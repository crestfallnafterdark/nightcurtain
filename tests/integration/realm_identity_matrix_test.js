/**
 * @file tests/integration/realm_identity_matrix_test.js
 * @description Wave I lane I2-T (ticket d57cbc1): cross-realm same-id acceptance
 *   matrix. Two Realms (`realm_i2t_alpha` / `realm_i2t_beta`) run side by side
 *   with agents sharing bare ids (`scout` ordinary, `root` privileged) plus one
 *   realm-unique privileged lead per Realm, through the real `AgentRuntime` +
 *   `SandboxStore` composition root (real MessagingBus, VirtualFS, WorldClock,
 *   TriggerQueue, RuntimeScheduler, InvocationEngine, lifecycle registries).
 *
 *   Coverage matrix (substrate -> asserted contract):
 *   1. registration/resolution — bare `scout`/`root` are ambiguous for the
 *      host/bypass lookup; realm-exact scopes resolve each Realm's own
 *      registration; `listAgentIdentities(scope)` is scope-correct.
 *   2. mail — in-realm direct + inline land in each Realm's own mailbox
 *      (including an inline sent by the shared-id `scout` through the trusted
 *      canonical callerKey); cross-realm direct/inline/broadcast deny or drop;
 *      the operator principal spans; receipts/envelopes/errors stay bare-id
 *      only.
 *   3. VFS — distinct canonical private workspaces (no bare-id partition);
 *      same-realm cross-workspace mount succeeds; cross-realm access denies;
 *      receipts/listings are realm-opaque.
 *   4. clock — partitions/events are realm-isolated; scoped enumeration works;
 *      duplicate event ids resolve realm-locally; receipts are bare.
 *   5. triggers — a realm-bound source wakes only same-realm (or bypass)
 *      targets; foreign and ambiguous targets drop.
 *   6. scheduler — schedules are owned per Realm; `listSchedules` is scoped;
 *      kill teardown cancels only the killed Realm's task; a bare-ref
 *      pre-launch schedule is torn down on kill (teardown fix at c21814e5);
 *      a same-literal-id realm root arms, lists, and tears down realm-exactly
 *      through the trusted principal + canonical callerKey (fix 7023644c).
 *   7. invocation — same-realm invoke returns the target's output; cross-realm
 *      pairs deny (even with the same literal id); the director and an
 *      operator-granted bypass caller span, including scoped grants that
 *      address one same-id registration by canonical key or `{ realmId }`
 *      scope (fix c3d35aa5).
 *   8. lifecycle — kill/restore/purge in one Realm never touches the other
 *      Realm's same-id agent; a same-id realm root resolves its own realm view
 *      through the lifecycle port while bare ambiguous claims stay fail-closed;
 *      the system scope stays unreachable to non-bypass callers.
 *   9. opacity sweep — no `realm:`, canonical-key shape, realm-id, or
 *      `realm_<id>` vocabulary appears in any agent-visible receipt, listing,
 *      envelope, or error produced by 1-8.
 *
 * Zero-Mock Verification: every engine/substrate class is the real production
 * class; the only stub is the deterministic in-memory model accepted by
 * `launchAgent` (the repo convention), so no request leaves the process.
 *
 * Standalone: `timeout 240 node tests/integration/realm_identity_matrix_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { TRIGGER_TYPES } from '../../src/lib/sandbox/triggerQueue/index.ts';

// ============================================================================
// Fixture: two realms, shared bare ids, deterministic models
// ============================================================================

/** First matrix Realm id (its literal carries the `realm_` vocabulary the opacity sweep must catch). */
const ALPHA = 'realm_i2t_alpha';
/** Second matrix Realm id. */
const BETA = 'realm_i2t_beta';

/** Realm vocabulary that must never appear on an agent-visible surface. */
const REALM_VOCABULARY = Object.freeze([ALPHA, BETA, 'realm:']);

/** Canonical identity-key shape (`realm:<realmId>:<agentId>` / `system:<agentId>`). */
const CANONICAL_KEY_SHAPE = /(?:^|["'\s{[(,=])realm:[^"'\s{}\[\],]+:[^"'\s{}\[\],]+/;

/** Tool grants for the shared ordinary `scout` pair. */
const SCOUT_TOOLS = Object.freeze([
  'read_file',
  'write_file',
  'list_files',
  'send_message',
  'inline_file_in_message',
  'world_clock',
  'event_list',
  'list_agents'
]);

/** Scheduling delay used by matrix timers: long enough to never expire mid-test. */
const LONG_DELAY_SECONDS = 240;

/** Settle window for queued trigger dispatch / wake turns. */
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asserts an agent-visible surface (receipt, listing, envelope, or error) is
 * free of internal realm vocabulary: the `realm:` key prefix, the canonical
 * key shape, both Realm ids, and system-scope key vocabulary.
 *
 * @param {unknown} value - Receipt/listing/error under test.
 * @param {string} label - Assertion label naming the surface.
 */
function assertRealmOpaque(value, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(typeof serialized === 'string' && serialized.length > 0, `${label}: surface must serialize`);
  assert.equal(serialized.includes('realm:'), false, `${label} must not carry a canonical key: ${serialized}`);
  assert.equal(CANONICAL_KEY_SHAPE.test(serialized), false, `${label} must not match the canonical key shape: ${serialized}`);
  for (const vocabulary of REALM_VOCABULARY) {
    assert.equal(
      serialized.includes(vocabulary),
      false,
      `${label} must not expose '${vocabulary}': ${serialized}`
    );
  }
  assert.equal(serialized.includes('system:director'), false, `${label} must not carry the system key: ${serialized}`);
  assert.equal(/realmId|realm_id|ownerKey|canonicalKey|agentRef/.test(serialized), false, `${label} must not carry internal identity fields: ${serialized}`);
}

/**
 * Deterministic in-memory model accepted by `launchAgent` (repo convention):
 * the runtime, bus, VFS, clock, trigger queue, scheduler, invocation engine and
 * registries all stay real; this fixture never touches the network.
 *
 * @param {string} output - Final assistant text for every turn.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `i2t-model-${output.replace(/\s+/g, '-')}`,
    config: {},
    provider: {
      id: 'i2t-matrix-provider',
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: 'i2t-matrix-model', name: 'I2T Matrix Model' }]
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
 * Builds the shared two-Realm matrix fixture through the real composition
 * root: a store wired onto the runtime's own substrates, the bootstrapped
 * system director (the only realm-bypass principal by birth), one ordinary
 * `scout` per Realm (same bare id, distinct realm memberships), one privileged
 * `root` per Realm (same bare id), and one realm-unique privileged `lead`.
 *
 * @returns {Promise<object>} Live fixture with resolved realm-exact identities.
 */
async function createMatrixFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  await store.ensureDirector();
  store.createRealm({ id: ALPHA, name: 'Matrix Alpha' });
  store.createRealm({ id: BETA, name: 'Matrix Beta' });

  const launch = (config, output) => store.launchAgent(config, createDeterministicModel(output));
  await launch({ id: 'scout', name: 'Matrix Scout', realmId: ALPHA, allowedTools: [...SCOUT_TOOLS] }, 'alpha scout output');
  await launch({ id: 'scout', name: 'Matrix Scout', realmId: BETA, allowedTools: [...SCOUT_TOOLS] }, 'beta scout output');
  await launch({ id: 'root', name: 'Matrix Root', realmId: ALPHA, privileged: true, allowedTools: ['*'] }, 'alpha root output');
  await launch({ id: 'root', name: 'Matrix Root', realmId: BETA, privileged: true, allowedTools: ['*'] }, 'beta root output');
  await launch({ id: 'alpha_lead', name: 'Matrix Alpha Lead', realmId: ALPHA, privileged: true, allowedTools: ['*'] }, 'alpha lead output');
  await launch({ id: 'beta_lead', name: 'Matrix Beta Lead', realmId: BETA, privileged: true, allowedTools: ['*'] }, 'beta lead output');

  const port = runtime.createAgentIdentityPort();
  /**
   * Resolves one realm-exact identity projection or fails the fixture.
   *
   * @param {string} id - Bare agent id.
   * @param {string} realmId - Realm membership.
   * @returns {object} Frozen identity projection.
   */
  const identityFor = (id, realmId) => {
    const projection = port.getAgentIdentity(id, { realmId });
    assert.ok(projection, `fixture: '${id}' must resolve in realm '${realmId}'`);
    return projection;
  };
  const director = port.getAgentIdentity('director');
  assert.ok(director && director.realmBypass === true, 'fixture: the bootstrapped director carries the bypass grant');

  return {
    runtime,
    store,
    port,
    operator: runtime.getOperatorPrincipal(),
    director,
    alpha: { scout: identityFor('scout', ALPHA), root: identityFor('root', ALPHA), lead: identityFor('alpha_lead', ALPHA) },
    beta: { scout: identityFor('scout', BETA), root: identityFor('root', BETA), lead: identityFor('beta_lead', BETA) }
  };
}

/**
 * Tears down one matrix fixture.
 *
 * @param {object} fixture - Fixture from {@link createMatrixFixture}.
 */
function destroyMatrixFixture(fixture) {
  fixture.store.destroy();
  fixture.runtime.destroy();
}

/**
 * Trusted agent context (identity + canonical key) for substrate calls.
 *
 * @param {object} projection - Realm-exact identity projection.
 * @returns {{callerAgentId: string, callerKey: string}} Context object.
 */
function callContext(projection) {
  return { callerAgentId: projection.id, callerKey: projection.key };
}

/**
 * Captures a thrown error without failing the test.
 *
 * @param {Function} fn - Synchronous call under test.
 * @returns {Error|null} Thrown error, or `null`.
 */
function captureThrow(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ============================================================================
// 1. Registration & resolution
// ============================================================================

test('1. registration/resolution: shared bare ids are ambiguous for the host lookup and realm-exact under scope', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, store, port, alpha, beta, director } = fixture;
  try {
    // Bare ids registered in two Realms never resolve a wrong-Realm pick.
    for (const bareId of ['scout', 'root']) {
      assert.equal(port.getAgentIdentity(bareId), null, `bare '${bareId}' must be ambiguous for the host lookup`);
      assert.equal(
        port.getAgentIdentity(bareId, { realmBypass: true }),
        null,
        `bare '${bareId}' must stay ambiguous for a bypass lookup`
      );
      assert.equal(runtime.getAgent(bareId), null, `runtime.getAgent('${bareId}') must fail closed`);
      assert.equal(runtime.hasAgent(bareId), false, `runtime.hasAgent('${bareId}') must fail closed`);
    }

    // Each Realm's own caller resolves its realm-local registration.
    assert.equal(alpha.scout.id, 'scout');
    assert.equal(beta.scout.id, 'scout');
    assert.notEqual(alpha.scout.key, beta.scout.key, 'the same literal id carries two canonical registrations');
    assert.equal(alpha.scout.realmId, ALPHA);
    assert.equal(beta.scout.realmId, BETA);
    assert.equal(alpha.root.privileged, true, 'each realm root keeps its privileged projection');
    assert.equal(beta.root.privileged, true);
    assert.equal(alpha.scout.privileged, false, 'an ordinary scout is not privileged');
    assert.equal(alpha.root.realmBypass, false, 'wildcard authority never mints realmBypass');
    assert.equal(beta.root.realmBypass, false);
    assert.equal(port.getAgentIdentity(alpha.scout.key)?.id, 'scout', 'a canonical key resolves its exact registration');
    assert.equal(port.getAgentIdentity(beta.scout.key)?.id, 'scout');
    assert.equal(port.getAgentIdentity('scout', { realmId: null }), null, 'the system scope holds no realm-local scout');

    // Scoped enumeration is scope-correct and never bleeds.
    const alphaIds = port.listAgentIdentities({ realmId: ALPHA }).map((entry) => entry.id).sort();
    const betaIds = port.listAgentIdentities({ realmId: BETA }).map((entry) => entry.id).sort();
    assert.deepEqual(alphaIds, ['alpha_lead', 'root', 'scout'], 'the Alpha enumeration is realm-exact');
    assert.deepEqual(betaIds, ['beta_lead', 'root', 'scout'], 'the Beta enumeration is realm-exact');
    for (const projection of port.listAgentIdentities({ realmId: ALPHA })) {
      assert.equal(projection.realmId, ALPHA, 'every Alpha enumeration entry is Alpha-bound');
    }
    const systemIds = port.listAgentIdentities({ realmId: null }).map((entry) => entry.id);
    assert.deepEqual(systemIds, ['director'], 'the system scope enumerates only the bootstrap director');
    const scouts = port.listAgentIdentities().filter((entry) => entry.id === 'scout');
    assert.equal(scouts.length, 2, 'an unscoped enumeration sees both same-id registrations');
    assert.notEqual(scouts[0].key, scouts[1].key);

    // Runtime listing filter parity.
    assert.deepEqual(
      runtime.listAgents({ realmId: ALPHA }).map((agent) => agent.id).sort(),
      ['alpha_lead', 'root', 'scout']
    );
    assert.deepEqual(
      runtime.listAgents({ realmId: BETA }).map((agent) => agent.id).sort(),
      ['beta_lead', 'root', 'scout']
    );

    // Store projections keep both registrations and fail closed on bare ambiguity.
    const storeScouts = store.agents.filter((agent) => agent.id === 'scout');
    assert.equal(storeScouts.length, 2, 'the store projects both same-id registrations');
    assert.deepEqual(
      storeScouts.map((agent) => agent.config.realmId).sort(),
      [ALPHA, BETA]
    );
    assert.equal(store.getAgentUnreadCount('scout'), 0, 'an ambiguous bare id reports no wrong-Realm badge');
    assert.equal(director.key, 'system:director', 'the bootstrap director keys the system scope');
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 2. Mail
// ============================================================================

test('2. mail: bare-id sends resolve realm-locally; cross-realm direct/inline/broadcast deny or drop', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, store, alpha, beta, director, operator } = fixture;
  const { messagingBus: bus, virtualFs: vfs } = runtime;
  try {
    // --- in-realm direct sends land in each realm's own mailbox -------------
    const alphaSend = bus.sendMessage(
      { from: 'scout', to: 'root', content: 'alpha in-realm report' },
      callContext(alpha.scout)
    );
    assert.equal(alphaSend.success, true, `alpha direct send failed: ${alphaSend.code}`);
    assert.equal(alphaSend.from, 'scout', 'the receipt projects the bare sender id');
    assert.equal(alphaSend.to, 'root', 'the receipt projects the bare recipient id');
    assert.equal(bus.getUnreadCount(alpha.root.key), 1, 'the Alpha root mailbox receives the send');
    assert.equal(bus.getUnreadCount(beta.root.key), 0, 'the Beta root mailbox stays untouched');

    const betaSend = bus.sendMessage(
      { from: 'scout', to: 'root', content: 'beta in-realm report' },
      callContext(beta.scout)
    );
    assert.equal(betaSend.success, true);
    assert.equal(bus.getUnreadCount(beta.root.key), 1, 'the Beta root mailbox receives its own send');
    assert.equal(bus.getUnreadCount(alpha.root.key), 1, 'the Alpha mailbox is not affected by the Beta send');

    const alphaRead = bus.readMessage(alpha.root.key, alphaSend.messageId);
    assert.equal(alphaRead.success, true);
    assert.equal(alphaRead.message.content, 'alpha in-realm report', "Alpha's mail keeps its own bytes");
    assertRealmOpaque(alphaSend, 'the in-realm send receipt');
    assertRealmOpaque(alphaRead.message, 'the in-realm envelope');

    // --- in-realm inline reads the sender's own private workspace -----------
    // The inline sender is a realm-unique caller, so the bus's inline VirtualFS
    // read resolves the caller's private workspace without ambiguity.
    const alphaWrite = vfs.writeFile({ filePath: '/note.md', content: 'alpha-private-note' }, callContext(alpha.scout));
    const betaWrite = vfs.writeFile({ filePath: '/note.md', content: 'beta-private-note' }, callContext(beta.scout));
    const leadWrite = vfs.writeFile({ filePath: '/lead.md', content: 'alpha-lead-note' }, callContext(alpha.lead));
    assert.equal(alphaWrite.success, true);
    assert.equal(betaWrite.success, true);
    assert.equal(leadWrite.success, true);

    const alphaInline = await bus.inlineFileInMessage(
      { filePath: '/lead.md', recipient: 'scout', from: 'alpha_lead', message: 'alpha attachment' },
      { ...callContext(alpha.lead), virtualFs: vfs }
    );
    assert.equal(alphaInline.success, true, `same-realm inline failed: ${alphaInline.error || alphaInline.code}`);
    assert.equal(alphaInline.to, 'scout', 'the inline receipt projects the bare recipient id');
    const inlinedRead = bus.readMessage(alpha.scout.key, alphaInline.messageId);
    assert.equal(inlinedRead.success, true);
    assert.equal(inlinedRead.message.content.includes('alpha-lead-note'), true, "the same-realm inline carries the sender's own bytes");
    assert.equal(inlinedRead.message.content.includes('beta-private-note'), false, 'no cross-realm bytes ride the inline');
    assertRealmOpaque(alphaInline, 'the same-realm inline receipt');
    assertRealmOpaque(inlinedRead.message, 'the same-realm inline envelope');

    // --- same-id sender inline: the trusted canonical callerKey reaches the
    // VirtualFS read, so the shared-id scout resolves realm-exactly ----------
    const sameIdInline = await bus.inlineFileInMessage(
      { filePath: '/note.md', recipient: 'root', from: 'scout', message: 'same-id attachment' },
      { ...callContext(alpha.scout), virtualFs: vfs }
    );
    assert.equal(sameIdInline.success, true, `same-id inline failed: ${sameIdInline.error || sameIdInline.code}`);
    assert.equal(sameIdInline.to, 'root', 'the same-id inline receipt projects the bare recipient id');
    const sameIdRead = bus.readMessage(alpha.root.key, sameIdInline.messageId);
    assert.equal(sameIdRead.success, true);
    assert.equal(sameIdRead.message.content.includes('alpha-private-note'), true, "the same-id inline carries Alpha scout's own bytes");
    assert.equal(sameIdRead.message.content.includes('beta-private-note'), false, 'no foreign bytes ride the same-id inline');
    assertRealmOpaque(sameIdInline, 'the same-id inline receipt');
    assertRealmOpaque(sameIdRead.message, 'the same-id inline envelope');

    // --- cross-realm direct + inline deny with no trace ---------------------
    const auditBefore = bus.getAuditLog().length;
    const crossDirect = bus.sendMessage(
      { from: 'scout', to: 'beta_lead', content: 'cross-realm probe' },
      callContext(alpha.scout)
    );
    assert.equal(crossDirect.success, false, 'a cross-realm direct send denies');
    assert.equal(crossDirect.code, 'PERMISSION_DENIED');
    assert.equal(crossDirect.id, undefined, 'a denied envelope mints no id');
    assert.equal(crossDirect.messageId, undefined);
    assert.equal(bus.getUnreadCount(beta.lead.key), 0, 'the foreign mailbox stays empty');
    assert.equal(bus.getAuditLog().length, auditBefore, 'a denied envelope leaves no audit trace');
    assertRealmOpaque(crossDirect, 'the cross-realm direct denial');

    // The same-literal-id beta scout is equally unreachable from Alpha.
    const crossSameId = bus.sendMessage(
      { from: 'scout', to: beta.scout.key, content: 'same-id cross probe' },
      callContext(alpha.scout)
    );
    assert.equal(crossSameId.success, false, 'the foreign realm same-id registration is never a valid target');
    assert.equal(crossSameId.code, 'PERMISSION_DENIED');
    assert.equal(bus.getUnreadCount(beta.scout.key), 0);

    const crossInline = await bus.inlineFileInMessage(
      { filePath: '/note.md', recipient: 'beta_lead', from: 'scout', message: 'cross attachment' },
      { ...callContext(alpha.scout), virtualFs: vfs }
    );
    assert.equal(crossInline.success, false, 'a cross-realm inline denies before delivery');
    assert.equal(crossInline.code, 'PERMISSION_DENIED');
    assert.equal(crossInline.inlinedFiles, undefined, 'a denied inline exposes no file metadata');
    assert.equal(bus.getUnreadCount(beta.lead.key), 0);
    assertRealmOpaque(crossInline, 'the cross-realm inline denial');

    // --- broadcast stays inside the sender's realm --------------------------
    const broadcast = bus.sendMessage(
      { from: 'scout', to: 'all', content: 'alpha standup' },
      callContext(alpha.scout)
    );
    assert.equal(broadcast.success, true, 'a realm broadcast delivers');
    assert.ok(Array.isArray(broadcast.recipients), 'the broadcast receipt lists recipients');
    assert.ok(broadcast.recipients.includes('root'), 'the same-realm root is a broadcast recipient');
    assert.ok(broadcast.recipients.includes('alpha_lead'), 'the same-realm lead is a broadcast recipient');
    assert.equal(broadcast.recipients.includes('beta_lead'), false, 'no foreign realm member receives the broadcast');
    assert.equal(broadcast.recipients.includes('scout'), false, 'the sender is excluded from its own fan-out');
    assertRealmOpaque(broadcast, 'the realm broadcast receipt');

    // --- operator bypass spans one-way --------------------------------------
    const operatorSend = store.sendMessage('human', 'beta_lead', 'operator directive');
    assert.equal(operatorSend.success, true, `operator send failed: ${operatorSend.code}`);
    assert.equal(operatorSend.to, 'beta_lead', 'the operator receipt projects the bare recipient id');
    assert.equal(bus.getUnreadCount(beta.lead.key), 1, 'the operator principal reaches a realm mailbox');
    assertRealmOpaque(operatorSend, 'the operator send receipt');

    // A bare target that exists in two Realms is never guessed for the operator.
    const operatorAmbiguous = store.sendMessage('human', 'scout', 'ambiguous directive');
    assert.equal(operatorAmbiguous.success, false, 'the operator never picks a Realm for an ambiguous bare target');
    assert.equal(operatorAmbiguous.code, 'PERMISSION_DENIED');
    assertRealmOpaque(operatorAmbiguous, 'the operator ambiguous-target denial');

    // The operator cannot be forged into a realm send: realm agents never
    // address the system-scope director (one-way bypass).
    const toDirector = bus.sendMessage(
      { from: 'scout', to: director.key, content: 'report to system' },
      callContext(alpha.scout)
    );
    assert.equal(toDirector.success, false, 'a realm agent never reaches the system scope');
    assert.equal(toDirector.code, 'PERMISSION_DENIED');
    assert.equal(bus.getUnreadCount(director.key), 0);
    assertRealmOpaque(toDirector, 'the system-scope mail denial');

    // Host-side principal reference stays exact: a lookalike does not bypass.
    const forged = bus.sendMessage(
      { from: 'scout', to: 'beta_lead', content: 'forged bypass' },
      { ...callContext(alpha.scout), principal: { kind: 'internal', subject: 'runtime-engine' } }
    );
    assert.equal(forged.success, false, 'a lookalike principal is not the injected operator reference');
    assert.equal(forged.code, 'PERMISSION_DENIED');
    assertRealmOpaque(forged, 'the forged-principal mail denial');

    // The genuine operator internal principal spans (identity-only reference).
    const spanned = bus.sendMessage(
      { from: 'scout', to: 'beta_lead', content: 'genuine operator span' },
      { ...callContext(alpha.scout), principal: operator }
    );
    assert.equal(spanned.success, true, 'the exact injected operator principal spans realms');
    assert.equal(bus.getUnreadCount(beta.lead.key), 2);
    assertRealmOpaque(spanned, 'the operator-principal span receipt');
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 3. VirtualFS
// ============================================================================

test('3. VFS: canonical private partitions, same-realm mounts, cross-realm denial, masked receipts', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, operator } = fixture;
  const { virtualFs: vfs } = runtime;
  try {
    // --- distinct canonical private workspaces, no bare-id partition --------
    const alphaWrite = vfs.writeFile({ filePath: '/note.md', content: 'alpha-private' }, callContext(alpha.scout));
    const betaWrite = vfs.writeFile({ filePath: '/note.md', content: 'beta-private' }, callContext(beta.scout));
    const leadWrite = vfs.writeFile({ filePath: '/lead.md', content: 'alpha-lead-note' }, callContext(alpha.lead));
    const foreignWrite = vfs.writeFile({ filePath: '/secret.md', content: 'beta-lead-secret' }, callContext(beta.lead));
    assert.equal(alphaWrite.success, true);
    assert.equal(betaWrite.success, true);
    assert.equal(leadWrite.success, true);
    assert.equal(foreignWrite.success, true);
    assert.equal(alphaWrite.workspaceId, 'scout', 'the write receipt projects the bare id label');
    assert.equal(betaWrite.workspaceId, 'scout');
    assertRealmOpaque(alphaWrite, 'the Alpha private write receipt');
    assertRealmOpaque(betaWrite, 'the Beta private write receipt');

    assert.equal(vfs.readFile({ filePath: '/note.md' }, { ...callContext(alpha.scout), raw: true }), 'alpha-private');
    assert.equal(vfs.readFile({ filePath: '/note.md' }, { ...callContext(beta.scout), raw: true }), 'beta-private');

    const snapshot = vfs.exportSnapshot({ principal: operator });
    assert.ok(snapshot[alpha.scout.key], 'Alpha storage is keyed by the canonical identity');
    assert.ok(snapshot[beta.scout.key], 'Beta storage is keyed by the canonical identity');
    assert.equal(snapshot[alpha.scout.key]['/note.md'].content, 'alpha-private');
    assert.equal(snapshot[beta.scout.key]['/note.md'].content, 'beta-private');
    assert.equal(snapshot.scout, undefined, 'no bare-id partition exists for the same-id pair');

    // --- same-realm cross-workspace authority works -------------------------
    const alphaRootDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'root',
      realmId: ALPHA,
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    const mountRead = await alphaRootDispatcher.executeTool('read_file', { file_path: '/agents/scout/note.md' });
    assert.equal(mountRead.success, true, `same-realm mount read failed: ${mountRead.error || mountRead.code}`);
    assert.equal(mountRead.content, 'alpha-private', "the root reads its own realm's scout bytes");
    assertRealmOpaque(mountRead, 'the same-realm mount read receipt');

    const mountListing = await alphaRootDispatcher.executeTool('list_files', { dir_path: '/agents' });
    assert.equal(mountListing.success, true, `realm mount listing failed: ${mountListing.error || mountListing.code}`);
    const mountNames = mountListing.result.map((entry) => entry.name);
    assert.ok(mountNames.includes('scout'), 'the same-realm scout mount is listed');
    assert.ok(mountNames.includes('alpha_lead'), 'the same-realm lead mount is listed');
    assert.equal(mountNames.includes('beta_lead'), false, 'a foreign realm mount is never listed');
    assert.equal(mountNames.includes('director'), false, 'the system scope mount is never listed');
    assertRealmOpaque(mountListing, 'the realm mount listing');

    // --- cross-realm access denies without disclosure -----------------------
    const foreignMount = await alphaRootDispatcher.executeTool('read_file', { file_path: '/agents/beta_lead/secret.md' });
    assert.equal(foreignMount.success, false, 'a cross-realm mount read denies');
    assert.equal(foreignMount.code, 'PERMISSION_DENIED');
    assert.equal(JSON.stringify(foreignMount).includes('beta-lead-secret'), false, 'foreign bytes are never disclosed');
    assertRealmOpaque(foreignMount, 'the cross-realm mount denial');

    const foreignWorkspace = captureThrow(() =>
      vfs.readFile({ filePath: '/secret.md' }, { ...callContext(alpha.root), workspaceId: 'beta_lead' })
    );
    assert.ok(foreignWorkspace, 'an explicit foreign workspace reference fails closed');
    assert.equal(foreignWorkspace.code, 'PERMISSION_DENIED');
    assert.equal(String(foreignWorkspace.message).includes('beta-lead-secret'), false);
    assertRealmOpaque(String(foreignWorkspace.message), 'the foreign workspace error');

    const foreignBytes = vfs.readFile({ filePath: '/secret.md' }, { ...callContext(beta.lead), raw: true });
    assert.equal(foreignBytes, 'beta-lead-secret', 'the foreign bytes are byte-identical after the denied attempts');
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 4. World clock
// ============================================================================

test('4. clock: partitions and events stay realm-isolated; duplicate event ids resolve realm-locally', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, director } = fixture;
  const clock = runtime.worldClock;
  try {
    const alphaContext = callContext(alpha.scout);
    const betaContext = callContext(beta.scout);

    // Own-partition isolation.
    assert.equal(clock.setTime({ totalSeconds: 111 }, alphaContext).success, true);
    assert.equal(clock.setTime({ totalSeconds: 222 }, betaContext).success, true);
    const alphaTime = clock.getTime({}, alphaContext);
    const betaTime = clock.getTime({}, betaContext);
    assert.equal(alphaTime.totalSeconds, 111, 'Alpha keeps its own clock');
    assert.equal(betaTime.totalSeconds, 222, 'Beta keeps its own clock');
    assert.equal(alphaTime.agentId, 'scout', 'the clock receipt projects the bare id');
    assert.equal(betaTime.agentId, 'scout');
    assertRealmOpaque(alphaTime, 'the Alpha clock receipt');
    assertRealmOpaque(betaTime, 'the Beta clock receipt');

    clock.advanceClock({ seconds: 60 }, alphaContext);
    assert.equal(clock.getTime({}, alphaContext).totalSeconds, 171);
    assert.equal(clock.getTime({}, betaContext).totalSeconds, 222, 'advancing Alpha never moves Beta');

    // A realm root's bare target resolves inside its own realm only.
    const rootSet = clock.setTime(
      { totalSeconds: 333, targetAgentId: 'scout' },
      { callerAgentId: alpha.root.id, callerKey: alpha.root.key }
    );
    assert.equal(rootSet.success, true, 'the realm root resolves its own same-id target');
    assert.equal(clock.getTime({}, alphaContext).totalSeconds, 333);
    assert.equal(clock.getTime({}, betaContext).totalSeconds, 222, "the Alpha root's write never reaches Beta");

    // Scoped enumeration per realm; the bypass director spans.
    const alphaRootContext = { callerAgentId: alpha.root.id, callerKey: alpha.root.key };
    const alphaClocks = clock.getAllClocks(alphaRootContext);
    assert.ok(alpha.scout.key in alphaClocks, 'the Alpha scout partition is enumerated');
    assert.equal(beta.scout.key in alphaClocks, false, "Beta's same-id partition is never enumerated");
    assert.equal(alphaClocks[alpha.scout.key].agentId, 'scout', 'listing values project the bare id');
    // The agent-facing clock adapter is realm-opaque (the raw host map is
    // engine-internal partition state exercised above by key).
    const visibleClocks = clock.handleClockTool({ action: 'query', all: true }, alphaRootContext);
    assertRealmOpaque(visibleClocks, 'the agent-facing all-clock receipt');
    assert.equal(JSON.stringify(visibleClocks).includes(beta.scout.key), false, "the agent-facing listing never names Beta's partition");
    const directorClocks = clock.getAllClocks({ callerAgentId: director.id, callerKey: director.key });
    assert.ok(alpha.scout.key in directorClocks && beta.scout.key in directorClocks, 'the director spans both realms');

    // Duplicate event ids resolve realm-locally.
    const alphaEvent = clock.registerEvent(
      { id: 'evt_matrix_beat', name: 'Alpha Beat', targetAgentId: alpha.scout.key },
      { callerAgentId: alpha.root.id, callerKey: alpha.root.key }
    );
    const betaEvent = clock.registerEvent(
      { id: 'evt_matrix_beat', name: 'Beta Beat', targetAgentId: beta.scout.key },
      { callerAgentId: beta.root.id, callerKey: beta.root.key }
    );
    assert.equal(alphaEvent.success, true);
    assert.equal(betaEvent.success, true);
    assert.equal(alphaEvent.event.ownerId, 'scout', 'event ownership projects the bare id');
    assert.equal(alphaEvent.event.createdBy, 'root', 'event attribution projects the bare id');
    assertRealmOpaque(alphaEvent, 'the Alpha event receipt');

    const alphaResolved = clock.resolveEvent({ eventId: 'evt_matrix_beat' }, { callerAgentId: alpha.root.id, callerKey: alpha.root.key });
    const betaResolved = clock.resolveEvent({ eventId: 'evt_matrix_beat' }, { callerAgentId: beta.root.id, callerKey: beta.root.key });
    assert.equal(alphaResolved.success, true);
    assert.equal(alphaResolved.event.name, 'Alpha Beat', "Alpha's duplicate event id resolves to Alpha's event");
    assert.equal(betaResolved.success, true);
    assert.equal(betaResolved.event.name, 'Beta Beat', "Beta's duplicate event id resolves to Beta's event");
    assertRealmOpaque(alphaResolved, 'the Alpha event resolution');

    const alphaQuery = clock.queryEvents({ status: 'all', all: true }, alphaContext);
    assert.deepEqual(alphaQuery.events.map((event) => event.name), ['Alpha Beat'], 'a realm-bound query never spans realms');
    const betaQuery = clock.queryEvents({ status: 'all', all: true }, betaContext);
    assert.deepEqual(betaQuery.events.map((event) => event.name), ['Beta Beat']);
    assertRealmOpaque(alphaQuery, 'the Alpha event query');
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 5. Trigger queue
// ============================================================================

test('5. triggers: a realm source wakes same-realm and bypass targets only; foreign/ambiguous targets drop', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, director } = fixture;
  const queue = runtime.triggerQueue;
  try {
    const alphaRootAgent = runtime.getAgent(alpha.root.key);
    const betaRootAgent = runtime.getAgent(beta.root.key);
    assert.ok(alphaRootAgent && betaRootAgent, 'fixture: both realm roots are active');
    const alphaBefore = alphaRootAgent.history.length;
    const betaBefore = betaRootAgent.history.length;

    // Same-realm wake: Alpha scout -> Alpha root (canonical source key).
    queue.enqueue({
      type: TRIGGER_TYPES.SCHEDULE,
      targetAgentId: alpha.root.key,
      sourceKey: alpha.scout.key,
      source: 'scout',
      payload: { prompt: 'alpha wake' }
    });
    // Foreign wake: Alpha scout -> Beta root. Must drop.
    queue.enqueue({
      type: TRIGGER_TYPES.SCHEDULE,
      targetAgentId: beta.root.key,
      sourceKey: alpha.scout.key,
      source: 'scout',
      payload: { prompt: 'foreign wake' }
    });
    // Bypass wake: the system director -> Beta root. Must dispatch.
    queue.enqueue({
      type: TRIGGER_TYPES.SCHEDULE,
      targetAgentId: beta.root.key,
      sourceKey: director.key,
      source: 'director',
      payload: { prompt: 'bypass wake' }
    });
    // Ambiguous bare target with a realm source: must drop like a foreign one.
    queue.enqueue({
      type: TRIGGER_TYPES.SCHEDULE,
      targetAgentId: 'scout',
      sourceKey: alpha.root.key,
      source: 'root',
      payload: { prompt: 'ambiguous wake' }
    });
    // Self wake by canonical key: must dispatch.
    queue.enqueue({
      type: TRIGGER_TYPES.SCHEDULE,
      targetAgentId: beta.root.key,
      sourceKey: beta.root.key,
      source: 'root',
      payload: { prompt: 'self wake' }
    });

    await queue.processTick();
    await settle(120);

    const alphaTurns = (alphaRootAgent.history.length - alphaBefore) / 2;
    const betaTurns = (betaRootAgent.history.length - betaBefore) / 2;
    assert.equal(alphaTurns, 1, 'exactly the same-realm wake ran for Alpha');
    assert.equal(betaTurns, 2, 'exactly the bypass and self wakes ran for Beta');
    assert.equal(queue.getPendingCount(), 0, 'every denied trigger is dropped, never re-queued');
    assert.deepEqual(queue.getPendingTriggers(), [], 'no pending trigger remains');
    assertRealmOpaque(queue.getPendingTriggers(), 'the trigger diagnostics');
    assert.equal(JSON.stringify(runtime.listAgents({ realmId: ALPHA }).map((agent) => agent.id)).includes('realm:'), false);
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 6. Scheduler
// ============================================================================

test('6. scheduler: schedules are realm-owned, listings scoped, and teardown realm-exact', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, operator } = fixture;
  try {
    // Realm-unique leads arm timers for the shared bare-id scout in each realm.
    const alphaArm = runtime.schedule(
      { agentId: 'scout', prompt: 'alpha wake', durationSeconds: LONG_DELAY_SECONDS, timerCondition: 'never' },
      { principal: alpha.lead.authority, callerKey: alpha.lead.key }
    );
    const betaArm = runtime.schedule(
      { agentId: 'scout', prompt: 'beta wake', durationSeconds: LONG_DELAY_SECONDS, timerCondition: 'never' },
      { principal: beta.lead.authority, callerKey: beta.lead.key }
    );
    assert.equal(alphaArm.success, true, `Alpha arm failed: ${alphaArm.code}`);
    assert.equal(betaArm.success, true, `Beta arm failed: ${betaArm.code}`);
    assert.equal(alphaArm.targetAgentId, 'scout', 'the receipt projects the bare target id');
    assert.equal(betaArm.targetAgentId, 'scout');
    assertRealmOpaque(alphaArm, 'the Alpha schedule receipt');
    assertRealmOpaque(betaArm, 'the Beta schedule receipt');
    assert.notEqual(alphaArm.timerId, betaArm.timerId);

    // Host export projects bare ids while keeping the dispatch refs internal.
    const exported = runtime.exportSchedules().filter((entry) => entry.status === 'pending');
    assert.equal(exported.length, 2, 'both realm timers are armed');
    for (const entry of exported) {
      assert.equal(entry.agentId, 'scout', 'the host export projects the bare target id');
      assert.equal(entry.targetAgentId, 'scout');
    }
    assert.notEqual(
      exported.find((entry) => entry.timerId === alphaArm.timerId).agentRef,
      exported.find((entry) => entry.timerId === betaArm.timerId).agentRef,
      'the two same-id timers keep distinct internal dispatch refs'
    );

    // Scoped listing: each realm lead sees its own realm's timer only.
    const alphaList = runtime.listSchedules({ status: 'all' }, { principal: alpha.lead.authority, callerKey: alpha.lead.key });
    assert.equal(alphaList.success, true);
    assert.deepEqual(alphaList.schedules.map((entry) => entry.timerId), [alphaArm.timerId], 'Alpha lists its own timer only');
    assertRealmOpaque(alphaList, 'the Alpha scoped listing');
    const betaList = runtime.listSchedules({ status: 'all' }, { principal: beta.lead.authority, callerKey: beta.lead.key });
    assert.deepEqual(betaList.schedules.map((entry) => entry.timerId), [betaArm.timerId], 'Beta lists its own timer only');
    const directorList = runtime.listSchedules({ status: 'all' }, { principal: fixture.director.authority, callerKey: fixture.director.key });
    assert.equal(directorList.schedules.length, 2, 'the bypass director spans both realm listings');

    // Cross-realm arming and cancellation deny; the foreign timer stays armed.
    const crossArm = runtime.schedule(
      { agentId: 'beta_lead', prompt: 'foreign arm', durationSeconds: LONG_DELAY_SECONDS },
      { principal: alpha.lead.authority, callerKey: alpha.lead.key }
    );
    assert.equal(crossArm.success, false, 'a realm lead cannot arm a foreign-realm timer');
    assert.equal(crossArm.code, 'PERMISSION_DENIED');
    assertRealmOpaque(crossArm, 'the cross-realm arm denial');
    const crossCancel = runtime.cancelSchedule(betaArm.timerId, 'foreign cancel', {
      principal: alpha.lead.authority,
      callerKey: alpha.lead.key
    });
    assert.equal(crossCancel.success, false, 'a realm lead cannot cancel a foreign-realm timer');
    assert.equal(crossCancel.code, 'PERMISSION_DENIED');
    assertRealmOpaque(crossCancel, 'the cross-realm cancel denial');
    assert.equal(
      runtime.exportSchedules().find((entry) => entry.timerId === betaArm.timerId).status,
      'pending',
      'the foreign timer survives the denied cancel'
    );

    // Kill teardown: killing Alpha's scout cancels Alpha's timer only.
    runtime.killAgent(alpha.scout.key, 'matrix kill', { principal: operator });
    const afterKill = runtime.exportSchedules();
    assert.equal(afterKill.find((entry) => entry.timerId === alphaArm.timerId).status, 'cancelled', "Alpha's timer is torn down");
    assert.equal(afterKill.find((entry) => entry.timerId === betaArm.timerId).status, 'pending', "Beta's same-id timer stays armed");
    runtime.restoreAgent(alpha.scout.key, { principal: operator });
  } finally {
    destroyMatrixFixture(fixture);
  }
});

test('6b. scheduler: a bare-ref pre-launch schedule is torn down on kill without touching the other realm', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, operator, port } = fixture;
  try {
    // Operator arms a bare-ref schedule before the agent exists anywhere.
    const preLaunch = runtime.schedule(
      { agentId: 'relay', prompt: 'pre-launch wake', durationSeconds: LONG_DELAY_SECONDS, timerCondition: 'never' },
      { principal: operator }
    );
    assert.equal(preLaunch.success, true, `pre-launch arm failed: ${preLaunch.code}`);
    assert.equal(preLaunch.targetAgentId, 'relay', 'the pre-launch receipt projects the bare reference');

    // The same literal id now launches in both realms; each realm lead arms
    // its own realm-exact timer for it.
    await fixture.store.launchAgent({ id: 'relay', realmId: ALPHA, allowedTools: ['read_file'] }, createDeterministicModel('alpha relay output'));
    await fixture.store.launchAgent({ id: 'relay', realmId: BETA, allowedTools: ['read_file'] }, createDeterministicModel('beta relay output'));
    const alphaRelay = port.getAgentIdentity('relay', { realmId: ALPHA });
    const betaRelay = port.getAgentIdentity('relay', { realmId: BETA });
    assert.ok(alphaRelay && betaRelay);
    assert.notEqual(alphaRelay.key, betaRelay.key);

    const alphaArm = runtime.schedule(
      { agentId: 'relay', prompt: 'alpha relay wake', durationSeconds: LONG_DELAY_SECONDS },
      { principal: fixture.alpha.lead.authority, callerKey: fixture.alpha.lead.key }
    );
    const betaArm = runtime.schedule(
      { agentId: 'relay', prompt: 'beta relay wake', durationSeconds: LONG_DELAY_SECONDS },
      { principal: fixture.beta.lead.authority, callerKey: fixture.beta.lead.key }
    );
    assert.equal(alphaArm.success, true);
    assert.equal(betaArm.success, true);

    // Killing Alpha's relay tears down the pre-launch bare-ref task and the
    // Alpha canonical task; Beta's canonical task is untouched.
    runtime.killAgent(alphaRelay.key, 'relay kill', { principal: operator });
    const exported = runtime.exportSchedules();
    assert.equal(exported.find((entry) => entry.timerId === preLaunch.timerId).status, 'cancelled', 'the bare-ref pre-launch schedule is torn down');
    assert.equal(exported.find((entry) => entry.timerId === alphaArm.timerId).status, 'cancelled', "Alpha's canonical timer is torn down");
    assert.equal(exported.find((entry) => entry.timerId === betaArm.timerId).status, 'pending', "Beta's same-literal-id timer stays armed");

    runtime.restoreAgent(alphaRelay.key, { principal: operator });
  } finally {
    destroyMatrixFixture(fixture);
  }
});

test('6c. scheduler: a same-id realm root arms, lists, and tears down realm-exactly', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, operator } = fixture;
  try {
    // Same-literal-id roots arm their own realm's scout via the trusted
    // principal + canonical callerKey (both bare subjects are ambiguous).
    const alphaArm = runtime.schedule(
      { agentId: 'scout', prompt: 'alpha root wake', durationSeconds: LONG_DELAY_SECONDS, timerCondition: 'never' },
      { principal: alpha.root.authority, callerKey: alpha.root.key }
    );
    const betaArm = runtime.schedule(
      { agentId: 'scout', prompt: 'beta root wake', durationSeconds: LONG_DELAY_SECONDS, timerCondition: 'never' },
      { principal: beta.root.authority, callerKey: beta.root.key }
    );
    assert.equal(alphaArm.success, true, `same-id root arm failed: ${alphaArm.code}`);
    assert.equal(betaArm.success, true, `same-id root arm failed: ${betaArm.code}`);
    assert.equal(alphaArm.targetAgentId, 'scout', 'the receipt projects the bare target id');
    assert.equal(betaArm.targetAgentId, 'scout');
    assertRealmOpaque(alphaArm, 'the same-id root schedule receipt');

    // Canonical dispatch refs: each timer addresses the exact registration.
    const exported = runtime.exportSchedules();
    assert.equal(
      exported.find((entry) => entry.timerId === alphaArm.timerId).agentRef,
      alpha.scout.key,
      "Alpha's timer dispatches to Alpha's canonical scout key"
    );
    assert.equal(
      exported.find((entry) => entry.timerId === betaArm.timerId).agentRef,
      beta.scout.key,
      "Beta's timer dispatches to Beta's canonical scout key"
    );

    // Scoped listing per same-id root; the director still spans.
    const alphaList = runtime.listSchedules({ status: 'all' }, { principal: alpha.root.authority, callerKey: alpha.root.key });
    assert.deepEqual(alphaList.schedules.map((entry) => entry.timerId), [alphaArm.timerId], 'the Alpha root lists its own timer only');
    assertRealmOpaque(alphaList, 'the same-id root scoped listing');
    const betaList = runtime.listSchedules({ status: 'all' }, { principal: beta.root.authority, callerKey: beta.root.key });
    assert.deepEqual(betaList.schedules.map((entry) => entry.timerId), [betaArm.timerId], 'the Beta root lists its own timer only');
    const directorList = runtime.listSchedules({ status: 'all' }, { principal: fixture.director.authority, callerKey: fixture.director.key });
    assert.equal(directorList.schedules.length, 2, 'the bypass director spans both root listings');

    // A canonical caller claim resolves the same realm-exact scope.
    const claimedArm = runtime.schedule(
      { agentId: 'scout', prompt: 'alpha claimed wake', durationSeconds: LONG_DELAY_SECONDS },
      { callerAgentId: alpha.root.key, callerKey: alpha.root.key }
    );
    assert.equal(claimedArm.success, true, `canonical claim arm failed: ${claimedArm.code}`);
    assert.equal(runtime.exportSchedules().find((entry) => entry.timerId === claimedArm.timerId).agentRef, alpha.scout.key);

    // Cross-realm arm/cancel deny for the same-id root; foreign timer survives.
    const crossArm = runtime.schedule(
      { agentId: 'beta_lead', prompt: 'foreign arm', durationSeconds: LONG_DELAY_SECONDS },
      { principal: alpha.root.authority, callerKey: alpha.root.key }
    );
    assert.equal(crossArm.success, false, 'a same-id root cannot arm a foreign-realm timer');
    assert.equal(crossArm.code, 'PERMISSION_DENIED');
    assertRealmOpaque(crossArm, 'the same-id root cross-realm arm denial');
    const crossCancel = runtime.cancelSchedule(betaArm.timerId, 'foreign cancel', {
      principal: alpha.root.authority,
      callerKey: alpha.root.key
    });
    assert.equal(crossCancel.success, false, 'a same-id root cannot cancel a foreign-realm timer');
    assert.equal(crossCancel.code, 'PERMISSION_DENIED');
    assert.equal(runtime.exportSchedules().find((entry) => entry.timerId === betaArm.timerId).status, 'pending');

    // Realm-exact teardown: killing Alpha's scout cancels both Alpha timers
    // and leaves Beta's same-id timer armed.
    runtime.killAgent(alpha.scout.key, 'matrix kill', { principal: operator });
    const afterKill = runtime.exportSchedules();
    assert.equal(afterKill.find((entry) => entry.timerId === alphaArm.timerId).status, 'cancelled', "Alpha's root timer is torn down");
    assert.equal(afterKill.find((entry) => entry.timerId === claimedArm.timerId).status, 'cancelled', 'the canonical-claim timer is torn down');
    assert.equal(afterKill.find((entry) => entry.timerId === betaArm.timerId).status, 'pending', "Beta's same-id root timer stays armed");
    runtime.restoreAgent(alpha.scout.key, { principal: operator });
  } finally {
    destroyMatrixFixture(fixture);
  }
});

test('6d. scheduler tool lane: a same-id caller arms, lists, and cancels realm-exactly; a stale pinned key fails closed', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, operator } = fixture;
  try {
    /**
     * Builds a realm-bound scheduler-tool dispatcher for the shared-id root.
     *
     * @param {string} realmId - Realm scope pinned at construction.
     * @returns {Function} Bound tool dispatcher.
     */
    const rootDispatcher = (realmId) => createSandboxToolDispatcher({
      runtime,
      agentId: 'root',
      realmId,
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    const alphaRoot = rootDispatcher(ALPHA);
    const betaRoot = rootDispatcher(BETA);

    // The tool lane must resolve the same-id caller realm-exactly and store its
    // canonical dispatch ref on the armed task (pre-fix: a bare `agentRef`).
    const alphaArm = await alphaRoot.executeTool('schedule', {
      action: 'create',
      prompt: 'alpha root tool wake',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(alphaArm.success, true, `the same-id root tool schedule must arm: ${JSON.stringify(alphaArm)}`);
    assert.equal(alphaArm.targetAgentId, 'root', 'the tool receipt projects the bare target id');
    assertRealmOpaque(alphaArm, 'the same-id root tool schedule receipt');
    assert.equal(
      runtime.exportSchedules().find((entry) => entry.timerId === alphaArm.timerId).agentRef,
      alpha.root.key,
      "the Alpha root's tool timer dispatches to Alpha's canonical key"
    );

    const betaArm = await betaRoot.executeTool('schedule', {
      action: 'create',
      prompt: 'beta root tool wake',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(betaArm.success, true, `the Beta same-id root tool schedule must arm: ${JSON.stringify(betaArm)}`);
    assert.equal(
      runtime.exportSchedules().find((entry) => entry.timerId === betaArm.timerId).agentRef,
      beta.root.key,
      "the Beta root's tool timer dispatches to Beta's canonical key"
    );

    // Tool-lane listings stay realm-scoped for the same-id pair.
    const alphaListing = await alphaRoot.executeTool('list_schedules', {});
    assert.equal(alphaListing.success, true, `the same-id root tool listing must succeed: ${JSON.stringify(alphaListing)}`);
    assert.deepEqual(
      alphaListing.schedules.map((entry) => entry.timerId),
      [alphaArm.timerId],
      'the Alpha root lists its own tool timer only'
    );
    assertRealmOpaque(alphaListing, 'the same-id root tool listing');
    const betaListing = await betaRoot.executeTool('list_schedules', {});
    assert.deepEqual(
      betaListing.schedules.map((entry) => entry.timerId),
      [betaArm.timerId],
      'the Beta root lists its own tool timer only'
    );

    // The caller cancels its own timer; the foreign same-id timer stays armed.
    const alphaCancel = await alphaRoot.executeTool('cancel_schedule', { task_id: alphaArm.timerId });
    assert.equal(alphaCancel.success, true, `the same-id root must cancel its own timer: ${JSON.stringify(alphaCancel)}`);
    assert.equal(
      runtime.exportSchedules().find((entry) => entry.timerId === alphaArm.timerId).status,
      'cancelled',
      'the Alpha root tool timer is cancelled'
    );
    assertRealmOpaque(alphaCancel, 'the same-id root tool cancel receipt');
    const crossCancel = await alphaRoot.executeTool('cancel_schedule', { task_id: betaArm.timerId });
    assert.equal(crossCancel.success, false, 'the same-id root cannot cancel the foreign realm timer');
    assert.equal(crossCancel.code, 'PERMISSION_DENIED');
    assertRealmOpaque(crossCancel, 'the same-id root cross-realm tool cancel denial');
    assert.equal(
      runtime.exportSchedules().find((entry) => entry.timerId === betaArm.timerId).status,
      'pending',
      'the foreign same-id timer survives the denied tool cancel'
    );

    // A dispatcher holding a stale pinned key (built before the recycle) fails
    // closed on every scheduler tool: no retarget, no anonymous degradation.
    const staleRoot = createSandboxToolDispatcher({
      runtime,
      agentId: 'root',
      callerAgentId: 'root',
      callerKey: alpha.root.key,
      allowedTools: ['schedule', 'list_schedules', 'cancel_schedule'],
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    runtime.killAgent(alpha.root.key, 'matrix stale tool probe', { principal: operator });
    assert.ok(runtime.getAgent(beta.root.key), 'the Beta same-id root stays active');

    const staleArm = await staleRoot.executeTool('schedule', {
      action: 'create',
      prompt: 'stale root tool wake',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(staleArm.success, false, `the stale-key tool schedule must fail closed: ${JSON.stringify(staleArm)}`);
    assert.equal(staleArm.code, 'PERMISSION_DENIED', 'the stale-key tool denial uses PERMISSION_DENIED');
    assert.equal(
      runtime.exportSchedules().some((entry) => entry.status === 'pending' && entry.prompt === 'stale root tool wake'),
      false,
      'the stale-key tool arm stores no task'
    );
    assertRealmOpaque(staleArm, 'the stale-key tool schedule denial');
    const staleListing = await staleRoot.executeTool('list_schedules', {});
    assert.equal(staleListing.success, false, 'the stale-key tool listing fails closed');
    assert.equal(staleListing.code, 'PERMISSION_DENIED');
    const staleCancel = await staleRoot.executeTool('cancel_schedule', { task_id: betaArm.timerId });
    assert.equal(staleCancel.success, false, 'the stale-key tool cancel fails closed');
    assert.equal(staleCancel.code, 'PERMISSION_DENIED');
    assert.equal(
      runtime.exportSchedules().find((entry) => entry.timerId === betaArm.timerId).status,
      'pending',
      'the Beta timer survives the stale-key tool cancel'
    );

    runtime.restoreAgent(alpha.root.key, { principal: operator });
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 7. Invocation
// ============================================================================

test('7. invocation: same-realm output returns, cross-realm pairs deny, bypass grants span', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, store, alpha, beta, director, operator } = fixture;
  try {
    // --- same-realm invoke returns the target's real turn output ------------
    const sameRealm = runtime.invokeAgent(alpha.root.key, alpha.scout.key, 'collect alpha report');
    assert.equal(sameRealm.success, true, `same-realm invoke failed: ${sameRealm.code}`);
    assert.equal(sameRealm.status, 'dispatched');
    assert.equal(sameRealm.targetAgentId, 'scout', 'the receipt projects the bare target id');
    assertRealmOpaque(sameRealm, 'the same-realm invocation receipt');
    const sameWait = await runtime.waitForInvocation({ invocationIds: [sameRealm.invocationId], timeout_ms: 3000 });
    assert.equal(sameWait.success, true, 'the invocation settles');
    assert.equal(sameWait.results[0].output, 'alpha scout output', "the caller receives Alpha scout's own output");
    assertRealmOpaque(sameWait, 'the same-realm invocation result');

    // --- the other realm's same-id registration is never the target ---------
    const sameIdCross = runtime.invokeAgent(alpha.root.key, beta.scout.key, 'collect beta report');
    assert.equal(sameIdCross.success, false, 'a bare-equal cross-realm invocation denies');
    assert.equal(sameIdCross.code, 'PERMISSION_DENIED');
    assertRealmOpaque(sameIdCross, 'the same-id cross-realm denial');

    // --- distinct-id cross-realm deny ---------------------------------------
    const crossRealm = runtime.invokeAgent(alpha.root.key, beta.lead.key, 'collect foreign report');
    assert.equal(crossRealm.success, false, 'wildcard authority never escapes the realm');
    assert.equal(crossRealm.code, 'PERMISSION_DENIED');
    assertRealmOpaque(crossRealm, 'the cross-realm invocation denial');

    // --- the director (system bypass) spans --------------------------------
    const bypass = runtime.invokeAgent(director.key, beta.lead.key, 'system directive');
    assert.equal(bypass.success, true, `director invoke failed: ${bypass.code}`);
    assert.equal(bypass.targetAgentId, 'beta_lead');
    const bypassWait = await runtime.waitForInvocation({ invocationIds: [bypass.invocationId], timeout_ms: 3000 });
    assert.equal(bypassWait.success, true);
    assert.equal(bypassWait.results[0].output, 'beta lead output', 'the bypass invoker receives the foreign output');
    assertRealmOpaque(bypassWait, 'the bypass invocation result');

    // --- an operator-granted bypass caller spans ----------------------------
    const beforeGrant = runtime.invokeAgent(alpha.lead.key, beta.lead.key, 'pre-grant probe');
    assert.equal(beforeGrant.success, false, 'a wildcard realm caller is still realm-bound before the grant');
    assert.equal(beforeGrant.code, 'PERMISSION_DENIED');

    const grant = runtime.grantRealmBypass('alpha_lead', { principal: operator });
    assert.ok(grant, 'the operator grant resolves the descriptor');
    assert.equal(grant.realmBypass, true, 'the rebuilt descriptor carries the grant');
    assert.equal(grant.allow.has('*'), true, 'the grant never widens or narrows capability');
    assert.equal(runtime.createAgentIdentityPort().getAgentIdentity(alpha.lead.key).realmBypass, true, 'the identity projection reflects the grant');

    const granted = runtime.invokeAgent(alpha.lead.key, beta.lead.key, 'granted span');
    assert.equal(granted.success, true, `granted bypass invoke failed: ${granted.code}`);
    const grantedWait = await runtime.waitForInvocation({ invocationIds: [granted.invocationId], timeout_ms: 3000 });
    assert.equal(grantedWait.success, true);
    assert.equal(grantedWait.results[0].output, 'beta lead output', 'the granted caller receives the foreign output');
    assertRealmOpaque(granted, 'the granted invocation receipt');

    // Revocation restores the boundary.
    const revoke = runtime.revokeRealmBypass('alpha_lead', { principal: operator });
    assert.equal(revoke.realmBypass, false, 'the operator can revoke the grant');
    const afterRevoke = runtime.invokeAgent(alpha.lead.key, beta.lead.key, 'post-revoke probe');
    assert.equal(afterRevoke.success, false, 'the revoked caller is realm-bound again');
    assert.equal(afterRevoke.code, 'PERMISSION_DENIED');

    // --- scoped grant/revoke addresses an exact same-id registration --------
    const rootPort = runtime.createAgentIdentityPort();
    const rootGrant = runtime.grantRealmBypass(alpha.root.key, { principal: operator });
    assert.ok(rootGrant, 'the operator resolves the same-id root by canonical key');
    assert.equal(rootGrant.realmBypass, true, 'the rebuilt descriptor carries the grant');
    assert.equal(rootGrant.subject, 'root', 'the descriptor keeps the bare realm-local subject');
    assert.equal(rootPort.getAgentIdentity(alpha.root.key).realmBypass, true, 'only the Alpha root carries the grant');
    assert.equal(rootPort.getAgentIdentity(beta.root.key).realmBypass, false, 'the Beta same-id root stays un-granted');

    const rootSpan = runtime.invokeAgent(alpha.root.key, beta.lead.key, 'root grant span');
    assert.equal(rootSpan.success, true, `granted same-id root invoke failed: ${rootSpan.code}`);
    const rootSpanWait = await runtime.waitForInvocation({ invocationIds: [rootSpan.invocationId], timeout_ms: 3000 });
    assert.equal(rootSpanWait.success, true);
    assert.equal(rootSpanWait.results[0].output, 'beta lead output', 'the granted same-id root receives the foreign output');
    const rootRevoke = runtime.revokeRealmBypass(alpha.root.key, { principal: operator });
    assert.equal(rootRevoke.realmBypass, false, 'the canonical-key revoke clears exactly the Alpha root');
    assert.equal(rootPort.getAgentIdentity(alpha.root.key).realmBypass, false);
    assert.equal(rootPort.getAgentIdentity(beta.root.key).realmBypass, false);
    const rootPostRevoke = runtime.invokeAgent(alpha.root.key, beta.lead.key, 'root post-revoke probe');
    assert.equal(rootPostRevoke.success, false, 'the revoked same-id root is realm-bound again');
    assert.equal(rootPostRevoke.code, 'PERMISSION_DENIED');

    // Store path: an explicit realm scope composes the canonical key, so the
    // Beta same-id root is granted without touching the Alpha registration.
    const scopedGrant = await store.grantRealmBypass('root', { realmId: BETA });
    assert.ok(scopedGrant, 'the store resolves the scoped same-id target');
    assert.equal(scopedGrant.realmBypass, true);
    assert.equal(scopedGrant.subject, 'root');
    assert.equal(rootPort.getAgentIdentity(beta.root.key).realmBypass, true, 'the Beta root receives the scoped grant');
    assert.equal(rootPort.getAgentIdentity(alpha.root.key).realmBypass, false, 'the Alpha same-id root stays un-granted');
    const scopedRevoke = await store.revokeRealmBypass('root', { realmId: BETA });
    assert.equal(scopedRevoke.realmBypass, false, 'the scoped revoke clears the Beta root');
    assert.equal(rootPort.getAgentIdentity(beta.root.key).realmBypass, false);

    // An ambiguous bare id without a scope still fails closed (no grant minted).
    assert.equal(await store.grantRealmBypass('root'), null, 'an unscoped ambiguous bare id mints no grant');
    assert.equal(rootPort.getAgentIdentity(alpha.root.key).realmBypass, false);
    assert.equal(rootPort.getAgentIdentity(beta.root.key).realmBypass, false);

    // --- tool path: a realm-bound same-id root invokes its own realm's
    // same-id scout by bare id (Wave I, ticket d57cbc1; fix lane F4) ---------
    // The per-call identity/realm claims below are stripped: the trusted bound
    // caller must win over the forged context.
    const sameIdToolRoot = createSandboxToolDispatcher({
      runtime,
      agentId: 'root',
      realmId: ALPHA,
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    const toolInvoke = await sameIdToolRoot.executeTool(
      'invoke_agent',
      { agent_id: 'scout', prompt: 'tool same-id task', timeout_ms: 3000 },
      { callerAgentId: 'beta_root', agentId: 'beta_root', callerKey: beta.root.key, realmId: BETA }
    );
    assert.equal(toolInvoke.success, true, `the same-id root tool invoke must dispatch: ${toolInvoke.error || toolInvoke.code}`);
    assert.equal(toolInvoke.status, 'dispatched', 'the tool invoke dispatches a turn');
    assert.equal(toolInvoke.targetAgentId, 'scout', 'the tool invoke receipt projects the bare target id');
    assertRealmOpaque(toolInvoke, 'the same-id root tool invoke receipt');

    const toolWait = await sameIdToolRoot.executeTool('wait_for_invocation', {
      invocation_ids: [toolInvoke.invocationId],
      timeout_ms: 3000
    });
    assert.equal(toolWait.success, true, `the same-id root tool await must resolve: ${toolWait.error || toolWait.code}`);
    assert.equal(toolWait.results[0].output, 'alpha scout output', "the tool caller receives Alpha scout's own output");
    assertRealmOpaque(toolWait, 'the same-id root tool await result');

    // A dispatcher without a trusted realm scope (ambiguous bare caller) stays
    // fail-closed: no caller claim may widen the invocation.
    const unscopedRoot = createSandboxToolDispatcher({
      runtime,
      agentId: 'root',
      privileged: true,
      allowedTools: ['*'],
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    const ambiguousInvoke = await unscopedRoot.executeTool('invoke_agent', {
      agent_id: 'scout',
      prompt: 'ambiguous tool task'
    });
    assert.equal(ambiguousInvoke.success, false, 'an ambiguous bare caller/target pair stays fail-closed');
    assert.equal(ambiguousInvoke.invocationId, undefined, 'no invocation is dispatched for the ambiguous pair');
    assertRealmOpaque(ambiguousInvoke, 'the ambiguous tool invoke denial');
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 8. Lifecycle
// ============================================================================

test('8. lifecycle: kill/restore/purge stay realm-exact; the system scope is unreachable to non-bypass callers', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, alpha, beta, director, operator } = fixture;
  try {
    // --- a same-id realm root resolves its own realm view -------------------
    const sameIdRootPort = runtime.createLifecyclePort();
    const rootViewByPrincipal = sameIdRootPort.listAgents({}, { principal: alpha.root.authority, callerKey: alpha.root.key });
    assert.deepEqual(
      rootViewByPrincipal.map((agent) => agent.id).sort(),
      ['alpha_lead', 'root', 'scout'],
      'a same-id root lists its own realm through the trusted principal + canonical key'
    );
    const rootViewByKey = sameIdRootPort.listAgents({}, { callerAgentId: alpha.root.key, callerKey: alpha.root.key });
    assert.deepEqual(
      rootViewByKey.map((agent) => agent.id).sort(),
      ['alpha_lead', 'root', 'scout'],
      'a canonical caller claim resolves the same realm-exact view'
    );
    assert.equal(rootViewByKey.some((agent) => agent.id === 'beta_lead'), false, 'no foreign member leaks into the same-id root view');
    assert.equal(rootViewByKey.some((agent) => agent.id === 'director'), false, 'the system scope stays unreachable in the same-id root view');
    assert.deepEqual(
      sameIdRootPort.listAgents({}, { callerAgentId: 'root', callerKey: alpha.root.key }),
      [],
      'an ambiguous bare claim without the canonical claim form stays fail-closed'
    );
    assert.deepEqual(
      sameIdRootPort.listAgents({}, { callerAgentId: 'root' }),
      [],
      'an ambiguous bare claim without any key stays fail-closed'
    );

    // --- operator kill of one realm's scout never touches the other ---------
    runtime.killAgent(alpha.scout.key, 'matrix kill', { principal: operator });
    assert.equal(runtime.hasRecycledAgent(alpha.scout.key), true, 'Alpha scout is recycled');
    assert.equal(runtime.hasRecycledAgent(beta.scout.key), false, 'Beta scout stays active');
    assert.ok(runtime.getAgent(beta.scout.key), 'the Beta registration is untouched');
    assert.equal(runtime.getAgent(alpha.scout.key), null, 'the recycled Alpha registration is not an active lookup');

    // --- restore is realm-exact too -----------------------------------------
    const restored = runtime.restoreAgent(alpha.scout.key, { principal: operator });
    assert.equal(restored.id, 'scout', 'the Alpha registration is restored');
    assert.ok(runtime.getAgent(beta.scout.key), 'Beta scout is still active');
    assert.equal(runtime.getAgent(alpha.scout.key).state, 'idle');

    // --- a same-id realm root kills only its own realm's registration -------
    runtime.killAgent(alpha.scout.key, 'realm-local kill', { callerAgentId: alpha.root.key, callerKey: alpha.root.key });
    assert.equal(runtime.hasRecycledAgent(alpha.scout.key), true, "Alpha's root kills Alpha's scout");
    assert.equal(runtime.hasRecycledAgent(beta.scout.key), false, "Beta's scout is untouched by Alpha's root");
    runtime.restoreAgent(alpha.scout.key, { principal: operator });

    // Cross-realm kill through the agent tool path denies and mutates nothing.
    const alphaLeadDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'alpha_lead',
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    const foreignKill = await alphaLeadDispatcher.executeTool('kill_agent', { agent_id: 'beta_lead' });
    assert.equal(foreignKill.success, false, 'a realm lead cannot kill a foreign-realm agent');
    assert.equal(foreignKill.code, 'PERMISSION_DENIED');
    assert.equal(runtime.hasRecycledAgent(beta.lead.key), false, 'the denied kill leaves the foreign target active');
    assertRealmOpaque(foreignKill, 'the cross-realm kill denial');

    // The same tool path resolves a bare same-id target inside its own realm.
    const localKill = await alphaLeadDispatcher.executeTool('kill_agent', { agent_id: 'scout' });
    assert.equal(localKill.success, true, `the same-realm bare target must resolve realm-locally: ${localKill.error || localKill.code}`);
    assert.equal(runtime.hasRecycledAgent(alpha.scout.key), true, "the Alpha lead kills Alpha's scout");
    assert.equal(runtime.hasRecycledAgent(beta.scout.key), false, "the Beta same-id registration is untouched");
    assertRealmOpaque(localKill, 'the realm-local kill receipt');
    runtime.restoreAgent(alpha.scout.key, { principal: operator });

    // --- purge in one realm never touches the other's same-id agent ---------
    runtime.killAgent(alpha.scout.key, 'purge fixture', { principal: operator });
    runtime.killAgent(beta.scout.key, 'purge fixture', { principal: operator });
    assert.equal(runtime.purgeAgent(alpha.scout.key, { principal: operator }), true, 'the Alpha registration is purged');
    assert.equal(runtime.hasRecycledAgent(alpha.scout.key), false, 'the purged Alpha registration is gone');
    assert.equal(runtime.hasRecycledAgent(beta.scout.key), true, 'the Beta registration is still recycled');
    assert.equal(runtime.restoreAgent(beta.scout.key, { principal: operator }).id, 'scout', 'the Beta registration still restores');

    // --- the system scope is unreachable to non-bypass callers --------------
    const alphaLeadPort = runtime.createLifecyclePort();
    const visible = alphaLeadPort.listAgents({}, { callerAgentId: alpha.lead.id, callerKey: alpha.lead.key });
    const visibleIds = visible.map((agent) => agent.id).sort();
    assert.deepEqual(visibleIds, ['alpha_lead', 'root'], 'a realm lead sees its realm members only (Alpha scout is purged)');
    assert.equal(visibleIds.includes('director'), false, 'the system scope is never listed');
    assert.equal(visibleIds.includes('beta_lead'), false, 'foreign realm members are never listed');

    const systemKill = await alphaLeadDispatcher.executeTool('kill_agent', { agent_id: 'director' });
    assert.equal(systemKill.success, false, 'a realm caller cannot kill the system director');
    assert.equal(systemKill.code, 'PERMISSION_DENIED');
    assert.ok(runtime.getAgent(director.key), 'the director survives the denied kill');
    assertRealmOpaque(systemKill, 'the system-scope kill denial');

    // The realm lead's scoped identity enumeration excludes the system scope.
    const identities = runtime.createAgentIdentityPort().listAgentIdentities({ realmId: ALPHA });
    assert.equal(identities.some((projection) => projection.id === 'director'), false);
  } finally {
    destroyMatrixFixture(fixture);
  }
});

// ============================================================================
// 9. Opacity sweep over aggregated agent-visible surfaces
// ============================================================================

test('9. opacity sweep: no realm vocabulary on any agent-visible surface produced above', async () => {
  const fixture = await createMatrixFixture();
  const { runtime, store, alpha, beta, director, operator } = fixture;
  const { messagingBus: bus, virtualFs: vfs, worldClock: clock } = runtime;
  const surfaces = [];
  try {
    const alphaRootDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'root',
      realmId: ALPHA,
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });

    // Mail surfaces.
    const mailReceipt = bus.sendMessage(
      { from: 'scout', to: 'root', content: 'opacity mail' },
      callContext(alpha.scout)
    );
    surfaces.push(['mail receipt', mailReceipt]);
    surfaces.push(['mail envelope', bus.readMessage(alpha.root.key, mailReceipt.messageId).message]);
    surfaces.push([
      'cross-realm mail denial',
      bus.sendMessage({ from: 'scout', to: 'beta_lead', content: 'x' }, callContext(alpha.scout))
    ]);
    surfaces.push([
      'inline receipt',
      await bus.inlineFileInMessage(
        { filePath: '/note.md', recipient: 'root', from: 'scout' },
        { ...callContext(alpha.scout), virtualFs: vfs }
      )
    ]);

    // VFS surfaces.
    surfaces.push(['vfs private write', vfs.writeFile({ filePath: '/note.md', content: 'opacity note' }, callContext(alpha.scout))]);
    surfaces.push(['vfs mount read', await alphaRootDispatcher.executeTool('read_file', { file_path: '/agents/scout/note.md' })]);
    surfaces.push(['vfs mount listing', await alphaRootDispatcher.executeTool('list_files', { dir_path: '/agents' })]);
    surfaces.push([
      'vfs cross-realm denial',
      await alphaRootDispatcher.executeTool('read_file', { file_path: '/agents/beta_lead/note.md' })
    ]);

    // Clock surfaces.
    clock.setTime({ totalSeconds: 55 }, callContext(alpha.scout));
    surfaces.push(['clock get', clock.getTime({}, callContext(alpha.scout))]);
    const opacityEvent = clock.registerEvent(
      { id: 'evt_opacity', name: 'Opacity Beat', targetAgentId: alpha.scout.key },
      { callerAgentId: alpha.root.id, callerKey: alpha.root.key }
    );
    surfaces.push(['clock event receipt', opacityEvent]);
    surfaces.push([
      'clock event resolve',
      clock.resolveEvent({ eventId: 'evt_opacity' }, { callerAgentId: alpha.root.id, callerKey: alpha.root.key })
    ]);
    surfaces.push([
      'agent-facing clock listing',
      clock.handleClockTool({ action: 'query', all: true }, { callerAgentId: alpha.root.id, callerKey: alpha.root.key })
    ]);

    // Scheduler surfaces.
    const arm = runtime.schedule(
      { agentId: 'scout', prompt: 'opacity wake', durationSeconds: LONG_DELAY_SECONDS },
      { principal: alpha.lead.authority, callerKey: alpha.lead.key }
    );
    surfaces.push(['schedule receipt', arm]);
    surfaces.push([
      'schedule listing',
      runtime.listSchedules({ status: 'all' }, { principal: alpha.lead.authority, callerKey: alpha.lead.key })
    ]);
    surfaces.push([
      'cross-realm schedule denial',
      runtime.schedule({ agentId: 'beta_lead', prompt: 'x', durationSeconds: LONG_DELAY_SECONDS }, { principal: alpha.lead.authority, callerKey: alpha.lead.key })
    ]);

    // Invocation surfaces.
    const invocation = runtime.invokeAgent(alpha.root.key, alpha.scout.key, 'opacity task');
    surfaces.push(['invocation receipt', invocation]);
    surfaces.push([
      'invocation await result',
      await runtime.waitForInvocation({ invocationIds: [invocation.invocationId], timeout_ms: 3000 })
    ]);
    surfaces.push([
      'cross-realm invocation denial',
      runtime.invokeAgent(alpha.root.key, beta.lead.key, 'x')
    ]);

    // Lifecycle surfaces.
    runtime.killAgent(alpha.scout.key, 'opacity kill', { principal: operator });
    const opacityLeadDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'alpha_lead',
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    });
    surfaces.push([
      'cross-realm kill denial',
      await opacityLeadDispatcher.executeTool('kill_agent', { agent_id: 'beta_lead' })
    ]);
    surfaces.push([
      'system-scope kill denial',
      await opacityLeadDispatcher.executeTool('kill_agent', { agent_id: 'director' })
    ]);
    surfaces.push([
      'reserved-shape target denial',
      await opacityLeadDispatcher.executeTool('kill_agent', { agent_id: `realm:${BETA}:scout` })
    ]);
    runtime.restoreAgent(alpha.scout.key, { principal: operator });
    surfaces.push(['agent tool listing', await alphaRootDispatcher.executeTool('list_agents', {})]);
    surfaces.push(['realm lead agent tool listing', await opacityLeadDispatcher.executeTool('list_agents', {})]);

    // Store manual-send surface (operator label is presentation only).
    surfaces.push(['store operator send', store.sendMessage('human', 'beta_lead', 'opacity operator note')]);
    surfaces.push(['store ambiguous send denial', store.sendMessage('human', 'scout', 'x')]);

    for (const [label, value] of surfaces) {
      assert.ok(value !== null && value !== undefined, `${label}: surface must exist`);
      assertRealmOpaque(value, label);
    }

    // The director's bare id is itself ordinary vocabulary: it may appear only
    // as a bare id, never as a system-scope key or bypass disclosure.
    assert.equal(JSON.stringify(surfaces).includes('system:'), false, 'no system-scope key vocabulary appears');
  } finally {
    destroyMatrixFixture(fixture);
  }
});
