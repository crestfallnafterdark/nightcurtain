/**
 * @file tests/integration/template_capability_hydration_test.js
 * @description Ticket 6a0282b red-first repro: reload hydration must keep the
 *   tool/privilege axis of template-launched realm members.
 *
 *   Live evidence (`data/qa/bug-repros/gen-run-resume-schema-evidence.txt`):
 *   after ONE reload the `session_zero` Architect/Genesis carried
 *   `privileged:false`, `allowedTools:[]`, and a schema with no
 *   `write_file`/`send_message`, while the realm's `session_zero` spec
 *   declared `privileged:true` + a multi-tool profile and the persisted member
 *   records carried no selectors at all (the withheld snapshot state was
 *   persisted after a skipped same-literal-id heal).
 *
 *   Asserted contract:
 *   1. a template realm member's `privileged` flag is re-derived from the
 *      trusted template provenance on hydration (the snapshot never carries
 *      it), and the persisted tool selectors heal onto the runtime descriptor;
 *   2. same-literal-id members of two realms launched from one template
 *      restore realm-exactly, including a member whose persisted record lost
 *      its selectors (F8) — only that member is repaired;
 *   3. a skipped/failed capability heal never overwrites persisted selectors
 *      with the degraded empty state (last-known-good selectors survive the
 *      next serialization).
 *
 * Zero-Mock Verification: every engine class (store, runtime, VirtualFS,
 * messaging bus, realm registry, persistence module) is the real production
 * class; hydration runs through the real `saveSandboxState`/`autoHydrate`
 * path with the shared LocalStorage emulation and no fixture triggers a model
 * turn.
 *
 * Standalone: `timeout 180 node tests/integration/template_capability_hydration_test.js`
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { serializeTemplateBundle } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { loadSandboxState, saveSandboxState } from '../../src/lib/sandbox/sandboxPersistence/index.ts';

/** Fixture template id. */
const CAPABILITY_TEMPLATE_ID = 'cap-hydration-fixture';

/** Architect's declared internal tool profile (privileged member). */
const ARCHITECT_TOOLS = Object.freeze(['read_file', 'write_file', 'send_message']);

/** Genesis's declared internal tool profile (unprivileged member). */
const GENESIS_TOOLS = Object.freeze(['read_file', 'send_message']);

/**
 * Builds the capability fixture: one privileged multi-tool member and one
 * unprivileged member, both with literal realm-local ids so two launches of
 * the same template register the same literal ids in two realms.
 *
 * @returns {object} Format-v2 template spec.
 */
function createCapabilityTemplate() {
  return {
    formatVersion: 2,
    id: CAPABILITY_TEMPLATE_ID,
    name: 'Capability Hydration Fixture',
    description: 'Ticket 6a0282b reload capability fixture.',
    agents: [
      {
        key: 'architect',
        idPattern: 'architect',
        name: 'Architect',
        role: 'author',
        prompt: [{ kind: 'text', text: 'You author templates.' }],
        toolProfile: { tools: [...ARCHITECT_TOOLS] },
        privileged: true
      },
      {
        key: 'genesis',
        idPattern: 'genesis',
        name: 'Genesis',
        role: 'hydrator',
        prompt: [{ kind: 'text', text: 'You hydrate payloads.' }],
        toolProfile: { tools: [...GENESIS_TOOLS] },
        privileged: false
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

/**
 * Imports the fixture template through the real store import path and returns
 * a ready-to-launch store.
 *
 * @param {object} store - Fixture store.
 * @returns {object} The same store.
 */
function importCapabilityFixture(store) {
  store.importRealmTemplate(serializeTemplateBundle({ template: createCapabilityTemplate(), files: {} }));
  return store;
}

/**
 * Resolves one member's canonical identity projection.
 *
 * @param {object} runtime - Fixture runtime.
 * @param {string} realmId - Realm id.
 * @param {string} agentId - Realm-local member id.
 * @returns {object} Identity projection.
 */
function memberIdentity(runtime, realmId, agentId) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity(agentId, { realmId });
  assert.ok(identity, `member '${agentId}' must resolve realm-exactly in '${realmId}'`);
  return identity;
}

/**
 * Runs the member's `whoami` through a real tool dispatcher bound to the
 * canonical registration (the production turn binding shape).
 *
 * @param {object} runtime - Fixture runtime.
 * @param {string} identityKey - Canonical identity key.
 * @param {string} agentId - Realm-local member id.
 * @returns {Promise<object>} whoami receipt.
 */
async function memberWhoami(runtime, identityKey, agentId) {
  const dispatcher = createSandboxToolDispatcher({
    runtime,
    agentId,
    callerKey: identityKey,
    lifecyclePort: runtime.createLifecyclePort()
  });
  const receipt = await dispatcher.executeTool('whoami', {});
  assert.equal(receipt.success, true, `whoami must succeed: ${JSON.stringify(receipt)}`);
  return receipt;
}

/**
 * Asserts the runtime descriptor carries the template tool profile and the
 * declared privilege (the runtime descriptor is wildcard-only for a
 * privileged agent by design; the declared profile stays on the legacy
 * `allowedTools` projection and the entity config).
 *
 * @param {object} identity - Identity projection.
 * @param {readonly string[]} expectedTools - Declared internal tool names.
 * @param {boolean} expectedPrivileged - Declared privilege flag.
 * @param {string} label - Assertion label.
 */
function assertCapability(identity, expectedTools, expectedPrivileged, label) {
  assert.equal(identity.privileged, expectedPrivileged, `${label}: privileged flag must match the template`);
  const allow = [...identity.authority.allow];
  assert.equal(
    allow.includes('*'),
    expectedPrivileged,
    `${label}: wildcard authority must follow the template privilege (got ${JSON.stringify(allow)})`
  );
  if (!expectedPrivileged) {
    for (const tool of expectedTools) {
      assert.ok(allow.includes(tool), `${label}: descriptor must keep '${tool}' (got ${JSON.stringify(allow)})`);
    }
  }
  assert.deepEqual(
    [...identity.allowedTools].sort(),
    [...expectedTools].sort(),
    `${label}: the declared tool profile must survive (got ${JSON.stringify(identity.allowedTools)})`
  );
}

/** Clears the shared storage before every leg. */
function freshStorage() {
  sharedLocalStorage.clear();
}

test('1. template-backed privilege and tool profile survive one reload', async () => {
  freshStorage();
  const { runtime, store } = createFixtureStore();
  importCapabilityFixture(store);
  const launched = await store.launchRealmFromTemplate(CAPABILITY_TEMPLATE_ID, { seed: false });
  const realmId = launched.realm.id;

  // Live launch truth: the declared profile is effective before any reload.
  const liveIdentity = memberIdentity(runtime, realmId, 'architect');
  assertCapability(liveIdentity, ARCHITECT_TOOLS, true, 'live launch');

  assert.equal(store.saveToStorage(), true, 'the launched realm must persist');
  const restored = createFixtureStore({ autoHydrate: true });

  const architect = memberIdentity(restored.runtime, realmId, 'architect');
  assertCapability(architect, ARCHITECT_TOOLS, true, 'hydrated architect');
  const genesis = memberIdentity(restored.runtime, realmId, 'genesis');
  assertCapability(genesis, GENESIS_TOOLS, false, 'hydrated genesis');

  const heal = restored.store.capabilityHealReport;
  assert.ok(heal, 'hydration publishes the capability heal report');
  assert.equal(heal.failed, 0, `no heal failure: ${JSON.stringify(heal.entries)}`);
  assert.equal(heal.skipped, 0, `no heal skip: ${JSON.stringify(heal.entries)}`);

  // Agent-facing projection (the F8 receipt shape): whoami must report the
  // restored privilege and tool list, not `privileged:false, allowedTools:[]`.
  const whoami = await memberWhoami(restored.runtime, architect.key, 'architect');
  assert.equal(whoami.privileged, true, `whoami must report template privilege: ${JSON.stringify(whoami)}`);
  assert.deepEqual(
    [...whoami.allowedTools].sort(),
    [...ARCHITECT_TOOLS].sort(),
    `whoami must report the healed tool profile: ${JSON.stringify(whoami)}`
  );
});

test('2. same-literal-id members of two realms restore realm-exactly, including a degraded record', async () => {
  freshStorage();
  const { store } = createFixtureStore();
  importCapabilityFixture(store);
  const first = await store.launchRealmFromTemplate(CAPABILITY_TEMPLATE_ID, { seed: false });
  const second = await store.launchRealmFromTemplate(CAPABILITY_TEMPLATE_ID, { seed: false });
  const firstRealmId = first.realm.id;
  const secondRealmId = second.realm.id;
  assert.notEqual(firstRealmId, secondRealmId, 'the fixture launches two distinct realms');

  // Reproduce the F8 loss on exactly one registration: the second realm's
  // architect record is persisted without any capability selector (the
  // pre-fix skipped-heal snapshot state). The other records keep theirs.
  const snapshot = store.serialize();
  const degraded = snapshot.agents.find(
    (entry) => entry.id === 'architect' && entry.config?.realmId === secondRealmId
  );
  assert.ok(degraded, 'the second realm architect record is present');
  delete degraded.config.allowedTools;
  delete degraded.config.extensionTools;
  assert.equal(saveSandboxState(snapshot), true, 'the degraded snapshot persists');

  const restored = createFixtureStore({ autoHydrate: true });
  const firstArchitect = memberIdentity(restored.runtime, firstRealmId, 'architect');
  const secondArchitect = memberIdentity(restored.runtime, secondRealmId, 'architect');
  assert.notEqual(firstArchitect.key, secondArchitect.key, 'same-literal-id members keep distinct canonical keys');
  assert.equal(firstArchitect.realmId, firstRealmId);
  assert.equal(secondArchitect.realmId, secondRealmId);

  assertCapability(firstArchitect, ARCHITECT_TOOLS, true, 'first realm architect');
  assertCapability(secondArchitect, ARCHITECT_TOOLS, true, 'second realm architect (repair)');
  assertCapability(memberIdentity(restored.runtime, firstRealmId, 'genesis'), GENESIS_TOOLS, false, 'first realm genesis');
  assertCapability(memberIdentity(restored.runtime, secondRealmId, 'genesis'), GENESIS_TOOLS, false, 'second realm genesis');

  const heal = restored.store.capabilityHealReport;
  assert.ok(heal, 'hydration publishes the capability heal report');
  assert.equal(heal.failed, 0, `no heal failure: ${JSON.stringify(heal.entries)}`);
  assert.equal(heal.skipped, 0, `no same-literal-id member may be skipped: ${JSON.stringify(heal.entries)}`);

  // The repair is durable: a save after the heal persists the derived
  // selectors instead of the degraded empty state.
  assert.equal(restored.store.saveToStorage(), true, 'the repaired session persists');
  const roundTrip = loadSandboxState();
  const repaired = roundTrip.agents.find(
    (entry) => entry.id === 'architect' && entry.config?.realmId === secondRealmId
  );
  assert.deepEqual(
    [...repaired.config.allowedTools].sort(),
    [...ARCHITECT_TOOLS].sort(),
    'the repaired selectors must reach the persisted record'
  );
});

test('3. a skipped capability heal never overwrites persisted selectors with empty', async () => {
  freshStorage();
  const { store } = createFixtureStore();
  importCapabilityFixture(store);
  const launched = await store.launchRealmFromTemplate(CAPABILITY_TEMPLATE_ID, { seed: false });
  const realmId = launched.realm.id;
  assert.equal(store.saveToStorage(), true, 'the launched realm must persist');

  // Force a real heal skip: pad the member's persisted membership so the
  // captured (trimmed) canonical target cannot resolve the live registration,
  // while the persisted selectors stay intact.
  const paddedRealmId = `  ${realmId}  `;
  const snapshot = store.serialize();
  const architectRecord = snapshot.agents.find((entry) => entry.id === 'architect');
  assert.ok(architectRecord, 'the architect record is present');
  architectRecord.config.realmId = paddedRealmId;
  assert.equal(saveSandboxState(snapshot), true, 'the padded snapshot persists');

  const restored = createFixtureStore({ autoHydrate: true });
  const heal = restored.store.capabilityHealReport;
  assert.ok(heal, 'hydration publishes the capability heal report');
  const skipped = heal.entries.find((entry) => entry.agentId === 'architect' && entry.outcome === 'skipped');
  assert.ok(skipped, `the architect heal must genuinely skip: ${JSON.stringify(heal.entries)}`);

  // The skip leaves the live runtime default-deny (the degraded F8 state) ...
  const liveKey = createAgentIdentityKey(paddedRealmId, 'architect');
  const liveAgent = restored.runtime.getAgent(liveKey);
  assert.ok(liveAgent, 'the padded-registration agent restores under its exact key');
  assert.equal(liveAgent.config.allowedTools, undefined, 'the skipped heal leaves the live selector withheld');

  // ... but the next serialization must keep the last-known-good selectors
  // rather than persisting the degraded empty state.
  assert.equal(restored.store.saveToStorage(), true, 'the post-skip save succeeds');
  const roundTrip = loadSandboxState();
  const persisted = roundTrip.agents.find((entry) => entry.id === 'architect');
  assert.ok(persisted, 'the architect record must survive the post-skip save');
  assert.ok(
    Array.isArray(persisted.config.allowedTools),
    `the persisted selector must survive a skipped heal (got ${JSON.stringify(persisted.config.allowedTools)})`
  );
  assert.deepEqual(
    [...persisted.config.allowedTools].sort(),
    [...ARCHITECT_TOOLS].sort(),
    'the persisted selector stays the last-known-good template profile'
  );
});
