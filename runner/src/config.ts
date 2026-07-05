// Single source of truth for branding. "benchcall" is a working name — verify
// trademark/domain availability before any public naming.
export const PRODUCT_NAME = 'benchcall';

export const DEFAULT_SERVER_URL = 'http://localhost:8788';

export interface EnvConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  openrouterApiKey?: string;
  vapiApiKey?: string;
  retellApiKey?: string;
  serverUrl: string;
  /** Shared secret for the hosted server's ingest/dashboard APIs. */
  apiToken?: string;
  /** 'off' disables score sync entirely (fully local mode, the benchcall design principles). */
  syncMode: 'on' | 'off';
  /** Optional per-role model overrides (else provider defaults apply). */
  callerModel?: string;
  judgeModel?: string;
  generationModel?: string;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    googleApiKey: env.GOOGLE_API_KEY || undefined,
    openrouterApiKey: env.OPENROUTER_API_KEY || undefined,
    vapiApiKey: env.VAPI_API_KEY || undefined,
    retellApiKey: env.RETELL_API_KEY || undefined,
    serverUrl: env.BENCHCALL_SERVER_URL || DEFAULT_SERVER_URL,
    apiToken: env.BENCHCALL_API_TOKEN || undefined,
    syncMode: env.BENCHCALL_SYNC === 'off' ? 'off' : 'on',
    callerModel: env.BENCHCALL_CALLER_MODEL || undefined,
    judgeModel: env.BENCHCALL_JUDGE_MODEL || undefined,
    generationModel: env.BENCHCALL_GENERATION_MODEL || undefined,
  };
}
