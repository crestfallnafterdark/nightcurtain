/**
 * @file tests/integration/meta_realm_admin_test.js
 * @description M3 meta-plane — realm-admin `inspect_realm` / `update_realm`
 * acceptance suite (meta-plane spec §4, ticket `094de1b`).
 *
 * Acceptance coverage:
 *   AC-M3-01 exact-authority only: the two tools live in the authority
 *     registry (outside the canonical taxonomy), the wildcard/privileged/
 *     ordinary channels never authorize, schemas and `describe_tool` are
 *     exposed only to the exact holder;
 *   AC-M3-02 scope: own-realm default, `targets` realm scopes, unique exact
 *     label resolution, uniform denials for unknown/out-of-scope/ambiguous
 *     labels, and realm-id-free receipts;
 *   AC-M3-03 inspect: roster with per-member effective capability, attachments
 *     with ceiling + live connection state, provenance + missing-extension
 *     disclosure, and full opacity (no realm ids, `realm:` paths, transport
 *     URLs, or credential material);
 *   AC-M3-04 edit: name/description/color; attach installed+connected only;
 *     ceiling change; unknown call names fail closed;
 *   AC-M3-05 sweep: attach/ceiling changes reauthorize idle members
 *     synchronously and busy members at `turn_complete`, terminated members
 *     are dropped;
 *   AC-M3-06 operator-only: membership, provenance, create/delete, detach/
 *     remove, raw attachment arrays, and every authority id are refused
 *     uniformly with zero mutation;
 *   AC-M3-07 no escalation: realm edits cannot mint authority or exceed the
 *     live catalog; the edited realm cannot widen an actor's own grants;
 *   AC-M3-08 audit: actor attribution, label-only realm payloads, and the
 *     attach `source: 'meta-realm-edit'` marker;
 *   R6 confused deputy: the pinned port denies a missing/unknown/wrong-authority
 *     actor record before any store mutation, and per-call port claims are
 *     stripped.
 *
 * Zero-Mock Verification: real `AgentRuntime`, real `SandboxStore`, real
 * dispatcher, real `node:http` MCP fixture; the only stub is the LLM stream.
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  ALL_TOOL_DESCRIPTORS,
  AUTHORITY_TOOL_REGISTRY,
  TOOL_REGISTRY,
  getAuthorityToolDescriptors,
  getAuthorityToolSchemas
} from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { SANDBOX_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';
import { getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';
import { AGENT_AUTHORITIES, AUTHORITY_IDS } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createMcpFixtureServer } from '../fixtures/mcp/http_fixture_server.mjs';

/** M3 tool names (pinned here so a taxonomy leak fails loudly). */
const INSPECT_REALM = 'inspect_realm';
const UPDATE_REALM = 'update_realm';
const REALM_INSPECT = AGENT_AUTHORITIES.REALM_INSPECT;
const REALM_EDIT = AGENT_AUTHORITIES.REALM_EDIT;
const ALPHA = 'realm_m3_alpha';
const BETA = 'realm_m3_beta';

/** Realm-admin MCP fixture tools. */
const FIXTURE_TOOLS = Object.freeze([
  Object.freeze({ name: 'echo', description: 'Echo text' }),
  Object.freeze({ name: 'sse', description: 'Stream text' })
]);

/** Simple deferred handle for gated turns. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Polls a predicate until it holds or the budget elapses.
 *
 * @param {Function} predicate - Synchronous predicate under test.
 * @param {number} [timeoutMs] - Polling budget in milliseconds.
 * @returns {Promise<void>} Resolves when the predicate holds.
 */
async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'waitUntil predicate must hold before the budget elapses');
}

/**
 * Minimal stream/complete mock model so turns settle without a provider network.
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @param {string} [modelId] - Model identifier.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn, modelId = 'meta-realm-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'meta-realm-provider',
      createModel: (id) => createMockModel(fn, id),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream(options = {}) {
      const res = await fn({ ...options });
      const content = res && typeof res === 'object' ? (res.content || res.text || 'ok') : (res || 'ok');
      if (typeof options.onChunk === 'function') {
        try { options.onChunk(content); } catch { /* best-effort chunk delivery */ }
      }
      yield { type: 'text', content };
      yield { type: 'finish', finishReason: 'stop', content, toolCalls: [] };
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

/**
 * Scripted model that captures the emitted tool schemas, calls one tool on the
 * first step, then settles the turn.
 *
 * @param {string} toolName - Canonical tool name to call.
 * @param {object} [args] - Tool arguments.
 * @returns {{ model: object, captured: object }} Model + capture record.
 */
function createToolCallModel(toolName, args = {}) {
  const captured = { toolNames: [], streamOptions: [] };
  let step = 0;
  const model = {
    id: 'meta-realm-scripted-model',
    config: {},
    provider: {
      id: 'meta-realm-scripted-provider',
      createModel: () => model,
      getEndpointUrl: () => 'http://localhost/scripted',
      checkBalance: async () => ({ balance: 1 }),
      listModels: async () => [{ id: 'meta-realm-scripted-model', name: 'meta-realm-scripted-model' }]
    },
    async *stream(options = {}) {
      captured.streamOptions.push(options);
      if (captured.toolNames.length === 0) {
        captured.toolNames = (Array.isArray(options.tools) ? options.tools : [])
          .map((entry) => entry?.function?.name || entry?.name || '');
      }
      step += 1;
      if (step === 1) {
        const toolCall = {
          id: 'meta_realm_call',
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) }
        };
        yield { type: 'tool_call', toolCalls: [toolCall] };
        yield { type: 'finish', finishReason: 'tool_calls', content: '', toolCalls: [toolCall] };
        return;
      }
      yield { type: 'finish', finishReason: 'stop', content: 'done', toolCalls: [] };
    },
    async complete() { return { content: 'done' }; }
  };
  return { model, captured };
}

/**
 * Last tool receipt from one agent's history.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Agent id.
 * @returns {object} Parsed receipt.
 */
function lastToolReceipt(runtime, agentId) {
  const history = runtime.getAgent(agentId).history || [];
  const toolMessages = history.filter((message) => message.role === 'tool');
  return JSON.parse(String(toolMessages[toolMessages.length - 1]?.content || '{}'));
}

/**
 * Builds a runtime + store harness. The runtime carries a delegating port
 * handle so the turn engine sees the store's real realm-admin port while the
 * store resolves scope from the same runtime registry (test-local bootstrap;
 * production binds the port directly in the store constructor).
 *
 * @returns {object} Harness.
 */
function createHarness() {
  const portRef = { current: null };
  const boundPort = Object.freeze({
    inspectRealm: (input) => portRef.current.inspectRealm(input),
    updateRealm: (input) => portRef.current.updateRealm(input)
  });
  const runtime = new AgentRuntime({ autoBootstrapDirector: false, realmAdminPort: boundPort });
  const store = new SandboxStore({ runtime, autoHydrate: false, autoBootstrapDirector: false });
  portRef.current = store.getRealmAdminPort();
  const events = [];
  const unsubscribe = runtime.subscribe((event) => events.push(event));
  return { runtime, store, events, unsubscribe, port: portRef.current };
}

/**
 * Launches a member through the store launch path with a mock model.
 *
 * @param {object} store - Fixture store.
 * @param {string} id - Agent id.
 * @param {string} realmId - Realm membership.
 * @param {object} [options] - Launch overrides.
 * @returns {Promise<object>} The launched snapshot.
 */
async function launchMember(store, id, realmId, options = {}) {
  return await store.launchAgent({
    id,
    name: options.name || id,
    role: options.role || 'user',
    realmId,
    allowedTools: options.tools || ['readonly'],
    ...(options.extensionTools ? { extensionTools: options.extensionTools } : {}),
    ...(options.privileged ? { privileged: true } : {}),
    model: options.model || createMockModel(async () => ({ content: 'ok' }))
  });
}

/** Grants one authority id to an active agent under the operator principal. */
function grant(runtime, agentId, authorityId, scope = null) {
  return runtime.grantAuthority(agentId, authorityId, scope, { principal: runtime.getOperatorPrincipal() });
}

/** Builds a dispatcher bound to one agent with the store's realm-admin port. */
function dispatcherFor(store, runtime, agentId) {
  return createSandboxToolDispatcher({
    runtime,
    agentId,
    callerAgentId: agentId,
    realmAdminPort: store.getRealmAdminPort()
  });
}

/** Effective extension call names of one member's frozen descriptor. */
function extensionGrantsOf(runtime, agentId, realmId) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity(agentId, { realmId });
  return identity ? [...identity.authority.extensions] : [];
}

// ============================================================================
// AC-M3-01 — surface + exact-authority exposure
// ============================================================================

test('1. [AC-M3-01] inspect_realm/update_realm are exact-authority tools outside the canonical taxonomy', () => {
  assert.equal(AUTHORITY_TOOL_REGISTRY[INSPECT_REALM]?.authority, REALM_INSPECT);
  assert.equal(AUTHORITY_TOOL_REGISTRY[UPDATE_REALM]?.authority, REALM_EDIT);
  assert.equal(TOOL_REGISTRY[INSPECT_REALM], undefined, 'inspect_realm is not a canonical tool');
  assert.equal(TOOL_REGISTRY[UPDATE_REALM], undefined, 'update_realm is not a canonical tool');
  assert.equal(
    ALL_TOOL_DESCRIPTORS.some((descriptor) => descriptor.name === INSPECT_REALM || descriptor.name === UPDATE_REALM),
    false,
    'the authority tools stay outside ALL_TOOL_DESCRIPTORS'
  );
  assert.equal(Object.values(SANDBOX_TOOLS).includes(INSPECT_REALM), false);
  assert.equal(Object.values(SANDBOX_TOOLS).includes(UPDATE_REALM), false);

  assert.deepEqual(
    getAuthorityToolSchemas([REALM_INSPECT]).map((definition) => definition.function.name),
    [INSPECT_REALM]
  );
  assert.deepEqual(
    getAuthorityToolSchemas([REALM_EDIT]).map((definition) => definition.function.name),
    [UPDATE_REALM]
  );
  assert.deepEqual(getAuthorityToolSchemas(['*']), [], 'the wildcard is never an authority id');
  assert.deepEqual(getAuthorityToolSchemas([]), [], 'no ids expose no schemas');
  assert.deepEqual(
    getAuthorityToolSchemas(AUTHORITY_IDS).map((definition) => definition.function.name).sort(),
    ['import_realm_template', INSPECT_REALM, 'submit_hydration_package', UPDATE_REALM].sort(),
    'every id with a registered descriptor exposes exactly its schema'
  );
  assert.deepEqual(
    getAuthorityToolDescriptors([REALM_INSPECT]).map((descriptor) => descriptor.name),
    [INSPECT_REALM],
    'the describe-merge source is exact-id filtered'
  );
  assert.deepEqual(getAuthorityToolDescriptors(['*']), [], 'the wildcard never describes an authority tool');

  assert.equal(getCanonToolName('inspect_realm'), INSPECT_REALM);
  assert.equal(getCanonToolName('inspectRealm'), INSPECT_REALM);
  assert.equal(getCanonToolName('update_realm'), UPDATE_REALM);
  assert.equal(getCanonToolName('updateRealm'), UPDATE_REALM);
});

test('2. [AC-M3-01] the dispatcher admits only the exact authority id', async () => {
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await launchMember(store, 'm3-holder', ALPHA, { tools: ['readonly'] });
    await launchMember(store, 'm3-ordinary', ALPHA, { tools: ['readonly'] });
    await launchMember(store, 'm3-wildcard', ALPHA, { tools: ['all'] });
    await launchMember(store, 'm3-privileged', ALPHA, { tools: ['readonly'], privileged: true });
    grant(runtime, 'm3-holder', REALM_INSPECT);

    const holder = await dispatcherFor(store, runtime, 'm3-holder').executeTool(INSPECT_REALM, {});
    assert.equal(holder.success, true, `the exact holder is admitted: ${JSON.stringify(holder)}`);
    assert.equal(holder.realm.label, 'Alpha');

    for (const deniedId of ['m3-ordinary', 'm3-wildcard', 'm3-privileged']) {
      const denied = await dispatcherFor(store, runtime, deniedId).executeTool(INSPECT_REALM, {});
      assert.equal(denied.success, false, `${deniedId} must be denied`);
      assert.equal(denied.code, 'PERMISSION_DENIED', `${deniedId} denial code`);
      assert.equal(
        String(denied.error).includes('Alpha'),
        false,
        'the denial never discloses realm state'
      );
    }

    // Wrong authority id: an inspect holder cannot edit, an edit holder cannot
    // inspect.
    const wrongEdit = await dispatcherFor(store, runtime, 'm3-holder').executeTool(UPDATE_REALM, {
      patch: { name: 'Nope' }
    });
    assert.equal(wrongEdit.code, 'PERMISSION_DENIED', 'inspect authority never authorizes edit');
    grant(runtime, 'm3-ordinary', REALM_EDIT);
    const wrongInspect = await dispatcherFor(store, runtime, 'm3-ordinary').executeTool(INSPECT_REALM, {});
    assert.equal(wrongInspect.code, 'PERMISSION_DENIED', 'edit authority never authorizes inspect');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-02 — scope + label resolution
// ============================================================================

test('3. [AC-M3-02] own-realm default, label addressing, uniform scope denials', async () => {
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    store.createRealm({ id: BETA, name: 'Beta' });
    store.createRealm({ id: 'realm_m3_twin1', name: 'Twin' });
    store.createRealm({ id: 'realm_m3_twin2', name: 'Twin' });
    await launchMember(store, 'm3-a', ALPHA);
    await launchMember(store, 'm3-b', BETA);
    await launchMember(store, 'm3-t', 'realm_m3_twin1');
    grant(runtime, 'm3-a', REALM_INSPECT);
    grant(runtime, 'm3-b', REALM_INSPECT, { targets: [BETA] });
    grant(runtime, 'm3-t', REALM_INSPECT, { targets: ['realm_m3_twin1', 'realm_m3_twin2'] });

    const a = dispatcherFor(store, runtime, 'm3-a');
    const own = await a.executeTool(INSPECT_REALM, {});
    assert.equal(own.success, true, JSON.stringify(own));
    assert.equal(own.realm.label, 'Alpha', 'omitted realm resolves the own realm');

    const byLabel = await a.executeTool(INSPECT_REALM, { realm: 'Alpha' });
    assert.equal(byLabel.success, true);
    assert.equal(byLabel.realm.label, 'Alpha');

    const outOfScope = await a.executeTool(INSPECT_REALM, { realm: 'Beta' });
    const unknown = await a.executeTool(INSPECT_REALM, { realm: 'No Such Realm' });
    assert.equal(outOfScope.code, 'PERMISSION_DENIED');
    assert.equal(unknown.code, 'PERMISSION_DENIED');
    assert.deepEqual(outOfScope, unknown, 'unknown and out-of-scope labels share one receipt (no oracle)');

    const b = dispatcherFor(store, runtime, 'm3-b');
    const targetOnly = await b.executeTool(INSPECT_REALM, { realm: 'Beta' });
    assert.equal(targetOnly.success, true, 'a targets grant reaches the listed realm');
    const ownExcluded = await b.executeTool(INSPECT_REALM, {});
    assert.equal(ownExcluded.code, 'PERMISSION_DENIED', 'targets replace the own-realm default');
    const crossDenied = await b.executeTool(INSPECT_REALM, { realm: 'Alpha' });
    assert.equal(crossDenied.code, 'PERMISSION_DENIED', 'a targets grant never widens');

    const twin = await dispatcherFor(store, runtime, 'm3-t').executeTool(INSPECT_REALM, { realm: 'Twin' });
    assert.equal(twin.code, 'PERMISSION_DENIED', 'an ambiguous label fails closed');

    // Realm ids never leak through receipts.
    const serialized = JSON.stringify(own);
    for (const realmId of [ALPHA, BETA, 'realm_m3_twin1', 'realm_m3_twin2', 'realm_generic']) {
      assert.equal(serialized.includes(realmId), false, `receipts never carry realm id '${realmId}'`);
    }
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-03 — bounded inspect projection
// ============================================================================

test('4. [AC-M3-03] inspect returns roster, capability, attachments, live state, provenance, disclosure', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    store.createRealm({ id: BETA, name: 'Beta' });
    await launchMember(store, 'm3-mgr', ALPHA, { tools: ['manager'], name: 'Manager' });
    await launchMember(store, 'm3-ro', ALPHA, { tools: ['readonly'] });
    await launchMember(store, 'm3-outsider', BETA);

    store.installExtension({
      id: 'm3-ext',
      kind: 'mcp',
      displayName: 'M3 Fixture',
      transportHint: { kind: 'http', url: fixture.url }
    });
    store.attachExtension(ALPHA, 'm3-ext', { toolSelection: ['echo'] });
    await store.connectExtension('m3-ext');

    store.updateRealm(ALPHA, {
      instance: {
        templateId: 'm3-template',
        templateVersion: 'sha256:m3version',
        packageDigest: 'sha256:m3package',
        inputHashes: { setting: 'sha256:m3input' },
        seedPaths: ['lore/world.md'],
        launchedAt: '2026-09-27T00:00:00.000Z',
        resolvedTools: { echo: 'm3-ext' },
        missingExtensions: ['m3-missing']
      }
    });

    await launchMember(store, 'm3-inspector', ALPHA);
    grant(runtime, 'm3-inspector', REALM_INSPECT);
    const receipt = await dispatcherFor(store, runtime, 'm3-inspector').executeTool(INSPECT_REALM, {});
    assert.equal(receipt.success, true, JSON.stringify(receipt));

    assert.equal(receipt.realm.label, 'Alpha');
    assert.equal(typeof receipt.realm.createdAt, 'number');
    assert.equal(receipt.realm.memberCount, 3, 'only the realm members are counted');

    const memberIds = receipt.members.map((member) => member.id).sort();
    assert.deepEqual(memberIds, ['m3-inspector', 'm3-mgr', 'm3-ro'], 'the roster is realm-exact');
    const manager = receipt.members.find((member) => member.id === 'm3-mgr');
    const readonly = receipt.members.find((member) => member.id === 'm3-ro');
    assert.equal(manager.name, 'Manager');
    assert.equal(manager.privileged, false);
    assert.ok(manager.tools.baked.includes('spawn_agent'), 'manager capability is visible');
    assert.ok(!readonly.tools.baked.includes('spawn_agent'), 'readonly capability is bounded');
    assert.ok(readonly.tools.baked.includes('read_file'));
    assert.equal(typeof manager.state, 'string');
    assert.equal(manager.turns, 0);

    assert.equal(receipt.attachments.length, 1);
    const attachment = receipt.attachments[0];
    assert.equal(attachment.extensionId, 'm3-ext');
    assert.equal(attachment.displayName, 'M3 Fixture');
    assert.equal(attachment.kind, 'mcp');
    assert.equal(attachment.status, 'active');
    assert.deepEqual(attachment.toolSelection, ['echo']);
    assert.equal(attachment.live, 'connected');

    assert.equal(receipt.provenance.templateId, 'm3-template');
    assert.equal(receipt.provenance.templateVersion, 'sha256:m3version');
    assert.equal(receipt.provenance.packageDigest, 'sha256:m3package');
    assert.deepEqual(receipt.provenance.inputHashes, { setting: 'sha256:m3input' });
    assert.deepEqual(receipt.provenance.seedPaths, ['lore/world.md']);
    assert.equal(receipt.provenance.launchedAt, '2026-09-27T00:00:00.000Z');
    assert.deepEqual(receipt.provenance.resolvedTools, { echo: 'm3-ext' });
    assert.deepEqual(receipt.disclosure.missingExtensions, ['m3-missing']);

    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(ALPHA), false, 'no realm ids in the projection');
    assert.equal(serialized.includes(BETA), false);
    assert.equal(serialized.includes('realm:'), false, 'no realm paths in the projection');
    assert.equal(serialized.includes(fixture.url), false, 'no transport URLs in the projection');
    assert.equal(serialized.includes('credential'), false, 'no credential vocabulary in the projection');

    const inspected = events.find((event) => event.type === 'realm_inspected');
    assert.ok(inspected, 'inspection is audited');
    assert.equal(inspected.payload.actorId, 'm3-inspector');
    assert.equal(inspected.payload.realmLabel, 'Alpha');
    assert.equal(JSON.stringify(inspected.payload).includes(ALPHA), false, 'audit carries the label only');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-04 — bounded edits
// ============================================================================

test('5. [AC-M3-04] metadata edits apply atomically with before/after receipts', async () => {
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha', description: 'old', color: '#000000' });
    await launchMember(store, 'm3-editor', ALPHA);
    grant(runtime, 'm3-editor', REALM_EDIT);
    const dispatcher = dispatcherFor(store, runtime, 'm3-editor');

    const receipt = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { name: 'Alpha Prime', description: 'new', color: '#123456' }
    });
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    assert.equal(receipt.realm, 'Alpha Prime');
    assert.deepEqual(receipt.fields.sort(), ['color', 'description', 'name']);
    assert.equal(receipt.before.name, 'Alpha');
    assert.equal(receipt.after.name, 'Alpha Prime');
    assert.equal(receipt.after.color, '#123456');

    const realm = store.getRealm(ALPHA);
    assert.equal(realm.name, 'Alpha Prime');
    assert.equal(realm.description, 'new');
    assert.equal(realm.color, '#123456');

    const updated = events.find((event) => event.type === 'realm_updated');
    assert.ok(updated, 'the edit is audited');
    assert.equal(updated.payload.actorId, 'm3-editor');
    assert.equal(updated.payload.realmLabel, 'Alpha Prime');
    assert.deepEqual([...updated.payload.fields].sort(), ['color', 'description', 'name']);
    assert.equal(JSON.stringify(updated.payload).includes(ALPHA), false, 'audit carries the label only');

    // A malformed patch fails without partial application.
    const malformed = await dispatcher.executeTool(UPDATE_REALM, { patch: { name: 42 } });
    assert.equal(malformed.code, 'INVALID_ARGUMENTS');
    assert.equal(store.getRealm(ALPHA).name, 'Alpha Prime', 'no partial application');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

test('6. [AC-M3-04] attach requires installed+connected and a live-catalog selection', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await launchMember(store, 'm3-attacher', ALPHA);
    grant(runtime, 'm3-attacher', REALM_EDIT);
    const dispatcher = dispatcherFor(store, runtime, 'm3-attacher');

    // Not installed → fail closed.
    const notInstalled = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { attach: { extensionId: 'm3-ext', toolSelection: ['echo'] } }
    });
    assert.equal(notInstalled.success, false);
    assert.equal(notInstalled.code, 'INVALID_ARGUMENTS');
    assert.equal(store.getRealm(ALPHA).extensions, undefined, 'nothing attached');

    // Installed but not connected → fail closed.
    store.installExtension({
      id: 'm3-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: fixture.url }
    });
    const notConnected = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { attach: { extensionId: 'm3-ext', toolSelection: ['echo'] } }
    });
    assert.equal(notConnected.code, 'INVALID_ARGUMENTS');
    assert.equal(store.getRealm(ALPHA).extensions, undefined, 'nothing attached before connect');

    // Connected + in-catalog selection → attached with actor-attributed audit.
    await store.connectExtension('m3-ext');
    const attached = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { attach: { extensionId: 'm3-ext', toolSelection: ['echo'] } }
    });
    assert.equal(attached.success, true, JSON.stringify(attached));
    assert.deepEqual(attached.fields, ['attachments']);
    const attachments = store.getRealm(ALPHA).extensions || [];
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].extensionId, 'm3-ext');
    assert.deepEqual(attachments[0].toolSelection, ['echo']);
    const attachedEvent = events.find((event) => event.type === 'extension_attached' && event.payload?.extensionId === 'm3-ext');
    assert.ok(attachedEvent, 'attach is audited');
    assert.equal(attachedEvent.payload.source, 'meta-realm-edit');
    assert.equal(attachedEvent.payload.actorId, 'm3-attacher');

    // An unknown call name fails closed with zero mutation.
    const unknownName = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { attach: { extensionId: 'm3-ext', toolSelection: ['not_a_real_tool'] } }
    });
    assert.equal(unknownName.code, 'INVALID_ARGUMENTS');
    assert.equal((store.getRealm(ALPHA).extensions || []).length, 1, 'no duplicate attach');

    // Re-attach is refused (operator detach/remove stays the only remover).
    const reattach = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { attach: { extensionId: 'm3-ext', toolSelection: 'all' } }
    });
    assert.equal(reattach.success, false);
    assert.equal(reattach.code, 'INVALID_ARGUMENTS');

    // Ceiling change resolves against the live catalog.
    const ceiling = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { toolSelection: { extensionId: 'm3-ext', selection: 'all' } }
    });
    assert.equal(ceiling.success, true, JSON.stringify(ceiling));
    assert.deepEqual(ceiling.fields, ['ceiling']);
    assert.equal(store.getRealm(ALPHA).extensions[0].toolSelection, 'all');
    const ceilingEvent = events.find((event) => event.type === 'extension_tool_selection_updated');
    assert.ok(ceilingEvent, 'the ceiling change is audited');
    assert.equal(ceilingEvent.payload.source, 'meta-realm-edit');
    assert.equal(ceilingEvent.payload.actorId, 'm3-attacher');

    const badCeiling = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { toolSelection: { extensionId: 'm3-ext', selection: ['not_a_real_tool'] } }
    });
    assert.equal(badCeiling.code, 'INVALID_ARGUMENTS');
    assert.equal(store.getRealm(ALPHA).extensions[0].toolSelection, 'all', 'fail closed, unchanged');

    const unknownAttachment = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { toolSelection: { extensionId: 'm3-not-attached', selection: 'all' } }
    });
    assert.equal(unknownAttachment.code, 'INVALID_ARGUMENTS');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-05 — safe-state sweep
// ============================================================================

test('7. [AC-M3-05] ceiling changes sweep idle members now, busy members at turn_complete, drop the dead', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    store.installExtension({
      id: 'm3-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: fixture.url }
    });
    store.attachExtension(ALPHA, 'm3-ext', { toolSelection: 'all' });
    await store.connectExtension('m3-ext');

    await launchMember(store, 'm3-sweep-idle', ALPHA, { tools: ['readonly'], extensionTools: ['echo'] });
    assert.deepEqual(extensionGrantsOf(runtime, 'm3-sweep-idle', ALPHA), ['echo'], 'launch grants resolve');

    const gate = deferred();
    const busyModel = createMockModel(async () => {
      await gate.promise;
      return { content: 'done' };
    });
    await launchMember(store, 'm3-sweep-busy', ALPHA, {
      tools: ['readonly'],
      extensionTools: ['echo'],
      model: busyModel
    });
    await launchMember(store, 'm3-sweep-dead', ALPHA, { tools: ['readonly'], extensionTools: ['echo'] });

    const busyTurn = runtime.executeAgentTurn('m3-sweep-busy', 'hold');
    await waitUntil(() => runtime.isAgentBusy('m3-sweep-busy'), 2000);

    runtime.killAgent('m3-sweep-dead', 'sweep drop probe', { principal: runtime.getOperatorPrincipal() });
    assert.equal(runtime.getAgent('m3-sweep-dead'), null, 'the terminated member is gone before the sweep');

    await launchMember(store, 'm3-sweep-editor', ALPHA);
    grant(runtime, 'm3-sweep-editor', REALM_EDIT);
    const ceiling = await dispatcherFor(store, runtime, 'm3-sweep-editor').executeTool(UPDATE_REALM, {
      patch: { toolSelection: { extensionId: 'm3-ext', selection: ['sse'] } }
    });
    assert.equal(ceiling.success, true, JSON.stringify(ceiling));

    assert.deepEqual(
      extensionGrantsOf(runtime, 'm3-sweep-idle', ALPHA),
      [],
      'the idle member is reauthorized synchronously'
    );
    assert.deepEqual(
      extensionGrantsOf(runtime, 'm3-sweep-busy', ALPHA),
      ['echo'],
      'the busy member keeps its grants until its safe state'
    );

    gate.resolve();
    await busyTurn;
    await waitUntil(() => extensionGrantsOf(runtime, 'm3-sweep-busy', ALPHA).length === 0, 2000);
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-06 — operator-only refusals
// ============================================================================

test('8. [AC-M3-06] create/delete/detach/membership/provenance/authority edits are refused with zero mutation', async () => {
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await launchMember(store, 'm3-guard', ALPHA);
    grant(runtime, 'm3-guard', REALM_EDIT);
    const dispatcher = dispatcherFor(store, runtime, 'm3-guard');
    const before = JSON.stringify(store.getRealm(ALPHA));

    const deniedKeys = [
      { members: [] },
      { membership: 'realm_m3_beta' },
      { realmId: BETA },
      { realm_id: BETA },
      { templateId: 'x' },
      { instance: null },
      { provenance: null },
      { create: { name: 'x' } },
      { delete: ALPHA },
      { remove: ALPHA },
      { detach: { extensionId: 'm3-ext' } },
      { removeExtension: 'm3-ext' },
      { extensions: [] },
      { settings: {} },
      { [REALM_EDIT]: true },
      { authorities: [{ id: REALM_INSPECT }] },
      { templateAuthority: false },
      { hydrationAuthority: null }
    ];
    for (const patch of deniedKeys) {
      const receipt = await dispatcher.executeTool(UPDATE_REALM, { patch });
      assert.equal(receipt.success, false, `${JSON.stringify(patch)} must fail`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `${JSON.stringify(patch)} denial class`);
      assert.equal(
        String(receipt.error).includes(ALPHA),
        false,
        'the denial never echoes realm state'
      );
    }
    assert.equal(JSON.stringify(store.getRealm(ALPHA)), before, 'zero partial mutation');
    assert.equal(events.some((event) => event.type === 'realm_updated'), false, 'no audit for a refused edit');

    // An empty patch and unknown keys are malformed, not silently dropped.
    assert.equal((await dispatcher.executeTool(UPDATE_REALM, { patch: {} })).code, 'INVALID_ARGUMENTS');
    assert.equal((await dispatcher.executeTool(UPDATE_REALM, { patch: { nope: 1 } })).code, 'INVALID_ARGUMENTS');
    // The operator store surface is unchanged (create/delete remain host-only).
    assert.equal(typeof store.createRealm, 'function');
    assert.equal(typeof store.deleteRealm, 'function');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-07 — no escalation
// ============================================================================

test('9. [AC-M3-07] realm edits never mint authority or exceed the live catalog', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    store.installExtension({
      id: 'm3-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: fixture.url }
    });
    store.attachExtension(ALPHA, 'm3-ext', { toolSelection: 'all' });
    await store.connectExtension('m3-ext');
    await launchMember(store, 'm3-actor', ALPHA, { tools: ['readonly'], extensionTools: ['echo'] });
    grant(runtime, 'm3-actor', REALM_EDIT);
    const dispatcher = dispatcherFor(store, runtime, 'm3-actor');

    const grantsBefore = JSON.stringify(runtime.getAuthorityGrants('m3-actor'));
    const receipt = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { name: 'Alpha II', toolSelection: { extensionId: 'm3-ext', selection: ['sse'] } }
    });
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    assert.equal(
      JSON.stringify(runtime.getAuthorityGrants('m3-actor')),
      grantsBefore,
      'the edit never mints or removes authority'
    );
    assert.deepEqual(
      extensionGrantsOf(runtime, 'm3-actor', ALPHA),
      [],
      'the actor loses its own out-of-selection grant only through the ceiling sweep'
    );

    // The ceiling can only select from the live catalog.
    const outOfCatalog = await dispatcher.executeTool(UPDATE_REALM, {
      patch: { toolSelection: { extensionId: 'm3-ext', selection: ['spawn_agent'] } }
    });
    assert.equal(outOfCatalog.code, 'INVALID_ARGUMENTS', 'a non-catalog name fails closed');
    assert.deepEqual(store.getRealm(ALPHA).extensions[0].toolSelection, ['sse'], 'unchanged');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-08 + R6 — audit + confused deputy
// ============================================================================

test('10. [AC-M3-08/R6] the pinned port denies without an actor record; audits stay realm-opaque', async () => {
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await launchMember(store, 'm3-deputy', ALPHA);
    await launchMember(store, 'm3-inspekt', ALPHA);
    await launchMember(store, 'm3-impostor', ALPHA);
    grant(runtime, 'm3-deputy', REALM_EDIT);
    grant(runtime, 'm3-inspekt', REALM_INSPECT);
    const port = store.getRealmAdminPort();
    const before = JSON.stringify(store.getRealm(ALPHA));

    // No actor record — never a silent operator-principal mutation.
    assert.throws(() => port.updateRealm({ actorRef: null, realmLabel: 'Alpha', patch: { name: 'X' } }));
    assert.throws(() => port.updateRealm({ actorRef: 'm3-unknown', realmLabel: 'Alpha', patch: { name: 'X' } }));
    assert.throws(() => port.updateRealm({ actorRef: 'm3-impostor', realmLabel: 'Alpha', patch: { name: 'X' } }));
    assert.throws(() => port.inspectRealm({ actorRef: null, realmLabel: null }));
    assert.throws(() => port.inspectRealm({ actorRef: 'm3-impostor', realmLabel: null }));
    // Wrong authority id: an inspect holder cannot route an edit through the port.
    assert.throws(() => port.updateRealm({ actorRef: 'm3-inspekt', realmLabel: 'Alpha', patch: { name: 'X' } }));
    assert.throws(() => port.inspectRealm({ actorRef: 'm3-deputy', realmLabel: null }));
    assert.equal(JSON.stringify(store.getRealm(ALPHA)), before, 'the deputy path mutates nothing');
    assert.equal(events.some((event) => event.type === 'realm_updated'), false, 'no audit from denied calls');

    // Per-call port substitution is stripped: a holder dispatcher without the
    // bound port fails closed even when the call claims one.
    const portless = createSandboxToolDispatcher({ runtime, agentId: 'm3-deputy', callerAgentId: 'm3-deputy' });
    const substituted = await portless.executeTool(
      UPDATE_REALM,
      { patch: { name: 'X' } },
      { realmAdminPort: port }
    );
    assert.equal(substituted.success, false);
    assert.equal(substituted.code, 'EXECUTION_FAILED');
    assert.match(String(substituted.error), /realmAdminPort service is not available/);
    assert.equal(JSON.stringify(store.getRealm(ALPHA)), before);

    // Actor attribution on a legitimate edit.
    const receipt = await dispatcherFor(store, runtime, 'm3-deputy').executeTool(UPDATE_REALM, {
      patch: { name: 'Alpha Done' }
    });
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    const updated = events.find((event) => event.type === 'realm_updated');
    assert.equal(updated.payload.actorId, 'm3-deputy');
    const serialized = JSON.stringify(updated.payload);
    assert.equal(serialized.includes(ALPHA), false);
    assert.equal(serialized.includes('realm:'), false);
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M3-01 — turn-engine binding + exposure
// ============================================================================

test('11. [AC-M3-01] the turn engine exposes schemas and describe to exact holders only', async () => {
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    const describeProbe = createToolCallModel('describe_tool', { tool_name: INSPECT_REALM });
    const hiddenProbe = createToolCallModel('describe_tool', { tool_name: INSPECT_REALM });
    const inspectProbe = createToolCallModel(INSPECT_REALM, {});
    await launchMember(store, 'm3-exposed', ALPHA, { tools: ['describe_tool'], model: describeProbe.model });
    await launchMember(store, 'm3-hidden', ALPHA, { tools: ['describe_tool'], model: hiddenProbe.model });
    grant(runtime, 'm3-exposed', REALM_INSPECT);
    grant(runtime, 'm3-exposed', REALM_EDIT);

    await runtime.executeAgentTurn('m3-exposed', 'probe exposure');
    assert.ok(describeProbe.captured.toolNames.includes(INSPECT_REALM), 'the holder schema is exposed');
    assert.ok(describeProbe.captured.toolNames.includes(UPDATE_REALM), 'the edit schema is exposed');
    const exposedDescribe = lastToolReceipt(runtime, 'm3-exposed');
    assert.equal(exposedDescribe.success, true, JSON.stringify(exposedDescribe));
    assert.equal(exposedDescribe.tool_name, INSPECT_REALM);

    await runtime.executeAgentTurn('m3-hidden', 'probe hiding');
    assert.equal(hiddenProbe.captured.toolNames.includes(INSPECT_REALM), false, 'non-holder schema hidden');
    assert.equal(hiddenProbe.captured.toolNames.includes(UPDATE_REALM), false);
    const hiddenDescribe = lastToolReceipt(runtime, 'm3-hidden');
    assert.equal(hiddenDescribe.success, false);
    assert.equal(hiddenDescribe.code, 'TOOL_NOT_FOUND', 'describe_tool hides non-held authority tools');
    assert.equal(getSandboxToolsSchema('all').some((definition) => definition.function.name === INSPECT_REALM), false);

    // End-to-end: the turn engine seeds the pinned port into the dispatcher.
    const inspectAgent = await launchMember(store, 'm3-e2e', ALPHA, { tools: ['readonly'], model: inspectProbe.model });
    grant(runtime, 'm3-e2e', REALM_INSPECT);
    await runtime.executeAgentTurn('m3-e2e', 'inspect my realm');
    const e2eReceipt = lastToolReceipt(runtime, 'm3-e2e');
    assert.equal(e2eReceipt.success, true, JSON.stringify(e2eReceipt));
    assert.equal(e2eReceipt.realm.label, 'Alpha');
    assert.ok(inspectAgent);
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});
