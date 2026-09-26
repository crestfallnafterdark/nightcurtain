/**
 * Canonical catalog-reflection descriptors (M5a meta-plane spec §6.1, ticket
 * `abec3a9`): `list_tools`, `list_tool_presets`, and `describe_preset`.
 *
 * These three tools are **canonical** ordinary tools (not authority tools):
 * they are innate read-only primitives placed with `describe_tool` per the
 * Wave 1 taxonomy (the `precall` family, present in every named tier), carry
 * no authority gate, and are never members of an authority registry.
 *
 * Fidelity and bounds:
 *
 * - `list_tools` enumerates exactly the canonical baked catalog — every
 *   `ALL_TOOL_DESCRIPTORS` entry the dispatcher seeds into the execution
 *   context, in canonical declaration order — and never an authority meta
 *   tool, extension call name, or host-only surface. Each entry carries only
 *   `name`, `family`, `mutating`, and a one-line description bounded to
 *   {@link CATALOG_TOOL_DESCRIPTION_MAX_CHARS}.
 * - `list_tool_presets` and `describe_preset` read the generated Wave 1
 *   `TOOL_PRESETS` catalog directly (ids, counts, members) — never a hardcoded
 *   literal — so tier membership can never drift from the frozen taxonomy.
 * - All three receipt shapes are closed (exact keys), realm-opaque (no realm
 *   ids, paths, extension vocabulary, or authority ids), and free of schemas,
 *   configuration, histories, and allowlists.
 */

import {
  SANDBOX_TOOLS,
  TOOL_FAMILIES,
  TOOL_PRESETS,
  TOOL_SYSTEM_ERROR_CODES,
  isMutatingTool
} from '../constants/index.ts';
import { toSnakeCase } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a catalog descriptor handler. */
type ToolParams = Record<string, unknown>;

/**
 * Per-entry description bound for `list_tools`: each listed tool's LLM-facing
 * description is truncated to this many characters (with a single trailing
 * `…` when cut), so the full canonical listing stays serialization-bounded.
 * The complete description remains available through `describe_tool`.
 */
export const CATALOG_TOOL_DESCRIPTION_MAX_CHARS = 160;

/** Prototype-mutating key names dropped by the catalog sanitizers. @internal */
const PROTOTYPE_POLLUTION_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);

/** Shared empty alias map for the parameterless catalog tools. @internal */
const EMPTY_ALIAS_MAP: Readonly<Record<string, string>> = Object.freeze({});

/**
 * `describe_preset` parameter alias map: preset-id spellings normalize to the
 * canonical `preset` key; every other key passes through verbatim so the
 * handler can reject it explicitly.
 * @internal
 */
const describePresetParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  preset: 'preset',
  preset_id: 'preset',
  presetId: 'preset',
  id: 'preset',
  name: 'preset',
  tier: 'preset'
});

/**
 * Catalog parameter sanitizer: normalizes alias keys through the supplied map
 * while preserving unknown keys and `null` values so the handler can classify
 * them explicitly (an unknown parameter must fail the whole call, never be
 * silently dropped). Total and prototype-pollution-safe.
 *
 * @param rawArgs - Raw tool arguments (object, JSON string, or arbitrary value).
 * @param aliasMap - Parameter alias map for the specific tool.
 * @returns A fresh sanitized parameter record.
 * @internal
 */
function sanitizeCatalogParams(
  rawArgs: unknown,
  aliasMap: Readonly<Record<string, string>>
): Record<string, unknown> {
  let parsedArgs: unknown = rawArgs;
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        parsedArgs = JSON.parse(trimmed);
      } catch {
        parsedArgs = null;
      }
    } else {
      parsedArgs = null;
    }
  }
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return {};
  const result: Record<string, unknown> = {};
  try {
    for (const [key, value] of Object.entries(parsedArgs)) {
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
      if (value === undefined) continue;
      const snakeKey = toSnakeCase(key);
      const alias = Object.prototype.hasOwnProperty.call(aliasMap, key)
        ? aliasMap[key]
        : (snakeKey && Object.prototype.hasOwnProperty.call(aliasMap, snakeKey)
          ? aliasMap[snakeKey]
          : key);
      if (!alias || PROTOTYPE_POLLUTION_KEYS.has(alias)) continue;
      result[alias] = value;
    }
  } catch {
    // A hostile accessor or proxy trap must never escape the sanitizer.
    return {};
  }
  return result;
}

/**
 * Builds a structured `INVALID_ARGUMENTS` failure receipt.
 *
 * @param message - Human-readable failure description.
 * @returns A failure receipt in the tool-system vocabulary.
 * @internal
 */
function invalidArguments(message: string): { success: false; error: string; code: string } {
  return { success: false, error: message, code: TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS };
}

/**
 * Truncates one descriptor description to the bounded one-line form.
 *
 * @param description - Full descriptor description.
 * @returns The bounded description (unchanged when already short enough).
 * @internal
 */
function boundedDescription(description: string): string {
  if (description.length <= CATALOG_TOOL_DESCRIPTION_MAX_CHARS) return description;
  return `${description.slice(0, CATALOG_TOOL_DESCRIPTION_MAX_CHARS - 1)}\u2026`;
}

/** Registry-entry fields read by the `list_tools` handler. @internal */
interface CatalogRegistryEntry {
  name?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

/**
 * `list_tools` descriptor — canonical read-only enumeration of the baked tool
 * catalog. Returns every canonical descriptor (never an authority meta tool or
 * extension call name) with its family, mutation class, and a bounded
 * one-line description; no schemas, configuration, histories, or allowlists.
 */
export const listToolsDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.LIST_TOOLS,
  description:
    'List the canonical baked tools available in this sandbox, in declaration order: each entry carries the tool name, '
    + 'its capability family, whether invoking it can mutate sandbox state, and a one-line description. '
    + 'The listing covers the full non-authority catalog and never carries schemas, configuration, or runtime state; '
    + 'use describe_tool for one tool\'s full schema and documentation.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [] as string[],
    additionalProperties: false
  }),
  paramAliasMap: EMPTY_ALIAS_MAP,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeCatalogParams(rawArgs, EMPTY_ALIAS_MAP),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const registry = context?.toolRegistry as Record<string, CatalogRegistryEntry> | undefined;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new Error('toolRegistry service is not available in execution context');
    }
    const keys = Object.keys(params || {});
    if (keys.length > 0) {
      // Static message: an unknown parameter never echoes its key.
      return invalidArguments('list_tools does not accept parameters.');
    }
    const tools: Array<{ name: string; family: string; mutating: boolean; description: string }> = [];
    for (const name of Object.values(SANDBOX_TOOLS)) {
      const entry = Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : null;
      if (!entry || typeof entry !== 'object') continue;
      tools.push({
        name,
        family: TOOL_FAMILIES[name],
        mutating: isMutatingTool(name),
        description: boundedDescription(typeof entry.description === 'string' ? entry.description : '')
      });
    }
    return { success: true, count: tools.length, tools };
  }
});
/** camelCase alias of `listToolsDescriptor`. */
export const listTools = listToolsDescriptor;
/** snake_case alias of `listToolsDescriptor`. */
export const list_tools = listToolsDescriptor;

/**
 * `list_tool_presets` descriptor — canonical read-only listing of the
 * generated Wave 1 capability presets: each preset id with its member count.
 * The catalog is read from the frozen `TOOL_PRESETS` source, never a literal.
 */
export const listToolPresetsDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.LIST_TOOL_PRESETS,
  description:
    'List the generated capability presets (tool tiers) usable for agent tool policy, each with the number of tools it grants. '
    + 'Preset ids are the exact spellings the lifecycle accepts; use describe_preset to inspect one tier\'s members.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [] as string[],
    additionalProperties: false
  }),
  paramAliasMap: EMPTY_ALIAS_MAP,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeCatalogParams(rawArgs, EMPTY_ALIAS_MAP),
  handler: async (params: ToolParams) => {
    const keys = Object.keys(params || {});
    if (keys.length > 0) {
      // Static message: an unknown parameter never echoes its key.
      return invalidArguments('list_tool_presets does not accept parameters.');
    }
    const presets = Object.keys(TOOL_PRESETS).map((id) => Object.freeze({
      id,
      count: TOOL_PRESETS[id as keyof typeof TOOL_PRESETS].length
    }));
    return Object.freeze({ success: true, count: presets.length, presets: Object.freeze(presets) });
  }
});
/** camelCase alias of `listToolPresetsDescriptor`. */
export const listToolPresets = listToolPresetsDescriptor;
/** snake_case alias of `listToolPresetsDescriptor`. */
export const list_tool_presets = listToolPresetsDescriptor;

/**
 * `describe_preset` descriptor — canonical read-only expansion of one
 * generated capability preset into its exact frozen members (the wildcard
 * `all` preset reports `['*']`). Unknown ids fail closed as malformed.
 */
export const describePresetDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.DESCRIBE_PRESET,
  description:
    'Describe one generated capability preset (tool tier) by id: the exact canonical tool members it grants and their count. '
    + 'The wildcard preset reports [\'*\']. Use list_tool_presets to discover the preset ids.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        description: 'Capability preset id to describe (e.g. manager, collaborator, readonly).'
      }
    },
    required: ['preset'],
    additionalProperties: false
  }),
  paramAliasMap: describePresetParamAliasMap,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeCatalogParams(rawArgs, describePresetParamAliasMap),
  handler: async (params: ToolParams) => {
    const keys = Object.keys(params || {});
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== 'preset') {
        // Static message: an unknown parameter never echoes its key.
        return invalidArguments('describe_preset does not accept unknown parameters.');
      }
    }
    const raw = params?.preset;
    if (typeof raw !== 'string' || !raw.trim()) {
      return invalidArguments("describe_preset: 'preset' is required and must be a non-empty string.");
    }
    const preset = raw.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(TOOL_PRESETS, preset)) {
      // Static message: an unknown preset id is never echoed.
      return invalidArguments('describe_preset: unknown preset id.');
    }
    const members = TOOL_PRESETS[preset as keyof typeof TOOL_PRESETS];
    return Object.freeze({
      success: true,
      preset,
      count: members.length,
      members: Object.freeze([...members])
    });
  }
});
/** camelCase alias of `describePresetDescriptor`. */
export const describePreset = describePresetDescriptor;
/** snake_case alias of `describePresetDescriptor`. */
export const describe_preset = describePresetDescriptor;

/**
 * Array of the three M5a canonical catalog-reflection descriptors, appended to
 * the canonical `ALL_TOOL_DESCRIPTORS` catalog by `tools/descriptors/index.ts`.
 */
export const catalogToolDescriptors = Object.freeze([
  listToolsDescriptor,
  listToolPresetsDescriptor,
  describePresetDescriptor
]);
