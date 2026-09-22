/**
 * @file tests/unit/trigger_queue_module_test.js
 * @description Comprehensive isolated unit test suite for Module 4: TriggerQueue.
 * 
 * Verifies strict contract conformance and architectural invariants:
 * 1. Strict Export Whitelist & Constant Immutability
 * 2. Absolute Encapsulation & Surface Integrity (Zero Leaked Internal State)
 * 3. Configuration & Options Handling (Defaults & Boundary Values)
 * 4. Ingestion Validation & Schema Guarantees (enqueue)
 * 5. Anti-Head-of-Line (HoL) Blocking (Mathematical 0 cross-agent starvation)
 * 6. Intra-Agent FIFO Serialization (Strict arrival order preservation)
 * 7. Dispatch Hook Semantics & Re-insertion on Retry
 * 8. Error Resilience & Non-Crashing Dispatch
 * 9. Concurrency, Reentrancy & Microtask Coalescing
 * 10. Background Interval Ticking & Lifecycle Management
 * 11. Diagnostics & Non-Mutating Snapshots
 * 12. Realm-Confined Dispatch (injected identities)
 * 13. Canonical Identity Keys — Two Realms, One Bare Id (Wave I, d57cbc1)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as TriggerQueueModule from '../../src/lib/sandbox/triggerQueue/index.ts';
import { TRIGGER_TYPES as DISPATCHER_TRIGGER_TYPES } from '../../src/lib/sandbox/runtime/triggerDispatcher/index.ts';
import { createAgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

const {
  TriggerQueue,
  TRIGGER_TYPES,
  TRIGGER_QUEUE_ERROR_CODES,
  TriggerQueueError
} = TriggerQueueModule;

// Helper to flush asynchronous microtasks and timer queues
const flushMicrotasks = (delayMs = 10) => new Promise((resolve) => setTimeout(resolve, delayMs));

// ============================================================================
// 1. Strict Export Whitelist & Constant Immutability
// ============================================================================

test('1. Strict Export Whitelist & Constant Immutability', () => {
  const exports = Object.keys(TriggerQueueModule).sort();
  assert.deepStrictEqual(exports, [
    'TRIGGER_QUEUE_ERROR_CODES',
    'TRIGGER_TYPES',
    'TriggerQueue',
    'TriggerQueueError'
  ]);

  // Validate canonical TRIGGER_TYPES
  assert.strictEqual(TRIGGER_TYPES.MAIL, 'mail');
  assert.strictEqual(TRIGGER_TYPES.INVOCATION, 'invocation');
  assert.strictEqual(TRIGGER_TYPES.SCHEDULE, 'schedule');
  assert.strictEqual(TRIGGER_TYPES.USER, 'user');
  assert.ok(Object.isFrozen(TRIGGER_TYPES), 'TRIGGER_TYPES must be frozen');
  assert.strictEqual(TRIGGER_TYPES, DISPATCHER_TRIGGER_TYPES,
    'TriggerQueue must re-export the single canonical dispatcher TRIGGER_TYPES object');

  // Verify immutability of TRIGGER_TYPES
  assert.throws(() => {
    // @ts-expect-error mutating frozen object
    TRIGGER_TYPES.MAIL = 'modified';
  }, TypeError);

  // Validate TRIGGER_QUEUE_ERROR_CODES values
  assert.strictEqual(TRIGGER_QUEUE_ERROR_CODES.INVALID_ARGUMENT, 'INVALID_ARGUMENT');
  assert.strictEqual(TRIGGER_QUEUE_ERROR_CODES.INVALID_TARGET_AGENT, 'INVALID_TARGET_AGENT');
  assert.strictEqual(TRIGGER_QUEUE_ERROR_CODES.INVALID_TRIGGER_TYPE, 'INVALID_TRIGGER_TYPE');
  assert.ok(Object.isFrozen(TRIGGER_QUEUE_ERROR_CODES), 'TRIGGER_QUEUE_ERROR_CODES must be frozen');

  // Verify immutability of TRIGGER_QUEUE_ERROR_CODES
  assert.throws(() => {
    // @ts-expect-error mutating frozen object
    TRIGGER_QUEUE_ERROR_CODES.INVALID_ARGUMENT = 'modified';
  }, TypeError);

  // Validate TriggerQueueError class
  const errNoDetails = new TriggerQueueError('Test error', TRIGGER_QUEUE_ERROR_CODES.INVALID_ARGUMENT);
  assert.strictEqual(errNoDetails instanceof Error, true);
  assert.strictEqual(errNoDetails instanceof TriggerQueueError, true);
  assert.strictEqual(errNoDetails.name, 'TriggerQueueError');
  assert.strictEqual(errNoDetails.message, 'Test error');
  assert.strictEqual(errNoDetails.code, 'INVALID_ARGUMENT');
  assert.strictEqual(errNoDetails.details, undefined);

  const errWithDetails = new TriggerQueueError(
    'Details error',
    TRIGGER_QUEUE_ERROR_CODES.INVALID_TARGET_AGENT,
    { agentId: 'agent-xyz', reason: 'blank' }
  );
  assert.strictEqual(errWithDetails.code, 'INVALID_TARGET_AGENT');
  assert.deepStrictEqual(errWithDetails.details, { agentId: 'agent-xyz', reason: 'blank' });
  assert.ok(Object.isFrozen(errWithDetails.details), 'Error details must be frozen');
});

// ============================================================================
// 2. Absolute Encapsulation & Surface Integrity
// ============================================================================

test('2. Absolute Encapsulation (No Leaky Public Queues or Private State)', () => {
  const queue = new TriggerQueue({ autoStart: false });

  // Verify private fields are completely encapsulated
  assert.strictEqual(queue.pendingQueue, undefined, 'pendingQueue must be private');
  assert.strictEqual(queue.queue, undefined, 'queue must be private');
  assert.strictEqual(queue.dispatchAction, undefined, 'dispatchAction must be private');
  assert.strictEqual(queue.isAgentBusy, undefined, 'isAgentBusy must be private');
  assert.strictEqual(queue.timerHandle, undefined, 'timerHandle must be private');
  assert.strictEqual(queue.isTicking, undefined, 'isTicking must be private');
  assert.strictEqual(queue.hasPendingTick, undefined, 'hasPendingTick must be private');

  // Verify legacy manipulation methods do NOT exist
  assert.strictEqual(queue.peek, undefined, 'peek must not exist');
  assert.strictEqual(queue.dequeue, undefined, 'dequeue must not exist');
  assert.strictEqual(queue.pop, undefined, 'pop must not exist');
  assert.strictEqual(queue.shift, undefined, 'shift must not exist');

  // Verify public API surface
  assert.strictEqual(typeof queue.enqueue, 'function');
  assert.strictEqual(typeof queue.processTick, 'function');
  assert.strictEqual(typeof queue.startProcessing, 'function');
  assert.strictEqual(typeof queue.stopProcessing, 'function');
  assert.strictEqual(typeof queue.clear, 'function');
  assert.strictEqual(typeof queue.dispose, 'function');
  assert.strictEqual(typeof queue.getPendingCount, 'function');
  assert.strictEqual(typeof queue.getPendingTriggers, 'function');
  assert.strictEqual(typeof queue.isProcessing, 'boolean');
  assert.strictEqual(typeof queue.tickIntervalMs, 'number');

  queue.dispose();
});

// ============================================================================
// 3. Configuration & Options Handling
// ============================================================================

test('3. Construction Options & Defaults', () => {
  // Default options
  const defaultQueue = new TriggerQueue();
  assert.strictEqual(defaultQueue.isProcessing, true, 'Default autoStart should be true');
  assert.strictEqual(defaultQueue.tickIntervalMs, 25, 'Default tickIntervalMs should be 25');
  defaultQueue.dispose();
  assert.strictEqual(defaultQueue.isProcessing, false);

  // Custom tickIntervalMs
  const customQueue = new TriggerQueue({
    autoStart: false,
    tickIntervalMs: 50
  });
  assert.strictEqual(customQueue.isProcessing, false);
  assert.strictEqual(customQueue.tickIntervalMs, 50);
  customQueue.dispose();

  // Invalid or negative tickIntervalMs falls back to default 25
  const fallbackQueue1 = new TriggerQueue({ autoStart: false, tickIntervalMs: -10 });
  assert.strictEqual(fallbackQueue1.tickIntervalMs, 25);
  fallbackQueue1.dispose();

  const fallbackQueue2 = new TriggerQueue({ autoStart: false, tickIntervalMs: 0 });
  assert.strictEqual(fallbackQueue2.tickIntervalMs, 25);
  fallbackQueue2.dispose();

  const fallbackQueue3 = new TriggerQueue({ autoStart: false, tickIntervalMs: '50' });
  assert.strictEqual(fallbackQueue3.tickIntervalMs, 25);
  fallbackQueue3.dispose();
});

// ============================================================================
// 4. Ingestion Validation & Schema Guarantees (enqueue)
// ============================================================================

test('4. enqueue Ingestion Validation & Trigger Schema', () => {
  const queue = new TriggerQueue({ autoStart: false });

  // 4.1 Invalid triggerData argument
  const invalidArgs = [null, undefined, 123, 'string', true, []];
  for (const arg of invalidArgs) {
    assert.throws(
      () => queue.enqueue(arg),
      (err) => err instanceof TriggerQueueError && err.code === TRIGGER_QUEUE_ERROR_CODES.INVALID_ARGUMENT
    );
  }

  // 4.2 Invalid targetAgentId
  const invalidAgents = [
    {},
    { type: 'mail' },
    { type: 'mail', targetAgentId: null },
    { type: 'mail', targetAgentId: 123 },
    { type: 'mail', targetAgentId: '' },
    { type: 'mail', targetAgentId: '   ' }
  ];
  for (const arg of invalidAgents) {
    assert.throws(
      () => queue.enqueue(arg),
      (err) => err instanceof TriggerQueueError && err.code === TRIGGER_QUEUE_ERROR_CODES.INVALID_TARGET_AGENT
    );
  }

  // 4.3 Invalid trigger type
  const invalidTypes = [
    { targetAgentId: 'agent-1' },
    { targetAgentId: 'agent-1', type: null },
    { targetAgentId: 'agent-1', type: 'INVALID_TYPE' },
    { targetAgentId: 'agent-1', type: 'message' },
    { targetAgentId: 'agent-1', type: 123 }
  ];
  for (const arg of invalidTypes) {
    assert.throws(
      () => queue.enqueue(arg),
      (err) => err instanceof TriggerQueueError && err.code === TRIGGER_QUEUE_ERROR_CODES.INVALID_TRIGGER_TYPE
    );
  }

  // 4.4 Valid Ingestion across all 4 canonical types
  const startTime = Date.now();
  const validTypes = [
    TRIGGER_TYPES.MAIL,
    TRIGGER_TYPES.INVOCATION,
    TRIGGER_TYPES.SCHEDULE,
    TRIGGER_TYPES.USER
  ];

  for (const type of validTypes) {
    const triggerId = queue.enqueue({
      type,
      targetAgentId: '  agent-alpha  ',
      source: '  coordinator  ',
      payload: { testType: type }
    });

    assert.ok(typeof triggerId === 'string');
    assert.ok(triggerId.startsWith('trig_'));
  }

  // Verify default source and payload handling
  const minimalId = queue.enqueue({
    type: TRIGGER_TYPES.MAIL,
    targetAgentId: 'agent-beta'
  });
  assert.ok(typeof minimalId === 'string');

  const pending = queue.getPendingTriggers();
  assert.strictEqual(pending.length, 5);

  // Check normalization on alpha triggers
  const alphaTrigger = pending[0];
  assert.strictEqual(alphaTrigger.targetAgentId, 'agent-alpha');
  assert.strictEqual(alphaTrigger.source, 'coordinator');
  assert.deepStrictEqual(alphaTrigger.payload, { testType: 'mail' });
  assert.ok(alphaTrigger.timestamp >= startTime);
  assert.ok(Object.isFrozen(alphaTrigger), 'AgentTrigger record must be frozen');

  // Check defaults on minimal trigger
  const betaTrigger = pending[4];
  assert.strictEqual(betaTrigger.targetAgentId, 'agent-beta');
  assert.strictEqual(betaTrigger.source, 'unknown');
  assert.strictEqual(betaTrigger.payload, null);

  queue.dispose();
});

// ============================================================================
// 5. Anti-Head-of-Line (HoL) Blocking
// ============================================================================

test('5. Anti-Head-of-Line Blocking: Busy agents never delay idle agents', async () => {
  const busyStatus = {
    'agent-busy-1': true,
    'agent-busy-2': true,
    'agent-idle-1': false,
    'agent-idle-2': false
  };

  /** @type {import('../../src/lib/sandbox/triggerQueue/index.ts').AgentTrigger[]} */
  const dispatchedTriggers = [];

  const queue = new TriggerQueue({
    autoStart: false,
    isAgentBusy: (agentId) => Boolean(busyStatus[agentId]),
    dispatchAction: async (trigger) => {
      dispatchedTriggers.push(trigger);
      return true;
    }
  });

  // Interleave triggers: Busy agent triggers at head of queue
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-busy-1', payload: { seq: 1 } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-busy-2', payload: { seq: 2 } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-idle-1', payload: { seq: 3 } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-idle-2', payload: { seq: 4 } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-busy-1', payload: { seq: 5 } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-idle-1', payload: { seq: 6 } });

  // Flush the microtask triggered by enqueue (Tick 1)
  await flushMicrotasks();

  // Tick 1: Idle agents (idle-1, idle-2) MUST be dispatched immediately without being blocked by busy-1 or busy-2
  assert.strictEqual(dispatchedTriggers.length, 2);
  assert.strictEqual(dispatchedTriggers[0].targetAgentId, 'agent-idle-1');
  assert.strictEqual(dispatchedTriggers[0].payload.seq, 3);
  assert.strictEqual(dispatchedTriggers[1].targetAgentId, 'agent-idle-2');
  assert.strictEqual(dispatchedTriggers[1].payload.seq, 4);

  // Busy triggers and the 2nd trigger for idle-1 remain pending
  assert.strictEqual(queue.getPendingCount(), 4);
  assert.strictEqual(queue.getPendingCount('agent-busy-1'), 2);
  assert.strictEqual(queue.getPendingCount('agent-busy-2'), 1);
  assert.strictEqual(queue.getPendingCount('agent-idle-1'), 1);

  // Tick 2: idle-1 is still idle, its second trigger should dispatch now
  await queue.processTick();
  assert.strictEqual(dispatchedTriggers.length, 3);
  assert.strictEqual(dispatchedTriggers[2].targetAgentId, 'agent-idle-1');
  assert.strictEqual(dispatchedTriggers[2].payload.seq, 6);
  assert.strictEqual(queue.getPendingCount('agent-idle-1'), 0);

  // Release busy-1
  busyStatus['agent-busy-1'] = false;
  await queue.processTick();

  // busy-1's first trigger (seq 1) dispatches
  assert.strictEqual(dispatchedTriggers.length, 4);
  assert.strictEqual(dispatchedTriggers[3].targetAgentId, 'agent-busy-1');
  assert.strictEqual(dispatchedTriggers[3].payload.seq, 1);

  // Release busy-2
  busyStatus['agent-busy-2'] = false;
  await queue.processTick();

  // busy-1's second trigger (seq 5) and busy-2's trigger (seq 2) dispatch
  assert.strictEqual(dispatchedTriggers.length, 6);
  assert.strictEqual(queue.getPendingCount(), 0);

  queue.dispose();
});

// ============================================================================
// 6. Intra-Agent FIFO Serialization
// ============================================================================

test('6. Intra-Agent FIFO Serialization: Strict arrival order per agent', async () => {
  const dispatchedIds = [];

  const queue = new TriggerQueue({
    autoStart: false,
    dispatchAction: async (trigger) => {
      dispatchedIds.push(trigger.payload.order);
      return true;
    }
  });

  // Enqueue 5 triggers for the SAME agent
  const total = 5;
  for (let i = 1; i <= total; i++) {
    queue.enqueue({
      type: TRIGGER_TYPES.MAIL,
      targetAgentId: 'serialized-agent',
      payload: { order: i }
    });
  }

  // Microtask handles Tick 1 (dispatches order 1)
  await flushMicrotasks();
  assert.strictEqual(dispatchedIds.length, 1);
  assert.strictEqual(dispatchedIds[0], 1);
  assert.strictEqual(queue.getPendingCount('serialized-agent'), 4);

  // Subsequent ticks dispatch each remaining trigger in strict arrival order
  for (let step = 2; step <= total; step++) {
    await queue.processTick();
    assert.strictEqual(dispatchedIds.length, step);
    assert.strictEqual(dispatchedIds[step - 1], step);
  }

  assert.deepStrictEqual(dispatchedIds, [1, 2, 3, 4, 5]);
  assert.strictEqual(queue.getPendingCount('serialized-agent'), 0);

  queue.dispose();
});

// ============================================================================
// 7. Dispatch Hook Semantics & Re-insertion on Retry
// ============================================================================

test('7. Dispatch Hook: Returning false re-inserts trigger at agent queue head', async () => {
  let attemptCount = 0;
  const dispatchLog = [];

  const queue = new TriggerQueue({
    autoStart: false,
    dispatchAction: async (trigger) => {
      dispatchLog.push({ id: trigger.payload.id, attempt: ++attemptCount });
      // Fail on first attempt for trigger A1, succeed on second attempt
      if (trigger.payload.id === 'A1' && attemptCount === 1) {
        return false; // Request retry / re-insert
      }
      return true; // Handled
    }
  });

  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-retry', payload: { id: 'A1' } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-retry', payload: { id: 'A2' } });

  // Flush microtask: Tick 1 runs, A1 evaluates and returns false -> re-inserted at head of agent-retry
  await flushMicrotasks();
  assert.strictEqual(dispatchLog.length, 1);
  assert.strictEqual(dispatchLog[0].id, 'A1');
  assert.strictEqual(dispatchLog[0].attempt, 1);

  // Verify A1 is still pending and at the head before A2
  const pending = queue.getPendingTriggers('agent-retry');
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[0].payload.id, 'A1');
  assert.strictEqual(pending[1].payload.id, 'A2');

  // Tick 2: A1 is retried first and succeeds
  await queue.processTick();
  assert.strictEqual(dispatchLog.length, 2);
  assert.strictEqual(dispatchLog[1].id, 'A1');
  assert.strictEqual(dispatchLog[1].attempt, 2);

  // Tick 3: A2 is evaluated and succeeds
  await queue.processTick();
  assert.strictEqual(dispatchLog.length, 3);
  assert.strictEqual(dispatchLog[2].id, 'A2');

  assert.strictEqual(queue.getPendingCount(), 0);
  queue.dispose();
});

test('7.2 Dispatch Hook: Multi-agent retry isolation', async () => {
  const queue = new TriggerQueue({
    autoStart: false,
    dispatchAction: async (trigger) => {
      if (trigger.targetAgentId === 'agent-fail') {
        return false;
      }
      return true;
    }
  });

  queue.enqueue({ type: TRIGGER_TYPES.INVOCATION, targetAgentId: 'agent-fail', payload: { id: 'f1' } });
  queue.enqueue({ type: TRIGGER_TYPES.INVOCATION, targetAgentId: 'agent-success', payload: { id: 's1' } });

  await flushMicrotasks();

  // agent-fail trigger was re-inserted, agent-success trigger completed
  assert.strictEqual(queue.getPendingCount('agent-fail'), 1);
  assert.strictEqual(queue.getPendingCount('agent-success'), 0);

  queue.dispose();
});

// ============================================================================
// 8. Error Resilience & Non-Crashing Dispatch
// ============================================================================

test('8. Error Resilience: Throwing in dispatchAction does not crash tick loop', async () => {
  const handled = [];

  const queue = new TriggerQueue({
    autoStart: false,
    dispatchAction: async (trigger) => {
      if (trigger.payload.id === 'failing-trigger') {
        throw new Error('Boom: Dispatcher execution failed');
      }
      handled.push(trigger.payload.id);
      return true;
    }
  });

  queue.enqueue({ type: TRIGGER_TYPES.INVOCATION, targetAgentId: 'agent-1', payload: { id: 'failing-trigger' } });
  queue.enqueue({ type: TRIGGER_TYPES.INVOCATION, targetAgentId: 'agent-2', payload: { id: 'healthy-trigger' } });

  // Flush microtasks - tick loop handles errors gracefully
  await flushMicrotasks();

  // The healthy trigger on agent-2 dispatched successfully
  assert.deepStrictEqual(handled, ['healthy-trigger']);
  // The failing trigger was discarded
  assert.strictEqual(queue.getPendingCount(), 0);

  queue.dispose();
});

// ============================================================================
// 9. Concurrency, Reentrancy & Microtask Coalescing
// ============================================================================

test('9. Concurrency & Microtask Processing: enqueue kicks microtask evaluation', async () => {
  const dispatched = [];

  const queue = new TriggerQueue({
    autoStart: false, // Interval is off, but enqueue schedules microtask
    dispatchAction: async (trigger) => {
      dispatched.push(trigger.payload.id);
      return true;
    }
  });

  queue.enqueue({ type: TRIGGER_TYPES.USER, targetAgentId: 'agent-micro', payload: { id: 'u1' } });

  // Immediately after enqueue, it is not yet dispatched synchronously
  assert.strictEqual(dispatched.length, 0);

  // Wait for microtask tick
  await flushMicrotasks();

  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0], 'u1');
  assert.strictEqual(queue.getPendingCount(), 0);

  queue.dispose();
});

test('9.2 Concurrency: Overlapping processTick calls coalesce safely', async () => {
  const executionOrder = [];

  const queue = new TriggerQueue({
    autoStart: false,
    dispatchAction: async (trigger) => {
      await new Promise((r) => setTimeout(r, 20));
      executionOrder.push(trigger.payload.id);
      return true;
    }
  });

  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-conc-1', payload: { id: 'm1' } });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-conc-2', payload: { id: 'm2' } });

  // Trigger concurrent ticks
  const tick1 = queue.processTick();
  const tick2 = queue.processTick();
  const tick3 = queue.processTick();

  await Promise.all([tick1, tick2, tick3]);
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(executionOrder.length, 2);
  assert.ok(executionOrder.includes('m1'));
  assert.ok(executionOrder.includes('m2'));
  assert.strictEqual(queue.getPendingCount(), 0);

  queue.dispose();
});

// ============================================================================
// 10. Background Interval Ticking & Lifecycle Management
// ============================================================================

test('10. Background Interval Ticking & Lifecycle Management', async () => {
  const dispatched = [];

  const queue = new TriggerQueue({
    autoStart: true,
    tickIntervalMs: 15,
    dispatchAction: async (trigger) => {
      dispatched.push(trigger.payload.id);
      return true;
    }
  });

  assert.strictEqual(queue.isProcessing, true);

  // Idempotency of startProcessing
  queue.startProcessing();
  assert.strictEqual(queue.isProcessing, true);

  queue.enqueue({ type: TRIGGER_TYPES.SCHEDULE, targetAgentId: 'agent-timer', payload: { id: 'sched-1' } });

  // Wait for periodic timer / microtask to trigger
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0], 'sched-1');

  // Stop processing
  queue.stopProcessing();
  assert.strictEqual(queue.isProcessing, false);

  // Idempotency of stopProcessing
  queue.stopProcessing();
  assert.strictEqual(queue.isProcessing, false);

  // Enqueue while stopped (and clear before microtask)
  queue.enqueue({ type: TRIGGER_TYPES.SCHEDULE, targetAgentId: 'agent-timer', payload: { id: 'sched-2' } });
  assert.strictEqual(queue.getPendingCount(), 1);

  queue.clear();
  assert.strictEqual(queue.getPendingCount(), 0);

  // Dispose teardown
  queue.startProcessing();
  assert.strictEqual(queue.isProcessing, true);
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-timer', payload: { id: 'sched-3' } });
  queue.dispose();
  assert.strictEqual(queue.isProcessing, false);
  assert.strictEqual(queue.getPendingCount(), 0);
});

// ============================================================================
// 11. Diagnostics & Non-Mutating Snapshots
// ============================================================================

test('11. Diagnostics: getPendingCount and getPendingTriggers Snapshot Immutability', () => {
  const queue = new TriggerQueue({ autoStart: false });

  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-x', payload: { n: 1 } });
  queue.enqueue({ type: TRIGGER_TYPES.INVOCATION, targetAgentId: 'agent-y', payload: { n: 2 } });
  queue.enqueue({ type: TRIGGER_TYPES.SCHEDULE, targetAgentId: 'agent-x', payload: { n: 3 } });

  // Count checks
  assert.strictEqual(queue.getPendingCount(), 3);
  assert.strictEqual(queue.getPendingCount('agent-x'), 2);
  assert.strictEqual(queue.getPendingCount('agent-y'), 1);
  assert.strictEqual(queue.getPendingCount('agent-unknown'), 0);

  // Snapshot retrieval
  const allTriggers = queue.getPendingTriggers();
  assert.strictEqual(allTriggers.length, 3);
  assert.ok(Object.isFrozen(allTriggers), 'Snapshot array must be frozen');

  // Attempting to mutate snapshot array should throw in strict mode
  assert.throws(() => {
    allTriggers.push({});
  }, TypeError);

  // Attempting to mutate snapshot item should throw in strict mode
  assert.throws(() => {
    allTriggers[0].targetAgentId = 'mutated';
  }, TypeError);

  // Internal queue state must remain intact
  assert.strictEqual(queue.getPendingCount(), 3);

  // Filtered snapshot
  const xTriggers = queue.getPendingTriggers('agent-x');
  assert.strictEqual(xTriggers.length, 2);
  assert.strictEqual(xTriggers[0].payload.n, 1);
  assert.strictEqual(xTriggers[1].payload.n, 3);

  queue.dispose();
});

// ============================================================================
// 12. Realm-Confined Dispatch (Realm wave A1, ticket 61dae28)
// ============================================================================

test('12. Realm-Confined Dispatch with injected identities', async () => {
  const identities = {
    'agent-a1': { realmId: 'R1' },
    'agent-a2': { realmId: 'R1' },
    'agent-b1': { realmId: 'R2' }
  };
  const identityPort = {
    getAgentIdentity: (id) => (identities[id] ? { id, ...identities[id] } : null)
  };
  const dispatched = [];
  const queue = new TriggerQueue({
    autoStart: false,
    identityPort,
    dispatchAction: async (trigger) => {
      dispatched.push(trigger);
      return true;
    }
  });

  const sameRealmTriggerId = queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-a2', source: 'agent-a1' });
  const crossRealmTriggerId = queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'agent-b1', source: 'agent-a1' });
  assert.notStrictEqual(sameRealmTriggerId, crossRealmTriggerId);

  await queue.processTick();

  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].targetAgentId, 'agent-a2');
  assert.strictEqual(dispatched[0].source, 'agent-a1');
  assert.strictEqual(queue.getPendingCount(), 0, 'denied trigger is dropped, not re-queued');

  queue.dispose();
});

// ============================================================================
// 13. Canonical Identity Keys — Two Realms, One Bare Id (Wave I, d57cbc1)
// ============================================================================

/**
 * Launches a real two-realm fixture on a real `AgentRuntime`: the bootstrapped
 * system director (the only realm-bypass identity), one privileged root per
 * realm, and the same literal `shared` id registered in both realms.
 *
 * @returns Real runtime fixture with resolved realm-exact projections.
 */
async function launchTwoRealmRuntime() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
  for (const realmId of ['realm_i2_alpha', 'realm_i2_beta']) {
    await runtime.launchAgent({
      config: { id: `${realmId}_root`, realmId, privileged: true, allowedTools: ['*'] },
      principal: operator
    });
  }
  await runtime.launchAgent({ id: 'shared', realmId: 'realm_i2_alpha', allowedTools: ['read_file'] });
  await runtime.launchAgent({ id: 'shared', realmId: 'realm_i2_beta', allowedTools: ['read_file'] });

  const port = runtime.createAgentIdentityPort();
  return {
    runtime,
    port,
    director: port.getAgentIdentity('director'),
    alphaRoot: port.getAgentIdentity('realm_i2_alpha_root'),
    betaRoot: port.getAgentIdentity('realm_i2_beta_root'),
    alphaShared: port.getAgentIdentity('shared', { realmId: 'realm_i2_alpha' }),
    betaShared: port.getAgentIdentity('shared', { realmId: 'realm_i2_beta' })
  };
}

test('13. Canonical identity keys: dispatch stays realm-confined, bypass spans, diagnostics are bare', async () => {
  const fixture = await launchTwoRealmRuntime();
  const { runtime, port, director, alphaRoot, betaRoot, alphaShared, betaShared } = fixture;
  try {
    assert.equal(alphaShared.id, 'shared');
    assert.equal(betaShared.id, 'shared');
    assert.equal(port.getAgentIdentity('shared'), null, 'the bare id is ambiguous across realms');

    const dispatched = [];
    const queue = new TriggerQueue({
      autoStart: false,
      identityPort: port,
      // Beta's root stays busy so the bypass-delivered trigger remains pending.
      isAgentBusy: (agentId) => agentId === betaRoot.key,
      dispatchAction: async (trigger) => {
        dispatched.push(trigger);
        return true;
      }
    });

    // Same-realm (canonical keys) and self-target wakeups dispatch.
    queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: alphaRoot.key, sourceKey: alphaShared.key, source: 'shared' });
    // Foreign-realm target with the same bare id is dropped.
    queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: betaShared.key, sourceKey: alphaShared.key, source: 'shared' });
    // Self by canonical key dispatches.
    queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: alphaShared.key, sourceKey: alphaShared.key, source: 'shared' });
    // A realm-bypass director (system scope) may wake a foreign-realm target.
    queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: betaRoot.key, sourceKey: director.key, source: 'director' });
    // An ambiguous bare target is dropped, exactly like a foreign one.
    queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'shared', sourceKey: alphaRoot.key, source: 'realm_i2_alpha_root' });
    // An unresolvable source keeps the legacy dispatch semantics.
    queue.enqueue({ type: TRIGGER_TYPES.SCHEDULE, targetAgentId: betaShared.key, source: 'system:scheduler' });

    await queue.processTick();

    const dispatchedTargets = dispatched.map((trigger) => trigger.targetAgentId).sort();
    assert.deepEqual(
      dispatchedTargets,
      [alphaRoot.key, alphaShared.key, betaShared.key].sort(),
      'only the same-realm, self, bypass, and legacy triggers dispatch'
    );
    assert.equal(
      dispatched.some((trigger) => trigger.targetAgentId === betaShared.key && trigger.source === 'system:scheduler'),
      true,
      'the legacy scheduler source still reaches its target'
    );
    assert.equal(queue.getPendingCount(), 1, 'the busy bypass delivery stays pending; denied triggers are dropped');

    const pending = queue.getPendingTriggers();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].targetAgentId, 'realm_i2_beta_root', 'diagnostics project the bare id');
    assert.equal(pending[0].source, 'director');
    assert.equal(JSON.stringify(pending).includes('realm:'), false, 'diagnostics carry no canonical keys');
    assert.equal(queue.getPendingCount(betaRoot.key), 1, 'filtering by the supplied identifier works');
    assert.equal(queue.getPendingCount('realm_i2_beta_root'), 1, 'filtering by the projected bare id works');

    queue.dispose();
  } finally {
    runtime.destroy();
  }
});
