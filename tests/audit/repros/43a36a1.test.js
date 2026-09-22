/**
 * @file tests/audit/repros/43a36a1.test.js
 * @description Audit repro for ticket 43a36a1 (Major; MOD-21):
 * privilege is serialized as data instead of being re-derived.
 *
 * Agent/persistence leg (MOD-21 W5; sub-issue 10): `Agent.toSnapshot()` carries
 * `config.privileged` verbatim, `Agent.fromSnapshot()` honors it, and a crafted
 * snapshot therefore grants live authority after `importSnapshot` /
 * `restoreRuntimeEnvironment`.
 *
 * Messaging-bus leg (MOD-21 W4): `MessagingBus.registerAgent` stores
 * caller-supplied `policy.privileged` verbatim (messagingBus.js:160-177),
 * `exportSnapshot` serializes it (:1434-1441), and `importSnapshot` restores
 * it, so a tampered or programmatically supplied snapshot grants live
 * bus-policy privilege.
 *
 * Ratified MOD-21 rule (90ad905): snapshots drop trust fields; restore
 * re-derives the frozen authority descriptor from trusted construction only.
 * A tampered privilege claim downgrades silently to anonymous and is recorded;
 * bus policy derives from the registry descriptor resolved through the injected
 * identity port or the opaque injected `internalPrincipal` reference, and the
 * `privileged` field is never persisted.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/43a36a1.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent, AGENT_STATES } from '../../../src/lib/sandbox/runtime/agent/index.ts';
import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { restoreRuntimeEnvironment } from '../../../src/lib/sandbox/sandboxPersistence/index.ts';
import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';

function buildAgentSnapshot(overrides = {}) {
  return {
    id: 'probe_privileged_agent',
    name: 'Probe Privileged Agent',
    config: {
      id: 'probe_privileged_agent',
      name: 'Probe Privileged Agent',
      role: 'admin',
      privileged: true,
      allowedTools: ['*'],
      ...(overrides.config || {})
    },
    state: AGENT_STATES.IDLE,
    stateDetail: null,
    turnCount: 0,
    telemetry: {
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
    },
    createdAt: 1773700000000,
    updatedAt: 1773700000000,
    lastSummary: null,
    lastError: null,
    lastInterruptedTurn: null,
    recycledAt: null,
    recycleReason: null,
    history: [],
    redoStack: [],
    pendingPrecalls: []
  };
}

function buildPersistedState(overrides = {}) {
  return {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'probe_privileged_agent',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [buildAgentSnapshot(overrides)],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };
}

// ---------------------------------------------------------------------------
// Agent/persistence leg (MOD-21 W5)
// ---------------------------------------------------------------------------

test('43a36a1: crafted snapshot config.privileged:true restores unprivileged through Agent.fromSnapshot', () => {
  const restored = Agent.fromSnapshot(structuredClone(buildAgentSnapshot()));

  assert.notStrictEqual(restored.config.privileged, true, 'snapshot privilege claim must not survive hydration');
  assert.ok(restored.authority, 'restored agent must expose the re-derived authority descriptor');
  assert.equal(restored.authority.subject, 'probe_privileged_agent');
  assert.equal(restored.authority.kind, 'agent');
  assert.equal(restored.authority.allow.has('*'), false, 're-derived authority must not carry the wildcard');
  assert.ok(restored.authorityDowngrade, 'ignored privilege claim must be recorded');
  assert.deepStrictEqual(restored.authorityDowngrade.fields, ['privileged']);
});

test('43a36a1: Agent.toSnapshot drops caller-asserted authority from the serialized config', () => {
  const agent = new Agent({ id: 'live_privileged_agent', privileged: true, allowedTools: ['*'] });
  const snapshot = agent.toSnapshot();

  assert.equal(snapshot.config.privileged, undefined, 'toSnapshot must not serialize config.privileged');
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot.config, 'privileged'),
    false,
    'serialized config must not carry the privileged key'
  );
});

test('43a36a1: runtime.importSnapshot re-derives authority instead of trusting the snapshot', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({ agents: [buildAgentSnapshot()], recycleBin: [] });

    const agent = runtime.getAgent('probe_privileged_agent');
    assert.ok(agent, 'agent must hydrate');
    assert.notStrictEqual(agent.config.privileged, true, 'hydrated config must not stay privileged');
    assert.equal(runtime.whoami('probe_privileged_agent').privileged, false, 'whoami must project the re-derived authority');
    assert.equal(agent.authorityProvenance, 'snapshot', 'hydrated entities carry snapshot provenance');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('probe_privileged_agent').authority.allow.size,
      0,
      'the registry descriptor must also be re-derived default-deny (no persisted wildcard authority)'
    );
  } finally {
    runtime.destroy();
  }
});

test('43a36a1: schema-invalid privilege claims fail closed with ERR_SNAPSHOT_INVALID', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    assert.throws(
      () => runtime.importSnapshot({ agents: [buildAgentSnapshot({ config: { privileged: 'yes' } })], recycleBin: [] }),
      (err) => err.code === 'ERR_SNAPSHOT_INVALID',
      'schema-invalid privilege must reject the snapshot'
    );
    assert.equal(runtime.getAgentCount(), 0, 'rejected snapshot must not install agents');
  } finally {
    runtime.destroy();
  }
});

test('43a36a1: authority is frozen after construction', () => {
  const agent = new Agent({ id: 'frozen_authority_agent', allowedTools: ['read_file'] });

  assert.ok(Object.isFrozen(agent.authority), 'authority descriptor must be frozen');
  assert.equal(agent.authority.allow.has('read_file'), true);

  assert.equal(typeof agent.authority.allow.add, 'undefined', 'allow-set mutators must be neutralized');
  assert.throws(() => agent.authority.allow.add('*'), TypeError, 'calling a neutralized mutator must throw');
  assert.equal(agent.authority.allow.has('*'), false, 'authority allow-set mutation must not take effect');

  assert.throws(() => { agent.authority = null; }, TypeError, 'the authority property must be non-writable');
  assert.ok(agent.authority, 'the authority descriptor must survive reassignment attempts');
});

test('43a36a1: restoreRuntimeEnvironment downgrades a crafted persisted privilege claim', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    const result = restoreRuntimeEnvironment(buildPersistedState(), runtime);
    assert.equal(result.success, true, 'clean restore must succeed');

    const agent = runtime.getAgent('probe_privileged_agent');
    assert.ok(agent, 'agent must restore');
    assert.notStrictEqual(agent.config.privileged, true, 'persisted privilege claim must not be honored');
    assert.equal(runtime.whoami('probe_privileged_agent').privileged, false);
  } finally {
    runtime.destroy();
  }
});

// ---------------------------------------------------------------------------
// Messaging-bus leg (MOD-21 W4)
// ---------------------------------------------------------------------------

function grantFor(subject) {
  return {
    id: subject,
    privileged: false,
    allowedTools: [],
    authority: {
      subject,
      kind: 'agent',
      allow: new Set(['*']),
      visibility: 'all'
    }
  };
}

test('43a36a1: caller-supplied policy.privileged grants nothing', () => {
  const bus = new MessagingBus();
  bus.registerAgent('agent_a', { mode: 'queued', privileged: true });

  assert.equal(bus.getPolicy('agent_a').privileged, false);
});

test('43a36a1: exportSnapshot does not persist policy privilege', () => {
  const bus = new MessagingBus();
  bus.registerAgent('agent_a', { mode: 'queued', privileged: true });

  const snapshot = bus.exportSnapshot();
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.registeredAgents.agent_a, 'privileged'), false);
});

test('43a36a1: a tampered snapshot privilege claim restores as unprivileged', () => {
  const bus = new MessagingBus();
  bus.importSnapshot({
    registeredAgents: { agent_a: { mode: 'queued', privileged: true } },
    terminatedAgents: []
  });

  assert.equal(bus.isRegistered('agent_a'), true);
  assert.equal(bus.getPolicy('agent_a').privileged, false);
});

test('43a36a1: registry descriptor through the identity port grants policy privilege', () => {
  const bus = new MessagingBus({
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'operator' ? grantFor('operator') : { id: agentId, privileged: false, allowedTools: [] })
    }
  });
  bus.registerAgent('operator', { mode: 'queued', privileged: true });

  assert.equal(bus.getPolicy('operator').privileged, true);
});

test('43a36a1: the injected internal principal reference keeps trusted engine registration privileged', () => {
  const internalPrincipal = Object.freeze({ kind: 'internal', subject: 'engine' });
  const bus = new MessagingBus({ internalPrincipal });

  bus.registerAgent('runtime', { mode: 'queued', principal: internalPrincipal });
  assert.equal(bus.getPolicy('runtime').privileged, true);

  bus.registerAgent('lookalike', { mode: 'queued', principal: { kind: 'internal', subject: 'engine' } });
  assert.equal(bus.getPolicy('lookalike').privileged, false);
});
