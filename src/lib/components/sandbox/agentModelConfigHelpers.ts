/**
 * Shared agent model-config presentation helpers (tickets 1448f5a, 8de6b9d).
 *
 * Pure, framework-free projections used by `AgentInspector.svelte` (the bound
 * preset's effective model config, including the Temp chip) and by the preset
 * editors (`AgentSettingsPanel.svelte` and `SandboxSettingsModal.svelte`,
 * provider-capability-gated field visibility and config building).
 *
 * The capability vocabulary itself has its single home in the `modelConfig`
 * sandbox module ({@link getProviderCapabilities}); this module only adapts it
 * to the editor field shapes and owns the shared resolution/build semantics,
 * so the two editors can never disagree.
 */

import { getProviderCapabilities } from '../../sandbox/modelConfig/index.ts';

/** Capability-gated visibility of the two provider-specific preset fields. */
export interface PresetEditorFieldVisibility {
  /** Whether the Routing Provider field applies to the provider. */
  readonly routing: boolean;

  /** Whether the Endpoint URL field applies to the provider. */
  readonly url: boolean;
}

/** Editable draft values of the agent-level preset editor. */
export interface PresetEditorDraft {
  /** Model id (trimmed on build). */
  readonly modelId: string;

  /** Temperature (numeric, or the string a range input may hand back). */
  readonly temperature: number | string;

  /** Reasoning effort (emitted when non-empty). */
  readonly reasoningEffort?: string;

  /** Routing provider (emitted only when the provider supports routing). */
  readonly routing?: string;

  /** Endpoint URL (emitted only when the provider supports a custom endpoint). */
  readonly url?: string;
}

/** Structural read surface of the agent needed to resolve its model config. */
export interface AgentModelConfigHost {
  /** Agent runtime config carrying the preset binding and cached model config. */
  readonly config?: {
    /** Bound catalog preset id (trimmed before resolution). */
    readonly presetId?: unknown;

    /** Cached runtime model config, used only when the binding cannot resolve. */
    readonly modelConfig?: Readonly<Record<string, unknown>> | null;
  } | null;
}

/** Minimal preset-catalog read surface consumed by the resolver. */
export interface PresetCatalogReader {
  /**
   * Resolves one catalog preset by id.
   *
   * @param id - Catalog preset id.
   * @returns The preset copy, or `null` when unknown.
   */
  getPreset(id: string): { readonly modelConfig: Readonly<Record<string, unknown>> } | null;
}

/**
 * Resolves the agent's effective model config with the bound-preset-first
 * precedence shared by the Agent Inspector and the Agent Settings preset
 * editor: the bound catalog preset (`config.presetId`, trimmed) when it
 * resolves, else the agent runtime copy (`config.modelConfig`), else the
 * injected fallback (the store's global model config).
 *
 * @param agent - Agent snapshot/entity carrying `config` (null-safe).
 * @param catalog - Preset catalog read surface (null-safe).
 * @param fallback - Last-resort model config (the store default).
 * @returns The resolved config, or the fallback when nothing resolves.
 */
export function resolveAgentModelConfig(
  agent: AgentModelConfigHost | null | undefined,
  catalog: PresetCatalogReader | null | undefined,
  fallback: Readonly<Record<string, unknown>> | null | undefined
): Readonly<Record<string, unknown>> | null | undefined {
  const boundPresetId = typeof agent?.config?.presetId === 'string' ? agent.config.presetId.trim() : '';
  const boundModelConfig = boundPresetId
    ? catalog?.getPreset(boundPresetId)?.modelConfig
    : undefined;
  if (boundModelConfig) return boundModelConfig;
  return agent?.config?.modelConfig || fallback;
}

/**
 * Maps a provider id onto the editor-field visibility flags consumed by the
 * preset editors (routing only for `nanogpt`, URL only for `custom`; every
 * other/unknown provider exposes neither field).
 *
 * @param providerId - Provider id from the edited preset (unknown-safe).
 * @returns The visibility flags derived from the single capability source.
 */
export function presetEditorFieldVisibility(providerId: unknown): PresetEditorFieldVisibility {
  const capabilities = getProviderCapabilities(typeof providerId === 'string' ? providerId : undefined);
  return { routing: capabilities.supportsRouting, url: capabilities.supportsUrl };
}

/**
 * Builds a preset model config from the editor draft, capability-gated.
 *
 * Semantics (the agent-level editor's save path, ticket 1448f5a):
 * - starts from a copy of the bound preset's base config (provider identity
 *   and unrelated fields survive);
 * - `modelId` is trimmed, `temperature` is coerced to a number, and
 *   `reasoningEffort` is emitted when non-empty;
 * - `routing` is emitted only when the provider supports routing and the
 *   draft value is non-empty, and `url` only when the provider supports a
 *   custom endpoint and the draft value is non-empty;
 * - every unsupported `routing`/`url` value is deleted from the result, so no
 *   dead field is ever persisted into a catalog preset.
 *
 * @param draft - Editor draft values.
 * @param base - Bound preset's current model config (may be absent).
 * @param capabilities - Visibility flags from {@link presetEditorFieldVisibility}.
 * @returns A fresh credential-free model config.
 */
export function buildPresetModelConfig(
  draft: PresetEditorDraft | null | undefined,
  base: Readonly<Record<string, unknown>> | null | undefined,
  capabilities: PresetEditorFieldVisibility | null | undefined
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(base ?? {}) };
  config.modelId = typeof draft?.modelId === 'string' ? draft.modelId.trim() : '';
  config.temperature = Number(draft?.temperature);

  const reasoning = typeof draft?.reasoningEffort === 'string' ? draft.reasoningEffort.trim() : '';
  if (reasoning) config.reasoningEffort = reasoning;

  const routing = typeof draft?.routing === 'string' ? draft.routing.trim() : '';
  if (capabilities?.routing && routing) config.routing = routing;
  else delete config.routing;

  const url = typeof draft?.url === 'string' ? draft.url.trim() : '';
  if (capabilities?.url && url) config.url = url;
  else delete config.url;

  return config;
}
