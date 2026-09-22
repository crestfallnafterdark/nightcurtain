/**
 * @file tests/unit/tool_system_module_test.js
 * @description Comprehensive unit and integration test suite for Module 8: tool_system.
 * Validates strict ICD compliance, immutable .ts contracts, Draft-07 schema generation,
 * preset resolution, O(1) table dispatch, parameter sanitization, universal error shielding,
 * and pure 1-line delegations across all 35 tool descriptors and 7 substrate domains.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Public Module 8 Facade Contract
import * as ToolSystemModule from '../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema,
  SANDBOX_TOOLS,
  INNATE_TOOLS,
  TOOL_PRESETS,
  resolveToolPreset,
  TOOL_SYSTEM_ERROR_CODES
} from '../../src/lib/sandbox/toolDefinitions/index.ts';

// Internal Normalizers & Descriptors (for unit-level invariant verification)
import {
  toSnakeCase,
  toCamelCase,
  createParamSanitizer
} from '../../src/lib/sandbox/tools/normalizers/index.ts';

import {
  TOOL_ALIAS_MAP,
  getCanonToolName,
  normalizeToolName,
  PRECALL_ALLOWLIST
} from '../../src/lib/sandbox/tools/normalizers/index.ts';

import {
  ALL_TOOL_DESCRIPTORS,
  TOOL_REGISTRY
} from '../../src/lib/sandbox/tools/descriptors/index.ts';

import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';

// ============================================================================
// 1. Strict Export Whitelist & Constant Immutability
// ============================================================================

test('1. Strict Export Whitelist & Constants Immutability', () => {
  const exportedKeys = Object.keys(ToolSystemModule).sort();
  assert.deepStrictEqual(
    exportedKeys,
    [
      'INNATE_TOOLS',
      'SANDBOX_TOOLS',
      'TOOL_PRESETS',
      'TOOL_SYSTEM_ERROR_CODES',
      'createSandboxToolDispatcher',
      'getSandboxToolsSchema',
      'resolveToolPreset'
    ].sort()
  );

  // Error codes verification
  assert.strictEqual(TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND, 'TOOL_NOT_FOUND');
  assert.strictEqual(TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED, 'PERMISSION_DENIED');
  assert.strictEqual(TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS, 'INVALID_ARGUMENTS');
  assert.strictEqual(TOOL_SYSTEM_ERROR_CODES.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
  assert.strictEqual(TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN, 'PRECALL_FORBIDDEN');
  assert.strictEqual(TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED, 'EXECUTION_FAILED');
  assert.ok(Object.isFrozen(TOOL_SYSTEM_ERROR_CODES));

  // Master tools enum
  assert.ok(Object.isFrozen(SANDBOX_TOOLS));
  assert.strictEqual(Object.keys(SANDBOX_TOOLS).length, 35);

  // Innate tools list
  assert.ok(Object.isFrozen(INNATE_TOOLS));
  assert.ok(Array.isArray(INNATE_TOOLS));
  assert.strictEqual(typeof INNATE_TOOLS.has, 'function');
  assert.strictEqual(INNATE_TOOLS.length, 4);
  assert.ok(INNATE_TOOLS.has('whoami'));
  assert.ok(INNATE_TOOLS.has('get_current_time'));
  assert.ok(INNATE_TOOLS.has('describe_tool'));
  assert.ok(INNATE_TOOLS.has('batch_precall'));
  assert.strictEqual(INNATE_TOOLS.has('read_file'), false);
  assert.strictEqual(INNATE_TOOLS.has('write_file'), false);

  // Tool presets
  assert.ok(Object.isFrozen(TOOL_PRESETS));
  assert.ok(Object.isFrozen(TOOL_PRESETS.all));
  assert.ok(Object.isFrozen(TOOL_PRESETS.manager));
  assert.ok(Object.isFrozen(TOOL_PRESETS.collaborator));
  assert.ok(Object.isFrozen(TOOL_PRESETS.readonly_collaborator));
  assert.ok(Object.isFrozen(TOOL_PRESETS.readonly));
});

// ============================================================================
// 2. Canonical Tool Taxonomy (All 35 Tools)
// ============================================================================

test('2. Canonical Tool Taxonomy Enumeration (35 Tools across 7 Domains)', () => {
  const expectedTools = [
    // VFS (12)
    'read_file', 'write_file', 'replace_file_content', 'copy_file', 'delete_file',
    'list_files', 'write_json', 'query_json', 'json_patch', 'grep', 'set_permissions',
    'concat_files',
    // Messaging (8)
    'send_message', 'wait_for_mail', 'list_inbox', 'read_message', 'get_archive',
    'inline_file_in_message', 'get_inbox', 'drain_inbox',
    // Lifecycle (5)
    'spawn_agent', 'kill_agent', 'list_agents', 'whoami', 'undo_turn',
    // Invocation (2)
    'invoke_agent', 'wait_for_invocation',
    // Scheduler (3)
    'schedule', 'list_schedules', 'cancel_schedule',
    // Clock & Events (3)
    'world_clock', 'event_list', 'get_current_time',
    // Precall & Reflection (2)
    'batch_precall', 'describe_tool'
  ];

  assert.strictEqual(expectedTools.length, 35);
  for (const name of expectedTools) {
    const found = Object.values(SANDBOX_TOOLS).includes(name);
    assert.ok(found, `Tool '${name}' must exist in SANDBOX_TOOLS enum`);
    assert.ok(TOOL_REGISTRY[name], `Tool '${name}' must be registered in frozen TOOL_REGISTRY`);
  }

  assert.strictEqual(ALL_TOOL_DESCRIPTORS.length, 35);
});

// ============================================================================
// 3. Preset Resolution Engine (resolveToolPreset)
// ============================================================================

test('3. Capability Preset Resolution Engine (resolveToolPreset)', () => {
  // Preset keyword resolution
  assert.deepStrictEqual(resolveToolPreset('all'), ['*']);
  assert.deepStrictEqual(resolveToolPreset('*'), ['*']);
  assert.deepStrictEqual(resolveToolPreset('manager'), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset('collaborator'), [...TOOL_PRESETS.collaborator]);
  assert.deepStrictEqual(resolveToolPreset('readonly_collaborator'), [...TOOL_PRESETS.readonly_collaborator]);
  assert.deepStrictEqual(resolveToolPreset('readonly'), [...TOOL_PRESETS.readonly]);

  // Case-insensitivity & whitespace trimming
  assert.deepStrictEqual(resolveToolPreset('  MANAGER  '), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset('Collaborator'), [...TOOL_PRESETS.collaborator]);

  // Array of presets or tool names
  assert.deepStrictEqual(resolveToolPreset(['manager']), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset(['read_file', 'write_file']), ['read_file', 'write_file']);

  // Comma-separated strings
  assert.deepStrictEqual(resolveToolPreset('read_file, write_file, whoami'), ['read_file', 'write_file', 'whoami']);

  // Set inputs
  assert.deepStrictEqual(
    resolveToolPreset(new Set(['read_file', 'send_message'])),
    ['read_file', 'send_message']
  );

  // Falsy / invalid inputs return empty array
  assert.deepStrictEqual(resolveToolPreset(null), []);
  assert.deepStrictEqual(resolveToolPreset(undefined), []);
  assert.deepStrictEqual(resolveToolPreset(''), []);
  assert.deepStrictEqual(resolveToolPreset('   '), []);
  assert.deepStrictEqual(resolveToolPreset([]), []);
  assert.deepStrictEqual(resolveToolPreset(12345), []);
  assert.deepStrictEqual(resolveToolPreset({}), []);
});

// ============================================================================
// 4. Schema Generation Engine (getSandboxToolsSchema)
// ============================================================================

test('4. Draft-07 JSON Schema Generation & Invariant 4 Zero Schema Pollution', () => {
  // 1. Full schema generation (all tools)
  const allSchemas = getSandboxToolsSchema('all');
  assert.strictEqual(allSchemas.length, 35);

  // 2. Preset-filtered schema generation
  const managerSchemas = getSandboxToolsSchema('manager');
  assert.strictEqual(managerSchemas.length, 28); // 24 listed in manager preset + 4 expanded subagent management tools

  const collabSchemas = getSandboxToolsSchema('collaborator');
  assert.strictEqual(collabSchemas.length, 24);

  const readonlyCollabSchemas = getSandboxToolsSchema('readonly_collaborator');
  assert.strictEqual(readonlyCollabSchemas.length, 13);

  const readonlySchemas = getSandboxToolsSchema('readonly');
  assert.strictEqual(readonlySchemas.length, 12);

  // 3. Option: includeReflection: false
  const noReflectionSchemas = getSandboxToolsSchema('all', { includeReflection: false });
  assert.strictEqual(noReflectionSchemas.length, 34);
  assert.ok(!noReflectionSchemas.some(s => s.function.name === 'describe_tool'));

  // 4. Structural validation of Draft-07 schemas
  for (const toolDef of allSchemas) {
    assert.strictEqual(toolDef.type, 'function');
    assert.ok(typeof toolDef.function.name === 'string' && toolDef.function.name.length > 0);
    assert.ok(typeof toolDef.function.description === 'string' && toolDef.function.description.length > 0);
    assert.ok(toolDef.function.parameters);
    assert.strictEqual(toolDef.function.parameters.type, 'object');
    assert.ok(typeof toolDef.function.parameters.properties === 'object');
    assert.ok(Array.isArray(toolDef.function.parameters.required));
    assert.strictEqual(toolDef.function.parameters.additionalProperties, false);

    // INVARIANT 4: Zero LLM Schema Pollution
    const propertyKeys = Object.keys(toolDef.function.parameters.properties);
    assert.ok(!propertyKeys.includes('model'), 'Schema must not expose model parameter');
    assert.ok(!propertyKeys.includes('temperature'), 'Schema must not expose temperature parameter');
    assert.ok(!propertyKeys.includes('maxTurns'), 'Schema must not expose maxTurns parameter');
    assert.ok(!propertyKeys.includes('depth'), 'Schema must not expose internal depth parameter');
    assert.ok(!propertyKeys.includes('privileged'), 'Schema must not expose privileged parameter');
    assert.ok(!propertyKeys.includes('allowedTools'), 'Schema must not expose allowedTools parameter');
    assert.ok(!propertyKeys.includes('toolPreset'), 'Schema must not expose toolPreset parameter');
  }
});

// ============================================================================
// 5. Parameter Normalization & Sanitization Factory
// ============================================================================

test('5. Parameter Sanitizer Factory & Case Normalizers', () => {
  // Case converters
  assert.strictEqual(toSnakeCase('filePath'), 'file_path');
  assert.strictEqual(toSnakeCase('TargetAgentId'), 'target_agent_id');
  assert.strictEqual(toSnakeCase('target-agent-id'), 'target_agent_id');
  assert.strictEqual(toCamelCase('file_path'), 'filePath');
  assert.strictEqual(toCamelCase('target-agent-id'), 'targetAgentId');

  // Parameter sanitizer with alias map and defaults
  const aliasMap = {
    filePath: 'file_path',
    path: 'file_path',
    dest: 'dest_path',
    destination: 'dest_path'
  };
  const sanitizer = createParamSanitizer(aliasMap, { limit: 100, offset: 0 });

  // 1. Direct object with aliases
  const res1 = sanitizer({ filePath: '/test.txt', dest: '/out.txt', extra: 'value' });
  assert.strictEqual(res1.file_path, '/test.txt');
  assert.strictEqual(res1.dest_path, '/out.txt');
  assert.strictEqual(res1.extra, 'value');
  assert.strictEqual(res1.limit, 100); // default applied
  assert.strictEqual(res1.offset, 0);  // default applied

  // 2. Stringified JSON payload
  const res2 = sanitizer('{"path": "/lore/rules.md", "limit": 50}');
  assert.strictEqual(res2.file_path, '/lore/rules.md');
  assert.strictEqual(res2.limit, 50);
  assert.strictEqual(res2.offset, 0);

  // 3. Malformed JSON string fallback to defaults
  const res3 = sanitizer('invalid json string');
  assert.strictEqual(res3.limit, 100);
  assert.strictEqual(res3.offset, 0);
  assert.strictEqual(res3.file_path, undefined);

  // 4. Prototype poisoning defense
  const res4 = sanitizer({
    __proto__: { polluted: true },
    constructor: { polluted: true },
    prototype: { polluted: true },
    filePath: '/safe.txt'
  });
  assert.strictEqual(res4.file_path, '/safe.txt');
  assert.strictEqual(res4.polluted, undefined);
  assert.strictEqual(Object.prototype.polluted, undefined);
});

// ============================================================================
// 6. Master Alias Map & Canonical Name Resolver
// ============================================================================

test('6. Master Tool Alias Map & Resolver across Hallucinated Formats', () => {
  assert.ok(Object.isFrozen(TOOL_ALIAS_MAP));
  assert.strictEqual(normalizeToolName, getCanonToolName);

  // Exact snake_case matches
  assert.strictEqual(getCanonToolName('read_file'), 'read_file');
  assert.strictEqual(getCanonToolName('send_message'), 'send_message');
  assert.strictEqual(getCanonToolName('whoami'), 'whoami');

  // CamelCase variants
  assert.strictEqual(getCanonToolName('readFile'), 'read_file');
  assert.strictEqual(getCanonToolName('sendMessage'), 'send_message');
  assert.strictEqual(getCanonToolName('waitForMail'), 'wait_for_mail');
  assert.strictEqual(getCanonToolName('spawnAgent'), 'spawn_agent');

  // Namespaced variants (dot and underscore)
  assert.strictEqual(getCanonToolName('virtualFs.readFile'), 'read_file');
  assert.strictEqual(getCanonToolName('virtualFs_readFile'), 'read_file');
  assert.strictEqual(getCanonToolName('fs.readFile'), 'read_file');
  assert.strictEqual(getCanonToolName('fs_readFile'), 'read_file');
  assert.strictEqual(getCanonToolName('messaging.sendMessage'), 'send_message');
  assert.strictEqual(getCanonToolName('msg.send'), 'send_message');
  assert.strictEqual(getCanonToolName('runtime.spawnAgent'), 'spawn_agent');
  assert.strictEqual(getCanonToolName('worldClock.getTime'), 'get_current_time');

  // Common CLI and LLM hallucinations
  assert.strictEqual(getCanonToolName('cp'), 'copy_file');
  assert.strictEqual(getCanonToolName('rm'), 'delete_file');
  assert.strictEqual(getCanonToolName('ls'), 'list_files');
  assert.strictEqual(getCanonToolName('chmod'), 'set_permissions');
  assert.strictEqual(getCanonToolName('send_mail'), 'send_message');
  assert.strictEqual(getCanonToolName('create_agent'), 'spawn_agent');
  assert.strictEqual(getCanonToolName('terminate_agent'), 'kill_agent');
  assert.strictEqual(getCanonToolName('get_identity'), 'whoami');
  assert.strictEqual(getCanonToolName('precall'), 'batch_precall');

  // Unknown names
  assert.strictEqual(getCanonToolName('unknown_custom_tool'), null);
  assert.strictEqual(getCanonToolName(''), null);
  assert.strictEqual(getCanonToolName(null), null);
  assert.strictEqual(getCanonToolName(undefined), null);

  // Precall allowlist
  assert.ok(Object.isFrozen(PRECALL_ALLOWLIST));
  assert.ok(PRECALL_ALLOWLIST.has('read_file'));
  assert.ok(PRECALL_ALLOWLIST.has('get_current_time'));
  assert.ok(PRECALL_ALLOWLIST.has('describe_tool'));
  assert.ok(!PRECALL_ALLOWLIST.has('write_file'));
  assert.ok(!PRECALL_ALLOWLIST.has('delete_file'));
  assert.ok(!PRECALL_ALLOWLIST.has('spawn_agent'));
  assert.ok(!PRECALL_ALLOWLIST.has('send_message'));
});

// ============================================================================
// 7. Dispatcher Ingestion Formats & Helper Methods
// ============================================================================

test('7. Tool Dispatcher Direct Invocation, executeToolCall, and executeTool', async () => {
  let readFileCalled = false;
  const mockVfs = {
    readFile: async (params, ctx) => {
      readFileCalled = true;
      return { success: true, content: 'Mock file content', size: 17 };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: mockVfs,
    agentId: 'agent_tester',
    allowedTools: 'all'
  });

  // 1. Direct invocation signature
  const res1 = await dispatcher({
    name: 'read_file',
    arguments: { file_path: '/test.txt' }
  });
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.content, 'Mock file content');

  // 2. OpenAI executeToolCall wrapper signature
  const res2 = await dispatcher.executeToolCall({
    id: 'call_abc_123',
    type: 'function',
    function: {
      name: 'readFile',
      arguments: JSON.stringify({ filePath: '/test.txt' })
    }
  });
  assert.strictEqual(res2.role, 'tool');
  assert.strictEqual(res2.tool_call_id, 'call_abc_123');
  const parsed = JSON.parse(res2.content);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.content, 'Mock file content');

  // 3. executeTool convenience helper
  const res3 = await dispatcher.executeTool('fs_readFile', { path: '/test.txt' });
  assert.strictEqual(res3.success, true);
  assert.strictEqual(res3.content, 'Mock file content');
});

// ============================================================================
// 8. Security Gating & Capability Authorization Invariants
// ============================================================================

test('8. Security Gating & Capability Authorization Invariants', async () => {
  const mockVfs = {
    readFile: async () => ({ success: true, content: 'read ok' }),
    writeFile: async () => ({ success: true, size: 10 })
  };
  const mockClock = {
    getTime: () => ({ success: true, formatted: '12:00:00' })
  };
  const mockLifecyclePort = {
    whoami: () => ({ success: true, agentId: 'restricted_agent' })
  };

  // 1. Innate tools are universally allowed even with empty allowedTools
  const restrictedDispatcher = createSandboxToolDispatcher({
    virtualFs: mockVfs,
    worldClock: mockClock,
    lifecyclePort: mockLifecyclePort,
    agentId: 'restricted_agent',
    allowedTools: []
  });

  const whoamiRes = await restrictedDispatcher.executeTool('whoami');
  assert.strictEqual(whoamiRes.success, true);
  assert.strictEqual(whoamiRes.agentId, 'restricted_agent');

  const timeRes = await restrictedDispatcher.executeTool('get_current_time');
  assert.strictEqual(timeRes.success, true);

  // Non-innate tool is rejected with PERMISSION_DENIED
  const writeRes = await restrictedDispatcher.executeTool('write_file', { file_path: '/a.txt', content: 'hello' });
  assert.strictEqual(writeRes.success, false);
  assert.strictEqual(writeRes.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);

  // 2. Readonly preset agent cannot call write_file
  const readonlyDispatcher = createSandboxToolDispatcher({
    virtualFs: mockVfs,
    agentId: 'ro_agent',
    allowedTools: 'readonly'
  });

  const roReadRes = await readonlyDispatcher.executeTool('read_file', { file_path: '/doc.txt' });
  assert.strictEqual(roReadRes.success, true);

  const roWriteRes = await readonlyDispatcher.executeTool('write_file', { file_path: '/doc.txt', content: 'test' });
  assert.strictEqual(roWriteRes.success, false);
  assert.strictEqual(roWriteRes.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);

  // 3. Superuser / Admin bypass allows all tools
  const adminDispatcher = createSandboxToolDispatcher({
    virtualFs: mockVfs,
    agentId: 'admin_agent',
    isAdmin: true,
    allowedTools: [] // explicitly empty, but admin bypasses
  });

  const adminWriteRes = await adminDispatcher.executeTool('write_file', { file_path: '/doc.txt', content: 'admin write' });
  assert.strictEqual(adminWriteRes.success, true);
});

// ============================================================================
// 9. Universal Error Shielding Guarantee
// ============================================================================

test('9. Universal Error Shielding Guarantee (Zero Unhandled Exceptions)', async () => {
  const crashingVfs = {
    readFile: async () => {
      throw new Error('Database disk I/O failure');
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: crashingVfs,
    agentId: 'agent_tester',
    allowedTools: 'all'
  });

  // 1. Unknown tool error
  const unknownRes = await dispatcher.executeTool('non_existent_tool', {});
  assert.strictEqual(unknownRes.success, false);
  assert.strictEqual(unknownRes.code, TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND);
  assert.ok(unknownRes.error.includes('non_existent_tool'));

  // 2. Downstream engine exception is caught and shielded
  const crashRes = await dispatcher.executeTool('read_file', { file_path: '/bad.txt' });
  assert.strictEqual(crashRes.success, false);
  assert.strictEqual(crashRes.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.strictEqual(crashRes.error, 'Database disk I/O failure');

  // 3. Missing substrate service
  const emptyDispatcher = createSandboxToolDispatcher({
    agentId: 'agent_empty',
    allowedTools: 'all'
  });
  const noVfsRes = await emptyDispatcher.executeTool('read_file', { file_path: '/test.txt' });
  assert.strictEqual(noVfsRes.success, false);
  assert.strictEqual(noVfsRes.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.ok(noVfsRes.error.includes('virtualFs service is not available'));
});

// ============================================================================
// 10. Subsystem Descriptor Delegations: Virtual Filesystem (11 Tools)
// ============================================================================

test('10. VFS Descriptor Delegations (11 Tools)', async () => {
  const vfsMock = {
    readFile: async (p) => ({ success: true, op: 'readFile', path: p.file_path, limit: p.limit }),
    writeFile: async (p) => ({ success: true, op: 'writeFile', path: p.file_path, content: p.content }),
    replaceFileContent: async (p) => ({ success: true, op: 'replaceFileContent', path: p.file_path, target: p.target_content }),
    copyFile: async (p) => ({ success: true, op: 'copyFile', src: p.src_path, dest: p.dest_path }),
    deleteFile: async (p) => ({ success: true, op: 'deleteFile', path: p.file_path }),
    listFiles: async (p) => ({ success: true, op: 'listFiles', dir: p.dir_path }),
    writeJson: async (p) => ({ success: true, op: 'writeJson', path: p.file_path, data: p.data }),
    queryJson: async (p) => ({ success: true, op: 'queryJson', path: p.file_path, query: p.query }),
    patchJson: async (p) => ({ success: true, op: 'patchJson', path: p.file_path, patch: p.patch }),
    grep: async (p) => ({ success: true, op: 'grep', pattern: p.pattern }),
    setPermissions: async (p) => ({ success: true, op: 'setPermissions', path: p.file_path, read_only: p.read_only })
  };

  const dispatcher = createSandboxToolDispatcher({ virtualFs: vfsMock, allowedTools: 'all' });

  // 1. read_file
  const r1 = await dispatcher.executeTool('read_file', { filePath: '/a.txt', maxBytes: 50 });
  assert.strictEqual(r1.op, 'readFile');
  assert.strictEqual(r1.path, '/a.txt');
  assert.strictEqual(r1.limit, 50);

  // 2. write_file
  const r2 = await dispatcher.executeTool('write_file', { filePath: '/a.txt', body: 'content 1' });
  assert.strictEqual(r2.op, 'writeFile');
  assert.strictEqual(r2.content, 'content 1');

  // 3. replace_file_content
  const r3 = await dispatcher.executeTool('replace_file_content', { filePath: '/a.txt', searchContent: 'foo', replacementContent: 'bar' });
  assert.strictEqual(r3.op, 'replaceFileContent');
  assert.strictEqual(r3.target, 'foo');

  // 4. copy_file
  const r4 = await dispatcher.executeTool('copy_file', { sourcePath: '/a.txt', destinationPath: '/b.txt' });
  assert.strictEqual(r4.op, 'copyFile');
  assert.strictEqual(r4.src, '/a.txt');
  assert.strictEqual(r4.dest, '/b.txt');

  // 5. delete_file
  const r5 = await dispatcher.executeTool('delete_file', { filePath: '/b.txt' });
  assert.strictEqual(r5.op, 'deleteFile');

  // 6. list_files
  const r6 = await dispatcher.executeTool('list_files', { directoryPath: '/lore' });
  assert.strictEqual(r6.op, 'listFiles');
  assert.strictEqual(r6.dir, '/lore');

  // 7. write_json
  const r7 = await dispatcher.executeTool('write_json', { filePath: '/data.json', jsonData: { key: 'val' } });
  assert.strictEqual(r7.op, 'writeJson');
  assert.deepStrictEqual(r7.data, { key: 'val' });

  // 8. query_json
  const r8 = await dispatcher.executeTool('query_json', { filePath: '/data.json', jsonPath: '.key' });
  assert.strictEqual(r8.op, 'queryJson');
  assert.strictEqual(r8.query, '.key');

  // 9. json_patch
  const r9 = await dispatcher.executeTool('json_patch', { filePath: '/data.json', patchData: [{ op: 'replace', path: '/key', value: 'new' }] });
  assert.strictEqual(r9.op, 'patchJson');

  // 10. grep
  const r10 = await dispatcher.executeTool('grep', { searchPattern: 'needle' });
  assert.strictEqual(r10.op, 'grep');
  assert.strictEqual(r10.pattern, 'needle');

  // 11. set_permissions
  const r11 = await dispatcher.executeTool('set_permissions', { filePath: '/a.txt', readOnly: true });
  assert.strictEqual(r11.op, 'setPermissions');
  assert.strictEqual(r11.read_only, true);
});

// ============================================================================
// 11. Subsystem Descriptor Delegations: Messaging Substrate (8 Tools)
// ============================================================================

test('11. Messaging Descriptor Delegations (8 Tools)', async () => {
  const busMock = {
    sendMessage: async (p) => ({ success: true, op: 'sendMessage', recipient: p.recipient, message: p.message }),
    waitForMail: async (p) => ({ success: true, op: 'waitForMail', timeout_ms: p.timeout_ms }),
    listInbox: async (p) => ({ success: true, op: 'listInbox', limit: p.limit }),
    readMessage: async (p) => ({ success: true, op: 'readMessage', message_id: p.message_id }),
    getArchive: async (p) => ({ success: true, op: 'getArchive', limit: p.limit }),
    inlineFileInMessage: async (p) => ({ success: true, op: 'inlineFileInMessage', file_path: p.file_path, recipient: p.recipient }),
    getInbox: async (p) => ({ success: true, op: 'getInbox', mark_as_read: p.mark_as_read }),
    drainInbox: (agentId) => [{ id: 'msg_1', content: 'Drained' }]
  };

  const dispatcher = createSandboxToolDispatcher({ messagingBus: busMock, allowedTools: 'all' });

  // 1. send_message
  const r1 = await dispatcher.executeTool('send_message', { to: 'agent_writer', content: 'Hello!' });
  assert.strictEqual(r1.op, 'sendMessage');
  assert.strictEqual(r1.recipient, 'agent_writer');
  assert.strictEqual(r1.message, 'Hello!');

  // 2. wait_for_mail
  const r2 = await dispatcher.executeTool('wait_for_mail', { timeoutMs: 5000 });
  assert.strictEqual(r2.op, 'waitForMail');
  assert.strictEqual(r2.timeout_ms, 5000);

  // 3. list_inbox
  const r3 = await dispatcher.executeTool('list_inbox', { count: 20 });
  assert.strictEqual(r3.op, 'listInbox');
  assert.strictEqual(r3.limit, 20);

  // 4. read_message
  const r4 = await dispatcher.executeTool('read_message', { messageId: 'msg_999' });
  assert.strictEqual(r4.op, 'readMessage');
  assert.strictEqual(r4.message_id, 'msg_999');

  // 5. get_archive
  const r5 = await dispatcher.executeTool('get_archive', { max: 50 });
  assert.strictEqual(r5.op, 'getArchive');
  assert.strictEqual(r5.limit, 50);

  // 6. inline_file_in_message
  const r6 = await dispatcher.executeTool('inline_file_in_message', { filePath: '/doc.md', targetAgentId: 'agent_critic' });
  assert.strictEqual(r6.op, 'inlineFileInMessage');
  assert.strictEqual(r6.file_path, '/doc.md');
  assert.strictEqual(r6.recipient, 'agent_critic');

  // 7. get_inbox
  const r7 = await dispatcher.executeTool('get_inbox', { markAsRead: true });
  assert.strictEqual(r7.op, 'getInbox');
  assert.strictEqual(r7.mark_as_read, true);

  // 8. drain_inbox
  const r8 = await dispatcher.executeTool('drain_inbox', {});
  assert.strictEqual(r8.success, true);
  assert.strictEqual(r8.count, 1);
});

// ============================================================================
// 12. Subsystem Descriptor Delegations: Agent Lifecycle (5 Tools)
// ============================================================================

test('12. Agent Lifecycle Descriptor Delegations (5 Tools)', async () => {
  let spawnCall = null;
  let killCall = null;
  let listDescriptorCall = null;
  const lifecyclePortMock = {
    launchAgent: async (options) => {
      spawnCall = options;
      return { success: true, op: 'launchAgent', id: options?.config?.id, role: options?.config?.role };
    },
    killAgent: async (id, reason, callerContext) => {
      killCall = { id, reason, callerContext };
      return true;
    },
    listAgentDescriptors: async (options) => {
      listDescriptorCall = options;
      return [{
        id: 'agent_01',
        name: 'Agent One',
        state: 'idle',
        role: 'coder',
        triggerPolicy: 'auto',
        unreadCount: 0,
        workspace: 'agent_01'
      }];
    },
    whoami: (agentId) => ({ success: true, op: 'whoami', agentId }),
    undoAgentTurn: async (agentId, turnId) => ({ success: true, op: 'undoAgentTurn', agentId, turnId })
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort: lifecyclePortMock,
    agentId: 'supervisor_agent',
    allowedTools: 'all'
  });

  // 1. spawn_agent — identity travels through LaunchAgentOptions.callerContext
  //    (MOD-21: never smuggled through config, never a privilege flag) and the
  //    successful receipt is the bounded public projection (550486c), never the
  //    raw launched entity.
  const r1 = await dispatcher.executeTool('spawn_agent', { agentId: 'worker_01', role: 'coder' });
  assert.deepStrictEqual(
    r1,
    {
      success: true,
      id: 'worker_01',
      name: 'worker_01',
      state: 'unknown',
      role: 'coder',
      workspace: 'worker_01'
    },
    'spawn_agent exposes exactly the bounded public receipt shape'
  );
  assert.strictEqual(spawnCall.config.id, 'worker_01');
  assert.strictEqual(spawnCall.config.callerContext, undefined);
  assert.deepStrictEqual(spawnCall.callerContext, { callerAgentId: 'supervisor_agent' });

  // 2. kill_agent — identity-only caller context
  const r2 = await dispatcher.executeTool('kill_agent', { targetAgentId: 'worker_01', reason: 'Done' });
  assert.strictEqual(r2.success, true);
  assert.strictEqual(r2.id, 'worker_01');
  assert.strictEqual(r2.killed, true);
  assert.strictEqual(killCall.id, 'worker_01');
  assert.strictEqual(killCall.reason, 'Done');
  assert.deepStrictEqual(killCall.callerContext, { callerAgentId: 'supervisor_agent' });

  // 3. list_agents — scoped descriptor delegation projected to the public shape
  const r3 = await dispatcher.executeTool('list_agents', {});
  assert.strictEqual(r3.success, true);
  assert.ok(Array.isArray(r3.result), 'list_agents array is wrapped under .result');
  assert.strictEqual(r3.result.length, 1);
  assert.deepStrictEqual(r3.result[0], {
    id: 'agent_01',
    name: 'Agent One',
    state: 'idle',
    role: 'coder',
    triggerPolicy: 'auto',
    unreadCount: 0,
    workspace: 'agent_01'
  }, 'list_agents exposes exactly the reduced public descriptor shape');
  assert.deepStrictEqual(
    listDescriptorCall,
    { callerAgentId: 'supervisor_agent' },
    'the bound caller identity is forwarded to the scoped descriptor projector'
  );

  // 4. whoami
  const r4 = await dispatcher.executeTool('whoami');
  assert.strictEqual(r4.op, 'whoami');
  assert.strictEqual(r4.agentId, 'supervisor_agent');

  // 5. undo_turn
  const r5 = await dispatcher.executeTool('undo_turn', { targetTurnId: 'turn_42' });
  assert.strictEqual(r5.op, 'undoAgentTurn');
  assert.strictEqual(r5.turnId, 'turn_42');
});

test('12b. list_agents fails closed for a lifecycle port without listAgentDescriptors (9133495)', async () => {
  let legacyListCalls = 0;
  const legacyPort = {
    listAgents: async () => {
      legacyListCalls += 1;
      return [{ id: 'legacy_agent', state: 'idle' }];
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort: legacyPort,
    agentId: 'supervisor_agent',
    allowedTools: 'all'
  });

  const receipt = await dispatcher.executeTool('list_agents', {});
  assert.strictEqual(
    receipt.success,
    false,
    'a legacy port without the scoped projector must fail closed, never list unscoped agents'
  );
  assert.strictEqual(receipt.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.match(
    receipt.error,
    /listAgentDescriptors/,
    'the error names the missing scoped capability'
  );
  assert.strictEqual(receipt.result, undefined, 'no agent list may be returned');
  assert.strictEqual(legacyListCalls, 0, 'the unscoped listAgents fallback must never run');
});

// ============================================================================
// 13. Subsystem Descriptor Delegations: Invocation Substrate (2 Tools)
// ============================================================================

test('13. Invocation Descriptor Delegations (2 Tools)', async () => {
  const lifecyclePortMock = {
    invokeAgent: async (invokerId, targetAgentId, prompt) => ({
      success: true,
      op: 'invokeAgent',
      invokerId,
      targetAgentId,
      prompt
    }),
    waitForInvocation: async (invocationIds, options) => ({
      success: true,
      op: 'waitForInvocation',
      timeout_ms: options?.timeout_ms
    })
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort: lifecyclePortMock,
    agentId: 'parent_agent',
    allowedTools: 'all'
  });

  // 1. invoke_agent
  const r1 = await dispatcher.executeTool('invoke_agent', { targetAgentId: 'child_agent', instruction: 'Process task' });
  assert.strictEqual(r1.op, 'invokeAgent');
  assert.strictEqual(r1.invokerId, 'parent_agent');
  assert.strictEqual(r1.targetAgentId, 'child_agent');
  assert.strictEqual(r1.prompt, 'Process task');

  // 2. wait_for_invocation
  const r2 = await dispatcher.executeTool('wait_for_invocation', { timeoutMs: 15000 });
  assert.strictEqual(r2.op, 'waitForInvocation');
  assert.strictEqual(r2.timeout_ms, 15000);
});

// ============================================================================
// 14. Subsystem Descriptor Delegations: Runtime Scheduler (3 Tools)
// ============================================================================

test('14. Runtime Scheduler Descriptor Delegations (3 Tools)', async () => {
  const schedulerMock = {
    schedule: async (params) => ({ success: true, op: 'schedule', action: params.action, prompt: params.prompt }),
    listSchedules: async (options, context) => ({
      success: true,
      op: 'listSchedules',
      agentId: context?.callerAgentId,
      contextKeys: Object.keys(context || {}).sort(),
      optionKeys: Object.keys(options || {})
    }),
    cancelSchedule: async (timerIdOrParams, reason, context) => ({
      success: true,
      op: 'cancelSchedule',
      taskId: typeof timerIdOrParams === 'string' ? timerIdOrParams : timerIdOrParams?.timerId,
      agentId: context?.callerAgentId,
      contextKeys: Object.keys(context || {}).sort(),
      reason
    })
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort: schedulerMock,
    agentId: 'timer_agent',
    allowedTools: 'all'
  });

  // 1. schedule
  const r1 = await dispatcher.executeTool('schedule', { action: 'timer', durationSeconds: 300, prompt: 'Check status' });
  assert.strictEqual(r1.op, 'schedule');
  assert.strictEqual(r1.action, 'timer');
  assert.strictEqual(r1.prompt, 'Check status');

  // 2. list_schedules — identity-only caller context (MOD-21)
  const r2 = await dispatcher.executeTool('list_schedules', {});
  assert.strictEqual(r2.op, 'listSchedules');
  assert.strictEqual(r2.agentId, 'timer_agent');
  assert.deepStrictEqual(r2.contextKeys, ['callerAgentId'], 'list_schedules context must be identity-only');
  assert.deepStrictEqual(r2.optionKeys, [], 'list_schedules must not forward params as scheduler options');

  // 2b. privilege and identity smuggling through params never reaches the port
  const r2b = await dispatcher.executeTool('list_schedules', {
    privileged: true,
    all: true,
    isPrivileged: true,
    callerAgentId: 'agent_alice'
  });
  assert.strictEqual(r2b.op, 'listSchedules');
  assert.strictEqual(r2b.agentId, 'timer_agent', 'callerAgentId in params must not override bound context identity');
  assert.deepStrictEqual(r2b.contextKeys, ['callerAgentId'], 'list_schedules context must stay identity-only');
  assert.deepStrictEqual(r2b.optionKeys, [], 'smuggled privilege keys must be dropped from options');

  // 3. cancel_schedule — identity-only caller context
  const r3 = await dispatcher.executeTool('cancel_schedule', { taskId: 'timer_123' });
  assert.strictEqual(r3.op, 'cancelSchedule');
  assert.strictEqual(r3.taskId, 'timer_123');
  assert.strictEqual(r3.agentId, 'timer_agent');
  assert.deepStrictEqual(r3.contextKeys, ['callerAgentId'], 'cancel_schedule context must be identity-only');
  assert.strictEqual(r3.reason, null);

  // 3b. privilege and identity smuggling through cancel params is not forwarded as trust
  const r3b = await dispatcher.executeTool('cancel_schedule', {
    taskId: 'timer_456',
    isPrivileged: true,
    privileged: true,
    callerAgentId: 'agent_alice'
  });
  assert.strictEqual(r3b.op, 'cancelSchedule');
  assert.strictEqual(r3b.taskId, 'timer_456');
  assert.strictEqual(r3b.agentId, 'timer_agent', 'callerAgentId in params must not override bound context identity');
  assert.deepStrictEqual(r3b.contextKeys, ['callerAgentId'], 'cancel_schedule context must stay identity-only');
});

// ============================================================================
// 15. Subsystem Descriptor Delegations: World Clock & Events (3 Tools)
// ============================================================================

test('15. World Clock & Events Descriptor Delegations (3 Tools)', async () => {
  const clockMock = {
    advanceClock: (p, ctx) => ({ success: true, op: 'advanceClock', minutes: p.minutes }),
    setTime: (p, ctx) => ({ success: true, op: 'setTime', time: p.time }),
    resetClock: (ctx) => ({ success: true, op: 'resetClock' }),
    getTime: (ctx) => ({ success: true, op: 'getTime', formatted: '10:00:00', hour: 10, minute: 0, second: 0 }),
    registerEvent: (p, ctx) => ({ success: true, op: 'registerEvent', name: p.name }),
    resolveEvent: (id, p, ctx) => ({ success: true, op: 'resolveEvent', id }),
    cancelEvent: (id, reason, ctx) => ({ success: true, op: 'cancelEvent', id, reason }),
    queryEvents: (p, ctx) => ({ success: true, op: 'queryEvents', count: 3 })
  };

  const dispatcher = createSandboxToolDispatcher({
    worldClock: clockMock,
    agentId: 'world_agent',
    allowedTools: 'all'
  });

  // 1. world_clock (advance, set, reset, query)
  const r1 = await dispatcher.executeTool('world_clock', { action: 'advance', offsetMinutes: 45 });
  assert.strictEqual(r1.op, 'advanceClock');
  assert.strictEqual(r1.minutes, 45);

  const r2 = await dispatcher.executeTool('world_clock', { action: 'set', time: '14:30' });
  assert.strictEqual(r2.op, 'setTime');
  assert.strictEqual(r2.time, '14:30');

  const r3 = await dispatcher.executeTool('world_clock', { action: 'reset' });
  assert.strictEqual(r3.op, 'resetClock');

  const r4 = await dispatcher.executeTool('world_clock', { action: 'query' });
  assert.strictEqual(r4.op, 'getTime');

  // 2. event_list (register, resolve, cancel, query)
  const e1 = await dispatcher.executeTool('event_list', { action: 'register', name: 'Eclipse' });
  assert.strictEqual(e1.op, 'registerEvent');
  assert.strictEqual(e1.name, 'Eclipse');

  const e2 = await dispatcher.executeTool('event_list', { action: 'resolve', eventId: 'evt_1' });
  assert.strictEqual(e2.op, 'resolveEvent');
  assert.strictEqual(e2.id, 'evt_1');

  const e3 = await dispatcher.executeTool('event_list', { action: 'cancel', eventId: 'evt_1', description: 'Cancelled' });
  assert.strictEqual(e3.op, 'cancelEvent');
  assert.strictEqual(e3.id, 'evt_1');

  const e4 = await dispatcher.executeTool('event_list', { action: 'query' });
  assert.strictEqual(e4.op, 'queryEvents');

  // 3. get_current_time
  const t1 = await dispatcher.executeTool('get_current_time');
  assert.strictEqual(t1.op, 'getTime');
  assert.strictEqual(t1.time_string, '10:00:00');
});

// ============================================================================
// 16. Subsystem Descriptor Delegations: Precall & Describe (2 Tools)
// ============================================================================

test('16. Precall & Tool Reflection Descriptor Delegations (2 Tools)', async () => {
  const dispatcher = createSandboxToolDispatcher({
    allowedTools: 'all',
    virtualFs: {
      readFile: async (p) => ({ success: true, content: 'precall content' }),
      writeFile: async () => ({ success: true })
    },
    worldClock: {
      getTime: () => ({ success: true, formatted: '09:30:00' })
    }
  });

  // 1. batch_precall with safe read-only operations
  const batchRes = await dispatcher.executeTool('batch_precall', {
    calls: [
      { name: 'read_file', arguments: { file_path: '/lore.txt' } },
      { name: 'get_current_time', arguments: {} }
    ]
  }, { executeTool: dispatcher.executeTool.bind(dispatcher) });

  assert.strictEqual(batchRes.success, true);
  assert.strictEqual(batchRes.count, 2);
  assert.strictEqual(batchRes.results[0].result.content, 'precall content');

  // Forbidden mutating tool inside batch_precall triggers PRECALL_FORBIDDEN
  const badBatch = await dispatcher.executeTool('batch_precall', {
    calls: [
      { name: 'write_file', arguments: { file_path: '/lore.txt', content: 'illegal' } }
    ]
  }, { executeTool: dispatcher.executeTool.bind(dispatcher) });

  assert.strictEqual(badBatch.success, true);
  assert.strictEqual(badBatch.results[0].success, false);
  assert.strictEqual(badBatch.results[0].code, TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN);

  // 2. describe_tool
  const descRes = await dispatcher.executeTool('describe_tool', { toolName: 'read_file' });
  assert.strictEqual(descRes.success, true);
  assert.strictEqual(descRes.tool_name, 'read_file');
  assert.ok(descRes.description.length > 0);
  assert.ok(descRes.schema);
  assert.ok(descRes.parameters.file_path);
});

// ============================================================================
// 17. Real Substrates End-to-End Integration
// ============================================================================

test('17. Real Substrates End-to-End Dispatcher Execution', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const clock = new WorldClock({ initialSeconds: 3600, autoSyncFs: false });

  bus.registerAgent('agent_alice');
  bus.registerAgent('agent_bob');

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    messagingBus: bus,
    worldClock: clock,
    agentId: 'agent_alice',
    allowedTools: 'all'
  });

  // 1. Write and read file through dispatcher
  const writeRes = await dispatcher.executeTool('write_file', {
    file_path: '/shared/memo.txt',
    content: 'Hello World from Tool Dispatcher'
  });
  assert.strictEqual(writeRes.success, true);

  const readRes = await dispatcher.executeTool('read_file', {
    file_path: '/shared/memo.txt'
  });
  assert.strictEqual(readRes.success, true);
  assert.strictEqual(readRes.content, 'Hello World from Tool Dispatcher');

  // 2. Send message and list inbox through dispatcher
  const sendRes = await dispatcher.executeTool('send_message', {
    recipient: 'agent_bob',
    message: 'Task ready for review'
  });
  assert.strictEqual(sendRes.success, true);

  // Bind a second trusted dispatcher for agent_bob to list his own inbox:
  // per-call identity overrides are caller data and never select the subject.
  const bobDispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    messagingBus: bus,
    worldClock: clock,
    agentId: 'agent_bob',
    allowedTools: 'all'
  });
  const bobInbox = await bobDispatcher.executeTool('list_inbox', {});
  assert.strictEqual(bobInbox.success, true);
  assert.ok(Array.isArray(bobInbox.result), 'list_inbox array is wrapped under .result');
  assert.strictEqual(bobInbox.result.length, 1);
  assert.strictEqual(bobInbox.result[0].from, 'agent_alice');
  assert.ok(bobInbox.result[0].preview.includes('Task ready for review'));

  // 3. Advance clock and query current time through dispatcher
  const advanceRes = await dispatcher.executeTool('world_clock', {
    action: 'advance',
    minutes: 30
  });
  assert.strictEqual(advanceRes.success, true);
  assert.strictEqual(advanceRes.currentFormatted, '00:30:00');

  const timeRes = await dispatcher.executeTool('get_current_time');
  assert.strictEqual(timeRes.formatted, '00:30:00');
});

// ============================================================================
// 18. ToolResult Envelope & Failure-Code Normalization (ICD-R1 124dbc6)
// ============================================================================

test('18. ToolResult Envelope & Failure-Code Normalization (ICD-R1)', async () => {
  const envelopeVfs = {
    listFiles: async () => [{ path: '/a.txt' }, { path: '/b.txt' }],
    grep: async () => [{ path: '/a.txt', line: 1, match: 'needle' }],
    deleteFile: async () => true,
    readFile: async (params) => {
      if (params.file_path === '/missing.txt') {
        const err = new Error("File '/missing.txt' does not exist");
        err.code = 'FILE_NOT_FOUND';
        throw err;
      }
      if (params.file_path === '/forbidden.txt') {
        const err = new Error('Permission denied');
        err.code = 'PERMISSION_DENIED';
        throw err;
      }
      if (params.file_path === '/invalid.txt') {
        return { success: false, error: 'Invalid arguments payload', code: 'INVALID_ARGUMENTS' };
      }
      return { success: false, error: 'Downstream read timeout', code: 'TIMEOUT' };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: envelopeVfs,
    agentId: 'agent_envelope',
    allowedTools: 'all'
  });

  // 1. Bare arrays are enveloped as ToolResult success receipts
  const listRes = await dispatcher.executeTool('list_files', {});
  assert.strictEqual(listRes.success, true);
  assert.ok(Array.isArray(listRes.result), 'list_files array is wrapped under .result');
  assert.strictEqual(listRes.result.length, 2);

  const grepRes = await dispatcher.executeTool('grep', { pattern: 'needle' });
  assert.strictEqual(grepRes.success, true);
  assert.deepStrictEqual(grepRes.result, [{ path: '/a.txt', line: 1, match: 'needle' }]);

  // 2. Primitive results stay enveloped
  const deleteRes = await dispatcher.executeTool('delete_file', { file_path: '/a.txt' });
  assert.strictEqual(deleteRes.success, true);
  assert.strictEqual(deleteRes.result, true);

  // 3. Thrown out-of-enum downstream codes normalize to EXECUTION_FAILED
  const missingRes = await dispatcher.executeTool('read_file', { file_path: '/missing.txt' });
  assert.strictEqual(missingRes.success, false);
  assert.strictEqual(missingRes.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.ok(missingRes.error.includes('does not exist'));

  // 4. Thrown in-enum codes are preserved
  const deniedRes = await dispatcher.executeTool('read_file', { file_path: '/forbidden.txt' });
  assert.strictEqual(deniedRes.success, false);
  assert.strictEqual(deniedRes.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);

  // 5. Returned failure receipts with out-of-enum codes normalize at the boundary
  const timeoutRes = await dispatcher.executeTool('read_file', { file_path: '/slow.txt' });
  assert.strictEqual(timeoutRes.success, false);
  assert.strictEqual(timeoutRes.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.strictEqual(timeoutRes.error, 'Downstream read timeout');

  // 6. Returned failure receipts with in-enum codes are preserved
  const invalidRes = await dispatcher.executeTool('read_file', { file_path: '/invalid.txt' });
  assert.strictEqual(invalidRes.success, false);
  assert.strictEqual(invalidRes.code, TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS);

  // 7. Every emitted failure code is a declared vocabulary member
  const declaredCodes = new Set(Object.values(TOOL_SYSTEM_ERROR_CODES));
  for (const receipt of [missingRes, deniedRes, timeoutRes, invalidRes]) {
    assert.ok(declaredCodes.has(receipt.code), `failure code '${receipt.code}' must be declared`);
  }

  // 8. read_file descriptor documents UTF-16 code units (G5 alignment)
  const readFileSchema = TOOL_REGISTRY.read_file.schema;
  assert.ok(readFileSchema.properties.offset.description.includes('UTF-16 code unit'));
  assert.ok(readFileSchema.properties.limit.description.includes('UTF-16 code unit'));
});

// ============================================================================
// 19. Realm/workspace/tenant scope-key pinning (Realm A0-2, c7a3049)
// ============================================================================

/**
 * The complete scope-key vocabulary the dispatcher must pin out of per-call
 * context. Kept as an explicit list here so a key silently dropped from
 * `PINNED_CONTEXT_KEYS` fails this suite.
 */
const SCOPE_CONTEXT_KEYS = Object.freeze([
  'workspaceId', 'workspace_id',
  'realmId', 'realm_id',
  'tenantId', 'tenant_id',
  'scope'
]);

test('19. per-call scope claims are stripped before a messaging-shaped handler (c7a3049)', async () => {
  for (const key of SCOPE_CONTEXT_KEYS) {
    const seenContexts = [];
    const dispatcher = createSandboxToolDispatcher({
      agentId: 'scope_agent',
      allowedTools: ['inline_file_in_message'],
      workspaceId: 'bound_workspace',
      messagingBus: {
        inlineFileInMessage: async (_params, ctx) => {
          seenContexts.push(ctx);
          return { success: true };
        }
      }
    });

    const receipt = await dispatcher.executeTool(
      'inline_file_in_message',
      { file_path: '/bound.txt', recipient: 'peer_agent' },
      { [key]: 'caller_workspace', ordinary: 'metadata' }
    );

    assert.strictEqual(receipt.success, true, `'${key}': the call must still dispatch`);
    assert.strictEqual(seenContexts.length, 1, `'${key}': the handler must run exactly once`);
    const seen = seenContexts[0];
    const expected = key === 'workspaceId' ? 'bound_workspace' : undefined;
    assert.strictEqual(
      seen[key],
      expected,
      `'${key}': the handler must observe the bound/undefined value, never the caller claim`
    );
    assert.notStrictEqual(seen[key], 'caller_workspace', `'${key}': a caller scope claim must never reach the handler`);
    assert.strictEqual(seen.workspaceId, 'bound_workspace', `'${key}': the bound workspace must stay effective`);
    assert.strictEqual(seen.ordinary, 'metadata', `'${key}': non-scope metadata still merges`);
  }
});

test('20. an unbound dispatcher never adopts a per-call scope claim (c7a3049)', async () => {
  for (const key of SCOPE_CONTEXT_KEYS) {
    const seenContexts = [];
    const dispatcher = createSandboxToolDispatcher({
      agentId: 'scope_agent',
      allowedTools: ['inline_file_in_message'],
      messagingBus: {
        inlineFileInMessage: async (_params, ctx) => {
          seenContexts.push(ctx);
          return { success: true };
        }
      }
    });

    await dispatcher.executeTool(
      'inline_file_in_message',
      { file_path: '/unbound.txt', recipient: 'peer_agent' },
      { [key]: 'caller_workspace' }
    );

    assert.strictEqual(seenContexts.length, 1, `'${key}': the handler must run exactly once`);
    assert.strictEqual(
      seenContexts[0][key],
      undefined,
      `'${key}': an unbound dispatcher must stay unbound, never adopt the caller claim`
    );
    assert.strictEqual(seenContexts[0].workspaceId, undefined, `'${key}': no workspace may be fabricated`);
  }
});

test('21. a VFS-shaped call observes the bound workspace, never per-call workspace claims (c7a3049)', async () => {
  for (const forgery of [
    { workspaceId: 'caller_workspace' },
    { workspace_id: 'caller_workspace' },
    { workspaceId: 'caller_workspace', workspace_id: 'caller_workspace' }
  ]) {
    const seenContexts = [];
    const dispatcher = createSandboxToolDispatcher({
      agentId: 'vfs_scope_agent',
      allowedTools: ['read_file'],
      workspaceId: 'bound_workspace',
      virtualFs: {
        readFile: async (_params, ctx) => {
          seenContexts.push(ctx);
          return { success: true, content: 'bound-content' };
        }
      }
    });

    const receipt = await dispatcher.executeTool('read_file', { file_path: '/scope.txt' }, forgery);

    assert.strictEqual(receipt.success, true, `${JSON.stringify(forgery)}: the call must still dispatch`);
    assert.strictEqual(seenContexts.length, 1, `${JSON.stringify(forgery)}: the handler must run exactly once`);
    assert.strictEqual(
      seenContexts[0].workspaceId,
      'bound_workspace',
      `${JSON.stringify(forgery)}: the effective workspace must be the bound one`
    );
    assert.strictEqual(
      seenContexts[0].workspace_id,
      undefined,
      `${JSON.stringify(forgery)}: the snake_case scope alias must be pinned too`
    );
  }
});
