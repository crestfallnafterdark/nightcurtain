/**
 * Tool descriptors for Runtime Scheduler operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated schedulerToolDescriptors array.
 */

import { SANDBOX_TOOLS, TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a scheduler descriptor handler. */
type ToolParams = Record<string, unknown>;

/** Identity-only caller scope forwarded to the lifecycle port. */
interface CallerScope {
  callerAgentId: string;
  /**
   * Trusted canonical identity key of the caller (Wave I, ticket d57cbc1;
   * I2-V residual R4, fix lane G6). Forwarded only when the dispatcher pinned
   * it from realm-exact construction; per-call `callerKey`/`caller_key` claims
   * are stripped before dispatch and are never read here.
   */
  callerKey?: string;
  principal?: object;
}

/** Structural view of the identity port's ambiguity-relevant enumeration member. */
interface AmbiguityAwareIdentityPort {
  listAgentIdentities?(scope?: { realmId?: string | null }): unknown;
}

/** Uniform refusal for a scheduler call whose bound caller cannot be resolved. */
const CALLER_IDENTITY_REFUSED_MESSAGE =
  'The caller identity could not be resolved; the operation is not permitted.';

/** Call-site view of the lifecycle port members consumed by this descriptor. */
interface LifecyclePortView {
  schedule(options: Record<string, unknown>, context?: object): unknown;
  listSchedules(options: object, context: object): unknown;
  cancelSchedule(params: { timerId: unknown }, reason: null, context: object): unknown;
}

/** Exact shape of the internal realm-global partition key (`realm:<realmId>:global`). */
const REALM_PARTITION_KEY_PATTERN = /^realm:[^:]+:global$/;

/** Target/owner fields on scheduler receipts rewritten by the opacity sanitizer (R3, ticket 10eab05). */
const SCHEDULER_PARTITION_FIELDS: ReadonlyArray<string> = Object.freeze(['agentId', 'targetAgentId']);

/**
 * Maps the internal realm-global partition key to the agent-visible label
 * `global`; every other identifier passes through unchanged.
 *
 * @param value - Candidate partition or owner identifier.
 * @returns The agent-visible label.
 */
function toAgentVisiblePartitionKey(value: string): string {
  return REALM_PARTITION_KEY_PATTERN.test(value) ? 'global' : value;
}

/**
 * Deep-copies a scheduler tool receipt, rewriting the internal
 * `realm:<realmId>:global` partition key to `global` in target/owner fields
 * (`agentId`, `targetAgentId`) and in nested `schedules` projections (R3,
 * ticket 10eab05). Agent-authored content (prompts, cancel reasons) is never
 * rewritten, and the runtime API surface keeps the internal key unchanged.
 *
 * @param value - Scheduler receipt or projection to sanitize.
 * @returns A sanitized deep copy.
 */
function sanitizeAgentVisibleScheduleReceipt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAgentVisibleScheduleReceipt(entry));
  }
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of SCHEDULER_PARTITION_FIELDS) {
    if (typeof out[field] === 'string') out[field] = toAgentVisiblePartitionKey(out[field] as string);
  }
  if (Array.isArray(out.schedules)) {
    out.schedules = out.schedules.map((entry) => sanitizeAgentVisibleScheduleReceipt(entry));
  }
  return out;
}

/**
 * Resolves the registered caller subject from the trusted execution context.
 * The dispatcher pins `callerAgentId` from bound construction only; the nested
 * `callerContext` key is caller data and is never consulted (ticket a1ce597).
 *
 * @param context - Optional trusted execution context
 * @returns The bound subject id, or `null` when no subject is bound
 */
function resolveCallerAgentId(context: ExecutionContext): string | null {
  const rawCallerAgentId = context?.callerAgentId || context?.agentId || null;
  return typeof rawCallerAgentId === 'string' && rawCallerAgentId ? rawCallerAgentId : null;
}

/**
 * Resolves the dispatcher-pinned canonical caller key from the trusted
 * execution context (Wave I, ticket d57cbc1; I2-V residual R4, fix lane G6).
 *
 * The key is trusted construction output only: the dispatcher binds it when
 * the caller resolved through a realm-exact scope (a construction-bound
 * `realmId`, including the explicit system scope) or when the turn engine
 * forwards the executing agent's canonical identity; a per-call
 * `callerKey`/`caller_key` claim is stripped before dispatch (pinned key) and
 * is never read here.
 *
 * @param context - Optional trusted execution context
 * @returns The pinned canonical identity key, or `null` when none is bound
 */
function resolvePinnedCallerKey(context: ExecutionContext): string | null {
  const rawCallerKey = context?.callerKey;
  return typeof rawCallerKey === 'string' && rawCallerKey ? rawCallerKey : null;
}

/**
 * Resolves the trusted realm scope bound to the dispatcher construction, if
 * any (Wave I, ticket d57cbc1; I2-V residual R4, fix lane G6). A
 * construction-bound `realmId` is a pinned scope key: a per-call claim is
 * stripped before dispatch. `undefined` means no scope was bound (legacy
 * unique-match construction); an explicit `null` is the system scope.
 *
 * @param context - Optional trusted execution context
 * @returns The bound identity scope for the identity port, or `undefined`
 */
function resolveBoundRealmScope(context: ExecutionContext): { realmId: string | null } | undefined {
  const rawRealmId = context?.realmId;
  if (typeof rawRealmId === 'string' && rawRealmId) return { realmId: rawRealmId };
  if (rawRealmId === null) return { realmId: null };
  return undefined;
}

/**
 * Resolves the identity-only caller scope embedded into LifecyclePort requests
 * (Wave I, ticket d57cbc1; I2-V residual R4, fix lane G6).
 *
 * The scope carries the registered subject id plus, when the injected identity
 * projection provides one, the frozen `AuthorityDescriptor` as the principal,
 * and the dispatcher-pinned canonical `callerKey` when the caller resolved
 * realm-exactly. Resolution mirrors the G1/F4 lifecycle/invocation caller
 * pattern: a pinned canonical key resolves its exact registration on its own;
 * otherwise the bound realm scope disambiguates the same-literal-id pair;
 * otherwise the legacy unique-match rule applies.
 *
 * Unlike the lifecycle lane, the principal is forwarded even when the bare
 * subject is ambiguous across Realms: the scheduler resolves a validated
 * principal's identity from the trusted `callerKey` ahead of the bare subject
 * and would otherwise fail the same-id caller closed. `callerKey` remains a
 * hint — the scheduler accepts it only when the registry authority resolver
 * binds it back to the same descriptor instance, so a forged key never widens.
 *
 * Caller-asserted privilege flags and authority-bearing role aliases are never
 * read here: scheduler authorization is resolved server-side from the registry
 * descriptor for the supplied subject (MOD-21); per-call identity/realm claims
 * are stripped before dispatch and are never consulted.
 *
 * @param context - Optional trusted execution context
 * @returns The identity-only caller scope, or `null` when no subject is bound
 */
function resolveCallerScope(context: ExecutionContext): CallerScope | null {
  const callerAgentId = resolveCallerAgentId(context);
  if (!callerAgentId) return null;

  const pinnedCallerKey = resolvePinnedCallerKey(context);

  let principal: object | null = null;
  const identityPort = context?.identityPort;
  if (identityPort && typeof identityPort.getAgentIdentity === 'function') {
    try {
      const projection = pinnedCallerKey
        ? identityPort.getAgentIdentity(pinnedCallerKey)
        : identityPort.getAgentIdentity(callerAgentId, resolveBoundRealmScope(context));
      if (projection && projection.authority) principal = projection.authority;
    } catch {
      principal = null;
    }
  }

  const scope: CallerScope = { callerAgentId };
  if (pinnedCallerKey) scope.callerKey = pinnedCallerKey;
  if (principal) scope.principal = principal;
  return scope;
}

/**
 * Reports whether the bound caller cannot be resolved to one exact
 * registration (Wave I, ticket d57cbc1; I2-V residual R4, fix lane G6).
 *
 * Fail-closed rules, mirroring the G1/F4 caller-resolution pattern:
 * - a supplied (dispatcher-pinned) canonical key that resolves no registration
 *   is the caller's only identity channel and must never fall back to the bare
 *   subject — otherwise a stale key left over from a recycled holder retargets
 *   the other Realm's same-literal-id twin;
 * - a keyless caller with a bound realm scope whose `(realmId, agentId)`
 *   registration resolves nothing cannot be attributed either — the bare
 *   unique-match rule could resolve a different Realm's registration;
 * - a keyless, unscoped bare id registered in several Realms names no exact
 *   caller and must not degrade to the anonymous host path.
 *
 * Dispatchers without an identity port (host/test constructions) keep their
 * legacy behavior; the check is read-only and never widens authority.
 *
 * @param context - Optional trusted execution context
 * @returns True when the bound caller must fail closed
 */
function isBoundCallerUnresolvable(context: ExecutionContext): boolean {
  const callerAgentId = resolveCallerAgentId(context);
  if (!callerAgentId) return false;
  const identityPort = context?.identityPort;
  if (!identityPort || typeof identityPort.getAgentIdentity !== 'function') return false;

  const pinnedCallerKey = resolvePinnedCallerKey(context);
  if (pinnedCallerKey) {
    try {
      return !identityPort.getAgentIdentity(pinnedCallerKey);
    } catch {
      return true;
    }
  }

  const boundScope = resolveBoundRealmScope(context);
  try {
    if (identityPort.getAgentIdentity(callerAgentId, boundScope)) return false;
  } catch {
    return false;
  }
  if (boundScope) return true;

  const enumerator = identityPort as unknown as AmbiguityAwareIdentityPort;
  if (typeof enumerator.listAgentIdentities !== 'function') return false;
  try {
    const registrations = enumerator.listAgentIdentities();
    if (!Array.isArray(registrations)) return false;
    let matches = 0;
    for (const registration of registrations) {
      const source = registration && typeof registration === 'object'
        ? registration as { id?: unknown }
        : null;
      if (source && source.id === callerAgentId) {
        matches += 1;
        if (matches > 1) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Builds the uniform permission-denied receipt for a scheduler call whose
 * bound caller cannot be resolved to one exact registration.
 *
 * @param context - Trusted execution context
 * @returns The refusal receipt, or `null` when the caller resolves
 */
function refusedCallerIdentityReceipt(context: ExecutionContext): Record<string, unknown> | null {
  return isBoundCallerUnresolvable(context)
    ? {
        success: false,
        error: CALLER_IDENTITY_REFUSED_MESSAGE,
        code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
      }
    : null;
}

// --- 1. schedule ---
const scheduleParamAliasMap = Object.freeze({
  action: 'action',
  prompt: 'prompt',
  delay_seconds: 'delay_seconds',
  delaySeconds: 'delay_seconds',
  duration_seconds: 'delay_seconds',
  durationSeconds: 'delay_seconds',
  condition: 'condition',
  timer_condition: 'condition',
  timerCondition: 'condition'
});

/**
 * `schedule` descriptor — schedule a deferred one-shot turn execution or timer.
 *
 * Args: `action` (required), optional `prompt`, `delay_seconds`, `condition`.
 * Delegates to `context.lifecyclePort.schedule()` with the bound caller id
 * (target pin) and the identity-only caller scope as the trusted `context`
 * (server-side authority/Realm resolution; ticket 61dae28); throws when that
 * service is missing.
 */
export const scheduleDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.SCHEDULE,
  description: 'Schedule a deferred one-shot turn execution or timer.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Scheduling action (e.g. "create", "timer").'
      },
      prompt: {
        type: 'string',
        description: 'Instruction prompt or task to execute upon trigger.'
      },
      delay_seconds: {
        type: 'number',
        description: 'Delay in seconds before triggering the one-shot timer.'
      },
      condition: {
        type: 'string',
        description: 'Early termination condition: "never", "any", or specific sender ID.'
      }
    },
    required: ['action'],
    additionalProperties: false
  }),
  paramAliasMap: scheduleParamAliasMap,
  sanitize: createParamSanitizer(scheduleParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.schedule !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Fail closed on a bound caller that cannot be attributed to one exact
    // registration (Wave I, ticket d57cbc1; I2-V residual R4, fix lane G6): a
    // stale pinned key or an ambiguous keyless bare id must never fall back to
    // a different Realm's same-literal-id twin or to the anonymous host path.
    const refused = refusedCallerIdentityReceipt(context);
    if (refused) return refused;
    const scope = resolveCallerScope(context);
    // Identity + trusted principal travel in the explicit `context` argument
    // (mirroring `list_schedules`/`cancel_schedule`); the parameter object keeps
    // only the dispatcher-bound target pin, never a privilege flag. Caller-
    // supplied claims remain inert: the pinned `agentId` wins over params and
    // authority is resolved server-side from the frozen registry descriptor.
    // The pinned canonical `callerKey` rides along so the scheduler resolves
    // the same-id caller realm-exactly and arms its canonical dispatch ref.
    return sanitizeAgentVisibleScheduleReceipt(await lifecyclePort.schedule({
      ...(params && typeof params === 'object' ? params : {}),
      ...(scope ? { agentId: scope.callerAgentId } : {})
    }, scope || {}));
  }
});
/** Alias of `scheduleDescriptor` (single-word canonical name). */
export const schedule = scheduleDescriptor;

// --- 2. list_schedules ---
/**
 * `list_schedules` descriptor — list active, pending, and triggered schedules and
 * timers.
 *
 * Declares no parameters; delegates to
 * `context.lifecyclePort.listSchedules({}, scope)` and throws when that service
 * is missing.
 */
export const listSchedulesDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.LIST_SCHEDULES,
  description: 'List all active, pending, or triggered schedules and timers.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: Object.freeze({}),
  sanitize: createParamSanitizer({}),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.listSchedules !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Fail closed on an unattributable bound caller (see `schedule`): the
    // stale-key / ambiguous-keyless caller must never list another Realm's
    // same-literal-id schedules or degrade to the anonymous empty view.
    const refused = refusedCallerIdentityReceipt(context);
    if (refused) return refused;
    const scope = resolveCallerScope(context);
    // The schema declares no properties, so caller params are never forwarded as
    // scheduler options (privilege-smuggling guard); identity travels in the
    // explicit `context` argument and authority is resolved server-side. The
    // returned projections are realm-opaque (R3): any internal realm-global
    // partition key is labeled `global` before reaching the agent.
    return sanitizeAgentVisibleScheduleReceipt(await lifecyclePort.listSchedules({}, scope || {}));
  }
});
/** camelCase alias of `listSchedulesDescriptor`. */
export const listSchedules = listSchedulesDescriptor;
/** snake_case alias of `listSchedulesDescriptor`. */
export const list_schedules = listSchedulesDescriptor;

// --- 3. cancel_schedule ---
const cancelScheduleParamAliasMap = Object.freeze({
  task_id: 'task_id',
  taskId: 'task_id',
  timer_id: 'task_id',
  timerId: 'task_id',
  id: 'task_id'
});

/**
 * `cancel_schedule` descriptor — cancel an active or pending scheduled task by
 * its task ID.
 *
 * Args: `task_id` (required). Delegates to
 * `context.lifecyclePort.cancelSchedule()` with the bound caller scope and throws
 * when that service is missing.
 */
export const cancelScheduleDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.CANCEL_SCHEDULE,
  description: 'Cancel an active or pending scheduled task by its task ID.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Unique identifier of the schedule or timer task to cancel.'
      }
    },
    required: ['task_id'],
    additionalProperties: false
  }),
  paramAliasMap: cancelScheduleParamAliasMap,
  sanitize: createParamSanitizer(cancelScheduleParamAliasMap),
  handler: async (params: ToolParams | string, context: ExecutionContext) => {
    const taskId = typeof params === 'object' ? (params?.task_id || params?.taskId || params?.timer_id || params?.timerId || params?.id) : params;
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.cancelSchedule !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Fail closed on an unattributable bound caller (see `schedule`): a stale
    // pinned key must never cancel a foreign same-id timer under the surviving
    // twin's authority.
    const refused = refusedCallerIdentityReceipt(context);
    if (refused) return refused;
    const scope = resolveCallerScope(context);
    // Identity + trusted principal travel in the explicit `context` argument; no
    // privilege flag is ever placed in the parameter object (privilege-smuggling
    // guard) and authority is resolved server-side. The receipt is realm-opaque
    // (R3): internal realm-global partition keys never reach the agent.
    return sanitizeAgentVisibleScheduleReceipt(await lifecyclePort.cancelSchedule(
      { timerId: taskId },
      null,
      scope || {}
    ));
  }
});
/** camelCase alias of `cancelScheduleDescriptor`. */
export const cancelSchedule = cancelScheduleDescriptor;
/** snake_case alias of `cancelScheduleDescriptor`. */
export const cancel_schedule = cancelScheduleDescriptor;

/**
 * Array of all Scheduler Tool Descriptors
 */
export const schedulerToolDescriptors = Object.freeze([
  scheduleDescriptor,
  listSchedulesDescriptor,
  cancelScheduleDescriptor
]);
