/**
 * @packageDocumentation
 * Canonical Type Definitions for the Trigger Dispatcher Subsystem.
 *
 * Architectural Layer: Layer 2 (Runtime Coordination, Event Scheduling & Trigger Dispatch Subsystem)
 * @module runtime/triggerDispatcher
 * @mayImport type-only ../runtimeScheduler/index.ts
 * @mayImport type-only ../index.ts
 * @invariant Pure DI leaf: zero runtime imports; `runtime`, `messagingBus`, `triggerQueue`, and `invocationEngine` enter only through constructor injection, and only host globals (`setTimeout`, `console`) are referenced.
 * @invariant Single dispatch point: all activations (mail, schedule alarms, user turns, subagent invocations) are enqueued on `TriggerQueue` and unpacked by `dispatchTrigger`; user turns cover store chat submissions, history retry/resends, and launch initial prompts, all entering through `enqueueUserTurn`. A direct `executeAgentTurn` call remains only as the documented no-`TriggerQueue` fallback of `enqueueUserTurn` and `executeTurnForInvocation` on hosts that inject no queue.
 * @invariant Strict Layer 2 boundary (zero subagent RPC trampolining): `TriggerDispatcher` is strictly an event router and trigger translation substrate; legacy trampoline methods (`invokeAgent`, `waitForInvocation`, `waitForMail`) do not exist.
 * @invariant Feedback-loop prevention: the mail subscription drops scheduler timer envelopes before enqueueing — `msg.from === 'system:scheduler'`, `msg.type === 'scheduled_timer'`, or `msg.metadata.category === 'scheduled_timer'`.
 * @invariant Mail wake debounce timers (10 ms) call `.unref()` on their handles when available, so a pending mail wake never hangs the Node.js process.
 * @invariant `dispatchTrigger` resolves `true` for both dispatched and skipped triggers — unknown/terminated agent, zero unread mail, stale envelope id, or unknown type — and no path resolves `false`.
 * @invariant Mail wake synthesis: unread mail yields a `[MAIL NOTIFICATION] …` prompt and calls `runtime.executeAgentTurn(agentId, prompt, { triggerType: 'mail', autoTrigger: true })`; zero unread mail resolves `true` without a model turn.
 * @invariant Non-blocking invocation bridge: `executeTurnForInvocation` enqueues an `INVOCATION` closure on `TriggerQueue` and settles the caller's promise from inside the queued execution without blocking host queue ticks.
 * @invariant Canonical trigger enumeration: `TRIGGER_TYPES` and `TriggerType` are declared in this module, and `runtimeScheduler`/`triggerQueue` re-export this single frozen object rather than declaring their own.
 * @invariant Canonical trigger addressing: the mail subscription registers on the agent's opaque registration identifier (the canonical `(realmId, agentId)` key under wiring), so its filter matches the delivered mailbox partition and the wake trigger partitions per registration; queued targets are dispatch references (canonical keys), never agent-facing labels. `executeTurnForInvocation` forwards a trusted `sourceKey` when the display source is a bare id, so the queue's realm gate resolves the sender realm-exactly.
 * @decision Mail auto-trigger reads unread mail through `MessagingBusHost.listInbox`/`getUnreadCount`; the dead duck-typed `getInbox`/`activeQueues` fallback was removed
 */

/**
 * Trigger Dispatcher & Inbound Event Routing Subsystem (Layer 2).
 *
 * Integrates reactive `TriggerQueue` handling, mail subscriptions, and
 * non-blocking invocation turns.
 */

import type {
  AgentRuntimeHost,
  MessagingBusHost,
  TriggerQueueHost,
  InvocationEngineHost
} from '../runtimeScheduler/index.ts';
import type { TurnInput } from '../index.ts';

/**
 * Canonical trigger categories supported by the sandbox trigger substrate.
 * This is the single declaration site: `runtimeScheduler` and `triggerQueue` re-export
 * this frozen object instead of duplicating it.
 *
 * - `MAIL`: Incoming asynchronous messages delivered via `MessagingBus`.
 * - `INVOCATION`: Delegated subagent execution turns dispatched via `InvocationEngine`.
 * - `SCHEDULE`: Time-deferred one-shot alarms from `RuntimeScheduler`.
 * - `USER`: Direct interactive user turns submitted via chat or UI gateways.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { TRIGGER_TYPES } from './triggerDispatcher/index.ts';
 *
 * triggerQueue.enqueue({
 *   type: TRIGGER_TYPES.MAIL,
 *   targetAgentId: 'agent-alice',
 *   source: 'agent-bob',
 *   payload: { content: 'Chapter review complete' }
 * });
 * ```
 */
export const TRIGGER_TYPES: Readonly<{
  readonly MAIL: 'mail';
  readonly INVOCATION: 'invocation';
  readonly SCHEDULE: 'schedule';
  readonly USER: 'user';
}> = Object.freeze({
  MAIL: 'mail',
  INVOCATION: 'invocation',
  SCHEDULE: 'schedule',
  USER: 'user'
});

/**
 * Type alias representing valid canonical trigger type strings.
 */
export type TriggerType = typeof TRIGGER_TYPES[keyof typeof TRIGGER_TYPES];

/**
 * Configuration options for initializing `TriggerDispatcher`.
 *
 * @example
 * ```typescript
 * const dispatcher = new TriggerDispatcher({
 *   runtime: agentRuntimeInstance,
 *   messagingBus: messagingBusInstance,
 *   triggerQueue: triggerQueueInstance,
 *   invocationEngine: invocationEngineInstance
 * });
 * ```
 */
export interface TriggerDispatcherOptions {
  /** Host AgentRuntime instance for agent lookup, termination checks, and isolated turn execution; omitted or `null` disables turn dispatch */
  readonly runtime?: AgentRuntimeHost | null;
  /** Shared MessagingBus instance for mailbox inspection and mail subscriptions; omitted or `null` disables mail wake routing */
  readonly messagingBus?: MessagingBusHost | null;
  /** Centralized non-blocking TriggerQueue coordinating anti-HoL activation; omitted or `null` makes invocation turns execute directly */
  readonly triggerQueue?: TriggerQueueHost | null;
  /** InvocationEngine instance accepted for injection parity; not consulted by the dispatcher — invocation turns route through `triggerQueue` and `runtime` */
  readonly invocationEngine?: InvocationEngineHost | null;
}

/**
 * Duck-typed view of the optional trigger payload read by `dispatchTrigger`.
 *
 * `TriggerQueueHost` carries payloads as `unknown`, while `dispatchTrigger` documents a
 * small set of optional keys per trigger type. This interface is the single decode
 * boundary for that opaque input: property reads stay duck-typed exactly as before the
 * typing pass (missing keys and reads on primitive payloads yield `undefined`), and no
 * value is validated, coerced, or copied.
 */
interface TriggerPayloadView {
  readonly id?: unknown;
  readonly messageId?: unknown;
  readonly prompt?: unknown;
  readonly input?: unknown;
  readonly options?: Record<string, unknown>;
  readonly timerId?: unknown;
  readonly execute?: (...args: unknown[]) => unknown;
}

/**
 * Resolves a prompt-bearing payload value exactly as the untranslated duck-typed
 * implementation did: the named key when present, otherwise the raw payload itself.
 * The `TurnInput` return matches the prompt parameter of the host
 * `AgentRuntimeHost.executeAgentTurn`; the value is forwarded without validation or
 * coercion, so no runtime semantics change. The type assertion reflects the
 * trigger-payload contract (string, structured object, message array, or
 * `null`/`undefined` on prompt-bearing paths), not a runtime check.
 */
function resolvePayloadPrompt(field: unknown, payload: unknown): TurnInput {
  return (field !== undefined ? field : payload) as TurnInput;
}

/**
 * TriggerDispatcher
 *
 * Centralized translation and dispatch coordinator bridging abstract `TriggerQueue` items
 * to concrete isolated execution turns on `AgentRuntime` / `TurnExecutionEngine`.
 *
 * Architectural Responsibilities:
 * - **Reactive Mail Subscriptions:** Listens to `MessagingBus` incoming envelopes and schedules queue triggers.
 * - **Notification Synthesis:** Unpacks triggers and constructs standardized notification prompts.
 * - **Trigger Execution:** Translates `MAIL`, `SCHEDULE`, `USER`, and `INVOCATION` items into `runtime.executeAgentTurn()` calls (or awaited invocation closures).
 * - **Non-Blocking Invocations:** Bridges subagent turn execution across `TriggerQueue`.
 *
 * @example
 * ```typescript
 * import { TriggerDispatcher } from './triggerDispatcher/index.ts';
 * import { TriggerQueue } from '../triggerQueue/index.ts';
 *
 * let dispatcher: TriggerDispatcher;
 * const triggerQueue = new TriggerQueue({
 *   dispatchAction: async (trigger) => dispatcher.dispatchTrigger(trigger),
 *   isAgentBusy: (agentId) => agentRuntime.isAgentBusy(agentId)
 * });
 *
 * dispatcher = new TriggerDispatcher({
 *   runtime: agentRuntime,
 *   messagingBus: messagingBus,
 *   triggerQueue: triggerQueue,
 *   invocationEngine: invocationEngine
 * });
 * ```
 */
export class TriggerDispatcher {
  #runtime: AgentRuntimeHost | null;
  #messagingBus: MessagingBusHost | null;
  #triggerQueue: TriggerQueueHost | null;

  /**
   * Initializes a new `TriggerDispatcher` instance.
   *
   * @param options - Subsystem dependencies and configuration options. Defaults to `{}`.
   */
  constructor({ runtime = null, messagingBus = null, triggerQueue = null }: TriggerDispatcherOptions = {}) {
    this.#runtime = runtime;
    this.#messagingBus = messagingBus;
    this.#triggerQueue = triggerQueue;
  }

  /**
   * Subscribes to incoming mail for a registration on `MessagingBus` and routes accepted envelopes
   * into `TriggerQueue` as `TRIGGER_TYPES.MAIL` triggers after a per-envelope 10 ms wake delay.
   *
   * Scheduler timer envelopes are dropped before enqueueing to prevent feedback loops:
   * `msg.type === 'scheduled_timer'`, `msg.from === 'system:scheduler'`, or
   * `msg.metadata.category === 'scheduled_timer'`. Falsy messages are ignored, and an envelope
   * whose delayed wake fires for a registration reported terminated by `runtime.isAgentTerminated` is
   * dropped without enqueueing.
   *
   * The queued trigger carries `source: msg.from || 'unknown'` and `payload: msg`; `TriggerQueue`
   * assigns the trigger id. Timer handles call `.unref()` when available so a pending mail wake
   * never holds the Node.js event loop open.
   *
   * Canonical keying (Wave I, ticket d57cbc1): `agentKey` is the opaque
   * registration identifier the bus partitions on (the canonical
   * `(realmId, agentId)` key under wiring), so the subscription filter matches
   * the delivered mailbox key exactly and two Realms' same-id agents never
   * share a subscription or a wake queue. The envelope's bare `from` stays the
   * display source; the queue resolves the sender scope from it.
   *
   * @param agentKey - Opaque registration identifier (canonical identity key).
   * @returns Unsubscribe cleanup function; returns a no-op function when no `messagingBus` is
   * injected or it exposes no `subscribe` method.
   *
   * @example
   * ```typescript
   * // Lifecycle subscription wiring when agent starts:
   * const unsubscribeMail = dispatcher.setupAgentMailSubscription('agent-writer');
   *
   * // On agent termination:
   * unsubscribeMail();
   * ```
   */
  setupAgentMailSubscription(agentKey: string): () => void {
    if (!this.#messagingBus || typeof this.#messagingBus.subscribe !== 'function') {
      return () => {};
    }
    return this.#messagingBus.subscribe(agentKey, (msg) => {
      if (!msg) return;
      if (msg.type === 'scheduled_timer' || msg.from === 'system:scheduler' || msg.metadata?.category === 'scheduled_timer') {
        return; // Handled directly via schedule trigger
      }
      const timerHandle: ReturnType<typeof setTimeout> & { unref?: () => void } = setTimeout(() => {
        if (this.#runtime && typeof this.#runtime.isAgentTerminated === 'function' && this.#runtime.isAgentTerminated(agentKey)) {
          return;
        }
        this.#triggerQueue?.enqueue({
          type: TRIGGER_TYPES.MAIL,
          targetAgentId: agentKey,
          source: msg.from || 'unknown',
          payload: msg
        });
      }, 10);
      if (timerHandle && typeof timerHandle.unref === 'function') {
        timerHandle.unref();
      }
    });
  }

  /**
   * Concrete implementation of `TriggerQueue.dispatchAction`.
   * Unpacks typed trigger objects (`mail`, `schedule`, `user`, `invocation`) and executes agent turns.
   *
   * Every path resolves `true`; `false` is never returned. A trigger is skipped, with no turn
   * and no throw, when it is falsy, has no `targetAgentId`, targets an agent unknown to
   * `runtime.getAgent` or reported terminated, or has an unrecognized type. Turn-based types
   * are also skipped when no `runtime` with `executeAgentTurn` was injected. Errors thrown by
   * `runtime.executeAgentTurn` or an invocation closure are caught and logged with
   * `console.error`, so a failed turn still resolves `true`.
   *
   * Processing Logic per Trigger Type:
   * - **`MAIL`**: Reads unread mail through `messagingBus.listInbox` / `messagingBus.getUnreadCount`.
   *   Zero unread mail skips the turn. A bus that exposes `getUnreadCount` without `listInbox` has no
   *   readable unread headers, so the turn is skipped even when the count is non-zero; the synthesized
   *   prompt cannot be built from a count alone. When `payload.id` or `payload.messageId` is set, the
   *   turn is skipped unless that envelope is still present in the unread list. The synthesized prompt is
   *   `"[MAIL NOTIFICATION] 1 unread message from '<sender>' (ID: '<id>')."` for a single message, or
   *   `"[MAIL NOTIFICATION] N unread messages from ['<a>', '<b>']."` for several, and is executed with
   *   `{ triggerType: 'mail', triggerId, autoTrigger: true }`.
   * - **`SCHEDULE`**: Executes `payload.prompt` (falling back to `payload` itself) with
   *   `{ triggerType: 'schedule', triggerId, sender: source || 'system:scheduler' }` plus
   *   `metadata: { category: 'scheduled_timer', timerId: payload?.timerId }`.
   * - **`USER`**: Executes `payload.input` (falling back to `payload`) with `payload.options` spread
   *   first, then `triggerType: 'user'` and `triggerId` overriding those keys.
   * - **`INVOCATION`**: When `payload.execute` is a function it is awaited directly; otherwise
   *   `payload.prompt` (falling back to `payload`) executes with `payload.options` plus
   *   `triggerType: 'invocation'` and `triggerId`.
   *
   * @param trigger - Typed trigger item dequeued from `TriggerQueue`.
   * - `trigger.triggerId` - Unique trigger identifier.
   * - `trigger.type` - Canonical trigger category.
   * - `trigger.targetAgentId` - Identifier of the agent to execute.
   * - `trigger.source` - Event origin (e.g. sender agent ID or `'system:scheduler'`).
   * - `trigger.payload` - Trigger-specific payload or execution closure.
   * @returns Resolves to `true` for both executed and skipped triggers.
   *
   * @example
   * ```typescript
   * await dispatcher.dispatchTrigger({
   *   triggerId: 'trig_1710633600000',
   *   type: 'schedule',
   *   targetAgentId: 'agent-1',
   *   source: 'system:scheduler',
   *   payload: { timerId: 'timer_101', prompt: 'Audit system health' }
   * });
   * ```
   */
  async dispatchTrigger(trigger: {
    readonly triggerId: string;
    readonly type: TriggerType;
    readonly targetAgentId: string;
    readonly source?: string;
    readonly payload?: unknown;
  }): Promise<boolean> {
    if (!trigger || !trigger.targetAgentId) return true;
    const agentId = trigger.targetAgentId;
    const runtime = this.#runtime;
    const agent = runtime?.getAgent ? runtime.getAgent(agentId) : null;
    if (!agent || (runtime?.isAgentTerminated && runtime.isAgentTerminated(agentId))) {
      return true;
    }

    const payload = trigger.payload as TriggerPayloadView | null | undefined;

    switch (trigger.type) {
      case TRIGGER_TYPES.MAIL: {
        // Without `listInbox` the unread headers cannot be read, so a
        // `getUnreadCount`-only bus is treated as having no readable mail;
        // synthesizing a prompt from a count alone would dereference an empty list.
        const messagingBus = this.#messagingBus;
        const hasListInbox = typeof messagingBus?.listInbox === 'function';
        const unreadQueue = hasListInbox ? (messagingBus.listInbox(agentId) || []) : [];
        const unreadCount = hasListInbox
          ? (typeof messagingBus?.getUnreadCount === 'function'
            ? messagingBus.getUnreadCount(agentId)
            : unreadQueue.length)
          : 0;
        if (unreadCount === 0) return true;

        const targetEnvelopeId = payload?.id || payload?.messageId;
        if (targetEnvelopeId) {
          const stillPresent = unreadQueue.some(m => (m.id === targetEnvelopeId || m.messageId === targetEnvelopeId));
          if (!stillPresent) {
            return true;
          }
        }

        let prompt: string;
        if (unreadCount === 1) {
          const firstMsg = unreadQueue[0];
          const sender = firstMsg.from || trigger.source || 'unknown';
          const messageId = firstMsg.id || firstMsg.messageId || payload?.id || payload?.messageId || '';
          prompt = `[MAIL NOTIFICATION] 1 unread message from '${sender}' (ID: '${messageId}').`;
        } else {
          const distinctSenders = Array.from(new Set(unreadQueue.map(m => m.from || 'unknown')));
          const sendersFormatted = distinctSenders.map(s => `'${s}'`).join(', ');
          prompt = `[MAIL NOTIFICATION] ${unreadCount} unread messages from [${sendersFormatted}].`;
        }

        if (this.#runtime && typeof this.#runtime.executeAgentTurn === 'function') {
          try {
            await this.#runtime.executeAgentTurn(agentId, prompt, {
              triggerType: TRIGGER_TYPES.MAIL,
              triggerId: trigger.triggerId,
              autoTrigger: true
            });
          } catch (err) {
            console.error(`Mail turn failed for '${agentId}':`, err);
          }
        }
        return true;
      }

      case TRIGGER_TYPES.SCHEDULE: {
        const prompt = resolvePayloadPrompt(payload?.prompt, payload);
        if (this.#runtime && typeof this.#runtime.executeAgentTurn === 'function') {
          try {
            await this.#runtime.executeAgentTurn(agentId, prompt, {
              triggerType: TRIGGER_TYPES.SCHEDULE,
              triggerId: trigger.triggerId,
              sender: trigger.source || 'system:scheduler',
              metadata: { category: 'scheduled_timer', timerId: payload?.timerId }
            });
          } catch (err) {
            console.error(`Schedule turn failed for '${agentId}':`, err);
          }
        }
        return true;
      }

      case TRIGGER_TYPES.USER: {
        const input = resolvePayloadPrompt(payload?.input, payload);
        const opts = payload?.options || {};
        if (this.#runtime && typeof this.#runtime.executeAgentTurn === 'function') {
          try {
            await this.#runtime.executeAgentTurn(agentId, input, {
              ...opts,
              triggerType: TRIGGER_TYPES.USER,
              triggerId: trigger.triggerId
            });
          } catch (err) {
            console.error(`User turn failed for '${agentId}':`, err);
          }
        }
        return true;
      }

      case TRIGGER_TYPES.INVOCATION: {
        if (payload && typeof payload.execute === 'function') {
          try {
            await payload.execute();
          } catch (err) {
            console.error(`Invocation execution callback failed for '${agentId}':`, err);
          }
        } else {
          const prompt = resolvePayloadPrompt(payload?.prompt, payload);
          const opts = payload?.options || {};
          if (this.#runtime && typeof this.#runtime.executeAgentTurn === 'function') {
            try {
              await this.#runtime.executeAgentTurn(agentId, prompt, {
                ...opts,
                triggerType: TRIGGER_TYPES.INVOCATION,
                triggerId: trigger.triggerId
              });
            } catch (err) {
              console.error(`Invocation turn failed for '${agentId}':`, err);
            }
          }
        }
        return true;
      }

      default:
        return true;
    }
  }

  /**
   * Executes a subagent invocation turn without blocking the caller.
   *
   * With a `triggerQueue` injected, enqueues a `TRIGGER_TYPES.INVOCATION` trigger whose
   * `payload.execute` closure performs the turn; the returned promise settles from inside that
   * queued execution, so the caller awaits asynchronously while the queue preserves anti-HoL
   * serialization. The queued trigger's `source` is `options.sender`, then `options.invokerId`,
   * then `'system:invocation'`.
   *
   * Canonical keying (Wave I, ticket d57cbc1): `targetAgentId` is the opaque
   * dispatch reference (the runtime canonicalizes it to the registration key),
   * and when the display source is a bare id whose canonical key the runtime
   * resolved, `options.sourceKey` is forwarded to the queue's `sourceKey`
   * channel so the sender scope resolves realm-exactly. Internal-only: the key
   * never appears on the trigger, the receipt, or an agent-visible surface.
   *
   * Without a `triggerQueue`, falls back to calling `runtime.executeAgentTurn` directly. Rejects
   * with `Error('TriggerQueue and runtime are not available for invocation')` when neither queue
   * nor runtime is available, and with `Error('Runtime is not available to execute invocation turn')`
   * when the queued closure runs without a usable runtime. A rejection from
   * `runtime.executeAgentTurn` propagates unchanged to the caller.
   *
   * @param targetAgentId - Opaque dispatch reference of the delegated subagent.
   * @param prompt - Task prompt or instructions for the subagent.
   * @param options - Options forwarded unchanged to `runtime.executeAgentTurn`, after being
   * consulted for `sender` / `invokerId` / the internal `sourceKey` hint. Defaults to `{}`.
   * @returns Promise resolving to the value returned by `runtime.executeAgentTurn`.
   * @throws Rejects as described above; never throws synchronously.
   *
   * @example
   * ```typescript
   * const result = await dispatcher.executeTurnForInvocation(
   *   'subagent-critic',
   *   'Critique the draft paragraph for tone and consistency',
   *   { invokerId: 'main-agent' }
   * );
   * console.log('Subagent turn result:', result);
   * ```
   */
  async executeTurnForInvocation(
    targetAgentId: string,
    prompt: string,
    options: Record<string, unknown> = {}
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#triggerQueue) {
        if (this.#runtime && typeof this.#runtime.executeAgentTurn === 'function') {
          return this.#runtime.executeAgentTurn(targetAgentId, prompt, options).then(resolve, reject);
        }
        return reject(new Error('TriggerQueue and runtime are not available for invocation'));
      }
      const source = (options?.sender || options?.invokerId || 'system:invocation') as string;
      const rawSourceKey = options?.sourceKey;
      const sourceKey = typeof rawSourceKey === 'string' && rawSourceKey && rawSourceKey !== source
        ? rawSourceKey
        : null;
      this.#triggerQueue.enqueue({
        type: TRIGGER_TYPES.INVOCATION,
        targetAgentId,
        // `sender`/`invokerId` come from the caller options dictionary; the queue
        // normalizes non-string sources to 'unknown' (`TriggerQueue.enqueue`).
        source,
        ...(sourceKey ? { sourceKey } : {}),
        payload: {
          execute: async () => {
            try {
              if (!this.#runtime || typeof this.#runtime.executeAgentTurn !== 'function') {
                throw new Error('Runtime is not available to execute invocation turn');
              }
              const result = await this.#runtime.executeAgentTurn(targetAgentId, prompt, options);
              resolve(result);
            } catch (err) {
              reject(err);
            }
          }
        }
      });
    });
  }
}
