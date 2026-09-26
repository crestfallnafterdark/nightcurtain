/**
 * @file src/lib/components/sandbox/realmArchiveHelpers.ts
 * @description Host-facing helpers for the full-realm archive surface (S2
 *   realm-export lane, ticket 3fe5221): filename/blob/drop-authority and
 *   receipt formatting over the frozen `SandboxStore.exportRealmArchive` /
 *   `importRealmArchive` API. UI-only concerns live here; the store owns the
 *   archive contract.
 */

import { triggerBrowserBlobDownload } from '../../sandbox/fsDownloadUtils/index.ts';
import type { DownloadReceipt } from '../../sandbox/fsDownloadUtils/index.ts';
import type { RealmArchiveImportReceipt } from '../../sandbox/sandboxStore/index.svelte.ts';

/** Minimal export result projection consumed by the helpers. */
export interface RealmArchiveExportView {
  /** True when the archive was serialized. */
  readonly success: boolean;
  /** Canonical archive JSON text (present on success). */
  readonly json?: string;
  /** Suggested download filename (present on success). */
  readonly filename?: string;
  /** Export-time completeness disclosures. */
  readonly warnings: readonly string[];
  /** Typed failure code when `success` is false. */
  readonly code?: string;
}

/**
 * Builds the download Blob for one successful export (JSON MIME type,
 * canonical payload bytes verbatim).
 *
 * @param result - Store export result.
 * @returns `{ blob, filename }`, or `null` when the export failed.
 */
export function buildRealmArchiveDownload(
  result: RealmArchiveExportView
): { blob: Blob; filename: string } | null {
  if (!result || result.success !== true || typeof result.json !== 'string') return null;
  const filename = typeof result.filename === 'string' && result.filename
    ? result.filename
    : 'realm-archive.realm.json';
  return { blob: new Blob([result.json], { type: 'application/json' }), filename };
}

/**
 * Failure result of {@link downloadRealmArchive} when the export itself did
 * not produce bytes (no DOM interaction happens).
 */
export interface RealmArchiveDownloadFailure {
  /** Always false. */
  readonly success: false;
  /** Always empty (no filename was produced). */
  readonly filename: '';
  /** Always zero bytes. */
  readonly size: 0;
  /** Typed export failure code, or a generic archive-failure code. */
  readonly error: string;
}

/**
 * Downloads one successful export through the shared browser download
 * utility.
 *
 * @param result - Store export result.
 * @returns Download receipt, or a typed failure object when the export failed.
 */
export function downloadRealmArchive(result: RealmArchiveExportView): DownloadReceipt | RealmArchiveDownloadFailure {
  const prepared = buildRealmArchiveDownload(result);
  if (!prepared) {
    return {
      success: false,
      filename: '',
      size: 0,
      error: result?.code ?? 'ERR_STORE_ARCHIVE_FAILED'
    };
  }
  return triggerBrowserBlobDownload(prepared.blob, prepared.filename);
}

/**
 * Formats the export outcome for the operator surface.
 *
 * @param result - Store export result.
 * @returns One-line operator copy.
 */
export function describeRealmArchiveExport(result: RealmArchiveExportView): string {
  if (!result || result.success !== true) {
    return `Realm export failed (${result?.code ?? 'unknown failure'}).`;
  }
  const base = `Realm archive ready (${result.filename ?? 'realm archive'})`;
  return result.warnings.length > 0
    ? `${base} — ${result.warnings.length} disclosure(s).`
    : `${base}.`;
}

/**
 * Formats the import receipt for the operator surface (fresh realm name/id,
 * section counters, and dropped-authority count).
 *
 * @param receipt - Store import receipt.
 * @returns Multi-line operator summary.
 */
export function describeRealmArchiveImport(receipt: RealmArchiveImportReceipt): string {
  if (!receipt || receipt.success !== true) {
    return `Realm import failed (${receipt?.code ?? 'unknown failure'}).`;
  }
  const dropped = receipt.droppedAuthority.reduce((count, entry) => count + entry.authorities.length, 0);
  const lines = [
    `Imported "${receipt.realmName ?? receipt.realmId}" (${receipt.realmId}).`,
    `${receipt.membersImported} active + ${receipt.membersRecycled} recycled member(s), `
    + `${receipt.filesImported} file(s), ${receipt.schedulesImported} schedule(s), `
    + `${receipt.payloadsImported} payload(s).`,
    `${receipt.attachmentsImported} attachment(s) re-attached, ${receipt.attachmentsSkipped} skipped; `
    + `template ${receipt.templateImported ? 'imported' : 'kept local'}.`
  ];
  if (dropped > 0) {
    lines.push(`${dropped} authority item(s) were NOT re-applied — re-grant them explicitly if intended.`);
  }
  if (receipt.warnings.length > 0) {
    lines.push(`${receipt.warnings.length} disclosure(s): ${receipt.warnings.join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * Formats one dropped-authority receipt entry for the operator surface.
 *
 * @param entry - Dropped-authority entry.
 * @returns Operator copy naming the member and dropped items.
 */
export function describeDroppedRealmAuthority(entry: { memberId: string; authorities: readonly string[] }): string {
  return `${entry.memberId}: ${entry.authorities.join(', ') || 'none'}`;
}
