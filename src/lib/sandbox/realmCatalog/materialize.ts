/**
 * Template materialization for the `realmCatalog` module: turns a validated
 * template plus launch options into a deeply frozen, deterministic launch plan
 * carrying composed system prompts, input provenance, resolved placements and
 * directives, and the agent plans.
 */

import {
  composeAgentHistory,
  composeSystemPrompt,
  resolveDirectives,
  resolvePlacements
} from './compose.ts';
import { deepFreeze } from './freeze.ts';
import { normalizeTemplate } from './legacy.ts';
import {
  isPlainRecord,
  requireNonEmptyString,
  resolveAgentId,
  resolveToolProfile
} from './validation.ts';
import type {
  RealmComposeOptions,
  RealmLaunchAgentPlan,
  RealmLaunchPlan,
  RealmMaterializeOptions,
  RealmTemplate
} from './types.ts';

/**
 * Validates the per-key id-override map: keys must name template agent keys and
 * values must be non-empty strings.
 *
 * @param candidate - Candidate override value from the materialization options
 * @param template - Validated template the overrides target
 * @returns The validated override map (empty when absent)
 */
function validateIdOverrides(
  candidate: unknown,
  template: { agents: readonly { key: string }[] }
): Record<string, string> {
  if (candidate === undefined) return {};
  if (!isPlainRecord(candidate)) {
    throw new Error('materializeTemplate idOverrides must be a record of agent key to id');
  }
  const knownKeys: ReadonlySet<string> = new Set(template.agents.map((spec) => spec.key));
  for (const key of Object.keys(candidate)) {
    if (!knownKeys.has(key)) {
      throw new Error(`materializeTemplate idOverrides names unknown agent key '${key}'`);
    }
    requireNonEmptyString(candidate[key], `materializeTemplate idOverrides['${key}']`);
  }
  return candidate as Record<string, string>;
}

/**
 * Materializes a template into a frozen launch plan.
 *
 * The template normalizes first (a legacy format-v1 document shims to the
 * canonical model), then the whole plan is built in one pass: agent ids
 * resolve as literal plain ids from `idPattern` with per-key `idOverrides`
 * winning over the pattern; each agent's system prompt composes from its
 * declared parts (`text` verbatim, `file` bodies from `bundleFiles`, `input`
 * values resolved supplied → default → defaultFile → empty, with `files`
 * inputs selecting one named file and `required` empty values failing closed);
 * baked history composes through the same part model; placements resolve to
 * concrete workspace writes; and directives resolve to launch messages.
 * Duplicate keys, duplicate resolved ids, retired placeholder patterns,
 * unknown presets, ambiguous or absent tool profiles, undeclared input
 * references, missing bundle entries, fileset selection mismatches, placement
 * destination collisions, and unknown override or input keys are rejected.
 *
 * @param template - Template to materialize (legacy format-v1 documents accepted)
 * @param options - Target realm id, optional per-key id overrides, supplied input values, and bundle files
 * @returns A deeply frozen, deterministic launch plan in template order
 * @throws `Error` - When the template, options, resolved ids, composition, placements, or directives are invalid
 *
 * @example
 * ```typescript
 * import { materializeTemplate } from './realmCatalog/index.ts';
 *
 * const plan = materializeTemplate(DEMO_TEMPLATE, { realmId: 'realm_1' });
 * // plan.placements, plan.directives, plan.agents
 * ```
 */
export function materializeTemplate(
  template: RealmTemplate,
  options: RealmMaterializeOptions
): RealmLaunchPlan {
  if (!isPlainRecord(options)) {
    throw new Error('materializeTemplate requires an options object');
  }
  const realmId = requireNonEmptyString(options.realmId, 'materializeTemplate realmId');
  const validated = normalizeTemplate(template);
  const requirementIds: ReadonlySet<string> = new Set(
    (validated.toolContract?.requirements ?? []).map((requirement) => requirement.id)
  );
  const overrides = validateIdOverrides(options.idOverrides, validated);
  const composeOptions: RealmComposeOptions = {
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
    ...(options.bundleFiles !== undefined ? { bundleFiles: options.bundleFiles } : {})
  };

  const seenIds: Set<string> = new Set();
  const agents: RealmLaunchAgentPlan[] = validated.agents.map((spec) => {
    // Own-property read: an undeclared override must never resolve through the
    // prototype chain (T-V finding F1, ticket e4c8f91).
    const override = Object.prototype.hasOwnProperty.call(overrides, spec.key) ? overrides[spec.key] : undefined;
    const agentId = resolveAgentId(spec.key, spec.idPattern, override);
    if (seenIds.has(agentId)) {
      throw new Error(`template materializes duplicate agent id '${agentId}'`);
    }
    seenIds.add(agentId);
    const composed = composeSystemPrompt(spec.prompt, validated.inputs, composeOptions);
    const history = composeAgentHistory(spec, validated.inputs, composeOptions);
    return {
      key: spec.key,
      agentId,
      name: spec.name,
      role: spec.role,
      systemPrompt: composed.systemPrompt,
      inputProvenance: composed.inputProvenance,
      history,
      toolProfile: resolveToolProfile(spec.toolProfile, `agent '${spec.key}' toolProfile`, requirementIds),
      privileged: spec.privileged,
      authorities: spec.authorities ?? [],
      ...(spec.triggerPolicy !== undefined ? { triggerPolicy: spec.triggerPolicy } : {}),
      ...(spec.modelPresetId !== undefined ? { modelPresetId: spec.modelPresetId } : {}),
      ...(spec.initialPrompt !== undefined ? { initialPrompt: spec.initialPrompt } : {})
    };
  });

  const placements = resolvePlacements(validated.placements ?? [], validated.inputs, composeOptions);
  const directives = resolveDirectives(validated.directives ?? [], validated.inputs, composeOptions);

  return deepFreeze({
    templateId: validated.id,
    realmId,
    placements,
    directives,
    agents
  });
}
