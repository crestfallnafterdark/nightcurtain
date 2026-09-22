/**
 * @file tests/audit/repros/3ccd9a3.test.js
 * @description Audit repro for ticket 3ccd9a3 (Minor, area:docs):
 * `downloadSingleFile` falls back to the raw unsanitized `baseName` when the full
 * sanitized path collapses to '', so all-symbol / all-CJK / backslash-only names are
 * handed to `anchor.download` verbatim, contradicting the documented filename
 * sanitization guarantee.
 *
 * Evidence: `src/lib/sandbox/fsDownloadUtils/index.ts`
 * `sanitizeDownloadFilename(...) || baseName` fallback (baseName is never sanitized).
 *
 * Contract pin: `fsDownloadUtils.d.ts` @invariant "Download filenames are sanitized:
 * `sanitizeDownloadFilename` maps directory separators and illegal characters to `_`
 * and strips leading `_` ..." and `DownloadReceipt.filename` ("Sanitized local
 * filename used for the browser download.").
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/3ccd9a3.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadSingleFile } from '../../../src/lib/sandbox/fsDownloadUtils/index.ts';

const ILLEGAL_CHARS = /[^a-zA-Z0-9._-]/;

function assertSanitizedFilename(receipt) {
  assert.ok(receipt.filename.length > 0, 'filename must not be empty');
  assert.ok(
    !ILLEGAL_CHARS.test(receipt.filename),
    `filename must contain only sanitized characters, got ${JSON.stringify(receipt.filename)}`
  );
}

test('3ccd9a3: all-CJK path never leaks the raw baseName', () => {
  const receipt = downloadSingleFile({ path: '/中文', content: 'x' });
  assertSanitizedFilename(receipt);
  assert.strictEqual(receipt.filename, 'file.txt');
});

test('3ccd9a3: all-symbol path never leaks the raw baseName', () => {
  const receipt = downloadSingleFile({ path: '/???@#!', content: 'x' });
  assertSanitizedFilename(receipt);
  assert.strictEqual(receipt.filename, 'file.txt');
});

test('3ccd9a3: backslash-only path never leaks the raw baseName', () => {
  const receipt = downloadSingleFile({ path: '/\\', content: 'x' });
  assertSanitizedFilename(receipt);
  assert.strictEqual(receipt.filename, 'file.txt');
});

test('3ccd9a3: workspace-prefixed all-CJK path stays sanitized', () => {
  const receipt = downloadSingleFile({ path: '/中文', content: 'x', workspaceId: 'ws' }, { prefixWorkspace: true });
  assertSanitizedFilename(receipt);
});

test('3ccd9a3: ordinary paths are unchanged by the sanitized fallback', () => {
  const receipt = downloadSingleFile({ path: '/models/npc_actor.json', content: '{}' });
  assert.strictEqual(receipt.filename, 'models_npc_actor.json');
});
