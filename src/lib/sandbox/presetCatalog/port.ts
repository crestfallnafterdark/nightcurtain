/**
 * Frozen runtime projection for the `presetCatalog` module.
 */

import type { ModelPresetSourcePort } from './index.ts';
import type { ModelPreset, PresetChangeEvent } from './types.ts';

/**
 * Builds the frozen `ModelPresetSourcePort` projection over catalog accessors.
 *
 * @param deps - Catalog accessor functions; `getPreset` already returns frozen
 * copies and `subscribe` already isolates listener exceptions
 * @returns A frozen plain-object port; every method delegates to the catalog
 */
export function createPresetSourcePort(deps: {
  getPreset(id: string): ModelPreset | null;
  getDefaultPresetId(): string;
  subscribe(listener: (event: PresetChangeEvent) => void): () => void;
}): ModelPresetSourcePort {
  return Object.freeze({
    getPreset: (id: string) => deps.getPreset(id),
    getDefaultPresetId: () => deps.getDefaultPresetId(),
    subscribe: (listener: (event: PresetChangeEvent) => void) => deps.subscribe(listener)
  });
}
