/**
 * @file tests/integration/tool_mailbox_realm_resolution_test.js
 * @description Tickets 5b5fe63 + 636ca85 — realm-exact mailbox resolution
 *   through the Tool Gateway and truthful results/receipts:
 *   1. With the same bare id (`scout`) registered in two realms, all four
 *      mailbox verbs (`get_inbox`, `list_inbox`, `read_message`,
 *      `drain_inbox`) executed through realm-bound dispatchers hit the
 *      caller's canonical `(realmId, agentId)` partition — never the empty
 *      bare-id partition and never the other realm.
 *   2. The header-only `get_inbox` mode makes no full-contents claim: the
 *      delivery note says headers/previews only, the payload carries bounded
 *      snippets (no `content`), and the tool description names the preview.
 *   3. `get_inbox {mark_as_read:true}` / `drain_inbox` receipts match the
 *      post-state: the canonical unread count is 0 after the call, the other
 *      realm stays untouched.
 *
 * Zero-Mock Verification: a real `AgentRuntime` (real registry, real identity
 * port, real bus bridge) with the repo's deterministic in-memory provider
 * stub, which never executes a turn. The bus identity bridge mirrors the
 * store composition root (late-bound runtime identity port).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { getInboxDescriptor } from '../../src/lib/sandbox/tools/descriptors/index.ts';

const ALPHA_REALM = 'realm_mailbox_alpha';
const BETA_REALM = 'realm_mailbox_beta';
const MAILBOX_TOOLS = ['get_inbox', 'drain_inbox', 'list_inbox', 'read_message'];

/**
 * Deterministic in-memory model accepted by `launchAgent` (the repo's standard
 * provider stub): the runtime, identity port and messaging bus stay real, and
 * this fixture never executes a turn.
 *
 * @param {string} output - Final assistant text for every turn.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output = 'acknowledged') {
  return {
    id: 'mailbox-realm-deterministic-model',
    config: {},
    provider: {
      id: 'mailbox-realm-deterministic-provider',
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: 'mailbox-realm-deterministic-model', name: 'Mailbox Realm Model' }]
    },
    async *stream(options = {}) {
      if (typeof options.onChunk === 'function') options.onChunk(output);
      yield { type: 'text', content: output };
      yield { type: 'finish', finishReason: 'stop', content: output, reasoning: '', toolCalls: [] };
    },
    async complete() {
      return { role: 'assistant', content: output };
    }
  };
}

/**
 * Composes the real runtime and the real bus the way the store composition
 * root does: a late-bound identity bridge hands the bus the runtime's frozen
 * `AgentIdentityPort` once the runtime exists. Launches one `scout` per realm
 * plus one same-realm peer per realm, then registers each agent's canonical
 * `(realmId, agentId)` key on the bus (the wiring-lane registration contract).
 *
 * @returns {Promise<{runtime: object, bus: object, identityPort: object, keys: object}>} Real fixture.
 */
async function createRealmMailboxFixture() {
  let identityPort = null;
  const bridge = {
    getAgentIdentity: (agentId, scope) => (identityPort ? identityPort.getAgentIdentity(agentId, scope) : null),
    listAgentIdentities: (scope) => (identityPort ? identityPort.listAgentIdentities(scope) : [])
  };
  const bus = new MessagingBus({ identityPort: bridge });
  const runtime = new AgentRuntime({ messagingBus: bus, autoBootstrapDirector: false });
  identityPort = runtime.createAgentIdentityPort();

  const model = createDeterministicModel();
  await runtime.launchAgent({ id: 'scout', realmId: ALPHA_REALM, allowedTools: [...MAILBOX_TOOLS] }, model);
  await runtime.launchAgent({ id: 'scout', realmId: BETA_REALM, allowedTools: [...MAILBOX_TOOLS] }, model);
  await runtime.launchAgent({ id: 'alpha_peer', realmId: ALPHA_REALM, allowedTools: ['read_file'] }, model);
  await runtime.launchAgent({ id: 'beta_peer', realmId: BETA_REALM, allowedTools: ['read_file'] }, model);

  const alphaScout = identityPort.getAgentIdentity('scout', { realmId: ALPHA_REALM });
  const betaScout = identityPort.getAgentIdentity('scout', { realmId: BETA_REALM });
  const alphaPeer = identityPort.getAgentIdentity('alpha_peer', { realmId: ALPHA_REALM });
  const betaPeer = identityPort.getAgentIdentity('beta_peer', { realmId: BETA_REALM });
  assert.ok(alphaScout && betaScout && alphaPeer && betaPeer, 'fixture: every real registration must resolve through the runtime identity port');
  assert.notEqual(alphaScout.key, betaScout.key, 'fixture: the same literal id in two realms has two registrations');

  // The wiring-lane registration contract: canonical keys, never bare ids.
  for (const projection of [alphaScout, betaScout, alphaPeer, betaPeer]) {
    bus.registerAgent(projection.key);
  }

  return { runtime, bus, identityPort, keys: { alphaScout, betaScout, alphaPeer, betaPeer } };
}

/**
 * Builds a dispatcher bound to one realm's `scout` exactly as the turn engine
 * supplies it (agent id + Realm scope; canonical key resolved internally).
 *
 * @param {object} runtime - Live runtime.
 * @param {string} realmId - Bound Realm scope.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, realmId) {
  return createSandboxToolDispatcher({
    runtime,
    agentId: 'scout',
    realmId,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    allowedTools: [...MAILBOX_TOOLS]
  });
}

/**
 * Delivers one in-realm message to the sender realm's `scout` through the real
 * bus (trusted canonical sender key, realm-local bare recipient).
 *
 * @param {object} bus - Real messaging bus.
 * @param {object} sender - Sender identity projection.
 * @param {string} content - Message body.
 * @returns {object} Send receipt.
 */
function deliver(bus, sender, content) {
  return bus.sendMessage(
    { from: sender.id, to: 'scout', content },
    { callerAgentId: sender.id, callerKey: sender.key }
  );
}

// ============================================================================
// 1. All four verbs resolve the caller's canonical partition
// ============================================================================

test('1. same bare id in two realms: all four mailbox verbs hit the caller canonical partition', async () => {
  const { runtime, bus, keys } = await createRealmMailboxFixture();
  const { alphaScout, betaScout, alphaPeer, betaPeer } = keys;
  try {
    const alphaDispatcher = dispatcherFor(runtime, ALPHA_REALM);
    const betaDispatcher = dispatcherFor(runtime, BETA_REALM);

    const alphaContent = 'alpha partition payload';
    const betaContent = 'beta partition payload';
    assert.equal(deliver(bus, alphaPeer, alphaContent).success, true);
    assert.equal(deliver(bus, betaPeer, betaContent).success, true);
    assert.equal(bus.getUnreadCount(alphaScout.key), 1);
    assert.equal(bus.getUnreadCount(betaScout.key), 1);

    // get_inbox (header mode): the alpha-bound caller must see its own mail.
    const alphaHeaders = await alphaDispatcher.executeTool('get_inbox', {});
    assert.equal(alphaHeaders.success, true);
    assert.equal(alphaHeaders.count, 1, 'get_inbox must resolve the alpha canonical partition');
    assert.equal(alphaHeaders.messages[0].from, 'alpha_peer');
    assert.ok(!String(alphaHeaders.messages[0].snippet).includes('beta'));
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the beta partition stays untouched');

    // list_inbox control path.
    const alphaList = await alphaDispatcher.executeTool('list_inbox', {});
    assert.equal(alphaList.length, 1);
    assert.equal(alphaList[0].from, 'alpha_peer');

    // read_message control path (peek: no consumption).
    const peek = await alphaDispatcher.executeTool('read_message', {
      message_id: alphaList[0].id,
      mark_as_read: false
    });
    assert.equal(peek.success, true);
    assert.equal(peek.message.content, alphaContent);
    assert.equal(bus.getUnreadCount(alphaScout.key), 1, 'a peek never consumes');

    // drain_inbox: must consume the alpha partition only.
    const drained = await alphaDispatcher.executeTool('drain_inbox', {});
    assert.equal(drained.success, true);
    assert.equal(drained.count, 1, 'drain_inbox must resolve the alpha canonical partition');
    assert.equal(drained.messages[0].content, alphaContent);
    assert.equal(bus.getUnreadCount(alphaScout.key), 0);
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the beta partition stays untouched');

    // The beta-bound dispatcher (same bare id) sees only beta's partition.
    const betaHeaders = await betaDispatcher.executeTool('get_inbox', {});
    assert.equal(betaHeaders.success, true);
    assert.equal(betaHeaders.count, 1, 'the beta-bound caller reads the beta canonical partition');
    assert.equal(betaHeaders.messages[0].from, 'beta_peer');
    assert.ok(!String(betaHeaders.messages[0].snippet).includes('alpha'));
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Header-only get_inbox must not claim full contents
// ============================================================================

test('2. header-only get_inbox makes no full-contents claim', async () => {
  const { runtime, bus, keys } = await createRealmMailboxFixture();
  const { alphaScout, alphaPeer } = keys;
  try {
    const alphaDispatcher = dispatcherFor(runtime, ALPHA_REALM);
    const longContent = `${'A'.repeat(200)} trailing detail beyond the preview`;
    assert.equal(deliver(bus, alphaPeer, longContent).success, true);

    const result = await alphaDispatcher.executeTool('get_inbox', {});
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    const header = result.messages[0];
    assert.equal('content' in header, false, 'header-only get_inbox must not carry full contents');
    assert.equal('message' in header, false, 'header-only get_inbox must not carry envelopes');
    assert.ok(header.snippet.length <= 83, `the snippet is a bounded preview; got ${header.snippet.length}`);
    assert.ok(header.snippet.length < longContent.length, 'the preview is shorter than the message');
    assert.match(String(result.deliveryNote), /header|preview/i, 'the delivery note must name the header/preview shape');
    assert.doesNotMatch(
      String(result.deliveryNote),
      /full contents|delivered in full|in full/i,
      'a header-only result must not claim to deliver full contents'
    );
    assert.equal(bus.getUnreadCount(alphaScout.key), 1, 'header mode must not consume mail');

    // The descriptor description must point the model at the preview shape and
    // the mark-as-read mode that does return full contents.
    assert.match(String(getInboxDescriptor.description), /preview|header/i, 'the description must name the preview shape');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Mark/drain receipts match the post-state
// ============================================================================

test('3. mark/drain receipts match post-state (unread 0)', async () => {
  const { runtime, bus, keys } = await createRealmMailboxFixture();
  const { alphaScout, betaScout, alphaPeer, betaPeer } = keys;
  try {
    const alphaDispatcher = dispatcherFor(runtime, ALPHA_REALM);
    assert.equal(deliver(bus, alphaPeer, 'alpha marked mail').success, true);
    assert.equal(deliver(bus, betaPeer, 'beta unread mail').success, true);

    // get_inbox {mark_as_read:true}: full contents, consumed, archived read.
    const marked = await alphaDispatcher.executeTool('get_inbox', { mark_as_read: true });
    assert.equal(marked.success, true);
    assert.equal(marked.count, 1);
    assert.equal(marked.messages[0].content, 'alpha marked mail');
    assert.match(String(marked.deliveryNote), /marked as read/i);
    assert.equal(
      bus.getUnreadCount(alphaScout.key),
      0,
      'the mark receipt claims consumption; the canonical post-state must agree'
    );
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the other realm stays untouched');
    const archived = bus.getArchive(alphaScout.key);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].read, true, 'consumed mail lands in the canonical archive as read');

    // drain_inbox: same post-state contract.
    assert.equal(deliver(bus, alphaPeer, 'alpha drained mail').success, true);
    const drained = await alphaDispatcher.executeTool('drain_inbox', {});
    assert.equal(drained.success, true);
    assert.equal(drained.count, 1);
    assert.equal(drained.messages[0].content, 'alpha drained mail');
    assert.match(String(drained.deliveryNote), /drained/i);
    assert.equal(
      bus.getUnreadCount(alphaScout.key),
      0,
      'the drain receipt claims consumption; the canonical post-state must agree'
    );
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the other realm stays untouched');
  } finally {
    runtime.destroy();
  }
});
