#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { readEnv } from './config.js';
import { AgentConfigSchema, TestSuiteSchema, type AgentConfig } from './core/types.js';
import { toSyncReport } from './core/sync.js';
import type { VoicePlatformAdapter } from './adapters/types.js';
import { LocalAdapter } from './adapters/local.js';
import { VapiAdapter } from './adapters/vapi.js';
import { RetellAdapter } from './adapters/retell.js';
import { detectProvider } from './llm/index.js';
import { CostTracker } from './llm/cost.js';
import { GenerationClient } from './client.js';
import { runSuite } from './run.js';
import { RunStore, type CalibrationAgreement } from './store/sqlite.js';
import { scoreRecentCalls } from './judge/production.js';
import { renderDiff } from './report/textdiff.js';
import { renderEvidenceHTML, buildEvidenceData } from './report/evidence.js';
import type { FixFailure } from './core/fix.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diffRuns } from './report/diff.js';
import { renderTerminalDiff, renderTerminalReport, bold, dim, green, red, yellow } from './report/terminal.js';
import { renderMarkdownReport } from './report/markdown.js';
import { renderShareCard } from './report/share.js';
import { renderTranscript } from './judge/prompts.js';

// Load ./.env when present (Node 20.12+); real deployments use actual env vars.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — fine */
}

const env = readEnv();

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireLLM() {
  const detected = detectProvider(env);
  if (!detected) {
    fail('no LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, or OPENROUTER_API_KEY (see .env.example).');
  }
  return detected;
}

function vapiAdapter(): VapiAdapter {
  if (!env.vapiApiKey) fail('VAPI_API_KEY is not set (see .env.example).');
  return new VapiAdapter(env.vapiApiKey);
}

function retellAdapter(): RetellAdapter {
  if (!env.retellApiKey) fail('RETELL_API_KEY is not set (see .env.example).');
  return new RetellAdapter(env.retellApiKey);
}

function platformAdapter(platform: string): VoicePlatformAdapter {
  if (platform === 'vapi') return vapiAdapter();
  if (platform === 'retell') return retellAdapter();
  fail(`unsupported platform "${platform}" (supported: vapi, retell)`);
}

function loadAgentConfig(path: string): AgentConfig {
  return AgentConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

interface TargetOptions {
  platform?: string;
  agent?: string;
  config?: string;
}

/** Resolve --platform/--agent/--config into an adapter + agent id. */
async function resolveTarget(
  opts: TargetOptions,
  costs?: CostTracker,
): Promise<{ adapter: VoicePlatformAdapter; agentId: string }> {
  if (opts.config) {
    const config = loadAgentConfig(opts.config);
    const llm = requireLLM();
    return { adapter: new LocalAdapter(config, llm.provider, { costs }), agentId: config.id };
  }
  if (opts.platform) {
    if (!opts.agent) fail(`--agent <id> is required with --platform ${opts.platform}`);
    return { adapter: platformAdapter(opts.platform), agentId: opts.agent };
  }
  fail('specify a target: --config <agent.json> for local emulation, or --platform vapi|retell --agent <id>');
}

const program = new Command();
program
  .name('benchcall')
  .description('Automated test suites, quality scores, and drift alerts for AI voice agents')
  .version('0.1.0');

program
  .command('connect')
  .description('Verify platform credentials and list your agents')
  .option('--platform <name>', 'voice platform', 'vapi')
  .action(async (opts: { platform: string }) => {
    const adapter = platformAdapter(opts.platform);
    const agents = await adapter.listAgents();
    console.log(bold(`Connected to ${adapter.platform} — ${agents.length} agent(s):`));
    for (const a of agents) console.log(`  ${a.id}  ${a.name}`);
    console.log(dim(`\nNext: benchcall generate --platform ${adapter.platform} --agent <id> --pack appointment-booking`));
  });

program
  .command('generate')
  .description('Generate a tailored test suite for an agent (uses the benchcall generation service)')
  .option('--platform <name>', 'voice platform (vapi)')
  .option('--agent <id>', 'platform agent/assistant id')
  .option('--config <path>', 'local agent config JSON instead of a platform agent')
  .option('--pack <id>', 'vertical template pack, e.g. appointment-booking')
  .option('--out <path>', 'where to write the suite', 'suite.json')
  .action(async (opts: TargetOptions & { pack?: string; out: string }) => {
    const llm = requireLLM();
    const { adapter, agentId } = await resolveTarget(opts);
    console.log(dim(`Fetching agent config from ${adapter.platform}...`));
    const agentConfig = await adapter.getAgentConfig(agentId);
    console.log(dim(`Generating suite via ${env.serverUrl} (this uses your ${llm.name} key)...`));
    const client = new GenerationClient(env.serverUrl, env.apiToken);
    const suite = await client.generateSuite({
      agentConfig,
      pack: opts.pack,
      llm: { provider: llm.name, apiKey: llm.apiKey, model: env.generationModel },
    });
    writeFileSync(opts.out, JSON.stringify(suite, null, 2));
    console.log(bold(`✓ ${suite.scenarios.length} scenarios written to ${opts.out}`));
    for (const s of suite.scenarios) console.log(`  - [${s.category}] ${s.title}`);
    console.log(dim(`\nNext: benchcall run --suite ${opts.out} ${opts.config ? `--config ${opts.config}` : `--platform vapi --agent ${agentId}`}`));
  });

program
  .command('run')
  .description('Run a test suite against an agent and judge every call')
  .requiredOption('--suite <path>', 'suite JSON produced by "benchcall generate"')
  .option('--platform <name>', 'voice platform (vapi)')
  .option('--agent <id>', 'platform agent/assistant id')
  .option('--config <path>', 'local agent config JSON instead of a platform agent')
  .option('--concurrency <n>', 'parallel scenarios', '4')
  .option('--out <path>', 'also write a markdown report here')
  .option('--if-changed', 'skip the run when the agent config is unchanged since the last run (for cron)')
  .option('--no-sync', 'do not push scores to the hosted dashboard')
  .action(
    async (opts: TargetOptions & { suite: string; concurrency: string; out?: string; ifChanged?: boolean; sync: boolean }) => {
      const llm = requireLLM();
      const suite = TestSuiteSchema.parse(JSON.parse(readFileSync(opts.suite, 'utf8')));
      const costs = new CostTracker();
      const { adapter, agentId } = await resolveTarget(opts, costs);
      const store = new RunStore();

      // Provider-update shield building block: cron `benchcall run --if-changed`
      // reruns only when the agent's config moved — and we can say WHAT moved
      // (prompt vs model vs voice), which lands in reports and Slack alerts.
      const liveConfig = await adapter.getAgentConfig(agentId);
      const configCheck = store.peekConfigChanges(agentId, liveConfig);
      if (opts.ifChanged && !configCheck.isFirst && configCheck.changedFields.length === 0) {
        console.log(dim(`agent config unchanged since the last run — skipping (--if-changed)`));
        store.close();
        return;
      }
      if (!configCheck.isFirst && configCheck.changes.length > 0) {
        console.log(yellow(`config changed since last run: ${configCheck.changes.join('; ')}`));
      }

      console.log(dim(`Running ${suite.scenarios.length} scenarios against ${adapter.platform}:${agentId}...`));
      const report = await runSuite(suite, {
        adapter,
        agentId,
        llm: llm.provider,
        callerModel: env.callerModel,
        judgeModel: env.judgeModel,
        concurrency: Math.max(1, Math.floor(Number(opts.concurrency)) || 4),
        costs,
        onProgress: (m) => console.log(dim(m)),
      });

      const previous = store.listRuns(report.agentId, 1)[0];
      store.saveRun(report);
      store.saveConfigState(agentId, liveConfig);
      store.close();

      console.log(renderTerminalReport(report));
      const diff = previous ? diffRuns(previous, report) : undefined;
      if (diff) console.log(renderTerminalDiff(diff));
      console.log("\n" + renderShareCard(report) + "\n");
      if (opts.out) {
        writeFileSync(opts.out, renderMarkdownReport(report, diff));
        console.log(dim(`\nmarkdown report written to ${opts.out}`));
      }

      // Score sync: verdicts and totals go to the dashboard;
      // transcripts never leave this machine. Best effort — a down dashboard
      // must never fail a CI run.
      if (opts.sync && env.syncMode === 'on') {
        try {
          const client = new GenerationClient(env.serverUrl, env.apiToken);
          await client.pushRun(toSyncReport(report, adapter.platform, configCheck.changes));
          console.log(dim(`scores synced to ${env.serverUrl} (transcripts stay local)`));
        } catch (err) {
          console.log(yellow(`score sync skipped: ${err instanceof Error ? err.message : err}`));
        }
      }
      process.exitCode = report.totals.failed + report.totals.errored > 0 ? 1 : 0;
    },
  );

program
  .command('fix')
  .description('Turn the latest run\'s failures into a suggested prompt patch (never auto-applied)')
  .option('--platform <name>', 'voice platform (vapi, retell)')
  .option('--agent <id>', 'platform agent id')
  .option('--config <path>', 'local agent config JSON')
  .option('--out <path>', 'where to write the suggested prompt', 'suggested-prompt.txt')
  .option('--apply', 'offer to write the suggested prompt to the LIVE agent (asks for explicit confirmation)')
  .action(async (opts: TargetOptions & { out: string; apply?: boolean }) => {
    const llm = requireLLM();
    const { adapter, agentId } = await resolveTarget(opts);
    const store = new RunStore();
    const latest = store.listRuns(agentId, 1)[0];
    store.close();
    if (!latest) fail(`no stored runs for agent ${agentId} — use "benchcall run" first.`);

    const failures: FixFailure[] = latest.outcomes.flatMap((o) =>
      (o.judge?.verdicts ?? [])
        .filter((v) => v.verdict === 'fail')
        .map((v) => {
          const criterion = o.scenario.successCriteria.find((c) => c.id === v.criterionId);
          return {
            scenarioTitle: o.scenario.title,
            category: o.scenario.category,
            criterion: criterion?.description ?? v.criterionId,
            kind: criterion?.kind ?? 'must',
            reasoning: v.reasoning,
            ...(v.evidence && v.evidence !== 'none' ? { evidence: v.evidence } : {}),
          };
        }),
    );
    if (failures.length === 0) {
      console.log(green('latest run has no failed criteria — nothing to fix.'));
      return;
    }

    const agentConfig = await adapter.getAgentConfig(agentId);
    console.log(dim(`Asking the fix engine to address ${failures.length} failure(s) (your ${llm.name} key)...`));
    const client = new GenerationClient(env.serverUrl, env.apiToken);
    const fix = await client.requestFix({
      agentConfig,
      failures,
      llm: { provider: llm.name, apiKey: llm.apiKey, model: env.generationModel },
    });

    console.log(bold('\nWhy these changes:'));
    console.log(fix.rationale);
    console.log(bold('\nEdits:'));
    for (const edit of fix.edits) console.log(`  • ${edit.change} ${dim(`(addresses: ${edit.addresses})`)}`);
    console.log(bold('\nPrompt diff (current → suggested):'));
    console.log(renderDiff(agentConfig.systemPrompt, fix.revisedSystemPrompt));
    writeFileSync(opts.out, fix.revisedSystemPrompt);
    console.log(bold(`\n✓ suggested prompt written to ${opts.out}`));

    if (opts.apply) {
      if (!adapter.updateSystemPrompt) {
        console.log(yellow(`--apply is not supported for ${adapter.platform} yet — paste the prompt manually.`));
        return;
      }
      console.log(red(`\nYou are about to OVERWRITE the live system prompt of ${adapter.platform}:${agentId}.`));
      console.log(dim('The current prompt is preserved in your platform dashboard history only if your platform versions it.'));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Type APPLY to confirm (anything else aborts): ')).trim();
      rl.close();
      if (answer !== 'APPLY') {
        console.log(dim('aborted — nothing was changed.'));
        return;
      }
      await adapter.updateSystemPrompt(agentId, fix.revisedSystemPrompt);
      console.log(green(`✓ live prompt updated on ${adapter.platform}.`));
      console.log(dim('Now re-run the suite to confirm the fixes: the diff vs the previous run is your proof.'));
    } else {
      console.log(
        dim(
          'Review it, paste it into your platform dashboard, then re-run the suite to confirm the fixes.\n' +
            'benchcall never applies changes without --apply and an explicit confirmation.',
        ),
      );
    }
  });

program
  .command('score-calls')
  .description('Passively score recent REAL production calls against the agent\'s own rules')
  .option('--platform <name>', 'voice platform (vapi, retell)')
  .option('--agent <id>', 'platform agent id')
  .requiredOption('--suite <path>', 'suite JSON (its analysis provides the rubric)')
  .option('--limit <n>', 'how many recent calls to score', '10')
  .option('--out <path>', 'also write a markdown summary here')
  .action(async (opts: TargetOptions & { suite: string; limit: string; out?: string }) => {
    const llm = requireLLM();
    if (!opts.platform || !opts.agent) fail('score-calls needs --platform vapi|retell --agent <id> (it reads real call history)');
    const adapter = platformAdapter(opts.platform);
    const suite = TestSuiteSchema.parse(JSON.parse(readFileSync(opts.suite, 'utf8')));
    const costs = new CostTracker();

    console.log(dim(`Fetching and judging up to ${opts.limit} recent production calls (transcripts stay local)...`));
    const report = await scoreRecentCalls(adapter, opts.agent, suite, {
      llm: llm.provider,
      judgeModel: env.judgeModel,
      limit: Math.max(1, Math.floor(Number(opts.limit)) || 10),
      costs,
      onProgress: (m) => console.log(dim(m)),
    });

    if (report.totals.calls === 0) {
      console.log(yellow(`no recent calls with usable transcripts found${report.skippedCalls ? ` (${report.skippedCalls} skipped — too short)` : ''}.`));
      return;
    }

    console.log(bold(`\nProduction call scores — ${report.agentName ?? report.agentId}`));
    for (const s of report.scores) {
      const flag = s.callVerdict === 'pass' ? green('OK  ') : red('FLAG');
      console.log(`${flag}  ${s.startedAt.slice(0, 16).replace('T', ' ')}  ${dim(s.callId)}`);
      console.log(`      ${s.summary}`);
      for (const v of s.verdicts.filter((v) => v.verdict === 'fail')) {
        const criterion = report.criteria.find((c) => c.id === v.criterionId);
        console.log(red(`      ↳ ${criterion?.description ?? v.criterionId}`));
        if (v.evidence && v.evidence !== 'none') console.log(dim(`        "${v.evidence}"`));
      }
    }
    console.log(
      bold(
        `\n${report.totals.flagged}/${report.totals.calls} real calls flagged` +
          (report.skippedCalls ? dim(`  (${report.skippedCalls} skipped — too short)`) : ''),
      ),
    );
    console.log(dim(`LLM spend (your keys): $${costs.totalUsd.toFixed(4)}`));
    if (opts.out) {
      const lines = [
        `# Production call review — ${report.agentName ?? report.agentId}`,
        '',
        `${report.totals.flagged}/${report.totals.calls} recent calls violated at least one standing rule (scored ${report.scoredAt}).`,
        '',
        ...report.scores.map((s) =>
          [
            `## ${s.callVerdict === 'pass' ? '✅' : '❌'} ${s.startedAt} — \`${s.callId}\``,
            '',
            s.summary,
            ...s.verdicts
              .filter((v) => v.verdict === 'fail')
              .map((v) => `- **${report.criteria.find((c) => c.id === v.criterionId)?.description ?? v.criterionId}** — ${v.reasoning}`),
            '',
          ].join('\n'),
        ),
        '*Generated by benchcall. Testing evidence, not legal advice.*',
      ];
      writeFileSync(opts.out, lines.join('\n'));
      console.log(dim(`markdown summary written to ${opts.out}`));
    }
    process.exitCode = report.totals.flagged > 0 ? 1 : 0;
  });

program
  .command('evidence')
  .description('Export an audit-ready evidence pack (HTML + JSON) from local run history')
  .requiredOption('--agent <id>', 'agent id (as stored in runs)')
  .option('--out <dir>', 'output directory', 'evidence')
  .option('--brand <name>', 'white-label: shown as "Prepared by <name>" (or set BENCHCALL_BRAND)')
  .action((opts: { agent: string; out: string; brand?: string }) => {
    const store = new RunStore();
    const runs = store.listRuns(opts.agent, 100);
    if (runs.length === 0) {
      store.close();
      fail(`no stored runs for agent ${opts.agent} — use "benchcall run" first.`);
    }
    const input = {
      agentId: opts.agent,
      agentName: runs[0]!.agentName,
      generatedAt: new Date().toISOString(),
      brand: opts.brand ?? process.env.BENCHCALL_BRAND ?? undefined,
      runs,
      agreement: store.agreementStats(opts.agent),
      configHistory: store.listConfigHistory(opts.agent),
    };
    store.close();

    mkdirSync(opts.out, { recursive: true });
    const htmlPath = join(opts.out, `evidence-${opts.agent.slice(0, 12)}.html`);
    const jsonPath = join(opts.out, `evidence-${opts.agent.slice(0, 12)}.json`);
    writeFileSync(htmlPath, renderEvidenceHTML(input));
    writeFileSync(jsonPath, JSON.stringify(buildEvidenceData(input), null, 2));
    console.log(bold(`✓ evidence pack written:`));
    console.log(`  ${htmlPath}  ${dim('(open in a browser → Print → Save as PDF)')}`);
    console.log(`  ${jsonPath}`);
    console.log(dim('\nReminder: this is testing evidence, not legal advice or a compliance certification.'));
  });

program
  .command('calibrate')
  .description('Review judge verdicts on the latest run and record agree/disagree (judge–human agreement)')
  .option('--agent <id>', 'filter to one agent')
  .option('--all', 'review every scenario, not just ones without feedback yet')
  .action(async (opts: { agent?: string; all?: boolean }) => {
    const store = new RunStore();
    const latest = store.listRuns(opts.agent, 1)[0];
    if (!latest) {
      store.close();
      fail('no stored runs yet — use "benchcall run" first.');
    }
    const done = opts.all ? new Set<string>() : store.calibratedScenarioIds(latest.runId);
    const judged = latest.outcomes
      .filter((o) => o.judge && !done.has(o.scenario.id))
      // Failures first — they are where judge mistakes hurt the most.
      .sort((a, b) => (a.judge!.scenarioVerdict === 'fail' ? -1 : 1) - (b.judge!.scenarioVerdict === 'fail' ? -1 : 1));

    if (judged.length === 0) {
      store.close();
      console.log(dim('nothing left to review on the latest run — rerun with --all to re-review.'));
      return;
    }

    console.log(bold(`Calibrating run ${latest.runId} — ${judged.length} judged scenario(s) to review.`));
    console.log(dim('For each: read the transcript, then say whether the judge got it right.\n'));

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const agreements: CalibrationAgreement[] = [];
    try {
      for (const [index, outcome] of judged.entries()) {
        const judge = outcome.judge!;
        console.log(bold(`\n[${index + 1}/${judged.length}] ${outcome.scenario.title} (${outcome.scenario.category})`));
        console.log(dim('─'.repeat(60)));
        console.log(renderTranscript(outcome.call));
        console.log(dim('─'.repeat(60)));
        console.log(`judge verdict: ${judge.scenarioVerdict === 'pass' ? green('PASS') : red('FAIL')} — ${judge.summary}`);
        for (const v of judge.verdicts) {
          const criterion = outcome.scenario.successCriteria.find((c) => c.id === v.criterionId);
          const mark = v.verdict === 'pass' ? green('✓') : v.verdict === 'fail' ? red('✗') : yellow('n/a');
          console.log(`  ${mark} ${criterion?.description ?? v.criterionId}`);
          if (v.verdict === 'fail') console.log(dim(`      ${v.reasoning}${v.evidence && v.evidence !== 'none' ? ` — "${v.evidence}"` : ''}`));
        }
        const answer = (await rl.question('\nDo you agree with the judge? [y]es / [n]o / [s]kip / [q]uit: ')).trim().toLowerCase();
        if (answer === 'q') break;
        if (answer === 'y' || answer === 'n') {
          agreements.push({ scenarioId: outcome.scenario.id, agree: answer === 'y' });
        }
      }
    } finally {
      rl.close();
    }

    if (agreements.length === 0) {
      store.close();
      console.log(dim('no feedback recorded.'));
      return;
    }
    store.saveCalibration(latest.runId, latest.agentId, agreements);
    const stats = store.agreementStats(latest.agentId);
    store.close();
    const pct = Math.round((stats.agreed / stats.total) * 100);
    console.log(bold(`\nRecorded ${agreements.length} judgement(s). Judge–human agreement for this agent: ${pct}% of ${stats.total}.`));
    if (pct < 80) console.log(yellow('Agreement is below 80% — judge rubrics need attention.'));

    // Sync only the booleans — never call content.
    if (env.syncMode === 'on') {
      try {
        const client = new GenerationClient(env.serverUrl, env.apiToken);
        await client.pushCalibration(latest.agentId, latest.runId, agreements);
        console.log(dim(`agreement synced to ${env.serverUrl}`));
      } catch (err) {
        console.log(yellow(`calibration sync skipped: ${err instanceof Error ? err.message : err}`));
      }
    }
  });

program
  .command('report')
  .description('Show the latest stored run (and change vs the one before)')
  .option('--agent <id>', 'filter to one agent')
  .option('--out <path>', 'write markdown report to a file')
  .action((opts: { agent?: string; out?: string }) => {
    const store = new RunStore();
    const runs = store.listRuns(opts.agent, 2);
    store.close();
    const [latest, previous] = runs;
    if (!latest) fail('no stored runs yet — use "benchcall run" first.');
    console.log(renderTerminalReport(latest));
    const diff = previous ? diffRuns(previous, latest) : undefined;
    if (diff) console.log(renderTerminalDiff(diff));
    console.log("\n" + renderShareCard(latest) + "\n");
    if (opts.out) {
      writeFileSync(opts.out, renderMarkdownReport(latest, diff));
      console.log(dim(`\nmarkdown report written to ${opts.out}`));
    }
  });

program
  .command('doctor')
  .description('Check keys, connectivity, and local setup (makes no billable LLM calls)')
  .action(async () => {
    const ok = (s: string) => console.log(`  ${green('✓')} ${s}`);
    const bad = (s: string) => console.log(`  ${red('✗')} ${s}`);
    const meh = (s: string) => console.log(`  ${dim('–')} ${s}`);

    console.log(bold('benchcall doctor\n'));

    const [major] = process.versions.node.split('.').map(Number);
    (major ?? 0) >= 20 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} — need >= 20`);

    const llmKeys = [
      ['ANTHROPIC_API_KEY', env.anthropicApiKey],
      ['OPENAI_API_KEY', env.openaiApiKey],
      ['GOOGLE_API_KEY', env.googleApiKey],
      ['OPENROUTER_API_KEY', env.openrouterApiKey],
    ].filter(([, v]) => v);
    llmKeys.length > 0
      ? ok(`LLM key: ${llmKeys.map(([k]) => k).join(', ')}`)
      : bad('no LLM key set — generation, judging, and the demo need one (see .env.example)');
    if (env.callerModel) meh(`caller model override: ${env.callerModel}`);
    if (env.judgeModel) meh(`judge model override: ${env.judgeModel}`);
    if (env.generationModel) meh(`generation model override: ${env.generationModel}`);

    for (const [name, key, make] of [
      ['Vapi', env.vapiApiKey, () => new VapiAdapter(env.vapiApiKey!)],
      ['Retell', env.retellApiKey, () => new RetellAdapter(env.retellApiKey!)],
    ] as const) {
      if (!key) {
        meh(`${name}: no key set (fine unless you test ${name} agents)`);
        continue;
      }
      try {
        const agents = await (make() as VoicePlatformAdapter).listAgents();
        ok(`${name}: connected — ${agents.length} agent(s) visible`);
      } catch (err) {
        bad(`${name}: key set but connection failed — ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }

    try {
      const response = await fetch(`${env.serverUrl.replace(/\/$/, '')}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      response.ok
        ? ok(`server: ${env.serverUrl} is up${env.apiToken ? ' (token set)' : dim(' — no BENCHCALL_API_TOKEN (dev mode)')}`)
        : bad(`server: ${env.serverUrl} answered ${response.status}`);
    } catch {
      meh(`server: ${env.serverUrl} unreachable — "generate" and score sync need it; runs from suite files still work`);
    }
    if (env.syncMode === 'off') meh('sync: OFF — scores stay fully local');

    try {
      const store = new RunStore();
      const runs = store.listRuns(undefined, 1);
      store.close();
      ok(`local store: .benchcall/benchcall.db writable (${runs.length > 0 ? `latest run ${runs[0]!.runId}` : 'no runs yet'})`);
    } catch (err) {
      bad(`local store: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }

    console.log(dim('\nAll checks are free — no LLM tokens were spent.'));
  });

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
