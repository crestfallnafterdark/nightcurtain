/**
 * @file tests/integration/template_roundtrip_test.js
 * @description Wave T lane T-E (ticket df3aac7) acceptance: the Realm template
 *   transport round-trip end-to-end through the real `SandboxStore` +
 *   `realmCatalog` + `AgentRuntime` composition root (real substrate engines,
 *   real registry, real preset catalog).
 *
 *   Asserted contract:
 *   1. import → export → re-import preserves `templateBundleVersion` in the
 *      same store and across a fresh store (the export is the canonical
 *      transport JSON, byte-identical after a second round-trip);
 *   2. a Realm launched from the imported bundle pins that content version in
 *      its instance provenance and composes exactly like the catalog
 *      materialization of the same bundle, on both stores;
 *   3. the effective launch catalog resolves shipped → imported (imports append
 *      after the shipped entries and one id keeps one effective entry), and an
 *      imported id replaces a shipped id in place;
 *   4. deleting a shadowing import restores the shipped revision for future
 *      launches while realms already launched from the import stay untouched
 *      (launched realms never read the catalog again — no upgrade path).
 *
 * Zero-Mock Verification: every engine class (store, runtime, VirtualFS,
 * messaging bus, realm registry, preset catalog, realmCatalog helpers) is the
 * real production class; the fixtures never declare a turn trigger, so no model
 * is ever resolved and no request leaves the process.
 *
 * Standalone: `timeout 180 node tests/integration/template_roundtrip_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAKED_TEMPLATE_BUNDLES,
  DEMO_TEMPLATE,
  hashText,
  materializeTemplate,
  serializeTemplateBundle,
  templateBundleVersion
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  SANDBOX_STORE_ERROR_CODES,
  createSandboxStore
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';

/** Imported fixture template id under test. */
const ROUNDTRIP_ID = 'te-roundtrip';

/** Fixture bundle files resolved by the fixture template's prompt part. */
const ROUNDTRIP_FILES = Object.freeze({
  'prompts/writer.md': 'Roundtrip writer protocol.'
});

/** Fixture template exercised by the transport round-trip. */
const ROUNDTRIP_TEMPLATE = Object.freeze({
  formatVersion: 1,
  id: ROUNDTRIP_ID,
  name: 'Roundtrip Fixture',
  description: 'Transport round-trip fixture.',
  inputs: [{ id: 'subject', label: 'Subject', default: 'the harbour' }],
  agents: [{
    key: 'writer',
    idPattern: 'te-roundtrip-writer',
    name: 'Writer',
    role: 'writer',
    prompt: [
      { kind: 'file', path: 'prompts/writer.md' },
      { kind: 'input', inputId: 'subject' }
    ],
    toolProfile: { preset: 'readonly' },
    privileged: false
  }],
  seed: {
    files: [
      { path: 'notes/start.md', target: 'realm', origin: 'fixed', source: { inline: 'Start here.' } }
    ]
  }
});

/** The fixture as a canonical transport payload (what `importRealmTemplate` accepts). */
const ROUNDTRIP_TRANSPORT = Object.freeze({
  formatVersion: 1,
  template: ROUNDTRIP_TEMPLATE,
  files: ROUNDTRIP_FILES
});

/** The fixture in catalog bundle shape (`{ template, files }`). */
const ROUNDTRIP_BUNDLE = Object.freeze({ template: ROUNDTRIP_TEMPLATE, files: ROUNDTRIP_FILES });

/** Baked demo ids in shipped order (the effective catalog's shipped prefix). */
const BAKED_IDS = BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id);

/**
 * Creates an isolated non-hydrating store backed by the real runtime
 * substrates.
 *
 * @returns {object} Fresh `SandboxStore` instance.
 */
function createStore() {
  return createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
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
// 1. Import → export → re-import preserves the content version
// ============================================================================

test('1. import → export → re-import preserves the content version in one store and across a fresh store', () => {
  const expectedVersion = templateBundleVersion(ROUNDTRIP_BUNDLE);
  const first = createStore();
  const second = createStore();
  try {
    const receipt = first.importRealmTemplate(ROUNDTRIP_TRANSPORT);
    assert.equal(receipt.templateId, ROUNDTRIP_ID);
    assert.equal(receipt.templateVersion, expectedVersion, 'the import receipt pins the fixture version');
    assert.equal(receipt.source, 'imported');
    assert.equal(receipt.replacesShipped, false, 'a new id shadows nothing');
    assert.equal(receipt.replacedImport, false);

    // The effective catalog resolves shipped first, then the import; the
    // transport export is the canonical JSON of that effective bundle.
    const effectiveIds = first.listRealmTemplates().map((template) => template.id);
    assert.deepEqual(
      effectiveIds.slice(0, BAKED_IDS.length),
      BAKED_IDS,
      'shipped bundles keep their order and the import appends after them'
    );
    assert.equal(effectiveIds.filter((id) => id === ROUNDTRIP_ID).length, 1, 'one effective entry per id');
    const exported = first.exportRealmTemplate(ROUNDTRIP_ID);
    assert.equal(exported, serializeTemplateBundle(ROUNDTRIP_BUNDLE), 'export is the canonical fixture payload');

    // Re-importing the exported text replaces the previous import in place and
    // keeps the same content version.
    const reimported = first.importRealmTemplate(exported);
    assert.equal(reimported.templateVersion, expectedVersion, 'the text round-trip preserves the version');
    assert.equal(reimported.replacedImport, true);
    assert.equal(first.exportRealmTemplate(ROUNDTRIP_ID), exported, 'the payload stays canonical');

    // A fresh store resolves the exported payload to the same version and
    // reproduces the exact transport bytes.
    const freshReceipt = second.importRealmTemplate(exported);
    assert.equal(freshReceipt.templateId, ROUNDTRIP_ID);
    assert.equal(freshReceipt.templateVersion, expectedVersion, 'a fresh store derives the identical version');
    assert.equal(second.exportRealmTemplate(ROUNDTRIP_ID), exported, 'the second round-trip is byte-identical');
    const freshBundle = second.getRealmTemplateBundle(ROUNDTRIP_ID);
    assert.equal(freshBundle.template.id, ROUNDTRIP_ID);
    assert.deepEqual(freshBundle.files, ROUNDTRIP_FILES, 'bundle file bodies survive the transport');
    assert.ok(Object.isFrozen(freshBundle) && Object.isFrozen(freshBundle.template), 'the effective bundle is frozen');

    // Source labels come from the same effective catalog.
    assert.deepEqual(first.getRealmTemplateSource(ROUNDTRIP_ID), {
      templateId: ROUNDTRIP_ID,
      source: 'imported',
      replacesShipped: false,
      templateVersion: expectedVersion
    });
    assert.equal(first.getRealmTemplateSource(DEMO_TEMPLATE.id).source, 'shipped');
    assert.equal(first.getRealmTemplateSource('te-missing'), null);
    expectThrow(
      () => first.exportRealmTemplate('te-missing'),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /unknown realm template/
    );
  } finally {
    first.destroy();
    second.destroy();
  }
});

// ============================================================================
// 2. A launched realm pins the round-tripped version and composes identically
// ============================================================================

test('2. a realm launched from the round-tripped bundle pins the version and composes like the catalog', async () => {
  const expectedVersion = templateBundleVersion(ROUNDTRIP_BUNDLE);
  const first = createStore();
  const second = createStore();
  try {
    first.importRealmTemplate(ROUNDTRIP_TRANSPORT);
    const exported = first.exportRealmTemplate(ROUNDTRIP_ID);
    second.importRealmTemplate(exported);

    const launchInputs = { subject: 'the lighthouse' };
    const firstReceipt = await first.launchRealmFromTemplate(ROUNDTRIP_ID, { inputValues: launchInputs });
    const secondReceipt = await second.launchRealmFromTemplate(ROUNDTRIP_ID, {
      name: 'Roundtrip Realm (fresh store)',
      inputValues: launchInputs
    });

    for (const [label, store, receipt] of [
      ['first store', first, firstReceipt],
      ['fresh store', second, secondReceipt]
    ]) {
      assert.equal(receipt.realm.templateId, ROUNDTRIP_ID, `${label}: the realm records its template id`);
      assert.deepEqual(
        receipt.agents.map((agent) => agent.id),
        ['te-roundtrip-writer'],
        `${label}: the import resolves its literal member id`
      );
      const instance = receipt.realm.instance;
      assert.equal(instance.templateId, ROUNDTRIP_ID, `${label}: provenance names the template`);
      assert.equal(instance.templateVersion, expectedVersion, `${label}: provenance pins the round-tripped version`);
      assert.equal(
        instance.inputHashes.subject,
        hashText('the lighthouse'),
        `${label}: provenance records the input hash, never the value`
      );
      assert.deepEqual(instance.seedPaths, ['/notes/start.md'], `${label}: the fixed seed path is recorded`);

      // The launched member composes exactly like the catalog materialization
      // of the same effective bundle.
      const bundle = store.getRealmTemplateBundle(ROUNDTRIP_ID);
      const expected = materializeTemplate(bundle.template, {
        realmId: receipt.realm.id,
        inputValues: launchInputs,
        bundleFiles: bundle.files
      });
      const member = store.agents.find((agent) => agent.id === 'te-roundtrip-writer');
      assert.ok(member, `${label}: the member is active`);
      assert.equal(member.config.systemPrompt, expected.agents[0].systemPrompt, `${label}: prompt matches materialization`);
      assert.equal(
        member.config.systemPrompt,
        'Roundtrip writer protocol.\n\nthe lighthouse',
        `${label}: protocol file plus launch value compose in declared order`
      );
      assert.equal(
        store.fsSnapshot[`realm:${receipt.realm.id}:global`]['/notes/start.md'].content,
        'Start here.',
        `${label}: the fixed bundle seed lands in the realm-global workspace`
      );
    }

    assert.notEqual(firstReceipt.realm.id, secondReceipt.realm.id, 'the two stores launch independent realms');
    // Re-exporting after both launches still reproduces the canonical payload.
    assert.equal(first.exportRealmTemplate(ROUNDTRIP_ID), exported);
    assert.equal(second.exportRealmTemplate(ROUNDTRIP_ID), exported);
  } finally {
    first.destroy();
    second.destroy();
  }
});

// ============================================================================
// 3. Imported id replaces a shipped id; delete restores the shipped revision
// ============================================================================

/**
 * Fresh shadow fixture: a valid template whose id equals the baked demo id, so
 * importing it must replace the shipped entry in place.
 *
 * @returns {object} Transport bundle.
 */
function createShadowDemoBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: DEMO_TEMPLATE.id,
      name: 'Roundtrip Shadow Demo',
      description: 'Imported revision shadowing the shipped demo fixture.',
      agents: [{
        key: 'shadow',
        idPattern: 'te-roundtrip-shadow',
        name: 'Shadow Member',
        role: 'worker',
        prompt: [{ kind: 'text', text: 'Shadow protocol.' }],
        toolProfile: { tools: [] },
        privileged: false
      }]
    },
    files: {}
  };
}

test('3. an imported id replaces a shipped id at launch and delete restores the shipped revision', async () => {
  const store = createStore();
  try {
    const shippedBundle = store.getRealmTemplateBundle(DEMO_TEMPLATE.id);
    const shippedVersion = templateBundleVersion({ template: shippedBundle.template, files: shippedBundle.files });
    const shadow = createShadowDemoBundle();
    const shadowVersion = templateBundleVersion({ template: shadow.template, files: shadow.files });

    // Baseline: the shipped revision launches coordinator + worker.
    const shippedReceipt = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Shipped Baseline' });
    assert.deepEqual(
      shippedReceipt.agents.map((agent) => agent.id),
      ['coordinator', 'worker'],
      'the shipped demo revision launches its declared members'
    );
    assert.equal(shippedReceipt.realm.instance.templateVersion, shippedVersion);

    // The import replaces the shipped id in place: same catalog position, same
    // single effective entry, imported source label.
    const shadowReceipt = store.importRealmTemplate(shadow);
    assert.equal(shadowReceipt.templateId, DEMO_TEMPLATE.id);
    assert.equal(shadowReceipt.replacesShipped, true, 'the import shadows the shipped demo id');
    assert.equal(shadowReceipt.templateVersion, shadowVersion);
    assert.deepEqual(
      store.listRealmTemplates().map((template) => template.id),
      BAKED_IDS,
      'shadowing replaces in place: shipped order and ids are unchanged'
    );
    assert.deepEqual(store.getRealmTemplateSource(DEMO_TEMPLATE.id), {
      templateId: DEMO_TEMPLATE.id,
      source: 'imported',
      replacesShipped: true,
      templateVersion: shadowVersion
    });
    assert.equal(store.exportRealmTemplate(DEMO_TEMPLATE.id), serializeTemplateBundle(shadow));

    // The next launch resolves the import, not the shipped revision.
    const shadowLaunch = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Shadow Realm' });
    assert.deepEqual(
      shadowLaunch.agents.map((agent) => agent.id),
      ['te-roundtrip-shadow'],
      'a launch resolves the imported revision member'
    );
    assert.equal(shadowLaunch.realm.instance.templateVersion, shadowVersion);
    assert.equal(store.getRealm(shadowLaunch.realm.id).templateId, DEMO_TEMPLATE.id);

    // Delete reveals the shipped revision for future launches, while the realm
    // launched from the import keeps its shadow member and pinned version (a
    // launched realm never reads the catalog again — no upgrade path).
    assert.equal(store.deleteRealmTemplate(DEMO_TEMPLATE.id), true);
    assert.deepEqual(store.getRealmTemplateSource(DEMO_TEMPLATE.id), {
      templateId: DEMO_TEMPLATE.id,
      source: 'shipped',
      replacesShipped: false,
      templateVersion: shippedVersion
    });
    assert.equal(store.getRealmTemplateBundle(DEMO_TEMPLATE.id).template, DEMO_TEMPLATE, 'the shipped revision resurfaces');
    assert.equal(store.deleteRealmTemplate(DEMO_TEMPLATE.id), false, 'the shipped revision has no delete path');

    const restoredReceipt = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Restored Shipped Realm' });
    assert.deepEqual(
      restoredReceipt.agents.map((agent) => agent.id),
      ['coordinator', 'worker'],
      'the shipped revision launches again after the import is deleted'
    );
    assert.equal(restoredReceipt.realm.instance.templateVersion, shippedVersion);
    assert.ok(
      store.agents.some((agent) => agent.id === 'te-roundtrip-shadow' && agent.config.realmId === shadowLaunch.realm.id),
      'the realm launched from the shadow import keeps its member'
    );
    assert.equal(
      store.getRealm(shadowLaunch.realm.id).instance.templateVersion,
      shadowVersion,
      'the shadow realm keeps its pinned version after the import is deleted'
    );
  } finally {
    store.destroy();
  }
});
