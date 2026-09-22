/**
 * @file tests/audit/repros/5b8bae1.test.js
 * @description Audit repro for ticket 5b8bae1 (Minor, area:docs):
 * `normalizeProviderId` runs its falsy check before `trim()`, so a
 * whitespace-only id normalizes to `''` although the contract documents an
 * empty-input fallback to `'runware'` and a whitespace-insensitive id.
 *
 * Evidence: `src/lib/sandbox/credentialVault/index.ts:116-121` — `if (!id) return
 * 'runware';` executes before `String(id).toLowerCase().trim();`, so `'   '`
 * is truthy, trims to `''`, and is returned as `''` (canonical id
 * `canonical_`, active-map key `''`).
 *
 * Contract pin: `credentialVault.d.ts` — "Empty/absent input falls back to
 * `'runware'`" and "@param id - Raw provider id (case/whitespace
 * insensitive)".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/5b8bae1.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CredentialVault,
  CREDENTIAL_VAULT_STORAGE_KEY,
  normalizeProviderId
} from '../../../src/lib/sandbox/credentialVault/index.ts';

test('5b8bae1: normalizeProviderId falls back to runware for whitespace-only input', () => {
  assert.strictEqual(normalizeProviderId('   '), 'runware', 'spaces-only id must fall back');
  assert.strictEqual(normalizeProviderId('\t\n '), 'runware', 'all-whitespace id must fall back');
  assert.strictEqual(normalizeProviderId(''), 'runware', 'empty id must fall back');
  assert.strictEqual(normalizeProviderId(null), 'runware', 'null id must fall back');
  assert.strictEqual(normalizeProviderId(undefined), 'runware', 'undefined id must fall back');
  assert.strictEqual(normalizeProviderId(' DeepSeek_Native '), 'deepseek', 'padded alias must resolve');
  assert.strictEqual(normalizeProviderId('  runware  '), 'runware', 'padded canonical id must resolve');
});

test('5b8bae1: whitespace-only provider lookup resolves the runware canonical entry', () => {
  const backing = new Map();
  const storage = {
    get: key => (backing.has(key) ? backing.get(key) : null),
    set: (key, value) => {
      backing.set(key, value);
    },
    remove: key => {
      backing.delete(key);
    }
  };
  const vault = new CredentialVault({ storage });

  const entries = vault.getCredentialsForProvider('   ');
  assert.strictEqual(entries.length, 1, 'lookup must lazily create one canonical entry');
  assert.strictEqual(entries[0].id, 'canonical_runware', 'canonical id must use the fallback provider');
  assert.strictEqual(entries[0].providerId, 'runware', 'entry provider id must be the fallback provider');

  const raw = JSON.parse(backing.get(CREDENTIAL_VAULT_STORAGE_KEY));
  assert.ok(!('' in raw.active), 'no empty active-map key may be persisted');
  assert.strictEqual(raw.active.runware, 'canonical_runware', 'the fallback provider must own the active pointer');
});
