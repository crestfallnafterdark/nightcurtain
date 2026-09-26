/**
 * Input-schema projection for dynamically discovered extension tools.
 *
 * Third-party MCP servers describe tool inputs with Draft 2019-09/2020-12
 * schemas that routinely use features the sandbox's model-facing dialect does
 * not carry: local `$ref`/`$defs` indirection, nullable/multi-branch unions,
 * `allOf` composition, and free-form objects. This module is the pure, total,
 * lossy projector between the two worlds. It never throws on schema content:
 * every rewrite or omission is recorded as a frozen
 * {@link ExtensionSchemaWarning} carrying a stable code and a `#`-rooted JSON
 * Pointer path, and only a schema the projector genuinely cannot represent is
 * refused per tool with a frozen {@link ExtensionSchemaRefusal}.
 *
 * The projector is deterministic (same input value → structurally identical
 * frozen output and warning list), prototype-pollution-safe (the
 * `__proto__`/`constructor`/`prototype` vocabulary is dropped everywhere and
 * no output object can gain an inherited property), and budget-bounded
 * (depth and dereference counts are capped by module constants, exceeding
 * either refuses the tool instead of emitting a partial schema).
 */

/**
 * Frozen dictionary of the stable warning codes the projector records.
 *
 * Every code names one projection decision:
 * - `ref-deref` — a local `$ref` was resolved in place.
 * - `ref-cycle-cut` — a `$ref` cycle was cut to a permissive node.
 * - `nullable-unwrapped` — a nullable union/type array was unwrapped.
 * - `union-widened` — a multi-branch union was widened to a looser shape.
 * - `allof-merged` — `allOf` branches were shallow-merged (later wins).
 * - `keyword-dropped` — an unsupported keyword/value was omitted.
 * - `metadata-dropped` — a benign JSON-Schema annotation (a title or other
 *   non-validation metadata keyword) was omitted; recorded additively because
 *   the survey classifies these as normalization, not loss.
 * - `additional-properties-defaulted` — a missing `additionalProperties` was
 *   defaulted to `false` because properties were declared.
 * - `description-defaulted` — a named property's missing/blank description was
 *   synthesized.
 * - `freeform-object` — a free-form object stays permissive (recorded once
 *   per projected tool, never once per node).
 *
 * @example
 * ```typescript
 * import { EXTENSION_SCHEMA_WARNING_CODES, projectExtensionInputSchema } from './tools/extensionTools/index.ts';
 *
 * const projection = projectExtensionInputSchema({ type: 'object', properties: { q: { type: 'string' } } });
 * if (projection.status === 'projected') {
 *   console.log(projection.warnings.some((warning) => warning.code === EXTENSION_SCHEMA_WARNING_CODES.DESCRIPTION_DEFAULTED));
 * }
 * ```
 */
export const EXTENSION_SCHEMA_WARNING_CODES: Readonly<{
  /** A local `$ref` was resolved in place. */
  readonly REF_DEREF: 'ref-deref';
  /** A `$ref` cycle was cut to a permissive node. */
  readonly REF_CYCLE_CUT: 'ref-cycle-cut';
  /** A nullable union or nullable `type` array was unwrapped to its non-null shape. */
  readonly NULLABLE_UNWRAPPED: 'nullable-unwrapped';
  /** A multi-branch `anyOf`/`oneOf` was widened to a looser shape. */
  readonly UNION_WIDENED: 'union-widened';
  /** `allOf` branches were shallow-merged with later keys winning. */
  readonly ALLOF_MERGED: 'allof-merged';
  /** An unsupported keyword, keyword value, or malformed entry was dropped. */
  readonly KEYWORD_DROPPED: 'keyword-dropped';
  /** A benign JSON-Schema annotation was dropped (normalization, never loss). */
  readonly METADATA_DROPPED: 'metadata-dropped';
  /** A missing `additionalProperties` was defaulted to `false` because properties were present. */
  readonly ADDITIONAL_PROPERTIES_DEFAULTED: 'additional-properties-defaulted';
  /** A missing or blank description was replaced with the synthesized default. */
  readonly DESCRIPTION_DEFAULTED: 'description-defaulted';
  /** A free-form object stays permissive; recorded once per projected tool. */
  readonly FREEFORM_OBJECT: 'freeform-object';
}> = Object.freeze({
  REF_DEREF: 'ref-deref',
  REF_CYCLE_CUT: 'ref-cycle-cut',
  NULLABLE_UNWRAPPED: 'nullable-unwrapped',
  UNION_WIDENED: 'union-widened',
  ALLOF_MERGED: 'allof-merged',
  KEYWORD_DROPPED: 'keyword-dropped',
  METADATA_DROPPED: 'metadata-dropped',
  ADDITIONAL_PROPERTIES_DEFAULTED: 'additional-properties-defaulted',
  DESCRIPTION_DEFAULTED: 'description-defaulted',
  FREEFORM_OBJECT: 'freeform-object'
} as const);

/**
 * Union of the stable projection warning codes; the values of
 * {@link EXTENSION_SCHEMA_WARNING_CODES}.
 */
export type ExtensionSchemaWarningCode =
  typeof EXTENSION_SCHEMA_WARNING_CODES[keyof typeof EXTENSION_SCHEMA_WARNING_CODES];

/**
 * Frozen dictionary of the per-tool refusal codes: the only reasons a tool's
 * input schema produces no descriptor.
 *
 * - `malformed-schema` — the value is not JSON-compatible (cyclic, non-finite,
 *   function/symbol/bigint member) or a non-object JSON root was supplied.
 * - `unsupported-root` — the schema root does not describe an object (a
 *   non-object `type`, an unsatisfiable boolean subschema).
 * - `unresolvable-ref` — a `$ref` is non-local, non-string, or points at a
 *   location that does not exist in the schema document.
 * - `depth-budget` — nesting exceeds `EXTENSION_SCHEMA_MAX_DEPTH`.
 * - `ref-budget` — dereferencing exceeds `EXTENSION_SCHEMA_MAX_REFS`.
 *
 * @example
 * ```typescript
 * import { EXTENSION_SCHEMA_REFUSAL_CODES, projectExtensionInputSchema } from './tools/extensionTools/index.ts';
 *
 * const projection = projectExtensionInputSchema({ type: 'string' });
 * if (projection.status === 'refused') {
 *   console.log(projection.refusal.code === EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT);
 * }
 * ```
 */
export const EXTENSION_SCHEMA_REFUSAL_CODES: Readonly<{
  /** The schema value is not JSON-compatible or is a non-object JSON root. */
  readonly MALFORMED_SCHEMA: 'malformed-schema';
  /** The schema root does not describe an object input. */
  readonly UNSUPPORTED_ROOT: 'unsupported-root';
  /** A `$ref` cannot be resolved against the schema document. */
  readonly UNRESOLVABLE_REF: 'unresolvable-ref';
  /** Projection nesting exceeds the depth budget. */
  readonly DEPTH_BUDGET: 'depth-budget';
  /** Dereferencing exceeds the reference budget. */
  readonly REF_BUDGET: 'ref-budget';
}> = Object.freeze({
  MALFORMED_SCHEMA: 'malformed-schema',
  UNSUPPORTED_ROOT: 'unsupported-root',
  UNRESOLVABLE_REF: 'unresolvable-ref',
  DEPTH_BUDGET: 'depth-budget',
  REF_BUDGET: 'ref-budget'
} as const);

/**
 * Union of the per-tool refusal codes; the values of
 * {@link EXTENSION_SCHEMA_REFUSAL_CODES}.
 */
export type ExtensionSchemaRefusalCode =
  typeof EXTENSION_SCHEMA_REFUSAL_CODES[keyof typeof EXTENSION_SCHEMA_REFUSAL_CODES];

/**
 * Maximum projected nesting depth (root is depth 0). A schema that would nest
 * deeper is refused with `depth-budget` rather than projected partially; the
 * observed ecosystem maximum stays well below this cap.
 */
export const EXTENSION_SCHEMA_MAX_DEPTH = 12;

/**
 * Maximum number of `$ref` dereferences in one tool projection. Exceeding the
 * budget refuses the tool with `ref-budget`; the observed ecosystem maximum
 * stays well below this cap.
 */
export const EXTENSION_SCHEMA_MAX_REFS = 200;

/**
 * One recorded projection decision: a stable code plus the `#`-rooted JSON
 * Pointer to the schema location it applies to (for example
 * `#/properties/regionUrl` or `#/properties/q/pattern`). Warnings never echo
 * arbitrary schema text.
 */
export interface ExtensionSchemaWarning {
  /** Stable warning code from {@link EXTENSION_SCHEMA_WARNING_CODES}. */
  readonly code: ExtensionSchemaWarningCode;
  /** `#`-rooted JSON Pointer to the location the warning applies to. */
  readonly path: string;
}

/**
 * Per-tool refusal reason for a schema the projector cannot represent.
 */
export interface ExtensionSchemaRefusal {
  /** Stable refusal code from {@link EXTENSION_SCHEMA_REFUSAL_CODES}. */
  readonly code: ExtensionSchemaRefusalCode;
  /** `#`-rooted JSON Pointer to the refusing location, when known. */
  readonly path?: string;
}

/**
 * One projected schema node in the model-facing subset.
 *
 * The shape is a sibling of `JsonSchemaDraft07` rather than a widening of it:
 * the baked dialect stays strict, while a projected node may omit `type` (an
 * unconstrained value), carry a multi-type array, and default descriptions.
 */
export interface ExtensionToolSchemaNode {
  /** JSON type token or multi-type array; absent on an unconstrained node. */
  readonly type?: string | readonly string[];
  /** Human-readable description; always present (a default is synthesized). */
  readonly description: string;
  /** Allowed values, when the source declared a non-empty `enum`. */
  readonly enum?: readonly unknown[];
  /** Element schema for `array` nodes. */
  readonly items?: ExtensionToolSchemaNode;
  /** Property map for `object` nodes; absent on non-object nodes. */
  readonly properties?: Readonly<Record<string, ExtensionToolSchemaNode>>;
  /** Property names the server requires for `object` nodes. */
  readonly required?: readonly string[];
  /**
   * Whether undeclared keys are legal for `object` nodes: `true`/`false`, or a
   * schema describing the permitted additional values.
   */
  readonly additionalProperties?: boolean | ExtensionToolSchemaNode;
  /** Known advisory format, when the source declared one the dialect keeps. */
  readonly format?: string;
}

/**
 * Projected root schema of one extension tool input: always an object root
 * with a property map and an explicit `additionalProperties` decision.
 */
export interface ExtensionToolSchema {
  /** Root type discriminator (always `'object'`). */
  readonly type: 'object';
  /** Root description, when the source supplied one. */
  readonly description?: string;
  /** Root property map (empty when the source declared no properties). */
  readonly properties: Readonly<Record<string, ExtensionToolSchemaNode>>;
  /** Root required property names, when the source declared any. */
  readonly required?: readonly string[];
  /** Root open/closed decision: boolean or a schema for additional values. */
  readonly additionalProperties: boolean | ExtensionToolSchemaNode;
}

/**
 * Successful projection: the model-facing schema plus every recorded warning.
 */
export interface ExtensionSchemaProjectionProjected {
  /** Projection status discriminator. */
  readonly status: 'projected';
  /** Frozen model-facing object schema. */
  readonly schema: ExtensionToolSchema;
  /** Frozen warnings in emission order (possibly empty). */
  readonly warnings: readonly ExtensionSchemaWarning[];
}

/**
 * Refused projection: no descriptor is produced for a refused tool.
 */
export interface ExtensionSchemaProjectionRefused {
  /** Projection status discriminator. */
  readonly status: 'refused';
  /** Frozen refusal reason. */
  readonly refusal: ExtensionSchemaRefusal;
  /** Frozen warnings recorded before the refusal. */
  readonly warnings: readonly ExtensionSchemaWarning[];
}

/**
 * Frozen union of the two projection outcomes.
 */
export type ExtensionSchemaProjection =
  | ExtensionSchemaProjectionProjected
  | ExtensionSchemaProjectionRefused;

/**
 * Synthesized description for a schema node whose source omitted one. Kept
 * deliberately content-free: no server text is invented.
 */
const DEFAULT_NODE_DESCRIPTION = 'No description provided by the server.';

/** JSON type tokens the model-facing dialect carries. */
const JSON_TYPE_TOKENS: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null'
]);

/**
 * Advisory `format` values kept on projected nodes; everything else is
 * dropped with a warning because the dialect only documents these.
 */
const KNOWN_FORMAT_VALUES: ReadonlySet<string> = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'uuid',
  'regex',
  'json-pointer'
]);

/** Prototype-chain property names that may never survive projection. */
const PROTOTYPE_PROPERTY_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Node keys the projector understands; everything else is dropped. */
const SUPPORTED_NODE_KEYS: ReadonlySet<string> = new Set([
  'type',
  'description',
  'enum',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'format'
]);

/** Keys consumed by the dereference pass and never copied to output. */
const REFERENCE_KEYS: ReadonlySet<string> = new Set(['$ref', '$defs', 'definitions']);

/**
 * Benign JSON-Schema annotations the model-facing dialect does not carry.
 * Dropping one of these is additive normalization, not semantic loss (the
 * ecosystem survey's "additive normalization, not loss" bucket): none of them
 * constrains an argument value, so they are recorded as `metadata-dropped` and
 * never push a catalog toward the degraded fidelity state.
 */
const METADATA_ANNOTATION_KEYS: ReadonlySet<string> = new Set([
  'title',
  '$schema',
  '$id',
  '$comment',
  'default',
  'examples',
  'deprecated'
]);

/** Mutable projection node used internally; deep-frozen at the boundary. */
interface MutableSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: MutableSchemaNode;
  properties?: Record<string, MutableSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | MutableSchemaNode;
  format?: string;
}

/** Mutable projection state shared across one `projectExtensionInputSchema` call. */
interface ProjectionContext {
  root: Record<string, unknown>;
  warnings: ExtensionSchemaWarning[];
  seenWarnings: Set<string>;
  refStack: string[];
  refs: number;
  freeformWarned: boolean;
}

/**
 * Internal control-flow signal carrying a refusal reason; caught at the public
 * boundary and converted into an {@link ExtensionSchemaProjectionRefused}.
 */
class ProjectionRefusal extends Error {
  readonly refusalCode: ExtensionSchemaRefusalCode;
  readonly refusalPath: string | undefined;

  /**
   * @param code - Stable refusal code.
   * @param path - `#`-rooted JSON Pointer to the refusing location.
   */
  constructor(code: ExtensionSchemaRefusalCode, path?: string) {
    super(path === undefined ? code : `${code} at ${path}`);
    this.name = 'ProjectionRefusal';
    this.refusalCode = code;
    this.refusalPath = path;
  }
}

/**
 * Reports whether a value is a plain JSON record (object literal or
 * `Object.create(null)`), never a class instance or other exotic object.
 *
 * @param value - Candidate value.
 * @returns `true` when the value is a plain record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reports whether an object carries an own (non-inherited) key.
 *
 * @param value - Candidate record.
 * @param key - Property key.
 * @returns `true` when the key is an own property.
 */
function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Assigns one own enumerable key without ever invoking a prototype accessor;
 * used for every projected key so no copied object can gain an inherited
 * property.
 *
 * @param target - Mutable target record.
 * @param key - Property key.
 * @param value - Property value.
 */
function setOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Clones one JSON-compatible value into a fresh tree of own-key-defined
 * objects and arrays, so projected outputs never share (or freeze) a
 * caller-owned member. The argument is expected to have passed
 * {@link assertJsonCompatible}; accessor members were already refused.
 *
 * @param value - JSON-compatible value to clone.
 * @returns A fresh deep copy (primitives pass through unchanged).
 */
function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    setOwnKey(copy, key, cloneJsonValue((value as Record<string, unknown>)[key]));
  }
  return copy;
}

/**
 * Escapes one JSON Pointer reference token.
 *
 * @param token - Raw key or index text.
 * @returns Escaped token (`~0`/`~1`).
 */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Appends one child location to a `#`-rooted JSON Pointer path.
 *
 * @param path - Parent pointer.
 * @param segments - Child key/index segments.
 * @returns The joined pointer.
 */
function joinSchemaPath(path: string, ...segments: Array<string | number>): string {
  let result = path;
  for (const segment of segments) {
    result += `/${escapePointerToken(String(segment))}`;
  }
  return result;
}

/**
 * Records one warning unless the exact `(code, path)` pair was already
 * recorded for this tool.
 *
 * @param ctx - Projection context.
 * @param code - Stable warning code.
 * @param path - `#`-rooted JSON Pointer.
 */
function addWarning(ctx: ProjectionContext, code: ExtensionSchemaWarningCode, path: string): void {
  const key = `${code}\u0000${path}`;
  if (ctx.seenWarnings.has(key)) return;
  ctx.seenWarnings.add(key);
  ctx.warnings.push({ code, path });
}

/**
 * Records the free-form-object disclosure at most once per projected tool.
 *
 * @param ctx - Projection context.
 * @param path - `#`-rooted JSON Pointer of the first free-form node.
 */
function addFreeformWarning(ctx: ProjectionContext, path: string): void {
  if (ctx.freeformWarned) return;
  ctx.freeformWarned = true;
  addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.FREEFORM_OBJECT, path);
}

/**
 * Records one dropped keyword with its classification: benign annotations
 * (`title`, `$schema`, `$id`, `$comment`, `default`, `examples`, `deprecated`)
 * are `metadata-dropped` — dropped exactly as before, but recorded as additive
 * normalization rather than semantic projection — while every other drop stays
 * `keyword-dropped`.
 *
 * @param ctx - Projection context.
 * @param path - `#`-rooted JSON Pointer of the dropped keyword's node.
 * @param key - Dropped keyword name.
 */
function addDroppedKeywordWarning(ctx: ProjectionContext, path: string, key: string): void {
  addWarning(
    ctx,
    METADATA_ANNOTATION_KEYS.has(key)
      ? EXTENSION_SCHEMA_WARNING_CODES.METADATA_DROPPED
      : EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED,
    joinSchemaPath(path, key)
  );
}

/**
 * Throws the internal refusal signal; never escapes the public boundary.
 *
 * @param code - Stable refusal code.
 * @param path - `#`-rooted JSON Pointer to the refusing location.
 * @returns Never returns.
 * @throws {@link ProjectionRefusal} Always.
 */
function refuse(code: ExtensionSchemaRefusalCode, path?: string): never {
  throw new ProjectionRefusal(code, path);
}

/**
 * Validates that one schema value is JSON-compatible and cycle-free using an
 * iterative walk, so deeply nested or hostile documents cannot overflow the
 * stack before the depth budget applies. Own enumerable accessor members are
 * refused without being executed, so a hostile getter can never break the
 * projector's never-throw contract.
 *
 * @param root - Candidate schema document.
 * @throws {@link ProjectionRefusal} With `malformed-schema` when the value
 *   contains a cycle, a non-finite number, a non-JSON member, or an accessor
 *   member.
 */
function assertJsonCompatible(root: unknown): void {
  interface WalkFrame {
    value: unknown;
    expanded: boolean;
  }
  const visiting = new Set<object>();
  const visited = new Set<object>();
  const stack: WalkFrame[] = [{ value: root, expanded: false }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const value = frame.value;
    if (!frame.expanded) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        stack.pop();
        continue;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
        stack.pop();
        continue;
      }
      if (typeof value !== 'object' || value instanceof Date || value instanceof Map || value instanceof Set) {
        refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
      }
      if (visiting.has(value)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
      if (visited.has(value)) {
        stack.pop();
        continue;
      }
      if (!Array.isArray(value) && !isPlainRecord(value)) {
        refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
      }
      visiting.add(value);
      frame.expanded = true;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, index);
          if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
            refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
          }
          stack.push({ value: value[index], expanded: false });
        }
      } else {
        const keys = Object.keys(value);
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index];
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
            refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
          }
          stack.push({ value: (value as Record<string, unknown>)[key], expanded: false });
        }
      }
      continue;
    }
    visiting.delete(value as object);
    visited.add(value as object);
    stack.pop();
  }
}

/**
 * Resolves one local JSON Pointer (`#` or `#/…`) against the schema document.
 *
 * @param root - Schema document root.
 * @param pointer - Candidate `$ref` text.
 * @returns The referenced value, or `undefined` when the pointer is malformed
 *   or does not resolve.
 */
function resolveLocalPointer(root: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith('#')) return undefined;
  const fragment = pointer.slice(1);
  if (fragment === '') return root;
  if (!fragment.startsWith('/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of fragment.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (isPlainRecord(current)) {
      if (!hasOwnKey(current, segment)) return undefined;
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/**
 * Normalizes a candidate `type` value into known type tokens, recording a
 * dropped-keyword warning for unknown tokens.
 *
 * @param value - Raw `type` value.
 * @param ctx - Projection context.
 * @param path - Node pointer.
 * @returns Unique known tokens, or `null` when absent/unusable.
 */
function readTypeTokens(value: unknown, ctx: ProjectionContext, path: string): string[] | null {
  if (value === undefined) return null;
  const candidates: unknown[] = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : [];
  const tokens: string[] = [];
  let dropped = candidates.length === 0;
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && JSON_TYPE_TOKENS.has(candidate)) {
      if (!tokens.includes(candidate)) tokens.push(candidate);
    } else {
      dropped = true;
    }
  }
  if (dropped) addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'type'));
  return tokens.length === 0 ? null : tokens;
}

/**
 * Builds the projection node used when a `$ref` cycle is cut.
 *
 * @returns A mutable permissive object node.
 */
function makeCycleCutNode(): MutableSchemaNode {
  return {
    type: 'object',
    description: DEFAULT_NODE_DESCRIPTION,
    properties: {},
    additionalProperties: true
  };
}

/**
 * Writes one common scalar keyword (`description`, `enum`, `format`) onto a
 * projected node, recording the appropriate warning when it is unusable.
 *
 * @param node - Mutable target node.
 * @param key - One of `description`, `enum`, `format`.
 * @param value - Raw keyword value.
 * @param ctx - Projection context.
 * @param path - Node pointer.
 * @param discloseDefaultedDescription - Whether a synthesized description is disclosed as `description-defaulted` (named property nodes) or applied silently (structural nodes).
 */
function applyScalarKeyword(
  node: MutableSchemaNode,
  key: 'description' | 'enum' | 'format',
  value: unknown,
  ctx: ProjectionContext,
  path: string,
  discloseDefaultedDescription = false
): void {
  if (key === 'description') {
    if (typeof value === 'string' && value.trim() !== '') {
      node.description = value;
    } else {
      node.description = DEFAULT_NODE_DESCRIPTION;
      if (discloseDefaultedDescription) {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.DESCRIPTION_DEFAULTED, path);
      }
    }
    return;
  }
  if (key === 'enum') {
    if (Array.isArray(value) && value.length > 0) {
      node.enum = value.map((entry) => cloneJsonValue(entry));
    } else {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'enum'));
    }
    return;
  }
  if (typeof value === 'string' && KNOWN_FORMAT_VALUES.has(value)) {
    node.format = value;
  } else {
    addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'format'));
  }
}

/**
 * Projects a plain (combinator-free) schema node.
 *
 * @param raw - JSON-compatible raw schema node.
 * @param ctx - Projection context.
 * @param path - Node pointer.
 * @param depth - Node nesting depth (root is 0).
 * @param isRoot - Whether this node is the tool input root.
 * @param isProperty - Whether this node was reached through a `properties` map (a named parameter).
 * @returns The mutable projected node.
 */
function projectPlainNode(
  raw: Record<string, unknown>,
  ctx: ProjectionContext,
  path: string,
  depth: number,
  isRoot: boolean,
  isProperty: boolean
): MutableSchemaNode {
  const node: MutableSchemaNode = {};

  let tokens = readTypeTokens(raw.type, ctx, path);
  if (tokens === null && isRoot && !hasOwnKey(raw, 'type')) {
    tokens = ['object'];
  }
  if (tokens !== null) {
    if (tokens.includes('null')) {
      if (tokens.length > 1) {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.NULLABLE_UNWRAPPED, path);
      } else {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'type'));
      }
      tokens = tokens.filter((token) => token !== 'null');
    }
    if (tokens.length === 1) node.type = tokens[0];
    else if (tokens.length > 1) node.type = [...tokens];
  }

  if (isRoot && node.type !== 'object') {
    refuse(EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT, path);
  }

  applyScalarKeyword(node, 'description', raw.description, ctx, path, isProperty);

  if (hasOwnKey(raw, 'enum')) applyScalarKeyword(node, 'enum', raw.enum, ctx, path);
  if (hasOwnKey(raw, 'format')) applyScalarKeyword(node, 'format', raw.format, ctx, path);

  if (hasOwnKey(raw, 'properties')) {
    if (!isPlainRecord(raw.properties)) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'properties'));
    } else {
      const properties: Record<string, MutableSchemaNode> = {};
      for (const key of Object.keys(raw.properties)) {
        if (PROTOTYPE_PROPERTY_NAMES.has(key)) {
          addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'properties', key));
          continue;
        }
        setOwnKey(properties, key, projectNode(raw.properties[key], ctx, joinSchemaPath(path, 'properties', key), depth + 1, false, true));
      }
      node.properties = properties;
    }
  }

  if (hasOwnKey(raw, 'required')) {
    if (!Array.isArray(raw.required)) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'required'));
    } else {
      const required: string[] = [];
      for (const candidate of raw.required) {
        if (typeof candidate !== 'string' || candidate === '' || PROTOTYPE_PROPERTY_NAMES.has(candidate)) {
          addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'required'));
          continue;
        }
        if (!required.includes(candidate)) required.push(candidate);
      }
      if (required.length > 0) node.required = required;
    }
  }

  if (hasOwnKey(raw, 'items')) {
    if (Array.isArray(raw.items)) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'items'));
    } else {
      node.items = projectNode(raw.items, ctx, joinSchemaPath(path, 'items'), depth + 1);
    }
  }

  const objectShaped = isRoot
    || (tokens !== null && tokens.includes('object'))
    || hasOwnKey(raw, 'properties')
    || hasOwnKey(raw, 'required')
    || hasOwnKey(raw, 'additionalProperties');
  if (objectShaped) {
    if (hasOwnKey(raw, 'additionalProperties')) {
      const additional = raw.additionalProperties;
      if (typeof additional === 'boolean') {
        node.additionalProperties = additional;
        if (additional) addFreeformWarning(ctx, path);
      } else if (isPlainRecord(additional)) {
        node.additionalProperties = projectNode(additional, ctx, joinSchemaPath(path, 'additionalProperties'), depth + 1);
        addFreeformWarning(ctx, path);
      } else {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'additionalProperties'));
        node.additionalProperties = true;
        addFreeformWarning(ctx, path);
      }
    } else if (hasOwnKey(raw, 'properties')) {
      node.additionalProperties = false;
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.ADDITIONAL_PROPERTIES_DEFAULTED, path);
    } else {
      node.additionalProperties = true;
      addFreeformWarning(ctx, path);
    }
  }

  for (const key of Object.keys(raw)) {
    if (SUPPORTED_NODE_KEYS.has(key) || REFERENCE_KEYS.has(key)) continue;
    addDroppedKeywordWarning(ctx, path, key);
  }

  if (isRoot && node.properties === undefined) {
    node.properties = {};
  }

  return node;
}

/**
 * Projects one already-projected node's raw sibling keywords (the keys beside
 * a widened union) onto the node: `description` and `type` merge, everything
 * else is dropped with a warning.
 *
 * @param node - Mutable widened node.
 * @param siblings - Raw sibling keywords excluding the combinator.
 * @param ctx - Projection context.
 * @param path - Node pointer.
 */
function applyRawSiblingsToNode(
  node: MutableSchemaNode,
  siblings: Record<string, unknown>,
  ctx: ProjectionContext,
  path: string
): void {
  for (const key of Object.keys(siblings)) {
    const value = siblings[key];
    if (PROTOTYPE_PROPERTY_NAMES.has(key)) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, key));
      continue;
    }
    if (key === 'description') {
      applyScalarKeyword(node, 'description', value, ctx, path);
      continue;
    }
    if (key === 'type') {
      const tokens = readTypeTokens(value, ctx, path);
      if (tokens === null) continue;
      const existing = node.type === undefined
        ? []
        : Array.isArray(node.type) ? [...node.type] : [node.type];
      const merged = [...existing];
      for (const token of tokens) if (!merged.includes(token)) merged.push(token);
      if (merged.includes('null')) {
        const withoutNull = merged.filter((token) => token !== 'null');
        if (withoutNull.length !== merged.length && withoutNull.length > 0) {
          addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.NULLABLE_UNWRAPPED, path);
        }
        if (withoutNull.length === 0) continue;
        node.type = withoutNull.length === 1 ? withoutNull[0] : withoutNull;
        continue;
      }
      node.type = merged.length === 1 ? merged[0] : merged;
      continue;
    }
    addDroppedKeywordWarning(ctx, path, key);
  }
}

/**
 * Computes the type tokens a projected node carries.
 *
 * @param node - Projected node.
 * @returns Token list (possibly empty).
 */
function nodeTypeTokens(node: MutableSchemaNode): string[] {
  if (node.type === undefined) return [];
  return Array.isArray(node.type) ? [...node.type] : [node.type];
}

/**
 * Reports whether one union branch is the `null` schema.
 *
 * @param branch - Candidate branch value.
 * @returns `true` when the branch constrains only to `null`.
 */
function isNullSchema(branch: unknown): boolean {
  if (!isPlainRecord(branch)) return false;
  const value = branch.type;
  if (value === 'null') return true;
  return Array.isArray(value) && value.length > 0 && value.every((token) => token === 'null');
}

/**
 * Widens a multi-branch union into one projected node: the union's type set is
 * preserved (or the node becomes unconstrained when a branch is untyped),
 * object properties merge first-wins, `required` keeps only the intersection,
 * `additionalProperties` opens when any branch is open, and `enum` unites when
 * every branch declares one and the type is homogeneous.
 *
 * @param branches - Raw union branches.
 * @param ctx - Projection context.
 * @param path - Union node pointer.
 * @param depth - Node nesting depth.
 * @param unionKey - `anyOf` or `oneOf`.
 * @returns The mutable widened node.
 */
function widenUnionBranches(
  branches: readonly unknown[],
  ctx: ProjectionContext,
  path: string,
  depth: number,
  unionKey: string
): MutableSchemaNode {
  const projected = branches.map((branch, index) => (
    projectNode(branch, ctx, joinSchemaPath(path, unionKey, index), depth + 1)
  ));

  const result: MutableSchemaNode = {};
  const types: string[] = [];
  let untypedBranch = false;
  for (const branch of projected) {
    const tokens = nodeTypeTokens(branch);
    if (tokens.length === 0) {
      untypedBranch = true;
      continue;
    }
    for (const token of tokens) {
      if (!types.includes(token)) types.push(token);
    }
  }

  for (const branch of projected) {
    if (typeof branch.description === 'string' && branch.description !== DEFAULT_NODE_DESCRIPTION) {
      result.description = branch.description;
      break;
    }
  }
  if (result.description === undefined) {
    for (const branch of projected) {
      if (typeof branch.description === 'string') {
        result.description = branch.description;
        break;
      }
    }
  }
  if (result.description === undefined) result.description = DEFAULT_NODE_DESCRIPTION;

  if (untypedBranch || types.length === 0) {
    return result;
  }

  result.type = types.length === 1 ? types[0] : types;

  const objectBranches = projected.filter((branch) => nodeTypeTokens(branch).includes('object'));
  if (objectBranches.length > 0) {
    const properties: Record<string, MutableSchemaNode> = {};
    for (const branch of objectBranches) {
      if (branch.properties === undefined) continue;
      for (const key of Object.keys(branch.properties)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          setOwnKey(properties, key, branch.properties[key]);
        }
      }
    }
    result.properties = properties;

    let required: string[] | null = null;
    let hasOpenAdditional = false;
    let additionalSchema: MutableSchemaNode | undefined;
    for (const branch of objectBranches) {
      const branchRequired = branch.required ?? [];
      required = required === null
        ? [...branchRequired]
        : required.filter((name) => branchRequired.includes(name));
      if (branch.additionalProperties === true) hasOpenAdditional = true;
      if (typeof branch.additionalProperties === 'object' && additionalSchema === undefined) {
        additionalSchema = branch.additionalProperties;
      }
    }
    if (required !== null && required.length > 0) result.required = required;
    if (hasOpenAdditional) result.additionalProperties = true;
    else if (additionalSchema !== undefined) result.additionalProperties = additionalSchema;
    else result.additionalProperties = false;
  }

  if (types.includes('array')) {
    for (const branch of projected) {
      if (nodeTypeTokens(branch).includes('array') && branch.items !== undefined) {
        result.items = branch.items;
        break;
      }
    }
  }

  if (types.length === 1) {
    const enums = projected.map((branch) => branch.enum);
    if (enums.length > 0 && enums.every((entry) => Array.isArray(entry))) {
      const unionEnum: unknown[] = [];
      for (const entry of enums as unknown[][]) {
        for (const value of entry) {
          if (!unionEnum.some((existing) => JSON.stringify(existing) === JSON.stringify(value))) {
            unionEnum.push(value);
          }
        }
      }
      result.enum = unionEnum;
    }
  }

  return result;
}

/**
 * Shallow-merges two raw schema nodes: later keys win, `type` conflicts widen
 * to a token union, and `properties` merge per property name with later
 * declarations winning.
 *
 * @param earlier - Earlier raw node.
 * @param later - Later raw node (wins conflicts).
 * @returns The merged mutable record.
 */
function mergeRawNodes(
  earlier: Record<string, unknown>,
  later: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of [earlier, later]) {
    for (const key of Object.keys(source)) {
      if (REFERENCE_KEYS.has(key)) {
        setOwnKey(merged, key, source[key]);
        continue;
      }
      if (key === 'properties' && isPlainRecord(merged.properties) && isPlainRecord(source.properties)) {
        const combined: Record<string, unknown> = {};
        for (const propertyKey of Object.keys(merged.properties)) setOwnKey(combined, propertyKey, merged.properties[propertyKey]);
        for (const propertyKey of Object.keys(source.properties)) setOwnKey(combined, propertyKey, source.properties[propertyKey]);
        setOwnKey(merged, 'properties', combined);
        continue;
      }
      if (key === 'type' && merged.type !== undefined) {
        const existing = typeof merged.type === 'string'
          ? [merged.type]
          : Array.isArray(merged.type) ? [...merged.type] : [];
        const incoming = typeof source.type === 'string'
          ? [source.type]
          : Array.isArray(source.type) ? source.type.filter((token): token is string => typeof token === 'string') : [];
        const combined = [...existing];
        for (const token of incoming) if (!combined.includes(token)) combined.push(token);
        setOwnKey(merged, 'type', combined);
        continue;
      }
      setOwnKey(merged, key, source[key]);
    }
  }
  return merged;
}

/**
 * Projects one schema node: resolves local references, absorbs `allOf`,
 * unwraps nullable and widens multi-branch unions, then applies the plain
 * projection pass.
 *
 * @param raw - JSON-compatible raw node.
 * @param ctx - Projection context.
 * @param path - Node pointer.
 * @param depth - Node nesting depth (root is 0).
 * @param isRoot - Whether this node is the tool input root.
 * @param isProperty - Whether this node was reached through a `properties` map (a named parameter).
 * @returns The mutable projected node.
 */
function projectNode(
  raw: unknown,
  ctx: ProjectionContext,
  path: string,
  depth: number,
  isRoot = false,
  isProperty = false
): MutableSchemaNode {
  if (depth > EXTENSION_SCHEMA_MAX_DEPTH) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.DEPTH_BUDGET, path);
  if (typeof raw === 'boolean') {
    if (!raw) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT, path);
    return { description: DEFAULT_NODE_DESCRIPTION };
  }
  if (!isPlainRecord(raw)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, path);

  if (hasOwnKey(raw, '$ref')) {
    const refText = raw.$ref;
    if (typeof refText !== 'string' || !refText.startsWith('#')) {
      refuse(EXTENSION_SCHEMA_REFUSAL_CODES.UNRESOLVABLE_REF, joinSchemaPath(path, '$ref'));
    }
    if (ctx.refStack.includes(refText)) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.REF_CYCLE_CUT, path);
      return makeCycleCutNode();
    }
    ctx.refs += 1;
    if (ctx.refs > EXTENSION_SCHEMA_MAX_REFS) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.REF_BUDGET, path);
    const target = resolveLocalPointer(ctx.root, refText);
    if (target === undefined) {
      refuse(EXTENSION_SCHEMA_REFUSAL_CODES.UNRESOLVABLE_REF, joinSchemaPath(path, '$ref'));
    }
    if (typeof target === 'boolean') {
      if (!target) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT, path);
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.REF_DEREF, path);
      return { description: DEFAULT_NODE_DESCRIPTION };
    }
    if (!isPlainRecord(target)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, path);

    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(target)) setOwnKey(merged, key, target[key]);
    for (const key of Object.keys(raw)) {
      if (key === '$ref' || REFERENCE_KEYS.has(key)) continue;
      setOwnKey(merged, key, raw[key]);
    }
    addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.REF_DEREF, path);
    ctx.refStack.push(refText);
    const projected = projectNode(merged, ctx, path, depth, isRoot, isProperty);
    ctx.refStack.pop();
    return projected;
  }

  let effective: Record<string, unknown> = raw;

  if (hasOwnKey(effective, 'allOf')) {
    const allOf = effective.allOf;
    if (!Array.isArray(allOf) || allOf.length === 0) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, 'allOf'));
      const withoutAllOf: Record<string, unknown> = {};
      for (const key of Object.keys(effective)) if (key !== 'allOf') setOwnKey(withoutAllOf, key, effective[key]);
      effective = withoutAllOf;
    } else {
      let merged: Record<string, unknown> = {};
      for (const branch of allOf) {
        if (!isPlainRecord(branch)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, path);
        merged = mergeRawNodes(merged, branch);
      }
      const siblings: Record<string, unknown> = {};
      for (const key of Object.keys(effective)) {
        if (key === 'allOf' || key === '$defs' || key === 'definitions') continue;
        setOwnKey(siblings, key, effective[key]);
      }
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.ALLOF_MERGED, path);
      effective = mergeRawNodes(merged, siblings);
    }
  }

  const unionKey = hasOwnKey(effective, 'anyOf')
    ? 'anyOf'
    : hasOwnKey(effective, 'oneOf')
      ? 'oneOf'
      : null;
  if (unionKey !== null) {
    const branches = effective[unionKey];
    const siblings: Record<string, unknown> = {};
    for (const key of Object.keys(effective)) {
      if (key === unionKey || key === '$defs' || key === 'definitions') continue;
      setOwnKey(siblings, key, effective[key]);
    }
    if (!Array.isArray(branches) || branches.length === 0) {
      addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, unionKey));
      effective = siblings;
    } else {
      const nonNullBranches = branches.filter((branch) => !isNullSchema(branch));
      const nullBranchCount = branches.length - nonNullBranches.length;
      if (branches.length === 1 && nullBranchCount === 0) {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, unionKey));
        const branch = nonNullBranches[0];
        if (!isPlainRecord(branch)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, path);
        effective = mergeRawNodes(branch, siblings);
      } else if (nullBranchCount === 1 && nonNullBranches.length === 1) {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.NULLABLE_UNWRAPPED, path);
        const branch = nonNullBranches[0];
        if (!isPlainRecord(branch)) refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, path);
        effective = mergeRawNodes(branch, siblings);
      } else if (nonNullBranches.length === 0) {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED, joinSchemaPath(path, unionKey));
        effective = siblings;
      } else {
        addWarning(ctx, EXTENSION_SCHEMA_WARNING_CODES.UNION_WIDENED, path);
        const widened = widenUnionBranches(nonNullBranches, ctx, path, depth, unionKey);
        applyRawSiblingsToNode(widened, siblings, ctx, path);
        return widened;
      }
    }
  }

  if (hasOwnKey(effective, '$ref')) {
    return projectNode(effective, ctx, path, depth, isRoot, isProperty);
  }

  return projectPlainNode(effective, ctx, path, depth, isRoot, isProperty);
}

/**
 * Recursively freezes one projected value (node, array, or primitive).
 *
 * @param value - Value to freeze.
 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
}

/**
 * Freezes the recorded warnings in emission order.
 *
 * @param warnings - Mutable warning list.
 * @returns Frozen warning array.
 */
function freezeWarnings(warnings: ExtensionSchemaWarning[]): readonly ExtensionSchemaWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({ code: warning.code, path: warning.path })));
}

/**
 * Projects one raw extension-tool `inputSchema` into the model-facing
 * Draft-07 subset under the adopted lossy-projection policy.
 *
 * Rules, applied in document order with one warning (or refusal) per
 * decision:
 * 1. Local `$ref` pointers resolve in place (siblings win); a reference cycle
 *    is cut to a permissive object node, and a non-local or unresolvable
 *    reference refuses the tool.
 * 2. Nullable unions (`anyOf`/`oneOf` with one non-null branch plus a `null`
 *    branch) and nullable `type` arrays unwrap to the non-null shape.
 * 3. Multi-branch unions widen to the union's type set with first-wins
 *    property merging; an untyped branch widens to an unconstrained value.
 * 4. `allOf` shallow-merges with later keys winning (conflicting `type`
 *    tokens union).
 * 5. Every other keyword is dropped with a warning — benign annotations
 *    (`title`/`$schema`/`$id`/`$comment`/`default`/`examples`/`deprecated`)
 *    as additive `metadata-dropped`, everything else as semantic
 *    `keyword-dropped` — except the supported
 *    `type`/`description`/`enum`/`items`/`properties`/`required`/
 *    `additionalProperties`/`format` set and the consumed `$defs`/
 *    `definitions`/`$ref` keys.
 * 6. Missing `additionalProperties` defaults to `false` when properties were
 *    declared, and free-form objects stay permissive with a single
 *    `freeform-object` disclosure per tool; a named property without a
 *    description receives the synthesized
 *    `"No description provided by the server."` default and a
 *    `description-defaulted` warning.
 * 7. `__proto__`/`constructor`/`prototype` keys are dropped everywhere and
 *    own-key definition keeps every output object free of inherited
 *    properties.
 * 8. Depth beyond {@link EXTENSION_SCHEMA_MAX_DEPTH} and dereferences beyond
 *    {@link EXTENSION_SCHEMA_MAX_REFS} refuse the tool; a missing/`null`
 *    schema projects to an open empty object so schema-less tools stay
 *    callable.
 *
 * The result — schema, warnings, refusal — is deeply frozen.
 *
 * @param rawSchema - Raw `inputSchema` value from a discovery catalog.
 * @returns The frozen projection outcome.
 *
 * @example
 * ```typescript
 * import { projectExtensionInputSchema } from './tools/extensionTools/index.ts';
 *
 * const projection = projectExtensionInputSchema({
 *   type: 'object',
 *   properties: { regionUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
 * });
 * // projection.status === 'projected'
 * // projection.warnings => [{ code: 'nullable-unwrapped', path: '#/properties/regionUrl' }, ...]
 * ```
 */
export function projectExtensionInputSchema(rawSchema: unknown): ExtensionSchemaProjection {
  const ctx: ProjectionContext = {
    root: {},
    warnings: [],
    seenWarnings: new Set(),
    refStack: [],
    refs: 0,
    freeformWarned: false
  };

  try {
    if (isPlainRecord(rawSchema)) ctx.root = rawSchema;
    let schema: ExtensionToolSchema;
    if (rawSchema === undefined || rawSchema === null) {
      addFreeformWarning(ctx, '#');
      schema = Object.freeze({
        type: 'object' as const,
        properties: Object.freeze({}),
        additionalProperties: true
      });
    } else {
      assertJsonCompatible(rawSchema);
      if (typeof rawSchema === 'boolean' || !isPlainRecord(rawSchema)) {
        refuse(EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, '#');
      }
      const projected = projectNode(rawSchema, ctx, '#', 0, true);
      if (projected.type !== 'object') {
        refuse(EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT, '#');
      }
      const frozen = projected as unknown as ExtensionToolSchema;
      deepFreeze(frozen);
      schema = frozen;
    }
    return Object.freeze({
      status: 'projected' as const,
      schema,
      warnings: freezeWarnings(ctx.warnings)
    });
  } catch (error) {
    if (error instanceof ProjectionRefusal) {
      return Object.freeze({
        status: 'refused' as const,
        refusal: Object.freeze({
          code: error.refusalCode,
          ...(error.refusalPath !== undefined ? { path: error.refusalPath } : {})
        }),
        warnings: freezeWarnings(ctx.warnings)
      });
    }
    // Totality is part of the contract: an unexpected failure raised while
    // reading hostile schema content (a hostile proxy trap, an exotic
    // accessor path) still yields the documented per-tool malformed refusal
    // with every warning recorded so far, never an escaping error.
    return Object.freeze({
      status: 'refused' as const,
      refusal: Object.freeze({ code: EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA, path: '#' }),
      warnings: freezeWarnings(ctx.warnings)
    });
  }
}
