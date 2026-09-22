/**
 * Catalog implementation for the `presetCatalog` module: seed/overlay state,
 * CRUD with freeze/copy isolation, synchronous change events, default-validity
 * fallback, and adapter-failure resilience.
 */

import { getDefaultModelConfig, PRESET_MODELS } from '../modelConfig/index.ts';
import type { ModelPresetSourcePort } from './index.ts';
import { createPresetSourcePort } from './port.ts';
import { PRESET_CHANGE_TYPES } from './types.ts';
import type {
  ModelPreset,
  PresetCatalog,
  PresetCatalogOptions,
  PresetCatalogStorageAdapter,
  PresetChangeEvent,
  PresetModelConfig
} from './types.ts';

/** Id used when no seed entry matches the master default configuration. */
const FALLBACK_MASTER_DEFAULT_ID = 'preset_master_default';

/**
 * Deterministic, explicitly enumerated credential-shaped `modelConfig` keys
 * stripped from every ingested config (seed, adapter load, and `savePreset`).
 * Matching is exact-name only — never pattern-based — so no legitimate
 * `AgentModelConfig` field is ever dropped by accident.
 */
const CREDENTIAL_MODEL_CONFIG_KEYS: readonly string[] = Object.freeze([
  'keyId',
  'apiKey',
  'encryptionKey'
]);

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value - Candidate value
 * @returns `true` when the value is a non-null, non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies a raw model config without any of the explicitly enumerated
 * credential-shaped keys; every other own field is copied verbatim.
 *
 * @param source - Raw model config object
 * @returns A fresh record with the credential-shaped keys removed
 */
function stripCredentialFields(source: object): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (CREDENTIAL_MODEL_CONFIG_KEYS.includes(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Normalizes a raw model config: credential-shaped keys are dropped and
 * `providerId`/`modelId` are replaced by their validated values, every other
 * own field is copied verbatim.
 *
 * @param source - Raw model config record
 * @param providerId - Validated non-empty provider id
 * @param modelId - Validated non-empty model id
 * @returns A frozen credential-free model config
 */
function toPresetModelConfig(
  source: Record<string, unknown>,
  providerId: string,
  modelId: string
): PresetModelConfig {
  return Object.freeze({
    ...stripCredentialFields(source),
    providerId,
    modelId
  }) as PresetModelConfig;
}

/**
 * Builds a frozen catalog entry; every read returns another frozen copy, so
 * callers never observe or mutate internal references.
 *
 * @param preset - Entry to copy and freeze
 * @returns A new frozen entry
 */
function freezePreset(preset: ModelPreset): ModelPreset {
  return Object.freeze({
    id: preset.id,
    name: preset.name,
    isCustom: preset.isCustom,
    modelConfig: Object.freeze({ ...preset.modelConfig }) as PresetModelConfig
  });
}

/**
 * Parses an unknown value into a frozen catalog entry.
 *
 * @param value - Candidate entry (seed literal, adapter value, or caller input)
 * @returns The frozen entry, or `null` when the shape is invalid
 */
function parsePreset(value: unknown): ModelPreset | null {
  if (!isRecord(value)) return null;
  const { id, name, isCustom } = value;
  const modelConfig = value.modelConfig;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof isCustom !== 'boolean') return null;
  if (!isRecord(modelConfig)) return null;
  const { providerId, modelId } = modelConfig;
  if (typeof providerId !== 'string' || providerId.trim().length === 0) return null;
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return null;
  return freezePreset({
    id,
    name,
    isCustom,
    modelConfig: toPresetModelConfig(modelConfig, providerId, modelId)
  });
}

/**
 * Compares two model configs field by field over their own keys.
 *
 * @param left - First config
 * @param right - Second config
 * @returns `true` when both carry the same keys with identical values
 */
function modelConfigsEqual(left: PresetModelConfig, right: PresetModelConfig): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the credential-free master default configuration.
 *
 * @returns A frozen copy of `getDefaultModelConfig()` with the credential-shaped keys removed
 */
function currentMasterDefaultConfig(): PresetModelConfig {
  return Object.freeze(stripCredentialFields(getDefaultModelConfig())) as PresetModelConfig;
}

/**
 * Reads adapter-loaded entries defensively; a missing adapter, a throwing
 * `load()`, or a non-array result all degrade to an empty list.
 *
 * @param storage - Injected adapter, when present
 * @returns The loaded candidate values, or an empty list
 */
function loadEntries(storage: PresetCatalogStorageAdapter | null): unknown[] {
  try {
    if (!storage || typeof storage.load !== 'function') return [];
    const loaded: unknown = storage.load();
    return Array.isArray(loaded) ? loaded : [];
  } catch {
    return [];
  }
}

/**
 * Creates the preset catalog service.
 *
 * Seeds the catalog from `PRESET_MODELS`, overlays adapter-loaded entries by
 * id, and returns the CRUD/events/port surface. The returned object is frozen;
 * all reads hand out frozen copies of frozen internal entries.
 *
 * @param options - Injected storage adapter and active-pointer closures
 * @returns The frozen catalog service
 */
export function createPresetCatalog(options: PresetCatalogOptions): PresetCatalog {
  const storage: PresetCatalogStorageAdapter | null = (options && options.storage) || null;
  const readActiveId =
    options && typeof options.getActivePresetId === 'function' ? options.getActivePresetId : null;
  const writeActiveId =
    options && typeof options.setActivePresetId === 'function' ? options.setActivePresetId : null;

  const entries = new Map<string, ModelPreset>();
  const listeners = new Set<(event: PresetChangeEvent) => void>();

  for (const seed of PRESET_MODELS) {
    const parsed = parsePreset(seed);
    if (parsed) entries.set(parsed.id, parsed);
  }

  const masterConfig = currentMasterDefaultConfig();
  let masterDefaultId = '';
  for (const entry of entries.values()) {
    if (modelConfigsEqual(entry.modelConfig, masterConfig)) {
      masterDefaultId = entry.id;
      break;
    }
  }
  if (masterDefaultId === '') {
    masterDefaultId = FALLBACK_MASTER_DEFAULT_ID;
    if (!entries.has(masterDefaultId)) {
      entries.set(
        masterDefaultId,
        freezePreset({
          id: masterDefaultId,
          name: 'Default',
          isCustom: false,
          modelConfig: masterConfig
        })
      );
    }
  }

  for (const candidate of loadEntries(storage)) {
    const parsed = parsePreset(candidate);
    if (parsed) entries.set(parsed.id, parsed);
  }

  /**
   * Persists the full catalog projection; adapter failures are swallowed so
   * the in-memory catalog stays authoritative.
   */
  function persist(): void {
    if (!storage || typeof storage.save !== 'function') return;
    try {
      storage.save([...entries.values()].map(entry => freezePreset(entry)));
    } catch {
      // Persistence is best-effort; the in-memory catalog remains authoritative.
    }
  }

  /**
   * Publishes one change event to a snapshot of the listener set, isolating
   * listener exceptions from the emitter and from each other.
   *
   * @param event - Mutation kind and affected preset id
   */
  function emit(event: PresetChangeEvent): void {
    const frozen = Object.freeze({ ...event });
    for (const listener of [...listeners]) {
      try {
        listener(frozen);
      } catch {
        // Listener failures are isolated; the mutation result is unaffected.
      }
    }
  }

  function listPresets(): readonly ModelPreset[] {
    return Object.freeze([...entries.values()].map(entry => freezePreset(entry)));
  }

  function getPreset(id: string): ModelPreset | null {
    const entry = typeof id === 'string' ? entries.get(id) : undefined;
    return entry ? freezePreset(entry) : null;
  }

  function savePreset(preset: ModelPreset): void {
    const parsed = parsePreset(preset);
    if (!parsed) {
      throw new Error(
        'savePreset requires a preset with a non-empty string id and name, a boolean isCustom, and a modelConfig with non-empty string providerId and modelId'
      );
    }
    entries.set(parsed.id, parsed);
    persist();
    emit({ type: PRESET_CHANGE_TYPES.UPDATED, presetId: parsed.id });
  }

  function deletePreset(id: string): void {
    if (typeof id !== 'string' || !entries.has(id)) return;
    if (id === masterDefaultId) {
      throw new Error(`deletePreset refuses the fallback default preset '${masterDefaultId}'`);
    }
    entries.delete(id);
    persist();
    emit({ type: PRESET_CHANGE_TYPES.DELETED, presetId: id });
  }

  function setActivePresetId(id: string): void {
    if (typeof id !== 'string' || id.length === 0 || !entries.has(id)) {
      throw new Error(
        `setActivePresetId requires an existing catalog preset id (received '${String(id)}')`
      );
    }
    if (writeActiveId) {
      try {
        writeActiveId(id);
      } catch {
        // The pointer write is best-effort; reads fall back to the default.
      }
    }
  }

  function getDefaultPresetId(): string {
    let active: unknown = '';
    if (readActiveId) {
      try {
        active = readActiveId();
      } catch {
        active = '';
      }
    }
    if (typeof active === 'string' && entries.has(active)) return active;
    return masterDefaultId;
  }

  function subscribe(listener: (event: PresetChangeEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe requires a listener function');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return Object.freeze({
    listPresets,
    getPreset,
    savePreset,
    deletePreset,
    setActivePresetId,
    subscribe,
    createPresetSourcePort: (): ModelPresetSourcePort =>
      createPresetSourcePort({ getPreset, getDefaultPresetId, subscribe })
  });
}
