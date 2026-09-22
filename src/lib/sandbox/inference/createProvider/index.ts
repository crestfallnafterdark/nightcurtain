/**
 * @packageDocumentation
 * Provider factory: instantiates the appropriate concrete transport adapter from
 * an `AgentModelConfig` or a vendor identifier.
 *
 * Runtime port of the retired `src/lib/inference/` tree with behavior
 * preserved, **except** the credential-injection change: the
 * `../utils/credentialVault.js` singleton import and default parameter are
 * removed. Credentials resolve exclusively through the optional injected
 * `CredentialResolverPort`; when no resolver is supplied they resolve to
 * nothing — there is no singleton fallback.
 *
 * Dual-mode `optionsOrKeyStore` (preserved):
 * - Object config branch: treated as a credential resolver when it duck-types
 *   a callable `getCredential`; otherwise no vault is attached (the resolver is
 *   forwarded to the adapter as its `vault` option for `credentialId`/active
 *   lookup).
 * - Vendor string branch: a non-resolver object is the `CreateProviderOptions`
 *   bag; a resolver is ignored and the bag defaults to `{}`.
 *
 * KeyId-only config branch (ticket a464f2a): an `AgentModelConfig` carries a
 * `keyId` reference and no raw secret material, so the branch never reads
 * `apiKey`/`encryptionKey` fields from the config object. The credential
 * resolved through the injected resolver (pinned `keyId`, else the provider's
 * active credential) is the sole key/KEK source, and it is forwarded to the
 * adapter as `credentialId` + `vault` for per-request resolution. Raw-secret
 * passthrough is confined to the vendor-string `CreateProviderOptions` bag.
 *
 * Encapsulation: the five sibling provider surfaces are imported (values) plus
 * the vault's `normalizeProviderId` helper for credential/provider matching;
 * `ProviderInterface` types are imported type-only. `fetch` never appears here.
 *
 * @module inference/createProvider
 * @mayImport ../RunwareProvider/index.ts
 * @mayImport ../NanoGptProvider/index.ts
 * @mayImport ../DeepSeekProvider/index.ts
 * @mayImport ../PremProvider/index.ts
 * @mayImport ../OpenAIProvider/index.ts
 * @mayImport ../../credentialVault/index.ts
 * @mayImport type-only ../ProviderInterface/index.ts
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant The credential resolver is duck-typed on a callable `getCredential`: only an object whose `getCredential` is a function is treated as the injected `CredentialResolverPort`; other objects are options bags or ignored, per the dual-mode argument.
 * @invariant A pinned `modelConfig.keyId` is bound only when it resolves and, when the credential exposes `providerId`, belongs to the requested provider; a miss or mismatch falls back to that provider's active credential.
 * @invariant Resolver projections omit `providerId` (least privilege) and are accepted as-is; a credential that does expose `providerId` must match the requested provider, so another provider's key is never silently bound.
 * @invariant The config-object branch is keyId-only: `modelConfig.apiKey`/`modelConfig.encryptionKey` are never read or forwarded; only the credential resolved through the injected `CredentialResolverPort` supplies the key/KEK, and it reaches the adapter as `credentialId` + `vault`.
 * @invariant Unknown vendors fall through to the OpenAI-compatible adapter (documented behavior, preserved).
 * @invariant `createProvider` is fetch-free; transport I/O lives only in the adapter pairs.
 * @decision Credentials are injected only through the `CredentialResolverPort`: the `credentialVault` singleton import and default parameter are removed, and with no resolver supplied credentials resolve to nothing
 */

import type {
  AgentModelConfig,
  BaseProviderOptions,
  CredentialResolverPort,
  ProviderInterface
} from '../ProviderInterface/index.ts';
import { RunwareProvider } from '../RunwareProvider/index.ts';
import { NanoGptProvider } from '../NanoGptProvider/index.ts';
import { DeepSeekProvider } from '../DeepSeekProvider/index.ts';
import { PremProvider } from '../PremProvider/index.ts';
import { OpenAIProvider } from '../OpenAIProvider/index.ts';
import { normalizeProviderId } from '../../credentialVault/index.ts';

/**
 * Construction options for the vendor-string form of {@link createProvider}.
 *
 * Extends {@link BaseProviderOptions} with the Prem client KEK. The
 * vendor-string branch forwards this object to the selected adapter, so vendor
 * extras (`headers`, endpoint overrides, ...) ride along; the `'custom'` and
 * OpenAI-compatible adapters are handed a factory-supplied `id` that overrides
 * any caller value.
 *
 * Raw-secret scope: this direct-adapter options bag is the only factory path
 * that accepts an explicit `apiKey`/`clientKEK`. The config-object branch is
 * keyId-only and ignores those fields on an {@link AgentModelConfig}.
 */
export interface CreateProviderOptions extends BaseProviderOptions {
  /**
   * Prem client-side encryption key. Only a valid 64-hex value is used for
   * enclave-client creation; any other non-empty value is preserved verbatim
   * by the adapter as the construction KEK.
   */
  clientKEK?: string;
  /** Additional adapter-specific options forwarded to the selected provider. */
  [key: string]: unknown;
}

/**
 * Instantiates the appropriate concrete provider based on an
 * {@link AgentModelConfig} object or a vendor identifier.
 *
 * Credential resolution:
 * - `optionsOrKeyStore` is treated as a {@link CredentialResolverPort} when it
 *   duck-types a callable `getCredential` method; otherwise it is an options bag
 *   (vendor-string form) or ignored (config-object form).
 * - When it is absent/undefined, no credentials are resolved — there is no
 *   singleton vault fallback.
 * - A set `modelConfig.keyId` wins only when it resolves and (when the injected
 *   object exposes `providerId`, i.e. a full vault entry) belongs to the
 *   requested provider; a miss or provider mismatch falls back to that
 *   provider's active credential. Resolver projections omit `providerId`
 *   (least privilege), so they are accepted as-is.
 * - A resolved credential's `id` is forwarded as the adapter's `credentialId`
 *   alongside the resolver as its `vault`, so the adapter re-resolves that
 *   credential for each request. The config-object branch is keyId-only: raw
 *   `apiKey`/`encryptionKey` fields on the config object are ignored, and the
 *   resolved credential is the sole key/KEK source (ticket a464f2a).
 *
 * Unknown vendors fall through to the OpenAI-compatible adapter (documented
 * behavior, preserved).
 *
 * Endpoint scope: `config.url` is consumed only by the `'custom'` (required)
 * and `'openai'`/unknown-vendor (optional override) branches; the `'runware'`,
 * `'nanogpt'`, `'deepseek'`, `'deepseek_native'`, and `'prem'` branches ignore
 * it and use their vendor default endpoint. The vendor-string form takes
 * `options.apiUrl` instead.
 *
 * @param configOrVendor - `AgentModelConfig` object (its `providerId` selects
 *   the adapter; absent defaults to `'runware'`) OR vendor string
 *   (`'runware'` | `'nanogpt'` | `'deepseek'` | `'deepseek_native'` |
 *   `'prem'` | `'custom'` | `'openai'`), matched case-insensitively after
 *   trimming. Defaults to `'runware'`.
 * @param optionsOrKeyStore - Injected credential resolver or construction options.
 * @returns Concrete transport provider instance.
 * @throws An `Error` when `'custom'` is requested without a non-blank endpoint
 *   (`modelConfig.url` in the config-object form, `options.apiUrl` in the
 *   vendor-string form).
 */
export function createProvider(
  configOrVendor: AgentModelConfig | string = 'runware',
  optionsOrKeyStore?: CredentialResolverPort | CreateProviderOptions
): ProviderInterface {
  if (typeof configOrVendor === 'object' && configOrVendor !== null) {
    const modelConfig = configOrVendor;
    const providerId = String(modelConfig.providerId || 'runware').toLowerCase().trim();
    const normProviderId = normalizeProviderId(providerId);
    const vault = (optionsOrKeyStore && typeof optionsOrKeyStore.getCredential === 'function')
      ? optionsOrKeyStore as CredentialResolverPort
      : undefined;

    /**
     * A credential may be bound only when it belongs to the configured provider.
     * Resolver projections omit `providerId` (least privilege); full vault
     * entries expose it and are validated so another provider's key is never
     * silently bound.
     *
     * @param credential - Resolved credential or `null`.
     * @returns `true` when the credential may be bound to `providerId`.
     */
    const isProviderCredential = (credential: {
      id?: string;
      apiKey?: string;
      encryptionKey?: string;
      providerId?: string | null;
    } | null | undefined): boolean => {
      if (!credential) return false;
      if (credential.providerId === undefined || credential.providerId === null) return true;
      return normalizeProviderId(credential.providerId) === normProviderId;
    };

    // Pinned keyId wins when it resolves; a miss (deleted credential) or a
    // provider mismatch falls back to that provider's active credential.
    let cred: { id: string; apiKey?: string; encryptionKey?: string } | null = null;
    if (vault) {
      const pinned = modelConfig.keyId ? vault.getCredential(modelConfig.keyId) : null;
      if (isProviderCredential(pinned)) {
        cred = pinned;
      } else {
        const active = vault.getActiveCredential(providerId);
        cred = isProviderCredential(active) ? active : null;
      }
    }
    // KeyId-only (ticket a464f2a): raw secret fields on the config object are
    // never read — the resolved credential is the sole key/KEK source.
    const apiKey = cred?.apiKey || '';
    const encryptionKey = cred?.encryptionKey || '';

    switch (providerId) {
      case 'runware':
        return new RunwareProvider({ apiKey, credentialId: cred?.id, vault });
      case 'nanogpt':
        return new NanoGptProvider({ apiKey, credentialId: cred?.id, vault });
      case 'deepseek':
      case 'deepseek_native':
        return new DeepSeekProvider({ apiKey, credentialId: cred?.id, vault });
      case 'prem':
        return new PremProvider({ apiKey, clientKEK: encryptionKey, credentialId: cred?.id, vault });
      case 'custom':
        if (!modelConfig.url || !modelConfig.url.trim()) {
          throw new Error("Custom provider requires a valid endpoint 'url' in AgentModelConfig");
        }
        return new OpenAIProvider({
          apiUrl: modelConfig.url.trim(),
          apiKey,
          credentialId: cred?.id,
          vault,
          id: 'custom'
        });
      case 'openai':
      default:
        return new OpenAIProvider({
          apiUrl: modelConfig.url,
          apiKey,
          credentialId: cred?.id,
          vault,
          id: providerId || 'openai'
        });
    }
  }

  const v = String(configOrVendor || 'runware').toLowerCase().trim();
  const options: CreateProviderOptions = (typeof optionsOrKeyStore === 'object' && optionsOrKeyStore !== null
      && typeof optionsOrKeyStore.getCredential !== 'function')
    ? optionsOrKeyStore as CreateProviderOptions
    : {};

  switch (v) {
    case 'runware':
      return new RunwareProvider(options);
    case 'nanogpt':
      return new NanoGptProvider(options);
    case 'deepseek':
    case 'deepseek_native':
      return new DeepSeekProvider(options);
    case 'prem':
      return new PremProvider(options);
    case 'custom':
      if (!options.apiUrl || !options.apiUrl.trim()) {
        throw new Error("Custom provider requires a valid endpoint 'url' in AgentModelConfig");
      }
      return new OpenAIProvider({ ...options, id: 'custom' });
    case 'openai':
    default:
      return new OpenAIProvider({ ...options, id: v || 'openai' });
  }
}
