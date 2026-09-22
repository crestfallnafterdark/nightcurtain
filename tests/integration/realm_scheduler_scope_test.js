/**
 * @file tests/integration/realm_scheduler_scope_test.js
 * @description Realm wave A-1 (ticket 61dae28) end-to-end scheduler reconnaissance
 *   regression: the scheduler/queue Realm filters must be live through the REAL
 *   composition root, not only when their identity ports are injected by hand.
 *
 *   1. Live wiring: a same-Realm broadcast from an R1 agent cannot early-cancel
 *      an R2 agent's `'any'` timer (red before the composition root injects the
 *      identity port into TriggerQueue/RuntimeScheduler).
 *   2. Runtime API: a realm-bound principal cannot `schedule()`/`cancelSchedule()`
 *      a foreign-Realm target — including a privileged (`*`) realm-bound caller —
 *      while same-Realm targets and the owner stay fully functional.
 *   3. Agent tool path: `LifecyclePort.schedule` forwards the trusted caller
 *      context, and the `schedule` descriptor pins its target to the bound
 *      caller, so the realm gate also evaluates the agent-reachable path.
 *   4. Generic realm parity (Wave R, ticket 56ba4b9): launches without an
 *      explicit realm resolve the seeded Generic default, so same-realm
 *      cross-agent scheduling, early-cancel matching, and timer expiry keep
 *      working inside Generic, while unresolvable/ungrouped targets fail
 *      closed for a Generic caller.
 *
 * Real classes only (Zero-Mock Verification): a real `AgentRuntime` with real
 * substrates; no static source scraping.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { scheduleDescriptor } from '../../src/lib/sandbox/tools/descriptors/index.ts';

/**
 * Resolves a launched agent's frozen registry authority descriptor: the trusted
 * principal every scheduler call must carry.
 *
 * @param {object} runtime - Real runtime instance.
 * @param {string} agentId - Launched agent id.
 * @returns {object} Frozen `AuthorityDescriptor`.
 */
function agentAuthority(runtime, agentId) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity(agentId);
  assert.ok(identity && identity.authority, `'${agentId}' must expose a frozen authority descriptor`);
  return identity.authority;
}

/**
 * Reads a timer's lifecycle status through the engine-level export surface
 * (independent of `listSchedules` principal visibility scoping).
 *
 * @param {object} runtime - Real runtime instance.
 * @param {string} timerId - Timer id returned by `schedule()`.
 * @returns {string|null} Scheduler status, or `null` when unknown.
 */
function timerStatus(runtime, timerId) {
  const entry = runtime.exportSchedules().find((schedule) => (schedule.timerId || schedule.id) === timerId);
  return entry ? entry.status : null;
}

/** Flush window for host-timer expiry checks. */
const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 1. Early cancellation through the live composition root
// ============================================================================

test('1. a realm-bound broadcast cannot early-cancel a foreign realm timer (live wiring)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'r1_agent', realmId: 'R1', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'r1_peer', realmId: 'R1', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'r2_agent', realmId: 'R2', allowedTools: ['read_file'] });
    const r1 = agentAuthority(runtime, 'r1_agent');
    const r2 = agentAuthority(runtime, 'r2_agent');

    const r1Timer = runtime.schedule(
      { agentId: 'r1_agent', prompt: 'R1 wake', durationSeconds: 60, timerCondition: 'any' },
      { principal: r1 }
    );
    const r2Timer = runtime.schedule(
      { agentId: 'r2_agent', prompt: 'R2 wake', durationSeconds: 60, timerCondition: 'any' },
      { principal: r2 }
    );
    assert.equal(r1Timer.success, true);
    assert.equal(r2Timer.success, true);
    assert.equal(timerStatus(runtime, r1Timer.timerId), 'pending');
    assert.equal(timerStatus(runtime, r2Timer.timerId), 'pending');

    const broadcast = runtime.messagingBus.sendMessage({
      from: 'r1_agent',
      to: 'all',
      content: 'R1-only broadcast'
    });
    assert.equal(broadcast.success, true, 'the bus must deliver the same-realm broadcast');
    assert.equal(
      runtime.messagingBus.getUnreadCount('r2_agent'),
      0,
      'the realm-scoped bus confines fan-out to R1'
    );

    assert.equal(timerStatus(runtime, r1Timer.timerId), 'cancelled', 'the R1 broadcast early-cancels the R1 timer');
    assert.equal(
      timerStatus(runtime, r2Timer.timerId),
      'pending',
      'a foreign realm timer must never be early-cancelled by an R1 sender'
    );

    await delay(120);
    assert.equal(
      timerStatus(runtime, r2Timer.timerId),
      'pending',
      'the foreign realm timer stays pending after the sweep window'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Foreign schedule/cancel through the runtime API
// ============================================================================

test('2. foreign schedule/cancel through the runtime API deny; same-realm stays allowed', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = agentAuthority(runtime, 'director');
    await runtime.launchAgent({ id: 'r1_agent', realmId: 'R1', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'r1_peer', realmId: 'R1', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'r2_agent', realmId: 'R2', allowedTools: ['read_file'] });
    await runtime.launchAgent({
      config: { id: 'r1_lead', realmId: 'R1', privileged: true, allowedTools: ['*'] },
      principal: operator
    });
    const r1 = agentAuthority(runtime, 'r1_agent');
    const r1Lead = agentAuthority(runtime, 'r1_lead');
    const r2 = agentAuthority(runtime, 'r2_agent');

    // A realm-bound (even wildcard) caller cannot arm a foreign-realm timer.
    const foreign = runtime.schedule(
      { agentId: 'r2_agent', prompt: 'foreign wake', durationSeconds: 60 },
      { principal: r1Lead }
    );
    assert.equal(foreign.success, false, 'a realm-bound caller cannot schedule across the realm boundary');
    assert.equal(foreign.code, 'PERMISSION_DENIED');

    const armed = runtime.schedule(
      { agentId: 'r2_agent', prompt: 'R2 wake', durationSeconds: 60 },
      { principal: r2 }
    );
    assert.equal(armed.success, true);
    assert.equal(timerStatus(runtime, armed.timerId), 'pending');

    // Privileged agent authority never escapes its realm on destructive ops.
    const foreignCancel = runtime.cancelSchedule(armed.timerId, null, { principal: r1Lead });
    assert.equal(foreignCancel.success, false, 'a privileged realm-bound caller cannot cancel a foreign-realm timer');
    assert.equal(foreignCancel.code, 'PERMISSION_DENIED');
    assert.equal(timerStatus(runtime, armed.timerId), 'pending');

    // Same-realm targets remain fully functional.
    const sameRealm = runtime.schedule(
      { agentId: 'r1_peer', prompt: 'R1 peer wake', durationSeconds: 60 },
      { principal: r1 }
    );
    assert.equal(sameRealm.success, true);
    assert.equal(sameRealm.targetAgentId, 'r1_peer');
    const leadCleanup = runtime.cancelSchedule(sameRealm.timerId, 'same-realm cleanup', { principal: r1Lead });
    assert.equal(leadCleanup.success, true, 'a same-realm privileged cancel still works');

    // The denied foreign schedule armed nothing: exactly one foreign-owned timer exists.
    const r2Pending = runtime.exportSchedules().filter((entry) => entry.agentId === 'r2_agent' && entry.status === 'pending');
    assert.equal(r2Pending.length, 1);
    assert.equal(r2Pending[0].timerId, armed.timerId);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Agent-reachable schedule path
// ============================================================================

test('3. the schedule tool path carries the bound principal (defense in depth)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'r1_agent', realmId: 'R1', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'r2_agent', realmId: 'R2', allowedTools: ['read_file'] });
    const r1 = agentAuthority(runtime, 'r1_agent');
    const lifecyclePort = runtime.createLifecyclePort();
    const identityPort = runtime.createAgentIdentityPort();

    // The lifecycle port forwards the trusted caller context (F2): a realm-bound
    // principal cannot arm a foreign-realm timer through the agent-facing port.
    const denied = lifecyclePort.schedule(
      { agentId: 'r2_agent', prompt: 'port foreign wake', durationSeconds: 60 },
      { principal: r1 }
    );
    assert.equal(denied.success, false, 'the port must forward the trusted principal to the realm gate');
    assert.equal(denied.code, 'PERMISSION_DENIED');

    // The descriptor path pins its target to the dispatcher-bound caller and
    // forwards the bound principal with it; caller-supplied target params are inert.
    const sanitized = scheduleDescriptor.sanitize({
      action: 'create',
      prompt: 'tool path wake',
      delay_seconds: 60,
      agentId: 'r2_agent',
      targetAgentId: 'r2_agent'
    });
    const receipt = await scheduleDescriptor.handler(sanitized, {
      callerAgentId: 'r1_agent',
      lifecyclePort,
      identityPort
    });
    assert.equal(receipt.success, true);
    assert.equal(receipt.targetAgentId, 'r1_agent', 'the descriptor pins the target to the bound caller');

    const pending = runtime.exportSchedules().filter((entry) => entry.status === 'pending');
    assert.equal(pending.length, 1, 'the denied port call armed nothing; the tool path armed exactly one timer');
    assert.equal(pending[0].agentId, 'r1_agent');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 4. Legacy ungrouped parity
// ============================================================================

test('4. Generic realm parity: same-realm scheduling works and unresolved targets fail closed', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    // Wave R (ticket 56ba4b9): launches without an explicit realm resolve the
    // seeded Generic default, so Generic is the new shared default scope (the
    // null/ungrouped scope is reserved for the director/system bootstrap).
    await runtime.launchAgent({ id: 'generic_a', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'generic_b', allowedTools: ['read_file'] });
    const genericA = agentAuthority(runtime, 'generic_a');
    const genericB = agentAuthority(runtime, 'generic_b');

    // Same-realm cross-agent scheduling keeps the shared-contract behavior.
    const cross = runtime.schedule(
      { agentId: 'generic_b', prompt: 'generic cross-agent wake', durationSeconds: 60, timerCondition: 'any' },
      { principal: genericA }
    );
    assert.equal(cross.success, true);
    assert.equal(cross.targetAgentId, 'generic_b');

    // Same-realm early-cancel matching still applies. The sender is excluded
    // from its own fan-out, so no wake is enqueued here.
    runtime.messagingBus.sendMessage({ from: 'generic_a', to: 'all', content: 'generic broadcast' });
    assert.equal(timerStatus(runtime, cross.timerId), 'cancelled');

    // A target that resolves outside the caller's scope — including an
    // unresolvable/ungrouped id — fails closed for a Generic caller.
    const ghost = runtime.schedule(
      { agentId: 'generic_ghost', prompt: 'ghost wake', durationSeconds: 60, timerCondition: 'never' },
      { principal: genericA }
    );
    assert.equal(ghost.success, false, 'an unresolvable target never enters the queue');
    assert.equal(ghost.code, 'PERMISSION_DENIED');

    // A Generic timer still fires on expiry.
    const firing = runtime.schedule(
      { agentId: 'generic_b', prompt: 'generic expiry', durationSeconds: 0.05, timerCondition: 'never' },
      { principal: genericB }
    );
    assert.equal(firing.success, true);
    await delay(150);
    assert.equal(timerStatus(runtime, firing.timerId), 'triggered', 'Generic timers still fire');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 5. System-scope mail-trigger isolation (V20-F4, ticket af00a71)
// ============================================================================

test('5. a realm broadcast never early-cancels the director system-scope watchdog', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const director = agentAuthority(runtime, 'director');
    await runtime.launchAgent({ id: 'r1_agent', realmId: 'R1', allowedTools: ['read_file'] });

    const watchdog = runtime.schedule(
      { agentId: 'director', prompt: 'director watchdog', durationSeconds: 60, timerCondition: 'any' },
      { principal: director }
    );
    assert.equal(watchdog.success, true, 'the director may arm a system-scope watchdog');
    assert.equal(timerStatus(runtime, watchdog.timerId), 'pending');

    // A realm-bound broadcast must not satisfy the system-scope timer: the
    // director's reserved scope is unreachable from every non-bypass sender.
    const broadcast = runtime.messagingBus.sendMessage({
      from: 'r1_agent',
      to: 'all',
      content: 'realm chatter'
    });
    assert.equal(broadcast.success, true, 'the bus delivers the realm broadcast');
    assert.equal(
      timerStatus(runtime, watchdog.timerId),
      'pending',
      'a realm broadcast must never early-cancel a system-scope watchdog (V20-F4, af00a71)'
    );

    // One-way bypass: the director itself may still satisfy its own timer.
    runtime.messagingBus.sendMessage({ from: 'director', to: 'all', content: 'system standdown' });
    assert.equal(
      timerStatus(runtime, watchdog.timerId),
      'cancelled',
      'a bypass sender may satisfy a system-scope timer'
    );
  } finally {
    runtime.destroy();
  }
});
