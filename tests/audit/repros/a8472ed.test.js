/**
 * @file tests/audit/repros/a8472ed.test.js
 * @description Audit repro for ticket a8472ed (Minor/latent; MOD-21 A3 final
 * re-audit, substrates leg — worldClock residual of the MOD-21 W8-D
 * tenant-administration fix; VFS analogue: c6e24c0).
 *
 * `WorldClock.exportSnapshot()`/`importSnapshot(snapshot)` accepted no
 * principal: any in-process caller could disclose every partition's clock and
 * event registry, and could atomically replace every partition's state, with
 * no `PERMISSION_DENIED` path. The ratified worldClock fix (MOD-21 W10-C)
 * mirrors the W8-D VFS design: both members are tenant administration and
 * default-deny anonymous callers, requiring the exact injected
 * `WorldClockOptions.internalPrincipal` reference (`context.principal`) or an
 * identity-port `AuthorityDescriptor` granting cross-partition authority; an
 * injected instance can receive the composition-root reference once via
 * `bindInternalPrincipal`.
 *
 * Red before the fix; green after.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/a8472ed.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldClock } from '../../../src/lib/sandbox/worldClock/index.ts';

const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'engine_sync' });

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

function operatorIdentityPort() {
  return {
    getAgentIdentity: (agentId) => (agentId === 'operator'
      ? grantFor('operator')
      : { id: agentId, privileged: false, allowedTools: [] })
  };
}

function victimClock(options = {}) {
  const clock = new WorldClock({ autoSyncFs: false, ...options });
  clock.advanceClock({ minutes: 90 }, { callerAgentId: 'agent_victim' });
  clock.registerEvent({ name: 'victim-secret-event' }, { callerAgentId: 'agent_victim' });
  return clock;
}

const MALLORY_SNAPSHOT = {
  agentClocks: { agent_victim: { totalSeconds: 0, date: 'Day 1' }, mallory: { totalSeconds: 999999 } },
  agentEvents: { agent_victim: [] }
};

test('a8472ed: anonymous exportSnapshot is denied and discloses no partition state', () => {
  const clock = victimClock();

  const result = clock.exportSnapshot();
  assert.equal(result.success, false, 'anonymous exportSnapshot must default-deny');
  assert.equal(result.code, 'PERMISSION_DENIED');
  assert.equal(result.agentClocks, undefined, 'denied export must not disclose partition clocks');
  assert.equal(result.agentEvents, undefined, 'denied export must not disclose partition events');
  assert.equal(result.events, undefined, 'denied export must not disclose the flattened event view');
});

test('a8472ed: anonymous importSnapshot is denied and leaves every partition intact', () => {
  const clock = victimClock();

  const receipt = clock.importSnapshot(MALLORY_SNAPSHOT);
  assert.equal(receipt.success, false, 'anonymous importSnapshot must default-deny');
  assert.equal(receipt.code, 'PERMISSION_DENIED');

  assert.equal(clock.getTime({}, { callerAgentId: 'agent_victim' }).totalSeconds, 5400, 'victim clock must be unchanged');
  assert.equal(clock.getTime({}, { callerAgentId: 'mallory' }).totalSeconds, 0, 'no injected partition may be created');
  assert.equal(clock.queryEvents({}, { callerAgentId: 'agent_victim' }).events.length, 1, 'victim events must be unchanged');
});

test('a8472ed: import denial precedes snapshot validation (no anonymous malformed-snapshot oracle)', () => {
  const clock = victimClock();

  assert.equal(clock.importSnapshot(null).code, 'PERMISSION_DENIED');
  assert.equal(clock.importSnapshot(null, { callerAgentId: 'mallory' }).code, 'PERMISSION_DENIED');
  assert.equal(clock.importSnapshot('not-a-snapshot').code, 'PERMISSION_DENIED');
});

test('a8472ed: caller-asserted flags and plain lookalike principals are denied on both members', () => {
  const clock = victimClock();
  const lookalike = { kind: 'internal', subject: 'engine_sync' };

  const contexts = [
    { principal: lookalike },
    { isAdmin: true, isPrivileged: true },
    { callerAgentId: 'system' },
    { callerAgentId: 'director', principal: lookalike }
  ];

  for (const context of contexts) {
    assert.equal(clock.exportSnapshot(context).code, 'PERMISSION_DENIED');
    assert.equal(clock.importSnapshot(MALLORY_SNAPSHOT, context).code, 'PERMISSION_DENIED');
  }

  assert.equal(clock.getTime({}, { callerAgentId: 'agent_victim' }).totalSeconds, 5400);
});

test('a8472ed: an identity-port operator descriptor authorizes export and import', () => {
  const source = victimClock({ identityPort: operatorIdentityPort() });
  const snapshot = source.exportSnapshot({ callerAgentId: 'operator' });

  assert.equal(snapshot.code, undefined, 'authorized export must return a snapshot, not a denial receipt');
  assert.equal(snapshot.agentClocks.agent_victim.totalSeconds, 5400);

  const target = victimClock({ identityPort: operatorIdentityPort() });
  const receipt = target.importSnapshot(snapshot, { callerAgentId: 'operator' });
  assert.equal(receipt.success, true, 'authorized import must hydrate');
  assert.equal(target.getTime({}, { callerAgentId: 'agent_victim' }).totalSeconds, 5400);
});

test('a8472ed: the exact injected internal principal reference authorizes; lookalikes do not', () => {
  const clock = victimClock({ internalPrincipal: INTERNAL_PRINCIPAL });

  const snapshot = clock.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.equal(snapshot.agentClocks.agent_victim.totalSeconds, 5400);

  const receipt = clock.importSnapshot(snapshot, { principal: INTERNAL_PRINCIPAL });
  assert.equal(receipt.success, true);

  const lookalike = { kind: 'internal', subject: 'engine_sync' };
  assert.equal(clock.exportSnapshot({ principal: lookalike }).code, 'PERMISSION_DENIED');
  assert.equal(clock.importSnapshot(snapshot, { principal: lookalike }).code, 'PERMISSION_DENIED');
});

test('a8472ed: bindInternalPrincipal binds the composition-root reference once for injected instances', () => {
  const clock = victimClock();

  assert.equal(clock.bindInternalPrincipal(INTERNAL_PRINCIPAL), true, 'the first valid object binds');
  assert.equal(clock.bindInternalPrincipal({ kind: 'internal', subject: 'lookalike' }), false, 'a second bind is refused');
  assert.equal(clock.bindInternalPrincipal(null), false, 'invalid candidates are rejected');

  const snapshot = clock.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.equal(snapshot.agentClocks.agent_victim.totalSeconds, 5400, 'the bound reference authorizes the engine path');
  assert.equal(clock.importSnapshot(snapshot, { principal: INTERNAL_PRINCIPAL }).success, true);
});
