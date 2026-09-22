import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';
import { loadEnvFiles } from '../test_env.js';
import { InferenceError, OpenAIProvider, withRetry } from '../../src/lib/sandbox/inference/index.ts';

loadEnvFiles();

const DEEPSEEK_KEY = process.env.DEEPSEEK_TEST_API_KEY || process.env.DEEPSEEK_API_KEY;

const sampleTools = [
  {
    type: 'function',
    function: {
      name: 'lookup_location_weather',
      description: 'Fetch current weather conditions for a given city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'Name of the city' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
        },
        required: ['city']
      }
    }
  }
];

test('OpenAIProvider comprehensive test suite with live DeepSeek endpoint', async (t) => {
  if (!DEEPSEEK_KEY) {
    t.skip('Skipping live DeepSeek tests: DEEPSEEK_TEST_API_KEY is not set');
    return;
  }

  const provider = new OpenAIProvider({
    apiUrl: 'https://api.deepseek.com/v1',
    apiKey: DEEPSEEK_KEY,
    id: 'deepseek'
  });

  let activeModelId = 'deepseek-v4-pro';

  await t.test('1. listModels() returns available models from endpoint', async () => {
    const models = await withRetry(() => provider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models), 'models should be an array');
    assert.ok(models.length > 0, 'models should not be empty');

    const modelIds = models.map(m => m.id);
    assert.ok(
      modelIds.includes('deepseek-v4-pro') || modelIds.includes('deepseek-flash'),
      `Expected models to contain deepseek model, got: ${modelIds.join(', ')}`
    );

    if (modelIds.includes('deepseek-v4-pro')) {
      activeModelId = 'deepseek-v4-pro';
    } else {
      activeModelId = modelIds[0];
    }
  });

  await t.test('2. complete() non-streaming chat completion with reasoning extraction', async () => {
    const model = provider.createModel(activeModelId, {
      maxTokens: 120,
      temperature: 0.1
    });

    const result = await withRetry(() => model.complete({
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: 'Output the exact word: PING' }
      ]
    }), { maxRetries: 3 });

    assert.ok(result, 'Result should exist');
    assert.ok(typeof result.content === 'string', 'result.content should be a string');
    assert.ok(result.content.trim().length > 0, 'result.content should not be empty');
    assert.match(result.content.toUpperCase(), /PING/, 'Content should contain PING');
    assert.ok(typeof result.reasoning === 'string', 'result.reasoning should be a string');
  });

  await t.test('3. stream() yields text/reasoning/finish chunks and returns CompletionResult', async () => {
    const model = provider.createModel(activeModelId, {
      maxTokens: 120,
      temperature: 0.1
    });

    const chunksReceived = [];
    await withRetry(async () => {
      chunksReceived.length = 0;
      const streamGen = model.stream({
        messages: [
          { role: 'system', content: 'You are a concise assistant.' },
          { role: 'user', content: 'Output the exact word: PONG' }
        ],
        onChunk: (c) => chunksReceived.push(c)
      });

      let yieldedChunks = 0;
      for await (const chunk of streamGen) {
        assert.ok(chunk.type, 'Chunk should have a type');
        yieldedChunks++;
      }

      assert.ok(yieldedChunks > 0, 'Should yield at least one chunk');
    }, { maxRetries: 3 });

    assert.ok(chunksReceived.length > 0, 'onChunk should have been called');

    const textChunks = chunksReceived.filter(c => c.type === 'text');
    const combinedText = textChunks.map(c => c.content).join('');
    assert.match(combinedText.toUpperCase(), /PONG/, 'Streamed content should contain PONG');

    const finishChunk = chunksReceived.find(c => c.type === 'finish');
    assert.ok(finishChunk, 'Stream should emit a terminal finish chunk');
    assert.ok(finishChunk.usage, 'Finish chunk should include token usage');
  });

  await t.test('4. complete() with tool calling invokes tool and parses arguments', async () => {
    const model = provider.createModel(activeModelId, {
      maxTokens: 200,
      temperature: 0.1
    });

    const result = await withRetry(() => model.complete({
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo right now? Call lookup_location_weather.' }
      ],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(result.finishReason, 'tool_calls', 'finishReason should be tool_calls');
    assert.ok(Array.isArray(result.toolCalls), 'result.toolCalls should be an array');
    assert.ok(result.toolCalls.length > 0, 'Should have invoked at least one tool');

    const tc = result.toolCalls[0];
    assert.equal(tc.name, 'lookup_location_weather', 'Tool name should match');
    assert.ok(tc.id && tc.id.length > 0, 'Tool call ID should be present');
    assert.ok(tc.args && typeof tc.args === 'object', 'Arguments should be parsed into object');
    assert.match(String(tc.args.city).toLowerCase(), /tokyo/, 'Tool args city should match Tokyo');
    assert.ok(typeof tc.rawArguments === 'string', 'rawArguments should be preserved');
  });

  await t.test('5. stream() with tool calling accumulates streaming tool arguments', async () => {
    const model = provider.createModel(activeModelId, {
      maxTokens: 200,
      temperature: 0.1
    });

    const streamChunks = [];
    await withRetry(async () => {
      streamChunks.length = 0;
      const streamGen = model.stream({
        messages: [
          { role: 'user', content: 'Check weather in London. Call lookup_location_weather.' }
        ],
        tools: sampleTools,
        onChunk: (c) => streamChunks.push(c)
      });

      for await (const _ of streamGen) {}
    }, { maxRetries: 3 });

    const toolChunks = streamChunks.filter(c => c.type === 'tool_call');
    assert.ok(toolChunks.length > 0, 'Stream should have emitted tool_call chunks');

    const finishChunk = streamChunks.find(c => c.type === 'finish');
    assert.ok(finishChunk, 'Finish chunk must be emitted');
    assert.equal(finishChunk.finishReason, 'tool_calls', 'Finish reason should be tool_calls');
    assert.ok(finishChunk.toolCalls.length > 0, 'Finish chunk should contain accumulated tool calls');

    const tc = finishChunk.toolCalls[0];
    assert.equal(tc.name, 'lookup_location_weather');
    assert.match(String(tc.args.city).toLowerCase(), /london/);
  });

  await t.test('6. Multi-turn conversation preserves past reasoning and handles tool execution return', async () => {
    const model = provider.createModel(activeModelId, {
      maxTokens: 250,
      temperature: 0.1
    });

    // Turn 1: Request tool execution
    const turn1Result = await withRetry(() => model.complete({
      messages: [
        { role: 'user', content: 'What is the weather in Berlin? Call lookup_location_weather.' }
      ],
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.equal(turn1Result.finishReason, 'tool_calls');
    const calledTool = turn1Result.toolCalls[0];

    // Turn 2: Feed back previous assistant message with past reasoning_content, tool_calls, and tool response
    const messagesTurn2 = [
      { role: 'user', content: 'What is the weather in Berlin? Call lookup_location_weather.' },
      {
        role: 'assistant',
        content: turn1Result.content || '',
        reasoning_content: turn1Result.reasoning,
        tool_calls: [
          {
            id: calledTool.id,
            type: 'function',
            function: {
              name: calledTool.name,
              arguments: calledTool.rawArguments || JSON.stringify(calledTool.args)
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: calledTool.id,
        content: JSON.stringify({ temperature: '18C', condition: 'Partly Cloudy' })
      }
    ];

    const turn2Result = await withRetry(() => model.complete({
      messages: messagesTurn2,
      tools: sampleTools
    }), { maxRetries: 3 });

    assert.ok(turn2Result.content.length > 0, 'Turn 2 should produce final text output');
    assert.match(turn2Result.content, /18|Cloudy|Berlin/i, 'Turn 2 text should incorporate tool response');
  });

  await t.test('7. Vault Integration: OpenAIProvider resolves credentials dynamically from CredentialVault', async () => {
    const testVault = {
      credentials: new Map([
        ['cred_openai_vault_test', {
          id: 'cred_openai_vault_test',
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

    const vaultProvider = new OpenAIProvider({
      apiUrl: 'https://api.deepseek.com/v1',
      credentialId: 'cred_openai_vault_test',
      vault: testVault
    });

    const models = await withRetry(() => vaultProvider.listModels(), { maxRetries: 3 });
    assert.ok(Array.isArray(models) && models.length > 0);
  });
});

test('OpenAIProvider HTTP failures raise InferenceError (offline, fetch mocked)', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const respond = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  const provider = new OpenAIProvider({
    apiUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    id: 'openai'
  });

  const assertInferenceError = (err, { status, retryable }) => {
    assert.ok(err instanceof InferenceError, 'error must be an InferenceError');
    assert.ok(err instanceof Error, 'InferenceError must stay catch-compatible as Error');
    assert.equal(err.name, 'InferenceError');
    assert.equal(err.status, status);
    assert.equal(err.code, `ERR_HTTP_${status}`);
    assert.equal(err.retryable, retryable);
    return true;
  };

  await t.test('complete() rejects with InferenceError on non-OK status', async () => {
    globalThis.fetch = async () => respond(500, { error: 'server exploded' });
    const model = provider.createModel('test-model');
    await assert.rejects(
      () => model.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      err => assertInferenceError(err, { status: 500, retryable: true })
    );
  });

  await t.test('stream() rejects with InferenceError on non-OK status', async () => {
    globalThis.fetch = async () => respond(429, { error: 'rate limited' });
    const model = provider.createModel('test-model');
    await assert.rejects(
      async () => {
        for await (const _chunk of model.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      },
      err => assertInferenceError(err, { status: 429, retryable: true })
    );
  });

  await t.test('listModels() rejects with InferenceError on non-OK status', async () => {
    globalThis.fetch = async () => respond(401, { error: 'unauthorized' });
    await assert.rejects(
      () => provider.listModels(),
      err => assertInferenceError(err, { status: 401, retryable: false })
    );
  });
});
