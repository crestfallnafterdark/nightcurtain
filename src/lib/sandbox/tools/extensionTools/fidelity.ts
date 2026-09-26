/**
 * Schema-fidelity summary for one extension's projected tool catalog.
 *
 * The summary is the disclosure signal consumed by the extension surfaces: it
 * distinguishes a clean catalog from one that needed lossy projection, and
 * escalates to degraded fidelity when more than half of the tools needed a
 * semantic projection or any tool was refused. Purely additive normalization
 * (missing `additionalProperties`/descriptions, recorded as
 * `additional-properties-defaulted`/`description-defaulted`) counts as a
 * recorded warning but never as semantic projection, matching the ecosystem
 * survey's "additive normalization, not loss" classification.
 */

import { EXTENSION_SCHEMA_WARNING_CODES } from './schemaProjection.ts';
import type { ExtensionSchemaProjection } from './schemaProjection.ts';

/**
 * Frozen fidelity-state vocabulary: `clean` (no recorded warnings),
 * `projected` (at least one tool carries a recorded warning), `degraded`
 * (more than half of the tools needed a semantic projection, or any tool was
 * refused).
 */
export interface ExtensionSchemaFidelitySummary {
  /** Fidelity state rendered by the extension surfaces. */
  readonly state: 'clean' | 'projected' | 'degraded';
  /** Number of projections summarized. */
  readonly total: number;
  /** Projected tools carrying at least one recorded warning. */
  readonly warned: number;
  /** Refused projections. */
  readonly refused: number;
}

/**
 * Warning codes treated as additive normalization rather than semantic
 * projection: they are recorded and disclosed, but they do not by themselves
 * push an extension catalog toward the degraded state.
 */
const ADDITIVE_NORMALIZATION_WARNING_CODES: ReadonlySet<string> = new Set([
  EXTENSION_SCHEMA_WARNING_CODES.ADDITIONAL_PROPERTIES_DEFAULTED,
  EXTENSION_SCHEMA_WARNING_CODES.DESCRIPTION_DEFAULTED
]);

/**
 * Reports whether one projection carries a semantic (non-additive) warning.
 *
 * @param warnings - Projection warning list.
 * @returns `true` when at least one warning is a semantic projection.
 */
function hasSemanticWarning(warnings: readonly { code: string }[]): boolean {
  return warnings.some((warning) => !ADDITIVE_NORMALIZATION_WARNING_CODES.has(warning.code));
}

/**
 * Validates one projection entry defensively.
 *
 * @param value - Candidate projection.
 * @returns `true` when the entry has a known status and a warning array.
 */
function isProjectionLike(value: unknown): value is ExtensionSchemaProjection {
  if (value === null || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  if (status !== 'projected' && status !== 'refused') return false;
  return Array.isArray((value as { warnings?: unknown }).warnings);
}

/**
 * Summarizes the schema fidelity of one extension's projected tool set.
 *
 * `warned` counts projected tools with at least one warning (including
 * additive normalization). The `degraded` state triggers when any projection
 * was refused or when strictly more than half of the projections carry a
 * semantic (non-additive) warning; otherwise a warned catalog is `projected`
 * and an unwarned catalog is `clean`. A zero-length input is `clean`.
 *
 * @param projections - Projection outcomes in catalog order.
 * @returns The frozen fidelity summary.
 * @throws `TypeError` - When the input is not an array of projection outcomes.
 *
 * @example
 * ```typescript
 * import { summarizeExtensionSchemaFidelity } from './tools/extensionTools/index.ts';
 *
 * const summary = summarizeExtensionSchemaFidelity([
 *   { status: 'projected', schema, warnings: [{ code: 'ref-deref', path: '#/properties/page' }] }
 * ]);
 * // summary.state => 'projected', summary.warned => 1
 * ```
 */
export function summarizeExtensionSchemaFidelity(
  projections: readonly ExtensionSchemaProjection[]
): ExtensionSchemaFidelitySummary {
  if (!Array.isArray(projections)) {
    throw new TypeError('summarizeExtensionSchemaFidelity requires an array of projections');
  }
  let warned = 0;
  let refused = 0;
  let semantic = 0;
  for (const projection of projections) {
    if (!isProjectionLike(projection)) {
      throw new TypeError('summarizeExtensionSchemaFidelity received a malformed projection outcome');
    }
    if (projection.status === 'refused') {
      refused += 1;
      continue;
    }
    if (projection.warnings.length > 0) warned += 1;
    if (hasSemanticWarning(projection.warnings)) semantic += 1;
  }
  const total = projections.length;
  const state = refused > 0 || (total > 0 && semantic > total / 2)
    ? 'degraded'
    : warned > 0 ? 'projected' : 'clean';
  return Object.freeze({ state, total, warned, refused });
}
