/**
 * Model-facing tool call-name derivation and the reserved-name predicate.
 * Private implementation detail of the `tools/normalizers` module; the public surface is `index.ts`.
 */

import { PUBLISHING_TOOLS, SANDBOX_TOOLS } from '../constants/index.ts';
import { getCanonToolName } from './aliasMap.ts';

/**
 * Frozen vocabulary of every baked (`SANDBOX_TOOLS`) and publishing
 * (`PUBLISHING_TOOLS`) tool name. Module-private (never exported) and never
 * mutated after initialization.
 */
const RESERVED_TOOL_DESCRIPTOR_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(SANDBOX_TOOLS),
  ...Object.values(PUBLISHING_TOOLS)
]);

/**
 * Derives the model-facing tool call name from a capability id or a
 * server-side tool name: every character outside `[A-Za-z0-9_]` becomes `_` —
 * per character, with no collapsing, case folding, or trimming, so the
 * derivation is total and deterministic for any input string.
 *
 * The call name is a stability promise: it is what models and providers see
 * (and what plans and capability summaries carry), so it must never change
 * between implementations of the same tool
 * (`text.similarity` → `text_similarity`,
 * `acme.scoring.similarity` → `acme_scoring_similarity`, `a-b` → `a_b`,
 * `a..b` → `a__b`). Derived names must be unreserved by
 * {@link isReservedToolCallName}; callers fail closed on collisions instead of
 * renaming.
 *
 * @param capabilityId - Capability requirement id or server-side tool name
 * @returns The derived call name
 *
 * @example
 * ```typescript
 * import { deriveToolCallName } from './tools/normalizers/index.ts';
 *
 * deriveToolCallName('text.similarity'); // 'text_similarity'
 * ```
 */
export function deriveToolCallName(capabilityId: string): string {
  return capabilityId.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Reports whether a candidate tool call name is already reserved by the baked
 * or publishing tool surface: a name is reserved when it resolves through the
 * tool alias map (canonical names, documented aliases, the aggregate
 * `subagent_management` selector, and the publishing meta-tool spellings) or
 * equals a frozen baked/publishing descriptor name.
 *
 * Derived requirement and extension call names must be unreserved, so a
 * template-derived call can never shadow — or be routed as — a baked, selector,
 * or publishing tool. The equality clause is a belt-and-suspenders check that
 * holds even if an alias entry is ever dropped.
 *
 * @param candidate - Candidate model-facing call name
 * @returns `true` when the name is reserved
 *
 * @example
 * ```typescript
 * import { isReservedToolCallName } from './tools/normalizers/index.ts';
 *
 * isReservedToolCallName('read_file'); // true
 * isReservedToolCallName('import_realm_template'); // true
 * isReservedToolCallName('acme_scoring_similarity'); // false
 * ```
 */
export function isReservedToolCallName(candidate: string): boolean {
  return RESERVED_TOOL_DESCRIPTOR_NAMES.has(candidate) || getCanonToolName(candidate) !== null;
}
