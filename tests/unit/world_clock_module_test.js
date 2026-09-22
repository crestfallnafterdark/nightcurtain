/**
 * @file tests/unit/world_clock_module_test.js
 * @description Comprehensive unit and contract tests for Module 3: WorldClock.
 * Validates strict ICD and worldClock/index.ts compliance:
 *   1. Strict Export Whitelist & Error Codes
 *   2. TimeState Structure & Granular Time Projections
 *   3. Partition Isolation & Security Access Control
 *   4. Time Progression & Shorthand Parsing (advanceClock)
 *   5. Absolute Time Configuration & Event Status Recalculation (setTime)
 *   6. Clock Reset & Epoch Transition (resetClock)
 *   7. Multi-Partition Inspection (getAllClocks)
 *   8. Event Registration & Scoping (registerEvent)
 *   9. Event Queries & Dynamic Filtering (queryEvents)
 *  10. Event Resolution & Recurrence Engine (resolveEvent)
 *  11. Event Cancellation (cancelEvent)
 *  12. Event Modification (updateEvent)
 *  13. Event Purge & Partition Clearing (clearEvents)
 *  14. Continuous Ticker Engine & Aliases (start, startTicker, stop, stopTicker, isRunning)
 *  15. Complete Snapshot Persistence Roundtrip (exportSnapshot, importSnapshot)
 *  16. Legacy Flat Snapshot Migration & Hydration
 *  17. VirtualFS Bidirectional Synchronization (syncToVirtualFs, syncFromVirtualFs)
 *  18. VirtualFS Resilience to Missing Files and Corrupted Data
 *  19. Injectable Host Timer DI (constructor setInterval/clearInterval)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as WorldClockModule from '../../src/lib/sandbox/worldClock/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';

const { WorldClock, WORLD_CLOCK_ERROR_CODES } = WorldClockModule;

/**
 * MOD-21 W4 test doubles. Authority now resolves from the injected identity
 * port (agent descriptors) and the injected opaque internal principal
 * reference (engine sync); caller flags are inert. The port below stands in
 * for the runtime registry's trusted resolver.
 */
const TEST_INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test_clock_engine' });

/**
 * MOD-21 W10-C: the all-partition snapshot pair is tenant administration and
 * resolves the injected `internalPrincipal` reference from the execution
 * context, so every export/import call below authorizes as the engine.
 */
const SNAPSHOT_CONTEXT = Object.freeze({ principal: TEST_INTERNAL_PRINCIPAL });

const PRIVILEGED_SUBJECTS = new Set(['operator', 'admin', 'director', 'system']);

const TEST_IDENTITY_PORT = {
  getAgentIdentity: (agentId) => (PRIVILEGED_SUBJECTS.has(agentId)
    ? {
      id: agentId,
      privileged: false,
      allowedTools: [],
      authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' }
    }
    : { id: agentId, privileged: false, allowedTools: [] })
};

function makeClock(options = {}) {
  return new WorldClock({
    identityPort: TEST_IDENTITY_PORT,
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    ...options
  });
}

function makeVfs(options = {}) {
  return new VirtualFS({
    identityPort: TEST_IDENTITY_PORT,
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    ...options
  });
}

test('1. Strict Export Whitelist & Error Codes', () => {
  const exportedKeys = Object.keys(WorldClockModule).sort();
  assert.deepStrictEqual(exportedKeys, ['WORLD_CLOCK_ERROR_CODES', 'WorldClock']);

  assert.deepStrictEqual(Object.keys(WORLD_CLOCK_ERROR_CODES), [
    'INVALID_ARGUMENTS',
    'PERMISSION_DENIED',
    'EVENT_NOT_FOUND',
    'CORRUPTED_SNAPSHOT'
  ]);
  assert.strictEqual(WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS, 'INVALID_ARGUMENTS');
  assert.strictEqual(WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED, 'PERMISSION_DENIED');
  assert.strictEqual(WORLD_CLOCK_ERROR_CODES.EVENT_NOT_FOUND, 'EVENT_NOT_FOUND');
  assert.strictEqual(WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT, 'CORRUPTED_SNAPSHOT');
  assert.strictEqual(WORLD_CLOCK_ERROR_CODES.CLOCK_UNAVAILABLE, undefined, 'Dead CLOCK_UNAVAILABLE code removed');
  assert.ok(Object.isFrozen(WORLD_CLOCK_ERROR_CODES));
});

test('2. TimeState Structure & Initial Clock State', () => {
  const clock = makeClock({ initialSeconds: 36905, date: 'Day 1 Morning', autoSyncFs: false });
  const time = clock.getTime();

  assert.strictEqual(time.agentId, 'global');
  assert.strictEqual(time.totalSeconds, 36905);
  assert.strictEqual(time.totalMinutes, 615);
  assert.strictEqual(time.day, 1);
  assert.strictEqual(time.hour, 10);
  assert.strictEqual(time.minute, 15);
  assert.strictEqual(time.second, 5);
  assert.strictEqual(time.formatted, '10:15:05');
  assert.strictEqual(time.shortFormatted, '10:15');
  assert.strictEqual(time.time_string, '10:15:05');
  assert.strictEqual(time.date, 'Day 1 Morning');
  assert.strictEqual(typeof time.lastSync, 'number');
  assert.strictEqual(time.activeEventsCount, 0);
  assert.strictEqual(time.pendingEventsCount, 0);
  assert.strictEqual(time.resolvedEventsCount, 0);
  assert.ok(Object.isFrozen(time));
});

test('3. Partition Isolation on Clock Time Queries', () => {
  const clock = makeClock({ initialSeconds: 3600, autoSyncFs: false });

  // Unprivileged agent_scout querying time gets their own partition (lazily created at 0 sec)
  const scoutTime = clock.getTime({}, { callerAgentId: 'agent_scout' });
  assert.strictEqual(scoutTime.agentId, 'agent_scout');
  assert.strictEqual(scoutTime.totalSeconds, 0);

  // Unprivileged agent cannot inspect another agent via targetAgentId parameter
  const illicitQuery = clock.getTime({ targetAgentId: 'global' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(illicitQuery.agentId, 'agent_scout', 'Unprivileged query must be restricted to callerAgentId');

  // Privileged admin/director can inspect any target partition
  const adminQuery = clock.getTime({ targetAgentId: 'global' }, { callerAgentId: 'director', isAdmin: true });
  assert.strictEqual(adminQuery.agentId, 'global');
  assert.strictEqual(adminQuery.totalSeconds, 3600);

  // String parameter normalization
  const stringParamQuery = clock.getTime('agent_scout', { callerAgentId: 'admin', isAdmin: true });
  assert.strictEqual(stringParamQuery.agentId, 'agent_scout');

  // Params-supplied identity/privilege claims must be ignored (auth is context-only)
  const spoofedQuery = clock.getTime(
    { targetAgentId: 'global', callerAgentId: 'system', isAdmin: true, isPrivileged: true },
    { callerAgentId: 'agent_scout' }
  );
  assert.strictEqual(spoofedQuery.agentId, 'agent_scout', 'Params privilege claims must not grant cross-partition access');
});

test('4. Time Progression & Shorthand Parsing (advanceClock)', () => {
  const clock = makeClock({ initialSeconds: 0, date: 'Day 1', autoSyncFs: false });

  // 1. Advance by discrete minutes and seconds
  const res1 = clock.advanceClock({ minutes: 45, seconds: 30 }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.agentId, 'agent_scout');
  assert.strictEqual(res1.previousSeconds, 0);
  assert.strictEqual(res1.currentSeconds, 2730);
  assert.strictEqual(res1.currentFormatted, '00:45:30');
  assert.strictEqual(res1.shortFormatted, '00:45');
  assert.strictEqual(res1.advancedBySeconds, 2730);
  assert.strictEqual(res1.advancedByMinutes, 45.5);

  // 2. Advance by duration shorthand "1h 30m"
  const res2 = clock.advanceClock({ time: '1h 30m' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.previousSeconds, 2730);
  assert.strictEqual(res2.currentSeconds, 2730 + 5400); // 8130 -> 02:15:30
  assert.strictEqual(res2.currentFormatted, '02:15:30');
  assert.strictEqual(res2.hour, 2);
  assert.strictEqual(res2.minute, 15);
  assert.strictEqual(res2.second, 30);

  // 3. Advance with date string update
  const res3 = clock.advanceClock({ hours: 24, date: 'Day 2' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(res3.success, true);
  assert.strictEqual(res3.day, 2);
  assert.strictEqual(res3.date, 'Day 2');
});

test('5. Multi-Partition Clock Advance & Permission Denials', () => {
  const clock = makeClock({ initialSeconds: 100, autoSyncFs: false });

  // Unprivileged agent trying to advance all partitions
  const unprivAll = clock.advanceClock({ minutes: 10, all: true }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(unprivAll.success, false);
  assert.strictEqual(unprivAll.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // Unprivileged agent trying to advance another agent
  const unprivOther = clock.advanceClock({ minutes: 10, targetAgentId: 'agent_bob' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(unprivOther.success, false);
  assert.strictEqual(unprivOther.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // Params-supplied admin claims must not authorize advancement (auth is context-only)
  const spoofedAll = clock.advanceClock(
    { minutes: 10, all: true, callerAgentId: 'system', isAdmin: true, isPrivileged: true },
    { callerAgentId: 'agent_scout' }
  );
  assert.strictEqual(spoofedAll.success, false);
  assert.strictEqual(spoofedAll.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // Privileged admin advancing all partitions simultaneously
  clock.getTime({}, { callerAgentId: 'agent_1' });
  clock.getTime({}, { callerAgentId: 'agent_2' });

  const privAll = clock.advanceClock({ minutes: 10, all: true }, { callerAgentId: 'system', isAdmin: true });
  assert.strictEqual(privAll.success, true);
  assert.strictEqual(privAll.all, true);
  assert.strictEqual(privAll.advancedBySeconds, 600);
  assert.ok(privAll.clocks);
  assert.strictEqual(privAll.clocks['global'].totalSeconds, 700);
  assert.strictEqual(privAll.clocks['agent_1'].totalSeconds, 600);
  assert.strictEqual(privAll.clocks['agent_2'].totalSeconds, 600);
});

test('6. Absolute Time Configuration & Event Status Recalculation (setTime)', () => {
  const clock = makeClock({ initialSeconds: 0, date: 'Day 1', autoSyncFs: false });

  // Register event at 14:00:00 (50400s)
  const reg = clock.registerEvent({
    name: 'Council Meeting',
    triggerTime: '14:00:00'
  }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(reg.event.status, 'pending');

  // Jump time forward past event trigger time
  const setRes1 = clock.setTime({ time: '15:00:00', date: 'Day 1 Afternoon' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(setRes1.success, true);
  assert.strictEqual(setRes1.currentFormatted, '15:00:00');
  assert.strictEqual(setRes1.date, 'Day 1 Afternoon');
  assert.strictEqual(setRes1.activeEventsCount, 1, 'Event should transition to active');

  // Jump time backwards before event trigger time
  const setRes2 = clock.setTime({ time: '10:00:00' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(setRes2.success, true);
  assert.strictEqual(setRes2.currentFormatted, '10:00:00');
  assert.strictEqual(setRes2.activeEventsCount, 0);
  assert.strictEqual(setRes2.pendingEventsCount, 1, 'Event should revert to pending');

  // Unprivileged caller setting another partition is denied
  const unprivSet = clock.setTime({ time: '12:00:00', targetAgentId: 'agent_bob' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(unprivSet.success, false);
  assert.strictEqual(unprivSet.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
});

test('7. Clock Reset to Epoch (resetClock)', () => {
  const clock = makeClock({ initialSeconds: 50000, date: 'Day 5', autoSyncFs: false });
  clock.registerEvent({ name: 'Future Event', offsetMinutes: 60 }, { callerAgentId: 'agent_scout' });

  // Advance scout
  clock.advanceClock({ minutes: 30 }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(clock.getTime({}, { callerAgentId: 'agent_scout' }).totalSeconds, 1800);

  // Reset scout clock
  const resetRes = clock.resetClock({}, { callerAgentId: 'agent_scout' });
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(resetRes.totalSeconds, 0);
  assert.strictEqual(resetRes.currentSeconds, 0);
  assert.strictEqual(resetRes.formatted, '00:00:00');
  assert.strictEqual(resetRes.date, 'Day 1');

  // Unprivileged resetting all partitions fails
  const unprivResetAll = clock.resetClock({ all: true }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(unprivResetAll.success, false);
  assert.strictEqual(unprivResetAll.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // Privileged resetting all partitions succeeds
  const privResetAll = clock.resetClock({ all: true }, { callerAgentId: 'director', isAdmin: true });
  assert.strictEqual(privResetAll.success, true);
  assert.strictEqual(privResetAll.all, true);
  assert.strictEqual(privResetAll.totalSeconds, 0);
});

test('8. Multi-Partition Inspection (getAllClocks)', () => {
  const clock = makeClock({ initialSeconds: 1000, autoSyncFs: false });
  clock.advanceClock({ seconds: 500 }, { callerAgentId: 'agent_alpha' });
  clock.advanceClock({ seconds: 800 }, { callerAgentId: 'agent_beta' });

  // Unprivileged agent only receives global and their own partition
  const unprivClocks = clock.getAllClocks({ callerAgentId: 'agent_alpha' });
  assert.ok(unprivClocks['global']);
  assert.ok(unprivClocks['agent_alpha']);
  assert.strictEqual(unprivClocks['agent_beta'], undefined);

  // Privileged caller receives all partitions
  const privClocks = clock.getAllClocks({ callerAgentId: 'admin', isAdmin: true });
  assert.ok(privClocks['global']);
  assert.ok(privClocks['agent_alpha']);
  assert.ok(privClocks['agent_beta']);
  assert.strictEqual(privClocks['agent_alpha'].totalSeconds, 500);
  assert.strictEqual(privClocks['agent_beta'].totalSeconds, 800);
});

test('9. Event Registration & Validation', () => {
  const clock = makeClock({ initialSeconds: 3600, autoSyncFs: false });

  // 1. Missing name/description returns INVALID_ARGUMENTS
  const invalidRes = clock.registerEvent({}, { callerAgentId: 'agent_scout' });
  assert.strictEqual(invalidRes.success, false);
  assert.strictEqual(invalidRes.code, WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS);

  // 2. Relative offset registration
  const reg1 = clock.registerEvent({
    name: 'Scout Perimeter',
    description: 'Inspect north gate',
    offsetMinutes: 30,
    category: 'recon',
    priority: 'high',
    metadata: { route: 'north' }
  }, { callerAgentId: 'agent_scout' });

  assert.strictEqual(reg1.success, true);
  assert.strictEqual(reg1.event.name, 'Scout Perimeter');
  assert.strictEqual(reg1.event.triggerTime, 1800); // 0s current scout time + 1800s
  assert.strictEqual(reg1.event.status, 'pending');
  assert.strictEqual(reg1.event.ownerId, 'agent_scout');
  assert.strictEqual(reg1.event.scope, 'agent');
  assert.strictEqual(reg1.event.public, false);
  assert.strictEqual(reg1.event.priority, 'high');
  assert.strictEqual(reg1.event.category, 'recon');
  assert.deepStrictEqual(reg1.event.metadata, { route: 'north' });

  // 3. Immediate execution event (triggerTime <= currentSeconds)
  const reg2 = clock.registerEvent({
    name: 'Immediate Alert'
  }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(reg2.event.status, 'active');

  // 4. Unprivileged caller attempting to register for another agent fails
  const unprivRegOther = clock.registerEvent({
    name: 'Sabotage',
    targetAgentId: 'agent_guard'
  }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(unprivRegOther.success, false);
  assert.strictEqual(unprivRegOther.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // 5. Privileged caller registering global public event
  const privGlobalReg = clock.registerEvent({
    name: 'Solar Flare',
    scope: 'global',
    public: true,
    triggerTime: 7200
  }, { callerAgentId: 'director', isAdmin: true });
  assert.strictEqual(privGlobalReg.success, true);
  assert.strictEqual(privGlobalReg.event.scope, 'global');
  assert.strictEqual(privGlobalReg.event.public, true);
  assert.strictEqual(privGlobalReg.event.ownerId, 'global');
});

test('10. Event Queries, Dynamic Filtering & Scoping (queryEvents)', () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });

  // Register agent events
  clock.registerEvent({ name: 'Patrol 1', category: 'security', offsetMinutes: 10 }, { callerAgentId: 'guard_1' });
  clock.registerEvent({ name: 'Patrol 2', category: 'security', offsetMinutes: 60 }, { callerAgentId: 'guard_1' });
  clock.registerEvent({ name: 'Secret Mission', category: 'covert', offsetMinutes: 10 }, { callerAgentId: 'guard_2' });

  // Register public global event
  clock.registerEvent({ name: 'Town Festival', category: 'social', scope: 'global', public: true, offsetMinutes: 30 }, { callerAgentId: 'director', isAdmin: true });

  // Unprivileged guard_1 query: sees own 2 events + 1 global public event = 3 total
  const q1 = clock.queryEvents({}, { callerAgentId: 'guard_1' });
  assert.strictEqual(q1.success, true);
  assert.strictEqual(q1.count, 3);
  assert.ok(q1.events.some(e => e.name === 'Patrol 1'));
  assert.ok(q1.events.some(e => e.name === 'Patrol 2'));
  assert.ok(q1.events.some(e => e.name === 'Town Festival'));
  assert.ok(!q1.events.some(e => e.name === 'Secret Mission'), 'Private event of guard_2 must not leak to guard_1');

  // Filter by category
  const qCat = clock.queryEvents({ category: 'security' }, { callerAgentId: 'guard_1' });
  assert.strictEqual(qCat.count, 2);

  // Filter by search substring
  const qSearch = clock.queryEvents({ search: 'festival' }, { callerAgentId: 'guard_1' });
  assert.strictEqual(qSearch.count, 1);
  assert.strictEqual(qSearch.events[0].name, 'Town Festival');

  // Advance time and check dynamic status transition
  clock.advanceClock({ minutes: 15 }, { callerAgentId: 'guard_1' });
  const qActive = clock.queryEvents({ status: 'active' }, { callerAgentId: 'guard_1' });
  assert.strictEqual(qActive.count, 1);
  assert.strictEqual(qActive.events[0].name, 'Patrol 1');

  // Privileged query with all: true sees all 4 events
  const qAll = clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true });
  assert.strictEqual(qAll.count, 4);
});

test('11. Event Resolution & Recurrence Engine (resolveEvent)', () => {
  const clock = makeClock({ initialSeconds: 1000, autoSyncFs: false });

  // 1. Recurring event (every 30 minutes = 1800s)
  const reg = clock.registerEvent({
    name: 'Hourly Sentry Check',
    repeatMinutes: 30,
    offsetMinutes: 10
  }, { callerAgentId: 'sentry_1' });

  const eventId = reg.event.id;

  // Advance time to activate event
  clock.advanceClock({ minutes: 15 }, { callerAgentId: 'sentry_1' });

  // Resolve event
  const res = clock.resolveEvent({
    eventId,
    resolutionNote: 'Perimeter secure, no anomalies.'
  }, { callerAgentId: 'sentry_1' });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.resolved, true);
  assert.strictEqual(res.event.status, 'resolved');
  assert.strictEqual(res.event.resolvedBy, 'sentry_1');
  assert.strictEqual(res.event.resolutionNote, 'Perimeter secure, no anomalies.');
  assert.strictEqual(res.event.resolvedAt, 900); // 15m advance on sentry clock = 900s

  // Recurrence spawned nextEvent
  assert.ok(res.nextEvent, 'Recurring event must spawn nextEvent instance');
  assert.notStrictEqual(res.nextEvent.id, eventId);
  assert.strictEqual(res.nextEvent.status, 'pending');
  assert.strictEqual(res.nextEvent.triggerTime, 900 + 1800); // 2700s
  assert.strictEqual(res.nextEvent.resolvedAt, null);

  // Unprivileged third-party cannot resolve someone else's event
  const reg2 = clock.registerEvent({ name: 'Private Task' }, { callerAgentId: 'sentry_1' });
  const illicitRes = clock.resolveEvent({ eventId: reg2.event.id }, { callerAgentId: 'sentry_2' });
  assert.strictEqual(illicitRes.success, false);
  assert.strictEqual(illicitRes.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // Missing event ID handling
  const missingRes = clock.resolveEvent({ eventId: 'non_existent_id' }, { callerAgentId: 'sentry_1' });
  assert.strictEqual(missingRes.success, false);
  assert.strictEqual(missingRes.code, WORLD_CLOCK_ERROR_CODES.EVENT_NOT_FOUND);
});

test('12. Event Cancellation (cancelEvent)', () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });
  const reg = clock.registerEvent({
    name: 'Escort Caravan',
    repeatMinutes: 60,
    offsetMinutes: 20
  }, { callerAgentId: 'guard' });

  const cancelRes = clock.cancelEvent({
    eventId: reg.event.id,
    reason: 'Caravan route cancelled due to sandstorm'
  }, { callerAgentId: 'guard' });

  assert.strictEqual(cancelRes.success, true);
  assert.strictEqual(cancelRes.cancelled, true);
  assert.strictEqual(cancelRes.event.status, 'cancelled');
  assert.strictEqual(cancelRes.event.cancellationReason, 'Caravan route cancelled due to sandstorm');
  assert.strictEqual(cancelRes.event.cancelledBy, 'guard');
});

test('13. Event Update & Purge (updateEvent & clearEvents)', () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });
  const reg = clock.registerEvent({
    name: 'Initial Name',
    priority: 'low',
    category: 'general'
  }, { callerAgentId: 'agent_writer' });

  // Update fields
  const updateRes = clock.updateEvent({
    eventId: reg.event.id,
    name: 'Updated Name',
    priority: 'critical',
    metadata: { key: 'value' }
  }, { callerAgentId: 'agent_writer' });

  assert.strictEqual(updateRes.success, true);
  assert.strictEqual(updateRes.updated, true);
  assert.strictEqual(updateRes.event.name, 'Updated Name');
  assert.strictEqual(updateRes.event.priority, 'critical');
  assert.deepStrictEqual(updateRes.event.metadata, { key: 'value' });

  // Clear events for agent
  const clearRes = clock.clearEvents({}, { callerAgentId: 'agent_writer' });
  assert.strictEqual(clearRes.success, true);
  assert.strictEqual(clearRes.cleared, 1);
  assert.strictEqual(clearRes.agentId, 'agent_writer');

  const qAfter = clock.queryEvents({}, { callerAgentId: 'agent_writer' });
  assert.strictEqual(qAfter.count, 0);
});

test('14. Continuous Ticker Engine & Aliases', async () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });

  assert.strictEqual(clock.isRunning, false);

  // Start ticker with 20ms interval advancing 5 simulation seconds per tick
  const receipt = clock.startTicker({ intervalMs: 20, stepSeconds: 5 });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.running, true);
  assert.strictEqual(receipt.intervalMs, 20);
  assert.strictEqual(receipt.stepSeconds, 5);
  assert.strictEqual(clock.isRunning, true);

  // Wait 70ms (~3 ticks = ~15 simulation seconds)
  await new Promise(resolve => setTimeout(resolve, 70));

  const stopReceipt = clock.stopTicker();
  assert.strictEqual(stopReceipt.success, true);
  assert.strictEqual(stopReceipt.running, false);
  assert.strictEqual(clock.isRunning, false);

  const globalTime = clock.getTime({ targetAgentId: 'global' }, { callerAgentId: 'system', isAdmin: true });
  assert.ok(globalTime.totalSeconds >= 10, `Expected at least 10 simulation seconds, got ${globalTime.totalSeconds}`);
});

test('15. Complete Snapshot Persistence Roundtrip (exportSnapshot, importSnapshot)', () => {
  const clock1 = makeClock({ initialSeconds: 5000, date: 'Day 3 Evening', autoSyncFs: false });
  clock1.advanceClock({ minutes: 30 }, { callerAgentId: 'agent_alpha' });
  clock1.registerEvent({ name: 'Alpha Task', offsetMinutes: 10 }, { callerAgentId: 'agent_alpha' });
  clock1.registerEvent({ name: 'Global Beat', scope: 'global', public: true, offsetMinutes: 50 }, { callerAgentId: 'director', isAdmin: true });

  const snapshot = clock1.exportSnapshot(SNAPSHOT_CONTEXT);
  assert.strictEqual(typeof snapshot.totalSeconds, 'number');
  assert.strictEqual(snapshot.date, 'Day 3 Evening');
  assert.ok(snapshot.agentClocks['global']);
  assert.ok(snapshot.agentClocks['agent_alpha']);
  assert.ok(snapshot.agentEvents['agent_alpha']);

  // Hydrate into clean clock instance
  const clock2 = makeClock({ autoSyncFs: false });
  clock2.importSnapshot(snapshot, SNAPSHOT_CONTEXT);

  const alphaTime = clock2.getTime({}, { callerAgentId: 'agent_alpha' });
  assert.strictEqual(alphaTime.totalSeconds, 1800);
  assert.strictEqual(alphaTime.pendingEventsCount, 2, 'Alpha partition includes own pending task + global pending beat');

  const globalTime = clock2.getTime({ targetAgentId: 'global' }, { callerAgentId: 'director', isAdmin: true });
  assert.strictEqual(globalTime.totalSeconds, 5000);
  assert.strictEqual(globalTime.date, 'Day 3 Evening');

  const qEvents = clock2.queryEvents({ all: true }, { callerAgentId: 'director', isAdmin: true });
  assert.strictEqual(qEvents.count, 2);
});

test('16. Legacy Flat Snapshot Migration & Hydration', () => {
  const legacySnapshot = {
    totalSeconds: 7200,
    date: 'Day 2',
    events: [
      {
        id: 'evt_legacy_1',
        name: 'Legacy Global Event',
        triggerTime: 7200,
        scope: 'global',
        public: true,
        ownerId: 'global',
        createdBy: 'director',
        status: 'active'
      },
      {
        id: 'evt_legacy_2',
        name: 'Legacy Agent Task',
        triggerTime: 3600,
        scope: 'agent',
        public: false,
        ownerId: 'agent_scout',
        createdBy: 'agent_scout',
        status: 'pending'
      }
    ]
  };

  const clock = makeClock({ autoSyncFs: false });
  clock.importSnapshot(legacySnapshot, SNAPSHOT_CONTEXT);

  const scoutEvents = clock.queryEvents({}, { callerAgentId: 'agent_scout' });
  assert.strictEqual(scoutEvents.count, 2, 'Scout should see own event + public global event');
  assert.ok(scoutEvents.events.some(e => e.id === 'evt_legacy_1'));
  assert.ok(scoutEvents.events.some(e => e.id === 'evt_legacy_2'));
});

test('17. VirtualFS Bidirectional Synchronization (syncToVirtualFs & syncFromVirtualFs)', () => {
  const vfs = makeVfs();
  const clock = makeClock({ virtualFs: vfs, initialSeconds: 3600, date: 'Day 1 Morning', autoSyncFs: true });

  // 1. Initial creation syncs /global/world_clock.json and /global/event_list.json
  assert.strictEqual(vfs.exists('/world_clock.json', { workspaceId: 'global', callerAgentId: 'system', isAdmin: true }), true);
  assert.strictEqual(vfs.exists('/event_list.json', { workspaceId: 'global', callerAgentId: 'system', isAdmin: true }), true);

  const globalClockFile = vfs.readFile('/world_clock.json', { workspaceId: 'global', callerAgentId: 'system', isAdmin: true, raw: true });
  const parsedGlobalClock = JSON.parse(typeof globalClockFile === 'string' ? globalClockFile : globalClockFile.content);
  assert.strictEqual(parsedGlobalClock.totalSeconds, 3600);
  assert.strictEqual(parsedGlobalClock.formatted, '01:00:00');
  assert.strictEqual(parsedGlobalClock.date, 'Day 1 Morning');

  // 2. Advance time for agent_scout and register an event
  clock.advanceClock({ minutes: 30 }, { callerAgentId: 'agent_scout' });
  clock.registerEvent({
    name: 'Scout Perimeter Shift',
    offsetMinutes: 15,
    category: 'security',
    priority: 'high'
  }, { callerAgentId: 'agent_scout' });

  // Files in agent_scout workspace must be synchronized
  assert.strictEqual(vfs.exists('/world_clock.json', { workspaceId: 'agent_scout', callerAgentId: 'system', isAdmin: true }), true);
  assert.strictEqual(vfs.exists('/event_list.json', { workspaceId: 'agent_scout', callerAgentId: 'system', isAdmin: true }), true);

  const scoutEventFile = vfs.readFile('/event_list.json', { workspaceId: 'agent_scout', callerAgentId: 'system', isAdmin: true, raw: true });
  const parsedScoutEvents = JSON.parse(typeof scoutEventFile === 'string' ? scoutEventFile : scoutEventFile.content);
  assert.strictEqual(parsedScoutEvents.events.length, 1);
  assert.strictEqual(parsedScoutEvents.events[0].name, 'Scout Perimeter Shift');

  // 3. Hydrate state into a brand new WorldClock instance from the same VFS
  const newClock = makeClock({ virtualFs: vfs, autoSyncFs: true });
  newClock.syncFromVirtualFs();

  const scoutTime = newClock.getTime({}, { callerAgentId: 'agent_scout' });
  assert.strictEqual(scoutTime.totalSeconds, 1800);
  assert.strictEqual(scoutTime.formatted, '00:30:00');

  const scoutQueriedEvents = newClock.queryEvents({}, { callerAgentId: 'agent_scout' });
  assert.strictEqual(scoutQueriedEvents.count, 1);
  assert.strictEqual(scoutQueriedEvents.events[0].name, 'Scout Perimeter Shift');
});

test('18. VirtualFS Resilience to Missing Files & Malformed JSON', () => {
  const vfs = makeVfs();
  // Write invalid corrupted JSON
  vfs.writeFile('/world_clock.json', '{ corrupted_json: invalid', { workspaceId: 'agent_broken', callerAgentId: 'system', isAdmin: true });
  vfs.writeFile('/event_list.json', 'NOT_JSON', { workspaceId: 'agent_broken', callerAgentId: 'system', isAdmin: true });

  const clock = makeClock({ virtualFs: vfs, autoSyncFs: true });
  // Must not throw or crash on corrupted data, and must surface the corruption
  let receipt;
  assert.doesNotThrow(() => {
    receipt = clock.syncFromVirtualFs('agent_broken');
  });
  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);

  const brokenTime = clock.getTime({}, { callerAgentId: 'agent_broken' });
  assert.strictEqual(brokenTime.totalSeconds, 0, 'Should fall back to clean 0 seconds');
});

test('19. Injectable Host Timers (setInterval/clearInterval)', () => {
  const scheduled = [];
  const cleared = [];
  const clock = makeClock({
    autoSyncFs: false,
    setInterval: (handler, ms) => {
      const handle = { handler, ms };
      scheduled.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    }
  });

  const receipt = clock.start({ intervalMs: 50, stepSeconds: 5 });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.running, true);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].ms, 50);
  assert.strictEqual(clock.isRunning, true);

  // Simulate one tick without touching real host timers
  scheduled[0].handler();
  const globalTime = clock.getTime({ targetAgentId: 'global' }, { callerAgentId: 'system', isAdmin: true });
  assert.strictEqual(globalTime.totalSeconds, 5);

  const stopReceipt = clock.stopTicker();
  assert.strictEqual(stopReceipt.running, false);
  assert.strictEqual(cleared.length, 1);
  assert.strictEqual(cleared[0], scheduled[0]);
  assert.strictEqual(clock.isRunning, false);
});

test('20. Event-returning APIs yield defensive copies', () => {
  const clock = makeClock({ initialSeconds: 1000, autoSyncFs: false });

  const reg = clock.registerEvent({
    name: 'Copy Guard',
    offsetMinutes: 10,
    metadata: { nested: { flag: true }, tags: ['a'] }
  }, { callerAgentId: 'agent_copy' });

  reg.event.name = 'MUTATED';
  reg.event.metadata.nested.flag = false;
  reg.event.metadata.tags.push('b');

  const afterReg = clock.queryEvents({}, { callerAgentId: 'agent_copy' }).events.find(e => e.id === reg.event.id);
  assert.strictEqual(afterReg.name, 'Copy Guard', 'registerEvent result must not alias internal state');
  assert.deepStrictEqual(afterReg.metadata, { nested: { flag: true }, tags: ['a'] });

  afterReg.metadata.nested.flag = 'corrupted';
  const requery = clock.queryEvents({}, { callerAgentId: 'agent_copy' }).events.find(e => e.id === reg.event.id);
  assert.deepStrictEqual(requery.metadata, { nested: { flag: true }, tags: ['a'] }, 'queryEvents results must not alias internal state');

  const upd = clock.updateEvent({ eventId: reg.event.id, name: 'Renamed' }, { callerAgentId: 'agent_copy' });
  assert.strictEqual(upd.success, true);
  upd.event.name = 'MUTATED AGAIN';
  assert.strictEqual(
    clock.queryEvents({ eventId: reg.event.id }, { callerAgentId: 'agent_copy' }).events[0].name,
    'Renamed',
    'updateEvent result must not alias internal state'
  );

  const canc = clock.cancelEvent({ eventId: reg.event.id }, { callerAgentId: 'agent_copy' });
  assert.strictEqual(canc.success, true);
  canc.event.cancellationReason = 'MUTATED';
  assert.strictEqual(
    clock.queryEvents({ eventId: reg.event.id }, { callerAgentId: 'agent_copy' }).events[0].cancellationReason,
    'Cancelled',
    'cancelEvent result must not alias internal state'
  );

  const triggered = clock.registerEvent({
    name: 'Trigger Copy',
    offsetMinutes: 1,
    metadata: { hit: 0 }
  }, { callerAgentId: 'agent_copy' });
  const adv = clock.advanceClock({ minutes: 2 }, { callerAgentId: 'agent_copy' });
  const trigEvt = adv.triggeredEvents.find(e => e.id === triggered.event.id);
  assert.ok(trigEvt, 'Event should have triggered');
  trigEvt.metadata.hit = 99;
  const trigRequery = clock.queryEvents({ eventId: triggered.event.id }, { callerAgentId: 'agent_copy' }).events[0];
  assert.strictEqual(trigRequery.metadata.hit, 0, 'triggeredEvents must not alias internal state');

  const res = clock.resolveEvent({ eventId: triggered.event.id }, { callerAgentId: 'agent_copy' });
  assert.strictEqual(res.success, true);
  res.event.resolutionNote = 'MUTATED';
  const resRequery = clock.queryEvents({ eventId: triggered.event.id }, { callerAgentId: 'agent_copy' }).events[0];
  assert.notStrictEqual(resRequery.resolutionNote, 'MUTATED', 'resolveEvent result must not alias internal state');

  const snapshot = clock.exportSnapshot(SNAPSHOT_CONTEXT);
  snapshot.agentEvents['agent_copy'].find(e => e.id === triggered.event.id).metadata.hit = 42;
  assert.strictEqual(
    clock.queryEvents({ eventId: triggered.event.id }, { callerAgentId: 'agent_copy' }).events[0].metadata.hit,
    0,
    'exportSnapshot must not alias internal state'
  );
});

test('21. resolveEvent rejects terminal states and never re-spawns recurrence', () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });

  const reg = clock.registerEvent({
    name: 'Recurring Guard',
    repeatMinutes: 5,
    offsetMinutes: 1
  }, { callerAgentId: 'agent_guard' });

  clock.advanceClock({ minutes: 2 }, { callerAgentId: 'agent_guard' });

  const first = clock.resolveEvent({ eventId: reg.event.id, resolutionNote: 'first' }, { callerAgentId: 'agent_guard' });
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.event.triggeredAtWorldTime, 120);
  assert.ok(first.nextEvent, 'Recurring event must spawn nextEvent instance');
  assert.strictEqual(first.nextEvent.triggeredAtWorldTime, undefined, 'nextEvent must not inherit stale triggeredAtWorldTime');
  assert.strictEqual(first.nextEvent.status, 'pending');

  const countAfterFirst = clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true }).count;

  const second = clock.resolveEvent({ eventId: reg.event.id, resolutionNote: 'second' }, { callerAgentId: 'agent_guard' });
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.code, WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS);
  assert.strictEqual(
    clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true }).count,
    countAfterFirst,
    'Re-resolution must not spawn another recurrence'
  );

  const cancelledReg = clock.registerEvent({
    name: 'Cancelled Guard',
    repeatMinutes: 5,
    offsetMinutes: 1
  }, { callerAgentId: 'agent_guard' });
  clock.cancelEvent({ eventId: cancelledReg.event.id }, { callerAgentId: 'agent_guard' });
  const resCancelled = clock.resolveEvent({ eventId: cancelledReg.event.id }, { callerAgentId: 'agent_guard' });
  assert.strictEqual(resCancelled.success, false);
  assert.strictEqual(resCancelled.code, WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS);
});

test('22. Legacy positional auth channels are removed (context must be an object)', () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });

  const stringCtxTime = clock.getTime({}, 'agent_scout');
  assert.strictEqual(stringCtxTime.agentId, 'global', 'String context must not grant caller identity');
  assert.deepStrictEqual(Object.keys(clock.getAllClocks('admin')), ['global'], 'String context must not grant privilege');

  const adv = clock.advanceClock({ minutes: 5 }, 'agent_scout');
  assert.strictEqual(adv.success, true);
  assert.strictEqual(adv.agentId, 'global', 'String context must not target another partition');

  const reg = clock.registerEvent({ name: 'Positional Guard' }, { callerAgentId: 'agent_scout' });
  const cancel = clock.cancelEvent(reg.event.id, 'agent_scout');
  assert.strictEqual(cancel.success, false);
  assert.strictEqual(cancel.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED, 'String context must not authenticate the owner');

  const cancelOk = clock.cancelEvent({ eventId: reg.event.id, reason: 'canonical' }, { callerAgentId: 'agent_scout' });
  assert.strictEqual(cancelOk.success, true);
  assert.strictEqual(cancelOk.event.cancellationReason, 'canonical');
});

test('23. Declared aliases are honored (setTime, writeToFs, eventId, type, numeric start)', () => {
  const clock = makeClock({ initialSeconds: 0, autoSyncFs: false });

  clock.setTime({ setTime: '06:30:00' }, { callerAgentId: 'agent_alias' });
  assert.strictEqual(clock.getTime({}, { callerAgentId: 'agent_alias' }).formatted, '06:30:00');

  const reg = clock.registerEvent({
    eventId: 'evt_alias_1',
    name: 'Alias Event',
    type: 'alias-category'
  }, { callerAgentId: 'agent_alias' });
  assert.strictEqual(reg.event.id, 'evt_alias_1');
  assert.strictEqual(reg.event.category, 'alias-category');

  const writes = [];
  const spyVfs = {
    exists: () => true,
    readFile: () => null,
    writeFile: (path, content, options) => { writes.push(options.workspaceId); }
  };
  const vfsClock = makeClock({ virtualFs: spyVfs, autoSyncFs: true });
  writes.length = 0;
  vfsClock.resetClock({ writeToFs: false }, { isAdmin: true, isPrivileged: true });
  assert.strictEqual(writes.length, 0, 'writeToFs:false must suppress VirtualFS synchronization');
  vfsClock.resetClock({ writeToFs: true }, { isAdmin: true, isPrivileged: true });
  assert.ok(writes.length > 0, 'writeToFs:true must synchronize to VirtualFS');

  const scheduled = [];
  const timerClock = makeClock({
    autoSyncFs: false,
    setInterval: (handler, ms) => {
      const handle = { handler, ms };
      scheduled.push(handle);
      return handle;
    },
    clearInterval: () => {}
  });
  const receipt = timerClock.start(25);
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.intervalMs, 25);
  assert.strictEqual(scheduled[0].ms, 25);
  timerClock.stop();
});

test('24. CORRUPTED_SNAPSHOT receipts for malformed snapshots and VFS payloads', () => {
  const clock = makeClock({ autoSyncFs: false });

  const nullResult = clock.importSnapshot(null, SNAPSHOT_CONTEXT);
  assert.strictEqual(nullResult.success, false);
  assert.strictEqual(nullResult.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);

  const badEvents = clock.importSnapshot({ totalSeconds: 100, events: 'not_an_array' }, SNAPSHOT_CONTEXT);
  assert.strictEqual(badEvents.success, false);
  assert.strictEqual(badEvents.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);

  const badClocks = clock.importSnapshot({ totalSeconds: 100, date: 'Day 1', agentClocks: [] }, SNAPSHOT_CONTEXT);
  assert.strictEqual(badClocks.success, false);
  assert.strictEqual(badClocks.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);

  const good = clock.importSnapshot({ totalSeconds: 100, date: 'Day 1', events: [] }, SNAPSHOT_CONTEXT);
  assert.strictEqual(good.success, true);
  assert.strictEqual(clock.getTime().totalSeconds, 100);

  const vfs = makeVfs();
  vfs.writeFile('/world_clock.json', '{ corrupted_json: invalid', { workspaceId: 'agent_bad', callerAgentId: 'system', isAdmin: true });
  vfs.writeFile('/event_list.json', 'NOT_JSON', { workspaceId: 'agent_bad', callerAgentId: 'system', isAdmin: true });
  const clockWithVfs = makeClock({ virtualFs: vfs, autoSyncFs: true });
  const receipt = clockWithVfs.syncFromVirtualFs('agent_bad');
  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);

  const cleanReceipt = clockWithVfs.syncFromVirtualFs('global');
  assert.strictEqual(cleanReceipt.success, true);
});

test('25. queryEvents has no failure branch (no error/code receipt fields)', () => {
  const clock = makeClock({ initialSeconds: 100, autoSyncFs: false });
  clock.registerEvent({ name: 'Known Event' }, { callerAgentId: 'agent_q' });

  const unprivCrossScope = clock.queryEvents({ all: true, targetAgentId: 'agent_other' }, { callerAgentId: 'agent_q' });
  assert.strictEqual(unprivCrossScope.success, true, 'Unauthorized scopes are narrowed silently, never failed');
  assert.strictEqual('error' in unprivCrossScope, false, 'queryEvents must not expose an error field');
  assert.strictEqual('code' in unprivCrossScope, false, 'queryEvents must not expose a code field');
});

test('26. importSnapshot rejects per-entry malformed sections atomically with details', () => {
  const clock = makeClock({ initialSeconds: 777, date: 'Day 5', autoSyncFs: false });
  clock.registerEvent({ name: 'Survivor Event' }, { callerAgentId: 'agent_keep' });

  const malformedClockEntry = clock.importSnapshot({
    totalSeconds: 100,
    date: 'Day 1',
    events: [],
    agentClocks: {
      agent_ok: { totalSeconds: 50, date: 'Day 1', lastSync: 1 },
      agent_bad: 'not-an-object'
    },
    agentEvents: {}
  }, SNAPSHOT_CONTEXT);
  assert.strictEqual(malformedClockEntry.success, false);
  assert.strictEqual(malformedClockEntry.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.deepStrictEqual(malformedClockEntry.details, ['agentClocks["agent_bad"]: expected a clock object']);

  const malformedPartition = clock.importSnapshot({
    totalSeconds: 100,
    date: 'Day 1',
    events: [],
    agentEvents: { agent_bad: { not: 'an array' } }
  }, SNAPSHOT_CONTEXT);
  assert.strictEqual(malformedPartition.success, false);
  assert.strictEqual(malformedPartition.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.deepStrictEqual(malformedPartition.details, ['agentEvents["agent_bad"]: expected an array of events']);

  const malformedEvents = clock.importSnapshot({
    totalSeconds: 100,
    date: 'Day 1',
    events: [null, { name: 'missing id' }, { id: 'evt_ok', name: 'valid' }]
  }, SNAPSHOT_CONTEXT);
  assert.strictEqual(malformedEvents.success, false);
  assert.strictEqual(malformedEvents.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.strictEqual(malformedEvents.details.length, 2);
  assert.ok(malformedEvents.details.some(d => d.includes('events[0]')));
  assert.ok(malformedEvents.details.some(d => d.includes('events[1]')));

  const malformedClockFields = clock.importSnapshot({
    totalSeconds: 100,
    date: 'Day 1',
    events: [],
    agentClocks: { agent_bad: { totalSeconds: 'not-a-number', date: 42 } }
  }, SNAPSHOT_CONTEXT);
  assert.strictEqual(malformedClockFields.success, false);
  assert.strictEqual(malformedClockFields.details.length, 2);
  assert.ok(malformedClockFields.details.some(d => d.includes('totalSeconds')));
  assert.ok(malformedClockFields.details.some(d => d.includes('date')));

  // Atomicity: every rejected snapshot left the prior in-memory state untouched
  const globalTime = clock.getTime({ targetAgentId: 'global' }, { callerAgentId: 'admin', isAdmin: true });
  assert.strictEqual(globalTime.totalSeconds, 777);
  assert.strictEqual(globalTime.date, 'Day 5');
  assert.strictEqual(clock.getAllClocks({ callerAgentId: 'admin', isAdmin: true })['agent_ok'], undefined);
  assert.strictEqual(clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true }).count, 1);
});

test('27. syncFromVirtualFs surfaces malformed event entries while importing valid ones', () => {
  const vfs = makeVfs();
  vfs.writeFile('/world_clock.json', JSON.stringify({ totalSeconds: 600, date: 'Day 1' }), {
    workspaceId: 'agent_mixed',
    callerAgentId: 'system',
    isAdmin: true
  });
  vfs.writeFile('/event_list.json', JSON.stringify({
    events: [
      { id: 'evt_valid', name: 'Valid Event' },
      { name: 'Missing Id' },
      'garbage'
    ]
  }), { workspaceId: 'agent_mixed', callerAgentId: 'system', isAdmin: true });

  const clock = makeClock({ virtualFs: vfs, autoSyncFs: false });
  const receipt = clock.syncFromVirtualFs('agent_mixed');

  assert.strictEqual(receipt.success, false, 'Malformed event entries must not be swallowed');
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.strictEqual(receipt.details.length, 2);
  assert.ok(receipt.details.some(d => d.includes('/event_list.json@agent_mixed') && d.includes('events[1]')));
  assert.ok(receipt.details.some(d => d.includes('/event_list.json@agent_mixed') && d.includes('events[2]')));

  // Best-effort hydration: valid clock and valid event still imported
  const time = clock.getTime({}, { callerAgentId: 'agent_mixed' });
  assert.strictEqual(time.totalSeconds, 600);
  const events = clock.queryEvents({}, { callerAgentId: 'agent_mixed' });
  assert.strictEqual(events.count, 1);
  assert.strictEqual(events.events[0].id, 'evt_valid');
});

test('28. syncFromVirtualFs rejects non-finite totalSeconds and reports malformed dates', () => {
  const makeFixture = () => {
    const vfs = makeVfs();
    const clock = makeClock({ virtualFs: vfs, initialSeconds: 3600, date: 'Day 1 Morning', autoSyncFs: false });
    return { vfs, clock };
  };
  const writeClockFile = (vfs, payload) => vfs.writeFile('/world_clock.json', payload, {
    workspaceId: 'global',
    callerAgentId: 'system',
    isAdmin: true
  });

  // (a) Infinity (JSON `1e999` parses to Infinity) is rejected: reported + clock unchanged
  {
    const { vfs, clock } = makeFixture();
    writeClockFile(vfs, '{"totalSeconds": 1e999, "date": "Era Corrupt"}');
    const receipt = clock.syncFromVirtualFs('global');

    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
    assert.ok(receipt.details.some(d => d.includes('totalSeconds') && d.includes('finite')));

    const time = clock.getTime();
    assert.strictEqual(time.totalSeconds, 3600, 'Non-finite payload must not mutate the clock');
    assert.strictEqual(time.date, 'Day 1 Morning', 'Non-finite payload must not replace the date');
    assert.strictEqual(time.formatted, '01:00:00', 'A corrupted clock must never format as NaN');
  }

  // (b) `null` and `NaN` totalSeconds are non-finite too
  {
    const { vfs, clock } = makeFixture();
    writeClockFile(vfs, JSON.stringify({ totalSeconds: null, date: 'Day 1' }));
    const receipt = clock.syncFromVirtualFs('global');
    assert.strictEqual(receipt.success, false);
    assert.ok(receipt.details.some(d => d.includes('totalSeconds')));
    assert.strictEqual(clock.getTime().totalSeconds, 3600);
  }
  {
    const mockVfs = {
      exists: () => true,
      readFile: (pathOrParams) => {
        const path = (pathOrParams && typeof pathOrParams === 'object') ? pathOrParams.filePath : pathOrParams;
        if (path === '/world_clock.json') return { totalSeconds: NaN, date: 'Day 1' };
        return null;
      }
    };
    const clock = makeClock({ virtualFs: mockVfs, initialSeconds: 3600, date: 'Day 1 Morning', autoSyncFs: false });
    const receipt = clock.syncFromVirtualFs();
    assert.strictEqual(receipt.success, false);
    assert.ok(receipt.details.some(d => d.includes('totalSeconds')));
    assert.strictEqual(clock.getTime().totalSeconds, 3600);
  }

  // (c) Non-string and blank dates are reported; the valid time still hydrates best-effort
  const malformedDates = [
    { payload: JSON.stringify({ totalSeconds: 600, date: 42 }), label: 'non-string date' },
    { payload: JSON.stringify({ totalSeconds: 700, date: '   ' }), label: 'blank date' },
    { payload: JSON.stringify({ totalSeconds: 800, date: null }), label: 'null date' }
  ];
  for (const { payload, label } of malformedDates) {
    const { vfs, clock } = makeFixture();
    writeClockFile(vfs, payload);
    const receipt = clock.syncFromVirtualFs('global');

    assert.strictEqual(receipt.success, false, `${label} must not be silently ignored`);
    assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
    assert.ok(receipt.details.some(d => d.includes('"date"') && d.includes('non-empty string')), `${label} must appear in details`);
    assert.strictEqual(clock.getTime().date, 'Day 1 Morning', `${label} must not overwrite the prior date`);
  }

  // (d) A fully valid payload still hydrates cleanly
  {
    const { vfs, clock } = makeFixture();
    writeClockFile(vfs, JSON.stringify({ totalSeconds: 120, date: 'Era Valid' }));
    const receipt = clock.syncFromVirtualFs('global');
    assert.strictEqual(receipt.success, true);
    assert.strictEqual(clock.getTime().totalSeconds, 120);
    assert.strictEqual(clock.getTime().date, 'Era Valid');
  }
});

test('29. importSnapshot validates the legacy flat events array even when agentEvents is present', () => {
  const clock = makeClock({ initialSeconds: 5000, date: 'Day 4', autoSyncFs: false });

  // Malformed legacy `events` are validated unconditionally, so the snapshot is rejected
  const rejected = clock.importSnapshot({
    totalSeconds: 50,
    date: 'Day 2',
    events: [{ name: 'missing id' }],
    agentEvents: { agent_ok: [{ id: 'evt_ok', name: 'Partitioned Event' }] }
  }, SNAPSHOT_CONTEXT);
  assert.strictEqual(rejected.success, false, 'Legacy events are validated even when agentEvents takes precedence');
  assert.strictEqual(rejected.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(rejected.details.some(d => d.includes('events[0]')));

  // Atomic rejection: prior state untouched
  assert.strictEqual(clock.getTime().totalSeconds, 5000);
  assert.strictEqual(clock.getTime().date, 'Day 4');
  assert.strictEqual(clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true }).count, 0);

  // Both sections well-formed: agentEvents wins and the legacy array is not imported
  const accepted = clock.importSnapshot({
    totalSeconds: 50,
    date: 'Day 2',
    events: [{ id: 'evt_legacy', name: 'Legacy Duplicate' }],
    agentEvents: { agent_ok: [{ id: 'evt_ok', name: 'Partitioned Event' }] }
  }, SNAPSHOT_CONTEXT);
  assert.strictEqual(accepted.success, true);
  assert.strictEqual(clock.getTime().totalSeconds, 50);
  const events = clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true });
  assert.strictEqual(events.count, 1, 'Legacy events must not be imported when agentEvents is present');
  assert.strictEqual(events.events[0].id, 'evt_ok');
});

test('30. importSnapshot validates top-level scalars atomically (non-finite totalSeconds, non-string date)', () => {
  const clock = makeClock({ initialSeconds: 777, date: 'Day 5', autoSyncFs: false });
  clock.registerEvent({ name: 'Survivor Event' }, { callerAgentId: 'agent_keep' });

  const badTotals = [Infinity, -Infinity, NaN, '100', null];
  for (const badTotal of badTotals) {
    const receipt = clock.importSnapshot({ totalSeconds: badTotal, date: 'Day 9', events: [] }, SNAPSHOT_CONTEXT);
    assert.strictEqual(receipt.success, false, `totalSeconds=${String(badTotal)} must be rejected`);
    assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
    assert.ok(
      receipt.details.some(d => d.includes('totalSeconds') && d.includes('finite')),
      `totalSeconds=${String(badTotal)} must be named in details`
    );
  }

  const badDates = [12345, null, {}, []];
  for (const badDate of badDates) {
    const receipt = clock.importSnapshot({ totalSeconds: 50, date: badDate, events: [] }, SNAPSHOT_CONTEXT);
    assert.strictEqual(receipt.success, false, `date=${JSON.stringify(badDate)} must be rejected`);
    assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
    assert.ok(
      receipt.details.some(d => d.toLowerCase().includes('date')),
      `date=${JSON.stringify(badDate)} must be named in details`
    );
  }

  // Both top-level scalars malformed: both are reported
  const bothBad = clock.importSnapshot({ totalSeconds: Infinity, date: 42, events: [] }, SNAPSHOT_CONTEXT);
  assert.strictEqual(bothBad.success, false);
  assert.strictEqual(bothBad.details.length, 2);

  // Atomicity: every rejection left the prior in-memory state untouched
  const time = clock.getTime();
  assert.strictEqual(time.totalSeconds, 777);
  assert.strictEqual(time.date, 'Day 5');
  assert.ok(Number.isFinite(time.totalSeconds), 'clock must never expose a NaN/Infinity projection');
  assert.strictEqual(clock.queryEvents({ all: true }, { callerAgentId: 'admin', isAdmin: true }).count, 1);

  // Absent top-level scalars keep the legacy fallbacks (backward compatibility)
  const legacy = clock.importSnapshot({ events: [] }, SNAPSHOT_CONTEXT);
  assert.strictEqual(legacy.success, true);
  assert.strictEqual(clock.getTime().totalSeconds, 0);
  assert.strictEqual(clock.getTime().date, 'Day 1');

  // Well-formed scalars hydrate after the rejections
  const good = clock.importSnapshot({ totalSeconds: 50, date: 'Day 9', events: [] }, SNAPSHOT_CONTEXT);
  assert.strictEqual(good.success, true);
  assert.strictEqual(clock.getTime().totalSeconds, 50);
  assert.strictEqual(clock.getTime().date, 'Day 9');
});

test('31. syncFromVirtualFs reports unreadable payloads and exists failures as CORRUPTED_SNAPSHOT', () => {
  // (a) readFile throws for both payloads (duck-typed VFS without exists())
  const readFailVfs = {
    readFile: () => {
      throw new Error('EACCES: permission denied');
    }
  };
  const readFailClock = makeClock({ virtualFs: readFailVfs, autoSyncFs: false });
  const readFailReceipt = readFailClock.syncFromVirtualFs('agent_unreadable');
  assert.strictEqual(readFailReceipt.success, false);
  assert.strictEqual(readFailReceipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(readFailReceipt.details.some(d => d.includes('/world_clock.json@agent_unreadable') && d.includes('unreadable')));
  assert.ok(readFailReceipt.details.some(d => d.includes('/event_list.json@agent_unreadable') && d.includes('unreadable')));

  // (b) only the event payload is unreadable; the valid clock payload still hydrates (best-effort)
  const partialVfs = {
    exists: () => true,
    readFile: (pathOrParams) => {
      const filePath = (pathOrParams && typeof pathOrParams === 'object') ? pathOrParams.filePath : pathOrParams;
      if (filePath === '/world_clock.json') return JSON.stringify({ totalSeconds: 900, date: 'Day 1' });
      throw new Error('EIO: device failure');
    }
  };
  const partialClock = makeClock({ virtualFs: partialVfs, autoSyncFs: false });
  const partialReceipt = partialClock.syncFromVirtualFs('agent_partial');
  assert.strictEqual(partialReceipt.success, false);
  assert.strictEqual(partialReceipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(partialReceipt.details.some(d => d.includes('/event_list.json@agent_partial')));
  assert.strictEqual(partialClock.getTime({}, { callerAgentId: 'agent_partial' }).totalSeconds, 900);

  // (c) exists() throws: reported rather than silently treated as "no file"
  const existsFailVfs = {
    exists: () => {
      throw new Error('EIO: stat failure');
    },
    readFile: () => null
  };
  const existsFailClock = makeClock({ virtualFs: existsFailVfs, autoSyncFs: false });
  const existsFailReceipt = existsFailClock.syncFromVirtualFs('agent_statless');
  assert.strictEqual(existsFailReceipt.success, false);
  assert.strictEqual(existsFailReceipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(existsFailReceipt.details.some(d => d.includes('/world_clock.json@agent_statless') && d.includes('unreadable')));
  assert.ok(existsFailReceipt.details.some(d => d.includes('/event_list.json@agent_statless') && d.includes('unreadable')));

  // (d) a genuinely missing file (FileNotFoundError) stays resilient, not corrupted
  const missingFileError = new Error('File not found');
  missingFileError.name = 'FileNotFoundError';
  const missingVfs = {
    readFile: () => {
      throw missingFileError;
    }
  };
  const missingClock = makeClock({ virtualFs: missingVfs, autoSyncFs: false });
  const missingReceipt = missingClock.syncFromVirtualFs('agent_gone');
  assert.strictEqual(missingReceipt.success, true);
  assert.strictEqual(missingReceipt.code, undefined);
});

test('32. Snapshot tenant administration is principal-gated (MOD-21 W10-C)', () => {
  const victim = makeClock({ autoSyncFs: false });
  victim.advanceClock({ minutes: 90 }, { callerAgentId: 'agent_victim' });
  victim.registerEvent({ name: 'victim-secret-event' }, { callerAgentId: 'agent_victim' });

  // Anonymous export/import default-deny with no disclosure and no replacement.
  const leaked = victim.exportSnapshot();
  assert.strictEqual(leaked.success, false);
  assert.strictEqual(leaked.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(leaked.agentClocks, undefined, 'denied export must not disclose partition clocks');
  assert.strictEqual(leaked.agentEvents, undefined, 'denied export must not disclose partition events');

  const denied = victim.importSnapshot({
    agentClocks: { agent_victim: { totalSeconds: 0, date: 'Day 1' }, mallory: { totalSeconds: 999999 } },
    agentEvents: { agent_victim: [] }
  });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(victim.getTime({}, { callerAgentId: 'agent_victim' }).totalSeconds, 5400);
  assert.strictEqual(victim.getTime({}, { callerAgentId: 'mallory' }).totalSeconds, 0);
  assert.strictEqual(victim.queryEvents({}, { callerAgentId: 'agent_victim' }).count, 1);

  // Denial precedes validation (no anonymous malformed-snapshot oracle).
  assert.strictEqual(
    victim.importSnapshot(null).code,
    WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED,
    'anonymous import must deny before reporting corruption'
  );

  // Caller-asserted flags and plain lookalikes confer nothing.
  const lookalike = { kind: 'internal', subject: 'test_clock_engine' };
  assert.strictEqual(victim.exportSnapshot({ principal: lookalike }).code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(victim.exportSnapshot({ isAdmin: true, isPrivileged: true }).code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(
    victim.importSnapshot({ events: [] }, { callerAgentId: 'mallory' }).code,
    WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
  );

  // Trusted principals (injected internal reference or identity-port operator) authorize.
  const snapshot = victim.exportSnapshot(SNAPSHOT_CONTEXT);
  assert.strictEqual(snapshot.agentClocks.agent_victim.totalSeconds, 5400);

  const restored = makeClock({ autoSyncFs: false });
  assert.strictEqual(restored.importSnapshot(snapshot, SNAPSHOT_CONTEXT).success, true);
  assert.strictEqual(restored.getTime({}, { callerAgentId: 'agent_victim' }).totalSeconds, 5400);

  const operatorSnapshot = victim.exportSnapshot({ callerAgentId: 'operator' });
  assert.strictEqual(operatorSnapshot.agentClocks.agent_victim.totalSeconds, 5400);
});

test('33. bindInternalPrincipal binds the composition-root reference once (MOD-21 W10-C)', () => {
  const clock = new WorldClock({ autoSyncFs: false });
  clock.advanceClock({ minutes: 15 }, { callerAgentId: 'agent_late' });

  assert.strictEqual(clock.bindInternalPrincipal(TEST_INTERNAL_PRINCIPAL), true, 'the first valid object binds');
  assert.strictEqual(clock.bindInternalPrincipal({ kind: 'internal', subject: 'lookalike' }), false, 'a second bind is refused');
  assert.strictEqual(clock.bindInternalPrincipal(null), false, 'invalid candidates are rejected');

  assert.strictEqual(clock.exportSnapshot(SNAPSHOT_CONTEXT).agentClocks.agent_late.totalSeconds, 900);

  const constructorBound = makeClock({ autoSyncFs: false });
  assert.strictEqual(
    constructorBound.bindInternalPrincipal(TEST_INTERNAL_PRINCIPAL),
    false,
    'constructor-bound instances are never rebound'
  );
});

test('34. Realm-prefixed partitions are confined for every ungrouped non-bypass caller (V10 F-V10-1)', () => {
  const REALM_AWARE_PORT = {
    getAgentIdentity: (agentId) => {
      if (agentId === 'realm_dir') {
        return {
          id: agentId,
          privileged: false,
          allowedTools: [],
          authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' },
          realmId: 'demo',
          realmBypass: false
        };
      }
      if (agentId === 'legacy_priv') {
        return {
          id: agentId,
          privileged: false,
          allowedTools: [],
          authority: { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' },
          realmId: null,
          realmBypass: false
        };
      }
      return { id: agentId, privileged: false, allowedTools: [], realmId: null, realmBypass: false };
    }
  };
  const clock = new WorldClock({ identityPort: REALM_AWARE_PORT, autoSyncFs: false });

  // Seed a realm partition and a legacy partition.
  clock.setTime({ totalSeconds: 42, targetAgentId: 'global' }, { callerAgentId: 'realm_dir' });
  clock.registerEvent({ name: 'Realm Secret', scope: 'global', triggerTime: 0 }, { callerAgentId: 'realm_dir' });
  clock.setTime({ totalSeconds: 7, targetAgentId: 'global' }, { callerAgentId: 'legacy_priv' });
  clock.registerEvent({ name: 'Legacy Public', scope: 'global', triggerTime: 0 }, { callerAgentId: 'legacy_priv' });

  // Ungrouped privileged: legacy span only, never realm-prefixed partitions.
  const legacyClocks = clock.getAllClocks({ callerAgentId: 'legacy_priv' });
  assert.equal(Object.keys(legacyClocks).some(key => key.startsWith('realm:')), false, 'no realm keys for ungrouped privileged');
  assert.ok('global' in legacyClocks, 'legacy global remains');
  const legacyQuery = clock.queryEvents({ all: true, status: 'all' }, { callerAgentId: 'legacy_priv' });
  assert.equal(legacyQuery.events.some(ev => ev.name === 'Realm Secret'), false, 'ungrouped privileged cannot query realm events');
  assert.equal(legacyQuery.events.some(ev => ev.name === 'Legacy Public'), true, 'legacy events remain visible');

  const legacyAllTime = clock.getTime({ all: true }, { callerAgentId: 'legacy_priv' });
  assert.equal(Object.keys(legacyAllTime.clocks).some(key => key.startsWith('realm:')), false, 'getTime(all) excludes realm keys');

  const foreignSet = clock.setTime({ totalSeconds: 99, targetAgentId: 'realm:demo:global' }, { callerAgentId: 'legacy_priv' });
  assert.equal(foreignSet.success, false, 'ungrouped privileged cannot target a realm partition');
  assert.equal(foreignSet.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  const foreignGet = clock.getTime({ targetAgentId: 'realm:demo:global' }, { callerAgentId: 'legacy_priv' });
  assert.equal(foreignGet.agentId, 'legacy_priv', 'foreign getTime narrows to the caller partition');

  // Ungrouped unprivileged parity is byte-identical: own partition + legacy global only.
  const plainClocks = clock.getAllClocks({ callerAgentId: 'plain_unpriv' });
  assert.deepStrictEqual(Object.keys(plainClocks).sort(), ['global', 'plain_unpriv']);
  const plainQuery = clock.queryEvents({ all: true, status: 'all' }, { callerAgentId: 'plain_unpriv' });
  assert.equal(plainQuery.events.some(ev => ev.name === 'Realm Secret'), false, 'unprivileged callers never read realm events');
  assert.equal(plainQuery.events.some(ev => ev.name === 'Legacy Public'), true, 'public legacy events stay visible');

  // The realm-bound principal still reads its own realm.
  const realmClocks = clock.getAllClocks({ callerAgentId: 'realm_dir' });
  assert.ok('realm:demo:global' in realmClocks, 'realm-bound callers enumerate their realm-global partition');
});

