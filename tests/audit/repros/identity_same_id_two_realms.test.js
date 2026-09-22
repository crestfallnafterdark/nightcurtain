/**
 * @file tests/audit/repros/identity_same_id_two_realms.test.js
 * @description Red-first audit repro for Wave I ticket d57cbc1 (lane I1-R
 * covering I2): agent identity is `(realmId, agentId)` internally, so the same
 * literal id must be launchable in two realms and resolve realm-locally.
 *
 * Target model (Wave I identity model — git-bug `d57cbc1`): `agentId` is realm-local and opaque;
 * same-realm duplicates stay denied while the same id in two realms is legal.
 * Realm-bound callers resolve bare ids in their own realm (no cross-realm
 * bleed); the two registrations are distinct agents.
 *
 * Red at HEAD 04114fa1: agent ids are sandbox-global map keys, so the second
 * `scout` launch is denied as a cross-realm duplicate (`AGENT_ALREADY_EXISTS`)
 * — the failures list below records it and the assertion fails. This repro is
 * EXPECTED TO STAY RED until I2 lands (I1 does not address id namespacing);
 * once I2 does, the realm-filtered listings and the same-realm port listings
 * must resolve each realm's own `scout` instance.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/identity_same_id_two_realms.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SandboxStore
} from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

/**
 * Closed-loopback model config for the launch fixture. No turn is ever run, so
 * no request leaves the process; zero mocks (real runtime, real store, real
 * provider construction).
 */
const OFFLINE_MODEL_CONFIG = Object.freeze({
  providerId: 'openai',
  modelId: 'identity-realm-local-probe',
  url: 'http://127.0.0.1:1/v1'
});

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

test('d57cbc1: the same literal id launches in two realms and resolves realm-locally', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  try {
    // The director is only the store's operator principal for the privileged
    // realm-root launches below; it is not part of the id-namespacing contract.
    await store.ensureDirector();
    const realmA = store.createRealm({ id: 'realm_i2_alpha', name: 'I2 Alpha' });
    const realmB = store.createRealm({ id: 'realm_i2_beta', name: 'I2 Beta' });

    // One privileged (sudoer) caller per realm: same-realm callers whose port
    // listings must resolve bare ids within their own realm.
    await store.launchAgent({
      id: 'alpha_root',
      name: 'Alpha Root',
      realmId: realmA.id,
      privileged: true,
      allowedTools: ['*'],
      modelConfig: OFFLINE_MODEL_CONFIG
    });
    await store.launchAgent({
      id: 'beta_root',
      name: 'Beta Root',
      realmId: realmB.id,
      privileged: true,
      allowedTools: ['*'],
      modelConfig: OFFLINE_MODEL_CONFIG
    });

    // The contract under test: the same literal id in both realms.
    const failures = [];
    for (const realm of [realmA, realmB]) {
      try {
        await store.launchAgent({
          id: 'scout',
          name: 'Scout',
          realmId: realm.id,
          allowedTools: ['read_file'],
          modelConfig: OFFLINE_MODEL_CONFIG
        });
      } catch (err) {
        failures.push(`${realm.id}: 'scout' launch denied — ${describeError(err)}`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      'the same literal agent id must launch independently in each realm (no cross-realm duplicate denial)'
    );

    // Each realm carries exactly its own registration of the shared id.
    const alphaScouts = runtime.listAgents({ realmId: realmA.id }).filter((agent) => agent.id === 'scout');
    const betaScouts = runtime.listAgents({ realmId: realmB.id }).filter((agent) => agent.id === 'scout');
    assert.equal(alphaScouts.length, 1, 'realm Alpha carries exactly one scout');
    assert.equal(betaScouts.length, 1, 'realm Beta carries exactly one scout');
    assert.notStrictEqual(alphaScouts[0], betaScouts[0], 'the two registrations are distinct agents');
    assert.equal(alphaScouts[0].config.realmId, realmA.id, 'the Alpha scout is bound to Alpha');
    assert.equal(betaScouts[0].config.realmId, realmB.id, 'the Beta scout is bound to Beta');

    // Bare-id resolution by a same-realm caller: each realm root resolves its
    // own scout and never the other realm's registration.
    const port = runtime.createLifecyclePort();
    const alphaView = port.listAgents({}, { callerAgentId: 'alpha_root' });
    const betaView = port.listAgents({}, { callerAgentId: 'beta_root' });
    const alphaScout = alphaView.find((agent) => agent.id === 'scout');
    const betaScout = betaView.find((agent) => agent.id === 'scout');
    assert.ok(alphaScout, 'the Alpha caller must resolve the bare id to its own realm registration');
    assert.ok(betaScout, 'the Beta caller must resolve the bare id to its own realm registration');
    assert.strictEqual(alphaScout, alphaScouts[0], 'the bare id must resolve realm-locally, never across realms');
    assert.strictEqual(betaScout, betaScouts[0], 'the bare id must resolve realm-locally, never across realms');
    assert.ok(!alphaView.some((agent) => agent.id === 'beta_root'), 'no cross-realm bleed into the Alpha view');
    assert.ok(!betaView.some((agent) => agent.id === 'alpha_root'), 'no cross-realm bleed into the Beta view');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
