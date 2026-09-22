/**
 * Realm launch review helpers (Wave U, lane U-R, ticket 458e727).
 *
 * Pure, UI-framework-free projections shared by `RealmLauncherModal.svelte`
 * (the completed review surface: per-part prompt provenance, editable baked
 * history, the file-content dialog, payload attachment, declared-authority
 * approvals, and the launch gate) and `AgentSettingsPanel.svelte` (the
 * operator `@template:authority` / `@hydration:authority` toggles).
 *
 * The composition and validation projections call the real `realmCatalog`
 * helpers (`composeSystemPrompt`, `composeAgentHistory`,
 * `validateHydrationPackage`) so a review can never disagree with what the
 * launch materializes; the store stays out of this module except for the one
 * injected grant-host seam the settings toggles call through
 * ({@link applyMetaAuthorityToggle}), which keeps the toggle wiring testable
 * against the real store without a DOM.
 *
 * Review semantics (Wave U decision 8): editing happens at the source —
 * generated/user inputs (their values flow into prompts and input-backed
 * history entries), generated/user seed files (carried into the attachment
 * package), and baked history entries through those sources. Per-instance
 * prompt overrides stay out, so `fixed` prompt parts and `fixed` seed slots
 * render read-only with explicit provenance.
 */

import {
  AGENT_AUTHORITIES,
  KNOWN_AGENT_AUTHORITIES,
  composeAgentHistory,
  validateHydrationPackage
} from '../../sandbox/realmCatalog/index.ts';
import type {
  PromptPart,
  RealmAgentSpec,
  RealmComposeOptions,
  RealmInputValues,
  RealmTemplate,
  RealmTemplateInput,
  RealmTemplateSeedFile
} from '../../sandbox/realmCatalog/index.ts';

/** Declared content origin of one reviewed artifact. */
export type RealmContentOrigin = 'fixed' | 'user' | 'generated';

/** Human label of one origin for review badges. */
export function describeRealmOrigin(origin: RealmContentOrigin): string {
  if (origin === 'generated') return 'generated';
  if (origin === 'user') return 'user';
  return 'fixed';
}

/**
 * Reads the human-readable message from an unknown thrown value.
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
 * Reads a thrown value's stable `code` field, when present.
 *
 * @param error - Thrown value.
 * @returns The code string, or an empty string.
 */
function codeOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * Whether a candidate is a plain record (own enumerable data, not an array).
 *
 * @param value - Candidate value.
 * @returns True for a plain object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Own-property read of a record (never resolves through the prototype chain).
 *
 * @param record - Source record.
 * @param key - Key to read.
 * @returns The own value, or `undefined`.
 */
function own(record: Readonly<Record<string, unknown>> | null | undefined, key: string): unknown {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

/**
 * Introduced `input` parts are editable at their source (the input field).
 *
 * @returns Always true — kept as a named seam for the review copy.
 */
export function isRealmInputPartEditable(): boolean {
  return true;
}

// ============================================================================
// Prompt part provenance
// ============================================================================

/**
 * One prompt/history part rendered with its declared provenance.
 *
 * `content` is the part's resolved contribution (the file body, the input
 * value, or the literal text); `editable` is true only for `input` parts,
 * which the review edits at their source (the launch input value) — never as
 * a per-instance prompt override.
 */
export interface RealmPartProvenanceView {
  /** Zero-based declared position. */
  readonly index: number;
  /** Part primitive. */
  readonly kind: 'file' | 'input' | 'text';
  /** Declared origin: bundle files and literal text are `fixed`; inputs carry their declared origin. */
  readonly origin: RealmContentOrigin;
  /** Display label (`bundle file <path>`, `input "<label>"`, `inline text`). */
  readonly label: string;
  /** Bundle path for `file` parts (empty otherwise). */
  readonly path: string;
  /** Referenced input id for `input` parts (empty otherwise). */
  readonly inputId: string;
  /** Referenced input label for `input` parts (empty otherwise). */
  readonly inputLabel: string;
  /** Whether the review may edit this part (input parts edit their source value). */
  readonly editable: boolean;
  /** Resolved contribution text (empty when the part contributes nothing). */
  readonly content: string;
  /** Whether the resolved contribution is empty. */
  readonly empty: boolean;
  /** Whether the referenced input is declared required. */
  readonly required: boolean;
}

/**
 * Review projection of one agent's prompt or history parts.
 */
export interface RealmPartProvenanceProjection {
  /** Whether every part resolved. */
  readonly ok: boolean;
  /** Part views in declared order (empty on failure). */
  readonly parts: readonly RealmPartProvenanceView[];
  /** Whether the failure is a missing bundle file. */
  readonly bundleUnavailable: boolean;
  /** User-facing failure text; empty when `ok` is true. */
  readonly error: string;
}

/**
 * Builds declared-input lookup and resolves one input's review value with the
 * catalog's launch → default → defaultFile → empty precedence.
 *
 * @param declaration - Declared input.
 * @param inputValues - Effective review values.
 * @param bundleFiles - Bundle file bodies.
 * @returns The resolved value (empty when unresolved) and whether it resolved.
 */
function resolveInputReviewValue(
  declaration: RealmTemplateInput,
  inputValues: Readonly<Record<string, unknown>>,
  bundleFiles: Readonly<Record<string, string>>
): { value: string; resolved: boolean } {
  if (Object.prototype.hasOwnProperty.call(inputValues, declaration.id)) {
    const explicit = inputValues[declaration.id];
    return { value: typeof explicit === 'string' ? explicit : '', resolved: true };
  }
  if (typeof declaration.default === 'string') return { value: declaration.default, resolved: true };
  if (typeof declaration.defaultFile === 'string') {
    if (Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
      return { value: bundleFiles[declaration.defaultFile], resolved: true };
    }
    return { value: '', resolved: false };
  }
  return { value: '', resolved: true };
}

/**
 * Builds per-part provenance views for one ordered part list (a prompt or a
 * history entry's content).
 *
 * `file` parts resolve verbatim from the bundle files and `text` parts carry
 * their literal text (both `fixed`); `input` parts carry the declared origin
 * and the value resolved with the same precedence the catalog composition
 * uses. Missing bundle entries are reported as `bundleUnavailable` — the
 * caller renders the explicit bundle state instead of guessing.
 *
 * @param parts - Declared parts in order.
 * @param inputs - Declared template inputs referenced by input parts.
 * @param options - Effective review input values and bundle file bodies.
 * @returns The projection; failures are inline, never thrown.
 *
 * @example
 * ```typescript
 * const view = buildRealmPartProvenanceViews(
 *   [{ kind: 'input', inputId: 'tone' }],
 *   [{ id: 'tone', label: 'Tone', origin: 'generated' }],
 *   { inputValues: { tone: 'Noir.' } }
 * );
 * view.parts[0].origin; // 'generated'
 * ```
 */
export function buildRealmPartProvenanceViews(
  parts: readonly PromptPart[] | null | undefined,
  inputs: readonly RealmTemplateInput[] | null | undefined,
  options: RealmComposeOptions | null | undefined = {}
): RealmPartProvenanceProjection {
  const partList = Array.isArray(parts) ? parts : [];
  const declarations = Array.isArray(inputs) ? inputs : [];
  const opts = isRecord(options) ? options : {};
  const inputValues: Readonly<Record<string, unknown>> = isRecord(opts.inputValues) ? opts.inputValues : {};
  const bundleFiles: Readonly<Record<string, string>> = isRecord(opts.bundleFiles)
    ? (opts.bundleFiles as Readonly<Record<string, string>>)
    : {};
  const inputsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    declarations
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );

  const missing: string[] = [];
  const views: RealmPartProvenanceView[] = [];
  partList.forEach((part, index) => {
    if (!part || typeof part !== 'object') return;
    if (part.kind === 'file') {
      const present = typeof part.path === 'string'
        && Object.prototype.hasOwnProperty.call(bundleFiles, part.path);
      if (!present) missing.push(String(part.path));
      const content = present ? bundleFiles[part.path] : '';
      views.push({
        index,
        kind: 'file',
        origin: 'fixed',
        label: `bundle file ${part.path}`,
        path: typeof part.path === 'string' ? part.path : '',
        inputId: '',
        inputLabel: '',
        editable: false,
        content,
        empty: content.trim().length === 0,
        required: false
      });
      return;
    }
    if (part.kind === 'input') {
      const declaration = inputsById.get(part.inputId) ?? null;
      if (!declaration) {
        views.push({
          index,
          kind: 'input',
          origin: 'user',
          label: `undeclared input "${String(part.inputId)}"`,
          path: '',
          inputId: typeof part.inputId === 'string' ? part.inputId : '',
          inputLabel: '',
          editable: false,
          content: '',
          empty: true,
          required: false
        });
        return;
      }
      const resolved = resolveInputReviewValue(declaration, inputValues, bundleFiles);
      if (!resolved.resolved && typeof declaration.defaultFile === 'string') missing.push(declaration.defaultFile);
      views.push({
        index,
        kind: 'input',
        origin: declaration.origin === 'generated' ? 'generated' : 'user',
        label: `input "${declaration.label}"`,
        path: '',
        inputId: declaration.id,
        inputLabel: declaration.label,
        editable: isRealmInputPartEditable(),
        content: resolved.value,
        empty: resolved.value.trim().length === 0,
        required: declaration.required === true
      });
      return;
    }
    const text = typeof part.text === 'string' ? part.text : '';
    views.push({
      index,
      kind: 'text',
      origin: 'fixed',
      label: 'inline text',
      path: '',
      inputId: '',
      inputLabel: '',
      editable: false,
      content: text,
      empty: text.trim().length === 0,
      required: false
    });
  });

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    return {
      ok: false,
      parts: [],
      bundleUnavailable: true,
      error: `Prompt bundle files are not available: ${unique.join(', ')}. The review needs the bundle to resolve these parts.`
    };
  }
  return { ok: true, parts: views, bundleUnavailable: false, error: '' };
}

// ============================================================================
// Editable baked history
// ============================================================================

/**
 * One baked history entry rendered for review editing.
 *
 * `content` is the composed message (the same text the launch seeds, composed
 * by the catalog's `composeAgentHistory`); `parts` carries each declared part
 * with its provenance. Input parts stay editable at their source — editing
 * one writes the launch input value, and the composed entry re-renders from
 * it — while `fixed` parts are shipped in the bundle and render read-only.
 */
export interface RealmHistoryEntryView {
  /** Zero-based declared position. */
  readonly index: number;
  /** Message attribution. */
  readonly role: 'user' | 'assistant';
  /** Display label of the role (`Operator`/`Agent`). */
  readonly roleLabel: string;
  /** Composed content seeded at launch. */
  readonly content: string;
  /** Per-part provenance and resolved contributions. */
  readonly parts: readonly RealmPartProvenanceView[];
  /** Whether any part is editable at its source (an input reference). */
  readonly editable: boolean;
  /** Referenced input ids in first-reference order. */
  readonly inputIds: readonly string[];
}

/**
 * Review projection of one agent's baked history.
 */
export interface RealmHistoryEditorProjection {
  /** Whether the history composed. */
  readonly ok: boolean;
  /** Entry views in declared order (empty when no history is declared). */
  readonly entries: readonly RealmHistoryEntryView[];
  /** Whether the failure is a missing bundle file. */
  readonly bundleUnavailable: boolean;
  /** User-facing failure text; empty when `ok` is true. */
  readonly error: string;
}

/**
 * Builds the editable baked-history projection for one template agent: the
 * composed entries (through the real `composeAgentHistory`) zipped with each
 * entry's per-part provenance.
 *
 * Composition failures (missing bundle entries, undeclared input references,
 * an entry that composes empty) are reported inline; a spec without history is
 * a valid empty projection.
 *
 * @param spec - Agent spec whose history is reviewed.
 * @param inputs - Declared template inputs referenced by history parts.
 * @param options - Effective review input values and bundle file bodies.
 * @returns The projection; failures are inline, never thrown.
 */
export function buildRealmHistoryEditorViews(
  spec: RealmAgentSpec | null | undefined,
  inputs: readonly RealmTemplateInput[] | null | undefined,
  options: RealmComposeOptions | null | undefined = {}
): RealmHistoryEditorProjection {
  if (!spec || typeof spec !== 'object') {
    return { ok: true, entries: [], bundleUnavailable: false, error: '' };
  }
  const history = Array.isArray(spec.history) ? spec.history : [];
  if (history.length === 0) return { ok: true, entries: [], bundleUnavailable: false, error: '' };
  const declarations = Array.isArray(inputs) ? inputs : [];
  const opts = isRecord(options) ? options : {};
  const inputValues: Readonly<Record<string, unknown>> = isRecord(opts.inputValues) ? opts.inputValues : {};
  const inputsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    declarations
      .filter((input): input is RealmTemplateInput => Boolean(input) && typeof input.id === 'string')
      .map((input) => [input.id, input] as const)
  );

  // Resolve each entry's referenced inputs with the catalog's own precedence
  // (launch value → default → defaultFile → empty) and collect per-part
  // provenance; the composed content itself comes from the real
  // `composeAgentHistory`, so the review can never disagree with the launch.
  const resolvedValues: Record<string, string> = Object.create(null);
  const missing: string[] = [];
  const undeclaredInputs: string[] = [];
  const partViewsByEntry: RealmPartProvenanceView[][] = [];
  const bundleFiles = isRecord(opts.bundleFiles) ? (opts.bundleFiles as Readonly<Record<string, string>>) : {};

  history.forEach((entry, entryIndex) => {
    const partViews: RealmPartProvenanceView[] = [];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.content)) {
      partViewsByEntry.push(partViews);
      return;
    }
    entry.content.forEach((part, partIndex) => {
      if (!part || typeof part !== 'object') return;
      if (part.kind === 'file') {
        const present = typeof part.path === 'string'
          && Object.prototype.hasOwnProperty.call(bundleFiles, part.path);
        if (!present) missing.push(String(part.path));
        const content = present ? bundleFiles[part.path] : '';
        partViews.push({
          index: partIndex,
          kind: 'file',
          origin: 'fixed',
          label: `bundle file ${part.path}`,
          path: typeof part.path === 'string' ? part.path : '',
          inputId: '',
          inputLabel: '',
          editable: false,
          content,
          empty: content.trim().length === 0,
          required: false
        });
        return;
      }
      if (part.kind === 'input') {
        const inputId = typeof part.inputId === 'string' ? part.inputId : '';
        const declaration = inputId.length > 0 ? inputsById.get(inputId) ?? null : null;
        if (!declaration) {
          undeclaredInputs.push(inputId || String(part.inputId));
          partViews.push({
            index: partIndex,
            kind: 'input',
            origin: 'user',
            label: `undeclared input "${String(part.inputId)}"`,
            path: '',
            inputId,
            inputLabel: '',
            editable: false,
            content: '',
            empty: true,
            required: false
          });
          return;
        }
        let resolved: string;
        if (Object.prototype.hasOwnProperty.call(resolvedValues, inputId)) {
          resolved = resolvedValues[inputId];
        } else {
          const resolution = resolveInputReviewValue(declaration, inputValues, bundleFiles);
          if (!resolution.resolved && typeof declaration.defaultFile === 'string') missing.push(declaration.defaultFile);
          resolved = resolution.value;
          resolvedValues[inputId] = resolved;
        }
        partViews.push({
          index: partIndex,
          kind: 'input',
          origin: declaration.origin === 'generated' ? 'generated' : 'user',
          label: `input "${declaration.label}"`,
          path: '',
          inputId,
          inputLabel: declaration.label,
          editable: isRealmInputPartEditable(),
          content: resolved,
          empty: resolved.trim().length === 0,
          required: declaration.required === true
        });
        return;
      }
      const text = typeof part.text === 'string' ? part.text : '';
      partViews.push({
        index: partIndex,
        kind: 'text',
        origin: 'fixed',
        label: 'inline text',
        path: '',
        inputId: '',
        inputLabel: '',
        editable: false,
        content: text,
        empty: text.trim().length === 0,
        required: false
      });
    });
    partViewsByEntry.push(partViews);
  });

  if (undeclaredInputs.length > 0) {
    const unique = [...new Set(undeclaredInputs)];
    return {
      ok: false,
      entries: [],
      bundleUnavailable: false,
      error: `Agent "${spec.key}" history references undeclared input${unique.length === 1 ? '' : 's'} ${unique.map((id) => `"${id}"`).join(', ')}.`
    };
  }

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    return {
      ok: false,
      entries: [],
      bundleUnavailable: true,
      error: `History bundle files are not available: ${unique.join(', ')}. The review needs the bundle to resolve these entries.`
    };
  }

  let messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  try {
    messages = composeAgentHistory(spec, resolvedValues, bundleFiles);
  } catch (error) {
    return {
      ok: false,
      entries: [],
      bundleUnavailable: false,
      error: messageOf(error) || 'The baked history could not be composed.'
    };
  }
  if (messages.length !== history.length) {
    return {
      ok: false,
      entries: [],
      bundleUnavailable: false,
      error: 'The baked history composed an unexpected number of entries.'
    };
  }

  return {
    ok: true,
    entries: messages.map((message, index) => {
      const partViews = partViewsByEntry[index] ?? [];
      return {
        index,
        role: message.role,
        roleLabel: message.role === 'assistant' ? 'Agent' : 'Operator',
        content: message.content,
        parts: partViews,
        editable: partViews.some((view) => view.editable),
        inputIds: [...new Set(partViews.filter((view) => view.inputId).map((view) => view.inputId))]
      };
    }),
    bundleUnavailable: false,
    error: ''
  };
}

// ============================================================================
// File-content dialog
// ============================================================================

/**
 * One declared seed slot rendered in the review files dialog.
 *
 * `content` is the resolved review content (bundle for `fixed`, the attached
 * payload or the review edit for `user`/`generated`); `contentSource` names
 * where it came from, and `editable` is false for `fixed` slots (shipped in
 * the bundle — a hydration package must never carry them).
 */
export interface RealmReviewFileSlot {
  /** Stable slot key (`<target>|<path>`) shared with payload matching. */
  readonly key: string;
  /** Destination path (workspace-relative). */
  readonly path: string;
  /** Destination kind. */
  readonly targetKind: 'realm' | 'agent';
  /** Target template agent key (`''` for the Realm-global workspace). */
  readonly targetKey: string;
  /** Target display label. */
  readonly targetLabel: string;
  /** Declared content origin. */
  readonly origin: RealmContentOrigin;
  /** Hydration instruction (empty when absent). */
  readonly brief: string;
  /** Whether an attached package must carry this slot (`generated` slots). */
  readonly required: boolean;
  /** Whether the review may edit the content (everything but `fixed`). */
  readonly editable: boolean;
  /** Resolved review content (empty when absent/unresolved). */
  readonly content: string;
  /** Where the resolved content came from. */
  readonly contentSource: 'bundle-inline' | 'bundle-file' | 'payload' | 'review' | 'absent' | 'bundle-missing';
  /** Human label of `contentSource`. */
  readonly sourceLabel: string;
  /** Whether the operator edited the slot in review. */
  readonly edited: boolean;
}

/**
 * Builds the stable slot key used for payload matching and review edits.
 *
 * @param target - Declared slot target (`realm` or `{ agent }`).
 * @param path - Declared slot path.
 * @returns `${target}|${path}` (unknown targets render `unknown`).
 */
export function realmReviewSlotKey(target: unknown, path: unknown): string {
  const targetKey = target === 'realm'
    ? 'realm'
    : isRecord(target) && typeof target.agent === 'string'
      ? `agent:${target.agent}`
      : 'unknown';
  return `${targetKey}|${typeof path === 'string' ? path : ''}`;
}

/**
 * Resolves the payload files map (from an attached candidate or local file)
 * keyed by slot key.
 *
 * @param payload - Candidate hydration package (structural; malformed entries skipped).
 * @returns Slot key → content for every well-formed entry.
 */
function payloadFilesByKey(payload: unknown): Map<string, string> {
  const byKey = new Map<string, string>();
  if (!isRecord(payload) || !Array.isArray(payload.files)) return byKey;
  for (const entry of payload.files) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.content !== 'string') continue;
    const key = realmReviewSlotKey(entry.target, entry.path);
    if (key.startsWith('unknown|')) continue;
    byKey.set(key, entry.content);
  }
  return byKey;
}

/**
 * Reads the attached payload's input values (string-valued entries only).
 *
 * @param payload - Candidate hydration package (structural).
 * @returns Input id → value for every well-formed entry.
 */
export function payloadInputValues(payload: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  if (!isRecord(payload) || !isRecord(payload.inputs)) return values;
  for (const [inputId, value] of Object.entries(payload.inputs)) {
    if (typeof value === 'string') values[inputId] = value;
  }
  return values;
}

/**
 * Builds the review file-dialog slots for one template: every declared seed
 * slot with its resolved content and provenance.
 *
 * Resolution order per slot — review edit, attached payload entry, bundle
 * source (`fixed` only), absent. `fixed` slots are never editable and never
 * payload-overridable; a missing fixed `source.file` bundle entry is reported
 * as `bundle-missing` instead of guessing.
 *
 * @param template - Selected template (structural; malformed slots skipped).
 * @param bundleFiles - Bundle file bodies.
 * @param options - Attached payload and review edits keyed by slot key.
 * @returns Slot views in declared order.
 */
export function buildRealmReviewFileSlots(
  template: RealmTemplate | null | undefined,
  bundleFiles: Readonly<Record<string, string>> | null | undefined,
  options: {
    readonly payload?: unknown;
    readonly edits?: Readonly<Record<string, string>> | null;
  } | null | undefined = {}
): RealmReviewFileSlot[] {
  if (!template || typeof template !== 'object' || !template.seed || typeof template.seed !== 'object') return [];
  const files: readonly RealmTemplateSeedFile[] = Array.isArray(template.seed.files) ? template.seed.files : [];
  const agents = Array.isArray(template.agents) ? template.agents : [];
  const bodies = isRecord(bundleFiles) ? bundleFiles as Readonly<Record<string, string>> : {};
  const opts = isRecord(options) ? options : {};
  const edits: Readonly<Record<string, unknown>> = isRecord(opts.edits) ? opts.edits : {};
  const payloadByKey = payloadFilesByKey(opts.payload);

  const views: RealmReviewFileSlot[] = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || file.path.length === 0) continue;
    const origin: RealmContentOrigin = file.origin === 'user' || file.origin === 'generated'
      ? file.origin
      : 'fixed';
    let targetKind: 'realm' | 'agent' = 'realm';
    let targetKey = '';
    let targetLabel = 'Realm-global workspace';
    if (isRecord(file.target) && typeof file.target.agent === 'string') {
      targetKind = 'agent';
      targetKey = file.target.agent;
      const agent = agents.find((entry) => entry && entry.key === targetKey) ?? null;
      targetLabel = agent && typeof agent.name === 'string' && agent.name.length > 0
        ? `${agent.name} (${targetKey})`
        : targetKey;
    }
    const key = realmReviewSlotKey(file.target, file.path);
    const edited = Object.prototype.hasOwnProperty.call(edits, key) && typeof own(edits, key) === 'string';

    let content = '';
    let contentSource: RealmReviewFileSlot['contentSource'] = 'absent';
    let sourceLabel = 'not attached';
    if (origin === 'fixed') {
      const source = file.source as { readonly inline?: unknown; readonly file?: unknown } | undefined;
      const inlineValue = source?.inline;
      const fileRef = source?.file;
      if (typeof inlineValue === 'string') {
        content = inlineValue;
        contentSource = 'bundle-inline';
        sourceLabel = 'inline bundle content';
      } else if (typeof fileRef === 'string') {
        if (Object.prototype.hasOwnProperty.call(bodies, fileRef)) {
          content = bodies[fileRef];
          contentSource = 'bundle-file';
          sourceLabel = `bundle file ${fileRef}`;
        } else {
          contentSource = 'bundle-missing';
          sourceLabel = `bundle file ${fileRef} (missing)`;
        }
      } else {
        sourceLabel = 'bundle content';
      }
    } else if (edited) {
      content = String(own(edits, key));
      contentSource = 'review';
      sourceLabel = 'edited in review';
    } else if (payloadByKey.has(key)) {
      content = payloadByKey.get(key) ?? '';
      contentSource = 'payload';
      sourceLabel = 'attached payload';
    }

    views.push({
      key,
      path: file.path,
      targetKind,
      targetKey,
      targetLabel,
      origin,
      brief: typeof file.brief === 'string' ? file.brief : '',
      required: origin === 'generated',
      editable: origin !== 'fixed',
      content,
      contentSource,
      sourceLabel,
      edited
    });
  }
  return views;
}

// ============================================================================
// Payload attachment
// ============================================================================

/**
 * Parses one local payload file into a candidate hydration package.
 *
 * The text must be a JSON object; structural validation against the template
 * happens through {@link previewRealmReviewPackage}, so a parse success is
 * never a validation success.
 *
 * @param text - File text.
 * @returns The parsed record, or one inline error.
 */
export function parseRealmPayloadFileText(text: unknown): {
  readonly ok: boolean;
  readonly value: Record<string, unknown> | null;
  readonly error: string;
} {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, value: null, error: 'The payload file is empty.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: `The payload file is not valid JSON (${messageOf(error) || 'parse failed'}).`
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, value: null, error: 'The payload file must contain a JSON object.' };
  }
  return { ok: true, value: parsed, error: '' };
}

/**
 * Builds a safe download/display filename for one payload.
 *
 * @param templateId - Template id the payload targets.
 * @returns `<sanitized-id>.package.json`.
 */
export function buildRealmPayloadFilename(templateId: unknown): string {
  const raw = typeof templateId === 'string' ? templateId.trim() : '';
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  return `${safe.length > 0 ? safe : 'realm-template'}.package.json`;
}

/**
 * Serializes one pending hydration-package candidate as pretty-printed JSON.
 *
 * `null`/`undefined` serialize to the `null` literal, and a payload
 * `JSON.stringify` cannot represent (a circular reference, a `BigInt`) falls
 * back to the same literal instead of throwing — the download control always
 * writes parseable JSON.
 *
 * @param payload - Candidate payload value.
 * @returns Pretty-printed JSON text with a trailing newline.
 *
 * @example
 * ```typescript
 * serializeRealmPendingPayload({ formatVersion: 1 }); // '{\n  "formatVersion": 1\n}\n'
 * ```
 */
export function serializeRealmPendingPayload(payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload, null, 2);
  } catch {
    // Malformed payloads (circular references, BigInt) degrade to `null`.
    json = undefined;
  }
  return `${json ?? 'null'}\n`;
}

/**
 * One pending instance payload (session candidate) rendered for the attach
 * control.
 */
export interface RealmPendingPayloadView {
  /** Template id the candidate targets. */
  readonly templateId: string;
  /** Effective template version the candidate was validated against. */
  readonly templateVersion: string;
  /** Raw resolution timestamp. */
  readonly resolvedAt: string;
  /** Display label (`3 inputs · 2 files · resolved <time>`). */
  readonly summary: string;
  /** Well-formed file entry count. */
  readonly fileCount: number;
  /** String-valued input entry count. */
  readonly inputCount: number;
}

/**
 * Builds the pending-candidate rows for one template id.
 *
 * @param templateId - Selected template id (blank → no rows).
 * @param pending - Session candidate list (`listPendingInstancePayloads()`).
 * @param formatTimestamp - Timestamp formatter (the launcher passes `formatRealmLaunchTimestamp`).
 * @returns Candidate views in list order.
 */
export function buildRealmPendingPayloadViews(
  templateId: unknown,
  pending: readonly unknown[] | null | undefined,
  formatTimestamp: (value: unknown) => string
): RealmPendingPayloadView[] {
  const id = typeof templateId === 'string' ? templateId.trim() : '';
  if (!id || !Array.isArray(pending)) return [];
  const views: RealmPendingPayloadView[] = [];
  for (const entry of pending) {
    if (!isRecord(entry) || entry.templateId !== id) continue;
    const payload = isRecord(entry.payload) ? entry.payload : {};
    const files = Array.isArray(payload.files) ? payload.files : [];
    const inputs = isRecord(payload.inputs) ? payload.inputs : {};
    const fileCount = files.filter((file) => (
      isRecord(file) && typeof file.path === 'string' && typeof file.content === 'string'
    )).length;
    const inputCount = Object.values(inputs).filter((value) => typeof value === 'string').length;
    const templateVersion = typeof entry.templateVersion === 'string' ? entry.templateVersion : '';
    const resolvedAt = typeof entry.resolvedAt === 'string' ? entry.resolvedAt : '';
    views.push({
      templateId: id,
      templateVersion,
      resolvedAt,
      summary: `${inputCount} input${inputCount === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'} · resolved ${formatTimestamp(resolvedAt)}`,
      fileCount,
      inputCount
    });
  }
  return views;
}

/**
 * Result of assembling the review's attach package.
 */
export interface RealmReviewPackageAssembly {
  /** Whether a package travels with the launch. */
  readonly attached: boolean;
  /** The package to attach (`null` when nothing is attached). */
  readonly package: Readonly<Record<string, unknown>> | null;
  /** Number of file entries the package carries. */
  readonly fileCount: number;
}

/**
 * Assembles the package the review attaches at launch.
 *
 * With a source package (a candidate or a local file) and no review file
 * edits, the source is attached verbatim — the recorded package digest then
 * matches exactly what the hydrator submitted. As soon as a slot is edited,
 * the package is rebuilt from the reviewed slots: every `user`/`generated`
 * slot with payload content or a review edit contributes one entry, source
 * inputs and provenance are preserved, and `fixed` slots are never included
 * (the format forbids them). A review with no source and no edits attaches
 * nothing.
 *
 * @param options - Template identity/version, source package, slots, and edited slot keys.
 * @returns The assembly; field order never depends on input order for the same slots.
 */
export function assembleRealmReviewPackage(options: {
  readonly templateId: unknown;
  readonly templateVersion: unknown;
  readonly source?: unknown;
  readonly slots?: readonly RealmReviewFileSlot[] | null;
}): RealmReviewPackageAssembly {
  const templateId = typeof options?.templateId === 'string' ? options.templateId : '';
  const templateVersion = typeof options?.templateVersion === 'string' ? options.templateVersion : '';
  const source = isRecord(options?.source) ? options.source : null;
  const slots = Array.isArray(options?.slots) ? options.slots : [];
  const edited = slots.some((slot) => slot && slot.edited === true && slot.origin !== 'fixed');

  if (!templateId || !templateVersion) {
    return { attached: false, package: null, fileCount: 0 };
  }
  if (source && !edited) {
    const fileCount = Array.isArray(source.files) ? source.files.length : 0;
    return { attached: true, package: source, fileCount };
  }

  const files: Array<{ path: string; target: unknown; content: string }> = [];
  for (const slot of slots) {
    if (!slot || slot.origin === 'fixed') continue;
    const contributes = slot.edited === true || slot.contentSource === 'payload';
    if (!contributes) continue;
    files.push({
      path: slot.path,
      target: slot.targetKind === 'agent' ? { agent: slot.targetKey } : 'realm',
      content: slot.content
    });
  }
  const inputs = isRecord(source?.inputs) ? { ...source.inputs } : undefined;
  const provenance = isRecord(source?.provenance) ? { ...source.provenance } : undefined;
  const packageValue: Record<string, unknown> = {
    formatVersion: 1,
    templateId,
    templateVersion,
    ...(inputs !== undefined ? { inputs } : {}),
    files,
    ...(provenance !== undefined ? { provenance } : {})
  };
  if (!source && files.length === 0) {
    return { attached: false, package: null, fileCount: 0 };
  }
  return { attached: true, package: packageValue, fileCount: files.length };
}

/**
 * Review projection of one attached package.
 */
export interface RealmReviewPackagePreview {
  /** Whether the package validates against the effective template. */
  readonly ok: boolean;
  /** Review warnings (an allowed version mismatch). */
  readonly warnings: readonly string[];
  /** Whether the package pins a different template version. */
  readonly mismatch: boolean;
  /** User-facing failure text; empty when `ok` is true. */
  readonly error: string;
  /** Stable error code of a failure (empty when none). */
  readonly code: string;
}

/**
 * Validates one attached package against the effective template for review.
 *
 * The package is validated through the real `validateHydrationPackage` with
 * `allowVersionMismatch: true`, so a version mismatch surfaces as a review
 * warning plus the `mismatch` flag (the launcher then requires explicit
 * confirmation before launch passes the flag); every other contract failure is
 * reported inline with its typed code.
 *
 * @param template - Effective template.
 * @param value - Attached package (`null`/`undefined` → valid empty preview).
 * @param options - Effective bundle `currentVersion`.
 * @returns The preview; failures are inline, never thrown.
 */
export function previewRealmReviewPackage(
  template: RealmTemplate | null | undefined,
  value: unknown,
  options: { readonly currentVersion?: string | null } | null | undefined = {}
): RealmReviewPackagePreview {
  if (value === null || value === undefined) {
    return { ok: true, warnings: [], mismatch: false, error: '', code: '' };
  }
  if (!template || typeof template !== 'object') {
    return { ok: false, warnings: [], mismatch: false, error: 'Select a template before attaching a payload.', code: '' };
  }
  const currentVersion = typeof options?.currentVersion === 'string' && options.currentVersion.length > 0
    ? options.currentVersion
    : undefined;
  try {
    const resolved = validateHydrationPackage(template, value, {
      allowVersionMismatch: true,
      ...(currentVersion !== undefined ? { currentVersion } : {})
    });
    const warnings = resolved.warnings;
    return {
      ok: true,
      warnings: [...warnings],
      mismatch: warnings.length > 0,
      error: '',
      code: ''
    };
  } catch (error) {
    return {
      ok: false,
      warnings: [],
      mismatch: false,
      error: messageOf(error) || 'The attached payload is not valid for this template.',
      code: codeOf(error)
    };
  }
}

// ============================================================================
// Authority approvals
// ============================================================================

/**
 * One declared publishing authority rendered for review.
 */
export interface RealmAuthorityView {
  /** Authority id as declared (`@template:authority` / `@hydration:authority`). */
  readonly authority: string;
  /** Short display label. */
  readonly label: string;
  /** Plain-language description of what the authority allows. */
  readonly description: string;
  /** Whether this host knows and can enforce the id. */
  readonly known: boolean;
}

/**
 * Describes one authority id for the review UI.
 *
 * @param authority - Authority id (unknown ids stay visible and are flagged).
 * @returns The display view; unknown ids render their raw value.
 *
 * @example
 * ```typescript
 * describeRealmAuthority('@hydration:authority').label; // 'Hydration publishing'
 * ```
 */
export function describeRealmAuthority(authority: unknown): RealmAuthorityView {
  const id = typeof authority === 'string' ? authority : '';
  if (id === AGENT_AUTHORITIES.TEMPLATE) {
    return {
      authority: id,
      label: 'Template publishing',
      description: 'Import realm template bundles into the host catalog.',
      known: true
    };
  }
  if (id === AGENT_AUTHORITIES.HYDRATION) {
    return {
      authority: id,
      label: 'Hydration publishing',
      description: 'Submit validated instance payloads (hydration candidates) for review.',
      known: true
    };
  }
  return {
    authority: id,
    label: id || 'Unknown authority',
    description: 'Not known to this host — a launch declaring it fails closed.',
    known: false
  };
}

/**
 * One template agent's declared-authority disclosure.
 */
export interface RealmAuthorityReviewAgent {
  /** Template agent key. */
  readonly key: string;
  /** Display name. */
  readonly name: string;
  /** Role/archetype. */
  readonly role: string;
  /** Whether the agent launches privileged (disclosed separately from these requests). */
  readonly privileged: boolean;
  /** Declared requests in declaration order, deduplicated. */
  readonly declarations: readonly RealmAuthorityView[];
  /** Declared ids this host cannot enforce (launch fails closed). */
  readonly unknownAuthorities: readonly RealmAuthorityView[];
}

/**
 * Builds the per-agent declared-authority disclosure rows.
 *
 * @param template - Selected template (structural; malformed specs skipped).
 * @returns One row per agent carrying at least one declaration, in template order.
 */
export function buildRealmAuthorityReviewAgents(
  template: RealmTemplate | null | undefined
): RealmAuthorityReviewAgent[] {
  if (!template || typeof template !== 'object' || !Array.isArray(template.agents)) return [];
  const rows: RealmAuthorityReviewAgent[] = [];
  for (const spec of template.agents) {
    if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') continue;
    const declared = Array.isArray(spec.authorities)
      ? spec.authorities.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
    const unique = [...new Set(declared)];
    if (unique.length === 0) continue;
    const declarations = unique.map((entry) => describeRealmAuthority(entry));
    rows.push({
      key: spec.key,
      name: typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : spec.key,
      role: typeof spec.role === 'string' ? spec.role : '',
      privileged: spec.privileged === true,
      declarations,
      unknownAuthorities: declarations.filter((entry) => !entry.known)
    });
  }
  return rows;
}

/**
 * Review decision for one declared `(agentKey, authority)` pair.
 *
 * `trusted` marks a pair auto-approved by a persisted template trust record
 * (rendered checked and locked — clearing the trust re-prompts); `approved`
 * and `declined` are explicit operator decisions; absent = declined.
 */
export type RealmAuthorityDecision = 'approved' | 'declined' | 'trusted';

/**
 * Builds the decision-map key for one declared pair.
 *
 * @param agentKey - Template agent key.
 * @param authority - Authority id.
 * @returns `${agentKey}::${authority}`.
 */
export function buildRealmAuthorityDecisionKey(agentKey: unknown, authority: unknown): string {
  return `${typeof agentKey === 'string' ? agentKey : ''}::${typeof authority === 'string' ? authority : ''}`;
}

/**
 * Builds the initial review decisions for one template: every declared pair
 * starts declined unless a persisted trust record already covers exactly that
 * `(agentKey, authority)` pair, which renders `trusted` (auto-approved).
 *
 * @param template - Selected template.
 * @param trustRecord - Persisted trust record for this template id (`null` when none).
 * @returns Decision map keyed by {@link buildRealmAuthorityDecisionKey}.
 */
export function buildRealmAuthorityDecisions(
  template: RealmTemplate | null | undefined,
  trustRecord: Readonly<Record<string, readonly string[]>> | null | undefined
): Record<string, RealmAuthorityDecision> {
  const decisions: Record<string, RealmAuthorityDecision> = {};
  if (!template || typeof template !== 'object' || !Array.isArray(template.agents)) return decisions;
  const trust = isRecord(trustRecord) ? trustRecord : {};
  for (const spec of template.agents) {
    if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') continue;
    const declared = Array.isArray(spec.authorities)
      ? spec.authorities.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
    for (const authority of new Set(declared)) {
      const trusted = Array.isArray(trust[spec.key]) && (trust[spec.key] as readonly string[]).includes(authority);
      decisions[buildRealmAuthorityDecisionKey(spec.key, authority)] = trusted ? 'trusted' : 'declined';
    }
  }
  return decisions;
}

/**
 * Assembles the `authorityApprovals` payload from the review decisions.
 *
 * Only checked pairs — explicit approvals and trust-auto-approved pairs —
 * travel; declined and unknown-decision pairs are omitted (absent = declined).
 * Order follows template agent order and declaration order.
 *
 * @param template - Selected template.
 * @param decisions - Decision map from {@link buildRealmAuthorityDecisions} (edited by the review).
 * @returns Approval pairs for `launchRealmFromTemplate({ authorityApprovals })`.
 */
export function assembleRealmAuthorityApprovals(
  template: RealmTemplate | null | undefined,
  decisions: Readonly<Record<string, RealmAuthorityDecision>> | null | undefined
): Array<{ agentKey: string; authority: string }> {
  const approvals: Array<{ agentKey: string; authority: string }> = [];
  if (!template || typeof template !== 'object' || !Array.isArray(template.agents)) return approvals;
  const map = isRecord(decisions) ? decisions : {};
  for (const spec of template.agents) {
    if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') continue;
    const declared = Array.isArray(spec.authorities)
      ? spec.authorities.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
    for (const authority of new Set(declared)) {
      const decision = map[buildRealmAuthorityDecisionKey(spec.key, authority)];
      if (decision === 'approved' || decision === 'trusted') {
        approvals.push({ agentKey: spec.key, authority });
      }
    }
  }
  return approvals;
}

/**
 * Trust-control display model for one template.
 */
export interface RealmAuthorityTrustView {
  /** Whether a persisted trust record exists for this template. */
  readonly trusted: boolean;
  /** Trusted pairs that are still declared, in declaration order. */
  readonly pairs: readonly { readonly agentKey: string; readonly authority: string; readonly label: string }[];
  /** Trusted pairs whose authority is no longer declared (stale; never auto-approve). */
  readonly stalePairs: readonly { readonly agentKey: string; readonly authority: string; readonly label: string }[];
  /** One-line status copy. */
  readonly summary: string;
}

/**
 * Builds the "trust this template" display model: which previously approved
 * exact pairs still match the template's declarations (those auto-approve)
 * and which are stale (a delta re-prompts; stale pairs never approve).
 *
 * @param template - Selected template.
 * @param trustRecord - Persisted trust record for this template id (`null` when none).
 * @returns The trust view; `trusted: false` with empty pairs when no record exists.
 */
export function describeRealmAuthorityTrust(
  template: RealmTemplate | null | undefined,
  trustRecord: Readonly<Record<string, readonly string[]>> | null | undefined
): RealmAuthorityTrustView {
  const empty: RealmAuthorityTrustView = { trusted: false, pairs: [], stalePairs: [], summary: '' };
  if (!template || typeof template !== 'object' || !Array.isArray(template.agents)) return empty;
  const trust = isRecord(trustRecord) ? trustRecord : null;
  if (!trust || Object.keys(trust).length === 0) return empty;

  const declared = new Map<string, Set<string>>();
  for (const spec of template.agents) {
    if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') continue;
    const entries = Array.isArray(spec.authorities)
      ? spec.authorities.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
    declared.set(spec.key, new Set(entries));
  }

  const pairs: Array<{ agentKey: string; authority: string; label: string }> = [];
  const stalePairs: Array<{ agentKey: string; authority: string; label: string }> = [];
  for (const [agentKey, authorities] of Object.entries(trust)) {
    if (!Array.isArray(authorities)) continue;
    const declaredForAgent = declared.get(agentKey) ?? new Set<string>();
    for (const authority of authorities) {
      if (typeof authority !== 'string' || authority.length === 0) continue;
      const view = describeRealmAuthority(authority);
      if (declaredForAgent.has(authority)) {
        pairs.push({ agentKey, authority, label: view.label });
      } else {
        stalePairs.push({ agentKey, authority, label: view.label });
      }
    }
  }
  if (pairs.length === 0 && stalePairs.length === 0) return empty;
  const matches = `${pairs.length} exact pair${pairs.length === 1 ? '' : 's'}`;
  const stale = stalePairs.length > 0
    ? ` ${stalePairs.length} trusted pair${stalePairs.length === 1 ? '' : 's'} no longer declared re-prompt.`
    : '';
  return {
    trusted: true,
    pairs,
    stalePairs,
    summary: `Trusted for ${matches} — those auto-approve at launch; any newly declared authority re-prompts.${stale}`
  };
}

// ============================================================================
// Launch gate
// ============================================================================

/**
 * Review/launch readiness state.
 */
export interface RealmLaunchGateState {
  /** Whether the operator acknowledged the mandatory review. */
  readonly reviewed: boolean;
  /** Preview/composition failure text (empty when none). */
  readonly previewError: string;
  /** Attached-payload validation failure text (empty when none). */
  readonly payloadError: string;
  /** Whether an attached payload pins a different version and the confirmation is unchecked. */
  readonly mismatchUnconfirmed: boolean;
  /** Declared authority ids unknown to this host (the launch fails closed on them). */
  readonly unknownAuthorities: readonly string[];
}

/**
 * Launch-gate projection: whether the launch button is disabled and why.
 *
 * The gate never replaces fail-closed store validation — it surfaces the same
 * conditions before the call so an operator never has to learn them from a
 * rejected launch: unknown declared authorities fail closed, an invalid
 * attached payload fails closed, an unconfirmed version mismatch fails closed,
 * an unbuildable preview fails closed, and the mandatory review must be
 * acknowledged.
 *
 * @param state - Review readiness state.
 * @returns `{ disabled, hint }`; `hint` is empty when the launch is available.
 */
export function describeRealmLaunchGate(state: RealmLaunchGateState): {
  readonly disabled: boolean;
  readonly hint: string;
} {
  if (Array.isArray(state.unknownAuthorities) && state.unknownAuthorities.length > 0) {
    return {
      disabled: true,
      hint: `Launch is refused: this host cannot enforce the declared authorit${state.unknownAuthorities.length === 1 ? 'y' : 'ies'} ${state.unknownAuthorities.join(', ')}.`
    };
  }
  if (state.payloadError) {
    return { disabled: true, hint: `Fix the attached payload before launching: ${state.payloadError}` };
  }
  if (state.mismatchUnconfirmed) {
    return {
      disabled: true,
      hint: 'The attached payload pins a different template version — confirm the mismatch to launch.'
    };
  }
  if (state.previewError) {
    return { disabled: true, hint: state.previewError };
  }
  if (!state.reviewed) {
    return {
      disabled: true,
      hint: 'Confirm the review above (composed prompts, file contents, and declared authorities) to enable the launch.'
    };
  }
  return { disabled: false, hint: '' };
}

// ============================================================================
// Operator publishing-authority toggles (agent settings)
// ============================================================================

/**
 * One operator publishing-authority toggle definition.
 */
export interface MetaAuthorityToggleDefinition {
  /** Authority id. */
  readonly authority: string;
  /** Short display label. */
  readonly label: string;
  /** Plain-language description. */
  readonly description: string;
}

/**
 * The two operator publishing-authority toggles, in display order.
 */
export const META_AUTHORITY_TOGGLES: readonly MetaAuthorityToggleDefinition[] = Object.freeze([
  Object.freeze({
    authority: AGENT_AUTHORITIES.TEMPLATE,
    label: 'Template publishing',
    description: 'Import realm template bundles into the host catalog.'
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.HYDRATION,
    label: 'Hydration publishing',
    description: 'Submit validated instance payloads (hydration candidates) for review.'
  })
]);

/**
 * Live toggle state of one agent's publishing authorities.
 */
export interface MetaAuthorityToggleState {
  /** Whether the agent holds `@template:authority`. */
  readonly template: boolean;
  /** Whether the agent holds `@hydration:authority`. */
  readonly hydration: boolean;
}

/**
 * Projects the operator grant listing onto one agent's canonical identity key.
 *
 * @param listing - `listMetaAuthorityGrants()` result (canonical identity keys).
 * @param agentKey - Target agent's canonical identity key (`createAgentIdentityKey(realmId, id)`).
 * @returns Live toggle state; malformed listings read as ungranted.
 */
export function buildMetaAuthorityToggleState(
  listing: { readonly template?: readonly string[]; readonly hydration?: readonly string[] } | null | undefined,
  agentKey: unknown
): MetaAuthorityToggleState {
  const key = typeof agentKey === 'string' ? agentKey : '';
  const template = Array.isArray(listing?.template) && key.length > 0 ? listing.template.includes(key) : false;
  const hydration = Array.isArray(listing?.hydration) && key.length > 0 ? listing.hydration.includes(key) : false;
  return { template, hydration };
}

/**
 * Narrow structural host the toggle calls go through: the real store
 * satisfies it, and tests exercise it with a real store instance.
 */
export interface MetaAuthorityGrantHost {
  /** Grant `@template:authority` to one active agent. */
  grantTemplateAuthority(agentId: string, scope?: { readonly realmId?: string | null }): Promise<unknown>;
  /** Revoke `@template:authority` from one active agent. */
  revokeTemplateAuthority(agentId: string, scope?: { readonly realmId?: string | null }): Promise<unknown>;
  /** Grant `@hydration:authority` to one active agent. */
  grantHydrationAuthority(agentId: string, scope?: { readonly realmId?: string | null }): Promise<unknown>;
  /** Revoke `@hydration:authority` from one active agent. */
  revokeHydrationAuthority(agentId: string, scope?: { readonly realmId?: string | null }): Promise<unknown>;
}

/**
 * One toggle activation: enable/disable one authority for one active agent.
 */
export interface MetaAuthorityToggleRequest {
  /** Active agent id (bare, realm-local). */
  readonly agentId: string;
  /** Authority id (`@template:authority` / `@hydration:authority`). */
  readonly authority: string;
  /** Whether the toggle should end enabled. */
  readonly enabled: boolean;
  /** Trusted realm scope for exact `(realmId, agentId)` resolution (`null` = system scope). */
  readonly realmId?: string | null;
}

/**
 * Applies one publishing-authority toggle through the injected host.
 *
 * The call is realm-exact when `realmId` is supplied (including `null` for the
 * director's system scope), so a same-literal-id agent in another Realm is
 * never retargeted. Failures come back inline; the caller re-reads the live
 * listing and re-renders.
 *
 * @param host - Grant host (the real `sandboxStore` satisfies it).
 * @param request - Toggle activation.
 * @returns `{ ok, error }`; `ok` means the call completed, not that the toggle reads enabled.
 */
export async function applyMetaAuthorityToggle(
  host: MetaAuthorityGrantHost | null | undefined,
  request: MetaAuthorityToggleRequest
): Promise<{ readonly ok: boolean; readonly error: string }> {
  const agentId = typeof request?.agentId === 'string' ? request.agentId.trim() : '';
  const authority = typeof request?.authority === 'string' ? request.authority : '';
  if (!host || !agentId || authority.length === 0) {
    return { ok: false, error: 'The authority toggle needs an active agent and a known authority.' };
  }
  const scope = { realmId: request.realmId ?? null };
  try {
    let descriptor: unknown;
    if (authority === AGENT_AUTHORITIES.TEMPLATE) {
      descriptor = request.enabled
        ? await host.grantTemplateAuthority(agentId, scope)
        : await host.revokeTemplateAuthority(agentId, scope);
    } else if (authority === AGENT_AUTHORITIES.HYDRATION) {
      descriptor = request.enabled
        ? await host.grantHydrationAuthority(agentId, scope)
        : await host.revokeHydrationAuthority(agentId, scope);
    } else {
      return { ok: false, error: `Unknown publishing authority "${authority}".` };
    }
    if (descriptor === null || descriptor === undefined) {
      return {
        ok: false,
        error: `No active agent matched "${agentId}" in the selected realm — it may have been killed or recycled.`
      };
    }
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: messageOf(error) || 'The authority change was rejected.' };
  }
}

// ============================================================================
// Preview disclosures
// ============================================================================

/**
 * One preview-disclosure row for an agent spec.
 */
export interface RealmAgentDisclosureRow {
  /** Stable row key. */
  readonly key: 'initialPrompt' | 'triggerPolicy' | 'modelPresetId' | 'privileged';
  /** Display label. */
  readonly label: string;
  /** Display value (`'—'` when absent). */
  readonly value: string;
  /** Whether the declared field is present. */
  readonly present: boolean;
}

/**
 * Builds the per-agent disclosure rows the review must show (Wave T carry-over
 * plus Wave U): `initialPrompt` (the text that triggers the first turn),
 * `triggerPolicy` (display-only label), `modelPresetId` (declared binding), and
 * `privileged` (elevated privilege).
 *
 * @param spec - Agent spec (structural; missing fields render absent rows).
 * @param presetBindingLabel - Optional resolved binding label from the preset display model.
 * @returns Rows in a stable order; never throws.
 */
export function buildRealmAgentDisclosureRows(
  spec: RealmAgentSpec | null | undefined,
  presetBindingLabel?: string | null
): RealmAgentDisclosureRow[] {
  const record: Record<string, unknown> = isRecord(spec) ? (spec as unknown as Record<string, unknown>) : {};
  const initialPrompt = typeof record.initialPrompt === 'string' ? record.initialPrompt : '';
  const triggerPolicy = typeof record.triggerPolicy === 'string' ? record.triggerPolicy : '';
  const modelPresetId = typeof record.modelPresetId === 'string' ? record.modelPresetId : '';
  const privileged = record.privileged === true;
  const binding = typeof presetBindingLabel === 'string' && presetBindingLabel.length > 0
    ? presetBindingLabel
    : modelPresetId;
  return [
    {
      key: 'initialPrompt',
      label: 'Initial prompt',
      value: initialPrompt.length > 0 ? initialPrompt : '—',
      present: initialPrompt.length > 0
    },
    {
      key: 'triggerPolicy',
      label: 'Trigger policy',
      value: triggerPolicy.length > 0 ? triggerPolicy : '—',
      present: triggerPolicy.length > 0
    },
    {
      key: 'modelPresetId',
      label: 'Model preset',
      value: binding.length > 0 ? binding : 'catalog default',
      present: binding.length > 0
    },
    {
      key: 'privileged',
      label: 'Privileged',
      value: privileged ? 'yes — sudo authority' : 'no',
      present: true
    }
  ];
}

/**
 * The effective review input values for previews: explicit review edits win,
 * then the attached payload's values, then nothing (the catalog resolves the
 * declared default).
 *
 * @param drafts - Review input drafts.
 * @param payload - Attached payload (its `inputs` record; string values only).
 * @returns Preview values keyed by input id.
 */
export function buildRealmReviewInputValues(
  drafts: readonly { readonly id: string; readonly value?: unknown; readonly dirty?: unknown }[] | null | undefined,
  payload: unknown
): Record<string, string> {
  const values: Record<string, string> = {};
  const payloadValues = payloadInputValues(payload);
  if (Array.isArray(drafts)) {
    for (const draft of drafts) {
      if (!draft || typeof draft.id !== 'string' || draft.id.length === 0) continue;
      if (draft.dirty === true) {
        values[draft.id] = typeof draft.value === 'string' ? draft.value : '';
      }
    }
  }
  for (const [inputId, value] of Object.entries(payloadValues)) {
    if (!Object.prototype.hasOwnProperty.call(values, inputId)) values[inputId] = value;
  }
  return values;
}

/**
 * Resolves the value one input field displays: an explicit edit, else the
 * attached payload's value, else the draft's prefill.
 *
 * @param draft - Review input draft.
 * @param payload - Attached payload.
 * @returns The display value.
 */
export function resolveRealmReviewInputDisplay(
  draft: { readonly id?: unknown; readonly value?: unknown; readonly dirty?: unknown } | null | undefined,
  payload: unknown
): string {
  if (!draft || typeof draft.id !== 'string' || draft.id.length === 0) return '';
  if (draft.dirty === true) return typeof draft.value === 'string' ? draft.value : '';
  const payloadValues = payloadInputValues(payload);
  if (Object.prototype.hasOwnProperty.call(payloadValues, draft.id)) return payloadValues[draft.id];
  return typeof draft.value === 'string' ? draft.value : '';
}

/**
 * Known-authority vocabulary for callers that only need the v1 ids.
 */
export function knownRealmAuthorities(): readonly string[] {
  return KNOWN_AGENT_AUTHORITIES;
}

/**
 * The reconciliation-safe input values payload for the launch call: explicit
 * review edits only (untouched fields stay out so the attached payload's
 * values, then the declared defaults, apply).
 *
 * @param drafts - Review input drafts.
 * @returns `inputValues` payload.
 */
export function assembleRealmReviewLaunchInputValues(
  drafts: readonly { readonly id: string; readonly value?: unknown; readonly dirty?: unknown }[] | null | undefined
): RealmInputValues {
  const values: Record<string, string> = {};
  if (!Array.isArray(drafts)) return values;
  for (const draft of drafts) {
    if (!draft || typeof draft.id !== 'string' || draft.id.length === 0) continue;
    if (draft.dirty === true) values[draft.id] = typeof draft.value === 'string' ? draft.value : '';
  }
  return values;
}
