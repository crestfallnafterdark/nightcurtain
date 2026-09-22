/**
 * @packageDocumentation
 * Transport contract for the NanoGPT adapter: construction options and the
 * public surface of `NanoGptProvider`.
 *
 * NanoGPT transport wrapper: composes the OpenAI-compatible adapter for chat
 * completions, streaming, and tool calls, and adds the distinct NanoGPT
 * surface — model catalog (`/api/models`), upstream route discovery
 * (`/api/models/:canonicalId/providers`), and credit balance lookup
 * (`POST /api/check-balance`).
 *
 * Runtime implementation: `NanoGptProvider/index.ts`.
 *
 * Encapsulation: only the public surface is declared. Runtime-only `#`-private
 * members (`openAi`, `baseUrl`, `getEffectiveBase`) are intentionally omitted
 * from this contract.
 *
 * @module inference/NanoGptProvider
 * @mayImport ../OpenAIProvider/index.ts
 * @mayImport type-only ../ProviderInterface/index.ts
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant `listModels()` reads the distinct NanoGPT catalog at `/api/models` and falls back to the composed adapter's OpenAI-compatible `/v1/models` listing on a non-OK response, an empty catalog, or a fetch error; a non-OK fallback listing rejects with an `InferenceError`.
 * @invariant `getProviders()` trims and URL-encodes the model id, queries `/api/models/:canonicalId/providers`, and resolves to `[]` without a request for a blank id, and on a non-OK response, fetch error, JSON-parse error, or a payload without a `providers` array; an id that cannot be URL-encoded (a lone UTF-16 surrogate) rejects with a `URIError`.
 * @invariant `getProviders` is the only real upstream route-discovery implementation among the transport adapters; the composed OpenAI, DeepSeek, Runware, and Prem adapters stub it to an empty list.
 * @invariant `checkBalance()` never throws on HTTP failure: a missing key, non-OK response, or fetch error resolves to `{ available: false, balance: null, error }`.
 */

import type {
  ProviderInterface,
  ModelInterface,
  ModelConfig,
  ModelDescriptor,
  ProviderRoute,
  BalanceResult,
  CredentialResolverPort
} from '../ProviderInterface/index.ts';
import { OpenAIProvider } from '../OpenAIProvider/index.ts';

/**
 * Construction options for {@link NanoGptProvider}.
 *
 * Credential precedence, highest first:
 * 1. the `credentialId` resolved through the injected `vault`
 *    (`vault.getCredential`), when that lookup yields a non-empty `apiKey`;
 * 2. the explicit `apiKey`;
 * 3. the vault's active credential for the provider id
 *    (`vault.getActiveCredential('nanogpt')`).
 *
 * The `credentialId` lookup requires a non-null `vault`; `apiUrl` overrides the
 * vendor endpoint default and trailing slashes are trimmed.
 */
export interface NanoGptProviderOptions {
  /** Pre-resolved API key. */
  apiKey?: string;
  /** NanoGPT base URL override (e.g. `https://nano-gpt.com`). */
  apiUrl?: string;
  /** Credential id looked up through `vault.getCredential`; requires an injected non-null `vault`. */
  credentialId?: string;
  /** Injected credential resolver; when absent or `null`, `credentialId` is ignored and no vault lookup occurs. */
  vault?: CredentialResolverPort | null;
}

/**
 * Wire shape of one NanoGPT catalog entry from `/api/models` (`models.text`).
 *
 * Fields are permissive because the catalog mixes numeric and string
 * context/pricing values; vendor extras ride along untyped.
 */
interface NanoGptCatalogModel {
  /** Model identifier; falls back to the catalog key. */
  model?: string;
  /** Display name. */
  name?: string;
  /** Descriptive model summary. */
  description?: string;
  /** Provider-reported cost string. */
  cost?: string;
  /** Context window under any of the catalog's field aliases. */
  maxInputTokens?: number | string;
  /** Alternate context-window field. */
  context_length?: number | string;
  /** Alternate context-window field. */
  contextLength?: number | string;
  /** Category label used when `tags` is absent. */
  category?: string;
  /** Category tags. */
  tags?: string[];
  /** Structured pricing block. */
  pricing?: {
    /** Prompt price per million tokens. */
    prompt_per_million?: number | string;
    /** Completion price per million tokens. */
    completion_per_million?: number | string;
    /** Additional vendor pricing fields. */
    [key: string]: unknown;
  } | null;
  /** Flat prompt price per million tokens. */
  input_price_per_million?: number | string;
  /** Flat completion price per million tokens. */
  output_price_per_million?: number | string;
  /** Alternate flat input price. */
  input?: number | string;
  /** Alternate flat output price. */
  output?: number | string;
}

/**
 * Per-1k-token price block reported under `pricing`/`effectivePricing`.
 */
interface NanoGptRoutePricing {
  /** Input price per 1k tokens. */
  inputPer1kTokens?: number;
  /** Output price per 1k tokens. */
  outputPer1kTokens?: number;
  /** Additional vendor pricing fields. */
  [key: string]: unknown;
}

/**
 * Wire shape of one upstream route entry from
 * `/api/models/:canonicalId/providers` (`providers[]`).
 */
interface NanoGptRouteEntry {
  /** Upstream provider identifier. */
  provider?: string;
  /** Whether the route is currently available. */
  available?: boolean;
  /** Context window served by this route. */
  maxInputTokens?: number | string;
  /** Quantization label of the served weights. */
  quantization?: string;
  /** Observed tokens per second. */
  tps?: number;
  /** Flat pricing block. */
  pricing?: NanoGptRoutePricing | null;
  /** Alternative pricing block with effective/list price variants. */
  effectivePricing?: {
    /** Effective price variant. */
    effective_price?: NanoGptRoutePricing;
    /** List price variant. */
    list_price?: NanoGptRoutePricing;
  } | null;
}

/**
 * NanoGPT Provider.
 *
 * Composes the OpenAI-compatible adapter for chat completions, streaming, and
 * tool calls, and adds the distinct NanoGPT model catalog (`/api/models`),
 * upstream route discovery (`/api/models/:canonicalId/providers`), and credit
 * balance lookup (`POST /api/check-balance`).
 */
export class NanoGptProvider implements ProviderInterface {
  /** Provider instance identifier (`'nanogpt'`). */
  readonly id = 'nanogpt';

  /** Composed OpenAI-compatible adapter handling chat completions, streaming, and tool calls. */
  #openAi: OpenAIProvider;

  /** Configured NanoGPT base URL (trailing slashes trimmed, without `/api/v1`). */
  #baseUrl: string;

  /**
   * Constructs the wrapper from an options object.
   *
   * @param options - Construction options; the base URL comes from `options.apiUrl`.
   * @param apiUrl - Ignored in this form; use `options.apiUrl`. The legacy
   *   positional overload consumes the second argument instead.
   */
  constructor(options: NanoGptProviderOptions, apiUrl?: string);

  /**
   * Constructs the wrapper from the legacy positional form, where the first
   * argument is a bare API key.
   *
   * @param apiKey - Pre-resolved API key.
   * @param apiUrl - Optional base URL override (defaults to `https://nano-gpt.com`).
   */
  constructor(apiKey: string, apiUrl?: string);

  /**
   * Constructs the wrapper from an options object or the legacy positional
   * form, where the first argument is a bare API key.
   *
   * The composed OpenAI-compatible adapter targets the NanoGPT base URL with
   * an `/api/v1` suffix (added only when not already present).
   *
   * @param options - Construction options, or a bare API key (legacy positional form).
   * @param apiUrl - Base URL override used by the legacy positional form.
   */
  constructor(options: NanoGptProviderOptions | string, apiUrl = 'https://nano-gpt.com') {
    const opts: NanoGptProviderOptions = typeof options === 'string' ? { apiKey: options, apiUrl } : options;
    this.#baseUrl = (opts.apiUrl || 'https://nano-gpt.com').replace(/\/+$/, '');

    const openAiUrl = this.#baseUrl.endsWith('/api/v1')
      ? this.#baseUrl
      : `${this.#baseUrl}/api/v1`;

    this.#openAi = new OpenAIProvider({
      apiUrl: openAiUrl,
      apiKey: opts.apiKey,
      credentialId: opts.credentialId,
      vault: opts.vault,
      id: 'nanogpt'
    });
  }

  /**
   * Factory method to instantiate and configure a Model.
   *
   * @param modelId - Model identifier bound to the new instance.
   * @param config - Model-bound configuration; defaults to `{}` and is shallow-frozen by the model.
   * @returns A new model instance bound to the composed OpenAI-compatible adapter.
   */
  createModel(modelId: string, config: ModelConfig = {}): ModelInterface {
    return this.#openAi.createModel(modelId, config);
  }

  /**
   * Derives the NanoGPT API base from the composed adapter's effective URL,
   * stripping a trailing `/api/v1` suffix.
   *
   * @returns Effective NanoGPT base URL (without `/api/v1`).
   */
  #getEffectiveBase(): string {
    const fromOpenAi = this.#openAi.getEffectiveApiUrl();
    if (fromOpenAi) {
      return fromOpenAi.endsWith('/api/v1') ? fromOpenAi.slice(0, -'/api/v1'.length) : fromOpenAi;
    }
    return this.#baseUrl;
  }

  /**
   * Lists models from the NanoGPT catalog at `/api/models`, normalizing
   * context lengths, pricing, and categories.
   *
   * Falls back to the composed adapter's OpenAI-compatible `/v1/models`
   * listing when the catalog response is non-OK, the request throws, or the
   * catalog contains no text models; the fallback receives the same `options`.
   *
   * @param options - Optional abort signal forwarded to the catalog request.
   * @returns Normalized model descriptors: catalog results, or the fallback listing.
   * @throws An `InferenceError` when the catalog request fails and the fallback
   *   `/v1/models` listing responds with a non-OK status (`status`,
   *   `ERR_HTTP_<status>`, endpoint `details`, and `retryable` from the shared
   *   retry classifier); catalog failures alone never throw.
   */
  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelDescriptor[]> {
    const key = this.#openAi.getEffectiveApiKey();
    const base = this.#getEffectiveBase();
    const targetUrl = `${base}/api/models`;
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
        // Fallback to OpenAI-compatible /v1/models if /api/models fails
        return this.#openAi.listModels(options);
      }

      const json = await response.json();
      const textModels = (json?.models?.text || {}) as Record<string, NanoGptCatalogModel>;
      const results: ModelDescriptor[] = [];

      for (const [keyName, m] of Object.entries(textModels)) {
        const id = m.model || keyName;
        const maxInput = m.maxInputTokens || m.context_length || m.contextLength;
        let formattedCtx: string | undefined;
        if (typeof maxInput === 'number') {
          formattedCtx = maxInput >= 1000000 ? `${(maxInput / 1000000).toFixed(0)}M` : (maxInput >= 1000 ? `${Math.round(maxInput / 1000)}k` : `${maxInput}`);
        } else if (maxInput) {
          formattedCtx = String(maxInput);
        }

        const promptPrice = m.pricing?.prompt_per_million ?? m.input_price_per_million ?? m.input;
        const compPrice = m.pricing?.completion_per_million ?? m.output_price_per_million ?? m.output;

        let costStr = m.cost || '';
        if (!costStr && (promptPrice !== undefined || compPrice !== undefined)) {
          costStr = `In: $${promptPrice ?? 0}/M • Out: $${compPrice ?? 0}/M`;
        }

        results.push({
          id,
          name: m.name || id,
          description: m.description,
          contextLength: formattedCtx,
          maxInputTokens: typeof maxInput === 'number' ? maxInput : undefined,
          cost: costStr,
          categories: Array.isArray(m.tags) ? m.tags : (m.category ? [m.category] : []),
          pricing: m.pricing ? {
            prompt: promptPrice ? parseFloat(String(promptPrice)) : undefined,
            completion: compPrice ? parseFloat(String(compPrice)) : undefined,
            ...m.pricing
          } : undefined,
          raw: m
        });
      }

      return results.length > 0 ? results : this.#openAi.listModels(options);
    } catch {
      return this.#openAi.listModels(options);
    }
  }

  /**
   * Lists upstream provider routes for a model id via
   * `/api/models/:canonicalId/providers`, trimming and URL-encoding the id.
   *
   * Resolves to `[]` for a blank or whitespace-only id (without a request), a
   * non-OK response, a request error, an unparseable response body, or a
   * payload without a `providers` array.
   *
   * @param modelId - Canonical model id to query; omitted or blank short-circuits to `[]`.
   * @param options - Optional abort signal forwarded to the request.
   * @returns Normalized routes, or an empty array.
   * @throws A `URIError` when the trimmed id cannot be URL-encoded (a lone
   *   UTF-16 surrogate); encoding runs before the request's error handling.
   */
  async getProviders(modelId?: string, options: { signal?: AbortSignal } = {}): Promise<ProviderRoute[]> {
    if (!modelId || !modelId.trim()) {
      return [];
    }

    const key = this.#openAi.getEffectiveApiKey();
    const base = this.#getEffectiveBase();
    const encodedModel = encodeURIComponent(modelId.trim());
    const targetUrl = `${base}/api/models/${encodedModel}/providers`;

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
        return [];
      }

      const json = await response.json();
      const providersList = (Array.isArray(json?.providers) ? json.providers : []) as NanoGptRouteEntry[];

      return providersList.map(p => {
        const id = p.provider || String(p);
        const maxInput = p.maxInputTokens;
        let formattedCtx: string | undefined;
        if (typeof maxInput === 'number') {
          formattedCtx = maxInput >= 1000000 ? `${(maxInput / 1000000).toFixed(0)}M` : (maxInput >= 1000 ? `${Math.round(maxInput / 1000)}k` : `${maxInput}`);
        } else if (maxInput) {
          formattedCtx = String(maxInput);
        }

        const pPricing = p.pricing || p.effectivePricing?.effective_price || p.effectivePricing?.list_price;
        let costStr = '';
        if (pPricing && (pPricing.inputPer1kTokens !== undefined || pPricing.outputPer1kTokens !== undefined)) {
          const inM = pPricing.inputPer1kTokens !== undefined ? (pPricing.inputPer1kTokens * 1000).toFixed(2) : '0.00';
          const outM = pPricing.outputPer1kTokens !== undefined ? (pPricing.outputPer1kTokens * 1000).toFixed(2) : '0.00';
          costStr = `In: $${inM}/M • Out: $${outM}/M`;
        }

        return {
          id,
          name: id,
          status: p.available === false ? 'unavailable' : 'available',
          available: p.available !== false,
          contextLength: formattedCtx,
          maxInputTokens: typeof maxInput === 'number' ? maxInput : undefined,
          cost: costStr,
          pricing: pPricing,
          tps: typeof p.tps === 'number' ? Math.round(p.tps * 10) / 10 : undefined,
          quantization: p.quantization,
          raw: p
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Looks up credit balance via `POST /api/check-balance`.
   *
   * Never rejects on HTTP failure. A missing effective API key resolves to
   * `{ available: false, balance: null, error }` without a request; a non-OK
   * response or request/parse error resolves to the same shape. Success resolves
   * to `{ available: true, balance, currency: 'USD', formatted, raw }`, where
   * `balance` is `usd_balance` coerced to a number (`NaN` when unparseable) and
   * `formatted` renders such a value as `$0.00`.
   *
   * @param options - Optional abort signal forwarded to the request.
   * @returns Balance result (see {@link BalanceResult}).
   */
  async checkBalance(options: { signal?: AbortSignal } = {}): Promise<BalanceResult> {
    const key = this.#openAi.getEffectiveApiKey();
    if (!key) {
      return { available: false, balance: null, error: 'No API key provided' };
    }

    const base = this.#getEffectiveBase();
    const targetUrl = `${base}/api/check-balance`;
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
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
      const rawUsd = data.usd_balance;
      const numBalance = typeof rawUsd === 'number' ? rawUsd : parseFloat(rawUsd || '0');

      return {
        available: true,
        balance: numBalance,
        currency: 'USD',
        formatted: `$${isNaN(numBalance) ? '0.00' : numBalance.toFixed(2)}`,
        raw: data
      };
    } catch (err) {
      const message = (err as { message?: unknown } | null | undefined)?.message;
      return {
        available: false,
        balance: null,
        error: typeof message === 'string' && message ? message : 'Failed to fetch NanoGPT balance'
      };
    }
  }
}
