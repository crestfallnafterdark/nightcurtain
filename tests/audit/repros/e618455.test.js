/**
 * @file tests/audit/repros/e618455.test.js
 * @description Audit repro for ticket e618455 (Major; MOD-21 sub-issue 8):
 * `worldClock` grants full privilege from reserved caller ids (`system`/`admin`/
 * `director`) with no flag, and from caller-asserted `isAdmin`/`isPrivileged`
 * flags in the execution context (worldClock.js:268-274, pre-fix). The contract
 * documents only the flags, and reserved-id elevation is stated nowhere.
 *
 * Ratified MOD-21 W4 fix: authority resolves from the injected principal
 * (`identityPort` descriptor or the opaque `internalPrincipal` reference);
 * caller flags and reserved ids confer nothing; engine steps run through
 * private paths. The resolved privilege rule is documented in the contract.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/e618455.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldClock } from '../../../src/lib/sandbox/worldClock/index.ts';

function grantFor(subject) {
  return {
    id: subject,
    privileged: false,
    allowedTools: [],
    authority: {
      subject,
      kind: 'agent',
      allow: new Set(['clock:*']),
      visibility: 'all'
    }
  };
}

function denyingPort(agentId) {
  return { id: agentId, privileged: false, allowedTools: [] };
}

function operatorClock(extraOptions = {}) {
  return new WorldClock({
    autoSyncFs: false,
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'operator' ? grantFor('operator') : denyingPort(agentId))
    },
    ...extraOptions
  });
}

test('e618455: reserved caller id director cannot advance another partition', () => {
  const clock = new WorldClock({ autoSyncFs: false, initialSeconds: 0 });
  clock.advanceClock({ minutes: 5 }, { callerAgentId: 'agent_bob' });

  const res = clock.advanceClock({ minutes: 5, targetAgentId: 'agent_bob' }, { callerAgentId: 'director' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'PERMISSION_DENIED');
});

test('e618455: reserved caller id system cannot advance all partitions', () => {
  const clock = new WorldClock({ autoSyncFs: false, initialSeconds: 0 });

  const res = clock.advanceClock({ minutes: 5, all: true }, { callerAgentId: 'system' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'PERMISSION_DENIED');
});

test('e618455: reserved caller id admin cannot query another partition', () => {
  const clock = new WorldClock({ autoSyncFs: false, initialSeconds: 3600 });

  const state = clock.getTime({ targetAgentId: 'global' }, { callerAgentId: 'admin' });
  assert.equal(state.agentId, 'admin', 'reserved id must not select the global partition');
});

for (const flag of ['isAdmin', 'isPrivileged', 'privileged']) {
  test(`e618455: forged context {${flag}: true} cannot advance another partition`, () => {
    const clock = new WorldClock({ autoSyncFs: false, initialSeconds: 0 });
    clock.advanceClock({ minutes: 5 }, { callerAgentId: 'agent_bob' });

    const res = clock.advanceClock(
      { minutes: 5, targetAgentId: 'agent_bob' },
      { callerAgentId: 'agent_alice', [flag]: true }
    );
    assert.equal(res.success, false);
    assert.equal(res.code, 'PERMISSION_DENIED');
  });
}

test('e618455: forged context flags cannot select another partition on read', () => {
  const clock = new WorldClock({ autoSyncFs: false, initialSeconds: 3600 });

  const state = clock.getTime(
    { targetAgentId: 'agent_bob' },
    { callerAgentId: 'agent_alice', isAdmin: true, isPrivileged: true, privileged: true }
  );
  assert.equal(state.agentId, 'agent_alice');
});

test('e618455: an injected authority descriptor still grants cross-partition writes', () => {
  const clock = operatorClock({ initialSeconds: 0 });
  clock.advanceClock({ minutes: 5 }, { callerAgentId: 'agent_bob' });

  const res = clock.advanceClock({ minutes: 5, targetAgentId: 'agent_bob' }, { callerAgentId: 'operator' });
  assert.equal(res.success, true);
  assert.equal(res.agentId, 'agent_bob');
});

test('e618455: engine ticker still advances every partition without caller flags', () => {
  let tickHandler = null;
  const clock = new WorldClock({
    autoSyncFs: false,
    initialSeconds: 0,
    setInterval: (handler) => { tickHandler = handler; return 1; },
    clearInterval: () => {}
  });
  clock.advanceClock({ minutes: 1 }, { callerAgentId: 'agent_scout' });
  const before = clock.getTime().totalSeconds;

  clock.start({ intervalMs: 10, stepSeconds: 5 });
  assert.equal(typeof tickHandler, 'function');
  tickHandler();
  clock.stop();

  const after = clock.getTime().totalSeconds;
  assert.equal(after, before + 5, 'engine tick must advance the global partition');
  assert.equal(clock.getAllClocks({ callerAgentId: 'agent_scout' }).agent_scout.totalSeconds, 65);
});
