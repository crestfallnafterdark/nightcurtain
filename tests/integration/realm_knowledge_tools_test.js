/**
 * @file tests/integration/realm_knowledge_tools_test.js
 * @description M5b meta-knowledge — realm template/hydration enumeration
 *   (`list_templates`, `get_template`, `list_hydration_packages`) acceptance
 *   suite (meta-plane spec §6.2, ticket `fb7d270`).
 *
 * Acceptance coverage:
 *   AC-M5b-01 exact-authority only: the three tools live in
 *     `AUTHORITY_TOOL_REGISTRY` under the exact `@template:authority` /
 *     `@hydration:authority` ids, schemes/`describe_tool` are exposed only to
 *     the exact holder, and wildcard/privileged/ordinary callers are denied;
 *   AC-M5b-02 bounded/opaque outputs: template summaries carry exactly
 *     id/name/version/description/formatVersion/launchability, `get_template`
 *     returns the normalized format-v2 model (no bundle bodies), and the
 *     hydration listing carries ids/versions/digests/timestamps only — never a
 *     raw payload body or realm vocabulary;
 *   AC-M5b-03 pending/saved listing lifecycle: submission stores a session
 *     pending candidate that the listing reports until cleared; the S1 saved
 *     payload library appears and clears through its own lifecycle;
 *   AC-M5b-04 digest equality with submission receipts: the pending listing
 *     digest equals the submission receipt `payloadDigest` and the canonical
 *     `payloadDigest` over the stored candidate; saved entries report the
 *     library digest;
 *   AC-M5b-05 no realm vocabulary in any receipt or descriptor.
 *
 * Zero-Mock Verification: real `AgentRuntime`, real `SandboxStore`, real
 * dispatcher, real catalog import path; only the LLM stream is absent because
 * no turn runs.
 *
 * Standalone: `timeout 180 node tests/integration/realm_knowledge_tools_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
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
import {
  PUBLISHING_TOOLS,
  REALM_KNOWLEDGE_TOOLS,
  SANDBOX_TOOLS
} from '../../src/lib/sandbox/tools/constants/index.ts';
import {
  AGENT_AUTHORITIES,
  normalizeTemplate,
  payloadDigest,
  serializeTemplateBundle
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import { getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';

const LIST_TEMPLATES = REALM_KNOWLEDGE_TOOLS.LIST_TEMPLATES;
const GET_TEMPLATE = REALM_KNOWLEDGE_TOOLS.GET_TEMPLATE;
const LIST_HYDRATION_PACKAGES = REALM_KNOWLEDGE_TOOLS.LIST_HYDRATION_PACKAGES;
const TEMPLATE = AGENT_AUTHORITIES.TEMPLATE;
const HYDRATION = AGENT_AUTHORITIES.HYDRATION;
const FIXTURE_ID = 'mk-template-fixture';
const UNKNOWN_TEMPLATE_ID = 'mk-unknown-template';

/** Realm/extension vocabulary no knowledge receipt may carry. */
const OPAQUE_VOCABULARY = Object.freeze([
  'realm:',
  'realm_generic',
  'realmId',
  'realm_id',
  'tenantId',
  'tenant_id',
  'system:',
  '/home/',
  'file://'
]);

/**
 * Builds the fixture template: one prompt input, one optional user seed slot,
 * one worker agent with a declared tool profile.
 *
 * @param {{ id?: string }} [options] - Fixture overrides.
 * @returns {object} Format-v1 template spec.
 */
function createFixtureTemplate({ id = FIXTURE_ID } = {}) {
  return {
    formatVersion: 1,
    id,
    name: 'Knowledge Fixture',
    description: 'Template knowledge fixture.',
    hydration: { brief: 'Produce the opening lore.' },
    inputs: [
      { id: 'premise', label: 'Premise', brief: 'One premise.' }
    ],
    seed: {
      files: [
        { path: 'lore/world.md', target: 'realm', origin: 'user', brief: 'World lore.' }
      ]
    },
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
    ]
  };
}

/**
 * Builds an isolated runtime + store harness and the director principal used
 * to launch grant holders.
 *
 * @returns {Promise<object>} Harness with runtime, store, and director authority.
 */
async function createHarness() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoHydrate: false, autoBootstrapDirector: false });
  await runtime.ensureDirector();
  const directorAuthority = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
  return { runtime, store, directorAuthority };
}

/**
 * Launches one grant-holder agent through the real runtime.
 *
 * @param {object} runtime - Live runtime.
 * @param {object} directorAuthority - Director principal.
 * @param {string} id - Agent id.
 * @param {object} [options] - Launch overrides.
 * @returns {Promise<object>} The launch result.
 */
function launchHolder(runtime, directorAuthority, id, options = {}) {
  return runtime.launchAgent({
    config: { id, allowedTools: options.tools || ['read_file'], ...(options.privileged ? { privileged: true } : {}) },
    principal: directorAuthority
  });
}

/**
 * Builds a dispatcher bound to one agent with the store's publishing port.
 *
 * @param {object} store - Fixture store.
 * @param {object} runtime - Fixture runtime.
 * @param {string} agentId - Bound caller id.
 * @param {object} [options] - Dispatcher overrides.
 * @returns {Function} Tool dispatcher.
 */
function dispatcherFor(store, runtime, agentId, options = {}) {
  return createSandboxToolDispatcher({
    runtime,
    agentId,
    callerAgentId: agentId,
    virtualFs: runtime.virtualFs,
    ...options,
    ...(options.realmPublishingPort === null
      ? {}
      : { realmPublishingPort: options.realmPublishingPort || store.getRealmPublishingPort() })
  });
}

/** Grants one authority id to an active agent under the operator principal. */
function grant(runtime, agentId, authorityId) {
  return runtime.grantAuthority(agentId, authorityId, null, { principal: runtime.getOperatorPrincipal() });
}

/** Revokes one authority id from an active agent under the operator principal. */
function revoke(runtime, agentId, authorityId) {
  return runtime.revokeAuthority(agentId, authorityId, { principal: runtime.getOperatorPrincipal() });
}

/** Imports the fixture template and returns its import receipt. */
function importFixture(store, template = createFixtureTemplate()) {
  return store.importRealmTemplate(serializeTemplateBundle({ template, files: {} }));
}

// ============================================================================
// AC-M5b-01 — surface + exact-authority exposure
// ============================================================================

test('1. [AC-M5b-01] the knowledge tools are exact-authority tools outside the canonical taxonomy', () => {
  assert.ok(Object.isFrozen(REALM_KNOWLEDGE_TOOLS));
  assert.equal(LIST_TEMPLATES, 'list_templates');
  assert.equal(GET_TEMPLATE, 'get_template');
  assert.equal(LIST_HYDRATION_PACKAGES, 'list_hydration_packages');

  assert.equal(AUTHORITY_TOOL_REGISTRY[LIST_TEMPLATES]?.authority, TEMPLATE);
  assert.equal(AUTHORITY_TOOL_REGISTRY[GET_TEMPLATE]?.authority, TEMPLATE);
  assert.equal(AUTHORITY_TOOL_REGISTRY[LIST_HYDRATION_PACKAGES]?.authority, HYDRATION);

  for (const name of [LIST_TEMPLATES, GET_TEMPLATE, LIST_HYDRATION_PACKAGES]) {
    assert.equal(TOOL_REGISTRY[name], undefined, `'${name}' is not a canonical tool`);
    assert.equal(
      ALL_TOOL_DESCRIPTORS.some((descriptor) => descriptor.name === name),
      false,
      `'${name}' stays outside ALL_TOOL_DESCRIPTORS`
    );
    assert.equal(Object.values(SANDBOX_TOOLS).includes(name), false, `'${name}' is not canonical`);
    assert.equal(getCanonToolName(name), name, `'${name}' resolves through the alias map`);
  }
  assert.equal(getCanonToolName('listTemplates'), LIST_TEMPLATES);
  assert.equal(getCanonToolName('getTemplate'), GET_TEMPLATE);
  assert.equal(getCanonToolName('listHydrationPackages'), LIST_HYDRATION_PACKAGES);

  const wildcard = getSandboxToolsSchema('all').map((definition) => definition.function.name);
  for (const name of [LIST_TEMPLATES, GET_TEMPLATE, LIST_HYDRATION_PACKAGES]) {
    assert.equal(wildcard.includes(name), false, `'${name}' is never wildcard-exposed`);
  }

  assert.deepEqual(getAuthorityToolSchemas(['*']), [], 'the wildcard is never an authority id');
  assert.deepEqual(getAuthorityToolSchemas([]), [], 'no ids expose no schemas');
  assert.deepEqual(
    getAuthorityToolSchemas([TEMPLATE]).map((definition) => definition.function.name).sort(),
    [PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, LIST_TEMPLATES, GET_TEMPLATE].sort()
  );
  assert.deepEqual(
    getAuthorityToolSchemas([HYDRATION]).map((definition) => definition.function.name).sort(),
    [PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, LIST_HYDRATION_PACKAGES].sort()
  );
  assert.deepEqual(
    getAuthorityToolDescriptors([TEMPLATE]).map((descriptor) => descriptor.name).sort(),
    [PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, LIST_TEMPLATES, GET_TEMPLATE].sort(),
    'the describe-merge source is exact-id filtered'
  );
  assert.deepEqual(getAuthorityToolDescriptors(['*']), [], 'the wildcard never describes an authority tool');

  for (const name of [LIST_TEMPLATES, GET_TEMPLATE, LIST_HYDRATION_PACKAGES]) {
    const descriptor = AUTHORITY_TOOL_REGISTRY[name];
    assert.equal(descriptor.schema.type, 'object', `${name} schema is an object`);
    assert.equal(descriptor.schema.additionalProperties, false, `${name} schema is closed`);
  }
  assert.deepEqual(Object.keys(AUTHORITY_TOOL_REGISTRY[LIST_TEMPLATES].schema.properties), []);
  assert.deepEqual(Object.keys(AUTHORITY_TOOL_REGISTRY[LIST_HYDRATION_PACKAGES].schema.properties), []);
  assert.deepEqual(Object.keys(AUTHORITY_TOOL_REGISTRY[GET_TEMPLATE].schema.properties), ['templateId']);
  assert.deepEqual(AUTHORITY_TOOL_REGISTRY[GET_TEMPLATE].schema.required, ['templateId']);
});

test('2. [AC-M5b-01] the dispatcher admits only the exact authority id and never widens', async () => {
  const { runtime, store, directorAuthority } = await createHarness();
  importFixture(store);

  await launchHolder(runtime, directorAuthority, 'mk_plain');
  await launchHolder(runtime, directorAuthority, 'mk_wild', { tools: ['*'], privileged: true });
  await launchHolder(runtime, directorAuthority, 'mk_architect');
  await launchHolder(runtime, directorAuthority, 'mk_genesis');
  await grant(runtime, 'mk_architect', TEMPLATE);
  await grant(runtime, 'mk_genesis', HYDRATION);

  const plain = dispatcherFor(store, runtime, 'mk_plain');
  for (const name of [LIST_TEMPLATES, GET_TEMPLATE, LIST_HYDRATION_PACKAGES]) {
    const receipt = await plain.executeTool(name, name === GET_TEMPLATE ? { templateId: FIXTURE_ID } : {});
    assert.equal(receipt.success, false, `'${name}' is denied for an ordinary caller`);
    assert.equal(receipt.code, 'PERMISSION_DENIED');
  }
  const hidden = await plain.executeTool(SANDBOX_TOOLS.DESCRIBE_TOOL, { tool_name: LIST_TEMPLATES });
  assert.equal(hidden.success, false, 'describe_tool hides an authority tool from a non-holder');
  assert.equal(hidden.code, 'TOOL_NOT_FOUND');

  const wild = dispatcherFor(store, runtime, 'mk_wild');
  for (const name of [LIST_TEMPLATES, GET_TEMPLATE, LIST_HYDRATION_PACKAGES]) {
    const receipt = await wild.executeTool(name, name === GET_TEMPLATE ? { templateId: FIXTURE_ID } : {});
    assert.equal(receipt.success, false, `wildcard/privileged never satisfies '${name}'`);
    assert.equal(receipt.code, 'PERMISSION_DENIED');
  }

  const architect = dispatcherFor(store, runtime, 'mk_architect');
  const listed = await architect.executeTool(LIST_TEMPLATES, {});
  assert.equal(listed.success, true, JSON.stringify(listed));
  const described = await architect.executeTool(GET_TEMPLATE, { templateId: FIXTURE_ID });
  assert.equal(described.success, true, JSON.stringify(described));
  const crossTemplate = await architect.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(crossTemplate.success, false, 'a template grant never authorizes hydration reads');
  assert.equal(crossTemplate.code, 'PERMISSION_DENIED');

  const genesis = dispatcherFor(store, runtime, 'mk_genesis');
  const packages = await genesis.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(packages.success, true, JSON.stringify(packages));
  const crossHydration = await genesis.executeTool(LIST_TEMPLATES, {});
  assert.equal(crossHydration.success, false, 'a hydration grant never authorizes template reads');
  assert.equal(crossHydration.code, 'PERMISSION_DENIED');

  await revoke(runtime, 'mk_architect', TEMPLATE);
  const revoked = await dispatcherFor(store, runtime, 'mk_architect').executeTool(LIST_TEMPLATES, {});
  assert.equal(revoked.success, false, 'revocation denies future calls');
  assert.equal(revoked.code, 'PERMISSION_DENIED');
});

// ============================================================================
// AC-M5b-02 — bounded/opaque outputs
// ============================================================================

test('3. [AC-M5b-02] template summaries and the normalized model are bounded and realm-opaque', async () => {
  const { runtime, store, directorAuthority } = await createHarness();
  const imported = importFixture(store);
  await launchHolder(runtime, directorAuthority, 'mk_architect');
  await launchHolder(runtime, directorAuthority, 'mk_genesis');
  await grant(runtime, 'mk_architect', TEMPLATE);
  await grant(runtime, 'mk_genesis', HYDRATION);
  const dispatcher = dispatcherFor(store, runtime, 'mk_architect');
  const hydration = dispatcherFor(store, runtime, 'mk_genesis');

  const list = await dispatcher.executeTool(LIST_TEMPLATES, {});
  assert.equal(list.success, true, JSON.stringify(list));
  assert.deepEqual(Object.keys(list).sort(), ['count', 'success', 'templates']);
  assert.equal(list.count, list.templates.length);
  for (const entry of list.templates) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['description', 'formatVersion', 'launchable', 'name', 'templateId', 'version']
    );
    assert.equal(typeof entry.launchable, 'boolean');
    assert.ok(entry.version === null || /^sha256:/.test(entry.version));
  }
  const fixture = list.templates.find((entry) => entry.templateId === FIXTURE_ID);
  assert.ok(fixture, 'the imported fixture is listed');
  assert.equal(fixture.name, 'Knowledge Fixture');
  assert.equal(fixture.description, 'Template knowledge fixture.');
  assert.equal(fixture.formatVersion, 2, 'the summary reports the normalized format version');
  assert.equal(fixture.version, imported.templateVersion);
  assert.equal(fixture.launchable, true);

  const described = await dispatcher.executeTool(GET_TEMPLATE, { templateId: FIXTURE_ID });
  assert.equal(described.success, true, JSON.stringify(described));
  assert.deepEqual(Object.keys(described).sort(), ['success', 'template', 'templateId', 'templateVersion']);
  assert.equal(described.templateId, FIXTURE_ID);
  assert.equal(described.templateVersion, imported.templateVersion);
  assert.equal(described.template.formatVersion, 2, 'get_template serves the normalized format-v2 model');
  assert.equal(described.template.id, FIXTURE_ID);
  assert.ok(described.template.inputs.some((input) => input.id === 'premise'), 'declared inputs are served');
  assert.ok(
    described.template.agents.every((agent) => agent.toolProfile !== undefined),
    'declared tool profiles are served'
  );
  assert.equal(described.template.files, undefined, 'bundle bodies never travel with the model');
  assert.equal(described.files, undefined, 'the receipt carries no bundle file map');

  const unknown = await dispatcher.executeTool(GET_TEMPLATE, { templateId: UNKNOWN_TEMPLATE_ID });
  assert.equal(unknown.success, false);
  assert.equal(unknown.code, 'INVALID_ARGUMENTS');
  assert.equal(JSON.stringify(unknown).includes(UNKNOWN_TEMPLATE_ID), false, 'an unknown id is never echoed');

  const packages = await hydration.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(packages.success, true, JSON.stringify(packages));
  assert.deepEqual(Object.keys(packages).sort(), ['pending', 'saved', 'success']);
  assert.deepEqual(packages.pending, [], 'no pending candidate exists yet');
  assert.deepEqual(packages.saved, [], 'the saved library starts empty');

  // Closed parameter surfaces: unknown parameters and missing required ids
  // fail the whole call with static malformed-arguments receipts.
  const strayList = await dispatcher.executeTool(LIST_TEMPLATES, { filter: 'x' });
  assert.equal(strayList.success, false);
  assert.equal(strayList.code, 'INVALID_ARGUMENTS');
  assert.equal(JSON.stringify(strayList).includes('filter'), false);

  const strayGet = await dispatcher.executeTool(GET_TEMPLATE, { templateId: FIXTURE_ID, files: true });
  assert.equal(strayGet.success, false);
  assert.equal(strayGet.code, 'INVALID_ARGUMENTS');
  assert.equal(JSON.stringify(strayGet).includes('files'), false);

  const missingGet = await dispatcher.executeTool(GET_TEMPLATE, {});
  assert.equal(missingGet.success, false);
  assert.equal(missingGet.code, 'INVALID_ARGUMENTS');

  const strayPackages = await hydration.executeTool(LIST_HYDRATION_PACKAGES, { templateId: FIXTURE_ID });
  assert.equal(strayPackages.success, false);
  assert.equal(strayPackages.code, 'INVALID_ARGUMENTS');
});

// ============================================================================
// AC-M5b-03 — pending/saved listing lifecycle
// ============================================================================

test('4. [AC-M5b-03] the hydration listing follows the pending and saved lifecycles', async () => {
  const { runtime, store, directorAuthority } = await createHarness();
  const imported = importFixture(store);
  await launchHolder(runtime, directorAuthority, 'mk_genesis');
  await grant(runtime, 'mk_genesis', HYDRATION);
  const dispatcher = dispatcherFor(store, runtime, 'mk_genesis');

  const submitted = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: FIXTURE_ID, inputs: { premise: 'knowledge premise' } }
  });
  assert.equal(submitted.success, true, JSON.stringify(submitted));
  assert.equal(submitted.stored, true);

  const afterSubmit = await dispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(afterSubmit.pending.length, 1, 'the session candidate is listed');
  const pending = afterSubmit.pending[0];
  assert.deepEqual(Object.keys(pending).sort(), ['digest', 'resolvedAt', 'templateId', 'templateVersion']);
  assert.equal(pending.templateId, FIXTURE_ID);
  assert.equal(pending.templateVersion, imported.templateVersion);
  assert.ok(/^sha256:/.test(pending.digest));
  assert.equal(pending.resolvedAt, submitted.resolvedAt);
  assert.equal(JSON.stringify(pending).includes('knowledge premise'), false, 'raw payload bodies never appear');

  const candidate = store.getPendingInstancePayload(FIXTURE_ID);
  const savedEntry = store.saveInstancePayload({
    name: 'Knowledge payload',
    templateId: FIXTURE_ID,
    templateVersion: imported.templateVersion,
    payload: candidate.payload
  });

  const afterSave = await dispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(afterSave.pending.length, 1, 'the pending candidate is still listed alongside the library');
  assert.equal(afterSave.saved.length, 1, 'the saved library entry is listed');
  const saved = afterSave.saved[0];
  assert.deepEqual(Object.keys(saved).sort(), ['digest', 'id', 'name', 'savedAt', 'templateId', 'templateVersion']);
  assert.equal(saved.id, savedEntry.id);
  assert.equal(saved.name, 'Knowledge payload');
  assert.equal(saved.templateId, FIXTURE_ID);
  assert.equal(saved.templateVersion, imported.templateVersion);
  assert.ok(/^sha256:/.test(saved.digest));
  assert.equal(typeof saved.savedAt, 'string');
  assert.equal(JSON.stringify(saved).includes('knowledge premise'), false, 'raw payload bodies never appear');

  assert.equal(store.deleteSavedInstancePayload(saved.id), true);
  const afterDelete = await dispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.deepEqual(afterDelete.saved, [], 'deleting the saved entry empties the library listing');

  assert.equal(store.clearPendingInstancePayload(FIXTURE_ID), true);
  const afterClear = await dispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.deepEqual(afterClear.pending, [], 'clearing the candidate empties the pending listing');
});

// ============================================================================
// AC-M5b-04 — digest equality with submission receipts
// ============================================================================

test('5. [AC-M5b-04] listing digests equal the submission receipt and the canonical payload digest', async () => {
  const { runtime, store, directorAuthority } = await createHarness();
  importFixture(store);
  await launchHolder(runtime, directorAuthority, 'mk_genesis');
  await grant(runtime, 'mk_genesis', HYDRATION);
  const dispatcher = dispatcherFor(store, runtime, 'mk_genesis');

  const submitted = await dispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: FIXTURE_ID, inputs: { premise: 'digest premise' } }
  });
  assert.equal(submitted.success, true, JSON.stringify(submitted));

  const candidate = store.getPendingInstancePayload(FIXTURE_ID);
  assert.equal(payloadDigest(candidate.payload), submitted.payloadDigest, 'the stored candidate digests to the receipt');

  const listed = await dispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.pending[0].digest, submitted.payloadDigest, 'the pending listing reports the receipt digest');

  const saved = store.saveInstancePayload({
    name: 'Digest payload',
    templateId: FIXTURE_ID,
    templateVersion: candidate.templateVersion,
    payload: candidate.payload
  });
  assert.equal(saved.digest, submitted.payloadDigest, 'the saved library re-digests the same authored payload');
  const relisted = await dispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(relisted.saved[0].digest, submitted.payloadDigest, 'the saved listing reports the library digest');
});

// ============================================================================
// AC-M5b-05 — opacity + fail-closed port binding
// ============================================================================

test('6. [AC-M5b-05] knowledge receipts are realm/extension-opaque and the port is pinned', async () => {
  const { runtime, store, directorAuthority } = await createHarness();
  importFixture(store);
  await launchHolder(runtime, directorAuthority, 'mk_architect');
  await launchHolder(runtime, directorAuthority, 'mk_genesis');
  await grant(runtime, 'mk_architect', TEMPLATE);
  await grant(runtime, 'mk_genesis', HYDRATION);

  const architect = dispatcherFor(store, runtime, 'mk_architect');
  const genesis = dispatcherFor(store, runtime, 'mk_genesis');
  const listReceipt = await architect.executeTool(LIST_TEMPLATES, {});
  const getReceipt = await architect.executeTool(GET_TEMPLATE, { templateId: FIXTURE_ID });
  const packagesReceipt = await genesis.executeTool(LIST_HYDRATION_PACKAGES, {});
  const receipts = [listReceipt, getReceipt, packagesReceipt];

  // Only the host-owned projection fields are scanned: template/hydration
  // names and descriptions are authored content, but the ids, versions,
  // scope fields, and digests the host adds must stay realm-opaque.
  const hostProjection = JSON.stringify({
    list: listReceipt.templates.map((entry) => ({
      templateId: entry.templateId,
      version: entry.version,
      formatVersion: entry.formatVersion,
      launchable: entry.launchable
    })),
    get: { templateId: getReceipt.templateId, templateVersion: getReceipt.templateVersion },
    packages: {
      pending: packagesReceipt.pending.map((entry) => ({
        templateId: entry.templateId,
        templateVersion: entry.templateVersion,
        digest: entry.digest,
        resolvedAt: entry.resolvedAt
      })),
      saved: packagesReceipt.saved.map((entry) => ({
        id: entry.id,
        templateId: entry.templateId,
        templateVersion: entry.templateVersion,
        digest: entry.digest,
        savedAt: entry.savedAt
      }))
    }
  });
  for (const term of OPAQUE_VOCABULARY) {
    assert.equal(hostProjection.includes(term), false, `knowledge projections never carry '${term}'`);
  }
  for (const receipt of receipts) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(receipt, 'realmId'),
      false,
      'no knowledge receipt carries a realm scope field'
    );
  }
  for (const descriptor of Object.values(REALM_KNOWLEDGE_TOOLS).map((name) => AUTHORITY_TOOL_REGISTRY[name])) {
    assert.equal(/realmId|realm_id|realm:|tenant|workspace/iu.test(descriptor.description), false, `${descriptor.name} description carries no scope vocabulary`);
    assert.equal(/extension/iu.test(descriptor.description), false, `${descriptor.name} description is extension-free`);
  }

  // Pinned port: a per-call claim is stripped, so a portless dispatcher fails
  // closed without executing anything.
  const portless = createSandboxToolDispatcher({ runtime, agentId: 'mk_architect', callerAgentId: 'mk_architect' });
  const substituted = await portless.executeTool(
    LIST_TEMPLATES,
    {},
    { realmPublishingPort: store.getRealmPublishingPort() }
  );
  assert.equal(substituted.success, false);
  assert.equal(substituted.code, 'EXECUTION_FAILED');
  assert.match(substituted.error, /realmPublishingPort service is not available/);

  // A partial port missing the read method fails closed the same way.
  const partial = dispatcherFor(store, runtime, 'mk_architect', { realmPublishingPort: {} });
  const partialReceipt = await partial.executeTool(LIST_TEMPLATES, {});
  assert.equal(partialReceipt.success, false);
  assert.equal(partialReceipt.code, 'EXECUTION_FAILED');
  assert.match(partialReceipt.error, /realmPublishingPort service is not available/);

  // The normalized model round-trips through the catalog's own normalizer.
  const described = await architect.executeTool(GET_TEMPLATE, { templateId: FIXTURE_ID });
  assert.deepEqual(normalizeTemplate(described.template).id, FIXTURE_ID);
});
