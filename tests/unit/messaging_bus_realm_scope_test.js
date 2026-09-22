/**
 * @file tests/unit/messaging_bus_realm_scope_test.js
 * @description Realm wave A (ticket 7387ce1) + Wave I realm-local identity
 *   (ticket d57cbc1) verification suite for the MessagingBus Realm ACL:
 *   1. Cross-realm direct sends deny fail-closed (`PERMISSION_DENIED`) with no
 *      mailbox copy and no audit/archive entry; realm-bound wildcard authority
 *      does not escape its realm.
 *   2. Same-realm direct and inline sends deliver normally.
 *   3. Bypass principals (identity-projection `realmBypass`, the engine
 *      principal in the execution context) span realms one-way: they reach any
 *      realm, while a realm agent addressing a bypass subject is denied by
 *      scope (no reply path); forged lookalike principals do not bypass.
 *   4. `to: 'all'` fan-out is filtered to same-realm members (a realm sender
 *      never reaches bypass recipients); counters/archives never disclose
 *      foreign agents.
 *   5. Legacy ungrouped parity (no identity port / projections without realm
 *      fields) is preserved.
 *   6. Forged realm claims in payloads/metadata are ignored.
 *   7. Mailbox reads stay self-scoped.
 *   8. Wave I: a real runtime + real bus keep two realms' same-id agents
 *      distinct — canonical-key registration, realm-local bare-ref resolution,
 *      scoped fan-out, opaque ambiguous denial, and bare-id-only surfaces.
 *
 * Unit level: realm membership is supplied by an injected identity port; the
 * runtime producer wiring lands in Wave A (the projection fields are optional,
 * so the current runtime stays type-compatible). Section 8 instead composes the
 * real `AgentRuntime` (real registry + real identity port) with the real bus
 * through the store-style late-bound bridge; only the model provider is the
 * repo's deterministic in-memory stub (zero-mock verification for the classes
 * under test).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../test_env.js';
import { MessagingBus, MESSAGING_ERROR_CODES } from '../../src/lib/sandbox/messagingBus/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

/**
 * Opaque engine-internal principal injected into the bus (composition-root
 * wiring); only the exact reference marks an engine-principal host call.
 */
const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'realm_bus_operator' });

/**
 * Trusted identity port carrying the Wave A Realm projection: `realmId` binds
 * an agent to a realm, `realmBypass` marks the operator/system-director
 * principals that span realms. Projections without either field stay ungrouped.
 */
function makeRealmIdentityPort() {
  return {
    getAgentIdentity: (agentId) => {
      switch (agentId) {
        case 'operator':
          return { id: agentId, realmBypass: true };
        case 'director':
          return {
            id: agentId,
            realmBypass: true,
            authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' }
          };
        case 'alpha_lead':
          return { id: agentId, realmId: 'alpha' };
        case 'alpha_member':
          return { id: agentId, realmId: 'alpha' };
        case 'alpha_admin':
          return {
            id: agentId,
            realmId: 'alpha',
            authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' }
          };
        case 'beta_lead':
          return { id: agentId, realmId: 'beta' };
        case 'beta_member':
          return { id: agentId, realmId: 'beta' };
        case 'legacy_agent':
          return { id: agentId };
        default:
          return null;
      }
    }
  };
}

/** Registration order is deterministic: operator, director, alpha, beta, legacy. */
const ALL_AGENTS = [
  'operator',
  'director',
  'alpha_lead',
  'alpha_member',
  'alpha_admin',
  'beta_lead',
  'beta_member',
  'legacy_agent'
];

function makeRealmBus() {
  const bus = new MessagingBus({
    identityPort: makeRealmIdentityPort(),
    internalPrincipal: INTERNAL_PRINCIPAL
  });
  for (const agentId of ALL_AGENTS) bus.registerAgent(agentId);
  return bus;
}

/** Records every VirtualFS read while delegating to a real VirtualFS instance. */
function makeRecordingVfs() {
  const vfs = new VirtualFS();
  const reads = [];
  const spy = {
    readFile: (path, options) => {
      reads.push({ path, options });
      return vfs.readFile(path, options);
    },
    writeFile: (path, content, options) => vfs.writeFile(path, content, options)
  };
  return { vfs, spy, reads };
}

// ============================================================================
// 1. Cross-Realm Direct Sends: Fail-Closed, No Trace
// ============================================================================

test('1. Cross-realm direct sends deny fail-closed with no mailbox copy and no audit/archive entry', () => {
  const bus = makeRealmBus();

  const notifications = [];
  bus.subscribe('all', (message) => notifications.push(message));
  bus.subscribe('beta_member', (message) => notifications.push(message));

  const receipt = bus.sendMessage({ from: 'alpha_member', to: 'beta_member', content: 'cross the line' });
  assert.equal(receipt.success, false, 'cross-realm delivery must be denied');
  assert.equal(receipt.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(receipt.id, undefined, 'no message id is assigned to a denied envelope');
  assert.equal(receipt.messageId, undefined);

  // Reverse direction is symmetric.
  const reverse = bus.sendMessage({ from: 'beta_lead', to: 'alpha_lead', content: 'reverse probe' });
  assert.equal(reverse.success, false);
  assert.equal(reverse.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // Ungrouped <-> realm is a boundary crossing in both directions.
  const outbound = bus.sendMessage({ from: 'alpha_member', to: 'legacy_agent', content: 'outbound' });
  assert.equal(outbound.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  const inbound = bus.sendMessage({ from: 'legacy_agent', to: 'alpha_member', content: 'inbound' });
  assert.equal(inbound.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // Wildcard authority does not escape its realm.
  const privilegedProbe = bus.sendMessage({ from: 'alpha_admin', to: 'beta_lead', content: 'admin probe' });
  assert.equal(privilegedProbe.success, false, 'agent authority (including *) must not cross realms');
  assert.equal(privilegedProbe.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // Nothing was delivered, queued, notified, or archived.
  assert.equal(bus.getUnreadCount('beta_member'), 0);
  assert.equal(bus.getUnreadCount('alpha_lead'), 0);
  assert.equal(bus.getUnreadCount('legacy_agent'), 0);
  assert.deepEqual(bus.listInbox('beta_member'), []);
  assert.deepEqual(bus.getArchive('beta_member'), []);
  assert.deepEqual(bus.listInbox('legacy_agent'), []);
  assert.deepEqual(bus.getAuditLog(), [], 'denied envelopes must not enter the audit log');
  assert.deepEqual(notifications, [], 'denied envelopes must not notify subscribers');
});

test('1b. Dead-letter codes keep precedence over the Realm gate', () => {
  const bus = makeRealmBus();

  // Unknown (ungrouped) recipient keeps RECIPIENT_NOT_FOUND even for a realm-bound sender.
  const unknown = bus.sendMessage({ from: 'alpha_member', to: 'ghost_agent', content: 'ghost' });
  assert.equal(unknown.code, MESSAGING_ERROR_CODES.RECIPIENT_NOT_FOUND);

  // Terminated foreign recipient keeps AGENT_TERMINATED.
  bus.markAgentTerminated('beta_member');
  const terminated = bus.sendMessage({ from: 'alpha_member', to: 'beta_member', content: 'dead' });
  assert.equal(terminated.code, MESSAGING_ERROR_CODES.AGENT_TERMINATED);

  assert.deepEqual(bus.getAuditLog(), [], 'dead-letter rejections never record an envelope');
});

// ============================================================================
// 2. Same-Realm Direct + Inline Delivery
// ============================================================================

test('2. Same-realm direct sends deliver normally', () => {
  const bus = makeRealmBus();

  const receipt = bus.sendMessage({ from: 'alpha_member', to: 'alpha_lead', content: 'in-realm report' });
  assert.equal(receipt.success, true);
  assert.equal(bus.getUnreadCount('alpha_lead'), 1);

  const read = bus.readMessage('alpha_lead', receipt.messageId);
  assert.equal(read.success, true);
  assert.equal(read.message.content, 'in-realm report');

  const broadcast = bus.sendMessage({ from: 'beta_lead', to: 'all', content: 'beta standup' });
  assert.equal(broadcast.success, true);
  assert.ok(broadcast.recipients.includes('beta_member'), 'same-realm member receives the broadcast');
});

test('2b. Same-realm inline sends read and deliver; cross-realm inline denies before the VirtualFS read', async () => {
  const bus = makeRealmBus();
  const { vfs, spy, reads } = makeRecordingVfs();
  vfs.writeFile('/workspace/report.md', '# Realm Alpha Report', { workspaceId: 'global' });

  const allowed = await bus.inlineFileInMessage({
    filePath: '/global/workspace/report.md',
    recipient: 'alpha_lead',
    from: 'alpha_member',
    message: 'Attached.'
  }, { virtualFs: spy, callerAgentId: 'alpha_member' });
  assert.equal(allowed.success, true, 'same-realm inline must deliver');
  assert.ok(allowed.deliveryConfirmation.includes('Successfully inlined'));
  assert.equal(reads.length, 1, 'the allowed inline reads the file once');

  const allowedRead = bus.readMessage('alpha_lead', allowed.messageId);
  assert.ok(allowedRead.message.content.includes('# Realm Alpha Report'));

  reads.length = 0;
  const denied = await bus.inlineFileInMessage({
    filePath: '/global/workspace/report.md',
    recipient: 'beta_member',
    from: 'alpha_member',
    message: 'Leak attempt.'
  }, { virtualFs: spy, callerAgentId: 'alpha_member' });
  assert.equal(denied.success, false, 'cross-realm inline must be denied');
  assert.equal(denied.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(denied.inlinedFiles, undefined, 'a denied inline exposes no file metadata');
  assert.equal(reads.length, 0, 'a denied inline must not read VirtualFS content');
  assert.equal(bus.getUnreadCount('beta_member'), 0);
  assert.equal(bus.getAuditLog().length, 1, 'only the allowed inline is archived');

  // Dead-letter precedence: an unregistered recipient keeps RECIPIENT_NOT_FOUND.
  const unknown = await bus.inlineFileInMessage({
    filePath: '/global/workspace/report.md',
    recipient: 'ghost_agent',
    from: 'alpha_member'
  }, { virtualFs: spy, callerAgentId: 'alpha_member' });
  assert.equal(unknown.code, MESSAGING_ERROR_CODES.RECIPIENT_NOT_FOUND);
  assert.equal(reads.length, 1, 'dead-letter rejection happens after the read, as documented');
});

// ============================================================================
// 3. Bypass Principals
// ============================================================================

test('3. Bypass principals span realms one-way: they reach any realm; realms cannot reach them', () => {
  const bus = makeRealmBus();

  // Operator (bypass) injects into a realm.
  const injected = bus.sendMessage({ from: 'operator', to: 'beta_member', content: 'operator directive' });
  assert.equal(injected.success, true, 'a bypass sender reaches any realm');
  assert.equal(bus.getUnreadCount('beta_member'), 1);

  // A realm agent cannot reply to (or address) the bypass director: the
  // recipient's bypass never widens the sender's scope (ticket cf0e127).
  const auditBefore = bus.getAuditLog().length;
  const reported = bus.sendMessage({ from: 'alpha_member', to: 'director', content: 'status report' });
  assert.equal(reported.success, false, 'a realm sender cannot reach the system director');
  assert.equal(reported.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(reported.messageId, undefined, 'no envelope is minted for the denied reply');
  assert.equal(bus.getUnreadCount('director'), 0, 'the director mailbox stays untouched');
  assert.equal(bus.getAuditLog().length, auditBefore, 'the denied envelope leaves no audit trace');

  // The director (bypass sender) reaches the realm one-way.
  const directive = bus.sendMessage({ from: 'director', to: 'alpha_member', content: 'system directive' });
  assert.equal(directive.success, true, 'the director bypass spans into the realm');
  assert.equal(bus.getUnreadCount('alpha_member'), 1);

  // The engine/operator principal in the execution context is bypass.
  const hostInject = bus.sendMessage(
    { from: 'alpha_member', to: 'beta_member', content: 'host injection' },
    { callerAgentId: 'alpha_member', principal: INTERNAL_PRINCIPAL }
  );
  assert.equal(hostInject.success, true, 'the exact injected internal principal bypasses realms');
  assert.equal(bus.getUnreadCount('beta_member'), 2);
});

test('3b. A forged lookalike principal or payload claim does not bypass', () => {
  const bus = makeRealmBus();

  const lookalike = bus.sendMessage(
    { from: 'alpha_member', to: 'beta_member', content: 'forged principal' },
    { callerAgentId: 'alpha_member', principal: { kind: 'internal', subject: 'realm_bus_operator' } }
  );
  assert.equal(lookalike.success, false, 'a structural lookalike principal is not the injected reference');
  assert.equal(lookalike.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  const payloadClaim = bus.sendMessage({
    from: 'alpha_member',
    to: 'beta_member',
    content: 'forged claims',
    realmBypass: true,
    realmId: 'beta'
  });
  assert.equal(payloadClaim.success, false);
  assert.equal(payloadClaim.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  assert.equal(bus.getUnreadCount('beta_member'), 0);
  assert.deepEqual(bus.getAuditLog(), []);
});

test('3c. Positional and proxy paths honor the same Realm rule; only the exact principal context bypasses', () => {
  const bus = makeRealmBus();

  // Positional (from, to, content) resolves the sender from the identity port.
  const positionalCross = bus.sendMessage('alpha_member', 'beta_member', 'positional cross');
  assert.equal(positionalCross.success, false);
  assert.equal(positionalCross.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  const positionalSame = bus.sendMessage('alpha_member', 'alpha_lead', 'positional same');
  assert.equal(positionalSame.success, true);

  // Positional descriptor handler (recipient, message, params/context).
  const descriptorNoBypass = bus.sendMessage('beta_member', 'hello', { callerAgentId: 'alpha_member' });
  assert.equal(descriptorNoBypass.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  const descriptorHost = bus.sendMessage('beta_member', 'hello', { callerAgentId: 'alpha_member', principal: INTERNAL_PRINCIPAL });
  assert.equal(descriptorHost.success, true, 'the exact internal principal bypasses through the descriptor context');
  assert.equal(descriptorHost.from, 'alpha_member');

  // The agent-scoped proxy keeps the same rule.
  const proxy = bus.forAgent('alpha_member');
  assert.equal(proxy.sendMessage('beta_member', 'proxy cross').code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
  const proxyBroadcast = proxy.broadcast('proxy broadcast');
  assert.deepEqual([...proxyBroadcast.recipients].sort(), ['alpha_admin', 'alpha_lead'], 'a realm broadcast never reaches bypass recipients');

  // A contextless payload cannot smuggle the principal reference either.
  const payloadPrincipal = bus.sendMessage({
    from: 'alpha_member',
    to: 'beta_member',
    content: 'payload principal',
    principal: INTERNAL_PRINCIPAL
  });
  assert.equal(payloadPrincipal.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // An anonymous context is ungrouped: realm recipients stay out of reach.
  const anonymous = bus.sendMessage({ to: 'alpha_member', content: 'anonymous' }, {});
  assert.equal(anonymous.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
});

// ============================================================================
// 4. Broadcast Fan-Out Filtering
// ============================================================================

test("4. to:'all' fan-out reaches same-realm members only for a realm sender", () => {
  const bus = makeRealmBus();

  const receipt = bus.sendMessage({ from: 'alpha_lead', to: 'all', content: 'alpha announcement' });
  assert.equal(receipt.success, true);
  assert.equal(receipt.broadcast, true);
  assert.deepEqual(
    [...receipt.recipients].sort(),
    ['alpha_admin', 'alpha_member'],
    'only same-realm members receive a realm-bound fan-out; bypass recipients stay out of reach'
  );

  // Counters/archives never disclose foreign agents.
  for (const foreign of ['beta_lead', 'beta_member', 'legacy_agent']) {
    assert.equal(bus.getUnreadCount(foreign), 0, `${foreign} must not receive a foreign broadcast`);
    assert.deepEqual(bus.listInbox(foreign), []);
    assert.deepEqual(bus.getArchive(foreign), []);
  }
  assert.equal(bus.getUnreadCount('alpha_member'), 1);
  assert.equal(bus.getUnreadCount('alpha_admin'), 1);
  assert.equal(bus.getUnreadCount('operator'), 0, 'the bypass operator is not disclosed to a realm fan-out');
  assert.equal(bus.getUnreadCount('director'), 0, 'the system director is not disclosed to a realm fan-out');

  // The audit entry carries the same filtered recipient list.
  const audit = bus.getAuditLog();
  assert.equal(audit.length, 1);
  assert.deepEqual([...audit[0].recipients].sort(), ['alpha_admin', 'alpha_member']);

  // The sender itself never receives a copy (legacy broadcast semantics).
  assert.equal(bus.getUnreadCount('alpha_lead'), 0);
});

test('4b. A bypass principal broadcast spans every realm', () => {
  const bus = makeRealmBus();

  const receipt = bus.sendMessage({ from: 'director', to: 'all', content: 'system notice' });
  assert.deepEqual(
    [...receipt.recipients].sort(),
    ['alpha_admin', 'alpha_lead', 'alpha_member', 'beta_lead', 'beta_member', 'legacy_agent', 'operator'],
    'the director reaches every registered realm'
  );
  assert.equal(bus.getUnreadCount('beta_member'), 1);
  assert.equal(bus.getUnreadCount('alpha_member'), 1);
  assert.equal(bus.getUnreadCount('legacy_agent'), 1);
});

test("4c. A realm-bound broadcast with no eligible recipients succeeds with an empty fan-out", () => {
  const bus = new MessagingBus({
    identityPort: makeRealmIdentityPort(),
    internalPrincipal: INTERNAL_PRINCIPAL
  });
  bus.registerAgent('alpha_lead');
  bus.registerAgent('beta_member');

  const receipt = bus.sendMessage({ from: 'alpha_lead', to: 'all', content: 'solo realm' });
  assert.equal(receipt.success, true);
  assert.deepEqual(receipt.recipients, [], 'no foreign agent may be disclosed or reached');
  assert.equal(bus.getUnreadCount('beta_member'), 0);
  assert.deepEqual(bus.listInbox('beta_member'), []);
});

// ============================================================================
// 5. Legacy Ungrouped Parity
// ============================================================================

test('5. Legacy ungrouped parity: no realm fields means unchanged direct and broadcast delivery', () => {
  // (a) No identity port at all.
  const plainBus = new MessagingBus();
  plainBus.registerAgent('agent_a');
  plainBus.registerAgent('agent_b');
  plainBus.registerAgent('agent_c');

  const direct = plainBus.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'plain direct' });
  assert.equal(direct.success, true);
  assert.equal(plainBus.getUnreadCount('agent_b'), 1);

  const broadcast = plainBus.sendMessage({ from: 'agent_a', to: 'all', content: 'plain broadcast' });
  assert.deepEqual([...broadcast.recipients].sort(), ['agent_b', 'agent_c']);

  // (b) Identity port without realm fields (pre-wiring projection shape).
  const legacyPort = new MessagingBus({
    identityPort: {
      getAgentIdentity: (agentId) => ({ id: agentId, privileged: false, allowedTools: [] })
    }
  });
  legacyPort.registerAgent('agent_a');
  legacyPort.registerAgent('agent_b');
  legacyPort.registerAgent('agent_c');

  const legacyDirect = legacyPort.sendMessage({ from: 'agent_a', to: 'agent_b', content: 'legacy direct' });
  assert.equal(legacyDirect.success, true);
  assert.equal(legacyPort.getUnreadCount('agent_b'), 1);

  const legacyBroadcast = legacyPort.sendMessage({ from: 'agent_a', to: 'all', content: 'legacy broadcast' });
  assert.deepEqual([...legacyBroadcast.recipients].sort(), ['agent_b', 'agent_c']);
});

// ============================================================================
// 6. Forged Realm Claims in Payloads/Metadata
// ============================================================================

test('6. Realm claims in payloads and metadata are ignored in both directions', () => {
  const bus = makeRealmBus();

  // Sender claims a foreign/other realm — the identity port decides.
  const senderClaim = bus.sendMessage({
    from: 'legacy_agent',
    to: 'alpha_member',
    content: 'claimed realm',
    realmId: 'alpha',
    metadata: { realmId: 'alpha', realmBypass: true }
  });
  assert.equal(senderClaim.success, false);
  assert.equal(senderClaim.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // Recipient-side claim on the sender payload does not widen the fan-out.
  const recipientClaim = bus.sendMessage({
    from: 'alpha_member',
    to: 'beta_member',
    content: 'claimed recipient realm',
    metadata: { to: 'alpha_lead', realmId: 'beta' }
  });
  assert.equal(recipientClaim.success, false);
  assert.equal(recipientClaim.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);

  // Claims are inert on an allowed same-realm send.
  const allowed = bus.sendMessage({
    from: 'alpha_member',
    to: 'alpha_lead',
    content: 'allowed',
    metadata: { realmId: 'beta', realmBypass: true }
  });
  assert.equal(allowed.success, true);
  assert.equal(bus.getUnreadCount('alpha_lead'), 1);

  // Claims do not change a broadcast fan-out.
  const broadcast = bus.sendMessage({
    from: 'alpha_lead',
    to: 'all',
    content: 'announcement',
    metadata: { realmId: 'beta' }
  });
  assert.deepEqual(
    [...broadcast.recipients].sort(),
    ['alpha_admin', 'alpha_member'],
    'a realm fan-out never includes bypass recipients'
  );
  assert.equal(bus.getUnreadCount('beta_member'), 0);

  assert.equal(bus.getAuditLog().length, 2, 'only the allowed direct + broadcast envelopes are archived');
});

// ============================================================================
// 7. Mailbox Reads Stay Self-Scoped
// ============================================================================

test('7. Context-bound mailbox reads stay self-scoped', () => {
  const bus = makeRealmBus();
  bus.sendMessage({ from: 'alpha_member', to: 'alpha_lead', content: 'alpha only' });

  const foreignView = bus.listInbox({}, { callerAgentId: 'beta_member' });
  assert.deepEqual(foreignView, [], 'a context-bound reader sees only its own mailbox');

  const ownView = bus.listInbox({}, { callerAgentId: 'alpha_lead' });
  assert.equal(ownView.length, 1);
  assert.equal(ownView[0].from, 'alpha_member');

  const deniedDrain = bus.drainInbox({}, { callerAgentId: 'beta_member' });
  assert.deepEqual(deniedDrain, []);
  assert.equal(bus.getUnreadCount('alpha_lead'), 1, 'a foreign context cannot consume another mailbox');
});

// ============================================================================
// 8. Wave I (d57cbc1): realm-local ids through the real runtime + real bus
// ============================================================================

const I2_WAVE_ALPHA_REALM = 'realm_i2bus_alpha';
const I2_WAVE_BETA_REALM = 'realm_i2bus_beta';

/**
 * Deterministic in-memory model accepted by `launchAgent` (the repo's standard
 * provider stub): the runtime, messaging bus, registry, identity port and
 * VirtualFS stay real, and this fixture never executes a turn.
 *
 * @param {string} output - Final assistant text for every turn.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output = 'acknowledged') {
  return {
    id: 'i2-bus-deterministic-model',
    config: {},
    provider: {
      id: 'i2-bus-deterministic-provider',
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: 'i2-bus-deterministic-model', name: 'I2 Bus Model' }]
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
 * Composes the real runtime and the real bus the way the store composition root
 * does: a late-bound identity bridge hands the bus the runtime's frozen
 * `AgentIdentityPort` once the runtime exists. Launches one `scout` per realm
 * plus one same-realm peer per realm, then registers each agent's canonical
 * `(realmId, agentId)` key on the bus (the wiring-lane registration contract).
 *
 * @returns {Promise<{runtime: object, bus: object, identityPort: object, keys: object}>} Real fixture.
 */
async function createRealRealmBusFixture() {
  let identityPort = null;
  const bridge = {
    getAgentIdentity: (agentId, scope) => (identityPort ? identityPort.getAgentIdentity(agentId, scope) : null),
    listAgentIdentities: (scope) => (identityPort ? identityPort.listAgentIdentities(scope) : [])
  };
  const bus = new MessagingBus({ identityPort: bridge });
  const runtime = new AgentRuntime({ messagingBus: bus, autoBootstrapDirector: false });
  identityPort = runtime.createAgentIdentityPort();

  await runtime.launchAgent({ id: 'scout', realmId: I2_WAVE_ALPHA_REALM, allowedTools: ['read_file'] }, createDeterministicModel());
  await runtime.launchAgent({ id: 'scout', realmId: I2_WAVE_BETA_REALM, allowedTools: ['read_file'] }, createDeterministicModel());
  await runtime.launchAgent({ id: 'alpha_peer', realmId: I2_WAVE_ALPHA_REALM, allowedTools: ['read_file'] }, createDeterministicModel());
  await runtime.launchAgent({ id: 'beta_peer', realmId: I2_WAVE_BETA_REALM, allowedTools: ['read_file'] }, createDeterministicModel());

  const alphaScout = identityPort.getAgentIdentity('scout', { realmId: I2_WAVE_ALPHA_REALM });
  const betaScout = identityPort.getAgentIdentity('scout', { realmId: I2_WAVE_BETA_REALM });
  const alphaPeer = identityPort.getAgentIdentity('alpha_peer', { realmId: I2_WAVE_ALPHA_REALM });
  const betaPeer = identityPort.getAgentIdentity('beta_peer', { realmId: I2_WAVE_BETA_REALM });
  assert.ok(alphaScout && betaScout && alphaPeer && betaPeer, 'fixture: every real registration must resolve through the runtime identity port');

  // The wiring-lane registration contract: canonical keys, never bare ids.
  for (const projection of [alphaScout, betaScout, alphaPeer, betaPeer]) {
    bus.registerAgent(projection.key);
  }

  return { runtime, bus, identityPort, keys: { alphaScout, betaScout, alphaPeer, betaPeer } };
}

test("8. Wave I d57cbc1: real runtime + real bus key two realms' same-id agents independently", async () => {
  const { runtime, bus, keys } = await createRealRealmBusFixture();
  const { alphaScout, betaScout, alphaPeer, betaPeer } = keys;
  try {
    // Canonical identity keys are distinct per realm and never the bare id.
    assert.match(alphaScout.key, /^realm:/);
    assert.match(betaScout.key, /^realm:/);
    assert.notEqual(alphaScout.key, betaScout.key, 'the same literal id in two realms has two registrations');
    assert.notEqual(alphaScout.key, 'scout', 'the registration identifier is not assumed to equal the bare id');
    assert.equal(bus.isRegistered(alphaScout.key), true);
    assert.equal(bus.isRegistered(betaScout.key), true);

    // In-scope delivery with a canonical caller key: the bare 'scout' ref
    // resolves realm-locally to the sender's own realm registration.
    const alphaDelivery = bus.sendMessage(
      { from: 'alpha_peer', to: 'scout', content: 'alpha in-scope delivery' },
      { callerAgentId: 'alpha_peer', callerKey: alphaPeer.key }
    );
    assert.equal(alphaDelivery.success, true);
    assert.equal(alphaDelivery.from, 'alpha_peer', 'the receipt exposes the bare sender id');
    assert.equal(alphaDelivery.to, 'scout', 'the receipt exposes the bare recipient id');
    assert.equal(bus.getUnreadCount(alphaScout.key), 1, 'the alpha scout partition receives the message');
    assert.equal(bus.getUnreadCount(betaScout.key), 0, 'the beta scout partition stays untouched');

    // A beta caller resolves *its* scout: same bare ref, realm-local.
    const betaDelivery = bus.sendMessage(
      { from: 'beta_peer', to: 'scout', content: 'beta in-scope delivery' },
      { callerAgentId: 'beta_peer', callerKey: betaPeer.key }
    );
    assert.equal(betaDelivery.success, true);
    assert.equal(bus.getUnreadCount(betaScout.key), 1);

    // In-scope inline delivery shares the same resolution. The file lives in
    // the alpha peer's realm-global partition: the trusted canonical
    // `callerKey` the inline forwards resolves realm-exactly through the
    // identity-wired runtime VirtualFS (a key-less bare VFS cannot resolve
    // canonical identity, so it would fail the read closed by contract).
    const vfs = runtime.virtualFs;
    vfs.writeFile('/workspace/i2-note.md', '# Realm-local note', {
      callerAgentId: alphaPeer.id,
      callerKey: alphaPeer.key,
      workspaceId: 'global'
    });
    const inlineAllowed = await bus.inlineFileInMessage(
      { filePath: '/global/workspace/i2-note.md', recipient: 'scout', from: 'alpha_peer' },
      { callerAgentId: 'alpha_peer', callerKey: alphaPeer.key, virtualFs: vfs }
    );
    assert.equal(inlineAllowed.success, true, 'a same-realm inline resolves the bare recipient realm-locally');
    assert.equal(inlineAllowed.to, 'scout');
    assert.equal(bus.getUnreadCount(alphaScout.key), 2);

    // The agent-scoped proxy pins its bound registration: a spoofed
    // `callerKey` option cannot move the sender to the other realm's scout.
    const proxy = bus.forAgent(alphaPeer.key);
    const proxyInline = await proxy.inlineFileInMessage('/global/workspace/i2-note.md', 'scout', {
      virtualFs: vfs,
      callerKey: betaScout.key
    });
    assert.equal(proxyInline.success, true);
    assert.equal(proxyInline.from, 'alpha_peer', 'the proxy strips payload `callerKey` spoof options');
    assert.equal(proxyInline.to, 'scout');
    assert.equal(bus.getUnreadCount(alphaScout.key), 3);
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the spoofed key must not redirect the delivery');

    // Cross-realm direct and inline sends deny fail-closed with no trace.
    const auditBeforeCross = bus.getAuditLog().length;
    const crossRealm = bus.sendMessage(
      { from: 'alpha_peer', to: 'beta_peer', content: 'cross-realm attempt' },
      { callerAgentId: 'alpha_peer', callerKey: alphaPeer.key }
    );
    assert.equal(crossRealm.success, false);
    assert.equal(crossRealm.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
    assert.equal(crossRealm.id, undefined, 'a denied envelope mints no id');
    assert.equal(bus.getUnreadCount(betaPeer.key), 0);
    assert.equal(bus.getAuditLog().length, auditBeforeCross, 'a denied envelope leaves no audit trace');

    const inlineDenied = await bus.inlineFileInMessage(
      { filePath: '/workspace/i2-note.md', recipient: 'beta_peer', from: 'alpha_peer' },
      { callerAgentId: 'alpha_peer', callerKey: alphaPeer.key, virtualFs: vfs }
    );
    assert.equal(inlineDenied.success, false, 'a cross-realm inline denies before delivery');
    assert.equal(inlineDenied.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
    assert.equal(bus.getUnreadCount(betaPeer.key), 0);

    // The `to: 'all'` fan-out enumerates the sender's realm only, excluding
    // the sender partition and never disclosing the foreign realm.
    const broadcast = bus.sendMessage(
      { from: 'scout', to: 'all', content: 'alpha standup' },
      { callerAgentId: 'scout', callerKey: alphaScout.key }
    );
    assert.equal(broadcast.success, true);
    assert.deepEqual(broadcast.recipients, ['alpha_peer'], 'fan-out spans the sender realm only');
    assert.equal(bus.getUnreadCount(alphaPeer.key), 1);
    assert.equal(bus.getUnreadCount(betaPeer.key), 0, 'no foreign partition receives the fan-out');
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the beta scout partition is unchanged by the alpha fan-out');

    // Canonical partitions drive reads exactly like legacy partitions.
    const headers = bus.listInbox(alphaScout.key);
    assert.equal(headers.length, 3);
    assert.equal(headers[0].from, 'alpha_peer');
    assert.equal(headers[0].to, 'scout');
    const drained = bus.drainInbox(alphaScout.key);
    assert.equal(drained.length, 3);
    assert.equal(bus.getUnreadCount(alphaScout.key), 0);

    // A bypass principal cannot address an ambiguous bare id: opaque denial.
    const ambiguous = bus.sendMessage(
      { from: 'human', to: 'scout', content: 'ambiguous operator probe' },
      { callerAgentId: 'human', principal: runtime.getOperatorPrincipal() }
    );
    assert.equal(ambiguous.success, false, 'a bypass principal cannot address an ambiguous bare id');
    assert.equal(ambiguous.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
    assert.equal(ambiguous.id, undefined);
    assert.equal(bus.getUnreadCount(betaScout.key), 1, 'the ambiguous probe reaches no partition');

    // Termination is realm-exact: killing the beta partition never touches the
    // alpha partition, and dead-letter checks read the canonical key.
    bus.markAgentTerminated(betaScout.key);
    assert.equal(bus.isAgentTerminated(betaScout.key), true);
    assert.equal(bus.isAgentTerminated(alphaScout.key), false, 'termination is realm-exact');
    assert.equal(bus.isRegistered(betaScout.key), false);
    assert.deepEqual(
      bus.getTerminatedAgents(),
      ['scout'],
      'terminated listings project the bare id, never the canonical key'
    );
    const deadLetter = bus.sendMessage(
      { from: 'beta_peer', to: 'scout', content: 'dead-letter probe' },
      { callerAgentId: 'beta_peer', callerKey: betaPeer.key }
    );
    assert.equal(deadLetter.success, false);
    assert.equal(deadLetter.code, MESSAGING_ERROR_CODES.AGENT_TERMINATED);
    assert.ok(String(deadLetter.error).includes('scout'), 'the dead-letter error names the bare id');

    // Receipts, listings, errors, audit entries and archived payloads expose
    // the bare id only — never the canonical key, never realm vocabulary.
    const registeredListing = bus.getRegisteredAgents();
    assert.ok(registeredListing.includes('alpha_peer'), 'listings surface the bare id');
    assert.ok(
      registeredListing.every((id) => !id.includes(':')),
      `registry listings must never expose canonical keys or realm vocabulary; got ${JSON.stringify(registeredListing)}`
    );
    const visibleSurfaces = JSON.stringify({
      receipts: [alphaDelivery, betaDelivery, inlineAllowed, crossRealm, inlineDenied, broadcast, ambiguous, deadLetter],
      audit: bus.getAuditLog(),
      inbox: bus.listInbox(alphaPeer.key),
      archive: bus.getArchive(alphaScout.key)
    });
    for (const internal of [alphaScout.key, betaScout.key, alphaPeer.key, betaPeer.key, I2_WAVE_ALPHA_REALM, I2_WAVE_BETA_REALM]) {
      assert.ok(!visibleSurfaces.includes(internal), `agent-visible surfaces must never expose '${internal}'`);
    }
  } finally {
    runtime.destroy();
  }
});
