/**
 * @file tests/audit/repros/a464f2a.test.js
 * @description Audit repro for ticket a464f2a (Major, area:docs): the
 * `createProvider` config-object branch must be keyId-only — raw
 * `apiKey`/`encryptionKey` fields on an `AgentModelConfig` are never read or
 * forwarded, and the removed `testApiKey` export must not resurface on the
 * inference barrel.
 *
 * Evidence: `src/lib/sandbox/inference/createProvider/index.ts` config-object branch
 * read `modelConfig.apiKey`/`modelConfig.encryptionKey` and forwarded them as
 * the direct key/KEK while `ProviderInterface.d.ts` invariant 15 promised
 * "`keyId` references only — no raw secret material".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/a464f2a.test.js
 */

import '../../test_env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider } from '../../../src/lib/sandbox/inference/createProvider/index.ts';
import { OpenAIProvider } from '../../../src/lib/sandbox/inference/OpenAIProvider/index.ts';
import { PremProvider, resetPremEnclaveClient } from '../../../src/lib/sandbox/inference/PremProvider/index.ts';
import * as inference from '../../../src/lib/sandbox/inference/index.ts';

/** Resolver with no credential for the pinned keyId and no active credential. */
const nullResolver = {
  getCredential: () => null,
  getActiveCredential: () => null
};

test('a464f2a: raw apiKey on the config object never reaches the provider', () => {
  const provider = createProvider(
    {
      providerId: 'custom',
      keyId: 'deleted-key',
      modelId: 'repro-model',
      url: 'https://repro.example/v1',
      apiKey: 'sk-raw-config-key'
    },
    nullResolver
  );

  assert.ok(provider instanceof OpenAIProvider);
  assert.equal(
    provider.getEffectiveApiKey(),
    '',
    'a raw apiKey on the AgentModelConfig must not be forwarded to the adapter'
  );
});

test('a464f2a: raw encryptionKey on the config object never reaches the Prem adapter', () => {
  const rawKek = 'f'.repeat(64);
  const provider = createProvider(
    {
      providerId: 'prem',
      keyId: 'deleted-key',
      modelId: 'repro-model',
      apiKey: 'sk-raw-config-key',
      encryptionKey: rawKek
    },
    nullResolver
  );

  assert.ok(provider instanceof PremProvider);
  assert.notEqual(
    provider.getEffectiveClientKEK(),
    rawKek,
    'a raw encryptionKey on the AgentModelConfig must not be forwarded as the Prem client KEK'
  );
});

test('a464f2a/ruling-1: testApiKey is gone from the inference export surface', () => {
  assert.equal(typeof inference.testApiKey, 'undefined');
});

after(() => {
  resetPremEnclaveClient();
});
