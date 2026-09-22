import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';
import { loadEnvFiles } from '../test_env.js';
import { InferenceError, PremProvider, withRetry } from '../../src/lib/sandbox/inference/index.ts';

loadEnvFiles();

const PREM_KEY = process.env.PREM_TEST_API_KEY || process.env.PREM_API_KEY;

const sampleTools = [
  {
    type: 'function',
    function: {
      name: 'get_system_status',
      description: 'Check enclave health and server status',
      parameters: {
        type: 'object',
        properties: {
          subsystem: { type: 'string' }
        },
        required: ['subsystem']
      }
    }
  }
];

test('PremProvider exhaustive unit test suite', async (t) => {
  if (!PREM_KEY) {
    t.skip('Skipping live Prem tests: PREM_TEST_API_KEY is not set');
    return;
  }

  const provider = new PremProvider({ apiKey: PREM_KEY });
  const modelId = 'deepseek-v4-flash-abliterated';

  await t.test('1. Provider metadata & properties', () => {
    assert.equal(provider.id, 'prem');
  });

  await t.test('2. getProviders() returns empty array for non-hub provider', async () => {
    const providers = await provider.getProviders();
    assert.ok(Array.isArray(providers));
    assert.equal(providers.length, 0);
  });

  await t.test('3. checkBalance() returns unsupported for enclave', async () => {
    const balance = await provider.checkBalance();
    assert.equal(balance.available, false);
    assert.equal(balance.balance, null);
  });

  await t.test('4. listModels() queries https://gateway.prem.io/rvenc/models and returns chat models', async () => {
    const models = await withRetry(() => provider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models) && models.length > 0);

    const ids = models.map(m => m.id);
    assert.ok(
      ids.includes('deepseek-v4-flash-abliterated'),
      `Expected models to include deepseek-v4-flash-abliterated, got: ${ids.join(', ')}`
    );

    const target = models.find(m => m.id === 'deepseek-v4-flash-abliterated');
    assert.ok(target.name);
    assert.ok(target.categories.includes('Confidential'));
  });

  await t.test('5. createModel() provisions properly configured Model instance', () => {
    const model = provider.createModel(modelId, {
      temperature: 0.7,
      maxTokens: 100,
      reasoningEffort: 'high'
    });

    assert.equal(model.id, modelId);
    assert.equal(model.config.temperature, 0.7);
    assert.equal(model.config.maxTokens, 100);
    assert.equal(model.config.reasoningEffort, 'high');
  });

  await t.test('6. model.complete() executes confidential enclave completion', async () => {
    const model = provider.createModel(modelId, { maxTokens: 120, temperature: 0.1 });
    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Say PREM_OK' }]
    }), { maxRetries: 3 });

    assert.ok(result);
    assert.ok(typeof result.content === 'string');
    assert.ok(typeof result.reasoning === 'string');
    const combined = (result.content + ' ' + result.reasoning).toUpperCase();
    assert.match(combined, /PREM_OK/, 'Should contain PREM_OK');
  });

  await t.test('7. model.complete() with tools triggers tool calling', async () => {
    const model = provider.createModel(modelId, { maxTokens: 200, temperature: 0.1 });
    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Check system status for enclave using get_system_status.' }],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(result.finishReason, 'tool_calls');
    assert.ok(result.toolCalls.length > 0);
    const tc = result.toolCalls[0];
    assert.equal(tc.name, 'get_system_status');
    assert.ok(tc.id);
    assert.ok(tc.args && typeof tc.args === 'object');
  });

  await t.test('8. model.stream() streams chunks and emits terminal finish chunk', async () => {
    const model = provider.createModel(modelId, { maxTokens: 120, temperature: 0.1 });
    const chunks = [];

    await withRetry(async () => {
      chunks.length = 0;
      const stream = model.stream({
        messages: [{ role: 'user', content: 'Say PREM_STREAM_OK' }],
        onChunk: (c) => chunks.push(c)
      });

      for await (const chunk of stream) {
        assert.ok(chunk.type);
      }
    }, { maxRetries: 3 });

    assert.ok(chunks.length > 0);
    const finish = chunks.find(c => c.type === 'finish');
    assert.ok(finish);
  });

  await t.test('9. model.stream() respects AbortSignal cancellation', async () => {
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

  await t.test('10. Enclave Client Singleton: Multiple PremProvider instances share exact same RvencClient', async () => {
    const p1 = new PremProvider({ apiKey: PREM_KEY });
    const p2 = new PremProvider({ apiKey: PREM_KEY });
    const client1 = await p1.getClient();
    const client2 = await p2.getClient();
    assert.strictEqual(client1, client2, 'Expected p1 and p2 to share identical singleton RvencClient reference');
  });

  await t.test('11. Vault Integration: PremProvider resolves credentials dynamically from CredentialVault', async () => {
    const testVault = {
      credentials: new Map([
        ['cred_prem_vault_test', {
          id: 'cred_prem_vault_test',
          providerId: 'prem',
          apiKey: PREM_KEY
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

    const vaultProvider = new PremProvider({
      credentialId: 'cred_prem_vault_test',
      vault: testVault
    });

    assert.equal(vaultProvider.getEffectiveApiKey(), PREM_KEY);
    const models = await withRetry(() => vaultProvider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models) && models.length > 0);
  });
});

test('PremProvider HTTP failures and payload hooks (offline, fetch mocked)', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const respond = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  await t.test('listModels() rejects with InferenceError on non-OK status', async () => {
    globalThis.fetch = async () => respond(503, { error: 'gateway down' });
    const provider = new PremProvider({ apiKey: 'test-key' });
    await assert.rejects(
      () => provider.listModels(),
      err => {
        assert.ok(err instanceof InferenceError, 'error must be an InferenceError');
        assert.ok(err instanceof Error, 'InferenceError must stay catch-compatible as Error');
        assert.equal(err.name, 'InferenceError');
        assert.equal(err.status, 503);
        assert.equal(err.code, 'ERR_HTTP_503');
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  await t.test('complete() honors transformPayload as the sole payload mutation hook', async () => {
    const payloads = [];
    const client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return {
              choices: [{ message: { content: 'PREM_OK', reasoning_content: 'why not' }, finish_reason: 'stop' }],
              usage: { total_tokens: 3 }
            };
          }
        }
      }
    };

    const provider = new PremProvider({ apiKey: 'test-key', client });
    const model = provider.createModel('prem-test-model', {
      temperature: 0.7,
      transformPayload: payload => ({ ...payload, vendor_extension: true })
    });

    const result = await model.complete({ messages: [{ role: 'user', content: 'ping' }] });

    assert.equal(result.content, 'PREM_OK');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].model, 'prem-test-model');
    assert.equal(payloads[0].temperature, 0.7);
    assert.equal(payloads[0].max_tokens, 100000);
    assert.equal(payloads[0].stream, false);
    assert.equal(payloads[0].vendor_extension, true);
  });

  await t.test('stream() applies transformPayload to the streaming payload', async () => {
    const payloads = [];
    const client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return (async function* () {
              yield { choices: [{ delta: { content: 'streamed' }, finish_reason: 'stop' }] };
            })();
          }
        }
      }
    };

    const provider = new PremProvider({ apiKey: 'test-key', client });
    const model = provider.createModel('prem-stream-model', {
      transformPayload: payload => ({ ...payload, stream_flag: 'on' })
    });

    for await (const _chunk of model.stream({ messages: [{ role: 'user', content: 'ping' }] })) {}

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].stream, true);
    assert.equal(payloads[0].stream_flag, 'on');
  });
});
