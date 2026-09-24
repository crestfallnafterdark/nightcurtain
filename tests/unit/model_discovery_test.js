/**
 * @file tests/unit/model_discovery_test.js
 * @description Unit suite for the Sandbox Settings modal discovery helpers
 * (ticket 8c7c1d9): `discoverModels()` model-listing normalization and typed
 * results, and `discoverRoutes()` nanogpt-only upstream route discovery.
 *
 * Offline by construction: the suite mocks `globalThis.fetch` and drives the
 * real `createProvider` adapters (no injected provider doubles), so the
 * NanoGPT `/api/models` catalog, the OpenAI-compatible `/v1/models` fallback,
 * and the `/api/models/:id/providers` route lookup are exercised as shipped.
 * Credentials resolve through a real-shaped `CredentialResolverPort` only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';

import { discoverModels, discoverRoutes } from '../../src/lib/components/sandbox/modelDiscovery.ts';

/** Canonical fake credential used across the suite; must never appear in output. */
const FAKE_CREDENTIAL = 'nano-discovery-credential-0123456789';

/**
 * Builds a `CredentialResolverPort`-shaped projection for the helpers.
 *
 * @param {string} [apiKey] Secret exposed as the provider's active credential.
 * @returns {{ getCredential: (id: string) => object | null, getActiveCredential: (providerId: string) => object | null }}
 */
function createResolverPort(apiKey = FAKE_CREDENTIAL) {
  const credential = Object.freeze({ id: 'cred_discovery_unit', apiKey });
  return {
    getCredential: (id) => (id === credential.id ? { ...credential } : null),
    getActiveCredential: () => ({ ...credential })
  };
}

/**
 * Installs a request-recording fetch mock for the duration of one test.
 *
 * @param {import('node:test').TestContext} t Node test context (for `t.after`).
 * @param {(url: string, init: object, call: number) => Promise<Response>} handler Mock transport.
 * @returns {Array<{ url: string, init: object }>} Captured call log (live array).
 */
function mockFetch(t, handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return calls;
}

/**
 * Builds a JSON `Response` with the canonical content type.
 *
 * @param {unknown} body JSON payload.
 * @param {number} [status] HTTP status.
 * @returns {Response} Mock response.
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('discoverModels: empty/failure results and no result secrets', async (t) => {
  await t.test('1. empty provider listings produce the typed empty-result error', async (t2) => {
    const calls = mockFetch(t2, async (url) => {
      if (url.endsWith('/api/models')) return jsonResponse({ models: { text: {} } });
      return jsonResponse({ data: [] });
    });

    const result = await discoverModels(
      { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' },
      createResolverPort()
    );

    assert.deepEqual(result, { ok: false, error: 'No models returned by endpoint.' });
    assert.equal(calls.length, 2, 'nanogpt must fall back to the OpenAI-compatible /v1/models listing');
  });

  await t.test('2. a provider failure resolves to a typed redacted error', async (t2) => {
    mockFetch(t2, async () => new Response(`invalid key ${FAKE_CREDENTIAL}`, { status: 401 }));

    const result = await discoverModels(
      { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' },
      createResolverPort()
    );

    assert.equal(result.ok, false, 'a rejected listing must not resolve ok');
    assert.match(result.error, /^OpenAI listModels error \(401\)/, 'the adapter error context must survive redaction');
    assert.ok(!result.error.includes(FAKE_CREDENTIAL), 'the resolved credential must never appear in an error result');
    assert.match(result.error, /\[redacted\]/, 'the credential must be replaced by the redaction marker');
  });

  await t.test('3. a non-Error rejection falls back to the legacy failure message', async (t2) => {
    mockFetch(t2, async () => {
      throw 'kaboom';
    });

    const result = await discoverModels(
      { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' },
      createResolverPort()
    );

    assert.deepEqual(result, { ok: false, error: 'Failed to list models.' });
  });
});

test('discoverModels: descriptor normalization through the real adapters', async (t) => {
  await t.test('4. string and descriptor entries normalize to {id, name, contextLength?} only', async (t2) => {
    const calls = mockFetch(t2, async (url) => {
      if (url.endsWith('/api/models')) {
        return jsonResponse({
          models: {
            text: {
              alpha: {
                model: 'alpha',
                name: 'Alpha Display',
                maxInputTokens: 128000,
                cost: 'In: $1/M • Out: $2/M'
              },
              beta: {
                name: 'Beta Display',
                context_length: 32000
              }
            }
          }
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await discoverModels(
      { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' },
      createResolverPort()
    );

    assert.deepEqual(result, {
      ok: true,
      models: [
        { id: 'alpha', name: 'Alpha Display', contextLength: '128k' },
        { id: 'beta', name: 'Beta Display', contextLength: '32k' }
      ]
    });
    assert.equal('cost' in result.models[0], false, 'provider metadata (cost/raw) must not leak through normalization');
    assert.equal(calls.length, 1, 'a populated NanoGPT catalog must not trigger the fallback listing');
    assert.match(String(calls[0].init.headers.Authorization), /^Bearer /, 'the active vault credential must authenticate discovery');
  });

  await t.test('5. duplicate model ids collapse to a single first-wins entry', async (t2) => {
    const calls = mockFetch(t2, async (url) => {
      if (url === 'https://nano-gpt.com/api/models') {
        return jsonResponse({
          models: {
            text: {
              'minimax-a': {
                model: 'minimax/minimax-m2.7',
                name: 'MiniMax M2.7 (first entry)',
                maxInputTokens: 200000
              },
              'minimax-b': {
                model: 'minimax/minimax-m2.7',
                name: 'MiniMax M2.7 (alias entry)',
                context_length: 64000
              },
              'other-entry': {
                model: 'other-model',
                name: 'Other Model'
              }
            }
          }
        });
      }
      if (url === 'http://localhost:11434/v1/models') {
        return jsonResponse({ data: ['string-dup', 'string-dup', 'string-unique'] });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const catalogResult = await discoverModels(
      { providerId: 'nanogpt', modelId: 'minimax/minimax-m2.7' },
      createResolverPort()
    );
    assert.deepEqual(catalogResult.models, [
      { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7 (first entry)', contextLength: '200k' },
      { id: 'other-model', name: 'Other Model' }
    ], 'the first duplicate catalog entry must win, keeping its name and context length');

    const stringResult = await discoverModels(
      { providerId: 'custom', url: 'http://localhost:11434/v1', modelId: 'string-dup' },
      createResolverPort()
    );
    assert.deepEqual(stringResult.models, [
      { id: 'string-dup', name: 'string-dup' },
      { id: 'string-unique', name: 'string-unique' }
    ], 'duplicate string entries must collapse to a single id');

    assert.equal(calls.length, 2);
    for (const result of [catalogResult, stringResult]) {
      assert.equal(result.ok, true);
      const ids = result.models.map((model) => model.id);
      assert.equal(new Set(ids).size, ids.length, 'discovered model ids must be unique for keyed rendering');
    }
  });

  await t.test('6. the custom provider draft URL drives the listing endpoint', async (t2) => {
    const calls = mockFetch(t2, async () => jsonResponse({ data: [{ id: 'llama3.2', name: 'Llama 3.2' }] }));

    const result = await discoverModels(
      { providerId: 'custom', url: 'http://localhost:11434/v1', modelId: 'llama3.2' },
      createResolverPort()
    );

    assert.deepEqual(result, { ok: true, models: [{ id: 'llama3.2', name: 'Llama 3.2' }] });
    assert.equal(calls[0].url, 'http://localhost:11434/v1/models', 'discovery must follow the passed custom endpoint');
  });
});

test('discoverRoutes: nanogpt-only, normalized, failures collapse to []', async (t) => {
  await t.test('7. nanogpt routes normalize to {id, name} without provider metadata', async (t2) => {
    const calls = mockFetch(t2, async (url) => {
      assert.match(url, /\/api\/models\/.+\/providers$/);
      return jsonResponse({
        providers: [
          { provider: 'fireworks', available: true, tps: 120.44, quantization: 'fp8' },
          { provider: 'deepinfra', available: false }
        ]
      });
    });

    const routes = await discoverRoutes(
      { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' },
      createResolverPort(),
      'deepseek/deepseek-v4.1-flash:thinking'
    );

    assert.deepEqual(routes, [
      { id: 'fireworks', name: 'fireworks' },
      { id: 'deepinfra', name: 'deepinfra' }
    ]);
    assert.equal('tps' in routes[0], false, 'route metadata must not leak through normalization');
    assert.equal(calls.length, 1);
  });

  await t.test('8. duplicate route ids collapse to a single first-wins entry', async (t2) => {
    mockFetch(t2, async (url) => {
      assert.match(url, /\/api\/models\/.+\/providers$/);
      return jsonResponse({
        providers: [
          { provider: 'neuralwatt', available: true, tps: 210.2 },
          { provider: 'neuralwatt', available: false },
          { provider: 'runware', available: true }
        ]
      });
    });

    const routes = await discoverRoutes(
      { providerId: 'nanogpt', modelId: 'minimax/minimax-m2.7' },
      createResolverPort(),
      'minimax/minimax-m2.7'
    );

    assert.deepEqual(routes, [
      { id: 'neuralwatt', name: 'neuralwatt' },
      { id: 'runware', name: 'runware' }
    ], 'the first duplicate route entry must win');
    const ids = routes.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length, 'discovered route ids must be unique for keyed rendering');
  });

  await t.test('9. non-nanogpt providers resolve [] without any request (stubbed adapters)', async (t2) => {
    const calls = mockFetch(t2, async () => {
      throw new Error('non-nanogpt providers must not perform route discovery');
    });

    const routes = await discoverRoutes(
      { providerId: 'runware', modelId: 'deepseek-v4-flash' },
      createResolverPort(),
      'deepseek-v4-flash'
    );

    assert.deepEqual(routes, []);
    assert.equal(calls.length, 0);
  });

  await t.test('10. blank model ids and failed route lookups resolve []', async (t2) => {
    const calls = mockFetch(t2, async () => new Response('upstream exploded', { status: 503 }));

    assert.deepEqual(await discoverRoutes({ providerId: 'nanogpt' }, createResolverPort(), '   '), []);
    assert.equal(calls.length, 0, 'a blank model id must not issue a request');

    const failed = await discoverRoutes(
      { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' },
      createResolverPort(),
      'deepseek/deepseek-v4.1-flash:thinking'
    );
    assert.deepEqual(failed, [], 'route failures collapse to an empty list');
    assert.equal(calls.length, 1);
  });
});
