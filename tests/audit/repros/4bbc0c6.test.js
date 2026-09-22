/**
 * @file tests/audit/repros/4bbc0c6.test.js
 * @description Audit repro for ticket 4bbc0c6 (Major, area:docs): the
 * `InlineFileMessageResult` contract documents `totalBytes` /
 * `inlinedFiles[].bytes` as the byte length of the inlined contents, but
 * `inlineFileInMessage` stamps them with the VirtualFS envelope's full-file
 * `totalBytes` while embedding only the budget-truncated `content`; the
 * truncation (`readResult.truncated` / `deliveryNote`) is dropped, so the
 * delivered body is silently short.
 *
 * Evidence: `src/lib/sandbox/messagingBus/index.ts:1318-1319` (full-file
 * `readResult.totalBytes`) vs `virtualFs.d.ts:979-1006` (`totalBytes` = whole
 * file, `bytesIncluded` = delivered slice, `truncated` + `deliveryNote`).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/4bbc0c6.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

const FULL_BYTES = 25000;

test('4bbc0c6: inline byte metadata must report delivered bytes and surface truncation', async () => {
  const vfs = new VirtualFS();
  const body = 'A'.repeat(FULL_BYTES);
  vfs.writeFile('/big.txt', body, { workspaceId: 'global' });

  const bus = new MessagingBus();
  bus.registerAgent('s');
  bus.registerAgent('r');

  const result = await bus.inlineFileInMessage('/big.txt', 'r', {
    from: 's',
    virtualFs: vfs,
    workspaceId: 'global'
  });
  assert.strictEqual(result.success, true);
  assert.ok(Array.isArray(result.inlinedFiles) && result.inlinedFiles.length === 1);

  const deliveredBytes = result.inlinedFiles[0].bytes;
  assert.ok(
    deliveredBytes < FULL_BYTES,
    `inlinedFiles[].bytes must be the delivered byte count, not the full file size (got ${deliveredBytes})`
  );
  assert.strictEqual(
    result.totalBytes,
    deliveredBytes,
    'totalBytes must equal the delivered byte count'
  );

  const read = bus.readMessage('r', result.id);
  assert.strictEqual(read.success, true);
  assert.ok(
    /truncat/i.test(read.message.content),
    'the delivered message content must surface the VirtualFS truncation note'
  );
  assert.ok(
    read.message.content.includes(body.slice(0, 64)),
    'the delivered message content must keep the delivered prefix'
  );
});
