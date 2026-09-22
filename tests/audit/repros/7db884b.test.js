/**
 * @file tests/audit/repros/7db884b.test.js
 * @description Audit repro for ticket 7db884b (Major; MOD-21 W10-A):
 * `AgentLifecycleManager.updateAgentConfig` reads the caller-supplied
 * `updatedConfig` object multiple times — once while computing the authority
 * gate and again while applying the update and rebuilding the registry
 * descriptor. A stateful `Proxy` answers `undefined` to the gate reads and the
 * authority value on the later reads, so an anonymous caller sets
 * `privileged: true`, grafts parentage, and mints the wildcard registry
 * descriptor. `Agent#updateConfig` has the same TOCTOU between its deny-filter
 * read and its spread.
 *
 * Expected (ratified W10): the caller input is snapshotted exactly once before
 * authorize + apply; gate and application read the same plain data, so a
 * stateful Proxy can never mint privilege.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/7db884b.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

/**
 * Builds the stateful TOCTOU proxy from the ticket: the authority fields answer
 * `undefined` to the first read (the gate) and the grant to later reads (apply).
 *
 * @param {string} parentId
 * @returns {Object}
 */
function buildStatefulGrantProxy(parentId) {
  let privilegedReads = 0;
  let parentageReads = 0;
  return new Proxy({ name: 'benign' }, {
    get(target, key) {
      if (key === 'privileged') {
        privilegedReads += 1;
        return privilegedReads > 1 ? true : undefined;
      }
      if (key === 'spawnedBy') {
        parentageReads += 1;
        return parentageReads > 1 ? parentId : undefined;
      }
      return target[key];
    },
    ownKeys: (target) => [...Reflect.ownKeys(target), 'privileged', 'spawnedBy'],
    getOwnPropertyDescriptor: (target, key) => (
      (key === 'privileged' || key === 'spawnedBy')
        ? {
          value: key === 'privileged' ? true : parentId,
          enumerable: true,
          configurable: true,
          writable: true
        }
        : Reflect.getOwnPropertyDescriptor(target, key)
    )
  });
}

test('7db884b: a stateful Proxy cannot TOCTOU the manager gate into granting privilege', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'victim' });

    const proxy = buildStatefulGrantProxy('mallory');
    assert.throws(
      () => runtime.updateAgentConfig('mallory', proxy, null),
      (err) => err?.code === 'PERMISSION_DENIED',
      'an anonymous caller with a stateful Proxy must be denied before any mutation'
    );

    const mallory = runtime.getAgent('mallory');
    assert.strictEqual(mallory.config.privileged, false, 'the proxy must not mint privilege');
    assert.deepStrictEqual(mallory.config.allowedTools, ['read_file'], 'the proxy must not widen capability');
    assert.strictEqual(mallory.config.spawnedBy, null, 'the proxy must not graft parentage');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').authority.allow.has('*'),
      false,
      'the registry descriptor must stay default-deny'
    );

    assert.throws(
      () => runtime.killAgent('victim', 'proxy-forged parentage', { callerAgentId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the proxy-forged parentage must not authorize a peer kill'
    );
    assert.ok(runtime.getAgent('victim'), 'the denied kill leaves the victim active');
  } finally {
    runtime.destroy();
  }
});

test('7db884b: a stateful Proxy cannot TOCTOU the entity deny-filter', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });

    const proxy = buildStatefulGrantProxy('mallory');
    assert.throws(
      () => runtime.getAgent('mallory').updateConfig(proxy),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the entity channel must deny the stateful Proxy before mutation'
    );

    const mallory = runtime.getAgent('mallory');
    assert.strictEqual(mallory.config.privileged, false, 'the entity proxy must not mint privilege');
    assert.deepStrictEqual(mallory.config.allowedTools, ['read_file'], 'the entity proxy must not widen capability');
    assert.strictEqual(mallory.config.spawnedBy, null, 'the entity proxy must not graft parentage');
  } finally {
    runtime.destroy();
  }
});
