/**
 * @file tests/audit/repros/18f43d6.test.js
 * @description Audit repro for ticket 18f43d6 (Major, area:security, MOD-21):
 * `AgentLifecycleManager.updateAgentConfig` reaches authority state through
 * dynamic dispatch — `agent.applyAuthorityConfig(authorityPatch,
 * this.#authorityChannel)` resolves the method from the entity's replaceable
 * `[[Prototype]]` and hands it the manager's opaque channel. A caller holding a
 * public entity reference substitutes the method (prototype replacement or an
 * own property) so it captures the channel, then calls the genuine
 * `Agent.prototype.applyAuthorityConfig` on any manager-owned entity to forge
 * `spawnedBy`/`creatorId`, which authorizes cross-agent kill/invoke.
 *
 * Expected: the manager never hands its channel to a dynamically-resolved
 * method, authority methods are non-writable/non-configurable, and the entity
 * `[[Prototype]]` slot cannot be replaced.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/18f43d6.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';

test('18f43d6: a replaced entity prototype must not intercept manager authority calls', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'victim' });
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;

    let captured = null;
    const hostile = Object.create(Agent.prototype);
    Object.defineProperty(hostile, 'applyAuthorityConfig', {
      value: function (_patch, channel) {
        captured = channel;
        return this;
      },
      writable: true,
      enumerable: true,
      configurable: true
    });

    const mallory = runtime.getAgent('mallory');
    let protoOutcome;
    try {
      Object.setPrototypeOf(mallory, hostile);
      protoOutcome = 'REPLACED';
    } catch (err) {
      protoOutcome = err?.constructor?.name || 'threw';
    }

    assert.notStrictEqual(protoOutcome, 'REPLACED', 'the public entity prototype must not be replaceable');

    // A capability edit routes an authority patch through the owner-controlled
    // channel without making mallory a sudoer (which would independently
    // authorize the peer kill below).
    runtime.updateAgentConfig('mallory', { allowedTools: ['read_file'] }, { principal: operator });
    assert.strictEqual(
      captured,
      null,
      'the manager authority channel must never be handed to a caller-substituted method'
    );

    if (captured) {
      Agent.prototype.applyAuthorityConfig.call(runtime.getAgent('victim'), { spawnedBy: 'mallory' }, captured);
    }
    assert.strictEqual(runtime.getAgent('victim').config.spawnedBy, null, 'victim parentage must stay intact');
    assert.throws(
      () => runtime.killAgent('victim', 'captured channel', { callerAgentId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a captured channel must not authorize a peer kill'
    );
    assert.ok(runtime.getAgent('victim'), 'the denied kill leaves the victim active');
  } finally {
    runtime.destroy();
  }
});

test('18f43d6: an own substituted applyAuthorityConfig cannot capture the channel', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;

    let captured = null;
    const mallory = runtime.getAgent('mallory');
    try {
      mallory.applyAuthorityConfig = function (_patch, channel) {
        captured = channel;
        return this;
      };
    } catch (_) {
      // A throwing write (non-extensible entity) is the fail-closed outcome.
    }

    runtime.updateAgentConfig('mallory', { allowedTools: ['read_file', 'list_files'] }, { principal: operator });

    assert.strictEqual(captured, null, 'the manager channel must not reach a caller-substituted method');
    assert.deepStrictEqual(
      runtime.getAgent('mallory').config.allowedTools,
      ['read_file', 'list_files'],
      'the operator capability edit still applies through the intrinsic'
    );
  } finally {
    runtime.destroy();
  }
});

test('18f43d6: authority methods cannot be replaced on Agent.prototype', () => {
  const originalApply = Agent.prototype.applyAuthorityConfig;
  const originalBind = Agent.prototype.bindAuthorityChannel;

  let replaced = false;
  try {
    Agent.prototype.applyAuthorityConfig = function () {
      throw new Error('substituted');
    };
    replaced = Agent.prototype.applyAuthorityConfig !== originalApply;
  } catch (_) {
    replaced = false;
  }
  try {
    Agent.prototype.bindAuthorityChannel = function () {
      return true;
    };
    if (!replaced) replaced = Agent.prototype.bindAuthorityChannel !== originalBind;
  } catch (_) {
    // A throwing write is the fail-closed outcome.
  }

  if (replaced) {
    Agent.prototype.applyAuthorityConfig = originalApply;
    Agent.prototype.bindAuthorityChannel = originalBind;
  }

  assert.strictEqual(replaced, false, 'authority methods must be non-writable/non-configurable');
});
