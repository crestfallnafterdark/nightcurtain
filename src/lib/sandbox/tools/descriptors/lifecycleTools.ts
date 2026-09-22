/**
 * Tool descriptors for Agent Lifecycle operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated lifecycleToolDescriptors array.
 */

import { SANDBOX_TOOLS, TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a lifecycle descriptor handler. */
type ToolParams = Record<string, unknown>;

/** Identity-only caller scope forwarded to the lifecycle port. */
interface CallerScope {
  callerAgentId: string;
  /**
   * Trusted canonical identity key of the caller (Wave I, ticket d57cbc1;
   * I2-V F1). Forwarded only when the dispatcher pinned it from realm-exact
   * construction; per-call `callerKey`/`caller_key` claims are stripped before
   * dispatch and are never read here.
   */
  callerKey?: string;
  principal?: object;
}

/** Turn-undo port outcome fields read by the `undo_turn` descriptor. */
interface UndoTurnPortResult {
  success?: boolean;
  reason?: unknown;
  targetTurnId?: unknown;
  undoneUserContent?: string | null;
  undoneAssistantContent?: string | null;
  count?: number;
  restoredPrompt?: string;
}

/** Launch options forwarded to the lifecycle port. */
interface LaunchAgentOptionsView {
  config: Record<string, unknown>;
  callerContext?: CallerScope;
}

/** Call-site view of the lifecycle port members consumed by this descriptor. */
interface LifecyclePortView {
  launchAgent(options: LaunchAgentOptionsView): unknown;
  killAgent(agentId: unknown, reason: unknown, callerContext: CallerScope | null): unknown;
  listAgentDescriptors(options: { callerAgentId?: string; callerKey?: string }): unknown;
  whoami(agentId: string | null): unknown;
  undoAgentTurn(agentId: string | null, targetTurnId: unknown): UndoTurnPortResult | null | undefined;
}

/**
 * Resolves the registered caller subject from the trusted execution context.
 * The dispatcher pins `callerAgentId` from bound construction only; the nested
 * `callerContext` key is caller data and is never consulted (ticket a1ce597).
 * @param context - Optional trusted execution context
 * @returns The bound subject id, or `null` when no subject is bound
 */
function resolveCallerAgentId(context: ExecutionContext): string | null {
  const rawCallerAgentId = context?.callerAgentId || context?.agentId || null;
  return typeof rawCallerAgentId === 'string' && rawCallerAgentId ? rawCallerAgentId : null;
}

/**
 * Resolves the dispatcher-pinned canonical caller key from the trusted
 * execution context (Wave I, ticket d57cbc1; I2-V F1).
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
 * any (Wave I, ticket d57cbc1; I2-V F1). A construction-bound `realmId` is a
 * pinned scope key: a per-call claim is stripped before dispatch. `undefined`
 * means no scope was bound (legacy unique-match construction); an explicit
 * `null` is the system scope.
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
 * (Wave I, ticket d57cbc1; I2-V F1).
 *
 * The scope carries the registered subject id plus, when the injected identity
 * projection provides one, the frozen `AuthorityDescriptor` as the principal,
 * and the dispatcher-pinned canonical `callerKey` when the caller resolved
 * realm-exactly. Resolution mirrors the invocation path's trusted caller
 * resolution: a pinned canonical key resolves its exact registration on its
 * own; otherwise the bound realm scope disambiguates the same-literal-id pair;
 * otherwise the legacy unique-match rule applies. A caller whose bare subject
 * is ambiguous across Realms keeps the pinned canonical key as its only
 * identity channel — the frozen principal is withheld because the lifecycle
 * manager resolves a forwarded principal by its bare subject ahead of the
 * canonical key and would otherwise fail the caller closed.
 *
 * Caller-asserted privilege flags and authority-bearing role aliases are never
 * read here: authority is resolved server-side from the registry descriptor for
 * the supplied subject (MOD-21); per-call identity/realm claims are stripped
 * before dispatch and are never consulted.
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
      if (projection) {
        // A principal whose bare subject is ambiguous across Realms is
        // withheld: the lifecycle manager's caller-context resolution reads a
        // forwarded principal by its bare subject and would mask the canonical
        // key channel (see above). The key remains the identity channel.
        let principalUsable = true;
        if (pinnedCallerKey) {
          try {
            principalUsable = Boolean(identityPort.getAgentIdentity(callerAgentId));
          } catch {
            principalUsable = false;
          }
        }
        if (projection.authority && principalUsable) principal = projection.authority;
      }
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
 * Resolves the exact reference addressed by a self-scoped lifecycle tool
 * (`whoami`, `undo_turn`): the dispatcher-pinned canonical caller key when one
 * is bound (realm-exact even for a same-literal-id pair), else the registered
 * bare subject (legacy unique-match channel).
 *
 * @param context - Optional trusted execution context
 * @returns The exact caller reference, or `null` when no subject is bound
 */
function resolveCallerReference(context: ExecutionContext): string | null {
  return resolvePinnedCallerKey(context) || resolveCallerAgentId(context);
}

/** Structural view of the identity port's ambiguity-relevant enumeration member. */
interface AmbiguityAwareIdentityPort {
  listAgentIdentities?(scope?: { realmId?: string | null }): unknown;
}

/**
 * Reports whether a bound caller subject is a realm-ambiguous bare id with no
 * trusted identity channel (Wave I, ticket d57cbc1; I2-V F1).
 *
 * An ambiguous bare id cannot name exactly one registration: the trusted
 * canonical `callerKey` is absent and the bound realm scope (if any) resolved
 * no projection, while the identity port enumerates more than one live
 * registration for the subject. Such a caller must fail closed on the launch
 * path rather than degrade to an anonymous host launch. Dispatchers without an
 * enumerating identity port (host/test constructions) keep their legacy
 * behavior; the check is read-only and never widens authority.
 *
 * @param context - Optional trusted execution context
 * @returns True when the bound caller is a realm-ambiguous bare id
 */
function isBoundCallerAmbiguous(context: ExecutionContext): boolean {
  const callerAgentId = resolveCallerAgentId(context);
  if (!callerAgentId) return false;
  if (resolvePinnedCallerKey(context)) return false;
  const identityPort = context?.identityPort;
  if (!identityPort || typeof identityPort.getAgentIdentity !== 'function') return false;
  try {
    if (identityPort.getAgentIdentity(callerAgentId, resolveBoundRealmScope(context))) return false;
    const enumerator = identityPort as unknown as AmbiguityAwareIdentityPort;
    if (typeof enumerator.listAgentIdentities !== 'function') return false;
    const registrations = enumerator.listAgentIdentities();
    if (!Array.isArray(registrations)) return false;
    let matches = 0;
    for (const registration of registrations) {
      const source = registration && typeof registration === 'object' ? registration as { id?: unknown } : null;
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

/** Uniform refusal for a launch claimed by a realm-ambiguous, keyless caller. */
const AMBIGUOUS_CALLER_LAUNCH_REFUSED_MESSAGE =
  'The caller identity could not be resolved unambiguously; the operation is not permitted.';

// --- Public projection helpers ---

/**
 * Reads a non-empty string field from a descriptor or legacy agent record.
 *
 * @param source - Record to read from, or `null`.
 * @param key - Field name.
 * @returns The field value when it is a non-empty string, otherwise `null`.
 */
function readPublicString(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === 'string' && value ? value : null;
}

/** Exact shape of the internal realm-global partition key (`realm:<realmId>:global`). */
const REALM_GLOBAL_WORKSPACE_PATTERN = /^realm:.+:global$/;

/** Internal realm partition vocabulary that must never reach an agent-visible field. */
const REALM_WORKSPACE_VOCABULARY_PATTERN = /realm:/;

/**
 * Internal realm/identity vocabulary an agent-supplied identifier must never
 * carry (ticket eab4e51, folded into d57cbc1): `realm:` anywhere (canonical
 * identity keys `realm:<realmId>:<agentId>`, realm-global partitions
 * `realm:<realmId>:global`), a `system:` prefix (system-scope canonical keys
 * `system:<agentId>`), and the engine-known seeded Generic realm id. Mirrors
 * the runtime launch gate (`runtime/agentLifecycle`) so the tool boundary and
 * the launch boundary refuse exactly the same vocabulary. Lexical only: this
 * boundary never consults a registry, so a refusal can never become an
 * existence oracle for a realm id.
 */
const INTERNAL_ID_VOCABULARY_PATTERN = /realm:|^system:/;

/** Engine-known seeded Generic realm id (`realm_generic`), refused as an agent id. */
const SEEDED_GENERIC_REALM_ID = 'realm_generic';

/**
 * Unanchored internal realm vocabulary used to scan message/error text for a
 * caller-supplied claim echoed by a downstream gate.
 */
const REALM_TEXT_VOCABULARY_PATTERN = /realm:|realm_/;

/**
 * Uniform, realm-opaque refusal returned when a lifecycle claim cannot be
 * surfaced: every vocabulary-bearing id claim and every downstream denial that
 * would repeat a realm-vocabulary claim gets the identical shape, so the
 * caller learns nothing about realm existence or state (no oracle).
 */
const LIFECYCLE_CLAIM_REFUSED_MESSAGE = 'The requested agent operation is not permitted.';

/**
 * Reports whether an agent-supplied identifier carries internal realm
 * vocabulary.
 *
 * @param value - Candidate identifier.
 * @returns True when the value carries the internal vocabulary.
 */
function carriesInternalRealmVocabulary(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  return INTERNAL_ID_VOCABULARY_PATTERN.test(value) || value === SEEDED_GENERIC_REALM_ID;
}

/**
 * Maps an internal workspace key onto its realm-opaque agent-visible label:
 * every `realm:<realmId>:global` partition key is presented as `global`
 * (matching the VirtualFS public labeling); any other key carrying the
 * internal `realm:` vocabulary is withheld (`null`) so a bounded receipt field
 * can never disclose a realm identifier. Plain keys pass through unchanged.
 *
 * @param value - Raw workspace key, or `null`.
 * @returns The realm-opaque label, or `null` when the key is withheld.
 */
function toAgentVisibleWorkspaceKey(value: string | null): string | null {
  if (!value) return null;
  if (REALM_GLOBAL_WORKSPACE_PATTERN.test(value)) return 'global';
  if (REALM_WORKSPACE_VOCABULARY_PATTERN.test(value)) return null;
  return value;
}

/**
 * Projects a lifecycle-port failure onto a realm-opaque error: a message that
 * repeats a caller-supplied realm-vocabulary claim (for example a launch gate
 * echoing a reserved workspace key) is replaced by the uniform refusal, while
 * the failure code is preserved so denial semantics stay unchanged. A clean
 * failure passes through untouched.
 *
 * @param error - Thrown lifecycle-port failure.
 * @returns A realm-opaque error carrying the original failure code.
 */
function toRealmOpaqueLifecycleError(error: unknown): unknown {
  const source = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null;
  const message = source && typeof source.message === 'string' ? source.message : '';
  if (!REALM_TEXT_VOCABULARY_PATTERN.test(message)) return error;
  const sanitized = new Error(LIFECYCLE_CLAIM_REFUSED_MESSAGE) as Error & { code?: unknown };
  if (source && source.code !== undefined) sanitized.code = source.code;
  return sanitized;
}

/**
 * Projects a returned lifecycle-port failure receipt onto a realm-opaque copy:
 * when any serialized field repeats a caller-supplied realm-vocabulary claim,
 * the receipt is reduced to the uniform refusal with its original failure code;
 * a clean receipt passes through unchanged (denial semantics preserved).
 *
 * @param receipt - Returned failure receipt.
 * @returns The realm-opaque failure receipt.
 */
function toRealmOpaqueFailureReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(receipt) || '';
  } catch {
    return receipt;
  }
  if (!REALM_TEXT_VOCABULARY_PATTERN.test(serialized)) return receipt;
  return {
    success: false,
    error: LIFECYCLE_CLAIM_REFUSED_MESSAGE,
    code: receipt.code
  };
}

// --- 1. spawn_agent ---
const spawnAgentParamAliasMap = Object.freeze({
  id: 'id',
  agent_id: 'id',
  agentId: 'id',
  name: 'name',
  display_name: 'name',
  displayName: 'name',
  role: 'role',
  system_prompt: 'system_prompt',
  systemPrompt: 'system_prompt',
  prompt: 'initial_prompt',
  initial_prompt: 'initial_prompt',
  initialPrompt: 'initial_prompt'
});

/** Reduced public fields exposed by a successful `spawn_agent` receipt. */
interface PublicSpawnReceipt {
  /** Child identifier. */
  id: string;
  /** Child display name. */
  name: string;
  /** Child FSM lifecycle state. */
  state: string;
  /** Child role label. */
  role: string;
  /** Realm-opaque workspace label; absent when the raw key is withheld. */
  workspace?: string;
}

/**
 * Projects the lifecycle port's launched-agent record onto the bounded public
 * `spawn_agent` receipt shape (`id`, `name`, `state`, `role`, workspace label).
 *
 * The live `Agent` entity is never spread: entity internals (`config` and its
 * `realmId`/`allowedTools`, `history`, `modelConfig`, `provider`, `model`,
 * `authority`, telemetry, …) are dropped here, mirroring the ticket `9133495`
 * `list_agents` safe projection. The workspace label is realm-opaque: an
 * internal `realm:<realmId>:global` partition key is presented as `global`,
 * and any other key carrying the internal `realm:` vocabulary is omitted, so
 * no realm identifier or realm field reaches agent-visible tool history/UI
 * (ticket 550486c; WAVE_R §0.2). A record id carrying internal realm
 * vocabulary is withheld entirely (`null`): the receipt must never echo it
 * (ticket eab4e51, folded into d57cbc1).
 *
 * @param record - Launched record returned by the lifecycle port.
 * @returns The frozen, wire-safe public receipt (without the `success` flag),
 *   or `null` when the record id must be withheld.
 */
function toPublicSpawnReceipt(record: unknown): PublicSpawnReceipt | null {
  const source = record && typeof record === 'object' ? record as Record<string, unknown> : {};
  const config = source.config && typeof source.config === 'object'
    ? source.config as Record<string, unknown>
    : null;
  const id = readPublicString(source, 'id') || readPublicString(config, 'id') || 'unknown';
  if (carriesInternalRealmVocabulary(id)) return null;
  const workspace = toAgentVisibleWorkspaceKey(
    readPublicString(source, 'workspace')
      || readPublicString(config, 'workspaceId')
      || readPublicString(config, 'workspace')
      || id
  );
  return Object.freeze({
    id,
    name: readPublicString(source, 'name') || readPublicString(config, 'name') || id,
    state: readPublicString(source, 'state') || 'unknown',
    role: readPublicString(source, 'role') || readPublicString(config, 'role') || '',
    ...(workspace ? { workspace } : {})
  });
}

/**
 * `spawn_agent` descriptor — launch a new agent instance in the sandbox runtime.
 *
 * Args: `id` (required), optional `name`, `role`, `system_prompt`,
 * `initial_prompt`. Forwards the identity-only caller scope to
 * `context.lifecyclePort.launchAgent()` and throws when that service is missing.
 * The successful receipt is projected to the bounded public shape (`success`,
 * `id`, `name`, `state`, `role`, realm-opaque `workspace`); the live `Agent`
 * entity returned by the port is never spread, and explicit failure receipts
 * keep their shape so denial semantics are preserved (ticket 550486c).
 *
 * Realm-exact caller resolution (Wave I, ticket d57cbc1; I2-V F1): the scope is
 * resolved from the trusted bound execution context only — the
 * dispatcher-pinned canonical `callerKey`, else the bound realm scope, else the
 * legacy unique-match rule ({@link resolveCallerScope}). A realm-bound
 * same-id caller therefore spawns under its own realm's principal instead of
 * degrading to an anonymous host launch, so realm inheritance, the spawn
 * workspace-confinement gate, and the SEC-2 tool clamp all apply. A bound
 * caller that is a realm-ambiguous bare id with no trusted identity channel
 * fails closed with the uniform `PERMISSION_DENIED` shape rather than reaching
 * that host path. A per-call `callerKey`/`caller_key` argument is stripped from
 * the launch config — the trusted execution context is the only caller-key
 * channel.
 *
 * Realm opacity (ticket eab4e51, folded into d57cbc1): an `id` claim carrying
 * internal realm vocabulary (`realm:`/`system:` shapes, the seeded Generic
 * realm id) is refused before delegation with the uniform
 * `PERMISSION_DENIED` shape and is never echoed; a downstream failure message
 * that repeats a caller-supplied realm-vocabulary claim is sanitized to the
 * same uniform phrase with its failure code preserved; and a per-call
 * `callerKey`/`caller_key` argument is stripped from the launch config — the
 * trusted execution context is the only caller-key channel.
 */
export const spawnAgentDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.SPAWN_AGENT,
  description: 'Spawn a new agent instance in the sandbox runtime.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Unique identifier for the new agent.'
      },
      name: {
        type: 'string',
        description: 'Human-readable display name for the agent.'
      },
      role: {
        type: 'string',
        description: 'Domain role or purpose of the agent.'
      },
      system_prompt: {
        type: 'string',
        description: 'Custom system prompt instructions for the agent.'
      },
      initial_prompt: {
        type: 'string',
        description: 'Initial prompt or task to trigger the agent with upon launch.'
      }
    },
    required: ['id'],
    additionalProperties: false
  }),
  paramAliasMap: spawnAgentParamAliasMap,
  sanitize: createParamSanitizer(spawnAgentParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.launchAgent !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Identity travels through the explicit LaunchAgentOptions channel, never
    // through config: a per-call `callerContext` is caller data, and the
    // runtime derives spawn authority from the registry descriptor for the
    // supplied subject.
    const scope = resolveCallerScope(context);
    const config = params && typeof params === 'object' ? { ...params } : {};
    // Fail closed on a realm-ambiguous keyless bound caller (Wave I, ticket
    // d57cbc1; I2-V F1): without a trusted canonical key or a resolving realm
    // scope the caller cannot be attributed, and an unattributed launch would
    // fall through to the anonymous host path (wrong realm, no confinement, no
    // SEC-2 clamp). The refusal carries the uniform permission-denied shape.
    if (isBoundCallerAmbiguous(context)) {
      return {
        success: false,
        error: AMBIGUOUS_CALLER_LAUNCH_REFUSED_MESSAGE,
        code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
      };
    }
    // Realm opacity at the tool boundary (ticket eab4e51, folded into
    // d57cbc1): a claimed id carrying internal realm vocabulary is refused
    // uniformly before the launch port is reached, so it can never be minted,
    // echoed by a receipt, or exposed by a listing. The launch-side
    // registry-id check is the runtime lane's; this static-shape gate needs no
    // registry lookup and therefore creates no existence oracle.
    if (carriesInternalRealmVocabulary(config.id)) {
      return {
        success: false,
        error: LIFECYCLE_CLAIM_REFUSED_MESSAGE,
        code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
      };
    }
    // A per-call `callerKey` claim is never a launch input: the trusted
    // execution context is the only caller-key channel (Wave I, d57cbc1).
    delete config.callerKey;
    delete config.caller_key;
    let launched: unknown;
    try {
      launched = await lifecyclePort.launchAgent({
        config,
        ...(scope ? { callerContext: scope } : {})
      });
    } catch (err) {
      // A launch-gate denial must not echo a caller-supplied realm-vocabulary
      // claim (reserved workspace keys, vocabulary ids); the code is preserved.
      throw toRealmOpaqueLifecycleError(err);
    }
    // Explicit failure receipts keep their shape (denial semantics/failure
    // codes are normalized by the dispatcher); the raw launched entity is
    // never returned. A failure that repeats a realm-vocabulary claim is
    // reduced to the uniform refusal.
    if (launched && typeof launched === 'object' && (launched as { success?: unknown }).success === false) {
      return toRealmOpaqueFailureReceipt(launched as Record<string, unknown>);
    }
    const receipt = toPublicSpawnReceipt(launched);
    if (!receipt) {
      // Defense in depth: a port-returned record whose id carries internal
      // realm vocabulary is withheld rather than echoed.
      return {
        success: false,
        error: LIFECYCLE_CLAIM_REFUSED_MESSAGE,
        code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
      };
    }
    return { success: true, ...receipt };
  }
});
/** camelCase alias of `spawnAgentDescriptor`. */
export const spawnAgent = spawnAgentDescriptor;
/** snake_case alias of `spawnAgentDescriptor`. */
export const spawn_agent = spawnAgentDescriptor;

// --- 2. kill_agent ---
const killAgentParamAliasMap = Object.freeze({
  agent_id: 'agent_id',
  agentId: 'agent_id',
  id: 'agent_id',
  target_agent_id: 'agent_id',
  targetAgentId: 'agent_id',
  reason: 'reason'
});

/**
 * `kill_agent` descriptor — terminate an agent and transition it to a recycled
 * or terminated state.
 *
 * Args: `agent_id` (required), optional `reason`. Delegates to
 * `context.lifecyclePort.killAgent()`; returns `{success, id, agentId, killed}`
 * or a structured `{success:false, error, code:"EXECUTION_FAILED"}` receipt, and
 * throws when the port is missing.
 *
 * Realm-exact caller resolution (Wave I, ticket d57cbc1; I2-V F1): the
 * identity-only caller scope ({@link resolveCallerScope}) forwards the
 * dispatcher-pinned canonical `callerKey` when the caller resolved
 * realm-exactly, so same-id self/parent authority resolves its own realm's
 * registration; per-call identity/realm claims stay stripped and inert.
 *
 * Realm opacity (ticket eab4e51, folded into d57cbc1): a target id carrying
 * internal realm vocabulary is refused before delegation with the uniform
 * `PERMISSION_DENIED` shape and is never echoed, and a downstream denial that
 * would repeat a realm-vocabulary claim is sanitized to the same uniform
 * phrase with its failure code preserved.
 */
export const killAgentDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.KILL_AGENT,
  description: 'Terminate an active agent in the runtime and transition it to recycled/terminated state.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Unique identifier of the agent to terminate.'
      },
      reason: {
        type: 'string',
        description: 'Reason for terminating the agent.'
      }
    },
    required: ['agent_id'],
    additionalProperties: false
  }),
  paramAliasMap: killAgentParamAliasMap,
  sanitize: createParamSanitizer(killAgentParamAliasMap),
  handler: async (params: ToolParams | string, context: ExecutionContext) => {
    const agentId = typeof params === 'string' ? params : (params?.agent_id || params?.id || params?.target_agent_id);
    const reason = typeof params === 'object' ? params?.reason : undefined;
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.killAgent !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Realm opacity at the tool boundary (ticket eab4e51, folded into
    // d57cbc1): a target id carrying internal realm vocabulary is refused
    // uniformly before the lifecycle port is reached and never echoed back.
    if (carriesInternalRealmVocabulary(agentId)) {
      return {
        success: false,
        error: LIFECYCLE_CLAIM_REFUSED_MESSAGE,
        code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED
      };
    }
    // Anonymous callers pass `null`; sudoer/parent/self authority is resolved
    // by the runtime from the registry descriptor, never from flags.
    let killed: unknown;
    try {
      killed = await lifecyclePort.killAgent(agentId, reason, resolveCallerScope(context));
    } catch (err) {
      // A kill-gate denial must not echo a realm-vocabulary target claim; the
      // code is preserved.
      throw toRealmOpaqueLifecycleError(err);
    }
    if (killed === false) {
      return {
        success: false,
        error: `Agent '${agentId}' could not be terminated`,
        code: 'EXECUTION_FAILED'
      };
    }
    return { success: true, id: agentId, agentId, killed: true };
  }
});
/** camelCase alias of `killAgentDescriptor`. */
export const killAgent = killAgentDescriptor;
/** snake_case alias of `killAgentDescriptor`. */
export const kill_agent = killAgentDescriptor;

// --- 3. list_agents ---
const listAgentsParamAliasMap = Object.freeze({
  state: 'state',
  agent_state: 'state',
  agentState: 'state',
  status: 'state',
  role: 'role'
});

/** Reduced public fields allowed in the `list_agents` tool result. */
interface PublicAgentDescriptor {
  /** Agent identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Current FSM lifecycle state. */
  state: string;
  /** Role label. */
  role: string;
  /** Stored trigger-policy label. */
  triggerPolicy: string;
  /** Unread mailbox message count. */
  unreadCount: number;
  /** Realm-opaque workspace label; absent when the raw key is withheld. */
  workspace?: string;
}

/**
 * Projects a lifecycle `AgentDescriptor` (or a legacy live-agent record) onto
 * the exact reduced public shape exposed by the `list_agents` tool.
 *
 * Entity internals (`history`, `config`/`allowedTools`, `modelConfig`,
 * `provider`, `model`, telemetry, …) are dropped here, so the tool result
 * never carries a live `Agent` or its enumerable state (ticket 9133495). The
 * workspace label is realm-opaque (ticket 550486c): internal
 * `realm:<realmId>:global` partition keys are presented as `global`, and any
 * other internal `realm:` vocabulary is withheld — the `workspace` field is
 * omitted rather than falling back to the raw id (ticket eab4e51, folded into
 * d57cbc1). An entry whose id carries internal realm vocabulary is withheld
 * entirely (`null`): a listing must never echo it.
 *
 * @param record - Descriptor or legacy agent record returned by the port.
 * @returns The frozen, wire-safe public descriptor, or `null` when the entry
 *   must be withheld.
 */
function toPublicAgentDescriptor(record: unknown): PublicAgentDescriptor | null {
  const source = record && typeof record === 'object' ? record as Record<string, unknown> : {};
  const config = source.config && typeof source.config === 'object'
    ? source.config as Record<string, unknown>
    : null;
  const id = readPublicString(source, 'id') || 'unknown';
  if (carriesInternalRealmVocabulary(id)) return null;
  const rawUnread = source.unreadCount;
  const workspace = toAgentVisibleWorkspaceKey(
    readPublicString(source, 'workspace') || readPublicString(config, 'workspaceId')
  );
  return Object.freeze({
    id,
    name: readPublicString(source, 'name') || readPublicString(config, 'name') || id,
    state: readPublicString(source, 'state') || 'unknown',
    role: readPublicString(source, 'role') || readPublicString(config, 'role') || '',
    triggerPolicy: readPublicString(source, 'triggerPolicy') || readPublicString(config, 'triggerPolicy') || 'auto',
    unreadCount: typeof rawUnread === 'number' && Number.isFinite(rawUnread) ? rawUnread : 0,
    ...(workspace ? { workspace } : {})
  });
}

/**
 * `list_agents` descriptor — list the agents visible to the bound caller.
 *
 * Args: optional `state` and `role` filters applied as post-filters on the
 * projected descriptors. Visibility and identity are resolved server-side: the
 * handler calls `context.lifecyclePort.listAgentDescriptors()` with the bound
 * execution-context subject only (never caller-supplied claims), so anonymous
 * callers receive `[]`, registry sudoers receive every descriptor, and
 * ordinary callers receive same-scope self and registry children (the
 * director's reserved system scope stays outside every realm scope). Results
 * are reduced to the public descriptor shape (`id`, `name`, `state`, `role`,
 * `triggerPolicy`, `unreadCount`, realm-opaque `workspace`, which is omitted
 * when the raw key must be withheld); live `Agent` entities and their
 * internals are never returned, and an entry whose id carries internal realm
 * vocabulary is withheld from the listing (ticket eab4e51, folded into
 * d57cbc1).
 *
 * Fail closed: a host-supplied legacy port without the scoped
 * `listAgentDescriptors` projector raises a clear error instead of falling
 * back to the unscoped `listAgents` listing; the dispatcher's universal error
 * shield normalizes it to an `EXECUTION_FAILED` receipt (ticket 9133495).
 *
 * Realm-exact caller resolution (Wave I, ticket d57cbc1; I2-V F1): the projector
 * receives the dispatcher-pinned canonical `callerKey` when the caller resolved
 * realm-exactly, so a same-literal-id caller lists its own realm's set instead
 * of failing closed on the ambiguous bare subject. Per-call identity/realm
 * claims remain stripped and inert (a1ce597).
 */
export const listAgentsDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.LIST_AGENTS,
  description: 'List active agents in the sandbox runtime visible to the calling agent, with optional status and role filtering.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      state: {
        type: 'string',
        description: 'Filter agents by execution state (e.g. "idle", "running").'
      },
      role: {
        type: 'string',
        description: 'Filter agents by role.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: listAgentsParamAliasMap,
  sanitize: createParamSanitizer(listAgentsParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort) {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    // Identity is the bound execution-context subject only: the dispatcher
    // pins it from trusted construction, and nested per-call identity claims
    // are stripped before dispatch (a1ce597). Visibility resolves registry-side
    // from this subject's frozen authority descriptor. The dispatcher-pinned
    // canonical `callerKey` (Wave I, ticket d57cbc1; I2-V F1) rides along so a
    // same-literal-id caller resolves realm-exactly instead of failing closed
    // on the ambiguous bare subject.
    const callerAgentId = resolveCallerAgentId(context);
    const callerKey = resolvePinnedCallerKey(context);
    // Scoped callers only (ticket 9133495, verifier V5 F1): a port lacking the
    // scoped descriptor projector fails closed rather than falling back to the
    // unscoped `listAgents` listing. The dispatcher's universal error shield
    // normalizes this throw to an `EXECUTION_FAILED` receipt.
    if (typeof lifecyclePort.listAgentDescriptors !== 'function') {
      throw new Error('list_agents requires lifecyclePort.listAgentDescriptors (scoped callers only)');
    }
    const records: unknown = await lifecyclePort.listAgentDescriptors(
      callerAgentId
        ? { callerAgentId, ...(callerKey ? { callerKey } : {}) }
        : {}
    );

    const sanitizedParams: ToolParams = params && typeof params === 'object' ? params : {};
    const stateFilter = typeof sanitizedParams.state === 'string' && sanitizedParams.state ? sanitizedParams.state : null;
    const roleFilter = typeof sanitizedParams.role === 'string' && sanitizedParams.role ? sanitizedParams.role : null;

    const descriptors = (Array.isArray(records) ? records : [])
      .map(toPublicAgentDescriptor)
      .filter((descriptor): descriptor is PublicAgentDescriptor => descriptor !== null);
    return descriptors.filter(
      (descriptor) =>
        (!stateFilter || descriptor.state === stateFilter) &&
        (!roleFilter || descriptor.role === roleFilter)
    );
  }
});
/** camelCase alias of `listAgentsDescriptor`. */
export const listAgents = listAgentsDescriptor;
/** snake_case alias of `listAgentsDescriptor`. */
export const list_agents = listAgentsDescriptor;

// --- 4. whoami ---
/**
 * `whoami` descriptor — retrieve identity, permissions, role, and allowed tools
 * for the bound caller.
 *
 * Delegates to `context.lifecyclePort.whoami()` and throws when that service is
 * missing. The reference is the dispatcher-pinned canonical `callerKey` when
 * the caller resolved realm-exactly, else the bound bare subject (Wave I,
 * ticket d57cbc1; I2-V F1), so a same-literal-id caller resolves its own
 * registration instead of the ambiguous-bare-id not-found path.
 */
export const whoamiDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.WHOAMI,
  description: 'Retrieve runtime identity metadata, permissions, role, and allowed tools for the calling agent.',
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
    if (!lifecyclePort || typeof lifecyclePort.whoami !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    const agentId = resolveCallerReference(context);
    return await lifecyclePort.whoami(agentId);
  }
});
/** Alias of `whoamiDescriptor` (single-word canonical name). */
export const whoami = whoamiDescriptor;

// --- 5. undo_turn ---
const undoTurnParamAliasMap = Object.freeze({
  target_turn_id: 'target_turn_id',
  targetTurnId: 'target_turn_id',
  turn_id: 'target_turn_id',
  turnId: 'target_turn_id'
});

/**
 * `undo_turn` descriptor — undo a conversational turn, defaulting to the most
 * recent one.
 *
 * Args: optional `target_turn_id` selector. Delegates to
 * `context.lifecyclePort.undoAgentTurn()` and maps port failures to
 * `{success:false, error, code, reason, targetTurnId}`; throws when the port is
 * missing. The target reference is the dispatcher-pinned canonical `callerKey`
 * when the caller resolved realm-exactly, else the bound bare subject (Wave I,
 * ticket d57cbc1; I2-V F1), so a same-literal-id caller undoes its own turn
 * instead of failing not-found on the ambiguous bare id.
 */
export const undoTurnDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.UNDO_TURN,
  description: 'Undo a conversational turn for the calling agent, cancelling in-flight work and restoring history (the most recent turn unless target_turn_id selects an earlier one).',
  schema: Object.freeze({
    type: 'object',
    properties: {
      target_turn_id: {
        type: 'string',
        description: 'Optional turn selector matched against a message id or metadata.turnId inside the target turn. Unknown or already-undone targets return a structured failure instead of undoing a different turn.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: undoTurnParamAliasMap,
  sanitize: createParamSanitizer(undoTurnParamAliasMap),
  handler: async (params: ToolParams | string, context: ExecutionContext) => {
    const lifecyclePort: LifecyclePortView | undefined = context?.lifecyclePort;
    if (!lifecyclePort || typeof lifecyclePort.undoAgentTurn !== 'function') {
      throw new Error('lifecyclePort service is not available in execution context');
    }
    const agentId = resolveCallerReference(context);
    const targetTurnId = typeof params === 'object' ? params?.target_turn_id : params;
    const result = await lifecyclePort.undoAgentTurn(agentId, targetTurnId);
    if (result && result.success === false) {
      const label = result.targetTurnId ? `'${result.targetTurnId}'` : 'the requested target';
      return {
        success: false,
        error: result.reason === 'TURN_ALREADY_UNDONE'
          ? `Turn ${label} has already been undone.`
          : `No active turn matches ${label}.`,
        code: 'EXECUTION_FAILED',
        reason: result.reason,
        targetTurnId: result.targetTurnId
      };
    }
    return result;
  }
});
/** camelCase alias of `undoTurnDescriptor`. */
export const undoTurn = undoTurnDescriptor;
/** snake_case alias of `undoTurnDescriptor`. */
export const undo_turn = undoTurnDescriptor;

/**
 * Array of all 5 Lifecycle Tool Descriptors
 */
export const lifecycleToolDescriptors = Object.freeze([
  spawnAgentDescriptor,
  killAgentDescriptor,
  listAgentsDescriptor,
  whoamiDescriptor,
  undoTurnDescriptor
]);
