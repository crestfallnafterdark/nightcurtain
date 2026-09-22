/**
 * @file tests/unit/runtime_telemetry_module_test.js
 * @description Comprehensive unit and contract tests for Module 12: RuntimeTelemetry.
 * Validates strict compliance with runtimeTelemetry/index.ts:
 *   1. Strict Export Whitelist, Constants, and Static Error Codes
 *   2. Instantiation, Default Configurations, and Capacity Clamping
 *   3. Lazy Agent Metrics Initialization & Sovereign Defensive Snapshots (INV-1)
 *   4. Invalid Agent Identifier Validation & Error Codes (INV-1)
 *   5. Two-Tier Token Accounting: Tier 1 Explicit Overrides (INV-4)
 *   6. Two-Tier Token Accounting: Tier 2 Provider Usage Metadata (INV-4)
 *   7. Two-Tier Token Accounting: Absent Explicit/Provider Counts Resolve to Zero (INV-4)
 *   8. Token Accounting Payload Clamping & Non-Negative Monotonicity (INV-3)
 *   9. Tool Execution Recording & Aggregate Counting
 *  10. Terminal Stop Telemetry & Cumulative Accounting
 *  11. Injected Mail Delivery & Precall Dispatch Accounting
 *  12. Bounded Context Snapshotting, Safe Role Distribution & Blob Truncation (INV-6)
 *  13. Arbitrary Event Recording & Type Validation
 *  14. Bounded Ring Buffer FIFO Eviction & Trace Query Filtering (INV-2)
 *  15. Trace Ring Buffer Selective & Global Clearing (INV-2)
 *  16. Observer Subscription, Delivery & Unsubscription
 *  17. Subscriber Exception Shielding & Non-Disruption Guarantee (INV-5)
 *  18. External Sink Attachment, Delivery, Detach & Exception Shielding (INV-5)
 *  19. Single Agent Metrics Reset & Telemetry Reset Events (INV-3)
 *  20. Runtime Aggregate Metrics & Clear All Metrics
 *  21. Backward Compatibility Facades (initializeTelemetry, getAgentTelemetry, clearAgentTelemetry)
 *  22. ICD-A2 (841111b): defensive-copy isolation, seed integer invariants, send-path
 *      bounding, and legacy hydration [] semantics
 *  23. ICD-A3 (dbeb5d4): non-plain entries (class instances, Map/Set/Date) are copied
 *      and mutation-isolated; caller objects survive truncation; captured containers
 *      are hardened against snapshot-side mutation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as TelemetryModule from '../../src/lib/sandbox/runtime/runtimeTelemetry/index.ts';

const {
  RuntimeTelemetry,
  createTelemetryCollector,
  RuntimeTelemetryTracker,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_ERROR_CODES
} = TelemetryModule;

// ============================================================================
// 1. Strict Export Whitelist, Constants, and Static Error Codes
// ============================================================================

test('1. Strict Export Whitelist, Constants, and Static Error Codes', () => {
  const exportedKeys = Object.keys(TelemetryModule).sort();
  assert.deepStrictEqual(exportedKeys, [
    'RuntimeTelemetry',
    'RuntimeTelemetryTracker',
    'TELEMETRY_ERROR_CODES',
    'TELEMETRY_EVENT_TYPES',
    'createTelemetryCollector'
  ]);

  // Verify TELEMETRY_EVENT_TYPES
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TURN_START, 'turn_start');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TURN_COMPLETE, 'turn_complete');
  // Dead code removed: turn errors are surfaced by the turn engine's own `error`
  // event, so telemetry never emitted the declared `TURN_ERROR` type.
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TURN_ERROR, undefined);
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TOOL_EXECUTION, 'tool_execution');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TOKEN_USAGE, 'token_usage');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TERMINAL_STOP, 'terminal_stop');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.INJECTED_DELIVERY, 'injected_delivery');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.PRECALL_DISPATCH, 'precall_dispatch');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.CONTEXT_SNAPSHOT, 'context_snapshot');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TELEMETRY_RESET, 'telemetry_reset');
  assert.strictEqual(TELEMETRY_EVENT_TYPES.TELEMETRY_UPDATE, 'telemetry_update');
  assert.ok(Object.isFrozen(TELEMETRY_EVENT_TYPES));

  // Verify TELEMETRY_ERROR_CODES
  assert.strictEqual(TELEMETRY_ERROR_CODES.INVALID_AGENT_ID, 'ERR_TELEMETRY_INVALID_AGENT_ID');
  // Dead codes removed: usage payloads are clamped, never warned
  // (ERR_TELEMETRY_INVALID_USAGE_PAYLOAD) and ring eviction is silent by design
  // (ERR_TELEMETRY_BUFFER_OVERFLOW).
  assert.strictEqual(TELEMETRY_ERROR_CODES.INVALID_USAGE_PAYLOAD, undefined);
  assert.strictEqual(TELEMETRY_ERROR_CODES.INVALID_EVENT_TYPE, 'ERR_TELEMETRY_INVALID_EVENT_TYPE');
  assert.strictEqual(TELEMETRY_ERROR_CODES.BUFFER_OVERFLOW, undefined);
  assert.strictEqual(TELEMETRY_ERROR_CODES.SUBSCRIBER_EXCEPTION, 'ERR_TELEMETRY_SUBSCRIBER_EXCEPTION');
  assert.strictEqual(TELEMETRY_ERROR_CODES.SINK_DISPATCH_FAILED, 'ERR_TELEMETRY_SINK_DISPATCH_FAILED');
  assert.ok(Object.isFrozen(TELEMETRY_ERROR_CODES));

  // Static class properties
  assert.strictEqual(RuntimeTelemetry.EVENT_TYPES, TELEMETRY_EVENT_TYPES);
  assert.strictEqual(RuntimeTelemetry.ERROR_CODES, TELEMETRY_ERROR_CODES);
  assert.strictEqual(RuntimeTelemetryTracker, RuntimeTelemetry);
  assert.strictEqual(typeof createTelemetryCollector, 'function');
});

// ============================================================================
// 2. Instantiation, Default Configurations, and Capacity Clamping
// ============================================================================

test('2. Instantiation, Default Configurations, and Capacity Clamping', () => {
  const defaultTelemetry = new RuntimeTelemetry();
  assert.ok(defaultTelemetry instanceof RuntimeTelemetry);

  const factoryTelemetry = createTelemetryCollector({
    maxTraceEventsPerAgent: 50,
    maxGlobalTraceEvents: 250
  });
  assert.ok(factoryTelemetry instanceof RuntimeTelemetry);

  // Clamping test: non-positive numbers clamped to >= 1
  const clampedTelemetry = new RuntimeTelemetry({
    maxTraceEventsPerAgent: -10,
    maxGlobalTraceEvents: 0
  });
  assert.ok(clampedTelemetry instanceof RuntimeTelemetry);

  const initialAggregate = defaultTelemetry.getRuntimeMetrics();
  assert.strictEqual(initialAggregate.cumulativeInputTokens, 0);
  assert.strictEqual(initialAggregate.cumulativeOutputTokens, 0);
  assert.strictEqual(initialAggregate.cumulativeTotalTokens, 0);
  assert.strictEqual(initialAggregate.totalTurnCount, 0);
  assert.strictEqual(initialAggregate.totalTerminalStops, 0);
  assert.strictEqual(initialAggregate.totalInjectedDeliveries, 0);
  assert.strictEqual(initialAggregate.totalPrecallCount, 0);
  assert.strictEqual(initialAggregate.totalToolExecutions, 0);
  assert.strictEqual(initialAggregate.activeAgentsCount, 0);
  assert.strictEqual(typeof initialAggregate.lastUpdated, 'number');
  assert.ok(Object.isFrozen(initialAggregate));
});

// ============================================================================
// 3. Lazy Agent Metrics Initialization & Sovereign Defensive Snapshots (INV-1)
// ============================================================================

test('3. Lazy Agent Metrics Initialization & Sovereign Defensive Snapshots (INV-1)', () => {
  const telemetry = new RuntimeTelemetry();

  // Lazy initialization of untracked agent
  const metrics = telemetry.getAgentMetrics('agent_writer_01');
  assert.strictEqual(metrics.agentId, 'agent_writer_01');
  assert.strictEqual(metrics.inputTokens, 0);
  assert.strictEqual(metrics.outputTokens, 0);
  assert.strictEqual(metrics.totalTokens, 0);
  assert.strictEqual(metrics.turnCount, 0);
  assert.strictEqual(metrics.lastPromptTokens, 0);
  assert.strictEqual(metrics.lastCompletionTokens, 0);
  assert.strictEqual(metrics.terminalStops, 0);
  assert.strictEqual(metrics.injectedDeliveries, 0);
  assert.strictEqual(metrics.precallCount, 0);
  assert.strictEqual(metrics.toolExecutionCount, 0);
  assert.deepStrictEqual(metrics.lastSentContext, []);
  assert.ok(Object.isFrozen(metrics));
  assert.ok(Object.isFrozen(metrics.lastSentContext));

  // Active agents count incremented to 1
  assert.strictEqual(telemetry.getRuntimeMetrics().activeAgentsCount, 1);

  // Defensive copy invariant: mutating external snapshot object throws (frozen)
  assert.throws(() => {
    // @ts-ignore
    metrics.inputTokens = 999;
  }, TypeError);

  // Subsequent queries return identical state
  const metrics2 = telemetry.getAgentMetrics('agent_writer_01');
  assert.strictEqual(metrics2.inputTokens, 0);
});

// ============================================================================
// 4. Invalid Agent Identifier Validation & Error Codes (INV-1)
// ============================================================================

test('4. Invalid Agent Identifier Validation & Error Codes (INV-1)', () => {
  const telemetry = new RuntimeTelemetry();

  const invalidIdentifiers = ['', '   ', null, undefined, 123, {}, []];

  for (const invalidId of invalidIdentifiers) {
    assert.throws(() => {
      // @ts-ignore
      telemetry.getAgentMetrics(invalidId);
    }, (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.code, TELEMETRY_ERROR_CODES.INVALID_AGENT_ID);
      assert.ok(err.message.includes(TELEMETRY_ERROR_CODES.INVALID_AGENT_ID));
      return true;
    });

    assert.throws(() => {
      // @ts-ignore
      telemetry.resetAgentMetrics(invalidId);
    }, (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.code, TELEMETRY_ERROR_CODES.INVALID_AGENT_ID);
      return true;
    });

    assert.throws(() => {
      // @ts-ignore
      telemetry.recordTurnUsage(invalidId, {});
    }, (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.code, TELEMETRY_ERROR_CODES.INVALID_AGENT_ID);
      return true;
    });

    assert.throws(() => {
      // @ts-ignore
      telemetry.recordToolExecution(invalidId, { toolName: 'test', durationMs: 10, status: 'success' });
    }, (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.code, TELEMETRY_ERROR_CODES.INVALID_AGENT_ID);
      return true;
    });
  }
});

// ============================================================================
// 5. Two-Tier Token Accounting: Tier 1 Explicit Overrides (INV-4)
// ============================================================================

test('5. Two-Tier Token Accounting: Tier 1 Explicit Overrides (INV-4)', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  const result = telemetry.recordTurnUsage('agent_alpha', {
    turnPromptTokens: 250,
    turnCompletionTokens: 120,
    turnUsage: { prompt_tokens: 999, completion_tokens: 888 },
    formattedMessages: 'Overridden prompt text that should not be estimated',
    responseContent: 'Overridden response content that should not be estimated'
  });

  assert.strictEqual(result.turnPromptTokens, 250);
  assert.strictEqual(result.turnCompletionTokens, 120);
  assert.strictEqual(result.telemetry.inputTokens, 250);
  assert.strictEqual(result.telemetry.outputTokens, 120);
  assert.strictEqual(result.telemetry.totalTokens, 370);
  assert.strictEqual(result.telemetry.turnCount, 1);
  assert.strictEqual(result.telemetry.lastPromptTokens, 250);
  assert.strictEqual(result.telemetry.lastCompletionTokens, 120);

  // Events emitted: TOKEN_USAGE, TURN_COMPLETE, TELEMETRY_UPDATE
  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].type, TELEMETRY_EVENT_TYPES.TOKEN_USAGE);
  assert.strictEqual(events[0].payload.turnPromptTokens, 250);
  assert.strictEqual(events[0].payload.turnCompletionTokens, 120);
  assert.strictEqual(events[0].payload.cumulativeTotalTokens, 370);

  assert.strictEqual(events[1].type, TELEMETRY_EVENT_TYPES.TURN_COMPLETE);
  assert.strictEqual(events[1].payload.turnNumber, 1);
  assert.strictEqual(events[1].payload.turnPromptTokens, 250);
  assert.strictEqual(events[1].payload.turnCompletionTokens, 120);

  assert.strictEqual(events[2].type, TELEMETRY_EVENT_TYPES.TELEMETRY_UPDATE);
  assert.strictEqual(events[2].payload.turnPromptTokens, 250);
  assert.strictEqual(events[2].payload.turnCompletionTokens, 120);
});

test('5.1 TurnUsagePayload.durationMs is declared and surfaced on TURN_COMPLETE', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  telemetry.recordTurnUsage('agent_duration', {
    turnPromptTokens: 10,
    turnCompletionTokens: 5,
    durationMs: 250
  });
  telemetry.recordTurnUsage('agent_duration', {
    turnPromptTokens: 10,
    turnCompletionTokens: 5,
    durationMs: -50
  });

  const completes = events.filter((e) => e.type === TELEMETRY_EVENT_TYPES.TURN_COMPLETE);
  assert.strictEqual(completes.length, 2);
  assert.strictEqual(completes[0].payload.durationMs, 250);
  assert.strictEqual(completes[1].payload.durationMs, 0, 'negative durationMs clamps to 0');
});

// ============================================================================
// 6. Two-Tier Token Accounting: Tier 2 Provider Usage Metadata (INV-4)
// ============================================================================

test('6. Two-Tier Token Accounting: Tier 2 Provider Usage Metadata (INV-4)', () => {
  const telemetry = new RuntimeTelemetry();

  // Test standard snake_case provider usage
  const res1 = telemetry.recordTurnUsage('agent_beta', {
    turnUsage: {
      prompt_tokens: 180,
      completion_tokens: 65,
      total_tokens: 245
    },
    formattedMessages: 'This prompt text should be ignored due to provider usage',
    responseContent: 'This response should be ignored due to provider usage'
  });

  assert.strictEqual(res1.turnPromptTokens, 180);
  assert.strictEqual(res1.turnCompletionTokens, 65);
  assert.strictEqual(res1.telemetry.inputTokens, 180);
  assert.strictEqual(res1.telemetry.outputTokens, 65);
  assert.strictEqual(res1.telemetry.totalTokens, 245);

  // Test camelCase provider usage
  const res2 = telemetry.recordTurnUsage('agent_beta', {
    turnUsage: {
      promptTokens: 120,
      completionTokens: 35,
      totalTokens: 155
    }
  });

  assert.strictEqual(res2.turnPromptTokens, 120);
  assert.strictEqual(res2.turnCompletionTokens, 35);
  assert.strictEqual(res2.telemetry.inputTokens, 300); // 180 + 120
  assert.strictEqual(res2.telemetry.outputTokens, 100); // 65 + 35
  assert.strictEqual(res2.telemetry.totalTokens, 400);
  assert.strictEqual(res2.telemetry.turnCount, 2);
});

// ============================================================================
// 7. Two-Tier Token Accounting: Absent Explicit/Provider Counts Resolve to Zero (INV-4)
// ============================================================================

test('7. Two-Tier Token Accounting: Absent Explicit/Provider Counts Resolve to Zero (INV-4)', () => {
  const telemetry = new RuntimeTelemetry();

  const formattedMessages = [
    { role: 'system', content: '1234' },
    { role: 'user', content: '123456' }
  ];

  const res = telemetry.recordTurnUsage('agent_gamma', {
    formattedMessages,
    responseContent: '12345678',
    responseReasoning: '1234'
  });

  // Text payloads no longer contribute token counts.
  assert.strictEqual(res.turnPromptTokens, 0);
  assert.strictEqual(res.turnCompletionTokens, 0);
  assert.strictEqual(res.telemetry.inputTokens, 0);
  assert.strictEqual(res.telemetry.outputTokens, 0);
  assert.strictEqual(res.telemetry.totalTokens, 0);
  assert.strictEqual(res.telemetry.turnCount, 1);

  // The formatted messages are still captured for context auditing.
  assert.deepStrictEqual(res.telemetry.lastSentContext, formattedMessages);

  // Context snapshot accounting sums explicit finite non-negative tokenCount values only.
  const snapshot = telemetry.recordContextSnapshot('agent_gamma', [
    { role: 'system', content: '1234', tokenCount: 2 },
    { role: 'user', content: '123456', tokenCount: 3 },
    { role: 'assistant', content: 'unreported' },
    { role: 'assistant', content: 'reported zero', tokenCount: 0 },
    { role: 'assistant', content: 'negative', tokenCount: -5 },
    { role: 'assistant', content: 'non-finite', tokenCount: NaN },
    { role: 'string message' }
  ]);
  assert.strictEqual(snapshot.estimatedTokens, 5);
});

// ============================================================================
// 8. Token Accounting Payload Clamping & Non-Negative Monotonicity (INV-3)
// ============================================================================

test('8. Token Accounting Payload Clamping & Non-Negative Monotonicity (INV-3)', () => {
  const telemetry = new RuntimeTelemetry();

  // Negative token counts are safely clamped to 0
  const res1 = telemetry.recordTurnUsage('agent_clamp', {
    turnPromptTokens: -100,
    turnCompletionTokens: -50
  });

  assert.strictEqual(res1.turnPromptTokens, 0);
  assert.strictEqual(res1.turnCompletionTokens, 0);
  assert.strictEqual(res1.telemetry.inputTokens, 0);
  assert.strictEqual(res1.telemetry.outputTokens, 0);
  assert.strictEqual(res1.telemetry.totalTokens, 0);

  // Floating point values are floored to non-negative integers
  const res2 = telemetry.recordTurnUsage('agent_clamp', {
    turnPromptTokens: 42.9,
    turnCompletionTokens: 18.2
  });

  assert.strictEqual(res2.turnPromptTokens, 42);
  assert.strictEqual(res2.turnCompletionTokens, 18);
  assert.strictEqual(res2.telemetry.inputTokens, 42);
  assert.strictEqual(res2.telemetry.outputTokens, 18);
  assert.strictEqual(res2.telemetry.totalTokens, 60);
  assert.strictEqual(res2.telemetry.turnCount, 2);
});

// ============================================================================
// 9. Tool Execution Recording & Aggregate Counting
// ============================================================================

test('9. Tool Execution Recording & Aggregate Counting', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  telemetry.recordToolExecution('agent_coder', {
    toolName: 'read_file',
    durationMs: 45,
    status: 'success',
    argumentsByteSize: 120,
    resultByteSize: 1024
  });

  telemetry.recordToolExecution('agent_coder', {
    toolName: 'run_command',
    durationMs: 120,
    status: 'error',
    errorCode: 'ERR_TIMEOUT',
    argumentsByteSize: 80,
    resultByteSize: 256
  });

  const metrics = telemetry.getAgentMetrics('agent_coder');
  assert.strictEqual(metrics.toolExecutionCount, 2);

  const aggregate = telemetry.getRuntimeMetrics();
  assert.strictEqual(aggregate.totalToolExecutions, 2);

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].type, TELEMETRY_EVENT_TYPES.TOOL_EXECUTION);
  assert.strictEqual(events[0].payload.toolName, 'read_file');
  assert.strictEqual(events[0].payload.status, 'success');
  assert.strictEqual(events[0].payload.durationMs, 45);

  assert.strictEqual(events[1].payload.toolName, 'run_command');
  assert.strictEqual(events[1].payload.status, 'error');
  assert.strictEqual(events[1].payload.errorCode, 'ERR_TIMEOUT');
});

// ============================================================================
// 10. Terminal Stop Telemetry & Cumulative Accounting
// ============================================================================

test('10. Terminal Stop Telemetry & Cumulative Accounting', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  telemetry.recordTerminalStop('agent_director', {
    reason: 'stop_keyword',
    turnNumber: 4
  });

  telemetry.recordTerminalStop('agent_director', {
    reason: 'max_turns_exceeded'
  });

  const metrics = telemetry.getAgentMetrics('agent_director');
  assert.strictEqual(metrics.terminalStops, 2);

  const aggregate = telemetry.getRuntimeMetrics();
  assert.strictEqual(aggregate.totalTerminalStops, 2);

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].type, TELEMETRY_EVENT_TYPES.TERMINAL_STOP);
  assert.strictEqual(events[0].payload.reason, 'stop_keyword');
  assert.strictEqual(events[0].payload.turnNumber, 4);
});

// ============================================================================
// 11. Injected Mail Delivery & Precall Dispatch Accounting
// ============================================================================

test('11. Injected Mail Delivery & Precall Dispatch Accounting', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  // Injected deliveries
  telemetry.recordInjectedDelivery('agent_mail', 3);
  telemetry.recordInjectedDelivery('agent_mail', 1);

  // Precalls
  telemetry.recordPrecall('agent_mail', 2);
  telemetry.recordPrecall('agent_mail'); // default 1

  const metrics = telemetry.getAgentMetrics('agent_mail');
  assert.strictEqual(metrics.injectedDeliveries, 4);
  assert.strictEqual(metrics.precallCount, 3);

  const aggregate = telemetry.getRuntimeMetrics();
  assert.strictEqual(aggregate.totalInjectedDeliveries, 4);
  assert.strictEqual(aggregate.totalPrecallCount, 3);

  assert.strictEqual(events.length, 4);
  assert.strictEqual(events[0].type, TELEMETRY_EVENT_TYPES.INJECTED_DELIVERY);
  assert.strictEqual(events[0].payload.count, 3);
  assert.strictEqual(events[0].payload.cumulativeDeliveries, 3);

  assert.strictEqual(events[2].type, TELEMETRY_EVENT_TYPES.PRECALL_DISPATCH);
  assert.strictEqual(events[2].payload.count, 2);
  assert.strictEqual(events[2].payload.cumulativePrecalls, 2);
});

// ============================================================================
// 12. Bounded Context Snapshotting, Safe Role Distribution & Blob Truncation (INV-6)
// ============================================================================

test('12. Bounded Context Snapshotting, Safe Role Distribution & Blob Truncation (INV-6)', () => {
  const telemetry = new RuntimeTelemetry();

  const longContent = 'A'.repeat(5000);
  const messages = [
    { role: 'system', content: 'You are an agent.', tokenCount: 7 },
    { role: 'user', content: 'Hello', tokenCount: 3 },
    { role: 'assistant', content: 'Mid turn pruned' },
    { role: 'tool', content: 'tool result', tokenCount: 5 },
    { role: 'user', content: longContent, tokenCount: 1200 }
  ];

  const snapshot = telemetry.recordContextSnapshot('agent_context', messages, {
    maxMessagesToRetain: 4,
    truncateContentAt: 100
  });

  assert.strictEqual(snapshot.messageCount, 5);
  // Reported per-message token counts are summed; the unreported message contributes 0.
  assert.strictEqual(snapshot.estimatedTokens, 1215);
  assert.strictEqual(snapshot.roleDistribution.system, 1);
  assert.strictEqual(snapshot.roleDistribution.user, 2);
  assert.strictEqual(snapshot.roleDistribution.assistant, 1);
  assert.strictEqual(snapshot.roleDistribution.tool, 1);

  // Retention bound: maxMessagesToRetain = 4 retains head (2) and tail (2)
  assert.strictEqual(snapshot.messages.length, 4);

  // Content truncation: 5000 chars truncated to 100 + notice on tail user message
  const truncatedUser = snapshot.messages[snapshot.messages.length - 1];
  assert.strictEqual(truncatedUser.role, 'user');
  assert.ok(truncatedUser.content.length < 200);
  assert.ok(truncatedUser.content.includes('[truncated 4900 chars]'));

  // Mirrored into agent metrics lastSentContext
  const metrics = telemetry.getAgentMetrics('agent_context');
  assert.strictEqual(metrics.lastSentContext.length, 4);
});

test('12.1 lastSentContext is latest-wins across send paths (3675292)', () => {
  const telemetry = new RuntimeTelemetry();

  const firstMessages = [{ role: 'user', content: 'first capture' }];
  telemetry.recordTurnUsage('agent_latest', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: firstMessages
  });

  let metrics = telemetry.getAgentMetrics('agent_latest');
  assert.deepStrictEqual(metrics.lastSentContext, [{ role: 'user', content: 'first capture' }]);

  const secondMessages = [
    { role: 'system', content: 'latest system' },
    { role: 'user', content: 'second capture' }
  ];
  telemetry.recordTurnUsage('agent_latest', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: secondMessages
  });

  metrics = telemetry.getAgentMetrics('agent_latest');
  assert.strictEqual(metrics.lastSentContext.length, 2, 'second send must replace the first capture');
  assert.deepStrictEqual(metrics.lastSentContext, [
    { role: 'system', content: 'latest system' },
    { role: 'user', content: 'second capture' }
  ]);
  assert.ok(Object.isFrozen(metrics.lastSentContext));

  // Defensive copy: mutating the caller array and its message objects after the
  // send must not alter the recorded telemetry.
  secondMessages[0].content = 'mutated after send';
  secondMessages.push({ role: 'user', content: 'appended after send' });
  metrics = telemetry.getAgentMetrics('agent_latest');
  assert.strictEqual(metrics.lastSentContext.length, 2);
  assert.strictEqual(metrics.lastSentContext[0].content, 'latest system');

  // The context-snapshot path is a send path too: the latest pruned/truncated
  // capture replaces whatever recordTurnUsage previously stored.
  const messages = [];
  for (let i = 1; i <= 60; i++) {
    messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `message_${i}` });
  }
  telemetry.recordContextSnapshot('agent_latest', messages, {
    maxMessagesToRetain: 10,
    truncateContentAt: 50
  });

  metrics = telemetry.getAgentMetrics('agent_latest');
  assert.strictEqual(metrics.lastSentContext.length, 10, 'snapshot pruning still bounds lastSentContext');
  assert.strictEqual(metrics.lastSentContext[0].content, 'message_1');
  assert.strictEqual(metrics.lastSentContext[9].content, 'message_60');
  assert.ok(metrics.lastSentContext.every((m) => m.content.length <= 50));
});

test('12.2 lastSentContext hydration fills only when absent; sends always win (3675292)', () => {
  const telemetry = new RuntimeTelemetry();

  // Fresh metrics hydrate from the seed snapshot.
  const seeded = telemetry.initializeTelemetry('agent_hydrate', {
    lastSentContext: [{ role: 'user', content: 'persisted context' }]
  });
  assert.deepStrictEqual(seeded.lastSentContext, [{ role: 'user', content: 'persisted context' }]);

  // A live capture replaces the hydrated value ...
  telemetry.recordTurnUsage('agent_hydrate', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'live capture' }]
  });

  // ... and re-seeding with the older persisted snapshot never clobbers it.
  const reseeded = telemetry.initializeTelemetry('agent_hydrate', {
    lastSentContext: [{ role: 'user', content: 'persisted context' }]
  });
  assert.strictEqual(reseeded.lastSentContext.length, 1);
  assert.strictEqual(reseeded.lastSentContext[0].content, 'live capture');

  // Legacy standalone backfill retains an agent-owned context array.
  const legacyAgent = {
    id: 'agent_legacy_ctx',
    telemetry: { lastSentContext: [{ role: 'user', content: 'agent-owned' }] }
  };
  telemetry.initializeTelemetry(legacyAgent);
  assert.strictEqual(legacyAgent.telemetry.lastSentContext[0].content, 'agent-owned');
});

// ============================================================================
// 13. Arbitrary Event Recording & Type Validation
// ============================================================================

test('13. Arbitrary Event Recording & Type Validation', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  // Valid event
  telemetry.recordEvent({
    type: TELEMETRY_EVENT_TYPES.TURN_START,
    agentId: 'agent_event',
    timestamp: 1000,
    payload: { turnNumber: 1, inputSummary: 'Start analysis' }
  });

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, TELEMETRY_EVENT_TYPES.TURN_START);
  assert.strictEqual(events[0].agentId, 'agent_event');

  // Invalid/unrecognized event type is safely rejected with warning
  telemetry.recordEvent({
    // @ts-ignore
    type: 'unrecognized_custom_type',
    agentId: 'agent_event',
    payload: {}
  });

  // Null/non-object is safely ignored
  // @ts-ignore
  telemetry.recordEvent(null);
  // @ts-ignore
  telemetry.recordEvent(undefined);

  assert.strictEqual(events.length, 1, 'Invalid events must not be dispatched');
});

// ============================================================================
// 14. Bounded Ring Buffer FIFO Eviction & Trace Query Filtering (INV-2)
// ============================================================================

test('14. Bounded Ring Buffer FIFO Eviction & Trace Query Filtering (INV-2)', () => {
  // Capacity of 3 events per agent, 5 globally
  const telemetry = new RuntimeTelemetry({
    maxTraceEventsPerAgent: 3,
    maxGlobalTraceEvents: 5
  });

  for (let i = 1; i <= 5; i++) {
    telemetry.recordToolExecution('agent_ring', {
      toolName: `tool_${i}`,
      durationMs: i * 10,
      status: 'success',
      timestamp: 1000 + i
    });
  }

  // Agent ring buffer has capacity 3: oldest items (1, 2) evicted, items 3, 4, 5 retained
  const agentTrace = telemetry.getTrace('agent_ring');
  assert.strictEqual(agentTrace.length, 3);
  assert.strictEqual(agentTrace[0].payload.toolName, 'tool_3');
  assert.strictEqual(agentTrace[1].payload.toolName, 'tool_4');
  assert.strictEqual(agentTrace[2].payload.toolName, 'tool_5');

  // Global ring buffer has capacity 5: all 5 events present
  const globalTrace = telemetry.getTrace();
  assert.strictEqual(globalTrace.length, 5);
  assert.strictEqual(globalTrace[0].payload.toolName, 'tool_1');
  assert.strictEqual(globalTrace[4].payload.toolName, 'tool_5');

  // Query filtering: sinceTimestamp
  const filteredSince = telemetry.getTrace('agent_ring', { sinceTimestamp: 1004 });
  assert.strictEqual(filteredSince.length, 2);
  assert.strictEqual(filteredSince[0].payload.toolName, 'tool_4');
  assert.strictEqual(filteredSince[1].payload.toolName, 'tool_5');

  // Query filtering: order desc and limit
  const descLimited = telemetry.getTrace('agent_ring', { order: 'desc', limit: 2 });
  assert.strictEqual(descLimited.length, 2);
  assert.strictEqual(descLimited[0].payload.toolName, 'tool_5');
  assert.strictEqual(descLimited[1].payload.toolName, 'tool_4');
});

test('14.1 TraceQueryOptions.limit defaults to 100 when omitted', () => {
  const telemetry = new RuntimeTelemetry();

  for (let i = 1; i <= 120; i++) {
    telemetry.recordToolExecution('agent_limit', {
      toolName: `tool_${i}`,
      durationMs: 1,
      status: 'success',
      timestamp: 1000 + i
    });
  }

  // Per-agent ring holds all 120; the default query cap returns the oldest 100
  const defaulted = telemetry.getTrace('agent_limit');
  assert.strictEqual(defaulted.length, 100);
  assert.strictEqual(defaulted[0].payload.toolName, 'tool_1');
  assert.strictEqual(defaulted[99].payload.toolName, 'tool_100');

  // Global trace uses the same default cap
  assert.strictEqual(telemetry.getTrace().length, 100);

  // Descending order + default cap returns the newest 100
  const newest = telemetry.getTrace('agent_limit', { order: 'desc' });
  assert.strictEqual(newest.length, 100);
  assert.strictEqual(newest[0].payload.toolName, 'tool_120');

  // Explicit limit still wins (including 0)
  assert.strictEqual(telemetry.getTrace('agent_limit', { limit: 5 }).length, 5);
  assert.strictEqual(telemetry.getTrace('agent_limit', { limit: 0 }).length, 0);
});

// ============================================================================
// 15. Trace Ring Buffer Selective & Global Clearing (INV-2)
// ============================================================================

test('15. Trace Ring Buffer Selective & Global Clearing (INV-2)', () => {
  const telemetry = new RuntimeTelemetry();

  telemetry.recordToolExecution('agent_1', { toolName: 't1', durationMs: 10, status: 'success' });
  telemetry.recordToolExecution('agent_2', { toolName: 't2', durationMs: 20, status: 'success' });

  assert.strictEqual(telemetry.getTrace('agent_1').length, 1);
  assert.strictEqual(telemetry.getTrace('agent_2').length, 1);
  assert.strictEqual(telemetry.getTrace().length, 2);

  // Selective clear of agent_1
  telemetry.clearTrace('agent_1');
  assert.strictEqual(telemetry.getTrace('agent_1').length, 0);
  assert.strictEqual(telemetry.getTrace('agent_2').length, 1);

  // Global clear
  telemetry.clearTrace();
  assert.strictEqual(telemetry.getTrace('agent_2').length, 0);
  assert.strictEqual(telemetry.getTrace().length, 0);
});

// ============================================================================
// 16. Observer Subscription, Delivery & Unsubscription
// ============================================================================

test('16. Observer Subscription, Delivery & Unsubscription', () => {
  const telemetry = new RuntimeTelemetry();
  const received = [];

  const unsubscribe = telemetry.subscribe((event) => {
    received.push(event);
  });

  telemetry.recordTurnUsage('agent_sub', { turnPromptTokens: 10, turnCompletionTokens: 20 });
  assert.ok(received.length >= 2);

  const countBeforeUnsub = received.length;
  unsubscribe();

  telemetry.recordTurnUsage('agent_sub', { turnPromptTokens: 10, turnCompletionTokens: 20 });
  assert.strictEqual(received.length, countBeforeUnsub, 'Unsubscribed listener must receive no further events');

  // Invalid listener
  assert.throws(() => {
    // @ts-ignore
    telemetry.subscribe(null);
  }, TypeError);
});

// ============================================================================
// 17. Subscriber Exception Shielding & Non-Disruption Guarantee (INV-5)
// ============================================================================

test('17. Subscriber Exception Shielding & Non-Disruption Guarantee (INV-5)', () => {
  const telemetry = new RuntimeTelemetry();
  const validReceiver = [];

  // Broken subscriber that throws
  telemetry.subscribe(() => {
    throw new Error('Explosive error in subscriber callback');
  });

  // Healthy subscriber
  telemetry.subscribe((event) => {
    validReceiver.push(event);
  });

  // recordTurnUsage should not throw despite the throwing subscriber
  assert.doesNotThrow(() => {
    telemetry.recordTurnUsage('agent_shield', {
      turnPromptTokens: 50,
      turnCompletionTokens: 50
    });
  });

  assert.ok(validReceiver.length >= 2, 'Healthy subscriber must receive events even if another subscriber throws');
});

// ============================================================================
// 18. External Sink Attachment, Delivery, Detach & Exception Shielding (INV-5)
// ============================================================================

test('18. External Sink Attachment, Delivery, Detach & Exception Shielding (INV-5)', () => {
  const telemetry = new RuntimeTelemetry();
  const sinkEvents = [];

  const sink = {
    emit(event) {
      sinkEvents.push(event);
    }
  };

  const detach = telemetry.attachSink(sink);

  telemetry.recordToolExecution('agent_sink', { toolName: 'test', durationMs: 15, status: 'success' });
  assert.strictEqual(sinkEvents.length, 1);
  assert.strictEqual(sinkEvents[0].type, TELEMETRY_EVENT_TYPES.TOOL_EXECUTION);

  detach();

  telemetry.recordToolExecution('agent_sink', { toolName: 'test2', durationMs: 25, status: 'success' });
  assert.strictEqual(sinkEvents.length, 1, 'Detached sink must receive no further events');

  // Faulty sink shielding test
  const brokenSink = {
    emit() {
      throw new Error('Sink transport failure');
    }
  };
  telemetry.attachSink(brokenSink);

  assert.doesNotThrow(() => {
    telemetry.recordToolExecution('agent_sink', { toolName: 'test3', durationMs: 35, status: 'success' });
  });

  // Invalid sink argument
  assert.throws(() => {
    // @ts-ignore
    telemetry.attachSink(null);
  }, TypeError);
});

// ============================================================================
// 19. Single Agent Metrics Reset & Telemetry Reset Events (INV-3)
// ============================================================================

test('19. Single Agent Metrics Reset & Telemetry Reset Events (INV-3)', () => {
  const telemetry = new RuntimeTelemetry();
  const events = [];
  telemetry.subscribe((e) => events.push(e));

  telemetry.recordTurnUsage('agent_reset', { turnPromptTokens: 100, turnCompletionTokens: 50 });
  telemetry.recordToolExecution('agent_reset', { toolName: 'tool1', durationMs: 10, status: 'success' });
  telemetry.recordTerminalStop('agent_reset', { reason: 'stop' });
  telemetry.recordInjectedDelivery('agent_reset', 2);
  telemetry.recordPrecall('agent_reset', 1);

  let metrics = telemetry.getAgentMetrics('agent_reset');
  assert.strictEqual(metrics.totalTokens, 150);
  assert.strictEqual(metrics.turnCount, 1);
  assert.strictEqual(metrics.toolExecutionCount, 1);
  assert.strictEqual(metrics.terminalStops, 1);
  assert.strictEqual(metrics.injectedDeliveries, 2);
  assert.strictEqual(metrics.precallCount, 1);

  // Reset agent metrics
  const resetSuccess = telemetry.resetAgentMetrics('agent_reset');
  assert.strictEqual(resetSuccess, true);

  metrics = telemetry.getAgentMetrics('agent_reset');
  assert.strictEqual(metrics.inputTokens, 0);
  assert.strictEqual(metrics.outputTokens, 0);
  assert.strictEqual(metrics.totalTokens, 0);
  assert.strictEqual(metrics.turnCount, 0);
  assert.strictEqual(metrics.lastPromptTokens, 0);
  assert.strictEqual(metrics.lastCompletionTokens, 0);
  assert.strictEqual(metrics.toolExecutionCount, 0);
  assert.strictEqual(metrics.terminalStops, 0);
  assert.strictEqual(metrics.injectedDeliveries, 0);
  assert.strictEqual(metrics.precallCount, 0);

  // TELEMETRY_RESET event emitted
  const resetEvent = events.find((e) => e.type === TELEMETRY_EVENT_TYPES.TELEMETRY_RESET);
  assert.ok(resetEvent);
  assert.strictEqual(resetEvent.agentId, 'agent_reset');
  assert.strictEqual(resetEvent.payload.telemetry.totalTokens, 0);

  // Reset on non-tracked agent returns false
  const untrackedReset = telemetry.resetAgentMetrics('non_existent_agent');
  assert.strictEqual(untrackedReset, false);
});

// ============================================================================
// 20. Runtime Aggregate Metrics & Clear All Metrics
// ============================================================================

test('20. Runtime Aggregate Metrics & Clear All Metrics', () => {
  const telemetry = new RuntimeTelemetry();

  telemetry.recordTurnUsage('agent_1', { turnPromptTokens: 100, turnCompletionTokens: 50 });
  telemetry.recordTurnUsage('agent_2', { turnPromptTokens: 200, turnCompletionTokens: 100 });
  telemetry.recordToolExecution('agent_1', { toolName: 't1', durationMs: 10, status: 'success' });
  telemetry.recordTerminalStop('agent_2', { reason: 'stop' });

  let aggregate = telemetry.getRuntimeMetrics();
  assert.strictEqual(aggregate.cumulativeInputTokens, 300);
  assert.strictEqual(aggregate.cumulativeOutputTokens, 150);
  assert.strictEqual(aggregate.cumulativeTotalTokens, 450);
  assert.strictEqual(aggregate.totalTurnCount, 2);
  assert.strictEqual(aggregate.totalToolExecutions, 1);
  assert.strictEqual(aggregate.totalTerminalStops, 1);
  assert.strictEqual(aggregate.activeAgentsCount, 2);

  // Clear all
  telemetry.clearAllMetrics();

  aggregate = telemetry.getRuntimeMetrics();
  assert.strictEqual(aggregate.cumulativeInputTokens, 0);
  assert.strictEqual(aggregate.cumulativeOutputTokens, 0);
  assert.strictEqual(aggregate.cumulativeTotalTokens, 0);
  assert.strictEqual(aggregate.totalTurnCount, 0);
  assert.strictEqual(aggregate.totalToolExecutions, 0);
  assert.strictEqual(aggregate.totalTerminalStops, 0);
  assert.strictEqual(aggregate.activeAgentsCount, 0);
  assert.strictEqual(telemetry.getTrace().length, 0);
});

// ============================================================================
// 21. Backward Compatibility Facades (initializeTelemetry, getAgentTelemetry, clearAgentTelemetry)
// ============================================================================

test('21. Backward Compatibility Facades (initializeTelemetry, getAgentTelemetry, clearAgentTelemetry)', () => {
  const telemetry = new RuntimeTelemetry();

  const mockAgent = {
    id: 'agent_legacy',
    telemetry: null
  };

  // initializeTelemetry
  const initialized = telemetry.initializeTelemetry(mockAgent);
  assert.ok(initialized);
  assert.strictEqual(initialized.agentId, 'agent_legacy');
  assert.ok(mockAgent.telemetry);
  assert.strictEqual(mockAgent.telemetry.inputTokens, 0);

  // getAgentTelemetry
  const queriedViaObj = telemetry.getAgentTelemetry(mockAgent);
  assert.strictEqual(queriedViaObj.agentId, 'agent_legacy');

  const queriedViaId = telemetry.getAgentTelemetry('agent_legacy');
  assert.strictEqual(queriedViaId.agentId, 'agent_legacy');

  assert.strictEqual(telemetry.getAgentTelemetry(null), null);
  assert.strictEqual(telemetry.getAgentTelemetry(''), null);

  // Mutate metrics through recordTurnUsage
  telemetry.recordTurnUsage('agent_legacy', { turnPromptTokens: 80, turnCompletionTokens: 20 });
  assert.strictEqual(telemetry.getAgentMetrics('agent_legacy').totalTokens, 100);

  // clearAgentTelemetry
  const cleared = telemetry.clearAgentTelemetry(mockAgent);
  assert.strictEqual(cleared, true);
  assert.strictEqual(telemetry.getAgentMetrics('agent_legacy').totalTokens, 0);
  assert.strictEqual(mockAgent.telemetry.totalTokens, 0);

  // Invalid clearAgentTelemetry returns false
  assert.strictEqual(telemetry.clearAgentTelemetry(null), false);
  assert.strictEqual(telemetry.clearAgentTelemetry(''), false);
});

// ============================================================================
// 22. ICD-A2 (841111b): defensive-copy isolation, seed integer invariants,
//     send-path bounding, and legacy hydration [] semantics
// ============================================================================

test('22. lastSentContext send entries are mutation-isolated and deep-frozen (841111b-a)', () => {
  const telemetry = new RuntimeTelemetry();

  const messages = [
    { role: 'system', content: 'system prompt', metadata: { tag: 'original', flags: ['a'] } }
  ];
  telemetry.recordTurnUsage('agent_deep_copy', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: messages
  });

  // Mutating the caller payload after the send (entry, nested object and array)
  // must not alter internal telemetry state.
  messages[0].content = 'mutated content';
  messages[0].metadata.tag = 'mutated tag';
  messages[0].metadata.flags.push('b');
  messages.push({ role: 'user', content: 'late append' });

  let metrics = telemetry.getAgentMetrics('agent_deep_copy');
  assert.strictEqual(metrics.lastSentContext.length, 1);
  assert.strictEqual(metrics.lastSentContext[0].content, 'system prompt');
  assert.strictEqual(metrics.lastSentContext[0].metadata.tag, 'original');
  assert.deepStrictEqual(metrics.lastSentContext[0].metadata.flags, ['a']);

  // Snapshot entries are deep-frozen: mutation attempts cannot reach internal state.
  const entry = metrics.lastSentContext[0];
  assert.ok(Object.isFrozen(entry), 'message entries must be frozen');
  assert.ok(Object.isFrozen(entry.metadata), 'nested message objects must be frozen');
  assert.throws(() => { entry.content = 'snapshot mutation'; }, TypeError);
  assert.throws(() => { entry.metadata.tag = 'snapshot mutation'; }, TypeError);

  metrics = telemetry.getAgentMetrics('agent_deep_copy');
  assert.strictEqual(metrics.lastSentContext[0].content, 'system prompt');
  assert.strictEqual(metrics.lastSentContext[0].metadata.tag, 'original');
});

test('22.1 recordContextSnapshot return and storage are decoupled and deep-frozen (841111b-a)', () => {
  const telemetry = new RuntimeTelemetry();
  const input = [
    { role: 'system', content: 'sys', metadata: { tag: 'orig' } },
    { role: 'user', content: 'usr' }
  ];

  const snapshot = telemetry.recordContextSnapshot('agent_snapshot_copy', input, {
    maxMessagesToRetain: 10,
    truncateContentAt: 50
  });

  // Caller input mutation after capture must not leak in.
  input[0].metadata.tag = 'input mutated';
  input.push({ role: 'user', content: 'late append' });

  // The returned record is frozen at every reached level: array, entry and nested object.
  assert.throws(() => { snapshot.messages.push({ role: 'user', content: 'evil' }); }, TypeError);
  assert.throws(() => { snapshot.messages[0] = { role: 'user', content: 'replaced' }; }, TypeError);
  assert.throws(() => { snapshot.messages[0].content = 'replaced'; }, TypeError);
  assert.throws(() => { snapshot.messages[0].metadata.tag = 'replaced'; }, TypeError);

  const metrics = telemetry.getAgentMetrics('agent_snapshot_copy');
  assert.notStrictEqual(snapshot.messages, metrics.lastSentContext, 'return must not alias the internal array');
  assert.strictEqual(metrics.lastSentContext.length, 2);
  assert.strictEqual(metrics.lastSentContext[0].content, 'sys');
  assert.strictEqual(metrics.lastSentContext[0].metadata.tag, 'orig');
});

test('22.2 Seeded counters are floored to non-negative integers (841111b-b)', () => {
  const telemetry = new RuntimeTelemetry();
  const seeded = telemetry.initializeTelemetry('agent_seed_round', {
    inputTokens: 3.7,
    outputTokens: -4.2,
    totalTokens: 1e21,
    turnCount: 2.5,
    lastPromptTokens: 9.99,
    lastCompletionTokens: 0.5,
    terminalStops: -0.5,
    injectedDeliveries: 7.2,
    precallCount: 4.8,
    toolExecutionCount: 6.1
  });

  assert.strictEqual(seeded.inputTokens, 3);
  assert.strictEqual(seeded.outputTokens, 0);
  assert.strictEqual(seeded.turnCount, 2);
  assert.strictEqual(seeded.lastPromptTokens, 9);
  assert.strictEqual(seeded.lastCompletionTokens, 0);
  assert.strictEqual(seeded.terminalStops, 0);
  assert.strictEqual(seeded.injectedDeliveries, 7);
  assert.strictEqual(seeded.precallCount, 4);
  assert.strictEqual(seeded.toolExecutionCount, 6);
  assert.ok(Number.isInteger(seeded.totalTokens));
  assert.strictEqual(seeded.totalTokens, Math.floor(1e21));

  // Seeding never lowers an already-recorded counter, and still floors the seed.
  telemetry.recordTurnUsage('agent_seed_round', { turnPromptTokens: 10, turnCompletionTokens: 0 });
  const reseeded = telemetry.initializeTelemetry('agent_seed_round', { inputTokens: 3.7 });
  assert.strictEqual(reseeded.inputTokens, 13, 'seeding must not lower a recorded counter');
});

test('22.3 recordTurnUsage send path applies the INV-6 bound and truncation (841111b-c)', () => {
  const telemetry = new RuntimeTelemetry();
  const longContent = 'B'.repeat(5000);
  const messages = [];
  for (let i = 1; i <= 120; i++) {
    messages.push({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: i === 120 ? longContent : `message_${i}`
    });
  }

  const result = telemetry.recordTurnUsage('agent_send_bound', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: messages
  });

  const captured = result.telemetry.lastSentContext;
  assert.strictEqual(captured.length, 50, 'send path must apply the default retention bound');
  assert.strictEqual(captured[0].content, 'message_1');
  assert.strictEqual(captured[1].content, 'message_2');
  assert.strictEqual(captured[49].role, 'assistant');
  assert.ok(captured[49].content.startsWith('B'.repeat(100)));
  assert.ok(captured[49].content.endsWith('... [truncated 3000 chars]'));
  assert.ok(!captured.some((m) => m.content === 'message_60'), 'middle messages are pruned');

  // A later small send replaces the bounded capture (latest-wins).
  const second = telemetry.recordTurnUsage('agent_send_bound', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'small' }]
  });
  assert.deepStrictEqual(second.telemetry.lastSentContext, [{ role: 'user', content: 'small' }]);
});

test('22.4 Hydration treats [] as absent, copies seeds, and mirrors non-aliased arrays (841111b-d)', () => {
  const telemetry = new RuntimeTelemetry();

  // Seed path: an empty snapshot never clobbers a live in-process capture.
  telemetry.recordTurnUsage('agent_hydrate_empty', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'live capture' }]
  });
  const reseeded = telemetry.initializeTelemetry('agent_hydrate_empty', { lastSentContext: [] });
  assert.strictEqual(reseeded.lastSentContext.length, 1);
  assert.strictEqual(reseeded.lastSentContext[0].content, 'live capture');

  // Legacy backfill: an agent-owned empty array counts as absent and is filled
  // from the live metrics projection (aligned with the seed path's [] rule).
  const legacyEmpty = { id: 'agent_legacy_empty' };
  telemetry.recordTurnUsage(legacyEmpty, {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'live capture' }]
  });
  legacyEmpty.telemetry.lastSentContext = [];
  const hydrated = telemetry.initializeTelemetry(legacyEmpty);
  assert.strictEqual(hydrated.lastSentContext[0].content, 'live capture');
  assert.strictEqual(legacyEmpty.telemetry.lastSentContext.length, 1, '[] on the agent side is treated as absent');

  // A non-empty agent-owned array is retained (latest-wins defense).
  const legacyOwned = {
    id: 'agent_legacy_owned',
    telemetry: { lastSentContext: [{ role: 'user', content: 'agent-owned' }] }
  };
  telemetry.initializeTelemetry(legacyOwned);
  assert.strictEqual(legacyOwned.telemetry.lastSentContext[0].content, 'agent-owned');

  // Mirror path: the agent-facing array is a copy, so mutating it cannot corrupt
  // the internal telemetry record.
  const legacyMirror = { id: 'agent_legacy_mirror' };
  telemetry.recordTurnUsage(legacyMirror, {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'mirrored' }]
  });
  assert.ok(Array.isArray(legacyMirror.telemetry.lastSentContext));
  legacyMirror.telemetry.lastSentContext[0] = { role: 'user', content: 'corrupted' };
  legacyMirror.telemetry.lastSentContext.push({ role: 'user', content: 'extra' });
  const internal = telemetry.getAgentMetrics('agent_legacy_mirror');
  assert.strictEqual(internal.lastSentContext.length, 1);
  assert.strictEqual(internal.lastSentContext[0].content, 'mirrored');

  // Seed hydration deep-copies entries: mutating the seed snapshot afterwards is inert.
  const seed = { lastSentContext: [{ role: 'user', content: 'seed', metadata: { tag: 'seed' } }] };
  telemetry.initializeTelemetry('agent_seed_copy', seed);
  seed.lastSentContext[0].content = 'mutated seed';
  seed.lastSentContext[0].metadata.tag = 'mutated seed';
  const fromSeed = telemetry.getAgentMetrics('agent_seed_copy');
  assert.strictEqual(fromSeed.lastSentContext[0].content, 'seed');
  assert.strictEqual(fromSeed.lastSentContext[0].metadata.tag, 'seed');
  assert.ok(Object.isFrozen(fromSeed.lastSentContext[0]), 'hydrated entries must be frozen');
});

// ============================================================================
// 23. ICD-A3 (dbeb5d4): non-plain entries (class instances, Map/Set/Date) are
//     copied and mutation-isolated; caller objects survive truncation; captured
//     containers are hardened against snapshot-side mutation
// ============================================================================

class TelemetryPayloadBox {
  constructor(tag) {
    this.tag = tag;
  }
}

class TelemetryLiveMessage {
  constructor(content) {
    this.role = 'user';
    this.content = content;
  }
}

test('23. Non-plain entries are copied and mutation-isolated (dbeb5d4-a)', () => {
  const telemetry = new RuntimeTelemetry();

  const box = new TelemetryPayloadBox('original');
  const map = new Map([['key', { nested: 'original' }]]);
  const set = new Set(['original']);
  const date = new Date('2026-01-01T00:00:00.000Z');

  telemetry.recordTurnUsage('agent_nonplain_copy', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'hello', metadata: { box, map, set, date } }]
  });

  // Caller mutation after capture must never be visible in telemetry.
  box.tag = 'mutated';
  map.set('key', { nested: 'mutated' });
  map.set('extra', true);
  set.add('extra');
  date.setTime(0);

  const captured = telemetry.getAgentMetrics('agent_nonplain_copy').lastSentContext[0].metadata;
  assert.notStrictEqual(captured.box, box, 'class instance must not be stored by reference');
  assert.notStrictEqual(captured.map, map, 'Map must not be stored by reference');
  assert.notStrictEqual(captured.set, set, 'Set must not be stored by reference');
  assert.notStrictEqual(captured.date, date, 'Date must not be stored by reference');
  assert.strictEqual(captured.box.tag, 'original');
  assert.strictEqual(
    Object.getPrototypeOf(captured.box),
    Object.prototype,
    'class instances capture as plain data objects (prototype not retained)'
  );
  assert.ok(captured.map instanceof Map);
  assert.ok(captured.set instanceof Set);
  assert.ok(captured.date instanceof Date);
  assert.strictEqual(captured.map.get('key').nested, 'original');
  assert.strictEqual(captured.map.size, 1);
  assert.ok(captured.set.has('original'));
  assert.strictEqual(captured.set.size, 1);
  assert.strictEqual(captured.date.getTime(), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('23.1 Captured Map/Set/Date are hardened against snapshot-side mutation (dbeb5d4-b)', () => {
  const telemetry = new RuntimeTelemetry();

  telemetry.recordContextSnapshot(
    'agent_nonplain_hardened',
    [{ role: 'user', content: 'hello', metadata: { map: new Map([['key', { nested: 1 }]]), set: new Set(['a']), date: new Date(1000) } }],
    { maxMessagesToRetain: 10, truncateContentAt: 50 }
  );

  const captured = telemetry.getAgentMetrics('agent_nonplain_hardened').lastSentContext[0].metadata;
  assert.ok(Object.isFrozen(captured.map));
  assert.ok(Object.isFrozen(captured.set));
  assert.ok(Object.isFrozen(captured.date));
  assert.ok(Object.isFrozen(captured.map.get('key')), 'plain values inside a Map are deep-frozen');
  assert.throws(() => captured.map.set('x', 1), TypeError);
  assert.throws(() => captured.map.delete('key'), TypeError);
  assert.throws(() => captured.map.clear(), TypeError);
  assert.throws(() => captured.set.add('b'), TypeError);
  assert.throws(() => captured.date.setTime(0), TypeError);

  // Failed mutation attempts leave internal telemetry state untouched.
  const reread = telemetry.getAgentMetrics('agent_nonplain_hardened').lastSentContext[0].metadata;
  assert.strictEqual(reread.map.get('key').nested, 1);
  assert.strictEqual(reread.map.size, 1);
  assert.strictEqual(reread.date.getTime(), 1000);
});

test('23.2 Truncation never writes through to caller-owned message objects (dbeb5d4-c)', () => {
  const telemetry = new RuntimeTelemetry();

  const longContent = 'Z'.repeat(400);
  const live = new TelemetryLiveMessage(longContent);
  const snapshot = telemetry.recordContextSnapshot('agent_nonplain_truncate', [live], {
    maxMessagesToRetain: 10,
    truncateContentAt: 40
  });

  assert.strictEqual(live.content, longContent, 'truncation must not mutate the caller object');
  assert.ok(snapshot.messages[0].content.endsWith('... [truncated 360 chars]'));
  assert.ok(snapshot.messages[0].content.length < longContent.length);

  const metrics = telemetry.getAgentMetrics('agent_nonplain_truncate');
  assert.strictEqual(metrics.lastSentContext[0].content, snapshot.messages[0].content);

  // The caller object remains ordinary and mutable — it was copied, not frozen.
  live.content = 'caller update';
  assert.strictEqual(live.content, 'caller update');
  assert.strictEqual(telemetry.getAgentMetrics('agent_nonplain_truncate').lastSentContext[0].content, snapshot.messages[0].content);
});

test('23.3 Uncloneable non-plain entries normalize instead of aliasing (dbeb5d4-d)', () => {
  const telemetry = new RuntimeTelemetry();

  const longContent = 'Y'.repeat(300);
  const live = new TelemetryLiveMessage(longContent);
  live.onEvent = () => {};
  telemetry.recordTurnUsage('agent_uncloneable', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [live]
  });

  live.content = 'caller update';
  live.onEvent = null;

  const captured = telemetry.getAgentMetrics('agent_uncloneable').lastSentContext[0];
  assert.strictEqual(captured.content, longContent, 'capture must retain the cloned message body');
  assert.notStrictEqual(captured, live);
  assert.strictEqual(typeof captured.onEvent, 'string', 'uncloneable function leaves become descriptor strings');
  assert.ok(captured.onEvent.startsWith('[Function'));
  assert.ok(Object.isFrozen(captured));
});
