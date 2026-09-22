import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';
import { loadEnvFiles } from '../test_env.js';
import { InferenceError, NanoGptProvider, withRetry } from '../../src/lib/sandbox/inference/index.ts';

loadEnvFiles();

const NANO_KEY = process.env.NANO_TEST_API_KEY || process.env.NANOGPT_API_KEY;

const sampleTools = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get current UTC time',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string' }
        },
        required: ['timezone']
      }
    }
  }
];

test('NanoGptProvider exhaustive unit test suite', async (t) => {
  if (!NANO_KEY) {
    t.skip('Skipping live NanoGPT tests: NANO_TEST_API_KEY is not set');
    return;
  }

  const provider = new NanoGptProvider({ apiKey: NANO_KEY });
  const modelId = 'deepseek/deepseek-v4.1-flash';

  // Check if test key is valid upstream before running live requests
  const initialBalance = await provider.checkBalance();
  if (!initialBalance.available) {
    t.skip(`Skipping live NanoGPT completion tests: NANO_TEST_API_KEY is inactive or invalid upstream (${initialBalance.error})`);
    return;
  }

  await t.test('1. Provider metadata & properties', () => {
    assert.equal(provider.id, 'nanogpt');
  });

  await t.test('2. checkBalance() returns live USD balance from POST /api/check-balance', async () => {
    const balanceResult = await withRetry(() => provider.checkBalance(), { maxRetries: 3 });
    assert.equal(balanceResult.available, true, 'Balance should be available');
    assert.ok(typeof balanceResult.balance === 'number', 'Balance should be a number');
    assert.ok(balanceResult.balance >= 0, 'Balance should be non-negative');
    assert.equal(balanceResult.currency, 'USD');
    assert.ok(balanceResult.formatted && balanceResult.formatted.startsWith('$'), 'Formatted balance should start with $');
    assert.ok(balanceResult.raw && balanceResult.raw.usd_balance !== undefined);
  });

  await t.test('3. checkBalance() handles missing or invalid key gracefully', async () => {
    const badProvider = new NanoGptProvider({ apiKey: '' });
    const emptyResult = await badProvider.checkBalance();
    assert.equal(emptyResult.available, false);
    assert.equal(emptyResult.balance, null);
    assert.ok(emptyResult.error);

    const invalidProvider = new NanoGptProvider({ apiKey: 'invalid_nano_key_000' });
    const invalidResult = await invalidProvider.checkBalance();
    assert.equal(invalidResult.available, false);
    assert.equal(invalidResult.balance, null);
    assert.ok(invalidResult.error);
  });

  await t.test('4. checkBalance() respects AbortSignal cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User aborted'));
    const abortedResult = await provider.checkBalance({ signal: controller.signal });
    assert.equal(abortedResult.available, false);
    assert.ok(abortedResult.error);
  });

  await t.test('5. listModels() returns models parsed from distinct NanoGPT schema', async () => {
    const models = await withRetry(() => provider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models) && models.length > 0);

    const target = models.find(m => m.id === modelId) || models[0];
    assert.ok(target.id);
    assert.ok(target.name);
    assert.ok(target.contextLength !== undefined, 'Model must have contextLength');
    assert.ok(typeof target.cost === 'string' && target.cost.length > 0, 'Model must have formatted cost string');
    assert.ok(Array.isArray(target.categories));
  });

  await t.test('6. getProviders() queries upstream routes from /api/models/:canonicalId/providers', async () => {
    const routes = await withRetry(() => provider.getProviders(modelId), { maxRetries: 3 });
    assert.ok(Array.isArray(routes));
    assert.ok(routes.length > 0, `Expected routes for ${modelId}, got 0`);

    const route = routes[0];
    assert.ok(route.id, 'Route should have provider id');
    assert.ok(route.name, 'Route should have provider name');
    assert.ok(route.status, 'Route should have status');
    assert.ok(route.contextLength !== undefined, 'Route should include contextLength if provided');
    assert.ok(typeof route.cost === 'string', 'Route should include cost string');
  });

  await t.test('7. getProviders() returns empty array when no modelId is provided', async () => {
    const routes = await provider.getProviders('');
    assert.ok(Array.isArray(routes));
    assert.equal(routes.length, 0);
  });

  await t.test('8. createModel() provisions model with default routing (no sub-provider override)', () => {
    const model = provider.createModel(modelId, {
      temperature: 0.7,
      maxTokens: 150
    });

    assert.equal(model.id, modelId);
    assert.equal(model.config.provider, undefined, 'Default routing must not pin a sub-provider');
    assert.equal(model.config.temperature, 0.7);
    assert.equal(model.config.maxTokens, 150);
  });

  await t.test('9. model.complete() executes completion with default routing', async () => {
    const model = provider.createModel(modelId, {
      maxTokens: 100,
      temperature: 0.1
    });

    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Say NANOGPT_OK' }]
    }), { maxRetries: 3 });

    assert.ok(result);
    assert.ok(typeof result.content === 'string');
    assert.ok(typeof result.reasoning === 'string');
    assert.match(
      (result.content + ' ' + result.reasoning).toUpperCase(),
      /NANOGPT_OK/,
      'Content or reasoning should contain NANOGPT_OK'
    );
    assert.ok(result.usage && result.usage.total_tokens > 0);
  });

  await t.test('10. model.complete() with tools triggers tool calling', async () => {
    const model = provider.createModel(modelId, {
      maxTokens: 200,
      temperature: 0.1
    });

    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Check UTC time using get_current_time.' }],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(result.finishReason, 'tool_calls');
    assert.ok(result.toolCalls.length > 0);
    const tc = result.toolCalls[0];
    assert.equal(tc.name, 'get_current_time');
    assert.ok(tc.id);
    assert.ok(tc.args && typeof tc.args === 'object');
  });

  await t.test('11. model.stream() streams chunks and emits terminal finish chunk', async () => {
    const model = provider.createModel(modelId, {
      maxTokens: 100,
      temperature: 0.1
    });

    const chunks = [];
    await withRetry(async () => {
      chunks.length = 0;
      const stream = model.stream({
        messages: [{ role: 'user', content: 'Say STREAM_PONG' }],
        onChunk: (c) => chunks.push(c)
      });

      for await (const chunk of stream) {
        assert.ok(chunk.type);
      }
    }, { maxRetries: 3 });

    assert.ok(chunks.length > 0);
    const finish = chunks.find(c => c.type === 'finish');
    assert.ok(finish);
    assert.ok(finish.usage);
  });

  await t.test('12. model.stream() respects AbortSignal cancellation', async () => {
    const model = provider.createModel(modelId, { maxTokens: 40 });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        for await (const _ of model.stream({
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal
        })) {}
      },
      /aborted/i
    );
  });

  await t.test('13. Vault Integration: NanoGptProvider resolves credentials dynamically from CredentialVault', async () => {
    const testVault = {
      credentials: new Map([
        ['cred_nanogpt_vault_test', {
          id: 'cred_nanogpt_vault_test',
          providerId: 'nanogpt',
          apiKey: NANO_KEY
        }]
      ]),
      getCredential(id) {
        return this.credentials.get(id) || null;
      },
      getActiveCredential(providerId) {
        for (const c of this.credentials.values()) {
          if (c.providerId === providerId) return c;
        }
        return null;
      }
    };

    const vaultProvider = new NanoGptProvider({
      credentialId: 'cred_nanogpt_vault_test',
      vault: testVault
    });

    const balance = await withRetry(() => vaultProvider.checkBalance(), { maxRetries: 3 });
    assert.equal(balance.available, true);
  });
});

test('NanoGptProvider surfaces InferenceError from its OpenAI-compatible fallback (offline, fetch mocked)', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = new NanoGptProvider({ apiKey: 'test-key' });
  await assert.rejects(
    () => provider.listModels(),
    err => {
      assert.ok(err instanceof InferenceError);
      assert.ok(err instanceof Error);
      assert.equal(err.status, 503);
      assert.equal(err.code, 'ERR_HTTP_503');
      assert.equal(err.retryable, true);
      return true;
    }
  );
});
