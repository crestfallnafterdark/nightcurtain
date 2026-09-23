/**
 * @file tests/integration/realm_publishing_tools_test.js
 * @description Wave U lane U-P (ticket 2518510) acceptance: `AgentSpec.authorities`,
 *   the two explicit-grant-only publishing meta tools (`import_realm_template`,
 *   `submit_hydration_package`) with `dry_run`, the dedicated template/hydration
 *   grants, launch approval + trust override, and the session candidate store.
 *   The format-v2 migration (ticket 76f3492, decision `2ba3008`) is covered in
 *   the same suite: v1|v2 import transport, v2 payloads and v1 packages on one
 *   `validatePayload` path, host-side `{ sourceFile }` resolution, and the
 *   canonical `payloadDigest` that equals the launch provenance `packageDigest`.
 *
 *   Asserted contract:
 *   1. catalog authorities: closed shape, duplicates/non-strings rejected,
 *      unknown ids accepted, materialized onto plans, version-hash coverage,
 *      `templateUnsupportedAuthorities` reporting;
 *   2. tool surface: publishing descriptors outside the canonical taxonomy,
 *      Draft-07 closed schemas, schemas only for the exact authority;
 *   3. authorization matrix: anonymous/descriptor-less, wildcard, and
 *      `privileged` callers denied; explicit grant allowed; revoke denied;
 *      engine-composed director allowed; per-call port substitution denied;
 *   4. import resolution: inline/file manifests, exactly-one exclusivity,
 *      caller-view source resolution, caps, typed errors, `dry_run` zero side
 *      effects (catalog + persisted topology unchanged), either authored
 *      transport format, and the catalog parser as the single validation truth;
 *   5. submission resolution: canonical inline payload, v2 shape-matched values
 *      and v1 packages, version mismatch fails closed, required coverage, caps,
 *      candidate lifecycle (session-only), the canonical payload digest, and
 *      `dry_run` stores nothing;
 *   6. launch approvals: declared-but-unapproved declined, approved granted
 *      under the operator principal, approvals beyond declarations rejected,
 *      unknown declared authority ids fail the launch closed, trust exact-set
 *      auto-approval, delta re-prompt, clear revokes the trust;
 *   7. grants: serialize/hydrate round-trip (`metaAuthorityGrants`,
 *      `templateAuthorityTrust`), revoke, kill drops grants, legacy snapshots
 *      byte-compatible;
 *   8. smuggling: `updateAgentConfig`, launch/spawn configs, and capability
 *      selectors can never place the authority ids.
 *
 * Zero-Mock Verification: every engine class (store, runtime, VirtualFS,
 * messaging bus, realm registry, preset catalog, realmCatalog helpers) is the
 * real production class; no fixture triggers a model turn.
 *
 * Standalone: `timeout 180 node tests/integration/realm_publishing_tools_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore, SANDBOX_STORE_ERROR_CODES } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import {
  AGENT_AUTHORITIES,
  KNOWN_AGENT_AUTHORITIES,
  RealmCatalogError,
  materializeTemplate,
  parseTemplateBundle,
  payloadDigest,
  serializeTemplateBundle,
  templateBundleVersion,
  templateUnsupportedAuthorities
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  ALL_TOOL_DESCRIPTORS,
  PUBLISHING_TOOL_REGISTRY,
  TOOL_REGISTRY,
  getPublishingToolSchemas
} from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { PUBLISHING_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { validateSandboxState } from '../../src/lib/sandbox/sandboxPersistence/index.ts';

/** Fixture template id used by most publishing cases. */
const FIXTURE_ID = 'up-publishing-fixture';

/** One mebibyte. */
const MiB = 1024 * 1024;

/**
 * Builds the shared fixture template: one template-authority agent, one
 * hydration-authority agent, one generated input and one generated seed slot.
 *
 * @param {{ id?: string, authorities?: object }} [options] - Fixture overrides.
 * @returns {object} Format-v1 template spec.
 */
function createFixtureTemplate({ id = FIXTURE_ID, authorities = null } = {}) {
  const declared = authorities ?? {
    architect: [AGENT_AUTHORITIES.TEMPLATE],
    genesis: [AGENT_AUTHORITIES.HYDRATION]
  };
  return {
    formatVersion: 1,
    id,
    name: 'Publishing Fixture',
    description: 'Wave U publishing fixture.',
    hydration: { brief: 'Produce the opening lore.' },
    inputs: [
      // Format-v2 totality: the input is consumed by the architect prompt
      // below; it stays optional (no `generated` origin) so authority/approval
      // fixtures can launch without a package.
      { id: 'premise', label: 'Premise', brief: 'One generated premise.' }
    ],
    seed: {
      files: [
        // `user` origin: an absent slot is skipped, so authority/approval
        // fixtures launch without a package; submission tests still exercise
        // slot matching against this declared slot.
        { path: 'lore/world.md', target: 'realm', origin: 'user', brief: 'World lore.' }
      ]
    },
    agents: [
      {
        key: 'architect',
        idPattern: `${id}-architect`,
        name: 'Architect',
        role: 'author',
        prompt: [
          { kind: 'text', text: 'You author templates.' },
          { kind: 'input', inputId: 'premise' }
        ],
        toolProfile: { tools: ['read_file'] },
        privileged: false,
        ...(declared.architect ? { authorities: [...declared.architect] } : {})
      },
      {
        key: 'genesis',
        idPattern: `${id}-genesis`,
        name: 'Genesis',
        role: 'hydrator',
        prompt: [{ kind: 'text', text: 'You hydrate payloads.' }],
        toolProfile: { tools: ['read_file'] },
        privileged: false,
        ...(declared.genesis ? { authorities: [...declared.genesis] } : {})
      }
    ]
  };
}

/**
 * Creates an isolated store over its own real runtime substrates.
 *
 * @param {{ autoHydrate?: boolean }} [options] - Hydration flag.
 * @returns {{ runtime: object, store: object, vfs: object, bus: object }}
 */
function createFixtureStore({ autoHydrate = false } = {}) {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });
  const store = new SandboxStore({
    runtime,
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false,
    autoHydrate
  });
  return { runtime, store, vfs, bus };
}

/** Fixture template id for the format-v2 publishing cases. */
const V2_FIXTURE_ID = 'up-publishing-v2-fixture';

/**
 * Builds a format-v2 fixture template: one required text input consumed by a
 * prompt part and one required files input consumed by a placement.
 *
 * @param {{ id?: string, loreRoot?: boolean }} [options] - Fixture overrides.
 * @returns {object} Format-v2 template spec.
 */
function createV2FixtureTemplate({ id = V2_FIXTURE_ID, loreRoot = true } = {}) {
  return {
    formatVersion: 2,
    id,
    name: 'Publishing V2 Fixture',
    description: 'Format-v2 publishing fixture.',
    inputs: [
      { id: 'premise', label: 'Premise', shape: 'text', required: true },
      { id: 'lore', label: 'Lore', shape: 'files', required: true }
    ],
    agents: [
      {
        key: 'worker',
        idPattern: `${id}-worker`,
        name: 'Worker',
        role: 'worker',
        prompt: [
          { kind: 'text', text: 'You work.' },
          { kind: 'input', inputId: 'premise' }
        ],
        toolProfile: { tools: ['read_file'] },
        privileged: false
      }
    ],
    placements: [
      loreRoot
        ? { inputId: 'lore', target: 'realm', root: 'lore/' }
        : { inputId: 'lore', target: 'realm', path: 'lore/index.md' }
    ]
  };
}

/**
 * Returns a copy of a format-v2 fixture whose first agent prompt starts with
 * one bundle file part.
 *
 * @param {object} template - Format-v2 template fixture.
 * @param {string} [path] - Bundle path of the file part.
 * @returns {object} Template copy referencing the bundle file.
 */
function withV2FilePart(template, path = 'prompts/part.md') {
  return {
    ...template,
    agents: template.agents.map((agent, index) => (
      index === 0 ? { ...agent, prompt: [{ kind: 'file', path }, ...agent.prompt] } : agent
    ))
  };
}

/**
 * Asserts a synchronous call throws a coded error.
 *
 * @param {Function} fn - Call under test.
 * @param {string} code - Expected `err.code`.
 * @param {RegExp} [pattern] - Optional message pattern.
 * @returns {Error} The thrown error.
 */
function expectThrow(fn, code, pattern) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `expected a throw with code ${code}`);
  assert.equal(thrown.code, code, `expected code ${code} (got ${thrown.code}: ${thrown.message})`);
  if (pattern) assert.match(thrown.message, pattern);
  return thrown;
}

/**
 * Builds a dispatcher bound to a store's publishing port, the real runtime
 * substrates, and the given caller.
 *
 * @param {object} store - Fixture store.
 * @param {object} runtime - Fixture runtime.
 * @param {string} agentId - Bound caller agent id.
 * @param {object} [options] - Extra bound context keys.
 * @returns {Function} Tool dispatcher.
 */
function createPublishingDispatcher(store, runtime, agentId, options = {}) {
  return createSandboxToolDispatcher({
    agentId,
    callerAgentId: agentId,
    identityPort: runtime.createAgentIdentityPort(),
    virtualFs: runtime.virtualFs,
    realmPublishingPort: store.getRealmPublishingPort(),
    ...options
  });
}

/**
 * Imports a fixture template through the real store import path.
 *
 * @param {object} store - Fixture store.
 * @param {object} template - Template spec.
 * @returns {object} Import receipt.
 */
function importFixture(store, template) {
  return store.importRealmTemplate(serializeTemplateBundle({ template, files: {} }));
}

/**
 * Launches a fixture template and returns its worker agent ids.
 *
 * @param {object} store - Fixture store.
 * @param {string} templateId - Template id.
 * @param {object} [options] - Launch options.
 * @returns {Promise<object>} Launch receipt.
 */
function launchFixture(store, templateId = FIXTURE_ID, options = {}) {
  return store.launchRealmFromTemplate(templateId, options);
}

// ============================================================================
// 1. Catalog authorities
// ============================================================================

test('1. AGENT_AUTHORITIES and KNOWN_AGENT_AUTHORITIES freeze the v1 vocabulary', () => {
  assert.deepEqual(KNOWN_AGENT_AUTHORITIES, ['@template:authority', '@hydration:authority']);
  assert.equal(AGENT_AUTHORITIES.TEMPLATE, '@template:authority');
  assert.equal(AGENT_AUTHORITIES.HYDRATION, '@hydration:authority');
  assert.ok(Object.isFrozen(AGENT_AUTHORITIES));
  assert.ok(Object.isFrozen(KNOWN_AGENT_AUTHORITIES));
});

test('2. authorities validation: closed shape, duplicates and non-strings rejected, unknown accepted', () => {
  const template = createFixtureTemplate();
  const parsed = parseTemplateBundle(serializeTemplateBundle({ template, files: {} }));
  assert.deepEqual(parsed.template.agents[0].authorities, [AGENT_AUTHORITIES.TEMPLATE]);
  assert.deepEqual(parsed.template.agents[1].authorities, [AGENT_AUTHORITIES.HYDRATION]);

  // Unknown identifiers are ACCEPTED by validation (launch fails closed later).
  const unknown = createFixtureTemplate({ id: 'up-unknown-authority' });
  unknown.agents[0].authorities = ['@future:authority'];
  const parsedUnknown = parseTemplateBundle(serializeTemplateBundle({ template: unknown, files: {} }));
  assert.deepEqual(parsedUnknown.template.agents[0].authorities, ['@future:authority']);

  // Duplicates are rejected with a typed catalog error.
  const duplicates = createFixtureTemplate({ id: 'up-dupes' });
  duplicates.agents[0].authorities = [AGENT_AUTHORITIES.TEMPLATE, AGENT_AUTHORITIES.TEMPLATE];
  const dupErr = expectThrow(
    () => parseTemplateBundle(serializeTemplateBundle({ template: duplicates, files: {} })),
    'ERR_TEMPLATE_INVALID',
    /duplicate authority/
  );
  assert.ok(dupErr instanceof RealmCatalogError);

  const nonArray = createFixtureTemplate({ id: 'up-non-array' });
  nonArray.agents[0].authorities = '@template:authority';
  expectThrow(
    () => parseTemplateBundle(serializeTemplateBundle({ template: nonArray, files: {} })),
    'ERR_TEMPLATE_INVALID',
    /must be an array/
  );
  const emptyEntry = createFixtureTemplate({ id: 'up-empty-entry' });
  emptyEntry.agents[0].authorities = ['  '];
  expectThrow(
    () => parseTemplateBundle(serializeTemplateBundle({ template: emptyEntry, files: {} })),
    'ERR_TEMPLATE_INVALID',
    /non-empty string/
  );

  // A singular typo stays a closed-shape rejection.
  const typo = createFixtureTemplate({ id: 'up-typo' });
  typo.agents[0].authority = [AGENT_AUTHORITIES.TEMPLATE];
  expectThrow(
    () => parseTemplateBundle(serializeTemplateBundle({ template: typo, files: {} })),
    'ERR_TEMPLATE_INVALID',
    /unknown field 'authority'/
  );
});

test('3. materializeTemplate carries declarations onto the plan and templateUnsupportedAuthorities reports unknown ids', () => {
  const parsed = parseTemplateBundle(serializeTemplateBundle({ template: createFixtureTemplate(), files: {} }));
  assert.deepEqual(templateUnsupportedAuthorities(parsed.template), []);
  assert.deepEqual(templateUnsupportedAuthorities(null), []);

  const unknown = createFixtureTemplate({ id: 'up-unsupported' });
  unknown.agents[0].authorities = ['@future:authority', AGENT_AUTHORITIES.TEMPLATE];
  unknown.agents[1].authorities = ['@future:authority'];
  assert.deepEqual(
    templateUnsupportedAuthorities(unknown),
    ['@future:authority'],
    'declared-but-unknown ids are reported once, in declaration order'
  );

  const built = materializeTemplate(parsed.template, { realmId: 'up-plan-realm' });
  assert.deepEqual(built.agents[0].authorities, [AGENT_AUTHORITIES.TEMPLATE]);
  assert.deepEqual(built.agents[1].authorities, [AGENT_AUTHORITIES.HYDRATION]);
  assert.ok(Object.isFrozen(built.agents[0].authorities));

  // A spec without declarations materializes an empty frozen list.
  const plain = createFixtureTemplate({ id: 'up-no-declarations', authorities: {} });
  const builtPlain = materializeTemplate(plain, { realmId: 'up-plan-realm-2' });
  assert.deepEqual(builtPlain.agents.map((agent) => agent.authorities), [[], []]);
});

test('4. the canonical templateVersion hash covers the authorities field', () => {
  const base = createFixtureTemplate({ id: 'up-hash-base', authorities: {} });
  const declared = createFixtureTemplate({ id: 'up-hash-base', authorities: {} });
  declared.agents[0] = { ...declared.agents[0], authorities: [AGENT_AUTHORITIES.TEMPLATE] };
  const vBase = templateBundleVersion({ template: base, files: {} });
  const vDeclared = templateBundleVersion({ template: declared, files: {} });
  assert.notEqual(vBase, vDeclared, 'declaring an authority changes the content version');

  const other = createFixtureTemplate({ id: 'up-hash-base', authorities: {} });
  other.agents[0] = { ...other.agents[0], authorities: [AGENT_AUTHORITIES.HYDRATION] };
  assert.notEqual(vDeclared, templateBundleVersion({ template: other, files: {} }), 'every authority id is hashed');
});

// ============================================================================
// 2. Tool surface and schema exposure
// ============================================================================

test('5. publishing tools stay outside the canonical taxonomy and never wildcard-expose schemas', () => {
  assert.deepEqual(
    Object.keys(PUBLISHING_TOOL_REGISTRY).sort(),
    [PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE]
  );
  assert.equal(ALL_TOOL_DESCRIPTORS.length, 35, 'the canonical taxonomy stays 35 descriptors');
  assert.equal(Object.keys(TOOL_REGISTRY).length, 35, 'the canonical registry stays 35 entries');
  assert.equal(TOOL_REGISTRY[PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE], undefined);
  assert.equal(TOOL_REGISTRY[PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE], undefined);

  const allSchemas = getSandboxToolsSchema('all');
  assert.ok(
    allSchemas.every((def) => !Object.values(PUBLISHING_TOOLS).includes(def.function.name)),
    'wildcard schema generation never emits publishing tools'
  );
  assert.deepEqual(getPublishingToolSchemas(['*']), [], 'the wildcard is not an authority');
  assert.deepEqual(
    getPublishingToolSchemas([AGENT_AUTHORITIES.TEMPLATE]).map((def) => def.function.name),
    [PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE]
  );
  assert.deepEqual(
    getPublishingToolSchemas([AGENT_AUTHORITIES.HYDRATION]).map((def) => def.function.name),
    [PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE]
  );
  assert.deepEqual(
    getPublishingToolSchemas(KNOWN_AGENT_AUTHORITIES).map((def) => def.function.name).sort(),
    [PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE]
  );
});

test('6. publishing descriptor schemas are closed Draft-07 with type-declared properties', () => {
  for (const descriptor of Object.values(PUBLISHING_TOOL_REGISTRY)) {
    assert.equal(descriptor.schema.type, 'object');
    assert.equal(descriptor.schema.additionalProperties, false);
    for (const [name, property] of Object.entries(descriptor.schema.properties)) {
      assert.equal(typeof property.type, 'string', `${descriptor.name}.${name} declares a type`);
      assert.equal(typeof property.description, 'string');
    }
    assert.ok(Array.isArray(descriptor.schema.oneOf), `${descriptor.name} enforces the exactly-one manifest form`);
    assert.deepEqual(
      descriptor.schema.oneOf.map((branch) => branch.required[0]).sort(),
      ['manifest', 'manifest_file']
    );
    assert.ok(Object.isFrozen(descriptor.schema));
    assert.ok(
      descriptor.authority === AGENT_AUTHORITIES.TEMPLATE || descriptor.authority === AGENT_AUTHORITIES.HYDRATION
    );
  }
});

// ============================================================================
// 3. Authorization matrix
// ============================================================================

test('7. authorization matrix: declared default-deny, grant allowed, revoke denied, cross-authority denied', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const launched = await launchFixture(store);
  const architect = launched.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const identityPort = runtime.createAgentIdentityPort();
  assert.ok(architect, 'the fixture agent launched');

  const dispatcher = createPublishingDispatcher(store, runtime, architect.id);
  const callImport = () => dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-denied' }), files: {} }
  });

  const before = await callImport();
  assert.equal(before.success, false);
  assert.equal(before.code, 'PERMISSION_DENIED');

  await store.grantTemplateAuthority(architect.id);
  const grantedIdentity = identityPort.getAgentIdentity(architect.id, { realmId: launched.realm.id });
  assert.ok(
    [...grantedIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE),
    'the grant is rebuilt into the descriptor allow set'
  );
  const afterGrant = await callImport();
  assert.equal(afterGrant.success, true, JSON.stringify(afterGrant));
  assert.equal(afterGrant.tool, PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE);
  assert.equal(afterGrant.imported, true);
  assert.equal(afterGrant.dryRun, false);

  // The hydration tool is a different authority: still denied for the architect.
  const crossTool = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: FIXTURE_ID, inputs: {}, files: [] }
  });
  assert.equal(crossTool.success, false);
  assert.equal(crossTool.code, 'PERMISSION_DENIED');

  await store.revokeTemplateAuthority(architect.id);
  const afterRevoke = await callImport();
  assert.equal(afterRevoke.success, false);
  assert.equal(afterRevoke.code, 'PERMISSION_DENIED');

  // The engine-composed root director holds both authorities.
  const director = await runtime.ensureDirector();
  const directorDispatcher = createPublishingDispatcher(store, runtime, director.id);
  const directorImport = await directorDispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-director' }), files: {} }
  });
  assert.equal(directorImport.success, true, JSON.stringify(directorImport));
  const directorIdentity = identityPort.getAgentIdentity(director.id, { realmId: null });
  assert.ok([...directorIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION));
});

test('8. anonymous, legacy-privileged, and per-call port claims all fail closed', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const identityPort = runtime.createAgentIdentityPort();

  const anonymous = createSandboxToolDispatcher({
    agentId: 'up-anonymous',
    identityPort,
    realmPublishingPort: store.getRealmPublishingPort()
  });
  const anonReceipt = await anonymous.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-anon' }), files: {} }
  });
  assert.equal(anonReceipt.success, false);
  assert.equal(anonReceipt.code, 'PERMISSION_DENIED');

  // Legacy privilege flags and wildcard allowlists never satisfy a publishing
  // authority (descriptor-less caller).
  const legacy = createSandboxToolDispatcher({
    agentId: 'up-anonymous',
    isAdmin: true,
    privileged: true,
    allowedTools: ['*'],
    realmPublishingPort: store.getRealmPublishingPort()
  });
  const legacyReceipt = await legacy.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-legacy' }), files: {} }
  });
  assert.equal(legacyReceipt.success, false);
  assert.equal(legacyReceipt.code, 'PERMISSION_DENIED');

  // Per-call context cannot substitute the trusted bound port (pinned key): a
  // dispatcher without a bound port stays fail-closed even when the call tries
  // to inject one. The director holds the authority, so the only missing piece
  // is the trusted port binding.
  const director = await runtime.ensureDirector();
  const portless = createSandboxToolDispatcher({
    agentId: director.id,
    identityPort,
    virtualFs: runtime.virtualFs
  });
  const substituted = await portless.executeTool(
    PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
    { manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-sub' }), files: {} } },
    { realmPublishingPort: store.getRealmPublishingPort() }
  );
  assert.equal(substituted.success, false);
  assert.equal(substituted.code, 'EXECUTION_FAILED');
  assert.match(substituted.error, /realmPublishingPort service is not available/);
});

// ============================================================================
// 4. Import pipeline
// ============================================================================

test('9. preview runs the identical pipeline with zero side effects and no import', () => {
  const { store } = createFixtureStore();
  const receipt = store.importRealmTemplate(serializeTemplateBundle({ template: createFixtureTemplate(), files: {} }));
  assert.equal(receipt.templateId, FIXTURE_ID);
  assert.equal(receipt.source, 'imported');
  assert.ok(receipt.templateVersion.startsWith('sha256:'));

  const beforeCatalog = store.listRealmTemplates().map((template) => template.id);
  const beforeImports = JSON.stringify(store.serialize().importedRealmTemplates ?? []);
  const preview = store.previewRealmTemplateImport(
    serializeTemplateBundle({ template: createFixtureTemplate({ id: 'up-preview' }), files: {} })
  );
  assert.equal(preview.dryRun, true);
  assert.equal(preview.templateId, 'up-preview');
  assert.equal(store.getRealmTemplateBundle('up-preview'), null, 'a preview never imports');
  assert.deepEqual(store.listRealmTemplates().map((template) => template.id), beforeCatalog);
  assert.equal(JSON.stringify(store.serialize().importedRealmTemplates ?? []), beforeImports);
});

test('10. import manifest compliance: exactly one form, closed envelope, typed catalog failures', async () => {
  const { runtime, store } = createFixtureStore();
  const director = await runtime.ensureDirector();
  const identityPort = runtime.createAgentIdentityPort();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);

  for (const args of [{}, { manifest: {}, manifest_file: '/x.json' }]) {
    const receipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, args);
    assert.equal(receipt.success, false, JSON.stringify(receipt));
    assert.equal(receipt.code, 'INVALID_ARGUMENTS');
    assert.match(receipt.error, /exactly one of manifest or manifest_file/);
  }

  const unknownField = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-unknown-field' }), files: {}, extra: true }
  });
  assert.equal(unknownField.success, false);
  assert.equal(unknownField.code, 'INVALID_ARGUMENTS');
  assert.match(unknownField.error, /unknown field 'extra'/);

  const invalidTemplate = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 1,
      template: { formatVersion: 1, id: 'up-broken', name: '', description: '', agents: [] },
      files: {}
    }
  });
  assert.equal(invalidTemplate.success, false);
  assert.equal(invalidTemplate.code, 'INVALID_ARGUMENTS');
  assert.ok(
    invalidTemplate.details.upstreamCode === 'ERR_TEMPLATE_INVALID'
      || invalidTemplate.details.upstreamCode === 'ERR_BUNDLE_FORMAT'
  );

  const missingSource = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 1,
      template: createFixtureTemplate({ id: 'up-missing-source' }),
      files: { 'prompts/x.md': { sourceFile: '/up/does-not-exist.md' } }
    }
  });
  assert.equal(missingSource.success, false);
  assert.equal(missingSource.code, 'INVALID_ARGUMENTS');
  assert.equal(missingSource.details.upstreamCode, 'FILE_NOT_FOUND');
  assert.equal(store.getRealmTemplateBundle('up-missing-source'), null);
});

test('10b. import accepts authored transport of either format; other versions fail typed', async () => {
  const { runtime, store, vfs } = createFixtureStore();
  const director = await runtime.ensureDirector();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);
  const principal = runtime.getOperatorPrincipal();

  // Format v1: accepted, normalized through the read shim, warning reported.
  const v1Receipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: createFixtureTemplate({ id: 'up-envelope-v1' }), files: {} }
  });
  assert.equal(v1Receipt.success, true, JSON.stringify(v1Receipt));
  assert.equal(v1Receipt.sourceFormatVersion, 1);
  assert.equal(v1Receipt.dryRun, false);
  assert.ok(
    v1Receipt.warnings.some((warning) => /legacy format v1/.test(warning)),
    'the v1 shim reports its normalization warning'
  );

  // Format v2: accepted with a { sourceFile } bundle reference resolved inline.
  const v2Files = { 'prompts/part.md': 'V2 part body.' };
  const v2Template = withV2FilePart(createV2FixtureTemplate({ id: 'up-envelope-v2' }));
  const v2Version = templateBundleVersion({ template: v2Template, files: v2Files });
  vfs.writeFile('/global/up-v2-part.md', v2Files['prompts/part.md'], {
    workspaceId: 'global',
    callerAgentId: director.id,
    principal
  });

  const beforeCatalog = store.listRealmTemplates().map((template) => template.id).join(',');
  const beforeImports = JSON.stringify(store.serialize().importedRealmTemplates ?? []);
  const dry = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 2,
      template: v2Template,
      files: { 'prompts/part.md': { sourceFile: '/global/up-v2-part.md' } }
    },
    dry_run: true
  });
  assert.equal(dry.success, true, JSON.stringify(dry));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.imported, false);
  assert.equal(dry.sourceFormatVersion, 2);
  assert.equal(dry.templateVersion, v2Version, 'the authored-form v2 version pins the import');
  assert.equal(dry.fileCount, 1, 'the referenced bundle file was resolved host-side');
  assert.equal(store.getRealmTemplateBundle('up-envelope-v2'), null, 'dry_run imports nothing');
  assert.equal(store.listRealmTemplates().map((template) => template.id).join(','), beforeCatalog);
  assert.equal(JSON.stringify(store.serialize().importedRealmTemplates ?? []), beforeImports);

  const real = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 2,
      template: v2Template,
      files: { 'prompts/part.md': { sourceFile: '/global/up-v2-part.md' } }
    }
  });
  assert.equal(real.success, true, JSON.stringify(real));
  assert.equal(real.imported, true);
  assert.equal(real.templateVersion, dry.templateVersion, 'dry run and real import agree on the version');
  const served = store.getRealmTemplateBundle('up-envelope-v2');
  assert.ok(served, 'the v2 import is registered');
  assert.equal(served.template.formatVersion, 2, 'the normalized catalog view is format v2');
  assert.equal(served.files['prompts/part.md'], v2Files['prompts/part.md']);
  const reimported = store.importRealmTemplate(store.exportRealmTemplate('up-envelope-v2'));
  assert.equal(reimported.templateVersion, v2Version, 'the canonical export round-trips to the same version');

  // Every other envelope version fails typed before any import.
  for (const formatVersion of [3, undefined, '1', true]) {
    const templateId = `up-envelope-${formatVersion === undefined ? 'absent' : String(formatVersion)}`;
    const manifest = { template: createFixtureTemplate({ id: templateId }), files: {} };
    if (formatVersion !== undefined) manifest.formatVersion = formatVersion;

    const before = store.listRealmTemplates().map((template) => template.id).join(',');
    const receipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, { manifest });
    assert.equal(receipt.success, false, JSON.stringify({ formatVersion, receipt }));
    assert.equal(receipt.code, 'INVALID_ARGUMENTS', JSON.stringify({ formatVersion, receipt }));
    assert.equal(receipt.details.upstreamCode, 'ERR_BUNDLE_FORMAT', JSON.stringify({ formatVersion, receipt }));
    assert.match(receipt.error, /formatVersion must be 1 or 2/);
    assert.equal(store.getRealmTemplateBundle(templateId), null, 'no bundle may be imported');
    assert.equal(store.listRealmTemplates().map((template) => template.id).join(','), before);
  }
});

test('10c. format-v2 import validates through the real catalog parser and resolves references host-side', async () => {
  const { runtime, store } = createFixtureStore();
  const director = await runtime.ensureDirector();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);

  // Envelope/template format mismatches fail typed before any import.
  for (const [formatVersion, template] of [
    [2, createFixtureTemplate({ id: 'up-v2-mismatch-v1' })],
    [1, createV2FixtureTemplate({ id: 'up-v2-mismatch-v2' })]
  ]) {
    const receipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
      manifest: { formatVersion, template, files: {} }
    });
    assert.equal(receipt.success, false, JSON.stringify(receipt));
    assert.equal(receipt.details.upstreamCode, 'ERR_BUNDLE_FORMAT', JSON.stringify(receipt));
    assert.match(receipt.error, /does not match the template formatVersion/);
    assert.equal(store.getRealmTemplateBundle(template.id), null);
  }

  // Totality: an unreferenced v2 input fails with the catalog's own message.
  const orphan = createV2FixtureTemplate({ id: 'up-v2-orphan' });
  orphan.inputs.push({ id: 'orphan', label: 'Orphan', shape: 'text' });
  const orphanReceipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 2, template: orphan, files: {} }
  });
  assert.equal(orphanReceipt.success, false);
  assert.equal(orphanReceipt.code, 'INVALID_ARGUMENTS');
  assert.equal(orphanReceipt.details.upstreamCode, 'ERR_TEMPLATE_INVALID');
  assert.match(orphanReceipt.error, /never referenced/);

  // A missing sourceFile reference fails closed with the VFS code, no import.
  const missing = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 2,
      template: withV2FilePart(createV2FixtureTemplate({ id: 'up-v2-missing-source' })),
      files: { 'prompts/part.md': { sourceFile: '/up/does-not-exist.md' } }
    }
  });
  assert.equal(missing.success, false);
  assert.equal(missing.details.upstreamCode, 'FILE_NOT_FOUND');
  assert.equal(store.getRealmTemplateBundle('up-v2-missing-source'), null);

  // Caps apply to v2 transport exactly like v1.
  const oversize = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 2,
      template: createV2FixtureTemplate({ id: 'up-v2-oversize-file' }),
      files: { 'files/huge.md': 'y'.repeat(2 * MiB + 1) }
    }
  });
  assert.equal(oversize.success, false);
  assert.equal(oversize.code, 'INVALID_ARGUMENTS');
  assert.match(oversize.error, /per-file publishing cap/);

  const bundleTotal = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 2,
      template: createV2FixtureTemplate({ id: 'up-v2-oversize-bundle' }),
      files: {
        'files/a.md': 'a'.repeat(1600 * 1024),
        'files/b.md': 'b'.repeat(1600 * 1024)
      }
    }
  });
  assert.equal(bundleTotal.success, false);
  assert.equal(bundleTotal.code, 'INVALID_ARGUMENTS');
  assert.match(bundleTotal.error, /bundle-total cap/);
  assert.equal(store.getRealmTemplateBundle('up-v2-oversize-bundle'), null);
});

test('11. file-sourced manifests resolve through the caller view; caps fail typed without partial import', async () => {
  const { runtime, store, vfs } = createFixtureStore();
  const director = await runtime.ensureDirector();
  const identityPort = runtime.createAgentIdentityPort();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);
  const principal = runtime.getOperatorPrincipal();

  const transport = serializeTemplateBundle({ template: createFixtureTemplate({ id: 'up-file-import' }), files: {} });
  vfs.writeFile('/global/up-template.json', transport, {
    workspaceId: 'global',
    callerAgentId: director.id,
    principal
  });

  const beforeCatalog = store.listRealmTemplates().map((template) => template.id).join(',');
  const beforeImports = JSON.stringify(store.serialize().importedRealmTemplates ?? []);
  const dry = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest_file: '/global/up-template.json',
    dry_run: true
  });
  assert.equal(dry.success, true, JSON.stringify(dry));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.imported, false);
  assert.equal(dry.manifestSource, 'file');
  assert.equal(store.listRealmTemplates().map((template) => template.id).join(','), beforeCatalog);
  assert.equal(JSON.stringify(store.serialize().importedRealmTemplates ?? []), beforeImports);

  const real = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest_file: '/global/up-template.json'
  });
  assert.equal(real.success, true, JSON.stringify(real));
  assert.equal(real.dryRun, false);
  assert.equal(real.templateId, 'up-file-import');
  assert.ok(store.getRealmTemplateBundle('up-file-import'));

  // Per-file cap: a 2 MiB + 1 inline file value fails typed.
  const oversizedReceipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 1,
      template: createFixtureTemplate({ id: 'up-oversize-file' }),
      files: { 'files/huge.md': 'y'.repeat(2 * MiB + 1) }
    }
  });
  assert.equal(oversizedReceipt.success, false);
  assert.equal(oversizedReceipt.code, 'INVALID_ARGUMENTS');
  assert.match(oversizedReceipt.error, /per-file publishing cap/);

  // Bundle-total cap: two ~1.6 MiB files cross the 3 MiB ceiling.
  const bundleTotal = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {
      formatVersion: 1,
      template: createFixtureTemplate({ id: 'up-oversize-bundle' }),
      files: {
        'files/a.md': 'a'.repeat(1600 * 1024),
        'files/b.md': 'b'.repeat(1600 * 1024)
      }
    }
  });
  assert.equal(bundleTotal.success, false);
  assert.equal(bundleTotal.code, 'INVALID_ARGUMENTS');
  assert.match(bundleTotal.error, /bundle-total cap/);
  assert.equal(store.getRealmTemplateBundle('up-oversize-bundle'), null, 'no partial import survives cap failures');
});

test('12. preview and real import agree on store-level caps (no dry-run drift)', async () => {
  const { runtime, store } = createFixtureStore();
  const director = await runtime.ensureDirector();
  const identityPort = runtime.createAgentIdentityPort();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);

  // A canonical transport above the store per-bundle cap (2 MiB) but below the
  // publishing bundle cap (3 MiB): the preview and the real call must fail with
  // the same typed store code.
  const bigTemplate = createFixtureTemplate({ id: 'up-store-cap' });
  bigTemplate.description = 'z'.repeat(2 * MiB + 64 * 1024);
  const dry = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: bigTemplate, files: {} },
    dry_run: true
  });
  const real = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: bigTemplate, files: {} }
  });
  assert.equal(dry.success, false);
  assert.equal(real.success, false);
  assert.equal(dry.code, real.code);
  assert.equal(dry.details.upstreamCode, 'ERR_STORE_TEMPLATE_TOO_LARGE');
  assert.equal(real.details.upstreamCode, 'ERR_STORE_TEMPLATE_TOO_LARGE');
  assert.equal(store.getRealmTemplateBundle('up-store-cap'), null);
});

test('13. source references resolve under the caller private view (no cross-caller reads)', async () => {
  const { runtime, store, vfs } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const launched = await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [
      { agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE },
      { agentKey: 'genesis', authority: AGENT_AUTHORITIES.HYDRATION }
    ]
  });
  const architect = launched.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const genesis = launched.agents.find((agent) => agent.id === `${FIXTURE_ID}-genesis`);
  const identityPort = runtime.createAgentIdentityPort();

  // A file in the architect's private workspace is visible to the architect
  // as a bare `/private.md` reference and invisible to the genesis caller.
  vfs.writeFile('/private.md', 'architect private bytes', {
    workspaceId: architect.id,
    callerAgentId: architect.id,
    principal: runtime.getOperatorPrincipal()
  });
  await store.grantHydrationAuthority(architect.id);

  const architectDispatcher = createPublishingDispatcher(store, runtime, architect.id);
  const architectSubmit = await architectDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: { sourceFile: '/private.md' } },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'ok' }]
    }
  });
  assert.equal(architectSubmit.success, true, JSON.stringify(architectSubmit));
  assert.equal(
    store.getPendingInstancePayload(FIXTURE_ID).payload.inputs.premise,
    'architect private bytes',
    'the caller view resolves the bare path in the caller private workspace'
  );

  const genesisDispatcher = createPublishingDispatcher(store, runtime, genesis.id);
  const genesisSubmit = await genesisDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: { sourceFile: '/private.md' } },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'ok' }]
    }
  });
  assert.equal(genesisSubmit.success, false, JSON.stringify(genesisSubmit));
  assert.equal(genesisSubmit.details.upstreamCode, 'FILE_NOT_FOUND');
});

// ============================================================================
// 5. Submission pipeline and candidate store
// ============================================================================

test('14. submit builds the canonical package, stores a session candidate, and dry_run stores nothing', async () => {
  const { runtime, store, vfs } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const director = await runtime.ensureDirector();
  const identityPort = runtime.createAgentIdentityPort();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);
  const principal = runtime.getOperatorPrincipal();

  vfs.writeFile('/global/world.md', '# World from a file', {
    workspaceId: 'global',
    callerAgentId: director.id,
    principal
  });
  const effectiveVersion = templateBundleVersion({ template: createFixtureTemplate(), files: {} });

  const real = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: { sourceFile: '/global/world.md' } },
      files: [{ path: 'lore/world.md', target: 'realm', sourceFile: '/global/world.md' }]
    }
  });
  assert.equal(real.success, true, JSON.stringify(real));
  assert.equal(real.stored, true);
  assert.equal(real.dryRun, false);
  assert.equal(real.templateVersion, effectiveVersion);
  assert.deepEqual(real.inputIds, ['premise']);

  const candidate = store.getPendingInstancePayload(FIXTURE_ID);
  assert.ok(candidate, 'the candidate is stored');
  assert.equal(candidate.templateId, FIXTURE_ID);
  assert.equal(candidate.templateVersion, effectiveVersion);
  assert.equal(candidate.payload.files[0].content, '# World from a file');
  assert.equal(candidate.payload.inputs.premise, '# World from a file');
  assert.ok(typeof candidate.resolvedAt === 'string' && candidate.resolvedAt.length > 0);
  assert.ok(Object.isFrozen(candidate));

  const dry = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: 'dry premise' },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'dry content' }]
    },
    dry_run: true
  });
  assert.equal(dry.success, true, JSON.stringify(dry));
  assert.equal(dry.stored, false);
  assert.equal(dry.dryRun, true);
  assert.equal(
    store.getPendingInstancePayload(FIXTURE_ID).payload.files[0].content,
    '# World from a file',
    'dry_run never replaces the stored candidate'
  );

  assert.deepEqual(store.listPendingInstancePayloads().map((entry) => entry.templateId), [FIXTURE_ID]);
  assert.equal(store.clearPendingInstancePayload(FIXTURE_ID), true);
  assert.equal(store.getPendingInstancePayload(FIXTURE_ID), null);
  assert.equal(store.clearPendingInstancePayload(FIXTURE_ID), false);
  assert.equal(store.clearPendingInstancePayload(''), false);
});

test('15. submission fails closed on version mismatch, missing slots, unknown templates, and caps', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const director = await runtime.ensureDirector();
  const identityPort = runtime.createAgentIdentityPort();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);

  const stale = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      templateVersion: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      inputs: { premise: 'x' },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'y' }]
    }
  });
  assert.equal(stale.success, false);
  assert.equal(stale.code, 'INVALID_ARGUMENTS');
  assert.equal(stale.details.upstreamCode, 'ERR_HYDRATION_VERSION_MISMATCH');

  // A generated slot is required: a dedicated generated-slot template fails
  // closed when the slot is missing.
  const generatedTemplate = createFixtureTemplate({ id: 'up-generated-coverage' });
  generatedTemplate.seed.files[0].origin = 'generated';
  importFixture(store, generatedTemplate);
  const missingGenerated = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: 'up-generated-coverage', inputs: { premise: 'x' }, files: [] }
  });
  assert.equal(missingGenerated.success, false);
  assert.equal(missingGenerated.details.upstreamCode, 'ERR_HYDRATION_PACKAGE');

  const unknownTemplate = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: 'up-no-such-template', inputs: {}, files: [] }
  });
  assert.equal(unknownTemplate.success, false);
  assert.equal(unknownTemplate.code, 'INVALID_ARGUMENTS');
  assert.equal(unknownTemplate.details.reason, 'unknown_template');

  const bothContentForms = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: 'x' },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'a', sourceFile: '/x.md' }]
    }
  });
  assert.equal(bothContentForms.success, false);
  assert.match(bothContentForms.error, /exactly one of content or sourceFile/);

  const noContentForm = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: FIXTURE_ID, inputs: { premise: 'x' }, files: [{ path: 'lore/world.md', target: 'realm' }] }
  });
  assert.equal(noContentForm.success, false);
  assert.match(noContentForm.error, /exactly one of content or sourceFile/);

  assert.equal(store.getPendingInstancePayload(FIXTURE_ID), null, 'no rejected submission stores a candidate');

  const bigFile = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: 'x' },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'z'.repeat(2 * MiB + 1) }]
    }
  });
  assert.equal(bigFile.success, false);
  assert.match(bigFile.error, /per-file publishing cap/);

  // Package-total cap: a five-slot fixture with 1.7 MiB per slot crosses 8 MiB.
  const totalTemplate = {
    formatVersion: 1,
    id: 'up-package-total',
    name: 'Package Total',
    description: '',
    seed: {
      files: [1, 2, 3, 4, 5].map((index) => ({
        path: `lore/part${index}.md`,
        target: 'realm',
        origin: 'generated',
        brief: 'Part.'
      }))
    },
    agents: [{
      key: 'worker',
      idPattern: 'up-package-total-worker',
      name: 'Worker',
      role: 'worker',
      prompt: [{ kind: 'text', text: 'Work.' }],
      toolProfile: { tools: [] },
      privileged: false
    }]
  };
  importFixture(store, totalTemplate);
  const totalReceipt = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: 'up-package-total',
      inputs: {},
      files: [1, 2, 3, 4, 5].map((index) => ({
        path: `lore/part${index}.md`,
        target: 'realm',
        content: 'q'.repeat(1700 * 1024)
      }))
    }
  });
  assert.equal(totalReceipt.success, false);
  assert.match(totalReceipt.error, /package-total cap/);
  assert.equal(store.getPendingInstancePayload('up-package-total'), null);
});

test('15b. format-v2 submissions resolve conveniences, store the authored payload, and carry the canonical digest', async () => {
  const { runtime, store, vfs } = createFixtureStore();
  store.importRealmTemplate(serializeTemplateBundle({ template: createV2FixtureTemplate(), files: {} }));
  const director = await runtime.ensureDirector();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);
  const principal = runtime.getOperatorPrincipal();
  const effectiveVersion = templateBundleVersion({ template: createV2FixtureTemplate(), files: {} });

  vfs.writeFile('/global/up-premise.md', 'The harbor keeps one lamp lit.', {
    workspaceId: 'global',
    callerAgentId: director.id,
    principal
  });
  vfs.writeFile('/global/up-lore-b.md', 'The keeper never asks the water why.', {
    workspaceId: 'global',
    callerAgentId: director.id,
    principal
  });

  const manifest = {
    formatVersion: 2,
    templateId: V2_FIXTURE_ID,
    inputs: {
      premise: { sourceFile: '/global/up-premise.md' },
      lore: {
        files: [
          { path: 'a.md', content: 'Lore A.' },
          { path: 'b.md', sourceFile: '/global/up-lore-b.md' }
        ]
      }
    }
  };

  const dry = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest,
    dry_run: true
  });
  assert.equal(dry.success, true, JSON.stringify(dry));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.stored, false);
  assert.equal(dry.sourceFormatVersion, 2);
  assert.equal(dry.templateVersion, effectiveVersion, 'an omitted pin is injected from the effective template');
  assert.match(dry.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(dry.inputIds, ['premise', 'lore'], 'the authored payload ids are reported in manifest order');
  assert.deepEqual(
    dry.fileEntries,
    [
      { path: 'lore/a.md', target: 'realm' },
      { path: 'lore/b.md', target: 'realm' }
    ],
    'the root placement resolves each fileset destination'
  );
  assert.equal(store.getPendingInstancePayload(V2_FIXTURE_ID), null, 'dry_run stores nothing');

  const real = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, { manifest });
  assert.equal(real.success, true, JSON.stringify(real));
  assert.equal(real.stored, true);
  assert.equal(real.payloadDigest, dry.payloadDigest, 'dry run and real submission agree on the digest');

  const candidate = store.getPendingInstancePayload(V2_FIXTURE_ID);
  assert.ok(candidate, 'the candidate is stored');
  assert.equal(candidate.payload.formatVersion, 2);
  assert.equal(candidate.payload.templateVersion, effectiveVersion);
  assert.deepEqual(candidate.payload.inputs.premise, { text: 'The harbor keeps one lamp lit.' });
  assert.deepEqual(candidate.payload.inputs.lore.files, [
    { path: 'a.md', content: 'Lore A.' },
    { path: 'b.md', content: 'The keeper never asks the water why.' }
  ]);
  assert.equal(
    JSON.stringify(candidate.payload).includes('sourceFile'),
    false,
    'every reference resolved to inline content before validation; none reaches the stored payload'
  );
  assert.equal(payloadDigest(candidate.payload), real.payloadDigest, 'the receipt digest covers exactly the stored authored payload');

  // The same payload attached at launch produces the identical provenance digest.
  const launched = await store.launchRealmFromTemplate(V2_FIXTURE_ID, { package: candidate.payload });
  assert.equal(
    launched.realm.instance.packageDigest,
    real.payloadDigest,
    'the launch provenance packageDigest equals the submission receipt digest'
  );
  const worldA = runtime.virtualFs.getFileRecord('/lore/a.md', {
    workspaceId: `realm:${launched.realm.id}:global`,
    callerAgentId: director.id,
    principal
  });
  assert.ok(worldA, 'the root placement seeded the fileset');
  assert.equal(worldA.content, 'Lore A.');
  const worldB = runtime.virtualFs.getFileRecord('/lore/b.md', {
    workspaceId: `realm:${launched.realm.id}:global`,
    callerAgentId: director.id,
    principal
  });
  assert.ok(worldB);
  assert.equal(worldB.content, 'The keeper never asks the water why.');
});

test('15c. format-v2 submissions fail closed on pins, shapes, unknown ids, and stray files', async () => {
  const { runtime, store } = createFixtureStore();
  store.importRealmTemplate(serializeTemplateBundle({ template: createV2FixtureTemplate(), files: {} }));
  const director = await runtime.ensureDirector();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);
  const effectiveVersion = templateBundleVersion({ template: createV2FixtureTemplate(), files: {} });
  const base = () => ({
    formatVersion: 2,
    templateId: V2_FIXTURE_ID,
    templateVersion: effectiveVersion,
    inputs: {
      premise: { text: 'A premise.' },
      lore: { files: [{ path: 'a.md', content: 'Lore.' }] }
    }
  });

  const stale = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      ...base(),
      templateVersion: `sha256:${'0'.repeat(64)}`
    }
  });
  assert.equal(stale.success, false);
  assert.equal(stale.code, 'INVALID_ARGUMENTS');
  assert.equal(stale.details.upstreamCode, 'ERR_HYDRATION_VERSION_MISMATCH');

  const unknownInput = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { ...base(), inputs: { ...base().inputs, ghost: { text: 'x' } } }
  });
  assert.equal(unknownInput.success, false);
  assert.equal(unknownInput.details.upstreamCode, 'ERR_HYDRATION_PACKAGE');
  assert.match(unknownInput.error, /undeclared input 'ghost'/);

  const textAsFiles = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: {
        premise: { files: [{ path: 'a.md', content: 'x' }] },
        lore: { files: [{ path: 'a.md', content: 'Lore.' }] }
      }
    }
  });
  assert.equal(textAsFiles.success, false);
  assert.equal(textAsFiles.details.upstreamCode, 'ERR_HYDRATION_PACKAGE');

  const missingRequired = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: { premise: { text: 'A premise.' } }
    }
  });
  assert.equal(missingRequired.success, false);
  assert.equal(missingRequired.details.upstreamCode, 'ERR_HYDRATION_PACKAGE');
  assert.match(missingRequired.error, /required input 'lore'/);

  const strayFiles = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: { premise: { text: 'x' }, lore: { files: [{ path: 'a.md', content: 'y' }] } },
      files: [{ path: 'lore/a.md', target: 'realm', content: 'y' }]
    }
  });
  assert.equal(strayFiles.success, false);
  assert.equal(strayFiles.code, 'INVALID_ARGUMENTS');
  assert.match(strayFiles.error, /carries no top-level files/);

  const bothContentForms = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: {
        premise: { text: 'x' },
        lore: { files: [{ path: 'a.md', content: 'y', sourceFile: '/global/x.md' }] }
      }
    }
  });
  assert.equal(bothContentForms.success, false);
  assert.match(bothContentForms.error, /exactly one of content or sourceFile/);

  const wholeSourceOnFiles = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: {
        premise: { text: 'x' },
        lore: { sourceFile: '/global/x.md' }
      }
    }
  });
  assert.equal(wholeSourceOnFiles.success, false);
  assert.match(wholeSourceOnFiles.error, /only valid for text inputs/);

  const badVersion = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { ...base(), formatVersion: '2' }
  });
  assert.equal(badVersion.success, false);
  assert.equal(badVersion.code, 'INVALID_ARGUMENTS');
  assert.match(badVersion.error, /formatVersion must be 1 or 2/);

  const bigText = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: {
        premise: { text: 'z'.repeat(2 * MiB + 1) },
        lore: { files: [{ path: 'a.md', content: 'y' }] }
      }
    }
  });
  assert.equal(bigText.success, false);
  assert.match(bigText.error, /per-file publishing cap/);

  const bigFileset = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: V2_FIXTURE_ID,
      inputs: {
        premise: { text: 'x' },
        lore: {
          files: [1, 2, 3, 4, 5].map((index) => ({
            path: `part${index}.md`,
            content: 'q'.repeat(1700 * 1024)
          }))
        }
      }
    }
  });
  assert.equal(bigFileset.success, false);
  assert.match(bigFileset.error, /package-total cap/);
  assert.equal(store.getPendingInstancePayload(V2_FIXTURE_ID), null, 'no rejected submission stores a candidate');
});

test('15d. legacy v1 packages submit against v2 templates and v2 payloads fill v1-authored templates', async () => {
  const { runtime, store } = createFixtureStore();
  const v2PathTemplate = createV2FixtureTemplate({ id: 'up-v2-package-target', loreRoot: false });
  store.importRealmTemplate(serializeTemplateBundle({ template: v2PathTemplate, files: {} }));
  importFixture(store, createFixtureTemplate({ id: 'up-v1-payload-target' }));
  const director = await runtime.ensureDirector();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);
  const principal = runtime.getOperatorPrincipal();

  // A legacy package (absent formatVersion) validates against the v2 template
  // through the catalog's v1 conversion and stores the authored v1 package.
  const legacy = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: 'up-v2-package-target',
      inputs: { premise: 'Legacy premise.' },
      files: [{ path: 'lore/index.md', target: 'realm', content: 'Legacy lore.' }]
    }
  });
  assert.equal(legacy.success, true, JSON.stringify(legacy));
  assert.equal(legacy.sourceFormatVersion, 1);
  assert.deepEqual(legacy.fileEntries, [{ path: 'lore/index.md', target: 'realm' }]);
  const legacyCandidate = store.getPendingInstancePayload('up-v2-package-target');
  assert.ok(legacyCandidate);
  assert.equal(legacyCandidate.payload.formatVersion, 1);
  assert.equal(payloadDigest(legacyCandidate.payload), legacy.payloadDigest);
  const legacyLaunch = await store.launchRealmFromTemplate('up-v2-package-target', {
    package: legacyCandidate.payload
  });
  assert.equal(legacyLaunch.realm.instance.packageDigest, legacy.payloadDigest);
  const legacySeed = runtime.virtualFs.getFileRecord('/lore/index.md', {
    workspaceId: `realm:${legacyLaunch.realm.id}:global`,
    callerAgentId: director.id,
    principal
  });
  assert.ok(legacySeed, 'the legacy package seeded the v2 template placement');
  assert.equal(legacySeed.content, 'Legacy lore.');

  // A format-v2 payload validates against a v1-authored template through the
  // read shim: the seed slot resolves to its shimmed files input id.
  const shimmed = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      formatVersion: 2,
      templateId: 'up-v1-payload-target',
      inputs: {
        premise: { text: 'Shimmed premise.' },
        seed_0: { files: [{ path: 'lore/world.md', content: 'Shimmed lore.' }] }
      }
    }
  });
  assert.equal(shimmed.success, true, JSON.stringify(shimmed));
  assert.equal(shimmed.sourceFormatVersion, 2);
  assert.deepEqual(shimmed.inputIds, ['premise', 'seed_0']);
  assert.deepEqual(shimmed.fileEntries, [{ path: 'lore/world.md', target: 'realm' }]);
  const shimCandidate = store.getPendingInstancePayload('up-v1-payload-target');
  assert.ok(shimCandidate);
  assert.equal(shimCandidate.payload.formatVersion, 2);
  assert.equal(payloadDigest(shimCandidate.payload), shimmed.payloadDigest);
});

test('16. a stored candidate attaches through the existing launch path', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const director = await runtime.ensureDirector();
  const identityPort = runtime.createAgentIdentityPort();
  const dispatcher = createPublishingDispatcher(store, runtime, director.id);

  const submit = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: {
      templateId: FIXTURE_ID,
      inputs: { premise: 'A drowned cathedral.' },
      files: [{ path: 'lore/world.md', target: 'realm', content: 'The city sank in a night.' }]
    }
  });
  assert.equal(submit.success, true, JSON.stringify(submit));
  const candidate = store.getPendingInstancePayload(FIXTURE_ID);
  const launched = await launchFixture(store, FIXTURE_ID, { package: candidate.payload });
  assert.equal(launched.agents.length, 2);
  const worldRecord = runtime.virtualFs.getFileRecord('/lore/world.md', {
    workspaceId: `realm:${launched.realm.id}:global`,
    callerAgentId: director.id,
    principal: runtime.getOperatorPrincipal()
  });
  assert.ok(worldRecord, 'the candidate file was seeded at launch');
  assert.equal(worldRecord.content, 'The city sank in a night.');

  // The candidate stays session-only after the launch attach (review may re-attach).
  assert.ok(store.getPendingInstancePayload(FIXTURE_ID));
});

// ============================================================================
// 6. Launch approval + trust override
// ============================================================================

test('17. declared-but-unapproved requests are declined; explicit approvals grant under the operator principal', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const declined = await launchFixture(store);
  const identityPort = runtime.createAgentIdentityPort();
  assert.deepEqual(store.listMetaAuthorityGrants(), { template: [], hydration: [] });
  for (const agent of declined.agents) {
    const identity = identityPort.getAgentIdentity(agent.id, { realmId: declined.realm.id });
    assert.equal([...identity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE), false);
    assert.equal([...identity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION), false);
  }

  const approved = await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [
      { agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE },
      { agentKey: 'genesis', authority: AGENT_AUTHORITIES.HYDRATION }
    ]
  });
  const architect = approved.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const genesis = approved.agents.find((agent) => agent.id === `${FIXTURE_ID}-genesis`);
  const architectIdentity = identityPort.getAgentIdentity(architect.id, { realmId: approved.realm.id });
  const genesisIdentity = identityPort.getAgentIdentity(genesis.id, { realmId: approved.realm.id });
  assert.ok([...architectIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE));
  assert.equal([...architectIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION), false);
  assert.ok([...genesisIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION));

  const grants = store.listMetaAuthorityGrants();
  assert.equal(grants.template.length, 1);
  assert.equal(grants.hydration.length, 1);
  assert.match(grants.template[0], new RegExp(`:${FIXTURE_ID}-architect$`));
});

test('18. approvals beyond declarations and malformed options reject the launch before any side effect', async () => {
  const { store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());

  const rejected = [
    {
      options: { authorityApprovals: [{ agentKey: 'ghost', authority: AGENT_AUTHORITIES.TEMPLATE }] },
      pattern: /declares no authorities/
    },
    {
      options: { authorityApprovals: [{ agentKey: 'architect', authority: AGENT_AUTHORITIES.HYDRATION }] },
      pattern: /undeclared authority/
    },
    { options: { authorityApprovals: 'nope' }, pattern: /must be an array/ },
    { options: { trustAuthorities: 'yes' }, pattern: /must be a boolean/ }
  ];
  for (const { options, pattern } of rejected) {
    const thrown = await store.launchRealmFromTemplate(FIXTURE_ID, options).then(() => null, (err) => err);
    assert.ok(thrown, `expected rejection for ${JSON.stringify(options)}`);
    assert.equal(thrown.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
    assert.match(thrown.message, pattern);
  }
  assert.deepEqual(store.listMetaAuthorityGrants(), { template: [], hydration: [] });
});

test('19. an unknown declared authority id fails the launch closed while import still accepts it', async () => {
  const { store } = createFixtureStore();
  const template = createFixtureTemplate({ id: 'up-launch-unsupported' });
  template.agents[0].authorities = ['@future:authority'];
  importFixture(store, template);
  assert.ok(store.getRealmTemplateBundle('up-launch-unsupported'), 'import/validation accept the declaration');

  const thrown = await store
    .launchRealmFromTemplate('up-launch-unsupported')
    .then(() => null, (err) => err);
  assert.ok(thrown, 'the launch must fail closed');
  assert.equal(thrown.code, SANDBOX_STORE_ERROR_CODES.ERR_TEMPLATE_AUTHORITY_UNSUPPORTED);
  assert.match(thrown.message, /@future:authority/);
});

test('20. trust persists the exact approved set, auto-approves exact matches, and re-prompts deltas', async () => {
  const { runtime, store } = createFixtureStore();
  // v1 declares only the architect template authority.
  const v1 = createFixtureTemplate({ id: FIXTURE_ID, authorities: { architect: [AGENT_AUTHORITIES.TEMPLATE] } });
  importFixture(store, v1);
  const firstLaunch = await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [{ agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE }],
    trustAuthorities: true
  });
  assert.deepEqual(
    Object.assign({}, store.listTemplateAuthorityTrust()[FIXTURE_ID]),
    { architect: [AGENT_AUTHORITIES.TEMPLATE] }
  );

  // Exact-set auto-approval on a later launch with no explicit approvals.
  const auto = await launchFixture(store, FIXTURE_ID);
  const autoArchitect = auto.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const identityPort = runtime.createAgentIdentityPort();
  const autoIdentity = identityPort.getAgentIdentity(autoArchitect.id, { realmId: auto.realm.id });
  assert.ok(
    [...autoIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE),
    'the trusted pair auto-approves on a later launch'
  );

  // A delta (newly declared hydration authority) is NOT auto-approved.
  const v2 = createFixtureTemplate({ id: FIXTURE_ID });
  importFixture(store, v2);
  const delta = await launchFixture(store, FIXTURE_ID);
  const deltaGenesis = delta.agents.find((agent) => agent.id === `${FIXTURE_ID}-genesis`);
  const deltaGenesisIdentity = identityPort.getAgentIdentity(deltaGenesis.id, { realmId: delta.realm.id });
  assert.equal(
    [...deltaGenesisIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION),
    false,
    'a newly declared authority re-prompts: it is not auto-approved'
  );
  const deltaArchitect = delta.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const deltaArchitectIdentity = identityPort.getAgentIdentity(deltaArchitect.id, { realmId: delta.realm.id });
  assert.ok(
    [...deltaArchitectIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE),
    'the previously trusted pair still auto-approves'
  );

  // Explicitly approving the delta and trusting again records it.
  const trustedAgain = await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [{ agentKey: 'genesis', authority: AGENT_AUTHORITIES.HYDRATION }],
    trustAuthorities: true
  });
  const genesis = trustedAgain.agents.find((agent) => agent.id === `${FIXTURE_ID}-genesis`);
  const genesisIdentity = identityPort.getAgentIdentity(genesis.id, { realmId: trustedAgain.realm.id });
  assert.ok([...genesisIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION));
  assert.deepEqual(
    store.listTemplateAuthorityTrust()[FIXTURE_ID].genesis,
    [AGENT_AUTHORITIES.HYDRATION]
  );
});

test('21. clearing the trust removes the override (no auto-approval) while explicit grants stay revocable', async () => {
  const { store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [{ agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE }],
    trustAuthorities: true
  });
  assert.equal(store.clearTemplateAuthorityTrust(FIXTURE_ID), true);
  assert.equal(store.clearTemplateAuthorityTrust(FIXTURE_ID), false);
  assert.deepEqual(Object.keys(store.listTemplateAuthorityTrust()), []);

  const afterClear = await launchFixture(store, FIXTURE_ID);
  const afterArchitect = afterClear.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const canonical = `realm:${afterClear.realm.id}:${afterArchitect.id}`;
  assert.equal(
    store.listMetaAuthorityGrants().template.includes(canonical),
    false,
    'after clearing trust, launches grant nothing without fresh approvals'
  );
  // The earlier explicit grant is an ordinary registry grant and stays revocable.
  const earlier = store.listMetaAuthorityGrants().template[0];
  assert.ok(earlier, 'the earlier explicit grant survives the clear');
  const descriptor = await store.revokeTemplateAuthority(earlier);
  assert.ok(descriptor, 'the explicit grant is revocable by its canonical key');
  assert.equal(store.listMetaAuthorityGrants().template.length, 0);
});

// ============================================================================
// 7. Grant persistence and grant lifecycle
// ============================================================================

test('22. grants and trust serialize additively, hydrate back, and legacy snapshots stay unchanged', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const launched = await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [
      { agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE },
      { agentKey: 'genesis', authority: AGENT_AUTHORITIES.HYDRATION }
    ],
    trustAuthorities: true
  });
  const persisted = store.serialize();
  assert.equal(store.saveToStorage(), true);
  assert.deepEqual(persisted.metaAuthorityGrants.template.length, 1);
  assert.deepEqual(persisted.metaAuthorityGrants.hydration.length, 1);
  assert.deepEqual(persisted.templateAuthorityTrust[FIXTURE_ID].architect, [AGENT_AUTHORITIES.TEMPLATE]);
  assert.deepEqual(validateSandboxState(persisted).valid, true);

  // A fresh store over the persisted state restores the grants and the trust.
  const restored = createFixtureStore({ autoHydrate: true });
  assert.deepEqual(restored.store.listMetaAuthorityGrants(), {
    template: persisted.metaAuthorityGrants.template,
    hydration: persisted.metaAuthorityGrants.hydration
  });
  assert.deepEqual(restored.store.listTemplateAuthorityTrust(), persisted.templateAuthorityTrust);
  // The restored grants are real descriptor capability.
  const identityPort = restored.runtime.createAgentIdentityPort();
  const architectKey = persisted.metaAuthorityGrants.template[0];
  const architectId = architectKey.slice(architectKey.lastIndexOf(':') + 1);
  const realmId = launched.realm.id;
  const architectIdentity = identityPort.getAgentIdentity(architectId, { realmId });
  assert.ok(
    architectIdentity && [...architectIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE),
    'the hydrated grant rebuilds into the descriptor'
  );

  // A legacy snapshot without the fields validates and re-serializes without them.
  const legacy = { ...persisted };
  delete legacy.metaAuthorityGrants;
  delete legacy.templateAuthorityTrust;
  const validation = validateSandboxState(legacy);
  assert.equal(validation.valid, true);
  assert.equal('metaAuthorityGrants' in validation.state, false);
  assert.equal('templateAuthorityTrust' in validation.state, false);

  // Fail-closed restore: unknown/recycled refs are skipped, never minted.
  const restoredRefs = restored.runtime.restoreMetaAuthorityGrants(
    { template: ['realm:ghost:ghost'], hydration: ['recycled-agent'] },
    { principal: restored.runtime.getOperatorPrincipal() }
  );
  assert.deepEqual(restoredRefs, { template: [], hydration: [] });
  assert.deepEqual(restored.store.listMetaAuthorityGrants(), {
    template: persisted.metaAuthorityGrants.template,
    hydration: persisted.metaAuthorityGrants.hydration
  });
});

test('23. kill and purge drop publishing grants; a grant-free snapshot omits both fields', async () => {
  const { runtime, store } = createFixtureStore();
  const events = [];
  runtime.subscribe((event) => events.push(event));
  importFixture(store, createFixtureTemplate());
  const launched = await launchFixture(store, FIXTURE_ID, {
    authorityApprovals: [{ agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE }]
  });
  const architect = launched.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  assert.equal(store.listMetaAuthorityGrants().template.length, 1);
  assert.ok(
    events.some((event) => event.type === 'template_authority_granted' && event.agentId === architect.id),
    'the grant emits an audit event'
  );

  runtime.killAgent(architect.id, 'test recycle', { principal: runtime.getOperatorPrincipal() });
  assert.deepEqual(store.listMetaAuthorityGrants(), { template: [], hydration: [] }, 'soft-kill drops the grant');
  assert.equal(
    events.some((event) => event.type === 'template_authority_revoked'),
    false,
    'the kill drops the grant silently (no operator revoke event)'
  );

  runtime.restoreAgent(architect.id, { principal: runtime.getOperatorPrincipal() });
  assert.deepEqual(
    store.listMetaAuthorityGrants(),
    { template: [], hydration: [] },
    'a restored record stays default-deny until re-granted'
  );
  runtime.purgeAgent(architect.id, { principal: runtime.getOperatorPrincipal() });
  const serialized = store.serialize();
  assert.equal('metaAuthorityGrants' in serialized, false, 'grant-free snapshots omit the grant field');
  assert.equal('templateAuthorityTrust' in serialized, false, 'trust-free snapshots omit the trust field');
});

// ============================================================================
// 8. Smuggling and propagation
// ============================================================================

test('24. updateAgentConfig cannot place or claim the authority ids', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const launched = await launchFixture(store);
  const architect = launched.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const identityPort = runtime.createAgentIdentityPort();

  // An operator capability-selector edit cannot mint an authority: the id is
  // stripped from the selector-derived descriptor members.
  const operatorContext = { principal: runtime.getOperatorPrincipal() };
  store.updateAgentConfig(architect.id, { allowedTools: ['read_file', AGENT_AUTHORITIES.TEMPLATE] }, operatorContext);
  const afterSelector = identityPort.getAgentIdentity(architect.id, { realmId: launched.realm.id });
  assert.equal(
    [...afterSelector.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE),
    false,
    'a selector cannot smuggle the authority id'
  );

  // An explicit authority key is rejected for every caller, operator included.
  let thrown = null;
  try {
    store.updateAgentConfig(architect.id, { templateAuthority: true }, operatorContext);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'templateAuthority is never a config-update field');
  assert.equal(thrown.code, 'PERMISSION_DENIED');
  thrown = null;
  try {
    store.updateAgentConfig(architect.id, { hydrationAuthority: true }, operatorContext);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'hydrationAuthority is never a config-update field');
  assert.equal(thrown.code, 'PERMISSION_DENIED');
});

test('25. launch and spawn configs cannot propagate the authority ids to children', async () => {
  const { runtime, store } = createFixtureStore();
  importFixture(store, createFixtureTemplate());
  const launched = await launchFixture(store);
  const architect = launched.agents.find((agent) => agent.id === `${FIXTURE_ID}-architect`);
  const identityPort = runtime.createAgentIdentityPort();

  // Non-engine launch claims are ignored and selector-smuggled ids stripped.
  const child = await runtime.launchAgent({
    config: {
      id: 'up-smuggle-child',
      name: 'Smuggler',
      role: 'worker',
      systemPrompt: 'child',
      realmId: launched.realm.id,
      privileged: false,
      allowedTools: ['read_file', AGENT_AUTHORITIES.TEMPLATE, AGENT_AUTHORITIES.HYDRATION],
      templateAuthority: true,
      hydrationAuthority: true
    },
    principal: identityPort.getAgentIdentity(architect.id, { realmId: launched.realm.id })?.authority
  });
  const childIdentity = identityPort.getAgentIdentity('up-smuggle-child', { realmId: launched.realm.id });
  assert.ok(childIdentity);
  const childAllow = [...childIdentity.authority.allow];
  assert.equal(childAllow.includes(AGENT_AUTHORITIES.TEMPLATE), false);
  assert.equal(childAllow.includes(AGENT_AUTHORITIES.HYDRATION), false);
  assert.equal(child.config.allowedTools.includes(AGENT_AUTHORITIES.TEMPLATE), false, 'the selector is scrubbed');
  assert.ok(child.config.templateAuthority !== true, 'the caller config claim is inert (never a descriptor grant)');
});
