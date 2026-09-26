/**
 * @packageDocumentation
 * Extension-tool synthesis layer: the pure bridge between a discovered MCP tool
 * catalog and sandbox execution.
 *
 * One discovered catalog tool becomes one frozen
 * {@link ExtensionToolDescriptor}: its raw `inputSchema` is lossy-projected
 * into the model-facing dialect under the adopted warning-recording policy
 * ({@link projectExtensionInputSchema}), its description is passed through or
 * synthesized, its parameters flow through the verbatim
 * `createPassThroughSanitizer`, and its handler delegates to the execution
 * port pinned on the handler context. Execution results are normalized and
 * capped by {@link mapMcpToolResult}, and a per-catalog
 * {@link summarizeExtensionSchemaFidelity} summary carries the disclosure
 * state to the extension surfaces.
 *
 * This module is pre-authorization: descriptors carry no capability claim, and
 * exact grant membership on the caller's frozen `AuthorityDescriptor` remains
 * the only extension capability decision. Output schemas are deliberately not
 * projected or exposed in this revision; an unprojectable output schema never
 * blocks a tool.
 *
 * @module tools/extensionTools
 * @mayImport ../normalizers/index.ts
 * @mayImport ../constants/index.ts
 * @mayImport type-only ../../mcpClient/index.ts
 * @mayImport type-only ../../toolDefinitions/index.ts
 * @invariant INV-PURITY: no network, clock, randomness, or import-time side effects; every projection, descriptor, mapping, and summary is a pure function of its inputs.
 * @invariant INV-IMMUTABILITY: projections, schemas, warnings, refusals, descriptors, sources, and receipts are deeply frozen fresh values; a refused projection yields no descriptor.
 * @invariant INV-PROJECTION-DISCLOSURE: every schema rewrite or omission records a warning with a stable code and a JSON Pointer path; a tool is refused only when the projector cannot produce a schema at all (malformed/non-object root, unresolvable reference, or depth/reference budget overflow).
 * @invariant INV-PROTOTYPE-HYGIENE: `__proto__`/`constructor`/`prototype` keys are dropped anywhere in a projected schema and every projected key is defined as an own property, so no output value can gain an inherited property.
 * @invariant INV-RESULT-BOUNDS: mapped receipts are JSON-serializable, secret-free, drop all binary channels to compact markers, and cap mapped text at `EXTENSION_TOOL_RESULT_MAX_CHARS` with the deterministic `…[truncated N chars]` marker.
 * @decision The execution port is read from the handler context under the pinned key `extensionExecutionPort`; the request carries only extension id, server tool name, and sanitized arguments, and the handler itself performs no authorization.
 * @decision Output schemas are not projected or exposed in this revision; the projector surface is input-schema-only and an unprojectable output schema never refuses a tool.
 * @decision Extension tool descriptions are third-party content capped at `EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH` characters; a missing description synthesizes the fixed third-party disclosure text.
 */

import { createPassThroughSanitizer, isReservedToolCallName } from '../normalizers/index.ts';
import { TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { mapMcpToolResult } from './resultMapper.ts';
import { projectExtensionInputSchema } from './schemaProjection.ts';
import type { McpClientToolCallResult } from '../../mcpClient/index.ts';
import type { ParamSanitizerFn, ToolHandlerFn } from '../../toolDefinitions/index.ts';
import type { ExtensionSchemaProjection, ExtensionToolSchema } from './schemaProjection.ts';

export {
  EXTENSION_SCHEMA_MAX_DEPTH,
  EXTENSION_SCHEMA_MAX_REFS,
  EXTENSION_SCHEMA_REFUSAL_CODES,
  EXTENSION_SCHEMA_WARNING_CODES,
  projectExtensionInputSchema
} from './schemaProjection.ts';
export { EXTENSION_TOOL_RESULT_MAX_CHARS, mapMcpToolResult } from './resultMapper.ts';
export { summarizeExtensionSchemaFidelity } from './fidelity.ts';

export type {
  ExtensionSchemaProjection,
  ExtensionSchemaProjectionProjected,
  ExtensionSchemaProjectionRefused,
  ExtensionSchemaRefusal,
  ExtensionSchemaRefusalCode,
  ExtensionSchemaWarning,
  ExtensionSchemaWarningCode,
  ExtensionToolSchema,
  ExtensionToolSchemaNode
} from './schemaProjection.ts';
export type { ExtensionToolResultMappingOptions } from './resultMapper.ts';
export type { ExtensionSchemaFidelitySummary } from './fidelity.ts';

/**
 * Maximum length of a passed-through extension tool description (characters).
 * Longer descriptions are truncated with a trailing ellipsis; the description
 * is untrusted third-party content that is disclosed as such in the review
 * surfaces.
 */
export const EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Pinned handler-context key under which a synthesized extension tool handler
 * locates its {@link ExtensionExecutionPort}. The composition root binds the
 * live implementation at this key; a missing or malformed value fails the call
 * closed with `EXECUTION_FAILED`.
 */
export const EXTENSION_EXECUTION_PORT_KEY = 'extensionExecutionPort';

/**
 * One execution request handed to the injected extension execution port by a
 * synthesized descriptor handler.
 */
export interface ExtensionToolExecutionRequest {
  /** Host-unique id of the extension that provides the tool. */
  readonly extensionId: string;
  /** Wire tool name exactly as the server advertised it. */
  readonly serverToolName: string;
  /** Sanitized pass-through arguments (wire keys preserved verbatim). */
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Narrow execution port an extension tool handler requires from its context
 * (pinned key `extensionExecutionPort`). The port is supplied by the
 * composition root as a frozen plain object; it owns session selection,
 * credential handling, cancellation, and transport concerns, so no secret or
 * transport detail ever crosses this interface.
 *
 * @example
 * ```typescript
 * import type { ExtensionExecutionPort } from './tools/extensionTools/index.ts';
 *
 * const port: ExtensionExecutionPort = {
 *   async execute(request) {
 *     return session.callTool(request.serverToolName, request.args);
 *   }
 * };
 * ```
 */
export interface ExtensionExecutionPort {
  /**
   * Executes one extension tool invocation.
   *
   * @param request - Extension id, wire tool name, and sanitized arguments.
   * @returns The raw MCP tool call result to be mapped into a receipt.
   */
  execute(request: ExtensionToolExecutionRequest): Promise<McpClientToolCallResult>;
}

/**
 * Provenance of one synthesized extension tool descriptor (secret-free).
 */
export interface ExtensionToolDescriptorSource {
  /** Host-unique id of the extension that provides the tool. */
  readonly extensionId: string;
  /** Wire tool name exactly as the server advertised it. */
  readonly serverToolName: string;
}

/**
 * Frozen synthesized descriptor for one discovered extension tool.
 *
 * The descriptor is a dynamic sibling of the baked `ToolDescriptor`: its name
 * is the sanitized model-facing call name (never a `SandboxToolName` union
 * member by construction), its schema is the projected
 * {@link ExtensionToolSchema}, and it carries no `paramAliasMap` — extension
 * arguments are passed through verbatim.
 */
export interface ExtensionToolDescriptor {
  /** Sanitized model-facing call name. */
  readonly name: string;
  /** Passed-through or synthesized third-party description. */
  readonly description: string;
  /** Projected model-facing input schema. */
  readonly schema: ExtensionToolSchema;
  /** Verbatim pass-through parameter sanitizer. */
  readonly sanitize: ParamSanitizerFn;
  /** Secret-free provenance of the tool. */
  readonly source: ExtensionToolDescriptorSource;
  /** Delegation handler bound to the descriptor's execution port key. */
  readonly handler: ToolHandlerFn;
}

/**
 * Input for {@link synthesizeExtensionToolDescriptor}: one discovered catalog
 * tool plus the id of the extension that provides it.
 *
 * The shape is structural, so a P3.1 `ExtensionCatalogTool` (which carries
 * `callName`/`serverToolName`/`description`/`inputSchema`/`outputSchema`) can
 * be spread with its owning `extensionId`.
 */
export interface ExtensionToolSynthesisInput {
  /** Host-unique id of the extension that provides the tool. */
  readonly extensionId: string;
  /** Sanitized model-facing call name from the discovery catalog. */
  readonly callName: string;
  /** Wire tool name exactly as the server advertised it. */
  readonly serverToolName: string;
  /** Optional server-supplied description (third-party content). */
  readonly description?: string;
  /** Raw JSON Schema of the tool input, when the server supplied one. */
  readonly inputSchema?: unknown;
  /** Raw JSON Schema of the tool structured output (carried, not projected). */
  readonly outputSchema?: unknown;
}

/**
 * Outcome of {@link synthesizeExtensionToolDescriptor}: either a frozen
 * descriptor plus its successful projection, or `descriptor: null` with the
 * refusing projection.
 */
export interface ExtensionToolSynthesisResult {
  /** Frozen descriptor, or `null` when the input schema was refused. */
  readonly descriptor: ExtensionToolDescriptor | null;
  /** The projection outcome that produced (or refused) the descriptor. */
  readonly projection: ExtensionSchemaProjection;
}

/**
 * Builds the model-facing description for a synthesized descriptor: the server
 * description verbatim (capped, ellipsis-marked) or the fixed synthesized
 * third-party disclosure when absent.
 *
 * @param input - Synthesis input.
 * @returns The descriptor description.
 */
function buildExtensionToolDescription(input: ExtensionToolSynthesisInput): string {
  const description = input.description;
  if (typeof description === 'string' && description.trim() !== '') {
    return description.length <= EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH
      ? description
      : `${description.slice(0, EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH)}…`;
  }
  return `Tool '${input.serverToolName}' provided by extension '${input.extensionId}' (third-party; classification unknown)`;
}

/**
 * Reads the pinned execution port from a handler context through duck typing.
 *
 * @param context - Handler execution context.
 * @returns The port, or `null` when absent/malformed.
 */
function readExtensionExecutionPort(context: unknown): ExtensionExecutionPort | null {
  if (context === null || typeof context !== 'object') return null;
  const candidate = (context as Record<string, unknown>)[EXTENSION_EXECUTION_PORT_KEY];
  if (candidate === null || typeof candidate !== 'object') return null;
  if (typeof (candidate as { execute?: unknown }).execute !== 'function') return null;
  return candidate as ExtensionExecutionPort;
}

/**
 * Creates the delegation handler for one extension tool: it resolves the
 * pinned execution port from the handler context and maps the raw result
 * through {@link mapMcpToolResult}. A missing/malformed port fails closed with
 * `EXECUTION_FAILED`; port rejections propagate to the dispatcher's universal
 * error shield.
 *
 * @param extensionId - Providing extension id.
 * @param serverToolName - Wire tool name.
 * @returns The descriptor handler.
 */
function createExtensionToolHandler(extensionId: string, serverToolName: string): ToolHandlerFn {
  return async (params, context) => {
    const port = readExtensionExecutionPort(context);
    if (port === null) {
      return {
        success: false,
        error: `Extension tool '${serverToolName}' of extension '${extensionId}' has no bound execution port.`,
        code: TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED
      };
    }
    const result = await port.execute({ extensionId, serverToolName, args: params });
    return mapMcpToolResult(result);
  };
}

/**
 * Synthesizes one frozen extension tool descriptor from a discovered catalog
 * tool.
 *
 * The function is pure and total over schema content: it projects the
 * `inputSchema` (lossy with recorded warnings, or refused per tool), builds
 * the capped/passed-through description, wires a fresh verbatim pass-through
 * sanitizer, and binds the handler to the pinned execution port key. A
 * refused projection returns `descriptor: null` and never a partial
 * descriptor. Programmer errors — a missing id/name, a reserved call name, or
 * a non-string description — throw `TypeError` instead of projecting.
 *
 * @param input - Catalog tool plus its owning extension id.
 * @returns The frozen synthesis result.
 * @throws `TypeError` - When the input shape is malformed or the call name is
 *   reserved by the baked/publishing/prototype surface.
 *
 * @example
 * ```typescript
 * import { synthesizeExtensionToolDescriptor } from './tools/extensionTools/index.ts';
 *
 * const { descriptor, projection } = synthesizeExtensionToolDescriptor({
 *   extensionId: 'acme-docs',
 *   callName: 'docs_search',
 *   serverToolName: 'docs.search',
 *   inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
 * });
 * // descriptor.name => 'docs_search'; projection.status => 'projected'
 * ```
 */
export function synthesizeExtensionToolDescriptor(
  input: ExtensionToolSynthesisInput
): ExtensionToolSynthesisResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('synthesizeExtensionToolDescriptor requires an input object');
  }
  if (typeof input.extensionId !== 'string' || input.extensionId.trim() === '') {
    throw new TypeError('synthesizeExtensionToolDescriptor requires a non-empty extensionId');
  }
  if (typeof input.serverToolName !== 'string' || input.serverToolName.trim() === '') {
    throw new TypeError('synthesizeExtensionToolDescriptor requires a non-empty serverToolName');
  }
  if (typeof input.callName !== 'string' || input.callName === '') {
    throw new TypeError('synthesizeExtensionToolDescriptor requires a non-empty callName');
  }
  if (isReservedToolCallName(input.callName)) {
    throw new TypeError(`Extension call name '${input.callName}' is reserved by the baked/publishing/prototype tool surface`);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new TypeError('synthesizeExtensionToolDescriptor requires a string description when present');
  }

  const projection = projectExtensionInputSchema(input.inputSchema);
  if (projection.status === 'refused') {
    return Object.freeze({ descriptor: null, projection });
  }

  const descriptor: ExtensionToolDescriptor = Object.freeze({
    name: input.callName,
    description: buildExtensionToolDescription(input),
    schema: projection.schema,
    sanitize: createPassThroughSanitizer(),
    source: Object.freeze({
      extensionId: input.extensionId,
      serverToolName: input.serverToolName
    }),
    handler: createExtensionToolHandler(input.extensionId, input.serverToolName)
  });
  return Object.freeze({ descriptor, projection });
}
