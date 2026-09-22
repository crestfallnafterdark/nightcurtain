/**
 * @file tests/audit/repros/16a8489.test.js
 * @description Audit repro for ticket 16a8489 (Critical; MOD-21-A):
 * the authority allow-set wrapper binds `Set.prototype.forEach` to the mutable
 * backing set, so the callback's third argument leaks the raw `Set` and any
 * reader can widen the descriptor into a sudoer.
 *
 * Ratified MOD-21 W8 fix: no exposed method may hand out the backing
 * collection; `forEach` must pass a safe read-only view (the frozen facade
 * itself), and prototype-call mutation forms (`Set.prototype.*.call(allow)`)
 * must throw or be inert.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/16a8489.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

function readAllowViews(allow) {
  return {
    values: [...allow.values()],
    keys: [...allow.keys()],
    entries: [...allow.entries()],
    iterator: [...allow]
  };
}

test('16a8489: the allow-set never exposes its mutable backing collection', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'bandit', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'victim' });
    const timer = runtime.schedule({ targetAgentId: 'victim', durationSeconds: 60, prompt: 'P' });

    const descriptor = runtime.createAgentIdentityPort().getAgentIdentity('bandit').authority;
    const allow = descriptor.allow;

    // 1. Walk every read method and hostile prototype-call form, attempting
    //    to mutate whatever the API hands out.
    const hostileAttempts = [
      () => { allow.forEach((value, key, collection) => { try { collection.add('*'); } catch (_) {} }); },
      () => { allow.forEach((value, key, collection) => { try { collection.delete('read_file'); } catch (_) {} }); },
      () => { try { Set.prototype.forEach.call(allow, (value, key, collection) => { try { collection.add('*'); } catch (_) {} }); } catch (_) {} },
      () => { try { Set.prototype.add.call(allow, '*'); } catch (_) {} },
      () => { try { Set.prototype.delete.call(allow, 'read_file'); } catch (_) {} },
      () => { try { Set.prototype.clear.call(allow); } catch (_) {} },
      () => { try { allow.values().next().value?.add?.('*'); } catch (_) {} },
      () => { try { allow.keys().next().value?.add?.('*'); } catch (_) {} },
      () => { try { allow.entries().next().value?.add?.('*'); } catch (_) {} },
      () => { try { const iter = allow[Symbol.iterator](); iter.next().value?.add?.('*'); } catch (_) {} }
    ];
    for (const attempt of hostileAttempts) attempt();

    assert.equal(allow.has('*'), false, 'no exposed view may widen the allow-set');
    assert.equal(allow.has('read_file'), true, 'no exposed view may delete membership');
    assert.equal(allow.size, 1, 'the allow-set size is unchanged');

    // 2. The third forEach argument must be safe to keep: mutating it later
    //    must not reach the registry either.
    let thirdArgument = null;
    allow.forEach((value, key, collection) => { thirdArgument = collection; });
    assert.ok(thirdArgument, 'forEach still hands a third argument');
    try { thirdArgument.add?.('*'); } catch (_) {}
    assert.equal(allow.has('*'), false, 'the retained third argument is a safe view');

    // 3. Iteration still exposes the plain values (no collection recursion).
    assert.deepEqual(readAllowViews(allow), {
      values: ['read_file'],
      keys: ['read_file'],
      entries: [['read_file', 'read_file']],
      iterator: ['read_file']
    }, 'iteration yields only the member strings');

    // 4. End-to-end: the widened-descriptor exploit stays dead.
    assert.deepEqual(
      runtime.listSchedules({}, { principal: descriptor }).schedules,
      [],
      'the non-sudoer descriptor cannot list cross-agent schedules'
    );
    const cancellation = runtime.cancelSchedule(timer.timerId, null, { principal: descriptor });
    assert.equal(cancellation.code, 'PERMISSION_DENIED', 'the descriptor cannot cancel cross-agent schedules');
    assert.throws(
      () => runtime.killAgent('victim', 'hostile', { principal: descriptor }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the descriptor cannot kill a peer'
    );
    // The literal id is ordinary (Wave I, c02d0b9): the non-sudoer descriptor
    // may spawn it, but the denied expansion still confers no privilege or
    // bypass on the child.
    const ordinary = await runtime.launchAgent({ config: { id: 'system' }, principal: descriptor });
    assert.equal(ordinary.config.privileged, false, 'the descriptor cannot elevate through a literal id');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('system').realmBypass,
      false,
      'the descriptor cannot grant bypass'
    );
  } finally {
    runtime.destroy();
  }
});

test('16a8489: the frozen descriptor stays immutable through every prototype method', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    const allow = operator.allow;

    assert.ok(Object.isFrozen(operator), 'the descriptor stays frozen');
    assert.equal(typeof allow.add, 'undefined', 'mutators are not exposed');
    assert.equal(typeof allow.delete, 'undefined', 'mutators are not exposed');
    assert.equal(typeof allow.clear, 'undefined', 'mutators are not exposed');
    assert.throws(() => Set.prototype.add.call(allow, 'forged_tool'), TypeError, 'prototype add must throw');
    assert.throws(() => Set.prototype.clear.call(allow), TypeError, 'prototype clear must throw');
    assert.equal(allow.has('forged_tool'), false, 'the sudoer allow-set is unchanged');
    assert.equal(allow.has('*'), true, 'the sudoer wildcard remains');
  } finally {
    runtime.destroy();
  }
});
