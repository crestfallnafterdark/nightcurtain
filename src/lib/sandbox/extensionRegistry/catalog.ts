/**
 * Pure catalog logic for the `extensionRegistry` module: one frozen catalog
 * projection per discovery, deterministic arbitration across live catalogs,
 * and the reconnect drift diff.
 *
 * Everything here is pure and deterministic — no ambient I/O, no clock, no
 * randomness, no network. Discovery output is mapped to model-facing call
 * names through the canonical `deriveToolCallName` rule; any derived name
 * reserved by the baked/publishing/alias/prototype surface fails the whole
 * catalog closed, and intra-server call-name collisions resolve first-wins
 * with the shadowed server tool recorded (never silently dropped, never
 * suffixed).
 */

import { deriveToolCallName, isReservedToolCallName } from '../tools/normalizers/index.ts';
import { EXTENSION_REGISTRY_ERROR_CODES, ExtensionRegistryError } from './errors.ts';
import { isRecord } from './validate.ts';
import type {
  ExtensionCatalog,
  ExtensionCatalogArbitration,
  ExtensionCatalogArbitrationInput,
  ExtensionCatalogConflict,
  ExtensionCatalogDiff,
  ExtensionCatalogIndexInput,
  ExtensionCatalogShadow,
  ExtensionCatalogTool
} from './types.ts';

/**
 * Version prefix of the catalog digest, so a future algorithm change is
 * detectable instead of silently reinterpreted.
 */
export const EXTENSION_CATALOG_DIGEST_PREFIX = 'extcat1:';

/**
 * Builds a typed catalog error.
 *
 * @param message - Human-readable failure description
 * @returns The typed error
 */
function catalogError(message: string): ExtensionRegistryError {
  return new ExtensionRegistryError(message, EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_CATALOG);
}

/**
 * Builds a typed arbitration error.
 *
 * @param message - Human-readable failure description
 * @returns The typed error
 */
function arbitrationError(message: string): ExtensionRegistryError {
  return new ExtensionRegistryError(message, EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ARBITRATION);
}

/**
 * Validates that one schema value is JSON-compatible and returns its deeply
 * frozen copy: arrays and plain records are copied (records with fresh
 * sorted-independent key order), primitives pass through, and `undefined`
 * object members are omitted. Cycles, non-finite numbers, functions, symbols,
 * bigints, and class instances fail closed — a value reaching a catalog must
 * be exactly what the wire delivered.
 *
 * @param value - Candidate JSON value
 * @param label - Human-readable label used in error messages
 * @returns The deeply frozen copy
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_CATALOG` when the value is not JSON-compatible
 */
function freezeCatalogJson(value: unknown, label: string): unknown {
  const stack = new Set<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw catalogError(`${label} must contain only finite numbers`);
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (stack.has(candidate)) throw catalogError(`${label} must not contain cycles`);
      stack.add(candidate);
      const entries = candidate.map((entry) => normalize(entry));
      stack.delete(candidate);
      return Object.freeze(entries);
    }
    if (isRecord(candidate)) {
      if (stack.has(candidate)) throw catalogError(`${label} must not contain cycles`);
      stack.add(candidate);
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(candidate)) {
        const entry = candidate[key];
        if (entry === undefined) continue;
        copy[key] = normalize(entry);
      }
      stack.delete(candidate);
      return Object.freeze(copy);
    }
    throw catalogError(`${label} must be JSON-serializable`);
  };
  return normalize(value);
}

/**
 * Renders one JSON value in a canonical text form: object keys are sorted
 * recursively and array order is preserved, so two structurally equal values
 * with different key insertion order render identically. The input is
 * expected to already be a frozen catalog JSON projection; the cycle guard is
 * a defensive invariant.
 *
 * @param value - Frozen JSON value
 * @returns Canonical JSON text
 */
function canonicalJsonText(value: unknown): string {
  const stack = new Set<object>();
  const canonicalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw catalogError('Catalog digest input must contain only finite numbers');
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (Array.isArray(candidate)) {
      if (stack.has(candidate)) throw catalogError('Catalog digest input must not contain cycles');
      stack.add(candidate);
      const entries = candidate.map((entry) => canonicalize(entry));
      stack.delete(candidate);
      return entries;
    }
    if (isRecord(candidate)) {
      if (stack.has(candidate)) throw catalogError('Catalog digest input must not contain cycles');
      stack.add(candidate);
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(candidate).sort()) {
        const entry = candidate[key];
        if (entry === undefined) continue;
        copy[key] = canonicalize(entry);
      }
      stack.delete(candidate);
      return copy;
    }
    throw catalogError('Catalog digest input must be JSON-serializable');
  };
  return JSON.stringify(canonicalize(value));
}

/**
 * FNV-1a 32-bit hash over UTF-16 code units, rendered as eight lowercase hex
 * digits. Non-cryptographic by contract: the digest exists to detect catalog
 * change/drift, not to authenticate content.
 *
 * @param text - Canonical JSON text
 * @returns Eight-hex-digit hash
 */
function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Builds one frozen tool projection entry.
 *
 * @param tool - Validated source tool
 * @returns Frozen catalog tool
 */
function toCatalogTool(tool: {
  callName: string;
  serverToolName: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}): ExtensionCatalogTool {
  return Object.freeze({
    callName: tool.callName,
    serverToolName: tool.serverToolName,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: freezeCatalogJson(tool.inputSchema, `Input schema of tool '${tool.serverToolName}'`) }
      : {}),
    ...(tool.outputSchema !== undefined
      ? { outputSchema: freezeCatalogJson(tool.outputSchema, `Output schema of tool '${tool.serverToolName}'`) }
      : {})
  });
}

/**
 * Computes the deterministic non-crypto catalog digest over the canonical JSON
 * of the ordered projection (`tools` plus `shadowedTools`): object key order is
 * normalized, array order is significant, and any tool, schema, description,
 * or shadow change changes the digest. The extension id is deliberately not
 * part of the digest — the same server catalog discovered under a different
 * id yields the same digest, so drift comparison stays extension-local.
 *
 * @param tools - Frozen catalog tools in server order
 * @param shadowedTools - Frozen shadow records in server order
 * @returns Digest text (`extcat1:<8 hex digits>`)
 */
function digestExtensionCatalog(
  tools: readonly ExtensionCatalogTool[],
  shadowedTools: readonly ExtensionCatalogShadow[]
): string {
  const text = canonicalJsonText({
    tools: tools.map((tool) => tool),
    shadowedTools: shadowedTools.map((shadow) => shadow)
  });
  return `${EXTENSION_CATALOG_DIGEST_PREFIX}${fnv1a32Hex(text)}`;
}

/**
 * Builds one frozen catalog projection from one extension's discovery output.
 *
 * Processing is in server order and fully deterministic:
 * 1. every tool derives its model-facing call name through the canonical
 *    `deriveToolCallName` rule;
 * 2. a derived name reserved by the baked/publishing/alias/prototype surface
 *    fails the whole catalog closed with `ERR_EXTENSION_INVALID_CATALOG`,
 *    naming every offending server tool and reserved call name;
 * 3. an intra-server duplicate derived name resolves first-wins — the earlier
 *    server tool keeps the name and the later one is recorded in
 *    `shadowedTools` (never dropped silently, never suffixed);
 * 4. the digest is computed over the canonical ordered projection.
 *
 * The result (including every embedded schema) is deeply frozen.
 *
 * @param input - Extension id plus discovered tools in server order
 * @returns The frozen catalog projection
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_CATALOG` when the input or a tool is malformed or a reserved call name is derived
 *
 * @example
 * ```typescript
 * import { indexExtensionCatalog } from './extensionRegistry/index.ts';
 *
 * const catalog = indexExtensionCatalog({
 *   extensionId: 'acme-scoring',
 *   tools: [{ name: 'text.similarity', inputSchema: { type: 'object' } }]
 * });
 * // catalog.tools[0].callName => 'text_similarity'
 * // catalog.digest => 'extcat1:…'
 * ```
 */
export function indexExtensionCatalog(input: ExtensionCatalogIndexInput): ExtensionCatalog {
  if (!isRecord(input)) {
    throw catalogError('indexExtensionCatalog requires an input object');
  }
  if (typeof input.extensionId !== 'string' || input.extensionId.trim().length === 0) {
    throw catalogError('indexExtensionCatalog requires a non-empty extensionId');
  }
  const extensionId = input.extensionId;
  if (!Array.isArray(input.tools)) {
    throw catalogError(`Extension '${extensionId}' catalog requires a tools array`);
  }

  const tools: ExtensionCatalogTool[] = [];
  const shadowedTools: ExtensionCatalogShadow[] = [];
  const reserved: Array<{ serverToolName: string; callName: string }> = [];
  const claimed = new Set<string>();

  for (const candidate of input.tools) {
    if (!isRecord(candidate) || typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
      throw catalogError(`Extension '${extensionId}' catalog carries a tool without a non-empty name`);
    }
    if (candidate.description !== undefined && typeof candidate.description !== 'string') {
      throw catalogError(`Tool '${candidate.name}' of extension '${extensionId}' carries a non-string description`);
    }
    const serverToolName = candidate.name;
    const callName = deriveToolCallName(serverToolName);
    if (isReservedToolCallName(callName)) {
      reserved.push({ serverToolName, callName });
      continue;
    }
    if (claimed.has(callName)) {
      shadowedTools.push(Object.freeze({ callName, serverToolName }));
      continue;
    }
    claimed.add(callName);
    tools.push(toCatalogTool({
      callName,
      serverToolName,
      ...(candidate.description !== undefined ? { description: candidate.description } : {}),
      ...(candidate.inputSchema !== undefined ? { inputSchema: candidate.inputSchema } : {}),
      ...(candidate.outputSchema !== undefined ? { outputSchema: candidate.outputSchema } : {})
    }));
  }

  if (reserved.length > 0) {
    throw catalogError(
      `Extension '${extensionId}' catalog fails closed on reserved call names: `
      + reserved.map(({ serverToolName, callName }) => `tool '${serverToolName}' derives '${callName}'`).join('; ')
    );
  }

  const frozenTools = Object.freeze(tools);
  const frozenShadows = Object.freeze(shadowedTools);
  return Object.freeze({
    tools: frozenTools,
    shadowedTools: frozenShadows,
    digest: digestExtensionCatalog(frozenTools, frozenShadows)
  });
}

/**
 * Validates one arbitration catalog and returns its ordered call names.
 *
 * @param catalog - Candidate catalog
 * @param extensionId - Owning extension id (for error messages)
 * @returns Frozen call-name list in catalog order
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_ARBITRATION` when the catalog or a call name is malformed
 */
function readArbitrationCallNames(catalog: unknown, extensionId: string): readonly string[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.tools)) {
    throw arbitrationError(`Extension '${extensionId}' arbitration entry requires a catalog with a tools array`);
  }
  const callNames: string[] = [];
  const seen = new Set<string>();
  for (const tool of catalog.tools) {
    if (!isRecord(tool) || typeof tool.callName !== 'string' || tool.callName.length === 0) {
      throw arbitrationError(`Extension '${extensionId}' catalog carries a tool without a non-empty callName`);
    }
    if (seen.has(tool.callName)) {
      throw arbitrationError(`Extension '${extensionId}' catalog carries the duplicate call name '${tool.callName}'`);
    }
    seen.add(tool.callName);
    callNames.push(tool.callName);
  }
  return Object.freeze(callNames);
}

/**
 * Arbitrates a set of live catalogs deterministically into per-extension
 * activation statuses.
 *
 * Entries are processed by ascending connection-completion `sequence` (the
 * only ordering authority; equal sequences order by extension id by UTF-16
 * code units, so the result never depends on map/array insertion order). Each
 * call name is claimed by the first active extension that exposes it; every
 * later extension exposing a claimed name is marked `conflict` with the
 * contested `{ callName, otherExtensionId }` pairs and is **not activated at
 * all** — its non-conflicting call names are withheld too, so a conflicting
 * extension can never silently shadow another. A conflict-free extension is
 * `active` and claims every one of its call names. Intra-server shadowing is
 * already resolved inside each catalog, so it never surfaces as a global
 * conflict.
 *
 * The result is frozen, in sequence order.
 *
 * @param input - Live catalogs with their connection-completion sequences
 * @returns Frozen per-extension arbitration outcomes in sequence order
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_ARBITRATION` when the input is malformed
 *
 * @example
 * ```typescript
 * import { arbitrateExtensionCatalogs } from './extensionRegistry/index.ts';
 *
 * const outcomes = arbitrateExtensionCatalogs([
 *   { extensionId: 'ext-a', sequence: 1, catalog: catalogA },
 *   { extensionId: 'ext-b', sequence: 2, catalog: catalogB }
 * ]);
 * // outcomes => [{ extensionId: 'ext-a', status: 'active', conflicts: [] },
 * //              { extensionId: 'ext-b', status: 'conflict', conflicts: [{ callName: 'shared', otherExtensionId: 'ext-a' }] }]
 * ```
 */
export function arbitrateExtensionCatalogs(
  input: readonly ExtensionCatalogArbitrationInput[]
): readonly ExtensionCatalogArbitration[] {
  if (!Array.isArray(input)) {
    throw arbitrationError('arbitrateExtensionCatalogs requires an array');
  }

  const entries: Array<{ extensionId: string; sequence: number; callNames: readonly string[] }> = [];
  const seenIds = new Set<string>();
  for (const candidate of input) {
    if (!isRecord(candidate)) {
      throw arbitrationError('arbitration entries must be objects');
    }
    if (typeof candidate.extensionId !== 'string' || candidate.extensionId.trim().length === 0) {
      throw arbitrationError('arbitration entries require a non-empty extensionId');
    }
    if (typeof candidate.sequence !== 'number' || !Number.isFinite(candidate.sequence)) {
      throw arbitrationError(`Extension '${candidate.extensionId}' arbitration entry requires a finite sequence`);
    }
    if (seenIds.has(candidate.extensionId)) {
      throw arbitrationError(`arbitration input carries the duplicate extension id '${candidate.extensionId}'`);
    }
    seenIds.add(candidate.extensionId);
    entries.push({
      extensionId: candidate.extensionId,
      sequence: candidate.sequence,
      callNames: readArbitrationCallNames(candidate.catalog, candidate.extensionId)
    });
  }

  entries.sort((a, b) => (
    a.sequence - b.sequence
    || (a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0)
  ));

  const claimed = new Map<string, string>();
  const outcomes: ExtensionCatalogArbitration[] = [];
  for (const entry of entries) {
    const conflicts: ExtensionCatalogConflict[] = [];
    for (const callName of entry.callNames) {
      const owner = claimed.get(callName);
      if (owner !== undefined) {
        conflicts.push(Object.freeze({ callName, otherExtensionId: owner }));
      }
    }
    if (conflicts.length > 0) {
      outcomes.push(Object.freeze({
        extensionId: entry.extensionId,
        status: 'conflict' as const,
        conflicts: Object.freeze(conflicts)
      }));
      continue;
    }
    for (const callName of entry.callNames) {
      claimed.set(callName, entry.extensionId);
    }
    outcomes.push(Object.freeze({
      extensionId: entry.extensionId,
      status: 'active' as const,
      conflicts: Object.freeze([])
    }));
  }
  return Object.freeze(outcomes);
}

/**
 * Reads one catalog's tools into a call-name → canonical-tool-text map.
 *
 * @param catalog - Candidate catalog
 * @param label - Human-readable label used in error messages
 * @returns Ordered call names plus a canonical-text lookup
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_CATALOG` when the catalog is malformed
 */
function readCatalogTools(catalog: unknown, label: string): {
  callNames: readonly string[];
  canonicalByCallName: ReadonlyMap<string, string>;
} {
  if (!isRecord(catalog) || !Array.isArray(catalog.tools)) {
    throw catalogError(`${label} must be a catalog with a tools array`);
  }
  const callNames: string[] = [];
  const canonicalByCallName = new Map<string, string>();
  for (const tool of catalog.tools) {
    if (!isRecord(tool) || typeof tool.callName !== 'string' || tool.callName.length === 0) {
      throw catalogError(`${label} carries a tool without a non-empty callName`);
    }
    if (canonicalByCallName.has(tool.callName)) {
      throw catalogError(`${label} carries the duplicate call name '${tool.callName}'`);
    }
    canonicalByCallName.set(tool.callName, canonicalJsonText(tool));
    callNames.push(tool.callName);
  }
  return { callNames: Object.freeze(callNames), canonicalByCallName };
}

/**
 * Reads one catalog's shadow records into an ordered call-name list.
 *
 * @param catalog - Candidate catalog
 * @param label - Human-readable label used in error messages
 * @returns Frozen shadow call names in catalog order
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_CATALOG` when a shadow record is malformed
 */
function readShadowCallNames(catalog: unknown, label: string): readonly string[] {
  if (!isRecord(catalog) || catalog.shadowedTools === undefined) return Object.freeze([]);
  if (!Array.isArray(catalog.shadowedTools)) {
    throw catalogError(`${label} shadowedTools must be an array when present`);
  }
  const callNames: string[] = [];
  for (const shadow of catalog.shadowedTools) {
    if (!isRecord(shadow) || typeof shadow.callName !== 'string' || shadow.callName.length === 0) {
      throw catalogError(`${label} carries a shadow record without a non-empty callName`);
    }
    callNames.push(shadow.callName);
  }
  return Object.freeze(callNames);
}

/**
 * Computes the reconnect drift diff between the previous and the new catalog
 * of one extension.
 *
 * `added`/`removed`/`changed` carry call names (changed = same call name whose
 * canonical tool projection differs, including the wire name, description, or
 * any schema byte); `shadowedAdded`/`shadowedRemoved` disclose intra-server
 * shadow-set changes; `reordered` reports a changed relative order of the
 * common call names; `digests.previous`/`digests.next` carry the digest pair
 * (`previous` is `null` when no previous catalog existed). Added/changed names
 * follow new-catalog order, removed/shadowed-removed names follow
 * previous-catalog order.
 *
 * @param previous - Previous catalog, or `null` when there was none
 * @param next - New catalog
 * @returns The frozen drift disclosure
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_CATALOG` when either catalog is malformed
 *
 * @example
 * ```typescript
 * import { diffExtensionCatalogs } from './extensionRegistry/index.ts';
 *
 * const diff = diffExtensionCatalogs(previousCatalog, nextCatalog);
 * // diff.added/removed/changed => call-name sets; diff.digests => { previous, next }
 * ```
 */
export function diffExtensionCatalogs(
  previous: ExtensionCatalog | null,
  next: ExtensionCatalog
): ExtensionCatalogDiff {
  const nextRead = readCatalogTools(next, 'diffExtensionCatalogs next catalog');
  const previousRead = previous === null || previous === undefined
    ? null
    : readCatalogTools(previous, 'diffExtensionCatalogs previous catalog');
  const nextShadows = readShadowCallNames(next, 'diffExtensionCatalogs next catalog');
  const previousShadows = previous === null || previous === undefined
    ? Object.freeze([] as string[])
    : readShadowCallNames(previous, 'diffExtensionCatalogs previous catalog');

  const previousNames = previousRead === null ? new Set<string>() : new Set(previousRead.callNames);
  const nextNames = new Set(nextRead.callNames);

  const added = nextRead.callNames.filter((callName) => !previousNames.has(callName));
  const removed = previousRead === null
    ? []
    : previousRead.callNames.filter((callName) => !nextNames.has(callName));
  const changed = nextRead.callNames.filter((callName) => {
    if (!previousNames.has(callName) || previousRead === null) return false;
    return previousRead.canonicalByCallName.get(callName) !== nextRead.canonicalByCallName.get(callName);
  });

  const previousShadowNames = new Set(previousShadows);
  const nextShadowNames = new Set(nextShadows);
  const shadowedAdded = nextShadows.filter((callName) => !previousShadowNames.has(callName));
  const shadowedRemoved = previousShadows.filter((callName) => !nextShadowNames.has(callName));

  const previousCommon = previousRead === null
    ? []
    : previousRead.callNames.filter((callName) => nextNames.has(callName));
  const nextCommon = nextRead.callNames.filter((callName) => previousNames.has(callName));
  const reordered = previousCommon.length === nextCommon.length
    && previousCommon.some((callName, index) => callName !== nextCommon[index]);

  const previousDigest = isRecord(previous) && typeof previous.digest === 'string' ? previous.digest : null;
  const nextDigest = isRecord(next) && typeof next.digest === 'string' ? next.digest : null;
  if (nextDigest === null) {
    throw catalogError('diffExtensionCatalogs next catalog must carry a string digest');
  }

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    shadowedAdded: Object.freeze(shadowedAdded),
    shadowedRemoved: Object.freeze(shadowedRemoved),
    reordered,
    digests: Object.freeze({ previous: previousDigest, next: nextDigest })
  });
}
