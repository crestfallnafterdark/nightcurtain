/**
 * Capability-summary projection for the `realmCatalog` module: resolves a
 * template agent spec's declared tool profile into the honest per-agent
 * display model consumed by the Realm launcher preview.
 */

import { MUTATING_TOOLS, READ_ONLY_TOOLS, SANDBOX_TOOLS } from '../tools/constants/index.ts';
import { getCanonToolName } from '../tools/normalizers/index.ts';
import { deepFreeze } from './freeze.ts';
import { CAPABILITY_WILDCARD_SOURCES } from './types.ts';
import { deriveToolCallName, requireNonEmptyString, resolveToolProfile, validateAgentSpec } from './validation.ts';
import type {
  AgentCapabilitySummary,
  CapabilityWildcardSource,
  RealmAgentSpec,
  RealmToolRequirement
} from './types.ts';

/** Membership probe over the canonical mutating-tool vocabulary. */
const MUTATING_TOOL_SET: ReadonlySet<string> = new Set(MUTATING_TOOLS);

/** Every canonical tool name (the mutation vocabulary partitions the full set). */
const CANONICAL_TOOL_SET: ReadonlySet<string> = new Set([...MUTATING_TOOLS, ...READ_ONLY_TOOLS]);

/**
 * Aggregate selector carried by the `manager` preset; the dispatcher expands
 * it to the subagent-management tool set.
 */
const SUBAGENT_MANAGEMENT_SELECTOR = 'subagent_management';

/** Canonical tools unlocked by the aggregate selector, in canonical order. */
const SUBAGENT_MANAGEMENT_TOOLS: readonly string[] = Object.freeze([
  SANDBOX_TOOLS.SPAWN_AGENT,
  SANDBOX_TOOLS.KILL_AGENT,
  SANDBOX_TOOLS.INVOKE_AGENT,
  SANDBOX_TOOLS.UNDO_TURN
]);

/**
 * Builds the honest capability summary for one template agent spec.
 *
 * The declared profile resolves through the canonical preset resolver; each
 * grant is then canonicalized through the tool alias resolver and classified
 * against the canonical mutation vocabulary. The aggregate
 * subagent-management selector expands to its canonical tools, wildcard
 * grants (`'*'`) report full vocabulary coverage, declared requirement ids
 * (from the owning template's `toolContract`) surface in `grants` as their
 * derived model-facing call names (`text.similarity` → `text_similarity`,
 * `deriveToolCallName`) without a mutation classification, and grants that map
 * to no canonical tool and no declared requirement are surfaced verbatim in
 * `unrecognized`. A privileged spec reports effective wildcard capability
 * regardless of its declared profile, matching the runtime authority
 * derivation.
 *
 * @param spec - Agent spec to summarize
 * @param requirements - The owning template's declared tool requirements, when the spec references requirement ids
 * @returns A deeply frozen capability summary
 * @throws `Error` - When the spec, its tool profile, or its requirement references are invalid
 *
 * @example
 * ```typescript
 * import { DEMO_TEMPLATE, summarizeAgentCapabilities } from './realmCatalog/index.ts';
 *
 * const preview = summarizeAgentCapabilities(DEMO_TEMPLATE.agents[1]);
 * // preview.mutating includes 'get_inbox' (mail consumption mutates state)
 * ```
 */
export function summarizeAgentCapabilities(
  spec: RealmAgentSpec,
  requirements?: readonly RealmToolRequirement[]
): AgentCapabilitySummary {
  const requirementCallNames = collectRequirementCallNames(requirements, 'summarizeAgentCapabilities');
  const validated = validateAgentSpec(spec, 'agent spec', requirementCallNames);
  return summarizeValidatedAgent(validated, requirementCallNames);
}

/**
 * Validates and collects an optional requirement list into an id → derived
 * call-name map.
 *
 * @param requirements - Declared tool requirements, when supplied
 * @param label - Human-readable label used in error messages
 * @returns Declared ids mapped to derived call names, or `undefined` when no list was supplied
 */
function collectRequirementCallNames(
  requirements: readonly RealmToolRequirement[] | undefined,
  label: string
): ReadonlyMap<string, string> | undefined {
  if (requirements === undefined) return undefined;
  const callNames: Map<string, string> = new Map();
  requirements.forEach((requirement, index) => {
    const id = requireNonEmptyString(requirement?.id, `${label} requirements[${index}] id`);
    callNames.set(id, deriveToolCallName(id));
  });
  return callNames;
}

/**
 * Projects one validated agent spec into the capability summary display model.
 *
 * @param validated - Validated agent spec
 * @param requirementCallNames - Declared requirement ids mapped to derived call names, when known
 * @returns A deeply frozen capability summary
 */
function summarizeValidatedAgent(
  validated: RealmAgentSpec,
  requirementCallNames: ReadonlyMap<string, string> | undefined
): AgentCapabilitySummary {
  const profile = resolveToolProfile(validated.toolProfile, `agent '${validated.key}' toolProfile`, requirementCallNames);

  /** Derived call names of the declared requirements (the resolved grant form). */
  const requirementCallNameSet: ReadonlySet<string> = new Set(requirementCallNames?.values() ?? []);

  const grants: string[] = [];
  const mutating: string[] = [];
  const readOnly: string[] = [];
  const unrecognized: string[] = [];
  const seen: Set<string> = new Set();
  let declaredWildcard = false;
  let declaredManagement = false;

  for (const grant of profile.tools) {
    if (grant === '*') {
      declaredWildcard = true;
      continue;
    }
    const canonical = getCanonToolName(grant);
    if (canonical === null) {
      if (requirementCallNameSet.has(grant)) {
        if (!seen.has(grant)) {
          seen.add(grant);
          grants.push(grant);
        }
        continue;
      }
      unrecognized.push(grant);
      grants.push(grant);
      continue;
    }
    if (canonical === SUBAGENT_MANAGEMENT_SELECTOR) {
      declaredManagement = true;
      for (const tool of SUBAGENT_MANAGEMENT_TOOLS) {
        if (seen.has(tool)) continue;
        seen.add(tool);
        grants.push(tool);
        mutating.push(tool);
      }
      continue;
    }
    if (!CANONICAL_TOOL_SET.has(canonical)) {
      unrecognized.push(canonical);
      grants.push(canonical);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    grants.push(canonical);
    if (MUTATING_TOOL_SET.has(canonical)) mutating.push(canonical);
    else readOnly.push(canonical);
  }

  const wildcardSource: CapabilityWildcardSource = validated.privileged
    ? CAPABILITY_WILDCARD_SOURCES.PRIVILEGED
    : declaredWildcard
      ? CAPABILITY_WILDCARD_SOURCES.PROFILE
      : CAPABILITY_WILDCARD_SOURCES.NONE;
  const wildcard = wildcardSource !== 'none';

  return deepFreeze({
    key: validated.key,
    idPattern: validated.idPattern,
    name: validated.name,
    role: validated.role,
    privileged: validated.privileged,
    preset: profile.preset,
    grants: wildcard ? ['*'] : grants,
    wildcard,
    wildcardSource,
    subagentManagement: wildcard || declaredManagement,
    mutating: wildcard ? [...MUTATING_TOOLS] : mutating,
    readOnly: wildcard ? [...READ_ONLY_TOOLS] : readOnly,
    unrecognized: wildcard ? [] : unrecognized
  });
}
