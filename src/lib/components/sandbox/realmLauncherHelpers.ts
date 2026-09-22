/**
 * Realm launcher UI helpers (Wave B, ticket b309e02).
 *
 * Pure, UI-framework-free projections and fail-closed validation shared by
 * `RealmLauncherModal.svelte`: the per-agent launch preview (built from the
 * `realmCatalog` capability summaries), the preset-binding display model, the
 * seed file-row parser, the seed-target options, and the store-error/seed-
 * workspace descriptions.
 *
 * These helpers never call the store and never hold state: every function is a
 * pure projection of its arguments, so the modal stays a thin rendering layer
 * and the validation rules are unit-testable without a DOM.
 */

import { composeAgentHistory, composeSystemPrompt, summarizeAgentCapabilities } from '../../sandbox/realmCatalog/index.ts';
import type {
  AgentCapabilitySummary,
  PromptPart,
  RealmAgentSpec,
  RealmComposeOptions,
  RealmInputProvenance,
  RealmSeedManifest,
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
 * modal; every other failure (undeclared input, required input empty, caps)
 * is reported through `error`.
 *
 * @param parts - Ordered prompt parts of the agent spec.
 * @param inputs - Declared template inputs referenced by `input` parts.
 * @param options - Launch input values and bundle file bodies.
 * @returns The preview projection; failures are inline, never thrown.
 *
 * @example
 * ```typescript
 * const preview = buildRealmPromptPreview(
 *   [{ kind: 'text', text: 'Protocol.' }, { kind: 'input', inputId: 'directives' }],
 *   [{ id: 'directives', label: 'Directives' }],
 *   { inputValues: { directives: 'Be concise.' } }
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
  const inputValues = opts.inputValues && typeof opts.inputValues === 'object' ? opts.inputValues : {};

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
      const defaultFile = inputsById.get(part.inputId)?.defaultFile;
      if (typeof defaultFile === 'string' && !Object.prototype.hasOwnProperty.call(bundleFiles, defaultFile)) {
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
    const composed = composeSystemPrompt(partList, declarations, { inputValues, bundleFiles });
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
 * Resolves the input values a spec's declared history references, mirroring
 * the catalog's launch/default/defaultFile/empty precedence
 * (`resolveAgentHistoryInputValues`), so a history opener previews exactly the
 * value the launch would seed.
 *
 * @param declarations - Referenced input declarations, in first-reference order.
 * @param inputValues - Explicit launch/review values.
 * @param bundleFiles - Bundle file bodies for `defaultFile` prefills.
 * @returns Resolved values keyed by input id.
 */
function resolveHistoryInputValues(
  declarations: readonly RealmTemplateInput[],
  inputValues: Readonly<Record<string, unknown>>,
  bundleFiles: Readonly<Record<string, string>>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const declaration of declarations) {
    if (Object.prototype.hasOwnProperty.call(inputValues, declaration.id)) {
      const value = inputValues[declaration.id];
      if (typeof value !== 'string') {
        throw new Error(`The history input "${declaration.id}" value must be text.`);
      }
      resolved[declaration.id] = value;
      continue;
    }
    if (typeof declaration.default === 'string') {
      resolved[declaration.id] = declaration.default;
      continue;
    }
    if (typeof declaration.defaultFile === 'string') {
      if (!Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
        throw new Error(`The history input "${declaration.id}" default file is not in the launch bundle.`);
      }
      resolved[declaration.id] = bundleFiles[declaration.defaultFile];
      continue;
    }
    resolved[declaration.id] = '';
  }
  return resolved;
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
  const inputValues = opts.inputValues && typeof opts.inputValues === 'object' ? opts.inputValues : {};
  const history = Array.isArray(spec.history) ? spec.history : [];

  const inputsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    declarations
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );
  const referencedInputs: RealmTemplateInput[] = [];
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
          && !Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
          missing.push(declaration.defaultFile);
        }
        if (!referencedInputs.includes(declaration)) referencedInputs.push(declaration);
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
    const composed = composeAgentHistory(
      spec,
      resolveHistoryInputValues(referencedInputs, inputValues, bundleFiles),
      bundleFiles
    );
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
 * One editable template input rendered by the launcher form.
 *
 * `value` is the effective field text (prefilled from the declared `default`
 * or the `defaultFile` bundle entry); `dirty` records whether the operator
 * touched the field. Presence semantics: an untouched field is omitted from
 * `inputValues` (the catalog resolves the declared prefill), while an edited
 * or cleared field travels explicitly — an explicit `''` blocks a `required`
 * input instead of silently falling back to the default.
 *
 * `origin` is the declared content origin (format v1 §3.2): `user` (the
 * default) or `generated` (hydration-produced, with a hydration `brief`). Both
 * origins render as normal editable fields in review — the reviewer may type,
 * edit, or override a generated proposal before launch.
 */
export interface RealmInputFieldDraft {
  /** Declared input id (the `inputValues` key). */
  readonly id: string;
  /** Human-readable field label. */
  readonly label: string;
  /** Author help text; empty when absent. */
  readonly help: string;
  /** Whether to render a multiline field (catalog default is true). */
  readonly multiline: boolean;
  /** Whether composition fails closed while the value stays empty. */
  readonly required: boolean;
  /** Declared content origin: `user` (operator-provided) or `generated` (hydration-produced). */
  readonly origin: 'user' | 'generated';
  /** Hydration instruction for a `generated` input (empty for `user` origins). */
  readonly brief: string;
  /** Current field text. */
  readonly value: string;
  /** Whether the operator edited the field (dirty fields travel in `inputValues`). */
  readonly dirty: boolean;
  /** Reset target: the resolved template default (`''` when absent/unresolved). */
  readonly defaultValue: string;
  /** Whether the template default resolved (false for an unresolved `defaultFile`). */
  readonly defaultResolved: boolean;
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

/**
 * Builds the editable input drafts for one template: declared order, prefilled
 * with each input's `default` (or resolved `defaultFile`) and marked untouched.
 *
 * Malformed declarations are skipped (the template preview owns structural
 * reporting), and a missing `defaultFile` prefill starts empty with
 * `defaultResolved: false` so the form can flag it.
 *
 * @param inputs - Declared template inputs (absent → no fields).
 * @param bundleFiles - Bundle file bodies for `defaultFile` prefills.
 * @returns Fresh drafts, in declared order.
 *
 * @example
 * ```typescript
 * buildRealmInputDrafts([{ id: 'directives', label: 'Directives', default: 'Be brief.' }]);
 * // => [{ id: 'directives', value: 'Be brief.', dirty: false, ... }]
 * ```
 */
export function buildRealmInputDrafts(
  inputs: readonly RealmTemplateInput[] | null | undefined,
  bundleFiles?: Readonly<Record<string, string>> | null
): RealmInputFieldDraft[] {
  if (!Array.isArray(inputs)) return [];
  const files = bundleFiles && typeof bundleFiles === 'object' ? bundleFiles : {};
  const drafts: RealmInputFieldDraft[] = [];
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || input.id.length === 0) continue;
    const prefill = resolveInputPrefill(input, files);
    const origin: 'user' | 'generated' = input.origin === 'generated' ? 'generated' : 'user';
    drafts.push({
      id: input.id,
      label: typeof input.label === 'string' && input.label.length > 0 ? input.label : input.id,
      help: typeof input.help === 'string' ? input.help : '',
      multiline: input.multiline !== false,
      required: input.required === true,
      origin,
      brief: origin === 'generated' && typeof input.brief === 'string' ? input.brief : '',
      value: prefill.value,
      dirty: false,
      defaultValue: prefill.value,
      defaultResolved: prefill.resolved
    });
  }
  return drafts;
}

/**
 * Resets one input field to its template default and marks it untouched.
 *
 * @param draft - Current draft (returned unchanged when malformed).
 * @param declaration - The template input declaration behind the draft.
 * @param bundleFiles - Bundle file bodies for a `defaultFile` prefill.
 * @returns A fresh draft prefilled from the declaration, `dirty: false`.
 */
export function resetRealmInputField(
  draft: RealmInputFieldDraft,
  declaration: RealmTemplateInput | null | undefined,
  bundleFiles?: Readonly<Record<string, string>> | null
): RealmInputFieldDraft {
  if (!draft || typeof draft !== 'object' || !declaration || typeof declaration !== 'object') {
    return draft;
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
 * Whether the reviewer may edit one input field.
 *
 * Review is mandatory (format v1 §5 step 3) and every declared input — `user`
 * and `generated` alike — stays a normal editable field in this wave: a
 * generated value is a hydration proposal the reviewer may type, edit, or
 * override before launch. Only a structurally malformed draft is
 * non-editable, because there is no field to edit.
 *
 * @param draft - Input field draft.
 * @returns `true` for a well-formed draft (any origin).
 *
 * @example
 * ```typescript
 * isRealmInputEditable({ id: 'premise', origin: 'generated' }); // true
 * ```
 */
export function isRealmInputEditable(draft: RealmInputFieldDraft | null | undefined): boolean {
  return Boolean(draft && typeof draft === 'object' && typeof draft.id === 'string' && draft.id.length > 0);
}

/**
 * Assembles the `inputValues` payload from the drafts: only edited fields are
 * present (an untouched field stays omitted so the catalog resolves the
 * declared default), and an explicitly cleared field travels as `''`.
 *
 * @param drafts - Editable input drafts.
 * @returns Fresh `inputValues` record (empty when nothing was edited).
 */
export function assembleRealmInputValues(
  drafts: readonly RealmInputFieldDraft[] | null | undefined
): Record<string, string> {
  const values: Record<string, string> = {};
  if (!Array.isArray(drafts)) return values;
  for (const draft of drafts) {
    if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string' || draft.id.length === 0) continue;
    if (draft.dirty === true) {
      values[draft.id] = typeof draft.value === 'string' ? draft.value : '';
    }
  }
  return values;
}

/**
 * Result of validating the editable input drafts.
 */
export interface RealmInputDraftValidation {
  /** Whether every required field resolves non-empty. */
  readonly ok: boolean;
  /** `inputValues` payload assembled from the dirty fields (empty on failure is still assembled for previews). */
  readonly inputValues: Record<string, string>;
  /** Per-field inline errors keyed by input id (empty when valid). */
  readonly fieldErrors: Record<string, string>;
  /** Aggregate inline error; empty when valid. */
  readonly error: string;
}

/**
 * Validates the editable input drafts: a `required` field whose effective
 * value (draft text, prefill included) is empty fails closed with an inline
 * per-field error — including the explicit-empty case (the operator cleared a
 * required field, which must not silently fall back to the default).
 *
 * @param drafts - Editable input drafts.
 * @returns Validation result with the assembled `inputValues` payload.
 *
 * @example
 * ```typescript
 * validateRealmInputDrafts([{ id: 'mandate', label: 'Mandate', required: true, value: '', dirty: true }]);
 * // => { ok: false, fieldErrors: { mandate: '"Mandate" is required.' }, ... }
 * ```
 */
export function validateRealmInputDrafts(
  drafts: readonly RealmInputFieldDraft[] | null | undefined
): RealmInputDraftValidation {
  const list = Array.isArray(drafts) ? drafts : [];
  const inputValues = assembleRealmInputValues(list);
  const fieldErrors: Record<string, string> = {};
  for (const draft of list) {
    if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string' || draft.id.length === 0) continue;
    if (draft.required !== true) continue;
    const value = typeof draft.value === 'string' ? draft.value : '';
    if (value.trim().length === 0) {
      const label = typeof draft.label === 'string' && draft.label.length > 0 ? draft.label : draft.id;
      fieldErrors[draft.id] = `"${label}" is required.`;
    }
  }
  const errors = Object.values(fieldErrors);
  if (errors.length > 0) {
    return {
      ok: false,
      inputValues,
      fieldErrors,
      error: errors.length === 1
        ? errors[0]
        : `${errors.length} required inputs are empty — fill them in or reset to the template defaults.`
    };
  }
  return { ok: true, inputValues, fieldErrors: {}, error: '' };
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
  /** Whether the selected template declares a seed manifest. */
  readonly declaresSeed: boolean;
  /** Number of declared seed files. */
  readonly fileCount: number;
  /** Distinct target labels, in first-appearance order. */
  readonly targetLabels: readonly string[];
  /** Directive summary (target label + text preview), or `null` when absent. */
  readonly directive: {
    readonly targetAgentKey: string;
    readonly targetLabel: string;
    readonly preview: string;
  } | null;
}

/**
 * Builds the compact seed summary shown with the launcher's seed toggle.
 *
 * The summary never resolves bundle-file content (counting and targeting are
 * enough); a `source.file` entry is counted like any other file, and the
 * materialization step still fails closed when the bundle entry is missing.
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
  if (!template || typeof template !== 'object') {
    return { declaresSeed: false, fileCount: 0, targetLabels: [], directive: null };
  }
  const seed: RealmSeedManifest | undefined = template.seed;
  if (!seed || typeof seed !== 'object') {
    return { declaresSeed: false, fileCount: 0, targetLabels: [], directive: null };
  }
  const files = Array.isArray(seed.files) ? seed.files : [];
  const agents = Array.isArray(template.agents) ? template.agents : [];
  const labelFor = (key: string): string => {
    const agent = agents.find((entry) => entry && entry.key === key) ?? null;
    return agent && typeof agent.name === 'string' && agent.name.length > 0 ? `${agent.name} (${key})` : key;
  };
  const targetLabels: string[] = [];
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    let label: string;
    if (file.target === 'realm') {
      label = 'Realm-global workspace';
    } else if (file.target && typeof file.target === 'object' && typeof file.target.agent === 'string') {
      label = labelFor(file.target.agent);
    } else {
      label = 'Unknown target';
    }
    if (!targetLabels.includes(label)) targetLabels.push(label);
  }
  let directive: RealmSeedSummary['directive'] = null;
  const declaredDirective = seed.directive;
  if (declaredDirective && typeof declaredDirective === 'object'
    && typeof declaredDirective.targetAgentKey === 'string') {
    const text = typeof declaredDirective.text === 'string' ? declaredDirective.text.trim() : '';
    directive = {
      targetAgentKey: declaredDirective.targetAgentKey,
      targetLabel: labelFor(declaredDirective.targetAgentKey),
      preview: text.length > 120 ? `${text.slice(0, 120).trimEnd()}…` : text
    };
  }
  return { declaresSeed: true, fileCount: files.length, targetLabels, directive };
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
 * Slots render in declared order with their destination and origin so the
 * reviewer can see exactly what the launch will write and where each slot's
 * content comes from. Malformed declarations are skipped (structural reporting
 * belongs to the template preview) and no slot content is resolved — this
 * wave lists slots only; the files dialog lands with the hydration wave.
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
  if (!template || typeof template !== 'object' || !template.seed || typeof template.seed !== 'object') return [];
  const files = Array.isArray(template.seed.files) ? template.seed.files : [];
  const agents = Array.isArray(template.agents) ? template.agents : [];
  const views: RealmSeedSlotView[] = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || file.path.length === 0) continue;
    const origin: 'fixed' | 'user' | 'generated' = file.origin === 'user' || file.origin === 'generated'
      ? file.origin
      : 'fixed';
    let targetKind: 'realm' | 'agent' = 'realm';
    let targetKey = '';
    let targetLabel = 'Realm-global workspace';
    if (file.target && typeof file.target === 'object' && typeof file.target.agent === 'string') {
      targetKind = 'agent';
      targetKey = file.target.agent;
      const agent = agents.find((entry) => entry && entry.key === targetKey) ?? null;
      targetLabel = agent && typeof agent.name === 'string' && agent.name.length > 0
        ? `${agent.name} (${targetKey})`
        : targetKey;
    }
    views.push({
      path: file.path,
      targetKind,
      targetKey,
      targetLabel,
      origin,
      brief: typeof file.brief === 'string' ? file.brief : '',
      sourceLabel: describeSeedSlotSource(origin, file.source)
    });
  }
  return views;
}

/**
 * Labels where one seed slot's content comes from at launch.
 *
 * @param origin - Effective slot origin.
 * @param source - Declared fixed source (ignored for `user`/`generated`).
 * @returns Human-readable source label.
 */
function describeSeedSlotSource(
  origin: 'fixed' | 'user' | 'generated',
  source: { readonly file?: unknown; readonly inline?: unknown } | null | undefined
): string {
  if (origin === 'user') return 'attached at launch';
  if (origin === 'generated') return 'filled from the hydration package';
  if (source && typeof source === 'object') {
    if (typeof source.file === 'string' && source.file.length > 0) return `bundle file ${source.file}`;
    if (typeof source.inline === 'string') return 'inline bundle content';
  }
  return 'bundle content';
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
  /**
   * Editable input drafts from {@link buildRealmInputDrafts} (absent when the
   * template declares no inputs). Required fields fail closed here.
   */
  readonly inputDrafts?: unknown;
}

/**
 * Result of validating the launch draft: the normalized store call payload, or one inline error.
 */
export type LaunchDraftResult =
  | {
      readonly ok: true;
      readonly templateId: string;
      readonly name: string;
      /** `inputValues` payload assembled from the dirty input drafts. */
      readonly inputValues: Record<string, string>;
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
 * is still offered, a non-blank Realm name, a name that no registered Realm
 * already uses (case-insensitive, trimmed via {@link isRealmNameTaken}), and
 * every `required` input draft resolving non-empty.
 *
 * The returned `inputValues` payload carries only edited input fields
 * ({@link assembleRealmInputValues}), so an untouched field lets the catalog
 * resolve its declared default.
 *
 * @param draft - Template selection, name draft, current option lists, and input drafts.
 * @returns Normalized launch payload, or one inline error (with per-field errors).
 *
 * @example
 * ```typescript
 * validateRealmLaunchDraft({
 *   templateId: 'demo', name: 'Story Realm', templateIds: ['demo'], realms: []
 * });
 * // => { ok: true, templateId: 'demo', name: 'Story Realm', inputValues: {} }
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
  if (draft.inputDrafts !== undefined && !Array.isArray(draft.inputDrafts)) {
    return { ok: false, error: 'The launch input drafts are malformed.', fieldErrors: {} };
  }
  const inputs = validateRealmInputDrafts(Array.isArray(draft.inputDrafts) ? draft.inputDrafts : []);
  if (!inputs.ok) {
    return { ok: false, error: inputs.error, fieldErrors: inputs.fieldErrors };
  }
  return { ok: true, templateId, name, inputValues: inputs.inputValues };
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
