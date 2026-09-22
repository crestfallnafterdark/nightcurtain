/**
 * @packageDocumentation
 * MOD-15 transport contract for the DeepSeek adapter: construction
 * options and the public surface of `DeepSeekProvider`.
 *
 * DeepSeek transport adapter: composes `OpenAIProvider` for models,
 * streaming, and completions, and adds the native DeepSeek
 * `/user/balance` lookup. The base-URL resolution and `/v1` suffixing logic
 * are kept as-is (a possible base-vs-full-path shape issue is intentionally
 * not fixed here).
 *
 * Encapsulation: only the public surface is exported. Runtime-only `#`-private
 * members (`openAi`, `baseUrl`) are intentionally absent from the public
 * surface; `fetch` is confined to this adapter file, and no settings,
 * credential singletons, or ambient UI globals are accessed.
 *
 * @module inference/DeepSeekProvider
 * @mayImport ../OpenAIProvider/index.ts
 * @mayImport type-only ../ProviderInterface/index.ts
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant Credentials resolve through the composed `OpenAIProvider` with provider id `'deepseek'`: a `credentialId` that resolves through `vault` to a non-empty `apiKey` wins over the explicit `apiKey`; otherwise the explicit `apiKey` applies, with `vault.getActiveCredential('deepseek')` as the final fallback; no credential singleton is imported.
 * @invariant Constructor `apiUrl` handling: trailing slashes are trimmed, then `/v1` is appended unless the trimmed URL already ends with `/v1` (default `https://api.deepseek.com`).
 * @invariant `getProviders()` always resolves to an empty array; DeepSeek exposes no separate routing list.
 * @invariant `checkBalance()` never throws on HTTP or network failure and instead resolves to `{ available: false, balance: null, error }`.
 */

import { OpenAIProvider } from '../OpenAIProvider/index.ts';
import type {
  ProviderInterface,
  ModelInterface,
  ModelConfig,
  ModelDescriptor,
  ProviderRoute,
  BalanceResult,
  CredentialResolverPort
} from '../ProviderInterface/index.ts';

/**
 * Construction options for {@link DeepSeekProvider}.
 *
 * `apiUrl` overrides the DeepSeek endpoint default (`https://api.deepseek.com`);
 * trailing slashes are trimmed and `/v1` is appended unless already present.
 * Credentials follow the composed `OpenAIProvider` precedence: a `credentialId`
 * that resolves through `vault` to a non-empty `apiKey` wins over the explicit
 * `apiKey`; otherwise the explicit `apiKey` applies, with the vault's active
 * credential for provider id `'deepseek'` as the final fallback.
 */
export interface DeepSeekProviderOptions {
  /** Pre-resolved API key. */
  apiKey?: string;
  /** Base API URL override (e.g. `https://api.deepseek.com`). */
  apiUrl?: string;
  /** Credential id looked up through `vault.getCredential`; requires a non-null `vault` and is ignored otherwise. */
  credentialId?: string;
  /** Injected credential resolver used for two lookups: `getCredential(credentialId)` first, then `getActiveCredential('deepseek')`; a `credentialId` resolves only when this is supplied. */
  vault?: CredentialResolverPort | null;
}

/**
 * DeepSeek Provider
 * Composes OpenAIProvider for models, streaming, and completions.
 * Implements native DeepSeek /user/balance lookup.
 *
 * The constructor accepts either a {@link DeepSeekProviderOptions} object or a
 * bare API key string (legacy shorthand).
 */
export class DeepSeekProvider implements ProviderInterface {
  /** Provider instance identifier (always `'deepseek'`). */
  readonly id: string = 'deepseek';

  /** Composed OpenAI-compatible transport used for model, streaming, and completion calls. */
  #openAi: OpenAIProvider;

  /** DeepSeek base URL with trailing slashes trimmed (before `/v1` suffixing). */
  #baseUrl: string;

  /**
   * Constructs a DeepSeek provider from an options object.
   *
   * @param options - Construction options.
   */
  constructor(options: DeepSeekProviderOptions);

  /**
   * Constructs a DeepSeek provider from a bare API key (legacy shorthand).
   *
   * @param apiKey - Pre-resolved API key.
   */
  constructor(apiKey: string);

  constructor(options: DeepSeekProviderOptions | string) {
    const opts: DeepSeekProviderOptions = typeof options === 'string' ? { apiKey: options } : options;
    const apiUrl = opts.apiUrl || 'https://api.deepseek.com';
    this.#baseUrl = apiUrl.replace(/\/+$/, '');

    const v1Url = this.#baseUrl.endsWith('/v1') ? this.#baseUrl : `${this.#baseUrl}/v1`;
    this.#openAi = new OpenAIProvider({
      apiUrl: v1Url,
      apiKey: opts.apiKey,
      credentialId: opts.credentialId,
      vault: opts.vault,
      id: 'deepseek'
    });
  }

  /**
   * Factory method to instantiate and configure a Model.
   *
   * @param modelId - Model identifier.
   * @param config - Model-bound configuration; defaults to `{}` and is frozen by the created model.
   * @returns A configured model instance bound to this provider.
   */
  createModel(modelId: string, config: ModelConfig = {}): ModelInterface {
    return this.#openAi.createModel(modelId, config);
  }

  /**
   * Lists models through the composed OpenAI-compatible provider.
   *
   * @param options - Optional abort signal propagated to the request.
   * @returns Normalized model descriptors from the composed `/models` listing.
   * @throws An `InferenceError` (`status`, `ERR_HTTP_<status>`, endpoint
   *   `details`, `retryable` from the shared retry classifier) when the
   *   endpoint responds with a non-OK status; network failures reject with the
   *   underlying fetch error.
   */
  listModels(options?: { signal?: AbortSignal }): Promise<ModelDescriptor[]> {
    return this.#openAi.listModels(options);
  }

  /**
   * DeepSeek exposes no separate routing list (always empty).
   *
   * @param _modelId - Ignored; accepted for interface parity.
   * @param _options - Ignored; accepted for interface parity.
   * @returns A promise resolving to an empty array.
   */
  getProviders(_modelId?: string, _options?: { signal?: AbortSignal }): Promise<ProviderRoute[] | string[]> {
    void _modelId;
    void _options;
    return Promise.resolve([]);
  }

  /**
   * Looks up the native `/user/balance` endpoint; never throws on HTTP failure.
   *
   * Resolves to `{ available: false, balance: null, error }` when no API key
   * resolves, the response is non-OK, or the fetch/body read fails. On success,
   * `is_available` maps to `available`, the first `balance_infos` entry supplies
   * `currency` (default `USD`) and `balance` (default `'0.00'`), `formatted`
   * prefixes `¥` for CNY and `$` otherwise, and `raw` retains the provider
   * payload.
   *
   * @param options - Optional abort signal propagated to the request.
   * @returns Balance lookup result, or the failure result described above.
   */
  async checkBalance(options: { signal?: AbortSignal } = {}): Promise<BalanceResult> {
    const key = this.#openAi.getEffectiveApiKey();
    if (!key) {
      return { available: false, balance: null, error: 'No API key provided' };
    }

    const effectiveBase = this.#openAi.getEffectiveApiUrl() || this.#baseUrl;
    const cleanBase = effectiveBase.endsWith('/v1') ? effectiveBase.slice(0, -3) : effectiveBase;
    const targetUrl = `${cleanBase}/user/balance`;
    try {
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
        return {
          available: false,
          balance: null,
          error: `HTTP ${response.status}: ${errText || response.statusText}`
        };
      }

      const data = await response.json();
      const info = data.balance_infos?.[0];
      const currency = info?.currency || 'USD';
      const balance = info?.total_balance ?? '0.00';
      const symbol = currency === 'CNY' ? '¥' : '$';

      return {
        available: Boolean(data.is_available),
        balance,
        currency,
        formatted: `${symbol}${balance}`,
        raw: data
      };
    } catch (err) {
      const message = (err as { message?: unknown } | null | undefined)?.message;
      return {
        available: false,
        balance: null,
        error: typeof message === 'string' && message ? message : 'Failed to fetch DeepSeek balance'
      };
    }
  }
}
