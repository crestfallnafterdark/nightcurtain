/**
 * @packageDocumentation
 * MOD-15 transport contract for the OpenAI-compatible adapter:
 * construction options and the public surface of `OpenAIModel` and
 * `OpenAIProvider`.
 *
 * Runtime implementation: `OpenAIProvider/index.ts`.
 *
 * Encapsulation:
 * - The former TypeScript `private` members (`apiUrl`, `apiKey`,
 *   `customHeaders`, `normalizeMessages`, `buildPayload`) are `#`-private at
 *   runtime and intentionally absent from the surface; `parseSseStream` is
 *   module-private and is not exported.
 * - `fetch` is confined to this adapter file; no settings, credential
 *   singletons, or ambient UI globals are accessed.
 *
 * Error taxonomy: every non-OK HTTP response path throws the contract's
 * `InferenceError` (status-derived `code`, `status`, endpoint `details`, and
 * `retryable` classified by the shared retry policy). Because `InferenceError`
 * extends `Error`, callers catching `Error` remain compatible.
 *
 * @module inference/OpenAIProvider
 * @mayImport ../ProviderInterface/index.ts
 * @mayImport ../retry/index.ts
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant `getEffectiveApiKey()` precedence: a `credentialId` that resolves through the injected `vault` to a non-empty `apiKey` wins over the explicit `apiKey`; otherwise the explicit `apiKey` applies, with `vault.getActiveCredential(providerId)` as the final fallback; it resolves to `''` when no step yields a non-empty key, and no credential singleton is imported.
 * @invariant `getEffectiveApiUrl()` trims trailing slashes and throws a plain `Error` when the provider id is `custom` (case-insensitive) with no URL configured; `getEndpointUrl()` swaps a trailing `/chat/completions` base suffix.
 * @invariant Non-OK HTTP responses from `stream`, `complete`, and `listModels` throw `InferenceError` with `status`, code `ERR_HTTP_<status>`, endpoint `details`, and `retryable` from the shared retry classifier; it extends `Error`, so `catch (Error)` consumers stay compatible.
 * @invariant `OpenAIModel.config` is frozen at construction.
 * @invariant `stream` is an `AsyncGenerator<StreamChunk, CompletionResult, void>` that yields incremental usage/text/reasoning/tool_call chunks plus a terminal `finish` chunk, then returns the consolidated `CompletionResult`; `onChunk` mirrors every yield.
 * @invariant `complete` extracts reasoning from `reasoning_content ?? reasoning ?? thought`, defaulting to `''`.
 * @invariant `checkBalance()` performs no network call and always resolves to `{ available: false, balance: null }`.
 */

import type {
  ProviderInterface,
  ModelInterface,
  ModelConfig,
  StreamOptions,
  CompletionOptions,
  StreamChunk,
  CompletionResult,
  ToolCall,
  ModelDescriptor,
  ProviderRoute,
  BalanceResult,
  CredentialResolverPort
} from '../ProviderInterface/index.ts';
import { InferenceError } from '../ProviderInterface/index.ts';
import { defaultIsRetryable } from '../retry/index.ts';

// ============================================================================
// Wire shapes (OpenAI-compatible JSON boundary)
// ============================================================================

/**
 * Wire shape of the `usage` object reported by the completions API.
 */
interface WireUsage {
  /** Prompt (input) token count. */
  prompt_tokens?: number;
  /** Completion (output) token count. */
  completion_tokens?: number;
  /** Total token count as reported by the provider. */
  total_tokens?: number;
  /** Additional provider-specific accounting fields. */
  [key: string]: unknown;
}

/**
 * Wire shape of a streamed tool-call delta entry.
 */
interface WireToolCallDelta {
  /** Index of the tool call in the accumulated list. */
  index?: number;
  /** Tool-call identifier (first delta only). */
  id?: string;
  /** Function name/argument fragments. */
  function?: {
    /** Function name fragment. */
    name?: string;
    /** Argument JSON fragment. */
    arguments?: string;
  };
}

/**
 * Wire shape of a streamed `delta` object.
 */
interface WireDelta {
  /** Incremental text content. */
  content?: string;
  /** Vendor reasoning transcript (DeepSeek native style). */
  reasoning_content?: string;
  /** Vendor reasoning transcript (OpenAI-compatible style). */
  reasoning?: string;
  /** Vendor reasoning transcript (alternate spelling). */
  thought?: string;
  /** Tool-call deltas. */
  tool_calls?: WireToolCallDelta[];
}

/**
 * Wire shape of a fully accumulated (non-streaming) tool call.
 */
interface WireToolCall {
  /** Tool-call identifier. */
  id?: string;
  /** Function name/arguments payload. */
  function?: {
    /** Function name. */
    name?: string;
    /** Argument JSON text. */
    arguments?: string;
  };
}

/**
 * Wire shape of one `choices[]` entry; `delta` appears in streaming frames,
 * `message` in non-streaming responses.
 */
interface WireChoice {
  /** Provider finish reason (`stop`, `tool_calls`, `length`, ...). */
  finish_reason?: string;
  /** Streamed delta payload. */
  delta?: WireDelta;
  /** Non-streaming assistant message. */
  message?: {
    /** Assistant text content. */
    content?: string;
    /** Vendor reasoning transcript (DeepSeek native style). */
    reasoning_content?: string;
    /** Vendor reasoning transcript (OpenAI-compatible style). */
    reasoning?: string;
    /** Vendor reasoning transcript (alternate spelling). */
    thought?: string;
    /** Requested tool calls. */
    tool_calls?: WireToolCall[];
  };
}

/**
 * Wire shape of one decoded SSE frame.
 */
interface WireStreamFrame {
  /** Token accounting frame. */
  usage?: WireUsage;
  /** Completion choices. */
  choices?: WireChoice[];
}

/**
 * Wire shape of a non-streaming chat completion response.
 */
interface WireCompletionResponse {
  /** Completion choices. */
  choices?: WireChoice[];
  /** Aggregate token accounting. */
  usage?: WireUsage;
}

/**
 * Wire shape of one model entry from the `/models` listing.
 */
interface WireModelEntry {
  /** Model identifier. */
  id?: string;
  /** Display name. */
  name?: string;
  /** Descriptive model summary. */
  description?: string;
  /** Provider-reported cost string. */
  cost?: string;
  /** Context window under any of the listing's field aliases. */
  context_length?: number | string;
  /** Alternate context-window field. */
  contextLength?: number | string;
  /** Alternate context-window field. */
  max_context_length?: number | string;
  /** Alternate context-window field. */
  max_input_tokens?: number | string;
  /** Alternate context-window field. */
  maxInputTokens?: number | string;
  /** Per-token pricing. */
  pricing?: {
    /** Prompt price per token/unit. */
    prompt?: number;
    /** Completion price per token/unit. */
    completion?: number;
    /** Additional provider-specific pricing fields. */
    [key: string]: unknown;
  } | null;
}

// ============================================================================
// SSE Decoding (module-private)
// ============================================================================

/**
 * Parses Server-Sent Events (SSE) frames from a Fetch `Response` body.
 *
 * Module-private helper: deliberately not exported (the module surface exposes
 * only `OpenAIModel` and `OpenAIProvider`).
 *
 * Frame handling: blank lines and `:` comment lines are skipped,
 * `data: [DONE]` terminates the stream, JSON after `data: ` is decoded and
 * yielded, malformed JSON is ignored, and any buffered trailing frame is
 * decoded after the reader ends.
 *
 * @param response - Fetch response whose body carries the SSE frames.
 * @returns Async generator of the decoded JSON object from each `data:` frame.
 */
async function* parseSseStream(response: Response): AsyncGenerator<WireStreamFrame, void, void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;
        if (trimmed.startsWith('data: ')) {
          try {
            yield JSON.parse(trimmed.slice(6)) as WireStreamFrame;
          } catch {
            // Ignore malformed JSON chunks
          }
        }
      }
    }

    if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
      try {
        yield JSON.parse(buffer.trim().slice(6)) as WireStreamFrame;
      } catch {
        // Ignore malformed trailing line
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// OpenAI-Compatible Model
// ============================================================================

/**
 * Construction options for {@link OpenAIProvider}.
 *
 * Precedence for credentials: a `credentialId` that resolves through `vault`
 * to a non-empty `apiKey` wins over the explicit `apiKey`; otherwise the
 * explicit `apiKey` applies, with `vault.getActiveCredential(providerId)` as
 * the final fallback. `apiUrl` is used as-is after trailing slashes are
 * trimmed; this generic adapter defines no vendor endpoint default.
 */
export interface OpenAIProviderOptions {
  /** Base API URL (e.g. `https://api.deepseek.com/v1`); required for the `custom` id and otherwise used as-is — no vendor default, so an unset URL yields `''`/relative endpoints. Trailing slashes are trimmed. */
  apiUrl?: string;
  /** Pre-resolved API key; used when the `credentialId` lookup (if any) does not yield a non-empty key. */
  apiKey?: string;
  /** Credential id looked up through `vault.getCredential`; requires an injected `vault`. */
  credentialId?: string;
  /** Injected credential resolver; when absent, only `apiKey` can supply a key. */
  vault?: CredentialResolverPort | null;
  /** Explicit provider instance id. Defaults to `'openai'`. */
  id?: string;
  /** Extra headers merged into every request; custom entries override the JSON `Content-Type` default, while a resolved key's `Authorization` header is applied last. */
  headers?: Record<string, string>;
}

/**
 * OpenAI-Compatible Model Implementation.
 *
 * `config` is shallow-frozen after construction. `stream` yields incremental
 * {@link StreamChunk} events and returns the consolidated
 * {@link CompletionResult}; `complete` performs a single non-streaming turn
 * with reasoning extraction (`reasoning_content` / `reasoning` / `thought`).
 */
export class OpenAIModel implements ModelInterface {
  /** Model identifier for this instance. */
  readonly id: string;

  /** Provider that produced this model instance. */
  readonly provider: OpenAIProvider;

  /** Shallow-frozen copy of the model-bound configuration; nested values remain mutable. */
  readonly config: ModelConfig;

  /**
   * Constructs a model bound to `provider` with a shallow-frozen copy of `config`.
   *
   * @param provider - Owning provider instance.
   * @param id - Model identifier.
   * @param config - Model-bound configuration; defaults to `{}` and is shallow-frozen after creation.
   */
  constructor(provider: OpenAIProvider, id: string, config: ModelConfig = {}) {
    this.provider = provider;
    this.id = id;
    this.config = Object.freeze({ ...config });
  }

  /**
   * Normalizes messages, ensuring reasoning is mapped to reasoning_content for
   * models that require it.
   *
   * @param messages - Raw conversation messages.
   * @returns Normalized messages (empty array for non-array input).
   */
  #normalizeMessages(messages: unknown): unknown[] {
    if (!Array.isArray(messages)) return [];
    return messages.map(msg => {
      if (!msg || typeof msg !== 'object') return msg;
      if (msg.role === 'assistant' && msg.reasoning && !msg.reasoning_content) {
        return { ...msg, reasoning_content: msg.reasoning };
      }
      return msg;
    });
  }

  /**
   * Builds the OpenAI-compatible chat completion payload.
   *
   * Preserved literals: `max_tokens` is always `100000`, streaming requests
   * add `stream_options: { include_usage: true }`, and `transformPayload` is
   * the sole payload mutation hook.
   *
   * @param messages - Conversation messages (normalized internally).
   * @param tools - Tool/function declarations offered to the model.
   * @param stream - Whether the payload targets the streaming endpoint.
   * @returns Outbound request body (post-`transformPayload`).
   */
  #buildPayload(messages: unknown, tools?: unknown, stream = false): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.id,
      messages: this.#normalizeMessages(messages),
      stream
    };

    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    if (this.config.temperature !== undefined) payload.temperature = this.config.temperature;
    payload.max_tokens = 100000;
    if (this.config.reasoningEffort !== undefined) payload.reasoning_effort = this.config.reasoningEffort;
    if (this.config.routing !== undefined) payload.provider = this.config.routing;
    if (this.config.provider !== undefined) payload.provider = this.config.provider;
    if (this.config.serviceTier !== undefined) payload.service_tier = this.config.serviceTier;

    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
    }

    if (typeof this.config.transformPayload === 'function') {
      return this.config.transformPayload(payload);
    }

    return payload;
  }

  /**
   * Streams a chat completion, yielding usage/text/reasoning/tool_call chunks
   * in arrival order, then a terminal `finish` chunk carrying the consolidated
   * fields; `onChunk` is invoked for every yield.
   *
   * Tool-call chunks carry accumulated calls whose `args` is still the raw JSON
   * string; the finish chunk and returned result carry parsed `args` plus
   * `rawArguments`.
   *
   * @param options - Streaming request options (messages, tools, abort signal, chunk mirror).
   * @returns The consolidated result: accumulated `content`/`reasoning` strings, parsed `toolCalls`, the last reported `usage`, and the last observed `finishReason`.
   * @throws An `InferenceError` (`status`, `ERR_HTTP_<status>`, `details`, `retryable`) when the HTTP status is not OK, with message `OpenAI API error (<status>): <body or statusText>`; fetch/abort failures propagate unchanged.
   */
  async *stream(options: StreamOptions): AsyncGenerator<StreamChunk, CompletionResult, void> {
    const url = this.provider.getEndpointUrl('/chat/completions');
    const payload = this.#buildPayload(options.messages, options.tools, true);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.provider.getHeaders(),
      body: JSON.stringify(payload),
      signal: options.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const message = `OpenAI API error (${response.status}): ${errText || response.statusText}`;
      throw new InferenceError(message, {
        code: `ERR_HTTP_${response.status}`,
        status: response.status,
        details: { providerId: this.provider.id, endpoint: url },
        retryable: defaultIsRetryable({ status: response.status, message })
      });
    }

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let usageResult: CompletionResult['usage'] = undefined;
    let finishReason: string | undefined = undefined;

    for await (const chunk of parseSseStream(response)) {
      if (chunk.usage) {
        usageResult = chunk.usage;
        const uChunk: StreamChunk = { type: 'usage', usage: chunk.usage };
        options.onChunk?.(uChunk);
        yield uChunk;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) continue;

      // 1. Text delta
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        accumulatedContent += delta.content;
        const cChunk: StreamChunk = { type: 'text', content: delta.content };
        options.onChunk?.(cChunk);
        yield cChunk;
      }

      // 2. Reasoning delta (DeepSeek, Qwen, etc.)
      const reasoningVal = delta.reasoning_content ?? delta.reasoning ?? delta.thought;
      if (typeof reasoningVal === 'string' && reasoningVal.length > 0) {
        accumulatedReasoning += reasoningVal;
        const rChunk: StreamChunk = { type: 'reasoning', reasoning: reasoningVal };
        options.onChunk?.(rChunk);
        yield rChunk;
      }

      // 3. Tool calls delta
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallsMap.get(idx) || { id: '', name: '', args: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolCallsMap.set(idx, existing);
        }

        const tChunk: StreamChunk = {
          type: 'tool_call',
          toolCalls: Array.from(toolCallsMap.values()).map(t => ({
            id: t.id,
            name: t.name,
            args: t.args
          }))
        };
        options.onChunk?.(tChunk);
        yield tChunk;
      }
    }

    const parsedToolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map(t => {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(t.args || '{}');
      } catch {
        parsedArgs = { raw: t.args };
      }
      return {
        id: t.id,
        name: t.name,
        args: parsedArgs,
        rawArguments: t.args
      };
    });

    const finalResult: CompletionResult = {
      content: accumulatedContent,
      reasoning: accumulatedReasoning,
      toolCalls: parsedToolCalls,
      usage: usageResult,
      finishReason
    };

    const finishChunk: StreamChunk = {
      type: 'finish',
      finishReason,
      usage: usageResult,
      toolCalls: parsedToolCalls,
      content: accumulatedContent,
      reasoning: accumulatedReasoning
    };
    options.onChunk?.(finishChunk);
    yield finishChunk;

    return finalResult;
  }

  /**
   * Executes a single non-streaming completion.
   *
   * @param options - Completion request options (messages, tools, abort signal).
   * @returns Result with `content`/`reasoning` defaulting to `''`, tool calls parsed from `message.tool_calls` (unparseable argument JSON falls back to `{ raw: <arguments> }`), and provider-reported `usage`/`finishReason`.
   * @throws An `InferenceError` (`status`, `ERR_HTTP_<status>`, `details`, `retryable`) when the HTTP status is not OK, with message `OpenAI API error (<status>): <body or statusText>`; fetch/abort failures propagate unchanged.
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const url = this.provider.getEndpointUrl('/chat/completions');
    const payload = this.#buildPayload(options.messages, options.tools, false);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.provider.getHeaders(),
      body: JSON.stringify(payload),
      signal: options.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const message = `OpenAI API error (${response.status}): ${errText || response.statusText}`;
      throw new InferenceError(message, {
        code: `ERR_HTTP_${response.status}`,
        status: response.status,
        details: { providerId: this.provider.id, endpoint: url },
        retryable: defaultIsRetryable({ status: response.status, message })
      });
    }

    const data = (await response.json()) as WireCompletionResponse;
    const choice: WireChoice = data.choices?.[0] || {};
    const message = choice.message || {};

    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map(tc => {
          let parsedArgs: Record<string, unknown>;
          try {
            parsedArgs = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            parsedArgs = { raw: tc.function?.arguments };
          }
          return {
            id: tc.id || '',
            name: tc.function?.name || '',
            args: parsedArgs,
            rawArguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
          };
        })
      : [];

    return {
      content: message.content || '',
      reasoning: message.reasoning_content ?? message.reasoning ?? message.thought ?? '',
      toolCalls,
      usage: data.usage,
      finishReason: choice.finish_reason
    };
  }
}

// ============================================================================
// OpenAI-Compatible Provider
// ============================================================================

/**
 * OpenAI-Compatible Provider Implementation.
 * Manages URL, Key, and creates configured Models.
 * Members are declared `readonly` and instances are treated as immutable after
 * construction, but they are not runtime-frozen.
 *
 * The constructor accepts either an {@link OpenAIProviderOptions} object or the
 * legacy positional form in all three arities: `(apiUrl)`,
 * `(apiUrl, apiKey)`, and `(apiUrl, apiKey, id)`.
 */
export class OpenAIProvider implements ProviderInterface {
  /** Provider instance identifier. */
  readonly id: string;

  /** Credential id looked up through the injected resolver; unset for the legacy positional form. */
  readonly credentialId?: string;

  /** Injected credential resolver; unset for the legacy positional form. */
  readonly vault?: CredentialResolverPort | null;

  /** Base API URL after trailing-slash trimming; unset when no URL was configured. */
  #apiUrl?: string;

  /** Explicit pre-resolved API key; the credential lookup happens in `getEffectiveApiKey`. */
  #apiKey: string;

  /** Extra headers merged into every request. */
  #customHeaders: Record<string, string>;

  /**
   * Constructs a provider from an options object.
   *
   * @param options - Construction options.
   */
  constructor(options: OpenAIProviderOptions);

  /**
   * Constructs a provider from a legacy base API URL (provider id defaults to `'openai'`).
   *
   * @param apiUrl - Base API URL.
   */
  constructor(apiUrl: string);

  /**
   * Constructs a provider from the legacy positional form; `credentialId` and
   * `vault` stay unset, so only `apiKey` can resolve.
   *
   * @param apiUrl - Base API URL.
   * @param apiKey - Optional pre-resolved API key.
   * @param id - Optional provider instance id. Defaults to `'openai'`.
   */
  constructor(apiUrl: string, apiKey?: string, id?: string);

  /**
   * Constructs a provider from an options object or the legacy positional
   * `(apiUrl, apiKey, id)` form. Both paths preserve the legacy behavior.
   *
   * @param options - Options object, or base API URL.
   * @param apiKey - API key (legacy positional form only).
   * @param id - Provider instance id (legacy positional form only).
   */
  constructor(options: OpenAIProviderOptions | string, apiKey?: string, id = 'openai') {
    if (typeof options === 'string') {
      this.#apiUrl = options.trim().replace(/\/+$/, '');
      this.#apiKey = apiKey || '';
      this.id = id;
      this.#customHeaders = {};
    } else {
      this.#apiUrl = options.apiUrl ? options.apiUrl.trim().replace(/\/+$/, '') : undefined;
      this.#apiKey = options.apiKey || '';
      this.credentialId = options.credentialId;
      this.vault = options.vault;
      this.id = options.id || 'openai';
      this.#customHeaders = options.headers || {};
    }
  }

  /**
   * Resolves the effective API key: a `credentialId` lookup through the
   * injected vault wins when it yields a non-empty key; otherwise the
   * explicitly configured `apiKey` applies, then the vault's active credential
   * for this provider id.
   *
   * @returns The resolved key, or `''` when no step yields a non-empty key.
   */
  getEffectiveApiKey(): string {
    if (this.credentialId && this.vault) {
      const cred = this.vault.getCredential(this.credentialId);
      if (cred?.apiKey) return cred.apiKey;
    }
    if (this.#apiKey) return this.#apiKey;
    if (this.vault) {
      const active = this.vault.getActiveCredential(this.id);
      if (active?.apiKey) return active.apiKey;
    }
    return '';
  }

  /**
   * Resolves the effective base API URL, trimming trailing slashes.
   *
   * @returns The trimmed URL, or `''` when none was configured for a non-`custom` provider.
   * @throws A plain `Error` when this is the `custom` provider (id compared case-insensitively) and no URL was provided.
   */
  getEffectiveApiUrl(): string {
    if (this.#apiUrl && this.#apiUrl.trim()) {
      return this.#apiUrl.trim().replace(/\/+$/, '');
    }
    if (this.id === 'custom' || this.id?.toLowerCase() === 'custom') {
      throw new Error("Custom provider requires a valid endpoint 'url' in AgentModelConfig");
    }
    return '';
  }

  /**
   * Builds request headers: JSON content type, custom headers, and a bearer
   * `Authorization` header when a key resolves.
   *
   * @returns A fresh header map; custom headers may override `Content-Type`, but the bearer `Authorization` is applied last.
   */
  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.#customHeaders
    };
    const key = this.getEffectiveApiKey();
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    return headers;
  }

  /**
   * Resolves a request URL against the effective base URL, swapping a
   * `/chat/completions` base suffix when present.
   *
   * @param path - Endpoint path (with or without a leading slash).
   * @returns The base URL plus the normalized path; a trailing `/chat/completions` base has that suffix replaced by `path`, except when `path` is exactly `/chat/completions` (then the base is returned unchanged). With no base URL configured, the root-relative path alone is returned; a `custom` provider without a URL throws from `getEffectiveApiUrl`.
   */
  getEndpointUrl(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const baseUrl = this.getEffectiveApiUrl();
    if (baseUrl.endsWith('/chat/completions')) {
      if (cleanPath === '/chat/completions') return baseUrl;
      return `${baseUrl.slice(0, -'/chat/completions'.length)}${cleanPath}`;
    }
    return `${baseUrl}${cleanPath}`;
  }

  /**
   * Factory method to instantiate and configure a Model.
   *
   * @param modelId - Model identifier bound to the new instance.
   * @param config - Model-bound configuration; defaults to `{}` and is shallow-frozen by the model.
   * @returns A new {@link OpenAIModel} bound to this provider.
   */
  createModel(modelId: string, config: ModelConfig = {}): ModelInterface {
    return new OpenAIModel(this, modelId, config);
  }

  /**
   * Lists models from the OpenAI-compatible `/models` endpoint, normalizing
   * context lengths and pricing into display strings.
   *
   * @param options - Optional abort signal forwarded to the request.
   * @returns Descriptors with `id`/`name` fallbacks, `contextLength` formatted as `M`/`k`/raw, `cost` taken from the provider's `cost` field or formatted per-million pricing, `maxInputTokens` for numeric context windows, and `raw` retaining the provider entry; accepts either `{ data: [...] }` or a bare array.
   * @throws An `InferenceError` (`status`, `ERR_HTTP_<status>`, `details`, `retryable`) when the HTTP status is not OK, with message `OpenAI listModels error (<status>): <body or statusText>`.
   */
  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelDescriptor[]> {
    const url = this.getEndpointUrl('/models');
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
      signal: options.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const message = `OpenAI listModels error (${response.status}): ${errText || response.statusText}`;
      throw new InferenceError(message, {
        code: `ERR_HTTP_${response.status}`,
        status: response.status,
        details: { providerId: this.id, endpoint: url },
        retryable: defaultIsRetryable({ status: response.status, message })
      });
    }

    const data = (await response.json()) as { data?: unknown };
    const list: unknown[] = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    return list.map(entry => {
      const m = entry as WireModelEntry;
      const id = m.id || String(m);
      const rawCtx = m.context_length || m.contextLength || m.max_context_length || m.max_input_tokens || m.maxInputTokens;
      let formattedCtx: string | undefined;
      if (typeof rawCtx === 'number') {
        formattedCtx = rawCtx >= 1000000 ? `${(rawCtx / 1000000).toFixed(0)}M` : (rawCtx >= 1000 ? `${Math.round(rawCtx / 1000)}k` : `${rawCtx}`);
      } else if (rawCtx) {
        formattedCtx = String(rawCtx);
      }

      let costStr = m.cost || '';
      if (!costStr && m.pricing) {
        let pIn = m.pricing.prompt !== undefined ? parseFloat(String(m.pricing.prompt)) : undefined;
        let pOut = m.pricing.completion !== undefined ? parseFloat(String(m.pricing.completion)) : undefined;
        if (pIn !== undefined && pIn < 0.001) pIn = Math.round(pIn * 1000000 * 100) / 100;
        if (pOut !== undefined && pOut < 0.001) pOut = Math.round(pOut * 1000000 * 100) / 100;

        if (pIn !== undefined || pOut !== undefined) {
          costStr = `In: $${pIn ?? 0}/M • Out: $${pOut ?? 0}/M`;
        }
      }

      return {
        id,
        name: m.name || id,
        description: m.description,
        contextLength: formattedCtx,
        maxInputTokens: typeof rawCtx === 'number' ? rawCtx : undefined,
        cost: costStr,
        pricing: m.pricing ?? undefined,
        raw: m
      };
    });
  }

  /**
   * OpenAI-compatible providers expose no separate routing list.
   *
   * @param modelId - Ignored; kept for interface parity.
   * @param options - Ignored; kept for interface parity.
   * @returns Always an empty array.
   */
  async getProviders(_modelId?: string, _options?: { signal?: AbortSignal }): Promise<ProviderRoute[] | string[]> {
    void _modelId;
    void _options;
    return [];
  }

  /**
   * No balance endpoint: performs no network call and never throws.
   *
   * @param options - Ignored; kept for interface parity.
   * @returns Always `{ available: false, balance: null }`.
   */
  async checkBalance(_options?: { signal?: AbortSignal }): Promise<BalanceResult> {
    void _options;
    return { available: false, balance: null };
  }
}
