/**
 * Model and upstream-route discovery helpers for the Sandbox Settings modal
 * (ticket 8c7c1d9).
 *
 * The modal edits a preset draft (provider id, model id, and — for the custom
 * provider — an endpoint URL) and needs live listings from the provider
 * transport: `listModels()` for the model picker, and the nanogpt-only
 * `getProviders()` upstream route list. Both helpers build the real
 * `createProvider` adapter from the passed draft plus the canonical vault
 * resolver port, so discovery always follows the editor draft and the active
 * credential for its provider.
 *
 * Secret discipline: the transport receives an `AgentModelConfig` whose
 * `keyId` is a reference — raw secret material never enters this module.
 * Failure messages are redacted against the credential values the resolver
 * exposes for the provider before they are returned, and successful listings
 * are normalized to the display shape only, so raw provider payloads never
 * reach the UI.
 *
 * The helpers are framework-free and never throw: `discoverModels` resolves a
 * typed `{ok}` result (legacy messages preserved), `discoverRoutes` resolves an
 * array that collapses to `[]` for non-nanogpt providers or any failure.
 */

import { createProvider } from '../../sandbox/inference/index.ts';
import type { AgentModelConfig, CredentialResolverPort } from '../../sandbox/inference/index.ts';

/**
 * Editor draft consumed by the discovery helpers.
 *
 * Only `providerId` and `url` change which transport endpoint is queried;
 * `keyId`, when present, pins the credential the factory resolves (otherwise
 * the provider's active credential is used). Extra draft fields are ignored —
 * no preset/catalog fields are read here.
 */
export interface DiscoveryModelConfig {
  /** Provider identifier from the editor draft (unknown-safe; defaults to `runware`). */
  providerId?: unknown;

  /** Model id from the editor draft (unused by listing endpoints; retained in the transport config). */
  modelId?: unknown;

  /** Endpoint override consumed by the `custom`/`openai` transport branches. */
  url?: unknown;

  /** Optional credential reference; resolved through the injected resolver port. */
  keyId?: unknown;

  /** Additional draft fields ride along untouched. */
  [key: string]: unknown;
}

/** Normalized model entry surfaced by the discovery list. */
export interface DiscoveredModel {
  /** Model identifier used to fill the editor. */
  readonly id: string;

  /** Human-readable display name (falls back to the id). */
  readonly name: string;

  /** Provider-reported context window, when available. */
  readonly contextLength?: string | number;
}

/** Typed outcome of {@link discoverModels}. */
export type ModelDiscoveryResult =
  | { readonly ok: true; readonly models: DiscoveredModel[] }
  | { readonly ok: false; readonly error: string };

/** Normalized upstream route entry surfaced by the routing list. */
export interface DiscoveredRoute {
  /** Upstream route/provider identifier used as the routing value. */
  readonly id: string;

  /** Human-readable route name (falls back to the id). */
  readonly name: string;
}

/** Legacy empty-listing message (preserved from the retired settings modal). */
const NO_MODELS_MESSAGE = 'No models returned by endpoint.';

/** Legacy failure message used when a rejection carries no message. */
const LIST_FAILED_MESSAGE = 'Failed to list models.';

/** Secret value projection read from the resolver port for error redaction. */
interface SecretProjection {
  /** Raw API key, when exposed. */
  apiKey?: string;
  /** Raw encryption key (Prem KEK), when exposed. */
  encryptionKey?: string;
}

/**
 * Discovers the provider's model listing for the editor draft.
 *
 * Builds `createProvider({...draft, keyId}, resolverPort)` and calls
 * `listModels()`, normalizing `string | ModelDescriptor` entries to
 * `{id, name, contextLength?}`. An empty listing resolves the legacy
 * `'No models returned by endpoint.'` error; a rejection resolves its message
 * (or `'Failed to list models.'` when absent), redacted against the
 * credentials resolved for the provider.
 *
 * @param modelConfig - Editor draft (provider id/url/keyId drive the transport).
 * @param resolverPort - Canonical vault resolver port; omitted means no credentials.
 * @returns Typed discovery result (never rejects).
 */
export async function discoverModels(
  modelConfig: DiscoveryModelConfig | null | undefined,
  resolverPort?: CredentialResolverPort | null
): Promise<ModelDiscoveryResult> {
  const transportConfig = buildTransportConfig(modelConfig);
  const secrets = collectSecretValues(
    resolverPort ?? null,
    transportConfig.providerId,
    transportConfig.keyId
  );
  try {
    const provider = createProvider(transportConfig, resolverPort ?? undefined);
    const models = normalizeModels(await provider.listModels());
    if (models.length === 0) {
      return { ok: false, error: NO_MODELS_MESSAGE };
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: redactSecrets(readErrorMessage(err), secrets) };
  }
}

/**
 * Discovers the nanogpt upstream routes for a model id.
 *
 * Only the `nanogpt` transport implements route discovery; every other
 * provider resolves `[]` without a request (their adapters stub the listing).
 * A blank model id, a transport failure, or a provider error also resolves
 * `[]` — the editor keeps its free-text routing field as the fallback.
 *
 * @param modelConfig - Editor draft (provider id/url/keyId drive the transport).
 * @param resolverPort - Canonical vault resolver port; omitted means no credentials.
 * @param modelId - Model id to query; falls back to the draft's model id.
 * @returns Normalized routes (`{id, name}`), or `[]` (never rejects).
 */
export async function discoverRoutes(
  modelConfig: DiscoveryModelConfig | null | undefined,
  resolverPort?: CredentialResolverPort | null,
  modelId?: string
): Promise<DiscoveredRoute[]> {
  const transportConfig = buildTransportConfig(modelConfig);
  if (transportConfig.providerId.trim().toLowerCase() !== 'nanogpt') {
    return [];
  }
  const requestedModelId = typeof modelId === 'string' && modelId.trim()
    ? modelId.trim()
    : transportConfig.modelId;
  if (!requestedModelId) {
    return [];
  }
  try {
    const provider = createProvider(transportConfig, resolverPort ?? undefined);
    return normalizeRoutes(await provider.getProviders(requestedModelId));
  } catch {
    return [];
  }
}

/**
 * Builds the transport config for the draft: `keyId` is always a string
 * reference (empty when the draft has none), so raw secret fields can never
 * be read by the factory.
 *
 * @param modelConfig - Editor draft.
 * @returns A factory-ready {@link AgentModelConfig}.
 */
function buildTransportConfig(modelConfig: DiscoveryModelConfig | null | undefined): AgentModelConfig {
  const url = readString(modelConfig?.url).trim();
  return {
    providerId: readProviderId(modelConfig),
    keyId: readString(modelConfig?.keyId),
    modelId: readString(modelConfig?.modelId),
    ...(url ? { url } : {})
  };
}

/**
 * Reads a defensive string field from the draft.
 *
 * @param value - Candidate field value.
 * @returns The string value, or `''` for any non-string.
 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Normalizes the draft provider id (trimmed; falls back to `runware`).
 *
 * @param modelConfig - Editor draft.
 * @returns Normalized provider id.
 */
function readProviderId(modelConfig: DiscoveryModelConfig | null | undefined): string {
  return readString(modelConfig?.providerId).trim() || 'runware';
}

/**
 * Normalizes a provider listing to the display shape, dropping every extra
 * provider field (cost, pricing, raw payloads, ...). Provider catalogs can
 * alias the same model id across multiple entries; the listing is deduped by
 * trimmed id (first entry wins, keeping its name/contextLength), so the
 * consumer can key its list by id.
 *
 * @param list - Provider result: `string | ModelDescriptor` entries.
 * @returns Normalized entries with unique usable ids.
 */
function normalizeModels(list: unknown): DiscoveredModel[] {
  if (!Array.isArray(list)) return [];
  const models: DiscoveredModel[] = [];
  const seenIds = new Set<string>();
  for (const entry of list) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        models.push({ id, name: id });
      }
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { id?: unknown; name?: unknown; contextLength?: unknown };
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const rawName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const name = rawName || id;
    const contextLength = candidate.contextLength;
    if (typeof contextLength === 'string' || typeof contextLength === 'number') {
      models.push({ id, name, contextLength });
    } else {
      models.push({ id, name });
    }
  }
  return models;
}

/**
 * Normalizes a route listing to `{id, name}`, dropping provider metadata and
 * deduping by trimmed id (first entry wins) — upstream route payloads may
 * alias the same provider id twice.
 *
 * @param routes - Provider result: `string | ProviderRoute` entries.
 * @returns Normalized routes with unique usable ids.
 */
function normalizeRoutes(routes: unknown): DiscoveredRoute[] {
  if (!Array.isArray(routes)) return [];
  const normalized: DiscoveredRoute[] = [];
  const seenIds = new Set<string>();
  for (const entry of routes) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        normalized.push({ id, name: id });
      }
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { id?: unknown; name?: unknown };
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const rawName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    normalized.push({ id, name: rawName || id });
  }
  return normalized;
}

/**
 * Reads the message from an unknown rejection.
 *
 * @param err - Thrown value (Error, string, or anything else).
 * @returns The message, or the legacy failure text when absent.
 */
function readErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return LIST_FAILED_MESSAGE;
}

/**
 * Collects the credential values the resolver exposes for the provider, used
 * to strip them from failure messages. Never logs or returns them.
 *
 * @param resolverPort - Injected resolver port (null-safe).
 * @param providerId - Transport provider id.
 * @param keyId - Draft-pinned credential id, when present.
 * @returns Distinct non-empty secret values.
 */
function collectSecretValues(
  resolverPort: CredentialResolverPort | null | undefined,
  providerId: string,
  keyId: string
): string[] {
  if (!resolverPort) return [];
  const values = new Set<string>();
  const add = (credential: SecretProjection | null | undefined): void => {
    if (!credential) return;
    if (typeof credential.apiKey === 'string' && credential.apiKey) values.add(credential.apiKey);
    if (typeof credential.encryptionKey === 'string' && credential.encryptionKey) {
      values.add(credential.encryptionKey);
    }
  };
  try {
    if (keyId) add(resolverPort.getCredential(keyId));
    if (providerId) add(resolverPort.getActiveCredential(providerId));
  } catch {
    // A resolver failure must never block discovery; the message is still
    // returned with whatever could be resolved (possibly nothing).
  }
  return [...values];
}

/**
 * Replaces every occurrence of the resolved credential values in the text.
 *
 * @param text - Raw failure message.
 * @param secrets - Secret values collected from the resolver.
 * @returns Redacted text.
 */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}
