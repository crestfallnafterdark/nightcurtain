/**
 * Plain types for the `presetCatalog` module: the catalog entry shape, the
 * injected storage/pointer wiring, and the runtime-facing preset source port.
 */

import type { AgentModelConfig } from '../modelConfig/index.ts';
import type { ModelPresetSourcePort } from './index.ts';

/**
 * A preset's model configuration: the canonical `AgentModelConfig` shape minus
 * the `keyId` credential reference. A preset never pins a credential; the
 * effective config re-attaches the provider-active credential at resolution.
 */
export type PresetModelConfig = Omit<AgentModelConfig, 'keyId'>;

/**
 * One catalog entry: an official seed preset or a user-authored custom preset.
 */
export interface ModelPreset {
  /** Catalog key: an official provider id or a `preset_custom_*` id. */
  id: string;
  /** Display name shown by catalog consumers. */
  name: string;
  /** `true` for user-authored entries, `false` for official seed entries. */
  isCustom: boolean;
  /** Provider/model selection plus tuning; never carries `keyId` or secret material. */
  modelConfig: PresetModelConfig;
}

/**
 * Runtime vocabulary of catalog mutation kinds. `PresetChangeType` is its
 * compile-time mirror; the two are proven exact mirrors below.
 */
export const PRESET_CHANGE_TYPES = Object.freeze({
  /** A save (create or replace) completed. */
  UPDATED: 'preset-updated',
  /** A delete completed. */
  DELETED: 'preset-deleted'
} as const);

/** Catalog mutation kind carried by {@link PresetChangeEvent}. */
export type PresetChangeType = 'preset-updated' | 'preset-deleted';

/**
 * Compile-time proof that {@link PresetChangeType} mirrors
 * `PRESET_CHANGE_TYPES` in both directions; a drifted vocabulary or union
 * makes the assertion alias fail its constraint.
 */
type _PresetChangeTypeValues = (typeof PRESET_CHANGE_TYPES)[keyof typeof PRESET_CHANGE_TYPES];

type _PresetChangeTypesInSync = [PresetChangeType] extends [_PresetChangeTypeValues]
  ? [_PresetChangeTypeValues] extends [PresetChangeType]
    ? true
    : false
  : false;

type _AssertTrue<T extends true> = T;

type _PresetChangeTypesSyncCheck = _AssertTrue<_PresetChangeTypesInSync>;

/** Synchronous notification published after a catalog mutation. */
export interface PresetChangeEvent {
  /** Mutation kind. */
  type: PresetChangeType;
  /** Id of the saved or deleted entry. */
  presetId: string;
}

/** Persistence seam supplied by the composition root. */
export interface PresetCatalogStorageAdapter {
  /** Returns the persisted catalog entries; unknown or invalid values are dropped. */
  load(): ModelPreset[];
  /** Receives the full catalog projection after every mutation. */
  save(presets: ModelPreset[]): void;
}

/** Construction options for `presetCatalog.createPresetCatalog()`. */
export interface PresetCatalogOptions {
  /** Injected persistence adapter for the catalog entries. */
  storage: PresetCatalogStorageAdapter;
  /** Reads the active global preset id from the composition root. */
  getActivePresetId(): string;
  /** Persists the active global preset id through the composition root. */
  setActivePresetId(id: string): void;
}

/** Catalog service returned by `presetCatalog.createPresetCatalog()`. */
export interface PresetCatalog {
  /** Frozen copies of every entry, in catalog order. */
  listPresets(): readonly ModelPreset[];
  /** Frozen copy of one entry, or `null` when unknown. */
  getPreset(id: string): ModelPreset | null;
  /** Creates or replaces an entry and publishes `preset-updated`. */
  savePreset(preset: ModelPreset): void;
  /** Deletes an entry and publishes `preset-deleted`. */
  deletePreset(id: string): void;
  /** Sets the active global preset id; the id must name a catalog entry. */
  setActivePresetId(id: string): void;
  /** Subscribes to catalog changes; returns an idempotent unsubscribe. */
  subscribe(listener: (event: PresetChangeEvent) => void): () => void;
  /** Builds the frozen runtime projection of this catalog. */
  createPresetSourcePort(): ModelPresetSourcePort;
}
