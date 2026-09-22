/**
 * @file tests/audit/repros/4a18f56.test.js
 * @description Audit repro for ticket 4a18f56 (Major, area:docs):
 * `detectArchiveCapability` reports `type: 'zip'` for any truthy ZipWriter/JSZip/
 * ZipArchive global, even when the engine exposes no `createZipBlob`; the ZIP branch
 * in `createArchiveBlob` then does nothing without falling through, so the documented
 * browser-native `CompressionStream('gzip')` fallback never runs and the archive call
 * throws `capability = 'none'`.
 *
 * Evidence: `src/lib/sandbox/fsDownloadUtils/index.ts` capability probe (truthy-only) and
 * the non-falling-through ZIP branch gated on `capability.type === 'zip'`.
 *
 * Contract pin: `fsDownloadUtils.d.ts` @invariant "Archive engine precedence:
 * `createArchiveBlob` uses a discovered ZIP engine first, otherwise browser-native
 * `CompressionStream('gzip')` ..." and invariant #2 on `createArchiveBlob`
 * ("Falls back ... when no usable ZIP engine is present").
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/4a18f56.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectArchiveCapability,
  createArchiveBlob,
  downloadFolderAsArchive
} from '../../../src/lib/sandbox/fsDownloadUtils/index.ts';

const FILES = [{ path: '/notes/a.txt', content: 'alpha', workspaceId: 'global' }];

function assertGzipMagic(bytes) {
  assert.strictEqual(bytes[0], 0x1f, 'gzip magic byte 0 must be 0x1f');
  assert.strictEqual(bytes[1], 0x8b, 'gzip magic byte 1 must be 0x8b');
}

test('4a18f56: bare ZipWriter global without createZipBlob is not reported as a usable zip capability', () => {
  function BareZipWriter() {}
  const cap = detectArchiveCapability({ ZipWriter: BareZipWriter, CompressionStream });

  assert.strictEqual(cap.type, 'compression_stream');
  assert.strictEqual(cap.format, 'tar.gz');
});

test('4a18f56: bare JSZip and non-function createZipBlob properties also fall through', () => {
  function BareJSZip() {}
  function NotAMethod() {}
  NotAMethod.createZipBlob = 42;

  for (const scope of [
    { JSZip: BareJSZip, CompressionStream },
    { ZipArchive: {}, CompressionStream },
    { zip: { ZipWriter: BareJSZip }, CompressionStream },
    { ZipWriter: NotAMethod, CompressionStream }
  ]) {
    const cap = detectArchiveCapability(scope);
    assert.strictEqual(cap.type, 'compression_stream', 'unusable ZIP engine must fall through to CompressionStream');
    assert.strictEqual(cap.format, 'tar.gz');
  }
});

test('4a18f56: createArchiveBlob produces a gzip archive when only a bare ZIP global is present', async () => {
  const result = await createArchiveBlob(FILES, {}, { ZipWriter: function BareZipWriter() {}, CompressionStream });

  assert.strictEqual(result.format, 'tar.gz');
  assert.ok(result.filename.endsWith('.tar.gz'), `expected .tar.gz filename, got ${result.filename}`);
  assertGzipMagic(new Uint8Array(await result.blob.arrayBuffer()));
});

test('4a18f56: downloadFolderAsArchive succeeds when only a bare ZIP global is present', async () => {
  const receipt = await downloadFolderAsArchive(FILES, {}, { ZipWriter: function BareZipWriter() {}, CompressionStream });

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.format, 'tar.gz');
  assert.strictEqual(receipt.capability, 'compression_stream');
  assert.strictEqual(receipt.filesCount, 1);
});

test('4a18f56: usable ZIP engine (createZipBlob function) still takes precedence over CompressionStream', async () => {
  function ZipEngine() {}
  ZipEngine.createZipBlob = async () => new Blob(['PK\x03\x04'], { type: 'application/zip' });

  const cap = detectArchiveCapability({ ZipWriter: ZipEngine, CompressionStream });
  assert.strictEqual(cap.type, 'zip');

  const result = await createArchiveBlob(FILES, {}, { ZipWriter: ZipEngine, CompressionStream });
  assert.strictEqual(result.format, 'zip');
  assert.ok(result.filename.endsWith('.zip'));
});
