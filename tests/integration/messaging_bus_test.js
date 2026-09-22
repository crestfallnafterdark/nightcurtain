/**
 * @file tests/messaging_bus_test.js
 * @description Zero-Mock Unit & Contract Test Suite for Epic 01: Pure FIFO MessagingBus & Mailbox Store.
 * Verifies all ICD acceptance criteria:
 *   [AC-QUEUE-01] Dequeue on Read
 *   [AC-QUEUE-02] Clean Drain
 *   [AC-QUEUE-03] Peeking
 *   [AC-WAIT-01] FIFO Wait
 *   [AC-SNAPSHOT] Persistence Roundtrip & Legacy Invariant Compatibility
 *   [AC-TESTS-01] 100% Suite Execution
 */

import assert from 'node:assert/strict';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

console.log('===============================================================');
console.log('  EPIC 01: PURE FIFO MESSAGING BUS & MAILBOX STORE TEST SUITE  ');
console.log('===============================================================\n');

// ----------------------------------------------------------------------------
// [AC-QUEUE-01] Dequeue on Read
// ----------------------------------------------------------------------------
console.log('--- 1. [AC-QUEUE-01] Dequeue on Read ---');

await test('[AC-QUEUE-01.1] readMessage dequeues envelope from activeQueue and persists to archive', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  const m1 = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Message 1' });
  const m2 = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Message 2' });

  assert.equal(bus.getUnreadCount('bob'), 2);
  assert.equal(bus.listInbox('bob').length, 2);
  assert.equal(bus.getArchive('bob').length, 0);

  // Read m1 with markAsRead: true (default)
  const res = bus.readMessage('bob', m1.messageId);
  assert.equal(res.success, true);
  assert.equal(res.message.id, m1.id);
  assert.equal(res.message.content, 'Message 1');
  assert.equal(res.message.read, true);

  // activeQueue must now contain ONLY m2
  assert.equal(bus.getUnreadCount('bob'), 1);
  const remaining = bus.listInbox('bob');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, m2.id);

  // archive must contain m1 marked as read
  const archived = bus.getArchive('bob');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, m1.id);
  assert.equal(archived[0].read, true);
});

await test('[AC-QUEUE-01.2] Subsequent read of an already-dequeued message returns from archive with status: archived', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  const m1 = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Burn after reading' });
  const res1 = bus.readMessage('bob', m1.messageId);
  assert.equal(res1.success, true);
  assert.equal(res1.status, 'inbox');
  assert.equal(bus.getUnreadCount('bob'), 0);

  // Subsequent read returns message from archive without re-enqueueing to activeQueue
  const res2 = bus.readMessage('bob', m1.messageId);
  assert.equal(res2.success, true);
  assert.equal(res2.status, 'archived');
  assert.equal(res2.message.content, 'Burn after reading');
  assert.equal(bus.getUnreadCount('bob'), 0);
});

await test('[AC-QUEUE-01.3] readMessage with markAsRead: false peeks content without dequeuing', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  const m1 = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Top secret preview' });
  assert.equal(bus.getUnreadCount('bob'), 1);

  // Peek with markAsRead: false
  const res = bus.readMessage('bob', m1.messageId, { markAsRead: false });
  assert.equal(res.success, true);
  assert.equal(res.message.content, 'Top secret preview');
  assert.equal(res.message.read, false);

  // activeQueue remains intact and unread
  assert.equal(bus.getUnreadCount('bob'), 1);
  const peeked = bus.listInbox('bob');
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0].read, false);
  assert.equal(bus.getArchive('bob').length, 0);
});

await test('[AC-QUEUE-01.4] readMessage validation on missing arguments or nonexistent message', () => {
  const bus = new MessagingBus();
  bus.registerAgent('bob');

  const resNullAgent = bus.readMessage(null, 'id_123');
  assert.equal(resNullAgent.success, false);
  assert.equal(resNullAgent.code, 'INVALID_ARGUMENTS');

  const resNullId = bus.readMessage('bob', null);
  assert.equal(resNullId.success, false);
  assert.equal(resNullId.code, 'INVALID_ARGUMENTS');

  const resMissing = bus.readMessage('bob', 'nonexistent_id');
  assert.equal(resMissing.success, false);
  assert.equal(resMissing.code, 'MESSAGE_NOT_FOUND');
});

// ----------------------------------------------------------------------------
// [AC-QUEUE-02] Clean Drain
// ----------------------------------------------------------------------------
console.log('\n--- 2. [AC-QUEUE-02] Clean Drain ---');

await test('[AC-QUEUE-02.1] drainInbox dequeues all active envelopes, marks read: true, and persists to archive', () => {
  const bus = new MessagingBus();
  bus.registerAgent('dispatcher');
  bus.registerAgent('worker');

  bus.sendMessage({ from: 'dispatcher', to: 'worker', content: 'Task 1' });
  bus.sendMessage({ from: 'dispatcher', to: 'worker', content: 'Task 2' });
  bus.sendMessage({ from: 'dispatcher', to: 'worker', content: 'Task 3' });

  assert.equal(bus.getUnreadCount('worker'), 3);

  const drained = bus.drainInbox('worker');
  assert.equal(drained.length, 3);
  assert.equal(drained[0].content, 'Task 1');
  assert.equal(drained[1].content, 'Task 2');
  assert.equal(drained[2].content, 'Task 3');
  assert.ok(drained.every(m => m.read === true));

  // activeQueue must be completely empty
  assert.equal(bus.getUnreadCount('worker'), 0);
  assert.equal(bus.listInbox('worker').length, 0);

  // archive must contain all 3 messages
  assert.equal(bus.getArchive('worker').length, 3);
});

await test('[AC-QUEUE-02.2] Zero Re-Dumping: subsequent drainInbox or listInbox returns zero items', () => {
  const bus = new MessagingBus();
  bus.registerAgent('dispatcher');
  bus.registerAgent('worker');

  bus.sendMessage({ from: 'dispatcher', to: 'worker', content: 'Task Alpha' });
  const drained1 = bus.drainInbox('worker');
  assert.equal(drained1.length, 1);

  // Second drain must yield 0 items
  const drained2 = bus.drainInbox('worker');
  assert.equal(drained2.length, 0);

  // Inspection must yield 0 items
  const headers = bus.listInbox('worker');
  assert.equal(headers.length, 0);
  assert.equal(bus.getUnreadCount('worker'), 0);
});

await test('[AC-QUEUE-02.3] listInbox peeks without draining, drainInbox empties the activeQueue', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  bus.sendMessage({ from: 'alice', to: 'bob', content: 'Item 1' });
  bus.sendMessage({ from: 'alice', to: 'bob', content: 'Item 2' });

  // Non-destructive view of activeQueue
  const peek = bus.listInbox('bob');
  assert.equal(peek.length, 2);
  assert.equal(bus.getUnreadCount('bob'), 2);

  // drainInbox drains activeQueue
  const drained = bus.drainInbox('bob');
  assert.equal(drained.length, 2);
  assert.equal(bus.getUnreadCount('bob'), 0);
  assert.equal(bus.listInbox('bob').length, 0);
});

// ----------------------------------------------------------------------------
// [AC-QUEUE-03] Peeking
// ----------------------------------------------------------------------------
console.log('\n--- 3. [AC-QUEUE-03] Peeking ---');

await test('[AC-QUEUE-03.1] listInbox peeks without mutating activeQueue or unread status', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  bus.sendMessage({ from: 'alice', to: 'bob', content: 'Hello there' });
  bus.sendMessage({
    from: 'alice',
    to: 'bob',
    content: 'A'.repeat(120), // Long string to test 80-char truncation
    metadata: { tag: 'urgent' }
  });

  const headers = bus.listInbox('bob');
  assert.equal(headers.length, 2);

  // Verify header contract
  assert.equal(headers[0].from, 'alice');
  assert.equal(headers[0].replyTo, 'alice');
  assert.equal(headers[0].read, false);
  assert.equal(headers[0].preview, 'Hello there');

  // Preview truncation
  assert.equal(headers[1].preview.length, 83); // 80 chars + '...'
  assert.ok(headers[1].preview.endsWith('...'));
  assert.equal(headers[1].metadata.tag, 'urgent');

  // Verify bus state was strictly unmutated
  assert.equal(bus.getUnreadCount('bob'), 2);
  const inbox = bus.listInbox('bob');
  assert.equal(inbox.length, 2);
  assert.equal(bus.getArchive('bob').length, 0);
  assert.equal(inbox[0].read, false);
  assert.equal(inbox[1].read, false);
});

await test('[AC-QUEUE-03.2] listInbox filtering options: sender and limit', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');
  bus.registerAgent('charlie');

  bus.sendMessage({ from: 'alice', to: 'charlie', content: 'Alice 1' });
  bus.sendMessage({ from: 'bob', to: 'charlie', content: 'Bob 1' });
  bus.sendMessage({ from: 'alice', to: 'charlie', content: 'Alice 2' });

  // Filter by sender
  const aliceOnly = bus.listInbox('charlie', { sender: 'alice' });
  assert.equal(aliceOnly.length, 2);
  assert.ok(aliceOnly.every(h => h.from === 'alice'));

  // Filter by limit
  const limited = bus.listInbox('charlie', { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].preview, 'Alice 1');
  assert.equal(limited[1].preview, 'Bob 1');

  // Sender filter through the same public listInbox peek API
  const aliasHeaders = bus.listInbox('charlie', { sender: 'bob' });
  assert.equal(aliasHeaders.length, 1);
  assert.equal(aliasHeaders[0].preview, 'Bob 1');
});

// ----------------------------------------------------------------------------
// [AC-WAIT-01] FIFO Wait
// ----------------------------------------------------------------------------
console.log('\n--- 4. [AC-WAIT-01] FIFO Wait ---');

await test('[AC-WAIT-01.1] waitForMail dequeues pre-existing envelopes and does not resurrect on repeat', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('worker');
  bus.registerAgent('director');

  // Send message before waiting
  bus.sendMessage({ from: 'worker', to: 'director', content: 'Report ready' });
  assert.equal(bus.getUnreadCount('director'), 1);

  // First wait: should resolve immediately with message dequeued
  const res1 = await bus.waitForMail('director', { senders: ['worker'], timeout_ms: 1000 });
  assert.equal(res1.success, true);
  assert.equal(res1.timedOut, false);
  assert.equal(res1.count, 1);
  assert.equal(res1.messages[0].content, 'Report ready');
  assert.equal(res1.messages[0].read, true);

  // Message must be dequeued from activeQueue and in archive
  assert.equal(bus.getUnreadCount('director'), 0);
  assert.equal(bus.listInbox('director').length, 0);
  assert.equal(bus.getArchive('director').length, 1);

  // Pure FIFO Invariant: Calling waitForMail again must NOT resurrect archived message
  const res2 = await bus.waitForMail('director', { senders: ['worker'], timeout_ms: 50 });
  assert.equal(res2.success, true);
  assert.equal(res2.timedOut, true);
  assert.equal(res2.count, 0);
  assert.equal(res2.messages.length, 0);
});

await test('[AC-WAIT-01.2] waitForMail halts turn and dequeues upon asynchronous message arrival', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('scout');
  bus.registerAgent('commander');

  const waitPromise = bus.waitForMail('commander', {
    senders: ['scout'],
    timeout_ms: 1000
  });

  // Message arrives after 25ms
  setTimeout(() => {
    bus.sendMessage({ from: 'scout', to: 'commander', content: 'Enemy spotted' });
  }, 25);

  const res = await waitPromise;
  assert.equal(res.success, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.count, 1);
  assert.equal(res.messages[0].content, 'Enemy spotted');

  // Dequeued immediately
  assert.equal(bus.getUnreadCount('commander'), 0);
  assert.equal(bus.getArchive('commander').length, 1);
});

await test('[AC-WAIT-01.3] waitForMail multi-sender require_all: false resolves on FIRST sender', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('scout1');
  bus.registerAgent('scout2');
  bus.registerAgent('commander');

  const waitPromise = bus.waitForMail('commander', {
    senders: ['scout1', 'scout2'],
    require_all: false,
    timeout_ms: 1000
  });

  setTimeout(() => {
    bus.sendMessage({ from: 'scout1', to: 'commander', content: 'Scout 1 report' });
  }, 20);

  const res = await waitPromise;
  assert.equal(res.success, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.count, 1);
  assert.equal(res.receivedSenders[0], 'scout1');
  assert.equal(bus.getUnreadCount('commander'), 0);
});

await test('[AC-WAIT-01.4] waitForMail timeout safety valve preserves arrived messages', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');
  bus.registerAgent('charlie');

  const waitPromise = bus.waitForMail('charlie', {
    senders: ['alice', 'bob'],
    require_all: true,
    timeout_ms: 100
  });

  // Only Alice responds
  setTimeout(() => {
    bus.sendMessage({ from: 'alice', to: 'charlie', content: 'Alice here' });
  }, 20);

  const res = await waitPromise;
  assert.equal(res.success, true);
  assert.equal(res.timedOut, true);
  assert.equal(res.count, 1);
  assert.equal(res.messages[0].from, 'alice');
  assert.deepEqual(res.receivedSenders, ['alice']);
  assert.deepEqual(res.missingSenders, ['bob']);

  // Alice's message is dequeued to archive
  assert.equal(bus.getUnreadCount('charlie'), 0);
  assert.equal(bus.getArchive('charlie').length, 1);
});

await test('[AC-WAIT-01.5] waitForMail cleans up listeners upon abort signal', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director');
  bus.registerAgent('silent');

  const ac = new AbortController();

  setTimeout(() => ac.abort(), 20);
  const res = await bus.waitForMail('director', {
    senders: ['silent'],
    timeout_ms: 2000,
    signal: ac.signal
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'ABORTED');
  assert.equal(res.count, 0);

  // A message arriving after the aborted wait must remain queued: a stale
  // subscription from the aborted wait would have consumed it.
  const late = bus.sendMessage({ from: 'silent', to: 'director', content: 'Post-abort mail' });
  assert.equal(late.success, true);
  assert.equal(bus.getUnreadCount('director'), 1, 'Aborted listener must not consume later mail');
});

// ----------------------------------------------------------------------------
// [AC-SNAPSHOT] Persistence Roundtrip & Compatibility
// ----------------------------------------------------------------------------
console.log('\n--- 5. [AC-SNAPSHOT] Persistence ---');

await test('[AC-SNAPSHOT.1] exportSnapshot and importSnapshot preserve activeQueues, archives, and registrations', () => {
  const bus1 = new MessagingBus();
  bus1.registerAgent('alice');
  bus1.registerAgent('bob');
  bus1.registerAgent('carol');
  bus1.markAgentTerminated('carol');

  // Bob has 1 unread message and 1 archived message
  bus1.sendMessage({ from: 'alice', to: 'bob', content: 'Archived msg' });
  bus1.drainInbox('bob');

  bus1.sendMessage({ from: 'alice', to: 'bob', content: 'Active unread msg' });

  assert.equal(bus1.getUnreadCount('bob'), 1);
  assert.equal(bus1.getArchive('bob').length, 1);

  // Export snapshot
  const snapshot = bus1.exportSnapshot();
  assert.ok(snapshot.activeQueues);
  assert.ok(snapshot.archives);
  assert.ok(snapshot.inboxes);
  assert.ok(snapshot.registeredAgents);
  assert.ok(snapshot.terminatedAgents.includes('carol'));
  assert.equal(snapshot.activeQueues.bob.length, 1);
  assert.equal(snapshot.archives.bob.length, 1);

  // Import into fresh bus
  const bus2 = new MessagingBus();
  bus2.importSnapshot(snapshot);

  assert.equal(bus2.isRegistered('alice'), true);
  assert.equal(bus2.isRegistered('bob'), true);
  assert.equal(bus2.isAgentTerminated('carol'), true);

  assert.equal(bus2.getUnreadCount('bob'), 1);
  const restoredActive = bus2.listInbox('bob');
  assert.equal(restoredActive[0].preview, 'Active unread msg');
  assert.equal(restoredActive[0].read, false);

  const restoredArchived = bus2.getArchive('bob');
  assert.equal(restoredArchived.length, 1);
  assert.equal(restoredArchived[0].content, 'Archived msg');
  assert.equal(restoredArchived[0].read, true);

  // History query works on restored archives
  const history = bus2.getArchive('bob');
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'Archived msg');
});

await test('[AC-SNAPSHOT.2] importSnapshot handles legacy snapshot with inboxes partitioning', () => {
  const legacySnapshot = {
    auditLog: [],
    terminatedAgents: ['dead_agent'],
    registeredAgents: {
      agent_a: { mode: 'queued', privileged: false },
      agent_b: { mode: 'queued', privileged: false }
    },
    inboxes: {
      agent_a: [
        { id: 'm1', from: 'agent_b', to: 'agent_a', content: 'Read message', read: true, timestamp: 100 },
        { id: 'm2', from: 'agent_b', to: 'agent_a', content: 'Unread message', read: false, timestamp: 200 }
      ]
    }
  };

  const bus = new MessagingBus();
  bus.importSnapshot(legacySnapshot);

  assert.equal(bus.isRegistered('agent_a'), true);
  assert.equal(bus.isAgentTerminated('dead_agent'), true);

  // Unread message correctly routed to activeQueues
  assert.equal(bus.getUnreadCount('agent_a'), 1);
  const restoredActive = bus.listInbox('agent_a');
  assert.equal(restoredActive[0].id, 'm2');
  assert.equal(restoredActive[0].read, false);

  // Read message correctly partitioned into archives
  const restoredArchived = bus.getArchive('agent_a');
  assert.equal(restoredArchived.length, 1);
  assert.equal(restoredArchived[0].id, 'm1');
  assert.equal(restoredArchived[0].read, true);
});

// ----------------------------------------------------------------------------
// 6. Backward Compatibility Bridge & Core Invariants
// ----------------------------------------------------------------------------
console.log('\n--- 6. Backward Compatibility Bridge & Core Invariants ---');

await test('purgeAgent atomically wipes queues, archive, and registration', () => {
  const bus = new MessagingBus();
  bus.registerAgent('temp_agent');
  bus.registerAgent('sender');

  bus.sendMessage({ from: 'sender', to: 'temp_agent', content: 'Msg 1' });
  assert.equal(bus.getUnreadCount('temp_agent'), 1);
  assert.equal(bus.isRegistered('temp_agent'), true);

  bus.purgeAgent('temp_agent');

  assert.equal(bus.isRegistered('temp_agent'), false);
  assert.equal(bus.getUnreadCount('temp_agent'), 0);
  assert.equal(bus.listInbox('temp_agent').length, 0);
  assert.equal(bus.getArchive('temp_agent').length, 0);

  const rejected = bus.sendMessage({ from: 'sender', to: 'temp_agent', content: 'Msg 2' });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'RECIPIENT_NOT_FOUND');
});

await test('getPolicy returns { mode: "queued", privileged: boolean }', () => {
  // MOD-21 W4: policy privilege is re-derived from the injected identity
  // resolver; the caller-asserted `privileged` policy field is inert.
  const bus = new MessagingBus({
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'admin'
        ? {
          id: agentId,
          privileged: false,
          allowedTools: [],
          authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' }
        }
        : { id: agentId, privileged: false, allowedTools: [] })
    }
  });
  bus.registerAgent('normal');
  bus.registerAgent('admin', { privileged: true });

  assert.deepEqual(bus.getPolicy('normal'), { mode: 'queued', privileged: false });
  assert.deepEqual(bus.getPolicy('admin'), { mode: 'queued', privileged: true });
  assert.equal(bus.getPolicy('unregistered'), undefined);
});

await test('sendMessage rejects dead or unregistered recipients', () => {
  const bus = new MessagingBus();
  bus.registerAgent('active');
  bus.registerAgent('doomed');
  bus.markAgentTerminated('doomed');

  const resUnregistered = bus.sendMessage({ from: 'active', to: 'ghost', content: 'Hello' });
  assert.equal(resUnregistered.success, false);
  assert.equal(resUnregistered.code, 'RECIPIENT_NOT_FOUND');

  const resTerminated = bus.sendMessage({ from: 'active', to: 'doomed', content: 'Hello' });
  assert.equal(resTerminated.success, false);
  assert.equal(resTerminated.code, 'AGENT_TERMINATED');
});

await test('broadcast to "all" routes to all active agents, excluding sender and dead agents', () => {
  const bus = new MessagingBus();
  bus.registerAgent('leader');
  bus.registerAgent('scout1');
  bus.registerAgent('scout2');
  bus.registerAgent('corpse');
  bus.markAgentTerminated('corpse');

  const res = bus.sendMessage({ from: 'leader', to: 'all', content: 'Roll call' });
  assert.equal(res.success, true);
  assert.equal(res.broadcast, true);
  assert.deepEqual(res.recipients.sort(), ['scout1', 'scout2']);

  assert.equal(bus.getUnreadCount('scout1'), 1);
  assert.equal(bus.getUnreadCount('scout2'), 1);
  assert.equal(bus.getUnreadCount('leader'), 0);
  assert.equal(bus.getUnreadCount('corpse'), 0);
});

await test('[ICD-A ea6d16e] getArchive preserves broadcast/recipients for archived and snapshot-restored messages', () => {
  const bus = new MessagingBus();
  bus.registerAgent('leader');
  bus.registerAgent('scout1');
  bus.registerAgent('scout2');

  const res = bus.sendMessage({ from: 'leader', to: 'all', content: 'Roll call' });
  assert.equal(res.broadcast, true);
  bus.drainInbox('scout1');

  const archived = bus.getArchive('scout1');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].broadcast, true);
  assert.deepEqual([...archived[0].recipients].sort(), ['scout1', 'scout2']);

  const restoredBus = new MessagingBus();
  restoredBus.importSnapshot(bus.exportSnapshot());
  const restored = restoredBus.getArchive('scout1');
  assert.equal(restored[0].broadcast, true);
  assert.deepEqual([...restored[0].recipients].sort(), ['scout1', 'scout2']);

  restoredBus.sendMessage({ from: 'leader', to: 'scout1', content: 'Direct' });
  restoredBus.drainInbox('scout1');
  const direct = restoredBus.getArchive('scout1').find(m => m.content === 'Direct');
  assert.equal(direct.broadcast, undefined);
  assert.equal(direct.recipients, undefined);
  assert.equal(direct.success, true);
});

await test('forAgent helper proxy exposes agent-scoped operations', () => {
  const bus = new MessagingBus();
  bus.registerAgent('agent1');
  bus.registerAgent('agent2');

  const proxy1 = bus.forAgent('agent1');
  assert.equal(proxy1.agentId, 'agent1');

  proxy1.sendMessage('agent2', 'Hello from proxy');
  assert.equal(bus.getUnreadCount('agent2'), 1);

  const proxy2 = bus.forAgent('agent2');
  assert.equal(proxy2.getUnreadCount(), 1);

  const headers = proxy2.listInbox();
  assert.equal(headers.length, 1);
  assert.equal(headers[0].from, 'agent1');

  const readRes = proxy2.readMessage(headers[0].id);
  assert.equal(readRes.success, true);
  assert.equal(proxy2.getUnreadCount(), 0);

  const history = proxy2.getArchive();
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'Hello from proxy');
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log('\n===============================================================');
console.log(`  RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL ${totalTests})`);
console.log('===============================================================');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
