/**
 * @file tests/audit/repros/3bad710.test.js
 * @description Audit repro for ticket 3bad710 (Major, area:docs):
 * `downloadFolderAsArchive` failure receipts echo the attempted capability `format`
 * ('zip'/'tar.gz') although no archive was produced, contradicting the documented
 * `ArchiveDownloadReceipt.format` contract: "'zip' or 'tar.gz'), or 'none' when no
 * archive is produced (empty input or failure)".
 *
 * Evidence: `src/lib/sandbox/fsDownloadUtils/index.ts` catch branch sets
 * `format: capability.format` instead of `'none'`.
 *
 * Contract pin: `fsDownloadUtils.d.ts` `ArchiveDownloadReceipt.format` ("or 'none'
 * when no archive is produced (empty input or failure)").
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/3bad710.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadFolderAsArchive } from '../../../src/lib/sandbox/fsDownloadUtils/index.ts';

const FILES = [{ path: '/notes/a.txt', content: 'alpha', workspaceId: 'global' }];

test('3bad710: ZIP engine rejection reports format none, not the attempted zip format', async () => {
  function BoomZipEngine() {}
  BoomZipEngine.createZipBlob = async () => {
    throw new Error('zip engine boom');
  };

  const receipt = await downloadFolderAsArchive(FILES, {}, { ZipWriter: BoomZipEngine });

  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.format, 'none', 'a failed archive must report format none');
  assert.strictEqual(receipt.filesCount, 1);
  assert.match(receipt.error, /zip engine boom/);
});

test('3bad710: CompressionStream rejection reports format none, not the attempted tar.gz format', async () => {
  class LeakyCompressionStream {
    constructor(format) {
      this.format = format;
    }
  }

  const receipt = await downloadFolderAsArchive(FILES, {}, { CompressionStream: LeakyCompressionStream });

  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.format, 'none', 'a failed archive must report format none');
  assert.strictEqual(receipt.filesCount, 1);
});

test('3bad710: empty input and missing-engine receipts keep reporting format none', async () => {
  const empty = await downloadFolderAsArchive([], {});
  assert.strictEqual(empty.success, true);
  assert.strictEqual(empty.format, 'none');

  const missingEngine = await downloadFolderAsArchive(FILES, {}, {});
  assert.strictEqual(missingEngine.success, false);
  assert.strictEqual(missingEngine.format, 'none');
  assert.strictEqual(missingEngine.capability, 'none');
});
