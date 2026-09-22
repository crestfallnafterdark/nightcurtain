/**
 * Launcher-local resolver for the tool-permission selection (`toolPreset` +
 * custom whitelist) into the `allowedTools` grant handed to
 * `sandboxStore.launchAgent`.
 *
 * A blank custom whitelist is an explicit validation failure instead of a
 * `['*']` wildcard grant, and custom entries canonicalize through the sandbox
 * alias normalizer so alias spellings grant the tool they name. Named presets
 * resolve through the sandbox preset catalog; `all` / `'*'` stays the explicit
 * intentional wildcard.
 */

import { TOOL_PRESETS, resolveToolPreset } from '../../sandbox/toolDefinitions/index.ts';
import { getCanonToolName } from '../../sandbox/tools/normalizers/index.ts';

/**
 * Result of resolving the launcher's tool-permission selection.
 *
 * `ok: true` carries the canonical grant list; `ok: false` carries a
 * user-facing validation message and the launch must be refused.
 */
export type ToolGrantsResolution =
  | { readonly ok: true; readonly allowedTools: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Resolves the selected tool preset and custom whitelist into the canonical
 * `allowedTools` grant list.
 *
 * Named presets (`all`, `manager`, `collaborator`, `readonly_collaborator`,
 * `readonly`) and the explicit `'*'` selector keep resolving through the
 * sandbox preset catalog, where `all`/`'*'` remain intentional wildcards.
 * Custom input parses through the sandbox preset resolver, must yield at
 * least one entry (blank or whitespace-only input fails validation rather
 * than granting `['*']`), and each entry canonicalizes through the sandbox
 * alias normalizer (`readFile` → `read_file`) with duplicates collapsed.
 *
 * @param toolPreset - Selected profile name (`all`, `manager`, `collaborator`, `readonly_collaborator`, `readonly`), the explicit `'*'` wildcard, or `'custom'`.
 * @param customTools - Raw comma-separated whitelist; read only when `toolPreset` is `'custom'`.
 * @returns Grant resolution; a failure must block the launch and surface `error`.
 *
 * @example
 * ```typescript
 * const grants = resolveToolGrants('custom', 'readFile, send_message');
 * // => { ok: true, allowedTools: ['read_file', 'send_message'] }
 *
 * const blank = resolveToolGrants('custom', '   ');
 * // => { ok: false, error: 'Enter at least one tool name ...' }
 * ```
 */
export function resolveToolGrants(toolPreset: string, customTools: string): ToolGrantsResolution {
  if (toolPreset === 'custom') {
    const parsed = resolveToolPreset(customTools);
    if (parsed.length === 0) {
      return {
        ok: false,
        error: 'Enter at least one tool name for the custom whitelist (comma-separated), or choose a preset.'
      };
    }
    return { ok: true, allowedTools: canonicalizeGrants(parsed) };
  }

  if (toolPreset === '*' || Object.prototype.hasOwnProperty.call(TOOL_PRESETS, toolPreset)) {
    return { ok: true, allowedTools: canonicalizeGrants(resolveToolPreset(toolPreset)) };
  }

  return {
    ok: false,
    error: `Unknown tool permission profile "${toolPreset}". Choose a preset or enter a custom whitelist.`
  };
}

/**
 * Canonicalizes resolved grant entries through the sandbox alias normalizer,
 * collapsing duplicates while preserving first-seen order. Unresolvable
 * entries (and the `'*'` selector) pass through unchanged.
 *
 * @param entries - Resolved preset or custom entries.
 * @returns Canonical, duplicate-free grant list.
 */
function canonicalizeGrants(entries: string[]): string[] {
  const grants: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const canonical = getCanonToolName(entry) ?? entry;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      grants.push(canonical);
    }
  }
  return grants;
}
