/**
 * Meta-plane descriptors: the M2 agent pair (`inspect_agent`/`update_agent`,
 * meta-plane spec §3, decision `c8a748f`), the M3 realm-admin pair
 * (`inspect_realm`/`update_realm`, spec §4, ticket `094de1b`), and the M4
 * extension-admin pair (`list_extensions`/`attach_extension`, spec §5, ticket
 * `a02bce7`).
 *
 * The M2 pair is **canonical** with ordinary preset authorization — parental
 * authority is inherent to the registered parent and needs no grant, so no
 * `requiredAuthority` gate applies and the manager preset (the family that owns
 * `spawn_agent`) is the only tier that carries them. The meta tier reuses the
 * same canonical tool under an exact scoped `@agent:inspect`/`@agent:edit`
 * grant enforced registry-side; schemas never mention authority vocabulary.
 *
 * The M3 and M4 pairs are **authority-registry** tooling (outside the
 * canonical taxonomy): each descriptor declares its exact authority id
 * (`@realm:inspect`/`@realm:edit`/`@extensions:authority`), so its schema is
 * exposed only through the M1 generic exact-id filter and the dispatcher gate
 * admits only the exact holder. The handlers forward the dispatcher-pinned
 * actor reference (and the closed patch/selection) to the pinned
 * `realmAdminPort`; the store-side port resolves the registry grant scope and
 * fails closed without an actor record (R6). The M4 attach is realm-wide
 * (decision `ce4b475`: one uniform extension set per realm), installed+
 * connected only, idempotent when already attached, and never installs,
 * dials, disconnects, detaches, or touches credentials.
 *
 * Tool-boundary honesty (§3.4): `update_agent` is a closed schema whose
 * property set is exactly the editable keys the handler honors; the sanitizer
 * preserves unknown keys (and `null` values) so the handler can fail the whole
 * call — `PERMISSION_DENIED` for the operator-only deny list, `INVALID_ARGUMENTS`
 * for unknown keys and malformed patches — instead of silently dropping a key.
 *
 * Realm opacity: receipts carry bare ids and labels only; the M2 handler masks
 * the workspace label and the parent reference exactly like `whoami`. Ordinary
 * agents never receive the extension vocabulary: the M4 schemas exist only for
 * the exact `@extensions:authority` holder.
 */

import { EXTENSIONS_ADMIN_TOOLS, REALM_ADMIN_TOOLS, REALM_KNOWLEDGE_TOOLS, SANDBOX_TOOLS, TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { toSnakeCase } from '../normalizers/index.ts';
import {
  AGENT_AUTHORITIES,
  AUTHORITY_IDS,
  REALM_ADMIN_DENIED_PATCH_KEYS,
  REALM_ADMIN_PATCH_FIELD_TOKENS,
  normalizeTemplate
} from '../../realmCatalog/index.ts';
import type { ExecutionContext, RealmAdminPort, RealmAdminPatch, RealmPublishingPort } from '../../toolDefinitions/index.ts';
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

// ============================================================================
// M3 realm-admin meta tools (`inspect_realm` / `update_realm`, ticket 094de1b)
// ============================================================================

/**
 * Operator-only / escalation-adjacent realm patch keys plus every exact
 * authority id (exact or snake_case spelling): presence fails the whole call
 * with the uniform permission denial before any port call, even for
 * `false`/`null` values. The registry-side port independently re-validates
 * against the same shared vocabulary (`REALM_ADMIN_DENIED_PATCH_KEYS`).
 * @internal
 */
function isDeniedRealmAdminPatchKey(key: string): boolean {
  if (REALM_ADMIN_DENIED_PATCH_KEYS.includes(key)) return true;
  if (META_AUTHORITY_ID_SET.has(key)) return true;
  const snake = toSnakeCase(key);
  if (snake && snake !== key) {
    if (REALM_ADMIN_DENIED_PATCH_KEYS.includes(snake)) return true;
    if (META_AUTHORITY_ID_SET.has(snake)) return true;
  }
  return false;
}

/** Sanitized realm patch keys the update handler forwards (the field-token vocabulary). @internal */
const REALM_ADMIN_ALLOWED_PATCH_KEYS: ReadonlySet<string> = new Set<string>(
  Object.keys(REALM_ADMIN_PATCH_FIELD_TOKENS)
);

/** Accepted nested key set of the `attach` patch container (closed at depth). @internal */
const REALM_ADMIN_ATTACH_KEYS: ReadonlySet<string> = new Set<string>(['extensionId', 'toolSelection']);

/** Accepted nested key set of the `toolSelection` patch container (closed at depth). @internal */
const REALM_ADMIN_TOOL_SELECTION_KEYS: ReadonlySet<string> = new Set<string>(['extensionId', 'selection']);

/**
 * Scans the `attach` / `toolSelection` patch containers for operator-only or
 * unknown nested keys (closed patch at depth, spec AC-M3-04/§1.4): denied-key
 * presence fails the whole call with the uniform permission denial, an unknown
 * key is malformed — never silently dropped. Malformed container shapes are
 * left to the store's value validation.
 *
 * @param patch - Sanitized patch record.
 * @returns The refusal receipt, or `null` when every nested key is accepted.
 * @internal
 */
function findRealmAdminNestedPatchFailure(
  patch: Record<string, unknown>
): { success: false; error: string; code: string } | null {
  const containers: Array<{ value: unknown; allowed: ReadonlySet<string> }> = [];
  if (patch.attach !== undefined) {
    containers[containers.length] = { value: patch.attach, allowed: REALM_ADMIN_ATTACH_KEYS };
  }
  if (patch.toolSelection !== undefined) {
    containers[containers.length] = { value: patch.toolSelection, allowed: REALM_ADMIN_TOOL_SELECTION_KEYS };
  }
  // Denied presence across both containers first, exactly like the top-level
  // scan: the uniform permission denial wins over unknown-key reporting.
  for (let i = 0; i < containers.length; i++) {
    const value = containers[i].value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nestedKeys = Object.keys(value as Record<string, unknown>);
    for (let j = 0; j < nestedKeys.length; j++) {
      if (isDeniedRealmAdminPatchKey(nestedKeys[j])) {
        return {
          success: false,
          error: 'update_realm does not permit operator-only fields.',
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }
  }
  for (let i = 0; i < containers.length; i++) {
    const value = containers[i].value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nestedKeys = Object.keys(value as Record<string, unknown>);
    for (let j = 0; j < nestedKeys.length; j++) {
      if (!containers[i].allowed.has(nestedKeys[j])) {
        // Static message: an unknown nested key never echoes its key.
        return invalidArguments('update_realm does not accept unknown fields.');
      }
    }
  }
  return null;
}

/** `inspect_realm` parameter alias map (realm label addressing only). @internal */
const realmInspectParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  realm: 'realm',
  realm_label: 'realm',
  realmLabel: 'realm',
  label: 'realm',
  realm_name: 'realm',
  realmName: 'realm'
});

/**
 * Update parameter alias map: realm addressing and the `patch` container
 * normalize to their canonical keys; every other key passes through verbatim
 * so the deny/unknown scan sees the caller's own spelling.
 * @internal
 */
const realmUpdateParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  realm: 'realm',
  realm_label: 'realm',
  realmLabel: 'realm',
  label: 'realm',
  realm_name: 'realm',
  realmName: 'realm',
  patch: 'patch',
  changes: 'patch',
  update: 'patch'
});

/**
 * Custom `update_realm` sanitizer: normalizes the realm/patch container aliases
 * while preserving unknown keys and `null` values so the handler can classify
 * them explicitly (a nested denied key must fail the whole call, never be
 * silently dropped). Total and prototype-pollution-safe.
 *
 * @param rawArgs - Raw tool arguments (object, JSON string, or arbitrary value).
 * @returns A fresh sanitized parameter record.
 * @internal
 */
function sanitizeRealmAdminUpdateParams(rawArgs?: unknown): Record<string, unknown> {
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
      const alias = Object.prototype.hasOwnProperty.call(realmUpdateParamAliasMap, key)
        ? realmUpdateParamAliasMap[key]
        : (snakeKey && Object.prototype.hasOwnProperty.call(realmUpdateParamAliasMap, snakeKey)
          ? realmUpdateParamAliasMap[snakeKey]
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
 * Resolves the trusted pinned realm-admin port from the execution context.
 *
 * @param context - Trusted execution context.
 * @returns The host port.
 * @throws `Error` - When no trusted port is bound.
 * @internal
 */
function realmAdminPortOf(context: ExecutionContext): RealmAdminPort {
  const port = context?.realmAdminPort;
  if (!port || typeof port.inspectRealm !== 'function' || typeof port.updateRealm !== 'function') {
    throw new Error('realmAdminPort service is not available in execution context');
  }
  return port;
}

/**
 * Resolves the dispatcher-pinned actor reference (canonical key first, then
 * the bare id) forwarded to the host port for registry-side scope resolution
 * and audit attribution. Never a per-call claim.
 *
 * @param context - Trusted execution context.
 * @returns The actor reference, or `null`.
 * @internal
 */
function resolveRealmAdminActorRef(context: ExecutionContext): string | null {
  const key = typeof context?.callerKey === 'string' && context.callerKey ? context.callerKey : null;
  if (key) return key;
  const raw = context?.callerAgentId || context?.agentId || null;
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * Normalizes the optional realm label argument: absent/blank means the caller's
 * own realm; a non-string value fails the call as malformed.
 *
 * @param value - Sanitized `realm` parameter.
 * @returns The trimmed label, or `null` for the own-realm form.
 * @throws `Error` - Code `'INVALID_ARGUMENTS'` for non-string values.
 * @internal
 */
function normalizeRealmLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    const err: Error & { code?: string } = new Error("The 'realm' parameter must be a string when present.");
    err.code = TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS;
    throw err;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * `inspect_realm` descriptor — exact-grant-only (`@realm:inspect`) bounded read
 * of one realm the caller's grant scope reaches: member roster with effective
 * capability, attachments with tool ceiling and live connection state, launch
 * provenance, and missing-extension disclosure. Realm ids, transport URLs, and
 * credential material never appear. Every resolution failure shares one
 * uniform, realm-opaque denial.
 */
export const inspectRealmDescriptor = Object.freeze({
  name: REALM_ADMIN_TOOLS.INSPECT_REALM,
  authority: AGENT_AUTHORITIES.REALM_INSPECT,
  description:
    'Inspect one realm you are authorized to observe (your own realm by default, or one realm by its display label when your grant reaches it) '
    + 'and return a bounded view: display metadata, the member roster with each member\'s state, privilege, and effective tool policy '
    + '(baked tools and granted extension tool names), the realm attachments with their tool ceiling and live connection state, '
    + 'launch provenance, and any unresolved extension disclosures. Requires the inspect_realm capability; unauthorized realms fail closed '
    + 'without disclosing whether they exist.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      realm: {
        type: 'string',
        description: 'Display label of the realm to inspect; omitted for your own realm.'
      }
    },
    required: [] as string[],
    additionalProperties: false
  }),
  paramAliasMap: realmInspectParamAliasMap,
  sanitize: (rawArgs?: unknown): ToolParams => {
    const result: ToolParams = {};
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return result;
    try {
      for (const [key, value] of Object.entries(rawArgs)) {
        if (PROTOTYPE_POLLUTION_KEYS.has(key) || value === undefined) continue;
        const snakeKey = toSnakeCase(key);
        const alias = Object.prototype.hasOwnProperty.call(realmInspectParamAliasMap, key)
          ? realmInspectParamAliasMap[key]
          : (snakeKey && Object.prototype.hasOwnProperty.call(realmInspectParamAliasMap, snakeKey)
            ? realmInspectParamAliasMap[snakeKey]
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
    const port = realmAdminPortOf(context);
    const keys = Object.keys(params || {});
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== 'realm') {
        // Static message: an unknown parameter never echoes its key.
        return invalidArguments('inspect_realm does not accept unknown parameters.');
      }
    }
    const realmLabel = normalizeRealmLabel(params?.realm);
    return port.inspectRealm({ actorRef: resolveRealmAdminActorRef(context), realmLabel });
  }
});
/** camelCase alias of `inspectRealmDescriptor`. */
export const inspectRealm = inspectRealmDescriptor;
/** snake_case alias of `inspectRealmDescriptor`. */
export const inspect_realm = inspectRealmDescriptor;

/**
 * `update_realm` descriptor — exact-grant-only (`@realm:edit`) bounded edit of
 * one realm the caller's grant scope reaches: display metadata
 * (`name`/`description`/`color`), one attach of an installed+connected
 * extension, or one attachment tool-ceiling change. Membership, provenance,
 * creation/deletion, detach/removal, raw attachment arrays, and every
 * authority id are operator-only and fail the whole call uniformly; the host
 * port applies the edit through the existing attach/ceiling paths and the
 * safe-state member sweep.
 */
export const updateRealmDescriptor = Object.freeze({
  name: REALM_ADMIN_TOOLS.UPDATE_REALM,
  authority: AGENT_AUTHORITIES.REALM_EDIT,
  description:
    'Update one realm you are authorized to edit (your own realm by default, or one realm by its display label when your grant reaches it): '
    + 'its display metadata (name, description, color), attach one installed and currently connected extension with an optional tool ceiling, '
    + 'or change one existing attachment\'s tool ceiling. The patch is validated as a whole (unknown or operator-only fields fail with no partial '
    + 'change; explicit tool selections must come from the extension\'s live tool catalog), attached capability changes reauthorize the realm '
    + 'members at their next safe state, and membership, provenance, creation/deletion, and detach/removal stay operator-only. '
    + 'Requires the update_realm capability.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      realm: {
        type: 'string',
        description: 'Display label of the realm to update; omitted for your own realm.'
      },
      patch: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Replacement realm display name.'
          },
          description: {
            type: ['string', 'null'],
            description: 'Replacement description; null clears it.'
          },
          color: {
            type: ['string', 'null'],
            description: 'Replacement accent color; null clears it.'
          },
          attach: {
            type: 'object',
            properties: {
              extensionId: {
                type: 'string',
                description: 'Id of one installed extension to attach to the realm.'
              },
              toolSelection: {
                type: ['string', 'array'],
                items: { type: 'string' },
                description: "Realm tool ceiling: 'all' or an explicit non-empty list of live call names."
              }
            },
            required: ['extensionId'],
            additionalProperties: false
          },
          toolSelection: {
            type: 'object',
            properties: {
              extensionId: {
                type: 'string',
                description: 'Id of an already attached extension.'
              },
              selection: {
                type: ['string', 'array'],
                items: { type: 'string' },
                description: "Replacement ceiling: 'all' or an explicit non-empty list of live call names."
              }
            },
            required: ['extensionId', 'selection'],
            additionalProperties: false
          }
        },
        additionalProperties: false
      }
    },
    required: ['patch'],
    additionalProperties: false
  }),
  paramAliasMap: realmUpdateParamAliasMap,
  sanitize: sanitizeRealmAdminUpdateParams,
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const port = realmAdminPortOf(context);
    const sanitized = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const keys = Object.keys(sanitized);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== 'realm' && keys[i] !== 'patch') {
        // Static message: an unknown parameter never echoes its key.
        return invalidArguments('update_realm does not accept unknown parameters.');
      }
    }
    const rawPatch = sanitized.patch;
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      return invalidArguments('update_realm requires a patch object with at least one editable field.');
    }
    const patchKeys = Object.keys(rawPatch);
    if (patchKeys.length === 0) {
      return invalidArguments('update_realm requires a patch object with at least one editable field.');
    }
    // Denied-key presence fails the whole call first (even `false`/`null`);
    // unknown keys are malformed params. Nothing is silently dropped. The same
    // closed-patch scan covers the `attach` / `toolSelection` containers, so a
    // nested denied/unknown key also fails the whole call before the port.
    for (let i = 0; i < patchKeys.length; i++) {
      if (isDeniedRealmAdminPatchKey(patchKeys[i])) {
        return {
          success: false,
          error: 'update_realm does not permit operator-only fields.',
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }
    for (let i = 0; i < patchKeys.length; i++) {
      if (!REALM_ADMIN_ALLOWED_PATCH_KEYS.has(patchKeys[i])) {
        return invalidArguments('update_realm does not accept unknown fields.');
      }
    }
    const nestedFailure = findRealmAdminNestedPatchFailure(rawPatch as Record<string, unknown>);
    if (nestedFailure) return nestedFailure;
    const realmLabel = normalizeRealmLabel(sanitized.realm);
    return port.updateRealm({
      actorRef: resolveRealmAdminActorRef(context),
      realmLabel,
      patch: rawPatch as RealmAdminPatch
    });
  }
});
/** camelCase alias of `updateRealmDescriptor`. */
export const updateRealm = updateRealmDescriptor;
/** snake_case alias of `updateRealmDescriptor`. */
export const update_realm = updateRealmDescriptor;

/**
 * Array of the M3 realm-admin authority descriptors: appended to
 * `authorityToolDescriptors` by `realmTools.ts`, so their schemas are exposed
 * through the generic exact-id filter and never through the canonical taxonomy.
 */
export const realmAdminToolDescriptors = Object.freeze([
  inspectRealmDescriptor,
  updateRealmDescriptor
]);

// ============================================================================
// M4 extension-admin meta tools (`list_extensions` / `attach_extension`, ticket a02bce7)
// ============================================================================

/**
 * Operator-only extension-management parameter vocabulary plus every exact
 * authority id (exact or snake_case spelling): presence fails the whole call
 * with the uniform permission denial before any port call, even for
 * `false`/`null` values. Install/connect/disconnect/remove and every
 * credential/transport-shaped key stay operator-only; the tool only ever
 * attaches an already installed+connected extension (decision `ce4b475`).
 * @internal
 */
const EXTENSIONS_ADMIN_DENIED_PARAM_KEYS: ReadonlySet<string> = new Set<string>([
  'install', 'uninstall',
  'remove', 'removeExtension', 'remove_extension',
  'detach', 'detachExtension', 'detach_extension',
  'connect', 'disconnect', 'reconnect',
  'credentials', 'credential', 'credentialId', 'credential_id',
  'secret', 'token', 'apiKey', 'api_key',
  'url', 'transportUrl', 'transport_url', 'transport', 'transportHint', 'transport_hint',
  'endpoint', 'approvedUrl', 'approved_url',
  'attachments', 'extensions', 'extensionTools', 'extension_tools',
  'realm', 'realmId', 'realm_id', 'realmLabel', 'realm_label', 'realmName', 'realm_name',
  'approvedBy', 'approved_by', 'approvedAt', 'approved_at',
  'status', 'live', 'connection', 'catalog',
  'authorities', 'authority', 'authorityGrants', 'authority_grants',
  'templateAuthority', 'template_authority', 'hydrationAuthority', 'hydration_authority'
]);

/**
 * Tests whether a sanitized extension-admin parameter is operator-only (exact
 * spelling, snake_case spelling, or an exact authority id in either spelling).
 *
 * @param key - Sanitized parameter key.
 * @returns True when the call must fail with the uniform permission denial.
 * @internal
 */
function isDeniedExtensionsAdminParam(key: string): boolean {
  if (EXTENSIONS_ADMIN_DENIED_PARAM_KEYS.has(key)) return true;
  if (META_AUTHORITY_ID_SET.has(key)) return true;
  const snake = toSnakeCase(key);
  if (snake && snake !== key) {
    if (EXTENSIONS_ADMIN_DENIED_PARAM_KEYS.has(snake)) return true;
    if (META_AUTHORITY_ID_SET.has(snake)) return true;
  }
  return false;
}

/**
 * Resolves the trusted pinned realm-admin port from the execution context for
 * the M4 methods (the port is the same frozen construction the M3 tools use;
 * a partial port without the M4 methods fails closed).
 *
 * @param context - Trusted execution context.
 * @returns The host port.
 * @throws `Error` - When no trusted port carrying the M4 methods is bound.
 * @internal
 */
function extensionsAdminPortOf(context: ExecutionContext): RealmAdminPort {
  const port = context?.realmAdminPort;
  if (!port || typeof port.listExtensions !== 'function' || typeof port.attachExtension !== 'function') {
    throw new Error('realmAdminPort service is not available in execution context');
  }
  return port;
}

/**
 * Custom extension-admin sanitizer: normalizes alias keys through the supplied
 * map while preserving unknown keys and `null` values so the handler can
 * classify them explicitly (an operator-only or unknown parameter must fail the
 * whole call, never be silently dropped). Total and prototype-pollution-safe.
 *
 * @param rawArgs - Raw tool arguments (object, JSON string, or arbitrary value).
 * @param aliasMap - Parameter alias map for the specific tool.
 * @returns A fresh sanitized parameter record.
 * @internal
 */
function sanitizeExtensionsAdminParams(
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

/** `list_extensions` parameter alias map (the listing takes no parameters). @internal */
const extensionsListParamAliasMap: Readonly<Record<string, string>> = Object.freeze({});

/**
 * `attach_extension` parameter alias map: extension id addressing and the
 * tool-selection ceiling normalize to their canonical keys; every other key
 * passes through verbatim so the deny/unknown scan sees the caller's spelling.
 * @internal
 */
const extensionsAttachParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  extensionId: 'extensionId',
  extension_id: 'extensionId',
  extension: 'extensionId',
  id: 'extensionId',
  toolSelection: 'toolSelection',
  tool_selection: 'toolSelection',
  selection: 'toolSelection'
});

/**
 * `list_extensions` descriptor — exact-grant-only (`@extensions:authority`)
 * bounded read of the host's installed extensions and the caller realm's
 * attachments: install metadata, live connection state, and available call
 * names. Transport URLs and credential material never appear.
 */
export const listExtensionsDescriptor = Object.freeze({
  name: EXTENSIONS_ADMIN_TOOLS.LIST_EXTENSIONS,
  authority: AGENT_AUTHORITIES.EXTENSIONS,
  description:
    'List the installed extensions and the extensions attached to your realm, with each extension\'s kind, installation status, '
    + 'live connection state, whether your realm attaches it, and the call names its live tool catalog provides. '
    + 'Requires the list_extensions capability; the listing never carries transport endpoints or credential material.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [] as string[],
    additionalProperties: false
  }),
  paramAliasMap: extensionsListParamAliasMap,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeExtensionsAdminParams(rawArgs, extensionsListParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const port = extensionsAdminPortOf(context);
    const keys = Object.keys(params || {});
    for (let i = 0; i < keys.length; i++) {
      if (isDeniedExtensionsAdminParam(keys[i])) {
        return {
          success: false,
          error: 'list_extensions does not permit operator-only parameters.',
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }
    if (keys.length > 0) {
      // Static message: an unknown parameter never echoes its key.
      return invalidArguments('list_extensions does not accept unknown parameters.');
    }
    return port.listExtensions({ actorRef: resolveRealmAdminActorRef(context) });
  }
});
/** camelCase alias of `listExtensionsDescriptor`. */
export const listExtensions = listExtensionsDescriptor;
/** snake_case alias of `listExtensionsDescriptor`. */
export const list_extensions = listExtensionsDescriptor;

/**
 * `attach_extension` descriptor — exact-grant-only (`@extensions:authority`)
 * realm-wide attach of one installed+connected extension: the caller's realm
 * uniform set gains the attachment through the shared store path and the
 * member safe-state sweep follows. Repeat attaches are idempotent (no mutation,
 * no duplicate audit). Install/connect/disconnect/remove, credential handling,
 * realm addressing, and every authority id are operator-only and fail the
 * whole call uniformly.
 */
export const attachExtensionDescriptor = Object.freeze({
  name: EXTENSIONS_ADMIN_TOOLS.ATTACH_EXTENSION,
  authority: AGENT_AUTHORITIES.EXTENSIONS,
  description:
    'Attach one installed and currently connected extension to your realm as a realm-wide capability (every member\'s effective tool policy '
    + 'recomputes at its next safe state), with an optional tool ceiling of explicit live call names or \'all\'. '
    + 'Unknown, not-installed, and not-connected extensions fail closed, an already attached extension is an idempotent no-op, and the call '
    + 'never installs, connects, disconnects, detaches, or touches credentials. Requires the attach_extension capability.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      extensionId: {
        type: 'string',
        description: 'Id of an installed extension to attach to your realm.'
      },
      toolSelection: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description: "Realm tool ceiling for the new attachment: 'all' or an explicit non-empty list of live call names."
      }
    },
    required: ['extensionId'],
    additionalProperties: false
  }),
  paramAliasMap: extensionsAttachParamAliasMap,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeExtensionsAdminParams(rawArgs, extensionsAttachParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const port = extensionsAdminPortOf(context);
    const sanitized = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const keys = Object.keys(sanitized);
    // Denied-key presence fails the whole call first (even `false`/`null`);
    // unknown keys are malformed params — nothing is silently dropped.
    for (let i = 0; i < keys.length; i++) {
      if (isDeniedExtensionsAdminParam(keys[i])) {
        return {
          success: false,
          error: 'attach_extension does not permit operator-only parameters.',
          code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== 'extensionId' && keys[i] !== 'toolSelection') {
        // Static message: an unknown parameter never echoes its key.
        return invalidArguments('attach_extension does not accept unknown parameters.');
      }
    }
    const extensionId = sanitized.extensionId;
    if (typeof extensionId !== 'string' || !extensionId.trim()) {
      return invalidArguments("attach_extension: 'extensionId' is required and must be a non-empty string.");
    }
    const rawSelection = sanitized.toolSelection;
    return port.attachExtension({
      actorRef: resolveRealmAdminActorRef(context),
      extensionId,
      // Shape validation lives in the store port (the same normalizer the M3
      // ceiling path uses); a malformed ceiling fails the whole call.
      ...(rawSelection !== undefined ? { toolSelection: rawSelection as 'all' | readonly string[] } : {})
    });
  }
});
/** camelCase alias of `attachExtensionDescriptor`. */
export const attachExtension = attachExtensionDescriptor;
/** snake_case alias of `attachExtensionDescriptor`. */
export const attach_extension = attachExtensionDescriptor;

/**
 * Array of the M4 extension-admin authority descriptors: appended to
 * `authorityToolDescriptors` by `realmTools.ts`, so their schemas are exposed
 * through the generic exact-id filter and never through the canonical taxonomy.
 */
export const extensionsAdminToolDescriptors = Object.freeze([
  listExtensionsDescriptor,
  attachExtensionDescriptor
]);

// ============================================================================
// M5b realm-knowledge meta tools (`list_templates` / `get_template` /
// `list_hydration_packages`, ticket fb7d270)
// ============================================================================

/**
 * Resolves the trusted pinned publishing port and one of its M5b read members
 * from the execution context (a partial port without the required member fails
 * closed). Never a per-call claim: `realmPublishingPort` is a pinned context
 * key.
 *
 * @param context - Trusted execution context.
 * @param member - Required read member of the publishing port.
 * @returns The host publishing port.
 * @throws `Error` - When no trusted port carrying the member is bound.
 * @internal
 */
function realmKnowledgePortOf(
  context: ExecutionContext,
  member: 'listEffectiveTemplates' | 'getEffectiveTemplateBundle' | 'listPendingInstancePayloads' | 'listSavedInstancePayloads'
): RealmPublishingPort {
  const port = context?.realmPublishingPort;
  if (!port || typeof port !== 'object' || typeof (port as unknown as Record<string, unknown>)[member] !== 'function') {
    throw new Error('realmPublishingPort service is not available in execution context');
  }
  return port;
}

/** `get_template` parameter alias map (template-id addressing only). @internal */
const getTemplateParamAliasMap: Readonly<Record<string, string>> = Object.freeze({
  templateId: 'templateId',
  template_id: 'templateId',
  id: 'templateId',
  template: 'templateId',
  name: 'templateId'
});

/**
 * `list_templates` descriptor — exact-grant-only (`@template:authority`)
 * bounded listing of the effective template catalog: id, name, effective
 * version, description, exposed format version, and launchability. Bundle
 * bodies, host paths, and realm vocabulary never appear.
 */
export const listTemplatesDescriptor = Object.freeze({
  name: REALM_KNOWLEDGE_TOOLS.LIST_TEMPLATES,
  authority: AGENT_AUTHORITIES.TEMPLATE,
  description:
    'List the realm templates available for launch, in catalog order: each entry carries the template id, display name, '
    + 'effective content version, description, format version, and whether the template is launchable. '
    + 'The listing never carries template file bodies, host paths, or runtime state; use get_template for one template\'s model.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [] as string[],
    additionalProperties: false
  }),
  paramAliasMap: Object.freeze({}) as Readonly<Record<string, string>>,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeExtensionsAdminParams(rawArgs, Object.freeze({})),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const port = realmKnowledgePortOf(context, 'listEffectiveTemplates');
    const keys = Object.keys(params || {});
    if (keys.length > 0) {
      // Static message: an unknown parameter never echoes its key.
      return invalidArguments('list_templates does not accept parameters.');
    }
    const templates = port.listEffectiveTemplates();
    return Object.freeze({ success: true, count: templates.length, templates });
  }
});
/** camelCase alias of `listTemplatesDescriptor`. */
export const listTemplates = listTemplatesDescriptor;
/** snake_case alias of `listTemplatesDescriptor`. */
export const list_templates = listTemplatesDescriptor;

/**
 * `get_template` descriptor — exact-grant-only (`@template:authority`)
 * resolution of one effective template as its normalized format-v2 model
 * (declared inputs, agent profiles, prompt/placement declarations). Bundle
 * file bodies and host paths never appear.
 */
export const getTemplateDescriptor = Object.freeze({
  name: REALM_KNOWLEDGE_TOOLS.GET_TEMPLATE,
  authority: AGENT_AUTHORITIES.TEMPLATE,
  description:
    'Resolve one realm template by id and return its normalized format-v2 model: declared inputs, agent profiles, prompts, placements, '
    + 'and directives. Use list_templates to discover template ids. Unknown ids fail closed without disclosing catalog state.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      templateId: {
        type: 'string',
        description: 'Id of the realm template to resolve (from list_templates).'
      }
    },
    required: ['templateId'],
    additionalProperties: false
  }),
  paramAliasMap: getTemplateParamAliasMap,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeExtensionsAdminParams(rawArgs, getTemplateParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const port = realmKnowledgePortOf(context, 'getEffectiveTemplateBundle');
    const sanitized = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const keys = Object.keys(sanitized);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== 'templateId') {
        // Static message: an unknown parameter never echoes its key.
        return invalidArguments('get_template does not accept unknown parameters.');
      }
    }
    const rawId = sanitized.templateId;
    if (typeof rawId !== 'string' || !rawId.trim()) {
      return invalidArguments("get_template: 'templateId' is required and must be a non-empty string.");
    }
    const effective = port.getEffectiveTemplateBundle(rawId.trim());
    if (!effective) {
      // Static message: an unknown template id is never echoed.
      return invalidArguments('get_template targets an unknown realm template.');
    }
    const template = normalizeTemplate(effective.template);
    return Object.freeze({
      success: true,
      templateId: template.id,
      templateVersion: effective.version,
      template
    });
  }
});
/** camelCase alias of `getTemplateDescriptor`. */
export const getTemplate = getTemplateDescriptor;
/** snake_case alias of `getTemplateDescriptor`. */
export const get_template = getTemplateDescriptor;

/**
 * `list_hydration_packages` descriptor — exact-grant-only
 * (`@hydration:authority`) bounded listing of the session-pending and
 * persisted saved hydration payloads: template id, version, canonical digest,
 * and ids/timestamps. Raw payload bodies never appear.
 */
export const listHydrationPackagesDescriptor = Object.freeze({
  name: REALM_KNOWLEDGE_TOOLS.LIST_HYDRATION_PACKAGES,
  authority: AGENT_AUTHORITIES.HYDRATION,
  description:
    'List the hydration payloads known to this host: the session-pending candidate of each template and the persisted saved-payload library, '
    + 'each with its template id, validated template version, canonical payload digest, and resolution/save timestamp. '
    + 'The listing never carries payload bodies; use submit_hydration_package to author a candidate.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [] as string[],
    additionalProperties: false
  }),
  paramAliasMap: Object.freeze({}) as Readonly<Record<string, string>>,
  sanitize: (rawArgs?: unknown): ToolParams => sanitizeExtensionsAdminParams(rawArgs, Object.freeze({})),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const pendingPort = realmKnowledgePortOf(context, 'listPendingInstancePayloads');
    const savedPort = realmKnowledgePortOf(context, 'listSavedInstancePayloads');
    const keys = Object.keys(params || {});
    if (keys.length > 0) {
      // Static message: an unknown parameter never echoes its key.
      return invalidArguments('list_hydration_packages does not accept parameters.');
    }
    return Object.freeze({
      success: true,
      pending: pendingPort.listPendingInstancePayloads(),
      saved: savedPort.listSavedInstancePayloads()
    });
  }
});
/** camelCase alias of `listHydrationPackagesDescriptor`. */
export const listHydrationPackages = listHydrationPackagesDescriptor;
/** snake_case alias of `listHydrationPackagesDescriptor`. */
export const list_hydration_packages = listHydrationPackagesDescriptor;

/**
 * Array of the M5b realm-knowledge authority descriptors: appended to
 * `authorityToolDescriptors` by `realmTools.ts`, so their schemas are exposed
 * through the generic exact-id filter and never through the canonical taxonomy.
 */
export const realmKnowledgeToolDescriptors = Object.freeze([
  listTemplatesDescriptor,
  getTemplateDescriptor,
  listHydrationPackagesDescriptor
]);
