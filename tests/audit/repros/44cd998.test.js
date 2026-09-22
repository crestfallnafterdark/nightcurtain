/**
 * @file tests/audit/repros/44cd998.test.js
 * @description Audit repro for ticket 44cd998 (Major, area:vfs): a `maxWords`
 * continuation cut that lands exactly on a line boundary reports `nextLine`
 * past the undelivered line, silently skipping it.
 *
 * Evidence: `src/lib/sandbox/virtualFs/index.ts:2164` computes `nextLine` from
 * `cutIsMidLine`; at a line-boundary cut the non-mid-line branch reports
 * `cut.lineNumber + 1`, which points past a line that was never delivered.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/44cd998.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

const FILE_CONTENT = 'a b c\nd e\nf g';
const SOURCE_LINES = ['a b c', 'd e', 'f g'];

/**
 * Pulls pages with `startLine`/`maxWords` until the continuation token ends,
 * following `nextOffset` on intra-line resumes. Returns the logical source
 * lines: `N: ` scaffolding is stripped and a fragment that continues a
 * mid-line cut is merged back into the line it belongs to (the contract
 * documented at `virtualFs.js:1939-1945`).
 */
function pullLogicalLines(vfs, filePath, { startLine, maxWords }) {
  const pages = [];
  let page = vfs.readFile(filePath, { workspaceId: 'global', startLine, maxWords });
  while (true) {
    pages.push(page);
    if (!page.truncated) break;
    assert.ok(pages.length <= 50, 'continuation pagination must terminate');
    const params = { workspaceId: 'global', startLine: page.nextLine, maxWords };
    if (page.nextOffset !== undefined) params.offset = page.nextOffset;
    page = vfs.readFile(filePath, params);
  }

  const logicalLines = [];
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].content === '') continue;
    const fragments = pages[i].content.split('\n').map((line) => line.replace(/^\d+: /, ''));
    const previous = i > 0 ? pages[i - 1] : null;
    if (previous && previous.nextOffset !== undefined && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += fragments[0];
      logicalLines.push(...fragments.slice(1));
    } else {
      logicalLines.push(...fragments);
    }
  }

  return { pages, logicalLines };
}

test('44cd998: line-boundary maxWords cut delivers every source line exactly once', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/repro_line_boundary.txt', FILE_CONTENT, { workspaceId: 'global' });

  const { logicalLines } = pullLogicalLines(vfs, '/repro_line_boundary.txt', { startLine: 1, maxWords: 3 });

  assert.deepStrictEqual(
    logicalLines,
    SOURCE_LINES,
    'every source line must be delivered exactly once, in order (line 2 "d e" must not be skipped)'
  );
  assert.strictEqual(
    logicalLines.join('\n'),
    FILE_CONTENT,
    'reassembled pulls must reconstruct the file exactly'
  );
});

test('44cd998: continuation token names the first undelivered line at a line-boundary cut', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/repro_line_boundary_token.txt', FILE_CONTENT, { workspaceId: 'global' });

  const first = vfs.readFile('/repro_line_boundary_token.txt', {
    workspaceId: 'global',
    startLine: 1,
    maxWords: 3
  });

  assert.strictEqual(first.truncated, true, 'a 3-word budget over 5 words must truncate');
  assert.strictEqual(first.nextOffset, undefined, 'a line-boundary cut must not report an intra-line offset');
  assert.strictEqual(
    first.nextLine,
    2,
    'nextLine must be the first line not fully delivered; a value of 3 jumps two lines and skips "d e"'
  );
});
