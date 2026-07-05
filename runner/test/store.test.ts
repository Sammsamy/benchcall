import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentConfigHash, RunStore } from '../src/store/sqlite.js';
import type { AgentConfig } from '../src/core/types.js';

let dir: string;
let store: RunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'benchcall-test-'));
  store = new RunStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const config: AgentConfig = {
  id: 'a1',
  name: 'Agent',
  platform: 'vapi',
  systemPrompt: 'You book appointments.',
  firstMessage: 'Hi!',
};

describe('agentConfigHash', () => {
  it('is stable for identical configs and changes when the prompt changes', () => {
    const h1 = agentConfigHash(config);
    expect(agentConfigHash({ ...config, raw: { anything: 'else' } })).toBe(h1);
    expect(agentConfigHash({ ...config, systemPrompt: 'You do something else.' })).not.toBe(h1);
  });
});

describe('RunStore agent state + calibration', () => {
  it('round-trips config hashes', () => {
    expect(store.getAgentConfigHash('a1')).toBeUndefined();
    store.setAgentConfigHash('a1', 'hash1');
    store.setAgentConfigHash('a1', 'hash2');
    expect(store.getAgentConfigHash('a1')).toBe('hash2');
  });

  it('tracks per-field config changes and keeps a change log', () => {
    const first = store.peekConfigChanges('a1', config);
    expect(first.isFirst).toBe(true);
    store.saveConfigState('a1', config);

    const unchanged = store.peekConfigChanges('a1', config);
    expect(unchanged).toMatchObject({ isFirst: false, changedFields: [] });

    const modified = { ...config, model: 'gpt-4.2', systemPrompt: 'New rules.' };
    const check = store.peekConfigChanges('a1', modified);
    expect(check.changedFields.sort()).toEqual(['model', 'systemPrompt']);
    expect(check.changes.join(' ')).toContain('gpt-4.2');

    store.saveConfigState('a1', modified);
    const history = store.listConfigHistory('a1');
    expect(history).toHaveLength(1);
    expect(history[0]!.changedFields.sort()).toEqual(['model', 'systemPrompt']);
  });

  it('records calibration and computes agreement stats', () => {
    store.saveCalibration('run_1', 'a1', [
      { scenarioId: 's1', agree: true },
      { scenarioId: 's2', agree: false },
      { scenarioId: 's3', agree: true },
    ]);
    expect(store.calibratedScenarioIds('run_1')).toEqual(new Set(['s1', 's2', 's3']));
    expect(store.agreementStats('a1')).toEqual({ agreed: 2, total: 3 });
    // Re-reviewing overwrites rather than double counting.
    store.saveCalibration('run_1', 'a1', [{ scenarioId: 's2', agree: true }]);
    expect(store.agreementStats('a1')).toEqual({ agreed: 3, total: 3 });
  });
});
