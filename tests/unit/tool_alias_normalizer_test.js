/**
 * @file tests/unit/tool_alias_normalizer_test.js
 * @description Comprehensive unit tests for Sandbox Tool Constants, Master Tool Alias Map,
 * Precall Allowlist, and Parameter Sanitizer Subsystem.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_TOOLS,
  INNATE_TOOLS,
  TOOL_PRESETS,
  PUBLISHING_TOOLS,
  TOOL_SYSTEM_ERROR_CODES,
  resolveToolPreset
} from '../../src/lib/sandbox/tools/constants/index.ts';

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
  createSandboxToolDispatcher
} from '../../src/lib/sandbox/toolDefinitions/index.ts';

test('1. SANDBOX_TOOLS Master Enum & Immutability', () => {
  assert.ok(SANDBOX_TOOLS, 'SANDBOX_TOOLS must be exported');
  assert.ok(Object.isFrozen(SANDBOX_TOOLS), 'SANDBOX_TOOLS must be frozen');

  const expectedCanonicalTools = [
    // VFS (11)
    'read_file', 'write_file', 'replace_file_content', 'copy_file', 'delete_file',
    'list_files', 'write_json', 'query_json', 'json_patch', 'grep', 'set_permissions',
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
    // Precall & Describe (2)
    'batch_precall', 'describe_tool'
  ];

  assert.strictEqual(expectedCanonicalTools.length, 34, 'Must have exactly 34 canonical tools');

  for (const toolName of expectedCanonicalTools) {
    const matchingKey = Object.keys(SANDBOX_TOOLS).find(k => SANDBOX_TOOLS[k] === toolName);
    assert.ok(matchingKey, `SANDBOX_TOOLS must have an entry with value '${toolName}'`);
    assert.strictEqual(SANDBOX_TOOLS[matchingKey], toolName);
  }
});

test('2. INNATE_TOOLS Group & Membership', () => {
  assert.ok(INNATE_TOOLS, 'INNATE_TOOLS must be exported');
  assert.ok(Object.isFrozen(INNATE_TOOLS), 'INNATE_TOOLS must be frozen');
  assert.ok(Array.isArray(INNATE_TOOLS), 'INNATE_TOOLS must be an array');
  assert.strictEqual(typeof INNATE_TOOLS.has, 'function', 'INNATE_TOOLS must have a .has method');

  const expectedInnate = ['whoami', 'get_current_time', 'describe_tool', 'batch_precall'];
  for (const tool of expectedInnate) {
    assert.ok(INNATE_TOOLS.includes(tool), `INNATE_TOOLS must include '${tool}'`);
    assert.ok(INNATE_TOOLS.has(tool), `INNATE_TOOLS.has('${tool}') must be true`);
  }
  assert.strictEqual(INNATE_TOOLS.has('write_file'), false);
  assert.strictEqual(INNATE_TOOLS.has('delete_file'), false);
});

test('3. TOOL_PRESETS and resolveToolPreset Resolution', () => {
  assert.ok(TOOL_PRESETS, 'TOOL_PRESETS must be exported');
  assert.ok(Object.isFrozen(TOOL_PRESETS), 'TOOL_PRESETS must be frozen');

  const expectedPresets = ['all', 'manager', 'collaborator', 'readonly_collaborator', 'readonly'];
  for (const preset of expectedPresets) {
    assert.ok(TOOL_PRESETS[preset], `TOOL_PRESETS must contain '${preset}'`);
    assert.ok(Array.isArray(TOOL_PRESETS[preset]), `TOOL_PRESETS.${preset} must be an array`);
    assert.ok(Object.isFrozen(TOOL_PRESETS[preset]), `TOOL_PRESETS.${preset} array must be frozen`);
  }

  // resolveToolPreset tests
  assert.deepStrictEqual(resolveToolPreset('all'), ['*']);
  assert.deepStrictEqual(resolveToolPreset('*'), ['*']);
  assert.deepStrictEqual(resolveToolPreset(), []);
  assert.deepStrictEqual(resolveToolPreset(null), []);
  assert.deepStrictEqual(resolveToolPreset(undefined), []);
  assert.deepStrictEqual(resolveToolPreset(''), []);
  assert.deepStrictEqual(resolveToolPreset('   '), []);
  assert.deepStrictEqual(resolveToolPreset(123), []);
  assert.deepStrictEqual(resolveToolPreset('manager'), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset('collaborator'), [...TOOL_PRESETS.collaborator]);
  assert.deepStrictEqual(resolveToolPreset('readonly_collaborator'), [...TOOL_PRESETS.readonly_collaborator]);
  assert.deepStrictEqual(resolveToolPreset('readonly'), [...TOOL_PRESETS.readonly]);
  assert.deepStrictEqual(resolveToolPreset(['manager']), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset(['read_file', 'write_file']), ['read_file', 'write_file']);
  assert.deepStrictEqual(resolveToolPreset('read_file, write_file'), ['read_file', 'write_file']);
  assert.deepStrictEqual(resolveToolPreset(new Set(['read_file', 'send_message'])), ['read_file', 'send_message']);
});

test('4. Master TOOL_ALIAS_MAP and getCanonToolName across all 34 tools', () => {
  assert.ok(TOOL_ALIAS_MAP, 'TOOL_ALIAS_MAP must be exported');
  assert.ok(Object.isFrozen(TOOL_ALIAS_MAP), 'TOOL_ALIAS_MAP must be frozen');
  assert.strictEqual(normalizeToolName, getCanonToolName, 'normalizeToolName must alias getCanonToolName');

  // Test all 34 canonical names and camelCase variants
  const all34Tools = [
    { canon: 'read_file', camel: 'readFile', aliases: ['virtualFs_readFile', 'fs_readFile', 'fs.readFile', 'virtualFs.readFile', 'fs_read_file', 'vfs_read_file', 'file_read', 'read'] },
    { canon: 'write_file', camel: 'writeFile', aliases: ['virtualFs_writeFile', 'fs_writeFile', 'fs.writeFile', 'virtualFs.writeFile', 'fs_write_file', 'vfs_write_file', 'save_file', 'write'] },
    { canon: 'replace_file_content', camel: 'replaceFileContent', aliases: ['virtualFs_replaceFileContent', 'fs_replaceFileContent', 'fs.replaceFileContent', 'replace_content', 'edit_file'] },
    { canon: 'copy_file', camel: 'copyFile', aliases: ['virtualFs_copyFile', 'fs_copyFile', 'fs.copyFile', 'cp', 'copy'] },
    { canon: 'delete_file', camel: 'deleteFile', aliases: ['virtualFs_deleteFile', 'fs_deleteFile', 'fs.deleteFile', 'remove_file', 'rm', 'unlink', 'delete'] },
    { canon: 'list_files', camel: 'listFiles', aliases: ['virtualFs_listFiles', 'fs_listFiles', 'fs.listFiles', 'list_dir', 'ls', 'dir'] },
    { canon: 'write_json', camel: 'writeJson', aliases: ['virtualFs_writeJson', 'fs_writeJson', 'fs.writeJson', 'save_json', 'write_json_file'] },
    { canon: 'query_json', camel: 'queryJson', aliases: ['virtualFs_queryJson', 'fs_queryJson', 'fs.queryJson', 'json_path', 'read_json'] },
    { canon: 'json_patch', camel: 'jsonPatch', aliases: ['virtualFs_jsonPatch', 'fs_jsonPatch', 'fs.jsonPatch', 'patch_json', 'apply_json_patch'] },
    { canon: 'grep', camel: 'grep', aliases: ['virtualFs_grep', 'fs_grep', 'fs.grep', 'grep_search', 'search_files', 'find_in_files', 'search'] },
    { canon: 'set_permissions', camel: 'setPermissions', aliases: ['virtualFs_setPermissions', 'fs_setPermissions', 'fs.setPermissions', 'chmod', 'fs_chmod', 'set_mode'] },
    { canon: 'send_message', camel: 'sendMessage', aliases: ['messaging_sendMessage', 'messaging.sendMessage', 'msg_send', 'msg.send', 'runtime_sendMessage', 'send_mail', 'send'] },
    { canon: 'wait_for_mail', camel: 'waitForMail', aliases: ['runtime_waitForMail', 'runtime.waitForMail', 'wait_mail', 'wait_for_messages', 'await_mail'] },
    { canon: 'list_inbox', camel: 'listInbox', aliases: ['messaging_listInbox', 'messaging.listInbox', 'msg_listInbox', 'get_inbox_headers', 'check_inbox'] },
    { canon: 'read_message', camel: 'readMessage', aliases: ['messaging_readMessage', 'messaging.readMessage', 'read_mail', 'get_message', 'fetch_message'] },
    { canon: 'get_archive', camel: 'getArchive', aliases: ['messaging_getArchive', 'messaging.getArchive', 'list_archive', 'get_history', 'get_read_mail', 'read_archive'] },
    { canon: 'inline_file_in_message', camel: 'inlineFileInMessage', aliases: ['messaging_inlineFileInMessage', 'messaging.inlineFileInMessage', 'inline_file', 'send_templated_message', 'render_prompt'] },
    { canon: 'get_inbox', camel: 'getInbox', aliases: ['messaging_getInbox', 'messaging.getInbox', 'msg_getInbox', 'fetch_inbox'] },
    { canon: 'drain_inbox', camel: 'drainInbox', aliases: ['messaging_drainInbox', 'messaging.drainInbox', 'msg_drainInbox', 'clear_inbox', 'flush_inbox'] },
    { canon: 'spawn_agent', camel: 'spawnAgent', aliases: ['runtime_spawnAgent', 'runtime.spawnAgent', 'create_agent', 'spawn', 'new_agent', 'start_agent'] },
    { canon: 'kill_agent', camel: 'killAgent', aliases: ['runtime_killAgent', 'runtime.killAgent', 'terminate_agent', 'stop_agent', 'destroy_agent', 'kill'] },
    { canon: 'list_agents', camel: 'listAgents', aliases: ['runtime_listAgents', 'runtime.listAgents', 'get_agents', 'active_agents', 'all_agents'] },
    { canon: 'whoami', camel: 'whoami', aliases: ['runtime_whoami', 'runtime.whoami', 'get_identity', 'my_identity', 'self_id', 'who_am_i'] },
    { canon: 'undo_turn', camel: 'undoTurn', aliases: ['runtime_undoTurn', 'runtime.undoTurn', 'runtime_undo_turn', 'undo', 'revert_turn', 'rollback_turn'] },
    { canon: 'invoke_agent', camel: 'invokeAgent', aliases: ['runtime_invokeAgent', 'runtime.invokeAgent', 'call_agent', 'invoke', 'dispatch_agent', 'run_agent'] },
    { canon: 'wait_for_invocation', camel: 'waitForInvocation', aliases: ['runtime_waitForInvocation', 'runtime.waitForInvocation', 'wait_invocation', 'await_invocation'] },
    { canon: 'schedule', camel: 'schedule', aliases: ['runtime_schedule', 'runtime.schedule', 'schedule_task', 'schedule_timer', 'set_timer', 'create_schedule'] },
    { canon: 'list_schedules', camel: 'listSchedules', aliases: ['runtime_listSchedules', 'runtime.listSchedules', 'get_schedules', 'sched_list', 'list_timers'] },
    { canon: 'cancel_schedule', camel: 'cancelSchedule', aliases: ['runtime_cancelSchedule', 'runtime.cancelSchedule', 'delete_schedule', 'cancel_timer'] },
    { canon: 'world_clock', camel: 'worldClock', aliases: ['clock', 'get_clock', 'update_clock', 'advance_clock', 'set_clock', 'world_time', 'reset_clock'] },
    { canon: 'event_list', camel: 'eventList', aliases: ['events', 'world_events', 'list_events', 'register_event', 'resolve_event', 'active_events', 'query_events', 'cancel_event'] },
    { canon: 'get_current_time', camel: 'getCurrentTime', aliases: ['system_getCurrentTime', 'system.getCurrentTime', 'worldClock_getTime', 'get_time', 'time', 'now'] },
    { canon: 'batch_precall', camel: 'batchPrecall', aliases: ['runtime_batchPrecall', 'runtime.batchPrecall', 'batch_call', 'precall', 'batch_precalls'] },
    { canon: 'describe_tool', camel: 'describeTool', aliases: ['system_describeTool', 'system.describeTool', 'tool_info', 'help', 'describe', 'inspect_tool'] }
  ];

  assert.strictEqual(all34Tools.length, 34, 'Must verify all 34 tools');

  for (const item of all34Tools) {
    // Canonical name resolution
    assert.strictEqual(
      getCanonToolName(item.canon),
      item.canon,
      `Canonical name '${item.canon}' must resolve to itself`
    );

    // camelCase resolution
    assert.strictEqual(
      getCanonToolName(item.camel),
      item.canon,
      `camelCase '${item.camel}' must resolve to '${item.canon}'`
    );

    // Case-insensitive / whitespace resolution
    assert.strictEqual(
      getCanonToolName(`  ${item.camel.toUpperCase()}  `),
      item.canon,
      `Uppercase padded '${item.camel}' must resolve to '${item.canon}'`
    );

    // Aliases resolution
    for (const alias of item.aliases) {
      assert.strictEqual(
        getCanonToolName(alias),
        item.canon,
        `Alias '${alias}' must resolve to '${item.canon}'`
      );
    }
  }

  // Edge cases & prototype safety
  assert.strictEqual(getCanonToolName(null), null);
  assert.strictEqual(getCanonToolName(undefined), null);
  assert.strictEqual(getCanonToolName(''), null);
  assert.strictEqual(getCanonToolName('   '), null);
  assert.strictEqual(getCanonToolName(12345), null);
  assert.strictEqual(getCanonToolName('toString'), null);
  assert.strictEqual(getCanonToolName('constructor'), null);
  assert.strictEqual(getCanonToolName('__proto__'), null);
  assert.strictEqual(getCanonToolName('non_existent_fake_tool'), null);
});

test('5. PRECALL_ALLOWLIST Validation', () => {
  assert.ok(PRECALL_ALLOWLIST, 'PRECALL_ALLOWLIST must be exported');
  assert.ok(Object.isFrozen(PRECALL_ALLOWLIST), 'PRECALL_ALLOWLIST must be frozen');
  assert.ok(PRECALL_ALLOWLIST instanceof Set, 'PRECALL_ALLOWLIST must be a Set');
  assert.strictEqual(typeof PRECALL_ALLOWLIST.has, 'function', 'PRECALL_ALLOWLIST must have .has');

  // Canonical read-only tools in PRECALL_ALLOWLIST
  const canonicalAllowedPrecalls = [
    'read_file', 'query_json', 'list_files', 'grep',
    'get_current_time', 'world_clock', 'event_list',
    'list_agents', 'whoami', 'list_inbox', 'read_message',
    'get_archive', 'get_inbox', 'describe_tool'
  ];

  for (const tool of canonicalAllowedPrecalls) {
    assert.ok(PRECALL_ALLOWLIST.has(tool), `PRECALL_ALLOWLIST.has('${tool}') should be true`);
  }

  // Aliases resolved through getCanonToolName
  const aliasAllowedPrecalls = [
    'readFile', 'virtualFs_readFile',
    'queryJson', 'virtualFs_queryJson',
    'listFiles', 'virtualFs_listFiles',
    'virtualFs_grep',
    'getCurrentTime', 'system_getCurrentTime',
    'worldClock', 'clock',
    'eventList', 'events',
    'listAgents', 'runtime_listAgents',
    'runtime_whoami', 'get_identity',
    'listInbox', 'messaging_listInbox',
    'readMessage', 'messaging_readMessage',
    'getArchive', 'messaging_getArchive',
    'getInbox', 'messaging_getInbox',
    'describeTool', 'system_describeTool'
  ];

  for (const alias of aliasAllowedPrecalls) {
    const canon = getCanonToolName(alias);
    assert.ok(canon && PRECALL_ALLOWLIST.has(canon), `PRECALL_ALLOWLIST.has(getCanonToolName('${alias}')) should be true`);
  }

  // Mutating tools must be forbidden
  const forbiddenPrecalls = [
    'write_file', 'writeFile', 'virtualFs_writeFile',
    'replace_file_content', 'copy_file', 'delete_file', 'write_json', 'json_patch',
    'set_permissions', 'chmod',
    'send_message', 'sendMessage', 'messaging_sendMessage',
    'spawn_agent', 'spawnAgent', 'runtime_spawnAgent',
    'kill_agent', 'killAgent', 'runtime_killAgent',
    'undo_turn', 'invoke_agent', 'schedule', 'cancel_schedule',
    'drain_inbox', 'inline_file_in_message'
  ];

  for (const tool of forbiddenPrecalls) {
    const canon = getCanonToolName(tool) || tool;
    assert.strictEqual(
      PRECALL_ALLOWLIST.has(canon),
      false,
      `Mutating tool '${tool}' must NOT be in PRECALL_ALLOWLIST`
    );
  }
});

test('6. String Transformers (toSnakeCase, toCamelCase)', () => {
  // toSnakeCase
  assert.strictEqual(toSnakeCase('filePath'), 'file_path');
  assert.strictEqual(toSnakeCase('FilePath'), 'file_path');
  assert.strictEqual(toSnakeCase('targetContent'), 'target_content');
  assert.strictEqual(toSnakeCase('start_line'), 'start_line');
  assert.strictEqual(toSnakeCase('StartLine'), 'start_line');
  assert.strictEqual(toSnakeCase('file-path'), 'file_path');
  assert.strictEqual(toSnakeCase(''), '');
  assert.strictEqual(toSnakeCase(null), '');
  assert.strictEqual(toSnakeCase(undefined), '');

  // toCamelCase
  assert.strictEqual(toCamelCase('file_path'), 'filePath');
  assert.strictEqual(toCamelCase('FilePath'), 'filePath');
  assert.strictEqual(toCamelCase('target_content'), 'targetContent');
  assert.strictEqual(toCamelCase('filePath'), 'filePath');
  assert.strictEqual(toCamelCase('file-path'), 'filePath');
  assert.strictEqual(toCamelCase(''), '');
  assert.strictEqual(toCamelCase(null), '');
  assert.strictEqual(toCamelCase(undefined), '');
});

test('7. createParamSanitizer Behavior & Edge Cases', () => {
  const paramMap = {
    filePath: 'file_path',
    path: 'file_path',
    StartLine: 'start_line',
    from_line: 'start_line',
    to_line: 'end_line',
    workspaceId: 'workspace_id'
  };

  const defaults = {
    workspace_id: 'global',
    start_line: 1,
    budget_bytes: 20000
  };

  const sanitizer = createParamSanitizer(paramMap, defaults);

  // Normal sanitization with mappings and snake_case fallback
  const input = {
    filePath: 'notes.txt',
    from_line: 5,
    to_line: 10,
    customParam: 'active'
  };

  const output = sanitizer(input);
  assert.deepStrictEqual(output, {
    workspace_id: 'global',
    start_line: 5,
    end_line: 10,
    budget_bytes: 20000,
    file_path: 'notes.txt',
    custom_param: 'active'
  });

  // Null & undefined values are ignored, defaults preserved
  const withNulls = sanitizer({
    filePath: 'foo.txt',
    start_line: null,
    workspace_id: undefined
  });
  assert.strictEqual(withNulls.file_path, 'foo.txt');
  assert.strictEqual(withNulls.start_line, 1);
  assert.strictEqual(withNulls.workspace_id, 'global');

  // Stringified JSON parsing
  const jsonInput = '{"path": "data.json", "custom_key": 42}';
  const jsonOutput = sanitizer(jsonInput);
  assert.strictEqual(jsonOutput.file_path, 'data.json');
  assert.strictEqual(jsonOutput.custom_key, 42);
  assert.strictEqual(jsonOutput.workspace_id, 'global');

  // Invalid inputs fallback to defaults
  assert.deepStrictEqual(sanitizer(null), defaults);
  assert.deepStrictEqual(sanitizer(undefined), defaults);
  assert.deepStrictEqual(sanitizer('not json'), defaults);
  assert.deepStrictEqual(sanitizer([1, 2, 3]), defaults);
  assert.deepStrictEqual(sanitizer(123), defaults);

  // Prototype pollution safety
  const polluted = JSON.parse('{"__proto__": {"admin": true}, "constructor": "bad", "path": "safe.txt"}');
  const safeOutput = sanitizer(polluted);
  assert.strictEqual(safeOutput.file_path, 'safe.txt');
  assert.strictEqual(Object.prototype.admin, undefined);
  assert.strictEqual(safeOutput.__proto__, Object.prototype);
});

// ============================================================================
// 8. Alias-map structural invariants (ticket 3809c64)
// ============================================================================

/**
 * Normalizes an alias key the same way `getCanonToolName` resolves it:
 * trimmed, lowercased, and dot-notation folded to underscores.
 * @param {string} key
 * @returns {string}
 */
function normalizeAliasKey(key) {
  return key.trim().toLowerCase().replace(/\./g, '_');
}

test('8. TOOL_ALIAS_MAP normalized keys are unique and never span canonical families', () => {
  const canonicalNames = new Set(Object.values(SANDBOX_TOOLS));
  const selectorTargets = new Set(['subagent_management']);
  // Wave U publishing meta tools are explicit-grant-only and outside the
  // canonical taxonomy, but they resolve through the same alias map.
  const publishingTargets = new Set(Object.values(PUBLISHING_TOOLS));

  // (a) A normalized key may appear many times only when every occurrence maps
  // to the same canonical target; two different targets behind one normalized
  // key would make case/dot resolution order-dependent.
  const ownerByNormalizedKey = new Map();
  const collisions = [];
  for (const [key, target] of Object.entries(TOOL_ALIAS_MAP)) {
    const normalized = normalizeAliasKey(key);
    const owner = ownerByNormalizedKey.get(normalized);
    if (!owner) {
      ownerByNormalizedKey.set(normalized, { key, target });
    } else if (owner.target !== target) {
      collisions.push({ normalized, first: owner, second: { key, target } });
    }
  }
  assert.deepEqual(
    collisions,
    [],
    `alias keys must never collide across canonical families: ${JSON.stringify(collisions)}`
  );

  // (b) Every target is a declared canonical tool, a declared selector family,
  // or a Wave U publishing meta tool.
  for (const [key, target] of Object.entries(TOOL_ALIAS_MAP)) {
    assert.ok(
      canonicalNames.has(target) || selectorTargets.has(target) || publishingTargets.has(target),
      `alias '${key}' maps to unknown target '${target}'`
    );
  }

  // (c) No alias shadows another tool's family: every canonical name resolves
  // to itself through the public resolver.
  for (const canonical of canonicalNames) {
    assert.strictEqual(
      getCanonToolName(canonical),
      canonical,
      `canonical '${canonical}' must not be shadowed by another family's alias`
    );
  }

  // (d) Every alias key resolves to its declared target through the public resolver.
  for (const [key, target] of Object.entries(TOOL_ALIAS_MAP)) {
    assert.strictEqual(getCanonToolName(key), target, `alias '${key}' must resolve to '${target}'`);
  }
});

// ============================================================================
// 8b. Wave U publishing meta-tool aliases (ticket 2518510)
// ============================================================================

test('8b. publishing meta-tool names resolve canonically and never join the taxonomy', () => {
  assert.strictEqual(getCanonToolName('import_realm_template'), PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE);
  assert.strictEqual(getCanonToolName('importRealmTemplate'), PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE);
  assert.strictEqual(getCanonToolName('submit_hydration_package'), PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE);
  assert.strictEqual(getCanonToolName('submitHydrationPackage'), PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE);
  const canonicalNames = new Set(Object.values(SANDBOX_TOOLS));
  for (const name of Object.values(PUBLISHING_TOOLS)) {
    assert.strictEqual(canonicalNames.has(name), false, `${name} stays outside SANDBOX_TOOLS`);
    assert.strictEqual(getCanonToolName(name), name, `${name} resolves to itself`);
  }
  // Publishing tools are never precallable.
  assert.strictEqual(PRECALL_ALLOWLIST.has(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE), false);
  assert.strictEqual(PRECALL_ALLOWLIST.has(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE), false);
});

// ============================================================================
// 9. Alias-written allowlist entries grant exactly their canonical tool (3809c64)
// ============================================================================

test('9. alias-written allowlist entries grant exactly their canonical tool', async () => {
  const executed = [];
  const vfsMock = {
    readFile: async () => {
      executed.push('read_file');
      return { success: true, content: 'ok' };
    },
    writeFile: async () => {
      executed.push('write_file');
      return { success: true };
    },
    deleteFile: async () => {
      executed.push('delete_file');
      return { success: true };
    }
  };

  // `save_file` is the write-file alias family; the grant must canonicalize to
  // write_file and must not leak to any sibling capability.
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfsMock,
    agentId: 'alias_agent',
    allowedTools: ['save_file']
  });

  const writeRes = await dispatcher.executeTool('write_file', { file_path: '/alias.txt', content: 'x' });
  assert.strictEqual(writeRes.success, true, "'save_file' must grant the canonical write_file");
  assert.deepStrictEqual(executed, ['write_file']);

  const readRes = await dispatcher.executeTool('read_file', { file_path: '/alias.txt' });
  assert.strictEqual(readRes.success, false, "'save_file' must not grant read_file");
  assert.strictEqual(readRes.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);

  const deleteRes = await dispatcher.executeTool('delete_file', { file_path: '/alias.txt' });
  assert.strictEqual(deleteRes.success, false, "'save_file' must not grant delete_file");
  assert.strictEqual(deleteRes.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepStrictEqual(executed, ['write_file'], 'only the canonical grant may reach the substrate');
});

// ============================================================================
// 10. Category selectors are not dispatchable tools (3809c64)
// ============================================================================

test('10. bare subagent_management (and its selector aliases) fail TOOL_NOT_FOUND', async () => {
  const dispatcher = createSandboxToolDispatcher({
    agentId: 'selector_probe',
    allowedTools: ['*']
  });

  for (const selector of ['subagent_management', 'manage_subagents', 'subagents', 'subagent_tools']) {
    // The alias map canonicalizes the selector to the category sentinel ...
    assert.strictEqual(
      dispatcher.canonicalizeToolName(selector),
      'subagent_management',
      `'${selector}' must canonicalize to the category sentinel`
    );
    // ... but no registry descriptor exists for it, so dispatch fails closed.
    const receipt = await dispatcher.executeTool(selector, {});
    assert.strictEqual(receipt.success, false, `'${selector}' must not be dispatchable as a tool`);
    assert.strictEqual(
      receipt.code,
      TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND,
      `'${selector}' must fail with TOOL_NOT_FOUND (got '${receipt.code}')`
    );
  }
});

// ============================================================================
// 11. Case and dot variants of write aliases (3809c64)
// ============================================================================

test('11. case/dot variants of write aliases grant only the canonical write_file', async () => {
  const writeVariants = [
    'write_file',
    'WRITE_FILE',
    'WriteFile',
    'writefile',
    'save_file',
    'SAVE_FILE',
    'save.file',
    'SAVE.FILE',
    'fs.writeFile',
    'FS.WRITE_FILE',
    'fs_write_file',
    'virtualFS.WriteFile'
  ];

  for (const variant of writeVariants) {
    assert.strictEqual(
      getCanonToolName(variant),
      'write_file',
      `write variant '${variant}' must canonicalize to write_file`
    );

    const executed = [];
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: {
        writeFile: async () => {
          executed.push('write_file');
          return { success: true };
        },
        deleteFile: async () => {
          executed.push('delete_file');
          return { success: true };
        }
      },
      agentId: `variant_${variant.replace(/[^a-zA-Z0-9]/g, '_')}`,
      allowedTools: [variant]
    });

    const writeRes = await dispatcher.executeTool('write_file', { file_path: '/variant.txt', content: 'x' });
    assert.strictEqual(writeRes.success, true, `allowlist variant '${variant}' must grant write_file`);

    const deleteRes = await dispatcher.executeTool('delete_file', { file_path: '/variant.txt' });
    assert.strictEqual(deleteRes.success, false, `allowlist variant '${variant}' must not grant delete_file`);
    assert.strictEqual(deleteRes.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
    assert.deepStrictEqual(executed, ['write_file'], `variant '${variant}' must reach only write_file`);
  }
});
