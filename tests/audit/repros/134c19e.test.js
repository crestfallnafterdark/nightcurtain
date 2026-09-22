/**
 * @file tests/audit/repros/134c19e.test.js
 * @description Audit repro for ticket 134c19e (Critical; MOD-21 post-release
 * substrate audit, bus leg): `MessagingBus` resolved mailbox routing and sender
 * identity from caller-controlled payload fields before consulting the trusted
 * execution context, so any agent could list/read/drain/archive another agent's
 * mailbox and send messages that appeared to come from another agent.
 *
 * Ratified MOD-21 W8-D fix: context identity (`callerAgentId`/`agentId`) wins;
 * payload `agentId`/`recipient`/`from`/`sender` are fallbacks used only when the
 * context binds no caller (direct-API/keyless calls), and are ignored when it
 * does. Red before the fix; green after.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/134c19e.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

const SECRET = 'TOP-SECRET victim mail';

function buildSeededBus() {
  const bus = new MessagingBus();
  bus.registerAgent('agent_victim');
  bus.registerAgent('mallory');
  bus.sendMessage({ from: 'director', to: 'agent_victim', content: SECRET });
  return bus;
}

function buildDispatcher(bus, vfs) {
  const dispatch = createSandboxToolDispatcher({
    messagingBus: bus,
    virtualFs: vfs,
    agentId: 'mallory',
    allowedTools: ['*']
  });
  return (name, args) => dispatch({ function: { name, arguments: JSON.stringify(args) } });
}

test('134c19e: raw listInbox resolves context identity, not payload recipient', () => {
  const bus = buildSeededBus();
  const leaked = bus.listInbox({ recipient: 'agent_victim' }, { callerAgentId: 'mallory' });
  assert.deepEqual(leaked, [], 'payload recipient must not select the victim mailbox');
});

test('134c19e: raw readMessage resolves context identity, not payload recipient', () => {
  const bus = buildSeededBus();
  const victimId = bus.listInbox('agent_victim')[0].id;
  const read = bus.readMessage(
    { agentId: 'agent_victim', message_id: victimId },
    { callerAgentId: 'mallory' }
  );
  assert.equal(read.success, false, 'payload agentId must not select the victim mailbox');
});

test('134c19e: raw drainInbox resolves context identity, not payload recipient', () => {
  const bus = buildSeededBus();
  const drained = bus.drainInbox({ recipient: 'agent_victim' }, { callerAgentId: 'mallory' });
  assert.deepEqual(drained, [], 'payload recipient must not drain the victim mailbox');
  assert.equal(bus.getUnreadCount('agent_victim'), 1, 'victim mail must remain unconsumed');
});

test('134c19e: raw getArchive resolves context identity, not payload recipient', () => {
  const bus = buildSeededBus();
  const victimId = bus.listInbox('agent_victim')[0].id;
  bus.readMessage('agent_victim', victimId);
  const archive = bus.getArchive({ recipient: 'agent_victim' }, { callerAgentId: 'mallory' });
  assert.deepEqual(archive, [], 'payload recipient must not select the victim archive');
});

test('134c19e: raw waitForMail resolves context identity, not payload recipient', async () => {
  const bus = buildSeededBus();
  const wait = await bus.waitForMail({ recipient: 'agent_victim', timeout_ms: 0 }, { callerAgentId: 'mallory' });
  assert.equal(wait.messages.length, 0, 'payload recipient must not consume the victim queue');
  assert.equal(bus.getUnreadCount('agent_victim'), 1, 'victim unread queue must be untouched');
});

test('134c19e: raw sendMessage resolves context sender, not payload from/sender', () => {
  const bus = buildSeededBus();
  const receipt = bus.sendMessage(
    { from: 'director', to: 'agent_victim', content: 'I am the director' },
    { callerAgentId: 'mallory' }
  );
  assert.equal(receipt.success, true);
  assert.equal(receipt.from, 'mallory', 'payload from must not spoof the context sender');

  const spoofAlias = bus.sendMessage(
    { sender: 'director', to: 'agent_victim', content: 'Alias spoof' },
    { callerAgentId: 'mallory' }
  );
  assert.equal(spoofAlias.from, 'mallory', 'payload sender alias must not spoof the context sender');
});

test('134c19e: raw inlineFileInMessage resolves context sender, not payload from', async () => {
  const bus = buildSeededBus();
  const vfs = new VirtualFS();
  vfs.writeFile('/report.md', 'report body', { workspaceId: 'global' });

  const receipt = await bus.inlineFileInMessage(
    { file_path: '/report.md', recipient: 'agent_victim', from: 'director' },
    { callerAgentId: 'mallory', virtualFs: vfs }
  );
  assert.equal(receipt.success, true);
  assert.equal(receipt.from, 'mallory', 'payload from must not spoof the inlined message sender');
});

test('134c19e: dispatcher list_inbox cannot read another mailbox via payload recipient', async () => {
  const bus = buildSeededBus();
  const call = buildDispatcher(bus, new VirtualFS());

  const leaked = await call('list_inbox', { recipient: 'agent_victim' });
  assert.equal(leaked.success, true);
  assert.deepEqual(leaked.result, [], 'dispatcher-bound agent must see only its own inbox');
});

test('134c19e: dispatcher read_message cannot read another mailbox via payload recipient', async () => {
  const bus = buildSeededBus();
  const call = buildDispatcher(bus, new VirtualFS());
  const victimId = bus.listInbox('agent_victim')[0].id;

  const read = await call('read_message', { message_id: victimId, recipient: 'agent_victim' });
  assert.equal(read.success, false, 'dispatcher-bound agent must not read the victim message');
});

test('134c19e: dispatcher get_archive cannot read another mailbox archive via payload recipient', async () => {
  const bus = buildSeededBus();
  const call = buildDispatcher(bus, new VirtualFS());
  const victimId = bus.listInbox('agent_victim')[0].id;
  bus.readMessage('agent_victim', victimId);

  const archive = await call('get_archive', { recipient: 'agent_victim' });
  assert.equal(archive.success, true);
  assert.deepEqual(archive.result, [], 'dispatcher-bound agent must not read the victim archive');
});

test('134c19e: dispatcher wait_for_mail cannot consume another mailbox via payload recipient', async () => {
  const bus = buildSeededBus();
  const call = buildDispatcher(bus, new VirtualFS());

  const wait = await call('wait_for_mail', { recipient: 'agent_victim', timeout_ms: 0 });
  assert.equal(wait.success, true);
  assert.equal(wait.messages.length, 0, 'dispatcher-bound agent must not consume the victim queue');
  assert.equal(bus.getUnreadCount('agent_victim'), 1, 'victim unread queue must be untouched');
});

test('134c19e: dispatcher send_message cannot spoof the sender via payload from', async () => {
  const bus = buildSeededBus();
  const call = buildDispatcher(bus, new VirtualFS());

  const spoof = await call('send_message', { recipient: 'agent_victim', message: 'I am the director', from: 'director' });
  assert.equal(spoof.success, true);
  assert.equal(spoof.from, 'mallory', 'dispatcher-bound sender must win over payload from');

  const victimInbox = bus.listInbox('agent_victim');
  assert.equal(victimInbox[victimInbox.length - 1].from, 'mallory');
});

test('134c19e: dispatcher inline_file_in_message cannot spoof the sender via payload from', async () => {
  const bus = buildSeededBus();
  const vfs = new VirtualFS();
  vfs.writeFile('/report.md', 'report body', { workspaceId: 'global' });
  const call = buildDispatcher(bus, vfs);

  const inlined = await call('inline_file_in_message', {
    file_path: '/report.md',
    recipient: 'agent_victim',
    message: 'attached',
    from: 'director'
  });
  assert.equal(inlined.success, true);
  assert.equal(inlined.from, 'mallory', 'dispatcher-bound sender must win over payload from');
});

test('134c19e: documented direct-API payload fallback still works when no context binds a caller', async () => {
  const bus = buildSeededBus();
  bus.registerAgent('agent_bob');
  bus.registerAgent('agent_alice');

  assert.equal(bus.listInbox({ agentId: 'agent_victim' }).length, 1, 'direct payload agentId must select the mailbox');
  assert.equal(bus.listInbox({ recipient: 'agent_victim' }).length, 1, 'direct payload recipient must select the mailbox');

  const positional = bus.sendMessage('agent_alice', 'agent_bob', 'hello');
  assert.equal(positional.from, 'agent_alice', 'positional sender form is documented direct-API handling');

  const objectForm = bus.sendMessage({ from: 'agent_alice', to: 'agent_bob', content: 'hello' });
  assert.equal(objectForm.from, 'agent_alice', 'contextless payload sender remains valid direct-API handling');
});
