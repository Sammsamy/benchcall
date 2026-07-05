import { TestSuiteSchema, type AgentConfig, type TestSuite } from './core/types.js';
import type { SyncedRunReport } from './core/sync.js';
import { FixResultSchema, type FixFailure, type FixResult } from './core/fix.js';
import type { CalibrationAgreement } from './store/sqlite.js';
import type { ProviderName } from './llm/types.js';

export interface GenerateRequest {
  agentConfig: AgentConfig;
  pack?: string;
  llm: {
    provider: Exclude<ProviderName, 'mock'>;
    model?: string;
    /**
     * BYOK: your key is forwarded over TLS for this one generation call and
     * never stored by the server.
     */
    apiKey: string;
  };
}

/**
 * Client for the hosted benchcall service: suite generation (closed-source
 * meta-prompts, the benchcall design principles), run sync (scores only, never transcripts —
 * the benchcall design principles), and calibration feedback.
 */
export class GenerationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken?: string,
  ) {
    // Request bodies can carry the customer's LLM API key — refuse to send
    // them in cleartext anywhere but loopback.
    const url = new URL(baseUrl);
    const host = url.hostname;
    const isLoopback =
      host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]' || host === '::1';
    if (url.protocol !== 'https:' && !isLoopback) {
      throw new Error(
        `Refusing to send API keys over ${url.protocol}// to ${host}. Use https:// for remote servers (BENCHCALL_SERVER_URL).`,
      );
    }
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(
        `Could not reach the benchcall server at ${this.baseUrl}. ` +
          `Start it with "npm run server:dev" or point BENCHCALL_SERVER_URL at a hosted instance. (${String(err)})`,
      );
    }
  }

  private async expectOk(response: Response, what: string): Promise<void> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${what} failed (${response.status}): ${body.slice(0, 500)}`);
    }
  }

  async generateSuite(request: GenerateRequest): Promise<TestSuite> {
    // Strip the raw platform payload — it may contain platform secrets and is
    // documented as never leaving the machine.
    const { raw: _raw, ...agentConfig } = request.agentConfig;
    // Timeout sits above the server's own 300s generation deadline so we never
    // abandon a suite the customer's key already paid for.
    const response = await this.post('/v1/generate', { ...request, agentConfig }, 330_000);
    await this.expectOk(response, 'Generation');
    const payload = (await response.json()) as { suite: unknown };
    return TestSuiteSchema.parse(payload.suite);
  }

  /** Failed tests → suggested prompt patch (server-side meta-prompt, BYOK). */
  async requestFix(request: {
    agentConfig: AgentConfig;
    failures: FixFailure[];
    llm: GenerateRequest['llm'];
  }): Promise<FixResult> {
    const { raw: _raw, ...agentConfig } = request.agentConfig;
    const response = await this.post('/v1/fix', { ...request, agentConfig }, 330_000);
    await this.expectOk(response, 'Fix generation');
    const payload = (await response.json()) as { fix: unknown };
    return FixResultSchema.parse(payload.fix);
  }

  /** Push a transcript-free run summary to the hosted dashboard. */
  async pushRun(report: SyncedRunReport): Promise<void> {
    const response = await this.post('/v1/runs', report, 30_000);
    await this.expectOk(response, 'Run sync');
  }

  /** Push judge-agreement feedback (booleans only — no call content). */
  async pushCalibration(agentId: string, runId: string, agreements: CalibrationAgreement[]): Promise<void> {
    const response = await this.post('/v1/calibration', { agentId, runId, agreements }, 30_000);
    await this.expectOk(response, 'Calibration sync');
  }
}
