/**
 * @file tests/audit/repros/b87de48.test.js
 * @description Audit repro for ticket b87de48 (Minor, area:security, MOD-21 W11-B):
 * `createMessagingParamSanitizer` omitted alias spellings the bus itself consumes
 * as sender/mailbox selectors (`from_agent`, `fromAgent`, `sender_id`,
 * `senderId`, `senders`, `workspaceId`, `workspace_id`, `targetAgent`,
 * `target_agent`), and `get_inbox`/`drain_inbox` bypassed the messaging scrub
 * entirely with the raw `createParamSanitizer`, so the documented claim that
 * undeclared identity/routing keys "can never reach the bus" was not enforced
 * for all eight messaging descriptors.
 *
 * Evidence: `src/lib/sandbox/tools/descriptors/index.ts` (messaging descriptor
 * definitions; incomplete key set and raw sanitizer call sites).
 *
 * Exact enforced claim after the fix: every messaging descriptor's `sanitize`
 * removes the undeclared identity/mailbox-routing spellings (including the
 * bus-consumed aliases) from the sanitized parameter copy handed to a handler,
 * while declared parameters (`recipient`, the `sender` filter) and their
 * canonical aliases are preserved.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/b87de48.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY } from '../../../src/lib/sandbox/tools/descriptors/index.ts';
import { toSnakeCase } from '../../../src/lib/sandbox/tools/normalizers/index.ts';

const MESSAGING_TOOLS = Object.freeze([
  'send_message',
  'wait_for_mail',
  'list_inbox',
  'read_message',
  'get_archive',
  'inline_file_in_message',
  'get_inbox',
  'drain_inbox'
]);

/** Identity/routing spellings the bus reads as sender/mailbox selectors. */
const IDENTITY_ROUTING_SPELLINGS = Object.freeze([
  'from',
  'from_agent',
  'fromAgent',
  'sender',
  'sender_id',
  'senderId',
  'senders',
  'agentId',
  'agent_id',
  'callerAgentId',
  'caller_agent_id',
  'recipient',
  'recipient_id',
  'recipientId',
  'targetAgentId',
  'target_agent_id',
  'targetAgent',
  'target_agent',
  'workspaceId',
  'workspace_id'
]);

/** Canonical identity-shaped keys each descriptor schema (or declared alias) allows. */
const DECLARED_PARAM_KEYS = Object.freeze({
  send_message: Object.freeze(['recipient']),
  wait_for_mail: Object.freeze(['sender']),
  list_inbox: Object.freeze([]),
  read_message: Object.freeze([]),
  get_archive: Object.freeze([]),
  inline_file_in_message: Object.freeze(['recipient']),
  get_inbox: Object.freeze([]),
  drain_inbox: Object.freeze([])
});

function identityPayload() {
  const raw = {};
  for (const spelling of IDENTITY_ROUTING_SPELLINGS) {
    raw[spelling] = 'victim';
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Red evidence: undeclared alias spellings survive sanitization.
// ---------------------------------------------------------------------------

for (const name of MESSAGING_TOOLS) {
  test(`b87de48: ${name} sanitize drops undeclared identity/routing spellings`, () => {
    const descriptor = TOOL_REGISTRY[name];
    assert.ok(descriptor, `descriptor ${name} must be registered`);

    const declared = new Set(DECLARED_PARAM_KEYS[name]);
    const sanitized = descriptor.sanitize(identityPayload());

    for (const spelling of IDENTITY_ROUTING_SPELLINGS) {
      const normalized = toSnakeCase(spelling);
      if (declared.has(normalized)) continue;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(sanitized, normalized),
        `${name}: undeclared identity/routing key '${normalized}' (from '${spelling}') survived sanitization: ${JSON.stringify(sanitized)}`
      );
    }
  });
}

test('b87de48: ticket repro — send_message alias retention', () => {
  const sanitized = TOOL_REGISTRY.send_message.sanitize({
    from_agent: 'victim',
    sender_id: 'victim',
    senders: ['victim'],
    workspace_id: 'victim'
  });
  assert.deepStrictEqual(sanitized, {}, `send_message retained alias keys: ${JSON.stringify(sanitized)}`);
});

test('b87de48: ticket repro — get_inbox has no scrub at all', () => {
  const sanitized = TOOL_REGISTRY.get_inbox.sanitize({
    caller_agent_id: 'victim',
    agent_id: 'victim'
  });
  assert.deepStrictEqual(sanitized, {}, `get_inbox retained identity keys: ${JSON.stringify(sanitized)}`);
});

test('b87de48: ticket repro — drain_inbox has no scrub at all', () => {
  const sanitized = TOOL_REGISTRY.drain_inbox.sanitize({
    caller_agent_id: 'victim',
    agent_id: 'victim'
  });
  assert.deepStrictEqual(sanitized, {}, `drain_inbox retained identity keys: ${JSON.stringify(sanitized)}`);
});

// ---------------------------------------------------------------------------
// Contract preservation: declared parameters and their canonical aliases work.
// ---------------------------------------------------------------------------

test('b87de48: declared recipient survives direct spelling and canonical aliases', () => {
  for (const name of ['send_message', 'inline_file_in_message']) {
    assert.strictEqual(TOOL_REGISTRY[name].sanitize({ recipient: 'agent_x' }).recipient, 'agent_x');
    for (const alias of ['to', 'targetAgentId', 'target_agent_id', 'recipient_id', 'recipientId']) {
      const out = TOOL_REGISTRY[name].sanitize({ [alias]: 'agent_y' });
      assert.strictEqual(out.recipient, 'agent_y', `${name}: '${alias}' must normalize to declared recipient`);
    }
  }
});

test('b87de48: declared sender filter survives and canonical aliases normalize to it', () => {
  assert.strictEqual(TOOL_REGISTRY.wait_for_mail.sanitize({ sender: 'agent_x' }).sender, 'agent_x');
  for (const alias of ['from', 'sender_id', 'senderId', 'from_agent', 'fromAgent']) {
    const out = TOOL_REGISTRY.wait_for_mail.sanitize({ [alias]: 'agent_y' });
    assert.strictEqual(out.sender, 'agent_y', `wait_for_mail: '${alias}' must normalize to declared sender`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(out, toSnakeCase(alias)),
      `wait_for_mail: '${alias}' must not survive under its own spelling`
    );
  }
});

test('b87de48: non-identity declared parameters are unaffected by the scrub', () => {
  assert.strictEqual(TOOL_REGISTRY.get_inbox.sanitize({ mark_as_read: true }).mark_as_read, true);
  assert.strictEqual(TOOL_REGISTRY.get_inbox.sanitize({ markAsRead: true }).mark_as_read, true);
  assert.strictEqual(TOOL_REGISTRY.send_message.sanitize({ recipient: 'a', message: 'hi' }).message, 'hi');
  assert.strictEqual(TOOL_REGISTRY.inline_file_in_message.sanitize({ file_path: '/f', recipient: 'a' }).file_path, '/f');
  assert.strictEqual(TOOL_REGISTRY.wait_for_mail.sanitize({ timeout_ms: 250 }).timeout_ms, 250);
  assert.strictEqual(TOOL_REGISTRY.list_inbox.sanitize({ limit: 5 }).limit, 5);
  assert.strictEqual(TOOL_REGISTRY.read_message.sanitize({ message_id: 'm1' }).message_id, 'm1');
  assert.strictEqual(TOOL_REGISTRY.get_archive.sanitize({ offset: 2 }).offset, 2);
});
