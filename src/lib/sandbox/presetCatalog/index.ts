/**
 * @packageDocumentation
 * Preset Catalog (MOD-20) — the unified model-preset catalog and the live
 * preset-binding source for the sandbox.
 *
 * The catalog merges the MOD-17 official `PRESET_MODELS` seed with user custom
 * presets supplied through an injected storage adapter, exposes CRUD for
 * management consumers, publishes synchronous change events, and projects a
 * read-only `ModelPresetSourcePort` for the runtime. It is the single source of
 * truth for preset selection; the active pointer is read and written only
 * through the injected composition-root closures.
 *
 * ### Responsibilities
 * - Unified preset catalog: list/read/save/delete with freeze/copy isolation.
 * - Active preset resolution (`getDefaultPresetId`) with master-default fallback.
 * - Synchronous change notification after every catalog mutation.
 * - Frozen `ModelPresetSourcePort` projection for runtime consumers.
 *
 * ### Non-responsibilities
 * No credential storage/resolution, transport/provider selection, agent
 * lifecycle, UI presentation, or ambient I/O: persistence lives behind the
 * injected adapter and the active pointer behind the injected closures.
 *
 * @module presetCatalog
 * @invariant INV-SINGLE-SOURCE: The catalog owns the only authoritative preset list; every read resolves from its in-memory entries, and callers receive copies instead of references.
 * @invariant INV-IMMUTABILITY: Internal entries and their modelConfigs are frozen; listPresets/getPreset and the source port return frozen fresh copies, never internal references.
 * @invariant INV-COMPLETENESS: Every stored entry carries a non-empty id and name, a boolean isCustom, and a modelConfig with non-empty providerId and modelId; savePreset rejects invalid input and adapter-loaded entries are dropped when invalid.
 * @invariant INV-DEFAULT-VALIDITY: getDefaultPresetId() always names an entry present in the catalog; a missing or unknown active pointer resolves to the undeletable fallback default.
 * @invariant INV-EVENTS: savePreset and deletePreset emit synchronously after the mutation; a preset-deleted listener observes getPreset(id) === null; listener exceptions are isolated and unsubscribe is idempotent.
 * @invariant INV-PURITY: No ambient I/O, no import-time side effects, deterministic outputs; persistence flows only through the injected adapter, whose failures never propagate to callers.
 * @invariant INV-NO-KEYID: Catalog entries carry no credential material; the explicit credential-shaped fields keyId, apiKey, and encryptionKey are stripped from every ingested modelConfig, on seed, on adapter load, and on save.
 * @decision Ingested modelConfigs are normalized by stripping the explicit credential-field set keyId/apiKey/encryptionKey (exact-name matching only, never patterns) so entries expose only credential-free PresetModelConfig fields; resolution re-attaches the provider-active credential at turn start
 * @decision storage.save receives the full catalog projection after every mutation; adapter load overlays entries by id, appends unknown ids, and load/save failures degrade to the in-memory catalog
 * @decision The seed entry matching getDefaultModelConfig() is the undeletable fallback default; deletePreset rejects it, deletePreset of an unknown id is a no-op, and stale active pointers resolve to the fallback without being rewritten
 * @decision setActivePresetId accepts only existing catalog ids and swallows pointer-write failures; the source port's subscribe delegates to the catalog's isolated listener set
 */

import type { ModelPreset, PresetChangeEvent } from './types.ts';

export { createPresetCatalog } from './catalog.ts';

/**
 * Read-only runtime projection of the catalog, built by
 * `presetCatalog.createPresetSourcePort()` and injected by the composition
 * root for turn-start model resolution and catalog-change subscription.
 *
 * The projection is a frozen plain object: every read resolves from the live
 * catalog and hands out frozen copies, so consumers never observe internal
 * references or mutate catalog state. `subscribe` delivers synchronous change
 * events with isolated listener exceptions and an idempotent unsubscribe.
 */
export interface ModelPresetSourcePort {
  /**
   * Resolves one preset by id.
   *
   * @param id - Candidate catalog preset id
   * @returns A frozen preset copy, or `null` when the id is unknown or deleted
   */
  getPreset(id: string): ModelPreset | null;
  /**
   * Resolves the active global preset id.
   *
   * @returns The active catalog entry id; an unknown or stale active pointer
   *   resolves to the undeletable fallback default
   */
  getDefaultPresetId(): string;
  /**
   * Subscribes to synchronous catalog change notifications.
   *
   * @param listener - Change callback; listener exceptions are isolated and
   *   never propagate to the emitter
   * @returns An idempotent unsubscribe function
   */
  subscribe(listener: (event: PresetChangeEvent) => void): () => void;
}

export type {
  ModelPreset,
  PresetModelConfig,
  PresetChangeType,
  PresetChangeEvent,
  PresetCatalogStorageAdapter,
  PresetCatalogOptions,
  PresetCatalog
} from './types.ts';
