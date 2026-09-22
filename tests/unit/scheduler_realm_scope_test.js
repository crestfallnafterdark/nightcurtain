/**
 * @file tests/unit/scheduler_realm_scope_test.js
 * @description Realm isolation suite for `RuntimeScheduler` and `TriggerQueue` (ticket 61dae28).
 *
 * Verifies the Wave A realm-scope contract with injected identities (real class
 * instances, zero static scraping):
 *   1. `schedule()`: cross-realm targets deny fail-closed with `PERMISSION_DENIED`.
 *   2. `schedule()`: same-realm, self, realm-bypass peers, and bypass callers work.
 *   3. `cancelSchedule()`: frontier cancellation by realm — agent authority,
 *      including privileged (`visibility: 'all'`), never escapes its realm.
 *   4. Message-driven early cancellation is confined to the sender's realm, so a
 *      direct message or broadcast cannot cancel a foreign realm's timers.
 *   5. TriggerQueue dispatch filtering: realm-bound sources cannot wake
 *      foreign-realm targets; queued triggers are dropped, never looped.
 *   6. Legacy ungrouped parity: without realm projections (and with no port at
 *      all) the historical, unscoped behavior is unchanged.
 *   7. Forged realm/privilege claims on `params`, `context`, `msg`, or
 *      descriptor-shaped objects are ignored; only the trusted identity
 *      projection plus the reference-validated principal resolve scope.
 *   9. `listSchedules` realm visibility matrix (R3, ticket 10eab05):
 *      own-only for ordinary callers, own + same-realm for a realm-bound root,
 *      all for director/internal bypass, and the ungrouped/system scope for
 *      ungrouped callers; exact-id filters never widen it and no foreign-realm
 *      metadata (prompt, targets, ids) reaches the caller.
 *  10. Cross-scope exact-id cancellation stays denied (re-verification, no
 *      regression) and leaves the foreign timers armed.
 *  11. Agent-visible scheduler tool receipts are realm-opaque: no `realm:`
 *      partition key reaches `schedule`/`list_schedules`/`cancel_schedule`.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RuntimeScheduler,
  SCHEDULER_ERROR_CODES,
  SCHEDULER_STATUS
} from '../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';
import { TriggerQueue, TRIGGER_TYPES } from '../../src/lib/sandbox/triggerQueue/index.ts';
import {
  scheduleDescriptor,
  listSchedulesDescriptor,
  cancelScheduleDescriptor
} from '../../src/lib/sandbox/tools/descriptors/index.ts';

// ---------------------------------------------------------------------------
// Fixtures: realm roster + trusted principal/identity doubles
// ---------------------------------------------------------------------------

/** Opaque engine principal; only this exact reference is interior-trusted. */
const TEST_INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test-engine' });

/** Realm roster consumed by the injected identity port. */
const REALM_ROSTER = Object.freeze({
  a1: { realmId: 'R1' },
  a2: { realmId: 'R1' },
  lead: { realmId: 'R1' },
  b1: { realmId: 'R2' },
  b2: { realmId: 'R2' },
  director: { realmId: null, realmBypass: true },
  bypassOnly: { realmId: null, realmBypass: true },
  legacy: { realmId: null }
});

/**
 * Trusted identity port double; projects `realmId`/`realmBypass` exactly like
 * the MOD-13 `AgentIdentityPort` the runtime will inject once wired.
 */
function createIdentityPort(roster = REALM_ROSTER) {
  return {
    getAgentIdentity(agentId) {
      const entry = roster[agentId];
      if (!entry) return null;
      return { id: agentId, realmId: entry.realmId ?? null, realmBypass: entry.realmBypass === true };
    }
  };
}

/** Registry authority resolver double: frozen descriptor instances by reference. */
const authorities = new Map();
function agentAuthority(id, { privileged = false } = {}) {
  const authority = Object.freeze({
    subject: id,
    kind: 'agent',
    allow: new Set(privileged ? ['*'] : []),
    visibility: privileged ? 'all' : 'self'
  });
  authorities.set(id, authority);
  return authority;
}

// Stable roster authorities (created once; the resolver validates by reference).
const A1 = agentAuthority('a1');
const A2 = agentAuthority('a2');
const LEAD = agentAuthority('lead', { privileged: true });
const B1 = agentAuthority('b1');
const B2 = agentAuthority('b2');
const DIRECTOR = agentAuthority('director', { privileged: true });
const BYPASS_ONLY = agentAuthority('bypassOnly');
const LEGACY = agentAuthority('legacy');

/** Registry resolver used by every scheduler under test. */
const resolveAgentAuthority = (id) => authorities.get(id) || null;

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function createScheduler({ triggerQueue = null, identityPort = createIdentityPort() } = {}) {
  return new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority,
    identityPort,
    triggerQueue
  });
}

function getStatus(scheduler, ownerAuthority, timerId) {
  const list = scheduler.listSchedules({}, { principal: ownerAuthority });
  const task = list.schedules.find((entry) => entry.timerId === timerId);
  return task ? task.status : null;
}

// ---------------------------------------------------------------------------
// 1-2. schedule(): realm-confined targets
// ---------------------------------------------------------------------------

test('1. schedule(): cross-realm targets deny fail-closed', async () => {
  const enqueued = [];
  const spyQueue = { enqueue: (trigger) => { enqueued.push(trigger); return 'trig_spy'; } };
  const scheduler = createScheduler({ triggerQueue: spyQueue });

  // R1 caller -> R2 target: denied, nothing registered, nothing woken.
  const foreign = scheduler.schedule(
    { agentId: 'b1', prompt: 'wake the other realm', durationSeconds: 0.02 },
    { principal: A1 }
  );
  assert.strictEqual(foreign.success, false);
  assert.strictEqual(foreign.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(scheduler.exportSchedules().length, 0);

  // Unresolvable target from a realm-bound caller: fail closed.
  const ghost = scheduler.schedule(
    { agentId: 'ghost', prompt: 'wake nobody', durationSeconds: 0.02 },
    { principal: A1 }
  );
  assert.strictEqual(ghost.success, false);
  assert.strictEqual(ghost.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Ungrouped (legacy) target is outside the realm boundary: fail closed.
  const ungrouped = scheduler.schedule(
    { agentId: 'legacy', prompt: 'wake ungrouped', durationSeconds: 0.02 },
    { principal: A1 }
  );
  assert.strictEqual(ungrouped.success, false);
  assert.strictEqual(ungrouped.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Privileged agent authority (visibility 'all') still does not escape its realm.
  const privilegedForeign = scheduler.schedule(
    { agentId: 'b2', prompt: 'privileged cross-realm', durationSeconds: 0.02 },
    { principal: LEAD }
  );
  assert.strictEqual(privilegedForeign.success, false);
  assert.strictEqual(privilegedForeign.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  await flush(80);
  assert.strictEqual(enqueued.length, 0, 'no cross-realm wake may reach the trigger queue');
  assert.strictEqual(scheduler.exportSchedules().length, 0);
  scheduler.destroy();
});

test('2. schedule(): same-realm, self, bypass peers, and bypass callers work', () => {
  const scheduler = createScheduler();

  // Same realm.
  const sameRealm = scheduler.schedule(
    { agentId: 'a2', prompt: 'same realm peer', durationSeconds: 100 },
    { principal: A1 }
  );
  assert.strictEqual(sameRealm.success, true);
  assert.strictEqual(sameRealm.targetAgentId, 'a2');

  // Self, resolved from context when params omit the target.
  const self = scheduler.schedule(
    { prompt: 'self reminder', durationSeconds: 100 },
    { principal: A1, agentId: 'a1' }
  );
  assert.strictEqual(self.success, true);
  assert.strictEqual(self.targetAgentId, 'a1');

  // Realm-bypass peer (hardcoded system director) is reachable from within a realm.
  const toDirector = scheduler.schedule(
    { agentId: 'director', prompt: 'report to director', durationSeconds: 100 },
    { principal: A1 }
  );
  assert.strictEqual(toDirector.success, true);

  // A bypass identity projection spans realms even when its descriptor is not privileged.
  const bypassCaller = scheduler.schedule(
    { agentId: 'b2', prompt: 'bypass cross-realm', durationSeconds: 100 },
    { principal: BYPASS_ONLY }
  );
  assert.strictEqual(bypassCaller.success, true);

  // Privileged director descriptor (bypass rides the projection).
  const directorCaller = scheduler.schedule(
    { agentId: 'a1', prompt: 'director across realms', durationSeconds: 100 },
    { principal: DIRECTOR }
  );
  assert.strictEqual(directorCaller.success, true);

  // Injected internal principal spans every realm.
  const internalCaller = scheduler.schedule(
    { agentId: 'b1', prompt: 'engine path', durationSeconds: 100 },
    { principal: TEST_INTERNAL_PRINCIPAL }
  );
  assert.strictEqual(internalCaller.success, true);

  assert.strictEqual(scheduler.exportSchedules().length, 6);
  scheduler.destroy();
});

// ---------------------------------------------------------------------------
// 3. cancelSchedule(): realm-confined cancellation
// ---------------------------------------------------------------------------

test('3. cancelSchedule(): realm boundary confines even privileged authorities', () => {
  const scheduler = createScheduler();

  const r1Timer = scheduler.schedule(
    { agentId: 'a1', prompt: 'R1 timer', durationSeconds: 100 },
    { principal: A1 }
  );
  const r2Timer = scheduler.schedule(
    { agentId: 'b1', prompt: 'R2 timer', durationSeconds: 100 },
    { principal: B1 }
  );
  const directorTimer = scheduler.schedule(
    { agentId: 'director', prompt: 'director timer', durationSeconds: 100 },
    { principal: DIRECTOR }
  );

  // `listSchedules` is realm-scoped (R3, ticket 10eab05): a realm-bound root
  // sees its own + same-realm schedules only — the foreign R2 timer (and the
  // bypass-owned director timer) stay hidden.
  const privilegedList = scheduler.listSchedules({}, { principal: LEAD });
  assert.ok(
    privilegedList.schedules.some((entry) => entry.timerId === r1Timer.timerId),
    'same-realm schedules stay visible to a realm-bound root'
  );
  assert.equal(
    privilegedList.schedules.some((entry) => entry.timerId === r2Timer.timerId),
    false,
    'a realm-bound root never sees a foreign-realm schedule'
  );
  assert.equal(
    privilegedList.schedules.some((entry) => entry.timerId === directorTimer.timerId),
    false,
    'a realm-bound root never sees a bypass-owned (system scope) schedule'
  );

  // Privileged R1 authority cannot cancel an R2 timer.
  const foreignCancel = scheduler.cancelSchedule(
    r2Timer.timerId,
    null,
    { principal: LEAD }
  );
  assert.strictEqual(foreignCancel.success, false);
  assert.strictEqual(foreignCancel.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(getStatus(scheduler, B1, r2Timer.timerId), SCHEDULER_STATUS.PENDING);

  // ...nor a realm-bypass peer's timer (destructive ops do not cross).
  const directorCancel = scheduler.cancelSchedule(
    directorTimer.timerId,
    null,
    { principal: LEAD }
  );
  assert.strictEqual(directorCancel.success, false);
  assert.strictEqual(directorCancel.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Same-realm cancel succeeds for the privileged authority.
  const sameRealmCancel = scheduler.cancelSchedule(
    r1Timer.timerId,
    'same-realm cleanup',
    { principal: LEAD }
  );
  assert.strictEqual(sameRealmCancel.success, true);

  // Owner cancel unchanged.
  const ownerCancel = scheduler.cancelSchedule(
    r2Timer.timerId,
    'owner cleanup',
    { principal: B1 }
  );
  assert.strictEqual(ownerCancel.success, true);

  // Bypass caller and internal principal span realms.
  const bypassTimer = scheduler.schedule(
    { agentId: 'b2', prompt: 'second R2 timer', durationSeconds: 100 },
    { principal: B1 }
  );
  const bypassCancel = scheduler.cancelSchedule(
    bypassTimer.timerId,
    null,
    { principal: DIRECTOR }
  );
  assert.strictEqual(bypassCancel.success, true);
  const internalCancel = scheduler.cancelSchedule(
    directorTimer.timerId,
    null,
    { principal: TEST_INTERNAL_PRINCIPAL }
  );
  assert.strictEqual(internalCancel.success, true);

  scheduler.destroy();
});

// ---------------------------------------------------------------------------
// 4. Early cancellation: sender realm confinement
// ---------------------------------------------------------------------------

test('4. handleIncomingMessageForTimers(): early cancellation never crosses a scope boundary', () => {
  const scheduler = createScheduler();

  const mkTimer = (ownerAuthority, owner, condition = 'any') => scheduler.schedule(
    { agentId: owner, prompt: `${owner} watchdog`, durationSeconds: 100, timerCondition: condition },
    { principal: ownerAuthority }
  );

  const a1Timer = mkTimer(A1, 'a1');
  const a2Timer = mkTimer(A2, 'a2');
  const b1Timer = mkTimer(B1, 'b1');
  const directorTimer = mkTimer(DIRECTOR, 'director');

  // Broadcast from an R1 member: same-realm peers cancel; the foreign realm's
  // timer and the system-scope (bypass-owned) timer are untouched (V20-F3/F4,
  // tickets 6504af9/af00a71 — the system scope coalesces with no other scope).
  scheduler.handleIncomingMessageForTimers({ from: 'a1', to: 'all', content: 'realm-local broadcast' });
  assert.strictEqual(getStatus(scheduler, A1, a1Timer.timerId), SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(getStatus(scheduler, A2, a2Timer.timerId), SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(
    getStatus(scheduler, DIRECTOR, directorTimer.timerId),
    SCHEDULER_STATUS.PENDING,
    'a realm broadcast never satisfies a system-scope timer'
  );
  assert.strictEqual(
    getStatus(scheduler, B1, b1Timer.timerId),
    SCHEDULER_STATUS.PENDING,
    'broadcast from R1 must not cancel an R2 timer'
  );

  // Direct (cross-realm leak simulation) message must not cancel either.
  scheduler.handleIncomingMessageForTimers({ from: 'a2', to: 'b1', content: 'leaked direct message' });
  assert.strictEqual(getStatus(scheduler, B1, b1Timer.timerId), SCHEDULER_STATUS.PENDING);

  // A resolved ungrouped (shared-null) sender is not a system/bypass sender:
  // it never satisfies a system-scope timer.
  scheduler.handleIncomingMessageForTimers({ from: 'legacy', to: 'all', content: 'ungrouped broadcast' });
  assert.strictEqual(
    getStatus(scheduler, DIRECTOR, directorTimer.timerId),
    SCHEDULER_STATUS.PENDING,
    'an ungrouped sender never satisfies a system-scope timer'
  );

  // An unresolvable sender keeps the legacy matching scope minus the system
  // scope: it still cannot satisfy a bypass-owned timer.
  scheduler.handleIncomingMessageForTimers({ from: 'peer-agent', to: 'all', content: 'legacy sender' });
  assert.strictEqual(
    getStatus(scheduler, DIRECTOR, directorTimer.timerId),
    SCHEDULER_STATUS.PENDING,
    'an unresolvable sender never satisfies a system-scope timer'
  );

  // A realm-bound sender's exact-match condition still works inside its realm.
  const a2Exact = mkTimer(A2, 'a2', 'a1');
  scheduler.handleIncomingMessageForTimers({ from: 'a1', to: 'a2', content: 'targeted reply' });
  assert.strictEqual(getStatus(scheduler, A2, a2Exact.timerId), SCHEDULER_STATUS.CANCELLED);

  // Unresolvable senders keep the legacy matching scope for non-system owners.
  const b2Exact = mkTimer(B2, 'b2', 'peer-agent');
  scheduler.handleIncomingMessageForTimers({ from: 'peer-agent', to: 'all', content: 'legacy sender' });
  assert.strictEqual(getStatus(scheduler, B2, b2Exact.timerId), SCHEDULER_STATUS.CANCELLED);

  // A bypass sender spans realms and is the only path into the system scope.
  scheduler.handleIncomingMessageForTimers({ from: 'director', to: 'all', content: 'director broadcast' });
  assert.strictEqual(getStatus(scheduler, B1, b1Timer.timerId), SCHEDULER_STATUS.CANCELLED);
  assert.strictEqual(
    getStatus(scheduler, DIRECTOR, directorTimer.timerId),
    SCHEDULER_STATUS.CANCELLED,
    'a bypass sender may satisfy a system-scope timer (one-way bypass)'
  );

  scheduler.destroy();
});

// ---------------------------------------------------------------------------
// 5. Legacy ungrouped parity
// ---------------------------------------------------------------------------

test('5. Legacy ungrouped parity: no realm projections means historical behavior', async () => {
  // (a) No identity port at all: cross-agent scheduling stays legacy.
  const bare = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority
  });
  const bareReceipt = bare.schedule(
    { agentId: 'b1', prompt: 'legacy cross-agent schedule', durationSeconds: 100 },
    { principal: A1 }
  );
  assert.strictEqual(bareReceipt.success, true);

  const legacyQueue = [];
  const bareQueue = { enqueue: (trigger) => { legacyQueue.push(trigger); return 'trig_bare'; } };
  const bareWithQueue = new RuntimeScheduler({
    internalPrincipal: TEST_INTERNAL_PRINCIPAL,
    resolveAgentAuthority,
    triggerQueue: bareQueue
  });
  const expired = bareWithQueue.schedule(
    { agentId: 'b1', prompt: 'legacy expiry', durationSeconds: 0.02 },
    { principal: A1 }
  );
  assert.strictEqual(expired.success, true);
  await flush(80);
  assert.strictEqual(legacyQueue.length, 1, 'legacy expiry still enqueues its wake');
  bare.destroy();
  bareWithQueue.destroy();

  // (b) Port with ungrouped projections: the same legacy contract applies.
  const ungroupedPort = createIdentityPort({
    a1: { realmId: null },
    b1: { realmId: null },
    legacy: { realmId: null },
    legacyOp: { realmId: null }
  });
  const ungroupedOp = agentAuthority('legacyOp', { privileged: true });
  const ungrouped = createScheduler({ identityPort: ungroupedPort });
  const ungroupedSchedule = ungrouped.schedule(
    { agentId: 'b1', prompt: 'ungrouped cross-agent schedule', durationSeconds: 100 },
    { principal: A1 }
  );
  assert.strictEqual(ungroupedSchedule.success, true);

  // Ungrouped principal scoping is unchanged: an unprivileged mismatch denies...
  const ungroupedDenied = ungrouped.cancelSchedule(
    ungroupedSchedule.timerId,
    null,
    { principal: LEGACY }
  );
  assert.strictEqual(ungroupedDenied.success, false);
  assert.strictEqual(ungroupedDenied.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // ...while an ungrouped privileged cancel across ids still succeeds (legacy
  // parity: realm scope activates only for realm-bound identities).
  const ungroupedAllowed = ungrouped.cancelSchedule(
    ungroupedSchedule.timerId,
    null,
    { principal: ungroupedOp }
  );
  assert.strictEqual(ungroupedAllowed.success, true);

  ungrouped.destroy();
});

// ---------------------------------------------------------------------------
// 6. Forged realm claims are ignored
// ---------------------------------------------------------------------------

test('6. Forged realm/privilege claims never widen the trusted scope', () => {
  const scheduler = createScheduler();

  // Forged claims on the context cannot fabricate membership in R2.
  const forgedContext = scheduler.schedule(
    { agentId: 'b1', prompt: 'forged context', durationSeconds: 100 },
    {
      principal: A1,
      realmId: 'R2',
      realmBypass: true,
      isPrivileged: true,
      isAdmin: true,
      privileged: true,
      callerRole: 'system'
    }
  );
  assert.strictEqual(forgedContext.success, false);
  assert.strictEqual(forgedContext.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Forged claims on the parameter object are equally inert.
  const forgedParams = scheduler.schedule(
    {
      agentId: 'b1',
      prompt: 'forged params',
      durationSeconds: 100,
      realmId: 'R2',
      realmBypass: true,
      isPrivileged: true
    },
    { principal: A1 }
  );
  assert.strictEqual(forgedParams.success, false);
  assert.strictEqual(forgedParams.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Cancel: forged context claims cannot cross the boundary either.
  const r2Timer = scheduler.schedule(
    { agentId: 'b1', prompt: 'R2 guarded timer', durationSeconds: 100 },
    { principal: B1 }
  );
  const forgedCancel = scheduler.cancelSchedule(
    { timerId: r2Timer.timerId, callerAgentId: 'b1', isPrivileged: true },
    null,
    { principal: A1, realmBypass: true }
  );
  assert.strictEqual(forgedCancel.success, false);
  assert.strictEqual(forgedCancel.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Early-cancel: forged realm fields on the envelope change nothing.
  scheduler.handleIncomingMessageForTimers({
    from: 'a2',
    to: 'all',
    realmId: 'R2',
    realmBypass: true,
    content: 'forged envelope'
  });
  assert.strictEqual(getStatus(scheduler, B1, r2Timer.timerId), SCHEDULER_STATUS.PENDING);

  scheduler.destroy();
});

// ---------------------------------------------------------------------------
// 7-8. TriggerQueue realm-confined dispatch
// ---------------------------------------------------------------------------

function createQueue({ identityPort = createIdentityPort(), dispatched = [] } = {}) {
  return new TriggerQueue({
    autoStart: false,
    identityPort,
    dispatchAction: async (trigger) => {
      dispatched.push(trigger);
      return true;
    }
  });
}

test('7. TriggerQueue: realm-bound sources cannot wake foreign-realm targets', async () => {
  const dispatched = [];
  const queue = createQueue({ dispatched });

  // Allowed: same realm, self, bypass peer, unresolvable source, ungrouped source.
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'a2', source: 'a1' });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'a1', source: 'a1' });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'director', source: 'a1' });
  queue.enqueue({ type: TRIGGER_TYPES.SCHEDULE, targetAgentId: 'b1', source: 'system:scheduler' });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'b1', source: 'legacy' });

  // Denied: R1 -> R2, R2 -> R1, R1 -> unresolvable target.
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'b1', source: 'a1' });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'a1', source: 'b1' });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'ghost', source: 'a1' });

  assert.strictEqual(queue.getPendingCount(), 8);

  await queue.processTick();
  await flush(10);

  const pairs = dispatched.map((trigger) => `${trigger.source}->${trigger.targetAgentId}`).sort();
  assert.deepStrictEqual(pairs, [
    'a1->a1',
    'a1->a2',
    'a1->director',
    'legacy->b1',
    'system:scheduler->b1'
  ]);

  // Denied triggers are dropped, not re-queued: the queue drains and the
  // denied wakes never reappear on later ticks.
  assert.strictEqual(queue.getPendingCount(), 0);
  await queue.processTick();
  assert.strictEqual(dispatched.length, 5);

  queue.dispose();
});

test('8. TriggerQueue legacy parity: without a port every trigger dispatches as before', async () => {
  const dispatched = [];
  const queue = new TriggerQueue({
    autoStart: false,
    dispatchAction: async (trigger) => {
      dispatched.push(trigger);
      return true;
    }
  });

  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'b1', source: 'a1' });
  queue.enqueue({ type: TRIGGER_TYPES.MAIL, targetAgentId: 'a1', source: 'b1' });
  queue.enqueue({ type: TRIGGER_TYPES.USER, targetAgentId: 'ghost', source: 'user' });

  await queue.processTick();

  assert.strictEqual(dispatched.length, 3);
  assert.strictEqual(queue.getPendingCount(), 0);
  queue.dispose();
});

// ---------------------------------------------------------------------------
// 9. listSchedules realm visibility matrix (R3, ticket 10eab05)
// ---------------------------------------------------------------------------

test('9. listSchedules: ordinary own, root own+same-realm, bypass all, ungrouped own scope', () => {
  const scheduler = createScheduler();

  // One timer per scope: R1 self, R1 peer, R2, director (bypass/system), legacy (ungrouped).
  const ownTimer = scheduler.schedule({ agentId: 'a1', prompt: 'R1 own secret', durationSeconds: 100 }, { principal: A1 });
  const peerTimer = scheduler.schedule({ agentId: 'a2', prompt: 'R1 peer secret', durationSeconds: 100 }, { principal: A1 });
  const foreignTimer = scheduler.schedule({ agentId: 'b1', prompt: 'R2 foreign secret', durationSeconds: 100 }, { principal: B1 });
  const directorTimer = scheduler.schedule({ agentId: 'director', prompt: 'system director secret', durationSeconds: 100 }, { principal: DIRECTOR });
  const legacyTimer = scheduler.schedule({ agentId: 'legacy', prompt: 'legacy secret', durationSeconds: 100 }, { principal: LEGACY });
  for (const receipt of [ownTimer, peerTimer, foreignTimer, directorTimer, legacyTimer]) {
    assert.strictEqual(receipt.success, true);
  }

  const idsFor = (principal) => scheduler.listSchedules({}, { principal }).schedules.map((entry) => entry.timerId).sort();
  const jsonFor = (principal) => JSON.stringify(scheduler.listSchedules({}, { principal }));

  // Ordinary (unprivileged, realm-bound): own only — not even the same-realm peer.
  assert.deepStrictEqual(idsFor(A1), [ownTimer.timerId], 'an ordinary caller lists only its own schedules');
  assert.strictEqual(jsonFor(A1).includes('R1 peer secret'), false);
  assert.strictEqual(jsonFor(A1).includes('R2 foreign secret'), false);
  assert.strictEqual(jsonFor(A1).includes('system director secret'), false);

  // Root (privileged, realm-bound): own + same realm; foreign and bypass-owned hidden.
  assert.deepStrictEqual(
    idsFor(LEAD),
    [ownTimer.timerId, peerTimer.timerId].sort(),
    'a realm-bound root lists own + same-realm schedules'
  );
  assert.strictEqual(jsonFor(LEAD).includes('R2 foreign secret'), false, 'no foreign prompt metadata escapes');
  assert.strictEqual(jsonFor(LEAD).includes('system director secret'), false, 'no system-scope prompt metadata escapes');
  assert.strictEqual(jsonFor(LEAD).includes(foreignTimer.timerId), false, 'no foreign timer id escapes');
  assert.strictEqual(jsonFor(LEAD).includes(directorTimer.timerId), false, 'no bypass-owned timer id escapes');

  // Director / internal bypass: everything.
  const bypassIds = [ownTimer.timerId, peerTimer.timerId, foreignTimer.timerId, directorTimer.timerId, legacyTimer.timerId].sort();
  assert.deepStrictEqual(idsFor(DIRECTOR), bypassIds, 'the director bypass spans every scope');
  assert.deepStrictEqual(idsFor(TEST_INTERNAL_PRINCIPAL), bypassIds, 'the internal principal spans every scope');

  // Ungrouped/system scope: a privileged ungrouped caller sees the ungrouped
  // (shared null) scope only — realm-owned schedules stay invisible, and the
  // director's reserved system scope never coalesces with the shared null
  // scope (V20-F3, ticket 6504af9; the prior "part of the shared ungrouped
  // scope" pin was superseded by the locked system-scope model, cf0e127).
  const SYSTEM_OP = agentAuthority('systemOp', { privileged: true });
  const ungrouped = scheduler.listSchedules({}, { principal: SYSTEM_OP });
  assert.ok(
    ungrouped.schedules.some((entry) => entry.timerId === legacyTimer.timerId),
    'ungrouped-scope schedules stay visible to an ungrouped privileged caller'
  );
  assert.strictEqual(
    ungrouped.schedules.some((entry) => entry.timerId === ownTimer.timerId),
    false,
    'a realm-owned schedule is never visible to an ungrouped caller'
  );
  assert.strictEqual(ungrouped.schedules.some((entry) => entry.timerId === foreignTimer.timerId), false);
  assert.strictEqual(
    ungrouped.schedules.some((entry) => entry.timerId === directorTimer.timerId),
    false,
    'the director/system scope is never visible to the shared ungrouped scope'
  );

  // Ungrouped unprivileged: own only.
  assert.deepStrictEqual(idsFor(LEGACY), [legacyTimer.timerId]);

  // Explicit exact-id filters only narrow; they can never widen visibility. An
  // unprivileged caller's foreign-id filter is overridden by its own scope.
  const ownOverride = scheduler.listSchedules({ agentId: 'b1' }, { principal: A1 });
  assert.strictEqual(ownOverride.schedules.length, 1);
  assert.strictEqual(ownOverride.schedules[0].agentId, 'a1');
  assert.strictEqual(ownOverride.schedules[0].timerId, ownTimer.timerId);
  assert.deepStrictEqual(
    scheduler.listSchedules({ agentId: 'b1' }, { principal: LEAD }).schedules,
    [],
    'an exact foreign id filter cannot cross a realm'
  );
  assert.deepStrictEqual(scheduler.listSchedules({ agentId: 'director' }, { principal: LEAD }).schedules, []);
  assert.strictEqual(
    scheduler.listSchedules({}, { principal: A1 }).schedules.every((entry) => entry.agentId === 'a1'),
    true
  );

  // Anonymous stays default-deny.
  assert.deepStrictEqual(scheduler.listSchedules({}, {}).schedules, []);

  scheduler.destroy();
});

// ---------------------------------------------------------------------------
// 10. Cross-scope exact-id cancellation re-verification
// ---------------------------------------------------------------------------

test('10. cancelSchedule: exact-id cross-scope attempts deny and leave foreign timers armed', () => {
  // Extend the roster with a privileged R2 root for the reverse direction.
  const scheduler = createScheduler({
    identityPort: createIdentityPort({ ...REALM_ROSTER, b_lead: { realmId: 'R2' } })
  });
  const B_LEAD = agentAuthority('b_lead', { privileged: true });

  const ownTimer = scheduler.schedule({ agentId: 'a1', prompt: 'R1 own', durationSeconds: 100 }, { principal: A1 });
  const peerTimer = scheduler.schedule({ agentId: 'a2', prompt: 'R1 peer', durationSeconds: 100 }, { principal: A1 });
  const foreignTimer = scheduler.schedule({ agentId: 'b1', prompt: 'R2 foreign', durationSeconds: 100 }, { principal: B1 });
  const directorTimer = scheduler.schedule({ agentId: 'director', prompt: 'director', durationSeconds: 100 }, { principal: DIRECTOR });

  // Ownership stays strict for unprivileged same-realm peers (A1 cannot cancel A2's timer).
  const peerDenied = scheduler.cancelSchedule(peerTimer.timerId, null, { principal: A1 });
  assert.strictEqual(peerDenied.success, false);
  assert.strictEqual(peerDenied.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED);

  // Exact-id cross-scope attempts deny for ordinary, root, ungrouped-root, and
  // reverse-root callers: the system scope (bypass-owned director timer) is
  // reachable from no non-bypass caller, the shared ungrouped scope included.
  const SYSTEM_OP = agentAuthority('systemOp', { privileged: true });
  const denials = [
    ['ordinary R1 -> R2', A1, foreignTimer.timerId],
    ['root R1 -> R2', LEAD, foreignTimer.timerId],
    ['root R1 -> director', LEAD, directorTimer.timerId],
    ['root R2 -> R1', B_LEAD, ownTimer.timerId],
    ['ordinary R1 -> director', A1, directorTimer.timerId],
    ['ungrouped root -> director', SYSTEM_OP, directorTimer.timerId]
  ];
  for (const [label, principal, timerId] of denials) {
    const denied = scheduler.cancelSchedule(timerId, null, { principal });
    assert.strictEqual(denied.success, false, `${label} must be denied`);
    assert.strictEqual(denied.code, SCHEDULER_ERROR_CODES.PERMISSION_DENIED, `${label} denial code`);
  }

  // Every denied target is still armed.
  assert.strictEqual(getStatus(scheduler, A2, peerTimer.timerId), SCHEDULER_STATUS.PENDING);
  assert.strictEqual(getStatus(scheduler, B1, foreignTimer.timerId), SCHEDULER_STATUS.PENDING);
  assert.strictEqual(getStatus(scheduler, DIRECTOR, directorTimer.timerId), SCHEDULER_STATUS.PENDING);
  assert.strictEqual(getStatus(scheduler, A1, ownTimer.timerId), SCHEDULER_STATUS.PENDING);

  // No over-blocking regression: bypass/internal callers still cancel by exact id.
  const directorCancel = scheduler.cancelSchedule(foreignTimer.timerId, null, { principal: DIRECTOR });
  assert.strictEqual(directorCancel.success, true);
  const internalCancel = scheduler.cancelSchedule(directorTimer.timerId, null, { principal: TEST_INTERNAL_PRINCIPAL });
  assert.strictEqual(internalCancel.success, true);
  const ownCancel = scheduler.cancelSchedule(ownTimer.timerId, null, { principal: A1 });
  assert.strictEqual(ownCancel.success, true);
  const rootSameRealmCancel = scheduler.cancelSchedule(peerTimer.timerId, null, { principal: LEAD });
  assert.strictEqual(rootSameRealmCancel.success, true);

  scheduler.destroy();
});

// ---------------------------------------------------------------------------
// 11. Agent-visible scheduler receipts are realm-opaque
// ---------------------------------------------------------------------------

/**
 * Identity port whose projections carry the frozen registry authority
 * descriptor, mirroring the runtime `AgentIdentityPort` shape consumed by the
 * scheduler tool descriptors' caller-scope resolver.
 */
const DESCRIPTOR_IDENTITY_PORT = {
  getAgentIdentity(agentId) {
    const projection = createIdentityPort().getAgentIdentity(agentId);
    if (!projection) return null;
    const authority = authorities.get(agentId);
    return authority ? { ...projection, authority } : projection;
  }
};

/** Minimal real-class LifecyclePort adapter over the scheduler under test. */
function schedulerLifecyclePort(scheduler) {
  return {
    schedule: (params, context) => scheduler.schedule(params, context),
    listSchedules: (options, context) => scheduler.listSchedules(options, context),
    cancelSchedule: (timerIdOrParams, reason, context) => scheduler.cancelSchedule(timerIdOrParams, reason, context)
  };
}

test('11. scheduler tool receipts are realm-opaque (schedule/list_schedules/cancel_schedule)', async () => {
  const scheduler = createScheduler();

  // A bypass caller may arm a timer whose owner is the internal realm-global
  // partition key: the engine projection carries it; the agent-visible tool
  // receipt must not.
  const realmKey = 'realm:R1:global';
  const armed = scheduler.schedule(
    { agentId: realmKey, prompt: 'partition-owned wake', durationSeconds: 100 },
    { principal: TEST_INTERNAL_PRINCIPAL }
  );
  assert.strictEqual(armed.success, true);
  assert.strictEqual(armed.targetAgentId, realmKey);

  const port = schedulerLifecyclePort(scheduler);
  const context = {
    callerAgentId: 'director',
    lifecyclePort: port,
    identityPort: DESCRIPTOR_IDENTITY_PORT
  };

  // list_schedules: the director (bypass) sees the schedule, labeled 'global'.
  const list = await listSchedulesDescriptor.handler({}, context);
  assert.strictEqual(list.success, true);
  const listed = list.schedules.find((entry) => entry.timerId === armed.timerId);
  assert.ok(listed, 'the director sees the system-wide schedule');
  assert.strictEqual(listed.agentId, 'global', "the realm-global owner is labeled 'global'");
  assert.strictEqual(listed.targetAgentId, 'global');
  assert.strictEqual(JSON.stringify(list).includes('realm:'), false, 'list_schedules receipts must be realm-opaque');

  // schedule: the descriptor pins the target to the bound caller.
  const created = await scheduleDescriptor.handler(
    { action: 'create', prompt: 'director reminder', delay_seconds: 100 },
    context
  );
  assert.strictEqual(created.success, true);
  assert.strictEqual(created.targetAgentId, 'director');
  assert.strictEqual(JSON.stringify(created).includes('realm:'), false, 'schedule receipts must be realm-opaque');

  // cancel_schedule: exact-id cancellation succeeds without leaking the owner key.
  const cancelled = await cancelScheduleDescriptor.handler({ task_id: armed.timerId }, context);
  assert.strictEqual(cancelled.success, true);
  assert.strictEqual(cancelled.timerId, armed.timerId);
  assert.strictEqual(JSON.stringify(cancelled).includes('realm:'), false, 'cancel_schedule receipts must be realm-opaque');

  scheduler.destroy();
});
