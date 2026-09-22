/**
 * @packageDocumentation
 * MOD-15 transport contract for the Runware adapter: construction
 * options and the public surface of `RunwareProvider`.
 *
 * Runware transport adapter: composes the OpenAI-compatible adapter for
 * models, streaming, and completions, and implements Runware's
 * `accountManagement/getDetails` balance retrieval.
 *
 * Encapsulation: only the public surface is declared. Runtime-only `#`-private
 * members (`openAi`, `baseUrl`) are intentionally absent from this contract;
 * `fetch` is confined to this adapter file, and no settings, credential
 * singletons, or ambient UI globals are accessed.
 *
 * @module inference/RunwareProvider
 * @mayImport ../OpenAIProvider/index.ts
 * @mayImport type-only ../ProviderInterface/index.ts
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant Credential resolution is inherited from the composed `OpenAIProvider`, highest precedence first: a `credentialId` that resolves through `vault` to a non-empty `apiKey` wins over the explicit `apiKey`; `vault.getActiveCredential('runware')` is the final fallback; no credential singleton is imported.
 * @invariant `getProviders()` always resolves to an empty array — the adapter exposes no separate routing-list surface.
 * @invariant `checkBalance()` never throws on HTTP failure — it resolves to `{ available: false, error }` instead.
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
 * Construction options for {@link RunwareProvider}.
 *
 * `apiUrl` overrides the Runware v1 endpoint default and trailing slashes are
 * trimmed. Credentials are resolved by the composed OpenAI-compatible adapter,
 * highest precedence first: a `credentialId` that resolves through `vault` to
 * a non-empty `apiKey` wins over the explicit `apiKey`; the vault's active
 * credential for `'runware'` (`vault.getActiveCredential`) is the final
 * fallback.
 */
export interface RunwareProviderOptions {
  /** Pre-resolved API key. */
  apiKey?: string;
  /** Base API URL override (defaults to `https://api.runware.ai/v1`). */
  apiUrl?: string;
  /** Credential id resolved through `vault.getCredential`. */
  credentialId?: string;
  /** Injected credential lookup port; without it, only the explicit `apiKey` can supply a key. */
  vault?: CredentialResolverPort | null;
}

/**
 * Runware Provider
 * Composes OpenAIProvider for models, streaming, and completions.
 * Implements Runware accountManagement getDetails balance retrieval.
 *
 * The constructor accepts either a {@link RunwareProviderOptions} object or a
 * bare API key string.
 */
export class RunwareProvider implements ProviderInterface {
  /** Provider instance identifier (always `'runware'`). */
  readonly id: string = 'runware';

  /** Composed OpenAI-compatible adapter. */
  #openAi: OpenAIProvider;

  /** Trimmed base API URL used as the balance-request fallback. */
  #baseUrl: string;

  /**
   * Constructs a provider from an options object.
   *
   * @param options - Construction options.
   */
  constructor(options: RunwareProviderOptions);

  /**
   * Constructs a provider from a bare API key.
   *
   * @param apiKey - Pre-resolved API key.
   */
  constructor(apiKey: string);

  /**
   * Constructs the adapter from an options object or a bare API key. The base
   * URL defaults to the Runware v1 endpoint and trailing slashes are trimmed.
   *
   * @param options - Options object, or API key.
   */
  constructor(options: RunwareProviderOptions | string) {
    const opts: RunwareProviderOptions = typeof options === 'string' ? { apiKey: options } : options;
    const apiUrl = opts.apiUrl || 'https://api.runware.ai/v1';
    this.#baseUrl = apiUrl.replace(/\/+$/, '');

    this.#openAi = new OpenAIProvider({
      apiUrl: this.#baseUrl,
      apiKey: opts.apiKey,
      credentialId: opts.credentialId,
      vault: opts.vault,
      id: 'runware'
    });
  }

  /**
   * Factory method to instantiate and configure a Model through the
   * OpenAI-compatible adapter.
   *
   * @param modelId - Model identifier.
   * @param config - Optional model-bound configuration (defaults to `{}`).
   * @returns Model instance bound to the composed OpenAI-compatible adapter.
   */
  createModel(modelId: string, config: ModelConfig = {}): ModelInterface {
    return this.#openAi.createModel(modelId, config);
  }

  /**
   * Lists models through the composed OpenAI-compatible adapter.
   *
   * @param options - Optional abort signal forwarded to the request.
   * @returns Normalized model descriptors, with context lengths and pricing
   *   rendered as display strings when the endpoint reports them.
   * @throws An `InferenceError` (`status`, `ERR_HTTP_<status>`, endpoint
   *   `details`, `retryable` from the shared retry classifier) when the
   *   endpoint responds with a non-OK status; network/abort failures propagate
   *   as the underlying fetch error.
   */
  listModels(options?: { signal?: AbortSignal }): Promise<ModelDescriptor[]> {
    return this.#openAi.listModels(options);
  }

  /**
   * Runware exposes no separate routing list (always empty).
   *
   * @param _modelId - Ignored; kept for interface parity.
   * @param _options - Ignored; kept for interface parity.
   * @returns A promise that always resolves to an empty array.
   */
  getProviders(_modelId?: string, _options?: { signal?: AbortSignal }): Promise<ProviderRoute[] | string[]> {
    void _modelId;
    void _options;
    return Promise.resolve([]);
  }

  /**
   * Retrieves the Runware account balance via an `accountManagement`
   * `getDetails` task-array request. Never throws on HTTP failure: resolves to
   * `{ available: false, error }` instead.
   *
   * The effective key and base URL are resolved through the composed
   * OpenAI-compatible adapter; a `/chat/completions` suffix on the effective
   * URL is stripped. Preserved subtleties: the guarded
   * `typeof crypto !== 'undefined'` UUID generation, numeric/object/string
   * balance coercion, and the contract that this method never throws on HTTP
   * failure.
   *
   * @param options - Optional abort signal forwarded to the request; an
   *   aborted request resolves to an unavailable result rather than rejecting.
   * @returns Balance lookup result: on success `{ available: true, balance, currency, formatted }`;
   *   on failure `{ available: false, balance: null, error }`. This method never rejects.
   */
  async checkBalance(options: { signal?: AbortSignal } = {}): Promise<BalanceResult> {
    const key = this.#openAi.getEffectiveApiKey();
    if (!key) {
      return { available: false, balance: null, error: 'No API key provided' };
    }

    const effectiveBase = this.#openAi.getEffectiveApiUrl() || this.#baseUrl;
    const cleanBase = effectiveBase.endsWith('/chat/completions')
      ? effectiveBase.slice(0, -'/chat/completions'.length)
      : effectiveBase;

    const taskUUID = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `rw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    try {
      const response = await fetch(cleanBase, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          {
            taskType: 'accountManagement',
            taskUUID,
            operation: 'getDetails'
          }
        ]),
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

      const json = await response.json();
      const item = Array.isArray(json?.data) ? json.data[0] : null;

      if (!item || item.balance === undefined) {
        return {
          available: false,
          balance: null,
          error: 'Invalid balance response received from Runware'
        };
      }

      const rawBalance = item.balance;
      let amount = 0;
      let currency = 'USD';

      if (typeof rawBalance === 'number') {
        amount = rawBalance;
      } else if (rawBalance && typeof rawBalance === 'object') {
        amount = typeof rawBalance.amount === 'number' ? rawBalance.amount : parseFloat(rawBalance.amount || '0');
        if (rawBalance.currency) currency = rawBalance.currency;
      } else if (typeof rawBalance === 'string') {
        amount = parseFloat(rawBalance);
      }

      return {
        available: true,
        balance: amount,
        currency,
        formatted: `$${isNaN(amount) ? '0.00' : amount.toFixed(2)}`
      };
    } catch (err) {
      const message = (err as { message?: unknown } | null | undefined)?.message;
      return {
        available: false,
        balance: null,
        error: typeof message === 'string' && message ? message : 'Failed to fetch Runware balance'
      };
    }
  }
}
