/**
 * @file tests/unit/virtual_fs_module_test.js
 * @description Exhaustive isolated unit test suite for Module 1: virtual_filesystem.
 * Covers POSIX path normalization, multi-tenant workspace isolation, permissions,
 * file read/write, pagination slicing, budget limits, surgical text replacement,
 * RFC 6902 atomic JSON patching, JSONPath/jq querying, grep scanning, scoped agent proxies,
 * prompt template file inlining, snapshots, and download/archiving utilities.
 *
 * Conforms to ICD-MOD01-VFS (v2.0.0).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VirtualFS,
  DEFAULT_BUDGET_BYTES,
  DEFAULT_WORD_BUDGET,
  FILE_PLUMBING_MAX_FILE_BYTES,
  FILE_PLUMBING_MAX_TOTAL_BYTES,
  normalizeVirtualPath,
  renderTemplateWithFiles,
  isReservedWorkspaceKey,
  PermissionDeniedError,
  FileNotFoundError,
  FileExistsError,
  FileTooLargeError
} from '../../src/lib/sandbox/virtualFs/index.ts';

import {
  detectArchiveCapability,
  isFolderUploadSupported,
  downloadSingleFile,
  downloadFilesSeparately,
  createArchiveBlob,
  downloadFolderAsArchive,
  filterFilesByFolder,
  processUploadedFiles,
  extractFilesFromDataTransfer,
  getMimeType,
  sanitizeDownloadFilename,
  triggerBrowserBlobDownload
} from '../../src/lib/sandbox/fsDownloadUtils/index.ts';

/**
 * MOD-21 W4 test double: the composition-root identity resolver grants the
 * `operator` subject cross-workspace scope. Flags on per-call options confer
 * nothing; only this injected descriptor (or the injected internal principal
 * reference) authorizes cross-workspace operations.
 */
const OPERATOR_AUTHORITY = Object.freeze({
  subject: 'operator',
  kind: 'agent',
  allow: Object.freeze(new Set(['*'])),
  visibility: 'all'
});

function operatorPortOptions() {
  return {
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'operator'
        ? { id: agentId, privileged: false, allowedTools: [], authority: OPERATOR_AUTHORITY }
        : { id: agentId, privileged: false, allowedTools: [] })
    }
  };
}

/**
 * MOD-21 W8-D test principal: the opaque engine-internal reference injected as
 * `VirtualFSOptions.internalPrincipal`, required by the tenant-administration
 * members (`deleteWorkspace`, `reset`, `exportSnapshot`, `importSnapshot`,
 * `forAgent`).
 */
const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test_tenant_admin' });

// ============================================================================
// 1. Module Exports & Contract Constant Invariants
// ============================================================================

test('1. Contract Exports & Constants Invariants', () => {
  assert.strictEqual(typeof VirtualFS, 'function', 'VirtualFS class must be exported');
  assert.strictEqual(typeof normalizeVirtualPath, 'function', 'normalizeVirtualPath must be exported');
  assert.strictEqual(typeof renderTemplateWithFiles, 'function', 'renderTemplateWithFiles must be exported');
  assert.strictEqual(typeof PermissionDeniedError, 'function', 'PermissionDeniedError must be exported');
  assert.strictEqual(typeof FileNotFoundError, 'function', 'FileNotFoundError must be exported');
  assert.strictEqual(typeof FileExistsError, 'function', 'FileExistsError must be exported');

  assert.strictEqual(DEFAULT_BUDGET_BYTES, 20000, 'DEFAULT_BUDGET_BYTES must be 20,000 bytes');
  assert.strictEqual(DEFAULT_WORD_BUDGET, 3333, 'DEFAULT_WORD_BUDGET must be 3,333 words');

  // Error class prototypes & codes
  const permErr = new PermissionDeniedError('Denied', { workspaceId: 'ws_a', callerAgentId: 'agent_b', filePath: '/secret.txt' });
  assert.ok(permErr instanceof Error);
  assert.ok(permErr instanceof PermissionDeniedError);
  assert.strictEqual(permErr.code, 'PERMISSION_DENIED');
  assert.strictEqual(permErr.workspaceId, 'ws_a');
  assert.strictEqual(permErr.callerAgentId, 'agent_b');
  assert.strictEqual(permErr.filePath, '/secret.txt');

  const fnfErr = new FileNotFoundError('Missing', { workspaceId: 'global', filePath: '/missing.json' });
  assert.ok(fnfErr instanceof Error);
  assert.ok(fnfErr instanceof FileNotFoundError);
  assert.strictEqual(fnfErr.code, 'FILE_NOT_FOUND');
  assert.strictEqual(fnfErr.workspaceId, 'global');
  assert.strictEqual(fnfErr.filePath, '/missing.json');

  const feErr = new FileExistsError('Exists', { workspaceId: 'global', filePath: '/exists.txt' });
  assert.ok(feErr instanceof Error);
  assert.ok(feErr instanceof FileExistsError);
  assert.strictEqual(feErr.code, 'FILE_EXISTS');
  assert.strictEqual(feErr.workspaceId, 'global');
  assert.strictEqual(feErr.filePath, '/exists.txt');
});

// ============================================================================
// 2. POSIX Path Normalization
// ============================================================================

test('2. POSIX Path Normalization (normalizeVirtualPath)', () => {
  assert.strictEqual(normalizeVirtualPath(''), '/');
  assert.strictEqual(normalizeVirtualPath(null), '/');
  assert.strictEqual(normalizeVirtualPath(undefined), '/');
  assert.strictEqual(normalizeVirtualPath('/'), '/');
  assert.strictEqual(normalizeVirtualPath('lore/codex.json'), '/lore/codex.json');
  assert.strictEqual(normalizeVirtualPath('/lore//codex.json'), '/lore/codex.json');
  assert.strictEqual(normalizeVirtualPath('/a/b/../c'), '/a/c');
  assert.strictEqual(normalizeVirtualPath('/a/b/../../../../c'), '/c');
  assert.strictEqual(normalizeVirtualPath('a/./b/./c'), '/a/b/c');
  assert.strictEqual(normalizeVirtualPath('\\windows\\style\\path.txt'), '/windows/style/path.txt');
});

// ============================================================================
// 3. Core File Operations: Read, Write, Exists & Metadata
// ============================================================================

test('3. Core File Operations: Read, Write, Exists, and Metadata', () => {
  const vfs = new VirtualFS();

  // Write file
  const receipt = vfs.writeFile('/lore/world.md', '# World Codex\nMagic requires energy.', {
    workspaceId: 'global',
    callerAgentId: 'director',
    owner: 'director',
    readOnly: false
  });

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.path, '/lore/world.md');
  assert.strictEqual(receipt.workspaceId, 'global');
  assert.ok(receipt.size > 0);
  assert.strictEqual(receipt.linesWritten, 2);
  assert.strictEqual(receipt.owner, 'director');
  assert.strictEqual(receipt.readOnly, false);
  assert.ok(typeof receipt.updatedAt === 'number');

  // Exists
  assert.strictEqual(vfs.exists('/lore/world.md', { workspaceId: 'global' }), true);
  assert.strictEqual(vfs.exists('/lore/nonexistent.md', { workspaceId: 'global' }), false);

  // Get raw file record
  const record = vfs.getFileRecord('/lore/world.md', { workspaceId: 'global' });
  assert.ok(record !== null);
  assert.strictEqual(record.path, '/lore/world.md');
  assert.strictEqual(record.workspaceId, 'global');
  assert.strictEqual(record.content, '# World Codex\nMagic requires energy.');
  assert.strictEqual(record.size, receipt.size);
  assert.strictEqual(record.owner, 'director');
  assert.strictEqual(record.readOnly, false);

  // Non-existent record returns null without throwing
  assert.strictEqual(vfs.getFileRecord('/nonexistent.txt', { workspaceId: 'global' }), null);

  // Read file result envelope
  const readRes = vfs.readFile('/lore/world.md', { workspaceId: 'global' });
  assert.strictEqual(readRes.content, '# World Codex\nMagic requires energy.');
  assert.strictEqual(readRes.totalBytes, receipt.size);
  assert.strictEqual(readRes.totalLines, 2);
  assert.strictEqual(readRes.totalWords, 6);
  assert.strictEqual(readRes.truncated, false);
  assert.strictEqual(readRes.deliveryNote, 'File delivered in full.');
  // String and JSON coercion transparency
  assert.strictEqual(String(readRes), '# World Codex\nMagic requires energy.');

  // Raw read bypass
  const rawContent = vfs.readFile('/lore/world.md', { workspaceId: 'global', raw: true });
  assert.strictEqual(typeof rawContent, 'string');
  assert.strictEqual(rawContent, '# World Codex\nMagic requires energy.');

  // Throws FileNotFoundError for missing file
  assert.throws(
    () => vfs.readFile('/lore/missing.txt', { workspaceId: 'global' }),
    (err) => err instanceof FileNotFoundError && err.code === 'FILE_NOT_FOUND' && err.filePath === '/lore/missing.txt'
  );
});

// ============================================================================
// 4. Output Budgeting, Offset Slicing & Line Pagination
// ============================================================================

test('4. Output Budgeting, Offset Slicing & Line Pagination', () => {
  const vfs = new VirtualFS();
  const multiLineDoc = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: Content description item`).join('\n');
  vfs.writeFile('/docs/log.txt', multiLineDoc, { workspaceId: 'global' });

  // 1. Line range slicing (1-indexed inclusive)
  const lineSlice = vfs.readFile('/docs/log.txt', {
    workspaceId: 'global',
    startLine: 10,
    endLine: 15
  });

  assert.strictEqual(lineSlice.truncated, true);
  assert.strictEqual(lineSlice.linesIncluded, 6);
  assert.strictEqual(lineSlice.nextLine, 16);
  assert.ok(lineSlice.content.includes('10: Line 10:'));
  assert.ok(lineSlice.content.includes('15: Line 15:'));
  assert.ok(!lineSlice.content.includes('16: Line 16:'));
  assert.ok(lineSlice.deliveryNote.includes('Showing lines 10-15 of 50'));

  // Line slicing with raw: true
  const rawLineSlice = vfs.readFile('/docs/log.txt', {
    workspaceId: 'global',
    startLine: 1,
    endLine: 3,
    raw: true
  });
  assert.strictEqual(rawLineSlice, 'Line 1: Content description item\nLine 2: Content description item\nLine 3: Content description item');

  // 2. Byte offset slicing
  const offsetSlice = vfs.readFile('/docs/log.txt', {
    workspaceId: 'global',
    offset: 0,
    limit: 60
  });
  assert.strictEqual(offsetSlice.truncated, true);
  assert.strictEqual(offsetSlice.bytesIncluded, 60);
  assert.strictEqual(offsetSlice.nextOffset, 60);
  assert.ok(offsetSlice.deliveryNote.includes('Output sliced at offset 0 (60 bytes)'));

  // 3. Structured JSON Budget Truncation
  const bigJson = {
    title: 'Character Catalog',
    items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Hero_${i}`, stats: { hp: 100 + i, mp: 50 } }))
  };
  vfs.writeJson('/data/heroes.json', bigJson, { workspaceId: 'global' });

  const budgetedJson = vfs.readFile('/data/heroes.json', {
    workspaceId: 'global',
    budgetBytes: 500,
    structured: true
  });
  assert.strictEqual(budgetedJson.truncated, true);
  assert.ok(budgetedJson.bytesIncluded <= 500);
  assert.ok(budgetedJson.deliveryNote.includes('JSON output truncated'));
  // Ensure truncated content is valid JSON syntax
  assert.doesNotThrow(() => JSON.parse(budgetedJson.content));
});

// ============================================================================
// 5. Surgical Text Replacement (replaceFileContent)
// ============================================================================

test('5. Surgical Text Replacement (replaceFileContent)', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/drafts/ch1.txt', 'Chapter 1: The Old Quest\nThe hero met the dragon. The dragon roared.', {
    workspaceId: 'agent_author',
    callerAgentId: 'agent_author'
  });

  // Single replacement
  const rep1 = vfs.replaceFileContent(
    '/drafts/ch1.txt',
    'The Old Quest',
    'The Ancient Quest',
    { workspaceId: 'agent_author', callerAgentId: 'agent_author' }
  );
  assert.strictEqual(rep1.success, true);
  assert.strictEqual(rep1.replacementsMade, 1);
  assert.strictEqual(rep1.path, '/drafts/ch1.txt');
  assert.ok(rep1.sizeAfter > 0);

  // Replace all occurrences
  const rep2 = vfs.replaceFileContent(
    '/drafts/ch1.txt',
    'dragon',
    'wyrm',
    { workspaceId: 'agent_author', callerAgentId: 'agent_author', replaceAll: true }
  );
  assert.strictEqual(rep2.success, true);
  assert.strictEqual(rep2.replacementsMade, 2);

  const finalContent = vfs.readFile('/drafts/ch1.txt', { workspaceId: 'agent_author', callerAgentId: 'agent_author', raw: true });
  assert.strictEqual(finalContent, 'Chapter 1: The Ancient Quest\nThe hero met the wyrm. The wyrm roared.');

  // SEARCH_NOT_FOUND error
  assert.throws(
    () => vfs.replaceFileContent('/drafts/ch1.txt', 'NonExistentString', 'Replacement', {
      workspaceId: 'agent_author',
      callerAgentId: 'agent_author'
    }),
    (err) => err.code === 'SEARCH_NOT_FOUND'
  );
});

// ============================================================================
// 6. JSON Writing, Tokenized Keypath & jq Querying (writeJson, queryJson)
// ============================================================================

test('6. Structured JSON Writing & jq / Keypath Querying', () => {
  const vfs = new VirtualFS();
  const dataset = {
    campaign: 'Phoenix',
    settings: {
      difficulty: 'hard',
      maxPlayers: 4
    },
    characters: [
      { id: 1, name: 'Aria', role: 'protagonist', level: 10, skills: ['fire', 'heal'] },
      { id: 2, name: 'Vael', role: 'antagonist', level: 15, skills: ['shadow', 'teleport'] },
      { id: 3, name: 'Lyra', role: 'companion', level: 8, skills: ['archery'] }
    ]
  };

  const writeReceipt = vfs.writeJson('/data/campaign.json', dataset, { workspaceId: 'global' });
  assert.strictEqual(writeReceipt.success, true);
  assert.strictEqual(writeReceipt.path, '/data/campaign.json');

  // 1. Direct Keypath
  const diff = vfs.queryJson('/data/campaign.json', 'settings.difficulty', { workspaceId: 'global', raw: true });
  assert.strictEqual(diff, 'hard');

  const firstHero = vfs.queryJson('/data/campaign.json', 'characters[0].name', { workspaceId: 'global', raw: true });
  assert.strictEqual(firstHero, 'Aria');

  // 2. JSONPath
  const names = vfs.queryJson('/data/campaign.json', '$.characters[*].name', { workspaceId: 'global', raw: true });
  assert.deepStrictEqual(names, ['Aria', 'Vael', 'Lyra']);

  // 3. jq Pipeline filter
  const protagonists = vfs.queryJson('/data/campaign.json', '.characters[] | select(.role == "protagonist")', {
    workspaceId: 'global',
    raw: true
  });
  assert.strictEqual(protagonists.name, 'Aria');
  assert.strictEqual(protagonists.level, 10);
});

// ============================================================================
// 7. Atomic RFC 6902 JSON Patching (patchJson)
// ============================================================================

test('7. Atomic RFC 6902 JSON Patching (patchJson)', () => {
  const vfs = new VirtualFS();
  const initialDoc = {
    profile: {
      name: 'Eldrin',
      status: 'active'
    },
    inventory: ['staff', 'potion']
  };

  vfs.writeJson('/state/eldrin.json', initialDoc, { workspaceId: 'global' });

  // Apply sequential patch operations
  const patchReceipt = vfs.patchJson('/state/eldrin.json', [
    { op: 'replace', path: '/profile/status', value: 'resting' },
    { op: 'add', path: '/inventory/-', value: 'spellbook' },
    { op: 'add', path: '/stats/mana', value: 100 } // Auto-upsert intermediate object container
  ], { workspaceId: 'global' });

  assert.strictEqual(patchReceipt.success, true);
  assert.strictEqual(patchReceipt.operationsApplied, 3);
  assert.ok(patchReceipt.sizeBefore > 0);
  assert.ok(patchReceipt.sizeAfter > 0);

  const patchedDoc = vfs.queryJson('/state/eldrin.json', '.', { workspaceId: 'global', raw: true });
  assert.strictEqual(patchedDoc.profile.status, 'resting');
  assert.deepStrictEqual(patchedDoc.inventory, ['staff', 'potion', 'spellbook']);
  assert.strictEqual(patchedDoc.stats.mana, 100);

  // Transactional rollback on failed test operation
  const docBeforeRollback = JSON.stringify(patchedDoc);
  assert.throws(() => {
    vfs.patchJson('/state/eldrin.json', [
      { op: 'replace', path: '/profile/status', value: 'fighting' },
      { op: 'test', path: '/profile/name', value: 'WrongName' } // Will fail test
    ], { workspaceId: 'global' });
  });

  const docAfterRollback = vfs.readFile('/state/eldrin.json', { workspaceId: 'global', raw: true });
  assert.strictEqual(JSON.stringify(JSON.parse(docAfterRollback)), JSON.stringify(JSON.parse(docBeforeRollback)));
});

// ============================================================================
// 8. Directory Listings & Workspace Management
// ============================================================================

test('8. Directory Listings & Workspace Management', () => {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  vfs.writeFile('/lore/canon.json', '{}', { workspaceId: 'global' });
  vfs.writeFile('/lore/world.md', '# Lore', { workspaceId: 'global' });
  vfs.writeFile('/lore/factions/solaris.json', '{}', { workspaceId: 'global' });
  vfs.writeFile('/lore/factions/lunari.json', '{}', { workspaceId: 'global' });
  vfs.writeFile('/config.json', '{}', { workspaceId: 'global' });

  // Non-recursive listing under /lore (aggregates files and virtual subdirectory with childCount)
  const items = vfs.listFiles('/lore', { workspaceId: 'global', recursive: false });
  assert.strictEqual(items.length, 3);

  const factionsDir = items.find(i => i.name === 'factions');
  assert.ok(factionsDir);
  assert.strictEqual(factionsDir.type, 'directory');
  assert.strictEqual(factionsDir.childCount, 2);

  const canonFile = items.find(i => i.name === 'canon.json');
  assert.ok(canonFile);
  assert.strictEqual(canonFile.type, 'file');

  // Recursive listing under /lore
  const allLore = vfs.listFiles('/lore', { workspaceId: 'global', recursive: true });
  assert.strictEqual(allLore.length, 4);
  assert.ok(allLore.every(i => i.type === 'file'));

  // listFilesWithContent
  const withContent = vfs.listFilesWithContent('/lore', { workspaceId: 'global' });
  assert.strictEqual(withContent.length, 4);
  assert.ok(withContent.some(f => f.path === '/lore/world.md' && f.content === '# Lore'));

  // Workspace lifecycle
  assert.strictEqual(vfs.hasWorkspace('agent_alpha'), false);
  vfs.initWorkspace('agent_alpha');
  assert.strictEqual(vfs.hasWorkspace('agent_alpha'), true);
  assert.ok(vfs.listWorkspaces().includes('agent_alpha'));

  assert.strictEqual(vfs.deleteWorkspace('agent_alpha', { principal: INTERNAL_PRINCIPAL }), true);
  assert.strictEqual(vfs.hasWorkspace('agent_alpha'), false);

  // Protected global workspace cannot be deleted
  assert.strictEqual(vfs.deleteWorkspace('global', { principal: INTERNAL_PRINCIPAL }), false);

  // MOD-21 W8-D: tenant administration default-denies anonymous callers
  assert.throws(() => vfs.deleteWorkspace('global'), (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED');
});

// ============================================================================
// 9. File Copying, Deletion & Overwrite Guards
// ============================================================================

test('9. File Copying, Deletion & Overwrite Guards', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/templates/profile.json', '{"template": true}', { workspaceId: 'global' });

  // Intra-workspace copy
  const copyRes = vfs.copyFile('/templates/profile.json', '/templates/backup.json', {
    workspaceId: 'global'
  });
  assert.strictEqual(copyRes.success, true);
  assert.strictEqual(copyRes.destPath, '/templates/backup.json');
  assert.strictEqual(vfs.exists('/templates/backup.json', { workspaceId: 'global' }), true);

  // Cross-workspace copy
  const crossRes = vfs.copyFile('/templates/profile.json', '/agent_1/profile.json', {
    srcWorkspaceId: 'global',
    destWorkspaceId: 'agent_1',
    callerAgentId: 'agent_1'
  });
  assert.strictEqual(crossRes.success, true);
  assert.strictEqual(crossRes.destWorkspaceId, 'agent_1');
  assert.strictEqual(vfs.exists('/agent_1/profile.json', { workspaceId: 'agent_1', callerAgentId: 'agent_1' }), true);

  // Overwrite guard (overwrite: false throwing FileExistsError)
  assert.throws(
    () => vfs.copyFile('/templates/profile.json', '/templates/backup.json', {
      workspaceId: 'global',
      overwrite: false
    }),
    (err) => err instanceof FileExistsError && err.code === 'FILE_EXISTS'
  );

  // Single file delete
  assert.strictEqual(vfs.deleteFile('/templates/backup.json', { workspaceId: 'global' }), true);
  assert.strictEqual(vfs.exists('/templates/backup.json', { workspaceId: 'global' }), false);
  assert.strictEqual(vfs.deleteFile('/nonexistent.txt', { workspaceId: 'global' }), false);

  // Recursive directory delete
  vfs.writeFile('/temp/a.txt', 'A', { workspaceId: 'global' });
  vfs.writeFile('/temp/sub/b.txt', 'B', { workspaceId: 'global' });
  assert.strictEqual(vfs.deleteFile('/temp', { workspaceId: 'global', recursive: true }), true);
  assert.strictEqual(vfs.exists('/temp/a.txt', { workspaceId: 'global' }), false);
  assert.strictEqual(vfs.exists('/temp/sub/b.txt', { workspaceId: 'global' }), false);
});

// ============================================================================
// 10. Multi-Tenant Security, Permissions & Access Control
// ============================================================================

test('10. Multi-Tenant Security, Permissions & Access Control', () => {
  const vfs = new VirtualFS(operatorPortOptions());

  // Create file in private workspace agent_alice
  vfs.writeFile('/secret_notes.txt', 'Alice secrets', {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });

  // Unauthorized agent_bob attempting to read Alice's workspace -> PermissionDeniedError
  assert.throws(
    () => vfs.readFile('/secret_notes.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Unauthorized agent_bob attempting to write to Alice's workspace -> PermissionDeniedError
  assert.throws(
    () => vfs.writeFile('/hack.txt', 'payload', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Privileged-principal bypass (MOD-21 W4: resolved through the injected identity port)
  const adminRead = vfs.readFile('/secret_notes.txt', {
    workspaceId: 'agent_alice',
    callerAgentId: 'operator',
    raw: true
  });
  assert.strictEqual(adminRead, 'Alice secrets');

  // Read-only file protection in global workspace
  vfs.writeFile('/rules.txt', 'Immutable rules', {
    workspaceId: 'global',
    callerAgentId: 'director',
    owner: 'director',
    readOnly: true
  });

  // Unauthorized non-owner writer trying to overwrite read-only file
  assert.throws(
    () => vfs.writeFile('/rules.txt', 'Hacked rules', { workspaceId: 'global', callerAgentId: 'agent_writer' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Permissions update via setPermissions
  const permReceipt = vfs.setPermissions('/rules.txt', { readOnly: false }, {
    workspaceId: 'global',
    callerAgentId: 'director'
  });
  assert.strictEqual(permReceipt.success, true);
  assert.strictEqual(permReceipt.readOnly, false);

  // Now writable
  assert.doesNotThrow(() => {
    vfs.writeFile('/rules.txt', 'Updated rules', { workspaceId: 'global', callerAgentId: 'agent_writer' });
  });
});

// ============================================================================
// 11. Scoped Agent Proxy (forAgent)
// ============================================================================

test('11. Scoped Agent Proxy (forAgent)', () => {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  const writerProxy = vfs.forAgent('writer_1', { role: 'writer', principal: INTERNAL_PRINCIPAL });

  assert.strictEqual(writerProxy.agentId, 'writer_1');
  assert.strictEqual(writerProxy.role, 'writer');
  assert.strictEqual(writerProxy.isAdmin, false);
  assert.strictEqual(writerProxy.raw, vfs);

  // MOD-21 W8-D: minting a proxy without a trusted principal default-denies
  assert.throws(() => vfs.forAgent('writer_1', { role: 'writer' }), (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED');

  // Automated routing to writer_1 private workspace
  const writeRes = writerProxy.writeFile('/chapter1.md', '# Chapter 1: Sunrise');
  assert.strictEqual(writeRes.success, true);
  assert.strictEqual(writeRes.workspaceId, 'writer_1');

  const readRes = writerProxy.readFile('/chapter1.md', { raw: true });
  assert.strictEqual(readRes, '# Chapter 1: Sunrise');

  // Write to global workspace
  const globalRes = writerProxy.writeGlobal('/announcement.txt', 'Draft 1 completed.');
  assert.strictEqual(globalRes.workspaceId, 'global');

  const globalRead = writerProxy.readGlobal('/announcement.txt', { raw: true });
  assert.strictEqual(globalRead, 'Draft 1 completed.');

  // JSON operations on proxy
  writerProxy.writeJson('/meta.json', { progress: 50 });
  const metaVal = writerProxy.queryJson('/meta.json', '.progress', { raw: true });
  assert.strictEqual(metaVal, 50);

  writerProxy.patchJson('/meta.json', [{ op: 'replace', path: '/progress', value: 100 }]);
  const patchedVal = writerProxy.queryJson('/meta.json', '.progress', { raw: true });
  assert.strictEqual(patchedVal, 100);

  // File replacement on proxy
  writerProxy.replaceFileContent('/chapter1.md', 'Sunrise', 'Dawn');
  assert.strictEqual(writerProxy.readFile('/chapter1.md', { raw: true }), '# Chapter 1: Dawn');

  // Delete & exists
  assert.strictEqual(writerProxy.exists('/chapter1.md'), true);
  assert.strictEqual(writerProxy.deleteFile('/chapter1.md'), true);
  assert.strictEqual(writerProxy.exists('/chapter1.md'), false);
});

// ============================================================================
// 12. Workspace Grep Search (grep)
// ============================================================================

test('12. Workspace Grep Search (grep)', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/src/app.js', 'function start() {\n  // TODO: Add logging\n  console.log("running");\n}', { workspaceId: 'global' });
  vfs.writeFile('/src/util.js', 'export function helper() {\n  // todo: optimize\n  return 42;\n}', { workspaceId: 'global' });
  vfs.writeFile('/docs/todo.txt', 'TODO item 1\nTODO item 2', { workspaceId: 'global' });

  // Literal case-sensitive grep
  const matches1 = vfs.grep('TODO', '/src', { workspaceId: 'global' });
  assert.strictEqual(matches1.length, 1);
  assert.strictEqual(matches1[0].filePath, '/src/app.js');
  assert.strictEqual(matches1[0].lineNumber, 2);
  assert.ok(matches1[0].lineContent.includes('// TODO: Add logging'));

  // Case-insensitive grep
  const matches2 = vfs.grep('todo', '/src', { workspaceId: 'global', caseInsensitive: true });
  assert.strictEqual(matches2.length, 2);

  // Regex pattern grep
  const matches3 = vfs.grep('TODO item [0-9]', '/docs', { workspaceId: 'global', isRegex: true });
  assert.strictEqual(matches3.length, 2);
});

// ============================================================================
// 13. Prompt Template Rendering & File Expansion (renderTemplateWithFiles)
// ============================================================================

test('13. Prompt Template Rendering & File Expansion', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/lore/world.md', 'Magic requires energy.', { workspaceId: 'global' });
  vfs.writeFile('/lore/hero.json', '{"name": "Aria", "title": "Mage"}', { workspaceId: 'global' });

  // Template with file and variable inlining
  const template = 'WORLD SETTING:\n{{file:/lore/world.md}}\n\nHERO:\n{{files.hero}}\n\nQUEST: {{questName}}';
  const result = renderTemplateWithFiles(template, {
    virtualFs: vfs,
    files: { hero: '/lore/hero.json' },
    variables: { questName: 'The Sun Crystal' },
    workspaceId: 'global'
  });

  assert.strictEqual(result.success, true);
  assert.ok(result.renderedPrompt.includes('Magic requires energy.'));
  assert.ok(result.renderedPrompt.includes('"name": "Aria"'));
  assert.ok(result.renderedPrompt.includes('QUEST: The Sun Crystal'));
  assert.strictEqual(result.inlinedFiles.length, 2);
  assert.ok(result.totalBytes > 0);
  assert.ok(result.wordsCount > 0);
});

// ============================================================================
// 14. Snapshots & State Persistence (exportSnapshot, importSnapshot)
// ============================================================================

test('14. Full Snapshot Persistence & Restoration', () => {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  vfs.writeFile('/lore/canon.json', '{"era": 1}', { workspaceId: 'global' });
  vfs.writeFile('/private.txt', 'Agent notes', { workspaceId: 'agent_writer', callerAgentId: 'agent_writer' });

  // MOD-21 W8-D: snapshot export/import are tenant administration
  assert.throws(() => vfs.exportSnapshot(), (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED');
  assert.throws(() => new VirtualFS().importSnapshot({}), (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED');

  const snapshot = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.ok(snapshot.global['/lore/canon.json']);
  assert.ok(snapshot.agent_writer['/private.txt']);

  // Restore into fresh VFS instance
  const restoredVfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  restoredVfs.importSnapshot(snapshot, { principal: INTERNAL_PRINCIPAL });

  assert.strictEqual(restoredVfs.exists('/lore/canon.json', { workspaceId: 'global' }), true);
  assert.strictEqual(restoredVfs.readFile('/lore/canon.json', { workspaceId: 'global', raw: true }), '{"era": 1}');
  assert.strictEqual(restoredVfs.exists('/private.txt', { workspaceId: 'agent_writer', callerAgentId: 'agent_writer' }), true);
  assert.strictEqual(restoredVfs.readFile('/private.txt', { workspaceId: 'agent_writer', callerAgentId: 'agent_writer', raw: true }), 'Agent notes');
});

// ============================================================================
// 15. Privacy-Preserving Current Time Query
// ============================================================================

test('15. Privacy-Preserving Unix Epoch Time Query', () => {
  const vfs = new VirtualFS();
  const time = vfs.getCurrentTime();
  assert.ok(typeof time.unix_timestamp === 'number');
  assert.ok(typeof time.epoch_ms === 'number');
  assert.ok(time.unix_timestamp > 1700000000);
  assert.strictEqual(Math.floor(time.epoch_ms / 1000), time.unix_timestamp);
});

// ============================================================================
// 16. Download & Archiving Utilities (fsDownloadUtils)
// ============================================================================

test('16. Download, Batching, Filtering & Archiving Utilities', async () => {
  // MIME and filename sanitization
  assert.strictEqual(getMimeType('/lore/rules.md'), 'text/markdown;charset=utf-8');
  assert.strictEqual(getMimeType('/data/state.json'), 'application/json;charset=utf-8');
  assert.strictEqual(sanitizeDownloadFilename('lore/world/../map:v1?.json'), 'lore_world_.._map_v1_.json');

  // Capability detection
  const cap = detectArchiveCapability();
  assert.ok(['zip', 'compression_stream', 'none'].includes(cap.type));
  assert.ok(typeof isFolderUploadSupported() === 'boolean');

  // Single file download simulation
  const singleReceipt = downloadSingleFile({
    path: '/lore/world.md',
    content: '# World Rules',
    workspaceId: 'global'
  }, { prefixWorkspace: true });
  assert.strictEqual(singleReceipt.success, true);
  assert.strictEqual(singleReceipt.filename, 'global_lore_world.md');

  // Batch download
  const filesList = [
    { path: '/config.json', content: '{"v":1}', workspaceId: 'global' },
    { path: '/notes.txt', content: 'Notes', workspaceId: 'global' }
  ];
  const batchReceipt = await downloadFilesSeparately(filesList, { delayMs: 1 });
  assert.strictEqual(batchReceipt.success, true);
  assert.strictEqual(batchReceipt.count, 2);

  // Folder filtering
  const allFiles = [
    { path: '/lore/factions/solaris.json', content: '{}' },
    { path: '/lore/world.md', content: '# World' },
    { path: '/drafts/scene.txt', content: 'Scene' }
  ];
  const filtered = filterFilesByFolder(allFiles, '/lore');
  assert.strictEqual(filtered.length, 2);

  // Archive blob creation & download
  const archiveResult = await createArchiveBlob(filesList, { archiveName: 'story_backup' });
  assert.ok(archiveResult.blob);
  assert.ok(archiveResult.filename.includes('story_backup'));
  assert.ok(['zip', 'tar.gz'].includes(archiveResult.format));

  const folderArchiveReceipt = await downloadFolderAsArchive(filesList, { archiveName: 'export_all' });
  assert.strictEqual(folderArchiveReceipt.success, true);
  assert.strictEqual(folderArchiveReceipt.filesCount, 2);

  // Upload processing
  const mockUploads = [
    { name: 'app.json', webkitRelativePath: 'project/app.json', text: async () => '{"app": true}' }
  ];
  const uploadedRecords = await processUploadedFiles(mockUploads, { baseDir: '/imported' });
  assert.strictEqual(uploadedRecords.length, 1);
  assert.strictEqual(uploadedRecords[0].path, '/imported/project/app.json');
  assert.strictEqual(uploadedRecords[0].content, '{"app": true}');
});

// ============================================================================
// 17. Private Workspace Fail-Closed Access & Permissions Payload Owner
// ============================================================================

test('17. Private Workspaces Require an Explicit Caller; PermissionsPayload.owner Applies', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/secret.txt', 'Alice secrets', {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });

  // Anonymous (no caller id supplied at all) access to a private workspace is denied
  assert.throws(
    () => vfs.readFile('/secret.txt', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.writeFile('/anon.txt', 'payload', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.exists('/secret.txt', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.listFiles('/', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.deleteFile('/secret.txt', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.setPermissions('/secret.txt', { readOnly: false }, { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.replaceFileContent('/secret.txt', 'Alice', 'Bob', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.copyFile('/secret.txt', '/copy.txt', {
      srcWorkspaceId: 'agent_alice',
      destWorkspaceId: 'agent_alice'
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.getFileRecord('/secret.txt', { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  // Fail closed even when the private workspace/file does not exist yet
  assert.throws(
    () => vfs.readFile('/missing.txt', { workspaceId: 'agent_ghost' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Explicit owner id still succeeds, and global/public anonymous access is unchanged
  const ownerRead = vfs.readFile('/secret.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice', raw: true });
  assert.strictEqual(ownerRead, 'Alice secrets');
  assert.doesNotThrow(() => vfs.writeFile('/open.txt', 'shared', { workspaceId: 'global' }));
  assert.strictEqual(vfs.readFile('/open.txt', { workspaceId: 'global', raw: true }), 'shared');
  assert.doesNotThrow(() => vfs.writeFile('/open_public.txt', 'shared', { workspaceId: 'public' }));
  assert.strictEqual(vfs.readFile('/open_public.txt', { workspaceId: 'public', raw: true }), 'shared');

  // PermissionsPayload.owner is applied with the same authority rules as options.owner
  vfs.writeFile('/perm.txt', 'permission payload', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  const payloadReceipt = vfs.setPermissions({
    filePath: '/perm.txt',
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice',
    permissions: { owner: 'agent_successor', readOnly: true }
  });
  assert.strictEqual(payloadReceipt.success, true);
  assert.strictEqual(payloadReceipt.owner, 'agent_successor');
  assert.strictEqual(payloadReceipt.readOnly, true);
  const updatedRecord = vfs.getFileRecord('/perm.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  assert.strictEqual(updatedRecord.owner, 'agent_successor');

  // Non-owner callers cannot reassign owner through the payload
  vfs.writeFile('/director_file.txt', 'director-owned', {
    workspaceId: 'global',
    callerAgentId: 'director',
    owner: 'director'
  });
  assert.throws(
    () => vfs.setPermissions('/director_file.txt', { owner: 'agent_writer' }, {
      workspaceId: 'global',
      callerAgentId: 'agent_writer'
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
});

// ============================================================================
// 18. Code-Unit Offset Semantics & maxWords Output Budget
// ============================================================================

test('18. Offset/Limit are UTF-16 Code Units; maxWords Bounds Delivered Words', () => {
  const vfs = new VirtualFS();

  // Non-ASCII content proves offset/limit are UTF-16 code units, not bytes
  const unicodeContent = 'αβγδε 😀 tail';
  vfs.writeFile('/unicode.txt', unicodeContent, { workspaceId: 'global' });
  const unicodeSlice = vfs.readFile('/unicode.txt', { workspaceId: 'global', offset: 1, limit: 3 });
  assert.strictEqual(unicodeSlice.content, unicodeContent.slice(1, 4));
  assert.strictEqual(unicodeSlice.offset, 1);
  assert.strictEqual(unicodeSlice.limit, 3);
  assert.strictEqual(unicodeSlice.bytesIncluded, Buffer.byteLength(unicodeSlice.content, 'utf8'));
  assert.notStrictEqual(unicodeSlice.bytesIncluded, unicodeSlice.content.length);

  // maxWords bounds the delivered word count and reports continuation metadata
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  vfs.writeFile('/words.txt', words, { workspaceId: 'global' });
  const capped = vfs.readFile('/words.txt', { workspaceId: 'global', maxWords: 25 });
  assert.strictEqual(capped.truncated, true);
  assert.ok(capped.wordsIncluded <= 25 && capped.wordsIncluded >= 1);
  assert.ok(typeof capped.nextOffset === 'number');
  const resumed = vfs.readFile('/words.txt', { workspaceId: 'global', offset: capped.nextOffset });
  assert.strictEqual(capped.content + resumed.content, words);

  // maxWords is honored for raw reads and offset slices
  assert.strictEqual(vfs.readFile('/words.txt', { workspaceId: 'global', maxWords: 3, raw: true }), 'word0 word1 word2');
  const offsetCapped = vfs.readFile('/words.txt', { workspaceId: 'global', offset: 0, limit: 100000, maxWords: 4 });
  assert.strictEqual(offsetCapped.wordsIncluded, 4);
  assert.strictEqual(offsetCapped.truncated, true);
  assert.strictEqual(offsetCapped.nextOffset, 'word0 word1 word2 word3'.length);

  // QueryJsonOptions.structured is honored: element-aware truncation keeps output valid JSON
  vfs.writeJson('/big_query.json', {
    items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item_${i}` }))
  }, { workspaceId: 'global' });
  const structuredQuery = vfs.queryJson('/big_query.json', '.', {
    workspaceId: 'global',
    budgetBytes: 500,
    structured: true
  });
  assert.strictEqual(structuredQuery.truncated, true);
  assert.ok(structuredQuery.totalBytes > 500);
  assert.doesNotThrow(() => JSON.parse(structuredQuery.content));
});

// ============================================================================
// 19. Long Single-Line Continuation & Intra-Line maxWords Windowing
// ============================================================================

test('19. Long single-line continuation advances across pulls and terminates', () => {
  const vfs = new VirtualFS();
  const totalWords = 500;
  const longLine = Array.from({ length: totalWords }, (_, i) => `w${i}`).join(' ');
  vfs.writeFile('/single_line.txt', longLine, { workspaceId: 'global' });

  const maxWords = 40;
  let page = vfs.readFile('/single_line.txt', { workspaceId: 'global', startLine: 1, maxWords });

  // Pre-fix this was the trap: the same line/chunk was returned forever because
  // nextLine stayed 1 and no intra-line nextOffset existed.
  assert.strictEqual(page.truncated, true);
  assert.strictEqual(page.nextLine, 1);
  assert.strictEqual(typeof page.nextOffset, 'number');
  assert.ok(page.nextOffset > 0);

  const chunks = [page.content];
  let lastOffset = page.nextOffset;
  let pulls = 1;
  while (page.truncated) {
    pulls++;
    assert.ok(pulls < 100, `pagination must terminate (stuck after ${pulls} pulls)`);
    page = vfs.readFile('/single_line.txt', {
      workspaceId: 'global',
      startLine: page.nextLine,
      offset: page.nextOffset,
      maxWords
    });
    assert.ok(
      page.nextOffset === undefined || page.nextOffset > lastOffset,
      `continuation offset must strictly advance (${lastOffset} -> ${page.nextOffset})`
    );
    chunks.push(page.content);
    if (page.nextOffset !== undefined) lastOffset = page.nextOffset;
  }

  assert.strictEqual(page.truncated, false);
  assert.strictEqual(page.nextOffset, undefined);
  assert.ok(pulls > 5, 'a 500-word single line must require multiple pulls at 40 words/pull');

  const deliveredWords = chunks.join(' ').replace(/\d+:\s+/g, '').split(/\s+/).filter(Boolean);
  assert.deepStrictEqual(
    deliveredWords,
    Array.from({ length: totalWords }, (_, i) => `w${i}`),
    'concatenated pulls must cover the entire long line exactly once'
  );
});

test('19b. maxWords on a long line reaches subsequent content and terminates', () => {
  const vfs = new VirtualFS();
  const longLine = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
  vfs.writeFile('/long_then_tail.txt', `${longLine}\nTAIL_MARKER tail words here`, { workspaceId: 'global' });

  let page = vfs.readFile('/long_then_tail.txt', { workspaceId: 'global', startLine: 1, maxWords: 25 });
  const chunks = [page.content];
  let pulls = 1;
  while (page.truncated) {
    pulls++;
    assert.ok(pulls < 50, `pagination must terminate (stuck after ${pulls} pulls)`);
    page = vfs.readFile('/long_then_tail.txt', {
      workspaceId: 'global',
      startLine: page.nextLine,
      offset: page.nextOffset,
      maxWords: 25
    });
    chunks.push(page.content);
  }

  const merged = chunks.join('\n');
  assert.ok(merged.includes('TAIL_MARKER'), 'continuation must eventually reach content after the long line');
  assert.ok(merged.includes('tail words here'));
  assert.strictEqual(page.truncated, false);
  assert.strictEqual(page.nextOffset, undefined);
});

// ============================================================================
// 20. Owner Reassignment Default-Deny & Legitimate Owner Reassignment
// ============================================================================

test('20. Owner reassignment default-deny without a resolvable caller', () => {
  const vfs = new VirtualFS(operatorPortOptions());
  vfs.writeFile('/owned.txt', 'director content', {
    workspaceId: 'global',
    callerAgentId: 'director',
    owner: 'director'
  });

  // Anonymous owner reassignment denied in global (options form) — pre-fix this succeeded.
  assert.throws(
    () => vfs.setPermissions('/owned.txt', { owner: 'attacker' }, { workspaceId: 'global' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Anonymous owner reassignment denied via PermissionsPayload.owner — pre-fix this succeeded.
  assert.throws(
    () => vfs.setPermissions({
      filePath: '/owned.txt',
      workspaceId: 'global',
      permissions: { owner: 'attacker' }
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Anonymous explicit-owner assignment through writeFile/copyFile is denied (same class).
  assert.throws(
    () => vfs.writeFile('/anon_claim.txt', 'claim', { workspaceId: 'global', owner: 'attacker' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => vfs.copyFile('/owned.txt', '/anon_copy.txt', {
      srcWorkspaceId: 'global',
      destWorkspaceId: 'global',
      owner: 'attacker'
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Ownership is unchanged after the denied attempts.
  assert.strictEqual(vfs.getFileRecord('/owned.txt', { workspaceId: 'global' }).owner, 'director');
  assert.strictEqual(vfs.exists('/anon_claim.txt', { workspaceId: 'global' }), false);
  assert.strictEqual(vfs.exists('/anon_copy.txt', { workspaceId: 'global' }), false);

  // Resolvable non-owner still cannot reassign ownership.
  assert.throws(
    () => vfs.setPermissions('/owned.txt', { owner: 'agent_writer' }, {
      workspaceId: 'global',
      callerAgentId: 'agent_writer'
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Legitimate current-owner reassignment works in global.
  const receipt = vfs.setPermissions('/owned.txt', { owner: 'agent_successor' }, {
    workspaceId: 'global',
    callerAgentId: 'director'
  });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.owner, 'agent_successor');
  assert.strictEqual(vfs.getFileRecord('/owned.txt', { workspaceId: 'global' }).owner, 'agent_successor');

  // Privileged-principal reassignment still works (resolved through the identity port).
  const adminReceipt = vfs.setPermissions('/owned.txt', { owner: 'admin' }, {
    workspaceId: 'global',
    callerAgentId: 'operator'
  });
  assert.strictEqual(adminReceipt.owner, 'admin');

  // Private workspace: anonymous reassignment is denied by the workspace ACL.
  vfs.writeFile('/private.txt', 'alice notes', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  assert.throws(
    () => vfs.setPermissions('/private.txt', { owner: 'attacker' }, { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Private workspace: the owner can still reassign ownership.
  const privateReceipt = vfs.setPermissions('/private.txt', { owner: 'agent_heir' }, {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });
  assert.strictEqual(privateReceipt.success, true);
  assert.strictEqual(privateReceipt.owner, 'agent_heir');
  assert.strictEqual(
    vfs.getFileRecord('/private.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' }).owner,
    'agent_heir'
  );
});

// ============================================================================
// 21. setPermissions Authorization: Default-Deny, Side-Effect-Free, Pollution-Proof
// ============================================================================

test('21. Anonymous permission mutations are denied, denied mutations leave no state behind', () => {
  const vfs = new VirtualFS(operatorPortOptions());
  vfs.writeFile('/locked.txt', 'locked content', {
    workspaceId: 'global',
    callerAgentId: 'director',
    owner: 'director',
    readOnly: true
  });

  // (a) Anonymous readOnly flip is denied in global — pre-fix this succeeded and
  // unprotected the file for every later writer.
  assert.throws(
    () => vfs.setPermissions('/locked.txt', { readOnly: false }, { workspaceId: 'global' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // (a2) Anonymous mode mutation is denied in global (positional form).
  assert.throws(
    () => vfs.setPermissions('/locked.txt', '0644', { workspaceId: 'global' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // (a3) Anonymous mutation is denied through the object payload form too.
  assert.throws(
    () => vfs.setPermissions({ filePath: '/locked.txt', workspaceId: 'global', permissions: { readOnly: false } }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  // Denied attempts left the record untouched.
  const afterAnon = vfs.getFileRecord('/locked.txt', { workspaceId: 'global' });
  assert.strictEqual(afterAnon.readOnly, true);
  assert.strictEqual(afterAnon.owner, 'director');

  // (a4) Anonymous mutation is denied in a private workspace as well.
  vfs.writeFile('/private.txt', 'alice notes', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice', readOnly: true });
  assert.throws(
    () => vfs.setPermissions('/private.txt', { readOnly: false }, { workspaceId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );
  assert.strictEqual(
    vfs.getFileRecord('/private.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' }).readOnly,
    true
  );

  // (b) A denied owner reassignment must not leak readOnly/mode changes.
  //     The workspace owner is authorized to reach the owner guard, which then denies
  //     reassignment to a non-owner: pre-fix `readOnly: false`/`mode: '0666'` stuck.
  vfs.writeFile('/staged.txt', 'staged', {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice',
    owner: 'agent_alice',
    readOnly: true,
    mode: '0444'
  });
  const reassignSuccess = vfs.setPermissions('/staged.txt', { owner: 'agent_bob' }, {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });
  assert.strictEqual(reassignSuccess.owner, 'agent_bob');

  assert.throws(
    () => vfs.setPermissions('/staged.txt', { readOnly: false, mode: '0666', owner: 'attacker' }, {
      workspaceId: 'agent_alice',
      callerAgentId: 'agent_alice'
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
  );

  const afterDenied = vfs.setPermissions('/staged.txt', {}, {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });
  assert.strictEqual(afterDenied.readOnly, true, 'denied reassignment must not flip readOnly');
  assert.strictEqual(afterDenied.mode, '0444', 'denied reassignment must not change mode');
  assert.strictEqual(afterDenied.owner, 'agent_bob', 'denied reassignment must not change owner');

  // (c) Prototype-polluted caller/owner fields cannot authorize or leak.
  Object.prototype.callerAgentId = 'director';
  Object.prototype.owner = 'attacker';
  try {
    assert.throws(
      () => vfs.setPermissions('/locked.txt', { readOnly: false }, { workspaceId: 'global' }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
    );
    assert.throws(
      () => vfs.setPermissions('/locked.txt', { owner: 'attacker' }, { workspaceId: 'global' }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED'
    );
    // A legitimate owner mutation still works and never adopts the polluted owner.
    const pollutedReceipt = vfs.setPermissions('/locked.txt', { readOnly: false }, {
      workspaceId: 'global',
      callerAgentId: 'director'
    });
    assert.strictEqual(pollutedReceipt.readOnly, false);
    assert.strictEqual(pollutedReceipt.owner, 'director');
  } finally {
    delete Object.prototype.callerAgentId;
    delete Object.prototype.owner;
  }

  const afterPollution = vfs.getFileRecord('/locked.txt', { workspaceId: 'global' });
  assert.strictEqual(afterPollution.owner, 'director');
  assert.strictEqual(afterPollution.readOnly, false);

  // (d) Legitimate owner/privileged-principal mutations still work.
  const adminReceipt = vfs.setPermissions('/locked.txt', { owner: 'admin', readOnly: true }, {
    workspaceId: 'global',
    callerAgentId: 'operator'
  });
  assert.strictEqual(adminReceipt.success, true);
  assert.strictEqual(adminReceipt.owner, 'admin');
  assert.strictEqual(adminReceipt.readOnly, true);
});

// ============================================================================
// 22. Caller-Identity Propagation in Object Forms (writeJson, copyFile)
// ============================================================================

test('22. Object-form writeJson/copyFile use the trusted caller identity', () => {
  const vfs = new VirtualFS();

  // writeJson object form with a trusted context: pre-fix the raw local caller was
  // undefined and overwrote the trusted identity, denying a private write.
  const privateWrite = vfs.writeJson(
    { filePath: '/private_notes.json', data: { note: 'private' }, workspaceId: 'agent_author' },
    { callerAgentId: 'agent_author' }
  );
  assert.strictEqual(privateWrite.success, true);
  assert.strictEqual(privateWrite.workspaceId, 'agent_author');
  assert.strictEqual(privateWrite.owner, 'agent_author');

  // Global object-form write: pre-fix the author was dropped and the file was owned by 'system'.
  const globalWrite = vfs.writeJson(
    { filePath: '/author_owned.json', data: { note: 'global' }, workspaceId: 'global' },
    { callerAgentId: 'agent_author' }
  );
  assert.strictEqual(globalWrite.owner, 'agent_author');
  assert.strictEqual(
    vfs.getFileRecord('/author_owned.json', { workspaceId: 'global' }).owner,
    'agent_author'
  );

  // copyFile object form with context: an authenticated owner=self assignment must be
  // authorized — pre-fix the guard read the raw local caller and denied as anonymous.
  // The source lives in the shared workspace, so it is addressed through the /global
  // mount; the destination stays in the caller's private workspace (ticket a50f109).
  vfs.writeFile('/global/source_identity.txt', 'identity payload', {
    workspaceId: 'global',
    callerAgentId: 'agent_author'
  });
  const copyReceipt = vfs.copyFile(
    { srcPath: '/global/source_identity.txt', destPath: '/copied_identity.txt', owner: 'agent_author' },
    { callerAgentId: 'agent_author' }
  );
  assert.strictEqual(copyReceipt.success, true);
  assert.strictEqual(copyReceipt.owner, 'agent_author');
  assert.strictEqual(
    vfs.getFileRecord('/copied_identity.txt', { workspaceId: 'agent_author', callerAgentId: 'agent_author' }).owner,
    'agent_author'
  );

  // Anonymous copy in global still defaults ownership to the source owner (unchanged).
  const anonCopy = vfs.copyFile('/global/source_identity.txt', '/anon_copied.txt');
  assert.strictEqual(anonCopy.success, true);
  assert.strictEqual(anonCopy.owner, 'agent_author');
});

// ============================================================================
// 23. Continuation Edge Cases: Word Budgets, Zero Limits, Line-End Offsets
// ============================================================================

test('23. maxWords=1 delivers content, zero-limit tokens advance, offset==lineEnd resumes', () => {
  const vfs = new VirtualFS();

  // (1) maxWords=1 with the `N: ` prefix must deliver one content word — pre-fix the
  // budget was spent on the prefix and the first content word was silently skipped.
  vfs.writeFile('/one_word.txt', 'alpha beta gamma', { workspaceId: 'global' });
  let page = vfs.readFile('/one_word.txt', { workspaceId: 'global', startLine: 1, maxWords: 1 });
  assert.strictEqual(page.wordsIncluded, 1);
  assert.strictEqual(page.content.replace(/^\d+: /, ''), 'alpha');
  assert.strictEqual(page.nextOffset, 'alpha'.length);
  assert.strictEqual(page.truncated, true);

  const pulledWords = [];
  let lastOffset = -1;
  let pulls = 0;
  while (true) {
    pulls++;
    assert.ok(pulls < 20, `maxWords=1 pagination must terminate (stuck after ${pulls} pulls)`);
    pulledWords.push(...page.content.replace(/^\d+: /gm, '').split(/\s+/).filter(Boolean));
    if (!page.truncated) break;
    assert.ok(
      page.nextOffset === undefined || page.nextOffset > lastOffset,
      `continuation offset must strictly advance (${lastOffset} -> ${page.nextOffset})`
    );
    if (page.nextOffset !== undefined) lastOffset = page.nextOffset;
    page = vfs.readFile('/one_word.txt', {
      workspaceId: 'global',
      startLine: page.nextLine,
      offset: page.nextOffset,
      maxWords: 1
    });
  }
  assert.deepStrictEqual(pulledWords, ['alpha', 'beta', 'gamma']);

  // (2) limit:0 must emit a strictly advancing nextOffset — pre-fix it re-emitted 0 forever.
  vfs.writeFile('/zero_limit.txt', 'Zero limit test string.', { workspaceId: 'global' });
  let zeroPage = vfs.readFile('/zero_limit.txt', { workspaceId: 'global', offset: 0, limit: 0 });
  assert.strictEqual(zeroPage.content, '');
  assert.ok(zeroPage.nextOffset > 0, `zero-limit nextOffset (${zeroPage.nextOffset}) must strictly advance`);
  let zeroPulls = 0;
  while (zeroPage.truncated) {
    zeroPulls++;
    assert.ok(zeroPulls < 20, 'zero-limit pagination must terminate');
    const nextPage = vfs.readFile('/zero_limit.txt', {
      workspaceId: 'global',
      offset: zeroPage.nextOffset,
      limit: 0
    });
    assert.strictEqual(nextPage.content, '');
    assert.ok(
      nextPage.nextOffset === undefined || nextPage.nextOffset > zeroPage.nextOffset,
      `zero-limit continuation offset must strictly advance (${zeroPage.nextOffset} -> ${nextPage.nextOffset})`
    );
    zeroPage = nextPage;
  }
  assert.strictEqual(zeroPage.truncated, false);
  assert.strictEqual(zeroPage.nextOffset, undefined);

  // (2b) maxWords:0 without an explicit offset also advances.
  const zeroWordsPage = vfs.readFile('/zero_limit.txt', { workspaceId: 'global', maxWords: 0 });
  assert.strictEqual(zeroWordsPage.content, '');
  assert.ok(zeroWordsPage.nextOffset > 0, `maxWords=0 nextOffset (${zeroWordsPage.nextOffset}) must strictly advance`);

  // (3) raw:true + startLine + maxWords returns a bare truncated string with no token
  // (the strictly-advancing token contract is scoped to structured reads).
  const rawSlice = vfs.readFile('/one_word.txt', { workspaceId: 'global', startLine: 1, maxWords: 1, raw: true });
  assert.strictEqual(rawSlice, 'alpha');

  // (4) offset == lineEnd resumes at the next line instead of restarting the line.
  vfs.writeFile('/lines.txt', 'aaaa bbbb\ncccc dddd\neeee', { workspaceId: 'global' });
  const lineEnd = 'aaaa bbbb'.length;
  const resumed = vfs.readFile('/lines.txt', { workspaceId: 'global', startLine: 1, offset: lineEnd });
  assert.ok(!resumed.content.includes('aaaa'), 'offset == lineEnd must not re-deliver the completed line');
  assert.strictEqual(resumed.content, '2: cccc dddd\n3: eeee');
  assert.strictEqual(resumed.truncated, false);
  assert.strictEqual(resumed.nextLine, undefined);
});

test('23b. Line-boundary maxWords cuts resume at the first undelivered line (44cd998)', () => {
  const vfs = new VirtualFS();
  const content = 'a b c\nd e\nf g\nh i j k\nl m\nn o p';
  const sourceLines = content.split('\n');
  vfs.writeFile('/boundary_words.txt', content, { workspaceId: 'global' });

  // (1) The word budget ends exactly at the end of line 1; the continuation token must
  // name line 2 (the first line not fully delivered), not line 3.
  const first = vfs.readFile('/boundary_words.txt', { workspaceId: 'global', startLine: 1, maxWords: 3 });
  assert.strictEqual(first.truncated, true);
  assert.strictEqual(first.nextOffset, undefined);
  assert.strictEqual(first.nextLine, 2);

  // (2) Whole-chain reconstruction across budgets that force boundary and mid-line cuts:
  // every source line must be delivered exactly once, in order, byte-exactly.
  for (const maxWords of [1, 2, 3, 4, 5, 6]) {
    const pages = [];
    let page = vfs.readFile('/boundary_words.txt', { workspaceId: 'global', startLine: 1, maxWords });
    while (true) {
      pages.push(page);
      assert.ok(pages.length <= 50, `maxWords=${maxWords} pagination must terminate`);
      if (!page.truncated) break;
      const params = { workspaceId: 'global', startLine: page.nextLine, maxWords };
      if (page.nextOffset !== undefined) params.offset = page.nextOffset;
      page = vfs.readFile('/boundary_words.txt', params);
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

    assert.deepStrictEqual(
      logicalLines,
      sourceLines,
      `maxWords=${maxWords} must deliver every source line exactly once, in order`
    );
    assert.strictEqual(
      logicalLines.join('\n'),
      content,
      `maxWords=${maxWords} continuation chain must reconstruct the file byte-exactly`
    );
  }
});

// ============================================================================
// 23c. Zero/Negative Word Budgets: startLine Continuation Must Advance (44cd998 regression)
// ============================================================================

test('23c. Zero/negative word budgets strictly advance and terminate on startLine (44cd998 regression)', () => {
  const vfs = new VirtualFS();

  // Pulls zero-budget pages, resuming with the emitted token and failing fast when a token
  // repeats: pre-fix the zero-budget cut could land exactly on a line boundary and re-emit
  // `{ truncated: true, nextLine: <current line> }` with no offset, restarting that line forever.
  const drainZeroBudget = (filePath, options = {}) => {
    const pages = [];
    const tokens = new Set();
    let page = vfs.readFile(filePath, { workspaceId: 'global', startLine: 1, maxWords: 0, ...options });
    while (true) {
      pages.push(page);
      assert.ok(pages.length <= 20, `zero-budget pagination must terminate (${pages.length} pulls)`);
      if (!page.truncated) break;
      const token = `${page.nextLine}:${page.nextOffset === undefined ? 'none' : page.nextOffset}`;
      assert.ok(!tokens.has(token), `zero-budget continuation token must strictly advance (repeated ${token})`);
      tokens.add(token);
      const params = { workspaceId: 'global', startLine: page.nextLine, maxWords: 0 };
      if (page.nextOffset !== undefined) params.offset = page.nextOffset;
      page = vfs.readFile(filePath, params);
    }
    return pages;
  };

  // (1) A one-word first line: the forced zero-budget advance ends exactly on the line
  // boundary. Pre-fix the token was `{ nextLine: 1 }` with no offset, so the documented
  // resume re-read the byte-identical page forever; the parent terminated `nextLine: 2`.
  vfs.writeFile('/zero_single_word.txt', 'one\ntwo', { workspaceId: 'global' });
  const singleWord = drainZeroBudget('/zero_single_word.txt');
  assert.strictEqual(singleWord[0].content, '');
  assert.strictEqual(singleWord[0].truncated, true);
  assert.strictEqual(singleWord[0].nextOffset, undefined);
  assert.strictEqual(singleWord[0].nextLine, 2, 'zero budget must resume at the first undelivered line');
  assert.strictEqual(singleWord.length, 2);
  assert.strictEqual(singleWord[1].truncated, false);

  // (2) Alternating-token form: pre-fix `(nextLine 1, nextOffset 3)` alternated forever
  // with `(nextLine 1, no offset)`.
  vfs.writeFile('/zero_alt.txt', 'one two\nthree four\nfive six', { workspaceId: 'global' });
  const alternating = drainZeroBudget('/zero_alt.txt');
  assert.strictEqual(alternating[alternating.length - 1].truncated, false);

  // (3) Empty file: a zero-budget read of a zero-word file is safe (single, final page).
  vfs.writeFile('/zero_empty.txt', '', { workspaceId: 'global' });
  const emptyFile = drainZeroBudget('/zero_empty.txt');
  assert.strictEqual(emptyFile.length, 1);
  assert.strictEqual(emptyFile[0].truncated, false);

  // (4) Empty first line and empty mid-file line: zero budget steps over them safely.
  vfs.writeFile('/zero_blank_first.txt', '\nsecond', { workspaceId: 'global' });
  const blankFirst = drainZeroBudget('/zero_blank_first.txt');
  assert.strictEqual(blankFirst.length, 2);
  assert.strictEqual(blankFirst[0].nextLine, 2);
  assert.strictEqual(blankFirst[1].truncated, false);

  vfs.writeFile('/zero_blank_mid.txt', 'one\n\ntwo', { workspaceId: 'global' });
  const blankMid = drainZeroBudget('/zero_blank_mid.txt');
  assert.strictEqual(blankMid[blankMid.length - 1].truncated, false);

  // (5) Negative budgets clamp to zero and advance identically; `budgetWords` aliases `maxWords`.
  const negative = drainZeroBudget('/zero_single_word.txt', { maxWords: -5 });
  assert.strictEqual(negative[0].nextLine, 2);
  assert.strictEqual(negative[negative.length - 1].truncated, false);

  const aliasFirst = vfs.readFile('/zero_single_word.txt', {
    workspaceId: 'global',
    startLine: 1,
    budgetWords: 0
  });
  assert.strictEqual(aliasFirst.truncated, true);
  assert.strictEqual(aliasFirst.nextOffset, undefined);
  assert.strictEqual(aliasFirst.nextLine, 2);

  // (6) Verified positive-budget boundaries stay unchanged: a positive line-boundary cut
  // still names the first undelivered line with no intra-line offset (44cd998 fix).
  vfs.writeFile('/zero_positive_guard.txt', 'a b c\nd e\nf g', { workspaceId: 'global' });
  const positiveFirst = vfs.readFile('/zero_positive_guard.txt', { workspaceId: 'global', startLine: 1, maxWords: 3 });
  assert.strictEqual(positiveFirst.truncated, true);
  assert.strictEqual(positiveFirst.nextOffset, undefined);
  assert.strictEqual(positiveFirst.nextLine, 2);
  assert.strictEqual(positiveFirst.content, '1: a b c');
});

test('24. [MOD-21 W8-D c6e24c0] Tenant administration default-denies anonymous callers', () => {
  const internalPrincipal = INTERNAL_PRINCIPAL;
  const vfs = new VirtualFS({ internalPrincipal });
  vfs.writeFile('/secret.txt', 'alice-secret', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });

  const denied = (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED';

  // Administer members are denied for anonymous callers and plain lookalikes.
  assert.throws(() => vfs.forAgent('agent_alice'), denied);
  assert.throws(() => vfs.forAgent('agent_alice', { principal: { kind: 'internal' } }), denied);
  assert.throws(() => vfs.deleteWorkspace('agent_alice'), denied);
  assert.throws(() => vfs.reset(), denied);
  assert.throws(() => vfs.exportSnapshot(), denied);
  assert.throws(() => vfs.importSnapshot({}), denied);

  // Denied attempts leave tenant state intact.
  assert.strictEqual(vfs.hasWorkspace('agent_alice'), true);
  assert.strictEqual(vfs.readFile('/secret.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice', raw: true }), 'alice-secret');

  // The exact injected principal reference authorizes every administer member.
  const snapshot = vfs.exportSnapshot({ principal: internalPrincipal });
  assert.ok(JSON.stringify(snapshot).includes('alice-secret'));
  const proxy = vfs.forAgent('agent_alice', { principal: internalPrincipal });
  assert.strictEqual(proxy.readFile('/secret.txt', { raw: true }), 'alice-secret');
  const restored = new VirtualFS({ internalPrincipal });
  restored.importSnapshot(snapshot, { principal: internalPrincipal });
  assert.strictEqual(restored.hasWorkspace('agent_alice'), true);
  assert.strictEqual(restored.deleteWorkspace('agent_alice', { principal: internalPrincipal }), true);
  assert.strictEqual(restored.hasWorkspace('agent_alice'), false);
  restored.reset({ principal: internalPrincipal });
  assert.deepStrictEqual(restored.listWorkspaces(), []);

  // An identity-port operator descriptor authorizes without the reference.
  const operatorVfs = new VirtualFS(operatorPortOptions());
  operatorVfs.writeFile('/op.txt', 'op-content', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  assert.strictEqual(operatorVfs.forAgent('agent_alice', { callerAgentId: 'operator' }).readFile('/op.txt', { raw: true }), 'op-content');
  assert.strictEqual(operatorVfs.deleteWorkspace('agent_alice', { callerAgentId: 'operator' }), true);
});

test('25. [MOD-21 W8-D c6e24c0] Injected instance binds the engine principal once (first bind wins)', () => {
  const internalPrincipal = INTERNAL_PRINCIPAL;
  const lookalike = { kind: 'internal', subject: 'test_tenant_admin' };
  const denied = (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED';

  // An injected (unbound) instance denies the engine path until the
  // composition root binds its exact principal reference.
  const injected = new VirtualFS();
  injected.writeFile('/secret.txt', 'alice-secret', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  assert.throws(() => injected.deleteWorkspace('agent_alice', { principal: internalPrincipal }), denied);
  assert.strictEqual(injected.hasWorkspace('agent_alice'), true);

  assert.strictEqual(injected.bindInternalPrincipal(internalPrincipal), true, 'the first valid object binds');
  assert.strictEqual(injected.bindInternalPrincipal(lookalike), false, 'a second bind is refused (no replacement)');
  assert.throws(() => injected.deleteWorkspace('agent_alice', { principal: lookalike }), denied, 'a lookalike never authorizes');
  assert.strictEqual(injected.deleteWorkspace('agent_alice', { principal: internalPrincipal }), true, 'the bound reference remains the sole direct authority');

  // Constructor-bound instances are never rebound.
  const constructorBound = new VirtualFS({ internalPrincipal });
  assert.strictEqual(constructorBound.bindInternalPrincipal(lookalike), false);
  assert.throws(() => constructorBound.reset({ principal: lookalike }), denied);

  // Invalid candidates do not consume the one-time binding.
  const late = new VirtualFS();
  assert.strictEqual(late.bindInternalPrincipal(null), false);
  assert.strictEqual(late.bindInternalPrincipal('not-an-object'), false);
  assert.strictEqual(late.bindInternalPrincipal(internalPrincipal), true);

  // The bound engine path authorizes every administer member.
  const engine = new VirtualFS();
  engine.writeFile('/engine.txt', 'engine-content', { workspaceId: 'agent_bob', callerAgentId: 'agent_bob' });
  assert.strictEqual(engine.bindInternalPrincipal(internalPrincipal), true);
  assert.ok(JSON.stringify(engine.exportSnapshot({ principal: internalPrincipal })).includes('engine-content'));
  assert.strictEqual(engine.forAgent('agent_bob', { principal: internalPrincipal }).readFile('/engine.txt', { raw: true }), 'engine-content');
  assert.strictEqual(engine.deleteWorkspace('agent_bob', { principal: internalPrincipal }), true);
  assert.strictEqual(engine.hasWorkspace('agent_bob'), false);
});

// ============================================================================
// 26. ACL class derives from the effective workspace (cb9909f)
// ============================================================================

test('26. [cb9909f] A /global/ path prefix never downgrades a foreign private-workspace ACL class', () => {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  // Private workspaces may legitimately carry `/global/`-prefixed keys (legacy
  // snapshot shape; Realm-global mounts), so the ACL class must come from the
  // effective workspace, never from the requested path.
  vfs.importSnapshot({
    victim_ws: { '/global/secret.txt': { content: 'victim-secret' } }
  }, { principal: INTERNAL_PRINCIPAL });

  const denied = (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED';

  assert.throws(
    () => vfs.grep('victim-secret', { pathPrefix: '/global/secret.txt', workspaceId: 'victim_ws', callerAgentId: 'attacker' }),
    denied,
    'a foreign caller must be denied despite the /global/ path prefix'
  );
  assert.throws(
    () => vfs.grep('victim-secret', { pathPrefix: '/global/secret.txt', workspaceId: 'victim_ws' }),
    denied,
    'an anonymous caller must be denied despite the /global/ path prefix'
  );

  // The workspace owner keeps access to its own `/global/`-prefixed entries by
  // scanning the workspace directly; through the workspace view the `/global`
  // prefix is the shared mount and never resolves to a private record.
  const own = vfs.grep('victim-secret', { workspaceId: 'victim_ws', callerAgentId: 'victim_ws' });
  assert.strictEqual(own.length, 1, 'the workspace owner keeps access to its own /global/-prefixed entries');
  assert.strictEqual(own[0].lineContent, 'victim-secret');
  assert.strictEqual(own[0].filePath, '/global/secret.txt');
  const ownViaMount = vfs.grep('victim-secret', { pathPrefix: '/global/secret.txt', workspaceId: 'victim_ws', callerAgentId: 'victim_ws' });
  assert.strictEqual(ownViaMount.length, 0, 'the /global mount resolves to the shared workspace, never the private record');

  // The shared `/global/` prefix alias keeps working for the public workspace.
  vfs.writeFile('/global/shared.txt', 'shared-public', { workspaceId: 'global', callerAgentId: 'director' });
  assert.strictEqual(vfs.readFile('/global/shared.txt', { raw: true }), 'shared-public');
  assert.strictEqual(vfs.grep('shared-public', { pathPrefix: '/shared.txt', workspaceId: 'global' }).length, 1);

  // `listWorkspaces`/eviction administration is unchanged by the fix.
  assert.strictEqual(vfs.deleteWorkspace('victim_ws', { principal: INTERNAL_PRINCIPAL }), true);
});

// ============================================================================
// 27. [f44da3e] Reserved workspace keys are undeletable through lifecycle eviction
// ============================================================================

test('27. [f44da3e] deleteWorkspace refuses reserved global/public/realm-global keys', () => {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  const realmKey = 'realm:alpha:global';

  vfs.writeFile('/g.txt', 'global-data', { workspaceId: 'global' });
  vfs.writeFile('/p.txt', 'public-data', { workspaceId: 'public', callerAgentId: 'public' });
  vfs.writeFile('/r.txt', 'realm-data', { workspaceId: realmKey, callerAgentId: realmKey });

  assert.strictEqual(
    vfs.deleteWorkspace('global', { principal: INTERNAL_PRINCIPAL }),
    false,
    'the exact global key stays protected'
  );
  assert.strictEqual(
    vfs.deleteWorkspace('public', { principal: INTERNAL_PRINCIPAL }),
    false,
    'the public alias is protected like global'
  );
  assert.strictEqual(
    vfs.deleteWorkspace(realmKey, { principal: INTERNAL_PRINCIPAL }),
    false,
    'every realm:<id>:global key is protected'
  );
  assert.strictEqual(
    vfs.deleteWorkspace('realm:other:global', { principal: INTERNAL_PRINCIPAL }),
    false,
    'the realm-global namespace guard is not limited to seeded keys'
  );

  assert.strictEqual(vfs.readFile('/g.txt', { workspaceId: 'global', raw: true }), 'global-data');
  assert.strictEqual(vfs.readFile('/p.txt', { workspaceId: 'public', raw: true }), 'public-data');
  assert.strictEqual(
    vfs.readFile('/r.txt', { workspaceId: realmKey, callerAgentId: realmKey, raw: true }),
    'realm-data'
  );
  assert.ok(vfs.hasWorkspace(realmKey), 'the reserved workspace stays live after the refused eviction');

  // Near-miss keys are ordinary private workspaces, never over-protected.
  vfs.initWorkspace('Global');
  assert.strictEqual(vfs.deleteWorkspace('Global', { principal: INTERNAL_PRINCIPAL }), true, "capitalized 'Global' is a distinct private key");
  vfs.initWorkspace('realmish');
  assert.strictEqual(vfs.deleteWorkspace('realmish', { principal: INTERNAL_PRINCIPAL }), true, 'a realm-prefixed non-global key is not reserved');
  vfs.initWorkspace('temp_ws');
  assert.strictEqual(vfs.deleteWorkspace('temp_ws', { principal: INTERNAL_PRINCIPAL }), true, 'ordinary private workspaces stay deletable');
});

// ============================================================================
// 28. [e6f10db] The reserved-key predicate is exported as the canonical vocabulary
// ============================================================================

test('28. [e6f10db] isReservedWorkspaceKey owns the reserved workspace-key vocabulary', () => {
  assert.strictEqual(
    typeof isReservedWorkspaceKey,
    'function',
    'the predicate must be exported from the module surface'
  );

  for (const key of ['global', 'public', 'realm:alpha:global', 'realm:other:global', 'realm:alpha:beta:global']) {
    assert.strictEqual(isReservedWorkspaceKey(key), true, `'${key}' must be reserved`);
  }

  // Near-miss shapes are ordinary private keys and must never be over-matched.
  for (const key of [
    'Global',
    'PUBLIC',
    'globalx',
    'publicx',
    'realm:alpha:globalx',
    'realm:alpha:glob',
    'realm:a:glob',
    'realmish',
    ''
  ]) {
    assert.strictEqual(isReservedWorkspaceKey(key), false, `'${key}' must be a near-miss, not reserved`);
  }

  // The predicate is the same vocabulary the delete guard applies: every
  // reserved key is undeletable, every near-miss key is deletable.
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  vfs.initWorkspace('realm:beta:global');
  vfs.initWorkspace('realm:alpha:globalx');
  assert.strictEqual(
    vfs.deleteWorkspace('realm:beta:global', { principal: INTERNAL_PRINCIPAL }),
    false,
    'the predicate and the delete guard agree on reserved keys'
  );
  assert.strictEqual(
    vfs.deleteWorkspace('realm:alpha:globalx', { principal: INTERNAL_PRINCIPAL }),
    true,
    'the predicate and the delete guard agree on near-miss keys'
  );
});

// ============================================================================
// 29. [49cfc41] Realm alias projection and `public` retirement (module surface)
// ============================================================================

test('29. [49cfc41] the public alias folds into global handling and realm projections stay additive', () => {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });

  // `public` is no longer a distinct namespace: it resolves to `global`.
  const folded = vfs.writeFile('/public-fold.txt', 'folded', { workspaceId: 'public' });
  assert.strictEqual(folded.workspaceId, 'global', 'an ungrouped `public` write folds into the global workspace');
  assert.strictEqual(vfs.readFile('/public-fold.txt', { workspaceId: 'global', raw: true }), 'folded');
  assert.strictEqual(vfs.readFile('/public-fold.txt', { workspaceId: 'public', raw: true }), 'folded');
  assert.strictEqual(vfs.hasWorkspace('public'), false, 'no literal public workspace is materialized by the alias');

  // The reserved-key guard keeps `public` protected (per-Realm deletion is an
  // operator Realm operation, not a module-local concern).
  assert.strictEqual(isReservedWorkspaceKey('public'), true);
  assert.strictEqual(vfs.deleteWorkspace('public', { principal: INTERNAL_PRINCIPAL }), false);

  // Legacy parity: a projection without the optional realm fields is ungrouped.
  const ungrouped = new VirtualFS({
    identityPort: { getAgentIdentity: (id) => ({ id, privileged: false, allowedTools: [] }) },
    internalPrincipal: INTERNAL_PRINCIPAL
  });
  ungrouped.writeFile('/shared.txt', 'shared', { workspaceId: 'global', callerAgentId: 'legacy' });
  assert.strictEqual(ungrouped.readFile('/shared.txt', { workspaceId: 'global', callerAgentId: 'legacy', raw: true }), 'shared');
  assert.ok(ungrouped.listWorkspaces({ callerAgentId: 'legacy' }).includes('global'));

  // Additive realm projection: an injected `realmId` resolves the global alias
  // to `realm:<realmId>:global` without renaming any stored key.
  const realmVfs = new VirtualFS({
    identityPort: {
      getAgentIdentity: (id) => (id === 'realm_agent' ? { id, privileged: false, allowedTools: [], realmId: 'alpha' } : null)
    },
    internalPrincipal: INTERNAL_PRINCIPAL
  });
  realmVfs.writeFile('/scoped.txt', 'scoped', { workspaceId: 'global', callerAgentId: 'realm_agent' });
  assert.strictEqual(realmVfs.hasWorkspace('realm:alpha:global'), true, 'the realm-global workspace is created');
  assert.strictEqual(realmVfs.hasWorkspace('global'), false, 'the legacy global workspace is not renamed or shadowed');

  // A supplied-but-unresolvable caller context fails closed instead of falling
  // back to the unscoped legacy span (V11 F2, ticket 49cfc41).
  assert.deepStrictEqual(realmVfs.listWorkspaces({ callerAgentId: 'ghost' }), [], 'an unresolvable caller enumerates nothing');
  assert.strictEqual(
    realmVfs.hasWorkspace('realm:alpha:global', { callerAgentId: 'ghost' }),
    false,
    'an unresolvable caller gets no cross-workspace existence oracle'
  );
  assert.strictEqual(
    realmVfs.readFile('/scoped.txt', { workspaceId: 'realm:alpha:global', callerAgentId: 'realm_agent', raw: true }),
    'scoped'
  );
  assert.throws(
    () => realmVfs.readFile('/scoped.txt', { workspaceId: 'global', callerAgentId: 'legacy' }),
    (err) => err instanceof FileNotFoundError && err.code === 'FILE_NOT_FOUND',
    'an ungrouped caller never inherits a realm-bound write through the literal global alias'
  );
});

// ============================================================================
// 30. Agent Workspace View: Trusted Context Workspace Binding (ticket a50f109)
// ============================================================================

test('30. [a50f109] writeFile honors the trusted context workspace binding', () => {
  const vfs = new VirtualFS();

  const receipt = vfs.writeFile(
    { filePath: '/ctx.md', content: 'ctx bytes' },
    { workspaceId: 'agent_ctx', callerAgentId: 'agent_ctx' }
  );
  assert.strictEqual(receipt.workspaceId, 'agent_ctx', 'the trusted context workspace is honored, not the global default');
  assert.strictEqual(vfs.hasWorkspace('global'), false, 'the write never falls back to the shared global workspace');
  assert.strictEqual(vfs.readFile('/ctx.md', { workspaceId: 'agent_ctx', callerAgentId: 'agent_ctx', raw: true }), 'ctx bytes');
  assert.strictEqual(vfs.readFile({ filePath: '/ctx.md' }, { callerAgentId: 'agent_ctx', raw: true }), 'ctx bytes', 'the private default reads the bound workspace');

  assert.throws(
    () => vfs.writeFile({ filePath: '/forged.md', content: 'x', workspaceId: 'other_ws' }, { callerAgentId: 'agent_ctx' }),
    (err) => err instanceof PermissionDeniedError,
    'an explicit foreign workspace target stays denied'
  );
  assert.strictEqual(vfs.hasWorkspace('other_ws'), false, 'a denied foreign write creates nothing');
});

// ============================================================================
// 31-38. Wave U File Plumbing (ticket 36f2763)
// ============================================================================

/** Identity port resolving ungrouped callers for the plumbing workspace ACL. */
function makePlumbingVfs() {
  return new VirtualFS({
    identityPort: { getAgentIdentity: (id) => ({ id, privileged: false, allowedTools: [] }) }
  });
}

test('31. writeFile source_file resolves under the caller view, appends, and rejects mixed inline/file args', () => {
  const vfs = makePlumbingVfs();
  const ctx = { workspaceId: 'agent_a', callerAgentId: 'agent_a' };
  vfs.writeFile('/parts/a.txt', 'AAA', ctx);
  vfs.writeFile('/parts/b.txt', 'BBB', ctx);

  const copied = vfs.writeFile({ filePath: '/dest.txt', sourceFile: '/parts/a.txt' }, ctx);
  assert.strictEqual(copied.success, true);
  assert.strictEqual(vfs.readFile('/dest.txt', { ...ctx, raw: true }), 'AAA');

  const appended = vfs.writeFile({ file_path: '/dest.txt', source_file: '/parts/b.txt', append: true }, ctx);
  assert.strictEqual(appended.success, true, 'snake_case source_file + append are honored');
  assert.strictEqual(vfs.readFile('/dest.txt', { ...ctx, raw: true }), 'AAABBB');

  vfs.writeFile({ filePath: '/dest.txt', content: '!', append: true }, ctx);
  assert.strictEqual(vfs.readFile('/dest.txt', { ...ctx, raw: true }), 'AAABBB!', 'append also applies to inline content');

  assert.throws(
    () => vfs.writeFile({ filePath: '/dest.txt', content: 'X', source_file: '/parts/a.txt' }, ctx),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...ctx, raw: true }), 'AAABBB!', 'a rejected mixed call leaves the destination byte-identical');
});

test('32. writeFile source refs are scoped to the caller and capped before any mutation', () => {
  const vfs = makePlumbingVfs();
  const alice = { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' };
  const bob = { workspaceId: 'agent_bob', callerAgentId: 'agent_bob' };
  vfs.writeFile('/secret.txt', 'bob payload', bob);
  vfs.writeFile('/dest.txt', 'ORIGINAL', alice);

  // A foreign private-workspace source is denied by the same read ACL read_file enforces.
  assert.throws(
    () => vfs.writeFile({ filePath: '/dest.txt', source_file: '/agents/agent_bob/secret.txt' }, { callerAgentId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError
  );
  assert.throws(
    () => vfs.readFile('/agents/agent_bob/secret.txt', { callerAgentId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError,
    'the same reference is denied through the corresponding read call'
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...alice, raw: true }), 'ORIGINAL', 'a denied source leaves the destination untouched');

  assert.throws(
    () => vfs.writeFile({ filePath: '/dest.txt', source_file: '/missing.txt' }, alice),
    (err) => err instanceof FileNotFoundError
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...alice, raw: true }), 'ORIGINAL');

  vfs.writeFile('/huge.txt', 'x'.repeat(FILE_PLUMBING_MAX_FILE_BYTES + 1), alice);
  assert.throws(
    () => vfs.writeFile({ filePath: '/dest.txt', source_file: '/huge.txt' }, alice),
    (err) => err instanceof FileTooLargeError
      && err.code === 'FILE_TOO_LARGE'
      && err.maxBytes === FILE_PLUMBING_MAX_FILE_BYTES
      && err.actualBytes > FILE_PLUMBING_MAX_FILE_BYTES
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...alice, raw: true }), 'ORIGINAL', 'an oversize source leaves the destination untouched');
});

test('33. replace_file_content accepts replacement_source_file and rejects mixed replacement args', () => {
  const vfs = makePlumbingVfs();
  const ctx = { workspaceId: 'agent_a', callerAgentId: 'agent_a' };
  vfs.writeFile('/doc.txt', 'Hello WORLD', ctx);
  vfs.writeFile('/replacement.bin', 'PLANET', ctx);

  const receipt = vfs.replaceFileContent(
    { filePath: '/doc.txt', targetContent: 'WORLD', replacementSourceFile: '/replacement.bin' },
    ctx
  );
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(vfs.readFile('/doc.txt', { ...ctx, raw: true }), 'Hello PLANET');

  assert.throws(
    () => vfs.replaceFileContent(
      { filePath: '/doc.txt', target_content: 'PLANET', replacement_content: 'X', replacement_source_file: '/replacement.bin' },
      ctx
    ),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
  assert.strictEqual(vfs.readFile('/doc.txt', { ...ctx, raw: true }), 'Hello PLANET', 'mutual exclusion leaves the target untouched');

  assert.throws(
    () => vfs.replaceFileContent(
      { filePath: '/doc.txt', target_content: 'PLANET', replacement_source_file: '/missing.bin' },
      ctx
    ),
    (err) => err instanceof FileNotFoundError
  );
  assert.strictEqual(vfs.readFile('/doc.txt', { ...ctx, raw: true }), 'Hello PLANET', 'a missing replacement source leaves the target untouched');
});

test('34. write_json accepts data_source_file and rejects mixed data args', () => {
  const vfs = makePlumbingVfs();
  const ctx = { workspaceId: 'agent_a', callerAgentId: 'agent_a' };
  vfs.writeJson('/payload.json', { ok: true, items: [1, 2] }, ctx);
  vfs.writeFile('/notes.txt', 'not json', ctx);
  vfs.writeJson('/dest.json', { stale: true }, ctx);

  const receipt = vfs.writeJson({ filePath: '/copy.json', dataSourceFile: '/payload.json' }, ctx);
  assert.strictEqual(receipt.success, true);
  assert.deepStrictEqual(JSON.parse(vfs.readFile('/copy.json', { ...ctx, raw: true })), { ok: true, items: [1, 2] });

  assert.throws(
    () => vfs.writeJson({ filePath: '/dest.json', data: { x: 1 }, data_source_file: '/payload.json' }, ctx),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
  assert.deepStrictEqual(JSON.parse(vfs.readFile('/dest.json', { ...ctx, raw: true })), { stale: true });

  assert.throws(
    () => vfs.writeJson({ filePath: '/dest.json', data_source_file: '/notes.txt' }, ctx),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
  assert.deepStrictEqual(JSON.parse(vfs.readFile('/dest.json', { ...ctx, raw: true })), { stale: true });
});

test('35. json_patch resolves per-op value_file atomically', () => {
  const vfs = makePlumbingVfs();
  const ctx = { workspaceId: 'agent_a', callerAgentId: 'agent_a' };
  vfs.writeJson('/state.json', { count: 1 }, ctx);
  vfs.writeJson('/value.json', { nested: true }, ctx);
  vfs.writeFile('/bad.json', 'not-json', ctx);

  const receipt = vfs.patchJson(
    { filePath: '/state.json', patch: [{ op: 'add', path: '/added', value_file: '/value.json' }] },
    ctx
  );
  assert.strictEqual(receipt.success, true);
  assert.deepStrictEqual(JSON.parse(vfs.readFile('/state.json', { ...ctx, raw: true })), { count: 1, added: { nested: true } });

  assert.throws(
    () => vfs.patchJson(
      { filePath: '/state.json', patch: [{ op: 'replace', path: '/count', value: 9, value_file: '/value.json' }] },
      ctx
    ),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
  assert.throws(
    () => vfs.patchJson(
      { filePath: '/state.json', patch: [{ op: 'replace', path: '/count', value_file: '/missing.json' }] },
      ctx
    ),
    (err) => err instanceof FileNotFoundError
  );
  assert.throws(
    () => vfs.patchJson(
      { filePath: '/state.json', patch: [{ op: 'replace', path: '/count', value_file: '/bad.json' }] },
      ctx
    ),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
  assert.deepStrictEqual(
    JSON.parse(vfs.readFile('/state.json', { ...ctx, raw: true })),
    { count: 1, added: { nested: true } },
    'failed patches leave the document byte-identical'
  );
});

test('36. query_json output_file extracts the full result under the caller write view', () => {
  const vfs = makePlumbingVfs();
  const ctx = { workspaceId: 'agent_a', callerAgentId: 'agent_a' };
  const items = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}` }));
  vfs.writeJson('/source.json', { items }, ctx);

  const inContext = vfs.queryJson({ filePath: '/source.json', query: '.items', budgetBytes: 200 }, ctx);
  assert.strictEqual(inContext.truncated, true, 'the in-context return envelope truncates without output_file');

  const receipt = vfs.queryJson({ file_path: '/source.json', query: '.items', output_file: '/extracted.json' }, ctx);
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.truncated, false);
  assert.strictEqual(receipt.output_file, '/extracted.json');
  assert.ok(receipt.bytes_written > 200);
  assert.deepStrictEqual(JSON.parse(vfs.readFile('/extracted.json', { ...ctx, raw: true })), items);

  const huge = 'z'.repeat(FILE_PLUMBING_MAX_FILE_BYTES + 32);
  vfs.writeFile('/huge.json', JSON.stringify({ blob: huge }), ctx);
  assert.throws(
    () => vfs.queryJson({ file_path: '/huge.json', query: '.blob', output_file: '/oversize.json' }, ctx),
    (err) => err instanceof FileTooLargeError
  );
  assert.throws(
    () => vfs.readFile('/oversize.json', { ...ctx }),
    (err) => err instanceof FileNotFoundError,
    'an oversize extraction creates no destination file'
  );
});

test('37. concatFiles joins sources with separator semantics and rejects malformed args', () => {
  const vfs = makePlumbingVfs();
  const ctx = { workspaceId: 'agent_a', callerAgentId: 'agent_a' };
  vfs.writeFile('/p/a.txt', 'AAA', ctx);
  vfs.writeFile('/p/b.txt', 'BBB', ctx);
  vfs.writeFile('/p/c.txt', 'CCC', ctx);

  const plain = vfs.concatFiles(['/p/a.txt', '/p/b.txt', '/p/c.txt'], '/joined.txt', ctx);
  assert.strictEqual(plain.success, true);
  assert.strictEqual(plain.source_count, 3);
  assert.strictEqual(plain.separator, '');
  assert.strictEqual(vfs.readFile('/joined.txt', { ...ctx, raw: true }), 'AAABBBCCC');

  const separated = vfs.concatFiles(
    { sources: ['/p/a.txt', '/p/b.txt', '/p/c.txt'], destination: '/joined.md', separator: '\n---\n' },
    ctx
  );
  assert.strictEqual(separated.success, true);
  assert.strictEqual(separated.separator, '\n---\n');
  assert.strictEqual(separated.lines_written, 5);
  assert.strictEqual(vfs.readFile('/joined.md', { ...ctx, raw: true }), 'AAA\n---\nBBB\n---\nCCC');

  assert.throws(() => vfs.concatFiles([], '/none.txt', ctx), (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS');
  assert.throws(() => vfs.concatFiles({ sources: ['/p/a.txt'] }, ctx), (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS');
  assert.throws(
    () => vfs.concatFiles({ sources: ['/p/a.txt'], destination: '/x.txt', separator: 7 }, ctx),
    (err) => err instanceof Error && err.code === 'INVALID_ARGUMENTS'
  );
});

test('38. concatFiles is source-scoped, atomic, and aggregate-capped', () => {
  const vfs = makePlumbingVfs();
  const alice = { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' };
  const bob = { workspaceId: 'agent_bob', callerAgentId: 'agent_bob' };
  vfs.writeFile('/p/a.txt', 'AAA', alice);
  vfs.writeFile('/dest.txt', 'ORIGINAL', alice);
  vfs.writeFile('/secret.txt', 'bob payload', bob);

  assert.throws(
    () => vfs.concatFiles(['/p/a.txt', '/agents/agent_bob/secret.txt'], '/dest.txt', { callerAgentId: 'agent_alice' }),
    (err) => err instanceof PermissionDeniedError
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...alice, raw: true }), 'ORIGINAL', 'a denied peer source leaves the destination untouched');

  assert.throws(
    () => vfs.concatFiles(['/p/a.txt', '/missing.txt'], '/dest.txt', alice),
    (err) => err instanceof FileNotFoundError
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...alice, raw: true }), 'ORIGINAL', 'a missing source aborts before the destination write');

  const chunk = 'y'.repeat(1_700_000);
  for (let i = 0; i < 5; i++) vfs.writeFile(`/big/p${i}.txt`, chunk, alice);
  assert.throws(
    () => vfs.concatFiles(['/big/p0.txt', '/big/p1.txt', '/big/p2.txt', '/big/p3.txt', '/big/p4.txt'], '/dest.txt', alice),
    (err) => err instanceof FileTooLargeError && err.maxBytes === FILE_PLUMBING_MAX_TOTAL_BYTES
  );
  assert.strictEqual(vfs.readFile('/dest.txt', { ...alice, raw: true }), 'ORIGINAL', 'an over-aggregate payload leaves the destination untouched');
});
