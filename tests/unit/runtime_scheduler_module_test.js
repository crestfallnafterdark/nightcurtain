/**
 * @file tests/unit/runtime_scheduler_module_test.js
 * @description Comprehensive isolated unit and contract test suite for Module 11: runtime_scheduler.
 * 
 * Verifies strict ICD compliance and architectural guarantees:
 *   1. Strict Export Whitelist & Constant Immutability
 *   2. Constructor & Encapsulation Integrity
 *   3. One-Shot Timer Scheduling (Validation, Aliases, Receipts)
 *   4. Timer Expiry & Decoupled Trigger Enqueuing (Invariant 1)
 *   5. One-Shot-Only Surface (cron/recurrence params rejected or ignored)
 *   6. List Schedules & Defensive Projections (Invariant 5)
 *   7. Cancel Schedule Governance (Permissions, Idempotency, Status Rules)
 *   8. Message-Driven Early Cancellation (Invariant 3)
 *   9. Lifecycle Teardown, Reset, Destroy & Zero Host Leaks (Invariant 4)
 *  10. Persistence Fidelity (exportSchedules / importSchedules) (Invariant 7)
 *  11. TriggerDispatcher Construction & Mail Subscription
 *  12. TriggerDispatcher Concrete Dispatching (Mail, Schedule, User, Invocation)
 *  13. Non-Blocking Invocation Bridge (executeTurnForInvocation)
 *  14. End-to-End Integration Flow (RuntimeScheduler -> TriggerQueue -> TriggerDispatcher -> Runtime)
 *  15. Realm Scope: identity port option and legacy parity
 *  16. Wave I canonical identity: realm-local owners, opaque keys, bare receipts
 *  17. Wave I caller resolution: forged callerKey rejected, ambiguity fails closed
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as RuntimeSchedulerModule from '../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';
import * as TriggerDispatcherModule from '../../src/lib/sandbox/runtime/triggerDispatcher/index.ts';
import {
  RuntimeScheduler,
  SCHEDULER_STATUS,
  SCHEDULER_ERROR_CODES,
  TRIGGER_TYPES as SCHEDULER_TRIGGER_TYPES
} from '../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';
import {
  TriggerDispatcher,
  TRIGGER_TYPES as DISPATCHER_TRIGGER_TYPES
} from '../../src/lib/sandbox/runtime/triggerDispatcher/index.ts';
import { TriggerQueue, TRIGGER_TYPES as QUEUE_TRIGGER_TYPES } from '../../src/lib/sandbox/triggerQueue/index.ts';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/agent/index.ts';


/**
 * MOD-21 scheduler test authority: principals are frozen descriptor objects
 * validated by reference through the injected registry resolver. Plain flag
 * bundles, roles, and reserved ids grant nothing.
 */
const TEST_INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test-engine' });
const schedulerAuthorities = new Map();

function agentAuthority(id, { privileged = false } = {}) {
  const authority = Object.freeze({
    subject: id,
    kind: 'agent',
    allow: new Set(privileged ? ['*'] : []),
    visibility: privileged ? 'all' : 'self'
  });
  schedulerAuthorities.set(id, authority);
  return authority;
}

function createScheduler({
  runtime = null,
  emit = null,
  triggerQueue = null,
  internalPrincipal = TEST_INTERNAL_PRINCIPAL,
  resolveAgentAuthority = (id) => schedulerAuthorities.get(id) || null
} = {}) {
  return new RuntimeScheduler({
    runtime,
    emit,
    triggerQueue,
    internalPrincipal,
    resolveAgentAuthority
  });
}

// Helper to flush asynchronous event loop ticks
const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 1. Strict Export Whitelist & Constant Immutability
// ============================================================================

test('1. Strict Export Whitelist & Constant Immutability', () => {
  const schedulerExports = Object.keys(RuntimeSchedulerModule).sort();
  assert.deepStrictEqual(
    schedulerExports,
    ['RuntimeScheduler', 'SCHEDULER_ERROR_CODES', 'SCHEDULER_STATUS', 'TRIGGER_TYPES'].sort()
  );

  const dispatcherExports = Object.keys(TriggerDispatcherModule).sort();
  assert.deepStrictEqual(
    dispatcherExports,
    ['TRIGGER_TYPES', 'TriggerDispatcher'].sort()
  );

  // Status Enum verification & immutability
  assert.strictEqual(SCHEDULER_STATUS.PENDING, 'pending');
  assert.strictEqual(SCHEDULER_STATUS.TRIGGERED, 'triggered');
  assert.strictEqual(SCHEDULER_STATUS.CANCELLED, 'cancelled');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(SCHEDULER_STATUS, 'COMPLETED'), false);
  assert.ok(Object.isFrozen(SCHEDULER_STATUS), 'SCHEDULER_STATUS must be frozen');
  assert.throws(() => { SCHEDULER_STATUS.PENDING = 'modified'; }, TypeError);

  // Error Codes Enum verification & immutability
  assert.strictEqual(SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS, 'INVALID_ARGUMENTS');
  assert.strictEqual(SCHEDULER_ERROR_CODES.SCHEDULE_NOT_FOUND, 'SCHEDULE_NOT_FOUND');
  assert.strictEqual(SCHEDULER_ERROR_CODES.PERMISSION_DENIED, 'PERMISSION_DENIED');
  assert.strictEqual(SCHEDULER_ERROR_CODES.ALREADY_TRIGGERED, 'ALREADY_TRIGGERED');
  assert.strictEqual(SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE, 'SCHEDULER_UNAVAILABLE');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(SCHEDULER_ERROR_CODES, 'ALREADY_CANCELLED'), false);
  assert.ok(Object.isFrozen(SCHEDULER_ERROR_CODES), 'SCHEDULER_ERROR_CODES must be frozen');
  assert.throws(() => { SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS = 'modified'; }, TypeError);

  // Trigger Types Enum verification & single-source parity across modules
  assert.strictEqual(SCHEDULER_TRIGGER_TYPES.MAIL, 'mail');
  assert.strictEqual(SCHEDULER_TRIGGER_TYPES.INVOCATION, 'invocation');
  assert.strictEqual(SCHEDULER_TRIGGER_TYPES.SCHEDULE, 'schedule');
  assert.strictEqual(SCHEDULER_TRIGGER_TYPES.USER, 'user');
  assert.strictEqual(SCHEDULER_TRIGGER_TYPES, DISPATCHER_TRIGGER_TYPES,
    'RuntimeScheduler must re-export the canonical dispatcher TRIGGER_TYPES object');
  assert.strictEqual(QUEUE_TRIGGER_TYPES, DISPATCHER_TRIGGER_TYPES,
    'TriggerQueue must re-export the canonical dispatcher TRIGGER_TYPES object');
  assert.deepStrictEqual(SCHEDULER_TRIGGER_TYPES, DISPATCHER_TRIGGER_TYPES);
  assert.ok(Object.isFrozen(SCHEDULER_TRIGGER_TYPES), 'TRIGGER_TYPES must be frozen');
});

// ============================================================================
// 2. Constructor & Encapsulation Integrity
// ============================================================================

test('2. Constructor & Encapsulation Integrity', () => {
  const scheduler = createScheduler();
  assert.ok(scheduler instanceof RuntimeScheduler);

  // Verify private fields are completely encapsulated
  assert.strictEqual(scheduler.scheduledTasks, undefined);
  assert.strictEqual(scheduler._scheduledTasks, undefined);
  assert.strictEqual(scheduler.tasks, undefined);
  assert.strictEqual(scheduler.destroyed, undefined);
  assert.strictEqual(scheduler._destroyed, undefined);
  assert.strictEqual(scheduler.timerCounter, undefined);

  // Verify public API surface
  assert.strictEqual(typeof scheduler.schedule, 'function');
  assert.strictEqual(typeof scheduler.listSchedules, 'function');
  assert.strictEqual(typeof scheduler.cancelSchedule, 'function');
  assert.strictEqual(typeof scheduler.handleIncomingMessageForTimers, 'function');
  assert.strictEqual(typeof scheduler.teardownForAgent, 'function');
  assert.strictEqual(typeof scheduler.cancelAll, 'function');
  assert.strictEqual(typeof scheduler.exportSchedules, 'function');
  assert.strictEqual(typeof scheduler.importSchedules, 'function');
  assert.strictEqual(typeof scheduler.reset, 'function');
  assert.strictEqual(typeof scheduler.destroy, 'function');

  scheduler.destroy();
});

// ============================================================================
// 3. One-Shot Timer Scheduling (Validation, Aliases, Receipts)
// ============================================================================

test('3. One-Shot Timer Scheduling (Validation, Aliases, Receipts)', () => {
  const events = [];
  const mockRuntime = {
    _emit: (evt) => events.push(evt)
  };
  const scheduler = createScheduler({ runtime: mockRuntime, emit: { emit: (evt) => events.push(evt) } });

  // Invalid params object
  const res1 = scheduler.schedule(null);
  assert.strictEqual(res1.success, false);
  assert.strictEqual(res1.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // Missing agentId
  const res2 = scheduler.schedule({ prompt: 'Hello', durationSeconds: 5 });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // Empty string agentId
  const res3 = scheduler.schedule({ agentId: '   ', prompt: 'Hello', durationSeconds: 5 });
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // Missing prompt
  const res4 = scheduler.schedule({ agentId: 'agent-1', durationSeconds: 5 });
  assert.strictEqual(res4.success, false);
  assert.strictEqual(res4.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // Non-positive or invalid durationSeconds
  const res5 = scheduler.schedule({ agentId: 'agent-1', prompt: 'Hello', durationSeconds: -10 });
  assert.strictEqual(res5.success, false);
  assert.strictEqual(res5.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  const res6 = scheduler.schedule({ agentId: 'agent-1', prompt: 'Hello', durationSeconds: 0 });
  assert.strictEqual(res6.success, false);
  assert.strictEqual(res6.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  const res7 = scheduler.schedule({ agentId: 'agent-1', prompt: 'Hello' });
  assert.strictEqual(res7.success, false);
  assert.strictEqual(res7.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // Successful schedule with canonical parameters
  const receipt1 = scheduler.schedule({
    agentId: 'agent-writer',
    prompt: 'Check narrative flow',
    durationSeconds: 60,
    timerCondition: 'agent-editor'
  });
  assert.strictEqual(receipt1.success, true);
  assert.ok(receipt1.timerId.startsWith('timer_'));
  assert.strictEqual(receipt1.targetAgentId, 'agent-writer');
  assert.strictEqual(receipt1.prompt, 'Check narrative flow');
  assert.strictEqual(receipt1.durationSeconds, 60);
  assert.strictEqual(receipt1.timerCondition, 'agent-editor');
  assert.ok(typeof receipt1.scheduledAt === 'number');
  assert.ok(typeof receipt1.fireAt === 'number');
  assert.ok(receipt1.fireAt >= receipt1.scheduledAt + 59000);

  // Check event emission
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'schedule_registered');
  assert.strictEqual(events[0].agentId, 'agent-writer');
  assert.strictEqual(events[0].timerId, receipt1.timerId);

  // Successful schedule with legacy/tool aliases
  const receipt2 = scheduler.schedule(
    {
      targetAgentId: 'agent-reader',
      prompt: { text: 'Structured prompt' },
      delay_seconds: 120,
      condition: 'any'
    },
    { callerAgentId: 'admin' }
  );
  assert.strictEqual(receipt2.success, true);
  assert.strictEqual(receipt2.targetAgentId, 'agent-reader');
  assert.strictEqual(receipt2.prompt, '{"text":"Structured prompt"}');
  assert.strictEqual(receipt2.durationSeconds, 120);
  assert.strictEqual(receipt2.timerCondition, 'any');

  // AgentId resolved from execution context
  const receipt3 = scheduler.schedule(
    {
      prompt: 'Context agent schedule',
      delaySeconds: 30
    },
    { agentId: 'context-agent' }
  );
  assert.strictEqual(receipt3.success, true);
  assert.strictEqual(receipt3.targetAgentId, 'context-agent');
  assert.strictEqual(receipt3.durationSeconds, 30);
  assert.strictEqual(receipt3.timerCondition, 'never');

  scheduler.destroy();
});

// ============================================================================
// 4. Timer Expiry & Decoupled Trigger Enqueuing (Invariant 1)
// ============================================================================

test('4. Timer Expiry & Decoupled Trigger Enqueuing (Invariant 1)', async () => {
  const enqueuedTriggers = [];
  const mockTriggerQueue = {
    enqueue: (data) => {
      enqueuedTriggers.push(data);
      return `trig_${Date.now()}`;
    }
  };

  const events = [];
  let turnExecuted = false;
  const mockRuntime = {
    _emit: (evt) => events.push(evt),
    executeAgentTurn: async () => {
      turnExecuted = true;
      return { success: true };
    }
  };

  const scheduler = createScheduler({
    runtime: mockRuntime,
    emit: { emit: (evt) => events.push(evt) },
    triggerQueue: mockTriggerQueue
  });

  // Schedule a fast 15ms timer (0.015s)
  const receipt = scheduler.schedule({
    agentId: 'agent-active',
    prompt: 'Timer expired prompt',
    durationSeconds: 0.015,
    timerCondition: 'never'
  });
  assert.strictEqual(receipt.success, true);

  // Wait for timer to expire
  await flush(50);

  // Invariant 1: Scheduler strictly enqueues to TriggerQueue and NEVER calls executeAgentTurn directly
  assert.strictEqual(turnExecuted, false, 'RuntimeScheduler MUST NOT invoke executeAgentTurn directly!');
  assert.strictEqual(enqueuedTriggers.length, 1);
  assert.strictEqual(enqueuedTriggers[0].type, SCHEDULER_TRIGGER_TYPES.SCHEDULE);
  assert.strictEqual(enqueuedTriggers[0].targetAgentId, 'agent-active');
  assert.strictEqual(enqueuedTriggers[0].source, 'system:scheduler');
  assert.strictEqual(enqueuedTriggers[0].payload.timerId, receipt.timerId);
  assert.strictEqual(enqueuedTriggers[0].payload.prompt, 'Timer expired prompt');

  // Verify status transition
  const listResult = scheduler.listSchedules({ agentId: 'agent-active' }, { principal: agentAuthority('agent-active') });
  assert.strictEqual(listResult.schedules.length, 1);
  assert.strictEqual(listResult.schedules[0].status, SCHEDULER_STATUS.TRIGGERED);
  assert.ok(typeof listResult.schedules[0].triggeredAt === 'number');

  // Verify event emission
  const trigEvent = events.find(e => e.type === 'schedule_triggered');
  assert.ok(trigEvent);
  assert.strictEqual(trigEvent.timerId, receipt.timerId);

  // Enqueued trigger carries the timer expiry timestamp
  assert.strictEqual(enqueuedTriggers[0].payload.triggeredAt >= receipt.scheduledAt, true);

  scheduler.destroy();
});

// ============================================================================
// 5. One-Shot-Only Surface (cron/recurrence params rejected or ignored)
// ============================================================================

test('5. One-Shot-Only Surface: cron/recurrence params are rejected or ignored', () => {
  const scheduler = createScheduler();

  // A cron expression must not substitute for the required one-shot delay
  const rejected = scheduler.schedule({
    agentId: 'agent-monitor',
    prompt: 'Periodic health audit',
    cron: '*/5 * * * *'
  });
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // With a delay, recurrence-shaped params are ignored and the alarm stays one-shot
  const receipt = scheduler.schedule({
    agentId: 'agent-monitor',
    prompt: 'Deferred health audit',
    durationSeconds: 60,
    cron: '*/5 * * * *',
    cronExpression: '0 * * * *',
    maxIterations: 10,
    max_iterations: 5,
    iterationCount: 3
  });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.targetAgentId, 'agent-monitor');
  assert.strictEqual(receipt.durationSeconds, 60);
  for (const key of ['cron', 'cronExpression', 'maxIterations', 'iterationCount']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(receipt, key), false,
      `receipt must not expose recurrence field '${key}'`);
  }

  const list = scheduler.listSchedules({ agentId: 'agent-monitor' }, { principal: agentAuthority('agent-monitor') });
  assert.strictEqual(list.schedules.length, 1);
  for (const key of ['cron', 'maxIterations', 'iterationCount']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(list.schedules[0], key), false,
      `projection must not expose recurrence field '${key}'`);
  }
  assert.strictEqual(list.schedules[0].status, SCHEDULER_STATUS.PENDING);

  scheduler.destroy();
});

// ============================================================================
// 6. List Schedules & Defensive Projections (Invariant 5)
// ============================================================================

test('6. List Schedules & Defensive Projections (Invariant 5)', () => {
  const scheduler = createScheduler();

  scheduler.schedule({
    agentId: 'agent-alice',
    prompt: 'Alice task 1',
    durationSeconds: 100
  });
  scheduler.schedule({
    agentId: 'agent-alice',
    prompt: 'Alice task 2',
    durationSeconds: 200
  });
  scheduler.schedule({
    agentId: 'agent-bob',
    prompt: 'Bob task 1',
    durationSeconds: 300
  });

  // Query by target agent ID string (owner identity supplied)
  const aliceSchedules = scheduler.listSchedules('agent-alice', { principal: agentAuthority('agent-alice') });
  assert.strictEqual(aliceSchedules.schedules.length, 2);
  assert.strictEqual(aliceSchedules.schedules[0].agentId, 'agent-alice');
  assert.ok(aliceSchedules.schedules[0].remainingSeconds > 0);
  assert.strictEqual(
    aliceSchedules.schedules[0].remainingSeconds,
    aliceSchedules.schedules[0].countdownSeconds
  );

  // Defensive projection immutability: projection must be frozen
  assert.ok(Object.isFrozen(aliceSchedules.schedules[0]));
  assert.throws(() => {
    aliceSchedules.schedules[0].remainingSeconds = 0;
  }, TypeError);

  // Ownership default-deny: anonymous non-privileged callers receive no schedules
  assert.deepStrictEqual(
    scheduler.listSchedules({}),
    { success: true, schedules: [] },
    'anonymous listSchedules() must return no schedules'
  );
  assert.deepStrictEqual(
    scheduler.listSchedules('agent-alice').schedules,
    [],
    'anonymous string-form listSchedules() must return no schedules'
  );
  assert.deepStrictEqual(
    scheduler.listSchedules({ agentId: 'agent-alice' }).schedules,
    [],
    'an explicit agentId filter must not widen an anonymous caller scope'
  );
  assert.deepStrictEqual(
    scheduler.listSchedules({ isPrivileged: false }).schedules,
    [],
    'explicit non-privileged flag with no identity must return no schedules'
  );

  // Privilege-looking option flags are ignored: caller data never grants visibility
  assert.deepStrictEqual(
    scheduler.listSchedules({ isPrivileged: true }).schedules,
    [],
    'options.isPrivileged must not grant visibility'
  );
  assert.deepStrictEqual(
    scheduler.listSchedules({ isAdmin: true, privileged: true, all: true }).schedules,
    [],
    'options privilege aliases must not grant visibility'
  );

  // Non-privileged caller filtering: callerAgentId receives only own tasks
  const bobFiltered = scheduler.listSchedules({}, { principal: agentAuthority('agent-bob') });
  assert.strictEqual(bobFiltered.schedules.length, 1);
  assert.strictEqual(bobFiltered.schedules[0].prompt, 'Bob task 1');

  // Non-privileged caller cannot widen scope through an explicit agentId filter
  const bobWidened = scheduler.listSchedules({ agentId: 'agent-alice' }, { principal: agentAuthority('agent-bob') });
  assert.strictEqual(bobWidened.schedules.length, 1);
  assert.strictEqual(bobWidened.schedules[0].agentId, 'agent-bob');

  // Caller identity claimed through ListSchedulesOptions is caller-controlled and
  // ignored: an anonymous options claim must not widen visibility.
  const optionsScoped = scheduler.listSchedules({ callerAgentId: 'agent-alice' });
  assert.deepStrictEqual(
    optionsScoped.schedules,
    [],
    'options.callerAgentId must be ignored; anonymous callers receive no schedules'
  );

  // Privileged caller receives all tasks
  const adminQuery1 = scheduler.listSchedules({}, { principal: agentAuthority('agent-bob', { privileged: true }) });
  assert.strictEqual(adminQuery1.schedules.length, 3);

  const adminQuery2 = scheduler.listSchedules({}, { principal: agentAuthority('operator', { privileged: true }) });
  assert.strictEqual(adminQuery2.schedules.length, 3);

  // Status filtering
  const pendingOnly = scheduler.listSchedules({ status: 'pending' }, { principal: agentAuthority('operator', { privileged: true }) });
  assert.strictEqual(pendingOnly.schedules.length, 3);

  const triggeredOnly = scheduler.listSchedules({ status: 'triggered' }, { principal: agentAuthority('operator', { privileged: true }) });
  assert.strictEqual(triggeredOnly.schedules.length, 0);

  scheduler.destroy();
});

// ============================================================================
// 7. Cancel Schedule Governance (Permissions, Idempotency, Status Rules)
// ============================================================================

test('7. Cancel Schedule Governance (Permissions, Idempotency, Status Rules)', async () => {
  const events = [];
  const mockRuntime = {
    _emit: (evt) => events.push(evt)
  };
  const scheduler = createScheduler({ runtime: mockRuntime, emit: { emit: (evt) => events.push(evt) } });

  const sched1 = scheduler.schedule({
    agentId: 'agent-alice',
    prompt: 'Cancel test 1',
    durationSeconds: 100
  });

  // Missing timerId
  const err1 = scheduler.cancelSchedule(null);
  assert.strictEqual(err1.success, false);
  assert.strictEqual(err1.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  // Non-existent timerId
  const err2 = scheduler.cancelSchedule('timer_nonexistent_999');
  assert.strictEqual(err2.success, false);
  assert.strictEqual(err2.code, SCHEDULER_ERROR_CODES.SCHEDULE_NOT_FOUND);

  // Non-privileged cross-agent cancellation rejected
  const err3 = scheduler.cancelSchedule(sched1.timerId, 'Attempted hijack', { principal: agentAuthority('agent-bob') });
  assert.strictEqual(err3.success, false);
  assert.strictEqual(err3.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Owner cancellation succeeded
  const ok1 = scheduler.cancelSchedule(sched1.timerId, 'User aborted', { principal: agentAuthority('agent-alice') });
  assert.strictEqual(ok1.success, true);
  assert.strictEqual(ok1.timerId, sched1.timerId);
  assert.ok(typeof ok1.cancelledAt === 'number');

  // Verify state
  const check1 = scheduler.listSchedules({ agentId: 'agent-alice' }, { principal: agentAuthority('agent-alice') });
  assert.strictEqual(check1.schedules[0].status, SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(check1.schedules[0].cancelReason, 'User aborted');

  // Verify event emission
  const cancelEvt = events.find(e => e.type === 'schedule_cancelled');
  assert.ok(cancelEvt);
  assert.strictEqual(cancelEvt.timerId, sched1.timerId);

  // Idempotent cancellation on already cancelled schedule (owner identity supplied)
  const ok2 = scheduler.cancelSchedule(sched1.timerId, 'Second cancel', { principal: agentAuthority('agent-alice') });
  assert.strictEqual(ok2.success, true);
  assert.strictEqual(ok2.alreadyCancelled, true);

  // Cancel via object parameters (task_id alias); object-form privilege flags are
  // ignored, so the cross-agent cancel is denied...
  const sched2 = scheduler.schedule({
    agentId: 'agent-bob',
    prompt: 'Cancel test 2',
    durationSeconds: 100
  });
  const forgedOk3 = scheduler.cancelSchedule({
    task_id: sched2.timerId,
    reason: 'Admin override',
    isPrivileged: true
  });
  assert.strictEqual(forgedOk3.success, false);
  assert.strictEqual(forgedOk3.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // ...while the explicit trusted context grants the privileged cancel.
  const ok3 = scheduler.cancelSchedule(
    { task_id: sched2.timerId, reason: 'Admin override' },
    null,
    { principal: agentAuthority('operator', { privileged: true }) }
  );
  assert.strictEqual(ok3.success, true);

  // Cannot cancel already triggered schedule
  const schedFast = scheduler.schedule({
    agentId: 'agent-fast',
    prompt: 'Fast trigger',
    durationSeconds: 0.01
  });
  await flush(40);
  const err4 = scheduler.cancelSchedule(schedFast.timerId, null, { principal: agentAuthority('agent-fast') });
  assert.strictEqual(err4.success, false);
  assert.strictEqual(err4.code, SCHEDULER_ERROR_CODES.ALREADY_TRIGGERED);

  scheduler.destroy();
});

// ============================================================================
// 7b. Anonymous Cancel Default-Deny (bb9cf78)
// ============================================================================

test('7b. Anonymous Cancel Default-Deny (bb9cf78)', () => {
  const scheduler = createScheduler();

  const aliceTimer = scheduler.schedule({
    agentId: 'agent-alice',
    prompt: 'Alice protected timer',
    durationSeconds: 100
  });
  const bobTimer = scheduler.schedule({
    agentId: 'agent-bob',
    prompt: 'Bob own timer',
    durationSeconds: 100
  });

  // Anonymous string-form cancel of another agent's schedule is denied by default
  const anonString = scheduler.cancelSchedule(aliceTimer.timerId, 'anonymous hijack attempt');
  assert.strictEqual(anonString.success, false);
  assert.strictEqual(anonString.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Anonymous object-form cancel is denied as well
  const anonObject = scheduler.cancelSchedule({ timerId: aliceTimer.timerId, reason: 'object hijack' });
  assert.strictEqual(anonObject.success, false);
  assert.strictEqual(anonObject.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Explicit non-privileged flag with no resolvable identity is denied too
  const anonExplicit = scheduler.cancelSchedule(aliceTimer.timerId, null, {});
  assert.strictEqual(anonExplicit.success, false);
  assert.strictEqual(anonExplicit.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Privilege smuggled through the maybeReason object form is ignored as well
  const anonReasonFlag = scheduler.cancelSchedule(aliceTimer.timerId, { isPrivileged: true });
  assert.strictEqual(anonReasonFlag.success, false);
  assert.strictEqual(anonReasonFlag.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // The victim timer remains pending after all denied attempts
  const aliceList = scheduler.listSchedules({ agentId: 'agent-alice' }, { principal: agentAuthority('operator', { privileged: true }) });
  assert.strictEqual(aliceList.schedules[0].status, SCHEDULER_STATUS.PENDING);

  // Owner with a resolvable identity can still cancel their own schedule
  const owner = scheduler.cancelSchedule(bobTimer.timerId, 'Owner cleanup', { principal: agentAuthority('agent-bob') });
  assert.strictEqual(owner.success, true);
  assert.strictEqual(owner.timerId, bobTimer.timerId);

  // Owner identity supplied through the object form is caller-controlled and ignored
  const carolTimer = scheduler.schedule({
    agentId: 'agent-carol',
    prompt: 'Carol timer',
    durationSeconds: 100
  });
  const carolForged = scheduler.cancelSchedule({ timerId: carolTimer.timerId, callerAgentId: 'agent-carol' });
  assert.strictEqual(carolForged.success, false);
  assert.strictEqual(carolForged.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  const carolPending = scheduler
    .listSchedules({}, { principal: agentAuthority('operator', { privileged: true }) })
    .schedules.find((task) => task.timerId === carolTimer.timerId);
  assert.strictEqual(carolPending.status, SCHEDULER_STATUS.PENDING);

  // ...while the trusted context identity still authorizes the owner cancel
  const carolOwner = scheduler.cancelSchedule(carolTimer.timerId, null, { principal: agentAuthority('agent-carol') });
  assert.strictEqual(carolOwner.success, true);

  // Privileged callers still bypass ownership
  const privileged = scheduler.cancelSchedule(aliceTimer.timerId, null, { principal: agentAuthority('operator', { privileged: true }) });
  assert.strictEqual(privileged.success, true);

  // callerRole 'system' remains a privileged path
  const daveTimer = scheduler.schedule({
    agentId: 'agent-dave',
    prompt: 'Dave timer',
    durationSeconds: 100
  });
  const systemCancel = scheduler.cancelSchedule(daveTimer.timerId, 'system cleanup', { principal: TEST_INTERNAL_PRINCIPAL });
  assert.strictEqual(systemCancel.success, true);

  scheduler.destroy();
});

// ============================================================================
// 8. Message-Driven Early Cancellation (Invariant 3)
// ============================================================================

test('8. Message-Driven Early Cancellation (Invariant 3)', () => {
  const scheduler = createScheduler();

  // Timer 1: condition = 'never' (default)
  const t1 = scheduler.schedule({
    agentId: 'agent-worker',
    prompt: 'Task never cancel',
    durationSeconds: 100,
    timerCondition: 'never'
  });

  // Timer 2: condition = 'any'
  const t2 = scheduler.schedule({
    agentId: 'agent-worker',
    prompt: 'Task any message cancel',
    durationSeconds: 100,
    timerCondition: 'any'
  });

  // Timer 3: condition = 'agent-boss'
  const t3 = scheduler.schedule({
    agentId: 'agent-worker',
    prompt: 'Task boss message cancel',
    durationSeconds: 100,
    timerCondition: 'agent-boss'
  });

  // System scheduler message arrives -> MUST NOT cancel condition 'any'
  scheduler.handleIncomingMessageForTimers({
    from: 'system:scheduler',
    to: 'agent-worker',
    content: 'tick'
  });
  let list = scheduler.listSchedules('agent-worker', { principal: agentAuthority('agent-worker') });
  assert.strictEqual(list.schedules.find(s => s.timerId === t2.timerId).status, SCHEDULER_STATUS.PENDING);

  // Message for another agent arrives -> MUST NOT cancel agent-worker timers
  scheduler.handleIncomingMessageForTimers({
    from: 'agent-boss',
    to: 'agent-other',
    content: 'hello other'
  });
  list = scheduler.listSchedules('agent-worker', { principal: agentAuthority('agent-worker') });
  assert.strictEqual(list.schedules.find(s => s.timerId === t3.timerId).status, SCHEDULER_STATUS.PENDING);

  // Message from peer 'agent-colleague' arrives for agent-worker:
  // - t1 ('never') remains PENDING
  // - t2 ('any') is CANCELLED early
  // - t3 ('agent-boss') remains PENDING
  scheduler.handleIncomingMessageForTimers({
    from: 'agent-colleague',
    to: 'agent-worker',
    content: 'peer update'
  });
  list = scheduler.listSchedules('agent-worker', { principal: agentAuthority('agent-worker') });
  assert.strictEqual(list.schedules.find(s => s.timerId === t1.timerId).status, SCHEDULER_STATUS.PENDING);
  assert.strictEqual(list.schedules.find(s => s.timerId === t2.timerId).status, SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(list.schedules.find(s => s.timerId === t3.timerId).status, SCHEDULER_STATUS.PENDING);

  // Message specifically from 'agent-boss' arrives for agent-worker:
  // - t3 ('agent-boss') is CANCELLED early
  scheduler.handleIncomingMessageForTimers({
    from: 'agent-boss',
    to: 'agent-worker',
    content: 'directive from boss'
  });
  list = scheduler.listSchedules('agent-worker', { principal: agentAuthority('agent-worker') });
  assert.strictEqual(list.schedules.find(s => s.timerId === t3.timerId).status, SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(list.schedules.find(s => s.timerId === t1.timerId).status, SCHEDULER_STATUS.PENDING);

  scheduler.destroy();
});

// ============================================================================
// 9. Lifecycle Teardown, Reset, Destroy & Zero Host Leaks (Invariant 4)
// ============================================================================

test('9. Lifecycle Teardown, Reset, Destroy & Zero Host Leaks (Invariant 4)', () => {
  const events = [];
  const mockRuntime = {
    _emit: (evt) => events.push(evt)
  };
  const scheduler = createScheduler({ runtime: mockRuntime, emit: { emit: (evt) => events.push(evt) } });

  scheduler.schedule({
    agentId: 'agent-a',
    prompt: 'Task A1',
    durationSeconds: 100
  });
  scheduler.schedule({
    agentId: 'agent-a',
    prompt: 'Task A2',
    durationSeconds: 200
  });
  scheduler.schedule({
    agentId: 'agent-b',
    prompt: 'Task B1',
    durationSeconds: 300
  });

  // teardownForAgent cancels only agent-a timers
  scheduler.teardownForAgent('agent-a', 'Evicted', false);
  const listA = scheduler.listSchedules('agent-a', { principal: agentAuthority('agent-a') });
  assert.strictEqual(listA.schedules.length, 2);
  assert.strictEqual(listA.schedules[0].status, SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(listA.schedules[0].cancelReason, 'Evicted');

  const listB = scheduler.listSchedules('agent-b', { principal: agentAuthority('agent-b') });
  assert.strictEqual(listB.schedules[0].status, SCHEDULER_STATUS.PENDING);

  // teardownForAgent with purge=true permanently removes entries
  scheduler.teardownForAgent('agent-a', 'Purged', true);
  const listAPurged = scheduler.listSchedules('agent-a', { principal: agentAuthority('agent-a') });
  assert.strictEqual(listAPurged.schedules.length, 0);

  // cancelAll cancels all pending schedules
  scheduler.cancelAll();
  const listBCancelled = scheduler.listSchedules('agent-b', { principal: agentAuthority('agent-b') });
  assert.strictEqual(listBCancelled.schedules[0].status, SCHEDULER_STATUS.CANCELLED);

  // reset clears all schedules
  scheduler.reset();
  const allReset = scheduler.listSchedules({}, { principal: agentAuthority('operator', { privileged: true }) });
  assert.strictEqual(allReset.schedules.length, 0);

  // destroy blocks subsequent operations
  scheduler.destroy();
  const afterDestroySchedule = scheduler.schedule({ agentId: 'agent-x', prompt: 'test', durationSeconds: 10 });
  assert.strictEqual(afterDestroySchedule.success, false);
  assert.strictEqual(afterDestroySchedule.code, SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE);

  const afterDestroyCancel = scheduler.cancelSchedule('timer_123');
  assert.strictEqual(afterDestroyCancel.success, false);
  assert.strictEqual(afterDestroyCancel.code, SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE);
});

// ============================================================================
// 10. Persistence Fidelity (exportSchedules / importSchedules) (Invariant 7)
// ============================================================================

test('10. Persistence Fidelity (exportSchedules / importSchedules) (Invariant 7)', () => {
  const scheduler1 = createScheduler();

  const r1 = scheduler1.schedule({
    agentId: 'agent-1',
    prompt: 'Persisted task 1',
    durationSeconds: 60,
    timerCondition: 'agent-2'
  });
  const r2 = scheduler1.schedule({
    agentId: 'agent-1',
    prompt: 'Persisted deferred task 2',
    durationSeconds: 120
  });

  const snapshot = scheduler1.exportSchedules();
  assert.strictEqual(Array.isArray(snapshot), true);
  assert.strictEqual(snapshot.length, 2);

  // Verify SerializedScheduledTimer schema compliance
  const timerItem = snapshot.find(s => s.id === r1.timerId);
  assert.ok(timerItem);
  assert.strictEqual(timerItem.agentId, 'agent-1');
  assert.strictEqual(timerItem.type, 'timeout');
  assert.strictEqual(timerItem.delayMs, 60000);
  assert.strictEqual(timerItem.payload.prompt, 'Persisted task 1');
  assert.strictEqual(timerItem.payload.timerCondition, 'agent-2');
  assert.strictEqual(timerItem.status, SCHEDULER_STATUS.PENDING);

  // Backward-compatibility alias fields emitted alongside the canonical schema
  assert.strictEqual(timerItem.timerId, r1.timerId);
  assert.strictEqual(timerItem.targetAgentId, 'agent-1');
  assert.strictEqual(timerItem.durationSeconds, 60);
  assert.strictEqual(timerItem.prompt, 'Persisted task 1');
  assert.strictEqual(timerItem.timerCondition, 'agent-2');
  assert.strictEqual(timerItem.scheduledAt, timerItem.createdAt);
  assert.strictEqual(timerItem.fireAt, timerItem.nextRunAt);
  assert.strictEqual(timerItem.cancelReason, null);

  const secondItem = snapshot.find(s => s.id === r2.timerId);
  assert.ok(secondItem);
  assert.strictEqual(secondItem.type, 'timeout');
  assert.strictEqual(secondItem.delayMs, 120000);
  assert.strictEqual(secondItem.durationSeconds, 120);
  for (const key of ['cronExpr', 'cron', 'intervalMs', 'maxIterations', 'iterationCount']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(secondItem, key), false,
      `serialized record must not expose recurrence field '${key}'`);
  }

  // Restore snapshot into a clean scheduler
  const scheduler2 = createScheduler();
  scheduler2.importSchedules(snapshot);

  const restoredList = scheduler2.listSchedules({ agentId: 'agent-1' }, { principal: agentAuthority('agent-1') });
  assert.strictEqual(restoredList.schedules.length, 2);

  const restoredTimer = restoredList.schedules.find(s => s.timerId === r1.timerId);
  assert.ok(restoredTimer);
  assert.strictEqual(restoredTimer.prompt, 'Persisted task 1');
  assert.strictEqual(restoredTimer.timerCondition, 'agent-2');
  assert.strictEqual(restoredTimer.status, SCHEDULER_STATUS.PENDING);

  const restoredSecond = restoredList.schedules.find(s => s.timerId === r2.timerId);
  assert.ok(restoredSecond);
  assert.strictEqual(restoredSecond.prompt, 'Persisted deferred task 2');
  assert.strictEqual(restoredSecond.durationSeconds, 120);

  scheduler1.destroy();
  scheduler2.destroy();
});

// ============================================================================
// 10b. Post-destroy importSchedules Rejection (SCHEDULER_UNAVAILABLE)
// ============================================================================

test('10b. importSchedules after destroy() rejects with SCHEDULER_UNAVAILABLE', () => {
  const scheduler = createScheduler();
  scheduler.destroy();

  const snapshot = [{
    id: 'timer_revived',
    agentId: 'agent-zombie',
    prompt: 'Must not be re-armed',
    createdAt: Date.now() - 1000,
    nextRunAt: Date.now() + 60000,
    status: SCHEDULER_STATUS.PENDING
  }];

  assert.throws(
    () => scheduler.importSchedules(snapshot),
    (err) => err instanceof Error && err.code === SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE,
    'importSchedules must reject once the scheduler is destroyed'
  );

  // No leaked registry state was created by the rejected import
  const list = scheduler.listSchedules({}, { principal: agentAuthority('operator', { privileged: true }) });
  assert.deepStrictEqual(list.schedules, []);
});

// ============================================================================
// 11. TriggerDispatcher Construction & Mail Subscription
// ============================================================================

test('11. TriggerDispatcher Construction & Mail Subscription', async () => {
  const enqueuedTriggers = [];
  const mockTriggerQueue = {
    enqueue: (trigger) => {
      enqueuedTriggers.push(trigger);
      return `trig_${Date.now()}`;
    }
  };

  const subscriptions = new Map();
  const mockMessagingBus = {
    subscribe: (channel, callback) => {
      subscriptions.set(channel, callback);
      return () => subscriptions.delete(channel);
    }
  };

  const mockRuntime = {
    isAgentTerminated: (id) => id === 'agent-dead',
    getAgent: (id) => id === 'agent-dead' ? null : { id }
  };

  const dispatcher = new TriggerDispatcher({
    runtime: mockRuntime,
    messagingBus: mockMessagingBus,
    triggerQueue: mockTriggerQueue
  });

  // Setup mail subscription
  const unsubscribe = dispatcher.setupAgentMailSubscription('agent-reader');
  assert.ok(subscriptions.has('agent-reader'));

  const callback = subscriptions.get('agent-reader');

  // Ignored message: scheduled_timer
  callback({ type: 'scheduled_timer', from: 'system:scheduler', content: 'alarm' });
  await flush(25);
  assert.strictEqual(enqueuedTriggers.length, 0);

  // Ignored message: category scheduled_timer
  callback({ metadata: { category: 'scheduled_timer' }, from: 'system:scheduler', content: 'alarm' });
  await flush(25);
  assert.strictEqual(enqueuedTriggers.length, 0);

  // Normal mail message arrives
  callback({ id: 'msg_101', from: 'agent-sender', to: 'agent-reader', content: 'Chapter review ready' });
  await flush(25);
  assert.strictEqual(enqueuedTriggers.length, 1);
  assert.strictEqual(enqueuedTriggers[0].type, DISPATCHER_TRIGGER_TYPES.MAIL);
  assert.strictEqual(enqueuedTriggers[0].targetAgentId, 'agent-reader');
  assert.strictEqual(enqueuedTriggers[0].source, 'agent-sender');

  // Terminated agent mail discarded
  const unsubscribeDead = dispatcher.setupAgentMailSubscription('agent-dead');
  const callbackDead = subscriptions.get('agent-dead');
  callbackDead({ id: 'msg_102', from: 'agent-sender', to: 'agent-dead', content: 'hello' });
  await flush(25);
  assert.strictEqual(enqueuedTriggers.length, 1); // No new trigger enqueued

  // Cleanup
  unsubscribe();
  unsubscribeDead();
  assert.strictEqual(subscriptions.size, 0);
});

// ============================================================================
// 12. TriggerDispatcher Concrete Dispatching (Mail, Schedule, User, Invocation)
// ============================================================================

test('12. TriggerDispatcher Concrete Dispatching (Mail, Schedule, User, Invocation)', async () => {
  const executedTurns = [];
  const mockRuntime = {
    getAgent: (id) => (id === 'dead-agent' ? null : { id }),
    isAgentTerminated: (id) => id === 'dead-agent',
    executeAgentTurn: async (agentId, prompt, options) => {
      executedTurns.push({ agentId, prompt, options });
      return { success: true };
    }
  };

  const inboxMap = new Map();
  const mockMessagingBus = {
    listInbox: (agentId) => inboxMap.get(agentId) || [],
    getUnreadCount: (agentId) => (inboxMap.get(agentId) || []).length
  };

  const dispatcher = new TriggerDispatcher({
    runtime: mockRuntime,
    messagingBus: mockMessagingBus
  });

  // 1. Terminated agent trigger is safely ignored
  const deadRes = await dispatcher.dispatchTrigger({
    triggerId: 'trig_dead',
    type: DISPATCHER_TRIGGER_TYPES.USER,
    targetAgentId: 'dead-agent',
    payload: 'hello'
  });
  assert.strictEqual(deadRes, true);
  assert.strictEqual(executedTurns.length, 0);

  // 2. MAIL trigger dispatching with 1 unread message
  inboxMap.set('agent-reader', [
    { id: 'msg_201', from: 'agent-writer', to: 'agent-reader', content: 'Draft v1' }
  ]);
  await dispatcher.dispatchTrigger({
    triggerId: 'trig_mail_1',
    type: DISPATCHER_TRIGGER_TYPES.MAIL,
    targetAgentId: 'agent-reader',
    source: 'agent-writer',
    payload: { id: 'msg_201' }
  });
  assert.strictEqual(executedTurns.length, 1);
  assert.strictEqual(executedTurns[0].agentId, 'agent-reader');
  assert.ok(executedTurns[0].prompt.includes("[MAIL NOTIFICATION] 1 unread message from 'agent-writer' (ID: 'msg_201')."));
  assert.strictEqual(executedTurns[0].options.triggerType, DISPATCHER_TRIGGER_TYPES.MAIL);
  assert.strictEqual(executedTurns[0].options.autoTrigger, true);

  // 3. MAIL trigger dispatching with multiple unread messages
  inboxMap.set('agent-reader', [
    { id: 'msg_202', from: 'agent-alice', to: 'agent-reader', content: 'One' },
    { id: 'msg_203', from: 'agent-bob', to: 'agent-reader', content: 'Two' }
  ]);
  await dispatcher.dispatchTrigger({
    triggerId: 'trig_mail_2',
    type: DISPATCHER_TRIGGER_TYPES.MAIL,
    targetAgentId: 'agent-reader'
  });
  assert.strictEqual(executedTurns.length, 2);
  assert.ok(executedTurns[1].prompt.includes("[MAIL NOTIFICATION] 2 unread messages from ['agent-alice', 'agent-bob']."));

  // 4. SCHEDULE trigger dispatching
  await dispatcher.dispatchTrigger({
    triggerId: 'trig_sched_1',
    type: DISPATCHER_TRIGGER_TYPES.SCHEDULE,
    targetAgentId: 'agent-reader',
    source: 'system:scheduler',
    payload: { timerId: 'timer_abc', prompt: 'Scheduled audit prompt' }
  });
  assert.strictEqual(executedTurns.length, 3);
  assert.strictEqual(executedTurns[2].prompt, 'Scheduled audit prompt');
  assert.strictEqual(executedTurns[2].options.triggerType, DISPATCHER_TRIGGER_TYPES.SCHEDULE);
  assert.strictEqual(executedTurns[2].options.sender, 'system:scheduler');
  assert.strictEqual(executedTurns[2].options.metadata.timerId, 'timer_abc');

  // 5. USER trigger dispatching
  await dispatcher.dispatchTrigger({
    triggerId: 'trig_user_1',
    type: DISPATCHER_TRIGGER_TYPES.USER,
    targetAgentId: 'agent-reader',
    source: 'user',
    payload: { input: 'User instruction turn', options: { customFlag: true } }
  });
  assert.strictEqual(executedTurns.length, 4);
  assert.strictEqual(executedTurns[3].prompt, 'User instruction turn');
  assert.strictEqual(executedTurns[3].options.triggerType, DISPATCHER_TRIGGER_TYPES.USER);
  assert.strictEqual(executedTurns[3].options.customFlag, true);

  // 6. INVOCATION trigger dispatching with raw prompt
  await dispatcher.dispatchTrigger({
    triggerId: 'trig_invoc_1',
    type: DISPATCHER_TRIGGER_TYPES.INVOCATION,
    targetAgentId: 'agent-reader',
    payload: { prompt: 'Subagent delegating prompt' }
  });
  assert.strictEqual(executedTurns.length, 5);
  assert.strictEqual(executedTurns[4].prompt, 'Subagent delegating prompt');
  assert.strictEqual(executedTurns[4].options.triggerType, DISPATCHER_TRIGGER_TYPES.INVOCATION);

  // 7. INVOCATION trigger dispatching with execute() closure
  let closureExecuted = false;
  await dispatcher.dispatchTrigger({
    triggerId: 'trig_invoc_2',
    type: DISPATCHER_TRIGGER_TYPES.INVOCATION,
    targetAgentId: 'agent-reader',
    payload: {
      execute: async () => {
        closureExecuted = true;
      }
    }
  });
  assert.strictEqual(closureExecuted, true);
});

// ============================================================================
// 12b. MAIL Trigger Edge: getUnreadCount Without listInbox
// ============================================================================

test('12b. MAIL trigger with getUnreadCount but no listInbox is skipped safely', async () => {
  const executedTurns = [];
  const mockRuntime = {
    getAgent: (id) => ({ id }),
    isAgentTerminated: () => false,
    executeAgentTurn: async (agentId, prompt, options) => {
      executedTurns.push({ agentId, prompt, options });
      return { success: true };
    }
  };

  const countOnlyBus = {
    getUnreadCount: () => 3
  };

  const dispatcher = new TriggerDispatcher({
    runtime: mockRuntime,
    messagingBus: countOnlyBus
  });

  const result = await dispatcher.dispatchTrigger({
    triggerId: 'trig_count_only',
    type: DISPATCHER_TRIGGER_TYPES.MAIL,
    targetAgentId: 'agent-reader'
  });

  assert.strictEqual(result, true);
  assert.strictEqual(executedTurns.length, 0, 'no turn may run without readable unread headers');
});

// ============================================================================
// 13. Non-Blocking Invocation Bridge (executeTurnForInvocation)
// ============================================================================

test('13. Non-Blocking Invocation Bridge (executeTurnForInvocation)', async () => {
  const triggerQueue = new TriggerQueue({
    dispatchAction: async (trigger) => {
      if (trigger.payload && typeof trigger.payload.execute === 'function') {
        await trigger.payload.execute();
      }
      return true;
    },
    tickIntervalMs: 10,
    autoStart: true
  });

  const mockRuntime = {
    executeAgentTurn: async (agentId, prompt, options) => {
      await flush(10);
      return { output: `Result for ${agentId}: ${prompt}`, options };
    }
  };

  const dispatcher = new TriggerDispatcher({
    runtime: mockRuntime,
    triggerQueue
  });

  const resultPromise = dispatcher.executeTurnForInvocation(
    'subagent-critic',
    'Evaluate stylistic consistency',
    { invokerId: 'main-writer' }
  );

  const result = await resultPromise;
  assert.deepStrictEqual(result, {
    output: 'Result for subagent-critic: Evaluate stylistic consistency',
    options: { invokerId: 'main-writer' }
  });

  // Rejection handling in invocation closure
  const mockFailingRuntime = {
    executeAgentTurn: async () => {
      throw new Error('Subagent LLM execution failed');
    }
  };
  const failingDispatcher = new TriggerDispatcher({
    runtime: mockFailingRuntime,
    triggerQueue
  });

  await assert.rejects(
    () => failingDispatcher.executeTurnForInvocation('subagent-failing', 'Fail prompt'),
    { message: 'Subagent LLM execution failed' }
  );

  triggerQueue.dispose();
});

// ============================================================================
// 14. End-to-End Integration Flow (RuntimeScheduler -> TriggerQueue -> TriggerDispatcher -> Runtime)
// ============================================================================

test('14. End-to-End Integration Flow', async () => {
  const executedTurns = [];
  const mockRuntime = {
    getAgent: (id) => ({ id, name: `Agent ${id}` }),
    isAgentTerminated: () => false,
    executeAgentTurn: async (agentId, prompt, options) => {
      executedTurns.push({ agentId, prompt, options });
      return { success: true };
    }
  };

  let dispatcher;
  const triggerQueue = new TriggerQueue({
    dispatchAction: async (trigger) => dispatcher.dispatchTrigger(trigger),
    isAgentBusy: () => false,
    tickIntervalMs: 10,
    autoStart: true
  });

  dispatcher = new TriggerDispatcher({
    runtime: mockRuntime,
    triggerQueue
  });

  const scheduler = createScheduler({
    runtime: mockRuntime,
    triggerQueue
  });

  // 1. Schedule a 20ms one-shot alarm
  const receipt = scheduler.schedule({
    agentId: 'director-agent',
    prompt: 'Perform story arc evaluation',
    durationSeconds: 0.02
  });
  assert.strictEqual(receipt.success, true);

  // 2. Wait for timer to expire, trigger to queue, and queue to dispatch
  await flush(80);

  // 3. Verify turn was executed on runtime via the decoupled queue pipeline
  assert.strictEqual(executedTurns.length, 1);
  assert.strictEqual(executedTurns[0].agentId, 'director-agent');
  assert.strictEqual(executedTurns[0].prompt, 'Perform story arc evaluation');
  assert.strictEqual(executedTurns[0].options.triggerType, SCHEDULER_TRIGGER_TYPES.SCHEDULE);
  assert.strictEqual(executedTurns[0].options.sender, 'system:scheduler');
  assert.strictEqual(executedTurns[0].options.metadata.timerId, receipt.timerId);

  // Cleanup
  scheduler.destroy();
  triggerQueue.dispose();
});

// ============================================================================
// 15. Realm Scope (Realm wave A1, ticket 61dae28)
// ============================================================================

test('15. Realm Scope: identity port option and legacy parity', () => {
  // Without an identity port the legacy target semantics are unchanged.
  const legacy = createScheduler();
  const legacyReceipt = legacy.schedule(
    { agentId: 'realm_legacy_b', prompt: 'legacy cross-agent', durationSeconds: 100 },
    { principal: agentAuthority('realm_legacy_a') }
  );
  assert.strictEqual(legacyReceipt.success, true);
  legacy.destroy();

  // Injected identities activate same-realm enforcement for validated principals.
  const identities = {
    realm_agent_a: { realmId: 'R1' },
    realm_agent_b: { realmId: 'R2' }
  };
  const realmScheduler = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority: (id) => schedulerAuthorities.get(id) || null,
    identityPort: {
      getAgentIdentity: (id) => (identities[id] ? { id, ...identities[id] } : null)
    }
  });

  const denied = realmScheduler.schedule(
    { agentId: 'realm_agent_b', prompt: 'cross-realm target', durationSeconds: 100 },
    { principal: agentAuthority('realm_agent_a') }
  );
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(realmScheduler.exportSchedules().length, 0);

  const allowed = realmScheduler.schedule(
    { agentId: 'realm_agent_a', prompt: 'self target', durationSeconds: 100 },
    { principal: agentAuthority('realm_agent_a') }
  );
  assert.strictEqual(allowed.success, true);

  realmScheduler.destroy();
});

// ============================================================================
// 16-17. Wave I canonical identity (ticket d57cbc1)
// ============================================================================

/**
 * Builds a real identity port over a realm-local registration roster (zero
 * mocks: real projections, real canonical keys from the identity helper),
 * mirroring the runtime `AgentIdentityPort`: canonical `key` match first,
 * realm-exact scope resolution, unique-match otherwise (zero/multiple -> null),
 * and `listAgentIdentities()` enumeration.
 *
 * @param {Array<{realmId: string|null, id: string, realmBypass?: boolean}>} roster - Registrations.
 * @returns {{getAgentIdentity: Function, listAgentIdentities: Function}} Identity port.
 */
function createRealmIdentityPort(roster) {
  const registrations = roster.map((entry) => Object.freeze({
    id: entry.id,
    key: createAgentIdentityKey(entry.realmId, entry.id),
    realmId: entry.realmId,
    realmBypass: entry.realmBypass === true
  }));
  return {
    getAgentIdentity(agentId, scope) {
      if (typeof agentId !== 'string' || !agentId) return null;
      const byKey = registrations.find((entry) => entry.key === agentId);
      if (byKey) return byKey;
      if (scope && typeof scope === 'object' && 'realmId' in scope && scope.realmBypass !== true) {
        const realmId = typeof scope.realmId === 'string' && scope.realmId ? scope.realmId : null;
        return registrations.find((entry) => entry.id === agentId && entry.realmId === realmId) || null;
      }
      const matches = registrations.filter((entry) => entry.id === agentId);
      return matches.length === 1 ? matches[0] : null;
    },
    listAgentIdentities() {
      return registrations.slice();
    }
  };
}

/**
 * Frozen registry authority descriptor whose subject is the canonical identity
 * key (the wired facade shape).
 *
 * @param {string} key - Canonical identity key.
 * @param {{privileged?: boolean}} [options] - Capability options.
 * @returns {object} Frozen descriptor.
 */
function keyedAuthority(key, { privileged = false } = {}) {
  return Object.freeze({
    subject: key,
    kind: 'agent',
    allow: new Set(privileged ? ['*'] : []),
    visibility: privileged ? 'all' : 'self'
  });
}

test('16. Wave I: canonical owners stay realm-local and receipts expose bare ids', () => {
  const keyScoutA = createAgentIdentityKey('realm_a', 'scout');
  const keyScoutB = createAgentIdentityKey('realm_b', 'scout');
  const keyPeerA = createAgentIdentityKey('realm_a', 'peer');
  const keyPeerB = createAgentIdentityKey('realm_b', 'peer');
  const identityPort = createRealmIdentityPort([
    { realmId: 'realm_a', id: 'scout' },
    { realmId: 'realm_b', id: 'scout' },
    { realmId: 'realm_a', id: 'peer' },
    { realmId: 'realm_b', id: 'peer' }
  ]);
  const scoutA = keyedAuthority(keyScoutA, { privileged: true });
  const scoutB = keyedAuthority(keyScoutB, { privileged: true });
  const authoritiesByKey = new Map([[keyScoutA, scoutA], [keyScoutB, scoutB]]);
  const scheduler = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority: (ref) => authoritiesByKey.get(ref) || null,
    identityPort
  });
  const contextA = { principal: scoutA, callerKey: keyScoutA };
  const contextB = { principal: scoutB, callerKey: keyScoutB };

  // A realm-A caller schedules for the bare id 'peer': scoped resolution picks
  // realm A's registration, never realm B's same literal id.
  const armedA = scheduler.schedule(
    { agentId: 'peer', prompt: 'realm A wake', durationSeconds: 100 },
    contextA
  );
  assert.strictEqual(armedA.success, true);
  assert.strictEqual(armedA.targetAgentId, 'peer', 'the receipt projects the bare id');
  assert.strictEqual(JSON.stringify(armedA).includes('realm:'), false, 'no realm vocabulary in a schedule receipt');

  // The same literal id armed from realm B by canonical key is a distinct owner.
  const armedB = scheduler.schedule(
    { agentId: keyPeerB, prompt: 'realm B wake', durationSeconds: 100 },
    contextB
  );
  assert.strictEqual(armedB.success, true);
  assert.strictEqual(armedB.targetAgentId, 'peer');
  assert.strictEqual(JSON.stringify(armedB).includes('realm:'), false, 'no canonical key in a schedule receipt');

  // Cross-realm scheduling for a canonical foreign target is denied; the
  // denial names only bare ids.
  const cross = scheduler.schedule(
    { agentId: keyPeerB, prompt: 'cross-realm wake', durationSeconds: 100 },
    contextA
  );
  assert.strictEqual(cross.success, false);
  assert.strictEqual(cross.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(JSON.stringify(cross).includes('realm:'), false, 'no canonical key in a denial');

  // Ownership isolation: each realm lists only its own scope, and no listing
  // carries the canonical key.
  const listA = scheduler.listSchedules({}, contextA);
  assert.deepStrictEqual(listA.schedules.map((entry) => entry.timerId), [armedA.timerId]);
  assert.strictEqual(listA.schedules[0].agentId, 'peer');
  assert.strictEqual(JSON.stringify(listA).includes('realm:'), false, 'no canonical key in listings');
  const listB = scheduler.listSchedules({}, contextB);
  assert.deepStrictEqual(listB.schedules.map((entry) => entry.timerId), [armedB.timerId]);

  // Cancellation is realm-exact even for privileged realm roots.
  const foreignCancel = scheduler.cancelSchedule(armedA.timerId, null, contextB);
  assert.strictEqual(foreignCancel.success, false);
  assert.strictEqual(foreignCancel.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(JSON.stringify(foreignCancel).includes('realm:'), false, 'no canonical key in a denial');
  const ownCancel = scheduler.cancelSchedule(armedA.timerId, null, contextA);
  assert.strictEqual(ownCancel.success, true);
  assert.strictEqual(JSON.stringify(ownCancel).includes('realm:'), false);

  // teardownForAgent accepts the canonical key and touches only that realm.
  const teardownA = scheduler.schedule({ agentId: keyPeerA, prompt: 'teardown A', durationSeconds: 100 }, contextA);
  const teardownB = scheduler.schedule({ agentId: keyPeerB, prompt: 'teardown B', durationSeconds: 100 }, contextB);
  assert.strictEqual(teardownA.success, true);
  assert.strictEqual(teardownB.success, true);
  scheduler.teardownForAgent(keyPeerA, 'realm A terminated');
  const afterTeardown = scheduler.listSchedules({}, { principal: TEST_INTERNAL_PRINCIPAL });
  const teardownStatusOf = (timerId) => afterTeardown.schedules.find((entry) => entry.timerId === timerId).status;
  assert.strictEqual(teardownStatusOf(teardownA.timerId), SCHEDULER_STATUS.CANCELLED, 'the canonical-key teardown cancels its realm');
  assert.strictEqual(teardownStatusOf(teardownB.timerId), SCHEDULER_STATUS.PENDING, 'the other realm stays armed');
  scheduler.teardownForAgent(keyPeerB, 'realm B terminated', true);
  const purged = scheduler.listSchedules({}, { principal: TEST_INTERNAL_PRINCIPAL });
  assert.strictEqual(
    purged.schedules.some((entry) => entry.timerId === teardownB.timerId),
    false,
    'purge removes the exact registration'
  );

  // An unprivileged caller sees and cancels its own canonical-keyed schedule.
  const soloAuthority = keyedAuthority(keyPeerA);
  const soloScheduler = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority: (ref) => (ref === keyPeerA ? soloAuthority : null),
    identityPort
  });
  const soloContext = { principal: soloAuthority, callerKey: keyPeerA };
  const soloSchedule = soloScheduler.schedule(
    { agentId: keyPeerA, prompt: 'solo self wake', durationSeconds: 100 },
    soloContext
  );
  assert.strictEqual(soloSchedule.success, true);
  assert.strictEqual(soloSchedule.targetAgentId, 'peer');
  const soloList = soloScheduler.listSchedules({}, soloContext);
  assert.deepStrictEqual(soloList.schedules.map((entry) => entry.timerId), [soloSchedule.timerId]);
  assert.strictEqual(JSON.stringify(soloList).includes('realm:'), false);
  assert.strictEqual(soloScheduler.cancelSchedule(soloSchedule.timerId, null, soloContext).success, true);
  soloScheduler.destroy();
  // An ambiguous bare broadcast sender satisfies no timer.
  const watchdogA = scheduler.schedule(
    { agentId: 'peer', prompt: 'watchdog A', durationSeconds: 100, timerCondition: 'any' },
    contextA
  );
  const watchdogB = scheduler.schedule(
    { agentId: keyPeerB, prompt: 'watchdog B', durationSeconds: 100, timerCondition: 'any' },
    contextB
  );
  assert.strictEqual(watchdogA.success, true);
  assert.strictEqual(watchdogB.success, true);
  scheduler.handleIncomingMessageForTimers({ from: 'scout', to: 'all', content: 'ambiguous broadcast' });
  const afterBroadcast = scheduler.listSchedules({}, { principal: TEST_INTERNAL_PRINCIPAL });
  const broadcastStatusOf = (timerId) => afterBroadcast.schedules.find((entry) => entry.timerId === timerId).status;
  assert.strictEqual(broadcastStatusOf(watchdogA.timerId), SCHEDULER_STATUS.PENDING, 'an ambiguous bare sender satisfies no timer');
  assert.strictEqual(broadcastStatusOf(watchdogB.timerId), SCHEDULER_STATUS.PENDING);

  scheduler.destroy();
});

test('17. Wave I: forged callerKey never widens and an ambiguous caller fails closed', () => {
  const keyScoutA = createAgentIdentityKey('realm_a', 'scout');
  const keyScoutB = createAgentIdentityKey('realm_b', 'scout');
  const keyPeerA = createAgentIdentityKey('realm_a', 'peer');
  const keyPeerB = createAgentIdentityKey('realm_b', 'peer');
  const identityPort = createRealmIdentityPort([
    { realmId: 'realm_a', id: 'scout' },
    { realmId: 'realm_b', id: 'scout' },
    { realmId: 'realm_a', id: 'peer' },
    { realmId: 'realm_b', id: 'peer' }
  ]);
  const scoutA = keyedAuthority(keyScoutA, { privileged: true });
  const scoutB = keyedAuthority(keyScoutB, { privileged: true });
  const authoritiesByKey = new Map([[keyScoutA, scoutA], [keyScoutB, scoutB]]);
  const scheduler = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority: (ref) => authoritiesByKey.get(ref) || null,
    identityPort
  });

  // A forged callerKey (another registration's key) is rejected by the
  // registry binding check; the principal's own realm stays authoritative.
  const forged = scheduler.schedule(
    { agentId: keyPeerB, prompt: 'forged caller key', durationSeconds: 100 },
    { principal: scoutA, callerKey: keyScoutB }
  );
  assert.strictEqual(forged.success, false, 'a forged callerKey never widens scope');
  assert.strictEqual(forged.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // The same caller with its genuine key can still reach its own realm.
  const genuine = scheduler.schedule(
    { agentId: keyPeerA, prompt: 'genuine caller key', durationSeconds: 100 },
    { principal: scoutA, callerKey: keyScoutA }
  );
  assert.strictEqual(genuine.success, true);

  // A bare-subject principal registered in two realms is ambiguous: no
  // projection resolves, so realm-scoped wake/cancel/list fail closed.
  const ambiguousAuthority = Object.freeze({
    subject: 'scout',
    kind: 'agent',
    allow: new Set(['*']),
    visibility: 'all'
  });
  const ambiguousScheduler = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority: (ref) => (ref === 'scout' ? ambiguousAuthority : (authoritiesByKey.get(ref) || null)),
    identityPort
  });
  const ambiguousContext = { principal: ambiguousAuthority };
  const ambiguousWake = ambiguousScheduler.schedule(
    { agentId: 'peer', prompt: 'ambiguous wake', durationSeconds: 100 },
    ambiguousContext
  );
  assert.strictEqual(ambiguousWake.success, false, 'an ambiguous caller cannot arm a realm-scoped timer');
  assert.strictEqual(ambiguousWake.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  assert.deepStrictEqual(
    ambiguousScheduler.listSchedules({}, ambiguousContext).schedules,
    [],
    'an ambiguous caller sees no realm schedules'
  );
  // A timer armed by the engine principal for the ambiguous bare id stays
  // uncancellable by the ambiguous agent caller (its realm is unknowable).
  const engineArmed = ambiguousScheduler.schedule(
    { agentId: 'peer', prompt: 'engine armed', durationSeconds: 100 },
    { principal: TEST_INTERNAL_PRINCIPAL }
  );
  assert.strictEqual(engineArmed.success, true);
  assert.strictEqual(
    ambiguousScheduler.cancelSchedule(engineArmed.timerId, null, ambiguousContext).code,
    SCHEDULER_ERROR_CODES.PERMISSION_DENIED
  );

  scheduler.destroy();
  ambiguousScheduler.destroy();
});
