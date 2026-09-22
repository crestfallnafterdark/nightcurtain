import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';
import { loadEnvFiles } from '../test_env.js';
import { InferenceError, RunwareProvider, withRetry } from '../../src/lib/sandbox/inference/index.ts';

loadEnvFiles();

const RUNWARE_KEY = process.env.RUNWARE_TEST_API_KEY || process.env.RUNWARE_API_KEY;

const sampleTools = [
  {
    type: 'function',
    function: {
      name: 'add_numbers',
      description: 'Add two numbers together',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' }
        },
        required: ['x', 'y']
      }
    }
  }
];

test('RunwareProvider exhaustive unit test suite', async (t) => {
  if (!RUNWARE_KEY) {
    t.skip('Skipping live Runware tests: RUNWARE_TEST_API_KEY is not set');
    return;
  }

  const provider = new RunwareProvider({ apiKey: RUNWARE_KEY });
  const modelId = 'deepseek-v4-flash';

  await t.test('1. Provider metadata & properties', () => {
    assert.equal(provider.id, 'runware');
  });

  await t.test('2. getProviders() returns empty array for non-hub provider', async () => {
    const providers = await provider.getProviders();
    assert.ok(Array.isArray(providers));
    assert.equal(providers.length, 0);
  });

  await t.test('3. checkBalance() extracts account balance and returns formatted USD', async () => {
    const balanceResult = await withRetry(() => provider.checkBalance(), { maxRetries: 3 });
    assert.equal(balanceResult.available, true, 'Balance should be available');
    assert.ok(typeof balanceResult.balance === 'number', 'Balance should be a number');
    assert.ok(balanceResult.balance >= 0, 'Balance should be non-negative');
    assert.equal(balanceResult.currency, 'USD');
    assert.ok(balanceResult.formatted && balanceResult.formatted.startsWith('$'), 'Formatted balance should start with $');
  });

  await t.test('4. checkBalance() handles missing or invalid key gracefully', async () => {
    const badProvider = new RunwareProvider({ apiKey: '' });
    const emptyResult = await badProvider.checkBalance();
    assert.equal(emptyResult.available, false);
    assert.equal(emptyResult.balance, null);
    assert.ok(emptyResult.error);

    const invalidProvider = new RunwareProvider({ apiKey: 'invalid_key_99999' });
    const invalidResult = await invalidProvider.checkBalance();
    assert.equal(invalidResult.available, false);
    assert.equal(invalidResult.balance, null);
    assert.ok(invalidResult.error);
  });

  await t.test('5. checkBalance() respects AbortSignal cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User aborted'));
    const abortedResult = await provider.checkBalance({ signal: controller.signal });
    assert.equal(abortedResult.available, false);
    assert.ok(abortedResult.error);
  });

  await t.test('6. listModels() returns available Runware models', async () => {
    const models = await withRetry(() => provider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models) && models.length > 0);
    const ids = models.map(m => m.id);
    assert.ok(
      ids.includes('deepseek-v4-1-flash') || ids.includes('deepseek-v4-flash') || ids.some(id => id.includes('deepseek')),
      `Expected Runware models to contain deepseek model, got count: ${ids.length}`
    );
  });

  await t.test('7. createModel() provisions properly configured Model instance', () => {
    const model = provider.createModel(modelId, {
      temperature: 0.7,
      maxTokens: 100,
      reasoningEffort: 'max'
    });

    assert.equal(model.id, modelId);
    assert.equal(model.config.temperature, 0.7);
    assert.equal(model.config.maxTokens, 100);
    assert.equal(model.config.reasoningEffort, 'max');
  });

  await t.test('8. model.complete() executes prose completion', async () => {
    const model = provider.createModel(modelId, { maxTokens: 40, temperature: 0.1 });
    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Say HELLO' }]
    }), { maxRetries: 3 });

    assert.ok(result && result.content);
    assert.match(result.content.toUpperCase(), /HELLO/);
    assert.ok(result.usage && result.usage.total_tokens > 0);
    assert.equal(result.finishReason, 'stop');
  });

  await t.test('9. model.complete() with tools invokes tool call and parses arguments', async () => {
    const model = provider.createModel(modelId, { maxTokens: 150, temperature: 0.1 });
    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Add 12 and 34 using add_numbers.' }],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(result.finishReason, 'tool_calls');
    assert.ok(result.toolCalls.length > 0);
    const tc = result.toolCalls[0];
    assert.equal(tc.name, 'add_numbers');
    assert.ok(tc.id);
    assert.equal(tc.args.x, 12);
    assert.equal(tc.args.y, 34);
    assert.ok(typeof tc.rawArguments === 'string');
  });

  await t.test('10. model.stream() streams chunks and emits terminal finish chunk', async () => {
    const model = provider.createModel(modelId, { maxTokens: 40, temperature: 0.1 });
    const chunks = [];

    await withRetry(async () => {
      chunks.length = 0;
      const stream = model.stream({
        messages: [{ role: 'user', content: 'Say STREAMING_OK' }],
        onChunk: (c) => chunks.push(c)
      });

      for await (const chunk of stream) {
        assert.ok(chunk.type);
      }
    }, { maxRetries: 3 });

    assert.ok(chunks.length > 0);
    const text = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
    assert.match(text.toUpperCase(), /STREAMING_OK/);

    const finish = chunks.find(c => c.type === 'finish');
    assert.ok(finish);
    assert.equal(finish.finishReason, 'stop');
    assert.ok(finish.usage);
  });

  await t.test('11. model.stream() respects AbortSignal cancellation', async () => {
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

  await t.test('12. Vault Integration: RunwareProvider resolves credentials dynamically from CredentialVault', async () => {
    const testVault = {
      credentials: new Map([
        ['cred_runware_vault_test', {
          id: 'cred_runware_vault_test',
          providerId: 'runware',
          apiKey: RUNWARE_KEY
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

    const vaultProvider = new RunwareProvider({
      credentialId: 'cred_runware_vault_test',
      vault: testVault
    });

    const balance = await withRetry(() => vaultProvider.checkBalance(), { maxRetries: 3 });
    assert.equal(balance.available, true);
  });
});

test('RunwareProvider inherits InferenceError from the composed OpenAI adapter (offline, fetch mocked)', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad gateway' }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = new RunwareProvider({ apiKey: 'test-key' });
  await assert.rejects(
    () => provider.listModels(),
    err => {
      assert.ok(err instanceof InferenceError);
      assert.ok(err instanceof Error);
      assert.equal(err.status, 502);
      assert.equal(err.code, 'ERR_HTTP_502');
      assert.equal(err.retryable, true);
      return true;
    }
  );
});
