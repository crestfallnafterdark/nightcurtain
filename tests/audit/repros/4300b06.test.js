/**
 * @file tests/audit/repros/4300b06.test.js
 * @description Audit repro for ticket 4300b06 (Minor; MOD-21 W10-A): the
 * `ReadonlySet` authority facade (registry + entity) delegates its read
 * methods to patchable `Array.prototype` methods — `has()` uses
 * `members.includes`, `entries()` uses `members.map`, and
 * `values()`/`keys()`/iteration call `members[Symbol.iterator]`. In-realm
 * tampering with those methods re-opens the `adf6cf0` defect class: a patched
 * `Array.prototype.includes` makes every `allow.has('*')` return `true`, so the
 * registry-backed lifecycle gate treats any registered descriptor as a sudoer.
 *
 * Expected (ratified W10): every facade read is an own indexed closure over
 * the frozen member array with no prototype-method delegation; patched
 * `Array.prototype` methods can neither widen membership nor corrupt
 * iteration.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/4300b06.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';

/**
 * Runs `fn` with one `Array.prototype` method replaced and restores it in all cases.
 *
 * @param {string|symbol} method
 * @param {Function} replacement
 * @param {() => void} fn
 */
function withPatchedArrayMethod(method, replacement, fn) {
  const original = Array.prototype[method];
  Array.prototype[method] = replacement;
  try {
    fn();
  } finally {
    Array.prototype[method] = original;
  }
}

/**
 * Collects a facade iterator's values with an own `next()` loop (no array
 * iteration helpers, which may themselves be patched during the probe).
 *
 * @param {Iterator<any>} iterator
 * @returns {string[]}
 */
function drainIterator(iterator) {
  const drained = [];
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    drained[drained.length] = String(step.value);
  }
  return drained;
}

test('4300b06: patched Array.prototype.includes cannot widen the authority facade', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'victim' });

    const registryAllow = runtime.createAgentIdentityPort().getAgentIdentity('mallory').authority.allow;
    const entityAllow = new Agent({ id: 'entity_probe', allowedTools: ['read_file'] }).authority.allow;

    let registryWidened = null;
    withPatchedArrayMethod('includes', function patchedIncludes() { return true; }, () => {
      registryWidened = registryAllow.has('*');
    });
    let entityWidened = null;
    withPatchedArrayMethod('includes', function patchedIncludes() { return true; }, () => {
      entityWidened = entityAllow.has('*');
    });

    assert.strictEqual(registryWidened, false, 'a patched Array.prototype.includes must not widen the registry allow-set');
    assert.strictEqual(entityWidened, false, 'a patched Array.prototype.includes must not widen the entity allow-set');

    let gateOutcome = null;
    withPatchedArrayMethod('includes', function patchedIncludes() { return true; }, () => {
      try {
        runtime.updateAgentConfig('victim', { privileged: true }, { callerAgentId: 'mallory' });
        gateOutcome = 'applied';
      } catch (err) {
        gateOutcome = err?.code || 'threw';
      }
    });
    assert.strictEqual(gateOutcome, 'PERMISSION_DENIED', 'the registry-backed manager gate must stay default-deny');
    assert.strictEqual(runtime.getAgent('victim').config.privileged, false, 'the denied update must not land');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('victim').authority.allow.has('*'),
      false,
      'the victim descriptor must stay default-deny'
    );
  } finally {
    runtime.destroy();
  }
});

test('4300b06: patched Array.prototype iteration/map cannot corrupt facade reads', () => {
  const entityAllow = new Agent({ id: 'entity_probe', allowedTools: ['read_file'] }).authority.allow;

  let iterated = null;
  withPatchedArrayMethod(Symbol.iterator, function patchedIterator() {
    let emitted = false;
    const hostile = {
      next() {
        if (!emitted) {
          emitted = true;
          return { value: '*', done: false };
        }
        return { value: undefined, done: true };
      }
    };
    hostile[Symbol.iterator] = () => hostile;
    return hostile;
  }, () => {
    iterated = drainIterator(entityAllow.values());
  });
  assert.deepStrictEqual(iterated, ['read_file'], 'iteration must yield only the real member strings');

  let entriesIterated = null;
  withPatchedArrayMethod('map', function patchedMap() { return [['*', '*']]; }, () => {
    entriesIterated = drainIterator(entityAllow.entries());
  });
  assert.deepStrictEqual(entriesIterated, ['read_file,read_file'], 'entries() must not delegate to Array.prototype.map');

  assert.strictEqual(entityAllow.has('*'), false, 'the facade membership must be unchanged after tampering');
  assert.strictEqual(entityAllow.has('read_file'), true, 'the real member must remain reachable');
  assert.strictEqual(entityAllow.size, 1, 'the facade size must be unchanged after tampering');
});
