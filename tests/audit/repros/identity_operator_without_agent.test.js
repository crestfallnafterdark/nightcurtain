/**
 * @file tests/audit/repros/identity_operator_without_agent.test.js
 * @description Red-first audit repro for Wave I ticket c02d0b9 (lane I1-R):
 * the host operator principal must authenticate operator actions with ZERO
 * agents in the sandbox — no director agent is required.
 *
 * Target model (Wave I identity model — git-bug `c02d0b9`): the operator is a first-class
 * host-side principal (exact-reference validated, spans realms), exposed to the
 * store through a runtime port. Store actions run under that principal, and
 * killing or never bootstrapping the director agent never breaks them.
 *
 * Red at HEAD 04114fa1: the store resolves its operator principal from the
 * bootstrapped `director` agent's registry descriptor
 * (`sandboxStore/index.svelte.ts` `#resolveOperatorPrincipal` → `OPERATOR_SUBJECT`),
 * so with `autoBootstrapDirector: false` every operator action default-denies:
 * the sudoer-only `emptyRecycleBin()` throws `PERMISSION_DENIED`, and a
 * privileged spawn is denied before any registration.
 *
 * The two probes are captured independently and asserted together, so the red
 * reports both denials instead of stopping at the first.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/identity_operator_without_agent.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERIC_REALM_ID,
  createSandboxStore
} from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';

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

test('c02d0b9: operator actions work with zero agents (no director principal needed)', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    assert.equal(store.agents.length, 0, 'fixture: no director agent and no other agent at all');

    // Probe 1: sudoer-only recycle-bin purge, deterministic and side-effect-free
    // on an empty bin.
    let purgeError = null;
    let purged = null;
    try {
      purged = store.emptyRecycleBin();
    } catch (err) {
      purgeError = err;
    }

    // Probe 2: privileged spawn, the canonical operator-only lifecycle action.
    let launchError = null;
    let launched = null;
    try {
      launched = await store.launchAgent({
        id: 'ops_root',
        name: 'Ops Root',
        realmId: GENERIC_REALM_ID,
        privileged: true,
        allowedTools: ['*']
      });
    } catch (err) {
      launchError = err;
    }

    assert.equal(
      purgeError,
      null,
      `the sudoer-only purge must run under the host operator principal with zero agents; got ${describeError(purgeError)}`
    );
    assert.equal(purged, 0, 'an empty recycle bin purges zero agents');
    assert.equal(
      launchError,
      null,
      `a privileged spawn must run under the host operator principal with zero agents; got ${describeError(launchError)}`
    );
    assert.equal(launched.config.privileged, true, 'the operator-granted privilege must land on the launched agent');
    assert.equal(launched.config.realmId, GENERIC_REALM_ID, 'the operator principal can launch into a realm');
    assert.equal(store.agents.length, 1, 'exactly the operator-launched agent exists — no director was bootstrapped');
  } finally {
    store.destroy();
  }
});
