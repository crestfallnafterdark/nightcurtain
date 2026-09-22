/**
 * @file tests/audit/repros/d5b583d.test.js
 * @description Audit repro for ticket d5b583d (Minor, area:security, MOD-21):
 * the direct `AgentRuntime.importSnapshot` facade accepts hostile lifecycle
 * claims for active entries — `state:'running'` with no in-flight turn (an
 * unresetable Zero-Zombie ghost) and `recycledAt` installing a recycled agent
 * in the active registry. The persistence layer normalizes both on the app
 * restore path (`normalizeSnapshotForHydration`); every direct import path must
 * yield the same invariant-safe state.
 *
 * Expected: active entries hydrate IDLE with no busy state; recycled/terminated
 * claims route to the recycle bin (or the import rejects them).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/d5b583d.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('d5b583d: direct importSnapshot normalizes hostile lifecycle claims', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({
      agents: [
        {
          id: 'runner',
          name: 'runner',
          config: { id: 'runner' },
          state: 'running',
          history: [],
          redoStack: [],
          pendingPrecalls: [],
          telemetry: {}
        },
        {
          id: 'zombie',
          name: 'zombie',
          config: { id: 'zombie' },
          state: 'idle',
          recycledAt: 1773700000000,
          history: [],
          redoStack: [],
          pendingPrecalls: [],
          telemetry: {}
        }
      ],
      recycleBin: []
    });

    const runner = runtime.getAgent('runner');
    assert.ok(runner, 'active entry must hydrate');
    assert.strictEqual(runner.state, 'idle', 'a hostile running claim must normalize to idle');
    assert.strictEqual(runtime.isAgentBusy('runner'), false, 'no in-flight turn exists for the raw entry');

    assert.strictEqual(runtime.getAgent('zombie'), null, 'a recycled claim must not install in the active registry');
    const zombie = runtime.getRecycledAgent('zombie');
    assert.ok(zombie, 'a recycled claim must route to the recycle bin');
    assert.strictEqual(zombie.state, 'recycled');
  } finally {
    runtime.destroy();
  }
});
