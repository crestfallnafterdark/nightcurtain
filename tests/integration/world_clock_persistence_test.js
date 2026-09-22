/**
 * @file tests/world_clock_persistence_test.js
 * @description Comprehensive verification suite for Issue 4:
 * World Clock and Event List Persistence Across Reloads.
 * 
 * Verifies:
 * 1. World clock advancement and event registration.
 * 2. Snapshot serialization containing worldClock.
 * 3. Validation of worldClock schema.
 * 4. Hydration into brand-new runtime/store instances simulating full browser reload.
 * 5. Preservation of world time, dates, and active/pending/resolved events.
 * 6. Clock advancement continuing seamlessly from restored world time.
 * 7. Factory reset restoring clean Day 1 state.
 * 8. MessagingBus listener re-wiring surviving reload (busTimerListener & store._unsubBus).
 * 9. Fallback hydration from VirtualFS when persistedState.worldClock is absent (backwards compatibility).
 * 10. Robustness of syncFromVirtualFs with string, object, and budgeted read payloads.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { WorldClock, WORLD_CLOCK_ERROR_CODES } from '../../src/lib/sandbox/worldClock/index.ts';
import {
  serializeRuntimeEnvironment,
  restoreRuntimeEnvironment,
  validateSandboxState,
  saveSandboxState,
  loadSandboxState,
  clearSandboxState
} from '../../src/lib/sandbox/sandboxPersistence/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { createWiredRuntime } from '../helpers/wired_identity_fixture.js';

test('1. Clock advance and event registration updates in-memory state and VirtualFS', async () => {
  clearSandboxState();
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  const clock = runtime.worldClock;
  assert.ok(clock, 'Runtime should have a worldClock instance');

  // Advance time to Day 2, 04:30:00 (86400 + 4*3600 + 30*60 = 102600 seconds)
  clock.setTime({ totalSeconds: 102600, date: 'Day 2 (Solar Arc)' });

  // Register events: one pending, one triggered/active, one resolved
  const res1 = clock.registerEvent({
    title: 'Solar Eclipse',
    description: 'The twin suns align.',
    triggerTime: 105000,
    category: 'celestial'
  });
  assert.equal(res1.success, true);
  const ev1 = res1.event;

  const res2 = clock.registerEvent({
    title: 'Market Opens',
    description: 'Grand bazaar opens.',
    triggerTime: 100000, // in the past relative to 102600
    category: 'society'
  });
  assert.equal(res2.success, true);
  const ev2 = res2.event;

  const res3 = clock.registerEvent({
    title: 'Morning Herald Call',
    description: 'Trumpets blare at dawn.',
    triggerTime: 90000,
    category: 'announcement'
  });
  assert.equal(res3.success, true);
  const ev3 = res3.event;

  const resResolve = clock.resolveEvent({ eventId: ev3.id, resolutionNote: 'Herald finished speech' }, { callerAgentId: 'herald_agent' });
  assert.equal(resResolve.success, true);

  // Verify memory state
  const timeState = clock.getTime();
  assert.equal(timeState.totalSeconds, 102600);
  assert.equal(timeState.day, 2);
  assert.equal(timeState.hour, 4);
  assert.equal(timeState.minute, 30);
  assert.equal(clock.getTime().date, 'Day 2 (Solar Arc)');

  assert.equal(clock.queryEvents({}).events.length, 3);
  assert.equal(clock.queryEvents({ status: 'pending' }).events.length, 1);
  assert.equal(clock.queryEvents({ status: 'active' }).events.length, 1);
  assert.equal(clock.queryEvents({ status: 'resolved' }).events.length, 1);

  // Verify VirtualFS files were written automatically
  assert.ok(vfs.exists('/world_clock.json', { workspaceId: 'global' }));
  assert.ok(vfs.exists('/event_list.json', { workspaceId: 'global' }));

  const rawClockVfs = JSON.parse(vfs.readFile('/world_clock.json', { workspaceId: 'global', callerAgentId: 'system', raw: true }));
  assert.equal(rawClockVfs.totalSeconds, 102600);
  assert.equal(rawClockVfs.date, 'Day 2 (Solar Arc)');

  const rawEventsVfs = JSON.parse(vfs.readFile('/event_list.json', { workspaceId: 'global', callerAgentId: 'system', raw: true }));
  assert.equal(rawEventsVfs.events.length, 3);
});

test('2. Snapshot serialization captures worldClock and passes schema validation', async () => {
  clearSandboxState();
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  runtime.worldClock.setTime({ totalSeconds: 5000, date: 'Day 1 Evening' });
  const regRes = runtime.worldClock.registerEvent({
    id: 'evt_test_1',
    title: 'Campfire Gathering',
    triggerTime: 5500
  });
  assert.equal(regRes.success, true);

  // Serialize runtime environment
  const snapshot = serializeRuntimeEnvironment(runtime, vfs, bus);

  // Verify worldClock is included in snapshot
  assert.ok(snapshot.worldClock, 'Snapshot must include worldClock');
  assert.equal(snapshot.worldClock.totalSeconds, 5000);
  assert.equal(snapshot.worldClock.date, 'Day 1 Evening');
  assert.equal(Array.isArray(snapshot.worldClock.events), true);
  assert.equal(snapshot.worldClock.events.length, 1);
  assert.equal(snapshot.worldClock.events[0].id, 'evt_test_1');

  // Validate state schema
  const validation = validateSandboxState(snapshot);
  assert.equal(validation.valid, true, 'Serialized state must pass validation');

  // Verify invalid worldClock is rejected
  assert.equal(validateSandboxState({ ...snapshot, worldClock: 'invalid_string' }).valid, false);
  assert.equal(validateSandboxState({ ...snapshot, worldClock: { totalSeconds: 'not_a_number' } }).valid, false);
  assert.equal(validateSandboxState({ ...snapshot, worldClock: { events: 'not_an_array' } }).valid, false);
});

test('3. Full browser reload simulation restores World Clock and Event List into fresh instances', async () => {
  clearSandboxState();

  // Step A: Setup original store and customize world clock & events
  const { runtime: runtime1, virtualFs: vfs1, messagingBus: bus1 } = createWiredRuntime();
  const originalStore = new SandboxStore({ virtualFs: vfs1, messagingBus: bus1, runtime: runtime1, autoBootstrapDirector: false, autoHydrate: false });
  const originalClock = runtime1.worldClock;
  originalClock.setTime({ totalSeconds: 95400, date: 'Cycle 3 - Moon of Whispers' });

  originalClock.registerEvent({
    id: 'evt_comet',
    title: 'Comet Sighting',
    description: 'A blue streak in the sky',
    triggerTime: 96000,
    category: 'omen'
  });

  originalClock.registerEvent({
    id: 'evt_festival',
    title: 'Lantern Festival',
    description: 'Celebrations in the square',
    triggerTime: 92000,
    category: 'festival'
  });
  // Resolve the festival event
  originalClock.resolveEvent(
    { eventId: 'evt_festival', resolutionNote: 'All lanterns released into the river' },
    { callerAgentId: 'elder_agent' }
  );

  // Save to persistent storage
  const saved = originalStore.saveToStorage();
  assert.equal(saved, true, 'Original store must save state to storage');

  // Step B: Simulate browser reload by instantiating a completely new SandboxStore
  // The new store initializes with brand-new empty VirtualFS and fresh runtime
  const { runtime: runtime2, virtualFs: vfs2, messagingBus: bus2 } = createWiredRuntime();
  const reloadedStore = new SandboxStore({ virtualFs: vfs2, messagingBus: bus2, runtime: runtime2, autoBootstrapDirector: false, autoHydrate: true });

  // Verify that reloaded store hydrated correctly
  const reloadedClock = runtime2.worldClock;
  assert.ok(reloadedClock, 'Reloaded store must have worldClock');
  assert.equal(reloadedClock.getTime().totalSeconds, 95400, 'Total seconds must match persisted state');
  assert.equal(reloadedClock.getTime().date, 'Cycle 3 - Moon of Whispers', 'Date must match persisted state');

  const reloadedTime = reloadedClock.getTime();
  assert.equal(reloadedTime.day, 2);
  assert.equal(reloadedTime.hour, 2);
  assert.equal(reloadedTime.minute, 30);

  // Verify events in reloaded store
  const reloadedEvents = reloadedClock.queryEvents({}).events;
  assert.equal(reloadedEvents.length, 2);
  const cometEv = reloadedEvents.find(e => e.id === 'evt_comet');
  assert.ok(cometEv, 'evt_comet must be restored');
  assert.equal(cometEv.name, 'Comet Sighting');
  assert.equal(cometEv.status, 'pending');

  const festivalEv = reloadedEvents.find(e => e.id === 'evt_festival');
  assert.ok(festivalEv, 'evt_festival must be restored');
  assert.equal(festivalEv.status, 'resolved');
  assert.equal(festivalEv.resolutionNote, 'All lanterns released into the river');

  // Verify VirtualFS files in reloaded store match
  assert.ok(vfs2.exists('/world_clock.json', { workspaceId: 'global' }));
  const clockVfs = JSON.parse(vfs2.readFile('/world_clock.json', { workspaceId: 'global', callerAgentId: 'system', raw: true }));
  assert.equal(clockVfs.totalSeconds, 95400);
  assert.equal(clockVfs.date, 'Cycle 3 - Moon of Whispers');

  clearSandboxState();
});

test('4. World time advancement continues seamlessly after reload without resetting to Day 1', async () => {
  clearSandboxState();

  // Create initial state
  const vfs1 = new VirtualFS();
  const bus1 = new MessagingBus();
  const runtime1 = new AgentRuntime({ virtualFs: vfs1, messagingBus: bus1, autoBootstrapDirector: false });

  runtime1.worldClock.setTime({ totalSeconds: 12000, date: 'Day 1 Twilight' });
  const snapshot = serializeRuntimeEnvironment(runtime1, vfs1, bus1);
  saveSandboxState(snapshot);

  // Simulate reload
  const vfs2 = new VirtualFS();
  const bus2 = new MessagingBus();
  const runtime2 = new AgentRuntime({ virtualFs: vfs2, messagingBus: bus2, autoBootstrapDirector: false });

  // Prior to hydration, runtime2 clock is Day 1 00:00:00
  assert.equal(runtime2.worldClock.getTime().totalSeconds, 0);

  // Restore
  const loadedState = loadSandboxState();
  const restoreResult = restoreRuntimeEnvironment(loadedState, runtime2, vfs2, bus2);
  assert.equal(restoreResult.success, true);

  // Verify clock is 12000
  assert.equal(runtime2.worldClock.getTime().totalSeconds, 12000);
  assert.equal(runtime2.worldClock.getTime().date, 'Day 1 Twilight');

  // Now advance time using the tool dispatcher (simulating an agent or system turn)
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs2,
    messagingBus: bus2,
    worldClock: runtime2.worldClock,
    agentId: 'global',
    runtime: runtime2,
    privileged: true,
    allowedTools: ['*']
  });

  const advRes = await dispatcher.executeTool('world_clock', {
    action: 'advance',
    seconds: 3600
  });

  assert.equal(advRes.success, true);
  assert.equal(advRes.currentSeconds, 15600, 'Clock must advance from 12000 + 3600 = 15600');
  assert.equal(runtime2.worldClock.getTime().totalSeconds, 15600);

  // Verify VirtualFS was updated with 15600 and was not overwritten by 0
  const updatedVfsClock = JSON.parse(vfs2.readFile('/world_clock.json', { workspaceId: 'global', callerAgentId: 'system', raw: true }));
  assert.equal(updatedVfsClock.totalSeconds, 15600);

  clearSandboxState();
});

test('5. Factory reset clears world clock to clean Day 1 state in memory, VirtualFS, and storage', async () => {
  clearSandboxState();

  const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();
  const store = new SandboxStore({ virtualFs: vfs, messagingBus: bus, runtime, autoBootstrapDirector: false, autoHydrate: false });
  const clock = runtime.worldClock;
  clock.setTime({ totalSeconds: 250000, date: 'Year 2, Autumn' });
  clock.registerEvent({ title: 'Harvest Feast', triggerTime: 255000 });
  store.saveToStorage();

  // Confirm saved in storage
  assert.ok(loadSandboxState());
  assert.equal(clock.getTime().totalSeconds, 250000);
  assert.equal(clock.queryEvents({}).events.length, 1);

  // Perform factory reset
  store.factoryReset();

  // Storage should be cleared
  assert.equal(loadSandboxState(), null);

  // In-memory clock should be reset to Day 1, 00:00:00
  assert.equal(clock.getTime().totalSeconds, 0);
  assert.equal(clock.getTime().date, 'Day 1');
  assert.equal(clock.queryEvents({}).events.length, 0);

  const time = clock.getTime();
  assert.equal(time.day, 1);
  assert.equal(time.hour, 0);
  assert.equal(time.minute, 0);
  assert.equal(time.second, 0);

  // VirtualFS files should be clean Day 1
  const clockVfs = JSON.parse(vfs.readFile('/world_clock.json', { workspaceId: 'global', callerAgentId: 'system', raw: true }));
  assert.equal(clockVfs.totalSeconds, 0);
  assert.equal(clockVfs.date, 'Day 1');

  const eventsVfs = JSON.parse(vfs.readFile('/event_list.json', { workspaceId: 'global', callerAgentId: 'system', raw: true }));
  assert.equal(eventsVfs.events.length, 0);

  clearSandboxState();
});

test('6. MessagingBus listener re-wiring survives reload and cancels early termination timers', async () => {
  clearSandboxState();

  const { runtime: runtime1, virtualFs: vfs1, messagingBus: bus1 } = createWiredRuntime();

  await runtime1.launchAgent({
    id: 'worker',
    role: 'worker',
    triggerPolicy: 'queued'
  });

  // Schedule a timer with condition 'any'
  const scheduleRes = runtime1.schedule({
    agentId: 'worker',
    prompt: 'Check status update',
    durationSeconds: 60,
    timerCondition: 'any'
  });
  assert.equal(scheduleRes.success, true);
  const timerId = scheduleRes.timerId;

  // Persist state
  const snapshot = serializeRuntimeEnvironment(runtime1, vfs1, bus1);
  saveSandboxState(snapshot);

  // Simulate reload with new instances
  const { runtime: runtime2, virtualFs: vfs2, messagingBus: bus2, hostSend } = createWiredRuntime();

  const loaded = loadSandboxState();
  restoreRuntimeEnvironment(loaded, runtime2, vfs2, bus2);

  // Verify scheduled timers were restored (MOD-21 W4: list as the owning
  // agent; flags and reserved ids no longer confer scheduler authority)
  const restoredTask = runtime2.listSchedules({}, { callerAgentId: 'worker' }).schedules.find(s => s.timerId === timerId);
  assert.ok(restoredTask, 'Scheduled timer must be restored');
  assert.equal(restoredTask.timerCondition, 'any');

  // Verify busTimerListener is re-wired: send a message to worker on bus2
  hostSend({
    from: 'peer',
    to: 'worker',
    content: 'Task done early!'
  });

  // Since condition was 'any', the timer should have been early-cancelled by the re-wired bus listener
  const cancelledTask = runtime2.listSchedules({}, { callerAgentId: 'worker' }).schedules.find(s => s.timerId === timerId);
  assert.equal(cancelledTask.status, 'cancelled', 'Timer status must be cancelled upon early cancellation');

  runtime1.destroy();
  runtime2.destroy();
  clearSandboxState();
});

test('7. SandboxStore _unsubBus survives reload and continues to receive broadcast messages', async () => {
  clearSandboxState();

  const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();
  const store = new SandboxStore({ virtualFs: vfs, messagingBus: bus, runtime, autoBootstrapDirector: false, autoHydrate: false });
  await store.launchAgent({ id: 'agent-1', role: 'assistant' });
  store.saveToStorage();

  // Reload
  const { runtime: runtime2, virtualFs: vfs2, messagingBus: bus2, hostSend: hostSend2 } = createWiredRuntime();
  const reloadedStore = new SandboxStore({ virtualFs: vfs2, messagingBus: bus2, runtime: runtime2, autoBootstrapDirector: false, autoHydrate: true });

  // Send message on reloaded messagingBus
  hostSend2({
    from: 'system',
    to: 'agent-1',
    content: 'Broadcast message after reload'
  });

  // Verify reloadedStore.messages accumulated the broadcast
  const found = reloadedStore.messages.some(m => m.content === 'Broadcast message after reload');
  assert.equal(found, true, 'Store bus subscriber must receive messages after reload');

  clearSandboxState();
});

test('8. Backwards compatibility: restores worldClock from VirtualFS when snapshot.worldClock is absent', async () => {
  clearSandboxState();

  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  // Simulate a legacy snapshot where snapshot.worldClock is undefined,
  // but virtualFs contains /global/world_clock.json and /global/event_list.json
  vfs.writeFile('/world_clock.json', JSON.stringify({
    totalSeconds: 42000,
    date: 'Day 3 Retrofit'
  }), { workspaceId: 'global', callerAgentId: 'system', isAdmin: true });

  vfs.writeFile('/event_list.json', JSON.stringify({
    events: [
      { id: 'legacy_evt_1', name: 'Ancient Ruin Discovery', triggerTime: 45000, status: 'pending' }
    ]
  }), { workspaceId: 'global', callerAgentId: 'system', isAdmin: true });

  const legacySnapshot = {
    version: '1.0.0',
    timestamp: Date.now(),
    agents: [],
    // VFS snapshots are tenant administration (MOD-21 W8-D): export through
    // the runtime persistence port, which carries the composition-root
    // InternalPrincipal binding.
    virtualFs: runtime.createPersistencePort().virtualFs.exportSnapshot(),
    messagingBus: bus.exportSnapshot(),
    // worldClock is intentionally omitted
  };

  const freshVfs = new VirtualFS();
  const freshBus = new MessagingBus();
  const freshRuntime = new AgentRuntime({ virtualFs: freshVfs, messagingBus: freshBus, autoBootstrapDirector: false });

  const restored = restoreRuntimeEnvironment(legacySnapshot, freshRuntime, freshVfs, freshBus);
  assert.equal(restored.success, true);

  // Since snapshot.worldClock was omitted, restoreRuntimeEnvironment should fall back to syncFromVirtualFs()
  assert.equal(freshRuntime.worldClock.getTime().totalSeconds, 42000);
  assert.equal(freshRuntime.worldClock.getTime().date, 'Day 3 Retrofit');
  const legacyEvents = freshRuntime.worldClock.queryEvents({}).events;
  assert.equal(legacyEvents.length, 1);
  assert.equal(legacyEvents.find(e => e.id === 'legacy_evt_1').name, 'Ancient Ruin Discovery');

  clearSandboxState();
});

test('9. Robustness: syncFromVirtualFs handles raw object, string JSON, and BudgetedReadOutput', async () => {
  const vfs = new VirtualFS();
  const clock = new WorldClock({ virtualFs: vfs });

  // Case A: string JSON written directly
  vfs.writeFile('/world_clock.json', JSON.stringify({ totalSeconds: 1500, date: 'Era 1' }), { workspaceId: 'global', callerAgentId: 'system', isAdmin: true });
  clock.syncFromVirtualFs();
  assert.equal(clock.getTime().totalSeconds, 1500);
  assert.equal(clock.getTime().date, 'Era 1');

  // Case B: mock virtualFs returning budgeted read output format { content: '...' }
  const mockVfs = {
    exists: () => true,
    readFile: (pathOrParams, maybeOptions) => {
      const path = (pathOrParams && typeof pathOrParams === 'object') ? pathOrParams.filePath : pathOrParams;
      if (path === '/world_clock.json') {
        return { content: JSON.stringify({ totalSeconds: 8888, date: 'Era 2' }) };
      }
      if (path === '/event_list.json') {
        return { content: JSON.stringify({ events: [{ id: 'e1', name: 'Budgeted Event' }] }) };
      }
      return '';
    }
  };

  const clockWithMock = new WorldClock({ virtualFs: mockVfs });
  clockWithMock.syncFromVirtualFs();
  assert.equal(clockWithMock.getTime().totalSeconds, 8888);
  assert.equal(clockWithMock.getTime().date, 'Era 2');
  const mockEvents = clockWithMock.queryEvents({}).events;
  assert.equal(mockEvents.length, 1);
  assert.equal(mockEvents.find(e => e.id === 'e1').name, 'Budgeted Event');

  // Case C: mock virtualFs returning object directly
  const mockObjVfs = {
    exists: () => true,
    readFile: (pathOrParams, maybeOptions) => {
      const path = (pathOrParams && typeof pathOrParams === 'object') ? pathOrParams.filePath : pathOrParams;
      if (path === '/world_clock.json') {
        return { totalSeconds: 9999, date: 'Era 3' };
      }
      if (path === '/event_list.json') {
        return { events: [{ id: 'e2', name: 'Direct Object Event' }] };
      }
      return null;
    }
  };

  const clockWithObj = new WorldClock({ virtualFs: mockObjVfs });
  clockWithObj.syncFromVirtualFs();
  assert.equal(clockWithObj.getTime().totalSeconds, 9999);
  assert.equal(clockWithObj.getTime().date, 'Era 3');
  const objEvents = clockWithObj.queryEvents({}).events;
  assert.equal(objEvents.length, 1);
  assert.equal(objEvents.find(e => e.id === 'e2').name, 'Direct Object Event');
});

test('10. Non-finite and malformed clock payloads are reported without corrupting hydrated state', async () => {
  clearSandboxState();

  const vfs = new VirtualFS();
  const writeClockFile = (payload) => vfs.writeFile('/world_clock.json', payload, {
    workspaceId: 'global',
    callerAgentId: 'system',
    isAdmin: true
  });

  const clock = new WorldClock({ virtualFs: vfs, initialSeconds: 3600, date: 'Day 1 Morning', autoSyncFs: false });

  // Infinity (`1e999`) is rejected with a CORRUPTED_SNAPSHOT receipt and the clock stays clean
  writeClockFile('{"totalSeconds": 1e999, "date": "Era Broken"}');
  const infinityReceipt = clock.syncFromVirtualFs();
  assert.equal(infinityReceipt.success, false);
  assert.equal(infinityReceipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(infinityReceipt.details.some(d => d.includes('totalSeconds')));
  assert.equal(clock.getTime().totalSeconds, 3600, 'Non-finite payload must not mutate the clock');
  assert.equal(clock.getTime().date, 'Day 1 Morning');
  assert.equal(clock.getTime().formatted, '01:00:00');

  // A malformed date is reported while the valid time still hydrates (best-effort sync)
  writeClockFile('{"totalSeconds": 8888, "date": null}');
  const dateReceipt = clock.syncFromVirtualFs();
  assert.equal(dateReceipt.success, false);
  assert.ok(dateReceipt.details.some(d => d.includes('"date"')));
  assert.equal(clock.getTime().totalSeconds, 8888);
  assert.equal(clock.getTime().date, 'Day 1 Morning');

  // A repaired payload hydrates cleanly again
  writeClockFile(JSON.stringify({ totalSeconds: 9999, date: 'Era Repaired' }));
  const cleanReceipt = clock.syncFromVirtualFs();
  assert.equal(cleanReceipt.success, true);
  assert.equal(clock.getTime().totalSeconds, 9999);
  assert.equal(clock.getTime().date, 'Era Repaired');

  clearSandboxState();
});

test('11. syncFromVirtualFs explicit targets are realm-scoped while engine hydration spans every workspace', () => {
  const INTERNAL = Object.freeze({ kind: 'internal', subject: 'persistence_clock_admin' });
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL });
  const operatorWrite = { principal: INTERNAL };

  vfs.writeFile('/world_clock.json', JSON.stringify({ totalSeconds: 1111, date: 'Realm A Day', updatedAt: Date.now() }), {
    workspaceId: 'realm:demo:global',
    ...operatorWrite
  });
  vfs.writeFile('/event_list.json', JSON.stringify({
    events: [{ id: 'evt_a', name: 'Realm A Beacon', ownerId: 'realm:demo:global', status: 'active' }]
  }), { workspaceId: 'realm:demo:global', ...operatorWrite });
  vfs.writeFile('/world_clock.json', JSON.stringify({ totalSeconds: 2222, date: 'Realm B Day', updatedAt: Date.now() }), {
    workspaceId: 'realm:other:global',
    ...operatorWrite
  });

  const identityPort = {
    getAgentIdentity: (agentId) => {
      const authority = { subject: agentId, kind: 'agent', allow: new Set(['*']), visibility: 'all' };
      if (agentId === 'realm_a_director') return { id: agentId, privileged: false, allowedTools: [], authority, realmId: 'demo', realmBypass: false };
      if (agentId === 'realm_b_director') return { id: agentId, privileged: false, allowedTools: [], authority, realmId: 'other', realmBypass: false };
      if (agentId === 'realm_a_member') return { id: agentId, privileged: false, allowedTools: [], realmId: 'demo', realmBypass: false };
      return { id: agentId, privileged: false, allowedTools: [], realmId: null, realmBypass: false };
    }
  };

  const clock = new WorldClock({ virtualFs: vfs, identityPort, internalPrincipal: INTERNAL, autoSyncFs: false });

  // Engine hydration (no caller context) still spans every workspace.
  const fullReceipt = clock.syncFromVirtualFs();
  assert.equal(fullReceipt.success, true, 'engine hydration succeeds');
  assert.equal(clock.getTime({ targetAgentId: 'realm:demo:global' }, { callerAgentId: 'realm_a_director' }).totalSeconds, 1111);
  assert.equal(clock.getTime({ targetAgentId: 'realm:other:global' }, { callerAgentId: 'realm_b_director' }).totalSeconds, 2222);
  assert.equal(
    clock.queryEvents({}, { callerAgentId: 'realm_a_director' }).events.some(ev => ev.name === 'Realm A Beacon'),
    true,
    'realm A events hydrated from the realm workspace'
  );

  // Foreign explicit targets are denied for a realm-bound caller.
  const deniedForeign = clock.syncFromVirtualFs('realm:other:global', { callerAgentId: 'realm_a_director' });
  assert.equal(deniedForeign.success, false, 'foreign realm workspace hydration denied');
  assert.equal(deniedForeign.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  const deniedMember = clock.syncFromVirtualFs('realm_b_member', { callerAgentId: 'realm_a_director' });
  assert.equal(deniedMember.success, false, 'foreign member workspace hydration denied');
  assert.equal(deniedMember.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);

  // Own realm-global and same-realm member workspaces stay hydratable.
  assert.equal(clock.syncFromVirtualFs('realm:demo:global', { callerAgentId: 'realm_a_director' }).success, true);
  assert.equal(clock.syncFromVirtualFs('realm_a_member', { callerAgentId: 'realm_a_director' }).success, true);

  // Context-free engine targets keep the legacy unscoped span.
  assert.equal(clock.syncFromVirtualFs('realm:other:global').success, true, 'context-free explicit target stays unscoped');
});

