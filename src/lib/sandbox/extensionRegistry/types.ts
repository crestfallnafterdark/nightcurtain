/**
 * Plain types for the `extensionRegistry` module: global extension install
 * records, realm-local attachment records, resolution request/result shapes,
 * the injected storage adapter, and the registry service surface.
 */

/**
 * Extension kind discriminator: an MCP server (protocol client) or a
 * host-installed tool pack.
 */
export type ExtensionKind = 'mcp' | 'pack';

/**
 * Frozen runtime vocabulary of the extension kinds; {@link ExtensionKind} is
 * its compile-time mirror.
 */
export const EXTENSION_KINDS: Readonly<{
  /** An MCP server extension. */
  readonly MCP: 'mcp';
  /** A host-installed tool pack extension. */
  readonly PACK: 'pack';
}> = Object.freeze({
  MCP: 'mcp',
  PACK: 'pack'
} as const);

/**
 * Installation lifecycle of one global install record. `installed` is the
 * healthy state; `unavailable` marks a record whose declared configuration is
 * currently unusable; `error` marks a record whose last operation failed.
 */
export type ExtensionInstallStatus = 'installed' | 'unavailable' | 'error';

/**
 * How an install record came to exist: an explicit operator install or the
 * operator-confirmed template install assist.
 */
export type ExtensionInstallSource = 'operator' | 'template-assist';

/**
 * Activation state of one realm-local attachment. `active` means the realm
 * accepts the extension; `conflict` marks a conflicting activation the
 * operator must resolve; `unavailable` marks an attachment whose extension is
 * not currently installed or usable.
 */
export type ExtensionAttachmentStatus = 'active' | 'conflict' | 'unavailable';

/**
 * Realm-level tool selection of one attachment: every tool the extension
 * provides, or an explicit list of sanitized model-facing call names.
 */
export type ExtensionToolSelection = 'all' | readonly string[];

/**
 * HTTP transport hint of an installed/requested MCP extension: the server URL
 * the operator declares or approves, never a fetched endpoint.
 */
export interface ExtensionHttpTransportHint {
  /** Transport discriminator. */
  readonly kind: 'http';
  /** Server URL (an install/review hint only; nothing connects until the operator installs and runs a connection). */
  readonly url: string;
}

/**
 * Stdio transport hint of an installed/requested MCP extension. Stdio is a
 * typed, host-only transport: browser contexts cannot execute it, so a record
 * carrying this hint is descriptive metadata only.
 */
export interface ExtensionStdioTransportHint {
  /** Transport discriminator. */
  readonly kind: 'stdio';
  /** Executable or command to run. */
  readonly command: string;
  /** Command arguments, when declared. */
  readonly args?: readonly string[];
}

/**
 * Install-source hint of a requested/installed tool pack: where the pack can
 * be obtained.
 */
export interface ExtensionPackTransportHint {
  /** Transport discriminator. */
  readonly kind: 'pack';
  /** Install source hint declared by the requesting template or operator. */
  readonly source: string;
}

/**
 * Transport hint union carried by install records and resolution requests.
 * Hints are descriptive: no connection is ever attempted from them.
 */
export type ExtensionTransportHint =
  | ExtensionHttpTransportHint
  | ExtensionStdioTransportHint
  | ExtensionPackTransportHint;

/**
 * One global extension install record: the host-level, operator-owned
 * statement that an extension is installed, plus the non-secret metadata
 * needed to review and manage it.
 *
 * Records are frozen plain data. The record shape deliberately carries no tool
 * catalog and no connection state: catalogs belong to connection-time
 * discovery and are never persisted here.
 */
export interface ExtensionInstallRecord {
  /** Host-unique extension id (a template provider id when the install was template-assisted). */
  readonly id: string;
  /** Extension kind: MCP server or tool pack. */
  readonly kind: ExtensionKind;
  /** Operator-facing display name; absent when none was declared. */
  readonly displayName?: string;
  /** Transport hint the record was installed with; never dialed from this module. */
  readonly transportHint: ExtensionTransportHint;
  /** Optional vault credential id bound to the record (an id, never a secret). */
  readonly credentialId?: string;
  /** Installation lifecycle status. */
  readonly status: ExtensionInstallStatus;
  /** How the record came to exist. */
  readonly installSource: ExtensionInstallSource;
  /** Operator-approved server URL, when the operator approved one explicitly. */
  readonly approvedUrl?: string;
  /** Non-fatal normalization findings recorded at install time (for example an ignored deprecated field). */
  readonly normalizationWarnings?: readonly string[];
  /** Epoch milliseconds when the record was created. */
  readonly createdAt: number;
}

/**
 * One realm-local attachment: the operator's statement that a realm accepts a
 * globally installed extension, with the realm-level tool selection and the
 * approval stamp.
 *
 * Attachments live on the realm record (realm-local, realm-managed), so realm
 * deletion and persistence carry them; this module owns the shape and
 * validation.
 */
export interface RealmExtensionAttachment {
  /** Id of the globally installed extension this realm attaches. */
  readonly extensionId: string;
  /** Realm-level tool selection: `'all'` or an explicit sanitized call-name list. */
  readonly toolSelection: ExtensionToolSelection;
  /** Activation state of the attachment. */
  readonly status: ExtensionAttachmentStatus;
  /** ISO-8601 timestamp of the operator approval that created the attachment. */
  readonly approvedAt: string;
  /** Approval principal; always the operator. */
  readonly approvedBy: 'operator';
}

/**
 * One extension requested by a template: the provider identity plus the
 * transport hint the request declares. Requests are inputs to resolution, not
 * install records.
 */
export interface ExtensionRequest {
  /** Requested extension id (the template provider id). */
  readonly id: string;
  /** Requested extension kind. */
  readonly kind: ExtensionKind;
  /** Optional declared display name. */
  readonly displayName?: string;
  /** Transport hint declared by the request, when it declares one. */
  readonly transportHint?: ExtensionTransportHint;
}

/**
 * Resolution input without host state: the requested extensions plus the
 * declared `<providerId>::<serverToolName>` references, in declared order.
 */
export interface ExtensionResolutionRequest {
  /** Requested extensions, in declared order (ids unique). */
  readonly requests: readonly ExtensionRequest[];
  /** Declared `<providerId>::<serverToolName>` tool references, in declared order. */
  readonly toolReferences: readonly string[];
}

/**
 * Complete resolution input including the host state a resolution reads:
 * install records and realm attachments (both already validated).
 */
export interface ExtensionResolutionInput extends ExtensionResolutionRequest {
  /** Installed extension records the resolution reads (ids unique). */
  readonly installs: readonly ExtensionInstallRecord[];
  /** Realm attachments the resolution reads (at most one per extension id). */
  readonly attachments: readonly RealmExtensionAttachment[];
}

/**
 * Why one requested extension did not resolve: it has no install record, or it
 * is installed but carries no active attachment.
 */
export type MissingExtensionReason = 'not-installed' | 'not-attached';

/**
 * Why one declared tool reference did not resolve: its extension did not
 * resolve, or the attachment's tool selection excludes the derived call name.
 */
export type MissingExtensionToolReason = 'not-installed' | 'not-attached' | 'selection-excluded';

/**
 * One requested extension that did not resolve, with the reason.
 */
export interface MissingExtension {
  /** Requested extension id. */
  readonly extensionId: string;
  /** Requested extension kind. */
  readonly kind: ExtensionKind;
  /** Why the extension did not resolve. */
  readonly reason: MissingExtensionReason;
}

/**
 * One declared tool reference that did not resolve, with the reason.
 */
export interface MissingExtensionTool {
  /** Declared `<providerId>::<serverToolName>` reference, verbatim. */
  readonly reference: string;
  /** Extension id the reference names. */
  readonly extensionId: string;
  /** Derived sanitized model-facing call name. */
  readonly callName: string;
  /** Why the reference did not resolve. */
  readonly reason: MissingExtensionToolReason;
}

/**
 * Frozen resolution projection of a template's extension requests against the
 * host's installed records and one realm's attachments.
 */
export interface ExtensionResolution {
  /** Sanitized call name → extension id, in declared reference order; only resolved tools appear. */
  readonly resolvedTools: Readonly<Record<string, string>>;
  /** Requested extensions that did not resolve, in declared request order. */
  readonly missingExtensions: readonly MissingExtension[];
  /** Declared tool references that did not resolve, in declared reference order. */
  readonly missingTools: readonly MissingExtensionTool[];
}

/**
 * One tool advertised by a discovered MCP server, as catalog indexing receives
 * it: the wire tool name plus the optional server-supplied description and raw
 * input/output schemas (surfaced verbatim, never validated against a dialect
 * here).
 */
export interface ExtensionCatalogDiscoveryTool {
  /** Wire tool name exactly as the server advertised it. */
  readonly name: string;
  /** Optional server-supplied human-readable description. */
  readonly description?: string;
  /** Raw JSON Schema of the tool input, when the server supplied one. */
  readonly inputSchema?: unknown;
  /** Raw JSON Schema of the tool structured output, when the server supplied one. */
  readonly outputSchema?: unknown;
}

/**
 * Input accepted by `indexExtensionCatalog`: the extension identity (used for
 * validation messages only) plus the discovered tool list in server order.
 */
export interface ExtensionCatalogIndexInput {
  /** Host-unique extension id the discovery belongs to. */
  readonly extensionId: string;
  /** Discovered tools in the server's advertised order. */
  readonly tools: readonly ExtensionCatalogDiscoveryTool[];
}

/**
 * One cataloged tool: the sanitized model-facing call name plus the wire facts
 * behind it. Absent optional facts stay absent (nothing is fabricated).
 */
export interface ExtensionCatalogTool {
  /** Sanitized model-facing call name (`deriveToolCallName(serverToolName)`). */
  readonly callName: string;
  /** Wire tool name exactly as the server advertised it. */
  readonly serverToolName: string;
  /** Optional server-supplied description. */
  readonly description?: string;
  /** Raw JSON Schema of the tool input, deep-frozen, when supplied. */
  readonly inputSchema?: unknown;
  /** Raw JSON Schema of the tool structured output, deep-frozen, when supplied. */
  readonly outputSchema?: unknown;
}

/**
 * One intra-server shadowed tool: a later server tool whose derived call name
 * was already claimed by an earlier tool of the same server. Shadowing is
 * deterministic (first occurrence in server order wins), recorded here, and
 * disclosed — never silently dropped and never auto-suffixed.
 */
export interface ExtensionCatalogShadow {
  /** Derived call name the earlier tool claimed. */
  readonly callName: string;
  /** Shadowed (later) wire tool name. */
  readonly serverToolName: string;
}

/**
 * Frozen catalog projection of one extension discovery. Catalogs are live
 * session state: they are never persisted and are rebuilt on every explicit
 * operator connect/reconnect.
 */
export interface ExtensionCatalog {
  /** Cataloged tools in server order, with intra-server shadows removed. */
  readonly tools: readonly ExtensionCatalogTool[];
  /** Intra-server shadowed tools in server order; empty when none collided. */
  readonly shadowedTools: readonly ExtensionCatalogShadow[];
  /** Deterministic non-crypto digest over the canonical ordered projection. */
  readonly digest: string;
}

/** One live catalog participating in `arbitrateExtensionCatalogs`. */
export interface ExtensionCatalogArbitrationInput {
  /** Host-unique extension id. */
  readonly extensionId: string;
  /** Connection-completion sequence number; the only arbitration ordering authority. */
  readonly sequence: number;
  /** The extension's discovered catalog. */
  readonly catalog: ExtensionCatalog;
}

/**
 * One call-name conflict of an extension against an earlier active extension:
 * the contested call name and the extension that claimed it first.
 */
export interface ExtensionCatalogConflict {
  /** Contested derived call name. */
  readonly callName: string;
  /** Earlier (sequence-smaller) extension that keeps the call name. */
  readonly otherExtensionId: string;
}

/**
 * Per-extension arbitration outcome. `active` means every cataloged call name
 * is exclusively claimed; `conflict` means the extension is not activated at
 * all (its other, non-conflicting call names are not exposed either) until a
 * later re-arbitration clears the conflicts.
 */
export interface ExtensionCatalogArbitration {
  /** Host-unique extension id. */
  readonly extensionId: string;
  /** Arbitration status: `active` when conflict-free, `conflict` otherwise. */
  readonly status: 'active' | 'conflict';
  /** Contested call names in catalog order; empty for `active`. */
  readonly conflicts: readonly ExtensionCatalogConflict[];
}

/**
 * Reconnect drift disclosure between two catalogs of one extension: call-name
 * sets (in catalog order) plus the digest pair, so an operator reconnect can
 * disclose exactly what changed. Never mutates grants by itself; grant
 * reconciliation stays with the safe-state reauthorization sweep.
 */
export interface ExtensionCatalogDiff {
  /** Call names present in the new catalog only, in new-catalog order. */
  readonly added: readonly string[];
  /** Call names present in the previous catalog only, in previous-catalog order. */
  readonly removed: readonly string[];
  /** Common call names whose tool facts differ, in new-catalog order. */
  readonly changed: readonly string[];
  /** Intra-server shadow call names present only in the new catalog, in new-catalog order. */
  readonly shadowedAdded: readonly string[];
  /** Intra-server shadow call names present only in the previous catalog, in previous-catalog order. */
  readonly shadowedRemoved: readonly string[];
  /** `true` when the relative order of the common call names changed. */
  readonly reordered: boolean;
  /** Digest pair: the previous catalog digest (`null` when there was none) and the new one. */
  readonly digests: {
    /** Digest of the previous catalog, or `null` when no previous catalog existed. */
    readonly previous: string | null;
    /** Digest of the new catalog. */
    readonly next: string;
  };
}

/** Persistence seam supplied by the composition root. */
export interface ExtensionRegistryStorageAdapter {
  /** Returns the persisted install records; unknown or invalid values are dropped. */
  load(): unknown;
  /** Receives the full frozen install-record projection after every mutation. */
  save(records: readonly ExtensionInstallRecord[]): void;
}

/** Construction options for `extensionRegistry.createExtensionRegistry()`. */
export interface ExtensionRegistryOptions {
  /**
   * Injected persistence adapter for install records. An absent adapter keeps
   * the registry in memory only; adapter load/save failures degrade to the
   * in-memory registry.
   */
  storage?: ExtensionRegistryStorageAdapter | null;
}

/**
 * Registry service returned by `extensionRegistry.createExtensionRegistry()`.
 *
 * Every read resolves from the live in-memory registry and returns frozen
 * copies; mutations validate first, persist through the injected adapter, and
 * fail closed on invalid or duplicate input.
 */
export interface ExtensionRegistry {
  /** Frozen copies of every install record, in registry order. */
  listExtensions(): readonly ExtensionInstallRecord[];
  /** Frozen copy of one install record, or `null` when unknown. */
  getExtension(id: string): ExtensionInstallRecord | null;
  /** Adds a new record (rejects invalid shapes and duplicate ids) and persists. */
  installExtension(record: ExtensionInstallRecord): ExtensionInstallRecord;
  /** Removes a record; returns `true` when one existed. Unknown ids are a `false` no-op. */
  removeExtension(id: string): boolean;
  /**
   * Replaces the registry state with a snapshot-authoritative, validated
   * record set: malformed entries are dropped and duplicate ids resolve
   * last-wins in place. Persists once when the applied set changed.
   */
  reconcile(records: unknown): readonly ExtensionInstallRecord[];
  /** Validates, freezes, and returns one complete attachment record. */
  createAttachment(candidate: RealmExtensionAttachment): RealmExtensionAttachment;
  /** Returns a frozen attachment list with the attachment appended; a duplicate extension id rejects. */
  attachExtension(
    attachments: readonly RealmExtensionAttachment[],
    attachment: RealmExtensionAttachment
  ): readonly RealmExtensionAttachment[];
  /** Returns a frozen attachment list without the named extension (a no-op list copy when absent). */
  detachExtension(
    attachments: readonly RealmExtensionAttachment[],
    extensionId: string
  ): readonly RealmExtensionAttachment[];
  /** Resolves a template's requests and tool references against this registry's installs plus the passed attachments. */
  resolve(
    request: ExtensionResolutionRequest,
    attachments: readonly RealmExtensionAttachment[]
  ): ExtensionResolution;
}
