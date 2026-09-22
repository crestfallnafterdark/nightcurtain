/**
 * @file tests/audit/repros/identity_id_is_ordinary.test.js
 * @description Red-first audit repro for Wave I ticket c02d0b9 (lane I1-R):
 * the literal agent id is just an identifier — `director`, `admin`, and
 * `system` carry no reserved meaning.
 *
 * Target model (Wave I identity model — git-bug `c02d0b9`): principals are the auth unit; the
 * id is ordinary. Launching an agent named `director` (or `admin`/`system`)
 * into a realm must succeed, and its identity projection must carry
 * `realmBypass === false` with a non-null realm — never the bootstrap-only
 * system scope. The engine bootstrap still launches the root system director,
 * but as an ordinary agent with a hardcoded grant, not as a reserved name.
 *
 * Red at HEAD 04114fa1: the lifecycle reserved-identity namespace
 * (`runtime/agentLifecycle/index.ts` `RESERVED_AGENT_IDS` +
 * `isEngineBootstrapLaunch`) denies every such launch with
 * `PERMISSION_DENIED` — the loop below records those denials and fails on the
 * assertion, never on a crash.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/identity_id_is_ordinary.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

/** Literal ids the reserved namespace denies today; all must be ordinary. */
const ORDINARY_IDS = Object.freeze(['director', 'admin', 'system']);

/**
 * Closed-loopback model config for the launch fixture. No turn is ever run, so
 * no request leaves the process; zero mocks (real runtime, real store, real
 * provider construction).
 */
const OFFLINE_MODEL_CONFIG = Object.freeze({
  providerId: 'openai',
  modelId: 'identity-ordinary-id-probe',
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

test('c02d0b9: director/admin/system are ordinary realm ids — launch succeeds, no bypass, realm-bound', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  try {
    assert.equal(store.agents.length, 0, 'fixture: no bootstrapped director and no other agent');
    const realm = store.createRealm({ id: 'realm_i1_ordinary_ids', name: 'Ordinary Ids' });

    const failures = [];
    for (const id of ORDINARY_IDS) {
      try {
        await store.launchAgent({
          id,
          name: `Ordinary ${id}`,
          realmId: realm.id,
          allowedTools: ['read_file'],
          modelConfig: OFFLINE_MODEL_CONFIG
        });
      } catch (err) {
        failures.push(`'${id}' launch denied — ${describeError(err)}`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      'every literal id must launch as an ordinary realm member; the lifecycle reserved-id namespace is the defect'
    );

    const identityPort = runtime.createAgentIdentityPort();
    for (const id of ORDINARY_IDS) {
      const projection = identityPort.getAgentIdentity(id);
      assert.ok(projection, `'${id}' must resolve through the identity port after launch`);
      assert.equal(projection.realmBypass, false, `the literal id '${id}' must never carry the bypass grant`);
      assert.equal(projection.realmId, realm.id, `the literal id '${id}' must stay realm-bound`);
      assert.notEqual(
        projection.realmId,
        null,
        `the literal id '${id}' must never land in the bootstrap-only system scope (realmId null)`
      );
    }
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
