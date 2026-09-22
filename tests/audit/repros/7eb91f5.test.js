/**
 * @file tests/audit/repros/7eb91f5.test.js
 * @description Audit repro for ticket 7eb91f5 (Major, area:docs): the
 * INV-PURGE invariant claims scheduler-timer teardown for `emptyRecycleBin`,
 * but the lifecycle manager purges recycled ids without touching the scheduler.
 *
 * Evidence: `src/lib/sandbox/runtime/index.ts:721-724` delegates to
 * `AgentLifecycleManager.emptyRecycleBin` (`agentLifecycle.js:921-930`), which
 * loops the manager-local `purgeAgent(id)` (no scheduler access); only
 * `AgentRuntime.purgeAgent` (`index.js:709-714`) runs
 * `RuntimeScheduler.teardownForAgent(id, 'Purged permanently', true)`.
 *
 * A live pending timer for a recycled id is reachable: `importSchedules`
 * restores PENDING timers for any `agentId`, including ids present only in the
 * recycle bin after a snapshot restore (`exportSchedules` exports all tasks
 * regardless of agent state).
 *
 * Fixture note (P2): `emptyRecycleBin` is sudoer-only (MOD-21 W8,
 * default-deny), so an anonymous call now throws `PERMISSION_DENIED` before
 * any purge — unrelated to the INV-PURGE teardown defect probed here. The
 * fixture authorizes with the bootstrapped director identity and pins the
 * anonymous denial (including its fail-closed side-effect freedom) alongside
 * the original assertion.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/7eb91f5.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('7eb91f5: emptyRecycleBin must tear down scheduler timers of purged agents (INV-PURGE)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    // Setup: launch then soft-kill, leaving the record in the recycle bin.
    await runtime.ensureDirector();
    const operator = { callerAgentId: 'director' };
    await runtime.launchAgent({ id: 'recycled-timer', role: 'helper' });
    runtime.killAgent('recycled-timer', 'Setup recycle', operator);
    assert.strictEqual(runtime.hasRecycledAgent('recycled-timer'), true, 'setup: agent must be recycled');

    // Simulate a snapshot restore that rehydrates a PENDING timer for a
    // recycle-bin-only id.
    runtime.importSchedules([{
      timerId: 'timer-recycled-timer',
      agentId: 'recycled-timer',
      status: 'pending',
      prompt: 'Deferred wakeup for a recycled agent',
      scheduledAt: Date.now(),
      fireAt: Date.now() + 60_000,
      durationSeconds: 60
    }]);

    const before = runtime.listSchedules({ status: 'pending' }, operator);
    assert.strictEqual(
      before.schedules.filter((s) => s.agentId === 'recycled-timer').length,
      1,
      'setup: a pending scheduler entry for the recycled id must exist'
    );

    // Anonymous emptying is denied before any purge (MOD-21 W8) and must not
    // tear the recycled timer down on its way out.
    assert.throws(
      () => runtime.emptyRecycleBin(),
      (err) => err?.code === 'PERMISSION_DENIED',
      'anonymous emptyRecycleBin must default-deny'
    );
    assert.strictEqual(runtime.hasRecycledAgent('recycled-timer'), true, 'the denied empty must leave the record recycled');
    assert.strictEqual(
      runtime.listSchedules({ status: 'all' }, operator).schedules.filter((s) => s.agentId === 'recycled-timer').length,
      1,
      'the denied empty must leave the recycled timer pending'
    );

    assert.strictEqual(runtime.emptyRecycleBin(operator), 1, 'the operator purges the recycled record');

    const after = runtime.listSchedules({ status: 'all' }, operator);
    assert.strictEqual(
      after.schedules.filter((s) => s.agentId === 'recycled-timer').length,
      0,
      'emptyRecycleBin must tear down scheduler timers for every purged agent (INV-PURGE)'
    );
  } finally {
    runtime.destroy();
  }
});
