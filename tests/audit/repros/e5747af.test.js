/**
 * @file tests/audit/repros/e5747af.test.js
 * @description Audit repro for ticket e5747af (Major, area:docs, security):
 * `importCredentials` persists caller-supplied `baseUrl` verbatim, while the
 * contract states the vault is a pure `(keyId, secret)` store and that
 * `baseUrl` is dropped outright from entries and mutations.
 *
 * Evidence: `src/lib/sandbox/credentialVault/index.ts:224-225` (`addCredential`) and
 * `:254-255` (`updateCredential`) delete `fields.baseUrl`; `:446-458`
 * (`importCredentials`) pushes/replaces caller objects verbatim, so an imported
 * `baseUrl` survives into `getAllCredentials()`.
 *
 * Contract pin: `credentialVault.d.ts` @decision "The vault is a pure
 * `(keyId, secret)` store: `baseUrl` is dropped outright from entries and
 * mutations, with no migration (pre-release)" (`fba7587`) and the
 * `CredentialEntry` index-signature note.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/e5747af.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { CredentialVault } from '../../../src/lib/sandbox/credentialVault/index.ts';

function createVault() {
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
  return new CredentialVault({ storage });
}

test('e5747af: importCredentials drops baseUrl on new and overwritten entries', () => {
  const vault = createVault();

  vault.importCredentials([
    {
      id: 'cred_imported',
      providerId: 'custom',
      label: 'Imported',
      apiKey: 'sk-imported',
      createdAt: 1,
      lastUsed: null,
      baseUrl: 'http://evil.local'
    }
  ]);

  const created = vault.getAllCredentials().find(c => c.id === 'cred_imported');
  assert.ok(created, 'the imported entry must be persisted');
  assert.strictEqual(created.apiKey, 'sk-imported', 'the secret must survive the import');
  assert.ok(
    !('baseUrl' in created),
    'importCredentials must not persist baseUrl; the endpoint URL lives only in AgentModelConfig.url'
  );

  vault.importCredentials([
    {
      id: 'cred_imported',
      providerId: 'custom',
      label: 'Imported Again',
      apiKey: 'sk-imported-2',
      createdAt: 1,
      lastUsed: null,
      baseUrl: 'http://evil.local/2'
    }
  ]);

  const replaced = vault.getAllCredentials().find(c => c.id === 'cred_imported');
  assert.ok(replaced, 'the overwritten entry must be persisted');
  assert.strictEqual(replaced.apiKey, 'sk-imported-2', 'the overwrite must land');
  assert.ok(!('baseUrl' in replaced), 'importCredentials must drop baseUrl on overwrite too');
});
