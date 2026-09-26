/**
 * Capability-summary projection for the `realmCatalog` module: resolves a
 * template agent spec's declared tool profile into the honest per-agent
 * display model consumed by the Realm launcher preview.
 */

import { MUTATING_TOOLS, READ_ONLY_TOOLS, SANDBOX_TOOLS } from '../tools/constants/index.ts';
import { getCanonToolName } from '../tools/normalizers/index.ts';
import { deepFreeze } from './freeze.ts';
import { CAPABILITY_WILDCARD_SOURCES } from './types.ts';
import { createToolGrantContext, resolveToolProfile, validateAgentSpec } from './validation.ts';
import type { RealmToolGrantContext } from './validation.ts';
import type {
  AgentCapabilitySummary,
  CapabilityWildcardSource,
  RealmAgentSpec,
  RealmProvider,
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
 * grants (`'*'`) report full vocabulary coverage, declared legacy requirement
 * ids (from the owning template's `toolContract`) and extension tool
 * references (from the declared providers) surface in `grants` as their
 * derived model-facing call names (`text.similarity` → `text_similarity`,
 * `acme::docs.search` → `docs_search`, `deriveToolCallName`) without a
 * mutation classification, and grants that map to no canonical tool and no
 * declared requirement are surfaced verbatim in `unrecognized`. A privileged
 * spec reports effective wildcard capability regardless of its declared
 * profile, matching the runtime authority derivation.
 *
 * @param spec - Agent spec to summarize
 * @param requirements - The owning template's declared legacy tool requirements, when the spec references requirement ids
 * @param providers - The owning template's declared providers, when the spec references extension tools
 * @returns A deeply frozen capability summary
 * @throws `Error` - When the spec, its tool profile, its requirement references, or its extension references are invalid
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
  requirements?: readonly RealmToolRequirement[],
  providers?: readonly RealmProvider[]
): AgentCapabilitySummary {
  const toolContract = requirements === undefined ? undefined : { requirements };
  const grantContext = createToolGrantContext(toolContract, providers, 'summarizeAgentCapabilities');
  const validated = validateAgentSpec(spec, 'agent spec', grantContext);
  return summarizeValidatedAgent(validated, grantContext);
}

/**
 * Projects one validated agent spec into the capability summary display model.
 *
 * @param validated - Validated agent spec
 * @param grantContext - Validated per-template grant context
 * @returns A deeply frozen capability summary
 */
function summarizeValidatedAgent(
  validated: RealmAgentSpec,
  grantContext: RealmToolGrantContext
): AgentCapabilitySummary {
  const profile = resolveToolProfile(validated.toolProfile, `agent '${validated.key}' toolProfile`, grantContext);

  /** Derived call names of the declared requirements and validated extension references. */
  const derivedCallNameSet: ReadonlySet<string> = new Set(grantContext.sourceByCallName.keys());

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
      if (derivedCallNameSet.has(grant)) {
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
