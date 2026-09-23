/**
 * Prompt/history composition, placement/directive resolution, and payload
 * input resolution for the `realmCatalog` module: turns a template's declared
 * prompt parts, history entries, inputs, placements, and directives into the
 * composed system prompt, the composed baked history, the input provenance,
 * the resolved workspace writes, and the launch messages carried by a launch
 * plan.
 *
 * Every helper is pure and fail-closed: missing bundle entries, undeclared
 * input references, required inputs that resolve empty, history entries that
 * compose empty, malformed option records, fileset-selection mismatches, and
 * destination collisions throw descriptive `Error`s.
 */

import { deepFreeze } from './freeze.ts';
import { REALM_CATALOG_ERROR_CODES, RealmCatalogError, toCatalogError } from './errors.ts';
import {
  isPlainRecord,
  requireNonEmptyString,
  requireSafePath,
  seedSlotKey,
  validateAgentHistory,
  validateDirectives,
  validateInputValues,
  validatePlacements,
  validatePromptParts,
  validateTemplateInputs
} from './validation.ts';
import type {
  PromptPart,
  RealmAgentSpec,
  RealmComposeOptions,
  RealmComposedPrompt,
  RealmDirective,
  RealmHistoryEntry,
  RealmHistoryMessage,
  RealmInputProvenance,
  RealmInputValue,
  RealmInputValueSource,
  RealmPlacement,
  RealmResolvedDirective,
  RealmResolvedPlacement,
  RealmTemplateInput
} from './types.ts';

/** Separator inserted between contributing prompt pieces. */
const PART_SEPARATOR = '\n\n';

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

/* ------------------------------------------------------------------------- *
 * Canonical composition (decision ticket 2ba3008)
 *
 * Inputs are shape tagged (`text` | `files`); a prompt/history reference to a
 * `files` input names exactly one file, and a placement writes a text value, a
 * bundle file, or a whole fileset. Composition has no engine caps.
 * ------------------------------------------------------------------------- */

/**
 * Resolves one declared format-v2 input's value and provenance.
 *
 * A supplied value wins even when empty (an emptied field is an explicit
 * decision, not an absent one); otherwise a `text` input falls back to the
 * declared `default`, then the `defaultFile` bundle entry, then the empty
 * string. A `files` input has no prefills: absent resolves to an empty
 * fileset. A referenced `defaultFile` whose bundle entry is missing fails
 * closed.
 *
 * @param declaration - Declared input being resolved
 * @param inputs - Validated supplied values keyed by input id
 * @param bundleFiles - Validated bundle bodies keyed by bundle-relative path
 * @param label - Human-readable label used in error messages
 * @returns The resolved shape-tagged value plus its provenance source
 */
export function resolveDeclaredInputValue(
  declaration: RealmTemplateInput,
  inputs: Record<string, RealmInputValue>,
  bundleFiles: Record<string, string>,
  label: string
): { value: RealmInputValue; source: RealmInputValueSource } {
  if (Object.prototype.hasOwnProperty.call(inputs, declaration.id)) {
    return { value: inputs[declaration.id], source: 'launch' };
  }
  if (declaration.shape === 'files') {
    return { value: { shape: 'files', files: [] }, source: 'empty' };
  }
  if (declaration.default !== undefined) {
    return { value: { shape: 'text', text: declaration.default }, source: 'default' };
  }
  if (declaration.defaultFile !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(bundleFiles, declaration.defaultFile)) {
      throw new Error(`${label} defaultFile '${declaration.defaultFile}' is not present in the bundle files`);
    }
    return { value: { shape: 'text', text: bundleFiles[declaration.defaultFile] }, source: 'defaultFile' };
  }
  return { value: { shape: 'text', text: '' }, source: 'empty' };
}

/**
 * Computes one prompt/history input part's contribution from its resolved
 * value.
 *
 * A `text` contribution is omitted while it resolves empty (a `required` empty
 * value fails closed instead); a `files` contribution selects the file named
 * by the part's `path` (a missing selection fails closed, an absent optional
 * fileset contributes nothing, and a `required` empty selection fails closed).
 *
 * @param part - Input part (validated structurally)
 * @param declaration - Declared input the part references
 * @param resolved - Resolved value and provenance
 * @param label - Human-readable label used in error messages
 * @returns The contributing text, or `null` when the part contributes nothing
 */
function contributionFromResolved(
  part: Extract<PromptPart, { kind: 'input' }>,
  declaration: RealmTemplateInput,
  resolved: { value: RealmInputValue; source: RealmInputValueSource },
  label: string
): string | null {
  if (declaration.shape === 'text') {
    if (part.path !== undefined) {
      throw new Error(
        `${label} references text input '${declaration.id}' with a file selection path — `
        + '"path" is only meaningful for files inputs'
      );
    }
    const text = resolved.value.shape === 'text' ? resolved.value.text : '';
    if (declaration.required === true && text.trim().length === 0) {
      throw new Error(`${label} input '${declaration.id}' is required and resolves empty`);
    }
    return text.trim().length > 0 ? text : null;
  }
  if (part.path === undefined) {
    throw new Error(
      `${label} references files input '${declaration.id}' without a file selection path — `
      + 'a files input is never injected wholesale; name exactly one file with "path"'
    );
  }
  const files = resolved.value.shape === 'files' ? resolved.value.files : [];
  if (files.length === 0) {
    if (declaration.required === true) {
      throw new Error(`${label} input '${declaration.id}' is required and resolves empty`);
    }
    return null;
  }
  const selected = files.find((file) => file.path === part.path);
  if (selected === undefined) {
    throw new Error(`${label} files input '${declaration.id}' has no file '${part.path}'`);
  }
  if (declaration.required === true && selected.content.trim().length === 0) {
    throw new Error(`${label} input '${declaration.id}' file '${part.path}' is required and resolves empty`);
  }
  return selected.content.trim().length > 0 ? selected.content : null;
}

/**
 * Validates the shared format-v2 composition plumbing: declarations, supplied
 * values, and bundle bodies.
 *
 * @param inputs - Declared inputs, when known
 * @param options - Composition options
 * @param label - Human-readable label used in error messages
 * @returns The declarations index, supplied values, and bundle bodies
 */
function prepareCompose(
  inputs: readonly RealmTemplateInput[] | undefined,
  options: RealmComposeOptions,
  label: string
): {
  declarationsById: ReadonlyMap<string, RealmTemplateInput>;
  inputValues: Record<string, RealmInputValue>;
  bundleFiles: Record<string, string>;
} {
  const validatedInputs = validateTemplateInputs(inputs, `${label} inputs`) ?? [];
  if (!isPlainRecord(options)) {
    throw new Error(`${label} options must be an object`);
  }
  const inputValues = validateInputValues(options.inputs, `${label} inputs`);
  const bundleFiles = validateStringRecord(options.bundleFiles, `${label} bundleFiles`);
  const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    validatedInputs.map((input) => [input.id, input] as const)
  );
  for (const id of Object.keys(inputValues)) {
    const declaration = declarationsById.get(id);
    if (declaration === undefined) {
      throw new Error(`${label} inputs names undeclared input '${id}'`);
    }
    if (inputValues[id].shape !== declaration.shape) {
      throw new Error(
        `${label} inputs['${id}'] must be ${declaration.shape}-shape (got '${inputValues[id].shape}')`
      );
    }
  }
  return { declarationsById, inputValues, bundleFiles };
}

/**
 * Composes one format-v2 agent's system prompt from its ordered prompt parts.
 *
 * Parts contribute in declared order: `text` verbatim, `file` bodies resolved
 * from `bundleFiles` (a missing entry fails closed), and `input` values
 * resolved supplied → default → defaultFile → empty. A `text` input that
 * resolves empty contributes nothing (a `required` empty value fails closed);
 * a `files` input reference selects one file by `path` (a missing selection
 * fails closed). Contributing pieces join with a blank line. The result
 * carries one provenance entry per referenced input, in first-reference
 * order, recording the id and source without duplicating the value text.
 *
 * @param parts - Ordered prompt parts (validated structurally here)
 * @param inputs - Declared template inputs referenced by `input` parts
 * @param options - Supplied input values and bundle file bodies
 * @returns A deeply frozen composed prompt plus input provenance
 * @throws `Error` - When parts, inputs, options, references, or file selections are invalid
 *
 * @example
 * ```typescript
 * import { composeSystemPrompt } from './realmCatalog/index.ts';
 *
 * const composed = composeSystemPrompt(
 *   [{ kind: 'input', inputId: 'lore', path: 'index.md' }],
 *   [{ id: 'lore', label: 'Lore', shape: 'files' }],
 *   { inputs: { lore: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] } } }
 * );
 * // composed.systemPrompt === 'Index.'
 * ```
 */
export function composeSystemPrompt(
  parts: readonly PromptPart[],
  inputs?: readonly RealmTemplateInput[],
  options: RealmComposeOptions = {}
): RealmComposedPrompt {
  const validatedParts = validatePromptParts(parts, 'composeSystemPrompt parts');
  const { declarationsById, inputValues, bundleFiles } = prepareCompose(
    inputs,
    options,
    'composeSystemPrompt'
  );

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
    const declaration = declarationsById.get(part.inputId);
    if (declaration === undefined) {
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
    const piece = contributionFromResolved(
      part,
      declaration,
      resolved,
      `composeSystemPrompt input '${declaration.id}'`
    );
    if (piece !== null) {
      pieces.push(piece);
    }
  }

  return deepFreeze({ systemPrompt: pieces.join(PART_SEPARATOR), inputProvenance: provenance });
}

/**
 * Composes one format-v2 agent spec's declared baked history into launch
 * messages.
 *
 * Entries compose in declared order using the same part model and separator as
 * prompts: `file` parts resolve from `bundleFiles` (a missing entry fails
 * closed), `input` parts resolve supplied → default → defaultFile → empty
 * (empty contributes nothing), and an entry that composes empty is rejected.
 * Every composed message carries `source: 'template'` (host-side provenance
 * for template-declared history); seeding message ids and seeding itself
 * belong to the runtime.
 *
 * @param spec - Agent spec whose `history` is composed
 * @param inputs - Declared template inputs referenced by `input` parts
 * @param options - Supplied input values and bundle file bodies
 * @returns Deeply frozen composed messages in declared order (empty when no history)
 * @throws `Error` - When the spec, its history, the options, a reference, or an empty entry is invalid
 *
 * @example
 * ```typescript
 * import { composeAgentHistory } from './realmCatalog/index.ts';
 *
 * const history = composeAgentHistory(
 *   { key: 'gm', history: [{ role: 'assistant', content: [{ kind: 'text', text: 'Rain hammers the roof.' }] }] },
 *   []
 * );
 * // history[0].content === 'Rain hammers the roof.'
 * ```
 */
export function composeAgentHistory(
  spec: RealmAgentSpec,
  inputs?: readonly RealmTemplateInput[],
  options: RealmComposeOptions = {}
): readonly RealmHistoryMessage[] {
  if (!isPlainRecord(spec)) {
    throw new RealmCatalogError(
      'composeAgentHistory spec must be an object',
      REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID
    );
  }
  const key = requireNonEmptyString(spec.key, 'composeAgentHistory spec key');
  let history: readonly RealmHistoryEntry[] | undefined;
  let declarationsById: ReadonlyMap<string, RealmTemplateInput>;
  let inputValues: Record<string, RealmInputValue>;
  let bundleFiles: Record<string, string>;
  try {
    const prepared = prepareCompose(inputs, options, 'composeAgentHistory');
    declarationsById = prepared.declarationsById;
    inputValues = prepared.inputValues;
    bundleFiles = prepared.bundleFiles;
    history = validateAgentHistory(spec.history, `agent '${key}' history`);
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }

  const messages = (history ?? []).map((entry, index) => {
    const label = `agent '${key}' history[${index}]`;
    const pieces: string[] = [];
    for (const part of entry.content) {
      if (part.kind === 'text') {
        pieces.push(part.text);
        continue;
      }
      if (part.kind === 'file') {
        if (!Object.prototype.hasOwnProperty.call(bundleFiles, part.path)) {
          throw new Error(`${label} references bundle file '${part.path}' which is not present in the bundle files`);
        }
        pieces.push(bundleFiles[part.path]);
        continue;
      }
      const declaration = declarationsById.get(part.inputId);
      if (declaration === undefined) {
        throw new Error(`${label} references undeclared input '${part.inputId}'`);
      }
      const resolved = resolveDeclaredInputValue(
        declaration,
        inputValues,
        bundleFiles,
        `${label} input '${declaration.id}'`
      );
      const piece = contributionFromResolved(part, declaration, resolved, `${label} input '${declaration.id}'`);
      if (piece !== null) {
        pieces.push(piece);
      }
    }
    const content = pieces.join(PART_SEPARATOR);
    if (content.trim().length === 0) {
      throw new Error(`${label} composes empty — every declared history entry must contribute content`);
    }
    return { role: entry.role, content, source: 'template' as const };
  });
  return deepFreeze(messages);
}

/**
 * Resolves a template's declared format-v2 placements into concrete workspace
 * writes, in declared order.
 *
 * A `file` source resolves its bundle body (a missing entry fails closed). A
 * `text`-input source writes the resolved value to the placement `path` (an
 * optional empty value writes nothing; a `required` empty value fails closed).
 * A `files`-input source writes every fileset file under the placement `root`
 * (`root` + `file.path`, a `/` separator inserted when the root omits one), or
 * — with a `path` destination — writes the single file the fileset must hold
 * (zero files writes nothing when optional; more than one fails closed).
 * Destinations that collide at resolution time (including root/file overlaps)
 * fail closed instead of silently overwriting.
 *
 * @param placements - Declared placements (validated structurally here)
 * @param inputs - Declared template inputs referenced by `inputId` placements
 * @param options - Supplied input values and bundle file bodies
 * @returns A deeply frozen resolved placement list
 * @throws `Error` - When placements, inputs, options, references, destinations, or required values are invalid
 *
 * @example
 * ```typescript
 * import { resolvePlacements } from './realmCatalog/index.ts';
 *
 * const files = resolvePlacements(
 *   [{ inputId: 'lore', target: 'realm', root: 'lore/' }],
 *   [{ id: 'lore', label: 'Lore', shape: 'files' }],
 *   { inputs: { lore: { shape: 'files', files: [{ path: 'a.md', content: 'A' }] } } }
 * );
 * // files[0].path === 'lore/a.md'
 * ```
 */
export function resolvePlacements(
  placements: readonly RealmPlacement[],
  inputs?: readonly RealmTemplateInput[],
  options: RealmComposeOptions = {}
): readonly RealmResolvedPlacement[] {
  const validatedPlacements = validatePlacements(placements, 'resolvePlacements placements') ?? [];
  const { declarationsById, inputValues, bundleFiles } = prepareCompose(
    inputs,
    options,
    'resolvePlacements'
  );

  const resolved: RealmResolvedPlacement[] = [];
  const destinations: Set<string> = new Set();
  const push = (
    path: string,
    target: RealmPlacement['target'],
    content: string,
    label: string
  ): void => {
    requireSafePath(path, `${label} resolved destination path`);
    const key = seedSlotKey(path, target);
    if (destinations.has(key)) {
      throw new Error(`${label} resolves a duplicate destination '${path}' for the same target`);
    }
    destinations.add(key);
    resolved.push({ path, target, content });
  };

  validatedPlacements.forEach((placement, index) => {
    const label = `resolvePlacements placements[${index}]`;
    if (placement.file !== undefined) {
      if (placement.path === undefined) {
        throw new Error(`${label} with a file source must declare a path destination`);
      }
      if (!Object.prototype.hasOwnProperty.call(bundleFiles, placement.file)) {
        throw new Error(`${label} references bundle file '${placement.file}' which is not present in the bundle files`);
      }
      push(placement.path, placement.target, bundleFiles[placement.file], label);
      return;
    }
    const declaration = declarationsById.get(placement.inputId as string);
    if (declaration === undefined) {
      throw new Error(`${label} references undeclared input '${String(placement.inputId)}'`);
    }
    const value = resolveDeclaredInputValue(
      declaration,
      inputValues,
      bundleFiles,
      `${label} input '${declaration.id}'`
    );
    if (declaration.shape === 'text') {
      if (placement.path === undefined) {
        throw new Error(`${label} references text input '${declaration.id}' and must declare a path destination`);
      }
      const text = value.value.shape === 'text' ? value.value.text : '';
      if (declaration.required === true && text.trim().length === 0) {
        throw new Error(`${label} input '${declaration.id}' is required and resolves empty`);
      }
      if (text.trim().length === 0) return;
      push(placement.path, placement.target, text, label);
      return;
    }
    const files = value.value.shape === 'files' ? value.value.files : [];
    if (files.length === 0) {
      if (declaration.required === true) {
        throw new Error(`${label} input '${declaration.id}' is required and resolves empty`);
      }
      return;
    }
    if (placement.root !== undefined) {
      const prefix = placement.root.endsWith('/') ? placement.root : `${placement.root}/`;
      for (const file of files) {
        push(`${prefix}${file.path}`, placement.target, file.content, label);
      }
      return;
    }
    if (files.length !== 1) {
      throw new Error(
        `${label} input '${declaration.id}' declares a path destination but the fileset holds `
        + `${files.length} files — declare a root destination for a multi-file fileset`
      );
    }
    push(placement.path as string, placement.target, files[0].content, label);
  });

  return deepFreeze(resolved);
}

/**
 * Resolves a template's declared format-v2 directives into launch messages, in
 * declared order.
 *
 * A literal `text` directive resolves verbatim. An `inputId` directive
 * resolves a declared `text` input (a `files` input fails closed): an optional
 * empty value delivers nothing, and a `required` empty value fails closed.
 *
 * @param directives - Declared directives (validated structurally here)
 * @param inputs - Declared template inputs referenced by `inputId` directives
 * @param options - Supplied input values and bundle file bodies
 * @returns A deeply frozen resolved directive list
 * @throws `Error` - When directives, inputs, options, references, shapes, or required values are invalid
 *
 * @example
 * ```typescript
 * import { resolveDirectives } from './realmCatalog/index.ts';
 *
 * const directives = resolveDirectives([{ text: 'Begin.', target: { agent: 'gm' } }], []);
 * // directives[0].text === 'Begin.'
 * ```
 */
export function resolveDirectives(
  directives: readonly RealmDirective[],
  inputs?: readonly RealmTemplateInput[],
  options: RealmComposeOptions = {}
): readonly RealmResolvedDirective[] {
  const validatedDirectives = validateDirectives(directives, 'resolveDirectives directives') ?? [];
  const { declarationsById, inputValues, bundleFiles } = prepareCompose(
    inputs,
    options,
    'resolveDirectives'
  );

  const resolved: RealmResolvedDirective[] = [];
  validatedDirectives.forEach((directive, index) => {
    const label = `resolveDirectives directives[${index}]`;
    if (directive.text !== undefined) {
      resolved.push({ targetAgentKey: directive.target.agent, text: directive.text });
      return;
    }
    const declaration = declarationsById.get(directive.inputId as string);
    if (declaration === undefined) {
      throw new Error(`${label} references undeclared input '${String(directive.inputId)}'`);
    }
    if (declaration.shape !== 'text') {
      throw new Error(
        `${label} references files input '${declaration.id}' — a directive needs a text message`
      );
    }
    const value = resolveDeclaredInputValue(
      declaration,
      inputValues,
      bundleFiles,
      `${label} input '${declaration.id}'`
    );
    const text = value.value.shape === 'text' ? value.value.text : '';
    if (declaration.required === true && text.trim().length === 0) {
      throw new Error(`${label} input '${declaration.id}' is required and resolves empty`);
    }
    if (text.trim().length === 0) return;
    resolved.push({ targetAgentKey: directive.target.agent, text });
  });

  return deepFreeze(resolved);
}
