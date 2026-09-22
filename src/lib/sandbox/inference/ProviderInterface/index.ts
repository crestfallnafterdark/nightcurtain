/**
 * @packageDocumentation
 * MOD-15 inference transport contract: request/stream shapes,
 * model & provider configuration, discovery/routing results, injected ports,
 * and the `InferenceError` taxonomy.
 *
 * @module inference/ProviderInterface
 * @mayImport type-only ../../credentialVault/index.ts
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant `AgentModelConfig`'s single home is this contract; new code imports it from here, `runtime/agent` re-exports it type-only, and `domain/directorAgent` consumes it type-only.
 * @invariant Transport receives an already-resolved `AgentModelConfig`: no default model ids, presets, or inheritance policy live here or in the adapters (those belong to MOD-17 `modelConfig`).
 * @invariant Configs carry `keyId` references only — no raw secret material; credentials resolve through the injected `CredentialResolverPort`, and the factory ignores any raw `apiKey`/`encryptionKey` fields on the config object.
 * @invariant `ModelConfig` is frozen by adapters after creation, with `transformPayload` as the sole payload mutation hook.
 * @invariant `checkBalance` never throws on HTTP failure — it resolves to `{ available: false, error }`.
 * @invariant `stream` is an `AsyncGenerator<StreamChunk, CompletionResult, void>` that returns the consolidated result from its finish path; `onChunk` mirrors every yield.
 * @invariant `InferenceError` extends the native `Error` (so `catch (Error)` consumers stay compatible); the HTTP-failure paths that construct it use status-derived code `ERR_HTTP_<status>`, `status` set, and `retryable` classified by the shared 429/5xx policy (the OpenAI-compatible adapters on `stream`/`complete`/`listModels`, and Prem on `listModels`); `DeepSeekError` is the preserved alias with the same class identity (`DeepSeekError === InferenceError`).
 * @invariant Abort is never converted to `InferenceError`: the OpenAI-compatible adapters hand the signal to `fetch` and let the native abort error propagate; Prem rejects an already-aborted `stream` signal with a plain `Error`, propagates its SDK error during the call, and returns the partial result when the signal aborts mid-stream.
 * @invariant The paired runtime companion `index.ts` is a leaf: zero imports, and its only runtime exports are the `InferenceError` class and the `DeepSeekError` alias.
 * @decision `AgentModelConfig`'s single home is the MOD-15 inference contract; `runtime/agent` re-exports and `domain/directorAgent` consumes it type-only
 * @decision `CredentialResolverPort` is the ratified MOD-16 `credentialVault` port consumed by the MOD-15 factory; this contract keeps a type-only re-export of its canonical shape
 * @decision Transport performs no model fallback: the factory and providers require a fully resolved config
 */

import type { CredentialResolverPort } from '../../credentialVault/index.ts';

// ============================================================================
// 1. Chat, Streaming & Completion Request Options
// ============================================================================

/**
 * Conversation message accepted by streaming transports.
 *
 * Content is either a plain string or an array of provider-native content
 * parts (e.g. text/image blocks); the index signature preserves vendor
 * extensions without widening the typed core.
 */
export interface StreamOptions {
  /** Ordered conversation history/input for the request. */
  messages: Array<{
    /** Message author role (`system`, `user`, `assistant`, `tool`, ...). */
    role: string;
    /** Plain text or provider-native content-part array. */
    content: string | Array<unknown>;
    /** Optional participant name for multi-agent conversations. */
    name?: string;
    /** Tool-call correlation id for `tool` role messages. */
    tool_call_id?: string;
    /** Tool calls requested by an assistant message. */
    tool_calls?: Array<unknown>;
    /** Vendor reasoning transcript (DeepSeek native style). */
    reasoning_content?: string;
    /** Vendor reasoning transcript (OpenAI-compatible style). */
    reasoning?: string;
    /** Additional vendor-specific message fields. */
    [key: string]: unknown;
  }>;
  /** Tool/function JSON-schema declarations offered to the model. */
  tools?: Array<unknown>;
  /** Cancellation signal propagated to the underlying fetch/stream. */
  signal?: AbortSignal;
  /** Optional mirror callback invoked for every yielded {@link StreamChunk}. */
  onChunk?: (chunk: StreamChunk) => void;
}

/**
 * Conversation message accepted by non-streaming completion transports
 * (same message shape as {@link StreamOptions}, without `onChunk`).
 */
export interface CompletionOptions {
  /** Ordered conversation history/input for the request. */
  messages: Array<{
    /** Message author role (`system`, `user`, `assistant`, `tool`, ...). */
    role: string;
    /** Plain text or provider-native content-part array. */
    content: string | Array<unknown>;
    /** Optional participant name for multi-agent conversations. */
    name?: string;
    /** Tool-call correlation id for `tool` role messages. */
    tool_call_id?: string;
    /** Tool calls requested by an assistant message. */
    tool_calls?: Array<unknown>;
    /** Vendor reasoning transcript (DeepSeek native style). */
    reasoning_content?: string;
    /** Vendor reasoning transcript (OpenAI-compatible style). */
    reasoning?: string;
    /** Additional vendor-specific message fields. */
    [key: string]: unknown;
  }>;
  /** Tool/function JSON-schema declarations offered to the model. */
  tools?: Array<unknown>;
  /** Cancellation signal propagated to the underlying fetch/stream. */
  signal?: AbortSignal;
}

// ============================================================================
// 2. Tool Calling, Stream Chunks & Completion Results
// ============================================================================

/**
 * Fully accumulated tool/function call produced by a model turn.
 *
 * `args` is the parsed argument object; `rawArguments` preserves the exact
 * streamed JSON text when a caller needs it for audit or repair.
 */
export interface ToolCall {
  /** Provider-assigned tool-call identifier used for result correlation. */
  id: string;
  /** Function/tool name requested by the model. */
  name: string;
  /** Parsed tool argument object. */
  args: Record<string, unknown>;
  /** Original streamed argument JSON text, when captured. */
  rawArguments?: string;
}

/**
 * Incremental event yielded by {@link ModelInterface.stream}.
 *
 * The generator yields `text`/`reasoning`/`tool_call`/`usage` chunks as they
 * arrive and finally returns the consolidated {@link CompletionResult}
 * (the terminal `finish` chunk marks the transition).
 */
export interface StreamChunk {
  /** Chunk discriminator (`'text' | 'reasoning' | 'tool_call' | 'usage' | 'finish'`). */
  type: 'text' | 'reasoning' | 'tool_call' | 'usage' | 'finish';
  /** Incremental text delta for `text` chunks. */
  content?: string;
  /** Incremental reasoning delta for `reasoning` chunks. */
  reasoning?: string;
  /** Tool-call deltas; `args` may still be an unparsed JSON string mid-stream. */
  toolCalls?: Array<ToolCall | { id: string; name: string; args: string }>;
  /** Token accounting attached to `usage`/`finish` chunks. */
  usage?: {
    /** Prompt (input) token count. */
    prompt_tokens?: number;
    /** Completion (output) token count. */
    completion_tokens?: number;
    /** Total token count as reported by the provider. */
    total_tokens?: number;
    /** Additional provider-specific accounting fields. */
    [key: string]: unknown;
  };
  /** Provider finish reason (`stop`, `tool_calls`, `length`, ...). */
  finishReason?: string;
}

/**
 * Consolidated result returned by `stream` (as the generator return value)
 * and by {@link ModelInterface.complete}.
 */
export interface CompletionResult {
  /** Full assistant text content for the turn. */
  content: string;
  /** Full reasoning transcript for the turn (empty when unsupported). */
  reasoning: string;
  /** Tool calls requested during the turn (parsed). */
  toolCalls: ToolCall[];
  /** Aggregate token accounting, when reported. */
  usage?: {
    /** Prompt (input) token count. */
    prompt_tokens?: number;
    /** Completion (output) token count. */
    completion_tokens?: number;
    /** Total token count as reported by the provider. */
    total_tokens?: number;
    /** Additional provider-specific accounting fields. */
    [key: string]: unknown;
  };
  /** Provider finish reason (`stop`, `tool_calls`, `length`, ...). */
  finishReason?: string;
}

// ============================================================================
// 3. Model & Provider Configuration
// ============================================================================

/**
 * Canonical resolved model configuration handed to MOD-15 transport.
 *
 * **Single home:** this declaration is authoritative. `runtime/agent.d.ts`
 * re-exports it type-only; `domain/directorAgent.d.ts` consumes it type-only.
 * Both modules' former duplicate declarations are deleted.
 *
 * Invariant: the transport receives an **already-resolved** config — no
 * default model ids, presets, or inheritance policy live in MOD-15 or here
 * (those belong to MOD-17 `modelConfig`). Contains no raw secrets: `keyId`
 * references a credential resolved through `CredentialResolverPort`.
 */
export interface AgentModelConfig {
  /** Provider identifier (e.g. `'runware'`, `'nanogpt'`, `'deepseek'`, `'prem'`, `'custom'`). */
  providerId: string;
  /** Credential id resolved via `CredentialResolverPort.getCredential`. */
  keyId: string;
  /** Concrete model identifier. */
  modelId: string;
  /**
   * Per-agent endpoint override consumed by the factory's `custom` (required)
   * and `openai`/unknown-vendor branches; the `runware`, `nanogpt`,
   * `deepseek`/`deepseek_native`, and `prem` branches ignore it and use their
   * vendor default endpoint.
   */
  url?: string;
  /** Sampling temperature (provider-defined range). */
  temperature?: number;
  /** Reasoning budget selector for reasoning-capable models. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  /** Provider routing preference (e.g. OpenRouter-style routing slug). */
  routing?: string;
  /** Provider service-tier selector (e.g. OpenAI `flex`/`priority`). */
  serviceTier?: string;
  /** Additional resolved vendor-specific parameters. */
  [key: string]: unknown;
}

/**
 * Model-bound configuration applied when instantiating a model through
 * {@link ProviderInterface.createModel}. Frozen by adapters after creation.
 */
export interface ModelConfig {
  /** Sampling temperature override for this model instance. */
  temperature?: number;
  /** Reasoning budget selector for reasoning-capable models. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  /** Provider routing preference for this model instance. */
  routing?: string;
  /** Provider service-tier selector for this model instance. */
  serviceTier?: string;
  /** Sole payload mutation hook: receives the outbound body, returns the body to send. */
  transformPayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  /** Additional model-bound vendor-specific parameters. */
  [key: string]: unknown;
}

// ============================================================================
// 4. Discovery, Routing & Balance Results
// ============================================================================

/**
 * Account balance lookup result.
 *
 * Contract: `checkBalance` **never throws** on HTTP failure — it resolves to
 * `{ available: false, error }` instead.
 */
export interface BalanceResult {
  /** Whether balance information was successfully retrieved. */
  available: boolean;
  /** Remaining balance (numeric or provider-formatted value). */
  balance?: number | string | null;
  /** Currency code for `balance`. */
  currency?: string;
  /** Pre-formatted human-readable balance string. */
  formatted?: string;
  /** Failure description when `available` is `false`. */
  error?: string;
  /** Raw provider payload retained for diagnostics. */
  raw?: unknown;
}

/**
 * Model descriptor returned by {@link ProviderInterface.listModels}.
 */
export interface ModelDescriptor {
  /** Model identifier used with `createModel`. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Context window size (provider-typed as string or number). */
  contextLength?: string | number;
  /** Maximum input tokens, when reported. */
  maxInputTokens?: number;
  /** Cost indicator as reported by the provider. */
  cost?: string;
  /** Category tags (e.g. `chat`, `reasoning`, `vision`). */
  categories?: string[];
  /** Descriptive model summary. */
  description?: string;
  /** Per-token pricing, when reported. */
  pricing?: {
    /** Prompt (input) price per token/unit. */
    prompt?: number;
    /** Completion (output) price per token/unit. */
    completion?: number;
    /** Additional provider-specific pricing fields. */
    [key: string]: unknown;
  };
  /** Raw provider payload retained for diagnostics. */
  raw?: unknown;
}

/**
 * Routable provider endpoint returned by {@link ProviderInterface.getProviders}.
 */
export interface ProviderRoute {
  /** Route/provider identifier. */
  id: string;
  /** Human-readable route name. */
  name: string;
  /** Provider-reported route status. */
  status?: string;
  /** Whether the route is currently usable. */
  available?: boolean;
  /** Context window size served by this route. */
  contextLength?: string | number;
  /** Maximum input tokens, when reported. */
  maxInputTokens?: number;
  /** Cost indicator as reported by the route. */
  cost?: string;
  /** Raw pricing object, when reported. */
  pricing?: unknown;
  /** Observed tokens per second, when available. */
  tps?: number;
  /** Quantization label of the served weights. */
  quantization?: string;
  /** Raw provider payload retained for diagnostics. */
  raw?: unknown;
}

// ============================================================================
// 5. Model Instance Contract
// ============================================================================

/**
 * ModelInterface
 *
 * An instantiated model bound to a provider and configuration. Executed
 * directly by agents (MOD-13/9 runtime).
 *
 * `stream` is an `AsyncGenerator<StreamChunk, CompletionResult, void>`: it
 * yields incremental chunks and **returns** the consolidated
 * {@link CompletionResult} from its finish path. `onChunk` (when supplied in
 * {@link StreamOptions}) mirrors every yield.
 */
export interface ModelInterface {
  /** Model identifier for this instance. */
  readonly id: string;
  /** Provider that produced this model instance. */
  readonly provider: ProviderInterface;
  /** Frozen model-bound configuration. */
  readonly config: ModelConfig;

  /**
   * Streams a chat completion, yielding incremental chunks and returning the
   * consolidated result.
   *
   * The OpenAI-compatible adapters reject iteration with an `InferenceError`
   * on non-OK HTTP responses (`status` and status-derived `code`, plus the
   * shared retry classification); because it extends the native `Error`,
   * `catch (Error)` consumers stay compatible. Prem transport failures are
   * not wrapped — its `@premai/api-sdk` errors propagate as-is. Abort is never
   * wrapped either: it surfaces as the native fetch/SDK abort error, and the
   * Prem adapter additionally rejects an already-aborted signal with a plain
   * `Error` and stops early (returning the partial result) when the signal
   * aborts mid-stream.
   *
   * @param options - Streaming request options (messages, tools, abort signal, chunk mirror).
   * @returns Consolidated completion result, returned after the terminal `finish` chunk.
   * @throws An `InferenceError` on non-OK HTTP responses from the OpenAI-compatible adapters; Prem SDK failures and other transport errors propagate unwrapped (abort surfaces as the underlying fetch/SDK error, and Prem rejects an already-aborted signal with a plain `Error`).
   */
  stream(options: StreamOptions): AsyncGenerator<StreamChunk, CompletionResult, void>;

  /**
   * Executes a single non-streaming completion.
   *
   * @param options - Completion request options (messages, tools, abort signal).
   * @returns Consolidated completion result.
   * @throws An `InferenceError` on non-OK HTTP responses from the OpenAI-compatible adapters; Prem SDK failures propagate unwrapped, and Prem's empty-choices response throws a plain `Error`.
   */
  complete(options: CompletionOptions): Promise<CompletionResult>;
}

// ============================================================================
// 6. Injected Credential Port & Provider Options
// ============================================================================

/**
 * Shared construction options for provider adapters.
 *
 * Credential precedence, highest first:
 * 1. the `credentialId` resolved through the injected `vault`
 *    (`vault.getCredential`), when that lookup yields a key;
 * 2. the explicit `apiKey`;
 * 3. the vault's active credential for the provider id
 *    (`vault.getActiveCredential`).
 *
 * The effective value is `''` when none of the three yields a non-empty key.
 * `apiUrl` overrides the adapter's vendor endpoint default.
 */
export interface BaseProviderOptions {
  /** Credential id to resolve through the injected resolver port. */
  credentialId?: string;
  /** Injected least-privilege credential resolver, or `null` when absent. */
  vault?: CredentialResolverPort | null;
  /** Pre-resolved API key. */
  apiKey?: string;
  /** Base API URL override. */
  apiUrl?: string;
  /** Explicit provider instance id. */
  id?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Additional adapter-specific options. */
  [key: string]: unknown;
}

/**
 * CredentialResolverPort — re-exported from its canonical MOD-16 home.
 *
 * The ratified contract (shape + semantics) lives in
 * `../../credentialVault/index.ts`; MOD-15 consumers keep importing it from here.
 */
export type { CredentialResolverPort } from '../../credentialVault/index.ts';

// ============================================================================
// 7. Provider Contract
// ============================================================================

/**
 * ProviderInterface
 *
 * Manages provider connectivity, model provisioning, discovery, routing, and
 * balance. Members are declared `readonly` and adapters treat instances as
 * immutable after construction, but instances are not runtime-frozen; Prem
 * additionally memoizes its enclave client lazily (documented in its own
 * contract). `fetch` lives in the adapter implementations, never in this
 * contract.
 */
export interface ProviderInterface {
  /** Provider instance identifier. */
  readonly id: string;

  /**
   * Factory method to instantiate and configure a Model.
   *
   * The returned instance's `config` is frozen, and `modelId` must already be
   * resolved — the transport applies no default.
   *
   * @param modelId - Concrete model identifier.
   * @param config - Model-bound overrides (defaults to `{}`).
   * @returns Model instance bound to this provider.
   * @throws A `TypeError` from the Prem adapter when `modelId` is falsy.
   */
  createModel(modelId: string, config?: ModelConfig): ModelInterface;

  /**
   * Lists models offered by this provider.
   *
   * @param options - Optional abort signal.
   * @returns Normalized model descriptors.
   * @throws An `InferenceError` when the discovery endpoint responds with a non-OK status (OpenAI-compatible and Prem adapters).
   */
  listModels(options?: { signal?: AbortSignal }): Promise<ModelDescriptor[]>;
  /**
   * Lists routable providers/endpoints for a model id, or provider names.
   *
   * @param modelId - Model id to query routes for; adapters without a routing hub ignore it.
   * @param options - Optional abort signal.
   * @returns Normalized routes; an empty array when the provider exposes no routing list.
   */
  getProviders(modelId?: string, options?: { signal?: AbortSignal }): Promise<ProviderRoute[] | string[]>;
  /**
   * Looks up account balance; never throws on HTTP failure (see {@link BalanceResult}).
   *
   * @param options - Optional abort signal.
   * @returns Balance result; providers without a balance endpoint resolve to `{ available: false, balance: null }`.
   */
  checkBalance(options?: { signal?: AbortSignal }): Promise<BalanceResult>;
}

// ============================================================================
// 8. Error Taxonomy
// ============================================================================

/**
 * Unified inference transport error.
 *
 * Runtime implementation lives in `index.ts`; this declaration mirrors it
 * member-for-member. Extends the native `Error`, so `instanceof Error` and
 * `instanceof InferenceError` both hold and `message`/`stack` behave natively;
 * `name` is fixed to `'InferenceError'`.
 *
 * @example
 * ```typescript
 * import { InferenceError } from './index.ts';
 *
 * throw new InferenceError('Upstream rate limit exceeded', {
 *   code: 'ERR_HTTP_429',
 *   status: 429,
 *   details: { providerId: 'deepseek' },
 *   retryable: true
 * });
 * ```
 */
export class InferenceError extends Error {
  /** Free-form programmatic code supplied by the caller (defaults to `'ERR_UNKNOWN'`); the HTTP-failure paths that construct this class use `'ERR_HTTP_<status>'` (OpenAI-compatible adapters, and Prem `listModels`). Abort paths never construct this class, so no sandbox code path emits `'ERR_ABORTED'`. */
  declare readonly code: string;

  /** HTTP status associated with the failure, or `0` when not applicable. */
  declare readonly status: number;

  /** Optional structured diagnostic context for the failure. */
  declare readonly details: unknown;

  /** Caller-supplied retry classification flag (defaults to `false`); the transport retry policy classifies independently from `status` and message heuristics. */
  declare readonly retryable: boolean;

  /**
   * Constructs a classified inference transport error.
   *
   * @param message - Human-readable diagnostic description of the failure.
   * @param options - Optional classification metadata; each field falls back to
   *   its documented default when omitted (`ERR_UNKNOWN` / `0` / `null` / `false`).
   */
  constructor(
    message: string,
    { code = 'ERR_UNKNOWN', status = 0, details = null, retryable = false }: {
      code?: string;
      status?: number;
      details?: unknown;
      retryable?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'InferenceError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

/**
 * Preserved historical alias for {@link InferenceError}.
 *
 * Exported for backwards compatibility with DeepSeek-era call sites: it is the
 * exact same class object, so `DeepSeekError === InferenceError` and errors
 * thrown through either identifier are caught by the other.
 *
 * @example
 * ```js
 * import { DeepSeekError, InferenceError } from './index.ts';
 *
 * console.assert(DeepSeekError === InferenceError);
 * ```
 */
export { InferenceError as DeepSeekError };
