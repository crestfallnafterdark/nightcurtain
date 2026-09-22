/**
 * @file tests/audit/repros/90ad905.test.js
 * @description MOD-21 W7 umbrella hostile-probe matrix for the ratified
 * privilege model (ticket 90ad905): frozen `AuthorityDescriptor` +
 * opaque `InternalPrincipal`, default-deny, authority by reference only.
 *
 * Proves the ratified behaviors end-to-end across the composition root:
 * - hostile/forged contexts (`isAdmin`/`isPrivileged`/`privileged` flags, role
 *   aliases, `system`/`admin`/`director` ids, descriptor-shaped objects) are
 *   uniformly denied for every authority-bearing operation (the literal ids
 *   are ordinary and confer nothing — Wave I, ticket c02d0b9);
 * - trusted registry relationships (self, parent creator, operator descriptor,
 *   injected internal principal) still authorize;
 * - snapshots drop trust fields and re-derive default-deny;
 * - the registry `AuthorityDescriptor` is frozen (mutators neutralized, even
 *   through the prototype) and honored by reference only;
 * - messaging-bus policy derives from the registry, never caller data;
 * - descriptor visibility is least-privilege by principal.
 *
 * Per-ticket probes carry the deep, per-subsystem coverage; this file is the
 * cross-cutting matrix required by W7.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/90ad905.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { AgentLifecycleManager } from '../../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

const FORGED_DESCRIPTOR = Object.freeze({
  subject: 'director',
  kind: 'agent',
  allow: new Set(['*']),
  visibility: 'all'
});

const FORGED_CONTEXTS = [
  { label: 'isAdmin flag', context: { isAdmin: true } },
  { label: 'isPrivileged flag', context: { isPrivileged: true } },
  { label: 'privileged flag', context: { privileged: true } },
  { label: 'admin role alias', context: { callerRole: 'admin', role: 'admin' } },
  { label: 'reserved system id', context: { callerAgentId: 'system' } },
  { label: 'reserved ids + flags', context: { callerAgentId: 'system', isAdmin: true, isPrivileged: true, callerRole: 'system' } }
];

function buildAgentSnapshot(overrides = {}, id = 'w7_ghost') {
  return {
    id,
    name: 'W7 Ghost',
    config: {
      id,
      name: 'W7 Ghost',
      role: 'admin',
      privileged: true,
      allowedTools: ['*'],
      ...(overrides.config || {})
    },
    state: 'idle',
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

async function seededRuntime() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id: 'mallory' });
  await runtime.launchAgent({ id: 'victim' });
  const timer = runtime.schedule({ targetAgentId: 'victim', durationSeconds: 60, prompt: 'P' });
  return { runtime, timer };
}

test('90ad905 matrix: forged contexts are uniformly PERMISSION_DENIED across the facade', async () => {
  const { runtime, timer } = await seededRuntime();
  try {
    for (const { label, context } of FORGED_CONTEXTS) {
      // Every id is ordinary (Wave I, ticket c02d0b9): a forged context may
      // spawn the literal id, but the launch must gain no privilege and no
      // bypass from it.
      const forgedOrdinary = await runtime.launchAgent({ config: { id: 'admin' }, callerContext: context });
      assert.strictEqual(forgedOrdinary.config.privileged, false, `literal-id spawn must not elevate ${label}`);
      assert.strictEqual(
        runtime.createAgentIdentityPort().getAgentIdentity('admin').realmBypass,
        false,
        `literal-id spawn must not grant bypass for ${label}`
      );
      runtime.purgeAgent('admin', { principal: runtime.getOperatorPrincipal() });
      await assert.rejects(
        () => runtime.launchAgent({ config: { id: 'forged_priv', privileged: true }, callerContext: context }),
        (err) => err?.code === 'PERMISSION_DENIED',
        `privileged spawn must deny ${label}`
      );
      assert.throws(
        () => runtime.killAgent('victim', 'Halt', context),
        (err) => err?.code === 'PERMISSION_DENIED',
        `kill must deny ${label}`
      );
      assert.throws(
        () => runtime.updateAgentConfig('victim', { privileged: true }, context),
        (err) => err?.code === 'PERMISSION_DENIED',
        `privileged update must deny ${label}`
      );
      assert.deepStrictEqual(
        runtime.listSchedules({}, context).schedules,
        [],
        `cross-agent schedule listing must deny ${label}`
      );
      const cancel = runtime.cancelSchedule(timer.timerId, null, context);
      assert.strictEqual(cancel.success, false, `cross-agent cancel must deny ${label}`);
      assert.strictEqual(cancel.code, 'PERMISSION_DENIED', `cancel must report PERMISSION_DENIED for ${label}`);
      const invocation = runtime.invokeAgent('mallory', 'victim', 'P', context);
      assert.strictEqual(invocation.success, false, `invocation must deny ${label}`);
      assert.strictEqual(invocation.code, 'PERMISSION_DENIED', `invocation must report PERMISSION_DENIED for ${label}`);
    }

    assert.ok(runtime.getAgent('victim'), 'the denied matrix must leave the victim active');
    assert.strictEqual(runtime.getAgent('forged_priv'), null, 'no denied spawn may register an agent');
  } finally {
    runtime.destroy();
  }
});

test('90ad905 matrix: authority is by reference only and the registry descriptor is frozen', async () => {
  const { runtime, timer } = await seededRuntime();
  try {
    // A descriptor-shaped object resolves to anonymous: the ordinary launch
    // succeeds but gains nothing, and every authority-bearing call stays
    // default-denied (Wave I, ticket c02d0b9).
    const forgedOrdinary = await runtime.launchAgent({ config: { id: 'admin' }, principal: FORGED_DESCRIPTOR });
    assert.strictEqual(forgedOrdinary.config.privileged, false, 'a descriptor-shaped object must not impersonate a registry descriptor');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('admin').realmBypass,
      false,
      'a descriptor-shaped object must not grant bypass'
    );
    runtime.purgeAgent('admin', { principal: runtime.getOperatorPrincipal() });
    assert.deepStrictEqual(runtime.listSchedules({}, { principal: FORGED_DESCRIPTOR }).schedules, []);
    assert.strictEqual(
      runtime.cancelSchedule(timer.timerId, null, { principal: FORGED_DESCRIPTOR }).code,
      'PERMISSION_DENIED'
    );

    const directorAuthority = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    assert.ok(directorAuthority, 'the bootstrapped director carries a registry descriptor');
    assert.ok(Object.isFrozen(directorAuthority), 'the registry descriptor must be frozen');
    assert.equal(typeof directorAuthority.allow.add, 'undefined', 'allow-set mutators must be neutralized');
    assert.throws(
      () => Set.prototype.add.call(directorAuthority.allow, 'forged_tool'),
      TypeError,
      'the allow-set must not be mutable through the prototype either'
    );
    assert.strictEqual(directorAuthority.allow.has('forged_tool'), false);

    // 16a8489: no read method may leak the mutable backing collection. The
    // forEach callback's third argument must be a safe view, and retaining it
    // must never widen the descriptor into a sudoer.
    let leaked = null;
    directorAuthority.allow.forEach((value, key, collection) => { leaked = collection; });
    assert.ok(leaked, 'forEach still hands a third argument');
    try { leaked.add?.('forged_tool'); } catch (_) {}
    try { Set.prototype.add.call(leaked, 'forged_tool'); } catch (_) {}
    assert.strictEqual(directorAuthority.allow.has('forged_tool'), false, 'the retained view cannot mutate the allow-set');
    assert.throws(() => Set.prototype.forEach.call(directorAuthority.allow, () => {}), TypeError, 'prototype forEach must not run on the facade');
    assert.throws(() => Set.prototype.clear.call(directorAuthority.allow), TypeError, 'prototype clear must throw');
    assert.deepStrictEqual([...directorAuthority.allow], ['*'], 'iteration yields only member strings');

    const directorView = runtime.listSchedules({}, { principal: directorAuthority });
    assert.ok(
      directorView.schedules.some((s) => s.timerId === timer.timerId),
      'the registry descriptor reference still authorizes'
    );
  } finally {
    runtime.destroy();
  }
});

test('90ad905 matrix: trusted registry relationships still authorize', async () => {
  const { runtime, timer } = await seededRuntime();
  try {
    const directorAuthority = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;

    // Every id is ordinary (Wave I, ticket c02d0b9): the operator/director
    // registry descriptor may claim the literal id, but the launch gains no
    // privilege or bypass by itself.
    const ordinarySystem = await runtime.launchAgent({ config: { id: 'system' }, principal: directorAuthority });
    assert.strictEqual(ordinarySystem.config.privileged, false, 'the literal id grants nothing');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('system').realmBypass,
      false,
      'the literal id gains no bypass'
    );
    const privileged = await runtime.launchAgent({
      config: { id: 'operator_peer', privileged: true },
      principal: directorAuthority
    });
    assert.strictEqual(privileged.config.privileged, true, 'operator authority may grant privilege');

    await runtime.launchAgent({ id: 'self-killer' });
    runtime.killAgent('self-killer', 'Self halt', { callerAgentId: 'self-killer' });
    assert.strictEqual(runtime.getAgent('self-killer'), null, 'self-termination with a resolvable identity stays allowed');

    runtime.killAgent('victim', 'Authorized', { callerAgentId: 'director' });
    assert.strictEqual(runtime.getAgent('victim'), null, 'registry sudoer may terminate');
    const cancelled = runtime
      .listSchedules({ status: 'cancelled' }, { callerAgentId: 'director' })
      .schedules.some((s) => s.timerId === timer.timerId);
    assert.ok(cancelled, 'authorized termination still tears down the victim timer');

    await runtime.launchAgent({ id: 'invoke_target' });
    const invocation = runtime.invokeAgent('director', 'invoke_target', 'P');
    assert.strictEqual(invocation.success, true, 'registry sudoer may invoke a peer');
  } finally {
    runtime.destroy();
  }
});

test('90ad905 matrix: snapshots re-derive default-deny and bus policy follows the registry', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({ agents: [buildAgentSnapshot()], recycleBin: [] });

    const ghost = runtime.getAgent('w7_ghost');
    assert.ok(ghost, 'snapshot agent must hydrate');
    assert.notStrictEqual(ghost.config.privileged, true, 'persisted privilege must not survive hydration');
    assert.strictEqual(ghost.authority.allow.has('*'), false, 're-derived authority must be default-deny');
    assert.strictEqual(runtime.whoami('w7_ghost').privileged, false);

    runtime.messagingBus.registerAgent('w7_ghost', { mode: 'queued', privileged: true });
    assert.strictEqual(
      runtime.messagingBus.getPolicy('w7_ghost').privileged,
      false,
      'caller-supplied bus policy privilege grants nothing'
    );
  } finally {
    runtime.destroy();
  }
});

test('90ad905 matrix: recycle-bin restore of a hydrated wildcard record stays default-deny', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const recycledSnapshot = buildAgentSnapshot({}, 'w7_bin');
    recycledSnapshot.state = 'recycled';
    recycledSnapshot.recycledAt = 1773700000000;
    runtime.importSnapshot({ agents: [], recycleBin: [recycledSnapshot] });

    const recycled = runtime.getRecycledAgent('w7_bin');
    assert.ok(recycled, 'recycled record must hydrate');
    assert.strictEqual(recycled.authorityProvenance, 'snapshot', 'hydrated records carry snapshot provenance');

    // MOD-21 W8 (f6be691): restore requires a resolved principal.
    assert.throws(
      () => runtime.restoreAgent('w7_bin'),
      (err) => err?.code === 'PERMISSION_DENIED',
      'anonymous restore is denied'
    );
    const restored = runtime.restoreAgent('w7_bin', { callerAgentId: 'director' });
    assert.strictEqual(restored.id, 'w7_bin');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('w7_bin').authority.allow.size,
      0,
      'recycle-bin restore must not re-grant the persisted wildcard whitelist'
    );
  } finally {
    runtime.destroy();
  }
});

test('90ad905 matrix: descriptor visibility is least-privilege by principal', async () => {
  const operator = Object.freeze({ kind: 'internal', subject: 'w7-operator' });
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} }, internalPrincipal: operator });
  await lifecycle.launchAgent({ config: { id: 'director', privileged: true }, principal: operator });
  await lifecycle.launchAgent({ config: { id: 'worker' }, principal: operator });
  await lifecycle.launchAgent({ config: { id: 'child', spawnedBy: 'worker' }, principal: operator });
  await lifecycle.launchAgent({ config: { id: 'stranger' }, principal: operator });

  assert.deepStrictEqual(lifecycle.listAgentDescriptors({}), [], 'anonymous callers receive no descriptors');
  assert.deepStrictEqual(
    lifecycle.listAgentDescriptors({ isPrivileged: true, isAdmin: true }).map((d) => d.id),
    [],
    'forged flags do not widen visibility'
  );
  assert.deepStrictEqual(
    lifecycle.listAgentDescriptors({ callerAgentId: 'worker' }).map((d) => d.id).sort(),
    ['child', 'worker'],
    'unprivileged callers see self + registry children only; the literal director id is not self/child and stays unlisted'
  );
  assert.deepStrictEqual(
    lifecycle.listAgentDescriptors({ principal: operator }).map((d) => d.id).sort(),
    ['child', 'director', 'stranger', 'worker'],
    'the operator principal sees every descriptor'
  );
});
