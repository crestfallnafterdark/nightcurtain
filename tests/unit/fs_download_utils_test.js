/**
 * @file tests/unit/fs_download_utils_test.js
 * @description Unit and integration test suite for Local Filesystem folder/file downloading, uploading, copying, and archiving.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectArchiveCapability,
  getMimeType,
  sanitizeDownloadFilename,
  downloadSingleFile,
  downloadFilesSeparately,
  createArchiveBlob,
  downloadFolderAsArchive,
  filterFilesByFolder,
  isFolderUploadSupported,
  processUploadedFiles,
  extractFilesFromDataTransfer
} from '../../src/lib/sandbox/fsDownloadUtils/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';

test('1. MIME Type & Filename Sanitization', () => {
  assert.ok(getMimeType('/data/config.json').includes('application/json'));
  assert.ok(getMimeType('/docs/readme.md').includes('text/markdown'));
  assert.ok(getMimeType('/logs/run.log').includes('text/plain'));
  assert.ok(getMimeType('/scripts/main.js').includes('application/javascript'));
  assert.strictEqual(getMimeType('/raw.bin'), 'application/octet-stream');

  assert.strictEqual(sanitizeDownloadFilename('global/data/config.json'), 'global_data_config.json');
  assert.strictEqual(sanitizeDownloadFilename('file:name*?.txt'), 'file_name__.txt');
});

test('2. Archive Capability Detection & Folder Upload Support', () => {
  const cap = detectArchiveCapability();
  assert.ok(cap.type === 'compression_stream' || cap.type === 'zip' || cap.type === 'none');
  assert.ok(typeof isFolderUploadSupported() === 'boolean');
});

test('3. Single File Download Simulation', () => {
  const fileReceipt = downloadSingleFile({
    path: '/models/npc_actor.json',
    content: { name: 'Eldrin', role: 'Mage' },
    workspaceId: 'global',
    readOnly: true
  });
  assert.strictEqual(fileReceipt.success, true);
  assert.strictEqual(fileReceipt.filename, 'models_npc_actor.json');
});

test('4. Separate Files Download', async () => {
  const filesToDownload = [
    { path: '/config.json', content: '{"version": 1}', workspaceId: 'global' },
    { path: '/notes.txt', content: 'Meeting notes', workspaceId: 'global' },
    { path: '/schema.json', content: '{"type": "object"}', workspaceId: 'global' }
  ];

  const progressEvents = [];
  const separateRes = await downloadFilesSeparately(filesToDownload, {
    delayMs: 5,
    onProgress: (cur, tot, file) => {
      progressEvents.push({ cur, tot, file });
    }
  });

  assert.strictEqual(separateRes.success, true);
  assert.strictEqual(separateRes.count, 3);
  assert.strictEqual(progressEvents.length, 3);
});

test('5. Filter Files By Folder Prefix', () => {
  const allFiles = [
    { path: '/lore/factions/solaris.json', content: '{}' },
    { path: '/lore/world.md', content: '# World' },
    { path: '/drafts/ch1.txt', content: 'Scene 1' },
    { path: '/config.json', content: '{}' }
  ];

  const loreFiles = filterFilesByFolder(allFiles, '/lore');
  assert.strictEqual(loreFiles.length, 2);
  assert.ok(loreFiles.some(f => f.path === '/lore/factions/solaris.json'));
  assert.ok(loreFiles.some(f => f.path === '/lore/world.md'));

  const draftFiles = filterFilesByFolder(allFiles, '/drafts');
  assert.strictEqual(draftFiles.length, 1);
  assert.strictEqual(draftFiles[0].path, '/drafts/ch1.txt');

  const rootFiles = filterFilesByFolder(allFiles, '/');
  assert.strictEqual(rootFiles.length, 4);
});

test('6. GZIP Archive Generation with CompressionStream & downloadFolderAsArchive', async () => {
  const filesToDownload = [
    { path: '/config.json', content: '{"version": 1}', workspaceId: 'global' },
    { path: '/notes.txt', content: 'Meeting notes', workspaceId: 'global' },
    { path: '/schema.json', content: '{"type": "object"}', workspaceId: 'global' }
  ];

  const archiveResult = await createArchiveBlob(filesToDownload, {
    archiveName: 'test_bundle'
  });

  assert.ok(archiveResult.filename === 'test_bundle.tar.gz' || archiveResult.filename === 'test_bundle.zip');
  assert.ok(archiveResult.blob instanceof Blob || archiveResult.blob instanceof Uint8Array);

  const arrayBuffer = await archiveResult.blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  assert.strictEqual(buffer[0], 0x1f);
  assert.strictEqual(buffer[1], 0x8b);

  const downloadReceipt = await downloadFolderAsArchive(filesToDownload, { archiveName: 'folder_bundle' });
  assert.strictEqual(downloadReceipt.success, true);
  assert.strictEqual(downloadReceipt.filesCount, 3);
});

test('7. Upload Utilities & File Processing', async () => {
  const mockUploadFiles = [
    { name: 'app.config.json', webkitRelativePath: 'project/app.config.json', text: async () => '{"app": "story"}' },
    { name: 'readme.txt', webkitRelativePath: 'project/docs/readme.txt', text: async () => 'Documentation' }
  ];

  const processedUploads = await processUploadedFiles(mockUploadFiles, { baseDir: '/custom' });
  assert.strictEqual(processedUploads.length, 2);
  assert.strictEqual(processedUploads[0].path, '/custom/project/app.config.json');
  assert.strictEqual(processedUploads[0].content, '{"app": "story"}');
  assert.strictEqual(processedUploads[1].path, '/custom/project/docs/readme.txt');
  assert.strictEqual(processedUploads[1].content, 'Documentation');
});

test('8. Separate Files Download Reports Per-Entry Failures Without Rejecting', async () => {
  const progressEvents = [];
  const batchRes = await downloadFilesSeparately([
    { path: '/ok_first.txt', content: 'first', workspaceId: 'global' },
    null,
    { path: '/ok_third.txt', content: 'third', workspaceId: 'global' },
    { path: 42, content: 'bad path' }
  ], {
    delayMs: 1,
    prefixWorkspace: false,
    onProgress: (cur, tot, file) => {
      progressEvents.push({ cur, tot, file });
    }
  });

  assert.strictEqual(batchRes.success, false);
  assert.strictEqual(batchRes.count, 2);
  assert.deepStrictEqual(batchRes.files, ['ok_first.txt', 'ok_third.txt']);
  assert.strictEqual(progressEvents.length, 2);
  assert.strictEqual(batchRes.failures.length, 2);
  assert.strictEqual(batchRes.failures[0].index, 1);
  assert.strictEqual(batchRes.failures[0].path, null);
  assert.ok(batchRes.failures[0].error.length > 0);
  assert.strictEqual(batchRes.failures[1].index, 3);
  assert.strictEqual(batchRes.failures[1].path, null);

  const allOkRes = await downloadFilesSeparately([
    { path: '/only.txt', content: 'only' }
  ], { delayMs: 0 });
  assert.strictEqual(allOkRes.success, true);
  assert.deepStrictEqual(allOkRes.failures, []);
});

test('9. Upload Wrapper Content And Size Win Over File Handle', async () => {
  const processed = await processUploadedFiles([
    {
      file: { name: 'from-handle.txt', size: 11, text: async () => 'from-handle' },
      path: 'wrapped/precedence.txt',
      content: 'explicit-wrapper-content',
      size: 26
    },
    {
      file: { name: 'fallback.txt', size: 5, text: async () => 'hello' },
      path: 'wrapped/fallback.txt'
    }
  ], { baseDir: '/imported' });

  assert.strictEqual(processed.length, 2);
  assert.strictEqual(processed[0].path, '/imported/wrapped/precedence.txt');
  assert.strictEqual(processed[0].content, 'explicit-wrapper-content');
  assert.strictEqual(processed[0].size, 26);
  assert.strictEqual(processed[1].content, 'hello');
  assert.strictEqual(processed[1].size, 5);
});

test('10. XML MIME Type', () => {
  assert.strictEqual(getMimeType('/feeds/sitemap.xml'), 'application/xml;charset=utf-8');
  assert.strictEqual(getMimeType('/icons/logo.svg'), 'image/svg+xml;charset=utf-8');
});

test('11. SandboxStore Upload, Copy & Delete Integration', async () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/system_config.json', JSON.stringify({ mode: 'sandbox' }), { workspaceId: 'global' });
  vfs.writeFile('/logs/boot.log', 'System initialized successfully', { workspaceId: 'global' });
  vfs.writeFile('/private_state.json', JSON.stringify({ state: 'ready' }), { workspaceId: 'agent-01', callerAgentId: 'agent-01' });

  const store = new SandboxStore({
    virtualFs: vfs,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  const mockUploadFiles = [
    { name: 'app.config.json', webkitRelativePath: 'project/app.config.json', text: async () => '{"app": "story"}' }
  ];

  const uploadRes = await store.uploadFiles(mockUploadFiles, 'global');
  assert.strictEqual(uploadRes.success, true);
  assert.strictEqual(uploadRes.count, 1);
  assert.ok(vfs.exists('/project/app.config.json', { workspaceId: 'global' }));

  const copySameWs = store.copyFile('/system_config.json', '/system_config_backup.json', {
    srcWorkspaceId: 'global',
    destWorkspaceId: 'global'
  });
  assert.strictEqual(copySameWs.success, true);
  assert.ok(vfs.exists('/system_config_backup.json', { workspaceId: 'global' }));

  const copyCrossWs = store.copyFile('/system_config.json', '/imported_config.json', {
    srcWorkspaceId: 'global',
    destWorkspaceId: 'agent-01',
    callerAgentId: 'agent-01'
  });
  assert.strictEqual(copyCrossWs.success, true);
  assert.ok(vfs.exists('/imported_config.json', { workspaceId: 'agent-01', callerAgentId: 'agent-01' }));

  const deleteRes = store.deleteFiles(['/project/app.config.json'], 'global');
  assert.strictEqual(deleteRes.success, true);
  assert.strictEqual(deleteRes.count, 1);
  assert.ok(!vfs.exists('/project/app.config.json', { workspaceId: 'global' }));
});
