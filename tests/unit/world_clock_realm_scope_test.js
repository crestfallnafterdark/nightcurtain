/**
 * @file tests/unit/world_clock_realm_scope_test.js
 * @description Realm wave A0 (ticket d5bd034) verification suite:
 *   1. Mutation-capability vocabulary completeness (`MUTATING_TOOLS` /
 *      `READ_ONLY_TOOLS`, world_clock + event_list mutating).
 *   2. Clock-denied agent: `world_clock`/`event_list` denied directly and via
 *      `batch_precall`; no `/world_clock.json` write occurs.
 *   3. Clock-granted realm-bound agents: the operating global partition and the
 *      VFS sync target are `realm:<realmId>:global`; other realms' partitions
 *      and workspaces stay untouched.
 *   4. Enumeration scoping: realm-bound callers enumerate only their realm; the
 *      injected internal principal spans all.
 *   5. Agent-visible tool receipt opacity (R3, ticket 10eab05): the
 *      `world_clock`/`event_list`/`get_current_time` tool receipts never carry
 *      the internal `realm:<id>:global` partition key, while the host/API
 *      surface keeps it unchanged.
 *   6. Canonical identity keys (Wave I, ticket d57cbc1): with a real
 *      `AgentRuntime` carrying the same literal id in two realms, clock and
 *      event partitions stay realm-isolated, realm-local bare references
 *      resolve through the identity port, scoped enumeration never crosses
 *      realms (bypass principals span), and every receipt is bare-id opaque.
 *
 * Unit level: realm membership is supplied by an injected identity port; the
 * runtime producer wiring lands in Wave A (the projection fields are optional,
 * so the current runtime stays type-compatible). The Wave I section runs on a
 * real runtime instance (zero mocks).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { createAgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  SANDBOX_TOOLS,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  isMutatingTool
} from '../../src/lib/sandbox/tools/constants/index.ts';

/**
 * Opaque engine-internal principal injected into both the VirtualFS and the
 * WorldClock (composition-root wiring).
 */
const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'realm_clock_admin' });

/**
 * Trusted identity port with Realm membership (Wave A projection shape):
 * `realmId` binds an agent to a realm; `realmBypass` is absent for every agent
 * here, so all of them are realm-bound. The realm directors carry a
 * cross-partition authority descriptor (still realm-bound).
 */
const REALM_IDENTITY_PORT = {
  getAgentIdentity: (agentId) => {
    if (agentId === 'realm_a_director') {
      return {
        id: agentId,
        privileged: false,
        allowedTools: ['world_clock', 'event_list'],
        authority: { subject: agentId, kind: 'agent', allow: new Set(['world_clock', 'event_list']), visibility: 'all' },
        realmId: 'demo'
      };
    }
    if (agentId === 'realm_a_member') {
      return { id: agentId, privileged: false, allowedTools: [], realmId: 'demo' };
    }
    if (agentId === 'realm_b_director') {
      return {
        id: agentId,
        privileged: false,
        allowedTools: ['world_clock', 'event_list'],
        authority: { subject: agentId, kind: 'agent', allow: new Set(['world_clock', 'event_list']), visibility: 'all' },
        realmId: 'other'
      };
    }
    if (agentId === 'realm_b_member') {
      return { id: agentId, privileged: false, allowedTools: [], realmId: 'other' };
    }
    if (agentId === 'ungrouped_priv') {
      // Ungrouped (legacy) wildcard principal: privileged, but not a Realm
      // bypass identity — the V10 F-V10-1 confinement case.
      return {
        id: agentId,
        privileged: false,
        allowedTools: ['world_clock', 'event_list'],
        authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' },
        realmId: null,
        realmBypass: false
      };
    }
    if (agentId === 'ungrouped_plain') {
      return { id: agentId, privileged: false, allowedTools: [], realmId: null, realmBypass: false };
    }
    if (agentId === 'realm_bypass_director') {
      // Hardcoded system-director shape: the only agent-side Realm bypass.
      return {
        id: agentId,
        privileged: false,
        allowedTools: ['world_clock', 'event_list'],
        authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' },
        realmId: null,
        realmBypass: true
      };
    }
    return { id: agentId, privileged: false, allowedTools: [] };
  }
};

/** Records every clock-originated VFS write while delegating to a real VirtualFS. */
function makeRecordingVfs() {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  const writes = [];
  const spy = {
    writeFile: (path, content, options) => {
      writes.push({ path, workspaceId: options?.workspaceId });
      return vfs.writeFile(path, content, options);
    },
    readFile: (path, options) => vfs.readFile(path, options),
    exists: (path, options) => vfs.exists(path, options),
    listWorkspaces: () => vfs.listWorkspaces()
  };
  return { vfs, spy, writes };
}

function makeRealmClock(recording) {
  return new WorldClock({
    virtualFs: recording.spy,
    identityPort: REALM_IDENTITY_PORT,
    internalPrincipal: INTERNAL_PRINCIPAL,
    autoSyncFs: true
  });
}

// ============================================================================
// 1. Mutation-Capability Vocabulary (A0-3.1)
// ============================================================================

test('1. Mutation-capability vocabulary partitions every canonical tool exactly once', () => {
  const canonical = Object.values(SANDBOX_TOOLS);
  assert.equal(canonical.length, 35, 'the canonical taxonomy is 35 tools');

  assert.ok(Array.isArray(MUTATING_TOOLS));
  assert.ok(Array.isArray(READ_ONLY_TOOLS));
  assert.ok(Object.isFrozen(MUTATING_TOOLS), 'MUTATING_TOOLS must be frozen');
  assert.ok(Object.isFrozen(READ_ONLY_TOOLS), 'READ_ONLY_TOOLS must be frozen');

  const union = [...MUTATING_TOOLS, ...READ_ONLY_TOOLS];
  assert.equal(union.length, 35, 'read-only + mutating covers all 35 canonical tools');
  assert.equal(new Set(union).size, 35, 'the classification is disjoint');
  assert.deepEqual([...union].sort(), [...canonical].sort(), 'the classification uses only canonical tool names');

  for (const tool of union) {
    assert.ok(canonical.includes(tool), `unknown classified tool '${tool}'`);
  }

  // Clock/event tools are mutation-capable (they step time and rewrite VFS payloads).
  assert.ok(MUTATING_TOOLS.includes(SANDBOX_TOOLS.WORLD_CLOCK), 'world_clock must be mutating');
  assert.ok(MUTATING_TOOLS.includes(SANDBOX_TOOLS.EVENT_LIST), 'event_list must be mutating');
  assert.ok(READ_ONLY_TOOLS.includes(SANDBOX_TOOLS.GET_CURRENT_TIME), 'get_current_time stays read-only');

  assert.equal(isMutatingTool(SANDBOX_TOOLS.WORLD_CLOCK), true);
  assert.equal(isMutatingTool(SANDBOX_TOOLS.EVENT_LIST), true);
  assert.equal(isMutatingTool(SANDBOX_TOOLS.GET_CURRENT_TIME), false);
  assert.equal(isMutatingTool('not_a_tool'), false);
});

// ============================================================================
// 2. Clock-Denied Agent: Direct + batch_precall Denial, No Write
// ============================================================================

test('2. A clock-denied agent is denied world_clock/event_list directly and via batch_precall, with no /world_clock.json write', async () => {
  const { vfs, spy, writes } = makeRecordingVfs();
  const clock = new WorldClock({ virtualFs: spy, autoSyncFs: true });

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    worldClock: clock,
    agentId: 'agent_noclock',
    allowedTools: ['read_file']
  });

  // Construction-time engine sync is expected; measure only the denied window.
  writes.length = 0;

  const directClock = await dispatcher.executeTool('world_clock', { action: 'advance', minutes: 45 });
  assert.equal(directClock.success, false, 'world_clock must be denied without the grant');
  assert.equal(directClock.code, 'PERMISSION_DENIED');

  const directEvents = await dispatcher.executeTool('event_list', { action: 'register', name: 'Illicit Event' });
  assert.equal(directEvents.success, false, 'event_list must be denied without the grant');
  assert.equal(directEvents.code, 'PERMISSION_DENIED');

  const batch = await dispatcher.executeTool('batch_precall', {
    calls: [
      { name: 'world_clock', arguments: { action: 'advance', minutes: 45 } },
      { name: 'event_list', arguments: { action: 'register', name: 'Illicit Batch Event' } }
    ]
  });
  assert.equal(batch.success, true, 'batch_precall itself is an innate tool');
  assert.equal(batch.count, 2);
  for (const item of batch.results) {
    assert.equal(item.result.success, false, `nested '${item.name}' must be denied`);
    assert.equal(item.result.code, 'PERMISSION_DENIED', `nested '${item.name}' denial code`);
  }

  assert.equal(writes.length, 0, 'no clock/event VFS write may occur for a denied agent');
  const adminRead = { principal: INTERNAL_PRINCIPAL };
  assert.equal(vfs.exists('/world_clock.json', { workspaceId: 'agent_noclock', ...adminRead }), false);
  assert.equal(vfs.exists('/event_list.json', { workspaceId: 'agent_noclock', ...adminRead }), false);
});

// ============================================================================
// 3. Realm-Granted Agent: Realm-Scoped Global Partition + Sync Target
// ============================================================================

test('3. A clock-granted realm agent syncs its global partition to realm:demo:global only', () => {
  const { vfs, spy, writes } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  // Seed realm B state (its own realm-global partition and workspace).
  clock.setTime({ totalSeconds: 3600, date: 'Day 1', targetAgentId: 'global' }, { callerAgentId: 'realm_b_director' });
  const realmBEvent = clock.registerEvent(
    { name: 'Realm B Storm', scope: 'global', triggerTime: 7200 },
    { callerAgentId: 'realm_b_director' }
  );
  assert.equal(realmBEvent.success, true);
  assert.equal(realmBEvent.event.ownerId, 'realm:other:global', 'realm B global events live in realm:other:global');

  const realmBClockBefore = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' });
  const adminRead = { principal: INTERNAL_PRINCIPAL, raw: true };
  const realmBWorkspaceBefore = vfs.readFile('/world_clock.json', { workspaceId: 'realm:other:global', ...adminRead });
  const realmBEventsBefore = vfs.readFile('/event_list.json', { workspaceId: 'realm:other:global', ...adminRead });

  writes.length = 0;

  // Realm A director: literal 'global' targets resolve to realm:demo:global.
  const reset = clock.resetClock({ targetAgentId: 'global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(reset.success, true);
  assert.equal(reset.agentId, 'realm:demo:global', "the caller's global key is its realm key");

  const setA = clock.setTime({ totalSeconds: 7200, date: 'Day 1 Noon', targetAgentId: 'global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(setA.success, true);
  assert.equal(setA.agentId, 'realm:demo:global', "an explicit 'global' target resolves to the realm key");

  const realmAEvent = clock.registerEvent(
    { name: 'Realm A Eclipse', scope: 'global', triggerTime: 9000 },
    { callerAgentId: 'realm_a_director' }
  );
  assert.equal(realmAEvent.success, true);
  assert.equal(realmAEvent.event.ownerId, 'realm:demo:global', 'realm A global events live in realm:demo:global');

  // Every write in the window targets the realm-global workspace (plus the
  // director's own agent workspace) — never legacy `global` or realm B.
  const writtenWorkspaces = new Set(writes.map(w => w.workspaceId));
  assert.ok(writtenWorkspaces.has('realm:demo:global'), 'the realm-global workspace receives the realm sync');
  for (const workspaceId of writtenWorkspaces) {
    assert.ok(
      workspaceId === 'realm:demo:global' || workspaceId === 'realm_a_director',
      `write escaped the realm scope: '${workspaceId}'`
    );
  }
  assert.equal(writes.some(w => w.workspaceId === 'global'), false, 'legacy global must stay untouched');
  assert.equal(writes.some(w => w.workspaceId === 'realm:other:global'), false, "realm B's workspace must stay untouched");

  // Realm B in-memory partition and persisted workspace are untouched.
  const realmBClockAfter = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' });
  assert.equal(realmBClockAfter.totalSeconds, realmBClockBefore.totalSeconds);
  assert.equal(realmBClockAfter.date, realmBClockBefore.date);
  assert.equal(vfs.readFile('/world_clock.json', { workspaceId: 'realm:other:global', ...adminRead }), realmBWorkspaceBefore);
  assert.equal(vfs.readFile('/event_list.json', { workspaceId: 'realm:other:global', ...adminRead }), realmBEventsBefore);

  // The realm-global payload is persisted under the realm key.
  const realmAWorkspaceClock = JSON.parse(vfs.readFile('/world_clock.json', { workspaceId: 'realm:demo:global', ...adminRead }));
  assert.equal(realmAWorkspaceClock.agentId, 'realm:demo:global');
  assert.equal(realmAWorkspaceClock.totalSeconds, 7200);
});

test('3b. A clock-granted realm agent driven through the dispatcher never writes outside its realm', async () => {
  const { vfs, spy, writes } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    worldClock: clock,
    agentId: 'realm_a_director',
    allowedTools: ['world_clock', 'event_list']
  });

  writes.length = 0;

  const advanced = await dispatcher.executeTool('world_clock', { action: 'advance', minutes: 30 });
  assert.equal(advanced.success, true, 'the granted realm agent may advance its clock');
  assert.equal(advanced.agentId, 'realm_a_director');

  const registered = await dispatcher.executeTool('event_list', { action: 'register', name: 'Realm A Patrol', trigger_minutes: 15 });
  assert.equal(registered.success, true);

  assert.ok(writes.length > 0, 'the granted mutation must sync');
  for (const write of writes) {
    assert.ok(
      write.workspaceId === 'realm_a_director',
      `dispatcher-driven sync escaped the realm scope: '${write.workspaceId}'`
    );
  }
});

// ============================================================================
// 4. Enumeration Scoping
// ============================================================================

test('4. Enumeration is scoped for realm-bound callers; the internal principal spans all', () => {
  const { vfs, spy } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  // Populate both realms (each realm has a global event owned by its realm key).
  clock.setTime({ totalSeconds: 1000, targetAgentId: 'global' }, { callerAgentId: 'realm_a_director' });
  clock.registerEvent({ name: 'Realm A Beacon', scope: 'global' }, { callerAgentId: 'realm_a_director' });
  clock.setTime({ totalSeconds: 2000, targetAgentId: 'global' }, { callerAgentId: 'realm_b_director' });
  clock.registerEvent({ name: 'Realm B Beacon', scope: 'global' }, { callerAgentId: 'realm_b_director' });
  clock.registerEvent({ name: 'Realm A Member Note' }, { callerAgentId: 'realm_a_member' });

  // Realm A director: realm scope only (realm-global + own + same-realm member).
  const directorClocks = clock.getAllClocks({ callerAgentId: 'realm_a_director' });
  assert.ok('realm:demo:global' in directorClocks, 'realm-global clock is enumerated');
  assert.ok('realm_a_director' in directorClocks);
  assert.ok('realm_a_member' in directorClocks, 'same-realm member partitions are visible to a realm director');
  assert.equal('realm:other:global' in directorClocks, false, "other realms' global clocks are not enumerated");
  assert.equal('realm_b_director' in directorClocks, false, "other realms' agents are not enumerated");

  // Realm A member: own partition + realm-global only.
  const memberClocks = clock.getAllClocks({ callerAgentId: 'realm_a_member' });
  assert.deepEqual(Object.keys(memberClocks).sort(), ['realm:demo:global', 'realm_a_member'].sort());

  // Internal principal (realm bypass): every partition.
  const internalClocks = clock.getAllClocks({ principal: INTERNAL_PRINCIPAL });
  assert.ok('realm:demo:global' in internalClocks);
  assert.ok('realm:other:global' in internalClocks);
  assert.ok('realm_a_member' in internalClocks);

  // queryEvents: realm-scoped public events only.
  const memberEvents = clock.queryEvents({}, { callerAgentId: 'realm_a_member' });
  const memberNames = memberEvents.events.map(ev => ev.name).sort();
  assert.deepEqual(memberNames, ['Realm A Beacon', 'Realm A Member Note']);
  assert.equal(memberEvents.events.some(ev => ev.name === 'Realm B Beacon'), false);

  const directorAll = clock.queryEvents({ all: true }, { callerAgentId: 'realm_a_director' });
  assert.equal(directorAll.events.some(ev => ev.name === 'Realm B Beacon'), false, 'realm-bound all-query never crosses realms');
  const internalAll = clock.queryEvents({ all: true }, { principal: INTERNAL_PRINCIPAL });
  assert.equal(internalAll.events.some(ev => ev.name === 'Realm B Beacon'), true, 'the internal principal spans all realms');
});

// ============================================================================
// 5. Snapshot Scoping (enumeration + hydration)
// ============================================================================

test('5. Realm-bound snapshot export/import touches only the caller realm', () => {
  const { vfs, spy } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  clock.setTime({ totalSeconds: 1000, targetAgentId: 'global' }, { callerAgentId: 'realm_a_director' });
  clock.registerEvent({ name: 'Realm A Beacon', scope: 'global' }, { callerAgentId: 'realm_a_director' });
  clock.setTime({ totalSeconds: 2000, targetAgentId: 'global' }, { callerAgentId: 'realm_b_director' });
  clock.registerEvent({ name: 'Realm B Beacon', scope: 'global' }, { callerAgentId: 'realm_b_director' });

  const realmASnapshot = clock.exportSnapshot({ callerAgentId: 'realm_a_director' });
  assert.equal(realmASnapshot.success, undefined, 'a successful export returns the snapshot object');
  assert.deepEqual(Object.keys(realmASnapshot.agentEvents).sort(), ['realm:demo:global']);
  assert.ok('realm:demo:global' in realmASnapshot.agentClocks);
  assert.equal('realm:other:global' in realmASnapshot.agentClocks, false);
  assert.equal(realmASnapshot.totalSeconds, 1000, 'top-level totals mirror the realm-global clock');

  const internalSnapshot = clock.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.ok('realm:other:global' in internalSnapshot.agentClocks, 'the internal principal spans all');

  const realmBClockBefore = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' });

  const imported = clock.importSnapshot({
    totalSeconds: 55,
    date: 'Realm A Day',
    events: [],
    agentClocks: {
      'realm:demo:global': { totalSeconds: 55, date: 'Realm A Day', lastSync: Date.now() },
      'realm:other:global': { totalSeconds: 999999, date: 'Hijacked', lastSync: Date.now() }
    },
    agentEvents: {
      'realm:demo:global': [{ id: 'evt_realm_a', name: 'Realm A Imported', ownerId: 'realm:demo:global', status: 'active', scope: 'global' }],
      'realm:other:global': [{ id: 'evt_realm_b', name: 'Realm B Hijacked', ownerId: 'realm:other:global', status: 'active', scope: 'global' }]
    }
  }, { callerAgentId: 'realm_a_director' });
  assert.equal(imported.success, true);

  const realmAResult = clock.getTime({ targetAgentId: 'realm:demo:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(realmAResult.totalSeconds, 55, 'realm A is replaced from its scoped snapshot');

  const realmBClockAfter = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' });
  assert.equal(realmBClockAfter.totalSeconds, realmBClockBefore.totalSeconds, "realm B's clock is untouched by a realm A import");
  assert.equal(realmBClockAfter.date, realmBClockBefore.date);
  const realmBEvents = clock.queryEvents({ all: true }, { callerAgentId: 'realm_b_director' });
  assert.equal(realmBEvents.events.some(ev => ev.name === 'Realm B Hijacked'), false);
  assert.equal(realmBEvents.events.some(ev => ev.name === 'Realm B Beacon'), true);
});

// ============================================================================
// 6. Ungrouped Non-Bypass Confinement (V10 F-V10-1)
// ============================================================================

test('6. Realm-prefixed partitions are invisible to every ungrouped non-bypass caller', () => {
  const { vfs, spy } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  // Seed both realms plus a legacy partition/event.
  clock.setTime({ totalSeconds: 1000, targetAgentId: 'global' }, { callerAgentId: 'realm_a_director' });
  clock.registerEvent({ name: 'Realm A Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'realm_a_director' });
  clock.setTime({ totalSeconds: 2000, targetAgentId: 'global' }, { callerAgentId: 'realm_b_director' });
  clock.registerEvent({ name: 'Realm B Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'realm_b_director' });
  clock.setTime({ totalSeconds: 3000, targetAgentId: 'global' }, { callerAgentId: 'ungrouped_priv' });
  clock.registerEvent({ name: 'Legacy Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'ungrouped_priv' });

  // Enumerating clocks: legacy partitions only, never realm-prefixed keys.
  const privClocks = clock.getAllClocks({ callerAgentId: 'ungrouped_priv' });
  assert.equal('realm:demo:global' in privClocks, false, 'ungrouped privileged must not enumerate realm A');
  assert.equal('realm:other:global' in privClocks, false, 'ungrouped privileged must not enumerate realm B');
  assert.ok('global' in privClocks, 'legacy global stays visible');
  assert.equal(privClocks['global'].totalSeconds, 3000);

  // Querying all events: realm events never appear, legacy events do.
  const privEvents = clock.queryEvents({ all: true, status: 'all' }, { callerAgentId: 'ungrouped_priv' });
  const privNames = privEvents.events.map(ev => ev.name);
  assert.ok(privNames.includes('Legacy Beacon'), 'legacy global events stay visible');
  assert.equal(privNames.includes('Realm A Beacon'), false, 'ungrouped privileged must not read realm A events');
  assert.equal(privNames.includes('Realm B Beacon'), false, 'ungrouped privileged must not read realm B events');

  const privAllTime = clock.getTime({ all: true }, { callerAgentId: 'ungrouped_priv' });
  assert.equal(privAllTime.all, true);
  assert.equal('realm:demo:global' in privAllTime.clocks, false, 'getTime(all) must not disclose realm A');
  assert.equal('realm:other:global' in privAllTime.clocks, false, 'getTime(all) must not disclose realm B');

  // Single-target foreign-realm operations deny (mutations) or narrow (reads).
  const foreignSet = clock.setTime({ totalSeconds: 424242, targetAgentId: 'realm:other:global' }, { callerAgentId: 'ungrouped_priv' });
  assert.equal(foreignSet.success, false, 'ungrouped privileged setTime on a foreign realm must fail');
  assert.equal(foreignSet.code, 'PERMISSION_DENIED');
  const foreignGet = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'ungrouped_priv' });
  assert.equal(foreignGet.agentId, 'ungrouped_priv', 'getTime silently narrows a foreign-realm target');
  assert.notEqual(foreignGet.totalSeconds, 2000, 'realm B state is never disclosed');

  // Bypass identities span every partition as before.
  const internalClocks = clock.getAllClocks({ principal: INTERNAL_PRINCIPAL });
  assert.ok('realm:demo:global' in internalClocks, 'the internal principal spans realm A');
  assert.ok('realm:other:global' in internalClocks, 'the internal principal spans realm B');
  const bypassClocks = clock.getAllClocks({ callerAgentId: 'realm_bypass_director' });
  assert.ok('realm:other:global' in bypassClocks, 'a realmBypass director spans every realm');
  const bypassEvents = clock.queryEvents({ all: true, status: 'all' }, { callerAgentId: 'realm_bypass_director' });
  assert.equal(bypassEvents.events.some(ev => ev.name === 'Realm B Beacon'), true, 'a realmBypass director reads realm B events');

  // Legacy ungrouped unprivileged parity: own partition + legacy global only.
  const plainClocks = clock.getAllClocks({ callerAgentId: 'ungrouped_plain' });
  assert.deepEqual(Object.keys(plainClocks).sort(), ['global', 'ungrouped_plain'], 'legacy unprivileged parity');
  const plainEvents = clock.queryEvents({ all: true, status: 'all' }, { callerAgentId: 'ungrouped_plain' });
  assert.equal(plainEvents.events.some(ev => ev.name.startsWith('Realm ')), false, 'unprivileged callers never read realm events');
  assert.equal(plainEvents.events.some(ev => ev.name === 'Legacy Beacon'), true, 'public legacy global events stay visible');
});

// ============================================================================
// 7. Single-Target Realm Scope (V2 F1 / V10 F-V10-1)
// ============================================================================

test('7. Realm-bound privileged single-target ops deny foreign realms; bypass spans all', () => {
  const { vfs, spy, writes } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  // Seed realm B: clock, a global event, and a pending task event.
  clock.setTime({ totalSeconds: 2000, date: 'Beta Eve', targetAgentId: 'global' }, { callerAgentId: 'realm_b_director' });
  const betaBeacon = clock.registerEvent({ name: 'Beta Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'realm_b_director' });
  const betaTask = clock.registerEvent({ name: 'Beta Task', scope: 'global', triggerTime: 5000 }, { callerAgentId: 'realm_b_director' });
  assert.equal(betaBeacon.success, true);
  assert.equal(betaTask.success, true);
  const betaClockBefore = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' });

  // Mutations on a foreign realm are denied before any state change.
  const foreignSet = clock.setTime({ totalSeconds: 555555, targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignSet.success, false, 'foreign setTime denied');
  assert.equal(foreignSet.code, 'PERMISSION_DENIED');
  const foreignReset = clock.resetClock({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignReset.success, false, 'foreign resetClock denied');
  assert.equal(foreignReset.code, 'PERMISSION_DENIED');
  const foreignAdvance = clock.advanceClock({ minutes: 5, targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignAdvance.success, false, 'foreign advanceClock denied');
  assert.equal(foreignAdvance.code, 'PERMISSION_DENIED');
  const foreignRegister = clock.registerEvent({ name: 'Hijack', scope: 'global', targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignRegister.success, false, 'foreign registerEvent denied');
  assert.equal(foreignRegister.code, 'PERMISSION_DENIED');
  const foreignClear = clock.clearEvents({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignClear.success, false, 'foreign clearEvents denied');
  assert.equal(foreignClear.code, 'PERMISSION_DENIED');
  const foreignMemberSet = clock.setTime({ totalSeconds: 1, targetAgentId: 'realm_b_member' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignMemberSet.success, false, 'foreign realm member partition denied');
  assert.equal(foreignMemberSet.code, 'PERMISSION_DENIED');

  // Reads narrow silently instead of disclosing the foreign partition.
  const foreignQuery = clock.queryEvents({ targetAgentId: 'realm:other:global', status: 'all' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignQuery.events.some(ev => ev.name === 'Beta Beacon'), false, 'foreign queryEvents cannot disclose realm B');
  assert.equal(foreignQuery.events.some(ev => ev.name === 'Beta Task'), false, 'foreign queryEvents cannot disclose realm B tasks');
  assert.notEqual(foreignQuery.clock.agentId, 'realm:other:global', 'foreign queryEvents cannot read the realm B clock');
  const foreignGet = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignGet.agentId, 'realm_a_director', 'foreign getTime narrows to the caller partition');

  // Event resolution by id applies the same scope.
  const foreignResolve = clock.resolveEvent({ eventId: betaTask.event.id }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignResolve.success, false, 'foreign resolveEvent denied');
  assert.equal(foreignResolve.code, 'PERMISSION_DENIED');
  const foreignCancel = clock.cancelEvent({ eventId: betaTask.event.id }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignCancel.success, false, 'foreign cancelEvent denied');
  assert.equal(foreignCancel.code, 'PERMISSION_DENIED');
  const foreignUpdate = clock.updateEvent({ eventId: betaBeacon.event.id, name: 'Hijacked' }, { callerAgentId: 'realm_a_director' });
  assert.equal(foreignUpdate.success, false, 'foreign updateEvent denied');
  assert.equal(foreignUpdate.code, 'PERMISSION_DENIED');

  // Same-realm member partitions stay targetable for a realm privileged principal.
  const sameRealmSet = clock.setTime({ totalSeconds: 77, targetAgentId: 'realm_a_member' }, { callerAgentId: 'realm_a_director' });
  assert.equal(sameRealmSet.success, true, 'same-realm member targeting stays allowed');
  assert.equal(sameRealmSet.agentId, 'realm_a_member');

  // Realm B is byte-identical after every denied attempt.
  const betaClockAfter = clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' });
  assert.equal(betaClockAfter.totalSeconds, betaClockBefore.totalSeconds, 'realm B clock untouched');
  assert.equal(betaClockAfter.date, betaClockBefore.date, 'realm B date untouched');
  const betaEventsAfter = clock.queryEvents({ all: true, status: 'all' }, { callerAgentId: 'realm_b_director' });
  assert.equal(betaEventsAfter.events.some(ev => ev.name === 'Hijack'), false, 'no hijack event landed in realm B');
  assert.equal(betaEventsAfter.events.some(ev => ev.name === 'Hijacked'), false, 'no hijacked event name in realm B');
  assert.equal(betaEventsAfter.events.filter(ev => ev.name === 'Beta Task').length, 1, 'realm B task stays unresolved');

  // Bypass principals may target foreign realms and resolve their events.
  const internalSet = clock.setTime({ totalSeconds: 999, targetAgentId: 'realm:other:global' }, { principal: INTERNAL_PRINCIPAL });
  assert.equal(internalSet.success, true, 'the internal principal may target realm B');
  const bypassSet = clock.setTime({ totalSeconds: 1234, targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_bypass_director' });
  assert.equal(bypassSet.success, true, 'a realmBypass director may target realm B');
  const bypassResolve = clock.resolveEvent({ eventId: betaTask.event.id }, { callerAgentId: 'realm_bypass_director' });
  assert.equal(bypassResolve.success, true, 'a realmBypass director may resolve realm B events');

  // syncFromVirtualFs explicit targets follow the same scope.
  const deniedSync = clock.syncFromVirtualFs('realm:other:global', { callerAgentId: 'realm_a_director' });
  assert.equal(deniedSync.success, false, 'foreign explicit syncFromVirtualFs denied');
  assert.equal(deniedSync.code, 'PERMISSION_DENIED');
  const deniedMemberSync = clock.syncFromVirtualFs('realm_b_member', { callerAgentId: 'realm_a_director' });
  assert.equal(deniedMemberSync.success, false, 'foreign member workspace sync denied');
  assert.equal(deniedMemberSync.code, 'PERMISSION_DENIED');
  const ownSync = clock.syncFromVirtualFs('realm:demo:global', { callerAgentId: 'realm_a_director' });
  assert.equal(ownSync.success, true, 'own realm-global workspace hydration stays allowed');
  const bypassSync = clock.syncFromVirtualFs('realm:other:global', { principal: INTERNAL_PRINCIPAL });
  assert.equal(bypassSync.success, true, 'the internal principal hydrates any workspace');
  const engineSync = clock.syncFromVirtualFs('realm:other:global');
  assert.equal(engineSync.success, true, 'context-free engine hydration stays unscoped');

  // syncToVirtualFs explicit targets follow the same scope (void method: the
  // denial is a silent no-op).
  writes.length = 0;
  clock.syncToVirtualFs('realm:other:global', { callerAgentId: 'realm_a_director' });
  assert.equal(
    writes.some(write => write.workspaceId === 'realm:other:global'),
    false,
    'foreign syncToVirtualFs must not serialize the foreign workspace'
  );
  clock.syncToVirtualFs('realm:other:global', { principal: INTERNAL_PRINCIPAL });
  assert.equal(
    writes.some(write => write.workspaceId === 'realm:other:global'),
    true,
    'the internal principal may serialize any workspace'
  );
  clock.syncToVirtualFs('realm:demo:global', { callerAgentId: 'realm_a_director' });
  assert.equal(
    writes.some(write => write.workspaceId === 'realm:demo:global'),
    true,
    'the caller realm-global workspace stays serializable'
  );
});

// ============================================================================
// 8. Tool Path (event_list all-query) Confinement
// ============================================================================

test('8. The event_list tool with all:true cannot disclose foreign realms for an ungrouped privileged caller', async () => {
  const { vfs, spy } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  clock.registerEvent({ name: 'Realm A Tool Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'realm_a_director' });
  clock.registerEvent({ name: 'Realm B Tool Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'realm_b_director' });
  clock.registerEvent({ name: 'Legacy Tool Beacon', scope: 'global', triggerTime: 0 }, { callerAgentId: 'ungrouped_priv' });

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    worldClock: clock,
    agentId: 'ungrouped_priv',
    allowedTools: ['event_list', 'world_clock']
  });

  const eventReceipt = await dispatcher.executeTool('event_list', { action: 'query', all: true });
  assert.equal(eventReceipt.success, true, 'the tool call itself succeeds');
  const eventContent = JSON.stringify(eventReceipt);
  assert.equal(eventContent.includes('Realm A Tool Beacon'), false, 'event_list all-query must not disclose realm A');
  assert.equal(eventContent.includes('Realm B Tool Beacon'), false, 'event_list all-query must not disclose realm B');
  assert.equal(eventContent.includes('Legacy Tool Beacon'), true, 'legacy global events stay reachable');

  // A realm-bound director still reads its own realm through the same tool.
  const realmDispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    worldClock: clock,
    agentId: 'realm_a_director',
    allowedTools: ['event_list', 'world_clock']
  });
  const realmReceipt = await realmDispatcher.executeTool('event_list', { action: 'query', all: true });
  const realmContent = JSON.stringify(realmReceipt);
  assert.equal(realmContent.includes('Realm A Tool Beacon'), true, 'realm A director reads its own realm-global event');
  assert.equal(realmContent.includes('Realm B Tool Beacon'), false, 'realm A director never reads realm B through the tool');
});

// ============================================================================
// 9. Agent-Visible Tool Receipt Opacity (R3, ticket 10eab05)
// ============================================================================

test('9. Agent tool receipts are realm-opaque while the host API keeps the partition key', async () => {
  const { vfs, spy } = makeRecordingVfs();
  const clock = makeRealmClock({ vfs, spy });

  // A same-realm global event lives in realm:demo:global (owner partition key).
  clock.setTime({ totalSeconds: 3600, date: 'Day 1', targetAgentId: 'global' }, { callerAgentId: 'realm_a_director' });
  const globalEvent = clock.registerEvent(
    { name: 'Realm A Festival', scope: 'global', triggerTime: 0 },
    { callerAgentId: 'realm_a_director' }
  );
  assert.equal(globalEvent.success, true);
  assert.equal(globalEvent.event.ownerId, 'realm:demo:global');

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    worldClock: clock,
    agentId: 'realm_a_member',
    allowedTools: ['world_clock', 'event_list', 'get_current_time']
  });

  // get_current_time: caller partition only, no realm key.
  const time = await dispatcher.executeTool('get_current_time', {});
  assert.equal(JSON.stringify(time).includes('realm:'), false, 'get_current_time receipts must be realm-opaque');
  assert.equal(time.agentId, 'realm_a_member');
  assert.equal(typeof time.time_string, 'string');

  // world_clock query/advance/set/reset receipts.
  const query = await dispatcher.executeTool('world_clock', { action: 'query' });
  assert.equal(query.success, true);
  assert.equal(JSON.stringify(query).includes('realm:'), false, 'world_clock query receipts must be realm-opaque');

  const advance = await dispatcher.executeTool('world_clock', { action: 'advance', minutes: 30 });
  assert.equal(advance.success, true);
  assert.equal(JSON.stringify(advance).includes('realm:'), false, 'world_clock advance receipts must be realm-opaque');

  const set = await dispatcher.executeTool('world_clock', { action: 'set', time: '10:15' });
  assert.equal(set.success, true);
  assert.equal(JSON.stringify(set).includes('realm:'), false, 'world_clock set receipts must be realm-opaque');

  const reset = await dispatcher.executeTool('world_clock', { action: 'reset' });
  assert.equal(reset.success, true);
  assert.equal(JSON.stringify(reset).includes('realm:'), false, 'world_clock reset receipts must be realm-opaque');

  // event_list query: the merged realm-global event is visible but labeled global.
  const events = await dispatcher.executeTool('event_list', { action: 'query' });
  assert.equal(events.success, true);
  const festival = events.events.find((event) => event.name === 'Realm A Festival');
  assert.ok(festival, 'the same-realm global event stays visible');
  assert.equal(festival.ownerId, 'global', "the owner partition is labeled 'global' for agents");
  assert.equal(JSON.stringify(events).includes('realm:'), false, 'event_list query receipts must be realm-opaque');

  // event_list register (caller-owned) and resolve (realm-global event).
  const registered = await dispatcher.executeTool('event_list', { action: 'register', name: 'Realm A Patrol', trigger_minutes: 15 });
  assert.equal(registered.success, true);
  assert.equal(JSON.stringify(registered).includes('realm:'), false, 'event_list register receipts must be realm-opaque');

  const resolved = await dispatcher.executeTool('event_list', { action: 'resolve', event_id: globalEvent.event.id });
  assert.equal(resolved.success, true);
  assert.equal(resolved.event.ownerId, 'global');
  assert.equal(JSON.stringify(resolved).includes('realm:'), false, 'event_list resolve receipts must be realm-opaque');

  // Host/API outputs keep the internal partition key (agent-visible formatting
  // is applied only at the tool seam).
  const hostView = clock.queryEvents({ status: 'all' }, { callerAgentId: 'realm_a_director' });
  assert.equal(
    hostView.events.some((event) => event.ownerId === 'realm:demo:global'),
    true,
    'host/API surfaces keep the internal partition key'
  );
  const hostTime = clock.getTime({ targetAgentId: 'realm:demo:global' }, { callerAgentId: 'realm_a_director' });
  assert.equal(hostTime.agentId, 'realm:demo:global');
});

// ============================================================================
// 10. Canonical Identity Keys — Two Realms, One Bare Id (Wave I, d57cbc1)
// ============================================================================

/**
 * Launches a real two-realm fixture on a real `AgentRuntime`: the bootstrapped
 * system director (the only realm-bypass identity), one privileged root per
 * realm, and the same literal `shared` id registered in both realms. Zero
 * mocks: real registries and the runtime's own frozen identity port.
 *
 * @returns Real runtime fixture with resolved realm-exact projections.
 */
async function launchTwoRealmRuntime() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
  for (const realmId of ['realm_i2_alpha', 'realm_i2_beta']) {
    await runtime.launchAgent({
      config: { id: `${realmId}_root`, realmId, privileged: true, allowedTools: ['*'] },
      principal: operator
    });
  }
  await runtime.launchAgent({ id: 'shared', realmId: 'realm_i2_alpha', allowedTools: ['read_file'] });
  await runtime.launchAgent({ id: 'shared', realmId: 'realm_i2_beta', allowedTools: ['read_file'] });

  const port = runtime.createAgentIdentityPort();
  return {
    runtime,
    port,
    director: port.getAgentIdentity('director'),
    alphaRoot: port.getAgentIdentity('realm_i2_alpha_root'),
    betaRoot: port.getAgentIdentity('realm_i2_beta_root'),
    alphaShared: port.getAgentIdentity('shared', { realmId: 'realm_i2_alpha' }),
    betaShared: port.getAgentIdentity('shared', { realmId: 'realm_i2_beta' })
  };
}

test('10. Canonical identity keys: the same bare id in two realms keeps clock partitions isolated', async () => {
  const fixture = await launchTwoRealmRuntime();
  const { runtime, port, alphaRoot, betaRoot, alphaShared, betaShared } = fixture;
  try {
    assert.equal(alphaShared.id, 'shared');
    assert.equal(betaShared.id, 'shared');
    assert.notEqual(alphaShared.key, betaShared.key, 'the two registrations carry distinct canonical keys');
    assert.equal(port.getAgentIdentity('shared'), null, 'the bare id is ambiguous across realms and fails closed');

    const clock = new WorldClock({ identityPort: port, autoSyncFs: false });
    const alphaCtx = { callerAgentId: 'shared', callerKey: alphaShared.key };
    const betaCtx = { callerAgentId: 'shared', callerKey: betaShared.key };

    // Own-partition isolation: each realm's caller writes its own partition.
    assert.equal(clock.setTime({ totalSeconds: 111 }, alphaCtx).success, true);
    assert.equal(clock.setTime({ totalSeconds: 222 }, betaCtx).success, true);
    const alphaTime = clock.getTime({}, alphaCtx);
    const betaTime = clock.getTime({}, betaCtx);
    assert.equal(alphaTime.totalSeconds, 111);
    assert.equal(betaTime.totalSeconds, 222);
    assert.equal(alphaTime.agentId, 'shared', 'receipts project the bare registration id');
    assert.equal(betaTime.agentId, 'shared');
    assert.equal(JSON.stringify([alphaTime, betaTime]).includes('realm:'), false, 'receipts carry no canonical keys');

    clock.advanceClock({ seconds: 60 }, alphaCtx);
    assert.equal(clock.getTime({}, alphaCtx).totalSeconds, 171);
    assert.equal(clock.getTime({}, betaCtx).totalSeconds, 222, 'advancing Alpha never touches Beta');

    // A realm-privileged caller's bare reference resolves inside its own realm.
    const rootSet = clock.setTime(
      { totalSeconds: 333, targetAgentId: 'shared' },
      { callerAgentId: 'realm_i2_alpha_root', callerKey: alphaRoot.key }
    );
    assert.equal(rootSet.success, true);
    assert.equal(rootSet.agentId, 'shared');
    assert.equal(clock.getTime({}, alphaCtx).totalSeconds, 333);
    assert.equal(clock.getTime({}, betaCtx).totalSeconds, 222, "Alpha's realm-local write never reaches Beta");

    // Cross-realm targeting denies before any mutation, without echoing keys.
    const cross = clock.setTime(
      { totalSeconds: 999, targetAgentId: betaShared.key },
      { callerAgentId: 'realm_i2_alpha_root', callerKey: alphaRoot.key }
    );
    assert.equal(cross.success, false);
    assert.equal(cross.code, 'PERMISSION_DENIED');
    assert.equal(JSON.stringify(cross).includes('realm_i2_beta'), false, 'denials never echo realm vocabulary');
    assert.equal(clock.getTime({}, betaCtx).totalSeconds, 222);

    // Scoped enumeration: Alpha lists its own realm only; the bypass director spans all.
    const alphaClocks = clock.getAllClocks({ callerAgentId: 'realm_i2_alpha_root', callerKey: alphaRoot.key });
    assert.ok(alphaShared.key in alphaClocks, 'the same-realm shared partition is enumerated');
    assert.equal(betaShared.key in alphaClocks, false, "Beta's shared partition is never enumerated");
    assert.equal(betaRoot.key in alphaClocks, false, "Beta's root partition is never enumerated");
    assert.equal(alphaClocks[alphaShared.key].agentId, 'shared', 'listing values project the bare id');
    const serializedValues = JSON.stringify(Object.values(alphaClocks));
    assert.equal(serializedValues.includes(alphaShared.key), false, 'no canonical registration key appears in listing values');
    assert.equal(serializedValues.includes(betaShared.key), false, 'no foreign canonical registration key appears in listing values');

    const directorClocks = clock.getAllClocks({ callerAgentId: 'director', callerKey: fixture.director.key });
    assert.ok(alphaShared.key in directorClocks, 'the bypass director spans Alpha');
    assert.ok(betaShared.key in directorClocks, 'the bypass director spans Beta');
  } finally {
    runtime.destroy();
  }
});

test('11. Canonical identity keys: duplicate event ids resolve realm-locally and receipts stay opaque', async () => {
  const fixture = await launchTwoRealmRuntime();
  const { runtime, port, alphaRoot, betaRoot, alphaShared, betaShared } = fixture;
  try {
    const clock = new WorldClock({ identityPort: port, autoSyncFs: false });
    const alphaCtx = { callerAgentId: 'realm_i2_alpha_root', callerKey: alphaRoot.key };
    const betaCtx = { callerAgentId: 'realm_i2_beta_root', callerKey: betaRoot.key };

    // The same agent-authored event id lands in both realms' partitions.
    const alphaEvent = clock.registerEvent(
      { id: 'evt_shared_beat', name: 'Alpha Beat', targetAgentId: alphaShared.key },
      alphaCtx
    );
    const betaEvent = clock.registerEvent(
      { id: 'evt_shared_beat', name: 'Beta Beat', targetAgentId: betaShared.key },
      betaCtx
    );
    assert.equal(alphaEvent.success, true);
    assert.equal(betaEvent.success, true);
    assert.equal(alphaEvent.event.ownerId, 'shared', 'event ownership projects the bare id');
    assert.equal(alphaEvent.event.createdBy, 'realm_i2_alpha_root', 'attribution projects the bare id');
    assert.equal(JSON.stringify(alphaEvent).includes('realm:'), false, 'event receipts carry no canonical keys');

    // Event-by-id resolution prefers the caller's own realm partition.
    const alphaResolve = clock.resolveEvent({ eventId: 'evt_shared_beat' }, alphaCtx);
    const betaResolve = clock.resolveEvent({ eventId: 'evt_shared_beat' }, betaCtx);
    assert.equal(alphaResolve.success, true);
    assert.equal(alphaResolve.event.name, 'Alpha Beat');
    assert.equal(betaResolve.success, true);
    assert.equal(betaResolve.event.name, 'Beta Beat');

    // Realm-bound callers never query across realms.
    const alphaQuery = clock.queryEvents({ status: 'all', all: true }, alphaCtx);
    assert.deepEqual(alphaQuery.events.map((event) => event.name), ['Alpha Beat']);
    assert.equal(JSON.stringify(alphaQuery).includes('realm:'), false, 'query receipts carry no canonical keys');
    const betaQuery = clock.queryEvents({ status: 'all', all: true }, betaCtx);
    assert.deepEqual(betaQuery.events.map((event) => event.name), ['Beta Beat']);
    const directorQuery = clock.queryEvents(
      { status: 'all', all: true },
      { callerAgentId: 'director', callerKey: fixture.director.key }
    );
    assert.equal(directorQuery.events.some((event) => event.name === 'Alpha Beat'), true);
    assert.equal(directorQuery.events.some((event) => event.name === 'Beta Beat'), true);

    // The agent-visible adapter surface never carries keys or realm vocabulary.
    const visibleTime = clock.handleClockTool({ action: 'query' }, { callerAgentId: 'shared', callerKey: alphaShared.key });
    assert.equal(JSON.stringify(visibleTime).includes('realm:'), false, 'clock tool receipts are realm-opaque');
    const visibleEvents = clock.handleEventTool({ action: 'query' }, alphaCtx);
    assert.equal(JSON.stringify(visibleEvents).includes('realm:'), false, 'event tool receipts are realm-opaque');
    const visibleAll = clock.handleClockTool({ action: 'query', all: true }, alphaCtx);
    assert.equal(JSON.stringify(visibleAll).includes('realm:'), false, 'all-clock tool receipts are realm-opaque');
    const currentTime = clock.getCurrentTime({}, { callerAgentId: 'shared', callerKey: betaShared.key });
    assert.equal(currentTime.agentId, 'shared');
    assert.equal(JSON.stringify(currentTime).includes('realm:'), false, 'get_current_time receipts are realm-opaque');
  } finally {
    runtime.destroy();
  }
});
