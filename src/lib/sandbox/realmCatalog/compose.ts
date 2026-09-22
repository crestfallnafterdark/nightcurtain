/**
 * Prompt/history composition and seed resolution for the `realmCatalog`
 * module: turns a template's declared prompt parts, history entries, inputs,
 * and seed manifest into the composed system prompt, the composed baked
 * history, the input provenance, and the resolved seed carried by a launch
 * plan.
 *
 * Every helper is pure and fail-closed: missing bundle entries, undeclared
 * input references, required inputs that resolve empty, history entries that
 * compose empty, malformed option records, mismatched hydration files, and
 * composition-cap violations throw descriptive `Error`s.
 */

import { deepFreeze } from './freeze.ts';
import { REALM_CATALOG_ERROR_CODES, RealmCatalogError, toCatalogError } from './errors.ts';
import {
  MAX_COMPOSED_PROMPT_CHARS,
  isPlainRecord,
  requireNonEmptyString,
  requireSafePath,
  rejectUnknownFields,
  seedSlotKey,
  validateAgentHistory,
  validatePromptParts,
  validateSeedManifest,
  validateSeedTarget,
  validateTemplateInputs
} from './validation.ts';
import type {
  BundleFiles,
  PromptPart,
  RealmAgentSpec,
  RealmComposeOptions,
  RealmComposedPrompt,
  RealmHistoryEntry,
  RealmHistoryMessage,
  RealmInputProvenance,
  RealmInputValues,
  RealmInputValueSource,
  RealmResolvedSeed,
  RealmResolvedSeedFile,
  RealmSeedManifest,
  RealmTemplateInput,
  ResolvedHydrationFile
} from './types.ts';

/** Separator inserted between contributing prompt pieces. */
const PART_SEPARATOR = '\n\n';

/** Canonical hydration-file entry field names (closed shape). */
const HYDRATION_FILE_FIELDS: ReadonlySet<string> = new Set(['path', 'target', 'content']);

/**
 * Validates an optional record of string values (option plumbing, not
 * template data).
 *
 * @param candidate - Candidate record
 * @param label - Human-readable label used in error messages
 * @returns The validated record (empty when absent)
 */
function validateStringRecord(candidate: unknown, label: string): Record<string, string> {
  if (candidate === undefined) return {};
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be a record of string values`);
  }
  for (const key of Object.keys(candidate)) {
    if (typeof candidate[key] !== 'string') {
      throw new Error(`${label}['${key}'] must be a string`);
    }
  }
  return candidate as Record<string, string>;
}

/**
 * Resolves one declared input's value and provenance.
 *
 * An explicit launch value wins even when empty (an emptied field is an
 * author/user decision, not an absent one); otherwise the declared `default`,
 * then the `defaultFile` bundle entry, then the empty string. A referenced
 * `defaultFile` whose bundle entry is missing fails closed.
 *
 * @param declaration - Declared input being resolved
 * @param inputValues - Validated launch values keyed by input id
 * @param bundleFiles - Validated bundle bodies keyed by bundle-relative path
 * @param label - Human-readable label used in error messages
 * @returns The resolved value plus its provenance source
 */
export function resolveDeclaredInputValue(
  declaration: RealmTemplateInput,
  inputValues: Record<string, string>,
  bundleFiles: Record<string, string>,
  label: string
): { value: string; source: RealmInputValueSource } {
  if (Object.prototype.hasOwnProperty.call(inputValues, declaration.id)) {
    return { value: inputValues[declaration.id], source: 'launch' };
  }
  if (declaration.default !== undefined) {
    return { value: declaration.default, source: 'default' };
  }
  if (declaration.defaultFile !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
      throw new Error(`${label} defaultFile '${declaration.defaultFile}' is not present in the bundle files`);
    }
    return { value: bundleFiles[declaration.defaultFile], source: 'defaultFile' };
  }
  return { value: '', source: 'empty' };
}

/**
 * Composes one agent's system prompt from its ordered prompt parts.
 *
 * Parts contribute in declared order: `text` verbatim, `file` bodies resolved
 * from `bundleFiles` (a missing entry fails closed), and `input` values
 * resolved launch → default → defaultFile → empty. An input that resolves
 * empty contributes nothing (unless declared `required`, which fails closed);
 * contributing pieces join with a blank line. The result carries one
 * provenance entry per referenced input, in first-reference order, recording
 * the id and source without duplicating the value text.
 *
 * @param parts - Ordered prompt parts (validated structurally here)
 * @param inputs - Declared template inputs referenced by `input` parts
 * @param options - Launch input values and bundle file bodies
 * @returns A deeply frozen composed prompt plus input provenance
 * @throws `Error` - When parts, inputs, options, references, or caps are invalid
 *
 * @example
 * ```typescript
 * import { composeSystemPrompt } from './realmCatalog/index.ts';
 *
 * const composed = composeSystemPrompt(
 *   [{ kind: 'text', text: 'Protocol.' }, { kind: 'input', inputId: 'directives' }],
 *   [{ id: 'directives', label: 'Directives' }],
 *   { inputValues: { directives: 'Be concise.' } }
 * );
 * // composed.systemPrompt === 'Protocol.\n\nBe concise.'
 * ```
 */
export function composeSystemPrompt(
  parts: readonly PromptPart[],
  inputs?: readonly RealmTemplateInput[],
  options: RealmComposeOptions = {}
): RealmComposedPrompt {
  const validatedParts = validatePromptParts(parts, 'composeSystemPrompt parts');
  const validatedInputs = validateTemplateInputs(inputs, 'composeSystemPrompt inputs') ?? [];
  if (!isPlainRecord(options)) {
    throw new Error('composeSystemPrompt options must be an object');
  }
  const inputValues = validateStringRecord(options.inputValues, 'composeSystemPrompt inputValues');
  const bundleFiles = validateStringRecord(options.bundleFiles, 'composeSystemPrompt bundleFiles');

  const inputsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    validatedInputs.map((input) => [input.id, input] as const)
  );
  for (const id of Object.keys(inputValues)) {
    if (!inputsById.has(id)) {
      throw new Error(`composeSystemPrompt inputValues names undeclared input '${id}'`);
    }
  }

  const pieces: string[] = [];
  const provenance: RealmInputProvenance[] = [];
  const seenInputs: Set<string> = new Set();

  for (const part of validatedParts) {
    if (part.kind === 'text') {
      pieces.push(part.text);
      continue;
    }
    if (part.kind === 'file') {
      if (!Object.prototype.hasOwnProperty.call(bundleFiles, part.path)) {
        throw new Error(`composeSystemPrompt prompt file '${part.path}' is not present in the bundle files`);
      }
      pieces.push(bundleFiles[part.path]);
      continue;
    }
    const declaration = inputsById.get(part.inputId);
    if (!declaration) {
      throw new Error(`composeSystemPrompt prompt references undeclared input '${part.inputId}'`);
    }
    const resolved = resolveDeclaredInputValue(
      declaration,
      inputValues,
      bundleFiles,
      `composeSystemPrompt input '${declaration.id}'`
    );
    if (!seenInputs.has(declaration.id)) {
      seenInputs.add(declaration.id);
      provenance.push({ inputId: declaration.id, source: resolved.source });
    }
    if (declaration.required === true && resolved.value.trim().length === 0) {
      throw new Error(`composeSystemPrompt input '${declaration.id}' is required and resolves empty`);
    }
    if (resolved.value.trim().length > 0) {
      pieces.push(resolved.value);
    }
  }

  const systemPrompt = pieces.join(PART_SEPARATOR);
  if (systemPrompt.length > MAX_COMPOSED_PROMPT_CHARS) {
    throw new Error(
      `composeSystemPrompt composed prompt is ${systemPrompt.length} characters; the cap is ${MAX_COMPOSED_PROMPT_CHARS}`
    );
  }

  return deepFreeze({ systemPrompt, inputProvenance: provenance });
}

/**
 * Validates an optional list of resolved hydration file entries (option
 * plumbing, not template data).
 *
 * @param candidate - Candidate entry list
 * @param label - Human-readable label used in error messages
 * @returns The validated entries (empty when absent)
 */
function validateHydrationFiles(candidate: unknown, label: string): readonly ResolvedHydrationFile[] {
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate)) {
    throw new Error(`${label} must be an array of hydration file entries`);
  }
  return candidate.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isPlainRecord(entry)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    rejectUnknownFields(entry, HYDRATION_FILE_FIELDS, entryLabel);
    const path = requireSafePath(entry.path, `${entryLabel} path`);
    const target = validateSeedTarget(entry.target, `${entryLabel} target`, undefined);
    if (typeof entry.content !== 'string') {
      throw new Error(`${entryLabel} content must be a string`);
    }
    return { path, target, content: entry.content };
  });
}

/**
 * Composes one history entry's content from its ordered parts.
 *
 * Parts contribute in declared order: `text` verbatim, `file` bodies resolved
 * from `files` (a missing entry fails closed), and `input` values resolved
 * from `inputs` (an absent or whitespace-only value contributes nothing).
 * Contributing pieces join with a blank line; an entry that contributes no
 * content is rejected rather than seeded as an empty message.
 *
 * @param entry - Validated history entry
 * @param inputs - Resolved input values keyed by declared input id
 * @param files - Bundle file bodies keyed by bundle-relative path
 * @param label - Human-readable label used in error messages
 * @returns The composed message
 */
function composeHistoryEntry(
  entry: RealmHistoryEntry,
  inputs: Record<string, string>,
  files: Record<string, string>,
  label: string
): RealmHistoryMessage {
  const pieces: string[] = [];
  for (const part of entry.content) {
    if (part.kind === 'text') {
      pieces.push(part.text);
      continue;
    }
    if (part.kind === 'file') {
      if (!Object.prototype.hasOwnProperty.call(files, part.path)) {
        throw new Error(`${label} references bundle file '${part.path}' which is not present in the bundle files`);
      }
      pieces.push(files[part.path]);
      continue;
    }
    const value = Object.prototype.hasOwnProperty.call(inputs, part.inputId) ? inputs[part.inputId] : '';
    if (value.trim().length > 0) {
      pieces.push(value);
    }
  }
  const content = pieces.join(PART_SEPARATOR);
  if (content.trim().length === 0) {
    throw new Error(`${label} composes empty — every declared history entry must contribute content`);
  }
  return { role: entry.role, content, source: 'template' };
}

/**
 * Composes one agent spec's declared baked history into launch messages.
 *
 * Entries compose in declared order using the same part model and separator as
 * prompts: `file` parts resolve from `files` (a missing entry fails closed),
 * `input` parts resolve from the supplied values (empty contributes nothing),
 * and an entry that composes empty is rejected. Every composed message carries
 * `source: 'template'` (host-side provenance for template-declared history);
 * seeding message ids and seeding itself belong to the runtime.
 *
 * @param spec - Agent spec whose `history` is composed
 * @param inputs - Resolved input values keyed by declared input id
 * @param files - Bundle file bodies keyed by bundle-relative path
 * @returns Deeply frozen composed messages in declared order (empty when no history)
 * @throws `Error` - When the spec, its history, the value/file records, a reference, or an empty entry is invalid
 *
 * @example
 * ```typescript
 * import { composeAgentHistory } from './realmCatalog/index.ts';
 *
 * const history = composeAgentHistory(
 *   { key: 'gm', history: [{ role: 'assistant', content: [{ kind: 'text', text: 'Rain hammers the roof.' }] }] },
 *   {},
 *   {}
 * );
 * // history[0].content === 'Rain hammers the roof.'
 * ```
 */
export function composeAgentHistory(
  spec: RealmAgentSpec,
  inputs: RealmInputValues,
  files: BundleFiles
): readonly RealmHistoryMessage[] {
  if (!isPlainRecord(spec)) {
    throw new RealmCatalogError('composeAgentHistory spec must be an object', REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }
  const key = requireNonEmptyString(spec.key, 'composeAgentHistory spec key');
  let inputValues: Record<string, string>;
  let fileBodies: Record<string, string>;
  let history: readonly RealmHistoryEntry[] | undefined;
  try {
    inputValues = validateStringRecord(inputs, 'composeAgentHistory inputs');
    fileBodies = validateStringRecord(files, 'composeAgentHistory files');
    history = validateAgentHistory(spec.history, `agent '${key}' history`);
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }
  const messages = (history ?? []).map((entry, index) => (
    composeHistoryEntry(entry, inputValues, fileBodies, `agent '${key}' history[${index}]`)
  ));
  return deepFreeze(messages);
}

/**
 * Resolves the input values a spec's declared history references.
 *
 * Each referenced input resolves with the same precedence as prompt parts —
 * explicit launch value (including hydration-provided values), then the
 * declared `default`, then the `defaultFile` bundle entry, then empty — so a
 * history opener sees exactly the value its prompt sibling would see.
 *
 * @param spec - Agent spec whose history references are resolved
 * @param inputs - Declared template inputs, when known
 * @param options - Launch input values and bundle file bodies
 * @returns A plain record of resolved values keyed by referenced input id
 * @throws `Error` - When the spec, declarations, options, or references are invalid
 */
export function resolveAgentHistoryInputValues(
  spec: RealmAgentSpec,
  inputs?: readonly RealmTemplateInput[],
  options: RealmComposeOptions = {}
): Record<string, string> {
  if (!isPlainRecord(spec)) {
    throw new Error('resolveAgentHistoryInputValues spec must be an object');
  }
  const key = requireNonEmptyString(spec.key, 'resolveAgentHistoryInputValues spec key');
  if (!isPlainRecord(options)) {
    throw new Error('resolveAgentHistoryInputValues options must be an object');
  }
  const inputValues = validateStringRecord(options.inputValues, 'resolveAgentHistoryInputValues inputValues');
  const bundleFiles = validateStringRecord(options.bundleFiles, 'resolveAgentHistoryInputValues bundleFiles');
  const validatedInputs = validateTemplateInputs(inputs, 'resolveAgentHistoryInputValues inputs') ?? [];
  const history = validateAgentHistory(spec.history, `agent '${key}' history`) ?? [];
  const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    validatedInputs.map((declaration) => [declaration.id, declaration] as const)
  );

  // Null prototype: caller/declared keys can never reach Object.prototype
  // setters through this accumulator (T-V finding F1, ticket e4c8f91).
  const resolved: Record<string, string> = Object.create(null);
  for (const entry of history) {
    for (const part of entry.content) {
      if (part.kind !== 'input' || Object.prototype.hasOwnProperty.call(resolved, part.inputId)) continue;
      const declaration = declarationsById.get(part.inputId);
      if (declaration === undefined) {
        throw new Error(`agent '${key}' history references undeclared input '${part.inputId}'`);
      }
      resolved[part.inputId] = resolveDeclaredInputValue(
        declaration,
        inputValues,
        bundleFiles,
        `agent '${key}' history input '${part.inputId}'`
      ).value;
    }
  }
  return resolved;
}

/**
 * Resolves a template's seed manifest into file content, honoring each slot's
 * declared origin.
 *
 * `fixed` slots resolve their declared source (inline verbatim; `source.file`
 * from `bundleFiles`, missing entry failing closed). `user`/`generated` slots
 * resolve from `hydrationFiles` matched by path and target: an absent optional
 * `user` slot is skipped, while a missing `generated` slot fails closed.
 * Hydration entries that match no declared slot, duplicate another entry, or
 * target a `fixed` slot are rejected. Targets and the directive are copied as
 * declared (template agent keys — resolving keys to launched agent ids belongs
 * to the seeding orchestration).
 *
 * @param manifest - Seed manifest to resolve
 * @param options - Bundle file bodies and resolved hydration file entries
 * @returns A deeply frozen resolved seed (files in declared order)
 * @throws `Error` - When the manifest, options, a referenced bundle entry, or the hydration files are invalid
 *
 * @example
 * ```typescript
 * import { resolveSeedManifest } from './realmCatalog/index.ts';
 *
 * const seed = resolveSeedManifest(
 *   { files: [{ path: 'brief.md', target: 'realm', source: { inline: 'Brief.' } }] },
 *   {}
 * );
 * // seed.files[0].content === 'Brief.'
 * ```
 */
export function resolveSeedManifest(
  manifest: RealmSeedManifest,
  options: RealmComposeOptions = {}
): RealmResolvedSeed {
  const validated = validateSeedManifest(manifest, 'resolveSeedManifest seed');
  if (!isPlainRecord(options)) {
    throw new Error('resolveSeedManifest options must be an object');
  }
  const bundleFiles = validateStringRecord(options.bundleFiles, 'resolveSeedManifest bundleFiles');
  const hydrationFiles = validateHydrationFiles(options.hydrationFiles, 'resolveSeedManifest hydrationFiles');

  const declaredSlots: ReadonlyMap<string, { origin: 'fixed' | 'user' | 'generated' }> = new Map(
    (validated.files ?? []).map((file) => [
      seedSlotKey(file.path, file.target),
      { origin: file.origin ?? 'fixed' }
    ] as const)
  );
  const hydrationByKey: Map<string, ResolvedHydrationFile> = new Map();
  for (const entry of hydrationFiles) {
    const key = seedSlotKey(entry.path, entry.target);
    const slot = declaredSlots.get(key);
    if (slot === undefined) {
      throw new Error(
        `resolveSeedManifest hydration file '${entry.path}' does not match any declared seed slot (path+target)`
      );
    }
    if (slot.origin === 'fixed') {
      throw new Error(
        `resolveSeedManifest hydration file '${entry.path}' targets a fixed seed slot; fixed slots ship in the bundle`
      );
    }
    if (hydrationByKey.has(key)) {
      throw new Error(`resolveSeedManifest hydration files duplicate the entry for seed slot '${entry.path}'`);
    }
    hydrationByKey.set(key, entry);
  }

  const files: RealmResolvedSeedFile[] = [];
  (validated.files ?? []).forEach((file, index) => {
    const origin = file.origin ?? 'fixed';
    if (origin === 'fixed') {
      const source = file.source;
      if (source === undefined) {
        throw new Error(`resolveSeedManifest fixed seed slot '${file.path}' (files[${index}]) declares no source`);
      }
      if ('inline' in source) {
        files.push({ path: file.path, target: file.target, content: source.inline });
      } else {
        const path = source.file;
        if (!Object.prototype.hasOwnProperty.call(bundleFiles, path)) {
          throw new Error(
            `resolveSeedManifest seed file '${path}' (files[${index}]) is not present in the bundle files`
          );
        }
        files.push({ path: file.path, target: file.target, content: bundleFiles[path] });
      }
      return;
    }
    const entry = hydrationByKey.get(seedSlotKey(file.path, file.target));
    if (entry !== undefined) {
      files.push({ path: file.path, target: file.target, content: entry.content });
      return;
    }
    if (origin === 'generated') {
      throw new Error(
        `resolveSeedManifest seed slot '${file.path}' is generated but no hydration file was supplied for it`
      );
    }
    // `user` slots are optional: an absent entry means the file is not written.
  });

  const directive = validated.directive;
  return deepFreeze({
    files,
    ...(directive !== undefined
      ? { directive: { targetAgentKey: directive.targetAgentKey, text: directive.text } }
      : {})
  });
}
