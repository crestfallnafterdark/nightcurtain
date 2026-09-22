/**
 * @packageDocumentation
 * Agent Conversational History, Cascading Tool-Pairing Hygiene, Dual-Stack Undo/Redo & Turn Resilience (Module 9: runtime_lifecycle).
 *
 * Agent Conversation Turn History, Dual-Stack Undo/Redo, Message Hygiene & Turn Resilience (Layer 2: runtime_lifecycle).
 *
 * @module runtime/historyManager
 * @mayImport ../agent/index.ts
 * @mayImport type-only ../index.ts
 * @invariant INV-TOOL-HYGIENE: Deleting an assistant message with declared `tool_calls` cascade-deletes every downstream `role: 'tool'` response whose `tool_call_id` matches a declared call id, and deleting a `tool` response prunes its matching call from the declaring assistant message (dropping an emptied `tool_calls` property) — history retains no orphaned half of a deleted tool pair.
 * @invariant INV-UNDO-BUNDLE: `undoAgentTurn` pops the turn's trailing system/tool/assistant/user messages in a single synchronous pass, assembles one chronological `TurnBundle` (`allPoppedMessages`), and pushes it onto `agent.redoStack` whenever messages were popped or a prompt was recovered — the empty-history recovery path pushes a message-less bundle (`allPoppedMessages: []`, `turnCountDelta: 0`); `agent.turnCount` is decremented at most once, only when a popped assistant message had non-empty content and the count was positive, never below zero, and `turnCountDelta` records exactly that decrement (`1` or `0`).
 * @invariant INV-REDO-RESTORE: `redoAgentTurn` pops the most recent `TurnBundle` and restores `allPoppedMessages` back into `agent.history` in exact chronological sequence, appended at the tail for conventional bundles or inserted at the bundle's numeric `insertionIndex` when a targeted undo removed an earlier turn (clamped to the current length), restoring `agent.turnCount` by `turnBundle.turnCountDelta` (a `0` delta leaves the count unchanged, so redo never inflates a count that undo did not decrement); an empty `redoStack` returns `{ success: false, reason: 'EMPTY_REDO_STACK' }`.
 * @invariant INV-HISTORY-PRESERVE: `retryAgentTurn` never re-injects a duplicate user prompt: a trailing unresponded `user` message is popped and re-sent as the prompt, while a mid-turn tail (`tool`, or `assistant` with `tool_calls`) resumes via `executeAgentTurn(agentId, null)` against the existing history.
 * @invariant INV-MSG-IDENTITY: Message lookups backfill first — `updateHistoryMessage` and `deleteHistoryMessage` call `ensureHistoryMessageIds(agent.history)`, which fills missing, blank, or non-string ids in place with unique role-prefixed ids (`<role>_<uuid>`, e.g. `user_<uuid>`, `assistant_<uuid>`, `tool_<uuid>`, and `msg_<uuid>` when the message carries no role; UUID where `crypto.randomUUID` is available) and leaves existing non-blank string ids untouched, and fills a missing assistant `reasoning_content` from its `reasoning`/`thought` alias or `''`.
 * @invariant In-flight undo: for an agent in `running`, `waiting_for_input`, `waiting_for_dependents`, `waiting_for_message`, or `canceling` state, `undoAgentTurn` cancels via `runtime.cancelAgent`, aborts `agent.abortController`, clears `agent.currentStream`/`agent.currentReasoning`/`agent.activeToolCalls`, and transitions the agent to `idle` before popping history.
 * @invariant Asymmetric miss semantics: `updateHistoryMessage` throws on a missing target (`INDEX_OUT_OF_BOUNDS` for an out-of-range numeric index, `MESSAGE_NOT_FOUND` for an unknown id) while `deleteHistoryMessage` returns `false` for the same misses; both still throw `AGENT_NOT_FOUND` for an unknown agent.
 * @invariant Event emission: mutations emit `message_updated`, `message_deleted` (carrying `cascadedDeletedIds`), `turn_undone`, and `turn_redone` through the emit port — the options-supplied `emit` port when usable, otherwise (options form) a port resolved once from `runtime.createSubsystemEmitPort()`, otherwise (runtime form) the runtime's own factory; when neither source exists, emission is a documented no-op, and a throwing emit is swallowed and never alters the operation result.
 * @invariant UNDO-TARGET: `undoAgentTurn` with an explicit non-blank `targetTurnId` resolves the turn by matching a message `id` or `metadata.turnId`: a target inside the default (most recent) pop range is undone exactly like the untargeted path; a target inside an earlier user-initiated segment is popped in place with its original position recorded as `insertionIndex` on the bundle; a target found on `agent.redoStack` returns `{ success: false, reason: 'TURN_ALREADY_UNDONE', targetTurnId }`; any other value (including a non-string) returns `{ success: false, reason: 'TURN_NOT_FOUND', targetTurnId }`; failures are returned before any mutation, in-flight cancellation, or emission, and blank values behave as "no target".
 * @decision `undoAgentTurn` is exposed to MOD-8 lifecycle descriptors through the frozen `LifecyclePort`, delegating to `HistoryManager.undoAgentTurn(agentId, targetTurnId)` with optional target-turn semantics
 */

import { generateMessageId, ensureHistoryMessageIds } from '../agent/index.ts';
export { generateMessageId, ensureHistoryMessageIds };

import type { SubsystemEmitPort } from '../index.ts';
import type {
  Agent,
  HistoryMessage,
  MessageUpdateFields,
  TurnBundle,
  UndoTurnResult,
  RedoTurnResult
} from '../agent/index.ts';

// ============================================================================
// Internal Typing & Helpers
// ============================================================================

/**
 * Error carrying an optional machine-readable lifecycle error code.
 */
type CodedError = Error & { code?: string };

/**
 * Structural view of the parent AgentRuntime coordinator used by HistoryManager.
 * Members are optional because a partially-constructed runtime is tolerated:
 * each call site validates the member it needs before invoking it.
 */
interface HistoryRuntime {
  getAgent?(agentId: string): Agent | null;
  cancelAgent?(agentId: string, reason?: string): unknown;
  setAgentState?(agent: Agent, state: string, reason?: string): unknown;
  transitionAgentState?(agent: Agent, state: string, reason?: string): unknown;
  executeAgentTurn(agentId: string, input?: unknown, options?: object): Promise<unknown>;
  /**
   * Queue-backed user-turn entry (MOD-21 W7); preferred over `executeAgentTurn` when present so
   * retries route through the centralized `TriggerQueue`.
   */
  enqueueUserTurn?(agentId: string, input?: unknown, options?: object): Promise<unknown>;
  /**
   * Used as the emit-port fallback when the options form supplies no usable `emit` port.
   */
  createSubsystemEmitPort?(): { emit: (event: object) => void };
}

/**
 * Duck-typed constructor argument probe: the options form, the runtime itself,
 * or `null`. Kept structural because the constructor detects the shape at runtime.
 */
interface HistoryManagerConstructorArg {
  runtime?: unknown;
  emit?: { emit: (event: object) => void } | null;
  getAgent?: unknown;
  createSubsystemEmitPort?: () => { emit: (event: object) => void };
}

/**
 * Reads the `content` member of a structured turn input of unknown shape.
 * Internal unexported helper; returns `undefined` for primitive inputs and for
 * object/function inputs that carry no `content` member.
 * @param input - Interrupted-turn input of unknown shape
 * @returns The `content` member when present, otherwise `undefined`
 */
function inputContent(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (typeof input !== 'object' && typeof input !== 'function') return undefined;
  return 'content' in input ? input.content : undefined;
}

/**
 * Stringifies an interrupted-turn input's `content` member, preserving the
 * undefined-is-null distinction. Internal unexported helper.
 * @param content - Content member of unknown shape
 * @returns The stringified content, or `null` when it is `undefined`
 */
function stringifyContent(content: unknown): string | null {
  return content !== undefined ? String(content) : null;
}

/**
 * Executes a retry/resend turn through the centralized queue-backed user-turn
 * entry when the runtime exposes one (MOD-21 W7 single dispatch point), falling
 * back to the direct turn engine on hosts without a `TriggerQueue`.
 *
 * @param runtime - Parent AgentRuntime coordinator
 * @param agentId - Unique agent identifier
 * @param input - Resend input; `null` resumes against existing history
 * @param options - Turn options forwarded to the dispatch entry
 * @returns Result of the queue-backed or direct turn execution
 */
function dispatchRetryTurn(
  runtime: HistoryRuntime,
  agentId: string,
  input: unknown = null,
  options: object = {}
): Promise<unknown> {
  if (typeof runtime.enqueueUserTurn === 'function') {
    return runtime.enqueueUserTurn(agentId, input, options);
  }
  return runtime.executeAgentTurn(agentId, input, options);
}

// ============================================================================
// 1. HistoryManager Options Specification
// ============================================================================

/**
 * Options for instantiating {@link HistoryManager}.
 *
 * Supports dependency injection of the runtime coordinator.
 *
 * @example
 * ```typescript
 * const options: HistoryManagerOptions = {
 *   runtime: agentRuntime
 * };
 * const historyManager = new HistoryManager(options);
 * ```
 */
export interface HistoryManagerOptions {
  /**
   * Back-reference to the parent AgentRuntime coordinator.
   *
   * When no runtime is supplied (or an object without a `getAgent` function is used),
   * agent-dependent methods throw `AGENT_NOT_FOUND` and
   * {@link HistoryManager.isAgentInterrupted} returns `false`.
   */
  runtime?: unknown;
  /**
   * Injected canonical {@link SubsystemEmitPort}. Adopted from an options-form
   * constructor argument when this value exposes an `emit` function, including
   * `{ runtime: null, emit }`. When omitted — or when it does not expose an
   * `emit` function — the port falls back to `runtime.createSubsystemEmitPort()`
   * when the supplied runtime provides it; with neither source, history events
   * are discarded as a documented no-op.
   */
  emit?: SubsystemEmitPort | null;
}

/**
 * Structured failure returned by {@link HistoryManager.undoAgentTurn} when an
 * explicit turn selector does not resolve to a turn currently present in history.
 *
 * Failures are returned (never thrown), leave the agent completely untouched,
 * and never cancel in-flight work or emit events.
 */
export interface UndoTurnSelectionFailure {
  /** Always `false`, distinguishing the failure from a successful {@link UndoTurnResult}. */
  readonly success: false;
  /**
   * `'TURN_ALREADY_UNDONE'` when the selector identifies a bundle on
   * `agent.redoStack`; `'TURN_NOT_FOUND'` when no active turn or undo bundle
   * carries it (including non-string selectors).
   */
  readonly reason: 'TURN_ALREADY_UNDONE' | 'TURN_NOT_FOUND';
  /** The trimmed turn selector that could not be resolved. */
  readonly targetTurnId: string;
}

// ============================================================================
// 2. HistoryManager Class
// ============================================================================

/**
 * Conversational Turn & History Management Subsystem (Module 9: runtime_lifecycle).
 *
 * Governs in-place message updates, cascading tool-pairing hygiene deletion,
 * dual-stack undo/redo with atomic {@link TurnBundle} snapshotting, mid-turn error
 * recovery without context duplication, and turn interruption detection.
 *
 * Architectural Invariants:
 * - INV-TOOL-HYGIENE: Cascading Tool Pairing Hygiene prevents fatal LLM API 400 errors.
 * - INV-UNDO-BUNDLE: Atomic TurnBundle Dual-Stack Undo/Redo.
 * - INV-HISTORY-PRESERVE: Zero Duplicate User Prompt on Mid-Turn Resume.
 *
 * @example
 * ```typescript
 * import { HistoryManager } from './historyManager/index.ts';
 *
 * const historyManager = new HistoryManager({ runtime: agentRuntime });
 * const undoResult = historyManager.undoAgentTurn('coder');
 * console.log(`Undone prompt: ${undoResult.restoredPrompt}`);
 * ```
 */
export class HistoryManager {
  /**
   * Parent runtime coordinator, or null when constructed without one.
   */
  #runtime: HistoryRuntime | null = null;
  #emitPort: { emit: (event: object) => void } | null;

  /**
   * Constructs a new HistoryManager subsystem instance.
   *
   * Argument resolution:
   * - An object is treated as {@link HistoryManagerOptions} when it declares its own
   *   `runtime` key, or when it declares its own `emit` key without exposing a
   *   `getAgent` function: `runtime` (possibly `null`) becomes the coordinator
   *   back-reference and `emit` is adopted as the emit port when `emit.emit` is a function.
   *   When `emit` is absent or unusable, the port falls back to
   *   `runtime.createSubsystemEmitPort()` if the runtime exposes that factory.
   * - Any other object is treated as the runtime itself — including an object carrying
   *   its own `emit` key when it exposes a `getAgent` function — and
   *   `runtime.createSubsystemEmitPort()` is called when present to obtain the emit port.
   * - `null`/`undefined` (or a runtime without the factory and no options `emit`)
   *   yields a manager with no emit port; history event emission is then a
   *   documented no-op and never throws.
   *
   * @param runtimeOrOptions - Parent AgentRuntime instance or {@link HistoryManagerOptions} object; defaults to `null`
   *
   * @example
   * ```typescript
   * const manager = new HistoryManager({ runtime });
   * ```
   */
  constructor(runtimeOrOptions: unknown = null) {
    this.#emitPort = null;
    const candidate = runtimeOrOptions as HistoryManagerConstructorArg;
    // Options are detected by their own `runtime` key, or their own `emit` key
    // when they do not expose `getAgent` (never by the truthiness of `runtime`),
    // so `{ runtime: null, emit }` still honors the injected port. An object
    // exposing `getAgent` stays a runtime unless it declares its own `runtime` key.
    const isOptionsObject = Boolean(runtimeOrOptions)
      && typeof runtimeOrOptions === 'object'
      && (
        Object.prototype.hasOwnProperty.call(candidate, 'runtime')
        || (Object.prototype.hasOwnProperty.call(candidate, 'emit')
          && typeof candidate.getAgent !== 'function')
      );

    if (isOptionsObject) {
      const runtime = candidate.runtime ? (candidate.runtime as HistoryRuntime) : null;
      this.#runtime = runtime;
      const injectedEmit = candidate.emit;
      this.#emitPort = (injectedEmit && typeof injectedEmit.emit === 'function')
        ? injectedEmit
        : (runtime && typeof runtime.createSubsystemEmitPort === 'function'
          ? runtime.createSubsystemEmitPort()
          : null);
    } else if (runtimeOrOptions && typeof runtimeOrOptions === 'object') {
      const runtime = runtimeOrOptions as HistoryRuntime;
      this.#runtime = runtime;
      if (typeof runtime.createSubsystemEmitPort === 'function') {
        this.#emitPort = runtime.createSubsystemEmitPort();
      }
    } else {
      this.#runtime = null;
    }
  }

  /**
   * Helper to emit runtime events through the injected SubsystemEmitPort.
   * @param event - Event object to broadcast
   */
  #emit(event: object) {
    if (this.#emitPort) {
      try {
        this.#emitPort.emit(event);
      } catch {
        // Emit is best-effort; telemetry failures never propagate into turns.
      }
    }
  }

  /**
   * Computes the range of the turn the default (untargeted) undo would pop,
   * mirroring the sequential pop order exactly: trailing system messages,
   * trailing tool responses, the trailing assistant message with any preceding
   * tool/assistant tool-call chain, then the initiating user message. The root
   * message at index 0 is never included. Internal unexported helper.
   * @param history - Agent history array
   * @returns Start (inclusive) and end (exclusive) indices of the default turn range
   */
  #selectDefaultTurnRange(history: HistoryMessage[]): { start: number; end: number } {
    const end = Array.isArray(history) ? history.length : 0;
    let start = end;
    while (start > 1 && history[start - 1]?.role === 'system') start--;
    while (start > 0 && history[start - 1]?.role === 'tool') start--;
    if (start > 0 && history[start - 1]?.role === 'assistant') {
      start--;
      while (
        start > 0 &&
        (history[start - 1]?.role === 'tool' ||
          (history[start - 1]?.role === 'assistant' && history[start - 1]?.tool_calls))
      ) {
        start--;
      }
    }
    if (start > 0 && history[start - 1]?.role === 'user') start--;
    return { start, end };
  }

  /**
   * Tests whether any message in `[start, end)` carries `targetTurnId` as its
   * `id` or as `metadata.turnId`. Internal unexported helper.
   * @param history - Agent history array
   * @param start - Start index (inclusive)
   * @param end - End index (exclusive)
   * @param targetTurnId - Turn selector to match
   * @returns Whether the range contains the target turn
   */
  #rangeMatchesTurnId(history: HistoryMessage[], start: number, end: number, targetTurnId: string): boolean {
    for (let i = start; i < end; i++) {
      const msg = history[i];
      if (msg && (msg.id === targetTurnId || msg.metadata?.turnId === targetTurnId)) return true;
    }
    return false;
  }

  /**
   * Finds the user-initiated turn segment (from its `user` message up to the
   * next `user` message or the end of history) that contains a message carrying
   * `targetTurnId` and starts before `beforeIndex` (the default turn range).
   * Internal unexported helper.
   * @param history - Agent history array
   * @param beforeIndex - Exclusive upper bound for the segment start
   * @param targetTurnId - Turn selector to match
   * @returns Segment range, or null when no earlier segment matches
   */
  #findHistoryTurnSegment(history: HistoryMessage[], beforeIndex: number, targetTurnId: string): { start: number; end: number } | null {
    let segmentStart = -1;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg?.role === 'user') segmentStart = i;
      if (segmentStart === -1 || segmentStart >= beforeIndex) continue;
      if (msg && (msg.id === targetTurnId || msg.metadata?.turnId === targetTurnId)) {
        let end = i + 1;
        while (end < history.length && history[end]?.role !== 'user') end++;
        return { start: segmentStart, end };
      }
    }
    return null;
  }

  /**
   * Tests whether `targetTurnId` identifies a turn already sitting on
   * `agent.redoStack` (bundle `turnId` or any contained message `id` /
   * `metadata.turnId`). Internal unexported helper.
   * @param agent - Agent state object
   * @param targetTurnId - Turn selector to match
   * @returns Whether the turn is already undone
   */
  #isTurnAlreadyUndone(agent: Agent, targetTurnId: string): boolean {
    const stack = Array.isArray(agent.redoStack) ? agent.redoStack : [];
    for (const bundle of stack) {
      if (!bundle || typeof bundle !== 'object') continue;
      if (bundle.turnId === targetTurnId) return true;
      const candidates = [
        bundle.userMessage,
        ...(Array.isArray(bundle.assistantMessages) ? bundle.assistantMessages : []),
        ...(Array.isArray(bundle.toolMessages) ? bundle.toolMessages : []),
        ...(Array.isArray(bundle.allPoppedMessages) ? bundle.allPoppedMessages : [])
      ];
      for (const msg of candidates) {
        if (msg && (msg.id === targetTurnId || msg.metadata?.turnId === targetTurnId)) return true;
      }
    }
    return false;
  }

  /**
   * Pops an explicitly targeted earlier turn segment in place, pushes its plain
   * TurnBundle (carrying `insertionIndex` for redo), clears interruption state,
   * and emits `turn_undone`. Internal unexported helper; assumes the caller has
   * already validated the segment against history and handled in-flight state.
   * @param agent - Agent state object
   * @param segment - Targeted segment range
   * @param targetTurnId - Resolved turn selector recorded on the bundle
   * @returns Summary of the undone segment
   */
  #undoHistoryTurnSegment(
    agent: Agent,
    segment: { start: number; end: number },
    targetTurnId: string
  ): { undoneUserContent: string | null; undoneAssistantContent: string | null; count: number; restoredPrompt: string } {
    const { start, end } = segment;
    const poppedMessages = agent.history.slice(start, end);
    agent.history.splice(start, end - start);

    const userMessage = poppedMessages.find(m => m && m.role === 'user') || null;
    const assistantMessages = poppedMessages.filter(m => m && m.role === 'assistant');
    const toolMessages = poppedMessages.filter(m => m && m.role === 'tool');
    const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
    const undoneAssistantContent = lastAssistant ? (lastAssistant.content || null) : null;
    const undoneUserContent = userMessage
      ? (typeof userMessage.content === 'string'
        ? userMessage.content
        : (userMessage.content !== undefined ? String(userMessage.content) : null))
      : null;
    const restoredPrompt = undoneUserContent || '';

    let turnDecremented = false;
    if (undoneAssistantContent && agent.turnCount > 0) {
      agent.turnCount--;
      turnDecremented = true;
    }

    agent.lastInterruptedTurn = null;
    agent.lastError = null;
    agent.updatedAt = Date.now();

    const bundle: TurnBundle = {
      turnId: targetTurnId,
      timestamp: Date.now(),
      userPrompt: undoneUserContent,
      userMessage,
      assistantMessages,
      toolMessages,
      allPoppedMessages: poppedMessages,
      finalOutput: undoneAssistantContent || '',
      turnCountDelta: turnDecremented ? 1 : 0,
      restoredPrompt,
      insertionIndex: start
    };
    agent.redoStack.push(bundle);

    if (this.#emitPort) {
      this.#emit({
        type: 'turn_undone',
        agentId: agent.id,
        payload: {
          agentId: agent.id,
          undoneUserContent,
          undoneAssistantContent,
          count: poppedMessages.length,
          restoredPrompt
        }
      });
    }

    return { undoneUserContent, undoneAssistantContent, count: poppedMessages.length, restoredPrompt };
  }

  /**
   * Updates an existing message in agent history in-place (INV-MSG-MUTATION).
   *
   * Operational Contract:
   * 1. Backfills missing, blank, or non-string IDs across the whole history via {@link ensureHistoryMessageIds} (INV-MSG-IDENTITY), which also fills a missing assistant `reasoning_content` from its `reasoning`/`thought` alias or `''`. This in-place mutation runs before selector validation, so even a rejected lookup may have backfilled IDs or `reasoning_content`.
   * 2. Resolves the target by 0-based integer index or by exact string ID (matched after trimming); backfilled IDs are role-prefixed (`<role>_<uuid>`, e.g. `user_<uuid>`, `assistant_<uuid>`, `tool_<uuid>`; `msg_<uuid>` when the message carries no role).
   * 3. Mutates fields: a bare string replaces `content`; an object updates `content` (non-strings coerced with `String(...)`), `reasoning_content` (falling back to `reasoning` only when `reasoning_content` is not supplied), and shallow-merges `metadata` over existing keys.
   * 4. Updates timestamps (`message.updatedAt = Date.now()`, `agent.updatedAt = Date.now()`).
   * 5. Emits `'message_updated'` with `messageIndex`, `messageId`, `message`, and `updatedFields`.
   *
   * Throws before mutating the target message, its timestamps, or emitting on any lookup failure; the only history change a rejected call leaves behind is the step-1 backfill.
   *
   * @param agentId - Unique agent identifier
   * @param messageIndexOrId - 0-based integer index or exact string message ID (e.g. `msg_<uuid>`)
   * @param updatedFields - Replacement string content or {@link MessageUpdateFields} object; omitted object fields are left unchanged
   * @returns The updated {@link HistoryMessage} (the same object stored in `agent.history`)
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is missing or not a string, or if index/ID is neither a number nor a string
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if target agent does not exist in runtime
   * @throws `Error` - With code `'INDEX_OUT_OF_BOUNDS'` if numeric index is out of bounds
   * @throws `Error` - With code `'MESSAGE_NOT_FOUND'` if message ID was not found in history
   *
   * @example
   * ```typescript
   * // Update message content by string ID:
   * const updated = historyManager.updateHistoryMessage('coder', 'msg_123', {
   *   content: 'Refactored function implementation.',
   *   metadata: { editedByUser: true }
   * });
   * ```
   */
  updateHistoryMessage(
    agentId: string,
    messageIndexOrId: number | string,
    updatedFields: string | MessageUpdateFields
  ): HistoryMessage {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("updateHistoryMessage requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${agentId}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    ensureHistoryMessageIds(agent.history);

    let targetIndex: number;
    if (typeof messageIndexOrId === 'number') {
      if (!Number.isInteger(messageIndexOrId) || messageIndexOrId < 0 || messageIndexOrId >= agent.history.length) {
        const err: CodedError = new Error(
          `Message index ${messageIndexOrId} out of bounds for agent '${agentId}' history (length: ${agent.history.length})`
        );
        err.code = 'INDEX_OUT_OF_BOUNDS';
        throw err;
      }
      targetIndex = messageIndexOrId;
    } else if (typeof messageIndexOrId === 'string') {
      const searchId = messageIndexOrId.trim();
      targetIndex = agent.history.findIndex(m => m.id === searchId);
      if (targetIndex === -1) {
        const err: CodedError = new Error(`Message with ID '${messageIndexOrId}' not found in agent '${agentId}' history`);
        err.code = 'MESSAGE_NOT_FOUND';
        throw err;
      }
    } else {
      const err: CodedError = new Error("messageIndexOrId must be an integer index or string ID");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const targetMsg = agent.history[targetIndex];
    if (!targetMsg) {
      const err: CodedError = new Error(`Message not found at index ${targetIndex} for agent '${agentId}'`);
      err.code = 'MESSAGE_NOT_FOUND';
      throw err;
    }

    if (typeof updatedFields === 'string') {
      targetMsg.content = updatedFields;
    } else if (updatedFields && typeof updatedFields === 'object') {
      if (updatedFields.content !== undefined) {
        targetMsg.content = typeof updatedFields.content === 'string' ? updatedFields.content : String(updatedFields.content);
      }
      if (updatedFields.reasoning_content !== undefined) {
        targetMsg.reasoning_content = updatedFields.reasoning_content;
      } else if (updatedFields.reasoning !== undefined) {
        targetMsg.reasoning_content = updatedFields.reasoning;
      }
      if (updatedFields.metadata !== undefined) {
        targetMsg.metadata = {
          ...(targetMsg.metadata || {}),
          ...updatedFields.metadata
        };
      }
    }

    targetMsg.updatedAt = Date.now();
    agent.updatedAt = Date.now();

    if (this.#emitPort) {
      this.#emit({
        type: 'message_updated',
        agentId: agent.id,
        payload: {
          agentId: agent.id,
          messageIndex: targetIndex,
          messageId: targetMsg.id,
          message: targetMsg,
          updatedFields
        }
      });
    }

    return targetMsg;
  }

  /**
   * Deletes a message from agent history with cascading tool-pairing hygiene enforcement (INV-TOOL-HYGIENE).
   *
   * History IDs are backfilled via {@link ensureHistoryMessageIds} before lookup (INV-MSG-IDENTITY), so a miss may still have filled missing IDs or assistant `reasoning_content`.
   *
   * Cascading Hygiene Rules:
   * 1. **Assistant with Tool Calls:** When deleting an assistant message declaring `tool_calls: [...]`:
   *    - Removes target assistant message from history.
   *    - Collects all tool call IDs (`tc.id`, blank IDs excluded).
   *    - Scans the history from the end back to the removed position and cascade-deletes every remaining `role: 'tool'` response whose `tool_call_id` matches one of the collected IDs.
   * 2. **Tool Response Message:** When deleting a tool response message (`role === 'tool'` with `tool_call_id`):
   *    - Removes target tool response from history.
   *    - Scans preceding history backwards for the nearest assistant message declaring that call.
   *    - Prunes the matching entry from `assistantMsg.tool_calls`, refreshes `assistantMsg.updatedAt`; when no declaring message is found only the tool response is removed.
   *    - If `assistantMsg.tool_calls` becomes empty, deletes the property and sets `content` to `''` when it was null/undefined.
   * 3. **Standard Message:** Removes the target system/user message directly.
   *
   * On success, refreshes `agent.updatedAt` and emits `'message_deleted'` carrying `deletedMessageId`, `deletedIndex`, `deletedMessage`, and `cascadedDeletedIds` (cascade victims, if any).
   * A miss returns `false` without emitting; apart from the already-applied backfill, history is unaltered.
   *
   * @param agentId - Unique agent identifier
   * @param messageIndexOrId - 0-based integer index or exact string message ID (e.g. `msg_<uuid>`); non-integer or negative numbers miss
   * @returns `true` if message was found and deleted; `false` if index/ID was not found or the argument type was invalid
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is missing or not a string
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if target agent does not exist in runtime
   *
   * @example
   * ```typescript
   * // Delete an assistant message and cascade-delete its paired tool responses:
   * const deleted = historyManager.deleteHistoryMessage('coder', 'msg_assistant_call_01');
   * if (deleted) {
   *   console.log('Assistant message and paired tool responses cleanly pruned.');
   * }
   * ```
   */
  deleteHistoryMessage(
    agentId: string,
    messageIndexOrId: number | string
  ): boolean {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("deleteHistoryMessage requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${agentId}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    ensureHistoryMessageIds(agent.history);

    let targetIndex: number;
    if (typeof messageIndexOrId === 'number') {
      if (!Number.isInteger(messageIndexOrId) || messageIndexOrId < 0 || messageIndexOrId >= agent.history.length) {
        return false;
      }
      targetIndex = messageIndexOrId;
    } else if (typeof messageIndexOrId === 'string') {
      const searchId = messageIndexOrId.trim();
      targetIndex = agent.history.findIndex(m => m.id === searchId);
      if (targetIndex === -1) {
        return false;
      }
    } else {
      return false;
    }

    const targetMsg = agent.history[targetIndex];
    if (!targetMsg) return false;

    const cascadedDeletedIds: string[] = [];

    // Cascading Tool Pairing Cleanup (INV-TOOL-HYGIENE)
    if (targetMsg.role === 'assistant' && Array.isArray(targetMsg.tool_calls) && targetMsg.tool_calls.length > 0) {
      const toolCallIds = new Set(targetMsg.tool_calls.map(tc => tc.id).filter(Boolean));
      // Remove target assistant message
      agent.history.splice(targetIndex, 1);

      // Purge matching tool response messages immediately following or downstream
      for (let i = agent.history.length - 1; i >= targetIndex; i--) {
        const msg = agent.history[i];
        if (msg && msg.role === 'tool' && msg.tool_call_id && toolCallIds.has(msg.tool_call_id)) {
          cascadedDeletedIds.push(msg.id);
          agent.history.splice(i, 1);
        }
      }
    } else if (targetMsg.role === 'tool' && targetMsg.tool_call_id) {
      const toolCallId = targetMsg.tool_call_id;
      // Remove target tool message
      agent.history.splice(targetIndex, 1);

      // Find the preceding assistant message that declared this tool call and prune it
      for (let i = targetIndex - 1; i >= 0; i--) {
        const msg = agent.history[i];
        if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          const tcIndex = msg.tool_calls.findIndex(tc => tc.id === toolCallId);
          if (tcIndex !== -1) {
            msg.tool_calls.splice(tcIndex, 1);
            if (msg.tool_calls.length === 0) {
              delete msg.tool_calls;
              if (msg.content === null || msg.content === undefined) {
                msg.content = '';
              }
            }
            msg.updatedAt = Date.now();
            break;
          }
        }
      }
    } else {
      agent.history.splice(targetIndex, 1);
    }

    agent.updatedAt = Date.now();

    if (this.#emitPort) {
      this.#emit({
        type: 'message_deleted',
        agentId: agent.id,
        payload: {
          agentId: agent.id,
          deletedIndex: targetIndex,
          deletedMessageId: targetMsg.id,
          deletedMessage: targetMsg,
          cascadedDeletedIds
        }
      });
    }

    return true;
  }

  /**
   * Undoes a turn for an agent, cleanly popping turn messages and constructing a TurnBundle (INV-UNDO-BUNDLE).
   *
   * Target selection (step 0, before any mutation):
   * - An explicit non-blank `targetTurnId` resolves the turn by matching a message `id` or a message `metadata.turnId`.
   * - A target inside the default (most recent) pop range follows the untargeted operational flow below, and its value names the assembled bundle's `turnId`.
   * - A target inside an earlier user-initiated segment (a `user` message up to the next `user` message) pops exactly that segment in place and records its original position as `insertionIndex` on the bundle so redo restores order.
   * - A target carried by any `agent.redoStack` bundle (`turnId` or contained message `id` / `metadata.turnId`) returns {@link UndoTurnSelectionFailure} with reason `'TURN_ALREADY_UNDONE'`.
   * - Any other target value — including a non-string — returns {@link UndoTurnSelectionFailure} with reason `'TURN_NOT_FOUND'`.
   * - Failures leave the agent completely untouched: no cancellation, no history or redo-stack change, no event.
   * - Blank values (`''`, whitespace-only) behave as "no target"; `null`/`undefined` select the most recent turn.
   *
   * Operational Flow (no target, or a target naming the most recent turn):
   * 1. In-flight handling: for `running`, `waiting_for_input`, `waiting_for_dependents`, `waiting_for_message`, or `canceling` state, calls `runtime.cancelAgent` (when available), aborts `agent.abortController`, clears `currentStream`/`currentReasoning`/`activeToolCalls`, and transitions the agent to `idle` via `runtime.setAgentState`, then `runtime.transitionAgentState`, then a direct state write.
   * 2. Empty-history short circuit: recovers the prompt from `agent.lastInterruptedTurn.input` (string or `.content`), clears that field, and returns `count: 0`. When a prompt was recovered, a message-less {@link TurnBundle} (`allPoppedMessages: []`, `turnCountDelta: 0`, `userMessage: null`) is pushed so the prompt is redoable, `agent.lastError` is cleared, `agent.updatedAt` is refreshed, and `'turn_undone'` is emitted; with no recoverable prompt nothing is pushed or emitted and `agent.lastError`/`agent.updatedAt` are left untouched.
   * 3. Otherwise pops messages in reverse chronological order:
   *    - Trailing system messages (the root message at index 0 is preserved).
   *    - Trailing `tool` responses.
   *    - A trailing `assistant` message, then any preceding `tool` or `assistant`-with-`tool_calls` messages from the same turn.
   *    - The initiating `user` prompt, when it is the new tail.
   * 4. Resolves `undoneUserContent` from the popped user message, falling back to `agent.lastInterruptedTurn.input`; `restoredPrompt` is that content or `''`.
   * 5. Decrements `agent.turnCount` at most once, only when a popped assistant message had non-empty content and the current count was positive.
   * 6. Pushes a plain (not frozen) {@link TurnBundle} onto `agent.redoStack` when messages were popped or a prompt was recovered; `turnId` is the resolved target when present, otherwise `generateMessageId('turn')`, and `turnCountDelta` is `1` only when step 5 actually decremented the count, otherwise `0` (redo never inflates a count that undo did not decrement).
   * 7. Clears `agent.lastInterruptedTurn` and `agent.lastError`, refreshes `agent.updatedAt`, and emits `'turn_undone'` with `undoneUserContent`, `undoneAssistantContent`, `count`, and `restoredPrompt`.
   *
   * @param agentId - Unique agent identifier
   * @param targetTurnId - Optional turn selector matched against message `id` / `metadata.turnId`; `null`, `undefined`, or blank selects the most recent turn, an unknown selector fails with `TURN_NOT_FOUND`, and an undo-stack selector fails with `TURN_ALREADY_UNDONE`
   * @returns {@link UndoTurnResult} containing undone user content, assistant output, count, and restored prompt, or {@link UndoTurnSelectionFailure} when an explicit target cannot be selected
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is missing or not a string
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if target agent does not exist in runtime
   *
   * @example
   * ```typescript
   * const { undoneUserContent, restoredPrompt, count } = historyManager.undoAgentTurn('coder');
   * console.log(`Undone prompt "${restoredPrompt}" across ${count} messages.`);
   * ```
   */
  undoAgentTurn(
    agentId: string,
    targetTurnId: string | null = null
  ): UndoTurnResult | UndoTurnSelectionFailure {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("undoAgentTurn requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${agentId}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    // 0. Resolve an explicit target turn before any mutation so a failed
    //    selection is side-effect free (no cancellation, no history change).
    let target: string | null = null;
    let targetedSegment: { start: number; end: number } | null = null;
    if (targetTurnId !== null && targetTurnId !== undefined) {
      if (typeof targetTurnId !== 'string') {
        return { success: false, reason: 'TURN_NOT_FOUND', targetTurnId: String(targetTurnId) };
      }
      target = targetTurnId.trim();
      if (!target) {
        target = null;
      } else {
        const history = Array.isArray(agent.history) ? agent.history : [];
        const defaultRange = this.#selectDefaultTurnRange(history);
        if (!this.#rangeMatchesTurnId(history, defaultRange.start, defaultRange.end, target)) {
          targetedSegment = this.#findHistoryTurnSegment(history, defaultRange.start, target);
          if (!targetedSegment) {
            const reason = this.#isTurnAlreadyUndone(agent, target) ? 'TURN_ALREADY_UNDONE' : 'TURN_NOT_FOUND';
            return { success: false, reason, targetTurnId: target };
          }
        }
      }
    }

    if (!Array.isArray(agent.redoStack)) {
      agent.redoStack = [];
    }

    // 1. If turn is currently in-flight, cancel it immediately
    if (
      agent.state === 'running' ||
      agent.state === 'waiting_for_input' ||
      agent.state === 'waiting_for_dependents' ||
      agent.state === 'waiting_for_message' ||
      agent.state === 'canceling'
    ) {
      if (runtime && typeof runtime.cancelAgent === 'function') {
        runtime.cancelAgent(agentId, 'Turn undone by user');
      }
      try {
        agent.abortController?.abort('Turn undone by user');
      } catch {
        // Abort is best-effort; stream state is cleared unconditionally below.
      }
      agent.currentStream = '';
      agent.currentReasoning = '';
      agent.activeToolCalls = [];
      if (runtime && typeof runtime.setAgentState === 'function') {
        runtime.setAgentState(agent, 'idle', 'Turn undone');
      } else if (runtime && typeof runtime.transitionAgentState === 'function') {
        runtime.transitionAgentState(agent, 'idle', 'Turn undone');
      } else {
        agent.state = 'idle';
      }
    }

    // Targeted earlier turn: pop exactly that segment and record its original
    // position so redo restores history order.
    if (targetedSegment && target) {
      return this.#undoHistoryTurnSegment(agent, targetedSegment, target);
    }

    if (!Array.isArray(agent.history) || agent.history.length === 0) {
      let undoneUser: string | null = null;
      if (agent.lastInterruptedTurn?.input) {
        const interruptedInput = agent.lastInterruptedTurn.input;
        if (typeof interruptedInput === 'string') {
          undoneUser = interruptedInput;
        } else {
          const content = inputContent(interruptedInput);
          undoneUser = content ? String(content) : null;
        }
      }
      agent.lastInterruptedTurn = null;
      const restoredPrompt = undoneUser || '';

      if (!restoredPrompt) {
        return { undoneUserContent: undoneUser, undoneAssistantContent: null, count: 0, restoredPrompt };
      }

      // Recovered prompt: push a message-less bundle and emit so the recovery is
      // redoable through the same redoStack protocol as the general path.
      agent.lastError = null;
      agent.updatedAt = Date.now();
      const recoveryBundle: TurnBundle = {
        turnId: target || generateMessageId('turn'),
        timestamp: Date.now(),
        userPrompt: undoneUser,
        userMessage: null,
        assistantMessages: [],
        toolMessages: [],
        allPoppedMessages: [],
        finalOutput: '',
        turnCountDelta: 0,
        restoredPrompt
      };
      agent.redoStack.push(recoveryBundle);

      if (this.#emitPort) {
        this.#emit({
          type: 'turn_undone',
          agentId: agent.id,
          payload: {
            agentId: agent.id,
            undoneUserContent: undoneUser,
            undoneAssistantContent: null,
            count: 0,
            restoredPrompt
          }
        });
      }

      return { undoneUserContent: undoneUser, undoneAssistantContent: null, count: 0, restoredPrompt };
    }

    const poppedReverse: HistoryMessage[] = [];
    let undoneAssistantContent: string | null = null;
    let undoneUserContent: string | null = null;
    let poppedUserMessage: HistoryMessage | null = null;
    const poppedAssistantMessages: HistoryMessage[] = [];
    const poppedToolMessages: HistoryMessage[] = [];

    // Pop any trailing system messages while preserving root identity directive at index 0
    while (agent.history.length > 1 && agent.history[agent.history.length - 1].role === 'system') {
      const msg = agent.history.pop();
      if (msg) poppedReverse.push(msg);
    }

    // If tail is tool messages (from an interrupted tool call sequence), pop them
    while (agent.history.length > 0 && agent.history[agent.history.length - 1].role === 'tool') {
      const msg = agent.history.pop();
      if (msg) {
        poppedReverse.push(msg);
        poppedToolMessages.unshift(msg);
      }
    }

    // If tail is assistant message, pop assistant (and any associated preceding tool calls/responses from same turn)
    if (agent.history.length > 0 && agent.history[agent.history.length - 1].role === 'assistant') {
      const popped = agent.history.pop();
      if (popped) {
        poppedReverse.push(popped);
        poppedAssistantMessages.unshift(popped);
        undoneAssistantContent = popped.content || null;
      }

      // Pop any tool calls preceding this assistant message if part of the same turn
      while (
        agent.history.length > 0 &&
        (agent.history[agent.history.length - 1].role === 'tool' ||
         (agent.history[agent.history.length - 1].role === 'assistant' && agent.history[agent.history.length - 1].tool_calls))
      ) {
        const prevMsg = agent.history.pop();
        if (prevMsg) {
          poppedReverse.push(prevMsg);
          if (prevMsg.role === 'tool') {
            poppedToolMessages.unshift(prevMsg);
          } else if (prevMsg.role === 'assistant') {
            poppedAssistantMessages.unshift(prevMsg);
          }
        }
      }
    }

    // If tail is now user message (either standalone interrupted turn or the prompt of the turn)
    if (agent.history.length > 0 && agent.history[agent.history.length - 1].role === 'user') {
      const userMsg = agent.history.pop();
      if (userMsg) {
        poppedReverse.push(userMsg);
        poppedUserMessage = userMsg;
        undoneUserContent = typeof userMsg.content === 'string'
          ? userMsg.content
          : (userMsg.content !== undefined ? String(userMsg.content) : null);
      }
    }

    // If undoneUserContent is still null, fallback to lastInterruptedTurn.input
    if (!undoneUserContent && agent.lastInterruptedTurn?.input) {
      const interruptedInput = agent.lastInterruptedTurn.input;
      undoneUserContent = typeof interruptedInput === 'string'
        ? interruptedInput
        : stringifyContent(inputContent(interruptedInput));
    }

    const restoredPrompt = undoneUserContent || (poppedUserMessage?.content !== undefined ? String(poppedUserMessage.content) : '');
    const count = poppedReverse.length;
    let turnDecremented = false;

    if (undoneAssistantContent && agent.turnCount > 0) {
      agent.turnCount--;
      turnDecremented = true;
    }

    agent.lastInterruptedTurn = null;
    agent.lastError = null;
    agent.updatedAt = Date.now();

    // Construct TurnBundle and push onto agent.redoStack
    if (count > 0 || restoredPrompt) {
      const allPoppedMessages = [...poppedReverse].reverse();
      const turnBundle: TurnBundle = {
        turnId: target || generateMessageId('turn'),
        timestamp: Date.now(),
        userPrompt: undoneUserContent,
        userMessage: poppedUserMessage,
        assistantMessages: poppedAssistantMessages,
        toolMessages: poppedToolMessages,
        allPoppedMessages,
        finalOutput: undoneAssistantContent || '',
        turnCountDelta: turnDecremented ? 1 : 0,
        restoredPrompt
      };
      agent.redoStack.push(turnBundle);
    }

    if (this.#emitPort) {
      this.#emit({
        type: 'turn_undone',
        agentId: agent.id,
        payload: {
          agentId: agent.id,
          undoneUserContent,
          undoneAssistantContent,
          count,
          restoredPrompt
        }
      });
    }

    return { undoneUserContent, undoneAssistantContent, count, restoredPrompt };
  }

  /**
   * Redoes the most recently undone turn for an agent from `agent.redoStack` (INV-UNDO-BUNDLE).
   *
   * Operational Flow:
   * 1. Pops the most recent {@link TurnBundle} from `agent.redoStack`.
   * 2. If the stack is missing, empty, or yields no bundle, returns `{ success: false, reason: 'EMPTY_REDO_STACK' }` without mutating the agent.
   * 3. Restores `turnBundle.allPoppedMessages` into `agent.history` in exact chronological sequence, appended at the tail for conventional bundles or inserted at the bundle's numeric `insertionIndex` (clamped to the current length) when a targeted undo removed an earlier turn; when that array is empty it falls back to restoring `userMessage`, then `assistantMessages`, then `toolMessages` at the same position.
   * 4. Adds `turnBundle.turnCountDelta` to `agent.turnCount` when it is a positive number (a missing count is treated as `0`).
   * 5. Clears `agent.lastError`, refreshes `agent.updatedAt`, and emits `'turn_redone'` with `restoredPrompt` and the updated `turnCount`.
   *
   * @param agentId - Unique agent identifier
   * @returns {@link RedoTurnResult}; on success `restoredPrompt` (possibly `''`) and the updated `turnCount`, on failure only `success: false` and `reason`
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is missing or not a string
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if target agent does not exist in runtime
   *
   * @example
   * ```typescript
   * const result = historyManager.redoAgentTurn('coder');
   * if (result.success) {
   *   console.log(`Redone turn. Turn count is now ${result.turnCount}.`);
   * }
   * ```
   */
  redoAgentTurn(agentId: string): RedoTurnResult {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("redoAgentTurn requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${agentId}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    if (!Array.isArray(agent.redoStack) || agent.redoStack.length === 0) {
      return { success: false, reason: 'EMPTY_REDO_STACK' };
    }

    const turnBundle = agent.redoStack.pop();
    if (!turnBundle) {
      return { success: false, reason: 'EMPTY_REDO_STACK' };
    }

    if (!Array.isArray(agent.history)) {
      agent.history = [];
    }

    const restoredMessages: HistoryMessage[] = [];
    if (Array.isArray(turnBundle.allPoppedMessages) && turnBundle.allPoppedMessages.length > 0) {
      restoredMessages.push(...turnBundle.allPoppedMessages);
    } else {
      if (turnBundle.userMessage) {
        restoredMessages.push(turnBundle.userMessage);
      }
      if (Array.isArray(turnBundle.assistantMessages)) {
        restoredMessages.push(...turnBundle.assistantMessages);
      }
      if (Array.isArray(turnBundle.toolMessages)) {
        restoredMessages.push(...turnBundle.toolMessages);
      }
    }

    // A targeted undo of an earlier turn records its original position; restore
    // it there so redo cannot reorder history. Untargeted/legacy bundles append.
    const insertionIndex = typeof turnBundle.insertionIndex === 'number'
      && Number.isInteger(turnBundle.insertionIndex)
      && turnBundle.insertionIndex >= 0
      ? Math.min(turnBundle.insertionIndex, agent.history.length)
      : agent.history.length;
    agent.history.splice(insertionIndex, 0, ...restoredMessages);

    if (typeof turnBundle.turnCountDelta === 'number' && turnBundle.turnCountDelta > 0) {
      agent.turnCount = (agent.turnCount || 0) + turnBundle.turnCountDelta;
    }

    agent.lastError = null;
    agent.updatedAt = Date.now();

    if (this.#emitPort) {
      this.#emit({
        type: 'turn_redone',
        agentId: agent.id,
        payload: {
          agentId: agent.id,
          restoredPrompt: turnBundle.restoredPrompt || '',
          turnCount: agent.turnCount
        }
      });
    }

    return {
      success: true,
      restoredPrompt: turnBundle.restoredPrompt || '',
      turnCount: agent.turnCount
    };
  }

  /**
   * Retries / resends the most recent turn for an agent with mid-turn error recovery (INV-HISTORY-PRESERVE).
   *
   * Preflight:
   * - For `running`, `waiting_for_input`, `waiting_for_dependents`, or `waiting_for_message` state, calls `runtime.cancelAgent` and waits ~50 ms before continuing; `canceling` is not treated as in-flight here.
   * - Clears `agent.lastError` before re-attempting.
   *
   * Context Recovery Rules:
   * - **Empty history:** re-executes with `agent.lastInterruptedTurn.input` and its `mode` when present, otherwise calls `executeAgentTurn(agentId)` with no explicit input.
   * - **Case 1 (Tail is User Message):** Pops the trailing unresponded user message and re-executes the turn with its `content`.
   * - **Case 2 (Tail is Tool Message or Assistant with Tool Calls):** Resumes LLM completion directly against existing in-progress history via `executeAgentTurn(agentId, null)` without re-injecting a duplicate user prompt.
   * - **Case 3 (Tail is Assistant Message):** Calls `undoAgentTurn` and, when it recovers a prompt, re-executes with that prompt; otherwise falls through.
   * - **Case 4 (Interrupted turn):** Re-executes with `agent.lastInterruptedTurn.input`, passing `{ mode }` when set.
   * - **Fallback:** `executeAgentTurn(agentId)` with no explicit input, allowing pending mailbox/events to be processed.
   *
   * @param agentId - Unique agent identifier
   * @returns A promise resolving to the `runtime.executeAgentTurn` result for the retried turn; retry never synthesizes a receipt of its own
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is missing or not a string
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if the runtime or target agent is unavailable
   *
   * @example
   * ```typescript
   * // Retry turn after a transient tool network error:
   * await historyManager.retryAgentTurn('coder');
   * ```
   */
  async retryAgentTurn(agentId: string): Promise<unknown> {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("retryAgentTurn requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!runtime || !agent) {
      const err: CodedError = new Error(`Agent '${agentId}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    // 1. If currently in-flight, cancel first
    if (
      agent.state === 'running' ||
      agent.state === 'waiting_for_input' ||
      agent.state === 'waiting_for_dependents' ||
      agent.state === 'waiting_for_message'
    ) {
      if (typeof runtime.cancelAgent === 'function') {
        runtime.cancelAgent(agentId, 'Turn retried by user');
      }
      await new Promise(r => setTimeout(r, 50));
    }

    // Clear lastError before re-attempting
    agent.lastError = null;

    if (!Array.isArray(agent.history) || agent.history.length === 0) {
      if (agent.lastInterruptedTurn?.input) {
        const input = agent.lastInterruptedTurn.input;
        const mode = agent.lastInterruptedTurn.mode;
        agent.lastInterruptedTurn = null;
        return dispatchRetryTurn(runtime, agentId, input, mode ? { mode } : {});
      }
      return dispatchRetryTurn(runtime, agentId);
    }

    const lastMsg = agent.history[agent.history.length - 1];

    // Case 1: Tail is user message (unresponded / interrupted at start)
    if (lastMsg && lastMsg.role === 'user') {
      agent.history.pop();
      agent.lastInterruptedTurn = null;
      return dispatchRetryTurn(runtime, agentId, lastMsg.content);
    }

    // Case 2: Tail is tool message or assistant message with tool_calls (failed mid-turn after tool executions)
    // Resume LLM completion with existing history without re-injecting duplicate user messages (INV-HISTORY-PRESERVE)
    if (lastMsg && (lastMsg.role === 'tool' || (lastMsg.role === 'assistant' && lastMsg.tool_calls))) {
      agent.lastInterruptedTurn = null;
      return dispatchRetryTurn(runtime, agentId, null);
    }

    // Case 3: Tail is assistant message (completed turn or prose before error)
    if (lastMsg && lastMsg.role === 'assistant') {
      const undoResult = this.undoAgentTurn(agentId);
      const undoneUserContent = 'reason' in undoResult ? null : undoResult.undoneUserContent;
      if (undoneUserContent) {
        return dispatchRetryTurn(runtime, agentId, undoneUserContent);
      }
    }

    // Case 4: If lastInterruptedTurn has input
    if (agent.lastInterruptedTurn?.input) {
      const input = agent.lastInterruptedTurn.input;
      const mode = agent.lastInterruptedTurn.mode;
      agent.lastInterruptedTurn = null;
      return dispatchRetryTurn(runtime, agentId, input, mode ? { mode } : {});
    }

    // Fallback: execute turn with null input (processes pending mailbox/events or continues)
    return dispatchRetryTurn(runtime, agentId);
  }

  /**
   * Checks if an agent has an unfinished turn awaiting retry or resolution.
   *
   * Checks run in order: an unknown agent or missing runtime returns `false`; a `running`
   * agent returns `false`; a set `agent.lastInterruptedTurn` returns `true`; a last history
   * message carrying `metadata.terminalSummary` or `metadata.summary` marks the turn
   * resolved and returns `false`; a trailing `user` or `tool` message returns `true`.
   * Anything else, including a completed turn ending in an `assistant` message, returns
   * `false` — even when that assistant message declares `tool_calls`.
   *
   * Performs no agentId validation and never throws: an unknown, missing, or malformed
   * agent ID simply returns `false`.
   *
   * @param agentId - Unique agent identifier
   * @returns `true` if the turn is interrupted or ends in an unresponded `user`/`tool` message; `false` otherwise
   *
   * @example
   * ```typescript
   * if (historyManager.isAgentInterrupted('coder')) {
   *   console.log('Agent has an unfinished turn awaiting retry or resolution.');
   * }
   * ```
   */
  isAgentInterrupted(agentId: string): boolean {
    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!agent) return false;
    if (agent.state === 'running') return false;
    if (agent.lastInterruptedTurn) return true;
    if (Array.isArray(agent.history) && agent.history.length > 0) {
      const lastMsg = agent.history[agent.history.length - 1];
      if (lastMsg?.metadata?.terminalSummary || lastMsg?.metadata?.summary) {
        return false;
      }
      if (lastMsg?.role === 'user' || lastMsg?.role === 'tool') {
        return true;
      }
    }
    return false;
  }
}
