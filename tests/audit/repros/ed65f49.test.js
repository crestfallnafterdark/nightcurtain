/**
 * @file tests/audit/repros/ed65f49.test.js
 * @description Audit repro for ticket ed65f49 (Major, area:docs): the entity
 * snapshot contract claims `Agent.toSnapshot()` / `Agent.fromSnapshot()` are
 * the persistence round-trip contract, but the serialized shape is incomplete
 * for the fields persistence carries. Agent-side evidence:
 *
 * 1. `lastInterruptedTurn` is deep-copied by `toSnapshot()` and restored by
 *    `fromSnapshot()` (regression pin for the interrupted-turn recovery claim).
 * 2. `lastError` — which `sandboxPersistence` persists separately and re-applies
 *    with a direct write to the live entity — is absent from `toSnapshot()` and
 *    unrecoverable through `fromSnapshot()`, so an entity-owned round trip
 *    silently loses the diagnostic banner.
 *
 * Contract pin: `SerializedAgent` (`src/lib/sandbox/runtime/agent/index.ts`)
 * declares `lastInterruptedTurn` and must also expose `lastError`; the entity
 * stores `Agent.lastError` as a message string (`string | null`).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/ed65f49.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';

const interruptedTurn = {
  input: 'Draft the opening scene',
  mode: 'chat',
  timestamp: 1773700000000,
  cancelled: true
};

test('ed65f49: agent-side snapshot round-trip preserves lastInterruptedTurn and lastError', () => {
  const agent = new Agent({ id: 'snapshot-roundtrip-agent' });
  agent.lastInterruptedTurn = interruptedTurn;
  agent.lastError = 'Provider timeout while generating the scene';

  const snapshot = agent.toSnapshot();

  assert.deepStrictEqual(
    snapshot.lastInterruptedTurn,
    interruptedTurn,
    'toSnapshot must emit the interrupted-turn record'
  );
  assert.strictEqual(
    snapshot.lastError,
    'Provider timeout while generating the scene',
    'toSnapshot must emit the diagnostic lastError'
  );

  const restored = Agent.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));

  assert.deepStrictEqual(
    restored.lastInterruptedTurn,
    interruptedTurn,
    'fromSnapshot must restore the interrupted-turn record'
  );
  assert.strictEqual(
    restored.lastError,
    'Provider timeout while generating the scene',
    'fromSnapshot must restore the diagnostic lastError'
  );
  assert.notStrictEqual(
    restored.lastInterruptedTurn,
    snapshot.lastInterruptedTurn,
    'restored interrupted-turn record must be a deep copy'
  );

  const healthy = Agent.fromSnapshot(new Agent({ id: 'snapshot-healthy-agent' }).toSnapshot());
  assert.strictEqual(healthy.lastInterruptedTurn, null, 'healthy agents round-trip a null interrupted turn');
  assert.strictEqual(healthy.lastError, null, 'healthy agents round-trip a null lastError');
});
