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
 * Args: `calls` (required), each `{name, arguments}`. Unresolved or
 * non-allowlisted names fail closed with `PRECALL_FORBIDDEN` and never reach
 * `context.executeTool()`; returns `{success, count, results}` of per-item
 * `{name, result}` receipts or structured denials; throws when `executeTool` is
 * missing.
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

    const calls: readonly PrecallCallEntry[] = Array.isArray(params?.calls) ? params.calls : [];
    const results: unknown[] = [];

    for (const call of calls) {
      if (!call || typeof call !== 'object' || !call.name) {
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

    return {
      success: true,
      count: results.length,
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
    const descriptor = canon ? registry[canon] : null;
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
