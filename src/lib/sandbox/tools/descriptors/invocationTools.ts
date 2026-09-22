/**
 * Tool descriptors for Synchronous and Direct Agent Invocation operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated invocationToolDescriptors array.
 */

import { SANDBOX_TOOLS } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to an invocation descriptor handler. */
type ToolParams = Record<string, unknown>;

/** Identity-only caller scope forwarded to the lifecycle port. */
interface CallerScope {
  callerAgentId: string;
  /**
   * Trusted canonical identity key of the caller (Wave I, ticket d57cbc1).
   * Forwarded only when the dispatcher pinned it from realm-exact
   * construction; per-call `callerKey`/`caller_key` claims are stripped before
   * dispatch and are never read here.
   */
  callerKey?: string;
  principal?: object;
}

/**
 * Trusted caller resolution for invocation descriptors (Wave I, ticket
 * d57cbc1): the identity-only port scope plus the Realm context the invocation
 * path needs to disambiguate a bare same-id target.
 */
interface TrustedCaller {
  /** Identity-only caller scope forwarded to the lifecycle port. */
  scope: CallerScope;
  /** Realm membership of the resolved caller (`null` = system scope/unresolved). */
  realmId: string | null;
  /** Whether the resolved caller holds the `realmBypass` grant. */
  realmBypass: boolean;
}

/** Call-site view of the lifecycle port members consumed by this descriptor. */
interface LifecyclePortView {
  invokeAgent(
    invokerId: string | undefined,
    targetAgentId: unknown,
    prompt: unknown,
    options: Record<string, unknown>
  ): unknown;
  waitForInvocation(
    ids: unknown,
    options: Record<string, unknown>,
    scope?: CallerScope
  ): unknown;
}

/**
 * Resolves the trusted caller context for an invocation request.
 *
 * The invoker is named by the registered subject id; when the injected identity
 * projection carries the frozen `AuthorityDescriptor` and its bare subject
 * resolves uniquely, it is forwarded as the principal. The dispatcher-pinned
 * canonical `callerKey` (Wave I, ticket d57cbc1) rides along when the caller
 * resolved realm-exactly, so the invocation engine disambiguates
 * same-literal-id registrations. The caller's Realm membership and
 * `realmBypass` grant are resolved for target disambiguation only and are
 * never forwarded to the port.
 *
 * The frozen principal is withheld for a caller whose bare subject is
 * ambiguous across Realms: the invocation engine's await channel resolves an
 * agent principal by its bare subject ahead of the canonical `callerKey`, so
 * an ambiguous principal would mask the realm-exact key and fail the caller
 * closed. The canonical key remains that caller's identity channel.
 *
 * Caller-asserted privilege flags and authority-bearing role aliases are never
 * read here — the invocation engine resolves invoker authority from the
 * registry descriptor for the supplied subject (MOD-21). Per-call
 * `callerKey`/`caller_key` and `realmId` claims are stripped by the dispatcher
 * and are never read.
 *
 * @param context - Optional trusted execution context
 * @returns The trusted caller resolution, or `null` when no subject is bound
 */
function resolveTrustedCaller(context: ExecutionContext): TrustedCaller | null {
  // The dispatcher pins `callerAgentId` from bound construction only; a nested
  // `callerContext.agentId` is caller data and is never consulted (a1ce597).
  const rawCallerAgentId = context?.callerAgentId || context?.agentId || null;
  const callerAgentId = typeof rawCallerAgentId === 'string' && rawCallerAgentId ? rawCallerAgentId : null;
  if (!callerAgentId) return null;

  // Pinned canonical identity key (Wave I, ticket d57cbc1): bound by the
  // dispatcher only when the caller resolved through the trusted realm scope;
  // a per-call `callerKey`/`caller_key` claim is stripped before dispatch.
  const rawCallerKey = context?.callerKey;
  const pinnedCallerKey = typeof rawCallerKey === 'string' && rawCallerKey ? rawCallerKey : null;

  // Trusted Realm scope pinned at dispatcher construction (`null` = system
  // scope); a per-call realm claim is stripped before dispatch (c7a3049).
  const rawRealmId = context?.realmId;
  const boundRealmId = typeof rawRealmId === 'string' && rawRealmId
    ? rawRealmId
    : (rawRealmId === null ? null : undefined);

  let principal: object | null = null;
  let realmId: string | null = boundRealmId === undefined ? null : boundRealmId;
  let realmBypass = false;
  const identityPort = context?.identityPort;
  if (identityPort && typeof identityPort.getAgentIdentity === 'function') {
    try {
      // A pinned canonical key resolves the exact registration on its own;
      // otherwise the trusted Realm scope (when one is bound) disambiguates
      // the same-literal-id pair and the legacy unique-match rule applies.
      const projection = pinnedCallerKey
        ? identityPort.getAgentIdentity(pinnedCallerKey)
        : identityPort.getAgentIdentity(
          callerAgentId,
          boundRealmId === undefined ? undefined : { realmId: boundRealmId }
        );
      if (projection) {
        // A principal whose bare subject is ambiguous across Realms is
        // withheld: the engine's principal branch resolves it by the bare
        // subject, which would mask the canonical key channel (see above).
        let principalUsable = true;
        if (pinnedCallerKey) {
          try {
            principalUsable = Boolean(identityPort.getAgentIdentity(callerAgentId));
          } catch {
            principalUsable = false;
          }
        }
        if (projection.authority && principalUsable) principal = projection.authority;
        if (typeof projection.realmId === 'string' && projection.realmId) realmId = projection.realmId;
        realmBypass = projection.realmBypass === true;
      }
    } catch {
      principal = null;
    }
  }

  const scope: CallerScope = { callerAgentId };
  if (pinnedCallerKey) scope.callerKey = pinnedCallerKey;
  if (principal) scope.principal = principal;
  return { scope, realmId, realmBypass };
}

/**
 * Resolves a tool-supplied invocation target to the realm-exact registration
 * key when only the caller's Realm can disambiguate it (Wave I, ticket
 * d57cbc1).
 *
 * A reference that resolves on its own (a canonical key or a globally unique
 * bare id) is forwarded unchanged, preserving the legacy channel. A bare id
 * registered in several Realms resolves inside the caller's own Realm through
 * the trusted identity port, so the invocation engine addresses the exact
 * registration instead of failing closed on the ambiguity. Bypass principals,
 * callers without a resolved Realm, and unresolvable (foreign/unknown) targets
 * fall through unchanged: the engine's authority gate, Realm confinement and
 * not-found handling remain the sole decision surface, and no caller-supplied
 * claim is ever promoted into a scope.
 *
 * @param identityPort - Trusted identity resolver from the execution context
 * @param targetAgentId - Sanitized tool-supplied target reference
 * @param caller - Trusted caller resolution
 * @returns The reference to forward to the lifecycle port
 */
function resolveTargetReference(
  identityPort: ExecutionContext['identityPort'],
  targetAgentId: unknown,
  caller: TrustedCaller
): unknown {
  if (typeof targetAgentId !== 'string' || !targetAgentId) return targetAgentId;
  if (!identityPort || typeof identityPort.getAgentIdentity !== 'function') return targetAgentId;
  // Bypass principals resolve bare ids by the global unique-match rule (an
  // ambiguous id fails closed) and a caller with no resolved Realm has no
  // scope to disambiguate with; both keep the caller-supplied reference.
  if (caller.realmBypass || !caller.realmId) return targetAgentId;
  try {
    if (identityPort.getAgentIdentity(targetAgentId)) return targetAgentId;
    const scoped = identityPort.getAgentIdentity(targetAgentId, { realmId: caller.realmId });
    if (scoped && typeof scoped.key === 'string' && scoped.key) return scoped.key;
  } catch {
    // Fall through to the caller-supplied reference (fail-closed downstream).
  }
  return targetAgentId;
}

// --- 1. invoke_agent ---
const invokeAgentParamAliasMap = Object.freeze({
  agent_id: 'agent_id',
  agentId: 'agent_id',
  target_agent_id: 'agent_id',
  targetAgentId: 'agent_id',
  id: 'agent_id',
  prompt: 'prompt',
  message: 'prompt',
  content: 'prompt',
  instruction: 'prompt',
  timeout_ms: 'timeout_ms',
  timeoutMs: 'timeout_ms',
  timeout: 'timeout_ms'
});

/**
 * `invoke_agent` descriptor — invoke an agent with a prompt and await the turn.
 *
 * Args: `agent_id`, `prompt` (both required), optional `timeout_ms`. Recursion
 * depth comes from the trusted `context.currentDepth`, never from params.
 * Delegates to `context.lifecyclePort.invokeAgent()` and throws when that
 * service is missing.
 *
 * Realm identity wiring (Wave I, ticket d57cbc1): the trusted caller resolution
 * ({@link resolveTrustedCaller}) forwards the dispatcher-pinned canonical
 * `callerKey` as the invoker reference, and a bare target that only the
 * caller's Realm can disambiguate resolves to its realm-exact canonical key
 * ({@link resolveTargetReference}) — so a same-literal-id caller invokes its own
 * Realm's same-literal-id target instead of failing closed. Per-call identity
 * and realm claims are stripped before dispatch and never reach this handler;
 * cross-Realm pairs, bypass ambiguity and unknown ids keep the engine's
 * fail-closed denial semantics.
 */
export const invokeAgentDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.INVOKE_AGENT,
  description: 'Directly invoke an agent to execute a turn with a prompt and await completion.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Target agent ID to invoke.'
      },
      prompt: {
        type: 'string',
        description: 'Instruction prompt or message payload to execute.'
      },
      timeout_ms: {
        type: 'integer',
        description: 'Maximum execution timeout in milliseconds.'
      }
    },
    required: ['agent_id', 'prompt'],
    additionalProperties: false
  }),
  paramAliasMap: invokeAgentParamAliasMap,
  sanitize: createParamSanitizer(invokeAgentParamAliasMap),
  handler: async (params: ToolParams | string, context: ExecutionContext) => {
    // Trusted caller resolution (Wave I, ticket d57cbc1): the pinned canonical
    // key disambiguates a same-literal-id invoker realm-exactly; the resolved
    // Realm context scopes a bare same-id target. Caller-asserted identity keys
    // were stripped before dispatch and are never consulted.
    const caller = resolveTrustedCaller(context);
    const scope = caller ? caller.scope : null;
    const invokerId = scope ? (scope.callerKey || scope.callerAgentId) : undefined;
    const rawTargetAgentId = typeof params === 'object' ? (params?.agent_id || params?.agentId || params?.target_agent_id) : params;
    const targetAgentId = caller
      ? resolveTargetReference(context?.identityPort, rawTargetAgentId, caller)
      : rawTargetAgentId;
    const prompt = typeof params === 'object' ? (params?.prompt || params?.instruction || params?.message) : '';
    // Identity-only invocation options: depth/timeout metadata plus the frozen
    // authority descriptor when the identity projection provides one. Privilege
    // flags and role aliases (`role`/`callerRole`) are never forwarded.
    //
    // Depth is the trusted bound turn capability (`currentDepth`), pinned by the
    // dispatcher from the executing turn (63026f5). A per-call `depth` key is
    // caller data and is never read: forwarding it let a nested invocation reset
    // (or inflate) the engine's recursion guard, so the guard never accumulated
    // across tool-initiated invocations.
    const invocationOptions: Record<string, unknown> = {};
    if (typeof context?.currentDepth === 'number') invocationOptions.depth = context.currentDepth;
    if (typeof params === 'object' && params?.timeout_ms !== undefined) invocationOptions.timeoutMs = params.timeout_ms;
    if (scope?.principal) invocationOptions.principal = scope.principal;

    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.invokeAgent !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    return await lifecyclePort.invokeAgent(invokerId, targetAgentId, prompt, invocationOptions);
  }
});
/** camelCase alias of `invokeAgentDescriptor`. */
export const invokeAgent = invokeAgentDescriptor;
/** snake_case alias of `invokeAgentDescriptor`. */
export const invoke_agent = invokeAgentDescriptor;

// --- 2. wait_for_invocation ---
const waitForInvocationParamAliasMap = Object.freeze({
  timeout_ms: 'timeout_ms',
  timeoutMs: 'timeout_ms',
  timeout: 'timeout_ms',
  invocation_ids: 'invocation_ids',
  invocationIds: 'invocation_ids',
  id: 'invocation_ids',
  ids: 'invocation_ids',
  require_all: 'require_all',
  requireAll: 'require_all'
});

/**
 * `wait_for_invocation` descriptor — wait for in-flight agent invocations to
 * complete.
 *
 * Args: optional `invocation_ids` (string or array), `timeout_ms`, `require_all`.
 * Delegates to `context.lifecyclePort.waitForInvocation()` and throws when that
 * service is missing.
 *
 * The handler forwards the identity-only bound caller scope
 * ({@link resolveTrustedCaller}) as the port's third argument, so the
 * invocation engine can authenticate the await (caller must be the invocation's
 * invoker, its target, or a Realm-bypass principal). The dispatcher-pinned
 * canonical `callerKey` (Wave I, ticket d57cbc1) rides along so a
 * same-literal-id caller authenticates realm-exactly. Caller-supplied params
 * are never an identity channel: the scope is pinned from the dispatcher's
 * bound execution context, and an unbound/anonymous caller forwards no scope,
 * which the agent-facing port treats as unauthenticated and fails closed
 * (Realm wave A, ticket 3487c56).
 */
export const waitForInvocationDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  description: 'Wait asynchronously for in-flight agent invocations to complete.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      timeout_ms: {
        type: 'integer',
        description: 'Maximum time to wait in milliseconds.'
      },
      invocation_ids: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description: 'Invocation ID or list of invocation IDs to await.'
      },
      require_all: {
        type: 'boolean',
        description: 'Whether all specified invocations must complete before resolving.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: waitForInvocationParamAliasMap,
  sanitize: createParamSanitizer(waitForInvocationParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.waitForInvocation !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Identity-only caller scope: the dispatcher pins `callerAgentId` and the
    // canonical `callerKey` from bound construction only; the frozen principal
    // rides along when the identity projection provides one. Caller-asserted
    // params are never read here.
    const scope = resolveTrustedCaller(context)?.scope ?? null;
    const ids = params?.invocation_ids;
    const waitOptions: Record<string, unknown> = {};
    if (typeof params?.timeout_ms === 'number') waitOptions.timeout_ms = params.timeout_ms;
    if (params?.require_all !== undefined) waitOptions.require_all = params.require_all;
    return await lifecyclePort.waitForInvocation(
      ids === undefined || ids === null ? [] : ids,
      waitOptions,
      // A bound caller forwards its identity-only scope; an unbound/anonymous
      // caller forwards `undefined`, which the agent-facing port treats as an
      // unauthenticated caller-scoped wait and fails closed (3487c56).
      scope ?? undefined
    );
  }
});
/** camelCase alias of `waitForInvocationDescriptor`. */
export const waitForInvocation = waitForInvocationDescriptor;
/** snake_case alias of `waitForInvocationDescriptor`. */
export const wait_for_invocation = waitForInvocationDescriptor;

/**
 * Array of all Invocation Tool Descriptors
 */
export const invocationToolDescriptors = Object.freeze([
  invokeAgentDescriptor,
  waitForInvocationDescriptor
]);
