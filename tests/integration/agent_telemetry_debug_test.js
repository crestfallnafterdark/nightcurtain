/**
 * @file tests/agent_telemetry_debug_test.js
 * @description Master Verification Suite for Agent Token Telemetry, Reset Actions, Context Debugging, and Persistence.
 * 
 * Verifies:
 * 1. Agent Creation: Telemetry initializes with zero counters and empty context for Director & spawned agents.
 * 2. Token Division & Accumulation: Single turn splits consumption into promptTokens and completionTokens and accumulates totalTokens.
 * 3. Multi-turn Accumulation: Multiple turns correctly accumulate cumulative inputTokens & outputTokens.
 * 4. Sent Context Tracking: agent.telemetry.lastSentContext stores exact formatted messages array sent to model.
 * 5. Telemetry Clear Action: clearAgentTelemetry resets counters to 0 and emits telemetry_reset event.
 * 6. Store Integration: sandboxStore.clearAgentTelemetry resets agent telemetry and updates reactive store.
 * 7. Persistence & Restore: serializeRuntimeEnvironment and restoreRuntimeEnvironment preserve telemetry across snapshots.
 * 8. Two-Tier Accounting: turns without provider usage record zero tokens (INV-4).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { serializeRuntimeEnvironment, restoreRuntimeEnvironment } from '../../src/lib/sandbox/sandboxPersistence/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';

function createMockModel(fn, modelId = 'test-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'test-provider',
      createModel: (mId) => createMockModel(fn, mId),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream(options = {}) {
      const bufferedChunks = [];
      const onChunk = (chunk) => {
        bufferedChunks.push(chunk);
        if (typeof options.onChunk === 'function') {
          try { options.onChunk(chunk); } catch (_) {}
        }
      };
      const res = await fn({ ...options, onChunk });

      if (bufferedChunks.length > 0) {
        for (const chunk of bufferedChunks) {
          yield chunk;
        }
      } else if (res && typeof res === 'object') {
        if (res.reasoning || res.reasoning_content) {
          yield { type: 'reasoning', reasoning: res.reasoning || res.reasoning_content, content: res.reasoning || res.reasoning_content };
        }
        if (res.content !== undefined || res.text !== undefined) {
          yield { type: 'text', content: res.content !== undefined ? res.content : res.text };
        }
      } else if (typeof res === 'string') {
        yield { type: 'text', content: res };
      }

      if (res && typeof res === 'object') {
        const toolCalls = res.tool_calls || res.toolCalls || [];
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          yield { type: 'tool_call', toolCalls };
        }
        const usage = res.usage || {
          prompt_tokens: res.promptTokens || 0,
          completion_tokens: res.completionTokens || 0,
          total_tokens: res.totalTokens || 0
        };
        yield {
          type: 'usage',
          usage
        };
        yield {
          type: 'finish',
          finishReason: res.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
          content: res.content !== undefined ? res.content : (res.text || ''),
          reasoning: res.reasoning || res.reasoning_content || '',
          toolCalls,
          usage
        };
      } else if (typeof res === 'string') {
        yield { type: 'finish', finishReason: 'stop', content: res, toolCalls: [] };
      }
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

test('1. Agent Creation: Telemetry initializes with zero counters and empty context', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus
  });

  // Check director
  const director = await runtime.ensureDirector();
  assert.ok(director, 'Director must exist');
  assert.ok(director.telemetry, 'Director must have telemetry initialized');
  assert.equal(director.telemetry.inputTokens, 0);
  assert.equal(director.telemetry.outputTokens, 0);
  assert.equal(director.telemetry.totalTokens, 0);
  assert.equal(director.telemetry.turnCount, 0);
  assert.equal(director.telemetry.lastPromptTokens, 0);
  assert.equal(director.telemetry.lastCompletionTokens, 0);
  assert.deepEqual(director.telemetry.lastSentContext, []);

  // Check spawned agent
  const scout = await runtime.launchAgent({
    id: 'scout_01',
    name: 'Scout Unit',
    role: 'explorer',
    systemPrompt: 'You are an explorer.'
  });

  assert.ok(scout.telemetry, 'Spawned agent must have telemetry initialized');
  assert.equal(scout.telemetry.inputTokens, 0);
  assert.equal(scout.telemetry.outputTokens, 0);
  assert.equal(scout.telemetry.totalTokens, 0);
  assert.equal(scout.telemetry.turnCount, 0);
  assert.deepEqual(scout.telemetry.lastSentContext, []);
});

test('2. Token Division & Accumulation: Single turn splits consumption into promptTokens and completionTokens', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  const mockCompletion = async (options) => {
    return {
      content: 'Understood. Initializing terrain scan.',
      reasoning_content: 'Evaluating the perimeter.',
      promptTokens: 145,
      completionTokens: 38,
      totalTokens: 183,
      usage: {
        prompt_tokens: 145,
        completion_tokens: 38,
        total_tokens: 183
      }
    };
  };

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  const agent = await runtime.launchAgent({
    id: 'agent_alpha',
    name: 'Alpha Agent',
    systemPrompt: 'System directive'
  }, createMockModel(mockCompletion));

  const emittedEvents = [];
  runtime.on((event) => {
    if (event.type === 'telemetry_update') {
      emittedEvents.push(event);
    }
  });

  await runtime.executeAgentTurn('agent_alpha', 'Scan sector 7');

  const telemetry = runtime.getAgentTelemetry('agent_alpha');
  assert.ok(telemetry, 'Telemetry must exist');
  assert.equal(telemetry.inputTokens, 145, 'Input tokens must match promptTokens');
  assert.equal(telemetry.outputTokens, 38, 'Output tokens must match completionTokens');
  assert.equal(telemetry.totalTokens, 183, 'Total tokens must match sum');
  assert.equal(telemetry.lastPromptTokens, 145);
  assert.equal(telemetry.lastCompletionTokens, 38);
  assert.equal(telemetry.turnCount, 1);

  assert.equal(emittedEvents.length, 1, 'Should emit telemetry_update event');
  assert.equal(emittedEvents[0].agentId, 'agent_alpha');
  assert.equal(emittedEvents[0].payload.turnPromptTokens, 145);
  assert.equal(emittedEvents[0].payload.turnCompletionTokens, 38);
});

test('3. Multi-turn Accumulation: Multiple turns correctly accumulate cumulative inputTokens & outputTokens', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  let turn = 0;
  const mockCompletion = async (options) => {
    turn++;
    if (turn === 1) {
      return {
        content: 'Turn 1 response',
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125
      };
    } else {
      return {
        content: 'Turn 2 response with more details',
        promptTokens: 150,
        completionTokens: 50,
        totalTokens: 200
      };
    }
  };

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  const agent = await runtime.launchAgent({
    id: 'agent_beta',
    name: 'Beta Agent'
  }, createMockModel(mockCompletion));

  await runtime.executeAgentTurn('agent_beta', 'First message');
  let tel = runtime.getAgentTelemetry('agent_beta');
  assert.equal(tel.inputTokens, 100);
  assert.equal(tel.outputTokens, 25);
  assert.equal(tel.totalTokens, 125);
  assert.equal(tel.turnCount, 1);

  await runtime.executeAgentTurn('agent_beta', 'Second message');
  tel = runtime.getAgentTelemetry('agent_beta');
  assert.equal(tel.inputTokens, 250, 'Input tokens should be 100 + 150 = 250');
  assert.equal(tel.outputTokens, 75, 'Output tokens should be 25 + 50 = 75');
  assert.equal(tel.totalTokens, 325, 'Total tokens should be 125 + 200 = 325');
  assert.equal(tel.lastPromptTokens, 150);
  assert.equal(tel.lastCompletionTokens, 50);
  assert.equal(tel.turnCount, 2);
});

test('4. Sent Context Tracking: agent.telemetry.lastSentContext stores exact formatted messages array sent to model', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  let capturedOptionsMessages = null;
  const mockCompletion = async (options) => {
    capturedOptionsMessages = options.messages;
    return {
      content: 'Response from model',
      promptTokens: 50,
      completionTokens: 10
    };
  };

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  const agent = await runtime.launchAgent({
    id: 'agent_gamma',
    name: 'Gamma Agent',
    systemPrompt: 'You are a gamma agent.'
  }, createMockModel(mockCompletion));

  await runtime.executeAgentTurn('agent_gamma', 'Execute task alpha');

  const tel = runtime.getAgentTelemetry('agent_gamma');
  assert.ok(Array.isArray(tel.lastSentContext), 'lastSentContext must be an array');
  assert.ok(tel.lastSentContext.length >= 2, 'lastSentContext should have system and user messages');
  assert.deepEqual(tel.lastSentContext, capturedOptionsMessages, 'lastSentContext must mirror the messages array passed to completion');
  
  // Verify roles
  assert.equal(tel.lastSentContext[0].role, 'system');
  assert.ok(tel.lastSentContext.some(m => m.role === 'user' && m.content === 'Execute task alpha'));
});

test('5. Telemetry Clear Action: clearAgentTelemetry resets counters to 0 and emits telemetry_reset event', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  const mockCompletion = async () => ({
    content: 'Completed',
    promptTokens: 200,
    completionTokens: 80
  });

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  const agent = await runtime.launchAgent({
    id: 'agent_delta',
    name: 'Delta Agent'
  }, createMockModel(mockCompletion));

  await runtime.executeAgentTurn('agent_delta', 'Do something');

  let tel = runtime.getAgentTelemetry('agent_delta');
  assert.equal(tel.totalTokens, 280);
  assert.equal(tel.turnCount, 1);
  const contextBeforeClear = [...tel.lastSentContext];

  let resetEmitted = false;
  runtime.on((ev) => {
    if (ev.type === 'telemetry_reset' && ev.agentId === 'agent_delta') {
      resetEmitted = true;
    }
  });

  const cleared = runtime.clearAgentTelemetry('agent_delta');
  assert.equal(cleared, true, 'clearAgentTelemetry should return true');

  tel = runtime.getAgentTelemetry('agent_delta');
  assert.equal(tel.inputTokens, 0, 'inputTokens must be reset to 0');
  assert.equal(tel.outputTokens, 0, 'outputTokens must be reset to 0');
  assert.equal(tel.totalTokens, 0, 'totalTokens must be reset to 0');
  assert.equal(tel.turnCount, 0, 'turnCount must be reset to 0');
  assert.equal(tel.lastPromptTokens, 0);
  assert.equal(tel.lastCompletionTokens, 0);
  assert.deepEqual(tel.lastSentContext, contextBeforeClear, 'lastSentContext should be preserved for inspection');
  assert.equal(resetEmitted, true, 'telemetry_reset event must be emitted');
});

test('6. Store Integration: sandboxStore.clearAgentTelemetry resets agent telemetry and updates reactive store', async () => {
  const mockCompletion = async () => ({
    content: 'Done from store',
    promptTokens: 120,
    completionTokens: 30
  });

  const store = new SandboxStore({});

  const agent = await store.spawnAgent({
    id: 'agent_store_test',
    name: 'Store Agent'
  }, createMockModel(mockCompletion));

  await store.triggerTurn('agent_store_test', 'Run store turn');

  let selectedAgent = store.agents.find(a => a.id === 'agent_store_test');
  assert.ok(selectedAgent, 'Agent must exist in store.agents');
  assert.equal(selectedAgent.telemetry.inputTokens, 120);
  assert.equal(selectedAgent.telemetry.outputTokens, 30);
  assert.equal(selectedAgent.telemetry.totalTokens, 150);
  assert.equal(selectedAgent.telemetry.turnCount, 1);

  const res = store.clearAgentTelemetry('agent_store_test');
  assert.equal(res, true, 'clearAgentTelemetry on store should succeed');

  selectedAgent = store.agents.find(a => a.id === 'agent_store_test');
  assert.equal(selectedAgent.telemetry.inputTokens, 0);
  assert.equal(selectedAgent.telemetry.outputTokens, 0);
  assert.equal(selectedAgent.telemetry.totalTokens, 0);
  assert.equal(selectedAgent.telemetry.turnCount, 0);
});

test('7. Persistence & Restore: serializeRuntimeEnvironment and restoreRuntimeEnvironment preserve telemetry across snapshots', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  const mockCompletion = async () => ({
    content: 'Snapshot verified',
    promptTokens: 300,
    completionTokens: 75
  });

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  await runtime.launchAgent({
    id: 'agent_persist',
    name: 'Persist Agent'
  }, createMockModel(mockCompletion));

  await runtime.executeAgentTurn('agent_persist', 'Turn for persistence');

  // Serialize environment
  const snapshot = serializeRuntimeEnvironment(runtime, vfs, bus);
  assert.ok(snapshot.agents, 'Snapshot must contain agents');
  const serializedAgent = snapshot.agents.find(a => a.id === 'agent_persist');
  assert.ok(serializedAgent.telemetry, 'Serialized agent must include telemetry');
  assert.equal(serializedAgent.telemetry.inputTokens, 300);
  assert.equal(serializedAgent.telemetry.outputTokens, 75);
  assert.equal(serializedAgent.telemetry.totalTokens, 375);
  assert.equal(serializedAgent.telemetry.turnCount, 1);
  assert.ok(serializedAgent.telemetry.lastSentContext.length > 0);

  // Restore into a fresh runtime
  const newVfs = new VirtualFS();
  const newBus = new MessagingBus();
  const newRuntime = new AgentRuntime({
    virtualFs: newVfs,
    messagingBus: newBus,
    autoBootstrapDirector: false
  });

  const restored = restoreRuntimeEnvironment(snapshot, newRuntime, newVfs, newBus);
  assert.equal(restored.success, true, 'restoreRuntimeEnvironment must succeed');

  const restoredAgent = newRuntime.getAgent('agent_persist');
  assert.ok(restoredAgent, 'Restored agent must exist');
  assert.ok(restoredAgent.telemetry, 'Restored agent must have telemetry');
  assert.equal(restoredAgent.telemetry.inputTokens, 300);
  assert.equal(restoredAgent.telemetry.outputTokens, 75);
  assert.equal(restoredAgent.telemetry.totalTokens, 375);
  assert.equal(restoredAgent.telemetry.turnCount, 1);
  assert.equal(restoredAgent.telemetry.lastSentContext.length, serializedAgent.telemetry.lastSentContext.length);
});

test('8. Two-Tier Token Accounting: turns without provider usage record zero tokens (INV-4)', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();

  const mockCompletion = async () => 'Plain response without provider usage.';

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false
  });

  await runtime.launchAgent({
    id: 'agent_no_usage',
    name: 'No Usage Agent'
  }, createMockModel(mockCompletion));

  await runtime.executeAgentTurn('agent_no_usage', 'Question without provider usage');

  const telemetry = runtime.getAgentTelemetry('agent_no_usage');
  assert.ok(telemetry, 'Telemetry must exist');
  assert.equal(telemetry.inputTokens, 0, 'Prompt tokens must be 0 when provider usage is absent');
  assert.equal(telemetry.outputTokens, 0, 'Completion tokens must be 0 when provider usage is absent');
  assert.equal(telemetry.totalTokens, 0);
  assert.equal(telemetry.turnCount, 1);
});
