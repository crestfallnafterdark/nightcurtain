/**
 * Per-bundle content versioning for the `realmCatalog` module.
 *
 * `templateBundleVersionV1()` computes the format-v1 `templateVersion` — a
 * `sha256:<hex>` digest over the canonical byte stream: the spec re-serialized
 * as UTF-8 JSON with recursively sorted keys and no insignificant whitespace,
 * followed by each referenced bundle file in lexicographic path order, each
 * framed as `<pathLength>:<path>\n<contentLength>:<content>` (lengths are
 * UTF-8 byte counts). Baked (build-time embedded) and imported (runtime JSON)
 * bundles are canonicalized through the same function, so the two paths hash
 * identically.
 *
 * This helper is intentionally separate from the pipeline's global
 * `REALM_CONTENT_VERSION`: the generated module version covers the whole
 * embedded payload (the build's freshness gate), while `templateBundleVersionV1`
 * identifies one bundle (the instance provenance pin).
 */

import { REALM_CATALOG_ERROR_CODES, toCatalogError } from './errors.ts';
import { sha256Hex, utf8ByteLength } from './sha256.ts';
import { isPlainRecord, requireSafePath, validateTemplateV1, validateTemplate } from './validation.ts';
import type { BundleFiles, RealmTemplateV1, RealmTemplate } from './types.ts';

/**
 * Renders a JSON value canonically: object keys recursively sorted, no
 * insignificant whitespace, JSON-standard string escaping.
 *
 * Only plain JSON data is accepted (finite numbers, strings, booleans, null,
 * arrays, plain objects); `undefined` object members are omitted like
 * `JSON.stringify` does and array holes become `null`.
 *
 * @param value - Value to render
 * @returns The canonical JSON text
 * @throws `Error` - When the value is not plain finite JSON data
 */
export function canonicalJsonStringify(value: unknown): string {
  return writeCanonical(value, 'value');
}

/**
 * Recursive canonical JSON writer.
 *
 * @param value - Value at the current position
 * @param path - Human-readable path used in error messages
 * @returns Canonical JSON text
 */
function writeCanonical(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => (
      item === undefined ? 'null' : writeCanonical(item, `${path}[${index}]`)
    ));
    return `[${items.join(',')}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${writeCanonical(value[key], `${path}.${key}`)}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`${path} must be plain JSON data (got ${typeof value})`);
}

/**
 * Validates one bundle files map: a plain record whose keys are safe
 * bundle-relative paths and whose values are strings.
 *
 * @param candidate - Candidate bundle files map
 * @returns The validated map reference
 * @throws `Error` - When the map or any entry is invalid
 */
export function validateBundleFiles(candidate: unknown): BundleFiles {
  if (!isPlainRecord(candidate)) {
    throw new Error('bundle files must be a record of file bodies');
  }
  for (const path of Object.keys(candidate)) {
    requireSafePath(path, 'bundle file path');
    if (typeof candidate[path] !== 'string') {
      throw new Error(`bundle files['${path}'] must be a string`);
    }
  }
  return candidate as BundleFiles;
}

/**
 * Collects every bundle file path a legacy format-v1 document references:
 * `file` prompt parts, `file` history content parts, input `defaultFile`
 * prefills, and `fixed` seed `source.file` bodies.
 *
 * The result is deduplicated and sorted lexicographically by code unit (the
 * order the canonical version stream frames files in).
 *
 * @param template - Validated format-v1 template
 * @returns Referenced bundle-relative paths in lexicographic order
 */
export function collectReferencedBundlePathsV1(template: RealmTemplateV1): readonly string[] {
  const references: Set<string> = new Set();
  const addParts = (parts: readonly { kind: string; path?: string }[]): void => {
    for (const part of parts) {
      if (part.kind === 'file' && typeof part.path === 'string') references.add(part.path);
    }
  };
  for (const agent of template.agents) {
    addParts(agent.prompt);
    for (const entry of agent.history ?? []) {
      addParts(entry.content);
    }
  }
  for (const input of template.inputs ?? []) {
    if (input.defaultFile !== undefined) references.add(input.defaultFile);
  }
  for (const file of template.seed?.files ?? []) {
    if ((file.origin ?? 'fixed') !== 'fixed' || file.source === undefined) continue;
    if ('file' in file.source) references.add(file.source.file);
  }
  return Object.freeze([...references].sort());
}

/**
 * Asserts that every referenced bundle file of a legacy format-v1 document is
 * present in the files map.
 *
 * @param template - Validated format-v1 template
 * @param files - Validated bundle files map
 * @throws `Error` - When a referenced file is missing from the map
 */
export function assertBundleReferencesResolvableV1(template: RealmTemplateV1, files: BundleFiles): void {
  for (const path of collectReferencedBundlePathsV1(template)) {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      throw new Error(`bundle references file '${path}' but the bundle files do not carry it`);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Canonical versioning (decision ticket 2ba3008)
 * ------------------------------------------------------------------------- */

/**
 * Collects every bundle file path a format-v2 template references: `file`
 * prompt/history parts, input `defaultFile` prefills, and placement `file`
 * sources.
 *
 * The result is deduplicated and sorted lexicographically by code unit (the
 * order the canonical version stream frames files in).
 *
 * @param template - Validated format-v2 template
 * @returns Referenced bundle-relative paths in lexicographic order
 */
export function collectReferencedBundlePaths(template: RealmTemplate): readonly string[] {
  const references: Set<string> = new Set();
  const addParts = (parts: readonly { kind: string; path?: string }[]): void => {
    for (const part of parts) {
      if (part.kind === 'file' && typeof part.path === 'string') references.add(part.path);
    }
  };
  for (const agent of template.agents) {
    addParts(agent.prompt);
    for (const entry of agent.history ?? []) {
      addParts(entry.content);
    }
  }
  for (const input of template.inputs ?? []) {
    if (input.defaultFile !== undefined) references.add(input.defaultFile);
  }
  for (const placement of template.placements ?? []) {
    if (placement.file !== undefined) references.add(placement.file);
  }
  return Object.freeze([...references].sort());
}

/**
 * Asserts that every bundle file a format-v2 template references is present in
 * the files map.
 *
 * @param template - Validated format-v2 template
 * @param files - Validated bundle files map
 * @throws `Error` - When a referenced file is missing from the map
 */
export function assertBundleReferencesResolvable(template: RealmTemplate, files: BundleFiles): void {
  for (const path of collectReferencedBundlePaths(template)) {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      throw new Error(`bundle references file '${path}' but the bundle files do not carry it`);
    }
  }
}

/**
 * Renders the canonical version byte stream for one validated bundle form.
 *
 * Internal helper shared by the public version entry point and the transport
 * parser; not part of the module's public surface.
 *
 * @param template - Validated template in its authored format
 * @param files - Validated bundle files map
 * @param paths - Referenced paths in framing order
 * @returns The `sha256:<hex>` version string
 */
export function computeBundleVersion(
  template: RealmTemplateV1 | RealmTemplate,
  files: BundleFiles,
  paths: readonly string[]
): string {
  const parts: string[] = [canonicalJsonStringify(template)];
  for (const path of paths) {
    const content = files[path];
    parts.push(`${utf8ByteLength(path)}:${path}\n${utf8ByteLength(content)}:${content}`);
  }
  return `sha256:${sha256Hex(parts.join(''))}`;
}

/**
 * Computes the per-bundle content version of a template bundle.
 *
 * A canonical (`formatVersion: 2`) bundle hashes the spec plus its referenced
 * bundle files (prompt/history `file` parts, input `defaultFile` prefills,
 * placement `file` sources); a legacy `formatVersion: 1` document keeps the
 * format-v1 byte stream exactly (the spec plus prompt/history `file` parts,
 * `defaultFile` prefills, and fixed seed sources), so pins computed before the
 * migration stay valid. The canonical framing is the same for both: the spec
 * re-serialized as UTF-8 JSON with recursively sorted keys and no insignificant
 * whitespace, then each referenced file in lexicographic path order framed as
 * `<pathLength>:<path>\n<contentLength>:<content>` (UTF-8 byte counts). The
 * template is hashed **in its authored format** — pass the authored template
 * (or a parsed bundle's `serialized` text), not a normalized model, to
 * reproduce a legacy pin.
 *
 * @param bundle - Bundle to version (`{ template, files }`; legacy format-v1 documents accepted)
 * @returns The version string (`sha256:<64 lowercase hex>`)
 * @throws `RealmCatalogError` (`ERR_TEMPLATE_INVALID`) - When the bundle, its template, files, or references are invalid
 *
 * @example
 * ```typescript
 * import { templateBundleVersion } from './realmCatalog/index.ts';
 *
 * templateBundleVersion({ template: DEMO_TEMPLATE, files: {} });
 * // 'sha256:…'
 * ```
 */
export function templateBundleVersion(bundle: {
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
      return computeBundleVersion(validated, files, collectReferencedBundlePathsV1(validated));
    }
    if (authored.formatVersion === 2) {
      const validated = validateTemplate(authored);
      assertBundleReferencesResolvable(validated, files);
      return computeBundleVersion(validated, files, collectReferencedBundlePaths(validated));
    }
    throw new Error(
      `template formatVersion must be 1 or 2 (got '${String(authored.formatVersion)}')`
    );
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }
}
