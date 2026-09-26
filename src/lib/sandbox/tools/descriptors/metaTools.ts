/**
 * Meta-plane agent descriptors (M2): `inspect_agent` and `update_agent`, the
 * first agent-facing edit surface (meta-plane spec §3, decision `c8a748f`).
 *
 * These are **canonical** tools with ordinary preset authorization — parental
 * authority is inherent to the registered parent and needs no grant, so no
 * `requiredAuthority` gate applies and the manager preset (the family that owns
 * `spawn_agent`) is the only tier that carries them. The meta tier reuses the
 * same canonical tool under an exact scoped `@agent:inspect`/`@agent:edit`
 * grant enforced registry-side; schemas never mention authority vocabulary.
 *
 * Tool-boundary honesty (§3.4): `update_agent` is a closed schema whose
 * property set is exactly the editable keys the handler honors; the sanitizer
 * preserves unknown keys (and `null` values) so the handler can fail the whole
 * call — `PERMISSION_DENIED` for the operator-only deny list, `INVALID_ARGUMENTS`
 * for unknown keys and malformed patches — instead of silently dropping a key.
 *
 * Realm opacity: receipts carry bare ids and labels only; the handler masks the
 * workspace label and the parent reference exactly like `whoami`.
 */

import { SANDBOX_TOOLS, TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { toSnakeCase } from '../normalizers/index.ts';
import { AUTHORITY_IDS } from '../../realmCatalog/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';
import { toAgentVisibleAgentReference, toAgentVisibleWorkspaceKey } from './lifecycleTools.ts';

/** Sanitized canonical parameter record handed to a meta descriptor handler. */
type ToolParams = Record<string, unknown>;

/**
 * Every exact authority id is operator-grant-only vocabulary: the meta tier's
 * two ids and the publishing pair alike are never schema vocabulary and never
 * appear in a description or receipt.
 * @internal
 */
const META_AUTHORITY_ID_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_IDS);

/**
 * Operator-only / escalation-adjacent update keys the tool boundary rejects
 * before any port call (presence — `false`/`null` included — fails the whole
 * call). Kept in exact parity with the lifecycle manager's registry-side
 * deny list (M2 spec §3.1); the manager independently re-validates.
 * @internal
 */
const META_UPDATE_DENIED_KEYS: ReadonlySet<string> = new Set<string>([
  'modelConfig',
  'presetId',
  'workspaceId',
  'workspace',
  'extensionTools',
  'settings',
  'customTools',
  'customToolSchemas',
  'role',
  'isAdmin',
  'isPrivileged',
  'spawnedBy',
  'creatorId',
  'realmId',
  'realmBypass',
  'templateAuthority',
  'hydrationAuthority',
  'authorities'
]);

/** Editable update keys the handler forwards to the lifecycle port. @internal */
const META_UPDATE_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  'target',
  'tools',
  'allowedTools',
  'toolPreset',
  'privileged',
  'triggerPolicy',
  'systemPrompt',
  'maxTurns',
  'name'
]);

/**
 * Tests whether a sanitized update key is operator-only (exact spelling,
 * snake_case spelling, or an exact authority id in either spelling).
 *
 * @param key - Sanitized parameter key.
 * @returns True when the call must fail with the uniform permission denial.
 * @internal
 */
function isDeniedMetaUpdateKey(key: string): boolean {
  if (META_UPDATE_DENIED_KEYS.has(key)) return true;
  if (META_AUTHORITY_ID_SET.has(key)) return true;
  const snake = toSnakeCase(key);
  if (snake && snake !== key) {
    if (META_UPDATE_DENIED_KEYS.has(snake)) return true;
    if (META_AUTHORITY_ID_SET.has(snake)) return true;
  }
  return false;
}

/** Inspect parameter alias map (target addressing only). @internal */
const metaInspectParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  target: 'target',
  agent_id: 'target',
  agentId: 'target',
  id: 'target',
  target_agent_id: 'target',
  targetAgentId: 'target'
});

/**
 * Update parameter alias map: editable aliases normalize to their canonical
 * key; every other key passes through verbatim so the deny/unknown scan sees
 * the caller's own spelling.
 * @internal
 */
const metaUpdateParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  target: 'target',
  agent_id: 'target',
  agentId: 'target',
  id: 'target',
  target_agent_id: 'target',
  targetAgentId: 'target',
  tools: 'tools',
  allowedTools: 'allowedTools',
  allowed_tools: 'allowedTools',
  toolPreset: 'toolPreset',
  tool_preset: 'toolPreset',
  privileged: 'privileged',
  triggerPolicy: 'triggerPolicy',
  trigger_policy: 'triggerPolicy',
  systemPrompt: 'systemPrompt',
  system_prompt: 'systemPrompt',
  maxTurns: 'maxTurns',
  max_turns: 'maxTurns',
  name: 'name'
});

/** Prototype-mutating key names dropped by the update sanitizer. @internal */
const PROTOTYPE_POLLUTION_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);

/**
 * Custom `update_agent` sanitizer: normalizes alias keys to their canonical
 * editable spelling while preserving unknown keys and `null` values so the
 * handler can classify them explicitly (the shared table-driven sanitizer
 * skips nulls and snake-cases unknowns, which would silently drop a
 * `modelConfig: null` deny probe). Total and prototype-pollution-safe.
 *
 * @param rawArgs - Raw tool arguments (object, JSON string, or arbitrary value).
 * @returns A fresh sanitized parameter record.
 * @internal
 */
function sanitizeMetaUpdateParams(rawArgs?: unknown): Record<string, unknown> {
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
      const alias = Object.prototype.hasOwnProperty.call(metaUpdateParamAliasMap, key)
        ? metaUpdateParamAliasMap[key]
        : (snakeKey && Object.prototype.hasOwnProperty.call(metaUpdateParamAliasMap, snakeKey)
          ? metaUpdateParamAliasMap[snakeKey]
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
 * Resolves the dispatcher-pinned caller subject from the trusted execution
 * context (never a per-call claim).
 *
 * @param context - Trusted execution context.
 * @returns The bound subject id, or `null`.
 * @internal
 */
function resolveBoundCallerAgentId(context: ExecutionContext): string | null {
  const raw = context?.callerAgentId || context?.agentId || null;
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * Resolves the dispatcher-pinned canonical caller key from the trusted
 * execution context.
 *
 * @param context - Trusted execution context.
 * @returns The pinned canonical identity key, or `null`.
 * @internal
 */
function resolveBoundCallerKey(context: ExecutionContext): string | null {
  const raw = context?.callerKey;
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * Builds the identity-only caller scope forwarded to the lifecycle port.
 *
 * @param context - Trusted execution context.
 * @returns The caller scope, or an empty scope for an anonymous caller.
 * @internal
 */
function resolveMetaCallerScope(context: ExecutionContext): Record<string, string> {
  const callerAgentId = resolveBoundCallerAgentId(context);
  if (!callerAgentId) return {};
  const callerKey = resolveBoundCallerKey(context);
  return callerKey ? { callerAgentId, callerKey } : { callerAgentId };
}

/**
 * Projects one manager inspection record onto the model-facing receipt:
 * the raw workspace label is masked (realm-global → `global`, other internal
 * partition keys omitted) and the parent reference is reduced to its bare id
 * (system/vocabulary references withheld). Every other field passes through
 * unchanged.
 *
 * @param record - Manager inspection projection.
 * @returns The realm-opaque receipt.
 * @internal
 */
function toAgentVisibleInspectReceipt(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const projected: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  const rawWorkspace = typeof projected.workspace === 'string' && projected.workspace ? projected.workspace : null;
  const workspace = toAgentVisibleWorkspaceKey(rawWorkspace);
  if (workspace) projected.workspace = workspace;
  else delete projected.workspace;
  if (projected.spawnedBy !== undefined) {
    projected.spawnedBy = toAgentVisibleAgentReference(projected.spawnedBy);
  }
  return projected;
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
 * `inspect_agent` descriptor — inspect one target agent under the parental
 * (inherent; registered direct spawns in the caller's own realm) or meta
 * (exact scoped `@agent:inspect`) tier. Self-inspection is allowed. Every
 * unauthorized target shares one uniform, realm-opaque `PERMISSION_DENIED`.
 */
export const inspectAgentDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.INSPECT_AGENT,
  description:
    'Inspect one target agent you are authorized to observe (an agent you directly spawned, or a target covered by your scoped inspect grant) '
    + 'and return a bounded view: identity, role, state, privilege, effective tool policy (baked tools and granted extension tool names), '
    + 'model-config summary, workspace label, parent, turn count, and unread count. Requires the inspect_agent capability (the manager preset grants it). '
    + 'Unauthorized targets fail closed without disclosing whether they exist.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Identifier of the agent to inspect.'
      }
    },
    required: ['target'],
    additionalProperties: false
  }),
  paramAliasMap: metaInspectParamAliasMap,
  sanitize: (rawArgs?: unknown): ToolParams => {
    const result: ToolParams = {};
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return result;
    try {
      for (const [key, value] of Object.entries(rawArgs)) {
        if (PROTOTYPE_POLLUTION_KEYS.has(key) || value === undefined) continue;
        const snakeKey = toSnakeCase(key);
        const alias = Object.prototype.hasOwnProperty.call(metaInspectParamAliasMap, key)
          ? metaInspectParamAliasMap[key]
          : (snakeKey && Object.prototype.hasOwnProperty.call(metaInspectParamAliasMap, snakeKey)
            ? metaInspectParamAliasMap[snakeKey]
            : key);
        if (!alias || PROTOTYPE_POLLUTION_KEYS.has(alias)) continue;
        result[alias] = value;
      }
    } catch {
      return {};
    }
    return result;
  },
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.inspectAgent !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    const keys = Object.keys(params || {});
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== 'target') {
        // Static message: an unknown parameter never echoes its key (a
        // caller-supplied scope-vocabulary key must not reach any receipt).
        return invalidArguments('inspect_agent does not accept unknown parameters.');
      }
    }
    const target = params?.target;
    if (typeof target !== 'string' || !target.trim()) {
      return invalidArguments("inspect_agent: 'target' is required and must be a non-empty string.");
    }
    const record = lifecyclePort.inspectAgent(target, resolveMetaCallerScope(context));
    return toAgentVisibleInspectReceipt(record);
  }
});
/** camelCase alias of `inspectAgentDescriptor`. */
export const inspectAgent = inspectAgentDescriptor;
/** snake_case alias of `inspectAgentDescriptor`. */
export const inspect_agent = inspectAgentDescriptor;

/**
 * `update_agent` descriptor — update one target agent's editable settings under
 * the parental (inherent; registered direct spawns in the caller's own realm)
 * or meta (exact scoped `@agent:edit`) tier. Editable: tool selector, privilege,
 * trigger policy, system prompt, maxTurns, and name. The edit applies at the
 * target's next safe state; the resulting state can never out-rank the caller.
 * Operator-only keys fail the whole call.
 */
export const updateAgentDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.UPDATE_AGENT,
  description:
    'Update the editable settings of one target agent you are authorized to edit (an agent you directly spawned, or a target covered by your scoped edit grant): '
    + 'the tool selector (toolPreset or an explicit tools/allowedTools list, never exceeding your own effective tool access), privilege, trigger policy, '
    + 'system prompt, maxTurns, and display name. The patch is validated as a whole (unknown or operator-only keys fail the call with no partial change), '
    + 'the resulting capability state can never exceed your own, and the edit applies at the target next safe state (never mid-turn). '
    + 'Requires the update_agent capability (the manager preset grants it). Self-target updates are denied.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Identifier of the agent to update.'
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit tool-name allowlist for the target; clamped to the editor effective access.'
      },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Alias of tools: explicit tool-name allowlist for the target.'
      },
      toolPreset: {
        type: 'string',
        description: 'Capability preset id for the target tools (clamped to the editor effective access).'
      },
      privileged: {
        type: 'boolean',
        description: 'Set or keep the target privilege inside the editor own level; a promotion above the editor is denied.'
      },
      triggerPolicy: {
        type: 'string',
        description: 'Stored trigger-policy label (display/configuration; does not gate execution).'
      },
      systemPrompt: {
        type: 'string',
        description: 'New system prompt; synchronized into the target live history in place.'
      },
      maxTurns: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum turn budget for the target.'
      },
      name: {
        type: 'string',
        description: 'Display name for the target.'
      }
    },
    required: ['target'],
    additionalProperties: false
  }),
  paramAliasMap: metaUpdateParamAliasMap,
  sanitize: sanitizeMetaUpdateParams,
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.updateAgent !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    const sanitized = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const keys = Object.keys(sanitized);
    // Denied-key presence fails the whole call first (even `false`/`null`),
    // exactly like the registry-side gate; unknown keys are malformed params.
    for (let i = 0; i < keys.length; i++) {
      if (isDeniedMetaUpdateKey(keys[i])) {
        return {
          success: false,
          error: 'update_agent does not permit operator-only fields.',
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }
    for (let i = 0; i < keys.length; i++) {
      if (!META_UPDATE_ALLOWED_KEYS.has(keys[i])) {
        // Static message: an unknown field never echoes its key (a
        // caller-supplied scope-vocabulary key must not reach any receipt).
        return invalidArguments('update_agent does not accept unknown fields.');
      }
    }
    const target = sanitized.target;
    if (typeof target !== 'string' || !target.trim()) {
      return invalidArguments("update_agent: 'target' is required and must be a non-empty string.");
    }
    const patch: ToolParams = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === 'target') continue;
      patch[key] = sanitized[key];
    }
    if (Object.keys(patch).length === 0) {
      return invalidArguments('update_agent requires at least one editable field.');
    }
    const receipt = lifecyclePort.updateAgent(target, patch, resolveMetaCallerScope(context));
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? { ...(receipt as unknown as Record<string, unknown>) }
      : { success: true, result: receipt };
  }
});
/** camelCase alias of `updateAgentDescriptor`. */
export const updateAgent = updateAgentDescriptor;
/** snake_case alias of `updateAgentDescriptor`. */
export const update_agent = updateAgentDescriptor;

/**
 * Array of the M2 meta-plane agent descriptors, appended to the canonical
 * `ALL_TOOL_DESCRIPTORS` catalog by `tools/descriptors/index.ts` (M3-M5b extend
 * this file with their own authority-gated descriptors).
 */
export const metaToolDescriptors = Object.freeze([
  inspectAgentDescriptor,
  updateAgentDescriptor
]);
