/**
 * @file tests/integration/extension_connect_test.js
 * @description Zero-Mock integration suite for the extension connection lane
 *   (P3.1): real store + real `node:http` MCP fixture + real `mcpClient`
 *   session over real sockets. The only non-production object is the fixture's
 *   tool behavior itself.
 *
 * Coverage:
 *  1. Unauthenticated plaintext connect → catalog + server identity + audit +
 *     attachment sync + call-name resolver.
 *  2. Single-flight: concurrent and repeated connects keep exactly one session.
 *  3. Disconnect: session dropped, attachment degraded, audit emitted;
 *     re-connect opens a fresh session.
 *  4. In-flight connect teardown, observed by the fixture (aborted handshake).
 *  5. Approval/credential/transport gates: mismatched or malformed approved
 *     URL, plaintext credential (zero sockets, zero secret disclosure),
 *     missing credential, pack/stdio typed refusals.
 *  6. Unreachable endpoint → `error` status + `extension_connect_failed`.
 *  6b. Reserved-name catalog refusal → typed error status, no session leak.
 *  7. Extension↔extension conflict: later extension loses the call name,
 *     attachments follow, disconnect of the winner re-activates the loser.
 *  8. Reconnect drift: changed catalog discloses added/removed and
 *     re-arbitrates the conflict away.
 *  9. Launch-time resolution × live conflict: the conflicted resolved
 *     extension loses the member's grants and regains them on re-arbitration.
 * 10. No auto-connect at hydration/launch; reset/destroy drop session state.
 * 11. F1: a disconnected attachment stays unavailable across unrelated
 *     registry saves until an explicit reconnect.
 * 12. F2: reconnect gate rejections keep the previous session/catalog/resolver.
 * 13. removeExtension drops a live session, audits it, and never redials.
 * 14. `connecting` never churns attachment status during a registry save.
 * 15. A disconnect during a reconnect handshake cancels it, no resurrect.
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import {
  SANDBOX_STORE_ERROR_CODES,
  SandboxStore
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AGENT_AUTHORITIES } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { createMcpFixtureServer, MCP_FIXTURE_SERVER_INFO } from '../fixtures/mcp/http_fixture_server.mjs';

/** Generic realm id (the seeded default every realm record carries). */
const GENERIC_REALM_ID = 'realm_generic';

/** Shared + distinct tool sets so two fixtures can collide on one call name. */
const FIXTURE_TOOLS_A = Object.freeze([
  Object.freeze({ name: 'shared_tool', description: 'A shared' }),
  Object.freeze({ name: 'alpha_only' })
]);
const FIXTURE_TOOLS_B = Object.freeze([
  Object.freeze({ name: 'shared_tool', description: 'B shared' }),
  Object.freeze({ name: 'beta_only' })
]);

/**
 * Builds a real runtime plus a store wired to that runtime's substrates and an
 * event collector for the audit stream.
 *
 * @returns {{ runtime: AgentRuntime, store: SandboxStore, events: object[], unsubscribe: () => void }} Harness.
 */
function createHarness() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  const events = [];
  const unsubscribe = runtime.subscribe((event) => events.push(event));
  return { runtime, store, events, unsubscribe };
}

/**
 * Installs one MCP extension pointing at a fixture (plaintext, unauthenticated).
 *
 * @param {object} store Store under test.
 * @param {string} id Extension id.
 * @param {{ url: string }} fixture Fixture handle.
 * @param {object} [overrides] Install-input overrides.
 * @returns {object} Frozen install record.
 */
function installMcp(store, id, fixture, overrides = {}) {
  return store.installExtension({
    id,
    kind: 'mcp',
    transportHint: { kind: 'http', url: fixture.url },
    ...overrides
  });
}

/**
 * Waits until a predicate holds or the budget elapses.
 *
 * @param {() => boolean} predicate Poll predicate.
 * @param {number} [timeoutMs] Budget.
 * @returns {Promise<boolean>} Whether the predicate held.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Boolean(predicate());
}

/**
 * Finds one audit event of a type by extension id.
 *
 * @param {object[]} events Collected runtime events.
 * @param {string} type Event type.
 * @param {string} extensionId Extension id.
 * @returns {object|undefined} The event.
 */
function auditEvent(events, type, extensionId) {
  return events.find((event) => event.type === type && event.payload?.extensionId === extensionId);
}

/**
 * Counts `initialize` handshakes the fixture served.
 *
 * @param {object} fixture Fixture handle.
 * @returns {number} Handshake count.
 */
function initializeCount(fixture) {
  return fixture.requests.filter((entry) => entry.method === 'initialize').length;
}

/**
 * Reads the Generic-realm attachment statuses of one extension.
 *
 * @param {object} store Store under test.
 * @param {string} extensionId Extension id.
 * @returns {string[]} Attachment statuses (empty when unattached).
 */
function attachmentStatuses(store, extensionId) {
  return store.getRealm(GENERIC_REALM_ID).extensions
    .filter((entry) => entry.extensionId === extensionId)
    .map((entry) => entry.status);
}

// ============================================================================
// 1. Connect + discovery
// ============================================================================

test('1. connect discovers a catalog over plaintext http and syncs attachments, resolver, and audit', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, events, unsubscribe } = createHarness();
  try {
    // The record carries an explicitly approved URL equal to the transport URL
    // (the install-dialog prefill shape): the approval boundary passes and the
    // connection dials normally.
    installMcp(store, 'ext-a', fixture, { approvedUrl: fixture.url });
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');

    const connection = await store.connectExtension('ext-a');
    assert.strictEqual(connection.status, 'connected');
    assert.deepStrictEqual(
      Object.keys(connection.catalog).sort(),
      ['alpha_only', 'shared_tool'],
      'the catalog projects every discovered call name'
    );
    assert.strictEqual(connection.catalog.shared_tool.extensionId, 'ext-a');
    assert.strictEqual(connection.catalog.shared_tool.serverToolName, 'shared_tool');
    assert.strictEqual(connection.catalog.shared_tool.inputSchema.type, 'object');
    assert.deepStrictEqual(connection.shadows, []);
    assert.deepStrictEqual(connection.conflicts, []);
    assert.strictEqual(connection.error, null);
    assert.deepEqual(connection.serverInfo, { ...MCP_FIXTURE_SERVER_INFO });
    assert.strictEqual(typeof connection.protocolVersion, 'string');
    assert.match(connection.digest, /^extcat1:[0-9a-f]{8}$/);
    assert.ok(connection.connectedAt > 0 && connection.discoveredAt > 0);
    assert.ok(Object.isFrozen(connection) && Object.isFrozen(connection.catalog));

    // Frozen reactive projection + getters agree.
    assert.ok(Object.isFrozen(store.extensionConnections));
    assert.deepStrictEqual(store.extensionConnections.map((entry) => [entry.extensionId, entry.status]), [['ext-a', 'connected']]);
    assert.strictEqual(store.getExtensionConnection('ext-a').digest, connection.digest);
    assert.deepStrictEqual(store.resolveExtensionCallName('shared_tool'), { extensionId: 'ext-a', serverToolName: 'shared_tool' });
    assert.deepStrictEqual(store.resolveExtensionCallName('alpha_only'), { extensionId: 'ext-a', serverToolName: 'alpha_only' });
    assert.ok(Object.isFrozen(store.resolveExtensionCallName('shared_tool')));

    // Attachment follows the live state.
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-a', 'active']]
    );

    // Audit: connected payload is secret-free and carries the catalog facts.
    const connected = auditEvent(events, 'extension_connected', 'ext-a');
    assert.ok(connected, 'extension_connected rides the runtime stream');
    assert.strictEqual(connected.payload.status, 'connected');
    assert.strictEqual(connected.payload.digest, connection.digest);
    assert.strictEqual(connected.payload.toolCount, 2);
    assert.strictEqual(connected.payload.shadowedCount, 0);
    assert.strictEqual(connected.payload.sequence, 1, 'the first completion is sequence 1');

    // Wire facts: handshake + initialized notification + tools/list.
    assert.deepStrictEqual(
      fixture.requests.map((entry) => entry.method),
      ['initialize', 'notifications/initialized', 'tools/list']
    );
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 2. Single-flight
// ============================================================================

test('2. concurrent and repeated connects keep exactly one session', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);

    const first = store.connectExtension('ext-a');
    const second = store.connectExtension('ext-a');
    const [firstProjection, secondProjection] = await Promise.all([first, second]);
    assert.strictEqual(initializeCount(fixture), 1, 'one session means one initialize handshake');
    assert.strictEqual(firstProjection.digest, secondProjection.digest);

    // An already-connected extension keeps its session: no second handshake.
    const repeated = await store.connectExtension('ext-a');
    assert.strictEqual(repeated.digest, firstProjection.digest);
    assert.strictEqual(initializeCount(fixture), 1, 'no duplicate session may be opened');
    assert.strictEqual(store.listExtensionConnections().length, 1);
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 3. Disconnect + fresh reconnect
// ============================================================================

test('3. disconnect drops the session, degrades the attachment, audits, and a re-connect opens a fresh session', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    assert.strictEqual(await store.disconnectExtension('ext-a'), true);
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.deepStrictEqual(store.listExtensionConnections(), []);
    assert.deepStrictEqual(store.extensionConnections, []);
    assert.strictEqual(store.resolveExtensionCallName('shared_tool'), null);
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-a', 'unavailable']],
      'a disconnected extension degrades its attachment'
    );
    const disconnected = auditEvent(events, 'extension_disconnected', 'ext-a');
    assert.ok(disconnected, 'extension_disconnected rides the runtime stream');
    assert.strictEqual(disconnected.payload.reason, 'operator');

    // A disconnected extension is a false no-op on repeat.
    assert.strictEqual(await store.disconnectExtension('ext-a'), false);

    // Re-connect runs a fresh session (second handshake), attachment active.
    const reconnected = await store.connectExtension('ext-a');
    assert.strictEqual(reconnected.status, 'connected');
    assert.strictEqual(initializeCount(fixture), 2, 'the previous session was not reused');
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-a', 'active']]
    );
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 4. In-flight teardown observed by the fixture
// ============================================================================

test('4. an in-flight connect is torn down observably: the fixture sees the aborted handshake', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A, initializeDelayMs: 3000 });
  const { store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);
    const pending = store.connectExtension('ext-a');
    assert.strictEqual(await waitFor(() => fixture.requests.some((entry) => entry.method === 'initialize')), true);
    assert.strictEqual(store.getExtensionConnection('ext-a').status, 'connecting');

    assert.strictEqual(await store.disconnectExtension('ext-a'), true);
    const cancelled = await pending;
    assert.strictEqual(cancelled.status, 'error');
    assert.strictEqual(cancelled.error.code, 'ERR_MCP_CANCELLED', 'the aborted handshake resolves as cancelled');

    assert.strictEqual(await waitFor(() => fixture.abortedRequests.count >= 1), true, 'the fixture observed the abort');
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.deepStrictEqual(store.extensionConnections, []);
    assert.ok(auditEvent(events, 'extension_disconnected', 'ext-a'), 'the operator disconnect is audited');
    assert.strictEqual(
      events.some((event) => event.type === 'extension_connect_failed' && event.payload?.extensionId === 'ext-a'),
      false,
      'an operator-aborted connect is not a connection failure'
    );
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 5. Credential / transport gates
// ============================================================================

test('5. approval, credential, and transport gates are typed, fail closed, and never touch the network', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, events, unsubscribe } = createHarness();
  const SECRET = 'p31-integration-secret-c4d1';
  try {
    const seeded = store.getCredentialVault().addCredential({ label: 'P3.1 integration probe', providerId: 'acme', apiKey: SECRET });

    // Plaintext credential gate: a real vault secret bound to a real http
    // endpoint is refused before any vault read or socket.
    installMcp(store, 'plain-ext', fixture, { credentialId: seeded.id });
    await assert.rejects(
      () => store.connectExtension('plain-ext'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL
    );

    // Approval boundary: a mismatched approved URL is refused before the
    // plaintext gate and any vault read (the bound credential would otherwise
    // trip the plaintext refusal), and an unparseable approval is refused
    // with the same typed code — both before any socket.
    store.installExtension({
      id: 'mismatch-approved-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: fixture.url },
      approvedUrl: 'https://approved.example.com/mcp',
      credentialId: seeded.id
    });
    await assert.rejects(
      () => store.connectExtension('mismatch-approved-ext'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT
    );
    store.installExtension({
      id: 'bad-approved-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: fixture.url },
      approvedUrl: 'not-a-url'
    });
    await assert.rejects(
      () => store.connectExtension('bad-approved-ext'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT
    );

    // Missing credential on https: fail closed before any network.
    store.installExtension({
      id: 'missing-cred-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: `https://127.0.0.1:${fixture.port}/mcp` },
      credentialId: 'ghost-cred'
    });
    await assert.rejects(
      () => store.connectExtension('missing-cred-ext'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED
    );

    // Pack and stdio refusals.
    store.installExtension({ id: 'pack-ext', kind: 'pack', transportHint: { kind: 'pack', source: 'npm:@acme/pack' } });
    await assert.rejects(
      () => store.connectExtension('pack-ext'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_CONNECTABLE
    );
    store.installExtension({ id: 'stdio-ext', kind: 'mcp', transportHint: { kind: 'stdio', command: 'npx' } });
    await assert.rejects(
      () => store.connectExtension('stdio-ext'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED
    );

    // Zero sockets, zero requests, zero connection state, zero secret leaks.
    assert.strictEqual(fixture.connections.total, 0, 'no refused gate may open a socket');
    assert.deepStrictEqual(fixture.requests, []);
    assert.deepStrictEqual(store.listExtensionConnections(), []);
    assert.ok(!JSON.stringify(events).includes(SECRET), 'audit payloads never carry the secret');
    assert.ok(!JSON.stringify(store.serialize()).includes(SECRET), 'the snapshot never carries the secret');
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 6. Unreachable endpoint
// ============================================================================

test('6. an unreachable endpoint resolves as an error status with a classified audit event', async () => {
  sharedLocalStorage.clear();
  const { store, events, unsubscribe } = createHarness();
  try {
    store.installExtension({
      id: 'dead-ext',
      kind: 'mcp',
      transportHint: { kind: 'http', url: 'http://127.0.0.1:1/mcp' }
    });
    store.attachExtension(GENERIC_REALM_ID, 'dead-ext');

    const connection = await store.connectExtension('dead-ext');
    assert.strictEqual(connection.status, 'error');
    assert.strictEqual(connection.error.code, 'ERR_MCP_NETWORK');
    assert.strictEqual(connection.catalog, null);
    assert.strictEqual(connection.digest, null);

    const failed = auditEvent(events, 'extension_connect_failed', 'dead-ext');
    assert.ok(failed, 'extension_connect_failed rides the runtime stream');
    assert.strictEqual(failed.payload.code, 'ERR_MCP_NETWORK');
    assert.ok(!('credentialId' in failed.payload), 'the audit payload carries no credential id');

    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['dead-ext', 'unavailable']],
      'a failed connect degrades the attachment'
    );
    assert.strictEqual(store.getExtensionConnection('dead-ext').status, 'error');
    assert.deepStrictEqual(store.extensionConnections.map((entry) => [entry.extensionId, entry.status]), [['dead-ext', 'error']]);
  } finally {
    unsubscribe();
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 6b. Discovery-time catalog refusal
// ============================================================================

test('6b. a catalog deriving a reserved call name fails the connect closed and never leaks the session', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: [{ name: 'read_file' }] });
  const { store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'reserved-ext', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'reserved-ext');

    const failed = await store.connectExtension('reserved-ext');
    assert.strictEqual(failed.status, 'error');
    assert.strictEqual(failed.error.code, 'ERR_EXTENSION_INVALID_CATALOG');
    assert.strictEqual(failed.catalog, null);
    const audit = auditEvent(events, 'extension_connect_failed', 'reserved-ext');
    assert.ok(audit, 'the catalog refusal is audited');
    assert.strictEqual(audit.payload.code, 'ERR_EXTENSION_INVALID_CATALOG');
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['reserved-ext', 'unavailable']],
      'a refused catalog degrades the attachment'
    );

    // Recovery: the server renames the tool and an explicit retry succeeds on
    // a fresh session (the failed session was closed, not reused).
    fixture.setTools([{ name: 'clean_tool' }]);
    const recovered = await store.connectExtension('reserved-ext');
    assert.strictEqual(recovered.status, 'connected');
    assert.deepStrictEqual(Object.keys(recovered.catalog), ['clean_tool']);
    assert.strictEqual(initializeCount(fixture), 2);
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 7. Extension↔extension conflict
// ============================================================================

test('7. the later conflicting extension is not activated; disconnect of the winner re-activates it', async () => {
  sharedLocalStorage.clear();
  const fixtureA = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const fixtureB = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_B });
  const { store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixtureA);
    installMcp(store, 'ext-b', fixtureB);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    store.attachExtension(GENERIC_REALM_ID, 'ext-b');

    await store.connectExtension('ext-a');
    const conflict = await store.connectExtension('ext-b');
    assert.strictEqual(conflict.status, 'conflict');
    assert.deepStrictEqual(conflict.conflicts, [{ callName: 'shared_tool', otherExtensionId: 'ext-a' }]);
    assert.deepStrictEqual(
      Object.keys(conflict.catalog).sort(),
      ['beta_only', 'shared_tool'],
      'the discovered catalog is disclosed even when conflicted'
    );
    assert.deepStrictEqual(store.resolveExtensionCallName('shared_tool'), { extensionId: 'ext-a', serverToolName: 'shared_tool' });
    assert.strictEqual(store.resolveExtensionCallName('beta_only'), null, 'a conflicted extension withholds every call name');
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-a', 'active'], ['ext-b', 'conflict']]
    );
    const conflicted = auditEvent(events, 'extension_conflict', 'ext-b');
    assert.ok(conflicted, 'entering conflict is audited');
    assert.strictEqual(conflicted.payload.status, 'conflict');
    assert.deepStrictEqual(conflicted.payload.conflicts, [{ callName: 'shared_tool', otherExtensionId: 'ext-a' }]);

    // The winner disconnects: the loser re-arbitrates active.
    await store.disconnectExtension('ext-a');
    const promoted = store.getExtensionConnection('ext-b');
    assert.strictEqual(promoted.status, 'connected');
    assert.deepStrictEqual(promoted.conflicts, []);
    assert.deepStrictEqual(store.resolveExtensionCallName('shared_tool'), { extensionId: 'ext-b', serverToolName: 'shared_tool' });
    assert.deepStrictEqual(store.resolveExtensionCallName('beta_only'), { extensionId: 'ext-b', serverToolName: 'beta_only' });
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-a', 'unavailable'], ['ext-b', 'active']]
    );
    const resolved = events
      .filter((event) => event.type === 'extension_conflict' && event.payload?.extensionId === 'ext-b')
      .at(-1);
    assert.strictEqual(resolved.payload.status, 'active', 'clearing the conflict is audited');
  } finally {
    unsubscribe();
    store.destroy();
    await fixtureA.close();
    await fixtureB.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 8. Reconnect drift
// ============================================================================

test("8. reconnect drift discloses added/removed call names and re-arbitrates the conflict away", async () => {
  sharedLocalStorage.clear();
  const fixtureA = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const fixtureB = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_B });
  const { store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixtureA);
    installMcp(store, 'ext-b', fixtureB);
    await store.connectExtension('ext-a');
    const conflicted = await store.connectExtension('ext-b');
    assert.strictEqual(conflicted.status, 'conflict');

    // The server changes its tool set: the contested name disappears and a new
    // one appears. An explicit reconnect is the only re-discovery path.
    fixtureB.setTools([{ name: 'beta_only' }, { name: 'beta_new', description: 'new' }]);
    const reconnected = await store.reconnectExtension('ext-b');
    assert.strictEqual(reconnected.status, 'connected');
    assert.deepStrictEqual(reconnected.conflicts, []);
    assert.strictEqual(reconnected.drift.removed.length, 1);
    assert.deepStrictEqual(reconnected.drift.removed, ['shared_tool']);
    assert.deepStrictEqual(reconnected.drift.added, ['beta_new']);
    assert.deepStrictEqual(reconnected.drift.changed, []);
    assert.deepStrictEqual(reconnected.drift.shadowedAdded, []);
    assert.deepStrictEqual(reconnected.drift.shadowedRemoved, []);
    assert.strictEqual(reconnected.drift.reordered, false);
    assert.strictEqual(reconnected.drift.digests.previous, conflicted.digest);
    assert.strictEqual(reconnected.drift.digests.next, reconnected.digest);
    assert.strictEqual(store.resolveExtensionCallName('beta_new').extensionId, 'ext-b');

    // Drift audit carries the digest pair and the call-name sets.
    const drift = auditEvent(events, 'extension_catalog_drift', 'ext-b');
    assert.ok(drift, 'extension_catalog_drift rides the runtime stream');
    assert.deepStrictEqual(drift.payload.added, ['beta_new']);
    assert.deepStrictEqual(drift.payload.removed, ['shared_tool']);
    assert.strictEqual(drift.payload.previousDigest, conflicted.digest);
    assert.strictEqual(drift.payload.digest, reconnected.digest);
    assert.ok(
      events.some((event) => event.type === 'extension_disconnected' && event.payload?.extensionId === 'ext-b' && event.payload.reason === 'reconnect'),
      'the reconnect close step is audited'
    );

    // An unchanged reconnect has an empty drift and emits no drift event.
    const driftCountBefore = events.filter((event) => event.type === 'extension_catalog_drift').length;
    const stable = await store.reconnectExtension('ext-b');
    assert.ok(stable.drift);
    assert.deepStrictEqual(
      [stable.drift.added, stable.drift.removed, stable.drift.changed, stable.drift.shadowedAdded, stable.drift.shadowedRemoved, stable.drift.reordered],
      [[], [], [], [], [], false],
      'an unchanged catalog produces an empty drift'
    );
    assert.strictEqual(
      events.filter((event) => event.type === 'extension_catalog_drift').length,
      driftCountBefore,
      'an empty drift emits no audit event'
    );
  } finally {
    unsubscribe();
    store.destroy();
    await fixtureA.close();
    await fixtureB.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 9. Launch resolution × live conflict sweep
// ============================================================================

test('9. a conflicted resolved extension loses and regains the member grants through the safe-state sweep', async () => {
  sharedLocalStorage.clear();
  const fixtureA = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const fixtureB = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_B });
  const { runtime, store, unsubscribe } = createHarness();
  try {
    store.importRealmTemplate({
      formatVersion: 1,
      template: {
        formatVersion: 1,
        id: 'integration-p31-sweep',
        name: 'P3.1 Sweep Fixture',
        description: 'One member resolving one fixture-backed extension tool.',
        agents: [{
          key: 'member',
          idPattern: 'p31-member',
          name: 'Member',
          role: 'observer',
          prompt: [{ kind: 'text', text: 'Observe.' }],
          toolProfile: { tools: ['ext-b::shared_tool', 'read_file'] },
          privileged: false
        }],
        providers: [{ kind: 'mcp', id: 'ext-b', transport: { kind: 'http', url: fixtureB.url } }]
      },
      files: {}
    });
    installMcp(store, 'ext-a', fixtureA);
    installMcp(store, 'ext-b', fixtureB);
    const receipt = await store.launchRealmFromTemplate('integration-p31-sweep', {
      extensionApprovals: [{ extensionId: 'ext-b' }]
    });
    const realmId = receipt.realm.id;
    assert.deepStrictEqual(receipt.realm.instance.resolvedTools, { shared_tool: 'ext-b' });

    const identityPort = runtime.createAgentIdentityPort();
    const grantsOf = () => [...identityPort.getAgentIdentity('p31-member', { realmId }).authority.extensions];
    assert.deepStrictEqual(grantsOf(), ['shared_tool'], 'the launch grants the resolved extension call name');
    assert.strictEqual(store.resolveExtensionCallName('beta_only')?.extensionId, undefined, 'no catalog is live before connect');

    // Winner connects first, then the realm's own extension conflicts.
    await store.connectExtension('ext-a');
    const conflict = await store.connectExtension('ext-b');
    assert.strictEqual(conflict.status, 'conflict');
    assert.deepStrictEqual(
      store.getRealm(realmId).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-b', 'conflict']]
    );
    assert.deepStrictEqual(grantsOf(), [], 'the idle member is swept to fail-closed grants');

    // Winner disconnects: the resolved extension re-arbitrates active and the
    // sweep restores the restricted member's grant. The member's explicit
    // selector intersects the (now catalog-expanded) universe, so it keeps
    // exactly the declared name — the live catalog does not widen it.
    await store.disconnectExtension('ext-a');
    assert.deepStrictEqual(
      store.getRealm(realmId).extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ext-b', 'active']]
    );
    assert.deepStrictEqual(
      grantsOf(),
      ['shared_tool'],
      'the restricted selector never expands beyond its declared names'
    );
  } finally {
    unsubscribe();
    store.destroy();
    await fixtureA.close();
    await fixtureB.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 10. No auto-connect; reset/destroy teardown
// ============================================================================

test('10. nothing auto-connects at launch or hydration, and reset/destroy drop live session state', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, unsubscribe } = createHarness();
  let hydrated = null;
  let destroyed = null;
  try {
    store.importRealmTemplate({
      formatVersion: 1,
      template: {
        formatVersion: 1,
        id: 'integration-p31-autoconnect',
        name: 'P3.1 Autoconnect Fixture',
        description: 'One extension-backed member.',
        agents: [{
          key: 'member',
          idPattern: 'p31-auto-member',
          name: 'Member',
          role: 'observer',
          prompt: [{ kind: 'text', text: 'Observe.' }],
          toolProfile: { tools: ['ext-a::shared_tool'] },
          privileged: false
        }],
        providers: [{ kind: 'mcp', id: 'ext-a', transport: { kind: 'http', url: fixture.url } }]
      },
      files: {}
    });
    installMcp(store, 'ext-a', fixture);
    await store.launchRealmFromTemplate('integration-p31-autoconnect', {
      extensionApprovals: [{ extensionId: 'ext-a' }]
    });
    assert.deepStrictEqual(store.listExtensionConnections(), []);
    assert.strictEqual(fixture.connections.total, 0, 'launch must never dial an endpoint');

    assert.strictEqual(store.saveToStorage(), true);
    const reloadedRuntime = new AgentRuntime({ autoBootstrapDirector: false });
    hydrated = new SandboxStore({
      runtime: reloadedRuntime,
      autoBootstrapDirector: false,
      autoHydrate: true
    });
    assert.deepStrictEqual(hydrated.listExtensionConnections(), []);
    assert.strictEqual(hydrated.getExtensionConnection('ext-a'), null);
    assert.strictEqual(hydrated.resolveExtensionCallName('shared_tool'), null);
    assert.strictEqual(fixture.connections.total, 0, 'hydration must never dial an endpoint');

    // A live session is session-only: reset drops it and opens nothing new.
    await store.connectExtension('ext-a');
    const requestsAfterConnect = fixture.requests.length;
    store.reset();
    assert.deepStrictEqual(store.listExtensionConnections(), []);
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.strictEqual(store.resolveExtensionCallName('shared_tool'), null);
    assert.strictEqual(fixture.requests.length, requestsAfterConnect, 'reset does not re-dial anything');

    // destroy() closes live sessions without leaking rejections.
    destroyed = createHarness();
    installMcp(destroyed.store, 'ext-a', fixture);
    await destroyed.store.connectExtension('ext-a');
    destroyed.store.destroy();
    assert.deepStrictEqual(destroyed.store.listExtensionConnections(), []);
    destroyed.unsubscribe();
  } finally {
    if (hydrated) hydrated.destroy();
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 11. F1: disconnect marker survives the install-only heal
// ============================================================================

test('11. a disconnected attachment stays unavailable across unrelated registry saves until an explicit reconnect', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const unrelated = await createMcpFixtureServer({ tools: [{ name: 'other_tool' }] });
  const { store, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');
    assert.strictEqual(await store.disconnectExtension('ext-a'), true);
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['unavailable']);

    // An unrelated registry install flows through the persistence-seam heal:
    // the in-memory disconnect marker must keep the attachment unavailable.
    installMcp(store, 'ext-b', unrelated);
    assert.deepStrictEqual(
      attachmentStatuses(store, 'ext-a'),
      ['unavailable'],
      'the install-only heal must not flip a disconnected attachment back to active'
    );
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.strictEqual(store.resolveExtensionCallName('shared_tool'), null);

    // A second unrelated registry save (removal) keeps it unavailable too.
    assert.strictEqual(store.removeExtension('ext-b'), true);
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['unavailable']);

    // The explicit reconnect is the only path back to active.
    const reconnected = await store.connectExtension('ext-a');
    assert.strictEqual(reconnected.status, 'connected');
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['active']);
    assert.deepStrictEqual(store.resolveExtensionCallName('shared_tool'), { extensionId: 'ext-a', serverToolName: 'shared_tool' });
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    await unrelated.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 12. F2: reconnect gates run before the previous session is torn down
// ============================================================================

test('12. a reconnect gate rejection keeps the previous live connection, catalog, and resolver entry', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    const first = await store.connectExtension('ext-a');
    const digest = first.digest;

    // Invalid option: rejected before any teardown.
    await assert.rejects(
      () => store.reconnectExtension('ext-a', { requestTimeoutMs: -1 }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
    );
    const afterInvalidOptions = store.getExtensionConnection('ext-a');
    assert.ok(afterInvalidOptions, 'the previous session must survive an invalid reconnect option');
    assert.strictEqual(afterInvalidOptions.status, 'connected');
    assert.strictEqual(afterInvalidOptions.digest, digest);
    assert.deepStrictEqual(store.resolveExtensionCallName('shared_tool'), { extensionId: 'ext-a', serverToolName: 'shared_tool' });
    assert.strictEqual(initializeCount(fixture), 1, 'the rejected reconnect performed no teardown and no redial');

    // Record-level approval gate: same guarantee.
    store.getExtensionRegistry().reconcile([{
      ...store.getExtension('ext-a'),
      approvedUrl: 'https://approved.example.com/mcp'
    }]);
    await assert.rejects(
      () => store.reconnectExtension('ext-a'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT
    );
    const afterApprovalMismatch = store.getExtensionConnection('ext-a');
    assert.ok(afterApprovalMismatch, 'the previous session must survive a refused approval boundary');
    assert.strictEqual(afterApprovalMismatch.status, 'connected');
    assert.strictEqual(afterApprovalMismatch.digest, digest);
    assert.strictEqual(initializeCount(fixture), 1, 'the refused reconnect never dialled');
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['active']);
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 13. removeExtension closes a live session
// ============================================================================

test('13. removeExtension drops a live session, audits the close, and never redials', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);
    await store.connectExtension('ext-a');

    assert.strictEqual(store.removeExtension('ext-a'), true);
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.deepStrictEqual(store.extensionConnections, []);
    assert.strictEqual(store.resolveExtensionCallName('shared_tool'), null);
    const closeAudit = events.filter(
      (event) => event.type === 'extension_disconnected'
        && event.payload?.extensionId === 'ext-a'
        && event.payload.reason === 'removed'
    );
    assert.strictEqual(closeAudit.length, 1, 'the removal close is audited');
    assert.strictEqual(initializeCount(fixture), 1, 'removal never redials');
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 14. `connecting` never churns attachment status
// ============================================================================

test('14. a connecting session never churns attachment status during a registry save', async () => {
  sharedLocalStorage.clear();
  const delayed = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A, initializeDelayMs: 600 });
  const plain = await createMcpFixtureServer({ tools: [{ name: 'plain_tool' }] });
  const { store, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', delayed);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');

    // First connect: the approved-active attachment must not churn while the
    // handshake is in flight (`connecting` imposes no attachment constraint).
    const pending = store.connectExtension('ext-a');
    assert.strictEqual(await waitFor(() => delayed.requests.some((entry) => entry.method === 'initialize')), true);
    assert.strictEqual(store.getExtensionConnection('ext-a').status, 'connecting');
    installMcp(store, 'plain-ext', plain);
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['active'], 'connecting never churns an active attachment');
    const connected = await pending;
    assert.strictEqual(connected.status, 'connected');
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['active']);

    // Reconnect after an explicit disconnect: the disconnected marker keeps
    // the attachment unavailable while the replacement handshake is in flight.
    assert.strictEqual(await store.disconnectExtension('ext-a'), true);
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['unavailable']);
    const reconnecting = store.reconnectExtension('ext-a');
    assert.strictEqual(await waitFor(() => initializeCount(delayed) === 2), true);
    assert.strictEqual(store.getExtensionConnection('ext-a').status, 'connecting');
    installMcp(store, 'plain-ext-2', plain);
    assert.deepStrictEqual(
      attachmentStatuses(store, 'ext-a'),
      ['unavailable'],
      'a reconnect stays unavailable while connecting'
    );
    const reconnected = await reconnecting;
    assert.strictEqual(reconnected.status, 'connected');
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['active']);
  } finally {
    unsubscribe();
    store.destroy();
    await delayed.close();
    await plain.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 15. disconnect during a reconnect handshake
// ============================================================================

test('15. a disconnect during a reconnect handshake cancels it and leaves no live state', async () => {
  sharedLocalStorage.clear();
  const delayed = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A, initializeDelayMs: 600 });
  const { store, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', delayed);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const reconnecting = store.reconnectExtension('ext-a');
    assert.strictEqual(await waitFor(() => initializeCount(delayed) === 2), true);
    assert.strictEqual(store.getExtensionConnection('ext-a').status, 'connecting');

    assert.strictEqual(await store.disconnectExtension('ext-a'), true);
    const cancelled = await reconnecting;
    assert.strictEqual(cancelled.status, 'error');
    assert.strictEqual(cancelled.error.code, 'ERR_MCP_CANCELLED');
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.deepStrictEqual(store.extensionConnections, []);
    assert.strictEqual(store.resolveExtensionCallName('shared_tool'), null);
    assert.deepStrictEqual(attachmentStatuses(store, 'ext-a'), ['unavailable']);
    assert.strictEqual(await waitFor(() => delayed.abortedRequests.count >= 1), true, 'the fixture observed the abort');

    // Nothing resurrects once the dust settles.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(store.getExtensionConnection('ext-a'), null);
    assert.deepStrictEqual(store.listExtensionConnections(), []);
  } finally {
    unsubscribe();
    store.destroy();
    await delayed.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 16. Realm-level attachment selection caps the catalog-driven grant universe
// ============================================================================

test('16. the attachment toolSelection narrows the catalog-driven universe before the per-agent selector', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({
    tools: [
      { name: 'echo', description: 'Echo' },
      { name: 'sse', description: 'SSE' }
    ]
  });
  const { runtime, store, unsubscribe } = createHarness();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a', { toolSelection: ['echo'] });
    await store.connectExtension('ext-a');
    assert.deepStrictEqual(
      store.resolveExtensionCallName('sse'),
      { extensionId: 'ext-a', serverToolName: 'sse' },
      'the exclusion is an attachment-selection rule, not a lost catalog name'
    );

    const identityPort = runtime.createAgentIdentityPort();
    const grantsOf = (id) => [...identityPort.getAgentIdentity(id, { realmId: GENERIC_REALM_ID }).authority.extensions];

    await store.launchAgent({
      id: 'p33-selection-all',
      name: 'Selection all',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: []
    });
    assert.deepStrictEqual(
      grantsOf('p33-selection-all'),
      ['echo'],
      "an 'all' member gets only the attachment selection's catalog names"
    );

    await store.launchAgent({
      id: 'p33-selection-selector',
      name: 'Selection selector',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: [],
      extensionTools: ['sse', 'echo']
    });
    assert.deepStrictEqual(
      grantsOf('p33-selection-selector'),
      ['echo'],
      'the per-agent selector intersects the capped universe and can never widen it'
    );

    await store.launchAgent({
      id: 'p33-selection-excluded',
      name: 'Selection excluded',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: [],
      extensionTools: ['sse']
    });
    assert.deepStrictEqual(
      grantsOf('p33-selection-excluded'),
      [],
      'a selection-excluded name is dropped fail-closed'
    );
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 18. M3 realm ceiling edits against the live catalog (ticket 094de1b)
// ============================================================================

test('18. [M3] setExtensionToolSelection validates against the live catalog and reauthorizes idle members', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'm3-selection-ext', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'm3-selection-ext', { toolSelection: 'all' });
    await store.connectExtension('m3-selection-ext');
    await store.launchAgent({
      id: 'm3-selection-member',
      name: 'Selection member',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: [],
      extensionTools: ['shared_tool']
    });
    const identityPort = runtime.createAgentIdentityPort();
    const grantsOf = (id) => [...identityPort.getAgentIdentity(id, { realmId: GENERIC_REALM_ID }).authority.extensions];
    assert.deepStrictEqual(grantsOf('m3-selection-member'), ['shared_tool']);

    assert.throws(
      () => store.setExtensionToolSelection(GENERIC_REALM_ID, 'm3-selection-ext', ['not_a_live_tool']),
      /live catalog|unknown/i,
      'a name outside the live catalog fails closed'
    );
    assert.deepStrictEqual(grantsOf('m3-selection-member'), ['shared_tool'], 'unchanged after the refusal');

    const updated = store.setExtensionToolSelection(GENERIC_REALM_ID, 'm3-selection-ext', ['alpha_only']);
    assert.deepStrictEqual([...updated.extensions[0].toolSelection], ['alpha_only']);
    assert.deepStrictEqual(
      grantsOf('m3-selection-member'),
      [],
      'the idle member is reauthorized synchronously against the new ceiling'
    );
    const audit = events.find((event) => event.type === 'extension_tool_selection_updated');
    assert.ok(audit, 'the ceiling change is audited');
    assert.equal(audit.payload.extensionId, 'm3-selection-ext');
    assert.equal(audit.payload.source, 'operator');
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 19. M4 privileged realm-wide attach against the live connection lifecycle
// (ticket a02bce7)
// ============================================================================

test('19. [M4] a privileged realm-wide attach rides the live connection lifecycle and the member sweep', async () => {
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS_A });
  const { runtime, store, events, unsubscribe } = createHarness();
  try {
    installMcp(store, 'm4-priv-ext', fixture);
    await store.connectExtension('m4-priv-ext');
    const identityPort = runtime.createAgentIdentityPort();
    const grantsOf = (id) => [...identityPort.getAgentIdentity(id, { realmId: GENERIC_REALM_ID }).authority.extensions];

    await store.launchAgent({
      id: 'm4-conn-member',
      name: 'M4 Conn Member',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: [],
      extensionTools: ['alpha_only']
    });
    await store.launchAgent({
      id: 'm4-conn-actor',
      name: 'M4 Conn Actor',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['readonly']
    });
    await store.grantAuthority('m4-conn-actor', AGENT_AUTHORITIES.EXTENSIONS);
    assert.deepStrictEqual(grantsOf('m4-conn-member'), [], 'no attachment → no grants');

    const port = store.getRealmAdminPort();
    const attach = port.attachExtension({
      actorRef: 'm4-conn-actor',
      extensionId: 'm4-priv-ext',
      toolSelection: ['alpha_only']
    });
    assert.equal(attach.success, true, JSON.stringify(attach));
    assert.equal(attach.applied, true);
    assert.deepStrictEqual(
      store.getRealm(GENERIC_REALM_ID).extensions.map((entry) => [entry.extensionId, entry.toolSelection]),
      [['m4-priv-ext', ['alpha_only']]],
      'the realm-wide uniform set gains the attachment with the requested ceiling'
    );
    assert.deepStrictEqual(grantsOf('m4-conn-member'), ['alpha_only'], 'the idle member is swept');
    const attachedEvent = events.find((event) => event.type === 'extension_attached' && event.payload?.extensionId === 'm4-priv-ext');
    assert.equal(attachedEvent.payload.source, 'privileged-agent');
    assert.equal(attachedEvent.payload.actorId, 'm4-conn-actor');

    // Disconnect degrades the attachment and the existing sweep drops the
    // member grants; reconnect restores both through the same internals.
    await store.disconnectExtension('m4-priv-ext');
    assert.equal(store.getRealm(GENERIC_REALM_ID).extensions[0].status, 'unavailable');
    assert.deepStrictEqual(grantsOf('m4-conn-member'), [], 'a disconnected extension grants nothing');

    await store.reconnectExtension('m4-priv-ext');
    assert.equal(store.getRealm(GENERIC_REALM_ID).extensions[0].status, 'active');
    assert.deepStrictEqual(grantsOf('m4-conn-member'), ['alpha_only'], 'reconnect restores the member grants');

    // A repeated privileged attach is a no-op that never disturbs live state.
    const repeated = port.attachExtension({ actorRef: 'm4-conn-actor', extensionId: 'm4-priv-ext' });
    assert.equal(repeated.applied, false);
    assert.equal(repeated.alreadyAttached, true);
    assert.equal(
      events.filter((event) => event.type === 'extension_attached' && event.payload?.extensionId === 'm4-priv-ext').length,
      1,
      'no duplicate audit on the idempotent path'
    );
    assert.deepStrictEqual(grantsOf('m4-conn-member'), ['alpha_only']);
  } finally {
    unsubscribe();
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});
