/**
 * @file tests/integration/meta_mcp_attach_test.js
 * @description M4 meta-plane — privileged MCP meta-attach `list_extensions` /
 * `attach_extension` acceptance suite (meta-plane spec §5, ticket `a02bce7`,
 * decisions `ce4b475`/`3c6197f`).
 *
 * Acceptance coverage:
 *   AC-M4-01 exact-authority only: both tools live in the authority registry
 *     (outside the canonical taxonomy) under `@extensions:authority`; the
 *     wildcard/privileged/ordinary channels never authorize, and schemas /
 *     `describe_tool` are exposed only to the exact holder;
 *   AC-M4-02 operator-only verbs: install/connect/disconnect/remove and every
 *     credential/transport-shaped parameter are refused uniformly with zero
 *     mutation; unknown parameters are malformed;
 *   AC-M4-03 realm-wide attach: one call adds the extension to the caller's
 *     realm uniform set and the member safe-state sweep follows (idle members
 *     synchronously, busy members at `turn_complete`);
 *   AC-M4-04 installed+connected gate: not-installed and not-connected
 *     extensions fail closed with zero mutation; explicit selections must
 *     resolve against the live conflict-free catalog;
 *   AC-M4-05 idempotence: re-attaching an already attached extension succeeds
 *     with `applied:false` and emits no duplicate audit or mutation;
 *   AC-M4-06 revocation: revoking `@extensions:authority` denies future calls
 *     while existing attachments persist until an operator detach;
 *   AC-M4-07 ordinary-agent opacity: non-holders never see the tools in their
 *     schemas, `describe_tool` hides them, and their denial receipts carry no
 *     extension state; `spawn_agent` params stay extension-free;
 *   AC-M4-08 audit: `extensions_inspected` (`{actorId, realmLabel}`) and
 *     `extension_attached` with `source:'privileged-agent'` + actor id;
 *   R6 confused deputy: the pinned port denies a missing/unknown/wrong-authority
 *     actor record before any store mutation, per-call port claims are
 *     stripped, and a scoped grant bounds the reachable realm.
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
import { AGENT_AUTHORITIES } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createMcpFixtureServer } from '../fixtures/mcp/http_fixture_server.mjs';

/** M4 tool names (pinned here so a taxonomy leak fails loudly). */
const LIST_EXTENSIONS = 'list_extensions';
const ATTACH_EXTENSION = 'attach_extension';
const EXTENSIONS = AGENT_AUTHORITIES.EXTENSIONS;
const REALM_INSPECT = AGENT_AUTHORITIES.REALM_INSPECT;
const REALM_EDIT = AGENT_AUTHORITIES.REALM_EDIT;
const ALPHA = 'realm_m4_alpha';
const BETA = 'realm_m4_beta';

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
function createMockModel(fn, modelId = 'meta-mcp-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'meta-mcp-provider',
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
    id: 'meta-mcp-scripted-model',
    config: {},
    provider: {
      id: 'meta-mcp-scripted-provider',
      createModel: () => model,
      getEndpointUrl: () => 'http://localhost/scripted',
      checkBalance: async () => ({ balance: 1 }),
      listModels: async () => [{ id: 'meta-mcp-scripted-model', name: 'meta-mcp-scripted-model' }]
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
          id: 'meta_mcp_call',
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
    updateRealm: (input) => portRef.current.updateRealm(input),
    listExtensions: (input) => portRef.current.listExtensions(input),
    attachExtension: (input) => portRef.current.attachExtension(input)
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
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.privileged ? { privileged: true } : {}),
    model: options.model || createMockModel(async () => ({ content: 'ok' }))
  });
}

/** Grants one authority id to an active agent under the operator principal. */
function grant(runtime, agentId, authorityId, scope = null) {
  return runtime.grantAuthority(agentId, authorityId, scope, { principal: runtime.getOperatorPrincipal() });
}

/** Revokes one authority id from an active agent under the operator principal. */
function revoke(runtime, agentId, authorityId) {
  return runtime.revokeAuthority(agentId, authorityId, { principal: runtime.getOperatorPrincipal() });
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

/** Installs + connects one fixture-backed MCP extension. */
async function installMcp(store, id, fixture, displayName) {
  store.installExtension({
    id,
    kind: 'mcp',
    ...(displayName ? { displayName } : {}),
    transportHint: { kind: 'http', url: fixture.url }
  });
  return await store.connectExtension(id);
}

// ============================================================================
// AC-M4-01 — surface + exact-authority exposure
// ============================================================================

test('1. [AC-M4-01] list_extensions/attach_extension are exact-authority tools outside the canonical taxonomy', () => {
  assert.equal(AUTHORITY_TOOL_REGISTRY[LIST_EXTENSIONS]?.authority, EXTENSIONS);
  assert.equal(AUTHORITY_TOOL_REGISTRY[ATTACH_EXTENSION]?.authority, EXTENSIONS);
  assert.equal(TOOL_REGISTRY[LIST_EXTENSIONS], undefined, 'list_extensions is not a canonical tool');
  assert.equal(TOOL_REGISTRY[ATTACH_EXTENSION], undefined, 'attach_extension is not a canonical tool');
  assert.equal(
    ALL_TOOL_DESCRIPTORS.some((descriptor) => descriptor.name === LIST_EXTENSIONS || descriptor.name === ATTACH_EXTENSION),
    false,
    'the authority tools stay outside ALL_TOOL_DESCRIPTORS'
  );
  assert.equal(Object.values(SANDBOX_TOOLS).includes(LIST_EXTENSIONS), false);
  assert.equal(Object.values(SANDBOX_TOOLS).includes(ATTACH_EXTENSION), false);

  assert.deepEqual(
    getAuthorityToolSchemas([EXTENSIONS]).map((definition) => definition.function.name).sort(),
    [ATTACH_EXTENSION, LIST_EXTENSIONS].sort()
  );
  assert.deepEqual(getAuthorityToolSchemas(['*']), [], 'the wildcard is never an authority id');
  assert.deepEqual(getAuthorityToolSchemas([]), [], 'no ids expose no schemas');
  assert.deepEqual(
    getAuthorityToolDescriptors([EXTENSIONS]).map((descriptor) => descriptor.name).sort(),
    [ATTACH_EXTENSION, LIST_EXTENSIONS].sort(),
    'the describe-merge source is exact-id filtered'
  );
  assert.deepEqual(getAuthorityToolDescriptors(['*']), [], 'the wildcard never describes an authority tool');

  // Closed shapes: list_extensions takes no parameters; attach_extension takes
  // exactly `extensionId` (required) plus the optional `toolSelection` ceiling.
  const listSchema = AUTHORITY_TOOL_REGISTRY[LIST_EXTENSIONS]?.schema;
  assert.equal(listSchema?.additionalProperties, false, 'list_extensions is closed');
  assert.deepEqual(Object.keys(listSchema?.properties || {}), [], 'list_extensions declares no properties');
  const attachSchema = AUTHORITY_TOOL_REGISTRY[ATTACH_EXTENSION]?.schema;
  assert.equal(attachSchema?.additionalProperties, false, 'attach_extension is closed');
  assert.deepEqual(Object.keys(attachSchema?.properties || {}).sort(), ['extensionId', 'toolSelection']);
  assert.deepEqual(attachSchema?.required, ['extensionId']);

  assert.equal(getCanonToolName('list_extensions'), LIST_EXTENSIONS);
  assert.equal(getCanonToolName('listExtensions'), LIST_EXTENSIONS);
  assert.equal(getCanonToolName('attach_extension'), ATTACH_EXTENSION);
  assert.equal(getCanonToolName('attachExtension'), ATTACH_EXTENSION);
});

test('2. [AC-M4-01] the dispatcher admits only the exact @extensions:authority holder', async () => {
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await launchMember(store, 'm4-holder', ALPHA, { tools: ['readonly'] });
    await launchMember(store, 'm4-ordinary', ALPHA, { tools: ['readonly'] });
    await launchMember(store, 'm4-wildcard', ALPHA, { tools: ['all'] });
    await launchMember(store, 'm4-privileged', ALPHA, { tools: ['readonly'], privileged: true });
    await launchMember(store, 'm4-realm-holder', ALPHA, { tools: ['readonly'] });
    grant(runtime, 'm4-holder', EXTENSIONS);
    grant(runtime, 'm4-realm-holder', REALM_INSPECT);

    const holder = await dispatcherFor(store, runtime, 'm4-holder').executeTool(LIST_EXTENSIONS, {});
    assert.equal(holder.success, true, `the exact holder is admitted: ${JSON.stringify(holder)}`);
    assert.equal(holder.realm, 'Alpha');

    for (const deniedId of ['m4-ordinary', 'm4-wildcard', 'm4-privileged']) {
      for (const tool of [LIST_EXTENSIONS, ATTACH_EXTENSION]) {
        const denied = await dispatcherFor(store, runtime, deniedId).executeTool(tool, {});
        assert.equal(denied.success, false, `${deniedId} must be denied for ${tool}`);
        assert.equal(denied.code, 'PERMISSION_DENIED', `${deniedId} denial code for ${tool}`);
        assert.equal(
          String(denied.error).includes('Alpha'),
          false,
          'the denial never discloses realm state'
        );
      }
    }

    // Wrong authority id: a realm-inspect holder cannot administer extensions,
    // and the extensions holder cannot inspect realms.
    const wrongExtensions = await dispatcherFor(store, runtime, 'm4-realm-holder').executeTool(LIST_EXTENSIONS, {});
    assert.equal(wrongExtensions.code, 'PERMISSION_DENIED', 'realm-inspect authority never authorizes extension listing');
    const wrongRealm = await dispatcherFor(store, runtime, 'm4-holder').executeTool('inspect_realm', {});
    assert.equal(wrongRealm.code, 'PERMISSION_DENIED', 'extensions authority never authorizes realm inspection');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-03 / AC-M4-04 — realm-wide attach + sweep + gates
// ============================================================================

test('3. [AC-M4-03/04] attach is realm-wide after installed+connected gates and the member sweep follows', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-ext', fixture, 'M4 Fixture');
    store.installExtension({
      id: 'm4-cold',
      kind: 'mcp',
      transportHint: { kind: 'http', url: fixture.url }
    });
    await launchMember(store, 'm4-attacher', ALPHA);
    grant(runtime, 'm4-attacher', EXTENSIONS);
    const dispatcher = dispatcherFor(store, runtime, 'm4-attacher');

    // Unknown extension → fail closed (never installs anything).
    const notInstalled = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ghost' });
    assert.equal(notInstalled.success, false);
    assert.equal(notInstalled.code, 'INVALID_ARGUMENTS');
    // Installed but not connected → fail closed (never dials anything).
    const notConnected = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-cold' });
    assert.equal(notConnected.success, false);
    assert.equal(notConnected.code, 'INVALID_ARGUMENTS');
    assert.equal(store.getRealm(ALPHA).extensions, undefined, 'nothing attached before the gates pass');
    assert.equal(events.some((event) => event.type === 'extension_attached'), false, 'no attach audit from refusals');

    // Members launched before the attachment hold the selector but no grants.
    await launchMember(store, 'm4-idle', ALPHA, { tools: ['readonly'], extensionTools: ['echo'] });
    assert.deepEqual(extensionGrantsOf(runtime, 'm4-idle', ALPHA), [], 'no attachment → no grants');
    const gate = deferred();
    const busyModel = createMockModel(async () => {
      await gate.promise;
      return { content: 'done' };
    });
    await launchMember(store, 'm4-busy', ALPHA, { tools: ['readonly'], extensionTools: ['echo'], model: busyModel });
    const busyTurn = runtime.executeAgentTurn('m4-busy', 'hold');
    await waitUntil(() => runtime.isAgentBusy('m4-busy'), 2000);

    // One realm-wide attach: the realm record gains the uniform attachment and
    // the sweep reauthorizes the idle member synchronously.
    const attached = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(attached.success, true, JSON.stringify(attached));
    assert.equal(attached.realm, 'Alpha');
    assert.equal(attached.extensionId, 'm4-ext');
    assert.equal(attached.toolSelection, 'all');
    assert.equal(attached.applied, true);
    assert.equal(attached.alreadyAttached, false);
    const attachments = store.getRealm(ALPHA).extensions || [];
    assert.equal(attachments.length, 1, 'the attachment lands on the realm record (uniform set)');
    assert.equal(attachments[0].extensionId, 'm4-ext');
    assert.equal(attachments[0].status, 'active');
    assert.deepEqual(extensionGrantsOf(runtime, 'm4-idle', ALPHA), ['echo'], 'the idle member is reauthorized synchronously');
    assert.deepEqual(extensionGrantsOf(runtime, 'm4-busy', ALPHA), [], 'the busy member keeps its grants until its safe state');

    // Explicit selection: an out-of-catalog name fails closed with zero mutation.
    const badSelection = await dispatcher.executeTool(ATTACH_EXTENSION, {
      extensionId: 'm4-cold',
      toolSelection: ['not_a_real_tool']
    });
    assert.equal(badSelection.success, false);
    assert.equal(badSelection.code, 'INVALID_ARGUMENTS');

    gate.resolve();
    await busyTurn;
    await waitUntil(() => extensionGrantsOf(runtime, 'm4-busy', ALPHA).length === 1, 2000);
    assert.deepEqual(extensionGrantsOf(runtime, 'm4-busy', ALPHA), ['echo'], 'the busy member catches up at turn_complete');

    const attachedEvent = events.find((event) => event.type === 'extension_attached' && event.payload?.extensionId === 'm4-ext');
    assert.ok(attachedEvent, 'the attach is audited');
    assert.equal(attachedEvent.payload.source, 'privileged-agent');
    assert.equal(attachedEvent.payload.actorId, 'm4-attacher');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

test('4. [AC-M4-05] a repeated attach is idempotent with no duplicate audit or mutation', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-ext', fixture);
    await launchMember(store, 'm4-idem', ALPHA);
    grant(runtime, 'm4-idem', EXTENSIONS);
    const dispatcher = dispatcherFor(store, runtime, 'm4-idem');

    const first = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext', toolSelection: ['echo'] });
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.applied, true);
    const firstCount = events.filter((event) => event.type === 'extension_attached' && event.payload?.extensionId === 'm4-ext').length;
    assert.equal(firstCount, 1);

    const second = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext', toolSelection: ['sse'] });
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(second.applied, false, 'a repeated attach applies nothing');
    assert.equal(second.alreadyAttached, true);
    assert.deepEqual(second.toolSelection, ['echo'], 'the stored ceiling is reported');
    assert.equal(
      events.filter((event) => event.type === 'extension_attached' && event.payload?.extensionId === 'm4-ext').length,
      firstCount,
      'no duplicate attach audit'
    );
    assert.equal(events.some((event) => event.type === 'extension_tool_selection_updated'), false, 'idempotence never rewrites the ceiling');
    const attachments = store.getRealm(ALPHA).extensions || [];
    assert.equal(attachments.length, 1);
    assert.deepEqual(attachments[0].toolSelection, ['echo'], 'the idempotent path mutates nothing');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-02 — operator-only verbs
// ============================================================================

test('5. [AC-M4-02] install/connect/disconnect/remove and credential/transport params are refused uniformly', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-ext', fixture);
    await launchMember(store, 'm4-guard', ALPHA);
    grant(runtime, 'm4-guard', EXTENSIONS);
    const dispatcher = dispatcherFor(store, runtime, 'm4-guard');
    const realmBefore = JSON.stringify(store.getRealm(ALPHA));
    const installsBefore = store.listExtensions().length;
    const eventsBefore = events.length;

    const deniedParams = [
      { install: { id: 'x' } },
      { uninstall: 'm4-ext' },
      { remove: 'm4-ext' },
      { removeExtension: 'm4-ext' },
      { detach: 'm4-ext' },
      { detachExtension: 'm4-ext' },
      { connect: true },
      { disconnect: true },
      { reconnect: true },
      { credentials: { token: 'x' } },
      { credential_id: 'vault-x' },
      { url: fixture.url },
      { transportUrl: fixture.url },
      { transportHint: { kind: 'http', url: fixture.url } },
      { extensions: [] },
      { realm: 'Beta' },
      { realmId: BETA },
      { approvedBy: 'operator' },
      { [EXTENSIONS]: true },
      { authorities: [{ id: EXTENSIONS }] }
    ];
    for (const params of deniedParams) {
      const receipt = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext', ...params });
      assert.equal(receipt.success, false, `${JSON.stringify(params)} must fail`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `${JSON.stringify(params)} denial class`);
      assert.equal(String(receipt.error).includes(ALPHA), false, 'the denial never echoes realm state');
    }
    const listDenied = await dispatcher.executeTool(LIST_EXTENSIONS, { install: { id: 'x' } });
    assert.equal(listDenied.code, 'PERMISSION_DENIED', 'operator-only params are denied on the listing too');

    // Unknown parameters are malformed, not silently dropped.
    assert.equal((await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext', nope: 1 })).code, 'INVALID_ARGUMENTS');
    assert.equal((await dispatcher.executeTool(ATTACH_EXTENSION, {})).code, 'INVALID_ARGUMENTS', 'extensionId is required');
    assert.equal((await dispatcher.executeTool(LIST_EXTENSIONS, { nope: 1 })).code, 'INVALID_ARGUMENTS');
    assert.equal((await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext', toolSelection: [] })).code, 'INVALID_ARGUMENTS');

    assert.equal(JSON.stringify(store.getRealm(ALPHA)), realmBefore, 'zero partial mutation');
    assert.equal(store.listExtensions().length, installsBefore, 'no install/remove side effect');
    assert.equal(
      events.slice(eventsBefore).some((event) => event.type.startsWith('extension_')),
      false,
      'no extension audit event from refused operator-only verbs'
    );
    assert.equal(typeof store.installExtension, 'function', 'the operator install surface is unchanged');
    assert.equal(typeof store.connectExtension, 'function');
    assert.equal(typeof store.removeExtension, 'function');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-06 — revocation semantics
// ============================================================================

test('6. [AC-M4-06] revocation denies future calls while existing attachments persist', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-ext', fixture);
    await launchMember(store, 'm4-revoke', ALPHA);
    grant(runtime, 'm4-revoke', EXTENSIONS);
    const dispatcher = dispatcherFor(store, runtime, 'm4-revoke');

    const attached = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(attached.success, true, JSON.stringify(attached));

    revoke(runtime, 'm4-revoke', EXTENSIONS);
    const afterRevokeList = await dispatcher.executeTool(LIST_EXTENSIONS, {});
    assert.equal(afterRevokeList.code, 'PERMISSION_DENIED', 'revocation denies the listing');
    const afterRevokeAttach = await dispatcher.executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(afterRevokeAttach.code, 'PERMISSION_DENIED', 'revocation denies the attach');
    assert.equal((store.getRealm(ALPHA).extensions || []).length, 1, 'the attachment persists until an operator detach');
    assert.throws(
      () => store.getRealmAdminPort().attachExtension({ actorRef: 'm4-revoke', extensionId: 'm4-ext' }),
      (error) => error?.code === 'PERMISSION_DENIED',
      'the direct port path re-reads the revoked registry state'
    );

    // Kill/purge drops the grant too: the dead actor is uniformly denied.
    grant(runtime, 'm4-revoke', EXTENSIONS);
    assert.equal((await dispatcher.executeTool(LIST_EXTENSIONS, {})).success, true, 're-grant restores access');
    runtime.killAgent('m4-revoke', 'revocation probe', { principal: runtime.getOperatorPrincipal() });
    const afterKill = await dispatcherFor(store, runtime, 'm4-revoke').executeTool(LIST_EXTENSIONS, {});
    assert.equal(afterKill.success, false, 'a killed actor is denied');
    assert.equal(afterKill.code, 'PERMISSION_DENIED', 'kill drops the grant');
    assert.equal((store.getRealm(ALPHA).extensions || []).length, 1, 'the attachment survives the actor');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-07 — ordinary-agent opacity
// ============================================================================

test('7. [AC-M4-07] ordinary agents keep tools-only opacity (schemas, receipts, errors)', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-secret-ext', fixture, 'Secret Fixture');

    const describeProbe = createToolCallModel('describe_tool', { tool_name: LIST_EXTENSIONS });
    await launchMember(store, 'm4-ordinary', ALPHA, { tools: ['describe_tool'], model: describeProbe.model });
    await runtime.executeAgentTurn('m4-ordinary', 'probe the hidden tool');

    assert.equal(
      describeProbe.captured.toolNames.includes(LIST_EXTENSIONS),
      false,
      'a non-holder never receives the list_extensions schema'
    );
    assert.equal(describeProbe.captured.toolNames.includes(ATTACH_EXTENSION), false);
    const hiddenDescribe = lastToolReceipt(runtime, 'm4-ordinary');
    assert.equal(hiddenDescribe.success, false);
    assert.equal(hiddenDescribe.code, 'TOOL_NOT_FOUND', 'describe_tool hides non-held authority tools');

    assert.equal(
      getSandboxToolsSchema('all').some((definition) => (
        definition.function.name === LIST_EXTENSIONS || definition.function.name === ATTACH_EXTENSION
      )),
      false,
      'the wildcard schema surface never exposes the tools'
    );

    // A direct call by a non-holder is denied without any extension state.
    const denial = await dispatcherFor(store, runtime, 'm4-ordinary').executeTool(LIST_EXTENSIONS, {});
    assert.equal(denial.success, false);
    assert.equal(denial.code, 'PERMISSION_DENIED');
    const serializedDenial = JSON.stringify(denial);
    for (const leak of ['m4-secret-ext', 'Secret Fixture', fixture.url, 'credential', 'transport']) {
      assert.equal(serializedDenial.includes(leak), false, `the denial never leaks '${leak}'`);
    }
    const attachDenial = await dispatcherFor(store, runtime, 'm4-ordinary').executeTool(ATTACH_EXTENSION, { extensionId: 'm4-secret-ext' });
    assert.equal(attachDenial.code, 'PERMISSION_DENIED');
    assert.equal(String(attachDenial.error).includes('m4-secret-ext'), false, 'the denial never echoes the claimed extension');

    // The ordinary spawn surface stays extension-free.
    const spawnSchema = TOOL_REGISTRY.spawn_agent.schema;
    assert.equal(
      Object.keys(spawnSchema.properties).some((key) => /extension|mcp/i.test(key)),
      false,
      'spawn_agent declares no extension vocabulary'
    );
    assert.equal(
      JSON.stringify(spawnSchema.properties).includes('extension'),
      false,
      'spawn_agent params carry no extension vocabulary'
    );

    // The rejected calls emitted no extension mutation audit.
    assert.equal(events.some((event) => event.type === 'extension_attached'), false, 'no attach from a denied caller');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-08 — bounded, realm-opaque listing
// ============================================================================

test('8. [AC-M4-08] the listing is bounded, realm-opaque, and audited', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-live', fixture, 'Live Fixture');
    store.installExtension({ id: 'm4-pack', kind: 'pack', transportHint: { kind: 'pack', source: 'test' } });
    store.installExtension({ id: 'm4-near', kind: 'mcp', transportHint: { kind: 'http', url: fixture.url } });
    store.attachExtension(ALPHA, 'm4-live', { toolSelection: ['echo'] });
    await launchMember(store, 'm4-lister', ALPHA);
    grant(runtime, 'm4-lister', EXTENSIONS);

    const receipt = await dispatcherFor(store, runtime, 'm4-lister').executeTool(LIST_EXTENSIONS, {});
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    assert.equal(receipt.realm, 'Alpha');
    assert.equal(receipt.installed.length, 3, 'every installed record is listed');
    const byId = new Map(receipt.installed.map((entry) => [entry.id, entry]));
    const live = byId.get('m4-live');
    assert.equal(live.displayName, 'Live Fixture');
    assert.equal(live.kind, 'mcp');
    assert.equal(live.status, 'installed');
    assert.equal(live.connected, true);
    assert.equal(live.attached, true);
    assert.deepEqual([...live.tools].sort(), ['echo', 'sse'], 'available call names are exposed for connected extensions');
    const pack = byId.get('m4-pack');
    assert.equal(pack.kind, 'pack');
    assert.equal(pack.connected, false);
    assert.equal(pack.attached, false);
    assert.equal(pack.tools, undefined, 'a pack has no live catalog');
    assert.equal(byId.get('m4-near').connected, false);
    assert.equal(byId.get('m4-near').attached, false);

    assert.equal(receipt.attachments.length, 1);
    const attachment = receipt.attachments[0];
    assert.equal(attachment.extensionId, 'm4-live');
    assert.equal(attachment.displayName, 'Live Fixture');
    assert.equal(attachment.kind, 'mcp');
    assert.equal(attachment.live, 'connected');
    assert.deepEqual(attachment.toolSelection, ['echo']);
    assert.deepEqual([...attachment.tools].sort(), ['echo', 'sse']);

    const serialized = JSON.stringify(receipt);
    for (const forbidden of [ALPHA, BETA, 'realm:', fixture.url, 'credential', 'http']) {
      assert.equal(serialized.includes(forbidden), false, `the listing never carries '${forbidden}'`);
    }

    const inspected = events.find((event) => event.type === 'extensions_inspected');
    assert.ok(inspected, 'the listing is audited');
    assert.equal(inspected.payload.actorId, 'm4-lister');
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
// R6 — confused deputy
// ============================================================================

test('9. [R6] the pinned port denies without an actor record; per-call substitution is stripped', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-ext', fixture);
    await launchMember(store, 'm4-deputy', ALPHA);
    await launchMember(store, 'm4-impostor', ALPHA);
    await launchMember(store, 'm4-realm-editor', ALPHA);
    grant(runtime, 'm4-deputy', EXTENSIONS);
    grant(runtime, 'm4-realm-editor', REALM_EDIT);
    const port = store.getRealmAdminPort();
    const realmBefore = JSON.stringify(store.getRealm(ALPHA));
    const eventsBefore = events.length;

    assert.ok(Object.isFrozen(port), 'the port handle is frozen');
    assert.equal(typeof port.listExtensions, 'function');
    assert.equal(typeof port.attachExtension, 'function');
    assert.equal(store.getRealmAdminPort(), port, 'the handle is stable');

    // No actor record / unknown actor / grant-less impostor / wrong authority —
    // never a silent operator-principal mutation.
    assert.throws(() => port.listExtensions({ actorRef: null }), (error) => error?.code === 'PERMISSION_DENIED');
    assert.throws(() => port.listExtensions({ actorRef: 'm4-unknown' }), (error) => error?.code === 'PERMISSION_DENIED');
    assert.throws(() => port.listExtensions({ actorRef: 'm4-impostor' }), (error) => error?.code === 'PERMISSION_DENIED');
    assert.throws(() => port.attachExtension({ actorRef: null, extensionId: 'm4-ext' }), (error) => error?.code === 'PERMISSION_DENIED');
    assert.throws(() => port.attachExtension({ actorRef: 'm4-unknown', extensionId: 'm4-ext' }), (error) => error?.code === 'PERMISSION_DENIED');
    assert.throws(() => port.attachExtension({ actorRef: 'm4-impostor', extensionId: 'm4-ext' }), (error) => error?.code === 'PERMISSION_DENIED');
    assert.throws(
      () => port.attachExtension({ actorRef: 'm4-realm-editor', extensionId: 'm4-ext' }),
      (error) => error?.code === 'PERMISSION_DENIED',
      'a realm-edit holder carries no extension authority'
    );
    assert.throws(
      () => port.attachExtension({ actorRef: 'm4-deputy', extensionId: '' }),
      (error) => error?.code === 'INVALID_ARGUMENTS',
      'a malformed extension id is INVALID_ARGUMENTS after the authority check'
    );
    assert.equal(JSON.stringify(store.getRealm(ALPHA)), realmBefore, 'the deputy path mutates nothing');
    assert.equal(
      events.slice(eventsBefore).some((event) => event.type === 'extension_attached'),
      false,
      'no audit from denied calls'
    );

    // Per-call port substitution is stripped: a holder dispatcher without the
    // bound port fails closed even when the call claims one.
    const portless = createSandboxToolDispatcher({ runtime, agentId: 'm4-deputy', callerAgentId: 'm4-deputy' });
    const substituted = await portless.executeTool(
      ATTACH_EXTENSION,
      { extensionId: 'm4-ext' },
      { realmAdminPort: port }
    );
    assert.equal(substituted.success, false);
    assert.equal(substituted.code, 'EXECUTION_FAILED');
    assert.match(String(substituted.error), /realmAdminPort service is not available/);
    assert.equal(JSON.stringify(store.getRealm(ALPHA)), realmBefore);

    // A legitimate call mutates exactly through the pinned channel.
    const attached = await dispatcherFor(store, runtime, 'm4-deputy').executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(attached.success, true, JSON.stringify(attached));
    const attachedEvent = events.find((event) => event.type === 'extension_attached');
    assert.equal(attachedEvent.payload.actorId, 'm4-deputy');
    assert.equal(attachedEvent.payload.source, 'privileged-agent');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-01 — turn-engine binding + exposure
// ============================================================================

test('10. [AC-M4-01] the turn engine exposes both tools to the exact holder end-to-end', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    await installMcp(store, 'm4-ext', fixture);
    const listProbe = createToolCallModel(LIST_EXTENSIONS, {});
    const hiddenProbe = createToolCallModel(LIST_EXTENSIONS, {});
    await launchMember(store, 'm4-e2e', ALPHA, { tools: ['readonly'], model: listProbe.model });
    await launchMember(store, 'm4-e2e-hidden', ALPHA, { tools: ['readonly'], model: hiddenProbe.model });
    grant(runtime, 'm4-e2e', EXTENSIONS);

    await runtime.executeAgentTurn('m4-e2e', 'list my extensions');
    assert.ok(listProbe.captured.toolNames.includes(LIST_EXTENSIONS), 'the holder schema is exposed');
    assert.ok(listProbe.captured.toolNames.includes(ATTACH_EXTENSION), 'the attach schema is exposed');
    const receipt = lastToolReceipt(runtime, 'm4-e2e');
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    assert.equal(receipt.realm, 'Alpha');

    await runtime.executeAgentTurn('m4-e2e-hidden', 'probe hiding');
    assert.equal(hiddenProbe.captured.toolNames.includes(LIST_EXTENSIONS), false, 'the non-holder schema stays hidden');
    assert.equal(hiddenProbe.captured.toolNames.includes(ATTACH_EXTENSION), false);
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// AC-M4-02/03 — realm-scope bounds
// ============================================================================

test('11. [AC-M4-02/03] realm-scoped grants bound the attach without widening to other realms', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    store.createRealm({ id: ALPHA, name: 'Alpha' });
    store.createRealm({ id: BETA, name: 'Beta' });
    await installMcp(store, 'm4-ext', fixture);
    await launchMember(store, 'm4-scope-default', ALPHA);
    await launchMember(store, 'm4-scope-own', ALPHA);
    await launchMember(store, 'm4-scope-other', ALPHA);
    await launchMember(store, 'm4-scope-empty', ALPHA);
    grant(runtime, 'm4-scope-default', EXTENSIONS);
    grant(runtime, 'm4-scope-own', EXTENSIONS, { targets: [ALPHA] });
    grant(runtime, 'm4-scope-other', EXTENSIONS, { targets: [BETA] });
    grant(runtime, 'm4-scope-empty', EXTENSIONS, { targets: [] });
    const realmBefore = JSON.stringify(store.getRealm(ALPHA));

    assert.equal((await dispatcherFor(store, runtime, 'm4-scope-default').executeTool(LIST_EXTENSIONS, {})).success, true);
    assert.equal((await dispatcherFor(store, runtime, 'm4-scope-own').executeTool(LIST_EXTENSIONS, {})).success, true, 'an explicit own-realm target reaches');
    const otherList = await dispatcherFor(store, runtime, 'm4-scope-other').executeTool(LIST_EXTENSIONS, {});
    assert.equal(otherList.code, 'PERMISSION_DENIED', 'a targets grant never reaches past its candidate set');
    const emptyList = await dispatcherFor(store, runtime, 'm4-scope-empty').executeTool(LIST_EXTENSIONS, {});
    assert.equal(emptyList.code, 'PERMISSION_DENIED', 'an explicit empty targets list reaches nothing');

    const otherAttach = await dispatcherFor(store, runtime, 'm4-scope-other').executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(otherAttach.code, 'PERMISSION_DENIED', 'out-of-scope attach is refused');
    const emptyAttach = await dispatcherFor(store, runtime, 'm4-scope-empty').executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(emptyAttach.code, 'PERMISSION_DENIED');
    assert.equal(JSON.stringify(store.getRealm(ALPHA)), realmBefore, 'no out-of-scope mutation');
    assert.equal(events.some((event) => event.type === 'extension_attached'), false, 'no audit from out-of-scope calls');

    const attached = await dispatcherFor(store, runtime, 'm4-scope-default').executeTool(ATTACH_EXTENSION, { extensionId: 'm4-ext' });
    assert.equal(attached.success, true, JSON.stringify(attached));
    assert.equal((store.getRealm(ALPHA).extensions || []).length, 1, 'the own-realm attach lands on the caller realm');
  } finally {
    unsubscribe();
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});
