/**
 * @file tests/integration/realm_launch_seed_test.js
 * @description Realm wave B (ticket 2348d28) end-to-end verification of the
 *   store launch-from-template orchestration and the generic `seedRealm` API,
 *   through the real `SandboxStore` composition root (real runtime, real
 *   VirtualFS, real MessagingBus, real realm registry).
 *
 *   Covered behavior:
 *   1. The baked demo template launches in one call: the Realm record exists,
 *      both members are active with the plain realm-opaque ids, membership,
 *      privilege, resolved tool grants (the `subagent_management` sentinel
 *      preserved), system prompts, and the catalog-default preset binding.
 *   2. Name/color/description overrides and per-key id overrides land on the
 *      record and the agent ids; the record is visible in the reactive
 *      projection.
 *   3. A per-key `presetBindings` override wins over the spec's
 *      `modelPresetId` and resolves through the preset catalog; unknown
 *      binding keys and unresolvable preset ids reject before any Realm is
 *      created (fail-closed, no churn).
 *   4. Unknown template ids fail closed without creating a record.
 *   5. A forced member-launch failure rolls back: the record is removed, the
 *      already-launched member is purged (not recycled), and the typed
 *      `ERR_STORE_REALM_LAUNCH_FAILED` error reports the failure and rollback
 *      (the runtime refuses a late member whose id carries realm vocabulary,
 *      after the first member already launched).
 *   6. A privileged member launches under the runtime host operator principal
 *      with zero agents (no director needed) and the realm materializes.
 *   7. `seedRealm` without a target writes into the Realm-global workspace
 *      `realm:<realmId>:global` and round-trips path/content through the real
 *      VFS.
 *   8. `seedRealm` with a target writes into the member's private workspace
 *      and delivers the directive as an operator-attributed mailbox message
 *      (the non-agent `'human'` label rides the runtime host operator principal
 *      per Wave I, ticket c02d0b9; ticket 99faaf1).
 *   9. Seed validation rejects unknown realms, unknown/non-member/recycled
 *      targets, traversal and duplicate paths, reserved-workspace targets,
 *      empty file lists, non-string content, and target-less directives —
 *      before the first write.
 *  10. Seed file paths naming the reserved `global`/`public` workspace roots
 *      are rejected before the first write instead of being silently routed
 *      into the legacy ungrouped shared workspace (V18 F-V18-1).
 *  11. Realm-local uniqueness (Wave I, ticket d57cbc1): a second template
 *      launch of the same plain ids lands in its own Realm — one registration
 *      per Realm, distinct canonical identities, no auto-suffix — while a
 *      same-Realm duplicate stays denied with `AGENT_ALREADY_EXISTS`.
 *  12. Wave C (ticket f1eb48a): launch `inputValues` forward to
 *      materialization — bundle files resolve, declared defaults apply, and an
 *      explicit value wins — and the store's bundle seam exposes the same
 *      files the launcher preview reads.
 *  13. The template-declared seed runs after every member launches, one
 *      `seedRealm` call per target (realm-global + per-member files), with the
 *      directive delivered under the operator subject to its target member.
 *  14. `seed: false` skips the template seed entirely (no workspace, no
 *      directive) while the manual seed surface still works.
 *  15. A required input that resolves empty fails materialization and the
 *      launch rolls back with no member and no record.
 *  16. A failing template seed (a member slot naming the reserved `global`
 *      root, rejected store-side after the realm-global group already wrote)
 *      rolls the launch back, evicts the realm-global file already written,
 *      purges both members, and reports the eviction on the typed failure.
 *  17. Wave C C2 (ticket dd13eab): the default store's baked catalog includes
 *      the embedded `example_agent` bundle and a launch with input values
 *      composes its prompt from the embedded bundle files (protocol file,
 *      launch inputs, `defaultFile` prefill) exactly as the catalog
 *      materializes it; the explicit zero-tool profile resolves to no grants.
 *      This case pins wiring, never wording.
 *
 * Fixture note: launched template agents carry a bound catalog preset so no
 * model literal appears at the launch site. The suite registers one custom
 * catalog preset pointing at a closed loopback endpoint, so the only wake turn
 * any test can provoke (the directive delivery in case 8) fails fast without
 * network access. No engine class is mocked: the store, runtime, VirtualFS,
 * messaging bus, registry, and preset catalog are all real.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERIC_REALM_ID,
  SANDBOX_STORE_ERROR_CODES,
  createSandboxStore
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { DEMO_TEMPLATE, materializeTemplate } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { TOOL_PRESETS } from '../../src/lib/sandbox/tools/constants/index.ts';

/** Custom catalog preset id used to keep launched agents off the network. */
const OFFLINE_PRESET_ID = 'preset_realm_b2_offline';

/** Closed loopback endpoint the offline preset points at. */
const OFFLINE_ENDPOINT = 'http://127.0.0.1:1/v1';

/**
 * Creates an isolated non-hydrating store with no auto-bootstrapped director.
 *
 * @returns {object} Fresh `SandboxStore` instance.
 */
function createStore() {
  return createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
}

/**
 * Creates an isolated store with the Director meta-agent registered as the
 * operator principal (privileged launches, realm moves, and file purges all
 * run through it).
 *
 * @param {Array<object>} [realmTemplateBundles] - Optional launch bundles injected through the store's bundle seam.
 * @returns {Promise<object>} Operator-backed `SandboxStore` instance.
 */
async function createOperatorStore(realmTemplateBundles = null) {
  const injected = Array.isArray(realmTemplateBundles) && realmTemplateBundles.length > 0;
  const store = createSandboxStore({
    autoBootstrapDirector: false,
    autoHydrate: false,
    ...(injected ? { realmTemplateBundles } : {})
  });
  await store.ensureDirector();
  return store;
}

/**
 * Registers the closed-endpoint custom preset in the store's catalog.
 *
 * @param {object} store - Store instance under test.
 */
function registerOfflinePreset(store) {
  store.getPresetCatalog().savePreset({
    id: OFFLINE_PRESET_ID,
    name: 'Realm B2 offline',
    isCustom: true,
    modelConfig: { providerId: 'openai', modelId: 'realm-b2-offline', url: OFFLINE_ENDPOINT }
  });
}

/**
 * Resolves the catalog default preset id of a store.
 *
 * @param {object} store - Store instance under test.
 * @returns {string} Default preset id.
 */
function defaultPresetId(store) {
  return store.getPresetCatalog().createPresetSourcePort().getDefaultPresetId();
}

/**
 * Runs a synchronous store call and returns the thrown error, or `null`.
 *
 * @param {Function} fn - Call under test.
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
 * Asserts that a synchronous call throws a coded error matching the message.
 *
 * @param {Function} fn - Call under test.
 * @param {string} code - Expected `err.code`.
 * @param {RegExp} messagePattern - Expected message pattern.
 * @returns {Error} The thrown error.
 */
function expectThrow(fn, code, messagePattern) {
  const err = captureThrow(fn);
  assert.ok(err, `expected a '${code}' error`);
  assert.equal(err.code, code, `expected code '${code}', got '${err.code}': ${err.message}`);
  assert.match(err.message, messagePattern);
  return err;
}

// ============================================================================
// Wave C (ticket f1eb48a) launch fixtures: inputs + per-target seed
// ============================================================================

/** Bundle file bodies the fixture template's prompt parts and seed sources resolve against. */
const FIXTURE_FILES = {
  'prompts/lead.md': 'Lead protocol body.',
  'files/lore.md': 'Bundle lore.',
  'files/order.md': 'Order one.'
};

/** Seeded fixture: three inputs (default, defaultFile, required) and a per-target seed with a directive. */
const FIXTURE_TEMPLATE = {
  id: 'c4-fixture',
  name: 'C4 Fixture Realm',
  description: 'Inputs + seed fixture.',
  formatVersion: 1,
  inputs: [
    { id: 'directives', label: 'Directives', help: 'Optional launch directives.', default: 'Default directive.' },
    { id: 'lore', label: 'Lore', defaultFile: 'files/lore.md' },
    { id: 'mandate', label: 'Mandate', required: true, multiline: false }
  ],
  agents: [
    {
      key: 'lead',
      idPattern: 'c4-lead',
      name: 'Lead',
      role: 'lead',
      prompt: [
        { kind: 'file', path: 'prompts/lead.md' },
        { kind: 'input', inputId: 'directives' },
        { kind: 'input', inputId: 'lore' },
        { kind: 'input', inputId: 'mandate' },
        { kind: 'text', text: 'Tail.' }
      ],
      toolProfile: { preset: 'readonly' },
      privileged: false,
      modelPresetId: OFFLINE_PRESET_ID
    },
    {
      key: 'scribe',
      idPattern: 'c4-scribe',
      name: 'Scribe',
      role: 'scribe',
      prompt: [{ kind: 'text', text: 'Scribe protocol.' }],
      toolProfile: { preset: 'readonly' },
      privileged: false,
      modelPresetId: OFFLINE_PRESET_ID
    }
  ],
  seed: {
    files: [
      { path: 'notes/realm.md', target: 'realm', source: { inline: 'Realm-wide note.' } },
      { path: 'orders/one.md', target: { agent: 'lead' }, source: { file: 'files/order.md' } },
      { path: 'lore/world.md', target: { agent: 'scribe' }, source: { inline: 'World lore.' } }
    ],
    directive: { targetAgentKey: 'lead', text: 'Begin the seeded session.' }
  }
};

/** The fixture as a store bundle. */
const FIXTURE_BUNDLE = { template: FIXTURE_TEMPLATE, files: FIXTURE_FILES };

/**
 * Seed-failure fixture: the member group's second lead file names the reserved
 * `global` workspace root, so the store's `seedRealm` reserved-root guard
 * rejects the member group after the realm-global group already wrote (the
 * catalog validates the manifest — reserved roots are a store-side write-time
 * rule — and the store fails it closed before the first write of that group).
 */
const FAILING_SEED_TEMPLATE = {
  id: 'c4-fixture-failing',
  name: 'C4 Fixture (failing seed)',
  description: 'Seed failure fixture.',
  formatVersion: 1,
  inputs: [{ id: 'mandate', label: 'Mandate', required: true }],
  agents: [
    {
      key: 'lead',
      idPattern: 'c4r-lead',
      name: 'Lead',
      role: 'lead',
      prompt: [{ kind: 'input', inputId: 'mandate' }],
      toolProfile: { preset: 'readonly' },
      privileged: false,
      modelPresetId: OFFLINE_PRESET_ID
    },
    {
      key: 'scribe',
      idPattern: 'c4r-scribe',
      name: 'Scribe',
      role: 'scribe',
      prompt: [{ kind: 'text', text: 'Scribe protocol.' }],
      toolProfile: { preset: 'readonly' },
      privileged: false,
      modelPresetId: OFFLINE_PRESET_ID
    }
  ],
  seed: {
    files: [
      { path: 'notes/realm.md', target: 'realm', source: { inline: 'Realm-wide note.' } },
      { path: 'orders/dup.md', target: { agent: 'lead' }, source: { inline: 'First copy.' } },
      { path: 'global/dup.md', target: { agent: 'lead' }, source: { inline: 'Reserved root.' } }
    ],
    directive: { targetAgentKey: 'lead', text: 'Begin the failing session.' }
  }
};

/** The failing-seed fixture as a store bundle. */
const FAILING_SEED_BUNDLE = { template: FAILING_SEED_TEMPLATE, files: {} };

/** Expected lead system prompt after materialization with the fixture inputs. */
const FIXTURE_LEAD_PROMPT = 'Lead protocol body.\n\nDefault directive.\n\nBundle lore.\n\nM\n\nTail.';

// ============================================================================
// 1. Demo template launch
// ============================================================================

test('1. demo launch creates the realm record and both members with realm-opaque ids, membership, grants, and presets', async () => {
  const store = await createOperatorStore();
  try {
    const receipt = await store.launchRealmFromTemplate('demo');
    const realm = receipt.realm;

    assert.match(realm.id, /^realm_/, 'the store generates the realm id');
    assert.equal(realm.templateId, 'demo');
    assert.equal(realm.name, DEMO_TEMPLATE.name, 'the template name is the default realm name');
    assert.equal(realm.description, DEMO_TEMPLATE.description);
    assert.ok(Object.isFrozen(realm), 'the registry record stays frozen');
    assert.deepEqual(
      store.realms.map((entry) => entry.id),
      [GENERIC_REALM_ID, realm.id],
      'the reactive projection carries the seeded Generic default plus the new realm'
    );
    assert.ok(store.getRealm(realm.id), 'the registry resolves the new realm');

    const coordinatorId = 'coordinator';
    const workerId = 'worker';
    assert.deepEqual(
      receipt.agents.map((agent) => agent.id),
      [coordinatorId, workerId],
      'members launch in template order with plain realm-opaque ids'
    );
    assert.ok(
      [coordinatorId, workerId].every((id) => !id.includes(realm.id)),
      'no generated member id embeds the realm id'
    );
    assert.deepEqual(
      store.agents.map((agent) => agent.id).sort(),
      [coordinatorId, workerId, 'director'].sort(),
      'exactly the two members and the operator are active'
    );

    const coordinator = store.agents.find((agent) => agent.id === coordinatorId);
    const worker = store.agents.find((agent) => agent.id === workerId);
    assert.equal(coordinator.config.realmId, realm.id, 'the coordinator is a realm member');
    assert.equal(worker.config.realmId, realm.id, 'the worker is a realm member');
    assert.equal(coordinator.config.privileged, true, 'the template privilege flag is re-derived from the trusted spec');
    assert.equal(worker.config.privileged, false);
    assert.equal(coordinator.config.role, 'coordinator');
    assert.equal(worker.config.role, 'worker');
    assert.equal(coordinator.config.name, 'Coordinator');
    assert.equal(worker.config.name, 'Worker');
    assert.equal(coordinator.config.systemPrompt, DEMO_TEMPLATE.agents[0].prompt[0].text, 'the composed text part becomes the system prompt');
    assert.equal(worker.config.systemPrompt, DEMO_TEMPLATE.agents[1].prompt[0].text);

    // Resolved grants: the manager preset travels verbatim, sentinel included.
    assert.deepEqual(coordinator.config.allowedTools, [...TOOL_PRESETS.manager]);
    assert.ok(
      coordinator.config.allowedTools.includes('subagent_management'),
      'the aggregate subagent_management sentinel is preserved on the launched agent'
    );
    assert.deepEqual(worker.config.allowedTools, [...TOOL_PRESETS.readonly]);

    // Preset binding: no spec modelPresetId and no override ⇒ catalog default.
    const expectedPresetId = defaultPresetId(store);
    assert.equal(coordinator.config.presetId, expectedPresetId);
    assert.equal(worker.config.presetId, expectedPresetId);
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 2. Launch option overrides
// ============================================================================

test('2. name/color/description and per-key id overrides land on the record and the member ids', async () => {
  const store = await createOperatorStore();
  try {
    const receipt = await store.launchRealmFromTemplate('demo', {
      name: 'Ops Realm',
      color: '#123456',
      description: 'Custom operator description',
      idOverrides: { coordinator: 'ops-lead', worker: 'ops-worker' }
    });

    assert.equal(receipt.realm.name, 'Ops Realm');
    assert.equal(receipt.realm.color, '#123456');
    assert.equal(receipt.realm.description, 'Custom operator description');
    assert.equal(receipt.realm.templateId, 'demo');
    assert.deepEqual(receipt.agents.map((agent) => agent.id), ['ops-lead', 'ops-worker']);
    assert.equal(store.getRealm(receipt.realm.id).name, 'Ops Realm', 'the registry persisted the override');
    assert.deepEqual(
      store.agents.filter((agent) => agent.config.realmId === receipt.realm.id).map((agent) => agent.id).sort(),
      ['ops-lead', 'ops-worker'],
      'both overridden ids are active members'
    );
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 3. Preset bindings
// ============================================================================

test('3. a presetBindings override wins over the spec and resolves through the catalog; bad bindings fail closed', async () => {
  const store = await createOperatorStore();
  try {
    registerOfflinePreset(store);

    const receipt = await store.launchRealmFromTemplate('demo', {
      presetBindings: { coordinator: OFFLINE_PRESET_ID }
    });
    const coordinator = store.agents.find((agent) => agent.id === 'coordinator');
    const worker = store.agents.find((agent) => agent.id === 'worker');
    assert.equal(coordinator.config.presetId, OFFLINE_PRESET_ID, 'the override binds the coordinator');
    assert.equal(coordinator.config.modelConfig.modelId, 'realm-b2-offline', 'the bound preset model config materializes');
    assert.equal(worker.config.presetId, defaultPresetId(store), 'unbound members keep the catalog default');

    const realmsBefore = store.realms.map((realm) => realm.id);
    const agentsBefore = store.agents.map((agent) => agent.id).sort();

    await assert.rejects(
      () => store.launchRealmFromTemplate('demo', { presetBindings: { ghost: OFFLINE_PRESET_ID } }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /unknown agent key 'ghost'/.test(err.message)
    );
    await assert.rejects(
      () => store.launchRealmFromTemplate('demo', { presetBindings: { coordinator: 'preset_does_not_exist' } }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /not a known catalog preset/.test(err.message)
    );

    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'a rejected binding creates no realm record');
    assert.deepEqual(store.agents.map((agent) => agent.id).sort(), agentsBefore, 'a rejected binding launches no member');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 4. Unknown template
// ============================================================================

test('4. an unknown template id is denied without creating a realm', async () => {
  const store = await createOperatorStore();
  try {
    const realmsBefore = store.realms.length;
    await assert.rejects(
      () => store.launchRealmFromTemplate('not-a-template'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /unknown realm template/.test(err.message)
    );
    assert.equal(store.realms.length, realmsBefore, 'a denied launch makes no record');
    assert.equal(store.agents.filter((agent) => agent.id !== 'director').length, 0, 'a denied launch makes no member');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 5. Rollback on a forced member failure
// ============================================================================

test('5. a failed member launch rolls back the whole realm and purges the launched member', async () => {
  const store = await createOperatorStore();
  try {
    const realmsBefore = store.realms.map((realm) => realm.id);
    const agentsBefore = store.agents.map((agent) => agent.id).sort();

    let failure = null;
    try {
      // Forced member-launch failure (Wave I, ticket d57cbc1): id collisions are
      // realm-local now, so the launch is failed by a late member whose resolved
      // id carries internal realm vocabulary — the runtime refuses it uniformly
      // before registration, after the first member already launched.
      await store.launchRealmFromTemplate('demo', { idOverrides: { worker: 'realm:beta:worker' } });
    } catch (err) {
      failure = err;
    }

    assert.ok(failure, 'the refused member id must fail the launch');
    assert.equal(failure.code, 'ERR_STORE_REALM_LAUNCH_FAILED');
    assert.equal(failure.templateId, 'demo');
    assert.match(failure.realmId, /^realm_/);
    assert.equal(failure.failedAgentId, 'realm:beta:worker');
    assert.equal(failure.rolledBack, true, 'the rollback completed without failures');
    assert.deepEqual(failure.rollbackFailures, []);
    assert.deepEqual(
      failure.terminatedMembers,
      ['coordinator'],
      'the already-launched coordinator was purged by the rollback'
    );
    assert.ok(failure.cause, 'the refusal rides as cause');
    assert.equal(failure.cause.code, 'PERMISSION_DENIED', 'the runtime refuses realm-vocabulary ids uniformly');

    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'no realm record survives the rollback');
    assert.deepEqual(store.agents.map((agent) => agent.id).sort(), agentsBefore, 'no launched member survives the rollback');
    assert.ok(
      !store.agents.some((agent) => /^(coordinator|worker)-\d+$/.test(agent.id)),
      'a refused member is never auto-suffixed'
    );
    assert.equal(store.recycleBin.length, 0, 'rolled-back members are purged, never recycled');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 6. Privileged template member under the host operator principal (zero agents)
// ============================================================================

test('6. a privileged member launches under the host operator principal with zero agents (no director needed)', async () => {
  const store = createStore();
  try {
    registerOfflinePreset(store);
    const { realm, agents } = await store.launchRealmFromTemplate('demo', {
      presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
    });

    assert.equal(store.agents.some((agent) => agent.id === 'director'), false, 'fixture: no director exists');
    const coordinator = store.agents.find((agent) => agent.id === 'coordinator');
    assert.ok(coordinator, 'the privileged coordinator launches');
    assert.equal(coordinator.config.privileged, true, 'the template privilege is granted by the host operator principal');
    assert.ok(store.getRealm(realm.id), 'the realm record materializes');
    assert.equal(agents.length, 2, 'both template members launch');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 7. Seed into the realm-global workspace
// ============================================================================

test('7. seeding without a target writes into realm:<realmId>:global and round-trips path/content', async () => {
  const store = await createOperatorStore();
  try {
    registerOfflinePreset(store);
    const { realm } = await store.launchRealmFromTemplate('demo', {
      presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
    });

    const receipt = store.seedRealm({
      realmId: realm.id,
      files: [
        { path: '/notes/brief.md', content: '# Brief\nSeed the realm.' },
        { path: 'lore/world.json', content: '{"name":"Test World","day":1}' }
      ]
    });

    assert.equal(receipt.realmId, realm.id);
    assert.equal(receipt.workspace, `realm:${realm.id}:global`);
    assert.deepEqual(receipt.writtenPaths, ['/notes/brief.md', '/lore/world.json'], 'relative paths normalize to absolute');
    assert.equal(receipt.directiveDelivered, false, 'no directive was requested');

    const workspaceSnapshot = store.fsSnapshot[`realm:${realm.id}:global`];
    assert.ok(workspaceSnapshot, 'the realm-global workspace exists after the seed');
    assert.equal(workspaceSnapshot['/notes/brief.md'].content, '# Brief\nSeed the realm.');
    assert.equal(workspaceSnapshot['/lore/world.json'].content, '{"name":"Test World","day":1}');
    assert.equal(workspaceSnapshot['/notes/brief.md'].workspaceId, `realm:${realm.id}:global`);
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 8. Seed into a member workspace + operator-attributed directive
// ============================================================================

test('8. seeding a member writes its private workspace and delivers the directive under the host operator principal', async () => {
  const store = await createOperatorStore();
  try {
    registerOfflinePreset(store);
    const { realm } = await store.launchRealmFromTemplate('demo', {
      presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
    });
    const coordinatorId = 'coordinator';

    const receipt = store.seedRealm({
      realmId: realm.id,
      targetAgentId: coordinatorId,
      files: [{ path: '/orders/one.md', content: 'Order one: open the session.' }],
      directive: 'Begin the seeded session.'
    });

    assert.equal(receipt.workspace, coordinatorId, "the target member's private workspace receives the files");
    assert.deepEqual(receipt.writtenPaths, ['/orders/one.md']);
    assert.equal(receipt.directiveDelivered, true, 'the operator-attributed directive delivers');

    const memberSnapshot = store.fsSnapshot[`realm:${realm.id}:${coordinatorId}`];
    assert.ok(memberSnapshot, "the member's private workspace exists after the seed (realm-qualified identity key, Wave I d57cbc1)");
    assert.equal(memberSnapshot['/orders/one.md'].content, 'Order one: open the session.');

    const delivered = store.messages.filter((message) => message.content === 'Begin the seeded session.');
    assert.equal(delivered.length, 1, 'exactly one directive envelope is archived');
    assert.equal(delivered[0].from, 'human', 'the non-agent label rides the host operator principal, never a caller claim');
    assert.equal(delivered[0].to, coordinatorId);
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 9. Seed validation (fail-closed, before the first write)
// ============================================================================

test('9. seed validation rejects unknown realms/targets, traversal, duplicates, reserved workspaces, and target-less directives', async () => {
  const store = await createOperatorStore();
  try {
    registerOfflinePreset(store);
    const { realm } = await store.launchRealmFromTemplate('demo', {
      presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
    });
    const coordinatorId = 'coordinator';

    // Unknown realm.
    expectThrow(
      () => store.seedRealm({ realmId: 'realm_missing_b2', files: [{ path: '/a.md', content: 'a' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /not registered/
    );

    // Unknown target agent.
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, targetAgentId: 'ghost', files: [{ path: '/a.md', content: 'a' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND,
      /not an active agent/
    );

    // Active agent that is not a member of the realm.
    await store.launchAgent({ id: 'loose-outsider', name: 'Outsider', role: 'worker', allowedTools: ['read_file'] });
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, targetAgentId: 'loose-outsider', files: [{ path: '/a.md', content: 'a' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /not an active member/
    );

    // Recycled member cannot be seeded.
    assert.equal(store.killAgent(`worker`), true);
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, targetAgentId: `worker`, files: [{ path: '/a.md', content: 'a' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND,
      /not an active agent/
    );

    // Traversal, root, duplicates, empty lists, and non-string content.
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, files: [{ path: '/../escape.md', content: 'x' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /path traversal/
    );
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, files: [{ path: '/', content: 'x' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /workspace root/
    );
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, files: [{ path: '/a.md', content: 'a' }, { path: 'a.md', content: 'b' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /duplicates an earlier file/
    );
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, files: [] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /non-empty files array/
    );
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, files: [{ path: '/a.md', content: { not: 'a string' } }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /content must be a string/
    );

    // A directive needs an explicit member target.
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, files: [{ path: '/a.md', content: 'a' }], directive: 'Go.' }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /requires a targetAgentId/
    );

    // Reserved-workspace targets fail closed (operator-launched reserved pin).
    await store.launchAgent({
      id: 'reserved-member',
      name: 'Reserved member',
      role: 'worker',
      realmId: realm.id,
      workspaceId: 'global',
      allowedTools: ['read_file']
    });
    expectThrow(
      () => store.seedRealm({ realmId: realm.id, targetAgentId: 'reserved-member', files: [{ path: '/a.md', content: 'a' }] }),
      SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      /reserved workspace/
    );

    // An empty/whitespace directive counts as absent and writes normally.
    const receipt = store.seedRealm({
      realmId: realm.id,
      targetAgentId: coordinatorId,
      files: [{ path: '/valid.md', content: 'valid' }],
      directive: '   '
    });
    assert.equal(receipt.directiveDelivered, false);
    assert.equal(store.fsSnapshot[`realm:${realm.id}:${coordinatorId}`]['/valid.md'].content, 'valid');

    // Rejected requests wrote nothing: the realm-global workspace was never created.
    assert.equal(store.fsSnapshot[`realm:${realm.id}:global`], undefined, 'rejected seeds never touch the workspace');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 10. Reserved workspace prefix rejection (V18 F-V18-1)
// ============================================================================

test('10. seed file paths naming the reserved global/public prefixes are rejected before any write, never re-rooted', async () => {
  const store = await createOperatorStore();
  try {
    registerOfflinePreset(store);
    const { realm } = await store.launchRealmFromTemplate('demo', {
      presetBindings: { coordinator: OFFLINE_PRESET_ID, worker: OFFLINE_PRESET_ID }
    });
    const coordinatorId = 'coordinator';
    const realmGlobalKey = `realm:${realm.id}:global`;

    // The legacy VirtualFS prefix routing sends any `/global/...` or
    // `/public/...` write to the ungrouped shared `global` workspace whatever
    // workspace was requested, so such seed paths must be rejected up front.
    const cases = [
      {
        name: 'member-targeted /global/ prefix',
        input: {
          realmId: realm.id,
          targetAgentId: coordinatorId,
          files: [{ path: '/global/member-leak.md', content: 'MEMBER-LEAK' }]
        }
      },
      {
        name: 'realm-global /public/ prefix',
        input: {
          realmId: realm.id,
          files: [{ path: '/public/realm-leak.md', content: 'REALM-LEAK' }]
        }
      },
      {
        name: 'backslash form of the /global/ prefix',
        input: {
          realmId: realm.id,
          targetAgentId: coordinatorId,
          files: [{ path: '\\global\\member-leak.md', content: 'MEMBER-LEAK' }]
        }
      },
      {
        name: 'bare reserved root',
        input: {
          realmId: realm.id,
          files: [{ path: '/global', content: 'MEMBER-LEAK' }]
        }
      }
    ];
    for (const scenario of cases) {
      expectThrow(
        () => store.seedRealm(scenario.input),
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
        /reserved workspace/i
      );
    }

    // Nothing landed anywhere: neither the selected workspaces nor the legacy
    // shared `global` workspace the legacy routing would have picked.
    const legacyGlobal = store.fsSnapshot['global'] || {};
    assert.equal(
      legacyGlobal['/member-leak.md'],
      undefined,
      'the legacy shared global workspace never receives the diverted member seed'
    );
    assert.equal(
      legacyGlobal['/realm-leak.md'],
      undefined,
      'the legacy shared global workspace never receives the diverted realm-global seed'
    );
    assert.equal(
      (store.fsSnapshot[`realm:${realm.id}:${coordinatorId}`] || {})['/global/member-leak.md'],
      undefined,
      'the member workspace never receives the rejected path'
    );
    assert.equal(
      (store.fsSnapshot[realmGlobalKey] || {})['/public/realm-leak.md'],
      undefined,
      'the realm-global workspace never receives the rejected path'
    );
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 11. Realm-local uniqueness: same-id instantiations are independent, never suffixed
// ============================================================================

test('11. a second template launch of the same plain ids lands in its own realm; same-realm duplicates stay denied', async () => {
  const store = await createOperatorStore();
  try {
    const first = await store.launchRealmFromTemplate('demo');
    const second = await store.launchRealmFromTemplate('demo');

    assert.notEqual(second.realm.id, first.realm.id, 'each instantiation creates its own realm record');
    assert.deepEqual(
      second.agents.map((agent) => agent.id),
      ['coordinator', 'worker'],
      'the second instantiation resolves the same plain member ids'
    );
    for (const agent of second.agents) {
      assert.equal(agent.config.realmId, second.realm.id, 'the second receipt member carries its own realm membership');
    }
    for (const agent of first.agents) {
      assert.equal(agent.config.realmId, first.realm.id, 'the first realm members stay bound to the first realm');
    }

    // Each literal id carries one distinct registration per realm.
    for (const id of ['coordinator', 'worker']) {
      const firstRealm = store.agents.filter((agent) => agent.id === id && agent.config.realmId === first.realm.id);
      const secondRealm = store.agents.filter((agent) => agent.id === id && agent.config.realmId === second.realm.id);
      assert.equal(firstRealm.length, 1, `${id}: the first realm carries exactly its own registration`);
      assert.equal(secondRealm.length, 1, `${id}: the second realm carries exactly its own registration`);
      assert.notEqual(firstRealm[0], secondRealm[0], `${id}: the two realm registrations are distinct`);
    }
    assert.ok(
      !store.agents.some((agent) => /^(coordinator|worker)-\d+$/.test(agent.id)),
      'instantiations are never auto-suffixed'
    );
    assert.equal(store.recycleBin.length, 0, 'both instantiations stay active, no recycle residue');

    // Realm-local uniqueness: a same-realm duplicate stays denied.
    await assert.rejects(
      () => store.launchAgent({
        id: 'coordinator',
        name: 'Duplicate coordinator',
        realmId: second.realm.id,
        allowedTools: ['read_file']
      }),
      (err) => err.code === 'AGENT_ALREADY_EXISTS',
      'a duplicate inside the target realm is still denied'
    );
    assert.equal(
      store.agents.filter((agent) => agent.id === 'coordinator' && agent.config.realmId === second.realm.id).length,
      1,
      'the denied duplicate leaves exactly the launched registration'
    );
    assert.equal(store.recycleBin.length, 0, 'a denied duplicate leaves no recycle residue');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 12. Wave C: input values + bundle files forward into the member prompts
// ============================================================================

test('12. launch input values forward to materialization: bundle files resolve, defaults apply, explicit values win', async () => {
  const store = await createOperatorStore([FIXTURE_BUNDLE]);
  try {
    registerOfflinePreset(store);
    const receipt = await store.launchRealmFromTemplate('c4-fixture', {
      name: 'Inputs Realm',
      inputValues: { mandate: 'M' }
    });

    assert.equal(receipt.realm.templateId, 'c4-fixture');
    assert.deepEqual(receipt.agents.map((agent) => agent.id), ['c4-lead', 'c4-scribe']);

    const lead = store.agents.find((agent) => agent.id === 'c4-lead');
    assert.equal(
      lead.config.systemPrompt,
      FIXTURE_LEAD_PROMPT,
      'the launch composes bundle files + defaults + explicit input values in declared order'
    );
    const scribe = store.agents.find((agent) => agent.id === 'c4-scribe');
    assert.equal(scribe.config.systemPrompt, 'Scribe protocol.');

    assert.equal(
      store.getRealmTemplateBundle('c4-fixture').files['prompts/lead.md'],
      'Lead protocol body.',
      'the launcher preview seam exposes the same bundle files the launch resolved'
    );
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 13. Wave C: the template seed runs per target after members launch
// ============================================================================

test('13. the template seed runs after members launch: realm-global and per-member files plus the operator directive', async () => {
  const store = await createOperatorStore([FIXTURE_BUNDLE]);
  try {
    registerOfflinePreset(store);
    const { realm } = await store.launchRealmFromTemplate('c4-fixture', { inputValues: { mandate: 'M' } });
    const realmGlobalKey = `realm:${realm.id}:global`;

    assert.equal(
      store.fsSnapshot[realmGlobalKey]['/notes/realm.md'].content,
      'Realm-wide note.',
      'realm-targeted files land in the Realm-global workspace'
    );
    assert.equal(
      store.fsSnapshot[`realm:${realm.id}:c4-lead`]['/orders/one.md'].content,
      'Order one.',
      'the lead target resolves the template key to the launched member id'
    );
    assert.equal(
      store.fsSnapshot[`realm:${realm.id}:c4-scribe`]['/lore/world.md'].content,
      'World lore.',
      'the scribe target resolves independently'
    );

    const delivered = store.messages.filter((message) => message.content === 'Begin the seeded session.');
    assert.equal(delivered.length, 1, 'exactly one directive envelope is archived');
    assert.equal(delivered[0].from, 'human', 'the directive rides the host operator principal');
    assert.equal(delivered[0].to, 'c4-lead', 'the directive target resolves through the template agent key');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 14. Wave C: the seed toggle skips the template seed entirely
// ============================================================================

test('14. seed: false skips the template seed entirely; the manual seed step stays available', async () => {
  const store = await createOperatorStore([FIXTURE_BUNDLE]);
  try {
    registerOfflinePreset(store);
    const { realm } = await store.launchRealmFromTemplate('c4-fixture', {
      inputValues: { mandate: 'M' },
      seed: false
    });
    const realmGlobalKey = `realm:${realm.id}:global`;

    assert.equal(store.fsSnapshot[realmGlobalKey], undefined, 'no realm-global workspace is created');
    assert.equal(
      store.fsSnapshot[`realm:${realm.id}:c4-lead`],
      undefined,
      'no member seed files are written (realm-qualified identity key, Wave I d57cbc1)'
    );
    assert.equal(
      store.messages.filter((message) => message.content === 'Begin the seeded session.').length,
      0,
      'no directive is delivered'
    );

    // The manual seed surface still works against the launched Realm.
    const receipt = store.seedRealm({
      realmId: realm.id,
      files: [{ path: '/notes/manual.md', content: 'Manual note.' }]
    });
    assert.deepEqual(receipt.writtenPaths, ['/notes/manual.md']);
    assert.equal(store.fsSnapshot[realmGlobalKey]['/notes/manual.md'].content, 'Manual note.');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 15. Wave C: a required input that resolves empty fails the launch closed
// ============================================================================

test('15. a required input that resolves empty rejects the launch before any member exists', async () => {
  const store = await createOperatorStore([FIXTURE_BUNDLE]);
  try {
    registerOfflinePreset(store);
    const realmsBefore = store.realms.map((realm) => realm.id);

    let failure = null;
    try {
      await store.launchRealmFromTemplate('c4-fixture');
    } catch (err) {
      failure = err;
    }

    assert.ok(failure, 'the missing required input must fail the launch');
    assert.equal(failure.code, 'ERR_STORE_REALM_LAUNCH_FAILED');
    assert.equal(failure.rolledBack, true);
    assert.deepEqual(failure.terminatedMembers, [], 'materialization failed before any member launched');
    assert.match(String(failure.cause && failure.cause.message), /required and resolves empty/);
    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'no realm record survives');
    assert.equal(store.agents.filter((agent) => agent.id !== 'director').length, 0, 'no member survives');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 16. Wave C: a failed template seed rolls back and evicts written seed files
// ============================================================================

test('16. a failed template seed rolls the whole launch back and evicts the files already written', async () => {
  const store = await createOperatorStore([FAILING_SEED_BUNDLE]);
  try {
    registerOfflinePreset(store);
    const realmsBefore = store.realms.map((realm) => realm.id);
    const agentsBefore = store.agents.map((agent) => agent.id).sort();

    let failure = null;
    try {
      await store.launchRealmFromTemplate('c4-fixture-failing', { inputValues: { mandate: 'M' } });
    } catch (err) {
      failure = err;
    }

    assert.ok(failure, 'the reserved-root seed path must fail the launch');
    assert.equal(failure.code, 'ERR_STORE_REALM_LAUNCH_FAILED');
    assert.equal(failure.rolledBack, true, 'the rollback completed without failures');
    assert.equal(failure.failedAgentId, null, 'a seed-phase failure names no agent');
    assert.deepEqual(failure.rollbackFailures, []);
    assert.deepEqual(
      [...failure.terminatedMembers].sort(),
      ['c4r-lead', 'c4r-scribe'],
      'both launched members were purged by the rollback'
    );
    assert.deepEqual(
      failure.evictedSeedFiles,
      ['/notes/realm.md'],
      'the realm-global file already written by the seed attempt was evicted'
    );
    assert.equal(failure.cause.code, SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
    assert.match(String(failure.cause.message), /addresses the reserved workspace prefix/);

    assert.deepEqual(store.realms.map((realm) => realm.id), realmsBefore, 'no realm record survives');
    assert.deepEqual(store.agents.map((agent) => agent.id).sort(), agentsBefore, 'no member survives');
    assert.equal(store.recycleBin.length, 0, 'rolled-back members are purged, never recycled');

    const residue = store.fsSnapshot[`realm:${failure.realmId}:global`] || {};
    assert.equal(residue['/notes/realm.md'], undefined, 'no seeded realm-global file survives the rollback');
    assert.equal(
      store.fsSnapshot[`realm:${failure.realmId}:c4r-lead`],
      undefined,
      "the purged member's workspace (and any seed files) is evicted"
    );
    assert.equal(
      store.messages.filter((message) => message.content === 'Begin the failing session.').length,
      0,
      'the directive was never delivered'
    );
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 17. the embedded example_agent bundle launches from bundle files
// ============================================================================

/**
 * Baked template id for the embedded reference bundle. This case pins the
 * pipeline wiring, never the bundle wording.
 */
const BAKED_EXAMPLE_TEMPLATE_ID = 'example_agent';

test('17. the default store carries the embedded example_agent bundle and composes its prompt from bundle files', async () => {
  const store = await createOperatorStore();
  try {
    const templateIds = store.listRealmTemplates().map((template) => template.id);
    assert.equal(templateIds[0], DEMO_TEMPLATE.id, 'the demo fixture stays first in the picker');
    assert.ok(
      templateIds.includes(BAKED_EXAMPLE_TEMPLATE_ID),
      'the embedded bundle is registered in the default launch catalog'
    );

    const bundle = store.getRealmTemplateBundle(BAKED_EXAMPLE_TEMPLATE_ID);
    assert.ok(bundle, 'the embedded bundle resolves through the store seam');
    assert.equal(bundle.template.id, BAKED_EXAMPLE_TEMPLATE_ID);
    assert.equal(
      typeof bundle.files['prompts/protocol.md'],
      'string',
      'the protocol file body is embedded'
    );
    assert.equal(
      typeof bundle.files['inputs/house_style.md'],
      'string',
      'the defaultFile prefill body is embedded'
    );

    const inputValues = {
      briefing: 'The probe briefing.',
      directives: 'The probe directives.'
    };
    const expected = materializeTemplate(bundle.template, {
      realmId: 'realm_probe',
      inputValues,
      bundleFiles: bundle.files
    });

    const receipt = await store.launchRealmFromTemplate(BAKED_EXAMPLE_TEMPLATE_ID, { inputValues });
    assert.equal(receipt.realm.templateId, BAKED_EXAMPLE_TEMPLATE_ID);
    assert.deepEqual(receipt.agents.map((agent) => agent.id), ['assistant']);

    const assistant = store.agents.find((agent) => agent.id === 'assistant');
    assert.ok(assistant, 'the assistant member launched');
    assert.equal(assistant.config.realmId, receipt.realm.id);
    assert.equal(assistant.config.privileged, false);
    assert.deepEqual(
      expected.agents[0].toolProfile,
      { preset: null, tools: [] },
      'the explicit empty tools profile resolves to zero grants with no preset'
    );
    assert.deepEqual(assistant.config.allowedTools, [], 'the launched assistant carries zero tool grants');
    assert.equal(
      assistant.config.systemPrompt,
      expected.agents[0].systemPrompt,
      'the launched prompt equals the catalog materialization of the same embedded bundle'
    );

    const prompt = assistant.config.systemPrompt;
    assert.ok(
      prompt.startsWith(bundle.files['prompts/protocol.md']),
      'the protocol file body opens the composed prompt'
    );
    assert.ok(prompt.includes('The probe briefing.'), 'the briefing launch value is composed');
    assert.ok(prompt.includes('The probe directives.'), 'the directives launch value is composed');
    assert.ok(
      prompt.includes(bundle.files['inputs/house_style.md']),
      'the house_style defaultFile prefill resolves from the embedded bundle file'
    );
    assert.deepEqual(expected.agents[0].inputProvenance, [
      { inputId: 'briefing', source: 'launch' },
      { inputId: 'directives', source: 'launch' },
      { inputId: 'house_style', source: 'defaultFile' }
    ]);
    assert.ok(!('seed' in expected), 'the bundle declares no seed');
  } finally {
    store.destroy();
  }
});
