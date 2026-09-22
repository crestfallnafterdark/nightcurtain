/**
 * @file tests/audit/repros/identity_reauthorize_bypass.test.js
 * @description Red-first audit repro for Wave I ticket c02d0b9 (lane I1-F):
 * `AgentLifecycleManager.reauthorizeAgent` must never compose the
 * `realmBypass` grant — not even for a lifecycle-authority caller (a wildcard
 * `'*'` agent descriptor or the exact injected internal principal).
 *
 * Target model (Wave I identity model — git-bug `c02d0b9`): `realmBypass` is a revocable
 * operator/engine GRANT, applied only through the engine bootstrap or the
 * operator grant/revoke API. `reauthorizeAgent` is a capability re-assertion
 * path: any input carrying the `realmBypass` key must fail closed with
 * `PERMISSION_DENIED` before any registry mutation, and an omitted key must
 * preserve the current grant state untouched.
 *
 * Red at HEAD 237c54ae: `reauthorizeAgent` accepts `{ realmBypass: true }`
 * from any lifecycle-authority descriptor and rebuilds the descriptor with the
 * grant, so a wildcard agent principal can flip its own scope grant
 * (`agentLifecycle/index.ts:1346-1352`). No in-repo caller reaches the method
 * today; the probe pins the latent escalation path shut.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/identity_reauthorize_bypass.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentLifecycleManager } from '../../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

/**
 * Exact injected engine principal for the fixture. Only this exact reference
 * is trusted for lifecycle authority; it is also the operator escalation path
 * that legitimately applies the `realmBypass` grant.
 */
const OPERATOR_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'i1f-reauthorize-operator' });

/**
 * Builds a headless real lifecycle manager with one active wildcard agent
 * (`privileged: true` → `allow: {'*'}`), whose frozen registry descriptor
 * holds lifecycle authority.
 *
 * @returns {Promise<{ lifecycle: AgentLifecycleManager, descriptor: object }>}
 */
async function createFixture() {
  const lifecycle = new AgentLifecycleManager({
    emit: { emit: () => {} },
    internalPrincipal: OPERATOR_PRINCIPAL
  });
  await lifecycle.launchAgent({
    config: { id: 'i1f_sudoer', name: 'I1F sudoer', privileged: true, allowedTools: ['*'] },
    principal: OPERATOR_PRINCIPAL
  });
  const descriptor = lifecycle.getAuthorityDescriptor('i1f_sudoer');
  assert.ok(descriptor, 'fixture: the wildcard agent must have a frozen registry descriptor');
  assert.equal(descriptor.allow.has('*'), true, 'fixture: the descriptor holds lifecycle authority');
  return { lifecycle, descriptor };
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

test('c02d0b9: reauthorizeAgent refuses to compose realmBypass (wildcard agent caller)', async () => {
  const { lifecycle, descriptor } = await createFixture();
  const before = lifecycle.getAuthorityInputs('i1f_sudoer');
  assert.equal(before.realmBypass, false, 'fixture: an ordinary privileged agent starts without the bypass grant');

  let denied = null;
  let returned = null;
  try {
    returned = lifecycle.reauthorizeAgent('i1f_sudoer', { realmBypass: true }, descriptor);
  } catch (err) {
    denied = err;
  }

  assert.equal(
    denied && denied.code,
    'PERMISSION_DENIED',
    `reauthorizeAgent must reject any realmBypass key fail-closed; got ${
      denied ? `denied ${describeError(denied)}` : `accepted and returned ${JSON.stringify(returned && returned.realmBypass)}`
    }`
  );
  assert.equal(
    lifecycle.getAuthorityInputs('i1f_sudoer').realmBypass,
    false,
    'the denied call must leave the grant state untouched'
  );
  const after = lifecycle.getAuthorityDescriptor('i1f_sudoer');
  assert.equal(after, descriptor, 'the denied call must not rebuild the registry descriptor');
  assert.equal(after.realmBypass, false, 'the denied call must not widen the descriptor scope grant');
  assert.equal(after.allow.has('*'), true, 'the denied call must not touch the capability axis');
});

test('c02d0b9: omitted realmBypass preserves an operator grant through reauthorizeAgent', async () => {
  const { lifecycle, descriptor } = await createFixture();

  // Legitimate escalation path: the exact injected operator principal applies
  // the grant through the dedicated API.
  lifecycle.grantRealmBypass('i1f_sudoer', { principal: OPERATOR_PRINCIPAL });
  assert.equal(
    lifecycle.getAuthorityInputs('i1f_sudoer').realmBypass,
    true,
    'fixture: the operator grant must land on the authority inputs'
  );

  // A capability-only reauthorize (no realmBypass key) preserves the grant.
  // The caller identity resolves through the registry, so the descriptor the
  // grant just rebuilt is picked up (the pre-grant capture is stale by design).
  lifecycle.reauthorizeAgent('i1f_sudoer', { allowedTools: ['read_file'] }, { callerAgentId: 'i1f_sudoer' });
  const after = lifecycle.getAuthorityDescriptor('i1f_sudoer');
  assert.ok(after, 'the reauthorized agent must stay resolvable');
  assert.equal(after.realmBypass, true, 'an omitted realmBypass key must preserve the operator grant');
  assert.equal(after.allow.has('read_file'), true, 'the capability update must land');
  assert.equal(after.allow.has('*'), false, 'the capability update must replace the wildcard capability');
});
