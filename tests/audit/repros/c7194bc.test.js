/**
 * @file tests/audit/repros/c7194bc.test.js
 * @description Audit repro for ticket c7194bc (Major/security, area:scheduler):
 * the scheduler still derives caller identity from caller-controlled input in
 * the `options`/object forms. An anonymous caller can read another agent's
 * schedules via `listSchedules({ callerAgentId })` and cancel another agent's
 * timer via `cancelSchedule(id, { callerAgentId })`.
 *
 * Evidence: `src/lib/sandbox/runtime/runtimeScheduler/index.ts:351,440,454-456,476-491`
 * trust `options.callerAgentId` / `timerIdOrParams.callerAgentId` /
 * `maybeReason.callerAgentId` as identity instead of the trusted `context`
 * argument. The tool path is protected; the public facade object form is not.
 *
 * Trusted-context assertions in the last test document the intended contract
 * (they pass at the buggy revision and must keep passing after the fix).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/c7194bc.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RuntimeScheduler,
  SCHEDULER_STATUS,
  SCHEDULER_ERROR_CODES
} from '../../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';

/** MOD-21 W3: reference-validated principals for the trusted-context assertions. */
const TEST_INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test-engine' });
const authorities = new Map();

function agentAuthority(id, privileged = false) {
  const descriptor = Object.freeze({
    subject: id,
    kind: 'agent',
    allow: new Set(privileged ? ['*'] : []),
    visibility: privileged ? 'all' : 'self'
  });
  authorities.set(id, descriptor);
  return descriptor;
}

function createScheduler() {
  return new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority: (id) => authorities.get(id) || null
  });
}

function scheduleTwo(scheduler) {
  const a = scheduler.schedule({ agentId: 'agent-a', prompt: 'Repro A', durationSeconds: 600 });
  const b = scheduler.schedule({ agentId: 'agent-b', prompt: 'Repro B', durationSeconds: 600 });
  assert.strictEqual(a.success, true, 'setup: agent-a schedule must succeed');
  assert.strictEqual(b.success, true, 'setup: agent-b schedule must succeed');
  return { a, b };
}

test('c7194bc: options.callerAgentId must not widen listSchedules for an anonymous caller', () => {
  const scheduler = createScheduler();
  try {
    scheduleTwo(scheduler);

    const leaked = scheduler.listSchedules({ callerAgentId: 'agent-a' });

    assert.deepStrictEqual(
      leaked.schedules,
      [],
      'options.callerAgentId is caller-controlled and must not be trusted as identity; anonymous listSchedules must default-deny'
    );
  } finally {
    scheduler.destroy();
  }
});

test('c7194bc: object-form callerAgentId must not authorize cancelling another agent timer', () => {
  const scheduler = createScheduler();
  try {
    const { b } = scheduleTwo(scheduler);

    const deniedStringForm = scheduler.cancelSchedule(b.timerId, { callerAgentId: 'agent-b' });
    assert.strictEqual(
      deniedStringForm.success,
      false,
      'cancelSchedule(timerId, { callerAgentId }) must be denied: identity in the reason object is caller-controlled'
    );
    assert.strictEqual(deniedStringForm.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

    const deniedObjectForm = scheduler.cancelSchedule({ timerId: b.timerId, callerAgentId: 'agent-b' });
    assert.strictEqual(
      deniedObjectForm.success,
      false,
      'cancelSchedule({ timerId, callerAgentId }) must be denied: identity in the params object is caller-controlled'
    );
    assert.strictEqual(deniedObjectForm.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

    const all = scheduler.listSchedules({}, { principal: agentAuthority('admin-bot', true) });
    const taskB = all.schedules.find((task) => task.timerId === b.timerId);
    assert.ok(taskB, 'agent-b timer must still exist after the denied cancels');
    assert.strictEqual(
      taskB.status,
      SCHEDULER_STATUS.PENDING,
      'agent-b timer must remain pending after the denied cancels'
    );
  } finally {
    scheduler.destroy();
  }
});

test('c7194bc: trusted-context identity and privilege still authorize as intended', () => {
  const scheduler = createScheduler();
  try {
    const { a, b } = scheduleTwo(scheduler);
    const c = scheduler.schedule({ agentId: 'agent-c', prompt: 'Repro C', durationSeconds: 600 });
    assert.strictEqual(c.success, true, 'setup: agent-c schedule must succeed');

    const privileged = scheduler.listSchedules({}, { principal: TEST_INTERNAL_PRINCIPAL });
    assert.strictEqual(privileged.schedules.length, 3, 'privileged context must see all schedules');

    const ownerList = scheduler.listSchedules({}, { principal: agentAuthority('agent-a') });
    assert.deepStrictEqual(ownerList.schedules.map((task) => task.agentId), ['agent-a']);

    const ownerCancel = scheduler.cancelSchedule(a.timerId, null, { principal: agentAuthority('agent-a') });
    assert.strictEqual(ownerCancel.success, true, 'owner identity from the trusted context must authorize self-cancel');
    assert.strictEqual(ownerCancel.timerId, a.timerId);

    const adminCancel = scheduler.cancelSchedule(b.timerId, { reason: 'admin cleanup' }, { principal: agentAuthority('admin-bot', true) });
    assert.strictEqual(adminCancel.success, true, 'privileged context must authorize cross-agent cancel');
    assert.strictEqual(adminCancel.timerId, b.timerId);

    const hijack = scheduler.cancelSchedule(c.timerId, null, { principal: agentAuthority('agent-a') });
    assert.strictEqual(hijack.success, false, 'non-privileged trusted identity must not cancel another agent timer');
    assert.strictEqual(hijack.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  } finally {
    scheduler.destroy();
  }
});
