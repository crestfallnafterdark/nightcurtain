/**
 * @file tests/audit/repros/identity_grantable_bypass.test.js
 * @description Red-first audit repro for Wave I ticket c02d0b9 (lane I1-R):
 * `realmBypass` must be a revocable OPERATOR GRANT, never an id-derived
 * property.
 *
 * Target model (Wave I identity model — git-bug `c02d0b9`):
 *  - `SandboxStore.grantRealmBypass(agentId)` / `revokeRealmBypass(agentId)`
 *    are user/operator actions; the runtime records the grant in the agent's
 *    frozen authority inputs and the identity projection reports `realmBypass`
 *    from that grant (never from the literal id).
 *  - The grant never moves realm membership (membership is immutable), it is
 *    per-agent (never ambient), and no agent-reachable spawn/update path may
 *    set it — agents cannot self-grant.
 *
 * Red at HEAD 04114fa1: the store exposes no grant/revoke surface at all, and
 * the only bypass source today is the `director` id plus the engine-composed
 * spec authority (`runtime/index.ts` `#isDirectorAuthorityTrusted`). The
 * surface assertions below therefore fail first as plain assertion failures —
 * never as a `TypeError` crash.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/identity_grantable_bypass.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERIC_REALM_ID,
  SandboxStore
} from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

/**
 * Closed-loopback model config for the launch fixture. No turn is ever run, so
 * no request leaves the process; the URL only pins the real OpenAI-compatible
 * adapter off vendor defaults. Zero mocks: real runtime, real store, real
 * provider construction.
 */
const OFFLINE_MODEL_CONFIG = Object.freeze({
  providerId: 'openai',
  modelId: 'identity-grant-probe',
  url: 'http://127.0.0.1:1/v1'
});

/**
 * Builds a store over an inspectable runtime with no bootstrapped director, so
 * the identity projection can be read directly and the grant is known to run
 * without the director agent.
 *
 * @returns {{ runtime: AgentRuntime, store: SandboxStore, identityPort: object }}
 */
function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  return { runtime, store, identityPort: runtime.createAgentIdentityPort() };
}

/**
 * One-line description of a caught error for assertion messages.
 *
 * @param {unknown} err - Caught value.
 * @returns {string} Human-readable error summary.
 */
function describeError(err) {
  if (!err) return 'none';
  if (typeof err === 'object') {
    return `${err.code || err.name || 'ERROR'}: ${err.message || String(err)}`;
  }
  return String(err);
}

test('c02d0b9: realmBypass is an operator grant — grant/revoke flip the identity projection', async () => {
  const { runtime, store, identityPort } = createFixture();
  try {
    assert.equal(store.agents.length, 0, 'fixture: no bootstrapped director and no agents at all');
    await store.launchAgent({
      id: 'r1_worker',
      name: 'Realm worker',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['read_file'],
      modelConfig: OFFLINE_MODEL_CONFIG
    });
    await store.launchAgent({
      id: 'r1_peer',
      name: 'Realm peer',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['read_file'],
      modelConfig: OFFLINE_MODEL_CONFIG
    });

    const before = identityPort.getAgentIdentity('r1_worker');
    assert.ok(before, 'the fixture agent must resolve through the identity port');
    assert.equal(before.realmBypass, false, 'an ordinary realm agent never starts with the bypass grant');
    assert.equal(before.realmId, GENERIC_REALM_ID, 'the fixture agent is realm-bound');

    // Surface guard: while the operator grant API is absent the red must be a
    // clear assertion failure, never a crash.
    assert.equal(
      typeof store.grantRealmBypass,
      'function',
      'SandboxStore must expose grantRealmBypass(agentId) as the operator bypass-grant action'
    );
    assert.equal(
      typeof store.revokeRealmBypass,
      'function',
      'SandboxStore must expose revokeRealmBypass(agentId) as the operator bypass-revocation action'
    );

    await store.grantRealmBypass('r1_worker');
    const granted = identityPort.getAgentIdentity('r1_worker');
    assert.ok(granted, 'the granted agent must stay resolvable');
    assert.equal(
      granted.realmBypass,
      true,
      'the operator grant must surface in the identity projection (authority inputs, never an id)'
    );
    assert.equal(granted.realmId, GENERIC_REALM_ID, 'the grant never moves realm membership (membership is immutable)');
    assert.equal(
      identityPort.getAgentIdentity('r1_peer').realmBypass,
      false,
      'the grant is per-agent, never ambient'
    );

    await store.revokeRealmBypass('r1_worker');
    const revoked = identityPort.getAgentIdentity('r1_worker');
    assert.ok(revoked, 'the revoked agent must stay resolvable');
    assert.equal(revoked.realmBypass, false, 'revocation must clear the projection');
    assert.equal(revoked.realmId, GENERIC_REALM_ID, 'revocation never moves realm membership');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('c02d0b9: no spawn/update path can set realmBypass (agents cannot self-grant)', async () => {
  const { runtime, store, identityPort } = createFixture();
  try {
    await store.launchAgent({
      id: 'r1_worker',
      name: 'Realm worker',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['read_file'],
      modelConfig: OFFLINE_MODEL_CONFIG
    });

    // Config update route: denied or ignored — never a grant.
    let updateError = null;
    try {
      store.updateAgentConfig('r1_worker', { realmBypass: true });
    } catch (err) {
      updateError = err;
    }
    const afterUpdate = identityPort.getAgentIdentity('r1_worker');
    assert.ok(afterUpdate, 'the updated agent must stay resolvable');
    assert.equal(
      afterUpdate.realmBypass,
      false,
      `updateAgentConfig must never set the bypass grant (update ${
        updateError ? `denied: ${describeError(updateError)}` : 'was accepted without granting'
      })`
    );

    // Spawn route: a launch-config claim is denied or ignored — never a grant.
    let spawnError = null;
    let spawned = null;
    try {
      spawned = await store.launchAgent({
        id: 'r1_forger',
        name: 'Realm forger',
        realmId: GENERIC_REALM_ID,
        realmBypass: true,
        allowedTools: ['read_file'],
        modelConfig: OFFLINE_MODEL_CONFIG
      });
    } catch (err) {
      spawnError = err;
    }
    const forger = spawned ? identityPort.getAgentIdentity('r1_forger') : null;
    assert.equal(
      forger ? forger.realmBypass : false,
      false,
      `the launch config must never set the bypass grant (spawn ${
        spawnError ? `denied: ${describeError(spawnError)}` : 'ignored the claim'
      })`
    );
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
