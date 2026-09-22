/**
 * @file tests/audit/repros/de74dac.test.js
 * @description Audit repro for ticket de74dac (Major, area:docs): thrown
 * hydration must still return the subsystem receipts and snapshot metadata
 * captured before the throw.
 *
 * Evidence: `src/lib/sandbox/sandboxPersistence/index.ts` collects `receipts` inside
 * the `try` and builds `metadata` only after `runtime.importSnapshot`; the
 * `catch` returns `{ success: false, error, code }` only, so a throw inside
 * `runtime.importSnapshot` (after VirtualFS/WorldClock/MessagingBus already
 * hydrated) discards the record of what ran.
 *
 * Contract pin: `src/lib/sandbox/sandboxPersistence/index.ts` RestoreResult.receipts
 * "Present on clean success and on partial rejection, so a discarded receipt is
 * impossible." and metadata "present whenever the hydration stages ran".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/de74dac.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  restoreRuntimeEnvironment,
  PERSISTENCE_ERROR_CODES
} from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

test('de74dac: thrown hydration still returns captured receipts and metadata', () => {
  const state = {
    version: '1.0.0',
    timestamp: 1726531200000,
    activeAgentId: 'boom_agent',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'boom_agent',
        name: 'Boom Agent',
        config: { id: 'boom_agent' },
        turnCount: 0,
        createdAt: 1726500000000,
        updatedAt: 1726530000000,
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {},
    messagingBus: {},
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  let vfsImports = 0;
  const virtualFs = {
    importSnapshot() {
      vfsImports += 1;
      return { success: true };
    }
  };
  const runtime = {
    importSnapshot() {
      throw new Error('boom');
    }
  };

  const result = restoreRuntimeEnvironment(state, { runtime, virtualFs });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.HYDRATION_FAILED);
  assert.strictEqual(result.error, 'boom');
  assert.strictEqual(vfsImports, 1, 'VirtualFS hydrated before the runtime throw');

  assert.ok(
    Array.isArray(result.receipts),
    'a thrown hydration must still return the receipts captured before the throw'
  );
  assert.deepStrictEqual(
    result.receipts.map((receipt) => receipt.subsystem),
    ['virtualFs'],
    'the captured VirtualFS acceptance receipt must not be discarded'
  );
  assert.strictEqual(result.receipts[0].success, true);

  assert.ok(
    result.metadata,
    'a thrown hydration must still return the snapshot metadata for what ran'
  );
  assert.strictEqual(result.metadata.version, '1.0.0');
  assert.strictEqual(result.metadata.activeAgentCount, 1);
  assert.strictEqual(result.metadata.recycledAgentCount, 0);
  assert.strictEqual(result.metadata.activeAgentId, 'boom_agent');
});
