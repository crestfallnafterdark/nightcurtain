/**
 * @file tests/integration/realm_export_test.js
 * @description S2 realm-export lane (ticket 3fe5221, D0b design): full-realm
 *   archive `RealmArchiveEnvelope` v1 acceptance through the real
 *   `SandboxStore` + `AgentRuntime` + `VirtualFS` + `MessagingBus` +
 *   `WorldClock` + `RealmRegistry` + `ExtensionRegistry` composition root.
 *
 *   Asserted contract (design AC names):
 *   - AC-REX-1 `round-trip equality (fresh realm, remapped ids)`: export →
 *     import into the same session; the fresh realm reproduces members by bare
 *     id (config minus credential/authority/parentage fields), histories (ids,
 *     order, roles), redo stacks, telemetry, the recycled member, the realm
 *     record, attachments, template payload, saved payload, per-workspace VFS
 *     `{path, content, readOnly, owner}` equality, with every canonical key
 *     under the new realm id and the source realm id absent from the new bytes.
 *   - AC-REX-2 `redaction asserted from export bytes`: seeded secret/KEK
 *     values, `keyId`, extension install fields (`credentialId`/`approvedUrl`/
 *     `transportHint`), URL userinfo/credential query params, a foreign realm's
 *     member/mail/clock/VFS state, session metadata, and ungrouped workspace
 *     bytes are absent from the serialized archive.
 *   - AC-REX-3 `slice completeness`: every checklist row present with counts
 *     equal to the live pre-export state (members active/recycled incl.
 *     histories/redo/telemetry, bus partitions + terminated + audit,
 *     per-agent schedules (foreign excluded), clock member + realm-global
 *     partitions/events, realm-global + member + pinned VFS workspaces,
 *     attachments, template, saved payloads, descriptive authority).
 *   - AC-REX-4 `import default-deny (no authority minting)`: archive carries
 *     `privileged:true`, `realmBypass`, template/hydration grants and a
 *     wildcard allow set; after import every member descriptor is default-deny
 *     (`privileged:false`, no `realmBypass`, no authority ids, `'*'` absent),
 *     `droppedAuthority` lists them, and tool selectors re-apply only through
 *     the operator path.
 *   - AC-REX-5 `collision, rollback, and failure atomicity`: pinned-workspace
 *     collision rejects with zero mutation; an injected VFS write failure and
 *     an injected runtime slice failure fully roll back; re-import mints a new
 *     independent realm each time.
 *   - AC-REX-6 `receipts + operator re-grant path`: the import receipt shape,
 *     and a post-import operator `grantRealmBypass` on an imported member
 *     succeeds through the ordinary operator API.
 *
 * Zero-Mock: every engine class (store, runtime, VirtualFS, messaging bus,
 * world clock, realm registry, extension registry, preset catalog) is the real
 * production class wired through the store's late-bound identity bridge; the
 * fixture declares no reachable model endpoint (a closed loopback preset), and
 * every turn the fixture can provoke fails fast without network access.
 *
 * Standalone: `timeout 180 node tests/integration/realm_export_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime, createAgentIdentityKey, parseAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { createPresetCatalog } from '../../src/lib/sandbox/presetCatalog/index.ts';
import { SandboxStore, createSandboxStore, SANDBOX_STORE_ERROR_CODES } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AGENT_AUTHORITIES } from '../../src/lib/sandbox/realmCatalog/index.ts';

/** Custom catalog preset id used to keep every fixture agent off the network. */
const OFFLINE_PRESET_ID = 'preset_rex_offline';

/** Closed loopback endpoint the offline preset points at. */
const OFFLINE_ENDPOINT = 'http://127.0.0.1:1/v1';

/** Seeded credential value that must never appear in archive bytes. */
const SEEDED_VALUE_ALPHA = 'rex-alpha-01';

/** Seeded encryption value that must never appear in archive bytes. */
const SEEDED_VALUE_BETA = 'rex-beta-01';

/** Marker string that identifies foreign-realm state. */
const FOREIGN_MARKER = 'foreign-realm-marker-content';

/**
 * Canonical realm-global workspace/partition key of a realm (design literal).
 *
 * @param {string} realmId - Realm id.
 * @returns {string} `realm:<realmId>:global`.
 */
function realmGlobalKey(realmId) {
  return `realm:${realmId}:global`;
}

/**
 * Creates a fully wired, injectable harness: real substrates shared between the
 * injected runtime and the injected store, so tests keep a live runtime handle
 * for entity-level fixture seeding without mocking any engine class.
 *
 * @returns {object} Harness carrying store/runtime/substrate references.
 */
function createHarness() {
  let runtimeRef = null;
  const identityBridge = {
    getAgentIdentity: (agentId, scope) => (
      runtimeRef ? runtimeRef.createAgentIdentityPort().getAgentIdentity(agentId, scope) : null
    ),
    listAgentIdentities: (scope) => (
      runtimeRef ? runtimeRef.createAgentIdentityPort().listAgentIdentities(scope) : []
    )
  };
  const virtualFs = new VirtualFS({ defaultBudgetBytes: 20000, identityPort: identityBridge });
  const messagingBus = new MessagingBus({ identityPort: identityBridge });
  const worldClock = new WorldClock({ virtualFs, identityPort: identityBridge });
  // Real preset catalog bound as the injected runtime's turn-time source, so
  // every fixture turn resolves the closed loopback endpoint (no network).
  const runtimeCatalog = createPresetCatalog({
    storage: { load: () => [], save: () => {} },
    getActivePresetId: () => OFFLINE_PRESET_ID,
    setActivePresetId: () => {}
  });
  runtimeCatalog.savePreset({
    id: OFFLINE_PRESET_ID,
    name: 'Realm export offline',
    isCustom: true,
    modelConfig: { providerId: 'openai', modelId: 'rex-offline', url: OFFLINE_ENDPOINT }
  });
  const runtime = new AgentRuntime({
    virtualFs,
    messagingBus,
    worldClock,
    presetSource: runtimeCatalog.createPresetSourcePort(),
    autoBootstrapDirector: false
  });
  runtimeRef = runtime;
  const store = new SandboxStore({
    virtualFs,
    messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  return { store, runtime, virtualFs, messagingBus, worldClock };
}

/**
 * Convenience: isolated non-hydrating store (store-owned wiring).
 *
 * @returns {object} Fresh `SandboxStore` instance.
 */
function createStore() {
  return createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
}

/**
 * Registers the closed-endpoint custom preset in the store's catalog.
 *
 * @param {object} store - Store under test.
 */
function registerOfflinePreset(store) {
  store.getPresetCatalog().savePreset({
    id: OFFLINE_PRESET_ID,
    name: 'Realm export offline',
    isCustom: true,
    modelConfig: { providerId: 'openai', modelId: 'rex-offline', url: OFFLINE_ENDPOINT }
  });
}

/**
 * Bounded wait until the named registration reports a non-busy state.
 *
 * @param {object} runtime - Live runtime.
 * @param {string} key - Canonical identity key to watch.
 * @param {number} [timeoutMs] - Maximum wait.
 * @returns {Promise<void>} Resolves when idle or the timeout elapses.
 */
async function waitForIdle(runtime, key, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  const busyStates = new Set(['running', 'canceling', 'waiting_for_input', 'waiting_for_dependents']);
  while (Date.now() < deadline) {
    const agent = runtime.getAgent(key);
    if (!agent || !busyStates.has(agent.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Mail wakes are debounced by 10ms; give a failed turn a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

/**
 * Captures a coded error, or `null` when the call returns.
 *
 * @param {Function} fn - Synchronous call under test.
 * @returns {Error|null} Thrown error.
 */
function captureThrow(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Counts canonical keys belonging to one realm.
 *
 * @param {Iterable<string>} keys - Candidate keys.
 * @param {string} realmId - Realm id to match.
 * @returns {number} Count of keys in the realm family.
 */
function countRealmKeys(keys, realmId) {
  let count = 0;
  for (const key of keys) {
    const parsed = typeof key === 'string' ? parseAgentIdentityKey(key) : null;
    if (parsed && parsed.realmId === realmId) count += 1;
  }
  return count;
}

/**
 * Reduces a VFS file map to the design's round-trip projection.
 *
 * @param {Record<string, object>} filesByPath - Path → file record.
 * @returns {object[]} Sorted `{path, content, readOnly, owner}` projection.
 */
function vfsProjection(filesByPath) {
  return Object.values(filesByPath ?? {})
    .map((file) => ({ path: file.path, content: file.content, readOnly: file.readOnly, owner: file.owner }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

// ============================================================================
// Fixture: one rich source realm, one same-literal-id foreign realm
// ============================================================================

/**
 * Builds the shared rich fixture: a foreign realm with the same literal member
 * ids, the source realm with live histories/redo/telemetry/interrupted turn/
 * pending precalls, a wildcard+credential-shaped extra member, a recycled
 * member, mail (unread + archived + audit), schedules, clock partitions, VFS
 * realm-global + member + pinned workspaces, grants, an extension attachment,
 * and a realm-scoped saved payload.
 *
 * @returns {Promise<object>} Fixture: harness, realms, keys, mail ids, export result.
 */
async function buildRichFixture() {
  const harness = createHarness();
  const { store, runtime, worldClock } = harness;
  registerOfflinePreset(store);

  // Foreign realm first (same literal member ids, same template).
  const foreignLaunch = await store.launchRealmFromTemplate('demo', {
    name: 'Foreign Realm',
    presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
  });
  const foreign = foreignLaunch.realm;

  // Source realm under test.
  const sourceLaunch = await store.launchRealmFromTemplate('demo', {
    name: 'Export Source',
    description: 'Archive fixture source realm.',
    color: '#2244aa',
    presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
  });
  const source = sourceLaunch.realm;

  // Extra member: credential-shaped model config, a wildcard capability, and an
  // explicit pinned workspace.
  await store.launchAgent({
    id: 'rex-extra',
    name: 'Extra Operator',
    role: 'support',
    realmId: source.id,
    workspaceId: 'rex-pinned-workspace',
    modelConfig: {
      providerId: 'openai',
      modelId: 'rex-extra-model',
      keyId: 'vault_ref_rex_secret',
      apiKey: SEEDED_VALUE_ALPHA,
      url: `https://user:${SEEDED_VALUE_ALPHA}@example.com/v1?token=${SEEDED_VALUE_ALPHA}&kek=${SEEDED_VALUE_BETA}`
    }
  });
  await store.updateAgentConfig('rex-extra', { allowedTools: ['*'] });

  // Recycled member of the source realm.
  await store.launchAgent({
    id: 'rex-recycled',
    name: 'Recycled Member',
    role: 'support',
    realmId: source.id,
    modelConfig: { providerId: 'openai', modelId: 'rex-recycled-model' }
  });
  const recycledKey = createAgentIdentityKey(source.id, 'rex-recycled');
  assert.equal(store.killAgent(recycledKey, 'archive fixture recycle'), true, 'fixture recycles a member');

  const coordinatorKey = createAgentIdentityKey(source.id, 'coordinator');
  const workerKey = createAgentIdentityKey(source.id, 'worker');
  const extraKey = createAgentIdentityKey(source.id, 'rex-extra');
  const coordinator = runtime.getAgent(coordinatorKey);
  const worker = runtime.getAgent(workerKey);
  assert.ok(coordinator && worker, 'fixture members are live');

  // Histories (system/tool/assistant roles), redo stacks, telemetry,
  // interrupted turn, pending precalls, diagnostics.
  coordinator.history.push(
    { id: 'hist-coord-1', role: 'system', content: 'Coordinator system briefing.' },
    {
      id: 'hist-coord-2',
      role: 'assistant',
      content: 'Fetching the brief.',
      tool_calls: [{ id: 'call-coord-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    },
    { id: 'hist-coord-3', role: 'tool', content: 'Brief body.', tool_call_id: 'call-coord-1' }
  );
  coordinator.redoStack.push({ turnId: 'redo-coord-1', note: 'fixture redo bundle' });
  coordinator.turnCount = 4;
  coordinator.telemetry.inputTokens = 111;
  coordinator.telemetry.cachedInputTokens = 22;
  coordinator.telemetry.outputTokens = 33;
  coordinator.telemetry.totalTokens = 166;
  coordinator.telemetry.turnCount = 4;
  coordinator.telemetry.lastPromptTokens = 11;
  coordinator.telemetry.lastCachedPromptTokens = 2;
  coordinator.telemetry.lastCompletionTokens = 3;
  coordinator.telemetry.precallCount = 1;
  coordinator.lastSummary = 'Coordinator summary.';
  coordinator.lastInterruptedTurn = { input: 'interrupted fixture', mode: 'user', timestamp: 1700000000000, cancelled: true };
  coordinator.pendingPrecalls.push({ tool: 'read_file', args: { filePath: '/brief.md' } });
  coordinator.lastError = `Provider rejected bearer ${SEEDED_VALUE_ALPHA}`;
  worker.history.push({ id: 'hist-worker-1', role: 'user', content: 'Worker task.' });
  worker.redoStack.push({ turnId: 'redo-worker-1', note: 'worker redo' });
  worker.turnCount = 2;
  worker.telemetry.inputTokens = 7;
  worker.telemetry.totalTokens = 7;

  // VFS: realm-global, member-private, pinned, plus foreign-realm bytes.
  store.writeFile('/realm/notes.md', 'Realm-wide fixture note.', {
    workspaceId: realmGlobalKey(source.id), readOnly: false, owner: 'operator'
  });
  store.writeFile('/member/notes.md', 'Coordinator private note.', {
    workspaceId: coordinatorKey, readOnly: true, owner: 'coordinator'
  });
  store.writeFile('/pinned/notes.md', 'Pinned workspace note.', {
    workspaceId: 'rex-pinned-workspace', readOnly: false, owner: 'rex-extra'
  });
  store.writeFile('/foreign/realm.md', `${FOREIGN_MARKER} realm-global`, {
    workspaceId: realmGlobalKey(foreign.id)
  });
  store.writeFile('/foreign/member.md', `${FOREIGN_MARKER} member`, {
    workspaceId: createAgentIdentityKey(foreign.id, 'coordinator')
  });

  // World clock: member + realm-global partitions/events; foreign partitions.
  const operatorContext = { principal: runtime.getOperatorPrincipal() };
  worldClock.setTime({ totalSeconds: 4321, date: 'Day 9', targetAgentId: coordinatorKey }, operatorContext);
  worldClock.registerEvent({
    targetAgentId: coordinatorKey, name: 'Coordinator event', type: 'narrative', description: 'Coordinator-partition fixture event.'
  }, operatorContext);
  worldClock.setTime({ totalSeconds: 4321, date: 'Day 9', targetAgentId: realmGlobalKey(source.id) }, operatorContext);
  worldClock.registerEvent({
    targetAgentId: realmGlobalKey(source.id), name: 'Realm event', type: 'narrative', description: 'Realm-global fixture event.'
  }, operatorContext);
  worldClock.setTime({ totalSeconds: 9999, date: 'Foreign Day', targetAgentId: createAgentIdentityKey(foreign.id, 'coordinator') }, operatorContext);
  worldClock.registerEvent({
    targetAgentId: createAgentIdentityKey(foreign.id, 'worker'), name: FOREIGN_MARKER, description: FOREIGN_MARKER
  }, operatorContext);

  // Per-agent schedules (source realm) + a foreign schedule.
  await store.scheduleTimer({ durationSeconds: 3600, prompt: 'Coordinator follow-up.', agentId: coordinatorKey });
  await store.scheduleTimer({ durationSeconds: 3600, prompt: 'Worker follow-up.', agentId: workerKey });
  await store.scheduleTimer({ durationSeconds: 3600, prompt: 'Foreign follow-up.', agentId: createAgentIdentityKey(foreign.id, 'worker') });

  // Descriptive authority state: realmBypass + publishing pair.
  await store.grantRealmBypass('rex-extra', { realmId: source.id });
  await store.grantTemplateAuthority('coordinator', { realmId: source.id });
  await store.grantHydrationAuthority('worker', { realmId: source.id });

  // Extension attachment (installed locally so import re-attaches it).
  store.installExtension({ id: 'rex-ext', kind: 'pack', transportHint: { kind: 'pack', source: 'fixture-pack' } });
  store.attachExtension(source.id, 'rex-ext', { toolSelection: 'all' });

  // Saved payloads: one targeting the realm template, one foreign to it.
  store.saveInstancePayload({
    name: 'Act 1', templateId: 'demo', templateVersion: 'sha256:fixture', payload: { formatVersion: 2, note: 'fixture payload' }
  });
  store.saveInstancePayload({
    name: 'Other payload', templateId: 'not-demo', templateVersion: 'sha256:other', payload: { formatVersion: 2, note: 'other' }
  });

  // Mail: two messages for the source realm (one archived), one foreign.
  const sentA = store.sendMessage(coordinatorKey, workerKey, 'Handoff A');
  assert.equal(sentA.success, true, 'fixture mail A delivers');
  const sentB = store.sendMessage(coordinatorKey, workerKey, 'Handoff B');
  assert.equal(sentB.success, true, 'fixture mail B delivers');
  const archived = store.markMessageRead(workerKey, sentB.messageId);
  assert.equal(archived.success, true, 'fixture archives one message');
  const foreignSent = store.sendMessage(
    createAgentIdentityKey(foreign.id, 'coordinator'),
    createAgentIdentityKey(foreign.id, 'worker'),
    `${FOREIGN_MARKER} mail`
  );
  assert.equal(foreignSent.success, true, 'fixture foreign mail delivers');

  await waitForIdle(runtime, workerKey);

  const exportResult = store.exportRealmArchive(source.id);
  assert.equal(exportResult.success, true, `fixture export succeeds (${exportResult.code ?? 'ok'})`);
  assert.equal(typeof exportResult.json, 'string', 'fixture export carries canonical JSON');

  return {
    harness,
    source,
    foreign,
    keys: { coordinatorKey, workerKey, extraKey, recycledKey },
    mailIds: { A: sentA.messageId, B: sentB.messageId },
    exportResult,
    envelope: JSON.parse(exportResult.json)
  };
}

/** Shared rich fixture (built once per process). */
let richFixturePromise = null;

/**
 * Lazily builds and returns the shared rich fixture.
 *
 * @returns {Promise<object>} Rich fixture.
 */
function getRichFixture() {
  if (!richFixturePromise) richFixturePromise = buildRichFixture();
  return richFixturePromise;
}

/** Shared rich import (one import per process; later ACs reuse it). */
let richImportPromise = null;

/**
 * Lazily imports the rich archive once and returns the receipt plus the
 * imported realm's re-exported envelope.
 *
 * @returns {Promise<object>} Rich import result.
 */
function getRichImport() {
  if (!richImportPromise) {
    richImportPromise = (async () => {
      const fixture = await getRichFixture();
      const receipt = fixture.harness.store.importRealmArchive(fixture.exportResult.json);
      assert.equal(receipt.success, true, 'rich archive import succeeds');
      const reExport = fixture.harness.store.exportRealmArchive(receipt.realmId);
      assert.equal(reExport.success, true, 'imported realm re-exports');
      return { fixture, receipt, newRealmId: receipt.realmId, importedEnvelope: JSON.parse(reExport.json) };
    })();
  }
  return richImportPromise;
}

/**
 * Builds a minimal source-realm archive for failure-injection tests: one
 * realm-global file, no pinned workspace, so repeated imports never collide.
 *
 * @returns {Promise<object>} Minimal fixture.
 */
async function buildMinimalFixture() {
  const harness = createHarness();
  const { store } = harness;
  registerOfflinePreset(store);
  const launch = await store.launchRealmFromTemplate('demo', {
    name: 'Minimal Source',
    presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
  });
  store.writeFile('/minimal/note.md', 'Minimal note.', { workspaceId: realmGlobalKey(launch.realm.id) });
  const result = store.exportRealmArchive(launch.realm.id);
  assert.equal(result.success, true, 'minimal fixture export succeeds');
  return { harness, source: launch.realm, exportResult: result };
}

// ============================================================================
// AC-REX-1: round-trip equality (fresh realm, remapped ids)
// ============================================================================

test('AC-REX-1 round-trip equality (fresh realm, remapped ids)', async () => {
  const { fixture, receipt, newRealmId, importedEnvelope } = await getRichImport();
  const { source, keys, envelope: sourceEnvelope } = fixture;
  const { store, runtime } = fixture.harness;

  assert.ok(newRealmId && newRealmId !== source.id, 'import mints a fresh realm id');
  assert.equal(receipt.membersImported, 3, 'three active members import');
  assert.equal(receipt.membersRecycled, 1, 'one recycled member imports');

  const newRealm = store.getRealm(newRealmId);
  assert.ok(newRealm, 'the imported realm record exists');
  assert.equal(newRealm.name, source.name, 'realm name round-trips');
  assert.equal(newRealm.description, source.description, 'realm description round-trips');
  assert.equal(newRealm.color, source.color, 'realm color round-trips');
  assert.equal(newRealm.templateId, source.templateId, 'realm template id round-trips');

  const importedActive = runtime.listAgents().filter((agent) => agent.config?.realmId === newRealmId);
  const importedRecycled = runtime.listRecycledAgents().filter((agent) => agent.config?.realmId === newRealmId);
  assert.deepEqual(importedActive.map((agent) => agent.id).sort(), ['coordinator', 'rex-extra', 'worker'], 'active member ids round-trip');
  assert.deepEqual(importedRecycled.map((agent) => agent.id), ['rex-recycled'], 'the recycled member round-trips');

  const sourceActiveById = new Map(sourceEnvelope.members.active.map((member) => [member.id, member]));
  for (const member of importedActive) {
    const archived = sourceActiveById.get(member.id);
    assert.ok(archived, `archived member '${member.id}' exists`);
    assert.equal(member.config.name, archived.config.name, `member '${member.id}' name round-trips`);
    assert.equal(member.config.role, archived.config.role, `member '${member.id}' role round-trips`);
    assert.equal(member.config.systemPrompt, archived.config.systemPrompt, `member '${member.id}' prompt round-trips`);
    assert.equal(member.config.presetId, archived.config.presetId, `member '${member.id}' preset round-trips`);
    assert.deepEqual(
      member.history.map((message) => [message.id, message.role]),
      archived.history.map((message) => [message.id, message.role]),
      `member '${member.id}' history identity/order/roles round-trip`
    );
    assert.deepEqual(member.redoStack, archived.redoStack, `member '${member.id}' redo stack round-trips`);
    assert.deepEqual(member.telemetry, archived.telemetry, `member '${member.id}' telemetry round-trips`);
    assert.equal(member.turnCount, archived.turnCount, `member '${member.id}' turn count round-trips`);
    assert.deepEqual(member.lastInterruptedTurn, archived.lastInterruptedTurn, `member '${member.id}' interrupted turn round-trips`);
    assert.deepEqual(member.pendingPrecalls, archived.pendingPrecalls, `member '${member.id}' pending precalls round-trip`);
    assert.equal(member.lastSummary, archived.lastSummary, `member '${member.id}' summary round-trips`);
    // Tool selectors re-apply through the operator path (R5); only the
    // wildcard entry is deliberately not re-minted (see AC-REX-4).
    if (member.id !== 'rex-extra') {
      assert.deepEqual(
        member.config.allowedTools ? [...member.config.allowedTools] : [],
        archived.config.allowedTools ? [...archived.config.allowedTools] : [],
        `member '${member.id}' tool selectors re-apply`
      );
    }
  }

  // Attachments, template payload, saved payloads.
  assert.deepEqual((newRealm.extensions ?? []).map((attachment) => attachment.extensionId), ['rex-ext'], 'attachment round-trips');
  assert.equal(importedEnvelope.template.id, sourceEnvelope.template.id, 'template id round-trips');
  assert.equal(importedEnvelope.template.payload, sourceEnvelope.template.payload, 'template payload round-trips verbatim');
  assert.deepEqual(
    importedEnvelope.savedPayloads.map((entry) => [entry.name, entry.templateId, entry.templateVersion, entry.payload]),
    sourceEnvelope.savedPayloads.map((entry) => [entry.name, entry.templateId, entry.templateVersion, entry.payload]),
    'realm-scoped saved payload round-trips'
  );
  assert.equal(importedEnvelope.source.realmId, newRealmId, 'the re-export names the new realm as its source');
  assert.equal(
    JSON.parse(JSON.stringify(importedEnvelope)).members.active.every((member) => member.config.realmId === newRealmId),
    true,
    'every imported member carries the new realm membership'
  );
  const reExportJson = JSON.stringify(importedEnvelope);
  assert.equal(reExportJson.includes(source.id), false, 'the source realm id never appears in the imported archive');

  // Canonical keys remap under the new realm id.
  for (const partition of Object.keys(importedEnvelope.messaging.activeQueues)) {
    assert.equal(parseAgentIdentityKey(partition)?.realmId, newRealmId, `queue key '${partition}' is remapped`);
  }
  for (const partition of Object.keys(importedEnvelope.messaging.archives)) {
    assert.equal(parseAgentIdentityKey(partition)?.realmId, newRealmId, `archive key '${partition}' is remapped`);
  }
  for (const ref of importedEnvelope.messaging.registeredAgents) {
    assert.equal(parseAgentIdentityKey(ref)?.realmId, newRealmId, `registered ref '${ref}' is remapped`);
  }
  for (const ref of importedEnvelope.messaging.terminatedAgents) {
    assert.equal(parseAgentIdentityKey(ref)?.realmId, newRealmId, `terminated ref '${ref}' is remapped`);
  }
  for (const schedule of importedEnvelope.schedules) {
    assert.equal(parseAgentIdentityKey(schedule.agentRef)?.realmId, newRealmId, `schedule ref '${schedule.agentRef}' is remapped`);
  }
  for (const partition of [...Object.keys(importedEnvelope.worldClock.clocks), ...Object.keys(importedEnvelope.worldClock.events)]) {
    assert.equal(parseAgentIdentityKey(partition)?.realmId, newRealmId, `clock partition '${partition}' is remapped`);
  }

  // Mail bodies/audit round-trip with stable ids.
  const archivedIds = new Set(
    Object.values(importedEnvelope.messaging.activeQueues).flat().map((envelope) => envelope.id)
      .concat(Object.values(importedEnvelope.messaging.archives).flat().map((envelope) => envelope.id))
  );
  assert.equal(archivedIds.has(fixture.mailIds.A), true, 'unread mail round-trips');
  assert.equal(archivedIds.has(fixture.mailIds.B), true, 'archived mail round-trips');

  // VFS per-workspace equality (path/content/readOnly/owner; updatedAt excluded).
  assert.deepEqual(
    vfsProjection(importedEnvelope.vfs.realmGlobal),
    vfsProjection(sourceEnvelope.vfs.realmGlobal),
    'realm-global files round-trip'
  );
  assert.deepEqual(
    vfsProjection(importedEnvelope.vfs.members[createAgentIdentityKey(newRealmId, 'coordinator')]),
    vfsProjection(sourceEnvelope.vfs.members[keys.coordinatorKey]),
    'member workspace files round-trip'
  );
  assert.deepEqual(
    vfsProjection(importedEnvelope.vfs.members['rex-pinned-workspace']),
    vfsProjection(sourceEnvelope.vfs.members['rex-pinned-workspace']),
    'pinned workspace files round-trip verbatim'
  );
});

// ============================================================================
// AC-REX-2: redaction asserted from export bytes
// ============================================================================

test('AC-REX-2 redaction asserted from export bytes', async () => {
  const fixture = await getRichFixture();
  const { exportResult, foreign } = fixture;
  const json = exportResult.json;

  assert.equal(json.includes(SEEDED_VALUE_ALPHA), false, 'seeded secret values never leave');
  assert.equal(json.includes(SEEDED_VALUE_BETA), false, 'seeded KEK-shaped values never leave');
  assert.equal(json.includes('keyId'), false, 'model-config keyId is dropped');
  assert.equal(json.includes('credentialId'), false, 'extension install credential ids never leave');
  assert.equal(json.includes('approvedUrl'), false, 'extension install approval urls never leave');
  assert.equal(json.includes('transportHint'), false, 'extension install transport hints never leave');
  assert.equal(json.includes('providerUrl'), false, 'legacy provider url channels are stripped');
  assert.equal(json.includes('provider_url'), false, 'snake-case provider url channels are stripped');
  assert.equal(json.includes('@example.com'), false, 'credential-shaped endpoint URLs are dropped wholesale');
  assert.equal(json.includes('token='), false, 'credential-shaped query parameters never leave');
  assert.equal(json.includes(FOREIGN_MARKER), false, "the foreign realm's VFS/mail/clock bytes never leave");
  assert.equal(json.includes('Foreign Day'), false, "the foreign realm's clock partitions never leave");
  assert.equal(json.includes(foreign.id), false, 'the foreign realm id never appears');
  assert.equal(json.includes('agentDraftInputs'), false, 'session draft metadata never leaves');
  assert.equal(json.includes('activeAgentId'), false, 'session selection metadata never leaves');
  assert.equal(json.includes('activeTab'), false, 'session tab metadata never leaves');
  assert.equal(json.includes('activePresetId'), false, 'session preset metadata never leaves');
  assert.equal(json.includes('customPresets'), false, 'session custom presets never leave');
  assert.equal(fixture.envelope.vfs.realmGlobal['/foreign/realm.md'], undefined, 'no foreign file enters the archive');

  // Recursive key walk: no credential-shaped keys anywhere in the envelope.
  const credentialKeys = ['apiKey', 'api_key', 'token', 'password', 'secret', 'kek', 'encryptionKey', 'authorization'];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(credentialKeys.includes(key), false, `credential-shaped key '${key}' is absent`);
      walk(child);
    }
  };
  walk(JSON.parse(json));
});

// ============================================================================
// AC-REX-3: slice completeness
// ============================================================================

test('AC-REX-3 slice completeness', async () => {
  const fixture = await getRichFixture();
  const { harness, source, keys, envelope } = fixture;
  const { runtime, messagingBus, worldClock } = harness;

  // Live pre-export counts (captured after the fixture settled).
  const liveActive = runtime.listAgents().filter((agent) => agent.config?.realmId === source.id);
  const liveRecycled = runtime.listRecycledAgents().filter((agent) => agent.config?.realmId === source.id);
  const liveSchedules = runtime.exportSchedules().filter((schedule) => parseAgentIdentityKey(schedule.agentRef)?.realmId === source.id);
  const bus = messagingBus.exportSnapshot();
  const liveClock = worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() });

  assert.equal(envelope.members.active.length, liveActive.length, 'active member count equals the live roster');
  assert.equal(envelope.members.recycled.length, liveRecycled.length, 'recycled member count equals the live recycle bin');
  assert.equal(envelope.members.active.length, 3, 'three active members are exported');
  assert.equal(envelope.members.recycled.length, 1, 'the recycled member is exported');
  assert.equal(envelope.schedules.length, liveSchedules.length, 'schedule count equals the live per-realm count');
  assert.equal(envelope.schedules.length, 2, 'only the source realm schedules are exported');
  assert.equal(
    countRealmKeys(Object.keys(bus.activeQueues), source.id),
    Object.keys(envelope.messaging.activeQueues).length,
    'active queue partitions are complete'
  );
  assert.equal(
    countRealmKeys(Object.keys(bus.archives), source.id),
    Object.keys(envelope.messaging.archives).length,
    'archive partitions are complete'
  );
  assert.equal(envelope.messaging.terminatedAgents.includes(keys.recycledKey), true, 'terminated agents include the recycled member');
  assert.ok(envelope.messaging.registeredAgents.includes(keys.coordinatorKey), 'registered agents include active members');
  assert.ok(envelope.messaging.auditLog.length >= 2, 'the audit log carries the realm mail trail');
  assert.equal(
    envelope.messaging.auditLog.every((entry) => typeof entry.from === 'string' && typeof entry.to === 'string'),
    true,
    'audit entries stay verbatim'
  );

  // Clock partitions: member + realm-global, with events; foreign excluded.
  const liveClockKeys = Object.keys(liveClock.agentClocks ?? {}).filter((key) => countRealmKeys([key], source.id) === 1);
  const liveEventKeys = Object.keys(liveClock.agentEvents ?? {}).filter((key) => countRealmKeys([key], source.id) === 1);
  assert.deepEqual(Object.keys(envelope.worldClock.clocks).sort(), liveClockKeys.sort(), 'clock partitions are complete');
  assert.deepEqual(Object.keys(envelope.worldClock.events).sort(), liveEventKeys.sort(), 'event partitions are complete');
  assert.equal(envelope.worldClock.global.date, 'Day 9', 'the realm-global clock snapshot is carried');
  assert.equal(Object.keys(envelope.worldClock.events).includes(realmGlobalKey(source.id)), true, 'realm-global events are carried');
  assert.equal(
    [...Object.keys(envelope.worldClock.clocks), ...Object.keys(envelope.worldClock.events)]
      .every((key) => key === realmGlobalKey(source.id) || parseAgentIdentityKey(key)?.realmId === source.id),
    true,
    'every clock key belongs to the source realm family'
  );

  // VFS: realm-global + member + pinned; foreign excluded.
  assert.equal(Object.keys(envelope.vfs.realmGlobal).length, 1, 'the realm-global container is complete');
  assert.equal(Object.keys(envelope.vfs.members).length, 2, 'member + pinned workspaces are complete');
  assert.equal(Object.keys(envelope.vfs.members).includes('rex-pinned-workspace'), true, 'the pinned workspace is included verbatim');
  assert.equal(Object.keys(envelope.vfs.members).some((key) => key.includes('foreign')), false, 'foreign workspaces are excluded');

  // Attachments, template, payloads, descriptive authority.
  assert.equal((envelope.realm.extensions ?? []).length, 1, 'the realm attachment is exported');
  assert.equal(envelope.template.id, 'demo', 'the launch template is exported');
  assert.equal(envelope.savedPayloads.length, 1, 'only realm-scoped saved payloads are exported');
  assert.equal(envelope.authority.hostGrants.length, 3, 'realmBypass + template + hydration grants are exported');
  assert.equal(Object.keys(envelope.authority.members).length, 3, 'every active member carries a descriptor projection');
  assert.equal(envelope.authority.members['rex-extra'].realmBypass, true, 'the realmBypass grant is exported descriptively');
  assert.equal(envelope.authority.members.coordinator.privileged, true, 'the privileged projection is exported descriptively');
  assert.equal(envelope.authority.members['rex-extra'].allow.includes('*'), true, 'the wildcard allow set is exported descriptively');
});

// ============================================================================
// AC-REX-4: import default-deny (no authority minting)
// ============================================================================

test('AC-REX-4 import default-deny (no authority minting)', async () => {
  const { fixture, receipt, newRealmId } = await getRichImport();
  const { envelope } = fixture;
  const { runtime } = fixture.harness;

  assert.equal(envelope.authority.members['rex-extra'].realmBypass, true, 'the archive carries a realmBypass projection');
  assert.equal(envelope.authority.members['rex-extra'].allow.includes('*'), true, 'the archive carries a wildcard allow set');
  assert.equal(
    envelope.authority.hostGrants.some((grant) => grant.authorityId === AGENT_AUTHORITIES.TEMPLATE),
    true,
    'the archive carries a template grant'
  );
  assert.equal(
    envelope.authority.hostGrants.some((grant) => grant.authorityId === AGENT_AUTHORITIES.HYDRATION),
    true,
    'the archive carries a hydration grant'
  );

  for (const member of envelope.members.active) {
    const projection = runtime.getAgentIdentity(member.id, { realmId: newRealmId });
    assert.ok(projection, `imported member '${member.id}' resolves`);
    assert.equal(projection.privileged, false, `member '${member.id}' imports unprivileged`);
    assert.equal(projection.realmBypass, false, `member '${member.id}' imports without realmBypass`);
    assert.ok(projection.authority, `member '${member.id}' has a descriptor`);
    assert.equal(projection.authority.realmBypass, false, `member '${member.id}' descriptor denies realmBypass`);
    assert.equal(projection.authority.allow.has('*'), false, `member '${member.id}' descriptor denies the wildcard`);
    assert.equal(projection.authority.allow.has(AGENT_AUTHORITIES.TEMPLATE), false, `member '${member.id}' descriptor denies template authority`);
    assert.equal(projection.authority.allow.has(AGENT_AUTHORITIES.HYDRATION), false, `member '${member.id}' descriptor denies hydration authority`);
  }

  const droppedByMember = new Map(receipt.droppedAuthority.map((entry) => [entry.memberId, entry.authorities]));
  assert.ok(droppedByMember.get('coordinator')?.includes('privileged'), 'the privileged drop is receipted');
  assert.ok(droppedByMember.get('coordinator')?.includes(AGENT_AUTHORITIES.TEMPLATE), 'the template grant drop is receipted');
  assert.ok(droppedByMember.get('worker')?.includes(AGENT_AUTHORITIES.HYDRATION), 'the hydration grant drop is receipted');
  assert.ok(droppedByMember.get('rex-extra')?.includes('*'), 'the wildcard drop is receipted');
  assert.ok(droppedByMember.get('rex-extra')?.includes('realmBypass'), 'the realmBypass drop is receipted');

  // Tool selectors re-apply only through the operator path (R5): concrete
  // selectors land, the wildcard entry is not re-minted.
  const importedCoordinator = runtime.getAgent(createAgentIdentityKey(newRealmId, 'coordinator'));
  const archivedCoordinator = envelope.members.active.find((member) => member.id === 'coordinator');
  assert.deepEqual(
    importedCoordinator.config.allowedTools ? [...importedCoordinator.config.allowedTools] : [],
    archivedCoordinator.config.allowedTools ? [...archivedCoordinator.config.allowedTools] : [],
    'concrete tool selectors re-apply'
  );
  const importedExtra = runtime.getAgent(createAgentIdentityKey(newRealmId, 'rex-extra'));
  assert.equal(
    Array.isArray(importedExtra.config.allowedTools) && importedExtra.config.allowedTools.includes('*'),
    false,
    'the wildcard selector is not re-minted'
  );
  assert.equal(
    receipt.warnings.some((warning) => warning.toLowerCase().includes('wildcard')),
    true,
    'the wildcard drop is disclosed'
  );
});

// ============================================================================
// AC-REX-5: collision, rollback, and failure atomicity
// ============================================================================

test('AC-REX-5a pinned-workspace collision rejects with zero mutation', async () => {
  const { fixture } = await getRichImport();
  const { harness, exportResult } = fixture;
  const { store, runtime, messagingBus, worldClock } = harness;
  const realmsBefore = store.realms.length;
  const membersBefore = runtime.listAgents().length;
  const busBefore = JSON.stringify(messagingBus.exportSnapshot());
  const clockBefore = JSON.stringify(worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() }));

  const err = captureThrow(() => store.importRealmArchive(exportResult.json));
  assert.ok(err, 'the colliding import rejects');
  assert.equal(err.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_IMPORT_FAILED, 'the collision reports a typed import failure');
  assert.equal(err.report.failedStage, 'vfs-preflight', 'the report names the preflight stage');
  assert.equal(store.realms.length, realmsBefore, 'no realm record is created');
  assert.equal(runtime.listAgents().length, membersBefore, 'no member is installed');
  assert.equal(JSON.stringify(messagingBus.exportSnapshot()), busBefore, 'the bus is unchanged');
  assert.equal(
    JSON.stringify(worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() })),
    clockBefore,
    'the clock is unchanged'
  );
});

test('AC-REX-5b injected VFS write failure rolls back record and files', async () => {
  const { harness, exportResult, source } = await buildMinimalFixture();
  const { store, runtime, virtualFs, messagingBus, worldClock } = harness;
  const realmsBefore = store.realms.length;
  const memberRealmIdsBefore = new Set(runtime.listAgents().map((agent) => agent.config?.realmId ?? null));
  const busBefore = JSON.stringify(messagingBus.exportSnapshot());
  const clockBefore = JSON.stringify(worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() }));

  const realWriteFile = virtualFs.writeFile.bind(virtualFs);
  virtualFs.writeFile = (params, ...rest) => {
    if (params && typeof params === 'object' && String(params.filePath ?? '').includes('/minimal/note.md')) {
      throw new Error('injected VFS write failure');
    }
    return realWriteFile(params, ...rest);
  };
  try {
    const err = captureThrow(() => store.importRealmArchive(exportResult.json));
    assert.ok(err, 'the injected write failure aborts the import');
    assert.equal(err.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_IMPORT_FAILED, 'the failure is typed');
    assert.equal(err.report.rolledBack, true, 'the report says the import rolled back');
  } finally {
    virtualFs.writeFile = realWriteFile;
  }
  assert.equal(store.realms.length, realmsBefore, 'the realm record was rolled back');
  assert.equal(
    runtime.listAgents().every((agent) => memberRealmIdsBefore.has(agent.config?.realmId ?? null)),
    true,
    'no imported member survives'
  );
  assert.equal(JSON.stringify(messagingBus.exportSnapshot()), busBefore, 'the bus is unchanged');
  assert.equal(
    JSON.stringify(worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() })),
    clockBefore,
    'the clock is unchanged'
  );
});

test('AC-REX-5c injected runtime slice failure restores pre-state', async () => {
  const { harness, exportResult } = await buildMinimalFixture();
  const { store, runtime, messagingBus, worldClock } = harness;
  const realmsBefore = store.realms.length;
  const agentsBefore = runtime.listAgents().length;
  const busBefore = JSON.stringify(messagingBus.exportSnapshot());
  const clockBefore = JSON.stringify(worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() }));
  const schedulesBefore = JSON.stringify(runtime.exportSchedules());

  const realImportSnapshot = messagingBus.importSnapshot.bind(messagingBus);
  let thrown = false;
  messagingBus.importSnapshot = (snapshot, ...rest) => {
    if (!thrown) {
      thrown = true;
      throw new Error('injected runtime slice failure');
    }
    return realImportSnapshot(snapshot, ...rest);
  };
  try {
    const err = captureThrow(() => store.importRealmArchive(exportResult.json));
    assert.ok(err, 'the injected slice failure aborts the import');
    assert.equal(err.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_IMPORT_FAILED, 'the failure is typed');
    assert.equal(err.report.rolledBack, true, 'the report says the import rolled back');
  } finally {
    messagingBus.importSnapshot = realImportSnapshot;
  }
  assert.equal(store.realms.length, realmsBefore, 'the realm record was rolled back');
  assert.equal(runtime.listAgents().length, agentsBefore, 'no imported member survives');
  assert.equal(JSON.stringify(runtime.exportSchedules()), schedulesBefore, 'schedules are restored');
  assert.equal(JSON.stringify(messagingBus.exportSnapshot()), busBefore, 'the bus is restored');
  assert.equal(
    JSON.stringify(worldClock.exportSnapshot({ principal: runtime.getOperatorPrincipal() })),
    clockBefore,
    'the clock is restored'
  );
});

test('AC-REX-5d re-import creates an independent realm (no id reuse)', async () => {
  const { harness, exportResult } = await buildMinimalFixture();
  const { store } = harness;
  const first = store.importRealmArchive(exportResult.json);
  const second = store.importRealmArchive(exportResult.json);
  assert.notEqual(first.realmId, second.realmId, 'each import mints its own realm');
  assert.ok(store.getRealm(first.realmId) && store.getRealm(second.realmId), 'both realms stay live');
  assert.ok(store.realms.filter((realm) => realm.templateId === 'demo').length >= 3, 'no import replaces a prior one');
});

// ============================================================================
// AC-REX-6: receipts + operator re-grant path
// ============================================================================

test('AC-REX-6 receipts + operator re-grant path', async () => {
  const { receipt, newRealmId } = await getRichImport();
  const { store } = (await getRichFixture()).harness;

  assert.equal(typeof receipt.success, 'boolean', 'receipt carries success');
  assert.equal(typeof receipt.realmId, 'string', 'receipt carries the new realm id');
  assert.equal(typeof receipt.realmName, 'string', 'receipt carries the realm name');
  assert.equal(typeof receipt.archiveId, 'string', 'receipt carries the archive id');
  assert.equal(Number.isInteger(receipt.membersImported), true, 'receipt carries membersImported');
  assert.equal(Number.isInteger(receipt.membersRecycled), true, 'receipt carries membersRecycled');
  assert.equal(Number.isInteger(receipt.filesImported), true, 'receipt carries filesImported');
  assert.equal(Number.isInteger(receipt.schedulesImported), true, 'receipt carries schedulesImported');
  assert.equal(receipt.attachmentsImported, 1, 'receipt counts the imported attachment');
  assert.equal(receipt.attachmentsSkipped, 0, 'no attachment is skipped when it resolves locally');
  assert.equal(receipt.templateImported, false, 'a locally known template is skipped and disclosed');
  assert.equal(receipt.payloadsImported, 1, 'receipt counts the imported saved payload');
  assert.ok(Array.isArray(receipt.droppedAuthority), 'receipt carries droppedAuthority');
  assert.ok(Array.isArray(receipt.warnings), 'receipt carries warnings');

  const granted = await store.grantRealmBypass('coordinator', { realmId: newRealmId });
  assert.ok(granted, 'an imported member resolves for an operator grant');
  assert.equal(granted.realmBypass, true, 'the operator re-grant mints realmBypass through the ordinary API');
  const revoked = await store.revokeRealmBypass('coordinator', { realmId: newRealmId });
  assert.equal(revoked.realmBypass, false, 'the operator can revoke what it granted');
});

// ============================================================================
// Export failure surface: unknown realm / malformed archive
// ============================================================================

test('export/import validation surfaces are typed and fail closed', async () => {
  const store = createStore();
  try {
    const missing = store.exportRealmArchive('realm_does_not_exist');
    assert.equal(missing.success, false, 'unknown realms fail closed');
    assert.equal(missing.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_NOT_FOUND, 'unknown realm reports NOT_FOUND');

    const malformed = captureThrow(() => store.importRealmArchive('{"format":"nope"}'));
    assert.ok(malformed, 'unknown archive formats reject');
    assert.equal(malformed.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS, 'malformed archives are an invalid-params failure');

    const unparseable = captureThrow(() => store.importRealmArchive('not json'));
    assert.ok(unparseable, 'unparseable archives reject');
    assert.equal(unparseable.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS, 'unparseable archives are an invalid-params failure');

    const polluted = captureThrow(
      () => store.importRealmArchive('{"format":"ai-story.realm-archive","formatVersion":1,"__proto__":{"polluted":true}}')
    );
    assert.ok(polluted, 'prototype-polluted archives reject');
  } finally {
    store.destroy();
  }
});
