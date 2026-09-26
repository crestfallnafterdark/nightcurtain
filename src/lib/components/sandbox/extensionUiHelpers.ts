/**
 * Extension management UI helpers (extension wave): the pure projections
 * behind the global extensions settings tab, the Realm attachment editor, the
 * missing-tools install/attach flow, the launcher/review extension disclosure,
 * and the P3.4 live connection surfaces (status chips, catalog count/digest,
 * fidelity badges, shadows/conflicts/drift/error disclosures, realm-level
 * ceiling views, and the live agent tool-scope universe).
 *
 * Resolution is never re-derived here: templates' requested extensions and
 * `<providerId>::<serverToolName>` references resolve through the real
 * `extensionRegistry.resolveExtensionRequests` against the passed install
 * records and Realm attachments, exactly as a launch would, so a displayed
 * "installed"/"attached"/"missing" state can never disagree with the store.
 * The install-draft validation mirrors the registry's own record rules (kind/
 * transport compatibility, reserved ids, non-empty fields) so the dialog fails
 * inline before the store's typed rejection.
 *
 * Live connection views are pure functions of the store's
 * `extensionConnections` projection (session-only, never persisted): the
 * helpers only read the frozen projections and never dial, install, or attach.
 * Fidelity badges classify schemas through the real projector
 * (`projectExtensionInputSchema` + `summarizeExtensionSchemaFidelity`), so the
 * disclosure can never disagree with the execution pipeline's synthesis.
 *
 * Nothing here connects, installs, or attaches: every projection is a pure
 * function of its arguments and every action is performed by the operator
 * through the component calling the store.
 */

import {
  projectExtensionInputSchema,
  summarizeExtensionSchemaFidelity
} from '../../sandbox/tools/extensionTools/index.ts';
import type { ExtensionSchemaFidelitySummary } from '../../sandbox/tools/extensionTools/index.ts';
import type {
  ExtensionConnectionProjection,
  ExtensionConnectionStatus
} from '../../sandbox/sandboxStore/index.svelte.ts';
import type {
  ExtensionCatalogDiff,
  ExtensionCatalogConflict,
  ExtensionCatalogShadow
} from '../../sandbox/extensionRegistry/index.ts';
import {
  deriveToolCallName
} from '../../sandbox/realmCatalog/index.ts';
import {
  resolveExtensionRequests
} from '../../sandbox/extensionRegistry/index.ts';
import type {
  ExtensionInstallRecord,
  ExtensionRequest,
  ExtensionResolution,
  ExtensionTransportHint,
  MissingExtension,
  MissingExtensionTool,
  RealmExtensionAttachment
} from '../../sandbox/extensionRegistry/index.ts';
import type { RealmProvider, RealmTemplate } from '../../sandbox/realmCatalog/index.ts';

/**
 * Object keys that must never become dynamic record keys (mirrors the
 * registry's reserved property names).
 */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
]);

/**
 * One-line display of an extension transport hint (`''` when absent or
 * malformed). Hints are descriptive: nothing is ever dialed from them.
 *
 * @param hint - Transport hint (any shape; unknown values read as `''`).
 * @returns Display summary (`https://…`, `stdio: command args`, `pack source`).
 *
 * @example
 * ```typescript
 * describeExtensionTransportHint({ kind: 'http', url: 'https://mcp.example.com' });
 * // 'https://mcp.example.com'
 * ```
 */
export function describeExtensionTransportHint(hint: unknown): string {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return '';
  const record = hint as Record<string, unknown>;
  if (record.kind === 'http') {
    return typeof record.url === 'string' ? record.url : '';
  }
  if (record.kind === 'stdio') {
    const command = typeof record.command === 'string' ? record.command : '';
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    if (command.length === 0) return '';
    return args.length > 0 ? `stdio: ${command} ${args.join(' ')}` : `stdio: ${command}`;
  }
  if (record.kind === 'pack') {
    return typeof record.source === 'string' ? `pack: ${record.source}` : '';
  }
  return '';
}

/**
 * Live resolution state of one requested extension against the host's install
 * records and one Realm's attachments.
 *
 * `not-attached` is the launch-relevant state (installed but not approved in
 * this Realm); `unavailable` marks an attachment whose extension is not
 * currently installed or usable; `conflict` is a catalog-time call-name
 * conflict (P3) the operator must resolve.
 */
export type RealmExtensionResolutionState =
  | 'active'
  | 'conflict'
  | 'unavailable'
  | 'not-attached'
  | 'not-installed';

/**
 * Display view of one resolution state (badge label plus explanation).
 */
export interface RealmExtensionStateView {
  /** Machine state. */
  readonly state: RealmExtensionResolutionState;
  /** Short badge label (`Active`, `Not attached`, …). */
  readonly label: string;
  /** Plain-language explanation. */
  readonly description: string;
}

/**
 * Describes one extension resolution state for the review/settings surfaces.
 *
 * @param state - Resolution state.
 * @returns The badge label plus explanation.
 *
 * @example
 * ```typescript
 * describeRealmExtensionState('not-installed').label; // 'Not installed'
 * ```
 */
export function describeRealmExtensionState(state: RealmExtensionResolutionState): RealmExtensionStateView {
  if (state === 'active') {
    return {
      state,
      label: 'Active',
      description: 'Attached in this Realm and resolved: its tools are accepted here.'
    };
  }
  if (state === 'conflict') {
    return {
      state,
      label: 'Conflict',
      description: 'A call-name conflict with another active extension — resolve it before the tools activate (catalog-time resolution).'
    };
  }
  if (state === 'unavailable') {
    return {
      state,
      label: 'Unavailable',
      description: 'The extension is not currently installed or usable, so its tools stay unavailable.'
    };
  }
  if (state === 'not-attached') {
    return {
      state,
      label: 'Installed, not attached',
      description: 'Installed globally but not approved in this Realm — attach it to enable its tools.'
    };
  }
  return {
    state,
    label: 'Not installed',
    description: 'No global install record — install it before it can be attached.'
  };
}

/**
 * Whether a resolution state is currently missing its tools in a Realm.
 *
 * @param state - Resolution state.
 * @returns `true` for every state except `active`.
 */
export function isRealmExtensionStateMissing(state: RealmExtensionResolutionState): boolean {
  return state !== 'active';
}

/**
 * Collects a template's requested extensions from its `providers` block, in
 * declared order with first-wins deduplication — the same projection the store
 * computes at launch, expressed over the structural template.
 *
 * @param template - Template (structural; malformed providers skipped).
 * @returns Frozen requests with transport hints.
 */
export function collectRealmExtensionRequests(
  template: RealmTemplate | null | undefined
): readonly ExtensionRequest[] {
  const providers = template && Array.isArray(template.providers) ? template.providers : [];
  const requests: ExtensionRequest[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    if (typeof provider.id !== 'string' || provider.id.trim().length === 0) continue;
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    let transportHint: ExtensionTransportHint | undefined;
    if (provider.kind === 'mcp') {
      const transport = provider.transport;
      if (transport && transport.kind === 'http') {
        transportHint = { kind: 'http', url: transport.url };
      } else if (transport && transport.kind === 'stdio') {
        transportHint = {
          kind: 'stdio',
          command: transport.command,
          ...(Array.isArray(transport.args) ? { args: [...transport.args] } : {})
        };
      }
    } else if (provider.kind === 'pack' && typeof provider.source === 'string' && provider.source.trim().length > 0) {
      transportHint = { kind: 'pack', source: provider.source };
    }
    requests.push({
      id: provider.id,
      kind: provider.kind,
      ...(transportHint !== undefined ? { transportHint } : {})
    });
  }
  return Object.freeze(requests);
}

/**
 * Collects every `<providerId>::<serverToolName>` reference declared across a
 * template's agent tool profiles, in declared order with exact-duplicate
 * deduplication.
 *
 * @param template - Template (structural; malformed profiles skipped).
 * @returns Frozen reference strings.
 */
export function collectRealmExtensionToolReferences(
  template: RealmTemplate | null | undefined
): readonly string[] {
  const references: string[] = [];
  const agents = template && Array.isArray(template.agents) ? template.agents : [];
  for (const spec of agents) {
    const tools = spec && spec.toolProfile ? spec.toolProfile.tools : undefined;
    if (!Array.isArray(tools)) continue;
    for (const entry of tools) {
      if (typeof entry !== 'string') continue;
      if (entry.indexOf('::') === -1) continue;
      if (!references.includes(entry)) references.push(entry);
    }
  }
  return Object.freeze(references);
}

/**
 * One requested extension with its live resolution state.
 */
export interface RealmExtensionRequestView {
  /** Requested extension id. */
  readonly id: string;
  /** Requested kind. */
  readonly kind: 'mcp' | 'pack';
  /** Declared display name (`''` when absent). */
  readonly displayName: string;
  /** Transport hint summary declared by the request (`''` when none). */
  readonly declaredTransportSummary: string;
  /** Declared HTTP URL (used to prefill the install dialog; `''` otherwise). */
  readonly declaredUrl: string;
  /** Declared install source hint for a pack request (`''` otherwise). */
  readonly declaredSource: string;
  /** Whether a global install record exists. */
  readonly installed: boolean;
  /** Install-record status (`''` when not installed). */
  readonly installStatus: 'installed' | 'unavailable' | 'error' | '';
  /** Install source of the record (`''` when not installed). */
  readonly installSource: 'operator' | 'template-assist' | '';
  /** Operator-approved server URL of the record (`''` when absent). */
  readonly approvedUrl: string;
  /** Bound vault credential id of the record (`''` when absent). */
  readonly credentialId: string;
  /** Realm attachment record (`null` when the Realm does not attach the extension). */
  readonly attachment: RealmExtensionAttachment | null;
  /** Live resolution state. */
  readonly state: RealmExtensionResolutionState;
  /** Whether the state is currently missing its tools. */
  readonly missing: boolean;
  /** Third-party trust label rendered wherever the request is reviewed. */
  readonly thirdPartyLabel: string;
  /** Live connection status (`'disconnected'` when no live session exists). */
  readonly connectionStatus: ExtensionConnectionStatus | 'disconnected';
  /** Whether a conflict-free live catalog currently exists. */
  readonly connected: boolean;
  /** Live catalog tool count (`0` when no catalog). */
  readonly liveToolCount: number;
  /** Fidelity badge of the live catalog (`''` when clean or no catalog). */
  readonly fidelityBadge: string;
  /** Fidelity state of the live catalog (`''` when no catalog). */
  readonly fidelityState: 'clean' | 'projected' | 'degraded' | '';
  /**
   * Requested-but-not-connected / conflict / failure disclosure (`''` when
   * connected, not installed, or nothing actionable).
   */
  readonly disclosure: string;
}

/**
 * Projection of a template's requested extensions against host state.
 */
export interface RealmExtensionRequestViews {
  /** Whether the projection built (resolution input stays consistent). */
  readonly ok: boolean;
  /** Inline failure text; empty when `ok`. */
  readonly error: string;
  /** Request views in declared request order. */
  readonly requests: readonly RealmExtensionRequestView[];
  /** Missing extensions reported by the real resolution (declared order). */
  readonly missingExtensions: readonly MissingExtension[];
  /** Missing declared tool references reported by the real resolution. */
  readonly missingTools: readonly MissingExtensionTool[];
}

/**
 * Builds the requested-extension views for one template: declared requests,
 * install-record metadata, Realm attachment, and the live resolution state
 * computed by the real `extensionRegistry` resolution, plus the live
 * connection disclosure (status, catalog fidelity, requested-but-not-connected
 * copy) when connection projections are supplied.
 *
 * @param template - Template whose `providers` are projected.
 * @param installs - Global install records (the store's `listExtensions()`).
 * @param attachments - Realm attachments (`[]` for a pre-launch review).
 * @param connections - Live connection projections (`[]` for a pre-launch review).
 * @returns The projection; an inconsistent resolution input fails inline.
 *
 * @example
 * ```typescript
 * const views = buildRealmExtensionRequestViews(template, sandboxStore.listExtensions());
 * views.requests.filter((request) => request.missing).map((request) => request.id);
 * ```
 */
export function buildRealmExtensionRequestViews(
  template: RealmTemplate | null | undefined,
  installs: readonly ExtensionInstallRecord[],
  attachments: readonly RealmExtensionAttachment[] = [],
  connections: readonly ExtensionConnectionProjection[] = []
): RealmExtensionRequestViews {
  const requests = collectRealmExtensionRequests(template);
  if (requests.length === 0) {
    return { ok: true, error: '', requests: [], missingExtensions: [], missingTools: [] };
  }
  let resolution: ExtensionResolution;
  try {
    resolution = resolveExtensionRequests({
      requests,
      toolReferences: collectRealmExtensionToolReferences(template),
      installs,
      attachments
    });
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error) || 'The template extension requests could not be resolved.',
      requests: [],
      missingExtensions: [],
      missingTools: []
    };
  }

  const installsById = new Map(installs.map((record) => [record.id, record] as const));
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.extensionId, attachment] as const));
  const connectionsById = new Map<string, ExtensionConnectionProjection>();
  for (const connection of Array.isArray(connections) ? connections : []) {
    if (connection && typeof connection.extensionId === 'string' && !connectionsById.has(connection.extensionId)) {
      connectionsById.set(connection.extensionId, connection);
    }
  }
  const views: RealmExtensionRequestView[] = requests.map((request) => {
    const record = installsById.get(request.id) ?? null;
    const attachment = attachmentsById.get(request.id) ?? null;
    const state = resolutionStateFor(record !== null, attachment);
    const hint = record ? record.transportHint : request.transportHint;
    const connection = record !== null ? connectionsById.get(request.id) ?? null : null;
    const connectionStatus: ExtensionConnectionStatus | 'disconnected' = connection ? connection.status : 'disconnected';
    const connected = connection !== null && connection.status === 'connected' && connection.catalog !== null
      && (connection.conflicts?.length ?? 0) === 0;
    const fidelity = connected ? buildExtensionCatalogFidelityView(connection) : null;
    let disclosure = '';
    if (record !== null) {
      if (connection === null) {
        disclosure = attachment !== null
          ? 'Installed and attached, but not connected — its tools stay unavailable until an operator connects it (Sandbox Settings → Extensions).'
          : 'Installed but not attached — approve/attach it in this Realm to enable its tools.';
      } else if (connection.status === 'conflict') {
        disclosure = 'Live catalog conflicts with an earlier extension — resolve it (disconnect or reconnect) before its tools activate.';
      } else if (connection.status === 'connecting') {
        disclosure = 'Connection in flight — the catalog appears when discovery completes.';
      } else if (connection.status === 'error') {
        const code = describeExtensionConnectionError(connection.error).code;
        disclosure = `The last connection attempt failed (${code}). Reconnect from Sandbox Settings → Extensions.`;
      } else if (!connected) {
        disclosure = 'The live catalog is not active for this attachment — resolve the conflict before its tools activate.';
      }
    }
    return {
      id: request.id,
      kind: request.kind,
      displayName: record && typeof record.displayName === 'string' ? record.displayName : '',
      declaredTransportSummary: describeExtensionTransportHint(hint),
      declaredUrl: hint && hint.kind === 'http' ? hint.url : '',
      declaredSource: hint && hint.kind === 'pack' ? hint.source : '',
      installed: record !== null,
      installStatus: record ? record.status : '',
      installSource: record ? record.installSource : '',
      approvedUrl: record && typeof record.approvedUrl === 'string' ? record.approvedUrl : '',
      credentialId: record && typeof record.credentialId === 'string' ? record.credentialId : '',
      attachment,
      state,
      missing: isRealmExtensionStateMissing(state),
      thirdPartyLabel: EXTENSION_THIRD_PARTY_LABEL,
      connectionStatus,
      connected,
      liveToolCount: connected && connection && connection.catalog ? Object.keys(connection.catalog).length : 0,
      fidelityBadge: fidelity ? fidelity.badge : '',
      fidelityState: fidelity ? fidelity.state : '',
      disclosure
    };
  });
  return {
    ok: true,
    error: '',
    requests: Object.freeze(views),
    missingExtensions: resolution.missingExtensions,
    missingTools: resolution.missingTools
  };
}

/**
 * Resolves the live state of one extension from install/attachment presence.
 *
 * @param installed - Whether a global install record exists.
 * @param attachment - Realm attachment, or `null`.
 * @returns The resolution state.
 */
function resolutionStateFor(
  installed: boolean,
  attachment: RealmExtensionAttachment | null
): RealmExtensionResolutionState {
  if (!installed) return 'not-installed';
  if (!attachment) return 'not-attached';
  if (attachment.status === 'conflict') return 'conflict';
  if (attachment.status === 'active') return 'active';
  return 'unavailable';
}

/**
 * One declared `<providerId>::<serverToolName>` reference rendered for review.
 */
export interface RealmExtensionReferenceView {
  /** Template agent key declaring the reference. */
  readonly agentKey: string;
  /** Display name of the declaring agent (falls back to the key). */
  readonly agentName: string;
  /** Declared reference verbatim (`<providerId>::<serverToolName>`). */
  readonly reference: string;
  /** Extension id the reference names. */
  readonly extensionId: string;
  /** Server tool name segment. */
  readonly serverToolName: string;
  /** Derived sanitized model-facing call name. */
  readonly callName: string;
  /** Live extension resolution state. */
  readonly state: RealmExtensionResolutionState;
  /**
   * Reference resolution: `resolved` (extension active and selection covers
   * the call name), `missing` (extension not installed/attached), or
   * `excluded` (the attachment's tool selection does not name the call name).
   */
  readonly referenceState: 'resolved' | 'missing' | 'excluded';
}

/**
 * Projection of a template's per-agent extension references.
 */
export interface RealmExtensionReferenceViews {
  /** Whether the projection built. */
  readonly ok: boolean;
  /** Inline failure text; empty when `ok`. */
  readonly error: string;
  /** Reference views in template agent order, then declared profile order. */
  readonly references: readonly RealmExtensionReferenceView[];
  /** Missing declared tool references reported by the real resolution. */
  readonly missingTools: readonly MissingExtensionTool[];
}

/**
 * Builds the per-agent `<providerId>::<serverToolName>` reference views with
 * their live resolution state, so the review can disclose exactly which
 * extension tools an agent would receive.
 *
 * @param template - Template whose agent profiles are projected.
 * @param installs - Global install records.
 * @param attachments - Realm attachments (`[]` for a pre-launch review).
 * @returns The projection; an inconsistent resolution input fails inline.
 *
 * @example
 * ```typescript
 * const views = buildRealmExtensionReferenceViews(template, [], []);
 * views.references[0].callName; // 'docs_search'
 * ```
 */
export function buildRealmExtensionReferenceViews(
  template: RealmTemplate | null | undefined,
  installs: readonly ExtensionInstallRecord[],
  attachments: readonly RealmExtensionAttachment[] = []
): RealmExtensionReferenceViews {
  const requests = collectRealmExtensionRequests(template);
  const agents = template && Array.isArray(template.agents) ? template.agents : [];
  const declared: Array<{ agentKey: string; agentName: string; reference: string }> = [];
  for (const spec of agents) {
    if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') continue;
    const tools = spec.toolProfile ? spec.toolProfile.tools : undefined;
    if (!Array.isArray(tools)) continue;
    for (const entry of tools) {
      if (typeof entry !== 'string' || entry.indexOf('::') === -1) continue;
      declared.push({
        agentKey: spec.key,
        agentName: typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : spec.key,
        reference: entry
      });
    }
  }
  if (declared.length === 0) {
    return { ok: true, error: '', references: [], missingTools: [] };
  }
  let resolution: ExtensionResolution;
  try {
    resolution = resolveExtensionRequests({
      requests,
      toolReferences: collectRealmExtensionToolReferences(template),
      installs,
      attachments
    });
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error) || 'The template extension tool references could not be resolved.',
      references: [],
      missingTools: []
    };
  }
  const missingByReference = new Map(resolution.missingTools.map((tool) => [tool.reference, tool] as const));
  const installsById = new Map(installs.map((record) => [record.id, record] as const));
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.extensionId, attachment] as const));
  const references: RealmExtensionReferenceView[] = declared.map((entry) => {
    const separator = entry.reference.indexOf('::');
    const extensionId = entry.reference.slice(0, separator);
    const serverToolName = entry.reference.slice(separator + 2);
    const parsedCallName = deriveToolCallName(serverToolName);
    const missingTool = missingByReference.get(entry.reference) ?? null;
    const attachment = attachmentsById.get(extensionId) ?? null;
    const state = resolutionStateFor(installsById.has(extensionId), attachment);
    return {
      agentKey: entry.agentKey,
      agentName: entry.agentName,
      reference: entry.reference,
      extensionId,
      serverToolName,
      callName: parsedCallName,
      state,
      referenceState: missingTool
        ? (missingTool.reason === 'selection-excluded' ? 'excluded' : 'missing')
        : 'resolved'
    };
  });
  return {
    ok: true,
    error: '',
    references: Object.freeze(references),
    missingTools: resolution.missingTools
  };
}

/**
 * One missing/unattached requested extension with its available operator
 * actions. The flow never acts on its own: the component performs exactly the
 * action the operator clicks.
 */
export interface MissingExtensionFlowView {
  /** Requested extension id. */
  readonly extensionId: string;
  /** Requested kind. */
  readonly kind: 'mcp' | 'pack';
  /** Declared display name (`''` when none is known). */
  readonly displayName: string;
  /** Live resolution state. */
  readonly state: RealmExtensionResolutionState;
  /** Live missing reason (`''` when the extension now resolves). */
  readonly reason: 'not-installed' | 'not-attached' | '';
  /** Transport hint summary declared by the template request (`''` when unknown). */
  readonly transportHintSummary: string;
  /** Declared HTTP URL for the install-dialog prefill (`''` when none). */
  readonly declaredUrl: string;
  /** Template author comment (the template's `notes`, trimmed; `''` when absent). */
  readonly authorComment: string;
  /** Template id the request came from (`''` when not template-launched). */
  readonly templateId: string;
  /** Whether the extension is installed globally. */
  readonly installed: boolean;
  /** Whether the install action applies (not installed). */
  readonly canInstall: boolean;
  /** Whether the attach action applies (installed, no active attachment). */
  readonly canAttach: boolean;
  /** Third-party trust label rendered wherever the row is reviewed. */
  readonly thirdPartyLabel: string;
  /** Install-dialog draft prefilled from the template request (or the install record when re-installing). */
  readonly installPrefill: ExtensionInstallDraft;
}

/**
 * Builds the missing-tools flow views from a Realm's recorded missing
 * extension ids (or a launch receipt's missing list) and the template that
 * requested them.
 *
 * State is live: an extension installed (and attached) after the launch
 * resolves to `active` with an empty reason, so a stale `missingExtensions`
 * entry never renders as a false warning. The template supplies the request's
 * transport hint and author comment for the prefilled install dialog; an id
 * with no template declaration falls back to the install record's kind.
 *
 * @param options - Missing ids, the requesting template, install records, and Realm attachments.
 * @returns Flow views in input order.
 *
 * @example
 * ```typescript
 * const flow = buildMissingExtensionFlowViews({
 *   missingExtensionIds: realm.instance?.missingExtensions ?? [],
 *   template,
 *   installs: sandboxStore.listExtensions()
 * });
 * flow[0].canInstall; // true while the extension is not installed
 * ```
 */
export function buildMissingExtensionFlowViews(options: {
  readonly missingExtensionIds: readonly string[] | null | undefined;
  readonly template: RealmTemplate | null | undefined;
  readonly installs: readonly ExtensionInstallRecord[];
  readonly attachments?: readonly RealmExtensionAttachment[];
}): MissingExtensionFlowView[] {
  const ids = Array.isArray(options?.missingExtensionIds)
    ? options.missingExtensionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (ids.length === 0) return [];
  const requestViews = buildRealmExtensionRequestViews(
    options.template,
    options.installs,
    options.attachments ?? []
  );
  const byId = new Map<string, RealmExtensionRequestView>(
    (requestViews.ok ? requestViews.requests : []).map((view) => [view.id, view] as const)
  );
  const installsById = new Map(options.installs.map((record) => [record.id, record] as const));
  const attachmentsById = new Map(
    (options.attachments ?? []).map((attachment) => [attachment.extensionId, attachment] as const)
  );
  const templateId = options.template && typeof options.template.id === 'string' ? options.template.id : '';
  const authorComment = options.template && typeof options.template.notes === 'string'
    ? options.template.notes.trim().slice(0, 600)
    : '';
  const providerById = new Map<string, RealmProvider>();
  const providers = options.template && Array.isArray(options.template.providers) ? options.template.providers : [];
  for (const provider of providers) {
    if (provider && typeof provider === 'object' && typeof provider.id === 'string' && !providerById.has(provider.id)) {
      providerById.set(provider.id, provider);
    }
  }
  const views: MissingExtensionFlowView[] = [];
  for (const id of [...new Set(ids)]) {
    const requestView = byId.get(id) ?? null;
    const record = installsById.get(id) ?? null;
    const attachment = attachmentsById.get(id) ?? null;
    const installed = record !== null;
    const state = resolutionStateFor(installed, attachment);
    const reason = state === 'not-installed' ? 'not-installed' : state === 'not-attached' ? 'not-attached' : '';
    const declaredTransportSummary = requestView
      ? requestView.declaredTransportSummary
      : record
        ? describeExtensionTransportHint(record.transportHint)
        : '';
    const provider = providerById.get(id) ?? null;
    const basePrefill = provider
      ? buildExtensionInstallPrefill(provider, {
          templateId,
          templateNotes: options.template ? options.template.notes : undefined,
          installSource: 'template-assist'
        })
      : buildExtensionInstallPrefillFromRecord(record);
    const installPrefill: ExtensionInstallDraft = record
      ? {
          ...basePrefill,
          id: basePrefill.id || id,
          displayName: basePrefill.displayName || (typeof record.displayName === 'string' ? record.displayName : ''),
          credentialId: basePrefill.credentialId || (typeof record.credentialId === 'string' ? record.credentialId : ''),
          approvedUrl: basePrefill.approvedUrl || (typeof record.approvedUrl === 'string' ? record.approvedUrl : '')
        }
      : { ...basePrefill, id: basePrefill.id || id };
    views.push({
      extensionId: id,
      kind: requestView ? requestView.kind : record ? record.kind : 'mcp',
      displayName: requestView ? requestView.displayName : '',
      state,
      reason,
      transportHintSummary: declaredTransportSummary,
      declaredUrl: requestView ? requestView.declaredUrl : (record && record.transportHint.kind === 'http' ? record.transportHint.url : ''),
      authorComment,
      templateId,
      installed,
      canInstall: !installed,
      canAttach: installed && attachment === null && state !== 'active',
      thirdPartyLabel: EXTENSION_THIRD_PARTY_LABEL,
      installPrefill
    });
  }
  return views;
}

/**
 * Builds the install-dialog draft from an existing install record: the record's
 * identity, kind, transport fields, optional display name, approved URL, and
 * bound credential id, with the operator install source.
 *
 * @param record - Install record, or `null`/`undefined`.
 * @returns A prefilled draft; a missing record yields a blank draft.
 *
 * @example
 * ```typescript
 * buildExtensionInstallPrefillFromRecord(record).transportKind; // 'http'
 * ```
 */
export function buildExtensionInstallPrefillFromRecord(
  record: ExtensionInstallRecord | null | undefined
): ExtensionInstallDraft {
  if (!record || typeof record !== 'object') return emptyExtensionInstallDraft();
  const hint = record.transportHint;
  const draft = emptyExtensionInstallDraft();
  const displayName = typeof record.displayName === 'string' ? record.displayName : '';
  const approvedUrl = typeof record.approvedUrl === 'string' ? record.approvedUrl : '';
  const credentialId = typeof record.credentialId === 'string' ? record.credentialId : '';
  if (record.kind === 'pack' || hint.kind === 'pack') {
    return {
      ...draft,
      id: record.id,
      kind: 'pack',
      displayName,
      transportKind: 'pack',
      source: hint.kind === 'pack' ? hint.source : '',
      approvedUrl,
      credentialId
    };
  }
  if (hint.kind === 'stdio') {
    return {
      ...draft,
      id: record.id,
      kind: 'mcp',
      displayName,
      transportKind: 'stdio',
      command: hint.command,
      argsText: hint.args ? [...hint.args].join('\n') : '',
      approvedUrl,
      credentialId
    };
  }
  return {
    ...draft,
    id: record.id,
    kind: 'mcp',
    displayName,
    transportKind: 'http',
    url: hint.kind === 'http' ? hint.url : '',
    approvedUrl,
    credentialId
  };
}

/**
 * Form draft of the extension install dialog. All values are raw strings; the
 * dialog maps them to the store's install input through
 * {@link validateExtensionInstallDraft}.
 */
export interface ExtensionInstallDraft {
  /** Extension id. */
  id: string;
  /** Extension kind (`'mcp'` or `'pack'`). */
  kind: string;
  /** Optional operator-facing display name. */
  displayName: string;
  /** Transport discriminator (`'http'`, `'stdio'`, or `'pack'`). */
  transportKind: string;
  /** HTTP server URL (http transports). */
  url: string;
  /** Executable/command (stdio transports). */
  command: string;
  /** Command arguments, one per line (stdio transports). */
  argsText: string;
  /** Install source hint (pack transports). */
  source: string;
  /** Operator-approved server URL (optional). */
  approvedUrl: string;
  /** Optional bound vault credential id. */
  credentialId: string;
  /** Install source recorded on the record (`'operator'` or `'template-assist'`). */
  installSource: string;
}

/**
 * Validated install input produced from a draft: structurally identical to the
 * store's `installExtension` input (with the operator-stamped fields explicit).
 */
export interface ExtensionInstallInput {
  /** Extension id. */
  readonly id: string;
  /** Extension kind. */
  readonly kind: 'mcp' | 'pack';
  /** Optional display name. */
  readonly displayName?: string;
  /** Transport hint. */
  readonly transportHint: ExtensionTransportHint;
  /** Optional bound credential id. */
  readonly credentialId?: string;
  /** Optional approved server URL. */
  readonly approvedUrl?: string;
  /** Recorded install source. */
  readonly installSource: 'operator' | 'template-assist';
}

/**
 * Result of validating an install draft.
 */
export type ExtensionInstallDraftResult =
  | { readonly ok: true; readonly input: ExtensionInstallInput }
  | { readonly ok: false; readonly error: string; readonly fieldErrors: Record<string, string> };

/**
 * Builds the install-dialog draft prefilled from one template provider
 * request: id, kind, kind-specific transport fields, and the declared HTTP URL
 * as the operator-approval prefill. `approvedUrl` is prefilled from the URL
 * because the operator confirms it by installing; every field stays editable.
 *
 * @param provider - Declared template provider (structural; malformed reads empty).
 * @param options - Template id, author comment source, and install source.
 * @returns A fresh prefilled draft.
 *
 * @example
 * ```typescript
 * const draft = buildExtensionInstallPrefill(
 *   { kind: 'mcp', id: 'acme-scoring', transport: { kind: 'http', url: 'https://mcp.example.com' } },
 *   { templateId: 'demo', templateNotes: 'Scoring tools.' }
 * );
 * draft.installSource; // 'template-assist'
 * ```
 */
export function buildExtensionInstallPrefill(
  provider: unknown,
  options: {
    readonly templateId?: unknown;
    readonly templateNotes?: unknown;
    readonly installSource?: 'operator' | 'template-assist';
  } = {}
): ExtensionInstallDraft {
  const record = provider && typeof provider === 'object' && !Array.isArray(provider)
    ? (provider as Record<string, unknown>)
    : {};
  const kind = record.kind === 'pack' ? 'pack' : 'mcp';
  const id = typeof record.id === 'string' ? record.id : '';
  const templateId = typeof options.templateId === 'string' ? options.templateId : '';
  let draft = emptyExtensionInstallDraft();
  draft = { ...draft, id, kind };
  if (kind === 'mcp') {
    const transport = record.transport && typeof record.transport === 'object' && !Array.isArray(record.transport)
      ? (record.transport as Record<string, unknown>)
      : {};
    if (transport.kind === 'stdio') {
      draft = {
        ...draft,
        transportKind: 'stdio',
        command: typeof transport.command === 'string' ? transport.command : '',
        argsText: Array.isArray(transport.args)
          ? transport.args.filter((arg): arg is string => typeof arg === 'string').join('\n')
          : ''
      };
    } else {
      const url = typeof transport.url === 'string' ? transport.url : '';
      draft = { ...draft, transportKind: 'http', url, approvedUrl: url };
    }
  } else {
    draft = {
      ...draft,
      transportKind: 'pack',
      source: typeof record.source === 'string' ? record.source : ''
    };
  }
  return {
    ...draft,
    installSource: options.installSource ?? (templateId.length > 0 ? 'template-assist' : 'operator')
  };
}

/**
 * Builds an empty operator install draft (schema defaults: MCP over HTTP).
 *
 * @returns A fresh blank draft with the operator install source.
 */
export function emptyExtensionInstallDraft(): ExtensionInstallDraft {
  return {
    id: '',
    kind: 'mcp',
    displayName: '',
    transportKind: 'http',
    url: '',
    command: '',
    argsText: '',
    source: '',
    approvedUrl: '',
    credentialId: '',
    installSource: 'operator'
  };
}

/**
 * Validates an install draft and maps it to the store's install input,
 * mirroring the registry's record rules so the dialog fails inline: a
 * non-empty non-reserved id, a kind-compatible transport, the kind's required
 * transport fields, and trimmed optional fields (omitted when empty).
 *
 * @param draft - Raw dialog draft (any shape; malformed reads as blanks).
 * @returns The validated input, or the first error plus per-field errors.
 *
 * @example
 * ```typescript
 * const result = validateExtensionInstallDraft({
 *   ...emptyExtensionInstallDraft(),
 *   id: 'acme-scoring',
 *   url: 'https://mcp.example.com'
 * });
 * result.ok; // true
 * ```
 */
export function validateExtensionInstallDraft(draft: unknown): ExtensionInstallDraftResult {
  const record = draft && typeof draft === 'object' && !Array.isArray(draft)
    ? (draft as Record<string, unknown>)
    : {};
  const read = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const fieldErrors: Record<string, string> = {};
  const fail = (): ExtensionInstallDraftResult => {
    const firstKey = Object.keys(fieldErrors)[0];
    return { ok: false, error: fieldErrors[firstKey], fieldErrors };
  };

  const id = read('id').trim();
  if (id.length === 0) {
    fieldErrors.id = 'An extension id is required.';
  } else if (RESERVED_PROPERTY_NAMES.has(id)) {
    fieldErrors.id = `"${id}" is a reserved property name and cannot be an extension id.`;
  }

  const kindValue = read('kind');
  const kind: 'mcp' | 'pack' | null = kindValue === 'pack' ? 'pack' : kindValue === 'mcp' ? 'mcp' : null;
  if (kind === null) {
    fieldErrors.kind = "Choose the extension kind ('mcp' or 'pack').";
  }
  if (kind === null || Object.keys(fieldErrors).length > 0) return fail();

  let transportHint: ExtensionTransportHint;
  if (kind === 'pack') {
    const source = read('source').trim();
    if (source.length === 0) {
      fieldErrors.source = 'A pack install source is required (where the pack can be obtained).';
    }
    if (Object.keys(fieldErrors).length > 0) return fail();
    transportHint = { kind: 'pack', source };
  } else {
    const transportKind = read('transportKind') === 'stdio' ? 'stdio' : 'http';
    if (transportKind === 'stdio') {
      const command = read('command').trim();
      if (command.length === 0) {
        fieldErrors.command = 'A stdio command is required.';
      }
      if (Object.keys(fieldErrors).length > 0) return fail();
      const args = read('argsText')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      transportHint = { kind: 'stdio', command, ...(args.length > 0 ? { args } : {}) };
    } else {
      const url = read('url').trim();
      if (url.length === 0) {
        fieldErrors.url = 'A transport URL is required.';
      }
      if (Object.keys(fieldErrors).length > 0) return fail();
      transportHint = { kind: 'http', url };
    }
  }

  const displayName = read('displayName').trim();
  const credentialId = read('credentialId').trim();
  const approvedUrl = read('approvedUrl').trim();
  const installSource = read('installSource') === 'template-assist' ? 'template-assist' : 'operator';
  return {
    ok: true,
    input: {
      id,
      kind,
      transportHint,
      ...(displayName.length > 0 ? { displayName } : {}),
      ...(credentialId.length > 0 ? { credentialId } : {}),
      ...(approvedUrl.length > 0 ? { approvedUrl } : {}),
      installSource
    }
  };
}

/**
 * Copy line of the third-party trust disclosure shown wherever extensions are
 * reviewed.
 */
export interface RealmExtensionDisclosureLine {
  /** Stable line key (`third-party`, `no-connection`, …). */
  readonly key: 'third-party' | 'no-connection' | 'urls-hints' | 'credentials-user-side';
  /** Short heading. */
  readonly title: string;
  /** Plain-language body. */
  readonly body: string;
}

/**
 * The third-party trust disclosure the launcher/review surfaces render before
 * an extension can be approved: tool metadata is third-party content, nothing
 * connects automatically, declared URLs are hints, and credentials stay
 * user-side (plaintext credentials are refused).
 */
export const REALM_EXTENSION_TRUST_DISCLOSURE: readonly RealmExtensionDisclosureLine[] = Object.freeze([
  Object.freeze({
    key: 'third-party',
    title: 'Third-party content',
    body: 'Tool names, descriptions, and schemas come from the extension server, not from this host — treat them as untrusted third-party content.'
  }),
  Object.freeze({
    key: 'no-connection',
    title: 'Nothing connects automatically',
    body: 'Installing or approving records operator intent only: no server is dialed, no tool runs, and no credential is sent in this wave.'
  }),
  Object.freeze({
    key: 'urls-hints',
    title: 'URLs are hints until approved',
    body: 'A template\u2019s declared URL is a review hint: it is never fetched until you install and approve it through the operator install flow.'
  }),
  Object.freeze({
    key: 'credentials-user-side',
    title: 'Credentials stay user-side',
    body: 'Credential binding is yours: pick a vault entry at install time (an id only, never a secret). Plaintext credentials over http are refused.'
  })
]);

/** Operator-principal remediation shown for permission-denied failures. */
const OPERATOR_HINT =
  'The operator (Director) principal is required for that extension action. Reload with the Director registered and retry.';

/**
 * Describes a failed `removeExtension()` call, surfacing the typed
 * `ERR_STORE_EXTENSION_ATTACHED` refusal with its detach-first guidance so a
 * blocked removal never reads as a silent failure.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeExtensionRemovalError(
  error: unknown,
  fallback = 'Failed to remove the extension.'
): string {
  const shape = shapeOf(error);
  if (isPermissionDenied(error, shape)) return OPERATOR_HINT;
  const base = messageOf(error) || fallback;
  if (shape.code === 'ERR_STORE_EXTENSION_ATTACHED') {
    return `${base} Detach it from every Realm before removing the install record.`;
  }
  return base;
}

/**
 * Describes a failed `installExtension()` call, including the typed
 * already-installed refusal.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeExtensionInstallError(
  error: unknown,
  fallback = 'Failed to install the extension.'
): string {
  const shape = shapeOf(error);
  if (isPermissionDenied(error, shape)) return OPERATOR_HINT;
  const base = messageOf(error) || fallback;
  if (shape.code === 'ERR_STORE_EXTENSION_ALREADY_INSTALLED') {
    return `${base} Remove the existing install record or choose a different id.`;
  }
  return base;
}

/**
 * Describes a failed `attachExtension()` call, including the typed
 * not-installed and already-attached refusals.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeExtensionAttachError(
  error: unknown,
  fallback = 'Failed to attach the extension to this Realm.'
): string {
  const shape = shapeOf(error);
  if (isPermissionDenied(error, shape)) return OPERATOR_HINT;
  const base = messageOf(error) || fallback;
  if (shape.code === 'ERR_STORE_EXTENSION_NOT_INSTALLED') {
    return `${base} Install it globally first, then attach it.`;
  }
  if (shape.code === 'ERR_STORE_EXTENSION_ALREADY_ATTACHED') {
    return `${base} The existing attachment is shown above; detach it first to change the tool selection.`;
  }
  return base;
}

/**
 * Extracts the human-readable message from an unknown thrown value.
 *
 * @param error - Thrown value.
 * @returns Trimmed message, or an empty string.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return '';
}

/**
 * Reads a thrown value as a string-keyed record for coded-error field access.
 *
 * @param error - Thrown value.
 * @returns The value as a record, or an empty object for primitives.
 */
function shapeOf(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
}

/**
 * Whether a thrown store error is a permission denial.
 *
 * @param error - Thrown value.
 * @param shape - Pre-read record projection of `error`.
 * @returns `true` for `PERMISSION_DENIED` errors.
 */
function isPermissionDenied(error: unknown, shape: Record<string, unknown>): boolean {
  if (shape.code === 'PERMISSION_DENIED') return true;
  return /permission denied/i.test(messageOf(error));
}

// ============================================================================
// Per-agent extension tuning (extension wave, P2.4)
// ============================================================================

/**
 * One selectable extension-tool row for the per-agent tuning editor.
 */
export interface AgentExtensionToolOption {
  /** Sanitized model-facing call name (the descriptor grant identity). */
  readonly callName: string;
  /** Extension id that provides the tool. */
  readonly extensionId: string;
  /** Display label (installed record display name, else the extension id). */
  readonly extensionLabel: string;
  /** Whether the agent's current selector grants this tool. */
  readonly enabled: boolean;
}

/**
 * Complete projection of the per-agent extension tuning editor surface.
 */
export interface AgentExtensionTuningProjection {
  /** Normalized selector the projection was built from (`'all'` default). */
  readonly selector: 'all' | readonly string[];
  /** Selectable tools in Realm record order (resolved-and-attached only). */
  readonly options: readonly AgentExtensionToolOption[];
  /** Count of resolved tools. */
  readonly totalCount: number;
  /** Count of currently enabled tools. */
  readonly selectedCount: number;
  /** Whether every resolved tool is enabled. */
  readonly allSelected: boolean;
  /** Whether the Realm exposes any resolved extension tools. */
  readonly hasTools: boolean;
  /** Compact status label for the toggle header. */
  readonly label: string;
}

/**
 * Normalizes an unknown selector value for the tuning surface: `'all'` for
 * absent/invalid input, else the distinct non-empty names in declared order.
 *
 * @param value - Candidate selector.
 * @returns Normalized selector.
 */
function normalizeTuningSelector(value: unknown): 'all' | readonly string[] {
  if (value === 'all') return 'all';
  if (!Array.isArray(value)) return 'all';
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) continue;
    if (!names.includes(entry)) names.push(entry);
  }
  return Object.freeze(names);
}

/**
 * Computes the Realm's resolved-and-attached extension tool names in record
 * order (the P2 universe the descriptor sweep uses): a `resolvedTools` entry
 * counts only while its extension still carries an `active` attachment.
 *
 * @param resolvedTools - Realm provenance `resolvedTools` record (null-safe).
 * @param attachments - Realm attachment list (null-safe).
 * @returns Resolved-and-attached call names.
 */
function tuningUniverse(
  resolvedTools: Readonly<Record<string, string>> | null | undefined,
  attachments: readonly RealmExtensionAttachment[] | null | undefined
): string[] {
  if (!resolvedTools || typeof resolvedTools !== 'object') return [];
  const activeIds = new Set<string>();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (
      attachment
      && attachment.status === 'active'
      && typeof attachment.extensionId === 'string'
      && attachment.extensionId
    ) {
      activeIds.add(attachment.extensionId);
    }
  }
  const names: string[] = [];
  for (const callName of Object.keys(resolvedTools)) {
    const extensionId = resolvedTools[callName];
    if (typeof extensionId !== 'string' || !activeIds.has(extensionId)) continue;
    if (!names.includes(callName)) names.push(callName);
  }
  return names;
}

/**
 * Builds the per-agent extension tuning projection: the Realm's
 * resolved-and-attached tools with their enabled state under the agent's
 * selector, plus the compact label and counts the settings panel renders.
 *
 * @param options - Realm resolution inputs, the agent selector, and optional extension display labels.
 * @returns Frozen tuning projection (empty when the Realm exposes no tools).
 *
 * @example
 * ```typescript
 * const tuning = buildAgentExtensionTuningProjection({
 *   resolvedTools: realm.instance?.resolvedTools,
 *   attachments: realm.extensions,
 *   selector: agent.config?.extensionTools
 * });
 * ```
 */
export function buildAgentExtensionTuningProjection(options: {
  resolvedTools?: Readonly<Record<string, string>> | null;
  attachments?: readonly RealmExtensionAttachment[] | null;
  selector?: unknown;
  extensionLabels?: Readonly<Record<string, string>> | null;
} = {}): AgentExtensionTuningProjection {
  const universe = tuningUniverse(options.resolvedTools, options.attachments);
  const selector = normalizeTuningSelector(options.selector);
  const selectedSet = selector === 'all' ? new Set(universe) : new Set(selector);
  const labels = options.extensionLabels && typeof options.extensionLabels === 'object'
    ? options.extensionLabels
    : {};
  const optionsView = universe.map((callName) => {
    const extensionId = options.resolvedTools ? options.resolvedTools[callName] : '';
    return Object.freeze({
      callName,
      extensionId: typeof extensionId === 'string' ? extensionId : '',
      extensionLabel: typeof labels[extensionId] === 'string' && labels[extensionId]
        ? labels[extensionId]
        : (typeof extensionId === 'string' ? extensionId : ''),
      enabled: selectedSet.has(callName)
    });
  });
  const selectedCount = optionsView.filter((option) => option.enabled).length;
  const totalCount = optionsView.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const label = totalCount === 0
    ? 'No extension tools resolved for this Realm.'
    : (allSelected
      ? 'All resolved extension tools'
      : (selectedCount === 0 ? 'No extension tools' : `${selectedCount} of ${totalCount} tools`));
  return Object.freeze({
    selector,
    options: Object.freeze(optionsView),
    totalCount,
    selectedCount,
    allSelected,
    hasTools: totalCount > 0,
    label
  });
}

/**
 * Applies one tuning toggle to a selector, returning the next selector value:
 * enabling every resolved tool collapses to `'all'`, any other state is an
 * explicit list in Realm record order, and an unknown tool name or a no-op
 * toggle returns the normalized selector unchanged.
 *
 * @param selector - Current selector (unknown values normalize to `'all'`).
 * @param callName - Tool call name being toggled.
 * @param enabled - Requested state.
 * @param resolvedTools - Realm provenance `resolvedTools` record.
 * @param attachments - Realm attachment list.
 * @returns The next selector value (`'all'` or a frozen explicit list).
 *
 * @example
 * ```typescript
 * const next = applyAgentExtensionToolToggle(
 *   'all', 'similarity', false, realm.instance?.resolvedTools, realm.extensions
 * );
 * ```
 */
export function applyAgentExtensionToolToggle(
  selector: unknown,
  callName: unknown,
  enabled: unknown,
  resolvedTools?: Readonly<Record<string, string>> | null,
  attachments?: readonly RealmExtensionAttachment[] | null
): 'all' | readonly string[] {
  return applyAgentExtensionSelectorToggle(
    selector,
    callName,
    enabled,
    tuningUniverse(resolvedTools, attachments)
  );
}

/**
 * Core selector-toggle rule over an explicit universe: enabling every name
 * collapses to `'all'`, any other state is an explicit list in universe order,
 * and an unknown name or a no-op toggle returns the normalized selector
 * unchanged. The universe order is the display/grant order the caller computes
 * (P3.4 passes the live realm universe so a restricted selector can only
 * narrow the realm-level ceiling).
 *
 * @param selector - Current selector (unknown values normalize to `'all'`).
 * @param callName - Tool call name being toggled.
 * @param enabled - Requested state.
 * @param universe - Names the selector may cover, in display order.
 * @returns The next selector value (`'all'` or a frozen explicit list).
 *
 * @example
 * ```typescript
 * applyAgentExtensionSelectorToggle('all', 'echo', false, ['echo', 'sse']);
 * // => ['sse']
 * ```
 */
export function applyAgentExtensionSelectorToggle(
  selector: unknown,
  callName: unknown,
  enabled: unknown,
  universe: readonly string[] | null | undefined
): 'all' | readonly string[] {
  const current = normalizeTuningSelector(selector);
  const names: string[] = [];
  for (const name of Array.isArray(universe) ? universe : []) {
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  if (typeof callName !== 'string' || !callName || !names.includes(callName)) {
    return current;
  }
  const selected = current === 'all' ? new Set(names) : new Set(current);
  if (enabled === true) selected.add(callName);
  else selected.delete(callName);
  if (selected.size === names.length) {
    // Every name enabled (including the empty universe) is the documented
    // `'all'` default.
    return 'all';
  }
  const next: string[] = [];
  for (const name of names) {
    if (selected.has(name)) next.push(name);
  }
  return Object.freeze(next);
}

// ============================================================================
// Live extension connections (extension wave, P3.4)
// ============================================================================

/**
 * Builds the id → display-label map the extension surfaces render (`Name`
 * when the record declares one, else the raw id). Display-only: the map never
 * carries transport or credential data.
 *
 * @param installs - Global install records (null-safe).
 * @returns Frozen label map.
 *
 * @example
 * ```typescript
 * buildExtensionLabelMap(sandboxStore.listExtensions())['acme-scoring'];
 * ```
 */
export function buildExtensionLabelMap(
  installs: readonly ExtensionInstallRecord[] | null | undefined
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const record of Array.isArray(installs) ? installs : []) {
    if (!record || typeof record.id !== 'string' || !record.id) continue;
    labels[record.id] = typeof record.displayName === 'string' && record.displayName
      ? record.displayName
      : record.id;
  }
  return Object.freeze(labels);
}

/**
 * Third-party trust label rendered wherever extension-provided tool metadata is
 * surfaced (extensions research §A.5: "third-party — classification unknown").
 */
export const EXTENSION_THIRD_PARTY_LABEL = 'third-party \u2014 classification unknown';

/**
 * Display view of one live (or absent) connection status.
 */
export interface ExtensionConnectionStatusView {
  /** Connection status, or `'disconnected'` when no live entry exists. */
  readonly state: ExtensionConnectionStatus | 'disconnected';
  /** Short chip label. */
  readonly label: string;
  /** Plain-language explanation. */
  readonly description: string;
  /** Whether the surfaces render a live status chip (`false` when disconnected). */
  readonly chip: boolean;
}

/**
 * Describes one live connection status for the settings/realm chips.
 *
 * @param status - Connection status (unknown values read as `'disconnected'`).
 * @returns The chip label plus explanation.
 *
 * @example
 * ```typescript
 * describeExtensionConnectionStatus('conflict').label; // 'Conflict'
 * ```
 */
export function describeExtensionConnectionStatus(status: unknown): ExtensionConnectionStatusView {
  if (status === 'connecting') {
    return {
      state: 'connecting',
      label: 'Connecting',
      description: 'Handshake and catalog discovery are in flight.',
      chip: true
    };
  }
  if (status === 'connected') {
    return {
      state: 'connected',
      label: 'Connected',
      description: 'Live, conflict-free catalog: its tools can be granted where the Realm attaches it.',
      chip: true
    };
  }
  if (status === 'conflict') {
    return {
      state: 'conflict',
      label: 'Conflict',
      description: 'Another extension claimed one of its call names first — none of its tools activate until the conflict clears.',
      chip: true
    };
  }
  if (status === 'error') {
    return {
      state: 'error',
      label: 'Error',
      description: 'The last connection attempt failed; the typed code below is the safe failure projection.',
      chip: true
    };
  }
  return {
    state: 'disconnected',
    label: 'Not connected',
    description: 'No live session — nothing is dialed until you connect.',
    chip: false
  };
}

/**
 * Renders one epoch-millisecond connection timestamp for display.
 *
 * @param value - Epoch milliseconds (unknown values read as `''`).
 * @returns `YYYY-MM-DD HH:MM UTC`, or an empty string for malformed values.
 */
export function formatExtensionConnectionTimestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Secret-free error projection of a failed connection attempt.
 */
export interface ExtensionConnectionErrorView {
  /** Typed `ERR_MCP_*` / `ERR_EXTENSION_*` / store code. */
  readonly code: string;
  /** Safe plain-language explanation (never server or credential text). */
  readonly message: string;
  /** Safe machine-readable context rendered as `key=value` lines (`[]` when none). */
  readonly details: readonly string[];
}

/**
 * Fixed safe explanations per typed connection-failure code. Unknown codes
 * fall back to the typed code alone; message text from the failure is never
 * rendered (the store's projection is already secret-free and this keeps the
 * surface conservative).
 */
const CONNECTION_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_MCP_TRANSPORT_UNSUPPORTED: 'The transport kind is not supported by this client.',
  ERR_MCP_PLAINTEXT_CREDENTIAL: 'A credential was refused for a plaintext endpoint.',
  ERR_MCP_AUTH: 'The endpoint rejected the request as unauthorized.',
  ERR_MCP_PROTOCOL: 'The endpoint returned a protocol-level error.',
  ERR_MCP_TIMEOUT: 'The request exceeded its timeout budget.',
  ERR_MCP_CANCELLED: 'The request was cancelled.',
  ERR_MCP_NETWORK: 'The transport failed (network or CORS).',
  ERR_MCP_INVALID_RESPONSE: 'The endpoint returned a response that could not be consumed.',
  ERR_STORE_EXTENSION_NOT_CONNECTABLE: 'This extension carries no connectable transport.',
  ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED: 'stdio is a host-only transport and cannot be connected from the browser.',
  ERR_STORE_EXTENSION_INVALID_ENDPOINT: 'The server URL is not absolute, or the approved URL no longer matches the transport URL.',
  ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL: 'The bound credential cannot be sent over a plaintext endpoint.',
  ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED: 'The bound credential no longer resolves in the vault.',
  ERR_STORE_EXTENSION_CONNECT_FAILED: 'The connection failed before a catalog could be discovered.',
  ERR_EXTENSION_INVALID_CATALOG: 'The discovered catalog was malformed; the whole catalog failed closed.'
});

/**
 * Formats one safe error-detail value for display (strings capped).
 *
 * @param value - Detail value.
 * @returns A display string.
 */
function formatConnectionErrorDetail(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}\u2026` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return typeof value;
    return text.length > 120 ? `${text.slice(0, 120)}\u2026` : text;
  } catch {
    return typeof value;
  }
}

/**
 * Describes one failed-connection projection as the typed store code plus a
 * safe message and any safe machine details. Never renders failure text from
 * the wire; render this instead of an error object.
 *
 * @param error - `ExtensionConnectionError` projection (unknown shapes read as a generic failure).
 * @returns The typed code, safe message, and formatted details.
 *
 * @example
 * ```typescript
 * describeExtensionConnectionError(connection.error).code; // 'ERR_MCP_NETWORK'
 * ```
 */
export function describeExtensionConnectionError(error: unknown): ExtensionConnectionErrorView {
  const shape = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>)
    : {};
  const code = typeof shape.code === 'string' && shape.code
    ? shape.code
    : 'ERR_STORE_EXTENSION_CONNECT_FAILED';
  const message = CONNECTION_ERROR_MESSAGES[code]
    ?? 'The connection attempt failed; the typed code below is the safe failure projection.';
  const detailsRecord = shape.details && typeof shape.details === 'object' && !Array.isArray(shape.details)
    ? (shape.details as Record<string, unknown>)
    : null;
  const details = detailsRecord
    ? Object.keys(detailsRecord).map((key) => `${key}=${formatConnectionErrorDetail(detailsRecord[key])}`)
    : [];
  return Object.freeze({ code, message, details: Object.freeze(details) });
}

/**
 * Display view of one reconnect drift disclosure.
 */
export interface ExtensionCatalogDriftView {
  /** Whether any catalog change was recorded. */
  readonly visible: boolean;
  /** Compact one-line summary (`+1 added · -2 removed`, `no catalog changes`). */
  readonly summary: string;
  /** Newly added call names (new-catalog order). */
  readonly added: readonly string[];
  /** Removed call names (previous-catalog order). */
  readonly removed: readonly string[];
  /** Common call names whose tool facts changed (new-catalog order). */
  readonly changed: readonly string[];
  /** Intra-server shadow call names present only in the new catalog. */
  readonly shadowedAdded: readonly string[];
  /** Intra-server shadow call names present only in the previous catalog. */
  readonly shadowedRemoved: readonly string[];
  /** Whether the relative order of the common call names changed. */
  readonly reordered: boolean;
  /** Previous catalog digest (`''` when there was none). */
  readonly previousDigest: string;
  /** New catalog digest (`''` when absent). */
  readonly nextDigest: string;
}

/**
 * Projects one `ExtensionCatalogDiff` (a reconnect drift record) into the
 * disclosure a surface renders.
 *
 * @param drift - Drift record from the live connection projection (null-safe).
 * @returns The drift view; `visible: false` when nothing changed.
 */
export function describeExtensionCatalogDrift(drift: ExtensionCatalogDiff | null | undefined): ExtensionCatalogDriftView {
  const list = (value: unknown): string[] => (
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
  );
  const record = drift && typeof drift === 'object' ? drift : null;
  const added = list(record?.added);
  const removed = list(record?.removed);
  const changed = list(record?.changed);
  const shadowedAdded = list(record?.shadowedAdded);
  const shadowedRemoved = list(record?.shadowedRemoved);
  const reordered = record?.reordered === true;
  const digests = record && record.digests && typeof record.digests === 'object' ? record.digests : null;
  const previousDigest = digests && typeof digests.previous === 'string' ? digests.previous : '';
  const nextDigest = digests && typeof digests.next === 'string' ? digests.next : '';
  const visible = added.length > 0 || removed.length > 0 || changed.length > 0
    || shadowedAdded.length > 0 || shadowedRemoved.length > 0 || reordered;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`+${added.length} added`);
  if (removed.length > 0) parts.push(`-${removed.length} removed`);
  if (changed.length > 0) parts.push(`~${changed.length} changed`);
  if (shadowedAdded.length > 0) parts.push(`+${shadowedAdded.length} shadowed`);
  if (shadowedRemoved.length > 0) parts.push(`-${shadowedRemoved.length} shadows cleared`);
  if (reordered) parts.push('order changed');
  return Object.freeze({
    visible,
    summary: parts.length > 0 ? parts.join(' \u00b7 ') : 'No catalog changes.',
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    shadowedAdded: Object.freeze(shadowedAdded),
    shadowedRemoved: Object.freeze(shadowedRemoved),
    reordered,
    previousDigest,
    nextDigest
  });
}

/**
 * One warned projected tool as disclosed in the fidelity details popover
 * (code + path only; never schema text).
 */
export interface ExtensionFidelityWarningView {
  /** Sanitized model-facing call name. */
  readonly callName: string;
  /** Stable projection warning code. */
  readonly code: string;
  /** `#`-rooted JSON Pointer the warning applies to. */
  readonly path: string;
}

/**
 * One refused projected tool as disclosed in the fidelity details popover.
 */
export interface ExtensionFidelityRefusalView {
  /** Sanitized model-facing call name. */
  readonly callName: string;
  /** Stable refusal code. */
  readonly code: string;
  /** `#`-rooted JSON Pointer, when known (`''` otherwise). */
  readonly path: string;
}

/**
 * Fidelity disclosure of one live catalog: the badge state plus the warned and
 * refused tools behind it.
 */
export interface ExtensionCatalogFidelityView {
  /** Fidelity state from `summarizeExtensionSchemaFidelity`. */
  readonly state: 'clean' | 'projected' | 'degraded';
  /** Projected tools summarized. */
  readonly total: number;
  /** Tools carrying at least one recorded warning. */
  readonly warned: number;
  /** Refused projections. */
  readonly refused: number;
  /** Badge text (`''` when clean, `projected schemas`, `degraded schema fidelity`). */
  readonly badge: string;
  /** One-line summary for the catalog row. */
  readonly summary: string;
  /** Warned tools (code + path only) in catalog order. */
  readonly warnings: readonly ExtensionFidelityWarningView[];
  /** Refused tools in catalog order. */
  readonly refusals: readonly ExtensionFidelityRefusalView[];
}

/**
 * Builds the fidelity disclosure of one live connection's catalog by running
 * the real projector (`projectExtensionInputSchema`) over every cataloged
 * input schema and summarizing with the real
 * `summarizeExtensionSchemaFidelity`, so the badge thresholds can never
 * disagree with the execution pipeline.
 *
 * @param connection - Live connection projection (null-safe).
 * @returns The fidelity view, or `null` when no catalog was discovered.
 *
 * @example
 * ```typescript
 * buildExtensionCatalogFidelityView(sandboxStore.getExtensionConnection('acme'))?.badge;
 * // 'projected schemas'
 * ```
 */
export function buildExtensionCatalogFidelityView(
  connection: ExtensionConnectionProjection | null | undefined
): ExtensionCatalogFidelityView | null {
  const catalog = connection && connection.catalog ? connection.catalog : null;
  if (!catalog) return null;
  const toolNames = Object.keys(catalog);
  const projections = toolNames.map((callName) => {
    const entry = catalog[callName];
    return projectExtensionInputSchema(entry ? entry.inputSchema : undefined);
  });
  const summary: ExtensionSchemaFidelitySummary = summarizeExtensionSchemaFidelity(projections);
  const warnings: ExtensionFidelityWarningView[] = [];
  const refusals: ExtensionFidelityRefusalView[] = [];
  for (let index = 0; index < projections.length; index += 1) {
    const callName = toolNames[index];
    const projection = projections[index];
    if (projection.status === 'refused') {
      refusals.push(Object.freeze({
        callName,
        code: projection.refusal.code,
        path: typeof projection.refusal.path === 'string' ? projection.refusal.path : ''
      }));
      continue;
    }
    for (const warning of projection.warnings) {
      warnings.push(Object.freeze({ callName, code: warning.code, path: warning.path }));
    }
  }
  const badge = summary.state === 'degraded'
    ? 'degraded schema fidelity'
    : summary.state === 'projected' ? 'projected schemas' : '';
  const summaryText = summary.state === 'clean'
    ? `All ${summary.total} tool schema${summary.total === 1 ? '' : 's'} project cleanly.`
    : summary.state === 'degraded'
      ? `${summary.warned} of ${summary.total} tool schemas needed projection; ${summary.refused} refused.`
      : `${summary.warned} of ${summary.total} tool schemas needed normalization (additive).`;
  return Object.freeze({
    state: summary.state,
    total: summary.total,
    warned: summary.warned,
    refused: summary.refused,
    badge,
    summary: summaryText,
    warnings: Object.freeze(warnings),
    refusals: Object.freeze(refusals)
  });
}

/**
 * Complete display projection of one installed extension plus its live
 * connection (if any): controls, live status, server identity, catalog
 * count/digest, fidelity, shadows/conflicts/drift, and the safe error.
 */
export interface ExtensionConnectionView {
  /** Host-unique extension id. */
  readonly extensionId: string;
  /** Display label (record display name, else the id). */
  readonly label: string;
  /** Extension kind. */
  readonly kind: 'mcp' | 'pack';
  /** Transport hint summary. */
  readonly transportSummary: string;
  /** Third-party trust label for the surface. */
  readonly thirdPartyLabel: string;
  /** Live (or absent) status. */
  readonly status: ExtensionConnectionStatusView;
  /** Whether Connect applies (an `http` MCP record with no live session, or after an error). */
  readonly canConnect: boolean;
  /** Whether Disconnect applies (a live entry exists). */
  readonly canDisconnect: boolean;
  /** Whether Reconnect applies (an `http` MCP record with a live entry). */
  readonly canReconnect: boolean;
  /** Why some controls are unavailable (`''` when all applicable controls render). */
  readonly controlsHint: string;
  /** Server name from the handshake (`''` before/without a session). */
  readonly serverName: string;
  /** Server version from the handshake (`''` before/without a session). */
  readonly serverVersion: string;
  /** Negotiated protocol revision (`''` before/without a session). */
  readonly protocolVersion: string;
  /** Catalog tool count (`0` when no catalog). */
  readonly toolCount: number;
  /** Catalog digest (`''` when no catalog). */
  readonly digest: string;
  /** Fidelity disclosure, or `null` when no catalog. */
  readonly fidelity: ExtensionCatalogFidelityView | null;
  /** Intra-server shadowed tools. */
  readonly shadows: readonly ExtensionCatalogShadow[];
  /** Extension↔extension conflicts of the last arbitration. */
  readonly conflicts: readonly ExtensionCatalogConflict[];
  /** Reconnect drift disclosure, or `null` when none was computed. */
  readonly drift: ExtensionCatalogDriftView | null;
  /** Failed-connection safe projection, or `null`. */
  readonly error: ExtensionConnectionErrorView | null;
  /** Formatted connection timestamp (`''` when none). */
  readonly connectedAt: string;
  /** Formatted discovery timestamp (`''` when none). */
  readonly discoveredAt: string;
}

/**
 * Builds the display projection of one install record plus its live
 * connection. The catalog is only read while the connection is live:
 * a disconnected extension shows no tools.
 *
 * @param record - Global install record.
 * @param connection - Live connection projection for the record, or `null`/`undefined`.
 * @returns Frozen display view.
 *
 * @example
 * ```typescript
 * const view = buildExtensionConnectionView(record, sandboxStore.getExtensionConnection(record.id));
 * view.canConnect; // true while no live session exists
 * ```
 */
export function buildExtensionConnectionView(
  record: ExtensionInstallRecord,
  connection: ExtensionConnectionProjection | null | undefined
): ExtensionConnectionView {
  const live = connection && typeof connection === 'object' ? connection : null;
  const isPack = record.kind === 'pack';
  const isStdio = !isPack && record.transportHint.kind === 'stdio';
  const isHttp = !isPack && record.transportHint.kind === 'http';
  const status = describeExtensionConnectionStatus(live ? live.status : 'disconnected');
  // "A disconnected extension shows no tools": catalog data is only surfaced
  // while a live entry exists (an errored entry keeps its error disclosure).
  const catalog = live && live.catalog ? live.catalog : null;
  const toolCount = catalog ? Object.keys(catalog).length : 0;
  const digest = live && typeof live.digest === 'string' ? live.digest : '';
  const fidelity = buildExtensionCatalogFidelityView(live);
  const shadows = live && Array.isArray(live.shadows) ? live.shadows : [];
  const conflicts = live && Array.isArray(live.conflicts) ? live.conflicts : [];
  const serverInfo = live && live.serverInfo && typeof live.serverInfo === 'object' ? live.serverInfo : null;
  const controlsHint = isPack
    ? 'Tool packs carry no connectable transport — they are host-installed.'
    : isStdio ? 'stdio is host-only: this browser session can record the declaration but cannot connect it.' : '';
  return Object.freeze({
    extensionId: record.id,
    label: typeof record.displayName === 'string' && record.displayName ? record.displayName : record.id,
    kind: record.kind,
    transportSummary: describeExtensionTransportHint(record.transportHint),
    thirdPartyLabel: EXTENSION_THIRD_PARTY_LABEL,
    status,
    canConnect: isHttp && (live === null || live.status === 'error'),
    canDisconnect: live !== null,
    canReconnect: isHttp && live !== null,
    controlsHint,
    serverName: serverInfo && typeof serverInfo.name === 'string' ? serverInfo.name : '',
    serverVersion: serverInfo && typeof serverInfo.version === 'string' ? serverInfo.version : '',
    protocolVersion: live && typeof live.protocolVersion === 'string' ? live.protocolVersion : '',
    toolCount,
    digest,
    fidelity,
    shadows: Object.freeze([...shadows]),
    conflicts: Object.freeze([...conflicts]),
    drift: live ? describeExtensionCatalogDrift(live.drift) : null,
    error: live && live.error ? describeExtensionConnectionError(live.error) : null,
    connectedAt: live ? formatExtensionConnectionTimestamp(live.connectedAt) : '',
    discoveredAt: live ? formatExtensionConnectionTimestamp(live.discoveredAt) : ''
  });
}

/**
 * Builds the display projections of every install record in registry order.
 *
 * @param options - Install records, live connection projections, and optional display labels.
 * @returns Frozen views in install-record order.
 */
export function buildExtensionConnectionViews(options: {
  readonly installs: readonly ExtensionInstallRecord[];
  readonly connections?: readonly ExtensionConnectionProjection[] | null;
  readonly labels?: Readonly<Record<string, string>> | null;
}): readonly ExtensionConnectionView[] {
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const byId = new Map<string, ExtensionConnectionProjection>();
  for (const connection of connections) {
    if (connection && typeof connection.extensionId === 'string' && !byId.has(connection.extensionId)) {
      byId.set(connection.extensionId, connection);
    }
  }
  return Object.freeze(
    options.installs.map((record) => buildExtensionConnectionView(record, byId.get(record.id) ?? null))
  );
}

/**
 * Realm-level ceiling view of one attachment: the attachment's tool selection
 * intersected with the live conflict-free catalog (P3.3 F1 semantics).
 */
export interface RealmAttachmentCeilingView {
  /** Realm selection mode. */
  readonly mode: 'all' | 'selection';
  /** Explicitly selected call names (`[]` when the mode is `all`). */
  readonly selectedNames: readonly string[];
  /** Live conflict-free catalog call names (capped by nothing; `[]` when no catalog). */
  readonly liveNames: readonly string[];
  /** Effective names the Realm may grant: live catalog ∩ selection (`all` keeps the catalog). */
  readonly effectiveNames: readonly string[];
  /** Live catalog names the attachment selection excludes. */
  readonly excludedNames: readonly string[];
  /** Whether a live conflict-free catalog currently exists. */
  readonly hasLiveCatalog: boolean;
  /** One-line display summary of the ceiling. */
  readonly summary: string;
}

/**
 * Builds the realm-level ceiling view of one attachment: `toolSelection` caps
 * the live catalog contribution (`'all'` keeps every live name, an explicit
 * list keeps the intersection), so a connect can never widen the Realm's
 * selection and per-agent selectors can only narrow it further.
 *
 * @param attachment - Realm attachment record.
 * @param connection - Live connection projection, or `null`/`undefined`.
 * @returns Frozen ceiling view.
 *
 * @example
 * ```typescript
 * buildRealmAttachmentCeilingView(attachment, connection).effectiveNames;
 * ```
 */
export function buildRealmAttachmentCeilingView(
  attachment: RealmExtensionAttachment,
  connection: ExtensionConnectionProjection | null | undefined
): RealmAttachmentCeilingView {
  const rawSelection = attachment.toolSelection;
  const mode: 'all' | 'selection' = rawSelection === 'all' ? 'all' : 'selection';
  const selectedNames: readonly string[] = mode === 'all'
    ? Object.freeze([])
    : Object.freeze((Array.isArray(rawSelection) ? rawSelection : [])
      .filter((name): name is string => typeof name === 'string' && name.length > 0));
  const live = connection && connection.status === 'connected' && connection.catalog && (connection.conflicts?.length ?? 0) === 0
    ? connection
    : null;
  const liveNames: string[] = live && live.catalog ? Object.keys(live.catalog) : [];
  const effectiveNames = mode === 'all'
    ? Object.freeze([...liveNames])
    : Object.freeze(liveNames.filter((name) => selectedNames.includes(name)));
  const excludedNames = mode === 'selection'
    ? Object.freeze(liveNames.filter((name) => !selectedNames.includes(name)))
    : Object.freeze([]) as readonly string[];
  const summary = liveNames.length === 0
    ? (mode === 'all'
      ? 'All tools — no live catalog yet (connect the extension to see it).'
      : `${selectedNames.length} selected call name${selectedNames.length === 1 ? '' : 's'} — no live catalog yet.`)
    : (mode === 'all'
      ? `All ${liveNames.length} live catalog tool${liveNames.length === 1 ? '' : 's'}.`
      : `${effectiveNames.length} of ${liveNames.length} live tool${liveNames.length === 1 ? '' : 's'} selected${excludedNames.length > 0 ? ` (${excludedNames.length} excluded by the Realm ceiling)` : ''}.`);
  return Object.freeze({
    mode,
    selectedNames: Object.freeze([...selectedNames]),
    liveNames: Object.freeze([...liveNames]),
    effectiveNames,
    excludedNames,
    hasLiveCatalog: liveNames.length > 0,
    summary
  });
}

/**
 * Ceiling-editor state of the extension currently picked in the attach editor.
 * `no-selection` makes no claim about live catalogs (one may well be
 * connected); `live-catalog` is a selected extension with a non-empty live
 * conflict-free catalog (the checkbox editor applies); `empty-live-catalog` is
 * a selected extension whose connected catalog lists no tools; and
 * `no-live-catalog` is a selected extension without a live conflict-free
 * catalog (absent, connecting, errored, or conflicting).
 */
export type RealmAttachCeilingState =
  | 'no-selection'
  | 'live-catalog'
  | 'empty-live-catalog'
  | 'no-live-catalog';

/**
 * Copy/visibility model of the attach-editor ceiling area: the picked
 * extension's live conflict-free catalog names, whether the live checkbox
 * editor applies, and the hint under the fallback (radio) editor per selection
 * mode.
 */
export interface RealmAttachCeilingEditorView {
  /** Which copy state applies to the current selection. */
  readonly state: RealmAttachCeilingState;
  /** Live conflict-free catalog call names in catalog order (`[]` otherwise). */
  readonly catalogNames: readonly string[];
  /** Whether the live-catalog checkbox ceiling editor applies (non-empty live catalog). */
  readonly showLiveCatalog: boolean;
  /** Hint under the fallback editor in the all-tools mode (`''` when the live editor applies). */
  readonly allToolsHint: string;
  /** Hint under the fallback editor in the custom-names mode (`''` when the live editor applies). */
  readonly customNamesHint: string;
}

/**
 * Builds the attach-editor ceiling model for one picked extension: the live
 * conflict-free catalog names (same first-wins/by-id lookup the other
 * connection views use) plus the state-accurate copy. The editor must never
 * claim "No live catalog is connected yet" unless the picked extension really
 * has no live conflict-free catalog — with nothing picked the connectivity of
 * the store's other extensions says nothing about this selection.
 *
 * @param options - Picked extension id (any shape; non-strings read as none) and live connection projections.
 * @returns Frozen copy/visibility model.
 *
 * @example
 * ```typescript
 * describeRealmAttachCeilingEditor({ extensionId: 'acme-scoring', connections }).showLiveCatalog;
 * ```
 */
export function describeRealmAttachCeilingEditor(options: {
  readonly extensionId?: unknown;
  readonly connections?: readonly ExtensionConnectionProjection[] | null;
} = {}): RealmAttachCeilingEditorView {
  const extensionId = typeof options.extensionId === 'string' ? options.extensionId : '';
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const connection = extensionId
    ? connections.find((entry) => entry && entry.extensionId === extensionId) ?? null
    : null;
  const live = connection && connection.status === 'connected' && connection.catalog
    && (connection.conflicts?.length ?? 0) === 0
    ? connection
    : null;
  const catalogNames: readonly string[] = Object.freeze(live && live.catalog ? Object.keys(live.catalog) : []);
  if (extensionId.length === 0) {
    return Object.freeze({
      state: 'no-selection',
      catalogNames,
      showLiveCatalog: false,
      allToolsHint: 'Choose an extension to set its Realm ceiling.',
      customNamesHint: 'Sanitized model-facing call names (the derived form), comma-separated. Choose an extension to record its ceiling.'
    });
  }
  if (live && catalogNames.length > 0) {
    return Object.freeze({
      state: 'live-catalog',
      catalogNames,
      showLiveCatalog: true,
      allToolsHint: '',
      customNamesHint: ''
    });
  }
  if (live) {
    return Object.freeze({
      state: 'empty-live-catalog',
      catalogNames,
      showLiveCatalog: false,
      allToolsHint: 'A live catalog is connected but currently lists no tools — the ceiling stays "all tools" and applies when tools appear.',
      customNamesHint: 'Sanitized model-facing call names (the derived form), comma-separated. The connected catalog currently lists no tools, so the names are recorded as the ceiling.'
    });
  }
  return Object.freeze({
    state: 'no-live-catalog',
    catalogNames,
    showLiveCatalog: false,
    allToolsHint: 'No live catalog is connected yet — the ceiling stays "all tools" until a connect.',
    customNamesHint: 'Sanitized model-facing call names (the derived form), comma-separated. No live catalog is connected yet, so names are recorded as the ceiling for a later connect.'
  });
}

/**
 * One extension↔extension conflict with the winning extension's display label.
 */
export interface RealmExtensionConflictView {
  /** Contested call name. */
  readonly callName: string;
  /** Earlier extension that keeps the call name. */
  readonly otherExtensionId: string;
  /** Display label of the winning extension. */
  readonly otherLabel: string;
}

/**
 * Complete display projection of one Realm attachment with its live state.
 */
export interface RealmExtensionAttachmentView {
  /** Attached extension id. */
  readonly extensionId: string;
  /** Display label (install display name, else the id). */
  readonly label: string;
  /** Attachment record. */
  readonly attachment: RealmExtensionAttachment;
  /** Live resolution state: `active` (attached; connection may be absent), `conflict`, or `unavailable`. */
  readonly state: 'active' | 'conflict' | 'unavailable';
  /** Short state label. */
  readonly stateLabel: string;
  /** Plain-language state explanation reflecting the live connection. */
  readonly stateDescription: string;
  /** Live (or absent) connection status. */
  readonly live: ExtensionConnectionStatusView;
  /** Live catalog tool count (`0` when no catalog). */
  readonly toolCount: number;
  /** Live catalog digest (`''` when no catalog). */
  readonly digest: string;
  /** Realm-level ceiling view. */
  readonly ceiling: RealmAttachmentCeilingView;
  /** Conflicts against earlier extensions with winner labels. */
  readonly conflicts: readonly RealmExtensionConflictView[];
  /** Whether the Disconnect resolution action applies. */
  readonly canDisconnect: boolean;
  /** Whether the Reconnect resolution action applies. */
  readonly canReconnect: boolean;
  /** Formatted connection timestamp (`''` when none). */
  readonly connectedAt: string;
  /** Formatted discovery timestamp (`''` when none). */
  readonly discoveredAt: string;
}

/**
 * Builds every attachment view of one Realm: live status, ceiling, conflicts
 * with winner labels, and the disconnect/reconnect resolution actions.
 *
 * @param options - Realm attachments, live connections, install records, and optional labels.
 * @returns Frozen views in attachment order.
 */
export function buildRealmExtensionAttachmentViews(options: {
  readonly attachments: readonly RealmExtensionAttachment[];
  readonly connections?: readonly ExtensionConnectionProjection[] | null;
  readonly installs?: readonly ExtensionInstallRecord[] | null;
  readonly labels?: Readonly<Record<string, string>> | null;
}): readonly RealmExtensionAttachmentView[] {
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const installs = Array.isArray(options.installs) ? options.installs : [];
  const labels = options.labels && typeof options.labels === 'object' ? options.labels : {};
  const connectionById = new Map<string, ExtensionConnectionProjection>();
  for (const connection of connections) {
    if (connection && typeof connection.extensionId === 'string' && !connectionById.has(connection.extensionId)) {
      connectionById.set(connection.extensionId, connection);
    }
  }
  const viewLabel = (extensionId: string): string => {
    if (typeof labels[extensionId] === 'string' && labels[extensionId]) return labels[extensionId];
    const record = installs.find((candidate) => candidate.id === extensionId) ?? null;
    return record && typeof record.displayName === 'string' && record.displayName ? record.displayName : extensionId;
  };
  return Object.freeze(options.attachments.map((attachment) => {
    const connection = connectionById.get(attachment.extensionId) ?? null;
    const live = describeExtensionConnectionStatus(connection ? connection.status : 'disconnected');
    const conflicts = connection && Array.isArray(connection.conflicts) ? connection.conflicts : [];
    const conflict = attachment.status === 'conflict' || (connection !== null && connection.status === 'conflict');
    const state: 'active' | 'conflict' | 'unavailable' = conflict
      ? 'conflict'
      : attachment.status === 'unavailable' ? 'unavailable' : 'active';
    const stateLabel = state === 'conflict' ? 'Conflict' : state === 'unavailable' ? 'Unavailable' : 'Active';
    const stateDescription = state === 'conflict'
      ? 'A call-name conflict with another live extension — the conflicting names stay inactive until the operator disconnects or reconnects the winner/loser.'
      : state === 'unavailable'
        ? 'The extension is not currently installed or usable, so its tools stay unavailable.'
        : connection && connection.status === 'connected'
          ? 'Attached and connected: the Realm grants the ceiling (live catalog ∩ selection) to its members.'
          : 'Attached and accepted, but not connected — its tools are unavailable until an operator connects it.';
    const catalog = connection && connection.status === 'connected' && connection.catalog ? connection.catalog : null;
    return Object.freeze({
      extensionId: attachment.extensionId,
      label: viewLabel(attachment.extensionId),
      attachment,
      state,
      stateLabel,
      stateDescription,
      live,
      toolCount: catalog ? Object.keys(catalog).length : 0,
      digest: connection && typeof connection.digest === 'string' ? connection.digest : '',
      ceiling: buildRealmAttachmentCeilingView(attachment, connection),
      conflicts: Object.freeze(conflicts.map((entry) => Object.freeze({
        callName: entry.callName,
        otherExtensionId: entry.otherExtensionId,
        otherLabel: viewLabel(entry.otherExtensionId)
      }))),
      canDisconnect: connection !== null,
      canReconnect: connection !== null,
      connectedAt: connection ? formatExtensionConnectionTimestamp(connection.connectedAt) : '',
      discoveredAt: connection ? formatExtensionConnectionTimestamp(connection.discoveredAt) : ''
    });
  }));
}

/**
 * One unavailable (no live catalog) attachment of the agent tool-scope panel.
 */
export interface AgentLiveExtensionUnavailableView {
  /** Attached extension id. */
  readonly extensionId: string;
  /** Display label. */
  readonly label: string;
  /** Why the attachment contributes no live tools. */
  readonly reason: 'not-connected' | 'connecting' | 'conflict' | 'error' | 'unavailable';
  /** Plain-language explanation. */
  readonly message: string;
}

/**
 * One selectable tool of the live agent scope panel.
 */
export interface AgentLiveExtensionToolOption {
  /** Sanitized model-facing call name. */
  readonly callName: string;
  /** Extension id that provides the tool. */
  readonly extensionId: string;
  /** Display label of the providing extension. */
  readonly extensionLabel: string;
  /** Whether the agent's current selector grants this tool. */
  readonly enabled: boolean;
  /** Where the name entered the universe: launch resolution or the live catalog. */
  readonly source: 'resolved' | 'catalog';
}

/**
 * Live per-agent extension tool-scope projection: the Realm's grant universe
 * under P3.3 F1 semantics (persisted resolved names plus each active
 * attachment's live conflict-free catalog capped by its `toolSelection`),
 * with per-attachment unavailable markers.
 */
export interface AgentLiveExtensionTuningProjection {
  /** Normalized selector the projection was built from (`'all'` default). */
  readonly selector: 'all' | readonly string[];
  /** Selectable tools in grant-universe order. */
  readonly options: readonly AgentLiveExtensionToolOption[];
  /** Every universe call name in order (the toggle universe). */
  readonly callNames: readonly string[];
  /** Count of universe tools. */
  readonly totalCount: number;
  /** Count of currently enabled tools. */
  readonly selectedCount: number;
  /** Whether every universe tool is enabled. */
  readonly allSelected: boolean;
  /** Whether the Realm exposes any extension tools. */
  readonly hasTools: boolean;
  /** Compact status label for the toggle header. */
  readonly label: string;
  /** Realm-level ceiling explanation rendered under the header. */
  readonly ceilingHint: string;
  /** Persisted (launch-resolved) names in the universe. */
  readonly resolvedCount: number;
  /** Live catalog names in the universe. */
  readonly liveCount: number;
  /** Active attachments whose catalog is not live, with the reason. */
  readonly unavailableAttachments: readonly AgentLiveExtensionUnavailableView[];
}

/**
 * Builds the live per-agent extension tool-scope projection from the Realm's
 * attachments, the store's live connection projections, the persisted
 * `resolvedTools` provenance, and the agent's selector.
 *
 * The universe mirrors the store's grant resolution exactly: persisted
 * resolved names first (active attachments only), then each active
 * attachment's live conflict-free catalog in connection order, capped by the
 * attachment's `toolSelection` (the realm-level ceiling). A restricted agent
 * selector therefore cannot widen past the ceiling — its options come from
 * this universe only.
 *
 * @param options - Realm provenance/attachments, live connections, selector, and display labels.
 * @returns Frozen tuning projection (empty when the Realm exposes no tools).
 */
export function buildAgentLiveExtensionTuningProjection(options: {
  readonly resolvedTools?: Readonly<Record<string, string>> | null;
  readonly attachments?: readonly RealmExtensionAttachment[] | null;
  readonly connections?: readonly ExtensionConnectionProjection[] | null;
  readonly selector?: unknown;
  readonly extensionLabels?: Readonly<Record<string, string>> | null;
} = {}): AgentLiveExtensionTuningProjection {
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const labels = options.extensionLabels && typeof options.extensionLabels === 'object'
    ? options.extensionLabels
    : {};
  const labelOf = (extensionId: string): string => (
    typeof labels[extensionId] === 'string' && labels[extensionId] ? labels[extensionId] : extensionId
  );
  const activeIds = new Set<string>();
  const selectionById = new Map<string, 'all' | readonly string[]>();
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.extensionId !== 'string' || attachment.status !== 'active') continue;
    activeIds.add(attachment.extensionId);
    selectionById.set(
      attachment.extensionId,
      attachment.toolSelection === 'all'
        ? 'all'
        : Object.freeze(Array.isArray(attachment.toolSelection)
          ? attachment.toolSelection.filter((name): name is string => typeof name === 'string' && name.length > 0)
          : [])
    );
  }
  const universe = new Map<string, { extensionId: string; source: 'resolved' | 'catalog' }>();
  const resolvedTools = options.resolvedTools && typeof options.resolvedTools === 'object' ? options.resolvedTools : null;
  if (resolvedTools) {
    for (const callName of Object.keys(resolvedTools)) {
      const extensionId = resolvedTools[callName];
      if (typeof extensionId !== 'string' || !activeIds.has(extensionId)) continue;
      if (!universe.has(callName)) universe.set(callName, { extensionId, source: 'resolved' });
    }
  }
  for (const connection of connections) {
    if (!connection || typeof connection.extensionId !== 'string') continue;
    if (connection.status !== 'connected' || (connection.conflicts?.length ?? 0) > 0) continue;
    const selection = selectionById.get(connection.extensionId);
    if (selection === undefined || !connection.catalog) continue;
    for (const callName of Object.keys(connection.catalog)) {
      if (selection !== 'all' && !selection.includes(callName)) continue;
      if (!universe.has(callName)) universe.set(callName, { extensionId: connection.extensionId, source: 'catalog' });
    }
  }
  const selector = normalizeTuningSelector(options.selector);
  const callNames = Object.freeze([...universe.keys()]);
  const selectedSet = selector === 'all' ? new Set(callNames) : new Set(selector);
  const optionViews = callNames.map((callName) => {
    const entry = universe.get(callName);
    const extensionId = entry ? entry.extensionId : '';
    return Object.freeze({
      callName,
      extensionId,
      extensionLabel: labelOf(extensionId),
      enabled: selectedSet.has(callName),
      source: entry ? entry.source : 'catalog'
    });
  });
  const selectedCount = optionViews.filter((option) => option.enabled).length;
  const totalCount = optionViews.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const unavailableAttachments: AgentLiveExtensionUnavailableView[] = [];
  const connectionById = new Map<string, ExtensionConnectionProjection>();
  for (const connection of connections) {
    if (connection && typeof connection.extensionId === 'string' && !connectionById.has(connection.extensionId)) {
      connectionById.set(connection.extensionId, connection);
    }
  }
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.extensionId !== 'string') continue;
    if (attachment.status !== 'active') {
      unavailableAttachments.push(Object.freeze({
        extensionId: attachment.extensionId,
        label: labelOf(attachment.extensionId),
        reason: 'unavailable',
        message: 'The attachment is not active in this Realm.'
      }));
      continue;
    }
    const connection = connectionById.get(attachment.extensionId) ?? null;
    if (connection && connection.status === 'connected' && connection.catalog) continue;
    const reason: AgentLiveExtensionUnavailableView['reason'] = !connection
      ? 'not-connected'
      : connection.status === 'connecting' ? 'connecting'
        : connection.status === 'conflict' ? 'conflict'
          : connection.status === 'error' ? 'error' : 'not-connected';
    const message = reason === 'connecting'
      ? 'Connection in flight; the catalog appears once discovery completes.'
      : reason === 'conflict'
        ? 'Catalog conflict with an earlier extension; resolve it before its tools activate.'
        : reason === 'error'
          ? 'The last connection attempt failed; reconnect from Sandbox Settings → Extensions.'
          : 'Not connected — its tools are unavailable until an operator connects it.';
    unavailableAttachments.push(Object.freeze({
      extensionId: attachment.extensionId,
      label: labelOf(attachment.extensionId),
      reason,
      message
    }));
  }
  const label = totalCount === 0
    ? 'No extension tools available in this Realm.'
    : allSelected ? 'All realm extension tools (ceiling)'
      : selectedCount === 0 ? 'No extension tools' : `${selectedCount} of ${totalCount} tools`;
  return Object.freeze({
    selector,
    options: Object.freeze(optionViews),
    callNames,
    totalCount,
    selectedCount,
    allSelected,
    hasTools: totalCount > 0,
    label,
    ceilingHint: 'The Realm attachment selection is the ceiling — per-agent scopes can only narrow it further.',
    resolvedCount: optionViews.filter((option) => option.source === 'resolved').length,
    liveCount: optionViews.filter((option) => option.source === 'catalog').length,
    unavailableAttachments: Object.freeze(unavailableAttachments)
  });
}

/**
 * Live realm-card indicator: how many of a Realm's attached extensions
 * currently expose a conflict-free catalog, and how many are not connected.
 */
export interface RealmExtensionLiveIndicator {
  /** Whether the indicator renders (the Realm attaches at least one extension). */
  readonly visible: boolean;
  /** Attachments with a live conflict-free catalog. */
  readonly connectedCount: number;
  /** Attachments whose live connection lost a call-name race. */
  readonly conflictCount: number;
  /** Active attachments without a live conflict-free catalog. */
  readonly notConnectedCount: number;
  /** Third-party trust label for the tooltip. */
  readonly thirdPartyLabel: string;
  /** Compact badge text (`2 live`, `1 live · 1 conflict`, `1 attached · not connected`). */
  readonly label: string;
  /** Tooltip naming the live and not-connected extensions. */
  readonly title: string;
}

/**
 * Builds the Realm-card live indicator from the Realm's attachments and the
 * store's live connection projections. Descriptive only: it never connects,
 * attaches, or re-resolves anything.
 *
 * @param options - Realm attachments, live connections, and optional display labels.
 * @returns The live indicator; hidden when the Realm attaches nothing.
 */
export function describeRealmExtensionLiveIndicator(options: {
  readonly attachments?: readonly RealmExtensionAttachment[] | null;
  readonly connections?: readonly ExtensionConnectionProjection[] | null;
  readonly labels?: Readonly<Record<string, string>> | null;
}): RealmExtensionLiveIndicator {
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const labels = options.labels && typeof options.labels === 'object' ? options.labels : {};
  const labelOf = (extensionId: string): string => (
    typeof labels[extensionId] === 'string' && labels[extensionId] ? labels[extensionId] : extensionId
  );
  const active = attachments.filter((attachment) => attachment && attachment.status === 'active');
  if (active.length === 0) {
    return {
      visible: false,
      connectedCount: 0,
      conflictCount: 0,
      notConnectedCount: 0,
      thirdPartyLabel: EXTENSION_THIRD_PARTY_LABEL,
      label: '',
      title: ''
    };
  }
  const connectionById = new Map<string, ExtensionConnectionProjection>();
  for (const connection of connections) {
    if (connection && typeof connection.extensionId === 'string' && !connectionById.has(connection.extensionId)) {
      connectionById.set(connection.extensionId, connection);
    }
  }
  const live: string[] = [];
  const conflicted: string[] = [];
  const idle: string[] = [];
  for (const attachment of active) {
    const connection = connectionById.get(attachment.extensionId) ?? null;
    if (connection && connection.status === 'connected' && connection.catalog) {
      live.push(labelOf(attachment.extensionId));
    } else if (connection && connection.status === 'conflict') {
      conflicted.push(labelOf(attachment.extensionId));
    } else {
      idle.push(labelOf(attachment.extensionId));
    }
  }
  const parts: string[] = [];
  if (live.length > 0) parts.push(`${live.length} live`);
  if (conflicted.length > 0) parts.push(`${conflicted.length} conflict`);
  if (idle.length > 0) parts.push(`${idle.length} not connected`);
  const details: string[] = [`${EXTENSION_THIRD_PARTY_LABEL}.`];
  if (live.length > 0) details.push(`Live: ${live.join(', ')}.`);
  if (conflicted.length > 0) details.push(`Conflict: ${conflicted.join(', ')}.`);
  if (idle.length > 0) details.push(`Not connected: ${idle.join(', ')}.`);
  details.push('Open Realm settings to manage connections and attachments.');
  return Object.freeze({
    visible: true,
    connectedCount: live.length,
    conflictCount: conflicted.length,
    notConnectedCount: idle.length,
    thirdPartyLabel: EXTENSION_THIRD_PARTY_LABEL,
    label: parts.join(' \u00b7 '),
    title: details.join(' ')
  });
}
