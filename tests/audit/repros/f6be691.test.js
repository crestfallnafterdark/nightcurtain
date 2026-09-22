/**
 * @file tests/audit/repros/f6be691.test.js
 * @description Audit repro for ticket f6be691 (Major; MOD-21-A):
 * `purgeAgent`/`emptyRecycleBin`/`restoreAgent`/`unstickAgent`/`cancelAgent`/
 * `cancelAll`/`setAgentState` are ungated, so anonymous callers can bypass the
 * `killAgent` authority model in both directions — permanent destruction and
 * anonymous resurrection of a privileged identity.
 *
 * Ratified MOD-21 W8 fix: every lifecycle mutation requires a resolved
 * principal. Purge/empty-recycle/cancel-all are sudoer-only; restore of an
 * authority-bearing record requires lifecycle authority; state/cancel/unstick
 * allow sudoer, parent creator, or self. Engine paths (reset/destroy/snapshot
 * hydration, turn + history subsystems) run under the opaque internal
 * principal.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f6be691.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

function assertDenied(fn, label) {
  assert.throws(fn, (err) => err?.code === 'PERMISSION_DENIED', label);
}

test('f6be691: anonymous permanent destruction is denied without tearing down timers', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });
    const timer = runtime.schedule({ targetAgentId: 'victim', durationSeconds: 60, prompt: 'P' });

    assertDenied(() => runtime.purgeAgent('victim'), 'anonymous purge must be denied');
    assert.ok(runtime.getAgent('victim'), 'the denied purge must leave the victim active');
    const stillPending = runtime.listSchedules({ status: 'all' }, { callerAgentId: 'victim' }).schedules
      .some((s) => s.timerId === timer.timerId && s.status === 'pending');
    assert.ok(stillPending, 'the denied purge must not tear down the victim timer');

    assert.equal(runtime.purgeAgent('non-existent'), false, 'a miss stays a false receipt');
  } finally {
    runtime.destroy();
  }
});

test('f6be691: anonymous resurrection of a privileged identity is denied', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = { callerAgentId: 'director' };

    await runtime.launchAgent({ config: { id: 'ops', privileged: true }, principal: operator });
    runtime.killAgent('ops', 'operator kill', operator);

    assertDenied(() => runtime.restoreAgent('ops'), 'anonymous restore of a privileged record must be denied');
    assert.ok(runtime.getRecycledAgent('ops'), 'the denied restore leaves the record recycled');

    const restored = runtime.restoreAgent('ops', operator);
    assert.equal(restored.id, 'ops');
    const identity = runtime.createAgentIdentityPort().getAgentIdentity('ops');
    assert.equal(identity.authority.allow.has('*'), true, 'the operator restore re-grants the registry authority');
  } finally {
    runtime.destroy();
  }
});

test('f6be691: anonymous recycle-bin emptying and DoS operations are denied', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = { callerAgentId: 'director' };

    await runtime.launchAgent({ id: 'rec_a' });
    await runtime.launchAgent({ id: 'rec_b' });
    runtime.killAgent('rec_a', 'setup', operator);
    runtime.killAgent('rec_b', 'setup', operator);

    assertDenied(() => runtime.emptyRecycleBin(), 'anonymous recycle-bin emptying must be denied');
    assert.equal(runtime.listRecycledAgents().length, 2, 'the denied empty leaves both records');

    await runtime.launchAgent({ id: 'live_target' });
    assertDenied(() => runtime.unstickAgent('live_target'), 'anonymous unstick must be denied');
    assertDenied(() => runtime.cancelAgent('live_target'), 'anonymous cancel must be denied');
    assertDenied(() => runtime.cancelAll(), 'anonymous cancel-all must be denied');
    assertDenied(() => runtime.setAgentState('live_target', 'running'), 'anonymous state transition must be denied');

    assert.equal(runtime.getAgent('live_target').state, 'idle', 'denied mutations leave the target untouched');
    assert.equal(runtime.emptyRecycleBin(operator), 2, 'the operator may empty the recycle bin');
  } finally {
    runtime.destroy();
  }
});

test('f6be691: self and parent principals keep the non-destructive operations, engine paths keep working', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    const parent = await runtime.ensureDirector();
    await runtime.launchAgent({ config: { id: 'child', spawnedBy: 'director', creatorId: 'director' } });

    const stateReceipt = runtime.setAgentState('child', 'running', 'self probe', { callerAgentId: 'child' });
    assert.equal(stateReceipt.state, 'running', 'self may transition its own state');
    const cancelReceipt = runtime.cancelAgent('child', 'self probe', { callerAgentId: 'child' });
    assert.equal(cancelReceipt, true, 'self may cancel its own turn');

    runtime.setAgentState('child', 'idle', 'parent probe', { callerAgentId: 'director' });
    const unstuck = runtime.unstickAgent('child', 'parent unstick', { callerAgentId: 'director' });
    assert.equal(unstuck.success, true, 'the parent creator may unstick its child');

    await runtime.launchAgent({ id: 'rest_agent', spawnedBy: 'director', creatorId: 'director' });
    runtime.killAgent('rest_agent', 'parent recycle', { callerAgentId: 'director' });
    const restored = runtime.restoreAgent('rest_agent', { callerAgentId: 'director' });
    assert.equal(restored.id, 'rest_agent', 'the parent creator may restore an unprivileged child');

    runtime.reset();
    assert.equal(runtime.getAgentCount(), 0, 'engine reset still runs under the internal principal');
    assert.ok(parent, 'director bootstrap stays available');
  } finally {
    runtime.destroy();
  }
});

test('f6be691: a non-sudoer parent cannot restore an authority-bearing record', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = { callerAgentId: 'director' };

    await runtime.launchAgent({ id: 'parent', spawnedBy: 'director', creatorId: 'director' });
    await runtime.launchAgent({
      config: { id: 'priv_child', privileged: true, spawnedBy: 'parent', creatorId: 'parent' },
      principal: operator
    });
    runtime.killAgent('priv_child', 'setup', operator);

    assertDenied(
      () => runtime.restoreAgent('priv_child', { callerAgentId: 'parent' }),
      'a non-sudoer parent cannot restore a privileged record'
    );
    assert.ok(runtime.getRecycledAgent('priv_child'), 'the privileged record stays recycled');
  } finally {
    runtime.destroy();
  }
});

test('f6be691: anonymous caller-asserted flags never authorize lifecycle mutations', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });
    const forged = { isAdmin: true, isPrivileged: true, privileged: true, callerRole: 'system', callerAgentId: 'system' };

    assertDenied(() => runtime.purgeAgent('victim', forged), 'forged flags must not authorize purge');
    assertDenied(() => runtime.emptyRecycleBin(forged), 'forged flags must not authorize empty');
    assertDenied(() => runtime.cancelAll('forged', forged), 'forged flags must not authorize cancel-all');
    assertDenied(() => runtime.setAgentState('victim', 'running', null, forged), 'forged flags must not authorize state transitions');
    assert.ok(runtime.getAgent('victim'), 'the victim survives the forged matrix');
  } finally {
    runtime.destroy();
  }
});
