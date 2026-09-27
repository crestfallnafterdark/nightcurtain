/**
 * @packageDocumentation
 * Module `toolDefinitions`.
 * Type definitions and comprehensive JSDoc specifications for the sandbox tool system.
 *
 * The Tool System is the Layer 1 Interface Gateway governing all interactions between untrusted Large Language Model
 * (LLM) function calls and the underlying Layer 0 Substrate Primitives (VirtualFS, MessagingBus, WorldClock,
 * InvocationEngine, RuntimeScheduler, and AgentLifecycleManager).
 *
 * @module toolDefinitions
 * @mayImport ../tools/constants/index.ts
 * @mayImport ../tools/normalizers/index.ts
 * @mayImport ../tools/descriptors/index.ts
 * @mayImport type-only ../tools/extensionTools/index.ts
 * @mayImport type-only ../runtime/index.ts
 * @invariant Strict minimal cross-boundary surface: exactly six public value symbols (`createSandboxToolDispatcher`, `getSandboxToolsSchema`, `SANDBOX_TOOLS`, `INNATE_TOOLS`, `TOOL_PRESETS`, `resolveToolPreset`) plus the frozen `TOOL_SYSTEM_ERROR_CODES` dictionary; the exported type-only seams (execution/receipt types and the additive extension provider-port declarations) carry no runtime value.
 * @invariant Table-driven descriptor delegation: each descriptor freezes its own parameter alias map and sanitizer, and its handler delegates to the injected substrate capability (`context.<subsystem>`) or narrow capability port (the dispatcher's `isAuthorized` gate is the single capability-authorization authority; `batch_precall` additionally applies the fixed precall policy allowlist as defense in depth). Handlers are thin but not mechanically 1-line: they guard required capabilities, may branch on sanitized parameters (action dispatch, legacy fallbacks), assemble identity-only caller-scope/option objects for the delegated call — never caller-asserted privilege flags or authority-bearing role aliases — and shape result receipts.
 * @invariant O(1) dispatcher on a frozen registry: routing is a direct property lookup on the frozen `TOOL_REGISTRY`, built once from the frozen descriptor catalog — zero `switch` statements and no registration or mutation path.
 * @invariant Zero LLM schema pollution: schemas exposed to LLMs carry only `name`, `description`, and `descriptor.schema` fields; infrastructure configuration and execution-context fields (`model`, `temperature`, `maxTurns`, `privileged`, `toolPreset`, `allowedTools`, `depth`, `sinceTimestamp`, raw byte limits) never appear in them.
 * @invariant Uniform result envelope: every dispatcher return value is a `ToolResult` — descriptor handler returns are normalized at the dispatcher boundary, objects without a `success` discriminator gain `success: true`, bare arrays are wrapped as `{ success: true, result }`, and primitives become `{ success: true, result }`.
 * @invariant Universal error shielding: the dispatcher never throws unhandled exceptions to the caller — every failure is captured as a typed `{ success: false, error, code }` receipt (`TOOL_NOT_FOUND` for unknown tools, `PERMISSION_DENIED` for unauthorized callers and for a throwing identity port, `EXECUTION_FAILED` for sanitizer/handler failures); every emitted `code` is a declared `TOOL_SYSTEM_ERROR_CODES` member, with downstream codes outside the dictionary normalized to `EXECUTION_FAILED`.
 * @decision `ToolExecutionPort` is declared in this contract; the dispatcher factory seeds both members into every descriptor context — the identity member (the `AgentIdentityPort` from `runtime/index.ts`, exposed via `identityPort`) and a trusted `executeTool` (the construction-bound executor when one was injected, otherwise the dispatcher's own re-entrant closure). A per-call `executeTool` is never consumed
 * @decision The dead `defaultTimeoutMs` dispatcher option was dropped rather than implemented; `SandboxDispatcherOptions` exposes no timeout knob
 * @decision `SERVICE_UNAVAILABLE` is contract-reserved: handlers never emit it themselves, and a missing required substrate surfaces from the error shield as `EXECUTION_FAILED`
 * @decision `canonicalizeToolName` is exposed on the dispatcher as the shared alias-normalization authority so engine consumers (precall revalidation) do not duplicate alias maps
 * @decision Per-call `callerContext` is caller data, never authority: the dispatcher strips its `isAdmin`/`isPrivileged`/`privileged` flags, authority-bearing `callerRole`/`role` aliases, `principal`/`authority` objects, and `allowedTools`, deriving privilege and capability only from trusted bound construction options and the injected identity port
 * @decision Descriptor-authoritative capability: when the projection's frozen `AuthorityDescriptor` is present, capability derives from the descriptor alone — a wildcard/explicit grant authorizes, and a retired-selector entry authorizes exactly its expansion — any other outcome denies, and the deprecated legacy channels above apply only to descriptor-less callers
 * @decision Authority meta tools (`import_realm_template`/`submit_hydration_package` and the M3 `inspect_realm`/`update_realm`, plus the meta-plane tools as they land) are explicit-grant-only: they resolve through the separate `AUTHORITY_TOOL_REGISTRY` (never members of `TOOL_REGISTRY` or `ALL_TOOL_DESCRIPTORS`, never emitted by `getSandboxToolsSchema`), and authorization is the exact authority-id entry on the caller's frozen descriptor — the wildcard `'*'`, `privileged`, and every legacy channel are deliberately insufficient, an engine-internal descriptor stays authorized, and descriptor-less callers deny (INV-9 refinement)
 * @decision Extension tools are exact-membership-only on the separate frozen `AuthorityDescriptor.extensions` axis: the dispatcher's extension branch is gated on an optional provider-registry port (bound at composition), authorize iff `authority.extensions.has(callName)`, with no wildcard/`privileged`/selector/alias/legacy fallback, engine-internal and anonymous/descriptor-less callers denying, and descriptor-probe throws failing closed; the axis is never populated from `allow` and an extension call never falls through to a baked handler or schema. After authorization, the branch resolves the frozen synthesized descriptor through the provider port's optional `resolveDescriptor` and executes it against the pinned `extensionExecutionPort` context key: a missing descriptor or execution port fails closed with `EXECUTION_FAILED`, an unresolved/catalog-less name stays `TOOL_NOT_FOUND`, and a port rejection propagates to the universal error shield as a redacted `EXECUTION_FAILED` receipt
 * @decision Realm/workspace/tenant scope is never caller-supplied: the scope vocabulary (`workspaceId`/`workspace_id`, `realmId`/`realm_id`, `tenantId`/`tenant_id`, `scope`) is pinned at dispatcher construction and stripped from per-call `callerContext`; a scope claim may only ride trusted bound construction (and, once Realm lands, the trusted identity projection), never a tool call
 * @decision Realm-exact caller resolution and canonical key binding: a construction-bound `realmId` resolves the caller projection for exactly that `(realmId, agentId)` registration and binds its canonical identity `key` as the execution context's `callerKey` (a pinned key — per-call `callerKey`/`caller_key` claims are stripped), so substrate contexts disambiguate the same literal id across Realms; an omitted Realm keeps the unique-match resolution and the bare-id channel
 * @decision The identity subject is pinned to construction: `callerAgentId`/`agentId`/nested `callerContext` on a per-call context never select whose `AgentIdentityProjection`/`AuthorityDescriptor` is consulted. The bound `agentId`/`callerAgentId` is the only subject source, and an anonymous dispatcher has no subject and fails closed; a throwing identity port is shielded as a uniform `PERMISSION_DENIED` denial before any dispatch (never an unshielded throw, never a fallback to legacy channels)
 * @decision Identity-bearing substrate operations stay anonymous for an anonymous dispatcher: the dispatcher binds `callerAgentId: null`, and the VFS/messaging substrates resolve identity from the supplied context only — payload `callerAgentId`/`agentId`/`recipient`/`from`/`sender` keys are never promoted, mailbox reads return empty, `wait_for_mail` fails `INVALID_ARGUMENTS`, `send_message` attributes the fixed `'anonymous'` label, and `inline_file_in_message` fails closed
 * @decision Injected capabilities/substrates are pinned to construction: `virtualFs`, `messagingBus`, `worldClock`, `signal`, `currentDepth`, `depth`, `executeTool`, `toolRegistry`, the narrow ports, and engine handles are dropped from per-call contexts and never override bound values; `batch_precall` consumes the bound executor (or the dispatcher's own re-entrant closure when none was bound), so a per-call executor or substrate can never be substituted
 * @decision The per-call `depth` alias is stripped along with the pinned capability keys: handlers read only the construction-bound `currentDepth`, so a caller-supplied depth can neither reset nor inflate the invocation engine's recursion guard
 * @decision Spawn/kill/invoke/schedule descriptors forward identity-only caller scope to the LifecyclePort: the registered `callerAgentId` plus, when the identity projection carries one, the frozen `AuthorityDescriptor` as the caller principal. Caller-asserted privilege flags and role aliases are never forwarded, and authorization remains server-side in the runtime/substrates
 * @decision Legacy caller-asserted authority fields are never authority: per-call `isAdmin`/`isPrivileged`/`privileged`/`callerRole`/`role` values are stripped before dispatch, role values never grant anything, and bound privilege flags are honored only for descriptor-less callers (no removal scheduled)
 * @decision Descriptor-authoritative denial for the legacy channel: for this aspect a present identity-projection `AuthorityDescriptor` is the sole capability decision — only a wildcard/explicit/selector grant authorizes, and every other descriptor outcome denies without consulting the stripped legacy fields
 */

import {
  SANDBOX_TOOLS,
  INNATE_TOOLS,
  expandRetiredToolSelector,
  resolveToolPreset,
  TOOL_SYSTEM_ERROR_CODES
} from '../tools/constants/index.ts';
import type { SandboxToolName, ToolSystemErrorCode } from '../tools/constants/index.ts';
import { getCanonToolName } from '../tools/normalizers/index.ts';
import { ALL_TOOL_DESCRIPTORS, AUTHORITY_TOOL_REGISTRY, TOOL_REGISTRY } from '../tools/descriptors/index.ts';
import type { AuthorityToolDescriptor } from '../tools/descriptors/index.ts';
import type { ExtensionExecutionPort, ExtensionToolDescriptor } from '../tools/extensionTools/index.ts';
import type {
  BundleFiles,
  PendingInstancePayload,
  RealmTemplate
} from '../realmCatalog/index.ts';
import type {
  LifecyclePort,
  AgentIdentityPort,
  AgentIdentityProjection,
  AgentIdentityScope,
  AgentRuntime
} from '../runtime/index.ts';

// Explicit facade re-exports: the toolDefinitions public surface is the
// dispatcher/schema symbols plus the frozen `TOOL_SYSTEM_ERROR_CODES`
// dictionary and the constants types. The capability vocabulary in
// `tools/constants` (`MUTATING_TOOLS`, `READ_ONLY_TOOLS`, `isMutatingTool`)
// intentionally lives only in its canonical home and is NOT re-exported here.
export {
  SANDBOX_TOOLS,
  INNATE_TOOLS,
  TOOL_PRESETS,
  TOOL_SYSTEM_ERROR_CODES
} from '../tools/constants/index.ts';
export type {
  InnateToolsList,
  SandboxToolName,
  ToolPresetName,
  ToolSystemErrorCode
} from '../tools/constants/index.ts';

/**
 * Resolves a tool preset identifier, tool array, Set, or comma-separated string
 * into a canonical array of permitted tool names or wildcard patterns.
 *
 * Supports:
 * - Preset names: `'all'`, `'manager'`, `'collaborator'`, `'readonly_collaborator'`, `'readonly'`
 * - Wildcard string: `'*'` -\> `['*']`
 * - Comma-separated strings: `'read_file, write_file, send_message'`
 * - Arrays of tool names: `['read_file', 'write_file']` (copied as-is)
 * - Single-element preset arrays: `['manager']` -\> the manager preset's tool list
 * - Sets of tool names: `new Set(['read_file', 'whoami'])`
 * - Null or undefined: returns `[]`
 *
 * @param input - Preset name, tool list, Set, or CSV string
 * @returns Canonical array of tool names or wildcard patterns
 *
 * @example
 * ```typescript
 * import { resolveToolPreset } from './toolDefinitions/index.ts';
 *
 * // Resolve a preset tier
 * const managerTools = resolveToolPreset('manager');
 *
 * // Resolve custom CSV list
 * const customTools = resolveToolPreset('read_file, write_file, whoami');
 *
 * // Resolve Set
 * const setTools = resolveToolPreset(new Set(['read_file', 'get_current_time']));
 * ```
 */
export { resolveToolPreset };

// ============================================================================
// 0. Canonical Capability Ports
// ============================================================================

/**
 * Canonical narrow tool-execution port.
 *
 * Both members are seeded into every descriptor context by the dispatcher
 * factory: the identity member (`identityPort`, the `AgentIdentityPort` from
 * `runtime/index.ts`) and a trusted executor. The executor is the
 * construction-bound `executeTool` when the caller injected one, otherwise the
 * dispatcher's own re-entrant closure; a per-call context cannot substitute it.
 * Consumers depend on the port only and never receive the provider's full instance.
 */
export interface ToolExecutionPort {
  /**
   * Executes a canonical tool by name with a normalized argument payload.
   * Seeded by the dispatcher factory from trusted construction: the bound
   * executor when supplied, otherwise the dispatcher's re-entrant closure.
   * Per-call `executeTool` values are stripped and never consumed.
   * @param name - Canonical tool name.
   * @param args - Sanitized argument payload.
   * @param callerContext - Optional per-call context (non-authority metadata only).
   * @returns Tool execution receipt.
   */
  executeTool(name: string, args: Record<string, unknown>, callerContext?: object): Promise<object>;

  /**
   * Resolves the identity descriptor for a caller agent (identity resolver).
   * Seeded by the dispatcher factory as `identityPort`; provided by `runtime/index.ts`.
   *
   * Wave I (ticket d57cbc1): the optional trusted `scope` resolves the
   * composite `(realmId, agentId)` registration exactly, so the same literal
   * id registered in two Realms never resolves the wrong caller; an omitted
   * scope keeps the legacy unique-match rule (an id registered in more than
   * one Realm resolves `null` — fail closed).
   *
   * @param agentId - Caller agent identifier, or `null` for an anonymous dispatcher.
   * @param scope - Optional trusted resolution scope (realm-exact or bypass).
   * @returns Frozen identity projection or null when the agent is unknown.
   */
  getAgentIdentity(agentId: string | null, scope?: AgentIdentityScope): AgentIdentityProjection | null;
}

// ============================================================================
// 1. Caller Execution & Security Context
// ============================================================================

/**
 * Structural receipt returned by the host template-import path (Wave T realm
 * template registry): the committed template id and content version, whether
 * the import shadowed a shipped entry, and the effective import budget.
 *
 * The `import_realm_template` tool receipt additionally carries the
 * handler-derived `seedSlots` summary (slot counts by origin plus distinct
 * targets); that summary is computed from the parsed template in the tool
 * handler, so this port receipt stays unchanged (ticket 922fa34).
 */
export interface RealmTemplateImportView {
  /** Imported template id. */
  readonly templateId: string;
  /** Canonical content version of the imported bundle (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Import origin label (always `imported`). */
  readonly source: 'imported';
  /** Whether the import shadows a shipped (baked/host-injected) template id. */
  readonly replacesShipped: boolean;
  /** Whether the import replaced a previous runtime import of the same id. */
  readonly replacedImport: boolean;
  /** Effective total imported-template bytes after this import. */
  readonly totalImportedBytes: number;
  /** Catalog parse/review warnings (empty when none). */
  readonly warnings: readonly string[];
}

/**
 * Structural view of one effective catalog template: the authored template
 * (format v1 or v2), its bundle file bodies, and the canonical authored-form
 * content version.
 *
 * The port serves the **authored** template, never a normalized projection:
 * the publishing tools validate a format-v2 payload against a v2 template
 * directly and a legacy v1 package against the catalog's v1 read shim, so a
 * format-v2 import no longer fails the tools' format-v1 validation closed.
 */
export interface RealmEffectiveTemplateView {
  /** The effective (shipped or imported) authored template. */
  readonly template: RealmTemplate;
  /** Bundle file bodies the template references. */
  readonly files: BundleFiles;
  /** Canonical authored-form content version (`sha256:<hex>`). */
  readonly version: string;
}

/**
 * Bounded summary of one effective catalog template (M5b). Carries exactly
 * the launch-relevant metadata — never bundle bodies, realm vocabulary, or
 * host paths.
 */
export interface RealmEffectiveTemplateSummary {
  /** Effective catalog template id. */
  readonly templateId: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Effective authored-form content version (`sha256:<hex>`), or `null` when the entry cannot be versioned. */
  readonly version: string | null;
  /** Operator-facing description. */
  readonly description: string;
  /** Schema format version of the exposed (normalized) template. */
  readonly formatVersion: number;
  /** Whether the entry resolves as a launchable template (version + non-empty agent set). */
  readonly launchable: boolean;
}

/**
 * Bounded projection of one session-only pending instance payload (M5b): the
 * template binding, the canonical payload digest, and the resolution
 * timestamp — never the raw payload body.
 */
export interface PendingInstancePayloadSummary {
  /** Template id the candidate targets. */
  readonly templateId: string;
  /** Effective template version the candidate was validated against (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Canonical `payloadDigest` of the stored authored payload. */
  readonly digest: string;
  /** ISO-8601 timestamp of the resolution that produced the candidate. */
  readonly resolvedAt: string;
}

/**
 * Bounded projection of one saved hydration-payload library entry (M5b): the
 * library id/name, the template binding, the canonical digest, and the save
 * timestamp — never the raw payload body.
 */
export interface SavedInstancePayloadSummary {
  /** Stable library id (`saved_payload_<n>`). */
  readonly id: string;
  /** Operator-chosen display name. */
  readonly name: string;
  /** Template id the payload targets. */
  readonly templateId: string;
  /** Effective template version the payload validated against (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Canonical `payloadDigest` of the authored payload. */
  readonly digest: string;
  /** ISO-8601 save timestamp. */
  readonly savedAt: string;
}

/**
 * Narrow host port consumed by the Wave U publishing meta tools and the M5b
 * realm-knowledge reads.
 *
 * The composition root (the sandbox store) implements this port over its real
 * Wave T template registry and session candidate surface. The port is trusted
 * bound construction: per-call context cannot substitute it
 * (`realmPublishingPort` is a pinned context key), import mutations reuse the
 * existing registry path (never a forked one), and `previewTemplateImport`
 * runs the identical validation/cap pipeline with zero side effects so
 * `dry_run` cannot drift from the real call. The M5b read members project the
 * same registries into bounded, realm-opaque views (no bundle bodies, no raw
 * payload bodies).
 */
export interface RealmPublishingPort {
  /**
   * Imports one canonical authored transport bundle through the host registry.
   * @param canonicalPayload - Canonical authored transport JSON (`{ formatVersion: 1|2, template, files }`).
   * @returns The committed import receipt.
   */
  importTemplate(canonicalPayload: string): RealmTemplateImportView;

  /**
   * Computes the would-be import receipt (caps, shadow labels, effective
   * budget) without mutating the registry, the persisted snapshot, or trust.
   * @param canonicalPayload - Canonical authored transport JSON (`{ formatVersion: 1|2, template, files }`).
   * @returns The would-be import receipt.
   */
  previewTemplateImport(canonicalPayload: string): RealmTemplateImportView;

  /**
   * Resolves one effective catalog template by id.
   * @param templateId - Template id from the effective catalog.
   * @returns The effective template view, or `null` for an unknown id.
   */
  getEffectiveTemplateBundle(templateId: string): RealmEffectiveTemplateView | null;

  /**
   * Stores (or replaces) the session-only pending instance payload for a
   * template id. Never persisted; the launch attach path stays `{ package }`.
   * @param candidate - Frozen candidate produced by a validated submission.
   */
  storePendingInstancePayload(candidate: PendingInstancePayload): void;

  /**
   * Lists the effective catalog templates as bounded summaries (M5b): id,
   * name, effective version, description, exposed format version, and
   * launchability. Never bundle bodies, realm vocabulary, or host paths.
   *
   * @returns Frozen template summaries in effective catalog order.
   */
  listEffectiveTemplates(): readonly RealmEffectiveTemplateSummary[];

  /**
   * Lists the session-only pending instance payloads as bounded views (M5b):
   * template id, pinned version, canonical payload digest, and resolution
   * timestamp. Never the raw payload body.
   *
   * @returns Frozen pending-payload views in submission order.
   */
  listPendingInstancePayloads(): readonly PendingInstancePayloadSummary[];

  /**
   * Lists the persisted saved hydration-payload library as bounded views
   * (M5b): library id/name, template binding, canonical digest, and save
   * timestamp. Never the raw payload body.
   *
   * @returns Frozen saved-payload views in library order.
   */
  listSavedInstancePayloads(): readonly SavedInstancePayloadSummary[];
}

/**
 * Realm-level tool-selection ceiling of one realm extension attachment: `'all'`
 * or an explicit non-empty list of sanitized model-facing call names.
 */
export type RealmAdminToolSelection = 'all' | readonly string[];

/**
 * One realm-admin edit patch (M3 closed shape): display metadata
 * (`name`/`description`/`color`), one new attachment (`attach`), or one
 * attachment ceiling change (`toolSelection`). Membership, provenance,
 * creation/deletion, detach/removal, raw attachment arrays, and every
 * authority id are operator-only and never accepted here.
 */
export interface RealmAdminPatch {
  /** Replacement display name (non-empty). */
  readonly name?: string;
  /** Replacement description, or `null` to clear it. */
  readonly description?: string | null;
  /** Replacement accent color, or `null` to clear it. */
  readonly color?: string | null;
  /** Attaches one installed+connected extension with an optional ceiling. */
  readonly attach?: {
    /** Id of the installed extension to attach. */
    readonly extensionId: string;
    /** Realm tool ceiling for the new attachment; defaults to `'all'`. */
    readonly toolSelection?: RealmAdminToolSelection;
  };
  /** Replaces one existing attachment's tool ceiling. */
  readonly toolSelection?: {
    /** Id of the already attached extension. */
    readonly extensionId: string;
    /** Replacement ceiling (`'all'` or explicit live call names). */
    readonly selection: RealmAdminToolSelection;
  };
}

/** One realm-member view in the bounded realm inspection projection. */
export interface RealmAdminMemberView {
  /** Bare realm-local agent id. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Role label. */
  readonly role: string;
  /** Lifecycle state. */
  readonly state: string;
  /** Effective privilege (registry inputs; wildcard counts as privileged). */
  readonly privileged: boolean;
  /** Effective capability: canonical baked tools (never authority ids) and granted extension call names. */
  readonly tools: { readonly baked: readonly string[]; readonly extensions: readonly string[] };
  /** Bare parent/creator id, when recorded and realm-opaque. */
  readonly parent?: string | null;
  /** Realm-opaque workspace label (realm-global partitions read `global`; internal partitions are withheld). */
  readonly workspace?: string;
  /** Completed turn count. */
  readonly turns: number;
}

/** One realm attachment view carrying the ceiling and live connection state. */
export interface RealmAdminAttachmentView {
  /** Host-level extension id. */
  readonly extensionId: string;
  /** Operator-facing display name, when declared. */
  readonly displayName?: string;
  /** Extension kind (`mcp`/`pack`). */
  readonly kind: string;
  /** Stored attachment status (`active`/`conflict`/`unavailable`). */
  readonly status: 'active' | 'conflict' | 'unavailable';
  /** Realm-level tool ceiling. */
  readonly toolSelection: RealmAdminToolSelection;
  /** Live connection state for the attachment. */
  readonly live: 'connected' | 'disconnected' | 'conflict' | 'error' | 'unavailable';
  /** Extension ids this attachment currently conflicts with, when any. */
  readonly conflictWith?: readonly string[];
}

/** Realm launch provenance projection (hashes and labels only). */
export interface RealmAdminProvenanceView {
  /** Template id the realm was launched from. */
  readonly templateId: string;
  /** Template content version at launch. */
  readonly templateVersion: string;
  /** Hydration-package content digest, when attached. */
  readonly packageDigest?: string;
  /** Per-input content hashes (never raw input values). */
  readonly inputHashes: Readonly<Record<string, string>>;
  /** Seed destination paths written at launch. */
  readonly seedPaths: readonly string[];
  /** ISO-8601 launch timestamp. */
  readonly launchedAt: string;
  /** Resolved launch tool references (call name → extension id). */
  readonly resolvedTools?: Readonly<Record<string, string>>;
  /** Requested extension ids that did not resolve at launch. */
  readonly missingExtensions?: readonly string[];
}

/** Bounded realm inspection receipt. Realm-id-free: label addressing only. */
export interface RealmInspectReceipt {
  /** Always `true`; failures throw instead of returning a receipt. */
  readonly success: true;
  /** Label-only realm metadata. */
  readonly realm: {
    /** Display label. */
    readonly label: string;
    /** Epoch milliseconds when the record was created. */
    readonly createdAt: number;
    /** Active member count of the realm. */
    readonly memberCount: number;
  };
  /** Realm-exact member roster with effective capability. */
  readonly members: readonly RealmAdminMemberView[];
  /** Realm attachments with ceiling and live connection state. */
  readonly attachments: readonly RealmAdminAttachmentView[];
  /** Launch provenance, when the realm was launched from a template. */
  readonly provenance?: RealmAdminProvenanceView;
  /** Missing-extension disclosure. */
  readonly disclosure: { readonly missingExtensions: readonly string[] };
}

/** Label-only realm summary used by the update receipt's before/after pair. */
export interface RealmAdminRealmSummary {
  /** Display name. */
  readonly name: string;
  /** Description, or absent when never set. */
  readonly description?: string | null;
  /** Accent color, or absent when never set. */
  readonly color?: string | null;
  /** Attachment ids with their tool ceilings. */
  readonly attachments: readonly {
    /** Host-level extension id. */
    readonly extensionId: string;
    /** Realm-level tool ceiling. */
    readonly toolSelection: RealmAdminToolSelection;
  }[];
}

/** Bounded realm update receipt. */
export interface RealmUpdateReceipt {
  /** Always `true`; failures throw instead of returning a receipt. */
  readonly success: true;
  /** Realm display label (never the realm id). */
  readonly realm: string;
  /** Ratified field tokens touched by the patch (`attachments`/`ceiling`/`name`/`description`/`color`). */
  readonly fields: readonly string[];
  /** Always `true`; the port applies the whole patch or throws. */
  readonly applied: true;
  /** Label-only realm summary before the patch. */
  readonly before: RealmAdminRealmSummary;
  /** Label-only realm summary after the patch. */
  readonly after: RealmAdminRealmSummary;
}

/** One installed-extension view in the M4 extension listing (no transport/credential material). */
export interface ExtensionsAdminInstalledView {
  /** Host-level extension id. */
  readonly id: string;
  /** Operator-facing display name, when declared. */
  readonly displayName?: string;
  /** Extension kind (`mcp`/`pack`). */
  readonly kind: string;
  /** Installation lifecycle status. */
  readonly status: string;
  /** Live connection state: `true` when a connected, conflict-free catalog is active. */
  readonly connected: boolean;
  /** Whether the caller's realm currently attaches the extension. */
  readonly attached: boolean;
  /** Live, conflict-free catalog call names; absent when no live catalog exists. */
  readonly tools?: readonly string[];
}

/** One realm attachment view in the M4 extension listing (the M3 projection plus live call names). */
export interface ExtensionsAdminAttachmentView extends RealmAdminAttachmentView {
  /** Live, conflict-free catalog call names; absent when no live catalog exists. */
  readonly tools?: readonly string[];
}

/** Bounded extension listing receipt. Label-only realm addressing. */
export interface ExtensionsInspectReceipt {
  /** Always `true`; failures throw instead of returning a receipt. */
  readonly success: true;
  /** Realm display label (never the realm id). */
  readonly realm: string;
  /** Every host-level install record with live connection and attachment state. */
  readonly installed: readonly ExtensionsAdminInstalledView[];
  /** The caller realm's attachments with ceiling and live connection state. */
  readonly attachments: readonly ExtensionsAdminAttachmentView[];
}

/** Bounded realm-wide extension attach receipt. */
export interface ExtensionAttachReceipt {
  /** Always `true`; failures throw instead of returning a receipt. */
  readonly success: true;
  /** Realm display label (never the realm id). */
  readonly realm: string;
  /** Host-level id of the targeted extension. */
  readonly extensionId: string;
  /** Effective realm-level tool ceiling of the attachment. */
  readonly toolSelection: RealmAdminToolSelection;
  /** `true` when this call added the attachment; `false` on the idempotent path. */
  readonly applied: boolean;
  /** `true` when the realm already attached the extension (no mutation, no audit). */
  readonly alreadyAttached: boolean;
}

/**
 * Narrow host port consumed by the M3 realm-admin and M4 extension-admin meta
 * tools.
 *
 * The composition root (the sandbox store) implements this port over its real
 * `realmRegistry` + `extensionRegistry` live state, runtime rosters, and the
 * existing attach/ceiling + safe-state sweep internals. The port is trusted
 * bound construction: per-call context cannot substitute it (`realmAdminPort`
 * is a pinned context key), and the *authority verdict stays dispatcher-side*
 * from the caller's frozen descriptor — the port only re-reads the registry-side
 * grant scope (never a caller claim) and fails closed when the `actorRef`
 * carries no matching active grant record, so a direct store call can never
 * execute under the operator principal without an actor record (R6).
 *
 * Every target-resolution failure (missing/unknown actor record, missing
 * grant, unknown/ambiguous/out-of-scope label) throws one uniform static
 * `PERMISSION_DENIED` per operation; malformed patches throw
 * `INVALID_ARGUMENTS`. Receipts and audits carry display labels and bare ids
 * only — never realm ids, `realm:` paths, transport URLs, credential ids, or
 * tokens.
 */
export interface RealmAdminPort {
  /**
   * Inspects one realm under the caller's exact scoped `@realm:inspect` grant.
   *
   * @param input - Trusted input: the dispatcher-pinned actor reference and the optional realm display label (`null` = own realm).
   * @returns The bounded realm projection.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for every resolution failure.
   */
  inspectRealm(input: { actorRef: string | null; realmLabel: string | null }): RealmInspectReceipt;

  /**
   * Updates one realm under the caller's exact scoped `@realm:edit` grant.
   *
   * @param input - Trusted input: the dispatcher-pinned actor reference, the optional realm display label (`null` = own realm), and the closed edit patch.
   * @returns The applied update receipt with before/after summaries.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for resolution/bound failures, `'INVALID_ARGUMENTS'` for malformed patches or live-catalog violations.
   */
  updateRealm(input: {
    actorRef: string | null;
    realmLabel: string | null;
    patch: RealmAdminPatch;
  }): RealmUpdateReceipt;

  /**
   * Lists the installed extensions and the caller realm's attachments under
   * the caller's exact scoped `@extensions:authority` grant: install metadata
   * (id/display name/kind/status), live connection state, and the available
   * call names of connected conflict-free catalogs. Never transport URLs,
   * credential ids, or realm ids.
   *
   * @param input - Trusted input: the dispatcher-pinned actor reference (the caller's own realm is the only target).
   * @returns The bounded extension listing.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for every resolution failure.
   */
  listExtensions(input: { actorRef: string | null }): ExtensionsInspectReceipt;

  /**
   * Attaches one installed+connected extension to the caller's realm under
   * the caller's exact scoped `@extensions:authority` grant: the realm-wide
   * uniform set gains the attachment through the shared store path, the
   * member safe-state sweep follows, and a repeated attach is an idempotent
   * no-op (no mutation, no duplicate audit). Never installs, dials,
   * disconnects, detaches, or touches credentials.
   *
   * @param input - Trusted input: the dispatcher-pinned actor reference, the host-level extension id, and the optional realm tool ceiling.
   * @returns The bounded attach receipt (`applied:false` on the idempotent path).
   * @throws `Error` - Code `'PERMISSION_DENIED'` for resolution failures, `'INVALID_ARGUMENTS'` for malformed ids/selections or gate failures.
   */
  attachExtension(input: {
    actorRef: string | null;
    extensionId: string;
    toolSelection?: RealmAdminToolSelection;
  }): ExtensionAttachReceipt;
}

/**
 * One resolved provider-tool binding returned by
 * {@link ExtensionToolProviderPort.resolveTool}.
 *
 * The binding carries the sanitized model-facing call name, the extension id
 * that provides the tool, and the wire tool name exactly as the server
 * advertised it. The store's live implementation always supplies the wire
 * name; a malformed binding is refused fail-closed by the dispatcher, so a
 * catalog-less or disconnected name stays `TOOL_NOT_FOUND` and never routes
 * into the extension branch.
 */
export interface ExtensionToolBinding {
  /** Sanitized model-facing call name; equals the requested canonical name. */
  readonly callName: string;
  /** Extension id that provides the tool (secret-free). */
  readonly extensionId: string;
  /** Wire tool name exactly as the server advertised it. */
  readonly serverToolName: string;
}

/**
 * Optional provider-registry port consumed by the dispatcher's extension
 * authorization branch (extension wave).
 *
 * The port is the sanctioned DI seam for the live provider registry: the
 * composition root supplies it once connections/catalogs exist, so a call
 * name the port resolves routes through the extension execution branch. When
 * absent, an extension call name is simply unknown and fails `TOOL_NOT_FOUND`
 * exactly as before. When present, a name the port resolves is authorized
 * **only** by exact membership on the caller's frozen
 * `AuthorityDescriptor.extensions` set: the wildcard `'*'`, `privileged`,
 * subagent-management selectors, alias-written entries, and the legacy
 * allowlist channels never authorize an extension call, anonymous and
 * descriptor-less callers deny, engine-internal principals deny, and any
 * throw while probing the descriptor fails closed.
 *
 * The port is pinned construction input: a per-call value is stripped.
 */
export interface ExtensionToolProviderPort {
  /**
   * Resolves one sanitized call name against the live provider registry.
   *
   * @param callName - Canonical sanitized model-facing call name.
   * @returns The frozen provider binding, or `null` when the name is not an
   *   extension tool (fail closed: `null` never authorizes).
   */
  resolveTool(callName: string): ExtensionToolBinding | null;

  /**
   * Resolves the frozen synthesized descriptor for one sanitized call name
   * (optional; a missing or non-function member keeps the fail-closed
   * `EXECUTION_FAILED` outcome for an authorized call).
   *
   * @param callName - Canonical sanitized model-facing call name.
   * @returns The frozen descriptor, or `null` when the name carries no
   *   executable descriptor (refused projection, disconnected catalog,
   *   conflict).
   */
  resolveDescriptor?(callName: string): ExtensionToolDescriptor | null;
}

/**
 * Caller Execution & Security Context injected into tool dispatchers and descriptor handlers.
 * Encapsulates the calling agent's identity, role, privilege tier, workspace isolation boundary,
 * tool capability allowlist, and injected Layer 0 substrate engine instances.
 *
 * @example
 * ```typescript
 * import type { ExecutionContext } from './toolDefinitions/index.ts';
 *
 * const context: ExecutionContext = {
 *   agentId: 'agent_writer_01',
 *   callerRole: 'collaborator',
 *   isAdmin: false,
 *   isPrivileged: false,
 *   workspaceId: 'agent_writer_01',
 *   allowedTools: ['read_file', 'write_file', 'send_message', 'whoami'],
 *   virtualFs: virtualFsInstance,
 *   messagingBus: messagingBusInstance,
 *   worldClock: worldClockInstance
 * };
 * ```
 */
export interface ExecutionContext {
  /**
   * Unique ID of the calling agent executing the turn (e.g. 'agent_writer_01').
   * `null` when the dispatcher is anonymous (no bound identity subject).
   * Trust boundary: pinned from bound construction. A per-call value is
   * stripped and never selects the identity projection or authority.
   */
  readonly agentId?: string | null;

  /**
   * Canonical caller agent identifier (alias of `agentId`).
   * `null` when the dispatcher is anonymous (no bound identity subject).
   * Trust boundary: pinned from bound construction. A per-call value is
   * stripped and never selects the identity projection or authority.
   */
  readonly callerAgentId?: string | null;

  /**
   * Caller role classification (e.g. 'admin', 'director', 'collaborator', 'critic').
   * @deprecated Metadata only: roles never grant authority. Per-call
   * `callerRole`/`role` values are stripped before dispatch; authority derives
   * solely from the identity projection's frozen `AuthorityDescriptor`.
   */
  readonly callerRole?: string;

  /**
   * Privilege elevation flag: grants superuser bypass over tool capability restrictions.
   * @deprecated Caller-asserted authority. Ignored on per-call `callerContext`
   * (stripped before dispatch); honored only when bound at construction and
   * only for callers whose identity projection carries no `AuthorityDescriptor`
   * (a present descriptor authorizes or denies alone) — this boolean remains
   * the legacy fallback channel.
   */
  readonly isAdmin?: boolean;

  /**
   * Privilege elevation flag (alias of `isAdmin`).
   * @deprecated Caller-asserted authority. Ignored on per-call `callerContext`
   * (stripped before dispatch); honored only when bound at construction and
   * only for callers whose identity projection carries no `AuthorityDescriptor`
   * (a present descriptor authorizes or denies alone) — this boolean remains
   * the legacy fallback channel.
   */
  readonly isPrivileged?: boolean;

  /**
   * Privilege elevation flag in legacy agent configurations.
   * @deprecated Caller-asserted authority. Ignored on per-call `callerContext`
   * (stripped before dispatch); honored only when bound at construction and
   * only for callers whose identity projection carries no `AuthorityDescriptor`
   * (a present descriptor authorizes or denies alone) — this boolean remains
   * the legacy fallback channel.
   */
  readonly privileged?: boolean;

  /**
   * Active workspace isolation boundary (defaults to `agentId` or 'global').
   *
   * Trust boundary: pinned from bound construction. A per-call
   * `workspaceId`/`workspace_id` (or the reserved Realm/tenant scope keys) is
   * stripped before dispatch and can never select the workspace a handler or
   * substrate operation resolves (ticket c7a3049).
   */
  readonly workspaceId?: string;

  /**
   * Allowed tools explicit whitelist, preset name, or resolved capability preset
   * array/Set. Preset-name strings (e.g. `'collaborator'`, `'readonly'`) and
   * comma-separated lists (e.g. `'read_file, write_file'`) resolve through
   * `resolveToolPreset`. When unset for an unprivileged caller, non-innate tools
   * fail closed with `PERMISSION_DENIED`.
   *
   * Trust boundary: the trusted value is the construction-bound option or the
   * identity-port projection. A per-call `callerContext.allowedTools` is ignored
   * and can never widen the trusted allowlist. When the identity projection
   * carries a frozen `AuthorityDescriptor`, the descriptor decides alone
   * (ticket 76fb539) and this allowlist is not consulted for authorization.
   *
   * `null` means no trusted allowlist was resolved; the authorization gate
   * treats it as unset and fails closed for non-innate tools.
   */
  readonly allowedTools?: string | readonly string[] | ReadonlySet<string> | null;

  /**
   * Injected Layer 0 Virtual Filesystem instance. Opaque to this contract:
   * descriptor handlers narrow the capability they are configured to consume.
   */
  readonly virtualFs?: unknown;

  /**
   * Injected Layer 0 Messaging Bus instance. Opaque to this contract:
   * descriptor handlers narrow the capability they are configured to consume.
   */
  readonly messagingBus?: unknown;

  /**
   * Injected Layer 0 World Clock & Timeline Events instance. Opaque to this
   * contract: descriptor handlers narrow the capability they are configured to
   * consume.
   */
  readonly worldClock?: unknown;

  /**
   * Trusted bound turn-recursion depth capability, seeded by the turn
   * execution engine from the invocation options at dispatcher construction
   * and consumed by `invoke_agent` to feed the invocation engine's recursion
   * guard. Trust boundary: pinned from bound construction. A per-call `depth`
   * (or `currentDepth`) value is stripped before dispatch and never reaches a
   * handler (MOD-21 A2, ticket 63026f5).
   */
  readonly currentDepth?: number;

  /**
   * Injected Layer 0 Synchronous Invocation Engine instance. Opaque to this
   * contract: descriptor handlers narrow the capability they are configured to
   * consume.
   */
  readonly invocationEngine?: unknown;

  /**
   * Injected Layer 0 Trigger Dispatcher instance. Opaque to this contract:
   * descriptor handlers narrow the capability they are configured to consume.
   */
  readonly triggerDispatcher?: unknown;

  /**
   * Injected Layer 0 Agent Lifecycle Manager instance. Opaque to this contract:
   * descriptor handlers narrow the capability they are configured to consume.
   */
  readonly lifecycleManager?: unknown;

  /**
   * Injected Layer 0 History & Turn Rollback Manager instance. Opaque to this
   * contract: descriptor handlers narrow the capability they are configured to
   * consume.
   */
  readonly historyManager?: unknown;

  /**
   * Injected Tool Registry / Reflection Subsystem instance. Opaque to this
   * contract: descriptor handlers narrow the capability they are configured to
   * consume.
   */
  readonly toolRegistry?: unknown;

  /**
   * Injected Wave U host publishing port consumed by the realm publishing meta
   * tools (canonical template import, effective-catalog resolution, and the
   * session candidate surface). Trust boundary: pinned from bound construction;
   * a per-call value is stripped and can never substitute the host port.
   */
  readonly realmPublishingPort?: RealmPublishingPort;

  /**
   * Injected M3 realm-admin host port consumed by the `inspect_realm` and
   * `update_realm` authority meta tools (realm roster/attachments/ceiling/
   * provenance reads and the bounded realm edit surface). Trust boundary:
   * pinned from bound construction; a per-call value is stripped and can never
   * substitute the host port.
   */
  readonly realmAdminPort?: RealmAdminPort;

  /**
   * Optional extension provider-registry port (extension wave): when a live
   * provider registry is bound, a call name it resolves routes through the
   * extension authorization branch — exact membership on the caller's frozen
   * `AuthorityDescriptor.extensions` set, no wildcard/privileged/
   * selector/alias/legacy fallback. Trust boundary: pinned from bound
   * construction; a per-call value is stripped and can never substitute the
   * host port.
   */
  readonly extensionToolProvider?: ExtensionToolProviderPort;

  /**
   * Optional extension execution port (extension wave) seeded into every
   * descriptor context under the pinned `extensionExecutionPort` key. The
   * synthesized extension tool handlers read it from their context and
   * delegate the actual server call to it; the dispatcher's extension branch
   * checks it is bound before dispatching. Trust boundary: pinned from bound
   * construction; a per-call value is stripped and can never substitute the
   * host port.
   */
  readonly extensionExecutionPort?: ExtensionExecutionPort;

  /**
   * Narrow lifecycle capability port consumed by scheduler,
   * invocation, and lifecycle descriptors. Replaces private-subsystem reaches.
   */
  readonly lifecyclePort?: LifecyclePort;

  /**
   * Narrow agent identity resolver seeded into descriptor contexts
   * and consumed by the dispatcher's privilege gate through its `getAgentIdentity`
   * member. Replaces full `Agent` instance handoffs.
   */
  readonly identityPort?: AgentIdentityPort;

  /**
   * Trusted executor seeded into every descriptor context by the dispatcher
   * factory: the construction-bound `executeTool` when one was injected,
   * otherwise the dispatcher's own re-entrant closure. A per-call `executeTool`
   * value is stripped and never consumed.
   */
  readonly executeTool?: (
    name: string,
    args: Record<string, unknown>,
    callerContext?: ExecutionContext
  ) => Promise<unknown>;

  /**
   * Injected Turn Execution Engine instance. Opaque to this contract: descriptor
   * handlers narrow the capability they are configured to consume.
   */
  readonly turnExecutionEngine?: unknown;

  /**
   * Legacy Sandbox Runtime instance accepted from direct callers: the factory derives
   * `lifecyclePort`/`identityPort` from it once and strips it before any descriptor
   * handler sees the context (it is never forwarded).
   */
  readonly runtime?: AgentRuntime;

  /** Flexible extension properties for domain-specific runtime contexts. */
  readonly [key: string]: unknown;
}

/**
 * Options used when instantiating a Sandbox Tool Dispatcher.
 *
 * These bound options are trusted construction input: their privilege fields,
 * `allowedTools`, and identity subject (`agentId`/`callerAgentId`, resolved
 * realm-exactly when a `realmId` scope is bound — Wave I, ticket d57cbc1) are
 * the only authority source besides the injected identity port, and their
 * capability fields (`virtualFs`, `messagingBus`, `worldClock`, `executeTool`,
 * ...) are the only capability source. Per-call `callerContext` is merged for
 * non-authority metadata only: its privilege flags, `allowedTools`, identity
 * keys (including `callerKey`), and capability keys are stripped and can never
 * override the construction-bound values. An anonymous dispatcher has no
 * identity subject:
 * non-innate tools authorize only through a bound `allowedTools` allowlist (or
 * the identity port), and identity-bearing substrate operations stay anonymous
 * — payload identity is never promoted (VFS operations default-deny, mailbox
 * reads return empty, `send_message` attributes the fixed `'anonymous'` label,
 * and `inline_file_in_message` requires a bound caller).
 *
 * @example
 * ```typescript
 * import { createSandboxToolDispatcher } from './toolDefinitions/index.ts';
 *
 * const dispatcher = createSandboxToolDispatcher({
 *   virtualFs: myVirtualFs,
 *   messagingBus: myMessagingBus,
 *   worldClock: myWorldClock
 * });
 * ```
 */
export type SandboxDispatcherOptions = ExecutionContext;

// ============================================================================
// 2. Tool Call Ingestion & Receipt Types
// ============================================================================

/**
 * Raw tool call payload emitted by Large Language Models (conforming to OpenAI/DeepSeek schema).
 *
 * @example
 * ```typescript
 * const call: ToolCall = {
 *   id: 'call_abc123',
 *   name: 'read_file',
 *   arguments: { file_path: '/lore/world_rules.md', limit: 500 }
 * };
 * ```
 */
export interface ToolCall {
  /** Unique identifier for the LLM tool call (e.g. 'call_99x88y77z'). */
  readonly id?: string;

  /** Raw tool name requested by the LLM (canonical name or hallucinated alias like 'readFile', 'fs_read_file'). */
  readonly name?: string;

  /** Raw arguments payload: pre-parsed JavaScript object or raw stringified JSON. */
  readonly arguments?: Record<string, unknown> | string;

  /** Alternative parameters payload alias (`args`). */
  readonly args?: Record<string, unknown> | string;

  /** OpenAI nested function calling container object. */
  readonly function?: {
    /** Function name. */
    readonly name: string;
    /** Raw arguments payload: object or raw JSON string. */
    readonly arguments?: Record<string, unknown> | string;
  };
}

/**
 * Receipt returned on successful tool execution.
 *
 * @example
 * ```typescript
 * const successReceipt: ToolResultSuccess = {
 *   success: true,
 *   content: '# World Rules\nMagic is rare...',
 *   size: 28
 * };
 * ```
 */
export interface ToolResultSuccess {
  /** Explicit success discriminator (always true). */
  readonly success: true;
  /** Subsystem output properties. */
  readonly [key: string]: unknown;
}

/**
 * Standardized error receipt returned on tool execution failure.
 * Universal error shielding guarantees that exceptions are caught and returned in this format.
 *
 * @example
 * ```typescript
 * const failureReceipt: ToolResultFailure = {
 *   success: false,
 *   error: "Tool 'launch_missile' is not recognized in the tool registry.",
 *   code: 'TOOL_NOT_FOUND'
 * };
 * ```
 */
export interface ToolResultFailure {
  /** Explicit failure discriminator (always false). */
  readonly success: false;
  /** Human-readable error explanation for LLM turn reflection and debugging. */
  readonly error: string;
  /**
   * Standardized machine-readable error code. Always a declared
   * `TOOL_SYSTEM_ERROR_CODES` member: downstream subsystem codes outside the
   * dictionary (e.g. `FILE_NOT_FOUND`, `TIMEOUT`) and missing codes are
   * normalized by the dispatcher to `EXECUTION_FAILED`.
   */
  readonly code: ToolSystemErrorCode;
  /** Optional diagnostic or validation details. */
  readonly details?: unknown;
}

/**
 * Union type representing the receipt returned by all tool executions.
 *
 * @example
 * ```typescript
 * const result: ToolResult = await dispatcher({ name: 'read_file', arguments: { file_path: '/lore/rules.md' } });
 * if (result.success) {
 *   console.log('File content:', result.content);
 * } else {
 *   console.error(`Tool error [${result.code}]: ${result.error}`);
 * }
 * ```
 */
export type ToolResult = ToolResultSuccess | ToolResultFailure;

/**
 * Callable tool dispatcher instance returned by {@link createSandboxToolDispatcher}.
 *
 * Dispatches raw tool calls through canonical name resolution, security capability checks,
 * parameter sanitization, and thin descriptor-handler delegation wrapped in universal error shielding.
 *
 * @example
 * ```typescript
 * // Standard direct invocation
 * const result = await dispatcher(
 *   { name: 'read_file', arguments: { file_path: '/lore/history.md' } },
 *   { agentId: 'agent_writer' }
 * );
 *
 * // OpenAI tool message wrapper (`whoami` requires a bound `lifecyclePort`; without
 * // one the shielded receipt is `{ success: false, code: "EXECUTION_FAILED" }`)
 * const toolMessage = await dispatcher.executeToolCall({
 *   id: 'call_123',
 *   function: { name: 'whoami', arguments: '{}' }
 * });
 * // => { role: 'tool', tool_call_id: 'call_123', content: '{"success":true,"id":"agent_writer","role":"collaborator",...}' }
 *
 * // Direct tool execution helper
 * const out = await dispatcher.executeTool('get_current_time', {});
 * ```
 */
export interface SandboxToolDispatcher {
  /**
   * Dispatches a tool call with optional per-call caller execution context overrides.
   *
   * @param toolCall - Raw tool call object (OpenAI or direct format)
   * @param callerContext - Optional execution context overrides for this invocation
   * @returns Result receipt object with `success: true` or `success: false`
   */
  (toolCall: ToolCall, callerContext?: ExecutionContext): Promise<ToolResult>;

  /**
   * Dispatches an OpenAI function call format tool call and formats the response as an OpenAI tool message.
   *
   * @param toolCallObj - OpenAI tool call object `{ id, function: { name, arguments } }`
   * @returns OpenAI tool message
   */
  executeToolCall(toolCallObj: ToolCall): Promise<{
    readonly role: 'tool';
    readonly tool_call_id: string;
    readonly content: string;
  }>;

  /**
   * Convenience helper to execute a tool directly by name and argument object.
   *
   * @param name - Tool name (canonical or alias)
   * @param rawArgs - Arguments payload
   * @param callerCtx - Optional caller execution context
   * @returns Result receipt
   */
  executeTool(
    name: string,
    rawArgs?: Record<string, unknown>,
    callerCtx?: ExecutionContext
  ): Promise<ToolResult>;

  /**
   * Canonical name resolver exposed as a narrow dispatcher capability. Consumers use the
   * same normalization authority as the dispatcher itself to avoid alias drift.
   *
   * @param name - Raw tool name or aliases (e.g. 'virtualFs_readFile', 'worldClock_getTime').
   * @returns Canonical snake_case tool name or null when the name is unknown.
   */
  canonicalizeToolName(name: string): string | null;
}

// ============================================================================
// 3. Schema Generation & Descriptor Types
// ============================================================================

/**
 * Standard Draft-07 JSON Schema representation for OpenAI/DeepSeek function calling parameters.
 *
 * @example
 * ```typescript
 * const schema: JsonSchemaDraft07 = {
 *   type: 'object',
 *   properties: {
 *     file_path: { type: 'string', description: 'Virtual path to the target file.' },
 *     limit: { type: 'integer', description: 'Maximum characters to read.' }
 *   },
 *   required: ['file_path'],
 *   additionalProperties: false
 * };
 * ```
 */
export interface JsonSchemaDraft07 {
  /** Must always be 'object'. */
  readonly type: 'object';

  /**
   * Optional Draft-07 root-level exactly-one-of constraint over `required`
   * alternatives (for example `write_file`'s inline-content vs `source_file`
   * form, or the publishing tools' `manifest` vs `manifest_file` form).
   * Preserved by every model-facing schema projection so the emitted call
   * schema agrees with `describe_tool` (ticket d872723 F7).
   */
  readonly oneOf?: readonly JsonSchemaOneOfAlternative[];

  /** Parameter definitions key-value map. */
  readonly properties: Record<string, {
    /** JSON Schema data type ('string', 'integer', 'number', 'boolean', 'array', 'object', 'null') or a union array of types. */
    readonly type: string | readonly string[];
    /** Human-readable parameter description for LLMs. */
    readonly description: string;
    /** Optional enum allowed values. */
    readonly enum?: readonly string[];
    /** Optional items schema for array types. */
    readonly items?: Record<string, unknown>;
    /** Additional JSON Schema properties. */
    readonly [key: string]: unknown;
  }>;

  /** List of required parameter names. */
  readonly required?: readonly string[];

  /**
   * Extra-parameter policy keyword. `false` for the closed baked/publishing
   * descriptors; `true` for descriptors whose handler accepts the key set on
   * the wire and ignores undocumented keys with an explicit warning (the
   * `spawn_agent` accept-and-warn boundary) — the emitted keyword always
   * matches the runtime behavior.
   */
  readonly additionalProperties: boolean;
}

/**
 * One root-level `oneOf` alternative of a {@link JsonSchemaDraft07} object
 * schema: the property names this alternative requires.
 */
export interface JsonSchemaOneOfAlternative {
  /** Property names required by this alternative. */
  readonly required: readonly string[];
}

/**
 * OpenAI function specification object.
 */
export interface OpenAIFunctionObject {
  /** Canonical tool name (e.g. 'read_file'). */
  readonly name: string;
  /** Comprehensive tool description and instructions for the LLM. */
  readonly description: string;
  /** Draft-07 JSON Schema defining parameter constraints. */
  readonly parameters: JsonSchemaDraft07;
}

/**
 * OpenAI/DeepSeek tool definition container.
 *
 * @example
 * ```typescript
 * const toolDef: OpenAIToolDefinition = {
 *   type: 'function',
 *   function: {
 *     name: 'read_file',
 *     description: 'Reads content from a virtual file...',
 *     parameters: { ... }
 *   }
 * };
 * ```
 */
export interface OpenAIToolDefinition {
  /** Tool type discriminator (always 'function'). */
  readonly type: 'function';
  /** Function definition payload. */
  readonly function: OpenAIFunctionObject;
}

/**
 * Options configuring tool schema generation.
 *
 * @example
 * ```typescript
 * const schemas = getSandboxToolsSchema('collaborator', { includeReflection: true });
 * ```
 */
export interface SchemaGenerationOptions {
  /** Whether to include system reflection tools (`describe_tool`). Defaults to true. */
  readonly includeReflection?: boolean;
}

/**
 * Parameter sanitizer function signature.
 * Normalizes raw/hallucinated parameters to canonical keys, strips prototype tampering, and applies domain defaults.
 *
 * @param rawArgs - Incoming raw arguments (pre-parsed object or raw JSON string)
 * @returns Sanitized canonical parameter object
 */
export type ParamSanitizerFn = (rawArgs?: unknown) => Record<string, unknown>;

/**
 * Subsystem delegation handler signature for a tool descriptor.
 * Handlers guard the required capability, delegate to the injected substrate or narrow port,
 * may branch on sanitized parameters and assemble caller-scope/option objects, and may shape
 * a failure receipt; the dispatcher normalizes whatever they return into a `ToolResult`.
 *
 * @param params - Sanitized canonical tool parameters
 * @param context - Injected execution and security context
 * @returns Downstream engine result
 */
export type ToolHandlerFn = (
  params: Record<string, unknown>,
  context: ExecutionContext
) => unknown;

/**
 * Canonical tool descriptor contract implemented by every sandbox tool.
 *
 * @example
 * ```typescript
 * const descriptor: ToolDescriptor = {
 *   name: 'read_file',
 *   description: 'Reads text content from a virtual file in storage.',
 *   schema: readFileSchema,
 *   paramAliasMap: { filePath: 'file_path', path: 'file_path' },
 *   sanitize: createParamSanitizer(paramAliasMap, { offset: 0, limit: 100000 }),
 *   handler: async (params, context) => context.virtualFs.readFile(params, context)
 * };
 * ```
 */
export interface ToolDescriptor {
  /** Canonical `snake_case` tool name. */
  readonly name: SandboxToolName;
  /** Full human-readable tool description provided to the LLM. */
  readonly description: string;
  /** Draft-07 parameter schema definition. */
  readonly schema: JsonSchemaDraft07;
  /** Mapping of parameter aliases/hallucinations to canonical parameter names. */
  readonly paramAliasMap: Readonly<Record<string, string>>;
  /** Table-driven parameter sanitizer instance. */
  readonly sanitize: ParamSanitizerFn;
  /** Delegation handler that routes to the injected capability and returns its receipt. */
  readonly handler: ToolHandlerFn;
  /**
   * Optional model-facing remedy appended to this tool's authorization denial
   * (e.g. which preset/authority grants it). The remedy restates the published
   * description — it never reveals registry state — so a denied caller learns
   * the requirement without an existence/authority oracle.
   */
  readonly denialHint?: string;
}

// ============================================================================
// 4. Public Functions
// ============================================================================

/** Declared failure-code vocabulary; every emitted failure receipt must use a member. */
const TOOL_RESULT_ERROR_CODES: ReadonlySet<string> = new Set<string>(Object.values(TOOL_SYSTEM_ERROR_CODES));

/**
 * Typed view of the frozen null-prototype `TOOL_REGISTRY` table built by
 * `tools/descriptors` from the frozen descriptor catalog: canonical
 * `snake_case` name → descriptor. The invariant covers exactly this shape;
 * the view gives the O(1) lookup its declared contract type at the boundary.
 */
const TOOL_REGISTRY_VIEW: Readonly<Record<string, ToolDescriptor>> = TOOL_REGISTRY;

/**
 * Typed view of the frozen authority meta-tool registry (M1 generalization of
 * the Wave U publishing registry). These tools are deliberately outside
 * `TOOL_REGISTRY`; they route through the same dispatcher pipeline but
 * authorize only against the caller's exact authority descriptor (never the
 * wildcard/legacy channels).
 */
const AUTHORITY_TOOL_REGISTRY_VIEW: Readonly<Record<string, AuthorityToolDescriptor>> = AUTHORITY_TOOL_REGISTRY;

/**
 * Realm/workspace/tenant scope vocabulary pinned at dispatcher construction
 * and stripped from per-call `callerContext` (ticket c7a3049). This is the
 * complete set of scope-shaped context keys the sandbox recognizes: a caller
 * claim for any of them must never reach a handler or a substrate operation,
 * so Realm/workspace isolation cannot be widened from tool input.
 *
 * `workspaceId` is consumed from context by the messaging bus
 * (`inlineFileInMessage` scopes its VirtualFS read) and `workspace_id` is its
 * snake_case wire alias; the Realm/tenant keys are reserved for the Realm
 * program's per-Realm partition work and are pinned ahead of that plumbing so
 * no future consumer can accidentally read them from caller data.
 */
const SCOPE_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'workspaceId', 'workspace_id',
  'realmId', 'realm_id',
  'tenantId', 'tenant_id',
  'scope'
]);

/**
 * Per-call context keys that can never originate from the untrusted caller:
 * authority claims, the identity subject, the trusted canonical identity key
 * (`callerKey`), the capability allowlist, the per-call depth alias, the
 * Realm/workspace/tenant scope vocabulary, and every injected
 * capability/substrate. Values for these keys are taken from trusted bound
 * construction only; a per-call value is dropped, so a caller can neither
 * select whose authority is consulted, claim a canonical identity key, reset
 * the recursion guard, claim a Realm/workspace/tenant scope, nor substitute
 * the executor/substrate a handler delegates to (MOD-21 W8-A/A2, tickets
 * a1ce597/dd73ca7/4074766/63026f5; Realm A0-2, ticket c7a3049; Wave I,
 * ticket d57cbc1 for the `callerKey` channel).
 */
const PINNED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  // Authority claims + allowlist (W1/W4: 4074766/172824e/a9db33c)
  'isAdmin', 'isPrivileged', 'privileged',
  'callerRole', 'role',
  'principal', 'authority', 'allowedTools',
  // Identity subject + trusted canonical identity key (W8-A: a1ce597; Wave I: d57cbc1)
  'agentId', 'callerAgentId', 'callerContext',
  'callerKey', 'caller_key',
  // Realm/workspace/tenant scope (Realm A0-2: c7a3049)
  ...SCOPE_CONTEXT_KEYS,
  // Injected capabilities/substrates (W8-A: dd73ca7)
  'virtualFs', 'messagingBus', 'worldClock', 'signal', 'currentDepth',
  // Per-call depth alias (63026f5): handlers read the bound `currentDepth`
  // capability only; a caller-supplied `depth` is dropped like every other
  // depth-shaped key so it can never reach a handler or the invocation engine.
  'depth',
  'executeTool', 'toolRegistry',
  'realmPublishingPort', 'realmAdminPort',
  // Extension authorization plumbing (extension wave): the provider-registry
  // port, the pinned execution port, and any extension selector are pinned
  // construction/registry state; a per-call value is dropped so it can neither
  // route a call into the branch, substitute the executor, nor present itself
  // as an extension grant.
  'extensionToolProvider', 'extensionExecutionPort', 'extensionTools',
  'lifecyclePort', 'identityPort',
  'invocationEngine', 'triggerDispatcher', 'lifecycleManager', 'historyManager',
  'turnExecutionEngine', 'runtime'
]);

/**
 * Projects one frozen descriptor schema onto the model-facing wire schema.
 *
 * Root keywords are projected explicitly so every declared constraint reaches
 * the provider: `type`, a fresh `properties` copy (the zero-LLM-schema-
 * pollution boundary), a fresh `required` array, the declared root-level
 * `oneOf` alternatives when present (ticket d872723 F7), and the
 * `additionalProperties` policy. The input schema is never mutated.
 *
 * @param schema - Frozen descriptor schema
 * @returns A fresh wire-schema object carrying the declared root constraints
 */
function projectParameterSchema(schema: JsonSchemaDraft07): JsonSchemaDraft07 {
  return {
    type: schema.type,
    properties: { ...schema.properties },
    required: Array.isArray(schema.required) ? [...schema.required] : [],
    ...(Array.isArray(schema.oneOf)
      ? { oneOf: schema.oneOf.map((clause) => ({ required: [...clause.required] })) }
      : {}),
    additionalProperties: Boolean(schema.additionalProperties)
  };
}

/**
 * Generates an array of OpenAI/DeepSeek function calling schemas dynamically filtered by
 * an agent's capability preset or allowed tools list.
 *
 * Enforces the zero-LLM-schema-pollution invariant declared in this module header. Parameters representing
 * infrastructure configurations (`model`, `temperature`, `maxTurns`, `depth`, etc.) are
 * strictly omitted from the output schemas.
 *
 * @param allowedTools - Tool preset name, tool array, Set, or null for all tools
 * @param options - Schema generation options (e.g. `includeReflection: false`)
 * @returns Array of OpenAI Draft-07 tool definition objects
 *
 * @example
 * ```typescript
 * import { getSandboxToolsSchema } from './toolDefinitions/index.ts';
 *
 * // Generate schemas for a collaborator agent
 * const collaboratorSchemas = getSandboxToolsSchema('collaborator');
 *
 * // Generate schemas with reflection tools omitted
 * const restrictedSchemas = getSandboxToolsSchema(['read_file', 'query_json'], {
 *   includeReflection: false
 * });
 * ```
 */
export function getSandboxToolsSchema(
  allowedTools: string | readonly string[] | ReadonlySet<string> | null = null,
  options: SchemaGenerationOptions = {}
): OpenAIToolDefinition[] {
  let targetDescriptors: readonly ToolDescriptor[] = ALL_TOOL_DESCRIPTORS;

  if (allowedTools !== null && allowedTools !== undefined) {
    const resolved = resolveToolPreset(allowedTools);
    if (!resolved.includes('*')) {
      const allowedSet = new Set<string>();
      for (const item of resolved) {
        if (typeof item !== 'string') continue;
        const canon = getCanonToolName(item);
        if (!canon) continue;
        const expansion = expandRetiredToolSelector(canon);
        if (expansion) {
          for (const tool of expansion) allowedSet.add(tool);
          continue;
        }
        allowedSet.add(canon);
      }
      targetDescriptors = ALL_TOOL_DESCRIPTORS.filter(d => allowedSet.has(d.name));
    }
  }

  if (options && options.includeReflection === false) {
    targetDescriptors = targetDescriptors.filter(d => d.name !== SANDBOX_TOOLS.DESCRIBE_TOOL);
  }

  return targetDescriptors.map((descriptor): OpenAIToolDefinition => ({
    type: 'function',
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: projectParameterSchema(descriptor.schema)
    }
  }));
}

/**
 * Factory constructing an error-shielded, O(1) table-driven tool dispatcher bound to
 * the provided runtime options and substrate primitives.
 *
 * The resulting dispatcher:
 * 1. Identifies canonical tool name via O(1) alias table lookup.
 * 2. Enforces security capability authorization from trusted construction only: when the
 *    identity projection carries a frozen `AuthorityDescriptor` it authorizes alone (a
 *    matching grant is required, otherwise deny); descriptor-less callers use the bound
 *    `allowedTools` allowlist (falling back to the identity port) and the deprecated bound
 *    privilege flags.
 * 3. Sanitizes arguments payload via table-driven parameter normalizers.
 * 4. Runs the descriptor's delegation handler against the sanitized params and merged execution context.
 * 5. Captures and shields all errors into standardized `{ success: false, error, code }` receipts.
 *
 * Per-call `callerContext` is caller data, never authority, capability, or
 * scope: its `isAdmin`/`isPrivileged`/`privileged` flags, authority-bearing
 * `callerRole`/`role` aliases, `principal`/`authority` objects, `allowedTools`,
 * identity keys (`callerAgentId`/`agentId`/nested `callerContext`/`callerKey`/
 * `caller_key`), the Realm/workspace/tenant scope keys
 * (`workspaceId`/`workspace_id`,
 * `realmId`/`realm_id`, `tenantId`/`tenant_id`, `scope`), and every injected
 * capability/substrate (`virtualFs`, `messagingBus`, `worldClock`, `signal`,
 * `currentDepth`, `depth`, `executeTool`, `toolRegistry`, the narrow ports,
 * engine handles) are stripped before dispatch, so they can neither elevate a
 * caller, widen a restricted allowlist, select whose authority is consulted,
 * claim a canonical identity key, claim a Realm/workspace/tenant scope, reset
 * the invocation recursion guard, nor substitute the executor/substrate a
 * handler delegates to. The identity subject and all
 * capabilities resolve from trusted bound construction — a construction-bound
 * `realmId` resolves the caller realm-exactly and binds its canonical
 * `callerKey` (Wave I, ticket d57cbc1); an
 * anonymous dispatcher fails closed for non-innate tools without a bound
 * allowlist, and its identity-bearing substrate operations stay anonymous:
 * payload identity keys are never promoted (VFS default-deny, mailbox reads
 * empty, `send_message` attributes the fixed `'anonymous'` label,
 * `inline_file_in_message` requires a bound caller). A legacy `runtime` option
 * has its `lifecyclePort`/`identityPort` derived once and is never forwarded
 * to descriptor handlers.
 *
 * @param options - Bound runtime options and Layer 0 substrate engines
 * @returns Lean, error-shielded dispatcher function with helper methods
 *
 * @example
 * ```typescript
 * import { createSandboxToolDispatcher } from './toolDefinitions/index.ts';
 *
 * const dispatcher = createSandboxToolDispatcher({
 *   agentId: 'agent_storyteller',
 *   allowedTools: 'collaborator',
 *   virtualFs: myVirtualFs,
 *   messagingBus: myMessagingBus,
 *   worldClock: myWorldClock
 * });
 *
 * // Execute an LLM tool call
 * const receipt = await dispatcher({
 *   name: 'read_file',
 *   arguments: { file_path: '/lore/characters.json' }
 * });
 *
 * if (receipt.success) {
 *   console.log('Read success:', receipt.content);
 * } else {
 *   console.error(`Dispatch failed [${receipt.code}]: ${receipt.error}`);
 * }
 * ```
 */
export function createSandboxToolDispatcher(options: SandboxDispatcherOptions = {}): SandboxToolDispatcher {
  // The dispatcher consumes narrow capability ports and never
  // forwards a full runtime instance into descriptor/substrate contexts. Direct
  // callers may still hand a runtime; its ports are derived once here and the
  // instance itself is dropped before any handler sees the context.
  const { runtime: runtimeInstance = null, ...restOptions } = options;
  const boundOptions = restOptions;
  const lifecyclePort: LifecyclePort | null = boundOptions.lifecyclePort
    || (runtimeInstance && typeof runtimeInstance.createLifecyclePort === 'function'
      ? runtimeInstance.createLifecyclePort()
      : null);
  const identityPort: { getAgentIdentity(agentId: string | null, scope?: AgentIdentityScope): AgentIdentityProjection | null } | null =
    boundOptions.identityPort
    || (runtimeInstance && typeof runtimeInstance.createAgentIdentityPort === 'function'
      ? runtimeInstance.createAgentIdentityPort()
      : null);
  const getAgentIdentity: ToolExecutionPort['getAgentIdentity'] | null =
    identityPort && typeof identityPort.getAgentIdentity === 'function'
      ? identityPort.getAgentIdentity.bind(identityPort)
      : null;

  const dispatch = async function dispatch(
    toolCall: ToolCall,
    callerContext: ExecutionContext = {}
  ): Promise<ToolResult> {
    const rawName = toolCall?.function?.name || toolCall?.name;
    const canonName = getCanonToolName(rawName);

    // 1. Tool Identification. The canonical taxonomy resolves first; the
    // authority meta tools are a separate explicit-grant-only registry
    // (never members of `TOOL_REGISTRY`, never wildcard-exposed) routed
    // through this same pipeline.
    const canonicalDescriptor = canonName ? TOOL_REGISTRY_VIEW[canonName] ?? null : null;
    const authorityDescriptor = canonName ? AUTHORITY_TOOL_REGISTRY_VIEW[canonName] ?? null : null;
    const descriptor: ToolDescriptor | AuthorityToolDescriptor | null = canonicalDescriptor ?? authorityDescriptor;

    // Extension identification (extension wave; P2 lands the branch inert
    // because no production composition binds the provider-registry port): a
    // call name that resolves through neither baked registry may be a live
    // extension tool when the optional provider port is present. Extension
    // call names are sanitized model-facing names outside the canonical alias
    // map by construction (P1 reserves the baked/publishing universe against
    // them), so the trimmed raw name is the candidate. Resolution is
    // fail-closed — a throwing port, a malformed binding, or a call-name
    // mismatch resolves nothing, so the call stays `TOOL_NOT_FOUND`.
    const extensionNameCandidate = canonName
      ? null
      : (typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null);
    const extensionBinding = !descriptor && extensionNameCandidate
      ? resolveExtensionToolBinding(boundOptions.extensionToolProvider, extensionNameCandidate)
      : null;

    if (!descriptor && !extensionBinding) {
      return {
        success: false,
        error: `Tool '${rawName}' is not recognized in the tool registry.`,
        code: TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND
      };
    }
    // The effective authorization name: the canonical name for baked tools,
    // the exact extension call name for provider tools.
    const authorizationName = extensionBinding ? extensionNameCandidate : canonName;
    if (!authorizationName) {
      return {
        success: false,
        error: `Tool '${rawName}' is not recognized in the tool registry.`,
        code: TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND
      };
    }

    // MOD-21 (tickets 4074766/172824e/a9db33c/a1ce597/dd73ca7): per-call
    // `callerContext` is caller data, never authority or capability. Strip the
    // legacy privilege flags, the authority-bearing role aliases,
    // authority-shaped principals, the capability allowlist, the identity
    // subject, and every injected capability/substrate before merging;
    // privilege, identity, and capability derive only from trusted bound
    // construction options and the injected identity port.
    const untrustedCallerContext: Record<string, unknown> = {};
    if (callerContext && typeof callerContext === 'object') {
      for (const [key, value] of Object.entries(callerContext)) {
        if (!PINNED_CONTEXT_KEYS.has(key)) untrustedCallerContext[key] = value;
      }
    }

    const mergedContext: Record<string, unknown> = { toolRegistry: TOOL_REGISTRY, ...boundOptions, ...untrustedCallerContext };
    if (lifecyclePort) mergedContext.lifecyclePort = lifecyclePort;
    if (identityPort) mergedContext.identityPort = identityPort;
    if ('runtime' in mergedContext) delete mergedContext.runtime;

    // The identity subject is the bound construction identity only. An
    // anonymous dispatcher has no subject and therefore falls through to the
    // fail-closed authorization path below; per-call identity keys were
    // stripped above.
    const boundCallerAgentId = typeof boundOptions.callerAgentId === 'string' && boundOptions.callerAgentId
      ? boundOptions.callerAgentId
      : null;
    const boundAgentId = typeof boundOptions.agentId === 'string' && boundOptions.agentId
      ? boundOptions.agentId
      : null;
    const agentId: string | null = boundCallerAgentId || boundAgentId;

    // Realm-exact identity resolution (Wave I, ticket d57cbc1): a trusted host
    // that binds the caller's Realm (`realmId` at construction — a pinned scope
    // key, never per-call data) resolves the projection for exactly that
    // `(realmId, agentId)` registration, so the same literal id in two Realms
    // never resolves the wrong caller and never falls into an ambiguity denial.
    // An omitted Realm keeps the legacy unique-match rule.
    const rawBoundRealmId = (boundOptions as { realmId?: unknown }).realmId;
    const hasBoundRealmScope = (typeof rawBoundRealmId === 'string' && rawBoundRealmId.length > 0)
      || rawBoundRealmId === null;
    const identityScope: AgentIdentityScope | undefined = hasBoundRealmScope
      ? { realmId: rawBoundRealmId === null ? null : rawBoundRealmId as string }
      : undefined;
    // Pinned canonical caller identity (ticket 5f34f18): a construction-bound
    // `callerKey` is the same trusted pinned channel `realmId` is (the turn
    // engine's production binding carries it while per-call claims are
    // stripped), so the projection resolves by canonical key ahead of the
    // scope/bare-id fallbacks. Without this, a caller whose bare id is
    // registered in two Realms resolves ambiguous -> `null` and every
    // authority-gated call default-denies even though the exact registration
    // holds the approved grant. A bound key is authoritative: when it does not
    // resolve to the bound subject (a stale key from before a recycle), the
    // dispatcher must NOT fall back to the ambiguous bare id — that fallback
    // could silently retarget the surviving same-literal-id twin (the pinned
    // stale-key fail-closed contract, realm_identity_matrix 6d).
    const boundCallerKey = typeof boundOptions.callerKey === 'string' && boundOptions.callerKey
      ? boundOptions.callerKey
      : null;
    // Identity-port shielding (P2.4-O1): identity resolution is trusted
    // construction, but a throwing `getAgentIdentity` must never escape
    // `dispatch()`. The failure fails closed as a uniform typed denial — an
    // identity the dispatcher cannot resolve is treated as unauthorized, never
    // as a fallback to the legacy descriptor-less channels (which could widen
    // a descriptor-present caller whose projection failed mid-read).
    let agentIdentity: AgentIdentityProjection | null = null;
    if (getAgentIdentity) {
      try {
        if (boundCallerKey) {
          if (agentId) {
            const keyed = getAgentIdentity(boundCallerKey);
            if (keyed && keyed.id === agentId) agentIdentity = keyed;
          }
        } else {
          agentIdentity = getAgentIdentity(agentId, identityScope);
        }
      } catch {
        return {
          success: false,
          error: `Agent '${agentId || 'anonymous'}' identity could not be resolved; the request is denied.`,
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }

    // Canonical identity key of the resolved caller (Wave I, ticket d57cbc1):
    // bound into the execution context when the caller resolved through the
    // trusted realm-exact scope or the pinned canonical `callerKey`, so
    // substrate contexts (bus/VFS/clock/scheduler/invocation) disambiguate
    // same-literal-id registrations exactly. A unique-match resolution keeps
    // the bare-id channel (substrates resolve it identically) and never
    // presents an unverifiable key to a substrate wired with a different
    // identity port. The key is trusted construction output: per-call
    // `callerKey`/`caller_key` claims are pinned keys and are stripped before
    // dispatch.
    const callerKey = (hasBoundRealmScope || boundCallerKey !== null)
      && agentIdentity
      && typeof agentIdentity.key === 'string'
      && agentIdentity.key
      ? agentIdentity.key
      : null;

    // Legacy privilege projection: honored by `isAuthorized` only for
    // descriptor-less callers (a present identity-projection
    // `AuthorityDescriptor` authorizes or denies alone, ticket 76fb539).
    const isPrivileged = Boolean(
      boundOptions.isAdmin ||
      boundOptions.isPrivileged ||
      boundOptions.privileged ||
      agentIdentity?.privileged
    );

    // Trusted allowlist: bound construction first, then the identity projection.
    // Legacy channel only: consulted when the identity projection carries no
    // `AuthorityDescriptor` (ticket 76fb539).
    const allowedTools = boundOptions.allowedTools !== undefined
      ? boundOptions.allowedTools
      : (agentIdentity?.allowedTools !== undefined ? agentIdentity.allowedTools : null);

    // The nested precall executor is a trusted construction capability: the
    // bound executor when one was injected, otherwise the dispatcher's own
    // re-entrant closure. Per-call `executeTool` values were stripped above
    // and can never replace it (ticket dd73ca7).
    const trustedExecuteTool: NonNullable<ExecutionContext['executeTool']> =
      typeof boundOptions.executeTool === 'function'
        ? boundOptions.executeTool
        : (name, args, callerCtx) => dispatch({ name, arguments: args }, callerCtx);

    // Reflection surface (ticket ec397bf): `describe_tool` is seeded with a
    // registry view narrowed to exactly the tools this caller can invoke, so
    // the advertised surface never exceeds the authorization surface. The
    // candidate view is the bound registry (engine-merged baked + granted
    // extension descriptors) plus the explicit-grant-only authority registry;
    // the same gate admits or withholds each entry, so authority tools are
    // described only to exact holders (d872723 F10) and ungranted callers
    // never see an invocable-looking entry.
    const reflectionRegistry = canonName === SANDBOX_TOOLS.DESCRIBE_TOOL
      ? buildAuthorizedRegistryView(
          {
            ...(mergedContext.toolRegistry && typeof mergedContext.toolRegistry === 'object'
              && !Array.isArray(mergedContext.toolRegistry)
              ? mergedContext.toolRegistry as Record<string, unknown>
              : TOOL_REGISTRY),
            ...AUTHORITY_TOOL_REGISTRY
          },
          { isAdmin: isPrivileged, isPrivileged, allowedTools },
          agentIdentity,
          boundOptions.extensionToolProvider
        )
      : mergedContext.toolRegistry;

    const executionContext: ExecutionContext = {
      ...mergedContext,
      toolRegistry: reflectionRegistry,
      agentId,
      callerAgentId: agentId,
      ...(callerKey ? { callerKey } : {}),
      allowedTools,
      executeTool: trustedExecuteTool,
      isAdmin: isPrivileged,
      isPrivileged,
      privileged: isPrivileged
    };

    // 2. Capability / Security Gating Check
    //
    // Extension tools (extension wave): a resolved provider binding never
    // reaches the canonical `isAuthorized` path. Authorization is exact
    // membership on the caller's frozen `AuthorityDescriptor.extensions` axis —
    // the wildcard `'*'`, `privileged`, subagent-management selectors,
    // alias-written descriptor entries, and every legacy allowlist channel are
    // deliberately insufficient; anonymous/descriptor-less callers deny and an
    // engine-internal principal denies. Identity resolution above is trusted
    // construction; any throw while probing the descriptor fails closed. After
    // authorization the branch resolves the frozen synthesized descriptor and
    // executes it against the pinned `extensionExecutionPort`; a missing
    // descriptor or execution port fails closed with `EXECUTION_FAILED` — never
    // a silent success and never a fallthrough to a baked handler.
    if (extensionBinding) {
      if (!isExtensionToolAuthorized(authorizationName, agentIdentity)) {
        return {
          success: false,
          error: `Agent '${agentId || 'anonymous'}' is not authorized to invoke extension tool '${authorizationName}'.`,
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
      const extensionDescriptor = resolveExtensionDescriptor(
        boundOptions.extensionToolProvider,
        authorizationName
      );
      const extensionExecutionPort = readExtensionExecutionPort(boundOptions.extensionExecutionPort);
      if (!extensionDescriptor || !extensionExecutionPort) {
        return {
          success: false,
          error: `Extension tool '${authorizationName}' is authorized but its execution channel is not available.`,
          code: TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED
        };
      }
      try {
        const rawArgs = toolCall?.function?.arguments !== undefined
          ? toolCall.function.arguments
          : (toolCall?.arguments !== undefined ? toolCall.arguments : (toolCall?.args !== undefined ? toolCall.args : {}));
        const sanitizedParams = extensionDescriptor.sanitize(rawArgs);
        const result = await extensionDescriptor.handler(sanitizedParams, executionContext);
        return normalizeToolResult(result);
      } catch (err) {
        // Universal error shield: a port rejection (typed `McpClientError`
        // taxonomy) or handler throw surfaces as a redacted failure receipt;
        // downstream codes outside the dictionary normalize to
        // `EXECUTION_FAILED`.
        const failure = (err ?? {}) as { message?: unknown; code?: unknown };
        return {
          success: false,
          error: typeof failure.message === 'string' && failure.message
            ? failure.message
            : 'Extension tool execution encountered an unhandled failure.',
          code: normalizeToolErrorCode(failure.code)
        };
      }
    }

    // Unreachable by construction (the identification guard above returns when
    // neither a baked descriptor nor an extension binding resolved); this
    // guard keeps the narrowing explicit for the executor/handler reads below.
    if (!descriptor) {
      return {
        success: false,
        error: `Tool '${rawName}' is not recognized in the tool registry.`,
        code: TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND
      };
    }

    if (!isAuthorized(authorizationName, executionContext, agentIdentity, authorityDescriptor ? authorityDescriptor.authority : null)) {
      // A descriptor may publish a remedy restating its description (e.g. the
      // capability requirement); it never reads registry state, so the denial
      // gives no existence/authority oracle.
      const denialHint = typeof (descriptor as { denialHint?: unknown }).denialHint === 'string'
        ? (descriptor as { denialHint?: string }).denialHint
        : '';
      return {
        success: false,
        error: `Agent '${agentId || 'anonymous'}' is not authorized to invoke tool '${authorizationName}'.${denialHint ? ` ${denialHint}` : ''}`,
        code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
      };
    }

    // 3. Execution & Universal Error Shielding
    try {
      const rawArgs = toolCall?.function?.arguments !== undefined
        ? toolCall.function.arguments
        : (toolCall?.arguments !== undefined ? toolCall.arguments : (toolCall?.args !== undefined ? toolCall.args : {}));

      const sanitizedParams = descriptor.sanitize(rawArgs);
      const result = await descriptor.handler(sanitizedParams, executionContext);
      return normalizeToolResult(result);
    } catch (err) {
      const failure = (err ?? {}) as { message?: unknown; code?: unknown };
      return {
        success: false,
        error: typeof failure.message === 'string' && failure.message
          ? failure.message
          : 'Tool execution encountered an unhandled failure.',
        code: normalizeToolErrorCode(failure.code)
      };
    }
  };

  /**
   * Dispatches OpenAI function call format tool calls: \{ id, type: 'function', function: \{ name, arguments \} \}
   * and returns OpenAI tool message receipt: \{ role: 'tool', tool_call_id, content \}
   */
  dispatch.executeToolCall = async function executeToolCall(
    toolCallObj: ToolCall
  ): Promise<{ role: 'tool'; tool_call_id: string; content: string }> {
    const rawResult = await dispatch(toolCallObj);
    return {
      role: 'tool',
      tool_call_id: toolCallObj?.id || '',
      content: typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
    };
  };

  /**
   * Convenience helper to execute a tool by name and arguments payload
   */
  dispatch.executeTool = async function executeTool(
    name: string,
    rawArgs: Record<string, unknown> = {},
    callerCtx: ExecutionContext = {}
  ): Promise<ToolResult> {
    return await dispatch({ name, arguments: rawArgs }, callerCtx);
  };

  /**
   * Canonical name resolver exposed as a narrow dispatcher capability. Consumers
   * (e.g. precall revalidation in `runtime/turnExecutionEngine/index.ts`) use the same
   * normalization authority as
   * the dispatcher itself, avoiding engine-local alias drift.
   *
   * @param name - Raw tool name or alias
   * @returns Canonical snake_case tool name or null when unknown
   */
  dispatch.canonicalizeToolName = function canonicalizeToolName(name: string): string | null {
    return getCanonToolName(name);
  };

  return dispatch;
}

/**
 * Normalizes an arbitrary descriptor-handler return value into a canonical
 * `ToolResult` receipt. Objects without a `success` discriminator gain
 * `success: true`; bare arrays are wrapped as `{ success: true, result }`;
 * primitives (including `null`/`undefined`) become `{ success: true, result }`;
 * explicit failure receipts keep their shape but have their `code` constrained
 * to the declared `TOOL_SYSTEM_ERROR_CODES` vocabulary.
 *
 * @param result - Raw descriptor handler return value
 * @returns Canonical `ToolResult` receipt
 */
function normalizeToolResult(result: unknown): ToolResult {
  if (result !== null && typeof result === 'object') {
    if (Array.isArray(result)) {
      return { success: true, result };
    }
    const receipt = result as { success?: unknown; [key: string]: unknown };
    if (receipt.success === false) {
      return {
        ...receipt,
        success: false,
        code: normalizeToolErrorCode(receipt.code)
      } as ToolResultFailure;
    }
    if (receipt.success === undefined) {
      return { success: true, ...receipt } as ToolResultSuccess;
    }
    return result as ToolResult;
  }
  return { success: true, result };
}

/**
 * Membership guard over the declared failure-code vocabulary.
 *
 * @param code - Candidate failure code
 * @returns `true` when `code` is a declared `TOOL_SYSTEM_ERROR_CODES` member
 */
function isToolSystemErrorCode(code: string): code is ToolSystemErrorCode {
  return TOOL_RESULT_ERROR_CODES.has(code);
}

/**
 * Constrains a downstream failure code to the declared tool-system vocabulary.
 * Out-of-enum (or missing) codes are normalized to `EXECUTION_FAILED`.
 *
 * @param code - Downstream error/receipt code
 * @returns A declared `TOOL_SYSTEM_ERROR_CODES` member
 */
function normalizeToolErrorCode(code: unknown): ToolSystemErrorCode {
  return typeof code === 'string' && isToolSystemErrorCode(code)
    ? code
    : TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED;
}

/**
 * Retired-selector window expansion (deprecated, ticket 5efc129): a grant
 * entry that canonicalizes to a retired selector expands to exactly the
 * selector's frozen tool list. Non-string entries, unknown names, and
 * alias-written canonical tool names never match here — aliases keep granting
 * exactly their canonical tool. Module-private.
 *
 * @param entry - Raw grant entry from an authority descriptor or legacy allowlist
 * @returns The frozen expansion array, or `null` when the entry is not a retired selector
 */
function expandRetiredSelectorGrant(entry: unknown): readonly SandboxToolName[] | null {
  if (typeof entry !== 'string') return null;
  const canonical = getCanonToolName(entry);
  if (canonical === null) return null;
  return expandRetiredToolSelector(canonical);
}

/**
 * Capability authorization gate.
 *
 * When the identity projection carries the frozen `AuthorityDescriptor`, the
 * descriptor decides alone (Realm A0-1, ticket 76fb539): a non-innate tool is
 * authorized iff the descriptor holds the wildcard `'*'`, an explicit grant for
 * the canonical tool (alias-written entries are canonicalized to their
 * canonical tool), or a grant entry that canonicalizes to a retired selector
 * and thereby authorizes exactly that selector's expansion (deprecated
 * window). A descriptor with no matching grant denies and never falls through
 * to legacy privilege flags or allowlists, so grants cannot widen each other.
 * Any throw from the descriptor read or capability probe
 * (`authority`/`allow`/`allow.has` accessors, `has(...)` calls, or the
 * allow-set iterator) is treated as a deny (fail closed), never an unshielded
 * exception out of `dispatch()`. The deprecated legacy channels
 * (`isAdmin`/`isPrivileged` bypass and the bound/identity `allowedTools`
 * allowlist) apply only to callers whose identity projection carries no
 * descriptor. Innate tools stay universally allowed.
 *
 * Wave U publishing meta tools (`requiredAuthority` non-null) refine INV-9:
 * authorization is the *exact* explicit authority on the frozen descriptor —
 * the wildcard `'*'`, `privileged`, and every legacy channel are deliberately
 * insufficient, so publishing capability can never be implied or smuggled.
 * An engine-internal descriptor (`kind: 'internal'`) remains authorized as the
 * composition-root path; anonymous and descriptor-less callers deny.
 *
 * @param toolName - Canonical tool name
 * @param context - Merged execution context (trusted bound construction + non-authority per-call metadata)
 * @param agentIdentity - Identity projection for the bound subject, or `null` when none
 * @param requiredAuthority - Exact authority id a publishing meta tool requires, or `null` for canonical tools
 * @returns `true` when the caller may invoke the tool
 */
function isAuthorized(
  toolName: string,
  context: ExecutionContext,
  agentIdentity: AgentIdentityProjection | null,
  requiredAuthority: string | null = null
): boolean {
  // Wave U publishing meta tools: explicit-grant-only. The wildcard `'*'` and
  // `privileged` never satisfy these two capabilities (deliberate INV-9
  // refinement); only the exact authority id on the frozen descriptor — or an
  // engine-internal descriptor — authorizes.
  if (requiredAuthority) {
    try {
      const authority = agentIdentity?.authority;
      if (!authority) return false;
      if (authority.kind === 'internal') return true;
      const allow = authority.allow;
      if (!allow || typeof allow.has !== 'function') return false;
      return allow.has(requiredAuthority) === true;
    } catch {
      // Fail closed: a throwing descriptor accessor or capability probe denies.
      return false;
    }
  }

  // Innate tools are universally authorized for all callers
  if (INNATE_TOOLS.has(toolName)) return true;

  // MOD-21 W1 + Realm A0-1 (76fb539): the frozen `AuthorityDescriptor` from the
  // identity projection is the authoritative capability surface when present
  // (wildcard permitted). A descriptor that does not allow the op denies on its
  // own; the deprecated legacy channels below apply only to callers with no
  // descriptor.
  try {
    const authority = agentIdentity?.authority;
    if (authority) {
      const allow = authority.allow;
      if (allow && typeof allow.has === 'function') {
        if (allow.has('*') || allow.has(toolName)) return true;
        if (typeof allow[Symbol.iterator] === 'function') {
          for (const entry of allow) {
            // Deprecated selector window (ticket 5efc129): an entry that
            // canonicalizes to a retired selector authorizes exactly that
            // selector's expansion, nothing more.
            const expansion = expandRetiredSelectorGrant(entry);
            if (expansion) {
              if (expansion.some((tool) => tool === toolName)) return true;
              continue;
            }
            // Alias-written descriptor entries grant exactly their canonical
            // tool (e.g. 'save_file' -> write_file). The descriptor still
            // decides alone: canonicalization never admits a tool the
            // descriptor does not name or alias.
            if (typeof entry === 'string' && entry !== toolName && getCanonToolName(entry) === toolName) {
              return true;
            }
          }
        }
      }
      // Fail closed: a descriptor-present caller gets no other widening channel.
      return false;
    }
  } catch {
    // Fail closed (ticket 8716523): any throw from the authority read or probe
    // (`authority`/`allow`/`allow.has` accessors, `has(...)` calls, or the
    // allow-set iterator) is a deny, never an unshielded exception out of
    // `dispatch()`.
    return false;
  }

  // --------------------------------------------------------------------------
  // Deprecated legacy channels (descriptor-less callers only)
  // --------------------------------------------------------------------------

  // Superuser / Admin privilege bypass
  if (context.isAdmin || context.isPrivileged) return true;

  // Explicit allowedTools check (context override first, then identity port)
  const rawAllowed = context.allowedTools !== undefined
    ? context.allowedTools
    : (agentIdentity?.allowedTools !== undefined ? agentIdentity.allowedTools : null);

  if (rawAllowed === null || rawAllowed === undefined) {
    return false; // Fail-closed for non-innate tools when allowedTools is unset and caller is unprivileged
  }

  const resolved = resolveToolPreset(rawAllowed);
  if (resolved.includes('*')) return true;

  const allowedSet = new Set<string>();
  for (const item of resolved) {
    if (typeof item !== 'string') continue;
    const canon = getCanonToolName(item);
    if (canon === null) continue;
    // Deprecated selector window (ticket 5efc129): the alias spellings
    // (`manage_subagents`/`subagents`/`subagent_tools`) canonicalize to the
    // retired selector and keep granting exactly its expansion.
    const expansion = expandRetiredToolSelector(canon);
    if (expansion) {
      for (const tool of expansion) allowedSet.add(tool);
      continue;
    }
    allowedSet.add(canon);
  }

  return allowedSet.has(toolName);
}

/**
 * Resolves one call name against the optional extension provider-registry
 * port (extension wave). Fail-closed resolution: a missing/throwing port, a
 * non-object binding, a call-name mismatch, an empty extension id, or a
 * missing wire tool name resolves `null`, so the call can never route into
 * the extension branch on malformed provider state.
 *
 * @param provider - Bound provider-registry port (`undefined` without one).
 * @param callName - Canonical sanitized call name.
 * @returns A frozen binding, or `null` when the name is not a live extension tool.
 * @internal
 */
function resolveExtensionToolBinding(
  provider: unknown,
  callName: string
): ExtensionToolBinding | null {
  if (!provider || typeof provider !== 'object') return null;
  const resolve = (provider as { resolveTool?: unknown }).resolveTool;
  if (typeof resolve !== 'function') return null;
  try {
    const binding = (resolve as (this: unknown, name: string) => unknown).call(provider, callName);
    if (!binding || typeof binding !== 'object') return null;
    const record = binding as { callName?: unknown; extensionId?: unknown; serverToolName?: unknown };
    if (record.callName !== callName) return null;
    if (typeof record.extensionId !== 'string' || !record.extensionId) return null;
    if (typeof record.serverToolName !== 'string' || !record.serverToolName) return null;
    return Object.freeze({ callName, extensionId: record.extensionId, serverToolName: record.serverToolName });
  } catch {
    return null;
  }
}

/**
 * Resolves the frozen synthesized descriptor for one authorized extension call
 * name through the provider port's optional `resolveDescriptor` member
 * (extension wave). Fail-closed resolution: a missing/throwing member, a
 * non-object descriptor, a name mismatch, or a descriptor missing its
 * description/schema/sanitizer/handler resolves `null`, so the dispatcher
 * fails the call closed with `EXECUTION_FAILED` instead of invoking a
 * malformed handler.
 *
 * @param provider - Bound provider-registry port (`undefined` without one).
 * @param callName - Canonical sanitized call name.
 * @returns The frozen descriptor, or `null` when none is executable.
 * @internal
 */
function resolveExtensionDescriptor(
  provider: unknown,
  callName: string
): ExtensionToolDescriptor | null {
  if (!provider || typeof provider !== 'object') return null;
  const resolve = (provider as { resolveDescriptor?: unknown }).resolveDescriptor;
  if (typeof resolve !== 'function') return null;
  try {
    const descriptor = (resolve as (this: unknown, name: string) => unknown).call(provider, callName);
    if (!descriptor || typeof descriptor !== 'object') return null;
    const record = descriptor as {
      name?: unknown;
      description?: unknown;
      schema?: unknown;
      sanitize?: unknown;
      handler?: unknown;
    };
    if (record.name !== callName) return null;
    if (typeof record.description !== 'string') return null;
    if (!record.schema || typeof record.schema !== 'object') return null;
    if (typeof record.sanitize !== 'function') return null;
    if (typeof record.handler !== 'function') return null;
    return descriptor as ExtensionToolDescriptor;
  } catch {
    return null;
  }
}

/**
 * Duck-typed presence check for the pinned extension execution port. The
 * synthesized descriptor handlers read the port from the handler context under
 * the pinned `extensionExecutionPort` key; the dispatcher's extension branch
 * checks the bound value so a missing port fails closed with a dispatcher-level
 * `EXECUTION_FAILED` receipt.
 *
 * @param value - Bound execution port candidate.
 * @returns The port when bound and executable-shaped, else `null`.
 * @internal
 */
function readExtensionExecutionPort(value: unknown): ExtensionExecutionPort | null {
  if (value === null || typeof value !== 'object') return null;
  if (typeof (value as { execute?: unknown }).execute !== 'function') return null;
  return value as ExtensionExecutionPort;
}

/**
 * Extension authorization gate (extension wave; INV-9 refinement).
 *
 * A resolved extension call is authorized iff the caller's frozen
 * `AuthorityDescriptor.extensions` set holds the exact call name. This axis is
 * separate from `allow` on purpose: the wildcard `'*'`, `privileged`,
 * subagent-management selectors, alias-written entries, and every legacy
 * allowlist/privilege channel are deliberately insufficient, and canonical
 * alias normalization never applies (matching is exact string membership).
 * Anonymous callers, descriptor-less callers, engine-internal principals, and
 * hand-built descriptors without a readable extensions set all deny. Any throw
 * from the descriptor read or the membership probe is a deny (fail closed),
 * never an unshielded exception out of `dispatch()`.
 *
 * @param toolName - Canonical sanitized call name resolved by the provider port.
 * @param agentIdentity - Identity projection for the bound subject, or `null`.
 * @returns `true` only on exact membership in the caller's extensions axis.
 * @internal
 */
function isExtensionToolAuthorized(
  toolName: string,
  agentIdentity: AgentIdentityProjection | null
): boolean {
  try {
    const authority = agentIdentity?.authority;
    if (!authority || authority.kind !== 'agent') return false;
    const extensions = authority.extensions;
    if (!extensions || typeof extensions.has !== 'function') return false;
    return extensions.has(toolName) === true;
  } catch {
    // Fail closed: a throwing descriptor accessor or membership probe denies.
    return false;
  }
}

/**
 * Builds the registry view a caller may reflect over — exactly the entries the
 * same authorization gate admits for invocation (ticket ec397bf; closes the
 * `describe_tool` visibility/authorization asymmetry and d872723 F10).
 *
 * Each candidate entry is classified the same way dispatch classifies a call:
 * an entry resolvable as a live extension call name is admitted only on exact
 * `AuthorityDescriptor.extensions` membership; every other entry runs through
 * {@link isAuthorized}, using a descriptor-declared `authority` id as the
 * `requiredAuthority` when present so explicit-grant-only tools are advertised
 * only to their exact holders (the wildcard `'*'` and `privileged` never imply
 * them). Innate tools are admitted by `isAuthorized` as usual. The returned
 * view is a fresh null-prototype frozen record; an entry the caller cannot
 * invoke is never added, so it resolves `TOOL_NOT_FOUND` from the handler
 * (uniform with an unknown name — no existence oracle).
 *
 * @param registry - Candidate registry (bound merged registry + authority registry).
 * @param authorizationContext - Dispatcher execution context carrying the trusted legacy channels.
 * @param agentIdentity - Identity projection for the bound subject, or `null`.
 * @param extensionToolProvider - Bound extension provider-registry port (`undefined` without one).
 * @returns The frozen caller-authorized registry view.
 * @internal
 */
function buildAuthorizedRegistryView(
  registry: Record<string, unknown>,
  authorizationContext: ExecutionContext,
  agentIdentity: AgentIdentityProjection | null,
  extensionToolProvider: unknown
): Record<string, unknown> {
  const view: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(registry)) {
    const binding = resolveExtensionToolBinding(extensionToolProvider, name);
    if (binding) {
      if (isExtensionToolAuthorized(name, agentIdentity)) view[name] = registry[name];
      continue;
    }
    const entry = registry[name];
    const requiredAuthority = entry && typeof entry === 'object'
      && typeof (entry as { authority?: unknown }).authority === 'string'
      ? (entry as { authority: string }).authority
      : null;
    if (isAuthorized(name, authorizationContext, agentIdentity, requiredAuthority)) {
      view[name] = registry[name];
    }
  }
  return Object.freeze(view);
}
