/**
 * @file tests/integration/template_baked_history_test.js
 * @description Wave T lane T-E (ticket df3aac7) acceptance: baked roleplay
 *   history (Realm Template Format v1 §3.5/§5) end-to-end through the real
 *   `SandboxStore` + `realmCatalog` + `AgentRuntime` composition root.
 *
 *   Asserted contract:
 *   1. a realm launched from a history-bearing template carries the composed
 *      prologue `[system, ...declared]` before any turn: the generated opener
 *      composes through the same part model as prompts, the declared entries
 *      carry `metadata.source: 'template'`, and the system entry stays bare;
 *   2. seeding the prologue runs no model call: the member stays `idle` with
 *      `turnCount === 0`, no error, and the runtime's aggregate turn counter is
 *      zero (the fixture declares no `initialPrompt` and no seed directive);
 *   3. message ids are launch-generated (INV-7: `sys_…`/`assistant_…`/`user_…`
 *      UUIDs) and survive a runtime `exportSnapshot` → `importSnapshot`
 *      round-trip byte-identically;
 *   4. the same ids survive a full store persistence round-trip
 *      (`saveToStorage` → fresh store `autoHydrate`) together with the realm
 *      record — INV-7 across serialization cycles.
 *
 * Zero-Mock Verification: every engine class (runtime, store, VirtualFS,
 * messaging bus, realm registry, preset catalog) is the real production class;
 * the runtime snapshot chain runs through the real `restoreRuntimeEnvironment`
 * hydration path.
 *
 * Standalone: `timeout 180 node tests/integration/template_baked_history_test.js`
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { templateBundleVersion } from '../../src/lib/sandbox/realmCatalog/index.ts';

/** Baked-history fixture template id. */
const ROLEPLAY_ID = 'te-roleplay';

/** Fixture bundle files resolved by the system prompt and the history opener. */
const ROLEPLAY_FILES = Object.freeze({
  'prompts/gm.md': 'GM protocol.',
  'history/opener.md': 'The gate groans open.'
});

/** Roleplay fixture: system prompt parts plus a two-entry baked prologue. */
const ROLEPLAY_TEMPLATE = Object.freeze({
  formatVersion: 1,
  id: ROLEPLAY_ID,
  name: 'Roleplay Fixture',
  description: 'Baked prologue fixture.',
  inputs: [{ id: 'opening_scene', label: 'Opening scene', origin: 'generated', brief: 'One generated opener.' }],
  agents: [{
    key: 'gm',
    idPattern: 'te-roleplay-gm',
    name: 'Game Master',
    role: 'gm',
    prompt: [
      { kind: 'file', path: 'prompts/gm.md' },
      { kind: 'text', text: 'You are the game master.' }
    ],
    toolProfile: { tools: [] },
    privileged: false,
    history: [
      {
        role: 'assistant',
        content: [
          { kind: 'file', path: 'history/opener.md' },
          { kind: 'input', inputId: 'opening_scene' }
        ]
      },
      { role: 'user', content: [{ kind: 'text', text: 'I step through the gate.' }] }
    ]
  }]
});

/** The fixture as a canonical transport payload. */
const ROLEPLAY_TRANSPORT = Object.freeze({
  formatVersion: 1,
  template: ROLEPLAY_TEMPLATE,
  files: ROLEPLAY_FILES
});

/** Effective fixture bundle version. */
const ROLEPLAY_VERSION = templateBundleVersion({ template: ROLEPLAY_TEMPLATE, files: ROLEPLAY_FILES });

/** Generated opener value. */
const OPENING_SCENE = 'A rain-soaked quay at dusk.';

/** Expected composed prologue content. */
const EXPECTED_OPENER = `The gate groans open.\n\n${OPENING_SCENE}`;

/**
 * Builds the hydration package for the fixture.
 *
 * @returns {object} Package object.
 */
function createRoleplayPackage() {
  return {
    formatVersion: 1,
    templateId: ROLEPLAY_ID,
    templateVersion: ROLEPLAY_VERSION,
    inputs: { opening_scene: OPENING_SCENE },
    files: []
  };
}

/**
 * Builds a real runtime plus a store wired to that runtime's own substrates.
 *
 * @param {{ autoHydrate?: boolean }} [options] - Auto-hydration flag.
 * @returns {{ runtime: object, store: object }} The fixture pair.
 */
function createSharedSubstrateStore({ autoHydrate = false } = {}) {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    autoBootstrapDirector: false,
    autoHydrate
  });
  return { runtime, store };
}

/**
 * Launches the roleplay fixture once and returns both store and runtime views.
 *
 * @returns {Promise<object>} Live fixture.
 */
async function launchRoleplayFixture() {
  const { runtime, store } = createSharedSubstrateStore();
  store.importRealmTemplate(ROLEPLAY_TRANSPORT);
  const receipt = await store.launchRealmFromTemplate(ROLEPLAY_ID, {
    name: 'Roleplay Realm',
    package: createRoleplayPackage()
  });
  const member = store.agents.find((agent) => agent.id === 'te-roleplay-gm');
  assert.ok(member, 'fixture: the gm member launched');
  const live = runtime.getAgent('te-roleplay-gm');
  assert.ok(live, 'fixture: the runtime resolves the launched member');
  return { runtime, store, receipt, member, live };
}

/**
 * Projects a history array into comparable `{ id, role, content, metadata }`
 * records.
 *
 * @param {ReadonlyArray<object>} history - Agent history.
 * @returns {Array<object>} Projection.
 */
function projectHistory(history) {
  return history.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    metadata: message.metadata ?? null
  }));
}

// ============================================================================
// 1. The prologue is present before any turn and no model call runs
// ============================================================================

test('1. a history-bearing realm launches with [system, ...declared] before any turn and runs no model call', async () => {
  const fixture = await launchRoleplayFixture();
  const { runtime, member, live } = fixture;
  try {
    // The launched member's system prompt composes from the declared parts.
    assert.equal(member.config.systemPrompt, 'GM protocol.\n\nYou are the game master.');

    // `[system, ...declared]` in declared order.
    assert.deepEqual(
      member.history.map((message) => message.role),
      ['system', 'assistant', 'user'],
      'the prologue is system first, then the declared entries in order'
    );
    assert.equal(member.history[0].content, member.config.systemPrompt, 'the system entry is the composed prompt');
    assert.equal(member.history[0].metadata, undefined, 'the system entry carries no template metadata');
    assert.equal(
      member.history[1].content,
      EXPECTED_OPENER,
      'the assistant opener composes the bundle file and the generated input in declared order'
    );
    assert.deepEqual(member.history[1].metadata, { source: 'template' }, 'the opener is marked host-side');
    assert.equal(member.history[2].content, 'I step through the gate.');
    assert.deepEqual(member.history[2].metadata, { source: 'template' }, 'every declared entry is marked host-side');

    // The runtime entity carries the same prologue (the store projection is
    // not a local fabrication).
    assert.deepEqual(projectHistory(live.history), projectHistory(member.history));

    // No model call: the fixture declares no initialPrompt and no directive, so
    // the member stays idle with zero turns, zero tokens, and no error.
    assert.equal(member.state, 'idle', 'the member is idle after launch');
    assert.equal(member.turnCount, 0, 'no turn ran');
    assert.equal(member.lastError, null, 'no turn failure was recorded');
    assert.equal(member.telemetry.totalTokens, 0, 'no tokens were consumed');
    const metrics = runtime.getRuntimeMetrics();
    assert.equal(metrics.totalTurnsExecuted, 0, 'the runtime executed no turn');
    assert.equal(metrics.totalTokensConsumed, 0, 'the runtime consumed no tokens');
    assert.equal(metrics.activeTimersCount, 0, 'no wake timer was scheduled');

    // Generated ids: one per message, typed prefixes, all distinct (INV-7).
    const ids = member.history.map((message) => message.id);
    assert.match(ids[0], /^sys_[0-9a-f-]{36}$/, 'the system id is launch-generated');
    assert.match(ids[1], /^assistant_[0-9a-f-]{36}$/, 'the assistant opener id is launch-generated');
    assert.match(ids[2], /^user_[0-9a-f-]{36}$/, 'the user entry id is launch-generated');
    assert.equal(new Set(ids).size, ids.length, 'every message id is unique');

    assert.equal(fixture.receipt.realm.instance.templateVersion, ROLEPLAY_VERSION);
  } finally {
    fixture.store.destroy();
    fixture.runtime.destroy();
  }
});

// ============================================================================
// 2. Message ids survive a runtime export/import snapshot round-trip
// ============================================================================

test('2. message ids survive the runtime exportSnapshot → importSnapshot round-trip byte-identically', async () => {
  const fixture = await launchRoleplayFixture();
  const { runtime } = fixture;
  let restored = null;
  try {
    const before = projectHistory(fixture.member.history);
    const snapshot = JSON.parse(JSON.stringify(runtime.exportSnapshot()));
    assert.deepEqual(
      projectHistory(snapshot.agents.find((agent) => agent.id === 'te-roleplay-gm').history),
      before,
      'the exported snapshot carries the same ids and contents'
    );

    restored = new AgentRuntime({ autoBootstrapDirector: false });
    restored.importSnapshot(snapshot);
    const hydrated = restored.getAgent('te-roleplay-gm');
    assert.ok(hydrated, 'the member hydrates into the fresh runtime');
    assert.deepEqual(projectHistory(hydrated.history), before, 'the imported history is byte-identical (ids included)');
    assert.equal(restored.getRuntimeMetrics().totalTurnsExecuted, 0, 'importing a prologue runs no turn');

    const reExported = JSON.parse(JSON.stringify(restored.exportSnapshot()));
    assert.deepEqual(
      projectHistory(reExported.agents.find((agent) => agent.id === 'te-roleplay-gm').history),
      before,
      'a re-export keeps the ids stable (serialization cycles are lossless)'
    );
  } finally {
    if (restored) restored.destroy();
    fixture.store.destroy();
    fixture.runtime.destroy();
  }
});

// ============================================================================
// 3. Message ids survive a full store persistence round-trip
// ============================================================================

test('3. message ids and the realm record survive the store persistence round-trip', async () => {
  sharedLocalStorage.clear();
  let first = null;
  let reloaded = null;
  try {
    first = await launchRoleplayFixture();
    const before = projectHistory(first.member.history);
    const realmId = first.receipt.realm.id;
    assert.equal(first.store.saveToStorage(), true, 'the fixture session persists');
    first.store.destroy();
    first.runtime.destroy();
    first = null;

    reloaded = createSharedSubstrateStore({ autoHydrate: true });
    assert.ok(reloaded.store.getRealm(realmId), 'the realm record hydrates');
    const hydrated = reloaded.store.agents.find((agent) => agent.id === 'te-roleplay-gm');
    assert.ok(hydrated, 'the member hydrates from the snapshot');
    assert.deepEqual(projectHistory(hydrated.history), before, 'ids, roles, contents, and metadata survive persistence');
    assert.equal(reloaded.store.getRealm(realmId).instance.templateVersion, ROLEPLAY_VERSION, 'provenance survives');
    assert.equal(reloaded.runtime.getRuntimeMetrics().totalTurnsExecuted, 0, 'hydration runs no turn');
  } finally {
    if (first) {
      first.store.destroy();
      first.runtime.destroy();
    }
    if (reloaded) {
      reloaded.store.destroy();
      reloaded.runtime.destroy();
    }
    sharedLocalStorage.clear();
  }
});
