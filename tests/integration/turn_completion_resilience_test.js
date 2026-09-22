/**
 * @file tests/turn_completion_resilience_test.js
 * @description Comprehensive Zero-Mock Independent Black-Box QA Verification Suite for Epic 17:
 * Turn Completion Summary Carrier, Intentional Presentation, Precall Revalidation & Runtime Fault Containment.
 * 
 * Verifies all 12 Acceptance Criteria (AC-EPIC17-01 through AC-EPIC17-12):
 * - [AC-EPIC17-01] Durable Summary Response: Terminal batch summary appended as assistant response in history
 * - [AC-EPIC17-02] Intentional Completion Presentation: No false 'interrupted' status on intentional completion
 * - [AC-EPIC17-03] Strict Precall Allowlist: Mutating tools rejected in precall allowlist
 * - [AC-EPIC17-04] Precall Execution-Time Revalidation: Injected/hydrated forbidden precalls caught at execution time
 * - [AC-EPIC17-05] Precall Deduplication: Duplicate precalls with identical canonical names & arguments execute once
 * - [AC-EPIC17-06] Precall Volume Bounds: Terminal batches bounded to maximum 10 precalls
 * - [AC-EPIC17-07] Precall Error Containment: Failed precalls surface as model-visible tool errors without aborting
 * - [AC-EPIC17-08] Multi-Tool Batch Fault Isolation: Failing tool call does not abort execution of subsequent calls
 * - [AC-EPIC17-09] Safe Tool Result Serialization: Circular references and BigInt handled safely without throwing
 * - [AC-EPIC17-10] Accurate Kill Reporting & Spawn Cleanup: NOT_FOUND on non-existent agents, unwinding on spawn error
 * - [AC-EPIC17-11] Validated Snapshot Import: Prototype pollution rejection and private workspace ownership integrity
 * - [AC-EPIC17-12] Zero-Mock Black-Box QA Gate & Clean Build Verification: Clean build exit 0
 */

import { strict as assert } from 'assert';
import { createWiredRuntime } from '../helpers/wired_identity_fixture.js';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';

/** Canonical private-workspace key of a Generic-realm test agent (Wave I, d57cbc1). */
const realmKey = (id) => createAgentIdentityKey('realm_generic', id);
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  SANDBOX_TOOLS,
  TOOL_PRESETS,
  INNATE_TOOLS,
  resolveToolPreset,
  getSandboxToolsSchema,
  createSandboxToolDispatcher
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  VirtualFS,
  PermissionDeniedError,
  FileNotFoundError
} from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { validateSandboxState, serializeRuntimeEnvironment, restoreRuntimeEnvironment } from '../../src/lib/sandbox/sandboxPersistence/index.ts';

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
        yield {
          type: 'finish',
          finishReason: res.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
          content: res.content !== undefined ? res.content : (res.text || ''),
          reasoning: res.reasoning || res.reasoning_content || '',
          toolCalls,
          usage: res.usage
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

// Global Test Recorder for QA Artifact Generation
const recordedScenarios = [];
let totalPassed = 0;
let totalFailed = 0;

async function runTestScenario(testId, criteriaId, title, invariant, testFn) {
  const start = performance.now();
  try {
    await testFn();
    const durationMs = performance.now() - start;
    totalPassed++;
    recordedScenarios.push({
      testId,
      criteriaId,
      title,
      invariant,
      status: 'PASS',
      durationMs: Number(durationMs.toFixed(2))
    });
    console.log(`  [PASS] [${testId}] [${criteriaId}] ${title} (${durationMs.toFixed(2)}ms)`);
  } catch (err) {
    const durationMs = performance.now() - start;
    totalFailed++;
    recordedScenarios.push({
      testId,
      criteriaId,
      title,
      invariant,
      status: 'FAIL',
      error: err?.message || String(err),
      durationMs: Number(durationMs.toFixed(2))
    });
    console.error(`  [FAIL] [${testId}] [${criteriaId}] ${title} (${durationMs.toFixed(2)}ms)`);
    console.error(err);
  }
}

console.log('======================================================================');
console.log('  EPIC 17 ZERO-MOCK BLACK-BOX QA SUITE: TURN COMPLETION & RESILIENCE');
console.log('======================================================================\n');

// -----------------------------------------------------------------------------
// [AC-EPIC17-01] Durable Summary Response
// -----------------------------------------------------------------------------
console.log('--- [AC-EPIC17-01] Durable Summary Response ---');

await runTestScenario(
  'AC17-01.1',
  'AC-EPIC17-01',
  'Terminal batch summary is appended as assistant response to agent.history and populated in output',
  'PRC-2: The summary supplied with a terminal batch must be appended to agent history as assistant turn response',
  async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const clock = new WorldClock();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, worldClock: clock });

    const closingSummaryText = 'Completed character backstory draft and indexed chapter outline.';

    const agent = await runtime.launchAgent({
      id: 'author-agent',
      name: 'Author Agent',
      role: 'user',
      allowedTools: ['*']
    }, createMockModel(async (options) => {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'runtime_batchPrecall',
              arguments: JSON.stringify({
                summary: closingSummaryText,
                calls: [{ name: 'virtualFs_readFile', arguments: { filePath: 'notes.txt' } }]
              })
            }
          }
        ]
      };
    }));

    const turnResult = await runtime.executeAgentTurn(agent.id, 'Please finish the outline.');

    assert.equal(turnResult.output, closingSummaryText);
    assert.equal(turnResult.summary, closingSummaryText);

    // Verify that agent.history has the assistant response message with summary
    const assistantMsgs = agent.history.filter(m => m.role === 'assistant');
    assert.ok(assistantMsgs.length >= 1, 'At least one assistant message in history');
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];
    assert.equal(lastAssistantMsg.content, closingSummaryText);
    assert.equal(lastAssistantMsg.metadata?.terminalSummary, true);
    assert.equal(lastAssistantMsg.metadata?.summary, closingSummaryText);
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-02] Intentional Completion Presentation
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-02] Intentional Completion Presentation ---');

await runTestScenario(
  'AC17-02.1',
  'AC-EPIC17-02',
  'Terminal batch completion records lastInterruptedTurn: null and isAgentInterrupted returns false',
  'PRC-1: Intentional completion is not an interruption; genuine aborts remain distinguishable',
  async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus });

    const agent = await runtime.launchAgent({
      id: 'worker-1',
      name: 'Worker 1',
      allowedTools: ['*']
    }, createMockModel(async (options) => {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_term_1',
            type: 'function',
            function: {
              name: 'runtime_batchPrecall',
              arguments: JSON.stringify({ summary: 'Finished review without errors.' })
            }
          }
        ]
      };
    }));

    await runtime.executeAgentTurn(agent.id, 'Perform review.');

    assert.equal(agent.lastInterruptedTurn, null, 'lastInterruptedTurn must be null after clean terminal completion');
    assert.equal(runtime.isAgentInterrupted(agent.id), false, 'isAgentInterrupted must return false for intentional completion');

    // Verify that genuine abort sets interrupted status
    agent.lastInterruptedTurn = {
      input: 'Interrupted task',
      mode: 'manual',
      timestamp: Date.now(),
      cancelled: true
    };
    assert.equal(runtime.isAgentInterrupted(agent.id), true, 'Genuine abort is distinguishable and returns true');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-03] Strict Precall Allowlist
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-03] Strict Precall Allowlist ---');

await runTestScenario(
  'AC17-03.1',
  'AC-EPIC17-03',
  'Mutating operations are strictly rejected from runtime_batchPrecall allowlist',
  'PRC-3: Only pure read/observe operations may execute as precalls',
  async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const clock = new WorldClock();
    const baseDispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      messagingBus: bus,
      worldClock: clock,
      agentId: 'tester-1',
      privileged: true,
      allowedTools: ['*']
    });
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      messagingBus: bus,
      worldClock: clock,
      agentId: 'tester-1',
      privileged: true,
      allowedTools: ['*'],
      executeTool: (name, args, ctx) => baseDispatcher.executeTool(name, args, ctx)
    });

    // Mutating tools that must be forbidden
    const forbiddenTools = [
      { name: 'virtualFs_writeFile', arguments: { filePath: 'foo.txt', content: 'test' } },
      { name: 'write_file', arguments: { path: 'foo.txt', content: 'test' } },
      { name: 'messaging_sendMessage', arguments: { to: 'peer', content: 'hi' } },
      { name: 'send_message', arguments: { to: 'peer', content: 'hi' } },
      { name: 'runtime_schedule', arguments: { delaySeconds: 10 } },
      { name: 'schedule', arguments: { delaySeconds: 10 } }
    ];

    for (const forbidden of forbiddenTools) {
      const res = await dispatcher.executeTool('runtime_batchPrecall', {
        calls: [forbidden]
      });
      assert.equal(res.success, true, `Batch returns a per-call result for '${forbidden.name}'`);
      const item = res.results[0];
      const callResult = item.result || item;
      assert.equal(callResult.success, false, `Tool '${forbidden.name}' must not execute`);
      assert.equal(callResult.code, 'PRECALL_FORBIDDEN', `Tool '${forbidden.name}' must be rejected from precall allowlist`);
    }

    // Permitted read-only tools and PO-allowed world_clock / event_list tools
    const allowedTools = [
      { name: 'virtualFs_readFile', arguments: { filePath: 'notes.txt' } },
      { name: 'read_file', arguments: { path: 'notes.txt' } },
      { name: 'virtualFs_queryJson', arguments: { filePath: 'data.json', jsonPath: '$.key' } },
      { name: 'query_json', arguments: { path: 'data.json', query: '$.key' } },
      { name: 'virtualFs_listFiles', arguments: {} },
      { name: 'list_files', arguments: {} },
      { name: 'virtualFs_grep', arguments: { pattern: 'needle' } },
      { name: 'grep', arguments: { query: 'needle' } },
      { name: 'runtime_whoami', arguments: {} },
      { name: 'whoami', arguments: {} },
      { name: 'runtime_listAgents', arguments: {} },
      { name: 'list_agents', arguments: {} },
      { name: 'system_getCurrentTime', arguments: {} },
      { name: 'get_current_time', arguments: {} },
      { name: 'world_clock', arguments: { action: 'query' } },
      { name: 'worldClock', arguments: {} },
      { name: 'clock', arguments: {} },
      { name: 'event_list', arguments: { action: 'query' } },
      { name: 'eventList', arguments: {} },
      { name: 'event_manager', arguments: {} },
      { name: 'messaging_listInbox', arguments: {} },
      { name: 'list_inbox', arguments: {} },
      { name: 'messaging_readMessage', arguments: { messageId: 'm1' } },
      { name: 'read_message', arguments: { message_id: 'm1' } },
      { name: 'messaging_getArchive', arguments: {} },
      { name: 'get_archive', arguments: {} }
    ];

    for (const allowed of allowedTools) {
      const res = await dispatcher.executeTool('runtime_batchPrecall', {
        calls: [allowed]
      });
      assert.equal(res.success, true, `Batch must accept '${allowed.name}'`);
      const item = res.results[0];
      assert.ok(item.result, `Allowed tool '${allowed.name}' must execute (no FORBIDDEN result)`);
      assert.notEqual(item.result.code, 'PRECALL_FORBIDDEN', `Tool '${allowed.name}' must be allowlisted`);
    }
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-04] Precall Execution-Time Revalidation
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-04] Precall Execution-Time Revalidation ---');

await runTestScenario(
  'AC17-04.1',
  'AC-EPIC17-04',
  'Hydrated/injected mutating precalls in pendingPrecalls are caught at turn execution time without aborting',
  'PRC-4: Execution-time revalidation enforces allowlist when precalls execute, not only when queued',
  async () => {
    const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();

    // Wildcard capability selection requires lifecycle authority (MOD-21 W8);
    // the production engine launches under the registered operator director.
    await runtime.ensureDirector();
    const agent = await runtime.launchAgent({
      config: { id: 'target-agent', name: 'Target Agent', allowedTools: ['*'] },
      model: createMockModel(async (options) => {
        return { role: 'assistant', content: 'Acknowledged context.' };
      }),
      principal: { callerAgentId: 'director' }
    });

    // Directly inject forbidden mutating precalls into pendingPrecalls (simulating malicious/stale hydrated state)
    agent.pendingPrecalls = [
      { name: 'virtualFs_writeFile', arguments: { filePath: 'exploit.txt', content: 'hacked' } },
      { name: 'virtualFs_readFile', arguments: { filePath: 'notes.txt', workspaceId: 'target-agent' } }
    ];

    vfs.writeFile('/notes.txt', 'Safe note content', { workspaceId: realmKey('target-agent'), callerAgentId: realmKey('target-agent') });

    const turnRes = await runtime.executeAgentTurn(agent.id, 'Next turn start');

    assert.equal(turnRes.cancelled, undefined, 'Turn must NOT be cancelled or aborted');
    
    // Check that exploit.txt was NOT created
    assert.equal(vfs.exists('/exploit.txt', { workspaceId: realmKey('target-agent'), callerAgentId: realmKey('target-agent') }), false, 'Forbidden mutating precall must not have executed');

    // Check that the tool responses contain FORBIDDEN_PRECALL error
    const toolMsgs = agent.history.filter(m => m.role === 'tool');
    const forbiddenResp = toolMsgs.find(m => m.name === 'virtualFs_writeFile');
    assert.ok(forbiddenResp, 'Tool response for forbidden precall must be recorded in history');
    const parsedResp = JSON.parse(forbiddenResp.content);
    assert.equal(parsedResp.success, false);
    assert.equal(parsedResp.code, 'FORBIDDEN_PRECALL');

    // Check that permitted notes.txt precall DID execute and returned content
    const allowedResp = toolMsgs.find(m => m.name === 'virtualFs_readFile');
    assert.ok(allowedResp, 'Tool response for permitted precall must be recorded');
    const parsedAllowed = JSON.parse(allowedResp.content);
    assert.equal(parsedAllowed.content, 'Safe note content');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-05] Precall Deduplication
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-05] Precall Deduplication ---');

await runTestScenario(
  'AC17-05.1',
  'AC-EPIC17-05',
  'Precalls with identical canonical tool name and equivalent arguments execute exactly once',
  'PRC-5: Two precalls with the same normalized tool name and equivalent arguments must execute once',
  async () => {
    const rawCalls = [
      { name: 'read_file', arguments: { path: 'shared.txt', workspaceId: 'dedupe-agent' } },
      { name: 'virtualFs_readFile', arguments: { path: 'shared.txt', workspaceId: 'dedupe-agent' } }, // duplicate canonical name
      { name: 'read_file', arguments: { path: 'other.txt', workspaceId: 'dedupe-agent' } }, // different argument
      { name: 'virtualFs_readFile', arguments: { path: 'shared.txt', workspaceId: 'dedupe-agent' } }, // exact duplicate
      { name: 'get_current_time', arguments: {} },
      { name: 'system_getCurrentTime', arguments: {} } // duplicate canonical name
    ];

    // Verify execution in runtime: deduplication is enforced on the public boundary
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus });

    const agent = await runtime.launchAgent({
      id: 'dedupe-agent',
      name: 'Dedupe Agent',
      allowedTools: ['*']
    }, createMockModel(async (options) => {
      return { role: 'assistant', content: 'Done.' };
    }));

    vfs.writeFile('/shared.txt', 'Shared text', { workspaceId: 'dedupe-agent', callerAgentId: 'dedupe-agent' });
    vfs.writeFile('/other.txt', 'Other text', { workspaceId: 'dedupe-agent', callerAgentId: 'dedupe-agent' });

    agent.pendingPrecalls = rawCalls;

    await runtime.executeAgentTurn(agent.id, 'Start');

    const toolMsgs = agent.history.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 3, 'Exactly 3 tool responses recorded after deduplication');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-06] Precall Volume Bounds
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-06] Precall Volume Bounds ---');

await runTestScenario(
  'AC17-06.1',
  'AC-EPIC17-06',
  'Queued precalls are bounded to maximum 10 calls per turn start',
  'PRC-8: A terminal batch must not be able to queue an unbounded number of precalls',
  async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus });

    const agent = await runtime.launchAgent({
      id: 'bound-agent',
      name: 'Bound Agent',
      allowedTools: ['*']
    }, createMockModel(async (options) => {
      return { role: 'assistant', content: 'Done.' };
    }));

    // Create 15 distinct files
    for (let i = 0; i < 15; i++) {
      vfs.writeFile(`/file_${i}.txt`, `Content ${i}`, { workspaceId: 'bound-agent', callerAgentId: 'bound-agent' });
    }

    // Queue 15 distinct precalls
    const manyCalls = [];
    for (let i = 0; i < 15; i++) {
      manyCalls.push({ name: 'virtualFs_readFile', arguments: { filePath: `file_${i}.txt` } });
    }

    agent.pendingPrecalls = manyCalls;

    await runtime.executeAgentTurn(agent.id, 'Process files');

    const toolMsgs = agent.history.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 10, 'Precall executions must be capped to maximum 10');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-07] Precall Error Containment
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-07] Precall Error Containment ---');

await runTestScenario(
  'AC17-07.1',
  'AC-EPIC17-07',
  'Failing precall (e.g. non-existent file) returns structured tool error to context without crashing turn',
  'PRC-6: A failed precall must appear as an ordinary tool failure that the model can observe',
  async () => {
    const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();

    // Wildcard capability selection requires lifecycle authority (MOD-21 W8);
    // the production engine launches under the registered operator director.
    await runtime.ensureDirector();
    const agent = await runtime.launchAgent({
      config: { id: 'error-precall-agent', name: 'Error Precall Agent', allowedTools: ['*'] },
      model: createMockModel(async (options) => {
        return { role: 'assistant', content: 'Handled missing file.' };
      }),
      principal: { callerAgentId: 'director' }
    });

    agent.pendingPrecalls = [
      { name: 'virtualFs_readFile', arguments: { filePath: 'missing_non_existent.txt' } }
    ];

    const turnRes = await runtime.executeAgentTurn(agent.id, 'Handle missing file');
    assert.equal(turnRes.cancelled, undefined);

    const toolMsgs = agent.history.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    const parsed = JSON.parse(toolMsgs[0].content);
    assert.equal(parsed.success, false);
    assert.equal(parsed.code, 'EXECUTION_FAILED');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-08] Multi-Tool Batch Fault Isolation
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-08] Multi-Tool Batch Fault Isolation ---');

await runTestScenario(
  'AC17-08.1',
  'AC-EPIC17-08',
  'A failure in the first tool call does not prevent remaining tool calls in the batch from executing',
  'TURN-6: A single failing tool call must not abort execution of remaining calls in the batch',
  async () => {
    const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();

    let streamIteration = 0;

    // Wildcard capability selection requires lifecycle authority (MOD-21 W8);
    // the production engine launches under the registered operator director.
    await runtime.ensureDirector();
    const agent = await runtime.launchAgent({
      config: { id: 'batch-fault-agent', name: 'Batch Fault Agent', allowedTools: ['*'] },
      model: createMockModel(async (options) => {
      streamIteration++;
      if (streamIteration === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_err_1',
              type: 'function',
              function: {
                name: 'virtualFs_readFile',
                arguments: JSON.stringify({ filePath: 'missing_file.txt', workspaceId: 'batch-fault-agent' })
              }
            },
            {
              id: 'call_ok_2',
              type: 'function',
              function: {
                name: 'virtualFs_readFile',
                arguments: JSON.stringify({ filePath: 'valid.txt', workspaceId: 'batch-fault-agent' })
              }
            }
          ]
        };
      } else {
        return { role: 'assistant', content: 'All tools processed.' };
      }
      }),
      principal: { callerAgentId: 'director' }
    });

    vfs.writeFile('/valid.txt', 'Valid Content', { workspaceId: realmKey('batch-fault-agent'), callerAgentId: realmKey('batch-fault-agent') });

    const turnRes = await runtime.executeAgentTurn(agent.id, 'Run batch');
    assert.equal(turnRes.cancelled, undefined);

    const toolMsgs = agent.history.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 2, 'Both tool calls in the batch must have executed');

    const resp1 = JSON.parse(toolMsgs[0].content);
    assert.equal(resp1.success, false);
    assert.equal(resp1.code, 'EXECUTION_FAILED');

    const resp2 = JSON.parse(toolMsgs[1].content);
    assert.equal(resp2.content, 'Valid Content');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-09] Safe Tool Result Serialization
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-09] Safe Tool Result Serialization ---');

await runTestScenario(
  'AC17-09.1',
  'AC-EPIC17-09',
  'Circular and BigInt tool results are contained as error responses without crashing the turn',
  'TURN-7: Tool results that cannot be serialized must be normalized into safe structured results',
  async () => {
    // 1. Dispatcher tool responses always serialize to parseable JSON
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      messagingBus: bus,
      agentId: 'serial-tester'
    });

    const circularToolCall = {
      id: 'call_circ_1',
      type: 'function',
      function: {
        name: 'virtualFs_listFiles',
        arguments: '{}'
      }
    };

    const resp = await dispatcher.executeToolCall(circularToolCall);
    assert.equal(resp.role, 'tool');
    assert.equal(typeof resp.content, 'string');
    assert.doesNotThrow(() => JSON.parse(resp.content));

    // 2. Runtime custom tools returning non-serializable values must not crash the turn:
    // they are contained as structured error tool responses and the model recovers.
    const circular = { name: 'circular' };
    circular.self = circular;

    const runtime = new AgentRuntime({ virtualFs: new VirtualFS(), messagingBus: new MessagingBus(), autoBootstrapDirector: false });
    let completions = 0;

    const agent = await runtime.launchAgent({
      id: 'serial-agent',
      allowedTools: ['*'],
      customTools: {
        circular_probe: () => circular,
        bigint_probe: () => ({ count: BigInt(9007199254740991) })
      }
    }, createMockModel(async () => {
      completions++;
      if (completions === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_circ', type: 'function', function: { name: 'circular_probe', arguments: '{}' } },
            { id: 'call_big', type: 'function', function: { name: 'bigint_probe', arguments: '{}' } }
          ]
        };
      }
      return { role: 'assistant', content: 'Recovered from unserializable tool results.', tool_calls: null };
    }));

    const turnResult = await runtime.executeAgentTurn('serial-agent', 'Probe serialization safety');
    assert.equal(turnResult.output, 'Recovered from unserializable tool results.');

    const toolMsgs = agent.history.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 2, 'Both unserializable probes must be contained as tool responses');
    for (const msg of toolMsgs) {
      assert.equal(typeof msg.content, 'string');
      const parsed = JSON.parse(msg.content);
      assert.equal(parsed.success, false);
    }

    runtime.destroy();
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-10] Accurate Kill Reporting & Spawn Cleanup
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-10] Accurate Kill Reporting & Spawn Cleanup ---');

await runTestScenario(
  'AC17-10.1',
  'AC-EPIC17-10',
  'Terminating non-existent agent returns EXECUTION_FAILED; failed spawn cleanly unwinds runtime registration',
  'TURN-11 & TURN-10: Accurate kill reporting and no live orphan agents on spawn failure',
  async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus });

    const dispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      messagingBus: bus,
      runtime,
      agentId: 'director',
      privileged: true,
      allowedTools: ['*']
    });

    // 1. Terminate non-existent agent
    const killRes = await dispatcher.executeTool('runtime_killAgent', {
      agentId: 'ghost_non_existent_agent'
    });
    assert.equal(killRes.success, false);
    assert.equal(killRes.code, 'EXECUTION_FAILED');
    assert.ok(killRes.error.includes('not found'));

    // 2. Spawn failure unwinding
    const initialTurnFailFn = async () => {
      throw new Error('LLM Provider Outage during launch');
    };

    let spawnThrew = false;
    try {
      await runtime.launchAgent(
        { id: 'failing-agent', name: 'Failing Agent' },
        createMockModel(initialTurnFailFn),
        'Initial greeting prompt'
      );
    } catch (err) {
      spawnThrew = true;
      assert.ok(err.message.includes('LLM Provider Outage'));
    }

    assert.equal(spawnThrew, true, 'launchAgent should have thrown on turn failure');
    assert.equal(runtime.getAgent('failing-agent'), null, 'Failed agent must NOT remain in runtime.agents');
    assert.equal(bus.isRegistered('failing-agent'), false, 'Failed agent must NOT remain registered in messagingBus');
    assert.equal(bus.getPolicy('failing-agent'), undefined, 'Failed agent must have no live bus policy after unwind');

    // Observable no-subscription outcome: mail cannot be accepted and no inbox remains.
    const postUnwindPing = bus.sendMessage({ from: 'test-harness', to: 'failing-agent', content: 'post-unwind probe' });
    assert.equal(postUnwindPing.success, false, 'Failed agent must not accept messages after spawn unwind');
    assert.equal(postUnwindPing.code, 'RECIPIENT_NOT_FOUND', 'Failed agent must be reported as an unknown recipient');
    assert.equal(bus.getUnreadCount('failing-agent'), 0, 'Failed agent must have no live mailbox awaiting delivery');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-11] Validated Snapshot Import
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-11] Validated Snapshot Import ---');

await runTestScenario(
  'AC17-11.1',
  'AC-EPIC17-11',
  'Snapshot validation rejects prototype pollution keys and enforces private workspace ownership',
  'SEC-12: Snapshot import is authorized and validated, rejecting prototype keys and forged ownership',
  async () => {
    // 1. validateSandboxState rejects prototype pollution keys
    const hostileState1 = JSON.parse('{"version":"1.0.0","timestamp":1700000000,"agents":[],"virtualFs":{"__proto__":{"evil.txt":{"content":"polluted"}}}}');
    const valRes1 = validateSandboxState(hostileState1);
    assert.equal(valRes1.valid, false);
    assert.ok(valRes1.error.includes('prototype pollution'));

    const hostileState2 = JSON.parse('{"version":"1.0.0","timestamp":1700000000,"agents":[],"virtualFs":{"agent-ws":{"__proto__":{"content":"polluted"}}}}');
    const valRes2 = validateSandboxState(hostileState2);
    assert.equal(valRes2.valid, false);
    assert.ok(valRes2.error.includes('prototype pollution'));

    // 2. VirtualFS.importSnapshot sanitizes prototype keys and enforces private
    // ownership. Tenant administration requires the trusted construction
    // principal (MOD-21 W8-D), injected here as the composition root would.
    const adminPrincipal = Object.freeze({ kind: 'internal', subject: 'test-operator' });
    const vfs = new VirtualFS({ internalPrincipal: adminPrincipal });
    const rawSnapshot = JSON.parse('{"agent-alice":{"secret.txt":{"content":"Alice secret","owner":"attacker-bob"}},"__proto__":{"polluted.txt":{"content":"should not exist"}},"global":{"shared.txt":{"content":"Global shared text","owner":"system"}}}');

    vfs.importSnapshot(rawSnapshot, { principal: adminPrincipal });

    // Verify prototype key was ignored
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted.txt'), false);

    // Verify private workspace file ownership integrity: owner forced to 'agent-alice'
    const fileRecord = vfs.getFileRecord('/secret.txt', { workspaceId: 'agent-alice', callerAgentId: 'agent-alice' });
    assert.ok(fileRecord, 'File /secret.txt must exist in agent-alice workspace');
    assert.equal(fileRecord.owner, 'agent-alice', 'Private workspace file owner must be strictly enforced as the workspace ID');
    assert.equal(fileRecord.content, 'Alice secret');
  }
);

// -----------------------------------------------------------------------------
// [AC-EPIC17-12] Zero-Mock Black-Box QA Gate & Clean Build Verification
// -----------------------------------------------------------------------------
console.log('\n--- [AC-EPIC17-12] Zero-Mock Black-Box QA Gate & Clean Build Verification ---');

await runTestScenario(
  'AC17-12.1',
  'AC-EPIC17-12',
  'Production build verification (npm run build exits 0)',
  'Build integrity: Vite production bundle compiles cleanly with 0 errors',
  async () => {
    const buildOutput = execSync('npm run build', {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8'
    });
    assert.ok(buildOutput.includes('built in') || buildOutput.includes('dist'), 'Build output should confirm clean bundle creation');
  }
);

console.log('\n======================================================================');
console.log(`  EPIC 17 QA VERIFICATION RESULTS: ${totalPassed} PASSED, ${totalFailed} FAILED (TOTAL: ${totalPassed + totalFailed})`);
console.log('======================================================================\n');

// Write QA summary artifacts
const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const qaReportPath = path.join(dataDir, 'phase3_qa_results.json');
fs.writeFileSync(qaReportPath, JSON.stringify({
  suite: 'EPIC-17 Zero-Mock Verification Suite',
  timestamp: new Date().toISOString(),
  totalPassed,
  totalFailed,
  scenarios: recordedScenarios
}, null, 2));

const mdReportPath = path.join(dataDir, 'phase3_qa_results.md');
const mdContent = `# Phase 3: QA Black-Box Test Results — Epic 17
## Turn Completion Summary Carrier, Intentional Presentation, Precall Revalidation & Runtime Fault Containment

**Timestamp:** ${new Date().toISOString()}  
**Total Tests:** ${totalPassed + totalFailed}  
**Passed:** ${totalPassed}  
**Failed:** ${totalFailed}  
**Status:** ${totalFailed === 0 ? 'ALL ACCEPTANCE CRITERIA SATISFIED (100% PASS)' : 'FAILURES DETECTED'}

| Test ID | Criteria ID | Description | Duration (ms) | Status |
|---|---|---|---|---|
${recordedScenarios.map(s => `| \`${s.testId}\` | \`${s.criteriaId}\` | ${s.title} | ${s.durationMs}ms | **${s.status}** |`).join('\n')}
`;
fs.writeFileSync(mdReportPath, mdContent);

if (totalFailed > 0) {
  process.exit(1);
}

