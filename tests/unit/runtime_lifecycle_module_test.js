/**
 * @file tests/unit/runtime_lifecycle_module_test.js
 * @description Comprehensive isolated unit and contract test suite for Module 9: runtime_lifecycle.
 *
 * Verifies strict ICD compliance and architectural guarantees:
 *   1. Strict Export Whitelist & Constant Immutability
 *   2. Pure Agent Domain Entity & Universal ModelConfig Composition (INV-1)
 *   3. Agent Launching & Security Privilege Gating (SEC-1, SEC-2)
 *   4. Formal 9-State Finite State Machine (FSM) Governance & Validation (INV-2)
 *   5. Soft-Kill Recycle Bin Workflows with Subsystem Teardown (INV-4 / INV-KILL)
 *   6. Agent Restoration from Recycle Bin (INV-RESTORE)
 *   7. Permanent Purging across Bus, Filesystem, Timers, and Memory (INV-PURGE)
 *   8. Emergency Turn Unsticking & Stream Reset Engine (INV-UNSTICK)
 *   9. Live Dynamic Configuration & System Prompt Synchronization (INV-8 / INV-CONFIG-SYNC)
 *  10. In-Place Conversational Message Mutation & Identity (INV-MSG-MUTATION, INV-MSG-IDENTITY)
 *  11. Cascading Tool-Pairing Hygiene Deletion (INV-5 / INV-TOOL-HYGIENE)
 *  12. Dual-Stack Undo/Redo with Atomic TurnBundle Snapshotting (INV-6 / INV-UNDO-BUNDLE)
 *  13. Mid-Turn Error Recovery & Context Preservation (INV-7 / INV-HISTORY-PRESERVE)
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as AgentModule from '../../src/lib/sandbox/runtime/agent/index.ts';
import * as AgentLifecycleModule from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import * as HistoryManagerModule from '../../src/lib/sandbox/runtime/historyManager/index.ts';

import {
  Agent,
  AGENT_STATES,
  generateMessageId,
  ensureHistoryMessageIds,
  getGlobalModelConfig
} from '../../src/lib/sandbox/runtime/agent/index.ts';
import { AgentLifecycleManager } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { HistoryManager } from '../../src/lib/sandbox/runtime/historyManager/index.ts';
import { createAgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { InferenceError } from '../../src/lib/sandbox/inference/index.ts';
import { getDefaultModelConfig } from '../../src/lib/sandbox/modelConfig/index.ts';
import { SCHEDULER_STATUS } from '../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';

/**
 * Canonical registration key of a launch that composes no explicit realm
 * (every ordinary launch lands in the Generic default; Wave I, d57cbc1).
 * Bus/mail/VFS lifecycle teardown now addresses registrations by this key.
 * @param {string} id - Realm-local agent id.
 * @returns {string} Canonical `(realmId, agentId)` identity key.
 */
const genericKey = (id) => createAgentIdentityKey('realm_generic', id);

/**
 * MOD-21 test principal: an opaque-in-spirit internal principal injected at
 * trusted construction. Caller-time plain objects cannot impersonate it because
 * the manager trusts only this exact reference.
 */
const TEST_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test-operator' });

/**
 * Serializes the identity-bearing fields of a recycled record so a denied
 * launch can be pinned to leave it byte-identical (e6f10db V8 minor
 * observation).
 * @param {object|null|undefined} record
 * @returns {string}
 */
function recycledRecordFingerprint(record) {
  return JSON.stringify({
    id: record?.id,
    state: record?.state,
    recycledAt: record?.recycledAt,
    recycleReason: record?.recycleReason,
    workspaceId: record?.config?.workspaceId,
    workspace: record?.config?.workspace,
    spawnedBy: record?.config?.spawnedBy,
    creatorId: record?.config?.creatorId,
    role: record?.config?.role,
    allowedTools: record?.config?.allowedTools
  });
}

// ============================================================================
// 1. Strict Export Whitelist & Constants Immutability
// ============================================================================

test('1. Strict Export Whitelist & Constants Immutability', () => {
  const agentExports = Object.keys(AgentModule).sort();
  assert.deepStrictEqual(
    agentExports,
    [
      'AGENT_STATES',
      'Agent',
      'createAgentIdentityKey',
      'ensureHistoryMessageIds',
      'generateMessageId',
      'getGlobalModelConfig',
      'parseAgentIdentityKey'
    ].sort()
  );

  const lifecycleExports = Object.keys(AgentLifecycleModule).sort();
  assert.deepStrictEqual(
    lifecycleExports,
    ['AGENT_STATES', 'AgentLifecycleManager'].sort()
  );

  const historyExports = Object.keys(HistoryManagerModule).sort();
  assert.deepStrictEqual(
    historyExports,
    ['HistoryManager', 'ensureHistoryMessageIds', 'generateMessageId'].sort()
  );

  // AGENT_STATES Verification
  assert.strictEqual(AGENT_STATES.IDLE, 'idle');
  assert.strictEqual(AGENT_STATES.RUNNING, 'running');
  assert.strictEqual(AGENT_STATES.WAITING_FOR_INPUT, 'waiting_for_input');
  assert.strictEqual(AGENT_STATES.WAITING_FOR_DEPENDENTS, 'waiting_for_dependents');
  assert.strictEqual(AGENT_STATES.WAITING_FOR_MESSAGE, 'waiting_for_message');
  assert.strictEqual(AGENT_STATES.CANCELING, 'canceling');
  assert.strictEqual(AGENT_STATES.ERRORED, 'errored');
  assert.strictEqual(AGENT_STATES.TERMINATED, 'terminated');
  assert.strictEqual(AGENT_STATES.RECYCLED, 'recycled');
  assert.ok(Object.isFrozen(AGENT_STATES), 'AGENT_STATES must be frozen');
});

// ============================================================================
// 2. Pure Agent Domain Entity & Universal ModelConfig Composition (INV-1)
// ============================================================================

test('2. Agent Construction: Validates config, inherits ModelConfig, and initializes state', () => {
  // Config validation
  assert.throws(
    () => new Agent(null),
    (err) => err.code === 'INVALID_CONFIG',
    'Throws INVALID_CONFIG on null config'
  );
  assert.throws(
    () => new Agent({}),
    (err) => err.code === 'INVALID_CONFIG',
    'Throws INVALID_CONFIG on missing id'
  );
  assert.throws(
    () => new Agent({ id: '   ' }),
    (err) => err.code === 'INVALID_CONFIG',
    'Throws INVALID_CONFIG on blank id'
  );

  // Standard Agent construction
  const agent = new Agent({
    id: 'writer',
    name: 'Story Writer',
    systemPrompt: 'You are a narrative writer.',
    modelConfig: {
      temperature: 0.8
    }
  });

  assert.strictEqual(agent.id, 'writer');
  assert.strictEqual(agent.name, 'Story Writer');
  assert.strictEqual(agent.state, AGENT_STATES.IDLE);
  assert.strictEqual(agent.stateDetail, null);
  assert.strictEqual(agent.turnCount, 0);
  assert.ok(agent.provider, 'Provider must be initialized');
  assert.ok(agent.model, 'Model must be initialized');
  assert.strictEqual(agent.modelConfig.temperature, 0.8);

  // Root system prompt initialization
  assert.strictEqual(agent.history.length, 1);
  assert.strictEqual(agent.history[0].role, 'system');
  assert.strictEqual(agent.history[0].content, 'You are a narrative writer.');
  assert.ok(agent.history[0].id.startsWith('sys_'), 'System prompt message must have sys_ prefix ID');

  // Telemetry initialized
  assert.deepStrictEqual(agent.telemetry, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    terminalStops: 0,
    injectedDeliveries: 0,
    precallCount: 0,
    lastSentContext: []
  });

  // Concrete Model Dependency Injection
  const mockProvider = {
    id: 'mock-provider',
    createModel: () => mockModel
  };
  const mockModel = {
    id: 'mock-model-1',
    provider: mockProvider
  };

  const diAgent = new Agent({ id: 'di-agent' }, mockModel, mockProvider);
  assert.strictEqual(diAgent.model, mockModel);
  assert.strictEqual(diAgent.provider, mockProvider);

  // updateModel
  const newMockModel = { id: 'mock-model-2', provider: mockProvider };
  diAgent.updateModel(newMockModel);
  assert.strictEqual(diAgent.model.id, 'mock-model-2');

  // Throws if model provided without provider
  assert.throws(
    () => new Agent({ id: 'bad-di' }, { id: 'no-provider-model' }, null),
    (err) => err.code === 'PROVIDER_INIT_FAILED'
  );
});

// ============================================================================
// 2a. Global Model Config Resolution: Catalog Master Default & Explicit Settings
// (legacy-retire T4: the sandbox no longer reads host globals)
// ============================================================================

test('2a. getGlobalModelConfig resolves the catalog master default and honors explicit settings', () => {
  assert.deepStrictEqual(
    getGlobalModelConfig(),
    getDefaultModelConfig(),
    'no explicit settings must resolve the model-catalog master default'
  );
  assert.deepStrictEqual(
    getGlobalModelConfig(null),
    getDefaultModelConfig(),
    'null settings must resolve the model-catalog master default'
  );

  const explicit = getGlobalModelConfig({
    modelConfig: {
      providerId: 'prem',
      keyId: 'canonical_prem',
      modelId: 'deepseek-v4-flash-abliterated',
      temperature: 0.1,
      reasoningEffort: 'low'
    }
  });
  assert.strictEqual(explicit.providerId, 'prem', 'explicit settings overlay wins over the catalog default');
  assert.strictEqual(explicit.keyId, 'canonical_prem');
  assert.strictEqual(explicit.modelId, 'deepseek-v4-flash-abliterated');
  assert.strictEqual(explicit.temperature, 0.1);
  assert.strictEqual(explicit.reasoningEffort, 'low');
});

// ============================================================================
// 2b. Interrupted-Turn Snapshot Round-Trip
// ============================================================================

test('2b. Agent snapshot round-trip preserves lastInterruptedTurn', () => {
  const agent = new Agent({ id: 'interrupt-snapshot-agent' });
  assert.strictEqual(agent.lastInterruptedTurn, null, 'Fresh agent starts with no interrupted turn');

  const interrupted = {
    input: 'Draft the opening scene',
    mode: 'chat',
    timestamp: 1773700000000,
    cancelled: true
  };
  agent.lastInterruptedTurn = interrupted;

  const snapshot = agent.toSnapshot();
  assert.deepStrictEqual(snapshot.lastInterruptedTurn, interrupted, 'toSnapshot emits the interrupted-turn record');

  const restored = Agent.fromSnapshot(snapshot);
  assert.deepStrictEqual(restored.lastInterruptedTurn, interrupted, 'fromSnapshot restores the record');

  // Deep copies: snapshot and restored records must not alias the entity record
  restored.lastInterruptedTurn.cancelled = false;
  restored.lastInterruptedTurn.input = 'MUTATED';
  assert.strictEqual(agent.lastInterruptedTurn.cancelled, true, 'Restored mutation does not reach the source entity');
  assert.strictEqual(agent.lastInterruptedTurn.input, 'Draft the opening scene');
  assert.strictEqual(snapshot.lastInterruptedTurn.cancelled, true, 'Decoded snapshot record stays isolated from the entity');

  // Constructor hydration path accepts the record as a config hydration field
  const hydrated = new Agent({ id: 'hydrated-interrupt-agent', lastInterruptedTurn: interrupted });
  assert.deepStrictEqual(hydrated.lastInterruptedTurn, interrupted);

  // Null round-trip
  const clearSnapshot = new Agent({ id: 'clear-interrupt-agent' }).toSnapshot();
  assert.strictEqual(clearSnapshot.lastInterruptedTurn, null);
  assert.strictEqual(Agent.fromSnapshot(clearSnapshot).lastInterruptedTurn, null);
});

// ============================================================================
// 2c. Authority Descriptor & Snapshot Trust Re-Derivation (MOD-21 W5, 43a36a1)
// ============================================================================

test('2c. Agent authority is built at construction, frozen, and default-deny on restore', () => {
  const privileged = new Agent({ id: 'authority-privileged-agent', privileged: true, allowedTools: ['*'] });
  assert.ok(Object.isFrozen(privileged.authority), 'authority descriptor must be frozen');
  assert.strictEqual(privileged.authority.subject, 'authority-privileged-agent');
  assert.strictEqual(privileged.authority.kind, 'agent');
  assert.strictEqual(privileged.authority.allow.has('*'), true, 'privileged construction grants the wildcard');
  assert.strictEqual(privileged.authority.visibility, 'all');
  assert.strictEqual(privileged.authorityDowngrade, null);

  const plain = new Agent({ id: 'authority-plain-agent', allowedTools: ['read_file'] });
  assert.strictEqual(plain.authority.allow.has('read_file'), true);
  assert.strictEqual(plain.authority.allow.has('*'), false);
  assert.strictEqual(plain.authority.visibility, 'owned');

  // Immutable after construction: mutators neutralized and property non-writable.
  assert.strictEqual(typeof plain.authority.allow.add, 'undefined', 'allow-set mutators must be neutralized');
  assert.throws(() => { plain.authority.allow.add('*'); }, TypeError);
  assert.throws(() => { plain.authority = privileged.authority; }, TypeError);
  assert.throws(
    () => Set.prototype.add.call(plain.authority.allow, '*'),
    TypeError,
    'the allow-set must not be mutable through the Set prototype'
  );
  assert.throws(() => Set.prototype.delete.call(plain.authority.allow, 'read_file'), TypeError);
  assert.throws(() => Set.prototype.clear.call(plain.authority.allow), TypeError);
  assert.strictEqual(plain.authority.allow.has('*'), false, 'authority never widens live');
  assert.strictEqual(plain.authority.allow.has('read_file'), true, 'authority never loses members live');

  // The facade must never hand out its backing collection (16a8489, 916b052).
  let handedOut = null;
  plain.authority.allow.forEach((value, key, collection) => { handedOut = collection; });
  assert.strictEqual(handedOut, plain.authority.allow, 'forEach must pass the frozen facade, never the backing set');
  assert.throws(() => Set.prototype.add.call(handedOut, '*'), TypeError);
  assert.strictEqual(plain.authority.allow.has('*'), false, 'forEach must not widen the allow-set');
});

test('2d. toSnapshot drops trust fields; fromSnapshot downgrades tampered claims and rejects schema-invalid ones', () => {
  const live = new Agent({ id: 'authority-snapshot-agent', privileged: true, allowedTools: ['*'] });
  const snapshot = live.toSnapshot();
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(snapshot.config, 'privileged'),
    false,
    'toSnapshot must drop caller-asserted authority'
  );

  const crafted = Agent.fromSnapshot(
    JSON.parse(JSON.stringify({ ...snapshot, config: { ...snapshot.config, privileged: true } }))
  );
  assert.notStrictEqual(crafted.config.privileged, true, 'tampered privilege claim must not survive hydration');
  assert.strictEqual(crafted.authority.allow.size, 0, 'restored authority is re-derived default-deny');
  assert.strictEqual(crafted.authority.allow.has('*'), false, 'persisted wildcard tools grant no authority on restore');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(crafted.config, 'allowedTools'),
    false,
    'persisted capability selectors are withheld from the hydrated config (no legacy gate grant)'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(crafted.config, 'tools'),
    false,
    'the persisted tools alias is withheld from the hydrated config'
  );
  assert.ok(crafted.authorityDowngrade, 'ignored privilege claim must be recorded');
  assert.strictEqual(crafted.authorityDowngrade.reason, 'SNAPSHOT_AUTHORITY_CLAIM_IGNORED');
  assert.deepStrictEqual([...crafted.authorityDowngrade.fields], ['privileged']);

  assert.throws(
    () => Agent.fromSnapshot(JSON.parse(JSON.stringify({ ...snapshot, config: { ...snapshot.config, privileged: 'yes' } }))),
    (err) => err.code === 'INVALID_CONFIG',
    'schema-invalid privilege claims fail closed'
  );
});

// ============================================================================
// 3. Agent Launching & Security Privilege Gating (SEC-1, SEC-2)
// ============================================================================

test('3. Agent Launching & Security Privilege Gating (SEC-1, SEC-2)', async () => {
  const emittedEvents = [];
  const mockRuntime = {
    _emit: (event) => emittedEvents.push(event),
    executeAgentTurn: async (id, prompt) => ({ output: `Done ${prompt}` }),
    _setupAgentMailSubscription: () => () => {}
  };

  const mockMessagingBus = {
    registered: new Map(),
    registerAgent(id, policy) { this.registered.set(id, policy); },
    unregisterAgent(id) { this.registered.delete(id); },
    isRegistered(id) { return this.registered.has(id); }
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    messagingBus: mockMessagingBus
  });

  // 1. Launch with LaunchAgentOptions unified signature
  const agent1 = await lifecycle.launchAgent({
    config: {
      id: 'analyst',
      name: 'Data Analyst',
      role: 'analyst',
      systemPrompt: 'Analyze story pacing.',
      allowedTools: ['read_file']
    }
  });

  assert.strictEqual(agent1.id, 'analyst');
  assert.strictEqual(agent1.state, AGENT_STATES.IDLE);
  assert.strictEqual(lifecycle.getAgent('analyst'), agent1);
  assert.strictEqual(mockMessagingBus.registered.get(genericKey('analyst'))?.privileged, false);

  // 2. Duplicate Launch Rejection
  await assert.rejects(
    async () => {
      await lifecycle.launchAgent({ config: { id: 'analyst' } });
    },
    (err) => err.code === 'AGENT_ALREADY_EXISTS',
    'Cannot launch duplicate active agent ID'
  );

  // 3. Every agent id is ordinary (Wave I, c02d0b9): an unprivileged/anonymous
  // caller may claim `admin`/`director`/`system` — the literal id carries no
  // reserved meaning and the launch composes neither privilege nor bypass.
  for (const ordinaryId of ['admin', 'director', 'system']) {
    const ordinary = await lifecycle.launchAgent({
      config: { id: ordinaryId },
      callerContext: { callerAgentId: 'worker', isPrivileged: false, isAdmin: false }
    });
    assert.strictEqual(ordinary.id, ordinaryId, `the literal id '${ordinaryId}' must launch as an ordinary agent`);
    assert.strictEqual(ordinary.config.privileged, false, `the literal id '${ordinaryId}' never grants privilege`);
    assert.strictEqual(
      lifecycle.getAuthorityInputs(ordinaryId).realmBypass,
      false,
      `the literal id '${ordinaryId}' never grants realmBypass`
    );
  }

  // 4. Privilege Escalation Prevention (SEC-1): Unprivileged caller spawning privileged agent
  await assert.rejects(
    async () => {
      await lifecycle.launchAgent({
        config: { id: 'sub-admin', privileged: true },
        callerContext: { callerAgentId: 'worker', isPrivileged: false }
      });
    },
    (err) => err.code === 'PERMISSION_DENIED',
    'Unprivileged caller cannot spawn privileged agent'
  );

  // 5. Tool Clamping for Unprivileged Creator (SEC-2)
  const parentAgent = await lifecycle.launchAgent({
    config: {
      id: 'parent-worker',
      allowedTools: ['read_file', 'write_file'],
      privileged: false
    }
  });

  const childAgent = await lifecycle.spawnAgent({
    config: {
      id: 'child-worker',
      allowedTools: ['read_file', 'write_file', 'run_command'], // requests run_command
      spawnedBy: 'parent-worker'
    },
    callerContext: { callerAgentId: 'parent-worker', isPrivileged: false }
  });

  // Clamped to parent's allowed tools subset (run_command dropped)
  assert.deepStrictEqual(childAgent.config.allowedTools, ['read_file', 'write_file']);
});

test('3b. Launch-time workspace pinning is confined for non-authority creators (f44da3e)', async () => {
  const mockRuntime = {
    _emit: () => {},
    executeAgentTurn: async () => ({}),
    _setupAgentMailSubscription: () => () => {}
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    internalPrincipal: TEST_PRINCIPAL
  });

  // Authority (internal/operator) creators keep full explicit pinning.
  const hosted = await lifecycle.launchAgent({
    config: { id: 'operator-hosted', workspace: 'host-shared-ws' },
    principal: TEST_PRINCIPAL
  });
  assert.strictEqual(hosted.config.workspaceId, 'host-shared-ws', 'operator pinning is unchanged');

  // A non-authority creator (no wildcard/lifecycle capability) is confined.
  await lifecycle.launchAgent({
    config: { id: 'worker-creator', allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });

  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'pinned-child', workspace: 'victim-ws', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'worker-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'a peer/foreign workspace pin is refused'
  );
  assert.strictEqual(lifecycle.getAgent('pinned-child'), null, 'the denied spawn leaves no partially-launched child');

  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'pinned-global', workspaceId: 'global', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'worker-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'a reserved global pin is refused'
  );
  assert.strictEqual(lifecycle.getAgent('pinned-global'), null, 'the denied reserved spawn leaves no child');

  // The creator's own resolved workspace and the child's own id stay allowed.
  const shared = await lifecycle.spawnAgent({
    config: { id: 'shared-child', workspace: 'worker-creator' },
    callerContext: { callerAgentId: 'worker-creator' }
  });
  assert.strictEqual(shared.config.workspaceId, 'worker-creator', 'the creator workspace pin is honored');

  const selfPinned = await lifecycle.spawnAgent({
    config: { id: 'self-child', workspace: 'self-child' },
    callerContext: { callerAgentId: 'worker-creator' }
  });
  assert.strictEqual(selfPinned.config.workspaceId, 'self-child', 'the child own-id pin is honored');

  // A denied pin is refused before the recycled-record capture (b8b94f1
  // ordering): the denied relaunch leaves the recycle-bin record intact.
  await lifecycle.launchAgent({ config: { id: 'recycled-child', allowedTools: ['read_file'] }, principal: TEST_PRINCIPAL });
  lifecycle.killAgent('recycled-child', 'recycle for denied relaunch', { principal: TEST_PRINCIPAL });
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'recycled-child', workspace: 'victim-ws' },
      callerContext: { callerAgentId: 'worker-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED'
  );
  assert.ok(lifecycle.getRecycledAgent('recycled-child'), 'the denied relaunch keeps the recycle-bin record');
  assert.strictEqual(lifecycle.getAgent('recycled-child'), null, 'the denied relaunch creates no active agent');
});

test('3c. Workspace claims confine launches and eviction keeps the last claimant (26c3913)', async () => {
  const mockRuntime = {
    _emit: () => {},
    executeAgentTurn: async () => ({}),
    _setupAgentMailSubscription: () => () => {}
  };
  const virtualFs = new VirtualFS({ internalPrincipal: TEST_PRINCIPAL });
  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    internalPrincipal: TEST_PRINCIPAL,
    virtualFs
  });

  // The operator pins a peer to the exact canonical key a default-workspace
  // child will resolve (Wave I, d57cbc1): the peer record claims that
  // partition key.
  await lifecycle.launchAgent({
    config: { id: 'claim-peer', workspaceId: genericKey('claim-peer-ws'), allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });
  // Non-authority creator (no wildcard/lifecycle capability).
  await lifecycle.launchAgent({
    config: { id: 'claim-creator', allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });

  // A child id that shadows the peer's resolved workspace key is refused.
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'claim-peer-ws', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'claim-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'a resolved key claimed by another registered record is refused'
  );
  assert.strictEqual(lifecycle.getAgent('claim-peer-ws'), null, 'the denied shadow launch leaves no child');
  assert.strictEqual(lifecycle.getRecycledAgent('claim-peer-ws'), null, 'the denied shadow launch leaves no zombie');

  // A pre-existing/orphan VFS workspace blocks the own-id resolved key.
  virtualFs.writeFile('/orphan.txt', 'orphan bytes', { workspaceId: 'orphan-self', callerAgentId: 'orphan-self' });
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'orphan-self', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'claim-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'a pre-existing workspace cannot be shadowed by an own-id launch'
  );
  assert.strictEqual(lifecycle.getAgent('orphan-self'), null, 'the denied orphan shadow leaves no child');
  assert.strictEqual(
    virtualFs.readFile('/orphan.txt', { workspaceId: 'orphan-self', callerAgentId: 'orphan-self', raw: true }),
    'orphan bytes',
    'the orphan workspace bytes survive'
  );

  // A fresh own-id launch stays allowed.
  const fresh = await lifecycle.launchAgent({
    config: { id: 'fresh-claim', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'claim-creator' }
  });
  assert.strictEqual(fresh.config.workspaceId, 'fresh-claim', 'a fresh own-id workspace resolves normally');

  // The creator's workspace is shared with a child pinned to the creator's
  // resolved (canonical) workspace key; teardown is claim-aware. The fixture
  // VFS has no identity port, so the canonical key is addressed literally (the
  // caller claim must equal the storage key in the port-less ACL).
  const creatorWorkspaceKey = genericKey('claim-creator');
  virtualFs.writeFile('/shared.txt', 'creator bytes', { workspaceId: creatorWorkspaceKey, callerAgentId: creatorWorkspaceKey });
  const shared = await lifecycle.launchAgent({
    config: { id: 'shared-claim', workspace: creatorWorkspaceKey, allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'claim-creator' }
  });
  assert.strictEqual(shared.config.workspaceId, creatorWorkspaceKey, 'the shared child adopts the creator workspace key');

  lifecycle.killAgent('shared-claim', 'shared teardown', { callerAgentId: 'shared-claim' });
  assert.ok(lifecycle.getRecycledAgent('shared-claim'), 'the child self-kill recycles the child');
  assert.ok(virtualFs.hasWorkspace(creatorWorkspaceKey), 'the active creator claim survives the child kill');
  assert.strictEqual(
    virtualFs.readFile('/shared.txt', { workspaceId: creatorWorkspaceKey, callerAgentId: creatorWorkspaceKey, raw: true }),
    'creator bytes',
    "the creator's bytes survive the child teardown"
  );

  lifecycle.killAgent('claim-creator', 'creator teardown', { callerAgentId: 'claim-creator' });
  assert.ok(lifecycle.getRecycledAgent('claim-creator'), 'the creator kill itself completes');
  assert.ok(virtualFs.hasWorkspace(creatorWorkspaceKey), 'the recycled child claim survives the creator kill');

  assert.strictEqual(
    lifecycle.purgeAgent('shared-claim', { principal: TEST_PRINCIPAL }),
    true,
    'the sudoer purge of the child completes'
  );
  assert.ok(virtualFs.hasWorkspace(creatorWorkspaceKey), 'the remaining recycled claimant blocks the purge eviction');

  assert.strictEqual(
    lifecycle.purgeAgent('claim-creator', { principal: TEST_PRINCIPAL }),
    true,
    'the sudoer purge of the last claimant completes'
  );
  assert.strictEqual(virtualFs.hasWorkspace(genericKey('claim-creator')), false, 'the last claimant teardown evicts the workspace');
});

test('3d. Reserved key shapes are always-shadowed for non-authority launches (e6f10db)', async () => {
  const mockRuntime = {
    _emit: () => {},
    executeAgentTurn: async () => ({}),
    _setupAgentMailSubscription: () => () => {}
  };
  const virtualFs = new VirtualFS({ internalPrincipal: TEST_PRINCIPAL });
  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    internalPrincipal: TEST_PRINCIPAL,
    virtualFs
  });

  await lifecycle.launchAgent({
    config: { id: 'res-creator', allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });

  // Own-id reserved-shape launches are refused regardless of `hasWorkspace`:
  // `realm:alpha:global` and `public` do not exist in this fresh VFS, so the
  // existence-based shadow check alone would let them through.
  assert.strictEqual(virtualFs.hasWorkspace('realm:alpha:global'), false, 'the reserved realm key is absent');
  assert.strictEqual(virtualFs.hasWorkspace('public'), false, 'the public key is absent');
  for (const reservedId of ['realm:alpha:global', 'public', 'global']) {
    await assert.rejects(
      () => lifecycle.launchAgent({
        config: { id: reservedId, allowedTools: ['read_file'] },
        callerContext: { callerAgentId: 'res-creator' }
      }),
      (err) => err.code === 'PERMISSION_DENIED',
      `own-id reserved launch '${reservedId}' is refused`
    );
    assert.strictEqual(lifecycle.getAgent(reservedId), null, 'the denied launch leaves no partial child');
    assert.strictEqual(lifecycle.getRecycledAgent(reservedId), null, 'the denied launch leaves no zombie child');
  }
  assert.strictEqual(virtualFs.hasWorkspace('realm:alpha:global'), false, 'the denied launch creates no reserved workspace');
  assert.strictEqual(virtualFs.hasWorkspace('public'), false, 'the denied launch creates no public workspace');

  // The reserved-shape rule is VFS-independent: a headless manager (no VFS)
  // denies the same shapes instead of relying on the existence check.
  const headless = new AgentLifecycleManager({ runtime: mockRuntime, internalPrincipal: TEST_PRINCIPAL });
  await headless.launchAgent({
    config: { id: 'headless-creator', allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });
  await assert.rejects(
    () => headless.launchAgent({
      config: { id: 'realm:alpha:global', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'headless-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'the reserved predicate does not depend on a resolvable workspace registry'
  );
  assert.strictEqual(headless.getAgent('realm:alpha:global'), null, 'the headless denial leaves no child');

  // A creator pinned into a reserved workspace by the operator may not pin a
  // child into that reserved partition either: the resolved key is reserved.
  const reservedHosted = await lifecycle.launchAgent({
    config: { id: 'reserved-hosted', workspaceId: 'realm:alpha:global', allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });
  assert.strictEqual(reservedHosted.config.workspaceId, 'realm:alpha:global', 'operator pinning is unchanged');
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'reserved-child', workspace: 'realm:alpha:global', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'reserved-hosted' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'a non-authority creator cannot pin a child into its reserved workspace'
  );
  assert.strictEqual(lifecycle.getAgent('reserved-child'), null, 'the denied reserved pin leaves no child');

  // Realm-vocabulary near-misses (`realm:…`) are hard launch refusals now
  // (Wave I, d57cbc1 / folded eab4e51); case near-misses stay ordinary.
  for (const vocabularyId of ['realm:alpha:globalx', 'realm:a:glob']) {
    await assert.rejects(
      () => lifecycle.launchAgent({
        config: { id: vocabularyId, allowedTools: ['read_file'] },
        callerContext: { callerAgentId: 'res-creator' }
      }),
      (err) => err.code === 'PERMISSION_DENIED',
      `realm-vocabulary id '${vocabularyId}' is refused`
    );
  }
  for (const nearMissId of ['Global', 'PUBLIC']) {
    const agent = await lifecycle.launchAgent({
      config: { id: nearMissId, allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'res-creator' }
    });
    assert.strictEqual(agent.config.workspaceId, nearMissId, `near-miss '${nearMissId}' is an ordinary private key`);
  }

  // Authority pinning to reserved keys stays unchanged.
  const operatorPinned = await lifecycle.launchAgent({
    config: { id: 'operator-reserved', workspaceId: 'realm:gamma:global', allowedTools: ['read_file'] },
    principal: TEST_PRINCIPAL
  });
  assert.strictEqual(operatorPinned.config.workspaceId, 'realm:gamma:global', 'authority reserved pinning is unchanged');

  // V8 minor regression pin (e6f10db): a denied reserved launch leaves an
  // existing recycled record byte-identical — the reserved-shape gate precedes
  // the recycle-bin capture, so the record is neither consumed nor mutated.
  await lifecycle.launchAgent({ config: { id: 'global', allowedTools: ['read_file'] }, principal: TEST_PRINCIPAL });
  lifecycle.killAgent('global', 'recycle for reserved relaunch denial', { principal: TEST_PRINCIPAL });
  const recycledRecord = lifecycle.getRecycledAgent('global');
  assert.ok(recycledRecord, 'setup: the reserved-key record is recycled');
  const fingerprintBefore = recycledRecordFingerprint(recycledRecord);

  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'global', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'res-creator' }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'the non-authority relaunch of the reserved id is refused'
  );
  assert.strictEqual(lifecycle.getRecycledAgent('global'), recycledRecord, 'the denied relaunch keeps the exact record');
  assert.strictEqual(
    recycledRecordFingerprint(lifecycle.getRecycledAgent('global')),
    fingerprintBefore,
    'the denied reserved relaunch leaves the recycled record byte-identical'
  );
  assert.strictEqual(lifecycle.getAgent('global'), null, 'the denied reserved relaunch creates no active agent');
});

// ============================================================================
// 3e-3g. Baked History Seeding (Realm Template Format v1, ticket 7e6edae)
// ============================================================================

test('3e. Baked history seeds [system, ...declared] with generated ids and template metadata', async () => {
  const turnCalls = [];
  const mockRuntime = {
    _emit: () => {},
    executeAgentTurn: async (id, prompt) => {
      turnCalls.push({ id, prompt });
      return { output: 'ok' };
    },
    enqueueUserTurn: async (id, prompt) => {
      turnCalls.push({ id, prompt, queued: true });
      return { output: 'ok' };
    },
    _setupAgentMailSubscription: () => () => {}
  };
  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    internalPrincipal: TEST_PRINCIPAL
  });

  const declared = [
    { role: 'assistant', content: 'The gate groans open.', source: 'template' },
    { role: 'user', content: 'I step through.' },
    { role: 'assistant', content: 'You are inside now.' }
  ];
  const agent = await lifecycle.launchAgent({
    config: { id: 'seeded-opener', systemPrompt: 'You are the narrator.' },
    history: declared
  });

  assert.deepStrictEqual(
    agent.history.map((m) => [m.role, m.content]),
    [
      ['system', 'You are the narrator.'],
      ['assistant', 'The gate groans open.'],
      ['user', 'I step through.'],
      ['assistant', 'You are inside now.']
    ],
    'history is the system message followed by the declared entries in order'
  );

  // INV-7: launch-generated, unique, prefix-stable ids.
  const ids = agent.history.map((m) => m.id);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), 'every seeded message carries a non-empty id');
  assert.strictEqual(new Set(ids).size, ids.length, 'seeded ids are unique (INV-7)');
  assert.match(ids[0], /^sys_/, 'the system message keeps the sys_ prefix');
  assert.match(ids[1], /^assistant_/, 'declared assistant entries generate assistant_ ids');
  assert.match(ids[2], /^user_/, 'declared user entries generate user_ ids');

  // metadata.source is attached only when the entry declares source: 'template'.
  assert.deepStrictEqual(agent.history[1].metadata, { source: 'template' });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(agent.history[2], 'metadata'),
    false,
    'an entry without a declared source carries no metadata'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(agent.history[3], 'metadata'),
    false,
    'the third entry carries no metadata either'
  );

  // Defensive copy: later caller mutation cannot alter the seeded history.
  declared[1].content = 'MUTATED';
  declared[0].source = 'imported';
  assert.strictEqual(agent.history[2].content, 'I step through.', 'seeded content is copied at launch');
  assert.deepStrictEqual(agent.history[1].metadata, { source: 'template' }, 'seeded provenance is copied at launch');

  // Seeding runs no turn; only initialPrompt triggers one.
  assert.strictEqual(turnCalls.length, 0, 'seeding declared history runs no turn');
  assert.strictEqual(agent.state, AGENT_STATES.IDLE, 'the seeded agent stays idle');

  await lifecycle.launchAgent({
    config: { id: 'seeded-prompted', systemPrompt: 'You are the narrator.' },
    history: [{ role: 'assistant', content: 'Ready when you are.', source: 'template' }],
    initialPrompt: 'Begin.'
  });
  assert.strictEqual(turnCalls.length, 1, 'initialPrompt is the only turn trigger');
  assert.strictEqual(turnCalls[0].prompt, 'Begin.');
  assert.strictEqual(turnCalls[0].queued, true, 'the launch directive routes through the queue-backed entry when present');

  // A template may open in medias res: with no system prompt, the assistant
  // opener is the first history message.
  const openerOnly = await lifecycle.launchAgent({
    config: { id: 'assistant-opener' },
    history: [{ role: 'assistant', content: 'Already in progress.' }]
  });
  assert.deepStrictEqual(
    openerOnly.history.map((m) => m.role),
    ['assistant'],
    'no system message is composed without a system prompt; the assistant opener is first'
  );
});

test('3f. Malformed declared history is rejected fail-closed before registration', async () => {
  const turnCalls = [];
  const mockRuntime = {
    _emit: () => {},
    executeAgentTurn: async (id, prompt) => {
      turnCalls.push(prompt);
      return { output: 'ok' };
    },
    _setupAgentMailSubscription: () => () => {}
  };
  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    internalPrincipal: TEST_PRINCIPAL
  });

  const invalidHistories = [
    ['a non-array value', 'not-an-array'],
    ['an object value', { role: 'user', content: 'x' }],
    ['a null entry', [null]],
    ['an array entry', [[]]],
    ['a system role', [{ role: 'system', content: 'composed elsewhere' }]],
    ['a tool role', [{ role: 'tool', content: 'x' }]],
    ['a missing role', [{ content: 'x' }]],
    ['an empty content', [{ role: 'user', content: '' }]],
    ['a non-string content', [{ role: 'user', content: 42 }]],
    ['a caller-supplied id', [{ role: 'user', content: 'x', id: 'pinned_id' }]],
    ['a caller-supplied metadata', [{ role: 'user', content: 'x', metadata: { source: 'template' } }]],
    ['an invalid source', [{ role: 'user', content: 'x', source: 'imported' }]],
    ['a non-string source', [{ role: 'assistant', content: 'x', source: true }]]
  ];

  for (let i = 0; i < invalidHistories.length; i++) {
    const [label, history] = invalidHistories[i];
    const id = `rejected-history-${i}`;
    await assert.rejects(
      () => lifecycle.launchAgent({ config: { id }, history }),
      (err) => err.code === 'INVALID_CONFIG',
      `${label} must be rejected with a typed INVALID_CONFIG error`
    );
    assert.strictEqual(lifecycle.getAgent(id), null, `${label}: no partial registration`);
    assert.strictEqual(lifecycle.getRecycledAgent(id), null, `${label}: no recycle-bin side effect`);
  }
  assert.strictEqual(turnCalls.length, 0, 'a rejected launch never reaches turn dispatch');

  // Empty / absent declarations are valid and seed nothing.
  const empty = await lifecycle.launchAgent({ config: { id: 'empty-history' }, history: [] });
  assert.deepStrictEqual(empty.history, [], 'an empty declared history seeds nothing');
  const absent = await lifecycle.launchAgent({ config: { id: 'absent-history' }, history: null });
  assert.deepStrictEqual(absent.history, [], 'a null declared history seeds nothing');
});

test('3g. Seeded baked history round-trips snapshots byte-identically', async () => {
  const mockRuntime = {
    _emit: () => {},
    _setupAgentMailSubscription: () => () => {}
  };
  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    internalPrincipal: TEST_PRINCIPAL
  });

  const agent = await lifecycle.launchAgent({
    config: { id: 'seed-snapshot', systemPrompt: 'System.' },
    history: [
      { role: 'assistant', content: 'Opener.', source: 'template' },
      { role: 'user', content: 'Reply.' }
    ]
  });

  const snapshot = agent.toSnapshot();
  const decoded = JSON.parse(JSON.stringify(snapshot));
  const restored = Agent.fromSnapshot(decoded);

  assert.deepStrictEqual(
    restored.history,
    snapshot.history,
    'history round-trips exactly (ids, roles, content, metadata)'
  );
  assert.strictEqual(restored.history[1].id, agent.history[1].id, 'the seeded id survives snapshot hydration (INV-7)');
  assert.deepStrictEqual(restored.history[1].metadata, { source: 'template' });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(restored.history[2], 'metadata'),
    false,
    'an entry without provenance stays metadata-free'
  );

  // Hydration deep-copies: mutating the restored history never reaches the entity.
  restored.history[1].metadata.source = 'mutated';
  restored.history[2].content = 'MUTATED';
  assert.deepStrictEqual(agent.history[1].metadata, { source: 'template' }, 'source entity provenance is isolated');
  assert.strictEqual(agent.history[2].content, 'Reply.', 'source entity content is isolated');
});

// ============================================================================
// 4. Formal 9-State Finite State Machine (FSM) Governance & Validation (INV-2)
// ============================================================================

test('4. Formal 9-State FSM State Machine Transitions & Validation', () => {
  const emittedEvents = [];
  const mockRuntime = {
    _emit: (event) => emittedEvents.push(event)
  };

  const lifecycle = new AgentLifecycleManager({ runtime: mockRuntime, internalPrincipal: TEST_PRINCIPAL });
  const agent = new Agent({ id: 'fsm-agent' });
  lifecycle.launchAgent({ config: { id: 'fsm-agent' } });

  // MOD-21 W8: lifecycle transitions require a resolved principal.
  const transition = (agentOrId, newState, stateDetail) =>
    lifecycle.transitionAgentState(agentOrId, newState, stateDetail, { principal: TEST_PRINCIPAL });

  // Initial state is IDLE
  assert.strictEqual(agent.state, AGENT_STATES.IDLE);

  // Valid Transitions:
  // IDLE -> RUNNING
  transition(agent, AGENT_STATES.RUNNING, 'Executing turn 1');
  assert.strictEqual(agent.state, AGENT_STATES.RUNNING);
  assert.strictEqual(agent.stateDetail, 'Executing turn 1');

  // RUNNING -> WAITING_FOR_INPUT
  transition(agent, AGENT_STATES.WAITING_FOR_INPUT, 'Awaiting user input');
  assert.strictEqual(agent.state, AGENT_STATES.WAITING_FOR_INPUT);

  // WAITING_FOR_INPUT -> RUNNING
  transition(agent, AGENT_STATES.RUNNING, 'Resuming turn');
  assert.strictEqual(agent.state, AGENT_STATES.RUNNING);

  // RUNNING -> WAITING_FOR_DEPENDENTS
  transition(agent, AGENT_STATES.WAITING_FOR_DEPENDENTS, 'Awaiting child RPC');
  assert.strictEqual(agent.state, AGENT_STATES.WAITING_FOR_DEPENDENTS);

  // WAITING_FOR_DEPENDENTS -> RUNNING
  transition(agent, AGENT_STATES.RUNNING, 'Child RPC completed');
  assert.strictEqual(agent.state, AGENT_STATES.RUNNING);

  // RUNNING -> WAITING_FOR_MESSAGE
  transition(agent, AGENT_STATES.WAITING_FOR_MESSAGE, 'Awaiting mail');
  assert.strictEqual(agent.state, AGENT_STATES.WAITING_FOR_MESSAGE);

  // WAITING_FOR_MESSAGE -> RUNNING
  transition(agent, AGENT_STATES.RUNNING, 'Mail received');
  assert.strictEqual(agent.state, AGENT_STATES.RUNNING);

  // RUNNING -> CANCELING
  transition(agent, AGENT_STATES.CANCELING, 'Canceling turn');
  assert.strictEqual(agent.state, AGENT_STATES.CANCELING);

  // CANCELING -> ERRORED
  transition(agent, AGENT_STATES.ERRORED, 'Aborted with error');
  assert.strictEqual(agent.state, AGENT_STATES.ERRORED);

  // ERRORED -> IDLE
  transition(agent, AGENT_STATES.IDLE, 'Reset after error');
  assert.strictEqual(agent.state, AGENT_STATES.IDLE);

  // Invalid Transition Rejection: IDLE -> WAITING_FOR_INPUT (Illegal directly from IDLE)
  assert.throws(
    () => transition(agent, AGENT_STATES.WAITING_FOR_INPUT),
    (err) => err.code === 'INVALID_STATE_TRANSITION',
    'Cannot transition from IDLE to WAITING_FOR_INPUT directly'
  );

  // Invalid Transition Rejection: CANCELING -> RUNNING
  transition(agent, AGENT_STATES.RUNNING);
  transition(agent, AGENT_STATES.CANCELING);
  assert.throws(
    () => transition(agent, AGENT_STATES.RUNNING),
    (err) => err.code === 'INVALID_STATE_TRANSITION',
    'Cannot transition from CANCELING to RUNNING'
  );

  // Unknown agent transition throws AGENT_NOT_FOUND
  assert.throws(
    () => transition('non-existent', AGENT_STATES.RUNNING),
    (err) => err.code === 'AGENT_NOT_FOUND'
  );
});

// ============================================================================
// 5. Soft-Kill Recycle Bin Workflows with Subsystem Teardown (INV-4 / INV-KILL)
// ============================================================================

test('5. Soft-Kill Recycle Bin Workflows with Subsystem Teardown (INV-KILL)', async () => {
  const emittedEvents = [];
  const mockRuntime = {
    _emit: (event) => emittedEvents.push(event),
    _setupAgentMailSubscription: () => () => {}
  };

  const mockVirtualFs = {
    deletedWorkspaces: [],
    deleteWorkspace(ws) { this.deletedWorkspaces.push(ws); }
  };

  const mockMessagingBus = {
    terminatedAgents: new Set(),
    registered: new Map(),
    markAgentTerminated(id) { this.terminatedAgents.add(id); },
    registerAgent(id, pol) { this.registered.set(id, pol); },
    isRegistered(id) { return this.registered.has(id); }
  };

  const mockInvocationEngine = {
    cancelledAgents: [],
    cancelPendingInvocationsForAgent(id, reason) { this.cancelledAgents.push({ id, reason }); }
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    virtualFs: mockVirtualFs,
    messagingBus: mockMessagingBus,
    invocationEngine: mockInvocationEngine,
    internalPrincipal: TEST_PRINCIPAL
  });

  const agent = await lifecycle.launchAgent({
    config: { id: 'worker-to-kill', name: 'Worker', role: 'helper' }
  });

  // Set in-flight streaming buffers & turn promise
  agent.currentStream = 'Partial output...';
  agent.currentReasoning = 'Thinking...';
  agent.activeToolCalls = [{ id: 'call_1' }];
  agent.abortController = new AbortController();
  agent.currentTurnPromise = Promise.resolve();

  // Authority Check: Unauthorized third-party rejected
  assert.throws(
    () => lifecycle.killAgent('worker-to-kill', 'Halt', { callerAgentId: 'unauthorized-peer', isPrivileged: false }),
    (err) => err.code === 'PERMISSION_DENIED',
    'Unauthorized peer cannot kill agent'
  );

  // Sudoer kill execution through the injected internal principal
  const recycledAgent = lifecycle.killAgent('worker-to-kill', 'Task completed', {
    principal: TEST_PRINCIPAL
  });

  assert.ok(recycledAgent);
  assert.strictEqual(recycledAgent.state, AGENT_STATES.RECYCLED);
  assert.strictEqual(recycledAgent.recycleReason, 'Task completed');
  assert.ok(recycledAgent.recycledAt, 'recycledAt timestamp must be set');

  // Buffers cleared
  assert.strictEqual(recycledAgent.currentStream, '');
  assert.strictEqual(recycledAgent.currentReasoning, '');
  assert.deepStrictEqual(recycledAgent.activeToolCalls, []);
  assert.strictEqual(recycledAgent.currentTurnPromise, null);

  // Subsystem Teardown verified (canonical registration keys, Wave I d57cbc1)
  assert.deepStrictEqual(mockVirtualFs.deletedWorkspaces, [genericKey('worker-to-kill')], 'Workspace evicted');
  assert.ok(mockMessagingBus.terminatedAgents.has(genericKey('worker-to-kill')), 'MessagingBus marked terminated');
  assert.strictEqual(mockInvocationEngine.cancelledAgents.length, 1);

  // Map migration verified
  assert.strictEqual(lifecycle.getAgent('worker-to-kill'), null, 'Removed from active registry');
  assert.strictEqual(lifecycle.getRecycledAgent('worker-to-kill'), recycledAgent, 'Present in recycleBin');
  assert.strictEqual(lifecycle.isAgentTerminated('worker-to-kill'), true, 'Reported as terminated');

  // Scheduled timer teardown is owned by the AgentRuntime facade (P2.2): verify with real instances
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'scheduled-worker', role: 'helper' });
    runtime.schedule({ targetAgentId: 'scheduled-worker', durationSeconds: 60, prompt: 'Pending task' });
    assert.strictEqual(runtime.listSchedules({ status: 'pending' }, { callerAgentId: 'director' }).schedules.length, 1);

    // Unauthorized kill must be side-effect free: denial happens before timer teardown (d5f49b0).
    await runtime.launchAgent({ id: 'protected-worker', role: 'helper' });
    const protectedTimer = runtime.schedule({
      targetAgentId: 'protected-worker',
      durationSeconds: 60,
      prompt: 'Protected timer'
    });
    assert.strictEqual(protectedTimer.success, true);
    assert.throws(
      () => runtime.killAgent('protected-worker', 'Unauthorized halt', {
        callerAgentId: 'unauthorized-peer',
        isPrivileged: false
      }),
      (err) => err.code === 'PERMISSION_DENIED',
      'Unauthorized peer cannot kill the protected worker'
    );
    assert.ok(runtime.getAgent('protected-worker'), 'Denied kill must leave the victim alive');
    const protectedProjection = runtime.listSchedules({}, { callerAgentId: 'director' }).schedules
      .find((s) => s.timerId === protectedTimer.timerId);
    assert.ok(protectedProjection, 'Denied kill must not remove the victim timer');
    assert.strictEqual(protectedProjection.status, SCHEDULER_STATUS.PENDING);

    runtime.killAgent('scheduled-worker', 'Task completed', { callerAgentId: 'director' });

    const schedules = runtime.listSchedules({ status: 'all' }, { callerAgentId: 'director' }).schedules;
    assert.strictEqual(schedules.length, 2);
    assert.strictEqual(schedules.find((s) => s.agentId === 'scheduled-worker').status, SCHEDULER_STATUS.CANCELLED);
    assert.strictEqual(
      schedules.find((s) => s.timerId === protectedTimer.timerId).status,
      SCHEDULER_STATUS.PENDING,
      'Authorized kill tears down only the killed agent timers'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 5b. killAgent authority: missing caller id never bypasses checks
// ============================================================================

test('5b. killAgent denies omitted and forged caller contexts (INV-ADMIN)', async () => {
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} }, internalPrincipal: TEST_PRINCIPAL });
  await lifecycle.launchAgent({ config: { id: 'anonymous-victim' } });

  // Omitted context and a context without a resolvable caller id are anonymous.
  assert.throws(
    () => lifecycle.killAgent('anonymous-victim', 'Halt'),
    (err) => err.code === 'PERMISSION_DENIED',
    'Omitted caller context is denied'
  );
  assert.throws(
    () => lifecycle.killAgent('anonymous-victim', 'Halt', { isPrivileged: false }),
    (err) => err.code === 'PERMISSION_DENIED',
    'Anonymous unprivileged context is denied'
  );
  assert.throws(
    () => lifecycle.killAgent('anonymous-victim', 'Halt', {}),
    (err) => err.code === 'PERMISSION_DENIED',
    'Bare context object is denied'
  );
  assert.throws(
    () => lifecycle.killAgent('anonymous-victim', 'Halt', { isAdmin: true, isPrivileged: true }),
    (err) => err.code === 'PERMISSION_DENIED',
    'Forged sudoer flags are denied'
  );

  assert.strictEqual(lifecycle.getAgent('anonymous-victim')?.state, AGENT_STATES.IDLE, 'Denied kills leave the agent untouched');

  // The injected engine principal may terminate.
  lifecycle.killAgent('anonymous-victim', 'System halt', { principal: TEST_PRINCIPAL });
  assert.strictEqual(lifecycle.getAgent('anonymous-victim'), null, 'Injected principal may terminate');

  // Alias identity fields and `privileged` flags no longer confer authority.
  await lifecycle.launchAgent({ config: { id: 'alias-victim' } });
  assert.throws(
    () => lifecycle.killAgent('alias-victim', 'Alias authority', { agentId: 'director', privileged: true }),
    (err) => err.code === 'PERMISSION_DENIED',
    'Alias identity + privilege flags are denied'
  );
  assert.ok(lifecycle.getAgent('alias-victim'), 'Denied alias kill leaves the victim active');
});

// ============================================================================
// 5c. Denied relaunch of a recycled ID preserves its recycle-bin record (b8b94f1)
// ============================================================================

test('5c. Denied relaunch of a recycled ID preserves its recycle-bin record (b8b94f1)', async () => {
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} }, internalPrincipal: TEST_PRINCIPAL });

  await lifecycle.launchAgent({
    config: { id: 'admin', name: 'Admin' },
    principal: TEST_PRINCIPAL
  });
  lifecycle.killAgent('admin', 'Recycled for denial coverage', {
    principal: TEST_PRINCIPAL
  });
  const recycledAdmin = lifecycle.getRecycledAgent('admin');
  assert.ok(recycledAdmin, 'setup: admin must be in the recycle bin');

  // A denied (privileged) relaunch must not consume the recycled record; the
  // id itself is ordinary (Wave I, c02d0b9) and grants nothing.
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'admin', privileged: true },
      callerContext: { callerAgentId: 'mallory', isPrivileged: false }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'An unprivileged caller cannot relaunch a recycled id with a privilege grant'
  );
  assert.strictEqual(
    lifecycle.getRecycledAgent('admin'),
    recycledAdmin,
    'Denied relaunch must leave the recycled record byte-identical'
  );
  assert.strictEqual(lifecycle.isAgentTerminated('admin'), true);

  // Preset-validation denial is equally side-effect free.
  await lifecycle.launchAgent({ config: { id: 'preset-recycled' } });
  lifecycle.killAgent('preset-recycled', 'Recycled for preset coverage', { principal: TEST_PRINCIPAL });
  const recycledPreset = lifecycle.getRecycledAgent('preset-recycled');
  await assert.rejects(
    () => lifecycle.launchAgent({ config: { id: 'preset-recycled', toolPreset: 'no-such-preset' } }),
    (err) => err.code === 'INVALID_ARGUMENTS'
  );
  assert.strictEqual(
    lifecycle.getRecycledAgent('preset-recycled'),
    recycledPreset,
    'Failed preset validation must not consume the recycled record'
  );

  // The preserved record remains restorable.
  const restored = lifecycle.restoreAgent('admin', { principal: TEST_PRINCIPAL });
  assert.strictEqual(restored.id, 'admin');
  assert.strictEqual(restored.state, AGENT_STATES.IDLE);
});

// ============================================================================
// 5d. Unauthorized kill of a recycled agent is denied without mutation (f016a6b)
// ============================================================================

test('5d. Unauthorized kill of a recycled agent is denied without mutation (f016a6b)', async () => {
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} }, internalPrincipal: TEST_PRINCIPAL });
  await lifecycle.launchAgent({ config: { id: 'recycled-victim' } });
  lifecycle.killAgent('recycled-victim', 'Setup recycle', { principal: TEST_PRINCIPAL });
  const recycled = lifecycle.getRecycledAgent('recycled-victim');
  assert.ok(recycled, 'setup: victim must be in the recycle bin');

  // Unprivileged non-owner and anonymous contexts are denied for recycled targets.
  assert.throws(
    () => lifecycle.killAgent('recycled-victim', 'Terminate', { callerAgentId: 'mallory', isPrivileged: false }),
    (err) => err.code === 'PERMISSION_DENIED',
    'Unprivileged non-owner cannot kill a recycled agent'
  );
  assert.throws(
    () => lifecycle.killAgent('recycled-victim', 'Terminate', {}),
    (err) => err.code === 'PERMISSION_DENIED',
    'Anonymous context cannot kill a recycled agent'
  );

  assert.strictEqual(
    lifecycle.getRecycledAgent('recycled-victim'),
    recycled,
    'Denied kill must leave the recycled record intact'
  );
  assert.strictEqual(recycled.state, AGENT_STATES.RECYCLED);
  assert.strictEqual(lifecycle.isAgentTerminated('recycled-victim'), true);

  // Authorized kill of a recycled agent keeps the idempotent contract.
  const idempotent = lifecycle.killAgent('recycled-victim', 'Terminate again', {
    principal: TEST_PRINCIPAL
  });
  assert.strictEqual(idempotent, recycled, 'Authorized recycled kill returns the existing record');
  assert.strictEqual(recycled.state, AGENT_STATES.RECYCLED);
});

// ============================================================================
// 5e. Failed post-gate relaunch of a recycled ID restores its record
// ============================================================================

test('5e. Failed post-gate relaunch of a recycled ID restores its recycle-bin record', async () => {
  let turnFailure = null;
  const lifecycle = new AgentLifecycleManager({
    runtime: {
      executeAgentTurn: async () => {
        if (turnFailure) throw turnFailure;
        return { output: 'ok' };
      }
    },
    emit: { emit: () => {} },
    internalPrincipal: TEST_PRINCIPAL
  });

  // Setup: launch then recycle, leaving a restorable bin record.
  await lifecycle.launchAgent({ config: { id: 'relaunch-victim', name: 'Original' } });
  lifecycle.killAgent('relaunch-victim', 'Setup recycle', { principal: TEST_PRINCIPAL });
  const recycled = lifecycle.getRecycledAgent('relaunch-victim');
  assert.ok(recycled, 'setup: victim must be in the recycle bin');

  // Authorized relaunch that clears every gate but whose initial prompt turn fails.
  turnFailure = new InferenceError('Upstream inference failure', {
    code: 'ERR_UPSTREAM',
    status: 500,
    retryable: true
  });
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'relaunch-victim', name: 'Replacement' },
      initialPrompt: 'This turn fails after the authorization gates'
    }),
    (err) => err instanceof InferenceError && err.code === 'ERR_UPSTREAM',
    'The post-gate inference failure must propagate to the caller'
  );

  // The failed relaunch must leave the record byte-identical and retryable.
  assert.strictEqual(
    lifecycle.getRecycledAgent('relaunch-victim'),
    recycled,
    'Failed relaunch must restore the identical recycled record'
  );
  assert.strictEqual(lifecycle.getAgent('relaunch-victim'), null, 'Failed relaunch must unwind the replacement registration');
  assert.strictEqual(lifecycle.isAgentTerminated('relaunch-victim'), true);

  const restored = lifecycle.restoreAgent('relaunch-victim', { principal: TEST_PRINCIPAL });
  assert.strictEqual(restored, recycled, 'restoreAgent must return the preserved record');
  assert.strictEqual(restored.state, AGENT_STATES.IDLE);

  // Control: a successful authorized relaunch still consumes the record as before.
  lifecycle.killAgent('relaunch-victim', 'Recycle for success control', { principal: TEST_PRINCIPAL });
  assert.ok(lifecycle.getRecycledAgent('relaunch-victim'), 'setup: victim recycled again');
  turnFailure = null;
  const replacement = await lifecycle.launchAgent({
    config: { id: 'relaunch-victim', name: 'Replacement' },
    initialPrompt: 'This turn succeeds'
  });
  assert.strictEqual(lifecycle.getRecycledAgent('relaunch-victim'), null, 'Successful relaunch consumes the recycled record');
  assert.strictEqual(lifecycle.getAgent('relaunch-victim'), replacement);
  assert.strictEqual(replacement.state, AGENT_STATES.IDLE);
});

// ============================================================================
// 6. Agent Restoration from Recycle Bin (INV-RESTORE)
// ============================================================================

test('6. Agent Restoration from Recycle Bin (INV-RESTORE)', async () => {
  const emittedEvents = [];
  const mockRuntime = {
    _emit: (event) => emittedEvents.push(event),
    _setupAgentMailSubscription: () => () => {}
  };

  const mockMessagingBus = {
    unmarked: [],
    registered: new Map(),
    unmarkAgentTerminated(id) { this.unmarked.push(id); },
    registerAgent(id, pol) { this.registered.set(id, pol); }
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    messagingBus: mockMessagingBus,
    internalPrincipal: TEST_PRINCIPAL
  });

  await lifecycle.launchAgent({ config: { id: 'restorable-agent' } });
  lifecycle.killAgent('restorable-agent', 'Soft delete', { principal: TEST_PRINCIPAL });

  assert.strictEqual(lifecycle.isAgentTerminated('restorable-agent'), true);

  // Restore agent
  const restored = lifecycle.restoreAgent('restorable-agent', { principal: TEST_PRINCIPAL });

  assert.strictEqual(restored.id, 'restorable-agent');
  assert.strictEqual(restored.state, AGENT_STATES.IDLE);
  assert.strictEqual(restored.recycledAt, null);
  assert.strictEqual(restored.recycleReason, null);

  // Map migration
  assert.strictEqual(lifecycle.getAgent('restorable-agent'), restored);
  assert.strictEqual(lifecycle.getRecycledAgent('restorable-agent'), null);
  assert.strictEqual(lifecycle.isAgentTerminated('restorable-agent'), false);

  // Bus re-registration (canonical registration keys, Wave I d57cbc1)
  assert.deepStrictEqual(mockMessagingBus.unmarked, [genericKey('restorable-agent')]);
  assert.ok(mockMessagingBus.registered.has(genericKey('restorable-agent')));

  // Restoring non-existent throws AGENT_NOT_FOUND
  assert.throws(
    () => lifecycle.restoreAgent('ghost-agent'),
    (err) => err.code === 'AGENT_NOT_FOUND'
  );
});

// ============================================================================
// 7. Permanent Purging across Bus, Filesystem, Timers, and Memory (INV-PURGE)
// ============================================================================

test('7. Permanent Purging across Bus, Filesystem, Timers, and Memory (INV-PURGE)', async () => {
  const emittedEvents = [];
  const mockRuntime = {
    _emit: (event) => emittedEvents.push(event),
    _setupAgentMailSubscription: () => () => {}
  };

  const mockVirtualFs = {
    deleted: [],
    deleteWorkspace(ws) { this.deleted.push(ws); }
  };

  const mockMessagingBus = {
    purged: [],
    purgeAgent(id) { this.purged.push(id); }
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    virtualFs: mockVirtualFs,
    messagingBus: mockMessagingBus,
    internalPrincipal: TEST_PRINCIPAL
  });

  await lifecycle.launchAgent({ config: { id: 'agent-to-purge' } });
  lifecycle.killAgent('agent-to-purge', 'Purge setup', { principal: TEST_PRINCIPAL });

  // Purge agent
  const purged = lifecycle.purgeAgent('agent-to-purge', { principal: TEST_PRINCIPAL });
  assert.strictEqual(purged, true);

  assert.strictEqual(lifecycle.getAgent('agent-to-purge'), null);
  assert.strictEqual(lifecycle.getRecycledAgent('agent-to-purge'), null);
  assert.deepStrictEqual(mockMessagingBus.purged, [genericKey('agent-to-purge')]);
  assert.deepStrictEqual(mockVirtualFs.deleted, [genericKey('agent-to-purge'), genericKey('agent-to-purge')]); // once on kill, once on purge

  // Purge non-existent returns false
  assert.strictEqual(lifecycle.purgeAgent('unknown-agent'), false);

  // Scheduler purge is owned by the AgentRuntime facade (P2.2): verify with real instances
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'scheduled-purge', role: 'helper' });
    runtime.schedule({ targetAgentId: 'scheduled-purge', durationSeconds: 60, prompt: 'Pending task' });
    assert.strictEqual(runtime.listSchedules({ status: 'all' }, { callerAgentId: 'director' }).schedules.length, 1);

    runtime.purgeAgent('scheduled-purge', { callerAgentId: 'director' });

    assert.strictEqual(runtime.listSchedules({ status: 'all' }, { callerAgentId: 'director' }).schedules.length, 0);
  } finally {
    runtime.destroy();
  }

  // emptyRecycleBin
  await lifecycle.launchAgent({ config: { id: 'rec-1' } });
  await lifecycle.launchAgent({ config: { id: 'rec-2' } });
  lifecycle.killAgent('rec-1', 'Recycle 1', { principal: TEST_PRINCIPAL });
  lifecycle.killAgent('rec-2', 'Recycle 2', { principal: TEST_PRINCIPAL });
  assert.strictEqual(lifecycle.listRecycledAgents().length, 2);

  const count = lifecycle.emptyRecycleBin({ principal: TEST_PRINCIPAL });
  assert.strictEqual(count, 2);
  assert.strictEqual(lifecycle.listRecycledAgents().length, 0);
});

// ============================================================================
// 8. Emergency Turn Unsticking & Stream Reset Engine (INV-UNSTICK)
// ============================================================================

test('8. Emergency Turn Unsticking & Stream Reset Engine (INV-UNSTICK)', async () => {
  const emittedEvents = [];
  let tickProcessed = false;
  const mockRuntime = {
    _emit: (event) => emittedEvents.push(event),
    triggerQueue: {
      processTick: async () => { tickProcessed = true; }
    },
    _setupAgentMailSubscription: () => () => {}
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: mockRuntime,
    emit: { emit: (event) => emittedEvents.push(event) },
    internalPrincipal: TEST_PRINCIPAL
  });
  const agent = await lifecycle.launchAgent({ config: { id: 'stuck-agent' } });

  // Simulate stuck agent state (MOD-21 W8: engine principal authorizes)
  lifecycle.transitionAgentState(agent, AGENT_STATES.RUNNING, 'Stuck in infinite tool loop', { principal: TEST_PRINCIPAL });
  agent.currentStream = 'Stranded partial token stream';
  agent.currentReasoning = 'Stranded thinking stream';
  agent.activeToolCalls = [{ id: 'call_hung' }];
  agent.abortController = new AbortController();
  agent.currentTurnPromise = new Promise(() => {}); // Never resolves

  assert.strictEqual(lifecycle.isAgentBusy('stuck-agent'), true);

  // Execute emergency unstick
  const unstickResult = lifecycle.unstickAgent('stuck-agent', 'UI Timeout Unstick', { principal: TEST_PRINCIPAL });
  const { success, agent: recoveredAgent, previousState, reason } = unstickResult;

  assert.strictEqual(success, true);
  assert.strictEqual(previousState, AGENT_STATES.RUNNING, 'Receipt reports the pre-unstick state');
  assert.strictEqual(reason, 'UI Timeout Unstick', 'Receipt reports the caller reason');
  assert.strictEqual(recoveredAgent.state, AGENT_STATES.IDLE);
  assert.strictEqual(recoveredAgent.currentStream, '');
  assert.strictEqual(recoveredAgent.currentReasoning, '');
  assert.deepStrictEqual(recoveredAgent.activeToolCalls, []);
  assert.strictEqual(recoveredAgent.abortController, null);
  assert.strictEqual(recoveredAgent.currentTurnPromise, null);
  assert.strictEqual(lifecycle.isAgentBusy('stuck-agent'), false);

  // Microtask kicks TriggerQueue
  await new Promise(resolve => queueMicrotask(resolve));
  assert.strictEqual(tickProcessed, true, 'TriggerQueue tick kicked on unstick');

  // stream_reset event emitted
  assert.ok(emittedEvents.some(e => e.type === 'stream_reset' && e.agentId === 'stuck-agent'));

  // Invalid unstick throws AGENT_NOT_FOUND
  assert.throws(
    () => lifecycle.unstickAgent('ghost-stuck'),
    (err) => err.code === 'AGENT_NOT_FOUND'
  );
});

// ============================================================================
// 8b. Cancellation Contract: boolean receipts & cancelAll(reason) propagation
// ============================================================================

test('8b. Cancellation Contract: boolean receipts & cancelAll(reason) propagation', async () => {
  const emittedEvents = [];
  const lifecycle = new AgentLifecycleManager({
    emit: { emit: (event) => emittedEvents.push(event) },
    internalPrincipal: TEST_PRINCIPAL
  });

  // Unknown agent: false, never throws
  assert.strictEqual(lifecycle.cancelAgent('ghost-agent', 'No such agent'), false);

  // Known idle agent has no cancellable in-flight/waiting state: false, state untouched
  const idleAgent = await lifecycle.launchAgent({ config: { id: 'idle-cancel-agent' } });
  assert.strictEqual(lifecycle.cancelAgent('idle-cancel-agent', 'Idle attempt', { principal: TEST_PRINCIPAL }), false);
  assert.strictEqual(idleAgent.state, AGENT_STATES.IDLE);

  // Known running agent: true, transitions to CANCELING with the caller reason and aborts
  const runningAgent = await lifecycle.launchAgent({ config: { id: 'running-cancel-agent' } });
  const abortController = new AbortController();
  runningAgent.abortController = abortController;
  lifecycle.transitionAgentState(runningAgent, AGENT_STATES.RUNNING, 'Executing', { principal: TEST_PRINCIPAL });
  assert.strictEqual(lifecycle.cancelAgent('running-cancel-agent', 'User stop', { principal: TEST_PRINCIPAL }), true);
  assert.strictEqual(runningAgent.state, AGENT_STATES.CANCELING);
  assert.strictEqual(runningAgent.stateDetail, 'User stop');
  assert.strictEqual(abortController.signal.aborted, true);

  // cancelAll(reason) propagates the caller reason to every active cancellable agent
  await lifecycle.launchAgent({ config: { id: 'cancel-all-1' } });
  await lifecycle.launchAgent({ config: { id: 'cancel-all-2' } });
  lifecycle.transitionAgentState('cancel-all-1', AGENT_STATES.RUNNING, 'Busy', { principal: TEST_PRINCIPAL });
  lifecycle.transitionAgentState('cancel-all-2', AGENT_STATES.RUNNING, 'Busy', { principal: TEST_PRINCIPAL });

  lifecycle.cancelAll('Emergency shutdown', { principal: TEST_PRINCIPAL });

  assert.strictEqual(lifecycle.getAgent('cancel-all-1').state, AGENT_STATES.CANCELING);
  assert.strictEqual(lifecycle.getAgent('cancel-all-2').state, AGENT_STATES.CANCELING);
  assert.strictEqual(lifecycle.getAgent('cancel-all-1').stateDetail, 'Emergency shutdown');
  assert.strictEqual(lifecycle.getAgent('cancel-all-2').stateDetail, 'Emergency shutdown');

  const cancelingReasons = emittedEvents
    .filter((e) => e.type === 'state_change' && e.payload?.to === AGENT_STATES.CANCELING)
    .map((e) => e.payload.stateDetail);
  assert.ok(cancelingReasons.includes('User stop'));
  assert.strictEqual(
    cancelingReasons.filter((r) => r === 'Emergency shutdown').length,
    2,
    'Both bulk-cancelled agents report the caller reason'
  );
});

// ============================================================================
// 9. Live Dynamic Configuration & System Prompt Synchronization (INV-CONFIG-SYNC)
// ============================================================================

test('9. Live Dynamic Configuration & System Prompt Synchronization (INV-CONFIG-SYNC)', async () => {
  const emittedEvents = [];
  const mockMessagingBus = {
    registered: new Map(),
    registerAgent(id, pol) { this.registered.set(id, pol); },
    isRegistered(id) { return this.registered.has(id); }
  };

  const lifecycle = new AgentLifecycleManager({
    runtime: { _emit: (e) => emittedEvents.push(e), _setupAgentMailSubscription: () => () => {} },
    emit: { emit: (e) => emittedEvents.push(e) },
    messagingBus: mockMessagingBus,
    internalPrincipal: TEST_PRINCIPAL
  });

  const agent = await lifecycle.launchAgent({
    config: {
      id: 'dynamic-agent',
      name: 'Initial Name',
      role: 'writer',
      systemPrompt: 'Original character directive.',
      allowedTools: ['read_file']
    }
  });

  assert.strictEqual(agent.history[0].content, 'Original character directive.');

  // Authority-bearing edits require lifecycle authority (MOD-21)
  assert.throws(
    () => lifecycle.updateAgentConfig('dynamic-agent', { privileged: true }),
    (err) => err.code === 'PERMISSION_DENIED',
    'Anonymous privileged grant is denied'
  );
  assert.strictEqual(agent.config.privileged, false, 'Denied grant leaves config unchanged');

  // Update Config with Live System Prompt Synchronization (authorized)
  lifecycle.updateAgentConfig('dynamic-agent', {
    name: 'Updated Name',
    role: 'senior-writer',
    systemPrompt: 'Updated senior character directive.',
    allowedTools: ['read_file', 'write_file'],
    privileged: true,
    maxTurns: 50
  }, { principal: TEST_PRINCIPAL });

  assert.strictEqual(agent.name, 'Updated Name');
  assert.strictEqual(agent.config.role, 'senior-writer');
  assert.strictEqual(agent.config.maxTurns, 50);
  assert.deepStrictEqual(agent.config.allowedTools, ['read_file', 'write_file']);
  assert.strictEqual(agent.config.privileged, true);
  assert.strictEqual(mockMessagingBus.registered.get(genericKey('dynamic-agent'))?.privileged, true);

  // System Prompt in history[0] updated in-place (INV-CONFIG-SYNC)
  assert.strictEqual(agent.history[0].role, 'system');
  assert.strictEqual(agent.history[0].content, 'Updated senior character directive.');

  // Event emission
  assert.ok(emittedEvents.some(e => e.type === 'agent_config_updated' && e.agentId === 'dynamic-agent'));

  // whoami descriptor reflects updated state
  const identity = lifecycle.whoami('dynamic-agent');
  assert.strictEqual(identity.name, 'Updated Name');
  assert.strictEqual(identity.privileged, true);
  assert.deepStrictEqual(identity.allowedTools, ['read_file', 'write_file']);
});

// ============================================================================
// 9b. INV-CONFIG-SYNC: empty system prompt never inserts a message
// ============================================================================

test('9b. updateAgentConfig never inserts an empty system prompt (INV-CONFIG-SYNC)', async () => {
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} } });
  const agent = await lifecycle.launchAgent({ config: { id: 'empty-prompt-agent' } });
  assert.strictEqual(agent.history.length, 0);

  lifecycle.updateAgentConfig('empty-prompt-agent', { systemPrompt: '' });
  assert.strictEqual(agent.history.length, 0, 'Empty prompt never inserts a system message');
  assert.strictEqual(agent.config.systemPrompt, '');

  lifecycle.updateAgentConfig('empty-prompt-agent', { systemPrompt: 'Now non-empty' });
  assert.strictEqual(agent.history.length, 1);
  assert.strictEqual(agent.history[0].role, 'system');
  assert.strictEqual(agent.history[0].content, 'Now non-empty');
});

// ============================================================================
// 9c. MOD-20 preset binding forwarding (additive plumbing)
// ============================================================================

test('9c. launchAgent forwards presetSource, preserves presetId, and updateAgentConfig accepts it', async () => {
  const presetSource = Object.freeze({
    getPreset: (id) => (id === 'preset_bound'
      ? Object.freeze({
        id: 'preset_bound',
        name: 'Bound Preset',
        isCustom: false,
        modelConfig: Object.freeze({ providerId: 'deepseek', modelId: 'deepseek-chat' })
      })
      : null),
    getDefaultPresetId: () => 'preset_bound',
    subscribe: () => () => {}
  });

  const lifecycle = new AgentLifecycleManager({
    emit: { emit: () => {} },
    presetSource,
    internalPrincipal: TEST_PRINCIPAL
  });

  // Bound launch: the preset materializes the effective model config and the
  // caller's explicit modelConfig does not act as an override layer.
  const bound = await lifecycle.launchAgent({
    config: {
      id: 'bound-launch-agent',
      presetId: 'preset_bound',
      modelConfig: { providerId: 'runware', modelId: 'legacy-override' }
    }
  });
  assert.strictEqual(bound.config.presetId, 'preset_bound');
  assert.strictEqual(bound.modelConfig.providerId, 'deepseek');
  assert.strictEqual(bound.modelConfig.modelId, 'deepseek-chat');
  assert.strictEqual(bound.modelConfig.keyId, 'canonical_deepseek');
  assert.strictEqual(bound.provider.id, 'deepseek');

  // Unbound launch: the source binds the catalog default at creation (ICD §6),
  // so the composed config carries the default binding even when the caller
  // supplied no presetId.
  const unbound = await lifecycle.launchAgent({ config: { id: 'unbound-launch-agent' } });
  assert.strictEqual(unbound.config.presetId, 'preset_bound');
  assert.strictEqual(unbound.modelConfig.providerId, 'deepseek');
  assert.strictEqual(unbound.modelConfig.modelId, 'deepseek-chat');

  // updateAgentConfig accepts the binding and round-trips it through the merge.
  lifecycle.updateAgentConfig('bound-launch-agent', { presetId: 'preset_bound' });
  assert.strictEqual(bound.config.presetId, 'preset_bound');

  // Snapshot round-trip keeps the binding on the persisted config.
  const persisted = bound.toSnapshot();
  assert.strictEqual(persisted.config.presetId, 'preset_bound');
});

// ============================================================================
// 10. In-Place Conversational Message Mutation & Identity (INV-MSG-MUTATION)
// ============================================================================

test('10. In-Place Conversational Message Mutation & Identity (INV-MSG-MUTATION)', () => {
  const emittedEvents = [];
  const agents = new Map();
  const mockRuntime = {
    _emit: (e) => emittedEvents.push(e),
    getAgent: (id) => agents.get(id) || null
  };

  const historyManager = new HistoryManager(mockRuntime);
  const agent = new Agent({
    id: 'history-agent',
    history: [
      { id: 'msg_1', role: 'user', content: 'Initial prompt' },
      { id: 'msg_2', role: 'assistant', content: 'Initial response', reasoning_content: 'Thought process' }
    ]
  });
  agents.set('history-agent', agent);

  // 1. Update by integer index
  const updated1 = historyManager.updateHistoryMessage('history-agent', 0, {
    content: 'Refined user prompt',
    metadata: { edited: true }
  });
  assert.strictEqual(updated1.content, 'Refined user prompt');
  assert.strictEqual(agent.history[0].content, 'Refined user prompt');
  assert.strictEqual(agent.history[0].metadata?.edited, true);

  // 2. Update by string ID
  const updated2 = historyManager.updateHistoryMessage('history-agent', 'msg_2', {
    content: 'Refined assistant response',
    reasoning_content: 'Refined thought process'
  });
  assert.strictEqual(updated2.content, 'Refined assistant response');
  assert.strictEqual(updated2.reasoning_content, 'Refined thought process');
  assert.strictEqual(agent.history[1].content, 'Refined assistant response');

  // 3. Simple string update payload
  historyManager.updateHistoryMessage('history-agent', 0, 'Simple string overwrite');
  assert.strictEqual(agent.history[0].content, 'Simple string overwrite');

  // 4. Index out of bounds throws INDEX_OUT_OF_BOUNDS
  assert.throws(
    () => historyManager.updateHistoryMessage('history-agent', 99, { content: 'test' }),
    (err) => err.code === 'INDEX_OUT_OF_BOUNDS'
  );

  // 5. Message ID not found throws MESSAGE_NOT_FOUND
  assert.throws(
    () => historyManager.updateHistoryMessage('history-agent', 'msg_unknown', { content: 'test' }),
    (err) => err.code === 'MESSAGE_NOT_FOUND'
  );
});

// ============================================================================
// 10b. HistoryManagerOptions.emit honored in the options form
// ============================================================================

test('10b. HistoryManagerOptions.emit is honored in the {runtime, emit} form', () => {
  const emitted = [];
  const agents = new Map();
  const agent = new Agent({
    id: 'emit-option-agent',
    history: [{ id: 'm1', role: 'user', content: 'Initial' }]
  });
  agents.set('emit-option-agent', agent);
  const runtime = { getAgent: (id) => agents.get(id) || null };

  // { runtime, emit } — events flow through the injected port
  const manager = new HistoryManager({ runtime, emit: { emit: (e) => emitted.push(e) } });
  manager.updateHistoryMessage('emit-option-agent', 0, { content: 'Updated' });
  assert.ok(emitted.some(e => e.type === 'message_updated'), 'message_updated emitted through the options emit port');

  // { runtime: null, emit } — the options object must not be mistaken for the runtime
  const inert = new HistoryManager({ runtime: null, emit: { emit: () => {} } });
  assert.strictEqual(inert.isAgentInterrupted('emit-option-agent'), false);
  assert.throws(
    () => inert.updateHistoryMessage('emit-option-agent', 0, { content: 'Nope' }),
    (err) => err.code === 'AGENT_NOT_FOUND',
    'Falsy runtime in the options form keeps the declared not-found behavior'
  );
});

// ============================================================================
// 11. Cascading Tool-Pairing Hygiene Deletion (INV-5 / INV-TOOL-HYGIENE)
// ============================================================================

test('11. Cascading Tool-Pairing Hygiene Deletion (INV-TOOL-HYGIENE)', () => {
  const emittedEvents = [];
  const agents = new Map();
  const mockRuntime = {
    _emit: (e) => emittedEvents.push(e),
    getAgent: (id) => agents.get(id) || null
  };

  const historyManager = new HistoryManager(mockRuntime);

  // Scenario 1: Deleting assistant message with tool calls cascade-deletes downstream tool responses
  const agent1 = new Agent({
    id: 'hygiene-agent-1',
    history: [
      { id: 'u1', role: 'user', content: 'What is the weather?' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Checking...',
        tool_calls: [
          { id: 'call_weather_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          { id: 'call_weather_2', type: 'function', function: { name: 'get_forecast', arguments: '{}' } }
        ]
      },
      { id: 't1', role: 'tool', tool_call_id: 'call_weather_1', content: 'Sunny 72F' },
      { id: 't2', role: 'tool', tool_call_id: 'call_weather_2', content: 'Clear skies' },
      { id: 'a2', role: 'assistant', content: 'It is sunny and 72F.' }
    ]
  });
  agents.set('hygiene-agent-1', agent1);

  const deletedAssistant = historyManager.deleteHistoryMessage('hygiene-agent-1', 'a1');
  assert.strictEqual(deletedAssistant, true);

  // a1, t1, and t2 are all cleanly pruned; only u1 and a2 remain
  assert.deepStrictEqual(
    agent1.history.map(m => m.id),
    ['u1', 'a2'],
    'Tool responses t1 and t2 cascade-deleted with declaring assistant message a1'
  );

  // Scenario 2: Deleting a tool response message prunes declaring tool_call in preceding assistant message
  const agent2 = new Agent({
    id: 'hygiene-agent-2',
    history: [
      { id: 'u1', role: 'user', content: 'Read two files' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_file_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
          { id: 'call_file_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } }
        ]
      },
      { id: 't1', role: 'tool', tool_call_id: 'call_file_1', content: 'File A content' },
      { id: 't2', role: 'tool', tool_call_id: 'call_file_2', content: 'File B content' }
    ]
  });
  agents.set('hygiene-agent-2', agent2);

  // Delete t1
  historyManager.deleteHistoryMessage('hygiene-agent-2', 't1');

  // t1 is removed, and a1.tool_calls now only contains call_file_2
  assert.strictEqual(agent2.history.find(m => m.id === 't1'), undefined);
  const assistantMsg = agent2.history.find(m => m.id === 'a1');
  assert.strictEqual(assistantMsg.tool_calls.length, 1);
  assert.strictEqual(assistantMsg.tool_calls[0].id, 'call_file_2');

  // Delete remaining tool response t2 -> assistant tool_calls becomes empty and is removed
  historyManager.deleteHistoryMessage('hygiene-agent-2', 't2');
  assert.strictEqual(assistantMsg.tool_calls, undefined, 'tool_calls property pruned when empty');
});

// ============================================================================
// 12. Dual-Stack Undo/Redo with Atomic TurnBundle Snapshotting (INV-UNDO-BUNDLE)
// ============================================================================

test('12. Dual-Stack Undo/Redo with Atomic TurnBundle Snapshotting (INV-UNDO-BUNDLE)', () => {
  const emittedEvents = [];
  const agents = new Map();
  const mockRuntime = {
    _emit: (e) => emittedEvents.push(e),
    getAgent: (id) => agents.get(id) || null
  };

  const historyManager = new HistoryManager(mockRuntime);

  const agent = new Agent({
    id: 'undo-agent',
    turnCount: 2,
    history: [
      { id: 'sys_0', role: 'system', content: 'You are helpful.' },
      { id: 'u1', role: 'user', content: 'Turn 1 prompt' },
      { id: 'a1', role: 'assistant', content: 'Turn 1 response' },
      { id: 'u2', role: 'user', content: 'Turn 2 prompt' },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Turn 2 response',
        tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'calc', arguments: '{}' } }]
      },
      { id: 't2', role: 'tool', tool_call_id: 'tc_2', content: '42' }
    ]
  });
  agents.set('undo-agent', agent);

  // 1. Execute Turn Undo (explicit selector naming the most recent user turn)
  const undoResult = historyManager.undoAgentTurn('undo-agent', 'u2');

  assert.strictEqual(undoResult.undoneUserContent, 'Turn 2 prompt');
  assert.strictEqual(undoResult.undoneAssistantContent, 'Turn 2 response');
  assert.strictEqual(undoResult.restoredPrompt, 'Turn 2 prompt');
  assert.strictEqual(agent.turnCount, 1, 'turnCount decremented to 1');

  // Remaining history only contains Turn 1 + System prompt
  assert.deepStrictEqual(
    agent.history.map(m => m.id),
    ['sys_0', 'u1', 'a1']
  );

  // TurnBundle pushed onto redoStack
  assert.strictEqual(agent.redoStack.length, 1);
  const bundle = agent.redoStack[0];
  assert.strictEqual(bundle.turnId, 'u2');
  assert.strictEqual(bundle.userPrompt, 'Turn 2 prompt');
  assert.strictEqual(bundle.restoredPrompt, 'Turn 2 prompt');
  assert.strictEqual(bundle.finalOutput, 'Turn 2 response');
  assert.strictEqual(bundle.turnCountDelta, 1);
  assert.strictEqual(bundle.allPoppedMessages.length, 3); // u2, a2, t2

  // 2. Execute Turn Redo
  const redoResult = historyManager.redoAgentTurn('undo-agent');

  assert.strictEqual(redoResult.success, true);
  assert.strictEqual(redoResult.restoredPrompt, 'Turn 2 prompt');
  assert.strictEqual(redoResult.turnCount, 2);
  assert.strictEqual(agent.turnCount, 2, 'turnCount incremented back to 2');
  assert.strictEqual(agent.redoStack.length, 0, 'redoStack emptied');

  // History restored in exact chronological sequence
  assert.deepStrictEqual(
    agent.history.map(m => m.id),
    ['sys_0', 'u1', 'a1', 'u2', 'a2', 't2']
  );

  // Redo on empty stack returns success: false
  const emptyRedo = historyManager.redoAgentTurn('undo-agent');
  assert.strictEqual(emptyRedo.success, false);
  assert.strictEqual(emptyRedo.reason, 'EMPTY_REDO_STACK');
});

// ============================================================================
// 12b. Undo/redo must not inflate turnCount when no decrement occurred
// ============================================================================

test('12b. Redo never inflates turnCount after a no-op undo decrement', () => {
  const agents = new Map();
  const mockRuntime = {
    getAgent: (id) => agents.get(id) || null
  };
  const historyManager = new HistoryManager(mockRuntime);

  // Case 1: turnCount already zero — undo cannot decrement, redo must not inflate
  const agentZero = new Agent({
    id: 'redo-zero-agent',
    turnCount: 0,
    history: [
      { id: 'sys_0', role: 'system', content: 'You are helpful.' },
      { id: 'u1', role: 'user', content: 'Prompt' },
      { id: 'a1', role: 'assistant', content: 'Response' }
    ]
  });
  agents.set('redo-zero-agent', agentZero);

  historyManager.undoAgentTurn('redo-zero-agent');
  assert.strictEqual(agentZero.turnCount, 0, 'Undo cannot decrement below zero');
  assert.strictEqual(agentZero.redoStack[0].turnCountDelta, 0, 'Bundle records no decrement');

  const redoZero = historyManager.redoAgentTurn('redo-zero-agent');
  assert.strictEqual(redoZero.success, true);
  assert.strictEqual(redoZero.turnCount, 0, 'Redo receipt reports the unchanged count');
  assert.strictEqual(agentZero.turnCount, 0, 'Redo must not inflate turnCount from zero');
  assert.deepStrictEqual(agentZero.history.map(m => m.id), ['sys_0', 'u1', 'a1']);

  // Case 2: positive count but emptied assistant content (INV-6: no decrement)
  const agentEmpty = new Agent({
    id: 'redo-empty-content-agent',
    turnCount: 3,
    history: [
      { id: 'sys_0', role: 'system', content: 'Sys' },
      { id: 'u1', role: 'user', content: 'Prompt' },
      { id: 'a1', role: 'assistant', content: '' }
    ]
  });
  agents.set('redo-empty-content-agent', agentEmpty);

  historyManager.undoAgentTurn('redo-empty-content-agent');
  assert.strictEqual(agentEmpty.turnCount, 3, 'No decrement for empty assistant content');
  assert.strictEqual(agentEmpty.redoStack[0].turnCountDelta, 0);

  historyManager.redoAgentTurn('redo-empty-content-agent');
  assert.strictEqual(agentEmpty.turnCount, 3, 'Redo must not inflate turnCount after a no-op decrement');
});

// ============================================================================
// 12c. Empty-history undo recovers the prompt into a redoable bundle
// ============================================================================

test('12c. Empty-history undo pushes a redoable bundle and emits turn_undone', () => {
  const emitted = [];
  const agents = new Map();
  const mockRuntime = {
    getAgent: (id) => agents.get(id) || null
  };
  const historyManager = new HistoryManager({
    runtime: mockRuntime,
    emit: { emit: (e) => emitted.push(e) }
  });

  const agent = new Agent({ id: 'empty-history-undo' });
  agent.history = [];
  agent.lastError = 'Interrupted mid-turn';
  agent.lastInterruptedTurn = {
    input: 'Recovered draft prompt',
    mode: 'chat',
    timestamp: 1773700000000,
    cancelled: true
  };
  agents.set('empty-history-undo', agent);

  const undo = historyManager.undoAgentTurn('empty-history-undo');
  assert.strictEqual(undo.undoneUserContent, 'Recovered draft prompt');
  assert.strictEqual(undo.undoneAssistantContent, null);
  assert.strictEqual(undo.count, 0);
  assert.strictEqual(undo.restoredPrompt, 'Recovered draft prompt');
  assert.strictEqual(agent.lastInterruptedTurn, null, 'Interrupted record consumed by undo');
  assert.strictEqual(agent.lastError, null, 'Error banner cleared alongside the recovery');

  assert.strictEqual(agent.redoStack.length, 1, 'Recovery pushed onto the redo stack');
  const bundle = agent.redoStack[0];
  assert.strictEqual(bundle.restoredPrompt, 'Recovered draft prompt');
  assert.strictEqual(bundle.userPrompt, 'Recovered draft prompt');
  assert.strictEqual(bundle.userMessage, null);
  assert.deepStrictEqual(bundle.allPoppedMessages, []);
  assert.strictEqual(bundle.turnCountDelta, 0);
  assert.ok(
    emitted.some(e => e.type === 'turn_undone' && e.payload?.restoredPrompt === 'Recovered draft prompt'),
    'turn_undone emitted for the recovered prompt'
  );

  const redo = historyManager.redoAgentTurn('empty-history-undo');
  assert.strictEqual(redo.success, true, 'Recovered prompt is redoable');
  assert.strictEqual(redo.restoredPrompt, 'Recovered draft prompt');
  assert.strictEqual(agent.turnCount, 0);

  // Message-object inputs are recovered through their `.content`
  const objectAgent = new Agent({ id: 'empty-history-object-input' });
  objectAgent.history = [];
  objectAgent.lastInterruptedTurn = {
    input: { role: 'user', content: 'Object prompt' },
    timestamp: 1773700000001,
    cancelled: true
  };
  agents.set('empty-history-object-input', objectAgent);
  const objectUndo = historyManager.undoAgentTurn('empty-history-object-input');
  assert.strictEqual(objectUndo.restoredPrompt, 'Object prompt');

  // No recoverable prompt keeps the legacy early-return behavior
  const emptyAgent = new Agent({ id: 'empty-history-no-prompt' });
  emptyAgent.history = [];
  agents.set('empty-history-no-prompt', emptyAgent);
  const emptyUndo = historyManager.undoAgentTurn('empty-history-no-prompt');
  assert.strictEqual(emptyUndo.restoredPrompt, '');
  assert.strictEqual(emptyAgent.redoStack.length, 0, 'Nothing pushed without a recovered prompt');
});

// ============================================================================
// 13. Mid-Turn Error Recovery & Context Preservation (INV-HISTORY-PRESERVE)
// ============================================================================

test('13. Mid-Turn Error Recovery & Context Preservation (INV-HISTORY-PRESERVE)', async () => {
  const retryCalls = [];
  const agents = new Map();
  const mockRuntime = {
    getAgent: (id) => agents.get(id) || null,
    executeAgentTurn: async (id, input, opts) => {
      retryCalls.push({ id, input, opts });
      return { output: 'Success' };
    }
  };

  const historyManager = new HistoryManager(mockRuntime);

  // Scenario 1: Tail is unresponded user message
  const agentUserTail = new Agent({
    id: 'agent-user-tail',
    history: [
      { id: 's1', role: 'system', content: 'Sys' },
      { id: 'u1', role: 'user', content: 'Calculate 2+2' }
    ]
  });
  agents.set('agent-user-tail', agentUserTail);

  assert.strictEqual(historyManager.isAgentInterrupted('agent-user-tail'), true);

  await historyManager.retryAgentTurn('agent-user-tail');
  assert.strictEqual(retryCalls.length, 1);
  assert.strictEqual(retryCalls[0].id, 'agent-user-tail');
  assert.strictEqual(retryCalls[0].input, 'Calculate 2+2', 'Re-executed with user prompt');

  // Scenario 2: Tail is tool message (Tool execution mid-turn failure)
  retryCalls.length = 0;
  const agentToolTail = new Agent({
    id: 'agent-tool-tail',
    history: [
      { id: 's1', role: 'system', content: 'Sys' },
      { id: 'u1', role: 'user', content: 'Fetch data' },
      { id: 'a1', role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
      { id: 't1', role: 'tool', tool_call_id: 'c1', content: '{"status": 200}' }
    ]
  });
  agents.set('agent-tool-tail', agentToolTail);

  assert.strictEqual(historyManager.isAgentInterrupted('agent-tool-tail'), true);

  // Retrying tool tail resumes LLM completion with input = null (NO duplicate user prompt)
  await historyManager.retryAgentTurn('agent-tool-tail');
  assert.strictEqual(retryCalls.length, 1);
  assert.strictEqual(retryCalls[0].id, 'agent-tool-tail');
  assert.strictEqual(retryCalls[0].input, null, 'Resumed in-progress history with input = null');

  // Scenario 3: Completed turn (Tail is assistant message)
  retryCalls.length = 0;
  const agentAssistantTail = new Agent({
    id: 'agent-assistant-tail',
    turnCount: 1,
    history: [
      { id: 's1', role: 'system', content: 'Sys' },
      { id: 'u1', role: 'user', content: 'Tell me a joke' },
      { id: 'a1', role: 'assistant', content: 'Why did the chicken cross the road?' }
    ]
  });
  agents.set('agent-assistant-tail', agentAssistantTail);

  assert.strictEqual(historyManager.isAgentInterrupted('agent-assistant-tail'), false);

  await historyManager.retryAgentTurn('agent-assistant-tail');
  assert.strictEqual(retryCalls.length, 1);
  assert.strictEqual(retryCalls[0].id, 'agent-assistant-tail');
  assert.strictEqual(retryCalls[0].input, 'Tell me a joke', 'Turn undone and retried with original prompt');
});

// ============================================================================
// 14. MOD-21 W10-A Authority Channel Hardening
// (5b585b7 direct config writes, 0a87141 snapshot parentage, 4300b06 facade
//  own-read iteration, 7db884b caller-object TOCTOU)
// ============================================================================

test('14. live config authority fields are owner-controlled read-only projections (5b585b7)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'w10_mallory', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'w10_victim' });

    const cfg = runtime.getAgent('w10_mallory').config;
    const attempts = [
      () => { cfg.privileged = true; },
      () => { Object.assign(cfg, { privileged: true }); },
      () => { cfg.allowedTools = ['*']; },
      () => { Object.assign(cfg, { allowedTools: ['*'] }); },
      () => { cfg.spawnedBy = 'w10_victim'; },
      () => { Object.defineProperty(cfg, 'privileged', { value: true, configurable: true }); }
    ];
    for (const attempt of attempts) {
      assert.throws(attempt, TypeError, 'direct authority writes must fail closed');
    }
    assert.strictEqual(cfg.privileged, false, 'direct writes must not mint privilege');
    assert.deepStrictEqual(cfg.allowedTools, ['read_file'], 'direct writes must not widen capability');
    assert.strictEqual(cfg.spawnedBy, null, 'direct writes must not graft parentage');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('w10_mallory').authority.allow.has('*'),
      false,
      'the registry descriptor must stay default-deny'
    );

    // The gated manager path remains the only authority writer.
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director')?.authority;
    const granted = runtime.updateAgentConfig('w10_mallory', { privileged: true }, { principal: operator });
    assert.strictEqual(granted.config.privileged, true, 'the gated manager grant still applies');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('w10_mallory').authority.allow.has('*'),
      true,
      'the operator grant rebuilds the registry descriptor'
    );
  } finally {
    runtime.destroy();
  }
});

test('14b. snapshot hydration drops caller-supplied parentage (0a87141)', async () => {
  const source = createAgentRuntime({ autoBootstrapDirector: false });
  await source.launchAgent({ id: 'w10_parent' });
  await source.launchAgent({ id: 'w10_child' });
  const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot()));
  source.destroy();

  const victim = snapshot.agents.find((entry) => entry.id === 'w10_child');
  victim.config.spawnedBy = 'w10_parent';
  victim.config.creatorId = 'w10_parent';

  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot(snapshot);
    assert.notStrictEqual(runtime.getAgent('w10_child').config.spawnedBy, 'w10_parent', 'snapshot parentage must not be adopted');
    assert.notStrictEqual(runtime.getAgent('w10_child').config.creatorId, 'w10_parent', 'snapshot parentage must not be adopted');
    assert.throws(
      () => runtime.killAgent('w10_child', 'forged snapshot parentage', { callerAgentId: 'w10_parent' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a snapshot-forged parent cannot kill the hydrated child'
    );
    assert.strictEqual(runtime.invokeAgent('w10_parent', 'w10_child', 'P').code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('14c. authority facade reads are independent of Array.prototype (4300b06)', () => {
  const allow = new Agent({ id: 'w10_facade', allowedTools: ['read_file'] }).authority.allow;
  const originalIncludes = Array.prototype.includes;
  const originalIterator = Array.prototype[Symbol.iterator];
  let widened = null;
  let iterated = null;
  Array.prototype.includes = function patchedIncludes() { return true; };
  Array.prototype[Symbol.iterator] = function patchedIterator() {
    let emitted = false;
    const hostile = {
      next() {
        if (!emitted) {
          emitted = true;
          return { value: '*', done: false };
        }
        return { value: undefined, done: true };
      }
    };
    hostile[Symbol.iterator] = () => hostile;
    return hostile;
  };
  try {
    widened = allow.has('*');
    iterated = [];
    const iterator = allow.values();
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      iterated[iterated.length] = step.value;
    }
  } finally {
    Array.prototype.includes = originalIncludes;
    Array.prototype[Symbol.iterator] = originalIterator;
  }
  assert.strictEqual(widened, false, 'a patched Array.prototype.includes must not widen the allow-set');
  assert.deepStrictEqual(iterated, ['read_file'], 'iteration must yield only the real member strings');
});

test('14d. a stateful Proxy cannot TOCTOU the authority gate (7db884b)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'w10_proxy', allowedTools: ['read_file'] });
    let privilegedReads = 0;
    const proxy = new Proxy({ name: 'benign' }, {
      get(target, key) {
        if (key === 'privileged') {
          privilegedReads += 1;
          return privilegedReads > 1 ? true : undefined;
        }
        return target[key];
      },
      ownKeys: (target) => [...Reflect.ownKeys(target), 'privileged'],
      getOwnPropertyDescriptor: (target, key) => (
        key === 'privileged'
          ? { value: true, enumerable: true, configurable: true, writable: true }
          : Reflect.getOwnPropertyDescriptor(target, key)
      )
    });

    assert.throws(
      () => runtime.updateAgentConfig('w10_proxy', proxy, null),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the manager gate must deny the stateful Proxy before mutation'
    );
    assert.throws(
      () => runtime.getAgent('w10_proxy').updateConfig(proxy),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the entity deny-filter must reject the stateful Proxy'
    );
    assert.strictEqual(runtime.getAgent('w10_proxy').config.privileged, false, 'the Proxy must not mint privilege');
    assert.deepStrictEqual(runtime.getAgent('w10_proxy').config.allowedTools, ['read_file']);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 15. MOD-21 W11-A Hardening
// (556636e pollution-safe config adoption + snapshot rejection, 26a65c5
//  owner-controlled authority provenance + channel bind on director rebuild,
//  18f43d6 intrinsic authority dispatch + immutable authority methods)
// ============================================================================

/**
 * Canonical tampered config: an own `__proto__` data key (JSON.parse) carrying
 * capability, privilege and parentage payloads.
 * @returns {Record<string, any>}
 */
function w11PollutedConfig() {
  return JSON.parse(
    '{"id":"w11_victim","name":"w11_victim","role":"user","__proto__":{"allowedTools":["*"],"tools":["*"],"privileged":true,"spawnedBy":"w11_mallory","creatorId":"w11_mallory"}}'
  );
}

test('15a. config adoption is pollution-safe and snapshots reject prototype-polluting keys (556636e)', () => {
  const agent = new Agent(w11PollutedConfig());
  assert.strictEqual(
    Object.getPrototypeOf(agent.config),
    Object.prototype,
    'the constructor must not adopt an own __proto__ config key as the live prototype'
  );
  assert.strictEqual(agent.config.privileged ?? false, false, 'the constructor must not mint privilege');
  assert.strictEqual(agent.config.spawnedBy ?? null, null, 'the constructor must not adopt parentage');
  assert.strictEqual(agent.authority.allow.has('*'), false, 'the authority descriptor must stay default-deny');

  agent.config = w11PollutedConfig();
  assert.strictEqual(
    Object.getPrototypeOf(agent.config),
    Object.prototype,
    'the config setter must build a pollution-safe config object'
  );
  assert.strictEqual(agent.config.spawnedBy ?? null, null, 'config replacement must not adopt parentage');

  assert.throws(
    () => Agent.fromSnapshot({ id: 'w11_victim', config: w11PollutedConfig(), history: [] }),
    (err) => err?.code === 'INVALID_CONFIG',
    'fromSnapshot must reject a prototype-polluting config (fail closed)'
  );

  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.launchAgent({ id: 'w11_mallory' });
    assert.throws(
      () => runtime.importSnapshot({
        agents: [
          { id: 'w11_mallory', config: { id: 'w11_mallory' } },
          { id: 'w11_victim', config: w11PollutedConfig(), history: [] }
        ],
        recycleBin: []
      }),
      (err) => err?.code === 'ERR_SNAPSHOT_INVALID',
      'the direct importSnapshot facade must reject a prototype-polluting config'
    );
    assert.strictEqual(runtime.getAgent('w11_victim'), null, 'the polluted victim must not hydrate');
    assert.ok(runtime.getAgent('w11_mallory'), 'the prior registry must stay intact after the rejected import');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('w11_mallory').authority.allow.has('*'),
      false,
      'the registry descriptor stays default-deny'
    );
  } finally {
    runtime.destroy();
  }
});

test('15b. authorityProvenance is owner-controlled and the director refuses a later channel claim (26a65c5)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'w11_peer' });
    const director = runtime.getAgent('director');

    const descriptor = Object.getOwnPropertyDescriptor(director, 'authorityProvenance');
    assert.ok(descriptor, 'authorityProvenance must be an own property');
    assert.notStrictEqual(descriptor.writable, true, 'authorityProvenance must not be a writable data property');
    assert.strictEqual(typeof descriptor.set, 'undefined', 'authorityProvenance must not expose a setter');
    assert.throws(
      () => { director.authorityProvenance = 'snapshot'; },
      TypeError,
      'a public provenance write must fail closed'
    );
    assert.strictEqual(director.authorityProvenance, 'construction', 'provenance stays construction');

    assert.strictEqual(
      director.bindAuthorityChannel({ forged: true }),
      false,
      'the launched director is channel-bound (first bind wins)'
    );
    assert.throws(
      () => runtime.killAgent('director', 'claimed parentage', { callerAgentId: 'w11_peer' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a peer cannot kill the director through a claimed channel'
    );
    assert.ok(runtime.getAgent('director'), 'the denied kill leaves the director active');
  } finally {
    runtime.destroy();
  }
});

test('15c. the manager channel never reaches a substituted entity method (18f43d6)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'w11_mallory', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'w11_victim' });
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;

    let captured = null;
    const hostile = Object.create(Agent.prototype);
    Object.defineProperty(hostile, 'applyAuthorityConfig', {
      value: (_patch, channel) => {
        captured = channel;
        return hostile;
      },
      writable: true,
      enumerable: true,
      configurable: true
    });

    const mallory = runtime.getAgent('w11_mallory');
    assert.throws(
      () => Object.setPrototypeOf(mallory, hostile),
      TypeError,
      'the entity [[Prototype]] slot must not be replaceable'
    );
    assert.throws(
      () => { mallory.applyAuthorityConfig = () => { captured = 'own-shadow'; }; },
      TypeError,
      'the non-extensible entity must refuse an own authority-method shadow'
    );

    runtime.updateAgentConfig('w11_mallory', { allowedTools: ['read_file', 'list_files'] }, { principal: operator });
    assert.strictEqual(captured, null, 'the manager channel must not reach a substituted method');
    assert.deepStrictEqual(
      runtime.getAgent('w11_mallory').config.allowedTools,
      ['read_file', 'list_files'],
      'the operator capability edit still applies through the intrinsic'
    );

    const originalApply = Agent.prototype.applyAuthorityConfig;
    assert.throws(
      () => { Agent.prototype.applyAuthorityConfig = function () {}; },
      TypeError,
      'authority methods must be non-writable on the prototype'
    );
    assert.strictEqual(Agent.prototype.applyAuthorityConfig, originalApply, 'the intrinsic method is intact');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 16. Realm Membership (Realm wave A, f5d1ccc)
// ============================================================================

test('16. realmId is owner-controlled, launch-inherited, defaults to Generic, and is immutable on update (f5d1ccc|56ba4b9)', async () => {
  // Entity contract: membership is an authority-bearing projection, and unlike
  // capability selectors/parentage it is deliberately retained by snapshots.
  const entity = new Agent({ id: 'realm_entity', realmId: 'demo' });
  assert.strictEqual(entity.config.realmId, 'demo');
  assert.strictEqual(entity.realmId, 'demo', 'the owner-controlled instance projection mirrors the config');
  assert.throws(() => { entity.config.realmId = 'other'; }, TypeError, 'direct config writes must fail closed');
  assert.throws(
    () => entity.updateConfig({ realmId: 'other' }),
    (err) => err?.code === 'PERMISSION_DENIED',
    'the entity channel denies realm moves'
  );
  assert.strictEqual(entity.config.realmId, 'demo', 'a denied direct move leaves membership untouched');

  const snapshot = entity.toSnapshot();
  assert.strictEqual(snapshot.config.realmId, 'demo', 'the snapshot carries membership');
  const hydrated = Agent.fromSnapshot(snapshot);
  assert.strictEqual(hydrated.config.realmId, 'demo', 'membership hydrates (a constraint, not a grant)');
  assert.throws(() => { hydrated.config.realmId = 'other'; }, TypeError, 'the hydrated projection stays read-only');

  // Launch composition: inheritance from the RESOLVED creator, never from
  // caller-asserted parentage/realm claims.
  const mockRuntime = {
    _emit: () => {},
    executeAgentTurn: async () => ({}),
    _setupAgentMailSubscription: () => () => {}
  };
  const lifecycle = new AgentLifecycleManager({ runtime: mockRuntime, internalPrincipal: TEST_PRINCIPAL });

  await lifecycle.launchAgent({ config: { id: 'realm_lead', realmId: 'demo' }, principal: TEST_PRINCIPAL });
  await lifecycle.launchAgent({
    config: { id: 'realm_wildcard', realmId: 'demo', privileged: true, allowedTools: ['*'] },
    principal: TEST_PRINCIPAL
  });
  const inherited = await lifecycle.launchAgent({
    config: { id: 'realm_child' },
    callerContext: { callerAgentId: 'realm_lead' }
  });
  assert.strictEqual(inherited.config.realmId, 'demo', 'a non-authority creator cannot move its child across Realms');

  const forged = await lifecycle.launchAgent({
    config: { id: 'realm_forged', realmId: 'other' },
    callerContext: { callerAgentId: 'realm_lead' }
  });
  assert.strictEqual(forged.config.realmId, 'demo', 'a caller-supplied realmId is ignored without lifecycle authority');

  // Wave R (ticket 56ba4b9): every non-director launch without an explicit or
  // inherited membership resolves to the seeded Generic default realm.
  const defaulted = await lifecycle.launchAgent({ config: { id: 'realm_none' } });
  assert.strictEqual(defaulted.config.realmId, 'realm_generic', 'a principal-less launch resolves the Generic default');

  // An explicit null composes the bootstrap-only system scope only on the
  // exact injected `InternalPrincipal` path (the engine director bootstrap,
  // Wave I ticket c02d0b9); for every other launch it falls through to the
  // Generic default.
  const nullRequest = await lifecycle.launchAgent({ config: { id: 'realm_null_request', realmId: null }, principal: TEST_PRINCIPAL });
  assert.strictEqual(nullRequest.config.realmId, null, 'the engine principal composes the bootstrap-only null system scope');

  const nullAnonymous = await lifecycle.launchAgent({ config: { id: 'realm_null_anonymous', realmId: null } });
  assert.strictEqual(nullAnonymous.config.realmId, 'realm_generic', 'an explicit null falls through for a principal-less launch');

  // The bootstrap launch composes the null system scope plus the hardcoded
  // grant; the literal id is ordinary and grants nothing by itself.
  const bootstrap = await lifecycle.launchAgent({
    config: { id: 'director', realmId: null, realmBypass: true },
    principal: TEST_PRINCIPAL
  });
  assert.strictEqual(bootstrap.config.realmId, null, 'the engine bootstrap stays in the null system scope');
  assert.strictEqual(
    lifecycle.getAuthorityInputs('director').realmBypass,
    true,
    'the engine bootstrap composes the realmBypass grant'
  );

  // Immutable-membership matrix (Wave R): EVERY caller — an unprivileged
  // creator, a wildcard peer, a wildcard self, the injected internal
  // principal, and a caller naming the director id — is denied any
  // realmId change (a clear to null included). Changing realms means
  // terminate + relaunch into the target realm.
  const noMoveCallers = [
    { label: 'an unprivileged creator', context: { callerAgentId: 'realm_lead' } },
    { label: 'a wildcard peer', context: { callerAgentId: 'realm_wildcard' } },
    { label: 'a wildcard self', context: { callerAgentId: 'realm_wildcard' }, target: 'realm_wildcard' },
    { label: 'the injected internal principal', context: { principal: TEST_PRINCIPAL } },
    { label: 'a caller naming the director id', context: { callerAgentId: 'director' } }
  ];
  for (const move of noMoveCallers) {
    const target = move.target || 'realm_child';
    for (const patch of [{ realmId: 'other' }, { realmId: null }]) {
      assert.throws(
        () => lifecycle.updateAgentConfig(target, patch, move.context),
        (err) => err?.code === 'PERMISSION_DENIED',
        `${move.label} must be denied ${JSON.stringify(patch)}`
      );
    }
  }
  assert.strictEqual(lifecycle.getAgent('realm_child').config.realmId, 'demo', 'a denied move leaves membership untouched');
  assert.strictEqual(
    lifecycle.getAgent('realm_wildcard').config.realmId,
    'demo',
    'denied wildcard moves leave membership untouched'
  );
  assert.strictEqual(lifecycle.getAgent('realm_none').config.realmId, 'realm_generic', 'the default membership is untouched');

  // Non-realm authority fields keep the generic lifecycle-authority gate.
  const granted = lifecycle.updateAgentConfig('realm_child', { privileged: true }, { callerAgentId: 'realm_wildcard' });
  assert.strictEqual(granted.config.privileged, true, 'wildcard lifecycle authority still updates non-realm authority fields');
});
