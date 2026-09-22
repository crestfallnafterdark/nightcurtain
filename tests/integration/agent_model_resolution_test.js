/**
 * @file tests/integration/agent_model_resolution_test.js
 * @description Authentic Integration Test Suite for:
 * Agent Domain Model, Universal AgentModelConfig, Explicit-Settings Inheritance with Model-Catalog Default,
 * Re-binding on Config Updates, and Canonical Compaction & Ephemeral Reasoning Invariants.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, getGlobalModelConfig } from '../../src/lib/sandbox/runtime/agent/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { formatMessagesWithToolHygiene } from '../../src/lib/sandbox/runtime/messageHygiene/index.ts';

test('1. Agent instantiation binds dedicated provider and model from src/lib/sandbox/inference/', () => {
  const agent = new Agent({
    id: 'test-agent-1',
    name: 'Explorer Agent',
    modelConfig: {
      providerId: 'runware',
      keyId: 'canonical_runware',
      modelId: 'deepseek-v4-flash'
    }
  });

  assert.equal(agent.id, 'test-agent-1');
  assert.equal(agent.name, 'Explorer Agent');
  assert.ok(agent.provider, 'Agent must hold its own provider instance');
  assert.equal(agent.provider.id, 'runware');
  assert.ok(agent.model, 'Agent must hold its own model instance');
  assert.equal(agent.model.id, 'deepseek-v4-flash');
  assert.equal(agent.apiKey, undefined);
  assert.equal(agent.apiUrl, undefined);
});

test('2. Single Source Inheritance: Unspecified parameters inherit strictly from explicit agent settings', () => {
  // Explicit sandbox-owned settings supply the base model config
  const settings = {
    modelConfig: {
      providerId: 'nanogpt',
      keyId: 'canonical_nanogpt',
      modelId: 'deepseek/deepseek-v4.1-flash:thinking',
      temperature: 0.45,
      reasoningEffort: 'xhigh',
      routing: 'aoru'
    }
  };

  // Agent with minimal config - inherits directly from the explicit settings
  const agent = new Agent({
    id: 'minimal-agent',
    settings
  });

  assert.equal(agent.modelConfig.providerId, 'nanogpt');
  assert.equal(agent.modelConfig.keyId, 'canonical_nanogpt');
  assert.equal(agent.modelConfig.modelId, 'deepseek/deepseek-v4.1-flash:thinking');
  assert.equal(agent.modelConfig.temperature, 0.45);
  assert.equal(agent.modelConfig.reasoningEffort, 'xhigh');
  assert.equal(agent.modelConfig.routing, 'aoru');

  assert.equal(agent.provider.id, 'nanogpt');
  assert.equal(agent.model.id, 'deepseek/deepseek-v4.1-flash:thinking');
});

test('3. Explicit agent config overrides explicit settings', () => {
  const agent = new Agent({
    id: 'custom-agent',
    settings: {
      modelConfig: {
        providerId: 'runware',
        keyId: 'canonical_runware',
        modelId: 'deepseek-v4-flash',
        temperature: 0.7,
        reasoningEffort: 'high'
      }
    },
    modelConfig: {
      providerId: 'deepseek',
      keyId: 'canonical_deepseek',
      modelId: 'deepseek-chat',
      temperature: 0.1,
      reasoningEffort: 'low'
    }
  });

  assert.equal(agent.modelConfig.providerId, 'deepseek');
  assert.equal(agent.modelConfig.modelId, 'deepseek-chat');
  assert.equal(agent.modelConfig.temperature, 0.1);
  assert.equal(agent.modelConfig.reasoningEffort, 'low');
  assert.equal(agent.provider.id, 'deepseek');
  assert.equal(agent.model.id, 'deepseek-chat');
});

test('4. Dynamic Re-binding: updateConfig re-instantiates provider and model', () => {
  const agent = new Agent({
    id: 'dynamic-agent',
    modelConfig: {
      providerId: 'runware',
      keyId: 'canonical_runware',
      modelId: 'deepseek-v4-flash'
    }
  });

  assert.equal(agent.provider.id, 'runware');
  assert.equal(agent.model.id, 'deepseek-v4-flash');

  // Update to Prem provider
  agent.updateConfig({
    modelConfig: {
      providerId: 'prem',
      keyId: 'canonical_prem',
      modelId: 'deepseek-v4-flash-abliterated'
    }
  });

  assert.equal(agent.provider.id, 'prem');
  assert.equal(agent.model.id, 'deepseek-v4-flash-abliterated');
  assert.equal(agent.modelConfig.providerId, 'prem');
  assert.equal(agent.modelConfig.modelId, 'deepseek-v4-flash-abliterated');
});

test('5. Canonical Compaction & Ephemeral Reasoning Mandate: In-turn reasoning preserved, historical reasoning evicted, tools compacted', () => {
  const agent = new Agent({
    id: 'compaction-test-agent',
    modelConfig: {
      providerId: 'runware',
      keyId: 'canonical_runware',
      modelId: 'deepseek-v4-flash'
    }
  });

  // Populate history across 2 turns
  agent.history = [
    // Turn 1
    { role: 'user', content: 'What files are in the workspace?' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'Turn 1 deep reasoning: I will list files to check directory contents.',
      tool_calls: [
        {
          id: 'call_turn1_list',
          type: 'function',
          function: { name: 'fs_listFiles', arguments: '{"path":"/"}' }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_turn1_list',
      name: 'fs_listFiles',
      content: JSON.stringify({ success: true, files: ['a.txt', 'b.txt', 'c.txt'], totalCount: 3 })
    },
    {
      role: 'assistant',
      content: 'Turn 1 Closing Summary: Found files a.txt, b.txt, and c.txt.',
      reasoning_content: 'Turn 1 conclusion: Summary delivered to user.'
    },

    // Turn 2 (Active in-flight turn)
    { role: 'user', content: 'Read file a.txt' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'Turn 2 active in-flight reasoning: Reading a.txt now.',
      tool_calls: [
        {
          id: 'call_turn2_read',
          type: 'function',
          function: { name: 'fs_readFile', arguments: '{"path":"/a.txt"}' }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_turn2_read',
      name: 'fs_readFile',
      content: JSON.stringify({ success: true, content: 'File A contents are very long...', totalBytes: 150 })
    }
  ];

  // Format context for active turn
  const formatted = formatMessagesWithToolHygiene(agent.history, {
    evictCompletedReasoning: true,
    compactHistoricalTools: true
  });

  // 1. Turn 1 reasoning MUST be evicted (ephemeral reasoning mandate)
  const turn1Assistant1 = formatted.find(m => m.tool_calls && m.tool_calls[0]?.id === 'call_turn1_list');
  assert.ok(turn1Assistant1, 'Turn 1 tool-calling assistant message exists');
  assert.equal(turn1Assistant1.reasoning_content, '', 'Turn 1 completed reasoning must be evicted');

  const turn1Summary = formatted.find(m => m.role === 'assistant' && m.content?.includes('Turn 1 Closing Summary'));
  assert.ok(turn1Summary, 'Turn 1 closing summary survives as persistent memory');
  assert.equal(turn1Summary.reasoning_content, '', 'Turn 1 summary reasoning must be evicted');

  // 2. Turn 1 tool result MUST be compacted to 1-line tombstone
  const turn1ToolResult = formatted.find(m => m.role === 'tool' && m.tool_call_id === 'call_turn1_list');
  assert.ok(turn1ToolResult, 'Turn 1 tool result exists');
  assert.ok(
    turn1ToolResult.content.includes('"compacted":true') ||
    turn1ToolResult.content.includes('evicted_from_history') ||
    turn1ToolResult.content.includes('[Tool Result: fs_listFiles |'),
    `Turn 1 tool result must be compacted: ${turn1ToolResult.content}`
  );

  // 3. Turn 2 (active in-flight turn) reasoning MUST be preserved!
  const turn2Assistant = formatted.find(m => m.tool_calls && m.tool_calls[0]?.id === 'call_turn2_read');
  assert.ok(turn2Assistant, 'Turn 2 active assistant exists');
  assert.equal(turn2Assistant.reasoning_content, 'Turn 2 active in-flight reasoning: Reading a.txt now.');

  // 4. Turn 2 active tool result MUST NOT be compacted!
  const turn2ToolResult = formatted.find(m => m.role === 'tool' && m.tool_call_id === 'call_turn2_read');
  assert.ok(turn2ToolResult, 'Turn 2 tool result exists');
  assert.ok(turn2ToolResult.content.includes('File A contents are very long...'), 'Active turn tool result retains full content');
});

test('6. AgentRuntime launches Agent instances and delegates config updates', async () => {
  const vFs = new VirtualFS();
  const mBus = new MessagingBus();
  const runtime = new AgentRuntime({
    virtualFs: vFs,
    messagingBus: mBus,
    autoBootstrapDirector: false
  });

  const agent = await runtime.launchAgent({
    id: 'runtime-agent-1',
    name: 'Runtime Test Agent',
    modelConfig: {
      providerId: 'runware',
      keyId: 'canonical_runware',
      modelId: 'deepseek-v4-flash'
    }
  });

  assert.ok(agent instanceof Agent, 'launchAgent must instantiate an Agent instance');
  assert.equal(agent.provider.id, 'runware');
  assert.equal(agent.model.id, 'deepseek-v4-flash');

  // Update via runtime.updateAgentConfig
  runtime.updateAgentConfig('runtime-agent-1', {
    modelConfig: {
      modelId: 'deepseek-chat',
      providerId: 'deepseek',
      keyId: 'canonical_deepseek'
    }
  });

  assert.equal(agent.provider.id, 'deepseek');
  assert.equal(agent.model.id, 'deepseek-chat');
  assert.equal(agent.modelConfig.modelId, 'deepseek-chat');
});

test('7. Polymorphic launchAgent: Concrete Model Dependency Injection executes turn directly via model.stream', async () => {
  const vFs = new VirtualFS();
  const mBus = new MessagingBus();
  const runtime = new AgentRuntime({
    virtualFs: vFs,
    messagingBus: mBus,
    autoBootstrapDirector: false
  });

  let streamInvoked = false;
  const mockProvider = {
    id: 'mock-provider',
    createModel: () => mockModel,
    getEndpointUrl: () => 'https://mock.example.com',
    checkBalance: async () => ({ available: true, balance: '100' })
  };

  const mockModel = {
    id: 'mock-deepseek-r1',
    provider: mockProvider,
    config: { temperature: 0.2 },
    async *stream(options) {
      streamInvoked = true;
      yield { type: 'reasoning', reasoning: 'Mock thinking step 1...' };
      yield { type: 'text', content: 'Injected model completed turn successfully.' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        content: 'Injected model completed turn successfully.',
        reasoning: 'Mock thinking step 1...'
      };
    },
    async complete(options) {
      return {
        content: 'Injected model completed turn successfully.',
        reasoning: 'Mock thinking step 1...',
        toolCalls: []
      };
    }
  };

  // Concrete Signature: launchAgent(config, model, provider)
  const agent = await runtime.launchAgent({
    id: 'di-agent',
    name: 'Dependency Injected Agent'
  }, mockModel, mockProvider);

  assert.equal(agent.model, mockModel, 'Agent holds injected mockModel directly');
  assert.equal(agent.provider, mockProvider, 'Agent holds injected mockProvider directly');

  // Execute turn
  const result = await runtime.executeAgentTurn('di-agent', 'Hello DI agent!');

  assert.ok(streamInvoked, 'mockModel.stream was invoked directly by AgentRuntime');
  assert.equal(result.output, 'Injected model completed turn successfully.');
  assert.equal(agent.history.length, 2);
  assert.equal(agent.history[0].role, 'user');
  assert.equal(agent.history[1].role, 'assistant');
  assert.equal(agent.history[1].content, 'Injected model completed turn successfully.');
});

test('8. Polymorphic launchAgent: String variant resolves model/provider and calls concrete variant', async () => {
  const vFs = new VirtualFS();
  const mBus = new MessagingBus();
  const runtime = new AgentRuntime({
    virtualFs: vFs,
    messagingBus: mBus,
    autoBootstrapDirector: false
  });

  // String variant: launchAgent(config) resolves from explicit sandbox settings
  const agent = await runtime.launchAgent({
    id: 'string-resolved-agent',
    name: 'String Resolved Agent',
    settings: {
      modelConfig: {
        providerId: 'runware',
        keyId: 'canonical_runware',
        modelId: 'deepseek-v4-flash'
      }
    }
  });

  assert.ok(agent instanceof Agent);
  assert.equal(agent.provider.id, 'runware');
  assert.equal(agent.model.id, 'deepseek-v4-flash');
});

/**
 * Builds a frozen MOD-20 preset-source test double over a preset map.
 *
 * @param {Record<string, object>} presets - Preset id -> modelConfig map
 * @param {string} defaultId - Id returned by getDefaultPresetId()
 * @returns {object} Frozen ModelPresetSourcePort double
 */
function makePresetSource(presets, defaultId) {
  return Object.freeze({
    getPreset(id) {
      if (!Object.prototype.hasOwnProperty.call(presets, id)) return null;
      return Object.freeze({
        id,
        name: `Preset ${id}`,
        isCustom: false,
        modelConfig: Object.freeze({ ...presets[id] })
      });
    },
    getDefaultPresetId: () => defaultId,
    subscribe: () => () => {}
  });
}

const BOUND_PRESET_CONFIG = {
  providerId: 'deepseek',
  modelId: 'deepseek-chat',
  temperature: 0.15,
  reasoningEffort: 'low'
};

test('9. Preset-bound construction materializes the catalog preset (binding-only) with provider-active credentials', () => {
  const presetSource = makePresetSource(
    { preset_official_deepseek_chat: BOUND_PRESET_CONFIG },
    'preset_official_deepseek_chat'
  );

  const resolverCalls = [];
  const credentialResolver = {
    getCredential: () => null,
    getActiveCredential: (providerId) => {
      resolverCalls.push(providerId);
      return providerId === 'deepseek' ? { id: 'vault_deepseek_active' } : null;
    }
  };

  const agent = new Agent(
    {
      id: 'preset-bound-agent',
      presetId: 'preset_official_deepseek_chat',
      settings: {
        modelConfig: {
          providerId: 'runware',
          keyId: 'canonical_runware',
          modelId: 'deepseek-v4-flash'
        }
      },
      modelConfig: {
        providerId: 'prem',
        keyId: 'canonical_prem',
        modelId: 'ignored-override'
      }
    },
    null,
    null,
    credentialResolver,
    null,
    presetSource
  );

  // Binding-only (OPEN-1): preset config wins wholesale; settings + explicit
  // modelConfig never form an override layer. (The resolver is consulted both
  // for materialization and again during provider construction.)
  assert.deepStrictEqual([...new Set(resolverCalls)], ['deepseek'], 'Active credential resolves for the preset provider');
  assert.equal(agent.modelConfig.providerId, 'deepseek');
  assert.equal(agent.modelConfig.modelId, 'deepseek-chat');
  assert.equal(agent.modelConfig.temperature, 0.15);
  assert.equal(agent.modelConfig.reasoningEffort, 'low');
  assert.equal(agent.modelConfig.keyId, 'vault_deepseek_active', 'Provider-active credential id is re-attached');
  assert.equal(agent.config.presetId, 'preset_official_deepseek_chat');
  assert.equal(agent.config.modelConfig.providerId, 'deepseek');
  assert.equal(agent.provider.id, 'deepseek');
  assert.equal(agent.model.id, 'deepseek-chat');

  // No resolver / no active credential: canonical provider reference fallback.
  const noResolver = new Agent(
    { id: 'preset-bound-no-resolver', presetId: 'preset_official_deepseek_chat' },
    null, null, null, null, presetSource
  );
  assert.equal(noResolver.modelConfig.keyId, 'canonical_deepseek');

  const nullActiveResolver = {
    getCredential: () => null,
    getActiveCredential: () => null
  };
  const nullActive = new Agent(
    { id: 'preset-bound-null-active', presetId: 'preset_official_deepseek_chat' },
    null, null, nullActiveResolver, null, presetSource
  );
  assert.equal(nullActive.modelConfig.keyId, 'canonical_deepseek');
});

test('10. Source-less construction keeps legacy resolution; source-bearing constructions bind the default (binding-only)', () => {
  const settings = {
    modelConfig: {
      providerId: 'nanogpt',
      keyId: 'canonical_nanogpt',
      modelId: 'deepseek/deepseek-v4.1-flash:thinking',
      temperature: 0.45
    }
  };
  const presetSource = makePresetSource(
    { preset_official_deepseek_chat: BOUND_PRESET_CONFIG },
    'preset_official_deepseek_chat'
  );

  // No source supplied: the binding is inert and legacy resolution applies.
  const noSource = new Agent({ id: 'legacy-no-source', presetId: 'preset_official_deepseek_chat', settings });
  assert.equal(noSource.config.presetId, 'preset_official_deepseek_chat', 'Source-less presetId stays inert metadata');
  assert.equal(noSource.modelConfig.providerId, 'nanogpt');
  assert.equal(noSource.modelConfig.modelId, 'deepseek/deepseek-v4.1-flash:thinking');
  assert.equal(noSource.modelConfig.temperature, 0.45);

  // Unknown id with a source: the construction binds the catalog default (ICD §6).
  const unknown = new Agent({ id: 'legacy-unknown-id', presetId: 'preset_missing', settings }, null, null, null, null, presetSource);
  assert.equal(unknown.config.presetId, 'preset_official_deepseek_chat');
  assert.equal(unknown.modelConfig.providerId, 'deepseek');
  assert.equal(unknown.modelConfig.modelId, 'deepseek-chat');

  // No presetId with a source: same implicit default binding.
  const unbound = new Agent({ id: 'legacy-unbound', settings }, null, null, null, null, presetSource);
  assert.equal(unbound.config.presetId, 'preset_official_deepseek_chat');
  assert.equal(unbound.modelConfig.providerId, 'deepseek');
  assert.equal(unbound.modelConfig.modelId, 'deepseek-chat');

  // Binding-only (OPEN-1): an explicit overlay never wins over the bound preset.
  const overlay = new Agent(
    {
      id: 'legacy-overlay',
      settings,
      modelConfig: { providerId: 'runware', keyId: 'canonical_runware', modelId: 'deepseek-v4-flash' }
    },
    null, null, null, null, presetSource
  );
  assert.equal(overlay.config.presetId, 'preset_official_deepseek_chat');
  assert.equal(overlay.modelConfig.providerId, 'deepseek');
  assert.equal(overlay.modelConfig.modelId, 'deepseek-chat');
});

test('11. fromSnapshot heals missing and stale preset ids to the source default and keeps valid bindings', () => {
  const presetSource = makePresetSource(
    {
      preset_default: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      preset_valid: { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking' }
    },
    'preset_default'
  );

  const baseSnapshot = new Agent({ id: 'heal-agent' }).toSnapshot();

  // Stale id: re-pointed at the source default and materialized from it.
  const staleInput = JSON.parse(JSON.stringify(baseSnapshot));
  staleInput.config.presetId = 'preset_deleted';
  const stale = Agent.fromSnapshot(staleInput, { presetSource });
  assert.equal(stale.config.presetId, 'preset_default');
  assert.equal(stale.modelConfig.providerId, 'deepseek');
  assert.equal(stale.modelConfig.modelId, 'deepseek-chat');
  assert.equal(stale.modelConfig.keyId, 'canonical_deepseek');
  assert.equal(staleInput.config.presetId, 'preset_deleted', 'Healing never rewrites the input snapshot');

  // Missing id: same default binding.
  const missing = Agent.fromSnapshot(baseSnapshot, { presetSource });
  assert.equal(missing.config.presetId, 'preset_default');
  assert.equal(missing.modelConfig.providerId, 'deepseek');

  // Valid id: kept verbatim and materialized from that preset.
  const validInput = JSON.parse(JSON.stringify(baseSnapshot));
  validInput.config.presetId = 'preset_valid';
  const valid = Agent.fromSnapshot(validInput, { presetSource });
  assert.equal(valid.config.presetId, 'preset_valid');
  assert.equal(valid.modelConfig.providerId, 'nanogpt');
  assert.equal(valid.modelConfig.modelId, 'deepseek/deepseek-v4.1-flash:thinking');

  // No source: the persisted config is adopted unchanged (no healing).
  const noSourceInput = JSON.parse(JSON.stringify(baseSnapshot));
  noSourceInput.config.presetId = 'preset_deleted';
  const noSource = Agent.fromSnapshot(noSourceInput, {});
  assert.equal(noSource.config.presetId, 'preset_deleted');
  const legacyBaseline = getGlobalModelConfig();
  assert.equal(noSource.modelConfig.providerId, legacyBaseline.providerId);
  assert.equal(noSource.modelConfig.modelId, legacyBaseline.modelId);
});
