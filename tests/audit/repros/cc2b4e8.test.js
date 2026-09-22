/**
 * @file tests/audit/repros/cc2b4e8.test.js
 * @description Audit repro for ticket cc2b4e8 (Minor hardening, area:persistence):
 * `validateSandboxState` scanned only own keys for prototype-pollution markers,
 * then read the optional Wave U authority fields
 * (`candidate.templateAuthorityTrust` / `candidate.metaAuthorityGrants`)
 * through the prototype chain. A crafted object graph whose *prototype*
 * carried one of those records validated as `valid: true` with
 * `result.state === input`, so a composition-root seeding/restore pass that
 * read the field directly would pick up inherited operator intent.
 *
 * Evidence: `src/lib/sandbox/sandboxPersistence/index.ts` optional-field reads
 * after the own-key-only pollution scan, and
 * `src/lib/sandbox/sandboxStore/index.svelte.ts` seed/restore reads.
 *
 * Exact enforced claim after the fix: a prototype-carried
 * `templateAuthorityTrust`/`metaAuthorityGrants` never validates as operator
 * state (the snapshot is rejected, or the validated state exposes no such
 * record), while own-key records still round-trip and own-key `__proto__`
 * pollution still fails closed.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/cc2b4e8.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSandboxState } from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

/**
 * Builds the minimal valid snapshot body shared by every probe.
 *
 * @param {object} [extra] - Additional own top-level fields.
 * @returns {object} Candidate snapshot body.
 */
function persistedBody(extra = {}) {
  return { version: '1.0.0', timestamp: Date.now(), agents: [], recycleBin: [], ...extra };
}

/**
 * Runs one prototype-carried-field probe and asserts the inherited record
 * never surfaces as operator state.
 *
 * @param {string} field - Wave U authority field to hide on the prototype.
 * @param {object} value - Inherited authority record.
 * @returns {object} Validation result for further assertions.
 */
function assertPrototypeValueIsNotOperatorState(field, value) {
  const hostile = Object.create({ [field]: value });
  Object.assign(hostile, persistedBody());
  const result = validateSandboxState(hostile);
  const reachable = result.valid === true && field in result.state;
  assert.equal(
    reachable,
    false,
    `observed valid:${result.valid} reachable:${reachable} (state===input:${result.state === hostile})`
  );
  if (result.valid) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.state, field),
      false,
      `validated state must not own an inherited '${field}'`
    );
  }
  return result;
}

test('cc2b4e8: a prototype-carried templateAuthorityTrust never validates as operator trust', () => {
  assertPrototypeValueIsNotOperatorState('templateAuthorityTrust', {
    'audit-cc2b4e8': { architect: ['@template:authority'] }
  });
});

test('cc2b4e8: a prototype-carried metaAuthorityGrants never validates as operator grants', () => {
  assertPrototypeValueIsNotOperatorState('metaAuthorityGrants', {
    template: ['realm:ghost:audit-cc2b4e8-architect'],
    hydration: []
  });
});

test('cc2b4e8 control: own authority records still round-trip through validation', () => {
  const own = persistedBody({
    metaAuthorityGrants: { template: ['realm:r1:architect'], hydration: [] },
    templateAuthorityTrust: { 'audit-cc2b4e8': { architect: ['@template:authority'] } }
  });
  const result = validateSandboxState(own);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.state, own, 'a valid own-field snapshot must not force a copy');
  assert.deepEqual(result.state.metaAuthorityGrants, own.metaAuthorityGrants);
  assert.deepEqual(result.state.templateAuthorityTrust, own.templateAuthorityTrust);
});

test('cc2b4e8 control: own-key __proto__ pollution still fails closed', () => {
  const polluted = JSON.parse(`{
    "version": "1.0.0",
    "timestamp": ${Date.now()},
    "agents": [],
    "metaAuthorityGrants": { "__proto__": ["realm:r1:a"] }
  }`);
  const result = validateSandboxState(polluted);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'ERR_PERSISTENCE_PROTOTYPE_POLLUTION');
});
