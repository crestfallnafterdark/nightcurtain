/**
 * @packageDocumentation
 * Formal contract for the `modelConfig` sandbox module (`index.ts`) —
 * the single home for the master `AgentModelConfig` default and the approved
 * model presets.
 *
 * ### Responsibilities
 * - Master `AgentModelConfig` default (`getDefaultModelConfig`).
 * - The approved presets (`PRESET_MODELS`: `runware`, `nanogpt`, `deepseek`,
 *   `prem`, `custom`).
 * - Provider → default model id lookup (`getDefaultModelId`).
 * - Explicit → default resolution with `'inherit'` sentinel stripping
 *   (`resolveModelConfig`).
 * - Convenience type re-export of `AgentModelConfig` (single home remains
 *   MOD-15 `ProviderInterface.d.ts`).
 *
 * ### Non-responsibilities
 * No ambient reads (`window`/`gameState`/storage/network), no credential
 * storage (MOD-16), no transport/provider selection (MOD-15), no custom user
 * presets (`preset_custom_*` stay in `SettingsModal` local storage).
 *
 * Literal provenance (anchored to commit `f002725`, where the literals lived
 * at the consumers; both files now import this module):
 * - `src/lib/components/SettingsModal.svelte@f002725:53-116` (`BASE_PRESETS`).
 * - `src/lib/utils/storage.js@f002725:59-65` (master `settings.modelConfig`).
 *
 * Preserved quirks:
 * - `custom` is included as-is (placeholder model + localhost URL,
 *   `isCustom: false`); the `isCustom` oddity and placeholder model are
 *   preserved verbatim by this module.
 *
 * @module modelConfig
 * @mayImport type-only ../inference/index.ts
 * @mustNotImport ../runtime/*
 * @invariant Pure: zero runtime imports; deterministic outputs; no import-time side effects.
 * @invariant `PRESET_MODELS` and every nested config are frozen; `getDefaultModelConfig()` returns a fresh shallow copy per call.
 * @invariant `resolveModelConfig()` always returns `providerId`, `keyId`, and `modelId` — never `undefined` or `'inherit'`.
 * @invariant The master default and `PRESET_MODELS` carry `keyId` references only; no secret material.
 * @invariant `resolveModelConfig()` overlays caller-supplied fields verbatim (untrusted, no sanitization/filtering); callers must not supply secrets.
 * @decision Master default and preset literals have their single home in this module
 * @decision Resolution overlays explicit non-`'inherit'` `settings.modelConfig` fields onto the module default; missing `keyId` derives `canonical_<providerId>`
 * @decision `custom` preset is included verbatim (placeholder model, localhost URL, `isCustom: false`)
 */

import type { AgentModelConfig } from '../inference/index.ts';

// ============================================================================
// 1. Data schema
// ============================================================================

/**
 * An approved base preset entry. `id`/`modelConfig.providerId` are
 * kept identical for the five base entries; `modelConfig` is a complete config.
 *
 * Exported because it is the element type of the public `PRESET_MODELS`
 * constant (`ae-forgotten-export` guard).
 */
export interface ModelPreset {
  /** Preset id (`'runware'` | `'nanogpt'` | `'deepseek'` | `'prem'` | `'custom'`). */
  id: string;

  /** Display name, verbatim from the source `BASE_PRESETS` literal (`SettingsModal.svelte@f002725`). */
  name: string;

  /** Base entries are all `false` (the current oddity is preserved as-is). */
  isCustom: boolean;

  /**
   * Full model config: providerId, keyId, modelId, temperature,
   * reasoningEffort, plus `routing`/`url` where present today.
   */
  modelConfig: AgentModelConfig;
}

// ============================================================================
// 2. Type re-export (single home remains MOD-15)
// ============================================================================

export type { AgentModelConfig } from '../inference/index.ts';

// ============================================================================
// 3. Preset catalog
// ============================================================================

/**
 * Master `AgentModelConfig` default, verbatim from `utils/storage.js@f002725:59-65`.
 * Frozen: callers receive copies through `getDefaultModelConfig()`.
 */
const MASTER_MODEL_CONFIG: Readonly<AgentModelConfig> = Object.freeze({
  providerId: 'deepseek',
  keyId: 'canonical_deepseek',
  modelId: 'deepseek-flash',
  temperature: 0.7,
  reasoningEffort: 'high'
});

/**
 * The five approved base presets (4 approved providers + `custom`), moved
 * verbatim from the `SettingsModal.svelte@f002725:53-116` (`BASE_PRESETS`)
 * literal; `SettingsModal.svelte` now consumes this module. Custom user
 * presets (`preset_custom_*`) stay in `SettingsModal` local storage.
 *
 * Frozen array of frozen `ModelPreset` entries; every nested `modelConfig` is
 * frozen as well.
 *
 * @example
 * ```typescript
 * import { PRESET_MODELS } from './index.ts';
 *
 * const ids = PRESET_MODELS.map(preset => preset.id);
 * // ['runware', 'nanogpt', 'deepseek', 'prem', 'custom']
 * ```
 */
export const PRESET_MODELS: readonly ModelPreset[] = Object.freeze([
  Object.freeze<ModelPreset>({
    id: 'runware',
    name: 'Runware',
    isCustom: false,
    modelConfig: Object.freeze<AgentModelConfig>({
      providerId: 'runware',
      keyId: 'canonical_runware',
      modelId: 'deepseek-v4-flash',
      temperature: 0.7,
      reasoningEffort: 'max'
    })
  }),
  Object.freeze<ModelPreset>({
    id: 'nanogpt',
    name: 'NanoGPT',
    isCustom: false,
    modelConfig: Object.freeze<AgentModelConfig>({
      providerId: 'nanogpt',
      keyId: 'canonical_nanogpt',
      modelId: 'deepseek/deepseek-v4.1-flash:thinking',
      temperature: 0.7,
      reasoningEffort: 'high',
      routing: 'auto'
    })
  }),
  Object.freeze<ModelPreset>({
    id: 'deepseek',
    name: 'DeepSeek Native',
    isCustom: false,
    modelConfig: Object.freeze<AgentModelConfig>({
      providerId: 'deepseek',
      keyId: 'canonical_deepseek',
      modelId: 'deepseek-flash',
      temperature: 0.7,
      reasoningEffort: 'high'
    })
  }),
  Object.freeze<ModelPreset>({
    id: 'prem',
    name: 'Prem AI',
    isCustom: false,
    modelConfig: Object.freeze<AgentModelConfig>({
      providerId: 'prem',
      keyId: 'canonical_prem',
      modelId: 'deepseek-v4-flash-abliterated',
      temperature: 0.7,
      reasoningEffort: 'high'
    })
  }),
  Object.freeze<ModelPreset>({
    id: 'custom',
    name: 'Custom OpenAI Completion',
    isCustom: false,
    modelConfig: Object.freeze<AgentModelConfig>({
      providerId: 'custom',
      keyId: 'canonical_custom',
      modelId: 'custom-completion-model',
      url: 'http://localhost:11434/v1',
      temperature: 0.7,
      reasoningEffort: 'none'
    })
  })
]);

// ============================================================================
// 4. Module functions
// ============================================================================

/**
 * Returns a fresh shallow copy of the master default model config.
 *
 * Mutation isolation: each call returns a new object, so
 * callers may freely adjust the copy without affecting the frozen master or
 * other callers' copies.
 *
 * @returns A fresh copy of the master default.
 */
export function getDefaultModelConfig(): AgentModelConfig {
  return { ...MASTER_MODEL_CONFIG };
}

/**
 * Resolves the default model id for a provider from the preset catalog.
 *
 * Lookup is by `modelConfig.providerId`: `runware` →
 * `'deepseek-v4-flash'`, `nanogpt` → `'deepseek/deepseek-v4.1-flash:thinking'`,
 * `deepseek` → `'deepseek-flash'`, `prem` → `'deepseek-v4-flash-abliterated'`,
 * `custom` → `'custom-completion-model'`. Unknown or omitted providers fall
 * back to the master `modelId`. Vendor-alias normalization
 * (`deepseek_native` ↔ `deepseek`) is not performed here:
 * `deepseek_native` is treated as unknown and falls back to the master
 * `modelId`.
 *
 * @param providerId - Provider id to look up (e.g. `'runware'`).
 * @returns The preset's `modelId`, or the master `modelId` when unknown/omitted.
 */
export function getDefaultModelId(providerId?: string): string {
  if (providerId) {
    const preset = PRESET_MODELS.find(p => p.modelConfig.providerId === providerId);
    if (preset) return preset.modelConfig.modelId;
  }
  return MASTER_MODEL_CONFIG.modelId;
}

/**
 * Resolves a complete model config from an optional partial settings layer.
 *
 * Semantics:
 * - Starts from the module default.
 * - Overlays every `settings.modelConfig` field that is present (not
 *   `undefined`) and not the `'inherit'` UI sentinel; absent/`'inherit'` fields
 *   fall through to the default layer.
 * - When the explicit layer omits `keyId` but supplies a `providerId`,
 *   derives `canonical_<providerId>` so a provider switch does not keep the
 *   master provider's credential reference.
 * - Always returns a complete config (`providerId`, `keyId`, `modelId`), never
 *   emitting `'inherit'`; never mutates `settings`.
 *
 * Trust boundary: the overlay is untrusted and copied verbatim — every present
 * field (including keys not known to `AgentModelConfig`) passes through with no
 * sanitization or filtering. Secret material (`apiKey`, `encryptionKey`, …)
 * supplied by the caller appears on the returned config; callers must not put
 * secrets in `settings.modelConfig`.
 *
 * `resolveModelConfig()` is equivalent to `getDefaultModelConfig()`.
 *
 * @param settings - Optional settings layer carrying a partial `modelConfig`.
 * @returns A complete resolved model config.
 */
export function resolveModelConfig(
  settings?: { modelConfig?: Partial<AgentModelConfig> } | null
): AgentModelConfig {
  const explicit: Partial<AgentModelConfig> = {};
  const overlay = settings ? settings.modelConfig : null;
  if (overlay) {
    for (const key of Object.keys(overlay)) {
      const value = overlay[key];
      if (value === undefined || value === 'inherit') continue;
      explicit[key] = value;
    }
  }
  if (!explicit.keyId && explicit.providerId) {
    explicit.keyId = `canonical_${explicit.providerId}`;
  }
  return { ...MASTER_MODEL_CONFIG, ...explicit };
}
