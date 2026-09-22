/**
 * @file tests/audit/repros/3916c8c.test.js
 * @description Audit repro for ticket 3916c8c (Minor; MOD-21 blocking sub-issue):
 * engine internal privileged operations are expressed with hardcoded flag
 * bundles / reserved `system` ids, syntactically identical to forged caller
 * input; no opaque `InternalPrincipal` exists.
 *
 * Ratified MOD-21 W3 (runtime leg) fix: the facade owns a frozen opaque
 * `InternalPrincipal` injected into the scheduler for telemetry and
 * message-driven timer cancellation; plain objects, flag bundles, and reserved
 * ids cannot impersonate it.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/3916c8c.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('3916c8c: telemetry still counts pending timers through the injected principal', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    runtime.schedule({ targetAgentId: 'worker', durationSeconds: 60, prompt: 'P' });
    assert.strictEqual(runtime.getRuntimeMetrics().activeTimersCount, 1);
  } finally {
    runtime.destroy();
  }
});

test('3916c8c: a flag bundle cannot impersonate the internal principal', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    runtime.schedule({ targetAgentId: 'worker', durationSeconds: 60, prompt: 'P' });
    assert.deepStrictEqual(
      runtime.listSchedules({}, { isPrivileged: true, callerRole: 'system', callerAgentId: 'system' }).schedules,
      [],
      'reserved system id plus flags must not impersonate the engine principal'
    );
  } finally {
    runtime.destroy();
  }
});

test('3916c8c: early message-driven cancellation still runs internally', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    await runtime.launchAgent({ id: 'peer' });
    const timer = runtime.schedule({
      targetAgentId: 'worker',
      durationSeconds: 60,
      prompt: 'P',
      timerCondition: 'any'
    });
    assert.strictEqual(timer.success, true);
    runtime.messagingBus.sendMessage({ from: 'peer', to: 'worker', content: 'ping' });

    const status = runtime
      .listSchedules({ status: 'cancelled' }, { callerAgentId: 'worker' })
      .schedules.find((s) => s.timerId === timer.timerId);
    assert.ok(status, 'internal cancellation must still cancel the timer via the engine principal');
  } finally {
    runtime.destroy();
  }
});
