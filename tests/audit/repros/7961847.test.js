/**
 * @file tests/audit/repros/7961847.test.js
 * @description Audit repro for ticket 7961847 (Major, area:docs): the object-first
 * forms of `getFileRecord`/`listFilesWithContent` discard the documented trailing
 * trusted `VirtualFsCallContext` and the payload's nested `options`, falling back
 * to the `global` workspace and returning `null`/`[]` for private-workspace reads.
 *
 * Evidence: `src/lib/sandbox/virtualFs/index.ts` `getFileRecord` (`opts = filePathOrParams`)
 * and `listFilesWithContent` (`opts = dirPath`) never merge `arg1.options` or the
 * second argument, unlike every sibling object-first method
 * (`readFile`/`writeFile`/`listFiles`/`exists`/`grep`/...).
 *
 * Contract pins: `virtualFs.d.ts` `GetFileRecordParams.options` /
 * `ListFilesParams.options` ("Nested trusted options merged into the call options")
 * and `VirtualFsCallContext` ("accepted as the optional trailing argument of every
 * object-first call form").
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/7961847.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

const CONTENT = 'agent a payload';

function seedPrivateWorkspace() {
  const vfs = new VirtualFS();
  vfs.writeFile('/p.txt', CONTENT, { workspaceId: 'agent_a', callerAgentId: 'agent_a' });
  return vfs;
}

test('7961847: getFileRecord object-first honors the trailing trusted context', () => {
  const vfs = seedPrivateWorkspace();

  const record = vfs.getFileRecord(
    { filePath: '/p.txt' },
    { workspaceId: 'agent_a', callerAgentId: 'agent_a' }
  );

  assert.ok(record, 'context-selected workspace read must return the record, not null');
  assert.strictEqual(record.workspaceId, 'agent_a');
  assert.strictEqual(record.content, CONTENT);
});

test('7961847: getFileRecord object-first honors the nested payload options', () => {
  const vfs = seedPrivateWorkspace();

  const record = vfs.getFileRecord({
    filePath: '/p.txt',
    options: { workspaceId: 'agent_a', callerAgentId: 'agent_a' }
  });

  assert.ok(record, 'nested-options workspace read must return the record, not null');
  assert.strictEqual(record.workspaceId, 'agent_a');
  assert.strictEqual(record.content, CONTENT);
});

test('7961847: listFilesWithContent object-first honors the trailing trusted context', () => {
  const vfs = seedPrivateWorkspace();

  const records = vfs.listFilesWithContent(
    { directory_path: '/' },
    { workspaceId: 'agent_a', callerAgentId: 'agent_a' }
  );

  assert.strictEqual(records.length, 1, 'context-selected workspace listing must not fall back to global');
  assert.strictEqual(records[0].path, '/p.txt');
  assert.strictEqual(records[0].workspaceId, 'agent_a');
});

test('7961847: listFilesWithContent object-first honors the nested payload options', () => {
  const vfs = seedPrivateWorkspace();

  const records = vfs.listFilesWithContent({
    directory_path: '/',
    options: { workspaceId: 'agent_a', callerAgentId: 'agent_a' }
  });

  assert.strictEqual(records.length, 1, 'nested-options workspace listing must not fall back to global');
  assert.strictEqual(records[0].path, '/p.txt');
  assert.strictEqual(records[0].workspaceId, 'agent_a');
});
