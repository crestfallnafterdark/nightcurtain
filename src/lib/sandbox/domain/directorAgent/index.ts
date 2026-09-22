/**
 * @packageDocumentation
 * Module `domain_director`.
 * Comprehensive TypeScript definitions for Module 7: Domain Director.
 *
 * In the multi-agent sandbox architecture, the Director is the root administrative
 * meta-agent with universal administrative governance over all agents, workspaces,
 * and runtime lifecycle events.
 *
 * @module domain/directorAgent
 * @mayImport type-only ../../runtime/agent/index.ts
 * @mayImport type-only ../../inference/ProviderInterface/index.ts
 * @invariant `DIRECTOR_SPEC` is deeply frozen (including nested `tools`/`allowedTools`): no runtime mutation or tamper path exists.
 * @invariant Permanent root privilege: `privileged` is `true`, `tools`/`allowedTools` are `['*']`, and composed configs re-pin `id`/`role`/`workspaceId` to `'director'`.
 * @invariant Concurrent `ensureDirectorAgent` calls on one runtime host share a single in-flight launch promise via a `WeakMap` lock and resolve to the same `Agent`.
 * @invariant Overrides are limited to `name`, `systemPrompt`, and `modelConfig` on a non-null, non-array object bag; non-object `overrides` (string/number/boolean/symbol/bigint/function/array) and any non-whitelisted own enumerable string key (including `id`, `role`, `privileged`, `workspaceId`, `tools`, or `allowedTools`, even with canonical values) throw `ERR_INVALID_SPEC_OVERRIDE`; the rejection scan is `Object.keys`-scoped, while composition is `hasOwnProperty`-scoped, so an own whitelisted key is composed regardless of enumerability and non-whitelisted non-enumerable keys evade rejection; inherited prototype values and symbol-keyed properties are never inspected or composed. Reading an override value (to compose it or to populate `details.value`) invokes its getter, so a throwing getter escapes as an untyped `Error` (the launch still aborts).
 * @invariant `isDirector` never throws and resists prototype pollution: own-property checks plus `try`/`catch` return `false` for hostile or malformed inputs.
 * @invariant Substrate decoupling: zero runtime imports; hosts are structurally typed via `DirectorRuntimeHost` (`getAgent`/`launchAgent`) and the runtime implementation is never imported.
 * @invariant `ensureDirectorAgent` re-provisions when the Director is absent, `terminated`, or `recycled`; any other live instance carrying the canonical id is returned unchanged — the id is ordinary and adoption never requires, grants, or upgrades authority.
 * @decision `AgentModelConfig` single home is the MOD-15 inference contract; this module consumes it type-only
 */

import type { Agent, AgentConfig } from '../../runtime/agent/index.ts';
import type { AgentModelConfig, ModelInterface, ProviderInterface } from '../../inference/ProviderInterface/index.ts';

// ============================================================================
// 1. Canonical Constants & Identifiers
// ============================================================================

/**
 * The immutable canonical agent identifier for the Director Meta-Agent.
 *
 * Canonical value seeded into `DIRECTOR_SPEC.id` and `DIRECTOR_SPEC.workspaceId`,
 * and the id passed to `runtime.getAgent` when locating the singleton.
 *
 * Type: `'director'`.
 *
 * @example
 * ```typescript
 * import { DIRECTOR_AGENT_ID, isDirector } from './domain/directorAgent/index.ts';
 *
 * if (callerAgentId === DIRECTOR_AGENT_ID) {
 *   console.log('Action initiated by root Director');
 * }
 * ```
 */
export const DIRECTOR_AGENT_ID = 'director';

/**
 * The immutable canonical role identifier for the Director Meta-Agent.
 *
 * Pinned into `DIRECTOR_SPEC.role` and re-pinned as the `role` of every composed
 * launch config. No sandbox runtime guard compares an agent's role against this
 * literal — the runtime invocation guard compares the agent id
 * (`DIRECTOR_AGENT_ID`) instead; matching `role === 'director'` literals appear
 * only in legacy transcript styling (`StoryLog.svelte`, `MessageCard.svelte`).
 *
 * Type: `'director'`.
 *
 * @example
 * ```typescript
 * import { DIRECTOR_ROLE } from './domain/directorAgent/index.ts';
 *
 * const isDirectorMessage = message.senderRole === DIRECTOR_ROLE;
 * ```
 */
export const DIRECTOR_ROLE = 'director';

/**
 * Default operational directive defining the Director Meta-Agent's administrative behavior.
 *
 * Summarizes the root operational guidelines shipped in the exported string:
 * - Administrative counterpart to the operator: provisions, configures, coordinates, and retires agents, and keeps workspaces, schedules, and message flow in order.
 * - Delegates by fit: routes work to the matching agent and handles administrative work directly.
 * - Reports plainly: state changes, running work, and items needing a decision.
 * - Keeps shared state honest: workspace contents, agent configurations, and scheduled work reflect reality.
 * - Executes the operator's direction faithfully through to a concrete result.
 *
 * The bullet summaries are paraphrases; the canonical wording lives in the string
 * itself. Seeded into `DIRECTOR_SPEC.systemPrompt` and shipped as the default
 * `systemPrompt` of launched Director agents. The text is behavior, not an
 * invariant: tests assert only that it is a non-empty string wired into the
 * spec, never its wording. No prompt-editor component consumes this constant.
 *
 * @example
 * ```typescript
 * import { DIRECTOR_DIRECTIVE } from './domain/directorAgent/index.ts';
 *
 * console.log('Active root directive:', DIRECTOR_DIRECTIVE);
 * ```
 */
export const DIRECTOR_DIRECTIVE: string = `You are the Director Meta-Agent, the root administrative orchestrator of the multi-agent sandbox.
You have universal administrative governance over all agents, workspaces, and runtime lifecycle events.

Operational Directive:
- You are the operator's administrative counterpart: you provision, configure, coordinate, and retire agents, and you keep workspaces, schedules, and message flow in order.
- Delegate by fit: route work to the agent whose role matches it, and handle directly what is administrative.
- Report plainly: state what changed, what is running, and what needs the operator's attention, without ceremony or process narration.
- Keep shared state honest: workspace contents, agent configurations, and scheduled work reflect what actually happened.
- Execute the operator's direction faithfully and carry it through to a concrete result.`;

/**
 * Standardized error codes emitted by the Director domain module.
 *
 * Enables programmatic exception handling without fragile string parsing.
 *
 * @readonly
 *
 * @example
 * ```typescript
 * import { DIRECTOR_ERROR_CODES, DirectorDomainError } from './domain/directorAgent/index.ts';
 *
 * try {
 *   await ensureDirectorAgent(runtime);
 * } catch (err) {
 *   if (err instanceof DirectorDomainError && err.code === DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME) {
 *     console.error('Runtime host was invalid or uninitialized');
 *   }
 * }
 * ```
 */
export const DIRECTOR_ERROR_CODES: Readonly<{
  /** The provided runtime host is invalid, null, or lacks required lifecycle methods. */
  ERR_INVALID_RUNTIME: 'ERR_INVALID_RUNTIME';
  /** An error occurred within the runtime host while launching the Director agent. */
  ERR_DIRECTOR_LAUNCH_FAILED: 'ERR_DIRECTOR_LAUNCH_FAILED';
  /** An illegal override was provided that violates Director immutability invariants (e.g. unprivileged). */
  ERR_INVALID_SPEC_OVERRIDE: 'ERR_INVALID_SPEC_OVERRIDE';
  /** The agent returned by `runtime.launchAgent` was falsy or failed Director identity verification. */
  ERR_DIRECTOR_CORRUPT: 'ERR_DIRECTOR_CORRUPT';
}> = Object.freeze({
  ERR_INVALID_RUNTIME: 'ERR_INVALID_RUNTIME',
  ERR_DIRECTOR_LAUNCH_FAILED: 'ERR_DIRECTOR_LAUNCH_FAILED',
  ERR_INVALID_SPEC_OVERRIDE: 'ERR_INVALID_SPEC_OVERRIDE',
  ERR_DIRECTOR_CORRUPT: 'ERR_DIRECTOR_CORRUPT'
});

/**
 * Union type representing all standardized error code string literals emitted by the Director domain module.
 *
 * @example
 * ```typescript
 * import type { DirectorErrorCode } from './domain/directorAgent/index.ts';
 *
 * function handleDirectorError(code: DirectorErrorCode) {
 *   switch (code) {
 *     case 'ERR_INVALID_RUNTIME':
 *       // handle invalid runtime
 *       break;
 *     case 'ERR_DIRECTOR_LAUNCH_FAILED':
 *       // handle launch failure
 *       break;
 *   }
 * }
 * ```
 */
export type DirectorErrorCode = typeof DIRECTOR_ERROR_CODES[keyof typeof DIRECTOR_ERROR_CODES];

// ============================================================================
// 2. Domain Specification Shapes
// ============================================================================

/**
 * Complete immutable configuration specification for the Director Meta-Agent.
 *
 * Encapsulates the permanent root privilege, universal tool whitelist, dedicated
 * workspace, and system prompt directives required for Director operation.
 *
 * @example
 * ```typescript
 * import type { DirectorAgentSpec } from './domain/directorAgent/index.ts';
 *
 * const customSpec: Partial<DirectorAgentSpec> = {
 *   name: 'Director'
 * };
 * ```
 */
export interface DirectorAgentSpec {
  /** Canonical unique identifier: strictly 'director'. */
  readonly id: typeof DIRECTOR_AGENT_ID;
  /** Human-readable display name: strictly 'Director'. */
  readonly name: 'Director';
  /** Administrative role: strictly 'director'. */
  readonly role: typeof DIRECTOR_ROLE;
  /** Complete operational directive string. */
  readonly systemPrompt: string;
  /** Root administrative privilege flag: strictly true. */
  readonly privileged: true;
  /** Universal tool access permissions: strictly ['*']. */
  readonly allowedTools: readonly ['*'];
  /** Universal tool access list: strictly ['*']. */
  readonly tools: readonly ['*'];
  /** Dedicated root administrative workspace: strictly 'director'. */
  readonly workspaceId: typeof DIRECTOR_AGENT_ID;
  /** Optional model configuration; inherits from global settings if omitted. */
  readonly modelConfig?: AgentModelConfig;
}

/**
 * Deep-frozen, immutable specification constant for the Director Meta-Agent.
 *
 * Deeply frozen with `Object.freeze` (including nested `tools` and `allowedTools` arrays)
 * to prevent tampering, prototype pollution, or runtime permission demotion.
 *
 * @example
 * ```typescript
 * import { DIRECTOR_SPEC } from './domain/directorAgent/index.ts';
 *
 * console.log(DIRECTOR_SPEC.privileged); // true
 * console.log(DIRECTOR_SPEC.tools); // ['*']
 * console.log(Object.isFrozen(DIRECTOR_SPEC)); // true
 * ```
 */
export const DIRECTOR_SPEC: Readonly<DirectorAgentSpec> = Object.freeze({
  id: DIRECTOR_AGENT_ID,
  name: 'Director',
  role: DIRECTOR_ROLE,
  systemPrompt: DIRECTOR_DIRECTIVE,
  privileged: true,
  allowedTools: Object.freeze(['*'] as const),
  tools: Object.freeze(['*'] as const),
  workspaceId: DIRECTOR_AGENT_ID
} as const);

// ============================================================================
// 3. Runtime Host Contract & Options
// ============================================================================

/**
 * Launch configuration accepted by `DirectorRuntimeHost.launchAgent`.
 *
 * Extends `AgentConfig` with the legacy embedded `provider` member that the
 * lifecycle launch path reads from a config object. The composed tool fields
 * are mutable clones of the frozen `DIRECTOR_SPEC` arrays, so this shape
 * satisfies `AgentConfig` while `DIRECTOR_SPEC` itself stays deeply frozen.
 */
export interface DirectorLaunchConfig extends AgentConfig {
  /** Optional concrete provider instance embedded into the composed launch config. */
  provider?: ProviderInterface | null;
}

/**
 * Minimal structural contract required of any runtime host capable of hosting the Director.
 * Fully satisfied by `AgentRuntime` and test harnesses.
 *
 * Substrate classes decouple domain specifics by providing standard lifecycle methods
 * `getAgent` and `launchAgent`.
 *
 * @example
 * ```typescript
 * import type { Agent } from '../../runtime/agent/index.ts';
 * import type { DirectorLaunchConfig, DirectorRuntimeHost } from './domain/directorAgent/index.ts';
 * import { ensureDirectorAgent } from './domain/directorAgent/index.ts';
 *
 * class MockRuntime implements DirectorRuntimeHost {
 *   private agents = new Map<string, Agent>();
 *   getAgent(id: string): Agent | null {
 *     return this.agents.get(id) ?? null;
 *   }
 *   async launchAgent(config: DirectorLaunchConfig): Promise<Agent> {
 *     const agent = { id: config.id, config } as unknown as Agent;
 *     this.agents.set(config.id, agent);
 *     return agent;
 *   }
 * }
 * ```
 */
export interface DirectorRuntimeHost {
  /**
   * Retrieves an active or registered agent by ID.
   *
   * @param agentId - The unique agent identifier to look up (e.g. 'director').
   * @returns The Agent instance if found and active, or null/undefined if absent.
   *
   * @example
   * ```typescript
   * const director = runtime.getAgent('director');
   * if (director) {
   *   console.log('Director is active');
   * }
   * ```
   */
  getAgent(agentId: string): Agent | null | undefined;

  /**
   * Provisions and launches an agent instance into the runtime.
   *
   * @param config - Composed Director launch configuration (`DirectorLaunchConfig`).
   * @param model - Optional concrete ModelInterface instance.
   * @param provider - Optional concrete ProviderInterface instance.
   * @param initialPrompt - Optional initial prompt string to execute upon launch.
   * @returns Promise resolving to the launched Agent instance.
   *
   * @example
   * ```typescript
   * const agent = await runtime.launchAgent({
   *   ...DIRECTOR_SPEC,
   *   allowedTools: [...DIRECTOR_SPEC.allowedTools],
   *   tools: [...DIRECTOR_SPEC.tools]
   * });
   * ```
   */
  launchAgent(
    config: DirectorLaunchConfig,
    model?: ModelInterface | null,
    provider?: ProviderInterface | null,
    initialPrompt?: string | null
  ): Promise<Agent>;
}

/**
 * Safe, non-security override bag accepted as `EnsureDirectorOptions.overrides`.
 *
 * Deliberately independent of `DirectorAgentSpec`: at runtime `name` is a
 * free-form display string composed as `overrides.name || DIRECTOR_SPEC.name`,
 * so deriving the bag from `Partial<Pick<DirectorAgentSpec, …>>` would wrongly
 * collapse `name` to the canonical `'Director'` literal.
 *
 * The rejection scan covers own enumerable string keys: keys outside
 * `name`/`systemPrompt`/`modelConfig` throw `ERR_INVALID_SPEC_OVERRIDE`.
 * Composition is own-key-scoped (`hasOwnProperty`), so an own whitelisted key is
 * composed regardless of enumerability (non-whitelisted non-enumerable keys
 * evade the scan entirely). Inherited prototype values and symbol-keyed
 * properties are ignored and never composed.
 *
 * @example
 * ```typescript
 * import type { DirectorSpecOverrides } from './domain/directorAgent/index.ts';
 *
 * const overrides: DirectorSpecOverrides = { name: 'Custom Director Display' };
 * ```
 */
export interface DirectorSpecOverrides {
  /**
   * Optional custom human-readable display name for the launched Director.
   *
   * Falsy values (e.g. `''`) fall back to the canonical `'Director'` instead of
   * being composed (mirrors the `overrides.name || DIRECTOR_SPEC.name` merge).
   */
  readonly name?: string;

  /**
   * Optional replacement operational directive for the launched Director.
   *
   * Falsy values (e.g. `''`) fall back to `DIRECTOR_DIRECTIVE` instead of being
   * composed (mirrors the `overrides.systemPrompt || DIRECTOR_SPEC.systemPrompt`
   * merge).
   */
  readonly systemPrompt?: string;

  /**
   * Optional model configuration for the launched Director, composed as
   * `config.modelConfig`.
   */
  readonly modelConfig?: AgentModelConfig;
}

/**
 * Execution options for `ensureDirectorAgent`.
 *
 * Allows injecting custom inference models, providers, initial prompts,
 * and safe non-security configuration overrides during Director bootstrap.
 *
 * @example
 * ```typescript
 * import type { EnsureDirectorOptions } from './domain/directorAgent/index.ts';
 * import { ensureDirectorAgent } from './domain/directorAgent/index.ts';
 *
 * const options: EnsureDirectorOptions = {
 *   initialPrompt: 'SYSTEM_BOOTSTRAP',
 *   overrides: {
 *     name: 'Custom Director Display'
 *   }
 * };
 * const director = await ensureDirectorAgent(runtime, options);
 * ```
 */
export interface EnsureDirectorOptions {
  /**
   * Optional concrete Model instance override (e.g. for testing with mock models).
   */
  readonly model?: ModelInterface | null;

  /**
   * Optional concrete Provider instance override. Forwarded to `launchAgent`
   * and embedded into the composed launch config as `provider`.
   */
  readonly provider?: ProviderInterface | null;

  /**
   * Optional initial prompt to execute immediately following initial launch.
   * Ignored if the Director agent is already active.
   */
  readonly initialPrompt?: string | null;

  /**
   * Optional safe configuration overrides for newly launched Director instances.
   *
   * Accepted shape: `undefined`/`null`, or a non-null, non-array object whose own
   * enumerable string keys are limited to `name`, `systemPrompt`, and `modelConfig`
   * (see `DirectorSpecOverrides`). The prototype chain is irrelevant. The rejection
   * scan is `Object.keys`-scoped, but composition is `hasOwnProperty`-scoped: an
   * own whitelisted key is composed regardless of enumerability (non-whitelisted
   * non-enumerable keys evade the scan), while inherited values and symbol-keyed
   * properties are never composed.
   *
   * Anything else — primitives (`string`, `number`, `boolean`, `symbol`, `bigint`),
   * functions, and arrays — is rejected with a `DirectorDomainError` carrying code
   * `ERR_INVALID_SPEC_OVERRIDE` and `details.field === 'overrides'` before any
   * launch. Additional own enumerable string keys outside the whitelist (including
   * canonical security fields such as `id`, `role`, `privileged`, `workspaceId`,
   * `tools`, and `allowedTools`) are rejected with the same code and
   * `details.field` set to the offending key; reading override values (to compose
   * a whitelisted key or to build that error) invokes their getters, so a throwing
   * getter escapes as an untyped `Error` rather than a `DirectorDomainError` (the
   * launch still aborts). Falsy `name` and `systemPrompt` values fall back to the
   * canonical `DIRECTOR_SPEC` values.
   * Canonical security fields are re-pinned by composition regardless. Not applied
   * when an existing active Director is returned.
   */
  readonly overrides?: DirectorSpecOverrides;
}

// ============================================================================
// 4. Exceptions & Error Model
// ============================================================================

/**
 * Structured domain exception thrown by the `domain_director` module during validation,
 * provisioning, or integrity verification.
 *
 * Carries a typed `code` property (`DirectorErrorCode`) and optional frozen `details` metadata.
 *
 * @example
 * ```typescript
 * import { DirectorDomainError, DIRECTOR_ERROR_CODES } from './domain/directorAgent/index.ts';
 *
 * try {
 *   throw new DirectorDomainError('Invalid host', DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME, { received: null });
 * } catch (err) {
 *   if (err instanceof DirectorDomainError) {
 *     console.error(err.code, err.details);
 *   }
 * }
 * ```
 */
export class DirectorDomainError extends Error {
  /**
   * Standardized error code from DIRECTOR_ERROR_CODES.
   */
  declare readonly code: DirectorErrorCode;

  /**
   * Readonly structured diagnostic metadata providing context about the failure.
   */
  declare readonly details?: Record<string, unknown>;

  /**
   * Creates a new DirectorDomainError instance.
   *
   * @param message - Human-readable error description message.
   * @param code - Standardized error code from DIRECTOR_ERROR_CODES.
   * @param details - Optional diagnostic context metadata dictionary; defaults to `{}`
   * and is stored as a shallow-frozen copy.
   */
  constructor(message: string, code: DirectorErrorCode, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DirectorDomainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    const ErrorWithStackCapture = Error as ErrorConstructor & {
      captureStackTrace?: (target: object, constructorOpt?: object) => void;
    };
    if (ErrorWithStackCapture.captureStackTrace) {
      ErrorWithStackCapture.captureStackTrace(this, DirectorDomainError);
    }
  }
}

// ============================================================================
// 5. Module-Private Internals
// ============================================================================

/**
 * Runtime-enforced whitelist of override keys accepted by `ensureDirectorAgent`.
 * Mirrors the declared `EnsureDirectorOptions.overrides` surface: any own
 * enumerable string key outside this set (including canonical security fields
 * such as `id` or `tools`) is rejected with `ERR_INVALID_SPEC_OVERRIDE`.
 * The rejection scan is driven by `Object.keys`, so own non-enumerable string
 * keys and symbol-keyed properties are never inspected for rejection. The
 * composition gates for the whitelisted keys use `hasOwnProperty`, so an own
 * whitelisted key is composed regardless of enumerability — a non-enumerable
 * own `name`/`systemPrompt`/`modelConfig` does reach the launched config.
 * Inherited (prototype-chain) and symbol-keyed values are never composed.
 */
const ALLOWED_OVERRIDE_KEYS: readonly string[] = Object.freeze(['name', 'systemPrompt', 'modelConfig']);

/**
 * Type guard for the shape accepted as `EnsureDirectorOptions.overrides`.
 * An override bag is any non-null, non-array object (its prototype chain is
 * irrelevant). The rejection scan inspects only own enumerable string keys;
 * composition of the whitelisted keys is gated by own-property
 * (`hasOwnProperty`) checks, so own whitelisted keys are composed regardless
 * of enumerability, while inherited and symbol-keyed properties are never
 * inspected or composed.
 * Primitives (`string`, `number`, `boolean`, `symbol`, `bigint`), functions, arrays, and
 * `null`/`undefined` are not override bags. Non-bag values are
 * rejected with `ERR_INVALID_SPEC_OVERRIDE` before any key filtering, so they can
 * never reach the composed agent configuration.
 *
 * @param value - Candidate overrides value.
 * @returns True when `value` is an object that can carry own override keys.
 */
function isOverrideBag(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * In-flight launch lock cache mapping runtime host instances to active launch promises.
 * Prevents concurrent duplicate launches on the same runtime host.
 */
const inFlightLaunchLocks = new WeakMap<object, Promise<Agent>>();

// ============================================================================
// 6. Public Function Contracts
// ============================================================================

/**
 * Safe domain predicate and TypeScript type guard verifying whether a target represents the Director.
 *
 * Evaluation Rules:
 * 1. String input: checks if `target.trim() === DIRECTOR_AGENT_ID` ('director').
 * 2. Object input: checks if a trimmed `target.id` or a trimmed `target.config?.id`
 *    equals `DIRECTOR_AGENT_ID`, guarding against `Object.prototype` properties.
 * 3. All other values (null, undefined, numbers, non-matching objects): returns `false`.
 *
 * Invariants:
 * - Guaranteed NEVER to throw under any input.
 * - Resistant to prototype pollution (`Object.prototype` properties).
 * - Eliminates repetitive ad-hoc string comparisons across the codebase.
 *
 * @param target - An agent instance, configuration object, agent ID string, or unknown value.
 * @returns True if the target represents the Director; false otherwise.
 *
 * @example
 * ```typescript
 * import { isDirector } from './domain/directorAgent/index.ts';
 *
 * // Checking string identifier
 * if (isDirector('director')) {
 *   console.log('Target is director ID');
 * }
 *
 * // Checking agent instance
 * if (isDirector(callerAgent)) {
 *   console.log('Caller has root administrative privileges');
 * }
 * ```
 */
export function isDirector(target: unknown): boolean {
  if (typeof target === 'string') {
    return target.trim() === DIRECTOR_AGENT_ID;
  }

  if (target && typeof target === 'object') {
    const candidate = target as Record<string, unknown>;
    try {
      if (Object.prototype.hasOwnProperty.call(candidate, 'id')) {
        if (typeof candidate.id === 'string' && candidate.id.trim() === DIRECTOR_AGENT_ID) {
          return true;
        }
      } else if (typeof candidate.id === 'string' && candidate.id.trim() === DIRECTOR_AGENT_ID) {
        if (!Object.prototype.hasOwnProperty.call(Object.prototype, 'id')) {
          return true;
        }
      }

      if (Object.prototype.hasOwnProperty.call(candidate, 'config')) {
        const config = candidate.config;
        if (config && typeof config === 'object') {
          const configRecord = config as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(configRecord, 'id')) {
            if (typeof configRecord.id === 'string' && configRecord.id.trim() === DIRECTOR_AGENT_ID) {
              return true;
            }
          } else if (typeof configRecord.id === 'string' && configRecord.id.trim() === DIRECTOR_AGENT_ID) {
            if (!Object.prototype.hasOwnProperty.call(Object.prototype, 'id')) {
              return true;
            }
          }
        }
      } else if (candidate.config && typeof candidate.config === 'object') {
        if (!Object.prototype.hasOwnProperty.call(Object.prototype, 'config')) {
          const configRecord = candidate.config as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(configRecord, 'id')) {
            if (typeof configRecord.id === 'string' && configRecord.id.trim() === DIRECTOR_AGENT_ID) {
              return true;
            }
          } else if (typeof configRecord.id === 'string' && configRecord.id.trim() === DIRECTOR_AGENT_ID) {
            if (!Object.prototype.hasOwnProperty.call(Object.prototype, 'id')) {
              return true;
            }
          }
        }
      }
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Idempotently ensures that the root Director Meta-Agent exists and is active within the target runtime.
 *
 * Detailed Execution Pipeline & Guarantees:
 * 1. **Runtime Validation:** Validates that `runtime` is a non-null object implementing `launchAgent`
 *    and `getAgent`. Throws `ERR_INVALID_RUNTIME` if invalid.
 * 2. **Active Instance Discovery:** Queries `runtime.getAgent('director')`. If the returned
 *    instance passes `isDirector` and its `state` is neither 'terminated' nor 'recycled',
 *    it is immediately returned, whatever authority it carries. Otherwise (absent,
 *    non-Director, terminated, or recycled) provisioning continues — the id is ordinary
 *    and adoption never grants or upgrades authority (Wave I, ticket c02d0b9).
 * 3. **Concurrency Synchronization:** If a launch operation is already in flight for this runtime
 *    instance in the internal WeakMap lock cache, reuses and returns the identical `Promise<Agent>`.
 * 4. **Spec Override Protection:** Validates the `options.overrides` shape first: a
 *    non-null, non-array object is required, and primitives, functions, and arrays
 *    throw `ERR_INVALID_SPEC_OVERRIDE` with `details.field === 'overrides'`. Object
 *    bags are then filtered against the override whitelist (`name`, `systemPrompt`,
 *    `modelConfig`). Every own enumerable string key outside the whitelist
 *    (including `id`, `role`, `privileged`, `workspaceId`, `tools`, `allowedTools`)
 *    throws `ERR_INVALID_SPEC_OVERRIDE` with `details.field` set to the offending
 *    key. The rejection scan is enumerability-scoped, while composition is
 *    own-key-scoped: own whitelisted keys are composed even when non-enumerable
 *    (non-whitelisted non-enumerable keys evade rejection), and inherited or
 *    symbol-keyed properties are never composed. Reading override values invokes
 *    their getters (to compose whitelisted keys or to populate `details.value`),
 *    so a throwing getter escapes as an untyped `Error`. Falsy
 *    `name`/`systemPrompt` values fall back to the canonical `DIRECTOR_SPEC`
 *    values.
 * 5. **Launch Delegation:** Launches the Director via `runtime.launchAgent(...)` with deep-frozen
 *    `DIRECTOR_SPEC` defaults and safe overrides. In-flight lock cache entry is cleaned up in `.finally()`.
 * 6. **Integrity Validation:** Verifies that the returned agent passes `isDirector(agent)`.
 *    Throws `ERR_DIRECTOR_CORRUPT` if invalid.
 *
 * @param runtime - Target AgentRuntime or DirectorRuntimeHost instance.
 * @param options - Optional execution options (model, provider, initialPrompt, safe overrides).
 * - `options.model` - Optional concrete ModelInterface instance override.
 * - `options.provider` - Optional concrete ProviderInterface instance override, forwarded to `launchAgent` and embedded as `config.provider`.
 * - `options.initialPrompt` - Optional initial prompt string to execute immediately following initial launch.
 * - `options.overrides` - Optional safe configuration overrides (name, systemPrompt, modelConfig) merged over `DIRECTOR_SPEC`; must be `undefined`/`null` or a non-array object with non-whitelisted own enumerable string keys absent; composition honors own whitelisted keys regardless of enumerability; checked only when a launch proceeds.
 * @returns Promise resolving to the Director singleton for that runtime host; concurrent calls on the same host resolve to the same instance.
 * @throws `DirectorDomainError` - With code `ERR_INVALID_RUNTIME` if the runtime host is null, undefined, or missing required methods.
 * @throws `DirectorDomainError` - With code `ERR_INVALID_SPEC_OVERRIDE` if `options.overrides` is a non-object/array value (`details.field === 'overrides'`) or contains a non-whitelisted own enumerable string key (`details.field` set to the offending key). The rejection scan inspects only own enumerable string keys, so non-whitelisted non-enumerable and symbol-keyed properties never throw (a whitelisted own key is still composed even when non-enumerable); inherited properties are ignored; a throwing getter on an inspected override value escapes as an untyped `Error`.
 * @throws `DirectorDomainError` - With code `ERR_DIRECTOR_LAUNCH_FAILED` if the substrate runtime fails during agent launch.
 * @throws `DirectorDomainError` - With code `ERR_DIRECTOR_CORRUPT` if the launched entity fails `isDirector` integrity verification.
 * @throws Any error thrown by the host's `getAgent` is not wrapped and propagates unchanged.
 *
 * @example
 * ```typescript
 * import { ensureDirectorAgent } from './domain/directorAgent/index.ts';
 *
 * // Basic usage - Idempotent singleton acquisition
 * const director = await ensureDirectorAgent(runtime);
 *
 * // Custom bootstrap with model injection
 * const directorWithModel = await ensureDirectorAgent(runtime, {
 *   model: customModelInstance,
 *   initialPrompt: 'SYSTEM_BOOTSTRAP'
 * });
 *
 * // Concurrent calls safely deduplicate to a single launch
 * const [d1, d2] = await Promise.all([
 *   ensureDirectorAgent(runtime),
 *   ensureDirectorAgent(runtime)
 * ]);
 * console.log(d1 === d2); // true
 * ```
 */
export async function ensureDirectorAgent(
  runtime: DirectorRuntimeHost,
  options: EnsureDirectorOptions = {}
): Promise<Agent> {
  // 1. Runtime Host Validation
  if (!runtime || typeof runtime !== 'object' || typeof runtime.launchAgent !== 'function') {
    throw new DirectorDomainError(
      'Invalid runtime host: must be an object with launchAgent and getAgent methods',
      DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME,
      { runtime }
    );
  }

  if (typeof runtime.getAgent !== 'function') {
    throw new DirectorDomainError(
      'Invalid runtime host: missing getAgent method',
      DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME,
      { runtime }
    );
  }

  // 2. Active Instance Discovery (Wave I, ticket c02d0b9): the canonical id is
  // an ordinary identifier, so any live instance carrying it is adopted
  // unchanged. Adoption never inspects or upgrades authority — a snapshot-
  // restored (default-deny) director is adopted too, and the composition root
  // restores its persisted grant explicitly.
  const existingAgent = runtime.getAgent(DIRECTOR_AGENT_ID);

  if (existingAgent && isDirector(existingAgent)) {
    const state = existingAgent.state;
    if (state !== 'terminated' && state !== 'recycled') {
      return existingAgent;
    }
  }

  // 3. Concurrency Synchronization
  if (inFlightLaunchLocks.has(runtime)) {
    return inFlightLaunchLocks.get(runtime)!;
  }

  // 4. Spec Override Type & Whitelist Validation
  const overrides = options?.overrides;
  const hasOverrides = overrides !== undefined && overrides !== null;

  if (hasOverrides && !isOverrideBag(overrides)) {
    throw new DirectorDomainError(
      `Invalid overrides: expected an object whose own keys are limited to ${ALLOWED_OVERRIDE_KEYS.join(', ')}`,
      DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE,
      { field: 'overrides', value: overrides, expected: 'object' }
    );
  }

  const overrideBag: Record<string, unknown> = hasOverrides && isOverrideBag(overrides)
    ? (overrides as Record<string, unknown>)
    : {};

  for (const key of Object.keys(overrideBag)) {
    if (!ALLOWED_OVERRIDE_KEYS.includes(key)) {
      throw new DirectorDomainError(
        `Cannot override Director field '${key}': overrides are limited to name, systemPrompt, and modelConfig`,
        DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE,
        { field: key, value: overrideBag[key] }
      );
    }
  }

  // 5. Composed Configuration (whitelisted own keys only; canonical security fields re-pinned)
  const overrideName = Object.prototype.hasOwnProperty.call(overrideBag, 'name') ? overrides?.name : undefined;
  const overrideSystemPrompt = Object.prototype.hasOwnProperty.call(overrideBag, 'systemPrompt')
    ? overrides?.systemPrompt
    : undefined;

  const composedConfig: DirectorLaunchConfig = {
    ...DIRECTOR_SPEC,
    id: DIRECTOR_AGENT_ID,
    name: overrideName || DIRECTOR_SPEC.name,
    role: DIRECTOR_ROLE,
    systemPrompt: overrideSystemPrompt || DIRECTOR_SPEC.systemPrompt,
    privileged: true,
    allowedTools: [...DIRECTOR_SPEC.allowedTools],
    tools: [...DIRECTOR_SPEC.tools],
    workspaceId: DIRECTOR_AGENT_ID
  };

  if (Object.prototype.hasOwnProperty.call(overrideBag, 'modelConfig')) {
    composedConfig.modelConfig = overrides?.modelConfig;
  }

  if (options?.provider) {
    composedConfig.provider = options.provider;
  }

  // 6. Launch Execution under Concurrency Lock
  const launchPromise = (async () => {
    try {
      const agent = await runtime.launchAgent(
        composedConfig,
        options?.model ?? null,
        options?.provider ?? null,
        options?.initialPrompt ?? null
      );

      if (!agent || !isDirector(agent)) {
        throw new DirectorDomainError(
          'Runtime returned an invalid or corrupt Director agent instance',
          DIRECTOR_ERROR_CODES.ERR_DIRECTOR_CORRUPT,
          { agent }
        );
      }

      return agent;
    } catch (error) {
      if (error instanceof DirectorDomainError) {
        throw error;
      }
      const message =
        (error instanceof Error ? error.message : '') || 'Failed to launch Director agent in runtime host';
      throw new DirectorDomainError(
        message,
        DIRECTOR_ERROR_CODES.ERR_DIRECTOR_LAUNCH_FAILED,
        { originalError: error }
      );
    }
  })();

  inFlightLaunchLocks.set(runtime, launchPromise);

  try {
    return await launchPromise;
  } finally {
    inFlightLaunchLocks.delete(runtime);
  }
}
