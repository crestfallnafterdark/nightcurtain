/**
 * @packageDocumentation
 * Canonical TypeScript definitions for the turn execution engine (Layer 2).
 * Governs the lifecycle of single-agent conversational turns, orchestrating input intake,
 * prompt preparation, multi-turn LLM inference loops, streaming token dispatch,
 * tool call evaluation, next-turn precall pipelining, concurrency serialization,
 * and cooperative cancellation.
 *
 * @module runtime/turnExecutionEngine
 * @mayImport type-only ../index.ts
 * @mayImport ../../toolDefinitions/index.ts
 * @mayImport ../../tools/descriptors/index.ts
 * @mayImport ../../realmCatalog/index.ts
 * @mayImport ../../virtualFs/index.ts
 * @mayImport ../agent/index.ts
 * @invariant Every `executeAgentTurn` call settles into exactly one terminal outcome: a receipt with one terminal `EXECUTION_STATUS` (`completed`, `skipped`, or `cancelled`) or a thrown error; a completed turn emits `turn_complete` exactly once.
 * @invariant At most one turn executes per agent: concurrent calls chain onto `agent.currentTurnPromise` and, after it settles, revalidate agent existence, `terminated`/`recycled` state, and abort state before running.
 * @invariant An auto-triggered mail wake (`autoTrigger` with null/empty input or `triggerType === 'mail'`) with zero unread messages resolves `{ status: 'skipped', skipped: true }` without model invocation.
 * @invariant Cancellation is cooperative: an external `AbortSignal` aborts the agent's internal controller, stream/tool/loop boundaries re-check abort state, the turn settles `cancelled` with `TURN_ABORTED`, and abort listeners are removed in `finally`.
 * @invariant Precalls are fail-closed: a raw or canonical name absent from the frozen `PRECALL_ALLOWLIST` yields an `isError` tool receipt coded `FORBIDDEN_PRECALL` and is never executed; terminal-batch queued calls are re-validated through the same gate.
 * @invariant Host-registered custom tool handlers execute only for callers whose frozen `AuthorityDescriptor` grants the wildcard `'*'` or `'@lifecycle:authority'` (or an engine-internal principal projection); a matching `allowedTools` entry never authorizes custom execution, anonymous callers are denied, and custom schemas are hidden from ungranted callers.
 * @invariant Publishing meta-tool schemas (`import_realm_template`/`submit_hydration_package`) are appended to the model-facing schema list only when the agent's frozen `AuthorityDescriptor` explicitly holds the matching `@template:authority`/`@hydration:authority` id; the wildcard `'*'` and `privileged` never expose them, and a descriptor-less or anonymous caller sees no publishing surface.
 * @invariant Precall execution exceptions are converted to `isError` tool receipts (`PRECALL_EXECUTION_ERROR`) and never halt the turn.
 * @invariant The multi-turn tool loop is bounded by a positive numeric `agent.config.maxTurns`; absent or non-positive values leave it open-ended by design (accepted QUIRK-001, no hard cap). When the budget is exhausted while the model is still dispatching tool calls, the turn throws an `Error` coded `MAX_TURNS_EXCEEDED` instead of resolving `completed`.
 * @invariant `EXECUTION_STATUS` and `EXECUTION_ERROR_CODES` (including `MAX_TURNS_EXCEEDED`) are frozen dictionaries and back every `status` and receipt `code` the engine returns. The concurrency chain always awaits `agent.currentTurnPromise`, so no `AGENT_BUSY` code exists.
 * @invariant Every assistant history message carries `reasoning_content` as a string primitive (default `''`), never `null` or `undefined` (INV-REASONING-STRING).
 * @invariant `agent.currentStream`, `agent.currentReasoning`, `agent.activeToolCalls`, and `agent.abortController` are reset in a `finally` block on every settlement; emission and trigger failures never propagate into turn execution.
 * @invariant Every settled turn kicks the injected `triggerQueue.processTick()` from a `finally` block.
 * @invariant MOD-20 turn-start materialization runs at most once per turn: when the agent exposes `materializeEffectiveModel()`, the engine calls it exactly once after staging and immediately before the inference loop, and mock agents without the hook are unaffected.
 * @invariant Realm-local identity wiring: every bus operation a turn performs addresses the agent's canonical `(realmId, agentId)` registration key — unread probes, inbox drains, mail sends, and the pre-turn auto-trigger check — so a same-literal-id pair never shares a mailbox. The tool execution context binds the trusted canonical `callerKey` alongside the bare caller identity, and the bound private workspace consumes the VFS-owned rule (`resolveAgentPrivateWorkspaceKey`: an explicit `config.workspaceId` pin verbatim, else the canonical identity for a Realm-bound agent, else the legacy bare id) so writes, mounts, and lifecycle eviction agree on one storage key.
 * @decision `executeAgentTurn` is the sole public turn entry; the dead `_runTurn`/`runTurn` delegate was pruned rather than declared
 * @decision Terminal `batch_precall` close is blocked by unwrapped self-validation failures (`{ success: false }`): `pendingPrecalls` are cleared and the model is re-invoked; wrapped execution failures (`{ name, result: { success: false } }`) do not block close and remain visible in history, `pendingPrecalls`, and terminal-stop telemetry
 * @decision A completed turn emits `turn_complete` exactly once; the duplicate telemetry emission was removed
 * @decision Precall-allowlist enforcement is fail-closed on an unresolved canonical name — deny (`FORBIDDEN_PRECALL`) rather than allow
 * @decision `EXECUTION_STATUS` declares terminal receipt outcomes only: `IDLE`/`RUNNING`/`ERRORED` were pruned as unreachable — execution lifecycle state lives on `AGENT_STATES`, and unhandled failures throw instead of resolving a receipt
 * @decision Mail-injection operator attribution: an injection whose effective sender is the default operator label `'user'` is a host/operator action, so the engine binds the runtime's opaque operator principal (the exact `InternalPrincipal` reference obtained through the runtime view, which the bus validates by reference) as the execution-context caller of the bus send while presenting the envelope under the operator label — never as a payload/realm claim and never as an agent id; any other explicit agent sender keeps the legacy contextless agent-scoped path, and a runtime without an operator principal stays fail-closed
 */

import type {
  AgentConfig,
  AgentIdentityPort,
  AgentState,
  HistoryMessage,
  LifecyclePort,
  SubsystemEmitPort
} from '../index.ts';
import { AGENT_STATES } from '../agentLifecycle/index.ts';
import { createAgentIdentityKey } from '../agent/index.ts';
import { formatMessagesWithToolHygiene } from '../messageHygiene/index.ts';
import { generateMessageId } from '../historyManager/index.ts';
import { RuntimeTelemetryTracker } from '../runtimeTelemetry/index.ts';
import { HistoryManager } from '../historyManager/index.ts';
import {
  SANDBOX_TOOLS,
  INNATE_TOOLS,
  getSandboxToolsSchema,
  createSandboxToolDispatcher
} from '../../toolDefinitions/index.ts';
import { getPublishingToolSchemas } from '../../tools/descriptors/index.ts';
import { AGENT_AUTHORITIES } from '../../realmCatalog/index.ts';
import { AGENT_WORKSPACE_VIEW_TOKEN, resolveAgentPrivateWorkspaceKey } from '../../virtualFs/index.ts';
import type {
  ExecutionContext,
  OpenAIToolDefinition,
  RealmPublishingPort,
  SandboxToolDispatcher
} from '../../toolDefinitions/index.ts';

/**
 * Narrow structural views of the runtime, agent, provider, and substrate
 * shapes consumed by this engine. Private to this module: consumers name the
 * exported contracts (e.g. `TurnExecutionAgent`) instead of these internal
 * views.
 */
interface EngineModelStreamChunk {
  type?: string;
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  text?: string;
  visibleProse?: string;
  currentReasoning?: string;
  toolCalls?: unknown;
  tool_calls?: unknown;
  usage?: unknown;
  finishReason?: string;
}

type EngineStreamChunk = string | EngineModelStreamChunk;

interface EngineCompletionResult {
  content?: string;
  reasoning?: string;
  toolCalls?: unknown;
  tool_calls?: unknown;
  usage?: unknown;
}

interface EngineModel {
  stream?(options: unknown): AsyncIterable<EngineStreamChunk>;
  complete?(options: unknown): Promise<EngineCompletionResult | null | undefined>;
}

interface EngineStreamOptions {
  messages: Array<{ role?: string; content?: string }>;
  tools?: OpenAIToolDefinition[];
  signal?: AbortSignal;
  onChunk: (chunk: EngineStreamChunk) => void;
}

interface EngineTelemetry {
  injectedDeliveries?: number;
  precallCount?: number;
  terminalStops?: number;
  lastSentContext?: unknown;
}

interface EngineInterruptedTurn {
  input: unknown;
  mode?: string | null;
  timestamp: number;
  cancelled: boolean;
}

type EngineAgentConfig = Omit<AgentConfig, 'customToolSchemas'> & { customToolSchemas?: unknown };

/** Caller-supplied history envelope after the engine's directive-mode normalization. */
interface CallerHistoryEnvelope {
  id?: string;
  role?: HistoryMessage['role'];
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: HistoryMessage['tool_calls'];
  reasoning_content?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface EngineAgent {
  id: string;
  name: string;
  state: AgentState;
  stateDetail: string | null;
  history: Array<HistoryMessage | CallerHistoryEnvelope>;
  config: EngineAgentConfig;
  turnCount: number;
  updatedAt: number;
  telemetry: EngineTelemetry;
  currentStream: string;
  currentReasoning: string;
  activeToolCalls: unknown[];
  redoStack: unknown[];
  pendingPrecalls: unknown[];
  lastSummary: string | null;
  lastError: string | null;
  lastInterruptedTurn: EngineInterruptedTurn | null;
  abortController: AbortController | null;
  currentTurnPromise: Promise<unknown> | null;
  model: EngineModel;
  rebindModel: () => void;
  /**
   * Optional MOD-20 W3-B2 turn-start preset-materialization hook. Present on
   * the real `Agent` entity (bound agents materialize their effective preset
   * config here); absent on mock agents, which the engine must keep working.
   */
  materializeEffectiveModel?: () => boolean;
}

interface EngineRuntimePort {
  getAgent?(agentId: string): EngineAgent | null | undefined;
  hasRecycledAgent?(agentId: string): boolean;
  createSubsystemEmitPort?(): SubsystemEmitPort;
  createLifecyclePort?(): LifecyclePort;
  createAgentIdentityPort?(): AgentIdentityPort;
  /**
   * Returns the composition-root operator principal (the opaque
   * `InternalPrincipal` reference) so operator-attributed bus sends carry the
   * exact reference the bus validates (Wave I, ticket c02d0b9).
   */
  getOperatorPrincipal?(): unknown;
  setAgentState?(agent: EngineAgent | string, newState: AgentState, stateDetail: string | null): unknown;
}

/**
 * Canonical telemetry key of a turn's agent (Wave I, ticket d57cbc1): the
 * `(realmId, agentId)` composite the runtime telemetry registry keys on, so
 * the same literal id in two Realms accumulates separate counters. Internal
 * only — never surfaced to an agent.
 *
 * @param agent - Turn's agent (its owner-controlled `config.realmId` is the
 *   membership source).
 * @returns The canonical identity key.
 * @internal
 */
function telemetryIdentityKey(agent: EngineAgent): string {
  const rawRealmId = agent?.config?.realmId;
  const realmId = typeof rawRealmId === 'string' && rawRealmId ? rawRealmId : null;
  return createAgentIdentityKey(realmId, agent.id);
}

interface EngineMessagingBus {
  getUnreadCount?(agentId: string): number;
  listInbox?(agentId: string, options?: { unreadOnly?: boolean }): unknown;
  drainInbox?(agentId: string): unknown;
  sendMessage?(
    payload: { from: string; to: string; content: string; metadata: Record<string, unknown> },
    context?: { callerAgentId?: string; callerKey?: string; principal?: unknown }
  ): unknown;
}

/**
 * Structural view of a runtime identity projection consumed by the turn
 * engine (Wave I, ticket d57cbc1): the canonical registration `key`, bare
 * `id`, realm scope, and the projected private-workspace pin.
 */
interface EngineIdentityProjection {
  readonly key?: string;
  readonly id?: string;
  readonly realmId?: string | null;
  readonly realmBypass?: boolean;
  readonly workspaceId?: string | null;
  readonly privileged?: boolean;
  readonly allowedTools?: readonly string[];
  readonly authority?: unknown;
}

interface EngineTriggerQueue {
  processTick?(): Promise<unknown>;
}

interface EngineTelemetryPort {
  initializeTelemetry(agentOrId: unknown, seedSnapshot?: unknown): unknown;
  recordInjectedDelivery(agentOrId: unknown, count?: number): void;
  recordPrecall(agentOrId: unknown, count?: number): void;
  recordTerminalStop(agentOrId: unknown, payload?: unknown): void;
  recordTurnUsage(agentOrId: unknown, payload?: unknown): unknown;
}

interface EngineCustomToolContext {
  virtualFs: unknown;
  messagingBus: unknown;
  agentId: string;
  lifecyclePort: LifecyclePort | null;
  identityPort: AgentIdentityPort | null;
  executeTool(name: string, args: Record<string, unknown>, callerContext?: ExecutionContext): Promise<unknown>;
}

type EngineCustomToolHandler = (args?: unknown, context?: EngineCustomToolContext) => unknown;

interface EngineToolCall {
  id: string;
  type: 'function';
  name: string;
  args: Record<string, unknown>;
  arguments?: Record<string, unknown> | string;
  function: { name: string; arguments: string };
}

interface EngineSyntheticToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface DeduplicatedPrecall {
  name: string;
  arguments: unknown;
  [key: string]: unknown;
}

interface EngineEmitEvent {
  type: string;
  agentId: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Reads an own or inherited property from an unknown value without asserting a
 * shape beyond the object guard.
 */
function readProperty(value: unknown, key: string): unknown {
  if (value !== null && typeof value === 'object' && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Renders an unknown thrown value as the message string the engine stores. */
function errorText(err: unknown): string {
  const message = readProperty(err, 'message');
  if (message) {
    return typeof message === 'string' ? message : String(message);
  }
  return String(err);
}

/** Normalizes a `drainInbox` result into the list of drained entries the engine consumes. */
function toDrainedMessages(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Reads the array length of a `listInbox` result, defaulting malformed values to 0. */
function inboxLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Capability name that authorizes host-only custom tool execution.
 *
 * Mirrors the `'@lifecycle:authority'` sentinel used by
 * `runtime/agentLifecycle` and `runtime/runtimeScheduler`; declared as a local
 * structural literal so this module never imports those modules' internals.
 */
const LIFECYCLE_AUTHORITY_CAPABILITY = '@lifecycle:authority';

/**
 * Operator presentation label of the mail-injection channel: an injection whose
 * effective sender is `'user'` (the documented default) denotes the human
 * operator. The engine maps that label to the runtime's opaque operator
 * principal for Realm scope resolution (ticket 99faaf1; Wave I, ticket
 * c02d0b9); the label itself never grants anything — the bus validates the
 * principal by exact reference, and without one the send stays ungrouped
 * (fail-closed). Any other explicit sender is agent-scoped and unchanged.
 */
const OPERATOR_SENDER_LABEL = 'user';

/** Resolves a custom tool entry (direct handler or `{ handler }` wrapper) from a registry. */
function resolveCustomToolHandler(registry: unknown, name: string): EngineCustomToolHandler | null {
  const entry = readProperty(registry, name);
  if (typeof entry === 'function') return entry as EngineCustomToolHandler;
  const handler = readProperty(entry, 'handler');
  if (handler) return handler as EngineCustomToolHandler;
  return null;
}

/** Normalizes raw provider tool calls into the engine's canonical call shape. */
function normalizeToolCalls(raw: unknown): EngineToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((entry) => {
    const fn = readProperty(entry, 'function');
    const rawName = readProperty(entry, 'name') || readProperty(fn, 'name');
    const name = typeof rawName === 'string' ? rawName : (rawName ? String(rawName) : '');
    const rawId = readProperty(entry, 'id');
    const id = typeof rawId === 'string' && rawId ? rawId : generateMessageId('call');
    let rawArgs = readProperty(entry, 'rawArguments');
    if (rawArgs === undefined) {
      const fnArgs = readProperty(fn, 'arguments');
      const entryArgs = readProperty(entry, 'args');
      if (fnArgs !== undefined) {
        rawArgs = typeof fnArgs === 'string' ? fnArgs : JSON.stringify(fnArgs);
      } else if (entryArgs !== undefined) {
        rawArgs = typeof entryArgs === 'string' ? entryArgs : JSON.stringify(entryArgs);
      } else {
        rawArgs = '{}';
      }
    }
    let parsedArgs = readProperty(entry, 'args') || readProperty(fn, 'arguments');
    if (typeof parsedArgs === 'string') {
      try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = { raw: parsedArgs }; }
    } else if (!parsedArgs || typeof parsedArgs !== 'object') {
      try { parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : {}; } catch { parsedArgs = {}; }
    }
    return {
      id,
      type: 'function',
      name,
      args: parsedArgs as Record<string, unknown>,
      function: {
        name,
        arguments: rawArgs as string
      }
    };
  });
}

/**
 * Canonical enumeration of terminal turn execution outcomes.
 *
 * Eliminates fragile string literal matching across callers, tests, and UI stores.
 *
 * Invariant: A settled turn resolves with exactly one terminal status (`COMPLETED`, `SKIPPED`, or `CANCELLED`) or throws.
 * `IDLE`, `RUNNING`, and `ERRORED` are deliberately absent: execution lifecycle state is tracked on the agent
 * (`AGENT_STATES`), and unhandled model, tool, or runtime failures throw instead of resolving a receipt
 * (evidence: no assignment site in `turnExecutionEngine/index.ts` ever produced them).
 *
 * @readonly
 * Enum of `string` values:
 * - `COMPLETED` (`'completed'`) - Turn concluded successfully via natural prose response or terminal batch precall.
 * - `SKIPPED` (`'skipped'`) - Turn was auto-triggered (e.g. mail wake) but skipped because unread count was 0.
 * - `CANCELLED` (`'cancelled'`) - Turn was cooperatively aborted via `AbortSignal` or `cancelAgentTurn`.
 *
 * @example
 * ```typescript
 * import { EXECUTION_STATUS, type TurnExecutionResult } from './turnExecutionEngine/index.ts';
 *
 * function handleResult(result: TurnExecutionResult): void {
 *   switch (result.status) {
 *     case EXECUTION_STATUS.COMPLETED:
 *       console.log('Turn output:', result.output);
 *       break;
 *     case EXECUTION_STATUS.SKIPPED:
 *       console.log('Turn skipped (no unread mail)');
 *       break;
 *     case EXECUTION_STATUS.CANCELLED:
 *       console.warn('Turn was cancelled cooperatively');
 *       break;
 *   }
 * }
 * ```
 */
export const EXECUTION_STATUS = Object.freeze({
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled'
} as const);

/**
 * Union type representing all valid terminal turn execution status literals.
 *
 * @example
 * ```typescript
 * function isTerminalStatus(status: ExecutionStatus): boolean {
 *   return status === 'completed' || status === 'cancelled' || status === 'skipped';
 * }
 * ```
 */
export type ExecutionStatus = typeof EXECUTION_STATUS[keyof typeof EXECUTION_STATUS];

/**
 * Standardized frozen dictionary of error codes emitted by `TurnExecutionEngine`.
 *
 * Ensures programmatic, deterministic error handling without brittle string substring parsing.
 *
 * @readonly
 * Enum of `string` values:
 * - `INVALID_ARGUMENTS` (`'INVALID_ARGUMENTS'`) - Required turn execution arguments (e.g., agent ID) are missing or invalid.
 * - `AGENT_NOT_FOUND` (`'AGENT_NOT_FOUND'`) - Target agent does not exist in the runtime agent registry.
 * - `AGENT_TERMINATED` (`'AGENT_TERMINATED'`) - Target agent is in the recycle bin or has lifecycle state `TERMINATED` / `RECYCLED`.
 * - `TURN_ABORTED` (`'TURN_ABORTED'`) - Turn execution was aborted via `AbortSignal` or `cancelAgentTurn`.
 * - `MODEL_INVOCATION_ERROR` (`'MODEL_INVOCATION_ERROR'`) - LLM model provider threw an unhandled exception or network failure.
 * - `TOOL_EXECUTION_ERROR` (`'TOOL_EXECUTION_ERROR'`) - Innate or sandbox tool dispatcher execution encountered an unhandled error.
 * - `FORBIDDEN_PRECALL` (`'FORBIDDEN_PRECALL'`) - Queued precall tool name is not present in `PRECALL_ALLOWLIST`.
 * - `PRECALL_EXECUTION_ERROR` (`'PRECALL_EXECUTION_ERROR'`) - Precall tool execution threw an exception (recorded as tool error response).
 * - `MAX_TURNS_EXCEEDED` (`'MAX_TURNS_EXCEEDED'`) - Multi-turn tool loop exceeded `agent.config.maxTurns` limit without concluding.
 *
 * @example
 * ```typescript
 * import { EXECUTION_ERROR_CODES, TurnExecutionEngine } from './turnExecutionEngine/index.ts';
 *
 * const engine = new TurnExecutionEngine({ runtime });
 * try {
 *   await engine.executeAgentTurn('invalid_agent_id', 'Hello');
 * } catch (err: unknown) {
 *   const code = (err as { code?: ExecutionErrorCode }).code;
 *   if (code === EXECUTION_ERROR_CODES.AGENT_NOT_FOUND) {
 *     console.error('Cannot run turn: Agent does not exist in registry');
 *   }
 * }
 * ```
 */
export const EXECUTION_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_TERMINATED: 'AGENT_TERMINATED',
  TURN_ABORTED: 'TURN_ABORTED',
  MODEL_INVOCATION_ERROR: 'MODEL_INVOCATION_ERROR',
  TOOL_EXECUTION_ERROR: 'TOOL_EXECUTION_ERROR',
  FORBIDDEN_PRECALL: 'FORBIDDEN_PRECALL',
  PRECALL_EXECUTION_ERROR: 'PRECALL_EXECUTION_ERROR',
  MAX_TURNS_EXCEEDED: 'MAX_TURNS_EXCEEDED'
} as const);

/**
 * Union type representing all valid turn execution error code string literals.
 *
 * @example
 * ```typescript
 * function handleExecutionError(code: ExecutionErrorCode, message: string): void {
 *   console.error(`Execution error [${code}]: ${message}`);
 * }
 * ```
 */
export type ExecutionErrorCode = typeof EXECUTION_ERROR_CODES[keyof typeof EXECUTION_ERROR_CODES];

/**
 * Orchestrator Action Modes determining how incoming input is ingested into agent history.
 *
 * Invariant 2 (Orchestrator Action Modes):
 * - `'directive'` (Default): Standard user or supervisor instruction. Appends a user message to `agent.history`.
 *   If unread messages exist in `MessagingBus`, also executes mailbox intake (piggybacked mail wake).
 * - `'system'`: System directive or operational constraint. Injected as a `system` message into `agent.history`.
 *   Does NOT drain mail unless explicitly requested.
 * - `'injection'`: Asynchronous event or inter-agent message delivery. The content is routed into the agent's
 *   mailbox via `messagingBus.sendMessage(...)`, followed immediately by a mailbox wake turn.
 *
 * @example
 * ```typescript
 * const mode: OrchestratorActionMode = 'directive';
 * ```
 */
export type OrchestratorActionMode = 'directive' | 'system' | 'injection';

/**
 * Inspects a tool response for execution or validation errors (R2.3, R5.1).
 * Private internal helper.
 * @param resp - Raw tool response record.
 * @returns True if the tool response represents a failure.
 */
function isToolResponseError(resp: unknown): boolean {
  if (!resp) return false;
  let content = readProperty(resp, 'content');
  const success = readProperty(resp, 'success');
  const error = readProperty(resp, 'error');
  if (content === undefined || content === null) {
    if (success === false || (error !== undefined && error !== null && error !== false && error !== '')) {
      return true;
    }
    return false;
  }
  if (typeof content === 'string') {
    const rawContent = content;
    try {
      content = JSON.parse(rawContent);
    } catch {
      if (success === false || (typeof error === 'string' && error)) return true;
      const lower = rawContent.toLowerCase();
      if (lower.startsWith('error:') || lower.includes('"success":false') || lower.includes('"success": false')) {
        return true;
      }
      return false;
    }
  }
  if (typeof content === 'object' && content !== null) {
    if (readProperty(content, 'success') === false) return true;
    const contentError = readProperty(content, 'error');
    if (contentError !== undefined && contentError !== null && contentError !== false && contentError !== '') return true;
    const status = readProperty(content, 'status');
    if (status === 'error' || status === 'failed') return true;
  }
  if (success === false || (error !== undefined && error !== null && error !== false && error !== '')) {
    return true;
  }
  return false;
}

/**
 * Ratified Precall Allowlist.
 * Precalls are strictly restricted to read/observe operations.
 *
 * Explicit aliases below mirror the canonical master alias map
 * (`tools/normalizers/aliasMap.ts`). Phantom names that the canonical resolver
 * cannot resolve must stay out of this set (and out of `normalizeToolName`),
 * otherwise this gate would allow what the descriptor gate fail-closes
 * (`tools/descriptors/precallTools.ts` -\> `getCanonToolName`). R4: `'time_now'` was such a
 * phantom and was removed; only canonical-resolvable aliases are listed.
 */
const PRECALL_ALLOWLIST = Object.freeze(new Set([
  SANDBOX_TOOLS.READ_FILE,
  SANDBOX_TOOLS.QUERY_JSON,
  SANDBOX_TOOLS.LIST_FILES,
  SANDBOX_TOOLS.GREP,
  SANDBOX_TOOLS.GET_CURRENT_TIME,
  SANDBOX_TOOLS.WORLD_CLOCK,
  SANDBOX_TOOLS.EVENT_LIST,
  SANDBOX_TOOLS.LIST_AGENTS,
  SANDBOX_TOOLS.WHOAMI,
  SANDBOX_TOOLS.LIST_INBOX,
  SANDBOX_TOOLS.READ_MESSAGE,
  SANDBOX_TOOLS.GET_ARCHIVE,
  SANDBOX_TOOLS.GET_INBOX,
  SANDBOX_TOOLS.DESCRIBE_TOOL,
  'read_file', 'readFile', 'fs_readFile', 'virtualFs_readFile',
  'query_json', 'queryJson', 'fs_queryJson', 'virtualFs_queryJson',
  'list_files', 'listFiles', 'fs_listFiles', 'virtualFs_listFiles',
  'grep', 'fs_grep', 'virtualFs_grep',
  'get_current_time', 'getCurrentTime',
  'world_clock', 'worldClock',
  'event_list', 'eventList', 'listEvents', 'list_events',
  'list_agents', 'listAgents',
  'whoami', 'who_am_i', 'whoAmI', 'runtime_whoami',
  'list_inbox', 'listInbox', 'messaging_listInbox',
  'read_message', 'readMessage', 'messaging_readMessage',
  'get_archive', 'getArchive', 'messaging_getArchive',
  'get_inbox', 'getInbox', 'messaging_getInbox',
  'describe_tool', 'describeTool', 'system_describeTool'
]));

/**
 * Normalizes tool name variants and aliases to canonical names.
 * Private internal helper.
 * @param name - Raw tool name variant or alias.
 * @returns Canonical tool name.
 */
function normalizeToolName(name: unknown): string {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  const unnamespaced = trimmed.replace(/^(runtime|fs|virtualFs|messaging|system|clock)[._]/i, '');
  const snake = unnamespaced.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  
  if (snake === 'batch_precall' || trimmed === 'runtime_batchPrecall' || trimmed === 'batchPrecall' || trimmed === 'runtimeBatchPrecall') {
    return SANDBOX_TOOLS.BATCH_PRECALL || 'batch_precall';
  }
  if (snake === 'read_file' || trimmed === 'readFile') return SANDBOX_TOOLS.READ_FILE || 'read_file';
  if (snake === 'write_file' || trimmed === 'writeFile') return SANDBOX_TOOLS.WRITE_FILE || 'write_file';
  if (snake === 'replace_file_content' || trimmed === 'replaceFileContent' || snake === 'replace_content') return SANDBOX_TOOLS.REPLACE_FILE_CONTENT || 'replace_file_content';
  if (snake === 'copy_file' || trimmed === 'copyFile') return SANDBOX_TOOLS.COPY_FILE || 'copy_file';
  if (snake === 'delete_file' || trimmed === 'deleteFile') return SANDBOX_TOOLS.DELETE_FILE || 'delete_file';
  if (snake === 'list_files' || trimmed === 'listFiles') return SANDBOX_TOOLS.LIST_FILES || 'list_files';
  if (snake === 'write_json' || trimmed === 'writeJson') return SANDBOX_TOOLS.WRITE_JSON || 'write_json';
  if (snake === 'query_json' || trimmed === 'queryJson') return SANDBOX_TOOLS.QUERY_JSON || 'query_json';
  if (snake === 'json_patch' || trimmed === 'jsonPatch') return SANDBOX_TOOLS.JSON_PATCH || 'json_patch';
  if (snake === 'grep') return SANDBOX_TOOLS.GREP || 'grep';
  if (snake === 'set_permissions' || trimmed === 'setPermissions') return SANDBOX_TOOLS.SET_PERMISSIONS || 'set_permissions';
  if (snake === 'send_message' || trimmed === 'sendMessage') return SANDBOX_TOOLS.SEND_MESSAGE || 'send_message';
  if (snake === 'wait_for_mail' || trimmed === 'waitForMail') return SANDBOX_TOOLS.WAIT_FOR_MAIL || 'wait_for_mail';
  if (snake === 'list_inbox' || trimmed === 'listInbox') return SANDBOX_TOOLS.LIST_INBOX || 'list_inbox';
  if (snake === 'read_message' || trimmed === 'readMessage') return SANDBOX_TOOLS.READ_MESSAGE || 'read_message';
  if (snake === 'get_archive' || trimmed === 'getArchive') return SANDBOX_TOOLS.GET_ARCHIVE || 'get_archive';
  if (snake === 'inline_file_in_message' || trimmed === 'inlineFileInMessage') return SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE || 'inline_file_in_message';
  if (snake === 'get_inbox' || trimmed === 'getInbox') return SANDBOX_TOOLS.GET_INBOX || 'get_inbox';
  if (snake === 'drain_inbox' || trimmed === 'drainInbox') return SANDBOX_TOOLS.DRAIN_INBOX || 'drain_inbox';
  if (snake === 'spawn_agent' || trimmed === 'spawnAgent') return SANDBOX_TOOLS.SPAWN_AGENT || 'spawn_agent';
  if (snake === 'kill_agent' || trimmed === 'killAgent') return SANDBOX_TOOLS.KILL_AGENT || 'kill_agent';
  if (snake === 'list_agents' || trimmed === 'listAgents') return SANDBOX_TOOLS.LIST_AGENTS || 'list_agents';
  if (snake === 'whoami' || snake === 'who_am_i') return SANDBOX_TOOLS.WHOAMI || 'whoami';
  if (snake === 'undo_turn' || trimmed === 'undoTurn') return SANDBOX_TOOLS.UNDO_TURN || 'undo_turn';
  if (snake === 'invoke_agent' || trimmed === 'invokeAgent') return SANDBOX_TOOLS.INVOKE_AGENT || 'invoke_agent';
  if (snake === 'wait_for_invocation' || trimmed === 'waitForInvocation') return SANDBOX_TOOLS.WAIT_FOR_INVOCATION || 'wait_for_invocation';
  if (snake === 'schedule') return SANDBOX_TOOLS.SCHEDULE || 'schedule';
  if (snake === 'list_schedules' || trimmed === 'listSchedules') return SANDBOX_TOOLS.LIST_SCHEDULES || 'list_schedules';
  if (snake === 'cancel_schedule' || trimmed === 'cancelSchedule') return SANDBOX_TOOLS.CANCEL_SCHEDULE || 'cancel_schedule';
  if (snake === 'world_clock' || trimmed === 'worldClock') return SANDBOX_TOOLS.WORLD_CLOCK || 'world_clock';
  if (snake === 'event_list' || trimmed === 'eventList' || snake === 'list_events') return SANDBOX_TOOLS.EVENT_LIST || 'event_list';
  // R4: 'time_now' is intentionally NOT mapped. It is absent from the canonical
  // master alias map, so the descriptor gate denies it (PRECALL_FORBIDDEN);
  // resolving it here would let the engine-local gate allow a phantom name.
  if (snake === 'get_current_time' || trimmed === 'getCurrentTime') return SANDBOX_TOOLS.GET_CURRENT_TIME || 'get_current_time';
  if (snake === 'describe_tool' || trimmed === 'describeTool') return SANDBOX_TOOLS.DESCRIBE_TOOL || 'describe_tool';
  
  return snake || trimmed;
}

/**
 * Deterministic JSON serialization for precall argument comparison.
 * Private internal helper.
 * @param obj - Value to serialize deterministically.
 * @returns Stable JSON string.
 */
function stableSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableSerialize).join(',') + ']';
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableSerialize(record[k])).join(',') + '}';
}

/**
 * Deduplicate precalls by normalized tool name and equivalent arguments (PRC-5).
 * Private internal helper.
 * @param calls - Raw staged precall records.
 * @returns Deduplicated precall records with parsed arguments.
 */
function deduplicatePrecalls(calls: unknown): DeduplicatedPrecall[] {
  if (!Array.isArray(calls)) return [];
  const seen = new Set<string>();
  const result: DeduplicatedPrecall[] = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object' || !readProperty(call, 'name')) continue;
    const rawName = String(readProperty(call, 'name')).trim();
    const canonName = normalizeToolName(rawName) || rawName;
    let argsObj = readProperty(call, 'arguments') || {};
    if (typeof argsObj === 'string') {
      try { argsObj = JSON.parse(argsObj); } catch { argsObj = {}; }
    }
    const normalizedArgsKey = stableSerialize(argsObj);
    const key = `${canonName}::${normalizedArgsKey}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({
        ...call,
        name: rawName,
        arguments: argsObj
      });
    }
  }
  return result;
}

/**
 * Creates an `Error` carrying a turn execution error code.
 * Private internal helper.
 * @param message - Human-readable error message (kept verbatim at every throw site).
 * @param code - Canonical `EXECUTION_ERROR_CODES` member.
 * @returns Error instance with the code attached.
 */
function createCodedError(message: string, code: ExecutionErrorCode): Error & { code?: ExecutionErrorCode } {
  const err: Error & { code?: ExecutionErrorCode } = new Error(message);
  err.code = code;
  return err;
}

// ============================================================================
// 2. Input & Context Structures
// ============================================================================

/**
 * Structured input envelope for turn execution.
 *
 * Encapsulates message content, role classification, orchestrator action mode,
 * sender identification, and arbitrary contextual metadata.
 *
 * Interface `TurnInputObject`.
 * - `content` (`string`) - Primary message textual payload or prompt.
 * - `role` (`'user' | 'system' | 'assistant'`) - Ingestion role in conversation history.
 * - `mode` (`OrchestratorActionMode`) - Orchestrator action mode ('directive', 'system', 'injection').
 * - `metadata` (`Record<string, unknown>`) - Arbitrary contextual metadata attached to the message.
 * - `sender` (`string`) - Sender agent ID or authority name (e.g. `'user'`, `'director'`).
 * - `from` (`string`) - Legacy alias for `sender`.
 *
 * @example
 * ```typescript
 * const inputEnvelope: TurnInputObject = {
 *   role: 'user',
 *   content: 'Analyze the latest telemetry logs.',
 *   mode: 'directive',
 *   sender: 'director',
 *   metadata: { priority: 'high', correlationId: 'job_482' }
 * };
 * ```
 */
export interface TurnInputObject {
  /** Primary text payload; `system` and `injection` modes stringify the whole envelope when this is absent, while directive mode ingests the envelope only when `role` or `content` is set. */
  readonly content?: string;
  /** History role for the ingested message; `'system'` also selects system mode when no explicit `mode`/`category` is supplied. */
  readonly role?: 'user' | 'system' | 'assistant';
  /** Explicit orchestrator action mode; takes precedence over the mode inferred from `role`. */
  readonly mode?: OrchestratorActionMode;
  /** Metadata stored on the ingested history message; keys here override same-named keys from `TurnExecutionOptions.metadata`. */
  readonly metadata?: Record<string, unknown>;
  /** Sender identity used in `injection` mode; ignored by other modes. */
  readonly sender?: string;
  /** Legacy alias for `sender`; takes precedence when both are supplied in `injection` mode. */
  readonly from?: string;
  /** Permits caller-defined extra fields of any type; directive mode preserves them on the stored history message when `role` is set. Values are untyped and must be narrowed on read. */
  readonly [key: string]: unknown;
}

/**
 * Valid turn input types accepted by `TurnExecutionEngine.executeAgentTurn`.
 *
 * Accepts a raw string prompt, a structured `TurnInputObject`, an array of
 * messages/prompts, or `null`/`undefined` for autonomous mail wake triggers.
 *
 * Invariant 3: When `autoTrigger` is true and input is null/empty or `triggerType === 'mail'`,
 * the engine checks the mailbox unread count and skips execution if it is 0.
 *
 * @example
 * ```typescript
 * // String prompt
 * await engine.executeAgentTurn('agent_1', 'Hello agent');
 *
 * // Structured input object
 * await engine.executeAgentTurn('agent_1', {
 *   content: 'System override',
 *   mode: 'system'
 * });
 *
 * // Null input for autonomous mailbox drain
 * await engine.executeAgentTurn('agent_1', null, {
 *   triggerType: 'mail',
 *   autoTrigger: true
 * });
 * ```
 */
export type TurnInput =
  | string
  | TurnInputObject
  | Array<TurnInputObject | string>
  | null
  | undefined;

/**
 * Options configuring a single agent turn execution.
 *
 * Governs cooperative cancellation signals, orchestrator action modes,
 * streaming token callbacks, per-turn model overrides, and autonomous trigger behavior.
 *
 * Interface `TurnExecutionOptions`.
 * - `signal` (`AbortSignal | null`) - Cooperative cancellation signal. Halts LLM inference and tool loops cleanly.
 * - `mode` (`OrchestratorActionMode`) - Action mode ('directive', 'system', 'injection'). Overrides category if both are specified.
 * - `category` (`string`) - Legacy action mode shorthand (e.g. `'directive'`, `'system'`, `'injection'`).
 * - `triggerType` (`'mail' | 'invocation' | 'schedule' | 'user' | string`) - Event category that triggered this turn.
 * - `autoTrigger` (`boolean`) - If true and input is empty or triggerType is 'mail', skips turn if inbox has 0 unread messages.
 * - `model` (`EngineModel`) - Per-turn LLM model instance override.
 * - `sender` (`string`) - Sender identity used when mode is 'injection'. Default: `'user'`, the operator
 *   label: the engine binds the trusted operator subject (`director`) as the delivery scope identity so
 *   Realm-bound targets receive operator mail. Any other sender is agent-scoped and Realm-enforced.
 * - `metadata` (`Record<string, unknown>`) - Arbitrary metadata attached to the ingested history message.
 * - `priority` (`string | number`) - Priority level for injected messages.
 * - `depth` (`number`) - Recursive invocation depth counter for recursion guard. Default: 0.
 * - `onChunk` (`(chunk: EngineStreamChunk) => void`) - Receives each raw provider chunk as it arrives: a plain string token
 *   or an object with `type: 'text' | 'reasoning' | 'tool_call' | 'usage' | 'finish'` (`content` carries text
 *   deltas and `reasoning` carries reasoning deltas, `toolCalls` tool calls, `usage` token counts). This is not
 *   the engine's emitted `stream` event and never carries `delta`.
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 *
 * const options: TurnExecutionOptions = {
 *   signal: controller.signal,
 *   mode: 'directive',
 *   triggerType: 'user',
 *   autoTrigger: false,
 *   onChunk: (chunk) => {
 *     if (typeof chunk === 'string') {
 *       process.stdout.write(chunk);
 *     } else if (chunk?.type === 'text') {
 *       process.stdout.write(chunk.content || '');
 *     }
 *   }
 * };
 * ```
 */
export interface TurnExecutionOptions {
  /**
   * Cooperative cancellation signal.
   * If aborted before or during turn execution, halts generation and returns status CANCELLED.
   */
  readonly signal?: AbortSignal | null;

  /**
   * Orchestrator action mode: 'directive', 'system', or 'injection'.
   * Overrides category if both are provided.
   */
  readonly mode?: OrchestratorActionMode;

  /**
   * Legacy action mode shorthand (e.g., 'system', 'injection', 'directive').
   */
  readonly category?: string;

  /**
   * Category of event that triggered this turn ('mail' | 'invocation' | 'schedule' | 'user').
   */
  readonly triggerType?: 'mail' | 'invocation' | 'schedule' | 'user' | string;

  /**
   * If true and input is empty or triggerType is 'mail', skips turn if inbox has 0 unread messages.
   */
  readonly autoTrigger?: boolean;

  /**
   * Per-turn model instance override.
   */
  readonly model?: EngineModel | null;

  /**
   * Sender identity used when mode is 'injection'. Default: 'user', the
   * operator label. A `'user'` injection is operator-attributed (the trusted
   * `director` subject backs Realm scope resolution, ticket 99faaf1); every
   * other sender keeps the legacy agent-scoped, Realm-enforced path.
   */
  readonly sender?: string;

  /**
   * Arbitrary metadata attached to the ingested history message.
   */
  readonly metadata?: Record<string, unknown>;

  /**
   * Priority level for injected messages.
   */
  readonly priority?: string | number;

  /**
   * Recursive invocation depth counter for recursion guard. Default: 0.
   */
  readonly depth?: number;

  /**
   * Real-time chunk listener for streaming token delivery: each raw provider chunk
   * (`content` carries text deltas, `reasoning` carries reasoning deltas).
   */
  readonly onChunk?: (chunk: EngineStreamChunk) => void;

  /** Permits additional caller-defined keys; the engine does not interpret unlisted keys. */
  readonly [key: string]: unknown;
}

// ============================================================================
// 3. Execution Results & Tool Records
// ============================================================================

/**
 * Normalized tool call emitted by LLM during multi-turn generation.
 *
 * Conforms to OpenAI tool call schema specifications.
 *
 * Interface `ToolCallRecord`.
 * - `id` (`string`) - Unique tool call identifier (e.g. `'call_abc123'`).
 * - `type` (`'function'`) - Tool call type, always `'function'`.
 * - `name` (`string`) - Function/tool name to execute; omitted on engine-synthesized mail/precall calls.
 * - `args` (`Record<string, unknown>`) - Parsed JavaScript argument dictionary; omitted on engine-synthesized mail/precall calls.
 * - `function` (`{ name: string; arguments: string }`) - OpenAI-compatible function descriptor with raw JSON arguments string.
 *
 * @example
 * ```typescript
 * const toolCall: ToolCallRecord = {
 *   id: 'call_123',
 *   type: 'function',
 *   name: 'fs_readFile',
 *   args: { path: '/workspace/data.json' },
 *   function: {
 *     name: 'fs_readFile',
 *     arguments: '{"path":"/workspace/data.json"}'
 *   }
 * };
 * ```
 */
export interface ToolCallRecord {
  /** Unique tool call identifier; generated via `generateMessageId('call')` when the model omits one. */
  readonly id: string;
  /** Tool call discriminator; always the literal `'function'`. */
  readonly type: 'function';
  /** Function name to execute, resolved from `name` or `function.name`; `''` when the model supplies neither. Omitted on engine-synthesized mail/precall calls. */
  readonly name?: string;
  /** Parsed argument dictionary; string arguments that fail JSON parsing are preserved as `{ raw: <string> }`, and absent arguments default to `{}`. Omitted on engine-synthesized mail/precall calls. */
  readonly args?: Record<string, unknown>;
  /** OpenAI-compatible descriptor; `name` mirrors the call name and `arguments` stays a raw JSON string (default `'{}'`). */
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/**
 * Tool execution response record appended to agent conversation history.
 *
 * Invariant: Must follow an assistant message containing the matching `tool_call_id`.
 *
 * Interface `ToolResponseRecord`.
 * - `id` (`string`) - Unique history message identifier.
 * - `role` (`'tool'`) - Message role, strictly `'tool'`.
 * - `tool_call_id` (`string`) - Corresponding tool call ID this response satisfies.
 * - `name` (`string`) - Tool name that produced this response.
 * - `content` (`string`) - Serialized output string or JSON payload.
 * - `isError` (`boolean`) - Optional boolean indicating whether execution resulted in an error.
 *
 * @example
 * ```typescript
 * const response: ToolResponseRecord = {
 *   id: 'msg_tool_456',
 *   role: 'tool',
 *   tool_call_id: 'call_123',
 *   name: 'fs_readFile',
 *   content: '{"success": true, "data": "file contents"}',
 *   isError: false
 * };
 * ```
 */
export interface ToolResponseRecord {
  /** History message identifier: the dispatcher-provided `id` when present, otherwise generated via `generateMessageId('tool')`. */
  readonly id: string;
  /** Message role; always the literal `'tool'`. */
  readonly role: 'tool';
  /** Identifier of the assistant tool call this response satisfies; `''` when the originating call carried no id. */
  readonly tool_call_id: string;
  /** Name of the tool that produced this response. */
  readonly name: string;
  /** Serialized tool output: string results pass through untouched, any other value is `JSON.stringify`-ed. */
  readonly content: string;
  /** Failure marker: `true` on engine-synthesized error receipts (forbidden precall, thrown execution) and dispatcher-reported failures; omitted on success. */
  readonly isError?: boolean;
}

/**
 * Public projection of the live agent instance carried on a settled turn receipt.
 *
 * `TurnExecutionResult.agent` references the live agent that executed the turn;
 * this interface declares the members consumers may read from it. Only the
 * identity surface is public: the engine's fuller structural view (`EngineAgent`)
 * stays private to this module and must not leak into consumer contracts.
 *
 * Interface `TurnExecutionAgent`.
 * - `id` (`string`) - Unique agent identifier (e.g. `'director'`, `'agent-scout'`).
 * - `role` (`string`) - Agent role label, mirrored from the live agent's
 *   owner-controlled `config.role` projection. Optional because structural
 *   callers typed against the engine's private view do not declare it.
 *
 * @example
 * ```typescript
 * const receipt = await engine.executeAgentTurn('researcher', 'Summarize notes');
 * console.log(`Turn ran on agent ${receipt.agent.id} (role: ${receipt.agent.role ?? 'unset'})`);
 * ```
 */
export interface TurnExecutionAgent {
  /** Unique agent identifier (e.g. `'director'`, `'agent-scout'`). */
  readonly id: string;
  /**
   * Agent role label mirrored from the live agent's `config.role` (owner-controlled
   * authority projection). Absent on callers that pass a structural agent whose
   * declared shape does not include it.
   */
  readonly role?: string;
}

/**
 * Standardized result receipt returned upon turn settlement.
 *
 * Receipt semantics: a settled turn exposes its outcome, final text output,
 * accumulated tool calls, terminal summary, and error taxonomy codes.
 *
 * Interface `TurnExecutionResult`.
 * - `agent` (`TurnExecutionAgent`) - Reference to the live agent instance that executed the turn.
 * - `status` (`ExecutionStatus`) - Canonical lifecycle outcome of this turn.
 * - `output` (`string`) - Final textual output produced by the turn (prose or terminal summary).
 * - `toolCalls` (`ReadonlyArray<ToolCallRecord>`) - All tool calls the engine dispatched or parsed this turn across all iterations, including engine-synthesized mail/precall calls; on cancellation this may include calls that were never dispatched.
 * - `summary` (`string | null`) - Closing summary recorded by the agent's most recent successful terminal batch, or `null`.
 * - `metadata` (`Record<string, unknown>`) - Metadata associated with turn completion and telemetry metrics.
 * - `cancelled` (`boolean`) - Ergonomic boolean flag: `true` if `status === 'cancelled'`.
 * - `skipped` (`boolean`) - Ergonomic boolean flag: `true` if `status === 'skipped'`.
 * - `error` (`string`) - Failure message on a failure receipt; `executeAgentTurn` throws unhandled failures instead of resolving with one.
 * - `code` (`ExecutionErrorCode`) - Programmatic code on a non-completed receipt (e.g. `TURN_ABORTED` on cancellation).
 *
 * @example
 * ```typescript
 * const receipt = await engine.executeAgentTurn('researcher', 'Summarize notes');
 *
 * if (receipt.status === 'completed') {
 *   console.log('Turn output:', receipt.output);
 *   if (receipt.summary) {
 *     console.log('Terminal summary:', receipt.summary);
 *   }
 * } else if (receipt.skipped) {
 *   console.log('Turn skipped: inbox empty');
 * } else if (receipt.cancelled) {
 *   console.warn('Turn was cancelled');
 * }
 * ```
 */
export interface TurnExecutionResult {
  /**
   * Reference to the live agent that executed the turn, projected onto the
   * public {@link TurnExecutionAgent} surface.
   */
  readonly agent: TurnExecutionAgent;

  /**
   * Canonical lifecycle outcome of this turn.
   */
  readonly status: ExecutionStatus;

  /**
   * Final textual output produced by the turn (prose or terminal summary).
   */
  readonly output: string;

  /**
   * All tool calls the engine dispatched or parsed this turn across all iterations,
   * including engine-synthesized mail/precall calls;
   * on cancellation this may include calls that were never dispatched.
   */
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;

  /**
   * Closing summary recorded by the agent's most recent successful terminal batch
   * (`runtime_batchPrecall`), or `null` when no terminal batch has succeeded yet.
   */
  readonly summary?: string | null;

  /**
   * Metadata associated with the turn completion.
   */
  readonly metadata?: Record<string, unknown>;

  /**
   * Ergonomic boolean flag: true if status === 'cancelled'.
   */
  readonly cancelled?: boolean;

  /**
   * Ergonomic boolean flag: true if status === 'skipped'.
   */
  readonly skipped?: boolean;

  /**
   * Failure message on a failure receipt. `executeAgentTurn` throws unhandled failures
   * instead of resolving a receipt for them, so this field is not populated by that method.
   */
  readonly error?: string;

  /**
   * Programmatic code accompanying a non-completed receipt; `TURN_ABORTED` is set on
   * cancelled receipts. Unhandled failures throw with the original error's code.
   */
  readonly code?: ExecutionErrorCode;
}

// ============================================================================
// 4. Engine Configuration & Class Interface
// ============================================================================

/**
 * Dependencies injected into `TurnExecutionEngine` constructor.
 *
 * Interface `TurnExecutionEngineOptions`.
 * - `runtime` (`EngineRuntimePort`) - Reference to parent `AgentRuntime` coordinator.
 * - `emit` (`SubsystemEmitPort`) - Injected canonical emit port; falls back to `runtime.createSubsystemEmitPort()`.
 * - `virtualFs` (`unknown`) - Shared `VirtualFS` instance for tool file operations.
 * - `messagingBus` (`EngineMessagingBus`) - Shared `MessagingBus` instance for mailbox intake and inter-agent communication.
 * - `worldClock` (`unknown`) - Shared `WorldClock` instance for simulated time and alarms.
 * - `triggerQueue` (`EngineTriggerQueue`) - Centralized non-blocking `TriggerQueue` for post-turn tick notifications.
 * - `customTools` (`Record<string, unknown> | null`) - Optional registry of runtime-level custom tools.
 * - `mailboxAutonomy` (`boolean | null`) - Global mailbox autonomy flag controlling identity header injection.
 * - `telemetryTracker` (`EngineTelemetryPort`) - `RuntimeTelemetryTracker` instance for recording turn token usage and metrics.
 * - `historyManager` (`HistoryManager`) - `HistoryManager` instance for history hygiene and message ID generation.
 *
 * @example
 * ```typescript
 * import { TurnExecutionEngine } from './turnExecutionEngine/index.ts';
 * import { MessagingBus } from '../messagingBus/index.ts';
 * import { VirtualFS } from '../virtualFs/index.ts';
 * import { TriggerQueue } from '../triggerQueue/index.ts';
 *
 * const engine = new TurnExecutionEngine({
 *   runtime: mockRuntime,
 *   emit: mockRuntime.createSubsystemEmitPort(),
 *   virtualFs: new VirtualFS(),
 *   messagingBus: new MessagingBus(),
 *   triggerQueue: new TriggerQueue()
 * });
 * ```
 */
export interface TurnExecutionEngineOptions {
  /**
   * Reference to parent AgentRuntime coordinator.
   */
  runtime?: EngineRuntimePort | null;

  /**
   * Injected canonical `SubsystemEmitPort` (declared by the runtime module)
   * for subsystem event broadcasting. Falls back to
   * `runtime.createSubsystemEmitPort()` when omitted or malformed.
   */
  emit?: SubsystemEmitPort | null;

  /**
   * Shared VirtualFS instance for tool file operations.
   */
  virtualFs?: unknown;

  /**
   * Shared MessagingBus instance for mail intake and inter-agent communication.
   */
  messagingBus?: EngineMessagingBus | null;

  /**
   * Shared WorldClock instance for simulated time and alarms.
   */
  worldClock?: unknown;

  /**
   * Centralized non-blocking TriggerQueue for post-turn tick notifications.
   */
  triggerQueue?: EngineTriggerQueue | null;

  /**
   * Optional registry of runtime-level, host-registered custom tools.
   *
   * Host-only contract (A0-5, ticket 0443865): custom tools are
   * operator/host-registered, never model-registered — provider function/JSON
   * input cannot add entries (the spawn sanitizer renames agent-supplied
   * `custom_tools` to an inert alias the composition ignores), and Realms never
   * register custom tools (the registry is operator-global). Handlers receive
   * raw substrate handles and execute before the dispatcher gate, so each
   * invocation is authorized against the caller's frozen `AuthorityDescriptor`:
   * the wildcard `'*'` or `'@lifecycle:authority'` sentinel (or an
   * engine-internal principal) is required, a matching `allowedTools` entry is
   * not sufficient, and anonymous callers are denied. Denied handlers fall
   * through to the normal dispatcher gate.
   */
  customTools?: Record<string, unknown> | null;

  /**
   * Optional Wave U host publishing port (ticket 2518510) seeded into every
   * tool dispatcher context. The store composition root implements it over the
   * real Wave T template registry and the session candidate surface; when
   * absent the publishing meta tools fail closed.
   */
  realmPublishingPort?: RealmPublishingPort | null;

  /**
   * Global mailbox autonomy flag controlling identity header injection.
   */
  mailboxAutonomy?: boolean | null;

  /**
   * Telemetry tracker instance for recording turn token usage and metrics.
   */
  telemetryTracker?: EngineTelemetryPort | null;

  /**
   * History manager instance retained from injection. The engine currently performs history
   * hygiene through `formatMessagesWithToolHygiene` and message-ID generation through the
   * imported `generateMessageId`, so this instance is stored but not read.
   */
  historyManager?: HistoryManager | null;
}

/**
 * `TurnExecutionEngine`
 *
 * Layer 2 Runtime Execution Engine & Multi-Turn Tool Loop Subsystem.
 * Orchestrates conversational turn execution, multi-turn LLM inference loops,
 * streaming token dispatch, next-turn precall pipelines, concurrency serialization,
 * and cooperative cancellation.
 *
 * ### Architectural Invariants:
 * 1. **Single-Turn Concurrency Serialization & Non-Reentrancy (Invariant 1):**
 *    Guarantees at most one active execution turn per agent. Invocations for an occupied agent
 *    chain onto `agent.currentTurnPromise`.
 * 2. **Orchestrator Action Modes (Invariant 2):**
 *    Supports `directive` (standard prompt + mail wake), `system` (operational constraint),
 *    and `injection` (mailbox delivery + mail wake).
 * 3. **Autonomous Mail Wake & Auto-Trigger Skip Guard (Invariant 3):**
 *    When auto-triggered with 0 unread messages, skips model inference and returns `{ status: 'skipped', skipped: true }`.
 *    When messages exist, drains inbox atomically and synthesizes tool call/response pairs.
 * 4. **Next-Turn Precall Pipeline (Invariant 4):**
 *    Deduplicates pending precalls (capped at 10), validates against `PRECALL_ALLOWLIST`,
 *    executes before LLM inference, and coalesces into a single synthetic assistant message.
 * 5. **Multi-Turn Tool Loop & Terminal Summary Abstraction (Invariant 5):**
 *    Executes tools up to `maxTurns`. On `runtime_batchPrecall`, unwrapped self-validation failures
 *    (`{ success: false }`) continue the loop for self-healing. Wrapped execution failures
 *    (`{ name, result: { success: false } }`) do not block close: the batch extracts its summary,
 *    queues next precalls, and breaks immediately with the failures visible in history, pending precalls, and telemetry.
 *    If `maxTurns` is exhausted while tool calls are still pending, the turn throws an `Error` coded `MAX_TURNS_EXCEEDED`.
 * 6. **Deterministic Stream Cleanup & Fault Isolation (Invariant 6):**
 *    Resets `currentStream`, `currentReasoning`, and `activeToolCalls` in `finally` blocks,
 *    cleans up abort listeners, and transitions agent state cleanly.
 * 7. **String Primitive Reasoning Content Invariant (Invariant 7 / INV-REASONING-STRING):**
 *    Enforces `typeof msg.reasoning_content === 'string'` (default `""`) on all assistant messages.
 * 8. **Post-Turn Reactive Kick:**
 *    Notifies `triggerQueue.processTick()` in the `finally` block of every turn settlement.
 *
 * Class `TurnExecutionEngine`.
 *
 * @example
 * ```typescript
 * import { TurnExecutionEngine, EXECUTION_STATUS } from './turnExecutionEngine/index.ts';
 *
 * const engine = new TurnExecutionEngine({
 *   runtime,
 *   messagingBus,
 *   virtualFs,
 *   triggerQueue
 * });
 *
 * // Execute standard turn
 * const result = await engine.executeAgentTurn('agent_1', 'Process data', {
 *   onChunk: (chunk) => console.log('Chunk:', chunk)
 * });
 *
 * if (result.status === EXECUTION_STATUS.COMPLETED) {
 *   console.log('Turn completed:', result.output);
 * }
 * ```
 */
export class TurnExecutionEngine {
  #runtime: EngineRuntimePort | null = null;
  #virtualFs: unknown = null;
  #messagingBus: EngineMessagingBus | null = null;
  #worldClock: unknown = null;
  #triggerQueue: EngineTriggerQueue | null = null;
  #customTools: Record<string, unknown> | null = null;
  #realmPublishingPort: RealmPublishingPort | null = null;
  #mailboxAutonomy: boolean | null = null;
  #telemetryTracker: EngineTelemetryPort | null = null;

  /** Whether telemetry keys canonically (injected tracker) or by entity (standalone tracker). */
  #telemetryCanonicalKeys = false;
  #emitPort: SubsystemEmitPort | null = null;
  #lifecyclePort: LifecyclePort | null = null;
  #identityPort: AgentIdentityPort | null = null;

  /**
   * Initializes a new `TurnExecutionEngine` instance with injected runtime dependencies.
   *
   * @param options - Dependency injection configuration.
   *
   * @example
   * ```typescript
   * const engine = new TurnExecutionEngine({
   *   runtime: agentRuntime,
   *   virtualFs: vfs,
   *   messagingBus: bus,
   *   triggerQueue: queue
   * });
   * ```
   */
  constructor({
    runtime = null,
    emit = null,
    virtualFs = null,
    messagingBus = null,
    worldClock = null,
    triggerQueue = null,
    customTools = null,
    realmPublishingPort = null,
    mailboxAutonomy = null,
    telemetryTracker = null
  }: TurnExecutionEngineOptions = {}) {
    this.#runtime = runtime;
    this.#virtualFs = virtualFs;
    this.#messagingBus = messagingBus;
    this.#worldClock = worldClock;
    this.#triggerQueue = triggerQueue;
    this.#customTools = customTools;
    this.#realmPublishingPort = realmPublishingPort || null;
    this.#mailboxAutonomy = mailboxAutonomy !== null && mailboxAutonomy !== undefined ? Boolean(mailboxAutonomy) : null;
    this.#emitPort = (emit && typeof emit.emit === 'function')
      ? emit
      : (runtime && typeof runtime.createSubsystemEmitPort === 'function' ? runtime.createSubsystemEmitPort() : null);
    this.#telemetryTracker = telemetryTracker || (runtime
      ? new RuntimeTelemetryTracker({
          emit: typeof runtime.createSubsystemEmitPort === 'function' ? runtime.createSubsystemEmitPort() : null
        })
      : null);
    // Telemetry keying mode (Wave I, ticket d57cbc1): the composition root
    // injects its accessor-backed tracker, which keys per `(realmId, agentId)`;
    // a self-created standalone tracker has no accessor and keeps the legacy
    // entity-keyed/entity-mirrored behavior so structural (realm-less) agents
    // still receive their telemetry snapshot.
    this.#telemetryCanonicalKeys = Boolean(telemetryTracker);
    this.#lifecyclePort = (runtime && typeof runtime.createLifecyclePort === 'function')
      ? runtime.createLifecyclePort()
      : null;
    this.#identityPort = (runtime && typeof runtime.createAgentIdentityPort === 'function')
      ? runtime.createAgentIdentityPort()
      : null;
  }

  /**
   * Helper to emit runtime events through the injected SubsystemEmitPort.
   * Every event carries the port-required epoch-millisecond `timestamp`.
   * @param event - Event payload to emit.
   */
  #emit(event: EngineEmitEvent) {
    if (this.#emitPort) {
      try {
        this.#emitPort.emit({
          ...event,
          timestamp: typeof event?.timestamp === 'number' ? event.timestamp : Date.now()
        });
      } catch (err) {
        console.error('Error in TurnExecutionEngine event emission:', err);
      }
    }
  }

  /**
   * Helper to transition agent state via runtime or directly.
   * @param agent - Agent domain instance.
   * @param newState - Target lifecycle state (an `AGENT_STATES` member).
   * @param stateDetail - Optional human-readable transition detail.
   */
  #setAgentState(agent: EngineAgent, newState: AgentState, stateDetail: string | null = null) {
    if (this.#runtime && typeof this.#runtime.setAgentState === 'function') {
      this.#runtime.setAgentState(agent, newState, stateDetail);
    } else {
      agent.state = newState;
      if (stateDetail !== undefined) {
        agent.stateDetail = stateDetail;
      }
      agent.updatedAt = Date.now();
    }
  }

  /**
   * Resolves the telemetry key target for a turn's agent: the canonical
   * `(realmId, agentId)` key for the composition-root tracker, or the entity
   * itself for a self-created standalone tracker (legacy entity mirroring).
   *
   * @param agent - Turn's agent.
   * @returns The telemetry target accepted by the tracker.
   * @internal
   */
  #telemetryTarget(agent: EngineAgent): string | EngineAgent | { id: string; telemetryLabel: string } {
    return this.#telemetryCanonicalKeys
      ? { id: telemetryIdentityKey(agent), telemetryLabel: agent.id }
      : agent;
  }

  /**
   * Resolves a turn agent's frozen identity projection realm-exactly (Wave I,
   * ticket d57cbc1): the agent's owner-controlled `config.realmId` scopes the
   * lookup, so the same literal id registered in another Realm never resolves.
   * Returns `null` without an injected identity port or on an unresolved
   * registration.
   *
   * @param agent - Turn's agent.
   * @returns The identity projection, or `null`.
   * @internal
   */
  #resolveAgentIdentity(agent: EngineAgent): EngineIdentityProjection | null {
    const rawRealmId = agent?.config?.realmId;
    const scope = typeof rawRealmId === 'string' && rawRealmId ? { realmId: rawRealmId } : undefined;
    const identity = this.#identityPort && typeof this.#identityPort.getAgentIdentity === 'function'
      ? this.#identityPort.getAgentIdentity(agent.id, scope)
      : null;
    return identity && typeof identity === 'object' ? identity as EngineIdentityProjection : null;
  }

  /**
   * Resolves the canonical registration key a turn's bus operations address
   * (Wave I, ticket d57cbc1): the identity projection's `key` when resolvable,
   * else the locally composed `(realmId, agentId)` key — the same value the
   * lifecycle registered the mailbox and subscription under.
   *
   * @param agent - Turn's agent.
   * @returns The canonical `(realmId, agentId)` registration key.
   * @internal
   */
  #busIdentityKey(agent: EngineAgent): string {
    const identity = this.#resolveAgentIdentity(agent);
    if (identity && typeof identity.key === 'string' && identity.key) return identity.key;
    return telemetryIdentityKey(agent);
  }

  /**
   * Resolves whether a caller may execute host-registered custom tool handlers
   * during its turn (A0-5, ticket 0443865).
   *
   * Trust boundary: custom handlers receive raw substrate handles and run
   * before the dispatcher's capability gate, so this engine authorizes them
   * directly against the frozen `AuthorityDescriptor` on the identity
   * projection — deliberately decoupled from the dispatcher's union
   * `isAuthorized` behavior:
   * - an active caller whose descriptor `allow` holds the wildcard `'*'` or the
   *   `'@lifecycle:authority'` sentinel may execute custom handlers;
   * - an engine-internal principal projection (`authority.kind === 'internal'`)
   *   is host-trusted and may execute them;
   * - an allowlist entry that merely matches the handler name never grants
   *   custom execution;
   * - anonymous callers (no identity port, no projection, or no authority
   *   descriptor) are denied;
   * - any throw from the descriptor read or capability probe (`authority` /
   *   `allow` / `allow.has` accessor reads or `allow.has(...)` calls) is a deny
   *   (fail closed): the handler never executes and the turn never aborts.
   *
   * @param agent - Turn's agent whose frozen descriptor authorizes custom-handler execution.
   * @returns `true` only when the caller's frozen descriptor grants custom-handler execution.
   */
  #isCustomToolCallerAuthorized(agent: EngineAgent): boolean {
    // Realm-exact when the agent carries membership (Wave I, ticket d57cbc1):
    // the same literal id in another Realm is a different registration, and
    // an id-only lookup would fail closed on the ambiguity. Realm-less
    // structural agents keep the legacy unique-match path.
    const identity = this.#resolveAgentIdentity(agent);
    if (!identity || typeof identity !== 'object') return false;

    try {
      const authority = readProperty(identity, 'authority');
      if (!authority || typeof authority !== 'object') return false;
      if (readProperty(authority, 'kind') === 'internal') return true;

      const allow = readProperty(authority, 'allow') as { has?: (name: string) => unknown } | null;
      if (!allow || typeof allow.has !== 'function') return false;
      return Boolean(allow.has('*') || allow.has(LIFECYCLE_AUTHORITY_CAPABILITY));
    } catch {
      // Fail closed (ticket 8716523): a throwing descriptor accessor or
      // capability probe denies — the custom handler never executes and the
      // turn never aborts.
      return false;
    }
  }

  /**
   * Resolves the Wave U publishing authorities the agent's frozen
   * `AuthorityDescriptor` explicitly holds (ticket 2518510).
   *
   * Exposure discipline mirrors {@link TurnExecutionEngine#isCustomToolCallerAuthorized}:
   * the descriptor is the sole source, the wildcard `'*'` and `privileged`
   * never satisfy a publishing authority, and any throw from the descriptor
   * read or capability probe denies (empty list). Realm-exact resolution when
   * the agent carries membership; Realm-less structural agents keep the
   * unique-match path.
   *
   * @param agent - Agent whose publishing surface is being prepared.
   * @returns Explicitly held publishing-authority ids (empty when none).
   */
  #publishingAuthoritiesFor(agent: EngineAgent): string[] {
    const identity = this.#resolveAgentIdentity(agent);
    if (!identity || typeof identity !== 'object') return [];
    try {
      const authority = readProperty(identity, 'authority');
      if (!authority || typeof authority !== 'object') return [];
      if (readProperty(authority, 'kind') === 'internal') {
        return [AGENT_AUTHORITIES.TEMPLATE, AGENT_AUTHORITIES.HYDRATION];
      }
      const allow = readProperty(authority, 'allow') as { has?: (name: string) => unknown } | null;
      if (!allow || typeof allow.has !== 'function') return [];
      const held: string[] = [];
      if (allow.has(AGENT_AUTHORITIES.TEMPLATE) === true) held.push(AGENT_AUTHORITIES.TEMPLATE);
      if (allow.has(AGENT_AUTHORITIES.HYDRATION) === true) held.push(AGENT_AUTHORITIES.HYDRATION);
      return held;
    } catch {
      // Fail closed: a throwing descriptor accessor or capability probe hides
      // the publishing surface.
      return [];
    }
  }

  /**
   * Checks whether an agent is currently executing a turn or has a turn chained in concurrency queue.
   *
   * Replaces direct inspection of internal promise references (`agent.currentTurnPromise`).
   *
   * @param agentId - Unique identifier of the agent.
   * @returns `true` if a turn is actively executing or chained, `false` otherwise.
   *
   * @example
   * ```typescript
   * if (engine.isTurnRunning('writer')) {
   *   console.log('Agent is busy executing a turn');
   * } else {
   *   console.log('Agent is idle and ready');
   * }
   * ```
   */
  isTurnRunning(agentId: string): boolean {
    const agent = this.#runtime?.getAgent ? this.#runtime.getAgent(agentId) : null;
    if (!agent) return false;
    return Boolean(agent.currentTurnPromise);
  }

  /**
   * Requests cooperative cancellation of any active in-flight turn for the specified agent.
   *
   * If a turn is executing, transitions the agent to `CANCELING` (from a running or waiting
   * state) and aborts the agent's internal `AbortController`. The in-flight turn observes the
   * abort at its next boundary, settles `cancelled` with `TURN_ABORTED`, records the interrupted
   * state in `agent.lastInterruptedTurn`, clears stream buffers, resets the agent state to
   * `IDLE`, and notifies `TriggerQueue` as part of its own settlement.
   *
   * Invariant: Safe to call even if no turn is running (returns `false`).
   *
   * @param agentId - Unique identifier of the agent to cancel.
   * @param reason - Optional human-readable cancellation rationale, passed to `AbortController.abort` and stored as the `CANCELING` state detail; defaults to `'Turn cancelled'`.
   * @returns `true` if the agent had an in-flight turn promise or abort controller, `false` if the agent is unknown or idle.
   *
   * @example
   * ```typescript
   * // Cancel a running turn
   * const wasCancelled = engine.cancelAgentTurn('researcher', 'User requested abort');
   * if (wasCancelled) {
   *   console.log('Active turn cancelled successfully');
   * }
   * ```
   */
  cancelAgentTurn(agentId: string, reason = 'Turn cancelled'): boolean {
    const agent = this.#runtime?.getAgent ? this.#runtime.getAgent(agentId) : null;
    if (!agent) return false;
    if (!agent.currentTurnPromise && !agent.abortController) {
      return false;
    }
    if (
      agent.state === AGENT_STATES.RUNNING ||
      agent.state === AGENT_STATES.WAITING_FOR_INPUT ||
      agent.state === AGENT_STATES.WAITING_FOR_DEPENDENTS ||
      agent.state === AGENT_STATES.WAITING_FOR_MESSAGE
    ) {
      this.#setAgentState(agent, AGENT_STATES.CANCELING, reason);
    }
    if (agent.abortController) {
      try {
        agent.abortController.abort(reason);
      } catch {
        // Abort is best-effort; cancellation still reports true below.
      }
      return true;
    }
    return Boolean(agent.currentTurnPromise);
  }

  /**
   * Executes a complete conversational turn for the specified agent.
   *
   * Automatically orchestrates:
   * 1. **Concurrency serialization:** Chains onto `agent.currentTurnPromise` if agent is currently busy.
   * 2. **Orchestrator action mode resolution:** Handles `'directive'`, `'system'`, and `'injection'` semantics.
   * 3. **Autonomous mail intake:** Drains unread mailbox messages and skips execution if inbox is empty on `autoTrigger`.
   * 4. **Next-turn precall pipeline:** Deduplicates, allowlist-revalidates, and executes staged precalls before LLM inference.
   * 5. **Multi-turn LLM inference loop:** Streams tokens (`onChunk`), dispatches tool calls, and handles recursion limits (`maxTurns`).
   * 6. **Terminal batch processing:** Intercepts `runtime_batchPrecall`, enforces error guards, applies summary, and queues next precalls.
   * 7. **Deterministic cleanup & reactive kick:** Clears stream buffers, tears down abort listeners, and wakes `TriggerQueue`.
   *
   * @param agentOrId - Agent identifier string or Agent domain instance.
   * @param input - User prompt string, `TurnInputObject`, array of messages, or `null`/`undefined` for mail wake.
   * @param options - Execution options object or legacy action mode string shorthand.
   * @returns Resolves with standardized turn execution receipt.
   *
   * @throws `Error` - Throws with code `INVALID_ARGUMENTS` if agentOrId is missing.
   * @throws `Error` - Throws with code `AGENT_NOT_FOUND` if agent ID does not exist in runtime.
   * @throws `Error` - Throws with code `AGENT_TERMINATED` if agent is terminated or in recycle bin.
   * @throws `Error` - Throws with code `MAX_TURNS_EXCEEDED` when a positive `agent.config.maxTurns` is exhausted while the model is still dispatching tool calls.
   * @throws `Error` - Rethrows any unhandled model, tool, or runtime error unchanged, after emitting an `error` event and moving the agent lifecycle state to `ERRORED` (`AGENT_STATES`).
   *
   * @example
   * ```typescript
   * // 1. Standard prompt execution
   * const receipt = await engine.executeAgentTurn('analyst', 'Analyze Q3 metrics');
   * console.log('Output:', receipt.output);
   *
   * // 2. Streaming execution with cancellation signal
   * const controller = new AbortController();
   * const streamReceipt = await engine.executeAgentTurn('writer', 'Draft report', {
   *   signal: controller.signal,
   *   onChunk: (chunk) => {
   *     if (typeof chunk === 'string') process.stdout.write(chunk);
   *     else if (chunk?.type === 'text') process.stdout.write(chunk.content || '');
   *   }
   * });
   *
   * // 3. Auto-triggered mail wake (skips if inbox empty)
   * const mailReceipt = await engine.executeAgentTurn('assistant', null, {
   *   triggerType: 'mail',
   *   autoTrigger: true
   * });
   * if (mailReceipt.skipped) {
   *   console.log('No unread mail, turn skipped.');
   * }
   * ```
   */
  async executeAgentTurn(agentOrId: string | EngineAgent, input: TurnInput = null, options: TurnExecutionOptions | string = {}): Promise<TurnExecutionResult> {
    // Pre-turn validations live inside the try whose finally owns the
    // TriggerQueue kick, so every terminal outcome (receipt or throw) settles
    // with exactly one post-turn tick (class invariant 8).
    try {
      const agentId = (agentOrId && typeof agentOrId === 'object' && agentOrId.id)
        ? agentOrId.id
        : String(agentOrId || '');

      if (!agentId) {
        throw createCodedError('Invalid agent identifier', EXECUTION_ERROR_CODES.INVALID_ARGUMENTS);
      }

      if (this.#runtime?.hasRecycledAgent?.(agentId)) {
        throw createCodedError(`Cannot execute turn on terminated agent '${agentId}' in recycle bin`, EXECUTION_ERROR_CODES.AGENT_TERMINATED);
      }

      const agent = (agentOrId && typeof agentOrId === 'object' && agentOrId.id)
        ? agentOrId
        : (this.#runtime?.getAgent ? this.#runtime.getAgent(agentId) : null);

      if (!agent) {
        throw createCodedError(`Agent '${agentId}' not found`, EXECUTION_ERROR_CODES.AGENT_NOT_FOUND);
      }

      if (agent.state === AGENT_STATES.TERMINATED || agent.state === AGENT_STATES.RECYCLED) {
        throw createCodedError(`Cannot execute turn on terminated agent '${agentId}'`, EXECUTION_ERROR_CODES.AGENT_TERMINATED);
      }

      const normalizedOptions: TurnExecutionOptions = typeof options === 'string'
        ? { category: options }
        : (options && typeof options === 'object' ? { ...options } : {});

      const signal = normalizedOptions.signal || (typeof options === 'object' && options?.signal ? options.signal : null);
      if (signal?.aborted) {
        return {
          agent,
          status: EXECUTION_STATUS.CANCELLED,
          output: '',
          toolCalls: [],
          cancelled: true,
          code: EXECUTION_ERROR_CODES.TURN_ABORTED
        };
      }

      // Concurrency control: if agent is currently executing a turn, chain onto current promise
      if (agent.currentTurnPromise) {
        return await (agent.currentTurnPromise || Promise.resolve())
          .catch(() => {})
          .then(() => {
            if (this.#runtime?.hasRecycledAgent?.(agentId)) {
              throw createCodedError(`Cannot execute turn on terminated agent '${agentId}' in recycle bin`, EXECUTION_ERROR_CODES.AGENT_TERMINATED);
            }
            const currentAgent = this.#runtime?.getAgent ? this.#runtime.getAgent(agentId) : null;
            if (!currentAgent) {
              throw createCodedError(`Agent '${agentId}' not found`, EXECUTION_ERROR_CODES.AGENT_NOT_FOUND);
            }
            if (currentAgent.state === AGENT_STATES.TERMINATED || currentAgent.state === AGENT_STATES.RECYCLED) {
              throw createCodedError(`Cannot execute turn on terminated agent '${agentId}'`, EXECUTION_ERROR_CODES.AGENT_TERMINATED);
            }
            const deferredSignal = normalizedOptions.signal || (typeof options === 'object' && options?.signal ? options.signal : null);
            if (deferredSignal?.aborted) {
              return {
                agent: currentAgent,
                status: EXECUTION_STATUS.CANCELLED,
                output: '',
                toolCalls: [],
                cancelled: true,
                code: EXECUTION_ERROR_CODES.TURN_ABORTED
              };
            }
            return this.executeAgentTurn(currentAgent, input, options);
          });
      }

      // If auto-triggered with mail or no explicit input, verify there are still unread messages when turn begins
      if (normalizedOptions.autoTrigger && (input === null || input === undefined || input === '' || normalizedOptions.triggerType === 'mail')) {
        // Canonical mailbox partition (Wave I, ticket d57cbc1): the unread
        // probe addresses the exact registration, never an ambiguous bare id.
        const turnAgentKey = this.#busIdentityKey(agent);
        const unread = typeof this.#messagingBus?.getUnreadCount === 'function'
          ? this.#messagingBus.getUnreadCount(turnAgentKey)
          : inboxLength(this.#messagingBus?.listInbox?.(turnAgentKey, { unreadOnly: true }));
        if (unread === 0) {
          return {
            agent,
            status: EXECUTION_STATUS.SKIPPED,
            output: '',
            toolCalls: [],
            skipped: true
          };
        }
      }

      const turnPromise = this.#runTurnCore(agent, input, options);
      agent.currentTurnPromise = turnPromise;

      try {
        return await turnPromise;
      } finally {
        if (agent.currentTurnPromise === turnPromise) {
          agent.currentTurnPromise = null;
        }
      }
    } finally {
      if (this.#triggerQueue && typeof this.#triggerQueue.processTick === 'function') {
        try {
          this.#triggerQueue.processTick().catch(() => {});
        } catch {
          // Tick draining is best-effort in the finally path.
        }
      }
    }
  }

  /**
   * Internal execution turn with multi-turn tool loop and error shielding.
   * @param agent - Agent domain instance executing the turn.
   * @param input - Normalized turn input (string, envelope, array, or null).
   * @param options - Execution options object or legacy action mode string shorthand.
   */
  async #runTurnCore(agent: EngineAgent, input: TurnInput, options: TurnExecutionOptions | string = {}): Promise<TurnExecutionResult> {
    // Normalize options
    const normalizedOptions: TurnExecutionOptions = typeof options === 'string'
      ? { category: options }
      : (options && typeof options === 'object' ? { ...options } : {});

    // Derive orchestrator action mode (INV-ACTION-MODES)
    let mode = 'directive';
    if (normalizedOptions.mode) {
      mode = normalizedOptions.mode;
    } else if (normalizedOptions.category) {
      const cat = String(normalizedOptions.category).toLowerCase().trim();
      if (cat === 'system') {
        mode = 'system';
      } else if (cat === 'injection') {
        mode = 'injection';
      } else {
        mode = 'directive';
      }
    } else if (input && typeof input === 'object' && !Array.isArray(input)) {
      if (input.mode) {
        mode = input.mode;
      } else if (input.role === 'system') {
        mode = 'system';
      }
    }

    // Transition to running state
    this.#setAgentState(agent, AGENT_STATES.RUNNING, 'Starting execution turn');
    agent.abortController = new AbortController();
    agent.lastError = null;
    agent.redoStack = [];

    let turnAborted = false;
    let onInternalAbort: (() => void) | null = null;
    let onExternalAbort: (() => void) | null = null;

    if (agent.abortController?.signal) {
      onInternalAbort = () => {
        turnAborted = true;
      };
      if (typeof agent.abortController.signal.addEventListener === 'function') {
        agent.abortController.signal.addEventListener('abort', onInternalAbort, { once: true });
      }
    }

    const externalSignal = normalizedOptions.signal || (typeof options === 'object' && options?.signal ? options.signal : null);
    if (externalSignal) {
      if (externalSignal.aborted) {
        turnAborted = true;
        agent.abortController?.abort();
      } else if (typeof externalSignal.addEventListener === 'function') {
        onExternalAbort = () => {
          turnAborted = true;
          agent.abortController?.abort();
        };
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    this.#emit({
      type: 'turn_start',
      agentId: agent.id,
      payload: {
        input,
        mode,
        turnCount: agent.turnCount + 1
      }
    });

    const turnToolCalls: ToolCallRecord[] = [];
    let finalOutput = '';

    try {
      // Ensure agent telemetry is initialized with efficiency counters
      if (this.#telemetryTracker) {
        this.#telemetryTracker.initializeTelemetry(this.#telemetryTarget(agent));
      }

      // Canonical registration key of the turn's agent (Wave I, ticket
      // d57cbc1): every bus operation addresses the exact mailbox partition —
      // a bare id shared by two Realms would fail closed instead of reaching
      // the wrong Realm's inbox.
      const agentKey = this.#busIdentityKey(agent);

      // Injected mail tool calls & responses arrays
      const mailToolCalls: EngineSyntheticToolCall[] = [];
      const mailToolResponses: ToolResponseRecord[] = [];

      // 1. Process explicit input according to Orchestrator Action Mode
      if (mode === 'injection' && input !== null && input !== undefined && input !== '') {
        // Injection Mode: Deposits event message into MessagingBus inbox
        let content = '';
        let sender = normalizedOptions.sender || 'user';
        let metadata = { ...(normalizedOptions.metadata || {}) };
        if (normalizedOptions.priority) {
          metadata.priority = normalizedOptions.priority;
        }

        if (typeof input === 'string') {
          content = input;
        } else if (typeof input === 'object' && !Array.isArray(input)) {
          content = input.content !== undefined ? String(input.content) : JSON.stringify(input);
          const explicitSender = input.from || input.sender;
          if (explicitSender) sender = explicitSender;
          if (input.metadata) metadata = { ...metadata, ...input.metadata };
        } else {
          content = String(input);
        }

        if (this.#messagingBus && typeof this.#messagingBus.sendMessage === 'function') {
          if (sender === OPERATOR_SENDER_LABEL) {
            // Operator attribution (ticket 99faaf1; Wave I, ticket c02d0b9):
            // the default 'user' label denotes the human operator. The bus
            // resolves Realm scope from its injected identity port or the exact
            // operator-principal reference, so the engine binds the runtime's
            // opaque principal (obtained through the runtime view) as the
            // trusted execution-context caller while presenting the envelope
            // under the operator label. The binding is built by the engine
            // here — never read from the injection payload and never an agent
            // id; without a resolvable operator principal the send stays
            // ungrouped (fail-closed for realm targets).
            const operatorPrincipal = typeof this.#runtime?.getOperatorPrincipal === 'function'
              ? this.#runtime.getOperatorPrincipal()
              : null;
            this.#messagingBus.sendMessage(
              { from: sender, to: agentKey, content, metadata },
              operatorPrincipal
                ? { callerAgentId: sender, principal: operatorPrincipal }
                : { callerAgentId: sender }
            );
          } else {
            // Agent sender (Wave I, ticket d57cbc1): bind the sender's
            // canonical key from the trusted identity port when it resolves,
            // so a same-literal-id sender resolves realm-exactly; an
            // unresolvable sender keeps the legacy contextless fail-closed
            // path. The envelope presents the bare sender label either way.
            const senderProjection = this.#identityPort && typeof this.#identityPort.getAgentIdentity === 'function'
              ? this.#identityPort.getAgentIdentity(sender)
              : null;
            const senderKey = senderProjection && typeof senderProjection.key === 'string' && senderProjection.key
              ? senderProjection.key
              : null;
            this.#messagingBus.sendMessage(
              { from: sender, to: agentKey, content, metadata },
              senderKey ? { callerAgentId: sender, callerKey: senderKey } : undefined
            );
          }
        }
      }

      const hasUnread = typeof this.#messagingBus?.getUnreadCount === 'function'
        && this.#messagingBus.getUnreadCount(agentKey) > 0;

      const isMailNotificationInput = typeof input === 'string' && input.trim().startsWith('[MAIL NOTIFICATION]');
      const isMailTrigger = normalizedOptions.triggerType === 'mail' ||
        mode === 'injection' ||
        isMailNotificationInput ||
        ((input === null || input === undefined || input === '') && hasUnread);

      if (isMailTrigger) {
        const pendingMessages = toDrainedMessages(
          typeof this.#messagingBus?.drainInbox === 'function'
            ? this.#messagingBus.drainInbox(agentKey)
            : []
        );

        if (pendingMessages.length > 0) {
          const senders = Array.from(new Set(pendingMessages.map(m => readProperty(m, 'from') || 'unknown')));
          const notificationContent = `[MAIL NOTIFICATION] You have ${pendingMessages.length} unread message(s). Senders: [${senders.join(', ')}]`;
          agent.history.push({
            id: generateMessageId('user'),
            role: 'user',
            content: notificationContent,
            metadata: { synthetic: true, wakeNotification: true, timestamp: Date.now() }
          });

          for (const msg of pendingMessages) {
            const rawMsgId = readProperty(msg, 'id') || readProperty(msg, 'messageId') || generateMessageId('msg');
            const sanitizedMsgId = String(rawMsgId).replace(/[^a-zA-Z0-9_-]/g, '_');
            const toolCallId = `call_inject_${sanitizedMsgId}`;
            mailToolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: 'messaging_readMessage',
                arguments: JSON.stringify({ messageId: readProperty(msg, 'id'), id: readProperty(msg, 'id') })
              }
            });

            mailToolResponses.push({
              id: generateMessageId('tool'),
              role: 'tool',
              tool_call_id: toolCallId,
              name: 'messaging_readMessage',
              content: JSON.stringify({
                id: readProperty(msg, 'id'),
                from: readProperty(msg, 'from'),
                to: readProperty(msg, 'to'),
                content: readProperty(msg, 'content'),
                metadata: readProperty(msg, 'metadata') || {},
                timestamp: readProperty(msg, 'timestamp'),
                status: 'read'
              })
            });
          }

          if (this.#telemetryTracker && typeof this.#telemetryTracker.recordInjectedDelivery === 'function') {
            this.#telemetryTracker.recordInjectedDelivery(this.#telemetryTarget(agent), pendingMessages.length);
          } else if (agent.telemetry) {
            agent.telemetry.injectedDeliveries = (agent.telemetry.injectedDeliveries || 0) + pendingMessages.length;
          }
        } else if (isMailNotificationInput) {
          agent.history.push({
            id: generateMessageId('user'),
            role: 'user',
            content: input.trim(),
            metadata: { synthetic: true, wakeNotification: true, timestamp: Date.now() }
          });
        }
      } else if (mode === 'system') {
        // System Mode: Injects system directive into history
        let content = '';
        let metadata = normalizedOptions.metadata || {};
        if (typeof input === 'string') {
          content = input;
        } else if (typeof input === 'object' && !Array.isArray(input)) {
          content = input!.content !== undefined ? String(input!.content) : JSON.stringify(input);
          if (input!.metadata) metadata = { ...metadata, ...input!.metadata };
        } else {
          content = String(input);
        }

        agent.history.push({
          id: generateMessageId('sys'),
          role: 'system',
          content,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {})
        });
      } else {
        // Directive Mode: Standard user prompt
        if (typeof input === 'string') {
          agent.history.push({
            id: generateMessageId('user'),
            role: 'user',
            content: input,
            ...(normalizedOptions.metadata ? { metadata: normalizedOptions.metadata } : {})
          });
        } else if (Array.isArray(input)) {
          for (const item of input) {
            if (item && typeof item === 'object') {
              const normalized = { ...item };
              if (!normalized.id) normalized.id = generateMessageId(normalized.role || 'user');
              if (normalized.role === 'assistant' && typeof normalized.reasoning_content !== 'string') {
                normalized.reasoning_content = '';
              }
              if (item.metadata || normalizedOptions.metadata) {
                normalized.metadata = { ...(normalizedOptions.metadata || {}), ...(item.metadata || {}) };
              }
              agent.history.push(normalized);
            } else if (item !== undefined && item !== null && item !== '') {
              agent.history.push({ id: generateMessageId('user'), role: 'user', content: String(item) });
            }
          }
        } else if (typeof input === 'object' && input !== null) {
          if (input.role) {
            const normalized = { ...input };
            if (!normalized.id) normalized.id = generateMessageId(normalized.role);
            if (normalized.role === 'assistant' && typeof normalized.reasoning_content !== 'string') {
              normalized.reasoning_content = '';
            }
            if (input.metadata || normalizedOptions.metadata) {
              normalized.metadata = { ...(normalizedOptions.metadata || {}), ...(input.metadata || {}) };
            }
            agent.history.push(normalized);
          } else if (input.content !== undefined) {
            agent.history.push({
              id: typeof input.id === 'string' && input.id ? input.id : generateMessageId('user'),
              role: 'user',
              content: String(input.content),
              ...((input.metadata || normalizedOptions.metadata) ? { metadata: { ...(normalizedOptions.metadata || {}), ...(input.metadata || {}) } } : {})
            });
          }
        }

        if (hasUnread) {
          const pendingMessages = toDrainedMessages(
            typeof this.#messagingBus?.drainInbox === 'function'
              ? this.#messagingBus.drainInbox(agentKey)
              : []
          );

          if (pendingMessages.length > 0) {
            for (const msg of pendingMessages) {
              const rawMsgId = readProperty(msg, 'id') || readProperty(msg, 'messageId') || generateMessageId('msg');
              const sanitizedMsgId = String(rawMsgId).replace(/[^a-zA-Z0-9_-]/g, '_');
              const toolCallId = `call_inject_${sanitizedMsgId}`;
              mailToolCalls.push({
                id: toolCallId,
                type: 'function',
                function: {
                  name: 'messaging_readMessage',
                  arguments: JSON.stringify({ messageId: readProperty(msg, 'id'), id: readProperty(msg, 'id') })
                }
              });

              mailToolResponses.push({
                id: generateMessageId('tool'),
                role: 'tool',
                tool_call_id: toolCallId,
                name: 'messaging_readMessage',
                content: JSON.stringify({
                  id: readProperty(msg, 'id'),
                  from: readProperty(msg, 'from'),
                  to: readProperty(msg, 'to'),
                  content: readProperty(msg, 'content'),
                  metadata: readProperty(msg, 'metadata') || {},
                  timestamp: readProperty(msg, 'timestamp'),
                  status: 'read'
                })
              });
            }

            if (this.#telemetryTracker && typeof this.#telemetryTracker.recordInjectedDelivery === 'function') {
              this.#telemetryTracker.recordInjectedDelivery(this.#telemetryTarget(agent), pendingMessages.length);
            } else if (agent.telemetry) {
              agent.telemetry.injectedDeliveries = (agent.telemetry.injectedDeliveries || 0) + pendingMessages.length;
            }
          }
        }
      }

      // 2. Multi-turn tool loop (open-ended execution until natural completion or configured maxTurns)
      const maxTurns = (typeof agent.config?.maxTurns === 'number' && agent.config.maxTurns > 0)
        ? agent.config.maxTurns
        : Infinity;
      let loopCount = 0;
      // Set when the final permitted loop iteration still dispatched tool
      // calls (i.e. the model did not conclude within `maxTurns`); the turn
      // then fails with MAX_TURNS_EXCEEDED instead of resolving completed.
      let turnLimitExhausted = false;

      // Prepare tool schemas
      const isPrivileged = Boolean(agent.config?.privileged);
      const isUniversalTools = Array.isArray(agent.config.allowedTools) && agent.config.allowedTools.includes('*');
      const toolsSchema = (!isUniversalTools && Array.isArray(agent.config.allowedTools))
        ? [...getSandboxToolsSchema(agent.config.allowedTools)]
        : [...getSandboxToolsSchema(isPrivileged ? undefined : (agent.config.allowedTools || INNATE_TOOLS))];

      // Host-only custom tool surface (A0-5, ticket 0443865): custom handlers
      // execute before the dispatcher gate, so both their schemas and their
      // invocation are gated on the caller's frozen authority descriptor.
      // Chosen behavior: custom schemas are blocked for ungranted callers.
      const hasCustomToolSurface = Boolean(agent.config.customTools || agent.config.customToolSchemas);
      if (hasCustomToolSurface && this.#isCustomToolCallerAuthorized(agent)) {
        if (agent.config.customToolSchemas && Array.isArray(agent.config.customToolSchemas)) {
          toolsSchema.push(...agent.config.customToolSchemas);
        } else if (agent.config.customTools) {
          if (Array.isArray(agent.config.customTools)) {
            for (const item of agent.config.customTools) {
              if (item && (item.type === 'function' || item.function)) {
                toolsSchema.push(item);
              }
            }
          } else if (typeof agent.config.customTools === 'object') {
            for (const val of Object.values(agent.config.customTools)) {
              if (val && typeof val === 'object' && (readProperty(val, 'type') === 'function' || readProperty(val, 'function') || readProperty(val, 'definition'))) {
                toolsSchema.push((readProperty(val, 'definition') || val) as OpenAIToolDefinition);
              }
            }
          }
        }
      }

      // Wave U publishing meta tools (ticket 2518510): schemas are exposed only
      // for the exact explicit authority the caller's frozen descriptor holds
      // (`@template:authority`/`@hydration:authority`); the wildcard `'*'` and
      // `privileged` never satisfy them, so an ungranted caller never sees the
      // publishing surface. Mirrors the host-only custom-tool exposure
      // discipline.
      const publishingAuthorities = this.#publishingAuthoritiesFor(agent);
      if (publishingAuthorities.length > 0) {
        toolsSchema.push(...getPublishingToolSchemas(publishingAuthorities));
      }

      const currentDepth = typeof normalizedOptions?.depth === 'number'
        ? normalizedOptions.depth
        : (typeof normalizedOptions?.metadata?.depth === 'number' ? normalizedOptions.metadata.depth : 0);
      // Workspace view (ticket a50f109; Wave I, ticket d57cbc1): the caller's
      // resolved private workspace is bound into the tool execution context
      // alongside the caller identity, so agent file I/O is private-by-default
      // and reaches shared/mounted workspaces only through the `/global` and
      // `/agents` view mounts. `workspaceId` is a pinned dispatcher construction
      // key, so no per-call claim can override it. Resolution consumes the
      // VFS-owned rule (`resolveAgentPrivateWorkspaceKey`): an explicit
      // `config.workspaceId` pin stays verbatim, a Realm-bound agent's default
      // keys on its canonical identity, and the system scope keeps the bare id
      // — the same key lifecycle teardown resolves, so writes, mounts, and
      // eviction agree.
      const agentIdentity = this.#resolveAgentIdentity(agent);
      const privateWorkspaceId = (agentIdentity ? resolveAgentPrivateWorkspaceKey(agentIdentity) : null)
        || (typeof agent.config?.workspaceId === 'string' && agent.config.workspaceId ? agent.config.workspaceId : agent.id);
      const dispatcher: SandboxToolDispatcher = createSandboxToolDispatcher({
        virtualFs: this.#virtualFs,
        messagingBus: this.#messagingBus,
        signal: agent.abortController?.signal,
        agentId: agent.id,
        callerAgentId: agent.id,
        // Trusted canonical caller key (Wave I, ticket d57cbc1): substrates
        // (VFS, bus, scheduler, invocation) resolve a same-literal-id caller
        // realm-exactly instead of failing closed on the bare-id ambiguity.
        ...(agentIdentity && typeof agentIdentity.key === 'string' && agentIdentity.key
          ? { callerKey: agentIdentity.key }
          : {}),
        workspaceId: privateWorkspaceId,
        agentWorkspaceView: AGENT_WORKSPACE_VIEW_TOKEN,
        role: agent.config.role || (isPrivileged ? 'admin' : 'user'),
        privileged: isPrivileged,
        allowedTools: isUniversalTools ? ['*'] : (agent.config.allowedTools || null),
        // AGENTS.md §3 (encapsulation boundaries): narrow injected capability ports only — never the full runtime.
        lifecyclePort: this.#lifecyclePort ?? undefined,
        identityPort: this.#identityPort ?? undefined,
        // Wave U host publishing port (ticket 2518510): trusted bound
        // construction; the dispatcher strips per-call claims for this pinned
        // key, so a tool call can never substitute the host port.
        ...(this.#realmPublishingPort ? { realmPublishingPort: this.#realmPublishingPort } : {}),
        worldClock: this.#worldClock,
        currentDepth,
        executeTool: (name: string, args: Record<string, unknown>, ctx?: ExecutionContext): Promise<unknown> =>
          dispatcher({ name, arguments: args }, ctx)
      });

      // BUG-ENC-016: revalidate precall names with the tool system's canonical
      // resolver (the same authority `batch_precall` validation uses). The local
      // `normalizeToolName` heuristic cannot resolve every master-map alias
      // (e.g. 'worldClock_getTime' -> 'get_current_time'), so engine-local
      // normalization would reject legitimately validated precalls.
      const canonicalizeToolName = typeof dispatcher.canonicalizeToolName === 'function'
        ? dispatcher.canonicalizeToolName
        : normalizeToolName;

      // Next-Turn Precall Pipeline Execution (R3.2, R3.3, R3.5, PRC-4, PRC-5, PRC-8)
      const precallToolCalls: EngineSyntheticToolCall[] = [];
      const precallToolResponses: ToolResponseRecord[] = [];

      if (Array.isArray(agent.pendingPrecalls) && agent.pendingPrecalls.length > 0) {
        const precalls = deduplicatePrecalls(agent.pendingPrecalls).slice(0, 10);
        agent.pendingPrecalls = [];

        for (let idx = 0; idx < precalls.length; idx++) {
          const precall = precalls[idx];
          if (!precall || !precall.name) continue;

          const sanitizedIdx = String(idx).replace(/[^a-zA-Z0-9_-]/g, '_');
          const toolCallId = `call_precall_${Date.now()}_${sanitizedIdx}`;
          const toolArgsStr = typeof precall.arguments === 'string'
            ? precall.arguments
            : JSON.stringify(precall.arguments || {});

          const toolCallObj: EngineSyntheticToolCall = {
            id: toolCallId,
            type: 'function',
            function: {
              name: precall.name,
              arguments: toolArgsStr
            }
          };
          precallToolCalls.push(toolCallObj);

          this.#emit({
            type: 'tool_start',
            agentId: agent.id,
            payload: {
              toolCall: toolCallObj,
              toolName: precall.name,
              args: toolArgsStr,
              isPrecall: true
            }
          });

          let toolResp: ToolResponseRecord;
          const rawCallName = String(precall.name).trim();
          const canonCallName = canonicalizeToolName(rawCallName);
          const isAllowedPrecall = PRECALL_ALLOWLIST.has(rawCallName) || (canonCallName && PRECALL_ALLOWLIST.has(canonCallName));

          if (!isAllowedPrecall) {
            // Execution-time revalidation failure (PRC-4, PRC-6, AC-EPIC17-04)
            toolResp = {
              id: generateMessageId('tool'),
              role: 'tool',
              tool_call_id: toolCallId,
              name: precall.name,
              content: JSON.stringify({
                success: false,
                error: `Tool '${precall.name}' is not permitted as a precall. Precalls are restricted to the allowlisted precall operations.`,
                code: EXECUTION_ERROR_CODES.FORBIDDEN_PRECALL
              }),
              isError: true
            };
          } else {
            try {
              // Check custom tools on agent or runtime first
              let customHandler = resolveCustomToolHandler(agent.config.customTools, precall.name);
              if (!customHandler) {
                customHandler = resolveCustomToolHandler(this.#customTools, precall.name);
              }
              // Host-only contract (A0-5, ticket 0443865): a resolved custom
              // handler still requires the caller's descriptor grant; a merely
              // matching allowlist entry never authorizes execution.
              if (customHandler && !this.#isCustomToolCallerAuthorized(agent)) {
                customHandler = null;
              }

              if (customHandler) {
                let parsedArgs = toolArgsStr;
                try { parsedArgs = JSON.parse(toolArgsStr); } catch { /* Non-JSON arguments pass through as the raw string. */ }
                const res = await customHandler(parsedArgs, {
                  virtualFs: this.#virtualFs,
                  messagingBus: this.#messagingBus,
                  agentId: agent.id,
                  lifecyclePort: this.#lifecyclePort,
                  identityPort: this.#identityPort,
                  executeTool: (name: string, args: Record<string, unknown>, ctx?: ExecutionContext): Promise<unknown> =>
                    dispatcher({ name, arguments: args }, ctx)
                });
                toolResp = {
                  id: generateMessageId('tool'),
                  role: 'tool',
                  tool_call_id: toolCallId,
                  name: precall.name,
                  content: typeof res === 'string' ? res : JSON.stringify(res)
                };
              } else {
                const rawToolResp = await dispatcher.executeToolCall(toolCallObj);
                toolResp = {
                  id: generateMessageId('tool'),
                  name: precall.name,
                  ...rawToolResp
                };
              }
            } catch (err) {
              // Precall errors must NOT halt turn execution (R3.5)
              toolResp = {
                id: generateMessageId('tool'),
                role: 'tool',
                tool_call_id: toolCallId,
                name: precall.name,
                content: JSON.stringify({
                  success: false,
                  error: readProperty(err, 'message') || String(err),
                  code: readProperty(err, 'code') || EXECUTION_ERROR_CODES.PRECALL_EXECUTION_ERROR
                }),
                isError: true
              };
            }
          }

          precallToolResponses.push(toolResp);

          this.#emit({
            type: 'tool_end',
            agentId: agent.id,
            payload: {
              toolCall: toolCallObj,
              toolName: precall.name,
              result: toolResp,
              isPrecall: true
            }
          });
        }

        if (this.#telemetryTracker && typeof this.#telemetryTracker.recordPrecall === 'function') {
          this.#telemetryTracker.recordPrecall(this.#telemetryTarget(agent), precalls.length);
        } else if (agent.telemetry) {
          agent.telemetry.precallCount = (agent.telemetry.precallCount || 0) + precalls.length;
        }
      }

      // Coalesce synthetic mail tool calls and precall tool calls into single synthetic assistant message (R4.1, R4.2, Critic Directive 2)
      const allSyntheticCalls = [...mailToolCalls, ...precallToolCalls];
      const allSyntheticResponses = [...mailToolResponses, ...precallToolResponses];

      if (allSyntheticCalls.length > 0) {
        const syntheticAssistantMsg: HistoryMessage = {
          id: generateMessageId('ast'),
          role: 'assistant',
          content: '',
          reasoning_content: '', // HARD INVARIANT: MUST be a string primitive! (INV-REASONING-STRING)
          tool_calls: allSyntheticCalls,
          metadata: {
            synthetic: true,
            ...(mailToolCalls.length > 0 ? { injected: true } : {}),
            ...(precallToolCalls.length > 0 ? { precall: true } : {}),
            timestamp: Date.now()
          }
        };
        agent.history.push(syntheticAssistantMsg);

        for (const resp of allSyntheticResponses) {
          agent.history.push(resp);
        }

        turnToolCalls.push(...allSyntheticCalls);
      }

      // MOD-20 W3-B2: turn-start-only preset materialization. Runs exactly once
      // per turn — after directive/mail staging and before the inference loop —
      // so every turn kind observes the freshly materialized model, while an
      // in-flight turn never sees a mid-turn provider swap. Agents without the
      // hook (unit-test mocks) are unaffected.
      if (typeof agent.materializeEffectiveModel === 'function') {
        agent.materializeEffectiveModel();
      }

      while (loopCount < maxTurns) {
        loopCount++;

        if (turnAborted || agent.abortController?.signal.aborted) {
          break;
        }

        // Reset live streaming trackers for this sub-turn
        agent.currentStream = '';
        agent.currentReasoning = '';
        agent.activeToolCalls = [];

        // Format history with tool hygiene before invocation
        const formattedMessages: Array<{ role?: string; content?: string }> =
          formatMessagesWithToolHygiene(agent.history);

        // Inject [IDENTITY] preamble into context for model completion [REQ-AGENT-06] & [AC-06]
        const autonomyTools = ['whoami', 'runtime_whoami', 'invoke_agent', 'runtime_invokeAgent', 'schedule', 'runtime_schedule', 'list_schedules', 'runtime_listSchedules', 'cancel_schedule', 'runtime_cancelSchedule', 'describe_tool', 'system_describeTool', 'list_inbox', 'read_message'];
        const hasAutonomyTools = Array.isArray(agent.config?.allowedTools) && agent.config.allowedTools.some(t => autonomyTools.includes(t));
        const enableIdentityHeader = agent.config?.identityHeader === true ||
          (agent.config?.identityHeader !== false && (
            agent.config?.mailboxAutonomy === true ||
            this.#mailboxAutonomy === true ||
            hasAutonomyTools ||
            (agent.config?.role && agent.config.role !== 'user' && agent.config.role !== 'admin')
          ));

        if (enableIdentityHeader) {
          const identityHeader = `[IDENTITY] Agent ID: ${agent.id} | Name: ${agent.name || agent.config?.name || agent.id} | Role: ${agent.config?.role || (agent.config?.privileged ? 'admin' : 'user')} | Workspace: ${agent.config?.workspaceId || agent.id} | Mode: ${agent.config?.triggerPolicy || 'auto'}`;
          if (formattedMessages.length > 0 && formattedMessages[0].role === 'system') {
            const firstMessage = formattedMessages[0];
            const firstContent = typeof firstMessage.content === 'string' ? firstMessage.content : '';
            if (!firstContent.includes('[IDENTITY]')) {
              formattedMessages[0] = {
                ...firstMessage,
                content: `${identityHeader}\n\n${firstContent}`.trim()
              };
            }
          } else {
            formattedMessages.unshift({
              role: 'system',
              content: identityHeader
            });
          }
        }

        if (!agent.model) {
          agent.rebindModel();
        }

        if (this.#telemetryTracker) {
          this.#telemetryTracker.initializeTelemetry(this.#telemetryTarget(agent));
        }

        try {
          if (agent.telemetry) {
            agent.telemetry.lastSentContext = JSON.parse(JSON.stringify(formattedMessages));
          }
        } catch {
          if (agent.telemetry) {
            agent.telemetry.lastSentContext = formattedMessages.map(m => ({ ...m }));
          }
        }

        const turnModel = normalizedOptions?.model || agent.model;

        const streamOptions: EngineStreamOptions = {
          messages: formattedMessages,
          tools: toolsSchema.length > 0 ? toolsSchema : undefined,
          signal: agent.abortController?.signal,
          onChunk: (chunk) => {
            if (typeof normalizedOptions?.onChunk === 'function') {
              try { normalizedOptions.onChunk(chunk); } catch { /* onChunk is observational; callback errors must not abort the turn. */ }
            }
          }
        };

        let rawToolCalls: unknown = null;
        let turnUsage: unknown = null;

        if (typeof turnModel.stream === 'function') {
          const streamGen = turnModel.stream(streamOptions);
          for await (const chunk of streamGen) {
            if (turnAborted || agent.abortController?.signal?.aborted || normalizedOptions?.signal?.aborted) {
              break;
            }
            if (!chunk) continue;

            let deltaText = '';
            let deltaReasoning = '';

            if (typeof chunk === 'string') {
              deltaText = chunk;
              agent.currentStream += deltaText;
            } else if (chunk.type === 'text') {
              deltaText = chunk.content || '';
              agent.currentStream += deltaText;
            } else if (chunk.type === 'reasoning') {
              deltaReasoning = chunk.content || chunk.reasoning || '';
              agent.currentReasoning += deltaReasoning;
            } else if (chunk.type === 'tool_call') {
              if (Array.isArray(chunk.toolCalls)) {
                rawToolCalls = [...chunk.toolCalls];
              }
            } else if (chunk.type === 'usage') {
              turnUsage = chunk.usage || turnUsage;
            } else if (chunk.type === 'finish') {
              if (chunk.content !== undefined && !agent.currentStream) agent.currentStream = chunk.content;
              if (chunk.reasoning !== undefined && !agent.currentReasoning) agent.currentReasoning = chunk.reasoning;
              if (Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0) {
                rawToolCalls = [...chunk.toolCalls];
              }
              if (chunk.usage) turnUsage = chunk.usage;
            } else {
              if (chunk.visibleProse !== undefined) {
                agent.currentStream = chunk.visibleProse;
                deltaText = chunk.text || chunk.content || '';
              } else if (chunk.text || chunk.content) {
                deltaText = chunk.text || chunk.content || '';
                agent.currentStream += deltaText;
              }

              if (chunk.currentReasoning !== undefined) {
                agent.currentReasoning = chunk.currentReasoning;
                deltaReasoning = chunk.reasoning || chunk.reasoning_content || '';
              } else if (chunk.reasoning || chunk.reasoning_content) {
                deltaReasoning = chunk.reasoning || chunk.reasoning_content || '';
                agent.currentReasoning += deltaReasoning;
              }

              if (chunk.tool_calls || chunk.toolCalls) {
                const tc = chunk.tool_calls || chunk.toolCalls;
                if (Array.isArray(tc)) {
                  rawToolCalls = [...tc];
                }
              }
              if (chunk.usage) turnUsage = chunk.usage;
            }

            agent.updatedAt = Date.now();

            this.#emit({
              type: 'stream',
              agentId: agent.id,
              payload: {
                chunk: deltaText,
                delta: deltaText,
                reasoning: deltaReasoning,
                visibleProse: agent.currentStream,
                currentReasoning: agent.currentReasoning,
                fullText: agent.currentStream,
                fullReasoning: agent.currentReasoning
              }
            });

            if (typeof normalizedOptions?.onChunk === 'function') {
              try {
                normalizedOptions.onChunk(chunk);
              } catch {
                // onChunk is observational; callback errors must not abort the turn.
              }
            }
          }
        } else if (typeof turnModel.complete === 'function') {
          const compResult = await turnModel.complete(streamOptions);
          if (compResult) {
            agent.currentStream = compResult.content || '';
            agent.currentReasoning = compResult.reasoning || '';
            rawToolCalls = compResult.toolCalls || compResult.tool_calls || null;
            turnUsage = compResult.usage || null;
          }
        }

        if (turnAborted || agent.abortController?.signal?.aborted || normalizedOptions?.signal?.aborted) {
          break;
        }

        const responseContent = agent.currentStream;
        const responseReasoning = agent.currentReasoning;

        // Normalize tool calls to both OpenAI structure (function: { name, arguments }) and ModelInterface shape
        let toolCalls: EngineToolCall[] | null = null;
        if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
          toolCalls = normalizeToolCalls(rawToolCalls);
        }

        if (this.#telemetryTracker) {
          this.#telemetryTracker.recordTurnUsage(this.#telemetryTarget(agent), {
            turnUsage,
            formattedMessages,
            responseContent,
            responseReasoning
          });
        }

        finalOutput = responseContent || '';

        // Record assistant response in history (INV-REASONING-STRING)
        const assistantMsg: HistoryMessage & { reasoning?: string } = {
          id: generateMessageId('ast'),
          role: 'assistant',
          content: responseContent || '',
          reasoning_content: (typeof responseReasoning === 'string') ? responseReasoning : ''
        };
        if (responseReasoning) {
          assistantMsg.reasoning = responseReasoning;
        }
        if (toolCalls && toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        agent.history.push(assistantMsg);

        // If no tool calls emitted, LLM concluded response
        if (!toolCalls || toolCalls.length === 0) {
          break;
        }

        // Execute tool calls
        agent.activeToolCalls = [...toolCalls];
        turnToolCalls.push(...toolCalls);

        for (const toolCall of toolCalls) {
          if (turnAborted || agent.abortController?.signal?.aborted || normalizedOptions?.signal?.aborted) {
            break;
          }

          const toolName = toolCall.function?.name || toolCall.name || '';
          const rawArgs = toolCall.function?.arguments !== undefined
            ? toolCall.function.arguments
            : (toolCall.arguments || {});

          const isWaitTool = toolName === 'runtime_waitForMail' || toolName === 'wait_for_mail' || toolName === 'runtimeWaitForMail' || toolName === 'waitForMail';
          const nextState = isWaitTool ? AGENT_STATES.WAITING_FOR_MESSAGE : AGENT_STATES.RUNNING;
          const nextStateDetail = isWaitTool ? `Waiting for mail: ${toolName}` : `Executing tool: ${toolName}`;
          this.#setAgentState(agent, nextState, nextStateDetail);

          this.#emit({
            type: 'tool_start',
            agentId: agent.id,
            payload: {
              toolCall,
              toolName,
              args: rawArgs
            }
          });

          let toolResponse: HistoryMessage & { isError?: boolean };

          // Check for custom tool implementation
          let customHandler = resolveCustomToolHandler(agent.config.customTools, toolName);
          if (!customHandler) {
            customHandler = resolveCustomToolHandler(this.#customTools, toolName);
          }
          // Host-only contract (A0-5, ticket 0443865): a resolved custom
          // handler still requires the caller's descriptor grant; a merely
          // matching allowlist entry never authorizes execution.
          if (customHandler && !this.#isCustomToolCallerAuthorized(agent)) {
            customHandler = null;
          }

          if (customHandler) {
            try {
              let parsedArgs = rawArgs;
              if (typeof rawArgs === 'string') {
                try {
                  parsedArgs = JSON.parse(rawArgs);
                } catch {
                  // Non-JSON arguments fall through as the raw string.
                }
              }
              const res = await customHandler(parsedArgs, {
                virtualFs: this.#virtualFs,
                messagingBus: this.#messagingBus,
                agentId: agent.id,
                lifecyclePort: this.#lifecyclePort,
                identityPort: this.#identityPort,
                executeTool: (name: string, args: Record<string, unknown>, ctx?: ExecutionContext): Promise<unknown> =>
                  dispatcher({ name, arguments: args }, ctx)
              });
              toolResponse = {
                id: generateMessageId('tool'),
                role: 'tool',
                tool_call_id: toolCall.id || '',
                name: toolName,
                content: typeof res === 'string' ? res : JSON.stringify(res)
              };
            } catch (customErr) {
              toolResponse = {
                id: generateMessageId('tool'),
                role: 'tool',
                tool_call_id: toolCall.id || '',
                name: toolName,
                content: JSON.stringify({
                  success: false,
                  error: readProperty(customErr, 'message') || String(customErr),
                  code: readProperty(customErr, 'name') || EXECUTION_ERROR_CODES.TOOL_EXECUTION_ERROR
                }),
                isError: true
              };
            }
          } else {
            try {
              const rawToolResp = await dispatcher.executeToolCall(toolCall);
              toolResponse = {
                id: generateMessageId('tool'),
                ...rawToolResp
              };
            } catch (toolExecErr) {
              toolResponse = {
                id: generateMessageId('tool'),
                role: 'tool',
                tool_call_id: toolCall.id || '',
                name: toolName,
                content: JSON.stringify({
                  success: false,
                  error: readProperty(toolExecErr, 'message') || String(toolExecErr),
                  code: readProperty(toolExecErr, 'code') || EXECUTION_ERROR_CODES.TOOL_EXECUTION_ERROR
                }),
                isError: true
              };
            }
          }

          if (turnAborted || agent.abortController?.signal?.aborted || normalizedOptions?.signal?.aborted) {
            break;
          }

          agent.history.push(toolResponse);

          this.#emit({
            type: 'tool_end',
            agentId: agent.id,
            payload: {
              toolCall,
              toolName,
              result: toolResponse
            }
          });
        }

        if (turnAborted || agent.abortController?.signal?.aborted || normalizedOptions?.signal?.aborted) {
          break;
        }

        // Terminal Batch & runtime_batchPrecall Execution Handling (R2.1, R2.2, R2.3, R5.1, PRC-1, PRC-2)
        const terminalToolCall = toolCalls.find(tc => {
          const tName = tc.function?.name || tc.name || '';
          return tName === SANDBOX_TOOLS.BATCH_PRECALL ||
            tName === 'runtime_batchPrecall' ||
            tName === 'batchPrecall' ||
            tName === 'batch_precall' ||
            tName === 'runtimeBatchPrecall' ||
            normalizeToolName(tName) === (SANDBOX_TOOLS.BATCH_PRECALL || 'batch_precall');
        });

        if (terminalToolCall) {
          // Check if ANY tool call in this turn batch failed
          let batchHasError = false;
          const batchToolResponses = agent.history.slice(-toolCalls.length);
          for (const resp of batchToolResponses) {
            if (isToolResponseError(resp)) {
              batchHasError = true;
              break;
            }
          }

          // Locate and parse the terminal batch response once (validation + payload extraction)
          const terminalResp = batchToolResponses.find(r => {
            const tcName = terminalToolCall.function?.name || terminalToolCall.name || '';
            return r.name === tcName || r.tool_call_id === terminalToolCall.id;
          });
          let parsedTerminalResponse: unknown = null;
          if (terminalResp?.content) {
            try {
              parsedTerminalResponse = typeof terminalResp.content === 'string'
                ? JSON.parse(terminalResp.content)
                : terminalResp.content;
            } catch {
              parsedTerminalResponse = null;
            }
          }

          // BUG-ENC-012 / BUG-ENC-016 batch-close semantics (decided):
          // - Unwrapped self-validation failures (`{ success: false }` items such as
          //   PRECALL_FORBIDDEN / INVALID_ARGUMENTS) BLOCK closing: pendingPrecalls are
          //   cleared and the model is re-invoked with the failure receipts.
          // - Wrapped execution failures (`{ name, result: { success: false } }` items,
          //   i.e. a validated precall whose tool execution failed) do NOT block closing.
          //   They are visible: the receipts stay in the stored history / emitted
          //   tool_end payload, the calls remain queued in pendingPrecalls for next-turn
          //   recovery, and the count is reported on the terminal-stop telemetry event.
          // - Success-path queued names are canonicalized through the tool system's
          //   resolver (same authority as batch_precall validation), so aliases that
          //   validated successfully are not re-rejected here (BUG-ENC-016).
          let batchExecutionFailures = 0;
          const terminalResults = readProperty(parsedTerminalResponse, 'results');
          if (!batchHasError && Array.isArray(terminalResults)) {
            for (const item of terminalResults) {
              if (!item) continue;
              if (readProperty(item, 'success') === false) {
                batchHasError = true;
                break;
              }
              const itemResult = readProperty(item, 'result');
              if (itemResult && typeof itemResult === 'object' && readProperty(itemResult, 'success') === false) {
                batchExecutionFailures++;
              }
            }
          }

          if (batchHasError) {
            // Failure Path (R2.3, R5.1): do NOT terminate, do NOT queue precalls.
            // Loop continues so LLM is re-invoked with the failure results.
            agent.pendingPrecalls = [];
          } else {
            // Success Path (R2.1, R2.2, PRC-1, PRC-2):
            let terminalArgs = terminalToolCall.function?.arguments !== undefined
              ? terminalToolCall.function.arguments
              : (terminalToolCall.arguments || {});
            if (typeof terminalArgs === 'string') {
              try { terminalArgs = JSON.parse(terminalArgs); } catch { terminalArgs = {}; }
            }

            const terminalSummary = readProperty(terminalArgs, 'summary');
            let closingSummary = typeof terminalSummary === 'string' ? terminalSummary.trim() : '';
            const terminalCalls = readProperty(terminalArgs, 'calls');
            let queuedCalls: unknown[] = Array.isArray(terminalCalls) ? terminalCalls : [];

            // If dispatcher returned validated calls and summary, prefer those from response
            if (parsedTerminalResponse) {
              const parsedSummary = readProperty(parsedTerminalResponse, 'summary');
              if (typeof parsedSummary === 'string') {
                closingSummary = parsedSummary;
              }
              const parsedCalls = readProperty(parsedTerminalResponse, 'calls');
              if (Array.isArray(parsedCalls)) {
                queuedCalls = parsedCalls;
              }
            }

            // Defense-in-depth (BUG-ENC-012): every queued precall must be allowlisted.
            const hasForbiddenQueuedCall = queuedCalls.some((call) => {
              if (!call || typeof call !== 'object' || !readProperty(call, 'name')) return true;
              const rawName = String(readProperty(call, 'name')).trim();
              const canonName = canonicalizeToolName(rawName);
              return !(PRECALL_ALLOWLIST.has(rawName) || (canonName && PRECALL_ALLOWLIST.has(canonName)));
            });

            if (hasForbiddenQueuedCall) {
              agent.pendingPrecalls = [];
            } else {
              // Summary as Assistant Turn Response (PRC-1, PRC-2, AC-EPIC17-01, AC-EPIC17-02, INV-REASONING-STRING)
              finalOutput = closingSummary;
              agent.history.push({
                id: generateMessageId('msg_assistant'),
                role: 'assistant',
                content: closingSummary,
                reasoning_content: '', // String primitive
                timestamp: Date.now(),
                metadata: {
                  summary: closingSummary,
                  terminalSummary: true
                }
              });

              agent.lastSummary = closingSummary;
              agent.pendingPrecalls = deduplicatePrecalls(queuedCalls).slice(0, 10);
              agent.lastInterruptedTurn = null;
              if (this.#telemetryTracker && typeof this.#telemetryTracker.recordTerminalStop === 'function') {
                this.#telemetryTracker.recordTerminalStop(this.#telemetryTarget(agent), {
                  reason: batchExecutionFailures > 0
                    ? 'terminal_batch_precall_with_execution_failures'
                    : 'terminal_batch_precall',
                  summary: closingSummary,
                  executionFailures: batchExecutionFailures
                });
              } else if (agent.telemetry) {
                agent.telemetry.terminalStops = (agent.telemetry.terminalStops || 0) + 1;
              }

              if (assistantMsg) {
                assistantMsg.metadata = {
                  ...(assistantMsg.metadata || {}),
                  summary: closingSummary
                };
              }

              // Immediately break out of tool loop without further LLM inference
              break;
            }
          }
        }

        agent.activeToolCalls = [];
        if (loopCount >= maxTurns) {
          turnLimitExhausted = true;
        }
        this.#setAgentState(agent, AGENT_STATES.RUNNING, 'Tool execution complete; re-invoking LLM');
      }

      // Check if aborted during loop
      if (turnAborted || agent.abortController?.signal?.aborted || normalizedOptions?.signal?.aborted || agent.state === AGENT_STATES.CANCELING) {
        if (agent.state !== AGENT_STATES.TERMINATED && agent.state !== AGENT_STATES.RECYCLED) {
          this.#setAgentState(agent, AGENT_STATES.IDLE, 'Turn cancelled');
        }
        agent.lastInterruptedTurn = {
          input,
          mode,
          timestamp: Date.now(),
          cancelled: true
        };
        return {
          agent,
          status: EXECUTION_STATUS.CANCELLED,
          output: agent.currentStream || finalOutput,
          toolCalls: turnToolCalls,
          cancelled: true,
          code: EXECUTION_ERROR_CODES.TURN_ABORTED
        };
      }

      // Hard turn cap: the model kept dispatching tool calls until the budget ran out.
      if (turnLimitExhausted) {
        throw createCodedError(`Turn limit exceeded: agent '${agent.id}' reached maxTurns (${maxTurns}) without concluding`, EXECUTION_ERROR_CODES.MAX_TURNS_EXCEEDED);
      }

      // Turn completed successfully (INV-OPEN-ENDED: continuous lifetime turns)
      agent.lastInterruptedTurn = null;
      agent.turnCount++;
      if (agent.state !== AGENT_STATES.TERMINATED && agent.state !== AGENT_STATES.RECYCLED) {
        this.#setAgentState(agent, AGENT_STATES.IDLE, null);
      }

      // Pre-clear live streaming buffers before emitting turn_complete to prevent duplicate UI flash
      agent.currentStream = '';
      agent.currentReasoning = '';
      agent.activeToolCalls = [];

      this.#emit({
        type: 'turn_complete',
        agentId: agent.id,
        payload: {
          output: finalOutput,
          toolCalls: turnToolCalls,
          turns: loopCount,
          turnCount: agent.turnCount,
          summary: agent.lastSummary || null,
          metadata: { summary: agent.lastSummary || null }
        }
      });

      return {
        agent,
        status: EXECUTION_STATUS.COMPLETED,
        output: finalOutput,
        toolCalls: turnToolCalls,
        summary: agent.lastSummary || null,
        metadata: { summary: agent.lastSummary || null }
      };
    } catch (err) {
      // Check if cancellation or abort
      if (
        turnAborted ||
        agent.abortController?.signal?.aborted ||
        normalizedOptions?.signal?.aborted ||
        agent.state === AGENT_STATES.CANCELING ||
        readProperty(err, 'name') === 'AbortError' ||
        readProperty(err, 'code') === 'ABORT_ERR' ||
        String(readProperty(err, 'message') || err) === 'AbortError'
      ) {
        if (agent.state !== AGENT_STATES.TERMINATED && agent.state !== AGENT_STATES.RECYCLED) {
          this.#setAgentState(agent, AGENT_STATES.IDLE, 'Turn cancelled');
        }
        agent.lastInterruptedTurn = {
          input,
          mode,
          timestamp: Date.now(),
          cancelled: true
        };
        return {
          agent,
          status: EXECUTION_STATUS.CANCELLED,
          output: agent.currentStream || finalOutput,
          toolCalls: turnToolCalls,
          cancelled: true,
          code: EXECUTION_ERROR_CODES.TURN_ABORTED
        };
      }

      // Unhandled error: record lastError and transition state to ERRORED
      agent.lastError = errorText(err);
      if (agent.state !== AGENT_STATES.TERMINATED && agent.state !== AGENT_STATES.RECYCLED) {
        this.#setAgentState(agent, AGENT_STATES.ERRORED, agent.lastError);
      }

      this.#emit({
        type: 'error',
        agentId: agent.id,
        payload: {
          error: agent.lastError,
          message: agent.lastError,
          status: readProperty(err, 'status') || null,
          code: readProperty(err, 'code') || readProperty(err, 'name') || EXECUTION_ERROR_CODES.MODEL_INVOCATION_ERROR
        }
      });

      throw err;
    } finally {
      // Clean up abort signal event listeners to prevent memory leaks
      if (externalSignal && onExternalAbort && typeof externalSignal.removeEventListener === 'function') {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort);
        } catch {
          // Listener removal is best-effort in the cleanup path.
        }
      }
      if (agent.abortController?.signal && onInternalAbort && typeof agent.abortController.signal.removeEventListener === 'function') {
        try {
          agent.abortController.signal.removeEventListener('abort', onInternalAbort);
        } catch {
          // Listener removal is best-effort in the cleanup path.
        }
      }

      // Deterministic Stream Cleanup (INV-STREAM-CLEANUP)
      agent.currentStream = '';
      agent.currentReasoning = '';
      agent.activeToolCalls = [];
      agent.abortController = null;

      if (agent.state !== AGENT_STATES.TERMINATED && agent.state !== AGENT_STATES.RECYCLED && agent.state !== AGENT_STATES.ERRORED) {
        this.#setAgentState(agent, AGENT_STATES.IDLE, null);
      }
    }
  }
}
