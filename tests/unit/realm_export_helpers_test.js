/**
 * @file tests/unit/realm_export_helpers_test.js
 * @description S2 realm-export lane (ticket 3fe5221) unit coverage for the
 *   host-facing archive helpers: download blob/filename assembly, the
 *   browser-download wrapper's headless receipt, and the operator-copy
 *   formatting for export results, import receipts, and dropped authority.
 *
 *   Zero-Mock: the helpers are exercised directly against real store-result
 *   shapes (plain frozen data); the download wrapper runs its real headless
 *   branch (no `window`/`document` in Node) and never touches a DOM.
 *
 * Standalone: `timeout 90 node tests/unit/realm_export_helpers_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRealmArchiveDownload,
  describeDroppedRealmAuthority,
  describeRealmArchiveExport,
  describeRealmArchiveImport,
  downloadRealmArchive
} from '../../src/lib/components/sandbox/realmArchiveHelpers.ts';

/** Successful store export result fixture. */
const EXPORT_RESULT = Object.freeze({
  success: true,
  archiveId: 'archive-1',
  json: '{"format":"ai-story.realm-archive","formatVersion":1}',
  filename: 'demo-realm-abcd1234.realm.json',
  warnings: Object.freeze([])
});

/** Import receipt fixture. */
const IMPORT_RECEIPT = Object.freeze({
  success: true,
  realmId: 'realm_new',
  realmName: 'Imported Realm',
  archiveId: 'archive-1',
  membersImported: 2,
  membersRecycled: 1,
  filesImported: 3,
  schedulesImported: 1,
  attachmentsImported: 1,
  attachmentsSkipped: 1,
  templateImported: false,
  payloadsImported: 1,
  droppedAuthority: Object.freeze([
    Object.freeze({ memberId: 'coordinator', authorities: Object.freeze(['privileged', 'realmBypass']) })
  ]),
  warnings: Object.freeze(['extension x is not installed locally'])
});

test('buildRealmArchiveDownload assembles the JSON blob and filename', async () => {
  const prepared = buildRealmArchiveDownload(EXPORT_RESULT);
  assert.ok(prepared, 'a successful export prepares a download');
  assert.strictEqual(prepared.filename, EXPORT_RESULT.filename);
  assert.strictEqual(prepared.blob.type, 'application/json');
  assert.strictEqual(prepared.blob.size, Buffer.byteLength(EXPORT_RESULT.json, 'utf8'));
  assert.strictEqual(await prepared.blob.text(), EXPORT_RESULT.json, 'the blob carries the canonical bytes verbatim');

  assert.strictEqual(buildRealmArchiveDownload({ success: false, warnings: [] }), null, 'failed exports never prepare a download');
  assert.strictEqual(buildRealmArchiveDownload(null), null);
});

test('downloadRealmArchive wraps the shared browser download utility', () => {
  const receipt = downloadRealmArchive(EXPORT_RESULT);
  assert.strictEqual(receipt.success, true, 'the download utility accepts the prepared blob');
  assert.strictEqual(receipt.filename, EXPORT_RESULT.filename);
  assert.strictEqual(typeof receipt.size, 'number');

  const failed = downloadRealmArchive({ success: false, warnings: [], code: 'ERR_STORE_REALM_NOT_FOUND' });
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.error, 'ERR_STORE_REALM_NOT_FOUND');
});

test('operator copy describes export results and import receipts', () => {
  assert.match(describeRealmArchiveExport(EXPORT_RESULT), /demo-realm-abcd1234\.realm\.json/);
  assert.match(
    describeRealmArchiveExport({ ...EXPORT_RESULT, warnings: ['missing template'] }),
    /1 disclosure/
  );
  assert.match(describeRealmArchiveExport({ success: false, warnings: [], code: 'ERR_STORE_ARCHIVE_FAILED' }), /ERR_STORE_ARCHIVE_FAILED/);

  const summary = describeRealmArchiveImport(IMPORT_RECEIPT);
  assert.match(summary, /Imported "Imported Realm" \(realm_new\)/);
  assert.match(summary, /2 active \+ 1 recycled/);
  assert.match(summary, /1 attachment\(s\) re-attached, 1 skipped/);
  assert.match(summary, /2 authority item\(s\) were NOT re-applied/);
  assert.match(summary, /1 disclosure/);
  assert.strictEqual(describeDroppedRealmAuthority(IMPORT_RECEIPT.droppedAuthority[0]), 'coordinator: privileged, realmBypass');
  assert.match(describeRealmArchiveImport({ success: false, code: 'ERR_STORE_INVALID_PARAMS' }), /ERR_STORE_INVALID_PARAMS/);
});
