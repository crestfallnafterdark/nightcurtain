/**
 * @file tests/audit/repros/e5e62a3.test.js
 * @description Audit repro for ticket e5e62a3 (Major, area:docs, security):
 * a snapshot that passes `validateSandboxState` but carries extra `state` /
 * `recycledAt` fields on active agent entries must not restore a `running`
 * active agent or smuggle a recycled agent into the active registry.
 *
 * Evidence: validation only checks id/config/history/redoStack, and
 * `restoreRuntimeEnvironment` hands the snapshot straight to
 * `runtime.importSnapshot`, where `Agent.fromSnapshot` honors `snapshot.state`
 * and `recycledAt` while the runtime registers every `agents[]` entry with a
 * live mailbox subscription.
 *
 * Contract pin: `src/lib/sandbox/sandboxPersistence/index.ts` @invariant
 * "Zero-zombie hydration" and "Normalization: all active agents restore in
 * state IDLE".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/e5e62a3.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { restoreRuntimeEnvironment } from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

function baseState(agents) {
  return {
    version: '1.0.0',
    timestamp: 1726531200000,
    activeAgentId: null,
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents,
    recycleBin: [],
    virtualFs: {},
    messagingBus: {},
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };
}

test('e5e62a3: hostile state/recycledAt fields do not restore running/recycled active agents', () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    const runningResult = restoreRuntimeEnvironment(
      baseState([
        {
          id: 'runner',
          name: 'Runner',
          config: { id: 'runner' },
          history: [],
          redoStack: [],
          state: 'running'
        }
      ]),
      runtime
    );

    assert.strictEqual(runningResult.success, true);
    const runner = runtime.getAgent('runner');
    assert.ok(runner, 'active entry must still hydrate');
    assert.strictEqual(
      runner.state,
      'idle',
      'a validated snapshot claiming state "running" must restore normalized to IDLE'
    );

    const recycledResult = restoreRuntimeEnvironment(
      baseState([
        {
          id: 'ghost',
          name: 'Ghost',
          config: { id: 'ghost' },
          history: [],
          redoStack: [],
          recycledAt: '2026-01-01T00:00:00.000Z'
        }
      ]),
      runtime
    );

    assert.strictEqual(recycledResult.success, true);
    assert.strictEqual(
      runtime.getAgent('ghost'),
      null,
      'a recycledAt-carrying entry must not enter the active registry'
    );
    const ghost = runtime.getRecycledAgent('ghost');
    assert.ok(ghost, 'a recycledAt-carrying entry must land in the recycle bin');
    assert.strictEqual(ghost.state, 'recycled');
    assert.strictEqual(
      runtime.isAgentTerminated('ghost'),
      true,
      'the relocated agent must be marked terminated on the MessagingBus'
    );
    assert.strictEqual(
      runtime.messagingBus.isRegistered('ghost'),
      false,
      'the relocated agent must never receive an active mailbox registration'
    );
  } finally {
    runtime.destroy();
  }
});
