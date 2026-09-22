/**
 * @packageDocumentation
 * Centralized, deterministic, and bounded observability, auditing, and token accounting engine (Module 12: runtime_telemetry).
 *
 * @module runtime/runtimeTelemetry
 * @mustNotImport ../agent/index.ts
 * @invariant INV-1: Telemetry state exists exclusively within private instance storage; external callers interact via immutable or defensive snapshots (frozen metric snapshots whose `lastSentContext` entries are capture-owned copies — arrays and plain objects deep-frozen, `Map`/`Set`/`Date` copies frozen with their mutators neutralized — and shallow-cloned trace arrays).
 * @invariant INV-2: Historical execution traces and context window snapshots are bounded by fixed-capacity FIFO ring buffers with O(1) push and deterministic oldest-first eviction; zero unbounded array growth.
 * @invariant INV-3: All cumulative metric counters are strictly non-negative integers and monotonic across turns until an explicit reset; seeding from a snapshot floors finite seed values to non-negative integers and never lowers an already-recorded value.
 * @invariant INV-4: Turn token consumption follows a strict two-tier resolution hierarchy: explicit overrides, then provider usage metadata; when neither is present, turn token counts are reported as zero.
 * @invariant INV-5: Subscriptions and external sinks are isolated within `try`/`catch` boundaries; a throwing observer is logged (`ERR_TELEMETRY_SUBSCRIBER_EXCEPTION`/`ERR_TELEMETRY_SINK_DISPATCH_FAILED`) and cannot interrupt caller execution.
 * @invariant INV-6: Context snapshots record message count, the sum of reported per-message token counts (0 when unreported), and role distributions with configurable head/tail pruning and per-message text truncation; both send paths (`recordTurnUsage` array payloads and `recordContextSnapshot`) bound `lastSentContext`, so raw context is never retained unbounded.
 * @invariant Identifier-resolving methods (metrics queries/resets and the operational `record*` methods except `recordEvent`, which normalizes a missing `agentId` to `'global'`) reject null, undefined, or empty/whitespace ids with a `TypeError` carrying code `ERR_TELEMETRY_INVALID_AGENT_ID`; the legacy facade methods `initializeTelemetry`, `getAgentTelemetry`, and `clearAgentTelemetry` are exempt and return `null`/`false` for invalid identifiers instead.
 * @decision `turn_complete` is broadcast on the runtime event bus by exactly one component (`TurnExecutionEngine`); telemetry still delivers its own `TURN_COMPLETE` to local subscribers, sinks, and ring buffers but never re-broadcasts it through the emit port
 * @decision Agent metrics cross the MOD-12/MOD-13 seam only through the injected frozen `AgentTelemetryAccessor` (`getTelemetrySnapshot`/`applyTelemetrySnapshot`); telemetry never receives or reaches into an `Agent` instance
 * @decision `TURN_ERROR`, `ERR_TELEMETRY_INVALID_USAGE_PAYLOAD`, and `ERR_TELEMETRY_BUFFER_OVERFLOW` were declared but never emitted and are removed rather than instrumented: turn failures surface on the turn engine's own `error` event, usage values are clamped rather than warned, and ring eviction is silent by design
 * @decision `TurnUsagePayload.durationMs` is declared because `recordTurnUsage` reads it; it is surfaced on the `TURN_COMPLETE` event payload and never feeds token accounting or cumulative metrics
 * @decision `recordToolExecution` is a public integration API with no engine-internal call sites; the runtime does not add instrumentation for it — callers record tool executions explicitly
 * @decision `lastSentContext` is latest-wins on every send: `recordTurnUsage` array payloads and `recordContextSnapshot` both replace the previous record, while snapshot/backfill hydration only fills an absent or empty context and never clobbers a non-empty in-process capture
 * @decision Non-plain message values (`Map`/`Set`/`Date`/class instances) are captured as defensive `structuredClone` copies, never by reference: class instances flatten to plain data objects, uncloneable values normalize to own-enumerable snapshots with function leaves replaced by descriptor strings, and captured `Map`/`Set`/`Date` copies are frozen with mutators neutralized, so truncation and later caller mutation can neither write through to nor alias caller-owned objects
 */

// ============================================================================
// 1. Canonical Event Constants & Error Codes
// ============================================================================

/**
 * Immutable dictionary of canonical telemetry event types.
 *
 * Standardized event identifiers emitted across the sandbox lifecycle:
 * - `TURN_START`: Emitted when an agent begins a turn execution.
 * - `TURN_COMPLETE`: Emitted when an agent successfully finishes a turn with token usage and duration metrics.
 * - `TOOL_EXECUTION`: Emitted when a completed tool execution (outcome, duration, payload sizes) is recorded.
 * - `TOKEN_USAGE`: Emitted when turn token consumption is calculated and accumulated.
 * - `TERMINAL_STOP`: Emitted when an agent reaches a terminal stop condition (e.g., stop keyword or turn limit).
 * - `INJECTED_DELIVERY`: Emitted when asynchronous mail messages are delivered into context.
 * - `PRECALL_DISPATCH`: Emitted when precall tool dispatches are executed prior to model inference.
 * - `CONTEXT_SNAPSHOT`: Emitted when a bounded context snapshot is captured and recorded.
 * - `TELEMETRY_RESET`: Emitted when an agent's cumulative metrics are reset to zero.
 * - `TELEMETRY_UPDATE`: Emitted when cumulative agent metrics are updated after turn completion.
 *
 * @example
 * ```typescript
 * import { TELEMETRY_EVENT_TYPES, type TelemetryEvent } from './runtimeTelemetry/index.ts';
 *
 * telemetry.subscribe((event: TelemetryEvent) => {
 *   if (event.type === TELEMETRY_EVENT_TYPES.TOKEN_USAGE) {
 *     console.log(`Agent ${event.agentId} used ${event.payload.turnPromptTokens} prompt tokens`);
 *   }
 * });
 * ```
 */
export const TELEMETRY_EVENT_TYPES: Readonly<{
  readonly TURN_START: 'turn_start';
  readonly TURN_COMPLETE: 'turn_complete';
  readonly TOOL_EXECUTION: 'tool_execution';
  readonly TOKEN_USAGE: 'token_usage';
  readonly TERMINAL_STOP: 'terminal_stop';
  readonly INJECTED_DELIVERY: 'injected_delivery';
  readonly PRECALL_DISPATCH: 'precall_dispatch';
  readonly CONTEXT_SNAPSHOT: 'context_snapshot';
  readonly TELEMETRY_RESET: 'telemetry_reset';
  readonly TELEMETRY_UPDATE: 'telemetry_update';
}> = Object.freeze({
  TURN_START: 'turn_start',
  TURN_COMPLETE: 'turn_complete',
  TOOL_EXECUTION: 'tool_execution',
  TOKEN_USAGE: 'token_usage',
  TERMINAL_STOP: 'terminal_stop',
  INJECTED_DELIVERY: 'injected_delivery',
  PRECALL_DISPATCH: 'precall_dispatch',
  CONTEXT_SNAPSHOT: 'context_snapshot',
  TELEMETRY_RESET: 'telemetry_reset',
  TELEMETRY_UPDATE: 'telemetry_update'
});

/**
 * Valid string union of canonical telemetry event types derived from {@link TELEMETRY_EVENT_TYPES}.
 *
 * @example
 * ```typescript
 * const eventType: TelemetryEventType = 'turn_complete';
 * ```
 */
export type TelemetryEventType =
  typeof TELEMETRY_EVENT_TYPES[keyof typeof TELEMETRY_EVENT_TYPES];

/**
 * Standardized telemetry error codes accessible via `RuntimeTelemetry.ERROR_CODES`.
 *
 * Canonical error identifiers:
 * - `INVALID_AGENT_ID`: `ERR_TELEMETRY_INVALID_AGENT_ID` — Thrown when an agent identifier is neither a non-blank string nor an object whose `id` is a non-blank string.
 * - `INVALID_EVENT_TYPE`: `ERR_TELEMETRY_INVALID_EVENT_TYPE` — Warning when an untyped/unrecognized event type is recorded.
 * - `SUBSCRIBER_EXCEPTION`: `ERR_TELEMETRY_SUBSCRIBER_EXCEPTION` — Non-fatal warning when an external subscriber callback throws.
 * - `SINK_DISPATCH_FAILED`: `ERR_TELEMETRY_SINK_DISPATCH_FAILED` — Non-fatal warning when an attached external sink fails during `.emit()`.
 *
 * @example
 * ```typescript
 * import { TELEMETRY_ERROR_CODES } from './runtimeTelemetry/index.ts';
 *
 * try {
 *   telemetry.getAgentMetrics('');
 * } catch (err: any) {
 *   if (err.message.includes(TELEMETRY_ERROR_CODES.INVALID_AGENT_ID)) {
 *     console.error('Invalid agent identifier passed to telemetry');
 *   }
 * }
 * ```
 */
export const TELEMETRY_ERROR_CODES: Readonly<{
  readonly INVALID_AGENT_ID: 'ERR_TELEMETRY_INVALID_AGENT_ID';
  readonly INVALID_EVENT_TYPE: 'ERR_TELEMETRY_INVALID_EVENT_TYPE';
  readonly SUBSCRIBER_EXCEPTION: 'ERR_TELEMETRY_SUBSCRIBER_EXCEPTION';
  readonly SINK_DISPATCH_FAILED: 'ERR_TELEMETRY_SINK_DISPATCH_FAILED';
}> = Object.freeze({
  INVALID_AGENT_ID: 'ERR_TELEMETRY_INVALID_AGENT_ID',
  INVALID_EVENT_TYPE: 'ERR_TELEMETRY_INVALID_EVENT_TYPE',
  SUBSCRIBER_EXCEPTION: 'ERR_TELEMETRY_SUBSCRIBER_EXCEPTION',
  SINK_DISPATCH_FAILED: 'ERR_TELEMETRY_SINK_DISPATCH_FAILED'
});

/**
 * Valid string union of canonical telemetry error codes derived from {@link TELEMETRY_ERROR_CODES}.
 *
 * @example
 * ```typescript
 * const code: TelemetryErrorCode = 'ERR_TELEMETRY_INVALID_AGENT_ID';
 * ```
 */
export type TelemetryErrorCode =
  typeof TELEMETRY_ERROR_CODES[keyof typeof TELEMETRY_ERROR_CODES];

// ============================================================================
// 2. Metrics & Snapshot Shapes
// ============================================================================

/**
 * Cumulative token consumption and lifecycle metrics for a single agent.
 *
 * Invariant Guarantees:
 * - Sovereign Encapsulation (INV-1): This object is an immutable defensive copy; its `lastSentContext` entries and nested plain objects are deep-frozen and captured `Map`/`Set`/`Date` copies are frozen with mutators neutralized, so mutating it (including nested message metadata) has no effect on internal state.
 * - Non-Negative Monotonicity (INV-3): All counter fields are strictly non-negative integers ($n ≥ 0$) and monotonically non-decreasing until explicit reset, including after snapshot seeding (finite seeds are floored).
 * - Bounded Context (INV-6): `lastSentContext` is bounded, pruned, and truncated on every send path (including `recordTurnUsage`) against OOM leaks.
 *
 * @example
 * ```typescript
 * const metrics: AgentTelemetryMetrics = telemetry.getAgentMetrics('agent_writer_01');
 * console.log(`Total tokens used: ${metrics.totalTokens} across ${metrics.turnCount} turns`);
 * ```
 */
export interface AgentTelemetryMetrics {
  /** Unique identifier of the agent. */
  readonly agentId: string;
  /** Cumulative prompt/input tokens consumed across all turns ($n ≥ 0$). */
  readonly inputTokens: number;
  /** Cumulative completion/output tokens generated across all turns ($n ≥ 0$). */
  readonly outputTokens: number;
  /** Cumulative total tokens (`inputTokens + outputTokens`). */
  readonly totalTokens: number;
  /** Cumulative execution turns completed by the agent ($n ≥ 0$). */
  readonly turnCount: number;
  /** Input tokens consumed in the most recent turn. */
  readonly lastPromptTokens: number;
  /** Completion tokens generated in the most recent turn. */
  readonly lastCompletionTokens: number;
  /** Number of times the agent completed execution via a terminal stop condition. */
  readonly terminalStops: number;
  /** Number of injected message deliveries received into prompt context. */
  readonly injectedDeliveries: number;
  /** Number of precall tool executions performed prior to model inference. */
  readonly precallCount: number;
  /** Cumulative number of tool executions performed by this agent. */
  readonly toolExecutionCount: number;
  /**
   * Bounded defensive copy of the most recently sent context message descriptors
   * (latest-wins: every send path replaces the previous record). Retained entries
   * are pruned and their string `content` truncated. Every object is a
   * capture-owned copy, never a caller alias: arrays and plain objects are
   * cloned structurally and deep-frozen, while non-plain values are cloned via
   * `structuredClone` (class instances flatten to plain data objects;
   * uncloneable values normalize to own-enumerable snapshots) and captured
   * `Map`/`Set`/`Date` copies are frozen with their mutators neutralized. The
   * array itself is frozen, so mutating the returned reference cannot alter
   * internal telemetry state.
   */
  readonly lastSentContext: ReadonlyArray<unknown>;
  /** Unix epoch timestamp (ms) of the most recent metric mutation. */
  readonly lastUpdated: number;
}

/**
 * Aggregate sandbox-wide cumulative telemetry metrics across all registered agents.
 *
 * Invariant Guarantees:
 * - Single-call aggregate retrieval: O(1) query without procedural loops across agent collections.
 * - Defensive snapshot: Returned object is a shallow clone with non-negative counters.
 *
 * @example
 * ```typescript
 * const runtimeMetrics: RuntimeAggregateMetrics = telemetry.getRuntimeMetrics();
 * console.log(`Active agents: ${runtimeMetrics.activeAgentsCount}, sandbox total tokens: ${runtimeMetrics.cumulativeTotalTokens}`);
 * ```
 */
export interface RuntimeAggregateMetrics {
  /** Cumulative input tokens across all registered agents ($n ≥ 0$). */
  readonly cumulativeInputTokens: number;
  /** Cumulative output tokens across all registered agents ($n ≥ 0$). */
  readonly cumulativeOutputTokens: number;
  /** Cumulative total tokens across all registered agents (`cumulativeInputTokens + cumulativeOutputTokens`). */
  readonly cumulativeTotalTokens: number;
  /** Cumulative turn count across all agents ($n ≥ 0$). */
  readonly totalTurnCount: number;
  /** Cumulative terminal stops across all agents ($n ≥ 0$). */
  readonly totalTerminalStops: number;
  /** Cumulative injected mail deliveries across all agents ($n ≥ 0$). */
  readonly totalInjectedDeliveries: number;
  /** Cumulative precall tool dispatches across all agents ($n ≥ 0$). */
  readonly totalPrecallCount: number;
  /** Cumulative tool executions across all agents ($n ≥ 0$). */
  readonly totalToolExecutions: number;
  /** Total number of unique agents currently tracked in telemetry ($n ≥ 0$). */
  readonly activeAgentsCount: number;
  /** Unix epoch timestamp (ms) of the most recent metric mutation. */
  readonly lastUpdated: number;
}

// ============================================================================
// 3. Payload Signatures for Telemetry Recording
// ============================================================================

/**
 * Input payload schema for recording turn token consumption.
 *
 * Resolution Hierarchy (INV-4):
 * 1. Tier 1: Explicit overrides (`turnPromptTokens`, `turnCompletionTokens`).
 * 2. Tier 2: Provider usage metadata (`turnUsage.prompt_tokens` / `promptTokens`, `completion_tokens` / `completionTokens`).
 *
 * When neither tier supplies a count, the turn counts resolve to zero; text
 * payloads never contribute to token accounting.
 *
 * @example
 * ```typescript
 * // Tier 2 Provider Usage example:
 * const payload: TurnUsagePayload = {
 *   turnUsage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
 *   responseContent: 'Hello world'
 * };
 * ```
 */
export interface TurnUsagePayload {
  /** Explicit prompt token count if known by caller. Overrides provider usage. */
  readonly turnPromptTokens?: number | null;
  /** Explicit completion token count if known by caller. Overrides provider usage. */
  readonly turnCompletionTokens?: number | null;
  /** Standard provider usage metadata object if supplied by model adapter; only the prompt/completion counts are consumed (total fields are ignored). */
  readonly turnUsage?: {
    readonly prompt_tokens?: number | null;
    readonly completion_tokens?: number | null;
    readonly total_tokens?: number | null;
    readonly promptTokens?: number | null;
    readonly completionTokens?: number | null;
    readonly totalTokens?: number | null;
  } | null;
  /** Formatted prompt messages array or string; array payloads are captured into `lastSentContext` for context auditing and never contribute to token accounting. */
  readonly formattedMessages?: readonly unknown[] | string | null;
  /** Generated model response text content; retained for payload compatibility and never contributes to token accounting. */
  readonly responseContent?: string | null;
  /** Generated model reasoning/thinking text content; retained for payload compatibility and never contributes to token accounting. */
  readonly responseReasoning?: string | null;
  /**
   * Wall-clock duration of the turn in milliseconds, surfaced on the emitted
   * `TURN_COMPLETE` event payload. Negative values are clamped to 0; omitted or
   * non-numeric values are reported as 0. It does not affect token accounting
   * or any cumulative metric.
   */
  readonly durationMs?: number | null;
}

/**
 * Result shape returned by {@link RuntimeTelemetry.recordTurnUsage}.
 *
 * @example
 * ```typescript
 * const result: TurnUsageResult = telemetry.recordTurnUsage('agent_writer', {
 *   turnPromptTokens: 150,
 *   turnCompletionTokens: 80
 * });
 * console.log(`Turn prompt tokens: ${result.turnPromptTokens}, cumulative agent tokens: ${result.telemetry.totalTokens}`);
 * ```
 */
export interface TurnUsageResult {
  /** Computed prompt tokens consumed in this turn. */
  readonly turnPromptTokens: number;
  /** Computed completion tokens generated in this turn. */
  readonly turnCompletionTokens: number;
  /** Defensive copy of updated cumulative agent telemetry metrics. */
  readonly telemetry: AgentTelemetryMetrics;
}

/**
 * Input payload schema for recording tool execution telemetry.
 *
 * @example
 * ```typescript
 * const toolPayload: ToolExecutionPayload = {
 *   toolName: 'read_file',
 *   durationMs: 42,
 *   status: 'success',
 *   argumentsByteSize: 128,
 *   resultByteSize: 2048,
 *   timestamp: Date.now()
 * };
 * telemetry.recordToolExecution('agent_coder', toolPayload);
 * ```
 */
export interface ToolExecutionPayload {
  /** Name of the tool invoked (e.g., `'read_file'`, `'bash_exec'`, `'send_message'`); non-string values are recorded as `'unknown'`. */
  readonly toolName: string;
  /** Execution duration in milliseconds ($n ≥ 0$); negative values are clamped to 0. */
  readonly durationMs: number;
  /** Outcome status of the execution (`'success'` | `'error'`); any value other than `'error'` is recorded as `'success'`. */
  readonly status: 'success' | 'error';
  /** Optional error code if the tool invocation failed; falsy values are recorded as `null`. */
  readonly errorCode?: string | null;
  /** Optional byte size of the tool arguments payload; omitted or non-numeric values are recorded as 0. */
  readonly argumentsByteSize?: number;
  /** Optional byte size of the tool output result; omitted or non-numeric values are recorded as 0. */
  readonly resultByteSize?: number;
  /** Optional epoch timestamp (ms) when execution commenced; defaults to the recording time (`Date.now()`). */
  readonly timestamp?: number;
}

/**
 * Input payload schema for recording terminal stops.
 *
 * @example
 * ```typescript
 * const stopPayload: TerminalStopPayload = {
 *   reason: 'stop_sequence_matched',
 *   turnNumber: 4
 * };
 * telemetry.recordTerminalStop('agent_writer', stopPayload);
 * ```
 */
export interface TerminalStopPayload {
  /** Reason for the terminal stop (e.g., `'stop'`, `'max_turns'`, `'abort'`, `'terminal_keyword_match'`); defaults to `'stop'` when omitted or non-string. */
  readonly reason?: string;
  /** Optional turn number at which the stop occurred; defaults to the agent's current `turnCount`. */
  readonly turnNumber?: number;
  /**
   * Count of validated precalls whose execution failed in the closing terminal batch.
   * Surfaced on the emitted `TERMINAL_STOP` event payload when greater than zero
   * (BUG-ENC-016 wrapped-failure visibility; failures do not block turn closure).
   */
  readonly executionFailures?: number;
}

/**
 * Options for capturing context window snapshots.
 *
 * Invariant Guarantees:
 * - Pruning & Truncation (INV-6): Defensively limits retained messages and character lengths to prevent unbounded memory growth.
 *
 * @example
 * ```typescript
 * const options: ContextSnapshotOptions = {
 *   maxMessagesToRetain: 30,
 *   truncateContentAt: 1500
 * };
 * ```
 */
export interface ContextSnapshotOptions {
  /** Maximum number of messages to retain in the snapshot (prioritizes head and tail). Default: 50; values are floored and clamped to a minimum of 1, and non-finite values fall back to the default. */
  readonly maxMessagesToRetain?: number;
  /** Maximum string length for individual message content before truncation. Default: 2000; values are floored and clamped to a minimum of 10, and non-finite values fall back to the default. */
  readonly truncateContentAt?: number;
}

/**
 * Structured context window summary record produced by {@link RuntimeTelemetry.recordContextSnapshot}.
 *
 * @example
 * ```typescript
 * const snapshot: ContextSnapshotRecord = telemetry.recordContextSnapshot('agent_01', messages, {
 *   maxMessagesToRetain: 50,
 *   truncateContentAt: 2000
 * });
 * console.log(`Context message count: ${snapshot.messageCount}, reported tokens: ${snapshot.estimatedTokens}`);
 * ```
 */
export interface ContextSnapshotRecord {
  /** Total number of messages in the context window, counted before pruning. */
  readonly messageCount: number;
  /** Sum of reported per-message `tokenCount` values (0 when unreported), calculated before pruning; only finite non-negative counts contribute. */
  readonly estimatedTokens: number;
  /** Breakdown of message count by role (e.g., `{ system: 1, user: 4, assistant: 3, tool: 2 }`); messages without a string `role` are counted under `'unknown'`. */
  readonly roleDistribution: Readonly<Record<string, number>>;
  /**
   * Pruned and truncated defensive copy of messages with deep-frozen entries
   * (captured `Map`/`Set`/`Date` copies are frozen with mutators neutralized);
   * long string `content` gains a `... [truncated N chars]` suffix. Every entry
   * is a capture-owned copy — non-plain values are never stored by reference —
   * and this is a separate frozen array from the internal `lastSentContext`
   * capture, so mutating the record cannot alter internal telemetry state.
   */
  readonly messages: ReadonlyArray<unknown>;
  /** Epoch timestamp (ms) when the snapshot was recorded. */
  readonly timestamp: number;
}

// ============================================================================
// 4. Trace & Event Logging Shapes
// ============================================================================

/**
 * Canonical discriminated union representing all telemetry audit events.
 *
 * Each variant carries an event `type` from {@link TELEMETRY_EVENT_TYPES}, an `agentId`,
 * an epoch `timestamp`, and a strictly typed `payload`.
 *
 * @example
 * ```typescript
 * function handleTelemetryEvent(event: TelemetryEvent) {
 *   switch (event.type) {
 *     case 'turn_start':
 *       console.log(`Turn ${event.payload.turnNumber} started for ${event.agentId}`);
 *       break;
 *     case 'turn_complete':
 *       console.log(`Turn ${event.payload.turnNumber} finished in ${event.payload.durationMs}ms`);
 *       break;
 *     case 'tool_execution':
 *       console.log(`Tool ${event.payload.toolName} status: ${event.payload.status}`);
 *       break;
 *     case 'telemetry_reset':
 *       console.log(`Metrics reset for agent ${event.agentId}`);
 *       break;
 *   }
 * }
 * ```
 */
export type TelemetryEvent =
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TURN_START;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: { readonly turnNumber: number; readonly inputSummary?: string };
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TURN_COMPLETE;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: {
        readonly turnNumber: number;
        readonly durationMs: number;
        readonly turnPromptTokens: number;
        readonly turnCompletionTokens: number;
      };
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TOOL_EXECUTION;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: ToolExecutionPayload;
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TOKEN_USAGE;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: {
        readonly turnPromptTokens: number;
        readonly turnCompletionTokens: number;
        readonly cumulativeTotalTokens: number;
      };
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TERMINAL_STOP;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: TerminalStopPayload;
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.INJECTED_DELIVERY;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: { readonly count: number; readonly cumulativeDeliveries: number };
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.PRECALL_DISPATCH;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: { readonly count: number; readonly cumulativePrecalls: number };
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.CONTEXT_SNAPSHOT;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: ContextSnapshotRecord;
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TELEMETRY_RESET;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: { readonly telemetry: AgentTelemetryMetrics };
    }
  | {
      readonly type: typeof TELEMETRY_EVENT_TYPES.TELEMETRY_UPDATE;
      readonly agentId: string;
      readonly timestamp: number;
      readonly payload: {
        readonly telemetry: AgentTelemetryMetrics;
        readonly turnPromptTokens: number;
        readonly turnCompletionTokens: number;
      };
    };

/**
 * Filter and query options for retrieving historical trace event logs.
 *
 * @example
 * ```typescript
 * const options: TraceQueryOptions = {
 *   type: 'tool_execution',
 *   limit: 50,
 *   sinceTimestamp: Date.now() - 60000,
 *   order: 'desc'
 * };
 * const events = telemetry.getTrace('agent_coder', options);
 * ```
 */
export interface TraceQueryOptions {
  /** Optional event type filter. */
  readonly type?: TelemetryEventType;
  /** Maximum number of records to return. Default: 100. */
  readonly limit?: number;
  /** Earliest timestamp (ms) to include in results. */
  readonly sinceTimestamp?: number;
  /** Chronological ordering of returned events (`'asc'` | `'desc'`). Default: `'asc'`. */
  readonly order?: 'asc' | 'desc';
}

// ============================================================================
// 5. Observer & Collector Configuration
// ============================================================================

/**
 * Callback function signature for telemetry event subscribers.
 *
 * Exception Shielding Invariant (INV-5):
 * Subscriber execution is isolated within try/catch blocks; uncaught exceptions will not disrupt caller execution.
 *
 * @param event - The broadcast telemetry event.
 *
 * @example
 * ```typescript
 * const listener: TelemetrySubscriber = (event) => {
 *   console.log(`[Telemetry ${event.type}] Agent: ${event.agentId}`);
 * };
 * const unsubscribe = telemetry.subscribe(listener);
 * ```
 */
export type TelemetrySubscriber = (event: TelemetryEvent) => void;

/**
 * External sink interface for decoupled event forwarding.
 *
 * Enables streaming telemetry events to audit loggers, UI store buses, or telemetry aggregators.
 *
 * @example
 * ```typescript
 * const auditSink: TelemetrySink = {
 *   emit(event) {
 *     auditLogger.log(event.type, event);
 *   }
 * };
 * const detach = telemetry.attachSink(auditSink);
 * ```
 */
export interface TelemetrySink {
  /** Receives and processes a telemetry event. */
  emit(event: TelemetryEvent): void;
}

/**
 * Configuration options for creating a {@link RuntimeTelemetry} instance.
 *
 * @example
 * ```typescript
 * const options: TelemetryCollectorOptions = {
 *   maxTraceEventsPerAgent: 250,
 *   maxGlobalTraceEvents: 2000
 * };
 * const telemetry = createTelemetryCollector(options);
 * ```
 */
export interface TelemetryCollectorOptions {
  /** Maximum trace events retained per agent ring buffer. Clamped to $≥ 1$. Default: 200; non-finite values fall back to the default. */
  readonly maxTraceEventsPerAgent?: number;
  /** Maximum global trace events retained in sandbox ring buffer. Clamped to $≥ 1$. Default: 1000; non-finite values fall back to the default. */
  readonly maxGlobalTraceEvents?: number;
  /** Optional external event sink for event forwarding. Ignored unless it exposes an `emit` function. */
  readonly sink?: TelemetrySink | null;
  /** Injected SubsystemEmitPort used to broadcast telemetry events to the runtime bus; ignored unless it exposes an `emit` function, and `turn_complete` is never re-broadcast through it. */
  readonly emit?: { emit(event: { type: string; timestamp: number; payload?: unknown }): void } | null;
  /** Narrow read/write accessor for agent telemetry (never a full Agent instance). Ignored unless it exposes an `applyTelemetrySnapshot` function. */
  readonly agentAccessor?: AgentTelemetryAccessor | null;
}

/**
 * Narrow accessor seam between Mod 12 and the agent registry (PORTS.md ratified
 * non-canonical internal DI). The provider (Mod 13) constructs a frozen plain
 * object; Mod 12 never receives or reaches into an `Agent` instance. Both legs
 * are best-effort: accessor failures are swallowed and treated as absent.
 */
export interface AgentTelemetryAccessor {
  /** Returns a read-only copy of the agent's current telemetry, or `null` when the agent is unknown; accessor exceptions are treated as `null`. */
  getTelemetrySnapshot(agentId: string): Partial<AgentTelemetryMetrics> | null;
  /** Applies a metrics snapshot to the owning agent through its public API; accessor exceptions are swallowed. */
  applyTelemetrySnapshot(agentId: string, metrics: Partial<AgentTelemetryMetrics>): void;
}

// ============================================================================
// Internal Helpers: Bounded Options & FIFO Ring Buffer
// ============================================================================

const DEFAULT_MAX_TRACE_PER_AGENT = 200;
const DEFAULT_MAX_TRACE_GLOBAL = 1000;
const DEFAULT_TRUNCATE_CONTENT_AT = 2000;
const DEFAULT_MAX_MESSAGES_TO_RETAIN = 50;
const DEFAULT_TRACE_QUERY_LIMIT = 100;

/**
 * Normalizes a numeric bound option. Finite numbers are floored and clamped to
 * `min`; every other value (including NaN, Infinity, strings, null) falls back
 * to `fallback`. Guards `Math.floor`/`Math.max` from propagating non-finite
 * values into array lengths (`RangeError: Invalid array length`) and slice
 * arithmetic.
 * @param value - Candidate numeric bound; non-finite values fall back.
 * @param min - Minimum allowed value after flooring.
 * @param fallback - Value used when `value` is not a finite number.
 */
function normalizeBoundedOption(value: unknown, min: number, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(min, Math.floor(value));
  }
  return fallback;
}

/**
 * Bounded FIFO ring buffer providing O(1) push and fixed memory footprint.
 */
class BoundedRingBuffer<T = unknown> {
  #capacity: number;
  #buffer: T[];
  #head = 0;
  #count = 0;

  constructor(capacity = 200) {
    this.#capacity = Math.max(1, capacity);
    this.#buffer = new Array(this.#capacity);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#count;
  }

  push(item: T): void {
    const index = (this.#head + this.#count) % this.#capacity;
    if (this.#count < this.#capacity) {
      this.#buffer[index] = item;
      this.#count++;
    } else {
      // Overwrite oldest item at head and advance head
      this.#buffer[this.#head] = item;
      this.#head = (this.#head + 1) % this.#capacity;
    }
  }

  toArray(): T[] {
    const result = new Array(this.#count);
    for (let i = 0; i < this.#count; i++) {
      result[i] = this.#buffer[(this.#head + i) % this.#capacity];
    }
    return result;
  }

  clear(): void {
    this.#buffer = new Array(this.#capacity);
    this.#head = 0;
    this.#count = 0;
  }
}

/**
 * Mutable in-process cumulative metrics record for a single agent. Counter
 * writes are floored and clamped before mutation; `lastSentContext` always
 * holds capture-owned, deep-frozen entries.
 */
interface InternalAgentMetrics {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
  lastPromptTokens: number;
  lastCompletionTokens: number;
  terminalStops: number;
  injectedDeliveries: number;
  precallCount: number;
  toolExecutionCount: number;
  lastSentContext: ReadonlyArray<unknown>;
  lastUpdated: number;
}

// ============================================================================
// 6. Public RuntimeTelemetry Class Contract
// ============================================================================

/**
 * Primary telemetry, auditing, and token accounting engine for the sandbox runtime.
 *
 * Encapsulates sovereign metric storage, bounded FIFO ring buffers, universal token accounting,
 * and exception-shielded event broadcasting.
 *
 * Architectural Invariants:
 * - Sovereign Encapsulation (INV-1): Metrics are managed strictly inside private instance maps; external queries return defensive snapshots whose context entries are deep-frozen copies.
 * - Bounded FIFO Buffers (INV-2): Ring buffers bound per-agent and global audit trace histories with O(1) push operations and deterministic eviction.
 * - Monotonic Counters (INV-3): Cumulative counters are non-negative integers that never decrease unless explicitly reset, including across snapshot seeding (finite seeds are floored).
 * - Two-Tier Token Accounting (INV-4): Explicit overrides, then provider usage metadata; absent counts resolve to zero.
 * - Observer Exception Shielding (INV-5): Subscriber errors are caught and logged; caller execution is never interrupted.
 * - Safe Context Auditing (INV-6): Context window snapshots are bounded, pruned, and truncated on every send path without raw text payload bloat.
 *
 * @example
 * ```typescript
 * import { RuntimeTelemetry, createTelemetryCollector } from './runtimeTelemetry/index.ts';
 *
 * const telemetry = createTelemetryCollector({
 *   maxTraceEventsPerAgent: 200,
 *   maxGlobalTraceEvents: 1000
 * });
 *
 * // Record turn execution usage
 * const usageResult = telemetry.recordTurnUsage('agent_writer', {
 *   turnUsage: { prompt_tokens: 150, completion_tokens: 50 },
 *   responseContent: 'Generated chapter content...'
 * });
 *
 * console.log(`Cumulative total tokens: ${usageResult.telemetry.totalTokens}`);
 * ```
 */
export class RuntimeTelemetry {
  /** Canonical static dictionary of event types. */
  public static readonly EVENT_TYPES: typeof TELEMETRY_EVENT_TYPES = TELEMETRY_EVENT_TYPES;
  /** Canonical static dictionary of error codes. */
  public static readonly ERROR_CODES: typeof TELEMETRY_ERROR_CODES = TELEMETRY_ERROR_CODES;

  #maxTraceEventsPerAgent: number;
  #agentMetrics = new Map<string, InternalAgentMetrics>();

  /**
   * Realm-local public labels for internal telemetry keys (Wave I, ticket
   * d57cbc1): pairs registered by key-carrying callers through the optional
   * `telemetryLabel` address property, so emitted events and snapshots stay
   * realm-opaque while the registries key canonically.
   */
  #publicAgentLabels = new Map<string, string>();
  #traceRingBuffers = new Map<string, BoundedRingBuffer<TelemetryEvent>>();
  #globalRingBuffer: BoundedRingBuffer<TelemetryEvent>;
  #subscribers = new Set<TelemetrySubscriber>();
  #sinks = new Set<TelemetrySink>();
  #agentAccessor: AgentTelemetryAccessor | null = null;

  #emitPort: { emit(event: { type: string; timestamp: number; payload?: unknown }): void } | null = null;
  #runtimeAggregate = {
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeTotalTokens: 0,
    totalTurnCount: 0,
    totalTerminalStops: 0,
    totalInjectedDeliveries: 0,
    totalPrecallCount: 0,
    totalToolExecutions: 0,
    activeAgentsCount: 0,
    lastUpdated: Date.now()
  };

  /**
   * Initializes a new `RuntimeTelemetry` collector instance.
   *
   * Initializes private metric storage maps, allocates the global ring buffer
   * (per-agent buffers are allocated lazily on first event), and wires up the
   * optional sink, emit port, and agent accessor. Option values with the wrong
   * shape are silently ignored rather than rejected: non-numeric values are
   * dropped and non-finite numeric capacities fall back to their defaults.
   *
   * @param options - Configuration options for ring buffer capacities and sinks.
   *
   * @example
   * ```typescript
   * const telemetry = new RuntimeTelemetry({
   *   maxTraceEventsPerAgent: 300,
   *   maxGlobalTraceEvents: 1500
   * });
   * ```
   */
  constructor(options: TelemetryCollectorOptions = {}) {
    let maxTracePerAgent = DEFAULT_MAX_TRACE_PER_AGENT;
    let maxGlobalTrace = DEFAULT_MAX_TRACE_GLOBAL;

    if (options && typeof options === 'object') {
      if (options.agentAccessor && typeof options.agentAccessor.applyTelemetrySnapshot === 'function') {
        this.#agentAccessor = options.agentAccessor;
      }

      if (options.emit && typeof options.emit.emit === 'function') {
        this.#emitPort = options.emit;
      }

      if (options.sink && typeof options.sink.emit === 'function') {
        this.#sinks.add(options.sink);
      }
      if (typeof options.maxTraceEventsPerAgent === 'number') {
        maxTracePerAgent = normalizeBoundedOption(options.maxTraceEventsPerAgent, 1, DEFAULT_MAX_TRACE_PER_AGENT);
      }
      if (typeof options.maxGlobalTraceEvents === 'number') {
        maxGlobalTrace = normalizeBoundedOption(options.maxGlobalTraceEvents, 1, DEFAULT_MAX_TRACE_GLOBAL);
      }
    }

    this.#maxTraceEventsPerAgent = maxTracePerAgent;
    this.#globalRingBuffer = new BoundedRingBuffer<TelemetryEvent>(maxGlobalTrace);
  }

  // --- Private Helpers ---

  #resolveAgentId(agentOrId: unknown): string {
    let resolved: string | null = null;
    if (typeof agentOrId === 'string' && agentOrId.trim().length > 0) {
      resolved = agentOrId.trim();
    } else if (agentOrId && typeof agentOrId === 'object') {
      const candidate = agentOrId as { id?: unknown; telemetryLabel?: unknown };
      if (typeof candidate.id === 'string' && candidate.id.trim().length > 0) {
        resolved = candidate.id.trim();
        // Internal key + public label (Wave I, ticket d57cbc1): callers that
        // key canonically may attach the realm-local agent id so every public
        // surface (events, snapshots) stays realm-opaque without this module
        // ever parsing the key itself.
        const label = candidate.telemetryLabel;
        if (typeof label === 'string' && label.trim().length > 0 && label.trim() !== resolved) {
          this.#publicAgentLabels.set(resolved, label.trim());
        }
      }
    }
    if (resolved !== null) return resolved;
    const error: TypeError & { code?: string } = new TypeError(`[${TELEMETRY_ERROR_CODES.INVALID_AGENT_ID}] Invalid agent ID provided: ${agentOrId}`);
    error.code = TELEMETRY_ERROR_CODES.INVALID_AGENT_ID;
    throw error;
  }

  /**
   * Projects an internal telemetry key back onto the realm-local agent id for
   * public surfaces (events, snapshots). Internal registries key on the
   * canonical `(realmId, agentId)` composite (Wave I, ticket d57cbc1), but no
   * emitted event or metrics snapshot may carry that composite — realm
   * vocabulary is engine-internal and consumers address agents by bare id.
   *
   * The label is registered by the key-carrying caller through the optional
   * `telemetryLabel` property on the agent address object; ids recorded as
   * plain strings fall back to the identifier itself (legacy key-agnostic use).
   *
   * @param resolvedId - Internal telemetry key.
   * @returns The realm-local agent id, or the input unchanged when no label is registered.
   * @internal
   */
  #publicAgentId(resolvedId: string): string {
    return this.#publicAgentLabels.get(resolvedId) ?? resolvedId;
  }

  /**
   * Reads a read-only telemetry snapshot for an agent through the injected
   * narrow accessor port (never touches the Agent entity directly).
   * @param resolvedId - Resolved agent id whose telemetry snapshot is read.
   */
  #readAgentSnapshot(resolvedId: string): Partial<AgentTelemetryMetrics> | null {
    if (!this.#agentAccessor) return null;
    try {
      const snapshot = this.#agentAccessor.getTelemetrySnapshot(resolvedId);
      return snapshot && typeof snapshot === 'object' ? snapshot : null;
    } catch {
      return null;
    }
  }

  /**
   * Pushes the current metrics snapshot back to the owning agent through the
   * injected accessor port. Declared fields only; no expandos.
   * @param metrics - Live metrics record to project onto the agent.
   */
  #syncAgentMetrics(metrics: InternalAgentMetrics): void {
    if (!this.#agentAccessor) return;
    try {
      this.#agentAccessor.applyTelemetrySnapshot(metrics.agentId, this.#createSnapshot(metrics));
    } catch {
      // Sync is best-effort; the collector's own metrics remain authoritative.
    }
  }

  /**
   * Publishes metrics to the owning agent through the injected accessor port;
   * falls back to the standalone legacy object mirror when no accessor exists.
   * @param agentOrId - Owning agent object or agent id.
   * @param metrics - Live metrics record to publish.
   */
  #publishMetrics(agentOrId: unknown, metrics: InternalAgentMetrics): void {
    if (this.#agentAccessor) {
      this.#syncAgentMetrics(metrics);
    } else if (agentOrId && typeof agentOrId === 'object') {
      this.#legacyMirrorToAgent(agentOrId, metrics);
    }
  }

  /**
   * Structural deep-copy of a message value graph. Arrays and plain objects are
   * copied element-by-element, preserving shared references and cycles through
   * `seen`. Every other object is copied defensively and is never retained by
   * reference: structured-cloneable values (`Map`, `Set`, `Date`, class
   * instances, typed arrays, ...) are deep-copied with `structuredClone`, which
   * flattens class instances to plain data objects (prototypes are not kept).
   * When `structuredClone` is unavailable or rejects a value (functions,
   * `WeakMap`/`WeakSet`, `Promise`, symbols, DOM nodes, ...), the value is
   * normalized to an own-enumerable snapshot reconstructed from cloned entries.
   * Functions are replaced by a descriptor string; primitives pass through.
   * @param value - Value graph to clone.
   * @param seen - Cycle-tracking map of already-cloned objects.
   */
  #deepCloneValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (Array.isArray(value)) {
      const cached = seen.get(value);
      if (cached) return cached;
      const clone = new Array(value.length);
      seen.set(value, clone);
      for (let i = 0; i < value.length; i++) {
        clone[i] = this.#deepCloneValue(value[i], seen);
      }
      return clone;
    }
    if (value && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const cached = seen.get(value);
        if (cached) return cached;
        const clone: Record<string, unknown> = {};
        seen.set(value, clone);
        for (const key of Object.keys(value)) {
          clone[key] = this.#deepCloneValue((value as Record<string, unknown>)[key], seen);
        }
        return clone;
      }
      return this.#cloneNonPlainValue(value, seen);
    }
    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }
    return value;
  }

  /**
   * Defensive copy of a non-plain object value. `structuredClone` is the
   * primary strategy; anything it cannot copy falls back to an own-enumerable
   * normalization. The caller's object is never stored or frozen in place.
   * @param value - Non-plain object to clone.
   * @param seen - Cycle-tracking map of already-cloned objects.
   */
  #cloneNonPlainValue(value: object, seen: WeakMap<object, unknown>): unknown {
    if (seen.has(value)) return seen.get(value);

    let clone: unknown = null;
    if (typeof structuredClone === 'function') {
      try {
        clone = structuredClone(value);
      } catch {
        clone = null;
      }
    }

    if (clone === null) {
      clone = this.#normalizeUncloneableValue(value, seen);
    } else {
      seen.set(value, clone);
    }
    return clone;
  }

  /**
   * Own-enumerable normalization used when `structuredClone` is unavailable or
   * rejects a value. `Map`/`Set`/`Date`/`RegExp` are rebuilt from cloned
   * entries; any other value becomes a plain object with recursively cloned
   * own-enumerable properties, so no caller-owned object is ever retained.
   * @param value - Object rejected by `structuredClone`.
   * @param seen - Cycle-tracking map of already-cloned objects.
   */
  #normalizeUncloneableValue(value: object, seen: WeakMap<object, unknown>): unknown {
    if (value instanceof Date) {
      const clone = new Date(value.getTime());
      seen.set(value, clone);
      return clone;
    }
    if (value instanceof Map) {
      const clone = new Map();
      seen.set(value, clone);
      for (const [key, entry] of value) {
        clone.set(this.#deepCloneValue(key, seen), this.#deepCloneValue(entry, seen));
      }
      return clone;
    }
    if (value instanceof Set) {
      const clone = new Set();
      seen.set(value, clone);
      for (const entry of value) {
        clone.add(this.#deepCloneValue(entry, seen));
      }
      return clone;
    }
    if (value instanceof RegExp) {
      const clone = new RegExp(value.source, value.flags);
      seen.set(value, clone);
      return clone;
    }
    const clone: Record<string, unknown> = {};
    seen.set(value, clone);
    for (const key of Object.keys(value)) {
      clone[key] = this.#deepCloneValue((value as Record<string, unknown>)[key], seen);
    }
    return clone;
  }

  /**
   * Recursively freezes an owned (already cloned) message value graph so any
   * leaked reference is inert. Arrays and plain objects are frozen recursively;
   * `Map`/`Set`/`Date` copies are additionally hardened so their mutator
   * methods throw before being frozen. Cycle safe through `seen`; exotic
   * structured clones that cannot be frozen (e.g. typed arrays) are returned
   * unchanged — they are still capture-owned copies, never caller aliases.
   * @param value - Owned value graph to freeze.
   * @param seen - Cycle-tracking set of already-frozen objects.
   */
  #deepFreezeValue(value: unknown, seen: WeakSet<object>): unknown {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;

    if (value instanceof Map || value instanceof Set) {
      if (seen.has(value)) return value;
      seen.add(value);
      if (value instanceof Map) {
        for (const [key, entry] of value) {
          this.#deepFreezeValue(key, seen);
          this.#deepFreezeValue(entry, seen);
        }
      } else {
        for (const entry of value) {
          this.#deepFreezeValue(entry, seen);
        }
      }
      this.#hardenMutableContainer(value);
      return value;
    }

    if (value instanceof Date) {
      if (seen.has(value)) return value;
      seen.add(value);
      this.#hardenMutableContainer(value);
      return value;
    }

    if (!Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
    }
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        this.#deepFreezeValue(item, seen);
      }
    } else {
      for (const key of Object.keys(value)) {
        this.#deepFreezeValue((value as Record<string, unknown>)[key], seen);
      }
    }
    Object.freeze(value);
    return value;
  }

  /**
   * Neutralizes the mutator methods on a capture-owned `Map`, `Set`, or `Date`
   * copy and freezes it, so a leaked snapshot reference cannot rewrite internal
   * telemetry state. The hardened value is always a copy, never a caller object.
   * @param value - Capture-owned `Map`/`Set`/`Date` copy to harden and freeze.
   */
  #hardenMutableContainer(value: Map<unknown, unknown> | Set<unknown> | Date): void {
    const reject = () => {
      throw new TypeError('Telemetry capture values are immutable');
    };
    const mutators = value instanceof Date
      ? [
          'setTime', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
          'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours', 'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds'
        ]
      : value instanceof Map
        ? ['set', 'delete', 'clear']
        : ['add', 'delete', 'clear'];
    for (const name of mutators) {
      Object.defineProperty(value, name, { value: reject, writable: false, enumerable: false, configurable: false });
    }
    Object.freeze(value);
  }

  /**
   * Prunes, truncates, deep-copies, and deep-freezes a formatted-message array
   * for internal storage. Every captured object is a copy: arrays and plain
   * objects are cloned structurally, all other objects through
   * `#deepCloneValue`'s non-plain rule (never by reference), so truncation and
   * later caller mutation can neither write through to nor alias caller
   * payloads. Captured entries are then deep-frozen, with `Map`/`Set`/`Date`
   * copies additionally hardened against mutation.
   * @param messages - Candidate formatted-message array.
   * @param maxMessages - Maximum entries to retain (head 2 + tail).
   * @param truncateAt - Maximum string `content` length before truncation.
   * @returns Frozen bounded capture.
   */
  #captureContextMessages(messages: readonly unknown[], maxMessages: number, truncateAt: number): ReadonlyArray<unknown> {
    const list = Array.isArray(messages) ? messages : [];

    let pruned: readonly unknown[];
    if (list.length <= maxMessages) {
      pruned = list;
    } else if (maxMessages <= 2) {
      pruned = list.slice(-maxMessages);
    } else {
      pruned = [...list.slice(0, 2), ...list.slice(-(maxMessages - 2))];
    }

    const cloneSeen = new WeakMap<object, unknown>();
    const captured = pruned.map(m => (m && typeof m === 'object' ? this.#deepCloneValue(m, cloneSeen) : m));

    for (const message of captured) {
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      if (typeof record.content === 'string' && record.content.length > truncateAt) {
        record.content = record.content.slice(0, truncateAt) + `... [truncated ${record.content.length - truncateAt} chars]`;
      }
    }

    const freezeSeen = new WeakSet<object>();
    for (const message of captured) {
      this.#deepFreezeValue(message, freezeSeen);
    }
    return Object.freeze(captured);
  }

  /**
   * Declared-fields-only telemetry projection (never emits expandos such as
   * `toolExecutionCount`, which stays internal to Mod 12). `lastSentContext`
   * is projected as a fresh array (elements are frozen captures), so legacy
   * facade consumers can never alias the internal array.
   * @param metrics - Live metrics record to project.
   */
  #declaredTelemetryFromMetrics(metrics: InternalAgentMetrics): Record<string, unknown> {
    return {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      turnCount: metrics.turnCount,
      lastPromptTokens: metrics.lastPromptTokens,
      lastCompletionTokens: metrics.lastCompletionTokens,
      terminalStops: metrics.terminalStops,
      injectedDeliveries: metrics.injectedDeliveries,
      precallCount: metrics.precallCount,
      lastSentContext: [...metrics.lastSentContext]
    };
  }

  /**
   * Standalone legacy facade path (no accessor injected): mirrors declared
   * telemetry fields onto a caller-supplied agent object.
   * @param agentObject - Caller-supplied agent object to mirror onto.
   * @param metrics - Live metrics record to mirror.
   */
  #legacyMirrorToAgent(agentObject: object, metrics: InternalAgentMetrics): void {
    const host = agentObject as { telemetry?: Record<string, unknown> | null; updatedAt?: number };
    host.telemetry = this.#declaredTelemetryFromMetrics(metrics);
    host.updatedAt = metrics.lastUpdated;
  }

  /**
   * Standalone legacy facade path: backfills missing telemetry fields on a
   * caller-supplied agent object without wiping existing values. A non-empty
   * `lastSentContext` array is retained; an absent or empty context is filled
   * from the live metrics projection (aligned with the seed path's `[]` rule),
   * always as a fresh copy so agent-owned arrays never alias internal storage.
   * @param agentObject - Caller-supplied agent object to backfill.
   * @param metrics - Live metrics record to backfill from.
   */
  #legacyBackfillAgent(agentObject: object, metrics: InternalAgentMetrics): void {
    const host = agentObject as { telemetry?: Record<string, unknown> | null };
    if (!host.telemetry || typeof host.telemetry !== 'object') {
      host.telemetry = this.#declaredTelemetryFromMetrics(metrics);
      return;
    }
    const projection = this.#declaredTelemetryFromMetrics(metrics);
    for (const [key, value] of Object.entries(projection)) {
      if (key === 'lastSentContext') {
        const existing = host.telemetry.lastSentContext;
        if (!Array.isArray(existing) || existing.length === 0) {
          host.telemetry.lastSentContext = value;
        }
      } else if (typeof host.telemetry[key] !== 'number') {
        host.telemetry[key] = value;
      }
    }
  }



  /**
   * Seeds cumulative counters from an existing agent telemetry snapshot without
   * ever lowering already-recorded values (fixes post-restore counter resets).
   * Finite seed values are floored to non-negative integers before the
   * monotonic `max`, so INV-3 holds across hydration. `lastSentContext` is
   * hydrated only when the in-memory record has none (absent or empty) and the
   * snapshot carries a non-empty array, so a seed snapshot never clobbers a
   * context already captured in this process; hydrated entries are deep-copied
   * and frozen under the same bound/truncation as live captures.
   * @param metrics - In-memory metrics record to seed.
   * @param snapshot - Persisted telemetry snapshot to seed from.
   */
  #seedCumulativeCounters(metrics: InternalAgentMetrics, snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const source = snapshot as Record<string, unknown>;
    const numericFields = [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'turnCount',
      'lastPromptTokens',
      'lastCompletionTokens',
      'terminalStops',
      'injectedDeliveries',
      'precallCount',
      'toolExecutionCount'
    ] as const;
    for (const field of numericFields) {
      const value = source[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        metrics[field] = Math.max(metrics[field], Math.floor(value));
      }
    }
    if (
      metrics.lastSentContext.length === 0 &&
      Array.isArray(source.lastSentContext) &&
      source.lastSentContext.length > 0
    ) {
      metrics.lastSentContext = this.#captureContextMessages(
        source.lastSentContext,
        DEFAULT_MAX_MESSAGES_TO_RETAIN,
        DEFAULT_TRUNCATE_CONTENT_AT
      );
    }
  }

  #getOrCreateAgentMetrics(resolvedId: string): InternalAgentMetrics {
    let metrics = this.#agentMetrics.get(resolvedId);
    if (!metrics) {
      metrics = {
        agentId: resolvedId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turnCount: 0,
        lastPromptTokens: 0,
        lastCompletionTokens: 0,
        terminalStops: 0,
        injectedDeliveries: 0,
        precallCount: 0,
        toolExecutionCount: 0,
        lastSentContext: [],
        lastUpdated: Date.now()
      };
      this.#seedCumulativeCounters(metrics, this.#readAgentSnapshot(resolvedId));
      this.#agentMetrics.set(resolvedId, metrics);
      this.#runtimeAggregate.activeAgentsCount = this.#agentMetrics.size;
    }
    return metrics;
  }

  #getOrCreateRingBuffer(resolvedId: string): BoundedRingBuffer<TelemetryEvent> {
    let ring = this.#traceRingBuffers.get(resolvedId);
    if (!ring) {
      ring = new BoundedRingBuffer<TelemetryEvent>(this.#maxTraceEventsPerAgent);
      this.#traceRingBuffers.set(resolvedId, ring);
    }
    return ring;
  }

  #createSnapshot(metrics: InternalAgentMetrics): AgentTelemetryMetrics {
    return Object.freeze({
      agentId: this.#publicAgentId(metrics.agentId),
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      turnCount: metrics.turnCount,
      lastPromptTokens: metrics.lastPromptTokens,
      lastCompletionTokens: metrics.lastCompletionTokens,
      terminalStops: metrics.terminalStops,
      injectedDeliveries: metrics.injectedDeliveries,
      precallCount: metrics.precallCount,
      toolExecutionCount: metrics.toolExecutionCount,
      lastSentContext: Object.freeze([...metrics.lastSentContext]),
      lastUpdated: metrics.lastUpdated
    });
  }

  #pushToRingBuffers(event: TelemetryEvent, resolvedId: string = event.agentId): void {
    if (resolvedId && resolvedId !== 'global') {
      const agentRing = this.#getOrCreateRingBuffer(resolvedId);
      agentRing.push(event);
    }
    this.#globalRingBuffer.push(event);
  }

  #dispatchEvent(event: TelemetryEvent): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.warn(`[RuntimeTelemetry] Subscriber threw uncaught exception (${TELEMETRY_ERROR_CODES.SUBSCRIBER_EXCEPTION}):`, err);
      }
    }

    for (const sink of this.#sinks) {
      try {
        sink.emit(event);
      } catch (err) {
        console.warn(`[RuntimeTelemetry] Sink dispatch failed (${TELEMETRY_ERROR_CODES.SINK_DISPATCH_FAILED}):`, err);
      }
    }

    // BUG-ENC-014: `turn_complete` is emitted on the runtime event bus by exactly
    // one component — TurnExecutionEngine (the richest payload: output/toolCalls/
    // summary). Telemetry still delivers its own TURN_COMPLETE to local
    // subscribers, sinks, and ring buffers, but must not re-broadcast it.
    if (this.#emitPort && event.type !== TELEMETRY_EVENT_TYPES.TURN_COMPLETE) {
      try {
        this.#emitPort.emit(event);
      } catch (err) {
        console.warn(`[RuntimeTelemetry] Emit port dispatch failed:`, err);
      }
    }
  }

  // --- Metrics Queries & Resets ---

  /**
   * Retrieves an immutable defensive copy of cumulative telemetry metrics for an agent.
   *
   * If the agent has never been tracked, lazily initializes a zero-metric record,
   * stores it in internal storage, and returns a defensive snapshot. When an
   * accessor is injected, the record is seeded from the agent's existing telemetry
   * snapshot; finite seed values are floored to non-negative integers and seeding
   * only raises counters, never lowers recorded values.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @returns Defensive copy of agent metrics with a frozen context array of deep-frozen entries.
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * const metrics = telemetry.getAgentMetrics('agent_coder');
   * console.log(`Input: ${metrics.inputTokens}, Output: ${metrics.outputTokens}, Turns: ${metrics.turnCount}`);
   * ```
   */
  public getAgentMetrics(agentId: string): AgentTelemetryMetrics {
    const resolvedId = this.#resolveAgentId(agentId);
    const metrics = this.#getOrCreateAgentMetrics(resolvedId);
    return this.#createSnapshot(metrics);
  }

  /**
   * Resets cumulative telemetry metrics for a specific agent back to zero.
   *
   * Zeroes all token and lifecycle counters (`inputTokens = 0`, `outputTokens = 0`, `totalTokens = 0`,
   * `turnCount = 0`, `terminalStops = 0`, `injectedDeliveries = 0`, `precallCount = 0`, `toolExecutionCount = 0`),
   * updates `lastUpdated = Date.now()`, syncs the owning agent, appends a `telemetry_reset`
   * event to the agent and global ring buffers, and dispatches it to subscribers, sinks,
   * and the emit port. `lastSentContext` is retained.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @returns True if the agent was found and reset, false otherwise.
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * const wasReset = telemetry.resetAgentMetrics('agent_coder');
   * if (wasReset) {
   *   console.log('Agent metrics successfully cleared');
   * }
   * ```
   */
  public resetAgentMetrics(agentId: string): boolean {
    const resolvedId = this.#resolveAgentId(agentId);

    const metrics = this.#agentMetrics.get(resolvedId);
    if (!metrics) {
      return false;
    }

    metrics.inputTokens = 0;
    metrics.outputTokens = 0;
    metrics.totalTokens = 0;
    metrics.turnCount = 0;
    metrics.lastPromptTokens = 0;
    metrics.lastCompletionTokens = 0;
    metrics.terminalStops = 0;
    metrics.injectedDeliveries = 0;
    metrics.precallCount = 0;
    metrics.toolExecutionCount = 0;
    metrics.lastUpdated = Date.now();

    this.#publishMetrics(agentId, metrics);

    const snapshot = this.#createSnapshot(metrics);

    const event = {
      type: TELEMETRY_EVENT_TYPES.TELEMETRY_RESET,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: metrics.lastUpdated,
      payload: {
        telemetry: snapshot
      }
    };

    this.#pushToRingBuffers(event, resolvedId);
    this.#dispatchEvent(event);

    return true;
  }

  /**
   * Retrieves aggregate cumulative metrics across all registered agents in the sandbox.
   *
   * Provides O(1) query access to cumulative input/output/total tokens, turn counts,
   * terminal stops, precall counts, tool executions, and active agent counts.
   *
   * @returns Defensive snapshot of aggregate runtime metrics.
   *
   * @example
   * ```typescript
   * const aggregate = telemetry.getRuntimeMetrics();
   * console.log(`Sandbox tokens: ${aggregate.cumulativeTotalTokens}, Total turns: ${aggregate.totalTurnCount}`);
   * ```
   */
  public getRuntimeMetrics(): RuntimeAggregateMetrics {
    return Object.freeze({
      ...this.#runtimeAggregate,
      activeAgentsCount: this.#agentMetrics.size,
      lastUpdated: this.#runtimeAggregate.lastUpdated
    });
  }

  /**
   * Clears all tracked agent metrics and resets aggregate statistics back to zero.
   *
   * Resets internal storage maps, clears every per-agent and global trace ring
   * buffer, and initializes aggregate counters to zero. Attached subscribers and
   * sinks are left intact, and no event is dispatched.
   *
   * @example
   * ```typescript
   * telemetry.clearAllMetrics();
   * console.log(telemetry.getRuntimeMetrics().cumulativeTotalTokens); // 0
   * ```
   */
  public clearAllMetrics(): void {
    this.#agentMetrics.clear();
    this.#traceRingBuffers.clear();
    this.#globalRingBuffer.clear();
    this.#runtimeAggregate = {
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeTotalTokens: 0,
      totalTurnCount: 0,
      totalTerminalStops: 0,
      totalInjectedDeliveries: 0,
      totalPrecallCount: 0,
      totalToolExecutions: 0,
      activeAgentsCount: 0,
      lastUpdated: Date.now()
    };
  }

  // --- Operational Recording Methods ---

  /**
   * Calculates turn token consumption, increments cumulative counters, updates aggregate
   * metrics, records audit trace events, and dispatches a `telemetry_update` event.
   *
   * Resolution Flow (INV-4):
   * 1. Resolves `promptTokens`: explicit `turnPromptTokens` -\> provider `turnUsage.prompt_tokens`; zero when neither is present.
   * 2. Resolves `completionTokens`: explicit `turnCompletionTokens` -\> provider `turnUsage.completion_tokens`; zero when neither is present.
   * 3. Atomically updates cumulative agent and sandbox aggregate counters.
   * 4. Pushes `TOKEN_USAGE` and `TURN_COMPLETE` events into the agent and global ring buffers.
   * 5. Dispatches `telemetry_update` to subscribers, sinks, and the emit port; unlike the
   *    other two events it is not appended to ring buffers.
   *
   * Explicit and provider-supplied counts are floored and clamped to a minimum of 0.
   * Dispatch order is `TOKEN_USAGE`, then
   * `TURN_COMPLETE`, then `telemetry_update`. When `formattedMessages` is an array,
   * its entries are deep-copied into `lastSentContext` — arrays/plain objects
   * structurally, non-plain objects via `structuredClone`, never by reference —
   * pruned to the default retention bound (head 2 + tail, 50 entries max) and
   * truncated at the default content limit (2000 chars), replacing any previous
   * capture (latest-wins); the captured entries are deep-frozen (with captured
   * `Map`/`Set`/`Date` copies frozen and their mutators neutralized), so
   * truncation and later caller-side mutation cannot alter internal state.
   * Non-array payloads leave the recorded array untouched.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @param payload - Optional turn usage metadata, provider usage, prompt messages, or generated text; defaults to an empty payload.
   * @returns Turn calculation result containing prompt tokens, completion tokens, and updated cumulative metrics.
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * const result = telemetry.recordTurnUsage('agent_writer', {
   *   turnUsage: { prompt_tokens: 210, completion_tokens: 95 },
   *   responseContent: 'Summary of discussion.'
   * });
   * console.log(`Turn Prompt: ${result.turnPromptTokens}, Turn Completion: ${result.turnCompletionTokens}`);
   * console.log(`Agent Cumulative: ${result.telemetry.totalTokens}`);
   * ```
   */
  public recordTurnUsage(agentId: string, payload: TurnUsagePayload = {}): TurnUsageResult {
    const resolvedId = this.#resolveAgentId(agentId);

    let calculatedPrompt = 0;
    let calculatedCompletion = 0;

    // 1. Prompt tokens resolution (two-tier)
    if (typeof payload?.turnPromptTokens === 'number' && Number.isFinite(payload.turnPromptTokens)) {
      calculatedPrompt = Math.max(0, Math.floor(payload.turnPromptTokens));
    } else if (typeof payload?.turnUsage?.prompt_tokens === 'number' && Number.isFinite(payload.turnUsage.prompt_tokens)) {
      calculatedPrompt = Math.max(0, Math.floor(payload.turnUsage.prompt_tokens));
    } else if (typeof payload?.turnUsage?.promptTokens === 'number' && Number.isFinite(payload.turnUsage.promptTokens)) {
      calculatedPrompt = Math.max(0, Math.floor(payload.turnUsage.promptTokens));
    }

    // 2. Completion tokens resolution (two-tier)
    if (typeof payload?.turnCompletionTokens === 'number' && Number.isFinite(payload.turnCompletionTokens)) {
      calculatedCompletion = Math.max(0, Math.floor(payload.turnCompletionTokens));
    } else if (typeof payload?.turnUsage?.completion_tokens === 'number' && Number.isFinite(payload.turnUsage.completion_tokens)) {
      calculatedCompletion = Math.max(0, Math.floor(payload.turnUsage.completion_tokens));
    } else if (typeof payload?.turnUsage?.completionTokens === 'number' && Number.isFinite(payload.turnUsage.completionTokens)) {
      calculatedCompletion = Math.max(0, Math.floor(payload.turnUsage.completionTokens));
    }

    const metrics = this.#getOrCreateAgentMetrics(resolvedId);
    metrics.inputTokens += calculatedPrompt;
    metrics.outputTokens += calculatedCompletion;
    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens;
    metrics.lastPromptTokens = calculatedPrompt;
    metrics.lastCompletionTokens = calculatedCompletion;
    metrics.turnCount += 1;
    metrics.lastUpdated = Date.now();

    if (Array.isArray(payload?.formattedMessages)) {
      metrics.lastSentContext = this.#captureContextMessages(
        payload.formattedMessages,
        DEFAULT_MAX_MESSAGES_TO_RETAIN,
        DEFAULT_TRUNCATE_CONTENT_AT
      );
    }

    this.#publishMetrics(agentId, metrics);

    this.#runtimeAggregate.cumulativeInputTokens += calculatedPrompt;
    this.#runtimeAggregate.cumulativeOutputTokens += calculatedCompletion;
    this.#runtimeAggregate.cumulativeTotalTokens += (calculatedPrompt + calculatedCompletion);
    this.#runtimeAggregate.totalTurnCount += 1;
    this.#runtimeAggregate.lastUpdated = metrics.lastUpdated;

    const now = metrics.lastUpdated;

    const tokenUsageEvent = {
      type: TELEMETRY_EVENT_TYPES.TOKEN_USAGE,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: now,
      payload: {
        turnPromptTokens: calculatedPrompt,
        turnCompletionTokens: calculatedCompletion,
        cumulativeTotalTokens: metrics.totalTokens
      }
    };
    this.#pushToRingBuffers(tokenUsageEvent, resolvedId);
    this.#dispatchEvent(tokenUsageEvent);

    const turnCompleteEvent = {
      type: TELEMETRY_EVENT_TYPES.TURN_COMPLETE,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: now,
      payload: {
        turnNumber: metrics.turnCount,
        durationMs: typeof payload?.durationMs === 'number' ? Math.max(0, payload.durationMs) : 0,
        turnPromptTokens: calculatedPrompt,
        turnCompletionTokens: calculatedCompletion
      }
    };
    this.#pushToRingBuffers(turnCompleteEvent, resolvedId);
    this.#dispatchEvent(turnCompleteEvent);

    const snapshot = this.#createSnapshot(metrics);

    const updateEvent = {
      type: TELEMETRY_EVENT_TYPES.TELEMETRY_UPDATE,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: now,
      payload: {
        telemetry: snapshot,
        turnPromptTokens: calculatedPrompt,
        turnCompletionTokens: calculatedCompletion
      }
    };
    this.#dispatchEvent(updateEvent);

    return {
      turnPromptTokens: calculatedPrompt,
      turnCompletionTokens: calculatedCompletion,
      telemetry: snapshot
    };
  }

  /**
   * Records execution of a tool, tracking duration, outcome status, and payload sizes.
   *
   * Monotonically increments `toolExecutionCount` on the agent metric record and `totalToolExecutions`
   * on the aggregate record, appends a `TOOL_EXECUTION` audit event to ring buffers, and broadcasts to subscribers.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @param payload - Tool execution audit details.
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * telemetry.recordToolExecution('agent_coder', {
   *   toolName: 'read_file',
   *   durationMs: 35,
   *   status: 'success',
   *   argumentsByteSize: 64,
   *   resultByteSize: 1024
   * });
   * ```
   */
  public recordToolExecution(agentId: string, payload: ToolExecutionPayload = {} as ToolExecutionPayload): void {
    const resolvedId = this.#resolveAgentId(agentId);
    const metrics = this.#getOrCreateAgentMetrics(resolvedId);

    metrics.toolExecutionCount += 1;
    metrics.lastUpdated = Date.now();

    this.#runtimeAggregate.totalToolExecutions += 1;
    this.#runtimeAggregate.lastUpdated = metrics.lastUpdated;

    this.#publishMetrics(agentId, metrics);

    const event: TelemetryEvent = {
      type: TELEMETRY_EVENT_TYPES.TOOL_EXECUTION,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: (typeof payload?.timestamp === 'number') ? payload.timestamp : metrics.lastUpdated,
      payload: {
        toolName: typeof payload?.toolName === 'string' ? payload.toolName : 'unknown',
        durationMs: (typeof payload?.durationMs === 'number') ? Math.max(0, payload.durationMs) : 0,
        status: payload?.status === 'error' ? 'error' : 'success',
        errorCode: payload?.errorCode || null,
        argumentsByteSize: (typeof payload?.argumentsByteSize === 'number') ? Math.max(0, payload.argumentsByteSize) : 0,
        resultByteSize: (typeof payload?.resultByteSize === 'number') ? Math.max(0, payload.resultByteSize) : 0,
        timestamp: (typeof payload?.timestamp === 'number') ? payload.timestamp : metrics.lastUpdated
      }
    };

    this.#pushToRingBuffers(event, resolvedId);
    this.#dispatchEvent(event);
  }

  /**
   * Records a terminal stop completion event for an agent.
   *
   * Monotonically increments `terminalStops` on the agent record and `totalTerminalStops`
   * on the aggregate record, syncs the owning agent, and pushes a `TERMINAL_STOP` event
   * into the agent and global ring buffers before broadcasting it.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @param payload - Optional stop reason (e.g., `'stop'`, `'max_turns'`, `'abort'`), turn number, and terminal-batch failure count.
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * telemetry.recordTerminalStop('agent_coder', {
   *   reason: 'stop_keyword_matched',
   *   turnNumber: 5
   * });
   * ```
   */
  public recordTerminalStop(agentId: string, payload: TerminalStopPayload = {}): void {
    const resolvedId = this.#resolveAgentId(agentId);
    const metrics = this.#getOrCreateAgentMetrics(resolvedId);

    metrics.terminalStops += 1;
    metrics.lastUpdated = Date.now();

    this.#runtimeAggregate.totalTerminalStops += 1;
    this.#runtimeAggregate.lastUpdated = metrics.lastUpdated;

    this.#publishMetrics(agentId, metrics);

    const event = {
      type: TELEMETRY_EVENT_TYPES.TERMINAL_STOP,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: metrics.lastUpdated,
      payload: {
        reason: typeof payload?.reason === 'string' ? payload.reason : 'stop',
        turnNumber: (typeof payload?.turnNumber === 'number') ? payload.turnNumber : metrics.turnCount,
        ...(typeof payload?.executionFailures === 'number' && payload.executionFailures > 0
          ? { executionFailures: payload.executionFailures }
          : {})
      }
    };

    this.#pushToRingBuffers(event, resolvedId);
    this.#dispatchEvent(event);
  }

  /**
   * Records the injection of pending mail messages into an agent's context window.
   *
   * Increments `injectedDeliveries` by `count` on the agent record and `totalInjectedDeliveries`
   * on the aggregate record (only when `count` is positive), then dispatches an
   * `INJECTED_DELIVERY` event carrying the recorded count and the new cumulative value.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @param count - Number of delivered messages. Defaults to 1 when omitted; non-finite, zero, or negative values are recorded as 0 and leave counters unchanged (the event is still dispatched).
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * telemetry.recordInjectedDelivery('agent_coder', 3);
   * ```
   */
  public recordInjectedDelivery(agentId: string, count = 1): void {
    const resolvedId = this.#resolveAgentId(agentId);
    const safeCount = (typeof count === 'number' && Number.isFinite(count) && count > 0) ? Math.floor(count) : 0;
    const metrics = this.#getOrCreateAgentMetrics(resolvedId);

    if (safeCount > 0) {
      metrics.injectedDeliveries += safeCount;
      metrics.lastUpdated = Date.now();

      this.#runtimeAggregate.totalInjectedDeliveries += safeCount;
      this.#runtimeAggregate.lastUpdated = metrics.lastUpdated;

      this.#publishMetrics(agentId, metrics);
    }

    const event = {
      type: TELEMETRY_EVENT_TYPES.INJECTED_DELIVERY,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: Date.now(),
      payload: {
        count: safeCount,
        cumulativeDeliveries: metrics.injectedDeliveries
      }
    };

    this.#pushToRingBuffers(event, resolvedId);
    this.#dispatchEvent(event);
  }

  /**
   * Records the execution of precall tool dispatches prior to model inference.
   *
   * Increments `precallCount` by `count` on the agent record and `totalPrecallCount`
   * on the aggregate record (only when `count` is positive), then dispatches a
   * `PRECALL_DISPATCH` event carrying the recorded count and the new cumulative value.
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @param count - Number of precall tools executed. Defaults to 1 when omitted; non-finite, zero, or negative values are recorded as 0 and leave counters unchanged (the event is still dispatched).
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * telemetry.recordPrecall('agent_coder', 2);
   * ```
   */
  public recordPrecall(agentId: string, count = 1): void {
    const resolvedId = this.#resolveAgentId(agentId);
    const safeCount = (typeof count === 'number' && Number.isFinite(count) && count > 0) ? Math.floor(count) : 0;
    const metrics = this.#getOrCreateAgentMetrics(resolvedId);

    if (safeCount > 0) {
      metrics.precallCount += safeCount;
      metrics.lastUpdated = Date.now();

      this.#runtimeAggregate.totalPrecallCount += safeCount;
      this.#runtimeAggregate.lastUpdated = metrics.lastUpdated;

      this.#publishMetrics(agentId, metrics);
    }

    const event = {
      type: TELEMETRY_EVENT_TYPES.PRECALL_DISPATCH,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: Date.now(),
      payload: {
        count: safeCount,
        cumulativePrecalls: metrics.precallCount
      }
    };

    this.#pushToRingBuffers(event, resolvedId);
    this.#dispatchEvent(event);
  }

  /**
   * Safely captures a bounded summary snapshot of an agent's active context window.
   *
   * Algorithm & Memory Protection (INV-6):
   * 1. Prunes messages to `maxMessagesToRetain`: when over the limit, the first two and the most recent messages are kept (only the tail when the limit is 2 or fewer).
   * 2. Truncates individual string message `content` to `truncateContentAt` (default: 2000 chars), appending a `... [truncated N chars]` marker.
   * 3. Calculates role distribution (`{ system: N, user: N, assistant: N, tool: N }`), counting messages without a string `role` as `'unknown'`.
   * 4. Sums reported per-message token counts across the entire pre-pruning context window, using a finite non-negative numeric `tokenCount` when present; messages without one contribute 0.
   * 5. Updates `agentMetrics.lastSentContext` with the pruned, truncated array of deep-copied and deep-frozen entries (arrays/plain objects structurally, non-plain objects via `structuredClone`, never by reference), syncs the owning agent, and dispatches `CONTEXT_SNAPSHOT`; the returned record carries its own frozen array over the same frozen entries.
   *
   * Both options are normalized before use: finite values are floored and
   * clamped (`maxMessagesToRetain` ≥ 1, `truncateContentAt` ≥ 10), while
   * non-finite or non-numeric values fall back to the defaults (50 and 2000).
   *
   * @param agentId - Unique identifier of the agent. Must be a non-empty string.
   * @param messages - Formatted prompt messages array; non-array values are treated as empty.
   * @param options - Truncation and retention configuration options.
   * @returns Structured context window summary record.
   * @throws `TypeError` - Throws `ERR_TELEMETRY_INVALID_AGENT_ID` when `agentId` is not a non-blank string.
   *
   * @example
   * ```typescript
   * const snapshot = telemetry.recordContextSnapshot('agent_writer', formattedMessages, {
   *   maxMessagesToRetain: 40,
   *   truncateContentAt: 1000
   * });
   * console.log(`Captured ${snapshot.messageCount} messages (${snapshot.estimatedTokens} reported tokens)`);
   * ```
   */
  public recordContextSnapshot(
    agentId: string,
    messages: readonly unknown[],
    options: ContextSnapshotOptions = {}
  ): ContextSnapshotRecord {
    const resolvedId = this.#resolveAgentId(agentId);
    const metrics = this.#getOrCreateAgentMetrics(resolvedId);
    const safeMessages = Array.isArray(messages) ? messages : [];

    const roleDistribution: Record<string, number> = {};
    for (const msg of safeMessages) {
      const role = (msg && typeof msg === 'object' && typeof msg.role === 'string') ? msg.role : 'unknown';
      roleDistribution[role] = (roleDistribution[role] || 0) + 1;
    }

    let estimatedTokens = 0;
    for (const msg of safeMessages) {
      if (
        msg && typeof msg === 'object' &&
        typeof msg.tokenCount === 'number' &&
        Number.isFinite(msg.tokenCount) &&
        msg.tokenCount >= 0
      ) {
        estimatedTokens += msg.tokenCount;
      }
    }

    const maxMessages = normalizeBoundedOption(options?.maxMessagesToRetain, 1, DEFAULT_MAX_MESSAGES_TO_RETAIN);
    const truncateAt = normalizeBoundedOption(options?.truncateContentAt, 10, DEFAULT_TRUNCATE_CONTENT_AT);

    const sanitizedMessages = this.#captureContextMessages(safeMessages, maxMessages, truncateAt);

    metrics.lastSentContext = sanitizedMessages;
    metrics.lastUpdated = Date.now();

    this.#publishMetrics(agentId, metrics);

    const snapshotRecord = Object.freeze({
      messageCount: safeMessages.length,
      estimatedTokens,
      roleDistribution: Object.freeze(roleDistribution),
      messages: Object.freeze([...sanitizedMessages]),
      timestamp: metrics.lastUpdated
    });

    const event = {
      type: TELEMETRY_EVENT_TYPES.CONTEXT_SNAPSHOT,
      agentId: this.#publicAgentId(resolvedId),
      timestamp: snapshotRecord.timestamp,
      payload: snapshotRecord
    };

    this.#pushToRingBuffers(event, resolvedId);
    this.#dispatchEvent(event);

    return snapshotRecord;
  }

  /**
   * Records an arbitrary structured telemetry event into agent and global trace ring buffers.
   *
   * Validates the event type against canonical {@link TELEMETRY_EVENT_TYPES}, appends it
   * to the agent's ring buffer and the global ring buffer, and broadcasts to active
   * subscribers, sinks, and the emit port. A `null`/non-object event is silently ignored;
   * an unrecognized `type` is rejected with a logged `ERR_TELEMETRY_INVALID_EVENT_TYPE`
   * warning. Missing fields are normalized: `agentId` to `'global'` (which skips the
   * per-agent buffer), `timestamp` to `Date.now()`, and `payload` to `{}`. Agent metric
   * counters are not touched.
   *
   * @param event - The structured telemetry audit event to record.
   *
   * @example
   * ```typescript
   * telemetry.recordEvent({
   *   type: 'turn_start',
   *   agentId: 'agent_writer',
   *   timestamp: Date.now(),
   *   payload: { turnNumber: 1, inputSummary: 'User requested outline' }
   * });
   * ```
   */
  public recordEvent(event: TelemetryEvent): void {
    if (!event || typeof event !== 'object') {
      return;
    }
    const eventTypes = Object.values(TELEMETRY_EVENT_TYPES);
    if (!event.type || !eventTypes.includes(event.type)) {
      console.warn(`[RuntimeTelemetry] Unrecognized event type: ${event?.type} (${TELEMETRY_ERROR_CODES.INVALID_EVENT_TYPE})`);
      return;
    }

    const normalizedEvent = {
      type: event.type,
      agentId: event.agentId || 'global',
      timestamp: (typeof event.timestamp === 'number') ? event.timestamp : Date.now(),
      payload: event.payload || {}
    } as TelemetryEvent;

    this.#pushToRingBuffers(normalizedEvent, normalizedEvent.agentId);
    this.#dispatchEvent(normalizedEvent);
  }

  // --- Trace Queries & Ring Buffer Access ---

  /**
   * Queries the bounded trace ring buffer for historical execution events.
   *
   * Ring Buffer Mechanics (INV-2):
   * Queries either an individual agent's dedicated ring buffer or the global sandbox buffer.
   * Returns a shallow-cloned array of event objects; nested `payload` references are shared
   * with the ring buffers, so callers must not mutate them.
   *
   * Filters apply in order: `type`, then `sinceTimestamp` (inclusive), then `order`, then
   * `limit`. Because ordering precedes limiting, `order: 'desc'` with a `limit` returns the
   * newest events. When `limit` is omitted, the result is capped at 100 matching events
   * (`order: 'desc'` therefore yields the newest 100).
   *
   * @param agentId - Optional agent ID to filter by. When omitted, blank, or null, queries the global ring buffer; an unknown agent ID yields an empty array.
   * @param query - Optional filtering by event type, minimum timestamp, limit, and sort order.
   * @returns Chronological defensive array of matching trace events.
   *
   * @example
   * ```typescript
   * // Query last 20 tool executions for an agent:
   * const toolEvents = telemetry.getTrace('agent_coder', {
   *   type: 'tool_execution',
   *   limit: 20,
   *   order: 'desc'
   * });
   *
   * // Query global sandbox trace:
   * const globalTrace = telemetry.getTrace(undefined, { limit: 100 });
   * ```
   */
  public getTrace(agentId: string | null = null, query: TraceQueryOptions | null = null): TelemetryEvent[] {
    let events: TelemetryEvent[];
    if (typeof agentId === 'string' && agentId.trim().length > 0) {
      const ring = this.#traceRingBuffers.get(agentId.trim());
      events = ring ? ring.toArray() : [];
    } else {
      events = this.#globalRingBuffer.toArray();
    }

    if (query && typeof query === 'object') {
      if (query.type) {
        events = events.filter(e => e.type === query.type);
      }
      if (typeof query.sinceTimestamp === 'number') {
        const sinceTimestamp = query.sinceTimestamp;
        events = events.filter(e => e.timestamp >= sinceTimestamp);
      }
      if (query.order === 'desc') {
        events = events.slice().reverse();
      }
    }

    const limit = (query && typeof query.limit === 'number' && Number.isFinite(query.limit))
      ? Math.max(0, Math.floor(query.limit))
      : DEFAULT_TRACE_QUERY_LIMIT;
    events = events.slice(0, limit);

    return events.map(e => ({ ...e }));
  }

  /**
   * Clears the trace ring buffer for a specific agent or globally across the sandbox.
   *
   * @param agentId - Optional agent ID. If a non-blank ID is provided, clears that agent's
   * ring buffer (an unknown ID is a no-op); if omitted or blank, clears every per-agent
   * buffer plus the global buffer.
   *
   * @example
   * ```typescript
   * // Clear specific agent buffer:
   * telemetry.clearTrace('agent_coder');
   *
   * // Clear all trace buffers:
   * telemetry.clearTrace();
   * ```
   */
  public clearTrace(agentId: string | null = null): void {
    if (typeof agentId === 'string' && agentId.trim().length > 0) {
      const ring = this.#traceRingBuffers.get(agentId.trim());
      if (ring) {
        ring.clear();
      }
    } else {
      for (const ring of this.#traceRingBuffers.values()) {
        ring.clear();
      }
      this.#globalRingBuffer.clear();
    }
  }

  // --- Event Subscription & Sink Management ---

  /**
   * Subscribes an observer callback to receive all dispatched telemetry events.
   *
   * Exception Shielding Invariant (INV-5):
   * Observer execution is wrapped in a try/catch boundary. If a subscriber throws an uncaught error,
   * the exception is captured, logged as `ERR_TELEMETRY_SUBSCRIBER_EXCEPTION`, and execution continues
   * without interrupting the agent turn execution pipeline.
   *
   * @param listener - Callback function receiving {@link TelemetryEvent} instances.
   * @returns Idempotent unsubscribe function removing the listener.
   * @throws `TypeError` - Throws when `listener` is not a function.
   *
   * @example
   * ```typescript
   * const unsubscribe = telemetry.subscribe((event) => {
   *   if (event.type === 'token_usage') {
   *     console.log(`Agent ${event.agentId} consumed tokens:`, event.payload);
   *   }
   * });
   *
   * // Clean up subscription when no longer needed:
   * unsubscribe();
   * ```
   */
  public subscribe(listener: TelemetrySubscriber): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Subscriber must be a function');
    }
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  /**
   * Attaches an external event sink for decoupled event forwarding.
   *
   * Forwards all dispatched telemetry events to `sink.emit(event)`.
   * Sink execution errors are caught and logged as `ERR_TELEMETRY_SINK_DISPATCH_FAILED`.
   *
   * @param sink - Object implementing the {@link TelemetrySink} interface.
   * @returns Idempotent detach function removing the sink.
   * @throws `TypeError` - Throws when `sink` is missing or has no `emit` function.
   *
   * @example
   * ```typescript
   * const detach = telemetry.attachSink({
   *   emit(event) {
   *     externalTelemetryService.send(event);
   *   }
   * });
   *
   * // Detach sink:
   * detach();
   * ```
   */
  public attachSink(sink: TelemetrySink): () => void {
    if (!sink || typeof sink.emit !== 'function') {
      throw new TypeError('Sink must be an object with an emit method');
    }
    this.#sinks.add(sink);
    return () => {
      this.#sinks.delete(sink);
    };
  }

  // --- Backward Compatibility Facade Methods ---

  /**
   * Initializes (or seeds) telemetry metrics for an agent and returns a frozen
   * metrics snapshot. Creates the tracking record when absent, so the active-agent
   * count grows.
   *
   * Agent telemetry is never mutated directly: when the collector was constructed
   * with an {@link AgentTelemetryAccessor}, snapshot sync flows through it. In
   * standalone legacy mode (no accessor) an object argument is backfilled in place
   * without overwriting existing telemetry numbers, and agent-facing
   * `lastSentContext` arrays are always fresh copies (never aliases of internal
   * storage). Seeding and backfill hydrate `lastSentContext` only when it is
   * absent or empty, and the hydrated entries are deep-copied and deep-frozen
   * under the default retention bound; a non-empty context already captured in
   * this process is retained (sends are latest-wins).
   *
   * @param agentOrId - Agent object (resolving `.id`) or string ID.
   * @param seedSnapshot - Optional read-only telemetry snapshot used to seed cumulative counters; finite seed values are floored to non-negative integers and seeding only raises values, never lowers recorded counters.
   * @returns Frozen metrics snapshot, or `null` for an invalid identifier; never throws.
   *
   * @example
   * ```typescript
   * const telemetryData = telemetry.initializeTelemetry('agent_alpha');
   * ```
   */
  public initializeTelemetry(agentOrId: unknown, seedSnapshot: unknown = null): AgentTelemetryMetrics | null {
    if (!agentOrId) return null;
    let agentId: string | null = null;
    if (typeof agentOrId === 'string') {
      agentId = agentOrId.trim();
    } else if (typeof agentOrId === 'object') {
      const candidate = agentOrId as { id?: unknown };
      if (typeof candidate.id === 'string') {
        agentId = candidate.id.trim();
      }
    }
    if (!agentId) return null;

    const metrics = this.#getOrCreateAgentMetrics(agentId);
    if (seedSnapshot && typeof seedSnapshot === 'object') {
      this.#seedCumulativeCounters(metrics, seedSnapshot);
    }
    if (this.#agentAccessor) {
      this.#syncAgentMetrics(metrics);
    } else if (agentOrId && typeof agentOrId === 'object') {
      this.#legacyBackfillAgent(agentOrId, metrics);
    }

    return this.#createSnapshot(metrics);
  }

  /**
   * Legacy alias for `getAgentMetrics`. Accepts an agent object (resolving `.id`) or string ID.
   *
   * @param agentOrId - Agent object or string ID.
   * @returns Defensive copy of agent metrics, or `null` if invalid identifier; never throws.
   *
   * @example
   * ```typescript
   * const legacyMetrics = telemetry.getAgentTelemetry(agentInstance);
   * ```
   */
  public getAgentTelemetry(agentOrId: unknown): AgentTelemetryMetrics | null {
    if (!agentOrId) return null;
    let agentId: string | null = null;
    if (typeof agentOrId === 'string' && agentOrId.trim().length > 0) {
      agentId = agentOrId.trim();
    } else if (typeof agentOrId === 'object') {
      const candidate = agentOrId as { id?: unknown };
      if (typeof candidate.id === 'string' && candidate.id.trim().length > 0) {
        agentId = candidate.id.trim();
      }
    }
    if (!agentId) return null;

    try {
      return this.getAgentMetrics(agentId);
    } catch {
      return null;
    }
  }

  /**
   * Legacy alias for `resetAgentMetrics`. Accepts an agent object (resolving `.id`) or string ID.
   *
   * @param agentOrId - Agent object or string ID.
   * @returns True if agent was found and reset, false otherwise.
   *
   * @example
   * ```typescript
   * const success = telemetry.clearAgentTelemetry(agentInstance);
   * ```
   */
  public clearAgentTelemetry(agentOrId: unknown): boolean {
    if (!agentOrId) return false;
    let agentId: string | null = null;
    if (typeof agentOrId === 'string' && agentOrId.trim().length > 0) {
      agentId = agentOrId.trim();
    } else if (typeof agentOrId === 'object') {
      const candidate = agentOrId as { id?: unknown };
      if (typeof candidate.id === 'string' && candidate.id.trim().length > 0) {
        agentId = candidate.id.trim();
      }
    }
    if (!agentId) return false;

    return this.resetAgentMetrics(agentOrId as string);
  }
}

// ============================================================================
// 7. Factory Function & Aliases
// ============================================================================

/**
 * Factory function creating a configured `RuntimeTelemetry` collector instance.
 *
 * Provides ergonomic instantiation with default or customized ring buffer capacities
 * and attached sinks.
 *
 * @param options - Telemetry configuration options.
 * @returns Fully configured RuntimeTelemetry collector.
 *
 * @example
 * ```typescript
 * import { createTelemetryCollector } from './runtimeTelemetry/index.ts';
 *
 * const telemetry = createTelemetryCollector({
 *   maxTraceEventsPerAgent: 100,
 *   maxGlobalTraceEvents: 500
 * });
 * ```
 */
export function createTelemetryCollector(
  options: TelemetryCollectorOptions = {}
): RuntimeTelemetry {
  return new RuntimeTelemetry(options);
}

/**
 * Class alias for `RuntimeTelemetry` provided for backward compatibility with legacy imports.
 *
 * @deprecated Use {@link RuntimeTelemetry} or {@link createTelemetryCollector} instead.
 *
 * @example
 * ```typescript
 * import { RuntimeTelemetryTracker } from './runtimeTelemetry/index.ts';
 *
 * const tracker = new RuntimeTelemetryTracker();
 * ```
 */
export const RuntimeTelemetryTracker: typeof RuntimeTelemetry = RuntimeTelemetry;
