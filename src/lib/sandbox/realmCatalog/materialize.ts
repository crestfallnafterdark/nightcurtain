/**
 * Template materialization for the `realmCatalog` module: turns a validated
 * template plus launch options into a deeply frozen, deterministic launch plan
 * carrying composed system prompts, input provenance, and the resolved seed.
 */

import {
  composeAgentHistory,
  composeSystemPrompt,
  resolveAgentHistoryInputValues,
  resolveSeedManifest
} from './compose.ts';
import { deepFreeze } from './freeze.ts';
import {
  isPlainRecord,
  requireNonEmptyString,
  resolveAgentId,
  resolveToolProfile,
  validateTemplate
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
function validateIdOverrides(candidate: unknown, template: RealmTemplate): Record<string, string> {
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
 * The whole template is validated before any plan is built, so a rejected
 * template produces no partial output. Agent ids resolve as literal plain ids
 * from `idPattern` with per-key `idOverrides` winning over the pattern; the
 * realm id is membership metadata only and never prefixes an agent id
 * (realm-opaque ids, Wave R ticket ff2202a). Tool profiles resolve through the
 * canonical preset resolver, and each agent's system prompt is composed from
 * its declared parts: `text` verbatim, `file` bodies resolved from
 * `bundleFiles`, `input` values resolved launch → default → defaultFile →
 * empty (an empty input contributes nothing, and a `required` empty input
 * fails closed). The plan also carries the resolved seed manifest when the
 * template declares one. Duplicate keys, duplicate resolved ids, retired
 * placeholder patterns, unknown presets, ambiguous or absent tool profiles,
 * undeclared input references, duplicate input ids, missing bundle entries,
 * and unknown override or input-value keys are rejected. Agent ids are
 * ordinary labels — no id is reserved, so any non-empty id is legal.
 *
 * @param template - Template to materialize
 * @param options - Target realm id, optional per-key id overrides, launch input values, and bundle files
 * @returns A deeply frozen, deterministic launch plan in template order
 * @throws `Error` - When the template, options, resolved ids, composition, or seed are invalid
 *
 * @example
 * ```typescript
 * import { DEMO_TEMPLATE, materializeTemplate } from './realmCatalog/index.ts';
 *
 * const plan = materializeTemplate(DEMO_TEMPLATE, { realmId: 'realm_1' });
 * // plan.agents[0].agentId === 'coordinator' (never 'realm_1-coordinator')
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
  const validated = validateTemplate(template);
  const requirementIds: ReadonlySet<string> = new Set(
    (validated.toolContract?.requirements ?? []).map((requirement) => requirement.id)
  );
  const overrides = validateIdOverrides(options.idOverrides, validated);
  const composeOptions: RealmComposeOptions = {
    ...(options.inputValues !== undefined ? { inputValues: options.inputValues } : {}),
    ...(options.bundleFiles !== undefined ? { bundleFiles: options.bundleFiles } : {}),
    ...(options.hydrationFiles !== undefined ? { hydrationFiles: options.hydrationFiles } : {})
  };
  const bundleFiles = isPlainRecord(options.bundleFiles) ? options.bundleFiles : {};

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
    const history = composeAgentHistory(
      spec,
      resolveAgentHistoryInputValues(spec, validated.inputs, composeOptions),
      bundleFiles
    );
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

  const resolvedSeed = validated.seed !== undefined
    ? resolveSeedManifest(validated.seed, composeOptions)
    : undefined;

  return deepFreeze({
    templateId: validated.id,
    realmId,
    ...(resolvedSeed !== undefined ? { seed: resolvedSeed } : {}),
    agents
  });
}
