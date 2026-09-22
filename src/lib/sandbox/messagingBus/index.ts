/**
 * @packageDocumentation
 * Type definitions for Module 2: Messaging Bus (Layer 0 Core Foundation Primitive).
 *
 * @module messagingBus
 * @mayImport buffer
 * @mayImport type-only ../virtualFs/index.ts
 * @invariant Strict FIFO dequeue-on-read: `readMessage` (`markAsRead`), `drainInbox`, and `waitForMail` atomically remove consumed envelopes from `#activeQueues` and append them to `#archives` with `read: true` (no ghost re-reads).
 * @invariant Archives are append-only; non-destructive APIs (`listInbox`, `getArchive`, `getAuditLog`) never mutate queues or `read` flags.
 * @invariant Mailbox state (queues, archives, registrations, terminations, policies, subscriptions, audit log) is `#`-private; public reads return defensive copies.
 * @invariant Dead-letter validation: `sendMessage` returns `AGENT_TERMINATED` to terminated recipients and `RECIPIENT_NOT_FOUND` to unregistered recipients; broadcasts target registered, non-terminated agents other than the sender.
 * @invariant `waitForMail` resolves immediately when pending mail already satisfies the predicate, otherwise suspends until delivery, timeout, or abort; timeout resolves `success: true` with `timedOut: true` and code `TIMEOUT`.
 * @invariant `exportSnapshot`/`importSnapshot` roundtrip the persisted snapshot state (queues, archives, registrations, terminations, routing modes, audit log) losslessly and accept the legacy `{ inboxes }` schema, partitioning envelopes by `read`; subscriptions are not persisted and `importSnapshot` clears them; every restored envelope carries an explicit `success` flag (absent legacy values default to `true`, explicit `false` is preserved).
 * @invariant Resolved policy-privilege rule (MOD-21, default-deny): `getPolicy(agentId).privileged` is derived on read — `true` only for a registration marked with the exact reference injected as `MessagingBusOptions.internalPrincipal`, or when `MessagingBusOptions.identityPort.getAgentIdentity(agentId)` resolves an authority descriptor whose `visibility` is `'all'`/`'system'` or whose `allow` set carries the `'*'` wildcard. Caller-supplied `policy.privileged`, reserved ids, and snapshot policy data confer nothing; a descriptor present without a grant fails closed, and the legacy projection `privileged` boolean is honored only as a fallback when the identity projection carries no `authority` descriptor.
 * @invariant VirtualFS is consumed only through injected contexts (`ExecutionContext.virtualFs` / `InlineFileOptions.virtualFs`); no runtime VirtualFS import, and a missing VFS yields `VFS_UNAVAILABLE`.
 * @invariant Subscriber handlers are notified after enqueue for direct recipients and the `'all'` wildcard; handler exceptions are quarantined and never fail delivery.
 * @invariant Resolved mailbox/sender rule (MOD-21, context-authoritative): when a trailing context object is supplied (even one that binds no caller), `listInbox`/`readMessage`/`drainInbox`/`getArchive`/`waitForMail` select the context caller's mailbox only (an anonymous context sees an empty mailbox, and `waitForMail` fails `INVALID_ARGUMENTS`), `sendMessage` attributes the context caller (or the fixed `'anonymous'` label when the context binds none), and `inlineFileInMessage` default-denies without a context caller (no VirtualFS read identity). Caller-supplied payload `agentId`/`recipient`/`from`/`sender`/`callerAgentId` are never promoted when a context object is supplied; they remain fallback-only for genuinely contextless direct-API calls. Documented sender filters (`sender`/`from` in `ListInboxOptions`/`ArchiveQueryOptions`/`WaitForMailOptions`) and the documented positional/contextless signatures remain callable data, never authority. The `forAgent(agentId)` proxy is an agent-scoped caller binding: its bound agent ID is the authoritative sender on `sendMessage`/`inlineFileInMessage`, payload `from`/`sender` (and `callerAgentId`/`callerKey` in the inline option bag) cannot override it, and no payload field is promoted as a fallback.
 * @invariant Realm-scoped delivery, one-way bypass: `sendMessage` and `inlineFileInMessage` resolve sender and recipient Realm scope from the injected identity port at call time — a direct or inline envelope is delivered only when the sender carries `realmBypass` (the injected internal principal or a `realmBypass` agent such as the hardcoded system director, who span every Realm one-way) or when both subjects share the same scope (the ungrouped `null` scope is shared by legacy subjects); a bypass recipient is never reachable from a non-bypass sender, so there is no agent-to-director reply path. `to: 'all'` fan-out is filtered to recipients sharing the sender's scope, or to every registered recipient for a bypass sender; a denied cross-Realm envelope fails closed with `PERMISSION_DENIED` before any mailbox or audit/archive write, and caller-supplied payload or metadata Realm claims are never consulted.
 * @invariant Realm-local identity keying: every map, set and partition in this module keys on the opaque identifier the runtime supplies to `registerAgent`/`markAgentTerminated`/`unregisterAgent`/`purgeAgent` — the canonical `(realmId, agentId)` key under wiring, legacy bare ids otherwise — and never assumes that identifier equals the bare id. Agent-supplied bare refs (`from`/`to`) and registration identifiers are resolved through the injected identity port: a `callerKey` carried by a trusted internal context (or supplied directly by the host) resolves the caller exactly by `key` over `listAgentIdentities()`, a bare caller id falls back to the port's unique-match `getAgentIdentity`, a recipient bare ref resolves within the caller's scope (`{ realmId: caller.realmId, realmBypass: caller.realmBypass }`) with a foreign-realm or ambiguous ref denied `PERMISSION_DENIED` exactly like the legacy cross-Realm gate, and `to: 'all'` enumerates `listAgentIdentities(callerScope)` (the registered set remains the fallback for ports without enumeration). Receipts, listings, errors and delivered payloads expose the bare `id` only — never the canonical `key`, never a registration identifier, never Realm vocabulary.
 * @decision Host runtime primitives (`idGenerator`, `clone`, `byteLength`) are optional constructor dependencies (`MessagingBusOptions`) defaulting to host globals
 * @decision `MessageEnvelope.success` is declared as part of the public envelope contract rather than hidden: `sendMessage` stamps `true` at dispatch, `exportSnapshot` copies it through untouched, `importSnapshot` defaults an absent legacy value to `true` while preserving an explicit `false`, and `getArchive` projects it
 * @decision Broadcast envelope markers are part of the archived envelope contract: `getArchive` copies `broadcast` through and shallow-copies `recipients` when the persisted envelope declares them, so archives are indistinguishable from the persisted form
 * @decision Legacy `getInbox`/`getInboxHeaders`/`getHistory` aliases are not part of the contract; consumers use the declared inbox/archive APIs
 * @decision Bus policy authority derives from the registry descriptor (injected identity port) or the opaque injected `internalPrincipal` reference; `registerAgent` never stores caller-asserted `privileged` policy and `exportSnapshot` never serializes trust
 * @decision Mailbox routing and sender identity resolve from the trusted execution context first: a context-bound `callerAgentId`/`agentId` outranks payload `agentId`/`recipient`/`from`/`sender` on every read and send seam, and payload routing keys are scrubbed from the merged option bags, while contextless direct-API and positional signatures retain their documented payload fallbacks
 * @decision The agent-scoped `forAgent(agentId)` proxy pins its bound agent ID as the authoritative sender on `sendMessage` and `inlineFileInMessage`; payload `from`/`sender` (and `callerAgentId` inline options) are stripped/ignored so the proxy cannot spoof another sender, while contextless direct-API calls retain their documented payload fallback
 * @decision Object-first mailbox routing and sender identity are context-bound: a supplied context object is the only identity source — a context binding no caller is anonymous, so mailbox reads return empty, `waitForMail` fails `INVALID_ARGUMENTS`, `sendMessage` uses the fixed `'anonymous'` sender, and `inlineFileInMessage` fails closed without a VirtualFS read identity/workspace; the payload `agentId`/`recipient`/`from`/`sender`/`callerAgentId` fallback survives only for genuinely contextless direct-API calls. Messaging tool descriptors additionally strip undeclared identity/routing keys from sanitized parameters before delegating
 * @decision Cross-Realm delivery denial is a fail-closed `PERMISSION_DENIED` receipt whose scope resolves from the trusted identity projection (`realmId`/`realmBypass`) or from the exact injected internal-principal reference carried by an execution context; the bypass is one-way (a bypass sender spans every Realm, a non-bypass sender cannot address a bypass subject — no reply path to the system scope); no message payload or metadata field can select a Realm scope, and subjects without a `realmId` keep legacy parity
 * @decision Realm-local identity resolution: substrate partitions key on the opaque registration identifier (canonical `(realmId, agentId)` key under wiring) while agent-facing refs stay bare ids resolved through the injected identity port — the trusted `callerKey`/`listAgentIdentities()` match resolves callers exactly, scoped `getAgentIdentity` resolves recipients within the caller's Realm, and identity resolution never consults payload routing claims. The bus imports no runtime internals and the exact-reference internal/operator principal path is unchanged
 */

import { Buffer } from 'buffer';
import type { ReadFileResult, VirtualFS } from '../virtualFs/index.ts';

export type { VirtualFS };

// ============================================================================
// Error Codes & Constants
// ============================================================================

/**
 * Standardized frozen dictionary of error code constants for all messaging bus
 * operations.
 *
 * Tool descriptors receive these string codes inside `MessagingBus` receipts; the
 * dictionary is not imported by tool handlers or runtime engines.
 *
 * @readonly
 * Enum of `string` values:
 * - `AGENT_TERMINATED` (`'AGENT_TERMINATED'`) - Target recipient agent is marked terminated and cannot receive messages.
 * - `RECIPIENT_NOT_FOUND` (`'RECIPIENT_NOT_FOUND'`) - Target recipient agent is not registered in the messaging bus.
 * - `PERMISSION_DENIED` (`'PERMISSION_DENIED'`) - The resolved Realm scope forbids the delivery (cross-Realm sender/recipient without `realmBypass`); nothing is delivered or archived.
 * - `MESSAGE_NOT_FOUND` (`'MESSAGE_NOT_FOUND'`) - Specified message ID was not found in active queues or historical archives.
 * - `INVALID_ARGUMENTS` (`'INVALID_ARGUMENTS'`) - Required parameters (e.g. `from`, `to`, `content`, `agentId`) are missing or invalid, or `sendMessage` content is not JSON-serializable.
 * - `VFS_UNAVAILABLE` (`'VFS_UNAVAILABLE'`) - VirtualFS instance is missing from execution context during inline file operations.
 * - `FILE_NOT_FOUND` (`'FILE_NOT_FOUND'`) - Target file could not be read from the VirtualFS workspace (missing or unreadable).
 * - `TIMEOUT` (`'TIMEOUT'`) - Blocking wait primitive timed out before required senders responded.
 * - `ABORTED` (`'ABORTED'`) - Blocking wait operation was aborted via an AbortSignal.
 *
 * @example
 * ```typescript
 * import { MessagingBus, MESSAGING_ERROR_CODES } from './messagingBus/index.ts';
 *
 * const bus = new MessagingBus();
 * const receipt = bus.sendMessage({ from: 'agent_a', to: 'agent_unknown', content: 'Hello' });
 *
 * if (!receipt.success) {
 *   if (receipt.code === MESSAGING_ERROR_CODES.RECIPIENT_NOT_FOUND) {
 *     console.error(`Delivery failed: recipient not registered (${receipt.error})`);
 *   }
 * }
 * ```
 */
export const MESSAGING_ERROR_CODES: {
  readonly AGENT_TERMINATED: 'AGENT_TERMINATED';
  readonly RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND';
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED';
  readonly MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND';
  readonly INVALID_ARGUMENTS: 'INVALID_ARGUMENTS';
  readonly VFS_UNAVAILABLE: 'VFS_UNAVAILABLE';
  readonly FILE_NOT_FOUND: 'FILE_NOT_FOUND';
  readonly TIMEOUT: 'TIMEOUT';
  readonly ABORTED: 'ABORTED';
} = Object.freeze({
  AGENT_TERMINATED: 'AGENT_TERMINATED',
  RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  VFS_UNAVAILABLE: 'VFS_UNAVAILABLE',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED'
});

/**
 * Union type representing all valid messaging error code string literals.
 *
 * @example
 * ```typescript
 * function handleMessagingError(code: MessagingErrorCode, errorMsg?: string): void {
 *   console.error(`Messaging bus error [${code}]: ${errorMsg}`);
 * }
 * ```
 */
export type MessagingErrorCode = typeof MESSAGING_ERROR_CODES[keyof typeof MESSAGING_ERROR_CODES];

// ============================================================================
// Core Message Envelopes & Headers
// ============================================================================

/**
 * Standard immutable message envelope routed through `MessagingBus`.
 * Represents a point-to-point or broadcast message payload with full audit metadata.
 *
 * Invariant: Unconsumed envelopes reside exclusively in `#activeQueues` with `read: false`.
 * Consumed envelopes reside exclusively in `#archives` with `read: true`.
 *
 * Interface `MessageEnvelope`.
 * - `id` (`string`) - Unique envelope identifier (`msg_${timestamp}_${random}` or UUID).
 * - `messageId` (`string`) - Alias of `id` for backwards compatibility with legacy tool protocols.
 * - `from` (`string`) - Sender agent ID who authored the envelope.
 * - `to` (`string`) - Target recipient agent ID, or `'all'` for broadcast envelopes.
 * - `replyTo` (`string`) - Designated reply-to agent ID for asynchronous response routing (defaults to `from`).
 * - `type` (`string`) - Message semantic classification tag (e.g. `'message'`, `'task'`, `'event'`, `'query'`, `'response'`).
 * - `content` (`string`) - Primary message payload or serialized text.
 * - `metadata` (`Readonly<Record<string, unknown>>`) - Read-only arbitrary dictionary of contextual metadata (e.g. correlation IDs, trace tokens); routing keys are narrowed on read.
 * - `timestamp` (`number`) - Millisecond Unix timestamp recorded when the message was dispatched into the bus.
 * - `read` (`boolean`) - Boolean flag indicating whether the message has been consumed from the unread queue into the archive.
 * - `success` (`boolean`) - Persisted delivery-acceptance flag stamped by `sendMessage`; always `true` for envelopes the bus dispatches, defaulted to `true` when a legacy snapshot entry omits it, and preserved as `false` when an explicit failure record is restored.
 * - `broadcast` (`boolean`) - Optional flag set to `true` on broadcast distribution envelopes.
 * - `recipients` (`readonly string[]`) - Optional list of agent IDs that received copies during a broadcast.
 *
 * @example
 * ```typescript
 * const envelope: MessageEnvelope = {
 *   id: 'msg_1726500000000_abc123',
 *   messageId: 'msg_1726500000000_abc123',
 *   from: 'director_agent',
 *   to: 'researcher_agent',
 *   replyTo: 'director_agent',
 *   type: 'task',
 *   content: 'Please summarize the quarterly revenue figures.',
 *   metadata: { priority: 'high', correlationId: 'req_9876' },
 *   timestamp: Date.now(),
 *   read: false,
 *   success: true
 * };
 * ```
 */
export interface MessageEnvelope {
  /** Unique envelope identifier assigned at dispatch (`crypto.randomUUID`, or a timestamp/random fallback). */
  readonly id: string;
  /** Alias of `id` for legacy tool protocols. */
  readonly messageId: string;
  /** Sender agent ID. */
  readonly from: string;
  /** Recipient agent ID, or `'all'` for a broadcast. */
  readonly to: string;
  /** Reply-to agent ID; never empty and falls back to `from`. */
  readonly replyTo: string;
  /** Resolved classification tag; defaults to `'message'`. */
  readonly type: string;
  /** Serialized payload string; non-string content is JSON-stringified at dispatch. */
  readonly content: string;
  /** Copied metadata dictionary, including `correlationId` when it was supplied. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Millisecond Unix timestamp of dispatch. */
  readonly timestamp: number;
  /** `false` while queued; set to `true` when the envelope is consumed into the archive. */
  read: boolean;
  /**
   * Persisted delivery-acceptance flag inherited from the dispatch receipt.
   * Always `true` for envelopes produced by `sendMessage`; `importSnapshot` defaults
   * an absent legacy value to `true` and preserves an explicit `false`.
   */
  readonly success: boolean;
  /** `true` on broadcast copies; absent on point-to-point envelopes. */
  readonly broadcast?: boolean;
  /** Recipients that received a broadcast copy, excluding the sender; absent on point-to-point envelopes. */
  readonly recipients?: readonly string[];
}

/**
 * Compatibility type alias for `MessageEnvelope`.
 */
export type BusMessageEnvelope = MessageEnvelope;

/**
 * Internal mutable projection of `MessageEnvelope` used by the private mailbox
 * stores: the public contract exposes `readonly` fields, while the bus mutates
 * `read` and conditionally stamps the broadcast markers on projections.
 */
type MutableMessageEnvelope = {
  -readonly [K in keyof MessageEnvelope]: MessageEnvelope[K];
};

/**
 * Lightweight header summary for non-destructive inbox peeking (`listInbox`).
 * Enables agents and UI components to inspect pending mail without dequeuing envelopes
 * or mutating read statuses.
 *
 * Interface `MessageHeaderSummary`.
 * - `id` (`string`) - Unique message identifier.
 * - `messageId` (`string`) - Alias of `id`.
 * - `from` (`string`) - Sender agent ID.
 * - `to` (`string`) - Recipient agent ID.
 * - `replyTo` (`string`) - Designated reply-to agent ID.
 * - `type` (`string`) - Message type tag.
 * - `preview` (`string`) - Truncated 80-character snippet of message content (with `'...'` suffix if longer than 80 chars).
 * - `snippet` (`string`) - Alias for `preview`.
 * - `timestamp` (`number`) - Millisecond Unix timestamp of message creation.
 * - `read` (`boolean`) - Read status of the message (`false` for active queue, `true` for archive).
 * - `metadata` (`Readonly<Record<string, unknown>>`) - Read-only metadata dictionary.
 *
 * @example
 * ```typescript
 * const headers: MessageHeaderSummary[] = bus.listInbox('agent_a', { status: 'unread' });
 * for (const h of headers) {
 *   console.log(`[${h.from}] -> [${h.to}]: ${h.preview} (${new Date(h.timestamp).toISOString()})`);
 * }
 * ```
 */
export interface MessageHeaderSummary {
  /** Message identifier (`id`, falling back to `messageId`). */
  readonly id: string;
  /** Message identifier (`messageId`, falling back to `id`). */
  readonly messageId: string;
  /** Sender agent ID. */
  readonly from: string;
  /** Recipient agent ID as stored on the envelope, falling back to the queried agent. */
  readonly to: string;
  /** Reply-to agent ID, falling back to `from`. */
  readonly replyTo: string;
  /** Message type, falling back to `metadata.type`, then `'message'`. */
  readonly type: string;
  /** Full content when at most 80 characters; otherwise the first 80 characters plus `'...'`. */
  readonly preview: string;
  /** Alias of `preview`. */
  readonly snippet: string;
  /** Millisecond Unix timestamp of the envelope. */
  readonly timestamp: number;
  /** `true` for archived envelopes, `false` for active-queue envelopes. */
  readonly read: boolean;
  /** Copy of the envelope metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Compatibility type alias for `MessageHeaderSummary`.
 */
export type InboxHeader = MessageHeaderSummary;

/**
 * Policy configuration options applied when registering an agent mailbox.
 *
 * Interface `AgentPolicy`.
 * - `mode` (`'queued'`) - Mailbox routing mode. Defaults to `'queued'`.
 * - `principal` (`object`) - Exact injected internal-principal reference marking a trusted engine registration.
 * - `privileged` (`boolean`) - Legacy caller-asserted flag; no longer honored.
 *
 * @example
 * ```typescript
 * bus.registerAgent('director_agent', { mode: 'queued' });
 * ```
 */
export interface AgentPolicy {
  /** Mailbox routing mode; only `'queued'` (strict FIFO) is currently supported. */
  readonly mode?: 'queued';
  /**
   * Trusted engine registration marker (MOD-21): honored only when it is the
   * exact object injected as `MessagingBusOptions.internalPrincipal`.
   */
  readonly principal?: object;
  /**
   * Whether the agent holds elevated privileges, such as system channel access.
   * @deprecated Caller-asserted policy privilege no longer confers anything (MOD-21 W4); policy privilege is re-derived from the injected identity port or the internal principal reference.
   */
  readonly privileged?: boolean;
}

// ============================================================================
// Receipts & Results
// ============================================================================

/**
 * Synchronous delivery receipt returned by `MessagingBus#sendMessage`.
 * Indicates whether routing succeeded or failed, containing the delivered envelope details
 * or dead-letter failure error codes.
 *
 * Interface `SendMessageReceipt`.
 * - `success` (`boolean`) - `true` if delivered or broadcast successfully; `false` if rejected or invalid.
 * - `id` (`string`) - Unique message ID assigned to the envelope.
 * - `messageId` (`string`) - Alias for `id`.
 * - `from` (`string`) - Sender agent ID.
 * - `to` (`string`) - Target recipient agent ID or `'all'`.
 * - `replyTo` (`string`) - Designated reply-to agent ID.
 * - `type` (`string`) - Message semantic classification tag.
 * - `content` (`string`) - Message payload.
 * - `metadata` (`Record<string, unknown>`) - Metadata dictionary attached to the message.
 * - `timestamp` (`number`) - Millisecond timestamp of message dispatch.
 * - `read` (`boolean`) - Initial read status (`false`).
 * - `broadcast` (`boolean`) - Flag indicating if the message was a broadcast (`to === 'all'`).
 * - `recipients` (`string[]`) - Array of recipient agent IDs that received the broadcast copy.
 * - `code` (`MessagingErrorCode`) - Standardized error code if `success === false` (`AGENT_TERMINATED`, `RECIPIENT_NOT_FOUND`, `INVALID_ARGUMENTS`).
 * - `error` (`string`) - Human-readable error description if `success === false`.
 *
 * @example
 * ```typescript
 * const receipt = bus.sendMessage({
 *   from: 'director',
 *   to: 'worker_1',
 *   content: 'Begin task execution.'
 * });
 *
 * if (receipt.success) {
 *   console.log(`Message delivered with ID: ${receipt.id}`);
 * } else {
 *   console.error(`Message delivery failed [${receipt.code}]: ${receipt.error}`);
 * }
 * ```
 */
export interface SendMessageReceipt {
  /** `true` when the envelope was accepted for every resolved recipient; `false` when validation or a dead-letter check rejected it. */
  readonly success: boolean;
  /** Unique message ID assigned at dispatch; present on success. */
  readonly id?: string;
  /** Alias of `id` for legacy tool protocols; present on success. */
  readonly messageId?: string;
  /** Sender agent ID resolved from the request or execution context; present on success. */
  readonly from?: string;
  /** Target recipient agent ID, or `'all'` for a broadcast; present on success. */
  readonly to?: string;
  /** Resolved reply-to agent ID; falls back to `from` when omitted. */
  readonly replyTo?: string;
  /** Resolved classification tag; defaults to `'message'`. */
  readonly type?: string;
  /** Serialized payload; non-string content is JSON-stringified at dispatch. */
  readonly content?: string;
  /** Copy of the caller metadata, including `correlationId` when it was supplied. */
  readonly metadata?: Record<string, unknown>;
  /** Millisecond Unix timestamp captured at dispatch. */
  readonly timestamp?: number;
  /** Initial read flag; always `false` for a newly delivered envelope. */
  readonly read?: boolean;
  /** `true` only on broadcast receipts. */
  readonly broadcast?: boolean;
  /** Registered, non-terminated recipients that received a broadcast copy, excluding the sender. */
  readonly recipients?: string[];
  /** Failure code when `success` is `false`: `sendMessage` emits `AGENT_TERMINATED`, `RECIPIENT_NOT_FOUND`, `PERMISSION_DENIED`, or `INVALID_ARGUMENTS`, while `inlineFileInMessage` may also emit `VFS_UNAVAILABLE` or `FILE_NOT_FOUND`. */
  readonly code?: MessagingErrorCode;
  /** Human-readable failure description when `success` is `false`. */
  readonly error?: string;
}

/**
 * Result object returned by `MessagingBus#readMessage`.
 *
 * Interface `ReadMessageResult`.
 * - `success` (`boolean`) - `true` if the message was found and retrieved; `false` otherwise.
 * - `status` (`'inbox' | 'archived'`) - Storage partition where the message was located (`'inbox'` if found in active queue, `'archived'` if found in historical archive).
 * - `message` (`MessageEnvelope`) - The retrieved message envelope.
 * - `code` (`MessagingErrorCode`) - Error code if `success === false` (`MESSAGE_NOT_FOUND`, `INVALID_ARGUMENTS`).
 * - `error` (`string`) - Human-readable error description on failure.
 *
 * @example
 * ```typescript
 * const result = bus.readMessage('agent_b', 'msg_123', { markAsRead: true });
 * if (result.success && result.message) {
 *   console.log(`Read message from ${result.message.from}: ${result.message.content}`);
 * } else {
 *   console.error(`Failed to read message: ${result.code}`);
 * }
 * ```
 */
export interface ReadMessageResult {
  /** `true` when the message was found; `false` for invalid arguments or an unknown ID. */
  readonly success: boolean;
  /** `'inbox'` when found in the active queue, `'archived'` when found in the archive; present on success. */
  readonly status?: 'inbox' | 'archived';
  /** Defensive copy of the retrieved envelope; present on success. */
  readonly message?: MessageEnvelope;
  /** Failure code (`MESSAGE_NOT_FOUND` or `INVALID_ARGUMENTS`); present when `success` is `false`. */
  readonly code?: MessagingErrorCode;
  /** Human-readable failure description; present when `success` is `false`. */
  readonly error?: string;
}

/**
 * Successful resolution of asynchronous `MessagingBus#waitForMail`.
 *
 * A wait that expires without full sender satisfaction still resolves with
 * `success: true`, `timedOut: true`, and `code: 'TIMEOUT'`; `messages`/`count`/
 * `receivedSenders`/`missingSenders` are always present on this variant.
 *
 * Interface `WaitForMailSuccessResult`.
 * - `success` (`true`) - Always `true` for a started wait (including graceful timeout).
 * - `messages` (`MessageEnvelope[]`) - Copies of all matching envelopes consumed or observed by the wait.
 * - `count` (`number`) - Number of received messages.
 * - `timedOut` (`boolean`) - `true` if the timeout expired before all requested senders delivered mail.
 * - `receivedSenders` (`string[]`) - Array of sender IDs that delivered at least one matching message.
 * - `missingSenders` (`string[]`) - Array of requested sender IDs that failed to deliver mail before timeout.
 * - `code` (`MessagingErrorCode`) - `'TIMEOUT'` when the wait expired without satisfaction.
 *
 * @example
 * ```typescript
 * const waitResult = await bus.waitForMail('orchestrator', {
 *   senders: ['worker_1', 'worker_2'],
 *   timeoutMs: 5000,
 *   requireAll: true
 * });
 *
 * if (waitResult.success) {
 *   if (waitResult.timedOut) {
 *     console.warn(`Timed out waiting for senders: ${waitResult.missingSenders.join(', ')}`);
 *   } else {
 *     console.log(`Received all ${waitResult.count} messages successfully.`);
 *   }
 * }
 * ```
 */
export interface WaitForMailSuccessResult {
  /** Always `true` for a started wait, including a graceful timeout. */
  readonly success: true;
  /** Copies of all matching envelopes consumed or observed by the wait. */
  readonly messages: MessageEnvelope[];
  /** Number of entries in `messages`. */
  readonly count: number;
  /** `true` when the deadline expired before the satisfaction predicate was met. */
  readonly timedOut: boolean;
  /** Senders that delivered at least one matching message, in first-seen order. */
  readonly receivedSenders: string[];
  /** Listed senders with no matching delivery; empty for wildcard waits. */
  readonly missingSenders: string[];
  /** `'TIMEOUT'` when the deadline expired without satisfaction; absent otherwise. */
  readonly code?: MessagingErrorCode;
}

/**
 * Failure resolution of asynchronous `MessagingBus#waitForMail` (missing/invalid
 * recipient or abort). The delivery projection fields are present on the abort
 * path but omitted on input-validation failure, hence optional here.
 *
 * Interface `WaitForMailFailureResult`.
 * - `success` (`false`) - Always `false` on this variant.
 * - `messages` (`MessageEnvelope[]`) - Received messages, when the wait had started before aborting.
 * - `count` (`number`) - Number of received messages, when the wait had started.
 * - `timedOut` (`boolean`) - Timeout flag, when the wait had started.
 * - `receivedSenders` (`string[]`) - Senders observed before failure, when the wait had started.
 * - `missingSenders` (`string[]`) - Expected senders still missing at failure, when the wait had started.
 * - `code` (`MessagingErrorCode`) - Standardized error code (`'INVALID_ARGUMENTS'`, `'ABORTED'`).
 * - `error` (`string`) - Human-readable error description.
 *
 * @example
 * ```typescript
 * const waitResult = await bus.waitForMail('');
 * if (!waitResult.success) {
 *   console.error(`Wait failed [${waitResult.code}]: ${waitResult.error}`);
 * }
 * ```
 */
export interface WaitForMailFailureResult {
  /** Always `false` on this variant. */
  readonly success: false;
  /** Messages collected before an abort; omitted on validation failure. */
  readonly messages?: MessageEnvelope[];
  /** Number of collected messages; omitted on validation failure. */
  readonly count?: number;
  /** Timeout flag recorded when the abort occurred; omitted on validation failure. */
  readonly timedOut?: boolean;
  /** Senders observed before the abort; omitted on validation failure. */
  readonly receivedSenders?: string[];
  /** Listed senders still missing at abort; omitted on validation failure. */
  readonly missingSenders?: string[];
  /** `'INVALID_ARGUMENTS'` for input validation failure, `'ABORTED'` for signal cancellation. */
  readonly code: MessagingErrorCode;
  /** Human-readable failure description. */
  readonly error: string;
}

/**
 * Discriminated union returned by asynchronous `MessagingBus#waitForMail`.
 *
 * Narrow on `success` to obtain the fully-populated delivery projection; the
 * failure variant reports `code` + `error` and only carries projection fields
 * when the wait had already started before aborting.
 */
export type WaitForMailResult = WaitForMailSuccessResult | WaitForMailFailureResult;

/**
 * Result returned by asynchronous `MessagingBus#inlineFileInMessage`. Extends `SendMessageReceipt`.
 *
 * Interface `InlineFileMessageResult`.
 * Extends `SendMessageReceipt`.
 * - `inlinedFiles` (`Array<{ path: string; bytes: number }>`) - Metadata records for embedded files; `bytes` counts the delivered content.
 * - `totalBytes` (`number`) - UTF-8 byte length of the delivered (possibly truncated) inlined content.
 * - `truncated` (`boolean`) - `true` when the VirtualFS read budget truncated the inlined content.
 * - `deliveryNote` (`string`) - VirtualFS truncation guidance; present only when `truncated` is `true`.
 * - `wordsCount` (`number`) - Approximate word count of the delivered inlined content.
 * - `deliveryConfirmation` (`string`) - Confirmation description string.
 *
 * @example
 * ```typescript
 * const inlineResult = await bus.inlineFileInMessage({
 *   filePath: '/workspace/analysis.md',
 *   recipient: 'reviewer_agent',
 *   from: 'director',
 *   message: 'Please review the attached analysis.'
 * }, { virtualFs, callerAgentId: 'director' });
 *
 * if (inlineResult.success) {
 *   console.log(`Inlined ${inlineResult.totalBytes} bytes from ${inlineResult.inlinedFiles?.[0]?.path}`);
 * }
 * ```
 */
export interface InlineFileMessageResult extends SendMessageReceipt {
  /** Inlined file metadata (`path`, `bytes`); `bytes` counts the delivered content. Present once the file has been read. */
  readonly inlinedFiles?: Array<{ path: string; bytes: number }>;
  /** UTF-8 byte length of the delivered (possibly truncated) inlined content; present once the file has been read. */
  readonly totalBytes?: number;
  /** `true` when the VirtualFS read budget truncated the inlined content; present once the file has been read. */
  readonly truncated?: boolean;
  /** VirtualFS truncation guidance; present only when `truncated` is `true`. */
  readonly deliveryNote?: string;
  /** Whitespace-delimited word count of the delivered inlined content; `0` for blank content. */
  readonly wordsCount?: number;
  /** Confirmation text; present only when the message was delivered successfully. */
  readonly deliveryConfirmation?: string;
}

// ============================================================================
// Input & Options Parameter Interfaces
// ============================================================================

/**
 * Execution context object passed across Tool Gateway invocations and runtime turn loops.
 * Supplies runtime credentials, virtual file systems, and abort signals for zero-glue delegation.
 *
 * Interface `ExecutionContext`.
 * - `callerAgentId` (`string`) - ID of the agent executing the current tool or turn; when a context object is supplied it is the only identity source, and a context binding no caller is anonymous (MOD-21 W10-B).
 * - `callerKey` (`string`) - Canonical identity `key` of the caller (Wave I, ticket d57cbc1); trusted internal contexts bind it to disambiguate realm-local ids. Internal-only: never a payload identity source and never echoed to agents.
 * - `agentId` (`string`) - Alternative alias for caller agent ID.
 * - `virtualFs` (`VirtualFS | null`) - Optional Virtual File System instance for file operations.
 * - `signal` (`AbortSignal | null`) - Optional AbortSignal for cooperative cancellation.
 * - `[key: string]` (`unknown`) - Additional contextual runtime metadata, narrowed on read (e.g. `workspaceId` scopes VirtualFS file reads).
 *
 * @example
 * ```typescript
 * const context: ExecutionContext = {
 *   callerAgentId: 'director_agent',
 *   virtualFs: vfsInstance,
 *   signal: abortController.signal
 * };
 * ```
 */
export interface ExecutionContext {
  /** ID of the invoking agent; when a context object is supplied it is the only mailbox/sender identity source and outranks caller payload identity fields (`agentId`/`recipient`/`from`/`sender`); a context binding no caller is anonymous (MOD-21 W10-B). */
  readonly callerAgentId?: string;
  /**
   * Canonical internal identity `key` of the caller (Wave I, ticket d57cbc1),
   * bound by trusted internal callers (engine/runtime) to disambiguate a
   * realm-local id registered in several Realms. Resolved by exact `key`
   * match over `listAgentIdentities()`; an unmatched key falls back to the
   * bare `callerAgentId` unique match. Identity input only — it is never
   * promoted from payloads and never surfaces in receipts, listings or errors.
   */
  readonly callerKey?: string;
  /** Fallback alias for `callerAgentId`, consulted only when it is absent. */
  readonly agentId?: string;
  /** VirtualFS instance used by inline file operations; when a context object is supplied it is the only VirtualFS source, and a missing or invalid instance yields `VFS_UNAVAILABLE`. */
  readonly virtualFs?: VirtualFS | null;
  /** Abort signal that resolves a pending `waitForMail` with `ABORTED`. */
  readonly signal?: AbortSignal | null;
  /** Additional contextual data; `workspaceId` scopes VirtualFS file reads and is narrowed on read. */
  readonly [key: string]: unknown;
}

/**
 * Parameter options for `MessagingBus#sendMessage`.
 * Supports both canonical names and tool descriptor aliases.
 *
 * Interface `SendMessageOptions`.
 * - `from` (`string`) - Sender agent ID; when a context object is supplied the context caller (or the fixed `'anonymous'` label when it binds none) owns the sender and this field is never promoted (MOD-21 W10-B); it is the direct-API sender only for genuinely contextless calls.
 * - `sender` (`string`) - Alias for `from`.
 * - `to` (`string`) - Target recipient agent ID, or `'all'` for broadcast.
 * - `recipient` (`string`) - Alias for `to`.
 * - `targetAgentId` (`string`) - CamelCase alias for `to`.
 * - `target_agent_id` (`string`) - Snake_case alias for `to`.
 * - `recipient_id` (`string`) - Snake_case alias for `to`.
 * - `recipientId` (`string`) - CamelCase alias for `to`.
 * - `content` (`string | object`) - Primary message content string or serializable object.
 * - `message` (`string | object`) - Alias for `content`.
 * - `text` (`string | object`) - Alias for `content`.
 * - `body` (`string | object`) - Alias for `content`.
 * - `payload` (`string | object`) - Alias for `content`.
 * - `replyTo` (`string`) - Designated reply-to agent ID (defaults to `from`).
 * - `in_reply_to` (`string`) - Alias for `replyTo`.
 * - `inReplyTo` (`string`) - CamelCase alias for `replyTo`.
 * - `reply_to` (`string`) - Snake_case alias for `replyTo`.
 * - `type` (`string`) - Message semantic classification tag (defaults to `'message'`).
 * - `metadata` (`Record<string, unknown>`) - Metadata dictionary attached to the message.
 * - `correlation_id` (`string`) - Correlation ID mapped into `metadata.correlationId`.
 * - `correlationId` (`string`) - CamelCase alias for `correlation_id`.
 *
 * @example
 * ```typescript
 * const options: SendMessageOptions = {
 *   from: 'agent_a',
 *   recipient: 'agent_b',
 *   message: 'Task complete',
 *   type: 'notification',
 *   correlation_id: 'job_1001'
 * };
 * ```
 */
export interface SendMessageOptions {
  /** Sender agent ID; when a context object is supplied the context caller (or the fixed `'anonymous'` label when it binds none) owns the sender and this field is never promoted, otherwise it is the direct-API sender fallback (MOD-21 W10-B). */
  from?: string;
  /** Alias for `from`. */
  sender?: string;
  /** Recipient agent ID, or `'all'` for a broadcast. */
  to?: string;
  /** Alias for `to`. */
  recipient?: string;
  /** Alias for `to` (tool descriptor spelling). */
  targetAgentId?: string;
  /** Snake_case alias for `to`. */
  target_agent_id?: string;
  /** Snake_case alias for `to`. */
  recipient_id?: string;
  /** CamelCase alias for `to`. */
  recipientId?: string;
  /** Primary payload; non-string values are JSON-stringified at dispatch, and unserializable values (circular structures, BigInt) are rejected with `INVALID_ARGUMENTS`. */
  content?: string | object;
  /** Alias for `content`. */
  message?: string | object;
  /** Alias for `content`. */
  text?: string | object;
  /** Alias for `content`. */
  body?: string | object;
  /** Alias for `content`. */
  payload?: string | object;
  /** Reply-to agent ID; falls back to `from`. */
  replyTo?: string;
  /** Snake_case alias for `replyTo`. */
  in_reply_to?: string;
  /** CamelCase alias for `replyTo`. */
  inReplyTo?: string;
  /** Snake_case alias for `replyTo`. */
  reply_to?: string;
  /** Classification tag; falls back to `metadata.type`, then `'message'`. */
  type?: string;
  /** Metadata copied onto the envelope; `correlation_id`/`correlationId` are merged in as `correlationId`. */
  metadata?: Record<string, unknown>;
  /** Correlation ID written to `metadata.correlationId`. */
  correlation_id?: string;
  /** CamelCase alias for `correlation_id`. */
  correlationId?: string;
}

/**
 * Filter, pagination, and inspection options for `MessagingBus#listInbox`.
 *
 * Interface `ListInboxOptions`.
 * - `status` (`'unread' | 'read' | 'all'`) - Storage partition filter (`'unread'`, `'read'`, or `'all'`). Defaults to `'unread'`.
 * - `unreadOnly` (`boolean`) - Boolean flag filtering for unread messages only.
 * - `unread_only` (`boolean`) - Snake_case alias for `unreadOnly`.
 * - `readOnly` (`boolean`) - Boolean flag filtering for read/archived messages only.
 * - `read_only` (`boolean`) - Snake_case alias for `readOnly`.
 * - `sender` (`string`) - Filter messages sent by a specific agent ID.
 * - `from` (`string`) - Alias for `sender`.
 * - `limit` (`number`) - Maximum number of header summaries to return.
 * - `offset` (`number`) - Number of entries to skip for pagination.
 * - `skip` (`number`) - Alias for `offset`.
 * - `max` (`number`) - Alias for `limit`.
 * - `count` (`number`) - Alias for `limit`.
 * - `pageSize` (`number`) - Alias for `limit`.
 * - `page_size` (`number`) - Snake_case alias for `limit`.
 *
 * @example
 * ```typescript
 * const options: ListInboxOptions = {
 *   status: 'unread',
 *   sender: 'supervisor',
 *   limit: 10
 * };
 * ```
 */
export interface ListInboxOptions {
  /** Partition to inspect: `'unread'` (active queue), `'read'` (archive), or `'all'`; defaults to `'unread'`. */
  status?: 'unread' | 'read' | 'all';
  /** Restrict to the active unread queue; equivalent to `status: 'unread'`. */
  unreadOnly?: boolean;
  /** Snake_case alias for `unreadOnly`. */
  unread_only?: boolean;
  /** Restrict to the read archive; equivalent to `status: 'read'`. */
  readOnly?: boolean;
  /** Snake_case alias for `readOnly`. */
  read_only?: boolean;
  /** Keep envelopes whose `from` equals this agent ID. */
  sender?: string;
  /** Alias for `sender`. */
  from?: string;
  /** Maximum number of summaries returned; applied only when positive. */
  limit?: number;
  /** Number of leading matches to skip for pagination; applied only when positive. */
  offset?: number;
  /** Alias for `offset`, consulted when `offset` is not a positive number. */
  skip?: number;
  /** Alias for `limit`, consulted when `limit` is not a number. */
  max?: number;
  /** Alias for `limit`, consulted when `limit` and `max` are not numbers. */
  count?: number;
  /** Alias for `limit`, consulted when `limit`, `max`, and `count` are not numbers. */
  pageSize?: number;
  /** Snake_case alias for `limit`, consulted when no other limit alias is a number. */
  page_size?: number;
}

/**
 * Compatibility type alias for `ListInboxOptions`.
 */
export type InboxListOptions = ListInboxOptions;

/**
 * Options passed to `MessagingBus#readMessage`.
 *
 * Interface `ReadMessageOptions`.
 * - `markAsRead` (`boolean`) - If `true` (default), dequeues envelope from active unread queue into archive. If `false`, leaves in unread queue.
 * - `mark_as_read` (`boolean`) - Snake_case alias for `markAsRead`.
 * - `markRead` (`boolean`) - CamelCase alias for `markAsRead`.
 *
 * @example
 * ```typescript
 * const options: ReadMessageOptions = { markAsRead: false }; // Non-destructive read
 * ```
 */
export interface ReadMessageOptions {
  /** When `true` (the default), dequeue the envelope into the archive; when `false`, return it without mutating the queue. */
  markAsRead?: boolean;
  /** Snake_case alias for `markAsRead`. */
  mark_as_read?: boolean;
  /** CamelCase alias for `markAsRead`. */
  markRead?: boolean;
}

/**
 * Search and filter options for `MessagingBus#getArchive`.
 *
 * Interface `ArchiveQueryOptions`.
 * - `sender` (`string`) - Filter archived messages by sender agent ID.
 * - `from` (`string`) - Alias for `sender`.
 * - `messageId` (`string`) - Filter by exact message identifier.
 * - `id` (`string`) - Alias for `messageId`.
 * - `since` (`number`) - Filter messages with `timestamp >= since` (Unix epoch ms).
 * - `search` (`string`) - Case-insensitive substring search within message `content`.
 * - `limit` (`number`) - Maximum number of archived envelopes to return (defaults to 20).
 * - `offset` (`number`) - Number of matching envelopes to skip for pagination.
 * - `skip` (`number`) - Alias for `offset`.
 * - `max` (`number`) - Alias for `limit`.
 * - `count` (`number`) - Alias for `limit`.
 * - `pageSize` (`number`) - Alias for `limit`.
 * - `page_size` (`number`) - Snake_case alias for `limit`.
 * - `after` (`number`) - Alias for `since`.
 *
 * @example
 * ```typescript
 * const options: ArchiveQueryOptions = {
 *   sender: 'director',
 *   search: 'error report',
 *   since: Date.now() - 3600000,
 *   limit: 5
 * };
 * ```
 */
export interface ArchiveQueryOptions {
  /** Keep envelopes whose `from` matches this agent ID. */
  sender?: string;
  /** Alias for `sender`. */
  from?: string;
  /** Keep only the envelope whose `id` or `messageId` matches. */
  messageId?: string;
  /** Alias for `messageId`. */
  id?: string;
  /** Keep envelopes with `timestamp >= since` (Unix epoch milliseconds). */
  since?: number;
  /** Case-insensitive substring match against stringified message content. */
  search?: string;
  /** Maximum number of envelopes returned; defaults to `20`. */
  limit?: number;
  /** Number of leading matches to skip for pagination; applied only when positive. */
  offset?: number;
  /** Alias for `offset`, consulted when `offset` is not a positive number. */
  skip?: number;
  /** Alias for `limit`, consulted when `limit` is not a number. */
  max?: number;
  /** Alias for `limit`, consulted when `limit` and `max` are not numbers. */
  count?: number;
  /** Alias for `limit`, consulted when `limit`, `max`, and `count` are not numbers. */
  pageSize?: number;
  /** Snake_case alias for `limit`, consulted when no other limit alias is a number. */
  page_size?: number;
  /** Alias for `since`, consulted when `since` is not a number. */
  after?: number;
}

/**
 * Configuration options for blocking mail wait in `MessagingBus#waitForMail`.
 *
 * Interface `WaitForMailOptions`.
 * - `senders` (`string[] | string`) - Array of sender agent IDs or single sender ID string to await.
 * - `sender` (`string`) - Alias for single sender ID in `senders`.
 * - `from` (`string`) - Alias for single sender ID in `senders`.
 * - `sender_id` (`string`) - Snake_case alias for single sender ID in `senders`.
 * - `senderId` (`string`) - CamelCase alias for single sender ID in `senders`.
 * - `from_agent` (`string`) - Snake_case alias for single sender ID in `senders`.
 * - `fromAgent` (`string`) - CamelCase alias for single sender ID in `senders`.
 * - `timeoutMs` (`number`) - Maximum duration in milliseconds to wait before timing out (defaults to 10000 ms).
 * - `timeout_ms` (`number`) - Snake_case alias for `timeoutMs`.
 * - `timeout` (`number`) - Shorthand alias for `timeoutMs`.
 * - `requireAll` (`boolean`) - If `true` (default), waits until at least one message arrives from EACH sender in `senders`. If `false`, resolves on the first message from ANY sender.
 * - `require_all` (`boolean`) - Snake_case alias for `requireAll`.
 * - `markAsRead` (`boolean`) - If `true` (default), dequeues received messages from active queue into archive.
 * - `mark_as_read` (`boolean`) - Snake_case alias for `markAsRead`.
 * - `markRead` (`boolean`) - CamelCase alias for `markAsRead`.
 * - `includeRead` (`boolean`) - If `true`, checks existing archive in addition to active unread queue (defaults to `false`).
 * - `include_read` (`boolean`) - Snake_case alias for `includeRead`.
 * - `since` (`number`) - Only consider messages dispatched at or after this millisecond timestamp.
 * - `sinceTimestamp` (`number`) - Alias for `since`.
 * - `after` (`number`) - Alias for `since`.
 * - `signal` (`AbortSignal | null`) - `AbortSignal` instance for cooperative cancellation.
 * - `abortSignal` (`AbortSignal | null`) - Alias for `signal`.
 *
 * @example
 * ```typescript
 * const options: WaitForMailOptions = {
 *   senders: ['worker_a', 'worker_b'],
 *   timeoutMs: 15000,
 *   requireAll: true,
 *   markAsRead: true
 * };
 * ```
 */
export interface WaitForMailOptions {
  /** Sender IDs to await, or a single sender ID string; an empty list or `'*'`/`'all'` matches any sender. */
  senders?: string[] | string;
  /** Alias for a single entry in `senders`. */
  sender?: string;
  /** Alias for a single entry in `senders`. */
  from?: string;
  /** Snake_case alias for a single entry in `senders`, consulted in the object-parameter call form after `senders`, `sender`, and `from`. */
  sender_id?: string;
  /** CamelCase alias for a single entry in `senders`, consulted in the object-parameter call form after `senders`, `sender`, and `from`. */
  senderId?: string;
  /** Snake_case alias for a single entry in `senders`, consulted in the object-parameter call form after `senders`, `sender`, and `from`. */
  from_agent?: string;
  /** CamelCase alias for a single entry in `senders`, consulted in the object-parameter call form after `senders`, `sender`, and `from`. */
  fromAgent?: string;
  /** Deadline in milliseconds; negative values are clamped to `0`; defaults to `10000`. */
  timeoutMs?: number;
  /** Snake_case alias for `timeoutMs`. */
  timeout_ms?: number;
  /** Shorthand alias for `timeoutMs`. */
  timeout?: number;
  /** When `true` (the default), every listed sender must deliver before resolving; when `false`, the first matching message resolves the wait. */
  requireAll?: boolean;
  /** Snake_case alias for `requireAll`. */
  require_all?: boolean;
  /** When `true` (the default), consumed active-queue messages move to the archive; `includeRead` matches are already archived. */
  markAsRead?: boolean;
  /** Snake_case alias for `markAsRead`. */
  mark_as_read?: boolean;
  /** CamelCase alias for `markAsRead`, consulted after `mark_as_read` and `markAsRead`. */
  markRead?: boolean;
  /** When `true`, pre-existing archived matches satisfy the wait without being dequeued; defaults to `false`. */
  includeRead?: boolean;
  /** Snake_case alias for `includeRead`. */
  include_read?: boolean;
  /** Ignore messages with `timestamp` before this Unix epoch millisecond value. */
  since?: number;
  /** Alias for `since`, consulted before `since` and `after`. */
  sinceTimestamp?: number;
  /** Alias for `since`, consulted when `sinceTimestamp` and `since` are not numbers. */
  after?: number;
  /** Abort signal that resolves the wait with `ABORTED`; an already-aborted signal resolves before subscribing. */
  signal?: AbortSignal | null;
  /** Alias for `signal`. */
  abortSignal?: AbortSignal | null;
}

/**
 * Filter criteria for inspecting global session audit logs via `MessagingBus#getAuditLog`.
 *
 * Interface `AuditLogFilter`.
 * - `agentId` (`string`) - Filter messages where `from === agentId`, `to === agentId`, or the broadcast target is `'all'`.
 * - `from` (`string`) - Filter messages authored by sender `from`.
 * - `to` (`string`) - Filter messages addressed to recipient `to`.
 * - `type` (`string`) - Filter by message semantic classification type.
 * - `since` (`number`) - Filter messages with `timestamp >= since` (Unix epoch ms).
 * - `limit` (`number`) - Maximum audit log entries to return.
 *
 * @example
 * ```typescript
 * const filter: AuditLogFilter = {
 *   agentId: 'director_agent',
 *   type: 'task',
 *   limit: 50
 * };
 * ```
 */
export interface AuditLogFilter {
  /** Keep entries where `from` or `to` equals this agent ID, plus every broadcast (targeted at `'all'`). */
  agentId?: string;
  /** Keep entries authored by this sender. */
  from?: string;
  /** Keep entries addressed to this recipient. */
  to?: string;
  /** Keep entries with this message type. */
  type?: string;
  /** Keep entries with `timestamp >= since` (Unix epoch milliseconds). */
  since?: number;
  /** Maximum number of entries returned; applied only when positive. */
  limit?: number;
}

/**
 * Parameter options for embedding virtual files into messages via `MessagingBus#inlineFileInMessage`.
 *
 * Interface `InlineFileOptions`.
 * - `file_path` (`string`) - Path of the file in VirtualFS to inline.
 * - `filePath` (`string`) - CamelCase alias for `file_path`.
 * - `path` (`string`) - Shorthand alias for `file_path`.
 * - `recipient` (`string`) - Target recipient agent ID.
 * - `to` (`string`) - Alias for `recipient`.
 * - `targetAgentId` (`string`) - CamelCase alias for `recipient`.
 * - `target_agent_id` (`string`) - Snake_case alias for `recipient`.
 * - `recipient_id` (`string`) - Snake_case alias for `recipient`.
 * - `recipientId` (`string`) - CamelCase alias for `recipient`.
 * - `from` (`string`) - Sender agent ID attributing the inlined file message; when a context object is supplied the context caller is the only sender and VirtualFS read identity, so this field is never promoted (MOD-21 W10-B); it is the direct-API sender fallback only for genuinely contextless calls.
 * - `sender` (`string`) - Alias for `from`.
 * - `callerAgentId` (`string`) - Payload alias for `from`, consulted only for genuinely contextless direct-API calls (never when a context object is supplied).
 * - `workspaceId` (`string`) - VirtualFS workspace identifier scoping the file read; when a context object is supplied, `context.workspaceId` is the only source.
 * - `message` (`string`) - Accompanying message or instructions.
 * - `content` (`string`) - Alias for `message`.
 * - `text` (`string`) - Alias for `message`.
 * - `body` (`string`) - Alias for `message`.
 * - `template` (`string`) - Optional custom Markdown template string for formatting inlined content.
 * - `replyTo` (`string`) - Designated reply-to agent ID.
 * - `in_reply_to` (`string`) - Alias for `replyTo`.
 * - `reply_to` (`string`) - Snake_case alias for `replyTo`.
 * - `metadata` (`Record<string, unknown>`) - Metadata dictionary attached to the message.
 * - `virtualFs` (`VirtualFS | null`) - Optional VirtualFS instance for genuinely contextless direct-API calls; when a context object is supplied, `context.virtualFs` is the only source (MOD-21 W10-B).
 *
 * @example
 * ```typescript
 * const options: InlineFileOptions = {
 *   filePath: '/reports/q3_summary.md',
 *   recipient: 'executive_agent',
 *   from: 'analyst',
 *   message: 'Please find attached the Q3 summary report.'
 * };
 * ```
 */
export interface InlineFileOptions {
  /** VirtualFS path of the file to inline. */
  file_path?: string;
  /** CamelCase alias for `file_path`. */
  filePath?: string;
  /** Shorthand alias for `file_path`. */
  path?: string;
  /** Target recipient agent ID. */
  recipient?: string;
  /** Alias for `recipient`. */
  to?: string;
  /** CamelCase alias for `recipient`. */
  targetAgentId?: string;
  /** Snake_case alias for `recipient`. */
  target_agent_id?: string;
  /** Snake_case alias for `recipient`; consulted in the object-parameter call form. */
  recipient_id?: string;
  /** CamelCase alias for `recipient`; consulted in the object-parameter call form. */
  recipientId?: string;
  /** Sender agent ID attributed to the outgoing message; when a context object is supplied the context caller is the only sender and VirtualFS read identity, so this field is never promoted; it is the direct-API fallback only for genuinely contextless calls (MOD-21 W10-B). */
  from?: string;
  /** Alias for `from`. */
  sender?: string;
  /** Payload alias for `from`, consulted only for genuinely contextless direct-API calls (never when a context object is supplied). */
  callerAgentId?: string;
  /** VirtualFS workspace scoping the file read; when a context object is supplied, `context.workspaceId` is the only source. */
  workspaceId?: string;
  /** Text prepended to the inlined content in the default formatted block. */
  message?: string;
  /** Alias for `message`. */
  content?: string;
  /** Alias for `message`. */
  text?: string;
  /** Alias for `message`. */
  body?: string;
  /** Custom template with `${content}`, `${file}`, `${filePath}`, or `${file_path}` placeholders; replaces the default formatted block. */
  template?: string;
  /** Reply-to agent ID; falls back to `from`. */
  replyTo?: string;
  /** Snake_case alias for `replyTo`. */
  in_reply_to?: string;
  /** Snake_case alias for `replyTo`. */
  reply_to?: string;
  /** Metadata dictionary attached to the outgoing message. */
  metadata?: Record<string, unknown>;
  /** VirtualFS instance used for the read; when a context object is supplied, `context.virtualFs` is the only source (MOD-21 W10-B); a missing instance yields `VFS_UNAVAILABLE`. */
  virtualFs?: VirtualFS | null;
}

/**
 * Optional constructor dependencies for `MessagingBus`.
 * Every field defaults to the corresponding host runtime primitive when omitted,
 * preserving identical behavior when not injected.
 *
 * Interface `MessagingBusOptions`.
 * - `idGenerator` (`() => string`) - Message ID generator (defaults to global `crypto.randomUUID`, with a timestamp/random fallback).
 * - `clone` (`(value: MessagingBusSnapshot) => MessagingBusSnapshot`) - Snapshot deep-clone utility (defaults to global `structuredClone`, with a JSON fallback).
 * - `byteLength` (`(value: string) => number`) - UTF-8 byte counter fallback for inlined file content when the VirtualFS receipt omits `bytesIncluded` (defaults to global `Buffer.byteLength`, with a string-length fallback).
 *
 * @example
 * ```typescript
 * const bus = new MessagingBus({
 *   idGenerator: () => 'msg_deterministic_1',
 *   clone: (value) => structuredClone(value),
 *   byteLength: (value) => new TextEncoder().encode(value).length
 * });
 * ```
 */
export interface MessagingBusOptions {
  /** Message ID factory; defaults to `crypto.randomUUID` with a `msg_<timestamp>_<random>` fallback. Non-function values are ignored. */
  readonly idGenerator?: () => string;
  /** Deep-clone utility used by `exportSnapshot`; defaults to `structuredClone` with a JSON round-trip fallback. Non-function values are ignored. */
  readonly clone?: (value: MessagingBusSnapshot) => MessagingBusSnapshot;
  /** UTF-8 byte counter fallback for inlined files when `bytesIncluded` is absent; defaults to `Buffer.byteLength` with a string-length fallback. Non-function values are ignored. */
  readonly byteLength?: (value: string) => number;
  /**
   * Trusted identity resolver used to re-derive bus policy privilege (MOD-21
   * W4). Injected by the composition root; when absent every registration is
   * default-deny unless it carries the injected internal principal reference.
   */
  readonly identityPort?: MessagingBusIdentityPort | null;
  /**
   * Opaque engine-internal principal reference (MOD-21). Only this exact
   * object marks a trusted internal registration.
   */
  readonly internalPrincipal?: object | null;
}

/**
 * Trusted identity projection consumed by the bus policy resolver.
 *
 * Structural mirror of the MOD-13 `AgentIdentityPort` projection; the canonical
 * definition lives in `runtime/index.ts`.
 */
export interface MessagingBusIdentityProjection {
  /** Registered agent identifier. */
  readonly id?: string;
  /**
   * Canonical internal identity key of the registration (Wave I, ticket
   * d57cbc1): the `(realmId, agentId)` composite owned by the runtime. The bus
   * partitions mailboxes on the identifier received at registration and maps
   * bare refs to it through this field; the key is internal-only and never
   * appears in receipts, listings, errors or payloads. Optional and additive:
   * a producer that omits it keeps the legacy bare-id partition.
   */
  readonly key?: string;
  /**
   * Legacy boolean privilege projection.
   * @deprecated Honored only as a fallback when `authority` is absent.
   */
  readonly privileged?: boolean;
  /** Frozen authority descriptor resolved by the identity port. */
  readonly authority?: {
    /** Stable principal identifier. */
    readonly subject: string;
    /** Principal class: a registered agent or an engine-internal path. */
    readonly kind: 'agent' | 'internal';
    /** Frozen set (or test-double array) of canonical tool/op names; `'*'` permits everything. */
    readonly allow: ReadonlySet<string> | readonly string[];
    /** Read/operation scope; `'all'` and `'system'` grant policy privilege. */
    readonly visibility: 'self' | 'owned' | 'all' | 'system';
  };
  /**
   * Realm membership resolved by the runtime identity projection (Realm wave A).
   * Optional and additive: projections produced before the runtime wiring lands
   * carry no `realmId`, which resolves to the ungrouped legacy scope.
   */
  readonly realmId?: string | null;
  /**
   * Whether the subject bypasses Realm scoping (the injected internal principal
   * or the hardcoded system director). Optional and additive; absent means
   * realm-bound when `realmId` is present.
   */
  readonly realmBypass?: boolean;
}

/**
 * Trusted resolution scope accepted by the identity port (Wave I, ticket
 * d57cbc1). Mirrors the runtime `AgentIdentityScope`: a realm-exact scope
 * (`realmId`, no bypass) resolves exactly `(realmId, agentId)` (the system
 * scope for `null`), while an omitted or `realmBypass` scope keeps the legacy
 * unique-match rule (an id registered in more than one Realm resolves `null` —
 * fail closed, never a wrong-Realm pick).
 */
export interface MessagingBusIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm. */
  readonly realmBypass?: boolean;
}

/**
 * Trusted identity resolver injected into the bus (default-deny when absent).
 * Structural mirror of the MOD-13 `AgentIdentityPort`.
 */
export interface MessagingBusIdentityPort {
  /**
   * Resolves the identity projection of a registered agent, or `null` when no
   * trusted principal matches the subject.
   *
   * @param agentId - Registered agent subject to resolve.
   * @param scope - Optional trusted Realm resolution scope (Wave I, ticket
   *   d57cbc1); an omitted scope keeps the legacy unique-match behavior.
   * @returns Frozen identity projection or `null` (anonymous).
   */
  getAgentIdentity(agentId: string, scope?: MessagingBusIdentityScope): MessagingBusIdentityProjection | null;
  /**
   * Enumerates the active registrations a scope can resolve (Wave I, ticket
   * d57cbc1): realm-bound scopes enumerate exactly that Realm, omitted or
   * bypass scopes enumerate every active registration. Optional and additive:
   * a legacy producer that omits it keeps the registered-set fan-out fallback.
   *
   * @param scope - Optional trusted Realm resolution scope.
   * @returns Frozen identity projections in registry insertion order.
   */
  listAgentIdentities?(scope?: MessagingBusIdentityScope): MessagingBusIdentityProjection[];
}

// ============================================================================
// Snapshot & Serialization Interfaces
// ============================================================================

/**
 * Deep-cloned JSON snapshot representation of the entire messaging bus state for persistence serialization.
 *
 * Interface `MessagingBusSnapshot`.
 * - `auditLog` (`MessageEnvelope[]`) - Chronological list of all envelopes routed across the session; every entry carries the persisted `success` delivery flag.
 * - `activeQueues` (`Record<string, MessageEnvelope[]>`) - Map of agent IDs to unread active envelope queues.
 * - `archives` (`Record<string, MessageEnvelope[]>`) - Map of agent IDs to consumed historical envelope archives.
 * - `inboxes` (`Record<string, MessageEnvelope[]>`) - Legacy alias emitted for `activeQueues`; `importSnapshot` partitions it by `read` when `activeQueues` is absent.
 * - `registeredAgents` (`Record<string, { mode: 'queued' }>`) - Map of registered agent IDs to routing configurations; trust is never persisted (MOD-21 W4).
 * - `terminatedAgents` (`string[]`) - List of terminated agent IDs.
 *
 * @example
 * ```typescript
 * const snapshot: MessagingBusSnapshot = bus.exportSnapshot();
 * console.log(`Persisted ${snapshot.auditLog.length} messages for ${Object.keys(snapshot.registeredAgents).length} agents.`);
 * ```
 */
export interface MessagingBusSnapshot {
  /** Chronological copies of every envelope recorded by the bus. */
  readonly auditLog: MessageEnvelope[];
  /** Map of agent ID to unconsumed envelopes, oldest first. */
  readonly activeQueues: Record<string, MessageEnvelope[]>;
  /** Map of agent ID to consumed envelopes (`read: true`), in append order. */
  readonly archives: Record<string, MessageEnvelope[]>;
  /** Legacy alias emitted for `activeQueues`; `importSnapshot` partitions it by `read` when `activeQueues` is absent. */
  readonly inboxes?: Record<string, MessageEnvelope[]>; // Compatibility alias
  /** Map of registered agent ID to its routing record; `mode` is always `'queued'` and privilege is never serialized (MOD-21 W4). */
  readonly registeredAgents: Record<string, { mode: 'queued' }>;
  /** IDs currently marked as terminated. */
  readonly terminatedAgents: string[];
}

/**
 * Unsubscribe callback function returned by `MessagingBus#subscribe`.
 * Invoking this function unbinds the listener to prevent memory leaks.
 *
 * Callback `UnsubscribeFn`.
 * @returns void
 *
 * @example
 * ```typescript
 * const unsubscribe = bus.subscribe('agent_a', (msg) => { ... });
 * // Cleanup on unmount / teardown:
 * unsubscribe();
 * ```
 */
export type UnsubscribeFn = () => void;

// ============================================================================
// Agent-Scoped Proxy Interface
// ============================================================================

/**
 * Ergonomic agent-bound messaging proxy returned by `MessagingBus#forAgent(agentId)`.
 * Pre-binds the caller agent ID into all messaging operations, eliminating repetitive parameter passing.
 *
 * Interface `AgentMessagingProxy`.
 * - `agentId` (`string`) - The bound agent ID for this proxy instance.
 */
export interface AgentMessagingProxy {
  /**
   * The bound agent ID for this proxy instance.
   */
  readonly agentId: string;

  /**
   * Sends a point-to-point message with this bound agent ID as the authoritative sender.
   * Payload `from`/`sender` fields are stripped: they cannot override the bound sender.
   *
   * @param toOrPayload - Recipient agent ID or full `SendMessageOptions` object.
   * @param content - Message content string or serializable object.
   * @param metadata - Metadata dictionary.
   * @param replyTo - Designated reply-to agent ID (defaults to the bound agent ID).
   * @returns Synchronous delivery receipt.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * const receipt = proxy.sendMessage('director', 'Task initialized');
   * ```
   */
  sendMessage(
    toOrPayload: string | SendMessageOptions,
    content?: string | object,
    metadata?: Record<string, unknown>,
    replyTo?: string
  ): SendMessageReceipt;

  /**
   * Broadcasts a message from this bound agent to all other registered, non-terminated agents
   * that share the bound agent's Realm scope; a `realmBypass` sender spans every scope (Realm wave A;
   * one-way bypass, Realm wave R ticket cf0e127).
   *
   * @param content - Broadcast message content string or object.
   * @param metadata - Optional metadata dictionary.
   * @param replyTo - Designated reply-to agent ID.
   * @returns Broadcast delivery receipt containing recipients list.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('coordinator');
   * const receipt = proxy.broadcast('System entering maintenance mode.');
   * console.log(`Broadcast reached ${receipt.recipients?.length} agents.`);
   * ```
   */
  broadcast(
    content: string | object,
    metadata?: Record<string, unknown>,
    replyTo?: string
  ): SendMessageReceipt;

  /**
   * Non-destructively peeks at this bound agent's inbox headers without dequeuing envelopes.
   *
   * @param options - Filter, pagination, and status options.
   * @returns Array of header summaries with 80-character previews.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * const unreadHeaders = proxy.listInbox({ status: 'unread' });
   * ```
   */
  listInbox(options?: ListInboxOptions): MessageHeaderSummary[];

  /**
   * Reads a specific message by ID for this bound agent.
   * Atomically dequeues from active unread queue to archive if `markAsRead: true` (default).
   *
   * @param messageId - Unique identifier of the message to read.
   * @param options - Read options (e.g. `markAsRead`) or a bare boolean `markAsRead` override.
   * @returns Result object containing retrieved envelope and status.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * const result = proxy.readMessage('msg_123');
   * ```
   */
  readMessage(messageId: string, options?: ReadMessageOptions | boolean): ReadMessageResult;

  /**
   * Atomically drains and consumes all unread messages from this bound agent's active queue into archive.
   *
   * @returns Array of consumed envelopes with `read: true`. Subsequent calls return `[]`.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * const pending = proxy.drainInbox();
   * for (const msg of pending) {
   *   console.log(`Processing: ${msg.content}`);
   * }
   * ```
   */
  drainInbox(): MessageEnvelope[];

  /**
   * Queries historical consumed message envelopes from this bound agent's archive.
   *
   * @param options - Filter, search, and pagination criteria.
   * @returns Array of matching archived envelopes.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * const pastMessages = proxy.getArchive({ sender: 'director', limit: 10 });
   * ```
   */
  getArchive(options?: ArchiveQueryOptions): MessageEnvelope[];

  /**
   * Returns the current count of pending unread messages in this bound agent's active queue ($O(1)$).
   *
   * @returns Unread message count.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * if (proxy.getUnreadCount() > 0) {
   *   const mail = proxy.drainInbox();
   * }
   * ```
   */
  getUnreadCount(): number;

  /**
   * Subscribes a real-time message delivery handler for messages addressed to this bound agent.
   *
   * @param handler - Callback invoked when a message arrives.
   * @returns Teardown function to unsubscribe the handler.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('worker_1');
   * const unsub = proxy.subscribe((msg) => {
   *   console.log(`New message arrived: ${msg.id}`);
   * });
   * ```
   */
  subscribe(handler: (message: MessageEnvelope) => void): UnsubscribeFn;

  /**
   * Asynchronously awaits incoming messages addressed to this bound agent from specified senders.
   * Dequeues matching messages on receipt.
   *
   * @param optionsOrSenders - Wait options or list of sender IDs.
   * @param maybeOptions - Additional wait options when sender list is passed as first argument.
   * @returns Promise resolving with received messages or timeout information.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('orchestrator');
   * const result = await proxy.waitForMail({ senders: ['worker_a', 'worker_b'], timeoutMs: 5000 });
   * ```
   */
  waitForMail(
    optionsOrSenders?: WaitForMailOptions | string[] | string,
    maybeOptions?: WaitForMailOptions
  ): Promise<WaitForMailResult>;

  /**
   * Reads a virtual file from VirtualFS and sends it from this bound agent.
   * The options object may override `filePath`/`recipient`, but the bound agent ID remains
   * the authoritative sender: `from`/`sender`/`callerAgentId` options cannot override it.
   *
   * @param filePath - Path of the file in VirtualFS to inline.
   * @param recipient - Target recipient agent ID.
   * @param options - Additional inline file options.
   * @returns Result of the inline file send operation.
   *
   * @example
   * ```typescript
   * const proxy = bus.forAgent('analyst');
   * const result = await proxy.inlineFileInMessage('/workspace/report.json', 'director');
   * ```
   */
  inlineFileInMessage(
    filePath: string,
    recipient: string,
    options?: InlineFileOptions
  ): Promise<InlineFileMessageResult>;
}

// ============================================================================
// File-Private Helpers
// ============================================================================

/**
 * Generates a unique UUID or random message ID string.
 *
 * @returns A fresh message identifier.
 */
function generateMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * MOD-21 W4 authority predicate: reports whether a frozen `AuthorityDescriptor`
 * (resolved through the injected identity port) grants privileged bus policy.
 *
 * A descriptor grants privilege when its `visibility` is `'all'` or
 * `'system'`, or when its `allow` set carries the `'*'` wildcard. Every other
 * shape (absent descriptor, `'self'`/`'owned'` visibility, explicit tool list)
 * is default-deny.
 *
 * @param authority - Authority descriptor resolved by the identity port.
 * @returns `true` only when the descriptor carries a privilege grant.
 */
function authorityGrantsSubstratePrivilege(
  authority: MessagingBusIdentityProjection['authority'] | null | undefined
): boolean {
  if (!authority || typeof authority !== 'object') return false;
  if (authority.visibility === 'all' || authority.visibility === 'system') return true;
  const allow = authority.allow;
  if (allow instanceof Set) return allow.has('*');
  if (Array.isArray(allow)) return allow.includes('*');
  return false;
}

/**
 * Trusted Realm scope resolved for one agent subject from the injected identity
 * projection (Realm wave A).
 */
interface ResolvedRealmScope {
  /** Non-empty realm id for realm-bound subjects, else `null` (ungrouped). */
  realmId: string | null;
  /** Whether the subject bypasses Realm scoping (internal principal / system director). */
  realmBypass: boolean;
}

/**
 * Trusted bus subject resolved through the injected identity port (Wave I,
 * ticket d57cbc1): the port projection when one resolves, the bare `id` the
 * module may surface to agents, and the effective Realm scope. Substrate
 * partitioning still keys on the opaque registration identifier, never on
 * `id`.
 */
interface ResolvedBusSubject {
  /** Bare agent id (agent-visible), or the empty string when the port omits it. */
  readonly id: string;
  /** Trusted identity projection, or `null` for legacy/unresolved subjects. */
  readonly projection: MessagingBusIdentityProjection | null;
  /** Effective Realm scope (bypass subjects resolve to `realmId: null`). */
  readonly realmId: string | null;
  /** Whether the subject bypasses Realm scoping. */
  readonly realmBypass: boolean;
}

/**
 * Recipient classification produced by scoped resolution (Wave I, ticket
 * d57cbc1). A `resolved` recipient keeps the projection-derived mailbox key;
 * `unknown` and `ambiguous` refs carry no projection and keep the legacy
 * dead-letter / opaque-denial semantics.
 */
interface ResolvedRecipient {
  /** Resolution outcome: deliverable target, unknown ref, or ambiguous bare id. */
  readonly kind: 'resolved' | 'unknown' | 'ambiguous';
  /** Bare agent id to surface in receipts/listings/errors. */
  readonly id: string;
  /** Opaque partition key to enqueue into (registration identifier). */
  readonly mailboxKey: string;
  /** Trusted projection when one resolved, else `null`. */
  readonly projection: MessagingBusIdentityProjection | null;
  /** Recipient Realm membership resolved from the projection. */
  readonly realmId: string | null;
  /** Whether the recipient bypasses Realm scoping. */
  readonly realmBypass: boolean;
  /** Whether the sender's scope may deliver to this recipient. */
  readonly scopeAllowed: boolean;
}

/**
 * Structural view of a trusted context bag that can carry the engine-internal
 * principal reference (the Realm bypass channel for host/operator calls).
 */
interface RealmPrincipalSource {
  /** Exact engine-internal principal reference, present only on host calls. */
  readonly principal?: unknown;
  /** Additional contextual fields (structural view of the execution context bag). */
  readonly [key: string]: unknown;
}

/**
 * MOD-21 W8-D: resolves the trusted caller identity carried by an execution
 * context, if any. Payload identity fields are caller data; when the context
 * binds a caller (`callerAgentId`/`agentId`), it outranks them.
 *
 * @param context - Trailing trusted-context argument.
 * @returns Caller agent ID when the context binds one; `null` otherwise.
 */
function resolveContextCallerId(context: ExecutionContext | null | undefined): string | null {
  if (!context || typeof context !== 'object') return null;
  const candidate = context.callerAgentId || context.agentId;
  return (typeof candidate === 'string' && candidate) ? candidate : null;
}

/**
 * MOD-21 W8-D defense in depth: removes caller-supplied routing identity keys
 * from a merged options bag once the trusted context has supplied the mailbox
 * or sender. Documented sender filter keys (`from`/`sender`) are preserved.
 *
 * @param options - Merged options bag to scrub in place.
 * @returns The same options bag without caller routing identity keys.
 */
function scrubPayloadRoutingKeys<T extends Record<string, unknown>>(options: T): T {
  if (!options || typeof options !== 'object') return options;
  delete options.agentId;
  delete options.agent_id;
  delete options.callerAgentId;
  delete options.caller_agent_id;
  delete options.recipient;
  delete options.recipientId;
  delete options.recipient_id;
  delete options.targetAgentId;
  delete options.target_agent_id;
  return options;
}

/**
 * MOD-21 W10-B: stable sender attributed to a supplied but identity-less
 * (anonymous) execution context. The label is fixed by the bus, never
 * selectable from caller payload, so an anonymous context cannot forge another
 * agent's sender identity.
 */
const ANONYMOUS_SENDER_ID = 'anonymous';

/**
 * MOD-21 W10-B: reports whether the trailing trusted-context object of an
 * object-first call was supplied at all. A supplied context object is the only
 * identity/routing authority (its caller binding, or none for an anonymous
 * context); caller-payload identity keys are never promoted when it is
 * present. A genuinely contextless direct-API call (no trailing object) keeps
 * the legacy payload identity channel.
 *
 * @param context - Trailing trusted-context argument.
 * @returns `true` when the argument is a supplied object.
 */
function isContextSupplied(context: unknown): context is ExecutionContext {
  return context !== null && typeof context === 'object';
}

/**
 * MOD-21 W10-B: resolves the effective mailbox/sender identity for an
 * object-first call. When a context object was supplied, its caller binding is
 * final: a context that binds no caller is anonymous, and no payload identity
 * is promoted (the caller resolves to `null`). Only genuinely contextless
 * direct-API calls may select identity from the payload.
 *
 * @param context - The trailing trusted-context argument.
 * @param contextSupplied - Whether that argument was a supplied object.
 * @param payloadIdentity - Legacy payload identity fallback.
 * @returns Resolved identity, or `null` when anonymous.
 */
function resolveRoutingIdentity(
  context: ExecutionContext | null | undefined,
  contextSupplied: boolean,
  payloadIdentity: unknown
): string | null {
  if (contextSupplied) return resolveContextCallerId(context);
  return (typeof payloadIdentity === 'string' && payloadIdentity) ? payloadIdentity : null;
}

/**
 * Internal mutable metadata bag: caller metadata values stay `unknown` until a
 * declared routing key (`type`, `correlationId`) is narrowed on read.
 */
type MetadataBag = Record<string, unknown>;

/**
 * Structural view of the trailing descriptor/params object promoted by the
 * positional `sendMessage` overload; only the declared aliases are read.
 */
interface PositionalExtraBag {
  from?: string;
  callerAgentId?: string;
  agentId?: string;
  replyTo?: string;
  in_reply_to?: string;
  inReplyTo?: string;
  reply_to?: string;
  metadata?: MetadataBag;
  correlation_id?: string;
  correlationId?: string;
  type?: string;
  principal?: unknown;
}

/**
 * Reads a thrown value's `message` when it exposes a non-empty string,
 * preserving the legacy `err && err.message` fallback for unknown catches.
 *
 * @param err - Caught value of unknown shape.
 * @returns The non-empty message string, or `null`.
 */
function readErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object' || !('message' in err)) return null;
  const message: unknown = err.message;
  return typeof message === 'string' && message ? message : null;
}

/**
 * Reads a non-empty string value from an extensible metadata/options bag.
 * Declared string slots (`type`, correlation and routing keys) narrow through
 * this guard instead of trusting arbitrary caller-supplied values.
 *
 * @param value - Candidate value of unknown shape.
 * @returns The non-empty string, or `undefined` when absent or not a string.
 */
function readMetadataString(value: unknown): string | undefined {
  return (typeof value === 'string' && value) ? value : undefined;
}

/**
 * Layer 0 Core Foundation Primitive: Pure FIFO MessagingBus & Mailbox Store.
 *
 * Governs isolated per-agent mailboxes with strict FIFO dequeue-on-read semantics,
 * an append-only archive store for consumed messages, dead-letter recipient validation,
 * deterministic persistence snapshots, and reactive pub/sub event routing.
 *
 * Module-level guarantees live on the `@packageDocumentation` header
 * (`@invariant`/`@decision` tags); member methods document their own behavior.
 *
 * Class `MessagingBus`.
 *
 * @example
 * ```typescript
 * import { MessagingBus } from './messagingBus/index.ts';
 *
 * const bus = new MessagingBus();
 *
 * // 1. Register agents
 * bus.registerAgent('director', { mode: 'queued' });
 * bus.registerAgent('researcher', { mode: 'queued' });
 *
 * // 2. Send message
 * const receipt = bus.sendMessage({
 *   from: 'director',
 *   to: 'researcher',
 *   content: 'Collect project metrics.'
 * });
 *
 * // 3. Drain unread inbox during researcher turn
 * const unread = bus.drainInbox('researcher');
 * console.log(`Received ${unread.length} task(s).`);
 * ```
 */
export class MessagingBus {
  /**
   * Map of registered agent IDs to unread FIFO message queues.
   * Only unconsumed envelopes reside here.
   */
  #activeQueues: Map<string, MutableMessageEnvelope[]> = new Map();

  /**
   * Map of agent IDs to consumed/read historical message archives.
   */
  #archives: Map<string, MutableMessageEnvelope[]> = new Map();

  /**
   * Set of registered, active agent IDs.
   */
  #registeredAgents: Set<string> = new Set();

  /**
   * Set of agent IDs that have been terminated.
   */
  #terminatedAgents: Set<string> = new Set();

  /**
   * Internal policy configuration for registered agents. `internal` records an
   * explicit engine-internal registration (the injected principal reference);
   * policy privilege is otherwise re-derived from the identity port and never
   * stored.
   */
  #policies: Map<string, { mode: 'queued', internal: boolean }> = new Map();

  /**
   * Bare-id memo for opaque registration identifiers (Wave I, ticket
   * d57cbc1): captured while the identity port still resolves the registration
   * (launch, termination) so agent-facing listings project the bare id even
   * after the agent leaves the active registry. Internal only.
   */
  #registrationIds: Map<string, string> = new Map();

  /**
   * Set of active subscriber objects.
   */
  #subscriptions: Set<{ recipientFilter: string, handler: (message: MessageEnvelope) => void }> = new Set();

  /**
   * Global append-only audit log of all messages routed through the bus.
   */
  #auditLog: MutableMessageEnvelope[] = [];

  /**
   * Optional injected message ID generator (defaults to global `crypto.randomUUID`).
   */
  #idGenerator: (() => string) | null = null;

  /**
   * Optional injected deep-clone utility (defaults to global `structuredClone`).
   */
  #cloneUtil: ((value: MessagingBusSnapshot) => MessagingBusSnapshot) | null = null;

  /**
   * Optional injected UTF-8 byte counter used when a VirtualFS read receipt omits `bytesIncluded`
   * (defaults to global `Buffer.byteLength`).
   */
  #byteLength: ((value: string) => number) | null = null;

  /**
   * Injected identity resolver (`AgentIdentityPort` shape) used to resolve an
   * agent subject into its trusted authority descriptor; null means no agent
   * authority is resolvable (default-deny).
   */
  #identityPort: MessagingBusIdentityPort | null = null;

  /**
   * Opaque engine-internal principal reference injected by the composition
   * root. Only this exact object marks a trusted internal registration;
   * caller-supplied policy params never grant privilege.
   */
  #internalPrincipal: object | null = null;

  /**
   * Initializes a new `MessagingBus` instance with segregated private mailbox stores,
   * audit log, and subscriber tracking.
   * Runtime primitives may be injected for deterministic testing; when omitted,
   * the corresponding host globals are used exactly as before.
   *
   * @param options - Optional injected runtime primitives; each defaults
   * to the corresponding host global when omitted.
   */
  constructor(options: MessagingBusOptions = {}) {
    const { idGenerator, clone, byteLength, identityPort = null, internalPrincipal = null } = options;
    this.#idGenerator = typeof idGenerator === 'function' ? idGenerator : null;
    this.#cloneUtil = typeof clone === 'function' ? clone : null;
    this.#byteLength = typeof byteLength === 'function' ? byteLength : null;
    this.#identityPort = (identityPort && typeof identityPort.getAgentIdentity === 'function') ? identityPort : null;
    this.#internalPrincipal = (internalPrincipal && typeof internalPrincipal === 'object') ? internalPrincipal : null;
  }

  /**
   * Binds the engine-internal principal to this instance (composition-root
   * wiring for injected substrates; Wave I, ticket c02d0b9).
   *
   * The runtime mints its opaque principal in its own constructor, so an
   * injected `MessagingBus` instance can never receive it through
   * `MessagingBusOptions.internalPrincipal`. The composition root binds that
   * exact reference here immediately after accepting the injection, mirroring
   * `VirtualFS.bindInternalPrincipal`/`WorldClock.bindInternalPrincipal`.
   * First bind wins: an instance constructed with `internalPrincipal` (or
   * already bound) is never rebound, and a non-object candidate is rejected.
   * The bind validates no further shape or branding — any accepted object
   * reference becomes the trusted principal — so only the exact
   * composition-root reference should ever be passed. Only the exact bound
   * reference marks the engine/operator path for Realm-scope resolution and
   * trusted internal registration; the binding method itself confers no other
   * authority.
   *
   * @param principal - The exact `InternalPrincipal` reference minted by the composition root.
   * @returns True when this call performed the one-time binding.
   *
   * @example
   * ```typescript
   * const bus = new MessagingBus();
   * bus.bindInternalPrincipal(internalPrincipal); // true
   * bus.bindInternalPrincipal(otherPrincipal); // false (never rebound)
   * ```
   */
  bindInternalPrincipal(principal: object): boolean {
    if (this.#internalPrincipal) return false;
    if (!principal || typeof principal !== 'object') return false;
    this.#internalPrincipal = principal;
    return true;
  }

  /**
   * Generates a unique message ID, preferring the injected generator.
   *
   * @returns A fresh message identifier.
   */
  #generateMessageId(): string {
    return this.#idGenerator ? this.#idGenerator() : generateMessageId();
  }

  /**
   * Completely resets all internal active queues, archives, audit logs, registrations,
   * terminations, and subscriptions to empty state.
   *
   * Intended for session teardown routines and test fixture isolation.
   *
   * @returns void
   *
   * @example
   * ```typescript
   * bus.reset();
   * console.log(bus.getRegisteredAgents().length); // 0
   * console.log(bus.getAuditLog().length); // 0
   * ```
   */
  reset(): void {
    this.#activeQueues.clear();
    this.#archives.clear();
    this.#registeredAgents.clear();
    this.#terminatedAgents.clear();
    this.#policies.clear();
    this.#registrationIds.clear();
    this.#subscriptions.clear();
    this.#auditLog = [];
  }

  /**
   * Registers an agent mailbox in the messaging bus.
   * Initializes empty active unread queue and historical archive stores if not present,
   * cleanses terminated status (allowing revival/un-recycling), and records the routing mode.
   *
   * MOD-21 W4: caller-supplied `policy.privileged` is ignored; only
   * `policy.principal ===` the injected internal-principal reference marks a
   * trusted engine registration.
   *
   * @param agentId - Unique identifier of the agent to register. Must be a non-empty string.
   * @param policy - Optional policy configuration (`{ mode: 'queued', principal?: object }`).
   * @returns void
   * @throws `Error` - Thrown if `agentId` is falsy or not a string (`INVALID_ARGUMENTS`).
   *
   * @example
   * ```typescript
   * bus.registerAgent('agent_alpha', { mode: 'queued' });
   * console.log(bus.isRegistered('agent_alpha')); // true
   * ```
   */
  registerAgent(agentId: string, policy: AgentPolicy = {}): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('Valid string agentId is required to register an agent');
    }

    // Cleanses terminated status upon re-registration
    this.#terminatedAgents.delete(agentId);
    this.#registeredAgents.add(agentId);
    this.#rememberRegistrationId(agentId);
    this.#policies.set(agentId, {
      mode: 'queued',
      internal: Boolean(this.#internalPrincipal && policy && policy.principal === this.#internalPrincipal)
    });

    if (!this.#activeQueues.has(agentId)) {
      this.#activeQueues.set(agentId, []);
    }
    if (!this.#archives.has(agentId)) {
      this.#archives.set(agentId, []);
    }
  }

  /**
   * Unregisters an agent from active message routing.
   * Removes agent from registered agents set and unbinds agent-specific direct subscriptions,
   * while preserving existing queues and archives for historical inspection.
   *
   * @param agentId - Unique identifier of the agent to unregister.
   * @returns void
   *
   * @example
   * ```typescript
   * bus.unregisterAgent('agent_alpha');
   * console.log(bus.isRegistered('agent_alpha')); // false
   * ```
   */
  unregisterAgent(agentId: string): void {
    if (!agentId || typeof agentId !== 'string') return;

    this.#rememberRegistrationId(agentId);
    this.#registeredAgents.delete(agentId);
    this.#policies.delete(agentId);

    // Clean up subscriptions bound specifically to this agentId
    for (const sub of this.#subscriptions) {
      if (sub.recipientFilter === agentId) {
        this.#subscriptions.delete(sub);
      }
    }
  }

  /**
   * Marks an agent as terminated.
   * Any subsequent point-to-point messages addressed to this agent will fail immediately
   * with receipt code `AGENT_TERMINATED`. Existing archives remain accessible for inspection.
   *
   * @param agentId - Unique identifier of the agent to terminate.
   * @returns void
   *
   * @example
   * ```typescript
   * bus.markAgentTerminated('agent_alpha');
   * console.log(bus.isAgentTerminated('agent_alpha')); // true
   * const receipt = bus.sendMessage({ from: 'director', to: 'agent_alpha', content: 'Ping' });
   * console.log(receipt.code); // 'AGENT_TERMINATED'
   * ```
   */
  markAgentTerminated(agentId: string): void {
    if (!agentId || typeof agentId !== 'string') return;

    // Capture the bare id while the registration still resolves (Wave I,
    // ticket d57cbc1) so terminated listings stay realm-opaque.
    this.#rememberRegistrationId(agentId);
    this.#terminatedAgents.add(agentId);
    this.unregisterAgent(agentId);
  }

  /**
   * Clears an agent's terminated flag. The agent remains unregistered and cannot
   * receive messages until `registerAgent` is called (which itself cleanses
   * terminated status).
   *
   * @param agentId - Unique identifier of the agent to unmark.
   * @returns void
   *
   * @example
   * ```typescript
   * bus.unmarkAgentTerminated('agent_alpha');
   * console.log(bus.isAgentTerminated('agent_alpha')); // false
   * console.log(bus.isRegistered('agent_alpha')); // still false until registerAgent()
   * ```
   */
  unmarkAgentTerminated(agentId: string): void {
    if (!agentId || typeof agentId !== 'string') return;
    this.#terminatedAgents.delete(agentId);
  }

  /**
   * Permanently and atomically deletes all mailbox stores and registration state for an agent.
   * Wipes active unread queues, historical archives, registration records, termination flags,
   * internal policy records, and direct subscriptions.
   *
   * Eliminates procedural queue hacks (e.g. `bus.inboxes.delete(id)`).
   *
   * @param agentId - Unique identifier of the agent to permanently purge.
   * @returns void
   *
   * @example
   * ```typescript
   * bus.purgeAgent('agent_alpha');
   * console.log(bus.isRegistered('agent_alpha')); // false
   * console.log(bus.getUnreadCount('agent_alpha')); // 0
   * ```
   */
  purgeAgent(agentId: string): void {
    if (!agentId || typeof agentId !== 'string') return;

    this.#activeQueues.delete(agentId);
    this.#archives.delete(agentId);
    this.#registeredAgents.delete(agentId);
    this.#terminatedAgents.delete(agentId);
    this.#policies.delete(agentId);
    this.#registrationIds.delete(agentId);

    for (const sub of this.#subscriptions) {
      if (sub.recipientFilter === agentId) {
        this.#subscriptions.delete(sub);
      }
    }
  }

  /**
   * Checks whether an agent is currently registered and eligible to receive messages.
   *
   * Wave I, ticket d57cbc1: the ref may be the canonical registration key (host
   * and wiring-lane calls) or a bare id resolvable through the identity port;
   * ambiguous bare ids fail closed (`false`).
   *
   * @param agentId - Agent identifier (or canonical registration key) to check.
   * @returns `true` if registered and active; `false` otherwise.
   *
   * @example
   * ```typescript
   * if (!bus.isRegistered('agent_beta')) {
   *   bus.registerAgent('agent_beta');
   * }
   * ```
   */
  isRegistered(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return false;
    if (this.#registeredAgents.has(agentId)) return true;
    const registrationKey = this.#resolveDirectMailboxKey(agentId);
    return Boolean(registrationKey && this.#registeredAgents.has(registrationKey));
  }

  /**
   * Checks whether an agent has been marked terminated.
   *
   * Wave I, ticket d57cbc1: the ref may be the canonical registration key
   * (host and wiring-lane calls) or a bare id resolvable through the identity
   * port; ambiguous bare ids fail closed (`false`).
   *
   * @param agentId - Agent identifier (or canonical registration key) to check.
   * @returns `true` if terminated; `false` otherwise.
   *
   * @example
   * ```typescript
   * if (bus.isAgentTerminated('agent_beta')) {
   *   console.warn('Agent is terminated and cannot receive instructions.');
   * }
   * ```
   */
  isAgentTerminated(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return false;
    if (this.#terminatedAgents.has(agentId)) return true;
    const registrationKey = this.#resolveDirectMailboxKey(agentId);
    return Boolean(registrationKey && this.#terminatedAgents.has(registrationKey));
  }

  /**
   * Retrieves registered policy configuration for an agent.
   *
   * Privilege is derived on read from trusted sources only: the injected
   * internal-principal registration marker or the injected identity port
   * authority descriptor (MOD-21 W4, default-deny). Caller policy and snapshot
   * data never grant it.
   *
   * @param agentId - Agent identifier to query.
   * @returns Policy configuration object (`privileged` re-derived), or `undefined` if not registered.
   *
   * @example
   * ```typescript
   * const policy = bus.getPolicy('director');
   * if (policy?.privileged) {
   *   console.log('Director has privileged routing access.');
   * }
   * ```
   */
  getPolicy(agentId: string): AgentPolicy | undefined {
    if (!agentId || typeof agentId !== 'string') return undefined;
    // Wave I, ticket d57cbc1: the caller may address a registration by its
    // canonical key (host/engine) or by a resolvable bare id; policy records
    // live under the registration identifier.
    const registrationKey = this.#resolveDirectMailboxKey(agentId);
    if (!registrationKey || !this.#registeredAgents.has(registrationKey)) return undefined;
    return {
      mode: 'queued',
      privileged: this.#isPrivilegedPolicy(registrationKey)
    };
  }

  /**
   * Resolves whether a registered agent holds privileged bus policy.
   *
   * @param registrationKey - Registered identifier (canonical key under wiring).
   * @returns `true` when the registration is engine-internal or the identity port grants authority.
   */
  #isPrivilegedPolicy(registrationKey: string): boolean {
    if (this.#policies.get(registrationKey)?.internal === true) return true;

    const identity = this.#identityByRef(registrationKey) || this.#identityByKey(registrationKey);
    if (identity) {
      if (identity.authority !== undefined && identity.authority !== null) {
        return authorityGrantsSubstratePrivilege(identity.authority);
      }
      if (identity.privileged === true) return true;
    }

    return false;
  }

  /**
   * Enumerates the trusted identity projections the injected port can resolve
   * for a scope (Wave I, ticket d57cbc1). Fail-closed: no port, a legacy port
   * without `listAgentIdentities`, or a throwing producer yields `[]`, which
   * routes consumers to the legacy registered-set fallback.
   *
   * @param scope - Optional trusted Realm resolution scope.
   * @returns Projections in port order (possibly empty).
   */
  #listIdentities(scope?: MessagingBusIdentityScope): MessagingBusIdentityProjection[] {
    const port = this.#identityPort;
    if (!port || typeof port.listAgentIdentities !== 'function') return [];
    try {
      const listed = port.listAgentIdentities(scope);
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  /**
   * Resolves the single identity projection registered under a canonical
   * identity `key` (Wave I, ticket d57cbc1). Zero or multiple matches resolve
   * `null` (fail closed, never an arbitrary pick).
   *
   * @param key - Canonical internal identity key (opaque to this module).
   * @returns The matching projection, or `null`.
   */
  #identityByKey(key: string | null | undefined): MessagingBusIdentityProjection | null {
    const canonical = readMetadataString(key);
    if (!canonical) return null;
    let match: MessagingBusIdentityProjection | null = null;
    for (const identity of this.#listIdentities()) {
      if (!identity || typeof identity !== 'object') continue;
      if (identity.key !== canonical) continue;
      if (match) return null;
      match = identity;
    }
    return match;
  }

  /**
   * Resolves an agent subject through the injected identity port (Wave I,
   * ticket d57cbc1). Fail-closed: no port or a throwing/malformed producer
   * resolves `null`. Payload and metadata claims are never consulted.
   *
   * @param ref - Bare agent id (or opaque host identifier) to resolve.
   * @param scope - Optional trusted Realm resolution scope.
   * @returns The identity projection, or `null`.
   */
  #identityByRef(
    ref: string | null | undefined,
    scope?: MessagingBusIdentityScope
  ): MessagingBusIdentityProjection | null {
    if (!this.#identityPort || !ref || typeof ref !== 'string') return null;
    try {
      const resolved = scope
        ? this.#identityPort.getAgentIdentity(ref, scope)
        : this.#identityPort.getAgentIdentity(ref);
      return (resolved && typeof resolved === 'object') ? resolved : null;
    } catch {
      return null;
    }
  }

  /**
   * Counts active registrations sharing a bare agent id (Wave I, ticket
   * d57cbc1): more than one means the id is realm-ambiguous and only a scoped
   * or canonical-key resolution may address it. A port without enumeration
   * cannot observe ambiguity (legacy parity).
   *
   * @param bareId - Bare agent id to count.
   * @returns Number of active registrations carrying that id.
   */
  #countIdentitiesByBareId(bareId: string): number {
    if (!bareId) return 0;
    let count = 0;
    for (const identity of this.#listIdentities()) {
      if (identity && typeof identity === 'object' && identity.id === bareId) count++;
    }
    return count;
  }

  /**
   * Projects a trusted identity projection into a {@link ResolvedBusSubject}.
   * Realm membership is normalized exactly as the Realm wave A resolver did: a
   * bypass subject is forced to the `null` scope, and blank realm ids resolve
   * to ungrouped.
   *
   * @param projection - Trusted projection from the injected port.
   * @returns Resolved subject (bare id plus effective scope).
   */
  #subjectFromProjection(projection: MessagingBusIdentityProjection): ResolvedBusSubject {
    const id = readMetadataString(projection.id) || '';
    const realmBypass = projection.realmBypass === true;
    const rawRealmId = projection.realmId;
    const realmId = (!realmBypass && typeof rawRealmId === 'string' && rawRealmId.trim())
      ? rawRealmId.trim()
      : null;
    return { id, projection, realmId, realmBypass };
  }

  /**
   * Resolves a caller subject (agent-supplied `from`/mailbox owner) through the
   * injected identity port (Wave I, ticket d57cbc1).
   *
   * Resolution order (sweep contract item 2): the trusted `callerKey` carried
   * by the context (or supplied directly by the host) resolves the unique
   * projection registered under that canonical key; otherwise the bare id
   * resolves the port's unique match across Realms (zero/multiple → fail
   * closed); a canonical key passed as the ref itself resolves by key match for
   * host/engine direct calls. An execution context carrying the exact injected
   * internal-principal reference stays realm-bypassing — the projection field
   * remains the agent channel and no payload can promote the principal.
   *
   * @param ref - Claimed caller ref (bare id, or opaque host identifier).
   * @param context - Optional trusted execution context (may carry `callerKey`/`principal`).
   * @returns Resolved subject, or `null` when nothing trusted resolves it.
   */
  #resolveCallerSubject(
    ref: string | null | undefined,
    context?: RealmPrincipalSource | null
  ): ResolvedBusSubject | null {
    const isEnginePrincipal = Boolean(
      this.#internalPrincipal &&
      context &&
      typeof context === 'object' &&
      context.principal === this.#internalPrincipal
    );
    const callerKey = context && typeof context === 'object' ? readMetadataString(context.callerKey) : undefined;

    let projection: MessagingBusIdentityProjection | null = null;
    if (callerKey) projection = this.#identityByKey(callerKey);
    if (!projection && ref) {
      projection = this.#identityByRef(ref) || this.#identityByKey(ref);
    }

    if (!projection) {
      if (!isEnginePrincipal) return null;
      return { id: ref || '', projection: null, realmId: null, realmBypass: true };
    }

    const subject = this.#subjectFromProjection(projection);
    if (isEnginePrincipal) {
      return { id: subject.id, projection: subject.projection, realmId: null, realmBypass: true };
    }
    return subject;
  }

  /**
   * Reports whether an opaque registration identifier currently partitions a
   * mailbox (registered, terminated, or holding queued/archived envelopes).
   *
   * @param ref - Candidate registration identifier.
   * @returns `true` when the bus already knows the identifier.
   */
  #isKnownMailbox(ref: string | null | undefined): boolean {
    if (!ref || typeof ref !== 'string') return false;
    return this.#registeredAgents.has(ref) ||
      this.#terminatedAgents.has(ref) ||
      this.#activeQueues.has(ref) ||
      this.#archives.has(ref);
  }

  /**
   * Resolves the opaque mailbox partition key for a trusted projection without
   * ever assuming the registration identifier equals the bare id (Wave I,
   * ticket d57cbc1, sweep contract item 1).
   *
   * The canonical projection `key` wins when it partitions a mailbox; when the
   * canonical key is not registered (pre-wiring producer or legacy producer
   * without `key`), the ref itself is the legacy registration identifier — but
   * only when the port does not see the ref as an ambiguous realm-local id
   * (more than one active registration sharing it), which fails closed instead
   * of delivering to an arbitrary Realm's mailbox.
   *
   * @param projection - Trusted projection, or `null` for legacy refs.
   * @param ref - Identifier received at registration time (or the bare ref).
   * @returns The partition key to use, or `null` when neither is usable.
   */
  #resolveMailboxKey(
    projection: MessagingBusIdentityProjection | null,
    ref: string | null | undefined
  ): string | null {
    const canonical = projection ? readMetadataString(projection.key) : undefined;
    if (canonical && this.#isKnownMailbox(canonical)) return canonical;
    if (ref && typeof ref === 'string' && this.#isKnownMailbox(ref)) {
      if (canonical && this.#countIdentitiesByBareId(ref) > 1) return canonical;
      return ref;
    }
    return canonical || (typeof ref === 'string' && ref ? ref : null);
  }

  /**
   * Resolves the mailbox partition key for a direct (positional/host) ref: the
   * ref itself when it already partitions a mailbox, otherwise its trusted
   * identity resolution (canonical key first, then a unique bare-id match).
   * Unknown refs stay verbatim so legacy empty-mailbox semantics hold.
   *
   * @param ref - Agent/mailbox identifier supplied by the caller.
   * @returns The partition key to read, or the ref when nothing resolves.
   */
  #resolveDirectMailboxKey(ref: string | null | undefined): string | null {
    if (!ref || typeof ref !== 'string') return null;
    if (this.#isKnownMailbox(ref)) return ref;
    const projection = this.#identityByRef(ref) || this.#identityByKey(ref);
    if (projection) {
      const key = this.#resolveMailboxKey(projection, ref);
      if (key && this.#isKnownMailbox(key)) return key;
    }
    return ref;
  }

  /**
   * Resolves the mailbox partition key for a context-bound read (Wave I,
   * ticket d57cbc1): the trusted context caller resolves through its
   * `callerKey`/bare id and partitions under its canonical registration key
   * when one is registered; otherwise the caller ref stays the legacy
   * partition (empty mailbox for unknown refs).
   *
   * @param context - Trusted execution context that bound the read.
   * @param ref - Caller ref already resolved from the context.
   * @returns The partition key to read.
   */
  #resolveContextMailboxKey(context: ExecutionContext, ref: string): string {
    const callerSubject = this.#resolveCallerSubject(ref, context);
    if (callerSubject) {
      const key = this.#resolveMailboxKey(callerSubject.projection, ref);
      if (key) return key;
    }
    return ref;
  }

  /**
   * Projects an opaque ref to the bare id an agent may see: a canonical key
   * resolves to its projection `id`; a bare ref (or an unresolved/unknown key)
   * stays verbatim so legacy surfaces are byte-compatible.
   *
   * @param ref - Candidate ref (bare id, canonical key, or legacy identifier).
   * @returns Bare agent id when the port resolves one, else the ref.
   */
  #bareIdForRef(ref: string | null | undefined): string {
    if (!ref || typeof ref !== 'string') return ref || '';
    const projection = this.#identityByKey(ref) || this.#identityByRef(ref);
    const id = projection ? readMetadataString(projection.id) : undefined;
    return id || ref;
  }

  /**
   * Resolves a registered identifier to the bare id surfaced by listings.
   * Canonical keys project to their bare id (the live port first, then the
   * launch/termination memo); legacy identifiers pass through.
   *
   * @param registrationRef - Identifier received at registration time.
   * @returns Bare agent id (or the identifier when no projection resolves).
   */
  #bareIdForRegistration(registrationRef: string): string {
    const projection = this.#identityByKey(registrationRef) || this.#identityByRef(registrationRef);
    const id = projection ? readMetadataString(projection.id) : undefined;
    return id || this.#registrationIds.get(registrationRef) || registrationRef;
  }

  /**
   * Remembers the bare id of an opaque registration identifier while the
   * identity port still resolves it (Wave I, ticket d57cbc1). Fail-closed:
   * ambiguous or unknown registrations are not memorized.
   *
   * @param registrationRef - Identifier received at registration time.
   */
  #rememberRegistrationId(registrationRef: string): void {
    if (!registrationRef || typeof registrationRef !== 'string') return;
    const projection = this.#identityByKey(registrationRef) || this.#identityByRef(registrationRef);
    const id = projection ? readMetadataString(projection.id) : undefined;
    if (id) this.#registrationIds.set(registrationRef, id);
  }

  /**
   * Reports whether a resolved sender scope may deliver to a resolved
   * recipient subject.
   *
   * The bypass is one-way scope isolation (Realm wave R, ticket cf0e127): a
   * bypass sender (the operator/engine principal or a `realmBypass` agent such
   * as the system director) may deliver to every recipient, while a non-bypass
   * sender may deliver only to recipients that share its own Realm scope. A
   * bypass recipient is never reachable from a non-bypass sender — there is no
   * reply path to the system scope — and ungrouped legacy subjects share the
   * `null` scope.
   *
   * @param senderScope - Pre-resolved sender Realm scope.
   * @param recipient - Resolved recipient subject.
   * @returns `true` when the delivery may proceed.
   */
  #isScopeDeliveryAllowed(senderScope: ResolvedRealmScope, recipient: ResolvedRealmScope): boolean {
    if (senderScope.realmBypass) return true;
    if (recipient.realmBypass === true) return false;
    return senderScope.realmId === recipient.realmId;
  }

  /**
   * Builds the legacy (projection-less) subject for a registration identifier,
   * resolving its Realm scope through the port's unique match. Unknown
   * identifiers keep the ungrouped `null` scope, exactly like the Realm wave A
   * resolver did.
   *
   * @param registrationRef - Identifier received at registration time.
   * @returns Resolved subject.
   */
  #subjectForRegistration(registrationRef: string): ResolvedBusSubject {
    const projection = this.#identityByRef(registrationRef);
    if (projection) return this.#subjectFromProjection(projection);
    return { id: registrationRef, projection: null, realmId: null, realmBypass: false };
  }

  /**
   * Resolves an agent-supplied recipient ref (`to`/`recipient`) within the
   * caller's Realm scope (Wave I, ticket d57cbc1, sweep contract item 3).
   *
   * Resolution order: an exact canonical-key match addresses a host/engine
   * target; the scoped bare-id resolution resolves realm-locally; the global
   * unique-match then classifies an out-of-scope (foreign Realm or bypass)
   * recipient. An id carried by several Realms is ambiguous, and a ref no
   * identity resolves falls back to the legacy registration partition only when
   * the bus knows it. Foreign, bypass and ambiguous recipients deny with the
   * existing `PERMISSION_DENIED` semantics; unknown refs keep
   * `RECIPIENT_NOT_FOUND`.
   *
   * @param ref - Agent-supplied recipient ref.
   * @param senderScope - Pre-resolved sender Realm scope.
   * @returns Recipient classification with the partition key to use.
   */
  #resolveRecipient(ref: string, senderScope: ResolvedRealmScope): ResolvedRecipient {
    const byKey = this.#identityByKey(ref);
    if (byKey) return this.#recipientFromProjection(byKey, ref, senderScope);

    const scoped = this.#identityByRef(ref, senderScope);
    if (scoped) return this.#recipientFromProjection(scoped, ref, senderScope);

    const global = this.#identityByRef(ref);
    if (global) return this.#recipientFromProjection(global, ref, senderScope);

    if (this.#countIdentitiesByBareId(ref) > 1) {
      return {
        kind: 'ambiguous',
        id: ref,
        mailboxKey: ref,
        projection: null,
        realmId: null,
        realmBypass: false,
        scopeAllowed: false
      };
    }

    if (this.#isKnownMailbox(ref)) {
      return {
        kind: 'resolved',
        id: ref,
        mailboxKey: ref,
        projection: null,
        realmId: null,
        realmBypass: false,
        scopeAllowed: senderScope.realmBypass || senderScope.realmId === null
      };
    }

    return {
      kind: 'unknown',
      id: ref,
      mailboxKey: ref,
      projection: null,
      realmId: null,
      realmBypass: false,
      scopeAllowed: false
    };
  }

  /**
   * Converts a trusted recipient projection into a delivery classification,
   * deriving the mailbox partition key and the scope gate outcome.
   *
   * @param projection - Trusted recipient projection.
   * @param ref - Agent-supplied ref that resolved to the projection.
   * @param senderScope - Pre-resolved sender Realm scope.
   * @returns Recipient classification.
   */
  #recipientFromProjection(
    projection: MessagingBusIdentityProjection,
    ref: string,
    senderScope: ResolvedRealmScope
  ): ResolvedRecipient {
    const subject = this.#subjectFromProjection(projection);
    const mailboxKey = this.#resolveMailboxKey(projection, ref) || ref;
    return {
      kind: 'resolved',
      id: subject.id || ref,
      mailboxKey,
      projection,
      realmId: subject.realmId,
      realmBypass: subject.realmBypass,
      scopeAllowed: this.#isScopeDeliveryAllowed(senderScope, subject)
    };
  }

  /**
   * Resolves the recipients of a `to: 'all'` fan-out (Wave I, ticket d57cbc1,
   * sweep contract item 3).
   *
   * The primary enumeration is `listAgentIdentities(callerScope)`, so the
   * fan-out spans exactly the sender's Realm — every Realm for a bypass sender
   * — and never discloses foreign agents. Registrations the port cannot see
   * (legacy/phantom identifiers) remain reachable through the registered-set
   * fallback, still gated by the port-resolved recipient scope. The sender's
   * own partition is always excluded, and terminated or unregistered
   * partitions are never targeted.
   *
   * @param senderScope - Pre-resolved sender Realm scope.
   * @param senderRef - Sender identifier used for legacy sender exclusion.
   * @param senderSubject - Resolved sender subject (carries the canonical key when known).
   * @returns Bare `recipients` list plus the partition keys to enqueue into.
   */
  #resolveBroadcastTargets(
    senderScope: ResolvedRealmScope,
    senderRef: string,
    senderSubject: ResolvedBusSubject | null
  ): { recipients: string[]; mailboxKeys: string[] } {
    const recipients: string[] = [];
    const mailboxKeys: string[] = [];
    const claimed = new Set<string>();
    const senderMailboxKey = senderSubject
      ? (this.#resolveMailboxKey(senderSubject.projection, senderRef) || senderRef)
      : (this.#resolveMailboxKey(null, senderRef) || senderRef);

    for (const projection of this.#listIdentities(senderScope)) {
      if (!projection || typeof projection !== 'object') continue;
      const subject = this.#subjectFromProjection(projection);
      if (!subject.id) continue;
      if (!this.#isScopeDeliveryAllowed(senderScope, subject)) continue;
      const mailboxKey = this.#resolveMailboxKey(projection, subject.id);
      if (!mailboxKey || !this.#registeredAgents.has(mailboxKey)) continue;
      if (this.#terminatedAgents.has(mailboxKey)) continue;
      if (mailboxKey === senderMailboxKey) continue;
      if (claimed.has(mailboxKey)) continue;
      claimed.add(mailboxKey);
      mailboxKeys.push(mailboxKey);
      recipients.push(subject.id);
    }

    for (const registeredRef of this.#registeredAgents) {
      if (claimed.has(registeredRef)) continue;
      if (registeredRef === senderMailboxKey) continue;
      if (this.#terminatedAgents.has(registeredRef)) continue;
      const recipientSubject = this.#subjectForRegistration(registeredRef);
      // Mixed transitional state: skip a bare registration whose agent is
      // already delivered through its canonical registration.
      const canonicalKey = recipientSubject.projection
        ? readMetadataString(recipientSubject.projection.key)
        : undefined;
      if (canonicalKey && claimed.has(canonicalKey)) continue;
      if (!senderScope.realmBypass && !this.#isScopeDeliveryAllowed(senderScope, recipientSubject)) continue;
      claimed.add(registeredRef);
      mailboxKeys.push(registeredRef);
      recipients.push(this.#bareIdForRegistration(registeredRef));
    }

    return { recipients, mailboxKeys };
  }

  /**
   * Notifies the subscribers bound to a delivered envelope: the partition key
   * first (canonical subscriptions under wiring) and the bare recipient id
   * (legacy subscriptions), deduplicated when both coincide.
   *
   * @param mailboxKey - Partition key the envelope landed in.
   * @param recipientId - Bare recipient id surfaced by the envelope.
   * @param message - Delivered envelope.
   */
  #notifyDelivered(mailboxKey: string, recipientId: string, message: MessageEnvelope): void {
    this.#notifySubscribers(mailboxKey, message);
    if (recipientId && recipientId !== mailboxKey) {
      this.#notifySubscribers(recipientId, message);
    }
  }

  /**
   * Returns a defensive array copy of all currently registered active agent IDs.
   *
   * Wave I, ticket d57cbc1: canonical registration keys project to their bare
   * agent id, so the listing never leaks the internal key; legacy identifiers
   * (and unresolvable registrations) pass through verbatim.
   *
   * @returns Array of registered agent ID strings (bare ids under wiring).
   *
   * @example
   * ```typescript
   * const activeAgents = bus.getRegisteredAgents();
   * console.log(`Currently registered agents: ${activeAgents.join(', ')}`);
   * ```
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.#registeredAgents, (registrationRef) => this.#bareIdForRegistration(registrationRef));
  }

  /**
   * Returns a defensive array copy of all terminated agent IDs.
   *
   * Wave I, ticket d57cbc1: canonical registration keys project to their bare
   * agent id; legacy identifiers pass through verbatim.
   *
   * @returns Array of terminated agent ID strings (bare ids under wiring).
   *
   * @example
   * ```typescript
   * const deadAgents = bus.getTerminatedAgents();
   * console.log(`Terminated agents: ${deadAgents.join(', ')}`);
   * ```
   */
  getTerminatedAgents(): string[] {
    return Array.from(this.#terminatedAgents, (registrationRef) => this.#bareIdForRegistration(registrationRef));
  }

  /**
   * Returns the exact number of pending unread messages in an agent's active queue ($O(1)$).
   *
   * Wave I, ticket d57cbc1: the ref may be the canonical registration key or a
   * bare id resolvable through the identity port; unknown/ambiguous refs keep
   * the legacy zero count (no existence oracle).
   *
   * @param agentId - Agent identifier (or canonical registration key) to query.
   * @returns Number of pending unread messages in `#activeQueues`.
   *
   * @example
   * ```typescript
   * const count = bus.getUnreadCount('researcher');
   * if (count > 0) {
   *   console.log(`Researcher has ${count} pending message(s).`);
   * }
   * ```
   */
  getUnreadCount(agentId: string): number {
    if (!agentId || typeof agentId !== 'string') return 0;
    const mailboxKey = this.#resolveDirectMailboxKey(agentId);
    const queue = mailboxKey ? this.#activeQueues.get(mailboxKey) : undefined;
    return queue ? queue.length : 0;
  }

  /**
   * Delivers a point-to-point or broadcast message envelope.
   *
   * Validates recipient existence and termination status, records envelope in chronological
   * append-only audit log, enqueues envelope into recipient active unread queues, and triggers
   * real-time subscriber notifications.
   *
   * Supports both canonical positional signatures and unified Tool Descriptor `(params, context)` signatures.
   * Unserializable content (circular structures, BigInt) is rejected with an `INVALID_ARGUMENTS` failure
   * receipt instead of throwing.
   *
   * Realm scope, one-way bypass (Realm wave A, ticket 7387ce1; Realm wave R,
   * ticket cf0e127): a direct send to an otherwise-deliverable recipient is
   * denied with `PERMISSION_DENIED` when the sender is non-bypass and the
   * recipient is a bypass subject or does not share the sender's Realm;
   * `to: 'all'` fan-out is filtered to recipients sharing a non-bypass
   * sender's Realm (every registered recipient for a bypass sender). A denied
   * envelope is neither delivered nor archived.
   *
   * @param arg1 - Full `SendMessageOptions` object, or sender agent ID string; within the object form a supplied `ExecutionContext` is the only sender identity source (the context caller, or the fixed `'anonymous'` label when it binds none — payload `from`/`sender` are never promoted, MOD-21 W10-B), while the positional sender-string form is documented direct-API handling.
   * @param maybeToOrContext - Recipient agent ID (`'all'` for broadcast) or `ExecutionContext`.
   * @param maybeContent - Message payload string or JSON-serializable object (positional signature); unserializable values fail with `INVALID_ARGUMENTS`.
   * @param maybeReplyToOrOptions - Designated reply-to agent ID or options object.
   * @param maybeMetadata - Additional metadata dictionary (positional signature).
   * @returns Synchronous delivery receipt. Never throws unhandled exceptions; returns `{ success: false, code, error }` on failure.
   *
   * @example
   * ```typescript
   * // Canonical object signature:
   * const receipt1 = bus.sendMessage({
   *   from: 'director',
   *   to: 'researcher',
   *   content: 'Analyze market data.',
   *   type: 'task'
   * });
   *
   * // Broadcast signature:
   * const receipt2 = bus.sendMessage({
   *   from: 'director',
   *   to: 'all',
   *   content: 'All agents standby.'
   * });
   *
   * // Tool Gateway (params, context) delegation:
   * const receipt3 = bus.sendMessage(params, context);
   * ```
   */
  sendMessage(
    arg1: SendMessageOptions | string,
    maybeToOrContext?: string | ExecutionContext,
    maybeContent?: string | object,
    maybeReplyToOrOptions?: string | SendMessageOptions,
    maybeMetadata?: Record<string, unknown>
  ): SendMessageReceipt {
    let from: unknown;
    let to: unknown;
    let content: unknown;
    let replyTo: unknown;
    let metadata: MetadataBag = {};
    let type: unknown;
    let correlationId: unknown;
    let realmSourceContext: RealmPrincipalSource | null = null;

    const replyToOption = (maybeReplyToOrOptions && typeof maybeReplyToOrOptions === 'object')
      ? maybeReplyToOrOptions.replyTo
      : undefined;

    if (arg1 && typeof arg1 === 'object') {
      // Form: sendMessage(paramsOrPayload, context)
      const payload = arg1;
      const contextSupplied = isContextSupplied(maybeToOrContext);
      const context: ExecutionContext = contextSupplied ? maybeToOrContext : {};
      if (contextSupplied) realmSourceContext = context;

      // MOD-21 W10-B: a supplied context object is the only identity source:
      // its caller binding (or the fixed anonymous sender when it binds none)
      // replaces every payload `from`/`sender`. Payload identity remains the
      // fallback only for genuinely contextless direct-API calls.
      from = contextSupplied
        ? (resolveContextCallerId(context) || ANONYMOUS_SENDER_ID)
        : (payload.from || payload.sender);
      to = payload.to || payload.recipient || payload.targetAgentId || payload.target_agent_id || payload.recipient_id || payload.recipientId;
      content = payload.content !== undefined
        ? payload.content
        : (payload.message !== undefined
          ? payload.message
          : (payload.text !== undefined
            ? payload.text
            : (payload.body !== undefined
              ? payload.body
              : payload.payload)));
      replyTo = payload.replyTo || payload.in_reply_to || payload.inReplyTo || payload.reply_to || from;
      type = payload.type || payload.metadata?.type || 'message';
      metadata = payload.metadata ? { ...payload.metadata } : {};
      correlationId = payload.correlation_id || payload.correlationId || metadata.correlationId;
      if (correlationId) {
        metadata.correlationId = correlationId;
      }
    } else if (typeof arg1 === 'string') {
      if (typeof maybeToOrContext === 'string' && maybeContent !== undefined && typeof maybeContent !== 'object') {
        // Positional: (from, to, content, replyTo, metadata)
        from = arg1;
        to = maybeToOrContext;
        content = maybeContent;
        replyTo = typeof maybeReplyToOrOptions === 'string' ? maybeReplyToOrOptions : (replyToOption || from);
        metadata = (maybeMetadata && typeof maybeMetadata === 'object')
          ? { ...maybeMetadata }
          : ((maybeReplyToOrOptions && typeof maybeReplyToOrOptions === 'object' && maybeReplyToOrOptions.metadata)
            ? { ...maybeReplyToOrOptions.metadata }
            : {});
        type = (maybeMetadata && maybeMetadata.type) || (maybeReplyToOrOptions && typeof maybeReplyToOrOptions === 'object' && maybeReplyToOrOptions.type) || 'message';
      } else if (typeof maybeToOrContext === 'string' && (maybeContent === undefined || typeof maybeContent === 'object')) {
        let extra: PositionalExtraBag = {};
        if (maybeContent && typeof maybeContent === 'object') {
          extra = maybeContent;
        }
        if (extra.from || extra.callerAgentId || extra.agentId) {
          // Positional descriptor handler: (recipient, message, params/context)
          to = arg1;
          content = maybeToOrContext;
          from = extra.from || extra.callerAgentId || extra.agentId;
          if ('principal' in extra) realmSourceContext = { principal: extra.principal };
          replyTo = extra.replyTo || extra.in_reply_to || extra.inReplyTo || extra.reply_to || from;
          metadata = extra.metadata ? { ...extra.metadata } : {};
          correlationId = extra.correlation_id || extra.correlationId || metadata.correlationId;
          if (correlationId) metadata.correlationId = correlationId;
          type = extra.type || metadata.type || 'message';
        } else {
          // Positional: (from, to, contentObject, replyTo, metadata)
          from = arg1;
          to = maybeToOrContext;
          content = maybeContent;
          replyTo = typeof maybeReplyToOrOptions === 'string' ? maybeReplyToOrOptions : (replyToOption || from);
          metadata = (maybeMetadata && typeof maybeMetadata === 'object')
            ? { ...maybeMetadata }
            : ((maybeReplyToOrOptions && typeof maybeReplyToOrOptions === 'object' && maybeReplyToOrOptions.metadata)
              ? { ...maybeReplyToOrOptions.metadata }
              : {});
          type = (maybeMetadata && maybeMetadata.type) || (maybeReplyToOrOptions && typeof maybeReplyToOrOptions === 'object' && maybeReplyToOrOptions.type) || 'message';
        }
      } else if (maybeToOrContext && typeof maybeToOrContext === 'object') {
        const ctx = maybeToOrContext;
        realmSourceContext = ctx;
        to = ctx.to || ctx.recipient || arg1;
        from = resolveContextCallerId(ctx) || ctx.from;
        content = ctx.content !== undefined ? ctx.content : (ctx.message !== undefined ? ctx.message : maybeContent);
        replyTo = ctx.replyTo || ctx.in_reply_to || ctx.inReplyTo || from;
        metadata = (ctx.metadata && typeof ctx.metadata === 'object') ? { ...ctx.metadata } : {};
        correlationId = ctx.correlation_id || ctx.correlationId;
        if (correlationId) metadata.correlationId = correlationId;
        type = ctx.type || metadata.type || 'message';
      } else {
        from = arg1;
        to = maybeToOrContext;
        content = maybeContent;
        replyTo = typeof maybeReplyToOrOptions === 'string' ? maybeReplyToOrOptions : from;
        metadata = maybeMetadata || {};
        type = metadata?.type || 'message';
      }
    }

    if (!from || typeof from !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: "Valid string 'from' is required"
      };
    }
    if (!to || typeof to !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: "Valid string 'to' is required"
      };
    }
    if (content === undefined || content === null) {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: "Message 'content' is required"
      };
    }

    const resolvedType = readMetadataString(type) || readMetadataString(metadata?.type) || 'message';
    const messageId = this.#generateMessageId();
    let stringContent: string | undefined;
    if (typeof content === 'string') {
      stringContent = content;
    } else {
      try {
        stringContent = JSON.stringify(content);
      } catch (err) {
        return {
          success: false,
          code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
          error: `Message 'content' is not JSON-serializable: ${readErrorMessage(err) || 'unsupported value'}`
        };
      }
    }
    if (typeof stringContent !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: "Message 'content' is not JSON-serializable"
      };
    }
    const timestamp = Date.now();

    // Caller/sender resolution (Wave I, ticket d57cbc1): the trusted
    // `callerKey` carried by an internal context (or the port's unique bare-id
    // match) owns the sender identity and Realm scope; the exact injected
    // internal-principal reference still marks the engine/operator path as
    // realm-bypassing. Payload/metadata Realm and identity claims are never
    // consulted. The envelope is stamped with the bare id only.
    const senderSubject = this.#resolveCallerSubject(from, realmSourceContext);
    const senderRealmScope: ResolvedRealmScope = senderSubject
      ? { realmId: senderSubject.realmId, realmBypass: senderSubject.realmBypass }
      : { realmId: null, realmBypass: false };
    const senderId = (senderSubject && senderSubject.id) ? senderSubject.id : from;
    const resolvedReplyTo = (replyTo && typeof replyTo === 'string')
      ? this.#bareIdForRef(replyTo)
      : senderId;

    // Broadcast routing
    if (to === 'all') {
      const { recipients, mailboxKeys } = this.#resolveBroadcastTargets(senderRealmScope, from, senderSubject);

      const message = {
        success: true,
        broadcast: true,
        recipients,
        id: messageId,
        messageId,
        from: senderId,
        replyTo: resolvedReplyTo,
        to: 'all',
        type: resolvedType,
        content: stringContent,
        metadata: metadata ? { ...metadata } : {},
        timestamp,
        read: false
      };

      // Append to global audit log
      this.#auditLog.push({ ...message, metadata: { ...message.metadata } });

      for (let i = 0; i < mailboxKeys.length; i++) {
        const recipientRef = mailboxKeys[i];
        let queue = this.#activeQueues.get(recipientRef);
        if (!queue) {
          queue = [];
          this.#activeQueues.set(recipientRef, queue);
        }
        queue.push({ ...message, metadata: { ...message.metadata } });

        this.#notifyDelivered(recipientRef, recipients[i], message);
      }

      this.#notifySubscribers('all', message);
      return message;
    }

    // Direct point-to-point routing: the recipient ref resolves within the
    // sender's Realm scope (Wave I, ticket d57cbc1); a foreign, bypass or
    // ambiguous recipient denies with the existing Realm semantics, an unknown
    // ref keeps the legacy dead-letter code, and the mailbox partition is the
    // resolved registration identifier (canonical key under wiring).
    const recipient = this.#resolveRecipient(to, senderRealmScope);
    const recipientId = recipient.id || to;
    const recipientMailboxKey = recipient.mailboxKey || to;
    // Agent-visible recipient label (Wave I, ticket d57cbc1): error surfaces
    // project the partition identifier back to its bare id (identity port,
    // then the launch/termination memo) so no canonical key or Realm
    // vocabulary ever reaches an agent. Legacy bare refs pass through
    // byte-compatibly.
    const recipientLabel = this.#bareIdForRegistration(recipientMailboxKey);

    if (recipient.kind === 'resolved' && this.#terminatedAgents.has(recipientMailboxKey)) {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.AGENT_TERMINATED,
        error: `Cannot send message to dead/unregistered agent '${recipientLabel}'`
      };
    }

    // Classification gate (Wave I, ticket d57cbc1): an ambiguous bare id is an
    // identity collision, not an absent mailbox — deny it fail-closed with the
    // existing Realm semantics *before* the registered-set check below (which
    // cannot see a bare ref under canonical wiring and would otherwise
    // misreport the denial as an unknown recipient). An unknown ref keeps the
    // legacy dead-letter code and precedence.
    if (recipient.kind === 'ambiguous') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.PERMISSION_DENIED,
        error: `Cross-realm delivery to '${recipientLabel}' is denied`
      };
    }

    if (recipient.kind === 'unknown' || !this.#registeredAgents.has(recipientMailboxKey)) {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.RECIPIENT_NOT_FOUND,
        error: `Cannot send message to dead/unregistered agent '${recipientLabel}'`
      };
    }

    // Realm gate (Realm wave A, ticket 7387ce1): dead-letter checks keep
    // precedence; an otherwise-deliverable cross-Realm recipient is denied
    // before any queue or audit write.
    if (!recipient.scopeAllowed) {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.PERMISSION_DENIED,
        error: `Cross-realm delivery to '${recipientLabel}' is denied`
      };
    }

    const message = {
      success: true,
      id: messageId,
      messageId,
      from: senderId,
      replyTo: resolvedReplyTo,
      to: recipientId,
      type: resolvedType,
      content: stringContent,
      metadata: metadata ? { ...metadata } : {},
      timestamp,
      read: false
    };

    this.#auditLog.push({ ...message, metadata: { ...message.metadata } });

    let queue = this.#activeQueues.get(recipientMailboxKey);
    if (!queue) {
      queue = [];
      this.#activeQueues.set(recipientMailboxKey, queue);
    }
    queue.push({ ...message, metadata: { ...message.metadata } });

    this.#notifyDelivered(recipientMailboxKey, recipientId, message);
    this.#notifySubscribers('all', message);

    return message;
  }

  /**
   * Internal helper to notify matching subscribers.
   *
   * @param filter - Recipient filter to match against active subscribers.
   * @param message - Delivered envelope copied for each handler.
   */
  #notifySubscribers(filter: string, message: MessageEnvelope): void {
    for (const sub of this.#subscriptions) {
      if (sub.recipientFilter === filter) {
        try {
          sub.handler({ ...message, metadata: { ...message.metadata } });
        } catch (err) {
          // Subscriber failures must not fail delivery: quarantine + host diagnostic only.
          console.error(`Error in MessagingBus subscription handler for filter '${filter}':`, err);
        }
      }
    }
  }

  /**
   * Non-destructively peeks at message headers and 80-character snippets for an agent.
   *
   * Never dequeues envelopes from `#activeQueues` and never mutates `read` flags.
   * Supports filtering by status (`'unread'`, `'read'`, `'all'`), sender filtering, and pagination.
   *
   * @param agentIdOrParams - Target agent ID or options object with `agentId` (or its `recipient` alias); when a supplied `ExecutionContext` is the trailing argument it is the only mailbox source (an anonymous context sees an empty inbox) and the payload aliases are never promoted (MOD-21 W10-B).
   * @param optionsOrContext - Filter/pagination options or `ExecutionContext`.
   * @returns Array of header summaries formatted with truncated 80-char previews.
   *
   * @example
   * ```typescript
   * // Peek unread messages:
   * const summaries = bus.listInbox('agent_a', { status: 'unread', limit: 10 });
   * for (const header of summaries) {
   *   console.log(`[${header.from}]: ${header.preview}`);
   * }
   *
   * // Tool Gateway delegation:
   * const toolHeaders = bus.listInbox(params, context);
   * ```
   */
  listInbox(
    agentIdOrParams: string | (ListInboxOptions & { agentId?: string; recipient?: string }),
    optionsOrContext?: ListInboxOptions | ExecutionContext
  ): MessageHeaderSummary[] {
    let agentId: string | null | undefined;
    let options: ListInboxOptions | ExecutionContext = {};
    let mailboxContext: ExecutionContext | null = null;

    if (agentIdOrParams && typeof agentIdOrParams === 'object') {
      const contextSupplied = isContextSupplied(optionsOrContext);
      const context: ExecutionContext = contextSupplied ? optionsOrContext : {};
      // MOD-21 W10-B: a supplied context selects the mailbox through its caller
      // binding only; a context that binds no caller is anonymous (empty
      // inbox). Payload routing is a fallback only for contextless calls.
      agentId = resolveRoutingIdentity(context, contextSupplied, agentIdOrParams.agentId || agentIdOrParams.recipient);
      options = scrubPayloadRoutingKeys({ ...agentIdOrParams, ...context });
      if (contextSupplied) mailboxContext = context;
    } else if (typeof agentIdOrParams === 'string') {
      agentId = agentIdOrParams;
      options = (optionsOrContext && typeof optionsOrContext === 'object') ? optionsOrContext : {};
    }

    if (!agentId || typeof agentId !== 'string') return [];
    // Wave I, ticket d57cbc1: the mailbox partitions on the caller's
    // registration identifier, never on an assumed bare id.
    const mailboxKey = mailboxContext
      ? this.#resolveContextMailboxKey(mailboxContext, agentId)
      : (this.#resolveDirectMailboxKey(agentId) || agentId);
    const surfaceId = this.#bareIdForRef(agentId);

    const activeQueue = this.#activeQueues.get(mailboxKey) || [];
    const archiveQueue = this.#archives.get(mailboxKey) || [];

    const targetSender: string | undefined = (typeof options.sender === 'string' && options.sender)
      ? options.sender
      : (typeof options.from === 'string' ? options.from : undefined);

    const requestedStatus = options.status;
    const status: 'unread' | 'read' | 'all' = (requestedStatus === 'unread' || requestedStatus === 'read' || requestedStatus === 'all')
      ? requestedStatus
      : (options.read_only || options.readOnly ? 'read' : ((options.unread_only || options.unreadOnly) ? 'unread' : 'unread'));

    let sourceList: MutableMessageEnvelope[];
    if (status === 'read' || options.readOnly || options.read_only) {
      sourceList = [...archiveQueue];
    } else if (status === 'all') {
      sourceList = [...activeQueue, ...archiveQueue];
    } else {
      sourceList = [...activeQueue];
    }

    if (targetSender) {
      sourceList = sourceList.filter(msg => msg.from === targetSender);
    }

    if (typeof options.offset === 'number' && options.offset > 0) {
      sourceList = sourceList.slice(options.offset);
    } else if (typeof options.skip === 'number' && options.skip > 0) {
      sourceList = sourceList.slice(options.skip);
    }

    const limit: number | undefined = typeof options.limit === 'number'
      ? options.limit
      : (typeof options.max === 'number'
        ? options.max
        : (typeof options.count === 'number'
          ? options.count
          : (typeof options.pageSize === 'number'
            ? options.pageSize
            : (typeof options.page_size === 'number' ? options.page_size : undefined))));

    if (typeof limit === 'number' && limit > 0) {
      sourceList = sourceList.slice(0, limit);
    }

    return sourceList.map(msg => {
      const snippet = typeof msg.content === 'string'
        ? (msg.content.length > 80 ? msg.content.slice(0, 80) + '...' : msg.content)
        : String(msg.content ?? '');
      return {
        id: msg.id || msg.messageId,
        messageId: msg.messageId || msg.id,
        from: msg.from,
        replyTo: msg.replyTo || msg.from,
        to: msg.to || surfaceId,
        type: readMetadataString(msg.type) || readMetadataString(msg.metadata?.type) || 'message',
        metadata: msg.metadata ? { ...msg.metadata } : {},
        timestamp: msg.timestamp,
        read: Boolean(msg.read),
        snippet,
        preview: snippet
      };
    });
  }

  /**
   * Retrieves a specific message by ID from an agent's active queue or archive.
   *
   * Invariant: If found in `#activeQueues` and `markAsRead: true` (default), the envelope is atomically
   * spliced from the unread queue, marked `read = true`, and appended to `#archives`.
   * If already in `#archives`, it is returned with `status: 'archived'`.
   *
   * @param agentIdOrMsgId - Target agent ID, message ID, or options object with `agentId` (or its `recipient` alias) and `messageId` (or its `message_id`/`msgId`/`msg_id`/`id` aliases); when a supplied `ExecutionContext` is the trailing argument it is the only mailbox source (an anonymous context has no mailbox) and the payload aliases are never promoted (MOD-21 W10-B).
   * @param messageIdOrOptions - Target message ID string or `ReadMessageOptions`.
   * @param optionsOrContext - Read options (`markAsRead`, or a bare boolean), or `ExecutionContext`.
   * @returns Result object containing retrieved envelope and partition status.
   *
   * @example
   * ```typescript
   * // Read and consume message:
   * const result = bus.readMessage('agent_a', 'msg_1726500000000_123');
   * if (result.success && result.message) {
   *   console.log(`Read message content: ${result.message.content}`);
   * }
   *
   * // Tool Gateway delegation:
   * const toolResult = bus.readMessage(params, context);
   * ```
   */
  readMessage(
    agentIdOrMsgId: string | (ReadMessageOptions & {
      agentId?: string;
      recipient?: string;
      messageId?: string;
      message_id?: string;
      msgId?: string;
      msg_id?: string;
      id?: string;
    }),
    messageIdOrOptions?: string | ReadMessageOptions,
    optionsOrContext?: ReadMessageOptions | ExecutionContext | boolean
  ): ReadMessageResult {
    let agentId: unknown;
    let messageId: unknown;
    let markAsRead: boolean = true;
    let mailboxContext: ExecutionContext | null = null;

    if (agentIdOrMsgId && typeof agentIdOrMsgId === 'object') {
      // Form: readMessage(params, context)
      const params = agentIdOrMsgId;
      const contextSupplied = isContextSupplied(messageIdOrOptions);
      const context: ExecutionContext = contextSupplied ? messageIdOrOptions : {};
      // MOD-21 W10-B: a supplied context selects the mailbox through its caller
      // binding only; a context that binds no caller is anonymous (no mailbox).
      // Payload routing is a fallback only for contextless direct-API calls.
      agentId = resolveRoutingIdentity(context, contextSupplied, params.agentId || params.recipient);
      if (contextSupplied) mailboxContext = context;
      messageId = params.message_id || params.messageId || params.id || params.msgId || params.msg_id;
      markAsRead = params.mark_as_read !== undefined
        ? Boolean(params.mark_as_read)
        : (params.markAsRead !== undefined
          ? Boolean(params.markAsRead)
          : (params.markRead !== undefined ? Boolean(params.markRead) : true));
    } else if (typeof agentIdOrMsgId === 'string') {
      if (typeof messageIdOrOptions === 'string') {
        // Form: readMessage(agentId, messageId, options)
        agentId = agentIdOrMsgId;
        messageId = messageIdOrOptions;
        const rawOptions = optionsOrContext;
        const readOptions: ReadMessageOptions | ExecutionContext = (rawOptions && typeof rawOptions === 'object') ? rawOptions : {};
        markAsRead = typeof rawOptions === 'boolean'
          ? rawOptions
          : (readOptions.mark_as_read !== undefined
            ? Boolean(readOptions.mark_as_read)
            : (readOptions.markAsRead !== undefined
              ? Boolean(readOptions.markAsRead)
              : (readOptions.markRead !== undefined ? Boolean(readOptions.markRead) : true)));
      } else {
        // Form: readMessage(messageId, optionsOrContext) where agentId is in optionsOrContext
        const options = (messageIdOrOptions && typeof messageIdOrOptions === 'object') ? messageIdOrOptions : {};
        const bag: Record<string, unknown> = { ...options };
        const readOptions: ReadMessageOptions | ExecutionContext = (options && typeof options === 'object') ? options : {};
        if (bag.agentId || bag.callerAgentId || bag.recipient) {
          agentId = bag.callerAgentId || bag.agentId || bag.recipient;
          messageId = agentIdOrMsgId;
          markAsRead = typeof options === 'boolean'
            ? options
            : (readOptions.mark_as_read !== undefined
              ? Boolean(readOptions.mark_as_read)
              : (readOptions.markAsRead !== undefined
                ? Boolean(readOptions.markAsRead)
                : (readOptions.markRead !== undefined ? Boolean(readOptions.markRead) : true)));
        } else {
          // agentId was passed as 1st arg, messageId missing
          agentId = agentIdOrMsgId;
          messageId = undefined;
          markAsRead = true;
        }
      }
    }

    if (!agentId || typeof agentId !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: 'Agent ID is required to read messages'
      };
    }
    if (!messageId || typeof messageId !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: 'Valid string messageId is required'
      };
    }

    const targetId = String(messageId).trim();
    const mailboxKey = mailboxContext
      ? this.#resolveContextMailboxKey(mailboxContext, agentId)
      : (this.#resolveDirectMailboxKey(agentId) || agentId);
    const surfaceId = this.#bareIdForRef(agentId);
    const queue = this.#activeQueues.get(mailboxKey);
    const idx = queue ? queue.findIndex(m => m.id === targetId || m.messageId === targetId) : -1;

    // 1. Found in active unread queue
    if (queue && idx !== -1) {
      if (!markAsRead) {
        const targetMsg = queue[idx];
        return {
          success: true,
          status: 'inbox',
          message: { ...targetMsg, metadata: { ...targetMsg.metadata } }
        };
      }

      // Strict FIFO dequeue on read: splice from activeQueue
      const [envelope] = queue.splice(idx, 1);
      envelope.read = true;

      let archive = this.#archives.get(mailboxKey);
      if (!archive) {
        archive = [];
        this.#archives.set(mailboxKey, archive);
      }
      archive.push(envelope);

      return {
        success: true,
        status: 'inbox',
        message: { ...envelope, metadata: { ...envelope.metadata } }
      };
    }

    // 2. Found in historical archive
    const archive = this.#archives.get(mailboxKey);
    if (archive && archive.length > 0) {
      const archMsg = archive.find(m => m.id === targetId || m.messageId === targetId);
      if (archMsg) {
        return {
          success: true,
          status: 'archived',
          message: { ...archMsg, read: true, metadata: { ...archMsg.metadata } }
        };
      }
    }

    return {
      success: false,
      code: MESSAGING_ERROR_CODES.MESSAGE_NOT_FOUND,
      error: `Message with ID '${targetId}' not found in inbox or archive of agent '${surfaceId}'`
    };
  }

  /**
   * Atomically consumes all unread messages in an agent's active queue.
   *
   * Shifts each pending envelope from `#activeQueues`, sets `read = true`, appends it to `#archives`,
   * and returns the full array of consumed envelopes. Subsequent invocations immediately return `[]`.
   *
   * @param agentIdOrParams - Target agent ID or params object containing `agentId` (or its `recipient` alias); when a supplied `ExecutionContext` is the trailing argument it is the only mailbox source (an anonymous context drains nothing) and the payload aliases are never promoted (MOD-21 W10-B).
   * @param context - Optional `ExecutionContext` supplying the trusted `callerAgentId` / `agentId`.
   * @returns Array of consumed envelopes with `read: true`.
   *
   * @example
   * ```typescript
   * // Drain pending turn inbox:
   * const turnMessages = bus.drainInbox('researcher');
   * for (const envelope of turnMessages) {
   *   processTask(envelope);
   * }
   *
   * // Subsequent call yields empty array:
   * console.log(bus.drainInbox('researcher').length); // 0
   * ```
   */
  drainInbox(
    agentIdOrParams: string | { agentId?: string; recipient?: string },
    context?: ExecutionContext
  ): MessageEnvelope[] {
    let agentId: string | null | undefined;
    let mailboxContext: ExecutionContext | null = null;
    if (agentIdOrParams && typeof agentIdOrParams === 'object') {
      const contextSupplied = isContextSupplied(context);
      // MOD-21 W10-B: a supplied context drains its caller's mailbox only; a
      // context that binds no caller is anonymous (nothing to drain). Payload
      // routing is a fallback only for contextless direct-API calls.
      agentId = resolveRoutingIdentity(context, contextSupplied, agentIdOrParams.agentId || agentIdOrParams.recipient);
      if (contextSupplied) mailboxContext = context;
    } else if (typeof agentIdOrParams === 'string') {
      agentId = agentIdOrParams;
    }

    if (!agentId || typeof agentId !== 'string') return [];
    // Wave I, ticket d57cbc1: partitions key on the caller's registration
    // identifier, never on an assumed bare id.
    const mailboxKey = mailboxContext
      ? this.#resolveContextMailboxKey(mailboxContext, agentId)
      : (this.#resolveDirectMailboxKey(agentId) || agentId);
    const queue = this.#activeQueues.get(mailboxKey);
    if (!queue || queue.length === 0) return [];

    let archive = this.#archives.get(mailboxKey);
    if (!archive) {
      archive = [];
      this.#archives.set(mailboxKey, archive);
    }

    const drained: MessageEnvelope[] = [];
    while (queue.length > 0) {
      const msg = queue.shift();
      if (!msg) break;
      msg.read = true;
      archive.push(msg);
      drained.push({ ...msg, metadata: { ...msg.metadata } });
    }
    return drained;
  }

  /**
   * Queries historical consumed message envelopes from an agent's archive.
   *
   * Supports filtering by sender (`sender` / `from`), message ID (`messageId` / `id`),
   * minimum timestamp (`since`), and case-insensitive substring search (`search`).
   * Returned envelopes include the persisted `success` delivery flag (`false` only when an
   * explicit `false` was restored) and preserve the persisted broadcast markers: `broadcast`
   * is copied through and `recipients` is shallow-copied when the archived envelope declares them.
   *
   * @param agentIdOrParams - Target agent ID or options object with `agentId` (or its `recipient` alias); when a supplied `ExecutionContext` is the trailing argument it is the only archive source (an anonymous context sees an empty archive) and the payload aliases are never promoted (MOD-21 W10-B).
   * @param optionsOrContext - Query filter options or `ExecutionContext`.
   * @returns Defensive cloned array of matching archived envelopes.
   *
   * @example
   * ```typescript
   * const pastReports = bus.getArchive('director', {
   *   sender: 'researcher',
   *   search: 'quarterly',
   *   limit: 10
   * });
   * ```
   */
  getArchive(
    agentIdOrParams: string | (ArchiveQueryOptions & { agentId?: string; recipient?: string }),
    optionsOrContext?: ArchiveQueryOptions | ExecutionContext
  ): MessageEnvelope[] {
    let agentId: string | null | undefined;
    let options: ArchiveQueryOptions | ExecutionContext = {};
    let mailboxContext: ExecutionContext | null = null;

    if (agentIdOrParams && typeof agentIdOrParams === 'object') {
      const contextSupplied = isContextSupplied(optionsOrContext);
      const context: ExecutionContext = contextSupplied ? optionsOrContext : {};
      // MOD-21 W10-B: a supplied context selects the archive through its
      // caller binding only; a context that binds no caller is anonymous
      // (empty archive). Payload routing is a fallback only for contextless
      // direct-API calls.
      agentId = resolveRoutingIdentity(context, contextSupplied, agentIdOrParams.agentId || agentIdOrParams.recipient);
      options = scrubPayloadRoutingKeys({ ...agentIdOrParams, ...context });
      if (contextSupplied) mailboxContext = context;
    } else if (typeof agentIdOrParams === 'string') {
      agentId = agentIdOrParams;
      options = (optionsOrContext && typeof optionsOrContext === 'object') ? optionsOrContext : {};
    }

    if (!agentId || typeof agentId !== 'string') return [];
    // Wave I, ticket d57cbc1: partitions key on the caller's registration
    // identifier, never on an assumed bare id.
    const mailboxKey = mailboxContext
      ? this.#resolveContextMailboxKey(mailboxContext, agentId)
      : (this.#resolveDirectMailboxKey(agentId) || agentId);
    const surfaceId = this.#bareIdForRef(agentId);
    const archive = this.#archives.get(mailboxKey) || [];
    let filtered = [...archive];

    const targetSender: string | undefined = (typeof options.sender === 'string' && options.sender)
      ? options.sender
      : (typeof options.from === 'string' ? options.from : undefined);

    if (targetSender) {
      filtered = filtered.filter(msg => msg.from === targetSender);
    }

    const targetId: string | undefined = (typeof options.messageId === 'string' && options.messageId)
      ? options.messageId
      : (typeof options.id === 'string' ? options.id : undefined);

    if (targetId) {
      filtered = filtered.filter(msg => msg.id === targetId || msg.messageId === targetId);
    }

    const since: number | undefined = typeof options.since === 'number' ? options.since : (typeof options.after === 'number' ? options.after : undefined);
    if (typeof since === 'number') {
      filtered = filtered.filter(msg => msg.timestamp >= since);
    }

    if (typeof options.search === 'string' && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      filtered = filtered.filter(msg => {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return text.toLowerCase().includes(q);
      });
    }

    if (typeof options.offset === 'number' && options.offset > 0) {
      filtered = filtered.slice(options.offset);
    } else if (typeof options.skip === 'number' && options.skip > 0) {
      filtered = filtered.slice(options.skip);
    }

    const limit: number = typeof options.limit === 'number'
      ? options.limit
      : (typeof options.max === 'number'
        ? options.max
        : (typeof options.count === 'number'
          ? options.count
          : (typeof options.pageSize === 'number'
            ? options.pageSize
            : (typeof options.page_size === 'number' ? options.page_size : 20))));

    filtered = filtered.slice(0, limit);

    return filtered.map(msg => {
      const projected: MutableMessageEnvelope = {
        id: msg.id || msg.messageId,
        messageId: msg.messageId || msg.id,
        from: msg.from,
        to: msg.to || surfaceId,
        replyTo: msg.replyTo || msg.from,
        type: readMetadataString(msg.type) || readMetadataString(msg.metadata?.type) || 'message',
        content: msg.content,
        metadata: msg.metadata ? { ...msg.metadata } : {},
        timestamp: msg.timestamp,
        read: true,
        success: msg.success !== false
      };

      if (msg.broadcast !== undefined) {
        projected.broadcast = msg.broadcast;
      }
      if (Array.isArray(msg.recipients)) {
        projected.recipients = [...msg.recipients];
      }

      return projected;
    });
  }

  /**
   * Registers a real-time reactive delivery listener for messages routed through the bus.
   *
   * @param recipientFilter - Target recipient agent ID to listen for, or `'all'` for wildcard listener.
   * @param handler - Callback function invoked when an envelope is delivered.
   * @returns Teardown callback function to unbind the listener.
   * @throws `Error` - If `recipientFilter` is not a non-empty string or `handler` is not a function.
   *
   * @example
   * ```typescript
   * // Listen for all bus traffic (e.g. UI store integration):
   * const unsubscribe = bus.subscribe('all', (envelope) => {
   *   console.log(`Live message routed from ${envelope.from} to ${envelope.to}`);
   * });
   *
   * // Cleanup on component destroy:
   * unsubscribe();
   * ```
   */
  subscribe(
    recipientFilter: string | 'all',
    handler: (message: MessageEnvelope) => void
  ): UnsubscribeFn {
    if (!recipientFilter || typeof recipientFilter !== 'string') {
      throw new Error("subscribe requires a valid 'recipientFilter' string");
    }
    if (typeof handler !== 'function') {
      throw new Error("subscribe requires a valid 'handler' callback function");
    }

    const sub = { recipientFilter, handler };
    this.#subscriptions.add(sub);

    return () => {
      this.#subscriptions.delete(sub);
    };
  }

  /**
   * Concurrency-safe non-polling asynchronous primitive that halts turn execution until expected
   * senders deliver mail, or until a timeout expires or abort signal fires.
   *
   * Execution Lifecycle:
   * 1. Inspects `#activeQueues` for matching pending mail; if found and `markAsRead: true`, dequeues immediately.
   * 2. If satisfaction predicate is met, resolves immediately without asynchronous wait.
   * 3. Otherwise, attaches a real-time pub/sub listener, arms timeout timer, and binds abort listener.
   * 4. Cleans up timers and subscribers atomically upon satisfaction, timeout, or abort.
   *
   * @param recipientOrParams - Recipient agent ID, or full options object with `recipient`/`targetAgentId`/`target_agent_id`/`recipientId`/`recipient_id` and the sender aliases `sender_id`/`senderId`/`from_agent`/`fromAgent` (object call form); when a supplied `ExecutionContext` is the trailing argument it is the only awaited-mailbox source and the payload recipient aliases are never promoted (an anonymous context fails `INVALID_ARGUMENTS`, MOD-21 W10-B).
   * @param optionsOrSenders - Wait options or list of sender IDs to await.
   * @param maybeOptionsOrContext - Additional options or `ExecutionContext`.
   * @returns Promise resolving to structured wait result.
   *
   * @example
   * ```typescript
   * // Await messages from two workers:
   * const result = await bus.waitForMail('orchestrator', {
   *   senders: ['worker_1', 'worker_2'],
   *   timeoutMs: 10000,
   *   requireAll: true,
   *   markAsRead: true
   * });
   *
   * if (result.success && result.timedOut) {
   *   console.warn(`Missing responses from: ${result.missingSenders.join(', ')}`);
   * } else if (result.success) {
   *   console.log(`Received ${result.count} messages.`);
   * } else {
   *   console.error(`Wait failed [${result.code}]: ${result.error}`);
   * }
   * ```
   */
  async waitForMail(
    recipientOrParams: string | (WaitForMailOptions & {
      recipient?: string;
      targetAgentId?: string;
      target_agent_id?: string;
      recipientId?: string;
      recipient_id?: string;
      sender_id?: string;
      senderId?: string;
      from_agent?: string;
      fromAgent?: string;
    }),
    optionsOrSenders?: WaitForMailOptions | string[] | string,
    maybeOptionsOrContext: WaitForMailOptions | ExecutionContext = {}
  ): Promise<WaitForMailResult> {
    let recipientId: string | null | undefined;
    let options: (WaitForMailOptions & { targetAgentId?: string; agentId?: string }) | ExecutionContext = {};
    let rawSenders: unknown;
    let mailboxContext: ExecutionContext | null = null;

    if (recipientOrParams && typeof recipientOrParams === 'object') {
      // Form: waitForMail(params, context)
      const params = recipientOrParams;
      const paramsBag: Record<string, unknown> = { ...params };
      const contextSupplied = isContextSupplied(optionsOrSenders);
      const context: ExecutionContext = contextSupplied ? optionsOrSenders : {};
      if (contextSupplied) mailboxContext = context;
      // MOD-21 W10-B: a supplied context awaits its caller's mailbox only; a
      // context that binds no caller is anonymous (no mailbox, default-deny).
      // Payload routing is a fallback only for contextless direct-API calls
      // (sender filter aliases remain available via `sender`/`from`).
      recipientId = resolveRoutingIdentity(
        context,
        contextSupplied,
        params.recipient || params.recipientId || params.recipient_id
          || params.targetAgentId || params.target_agent_id || paramsBag.agentId
      );
      options = scrubPayloadRoutingKeys({ ...params, ...context });
      rawSenders = options.senders !== undefined
        ? options.senders
        : (options.sender !== undefined
          ? options.sender
          : (options.from !== undefined
            ? options.from
            : (options.sender_id !== undefined
              ? options.sender_id
              : (options.senderId !== undefined
                ? options.senderId
                : (options.from_agent !== undefined
                  ? options.from_agent
                  : options.fromAgent)))));
    } else if (typeof recipientOrParams === 'string') {
      recipientId = recipientOrParams;
      if (Array.isArray(optionsOrSenders)) {
        rawSenders = optionsOrSenders;
        options = (maybeOptionsOrContext && typeof maybeOptionsOrContext === 'object') ? maybeOptionsOrContext : {};
      } else if (typeof optionsOrSenders === 'string') {
        rawSenders = [optionsOrSenders];
        options = (maybeOptionsOrContext && typeof maybeOptionsOrContext === 'object') ? maybeOptionsOrContext : {};
      } else if (optionsOrSenders && typeof optionsOrSenders === 'object' && !Array.isArray(optionsOrSenders)) {
        options = optionsOrSenders;
        rawSenders = options.senders !== undefined
          ? options.senders
          : (options.sender !== undefined
            ? options.sender
            : (options.from !== undefined
              ? options.from
              : (options.targetAgentId !== undefined
                ? options.targetAgentId
                : (options.agentId !== undefined ? options.agentId : undefined))));
      }
    }

    if (!recipientId || typeof recipientId !== 'string') {
      return {
        success: false,
        error: "Missing required string 'recipientId'",
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    let senderList: string[] = [];
    if (Array.isArray(rawSenders)) {
      senderList = rawSenders.map(s => String(s).trim()).filter(Boolean);
    } else if (typeof rawSenders === 'string' && rawSenders.trim()) {
      senderList = [rawSenders.trim()];
    }

    const isAnySender = senderList.length === 0 || senderList.includes('*') || senderList.includes('all');
    const targetSenderSet = isAnySender ? null : new Set(senderList);

    const timeoutMs: number = typeof options.timeout_ms === 'number'
      ? Math.max(0, options.timeout_ms)
      : (typeof options.timeoutMs === 'number'
        ? Math.max(0, options.timeoutMs)
        : (typeof options.timeout === 'number' ? Math.max(0, options.timeout) : 10000));

    const requireAll: boolean = options.require_all !== undefined
      ? Boolean(options.require_all)
      : (options.requireAll !== undefined ? Boolean(options.requireAll) : true);

    const markAsRead: boolean = options.mark_as_read !== undefined
      ? Boolean(options.mark_as_read)
      : (options.markAsRead !== undefined
        ? Boolean(options.markAsRead)
        : (options.markRead !== undefined ? Boolean(options.markRead) : true));

    const includeRead: boolean = options.include_read !== undefined
      ? Boolean(options.include_read)
      : (options.includeRead !== undefined ? Boolean(options.includeRead) : false);

    const sinceTimestamp: number | null = typeof options.sinceTimestamp === 'number'
      ? options.sinceTimestamp
      : (typeof options.since === 'number'
        ? options.since
        : (typeof options.after === 'number' ? options.after : null));

    const signal: AbortSignal | null | undefined = (options.signal instanceof AbortSignal)
      ? options.signal
      : (options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined);

    const collectedMessages: MessageEnvelope[] = [];
    const receivedSenderSet = new Set<string>();

    // Wave I, ticket d57cbc1: the awaited mailbox partitions on the caller's
    // registration identifier, while `recipientId` stays the bare ref used to
    // match delivered envelope targets.
    const mailboxKey = mailboxContext
      ? this.#resolveContextMailboxKey(mailboxContext, recipientId)
      : (this.#resolveDirectMailboxKey(recipientId) || recipientId);

    let archive = this.#archives.get(mailboxKey);
    if (!archive) {
      archive = [];
      this.#archives.set(mailboxKey, archive);
    }

    // 0. If includeRead is enabled, inspect archived messages matching sender and timestamp criteria
    if (includeRead && archive.length > 0) {
      for (const msg of archive) {
        const matchesSender = !targetSenderSet || targetSenderSet.has(msg.from);
        const matchesSince = sinceTimestamp === null || msg.timestamp >= sinceTimestamp;
        if (matchesSender && matchesSince) {
          const msgId = msg.id || msg.messageId;
          if (!collectedMessages.some(m => (m.id || m.messageId) === msgId)) {
            collectedMessages.push({ ...msg, metadata: { ...msg.metadata } });
            receivedSenderSet.add(msg.from);
          }
        }
      }
    }

    // 1. Inspect existing activeQueue messages and dequeue matching envelopes
    const queue = this.#activeQueues.get(mailboxKey) || [];
    let i = 0;
    while (i < queue.length) {
      const msg = queue[i];
      const matchesSender = !targetSenderSet || targetSenderSet.has(msg.from);
      const matchesSince = sinceTimestamp === null || msg.timestamp >= sinceTimestamp;

      if (matchesSender && matchesSince) {
        if (markAsRead) {
          queue.splice(i, 1);
          msg.read = true;
          const msgId = msg.id || msg.messageId;
          if (!archive.some(a => (a.id || a.messageId) === msgId)) {
            archive.push(msg);
          }
        } else {
          i++;
        }
        const msgId = msg.id || msg.messageId;
        if (!collectedMessages.some(m => (m.id || m.messageId) === msgId)) {
          collectedMessages.push({ ...msg, metadata: { ...msg.metadata } });
          receivedSenderSet.add(msg.from);
        }
      } else {
        i++;
      }
    }

    const isSatisfied = () => {
      if (isAnySender) {
        return collectedMessages.length > 0;
      }
      if (requireAll) {
        for (const expectedSender of senderList) {
          if (!receivedSenderSet.has(expectedSender)) {
            return false;
          }
        }
        return true;
      } else {
        return collectedMessages.length > 0;
      }
    };

    if (isSatisfied()) {
      const missingSenders = isAnySender ? [] : senderList.filter(s => !receivedSenderSet.has(s));
      return {
        success: true,
        messages: collectedMessages,
        count: collectedMessages.length,
        timedOut: false,
        receivedSenders: Array.from(receivedSenderSet),
        missingSenders
      };
    }

    if (timeoutMs === 0) {
      const missingSenders = isAnySender ? [] : senderList.filter(s => !receivedSenderSet.has(s));
      return {
        success: true,
        messages: collectedMessages,
        count: collectedMessages.length,
        timedOut: true,
        receivedSenders: Array.from(receivedSenderSet),
        missingSenders,
        code: MESSAGING_ERROR_CODES.TIMEOUT
      };
    }

    // 2. Wait for incoming messages via bus subscription
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: UnsubscribeFn | null = null;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const finish = (timedOut: boolean, aborted = false) => {
        cleanup();
        const missingSenders = isAnySender ? [] : senderList.filter(s => !receivedSenderSet.has(s));
        const projection = {
          messages: collectedMessages,
          count: collectedMessages.length,
          timedOut: Boolean(timedOut),
          receivedSenders: Array.from(receivedSenderSet),
          missingSenders
        };
        if (aborted) {
          resolve({
            success: false,
            ...projection,
            code: MESSAGING_ERROR_CODES.ABORTED,
            error: 'Operation was aborted'
          });
          return;
        }
        if (timedOut && !isSatisfied()) {
          resolve({
            success: true,
            ...projection,
            code: MESSAGING_ERROR_CODES.TIMEOUT
          });
          return;
        }
        resolve({
          success: true,
          ...projection
        });
      };

      const abortHandler = () => {
        finish(false, true);
      };

      if (signal) {
        if (signal.aborted) {
          finish(false, true);
          return;
        }
        signal.addEventListener('abort', abortHandler);
      }

      unsubscribe = this.subscribe('all', (message) => {
        if (settled) return;
        const isForRecipient = message.to === recipientId ||
          message.to === mailboxKey ||
          (message.to === 'all' && message.from !== recipientId);

        if (isForRecipient) {
          if (!targetSenderSet || targetSenderSet.has(message.from)) {
            const matchesSince = sinceTimestamp === null || message.timestamp >= sinceTimestamp;
            if (matchesSince) {
              let envelope = message;
              const envId = envelope.id || envelope.messageId;
              if (markAsRead) {
                const currentQueue = this.#activeQueues.get(mailboxKey) || [];
                const qIdx = currentQueue.findIndex(m => (m.id || m.messageId) === envId);
                if (qIdx !== -1) {
                  [envelope] = currentQueue.splice(qIdx, 1);
                }
                envelope.read = true;
                if (!archive.some(a => (a.id || a.messageId) === envId)) {
                  archive.push(envelope);
                }
              }
              if (!collectedMessages.some(m => (m.id || m.messageId) === envId)) {
                collectedMessages.push({ ...envelope, metadata: { ...envelope.metadata } });
                receivedSenderSet.add(envelope.from);
              }

              if (isSatisfied()) {
                finish(false);
              }
            }
          }
        }
      });

      timer = setTimeout(() => {
        finish(true);
      }, timeoutMs);
    });
  }

  /**
   * Reads a virtual file from `VirtualFS` and embeds its formatted content directly into an
   * outgoing message envelope dispatched to the recipient. When the VirtualFS read budget
   * truncates the file, the delivered message carries a truncation notice, `truncated` is
   * `true`, `deliveryNote` reports the truncation guidance, and `totalBytes` /
   * `inlinedFiles[].bytes` report the delivered byte count.
   *
   * @param filePathOrParams - Virtual file path or full `InlineFileOptions` object (accepts the declared path, recipient, sender, message, and reply-to aliases); in the object form a supplied `ExecutionContext` owns both the sender identity and the VirtualFS read identity/workspace, so a context binding no caller fails closed and payload identity is never promoted (MOD-21 W10-B).
   * @param recipientOrContext - Target recipient agent ID or `ExecutionContext`.
   * @param optionsOrContext - Inline file options or `ExecutionContext`.
   * @returns Promise resolving to structured delivery receipt with file metadata.
   * @remarks Failure codes: `VFS_UNAVAILABLE` (no usable VirtualFS), `INVALID_ARGUMENTS`
   * (missing path, recipient, or caller), `FILE_NOT_FOUND` (any `VirtualFS.readFile` failure),
   * or `PERMISSION_DENIED` (a non-bypass caller addressing a bypass subject or a cross-Realm
   * recipient, refused before the VirtualFS read whenever the recipient survives the
   * dead-letter checks).
   *
   * @example
   * ```typescript
   * const result = await bus.inlineFileInMessage({
   *   filePath: '/workspace/findings.md',
   *   recipient: 'director',
   *   from: 'analyst',
   *   message: 'Here are the latest findings.'
   * }, { virtualFs, callerAgentId: 'analyst' });
   *
   * if (result.success) {
   *   console.log(`Delivered message with ${result.totalBytes} bytes inlined.`);
   * }
   * ```
   */
  async inlineFileInMessage(
    filePathOrParams: string | InlineFileOptions,
    recipientOrContext?: string | ExecutionContext,
    optionsOrContext?: InlineFileOptions | ExecutionContext
  ): Promise<InlineFileMessageResult> {
    let filePath: string | undefined;
    let recipient: string | undefined;
    let callerAgentId: string | null | undefined;
    let callerKey: string | undefined;
    let message: string | undefined;
    let template: string | undefined;
    let replyTo: string | undefined;
    let metadata: MetadataBag = {};
    let virtualFs: VirtualFS | null | undefined;
    let workspaceId: string | undefined;
    let realmSourceContext: RealmPrincipalSource | null = null;

    if (filePathOrParams && typeof filePathOrParams === 'object') {
      const params = filePathOrParams;
      const contextSupplied = isContextSupplied(recipientOrContext);
      const context: ExecutionContext = contextSupplied ? recipientOrContext : {};
      if (contextSupplied) realmSourceContext = context;
      filePath = params.file_path || params.filePath || params.path;
      recipient = params.recipient || params.to || params.targetAgentId || params.target_agent_id || params.recipient_id || params.recipientId;
      // MOD-21 W10-B: a supplied context owns the inlined sender identity and
      // the VirtualFS read identity/substrate; a context that binds no caller
      // is anonymous and fails closed. Payload identity and substrate are
      // fallbacks only for genuinely contextless direct-API calls.
      callerAgentId = resolveRoutingIdentity(context, contextSupplied, params.from || params.sender || params.callerAgentId);
      // Wave I, ticket d57cbc1: the trusted context may bind the caller's
      // canonical key; it is identity only, never promoted from payloads.
      callerKey = contextSupplied
        ? readMetadataString(context.callerKey)
        : readMetadataString((params as { callerKey?: unknown }).callerKey);
      message = params.message || params.content || params.text || params.body || '';
      template = params.template;
      replyTo = params.replyTo || params.in_reply_to || params.reply_to;
      metadata = params.metadata ? { ...params.metadata } : {};
      virtualFs = contextSupplied ? context.virtualFs : params.virtualFs;
      workspaceId = contextSupplied ? readMetadataString(context.workspaceId) : params.workspaceId;
    } else if (typeof filePathOrParams === 'string') {
      filePath = filePathOrParams;
      if (typeof recipientOrContext === 'string') {
        recipient = recipientOrContext;
        const opts: InlineFileOptions | ExecutionContext = (optionsOrContext && typeof optionsOrContext === 'object') ? optionsOrContext : {};
        if ('principal' in opts) realmSourceContext = { principal: opts.principal };
        callerAgentId = readMetadataString(opts.callerAgentId) || readMetadataString('agentId' in opts ? opts.agentId : undefined) || readMetadataString(opts.from) || readMetadataString(opts.sender);
        callerKey = readMetadataString((opts as { callerKey?: unknown }).callerKey);
        message = readMetadataString(opts.message) || readMetadataString(opts.content) || readMetadataString(opts.text) || readMetadataString(opts.body) || '';
        template = readMetadataString(opts.template);
        replyTo = readMetadataString(opts.replyTo) || readMetadataString(opts.in_reply_to) || readMetadataString(opts.reply_to);
        metadata = (opts.metadata && typeof opts.metadata === 'object') ? { ...opts.metadata } : {};
        virtualFs = opts.virtualFs;
        workspaceId = readMetadataString(opts.workspaceId);
      } else {
        const opts: InlineFileOptions | ExecutionContext = (recipientOrContext && typeof recipientOrContext === 'object') ? recipientOrContext : {};
        if ('principal' in opts) realmSourceContext = { principal: opts.principal };
        recipient = readMetadataString(opts.recipient) || readMetadataString(opts.to) || readMetadataString(opts.targetAgentId) || readMetadataString(opts.target_agent_id);
        callerAgentId = readMetadataString(opts.callerAgentId) || readMetadataString('agentId' in opts ? opts.agentId : undefined) || readMetadataString(opts.from) || readMetadataString(opts.sender);
        callerKey = readMetadataString((opts as { callerKey?: unknown }).callerKey);
        message = readMetadataString(opts.message) || readMetadataString(opts.content) || readMetadataString(opts.text) || readMetadataString(opts.body) || '';
        template = readMetadataString(opts.template);
        replyTo = readMetadataString(opts.replyTo) || readMetadataString(opts.in_reply_to) || readMetadataString(opts.reply_to);
        metadata = (opts.metadata && typeof opts.metadata === 'object') ? { ...opts.metadata } : {};
        virtualFs = opts.virtualFs;
        workspaceId = readMetadataString(opts.workspaceId);
      }
    }

    if (!virtualFs || typeof virtualFs.readFile !== 'function') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.VFS_UNAVAILABLE,
        error: 'VirtualFS is not available in execution context'
      };
    }

    if (!filePath || typeof filePath !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: "Valid string 'filePath' is required"
      };
    }

    if (!recipient || typeof recipient !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: "Valid string 'recipient' is required"
      };
    }

    if (!callerAgentId || typeof callerAgentId !== 'string') {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.INVALID_ARGUMENTS,
        error: 'Caller agent ID is required'
      };
    }

    // Caller/sender resolution (Wave I, ticket d57cbc1): the trusted
    // `callerKey` in the internal context (or the port's unique bare-id match)
    // owns the sender identity and Realm scope; the exact injected
    // internal-principal reference still marks the engine/operator path as
    // realm-bypassing. Only the bare id reaches the envelope.
    const senderSubject = this.#resolveCallerSubject(callerAgentId, realmSourceContext);
    const senderScope: ResolvedRealmScope = senderSubject
      ? { realmId: senderSubject.realmId, realmBypass: senderSubject.realmBypass }
      : { realmId: null, realmBypass: false };
    const senderId = (senderSubject && senderSubject.id) ? senderSubject.id : callerAgentId;

    // Realm gate (Realm wave A, ticket 7387ce1; Wave I, ticket d57cbc1): refuse
    // a cross-realm inline before any VirtualFS read when the recipient would
    // otherwise be deliverable (registered, non-terminated); dead-letter codes
    // keep precedence. The delegated send re-applies the same gate, and a
    // foreign/ambiguous recipient ref is never disclosed.
    let recipientSurfaceId = recipient;
    if (recipient !== 'all') {
      const recipientResolution = this.#resolveRecipient(recipient, senderScope);
      recipientSurfaceId = recipientResolution.id || recipient;
      const recipientMailboxKey = recipientResolution.mailboxKey || recipient;
      const deliverable = recipientResolution.kind === 'resolved' &&
        this.#registeredAgents.has(recipientMailboxKey) &&
        !this.#terminatedAgents.has(recipientMailboxKey);
      if (recipientResolution.kind === 'ambiguous' || (deliverable && !recipientResolution.scopeAllowed)) {
        return {
          success: false,
          code: MESSAGING_ERROR_CODES.PERMISSION_DENIED,
          error: `Cross-realm delivery to '${recipientSurfaceId}' is denied`
        };
      }
    }

    let readResult: ReadFileResult & { readonly notice?: string };
    try {
      // Wave I, ticket d57cbc1: forward the trusted canonical `callerKey`
      // (parsed from the internal context, never from payload claims) into the
      // VirtualFS read context, so a caller whose bare literal id is shared by
      // two Realms resolves realm-exactly instead of failing closed on an
      // unresolvable identity.
      readResult = await virtualFs.readFile(filePath, {
        workspaceId,
        callerAgentId,
        ...(callerKey ? { callerKey } : {})
      });
    } catch (err) {
      return {
        success: false,
        code: MESSAGING_ERROR_CODES.FILE_NOT_FOUND,
        error: readErrorMessage(err) || `File '${filePath}' not found or unreadable in VirtualFS`
      };
    }

    const fileContent = readResult.content;

    // Byte accounting must describe what is actually embedded: VirtualFS may truncate
    // `content` to its read budget, so prefer the delivered `bytesIncluded` over the
    // full-file `totalBytes`.
    const fileBytes = typeof readResult.bytesIncluded === 'number'
      ? readResult.bytesIncluded
      : (this.#byteLength
        ? this.#byteLength(fileContent)
        : (typeof Buffer !== 'undefined' ? Buffer.byteLength(fileContent, 'utf8') : fileContent.length));

    const isTruncated = readResult.truncated === true;
    const truncationNote = isTruncated
      ? (readResult.deliveryNote || readResult.notice || `Inlined content truncated to ${fileBytes} bytes.`)
      : null;

    let assembledContent: string;
    if (template && typeof template === 'string') {
      assembledContent = template
        .replace(/\$\{content\}/g, fileContent)
        .replace(/\$\{file\}/g, fileContent)
        .replace(/\$\{filePath\}/g, filePath)
        .replace(/\$\{file_path\}/g, filePath);
      if (truncationNote) {
        assembledContent += `\n--- Truncation Notice: ${truncationNote} ---`;
      }
    } else {
      const prefix = message ? `${message}\n\n` : '';
      const truncationSuffix = truncationNote ? `\n--- Truncation Notice: ${truncationNote} ---` : '';
      assembledContent = `${prefix}--- Inlined File: ${filePath} (${fileBytes} bytes) ---\n${fileContent}${truncationSuffix}\n--- End of File ---`;
    }

    const wordsCount = fileContent.trim() ? fileContent.trim().split(/\s+/).length : 0;

    // Preserve an engine-principal host context across the delegated send so
    // the Realm gate resolves the same bypass it did above (the delegated
    // context binds the same caller + canonical key, keeping W10-B identity
    // authoritative) and the delegated send resolves the same caller identity.
    const delegatedContext: ExecutionContext | undefined = (realmSourceContext && this.#internalPrincipal && realmSourceContext.principal === this.#internalPrincipal)
      ? {
        callerAgentId: senderId,
        principal: this.#internalPrincipal,
        ...(callerKey ? { callerKey } : {})
      }
      : {
        callerAgentId: senderId,
        ...(callerKey ? { callerKey } : {})
      };

    const sendReceipt = this.sendMessage({
      from: senderId,
      to: recipient,
      replyTo,
      content: assembledContent,
      metadata: {
        ...metadata,
        inlinedFiles: [{ path: filePath, bytes: fileBytes }]
      }
    }, delegatedContext);

    if (!sendReceipt.success) {
      return {
        ...sendReceipt,
        inlinedFiles: [{ path: filePath, bytes: fileBytes }],
        totalBytes: fileBytes,
        truncated: isTruncated,
        ...(truncationNote ? { deliveryNote: truncationNote } : {}),
        wordsCount
      };
    }

    return {
      ...sendReceipt,
      inlinedFiles: [{ path: filePath, bytes: fileBytes }],
      totalBytes: fileBytes,
      truncated: isTruncated,
      ...(truncationNote ? { deliveryNote: truncationNote } : {}),
      wordsCount,
      deliveryConfirmation: `Successfully inlined '${filePath}' (${fileBytes} bytes) into message for '${recipientSurfaceId}'`
    };
  }

  /**
   * Retrieves an immutable defensive array copy of message envelopes routed through the bus across the session.
   *
   * Retained in append-only chronological order for UI trace visualization, timeline rendering, and deterministic debugging.
   *
   * @param filter - Optional filter criteria (agentId, sender, recipient, type, since timestamp, limit).
   * @returns Defensive array copy of matching audit log envelopes.
   *
   * @example
   * ```typescript
   * // Query full audit trail for an agent:
   * const history = bus.getAuditLog({ agentId: 'director', limit: 100 });
   * console.log(`Audit log contains ${history.length} events for director.`);
   * ```
   */
  getAuditLog(filter: AuditLogFilter = {}): MessageEnvelope[] {
    let results = [...this.#auditLog];

    if (filter.agentId) {
      results = results.filter(
        msg => msg.from === filter.agentId || msg.to === filter.agentId || msg.to === 'all'
      );
    }

    if (filter.from) {
      results = results.filter(msg => msg.from === filter.from);
    }

    if (filter.to) {
      results = results.filter(msg => msg.to === filter.to);
    }

    if (filter.type) {
      results = results.filter(msg => msg.type === filter.type);
    }

    if (typeof filter.since === 'number') {
      const since = filter.since;
      results = results.filter(msg => msg.timestamp >= since);
    }

    if (typeof filter.limit === 'number' && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results.map(msg => ({ ...msg, metadata: { ...msg.metadata } }));
  }

  /**
   * Exports an immutable, deep-cloned JSON snapshot containing all active queues, archives,
   * audit logs, registered agents, and terminated agents. Subscriptions and their live
   * handlers are not part of the snapshot.
   *
   * Envelopes are copied whole, so the persisted `success` delivery flag survives serialization.
   *
   * @returns Deep-cloned snapshot object safe for JSON serialization.
   *
   * @example
   * ```typescript
   * const snapshot = bus.exportSnapshot();
   * const serialized = JSON.stringify(snapshot);
   * localStorage.setItem('sandbox_bus_state', serialized);
   * ```
   */
  exportSnapshot(): MessagingBusSnapshot {
    const activeQueuesObj: Record<string, MessageEnvelope[]> = {};
    for (const [agentId, queue] of this.#activeQueues.entries()) {
      activeQueuesObj[agentId] = (queue || []).map(m => ({
        ...m,
        metadata: { ...m.metadata }
      }));
    }

    const archivesObj: Record<string, MessageEnvelope[]> = {};
    for (const [agentId, msgs] of this.#archives.entries()) {
      archivesObj[agentId] = (msgs || []).map(m => ({
        ...m,
        metadata: { ...m.metadata }
      }));
    }

    const registeredAgentsObj: Record<string, { mode: 'queued' }> = {};
    for (const agentId of this.#registeredAgents) {
      // MOD-21 W4: trust is never persisted; only the routing mode survives.
      registeredAgentsObj[agentId] = {
        mode: 'queued'
      };
    }

    const snapshot: MessagingBusSnapshot = {
      auditLog: this.#auditLog.map(m => ({ ...m, metadata: { ...m.metadata } })),
      activeQueues: activeQueuesObj,
      archives: archivesObj,
      inboxes: activeQueuesObj, // backward-compatibility alias for legacy consumers
      registeredAgents: registeredAgentsObj,
      terminatedAgents: Array.from(this.#terminatedAgents)
    };

    if (this.#cloneUtil) {
      return this.#cloneUtil(snapshot);
    }
    return typeof structuredClone === 'function'
      ? structuredClone(snapshot)
      : JSON.parse(JSON.stringify(snapshot));
  }

  /**
   * Hydrates bus state from a persistence snapshot object.
   *
   * Clears all existing active queues, archives, audit logs, registrations, terminations,
   * and subscriptions before restoring state. Subscriptions are not part of a snapshot, so
   * none are restored.
   *
   * Supports both modern snapshot schema and legacy `{ inboxes: { [agentId]: Envelope[] } }` schema,
   * accurately partitioning legacy envelopes into unread `#activeQueues` (`read === false`)
   * and historical `#archives` (`read === true`).
   * Every restored envelope receives an explicit `success` flag: an absent legacy value
   * defaults to `true` (the envelope was persisted, hence delivered), while an explicit
   * `false` is preserved.
   *
   * @param snapshot - Snapshot object to hydrate from.
   * @returns void
   *
   * @example
   * ```typescript
   * const raw = localStorage.getItem('sandbox_bus_state');
   * if (raw) {
   *   bus.importSnapshot(JSON.parse(raw));
   * }
   * ```
   */
  importSnapshot(snapshot: MessagingBusSnapshot | Record<string, unknown>): void {
    this.reset();
    if (!snapshot || typeof snapshot !== 'object') return;

    if (Array.isArray(snapshot.terminatedAgents)) {
      for (const agentId of snapshot.terminatedAgents) {
        if (agentId && typeof agentId === 'string') {
          this.#terminatedAgents.add(agentId);
        }
      }
    }

    if (Array.isArray(snapshot.auditLog)) {
      this.#auditLog = snapshot.auditLog.map(m => {
        const messageId = m.messageId || m.id || this.#generateMessageId();
        return {
          ...m,
          id: messageId,
          messageId,
          replyTo: m.replyTo || m.from,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          type: m.type || m.metadata?.type || 'message',
          metadata: m.metadata ? { ...m.metadata } : {},
          read: Boolean(m.read),
          success: m.success !== false
        };
      });
    }

    // Restore registered agents
    if (snapshot.registeredAgents) {
      if (Array.isArray(snapshot.registeredAgents)) {
        for (const agentId of snapshot.registeredAgents) {
          if (agentId && typeof agentId === 'string') {
            this.registerAgent(agentId);
          }
        }
      } else if (typeof snapshot.registeredAgents === 'object') {
        for (const agentId of Object.keys(snapshot.registeredAgents)) {
          if (agentId) {
            // MOD-21 W4: snapshot policy is untrusted; re-derive on read.
            this.registerAgent(agentId);
          }
        }
      }
    }

    // Restore activeQueues
    if (snapshot.activeQueues && typeof snapshot.activeQueues === 'object') {
      for (const [agentId, msgs] of Object.entries(snapshot.activeQueues)) {
        if (Array.isArray(msgs)) {
          this.#activeQueues.set(
            agentId,
            msgs.map(m => {
              const messageId = m.messageId || m.id || this.#generateMessageId();
              return {
                ...m,
                id: messageId,
                messageId,
                replyTo: m.replyTo || m.from,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
                type: m.type || m.metadata?.type || 'message',
                metadata: m.metadata ? { ...m.metadata } : {},
                read: false,
                success: m.success !== false
              };
            })
          );
        }
      }
    } else if (snapshot.inboxes && typeof snapshot.inboxes === 'object') {
      // Legacy format fallback: partition messages into activeQueues (unread) and archives (read)
      for (const [agentId, msgs] of Object.entries(snapshot.inboxes)) {
        if (Array.isArray(msgs)) {
          const unread: MutableMessageEnvelope[] = [];
          const read: MutableMessageEnvelope[] = [];
          for (const m of msgs) {
            const messageId = m.messageId || m.id || this.#generateMessageId();
            const env = {
              ...m,
              id: messageId,
              messageId,
              replyTo: m.replyTo || m.from,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
              type: m.type || m.metadata?.type || 'message',
              metadata: m.metadata ? { ...m.metadata } : {},
              read: Boolean(m.read),
              success: m.success !== false
            };
            if (env.read) {
              read.push(env);
            } else {
              unread.push(env);
            }
          }
          this.#activeQueues.set(agentId, unread);
          if (read.length > 0) {
            this.#archives.set(agentId, read);
          }
        }
      }
    }

    // Restore archives
    if (snapshot.archives && typeof snapshot.archives === 'object') {
      for (const [agentId, msgs] of Object.entries(snapshot.archives)) {
        if (Array.isArray(msgs)) {
          this.#archives.set(
            agentId,
            msgs.map(m => {
              const messageId = m.messageId || m.id || this.#generateMessageId();
              return {
                ...m,
                id: messageId,
                messageId,
                replyTo: m.replyTo || m.from,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
                type: m.type || m.metadata?.type || 'message',
                metadata: m.metadata ? { ...m.metadata } : {},
                read: true,
                success: m.success !== false
              };
            })
          );
        }
      }
    }
  }

  /**
   * Returns an ergonomic proxy instance (`AgentMessagingProxy`) pre-bound to `agentId`.
   * Eliminates repetitive parameter passing in agent runtime wrappers and tool adapters.
   *
   * @param agentId - Agent identifier to bind to the proxy facade.
   * @returns Pre-bound agent messaging proxy.
   * @throws `Error` - If `agentId` is falsy or not a string.
   *
   * @example
   * ```typescript
   * const agentBus = bus.forAgent('researcher');
   * agentBus.sendMessage('director', 'Report submitted.');
   * const unreadCount = agentBus.getUnreadCount();
   * ```
   */
  forAgent(agentId: string): AgentMessagingProxy {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required for forAgent()');
    }

    return {
      agentId,
      sendMessage: (toOrPayload, content, metadata, replyTo) => {
        if (toOrPayload && typeof toOrPayload === 'object') {
          // MOD-21 W9-C: the bound sender is authoritative; payload identity
          // (`from`/`sender`/`callerKey`) is stripped so the proxy cannot
          // spoof another agent.
          const rest = { ...toOrPayload } as SendMessageOptions & { callerKey?: unknown };
          delete rest.from;
          delete rest.sender;
          delete rest.callerKey;
          return this.sendMessage({ ...rest, from: agentId });
        }
        return this.sendMessage({ from: agentId, to: toOrPayload, content, metadata, replyTo });
      },
      broadcast: (content, metadata, replyTo) =>
        this.sendMessage({ from: agentId, to: 'all', content, metadata, replyTo }),
      listInbox: (options = {}) =>
        this.listInbox(agentId, options),
      readMessage: (messageId, options = {}) =>
        this.readMessage(agentId, messageId, options),
      drainInbox: () =>
        this.drainInbox(agentId),
      getArchive: (options = {}) =>
        this.getArchive(agentId, options),
      getUnreadCount: () =>
        this.getUnreadCount(agentId),
      subscribe: (handler) =>
        this.subscribe(agentId, handler),
      waitForMail: (optionsOrSenders, maybeOptions) =>
        this.waitForMail(agentId, optionsOrSenders, maybeOptions),
      inlineFileInMessage: (filePath, recipient, options = {}) => {
        // MOD-21 W9-C (+ Wave I, ticket d57cbc1): the bound sender is
        // authoritative — `from` is placed after the caller spread, and the
        // identity-bearing payload keys (`sender`/`callerAgentId`/`callerKey`)
        // are stripped so the proxy can never spoof another registration.
        const rest = { ...options } as InlineFileOptions & { agentId?: unknown; callerKey?: unknown };
        delete rest.from;
        delete rest.sender;
        delete rest.callerAgentId;
        delete rest.agentId;
        delete rest.callerKey;
        return this.inlineFileInMessage({ filePath, recipient, ...rest, from: agentId });
      }
    };
  }
}
