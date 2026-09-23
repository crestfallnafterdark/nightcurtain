/**
 * Baked template bundles for the `realmCatalog` module: the demo fixture plus
 * the embedded bundles generated from `templates/**` by
 * `scripts/embed_realm_content.mjs`.
 *
 * This file is the module's single composition point for baked bundle content:
 * it deep-freezes the generated payload and exposes id lookup for the launcher
 * preview and the sandbox store's default launch catalog. Bundle files are the
 * only source for prompt/history `file` parts, input `defaultFile` prefills,
 * and placement `file` sources — the catalog performs no runtime file reads and
 * uses no `?raw` imports.
 */

import { GENERATED_TEMPLATE_BUNDLES } from './content.generated.ts';
import { DEMO_TEMPLATE } from './demo.ts';
import { deepFreeze } from './freeze.ts';
import type { BakedTemplateBundle } from './types.ts';

/**
 * Baked template bundles in registration order: the demo fixture first, then
 * the embedded generated bundles in sorted template id order.
 *
 * The list and every nested template/file body are deeply frozen; generated
 * bundles are never hand-edited (freshness is enforced by
 * `node scripts/embed_realm_content.mjs --check`).
 */
export const BAKED_TEMPLATE_BUNDLES: readonly BakedTemplateBundle[] = deepFreeze<BakedTemplateBundle[]>([
  { template: DEMO_TEMPLATE, files: {} },
  ...GENERATED_TEMPLATE_BUNDLES
]);

/** Id index over `BAKED_TEMPLATE_BUNDLES` (built once, never exposed). */
const BUNDLES_BY_ID: ReadonlyMap<string, BakedTemplateBundle> = new Map(
  BAKED_TEMPLATE_BUNDLES.map((bundle) => [bundle.template.id, bundle] as const)
);

/**
 * Resolves one baked template bundle by id.
 *
 * The returned bundle is the same deeply frozen module constant the store's
 * default launch catalog uses, so a launcher preview and a launch resolve the
 * exact same template and bundle files. Blank or non-string ids return `null`.
 *
 * @param templateId - Template id to resolve.
 * @returns The frozen baked bundle, or `null` for an unknown id.
 *
 * @example
 * ```typescript
 * import { getBakedTemplateBundle } from './realmCatalog/index.ts';
 *
 * const bundle = getBakedTemplateBundle('demo');
 * console.log(bundle?.template.name, Object.keys(bundle?.files ?? {}));
 * ```
 */
export function getBakedTemplateBundle(templateId: string): BakedTemplateBundle | null {
  if (typeof templateId !== 'string' || templateId.trim().length === 0) return null;
  return BUNDLES_BY_ID.get(templateId) ?? null;
}
