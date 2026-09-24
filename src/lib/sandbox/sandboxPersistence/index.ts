/**
 * @packageDocumentation
 * Type definitions for the sandbox persistence contract.
 *
 * Persistence is the foundational serialization, schema validation,
 * persistence, and disaster-recovery engine for the multi-agent conversational sandbox.
 * Operating at Layer 0 of the architecture, it provides an opaque, leak-proof boundary
 * between ephemeral in-memory runtime objects and persistent storage (browser LocalStorage,
 * JSON backup dumps, and file export streams).
 *
 * Core persistence engine for multi-agent sandbox snapshots, serialization,
 * deserialization, debounced auto-save coordinator, schema validation, and factory reset primitives (Layer 0).
 *
 * @module sandboxPersistence
 * @invariant Zero-leak credential boundary: secrets, API keys, encryption keys, and KEKs are stripped from agent and model configurations prior to serialization; the retired legacy provider-URL channels (`providerUrl`/`provider_url`) are stripped too, while model-config `url` endpoint references are retained by design; persisted diagnostic errors are redacted.
 * @invariant Zero persisted authority: caller-asserted authority fields (`privileged`, `isPrivileged`, `isAdmin`) are stripped from serialized agent config, and restore re-derives authority through the entity contract (`Agent.fromSnapshot`) — tampered `true` claims downgrade silently to anonymous, schema-invalid claims fail closed, and no persisted path can grant privilege.
 * @invariant Capability selectors are withheld on hydration: persisted `allowedTools`/`tools` are stripped from the copied agent `config` handed to `Agent.fromSnapshot`, so the legacy tool gate cannot re-grant a snapshot-persisted whitelist; the selectors remain serialized data only.
 * @invariant Hydration ids are canonicalized: every persisted agent entry's `id` and `config.id` are trimmed on the copies handed to runtime hydration, so a whitespace-padded reserved-id alias can neither bypass an engine-composed rebuild nor install under a padded key even when a consumer bypasses the runtime's own hydration boundary
 * @invariant Prototype-pollution immunity: every nested workspace, path, and dictionary key is scanned for `__proto__`, `constructor`, and `prototype`, and the snapshot is rejected.
 * @invariant Zero-zombie hydration: recycled/terminated agents restore in state `RECYCLED` and are marked terminated on `MessagingBus`, never receiving trigger subscriptions or mailbox listeners.
 * @invariant Normalization: all active agents restore in state `IDLE` and without authority-bearing capability selectors.
 * @invariant Deterministic message identity and redo isolation: every persisted history message has a stable non-empty id (backfilled in place when missing), and redo stacks are deep-cloned so serialization cannot leak mutations.
 * @invariant Strict topological hydration order: VirtualFS -\> WorldClock -\> MessagingBus -\> AgentRuntime -\> `'state_restored'` event.
 * @invariant Subsystem import receipts are never discarded: a VirtualFS, WorldClock, or MessagingBus import that explicitly rejects its snapshot makes `restoreRuntimeEnvironment` return `{ success: false, code: HYDRATION_FAILED, error, details, receipts }` (with the remaining stages still hydrated) instead of reporting success.
 * @invariant `validateSandboxState` is pure and never throws: it never mutates its input and always returns a `ValidationResult`.
 * @invariant `loadSandboxState` never throws: absent, empty, unparseable, or invalid entries return `null`; unreadable entries are quarantined and reported via `options.onRecovery`.
 * @invariant `saveSandboxStateLocked` serializes concurrent saves through a FIFO promise lock queue so saves never race or lose updates.
 * @decision Authority is never persisted: serialized agent config drops caller-asserted trust fields and restore re-derives the descriptor through `Agent.fromSnapshot` (tampered claims downgrade, schema-invalid claims fail closed)
 * @decision Legacy snapshots that omit `recycleBin` are accepted and normalized to `[]` during hydration
 * @decision Additive MOD-20 topology fields `activePresetId`/`customPresets` round-trip as plain data: serialization emits them from session metadata, validation drops structurally invalid values instead of failing the snapshot, and legacy snapshots without the fields load byte-compatibly
 * @decision Additive realm-registry field `realms` round-trips as plain data: serialization emits only the canonical record fields from session metadata, validation drops structurally invalid entries instead of failing the snapshot, and legacy snapshots without the field load byte-compatibly with an empty registry
 * @decision Additive authority fields `metaAuthorityGrants`/`templateAuthorityTrust` round-trip as plain data emitted from session metadata only when non-empty (legacy snapshots stay byte-identical) and are strictly validated fail-closed: malformed shapes reject the snapshot, proto-pollution keys are rejected by the recursive scan, and hydration never derives authority from either field — grants are re-applied through the composition root's lifecycle-gated restore (unknown/recycled refs skipped) and trust only auto-approves exact declared matches at a later launch
 * @decision Persistence does not re-wire runtime timer listeners on restore; the `MessagingBus` timer-listener lifecycle is owned by `AgentRuntime`
 */

import type { AgentRuntime, RuntimeSnapshot } from '../runtime/index.ts';
import type { VirtualFS } from '../virtualFs/index.ts';
import type { MessageEnvelope, MessagingBus } from '../messagingBus/index.ts';
import type { PartitionClockSnapshot, WorldClock, WorldEvent } from '../worldClock/index.ts';
import type { SerializedScheduledTimer } from '../runtime/runtimeScheduler/index.ts';
import type { Agent, AgentState, HistoryMessage, InterruptedTurn } from '../runtime/agent/index.ts';

import {
  SANDBOX_STATE_STORAGE_KEY,
  getRawLocalStorage,
  hasSandboxStateEntry,
  readSandboxStateEntry,
  removeSandboxStateEntry,
  writeSandboxStateEntry
} from './localStorage.ts';
import { ensureHistoryMessageIds } from '../runtime/historyManager/index.ts';

// ============================================================================
// Constants & Error Codes
// ============================================================================

/**
 * Canonical schema version string for sandbox persisted state snapshots.
 * Used for snapshot compatibility verification and future schema migration gating.
 *
 * @example
 * ```typescript
 * import { SANDBOX_PERSISTENCE_VERSION } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * console.log('Current persistence schema version:', SANDBOX_PERSISTENCE_VERSION);
 * // Output: '1.0.0'
 * ```
 */
export const SANDBOX_PERSISTENCE_VERSION = '1.0.0' as const;

/**
 * Canonical browser LocalStorage key constant for sandbox state.
 * Eliminates hardcoded magic strings across storage adapters, stores, and diagnostic tools.
 *
 * @example
 * ```typescript
 * import { SANDBOX_STATE_STORAGE_KEY } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const rawData = localStorage.getItem(SANDBOX_STATE_STORAGE_KEY);
 * ```
 */
export { SANDBOX_STATE_STORAGE_KEY } from './localStorage.ts';

/**
 * Frozen dictionary of standardized persistence error codes for programmatic
 * inspection without fragile string matching.
 *
 * @example
 * ```typescript
 * import { PERSISTENCE_ERROR_CODES, validateSandboxState } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const res = validateSandboxState(corruptedData);
 * if (!res.valid && res.code === PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED) {
 *   console.error('Security alert: Prototype pollution attack detected in snapshot!');
 * }
 * ```
 */
export const PERSISTENCE_ERROR_CODES: {
  readonly INVALID_STATE: 'ERR_PERSISTENCE_INVALID_STATE';
  readonly VERSION_MISMATCH: 'ERR_PERSISTENCE_VERSION_MISMATCH';
  readonly SERIALIZATION_FAILED: 'ERR_PERSISTENCE_SERIALIZATION_FAILED';
  readonly HYDRATION_FAILED: 'ERR_PERSISTENCE_HYDRATION_FAILED';
  readonly PROTOTYPE_POLLUTION_DETECTED: 'ERR_PERSISTENCE_PROTOTYPE_POLLUTION';
} = Object.freeze({
  INVALID_STATE: 'ERR_PERSISTENCE_INVALID_STATE',
  VERSION_MISMATCH: 'ERR_PERSISTENCE_VERSION_MISMATCH',
  SERIALIZATION_FAILED: 'ERR_PERSISTENCE_SERIALIZATION_FAILED',
  HYDRATION_FAILED: 'ERR_PERSISTENCE_HYDRATION_FAILED',
  PROTOTYPE_POLLUTION_DETECTED: 'ERR_PERSISTENCE_PROTOTYPE_POLLUTION'
});

/**
 * Union type representing valid persistence error code strings.
 */
export type PersistenceErrorCode = typeof PERSISTENCE_ERROR_CODES[keyof typeof PERSISTENCE_ERROR_CODES];

// ============================================================================
// Environment & Options Interfaces
// ============================================================================

/**
 * Execution environment container passed to serialization and restoration functions.
 * Encapsulates live domain subsystem instances (Runtime, VFS, MessagingBus, WorldClock).
 */
export interface PersistenceEnvironmentObject {
  /** The primary agent runtime coordinator managing agents, timers, and execution turns. */
  readonly runtime: AgentRuntime;
  /** Shared virtual filesystem instance. If omitted or `null`, extracted from `runtime.virtualFs`. */
  readonly virtualFs?: VirtualFS | null;
  /** Shared messaging bus instance. If omitted or `null`, extracted from `runtime.messagingBus`. */
  readonly messagingBus?: MessagingBus | null;
  /** Shared world clock simulation instance. If omitted or `null`, extracted from `runtime.worldClock`. */
  readonly worldClock?: WorldClock | null;
}

/**
 * Polymorphic persistence environment parameter accepting either an `AgentRuntime`
 * directly or an explicit `PersistenceEnvironmentObject` bag.
 *
 * @example
 * ```typescript
 * import { serializeRuntimeEnvironment } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * // Direct runtime passing:
 * const snap1 = serializeRuntimeEnvironment(runtime);
 *
 * // Container object passing:
 * const snap2 = serializeRuntimeEnvironment({ runtime, virtualFs, messagingBus });
 * ```
 */
export type PersistenceEnvironment = AgentRuntime | PersistenceEnvironmentObject;

/**
 * Structural shape of one MOD-20 custom preset entry carried by the persisted
 * snapshot. Deliberately type-local: persistence never imports the
 * `presetCatalog` module (the catalog owns preset semantics), so the shape is
 * declared here as plain data. Structural validation (`validateSandboxState`)
 * additionally requires non-empty string `providerId`/`modelId` inside
 * `modelConfig`.
 */
export interface PersistedModelPreset {
  /** Catalog key: a `preset_custom_*` id (or any catalog entry id carried by a foreign snapshot). */
  readonly id: string;
  /** Display name shown by catalog consumers. */
  readonly name: string;
  /** `true` for user-authored entries, `false` for official seed entries. */
  readonly isCustom: boolean;
  /** Credential-free model configuration (providerId/modelId plus tuning). */
  readonly modelConfig: Record<string, unknown>;
}

/**
 * Structural shape of one Realm launch-provenance entry carried by the
 * persisted snapshot (Wave T, ticket 0df20ae). Deliberately type-local:
 * persistence never imports the `realmRegistry` module (the registry owns realm
 * semantics), so the shape is declared here as plain data. Validation keeps
 * only the canonical fields and treats a malformed provenance as an absent
 * one — a corrupt provenance block never costs the Realm record itself.
 * Records carry hashes/paths only, never raw input values or secrets. The
 * nested collections are `readonly` exactly like the frozen registry shape
 * (`realmRegistry.RealmInstanceProvenance`) so a registry record assigns to
 * this type structurally without persistence importing the registry module.
 */
export interface PersistedRealmInstanceProvenance {
  /** Template id the Realm was launched from. */
  readonly templateId: string;
  /** Effective template bundle content version (`sha256:<hex>`) at launch. */
  readonly templateVersion: string;
  /** Optional content hash of the canonical hydration-package serialization. */
  readonly packageDigest?: string;
  /** Per-input content hashes keyed by declared input id (hashes only). */
  readonly inputHashes: Readonly<Record<string, string>>;
  /** Template-seed destination paths written at launch, in write order. */
  readonly seedPaths: readonly string[];
  /** ISO-8601 launch timestamp. */
  readonly launchedAt: string;
  /** Reserved for Wave P: resolved capability id → provider binding. */
  readonly resolvedTools?: Readonly<Record<string, string>>;
}

/**
 * Structural shape of one Realm-record entry carried by the persisted
 * snapshot. Deliberately type-local: persistence never imports the
 * `realmRegistry` module (the registry owns realm semantics), so the shape is
 * declared here as plain data. Serialization copies only the canonical fields,
 * so unknown fields on an ingested record are dropped at the persistence
 * boundary; structural validation (`validateSandboxState`) requires a non-empty
 * string `id`/`name` and a finite numeric `createdAt`, and drops optional
 * `description`/`color`/`templateId` fields that are not strings.
 */
export interface PersistedRealmRecord {
  /** Registry key: a `realm_*` id (or any registry entry id carried by a foreign snapshot). */
  readonly id: string;
  /** User-visible display name. */
  readonly name: string;
  /** Optional operator description. */
  readonly description?: string;
  /** Optional UI accent color; presentation-only. */
  readonly color?: string;
  /** Optional template id the Realm was launched from. */
  readonly templateId?: string;
  /** Optional launch provenance of a template-launched Realm (additive). */
  readonly instance?: PersistedRealmInstanceProvenance;
  /** Epoch milliseconds when the Realm record was created. */
  readonly createdAt: number;
}

/**
 * Structural shape of one persisted imported Realm-template bundle (Wave T,
 * ticket 0df20ae). The payload is the canonical transport JSON text
 * (`{ formatVersion, template, files }`) exactly as imported; the store
 * re-parses it on hydration. Additive optional snapshot data: absent on legacy
 * snapshots (which load byte-compatibly), structurally invalid entries are
 * dropped during validation, and the payload carries no credentials by
 * construction (template bundles never contain secrets).
 */
export interface PersistedImportedRealmTemplate {
  /** Template id the payload resolves under (equal to the parsed template id). */
  readonly id: string;
  /** Canonical transport JSON text of the imported bundle. */
  readonly payload: string;
}

/**
 * Structural shape of the additive Wave U publishing-authority grant lists
 * (ticket 2518510): canonical `(realmId, agentId)` identity keys per explicit
 * authority. Deliberately type-local: persistence never imports the runtime
 * (the runtime owns grant semantics). The store emits the field only when at
 * least one grant is active, so grant-free and legacy sessions keep their
 * persisted bytes unchanged; hydration re-applies grants exclusively through
 * the composition-root restore (unknown/recycled refs fail closed), and the
 * lists are never derived from template/config content.
 */
export interface PersistedMetaAuthorityGrants {
  /** Canonical identity keys holding `@template:authority`. */
  readonly template?: readonly string[];
  /** Canonical identity keys holding `@hydration:authority`. */
  readonly hydration?: readonly string[];
}

/**
 * Structural shape of the additive Wave U per-template authority-trust record
 * (ticket 2518510): template id → template agent key → previously approved
 * authority ids. Trust is operator intent, never authority by itself — it only
 * lets a later launch auto-approve the exact previously approved set; newly
 * declared authorities re-prompt, and grants are still applied (and persisted)
 * through the ordinary operator grant registry. Secret-free by construction.
 */
export type PersistedTemplateAuthorityTrust =
  Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/**
 * Transient UI and session metadata preserved across persistence boundaries.
 */
export interface SessionMetadata {
  /** Identifier of the currently selected active agent in the user interface. */
  readonly activeAgentId?: string | null;
  /**
   * Canonical `(realmId, agentId)` identity key of the currently selected
   * active agent (defect 7d2c314). Additive optional field: absent on legacy
   * snapshots, where hydration falls back to `activeAgentId`'s unique-match
   * resolution; a realm-local agent whose literal id equals another scope's id
   * is restored realm-exactly through this field.
   */
  readonly activeAgentKey?: string | null;
  /** Identifier of the currently selected virtual filesystem workspace partition. */
  readonly activeFsWorkspace?: string;
  /** Identifier of the currently active navigation tab (e.g., 'chat', 'fs', 'clock'). */
  readonly activeTab?: string;
  /** Map of uncommitted user draft inputs keyed by agent ID. */
  readonly agentDraftInputs?: Record<string, string>;
  /**
   * Active MOD-20 model-preset pointer captured from the composition root.
   * Additive optional field: absent on legacy snapshots, dropped when
   * structurally invalid, and never rewritten by hydration.
   */
  readonly activePresetId?: string;
  /**
   * User-authored MOD-20 custom preset entries captured from the catalog
   * projection. Additive optional field: official seed presets are never
   * persisted here, absent/invalid entries are dropped on validation, and old
   * snapshots load unchanged.
   */
  readonly customPresets?: readonly PersistedModelPreset[];
  /**
   * Realm registry records captured from the composition root's realm
   * registry. Additive optional field: absent on legacy snapshots,
   * absent/invalid entries are dropped on validation, and old snapshots load
   * unchanged with an empty registry.
   */
  readonly realms?: readonly PersistedRealmRecord[];
  /**
   * Runtime-imported Realm-template bundles captured from the composition
   * root's template registry (Wave T, ticket 0df20ae). Additive optional
   * field: absent while no import exists (legacy snapshots load byte-
   * compatibly), absent/invalid entries are dropped on validation, and the
   * store re-parses each payload and re-applies its own size caps on
   * hydration.
   */
  readonly importedRealmTemplates?: readonly PersistedImportedRealmTemplate[];
}

/**
 * Diagnostic payload describing a quarantined, unreadable persisted snapshot.
 * Delivered to `StorageOptions.onRecovery` when recovery kicks in.
 */
export interface SandboxStateRecoveryInfo {
  /** Why the persisted entry could not be used. */
  readonly reason: 'unparseable' | 'invalid-schema';
  /** Parser or validation error detail, when available. */
  readonly detail: string | null;
  /** Canonical LocalStorage key that was quarantined. */
  readonly key: string;
  /** Timestamped backup key the corrupt blob was moved to, or `null` on plain removal. */
  readonly quarantinedKey: string | null;
}

/**
 * Configuration options for storage operations (save, load, clear, has).
 */
export interface StorageOptions {
  /** Override default LocalStorage key (`SANDBOX_STATE_STORAGE_KEY`). */
  readonly storageKey?: string;
  /**
   * Optional recovery callback invoked when `loadSandboxState` detects an
   * unreadable persisted entry. The entry is quarantined/cleared before the
   * callback fires so callers can surface a dismissible recovery notice.
   */
  readonly onRecovery?: (info: SandboxStateRecoveryInfo) => void;
}

// ============================================================================
// Result Interfaces
// ============================================================================

/**
 * Result returned by `validateSandboxState`.
 */
export interface ValidationResult {
  /** Whether the state is structurally valid and passes all security checks. */
  readonly valid: boolean;
  /** Human-readable failure description if validation fails. */
  readonly error?: string;
  /** Standardized error code if validation fails. */
  readonly code?: PersistenceErrorCode;
  /** Validated snapshot payload (the input object reference, unmodified) when `valid` is true. */
  readonly state?: SandboxPersistedState;
}

/**
 * Restored session metadata extracted from the persisted snapshot.
 * Provided to Layer 3 UI stores to bind reactive state without procedural coupling.
 */
export interface RestoredMetadata {
  /** Schema version string of the restored snapshot. */
  readonly version: string;
  /** Epoch timestamp (ms) when the snapshot was originally serialized. */
  readonly timestamp: number;
  /** ID of the active agent selected prior to serialization. */
  readonly activeAgentId: string | null;
  /**
   * Canonical `(realmId, agentId)` identity key of the selected agent
   * (defect 7d2c314), or `null` on legacy snapshots without the additive
   * field.
   */
  readonly activeAgentKey: string | null;
  /** Active virtual filesystem workspace partition identifier. */
  readonly activeFsWorkspace: string;
  /** Active UI tab identifier. */
  readonly activeTab: string;
  /** Preserved uncommitted draft input map keyed by agent ID. */
  readonly agentDraftInputs: Record<string, string>;
  /** Total count of active agents restored in state IDLE. */
  readonly activeAgentCount: number;
  /** Total count of recycled agents restored in state RECYCLED. */
  readonly recycledAgentCount: number;
}

/**
 * Structured receipt captured from a subsystem snapshot import during
 * `restoreRuntimeEnvironment`. Subsystems that return no receipt are treated
 * as accepting their snapshot (`success: true`).
 */
export interface SubsystemImportReceipt {
  /** Subsystem that was hydrated, in topological order. */
  readonly subsystem: 'virtualFs' | 'worldClock' | 'messagingBus';
  /** False when the subsystem explicitly rejected its snapshot. */
  readonly success: boolean;
  /** Human-readable rejection reason when `success` is false. */
  readonly error?: string;
  /** Subsystem machine-readable rejection code (e.g. `'CORRUPTED_SNAPSHOT'`). */
  readonly code?: string;
  /** Per-entry validation problems reported by the rejecting subsystem. */
  readonly details?: readonly string[];
}

/**
 * Structured result returned by `restoreRuntimeEnvironment`.
 *
 * `success: false` with code `HYDRATION_FAILED` is returned both when a
 * critical subsystem explicitly rejects its snapshot (partial/degraded
 * hydration: the remaining stages still ran) and when the hydration throws.
 * In the partial case `details`, `receipts`, and `metadata` describe what ran.
 */
export interface RestoreResult {
  /** True if all subsystems were successfully hydrated in topological order; false otherwise, including partial rejections. */
  readonly success: boolean;
  /** Human-readable error message if restoration fails. */
  readonly error?: string;
  /** Standardized error code if restoration fails. */
  readonly code?: PersistenceErrorCode;
  /**
   * Flattened per-entry hydration problems from every rejecting subsystem
   * receipt (e.g. the WorldClock `CORRUPTED_SNAPSHOT` malformed-entry list).
   */
  readonly details?: readonly string[];
  /**
   * Subsystem import receipts captured in topological order. Present on clean
   * success and on partial rejection, so a discarded receipt is impossible.
   */
  readonly receipts?: readonly SubsystemImportReceipt[];
  /**
   * Restored session metadata for the snapshot body that was hydrated; present
   * whenever the hydration stages ran, including partial/degraded failures.
   */
  readonly metadata?: RestoredMetadata;
}

// ============================================================================
// Persisted State Domain Models (The Stored JSON Contract)
// ============================================================================

/**
 * Sanitized model configuration stripped of credentials and secrets, including
 * the retired legacy `providerUrl` channels. Model-config `url` endpoint
 * references are retained: endpoint routing belongs to the model configuration.
 */
export interface SanitizedModelConfig {
  /** Model provider identifier (e.g., 'nano-gpt', 'deepseek', 'runware'). */
  readonly providerId?: string;
  /** Model identifier string (e.g., 'deepseek-chat', 'gpt-4o'). */
  readonly modelId?: string;
  /** Sampling temperature (0.0 - 2.0). */
  readonly temperature?: number;
  /** Reasoning effort tier ('low' | 'medium' | 'high'). */
  readonly reasoningEffort?: string;
  /** Public key identifier reference (never contains the secret key itself). */
  readonly keyId?: string;
  /** Maximum generation tokens. */
  readonly maxTokens?: number;
  /** Additional non-sensitive model parameters. */
  [key: string]: unknown;
}

/**
 * Sanitized agent launch configuration stripped of credentials and API keys.
 */
export interface SanitizedAgentConfig {
  /** Unique string identifier for the agent. */
  readonly id: string;
  /** Display name of the agent. */
  readonly name?: string;
  /** Persona or domain role. */
  readonly role?: string;
  /** System prompt persona and behavioral instructions. */
  readonly systemPrompt?: string;
  /**
   * Whitelist of permitted tool names, carried as serialized data only.
   * Hydration withholds it from the live entity config — authority is
   * re-derived default-deny and only a trusted operator grant re-populates the
   * capability surface (MOD-21 W8).
   */
  readonly allowedTools?: string[];
  /**
   * Whether the agent possesses administrative / privileged capabilities.
   * @deprecated Legacy boolean never emitted by serialization (MOD-21 W5 stripped
   * it from persisted config) and ignored on restore; present only on legacy or
   * hostile snapshots, where a `true` claim downgrades and a non-boolean claim
   * fails hydration closed.
   */
  readonly privileged?: boolean;
  /** Sanitized model configuration. */
  readonly modelConfig?: SanitizedModelConfig;
  /**
   * Bound catalog preset id (MOD-20 live preset binding), persisted as plain
   * data alongside the model-config cache. Hydration heals a missing or stale id
   * to the catalog default in memory; serialization never rewrites persisted
   * values and legacy snapshots without the field load unchanged.
   */
  readonly presetId?: string;
  /** Additional non-sensitive configuration properties. */
  [key: string]: unknown;
}

/**
 * Token usage, execution counters, and context telemetry metrics snapshot for an agent.
 */
export interface AgentTelemetrySnapshot {
  /** Cumulative prompt tokens consumed by this agent. */
  readonly inputTokens: number;
  /** Cumulative completion tokens generated by this agent. */
  readonly outputTokens: number;
  /** Total cumulative tokens consumed. */
  readonly totalTokens: number;
  /** Total conversation turns executed. */
  readonly turnCount: number;
  /** Prompt tokens in the most recent turn. */
  readonly lastPromptTokens: number;
  /** Completion tokens generated in the most recent turn. */
  readonly lastCompletionTokens: number;
  /** Count of terminal turn stops. */
  readonly terminalStops: number;
  /** Count of context injections delivered. */
  readonly injectedDeliveries: number;
  /** Count of tool precall invocations. */
  readonly precallCount: number;
  /** Serialized snapshot of the last sent context payload. */
  readonly lastSentContext: unknown[];
}

/**
 * Conversational message snapshot with a guaranteed stable identifier.
 * Every message possesses a unique, stable string ID.
 */
export interface HistoryMessageSnapshot {
  /**
   * Unique, stable message identifier, always non-empty in persisted snapshots;
   * missing identifiers are backfilled during serialization (UUID-based when
   * `crypto.randomUUID` is available, otherwise a timestamp plus random suffix).
   */
  readonly id: string;
  /** Message author role. */
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  /** Text content string or structured multipart content array. */
  readonly content: string | unknown[];
  /** Array of tool call descriptors requested by assistant. */
  readonly tool_calls?: unknown[];
  /** Matching tool call ID for role 'tool'. */
  readonly tool_call_id?: string;
  /** Epoch timestamp (ms) when message was created. */
  readonly timestamp?: number;
  /** Additional metadata properties. */
  [key: string]: unknown;
}

/**
 * Serialized representation of an active agent runtime instance.
 *
 * Persisted projection of the entity-owned agent snapshot contract
 * (`Agent.toSnapshot()`, `runtime/agent`). Persistence replaces the copied
 * `config` with its credential-stripped form, backfills deterministic history
 * message ids, redacts `lastError`, and carries every other field — including
 * `state`, `stateDetail`, `lastInterruptedTurn`, `recycledAt`, and
 * `recycleReason` — verbatim from the entity snapshot.
 */
export interface SerializedAgent {
  /** Unique agent identifier. */
  readonly id: string;
  /** Display name of the agent. */
  readonly name: string;
  /**
   * Sanitized configuration stripped of secrets and caller-asserted authority
   * fields (MOD-21 W5): `privileged`/`isPrivileged`/`isAdmin` are never emitted,
   * so a persisted snapshot cannot grant privilege on restore. Capability
   * selectors (`allowedTools`/`tools`) are emitted as data only and are
   * withheld from the live config during hydration (MOD-21 W8).
   */
  readonly config: SanitizedAgentConfig;
  /** Lifecycle state captured by the entity snapshot; hydration normalizes active entries to IDLE. */
  readonly state?: AgentState;
  /** Human-readable detail for `state`; `null` when none was recorded. */
  readonly stateDetail?: string | null;
  /** Turn execution counter. */
  readonly turnCount: number;
  /** Cumulative token metrics and execution telemetry. */
  readonly telemetry: AgentTelemetrySnapshot;
  /** Epoch ms timestamp when agent was created. */
  readonly createdAt: number;
  /** Epoch ms timestamp of last agent state modification. */
  readonly updatedAt: number;
  /** Context summarization cache if generated; null otherwise. */
  readonly lastSummary: string | null;
  /** Redacted last-turn diagnostic error message, or `null` if healthy. */
  readonly lastError: string | null;
  /** Deep-copied interrupted-turn recovery record carried by the entity snapshot. */
  readonly lastInterruptedTurn?: InterruptedTurn | null;
  /** ISO string timestamp of the soft-kill; `null` while active. */
  readonly recycledAt?: string | null;
  /** Reason recorded for the soft-kill; `null` while active. */
  readonly recycleReason?: string | null;
  /** Serialized buffer of pending precalls awaiting execution. */
  readonly pendingPrecalls: unknown[];
  /**
   * Deep-cloned undo/redo stack carried verbatim from the entity snapshot
   * (`Agent.toSnapshot()` in `runtime/agent` types `redoStack` as `unknown[]`;
   * the live entity holds `TurnBundle[]`, INV-6). Entries are self-contained
   * turn bundles, never arrays of `HistoryMessageSnapshot`, and are not
   * shape-validated on load beyond being an array — hence the conservative
   * element type.
   */
  readonly redoStack: unknown[];
  /** Conversational message history whose entries all carry a stable non-empty id. */
  readonly history: HistoryMessageSnapshot[];
}

/**
 * Serialized representation of a recycled / terminated agent: the entity
 * snapshot contract with the recycle-bin timestamp and reason required.
 * Recycled agents are restored in state `RECYCLED` and terminated on `MessagingBus`.
 */
export interface SerializedRecycledAgent extends SerializedAgent {
  /** ISO 8601 timestamp string when the agent was recycled. */
  readonly recycledAt: string;
  /** Narrative reason or trigger for recycling. */
  readonly recycleReason: string;
}

/**
 * Serialized file record within a virtual filesystem workspace partition.
 * Mirrors the `FileRecord` projection emitted by `VirtualFS.exportSnapshot()`.
 */
export interface VirtualFsPersistedFile {
  /** Canonical normalized virtual path starting with a leading slash (e.g. '/lore/codex.json'). */
  readonly path: string;
  /** Workspace identifier where this file resides (e.g. 'global', 'agent_writer'). */
  readonly workspaceId: string;
  /** UTF-8 text content or serialized file payload. */
  readonly content: string;
  /** File size in bytes. */
  readonly size: number;
  /** Epoch ms last write timestamp. */
  readonly updatedAt: number;
  /** Whether the file is write-protected. */
  readonly readOnly: boolean;
  /** Identifier of the agent or system entity that owns this file. */
  readonly owner: string;
}

/**
 * Serialized state of the MessagingBus including audit trail, mailboxes, and agent routing policies.
 * Mirrors the shapes emitted by `MessagingBus.exportSnapshot()`.
 */
export interface SerializedMessagingBus {
  /** Complete chronological audit log of all envelopes routed through the bus. */
  readonly auditLog: MessageEnvelope[];
  /** Map of agent ID to unconsumed envelope queues, oldest first. */
  readonly activeQueues: Record<string, MessageEnvelope[]>;
  /** Map of agent ID to consumed envelopes (`read: true`), in append order. */
  readonly archives: Record<string, MessageEnvelope[]>;
  /** Legacy alias emitted for `activeQueues`; `importSnapshot` partitions by `read` when `activeQueues` is absent. */
  readonly inboxes?: Record<string, MessageEnvelope[]>;
  /** Map of registered agent mailbox routing policies; `mode` is always `'queued'` and trust is never persisted (MOD-21 W4). */
  readonly registeredAgents: Record<string, { mode: 'queued' }>;
  /** Agent IDs currently marked as terminated. */
  readonly terminatedAgents: string[];
}

/**
 * Serialized representation of a scheduled one-shot alarm.
 *
 * Alias of the canonical scheduler record `SerializedScheduledTimer`
 * (`runtime/runtimeScheduler`) emitted by `AgentRuntime.exportSchedules()` and
 * accepted by `importSchedules()`. The canonical one-shot-only contract owns
 * the member shape.
 */
export type { SerializedScheduledTimer };

/**
 * Serialized state of the WorldClock simulation and narrative events.
 * Mirrors the `WorldClockSnapshot` emitted by `WorldClock.exportSnapshot()`.
 */
export interface SerializedWorldClock {
  /** Total elapsed simulation seconds on the primary / global timeline. */
  readonly totalSeconds: number;
  /** Primary narrative date string (e.g., 'Day 1'). */
  readonly date: string;
  /** Flat array of all registered world events across partitions. */
  readonly events: WorldEvent[];
  /** Map of partition IDs to partition clock snapshots. */
  readonly agentClocks?: Record<string, PartitionClockSnapshot>;
  /** Map of partition IDs to arrays of partitioned world events. */
  readonly agentEvents?: Record<string, WorldEvent[]>;
}

/**
 * Root canonical snapshot contract persisted to storage or exported to JSON.
 * Defines the complete, portable, leak-proof state of the sandbox environment.
 *
 * This is the storage contract, not the runtime's `RuntimeSnapshot`: it carries
 * neither `status` nor `exportedAt`. At runtime `AgentRuntime.importSnapshot`
 * accepts it by structural convention (it consumes `agents`, `recycleBin`, and
 * `scheduledTimers`), but the runtime parameter is statically typed
 * `RuntimeSnapshot`; a direct typed call `runtime.importSnapshot(persistedState)`
 * is therefore not assignable, and `restoreRuntimeEnvironment` is the supported
 * bridge across the persistence/runtime seam.
 *
 * @example
 * ```typescript
 * import { validateSandboxState, saveSandboxState } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const state: SandboxPersistedState = {
 *   version: '1.0.0',
 *   timestamp: Date.now(),
 *   activeAgentId: 'agent-1',
 *   activeFsWorkspace: 'workspace-default',
 *   activeTab: 'chat',
 *   agents: [],
 *   recycleBin: [],
 *   virtualFs: {},
 *   messagingBus: { auditLog: [], activeQueues: {}, archives: {}, inboxes: {}, registeredAgents: {}, terminatedAgents: [] },
 *   scheduledTimers: [],
 *   worldClock: null,
 *   agentDraftInputs: {}
 * };
 *
 * if (validateSandboxState(state).valid) {
 *   saveSandboxState(state);
 * }
 * ```
 */
export interface SandboxPersistedState {
  /** Schema version string (e.g., '1.0.0'). */
  readonly version: string;
  /** Epoch ms timestamp when snapshot was captured. */
  readonly timestamp: number;
  /** ID of active agent in UI; null if none selected. */
  readonly activeAgentId: string | null;
  /**
   * Canonical `(realmId, agentId)` identity key of the selected agent
   * (additive optional field, defect 7d2c314). Absent on legacy snapshots;
   * an invalid (non-string) value is dropped during validation so an
   * otherwise valid snapshot still loads.
   */
  readonly activeAgentKey?: string | null;
  /** Active virtual filesystem workspace identifier. */
  readonly activeFsWorkspace: string;
  /** Active UI navigation tab identifier. */
  readonly activeTab: string;
  /** Active agent instances serialized through the entity snapshot contract; restore normalizes them to state IDLE. */
  readonly agents: SerializedAgent[];
  /** Terminated / recycled agents serialized in state RECYCLED. */
  readonly recycleBin: SerializedRecycledAgent[];
  /** Workspace file trees keyed by workspaceId -\> filePath -\> fileRecord. */
  readonly virtualFs: Record<string, Record<string, VirtualFsPersistedFile>>;
  /** Messaging bus audit logs, inboxes, and registrations. */
  readonly messagingBus: SerializedMessagingBus;
  /** Scheduled one-shot timers. */
  readonly scheduledTimers: SerializedScheduledTimer[];
  /** World clock simulation time and narrative events. */
  readonly worldClock: SerializedWorldClock | null;
  /** Uncommitted user draft inputs per agent ID. */
  readonly agentDraftInputs: Record<string, string>;
  /**
   * Active MOD-20 model-preset pointer (additive optional field). Absent on
   * legacy snapshots; invalid values are dropped during validation so an
   * otherwise valid snapshot still loads.
   */
  readonly activePresetId?: string;
  /**
   * User-authored MOD-20 custom preset entries (additive optional field).
   * Official seed presets are never stored here; absent or invalid entries are
   * dropped during validation so legacy snapshots load byte-compatibly.
   */
  readonly customPresets?: PersistedModelPreset[];
  /**
   * Realm registry records (additive optional field). Absent on legacy
   * snapshots; invalid entries are dropped during validation so an otherwise
   * valid snapshot still loads with the remaining records.
   */
  readonly realms?: PersistedRealmRecord[];
  /**
   * Runtime-imported Realm-template bundles (additive optional field, Wave T
   * ticket 0df20ae). Absent while no import exists so legacy snapshots stay
   * byte-identical; invalid entries are dropped during validation.
   */
  readonly importedRealmTemplates?: PersistedImportedRealmTemplate[];
  /**
   * Persisted Wave U publishing-authority grant lists (additive optional
   * field, ticket 2518510): canonical identity keys per explicit authority.
   * Absent while no grant exists (legacy snapshots stay byte-identical);
   * malformed values fail validation closed, and hydration never derives
   * authority from this field — it re-applies grants through the
   * composition-root restore only (unknown/recycled refs skipped).
   */
  readonly metaAuthorityGrants?: PersistedMetaAuthorityGrants;
  /**
   * Persisted Wave U per-template authority trust (additive optional field,
   * ticket 2518510): template id → agent key → previously approved authority
   * ids. Absent while no trust is recorded; malformed values fail validation
   * closed; trust never grants anything directly (it only auto-approves exact
   * matches at a later launch).
   */
  readonly templateAuthorityTrust?: PersistedTemplateAuthorityTrust;
}

// ============================================================================
// Auto-Save Coordinator Interface
// ============================================================================

/**
 * Configuration options for `createDebouncedSave`.
 */
export interface DebouncedSaveOptions {
  /** Custom save implementation. Defaults to `saveSandboxState`. */
  readonly saveFn?: (state: SandboxPersistedState) => boolean | Promise<boolean>;
  /** Debounce coalescing delay in milliseconds (default: 300ms). */
  readonly delayMs?: number;
  /** Whether to bind to browser unload lifecycle events (`beforeunload`, `pagehide`) (default: true). */
  readonly bindWindowEvents?: boolean;
}

/**
 * Burst-coalescing persistence coordinator returned by `createDebouncedSave`.
 * Manages auto-save timers, lazy state evaluation, synchronous flush, and unload hooks.
 *
 * @example
 * ```typescript
 * import { createDebouncedSave, serializeRuntimeEnvironment } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const autoSaver = createDebouncedSave({
 *   delayMs: 500,
 *   saveFn: async (state) => {
 *     return await saveSandboxStateLocked(state);
 *   }
 * });
 *
 * // Schedule lazy save on mutation:
 * autoSaver.schedule(() => serializeRuntimeEnvironment(runtime));
 *
 * // Synchronous flush on demand:
 * autoSaver.flushSync();
 * ```
 */
export interface DebouncedSaveCoordinator {
  /**
   * Schedule a debounced save with a precomputed snapshot or a lazy supplier function.
   * If a save is already pending, resets the debounce timer.
   *
   * @param stateSupplier - State snapshot object or zero-argument supplier function returning snapshot.
   */
  schedule: (stateSupplier: SandboxPersistedState | (() => SandboxPersistedState | null)) => void;

  /**
   * Synchronously flushes any pending save to storage immediately.
   *
   * A `saveFn` that returns a `Promise` is invoked but not awaited, so its
   * eventual resolution cannot affect this return value.
   *
   * @returns True when no save was pending, the supplier yielded no state, or
   * `saveFn` returned a value other than `false`; false when the supplier or
   * `saveFn` throws or `saveFn` returns `false`.
   */
  flush: () => boolean;

  /**
   * Synchronous alias for `flush()`.
   *
   * @returns True if executed successfully; false on failure.
   */
  flushSync: () => boolean;

  /**
   * Cancels any pending debounced save without writing to storage.
   */
  cancel: () => void;

  /**
   * Returns true if an auto-save is currently scheduled and pending execution.
   *
   * @returns True if timer is active; false otherwise.
   */
  isPending: () => boolean;

  /**
   * Unbinds window lifecycle listeners, cancels pending timers, and destroys the coordinator.
   */
  destroy: () => void;
}

/**
 * Duck-typed subsystem surface reached through the polymorphic environment bag
 * and the runtime persistence port. Persistence never imports subsystem
 * implementations; snapshot results are asserted to the persisted contract at
 * the boundary, mirroring the previous duck-typed access.
 */
type PersistedSubsystem = {
  exportSnapshot?(): unknown;
  importSnapshot?(snapshot: unknown): unknown;
  syncFromVirtualFs?(): unknown;
};

/**
 * Mutable view of a readonly contract shape, used while building copied
 * sanitized records before they are handed back through the readonly surface.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ============================================================================
// Internal Private Helper Functions
// ============================================================================

const CREDENTIAL_PROPERTIES_TO_STRIP = new Set([
  'apiKey',
  'api_key',
  'encryptionKey',
  'encryption_key',
  // Retired legacy secret-named channels (legacy snapshots may still carry them)
  'providerApiKey',
  'provider_api_key',
  'providerApiKeys',
  'provider_api_keys',
  'providerEncryptionKey',
  'provider_encryption_key',
  'providerEncryptionKeys',
  'provider_encryption_keys',
  'runwareApiKey',
  'runware_api_key',
  'providerVendor',
  'providerUrl',
  'provider_url',
  'secret',
  'secretKey',
  'secret_key',
  'kek',
  'accessKey',
  'access_key',
  'token',
  'authHeader',
  'authorization',
  'password',
  'clientSecret',
  'client_secret'
]);

/**
 * Caller-asserted authority fields (MOD-21 W5) stripped from persisted agent
 * configuration. Authority is derived state: snapshots never carry trust, and
 * restore re-derives it through `Agent.fromSnapshot` (tampered claims downgrade,
 * schema-invalid claims fail closed). The entity performs the authoritative
 * drop; this set is the persistence-layer defense-in-depth copy.
 */
const AUTHORITY_TRUST_PROPERTIES_TO_STRIP = new Set([
  'privileged',
  'isPrivileged',
  'isAdmin'
]);

/**
 * Credential-shaped keys stripped from persisted custom presets. Presets carry
 * no credential reference at all (MOD-20 INV-NO-KEYID), so unlike agent configs
 * the public `keyId` reference is dropped here alongside the secret material.
 */
const PRESET_CREDENTIAL_PROPERTIES_TO_STRIP = new Set([
  ...CREDENTIAL_PROPERTIES_TO_STRIP,
  'keyId'
]);

/**
 * Checks if an object contains dangerous prototype pollution keys.
 *
 * @param obj - Candidate object.
 * @param seen - Cycle guard set shared across the recursion.
 * @returns True when a dangerous own key is present.
 */
function hasPrototypePollutionKey(obj: unknown, seen: Set<object> = new Set()): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (seen.has(obj)) return false;
  seen.add(obj);

  if (
    Object.prototype.hasOwnProperty.call(obj, '__proto__') ||
    Object.prototype.hasOwnProperty.call(obj, 'constructor') ||
    Object.prototype.hasOwnProperty.call(obj, 'prototype')
  ) {
    return true;
  }
  const propNames = Object.getOwnPropertyNames(obj);
  for (let i = 0; i < propNames.length; i++) {
    const key = propNames[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
  }
  return false;
}

/**
 * Recursively inspects all keys in an object tree for prototype pollution.
 *
 * @param obj - Candidate object tree.
 * @param seen - Cycle guard set shared across the recursion.
 * @returns True when any nested own key is dangerous.
 */
function deepHasPrototypePollution(obj: unknown, seen: Set<object> = new Set()): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (seen.has(obj)) return false;
  seen.add(obj);

  if (hasPrototypePollutionKey(obj)) return true;

  if (Array.isArray(obj)) {
    const values: unknown[] = obj;
    for (let i = 0; i < values.length; i++) {
      if (deepHasPrototypePollution(values[i], seen)) return true;
    }
  } else {
    const record = obj as Record<string, unknown>;
    const propNames = Object.getOwnPropertyNames(record);
    for (let i = 0; i < propNames.length; i++) {
      const key = propNames[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return true;
      }
      const val = record[key];
      if (val && typeof val === 'object') {
        if (deepHasPrototypePollution(val, seen)) return true;
      }
    }
  }

  return false;
}

/**
 * Structural check for one persisted MOD-20 custom preset entry: a non-empty
 * string `id`/`name`, a boolean `isCustom`, and an object `modelConfig` with
 * non-empty string `providerId`/`modelId`.
 *
 * @param value - Candidate preset entry.
 * @returns True when the entry round-trips as a catalog-shaped preset.
 */
function isPersistedModelPreset(value: unknown): value is PersistedModelPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const preset = value as Record<string, unknown>;
  if (typeof preset.id !== 'string' || !preset.id.trim()) return false;
  if (typeof preset.name !== 'string' || !preset.name.trim()) return false;
  if (typeof preset.isCustom !== 'boolean') return false;
  const modelConfig = preset.modelConfig;
  if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) return false;
  const config = modelConfig as Record<string, unknown>;
  if (typeof config.providerId !== 'string' || !config.providerId.trim()) return false;
  if (typeof config.modelId !== 'string' || !config.modelId.trim()) return false;
  return true;
}

/**
 * Normalizes the additive MOD-20 preset fields of an already structurally
 * valid snapshot. A valid value is kept verbatim; an absent, null, or invalid
 * value is dropped (`customPresets` filters invalid entries individually).
 * Returns the input reference when no field needs dropping, so clean legacy
 * snapshots keep their exact identity.
 *
 * @param candidate - Structurally valid snapshot record.
 * @returns The input reference, or a shallow copy with invalid preset fields dropped.
 */
function normalizePresetSnapshotFields(candidate: Record<string, unknown>): Record<string, unknown> {
  const hasActivePresetId = candidate.activePresetId !== undefined && candidate.activePresetId !== null;
  const activePresetIdValid = !hasActivePresetId
    || (typeof candidate.activePresetId === 'string' && candidate.activePresetId.trim().length > 0);

  const hasCustomPresets = candidate.customPresets !== undefined && candidate.customPresets !== null;
  const customPresetsValid = !hasCustomPresets
    || (Array.isArray(candidate.customPresets) && candidate.customPresets.every(isPersistedModelPreset));

  if (activePresetIdValid && customPresetsValid) return candidate;

  const normalized: Record<string, unknown> = { ...candidate };
  if (!activePresetIdValid) {
    delete normalized.activePresetId;
  }
  if (!customPresetsValid) {
    if (Array.isArray(candidate.customPresets)) {
      normalized.customPresets = candidate.customPresets.filter(isPersistedModelPreset);
    } else {
      delete normalized.customPresets;
    }
  }
  return normalized;
}

/**
 * Copies one custom preset entry into its persisted form: identifier fields
 * verbatim plus a fresh `modelConfig` copy with the credential-shaped keys
 * stripped (the catalog already guarantees credential-free entries; this is
 * the persistence-layer zero-leak defense-in-depth copy).
 *
 * @param preset - Structurally valid custom preset entry.
 * @returns Plain JSON-serializable snapshot record.
 */
function serializePresetRecord(preset: PersistedModelPreset): PersistedModelPreset {
  const modelConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(preset.modelConfig)) {
    if (PRESET_CREDENTIAL_PROPERTIES_TO_STRIP.has(key)) continue;
    modelConfig[key] = value;
  }
  return {
    id: preset.id,
    name: preset.name,
    isCustom: preset.isCustom,
    modelConfig
  };
}

/**
 * Structural check for one persisted Realm-record entry: a non-empty string
 * `id`/`name`, a finite numeric `createdAt`, and optional
 * `description`/`color`/`templateId` fields that are strings when present.
 *
 * @param value - Candidate realm entry.
 * @returns True when the entry round-trips as a registry-shaped realm record.
 */
function isPersistedRealmRecord(value: unknown): value is PersistedRealmRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const realm = value as Record<string, unknown>;
  if (typeof realm.id !== 'string' || !realm.id.trim()) return false;
  if (typeof realm.name !== 'string' || !realm.name.trim()) return false;
  if (typeof realm.createdAt !== 'number' || !Number.isFinite(realm.createdAt)) return false;
  for (const field of ['description', 'color', 'templateId']) {
    if (realm[field] !== undefined && typeof realm[field] !== 'string') return false;
  }
  return true;
}

/**
 * Structural check for one persisted Realm launch-provenance entry
 * (Wave T, ticket 0df20ae): non-empty string `templateId`/`templateVersion`/
 * `launchedAt`, a string-valued `inputHashes` record, a string `seedPaths`
 * array, and optional non-empty string `packageDigest` / string-valued
 * `resolvedTools`.
 *
 * @param value - Candidate provenance entry.
 * @returns True when the entry round-trips as a provenance record.
 */
function isPersistedRealmInstanceProvenance(value: unknown): value is PersistedRealmInstanceProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const instance = value as Record<string, unknown>;
  for (const field of ['templateId', 'templateVersion', 'launchedAt']) {
    if (typeof instance[field] !== 'string' || !(instance[field] as string).trim()) return false;
  }
  const inputHashes = instance.inputHashes;
  if (!inputHashes || typeof inputHashes !== 'object' || Array.isArray(inputHashes)) return false;
  if (Object.values(inputHashes).some((hash) => typeof hash !== 'string')) return false;
  if (!Array.isArray(instance.seedPaths) || instance.seedPaths.some((path) => typeof path !== 'string')) return false;
  if (instance.packageDigest !== undefined
    && (typeof instance.packageDigest !== 'string' || !instance.packageDigest.trim())) return false;
  const resolvedTools = instance.resolvedTools;
  if (resolvedTools !== undefined) {
    if (!resolvedTools || typeof resolvedTools !== 'object' || Array.isArray(resolvedTools)) return false;
    if (Object.values(resolvedTools).some((binding) => typeof binding !== 'string')) return false;
  }
  return true;
}

/**
 * Copies one provenance entry into its persisted form: canonical fields only,
 * nested maps/arrays fresh, so a registry reference is never aliased.
 *
 * @param instance - Valid provenance entry.
 * @returns Plain JSON-serializable provenance record.
 */
function serializeRealmInstance(
  instance: PersistedRealmInstanceProvenance
): PersistedRealmInstanceProvenance {
  return {
    templateId: instance.templateId,
    templateVersion: instance.templateVersion,
    ...(instance.packageDigest !== undefined ? { packageDigest: instance.packageDigest } : {}),
    inputHashes: { ...instance.inputHashes },
    seedPaths: [...instance.seedPaths],
    launchedAt: instance.launchedAt,
    ...(instance.resolvedTools !== undefined ? { resolvedTools: { ...instance.resolvedTools } } : {})
  };
}

/**
 * Normalizes the additive realm-registry field of an already structurally
 * valid snapshot. Invalid realm entries are dropped individually and a
 * malformed `instance` provenance block is dropped while its Realm record
 * survives (provenance is descriptive metadata, never identity). An absent or
 * `null` value is preserved verbatim because consumers gate on `Array.isArray`,
 * while a defined non-array value has the field dropped. Returns the input
 * reference when no field needs dropping, so clean legacy snapshots keep their
 * exact identity.
 *
 * @param candidate - Structurally valid snapshot record.
 * @returns The input reference, or a shallow copy with invalid realm fields dropped.
 */
function normalizeRealmSnapshotFields(candidate: Record<string, unknown>): Record<string, unknown> {
  const hasRealms = candidate.realms !== undefined && candidate.realms !== null;
  if (!hasRealms) return candidate;
  if (!Array.isArray(candidate.realms)) {
    const normalized: Record<string, unknown> = { ...candidate };
    delete normalized.realms;
    return normalized;
  }

  let changed = false;
  const realms: unknown[] = [];
  for (const entry of candidate.realms) {
    if (!isPersistedRealmRecord(entry)) {
      changed = true;
      continue;
    }
    if (entry.instance !== undefined && !isPersistedRealmInstanceProvenance(entry.instance)) {
      changed = true;
      const rest: Record<string, unknown> = { ...entry };
      delete rest.instance;
      realms.push(rest);
      continue;
    }
    realms.push(entry);
  }
  if (!changed) return candidate;
  return { ...candidate, realms };
}

/**
 * Structural check for one persisted imported Realm-template bundle entry
 * (Wave T, ticket 0df20ae): non-empty string `id` and a non-empty string
 * `payload` (the canonical transport JSON text).
 *
 * @param value - Candidate imported-template entry.
 * @returns True when the entry round-trips as an imported-template record.
 */
function isPersistedImportedRealmTemplate(value: unknown): value is PersistedImportedRealmTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id.trim()) return false;
  if (typeof entry.payload !== 'string' || !entry.payload.trim()) return false;
  return true;
}

/**
 * Normalizes the additive imported-template registry field of an already
 * structurally valid snapshot: invalid entries are dropped individually, an
 * absent or `null` value is preserved verbatim (consumers gate on
 * `Array.isArray`), and a defined non-array value has the field dropped.
 * Returns the input reference when no field needs dropping, so clean legacy
 * snapshots keep their exact identity.
 *
 * @param candidate - Structurally valid snapshot record.
 * @returns The input reference, or a shallow copy with invalid entries dropped.
 */
function normalizeImportedTemplateSnapshotFields(candidate: Record<string, unknown>): Record<string, unknown> {
  const hasImports = candidate.importedRealmTemplates !== undefined && candidate.importedRealmTemplates !== null;
  const importsValid = !hasImports
    || (Array.isArray(candidate.importedRealmTemplates)
      && candidate.importedRealmTemplates.every(isPersistedImportedRealmTemplate));

  if (importsValid) return candidate;

  const normalized: Record<string, unknown> = { ...candidate };
  if (Array.isArray(candidate.importedRealmTemplates)) {
    normalized.importedRealmTemplates = candidate.importedRealmTemplates.filter(isPersistedImportedRealmTemplate);
  } else {
    delete normalized.importedRealmTemplates;
  }
  return normalized;
}

/**
 * Copies one imported-template entry into its persisted form: identifier and
 * canonical payload verbatim.
 *
 * @param entry - Structurally valid imported-template entry.
 * @returns Plain JSON-serializable imported-template record.
 */
function serializeImportedRealmTemplate(
  entry: PersistedImportedRealmTemplate
): PersistedImportedRealmTemplate {
  return { id: entry.id, payload: entry.payload };
}

/**
 * Copies one Realm-record entry into its persisted form: only the canonical
 * registry fields are retained, in a fixed order, so unknown fields on an
 * ingested record never reach the serialized snapshot.
 *
 * @param realm - Structurally valid realm record.
 * @returns Plain JSON-serializable snapshot record.
 */
function serializeRealmRecord(realm: PersistedRealmRecord): PersistedRealmRecord {
  return {
    id: realm.id,
    name: realm.name,
    ...(realm.description !== undefined ? { description: realm.description } : {}),
    ...(realm.color !== undefined ? { color: realm.color } : {}),
    ...(realm.templateId !== undefined ? { templateId: realm.templateId } : {}),
    ...(realm.instance !== undefined ? { instance: serializeRealmInstance(realm.instance) } : {}),
    createdAt: realm.createdAt
  };
}

/**
 * Sanitizes agent configuration for persistence and hydration, ensuring
 * modelConfig fidelity, zero credential leakage, and zero persisted authority:
 * caller-asserted trust fields (`privileged`, `isPrivileged`, `isAdmin`) are
 * stripped recursively alongside legacy credential properties (MOD-21 W5).
 *
 * @param agent - Live Agent instance or raw persisted agent data
 * @returns Sanitized configuration object
 */
function sanitizeAgentConfigForPersistence(
  agent: { readonly id?: unknown; readonly config?: unknown; readonly modelConfig?: unknown } | null | undefined
): Mutable<SanitizedAgentConfig> {
  let config: Record<string, unknown> = { id: agent?.id };
  if (agent?.config && typeof agent.config === 'object') {
    try {
      config = (typeof structuredClone === 'function'
        ? structuredClone(agent.config)
        : JSON.parse(JSON.stringify(agent.config))) as Record<string, unknown>;
    } catch {
      const rawConfig = (agent.config && typeof agent.config === 'object' ? agent.config : null) as
        { readonly name?: unknown; readonly role?: unknown } | null;
      config = { id: agent.id, name: rawConfig?.name, role: rawConfig?.role };
    }
  }

  // Explicitly serialize agent.modelConfig into config.modelConfig
  const effectiveModelConfig = agent?.modelConfig || config.modelConfig;
  if (effectiveModelConfig && typeof effectiveModelConfig === 'object') {
    try {
      config.modelConfig = (typeof structuredClone === 'function'
        ? structuredClone(effectiveModelConfig)
        : JSON.parse(JSON.stringify(effectiveModelConfig))) as Record<string, unknown>;
    } catch {
      config.modelConfig = { ...(effectiveModelConfig as Record<string, unknown>) };
    }
  }

  // Zero Credential Leaks + Zero Persisted Authority (MOD-21 W5): strip legacy
  // credential properties and caller-asserted authority fields recursively.
  function stripPersistedPropertiesRecursively(obj: unknown, seen: Set<object> = new Set()): void {
    if (!obj || typeof obj !== 'object') return;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      const values: unknown[] = obj;
      for (let i = 0; i < values.length; i++) {
        if (values[i] && typeof values[i] === 'object') {
          stripPersistedPropertiesRecursively(values[i], seen);
        }
      }
    } else {
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (CREDENTIAL_PROPERTIES_TO_STRIP.has(key) || AUTHORITY_TRUST_PROPERTIES_TO_STRIP.has(key)) {
          delete record[key];
        } else if (record[key] && typeof record[key] === 'object') {
          stripPersistedPropertiesRecursively(record[key], seen);
        }
      }
    }
  }

  stripPersistedPropertiesRecursively(config);

  return config as Mutable<SanitizedAgentConfig>;
}

/**
 * Builds a persisted agent record from the entity-owned snapshot contract
 * (`Agent.toSnapshot()`), applying only the persistence-specific layers on top:
 * credential and authority trust-field stripping on the copied config,
 * deterministic history message ids, diagnostic redaction for `lastError`, and
 * recycle-bin timestamp/reason defaults. The entity snapshot carries `state`, `stateDetail`,
 * `lastInterruptedTurn`, `recycledAt`, and `recycleReason`, so persistence never
 * rebuilds the agent field map by hand.
 *
 * @param agent - Live `Agent` instance obtained from the runtime.
 * @param recycled - True when serializing a recycle-bin entry.
 * @returns Plain JSON-serializable persisted agent record.
 */
function serializeAgentSnapshot(agent: Agent, recycled: boolean): SerializedAgent {
  const snapshot: Record<string, unknown> = { ...agent.toSnapshot() };

  snapshot.config = sanitizeAgentConfigForPersistence(snapshot);
  snapshot.history = ensureHistoryMessageIds(
    Array.isArray(snapshot.history)
      ? snapshot.history as Array<HistoryMessage & { reasoning?: string; thought?: string }>
      : []
  );
  snapshot.lastError = sanitizeDiagnosticError(snapshot.lastError) || null;

  if (recycled) {
    snapshot.recycledAt = snapshot.recycledAt || new Date().toISOString();
    snapshot.recycleReason = snapshot.recycleReason || 'Terminated';
  }

  return snapshot as unknown as SerializedAgent;
}

/**
 * Normalizes a subsystem snapshot-import return value into a structured
 * receipt. Subsystems that return nothing are treated as accepting their
 * snapshot; an explicit `{ success: false }` receipt is preserved with its
 * error message, machine-readable code, and per-entry details.
 *
 * @param subsystem - Subsystem being hydrated.
 * @param receipt - Return value of the subsystem's `importSnapshot`/`syncFromVirtualFs`.
 * @returns Structured subsystem import receipt.
 */
function toSubsystemImportReceipt(
  subsystem: 'virtualFs' | 'worldClock' | 'messagingBus',
  receipt: unknown
): SubsystemImportReceipt {
  if (receipt && typeof receipt === 'object' && (receipt as { success?: unknown }).success === false) {
    const rejection = receipt as { error?: unknown; code?: unknown; details?: unknown };
    return {
      subsystem,
      success: false,
      error: (typeof rejection.error === 'string' && rejection.error) ? rejection.error : `${subsystem} rejected its snapshot`,
      code: typeof rejection.code === 'string' ? rejection.code : PERSISTENCE_ERROR_CODES.HYDRATION_FAILED,
      ...(Array.isArray(rejection.details) ? { details: rejection.details.map(String) } : {})
    };
  }
  return { subsystem, success: true };
}

/**
 * Redacts credential-shaped substrings from diagnostic error text and caps its
 * length so persisted snapshots never carry secrets or raw provider payloads.
 * Mirrored by the render-time redactor in `sandboxStore/index.svelte.ts`; keep both
 * implementations behaviorally identical.
 *
 * @param value - Error message or thrown value.
 * @param maxLength - Maximum retained characters.
 * @returns Sanitized single-line diagnostic string ('' when empty).
 */
function sanitizeDiagnosticError(value: unknown, maxLength = 320): string {
  if (value === null || value === undefined) return '';
  const candidate = value as { message?: unknown };
  let text = typeof value === 'string' ? value : String(candidate?.message || value);
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  text = text.replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  text = text.replace(/(authorization|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|password|token|bearer|kek)\s*[:=]\s*["']?[^\s"',;}\]]+/gi, '$1=[redacted]');
  text = text.replace(/\b(sk|gsk|xai|pk|api|key)[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]');
  text = text.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]');
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength).trimEnd()}…`;
  }
  return text;
}

/**
 * Reads a thrown value's `message` property with `message || fallback`
 * truthiness semantics, coercing a non-string truthy message to text.
 *
 * @param value - Thrown value to inspect.
 * @returns Message string when one is present, `null` otherwise.
 */
function extractThrownMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const message = (value as { message?: unknown }).message;
  if (!message) return null;
  return typeof message === 'string' ? message : String(message);
}

/**
 * Removes authority-bearing capability selectors (`allowedTools`/`tools`) from
 * a copied hydration entry. Authority is re-derived default-deny on restore
 * (MOD-21 W5/W8): a persisted whitelist is untrusted data and must never feed
 * the legacy tool gate, so the copied `config` handed to `Agent.fromSnapshot`
 * withholds it. Non-object entries and entries without a plain `config` are
 * returned unchanged. Never mutates the input.
 *
 * @param entry - Persisted agent entry.
 * @returns Entry copy without capability selectors in `config`.
 */
function withholdAuthoritySelectors(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const record = entry as { readonly config?: unknown };
  if (!record.config || typeof record.config !== 'object' || Array.isArray(record.config)) return entry;
  const copy = {
    ...(entry as Record<string, unknown>),
    config: { ...(record.config as Record<string, unknown>) }
  };
  delete copy.config.allowedTools;
  delete copy.config.tools;
  return copy;
}

/**
 * Canonicalizes the identity fields of an agent entry (`id` and, when
 * present, `config.id`) by trimming surrounding whitespace on the copies
 * handed to runtime hydration. The entity contract (`Agent.fromSnapshot`)
 * trims the id it adopts, so a padded reserved-id alias must never reach an
 * identity comparison upstream of the entity; canonicalizing here keeps the
 * persistence path self-guarding instead of depending on the runtime's own
 * canonicalization boundary (1398527/38a64ae). Structural validation already
 * guarantees `id` is a non-empty string after trimming, so this cannot turn a
 * hostile id into a silently dropped entry. Non-string ids pass through
 * unchanged. Never mutates the input.
 *
 * @param entry - Persisted agent entry.
 * @returns Entry copy with canonical identity fields.
 */
function canonicalizeHydrationEntryIds(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const copy: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  if (typeof copy.id === 'string') copy.id = copy.id.trim();
  if (copy.config && typeof copy.config === 'object' && !Array.isArray(copy.config)) {
    const configCopy: Record<string, unknown> = { ...(copy.config as Record<string, unknown>) };
    if (typeof configCopy.id === 'string') configCopy.id = configCopy.id.trim();
    copy.config = configCopy;
  }
  return copy;
}

/**
 * Normalizes a validated persisted snapshot against the entity snapshot
 * contract before runtime hydration. Active entries are reduced to
 * IDLE-restorable records (`state`, `stateDetail`, `recycledAt`, and
 * `recycleReason` stripped so `Agent.fromSnapshot` cannot honor a hostile
 * lifecycle claim), and entries that claim a recycled/terminated lifecycle or
 * carry a `recycledAt` timestamp are routed to the recycle bin, where the
 * runtime restores them terminated instead of registering them with an active
 * mailbox subscription. Authority-bearing capability selectors
 * (`allowedTools`/`tools`) are withheld from every entry's `config` copy so no
 * legacy gate can re-grant a persisted whitelist (MOD-21 W8, ticket 8042808).
 * Identity fields (`id`/`config.id`) are canonicalized (trimmed) on every
 * entry so padded reserved-id aliases cannot bypass engine-composed rebuilds
 * even when a consumer reads the snapshot outside the runtime's own
 * hydration boundary (1398527/38a64ae). Diagnostic `lastError` strings are
 * re-redacted on the copies handed to the entity contract.
 *
 * Returns a fresh snapshot object; the input is never mutated.
 *
 * @param persistedState - Validated SandboxPersistedState snapshot
 * @returns Normalized snapshot plus active/recycled entry counts.
 */
function normalizeSnapshotForHydration(persistedState: SandboxPersistedState): {
  snapshot: unknown;
  activeAgentCount: number;
  recycledAgentCount: number;
} {
  const activeEntries = Array.isArray(persistedState.agents) ? persistedState.agents : [];
  const recycledEntries = Array.isArray(persistedState.recycleBin) ? persistedState.recycleBin : [];

  const normalizedActive: unknown[] = [];
  const normalizedRecycled: unknown[] = [];

  for (const entry of recycledEntries) {
    normalizedRecycled.push(
      canonicalizeHydrationEntryIds(withholdAuthoritySelectors(normalizeAgentDiagnostics(entry)))
    );
  }

  for (const entry of activeEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      normalizedActive.push(entry);
      continue;
    }

    const claimsTerminalLifecycle =
      entry.state === 'recycled' ||
      entry.state === 'terminated' ||
      Boolean(entry.recycledAt);

    if (claimsTerminalLifecycle) {
      normalizedRecycled.push(
        canonicalizeHydrationEntryIds(withholdAuthoritySelectors(normalizeAgentDiagnostics(entry)))
      );
      continue;
    }

    const rest = canonicalizeHydrationEntryIds(withholdAuthoritySelectors(normalizeAgentDiagnostics(entry))) as Record<string, unknown>;
    delete rest.state;
    delete rest.stateDetail;
    delete rest.recycledAt;
    delete rest.recycleReason;
    normalizedActive.push(rest);
  }

  return {
    snapshot: {
      ...persistedState,
      agents: normalizedActive,
      recycleBin: normalizedRecycled
    },
    activeAgentCount: normalizedActive.length,
    recycledAgentCount: normalizedRecycled.length
  };
}

/**
 * Copies an agent entry and re-applies the persisted diagnostic redaction
 * policy to its `lastError` string. Non-string diagnostics normalize to `null`
 * (the entity contract restores string diagnostics only). Never mutates the
 * input entry.
 *
 * @param entry - Persisted agent entry.
 * @returns Shallow copy with a redacted `lastError`, or the input when it is not a plain object.
 */
function normalizeAgentDiagnostics(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;

  const copy: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  if (typeof copy.lastError === 'string' && copy.lastError) {
    copy.lastError = sanitizeDiagnosticError(copy.lastError) || null;
  } else if (copy.lastError !== null && copy.lastError !== undefined) {
    copy.lastError = null;
  }
  return copy;
}

// ============================================================================
// Public API Functions
// ============================================================================

/**
 * Validates the schema and structural integrity of a SandboxPersistedState object.
 * Enforces prototype pollution defenses across virtualFs, messagingBus, and agentDraftInputs.
 *
 * Validates that a raw object conforms to the `SandboxPersistedState` schema and
 * verifies prototype pollution immunity.
 *
 * Validation checks:
 * 1. Root shape is a non-null, non-array object.
 * 2. Deep prototype pollution scan of every own key (`__proto__`, `constructor`, `prototype`);
 *    the optional Wave U authority fields (`metaAuthorityGrants`,
 *    `templateAuthorityTrust`) must additionally arrive as own properties, so a
 *    prototype-carried record rejects as pollution (defect cc2b4e8).
 * 3. Required fields: non-empty string `version` whose major component matches
 *    `SANDBOX_PERSISTENCE_VERSION`, positive number `timestamp`, and an `agents`
 *    array whose entries each carry a non-empty string `id`, an object `config`,
 *    an array `history`, and an array-or-null `redoStack`.
 * 4. Optional sections when present: `recycleBin` (same per-entry checks as
 *    `agents`), `virtualFs` (workspace-ID and file-map shape), `messagingBus`,
 *    `scheduledTimers`, `worldClock`, and `agentDraftInputs`.
 *
 * Purity: Pure inspection function. Never throws; returns `{ valid: false, error, code }` on invalid input.
 *
 * @param state - The raw object or parsed JSON payload to validate.
 * @returns `ValidationResult` containing `{ valid: true, state }` or `{ valid: false, error, code }`.
 *
 * @example
 * ```typescript
 * import { validateSandboxState, PERSISTENCE_ERROR_CODES } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const rawJson = JSON.parse(uploadedFileString);
 * const result = validateSandboxState(rawJson);
 *
 * if (!result.valid) {
 *   console.error(`Invalid backup file: ${result.error} (code: ${result.code})`);
 *   if (result.code === PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED) {
 *     alert('Malicious payload rejected!');
 *   }
 * } else {
 *   console.log('Snapshot validated successfully for version:', result.state?.version);
 * }
 * ```
 */
export function validateSandboxState(state: unknown): ValidationResult {
  try {
    return inspectSandboxState(state);
  } catch (err) {
    const thrown = err && typeof err === 'object' ? err as { message?: unknown } : null;
    const message = (typeof thrown?.message === 'string' && thrown.message)
      ? thrown.message
      : 'unexpected inspection failure';
    return {
      valid: false,
      error: `State inspection failed: ${message}`,
      code: PERSISTENCE_ERROR_CODES.INVALID_STATE
    };
  }
}

/**
 * Internal shape and prototype-pollution inspection for `validateSandboxState`.
 * Reads caller-supplied property values, so it may throw on accessor-bearing
 * input; the exported wrapper converts that into an INVALID_STATE result.
 *
 * @param state - Raw candidate state.
 * @returns Validation result for the inspected state.
 */
function inspectSandboxState(state: unknown): ValidationResult {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { valid: false, error: 'State must be a non-null object', code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
  }

  if (deepHasPrototypePollution(state)) {
    return { valid: false, error: 'Invalid state object (prototype pollution key detected)', code: PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED };
  }

  const candidate = state as Record<string, unknown>;

  // Wave U authority fields must arrive as own data properties (defect
  // cc2b4e8). The persisted state is JSON, so a value reachable only through
  // the prototype chain is hostile: fail the snapshot closed instead of
  // reading it as operator intent during a composition-root restore.
  for (const authorityField of ['metaAuthorityGrants', 'templateAuthorityTrust'] as const) {
    if (!Object.prototype.hasOwnProperty.call(candidate, authorityField)
      && authorityField in candidate) {
      return {
        valid: false,
        error: `Invalid state object ('${authorityField}' must be an own property)`,
        code: PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED
      };
    }
  }

  if (typeof candidate.version !== 'string' || !candidate.version.trim()) {
    return { valid: false, error: "Missing or invalid 'version' field", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
  }

  const majorVersion = candidate.version.split('.')[0];
  const expectedMajor = SANDBOX_PERSISTENCE_VERSION.split('.')[0];
  if (majorVersion !== expectedMajor) {
    return {
      valid: false,
      error: `Incompatible schema version '${candidate.version}'. Expected major version '${expectedMajor}'.`,
      code: PERSISTENCE_ERROR_CODES.VERSION_MISMATCH
    };
  }

  if (typeof candidate.timestamp !== 'number' || isNaN(candidate.timestamp) || candidate.timestamp <= 0) {
    return { valid: false, error: "Missing or invalid 'timestamp' field", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
  }

  if (!Array.isArray(candidate.agents)) {
    return { valid: false, error: "'agents' must be an array", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
  }

  for (let i = 0; i < candidate.agents.length; i++) {
    const agent: unknown = candidate.agents[i];
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
      return { valid: false, error: `Agent at index ${i} is not a valid object`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    const agentRecord = agent as Record<string, unknown>;
    if (typeof agentRecord.id !== 'string' || !agentRecord.id.trim()) {
      return { valid: false, error: `Agent at index ${i} is missing a valid string 'id'`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    if (!agentRecord.config || typeof agentRecord.config !== 'object' || Array.isArray(agentRecord.config)) {
      return { valid: false, error: `Agent '${agentRecord.id}' is missing a valid 'config' object`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    if (!Array.isArray(agentRecord.history)) {
      return { valid: false, error: `Agent '${agentRecord.id}' is missing a valid 'history' array`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    if (agentRecord.redoStack !== undefined && agentRecord.redoStack !== null && !Array.isArray(agentRecord.redoStack)) {
      return { valid: false, error: `Agent '${agentRecord.id}' redoStack must be an array`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
  }

  // Validate recycleBin if present
  if (candidate.recycleBin !== undefined && candidate.recycleBin !== null) {
    if (!Array.isArray(candidate.recycleBin)) {
      return { valid: false, error: "'recycleBin' must be an array", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }

    for (let i = 0; i < candidate.recycleBin.length; i++) {
      const agent: unknown = candidate.recycleBin[i];
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
        return { valid: false, error: `Recycled agent at index ${i} is not a valid object`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
      const agentRecord = agent as Record<string, unknown>;
      if (typeof agentRecord.id !== 'string' || !agentRecord.id.trim()) {
        return { valid: false, error: `Recycled agent at index ${i} is missing a valid string 'id'`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
      if (!agentRecord.config || typeof agentRecord.config !== 'object' || Array.isArray(agentRecord.config)) {
        return { valid: false, error: `Recycled agent '${agentRecord.id}' is missing a valid 'config' object`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
      if (!Array.isArray(agentRecord.history)) {
        return { valid: false, error: `Recycled agent '${agentRecord.id}' is missing a valid 'history' array`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
      if (agentRecord.redoStack !== undefined && agentRecord.redoStack !== null && !Array.isArray(agentRecord.redoStack)) {
        return { valid: false, error: `Recycled agent '${agentRecord.id}' redoStack must be an array`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
    }
  }

  // Validate virtualFs if present
  if (candidate.virtualFs !== undefined && candidate.virtualFs !== null) {
    if (typeof candidate.virtualFs !== 'object' || Array.isArray(candidate.virtualFs)) {
      return { valid: false, error: "'virtualFs' must be an object map of workspaces", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    const wsKeys = Object.getOwnPropertyNames(candidate.virtualFs);
    for (let i = 0; i < wsKeys.length; i++) {
      const wsId = wsKeys[i];
      if (typeof wsId !== 'string' || !wsId.trim()) {
        return { valid: false, error: "Workspace ID must be a non-empty string", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
      const files = (candidate.virtualFs as Record<string, unknown>)[wsId];
      if (files !== null && typeof files === 'object' && !Array.isArray(files)) {
        // file entries validated by deepHasPrototypePollution
      } else if (files !== undefined && files !== null) {
        return { valid: false, error: `Workspace '${wsId}' files must be an object map`, code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
    }
  }

  // Validate messagingBus if present
  if (candidate.messagingBus !== undefined && candidate.messagingBus !== null) {
    if (typeof candidate.messagingBus !== 'object' || Array.isArray(candidate.messagingBus)) {
      return { valid: false, error: "'messagingBus' must be an object", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    if ((candidate.messagingBus as Record<string, unknown>).auditLog !== undefined
      && !Array.isArray((candidate.messagingBus as Record<string, unknown>).auditLog)) {
      return { valid: false, error: "'messagingBus.auditLog' must be an array", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
  }

  // Validate scheduledTimers if present
  if (candidate.scheduledTimers !== undefined && candidate.scheduledTimers !== null && !Array.isArray(candidate.scheduledTimers)) {
    return { valid: false, error: "'scheduledTimers' must be an array", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
  }

  // Validate worldClock if present
  if (candidate.worldClock !== undefined && candidate.worldClock !== null) {
    if (typeof candidate.worldClock !== 'object' || Array.isArray(candidate.worldClock)) {
      return { valid: false, error: "'worldClock' must be an object", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    if ((candidate.worldClock as Record<string, unknown>).events !== undefined
      && !Array.isArray((candidate.worldClock as Record<string, unknown>).events)) {
      return { valid: false, error: "'worldClock.events' must be an array", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    if ((candidate.worldClock as Record<string, unknown>).totalSeconds !== undefined
      && (typeof (candidate.worldClock as Record<string, unknown>).totalSeconds !== 'number'
        || isNaN((candidate.worldClock as Record<string, unknown>).totalSeconds as number))) {
      return { valid: false, error: "'worldClock.totalSeconds' must be a number", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
  }

  // Validate agentDraftInputs if present
  if (candidate.agentDraftInputs !== undefined && candidate.agentDraftInputs !== null) {
    if (typeof candidate.agentDraftInputs !== 'object' || Array.isArray(candidate.agentDraftInputs)) {
      return { valid: false, error: "'agentDraftInputs' must be an object map", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
  }

  // Wave U publishing-authority grants (ticket 2518510): fail clipped and
  // fail-closed — a malformed grant field rejects the snapshot rather than
  // being silently dropped, because a partially readable authority list could
  // misrepresent which grants an operator actually made. Grants are never
  // derived from this field: hydration re-applies them through the
  // composition-root restore only.
  if (Object.prototype.hasOwnProperty.call(candidate, 'metaAuthorityGrants')
    && candidate.metaAuthorityGrants !== undefined
    && candidate.metaAuthorityGrants !== null) {
    const grants = candidate.metaAuthorityGrants;
    if (typeof grants !== 'object' || Array.isArray(grants)) {
      return { valid: false, error: "'metaAuthorityGrants' must be an object", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    for (const authority of ['template', 'hydration'] as const) {
      const refs = (grants as Record<string, unknown>)[authority];
      if (refs === undefined || refs === null) continue;
      if (!Array.isArray(refs)) {
        return {
          valid: false,
          error: `'metaAuthorityGrants.${authority}' must be an array of identity keys`,
          code: PERSISTENCE_ERROR_CODES.INVALID_STATE
        };
      }
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (typeof ref !== 'string' || !ref.trim()) {
          return {
            valid: false,
            error: `'metaAuthorityGrants.${authority}[${i}]' must be a non-empty string`,
            code: PERSISTENCE_ERROR_CODES.INVALID_STATE
          };
        }
      }
    }
  }

  // Wave U template-authority trust (ticket 2518510): fail closed on any
  // malformed entry. Trust is operator intent only; it never grants authority
  // directly, and the store drops entries whose template/agent pairs are no
  // longer declared when it auto-approves an exact match.
  if (Object.prototype.hasOwnProperty.call(candidate, 'templateAuthorityTrust')
    && candidate.templateAuthorityTrust !== undefined
    && candidate.templateAuthorityTrust !== null) {
    const trust = candidate.templateAuthorityTrust;
    if (typeof trust !== 'object' || Array.isArray(trust)) {
      return { valid: false, error: "'templateAuthorityTrust' must be an object", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
    }
    for (const templateId of Object.keys(trust)) {
      if (typeof templateId !== 'string' || !templateId.trim()) {
        return { valid: false, error: "'templateAuthorityTrust' carries an empty template id", code: PERSISTENCE_ERROR_CODES.INVALID_STATE };
      }
      const agents = (trust as Record<string, unknown>)[templateId];
      if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
        return {
          valid: false,
          error: `'templateAuthorityTrust['${templateId}']' must be an object of agent key to authority ids`,
          code: PERSISTENCE_ERROR_CODES.INVALID_STATE
        };
      }
      for (const agentKey of Object.keys(agents)) {
        if (typeof agentKey !== 'string' || !agentKey.trim()) {
          return {
            valid: false,
            error: `'templateAuthorityTrust['${templateId}']' carries an empty agent key`,
            code: PERSISTENCE_ERROR_CODES.INVALID_STATE
          };
        }
        const authorities = (agents as Record<string, unknown>)[agentKey];
        if (!Array.isArray(authorities)) {
          return {
            valid: false,
            error: `'templateAuthorityTrust['${templateId}']['${agentKey}']' must be an array of authority ids`,
            code: PERSISTENCE_ERROR_CODES.INVALID_STATE
          };
        }
        for (let i = 0; i < authorities.length; i++) {
          const authority = authorities[i];
          if (typeof authority !== 'string' || !authority.trim()) {
            return {
              valid: false,
              error: `'templateAuthorityTrust['${templateId}']['${agentKey}'][${i}]' must be a non-empty string`,
              code: PERSISTENCE_ERROR_CODES.INVALID_STATE
            };
          }
        }
      }
    }
  }

  // MOD-20 additive preset fields, the Wave A additive realm-registry field,
  // and the Wave T additive imported-template field: structurally invalid
  // values are dropped instead of failing the snapshot, so legacy and
  // partially written sessions still load (absent/invalid -> dropped; old
  // snapshots byte-compatible).
  return {
    valid: true,
    state: normalizeActiveAgentKeyField(
      normalizeImportedTemplateSnapshotFields(
        normalizeRealmSnapshotFields(normalizePresetSnapshotFields(candidate))
      )
    ) as unknown as SandboxPersistedState
  };
}

/**
 * Normalizes the additive canonical selection key of an already structurally
 * valid snapshot (defect 7d2c314). A non-empty string is kept verbatim, an
 * absent or `null` value is preserved (the field is optional), and any other
 * value is dropped, so a malformed key can never reach hydration. Returns the
 * input reference when no field needs dropping, so clean legacy snapshots
 * keep their exact identity.
 *
 * @param candidate - Structurally valid snapshot record.
 * @returns The input reference, or a shallow copy with an invalid key dropped.
 */
function normalizeActiveAgentKeyField(candidate: Record<string, unknown>): Record<string, unknown> {
  const value = candidate.activeAgentKey;
  if (value === undefined || value === null) return candidate;
  if (typeof value === 'string' && value.trim().length > 0) return candidate;
  const normalized: Record<string, unknown> = { ...candidate };
  delete normalized.activeAgentKey;
  return normalized;
}

/**
 * Serializes live subsystem states (AgentRuntime, VirtualFS, MessagingBus, WorldClock)
 * into an isolated, deep-cloned, credential-sanitized `SandboxPersistedState` snapshot.
 *
 * Serializes live runtime, virtualFs, messagingBus, worldClock, and UI metadata into an isolated snapshot.
 *
 * Agent bodies are serialized through the entity-owned snapshot contract
 * (`Agent.toSnapshot()`, `runtime/agent`); persistence only layers credential
 * stripping, deterministic history message ids, diagnostic redaction, and
 * recycle-bin defaults on top instead of rebuilding the agent field map.
 *
 * Execution steps:
 * 1. Serializes each active agent through the entity-owned snapshot contract (`Agent.toSnapshot()`).
 * 2. Strips all API keys, KEKs, and the retired legacy provider-URL channels from each copied config.
 * 3. Backfills deterministic message IDs across the copied histories and redacts persisted `lastError` diagnostics.
 * 4. Serializes recycled agents through the same contract with recycle-bin timestamp/reason defaults.
 * 5. Exports VirtualFS workspace file trees via the runtime persistence port (`runtime.createPersistencePort().virtualFs.exportSnapshot()`), whose VFS members carry the composition-root `InternalPrincipal` binding (MOD-21 W8-D/W8-F); the direct `virtualFs.exportSnapshot()` fallback applies only to runtimes without a persistence port.
 * 6. Exports MessagingBus audit logs and inboxes via `messagingBus.exportSnapshot()`.
 * 7. Exports active one-shot scheduled timers via `runtime.exportSchedules()`.
 * 8. Exports WorldClock simulation seconds and events via `worldClock.exportSnapshot()`.
 * 9. Attaches UI session metadata (`activeAgentId`, `activeFsWorkspace`, `activeTab`, `agentDraftInputs`), plus the additive MOD-20 preset topology (`activePresetId` and credential-stripped `customPresets`), the additive realm-registry topology (`realms`), and the additive imported-template topology (`importedRealmTemplates`) when supplied.
 *
 * @param env - Live `AgentRuntime` instance or `PersistenceEnvironmentObject` container.
 * @param meta - Optional UI session metadata (active agent, tab, workspace, draft inputs).
 * @returns Immutable, fully serializable `SandboxPersistedState` snapshot.
 * @throws `Error` - With code `ERR_PERSISTENCE_SERIALIZATION_FAILED` if `runtime` is missing or invalid.
 *
 * @example
 * ```typescript
 * import { serializeRuntimeEnvironment } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const snapshot = serializeRuntimeEnvironment(runtime, {
 *   activeAgentId: 'director',
 *   activeFsWorkspace: 'workspace-default',
 *   activeTab: 'chat',
 *   agentDraftInputs: { 'director': 'Draft message...' }
 * });
 *
 * console.log(`Serialized ${snapshot.agents.length} agents at ${snapshot.timestamp}`);
 * ```
 */
export function serializeRuntimeEnvironment(
  env: PersistenceEnvironment,
  meta: SessionMetadata = {}
): SandboxPersistedState {
  let actualRuntime: AgentRuntime | null = null;
  let vFs: PersistedSubsystem | null | undefined = null;
  let mBus: PersistedSubsystem | null | undefined = null;
  let worldClock: PersistedSubsystem | null | undefined = null;
  let sessionMeta: SessionMetadata = {};

  if (env && typeof env === 'object') {
    const envBag = env as PersistenceEnvironmentObject;
    if (envBag.runtime) {
      actualRuntime = envBag.runtime;
      vFs = env.virtualFs || actualRuntime?.virtualFs;
      mBus = env.messagingBus || actualRuntime?.messagingBus;
      worldClock = env.worldClock || actualRuntime?.worldClock;
    } else {
      actualRuntime = env as AgentRuntime;
      vFs = env.virtualFs || actualRuntime?.virtualFs;
      mBus = env.messagingBus || actualRuntime?.messagingBus;
      worldClock = env.worldClock || actualRuntime?.worldClock;
    }
  }

  // Handle standard (env, meta) callers
  if (meta && typeof meta === 'object') {
    sessionMeta = meta;
  }

  if (!actualRuntime || typeof actualRuntime !== 'object') {
    const error: Error & { code?: string } = new Error('Cannot serialize runtime environment: missing or invalid runtime');
    error.code = PERSISTENCE_ERROR_CODES.SERIALIZATION_FAILED;
    throw error;
  }

  // Extract raw active agents from runtime
  let rawAgents: Agent[] = [];
  if (typeof actualRuntime.listAgents === 'function') {
    rawAgents = actualRuntime.listAgents();
  }

  const serializedAgents = rawAgents.map((agent) => serializeAgentSnapshot(agent, false));

  // Extract raw recycled agents from runtime
  let rawRecycledAgents: Agent[] = [];
  if (typeof actualRuntime.listRecycledAgents === 'function') {
    rawRecycledAgents = actualRuntime.listRecycledAgents();
  }

  const serializedRecycledAgents = rawRecycledAgents.map(
    (agent) => serializeAgentSnapshot(agent, true) as SerializedRecycledAgent
  );

  // Export VirtualFS snapshot through the runtime persistence port, whose VFS
  // members carry the composition-root InternalPrincipal binding (MOD-21
  // W8-D/W8-F); the direct export stays only as a fallback for runtimes without
  // a persistence port.
  const runtimeVfsPort = typeof actualRuntime.createPersistencePort === 'function'
    ? actualRuntime.createPersistencePort()?.virtualFs
    : null;
  const vFsSnapshot = (
    runtimeVfsPort && typeof runtimeVfsPort.exportSnapshot === 'function'
      ? runtimeVfsPort.exportSnapshot()
      : (vFs && typeof vFs.exportSnapshot === 'function' ? vFs.exportSnapshot() : {})
  ) as Record<string, Record<string, VirtualFsPersistedFile>>;

  // Export MessagingBus snapshot
  const mBusSnapshot = (
    mBus && typeof mBus.exportSnapshot === 'function'
      ? mBus.exportSnapshot()
      : { auditLog: [], inboxes: {}, registeredAgents: {} }
  ) as SerializedMessagingBus;

  const activeAgentId = sessionMeta.activeAgentId !== undefined
    ? sessionMeta.activeAgentId
    : (serializedAgents.length > 0 ? serializedAgents[0].id : null);

  // Additive canonical selection key (defect 7d2c314): emitted as plain data
  // alongside the legacy bare `activeAgentId`, so a realm-local agent whose
  // literal id equals another scope's id restores its exact registration.
  const activeAgentKey = typeof sessionMeta.activeAgentKey === 'string' && sessionMeta.activeAgentKey
    ? sessionMeta.activeAgentKey
    : null;

  const activeFsWorkspace = sessionMeta.activeFsWorkspace || 'global';
  const activeTab = sessionMeta.activeTab || 'inspector';

  const agentDraftInputs = sessionMeta.agentDraftInputs !== undefined
    ? sessionMeta.agentDraftInputs
    : {};

  // Additive MOD-20 preset topology: the composition root supplies the active
  // pointer and the catalog's custom entries; both are emitted as plain data
  // and omitted when empty so legacy wire bytes are unchanged.
  const activePresetId = typeof sessionMeta.activePresetId === 'string' && sessionMeta.activePresetId.trim()
    ? sessionMeta.activePresetId.trim()
    : null;

  const customPresets = Array.isArray(sessionMeta.customPresets)
    ? sessionMeta.customPresets.filter(isPersistedModelPreset).map(serializePresetRecord)
    : [];

  // Additive Wave A realm topology: the composition root supplies the realm
  // registry projection; records are emitted as plain data and omitted when
  // empty so legacy wire bytes are unchanged.
  const realms = Array.isArray(sessionMeta.realms)
    ? sessionMeta.realms.filter(isPersistedRealmRecord).map(serializeRealmRecord)
    : [];

  // Additive Wave T imported-template topology: the composition root supplies
  // the runtime-imported bundle payloads; entries are emitted as plain data and
  // omitted when empty so legacy wire bytes are unchanged.
  const importedRealmTemplates = Array.isArray(sessionMeta.importedRealmTemplates)
    ? sessionMeta.importedRealmTemplates.filter(isPersistedImportedRealmTemplate).map(serializeImportedRealmTemplate)
    : [];

  // Export scheduled timers snapshot
  const scheduledTimers = actualRuntime && typeof actualRuntime.exportSchedules === 'function'
    ? actualRuntime.exportSchedules()
    : [];

  // Export WorldClock snapshot through the runtime persistence port, whose
  // clock members carry the composition-root InternalPrincipal binding (MOD-21
  // W10-C). A denial receipt is never persisted; the direct export stays only
  // as a fallback for runtimes without a persistence port.
  const actualClock: PersistedSubsystem | null | undefined = worldClock || actualRuntime?.worldClock;
  const runtimeClockPort = typeof actualRuntime.createPersistencePort === 'function'
    ? actualRuntime.createPersistencePort()?.worldClock
    : null;
  const exportedClock = (
    runtimeClockPort && typeof runtimeClockPort.exportSnapshot === 'function'
      ? runtimeClockPort.exportSnapshot()
      : (actualClock && typeof actualClock.exportSnapshot === 'function' ? actualClock.exportSnapshot() : null)
  ) as unknown;
  const worldClockSnapshot = exportedClock && (exportedClock as { success?: boolean }).success !== false ? exportedClock : null;

  return {
    version: SANDBOX_PERSISTENCE_VERSION,
    timestamp: Date.now(),
    activeAgentId: activeAgentId || null,
    activeAgentKey,
    activeFsWorkspace,
    activeTab,
    agents: serializedAgents,
    recycleBin: serializedRecycledAgents,
    virtualFs: vFsSnapshot,
    messagingBus: mBusSnapshot,
    scheduledTimers,
    worldClock: worldClockSnapshot as SerializedWorldClock | null,
    agentDraftInputs: (typeof agentDraftInputs === 'object' && agentDraftInputs !== null) ? { ...agentDraftInputs } : {},
    ...(activePresetId ? { activePresetId } : {}),
    ...(customPresets.length > 0 ? { customPresets } : {}),
    ...(realms.length > 0 ? { realms } : {}),
    ...(importedRealmTemplates.length > 0 ? { importedRealmTemplates } : {})
  };
}

/**
 * Validates and restores a persisted snapshot into live runtime subsystems in strict
 * topological order, guaranteeing the Zero Zombie Invariant and normalizing agent states.
 *
 * Faithfully restores and hydrates a persisted state snapshot back into live instances in strict topological order.
 * Enforces Zero Zombie Invariant and active agent state normalization to IDLE.
 * A live runtime is mandatory: hydration is target-driven and the runtime owns
 * `'state_restored'` emission inside `importSnapshot()`.
 *
 * Subsystem receipts are captured, never discarded. When VirtualFS, WorldClock,
 * or MessagingBus explicitly rejects its snapshot (`{ success: false }`), the
 * remaining stages still run (partial/degraded hydration), but the overall
 * result is a failure carrying `HYDRATION_FAILED`, a subsystem error summary,
 * the flattened per-entry `details`, and every captured receipt. The rejecting
 * WorldClock validates atomically, so its prior in-memory state is untouched.
 *
 * Agent bodies restore through the entity-owned snapshot contract
 * (`Agent.fromSnapshot()`), so `lastInterruptedTurn` and the redacted
 * `lastError` diagnostic round-trip; persistence never writes entity fields
 * directly.
 *
 * Topological Hydration Sequence:
 * 1. Validates snapshot schema via `validateSandboxState()`.
 * 2. Hydrates `VirtualFS` through the runtime persistence port (`runtime.createPersistencePort().virtualFs.importSnapshot()`), whose VFS members carry the composition-root `InternalPrincipal` binding (MOD-21 W8-D/W8-F); the direct `virtualFs.importSnapshot()` fallback applies only to runtimes without a persistence port.
 * 3. Hydrates `WorldClock` (`worldClock.importSnapshot()`), falling back to `worldClock.syncFromVirtualFs()` when the snapshot omits `worldClock`.
 * 4. Hydrates `MessagingBus` (`messagingBus.importSnapshot()`).
 * 5. Clears active runtime state, cancels in-flight turns, and restores active agents in state `IDLE`; hostile lifecycle claims (`state`, `stateDetail`, `recycledAt`, `recycleReason`) are stripped first, and recycled/terminated-claiming entries are routed to the recycle bin. Every entry's identity fields (`id`/`config.id`) are canonicalized (trimmed) on the normalized copies before hydration (1398527/38a64ae).
 * 6. Re-attaches reactive mail subscriptions for active agents on `MessagingBus`.
 * 7. Restores recycled agents in state `RECYCLED` and marks them terminated on `MessagingBus` (Zero Zombie Invariant).
 * 8. Restores scheduled timers and emits the `'state_restored'` event inside `runtime.importSnapshot()` (runtime-owned emission; no caller emission option).
 *
 * Agent bodies restore through the entity-owned snapshot contract
 * (`Agent.fromSnapshot()`), which carries `lastInterruptedTurn` and the redacted
 * `lastError` diagnostic; persistence never writes entity fields directly.
 * Authority is re-derived, never restored (MOD-21 W5/W8): snapshot privilege
 * claims are ignored, `true` claims downgrade silently to anonymous, a
 * schema-invalid claim makes hydration fail closed instead of elevating, and
 * the persisted capability selectors (`allowedTools`/`tools`) are withheld from
 * the copied config so the legacy tool gate cannot re-grant a snapshot
 * whitelist.
 *
 * The persisted snapshot crosses into `AgentRuntime.importSnapshot` as a
 * structural subset: the runtime implementation consumes `agents`,
 * `recycleBin`, and `scheduledTimers` and accepts this shape, while its
 * declared parameter is `RuntimeSnapshot`, which additionally requires
 * `status` and `exportedAt`. A direct typed call
 * `runtime.importSnapshot(persistedState)` is therefore not assignable under
 * the runtime contract; `restoreRuntimeEnvironment` is the supported bridge
 * across the persistence/runtime seam.
 *
 * A live runtime is mandatory: when `env` carries no object with a callable
 * `importSnapshot`, restoration fails with `PERSISTENCE_ERROR_CODES.HYDRATION_FAILED`
 * and never reports success.
 *
 * Subsystem receipts are captured, never discarded. When VirtualFS, WorldClock,
 * or MessagingBus explicitly rejects its snapshot (`{ success: false }`), every
 * hydration stage still runs (partial/degraded state), but the result is
 * `{ success: false, code: HYDRATION_FAILED, error, details, receipts, metadata }`
 * carrying the rejecting receipt instead of an unconditional success. The
 * WorldClock validates atomically, so a rejected clock snapshot leaves its
 * prior in-memory state untouched.
 *
 * @param persistedState - The validated sandbox state snapshot to restore.
 * @param env - Target live `AgentRuntime` or `PersistenceEnvironmentObject` container.
 * @returns `RestoreResult` containing `{ success: true, metadata, receipts }` on success, or `{ success: false, error, code, details?, receipts?, metadata? }` on failure.
 *
 * @example
 * ```typescript
 * import { restoreRuntimeEnvironment, loadSandboxState } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const savedState = loadSandboxState();
 * if (savedState) {
 *   const result = restoreRuntimeEnvironment(savedState, runtime);
 *   if (result.success && result.metadata) {
 *     console.log(`Successfully hydrated ${result.metadata.activeAgentCount} active agents.`);
 *     console.log(`Selected agent: ${result.metadata.activeAgentId}`);
 *   } else {
 *     console.error(`Hydration failed: ${result.error} (code: ${result.code})`);
 *   }
 * }
 * ```
 */
export function restoreRuntimeEnvironment(
  persistedState: SandboxPersistedState,
  env: PersistenceEnvironment
): RestoreResult {
  const validation = validateSandboxState(persistedState);
  if (!validation.valid) {
    console.error('[SandboxPersistence] Cannot restore invalid state:', validation.error);
    return {
      success: false,
      error: validation.error || 'Invalid state schema',
      code: validation.code || PERSISTENCE_ERROR_CODES.INVALID_STATE
    };
  }

  let actualRuntime: AgentRuntime | null = null;
  let vFs: PersistedSubsystem | null | undefined = null;
  let mBus: PersistedSubsystem | null | undefined = null;
  let worldClock: PersistedSubsystem | null | undefined = null;

  if (env && typeof env === 'object') {
    const envBag = env as PersistenceEnvironmentObject;
    if (envBag.runtime) {
      actualRuntime = envBag.runtime;
      vFs = env.virtualFs || actualRuntime?.virtualFs;
      mBus = env.messagingBus || actualRuntime?.messagingBus;
      worldClock = env.worldClock || actualRuntime?.worldClock;
    } else {
      actualRuntime = env as AgentRuntime;
      vFs = env.virtualFs || actualRuntime?.virtualFs;
      mBus = env.messagingBus || actualRuntime?.messagingBus;
      worldClock = env.worldClock || actualRuntime?.worldClock;
    }
  }

  if (!actualRuntime || typeof actualRuntime.importSnapshot !== 'function') {
    const error = 'Cannot restore runtime environment: missing or invalid runtime';
    console.error('[SandboxPersistence]', error);
    return {
      success: false,
      error,
      code: PERSISTENCE_ERROR_CODES.HYDRATION_FAILED
    };
  }

  // Normalize the validated snapshot against the entity snapshot contract
  // before hydration so hostile lifecycle claims cannot create running or
  // live-recycled active agents.
  const normalized = normalizeSnapshotForHydration(persistedState);

  /**
   * Subsystem import receipts captured in topological order. A subsystem that
   * returns no receipt (VirtualFS, MessagingBus) is recorded as accepting its
   * snapshot; explicit rejections keep their error code and per-entry details.
   * Declared outside the try so a thrown hydration stage still returns them.
   */
  const receipts: SubsystemImportReceipt[] = [];

  /**
   * Snapshot metadata for the body being hydrated. Built before hydration so
   * clean success, partial rejection, and thrown stages all return it.
   */
  const metadata = {
    version: persistedState.version,
    timestamp: persistedState.timestamp,
    activeAgentId: persistedState.activeAgentId || null,
    // Additive canonical selection key (defect 7d2c314): `null` on legacy
    // snapshots that predate the field.
    activeAgentKey: typeof persistedState.activeAgentKey === 'string' && persistedState.activeAgentKey
      ? persistedState.activeAgentKey
      : null,
    activeFsWorkspace: persistedState.activeFsWorkspace || 'global',
    activeTab: persistedState.activeTab || 'inspector',
    agentDraftInputs: (persistedState.agentDraftInputs && typeof persistedState.agentDraftInputs === 'object')
      ? { ...persistedState.agentDraftInputs }
      : {},
    activeAgentCount: normalized.activeAgentCount,
    recycledAgentCount: normalized.recycledAgentCount
  };

  try {
    // 1. Hydrate VirtualFS through the runtime persistence port, whose VFS
    // members carry the composition-root InternalPrincipal binding (MOD-21
    // W8-D/W8-F); the direct import is the fallback for runtimes without a
    // persistence port.
    const runtimeVfsPort = typeof actualRuntime.createPersistencePort === 'function'
      ? actualRuntime.createPersistencePort()?.virtualFs
      : null;
    if (runtimeVfsPort && typeof runtimeVfsPort.importSnapshot === 'function') {
      receipts.push(toSubsystemImportReceipt('virtualFs', runtimeVfsPort.importSnapshot(persistedState.virtualFs || {})));
    } else if (vFs && typeof vFs.importSnapshot === 'function') {
      receipts.push(toSubsystemImportReceipt('virtualFs', vFs.importSnapshot(persistedState.virtualFs || {})));
    }

    // 2. Hydrate WorldClock through the runtime persistence port, whose clock
    // members carry the composition-root InternalPrincipal binding (MOD-21
    // W10-C); the direct import is the fallback for runtimes without a
    // persistence port (an atomic rejection leaves prior clock state untouched).
    const clock: PersistedSubsystem | null | undefined = worldClock || actualRuntime?.worldClock;
    if (clock) {
      if (persistedState.worldClock && typeof clock.importSnapshot === 'function') {
        const runtimeClockPort = typeof actualRuntime.createPersistencePort === 'function'
          ? actualRuntime.createPersistencePort()?.worldClock
          : null;
        const importedClock = runtimeClockPort && typeof runtimeClockPort.importSnapshot === 'function'
          ? runtimeClockPort.importSnapshot(persistedState.worldClock)
          : clock.importSnapshot(persistedState.worldClock);
        receipts.push(toSubsystemImportReceipt('worldClock', importedClock));
      } else if (typeof clock.syncFromVirtualFs === 'function') {
        receipts.push(toSubsystemImportReceipt('worldClock', clock.syncFromVirtualFs()));
      }
    }

    // 3. Hydrate MessagingBus
    if (mBus && typeof mBus.importSnapshot === 'function') {
      receipts.push(toSubsystemImportReceipt('messagingBus', mBus.importSnapshot(persistedState.messagingBus || {})));
    }

    // 4. Hydrate AgentRuntime active agents from the normalized snapshot
    if (actualRuntime && typeof actualRuntime.importSnapshot === 'function') {
      actualRuntime.importSnapshot(normalized.snapshot as RuntimeSnapshot);
    }

    // 5. Critical subsystem rejections are returned, never discarded. All
    // hydration stages above already ran (partial/degraded state), so metadata
    // and receipts stay attached to the failure for the caller to surface.
    const failures = receipts.filter((receipt) => receipt.success === false);
    if (failures.length > 0) {
      const error = failures.map((receipt) => `${receipt.subsystem}: ${receipt.error}`).join('; ');
      const details = failures.flatMap((receipt) => receipt.details || []);
      console.error('[SandboxPersistence] Hydration rejected by subsystem:', error, details);
      return {
        success: false,
        error,
        code: PERSISTENCE_ERROR_CODES.HYDRATION_FAILED,
        details,
        receipts,
        metadata
      };
    }

    return {
      success: true,
      metadata,
      receipts
    };
  } catch (err) {
    console.error('[SandboxPersistence] Hydration failed:', err);
    const details = receipts
      .filter((receipt) => receipt.success === false)
      .flatMap((receipt) => receipt.details || []);
    return {
      success: false,
      error: extractThrownMessage(err) || 'Hydration failed',
      code: PERSISTENCE_ERROR_CODES.HYDRATION_FAILED,
      ...(details.length > 0 ? { details } : {}),
      receipts,
      metadata
    };
  }
}

/**
 * Synchronously validates and writes a sandbox state snapshot to browser LocalStorage.
 *
 * Persists sandbox state snapshot to browser LocalStorage.
 *
 * Error Handling:
 * - Safely catches `QuotaExceededError` and disabled LocalStorage restrictions (e.g. strict private mode).
 * - Logs structured diagnostics via `console.error` without throwing unhandled exceptions.
 *
 * @param state - Validated `SandboxPersistedState` snapshot to persist.
 * @param options - Optional storage options to override default storage key.
 * @returns `true` if successfully written to LocalStorage; `false` on validation error, quota exceeded, or storage failure.
 *
 * @example
 * ```typescript
 * import { saveSandboxState, serializeRuntimeEnvironment } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const snapshot = serializeRuntimeEnvironment(runtime);
 * const success = saveSandboxState(snapshot);
 * if (!success) {
 *   console.warn('Failed to save sandbox state to LocalStorage (quota exceeded or storage disabled)');
 * }
 * ```
 */
export function saveSandboxState(state: SandboxPersistedState, options: StorageOptions = {}): boolean {
  const validation = validateSandboxState(state);
  if (!validation.valid) {
    console.error('[SandboxPersistence] Cannot save invalid sandbox state:', validation.error);
    return false;
  }

  const key = options?.storageKey || SANDBOX_STATE_STORAGE_KEY;

  try {
    if (key === SANDBOX_STATE_STORAGE_KEY) {
      return writeSandboxStateEntry(state);
    }

    if (typeof window === 'undefined' && typeof globalThis.localStorage === 'undefined') {
      return false;
    }
    const ls = typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage;
    if (!ls) return false;

    const serialized = typeof state === 'string' ? state : JSON.stringify(state);
    ls.setItem(key, serialized);
    return true;
  } catch (err) {
    const failure = err && typeof err === 'object' ? err as { name?: unknown; code?: unknown } : null;
    if (failure && (failure.name === 'QuotaExceededError' || failure.code === 22 || failure.code === 1014 || failure.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
      console.error('[SandboxPersistence] LocalStorage quota exceeded while saving sandbox state:', err);
    } else {
      console.error('[SandboxPersistence] Failed to persist sandbox state:', err);
    }
    return false;
  }
}

let _saveLockPromise = Promise.resolve(true);

/**
 * Chains save execution onto an internal serialization FIFO promise lock queue.
 * Guarantees that concurrent save triggers (e.g. debounced auto-save + turn completion hooks)
 * execute sequentially without racing or lost updates.
 *
 * Asynchronously saves state snapshot through sequential FIFO serialization lock queue.
 * Ensures sequential execution of concurrent calls without data races.
 *
 * @param state - Validated `SandboxPersistedState` snapshot to persist.
 * @param options - Optional storage options to override default storage key.
 * @returns `Promise<boolean>` resolving to `true` on successful write, or `false` on failure.
 *
 * @example
 * ```typescript
 * import { saveSandboxStateLocked, serializeRuntimeEnvironment } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * async function onTurnCompleted() {
 *   const snapshot = serializeRuntimeEnvironment(runtime);
 *   const saved = await saveSandboxStateLocked(snapshot);
 *   console.log('Turn state sequentially saved:', saved);
 * }
 * ```
 */
export async function saveSandboxStateLocked(state: SandboxPersistedState, options: StorageOptions = {}): Promise<boolean> {
  _saveLockPromise = (_saveLockPromise || Promise.resolve(true))
    .catch(() => false)
    .then(async () => {
      try {
        const snapshot = state && typeof state === 'object'
          ? (typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state)))
          : state;
        return saveSandboxState(snapshot, options);
      } catch (err) {
        console.error('[SandboxPersistence] Error during locked save:', err);
        return false;
      }
    });

  return _saveLockPromise;
}

/**
 * Quarantines an unreadable persisted entry by moving it to a timestamped
 * backup key (best effort) and clearing the canonical key so the next save
 * cannot silently overwrite the corrupt blob. Falls back to plain removal.
 *
 * @param key - Canonical storage key.
 * @returns Backup key when the entry was successfully moved, or
 *   null when nothing was quarantined (including when the backup write failed
 *   and the canonical entry was removed without a copy).
 */
function quarantineUnreadableEntry(key: string) {
  try {
    const ls = getRawLocalStorage();
    if (!ls) return null;
    const raw = ls.getItem(key);
    if (raw === null || raw === undefined) return null;

    const backupKey = `${key}__corrupt_${Date.now()}`;
    let backupStored = false;
    try {
      ls.setItem(backupKey, raw);
      backupStored = true;
    } catch {
      // Best effort backup; canonical removal below still prevents overwrite.
    }
    try {
      ls.removeItem(key);
    } catch {
      return null;
    }
    return backupStored ? backupKey : null;
  } catch {
    return null;
  }
}

/**
 * Notifies an optional recovery listener without ever throwing into the load path.
 *
 * @param options - loadSandboxState options bag.
 * @param info - Recovery diagnostic describing the quarantined entry.
 */
function notifyRecovery(options: StorageOptions, info: SandboxStateRecoveryInfo): void {
  if (options && typeof options.onRecovery === 'function') {
    try {
      options.onRecovery(info);
    } catch {
      // Recovery listeners are diagnostic only; never block hydration.
    }
  }
}

/**
 * Clears the internal promise chain for `saveSandboxStateLocked()`, resetting it to
 * an immediate resolved state.
 *
 * Resets internal serialization FIFO lock queue (for testing, teardown, and recovery).
 *
 * Intended for test teardown, error recovery, and clean suite initialization.
 *
 * @example
 * ```typescript
 * import { resetSaveLockQueue } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * afterEach(() => {
 *   resetSaveLockQueue();
 * });
 * ```
 */
export function resetSaveLockQueue(): void {
  _saveLockPromise = Promise.resolve(true);
}

/**
 * Reads, deserializes, and validates the persisted sandbox state from browser LocalStorage.
 *
 * Loads and validates sandbox state snapshot from browser LocalStorage.
 * If data is missing, corrupted, or invalid, safely returns null without throwing.
 * Unreadable entries are quarantined (moved aside) and reported through the
 * optional `options.onRecovery` callback so callers can surface a recovery notice.
 *
 * Robustness:
 * - Safely catches `JSON.parse` syntax errors and schema validation failures.
 * - Safely handles missing, empty, or corrupted LocalStorage keys.
 * - Returns `null` on any error without throwing.
 * - Quarantines unreadable entries and reports them via `options.onRecovery`.
 *
 * @param options - Optional storage options to override default storage key or observe recovery.
 * @returns `SandboxPersistedState` if valid state exists; `null` if absent, empty, corrupted, or invalid.
 *
 * @example
 * ```typescript
 * import { loadSandboxState, restoreRuntimeEnvironment } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * const state = loadSandboxState();
 * if (state) {
 *   restoreRuntimeEnvironment(state, runtime);
 * } else {
 *   console.log('No prior sandbox state found. Starting fresh session.');
 * }
 * ```
 */
export function loadSandboxState(options: StorageOptions = {}): SandboxPersistedState | null {
  const key = options?.storageKey || SANDBOX_STATE_STORAGE_KEY;

  try {
    if (key === SANDBOX_STATE_STORAGE_KEY) {
      const rawState = readSandboxStateEntry();
      if (rawState) {
        const validation = validateSandboxState(rawState);
        if (!validation.valid) {
          console.warn('[SandboxPersistence] Stored sandbox state failed schema validation:', validation.error);
          const quarantinedKey = quarantineUnreadableEntry(key);
          notifyRecovery(options, {
            reason: 'invalid-schema',
            detail: validation.error || null,
            key,
            quarantinedKey
          });
          return null;
        }
        return validation.state ?? null;
      }

      // Facade returned no state: distinguish "absent" from "unreadable" by
      // inspecting the raw entry the facade could not deserialize.
      const ls = getRawLocalStorage();
      if (!ls) return null;
      const serialized = ls.getItem(key);
      if (!serialized) return null;

      let parsedState: unknown;
      try {
        parsedState = JSON.parse(serialized);
      } catch (parseErr) {
        console.warn('[SandboxPersistence] Failed to deserialize sandbox state:', parseErr);
        const quarantinedKey = quarantineUnreadableEntry(key);
        notifyRecovery(options, {
          reason: 'unparseable',
          detail: extractThrownMessage(parseErr),
          key,
          quarantinedKey
        });
        return null;
      }

      const validation = validateSandboxState(parsedState);
      if (!validation.valid) {
        console.warn('[SandboxPersistence] Stored sandbox state failed schema validation:', validation.error);
        const quarantinedKey = quarantineUnreadableEntry(key);
        notifyRecovery(options, {
          reason: 'invalid-schema',
          detail: validation.error || null,
          key,
          quarantinedKey
        });
        return null;
      }

      return validation.state ?? null;
    }

    if (typeof window === 'undefined' && typeof globalThis.localStorage === 'undefined') {
      return null;
    }
    const ls = typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage;
    if (!ls) return null;

    const serialized = ls.getItem(key);
    if (!serialized) return null;

    let rawState: unknown;
    try {
      rawState = JSON.parse(serialized);
    } catch (parseErr) {
      console.warn('[SandboxPersistence] Failed to deserialize sandbox state:', parseErr);
      const quarantinedKey = quarantineUnreadableEntry(key);
      notifyRecovery(options, {
        reason: 'unparseable',
        detail: extractThrownMessage(parseErr),
        key,
        quarantinedKey
      });
      return null;
    }

    const validation = validateSandboxState(rawState);
    if (!validation.valid) {
      console.warn('[SandboxPersistence] Stored sandbox state failed schema validation:', validation.error);
      const quarantinedKey = quarantineUnreadableEntry(key);
      notifyRecovery(options, {
        reason: 'invalid-schema',
        detail: validation.error || null,
        key,
        quarantinedKey
      });
      return null;
    }

    return validation.state ?? null;
  } catch (err) {
    console.warn('[SandboxPersistence] Failed to load or deserialize sandbox state:', err);
    return null;
  }
}

/**
 * Factory reset primitive. Removes the sandbox state key from browser LocalStorage.
 *
 * Clears/wipes the persisted sandbox state key from LocalStorage (Factory Reset primitive).
 *
 * @param options - Optional storage options to override default storage key.
 * @returns `true` if successfully removed or already absent; `false` on storage error.
 *
 * @example
 * ```typescript
 * import { clearSandboxState } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * function handleFactoryReset() {
 *   if (confirm('Erase all agents and virtual files?')) {
 *     clearSandboxState();
 *     window.location.reload();
 *   }
 * }
 * ```
 */
export function clearSandboxState(options: StorageOptions = {}): boolean {
  const key = options?.storageKey || SANDBOX_STATE_STORAGE_KEY;

  try {
    if (key === SANDBOX_STATE_STORAGE_KEY) {
      return removeSandboxStateEntry();
    }

    if (typeof window === 'undefined' && typeof globalThis.localStorage === 'undefined') {
      return true;
    }
    const ls = typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage;
    if (!ls) return true;

    ls.removeItem(key);
    return true;
  } catch (err) {
    console.error('[SandboxPersistence] Failed to clear sandbox state:', err);
    return false;
  }
}

/**
 * High-speed boolean check verifying whether a non-empty persisted sandbox snapshot exists
 * in LocalStorage.
 *
 * Checks whether a non-empty persisted sandbox state snapshot exists in LocalStorage.
 * Whitespace-only entries are treated as absent on both the facade and fallback paths.
 *
 * Performance: Performs no JSON parsing or schema validation for maximum boot performance.
 *
 * @param options - Optional storage options to override default storage key.
 * @returns `true` if a non-empty snapshot exists in LocalStorage; `false` otherwise.
 *
 * @example
 * ```typescript
 * import { hasPersistedState } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * if (hasPersistedState()) {
 *   console.log('Found existing session; auto-hydration eligible.');
 * }
 * ```
 */
export function hasPersistedState(options: StorageOptions = {}): boolean {
  const key = options?.storageKey || SANDBOX_STATE_STORAGE_KEY;

  try {
    if (key === SANDBOX_STATE_STORAGE_KEY && !hasSandboxStateEntry()) {
      return false;
    }

    const ls = getRawLocalStorage();
    if (!ls) return false;

    const item = ls.getItem(key);
    return typeof item === 'string' && item.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Constructs a burst-coalescing auto-save persistence coordinator with configurable delay (default 300ms).
 *
 * Accepted call forms:
 * 1. `createDebouncedSave(options)` — options object (`saveFn`, `delayMs`, `bindWindowEvents`).
 * 2. `createDebouncedSave(saveFn, delayMs?)` — direct save-function injection with optional delay
 *    (legacy positional form; equivalent to `{ saveFn, delayMs }`).
 *
 * Features:
 * - Supports lazy state suppliers (`() => serializeRuntimeEnvironment(...)`) to avoid unnecessary serialization work.
 * - Automatically attaches to browser unload events (`beforeunload`, `pagehide`) to ensure synchronous flush on page dismissal.
 * - Provides synchronous `flushSync()` and cancellation controls.
 *
 * @param saveFn - Save implementation invoked with each coalesced snapshot; may return a boolean or a `Promise<boolean>`.
 * @param delayMs - Debounce coalescing delay in milliseconds (default 300; non-numeric values fall back to the default).
 * @returns `DebouncedSaveCoordinator` instance for managing auto-saves.
 *
 * @example
 * ```typescript
 * import { createDebouncedSave, serializeRuntimeEnvironment, saveSandboxStateLocked } from '$lib/sandbox/sandboxPersistence/index.ts';
 *
 * // Object options form:
 * const autoSaver = createDebouncedSave({
 *   delayMs: 300,
 *   saveFn: (state) => saveSandboxStateLocked(state)
 * });
 *
 * // Positional save-function form (legacy dual API):
 * const positionalSaver = createDebouncedSave((state) => saveSandboxState(state), 300);
 *
 * // Trigger on agent mutation:
 * function onAgentModified() {
 *   autoSaver.schedule(() => serializeRuntimeEnvironment(runtime));
 * }
 *
 * // Clean up on unmount:
 * function cleanup() {
 *   autoSaver.destroy();
 * }
 * ```
 */
export function createDebouncedSave(
  saveFn: (state: SandboxPersistedState) => boolean | Promise<boolean>,
  delayMs?: number
): DebouncedSaveCoordinator;

/**
 * Constructs a burst-coalescing auto-save persistence coordinator with configurable delay (default 300ms).
 *
 * @param options - Optional configuration options (custom save function, delay in ms, unload event bindings).
 * @returns `DebouncedSaveCoordinator` instance for managing auto-saves.
 *
 * @example
 * ```typescript
 * const autoSaver = createDebouncedSave({ bindWindowEvents: false });
 * autoSaver.schedule(() => serializeRuntimeEnvironment(runtime));
 * ```
 */
export function createDebouncedSave(
  options?: DebouncedSaveOptions
): DebouncedSaveCoordinator;

/**
 * Creates a debounced persistence coordinator that coalesces burst writes with synchronous flush support.
 *
 * @param optionsOrSaveFn - DebouncedSaveOptions object or custom save function
 * @param maybeDelayMs - Delay in milliseconds if save function passed as first argument
 * @returns Debounced auto-save coordinator.
 */
export function createDebouncedSave(
  optionsOrSaveFn: DebouncedSaveOptions | ((state: SandboxPersistedState) => boolean | Promise<boolean>) = {},
  maybeDelayMs?: number
): DebouncedSaveCoordinator {
  let saveFn: (state: SandboxPersistedState) => unknown = saveSandboxState;
  let delayMs = 300;
  let bindWindowEvents = true;

  if (typeof optionsOrSaveFn === 'function') {
    saveFn = optionsOrSaveFn;
    if (typeof maybeDelayMs === 'number') {
      delayMs = maybeDelayMs;
    }
  } else if (optionsOrSaveFn && typeof optionsOrSaveFn === 'object') {
    if (typeof optionsOrSaveFn.saveFn === 'function') saveFn = optionsOrSaveFn.saveFn;
    if (typeof optionsOrSaveFn.delayMs === 'number') delayMs = optionsOrSaveFn.delayMs;
    if (typeof optionsOrSaveFn.bindWindowEvents === 'boolean') bindWindowEvents = optionsOrSaveFn.bindWindowEvents;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSupplier: SandboxPersistedState | (() => SandboxPersistedState | null) | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    if (pendingSupplier !== null) {
      const supplier = pendingSupplier;
      pendingSupplier = null;
      try {
        const state = typeof supplier === 'function' ? supplier() : supplier;
        if (state) {
          const res = saveFn(state);
          return res !== false;
        }
        return true;
      } catch (err) {
        console.error('[SandboxPersistence] Error during debounced save flush:', err);
        return false;
      }
    }
    return true;
  };

  const flushSync = () => flush();

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingSupplier = null;
  };

  const schedule = (stateSupplier: SandboxPersistedState | (() => SandboxPersistedState | null)) => {
    pendingSupplier = stateSupplier;

    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      flush();
    }, Math.max(0, delayMs));
  };

  const isPending = () => {
    return timer !== null || pendingSupplier !== null;
  };

  const handleUnload = () => {
    flush();
  };

  if (bindWindowEvents && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
  }

  const destroy = () => {
    cancel();
    if (bindWindowEvents && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    }
  };

  return {
    schedule,
    flush,
    flushSync,
    cancel,
    isPending,
    destroy
  };
}
