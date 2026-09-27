/**
 * Settings-panel-local resolver for the tool-permission form state
 * (`toolPreset` + comma-separated whitelist) against the live agent config.
 *
 * Ticket 6a0282b (F10): an absent `allowedTools` selector is default-deny
 * runtime capability, not Full Access. The runtime derives a privileged
 * agent's wildcard from `config.privileged`, never from a missing list, so the
 * panel must not present `*` for a withheld/degraded capability state; an
 * explicit `'*'` list (or a privileged agent) is the only Full Access reading.
 * The parser mirrors the same rule in the other direction: only an explicit
 * `*` is the wildcard, and a blank whitelist persists default-deny instead of
 * silently widening to `*`.
 */

import { TOOL_PRESETS } from '../../sandbox/toolDefinitions/index.ts';

/**
 * Form-state projection of an agent's tool-permission axis.
 *
 * `toolPreset` is a named preset key, `'all'` (the explicit wildcard),
 * or `'custom'`; `toolsString` is the comma-separated whitelist shown in the
 * editor.
 */
export interface AgentToolFormState {
  /** Selected preset key (`all`/`manager`/`collaborator`/`readonly_collaborator`/`readonly`/`custom`). */
  readonly toolPreset: string;
  /** Comma-separated whitelist text (`*` for Full Access). */
  readonly toolsString: string;
}

/** Named presets in the settings panel's display order. */
const NAMED_PRESET_KEYS: readonly string[] = Object.freeze([
  'manager',
  'collaborator',
  'readonly_collaborator',
  'readonly'
]);

/**
 * Resolves the tool-permission form state from the live agent config.
 *
 * A missing selector reads `custom` with an empty whitelist (default-deny,
 * matching the runtime) unless the agent is privileged, whose wildcard comes
 * from `config.privileged` and reads Full Access; an explicit `'*'` list reads
 * Full Access; a list exactly matching a named preset reads that preset;
 * anything else reads `custom` with the literal list.
 *
 * @param config - Live agent config (or a structural equivalent).
 * @returns The form state the panel must display.
 */
export function resolveAgentToolFormState(
  config: { readonly allowedTools?: unknown; readonly privileged?: unknown } | null | undefined
): AgentToolFormState {
  const rawTools = Array.isArray(config?.allowedTools)
    ? config.allowedTools
    : (config?.allowedTools === '*' ? ['*'] : null);

  if (rawTools === null) {
    return config?.privileged === true
      ? { toolPreset: 'all', toolsString: '*' }
      : { toolPreset: 'custom', toolsString: '' };
  }
  const currentJoined = rawTools.map((tool) => String(tool)).join(', ');
  if (rawTools.length === 1 && String(rawTools[0]) === '*') {
    return { toolPreset: 'all', toolsString: '*' };
  }
  for (const presetKey of NAMED_PRESET_KEYS) {
    const presetTools = TOOL_PRESETS[presetKey as keyof typeof TOOL_PRESETS];
    if (Array.isArray(presetTools) && currentJoined === presetTools.join(', ')) {
      return { toolPreset: presetKey, toolsString: currentJoined };
    }
  }
  return { toolPreset: 'custom', toolsString: currentJoined };
}

/**
 * Parses the comma-separated whitelist editor value into the grant list to
 * persist. Only an explicit `*` is the wildcard; a blank value parses to the
 * empty (default-deny) list — never a silent Full Access widening.
 *
 * @param toolsString - Raw editor value.
 * @returns The parsed grant list (`['*']` for the explicit wildcard).
 */
export function parseAllowedToolsInput(toolsString: string): string[] {
  if (toolsString.trim() === '*') return ['*'];
  return toolsString.split(',').map((tool) => tool.trim()).filter(Boolean);
}
