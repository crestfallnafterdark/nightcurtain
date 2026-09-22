/**
 * @file tests/audit/repros/adf6cf0.test.js
 * @description Audit repro for ticket adf6cf0 (Minor; MOD-21-A2): the authority
 * allow-set facade resolves a prototype method and binds it to the private
 * backing `Set` (`value.bind(target)`), so in-realm tampering with a
 * `Set.prototype` read method (`values`/`has`/`forEach`/…) captures the raw
 * backing collection as `this`. The registry descriptor is exploitable because
 * `principalHasLifecycleAuthority` trusts `allow.has('*')` on it.
 *
 * Expected: the facade is built over a frozen snapshot of the member names and
 * implements every read as an own closure, so patched `Set.prototype` methods
 * are never reached and can never receive the backing collection — for both
 * the lifecycle registry descriptor and `Agent#authority`.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/adf6cf0.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';

/**
 * Patches a `Set.prototype` read method for the duration of `fn`, recording
 * every `this` the patched method receives.
 *
 * @param {string|symbol} method
 * @param {() => void} fn
 * @returns {unknown[]} Recorded receivers
 */
function capturePrototypeReceivers(method, fn) {
  const original = Set.prototype[method];
  const receivers = [];
  Set.prototype[method] = function patched(...args) {
    receivers.push(this);
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    Set.prototype[method] = original;
  }
  return receivers;
}

test('adf6cf0: patched Set.prototype read methods cannot capture the registry backing set', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'bandit', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'victim' });
    const timer = runtime.schedule({ targetAgentId: 'victim', durationSeconds: 60, prompt: 'P' });

    const descriptor = runtime.createAgentIdentityPort().getAgentIdentity('bandit').authority;
    const allow = descriptor.allow;

    const valueReceivers = capturePrototypeReceivers('values', () => {
      try { [...allow.values()]; } catch (_) {}
    });
    const hasReceivers = capturePrototypeReceivers('has', () => {
      try { allow.has('read_file'); } catch (_) {}
    });
    const forEachReceivers = capturePrototypeReceivers('forEach', () => {
      try { allow.forEach(() => {}); } catch (_) {}
    });

    const receivers = [...valueReceivers, ...hasReceivers, ...forEachReceivers];
    for (const receiver of receivers) {
      assert.ok(
        !(receiver instanceof Set) || receiver === allow,
        'a patched prototype method must never receive the raw backing collection'
      );
      if (receiver && typeof receiver.add === 'function') receiver.add('*');
    }

    assert.strictEqual(allow.has('*'), false, 'the captured receiver cannot widen the allow-set');
    assert.strictEqual(allow.has('read_file'), true, 'the allow-set contents must be unchanged');

    assert.deepStrictEqual(
      runtime.listSchedules({ status: 'all' }, { principal: descriptor }).schedules,
      [],
      'the descriptor cannot list cross-agent schedules'
    );
    const cancellation = runtime.cancelSchedule(timer.timerId, null, { principal: descriptor });
    assert.strictEqual(cancellation.code, 'PERMISSION_DENIED', 'the descriptor cannot cancel cross-agent schedules');
    // The literal id is ordinary (Wave I, c02d0b9): the captured-receiver
    // descriptor may spawn it, but no privilege or bypass is conferred.
    const ordinary = await runtime.launchAgent({ config: { id: 'system' }, principal: descriptor });
    assert.strictEqual(ordinary.config.privileged, false, 'the descriptor cannot elevate through a literal id');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('system').realmBypass,
      false,
      'the descriptor cannot grant bypass'
    );
  } finally {
    runtime.destroy();
  }
});

test('adf6cf0: patched Set.prototype methods cannot capture the entity backing set', () => {
  const agent = new Agent({ id: 'entity_probe', allowedTools: ['read_file'] });
  const allow = agent.authority.allow;

  const valueReceivers = capturePrototypeReceivers('values', () => {
    try { [...allow.values()]; } catch (_) {}
  });
  const hasReceivers = capturePrototypeReceivers('has', () => {
    try { allow.has('read_file'); } catch (_) {}
  });
  const iteratorReceivers = capturePrototypeReceivers(Symbol.iterator, () => {
    try { [...allow]; } catch (_) {}
  });

  const receivers = [...valueReceivers, ...hasReceivers, ...iteratorReceivers];
  for (const receiver of receivers) {
    if (receiver && typeof receiver.add === 'function') receiver.add('*');
  }

  assert.strictEqual(allow.has('*'), false, 'the captured receiver cannot widen the entity allow-set');
  assert.strictEqual(allow.has('read_file'), true, 'the entity allow-set contents must be unchanged');
  assert.strictEqual(allow.size, 1, 'the entity allow-set size must be unchanged');
});
