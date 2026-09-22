import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';
import { loadEnvFiles } from '../test_env.js';
import { DeepSeekProvider, InferenceError, withRetry } from '../../src/lib/sandbox/inference/index.ts';

loadEnvFiles();

const DEEPSEEK_KEY = process.env.DEEPSEEK_TEST_API_KEY || process.env.DEEPSEEK_API_KEY;

const sampleTools = [
  {
    type: 'function',
    function: {
      name: 'calculate_sum',
      description: 'Calculate the sum of two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' }
        },
        required: ['a', 'b']
      }
    }
  }
];

test('DeepSeekProvider exhaustive unit test suite', async (t) => {
  if (!DEEPSEEK_KEY) {
    t.skip('Skipping live DeepSeek tests: DEEPSEEK_TEST_API_KEY is not set');
    return;
  }

  const provider = new DeepSeekProvider({ apiKey: DEEPSEEK_KEY });
  let activeModelId = 'deepseek-flash';

  await t.test('1. Provider metadata & properties', () => {
    assert.equal(provider.id, 'deepseek');
  });

  await t.test('2. getProviders() returns empty array for non-hub provider', async () => {
    const providers = await provider.getProviders();
    assert.ok(Array.isArray(providers));
    assert.equal(providers.length, 0);
  });

  await t.test('3. checkBalance() returns account balance and currency info', async () => {
    const balanceResult = await withRetry(() => provider.checkBalance(), { maxRetries: 3 });
    assert.equal(balanceResult.available, true, 'Balance should be available');
    assert.ok(balanceResult.balance != null, 'Balance value should be present');
    assert.ok(typeof balanceResult.currency === 'string', 'Currency should be a string');
    assert.ok(balanceResult.formatted && (balanceResult.formatted.startsWith('$') || balanceResult.formatted.startsWith('¥')));
    assert.ok(balanceResult.raw && Array.isArray(balanceResult.raw.balance_infos));
  });

  await t.test('4. checkBalance() handles missing or invalid key gracefully', async () => {
    const badProvider = new DeepSeekProvider({ apiKey: '' });
    const emptyResult = await badProvider.checkBalance();
    assert.equal(emptyResult.available, false);
    assert.equal(emptyResult.balance, null);
    assert.ok(emptyResult.error);

    const invalidProvider = new DeepSeekProvider({ apiKey: 'sk-invalid-key-000000' });
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

  await t.test('6. listModels() returns available models and respects AbortSignal', async () => {
    const models = await withRetry(() => provider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models) && models.length > 0);
    const ids = models.map(m => m.id);
    assert.ok(ids.includes('deepseek-v4-pro') || ids.includes('deepseek-flash'));

    if (ids.includes('deepseek-flash')) {
      activeModelId = 'deepseek-flash';
    } else {
      activeModelId = ids[0];
    }

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () => provider.listModels({ signal: controller.signal }),
      /aborted/i
    );
  });

  await t.test('7. createModel() provisions properly configured Model instance', () => {
    const model = provider.createModel(activeModelId, {
      temperature: 0.2,
      maxTokens: 150,
      reasoningEffort: 'high'
    });

    assert.equal(model.id, activeModelId);
    assert.equal(model.config.temperature, 0.2);
    assert.equal(model.config.maxTokens, 150);
    assert.equal(model.config.reasoningEffort, 'high');
  });

  await t.test('8. model.complete() executes prose completion with reasoning', async () => {
    const model = provider.createModel(activeModelId, { maxTokens: 120, temperature: 0.1 });
    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Say HELLO' }]
    }), { maxRetries: 3 });

    assert.ok(result && result.content);
    assert.match(result.content.toUpperCase(), /HELLO/);
    assert.ok(typeof result.reasoning === 'string');
    assert.ok(result.usage && result.usage.total_tokens > 0);
    assert.equal(result.finishReason, 'stop');
  });

  await t.test('9. model.complete() with tools invokes tool call and parses arguments', async () => {
    const model = provider.createModel(activeModelId, { maxTokens: 200, temperature: 0.1 });
    const result = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Calculate 15 + 27 using calculate_sum.' }],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(result.finishReason, 'tool_calls');
    assert.ok(result.toolCalls.length > 0);
    const tc = result.toolCalls[0];
    assert.equal(tc.name, 'calculate_sum');
    assert.ok(tc.id);
    assert.equal(tc.args.a, 15);
    assert.equal(tc.args.b, 27);
    assert.ok(typeof tc.rawArguments === 'string');
  });

  await t.test('10. model.stream() streams chunks, reasoning, finish chunk, and onChunk callback', async () => {
    const model = provider.createModel(activeModelId, { maxTokens: 120, temperature: 0.1 });
    const chunks = [];

    await withRetry(async () => {
      chunks.length = 0;
      const stream = model.stream({
        messages: [{ role: 'user', content: 'Say STREAM_OK' }],
        onChunk: (c) => chunks.push(c)
      });

      for await (const chunk of stream) {
        assert.ok(chunk.type);
      }
    }, { maxRetries: 3 });

    assert.ok(chunks.length > 0);

    const text = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
    assert.match(text.toUpperCase(), /STREAM_OK/);

    const finish = chunks.find(c => c.type === 'finish');
    assert.ok(finish);
    assert.equal(finish.finishReason, 'stop');
    assert.ok(finish.usage);
  });

  await t.test('11. model.stream() with tools streams partial arguments and emits complete tool calls on finish', async () => {
    const model = provider.createModel(activeModelId, { maxTokens: 200, temperature: 0.1 });
    const chunks = [];

    await withRetry(async () => {
      chunks.length = 0;
      const stream = model.stream({
        messages: [{ role: 'user', content: 'Calculate 100 + 250 using calculate_sum.' }],
        tools: sampleTools,
        onChunk: (c) => chunks.push(c)
      });

      for await (const _ of stream) {}
    }, { maxRetries: 3 });

    const toolChunks = chunks.filter(c => c.type === 'tool_call');
    assert.ok(toolChunks.length > 0);

    const finish = chunks.find(c => c.type === 'finish');
    assert.ok(finish);
    assert.equal(finish.finishReason, 'tool_calls');
    assert.ok(finish.toolCalls.length > 0);
    assert.equal(finish.toolCalls[0].name, 'calculate_sum');
    assert.equal(finish.toolCalls[0].args.a, 100);
    assert.equal(finish.toolCalls[0].args.b, 250);
  });

  await t.test('12. model.stream() respects AbortSignal cancellation', async () => {
    const model = provider.createModel(activeModelId, { maxTokens: 120 });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        for await (const _ of model.stream({
          messages: [{ role: 'user', content: 'hello' }],
          signal: controller.signal
        })) {}
      },
      /aborted/i
    );
  });

  await t.test('13. Multi-turn conversation preserves past reasoning and tool returns', async () => {
    const model = provider.createModel(activeModelId, { maxTokens: 250, temperature: 0.1 });

    const turn1 = await withRetry(() => model.complete({
      messages: [{ role: 'user', content: 'Calculate 50 + 50 using calculate_sum.' }],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(turn1.finishReason, 'tool_calls');
    const called = turn1.toolCalls[0];

    const turn2 = await withRetry(() => model.complete({
      messages: [
        { role: 'user', content: 'Calculate 50 + 50 using calculate_sum.' },
        {
          role: 'assistant',
          content: turn1.content || '',
          reasoning_content: turn1.reasoning,
          tool_calls: [
            {
              id: called.id,
              type: 'function',
              function: {
                name: called.name,
                arguments: called.rawArguments || JSON.stringify(called.args)
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: called.id,
          content: JSON.stringify({ result: 100 })
        }
      ],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.ok(turn2.content.length > 0);
    assert.match(turn2.content, /100/);
  });

  await t.test('14. Vault Integration: DeepSeekProvider resolves credentials dynamically from CredentialVault', async () => {
    const testVault = {
      credentials: new Map([
        ['cred_deepseek_vault_test', {
          id: 'cred_deepseek_vault_test',
          providerId: 'deepseek',
          apiKey: DEEPSEEK_KEY
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

    const vaultProvider = new DeepSeekProvider({
      credentialId: 'cred_deepseek_vault_test',
      vault: testVault
    });

    const balance = await withRetry(() => vaultProvider.checkBalance(), { maxRetries: 3 });
    assert.equal(balance.available, true);
  });
});

test('DeepSeekProvider inherits InferenceError from the composed OpenAI adapter (offline, fetch mocked)', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const respond = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = new DeepSeekProvider({ apiKey: 'test-key' });

  await t.test('listModels() rejects with InferenceError on non-OK status', async () => {
    globalThis.fetch = async () => respond(502, { error: 'bad gateway' });
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

  await t.test('complete() rejects with InferenceError on non-OK status', async () => {
    globalThis.fetch = async () => respond(500, { error: 'server exploded' });
    const model = provider.createModel('deepseek-flash');
    await assert.rejects(
      () => model.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      err => {
        assert.ok(err instanceof InferenceError);
        assert.equal(err.status, 500);
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });
});
