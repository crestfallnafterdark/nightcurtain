/**
 * @file tests/audit/repros/bdc5cee.test.js
 * @description Audit repro for ticket bdc5cee (Major; MOD-21 W10-B):
 * the messaging substrate still implements the pre-W9-A identity rule at every
 * bus identity/routing site (`resolveContextCallerId(context) || <payload
 * identity>`), so a context object that is supplied but binds no caller (an
 * anonymous dispatcher binds `callerAgentId: null`) re-admits caller-payload
 * identity. An anonymous dispatcher with an explicit allowlist can therefore
 * list/read/consume another agent's private mailbox, send messages as another
 * agent, and — via `inline_file_in_message` — turn the payload identity into a
 * VirtualFS read identity.
 *
 * Contract under test: a payload identity is never promoted when a context
 * object is present (even one that binds no caller); the payload fallback
 * survives only for genuinely contextless direct-API calls. A bound dispatcher
 * ignores payload routing/sender keys entirely.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/bdc5cee.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

const VICTIM_MAIL = 'TOP-SECRET victim mail';
const VICTIM_SECRET = 'victim-secret-token';

/**
 * Builds an isolated fixture: a victim mailbox with one unread message, a
 * victim private workspace with one secret file, and a global report file.
 * @returns {{ bus: MessagingBus, vfs: VirtualFS }}
 */
function createFixture() {
  const bus = new MessagingBus();
  bus.registerAgent('victim');
  bus.registerAgent('mallory');
  bus.registerAgent('director');
  bus.sendMessage({ from: 'director', to: 'victim', content: VICTIM_MAIL });

  const vfs = new VirtualFS();
  vfs.writeFile({ filePath: '/secret.txt', content: VICTIM_SECRET, workspaceId: 'victim', callerAgentId: 'victim' });
  vfs.writeFile({ filePath: '/report.md', content: 'global report body', workspaceId: 'global' });

  return { bus, vfs };
}

/**
 * Builds an anonymous dispatcher with an explicit allowlist (the documented
 * in-scope shape) over the fixture substrates.
 * @param {MessagingBus} bus
 * @param {VirtualFS} vfs
 * @returns {Function}
 */
function createAnonymousDispatcher(bus, vfs) {
  return createSandboxToolDispatcher({
    virtualFs: vfs,
    messagingBus: bus,
    allowedTools: ['*']
  });
}

/**
 * Builds a dispatcher bound to `mallory` over the fixture substrates.
 * @param {MessagingBus} bus
 * @param {VirtualFS} vfs
 * @returns {Function}
 */
function createBoundDispatcher(bus, vfs) {
  return createSandboxToolDispatcher({
    virtualFs: vfs,
    messagingBus: bus,
    agentId: 'mallory',
    allowedTools: ['*']
  });
}

test('RED: anonymous dispatcher must not read a foreign mailbox via payload recipient', async () => {
  const { bus, vfs } = createFixture();
  const anon = createAnonymousDispatcher(bus, vfs);

  const r = await anon.executeTool('list_inbox', { recipient: 'victim' });
  assert.equal(r.success, true);
  assert.ok(!JSON.stringify(r).includes('TOP-SECRET'), 'victim mail must never leak');
});

test('RED: anonymous dispatcher must not spoof sender via payload from', async () => {
  const { bus, vfs } = createFixture();
  const anon = createAnonymousDispatcher(bus, vfs);

  const r = await anon.executeTool('send_message', { recipient: 'mallory', message: 'spoofed', from: 'victim' });
  assert.equal(r.success, true);
  assert.notEqual(r.from, 'victim', 'anonymous sender must not be payload-selectable');
});

test('RED: an empty trusted context must not promote payload identity into the VFS read', async () => {
  const { bus, vfs } = createFixture();

  const r = await bus.inlineFileInMessage(
    { filePath: '/secret.txt', recipient: 'mallory', from: 'victim', workspaceId: 'victim', virtualFs: vfs },
    {}
  );
  assert.equal(r.success, false, 'payload identity must not read a foreign private workspace');
  assert.ok(!JSON.stringify(r).includes(VICTIM_SECRET), 'secret must never be inlined');
});

test('RED: anonymous dispatcher must not consume or archive a foreign mailbox', async () => {
  const { bus, vfs } = createFixture();
  const anon = createAnonymousDispatcher(bus, vfs);

  const victimMsgId = bus.listInbox('victim')[0].id;

  const read = await anon.executeTool('read_message', { recipient: 'victim', message_id: victimMsgId });
  assert.ok(!JSON.stringify(read).includes(VICTIM_MAIL), 'read_message must never leak victim mail');

  const archive = await anon.executeTool('get_archive', { recipient: 'victim' });
  assert.ok(!JSON.stringify(archive).includes(VICTIM_MAIL), 'get_archive must never leak victim mail');

  const wait = await anon.executeTool('wait_for_mail', { recipient: 'victim', timeout_ms: 0 });
  assert.ok(!JSON.stringify(wait).includes(VICTIM_MAIL), 'wait_for_mail must never leak victim mail');

  assert.equal(bus.getUnreadCount('victim'), 1, 'victim unread queue must be untouched');
});

test('RED: anonymous dispatcher must not inline as a payload-selected sender', async () => {
  const { bus, vfs } = createFixture();
  const anon = createAnonymousDispatcher(bus, vfs);

  const r = await anon.executeTool('inline_file_in_message', {
    file_path: '/report.md',
    recipient: 'mallory',
    from: 'victim'
  });
  assert.equal(r.success, false, 'inlining requires a bound caller identity');
  assert.notEqual(r.from, 'victim', 'payload identity must never own the inlined message');
});

test('bdc5cee control: a dispatcher bound to mallory ignores payload routing and sender', async () => {
  const { bus, vfs } = createFixture();
  const bound = createBoundDispatcher(bus, vfs);

  const list = await bound.executeTool('list_inbox', { recipient: 'victim' });
  assert.ok(JSON.stringify(list).includes('result'), 'bound list_inbox returns its own mailbox projection');
  assert.ok(!JSON.stringify(list).includes('TOP-SECRET'), 'bound mailbox must not read the victim mailbox');

  const send = await bound.executeTool('send_message', { recipient: 'victim', message: 'spoof', from: 'victim' });
  assert.equal(send.success, true);
  assert.equal(send.from, 'mallory', 'bound sender must win over payload from');

  const inline = await bound.executeTool('inline_file_in_message', {
    file_path: '/report.md',
    recipient: 'victim',
    from: 'victim'
  });
  assert.equal(inline.success, true);
  assert.equal(inline.from, 'mallory', 'bound sender owns the inlined message');

  const victimUnreadBeforeWait = bus.getUnreadCount('victim');
  const wait = await bound.executeTool('wait_for_mail', { recipient: 'victim', timeout_ms: 0 });
  assert.ok(!JSON.stringify(wait).includes('TOP-SECRET'), 'bound wait_for_mail must not drain the victim mailbox');
  assert.equal(bus.getUnreadCount('victim'), victimUnreadBeforeWait, 'victim unread queue must be untouched by bound wait_for_mail');
});

test('bdc5cee control: contextless direct-API object calls keep the payload identity channel', () => {
  const { bus } = createFixture();

  assert.ok(bus.listInbox({ recipient: 'victim' }).length >= 1, 'contextless direct reads keep legacy payload routing');
  assert.equal(bus.sendMessage({ from: 'director', to: 'mallory', content: 'direct' }).from, 'director');
});
