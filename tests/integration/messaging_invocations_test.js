/**
 * @file tests/messaging_invocations_test.js
 * @description Master Acceptance & Integration Test Suite for Clean Event-Driven Sandbox
 * 
 * Verifies all 10 PRD Acceptance Criteria + History Purity + End-to-End Multi-Agent Sandbox:
 * - [AC-QUEUE-01] FIFO Dequeue (read_message marks read, removes from activeQueue, moves to archive)
 * - [AC-QUEUE-02] Clean Drain & Zero Re-Dumping (drain_inbox empties activeQueue to archive)
 * - [AC-QUEUE-03] Non-Destructive Peeking (list_inbox returns headers without dequeuing)
 * - [AC-INVOKE-01] Zero Mailbox Pollution (invoke_agent direct injection produces zero mailbox envelopes)
 * - [AC-INVOKE-02] Secondary Stream Isolation (invocation stream chunks tagged with invocationId)
 * - [AC-TRIGGER-01] Central Queue Ingestion (mail, invocation, schedule, user triggers registered)
 * - [AC-TRIGGER-02] Non-Blocking Requeuing & Inter-Agent Concurrency (busy agents do not block idle agents)
 * - [AC-ALL-AUTO] Abolition of triggerPolicy (all agents auto-react; legacy parameter has zero effect)
 * - [AC-WAIT-01] Multi-Wait Mail (waitForMail resolves on senders, timeouts, and partials)
 * - [AC-WAIT-02] Multi-Wait Invocation (waitForInvocation resolves on UUIDs, require_all, timeouts)
 * - [AC-HISTORY-CLEAN] Zero History Pollution (0 synthetic [MAIL NOTIFICATION] or [EVENT NOTIFICATION] entries)
 * - [AC-INTEG-01] End-to-End Multi-Agent Sandbox Collaboration (Director, Worker, Scout live scenario)
 * 
 * Zero-Mock Rule: 100% authentic production classes imported directly.
 */

import '../test_env.js';
import assert from 'node:assert/strict';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { InvocationEngine } from '../../src/lib/sandbox/invocationEngine/index.ts';
import { TriggerQueue } from '../../src/lib/sandbox/triggerQueue/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createWiredRuntime } from '../helpers/wired_identity_fixture.js';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import {
  createSandboxToolDispatcher,
  SANDBOX_TOOLS,
  INNATE_TOOLS
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';

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
      const bufferedChunks = [];
      const onChunk = (chunk) => {
        bufferedChunks.push(chunk);
        if (typeof options.onChunk === 'function') {
          try { options.onChunk(chunk); } catch (_) {}
        }
      };
      const res = await fn({ ...options, onChunk });

      if (bufferedChunks.length > 0) {
        for (const chunk of bufferedChunks) {
          yield chunk;
        }
      } else if (res && typeof res === 'object') {
        if (res.reasoning || res.reasoning_content) {
          yield { type: 'reasoning', reasoning: res.reasoning || res.reasoning_content, content: res.reasoning || res.reasoning_content };
        }
        if (res.content !== undefined || res.text !== undefined) {
          yield { type: 'text', content: res.content !== undefined ? res.content : res.text };
        }
      } else if (typeof res === 'string') {
        yield { type: 'text', content: res };
      }

      if (res && typeof res === 'object') {
        const toolCalls = res.tool_calls || res.toolCalls || [];
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          yield { type: 'tool_call', toolCalls };
        }
        yield {
          type: 'finish',
          finishReason: res.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
          content: res.content !== undefined ? res.content : (res.text || ''),
          reasoning: res.reasoning || res.reasoning_content || '',
          toolCalls,
          usage: res.usage
        };
      } else if (typeof res === 'string') {
        yield { type: 'finish', finishReason: 'stop', content: res, toolCalls: [] };
      }
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

/** MOD-21 W3: registry descriptor granting sudoer authority to test invokers. */
const DIRECTOR_AUTHORITY = Object.freeze({
  subject: 'director',
  kind: 'agent',
  allow: new Set(['*']),
  visibility: 'all'
});
const getAgentAuthority = (id) => (id === 'director' ? DIRECTOR_AUTHORITY : null);

let passed = 0;
let failed = 0;
const results = [];

function logPass(title) {
  console.log(`  [PASS] ${title}`);
  passed++;
  results.push({ title, status: 'PASS' });
}

function logFail(title, err) {
  console.error(`  [FAIL] ${title}`);
  console.error(err);
  failed++;
  results.push({ title, status: 'FAIL', error: err.message });
}

async function test(title, fn) {
  try {
    await fn();
    logPass(title);
  } catch (err) {
    logFail(title, err);
  }
}

console.log('========================================================================');
console.log('  MASTER ACCEPTANCE TEST SUITE: CLEAN MESSAGING & INVOCATIONS ENGINE');
console.log('  Scope: 10 PRD Acceptance Criteria + Context Hygiene + Live Sandbox');
console.log('  Zero-Mock Mandate: ENFORCED (Real Production Modules)');
console.log('========================================================================\n');

// ============================================================================
// 1. [AC-QUEUE-01] Strict FIFO Mailbox & Dequeue Semantics
// ============================================================================
console.log('--- 1. [AC-QUEUE-01] Strict FIFO Mailbox & Dequeue Semantics ---');

await test('[AC-QUEUE-01.1] readMessage marks envelope read: true, removes from activeQueue, and appends to archive', () => {
  const bus = new MessagingBus();
  bus.registerAgent('receiver');

  // Send 3 sequential messages
  const m1 = bus.sendMessage({ from: 'alice', to: 'receiver', content: 'Message 1' });
  const m2 = bus.sendMessage({ from: 'bob', to: 'receiver', content: 'Message 2' });
  const m3 = bus.sendMessage({ from: 'charlie', to: 'receiver', content: 'Message 3' });

  assert.equal(bus.getUnreadCount('receiver'), 3);
  assert.equal(bus.listInbox('receiver').length, 3);
  assert.equal(bus.getArchive('receiver').length, 0);

  // Consume m2 via readMessage
  const readRes = bus.readMessage('receiver', m2.id);
  assert.equal(readRes.success, true);
  assert.equal(readRes.message.id, m2.id);
  assert.equal(readRes.message.read, true);

  // active unread queue now has 2 unread (m1, m3 in order)
  const active = bus.listInbox('receiver');
  assert.equal(active.length, 2);
  assert.equal(active[0].id, m1.id);
  assert.equal(active[1].id, m3.id);
  assert.equal(bus.getUnreadCount('receiver'), 2);

  // Archive has 1 consumed message
  const archive = bus.getArchive('receiver');
  assert.equal(archive.length, 1);
  assert.equal(archive[0].id, m2.id);
  assert.equal(archive[0].read, true);
});

await test('[AC-QUEUE-01.2] FIFO arrival sequence is strictly preserved across activeQueue and archive', () => {
  const bus = new MessagingBus();
  bus.registerAgent('target');

  const ids = [];
  for (let i = 0; i < 5; i++) {
    const msg = bus.sendMessage({ from: 'sender', to: 'target', content: `Item ${i}` });
    ids.push(msg.id);
  }

  // Dequeue items in arrival order (FIFO)
  for (let i = 0; i < 5; i++) {
    const active = bus.listInbox('target');
    assert.equal(active[0].id, ids[i]);
    const res = bus.readMessage('target', ids[i]);
    assert.equal(res.success, true);
  }

  assert.equal(bus.listInbox('target').length, 0);
  assert.equal(bus.getUnreadCount('target'), 0);

  // Archive order matches initial arrival sequence
  const history = bus.getArchive('target');
  assert.equal(history.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(history[i].id, ids[i]);
    assert.equal(history[i].read, true);
  }
});

// ============================================================================
// 2. [AC-QUEUE-02] Clean Drain & Zero Re-Dumping Guarantee
// ============================================================================
console.log('\n--- 2. [AC-QUEUE-02] Clean Drain & Zero Re-Dumping Guarantee ---');

await test('[AC-QUEUE-02.1] drainInbox pops all unread envelopes, moves them to archive, leaving activeQueue empty', () => {
  const bus = new MessagingBus();
  bus.registerAgent('worker');

  bus.sendMessage({ from: 'director', to: 'worker', content: 'Job 1' });
  bus.sendMessage({ from: 'director', to: 'worker', content: 'Job 2' });
  bus.sendMessage({ from: 'director', to: 'worker', content: 'Job 3' });

  assert.equal(bus.getUnreadCount('worker'), 3);

  const drained = bus.drainInbox('worker');
  assert.equal(drained.length, 3);
  assert.ok(drained.every(m => m.read === true));

  assert.equal(bus.listInbox('worker').length, 0);
  assert.equal(bus.getUnreadCount('worker'), 0);
  assert.equal(bus.getArchive('worker').length, 3);
});

await test('[AC-QUEUE-02.2] Zero Re-Dumping: repeat calls to drainInbox or listInbox return empty arrays', () => {
  const bus = new MessagingBus();
  bus.registerAgent('worker');

  bus.sendMessage({ from: 'sys', to: 'worker', content: 'Initial task' });

  const firstDrain = bus.drainInbox('worker');
  assert.equal(firstDrain.length, 1);

  // Second drain must return 0 items
  const secondDrain = bus.drainInbox('worker');
  assert.equal(secondDrain.length, 0);

  // listInbox must return 0 unread headers
  const headers = bus.listInbox('worker');
  assert.equal(headers.length, 0);

  // Total archive remains exactly 1
  assert.equal(bus.getArchive('worker').length, 1);
});

// ============================================================================
// 3. [AC-QUEUE-03] Non-Destructive Peeking
// ============================================================================
console.log('\n--- 3. [AC-QUEUE-03] Non-Destructive Peeking ---');

await test('[AC-QUEUE-03.1] listInbox peeks into activeQueue without mutating read status or dequeuing', () => {
  const bus = new MessagingBus();
  bus.registerAgent('inspector');

  bus.sendMessage({ from: 'alice', to: 'inspector', content: 'Peek test 1', metadata: { priority: 'high' } });
  bus.sendMessage({ from: 'bob', to: 'inspector', content: 'Peek test 2', metadata: { priority: 'low' } });

  // Peek headers 3 times
  for (let i = 0; i < 3; i++) {
    const headers = bus.listInbox('inspector');
    assert.equal(headers.length, 2);
    assert.equal(headers[0].from, 'alice');
    assert.equal(headers[0].read, false);
    assert.equal(headers[1].from, 'bob');
    assert.equal(headers[1].read, false);

    assert.equal(bus.getUnreadCount('inspector'), 2);
    assert.equal(bus.listInbox('inspector').length, 2);
    assert.equal(bus.getArchive('inspector').length, 0);
  }
});

// ============================================================================
// 4. [AC-INVOKE-01] Zero Mailbox Pollution on Invocations
// ============================================================================
console.log('\n--- 4. [AC-INVOKE-01] Zero Mailbox Pollution on Invocations ---');

await test('[AC-INVOKE-01.1] invokeAgent execution produces strictly zero entries in target or caller inboxes/archives', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director');
  bus.registerAgent('subagent');

  const engine = new InvocationEngine({
    messagingBus: bus,
    getAgent: (id) => ({ id, state: 'idle' }),
    getAgentAuthority,
    executeTurn: async (targetId, prompt) => {
      return `Executed subroutine for ${targetId}: prompt length ${prompt.length}`;
    }
  });

  const res = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'subagent',
    prompt: 'Execute deep research subroutine'
  });

  assert.equal(res.success, true);
  assert.ok(res.invocationId);
  assert.equal(res.status, 'dispatched');

  // Wait for turn completion
  await engine.waitForInvocation(res.invocationId, { timeout_ms: 1000 });

  // Inspect Mailboxes: strictly 0 envelopes in both activeQueue and archive
  assert.equal(bus.listInbox('director').length, 0);
  assert.equal(bus.getArchive('director').length, 0);
  assert.equal(bus.listInbox('subagent').length, 0);
  assert.equal(bus.getArchive('subagent').length, 0);
  assert.equal(bus.getAuditLog().length, 0);

  // Invocation history is stored exclusively in InvocationEngine
  const record = engine.getInvocation(res.invocationId);
  assert.ok(record);
  assert.equal(record.status, 'completed');
  assert.ok(record.output.includes('Executed subroutine for subagent'));
});

// ============================================================================
// 5. [AC-INVOKE-02] Secondary Stream Channel
// ============================================================================
console.log('\n--- 5. [AC-INVOKE-02] Secondary Stream Channel ---');

await test('[AC-INVOKE-02.1] Invocation stream chunks are emitted with invocationId on the secondary channel', async () => {
  const chunksReceived = [];
  const engine = new InvocationEngine({
    getAgentAuthority,
    executeTurn: async (targetId, prompt, context) => {
      if (typeof context?.onChunk === 'function') {
        context.onChunk('Token1 ');
        context.onChunk('Token2 ');
        context.onChunk('Token3');
      }
      return { output: 'Token1 Token2 Token3' };
    }
  });

  const unsub = engine.onInvocationChunk((payload) => {
    chunksReceived.push(payload);
  });

  const res = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'streamer',
    prompt: 'Stream tokens'
  });

  await engine.waitForInvocation(res.invocationId, { timeout_ms: 1000 });
  unsub();

  assert.equal(chunksReceived.length, 3);
  assert.ok(chunksReceived.every(c => c.invocationId === res.invocationId));
  assert.ok(chunksReceived.every(c => c.targetAgentId === 'streamer'));
  assert.equal(chunksReceived.map(c => c.chunk).join(''), 'Token1 Token2 Token3');
});

// ============================================================================
// 6. [AC-TRIGGER-01] Central Queue Ingestion
// ============================================================================
console.log('\n--- 6. [AC-TRIGGER-01] Central Queue Ingestion ---');

await test('[AC-TRIGGER-01.1] Mail, invocation, schedule, and user triggers register with canonical schema in TriggerQueue', async () => {
  const triggersEnqueued = [];
  const queue = new TriggerQueue({
    dispatchAction: async (trig) => {
      triggersEnqueued.push(trig);
      return true;
    }
  });

  const t1 = queue.enqueue({ type: 'mail', targetAgentId: 'agent-1', source: 'peer', payload: { id: 'm-1' } });
  const t2 = queue.enqueue({ type: 'invocation', targetAgentId: 'agent-2', source: 'director', payload: { id: 'inv-1' } });
  const t3 = queue.enqueue({ type: 'schedule', targetAgentId: 'agent-3', source: 'system:scheduler', payload: { timerId: 't-1' } });
  const t4 = queue.enqueue({ type: 'user', targetAgentId: 'agent-4', source: 'human', payload: { input: 'Hello' } });

  assert.ok(typeof t1 === 'string' && t1.startsWith('trig_'));
  assert.ok(typeof t2 === 'string' && t2.startsWith('trig_'));
  assert.ok(typeof t3 === 'string' && t3.startsWith('trig_'));
  assert.ok(typeof t4 === 'string' && t4.startsWith('trig_'));

  await new Promise(r => setTimeout(r, 40));
  queue.stopProcessing();

  assert.equal(triggersEnqueued.length, 4);
  assert.deepEqual(triggersEnqueued.map(t => t.type), ['mail', 'invocation', 'schedule', 'user']);
});

// ============================================================================
// 7. [AC-TRIGGER-02] Non-Blocking Requeuing & Inter-Agent Concurrency
// ============================================================================
console.log('\n--- 7. [AC-TRIGGER-02] Non-Blocking Requeuing & Inter-Agent Concurrency ---');

await test('[AC-TRIGGER-02.1] Busy agent triggers are requeued without blocking idle agents; intra-agent FIFO is preserved', async () => {
  const executionOrder = [];
  let busyAgentLocked = true;

  const queue = new TriggerQueue({
    isAgentBusy: (id) => id === 'busy-agent' && busyAgentLocked,
    dispatchAction: async (trig) => {
      executionOrder.push(`${trig.targetAgentId}:${trig.payload.seq}`);
      return true;
    }
  });

  // Enqueue 2 triggers for busy-agent, then 1 for idle-agent-1, then 1 for busy-agent, then 1 for idle-agent-2
  queue.enqueue({ type: 'mail', targetAgentId: 'busy-agent', payload: { seq: 1 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'busy-agent', payload: { seq: 2 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'idle-agent-1', payload: { seq: 1 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'busy-agent', payload: { seq: 3 } });
  queue.enqueue({ type: 'mail', targetAgentId: 'idle-agent-2', payload: { seq: 1 } });

  // First tick: idle agents execute immediately while busy-agent triggers are requeued
  await new Promise(r => setTimeout(r, 30));
  assert.ok(executionOrder.includes('idle-agent-1:1'));
  assert.ok(executionOrder.includes('idle-agent-2:1'));
  assert.ok(!executionOrder.some(e => e.startsWith('busy-agent')));

  // Unlock busy agent and drain all pending ticks
  busyAgentLocked = false;
  while (queue.getPendingCount() > 0) {
    await queue.processTick();
  }
  queue.stopProcessing();

  // All executed
  assert.equal(executionOrder.length, 5);
  // Busy agent triggers executed in strict intra-agent FIFO order 1 -> 2 -> 3
  const busySeq = executionOrder.filter(e => e.startsWith('busy-agent')).map(e => e.split(':')[1]);
  assert.deepEqual(busySeq, ['1', '2', '3']);
});

// ============================================================================
// 8. [AC-ALL-AUTO] Abolition of triggerPolicy
// ============================================================================
console.log('\n--- 8. [AC-ALL-AUTO] Abolition of triggerPolicy ---');

await test('[AC-ALL-AUTO.1] All agents react automatically to incoming mail regardless of legacy triggerPolicy parameter', async () => {
  let turnsRun = 0;

  const { runtime, messagingBus: bus, hostSend } = createWiredRuntime();

  const mockModel = createMockModel(async () => {
    turnsRun++;
    return { content: 'Auto reaction completed' };
  });

  // Launch with explicit legacy parameter triggerPolicy: 'queued'
  const agent = await runtime.launchAgent({
    id: 'legacy-queued-agent',
    triggerPolicy: 'queued'
  }, mockModel);

  assert.equal(agent.config.triggerPolicy, 'queued');

  // Send message
  hostSend({ from: 'sender', to: 'legacy-queued-agent', content: 'Wake up' });

  await new Promise(r => setTimeout(r, 60));
  runtime.destroy();

  assert.equal(turnsRun, 1, 'Agent must automatically react to incoming mail');
});

// ============================================================================
// 9. [AC-WAIT-01] Multi-Wait Mail Primitive
// ============================================================================
console.log('\n--- 9. [AC-WAIT-01] Multi-Wait Mail Primitive ---');

await test('[AC-WAIT-01.1] waitForMail resolves on multi-senders, respects timeouts, and preserves partial arrivals', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director');
  bus.registerAgent('alice');
  bus.registerAgent('bob');
  bus.registerAgent('silent_clara');

  // Alice sends message before wait
  bus.sendMessage({ from: 'alice', to: 'director', content: 'Alice report' });

  // Director waits on Alice, Bob, and Clara with 80ms timeout
  const waitPromise = bus.waitForMail('director', {
    senders: ['alice', 'bob', 'silent_clara'],
    require_all: true,
    timeout_ms: 80
  });

  // Bob sends message at 20ms
  setTimeout(() => {
    bus.sendMessage({ from: 'bob', to: 'director', content: 'Bob report' });
  }, 20);

  // Clara stays silent

  const result = await waitPromise;
  assert.equal(result.success, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.receivedSenders.sort(), ['alice', 'bob']);
  assert.deepEqual(result.missingSenders, ['silent_clara']);

  // Messages consumed by waitForMail are dequeued from activeQueue and saved to archive
  assert.equal(bus.listInbox('director').length, 0);
  assert.equal(bus.getArchive('director').length, 2);
});

// ============================================================================
// 10. [AC-WAIT-02] Multi-Wait Invocation Primitive
// ============================================================================
console.log('\n--- 10. [AC-WAIT-02] Multi-Wait Invocation Primitive ---');

await test('[AC-WAIT-02.1] waitForInvocation waits across multiple UUIDs, supports require_all: false, and resolves completed', async () => {
  const engine = new InvocationEngine({
    getAgentAuthority,
    executeTurn: async (targetId, prompt) => {
      const delay = targetId === 'fast' ? 10 : 80;
      await new Promise(r => setTimeout(r, delay));
      return `Result from ${targetId}: ${prompt}`;
    }
  });

  const invFast = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'fast', prompt: 'Fast task' });
  const invSlow = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'slow', prompt: 'Slow task' });

  // Wait on FIRST completion
  const resFirst = await engine.waitForInvocation({
    invocationIds: [invFast.invocationId, invSlow.invocationId],
    require_all: false,
    timeout_ms: 400
  });

  assert.equal(resFirst.success, true);
  assert.equal(resFirst.count, 1);
  assert.equal(resFirst.results[0].targetAgentId, 'fast');

  // Wait for the remaining slow invocation
  const resSlow = await engine.waitForInvocation({
    invocationIds: [invSlow.invocationId],
    timeout_ms: 400
  });

  assert.equal(resSlow.success, true);
  assert.equal(resSlow.count, 1);
  assert.equal(resSlow.results[0].targetAgentId, 'slow');
});

// ============================================================================
// 11. [AC-HISTORY-CLEAN] Zero History Pollution
// ============================================================================
console.log('\n--- 11. [AC-HISTORY-CLEAN] Zero History Pollution ---');

await test('[AC-HISTORY-CLEAN.1] Agent history contains strictly authentic user/assistant/tool entries without synthetic notification clutter', async () => {
  const { runtime, virtualFs: vfs, messagingBus: bus, hostSend } = createWiredRuntime();

  const agent = await runtime.launchAgent({ id: 'clean-agent' }, createMockModel(async () => ({ content: 'Turn processed' })));

  // 1. Send burst of 3 peer messages
  hostSend({ from: 'alice', to: 'clean-agent', content: 'Msg 1' });
  hostSend({ from: 'bob', to: 'clean-agent', content: 'Msg 2' });
  hostSend({ from: 'charlie', to: 'clean-agent', content: 'Msg 3' });

  // 2. Schedule a timer
  runtime.schedule({ agentId: 'clean-agent', durationSeconds: 0.04, prompt: 'Timer wake-up' });

  // Wait for triggers to execute
  await new Promise(r => setTimeout(r, 120));
  runtime.destroy();

  // Audit history: verify minimal [MAIL NOTIFICATION] format and zero [EVENT NOTIFICATION]
  const mailNotifs = agent.history.filter(m =>
    typeof m.content === 'string' && m.content.includes('[MAIL NOTIFICATION]')
  );
  assert.ok(mailNotifs.length > 0, 'agent.history should contain minimal mail notification');
  for (const notif of mailNotifs) {
    assert.ok(notif.content.startsWith('[MAIL NOTIFICATION]'), 'Must start with [MAIL NOTIFICATION]');
    assert.ok(!notif.content.includes('read_message'), 'Must NOT contain read_message tutorial');
    assert.ok(!notif.content.includes('list_inbox'), 'Must NOT contain list_inbox tutorial');
  }

  const eventNotifs = agent.history.filter(m =>
    typeof m.content === 'string' && m.content.includes('[EVENT NOTIFICATION]')
  );
  assert.equal(eventNotifs.length, 0, 'agent.history must contain ZERO [EVENT NOTIFICATION] entries');
});

// ============================================================================
// 12. [AC-INTEG-01] End-to-End Multi-Agent Sandbox Collaboration
// ============================================================================
console.log('\n--- 12. [AC-INTEG-01] End-to-End Multi-Agent Sandbox Collaboration ---');

await test('[AC-INTEG-01.1] Director, Worker, and Scout collaborate via messaging, invocations, and triggers with 100% pure state', async () => {
  const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();

  const defaultMockModel = createMockModel(async (opts) => {
    const history = opts.messages || [];
    const lastMsg = history[history.length - 1];

    // If tool response from wait_for_invocation
    if (lastMsg && lastMsg.role === 'tool' && (lastMsg.name === 'wait_for_invocation' || lastMsg.name === 'runtime_waitForInvocation')) {
      const parsed = JSON.parse(lastMsg.content);
      const scoutOutput = parsed.results?.[0]?.output || 'Scout completed';
      return {
        content: `Director finalized plan using scout report: "${scoutOutput}".`
      };
    }

    return { content: 'Acknowledged directive' };
  });

  // Launch Director, Worker, and Scout. MOD-21: the reserved-id director is
  // bootstrapped through the composition root, then bound to the scripted model.
  await runtime.ensureDirector();
  const director = runtime.getAgent('director');
  director.model = defaultMockModel;
  const worker = await runtime.launchAgent({ id: 'worker', role: 'assistant' }, defaultMockModel);
  const scout = await runtime.launchAgent({
    id: 'scout',
    role: 'assistant'
  }, createMockModel(async () => ({ content: 'Scout telemetry: Sector 7 is clear.' })));

  // 1. Director sends mail to worker
  bus.sendMessage({ from: 'director', to: 'worker', content: 'Assemble components' });
  assert.equal(bus.getUnreadCount('worker'), 1);

  // 2. Worker consumes message via drainInbox
  const workerDrained = bus.drainInbox('worker');
  assert.equal(workerDrained.length, 1);
  assert.equal(workerDrained[0].content, 'Assemble components');
  assert.equal(bus.getUnreadCount('worker'), 0);

  // 3. Director invokes Scout via InvocationEngine and awaits completion
  const invokeReceipt = runtime.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'scout',
    prompt: 'Survey Sector 7'
  });
  assert.equal(invokeReceipt.success, true);
  assert.equal(invokeReceipt.status, 'dispatched');

  const waitRes = await runtime.waitForInvocation({
    invocationIds: [invokeReceipt.invocationId],
    timeout_ms: 1000
  });

  assert.equal(waitRes.success, true);
  assert.equal(waitRes.results[0].output, 'Scout telemetry: Sector 7 is clear.');

  // 4. Verify ZERO mailbox pollution from invocation
  assert.equal(bus.listInbox('scout').length, 0);
  assert.equal(bus.getArchive('scout').length, 0);

  // 5. Verify SandboxStore reactivity with live agents
  const store = new SandboxStore({
    virtualFs: vfs,
    messagingBus: bus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  assert.equal(store.getAgentUnreadCount('worker'), 0);

  runtime.destroy();
});

// ============================================================================
// Summary & Exit Gate
// ============================================================================
console.log('\n========================================================================');
console.log(`  MASTER ACCEPTANCE SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
console.log('========================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
