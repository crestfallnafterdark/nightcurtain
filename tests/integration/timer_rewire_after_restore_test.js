/**
 * @file tests/integration/timer_rewire_after_restore_test.js
 * @description Behavioral regression suite for BUG-ENC-001 (P2.1 / R-A):
 * AgentRuntime must own the MessagingBus early-cancellation listener lifecycle
 * across reset() and importSnapshot(), independent of any persistence rewire.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

function createMockModel(fn, modelId = 'test-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'test-provider',
      createModel: (mId) => createMockModel(fn, mId),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream() {
      const res = await fn();
      if (typeof res === 'string') yield { type: 'text', content: res };
      else if (res?.text) yield { type: 'text', content: res.text };
    },
    async complete() {
      return await fn();
    }
  };
}

/**
 * Trusted scheduler context for the owning agent: the runtime resolves the
 * agent's frozen registry `AuthorityDescriptor` from the identity claim, so
 * caller-declared privilege flags are never used (MOD-21 W3).
 * @param {AgentRuntime} runtime
 * @param {string} agentId
 * @returns {{ principal: Object }}
 */
function ownerContext(runtime, agentId) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity(agentId);
  return identity?.authority ? { principal: identity.authority } : {};
}

/**
 * Reads a schedule projection through the public listSchedules() API.
 * @param {AgentRuntime} runtime
 * @param {string} timerId
 * @param {string} [agentId='timer-agent']
 * @returns {Object|null}
 */
function findSchedule(runtime, timerId, agentId = 'timer-agent') {
  const { schedules } = runtime.listSchedules({}, ownerContext(runtime, agentId));
  return schedules.find((schedule) => schedule.timerId === timerId) || null;
}

/**
 * Returns every schedule still pending or active according to listSchedules().
 * @param {AgentRuntime} runtime
 * @returns {Array<Object>}
 */
function listPendingOrActive(runtime) {
  const { schedules } = runtime.listSchedules({}, ownerContext(runtime, 'timer-agent'));
  return schedules.filter((schedule) => schedule.status === 'pending' || schedule.status === 'active');
}

test('1. reset() re-binds the bus timer listener for early cancellation', async () => {
  const runtime = new AgentRuntime();
  const model = createMockModel(async () => 'Turn handled');
  await runtime.launchAgent({ id: 'timer-agent' }, model);

  // A pre-reset timer proves reset() flushes scheduler state and bus subscriptions.
  const preReset = runtime.schedule({
    agentId: 'timer-agent',
    prompt: 'Pre-reset timer',
    durationSeconds: 60,
    timerCondition: 'any'
  });
  assert.equal(preReset.success, true);
  assert.equal(findSchedule(runtime, preReset.timerId)?.status, 'pending');

  runtime.reset();

  // The pre-reset timer must be gone after reset()...
  assert.equal(findSchedule(runtime, preReset.timerId), null);

  // reset() also wipes MessagingBus registrations, so re-provision the agent
  // before verifying a freshly scheduled timer remains early-cancellable.
  // Wave R (ticket 56ba4b9): the sender must also be a registered agent —
  // both default to the Generic realm — because a realm-bound target no longer
  // accepts an unresolvable/ungrouped sender.
  await runtime.launchAgent({ id: 'timer-agent' }, model);
  await runtime.launchAgent({ id: 'peer-agent' }, model);

  const postReset = runtime.schedule({
    agentId: 'timer-agent',
    prompt: 'Post-reset timer',
    durationSeconds: 60,
    timerCondition: 'any'
  });
  assert.equal(postReset.success, true);
  assert.equal(findSchedule(runtime, postReset.timerId)?.status, 'pending');

  const receipt = runtime.messagingBus.sendMessage({
    from: 'peer-agent',
    to: 'timer-agent',
    content: 'Early completion after reset'
  });
  assert.equal(receipt.success, true);

  const cancelled = findSchedule(runtime, postReset.timerId);
  assert.ok(cancelled, 'listSchedules() must still expose the post-reset timer');
  assert.notEqual(cancelled.status, 'pending');
  assert.notEqual(cancelled.status, 'active');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(listPendingOrActive(runtime).length, 0);

  runtime.destroy();
});

test('2. importSnapshot() re-binds the bus timer listener for early cancellation', async () => {
  const runtime = new AgentRuntime();
  const model = createMockModel(async () => 'Turn handled');
  await runtime.launchAgent({ id: 'timer-agent' }, model);

  const scheduled = runtime.schedule({
    agentId: 'timer-agent',
    prompt: 'Snapshot timer',
    durationSeconds: 60,
    timerCondition: 'any'
  });
  assert.equal(scheduled.success, true);

  const snapshot = runtime.exportSnapshot();
  assert.equal(
    snapshot.scheduledTimers.some((task) => task.timerId === scheduled.timerId),
    true,
    'exportSnapshot() must capture the pending timer'
  );

  // Simulate the persistence restore order: re-hydrating the bus drops all
  // existing subscriptions before the runtime snapshot is imported.
  runtime.messagingBus.importSnapshot({});
  runtime.importSnapshot(snapshot);
  // Wave R (ticket 56ba4b9): re-register the same-realm (Generic) sender the
  // early-cancel send below needs; the restored target is realm-bound.
  await runtime.launchAgent({ id: 'peer-agent' }, model);

  assert.equal(findSchedule(runtime, scheduled.timerId)?.status, 'pending');

  const receipt = runtime.messagingBus.sendMessage({
    from: 'peer-agent',
    to: 'timer-agent',
    content: 'Early completion after restore'
  });
  assert.equal(receipt.success, true);

  const cancelled = findSchedule(runtime, scheduled.timerId);
  assert.ok(cancelled, 'listSchedules() must still expose the restored timer');
  assert.notEqual(cancelled.status, 'pending');
  assert.notEqual(cancelled.status, 'active');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(listPendingOrActive(runtime).length, 0);

  runtime.destroy();
});
