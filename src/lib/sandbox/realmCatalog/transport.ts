/**
 * Canonical transport for `realmCatalog` template bundles.
 *
 * A transport bundle is the plain JSON document
 * `{ formatVersion: 1, template, files }`: the spec (format v1) plus every
 * bundle file body keyed by bundle-relative path. `parseTemplateBundle()`
 * validates the closed envelope, the template, and the files map, then stamps
 * the per-bundle content version; `serializeTemplateBundle()` renders the same
 * document canonically (recursively sorted keys, no insignificant whitespace),
 * so parsing and re-serializing is stable across round-trips.
 */

import { REALM_CATALOG_ERROR_CODES, RealmCatalogError, toCatalogError } from './errors.ts';
import { isPlainRecord, rejectUnknownFields } from './validation.ts';
import {
  assertBundleReferencesResolvable,
  canonicalJsonStringify,
  freezeBundleParts,
  templateBundleVersion,
  validateBundleParts
} from './version.ts';
import { deepFreeze } from './freeze.ts';
import type { BundleFiles, ParsedTemplateBundle, RealmTemplate } from './types.ts';

/** Canonical transport envelope field names (closed shape). */
const TRANSPORT_FIELDS: ReadonlySet<string> = new Set(['formatVersion', 'template', 'files']);

/**
 * Parses and validates a canonical transport bundle.
 *
 * Accepted input is the transport JSON as an object or as JSON text. The
 * envelope is closed-shape (`{ formatVersion: 1, template, files }` on top of
 * the validated format-v1 template and a string-valued files map), every
 * referenced bundle file must be present, and the returned bundle is deeply
 * frozen — pass a freshly parsed object (an imported payload), not a live
 * application object graph, because freezing is intentional immutability.
 *
 * @param input - Transport bundle object or JSON text
 * @returns The validated, deeply frozen `{ template, files, version, warnings }` bundle
 * @throws `RealmCatalogError` - `ERR_BUNDLE_FORMAT` for a malformed envelope/JSON text, `ERR_TEMPLATE_INVALID` for an invalid template or files map
 *
 * @example
 * ```typescript
 * import { parseTemplateBundle, serializeTemplateBundle } from './realmCatalog/index.ts';
 *
 * const parsed = parseTemplateBundle(serializeTemplateBundle({ template: DEMO_TEMPLATE, files: {} }));
 * parsed.template.id; // 'demo'
 * ```
 */
export function parseTemplateBundle(input: unknown): ParsedTemplateBundle {
  let envelope: unknown = input;
  if (typeof input === 'string') {
    try {
      envelope = JSON.parse(input);
    } catch (error) {
      throw new RealmCatalogError(
        `template bundle text is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT
      );
    }
  }
  if (!isPlainRecord(envelope)) {
    throw new RealmCatalogError('template bundle must be an object', REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT);
  }
  try {
    rejectUnknownFields(envelope, TRANSPORT_FIELDS, 'template bundle');
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT);
  }
  if (envelope.formatVersion !== 1) {
    throw new RealmCatalogError(
      `template bundle formatVersion must be 1 (got '${String(envelope.formatVersion)}')`,
      REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT
    );
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, 'template')
    || !Object.prototype.hasOwnProperty.call(envelope, 'files')) {
    throw new RealmCatalogError(
      'template bundle must carry both template and files',
      REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT
    );
  }

  let parts: { template: RealmTemplate; files: BundleFiles };
  try {
    parts = validateBundleParts(envelope);
    assertBundleReferencesResolvable(parts.template, parts.files);
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }

  const version = templateBundleVersion(parts);
  const frozen = freezeBundleParts(parts.template, parts.files);
  return deepFreeze({
    template: frozen.template,
    files: frozen.files,
    version,
    warnings: []
  });
}

/**
 * Renders a template bundle as the canonical transport JSON.
 *
 * The output is deterministic: keys are recursively sorted, there is no
 * insignificant whitespace, and the document re-parses to a deep-equal bundle
 * with the same per-bundle version.
 *
 * @param bundle - Bundle to serialize (`{ template, files }`)
 * @returns Canonical transport JSON text
 * @throws `RealmCatalogError` (`ERR_TEMPLATE_INVALID`) - When the bundle, its template, files, or references are invalid
 */
export function serializeTemplateBundle(bundle: { template: RealmTemplate; files: BundleFiles }): string {
  try {
    const { template, files } = validateBundleParts(bundle);
    assertBundleReferencesResolvable(template, files);
    return canonicalJsonStringify({ formatVersion: 1, template, files });
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }
}
