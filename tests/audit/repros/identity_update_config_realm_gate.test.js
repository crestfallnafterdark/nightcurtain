/**
 * @file tests/audit/repros/identity_update_config_realm_gate.test.js
 * @description Red-first audit repro for Wave I I2-V re-check residual R1
 * (MEDIUM, security; ticket d57cbc1): `updateAgentConfig` had no Realm-scope
 * gate, so an ordinary realm-bound caller rewrote a foreign Realm record's
 * `systemPrompt` by bare id and a wildcard Realm root rewrote one by canonical
 * identity key. The fix applies the same realm gate kill/restore/purge/cancel
 * use to every resolved agent principal (Realm wave A, ticket 3487c56).
 *
 * Red at HEAD 0bec0920 (pre-fix): the two cross-Realm updates below mutate the
 * foreign record (`PWNED-*` prompts land) instead of denying with
 * `PERMISSION_DENIED`. The positive controls (same-Realm, operator, host,
 * granted bypass, valid kill control) pass before and after.
 *
 * Run directly (not part of `npm test`):
 *   timeout 180 node tests/audit/repros/identity_update_config_realm_gate.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';

/** Realm of the updating realm-bound callers. */
const ALPHA = 'realm_g5r1_alpha';
/** Realm of the foreign records the callers must not reach. */
const BETA = 'realm_g5r1_beta';

/**
 * Deterministic in-memory model accepted by the store's launch path (repo
 * convention): no turn is driven here, so no request ever leaves the process.
 *
 * @param {string} output - Static assistant text.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `g5r1-model-${output}`,
    config: {},
    provider: {
      id: `g5r1-provider-${output}`,
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: `g5r1-model-${output}`, name: 'G5-R1 Model' }]
    },
    async *stream(options = {}) {
      if (typeof options.onChunk === 'function') options.onChunk(output);
      yield { type: 'text', content: output };
      yield { type: 'finish', finishReason: 'stop', content: output, reasoning: '', toolCalls: [] };
    },
    async complete() {
      return { role: 'assistant', content: output };
    }
  };
}

/**
 * Captures a synchronous call as `{ ok, value }` or `{ ok: false, code, message }`.
 *
 * @param {Function} fn - Thunk to execute.
 * @returns {{ ok: boolean, value?: unknown, code?: string, message?: string }} Outcome.
 */
function capture(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, code: err && err.code, message: String(err && err.message) };
  }
}

/**
 * Builds the two-Realm fixture: an ordinary and a wildcard caller in Alpha and
 * two records in Beta the callers must not reach across the gate.
 *
 * @returns {Promise<object>} Live fixture plus realm-exact identity projections.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  await store.ensureDirector();
  store.createRealm({ id: ALPHA, name: 'G5-R1 Alpha' });
  store.createRealm({ id: BETA, name: 'G5-R1 Beta' });

  await store.launchAgent(
    { id: 'alpha_lead', realmId: ALPHA, allowedTools: ['read_file'] },
    createDeterministicModel('g5r1-alpha-lead')
  );
  await store.launchAgent(
    { id: 'alpha_root', realmId: ALPHA, privileged: true, allowedTools: ['*'] },
    createDeterministicModel('g5r1-alpha-root')
  );
  await store.launchAgent(
    { id: 'beta_lead', realmId: BETA, allowedTools: ['read_file'] },
    createDeterministicModel('g5r1-beta-lead')
  );
  await store.launchAgent(
    { id: 'beta_root', realmId: BETA, privileged: true, allowedTools: ['*'] },
    createDeterministicModel('g5r1-beta-root')
  );

  const port = runtime.createAgentIdentityPort();
  return {
    runtime,
    store,
    operator: runtime.getOperatorPrincipal(),
    alphaLead: port.getAgentIdentity('alpha_lead', { realmId: ALPHA }),
    alphaRoot: port.getAgentIdentity('alpha_root', { realmId: ALPHA }),
    betaLead: port.getAgentIdentity('beta_lead', { realmId: BETA })
  };
}

test('d57cbc1 G5-R1: realm-bound callers cannot update a foreign Realm config', async () => {
  const fixture = await createFixture();
  const { runtime, store, alphaLead, alphaRoot, betaLead, operator } = fixture;
  try {
    assert.ok(alphaLead?.key && alphaRoot?.key && betaLead?.key, 'fixture: realm-exact projections resolve');

    // Control: the cross-Realm pair is genuinely cross-scope (kill is denied).
    const killDenied = capture(() => runtime.killAgent(betaLead.key, 'cross-realm control', {
      callerAgentId: alphaLead.id,
      callerKey: alphaLead.key
    }));
    assert.equal(killDenied.code, 'PERMISSION_DENIED', 'control: cross-Realm kill is denied');

    const before = runtime.getAgent(betaLead.key);
    const beforePrompt = before.config.systemPrompt;
    const beforeUpdatedAt = before.updatedAt;

    // Ordinary realm-bound caller, foreign bare id: the R1 repro path.
    const byBareId = capture(() => runtime.updateAgentConfig(
      'beta_lead',
      { systemPrompt: 'PWNED-BY-ALPHA-ORDINARY' },
      { callerAgentId: alphaLead.id, callerKey: alphaLead.key }
    ));
    assert.equal(byBareId.ok, false, `ordinary cross-Realm bare-id update must be denied: ${JSON.stringify(byBareId)}`);
    assert.equal(byBareId.code, 'PERMISSION_DENIED', 'the cross-Realm bare-id denial uses PERMISSION_DENIED');

    // Wildcard realm root, foreign canonical identity key.
    const byCanonicalKey = capture(() => runtime.updateAgentConfig(
      betaLead.key,
      { systemPrompt: 'PWNED-BY-ALPHA-CANONICAL' },
      { callerAgentId: alphaRoot.id, callerKey: alphaRoot.key }
    ));
    assert.equal(byCanonicalKey.ok, false, `wildcard cross-Realm canonical update must be denied: ${JSON.stringify(byCanonicalKey)}`);
    assert.equal(byCanonicalKey.code, 'PERMISSION_DENIED', 'the cross-Realm canonical denial uses PERMISSION_DENIED');

    // The foreign record is byte-for-byte untouched by both denials.
    assert.equal(runtime.getAgent(betaLead.key).config.systemPrompt, beforePrompt, 'the foreign systemPrompt is unchanged');
    assert.equal(runtime.getAgent(betaLead.key).updatedAt, beforeUpdatedAt, 'the foreign record is not marked updated');
    assert.equal(
      JSON.stringify(runtime.getAgent(betaLead.key).history).includes('PWNED'),
      false,
      'no denied prompt reaches the foreign history'
    );
    assert.ok(operator, 'fixture: the operator principal exists');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('d57cbc1 G5-R1: same-Realm, operator, host, and granted-bypass updates keep their semantics', async () => {
  const fixture = await createFixture();
  const { runtime, store, alphaLead, alphaRoot, betaLead, operator } = fixture;
  try {
    // Same-Realm self update (ordinary caller) succeeds and syncs history[0].
    const selfUpdate = capture(() => runtime.updateAgentConfig(
      alphaLead.key,
      { systemPrompt: 'self update' },
      { callerAgentId: alphaLead.id, callerKey: alphaLead.key }
    ));
    assert.equal(selfUpdate.ok, true, `same-Realm self update must succeed: ${JSON.stringify(selfUpdate)}`);
    assert.equal(runtime.getAgent(alphaLead.key).config.systemPrompt, 'self update');
    assert.equal(runtime.getAgent(alphaLead.key).history[0]?.content, 'self update', 'INV-CONFIG-SYNC still applies');

    // Same-Realm wildcard authority update of a peer still works.
    const peerUpdate = capture(() => runtime.updateAgentConfig(
      alphaLead.key,
      { name: 'Lead Renamed By Root' },
      { callerAgentId: alphaRoot.id, callerKey: alphaRoot.key }
    ));
    assert.equal(peerUpdate.ok, true, `same-Realm wildcard update must succeed: ${JSON.stringify(peerUpdate)}`);
    assert.equal(runtime.getAgent(alphaLead.key).name, 'Lead Renamed By Root');

    // The exact operator/internal principal spans scopes.
    const operatorUpdate = capture(() => runtime.updateAgentConfig(
      betaLead.key,
      { name: 'Renamed By Operator' },
      { principal: operator }
    ));
    assert.equal(operatorUpdate.ok, true, `operator cross-Realm update must succeed: ${JSON.stringify(operatorUpdate)}`);
    assert.equal(runtime.getAgent(betaLead.key).name, 'Renamed By Operator');

    // The principal-less host/API path keeps its legacy unscoped semantics.
    const hostUpdate = capture(() => runtime.updateAgentConfig(betaLead.key, { name: 'Renamed By Host' }));
    assert.equal(hostUpdate.ok, true, `host update must succeed: ${JSON.stringify(hostUpdate)}`);
    assert.equal(runtime.getAgent(betaLead.key).name, 'Renamed By Host');

    // A `realmBypass`-granted agent spans: the operator grant admits the
    // cross-Realm update, revocation restores the confinement.
    runtime.grantRealmBypass(alphaLead.key, { principal: operator });
    const grantedUpdate = capture(() => runtime.updateAgentConfig(
      betaLead.key,
      { name: 'Renamed By Granted Peer' },
      { callerAgentId: alphaLead.id, callerKey: alphaLead.key }
    ));
    assert.equal(grantedUpdate.ok, true, `granted-bypass cross-Realm update must succeed: ${JSON.stringify(grantedUpdate)}`);
    assert.equal(runtime.getAgent(betaLead.key).name, 'Renamed By Granted Peer');

    runtime.revokeRealmBypass(alphaLead.key, { principal: operator });
    const revokedUpdate = capture(() => runtime.updateAgentConfig(
      betaLead.key,
      { name: 'Renamed After Revoke' },
      { callerAgentId: alphaLead.id, callerKey: alphaLead.key }
    ));
    assert.equal(revokedUpdate.ok, false, 'the revoked peer is confined again');
    assert.equal(revokedUpdate.code, 'PERMISSION_DENIED', 'the post-revoke denial uses PERMISSION_DENIED');
    assert.equal(runtime.getAgent(betaLead.key).name, 'Renamed By Granted Peer', 'the revoked denial leaves the record untouched');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
