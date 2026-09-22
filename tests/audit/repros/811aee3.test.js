/**
 * @file tests/audit/repros/811aee3.test.js
 * @description Audit repro for ticket 811aee3 (Major, area:docs): for an
 * `offset` + `limit` cut that lands inside a line, `ReadFileResult.nextLine`
 * reports the line *after* the cut instead of the line containing the resume
 * point, so the documented `nextLine` + `nextOffset` resume silently skips the
 * remainder of the cut line.
 *
 * Evidence: `src/lib/sandbox/virtualFs/index.ts:2284-2285` computes
 * `linesUpToSlice = fullContent.slice(0, off + slicedContent.length).split(/\r?\n/).length`
 * and always reports `linesUpToSlice + 1`.
 *
 * Contract pin: `virtualFs.d.ts` `ReadFileResult.nextLine` ("When an intra-line
 * `nextOffset` is present this is the line containing that resume point (resume
 * with `nextLine` + `nextOffset`)").
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/811aee3.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

// Line 1: 'abcd' (offsets 0-3), line 2: 'efgh' (offsets 5-8), line 3: 'ijkl' (10-13).
const CONTENT = 'abcd\nefgh\nijkl\n';

test('811aee3: intra-line offset cut reports the containing line as nextLine', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/t.txt', CONTENT, { workspaceId: 'global' });

  const page = vfs.readFile('/t.txt', { workspaceId: 'global', offset: 6, limit: 2 });

  assert.strictEqual(page.content, 'fg');
  assert.strictEqual(page.nextOffset, 8, 'resume offset 8 is the "h" inside line 2');
  assert.strictEqual(page.truncated, true);
  assert.strictEqual(
    page.nextLine,
    2,
    'the resume point sits inside line 2, so nextLine must be 2 (pre-fix it is 3)'
  );
});

test('811aee3: documented nextLine+nextOffset resume does not skip the cut line tail', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/t.txt', CONTENT, { workspaceId: 'global' });

  const page = vfs.readFile('/t.txt', { workspaceId: 'global', offset: 6, limit: 2 });
  const resume = vfs.readFile('/t.txt', {
    workspaceId: 'global',
    startLine: page.nextLine,
    offset: page.nextOffset
  });

  assert.ok(
    resume.content.includes('h'),
    `resumed read must deliver the rest of the cut line ("h"), got ${JSON.stringify(resume.content)}`
  );

  const reassembled = CONTENT.slice(0, page.nextOffset) + resume.content.replace(/^\d+: /gm, '');
  assert.strictEqual(reassembled, CONTENT, 'nextLine+nextOffset resume must reconstruct the file without loss');
});
