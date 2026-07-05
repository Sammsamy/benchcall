import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RunReportSchema, type AgentConfig, type RunReport } from '../core/types.js';

/** One human judgement about one judged scenario (calibration, the benchcall design principles). */
export interface CalibrationAgreement {
  scenarioId: string;
  agree: boolean;
}

/** Stable fingerprint of the parts of an agent config that affect behavior. */
export function agentConfigHash(config: AgentConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        systemPrompt: config.systemPrompt,
        firstMessage: config.firstMessage ?? null,
        model: config.model ?? null,
        tools: config.tools ?? null,
      }),
    )
    .digest('hex');
}

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * Per-field fingerprints so change detection can say WHAT changed (prompt vs
 * model vs voice) — the building block of provider-update shields.
 * Short values stored raw (readable in alerts), long ones hashed.
 */
export function agentFieldPrints(config: AgentConfig): Record<string, string> {
  return {
    systemPrompt: `sha:${sha8(config.systemPrompt)}`,
    firstMessage: config.firstMessage ?? '(none)',
    model: config.model ?? '(unknown)',
    voice: config.voice ?? '(unknown)',
    tools: `sha:${sha8(JSON.stringify(config.tools ?? null))}`,
  };
}

export interface ConfigChangeCheck {
  isFirst: boolean;
  changedFields: string[];
  /** Human-readable "model: gpt-4.1 → gpt-4.2" style descriptions. */
  changes: string[];
}

/** Local-mode history. */
export class RunStore {
  private db: Database.Database;

  constructor(dbPath = '.benchcall/benchcall.db') {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        suite_id   TEXT NOT NULL,
        started_at TEXT NOT NULL,
        passed     INTEGER NOT NULL,
        failed     INTEGER NOT NULL,
        errored    INTEGER NOT NULL,
        json       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs (agent_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS calibration (
        run_id      TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        agree       INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (run_id, scenario_id)
      );
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id    TEXT PRIMARY KEY,
        config_hash TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_history (
        agent_id       TEXT NOT NULL,
        at             TEXT NOT NULL,
        changed_fields TEXT NOT NULL,
        changes        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_config_history_agent ON config_history (agent_id, at DESC);
    `);
    // Migration: fields_json added after the first Phase 2 release.
    const columns = this.db.prepare(`PRAGMA table_info(agent_state)`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'fields_json')) {
      this.db.exec(`ALTER TABLE agent_state ADD COLUMN fields_json TEXT`);
    }
  }

  /** Compare a live config against the last recorded state (read-only). */
  peekConfigChanges(agentId: string, config: AgentConfig): ConfigChangeCheck {
    const row = this.db.prepare('SELECT fields_json FROM agent_state WHERE agent_id = ?').get(agentId) as
      | { fields_json: string | null }
      | undefined;
    const current = agentFieldPrints(config);
    if (!row?.fields_json) {
      return { isFirst: true, changedFields: Object.keys(current), changes: [] };
    }
    const previous = JSON.parse(row.fields_json) as Record<string, string>;
    const changedFields = Object.keys(current).filter((k) => previous[k] !== current[k]);
    const changes = changedFields.map((k) =>
      current[k]!.startsWith('sha:') ? `${k} changed` : `${k}: ${previous[k] ?? '(unset)'} → ${current[k]}`,
    );
    return { isFirst: false, changedFields, changes };
  }

  /** Persist the config state; appends to the change log when fields moved. */
  saveConfigState(agentId: string, config: AgentConfig): void {
    const check = this.peekConfigChanges(agentId, config);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_state (agent_id, config_hash, updated_at, fields_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET config_hash = excluded.config_hash,
           updated_at = excluded.updated_at, fields_json = excluded.fields_json`,
      )
      .run(agentId, agentConfigHash(config), now, JSON.stringify(agentFieldPrints(config)));
    if (!check.isFirst && check.changedFields.length > 0) {
      this.db
        .prepare('INSERT INTO config_history (agent_id, at, changed_fields, changes) VALUES (?, ?, ?, ?)')
        .run(agentId, now, JSON.stringify(check.changedFields), JSON.stringify(check.changes));
    }
  }

  /** Newest first — the "change log" for evidence packs and update shields. */
  listConfigHistory(agentId: string, limit = 50): Array<{ at: string; changedFields: string[]; changes: string[] }> {
    const rows = this.db
      .prepare('SELECT at, changed_fields, changes FROM config_history WHERE agent_id = ? ORDER BY at DESC LIMIT ?')
      .all(agentId, limit) as Array<{ at: string; changed_fields: string; changes: string }>;
    return rows.map((r) => ({
      at: r.at,
      changedFields: JSON.parse(r.changed_fields) as string[],
      changes: JSON.parse(r.changes) as string[],
    }));
  }

  saveRun(report: RunReport): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (run_id, agent_id, suite_id, started_at, passed, failed, errored, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.runId,
        report.agentId,
        report.suiteId,
        report.startedAt,
        report.totals.passed,
        report.totals.failed,
        report.totals.errored,
        JSON.stringify(report),
      );
  }

  /** Newest first. */
  listRuns(agentId?: string, limit = 20): RunReport[] {
    const rows = agentId
      ? this.db
          .prepare('SELECT json FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(agentId, limit)
      : this.db.prepare('SELECT json FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
    return (rows as Array<{ json: string }>).map((r) => RunReportSchema.parse(JSON.parse(r.json)));
  }

  /** Record human agreement/disagreement with judge verdicts for one run. */
  saveCalibration(runId: string, agentId: string, agreements: CalibrationAgreement[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO calibration (run_id, scenario_id, agent_id, agree, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const insertAll = this.db.transaction((rows: CalibrationAgreement[]) => {
      for (const row of rows) stmt.run(runId, row.scenarioId, agentId, row.agree ? 1 : 0, now);
    });
    insertAll(agreements);
  }

  /** Which scenarios of a run already have human feedback. */
  calibratedScenarioIds(runId: string): Set<string> {
    const rows = this.db.prepare('SELECT scenario_id FROM calibration WHERE run_id = ?').all(runId);
    return new Set((rows as Array<{ scenario_id: string }>).map((r) => r.scenario_id));
  }

  /** Judge–human agreement for an agent. */
  agreementStats(agentId?: string): { agreed: number; total: number } {
    const row = (
      agentId
        ? this.db.prepare('SELECT SUM(agree) AS agreed, COUNT(*) AS total FROM calibration WHERE agent_id = ?').get(agentId)
        : this.db.prepare('SELECT SUM(agree) AS agreed, COUNT(*) AS total FROM calibration').get()
    ) as { agreed: number | null; total: number };
    return { agreed: row.agreed ?? 0, total: row.total };
  }

  getAgentConfigHash(agentId: string): string | undefined {
    const row = this.db.prepare('SELECT config_hash FROM agent_state WHERE agent_id = ?').get(agentId) as
      | { config_hash: string }
      | undefined;
    return row?.config_hash;
  }

  setAgentConfigHash(agentId: string, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_state (agent_id, config_hash, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET config_hash = excluded.config_hash, updated_at = excluded.updated_at`,
      )
      .run(agentId, hash, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
