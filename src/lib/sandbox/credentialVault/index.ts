/**
 * @packageDocumentation
 * Formal contract for the MOD-16 credential vault sandbox pair
 * (`credentialVault/index.ts`). This file is the canonical home of the
 * `CredentialResolverPort` contract; its planned → ratified flip is recorded
 * by the port-ratification commits (`88243bd`/`0416c42`).
 *
 * ### Responsibilities
 * - Labeled credential storage (`apiKey`/`encryptionKey`).
 * - Active-credential pointers per normalized provider id.
 * - Canonical-credential lifecycle, display masking, redacted export, and
 *   least-privilege resolver construction.
 *
 * Preserved source quirks:
 * - Lazy canonical-credential creation on lookup (ratified mutating-read exception).
 * - Deleting a canonical credential wipes its secrets but keeps the entry.
 * - `setActiveCredential(providerId, null)` re-selects or lazily creates+persists.
 * - Corrupt JSON in storage silently falls back to an empty state.
 * - `lastUsed` is retained on entries but never written after creation.
 * - Arbitrary passthrough fields are preserved; `baseUrl` is dropped outright
 *   by every mutation path (BUG-ENC-027, `fba7587` — the custom endpoint URL
 *   lives in the model config).
 * - Storage quota errors propagate unguarded; the API is synchronous; no logging.
 *
 * @module credentialVault
 * @mustNotImport ../runtime/*
 * @mustNotImport ../inference/*
 * @invariant Leaf: zero imports; all persistence goes through the injected `CredentialStoragePort`.
 * @invariant `createBrowserCredentialStorage()` is the single declared ambient (`localStorage`) touchpoint; class instances never fall back to ambient storage.
 * @invariant This module is the only application reader and writer of `CREDENTIAL_VAULT_STORAGE_KEY` (`'ai_story_credentials_v1'`); no application consumer touches credential storage directly (the sanctioned QA seeder `tests/qa/seed_vault.mjs` writes and verifies the key on the MCP profile — see `docs/testing/exploratory_qa_plan.md` §2).
 * @invariant Secrets stay confined to full entries: `createResolverPort()` returns the `{ id, apiKey?, encryptionKey? }` projection only, `exportCredentials()` is redacted by default, and secrets never appear in errors or logs.
 * @invariant Canonical-credential creation on lookup is the sole mutating read path through an otherwise read-only resolver (ratified exception); the resolver exposes no writes, enumeration, or listing.
 * @invariant The API is synchronous and emits no events or subscriptions.
 * @invariant Corrupt persisted JSON silently falls back to an empty state; storage/quota failures propagate unguarded to the caller.
 * @decision `CredentialResolverPort` is the canonical registry-listed port provided by this module, constructed as a frozen plain object via `vault.createResolverPort()` (ratified port contract)
 * @decision The vault is a pure `(keyId, secret)` store: `baseUrl` is dropped outright from entries and mutations, with no migration (pre-release)
 */

// ============================================================================
// 1. Storage key
// ============================================================================

/**
 * Storage key under which the serialized `CredentialVaultData` JSON lives
 * (`'ai_story_credentials_v1'`). Single storage path for application code: no
 * application module reads or writes this key directly; the sanctioned QA
 * seeder (`tests/qa/seed_vault.mjs`) is the sole outside writer and verifier
 * (see `docs/testing/exploratory_qa_plan.md` §2).
 */
export const CREDENTIAL_VAULT_STORAGE_KEY = 'ai_story_credentials_v1';

// ============================================================================
// 2. Ports
// ============================================================================

/**
 * Injected storage port (non-canonical internal DI, not registry-listed).
 *
 * The composition root provides the implementation and the vault is the sole
 * consumer. `createBrowserCredentialStorage()` is the single declared ambient
 * (`localStorage`) touchpoint; class instances never fall back to ambient
 * storage on their own.
 *
 * @example
 * ```typescript
 * const backing = new Map<string, string>();
 * const storage: CredentialStoragePort = {
 *   get: key => (backing.has(key) ? backing.get(key)! : null),
 *   set: (key, value) => void backing.set(key, value),
 *   remove: key => void backing.delete(key)
 * };
 * const vault = new CredentialVault({ storage });
 * ```
 */
export interface CredentialStoragePort {
  /** Reads the raw JSON string for `key`, or `null` when absent. */
  get(key: string): string | null;

  /** Persists `value` under `key` (storage/quota errors propagate to the caller). */
  set(key: string, value: string): void;

  /** Removes the value stored under `key`. */
  remove(key: string): void;
}

/**
 * Canonical read-only credential resolver port (registry-listed).
 *
 * Constructed as a frozen plain object via `CredentialVault.createResolverPort()`
 * and handed to runtime/domain consumers (e.g. MOD-15 `createProvider`). Returns
 * least-privilege projections rather than full vault entries — no writes, no
 * enumeration, no listing.
 *
 * **Ratified exception (MOD-16):** a lookup miss for a canonical provider id may
 * lazily create and persist that canonical credential; this is the sole
 * mutating read path, documented in the module invariants.
 */
export interface CredentialResolverPort {
  /** Lookup by credential id (as referenced by `AgentModelConfig.keyId`). */
  getCredential(id: string): { id: string; apiKey?: string; encryptionKey?: string } | null;

  /** Active credential for a provider id (e.g. `'runware'`, `'deepseek'`). */
  getActiveCredential(providerId: string): { id: string; apiKey?: string; encryptionKey?: string } | null;
}

// ============================================================================
// 3. Data schema
// ============================================================================

/**
 * Least-privilege credential projection returned by the resolver port.
 * Only the credential id and the two secret fields inference consumes.
 */
export interface CredentialProjection {
  /** Credential id. */
  id: string;

  /** API key, omitted when the underlying entry has none. */
  apiKey?: string;

  /** Prem AI client KEK, omitted when the underlying entry has none. */
  encryptionKey?: string;
}

/**
 * A labeled credential record stored by the vault. Arbitrary passthrough fields
 * survive round-trips (the vault spreads caller-provided entries).
 */
export interface CredentialEntry {
  /** Unique credential id (`canonical_<providerId>` for canonical entries). */
  id: string;

  /** Normalized provider id (see `normalizeProviderId`). */
  providerId: string;

  /** Human-readable label used by management UIs. */
  label: string;

  /** Secret API key (absent on redacted `exportCredentials()` results). */
  apiKey?: string;

  /** Optional Prem AI client-side encryption key (absent on redacted exports). */
  encryptionKey?: string;

  /** Epoch-ms creation timestamp (`0` for lazily created canonical entries). */
  createdAt: number;

  /** Legacy field, retained on entries but never written after creation. */
  lastUsed: number | null;

  /** True for lazily created canonical entries. */
  isCanonical?: boolean;

  /**
   * Arbitrary passthrough fields preserved verbatim from callers.
   *
   * `baseUrl` is **not** preserved: the vault is a pure `(keyId, secret)` store
   * per the v1.1.0 amendment (BUG-ENC-027) — all mutation paths
   * (`addCredential`, `updateCredential`, `importCredentials`) drop it, and the
   * custom endpoint URL lives in the model config (`AgentModelConfig.url`).
   */
  [key: string]: unknown;
}

/**
 * Serialized vault state persisted under `CREDENTIAL_VAULT_STORAGE_KEY`.
 */
export interface CredentialVaultData {
  /** Credential records. */
  credentials: CredentialEntry[];

  /** Active credential id per normalized provider id. */
  active: Record<string, string>;
}

/**
 * Constructor options for `CredentialVault`.
 */
export interface CredentialVaultOptions {
  /**
   * Required storage port exposing `get`/`set`/`remove`. A constructor
   * `TypeError` is thrown when this is missing or malformed.
   */
  storage: CredentialStoragePort;

  /** Storage key override; defaults to `CREDENTIAL_VAULT_STORAGE_KEY`. */
  storageKey?: string;
}

/**
 * Masking options for `CredentialVault.maskKey`.
 */
export interface MaskKeyOptions {
  /** Number of leading characters kept visible (default `3`). */
  visibleStart?: number;

  /** Number of trailing characters kept visible (default `4`). */
  visibleEnd?: number;
}

/**
 * Options for `CredentialVault.exportCredentials`.
 */
export interface ExportCredentialsOptions {
  /**
   * When `true`, `apiKey`/`encryptionKey` are retained in the returned copies.
   * Defaults to `false` (redacted by default).
   */
  includeSecrets?: boolean;
}

// ============================================================================
// 4. Module functions
// ============================================================================

/**
 * Normalizes a provider id to its canonical vault form. Empty, absent, or
 * whitespace-only input falls back to `'runware'`; `'deepseek_native'` aliases
 * `'deepseek'`.
 *
 * @param id - Raw provider id (case/whitespace insensitive).
 * @returns Normalized provider id.
 */
export function normalizeProviderId(id?: string | null): string {
  if (!id || !String(id).trim()) return 'runware';
  const norm = String(id).toLowerCase().trim();
  if (norm === 'deepseek_native') return 'deepseek';
  return norm;
}

/**
 * Creates the declared browser storage adapter (`{ get, set, remove }`).
 *
 * Mirrors the source module's storage-resolution guard order: when `window` is
 * undefined or `globalThis.localStorage` is undefined, a Map-backed in-memory
 * port is returned (preserving Node-test behavior); otherwise `localStorage`
 * backs the port directly.
 *
 * @returns A `CredentialStoragePort` over `localStorage` or an in-memory fallback.
 */
export function createBrowserCredentialStorage(): CredentialStoragePort {
  if (typeof window === 'undefined' || typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    const fallback: CredentialStoragePort = {
      get(key) {
        return store.get(key) ?? null;
      },
      set(key, value) {
        store.set(key, value);
      },
      remove(key) {
        store.delete(key);
      }
    };
    return fallback;
  }
  const browser: CredentialStoragePort = {
    get(key) {
      return localStorage.getItem(key);
    },
    set(key, value) {
      localStorage.setItem(key, value);
    },
    remove(key) {
      localStorage.removeItem(key);
    }
  };
  return browser;
}

// ============================================================================
// 5. CredentialVault
// ============================================================================

/**
 * Canonical provider descriptors. Internal — intentionally not exported; only
 * `normalizeProviderId` is part of the public helper surface.
 */
const CANONICAL_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'runware', label: 'Runware Default' },
  { id: 'nanogpt', label: 'NanoGPT Default' },
  { id: 'deepseek', label: 'DeepSeek Default' },
  { id: 'prem', label: 'Prem AI Default' },
  { id: 'custom', label: 'Custom OpenAI Default' }
];

/**
 * Labeled credential vault with injected persistence.
 *
 * All mutation flows through the injected `CredentialStoragePort`; the API is
 * synchronous, emits no events, and never logs. Storage/quota errors propagate
 * unguarded (source-verbatim). Internals are `#`-private and deliberately
 * absent from this contract; this declaration covers the public surface only.
 *
 * @example
 * ```typescript
 * import { CredentialVault, createBrowserCredentialStorage } from './credentialVault/index.ts';
 *
 * const vault = new CredentialVault({ storage: createBrowserCredentialStorage() });
 * const entry = vault.addCredential({ providerId: 'runware', label: 'Main', apiKey: 'sk-...' });
 * vault.setActiveCredential('runware', entry.id);
 *
 * const resolver = vault.createResolverPort();
 * resolver.getActiveCredential('runware')?.apiKey;
 * ```
 */
export class CredentialVault {
  /** Injected storage port (constructor-validated). */
  #storage: CredentialStoragePort;

  /** Storage key the serialized vault state is read from and written to. */
  #storageKey: string;

  /** Last persisted state, served when storage has no value yet. */
  #inMemoryData: CredentialVaultData;

  /**
   * Creates a vault over the supplied storage port.
   *
   * @param options - Storage port (required) and optional storage key.
   * @throws `TypeError` - When `options` or `options.storage` is missing/malformed.
   */
  constructor(options: CredentialVaultOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError(
        'CredentialVault requires an options object: new CredentialVault({ storage, storageKey? })'
      );
    }
    const { storage, storageKey = CREDENTIAL_VAULT_STORAGE_KEY } = options;
    if (
      !storage ||
      typeof storage.get !== 'function' ||
      typeof storage.set !== 'function' ||
      typeof storage.remove !== 'function'
    ) {
      throw new TypeError(
        'CredentialVault requires a storage port exposing get(key), set(key, value), and remove(key)'
      );
    }
    this.#storage = storage;
    this.#storageKey = storageKey;
    this.#inMemoryData = { credentials: [], active: {} };
  }

  /**
   * Builds a canonical credential entry for a provider.
   *
   * @param providerId - Provider id (normalized internally).
   * @returns The canonical entry.
   */
  #createCanonicalCredential(providerId: string): CredentialEntry {
    const norm = normalizeProviderId(providerId);
    const def = CANONICAL_PROVIDERS.find(p => p.id === norm) || { id: norm, label: `${norm} Default` };
    return {
      id: `canonical_${norm}`,
      providerId: norm,
      label: def.label,
      apiKey: '',
      encryptionKey: norm === 'prem' ? '' : undefined,
      createdAt: 0,
      lastUsed: null,
      isCanonical: true
    };
  }

  /**
   * Loads the vault state from the injected storage.
   * Corrupt JSON silently falls back to an empty state (source quirk).
   *
   * @returns The vault state.
   */
  #load(): CredentialVaultData {
    const raw = this.#storage.get(this.#storageKey);
    if (!raw) return JSON.parse(JSON.stringify(this.#inMemoryData));
    try {
      return JSON.parse(raw);
    } catch {
      return { credentials: [], active: {} };
    }
  }

  /**
   * Persists the vault state through the injected storage.
   * Storage errors (quota) propagate unguarded (source quirk).
   *
   * @param data - Vault state to persist.
   */
  #save(data: CredentialVaultData): void {
    this.#storage.set(this.#storageKey, JSON.stringify(data));
    this.#inMemoryData = JSON.parse(JSON.stringify(data));
  }

  /**
   * Adds a credential entry, assigning `id`, `createdAt`, and `lastUsed: null`.
   * Arbitrary extra fields are preserved by spread, except `baseUrl`, which is
   * dropped (BUG-ENC-027 — the vault stores `(keyId, secret)` pairs only).
   *
   * @param entry - Credential fields (id/createdAt/lastUsed are assigned by the vault).
   *   `label` is required: the returned entry carries it.
   * @returns The stored entry, including its generated id.
   */
  addCredential(entry: Partial<CredentialEntry> & { label: string }): CredentialEntry {
    const data = this.#load();
    const fields = { ...entry };
    delete fields.baseUrl;
    const providerId = normalizeProviderId(entry.providerId || 'runware');
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cred_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const newEntry: CredentialEntry = {
      ...fields,
      providerId,
      id,
      createdAt: Date.now(),
      lastUsed: null
    };
    data.credentials.push(newEntry);
    this.#save(data);
    return newEntry;
  }

  /**
   * Updates a credential by id. A missing `canonical_*` id lazily creates that
   * canonical entry with the updates applied and marks it active. `baseUrl` is
   * dropped from the updates (BUG-ENC-027).
   *
   * @param id - Credential id.
   * @param updates - Partial entry merged over the stored credential.
   * @returns The updated/created entry, or `null` when the id is unknown and not canonical.
   */
  updateCredential(id: string, updates: Partial<CredentialEntry>): CredentialEntry | null {
    const data = this.#load();
    const fields = { ...updates };
    delete fields.baseUrl;
    const idx = data.credentials.findIndex(c => c.id === id);
    if (idx === -1) {
      if (id && String(id).startsWith('canonical_')) {
        const provId = id.replace('canonical_', '');
        const canonical = this.#createCanonicalCredential(provId);
        const updated: CredentialEntry = { ...canonical, ...fields, id };
        data.credentials.push(updated);
        data.active[provId] = id;
        this.#save(data);
        return updated;
      }
      return null;
    }
    data.credentials[idx] = { ...data.credentials[idx], ...fields };
    this.#save(data);
    return data.credentials[idx];
  }

  /**
   * Deletes a credential by id. Canonical entries are wiped in place (secrets
   * cleared, entry retained); non-canonical entries are removed and the active
   * pointer is re-pointed or cleared.
   *
   * @param id - Credential id.
   * @returns `true` when an entry was found.
   */
  deleteCredential(id: string): boolean {
    const data = this.#load();
    const idx = data.credentials.findIndex(c => c.id === id);
    if (idx === -1) return false;
    const cred = data.credentials[idx];
    if (cred.isCanonical || String(id).startsWith('canonical_')) {
      cred.apiKey = '';
      if (cred.encryptionKey !== undefined) cred.encryptionKey = '';
      this.#save(data);
      return true;
    }
    data.credentials.splice(idx, 1);
    if (data.active[cred.providerId] === id) {
      const remaining = data.credentials.find(c => c.providerId === cred.providerId);
      if (remaining) {
        data.active[cred.providerId] = remaining.id;
      } else {
        delete data.active[cred.providerId];
      }
    }
    this.#save(data);
    return true;
  }

  /**
   * Looks up a credential by id. **Mutating read:** a missing `canonical_*` id
   * lazily creates, persists, and returns the canonical entry (ratified
   * exception).
   *
   * @param id - Credential id.
   * @returns The entry, or `null` for unknown non-canonical ids.
   */
  getCredential(id: string): CredentialEntry | null {
    const data = this.#load();
    const found = data.credentials.find(c => c.id === id);
    if (found) return found;
    if (id && String(id).startsWith('canonical_')) {
      const provId = id.replace('canonical_', '');
      const canonical = this.#createCanonicalCredential(provId);
      data.credentials.push(canonical);
      if (!data.active[provId]) data.active[provId] = canonical.id;
      this.#save(data);
      return canonical;
    }
    return null;
  }

  /**
   * Returns all credentials for a provider, lazily creating and persisting the
   * canonical entry when none exist.
   *
   * @param providerId - Provider id (normalized internally).
   * @returns At least one entry (the canonical fallback).
   */
  getCredentialsForProvider(providerId: string): CredentialEntry[] {
    const norm = normalizeProviderId(providerId);
    const data = this.#load();
    const forProvider = data.credentials.filter(c => c.providerId === norm);
    if (forProvider.length > 0) return forProvider;
    const canonical = this.#createCanonicalCredential(norm);
    data.credentials.push(canonical);
    if (!data.active[norm]) data.active[norm] = canonical.id;
    this.#save(data);
    return [canonical];
  }

  /**
   * Returns every stored credential, including secrets.
   *
   * @returns All full entries.
   */
  getAllCredentials(): CredentialEntry[] {
    return this.#load().credentials;
  }

  /**
   * Returns the active credential for a provider. Falls back to the first
   * stored credential, then lazily creates and persists the canonical entry.
   *
   * @param providerId - Provider id (normalized internally).
   * @returns The active entry (never `null`; canonical fallback is persisted).
   */
  getActiveCredential(providerId: string): CredentialEntry {
    const norm = normalizeProviderId(providerId);
    const data = this.#load();
    const activeId = data.active[norm];
    if (activeId) {
      const cred = data.credentials.find(c => c.id === activeId);
      if (cred) return cred;
    }
    const forProvider = data.credentials.filter(c => c.providerId === norm);
    if (forProvider.length > 0) return forProvider[0];

    const canonical = this.#createCanonicalCredential(norm);
    data.credentials.push(canonical);
    data.active[norm] = canonical.id;
    this.#save(data);
    return canonical;
  }

  /**
   * Sets the active credential for a provider; a falsy `credentialId` clears
   * the pointer, after which the normal active-resolution path re-selects or
   * lazily creates the canonical entry.
   *
   * @param providerId - Provider id (normalized internally).
   * @param credentialId - Credential id, or `null`/omitted to clear.
   * @returns The resolved active entry after the mutation.
   */
  setActiveCredential(providerId: string, credentialId?: string | null): CredentialEntry {
    const norm = normalizeProviderId(providerId);
    const data = this.#load();
    if (!credentialId) {
      delete data.active[norm];
    } else {
      data.active[norm] = credentialId;
    }
    this.#save(data);
    return this.getActiveCredential(norm);
  }

  /**
   * Masks a secret for display: keeps `visibleStart` leading and `visibleEnd`
   * trailing characters, collapsing keys whose length is at most
   * `visibleStart + visibleEnd` (the boundary includes equality) to `'****'`.
   * Falsy/non-string input yields `''`.
   *
   * @param key - Secret to mask.
   * @param options - Visible window overrides.
   * @returns Masked display string.
   */
  static maskKey(key: string | null | undefined, options: MaskKeyOptions = {}): string {
    if (!key || typeof key !== 'string') return '';
    const visibleStart = options.visibleStart !== undefined ? options.visibleStart : 3;
    const visibleEnd = options.visibleEnd !== undefined ? options.visibleEnd : 4;
    if (key.length <= visibleStart + visibleEnd) return '****';
    return `${key.substring(0, visibleStart)}****${key.substring(key.length - visibleEnd)}`;
  }

  /**
   * Exports credentials redacted by default (`apiKey`/`encryptionKey`
   * removed). This is the redacted-by-default export surface;
   * `includeSecrets: true` is the explicit opt-in escape hatch.
   *
   * @param options - Export options (redacted unless `includeSecrets` is true).
   * @returns Shallow copies of the stored entries.
   */
  exportCredentials(options: ExportCredentialsOptions = { includeSecrets: false }): CredentialEntry[] {
    const data = this.#load();
    return data.credentials.map(c => {
      const copy: CredentialEntry = { ...c };
      if (!options.includeSecrets) {
        delete copy.apiKey;
        delete copy.encryptionKey;
      }
      return copy;
    });
  }

  /**
   * Imports credentials, overwriting entries by id and assigning missing ids
   * by mutating the caller's objects. `baseUrl` is dropped from imported
   * entries, as in `addCredential`/`updateCredential` (BUG-ENC-027 — the vault
   * stores `(keyId, secret)` pairs only).
   *
   * @param credentials - Entries to import.
   */
  importCredentials(credentials: CredentialEntry[] = []): void {
    const data = this.#load();
    for (const c of credentials) {
      if (!c.id) c.id = `cred_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const fields: CredentialEntry = { ...c };
      delete fields.baseUrl;
      const existingIdx = data.credentials.findIndex(ec => ec.id === c.id);
      if (existingIdx !== -1) {
        data.credentials[existingIdx] = fields;
      } else {
        data.credentials.push(fields);
      }
    }
    this.#save(data);
  }

  /**
   * Builds the canonical read-only `CredentialResolverPort`: a frozen plain
   * object returning least-privilege `{ id, apiKey?, encryptionKey? }`
   * projections. No writes, no enumeration.
   *
   * @returns A frozen `CredentialResolverPort` bound to this vault.
   */
  createResolverPort(): CredentialResolverPort {
    const project = (credential: CredentialEntry | null): CredentialProjection | null => {
      if (!credential) return null;
      const projection: CredentialProjection = { id: credential.id };
      if (credential.apiKey !== undefined) projection.apiKey = credential.apiKey;
      if (credential.encryptionKey !== undefined) projection.encryptionKey = credential.encryptionKey;
      return projection;
    };
    return Object.freeze({
      getCredential: (id: string) => project(this.getCredential(id)),
      getActiveCredential: (providerId: string) => project(this.getActiveCredential(providerId))
    });
  }
}
