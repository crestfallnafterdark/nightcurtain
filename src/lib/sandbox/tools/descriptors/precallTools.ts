/**
 * Tool descriptors for Batch Precall and Tool Reflection operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated precallToolDescriptors array.
 */

import { SANDBOX_TOOLS, TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { createParamSanitizer, getCanonToolName, PRECALL_ALLOWLIST } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a precall descriptor handler. */
type ToolParams = Record<string, unknown>;

/** One `batch_precall` call entry as read after array-shape validation. */
interface PrecallCallEntry {
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
  [key: string]: unknown;
}

/** Registry entry fields read by the `describe_tool` reflection handler. */
interface ToolRegistryEntry {
  name?: unknown;
  description?: unknown;
  schema?: { properties?: Record<string, unknown> } | null;
  [key: string]: unknown;
}

/** Call-site view of the dispatcher executor as invoked by `batch_precall` (raw, pre-validation name/args). */
type ExecuteToolView = (name: unknown, args: unknown, callerContext?: ExecutionContext) => unknown;

const precallAllowlist: ReadonlySet<string> = PRECALL_ALLOWLIST;

/**
 * Renders an arbitrary tool name for denial messages without implicit coercion.
 * Template-literal interpolation of a Symbol throws `TypeError`, which would
 * escape the structured denial path; `String()` converts Symbols safely and the
 * try/catch covers exotic objects with hostile `toString` implementations.
 * @param name - The tool name to render
 * @returns The rendered tool name
 */
function formatToolName(name: unknown): string {
  if (typeof name === 'string') return name;
  try {
    return String(name);
  } catch {
    return Object.prototype.toString.call(name);
  }
}

// --- 1. batch_precall ---
const batchPrecallParamAliasMap = Object.freeze({
  calls: 'calls',
  precalls: 'calls',
  operations: 'calls',
  batch: 'calls'
});

/**
 * `batch_precall` descriptor — execute an ordered batch of allowlisted precalls.
 *
 * Args: `calls` (required), each `{name, arguments}`; the terminal-close
 * carrier shape `{summary}` without `calls` is admitted as a precall-free
 * close. Any other missing or non-array `calls` fails closed with
 * `INVALID_ARGUMENTS` (no false-success envelope).
 * Unresolved or non-allowlisted names fail closed with `PRECALL_FORBIDDEN` and
 * never reach `context.executeTool()`. Every batch carries explicit accounting
 * (`count`, `executed`, `denied`, `partial`); a batch in which every entry was
 * denied reports `success:false` with the denial code (and still carries the
 * per-item receipts), while a partly executed batch keeps `success:true` with
 * `partial:true`. Throws when `executeTool` is missing.
 */
export const batchPrecallDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.BATCH_PRECALL,
  description: 'Execute an ordered batch of allowlisted pre-computation tool calls prior to conversational actions; the allowlist admits mail consumption and clock/event stepping, while VFS writes, agent lifecycle mutations, scheduler mutations, outbound messaging, and direct invocation are forbidden.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        description: 'Array of tool invocation call objects to execute in batch.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the tool to execute.'
            },
            arguments: {
              type: 'object',
              description: 'Arguments payload for the tool call.'
            }
          },
          required: ['name']
        }
      }
    },
    required: ['calls'],
    additionalProperties: false
  }),
  paramAliasMap: batchPrecallParamAliasMap,
  sanitize: createParamSanitizer(batchPrecallParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const execute = context?.executeTool as ExecuteToolView | undefined;
    if (typeof execute !== 'function') {
      throw new Error('executeTool service is not available in execution context');
    }

    // Envelope truth (ticket eba7c76): the schema declares `calls` required and
    // an array, so a missing/non-array payload must fail closed with
    // INVALID_ARGUMENTS instead of the legacy `{success:true,count:0}` receipt.
    //
    // Terminal-close carrier (runtime/turnExecutionEngine): the same tool also
    // carries the closing summary of a terminal turn, where a non-empty
    // `summary` argument with no `calls` at all is a valid precall-free close.
    // Only that exact shape is admitted; an explicitly non-array `calls` (or a
    // payload with neither `calls` nor a summary) stays invalid.
    const rawCalls = params?.calls;
    const terminalClose = typeof params?.summary === 'string' && params.summary.trim() !== '';
    if (!Array.isArray(rawCalls)) {
      if ((rawCalls === undefined || rawCalls === null) && terminalClose) {
        return {
          success: true,
          partial: false,
          count: 0,
          executed: 0,
          denied: 0,
          results: []
        };
      }
      return {
        success: false,
        error: "batch_precall: 'calls' is required and must be an array of { name, arguments } objects.",
        code: TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    const calls: readonly PrecallCallEntry[] = rawCalls;
    const results: unknown[] = [];
    let denied = 0;
    let malformed = 0;

    for (const call of calls) {
      if (!call || typeof call !== 'object' || !call.name) {
        denied++;
        malformed++;
        results.push({
          success: false,
          error: "Precall item must be an object containing a valid string 'name'",
          code: TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS
        });
        continue;
      }

      // BUG-ENC-017: fail closed when the canonical name cannot be resolved.
      // Unresolved names must never reach the executor, matching the engine's
      // stricter `!canonName || !allowed` precall gate (runtime/turnExecutionEngine/index.ts).
      const canonName = getCanonToolName(call.name);
      if (!canonName || !precallAllowlist.has(canonName)) {
        denied++;
        results.push({
          success: false,
          error: `Tool '${formatToolName(call.name)}' is forbidden during precall batch execution.`,
          code: TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN
        });
        continue;
      }

      const args = call.arguments || call.args || {};
      const res = await execute(call.name, args, context);
      results.push({ name: call.name, result: res });
    }

    const count = results.length;
    const executed = count - denied;
    // A fully denied batch is a self-validation failure, not a success: it must
    // not report `success:true` (the turn engine's terminal-close guard reads
    // the outer discriminator). The code distinguishes an all-malformed payload
    // from a policy denial; per-item receipts stay in `results`.
    if (count > 0 && executed === 0) {
      const allMalformed = malformed === denied;
      return {
        success: false,
        error: allMalformed
          ? `batch_precall: all ${count} call entries were malformed; none executed.`
          : `batch_precall: all ${count} call entries were denied by the precall allowlist; none executed.`,
        code: allMalformed
          ? TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS
          : TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN,
        partial: false,
        count,
        executed,
        denied,
        results
      };
    }

    return {
      success: true,
      partial: denied > 0,
      count,
      executed,
      denied,
      results
    };
  }
});
/** camelCase alias of `batchPrecallDescriptor`. */
export const batchPrecall = batchPrecallDescriptor;
/** snake_case alias of `batchPrecallDescriptor`. */
export const batch_precall = batchPrecallDescriptor;

// --- 2. describe_tool ---
const describeToolParamAliasMap = Object.freeze({
  tool_name: 'tool_name',
  toolName: 'tool_name',
  name: 'tool_name',
  tool: 'tool_name'
});

/**
 * `describe_tool` descriptor — look up a tool description and schema in the
 * registry.
 *
 * Args: `tool_name` (required). Reads `context.toolRegistry` and returns
 * `{success, tool_name, description, schema, parameters}`, or
 * `{success:false, error, code:"TOOL_NOT_FOUND"}`; throws when the registry is
 * missing.
 */
export const describeToolDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.DESCRIBE_TOOL,
  description: 'Retrieve documentation, schema, and parameter specifications for a sandbox tool from the registry.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: 'Name of the tool to inspect and describe.'
      }
    },
    required: ['tool_name'],
    additionalProperties: false
  }),
  paramAliasMap: describeToolParamAliasMap,
  sanitize: createParamSanitizer(describeToolParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    // Registry surface already seeded into the execution context by the dispatcher
    // (PORTS.md: no runtime reach, no foreign-registry duck-typing).
    const registry = context?.toolRegistry as Record<string, ToolRegistryEntry> | undefined;
    if (!registry) {
      throw new Error('toolRegistry service is not available in execution context');
    }

    const canon = getCanonToolName(params.tool_name);
    let descriptor = canon ? registry[canon] : null;
    // Extension wave (P3.3): sanitized extension call names are deliberately
    // non-resolvable through the alias map, so the turn's merged registry view
    // seeds each granted extension descriptor under its exact call name. Fall
    // back to an own-property lookup so `describe_tool` documents granted
    // extension tools, while prototype-chain keys and canonical alias lookups
    // stay out of reach.
    if (
      !descriptor
      && typeof params.tool_name === 'string'
      && params.tool_name
      && Object.prototype.hasOwnProperty.call(registry, params.tool_name)
    ) {
      descriptor = registry[params.tool_name];
    }
    if (descriptor && typeof descriptor === 'object') {
      return {
        success: true,
        tool_name: descriptor.name || params.tool_name,
        description: descriptor.description || '',
        schema: descriptor.schema || null,
        parameters: descriptor.schema?.properties || {}
      };
    }

    return {
      success: false,
      error: `Tool '${params.tool_name}' not found in registry`,
      code: TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND
    };
  }
});
/** camelCase alias of `describeToolDescriptor`. */
export const describeTool = describeToolDescriptor;
/** snake_case alias of `describeToolDescriptor`. */
export const describe_tool = describeToolDescriptor;

/**
 * Array of all Precall & Reflection Tool Descriptors
 */
export const precallToolDescriptors = Object.freeze([
  batchPrecallDescriptor,
  describeToolDescriptor
]);
