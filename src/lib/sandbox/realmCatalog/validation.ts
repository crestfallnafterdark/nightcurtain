/**
 * Runtime validation and resolution helpers for the `realmCatalog` module.
 *
 * Every helper is pure and fail-closed: invalid shapes throw descriptive
 * `Error`s instead of being coerced, dropped, or defaulted. The helpers serve
 * both materialization (which resolves ids, composes prompt parts, resolves
 * the seed manifest, and resolves tool profiles) and the capability summary
 * (which resolves profiles only).
 */

import { MUTATING_TOOLS, READ_ONLY_TOOLS, TOOL_PRESETS, resolveToolPreset } from '../tools/constants/index.ts';
import type { ToolPresetName } from '../tools/constants/index.ts';
import { getCanonToolName } from '../tools/normalizers/index.ts';
import { deepFreeze } from './freeze.ts';
import { KNOWN_AGENT_AUTHORITIES } from './types.ts';
import type {
  PromptPart,
  RealmAgentSpec,
  RealmHistoryEntry,
  RealmLaunchToolProfile,
  RealmProviderMcp,
  RealmProviderPack,
  RealmSeedManifest,
  RealmTemplate,
  RealmTemplateInput,
  RealmTemplateSeedFile,
  RealmToolRequirement
} from './types.ts';

/**
 * Retired id-pattern placeholder (Wave R, ticket ff2202a).
 *
 * Id patterns are literal agent ids now: the token is rejected at validation
 * with a clear message instead of being resolved, so an id can never embed a
 * realm identifier.
 */
const RETIRED_REALM_PLACEHOLDER = '{realm}';

/**
 * Property names that must never key a record built from template-declared
 * strings (T-V finding F1, ticket e4c8f91).
 *
 * `__proto__` is an accessor on `Object.prototype`, so assigning it to a plain
 * record invokes the setter and silently drops or reroutes the value, while
 * `constructor`/`prototype` reads fall through to inherited members. Rejecting
 * these names at validation keeps every template-derived identifier and path
 * segment safe as an object key.
 */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Composition cap: parts declared by one agent prompt. */
export const MAX_PROMPT_PARTS = 64;

/** Composition cap: characters of one composed system prompt. */
export const MAX_COMPOSED_PROMPT_CHARS = 200 * 1024;

/** Canonical template field names (closed shape). */
const TEMPLATE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'description',
  'notes',
  'formatVersion',
  'hydration',
  'inputs',
  'agents',
  'seed',
  'toolContract',
  'providers'
]);

/** Canonical agent-spec field names (closed shape). */
const AGENT_SPEC_FIELDS: ReadonlySet<string> = new Set([
  'key',
  'idPattern',
  'name',
  'role',
  'prompt',
  'toolProfile',
  'privileged',
  'authorities',
  'history',
  'triggerPolicy',
  'modelPresetId',
  'initialPrompt'
]);

/** Canonical tool-profile field names (closed shape). */
const TOOL_PROFILE_FIELDS: ReadonlySet<string> = new Set(['preset', 'tools']);

/** Canonical template-input field names (closed shape). */
const TEMPLATE_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'help',
  'origin',
  'brief',
  'default',
  'defaultFile',
  'required',
  'multiline'
]);

/** Canonical prompt-part field names per declared kind (closed shape). */
const PROMPT_PART_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  file: new Set(['kind', 'path']),
  input: new Set(['kind', 'inputId']),
  text: new Set(['kind', 'text'])
});

/** Canonical history-entry field names (closed shape). */
const HISTORY_ENTRY_FIELDS: ReadonlySet<string> = new Set(['role', 'content']);

/** Canonical hydration-declaration field names (closed shape). */
const HYDRATION_DECLARATION_FIELDS: ReadonlySet<string> = new Set(['brief']);

/** Canonical tool-contract field names (closed shape). */
const TOOL_CONTRACT_FIELDS: ReadonlySet<string> = new Set(['requirements']);

/** Canonical requirement field names (closed shape). */
const REQUIREMENT_FIELDS: ReadonlySet<string> = new Set(['id', 'brief', 'io', 'required', 'range', 'prefer']);

/** Canonical requirement `io` field names (closed shape). */
const REQUIREMENT_IO_FIELDS: ReadonlySet<string> = new Set(['in', 'out']);

/** Canonical pack-provider field names (closed shape). */
const PROVIDER_PACK_FIELDS: ReadonlySet<string> = new Set(['kind', 'id', 'range', 'source']);

/** Canonical MCP-provider field names (closed shape). */
const PROVIDER_MCP_FIELDS: ReadonlySet<string> = new Set(['kind', 'id', 'transport', 'provides', 'authRef']);

/** Canonical MCP-transport field names (closed shape). */
const MCP_TRANSPORT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  http: new Set(['kind', 'url']),
  stdio: new Set(['kind', 'command', 'args'])
});

/** Canonical provider-surface field names (closed shape). */
const PROVIDES_FIELDS: ReadonlySet<string> = new Set(['capability', 'tool']);

/** Agent-spec field names naming an array of history entries. */
const AGENT_HISTORY_FIELD = 'history';

/** Canonical seed-manifest field names (closed shape). */
const SEED_MANIFEST_FIELDS: ReadonlySet<string> = new Set(['files', 'directive']);

/** Canonical seed-file field names (closed shape). */
const SEED_FILE_FIELDS: ReadonlySet<string> = new Set(['path', 'target', 'origin', 'brief', 'source']);

/** Canonical seed-source field names (closed shape). */
const SEED_SOURCE_FIELDS: ReadonlySet<string> = new Set(['file', 'inline']);

/** Canonical seed agent-target field names (closed shape). */
const SEED_AGENT_TARGET_FIELDS: ReadonlySet<string> = new Set(['agent']);

/** Canonical seed-directive field names (closed shape). */
const SEED_DIRECTIVE_FIELDS: ReadonlySet<string> = new Set(['targetAgentKey', 'text']);

/** Optional agent-spec string fields validated as non-empty when present. */
const OPTIONAL_SPEC_STRING_FIELDS: readonly string[] = Object.freeze([
  'triggerPolicy',
  'modelPresetId',
  'initialPrompt'
]);

/** Canonical tool names plus the aggregate subagent-management selector. */
const RECOGNIZED_TOOL_GRANTS: ReadonlySet<string> = new Set([
  ...MUTATING_TOOLS,
  ...READ_ONLY_TOOLS,
  'subagent_management'
]);

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value - Candidate value
 * @returns `true` when the value is a non-null, non-array object
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects unknown own keys on a closed-shape record.
 *
 * @param value - Record to inspect
 * @param allowed - Canonical field-name set
 * @param label - Human-readable label used in the error message
 */
export function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} carries unknown field '${key}'`);
    }
  }
}

/**
 * Requires a non-empty string (validated after trimming).
 *
 * @param value - Candidate value
 * @param label - Human-readable label used in the error message
 * @returns The original string, untrimmed
 */
export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Rejects a template-declared identifier that would become a dangerous object
 * key (`__proto__`, `constructor`, `prototype`).
 *
 * The value is returned unchanged so the check composes with
 * {@link requireNonEmptyString} calls.
 *
 * @param value - Validated non-empty identifier
 * @param label - Human-readable label used in the error message
 * @returns The identifier, unchanged
 */
export function requireNonReservedName(value: string, label: string): string {
  if (RESERVED_PROPERTY_NAMES.has(value)) {
    throw new Error(`${label} '${value}' is a reserved property name`);
  }
  return value;
}

/**
 * Requires a non-empty path that is safe as a bundle-relative or
 * workspace-relative reference: null bytes, `..` segments, and reserved
 * property-name segments (`__proto__`, `constructor`, `prototype`) are
 * rejected, because paths key bundle/slot records (T-V finding F1, ticket
 * e4c8f91).
 *
 * @param value - Candidate path
 * @param label - Human-readable label used in the error message
 * @returns The original path, untrimmed
 */
export function requireSafePath(value: unknown, label: string): string {
  const path = requireNonEmptyString(value, label);
  if (path.includes('\0')) {
    throw new Error(`${label} must not contain null bytes`);
  }
  const segments = path.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) {
    throw new Error(`${label} '${path}' must not contain '..' path segments`);
  }
  for (const segment of segments) {
    if (RESERVED_PROPERTY_NAMES.has(segment)) {
      throw new Error(`${label} '${path}' must not use reserved property names as path segments`);
    }
  }
  return path;
}

/**
 * Builds the matching key of a seed slot or hydration entry: destination path
 * plus target (the Realm-global workspace or one template agent key).
 *
 * @param path - Slot/entry destination path
 * @param target - Slot/entry target
 * @returns A stable string key
 */
export function seedSlotKey(path: string, target: 'realm' | { agent: string }): string {
  return `${path}\u0000${target === 'realm' ? 'realm' : `agent:${target.agent}`}`;
}

/**
 * Asserts that one declared tool-list entry is a recognized grant: the
 * wildcard, a canonical tool name (or alias resolving to one, including the
 * aggregate subagent-management selector), or a declared requirement id.
 *
 * @param entry - Declared entry (validated non-empty)
 * @param label - Human-readable label used in the error message
 * @param requirementIds - Declared `toolContract` requirement ids, when known
 */
function assertRecognizedToolGrant(
  entry: string,
  label: string,
  requirementIds: ReadonlySet<string> | undefined
): void {
  if (entry === '*') return;
  if (requirementIds !== undefined && requirementIds.has(entry)) return;
  const canonical = getCanonToolName(entry);
  if (canonical !== null && RECOGNIZED_TOOL_GRANTS.has(canonical)) return;
  throw new Error(
    `${label} '${entry}' is neither a canonical tool name nor a declared toolContract requirement id`
  );
}

/**
 * Resolves one declared tool profile into a frozen resolved profile.
 *
 * A profile must be an object declaring exactly one selector. Preset names
 * must be canonical `tools/constants` keys and resolve to fresh preset arrays.
 * Explicit lists pass through the canonical resolver in declared order, but
 * every entry is validated first: an entry must be the wildcard, a canonical
 * tool name (or an alias that resolves to one), or — when the template's
 * declared requirement ids are supplied — a declared `toolContract` requirement
 * id. Unknown entries are rejected instead of silently passing through as
 * unrecognized grants.
 *
 * @param profile - Candidate tool-profile value
 * @param label - Human-readable label used in error messages
 * @param requirementIds - Declared `toolContract` requirement ids, when known
 * @returns A frozen resolved profile (`preset` `null` for explicit lists)
 */
export function resolveToolProfile(
  profile: unknown,
  label: string,
  requirementIds?: ReadonlySet<string>
): RealmLaunchToolProfile {
  if (!isPlainRecord(profile)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(profile, TOOL_PROFILE_FIELDS, label);

  const hasPreset = profile.preset !== undefined;
  const hasTools = profile.tools !== undefined;
  if (hasPreset === hasTools) {
    throw new Error(`${label} must declare exactly one of preset or tools`);
  }

  if (hasPreset) {
    const preset = profile.preset;
    if (typeof preset !== 'string' || !Object.prototype.hasOwnProperty.call(TOOL_PRESETS, preset)) {
      throw new Error(`${label} preset '${String(preset)}' is not a known tool preset`);
    }
    return deepFreeze({ preset: preset as ToolPresetName, tools: resolveToolPreset(preset) });
  }

  const tools = profile.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`${label} tools must be an array of tool names`);
  }
  tools.forEach((tool, index) => {
    const entry = requireNonEmptyString(tool, `${label} tools[${index}]`);
    assertRecognizedToolGrant(entry, `${label} tools[${index}]`, requirementIds);
  });
  return deepFreeze({ preset: null, tools: resolveToolPreset(tools as readonly string[]) });
}

/**
 * Validates one prompt part against the closed schema shape.
 *
 * `kind` selects the closed field set: `file` requires a safe bundle path,
 * `input` requires a non-empty input id, and `text` requires non-empty text.
 * Unknown kinds and unknown fields on any kind are rejected.
 *
 * @param candidate - Candidate prompt part
 * @param label - Human-readable label used in error messages
 * @returns The validated part reference
 */
export function validatePromptPart(candidate: unknown, label: string): PromptPart {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  const kind = candidate.kind;
  if (kind !== 'file' && kind !== 'input' && kind !== 'text') {
    throw new Error(`${label} carries unknown prompt part kind '${String(kind)}'`);
  }
  rejectUnknownFields(candidate, PROMPT_PART_FIELDS[kind], label);
  if (kind === 'file') {
    requireSafePath(candidate.path, `${label} path`);
  } else if (kind === 'input') {
    requireNonEmptyString(candidate.inputId, `${label} inputId`);
  } else {
    requireNonEmptyString(candidate.text, `${label} text`);
  }
  return candidate as unknown as PromptPart;
}

/**
 * Validates an agent prompt: a non-empty part list within the composition cap.
 *
 * @param candidate - Candidate prompt-part list
 * @param label - Human-readable label used in error messages
 * @returns The validated part list reference
 */
export function validatePromptParts(candidate: unknown, label: string): readonly PromptPart[] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error(`${label} must be a non-empty array of prompt parts`);
  }
  if (candidate.length > MAX_PROMPT_PARTS) {
    throw new Error(`${label} declares ${candidate.length} prompt parts; the cap is ${MAX_PROMPT_PARTS}`);
  }
  candidate.forEach((part, index) => {
    validatePromptPart(part, `${label}[${index}]`);
  });
  return candidate as readonly PromptPart[];
}

/**
 * Validates one template input against the closed schema shape.
 *
 * `origin` defaults to `user` when absent (draft compatibility); a `generated`
 * input requires a non-empty `brief` and rejects `default`/`defaultFile`
 * prefills, which are `user`-origin declarations only. `default` and
 * `defaultFile` are alternative prefills and are rejected together; an empty
 * `default` is valid (it starts empty, exactly like an absent prefill).
 *
 * @param candidate - Candidate template input
 * @param label - Human-readable label used in error messages
 * @returns The validated input reference
 */
export function validateTemplateInput(candidate: unknown, label: string): RealmTemplateInput {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, TEMPLATE_INPUT_FIELDS, label);
  requireNonReservedName(requireNonEmptyString(candidate.id, `${label} id`), `${label} id`);
  requireNonEmptyString(candidate.label, `${label} label`);
  if (candidate.help !== undefined) {
    requireNonEmptyString(candidate.help, `${label} help`);
  }
  if (candidate.origin !== undefined && candidate.origin !== 'user' && candidate.origin !== 'generated') {
    throw new Error(`${label} origin must be 'user' or 'generated'`);
  }
  const origin = candidate.origin === 'generated' ? 'generated' : 'user';
  if (candidate.brief !== undefined) {
    requireNonEmptyString(candidate.brief, `${label} brief`);
  }
  if (origin === 'generated' && candidate.brief === undefined) {
    throw new Error(`${label} must declare a brief for a generated input`);
  }
  if (origin === 'generated' && (candidate.default !== undefined || candidate.defaultFile !== undefined)) {
    throw new Error(`${label} must not declare default or defaultFile for a generated input`);
  }
  if (candidate.default !== undefined && typeof candidate.default !== 'string') {
    throw new Error(`${label} default must be a string`);
  }
  if (candidate.defaultFile !== undefined) {
    requireSafePath(candidate.defaultFile, `${label} defaultFile`);
  }
  if (candidate.default !== undefined && candidate.defaultFile !== undefined) {
    throw new Error(`${label} must declare at most one of default or defaultFile`);
  }
  for (const field of ['required', 'multiline'] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'boolean') {
      throw new Error(`${label} ${field} must be a boolean`);
    }
  }
  return candidate as unknown as RealmTemplateInput;
}

/**
 * Validates an optional template-input declaration list.
 *
 * @param candidate - Candidate input list
 * @param label - Human-readable label used in error messages
 * @returns The validated list reference, or `undefined` when absent
 */
export function validateTemplateInputs(
  candidate: unknown,
  label: string
): readonly RealmTemplateInput[] | undefined {
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate)) {
    throw new Error(`${label} must be an array of template inputs`);
  }
  const ids: Set<string> = new Set();
  candidate.forEach((input, index) => {
    const validated = validateTemplateInput(input, `${label}[${index}]`);
    if (ids.has(validated.id)) {
      throw new Error(`${label} carries duplicate input id '${validated.id}'`);
    }
    ids.add(validated.id);
  });
  return candidate as readonly RealmTemplateInput[];
}

/**
 * Validates one seed target: the Realm-global workspace or one template agent
 * key (membership checked only when the declared agent-key set is supplied).
 *
 * @param candidate - Candidate target value
 * @param label - Human-readable label used in error messages
 * @param agentKeys - Declared template agent keys, when known
 * @returns The validated target reference
 */
export function validateSeedTarget(
  candidate: unknown,
  label: string,
  agentKeys: ReadonlySet<string> | undefined
): 'realm' | { agent: string } {
  if (candidate === 'realm') return 'realm';
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be 'realm' or an object naming a template agent`);
  }
  rejectUnknownFields(candidate, SEED_AGENT_TARGET_FIELDS, label);
  const agent = requireNonEmptyString(candidate.agent, `${label} agent`);
  if (agentKeys !== undefined && !agentKeys.has(agent)) {
    throw new Error(`${label} names unknown template agent key '${agent}'`);
  }
  return candidate as { agent: string };
}

/**
 * Validates one seed source: exactly one of a safe bundle file path or inline
 * text (inline text is verbatim and may be empty, like an empty file).
 *
 * @param candidate - Candidate source value
 * @param label - Human-readable label used in error messages
 * @returns The validated source reference
 */
function validateSeedSource(candidate: unknown, label: string): { file: string } | { inline: string } {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, SEED_SOURCE_FIELDS, label);
  const hasFile = candidate.file !== undefined;
  const hasInline = candidate.inline !== undefined;
  if (hasFile === hasInline) {
    throw new Error(`${label} must declare exactly one of file or inline`);
  }
  if (hasFile) {
    requireSafePath(candidate.file, `${label} file`);
    return candidate as { file: string };
  }
  if (typeof candidate.inline !== 'string') {
    throw new Error(`${label} inline must be a string`);
  }
  return candidate as { inline: string };
}

/**
 * Validates one seed file slot against the closed schema shape and its
 * origin/content-source rules.
 *
 * `origin` defaults to `fixed` when absent (draft compatibility). A `fixed`
 * slot must declare a source (`file` or `inline`); `user` and `generated` slots
 * must not (their content arrives with the hydration package), and a
 * `generated` slot must declare a non-empty `brief`. `user` briefs are optional.
 *
 * @param candidate - Candidate seed file
 * @param label - Human-readable label used in error messages
 * @param agentKeys - Declared template agent keys, when known
 * @returns The validated file reference
 */
export function validateSeedFile(
  candidate: unknown,
  label: string,
  agentKeys?: ReadonlySet<string>
): RealmTemplateSeedFile {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, SEED_FILE_FIELDS, label);
  requireSafePath(candidate.path, `${label} path`);
  validateSeedTarget(candidate.target, `${label} target`, agentKeys);
  if (candidate.origin !== undefined && candidate.origin !== 'fixed'
    && candidate.origin !== 'user' && candidate.origin !== 'generated') {
    throw new Error(`${label} origin must be 'fixed', 'user', or 'generated'`);
  }
  const origin = candidate.origin ?? 'fixed';
  if (candidate.brief !== undefined) {
    requireNonEmptyString(candidate.brief, `${label} brief`);
  }
  if (origin === 'generated' && candidate.brief === undefined) {
    throw new Error(`${label} must declare a brief for a generated seed slot`);
  }
  if (origin === 'fixed') {
    if (candidate.source === undefined) {
      throw new Error(`${label} must declare a source for a fixed seed slot`);
    }
    validateSeedSource(candidate.source, `${label} source`);
  } else if (candidate.source !== undefined) {
    throw new Error(`${label} must not declare a source for a ${origin} seed slot`);
  }
  return candidate as unknown as RealmTemplateSeedFile;
}

/**
 * Validates one seed directive: a non-empty target template agent key (checked
 * against the declared keys when supplied) and non-empty directive text.
 *
 * @param candidate - Candidate directive
 * @param label - Human-readable label used in error messages
 * @param agentKeys - Declared template agent keys, when known
 * @returns The validated directive reference
 */
export function validateSeedDirective(
  candidate: unknown,
  label: string,
  agentKeys?: ReadonlySet<string>
): { targetAgentKey: string; text: string } {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, SEED_DIRECTIVE_FIELDS, label);
  const targetAgentKey = requireNonEmptyString(candidate.targetAgentKey, `${label} targetAgentKey`);
  if (agentKeys !== undefined && !agentKeys.has(targetAgentKey)) {
    throw new Error(`${label} names unknown template agent key '${targetAgentKey}'`);
  }
  requireNonEmptyString(candidate.text, `${label} text`);
  return candidate as unknown as { targetAgentKey: string; text: string };
}

/**
 * Validates one seed manifest against the closed schema shape.
 *
 * Beyond the per-entry checks, `path`+`target` slot pairs must be unique (a
 * duplicate would make hydration matching last-wins, T-V finding F3 ticket
 * dc2aa0c), and a declared directive must have at least one file targeting the
 * same template agent key: the store delivers a directive together with its
 * target's files (one operator seed call per target), so a directive-only
 * manifest fails closed here instead of needing a second delivery path.
 *
 * @param candidate - Candidate seed manifest
 * @param label - Human-readable label used in error messages
 * @param agentKeys - Declared template agent keys, when known
 * @returns The validated manifest reference
 */
export function validateSeedManifest(
  candidate: unknown,
  label: string,
  agentKeys?: ReadonlySet<string>
): RealmSeedManifest {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, SEED_MANIFEST_FIELDS, label);
  if (candidate.files !== undefined) {
    if (!Array.isArray(candidate.files)) {
      throw new Error(`${label} files must be an array of seed files`);
    }
    const slots: Set<string> = new Set();
    candidate.files.forEach((file, index) => {
      const validated = validateSeedFile(file, `${label} files[${index}]`, agentKeys);
      const key = seedSlotKey(validated.path, validated.target);
      if (slots.has(key)) {
        throw new Error(
          `${label} carries duplicate seed slot '${validated.path}'`
          + ' — every slot must declare a unique path+target pair'
        );
      }
      slots.add(key);
    });
  }
  if (candidate.directive !== undefined) {
    const directive = validateSeedDirective(candidate.directive, `${label} directive`, agentKeys);
    const files = Array.isArray(candidate.files) ? candidate.files : [];
    const hasTargetFile = files.some(
      (file) => isPlainRecord(file)
        && isPlainRecord(file.target)
        && file.target.agent === directive.targetAgentKey
    );
    if (!hasTargetFile) {
      throw new Error(
        `${label} directive targets agent '${directive.targetAgentKey}' but declares no seed file for that target`
        + ' — a directive is delivered with its target\'s files, so a directive-only manifest is rejected'
      );
    }
  }
  return candidate as unknown as RealmSeedManifest;
}

/**
 * Validates one baked history entry against the closed schema shape.
 *
 * `role` is `user` (operator-attributed) or `assistant` (the agent itself);
 * `content` is a non-empty ordered part list within the composition cap, using
 * the same part model as prompts.
 *
 * @param candidate - Candidate history entry
 * @param label - Human-readable label used in error messages
 * @returns The validated entry reference
 */
export function validateHistoryEntry(candidate: unknown, label: string): RealmHistoryEntry {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, HISTORY_ENTRY_FIELDS, label);
  if (candidate.role !== 'user' && candidate.role !== 'assistant') {
    throw new Error(`${label} role must be 'user' or 'assistant'`);
  }
  validatePromptParts(candidate.content, `${label} content`);
  return candidate as unknown as RealmHistoryEntry;
}

/**
 * Validates an optional agent history declaration.
 *
 * @param candidate - Candidate history list
 * @param label - Human-readable label used in error messages
 * @returns The validated list reference, or `undefined` when absent
 */
export function validateAgentHistory(
  candidate: unknown,
  label: string
): readonly RealmHistoryEntry[] | undefined {
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate)) {
    throw new Error(`${label} must be an array of history entries`);
  }
  candidate.forEach((entry, index) => {
    validateHistoryEntry(entry, `${label}[${index}]`);
  });
  return candidate as readonly RealmHistoryEntry[];
}

/**
 * Validates the optional agent-spec `authorities` declaration (Wave U, lane
 * U-P).
 *
 * The closed shape is an array of non-empty, unique strings. Identifiers
 * unknown to the host are accepted here on purpose: validation stays
 * permissive so a bundle authored for a newer host can still be imported and
 * reviewed, while the launch gate fails closed with
 * `ERR_TEMPLATE_AUTHORITY_UNSUPPORTED` (providers precedent). Duplicates are
 * rejected, because a repeated request would make the review surface
 * ambiguous.
 *
 * @param candidate - Candidate authorities declaration
 * @param label - Human-readable label used in error messages
 * @returns The validated declaration reference, or `undefined` when absent
 */
export function validateAgentAuthorities(candidate: unknown, label: string): readonly string[] | undefined {
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate)) {
    throw new Error(`${label} must be an array of authority identifiers`);
  }
  const seen: Set<string> = new Set();
  candidate.forEach((authority, index) => {
    const value = requireNonEmptyString(authority, `${label}[${index}]`);
    if (seen.has(value)) {
      throw new Error(`${label} carries duplicate authority '${value}'`);
    }
    seen.add(value);
  });
  return candidate as readonly string[];
}

/**
 * Validates the optional hydration declaration against the closed schema shape.
 *
 * @param candidate - Candidate hydration declaration
 * @param label - Human-readable label used in error messages
 * @returns The validated declaration reference, or `undefined` when absent
 */
export function validateHydrationDeclaration(candidate: unknown, label: string): void {
  if (candidate === undefined) return;
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, HYDRATION_DECLARATION_FIELDS, label);
  requireNonEmptyString(candidate.brief, `${label} brief`);
}

/**
 * Validates one `toolContract` requirement against the closed schema shape.
 *
 * @param candidate - Candidate requirement
 * @param label - Human-readable label used in error messages
 * @returns The validated requirement reference
 */
export function validateToolRequirement(candidate: unknown, label: string): RealmToolRequirement {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, REQUIREMENT_FIELDS, label);
  requireNonReservedName(requireNonEmptyString(candidate.id, `${label} id`), `${label} id`);
  requireNonEmptyString(candidate.brief, `${label} brief`);
  const io = candidate.io;
  if (!isPlainRecord(io)) {
    throw new Error(`${label} io must be an object`);
  }
  rejectUnknownFields(io, REQUIREMENT_IO_FIELDS, label + ' io');
  for (const direction of ['in', 'out'] as const) {
    const signature = io[direction];
    if (!isPlainRecord(signature)) {
      throw new Error(`${label} io.${direction} must be a record of type labels`);
    }
    for (const name of Object.keys(signature)) {
      requireNonEmptyString(signature[name], `${label} io.${direction}['${name}']`);
    }
  }
  if (candidate.required !== undefined && typeof candidate.required !== 'boolean') {
    throw new Error(`${label} required must be a boolean`);
  }
  if (candidate.range !== undefined) {
    requireNonEmptyString(candidate.range, `${label} range`);
  }
  if (candidate.prefer !== undefined) {
    if (!Array.isArray(candidate.prefer)) {
      throw new Error(`${label} prefer must be an array of provider ids`);
    }
    candidate.prefer.forEach((providerId, index) => {
      requireNonEmptyString(providerId, `${label} prefer[${index}]`);
    });
  }
  return candidate as unknown as RealmToolRequirement;
}

/**
 * Validates the optional tool contract and returns its declared requirement
 * ids (used to validate `toolProfile.tools` entries).
 *
 * @param candidate - Candidate tool contract
 * @param label - Human-readable label used in error messages
 * @returns Declared requirement ids; empty when the contract is absent
 */
export function validateToolContract(candidate: unknown, label: string): ReadonlySet<string> {
  if (candidate === undefined) return new Set();
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, TOOL_CONTRACT_FIELDS, label);
  if (candidate.requirements === undefined) return new Set();
  if (!Array.isArray(candidate.requirements)) {
    throw new Error(`${label} requirements must be an array`);
  }
  const ids: Set<string> = new Set();
  candidate.requirements.forEach((requirement, index) => {
    const validated = validateToolRequirement(requirement, `${label} requirements[${index}]`);
    if (ids.has(validated.id)) {
      throw new Error(`${label} carries duplicate requirement id '${validated.id}'`);
    }
    ids.add(validated.id);
  });
  return ids;
}

/**
 * Validates one provider pack request: a `publisher/name` id, optional semver
 * range and install-source hint.
 *
 * @param candidate - Candidate pack provider
 * @param label - Human-readable label used in error messages
 * @returns The validated provider reference
 */
function validateProviderPack(candidate: Record<string, unknown>, label: string): RealmProviderPack {
  rejectUnknownFields(candidate, PROVIDER_PACK_FIELDS, label);
  const id = requireNonEmptyString(candidate.id, `${label} id`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(id)) {
    throw new Error(`${label} id '${id}' must be a 'publisher/name' pack identity`);
  }
  if (candidate.range !== undefined) {
    requireNonEmptyString(candidate.range, `${label} range`);
  }
  if (candidate.source !== undefined) {
    requireNonEmptyString(candidate.source, `${label} source`);
  }
  return candidate as unknown as RealmProviderPack;
}

/**
 * Validates one MCP provider request: id, exactly one http/stdio transport,
 * optional capability mappings, and an `authRef` vault key name (never a
 * secret).
 *
 * @param candidate - Candidate MCP provider
 * @param label - Human-readable label used in error messages
 * @returns The validated provider reference
 */
function validateProviderMcp(candidate: Record<string, unknown>, label: string): RealmProviderMcp {
  rejectUnknownFields(candidate, PROVIDER_MCP_FIELDS, label);
  requireNonEmptyString(candidate.id, `${label} id`);
  const transport = candidate.transport;
  if (!isPlainRecord(transport)) {
    throw new Error(`${label} transport must be an object`);
  }
  const transportKind = transport.kind;
  if (transportKind !== 'http' && transportKind !== 'stdio') {
    throw new Error(`${label} transport kind must be 'http' or 'stdio'`);
  }
  rejectUnknownFields(transport, MCP_TRANSPORT_FIELDS[transportKind], `${label} transport`);
  if (transportKind === 'http') {
    requireNonEmptyString(transport.url, `${label} transport url`);
  } else {
    requireNonEmptyString(transport.command, `${label} transport command`);
    if (transport.args !== undefined) {
      if (!Array.isArray(transport.args)) {
        throw new Error(`${label} transport args must be an array of strings`);
      }
      transport.args.forEach((arg, index) => {
        if (typeof arg !== 'string') {
          throw new Error(`${label} transport args[${index}] must be a string`);
        }
      });
    }
  }
  if (candidate.provides !== undefined) {
    if (!Array.isArray(candidate.provides)) {
      throw new Error(`${label} provides must be an array`);
    }
    candidate.provides.forEach((surface, index) => {
      const surfaceLabel = `${label} provides[${index}]`;
      if (!isPlainRecord(surface)) {
        throw new Error(`${surfaceLabel} must be an object`);
      }
      rejectUnknownFields(surface, PROVIDES_FIELDS, surfaceLabel);
      requireNonEmptyString(surface.capability, `${surfaceLabel} capability`);
      if (surface.tool !== undefined) {
        requireNonEmptyString(surface.tool, `${surfaceLabel} tool`);
      }
    });
  }
  if (candidate.authRef !== undefined) {
    requireNonEmptyString(candidate.authRef, `${label} authRef`);
  }
  return candidate as unknown as RealmProviderMcp;
}

/**
 * Validates the optional provider request list against the closed schema shape.
 *
 * @param candidate - Candidate provider list
 * @param label - Human-readable label used in error messages
 */
export function validateProviders(candidate: unknown, label: string): void {
  if (candidate === undefined) return;
  if (!Array.isArray(candidate)) {
    throw new Error(`${label} must be an array of provider requests`);
  }
  candidate.forEach((provider, index) => {
    const providerLabel = `${label}[${index}]`;
    if (!isPlainRecord(provider)) {
      throw new Error(`${providerLabel} must be an object`);
    }
    if (provider.kind === 'pack') {
      validateProviderPack(provider, providerLabel);
    } else if (provider.kind === 'mcp') {
      validateProviderMcp(provider, providerLabel);
    } else {
      throw new Error(`${providerLabel} kind must be 'pack' or 'mcp'`);
    }
  });
}

/**
 * Reports whether a template declares capability needs: non-empty
 * `toolContract.requirements` or non-empty `providers`.
 *
 * The launch gate uses this to fail closed with
 * `ERR_TEMPLATE_PROVIDERS_UNSUPPORTED` until the providers wave lands, while
 * import, parse, validation, and review all succeed. The helper is a pure
 * shape query — the shape itself is validated by
 * `validateTemplate()`/`parseTemplateBundle()`.
 *
 * @param template - Template (or `null`/`undefined`) to inspect
 * @returns `true` when the template requests providers or capability requirements
 *
 * @example
 * ```typescript
 * import { templateRequiresProviders } from './realmCatalog/index.ts';
 *
 * templateRequiresProviders({ ...DEMO_TEMPLATE });
 * // false
 * ```
 */
export function templateRequiresProviders(template: RealmTemplate | null | undefined): boolean {
  if (!template || typeof template !== 'object') return false;
  const requirements = template.toolContract?.requirements;
  const providers = template.providers;
  return (Array.isArray(requirements) && requirements.length > 0)
    || (Array.isArray(providers) && providers.length > 0);
}

/**
 * Lists the declared-but-unknown publishing-authority ids of a template (Wave
 * U, lane U-P).
 *
 * The check is a pure shape query over `AgentSpec.authorities`: every declared
 * identifier outside `KNOWN_AGENT_AUTHORITIES` is reported once, in first
 * declaration order across agent specs. An empty result means every declared
 * authority is supported by this host; import, parse, and review accept a
 * template carrying unknown ids, while the launch gate fails closed with
 * `ERR_TEMPLATE_AUTHORITY_UNSUPPORTED` (providers precedent). The helper never
 * validates the template — malformed declarations are simply not reported.
 *
 * @param template - Template (or `null`/`undefined`) to inspect
 * @returns Declared-but-unknown authority ids (empty when all are known)
 *
 * @example
 * ```typescript
 * import { templateUnsupportedAuthorities } from './realmCatalog/index.ts';
 *
 * templateUnsupportedAuthorities({ ...DEMO_TEMPLATE });
 * // []
 * ```
 */
export function templateUnsupportedAuthorities(template: RealmTemplate | null | undefined): readonly string[] {
  if (!template || typeof template !== 'object') return Object.freeze([]);
  const known: ReadonlySet<string> = new Set(KNOWN_AGENT_AUTHORITIES);
  const unsupported: string[] = [];
  const agents = Array.isArray(template.agents) ? template.agents : [];
  for (const spec of agents) {
    if (!spec || typeof spec !== 'object') continue;
    const authorities = Array.isArray(spec.authorities) ? spec.authorities : [];
    for (const authority of authorities) {
      if (typeof authority !== 'string' || known.has(authority)) continue;
      if (!unsupported.includes(authority)) unsupported.push(authority);
    }
  }
  return Object.freeze(unsupported);
}

/**
 * Validates one agent spec against the closed schema shape.
 *
 * The check is structural: it validates required fields, rejects any
 * placeholder syntax in `idPattern` (the retired `{realm}` token included, so
 * an id can never embed a realm identifier), validates the ordered prompt
 * parts and their composition cap, validates the optional baked history
 * entries, validates the tool profile (every explicit grant must be a
 * canonical tool name or a declared requirement id when the template's
 * requirements are supplied), and rejects unknown fields. Input references and
 * reserved-identity checks happen later (template validation and
 * materialization, where the declared input ids and the final id are known).
 *
 * @param candidate - Candidate agent spec
 * @param label - Human-readable label used in error messages
 * @param requirementIds - Declared `toolContract` requirement ids, when known
 * @returns The validated spec reference
 */
export function validateAgentSpec(
  candidate: unknown,
  label: string,
  requirementIds?: ReadonlySet<string>
): RealmAgentSpec {
  if (!isPlainRecord(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, AGENT_SPEC_FIELDS, label);
  requireNonReservedName(requireNonEmptyString(candidate.key, `${label} key`), `${label} key`);
  const idPattern = requireNonEmptyString(candidate.idPattern, `${label} idPattern`);
  if (idPattern.includes('{') || idPattern.includes('}')) {
    throw new Error(
      `${label} idPattern '${idPattern}' must be a literal agent id without placeholders — `
      + `the '${RETIRED_REALM_PLACEHOLDER}' placeholder is retired (agent ids are realm-opaque)`
    );
  }
  requireNonEmptyString(candidate.name, `${label} name`);
  requireNonEmptyString(candidate.role, `${label} role`);
  validatePromptParts(candidate.prompt, `${label} prompt`);
  resolveToolProfile(candidate.toolProfile, `${label} toolProfile`, requirementIds);
  if (typeof candidate.privileged !== 'boolean') {
    throw new Error(`${label} privileged must be a boolean`);
  }
  validateAgentAuthorities(candidate.authorities, `${label} authorities`);
  validateAgentHistory(candidate[AGENT_HISTORY_FIELD], `${label} history`);
  for (const field of OPTIONAL_SPEC_STRING_FIELDS) {
    const value = candidate[field];
    if (value !== undefined) {
      requireNonEmptyString(value, `${label} ${field}`);
    }
  }
  return candidate as unknown as RealmAgentSpec;
}

/**
 * Validates a whole template against the closed schema shape.
 *
 * Beyond the structural checks, the cross-references fail closed here: the
 * hydration declaration, tool contract, and provider requests validate (with
 * requirement ids collected first so `toolProfile.tools` can reference them),
 * every `input` part in a prompt or history entry must name a declared input,
 * input ids and requirement ids must be unique, and every seed target (file
 * `target.agent` and the directive `targetAgentKey`) must name a declared
 * template agent key.
 *
 * @param candidate - Candidate template
 * @returns The validated template reference
 */
export function validateTemplate(candidate: unknown): RealmTemplate {
  if (!isPlainRecord(candidate)) {
    throw new Error('template must be an object');
  }
  rejectUnknownFields(candidate, TEMPLATE_FIELDS, 'template');
  requireNonEmptyString(candidate.id, 'template id');
  requireNonEmptyString(candidate.name, 'template name');
  if (typeof candidate.description !== 'string') {
    throw new Error('template description must be a string');
  }
  if (candidate.notes !== undefined) {
    requireNonEmptyString(candidate.notes, 'template notes');
  }
  if (candidate.formatVersion !== 1) {
    throw new Error(`template formatVersion must be 1 (got '${String(candidate.formatVersion)}')`);
  }
  validateHydrationDeclaration(candidate.hydration, 'template hydration');
  const requirementIds = validateToolContract(candidate.toolContract, 'template toolContract');
  validateProviders(candidate.providers, 'template providers');

  const inputs = validateTemplateInputs(candidate.inputs, 'template inputs');
  const declaredInputIds: ReadonlySet<string> = new Set((inputs ?? []).map((input) => input.id));

  const agents = candidate.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('template agents must be a non-empty array');
  }

  const keys: Set<string> = new Set();
  agents.forEach((agent, index) => {
    const spec = validateAgentSpec(agent, `template agent[${index}]`, requirementIds);
    if (keys.has(spec.key)) {
      throw new Error(`template carries duplicate agent key '${spec.key}'`);
    }
    keys.add(spec.key);
    for (const part of spec.prompt) {
      if (part.kind === 'input' && !declaredInputIds.has(part.inputId)) {
        throw new Error(`template agent '${spec.key}' prompt references undeclared input '${part.inputId}'`);
      }
    }
    for (const entry of spec.history ?? []) {
      for (const part of entry.content) {
        if (part.kind === 'input' && !declaredInputIds.has(part.inputId)) {
          throw new Error(
            `template agent '${spec.key}' history references undeclared input '${part.inputId}'`
          );
        }
      }
    }
  });

  if (candidate.seed !== undefined) {
    validateSeedManifest(candidate.seed, 'template seed', keys);
  }

  return candidate as unknown as RealmTemplate;
}

/**
 * Resolves one agent id from its literal pattern and an optional override.
 *
 * Patterns are literal agent ids (validated to carry no placeholder); a
 * per-key override wins over the pattern. The final id must be non-empty and
 * free of unresolved placeholders. Ids are ordinary identifiers: no value is
 * reserved and no id confers authority (Wave I, ticket c02d0b9).
 *
 * @param key - Agent key (for error labels)
 * @param idPattern - Declared literal id pattern
 * @param override - Optional explicit id for this agent key
 * @returns The trimmed, validated agent id
 */
export function resolveAgentId(
  key: string,
  idPattern: string,
  override: string | undefined
): string {
  if (override !== undefined) {
    return assertUsableAgentId(requireNonEmptyString(override, `agent '${key}' id override`).trim(), key);
  }
  return assertUsableAgentId(idPattern.trim(), key);
}

/**
 * Asserts that a resolved id is usable: non-empty and free of unresolved
 * placeholders. Every other value is legal — ids are ordinary labels and
 * confer nothing, so there is no reserved identity (Wave I, ticket c02d0b9).
 *
 * @param id - Trimmed candidate agent id
 * @param key - Agent key (for error labels)
 * @returns The validated id
 */
function assertUsableAgentId(id: string, key: string): string {
  if (id.length === 0) {
    throw new Error(`agent '${key}' resolves to an empty agent id`);
  }
  if (id.includes('{') || id.includes('}')) {
    throw new Error(`agent '${key}' resolves to '${id}' with an unresolved placeholder`);
  }
  return id;
}
