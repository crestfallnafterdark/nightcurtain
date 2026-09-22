/**
 * @file tests/integration/template_package_launch_test.js
 * @description Wave T lane T-E (ticket df3aac7) acceptance: the hydration
 *   package launch path end-to-end through the real `SandboxStore` +
 *   `realmCatalog` + `AgentRuntime` composition root (real substrate engines,
 *   real realm registry, real VFS).
 *
 *   Asserted contract:
 *   1. a package launch merges package inputs with explicit launch values (the
 *      explicit value wins) and the generated input composes into the launched
 *      agent's system prompt exactly like the catalog materialization;
 *   2. package `generated`/`user` seed files land in the correct workspaces —
 *      realm targets in the realm-global partition, member targets in the
 *      member's private partition — while `fixed` slots still resolve from the
 *      bundle;
 *   3. instance provenance records the package digest, per-input value hashes,
 *      and the seeded destination paths (hashes and paths only);
 *   4. a package missing a required generated slot, carrying a `fixed`-slot
 *      entry, or carrying an unmatched entry is rejected typed with no realm;
 *   5. a pinned-version mismatch fails closed by default and launches with an
 *      explicit `allowVersionMismatch` confirmation, riding the receipt as a
 *      warning (the review API reports the same warning);
 *   6. a providers/capability-bearing template imports, exports, and lists
 *      fine but launch is blocked with `ERR_TEMPLATE_PROVIDERS_UNSUPPORTED`
 *      before any side effect (no partial realm).
 *
 * Zero-Mock Verification: every engine class is the real production class; the
 * fixture declares no turn trigger (no `initialPrompt`, no seed directive), so
 * no model is ever resolved and no request leaves the process.
 *
 * Standalone: `timeout 180 node tests/integration/template_package_launch_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RealmCatalogError,
  hashText,
  materializeTemplate,
  serializeTemplateBundle,
  templateBundleVersion,
  templateRequiresProviders,
  validateHydrationPackage
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  SANDBOX_STORE_ERROR_CODES,
  createSandboxStore
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';

/** Package fixture template id. */
const PACKAGE_ID = 'te-package';

/** Fixture bundle files resolved by the prompt part and the fixed seed slot. */
const PACKAGE_FILES = Object.freeze({
  'prompts/narrator.md': 'Narrator protocol.'
});

/** Fixture template: generated + user inputs, generated/user/fixed seed slots. */
const PACKAGE_TEMPLATE = Object.freeze({
  formatVersion: 1,
  id: PACKAGE_ID,
  name: 'Package Fixture',
  description: 'Hydration package launch fixture.',
  inputs: [
    { id: 'premise', label: 'Premise', origin: 'generated', brief: 'One generated premise.' },
    { id: 'tone', label: 'Tone', default: 'neutral' }
  ],
  agents: [{
    key: 'narrator',
    idPattern: 'te-package-narrator',
    name: 'Narrator',
    role: 'narrator',
    prompt: [
      { kind: 'file', path: 'prompts/narrator.md' },
      { kind: 'input', inputId: 'premise' },
      { kind: 'input', inputId: 'tone' },
      { kind: 'text', text: 'literal tail' }
    ],
    toolProfile: { preset: 'readonly' },
    privileged: false
  }],
  seed: {
    files: [
      { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'Generated world lore.' },
      { path: 'notes/member.md', target: { agent: 'narrator' }, origin: 'user', brief: 'Operator notes.' },
      { path: 'rules/base.md', target: 'realm', origin: 'fixed', source: { inline: 'Fixed rules.' } },
      { path: 'dossier/entry.md', target: { agent: 'narrator' }, origin: 'generated', brief: 'Generated dossier entry.' }
    ]
  }
});

/** The fixture as a canonical transport payload. */
const PACKAGE_TRANSPORT = Object.freeze({
  formatVersion: 1,
  template: PACKAGE_TEMPLATE,
  files: PACKAGE_FILES
});

/** Effective fixture bundle version (what a correctly pinned package carries). */
const PACKAGE_VERSION = templateBundleVersion({ template: PACKAGE_TEMPLATE, files: PACKAGE_FILES });

/** Generated package content used by the launch cases. */
const PACKAGE_INPUTS = Object.freeze({
  premise: 'A city under a sleeping sun.',
  tone: 'package tone'
});

/** Package file entries matching the declared generated/user slots. */
const PACKAGE_ENTRIES = Object.freeze([
  { path: 'lore/world.md', target: 'realm', content: 'Generated world lore.' },
  { path: 'notes/member.md', target: { agent: 'narrator' }, content: 'Operator member notes.' },
  { path: 'dossier/entry.md', target: { agent: 'narrator' }, content: 'Generated dossier entry.' }
]);

/**
 * Builds a hydration package for the fixture template.
 *
 * @param {object} [overrides] - Field overrides (for example `files`, `inputs`).
 * @returns {object} Package object.
 */
function createPackage(overrides = {}) {
  return {
    formatVersion: 1,
    templateId: PACKAGE_ID,
    templateVersion: PACKAGE_VERSION,
    inputs: { ...PACKAGE_INPUTS },
    files: PACKAGE_ENTRIES.map((entry) => ({ ...entry })),
    provenance: { hydrator: 'te-integration', generatedAt: '2026-09-21T00:00:00.000Z' },
    ...overrides
  };
}

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
 * Asserts that a synchronous call throws a `RealmCatalogError` with a code.
 *
 * @param {Function} fn - Call under test.
 * @param {string} code - Expected catalog error code.
 * @param {RegExp} messagePattern - Expected message pattern.
 * @returns {Error} The thrown error.
 */
function expectCatalogThrow(fn, code, messagePattern) {
  let err = null;
  try {
    fn();
  } catch (thrown) {
    err = thrown;
  }
  assert.ok(err, `expected a '${code}' error`);
  assert.ok(err instanceof RealmCatalogError, `expected a RealmCatalogError, got ${err?.constructor?.name}`);
  assert.equal(err.code, code, `expected code '${code}', got '${err.code}': ${err.message}`);
  assert.match(err.message, messagePattern);
  return err;
}

// ============================================================================
// 1. Generated inputs compose into the launched prompts; files land correctly
// ============================================================================

test('1. a package launch composes generated inputs and seeds realm-global and member files', async () => {
  const store = createStore();
  try {
    store.importRealmTemplate(PACKAGE_TRANSPORT);
    const pkg = createPackage();

    const receipt = await store.launchRealmFromTemplate(PACKAGE_ID, {
      name: 'Package Realm',
      package: pkg,
      inputValues: { tone: 'launch tone' }
    });
    const realmId = receipt.realm.id;
    const realmGlobalKey = `realm:${realmId}:global`;
    const memberKey = `realm:${realmId}:te-package-narrator`;

    assert.equal(receipt.realm.templateId, PACKAGE_ID);
    assert.deepEqual(receipt.agents.map((agent) => agent.id), ['te-package-narrator']);

    // The composed prompt interleaves the bundle protocol file, the generated
    // package input, the explicit launch value, and the inline part.
    const narrator = store.agents.find((agent) => agent.id === 'te-package-narrator');
    assert.equal(
      narrator.config.systemPrompt,
      'Narrator protocol.\n\nA city under a sleeping sun.\n\nlaunch tone\n\nliteral tail',
      'the generated premise and the explicit launch value compose in declared order'
    );

    // Cross-check against the pure catalog materialization of the same inputs.
    const bundle = store.getRealmTemplateBundle(PACKAGE_ID);
    const resolved = validateHydrationPackage(bundle.template, pkg, { currentVersion: PACKAGE_VERSION });
    const expected = materializeTemplate(bundle.template, {
      realmId,
      inputValues: { tone: 'launch tone', premise: 'A city under a sleeping sun.' },
      hydrationFiles: resolved.files,
      bundleFiles: bundle.files
    });
    assert.equal(narrator.config.systemPrompt, expected.agents[0].systemPrompt, 'launch matches materialization');

    // Generated + fixed realm files land in the realm-global partition.
    assert.equal(store.fsSnapshot[realmGlobalKey]['/lore/world.md'].content, 'Generated world lore.');
    assert.equal(store.fsSnapshot[realmGlobalKey]['/rules/base.md'].content, 'Fixed rules.');

    // Generated + user member files land in the member's private partition.
    assert.equal(store.fsSnapshot[memberKey]['/notes/member.md'].content, 'Operator member notes.');
    assert.equal(store.fsSnapshot[memberKey]['/dossier/entry.md'].content, 'Generated dossier entry.');

    // No cross-workspace leakage: member files never surface in the realm
    // partition and vice versa.
    assert.equal(store.fsSnapshot[realmGlobalKey]['/notes/member.md'], undefined);
    assert.equal(store.fsSnapshot[memberKey]['/lore/world.md'], undefined);

    // Provenance: hashes and paths only.
    const instance = receipt.realm.instance;
    assert.ok(instance, 'the receipt realm carries provenance');
    assert.ok(instance.packageDigest.startsWith('sha256:'), 'the package digest is a content hash');
    assert.equal(instance.inputHashes.premise, hashText('A city under a sleeping sun.'));
    assert.equal(instance.inputHashes.tone, hashText('launch tone'), 'the explicit launch value wins over the package');
    assert.deepEqual(
      instance.seedPaths,
      ['/lore/world.md', '/rules/base.md', '/notes/member.md', '/dossier/entry.md'],
      'seed paths record each destination in group/write order'
    );
    assert.equal(
      !JSON.stringify(instance).includes('A city under a sleeping sun.'),
      true,
      'no raw generated input value reaches the provenance record'
    );

    // A second launch without launch values takes both inputs from the package.
    const packageOnly = await store.launchRealmFromTemplate(PACKAGE_ID, { name: 'Package Only Realm', package: createPackage() });
    const secondNarrator = store.agents.find(
      (agent) => agent.id === 'te-package-narrator' && agent.config.realmId === packageOnly.realm.id
    );
    assert.equal(
      secondNarrator.config.systemPrompt,
      'Narrator protocol.\n\nA city under a sleeping sun.\n\npackage tone\n\nliteral tail',
      'package inputs resolve when no launch value overrides them'
    );
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 2. Package validation fails closed, typed, before any record exists
// ============================================================================

test('2. required-missing, fixed-entry, and unmatched package entries reject typed with no partial realm', async () => {
  const store = createStore();
  try {
    store.importRealmTemplate(PACKAGE_TRANSPORT);
    const realmsBefore = store.realms.map((realm) => realm.id);
    const agentsBefore = store.agents.map((agent) => agent.id).sort();

    const missingGenerated = createPackage({
      files: PACKAGE_ENTRIES.filter((entry) => entry.path !== 'lore/world.md').map((entry) => ({ ...entry }))
    });
    await assert.rejects(
      () => store.launchRealmFromTemplate(PACKAGE_ID, { package: missingGenerated }),
      (err) => err instanceof RealmCatalogError
        && err.code === 'ERR_HYDRATION_PACKAGE'
        && /missing the required generated seed slot 'lore\/world.md'/.test(err.message)
    );

    const fixedEntry = createPackage({
      files: [...PACKAGE_ENTRIES.map((entry) => ({ ...entry })), { path: 'rules/base.md', target: 'realm', content: 'must not attach' }]
    });
    await assert.rejects(
      () => store.launchRealmFromTemplate(PACKAGE_ID, { package: fixedEntry }),
      (err) => err instanceof RealmCatalogError
        && err.code === 'ERR_HYDRATION_PACKAGE'
        && /fixed seed slot/.test(err.message)
    );

    const unmatchedEntry = createPackage({
      files: [...PACKAGE_ENTRIES.map((entry) => ({ ...entry })), { path: 'ghost/file.md', target: 'realm', content: 'nowhere' }]
    });
    await assert.rejects(
      () => store.launchRealmFromTemplate(PACKAGE_ID, { package: unmatchedEntry }),
      (err) => err instanceof RealmCatalogError
        && err.code === 'ERR_HYDRATION_PACKAGE'
        && /does not match any declared seed slot/.test(err.message)
    );

    // The pure catalog validator agrees with the store gate.
    const bundle = store.getRealmTemplateBundle(PACKAGE_ID);
    expectCatalogThrow(
      () => validateHydrationPackage(bundle.template, missingGenerated, { currentVersion: PACKAGE_VERSION }),
      'ERR_HYDRATION_PACKAGE',
      /missing the required generated seed slot/
    );

    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'rejected packages create no realm record');
    assert.deepEqual(store.agents.map((agent) => agent.id).sort(), agentsBefore, 'rejected packages launch no member');
    assert.equal(store.recycleBin.length, 0, 'rejected packages leave no recycle residue');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 3. Version mismatch: fail-closed by default, explicit confirmation warns
// ============================================================================

test('3. a pinned-version mismatch fails closed by default and launches with allowVersionMismatch as a warning', async () => {
  const store = createStore();
  try {
    store.importRealmTemplate(PACKAGE_TRANSPORT);
    const bundle = store.getRealmTemplateBundle(PACKAGE_ID);
    const mismatched = createPackage({ templateVersion: `sha256:${'0'.repeat(64)}` });
    const realmsBefore = store.realms.map((realm) => realm.id);

    // Review surface: the mismatch is a typed error unless the reviewer
    // explicitly allows it, in which case it is reported as a warning.
    expectCatalogThrow(
      () => validateHydrationPackage(bundle.template, mismatched, { currentVersion: PACKAGE_VERSION }),
      'ERR_HYDRATION_VERSION_MISMATCH',
      /allowVersionMismatch/
    );
    const review = validateHydrationPackage(bundle.template, mismatched, {
      currentVersion: PACKAGE_VERSION,
      allowVersionMismatch: true
    });
    assert.equal(review.warnings.length, 1, 'the allowed mismatch is reported once');
    assert.match(review.warnings[0], /version/);
    assert.equal(review.templateVersion, mismatched.templateVersion, 'the review keeps the pinned version');

    // Launch blocks by default, before any realm record exists.
    await assert.rejects(
      () => store.launchRealmFromTemplate(PACKAGE_ID, { package: mismatched }),
      (err) => err instanceof RealmCatalogError && err.code === 'ERR_HYDRATION_VERSION_MISMATCH'
    );
    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'the blocked launch creates no record');

    // The explicit confirmation launches and rides the receipt as a warning.
    const allowed = await store.launchRealmFromTemplate(PACKAGE_ID, {
      name: 'Mismatch Allowed',
      package: mismatched,
      allowVersionMismatch: true
    });
    assert.equal(allowed.warnings.length, 1, 'the allowed mismatch rides the launch receipt');
    assert.match(allowed.warnings[0], /version/);
    assert.equal(
      allowed.realm.instance.templateVersion,
      PACKAGE_VERSION,
      'provenance pins the effective bundle version, not the package pin'
    );
    assert.equal(
      store.fsSnapshot[`realm:${allowed.realm.id}:global`]['/lore/world.md'].content,
      'Generated world lore.',
      'the mismatched package content still lands after explicit confirmation'
    );

    // A non-boolean confirmation is an invalid launch option (nothing created).
    await assert.rejects(
      () => store.launchRealmFromTemplate(PACKAGE_ID, { package: mismatched, allowVersionMismatch: 'yes' }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
    );
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 4. Providers/capability contract: import accepted, launch blocked
// ============================================================================

/** Provider-bearing fixture: one requirement plus one pack and one MCP request. */
const PROVIDERS_TEMPLATE = Object.freeze({
  formatVersion: 1,
  id: 'te-providers',
  name: 'Provider Fixture',
  description: 'Declares a capability contract.',
  agents: [{
    key: 'observer',
    idPattern: 'te-providers-observer',
    name: 'Observer',
    role: 'observer',
    prompt: [{ kind: 'text', text: 'Observe.' }],
    toolProfile: { tools: [] },
    privileged: false
  }],
  toolContract: {
    requirements: [{
      id: 'text.similarity',
      brief: 'Similarity between two texts.',
      io: { in: { a: 'string', b: 'string' }, out: { score: 'number' } },
      required: true
    }]
  },
  providers: [
    { kind: 'pack', id: 'acme/text-tools', range: '^1' },
    {
      kind: 'mcp',
      id: 'acme-scoring',
      transport: { kind: 'http', url: 'https://mcp.example.com' },
      provides: [{ capability: 'text.similarity', tool: 'similarity' }],
      authRef: 'acme_scoring_key'
    }
  ]
});

/** The provider fixture as a canonical transport payload. */
const PROVIDERS_TRANSPORT = Object.freeze({
  formatVersion: 1,
  template: PROVIDERS_TEMPLATE,
  files: {}
});

test('4. a providers-bearing template imports and exports fine but launch is blocked with the typed gate', async () => {
  const store = createStore();
  try {
    const importReceipt = store.importRealmTemplate(PROVIDERS_TRANSPORT);
    assert.equal(importReceipt.templateId, 'te-providers', 'the capability contract is accepted at import');
    assert.equal(importReceipt.source, 'imported');
    assert.equal(
      store.exportRealmTemplate('te-providers'),
      serializeTemplateBundle(PROVIDERS_TRANSPORT),
      'the capability contract exports unchanged'
    );
    assert.equal(store.getRealmTemplateSource('te-providers').source, 'imported');
    const bundle = store.getRealmTemplateBundle('te-providers');
    assert.equal(templateRequiresProviders(bundle.template), true, 'the catalog exposes the launch gate predicate');

    const realmsBefore = store.realms.map((realm) => realm.id);
    const agentsBefore = store.agents.map((agent) => agent.id).sort();
    const messagesBefore = store.messages.length;
    const fsBefore = JSON.stringify(store.fsSnapshot);

    let failure = null;
    try {
      await store.launchRealmFromTemplate('te-providers');
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, 'the providers-bearing template must block the launch');
    assert.equal(failure.code, SANDBOX_STORE_ERROR_CODES.ERR_TEMPLATE_PROVIDERS_UNSUPPORTED);
    assert.equal(failure.code, 'ERR_TEMPLATE_PROVIDERS_UNSUPPORTED');

    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'no partial realm record');
    assert.deepEqual(store.agents.map((agent) => agent.id).sort(), agentsBefore, 'no partial member');
    assert.equal(store.recycleBin.length, 0, 'no recycle residue');
    assert.equal(store.messages.length, messagesBefore, 'nothing is delivered');
    assert.equal(JSON.stringify(store.fsSnapshot), fsBefore, 'nothing is written to any workspace');
  } finally {
    store.destroy();
  }
});
