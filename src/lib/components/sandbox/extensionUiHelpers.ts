/**
 * Extension management UI helpers (extension wave, P2.3): the pure projections
 * behind the global extensions settings tab, the Realm attachment editor, the
 * missing-tools install/attach flow, and the launcher/review extension
 * disclosure.
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
 * Nothing here connects, installs, or attaches: every projection is a pure
 * function of its arguments and every action is performed by the operator
 * through the component calling the store.
 */

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
 * computed by the real `extensionRegistry` resolution.
 *
 * @param template - Template whose `providers` are projected.
 * @param installs - Global install records (the store's `listExtensions()`).
 * @param attachments - Realm attachments (`[]` for a pre-launch review).
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
  attachments: readonly RealmExtensionAttachment[] = []
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
  const views: RealmExtensionRequestView[] = requests.map((request) => {
    const record = installsById.get(request.id) ?? null;
    const attachment = attachmentsById.get(request.id) ?? null;
    const state = resolutionStateFor(record !== null, attachment);
    const hint = record ? record.transportHint : request.transportHint;
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
      missing: isRealmExtensionStateMissing(state)
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
  const current = normalizeTuningSelector(selector);
  const universe = tuningUniverse(resolvedTools, attachments);
  if (typeof callName !== 'string' || !callName || !universe.includes(callName)) {
    return current;
  }
  const selected = current === 'all' ? new Set(universe) : new Set(current);
  if (enabled === true) selected.add(callName);
  else selected.delete(callName);
  if (selected.size === universe.length) {
    // Every resolved tool enabled (including the empty universe) is the
    // documented `'all'` default.
    return 'all';
  }
  const next: string[] = [];
  for (const name of universe) {
    if (selected.has(name)) next.push(name);
  }
  return Object.freeze(next);
}
