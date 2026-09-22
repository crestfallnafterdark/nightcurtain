/**
 * @packageDocumentation
 * Prem AI confidential-enclave transport adapter. Runtime implementation with
 * explicit encapsulation; behavior is preserved from the legacy TypeScript
 * adapter.
 *
 * Contract: this module declares `PremProviderOptions`, the four enclave
 * client helpers, `PremModel`, and `PremProvider`. Imports are limited to the
 * npm `@premai/api-sdk/browser` SDK (enclave runtime) plus the intra-module
 * contract pair (`ProviderInterface` for `InferenceError` and the transport
 * types, `retry` for the shared retry classifier).
 *
 * Encapsulation (TS `private` → `#`):
 * - `PremModel`: `#normalizeMessages`, `#buildRequestOptions` (not in contract).
 * - `PremProvider`: `#client`, `#apiKey`, `#clientKEK`, `#gatewayUrl` (not in contract).
 * - Module-level singletons `enclaveClientCache` (Map keyed by credential id or
 *   `apiKey:clientKEK`, value = creation Promise) and `defaultModuleKEK` stay
 *   module-scope and are reachable only through `getPremEnclaveClient`,
 *   `getDefaultClientKEK`, and `resetPremEnclaveClient`.
 *
 * Preserved semantics: 64-hex `clientKEK` validation with
 * `generateNewClientKEK()` fallback, `dangerouslyAllowBrowser`, 300 000 ms
 * request/OpenAI timeouts, `attest: false`, lazy enclave-client creation, and
 * the `{ available: false, balance: null }` balance stub.
 *
 * MC-4: the model-id fallback is removed — model ids arrive fully resolved
 * (MOD-15 invariant 4: no default model ids in transport).
 *
 * Contract alignment: `PremModel` honors `config.transformPayload` as the sole
 * payload mutation hook, and non-OK HTTP responses from `listModels` throw the
 * contract's `InferenceError` (extends `Error`, so `catch (Error)` callers
 * remain compatible).
 *
 * @module inference/PremProvider
 * @mayImport \@premai/api-sdk/browser
 * @mayImport ../ProviderInterface/index.ts
 * @mayImport ../retry/index.ts
 * @mustNotImport ../modelConfig/index.ts
 * @mustNotImport ../runtime/*
 * @mustNotImport ../domain/*
 * @mustNotImport ../tools/*
 * @invariant The module-level `enclaveClientCache` (keyed by credential id or `apiKey:clientKEK`, value = creation promise) and `defaultModuleKEK` singletons are preserved: they stay module-scope and are reachable only through `getPremEnclaveClient`, `getDefaultClientKEK`, and `resetPremEnclaveClient`.
 * @invariant A failed enclave-client creation evicts its cache entry, so a later call may retry.
 * @invariant Concurrent callers for the same cache key share the exact same creation promise — and therefore the same client identity.
 * @invariant `createPremEnclaveClient` honors only a valid 64-hex `clientKEK` verbatim; any other value yields a freshly generated KEK, while the provider constructor's missing-KEK path uses the memoized module default.
 * @invariant The gateway URL is trimmed of trailing slashes and defaults to `https://gateway.prem.io`; attestation is disabled and request/OpenAI timeouts are fixed at 300 000 ms.
 * @invariant Providers are treated as immutable after construction (members are `readonly` in this contract, but instances are not runtime-frozen) except the documented lazy enclave-client memoization on `getClient()`; `PremModel.config` is frozen at construction.
 * @invariant `PremModel` honors `config.transformPayload` as the sole payload mutation hook (it receives the assembled enclave request body and its return value is sent); of the `ModelConfig` keys, only `temperature` is forwarded (`maxTokens`, `reasoningEffort`, `routing`, `serviceTier` are accepted but ignored) and `max_tokens` is fixed at 100 000.
 * @invariant Non-OK HTTP responses from `listModels` throw `InferenceError` with `status`, code `ERR_HTTP_<status>`, endpoint `details`, and `retryable` from the shared retry classifier; it extends `Error`, so `catch (Error)` consumers stay compatible.
 * @invariant `PremModel` construction and `PremProvider.createModel` throw `TypeError` on a falsy model id; transport performs no model-id fallback (MC-4).
 * @invariant `checkBalance()` is unsupported for the enclave: it performs no network call, never throws, and always resolves to `{ available: false, balance: null }`.
 * @invariant `getEffectiveClientKEK()` precedence: a valid 64-hex `encryptionKey` on the credential referenced by `credentialId` wins over the construction KEK when `vault` is injected and the lookup yields one, falling back to `''`.
 * @decision The npm `@premai/api-sdk/browser` SDK is the sanctioned runtime import for the Prem confidential-enclave adapter; the SDK is typed `any` at that boundary
 * @decision The module-level `enclaveClientCache` and `defaultModuleKEK` singletons are preserved from the port and are reset only via `resetPremEnclaveClient`
 * @decision Transport performs no model-id fallback: Prem model construction requires an already-resolved id, throwing `TypeError` on falsy
 */

import type {
  BalanceResult,
  CompletionOptions,
  CompletionResult,
  CredentialResolverPort,
  ModelConfig,
  ModelDescriptor,
  ModelInterface,
  ProviderInterface,
  ProviderRoute,
  StreamChunk,
  StreamOptions,
  ToolCall
} from '../ProviderInterface/index.ts';
import createRvencClient, { generateNewClientKEK } from '@premai/api-sdk/browser';
import { InferenceError } from '../ProviderInterface/index.ts';
import { defaultIsRetryable } from '../retry/index.ts';

// ============================================================================
// 1. Enclave Client Helpers
// ============================================================================

/**
 * Construction options for {@link PremProvider}.
 *
 * `client` is an injected RvencClient reference used to bound enclave resource
 * footprint; when present it short-circuits lazy creation in `getClient()`.
 * `credentialId`/`vault` drive dynamic credential resolution and `apiKey` is the
 * pre-resolved fallback. `gatewayUrl` overrides the vendor endpoint. `clientKEK`
 * is consumed by two paths: the provider constructor preserves any non-empty
 * value verbatim (only a missing/empty value falls back to the module default),
 * while {@link createPremEnclaveClient} honors it only when it is a valid
 * 64-hex string and otherwise generates a fresh KEK. Both `client` and
 * `gatewayUrl` are preserved injection/test hooks: no in-repo production
 * caller supplies them.
 */
export interface PremProviderOptions {
  /** Injected RvencClient reference to bound enclave resource footprint. Preserved injection/test hook: no in-repo production caller supplies it; when present it short-circuits lazy creation in `getClient()`. */
  client?: any;
  /** Credential id resolved through the injected resolver. */
  credentialId?: string;
  /** Injected credential resolver used for dynamic API-key/KEK resolution; the `credentialId` lookup (API key and KEK override) requires an injected `vault` — without one, `credentialId` is ignored. */
  vault?: CredentialResolverPort | null;
  /** Pre-resolved Prem API key. */
  apiKey?: string;
  /** Explicit client KEK; the provider preserves any non-empty value, while {@link createPremEnclaveClient} honors only a valid 64-hex value. */
  clientKEK?: string;
  /** Gateway base URL override (default `https://gateway.prem.io`). Preserved injection/test hook: no in-repo production caller supplies it. */
  gatewayUrl?: string;
}

/**
 * Creates a Prem confidential-enclave client.
 *
 * A valid 64-hex `clientKEK` is used verbatim; any other value falls back to a
 * fresh `generateNewClientKEK()`. The gateway URL is trimmed of trailing
 * slashes and defaults to `https://gateway.prem.io`. Attestation is disabled
 * and request/OpenAI timeouts are fixed at 300 000 ms.
 *
 * @param options - Enclave construction parameters.
 * @returns The resolved RvencClient (SDK-typed as `any`).
 * @throws Any rejection raised by the underlying SDK client construction.
 */
export async function createPremEnclaveClient(options: {
  apiKey: string;
  clientKEK?: string;
  gatewayUrl?: string;
}): Promise<any> {
  const kek = typeof options.clientKEK === 'string' && /^[0-9a-fA-F]{64}$/.test(options.clientKEK)
    ? options.clientKEK
    : generateNewClientKEK();
  const gateway = (options.gatewayUrl || 'https://gateway.prem.io').replace(/\/+$/, '');

  return await createRvencClient({
    apiKey: options.apiKey,
    clientKEK: kek,
    attest: false,
    requestTimeoutMs: 300000,
    config: {
      endpoints: {
        enclave: 'https://conf-engine.prem.io',
        proxy: gateway
      },
      openAIClientOptions: {
        dangerouslyAllowBrowser: true,
        timeout: 300000
      }
    }
  });
}

/**
 * Shared Module-Level Singleton Cache for RvencClient.
 * Ensures only ONE WebAssembly confidential enclave instance is active
 * per unique credential / KEK pair across all Prem agents in the browser realm.
 */
const enclaveClientCache = new Map<string, Promise<any>>();

/**
 * Returns the cached enclave client promise for `cacheKey`, or creates and
 * caches one. A failed creation removes the cache entry so a later call may
 * retry; concurrent callers reuse the exact same cached creation promise (and
 * therefore the same client identity).
 *
 * @param cacheKey - Cache identity (credential id, or `apiKey:clientKEK`).
 * @param options - Enclave construction parameters, used only on cache miss.
 * @returns Shared RvencClient promise.
 */
export async function getPremEnclaveClient(
  cacheKey: string,
  options: { apiKey: string; clientKEK?: string; gatewayUrl?: string }
): Promise<any> {
  const existing = enclaveClientCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const clientPromise = createPremEnclaveClient(options).catch(err => {
    enclaveClientCache.delete(cacheKey);
    throw err;
  });

  enclaveClientCache.set(cacheKey, clientPromise);
  return clientPromise;
}

/**
 * Module-level default client KEK, lazily generated on first use and shared by
 * every `PremProvider` constructed without an explicit KEK.
 */
let defaultModuleKEK: string | null = null;

/**
 * Returns the module-level default client KEK, generating and memoizing one on
 * first use. The identity is stable until `resetPremEnclaveClient()` is called
 * without a cache key.
 *
 * @returns 64-hex client KEK.
 */
export function getDefaultClientKEK(): string {
  if (!defaultModuleKEK) {
    defaultModuleKEK = generateNewClientKEK();
  }
  return defaultModuleKEK;
}

/**
 * Resets module-level enclave client state.
 *
 * With a `cacheKey`, only that cache entry is evicted (the default KEK is left
 * untouched). Without one, the whole cache is cleared AND the default module
 * KEK is reset, so the next `getDefaultClientKEK()` generates a fresh value.
 * Preserved reset/test helper: no in-repo production caller invokes it; it is
 * exported for test isolation and legacy parity.
 *
 * @param cacheKey - Specific cache entry to evict; omit to clear all.
 */
export function resetPremEnclaveClient(cacheKey?: string): void {
  if (cacheKey) {
    enclaveClientCache.delete(cacheKey);
  } else {
    enclaveClientCache.clear();
    defaultModuleKEK = null;
  }
}

// ============================================================================
// 2. Model & Provider
// ============================================================================

/**
 * Wire shape of a fully accumulated (non-streaming) tool call returned by the
 * enclave's OpenAI-compatible surface.
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
 * Wire shape of one model entry from the enclave gateway's `/rvenc/models`
 * listing.
 */
interface WirePremModel {
  /** Model identifier under either alias. */
  id?: string;
  /** Model identifier under either alias. */
  model?: string;
  /** Display name. */
  name?: string;
  /** Descriptive summary. */
  description?: string;
  /** Model category (`CHAT`, ...); absent entries are treated as chat. */
  type?: string;
  /** Confidential pricing block. */
  price_config?: {
    /** Confidential pricing tier. */
    confidential?: {
      /** Default per-1k-token pricing. */
      default?: {
        /** Prompt price per 1k tokens. */
        prompt_price_per_k: number;
        /** Completion price per 1k tokens. */
        completion_price_per_k: number;
      };
    };
  };
}

/**
 * Prem AI Confidential Enclave Model Implementation.
 *
 * `id` must arrive fully resolved (MC-4 removed the transport-level fallback;
 * MOD-15 invariant 4: no default model ids in transport); `config` is frozen
 * after construction. `config.transformPayload` is honored as the sole payload
 * mutation hook; of the `ModelConfig` keys, only `temperature` is forwarded.
 * `tools` from request options are included when non-empty; `max_tokens` is
 * fixed at 100 000 and a caller-supplied `config.maxTokens` is ignored.
 */
export class PremModel implements ModelInterface {
  /** Model identifier for this instance. */
  readonly id: string;

  /** Owning Prem provider. */
  readonly provider: PremProvider;

  /** Frozen model-bound configuration. */
  readonly config: ModelConfig;

  /**
   * Constructs an enclave model from a resolved id, throwing `TypeError` when
   * `id` is falsy.
   *
   * @param provider - Owning provider instance.
   * @param id - Resolved model identifier (required; no transport default).
   * @param config - Model-bound configuration; defaults to `{}` and is frozen
   *   after construction.
   * @throws A `TypeError` when `id` is falsy.
   */
  constructor(provider: PremProvider, id: string, config: ModelConfig = {}) {
    if (!id) {
      throw new TypeError('PremModel requires a resolved model id (no transport default).');
    }
    this.provider = provider;
    this.id = id;
    this.config = Object.freeze({ ...config });
  }

  /**
   * Maps outbound messages to the Prem-native shape: a `reasoning` transcript is
   * mirrored into `reasoning_content` when the latter is absent.
   *
   * @param messages - Candidate message array.
   * @returns Normalized messages (non-arrays yield `[]`).
   */
  #normalizeMessages(messages: unknown): unknown[] {
    if (!Array.isArray(messages)) return [];
    return messages.map(msg => {
      if (!msg || typeof msg !== 'object') return msg;
      const clean = { ...msg };
      if (clean.reasoning && !clean.reasoning_content) {
        clean.reasoning_content = clean.reasoning;
      }
      return clean;
    });
  }

  /**
   * Builds the outbound chat-completions request body.
   *
   * `config.transformPayload` is honored as the sole payload mutation hook
   * (matching the OpenAI-compatible adapter): when supplied it receives the
   * assembled body and its return value is sent. Of the `ModelConfig` keys,
   * only `temperature` is forwarded; `config.maxTokens` is accepted but
   * ignored.
   *
   * @param messages - Conversation messages.
   * @param tools - Tool declarations; omitted from the payload when empty.
   * @param stream - Whether the request is a streaming request.
   * @returns Request body (`temperature` defaults to `0.3`, `max_tokens` fixed at 100 000), post-`transformPayload` when configured.
   */
  #buildRequestOptions(messages: unknown, tools?: unknown, stream = false): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      model: this.id,
      messages: this.#normalizeMessages(messages),
      stream,
      temperature: this.config.temperature ?? 0.3
    };

    opts.max_tokens = 100000;

    if (Array.isArray(tools) && tools.length > 0) {
      opts.tools = tools;
    }

    if (typeof this.config.transformPayload === 'function') {
      return this.config.transformPayload(opts);
    }

    return opts;
  }

  /**
   * Streams a Prem confidential-enclave completion, yielding usage/text/
   * reasoning/tool_call chunks, a terminal finish chunk, and returning the
   * consolidated result.
   *
   * @param options - Streaming request options.
   * @throws An `Error` when the signal is already aborted before execution or
   *   when no Prem API key can be resolved for the underlying client.
   */
  async *stream(options: StreamOptions): AsyncGenerator<StreamChunk, CompletionResult, void> {
    if (options.signal?.aborted) {
      throw new Error('Stream request was aborted before execution.');
    }
    const client = await this.provider.getClient();
    const requestOptions = this.#buildRequestOptions(options.messages, options.tools, true);

    const stream = await client.chat.completions.create(requestOptions, {
      signal: options.signal
    });

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let usageResult: CompletionResult['usage'] = undefined;
    let finishReason: string | undefined = undefined;

    for await (const chunk of stream) {
      if (options.signal?.aborted) break;

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

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        accumulatedContent += delta.content;
        const cChunk: StreamChunk = { type: 'text', content: delta.content };
        options.onChunk?.(cChunk);
        yield cChunk;
      }

      const reasoningVal = delta.reasoning_content ?? delta.reasoning ?? delta.thought;
      if (typeof reasoningVal === 'string' && reasoningVal.length > 0) {
        accumulatedReasoning += reasoningVal;
        const rChunk: StreamChunk = { type: 'reasoning', reasoning: reasoningVal };
        options.onChunk?.(rChunk);
        yield rChunk;
      }

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
          toolCalls: Array.from(toolCallsMap.values())
        };
        options.onChunk?.(tChunk);
        yield tChunk;
      }
    }

    const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map(tc => {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.args || '{}');
      } catch {
        parsedArgs = { raw: tc.args };
      }
      return {
        id: tc.id || '',
        name: tc.name || '',
        args: parsedArgs,
        rawArguments: tc.args
      };
    });

    const completionResult: CompletionResult = {
      content: accumulatedContent,
      reasoning: accumulatedReasoning,
      toolCalls,
      usage: usageResult,
      finishReason
    };

    const finishChunk: StreamChunk = {
      type: 'finish',
      content: accumulatedContent,
      reasoning: accumulatedReasoning,
      toolCalls,
      usage: usageResult,
      finishReason
    };
    options.onChunk?.(finishChunk);
    yield finishChunk;

    return completionResult;
  }

  /**
   * Executes a single non-streaming Prem confidential-enclave completion.
   *
   * @param options - Completion request options.
   * @throws An `Error` when no Prem API key can be resolved or when Prem
   *   returns an empty choices array.
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.provider.getClient();
    const requestOptions = this.#buildRequestOptions(options.messages, options.tools, false);

    const response = await client.chat.completions.create(requestOptions, {
      signal: options.signal
    });

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error('Prem API returned empty choices array');
    }

    const message = choice.message || {};
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc: WireToolCall) => {
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
      usage: response.usage,
      finishReason: choice.finish_reason
    };
  }
}

/**
 * Prem AI Provider
 * Client-Encrypted Security Enclave provider implementation.
 *
 * Members are declared `readonly` and instances are treated as immutable after
 * construction, but they are not runtime-frozen. The sole mutation is the
 * documented lazy enclave-client memoization on the instance (`getClient()`),
 * backed by the module-level singleton cache.
 */
export class PremProvider implements ProviderInterface {
  /** Provider instance identifier (always `'prem'`). */
  readonly id: string = 'prem';

  /** Credential id resolved through the injected resolver, when supplied. */
  readonly credentialId?: string;

  /** Injected credential resolver used for dynamic API-key/KEK resolution; the `credentialId` lookup (API key and KEK override) requires an injected `vault` — without one, `credentialId` is ignored. */
  readonly vault?: CredentialResolverPort | null;

  #client: any = null;

  #apiKey: string | undefined;

  #clientKEK: string | undefined;

  #gatewayUrl: string;

  /**
   * Constructs a Prem provider.
   *
   * `options` may be a legacy bare API-key string (KEK argument applied as-is,
   * defaulting to the module KEK) or a {@link PremProviderOptions} bag. In the
   * bag form, a malformed non-64-hex `clientKEK` is preserved verbatim (only a
   * missing/empty value falls back to `getDefaultClientKEK()`), and the gateway
   * URL is trimmed of trailing slashes.
   *
   * @param options - Options bag or legacy API key.
   * @param clientKEK - Legacy KEK argument (string form only).
   */
  constructor(options: PremProviderOptions | string, clientKEK?: string) {
    if (typeof options === 'string') {
      this.#apiKey = options;
      this.#clientKEK = clientKEK || getDefaultClientKEK();
      this.#gatewayUrl = 'https://gateway.prem.io';
      this.#client = null;
    } else {
      this.#client = options.client || null;
      this.credentialId = options.credentialId;
      this.vault = options.vault;
      this.#apiKey = options.apiKey || '';
      this.#clientKEK = typeof options.clientKEK === 'string' && /^[0-9a-fA-F]{64}$/.test(options.clientKEK)
        ? options.clientKEK
        : (options.clientKEK || getDefaultClientKEK());
      this.#gatewayUrl = (options.gatewayUrl || 'https://gateway.prem.io').replace(/\/+$/, '');
    }
  }

  /**
   * Resolves the effective API key: explicit `credentialId` + `vault` lookup
   * first, then the directly supplied key, then the vault's active credential
   * for the `prem` provider; empty string when nothing resolves.
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
   * Resolves the effective client KEK: a 64-hex `encryptionKey` from the
   * credential referenced by `credentialId` wins when `vault` is injected and
   * the lookup yields one, otherwise the construction KEK (or empty string).
   */
  getEffectiveClientKEK(): string {
    if (this.credentialId && this.vault) {
      const cred = this.vault.getCredential(this.credentialId);
      if (cred?.encryptionKey && /^[0-9a-fA-F]{64}$/.test(cred.encryptionKey)) {
        return cred.encryptionKey;
      }
    }
    return this.#clientKEK || '';
  }

  /**
   * Lazily resolves the enclave client through the module-level cache: an
   * injected `client` wins, otherwise `getPremEnclaveClient` is called with the
   * credential id (or `apiKey:clientKEK`) as the cache key. The resolved client
   * is memoized on the instance.
   *
   * @throws An `Error` when no Prem API key can be resolved.
   */
  async getClient(): Promise<any> {
    if (this.#client) {
      return this.#client;
    }

    const key = this.getEffectiveApiKey();
    if (!key) {
      throw new Error('No Prem API key provided.');
    }

    const kek = this.getEffectiveClientKEK();
    const cacheKey = this.credentialId || `${key}:${kek}`;

    this.#client = await getPremEnclaveClient(cacheKey, {
      apiKey: key,
      clientKEK: kek,
      gatewayUrl: this.#gatewayUrl
    });

    return this.#client;
  }

  /**
   * Creates a Prem model bound to this provider.
   *
   * @param modelId - Resolved model id (required; no transport default).
   * @param config - Model-bound configuration; defaults to `{}`.
   * @returns A {@link PremModel} bound to this provider.
   * @throws A `TypeError` when `modelId` is falsy.
   */
  createModel(modelId: string, config: ModelConfig = {}): ModelInterface {
    return new PremModel(this, modelId, config);
  }

  /**
   * Discovers chat models from the configured gateway's `/rvenc/models`
   * endpoint (default gateway `https://gateway.prem.io`).
   *
   * @param options - Abort signal for the request.
   * @returns Discovered chat model descriptors.
   * @throws An `InferenceError` (`status`, `ERR_HTTP_<status>`, `details`, `retryable`) on non-OK HTTP responses.
   */
  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelDescriptor[]> {
    const key = this.getEffectiveApiKey();
    const targetUrl = `${this.#gatewayUrl}/rvenc/models`;
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json'
      },
      signal: options.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const message = `Prem listModels error (${response.status}): ${errText || response.statusText}`;
      throw new InferenceError(message, {
        code: `ERR_HTTP_${response.status}`,
        status: response.status,
        details: { providerId: this.id, endpoint: targetUrl },
        retryable: defaultIsRetryable({ status: response.status, message })
      });
    }

    const json = await response.json();
    const list = (Array.isArray(json?.data) ? json.data : []) as WirePremModel[];

    const chatModels: ModelDescriptor[] = list
      .filter(m => !m.type || m.type === 'CHAT')
      .map(m => ({
        id: m.model || String(m.id),
        name: m.name || m.model || String(m.id),
        description: m.description,
        categories: ['Confidential', 'Enclave', ...(m.model?.includes('abliterated') ? ['Abliterated'] : [])],
        pricing: m.price_config?.confidential?.default ? {
          prompt: m.price_config.confidential.default.prompt_price_per_k * 1000,
          completion: m.price_config.confidential.default.completion_price_per_k * 1000
        } : undefined
      }));

    return chatModels;
  }

  /**
   * Prem has no provider-routing hub: always returns an empty array.
   *
   * @param modelId - Ignored model id.
   * @param options - Ignored options.
   */
  async getProviders(_modelId?: string, _options?: { signal?: AbortSignal }): Promise<ProviderRoute[] | string[]> {
    void _modelId;
    void _options;
    return [];
  }

  /**
   * Balance lookup is unsupported for the enclave: never throws and always
   * resolves to `{ available: false, balance: null }`.
   *
   * @param options - Ignored options.
   */
  async checkBalance(_options?: { signal?: AbortSignal }): Promise<BalanceResult> {
    void _options;
    return { available: false, balance: null };
  }
}
