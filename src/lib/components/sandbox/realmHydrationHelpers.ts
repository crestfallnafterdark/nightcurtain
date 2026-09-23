/**
 * Template-hydration workspace helpers (format-v2 UI overhaul, ticket 874182b).
 *
 * Pure, UI-framework-free projections shared by `RealmLauncherModal.svelte`
 * (the hydration workspace: per-input requirements, fileset placement mapping,
 * directive review, payload digest/pin) and `RealmRehydrateModal.svelte` (the
 * Realm Manager's reopen/replace flow). The module never calls the store: every
 * function is a pure projection of its arguments, so the flow copy is
 * unit-testable without a DOM and the components stay thin rendering layers.
 *
 * Validation is never re-implemented here: the rehydrate plan runs the real
 * `validatePayload` and `materializeTemplate` from `realmCatalog`, so the
 * preview and the apply path share one validator. Digest rows use the catalog's
 * canonical `payloadDigest` (recursively sorted keys, no insignificant
 * whitespace).
 *
 * Realm opacity: every projection carries template-level labels or bare member
 * ids only — canonical workspace keys never appear in a rendered row.
 */

import {
  materializeTemplate,
  normalizeTemplate,
  payloadDigest,
  resolveDirectives,
  validatePayload
} from '../../sandbox/realmCatalog/index.ts';
import type {
  RealmDirective,
  RealmInputValues,
  RealmTemplate
} from '../../sandbox/realmCatalog/index.ts';
import { buildRealmInputUsageMap } from './realmLauncherHelpers.ts';
import type {
  RealmFilesInputDraft,
  RealmInputUsage,
  RealmInputUsageSite
} from './realmLauncherHelpers.ts';

/**
 * Formats a byte count for operator display (binary units, one decimal).
 *
 * @param bytes - Byte count (non-finite/negative values render `0 B`).
 * @returns `512 B`, `1.5 KiB`, or `2.0 MiB`.
 *
 * @example
 * ```typescript
 * formatRealmByteSize(1536); // '1.5 KiB'
 * ```
 */
export function formatRealmByteSize(bytes: unknown): string {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * UTF-8 byte length of one string body (the attachment size the fileset shows).
 *
 * @param text - File body.
 * @returns Byte length; `0` for non-strings.
 */
export function utf8ByteLength(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return new TextEncoder().encode(text).length;
}

/**
 * Resolves one template (v1 shim included) to the normalized v2 model, or
 * `null` when the value cannot be validated.
 *
 * @param template - Candidate template value.
 * @returns Normalized model, or `null`.
 */
function asV2Template(template: RealmTemplate | null | undefined): RealmTemplate | null {
  if (!template || typeof template !== 'object') return null;
  try {
    return normalizeTemplate(template);
  } catch {
    return null;
  }
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
 * One declared placement destination of an input: where its resolved value (or
 * fileset) lands at launch. Destinations are template-level labels only.
 */
export interface RealmInputPlacementDestination {
  /** Destination workspace kind. */
  readonly targetKind: 'realm' | 'agent';
  /** Target template agent key (empty for a Realm-global placement). */
  readonly agentKey: string;
  /** Display label of the destination (`Realm-global workspace` or `Name (key)`). */
  readonly targetLabel: string;
  /** How the value lands: `root` joins every attached file, `path` writes one destination. */
  readonly mode: 'root' | 'path';
  /** Destination root prefix (`root` mode) or destination path (`path` mode). */
  readonly destination: string;
}

/**
 * Derives the placement destinations of one input from its usage map.
 *
 * @param usage - Derived input usage map entry.
 * @returns Placement destinations in usage order (empty when none).
 *
 * @example
 * ```typescript
 * buildRealmInputPlacementDestinations(usage).map((entry) => entry.destination);
 * ```
 */
export function buildRealmInputPlacementDestinations(
  usage: RealmInputUsage | null | undefined
): RealmInputPlacementDestination[] {
  const sites = Array.isArray(usage?.sites) ? usage.sites : [];
  const destinations: RealmInputPlacementDestination[] = [];
  for (const site of sites) {
    if (!site || site.kind !== 'placement') continue;
    destinations.push({
      targetKind: site.targetKind,
      agentKey: site.agentKey,
      targetLabel: site.targetLabel,
      mode: site.selection === 'root' ? 'root' : 'path',
      destination: site.path
    });
  }
  return destinations;
}

/**
 * One attached file of a fileset with its display size and resolved destinations.
 */
export interface RealmFileAttachmentView {
  /** Attachment index inside the draft's fileset. */
  readonly index: number;
  /** Fileset-relative identity path. */
  readonly path: string;
  /** Source file name for display (`''` when typed). */
  readonly name: string;
  /** UTF-8 byte length of the body. */
  readonly sizeBytes: number;
  /** Display size (`1.5 KiB`). */
  readonly sizeLabel: string;
  /** Concrete destination paths this file lands at (root joins / single-path writes). */
  readonly destinations: readonly string[];
}

/**
 * Builds the per-file attachment rows of one fileset draft: size plus every
 * concrete placement destination the file resolves to.
 *
 * A `root` destination joins the file's own path onto the declared prefix (the
 * exact join `resolvePlacements` performs); a `path` destination names its
 * declared path only while the fileset holds exactly one file — a multi-file
 * fileset cannot write a single path, and the attachment validator owns that
 * error instead of a dishonest destination row.
 *
 * @param draft - Files-shape input draft.
 * @param destinations - The input's derived placement destinations.
 * @returns Per-file views in attachment order.
 *
 * @example
 * ```typescript
 * buildRealmFileAttachmentViews(draft, destinations)[0].sizeLabel; // '2.1 KiB'
 * ```
 */
export function buildRealmFileAttachmentViews(
  draft: RealmFilesInputDraft | null | undefined,
  destinations: readonly RealmInputPlacementDestination[] | null | undefined
): RealmFileAttachmentView[] {
  if (!draft || draft.shape !== 'files' || !Array.isArray(draft.files)) return [];
  const placements = Array.isArray(destinations) ? destinations : [];
  return draft.files.map((file, index) => {
    const resolved: string[] = [];
    for (const placement of placements) {
      if (!placement || typeof placement.destination !== 'string' || placement.destination.length === 0) continue;
      if (placement.mode === 'root') {
        const prefix = placement.destination.endsWith('/')
          ? placement.destination
          : `${placement.destination}/`;
        resolved.push(`${prefix}${file.path}`);
        continue;
      }
      if (draft.files.length === 1 && !resolved.includes(placement.destination)) {
        resolved.push(placement.destination);
      }
    }
    const sizeBytes = utf8ByteLength(file.content);
    return {
      index,
      path: file.path,
      name: typeof file.name === 'string' ? file.name : '',
      sizeBytes,
      sizeLabel: formatRealmByteSize(sizeBytes),
      destinations: resolved
    };
  });
}

/**
 * One declared directive with its resolved preview text for the hydration
 * workspace. Directives are derived content: they are edited at their bound
 * input, never directly.
 */
export interface RealmDirectiveReviewEntry {
  /** Target template agent key. */
  readonly targetAgentKey: string;
  /** Display label of the target. */
  readonly targetLabel: string;
  /** Whether the directive text is a literal or bound to a `text` input. */
  readonly source: 'literal' | 'input';
  /** Bound input id (`''` for a literal). */
  readonly inputId: string;
  /** Display label of the bound input (`''` for a literal). */
  readonly inputLabel: string;
  /** Resolved message text (`''` when an optional input resolves empty). */
  readonly text: string;
  /** Per-directive resolution error (`''` when resolvable). */
  readonly error: string;
}

/**
 * Directive review projection of one template.
 */
export interface RealmDirectiveReview {
  /** Whether every declared directive resolves against the supplied values. */
  readonly ok: boolean;
  /** Template-level failure text (`''` when the template normalized). */
  readonly error: string;
  /** Per-directive entries in declared order. */
  readonly entries: readonly RealmDirectiveReviewEntry[];
}

/**
 * Builds the declared-directive review from the effective input values, using
 * the catalog's own `resolveDirectives` per directive so a preview and the
 * launch can never disagree (an optional empty input delivers nothing, a
 * required empty input reports its typed failure).
 *
 * @param template - Selected template (v1 templates convert through the shim).
 * @param inputs - Effective shape-tagged input values.
 * @returns The directive review; per-entry errors never throw.
 *
 * @example
 * ```typescript
 * const review = buildRealmDirectiveReview(template, inputs);
 * review.entries.map((entry) => entry.text);
 * ```
 */
export function buildRealmDirectiveReview(
  template: RealmTemplate | null | undefined,
  inputs: RealmInputValues | null | undefined
): RealmDirectiveReview {
  const model = asV2Template(template);
  if (!model) {
    return { ok: false, error: 'The selected template could not be validated.', entries: [] };
  }
  const values: RealmInputValues = inputs && typeof inputs === 'object' ? inputs : {};
  const agents = Array.isArray(model.agents) ? model.agents : [];
  const declarations = Array.isArray(model.inputs) ? model.inputs : [];
  const declarationsById = new Map(declarations.map((declaration) => [declaration.id, declaration] as const));
  const labelFor = (key: unknown): string => {
    const spec = agents.find((agent) => agent.key === key) ?? null;
    if (!spec) return typeof key === 'string' ? key : 'unknown member';
    const name = typeof spec.name === 'string' && spec.name.trim().length > 0 ? spec.name : spec.key;
    return `${name} (${spec.key})`;
  };

  let allOk = true;
  const entries: RealmDirectiveReviewEntry[] = [];
  for (const directive of Array.isArray(model.directives) ? model.directives : []) {
    if (!directive || typeof directive !== 'object') continue;
    const boundInputId = typeof (directive as RealmDirective).inputId === 'string'
      ? ((directive as RealmDirective).inputId as string)
      : '';
    const literal = typeof (directive as RealmDirective).text === 'string'
      ? ((directive as RealmDirective).text as string)
      : '';
    const target = (directive as RealmDirective).target;
    const targetAgentKey = target && typeof target === 'object' && typeof target.agent === 'string'
      ? target.agent
      : '';
    let text = '';
    let error = '';
    try {
      const resolved = resolveDirectives([directive as RealmDirective], model.inputs, { inputs: values });
      text = resolved[0]?.text ?? '';
    } catch (err) {
      error = messageOf(err) || 'The directive does not resolve against the current values.';
      allOk = false;
    }
    entries.push({
      targetAgentKey,
      targetLabel: labelFor(targetAgentKey),
      source: boundInputId.length > 0 ? 'input' : 'literal',
      inputId: boundInputId,
      inputLabel: boundInputId.length > 0
        ? (declarationsById.get(boundInputId)?.label ?? boundInputId)
        : '',
      text,
      error
    });
  }
  return { ok: allOk, error: '', entries };
}

/**
 * One declared input's requirement review: the author-facing declaration plus
 * its derived usage map and placement destinations.
 */
export interface RealmInputRequirementReview {
  /** Declared input id. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Production brief (`''` when absent). */
  readonly brief: string;
  /** Help text (`''` when absent). */
  readonly help: string;
  /** Declared value domain. */
  readonly shape: 'text' | 'files';
  /** Whether composition fails while the input resolves empty. */
  readonly required: boolean;
  /** Whether a `text` input renders multiline (declared default true). */
  readonly multiline: boolean;
  /** Whether the declaration carries a `default`/`defaultFile` prefill. */
  readonly hasDefault: boolean;
  /** Bundle-relative default file name (`''` when none). */
  readonly defaultFileName: string;
  /** One-line usage summary (`2 system prompt references · 1 placement`). */
  readonly usageSummary: string;
  /** Derived usage sites. */
  readonly usageSites: readonly RealmInputUsageSite[];
  /** Derived placement destinations. */
  readonly placements: readonly RealmInputPlacementDestination[];
  /** Fileset paths referenced by prompt/history `path` selections. */
  readonly selectionPaths: readonly string[];
}

/**
 * Builds the per-input requirement reviews for one template (declared order).
 *
 * @param template - Selected template (v1 templates convert through the shim).
 * @returns Requirement reviews; empty for a malformed/absent template.
 *
 * @example
 * ```typescript
 * buildRealmInputRequirementReviews(template).map((entry) => entry.id);
 * ```
 */
export function buildRealmInputRequirementReviews(
  template: RealmTemplate | null | undefined
): RealmInputRequirementReview[] {
  const model = asV2Template(template);
  if (!model) return [];
  const usageMap = buildRealmInputUsageMap(model);
  const reviews: RealmInputRequirementReview[] = [];
  for (const declaration of Array.isArray(model.inputs) ? model.inputs : []) {
    if (!declaration || typeof declaration !== 'object' || typeof declaration.id !== 'string') continue;
    const usage = usageMap.get(declaration.id) ?? null;
    const sites = usage?.sites ?? [];
    const selectionPaths: string[] = [];
    for (const site of sites) {
      if (!site || site.selection !== 'path' || site.path.length === 0) continue;
      if (!selectionPaths.includes(site.path)) selectionPaths.push(site.path);
    }
    const defaultFileName = typeof declaration.defaultFile === 'string' ? declaration.defaultFile : '';
    reviews.push({
      id: declaration.id,
      label: typeof declaration.label === 'string' && declaration.label.length > 0
        ? declaration.label
        : declaration.id,
      brief: typeof declaration.brief === 'string' ? declaration.brief : '',
      help: typeof declaration.help === 'string' ? declaration.help : '',
      shape: declaration.shape === 'files' ? 'files' : 'text',
      required: declaration.required === true,
      multiline: declaration.multiline !== false,
      hasDefault: typeof declaration.default === 'string' || defaultFileName.length > 0,
      defaultFileName,
      usageSummary: usage?.summary ?? 'Declared but not referenced.',
      usageSites: sites,
      placements: buildRealmInputPlacementDestinations(usage),
      selectionPaths
    });
  }
  return reviews;
}

/**
 * Payload digest + template pin projection of the reviewed launch content.
 */
export interface RealmHydrationPinView {
  /** Whether the projection has anything honest to show. */
  readonly visible: boolean;
  /** Template id the content targets. */
  readonly templateId: string;
  /** Effective template pin the launch validates against (`sha256:<hex>` or `''`). */
  readonly pin: string;
  /** Canonical payload digest (`sha256:<hex>` or `''` when undigestible). */
  readonly digest: string;
  /** Whether the digest resolved. */
  readonly digestOk: boolean;
  /** Digest failure text (`''` when none). */
  readonly digestError: string;
  /** Count of input values carried by the payload. */
  readonly inputCount: number;
  /** Count of attached files carried by the payload's filesets. */
  readonly fileCount: number;
  /** Operator-facing source label of the reviewed content. */
  readonly sourceLabel: string;
}

/**
 * Builds the review-time digest/pin card from a validated launch payload.
 *
 * The digest is the catalog's canonical `payloadDigest`; an undigestible value
 * reports the failure inline instead of rendering a fake hash. The counts are
 * read from the authored payload form (`{ text }` / `{ files }`).
 *
 * @param input - Template id, effective pin, reviewed payload, and source label.
 * @returns The pin/digest projection.
 *
 * @example
 * ```typescript
 * const view = buildRealmHydrationPinView({
 *   templateId: 'session_zero',
 *   templateVersion: pin,
 *   payload: inputProjection.payload,
 *   sourceLabel: 'assembled inputs'
 * });
 * view.digest; // 'sha256:…'
 * ```
 */
export function buildRealmHydrationPinView(input: {
  readonly templateId?: unknown;
  readonly templateVersion?: unknown;
  readonly payload?: unknown;
  readonly sourceLabel?: unknown;
}): RealmHydrationPinView {
  const templateId = typeof input?.templateId === 'string' ? input.templateId : '';
  const pin = typeof input?.templateVersion === 'string' ? input.templateVersion : '';
  const sourceLabel = typeof input?.sourceLabel === 'string' && input.sourceLabel.length > 0
    ? input.sourceLabel
    : 'no payload attached';
  const payload = input?.payload;
  if (!templateId && payload === undefined) {
    return {
      visible: false,
      templateId,
      pin,
      digest: '',
      digestOk: false,
      digestError: '',
      inputCount: 0,
      fileCount: 0,
      sourceLabel
    };
  }
  let inputCount = 0;
  let fileCount = 0;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const inputs = (payload as Record<string, unknown>).inputs;
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
      for (const value of Object.values(inputs as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        inputCount += 1;
        const files = (value as Record<string, unknown>).files;
        if (Array.isArray(files)) fileCount += files.length;
      }
    }
  }
  let digest = '';
  let digestOk = false;
  let digestError = '';
  if (payload === undefined) {
    digestError = 'No launch payload is assembled yet.';
  } else {
    try {
      digest = payloadDigest(payload);
      digestOk = true;
    } catch (error) {
      digestError = messageOf(error) || 'The reviewed payload could not be digested.';
    }
  }
  return {
    visible: true,
    templateId,
    pin,
    digest,
    digestOk,
    digestError,
    inputCount,
    fileCount,
    sourceLabel
  };
}

/**
 * Input/file summary of one authored payload (`3 inputs · 2 files`).
 *
 * @param payload - Authored payload value.
 * @returns Summary text; `no input values` when empty/unknown.
 *
 * @example
 * ```typescript
 * describeRealmPayloadInputs(payload); // '3 inputs · 2 files'
 * ```
 */
export function describeRealmPayloadInputs(payload: unknown): string {
  let inputCount = 0;
  let fileCount = 0;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const inputs = (payload as Record<string, unknown>).inputs;
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
      for (const value of Object.values(inputs as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        inputCount += 1;
        const files = (value as Record<string, unknown>).files;
        if (Array.isArray(files)) fileCount += files.length;
      }
    }
  }
  if (inputCount === 0) return 'no input values';
  const inputs = `${inputCount} input${inputCount === 1 ? '' : 's'}`;
  if (fileCount === 0) return inputs;
  return `${inputs} · ${fileCount} file${fileCount === 1 ? '' : 's'}`;
}

/**
 * Name-validation result of one saved-payload draft.
 */
export interface RealmSavedPayloadNameValidation {
  /** Whether the name is accepted. */
  readonly ok: boolean;
  /** Refusal copy (`''` when accepted). */
  readonly error: string;
  /** Trimmed accepted name. */
  readonly name: string;
}

/**
 * Validates a saved-payload name: non-empty after trimming and unique
 * (case-insensitive) among the existing names.
 *
 * @param name - Operator-supplied name.
 * @param existingNames - Names already saved (compared case-insensitively).
 * @returns Validation result with the trimmed name.
 *
 * @example
 * ```typescript
 * validateRealmSavedPayloadName('  Act 1 ', ['act 2']).ok; // true
 * ```
 */
export function validateRealmSavedPayloadName(
  name: unknown,
  existingNames?: readonly string[] | null
): RealmSavedPayloadNameValidation {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) {
    return { ok: false, error: 'Name the payload before saving it.', name: '' };
  }
  const taken = new Set(
    (Array.isArray(existingNames) ? existingNames : [])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
  );
  if (taken.has(trimmed.toLowerCase())) {
    return { ok: false, error: `A payload named "${trimmed}" is already saved — pick another name.`, name: trimmed };
  }
  return { ok: true, error: '', name: trimmed };
}

/**
 * Builds a safe download filename for one named saved payload:
 * `<templateId>--<sanitized-name>.package.json`.
 *
 * @param name - Saved payload name.
 * @param templateId - Template id the payload targets.
 * @returns Filesystem-safe filename.
 *
 * @example
 * ```typescript
 * buildRealmSavedPayloadFilename('Act 1', 'session_zero');
 * // 'session_zero--Act_1.package.json'
 * ```
 */
export function buildRealmSavedPayloadFilename(name: unknown, templateId: unknown): string {
  const sanitize = (value: unknown, fallback: string): string => {
    const raw = typeof value === 'string' ? value.trim() : '';
    const safe = raw
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+/, '')
      .replace(/[._-]+$/, '');
    return safe.length > 0 ? safe : fallback;
  };
  return `${sanitize(templateId, 'realm-template')}--${sanitize(name, 'payload')}.package.json`;
}

/**
 * One active member of a Realm the rehydrate flow can address (bare id + display
 * name only — membership is realm-opaque).
 */
export interface RealmRehydrateMember {
  /** Bare realm-local agent id. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
}

/**
 * One file the rehydrate plan writes.
 */
export interface RealmRehydrateFile {
  /** Destination path. */
  readonly path: string;
  /** File body. */
  readonly content: string;
}

/**
 * One destination group of the rehydrate plan: the files written into one
 * workspace in a single store call.
 */
export interface RealmRehydrateWriteGroup {
  /** Destination workspace kind. */
  readonly targetKind: 'realm' | 'agent';
  /** Target template agent key (empty for the Realm-global group). */
  readonly agentKey: string;
  /** Bare target member id (empty for the Realm-global group). */
  readonly agentId: string;
  /** Display label of the destination. */
  readonly targetLabel: string;
  /** Files to write, in resolved order. */
  readonly files: readonly RealmRehydrateFile[];
}

/**
 * One directive the rehydrate plan delivers to an existing member.
 */
export interface RealmRehydrateDirective {
  /** Target template agent key. */
  readonly agentKey: string;
  /** Bare target member id. */
  readonly agentId: string;
  /** Display label of the target. */
  readonly targetLabel: string;
  /** Resolved message text. */
  readonly text: string;
}

/**
 * Rehydrate plan projection: validated, materialized writes and directives for
 * an existing Realm, ready to apply through the store's seed/send surfaces.
 */
export interface RealmRehydratePlan {
  /** Whether the plan resolved and every referenced member exists. */
  readonly ok: boolean;
  /** Typed failure text (`''` when `ok`). */
  readonly error: string;
  /** Validator warnings (e.g. an explicitly allowed version mismatch). */
  readonly warnings: readonly string[];
  /** Template id the payload targets. */
  readonly templateId: string;
  /** Effective template version the plan validated against. */
  readonly currentVersion: string;
  /** Payload pin (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Whether the payload pin differs from the effective version. */
  readonly mismatch: boolean;
  /** Canonical payload digest (`sha256:<hex>` or `''`). */
  readonly digest: string;
  /** Placement write groups in first-appearance target order. */
  readonly writes: readonly RealmRehydrateWriteGroup[];
  /** Resolved directives in declared order. */
  readonly directives: readonly RealmRehydrateDirective[];
  /** Total files across every write group. */
  readonly fileCount: number;
}

/**
 * Builds the rehydrate plan for one existing Realm: validates the attached
 * payload through the real catalog `validatePayload`, materializes the
 * template with the resolved values (`materializeTemplate` — the exact
 * resolver the launch uses), maps placement/directive agent keys onto the
 * Realm's active members, and groups the resolved writes by destination.
 *
 * A template agent key referenced by a placement or directive with no active
 * member fails closed with a clear message (nothing is written); a member id
 * that is not the plan's resolved id is never matched by pattern.
 *
 * @param options - Template, realm id, payload, bundle files, active members, and the effective/pinned versions.
 * @returns The plan; failures are inline, never thrown.
 *
 * @example
 * ```typescript
 * const plan = buildRealmRehydratePlan({
 *   template, realmId, payload, members, currentVersion
 * });
 * plan.ok ? plan.writes.length : 0;
 * ```
 */
export function buildRealmRehydratePlan(options: {
  readonly template?: RealmTemplate | null;
  readonly realmId?: unknown;
  readonly payload?: unknown;
  readonly bundleFiles?: Readonly<Record<string, string>> | null;
  readonly members?: readonly RealmRehydrateMember[] | null;
  readonly currentVersion?: unknown;
  readonly allowVersionMismatch?: unknown;
}): RealmRehydratePlan {
  const empty = (error: string): RealmRehydratePlan => ({
    ok: false,
    error,
    warnings: [],
    templateId: '',
    currentVersion: '',
    templateVersion: '',
    mismatch: false,
    digest: '',
    writes: [],
    directives: [],
    fileCount: 0
  });
  const realmId = typeof options?.realmId === 'string' ? options.realmId.trim() : '';
  if (realmId.length === 0) return empty('Rehydrate requires a registered Realm.');
  const model = asV2Template(options?.template ?? null);
  if (!model) return empty('The Realm\'s launch template could not be resolved or validated.');
  const currentVersion = typeof options?.currentVersion === 'string' ? options.currentVersion.trim() : '';
  const bundleFiles = options?.bundleFiles && typeof options.bundleFiles === 'object'
    ? options.bundleFiles
    : undefined;
  const members = Array.isArray(options?.members) ? options.members : [];
  const membersById = new Map(
    members
      .filter((member): member is RealmRehydrateMember => (
        Boolean(member) && typeof member.id === 'string' && member.id.length > 0
      ))
      .map((member) => [member.id, member] as const)
  );

  let resolved: ReturnType<typeof validatePayload>;
  try {
    resolved = validatePayload(model, options?.payload, {
      ...(currentVersion.length > 0 ? { currentVersion } : {}),
      ...(options?.allowVersionMismatch === true ? { allowVersionMismatch: true } : {})
    });
  } catch (error) {
    return empty(messageOf(error) || 'The attached payload is not valid for this Realm\'s template.');
  }

  let plan: ReturnType<typeof materializeTemplate>;
  try {
    plan = materializeTemplate(model, {
      realmId,
      inputs: resolved.inputs,
      ...(bundleFiles ? { bundleFiles } : {})
    });
  } catch (error) {
    return empty(messageOf(error) || 'The template could not be resolved for rehydration.');
  }

  const agentIdByKey = new Map(plan.agents.map((agent) => [agent.key, agent.agentId] as const));
  const nameByKey = new Map(plan.agents.map((agent) => [
    agent.key,
    typeof agent.name === 'string' && agent.name.trim().length > 0 ? agent.name : agent.key
  ] as const));

  const memberFor = (agentKey: string): RealmRehydrateMember | null => {
    const agentId = agentIdByKey.get(agentKey);
    if (!agentId) return null;
    return membersById.get(agentId) ?? null;
  };

  /** Mutable internal group shape (files grow as placements resolve). */
  type MutableWriteGroup = {
    targetKind: 'realm' | 'agent';
    agentKey: string;
    agentId: string;
    targetLabel: string;
    files: RealmRehydrateFile[];
  };
  const writeGroups: MutableWriteGroup[] = [];
  const groupsByTarget = new Map<string, MutableWriteGroup>();
  const groupFor = (target: 'realm' | { agent: string }): MutableWriteGroup | null => {
    if (target === 'realm') {
      const key = 'realm';
      let group = groupsByTarget.get(key);
      if (!group) {
        group = {
          targetKind: 'realm',
          agentKey: '',
          agentId: '',
          targetLabel: 'Realm-global workspace',
          files: []
        };
        groupsByTarget.set(key, group);
        writeGroups.push(group);
      }
      return group;
    }
    const agentKey = typeof target.agent === 'string' ? target.agent : '';
    const member = memberFor(agentKey);
    if (!member) return null;
    const key = `agent:${agentKey}`;
    let group = groupsByTarget.get(key);
    if (!group) {
      group = {
        targetKind: 'agent',
        agentKey,
        agentId: member.id,
        targetLabel: member.name.trim().length > 0 ? member.name : member.id,
        files: []
      };
      groupsByTarget.set(key, group);
      writeGroups.push(group);
    }
    return group;
  };

  for (const placement of plan.placements) {
    const group = groupFor(placement.target);
    if (!group) {
      const agentKey = typeof placement.target === 'object' ? placement.target.agent : '';
      const label = nameByKey.get(agentKey) ?? agentKey;
      return empty(
        `The template placement targets member "${label}", which is not an active member of this Realm — relaunch the Realm or remove that placement.`
      );
    }
    group.files.push({ path: placement.path, content: placement.content });
  }

  const directives: RealmRehydrateDirective[] = [];
  for (const directive of plan.directives) {
    const member = memberFor(directive.targetAgentKey);
    if (!member) {
      const label = nameByKey.get(directive.targetAgentKey) ?? directive.targetAgentKey;
      return empty(
        `A template directive targets member "${label}", which is not an active member of this Realm — relaunch the Realm or remove that directive.`
      );
    }
    directives.push({
      agentKey: directive.targetAgentKey,
      agentId: member.id,
      targetLabel: member.name.trim().length > 0 ? member.name : member.id,
      text: directive.text
    });
  }

  let digest = '';
  try {
    digest = payloadDigest(options?.payload);
  } catch {
    digest = '';
  }

  const fileCount = writeGroups.reduce((total, group) => total + group.files.length, 0);
  return {
    ok: true,
    error: '',
    warnings: resolved.warnings,
    templateId: resolved.templateId,
    currentVersion,
    templateVersion: resolved.templateVersion,
    mismatch: currentVersion.length > 0 && currentVersion !== resolved.templateVersion,
    digest,
    writes: writeGroups,
    directives,
    fileCount
  };
}

/**
 * One applied write receipt folded into realm-opaque copy.
 */
export interface RealmRehydrateWriteReceipt {
  /** Display label of the destination. */
  readonly targetLabel: string;
  /** Realm-opaque workspace label. */
  readonly workspaceLabel: string;
  /** Written paths. */
  readonly writtenPaths: readonly string[];
}

/**
 * Describes the outcome of one rehydrate apply for the inline receipt line.
 *
 * @param receipts - Per-group write receipts.
 * @param directives - Per-directive delivery outcomes.
 * @returns One-line operator receipt.
 *
 * @example
 * ```typescript
 * describeRealmRehydrateOutcome([], []); // 'Nothing was written.'
 * ```
 */
export function describeRealmRehydrateOutcome(
  receipts: readonly RealmRehydrateWriteReceipt[],
  directives: readonly { readonly targetLabel: string; readonly delivered: boolean }[]
): string {
  const writeList = Array.isArray(receipts) ? receipts : [];
  const directiveList = Array.isArray(directives) ? directives : [];
  const fileCount = writeList.reduce((total, receipt) => total + receipt.writtenPaths.length, 0);
  const delivered = directiveList.filter((entry) => entry.delivered === true).length;
  const failed = directiveList.length - delivered;
  const parts: string[] = [];
  if (fileCount > 0) {
    const targets = writeList
      .filter((receipt) => receipt.writtenPaths.length > 0)
      .map((receipt) => receipt.targetLabel)
      .join(', ');
    parts.push(`Wrote ${fileCount} file${fileCount === 1 ? '' : 's'} into ${targets || 'no destination'}.`);
  }
  if (delivered > 0) {
    parts.push(`Delivered ${delivered} directive${delivered === 1 ? '' : 's'} (operator-attributed).`);
  }
  if (failed > 0) {
    parts.push(`${failed} directive${failed === 1 ? '' : 's'} could not be delivered.`);
  }
  if (parts.length === 0) return 'Nothing was written.';
  return parts.join(' ');
}

/**
 * One input-hash provenance row of a launched Realm.
 */
export interface RealmProvenanceInputRow {
  /** Declared input id the hash covers. */
  readonly inputId: string;
  /** Full hash string from the provenance record. */
  readonly hash: string;
  /** Shortened hash for display. */
  readonly shortHash: string;
}

/**
 * Detail projection of one Realm record's launch provenance: per-input hashes
 * and seeded paths (hashes and paths only — raw values are never recorded).
 */
export interface RealmProvenanceDetailView {
  /** Whether the detail block renders. */
  readonly visible: boolean;
  /** Per-input hash rows in record order. */
  readonly inputRows: readonly RealmProvenanceInputRow[];
  /** Seeded placement paths recorded at launch. */
  readonly seedPaths: readonly string[];
}

/**
 * Builds the provenance detail rows from `RealmRecord.instance`.
 *
 * @param realm - Realm record (structural; `instance` read only).
 * @returns Detail view; hidden when the record carries no valid provenance block.
 *
 * @example
 * ```typescript
 * buildRealmProvenanceDetailView(realm).inputRows.length;
 * ```
 */
export function buildRealmProvenanceDetailView(
  realm: { readonly instance?: unknown } | null | undefined
): RealmProvenanceDetailView {
  const instance = realm && typeof realm === 'object' && realm.instance && typeof realm.instance === 'object'
    ? (realm.instance as Record<string, unknown>)
    : null;
  if (!instance) return { visible: false, inputRows: [], seedPaths: [] };
  const inputHashes = instance.inputHashes && typeof instance.inputHashes === 'object' && !Array.isArray(instance.inputHashes)
    ? (instance.inputHashes as Record<string, unknown>)
    : {};
  const inputRows: RealmProvenanceInputRow[] = [];
  for (const [inputId, hash] of Object.entries(inputHashes)) {
    if (typeof hash !== 'string' || hash.length === 0) continue;
    inputRows.push({
      inputId,
      hash,
      shortHash: hash.length > 27 ? `${hash.slice(0, 24)}…` : hash
    });
  }
  const seedPaths = Array.isArray(instance.seedPaths)
    ? instance.seedPaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
    : [];
  return { visible: true, inputRows, seedPaths };
}
