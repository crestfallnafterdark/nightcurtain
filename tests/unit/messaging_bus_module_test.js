/**
 * @file tests/unit/messaging_bus_module_test.js
 * @description Comprehensive isolated unit and contract tests for Module 2: MessagingBus.
 * Verifies strict ICD compliance against:
 *   [AC-BUS-01] Strict Dequeue on Read
 *   [AC-BUS-02] Clean Drain
 *   [AC-BUS-03] Non-Destructive Peek
 *   [AC-BUS-04] Dead-Letter Rejection
 *   [AC-BUS-05] Broadcast Isolation
 *   [AC-BUS-06] Blocking FIFO Wait
 *   [AC-BUS-07] Snapshot Roundtrip
 *   [AC-BUS-08] Legacy Partitioning
 *   [AC-BUS-09] Opaque Purge
 *   [AC-BUS-10] Dual-Signature Tool Uniformity & Inline File Embedding
 *   [AC-BUS-11] Agent Lifecycle & State Management
 *   [AC-BUS-12] Real-time Pub/Sub & Audit Logging
 *   [AC-BUS-13] Agent Messaging Proxy (forAgent Facade)
 *   [AC-BUS-14] VirtualFS Contract Consumption for File Inlining
 *   [AC-BUS-16] Throw-Safety on Unserializable Content (circular/BigInt)
 *   [AC-BUS-17] Legacy Alias Surface (declared aliases resolve to canonical behavior)
 *   [ICD-A 4fee390] Persisted Envelope `success` Contract
 *   [ICD-A ea6d16e] Archived Broadcast Envelope Markers (`broadcast`/`recipients`)
 *   [MOD-21 W8-D 134c19e] Context-First Mailbox Routing & Sender Identity
 *   [Realm wave A 7387ce1] Realm-Scoped Delivery (cross-realm denial, bypass principals, filtered broadcast)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as MessagingBusModule from '../../src/lib/sandbox/messagingBus/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';

const { MessagingBus, MESSAGING_ERROR_CODES } = MessagingBusModule;

test('0. Strict Export Whitelist & Constants', () => {
  const exportedKeys = Object.keys(MessagingBusModule).sort();
  assert.deepStrictEqual(exportedKeys, ['MESSAGING_ERROR_CODES', 'MessagingBus']);

  assert.strictEqual(MESSAGING_ERROR_CODES.AGENT_TERMINATED, 'AGENT_TERMINATED');
  assert.strictEqual(MESSAGING_ERROR_CODES.RECIPIENT_NOT_FOUND, 'RECIPIENT_NOT_FOUND');
  assert.strictEqual(MESSAGING_ERROR_CODES.PERMISSION_DENIED, 'PERMISSION_DENIED');
  assert.strictEqual(MESSAGING_ERROR_CODES.MESSAGE_NOT_FOUND, 'MESSAGE_NOT_FOUND');
  assert.strictEqual(MESSAGING_ERROR_CODES.INVALID_ARGUMENTS, 'INVALID_ARGUMENTS');
  assert.strictEqual(MESSAGING_ERROR_CODES.VFS_UNAVAILABLE, 'VFS_UNAVAILABLE');
  assert.strictEqual(MESSAGING_ERROR_CODES.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
  assert.strictEqual(MESSAGING_ERROR_CODES.TIMEOUT, 'TIMEOUT');
  assert.strictEqual(MESSAGING_ERROR_CODES.ABORTED, 'ABORTED');
  assert.ok(Object.isFrozen(MESSAGING_ERROR_CODES));
});

test('1. Absolute Encapsulation (No Leaky Public Queues or Private State)', () => {
  const bus = new MessagingBus();
  assert.strictEqual(bus.activeQueues, undefined, 'activeQueues must be private');
  assert.strictEqual(bus.archives, undefined, 'archives must be private');
  assert.strictEqual(bus.registeredAgents, undefined, 'registeredAgents must be private');
  assert.strictEqual(bus.terminatedAgents, undefined, 'terminatedAgents must be private');
  assert.strictEqual(bus.auditLog, undefined, 'auditLog must be private');
  assert.strictEqual(bus.subscriptions, undefined, 'subscriptions must be private');
  assert.strictEqual(bus.policies, undefined, 'policies must be private');
  assert.strictEqual(bus.inboxes, undefined, 'inboxes getter must be gutted');
});

test('2. Agent Lifecycle & Registration Management', () => {
  // MOD-21 W4: policy privilege derives from the injected identity port; the
  // caller-asserted `privileged` policy field is inert.
  const bus = new MessagingBus({
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'director'
        ? {
          id: agentId,
          privileged: false,
          allowedTools: [],
          authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' }
        }
        : { id: agentId, privileged: false, allowedTools: [] })
    }
  });

  // Invalid registration
  assert.throws(() => bus.registerAgent(''), /Valid string agentId is required/);
  assert.throws(() => bus.registerAgent(null), /Valid string agentId is required/);

  // Valid registration (the `privileged` policy claim on worker_1 is ignored)
  bus.registerAgent('director', { mode: 'queued' });
  bus.registerAgent('worker_1', { privileged: true });

  assert.strictEqual(bus.isRegistered('director'), true);
  assert.strictEqual(bus.isRegistered('worker_1'), true);
  assert.strictEqual(bus.isRegistered('non_existent'), false);

  assert.deepStrictEqual(bus.getPolicy('director'), { mode: 'queued', privileged: true });
  assert.deepStrictEqual(bus.getPolicy('worker_1'), { mode: 'queued', privileged: false });
  assert.strictEqual(bus.getPolicy('non_existent'), undefined);

  assert.deepStrictEqual(bus.getRegisteredAgents().sort(), ['director', 'worker_1']);
  assert.deepStrictEqual(bus.getTerminatedAgents(), []);

  // Terminate agent
  bus.markAgentTerminated('worker_1');
  assert.strictEqual(bus.isAgentTerminated('worker_1'), true);
  assert.strictEqual(bus.isRegistered('worker_1'), false);
  assert.deepStrictEqual(bus.getTerminatedAgents(), ['worker_1']);
  assert.deepStrictEqual(bus.getRegisteredAgents(), ['director']);

  // Revive / Unmark terminated agent
  bus.unmarkAgentTerminated('worker_1');
  assert.strictEqual(bus.isAgentTerminated('worker_1'), false);

  // Re-register agent clears terminated status automatically
  bus.markAgentTerminated('worker_1');
  assert.strictEqual(bus.isAgentTerminated('worker_1'), true);
  bus.registerAgent('worker_1');
  assert.strictEqual(bus.isAgentTerminated('worker_1'), false);
  assert.strictEqual(bus.isRegistered('worker_1'), true);

  // Unregister agent
  bus.unregisterAgent('worker_1');
  assert.strictEqual(bus.isRegistered('worker_1'), false);

  // Reset clears all
  bus.reset();
  assert.deepStrictEqual(bus.getRegisteredAgents(), []);
  assert.deepStrictEqual(bus.getTerminatedAgents(), []);
  assert.deepStrictEqual(bus.getAuditLog(), []);
});

test('3. [AC-BUS-01] Strict Dequeue on Read & Non-Destructive Peek', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  const m1 = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Message 1', type: 'task' });
  const m2 = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Message 2', type: 'task' });

  assert.strictEqual(bus.getUnreadCount('bob'), 2);

  // Read m1 with default markAsRead: true (atomically moves to archive)
  const res1 = bus.readMessage('bob', m1.messageId);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.status, 'inbox');
  assert.strictEqual(res1.message.id, m1.id);
  assert.strictEqual(res1.message.read, true);

  // Unread count must now be 1
  assert.strictEqual(bus.getUnreadCount('bob'), 1);

  // Subsequent read of m1 returns from archive with status 'archived'
  const res1_again = bus.readMessage('bob', m1.messageId);
  assert.strictEqual(res1_again.success, true);
  assert.strictEqual(res1_again.status, 'archived');
  assert.strictEqual(res1_again.message.id, m1.id);
  assert.strictEqual(res1_again.message.read, true);

  // Read m2 with markAsRead: false (non-destructive read/peek)
  const res2 = bus.readMessage('bob', m2.messageId, { markAsRead: false });
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.status, 'inbox');
  assert.strictEqual(res2.message.read, false);
  assert.strictEqual(bus.getUnreadCount('bob'), 1);

  // Read non-existent message
  const notFoundRes = bus.readMessage('bob', 'msg_unknown_123');
  assert.strictEqual(notFoundRes.success, false);
  assert.strictEqual(notFoundRes.code, MESSAGING_ERROR_CODES.MESSAGE_NOT_FOUND);

  // Read with missing parameters
  const invalidArgRes1 = bus.readMessage('', 'msg_1');
  assert.strictEqual(invalidArgRes1.success, false);
  assert.strictEqual(invalidArgRes1.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);

  const invalidArgRes2 = bus.readMessage('bob', '');
  assert.strictEqual(invalidArgRes2.success, false);
  assert.strictEqual(invalidArgRes2.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);
});

test('4. [AC-BUS-02] Clean Drain (drainInbox)', () => {
  const bus = new MessagingBus();
  bus.registerAgent('sender');
  bus.registerAgent('receiver');

  bus.sendMessage({ from: 'sender', to: 'receiver', content: 'Work 1' });
  bus.sendMessage({ from: 'sender', to: 'receiver', content: 'Work 2' });
  assert.strictEqual(bus.getUnreadCount('receiver'), 2);

  const drained = bus.drainInbox('receiver');
  assert.strictEqual(drained.length, 2);
  assert.strictEqual(drained[0].content, 'Work 1');
  assert.strictEqual(drained[1].content, 'Work 2');
  assert.ok(drained.every(m => m.read === true));

  assert.strictEqual(bus.getUnreadCount('receiver'), 0);

  // Subsequent drain immediately returns empty
  const drainedAgain = bus.drainInbox('receiver');
  assert.strictEqual(drainedAgain.length, 0);

  // Archive contains both consumed messages
  const archive = bus.getArchive('receiver');
  assert.strictEqual(archive.length, 2);
});

test('5. [AC-BUS-03] Non-Destructive Peek & Snippet Formatting (listInbox)', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');
  bus.registerAgent('charlie');

  bus.sendMessage({ from: 'alice', to: 'bob', content: 'Short message', type: 'info' });
  bus.sendMessage({ from: 'charlie', to: 'bob', content: 'X'.repeat(120), type: 'report' });

  // List unread headers
  const headers = bus.listInbox('bob', { status: 'unread' });
  assert.strictEqual(headers.length, 2);
  assert.strictEqual(headers[0].from, 'alice');
  assert.strictEqual(headers[0].preview, 'Short message');
  assert.strictEqual(headers[0].snippet, 'Short message');
  assert.strictEqual(headers[0].read, false);

  assert.strictEqual(headers[1].from, 'charlie');
  assert.strictEqual(headers[1].preview.length, 83); // 80 chars + '...'
  assert.ok(headers[1].preview.endsWith('...'));

  // Filtering by sender
  const aliceOnly = bus.listInbox('bob', { sender: 'alice' });
  assert.strictEqual(aliceOnly.length, 1);
  assert.strictEqual(aliceOnly[0].from, 'alice');

  // Pagination (limit, offset)
  const paged = bus.listInbox('bob', { limit: 1, offset: 1 });
  assert.strictEqual(paged.length, 1);
  assert.strictEqual(paged[0].from, 'charlie');

  // Unread count remains untouched
  assert.strictEqual(bus.getUnreadCount('bob'), 2);

  // Drain and list archived mail
  bus.drainInbox('bob');
  const readHeaders = bus.listInbox('bob', { status: 'read' });
  assert.strictEqual(readHeaders.length, 2);
  assert.ok(readHeaders.every(h => h.read === true));
});

test('6. [AC-BUS-04] Point-to-Point Routing, Dead-Letter Rejection & Argument Validation', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');
  bus.markAgentTerminated('bob');

  // Point-to-point success
  bus.registerAgent('carol');
  const validReceipt = bus.sendMessage({
    from: 'alice',
    to: 'carol',
    content: 'Task payload',
    replyTo: 'custom_reply',
    metadata: { correlationId: 'job_42' },
    type: 'query'
  });
  assert.strictEqual(validReceipt.success, true);
  assert.strictEqual(validReceipt.from, 'alice');
  assert.strictEqual(validReceipt.to, 'carol');
  assert.strictEqual(validReceipt.replyTo, 'custom_reply');
  assert.strictEqual(validReceipt.type, 'query');
  assert.strictEqual(validReceipt.metadata.correlationId, 'job_42');

  // Dead-letter: unregistered recipient
  const resUnregistered = bus.sendMessage({ from: 'alice', to: 'ghost_agent', content: 'Hello' });
  assert.strictEqual(resUnregistered.success, false);
  assert.strictEqual(resUnregistered.code, MESSAGING_ERROR_CODES.RECIPIENT_NOT_FOUND);

  // Dead-letter: terminated recipient
  const resTerminated = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Hello' });
  assert.strictEqual(resTerminated.success, false);
  assert.strictEqual(resTerminated.code, MESSAGING_ERROR_CODES.AGENT_TERMINATED);

  // Missing arguments
  const missingFrom = bus.sendMessage({ to: 'carol', content: 'Hi' });
  assert.strictEqual(missingFrom.success, false);
  assert.strictEqual(missingFrom.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);

  const missingTo = bus.sendMessage({ from: 'alice', content: 'Hi' });
  assert.strictEqual(missingTo.success, false);
  assert.strictEqual(missingTo.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);

  const missingContent = bus.sendMessage({ from: 'alice', to: 'carol' });
  assert.strictEqual(missingContent.success, false);
  assert.strictEqual(missingContent.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);
});

test('7. [AC-BUS-05] Broadcast Isolation (to === "all")', () => {
  const bus = new MessagingBus();
  bus.registerAgent('sender');
  bus.registerAgent('r1');
  bus.registerAgent('r2');
  bus.registerAgent('r3');
  bus.markAgentTerminated('r3');

  const res = bus.sendMessage({ from: 'sender', to: 'all', content: 'System alert' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.broadcast, true);
  assert.deepStrictEqual(res.recipients.sort(), ['r1', 'r2']);

  // Delivered to active registered recipients, excluding sender and terminated agents
  assert.strictEqual(bus.getUnreadCount('r1'), 1);
  assert.strictEqual(bus.getUnreadCount('r2'), 1);
  assert.strictEqual(bus.getUnreadCount('r3'), 0);
  assert.strictEqual(bus.getUnreadCount('sender'), 0);
});

test('8. [AC-BUS-06] Blocking FIFO Wait (waitForMail)', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('worker_a');
  bus.registerAgent('worker_b');
  bus.registerAgent('coordinator');

  // Case 1: Immediate resolution when messages already present in activeQueue
  bus.sendMessage({ from: 'worker_a', to: 'coordinator', content: 'Ready A' });
  bus.sendMessage({ from: 'worker_b', to: 'coordinator', content: 'Ready B' });

  const immediateRes = await bus.waitForMail('coordinator', {
    senders: ['worker_a', 'worker_b'],
    requireAll: true,
    timeoutMs: 1000
  });

  assert.strictEqual(immediateRes.success, true);
  assert.strictEqual(immediateRes.timedOut, false);
  assert.strictEqual(immediateRes.count, 2);
  assert.deepStrictEqual(immediateRes.receivedSenders.sort(), ['worker_a', 'worker_b']);
  assert.deepStrictEqual(immediateRes.missingSenders, []);
  assert.strictEqual(bus.getUnreadCount('coordinator'), 0); // Dequeued on read

  // Case 2: Asynchronous arrival resolution via live subscriber
  const asyncPromise = bus.waitForMail('coordinator', {
    sender: 'worker_a',
    timeoutMs: 1000
  });

  setTimeout(() => {
    bus.sendMessage({ from: 'worker_a', to: 'coordinator', content: 'Late update' });
  }, 30);

  const asyncRes = await asyncPromise;
  assert.strictEqual(asyncRes.success, true);
  assert.strictEqual(asyncRes.timedOut, false);
  assert.strictEqual(asyncRes.count, 1);
  assert.strictEqual(asyncRes.messages[0].content, 'Late update');

  // Case 3: Timeout expiration
  const timeoutRes = await bus.waitForMail('coordinator', {
    senders: ['worker_a', 'worker_b'],
    requireAll: true,
    timeoutMs: 40
  });
  assert.strictEqual(timeoutRes.success, true);
  assert.strictEqual(timeoutRes.timedOut, true);
  assert.strictEqual(timeoutRes.code, MESSAGING_ERROR_CODES.TIMEOUT);
  assert.deepStrictEqual(timeoutRes.missingSenders.sort(), ['worker_a', 'worker_b']);

  // Case 4: AbortSignal cooperative cancellation
  const ac = new AbortController();
  const abortPromise = bus.waitForMail('coordinator', {
    sender: 'worker_a',
    timeoutMs: 5000,
    signal: ac.signal
  });
  setTimeout(() => {
    ac.abort();
  }, 20);

  const abortRes = await abortPromise;
  assert.strictEqual(abortRes.success, false);
  assert.strictEqual(abortRes.code, MESSAGING_ERROR_CODES.ABORTED);

  // Case 5: Invalid arguments
  const invalidWait = await bus.waitForMail('');
  assert.strictEqual(invalidWait.success, false);
  assert.strictEqual(invalidWait.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);
});

test('9. [AC-BUS-07] Snapshot Roundtrip & [AC-BUS-08] Legacy Partitioning', () => {
  const bus1 = new MessagingBus();
  bus1.registerAgent('agent_a', { mode: 'queued', privileged: true });
  bus1.registerAgent('agent_b', { privileged: false });
  bus1.registerAgent('agent_c');
  bus1.markAgentTerminated('agent_c');

  bus1.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'Archived msg', type: 'note' });
  bus1.drainInbox('agent_b');
  bus1.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'Unread msg', type: 'task' });

  const snapshot = bus1.exportSnapshot();
  assert.ok(snapshot.auditLog.length >= 2);
  assert.strictEqual(snapshot.activeQueues.agent_b.length, 1);
  assert.strictEqual(snapshot.archives.agent_b.length, 1);
  // MOD-21 W4: trust is never persisted
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot.registeredAgents.agent_a, 'privileged'), false);
  assert.deepStrictEqual(snapshot.terminatedAgents, ['agent_c']);

  // Hydrate into new instance (no identity port => default-deny, fail closed)
  const bus2 = new MessagingBus();
  bus2.importSnapshot(snapshot);

  assert.strictEqual(bus2.isRegistered('agent_a'), true);
  assert.strictEqual(bus2.getPolicy('agent_a').privileged, false);
  assert.strictEqual(bus2.isRegistered('agent_b'), true);
  assert.strictEqual(bus2.isAgentTerminated('agent_c'), true);
  assert.strictEqual(bus2.getUnreadCount('agent_b'), 1);
  assert.strictEqual(bus2.getArchive('agent_b').length, 1);
  assert.strictEqual(bus2.getAuditLog().length, bus1.getAuditLog().length);

  // Legacy snapshot parsing with 'inboxes' map
  const legacySnapshot = {
    auditLog: [],
    registeredAgents: { x: { mode: 'queued', privileged: false } },
    terminatedAgents: ['y'],
    inboxes: {
      x: [
        { id: '1', from: 'z', to: 'x', content: 'Old', read: true, timestamp: 100 },
        { id: '2', from: 'z', to: 'x', content: 'New', read: false, timestamp: 200 }
      ]
    }
  };

  const bus3 = new MessagingBus();
  bus3.importSnapshot(legacySnapshot);
  assert.strictEqual(bus3.isRegistered('x'), true);
  assert.strictEqual(bus3.isAgentTerminated('y'), true);
  assert.strictEqual(bus3.getUnreadCount('x'), 1);
  assert.strictEqual(bus3.getArchive('x').length, 1);
  assert.strictEqual(bus3.getArchive('x')[0].content, 'Old');
});

test('10. [AC-BUS-09] Opaque Purge (purgeAgent)', () => {
  const bus = new MessagingBus();
  bus.registerAgent('temp');
  bus.registerAgent('other');
  bus.sendMessage({ from: 'other', to: 'temp', content: 'Hello' });

  assert.strictEqual(bus.isRegistered('temp'), true);
  assert.strictEqual(bus.getUnreadCount('temp'), 1);

  bus.purgeAgent('temp');
  assert.strictEqual(bus.isRegistered('temp'), false);
  assert.strictEqual(bus.isAgentTerminated('temp'), false);
  assert.strictEqual(bus.getUnreadCount('temp'), 0);
  assert.strictEqual(bus.getArchive('temp').length, 0);
  assert.strictEqual(bus.getPolicy('temp'), undefined);
});

test('11. [AC-BUS-10] Real VirtualFS File Inlining (inlineFileInMessage)', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('analyst');
  bus.registerAgent('director');

  const vfs = new VirtualFS();
  vfs.writeFile('/workspace/report.md', '# Q3 Summary\nRevenue increased by 15%.', { workspaceId: 'analyst', callerAgentId: 'analyst' });

  // Inlining with real VirtualFS
  const inlineRes = await bus.inlineFileInMessage('/workspace/report.md', 'director', {
    virtualFs: vfs,
    from: 'analyst',
    message: 'Here is the requested Q3 report:'
  });

  assert.strictEqual(inlineRes.success, true);
  assert.strictEqual(inlineRes.inlinedFiles.length, 1);
  assert.strictEqual(inlineRes.inlinedFiles[0].path, '/workspace/report.md');
  assert.strictEqual(inlineRes.totalBytes, 38);
  assert.ok(inlineRes.wordsCount > 0);
  assert.ok(inlineRes.deliveryConfirmation.includes('Successfully inlined'));

  // Verify recipient received formatted file content
  const readRes = bus.readMessage('director', inlineRes.messageId);
  assert.strictEqual(readRes.success, true);
  assert.ok(readRes.message.content.includes('Here is the requested Q3 report:'));
  assert.ok(readRes.message.content.includes('--- Inlined File: /workspace/report.md (38 bytes) ---'));
  assert.ok(readRes.message.content.includes('# Q3 Summary\nRevenue increased by 15%.'));

  // Custom template formatting
  const customTemplateRes = await bus.inlineFileInMessage({
    filePath: '/workspace/report.md',
    recipient: 'director',
    from: 'analyst',
    template: 'START:\n${content}\nFILE:${filePath}\nEND'
  }, { virtualFs: vfs, callerAgentId: 'analyst' });

  assert.strictEqual(customTemplateRes.success, true);
  const customRead = bus.readMessage('director', customTemplateRes.messageId);
  assert.ok(customRead.message.content.includes('START:\n# Q3 Summary\nRevenue increased by 15%.\nFILE:/workspace/report.md\nEND'));

  // Error: VirtualFS unavailable
  const missingVfsRes = await bus.inlineFileInMessage({
    filePath: '/workspace/report.md',
    recipient: 'director',
    from: 'analyst'
  });
  assert.strictEqual(missingVfsRes.success, false);
  assert.strictEqual(missingVfsRes.code, MESSAGING_ERROR_CODES.VFS_UNAVAILABLE);

  // Error: File not found in VirtualFS
  const missingFileRes = await bus.inlineFileInMessage({
    filePath: '/workspace/non_existent.md',
    recipient: 'director',
    from: 'analyst'
  }, { virtualFs: vfs, callerAgentId: 'analyst' });
  assert.strictEqual(missingFileRes.success, false);
  assert.strictEqual(missingFileRes.code, MESSAGING_ERROR_CODES.FILE_NOT_FOUND);

  // Error: Recipient is terminated
  bus.markAgentTerminated('director');
  const termRes = await bus.inlineFileInMessage({
    filePath: '/workspace/report.md',
    recipient: 'director',
    from: 'analyst'
  }, { virtualFs: vfs, callerAgentId: 'analyst' });
  assert.strictEqual(termRes.success, false);
  assert.strictEqual(termRes.code, MESSAGING_ERROR_CODES.AGENT_TERMINATED);
});

test('12. [AC-BUS-12] Real-time Pub/Sub Subscriptions & Global Audit Logging', () => {
  const bus = new MessagingBus();
  bus.registerAgent('producer');
  bus.registerAgent('consumer');

  const receivedWildcard = [];
  const receivedDirect = [];

  const unsubWildcard = bus.subscribe('all', (msg) => {
    receivedWildcard.push(msg);
  });

  const unsubDirect = bus.subscribe('consumer', (msg) => {
    receivedDirect.push(msg);
  });

  bus.sendMessage({ from: 'producer', to: 'consumer', content: 'Event 1', type: 'event' });
  bus.sendMessage({ from: 'producer', to: 'consumer', content: 'Event 2', type: 'event' });

  assert.strictEqual(receivedWildcard.length, 2);
  assert.strictEqual(receivedDirect.length, 2);

  // Unsubscribe direct listener
  unsubDirect();
  bus.sendMessage({ from: 'producer', to: 'consumer', content: 'Event 3', type: 'event' });

  assert.strictEqual(receivedWildcard.length, 3);
  assert.strictEqual(receivedDirect.length, 2); // Unsubscribed, no new events

  // Unsubscribe wildcard listener
  unsubWildcard();
  bus.sendMessage({ from: 'producer', to: 'consumer', content: 'Event 4', type: 'event' });
  assert.strictEqual(receivedWildcard.length, 3);

  // Audit log inspection
  const allLogs = bus.getAuditLog();
  assert.strictEqual(allLogs.length, 4);

  const eventLogs = bus.getAuditLog({ type: 'event', limit: 2 });
  assert.strictEqual(eventLogs.length, 2);

  const agentLogs = bus.getAuditLog({ agentId: 'consumer' });
  assert.strictEqual(agentLogs.length, 4);
});

test('13. [AC-BUS-13] Agent Messaging Proxy (forAgent Facade)', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('agent_x');
  bus.registerAgent('agent_y');

  const proxyX = bus.forAgent('agent_x');
  const proxyY = bus.forAgent('agent_y');

  assert.strictEqual(proxyX.agentId, 'agent_x');
  assert.strictEqual(proxyY.agentId, 'agent_y');

  // sendMessage via proxy
  const receipt = proxyX.sendMessage('agent_y', 'Hello from proxy X');
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.from, 'agent_x');
  assert.strictEqual(receipt.to, 'agent_y');
  assert.strictEqual(proxyY.getUnreadCount(), 1);

  // listInbox via proxy
  const headers = proxyY.listInbox();
  assert.strictEqual(headers.length, 1);
  assert.strictEqual(headers[0].from, 'agent_x');

  // readMessage via proxy
  const readRes = proxyY.readMessage(headers[0].id);
  assert.strictEqual(readRes.success, true);
  assert.strictEqual(proxyY.getUnreadCount(), 0);

  // getArchive via proxy
  const archive = proxyY.getArchive();
  assert.strictEqual(archive.length, 1);

  // broadcast via proxy
  bus.registerAgent('agent_z');
  const bReceipt = proxyX.broadcast('Broadcast from proxy X');
  assert.strictEqual(bReceipt.success, true);
  assert.deepStrictEqual(bReceipt.recipients.sort(), ['agent_y', 'agent_z']);

  // drainInbox via proxy
  const drained = proxyY.drainInbox();
  assert.strictEqual(drained.length, 1);
  assert.strictEqual(proxyY.getUnreadCount(), 0);

  // inlineFileInMessage via proxy
  const vfs = new VirtualFS();
  vfs.writeFile('/notes.txt', 'Secret notes', { workspaceId: 'agent_x', callerAgentId: 'agent_x' });
  const inlineRes = await proxyX.inlineFileInMessage('/notes.txt', 'agent_y', { virtualFs: vfs });
  assert.strictEqual(inlineRes.success, true);
  assert.strictEqual(inlineRes.from, 'agent_x');
  assert.strictEqual(proxyY.getUnreadCount(), 1);

  // MOD-21 W9-C: the bound sender is authoritative; payload identity cannot spoof it
  const spoofSend = proxyX.sendMessage({ from: 'agent_y', sender: 'agent_y', to: 'agent_y', content: 'spoof' });
  assert.strictEqual(spoofSend.success, true);
  assert.strictEqual(spoofSend.from, 'agent_x');

  const spoofInline = await proxyX.inlineFileInMessage('/notes.txt', 'agent_y', {
    virtualFs: vfs,
    from: 'agent_y',
    sender: 'agent_y',
    callerAgentId: 'agent_y'
  });
  assert.strictEqual(spoofInline.success, true);
  assert.strictEqual(spoofInline.from, 'agent_x');
});

test('14. [AC-BUS-14] Archive Search & Pagination (getArchive)', () => {
  const bus = new MessagingBus();
  bus.registerAgent('author');
  bus.registerAgent('reader');

  bus.sendMessage({ from: 'author', to: 'reader', content: 'Alpha chapter 1' });
  bus.sendMessage({ from: 'author', to: 'reader', content: 'Beta chapter 2' });
  bus.sendMessage({ from: 'author', to: 'reader', content: 'Alpha chapter 3' });
  bus.drainInbox('reader');

  // Search filter
  const searchAlpha = bus.getArchive('reader', { search: 'alpha' });
  assert.strictEqual(searchAlpha.length, 2);

  const searchBeta = bus.getArchive('reader', { search: 'beta' });
  assert.strictEqual(searchBeta.length, 1);
  assert.strictEqual(searchBeta[0].content, 'Beta chapter 2');

  // Limit and offset
  const paged = bus.getArchive('reader', { limit: 1, offset: 1 });
  assert.strictEqual(paged.length, 1);
  assert.strictEqual(paged[0].content, 'Beta chapter 2');
});

test('15. [AC-BUS-15] Dual-Signature Tool Uniformity across (params, context)', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('bot_1');
  bus.registerAgent('bot_2');

  const vfs = new VirtualFS();
  vfs.writeFile('/workspace/data.json', { status: 'ok', counter: 1 }, { workspaceId: 'bot_1', callerAgentId: 'bot_1' });

  const context1 = { callerAgentId: 'bot_1', virtualFs: vfs };
  const context2 = { callerAgentId: 'bot_2', virtualFs: vfs };

  // 1. sendMessage(params, context)
  const sendRes = bus.sendMessage({
    recipient: 'bot_2',
    message: 'Hello via tool call',
    correlation_id: 'tool_job_1'
  }, context1);
  assert.strictEqual(sendRes.success, true);
  assert.strictEqual(sendRes.from, 'bot_1');
  assert.strictEqual(sendRes.to, 'bot_2');
  assert.strictEqual(sendRes.metadata.correlationId, 'tool_job_1');

  // 2. listInbox(params, context)
  const headers = bus.listInbox({ unread_only: true }, context2);
  assert.strictEqual(headers.length, 1);
  assert.strictEqual(headers[0].from, 'bot_1');

  // 3. readMessage(params, context)
  const readRes = bus.readMessage({
    message_id: headers[0].id,
    mark_as_read: false
  }, context2);
  assert.strictEqual(readRes.success, true);
  assert.strictEqual(readRes.message.read, false);
  assert.strictEqual(bus.getUnreadCount('bot_2'), 1);

  // 4. inlineFileInMessage(params, context)
  const inlineRes = await bus.inlineFileInMessage({
    file_path: '/workspace/data.json',
    recipient: 'bot_2',
    message: 'Check state:'
  }, context1);
  assert.strictEqual(inlineRes.success, true);
  assert.strictEqual(bus.getUnreadCount('bot_2'), 2);

  // 5. drainInbox(params, context)
  const drained = bus.drainInbox({}, context2);
  assert.strictEqual(drained.length, 2);
  assert.strictEqual(bus.getUnreadCount('bot_2'), 0);

  // 6. getArchive(params, context)
  const archive = bus.getArchive({ limit: 10 }, context2);
  assert.strictEqual(archive.length, 2);

  // 7. waitForMail(params, context)
  const waitRes = await bus.waitForMail({
    sender: 'bot_1',
    timeout_ms: 10
  }, context2);
  assert.strictEqual(waitRes.success, true);
  assert.strictEqual(waitRes.timedOut, true);
});

test('16. [AC-BUS-16] Throw-Safety on Unserializable Content (circular/BigInt)', () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  const circular = { name: 'loop' };
  circular.self = circular;

  let circularReceipt;
  assert.doesNotThrow(() => {
    circularReceipt = bus.sendMessage({ from: 'alice', to: 'bob', content: circular });
  });
  assert.strictEqual(circularReceipt.success, false);
  assert.strictEqual(circularReceipt.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);
  assert.match(circularReceipt.error, /serializ/i);

  let bigintReceipt;
  assert.doesNotThrow(() => {
    bigintReceipt = bus.sendMessage({ from: 'alice', to: 'bob', content: 10n });
  });
  assert.strictEqual(bigintReceipt.success, false);
  assert.strictEqual(bigintReceipt.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);

  // Positional signature must be equally throw-safe
  let positionalReceipt;
  assert.doesNotThrow(() => {
    positionalReceipt = bus.sendMessage('alice', 'bob', circular);
  });
  assert.strictEqual(positionalReceipt.success, false);
  assert.strictEqual(positionalReceipt.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);

  // Rejected payloads must not leave partial delivery or audit state
  assert.strictEqual(bus.getUnreadCount('bob'), 0);
  assert.strictEqual(bus.getAuditLog().length, 0);
});

test('17. [AC-BUS-17] Legacy Alias Surface Resolves to Canonical Behavior', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('alice');
  bus.registerAgent('bob');
  bus.registerAgent('carol');

  bus.sendMessage({ from: 'alice', to: 'bob', content: 'First' });
  bus.sendMessage({ from: 'carol', to: 'bob', content: 'Second' });

  // listInbox pagination aliases: skip (offset), max/count/pageSize/page_size (limit)
  assert.deepStrictEqual(
    bus.listInbox('bob', { skip: 1, max: 1 }).map(h => h.from),
    ['carol']
  );
  assert.deepStrictEqual(
    bus.listInbox('bob', { count: 1 }).map(h => h.from),
    ['alice']
  );
  assert.deepStrictEqual(
    bus.listInbox('bob', { pageSize: 1 }).map(h => h.from),
    ['alice']
  );
  assert.deepStrictEqual(
    bus.listInbox('bob', { page_size: 1 }).map(h => h.from),
    ['alice']
  );

  // readMessage bare boolean options argument (markAsRead override)
  const peek = bus.readMessage('bob', bus.listInbox('bob')[0].id, false);
  assert.strictEqual(peek.success, true);
  assert.strictEqual(peek.message.read, false);
  assert.strictEqual(bus.getUnreadCount('bob'), 2);

  // getArchive pagination aliases and after (since) alias
  bus.drainInbox('bob');
  assert.deepStrictEqual(
    bus.getArchive('bob', { skip: 1, count: 1 }).map(m => m.content),
    ['Second']
  );
  assert.deepStrictEqual(
    bus.getArchive('bob', { pageSize: 1 }).map(m => m.content),
    ['First']
  );
  assert.strictEqual(bus.getArchive('bob', { after: 0 }).length, 2);
  assert.strictEqual(bus.getArchive('bob', { after: Date.now() + 60000 }).length, 0);

  // waitForMail aliases: from_agent/sender_id (senders), markRead, after
  bus.sendMessage({ from: 'alice', to: 'bob', content: 'Alias mail' });
  const waitFromAgent = await bus.waitForMail({
    recipient: 'bob',
    from_agent: 'alice',
    markRead: false,
    after: 0,
    timeout_ms: 20
  });
  assert.strictEqual(waitFromAgent.success, true);
  assert.strictEqual(waitFromAgent.timedOut, false);
  assert.strictEqual(waitFromAgent.count, 1);
  assert.strictEqual(waitFromAgent.messages[0].content, 'Alias mail');
  assert.strictEqual(bus.getUnreadCount('bob'), 1);

  const waitSenderId = await bus.waitForMail({
    recipient: 'bob',
    sender_id: 'carol',
    timeout_ms: 20
  });
  assert.strictEqual(waitSenderId.timedOut, true);
  assert.strictEqual(waitSenderId.count, 0);

  // inlineFileInMessage recipient and message aliases
  const vfs = new VirtualFS();
  vfs.writeFile('/alias.txt', 'Inline alias body', { workspaceId: 'alice', callerAgentId: 'alice' });

  const inlineRecipientId = await bus.inlineFileInMessage({
    path: '/alias.txt',
    recipient_id: 'bob',
    from: 'alice',
    body: 'Alias caption'
  }, { virtualFs: vfs, callerAgentId: 'alice' });
  assert.strictEqual(inlineRecipientId.success, true);
  assert.strictEqual(inlineRecipientId.to, 'bob');
  const inlineRead = bus.readMessage('bob', inlineRecipientId.messageId);
  assert.ok(inlineRead.message.content.includes('Alias caption'));

  const inlineTargetAgentId = await bus.inlineFileInMessage({
    file_path: '/alias.txt',
    target_agent_id: 'bob',
    from: 'alice',
    text: 'Target alias caption'
  }, { virtualFs: vfs, callerAgentId: 'alice' });
  assert.strictEqual(inlineTargetAgentId.success, true);
  assert.strictEqual(inlineTargetAgentId.to, 'bob');
});

test('18. [ICD-A 4fee390] Persisted envelope success survives snapshots and public projections', () => {
  let seq = 0;
  const bus = new MessagingBus({ idGenerator: () => `msg_fixed_${++seq}` });
  bus.registerAgent('alice');
  bus.registerAgent('bob');

  const direct = bus.sendMessage({ from: 'alice', to: 'bob', content: 'Direct delivery' });
  assert.strictEqual(direct.success, true);
  bus.drainInbox('bob');
  const broadcast = bus.sendMessage({ from: 'alice', to: 'all', content: 'Broadcast delivery' });
  assert.strictEqual(broadcast.success, true);

  const snapshot = bus.exportSnapshot();

  // Runtime assertion on serialized keys: every persisted envelope carries a boolean `success`.
  const serialized = JSON.parse(JSON.stringify(snapshot));
  const persistedEnvelopes = [
    ...serialized.auditLog,
    ...serialized.activeQueues.bob,
    ...serialized.archives.bob
  ];
  assert.ok(persistedEnvelopes.length >= 4, 'expected envelopes across auditLog/activeQueues/archives');
  for (const env of persistedEnvelopes) {
    assert.strictEqual(typeof env.success, 'boolean', `persisted envelope '${env.id}' must expose boolean success`);
  }

  // Round-trip preserves the delivery status on every public envelope surface.
  const restored = new MessagingBus();
  restored.importSnapshot(serialized);
  assert.strictEqual(restored.getUnreadCount('bob'), 1);
  assert.deepStrictEqual(restored.getAuditLog().map(m => m.success), [true, true]);
  const queuedHeader = restored.listInbox('bob')[0];
  const readResult = restored.readMessage('bob', queuedHeader.id);
  assert.strictEqual(readResult.success, true);
  assert.strictEqual(readResult.message.success, true);
  assert.strictEqual(restored.getArchive('bob')[0].success, true);

  // Legacy snapshots that omit `success` default to `true` (a persisted envelope was delivered);
  // an explicitly persisted failure record survives restore as `false`.
  const legacy = new MessagingBus();
  legacy.importSnapshot({
    auditLog: [{ id: 'legacy_audit', from: 'alice', to: 'bob', content: 'Legacy audit', timestamp: 1 }],
    activeQueues: { bob: [{ id: 'legacy_unread', from: 'alice', to: 'bob', content: 'Legacy unread', timestamp: 2 }] },
    archives: {
      bob: [
        { id: 'legacy_read', from: 'alice', to: 'bob', content: 'Legacy read', timestamp: 3, success: false }
      ]
    },
    registeredAgents: { bob: { mode: 'queued', privileged: false } },
    terminatedAgents: []
  });

  assert.strictEqual(legacy.getAuditLog()[0].success, true);
  assert.strictEqual(legacy.drainInbox('bob')[0].success, true);
  assert.strictEqual(legacy.getArchive('bob')[0].success, false);
});

test('19. [ICD-A ea6d16e] getArchive preserves persisted broadcast/recipients envelope markers', () => {
  const bus = new MessagingBus();
  bus.registerAgent('sender');
  bus.registerAgent('bob');
  bus.registerAgent('carol');

  const broadcast = bus.sendMessage({ from: 'sender', to: 'all', content: 'Roll call' });
  assert.strictEqual(broadcast.broadcast, true);
  assert.deepStrictEqual([...broadcast.recipients].sort(), ['bob', 'carol']);

  bus.drainInbox('bob');
  const archived = bus.getArchive('bob');
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(archived[0].broadcast, true);
  assert.ok(Array.isArray(archived[0].recipients));
  assert.deepStrictEqual([...archived[0].recipients].sort(), ['bob', 'carol']);
  assert.strictEqual(archived[0].success, true);

  // Defensive copy: mutating a projected recipient list cannot corrupt persisted archive state.
  archived[0].recipients.push('intruder');
  assert.deepStrictEqual([...bus.getArchive('bob')[0].recipients].sort(), ['bob', 'carol']);

  // Point-to-point envelopes keep their narrow shape and do not gain broadcast markers.
  bus.sendMessage({ from: 'sender', to: 'bob', content: 'Direct delivery' });
  bus.drainInbox('bob');
  const direct = bus.getArchive('bob').find(m => m.content === 'Direct delivery');
  assert.strictEqual(direct.broadcast, undefined);
  assert.strictEqual(direct.recipients, undefined);
  assert.strictEqual(direct.success, true);

  // The `success` contract from 4fee390 stays intact alongside the new projection fields.
  const legacy = new MessagingBus();
  legacy.importSnapshot({
    auditLog: [],
    activeQueues: {},
    archives: {
      bob: [{ id: 'legacy_failed', from: 'sender', to: 'bob', content: 'Failed', timestamp: 1, success: false }]
    },
    registeredAgents: { bob: { mode: 'queued', privileged: false } },
    terminatedAgents: []
  });
  const failed = legacy.getArchive('bob')[0];
  assert.strictEqual(failed.success, false);
  assert.strictEqual('broadcast' in failed, false);
  assert.strictEqual('recipients' in failed, false);
});

test('20. [MOD-21 W8-D] Context identity outranks caller payload routing and sender fields', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('agent_victim');
  bus.registerAgent('mallory');
  bus.registerAgent('bob');
  bus.sendMessage({ from: 'director', to: 'agent_victim', content: 'TOP-SECRET victim mail' });
  const victimId = bus.listInbox('agent_victim')[0].id;
  const ctx = { callerAgentId: 'mallory' };

  assert.deepStrictEqual(bus.listInbox({ recipient: 'agent_victim' }, ctx), []);
  assert.strictEqual(bus.readMessage({ agentId: 'agent_victim', message_id: victimId }, ctx).success, false);
  assert.deepStrictEqual(bus.drainInbox({ recipient: 'agent_victim' }, ctx), []);
  assert.deepStrictEqual(bus.getArchive({ recipient: 'agent_victim' }, ctx), []);

  const wait = await bus.waitForMail({ recipient: 'agent_victim', timeout_ms: 0 }, ctx);
  assert.strictEqual(wait.messages.length, 0);
  assert.strictEqual(bus.getUnreadCount('agent_victim'), 1, 'victim unread queue must be untouched');

  const spoof = bus.sendMessage({ from: 'director', to: 'agent_victim', content: 'spoof' }, ctx);
  assert.strictEqual(spoof.from, 'mallory', 'context sender must win over payload from');

  const vfs = new VirtualFS();
  vfs.writeFile('/report.md', 'body', { workspaceId: 'mallory', callerAgentId: 'mallory' });
  const inlined = await bus.inlineFileInMessage(
    { file_path: '/report.md', recipient: 'agent_victim', from: 'director' },
    { callerAgentId: 'mallory', virtualFs: vfs }
  );
  assert.strictEqual(inlined.from, 'mallory', 'context sender must own the inlined message');

  // Documented direct-API fallbacks remain valid when no context binds a caller.
  assert.ok(bus.listInbox({ recipient: 'agent_victim' }).length >= 1);
  assert.strictEqual(bus.sendMessage({ from: 'bob', to: 'mallory', content: 'direct' }).from, 'bob');
});

test('21. [Realm wave A 7387ce1] identity-projection realm scope: cross-realm denial, bypass reachability, filtered broadcast', () => {
  const identityPort = {
    getAgentIdentity: (agentId) => {
      if (agentId === 'director') return { id: agentId, realmBypass: true };
      if (agentId === 'alpha_member') return { id: agentId, realmId: 'alpha' };
      if (agentId === 'alpha_peer') return { id: agentId, realmId: 'alpha' };
      if (agentId === 'beta_member') return { id: agentId, realmId: 'beta' };
      return { id: agentId };
    }
  };

  const bus = new MessagingBus({ identityPort });
  for (const agentId of ['alpha_member', 'alpha_peer', 'beta_member', 'director', 'legacy_agent']) {
    bus.registerAgent(agentId);
  }

  // Cross-realm direct send denies fail-closed with no delivery/archive.
  const denied = bus.sendMessage({ from: 'alpha_member', to: 'beta_member', content: 'denied' });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(bus.getUnreadCount('beta_member'), 0);
  assert.deepStrictEqual(bus.getAuditLog(), []);

  // Same-realm delivery and one-way bypass reachability (Realm wave R,
  // ticket cf0e127): a bypass sender reaches any realm, while a realm sender
  // can never address the system-scope director (no reply path).
  assert.strictEqual(bus.sendMessage({ from: 'alpha_member', to: 'alpha_peer', content: 'in realm' }).success, true);
  const toDirector = bus.sendMessage({ from: 'alpha_member', to: 'director', content: 'to director' });
  assert.strictEqual(toDirector.success, false);
  assert.strictEqual(toDirector.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(bus.getUnreadCount('director'), 0);
  assert.strictEqual(bus.sendMessage({ from: 'director', to: 'beta_member', content: 'to beta' }).success, true);

  // Fan-out is filtered to same-realm members only (no bypass recipients).
  const broadcast = bus.sendMessage({ from: 'alpha_member', to: 'all', content: 'alpha broadcast' });
  assert.deepStrictEqual([...broadcast.recipients].sort(), ['alpha_peer']);
  assert.strictEqual(bus.getUnreadCount('beta_member'), 1, "only the director's direct bypass send reached beta");
  assert.strictEqual(bus.getUnreadCount('legacy_agent'), 0);
  assert.deepStrictEqual(bus.listInbox('legacy_agent'), []);

  // Payload/metadata realm claims are inert for a realm-bound sender.
  const claimed = bus.sendMessage({
    from: 'alpha_member',
    to: 'beta_member',
    content: 'claimed',
    realmId: 'beta',
    metadata: { realmId: 'beta', realmBypass: true }
  });
  assert.strictEqual(claimed.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // Legacy parity: an ungrouped bus keeps full fan-out.
  const plain = new MessagingBus();
  plain.registerAgent('agent_a');
  plain.registerAgent('agent_b');
  assert.strictEqual(plain.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'legacy' }).success, true);
  assert.deepStrictEqual([...plain.sendMessage({ from: 'agent_a', to: 'all', content: 'legacy all' }).recipients].sort(), ['agent_b']);
});

