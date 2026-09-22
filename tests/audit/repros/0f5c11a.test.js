/**
 * @file tests/audit/repros/0f5c11a.test.js
 * @description Audit repro for ticket 0f5c11a (Minor, area:docs):
 * `createProvider`'s vendor-string branch classifies the credential resolver by
 * property presence (`'getCredential' in optionsOrKeyStore`) instead of
 * callability, so a plain data property named `getCredential` makes the whole
 * options bag be discarded — contradicting the contract's duck-typing invariant
 * ("only an object exposing that method is treated as the injected
 * `CredentialResolverPort`; other objects are options bags or ignored") and
 * disagreeing with the config-object branch's `typeof` check on the same input.
 *
 * Evidence: `src/lib/sandbox/inference/createProvider/index.ts` vendor-string branch
 * (`'getCredential' in ...`) versus the config-object branch
 * (`typeof ...getCredential === 'function'`).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/0f5c11a.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProvider } from '../../../src/lib/sandbox/inference/createProvider/index.ts';
import { OpenAIProvider } from '../../../src/lib/sandbox/inference/OpenAIProvider/index.ts';

test('0f5c11a: non-function `getCredential` is an options bag in the vendor-string form', () => {
  const provider = createProvider('custom', {
    getCredential: 42,
    apiUrl: 'https://x.example',
    apiKey: 'sk-test'
  });

  assert.ok(provider instanceof OpenAIProvider, 'a non-callable getCredential must not select the resolver path');
  assert.strictEqual(provider.id, 'custom');
  assert.strictEqual(provider.getEffectiveApiUrl(), 'https://x.example');
  assert.strictEqual(provider.getEffectiveApiKey(), 'sk-test');
});

test('0f5c11a: callable `getCredential` still classifies as a resolver and is ignored in the vendor-string form', () => {
  assert.throws(
    () => createProvider('custom', { getCredential: () => null, apiUrl: 'https://x.example' }),
    /requires a valid endpoint 'url'/
  );
});
