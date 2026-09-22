import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { formatMessagesWithToolHygiene } from '../../src/lib/sandbox/runtime/messageHygiene/index.ts';
import { createWiredRuntime } from '../helpers/wired_identity_fixture.js';

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
        if (res.usage) {
          yield { type: 'usage', usage: res.usage };
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

// ============================================================================
// SUITE 1: MessagingBus Message Routing Permutations
// ============================================================================
test('Suite 1.1: MessagingBus Routing - Unicast, Self-Messages, Invalid Payloads', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('agent_a', { mode: 'queued' });
  bus.registerAgent('agent_b', { mode: 'auto' });

  // 1. Unicast valid
  const receipt1 = bus.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'Hello B' });
  assert.strictEqual(receipt1.success, true);
  assert.strictEqual(receipt1.to, 'agent_b');
  assert.strictEqual(receipt1.from, 'agent_a');
  assert.strictEqual(bus.getUnreadCount('agent_b'), 1);

  // 2. Unicast to unregistered agent
  const receiptUnregistered = bus.sendMessage({ from: 'agent_a', to: 'agent_nonexistent', content: 'Hello Ghost' });
  assert.strictEqual(receiptUnregistered.success, false);
  assert.strictEqual(receiptUnregistered.code, 'RECIPIENT_NOT_FOUND');

  // 3. Unicast to terminated agent
  bus.markAgentTerminated('agent_b');
  const receiptTerminated = bus.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'Hello Dead B' });
  assert.strictEqual(receiptTerminated.success, false);
  assert.strictEqual(receiptTerminated.code, 'AGENT_TERMINATED');

  // 4. Re-registration cleanses terminated status
  bus.registerAgent('agent_b', { mode: 'queued' });
  assert.strictEqual(bus.isAgentTerminated('agent_b'), false);
  const receiptRevived = bus.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'Hello Revived B' });
  assert.strictEqual(receiptRevived.success, true);

  // 5. Self-message unicast (agent_a to agent_a)
  const selfReceipt = bus.sendMessage({ from: 'agent_a', to: 'agent_a', content: 'Note to self' });
  assert.strictEqual(selfReceipt.success, true);
  assert.strictEqual(bus.getUnreadCount('agent_a'), 1);
  assert.strictEqual(bus.listInbox('agent_a')[0].preview, 'Note to self');

  // 6. Invalid payloads fail closed with INVALID_ARGUMENTS
  assert.strictEqual(bus.sendMessage({ from: null, to: 'agent_a', content: 'x' }).code, 'INVALID_ARGUMENTS');
  assert.strictEqual(bus.sendMessage({ from: 'agent_a', to: null, content: 'x' }).code, 'INVALID_ARGUMENTS');
  assert.strictEqual(bus.sendMessage({ from: 'agent_a', to: 'agent_b', content: null }).code, 'INVALID_ARGUMENTS');
  assert.strictEqual(bus.sendMessage({ from: 'agent_a', to: 'agent_b', content: undefined }).code, 'INVALID_ARGUMENTS');

  // 7. Non-registered sender (from is not registered)
  const unregSenderReceipt = bus.sendMessage({ from: 'ghost_sender', to: 'agent_a', content: 'Spoofed from' });
  assert.strictEqual(unregSenderReceipt.success, true);
});

test('Suite 1.2: MessagingBus Routing - Broadcast Permutations', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice', { mode: 'queued' });
  bus.registerAgent('bob', { mode: 'auto' });
  bus.registerAgent('charlie', { mode: 'queued' });

  // 1. Broadcast excludes sender
  const bcast = bus.sendMessage({ from: 'alice', to: 'all', content: 'Announcement' });
  assert.strictEqual(bcast.success, true);
  assert.strictEqual(bcast.broadcast, true);
  assert.deepStrictEqual(bcast.recipients.sort(), ['bob', 'charlie'].sort());
  assert.strictEqual(bus.getUnreadCount('alice'), 0); // Sender did not receive own broadcast
  assert.strictEqual(bus.getUnreadCount('bob'), 1);
  assert.strictEqual(bus.getUnreadCount('charlie'), 1);

  // 2. Broadcast when no other agents registered
  const isolatedBus = new MessagingBus();
  isolatedBus.registerAgent('lonely', { mode: 'queued' });
  const lonelyBcast = isolatedBus.sendMessage({ from: 'lonely', to: 'all', content: 'Echo...' });
  assert.strictEqual(lonelyBcast.success, true);
  assert.deepStrictEqual(lonelyBcast.recipients, []);
});

test('Suite 1.3: MessagingBus Subscriptions - Queued Mode vs Auto Mode Discrepancy', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('queued_agent', { mode: 'queued' });
  bus.registerAgent('auto_agent', { mode: 'auto' });

  const receivedQueued = [];
  const receivedAuto = [];
  const receivedWildcard = [];

  bus.subscribe('queued_agent', (msg) => receivedQueued.push(msg));
  bus.subscribe('auto_agent', (msg) => receivedAuto.push(msg));
  bus.subscribe('all', (msg) => receivedWildcard.push(msg));

  bus.sendMessage({ from: 'sender', to: 'queued_agent', content: 'Msg to Queued' });
  bus.sendMessage({ from: 'sender', to: 'auto_agent', content: 'Msg to Auto' });

  // Wildcard receives both
  assert.strictEqual(receivedWildcard.length, 2);

  // Auto agent subscriber receives direct message
  assert.strictEqual(receivedAuto.length, 1);

  // Direct subscriber to queued_agent receives direct message
  assert.strictEqual(receivedQueued.length, 1, 'Direct subscriber for queued agent is correctly notified');
});

// ============================================================================
// SUITE 2: MessagingBus waitForMail Permutations & Bugs
// ============================================================================
test('Suite 2.1: waitForMail - Async Arrival deliveredByWaitForMail Bug', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director', { mode: 'queued' });
  bus.registerAgent('worker', { mode: 'queued' });

  // First wait: message arrives ASYNCHRONOUSLY
  const wait1Promise = bus.waitForMail('director', { senders: ['worker'], timeout_ms: 500 });
  setTimeout(() => {
    bus.sendMessage({ from: 'worker', to: 'director', content: 'Task 1 done' });
  }, 20);
  const res1 = await wait1Promise;
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.messages.length, 1);

  // Check inbox in bus
  const inboxMsg = bus.getArchive('director')[0];
  assert.strictEqual(inboxMsg.read, true); // Marked as read

  // Second wait: Director calls waitForMail AGAIN expecting a NEW task from worker!
  // Since Task 1 was already delivered in wait1, wait2 should NOT deliver Task 1!
  // It should timeout waiting for a new message!
  const res2 = await bus.waitForMail('director', { senders: ['worker'], timeout_ms: 100 });

  assert.strictEqual(
    res2.messages.length,
    0,
    'FIX VERIFIED: waitForMail does not re-deliver already delivered message'
  );
  assert.strictEqual(res2.timedOut, true);
});

test('Suite 2.2: waitForMail - Drained Inbox Resurrected from AuditLog Bug', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director', { mode: 'queued' });
  bus.registerAgent('worker', { mode: 'queued' });

  // Worker sends message
  bus.sendMessage({ from: 'worker', to: 'director', content: 'Old secret report' });

  // Director drains inbox completely
  const drained = bus.drainInbox('director');
  assert.strictEqual(drained.length, 1);
  assert.strictEqual(bus.getUnreadCount('director'), 0);

  // Now Director calls waitForMail with senders: ['worker'] waiting for a NEW report
  const waitResult = await bus.waitForMail('director', {
    senders: ['worker'],
    timeout_ms: 100
  });

  assert.strictEqual(
    waitResult.messages.length,
    0,
    'FIX VERIFIED: waitForMail does not resurrect old messages from auditLog after drainInbox'
  );
  assert.strictEqual(waitResult.timedOut, true);
});

test('Suite 2.3: waitForMail - Listener Cleanup & Memory Leak Check on Timeout & Abort', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director', { mode: 'queued' });
  bus.registerAgent('sender', { mode: 'queued' });

  // Run 10 timed-out waits sequentially
  for (let i = 0; i < 10; i++) {
    await bus.waitForMail('director', { senders: ['silent_agent'], timeout_ms: 10 });
  }

  // A stale listener from a timed-out wait would silently consume later mail.
  bus.sendMessage({ from: 'sender', to: 'director', content: 'Post-timeout mail' });
  assert.strictEqual(bus.getUnreadCount('director'), 1, 'Timed-out waits must not consume later mail');
  const postTimeoutWait = await bus.waitForMail('director', { senders: ['sender'], timeout_ms: 100 });
  assert.strictEqual(postTimeoutWait.count, 1, 'Later mail is delivered exactly once to a fresh wait');

  // Run 10 aborted waits
  for (let i = 0; i < 10; i++) {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await bus.waitForMail('director', { senders: ['silent_agent'], timeout_ms: 1000, signal: ac.signal });
  }

  bus.sendMessage({ from: 'sender', to: 'director', content: 'Post-abort mail' });
  assert.strictEqual(bus.getUnreadCount('director'), 1, 'Aborted waits must not consume later mail');
  const postAbortWait = await bus.waitForMail('director', { senders: ['sender'], timeout_ms: 100 });
  assert.strictEqual(postAbortWait.count, 1, 'Later mail is delivered exactly once after aborts');
});

// ============================================================================
// SUITE 3: AgentRuntime Concurrency, Turn Queuing & Reactive Wakeup
// ============================================================================
test('Suite 3.1: Auto-trigger Redundant Turn Execution during waitForMail Bug', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  let turnExecutionCount = 0;
  let subTurnCount = 0;

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  // Launch Alice with triggerPolicy: 'auto'
  await runtime.launchAgent({
    id: 'alice',
    name: 'Alice',
    triggerPolicy: 'auto',
    allowedTools: ['runtime_waitForMail']
  }, createMockModel(async (opts) => {
    subTurnCount++;
    const lastMsg = opts.messages[opts.messages.length - 1];

    // If responding to tool result from waitForMail
    if (lastMsg.role === 'tool' && lastMsg.name === 'runtime_waitForMail') {
      return {
        content: 'I received the mail in waitForMail and processed it.'
      };
    }

    // Initial sub-turn: Alice calls waitForMail to wait for Bob
    if (subTurnCount === 1) {
      return {
        content: 'Calling waitForMail to wait for Bob...',
        tool_calls: [{
          id: 'call_wait_bob',
          type: 'function',
          function: {
            name: 'runtime_waitForMail',
            arguments: JSON.stringify({ senders: ['bob'], timeout_ms: 2000 })
          }
        }]
      };
    }

    // If a second turn is executed unexpectedly
    return {
      content: `Unexpected turn execution #${turnExecutionCount}`
    };
  }));

  // Launch Bob
  await runtime.launchAgent({
    id: 'bob',
    name: 'Bob',
    triggerPolicy: 'queued'
  });

  // Subscribe to turn_start events to count how many turns Alice actually starts
  const startedTurns = [];
  runtime.on('turn_start', (ev) => {
    if (ev.agentId === 'alice') {
      startedTurns.push(ev);
    }
  });

  // Start Alice's first turn
  const aliceTurnPromise = runtime.executeAgentTurn('alice', 'Start waiting for Bob');

  // Bob sends message to Alice while Alice is blocked in waitForMail
  setTimeout(() => {
    bus.sendMessage({
      from: 'bob',
      to: 'alice',
      content: 'Hello Alice, here is your answer.'
    });
  }, 50);

  await aliceTurnPromise;

  // Wait a moment for any queued microtasks / chained turns to fire
  await new Promise(r => setTimeout(r, 100));

  // VERIFICATION: the auto-subscription must not trigger a redundant turn.
  // turn_start is the authoritative per-turn public signal.
  assert.strictEqual(
    startedTurns.length,
    1,
    'FIX VERIFIED: Alice started exactly 1 turn; the auto-subscription did not run a redundant turn after waitForMail completed.'
  );
});

test('Suite 3.2: Message Arrival During Turn Execution - In-Flight Turn Queuing', async () => {
  const { runtime, virtualFs: vfs, messagingBus: bus, hostSend } = createWiredRuntime();

  let turnCount = 0;

  await runtime.launchAgent({
    id: 'worker',
    triggerPolicy: 'auto'
  }, createMockModel(async (opts) => {
    turnCount++;
    // Simulate 50ms LLM processing time
    await new Promise(r => setTimeout(r, 50));
    return { content: `Response to turn ${turnCount}` };
  }));

  // Turn 1 starts
  const p1 = runtime.executeAgentTurn('worker', 'Prompt 1');

  // While Turn 1 is executing, message arrives from MessagingBus
  setTimeout(() => {
    hostSend({ from: 'boss', to: 'worker', content: 'Urgent message while running' });
  }, 10);

  await p1;
  // Give time for queued turn to complete
  await new Promise(r => setTimeout(r, 100));

  assert.strictEqual(turnCount, 2, 'Message arriving during turn correctly queued Turn 2');
});

test('Suite 3.3: Cancellation While Blocked in waitForMail - Zombie Turn Execution Bug', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  let zombieTurnContinued = false;

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  await runtime.launchAgent({
    id: 'sleeper',
    name: 'Sleeper',
    triggerPolicy: 'queued',
    allowedTools: ['runtime_waitForMail']
  }, createMockModel(async (opts) => {
    const lastMsg = opts.messages[opts.messages.length - 1];
    if (lastMsg.role === 'tool') {
      zombieTurnContinued = true;
      return { content: 'Zombie response continued after waitForMail!' };
    }

    return {
      content: 'Sleeping in waitForMail for 1000ms',
      tool_calls: [{
        id: 'call_sleep',
        type: 'function',
        function: {
          name: 'runtime_waitForMail',
          arguments: JSON.stringify({ senders: ['nobody'], timeout_ms: 1000 })
        }
      }]
    };
  }));

  // Start turn
  const turnPromise = runtime.executeAgentTurn('sleeper', 'Go to sleep');

  // Wait 50ms, then call unstickAgent / cancelAgent
  await new Promise(r => setTimeout(r, 50));
  // Self principal: the active agent's own registry descriptor authorizes the
  // unstick under MOD-21 W8 default-deny (the production store forwards its
  // lifecycle authority context for operator-initiated unsticks).
  const unstickRes = runtime.unstickAgent('sleeper', 'User unstuck sleeper', { callerAgentId: 'sleeper' });
  assert.strictEqual(unstickRes.success, true);
  assert.strictEqual(runtime.getAgent('sleeper').state, AGENT_STATES.IDLE);

  // Wait 1200ms for the un-cancelled waitForMail timer inside tool dispatcher to fire
  await new Promise(r => setTimeout(r, 1100));

  assert.strictEqual(
    zombieTurnContinued,
    false,
    'FIX VERIFIED: Cancelling or unsticking an agent blocked in waitForMail aborts waitForMail and prevents zombie turn execution'
  );
});

// ============================================================================
// SUITE 4: SandboxStore Synchronization & Duplicate Prose Flash Race Condition
// ============================================================================
test('Suite 4.1: SandboxStore - Duplicate Prose / Stream Bubble Race at turn_complete', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  let stateAtTurnComplete = null;

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  const store = new SandboxStore({
    virtualFs: vfs,
    messagingBus: bus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  await store.launchAgent({
    id: 'writer',
    name: 'Writer',
    triggerPolicy: 'queued'
  }, createMockModel(async (opts) => {
    // Simulate streaming chunks
    opts.onChunk({ text: 'Hello ', visibleProse: 'Hello ' });
    opts.onChunk({ text: 'world!', visibleProse: 'Hello world!' });
    return { content: 'Hello world!' };
  }));

  store.selectAgent('writer');

  // Intercept runtime turn_complete event to check store state at the exact moment turn_complete is emitted
  runtime.on('turn_complete', (ev) => {
    if (ev.agentId === 'writer') {
      stateAtTurnComplete = {
        historyLength: store.selectedAgent.history.length,
        lastHistoryContent: store.selectedAgent.history[store.selectedAgent.history.length - 1]?.content,
        streamingProse: store.streamingProse,
        isAgentStreaming: store.isAgentStreaming,
        agentState: store.selectedAgent.state
      };
    }
  });

  await store.submitChatTurn('Write a greeting');

  // VERIFICATION: At turn_complete, the message is in history AND streamingProse is pre-cleared AND isAgentStreaming is false!
  assert.strictEqual(stateAtTurnComplete.lastHistoryContent, 'Hello world!');
  assert.strictEqual(stateAtTurnComplete.streamingProse, '', 'FIX VERIFIED: streamingProse pre-cleared before turn_complete');
  assert.strictEqual(stateAtTurnComplete.isAgentStreaming, false, 'FIX VERIFIED: isAgentStreaming is false at turn_complete');
});

// ============================================================================
// SUITE 5: runtime/messageHygiene Tool Hygiene & Reasoning Content Hygiene
// ============================================================================
test('Suite 5.1: formatMessagesWithToolHygiene - Cascading Pruning & Reasoning Eviction', () => {
  // Scenario 1: Multi-turn tool sequence with reasoning content
  const messages = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Turn 1: List files' },
    {
      role: 'assistant',
      content: 'Listing files...',
      reasoning_content: 'Let me think about how to list files...',
      tool_calls: [{ id: 'call_1', function: { name: 'list_files', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', content: '["a.txt"]' },
    {
      role: 'assistant',
      content: 'Files listed.',
      reasoning_content: 'Turn 1 finished.'
    },
    // Turn 2 starts
    { role: 'user', content: 'Turn 2: Read a.txt' },
    {
      role: 'assistant',
      content: 'Reading a.txt...',
      reasoning_content: 'I need to call read_file now...',
      tool_calls: [{ id: 'call_2', function: { name: 'read_file', arguments: '{"filePath": "a.txt"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_2', content: 'File content' }
  ];

  const formatted = formatMessagesWithToolHygiene(messages, { evictCompletedReasoning: true });

  // Verify Turn 1 assistant messages had their reasoning_content evicted (set to empty string)
  // because a subsequent user message exists (Turn 2)
  const ast1 = formatted.find(m => m.role === 'assistant' && m.content === 'Listing files...');
  assert.strictEqual(ast1.reasoning_content, '', 'Completed turn reasoning evicted');

  const ast2 = formatted.find(m => m.role === 'assistant' && m.content === 'Files listed.');
  assert.strictEqual(ast2.reasoning_content, '', 'Completed turn assistant reasoning evicted');

  // Verify Turn 2 assistant message PRESERVES its reasoning_content because Turn 2 is the current turn!
  const ast3 = formatted.find(m => m.role === 'assistant' && m.content === 'Reading a.txt...');
  assert.strictEqual(ast3.reasoning_content, 'I need to call read_file now...', 'Current turn reasoning preserved');
});

// ============================================================================
// SUITE 1 (Cont.): High Concurrency & Load on MessagingBus
// ============================================================================
test('Suite 1.4: MessagingBus Under Load - Concurrent 100 Messages Routing', async () => {
  const bus = new MessagingBus();
  const numAgents = 5;
  const numMessages = 100;

  for (let i = 0; i < numAgents; i++) {
    bus.registerAgent(`agent_${i}`, { mode: 'queued' });
  }

  // Concurrently dispatch 100 messages randomly across agents
  const promises = [];
  for (let m = 0; m < numMessages; m++) {
    const fromIdx = m % numAgents;
    const toIdx = (m + 1) % numAgents;
    promises.push(Promise.resolve().then(() => {
      return bus.sendMessage({
        from: `agent_${fromIdx}`,
        to: `agent_${toIdx}`,
        content: `Payload ${m}`
      });
    }));
  }

  const receipts = await Promise.all(promises);
  assert.strictEqual(receipts.length, numMessages);
  assert.ok(receipts.every(r => r.success === true));
  assert.strictEqual(bus.getAuditLog().length, numMessages);

  // Verify total messages across all inboxes equals 100
  let totalInboxes = 0;
  for (let i = 0; i < numAgents; i++) {
    totalInboxes += bus.getUnreadCount(`agent_${i}`);
  }
  assert.strictEqual(totalInboxes, numMessages);
});

// ============================================================================
// SUITE 2 (Cont.): waitForMail Multiple Messages & Senders Permutations
// ============================================================================
test('Suite 2.4: waitForMail - Multiple Messages from Same Sender & Unexpected Senders', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director', { mode: 'queued' });
  bus.registerAgent('expected_sender', { mode: 'queued' });
  bus.registerAgent('unexpected_sender', { mode: 'queued' });

  const waitPromise = bus.waitForMail('director', {
    senders: ['expected_sender'],
    timeout_ms: 300
  });

  // Unexpected sender sends a message
  bus.sendMessage({ from: 'unexpected_sender', to: 'director', content: 'Noise message' });

  // Expected sender sends 3 messages
  bus.sendMessage({ from: 'expected_sender', to: 'director', content: 'Expected 1' });
  bus.sendMessage({ from: 'expected_sender', to: 'director', content: 'Expected 2' });
  bus.sendMessage({ from: 'expected_sender', to: 'director', content: 'Expected 3' });

  const result = await waitPromise;
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.timedOut, false);
  // waitForMail satisfied on FIRST message from expected_sender and unsubscribed immediately!
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].content, 'Expected 1');

  // The unexpected message ('Noise message') PLUS subsequent messages ('Expected 2', 'Expected 3') remain unread in Director's inbox
  const unread = bus.listInbox('director', { unreadOnly: true });
  assert.strictEqual(unread.length, 3, '1 noise message + 2 subsequent expected messages arrived after waitForMail finished');
  assert.ok(unread.some(m => m.from === 'unexpected_sender'));
  assert.ok(unread.some(m => m.preview === 'Expected 2'));
  assert.ok(unread.some(m => m.preview === 'Expected 3'));
});

test('Suite 2.5: waitForMail - require_all: false resolves on FIRST sender', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director', { mode: 'queued' });
  bus.registerAgent('sender_fast', { mode: 'queued' });
  bus.registerAgent('sender_slow', { mode: 'queued' });

  const waitPromise = bus.waitForMail('director', {
    senders: ['sender_fast', 'sender_slow'],
    require_all: false,
    timeout_ms: 1000
  });

  setTimeout(() => {
    bus.sendMessage({ from: 'sender_fast', to: 'director', content: 'Fast response' });
  }, 20);

  setTimeout(() => {
    bus.sendMessage({ from: 'sender_slow', to: 'director', content: 'Slow response' });
  }, 150);

  const result = await waitPromise;
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].from, 'sender_fast');
  assert.deepStrictEqual(result.receivedSenders, ['sender_fast']);
});

// ============================================================================
// SUITE 3 (Cont.): Multi-Turn Tool Loop & Event Lifecycle Sequence Trace
// ============================================================================
test('Suite 3.4: Multi-Turn Tool Loop - Stream Buffer Isolation & Event Sequence', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  const emittedEvents = [];
  let subTurnIteration = 0;

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  runtime.subscribe((ev) => {
    emittedEvents.push({ type: ev.type, agentId: ev.agentId, payload: ev.payload });
  });

  // Agent executes a 2-step tool loop
  await runtime.launchAgent({
    id: 'looper',
    triggerPolicy: 'queued',
    allowedTools: ['read_file', 'write_file']
  }, createMockModel(async (opts) => {
    subTurnIteration++;

    if (subTurnIteration === 1) {
      // Sub-turn 1: emits thought, stream chunk, and tool call
      opts.onChunk({ text: 'Thinking about step 1. ', reasoning: 'Reasoning step 1. ' });
      return {
        content: 'Step 1: Writing file',
        reasoning_content: 'Reasoning step 1.',
        tool_calls: [{
          id: 'call_write',
          type: 'function',
          function: {
            name: 'virtualFs_writeFile',
            arguments: JSON.stringify({ filePath: '/test.txt', content: 'Hello' })
          }
        }]
      };
    }

    // Sub-turn 2: Final response
    opts.onChunk({ text: 'Step 2: Done with file write.', reasoning: 'Reasoning step 2.' });
    return {
      content: 'Step 2: Done with file write.',
      reasoning_content: 'Reasoning step 2.'
    };
  }));

  const turnResult = await runtime.executeAgentTurn('looper', 'Run multi-turn process');
  assert.strictEqual(turnResult.output, 'Step 2: Done with file write.');

  // Trace the exact event types emitted during the turn
  const eventTypes = emittedEvents.map(e => e.type);
  console.log('Empirical Check: Full sequence of emitted event types:\n', eventTypes);

  // Assert expected sequence
  assert.ok(eventTypes.includes('state_change'));
  assert.ok(eventTypes.includes('stream'));
  assert.ok(eventTypes.includes('tool_start'));
  assert.ok(eventTypes.includes('tool_end'));
  assert.ok(eventTypes.includes('turn_complete'));

  // Verify turn_start lifecycle event:
  assert.strictEqual(eventTypes.includes('turn_start'), true, 'FIX VERIFIED: turn_start is emitted by AgentRuntime');
  assert.strictEqual(eventTypes.includes('stream_start'), false, 'ANOMALY CONFIRMED: stream_start is NOT emitted by AgentRuntime');
  assert.strictEqual(eventTypes.includes('stream_delta'), false, 'ANOMALY CONFIRMED: event type is "stream", not "stream_delta"');
  assert.strictEqual(eventTypes.includes('tool_result'), false, 'ANOMALY CONFIRMED: tool result is wrapped in "tool_end", not "tool_result"');
});

// ============================================================================
// SUITE 4 (Cont.): SandboxStore Unread Badges Consistency
// ============================================================================
test('Suite 4.2: SandboxStore - Unread Badge Count Accuracy on Drain & Bulk Messages', async () => {
  const { runtime, virtualFs: vfs, messagingBus: bus, hostSend } = createWiredRuntime();

  const store = new SandboxStore({
    runtime,
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  await store.launchAgent({ id: 'receiver', name: 'Receiver', triggerPolicy: 'queued' });
  await store.launchAgent({ id: 'sender', name: 'Sender', triggerPolicy: 'queued' });

  assert.strictEqual(store.getAgentUnreadCount('receiver'), 0);

  // Send 5 messages to receiver
  for (let i = 0; i < 5; i++) {
    hostSend({ from: 'sender', to: 'receiver', content: `Message ${i}` });
  }

  // Check store unread count
  assert.strictEqual(store.getAgentUnreadCount('receiver'), 5);

  // Read 1 message
  const inbox = bus.listInbox('receiver');
  store.readAgentMessage('receiver', inbox[0].id, true);
  assert.strictEqual(store.getAgentUnreadCount('receiver'), 4);

  // Drain remaining messages
  const drained = store.drainAgentInbox('receiver');
  assert.strictEqual(drained.length, 4);
  assert.strictEqual(store.getAgentUnreadCount('receiver'), 0);
});
