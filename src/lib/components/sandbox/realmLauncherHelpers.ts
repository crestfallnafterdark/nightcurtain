/**
 * Realm launcher UI helpers (Wave B, ticket b309e02).
 *
 * Pure, UI-framework-free projections and fail-closed validation shared by
 * `RealmLauncherModal.svelte`: the per-agent launch preview (built from the
 * `realmCatalog` capability summaries), the preset-binding display model, the
 * seed file-row parser, the seed-target options, and the store-error/seed-
 * workspace descriptions.
 *
 * Format v2 additions (ticket a71198f): the launcher renders the normalized
 * v2 input requirements — `text` fields (label/help/multiline/required/
 * `default` prefill) and `files` fields (attached files carrying their own
 * fileset-relative `path`) — derives the per-input usage map (where the input
 * lands across prompt/history `input` parts, placements, and directives), and
 * validates the operator-assembled values through the store's own v2 path by
 * synthesizing the canonical payload envelope and running the real
 * `validatePayload`. Failures surface with a typed class (missing required,
 * pin mismatch, unknown input, shape mismatch) and per-field inline errors
 * without ever leaking a canonical workspace key: every label rendered here is
 * a template-level target label (`Realm-global workspace` or `Name (key)`).
 *
 * These helpers never call the store and never hold state: every function is a
 * pure projection of its arguments, so the modal stays a thin rendering layer
 * and the validation rules are unit-testable without a DOM.
 */

import {
  composeAgentHistory,
  composeSystemPrompt,
  normalizeTemplate,
  summarizeAgentCapabilities,
  validatePayload
} from '../../sandbox/realmCatalog/index.ts';
import { REALM_CATALOG_ERROR_CODES } from '../../sandbox/realmCatalog/index.ts';
import type {
  AgentCapabilitySummary,
  PromptPart,
  RealmAgentSpec,
  RealmComposeOptions,
  RealmDirective,
  RealmInputProvenance,
  RealmInputValue,
  RealmInputValues,
  RealmPayloadInputValue,
  RealmPlacement,
  RealmTemplate,
  RealmTemplateInput
} from '../../sandbox/realmCatalog/index.ts';
import { normalizeVirtualPath } from '../../sandbox/virtualFs/index.ts';

/**
 * Successful or failed preview projection of one template.
 *
 * `rows` preserves template order; a presentation-level template failure
 * (invalid spec) is reported through `error` instead of throwing, so the modal
 * can render the message inline and block the launch.
 */
export interface RealmPreviewProjection {
  /** Whether every agent spec projected into a capability summary. */
  readonly ok: boolean;
  /** Per-agent capability summaries, in template order (empty on failure). */
  readonly rows: readonly AgentCapabilitySummary[];
  /** User-facing failure text; empty when `ok` is true. */
  readonly error: string;
}

/**
 * Builds the per-agent preview projection for one template.
 *
 * Every row is the honest capability summary produced by the catalog
 * (`grants`, `mutating`/`readOnly` classification, wildcard and privilege
 * flags), so the preview can never understate what a launched member may do.
 *
 * @param template - Selected template, or `null`/`undefined` when none is selected yet.
 * @returns The projection; `ok: false` carries an inline message.
 *
 * @example
 * ```typescript
 * const preview = buildRealmPreviewProjection(DEMO_TEMPLATE);
 * preview.rows[0].name; // 'Coordinator'
 * ```
 */
export function buildRealmPreviewProjection(
  template: RealmTemplate | null | undefined
): RealmPreviewProjection {
  if (!template || typeof template !== 'object' || !Array.isArray(template.agents)) {
    return { ok: false, rows: [], error: 'Select a template to preview its agents.' };
  }
  try {
    return { ok: true, rows: template.agents.map((spec) => summarizeAgentCapabilities(spec)), error: '' };
  } catch (error) {
    return { ok: false, rows: [], error: messageOf(error) || 'The template preview could not be built.' };
  }
}

/**
 * Composed-prompt preview for one template agent.
 *
 * `ok: false` carries an inline message instead of throwing; when the failure
 * is an unresolvable bundle entry (`file` part or `defaultFile` prefill) the
 * `bundleUnavailable` flag tells the launcher to render the explicit
 * "bundle not available" state rather than a composition error.
 */
export interface RealmPromptPreview {
  /** Whether the prompt composed. */
  readonly ok: boolean;
  /** Composed system prompt (empty on failure). */
  readonly systemPrompt: string;
  /** One entry per referenced input, in first-reference order (empty on failure). */
  readonly inputProvenance: readonly RealmInputProvenance[];
  /** Whether the failure is a missing bundle file. */
  readonly bundleUnavailable: boolean;
  /** User-facing failure text; empty when `ok` is true. */
  readonly error: string;
}

/**
 * Composes one agent's preview prompt through the catalog's real
 * `composeSystemPrompt`, so a preview can never disagree with the prompt the
 * launch materializes.
 *
 * Parts contribute in declared order with the same rules as materialization
 * (`file`/`text` verbatim, empty inputs omitted, contributing pieces joined
 * with a blank line). A missing bundle entry — a `file` part whose path is not
 * in `bundleFiles`, or a referenced input's `defaultFile` prefill — is
 * reported as `bundleUnavailable` before composition instead of crashing the
 * modal; every other failure (undeclared input, required input empty, fileset
 * selection mismatch) is reported through `error`. Composition runs through
 * the real `composeSystemPrompt`, so a files input part resolves the exact
 * file its `path` selects.
 *
 * @param parts - Ordered prompt parts of the agent spec.
 * @param inputs - Declared template inputs referenced by `input` parts.
 * @param options - Supplied shape-tagged input values and bundle file bodies.
 * @returns The preview projection; failures are inline, never thrown.
 *
 * @example
 * ```typescript
 * const preview = buildRealmPromptPreview(
 *   [{ kind: 'text', text: 'Protocol.' }, { kind: 'input', inputId: 'directives' }],
 *   [{ id: 'directives', label: 'Directives', shape: 'text' }],
 *   { inputs: { directives: { shape: 'text', text: 'Be concise.' } } }
 * );
 * preview.systemPrompt; // 'Protocol.\n\nBe concise.'
 * ```
 */
export function buildRealmPromptPreview(
  parts: readonly PromptPart[] | null | undefined,
  inputs: readonly RealmTemplateInput[] | null | undefined,
  options: RealmComposeOptions | null | undefined = {}
): RealmPromptPreview {
  const partList = Array.isArray(parts) ? parts : [];
  const declarations = Array.isArray(inputs) ? inputs : [];
  const opts = options && typeof options === 'object' ? options : {};
  const bundleFiles = opts.bundleFiles && typeof opts.bundleFiles === 'object' ? opts.bundleFiles : {};
  const shapeTagged = opts.inputs && typeof opts.inputs === 'object' ? opts.inputs : null;

  const inputsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    declarations
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );
  const missing: string[] = [];
  for (const part of partList) {
    if (!part || typeof part !== 'object') continue;
    if (part.kind === 'file' && typeof part.path === 'string'
      && !Object.prototype.hasOwnProperty.call(bundleFiles, part.path)) {
      missing.push(part.path);
    }
    if (part.kind === 'input') {
      const declaration = inputsById.get(part.inputId);
      const defaultFile = declaration?.defaultFile;
      if (typeof defaultFile === 'string'
        && !shapeTaggedHasValue(shapeTagged, part.inputId)
        && !Object.prototype.hasOwnProperty.call(bundleFiles, defaultFile)) {
        missing.push(defaultFile);
      }
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    return {
      ok: false,
      systemPrompt: '',
      inputProvenance: [],
      bundleUnavailable: true,
      error: `Prompt bundle files are not available: ${unique.join(', ')}. The composed prompt cannot be previewed yet.`
    };
  }

  try {
    const composed = composeSystemPrompt(partList, declarations, { inputs: shapeTagged ?? {}, bundleFiles });
    return {
      ok: true,
      systemPrompt: composed.systemPrompt,
      inputProvenance: composed.inputProvenance,
      bundleUnavailable: false,
      error: ''
    };
  } catch (error) {
    return {
      ok: false,
      systemPrompt: '',
      inputProvenance: [],
      bundleUnavailable: false,
      error: messageOf(error) || 'The composed prompt could not be previewed.'
    };
  }
}

/**
 * Whether one shape-tagged value set carries a supplied value for an input.
 *
 * @param inputs - Shape-tagged values, or `null`.
 * @param inputId - Declared input id.
 * @returns `true` when the input has a supplied value.
 */
function shapeTaggedHasValue(inputs: RealmInputValues | null, inputId: string): boolean {
  return Boolean(inputs && Object.prototype.hasOwnProperty.call(inputs, inputId));
}

/**
 * One composed baked-history message rendered by the launcher's read-only
 * history preview.
 */
export interface RealmHistoryPreviewEntry {
  /** Message attribution: the operator (`user`) or the agent itself (`assistant`). */
  readonly role: 'user' | 'assistant';
  /** Display label of the role (`Operator`/`Agent`). */
  readonly roleLabel: string;
  /** Composed content (never empty). */
  readonly content: string;
}

/**
 * Read-only baked-history preview for one template agent.
 *
 * `ok: false` carries an inline message instead of throwing; when the failure
 * is an unresolvable bundle entry (`file` part or a referenced input's
 * `defaultFile` prefill) the `bundleUnavailable` flag tells the launcher to
 * render the explicit "bundle not available" state rather than a composition
 * error.
 */
export interface RealmHistoryPreview {
  /** Whether the declared history composed. */
  readonly ok: boolean;
  /** Composed messages in declared order (empty when no history is declared). */
  readonly entries: readonly RealmHistoryPreviewEntry[];
  /** Whether the failure is a missing bundle file. */
  readonly bundleUnavailable: boolean;
  /** User-facing failure text; empty when `ok` is true. */
  readonly error: string;
}

/**
 * Builds the read-only baked-history preview for one template agent through
 * the catalog's real `composeAgentHistory`, so a preview can never disagree
 * with the history the launch seeds.
 *
 * Missing bundle entries (`file` parts and referenced `defaultFile` prefills)
 * are reported as `bundleUnavailable` before composition; every other failure
 * (undeclared input reference, an entry that composes empty) is reported
 * through `error`. Entries carry the declared role plus the composed content
 * and are never editable this wave (the hydration wave adds prompt/file
 * editing).
 *
 * @param spec - Agent spec whose `history` is previewed.
 * @param inputs - Declared template inputs referenced by history parts.
 * @param options - Launch input values and bundle file bodies.
 * @returns The history projection; failures are inline, never thrown.
 *
 * @example
 * ```typescript
 * const preview = buildRealmHistoryPreview(
 *   { key: 'gm', history: [{ role: 'assistant', content: [{ kind: 'text', text: 'Rain.' }] }] },
 *   [],
 *   {}
 * );
 * preview.entries[0]; // { role: 'assistant', roleLabel: 'Agent', content: 'Rain.' }
 * ```
 */
export function buildRealmHistoryPreview(
  spec: RealmAgentSpec | null | undefined,
  inputs: readonly RealmTemplateInput[] | null | undefined,
  options: RealmComposeOptions | null | undefined = {}
): RealmHistoryPreview {
  const failure = (error: string, bundleUnavailable = false): RealmHistoryPreview => ({
    ok: false,
    entries: [],
    bundleUnavailable,
    error
  });
  if (!spec || typeof spec !== 'object') {
    return failure('Select a template agent to preview its baked history.');
  }
  const declarations = Array.isArray(inputs) ? inputs : [];
  const opts = options && typeof options === 'object' ? options : {};
  const bundleFiles = opts.bundleFiles && typeof opts.bundleFiles === 'object' ? opts.bundleFiles : {};
  const shapeTagged = opts.inputs && typeof opts.inputs === 'object' ? opts.inputs : null;
  const history = Array.isArray(spec.history) ? spec.history : [];

  const inputsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    declarations
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );
  const missing: string[] = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.content)) continue;
    for (const part of entry.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.kind === 'file' && typeof part.path === 'string'
        && !Object.prototype.hasOwnProperty.call(bundleFiles, part.path)) {
        missing.push(part.path);
        continue;
      }
      if (part.kind === 'input') {
        const inputId = typeof part.inputId === 'string' ? part.inputId : '';
        const declaration = inputId.length > 0 ? inputsById.get(inputId) ?? null : null;
        if (!declaration) {
          return failure(`The baked history references undeclared input "${String(part.inputId)}".`);
        }
        if (typeof declaration.defaultFile === 'string'
          && !shapeTaggedHasValue(shapeTagged, declaration.id)
          && !Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
          missing.push(declaration.defaultFile);
        }
      }
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    return failure(
      `History bundle files are not available: ${unique.join(', ')}. The baked history cannot be previewed yet.`,
      true
    );
  }

  try {
    const composed = composeAgentHistory(spec, declarations, { inputs: shapeTagged ?? {}, bundleFiles });
    return {
      ok: true,
      entries: composed.map((message) => ({
        role: message.role,
        roleLabel: message.role === 'assistant' ? 'Agent' : 'Operator',
        content: message.content
      })),
      bundleUnavailable: false,
      error: ''
    };
  } catch (error) {
    return failure(messageOf(error) || 'The baked history could not be previewed.');
  }
}

/**
 * Resolves the template-declared prefill for one input.
 *
 * @param input - Declared template input.
 * @param bundleFiles - Bundle file bodies keyed by bundle-relative path.
 * @returns The prefill text plus whether it resolved (`defaultFile` missing → `false`).
 */
function resolveInputPrefill(
  input: RealmTemplateInput,
  bundleFiles: Readonly<Record<string, string>>
): { value: string; resolved: boolean } {
  if (typeof input.default === 'string') {
    return { value: input.default, resolved: true };
  }
  if (typeof input.defaultFile === 'string') {
    if (Object.prototype.hasOwnProperty.call(bundleFiles, input.defaultFile)) {
      return { value: bundleFiles[input.defaultFile], resolved: true };
    }
    return { value: '', resolved: false };
  }
  return { value: '', resolved: true };
}

// ============================================================================
// Launch inputs (ticket a71198f)
// ============================================================================

/**
 * Reads a template as the canonical model: the store exposes already-validated
 * templates, and the launcher helpers stay tolerant of presentation-level
 * malformation (the template preview owns structural reporting). Legacy
 * format-v1 documents are converted through the catalog's read shim so direct
 * v1 callers keep working.
 *
 * @param template - Candidate template (canonical, legacy v1, or malformed).
 * @returns The canonical model, or `null` when the candidate is not a template.
 */
function asRealmTemplate(template: unknown): RealmTemplate | null {
  if (!template || typeof template !== 'object') return null;
  if ((template as RealmTemplate).formatVersion === 2) return template as RealmTemplate;
  try {
    return normalizeTemplate(template);
  } catch {
    return null;
  }
}

/**
 * Display label of one template agent key (`Name (key)`, else the raw key).
 *
 * @param agents - Declared agent specs.
 * @param key - Template agent key.
 * @returns Display label; never a launched agent id or a workspace key.
 */
function agentKeyLabel(
  agents: readonly RealmAgentSpec[],
  key: string
): string {
  const spec = agents.find((entry) => entry && entry.key === key) ?? null;
  const name = spec && typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : '';
  return name.length > 0 ? `${name} (${key})` : key;
}

/**
 * One derived usage site of a declared format-v2 input: the exact place the
 * input lands at launch.
 *
 * Sites are realm-opaque: `agentLabel`/`targetLabel` are template-level labels
 * (`Name (key)` or `Realm-global workspace`), never launched agent ids or
 * canonical workspace keys, so the usage map is safe to render to agents.
 */
export interface RealmInputUsageSite {
  /** Where the input is consumed. */
  readonly kind: 'prompt' | 'history' | 'placement' | 'directive';
  /** Target template agent key (empty for a Realm-global placement). */
  readonly agentKey: string;
  /** Display label of the target agent (`''` for a Realm-global placement). */
  readonly agentLabel: string;
  /** Destination kind of the site. */
  readonly targetKind: 'realm' | 'agent';
  /** Display label of the destination. */
  readonly targetLabel: string;
  /** How the input is consumed at this site. */
  readonly selection: 'text' | 'path' | 'root' | 'message';
  /** Selection path (`path`/`root` selections) or empty. */
  readonly path: string;
  /** Short site title (`System prompt part 2`, `Placement → Realm-global workspace`). */
  readonly label: string;
  /** One-line detail (`selects "index.md"`, `writes /notes.md`, `delivers the text as a mailbox message`). */
  readonly detail: string;
}

/**
 * Derived usage map of one declared format-v2 input.
 */
export interface RealmInputUsage {
  /** Declared input id. */
  readonly inputId: string;
  /** Declared value domain. */
  readonly shape: 'text' | 'files';
  /** Whether the input fails composition while it resolves empty. */
  readonly required: boolean;
  /** Consumption sites in derivation order (prompts, history, placements, directives). */
  readonly sites: readonly RealmInputUsageSite[];
  /** One-line summary (`2 system prompt references · 1 placement`). */
  readonly summary: string;
}

/**
 * Builds the per-input usage map for one template: every declared input with
 * the exact sites it is consumed at, derived from the normalized model.
 *
 * Derivation order is stable — agent order, then prompt part order, then
 * history entry/part order, then declared placement order, then declared
 * directive order — and each site records the selection kind (`text` for a
 * whole-value injection, `path` for a one-file selection, `root` for a fileset
 * placement, `message` for a directive).
 *
 * @param template - Selected template (v1 templates convert through the shim).
 * @returns Input id → usage, restricted to the declared inputs (empty map for a malformed selection).
 *
 * @example
 * ```typescript
 * const usage = buildRealmInputUsageMap(template).get('handoff_notes');
 * usage.summary; // '1 placement'
 * ```
 */
export function buildRealmInputUsageMap(
  template: RealmTemplate | null | undefined
): ReadonlyMap<string, RealmInputUsage> {
  const model = asRealmTemplate(template);
  const map: Map<string, RealmInputUsage> = new Map();
  if (!model) return map;
  const agents = Array.isArray(model.agents) ? model.agents : [];
  const sitesByInput: Map<string, RealmInputUsageSite[]> = new Map();
  const push = (inputId: unknown, site: RealmInputUsageSite): void => {
    if (typeof inputId !== 'string' || inputId.length === 0) return;
    const sites = sitesByInput.get(inputId);
    if (sites) sites.push(site);
    else sitesByInput.set(inputId, [site]);
  };

  for (const spec of agents) {
    if (!spec || typeof spec !== 'object') continue;
    const agentLabel = agentKeyLabel(agents, spec.key);
    (Array.isArray(spec.prompt) ? spec.prompt : []).forEach((part, index) => {
      if (!part || part.kind !== 'input' || typeof part.inputId !== 'string') return;
      const selected = typeof part.path === 'string' && part.path.length > 0;
      push(part.inputId, {
        kind: 'prompt',
        agentKey: spec.key,
        agentLabel,
        targetKind: 'agent',
        targetLabel: agentLabel,
        selection: selected ? 'path' : 'text',
        path: selected ? part.path : '',
        label: `System prompt part ${index + 1}`,
        detail: selected ? `selects "${part.path}" from the fileset` : 'injects the text value'
      });
    });
    (Array.isArray(spec.history) ? spec.history : []).forEach((entry, entryIndex) => {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.content)) return;
      entry.content.forEach((part, partIndex) => {
        if (!part || part.kind !== 'input' || typeof part.inputId !== 'string') return;
        const selected = typeof part.path === 'string' && part.path.length > 0;
        push(part.inputId, {
          kind: 'history',
          agentKey: spec.key,
          agentLabel,
          targetKind: 'agent',
          targetLabel: agentLabel,
          selection: selected ? 'path' : 'text',
          path: selected ? part.path : '',
          label: `Baked history entry ${entryIndex + 1} part ${partIndex + 1}`,
          detail: selected ? `selects "${part.path}" from the fileset` : 'injects the text value'
        });
      });
    });
  }

  for (const placement of Array.isArray(model.placements) ? model.placements : []) {
    if (!placement || typeof placement !== 'object' || typeof placement.inputId !== 'string') continue;
    const targetKind: 'realm' | 'agent' = placement.target === 'realm' ? 'realm' : 'agent';
    const targetKey = targetKind === 'agent' && placement.target && typeof placement.target === 'object'
      ? placement.target.agent
      : '';
    const targetLabel = targetKind === 'agent' ? agentKeyLabel(agents, targetKey) : 'Realm-global workspace';
    const root = typeof placement.root === 'string' && placement.root.length > 0 ? placement.root : '';
    const path = typeof placement.path === 'string' && placement.path.length > 0 ? placement.path : '';
    push(placement.inputId, {
      kind: 'placement',
      agentKey: targetKey,
      agentLabel: targetKind === 'agent' ? targetLabel : '',
      targetKind,
      targetLabel,
      selection: root ? 'root' : 'path',
      path: root || path,
      label: root
        ? `Placement → ${targetLabel} under ${root.endsWith('/') ? root : `${root}/`}`
        : `Placement → ${targetLabel}`,
      detail: root
        ? 'writes every attached file under the root prefix'
        : 'writes the resolved value to the destination path'
    });
  }

  for (const directive of Array.isArray(model.directives) ? model.directives : []) {
    if (!directive || typeof directive !== 'object' || typeof directive.inputId !== 'string') continue;
    const targetKey = directive.target && typeof directive.target === 'object' ? directive.target.agent : '';
    const targetLabel = agentKeyLabel(agents, targetKey);
    push(directive.inputId, {
      kind: 'directive',
      agentKey: targetKey,
      agentLabel: targetLabel,
      targetKind: 'agent',
      targetLabel,
      selection: 'message',
      path: '',
      label: `Directive → ${targetLabel}`,
      detail: 'delivers the text as an operator-attributed mailbox message'
    });
  }

  for (const declaration of Array.isArray(model.inputs) ? model.inputs : []) {
    if (!declaration || typeof declaration !== 'object' || typeof declaration.id !== 'string') continue;
    const sites = sitesByInput.get(declaration.id) ?? [];
    map.set(declaration.id, {
      inputId: declaration.id,
      shape: declaration.shape === 'files' ? 'files' : 'text',
      required: declaration.required === true,
      sites,
      summary: describeRealmInputUsageSummary(sites)
    });
  }
  return map;
}

/**
 * Renders the one-line usage summary of a site list.
 *
 * @param sites - Derived usage sites.
 * @returns Summary text (`2 system prompt references · 1 placement`).
 */
function describeRealmInputUsageSummary(sites: readonly RealmInputUsageSite[]): string {
  if (sites.length === 0) return 'Declared but not referenced.';
  const counts = { prompt: 0, history: 0, placement: 0, directive: 0 };
  for (const site of sites) counts[site.kind] += 1;
  const parts: string[] = [];
  const plural = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? '' : 's'}`;
  if (counts.prompt > 0) parts.push(plural(counts.prompt, 'system prompt reference'));
  if (counts.history > 0) parts.push(plural(counts.history, 'baked history reference'));
  if (counts.placement > 0) parts.push(plural(counts.placement, 'placement'));
  if (counts.directive > 0) parts.push(plural(counts.directive, 'directive'));
  return parts.join(' · ');
}

/**
 * One attached file body of a `files`-shape input draft.
 *
 * `path` is fileset-relative and is the identity a `path` selection or `root`
 * join resolves against; `name` is the source file name for display only.
 */
export interface RealmInputAttachment {
  /** Fileset-relative path (safe; unique within the draft's fileset). */
  readonly path: string;
  /** File body (UTF-8 text; may be empty). */
  readonly content: string;
  /** Source file name for display (`''` when the row was typed). */
  readonly name: string;
}

/**
 * One `text`-shape input draft.
 */
export interface RealmTextInputDraft {
  /** Declared input id. */
  readonly id: string;
  /** Human-readable field label. */
  readonly label: string;
  /** Author help text; empty when absent. */
  readonly help: string;
  /** Production instruction for whoever fills the input; empty when absent. */
  readonly brief: string;
  /** Value domain discriminator. */
  readonly shape: 'text';
  /** Whether to render a multiline field (declared `multiline` default true). */
  readonly multiline: boolean;
  /** Whether composition fails closed while the value resolves empty. */
  readonly required: boolean;
  /** Current field text. */
  readonly value: string;
  /** Whether the operator edited the field (dirty fields travel explicitly). */
  readonly dirty: boolean;
  /** Reset target: the resolved template default (`''` when absent/unresolved). */
  readonly defaultValue: string;
  /** Whether the template default resolved (false for a missing `defaultFile` bundle entry). */
  readonly defaultResolved: boolean;
  /** Derived usage map of this input. */
  readonly usage: RealmInputUsage;
}

/**
 * One `files`-shape input draft: an ordered fileset the operator attaches.
 */
export interface RealmFilesInputDraft {
  /** Declared input id. */
  readonly id: string;
  /** Human-readable field label. */
  readonly label: string;
  /** Author help text; empty when absent. */
  readonly help: string;
  /** Production instruction for whoever fills the input; empty when absent. */
  readonly brief: string;
  /** Value domain discriminator. */
  readonly shape: 'files';
  /** Files inputs are never multiline text fields. */
  readonly multiline: false;
  /** Whether composition and placement fail closed while the fileset is empty. */
  readonly required: boolean;
  /** Attached files, in operator order (each carries its fileset-relative `path`). */
  readonly files: readonly RealmInputAttachment[];
  /** Whether the operator edited the fileset (dirty drafts travel explicitly). */
  readonly dirty: boolean;
  /** Derived usage map of this input. */
  readonly usage: RealmInputUsage;
}

/** One format-v2 input draft: a text field or a fileset attachment list. */
export type RealmInputDraft = RealmTextInputDraft | RealmFilesInputDraft;

/**
 * Builds the editable format-v2 input drafts for one template, in declared
 * order: `text` drafts prefilled from the declared `default`/`defaultFile`
 * (untouched), and `files` drafts starting with an empty fileset. Every draft
 * carries its derived usage map so the launcher can show where the input lands.
 *
 * Malformed declarations are skipped (the template preview owns structural
 * reporting) and a missing `defaultFile` prefill starts empty with
 * `defaultResolved: false` so the form can flag it.
 *
 * @param template - Selected template (v1 templates convert through the shim).
 * @param bundleFiles - Bundle file bodies for `defaultFile` prefills.
 * @returns Fresh drafts in declared order (empty for a malformed/absent selection).
 *
 * @example
 * ```typescript
 * buildRealmV2InputDrafts(template).map((draft) => draft.shape); // ['text', 'files']
 * ```
 */
export function buildRealmV2InputDrafts(
  template: RealmTemplate | null | undefined,
  bundleFiles?: Readonly<Record<string, string>> | null
): RealmInputDraft[] {
  const model = asRealmTemplate(template);
  if (!model) return [];
  const files = bundleFiles && typeof bundleFiles === 'object' ? bundleFiles : {};
  const usageMap = buildRealmInputUsageMap(model);
  const drafts: RealmInputDraft[] = [];
  for (const declaration of Array.isArray(model.inputs) ? model.inputs : []) {
    if (!declaration || typeof declaration !== 'object' || typeof declaration.id !== 'string' || declaration.id.length === 0) {
      continue;
    }
    const usage = usageMap.get(declaration.id) ?? {
      inputId: declaration.id,
      shape: declaration.shape === 'files' ? 'files' : 'text',
      required: declaration.required === true,
      sites: [],
      summary: 'Declared but not referenced.'
    };
    const label = typeof declaration.label === 'string' && declaration.label.length > 0 ? declaration.label : declaration.id;
    const help = typeof declaration.help === 'string' ? declaration.help : '';
    const brief = typeof declaration.brief === 'string' ? declaration.brief : '';
    const required = declaration.required === true;
    if (declaration.shape === 'files') {
      drafts.push({
        id: declaration.id,
        label,
        help,
        brief,
        shape: 'files',
        multiline: false,
        required,
        files: [],
        dirty: false,
        usage
      });
      continue;
    }
    const prefill = resolveInputPrefill(declaration, files);
    drafts.push({
      id: declaration.id,
      label,
      help,
      brief,
      shape: 'text',
      multiline: declaration.multiline !== false,
      required,
      value: prefill.value,
      dirty: false,
      defaultValue: prefill.value,
      defaultResolved: prefill.resolved,
      usage
    });
  }
  return drafts;
}

/**
 * Whether the reviewer may edit one format-v2 input draft.
 *
 * @param draft - Input draft.
 * @returns `true` for a well-formed draft (any shape).
 */
export function isRealmV2InputEditable(draft: RealmInputDraft | null | undefined): boolean {
  return Boolean(draft && typeof draft === 'object' && typeof draft.id === 'string' && draft.id.length > 0);
}

/**
 * Records one text edit on a format-v2 draft (dirty presence semantics).
 *
 * @param draft - Current draft.
 * @param value - New field text.
 * @returns A fresh draft (`dirty: true`); a files draft or malformed input returns unchanged.
 */
export function setRealmV2InputText(draft: RealmInputDraft | null | undefined, value: unknown): RealmInputDraft {
  if (!draft || typeof draft !== 'object' || draft.shape !== 'text') return draft as RealmInputDraft;
  return { ...draft, value: typeof value === 'string' ? value : '', dirty: true };
}

/**
 * Replaces the attached fileset of a format-v2 draft (dirty presence semantics).
 *
 * @param draft - Current draft.
 * @param files - New attachment list (malformed entries are skipped).
 * @returns A fresh draft (`dirty: true`); a text draft or malformed input returns unchanged.
 */
export function setRealmV2InputFiles(
  draft: RealmInputDraft | null | undefined,
  files: readonly unknown[] | null | undefined
): RealmInputDraft {
  if (!draft || typeof draft !== 'object' || draft.shape !== 'files') return draft as RealmInputDraft;
  const attachments: RealmInputAttachment[] = [];
  for (const entry of Array.isArray(files) ? files : []) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { readonly path?: unknown; readonly content?: unknown; readonly name?: unknown };
    if (typeof record.path !== 'string' || record.path.length === 0) continue;
    attachments.push({
      path: record.path,
      content: typeof record.content === 'string' ? record.content : '',
      name: typeof record.name === 'string' ? record.name : ''
    });
  }
  return { ...draft, files: attachments, dirty: true };
}

/**
 * Resets one format-v2 draft to its template declaration: a text draft is
 * prefilled from `default`/`defaultFile` again (untouched), a files draft
 * drops every attachment (untouched).
 *
 * @param draft - Current draft (returned unchanged when malformed).
 * @param declaration - The declaration behind the draft.
 * @param bundleFiles - Bundle file bodies for a `defaultFile` prefill.
 * @returns A fresh draft with `dirty: false`.
 */
export function resetRealmV2InputDraft(
  draft: RealmInputDraft | null | undefined,
  declaration: RealmTemplateInput | null | undefined,
  bundleFiles?: Readonly<Record<string, string>> | null
): RealmInputDraft {
  if (!draft || typeof draft !== 'object' || !declaration || typeof declaration !== 'object') {
    return draft as RealmInputDraft;
  }
  if (draft.shape === 'files') {
    return { ...draft, files: [], dirty: false };
  }
  const files = bundleFiles && typeof bundleFiles === 'object' ? bundleFiles : {};
  const prefill = resolveInputPrefill(declaration, files);
  return {
    ...draft,
    value: prefill.value,
    dirty: false,
    defaultValue: prefill.value,
    defaultResolved: prefill.resolved
  };
}

/**
 * Builds one attachment from a picked file: the file name becomes the default
 * fileset path (sanitized to a safe relative path) and the text becomes the
 * body.
 *
 * @param name - Source file name.
 * @param content - File body.
 * @returns The attachment (a safe fallback path when the name is unusable).
 */
export function buildRealmInputAttachment(name: unknown, content: unknown): RealmInputAttachment {
  const fileName = typeof name === 'string' ? name.trim() : '';
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return {
    path: sanitizeRealmAttachmentPath(base) || 'file.txt',
    content: typeof content === 'string' ? content : '',
    name: fileName
  };
}

/**
 * Sanitizes one fileset-relative attachment path (no leading slash, no `.`/`..`
 * segments, no null bytes).
 *
 * @param candidate - Raw path.
 * @returns Safe relative path, or `''` when unusable.
 */
export function sanitizeRealmAttachmentPath(candidate: unknown): string {
  const raw = typeof candidate === 'string' ? candidate.trim() : '';
  if (!raw || raw.includes('\0')) return '';
  const segments = raw.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return '';
  return segments.join('/');
}

/**
 * Resolves a unique fileset path for one attachment (suffixes `-2`, `-3`, …).
 *
 * @param existing - Paths already attached to the same fileset.
 * @param candidate - Candidate path (sanitized here).
 * @returns A path not present in `existing`.
 */
export function uniqueRealmAttachmentPath(existing: readonly string[], candidate: unknown): string {
  const base = sanitizeRealmAttachmentPath(candidate) || 'file.txt';
  const taken = new Set(Array.isArray(existing) ? existing : []);
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';
  let suffix = 2;
  while (taken.has(`${stem}-${suffix}${extension}`)) suffix += 1;
  return `${stem}-${suffix}${extension}`;
}

/**
 * Assembles the shape-tagged `inputs` payload from the drafts: only edited
 * fields are present, an untouched field stays omitted so the attached
 * payload's value (then the declared default) applies, and a dirty fileset
 * with no files is omitted because the payload format has no empty fileset
 * (an absent optional fileset writes nothing).
 *
 * @param drafts - Editable format-v2 input drafts.
 * @returns Fresh shape-tagged values (empty when nothing was edited).
 */
export function assembleRealmV2Inputs(
  drafts: readonly RealmInputDraft[] | null | undefined
): RealmInputValues {
  const values: Record<string, RealmInputValue> = {};
  if (!Array.isArray(drafts)) return values;
  for (const draft of drafts) {
    if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string' || draft.id.length === 0) continue;
    if (draft.dirty !== true) continue;
    if (draft.shape === 'text') {
      values[draft.id] = { shape: 'text', text: typeof draft.value === 'string' ? draft.value : '' };
      continue;
    }
    if (draft.files.length > 0) {
      values[draft.id] = { shape: 'files', files: draft.files.map((file) => ({ path: file.path, content: file.content })) };
    }
  }
  return values;
}

/**
 * Typed failure classes of the operator-assembled input validation, mirroring
 * the store's launch path.
 */
export type RealmV2InputFailureCode =
  | 'missing-required'
  | 'pin-mismatch'
  | 'unknown-input'
  | 'shape-mismatch'
  | 'invalid-payload'
  | 'invalid-template';

/**
 * One effective resolved input value of a format-v2 launch projection.
 */
export interface RealmV2ResolvedInput {
  /** Declared input id. */
  readonly id: string;
  /** Declared label. */
  readonly label: string;
  /** Declared value domain. */
  readonly shape: 'text' | 'files';
  /** Whether composition fails closed while the value resolves empty. */
  readonly required: boolean;
  /** Effective value (draft edit → attached payload → declared default → empty). */
  readonly value: RealmInputValue;
  /** Where the effective value came from. */
  readonly source: 'launch' | 'payload' | 'default' | 'defaultFile' | 'empty';
  /** Whether a `required` input resolves non-empty (always true when not required). */
  readonly complete: boolean;
}

/**
 * Result of validating the operator-assembled format-v2 inputs through the
 * catalog's own payload path (the store's launch validation).
 */
export interface RealmV2InputProjection {
  /** Whether the assembled values validate against the effective template. */
  readonly ok: boolean;
  /** Typed failure class (`''` when `ok`). */
  readonly code: '' | RealmV2InputFailureCode;
  /** User-facing failure text (`''` when `ok`). */
  readonly error: string;
  /** Per-field inline errors keyed by input id (empty when none). */
  readonly fieldErrors: Record<string, string>;
  /** Shape-tagged explicit values to send as the store's `inputs` option. */
  readonly launchInputs: RealmInputValues;
  /** Effective shape-tagged value per declared input (review display). */
  readonly effectiveInputs: RealmInputValues;
  /** Synthesized v2 envelope of the effective values (`null` when unbuildable). */
  readonly payload: Readonly<Record<string, unknown>> | null;
  /** Effective resolution per declared input, in declared order. */
  readonly resolved: readonly RealmV2ResolvedInput[];
}

/**
 * Options accepted by {@link validateRealmV2InputDrafts}.
 */
export interface RealmV2InputValidationOptions {
  /** Effective authored bundle version the launch pins (the payload envelope pin). */
  readonly currentVersion?: string | null;
  /** Explicit confirmation that a mismatching attached payload pin may pass. */
  readonly allowVersionMismatch?: boolean;
  /** Attached payload (v2 payload or legacy v1 hydration package). */
  readonly payload?: unknown;
  /** Bundle file bodies for `defaultFile` prefills. */
  readonly bundleFiles?: Readonly<Record<string, string>> | null;
}

/**
 * Validates the operator-assembled format-v2 inputs through the store's own
 * path: the effective values (draft edits → attached payload → declared
 * default → empty) are synthesized into the canonical format-v2 payload
 * envelope and validated by the real `validatePayload` against the effective
 * template and version, exactly as `launchRealmFromTemplate` does — so a
 * missing required input, a pinned-version mismatch, an unknown input, or a
 * shape mismatch fails closed here with the same typed class before any Realm
 * record exists.
 *
 * `launchInputs` is the minimal explicit `inputs` payload for the launch call:
 * edited fields travel, an untouched field stays omitted (an attached
 * payload's value, then the declared default, applies), and a required input
 * the attached payload does not provide is filled from its effective value so
 * the store's own synthesized-payload check cannot fail on a field the
 * operator never touched.
 *
 * Failure text is the catalog's own message (input ids and labels only) — no
 * canonical workspace key ever reaches this surface.
 *
 * @param template - Selected template (v1 templates convert through the shim).
 * @param drafts - Editable format-v2 input drafts.
 * @param options - Effective version, mismatch confirmation, attached payload, bundle files.
 * @returns The projection; failures are inline, never thrown.
 *
 * @example
 * ```typescript
 * const projection = validateRealmV2InputDrafts(template, drafts, { currentVersion: 'sha256:…' });
 * projection.code; // 'missing-required' while a required field is empty
 * ```
 */
export function validateRealmV2InputDrafts(
  template: RealmTemplate | null | undefined,
  drafts: readonly RealmInputDraft[] | null | undefined,
  options: RealmV2InputValidationOptions = {}
): RealmV2InputProjection {
  const failure = (
    code: RealmV2InputFailureCode,
    error: string,
    extra: {
      readonly fieldErrors?: Record<string, string>;
      readonly launchInputs?: RealmInputValues;
      readonly effectiveInputs?: RealmInputValues;
      readonly resolved?: readonly RealmV2ResolvedInput[];
    } = {}
  ): RealmV2InputProjection => ({
    ok: false,
    code,
    error,
    fieldErrors: extra.fieldErrors ?? {},
    launchInputs: extra.launchInputs ?? {},
    effectiveInputs: extra.effectiveInputs ?? {},
    payload: null,
    resolved: extra.resolved ?? []
  });

  if (!template || typeof template !== 'object') {
    return failure('invalid-template', 'Select a template before launching.');
  }
  let model: RealmTemplate;
  try {
    model = normalizeTemplate(template);
  } catch (error) {
    return failure('invalid-template', messageOf(error) || 'The selected template could not be validated.');
  }

  const bundleFiles: Readonly<Record<string, string>> = options.bundleFiles && typeof options.bundleFiles === 'object'
    ? options.bundleFiles
    : {};
  const currentVersion = typeof options.currentVersion === 'string' && options.currentVersion.length > 0
    ? options.currentVersion
    : null;
  const allowVersionMismatch = options.allowVersionMismatch === true;

  // The attached payload is the base value set and its pin is the envelope
  // pin, exactly like the store launch; a typed failure (mismatch, unknown
  // input, shape) returns before any value is assembled.
  let payloadValues: RealmInputValues = {};
  let payloadPin: string | null = null;
  if (options.payload !== undefined && options.payload !== null) {
    try {
      const resolvedPayload = validatePayload(model, options.payload, {
        ...(currentVersion !== null ? { currentVersion } : {}),
        ...(allowVersionMismatch ? { allowVersionMismatch: true } : {})
      });
      payloadValues = resolvedPayload.inputs;
      payloadPin = resolvedPayload.templateVersion;
    } catch (error) {
      const classified = classifyRealmV2InputFailure(error);
      return failure(classified.code, classified.error, { fieldErrors: classified.fieldErrors });
    }
  }

  const draftList = Array.isArray(drafts) ? drafts : [];
  const draftsById: ReadonlyMap<string, RealmInputDraft> = new Map(
    draftList
      .filter((draft): draft is RealmInputDraft => Boolean(draft) && typeof draft.id === 'string' && draft.id.length > 0)
      .map((draft) => [draft.id, draft] as const)
  );

  const resolvedInputs: RealmV2ResolvedInput[] = [];
  const effective: Record<string, RealmInputValue> = {};
  const launch: Record<string, RealmInputValue> = {};
  const missingDefaultFiles: Array<{ id: string; label: string }> = [];

  for (const declaration of Array.isArray(model.inputs) ? model.inputs : []) {
    if (!declaration || typeof declaration !== 'object' || typeof declaration.id !== 'string') continue;
    const draft = draftsById.get(declaration.id) ?? null;
    const payloadProvided = Object.prototype.hasOwnProperty.call(payloadValues, declaration.id);
    const explicit = draft && draft.dirty === true ? explicitDraftValue(draft) : null;

    let value: RealmInputValue;
    let source: RealmV2ResolvedInput['source'];
    if (explicit !== null) {
      value = explicit;
      source = 'launch';
    } else if (payloadProvided) {
      value = payloadValues[declaration.id];
      source = 'payload';
    } else if (declaration.shape === 'text' && typeof declaration.default === 'string') {
      value = { shape: 'text', text: declaration.default };
      source = 'default';
    } else if (declaration.shape === 'text' && typeof declaration.defaultFile === 'string') {
      if (Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
        value = { shape: 'text', text: bundleFiles[declaration.defaultFile] };
        source = 'defaultFile';
      } else {
        value = { shape: 'text', text: '' };
        source = 'defaultFile';
        missingDefaultFiles.push({ id: declaration.id, label: declaration.label });
      }
    } else {
      value = declaration.shape === 'files' ? { shape: 'files', files: [] } : { shape: 'text', text: '' };
      source = 'empty';
    }

    const complete = declaration.required !== true
      ? true
      : value.shape === 'text'
        ? value.text.trim().length > 0
        : value.files.length > 0;
    resolvedInputs.push({
      id: declaration.id,
      label: declaration.label,
      shape: declaration.shape === 'files' ? 'files' : 'text',
      required: declaration.required === true,
      value,
      source,
      complete
    });
    effective[declaration.id] = value;

    if (draft && draft.dirty === true) {
      if (draft.shape === 'text') {
        launch[declaration.id] = { shape: 'text', text: draft.value };
      } else if (draft.files.length > 0) {
        launch[declaration.id] = {
          shape: 'files',
          files: draft.files.map((file) => ({ path: file.path, content: file.content }))
        };
      }
      continue;
    }
    if (declaration.required === true && !payloadProvided && complete) {
      // A required input the attached payload does not provide must travel
      // explicitly so the store's synthesized-payload check sees it.
      launch[declaration.id] = value;
    }
  }

  if (missingDefaultFiles.length > 0) {
    const first = missingDefaultFiles[0];
    const fieldErrors: Record<string, string> = {};
    for (const entry of missingDefaultFiles) {
      fieldErrors[entry.id] = `The template default file for "${entry.label}" is not in the launch bundle — fill the field or fix the bundle.`;
    }
    return failure('invalid-payload', fieldErrors[first.id], {
      fieldErrors,
      launchInputs: launch,
      effectiveInputs: effective,
      resolved: resolvedInputs
    });
  }

  const pin = payloadPin ?? currentVersion;
  if (pin === null) {
    return failure(
      'pin-mismatch',
      'The template bundle has no resolvable content version — the launch would fail closed.',
      { launchInputs: launch, effectiveInputs: effective, resolved: resolvedInputs }
    );
  }

  const authored: Record<string, RealmPayloadInputValue> = {};
  for (const id of Object.keys(payloadValues)) authored[id] = toAuthoredPayloadValue(payloadValues[id]);
  for (const id of Object.keys(launch)) authored[id] = toAuthoredPayloadValue(launch[id]);
  const envelope = { formatVersion: 2, templateId: model.id, templateVersion: pin, inputs: authored };
  try {
    validatePayload(model, envelope, {
      ...(currentVersion !== null ? { currentVersion } : {}),
      ...(allowVersionMismatch ? { allowVersionMismatch: true } : {})
    });
  } catch (error) {
    const classified = classifyRealmV2InputFailure(error);
    const fieldErrors = { ...classified.fieldErrors };
    if (classified.code === 'missing-required') {
      // The catalog fails fast on the first required input; the launcher marks
      // every empty required field so the operator fixes them all in one pass.
      for (const entry of resolvedInputs) {
        if (entry.required !== true || entry.complete === true) continue;
        if (Object.prototype.hasOwnProperty.call(fieldErrors, entry.id)) continue;
        fieldErrors[entry.id] = `"${entry.label}" is required — provide a value or reset to the template default.`;
      }
    }
    return failure(classified.code, classified.error, {
      fieldErrors,
      launchInputs: launch,
      effectiveInputs: effective,
      resolved: resolvedInputs
    });
  }

  return {
    ok: true,
    code: '',
    error: '',
    fieldErrors: {},
    launchInputs: launch,
    effectiveInputs: effective,
    payload: envelope,
    resolved: resolvedInputs
  };
}

/**
 * Resolves one draft's explicit shape-tagged value (`null` when a files draft
 * holds no files — the payload format has no empty fileset, so the value is
 * treated as absent).
 *
 * @param draft - Dirty draft.
 * @returns The explicit value, or `null` when it cannot be expressed.
 */
function explicitDraftValue(draft: RealmInputDraft): RealmInputValue | null {
  if (draft.shape === 'text') {
    return { shape: 'text', text: typeof draft.value === 'string' ? draft.value : '' };
  }
  if (draft.files.length === 0) return null;
  return {
    shape: 'files',
    files: draft.files.map((file) => ({ path: file.path, content: file.content }))
  };
}

/**
 * Converts a validated shape-tagged value into the authored payload form.
 *
 * @param value - Validated shape-tagged value.
 * @returns Authored `{ text }` / `{ files }` value.
 */
function toAuthoredPayloadValue(value: RealmInputValue): RealmPayloadInputValue {
  return value.shape === 'text'
    ? { text: value.text }
    : { files: value.files.map((file) => ({ path: file.path, content: file.content })) };
}

/**
 * Classifies one catalog failure into the launcher's typed classes and maps
 * the message's input id onto a per-field error.
 *
 * @param error - Thrown catalog error.
 * @returns Typed class, message, and per-field errors.
 */
function classifyRealmV2InputFailure(error: unknown): {
  readonly code: RealmV2InputFailureCode;
  readonly error: string;
  readonly fieldErrors: Record<string, string>;
} {
  const message = messageOf(error) || 'The launch inputs are not valid for this template.';
  if (shapeOf(error).code === REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_VERSION_MISMATCH) {
    return { code: 'pin-mismatch', error: message, fieldErrors: {} };
  }
  const inputId = extractRealmV2InputId(message);
  const fieldErrors = inputId.length > 0 ? { [inputId]: message } : {};
  if (/undeclared input|unknown input/i.test(message)) {
    return { code: 'unknown-input', error: message, fieldErrors };
  }
  if (/must be \{ shape|unknown field '(?:text|files)'|text must be a string|files must be a non-empty array|-shape/.test(message)) {
    return { code: 'shape-mismatch', error: message, fieldErrors };
  }
  if (/required/i.test(message)) {
    return { code: 'missing-required', error: message, fieldErrors };
  }
  return { code: 'invalid-payload', error: message, fieldErrors };
}

/**
 * Extracts the input id referenced by a catalog validation message.
 *
 * @param message - Catalog failure text.
 * @returns The input id, or `''` when the message names none.
 */
function extractRealmV2InputId(message: string): string {
  const bracketed = /inputs\[['"]([^'"]+)['"]\]/.exec(message);
  if (bracketed) return bracketed[1];
  const named = /input\s+['"]([^'"]+)['"]/.exec(message);
  return named ? named[1] : '';
}

/**
 * One structural issue of the operator's fileset attachments.
 */
export interface RealmInputAttachmentIssue {
  /** Declared input id. */
  readonly inputId: string;
  /** Issue class. */
  readonly code: 'path-placement-count' | 'selection-missing' | 'duplicate-path' | 'unsafe-path' | 'required-empty';
  /** Offending fileset path (empty for fileset-level issues). */
  readonly path: string;
  /** User-facing failure text. */
  readonly error: string;
}

/**
 * Result of validating the operator's fileset attachments against the
 * template's declared consumption sites.
 */
export interface RealmInputAttachmentValidation {
  /** Whether every attachment satisfies its declared sites. */
  readonly ok: boolean;
  /** Structural issues in declaration order (empty when valid). */
  readonly issues: readonly RealmInputAttachmentIssue[];
  /** Per-input inline errors (first issue per input). */
  readonly fieldErrors: Record<string, string>;
}

/**
 * Options accepted by {@link validateRealmInputAttachments}.
 */
export interface RealmInputAttachmentValidationOptions {
  /**
   * Effective shape-tagged input values (the value projection's
   * `effectiveInputs`): the attached payload's values plus the operator's
   * explicit edits. A `files` entry whose fileset resolves here satisfies the
   * composition checks even while the operator draft is empty, so the
   * attachment gate can never disagree with the value gate
   * (`validateRealmV2InputDrafts`) about a payload-supplied fileset
   * (ticket 0ea4c2b). Absent/partial values fall back to the draft files.
   */
  readonly inputs?: RealmInputValues | null;
}

/**
 * Resolves the fileset one files draft validates against: the effective
 * value's fileset when the projection carries one (a payload-provided value or
 * an explicit operator edit), else the draft's own attachments.
 *
 * @param draft - Files-shape input draft.
 * @param effectiveInputs - Effective shape-tagged values, or `null` when the caller passed none.
 * @returns The fileset to validate (never null; empty when neither source supplies one).
 */
function resolveAttachmentFiles(
  draft: RealmFilesInputDraft,
  effectiveInputs: RealmInputValues | null
): readonly RealmInputAttachment[] {
  const effective = effectiveInputs ? effectiveInputs[draft.id] : undefined;
  if (effective && effective.shape === 'files' && Array.isArray(effective.files)) {
    return effective.files.map((file) => ({ path: file.path, content: file.content, name: '' }));
  }
  return draft.files;
}

/**
 * Validates the attached filesets against the template's declared consumption
 * sites — the checks `validatePayload` cannot make because they depend on
 * composition:
 *
 * - every attached file has a safe, unique fileset path;
 * - a `path` placement writes exactly one file (attach one, or none — an
 *   absent optional fileset writes nothing), while `root` placements accept
 *   any count;
 * - a prompt/history `path` selection names an attached file whenever the
 *   fileset is non-empty;
 * - a `required` files input resolves a non-empty fileset with text content.
 *
 * Checks run against the **effective** fileset per input (payload-provided
 * values included) when the caller passes `options.inputs`, and against the
 * operator drafts alone otherwise — the pre-ticket behavior — so the gate
 * never blocks a launch whose required files input is supplied by the attached
 * payload (ticket 0ea4c2b).
 *
 * @param template - Selected template (v1 templates convert through the shim).
 * @param drafts - Editable format-v2 input drafts.
 * @param options - Effective shape-tagged values (`effectiveInputs`) the checks resolve against.
 * @returns The validation; issues are inline, never thrown.
 *
 * @example
 * ```typescript
 * validateRealmInputAttachments(template, drafts, { inputs: projection.effectiveInputs }).ok;
 * ```
 */
export function validateRealmInputAttachments(
  template: RealmTemplate | null | undefined,
  drafts: readonly RealmInputDraft[] | null | undefined,
  options: RealmInputAttachmentValidationOptions = {}
): RealmInputAttachmentValidation {
  const model = asRealmTemplate(template);
  const issues: RealmInputAttachmentIssue[] = [];
  if (!model || !Array.isArray(drafts)) return { ok: true, issues, fieldErrors: {} };
  const effectiveInputs: RealmInputValues | null = options && typeof options === 'object'
    && options.inputs && typeof options.inputs === 'object'
    ? options.inputs
    : null;
  const draftList = drafts.filter((draft): draft is RealmFilesInputDraft => (
    Boolean(draft) && draft.shape === 'files' && typeof draft.id === 'string'
  ));
  if (draftList.length === 0) return { ok: true, issues, fieldErrors: {} };

  const placementsByInput: ReadonlyMap<string, readonly RealmPlacement[]> = new Map(
    (Array.isArray(model.placements) ? model.placements : [])
      .filter((placement): placement is RealmPlacement & { inputId: string } => (
        Boolean(placement) && typeof placement.inputId === 'string'
      ))
      .reduce((accumulator, placement) => {
        const entries = accumulator.get(placement.inputId) ?? [];
        entries.push(placement);
        accumulator.set(placement.inputId, entries);
        return accumulator;
      }, new Map<string, RealmPlacement[]>())
  );
  const selectionsByInput: Map<string, readonly string[]> = new Map();
  for (const spec of Array.isArray(model.agents) ? model.agents : []) {
    if (!spec || typeof spec !== 'object') continue;
    const parts: Array<{ readonly inputId?: unknown; readonly path?: unknown }> = [];
    for (const part of Array.isArray(spec.prompt) ? spec.prompt : []) {
      if (part && part.kind === 'input') parts.push(part);
    }
    for (const entry of Array.isArray(spec.history) ? spec.history : []) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.content)) continue;
      for (const part of entry.content) {
        if (part && part.kind === 'input') parts.push(part);
      }
    }
    for (const part of parts) {
      if (typeof part.inputId !== 'string' || typeof part.path !== 'string' || part.path.length === 0) continue;
      const existing = selectionsByInput.get(part.inputId) ?? [];
      if (!existing.includes(part.path)) selectionsByInput.set(part.inputId, [...existing, part.path]);
    }
  }

  for (const draft of draftList) {
    const label = draft.label.length > 0 ? draft.label : draft.id;
    const files = resolveAttachmentFiles(draft, effectiveInputs);
    const seen: Set<string> = new Set();
    for (const file of files) {
      const safe = sanitizeRealmAttachmentPath(file.path);
      if (safe.length === 0 || safe !== file.path) {
        issues.push({
          inputId: draft.id,
          code: 'unsafe-path',
          path: file.path,
          error: `"${label}": the attached path "${file.path}" must be a safe fileset-relative path.`
        });
        continue;
      }
      if (seen.has(safe)) {
        issues.push({
          inputId: draft.id,
          code: 'duplicate-path',
          path: safe,
          error: `"${label}": the attached path "${safe}" duplicates an earlier file.`
        });
      }
      seen.add(safe);
    }

    for (const placement of placementsByInput.get(draft.id) ?? []) {
      const isPathDestination = typeof placement.path === 'string' && placement.path.length > 0;
      if (isPathDestination && files.length > 1) {
        issues.push({
          inputId: draft.id,
          code: 'path-placement-count',
          path: placement.path as string,
          error: `"${label}" writes exactly one file to "${placement.path}", but the fileset holds ${files.length} files — attach one file or leave the fileset empty.`
        });
      }
    }

    for (const selection of selectionsByInput.get(draft.id) ?? []) {
      if (files.length > 0 && !files.some((file) => file.path === selection)) {
        issues.push({
          inputId: draft.id,
          code: 'selection-missing',
          path: selection,
          error: `"${label}" references the file "${selection}", which is not attached — attach it or clear the selection.`
        });
      }
    }

    if (draft.required === true) {
      if (files.length === 0) {
        issues.push({
          inputId: draft.id,
          code: 'required-empty',
          path: '',
          error: `"${label}" is required — attach at least one file.`
        });
      } else if (files.every((file) => file.content.trim().length === 0)) {
        issues.push({
          inputId: draft.id,
          code: 'required-empty',
          path: '',
          error: `"${label}" is required — the attached files are empty.`
        });
      }
    }
  }

  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    if (!Object.prototype.hasOwnProperty.call(fieldErrors, issue.inputId)) fieldErrors[issue.inputId] = issue.error;
  }
  return { ok: issues.length === 0, issues, fieldErrors };
}

/**
 * Display model for one agent's model-preset binding.
 *
 * `isDefault` reports whether the effective binding is the catalog's active
 * default preset; `known` is false when a declared preset id is absent from
 * the catalog (the store rejects such a launch, so the preview flags it).
 */
export interface RealmPresetBindingView {
  /** Effective preset id, or `null` when no preset is available. */
  readonly id: string | null;
  /** Display label (catalog name when known). */
  readonly label: string;
  /** Whether the effective binding is the catalog's active default preset. */
  readonly isDefault: boolean;
  /** Whether the effective preset id names a catalog entry. */
  readonly known: boolean;
}

/**
 * Resolves the preset-binding display model for one agent spec.
 *
 * @param presetId - The spec's declared `modelPresetId`, if any.
 * @param presets - Catalog entries (`{ id, name }`; extra fields ignored).
 * @param defaultPresetId - The catalog's active default preset id, if any.
 * @returns Binding view; a declared-but-unknown id is labeled explicitly.
 *
 * @example
 * ```typescript
 * describeRealmPresetBinding(undefined, [{ id: 'preset_a', name: 'Preset A' }], 'preset_a');
 * // => { id: 'preset_a', label: 'Preset A', isDefault: true, known: true }
 * ```
 */
export function describeRealmPresetBinding(
  presetId: string | null | undefined,
  presets: ReadonlyArray<{ readonly id: string; readonly name?: string | null }>,
  defaultPresetId: string | null
): RealmPresetBindingView {
  const list = Array.isArray(presets) ? presets : [];
  const requested = typeof presetId === 'string' ? presetId.trim() : '';
  if (requested) {
    const preset = findPreset(list, requested);
    if (preset) {
      return {
        id: preset.id,
        label: presetLabel(preset),
        isDefault: preset.id === defaultPresetId,
        known: true
      };
    }
    return { id: requested, label: `${requested} (not in catalog)`, isDefault: false, known: false };
  }
  const fallback = typeof defaultPresetId === 'string' && defaultPresetId
    ? findPreset(list, defaultPresetId)
    : null;
  if (fallback) {
    return { id: fallback.id, label: presetLabel(fallback), isDefault: true, known: true };
  }
  return { id: null, label: 'No preset available', isDefault: false, known: false };
}

/**
 * One seed-target option: the Realm-global workspace or a launched member.
 */
export interface RealmSeedTargetOption {
  /** `<select>` value: empty string for the Realm-global workspace, else the member id. */
  readonly value: string;
  /** Display label. */
  readonly label: string;
}

/**
 * Builds the seed target picker options: the Realm-global workspace first,
 * then every launched member in launch order.
 *
 * @param members - Launched member identities (`{ id, name }`; extra fields ignored).
 * @param realmName - Launched Realm display name, if known.
 * @returns Target options; malformed member entries are skipped.
 *
 * @example
 * ```typescript
 * buildSeedTargetOptions([{ id: 'r1-worker', name: 'Worker' }], 'My Realm');
 * // => [
 * //   { value: '', label: 'Realm-global workspace (My Realm)' },
 * //   { value: 'r1-worker', label: 'Worker (r1-worker)' }
 * // ]
 * ```
 */
export function buildSeedTargetOptions(
  members: ReadonlyArray<{ readonly id: string; readonly name?: string | null }>,
  realmName?: string | null
): RealmSeedTargetOption[] {
  const name = typeof realmName === 'string' && realmName.trim() ? realmName.trim() : '';
  const options: RealmSeedTargetOption[] = [
    { value: '', label: name ? `Realm-global workspace (${name})` : 'Realm-global workspace (default)' }
  ];
  if (!Array.isArray(members)) return options;
  for (const member of members) {
    if (!member || typeof member.id !== 'string' || member.id.trim().length === 0) continue;
    const id = member.id.trim();
    const memberName = typeof member.name === 'string' && member.name.trim() ? member.name.trim() : id;
    options.push({ value: id, label: `${memberName} (${id})` });
  }
  return options;
}

/**
 * Compact display model of a template-declared seed.
 *
 * `targetLabels` lists the distinct destinations in declared order
 * (Realm-global workspace first-seen, then member display names); the
 * directive preview is trimmed text with a length cap for the summary line.
 */
export interface RealmSeedSummary {
  /** Whether the selected template declares placements or directives. */
  readonly declaresSeed: boolean;
  /** Number of declared placements (each may write a whole fileset). */
  readonly fileCount: number;
  /** Distinct target labels, in first-appearance order. */
  readonly targetLabels: readonly string[];
  /** Directive summary (target label + text preview), or `null` when absent. */
  readonly directive: {
    readonly targetAgentKey: string;
    readonly targetLabel: string;
    readonly preview: string;
  } | null;
  /** Number of declared placements (each may write a whole fileset). */
  readonly placementCount?: number;
  /** Number of declared directives. */
  readonly directiveCount?: number;
}

/**
 * Builds the compact seed summary shown with the launcher's seed toggle.
 *
 * Placements are counted in declared order with their target labels, and the
 * first directive is previewed (a literal directive shows its text, an
 * input-backed directive shows the input label). Legacy format-v1 documents
 * convert through the read shim first, so their converted placements and
 * directives render natively.
 *
 * The summary never resolves bundle-file content (counting and targeting are
 * enough); a missing bundle entry still fails the launch closed.
 *
 * @param template - Selected template, or `null`/`undefined` when none is selected.
 * @returns Seed summary; `declaresSeed: false` for a seed-less selection.
 *
 * @example
 * ```typescript
 * buildRealmSeedSummary(DEMO_TEMPLATE).declaresSeed; // false
 * ```
 */
export function buildRealmSeedSummary(template: RealmTemplate | null | undefined): RealmSeedSummary {
  const model = asRealmTemplate(template);
  if (!model) {
    return { declaresSeed: false, fileCount: 0, targetLabels: [], directive: null };
  }
  const placements = Array.isArray(model.placements) ? model.placements : [];
  const directives = Array.isArray(model.directives) ? model.directives : [];
  if (placements.length === 0 && directives.length === 0) {
    return { declaresSeed: false, fileCount: 0, targetLabels: [], directive: null };
  }
  const agents = Array.isArray(model.agents) ? model.agents : [];
  const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    (Array.isArray(model.inputs) ? model.inputs : [])
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );
  const targetLabels: string[] = [];
  for (const placement of placements) {
    if (!placement || typeof placement !== 'object') continue;
    const label = realmPlacementTargetLabel(placement, agents);
    if (!targetLabels.includes(label)) targetLabels.push(label);
  }
  let directive: RealmSeedSummary['directive'] = null;
  const firstDirective = directives.find((entry) => entry && typeof entry === 'object') ?? null;
  if (firstDirective) {
    const targetAgentKey = firstDirective.target && typeof firstDirective.target === 'object'
      ? firstDirective.target.agent
      : '';
    const inputDeclaration = typeof firstDirective.inputId === 'string'
      ? declarationsById.get(firstDirective.inputId) ?? null
      : null;
    const text = typeof firstDirective.text === 'string'
      ? firstDirective.text.trim()
      : inputDeclaration
        ? `input "${inputDeclaration.label.length > 0 ? inputDeclaration.label : inputDeclaration.id}"`
        : '';
    directive = {
      targetAgentKey,
      targetLabel: agentKeyLabel(agents, targetAgentKey),
      preview: text.length > 120 ? `${text.slice(0, 120).trimEnd()}…` : text
    };
  }
  return {
    declaresSeed: true,
    fileCount: placements.length,
    targetLabels,
    directive,
    placementCount: placements.length,
    directiveCount: directives.length
  };
}

/**
 * Display label of one placement's destination target (realm-opaque).
 *
 * @param placement - Declared placement.
 * @param agents - Declared agent specs.
 * @returns `Realm-global workspace` or the agent label.
 */
function realmPlacementTargetLabel(
  placement: RealmPlacement,
  agents: readonly RealmAgentSpec[]
): string {
  if (placement.target === 'realm') return 'Realm-global workspace';
  const key = placement.target && typeof placement.target === 'object' ? placement.target.agent : '';
  return agentKeyLabel(agents, typeof key === 'string' ? key : '');
}

/**
 * One read-only seed file slot rendered by the launcher review: destination
 * path, resolved target, declared origin, and origin-dependent source label.
 */
export interface RealmSeedSlotView {
  /** Declared destination path (workspace-relative). */
  readonly path: string;
  /** Destination kind: the Realm-global workspace or one member's private workspace. */
  readonly targetKind: 'realm' | 'agent';
  /** Target template agent key (`''` for the Realm-global workspace). */
  readonly targetKey: string;
  /** Display label of the target (`Realm-global workspace` or `Name (key)`). */
  readonly targetLabel: string;
  /** Declared content origin (`fixed` default, `user`, or `generated`). */
  readonly origin: 'fixed' | 'user' | 'generated';
  /** Hydration instruction (empty when absent). */
  readonly brief: string;
  /** Where the content comes from at launch (`inline bundle content`, `bundle file <path>`, `attached at launch`, `filled from the hydration package`). */
  readonly sourceLabel: string;
}

/**
 * Builds the read-only seed file slot list for one template.
 *
 * Placements render natively: a `file` placement resolves from the bundle, an
 * input placement shows its destination and the input's requiredness (a `root`
 * placement is labeled as writing every attached file under the prefix).
 * Legacy format-v1 documents convert through the read shim first, so their
 * converted placements render natively. Slots render in declared order with
 * their destination and origin so the reviewer can see exactly what the launch
 * will write and where each slot's content comes from. Malformed declarations
 * are skipped (structural reporting belongs to the template preview).
 *
 * @param template - Selected template, or `null`/`undefined` when none is selected.
 * @returns Slot views in declared order (empty when no seed is declared).
 *
 * @example
 * ```typescript
 * buildRealmSeedSlotViews(DEMO_TEMPLATE); // []
 * ```
 */
export function buildRealmSeedSlotViews(template: RealmTemplate | null | undefined): RealmSeedSlotView[] {
  const model = asRealmTemplate(template);
  if (!model) return [];
  const placements = Array.isArray(model.placements) ? model.placements : [];
  if (placements.length === 0) return [];
  const agents = Array.isArray(model.agents) ? model.agents : [];
  const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    (Array.isArray(model.inputs) ? model.inputs : [])
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );
  const views: RealmSeedSlotView[] = [];
  for (const placement of placements) {
    if (!placement || typeof placement !== 'object') continue;
    const targetKind: 'realm' | 'agent' = placement.target === 'realm' ? 'realm' : 'agent';
    const targetKey = targetKind === 'agent' && placement.target && typeof placement.target === 'object'
      ? placement.target.agent
      : '';
    const targetLabel = targetKind === 'agent'
      ? agentKeyLabel(agents, typeof targetKey === 'string' ? targetKey : '')
      : 'Realm-global workspace';
    const path = typeof placement.path === 'string' ? placement.path : '';
    const root = typeof placement.root === 'string' ? placement.root : '';
    if (typeof placement.file === 'string' && placement.file.length > 0) {
      if (path.length === 0) continue;
      views.push({
        path,
        targetKind,
        targetKey: typeof targetKey === 'string' ? targetKey : '',
        targetLabel,
        origin: 'fixed',
        brief: '',
        sourceLabel: `bundle file ${placement.file}`
      });
      continue;
    }
    if (typeof placement.inputId !== 'string' || placement.inputId.length === 0) continue;
    const declaration = declarationsById.get(placement.inputId) ?? null;
    if (!declaration) {
      views.push({
        path: path || root || placement.inputId,
        targetKind,
        targetKey: typeof targetKey === 'string' ? targetKey : '',
        targetLabel,
        origin: 'user',
        brief: '',
        sourceLabel: `undeclared input "${placement.inputId}"`
      });
      continue;
    }
    const origin = v2InputDisplayOrigin(declaration);
    const label = declaration.label.length > 0 ? declaration.label : declaration.id;
    let sourceLabel: string;
    if (declaration.shape === 'files') {
      sourceLabel = root.length > 0
        ? `input "${label}" — every attached file under ${root.endsWith('/') ? root : `${root}/`}`
        : `input "${label}" — exactly one attached file`;
    } else if (typeof declaration.default === 'string') {
      sourceLabel = `input "${label}" — inline template default`;
    } else if (typeof declaration.defaultFile === 'string') {
      sourceLabel = `input "${label}" — default file ${declaration.defaultFile}`;
    } else {
      sourceLabel = `input "${label}"`;
    }
    views.push({
      path: path || (root.length > 0 ? (root.endsWith('/') ? root : `${root}/`) : ''),
      targetKind,
      targetKey: typeof targetKey === 'string' ? targetKey : '',
      targetLabel,
      origin,
      brief: typeof declaration.brief === 'string' ? declaration.brief : '',
      sourceLabel
    });
  }
  return views;
}

/**
 * Coarse display origin of one v2 input declaration (v1-comparable labels).
 *
 * @param declaration - Declared format-v2 input.
 * @returns `generated` for a required input, `fixed` for a text input with a prefill, else `user`.
 */
function v2InputDisplayOrigin(declaration: RealmTemplateInput): 'fixed' | 'user' | 'generated' {
  if (declaration.required === true) return 'generated';
  if (declaration.shape === 'text' && (typeof declaration.default === 'string' || typeof declaration.defaultFile === 'string')) {
    return 'fixed';
  }
  return 'user';
}

/**
 * One parsed seed file: normalized virtual path plus verbatim content.
 */
export interface RealmSeedFileRow {
  /** Normalized absolute virtual path (workspace-relative input is accepted). */
  readonly path: string;
  /** File content, preserved verbatim. */
  readonly content: string;
}

/**
 * Result of parsing the editable seed file rows.
 */
export type SeedRowsResult =
  | { readonly ok: true; readonly files: RealmSeedFileRow[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parses and validates the editable seed file rows into the store's file list.
 *
 * Row-level rules mirror the store's fail-closed seed validation: a path is
 * required, null bytes and `..` segments are rejected, the workspace root is
 * not a file, paths addressing the reserved `global`/`public` workspace roots
 * are rejected (the legacy VirtualFS prefix routing would otherwise divert
 * the write into the ungrouped shared workspace while the selected one was
 * reported), duplicate normalized paths are rejected, and content must be
 * text (empty text is a valid empty file). Row order is preserved and every
 * accepted path is normalized through the canonical VirtualFS normalizer, so
 * the helper and the store agree on path identity.
 *
 * @param rows - Raw row list (`{ path, content }` entries; unknown input rejected).
 * @returns Parsed files, or the first row-level error.
 *
 * @example
 * ```typescript
 * parseSeedFileRows([{ path: 'notes/brief.md', content: 'hi' }]);
 * // => { ok: true, files: [{ path: '/notes/brief.md', content: 'hi' }] }
 * ```
 */
export function parseSeedFileRows(rows: unknown): SeedRowsResult {
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'File rows must be a list.' };
  }
  const files: RealmSeedFileRow[] = [];
  const seen: Set<string> = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const label = `Row ${index + 1}`;
    const row = rows[index] as Record<string, unknown> | null;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `${label}: each file row needs a path and content.` };
    }
    const rawPath = typeof row.path === 'string' ? row.path.trim() : '';
    if (!rawPath) {
      return { ok: false, error: `${label}: a file path is required.` };
    }
    if (rawPath.includes('\0')) {
      return { ok: false, error: `${label}: the path must not contain null bytes.` };
    }
    if (rawPath.replace(/\\/g, '/').split('/').includes('..')) {
      return { ok: false, error: `${label}: "${rawPath}" must not contain ".." path segments.` };
    }
    const normalized = normalizeVirtualPath(rawPath);
    if (normalized === '/') {
      return { ok: false, error: `${label}: "${rawPath}" resolves to the workspace root, not a file.` };
    }
    // Reserved workspace vocabulary (mirrors the store's `seedRealm` guard):
    // seed paths are workspace-relative, and `/global/...` / `/public/...`
    // would be routed by the legacy VirtualFS to the ungrouped shared
    // workspace instead of the selected one. Rejected, never re-rooted.
    const rootSegment = normalized.split('/')[1] ?? '';
    if (rootSegment === 'global' || rootSegment === 'public') {
      return {
        ok: false,
        error: `${label}: "${rawPath}" addresses the reserved workspace prefix "/${rootSegment}" — seed paths are workspace-relative.`
      };
    }
    if (seen.has(normalized)) {
      return { ok: false, error: `${label}: "${normalized}" duplicates an earlier file row.` };
    }
    if (typeof row.content !== 'string') {
      return { ok: false, error: `${label}: content must be text.` };
    }
    seen.add(normalized);
    files.push({ path: normalized, content: row.content });
  }
  return { ok: true, files };
}

/**
 * Editable seed draft consumed by {@link validateSeedDraft}.
 */
export interface RealmSeedDraft {
  /** Editable file rows. */
  readonly rows: unknown;
  /** Optional operator directive text. */
  readonly directive?: unknown;
  /** Selected target member id (`''`/absent = Realm-global workspace). */
  readonly targetAgentId?: unknown;
}

/**
 * Result of validating the seed draft: the exact call payload, or one inline error.
 */
export type SeedDraftResult =
  | {
      readonly ok: true;
      readonly files: RealmSeedFileRow[];
      readonly directive: string | null;
      readonly targetAgentId: string | null;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Validates the whole seed draft: file rows, directive text, and directive
 * targeting.
 *
 * A directive requires an explicit member target (the store delivers it as an
 * operator-attributed mailbox message; realm-global has no recipient), so a
 * non-blank directive with the Realm-global target selected is rejected here
 * before any file is written. An empty/whitespace directive counts as absent.
 *
 * @param draft - Editable rows, directive text, and target selection.
 * @returns Normalized seed payload, or one inline error.
 *
 * @example
 * ```typescript
 * validateSeedDraft({ rows: [{ path: '/a.md', content: '' }] });
 * // => { ok: true, files: [{ path: '/a.md', content: '' }], directive: null, targetAgentId: null }
 * ```
 */
export function validateSeedDraft(draft: RealmSeedDraft): SeedDraftResult {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, error: 'The seed request is malformed.' };
  }
  const parsed = parseSeedFileRows(draft.rows);
  if (!parsed.ok) return parsed;
  if (parsed.files.length === 0) {
    return { ok: false, error: 'Add at least one file row to seed, or skip seeding.' };
  }
  if (draft.directive !== undefined && draft.directive !== null && typeof draft.directive !== 'string') {
    return { ok: false, error: 'The directive must be text.' };
  }
  const directive = typeof draft.directive === 'string' && draft.directive.trim().length > 0
    ? draft.directive
    : null;
  const targetAgentId = typeof draft.targetAgentId === 'string' && draft.targetAgentId.trim().length > 0
    ? draft.targetAgentId.trim()
    : null;
  if (directive !== null && targetAgentId === null) {
    return {
      ok: false,
      error: 'A directive needs a member recipient — choose a target member, or clear the directive.'
    };
  }
  return { ok: true, files: parsed.files, directive, targetAgentId };
}

/**
 * Editable launch draft consumed by {@link validateRealmLaunchDraft}.
 */
export interface RealmLaunchDraft {
  /** Selected template id. */
  readonly templateId: unknown;
  /** Operator-entered Realm name. */
  readonly name: unknown;
  /** Template ids currently offered by the store (the picker options). */
  readonly templateIds: readonly string[];
  /** Registered Realm records whose names must stay unique in the UI. */
  readonly realms: ReadonlyArray<{ readonly name?: string | null }>;
}

/**
 * Result of validating the launch draft: the normalized store call payload, or one inline error.
 */
export type LaunchDraftResult =
  | {
      readonly ok: true;
      readonly templateId: string;
      readonly name: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /** Per-field inline errors keyed by input id (empty for non-input failures). */
      readonly fieldErrors: Record<string, string>;
    };

/**
 * Whether a candidate Realm name collides with a registered record.
 *
 * Realm identity is the generated id, so the registry itself treats names as
 * repeatable labels; both operator creation surfaces (the launcher wizard and
 * the Realm manager's create form) share this guard to keep names unique in
 * the UI. Comparison is trimmed and case-insensitive, and a blank candidate
 * never collides (the required-name check owns that rejection).
 *
 * @param name - Candidate Realm name (any shape; non-strings never collide).
 * @param realms - Registered Realm records (any `{ name }` shapes).
 * @returns `true` when a record already carries the normalized name.
 *
 * @example
 * ```typescript
 * isRealmNameTaken('  story REALM ', [{ name: 'Story Realm' }]);
 * // => true
 * ```
 */
export function isRealmNameTaken(
  name: unknown,
  realms: ReadonlyArray<{ readonly name?: string | null } | null | undefined>
): boolean {
  const candidate = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!candidate) return false;
  const list = Array.isArray(realms) ? realms : [];
  return list.some(
    (realm) => realm != null && typeof realm.name === 'string' && realm.name.trim().toLowerCase() === candidate
  );
}

/**
 * Validates the launch draft before the store call: a selected template that
 * is still offered, a non-blank Realm name, and a name that no registered
 * Realm already uses (case-insensitive, trimmed via
 * {@link isRealmNameTaken}). Input values are validated separately through
 * the store's own payload path (`validateRealmV2InputDrafts`).
 *
 * @param draft - Template selection, name draft, and current option lists.
 * @returns Normalized launch payload, or one inline error (with per-field errors).
 *
 * @example
 * ```typescript
 * validateRealmLaunchDraft({
 *   templateId: 'demo', name: 'Story Realm', templateIds: ['demo'], realms: []
 * });
 * // => { ok: true, templateId: 'demo', name: 'Story Realm' }
 * ```
 */
export function validateRealmLaunchDraft(draft: RealmLaunchDraft): LaunchDraftResult {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, error: 'The launch request is malformed.', fieldErrors: {} };
  }
  const templateId = typeof draft.templateId === 'string' ? draft.templateId.trim() : '';
  if (!templateId) {
    return { ok: false, error: 'Choose a template to launch.', fieldErrors: {} };
  }
  const templateIds = Array.isArray(draft.templateIds) ? draft.templateIds : [];
  if (!templateIds.some((id) => id === templateId)) {
    return { ok: false, error: `Template "${templateId}" is no longer available — choose another.`, fieldErrors: {} };
  }
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'A Realm name is required.', fieldErrors: {} };
  }
  const realms = Array.isArray(draft.realms) ? draft.realms : [];
  if (isRealmNameTaken(name, realms)) {
    return { ok: false, error: `A Realm named "${name}" already exists — pick a different name.`, fieldErrors: {} };
  }
  return { ok: true, templateId, name };
}

/**
 * Describes a seed workspace key for the success receipt: the Realm-global
 * partition is labeled explicitly, every other key is a member workspace.
 *
 * @param workspace - Workspace key reported by `seedRealm()`.
 * @param realmId - Realm the seed ran against.
 * @returns Human-readable workspace description.
 */
export function describeSeedWorkspace(workspace: string, realmId: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0) return 'an unknown workspace';
  if (typeof realmId === 'string' && realmId.length > 0 && workspace === `realm:${realmId}:global`) {
    return 'the Realm-global workspace (shared by every member)';
  }
  return `the member workspace "${workspace}"`;
}

/** Operator-principal remediation shown for permission-denied failures. */
const OPERATOR_HINT =
  'The operator (Director) principal is required for that Realm action. Reload with the Director registered and retry.';

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

/**
 * Describes a failed `launchRealmFromTemplate()` call, including the rollback
 * report carried by the typed `ERR_STORE_REALM_LAUNCH_FAILED` error, so a
 * failed launch never reads as a silent no-op.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeRealmLaunchError(
  error: unknown,
  fallback = 'Failed to launch the Realm.'
): string {
  const shape = shapeOf(error);
  if (isPermissionDenied(error, shape)) return OPERATOR_HINT;
  const base = messageOf(error) || fallback;
  if (shape.code !== 'ERR_STORE_REALM_LAUNCH_FAILED') return base;
  const terminated = Array.isArray(shape.terminatedMembers) ? shape.terminatedMembers.length : 0;
  const rollbackFailures = Array.isArray(shape.rollbackFailures)
    ? shape.rollbackFailures.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
      )
    : [];
  if (shape.rolledBack === true && rollbackFailures.length === 0) {
    const members = `${terminated} rolled-back member${terminated === 1 ? '' : 's'}`;
    return `${base} No partial Realm remains (${members}).`;
  }
  const detail = rollbackFailures.length > 0 ? rollbackFailures.join('; ') : 'rollback did not report success';
  return `${base} Rollback could not be confirmed: ${detail}.`;
}

/**
 * Describes a failed `seedRealm()` call, including the paths already written
 * when the store reports a partial write, so no partial seed is silent.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeRealmSeedError(
  error: unknown,
  fallback = 'Failed to seed the Realm.'
): string {
  const shape = shapeOf(error);
  if (isPermissionDenied(error, shape)) return OPERATOR_HINT;
  const base = messageOf(error) || fallback;
  if (shape.code !== 'ERR_STORE_VFS_FAILED' && !Array.isArray(shape.writtenPaths)) return base;
  const written = Array.isArray(shape.writtenPaths)
    ? shape.writtenPaths.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (written.length === 0) return `${base} No files were written.`;
  return `${base} Files already written before the failure: ${written.join(', ')}. The remaining rows were not written.`;
}

/**
 * Finds a preset entry by id.
 *
 * @param presets - Catalog entries.
 * @param id - Preset id to find.
 * @returns The entry, or `null`.
 */
function findPreset(
  presets: ReadonlyArray<{ readonly id: string; readonly name?: string | null }>,
  id: string
): { readonly id: string; readonly name?: string | null } | null {
  for (const preset of presets) {
    if (preset && preset.id === id) return preset;
  }
  return null;
}

/**
 * Display label of a preset entry (name when present, else id).
 *
 * @param preset - Catalog entry.
 * @returns Display label.
 */
function presetLabel(preset: { readonly id: string; readonly name?: string | null }): string {
  return typeof preset.name === 'string' && preset.name.trim().length > 0 ? preset.name.trim() : preset.id;
}
