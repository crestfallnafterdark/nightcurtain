/**
 * @file tests/unit/deepseek_reasoning_hygiene_test.js
 * @description Unit and Contract Test Suite for DeepSeek Thinking Mode reasoning_content Hygiene.
 */

import '../test_env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessagesWithToolHygiene } from '../../src/lib/sandbox/runtime/messageHygiene/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import {
  generateMessageId,
  ensureHistoryMessageIds
} from '../../src/lib/sandbox/runtime/historyManager/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';

test('1. formatMessagesWithToolHygiene guarantees reasoning_content string on assistant messages without reasoning', () => {
  const history = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' }
  ];

  const formatted = formatMessagesWithToolHygiene(history);
  assert.equal(formatted.length, 2);
  const ast = formatted[1];
  assert.equal(ast.role, 'assistant');
  assert.equal(typeof ast.reasoning_content, 'string');
  assert.equal(ast.reasoning_content, '');
});

test('2. formatMessagesWithToolHygiene preserves reasoning with evictCompletedReasoning: false, and evicts completed turns by default', () => {
  const history = [
    { role: 'user', content: 'Explain gravity' },
    { role: 'assistant', content: 'Gravity is...', reasoning_content: 'Mass curves spacetime.' },
    { role: 'user', content: 'Explain light' },
    { role: 'assistant', content: 'Light is...', reasoning: 'Photons with wave-particle duality.' },
    { role: 'user', content: 'Explain sound' },
    { role: 'assistant', content: 'Sound is...', thought: 'Mechanical pressure waves.' }
  ];

  const allPreserved = formatMessagesWithToolHygiene(history, { evictCompletedReasoning: false });
  assert.equal(allPreserved.length, 6);
  assert.equal(allPreserved[1].reasoning_content, 'Mass curves spacetime.');
  assert.equal(allPreserved[3].reasoning_content, 'Photons with wave-particle duality.');
  assert.equal(allPreserved[5].reasoning_content, 'Mechanical pressure waves.');

  const evicted = formatMessagesWithToolHygiene(history);
  assert.equal(evicted.length, 6);
  assert.equal(evicted[1].reasoning_content, '');
  assert.equal(evicted[3].reasoning_content, '');
  assert.equal(evicted[5].reasoning_content, 'Mechanical pressure waves.');
});

test('3. formatMessagesWithToolHygiene preserves reasoning_content on assistant messages with tool calls', () => {
  const history = [
    { role: 'user', content: 'Check files' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'I need to check the directory contents.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'listFiles', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_1', content: '["file1.txt"]' },
    {
      role: 'assistant',
      content: 'I found file1.txt',
      reasoning_content: 'Summarizing directory results.'
    }
  ];

  const formatted = formatMessagesWithToolHygiene(history);
  assert.equal(formatted.length, 4);
  assert.equal(formatted[1].role, 'assistant');
  assert.equal(formatted[1].reasoning_content, 'I need to check the directory contents.');
  assert.equal(formatted[1].tool_calls.length, 1);
  assert.equal(formatted[3].role, 'assistant');
  assert.equal(formatted[3].reasoning_content, 'Summarizing directory results.');
});

test('4. formatMessagesWithToolHygiene preserves reasoning_content even when unfulfilled tool calls are pruned', () => {
  const history = [
    { role: 'user', content: 'Run tool' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Thinking about tool execution.',
      tool_calls: [
        { id: 'call_orphan', type: 'function', function: { name: 'doSomething', arguments: '{}' } }
      ]
    }
  ];

  const formatted = formatMessagesWithToolHygiene(history);
  assert.equal(formatted.length, 2);
  const ast = formatted[1];
  assert.equal(ast.role, 'assistant');
  assert.equal(ast.tool_calls, undefined);
  assert.equal(ast.reasoning_content, 'Thinking about tool execution.');
});

test('5. formatMessagesWithToolHygiene guarantees reasoning_content on all assistant messages, including custom reasoning fields', () => {
  const rawMessages = [
    { role: 'system', content: 'Directives' },
    { role: 'user', content: 'Turn 1' },
    { role: 'assistant', content: 'Response 1' },
    { role: 'user', content: 'Turn 2' },
    { role: 'assistant', content: 'Response 2', reasoning: 'Deliberation from custom field' }
  ];

  const formatted = formatMessagesWithToolHygiene(rawMessages);

  assert.equal(formatted.length, 5);
  const ast1 = formatted[2];
  const ast2 = formatted[4];

  assert.equal(ast1.role, 'assistant');
  assert.equal(typeof ast1.reasoning_content, 'string');
  assert.equal(ast1.reasoning_content, '');

  assert.equal(ast2.role, 'assistant');
  assert.equal(ast2.reasoning_content, 'Deliberation from custom field');
});

test('6. AgentRuntime turn execution records reasoning_content in history for both tool calls and final text', async () => {
  const virtualFs = new VirtualFS();
  const messagingBus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs, messagingBus });

  let turnCallCount = 0;
  const mockCompletion = async (options) => {
    turnCallCount++;
    if (turnCallCount === 1) {
      return {
        content: null,
        reasoning: null,
        reasoning_content: '',
        tool_calls: [
          {
            id: 'call_test_1',
            type: 'function',
            function: {
              name: 'whoami',
              arguments: '{}'
            }
          }
        ]
      };
    } else {
      return {
        content: 'I verified my identity.',
        reasoning: 'I confirmed my agent ID is director.',
        reasoning_content: 'I confirmed my agent ID is director.',
        tool_calls: null
      };
    }
  };

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
        const res = await fn(options);
        if (typeof res === 'string') {
          yield { type: 'text', content: res };
        } else if (res && typeof res === 'object') {
          if (res.reasoning || res.reasoning_content) {
            yield { type: 'reasoning', reasoning: res.reasoning || res.reasoning_content, content: res.reasoning || res.reasoning_content };
          }
          if (res.content !== undefined || res.text !== undefined) {
            yield { type: 'text', content: res.content !== undefined ? res.content : res.text };
          }
          const toolCalls = res.tool_calls || res.toolCalls || [];
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            yield { type: 'tool_call', toolCalls };
          }
          yield {
            type: 'finish',
            finishReason: res.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
            content: res.content !== undefined ? res.content : (res.text || ''),
            reasoning: res.reasoning || res.reasoning_content || '',
            toolCalls,
            usage: res.usage
          };
        }
      },
      async complete(options = {}) {
        return await fn(options);
      }
    };
  }

  const agent = await runtime.launchAgent({
    id: 'test_reasoning_agent',
    name: 'Test Reasoning Agent',
    role: 'director'
  }, createMockModel(mockCompletion));

  const result = await runtime.executeAgentTurn('test_reasoning_agent', 'Run test');
  assert(result && result.agent);

  const history = agent.history;
  assert(history.length >= 4);

  const assistantMessages = history.filter(m => m.role === 'assistant');
  assert.equal(assistantMessages.length, 2);

  const toolAstMsg = assistantMessages[0];
  assert.equal(toolAstMsg.role, 'assistant');
  assert.equal(typeof toolAstMsg.reasoning_content, 'string');
  assert.equal(toolAstMsg.reasoning_content, '');
  assert.equal(toolAstMsg.tool_calls.length, 1);

  const finalAstMsg = assistantMessages[1];
  assert.equal(finalAstMsg.role, 'assistant');
  assert.equal(finalAstMsg.reasoning_content, 'I confirmed my agent ID is director.');
  assert.equal(finalAstMsg.reasoning, 'I confirmed my agent ID is director.');

  const formatted = formatMessagesWithToolHygiene(history);
  assert.equal(formatted.length, history.length);

  for (const m of formatted) {
    if (m.role === 'assistant') {
      assert.equal(typeof m.reasoning_content, 'string');
    }
  }
});

test('7. ensureHistoryMessageIds backfills reasoning_content on legacy assistant messages', () => {
  const legacyHistory = [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' }
  ];

  ensureHistoryMessageIds(legacyHistory);
  assert.equal(legacyHistory.length, 2);
  assert(legacyHistory[0].id);
  assert(legacyHistory[1].id);
  assert.equal(typeof legacyHistory[1].reasoning_content, 'string');
  assert.equal(legacyHistory[1].reasoning_content, '');
});
