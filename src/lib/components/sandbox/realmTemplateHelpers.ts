/**
 * Realm template registry and instance-provenance UI helpers (Wave T, ticket
 * 2b5db57).
 *
 * Pure, UI-framework-free projections shared by `RealmLauncherModal.svelte`
 * (template picker source labels, import/export/delete copy, and typed import
 * error surfacing) and `RealmSettingsModal.svelte` (the instance provenance
 * panel). These helpers never call the store: every function is a pure
 * projection of its arguments, so the registry copy is unit-testable without a
 * DOM and the components stay thin rendering layers.
 *
 * Source labels mirror the store's `listRealmTemplateSources()` (Wave T
 * decision 3.2): `shipped` is the build/host catalog, `imported` is a runtime
 * import, and `imported · replaces shipped` marks an import that shadows a
 * shipped id. Only imported entries are deletable — deleting the import
 * restores the shipped revision. Provenance rows read `RealmRecord.instance`
 * (hashes and paths only, recorded at launch) and render nothing when the
 * record carries no valid provenance block.
 */

import type { RealmTemplate } from '../../sandbox/realmCatalog/index.ts';
import type { RealmRecord } from '../../sandbox/realmRegistry/index.ts';

/**
 * Structural source-label input accepted by the helpers: the fields of the
 * store's `RealmTemplateSourceInfo` the UI copy needs. Keeping the shape
 * structural keeps this module store-free while staying satisfied by the
 * store's returned labels.
 */
export interface RealmTemplateSourceLabel {
  /** Template id of the effective catalog entry. */
  readonly templateId: string;
  /** Effective source of the entry: `shipped` (build/host catalog) or `imported` (runtime import). */
  readonly source: 'shipped' | 'imported';
  /** True when an imported entry shadows a shipped entry of the same id. */
  readonly replacesShipped: boolean;
  /** Effective bundle content version, or `null` when unversionable. */
  readonly templateVersion: string | null;
}

/**
 * One template picker entry: the template identity plus its effective source
 * label, content version, and deletability.
 */
export interface RealmTemplateCatalogEntry {
  /** Template id. */
  readonly id: string;
  /** Display name (falls back to the id when blank). */
  readonly name: string;
  /** Launcher subtitle. */
  readonly description: string;
  /** Effective source of the entry. */
  readonly source: 'shipped' | 'imported';
  /** True when an imported entry shadows a shipped entry of the same id. */
  readonly replacesShipped: boolean;
  /** Human-readable source label (`shipped`, `imported`, `imported · replaces shipped`). */
  readonly sourceLabel: string;
  /** Effective bundle content version, or `null` when unversionable. */
  readonly templateVersion: string | null;
  /** Whether the entry is a runtime import (the only deletable source). */
  readonly deletable: boolean;
}

/**
 * Renders the picker source label for one effective catalog entry.
 *
 * @param source - Effective source (`shipped`/`imported`; unknown values render `shipped`).
 * @param replacesShipped - Whether an imported entry shadows a shipped id.
 * @returns The source label (`shipped`, `imported`, or `imported · replaces shipped`).
 *
 * @example
 * ```typescript
 * describeRealmTemplateSource('imported', true); // 'imported · replaces shipped'
 * ```
 */
export function describeRealmTemplateSource(source: unknown, replacesShipped: unknown): string {
  if (source === 'imported') {
    return replacesShipped === true ? 'imported · replaces shipped' : 'imported';
  }
  return 'shipped';
}

/**
 * Joins the store's template list with its source labels into picker entries,
 * in effective catalog order (one entry per template id).
 *
 * A template without a matching source label is treated as shipped: the
 * store's `listRealmTemplateSources()` covers every effective entry, so a
 * missing label means host-injected content, never a hidden import.
 *
 * @param templates - Effective launch templates (`listRealmTemplates()` order).
 * @param sources - Effective source labels (`listRealmTemplateSources()` order).
 * @returns Picker entries; malformed templates are skipped.
 *
 * @example
 * ```typescript
 * const entries = buildRealmTemplateCatalogEntries(
 *   sandboxStore.listRealmTemplates(),
 *   sandboxStore.listRealmTemplateSources()
 * );
 * entries.find((entry) => entry.deletable)?.sourceLabel; // 'imported'
 * ```
 */
export function buildRealmTemplateCatalogEntries(
  templates: readonly (RealmTemplate)[] | null | undefined,
  sources: readonly RealmTemplateSourceLabel[] | null | undefined
): RealmTemplateCatalogEntry[] {
  const templateList = Array.isArray(templates) ? templates : [];
  const sourceById: Map<string, RealmTemplateSourceLabel> = new Map();
  if (Array.isArray(sources)) {
    for (const info of sources) {
      if (!info || typeof info !== 'object' || typeof info.templateId !== 'string') continue;
      sourceById.set(info.templateId, info);
    }
  }

  const entries: RealmTemplateCatalogEntry[] = [];
  for (const template of templateList) {
    if (!template || typeof template !== 'object' || typeof template.id !== 'string' || template.id.length === 0) {
      continue;
    }
    const info = sourceById.get(template.id) ?? null;
    const source: 'shipped' | 'imported' = info?.source === 'imported' ? 'imported' : 'shipped';
    const replacesShipped = source === 'imported' && info?.replacesShipped === true;
    entries.push({
      id: template.id,
      name: typeof template.name === 'string' && template.name.trim().length > 0 ? template.name : template.id,
      description: typeof template.description === 'string' ? template.description : '',
      source,
      replacesShipped,
      sourceLabel: describeRealmTemplateSource(source, replacesShipped),
      templateVersion: typeof info?.templateVersion === 'string' ? info.templateVersion : null,
      deletable: source === 'imported'
    });
  }
  return entries;
}

/**
 * Whether one catalog entry is deletable through the template registry: only
 * runtime imports can be deleted; shipped revisions have no delete path.
 *
 * @param entry - Catalog entry or source label (structural `{ source }`).
 * @returns `true` for imported entries only.
 *
 * @example
 * ```typescript
 * canDeleteRealmTemplate({ source: 'shipped' }); // false
 * ```
 */
export function canDeleteRealmTemplate(entry: { readonly source?: unknown } | null | undefined): boolean {
  return Boolean(entry && typeof entry === 'object' && entry.source === 'imported');
}

/**
 * Copy/behavior model of the template-delete confirmation.
 */
export interface RealmTemplateDeletionPlan {
  /** Targeted template id. */
  readonly templateId: string;
  /** Whether deletion is available (imported entries only). */
  readonly allowed: boolean;
  /** Refusal copy for a shipped entry; empty when deletion is available. */
  readonly blockedCopy: string;
  /** Confirmation copy for the selected entry; empty when deletion is refused. */
  readonly confirmCopy: string;
  /** Destructive confirm-button label. */
  readonly confirmLabel: string;
}

/**
 * Builds the delete-confirmation model for one catalog entry.
 *
 * Deleting an import that shadowed a shipped id is labeled explicitly: the
 * shipped revision resolves again, so the confirmation says so instead of
 * implying a permanent removal of the template id.
 *
 * @param entry - Catalog entry (structural `{ id, name, source, replacesShipped }`).
 * @returns The deletion plan; shipped entries are refused with copy.
 *
 * @example
 * ```typescript
 * describeRealmTemplateDeletion({ id: 'demo', name: 'Demo', source: 'imported', replacesShipped: true }).allowed;
 * // true
 * ```
 */
export function describeRealmTemplateDeletion(
  entry: {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly source?: unknown;
    readonly replacesShipped?: unknown;
  } | null | undefined
): RealmTemplateDeletionPlan {
  const templateId = entry && typeof entry.id === 'string' ? entry.id : '';
  const name = entry && typeof entry.name === 'string' && entry.name.trim().length > 0
    ? entry.name
    : templateId;
  if (!canDeleteRealmTemplate(entry)) {
    return {
      templateId,
      allowed: false,
      blockedCopy: `The shipped template "${name}" cannot be deleted — only imported revisions can.`,
      confirmCopy: '',
      confirmLabel: 'Delete Import'
    };
  }
  const shadowed = entry?.replacesShipped === true;
  return {
    templateId,
    allowed: true,
    blockedCopy: '',
    confirmCopy: shadowed
      ? `Delete the imported revision of "${name}"? The shipped revision of this id will resolve again.`
      : `Delete the imported template "${name}"? This cannot be undone.`,
    confirmLabel: shadowed ? 'Delete Import & Restore Shipped' : 'Delete Import'
  };
}

/**
 * Builds a safe download filename for one template export.
 *
 * The id is sanitized to a filesystem-safe token (any other character becomes
 * `_`), so an operator-supplied id can never inject a path into the download
 * filename; a blank/unknown id falls back to `realm-template`.
 *
 * @param templateId - Template id being exported.
 * @returns `<sanitized-id>.template.json`.
 *
 * @example
 * ```typescript
 * buildRealmTemplateExportFilename('consensus_test'); // 'consensus_test.template.json'
 * ```
 */
export function buildRealmTemplateExportFilename(templateId: unknown): string {
  const raw = typeof templateId === 'string' ? templateId.trim() : '';
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  return `${safe.length > 0 ? safe : 'realm-template'}.template.json`;
}

/**
 * Describes a successful `importRealmTemplate()` receipt for the launcher
 * notice, naming shadowing and import replacement explicitly.
 *
 * @param receipt - Store receipt (structural fields only).
 * @returns One-line operator notice.
 *
 * @example
 * ```typescript
 * describeRealmTemplateImportReceipt({ templateId: 'mine' });
 * // 'Imported template "mine".'
 * ```
 */
export function describeRealmTemplateImportReceipt(
  receipt: {
    readonly templateId?: unknown;
    readonly replacesShipped?: unknown;
    readonly replacedImport?: unknown;
    readonly warnings?: unknown;
  } | null | undefined
): string {
  const templateId = receipt && typeof receipt.templateId === 'string' ? receipt.templateId : '';
  if (!templateId) return 'Template imported.';
  let text = `Imported template "${templateId}".`;
  if (receipt?.replacedImport === true) {
    text += ' The previous import of this id was replaced.';
  }
  if (receipt?.replacesShipped === true) {
    text += ' It replaces the shipped revision of this id; deleting the import restores the shipped revision.';
  }
  const warnings = Array.isArray(receipt?.warnings)
    ? receipt.warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0)
    : [];
  if (warnings.length > 0) {
    text += ` Warnings: ${warnings.join(' ')}`;
  }
  return text;
}

/**
 * Extracts the human-readable message from an unknown thrown value.
 *
 * @param error - Thrown value.
 * @returns Trimmed message, or an empty string.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return '';
}

/**
 * Reads the stable `code` of a thrown coded error, when present.
 *
 * @param error - Thrown value.
 * @returns The code string, or an empty string.
 */
function codeOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * Describes a failed `importRealmTemplate()` call: the typed catalog/store
 * error class is named explicitly and the message is preserved, so a rejected
 * file never reads as a generic failure.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 *
 * @example
 * ```typescript
 * describeRealmTemplateImportError(new Error('bad'));
 * // 'bad'
 * ```
 */
export function describeRealmTemplateImportError(
  error: unknown,
  fallback = 'Failed to import the template bundle.'
): string {
  const base = messageOf(error) || fallback;
  switch (codeOf(error)) {
    case 'ERR_BUNDLE_FORMAT':
      return `The import was rejected: the file is not a canonical Realm template bundle (expected JSON with "formatVersion", "template", and "files"). ${base}`;
    case 'ERR_TEMPLATE_INVALID':
      return `The import was rejected: the template failed format-v1 validation. ${base}`;
    case 'ERR_STORE_TEMPLATE_TOO_LARGE':
      return `${base} Content-heavy templates must travel as files or hydration packages.`;
    case 'ERR_STORE_TEMPLATE_PERSIST_FAILED':
      return `The import was rolled back — the template registry could not be saved (storage quota or unavailable storage). ${base}`;
    default:
      return base;
  }
}

/**
 * Describes a failed `exportRealmTemplate()` call (unknown or removed id).
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeRealmTemplateExportError(
  error: unknown,
  fallback = 'Failed to export the template bundle.'
): string {
  const base = messageOf(error) || fallback;
  if (codeOf(error) === 'ERR_STORE_INVALID_PARAMS') {
    return `${base} The template may have been deleted — refresh the template list and retry.`;
  }
  return base;
}

/**
 * Describes a failed `deleteRealmTemplate()` call. The store rolls a failed
 * persistence write back, so the copy says the import survives instead of
 * leaving the operator unsure.
 *
 * @param error - Thrown value from the store call.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing failure text.
 */
export function describeRealmTemplateDeleteError(
  error: unknown,
  fallback = 'Failed to delete the imported template.'
): string {
  const base = messageOf(error) || fallback;
  if (codeOf(error) === 'ERR_STORE_TEMPLATE_PERSIST_FAILED') {
    return `The delete was rolled back — the template registry could not be saved (storage quota or unavailable storage). ${base}`;
  }
  return base;
}

/**
 * Formats a launch timestamp for display: ISO-8601 input renders as a stable
 * UTC label; unparseable input renders verbatim instead of `Invalid Date`.
 *
 * @param value - Timestamp string from the provenance record.
 * @returns `YYYY-MM-DD HH:MM:SS UTC`, the raw value when unparseable, or `''`.
 *
 * @example
 * ```typescript
 * formatRealmLaunchTimestamp('2026-09-21T12:34:56.000Z');
 * // '2026-09-21 12:34:56 UTC'
 * ```
 */
export function formatRealmLaunchTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const iso = new Date(parsed).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * One rendered provenance row.
 */
export interface RealmProvenanceRow {
  /** Stable row key (`templateId`/`templateVersion`/`packageDigest`/`launchedAt`). */
  readonly key: 'templateId' | 'templateVersion' | 'packageDigest' | 'launchedAt';
  /** Display label. */
  readonly label: string;
  /** Display value (the `launchedAt` row is the formatted timestamp). */
  readonly value: string;
}

/**
 * Provenance panel projection of one Realm record.
 */
export interface RealmProvenanceView {
  /** Whether the panel renders at all (no valid `instance` → nothing shown). */
  readonly visible: boolean;
  /** Provenance template id; empty when hidden. */
  readonly templateId: string;
  /** Rows in display order (`templateId`, `templateVersion`, optional `packageDigest`, `launchedAt`). */
  readonly rows: readonly RealmProvenanceRow[];
}

/**
 * Builds the Realm settings provenance panel from `RealmRecord.instance`.
 *
 * The `instance` block is the authoritative launch provenance (Wave T, ticket
 * 0df20ae): it records the effective template revision, the optional hydration
 * package digest, input hashes, seed paths, and the launch timestamp. A record
 * without a valid provenance block — or with a malformed one (missing
 * `templateId`/`templateVersion`/`launchedAt`) — renders nothing rather than
 * guessing from `templateId` alone, so the panel is never dishonest.
 *
 * @param realm - Realm record (structural; `instance` read only).
 * @returns The panel projection; hidden with empty rows when provenance is absent.
 *
 * @example
 * ```typescript
 * const view = buildRealmProvenanceView(sandboxStore.realms[0]);
 * view.visible ? view.rows.map((row) => row.key) : [];
 * ```
 */
export function buildRealmProvenanceView(
  realm: RealmRecord | { readonly instance?: unknown } | null | undefined
): RealmProvenanceView {
  const instance = realm && typeof realm === 'object' && realm.instance && typeof realm.instance === 'object'
    ? (realm.instance as Record<string, unknown>)
    : null;
  if (!instance) return { visible: false, templateId: '', rows: [] };

  const templateId = typeof instance.templateId === 'string' ? instance.templateId.trim() : '';
  const templateVersion = typeof instance.templateVersion === 'string' ? instance.templateVersion.trim() : '';
  const launchedAt = typeof instance.launchedAt === 'string' ? instance.launchedAt.trim() : '';
  if (!templateId || !templateVersion || !launchedAt) {
    return { visible: false, templateId: '', rows: [] };
  }
  const packageDigest = typeof instance.packageDigest === 'string' ? instance.packageDigest.trim() : '';

  const rows: RealmProvenanceRow[] = [
    { key: 'templateId', label: 'Template', value: templateId },
    { key: 'templateVersion', label: 'Template version', value: templateVersion },
    ...(packageDigest
      ? [{ key: 'packageDigest' as const, label: 'Hydration package', value: packageDigest }]
      : []),
    { key: 'launchedAt', label: 'Launched', value: formatRealmLaunchTimestamp(launchedAt) }
  ];
  return { visible: true, templateId, rows };
}
