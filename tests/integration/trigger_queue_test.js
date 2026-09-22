/**
 * @file tests/integration/trigger_queue_test.js
 * @description Zero-Mock Unit & Integration Test Suite for Centralized Non-Blocking TriggerQueue.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerQueue, TRIGGER_TYPES } from '../../src/lib/sandbox/triggerQueue/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

test('1. TriggerQueue initializes with options and starts processing', () => {
  const queue = new TriggerQueue({ tickIntervalMs: 20 });
  assert.equal(queue.getPendingCount(), 0);
  assert.equal(queue.isProcessing, true);
  assert.equal(queue.tickIntervalMs, 20);
  queue.stopProcessing();
  assert.equal(queue.isProcessing, false);
});

test('2. enqueue validates arguments and generates valid AgentTrigger schema', () => {
  const queue = new TriggerQueue({ autoStart: false });

  assert.throws(() => queue.enqueue(null), /valid triggerData object/);
  assert.throws(() => queue.enqueue({}), /non-empty string 'targetAgentId'/);
  assert.throws(() => queue.enqueue({ targetAgentId: 'agent-1' }), /Invalid trigger type/);
  assert.throws(() => queue.enqueue({ targetAgentId: 'agent-1', type: 'invalid_type' }), /Invalid trigger type/);

  for (const type of Object.values(TRIGGER_TYPES)) {
    const triggerId = queue.enqueue({
      type,
      targetAgentId: 'agent-alice',
      source: 'test-suite',
      payload: { test: type }
    });

    assert.ok(typeof triggerId === 'string' && triggerId.startsWith('trig_'));
  }

  assert.equal(queue.getPendingCount(), 4);
  assert.equal(queue.getPendingCount('agent-alice'), 4);
  assert.equal(queue.getPendingCount('agent-bob'), 0);

  const triggers = queue.getPendingTriggers();
  assert.equal(triggers.length, 4);
  assert.equal(triggers[0].type, 'mail');
  assert.equal(triggers[1].type, 'invocation');
  assert.equal(triggers[2].type, 'schedule');
  assert.equal(triggers[3].type, 'user');
  assert.equal(triggers[0].targetAgentId, 'agent-alice');
  assert.equal(triggers[0].source, 'test-suite');
  assert.ok(typeof triggers[0].timestamp === 'number');

  queue.clear();
  assert.equal(queue.getPendingCount(), 0);
});

test('3. peek snapshot and clear maintain queue state without side-effects', () => {
  const queue = new TriggerQueue({ autoStart: false });

  assert.deepEqual(queue.getPendingTriggers(), []);
  assert.equal(queue.getPendingCount(), 0);

  const id1 = queue.enqueue({ type: 'mail', targetAgentId: 'agent-1' });
  const id2 = queue.enqueue({ type: 'user', targetAgentId: 'agent-2' });

  assert.equal(queue.getPendingTriggers()[0]?.triggerId, id1);
  assert.equal(queue.getPendingCount(), 2);

  // getPendingTriggers() is a non-destructive frozen snapshot
  const snapshot = queue.getPendingTriggers();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].triggerId, id1);
  assert.equal(snapshot[1].triggerId, id2);
  assert.equal(queue.getPendingCount(), 2);

  queue.clear();
  assert.equal(queue.getPendingCount(), 0);
  assert.deepEqual(queue.getPendingTriggers(), []);
});

test('4. Non-blocking requeue: busy agent triggers do NOT block idle agent triggers', async () => {
  const busyStatus = {
    'agent-busy': true,
    'agent-idle': false
  };

  const dispatched = [];

  const queue = new TriggerQueue({
    autoStart: false,
    isAgentBusy: (id) => Boolean(busyStatus[id]),
    dispatchAction: async (trigger) => {
      dispatched.push(trigger);
      return true;
    }
  });

  queue.enqueue({ type: 'mail', targetAgentId: 'agent-busy', payload: { n: 1 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'agent-idle', payload: { n: 2 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'agent-busy', payload: { n: 3 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'agent-idle', payload: { n: 4 } });

  // Allow initial microtask ticks to run
  await new Promise(r => setTimeout(r, 40));

  assert.ok(dispatched.some(d => d.targetAgentId === 'agent-idle'));
  assert.ok(!dispatched.some(d => d.targetAgentId === 'agent-busy'));
  assert.equal(queue.getPendingCount('agent-busy'), 2);

  // Un-busy agent-busy and drain remaining triggers
  busyStatus['agent-busy'] = false;
  await queue.processTick();
  await queue.processTick();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(dispatched.length, 4);
  assert.equal(queue.getPendingCount(), 0);
});

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
    async *stream(options = {}) {
      const res = await fn(options);
      if (typeof res === 'string') yield { type: 'text', content: res };
      else if (res?.content) yield { type: 'text', content: res.content };
      else if (res?.text) yield { type: 'text', content: res.text };
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

test('5. TriggerQueue integration with AgentRuntime mail arrival', async () => {
  const runtime = new AgentRuntime({
    autoBootstrapDirector: false
  });

  const mockModel = createMockModel(async (opts) => ({ text: 'Turn handled', toolCalls: [] }));

  const agent = await runtime.launchAgent({ id: 'clean-history-agent' }, mockModel);
  await runtime.launchAgent({ id: 'mail-sender' }, mockModel);

  runtime.messagingBus.sendMessage({ from: 'mail-sender', to: 'clean-history-agent', content: 'Message 1' });

  await new Promise(resolve => setTimeout(resolve, 80));

  const singleNotifs = agent.history.filter(m =>
    typeof m.content === 'string' && m.content.includes('[MAIL NOTIFICATION]')
  );
  assert.ok(singleNotifs.length >= 1, 'agent.history must contain minimal [MAIL NOTIFICATION] entry');
  assert.ok(singleNotifs[0].content.includes('mail-sender'));
  assert.ok(!singleNotifs[0].content.includes('read_message'));

  runtime.triggerQueue.stopProcessing();
});
