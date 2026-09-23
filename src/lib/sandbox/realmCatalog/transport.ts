/**
 * Canonical transport for `realmCatalog` template bundles.
 *
 * A transport bundle is the plain JSON document
 * `{ formatVersion, template, files }`: the authored spec (canonical
 * `formatVersion: 2`, or a legacy `formatVersion: 1` document) plus every
 * bundle file body keyed by bundle-relative path. `parseTemplateBundle()`
 * validates the closed envelope, the template, and the files map, normalizes
 * the template, and stamps the authored per-bundle content version;
 * `serializeTemplateBundle()` renders the same document canonically
 * (recursively sorted keys, no insignificant whitespace), so parsing and
 * re-serializing is stable across round-trips.
 */

import { REALM_CATALOG_ERROR_CODES, RealmCatalogError, toCatalogError } from './errors.ts';
import { deepFreeze } from './freeze.ts';
import { normalizeTemplate } from './legacy.ts';
import { isPlainRecord, rejectUnknownFields, validateTemplateV1, validateTemplate } from './validation.ts';
import {
  assertBundleReferencesResolvable,
  assertBundleReferencesResolvableV1,
  canonicalJsonStringify,
  collectReferencedBundlePaths,
  collectReferencedBundlePathsV1,
  computeBundleVersion,
  validateBundleFiles
} from './version.ts';
import type {
  BundleFiles,
  ParsedTemplateBundle,
  RealmTemplate
} from './types.ts';

/** Canonical transport envelope field names (closed shape). */
const TRANSPORT_FIELDS: ReadonlySet<string> = new Set(['formatVersion', 'template', 'files']);

/**
 * Parses and validates a canonical transport bundle of either authored format.
 *
 * Accepted input is the transport JSON as an object or as JSON text. The
 * envelope is closed-shape (`{ formatVersion, template, files }` with
 * `formatVersion` 1 or 2, matching the template's declared version) and every
 * referenced bundle file must be present. A `formatVersion: 1` template is
 * validated against the frozen v1 schema, shimmed to the canonical model, and
 * the returned bundle carries the authored v1 content version, so pins
 * computed before the migration stay valid; a `formatVersion: 2` template
 * validates directly. `serialized` is the canonical authored transport JSON
 * and round-trips to a deep-equal parsed bundle with the same `version`.
 *
 * @param input - Transport bundle object or JSON text (either format)
 * @returns The validated, deeply frozen `{ template, files, version, sourceFormatVersion, serialized, warnings }` bundle
 * @throws `RealmCatalogError` - `ERR_BUNDLE_FORMAT` for a malformed envelope/JSON text, `ERR_TEMPLATE_INVALID` for an invalid template or files map
 *
 * @example
 * ```typescript
 * import { parseTemplateBundle, serializeTemplateBundle } from './realmCatalog/index.ts';
 *
 * const parsed = parseTemplateBundle(serializeTemplateBundle({ template: DEMO_TEMPLATE, files: {} }));
 * parsed.template.formatVersion; // 2
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
  if (envelope.formatVersion !== 1 && envelope.formatVersion !== 2) {
    throw new RealmCatalogError(
      `template bundle formatVersion must be 1 or 2 (got '${String(envelope.formatVersion)}')`,
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
  const sourceFormatVersion = envelope.formatVersion;
  const templateCandidate = envelope.template;
  if (isPlainRecord(templateCandidate) && templateCandidate.formatVersion !== sourceFormatVersion) {
    throw new RealmCatalogError(
      `template bundle formatVersion ${sourceFormatVersion} does not match the template formatVersion `
      + `'${String(templateCandidate.formatVersion)}'`,
      REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT
    );
  }

  let files: BundleFiles;
  let normalized: RealmTemplate;
  let version: string;
  let serialized: string;
  try {
    files = validateBundleFiles(envelope.files);
    if (sourceFormatVersion === 1) {
      const validated = validateTemplateV1(templateCandidate);
      assertBundleReferencesResolvableV1(validated, files);
      version = computeBundleVersion(validated, files, collectReferencedBundlePathsV1(validated));
      serialized = canonicalJsonStringify({ formatVersion: 1, template: validated, files });
      normalized = normalizeTemplate(validated);
      // Freeze the freshly parsed authored parts in place (intentional
      // immutability; callers pass imported payloads, never live graphs).
      deepFreeze(validated);
    } else {
      const validated = validateTemplate(templateCandidate);
      assertBundleReferencesResolvable(validated, files);
      version = computeBundleVersion(validated, files, collectReferencedBundlePaths(validated));
      serialized = canonicalJsonStringify({ formatVersion: 2, template: validated, files });
      normalized = normalizeTemplate(validated);
      deepFreeze(validated);
    }
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }

  const frozenFiles = deepFreeze(files);
  const warnings: string[] = sourceFormatVersion === 1
    ? ['bundle uses legacy format v1; it was normalized to the format v2 model']
    : [];
  return deepFreeze({
    template: normalized,
    files: frozenFiles,
    version,
    sourceFormatVersion,
    serialized,
    warnings
  });
}

/**
 * Renders a template bundle as canonical transport JSON.
 *
 * The output is deterministic: keys are recursively sorted, there is no
 * insignificant whitespace, and the document re-parses (via
 * {@link parseTemplateBundle}) to a deep-equal parsed bundle with the same
 * per-bundle version. A legacy format-v1 document serializes as a v1 envelope
 * (stable round-trip); a canonical template serializes as a v2 envelope.
 *
 * @param bundle - Bundle to serialize (`{ template, files }`; legacy format-v1 documents accepted)
 * @returns Canonical transport JSON text
 * @throws `RealmCatalogError` (`ERR_TEMPLATE_INVALID`) - When the bundle, its template, files, or references are invalid
 */
export function serializeTemplateBundle(bundle: {
  template: RealmTemplate;
  files: BundleFiles;
}): string {
  try {
    if (!isPlainRecord(bundle)) {
      throw new Error('template bundle must be an object');
    }
    const files = validateBundleFiles(bundle.files);
    // Authored documents are read as unknown so a legacy format-v1 document
    // can flow through the read shim at runtime (the typed surface is the
    // canonical format).
    const authored: unknown = bundle.template;
    if (!isPlainRecord(authored)) {
      throw new Error('template must be an object');
    }
    if (authored.formatVersion === 1) {
      const validated = validateTemplateV1(authored);
      assertBundleReferencesResolvableV1(validated, files);
      return canonicalJsonStringify({ formatVersion: 1, template: validated, files });
    }
    if (authored.formatVersion === 2) {
      const validated = validateTemplate(authored);
      assertBundleReferencesResolvable(validated, files);
      return canonicalJsonStringify({ formatVersion: 2, template: validated, files });
    }
    throw new Error(
      `template formatVersion must be 1 or 2 (got '${String(authored.formatVersion)}')`
    );
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }
}
