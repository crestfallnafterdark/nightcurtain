/**
 * @file tests/integration/template_persistence_roundtrip_test.js
 * @description Wave T lane T-E (ticket df3aac7) acceptance: runtime-imported
 *   templates, hydration-launched realms, and instance provenance survive the
 *   real store persistence round-trip (`saveToStorage` → fresh store
 *   `autoHydrate`), and registry caps/quota failures surface typed and roll
 *   back across that boundary.
 *
 *   Asserted contract:
 *   1. an imported bundle persists and hydrates back into a fresh store: the
 *      effective export stays canonical and byte-identical, the source label
 *      stays `imported`, the import budget is recomputed, and bundle files
 *      survive;
 *   2. the launched realm's instance provenance (template id, pinned version,
 *      package digest, input hashes, seed paths, launch timestamp) survives
 *      byte-for-byte, and the seeded files and member history hydrate with it;
 *   3. a relaunch from the hydrated import resolves the same content version,
 *      launches the same literal member id realm-locally into a new realm, and
 *      keeps both realms' seeded files isolated;
 *   4. the per-bundle byte cap fails typed (`ERR_STORE_TEMPLATE_TOO_LARGE`)
 *      without applying anything, and a quota-failed import/delete rolls back
 *      and surfaces the typed `ERR_STORE_TEMPLATE_PERSIST_FAILED`, with the
 *      persisted snapshot still agreeing with the effective catalog after a
 *      fresh hydration.
 *
 * Zero-Mock Verification: every engine class (runtime, store, VirtualFS,
 * messaging bus, realm registry, preset catalog, persistence module) is the
 * real production class; the persistence chain runs through the real
 * `saveSandboxState`/`restoreRuntimeEnvironment` path with the shared
 * LocalStorage emulation.
 *
 * Standalone: `timeout 180 node tests/integration/template_persistence_roundtrip_test.js`
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import {
  REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES,
  SANDBOX_STORE_ERROR_CODES,
  SandboxStore
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import {
  payloadDigest,
  templateBundleVersion
} from '../../src/lib/sandbox/realmCatalog/index.ts';

/** Persistence fixture template id. */
const PERSIST_ID = 'te-persist';

/** Fixture bundle files resolved by the prompt part. */
const PERSIST_FILES = Object.freeze({
  'prompts/keeper.md': 'Keeper protocol.'
});

/** Fixture template: generated + user inputs, generated/user seed slots. */
const PERSIST_TEMPLATE = Object.freeze({
  formatVersion: 1,
  id: PERSIST_ID,
  name: 'Persistence Fixture',
  description: 'Persistence round-trip fixture.',
  inputs: [
    { id: 'premise', label: 'Premise', origin: 'generated', brief: 'One generated premise.' },
    { id: 'tone', label: 'Tone', default: 'neutral' }
  ],
  agents: [{
    key: 'keeper',
    idPattern: 'te-persist-keeper',
    name: 'Keeper',
    role: 'keeper',
    prompt: [
      { kind: 'file', path: 'prompts/keeper.md' },
      { kind: 'input', inputId: 'premise' },
      // Format-v2 totality: every declared input must be consumed, so the
      // optional tone input is referenced as a prompt part.
      { kind: 'input', inputId: 'tone' }
    ],
    toolProfile: { tools: [] },
    privileged: false
  }],
  seed: {
    files: [
      { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'Generated world lore.' },
      { path: 'notes/keeper.md', target: { agent: 'keeper' }, origin: 'user', brief: 'Operator notes.' }
    ]
  }
});

/** The fixture as a canonical transport payload. */
const PERSIST_TRANSPORT = Object.freeze({
  formatVersion: 1,
  template: PERSIST_TEMPLATE,
  files: PERSIST_FILES
});

/** Effective fixture bundle version. */
const PERSIST_VERSION = templateBundleVersion({ template: PERSIST_TEMPLATE, files: PERSIST_FILES });

/**
 * Builds a hydration package for the persistence fixture.
 *
 * @param {string} premise - Generated premise value.
 * @returns {object} Package object.
 */
function createPersistPackage(premise) {
  return {
    formatVersion: 1,
    templateId: PERSIST_ID,
    templateVersion: PERSIST_VERSION,
    inputs: { premise, tone: 'package tone' },
    files: [
      { path: 'lore/world.md', target: 'realm', content: `World lore for ${premise}` },
      { path: 'notes/keeper.md', target: { agent: 'keeper' }, content: `Notes for ${premise}` }
    ]
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
 * Builds a shadow fixture for the shipped demo id (used by the quota case to
 * observe whether a failed mutation leaked into the effective catalog).
 *
 * @returns {object} Transport payload.
 */
function createShadowDemoPayload() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'demo',
      name: 'Persistence Shadow Demo',
      description: 'Quota probe shadowing the shipped demo.',
      agents: [{
        key: 'shadow',
        idPattern: 'te-persist-shadow',
        name: 'Shadow',
        role: 'worker',
        prompt: [{ kind: 'text', text: 'Shadow.' }],
        toolProfile: { tools: [] },
        privileged: false
      }]
    },
    files: {}
  };
}

/**
 * Asserts a synchronous call throws a coded error.
 *
 * @param {Function} fn - Call under test.
 * @param {string} code - Expected `err.code`.
 * @param {RegExp} messagePattern - Expected message pattern.
 * @returns {Error} The thrown error.
 */
function expectThrow(fn, code, messagePattern) {
  let err = null;
  try {
    fn();
  } catch (thrown) {
    err = thrown;
  }
  assert.ok(err, `expected a '${code}' error`);
  assert.equal(err.code, code, `expected code '${code}', got '${err.code}': ${err.message}`);
  assert.match(err.message, messagePattern);
  return err;
}

// ============================================================================
// 1. Import + package launch + provenance persist and hydrate back
// ============================================================================

test('1. an imported bundle, its package-launched realm, and provenance survive a fresh-store hydration', async () => {
  sharedLocalStorage.clear();
  let first = null;
  let reloaded = null;
  try {
    first = createSharedSubstrateStore();
    first.store.importRealmTemplate(PERSIST_TRANSPORT);
    const canonicalExport = first.store.exportRealmTemplate(PERSIST_ID);
    const receipt = await first.store.launchRealmFromTemplate(PERSIST_ID, {
      name: 'Persisted Realm',
      package: createPersistPackage('the salt flats'),
      inputValues: { tone: 'launch tone' }
    });
    const realmId = receipt.realm.id;
    const instance = receipt.realm.instance;
    const member = first.store.agents.find((agent) => agent.id === 'te-persist-keeper');
    const historyIds = member.history.map((message) => message.id);
    const persistedOk = first.store.saveToStorage();
    assert.equal(persistedOk, true, 'the fixture session persists');
    first.store.destroy();
    first.runtime.destroy();
    first = null;

    reloaded = createSharedSubstrateStore({ autoHydrate: true });

    // Import topology: one effective imported entry, canonical payload, frozen bundle.
    const hydratedBundle = reloaded.store.getRealmTemplateBundle(PERSIST_ID);
    assert.ok(hydratedBundle, 'the imported bundle hydrates');
    assert.deepEqual(hydratedBundle.files, PERSIST_FILES, 'bundle files survive hydration');
    assert.equal(reloaded.store.exportRealmTemplate(PERSIST_ID), canonicalExport, 'the export stays canonical');
    assert.deepEqual(reloaded.store.getRealmTemplateSource(PERSIST_ID), {
      templateId: PERSIST_ID,
      source: 'imported',
      replacesShipped: false,
      templateVersion: PERSIST_VERSION
    });
    assert.equal(
      reloaded.store.listRealmTemplateSources().filter((entry) => entry.templateId === PERSIST_ID).length,
      1,
      'exactly one effective import remains after hydration'
    );
    assert.equal(
      JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1')).importedRealmTemplates.length,
      1,
      'the persisted snapshot carries the accepted import'
    );

    // Provenance survives byte-for-byte; the realm and its seeded files hydrate.
    const hydratedRealm = reloaded.store.getRealm(realmId);
    assert.ok(hydratedRealm, 'the realm record hydrates');
    assert.deepEqual(hydratedRealm.instance, instance, 'instance provenance round-trips byte-for-byte');
    assert.ok(Object.isFrozen(hydratedRealm.instance), 'hydrated provenance is frozen');
    assert.equal(instance.templateVersion, PERSIST_VERSION, 'the provenance pins the fixture version');
    assert.ok(instance.packageDigest.startsWith('sha256:'), 'the package digest is recorded');
    assert.equal(
      instance.inputHashes.premise,
      payloadDigest({ shape: 'text', text: 'the salt flats' }),
      'the generated premise hash covers the canonical tagged value'
    );
    assert.equal(
      instance.inputHashes.tone,
      payloadDigest({ shape: 'text', text: 'launch tone' }),
      'the explicit launch value won the merge'
    );
    assert.deepEqual(instance.seedPaths, ['/lore/world.md', '/notes/keeper.md']);

    assert.equal(
      reloaded.store.fsSnapshot[`realm:${realmId}:global`]['/lore/world.md'].content,
      'World lore for the salt flats',
      'the generated realm-global seed hydrates'
    );
    assert.equal(
      reloaded.store.fsSnapshot[`realm:${realmId}:te-persist-keeper`]['/notes/keeper.md'].content,
      'Notes for the salt flats',
      'the user member seed hydrates'
    );
    const hydratedMember = reloaded.store.agents.find((agent) => agent.id === 'te-persist-keeper');
    assert.ok(hydratedMember, 'the member hydrates');
    assert.deepEqual(
      hydratedMember.history.map((message) => message.id),
      historyIds,
      'message ids survive the store persistence round-trip (INV-7)'
    );
    assert.notEqual(hydratedMember.config.privileged, true, 'hydration never widens the member privilege');
    assert.equal(hydratedMember.config.realmId, realmId);

    // 3. Relaunch from the hydrated import: same version, realm-local member,
    // isolated seed files.
    const relaunch = await reloaded.store.launchRealmFromTemplate(PERSIST_ID, {
      name: 'Relaunched Realm',
      package: createPersistPackage('the glass sea')
    });
    assert.notEqual(relaunch.realm.id, realmId, 'the relaunch creates its own realm');
    assert.equal(relaunch.realm.instance.templateVersion, PERSIST_VERSION, 'the relaunch pins the same version');
    assert.deepEqual(
      relaunch.agents.map((agent) => agent.id),
      ['te-persist-keeper'],
      'the same literal member id launches realm-locally'
    );
    const keeperRegistrations = reloaded.store.agents.filter((agent) => agent.id === 'te-persist-keeper');
    assert.equal(keeperRegistrations.length, 2, 'two realm registrations of the literal id exist side by side');
    assert.deepEqual(
      keeperRegistrations.map((agent) => agent.config.realmId).sort(),
      [realmId, relaunch.realm.id].sort()
    );
    assert.equal(
      reloaded.store.fsSnapshot[`realm:${relaunch.realm.id}:global`]['/lore/world.md'].content,
      'World lore for the glass sea',
      'the relaunched realm receives its own package content'
    );
    assert.equal(
      reloaded.store.fsSnapshot[`realm:${realmId}:global`]['/lore/world.md'].content,
      'World lore for the salt flats',
      'the original realm keeps its own bytes'
    );
    assert.equal(reloaded.store.exportRealmTemplate(PERSIST_ID), canonicalExport, 'the import is still canonical after relaunch');
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

// ============================================================================
// 2. Caps fail typed without applying; the persisted registry agrees
// ============================================================================

test('2. the per-bundle cap rejects typed, applies nothing, and the persisted registry stays clean', () => {
  sharedLocalStorage.clear();
  let first = createSharedSubstrateStore();
  let reloaded = null;
  try {
    first.store.importRealmTemplate(PERSIST_TRANSPORT);
    const acceptedExport = first.store.exportRealmTemplate(PERSIST_ID);
    first.store.saveToStorage();

    const oversized = {
      formatVersion: 1,
      template: {
        formatVersion: 1,
        id: 'te-persist-big',
        name: 'Oversized Fixture',
        description: 'Over the per-bundle budget.',
        agents: [{
          key: 'blob',
          idPattern: 'te-persist-blob',
          name: 'Blob',
          role: 'blob',
          prompt: [{ kind: 'text', text: 'Blob.' }],
          toolProfile: { tools: [] },
          privileged: false
        }]
      },
      files: { 'files/blob.txt': 'x'.repeat(REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES + 1) }
    };
    expectThrow(
      () => first.store.importRealmTemplate(oversized),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_TOO_LARGE,
      /exceeding the per-bundle cap/
    );
    assert.equal(first.store.getRealmTemplateBundle('te-persist-big'), null, 'the oversized import never applies');
    assert.equal(first.store.exportRealmTemplate(PERSIST_ID), acceptedExport, 'the accepted import is untouched');

    // The persisted snapshot was written before the refused mutation and still
    // names only the accepted import.
    const persisted = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
    assert.deepEqual(persisted.importedRealmTemplates.map((entry) => entry.id), [PERSIST_ID]);

    first.store.destroy();
    first.runtime.destroy();
    first = null;

    // A fresh hydration sees exactly the accepted import — the refused bundle
    // never leaked into persisted bytes.
    reloaded = createSharedSubstrateStore({ autoHydrate: true });
    assert.equal(reloaded.store.getRealmTemplateBundle('te-persist-big'), null);
    assert.equal(reloaded.store.exportRealmTemplate(PERSIST_ID), acceptedExport, 'the accepted import hydrates canonical');
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

// ============================================================================
// 3. Quota failures roll back the registry mutation and persist honest bytes
// ============================================================================

test('3. a quota-failed import and delete roll back with the typed error and hydrate honest bytes', () => {
  sharedLocalStorage.clear();
  let base = createSharedSubstrateStore();
  let reloaded = null;
  try {
    base.store.importRealmTemplate(PERSIST_TRANSPORT);
    const acceptedExport = base.store.exportRealmTemplate(PERSIST_ID);
    base.store.saveToStorage();
    const persistedBefore = sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1');

    sharedLocalStorage.__simulateQuotaExceeded(true);
    try {
      expectThrow(
        () => base.store.importRealmTemplate(createShadowDemoPayload()),
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_PERSIST_FAILED,
        /rolled back/
      );
      expectThrow(
        () => base.store.deleteRealmTemplate(PERSIST_ID),
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_PERSIST_FAILED,
        /rolled back/
      );
    } finally {
      sharedLocalStorage.__simulateQuotaExceeded(false);
    }

    // Both mutations rolled back in memory.
    assert.equal(base.store.getRealmTemplateSource('demo').source, 'shipped', 'the shadow import never applied');
    assert.equal(base.store.getRealmTemplateSource('demo').replacesShipped, false);
    assert.equal(base.store.getRealmTemplateSource(PERSIST_ID).source, 'imported', 'the delete never applied');
    assert.equal(base.store.exportRealmTemplate(PERSIST_ID), acceptedExport, 'the accepted import stays canonical');
    assert.equal(
      sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'),
      persistedBefore,
      'the failed writes left the persisted bytes untouched'
    );

    base.store.destroy();
    base.runtime.destroy();
    base = null;

    reloaded = createSharedSubstrateStore({ autoHydrate: true });
    assert.equal(reloaded.store.getRealmTemplateSource('demo').source, 'shipped', 'the shadow never reached the snapshot');
    assert.equal(reloaded.store.getRealmTemplateSource(PERSIST_ID).source, 'imported', 'the import survived the rollback');
    assert.equal(reloaded.store.exportRealmTemplate(PERSIST_ID), acceptedExport, 'the hydrated export is canonical');
  } finally {
    sharedLocalStorage.__simulateQuotaExceeded(false);
    if (base) {
      base.store.destroy();
      base.runtime.destroy();
    }
    if (reloaded) {
      reloaded.store.destroy();
      reloaded.runtime.destroy();
    }
    sharedLocalStorage.clear();
  }
});
