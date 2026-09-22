/**
 * @file tests/tool_schemas_security_test.js
 * @description Comprehensive unit & contract test suite for EPIC-06:
 * Security Governance, Native Tool Schemas & Whitelisting.
 * Validates JSON Schema Draft-07 compliance, capability whitelisting, alias resolution,
 * resilient execution dispatcher, and universal admin workspace access.
 */

import {
  SANDBOX_TOOLS,
  getSandboxToolsSchema,
  createSandboxToolDispatcher
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { TOOL_ALIAS_MAP, normalizeToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';
import {
  ALL_TOOL_DESCRIPTORS,
  TOOL_REGISTRY,
  PUBLISHING_TOOL_REGISTRY,
  getPublishingToolSchemas
} from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { PUBLISHING_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';
import { AGENT_AUTHORITIES } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { VirtualFS, PermissionDeniedError, FileNotFoundError } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    failed++;
    return false;
  }
  console.log(`  [PASS] ${message}`);
  passed++;
  return true;
}

async function runEpic6UnitTests() {
  console.log('======================================================================');
  console.log('  EPIC 6 UNIT & CONTRACT VERIFICATION SUITE');
  console.log('  Layer 1: Security Governance, Native Tool Schemas & Whitelisting');
  console.log('======================================================================\n');

  // --- SECTION 1: Registry & Constants Verification ---
  console.log('--- 1. SANDBOX_TOOLS Registry & Tool Constants ---');
  const expectedTools = [
    'read_file',
    'write_file',
    'replace_file_content',
    'write_json',
    'query_json',
    'json_patch',
    'list_files',
    'delete_file',
    'grep',
    'get_current_time',
    'send_message',
    'get_inbox',
    'drain_inbox',
    'spawn_agent',
    'kill_agent'
  ];

  assert(Object.keys(SANDBOX_TOOLS).length >= 15, 'SANDBOX_TOOLS contains at least 15 standard tools');
  const canonicalTools = Object.values(SANDBOX_TOOLS);
  for (const toolName of expectedTools) {
    assert(canonicalTools.includes(toolName), `SANDBOX_TOOLS includes canonical '${toolName}'`);
  }

  // --- SECTION 2: OpenAI/DeepSeek JSON Schema Draft-07 Compliance ---
  console.log('\n--- 2. OpenAI / DeepSeek Schema Draft-07 Validation (INV-SCHEMA) ---');
  const allSchemas = getSandboxToolsSchema();
  assert(Array.isArray(allSchemas), 'getSandboxToolsSchema returns an array');
  assert(allSchemas.length >= 15, 'getSandboxToolsSchema returns all schemas by default');

  for (const def of allSchemas) {
    assert(def.type === 'function', `Schema for '${def.function?.name}' has type 'function'`);
    assert(typeof def.function?.name === 'string' && def.function.name.length > 0, `Schema has valid function.name: ${def.function?.name}`);
    assert(typeof def.function?.description === 'string' && def.function.description.length > 0, `Schema for '${def.function.name}' has non-empty description`);
    assert(def.function.parameters?.type === 'object', `Schema for '${def.function.name}' parameters.type is 'object'`);
    assert(typeof def.function.parameters.properties === 'object', `Schema for '${def.function.name}' parameters.properties is object`);
    assert(Array.isArray(def.function.parameters.required), `Schema for '${def.function.name}' parameters.required is array`);
    assert(typeof def.function.parameters.additionalProperties === 'boolean', `Schema for '${def.function.name}' has boolean additionalProperties`);
  }

  // Check specific required parameters
  const replaceSchema = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.REPLACE_FILE_CONTENT);
  assert(replaceSchema.function.parameters.required.includes('file_path'), 'replaceFileContent requires file_path');
  assert(replaceSchema.function.parameters.required.includes('target_content'), 'replaceFileContent requires target_content');
  assert(replaceSchema.function.parameters.properties.replacement_content?.type === 'string', 'replaceFileContent declares inline replacement_content');
  assert(replaceSchema.function.parameters.properties.replacement_source_file?.type === 'string', 'replaceFileContent declares file-sourced replacement_source_file');

  const writeJsonSchema = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.WRITE_JSON);
  assert(writeJsonSchema.function.parameters.required.includes('file_path'), 'writeJson requires file_path');
  assert(writeJsonSchema.function.parameters.properties.data, 'writeJson declares inline data');
  assert(writeJsonSchema.function.parameters.properties.data_source_file?.type === 'string', 'writeJson declares file-sourced data_source_file');

  const spawnSchema = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.SPAWN_AGENT);
  assert(spawnSchema.function.parameters.required.includes('id'), 'spawnAgent requires id');

  // --- SECTION 3: Tool Alias Normalization ---
  console.log('\n--- 3. Tool Alias Normalization Engine ---');
  assert(normalizeToolName('read_file') === SANDBOX_TOOLS.READ_FILE, "normalizeToolName resolves 'read_file'");
  assert(normalizeToolName('readFile') === SANDBOX_TOOLS.READ_FILE, "normalizeToolName resolves 'readFile'");
  assert(normalizeToolName('replace_file_content') === SANDBOX_TOOLS.REPLACE_FILE_CONTENT, "normalizeToolName resolves 'replace_file_content'");
  assert(normalizeToolName('write_json') === SANDBOX_TOOLS.WRITE_JSON, "normalizeToolName resolves 'write_json'");
  assert(normalizeToolName('query_json') === SANDBOX_TOOLS.QUERY_JSON, "normalizeToolName resolves 'query_json'");
  assert(normalizeToolName('json_patch') === SANDBOX_TOOLS.JSON_PATCH, "normalizeToolName resolves 'json_patch'");
  assert(normalizeToolName('get_current_time') === SANDBOX_TOOLS.GET_CURRENT_TIME, "normalizeToolName resolves 'get_current_time'");
  assert(normalizeToolName('send_message') === SANDBOX_TOOLS.SEND_MESSAGE, "normalizeToolName resolves 'send_message'");
  assert(normalizeToolName('spawn_agent') === SANDBOX_TOOLS.SPAWN_AGENT, "normalizeToolName resolves 'spawn_agent'");
  assert(normalizeToolName('kill_agent') === SANDBOX_TOOLS.KILL_AGENT, "normalizeToolName resolves 'kill_agent'");
  assert(normalizeToolName('unknown_custom_tool') === null, "normalizeToolName returns null for unknown tool");

  // --- SECTION 4: Capability Whitelist Filtering ---
  console.log('\n--- 4. Schema Capability Whitelist Filtering (INV-WHITELIST) ---');
  const filteredSchemas1 = getSandboxToolsSchema(['read_file', 'write_file', 'get_current_time']);
  assert(filteredSchemas1.length === 3, 'getSandboxToolsSchema returns exactly 3 schemas for 3 allowed aliases');
  const filteredNames1 = filteredSchemas1.map(s => s.function.name);
  assert(filteredNames1.includes(SANDBOX_TOOLS.READ_FILE), "Filtered schemas include 'virtualFs_readFile'");
  assert(filteredNames1.includes(SANDBOX_TOOLS.WRITE_FILE), "Filtered schemas include 'virtualFs_writeFile'");
  assert(filteredNames1.includes(SANDBOX_TOOLS.GET_CURRENT_TIME), "Filtered schemas include 'system_getCurrentTime'");

  const filteredSchemas2 = getSandboxToolsSchema(['virtualFs_queryJson', 'json_patch']);
  assert(filteredSchemas2.length === 2, 'getSandboxToolsSchema mixes canonical and alias names cleanly');

  const emptyFilter = getSandboxToolsSchema([]);
  assert(emptyFilter.length === 0, 'getSandboxToolsSchema with empty array returns empty array');

  // --- SECTION 5: Dispatcher Whitelisting & Error Shielding ---
  console.log('\n--- 5. Dispatcher Capability Enforcement & Error Shielding ---');
  // MOD-21 W4: the substrate resolves cross-workspace authority through the
  // injected identity port; delegate to the runtime's port once it exists.
  let runtimeIdentityPort = null;
  const virtualFs = new VirtualFS({
    identityPort: {
      getAgentIdentity: (agentId) => (runtimeIdentityPort ? runtimeIdentityPort.getAgentIdentity(agentId) : null)
    }
  });
  const messagingBus = new MessagingBus();
  messagingBus.registerAgent('agent_alice');
  messagingBus.registerAgent('agent_bob');

  const restrictedDispatcher = createSandboxToolDispatcher({
    virtualFs,
    messagingBus,
    agentId: 'agent_alice',
    role: 'specialist',
    allowedTools: ['read_file', 'write_file']
  });

  // Allowed tool invocation
  const writeRes = await restrictedDispatcher.executeTool('write_file', {
    filePath: '/test.txt',
    content: 'Alice content'
  });
  assert(writeRes.success === true, 'Permitted tool write_file executes successfully');

  // Blocked restricted tool invocation (alias)
  const blockedRes1 = await restrictedDispatcher.executeTool('spawn_agent', {
    id: 'sub_agent'
  });
  assert(blockedRes1.success === false, 'Blocked tool spawn_agent fails');
  assert(blockedRes1.code === 'PERMISSION_DENIED', 'Blocked tool returns code PERMISSION_DENIED');

  // Blocked restricted tool invocation (canonical)
  const blockedRes2 = await restrictedDispatcher.executeTool('runtime_killAgent', {
    agentId: 'sub_agent'
  });
  assert(blockedRes2.success === false && blockedRes2.code === 'PERMISSION_DENIED', 'Blocked canonical killAgent rejected with PERMISSION_DENIED');

  // executeToolCall format check
  const toolCallResponse = await restrictedDispatcher.executeToolCall({
    id: 'call_123',
    function: {
      name: 'runtime_spawnAgent',
      arguments: JSON.stringify({ id: 'sub_agent' })
    }
  });
  assert(toolCallResponse.role === 'tool', "executeToolCall returns role 'tool'");
  assert(toolCallResponse.tool_call_id === 'call_123', 'executeToolCall preserves tool_call_id');
  const parsedContent = JSON.parse(toolCallResponse.content);
  assert(parsedContent.code === 'PERMISSION_DENIED', 'executeToolCall content contains PERMISSION_DENIED payload');

  // --- SECTION 6: Dispatcher Execution for All 15 Tools ---
  console.log('\n--- 6. Complete 15-Tool Dispatcher Execution ---');
  const runtime = new AgentRuntime({ virtualFs, messagingBus, autoBootstrapDirector: false });
  runtimeIdentityPort = runtime.createAgentIdentityPort();
  // MOD-21: the dispatcher's bound identity must resolve to a registered
  // registry descriptor for privileged tool calls. Bootstrap the director as
  // the composition root and provision agent_alice / director_agent as
  // privileged operators.
  await runtime.ensureDirector();
  await runtime.launchAgent({
    config: { id: 'agent_alice', privileged: true, allowedTools: ['*'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'director_agent', privileged: true, allowedTools: ['*'] },
    callerContext: { callerAgentId: 'director' }
  });
  // Wave R (ticket 56ba4b9): every non-director agent resolves a Realm (the
  // Generic default), and the VFS cross-workspace ACL is realm-aware — Bob's
  // workspace must belong to a registered same-realm agent, otherwise the
  // privileged admin access below is a fail-closed cross-scope denial.
  await runtime.launchAgent({
    config: { id: 'agent_bob', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  const worldClock = new WorldClock({ virtualFs });
  const fullDispatcher = createSandboxToolDispatcher({
    virtualFs,
    messagingBus,
    worldClock,
    agentId: 'agent_alice',
    role: 'admin',
    privileged: true,
    allowedTools: ['*'],
    runtime
  });

  // 1. Write file
  const tWrite = await fullDispatcher.executeTool('write_file', { filePath: '/data.txt', content: 'Line 1\nTarget Block\nLine 3' });
  assert(tWrite.success === true, '1. write_file succeeds');

  // 2. Read file
  const tRead = await fullDispatcher.executeTool('read_file', { filePath: '/data.txt' });
  assert(tRead.success === true && tRead.content.includes('Target Block'), '2. read_file succeeds');

  // 3. Replace file content
  const tReplace = await fullDispatcher.executeTool('replace_file_content', {
    filePath: '/data.txt',
    targetContent: 'Target Block',
    replacementContent: 'Replaced Block'
  });
  assert(tReplace.success === true && tReplace.lines_modified === 1, '3. replace_file_content succeeds');

  // 4. Write JSON
  const tWriteJson = await fullDispatcher.executeTool('write_json', {
    filePath: '/config.json',
    data: { app: 'story', count: 10, items: ['sword', 'shield'] }
  });
  assert(tWriteJson.success === true && tWriteJson.bytes_written > 0, '4. write_json succeeds');

  // 5. Query JSON
  const tQueryJson = await fullDispatcher.executeTool('query_json', {
    filePath: '/config.json',
    filter: '.items[0]'
  });
  assert(tQueryJson.success === true && tQueryJson.result === 'sword', '5. query_json evaluates jq filter');

  // 6. JSON Patch
  const tPatch = await fullDispatcher.executeTool('json_patch', {
    filePath: '/config.json',
    patch: [{ op: 'replace', path: '/count', value: 15 }]
  });
  assert(tPatch.success === true, '6. json_patch succeeds');
  const tVerifyTransform = await fullDispatcher.executeTool('query_json', { filePath: '/config.json', filter: '.count' });
  assert(tVerifyTransform.result === 15, 'json_patch updated count from 10 to 15');

  // 7. List files — bare arrays are wrapped in a ToolResult success receipt
  const tList = await fullDispatcher.executeTool('list_files', {});
  assert(tList.success === true && Array.isArray(tList.result) && tList.result.length >= 2, '7. list_files succeeds');

  // 8. Grep
  const tGrep = await fullDispatcher.executeTool('grep', { pattern: 'Replaced Block' });
  assert(tGrep.success === true && Array.isArray(tGrep.result) && tGrep.result.length === 1, '8. grep finds matching line');

  // 9. Delete file
  const tDelete = await fullDispatcher.executeTool('delete_file', { filePath: '/data.txt' });
  assert(tDelete.success === true && tDelete.result === true, '9. delete_file succeeds');

  // 10. Get current time
  const tTime = await fullDispatcher.executeTool('get_current_time', {});
  assert(tTime.success === true && typeof tTime.totalSeconds === 'number' && typeof tTime.formatted === 'string', '10. get_current_time returns clock projection fields');

  // 11. Send message
  const tSend = await fullDispatcher.executeTool('send_message', { to: 'agent_bob', content: 'Hello Bob' });
  assert(tSend.success === true && tSend.from === 'agent_alice', '11. send_message locks from to agent_alice');

  // 12. Get inbox & Drain inbox
  messagingBus.sendMessage({ from: 'agent_bob', to: 'agent_alice', content: 'Hello Alice' });
  const tInbox = await fullDispatcher.executeTool('get_inbox', {});
  assert(tInbox.success === true && tInbox.count === 1, '12. get_inbox retrieves pending message');
  const tDrain = await fullDispatcher.executeTool('drain_inbox', {});
  assert(tDrain.success === true && tDrain.count === 1, '13. drain_inbox clears pending messages');

  // 14. Spawn agent
  const tSpawn = await fullDispatcher.executeTool('spawn_agent', {
    id: 'agent_charlie',
    role: 'researcher',
    allowedTools: ['read_file', 'get_current_time']
  });
  assert(tSpawn.success === true && tSpawn.id === 'agent_charlie', '14. spawn_agent dynamically launches agent');

  // 15. Kill agent
  const tKill = await fullDispatcher.executeTool('kill_agent', { agentId: 'agent_charlie' });
  assert(tKill.success === true && tKill.id === 'agent_charlie', '15. kill_agent terminates agent');

  // --- SECTION 7: Universal Admin Security Governance (INV-ADMIN) ---
  console.log('\n--- 7. Universal Admin Security Governance (INV-ADMIN) ---');
  // Setup private files for Alice and Bob
  virtualFs.writeFile('/secret.txt', 'Alice private data', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  virtualFs.writeFile('/plans.json', JSON.stringify({ mission: 'infiltrate' }), { workspaceId: 'agent_bob', callerAgentId: 'agent_bob' });

  // 1. Non-admin Bob attempts cross-workspace read on Alice's private file -> REJECTED
  let nonAdminBlocked = false;
  try {
    virtualFs.readFile('/secret.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob' });
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      nonAdminBlocked = true;
    }
  }
  assert(nonAdminBlocked, "Non-admin agent 'agent_bob' is rejected from reading Alice's workspace");

  // 2. Non-admin Bob attempts cross-workspace write on Alice's workspace -> REJECTED
  let nonAdminWriteBlocked = false;
  try {
    virtualFs.writeFile('/poison.txt', 'malicious data', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob' });
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      nonAdminWriteBlocked = true;
    }
  }
  assert(nonAdminWriteBlocked, "Non-admin agent 'agent_bob' is rejected from writing to Alice's workspace");

  // 3. Admin agent with role: 'admin' / privileged reading Alice's private workspace -> ALLOWED
  const adminReadContent = virtualFs.readFile('/secret.txt', {
    workspaceId: 'agent_alice',
    callerAgentId: 'director_agent',
    callerRole: 'admin',
    isAdmin: true,
    privileged: true
  });
  assert(
    (typeof adminReadContent === 'string' ? adminReadContent : adminReadContent?.content) === 'Alice private data',
    "Admin agent (role: 'admin') can read Alice's private workspace"
  );

  // 4. Admin agent writing to Bob's private workspace -> ALLOWED
  const adminWriteRes = virtualFs.writeFile('/admin_override.txt', 'Authorized by Director', {
    workspaceId: 'agent_bob',
    callerAgentId: 'director_agent',
    callerRole: 'admin',
    isAdmin: true,
    privileged: true
  });
  assert(adminWriteRes.success === true, "Admin agent (role: 'admin') can write to Bob's private workspace");

  // 5. Admin agent replacing content in Bob's private file -> ALLOWED
  const adminReplaceRes = virtualFs.replaceFileContent(
    '/admin_override.txt',
    'Authorized by Director',
    'Director Override Executed',
    {
      workspaceId: 'agent_bob',
      callerAgentId: 'director_agent',
      callerRole: 'admin',
      isAdmin: true,
      privileged: true
    }
  );
  assert(adminReplaceRes.success === true, "Admin agent can replace content in Bob's private file");

  // 6. Admin agent querying Bob's private JSON file -> ALLOWED
  const adminQueryResult = virtualFs.queryJson(
    '/plans.json',
    '.mission',
    {
      workspaceId: 'agent_bob',
      callerAgentId: 'director_agent',
      callerRole: 'admin',
      isAdmin: true,
      privileged: true
    }
  );
  assert(adminQueryResult === 'infiltrate', "Admin agent can query Bob's private JSON file");

  // 7. Admin agent patching Bob's private JSON file -> ALLOWED
  const adminPatchRes = virtualFs.patchJson(
    '/plans.json',
    [{ op: 'replace', path: '/mission', value: 'abort' }],
    {
      workspaceId: 'agent_bob',
      callerAgentId: 'director_agent',
      callerRole: 'admin',
      isAdmin: true,
      privileged: true
    }
  );
  assert(adminPatchRes.success === true, "Admin agent can patch Bob's private JSON file");
  const bobMission = virtualFs.queryJson('/plans.json', '.mission', { workspaceId: 'agent_bob', callerAgentId: 'agent_bob' });
  assert(bobMission === 'abort', "Bob's private JSON was mutated by Admin to 'abort'");

  // 8. Admin agent listing and deleting Bob's private file -> ALLOWED
  const adminList = virtualFs.listFiles('/', { workspaceId: 'agent_bob', callerAgentId: 'director_agent', callerRole: 'admin', isAdmin: true, privileged: true });
  assert(adminList.some(f => f.path === '/admin_override.txt'), "Admin can list Bob's private directory");

  const adminDelete = virtualFs.deleteFile('/admin_override.txt', { workspaceId: 'agent_bob', callerAgentId: 'director_agent', callerRole: 'admin', isAdmin: true, privileged: true });
  assert(adminDelete === true, "Admin can delete file in Bob's private workspace");

  // 9. Admin Grep wildcard '*' scans all workspaces (privilege supplied via trusted context)
  const adminGrep = virtualFs.grep(
    { workspaceId: '*', pattern: 'Alice private data', callerAgentId: 'director_agent' },
    { callerAgentId: 'director_agent', callerRole: 'admin', isAdmin: true, privileged: true }
  );
  assert(adminGrep.length === 1 && adminGrep[0].workspaceId === 'agent_alice', "Admin wildcard grep searches across foreign private workspaces");

  const nonAdminGrep = virtualFs.grep(
    { workspaceId: '*', pattern: 'Alice private data', callerAgentId: 'agent_bob' },
    { callerAgentId: 'agent_bob', callerRole: 'specialist' }
  );
  assert(nonAdminGrep.length === 0, "Non-admin wildcard grep is strictly confined to caller and global workspaces");

  // 10. Global read-only override by admin
  virtualFs.writeFile('/system_policy.json', JSON.stringify({ lockdown: false }), {
    workspaceId: 'global',
    callerAgentId: 'agent_alice',
    readOnly: true
  });

  let nonAdminGlobalBlocked = false;
  try {
    virtualFs.writeFile('/system_policy.json', JSON.stringify({ lockdown: true }), {
      workspaceId: 'global',
      callerAgentId: 'agent_bob'
    });
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      nonAdminGlobalBlocked = true;
    }
  }
  assert(nonAdminGlobalBlocked, 'Non-admin Bob cannot overwrite Alice read-only global file');

  const adminGlobalOverride = virtualFs.writeFile('/system_policy.json', JSON.stringify({ lockdown: true }), {
    workspaceId: 'global',
    callerAgentId: 'director_agent',
    callerRole: 'admin',
    isAdmin: true,
    privileged: true
  });
  assert(adminGlobalOverride.success === true, 'Admin agent can overwrite read-only global file');

  // --- SECTION 8: Wave U File Plumbing (ticket 36f2763) ---
  console.log('\n--- 8. Wave U File Plumbing: file-sourced params + concat_files ---');
  const writeFileSchema = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.WRITE_FILE);
  assert(writeFileSchema.function.parameters.properties.source_file?.type === 'string', "write_file schema exposes 'source_file'");
  assert(writeFileSchema.function.parameters.properties.append?.type === 'boolean', "write_file schema exposes 'append'");
  assert(
    JSON.stringify([...writeFileSchema.function.parameters.required]) === JSON.stringify(['file_path']),
    'write_file requires only file_path (content/source_file form the oneOf alternatives)'
  );

  const replaceSchemaPlumbing = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.REPLACE_FILE_CONTENT);
  assert(replaceSchemaPlumbing.function.parameters.properties.replacement_source_file?.type === 'string', "replace_file_content schema exposes 'replacement_source_file'");
  assert(
    JSON.stringify([...replaceSchemaPlumbing.function.parameters.required]) === JSON.stringify(['file_path', 'target_content']),
    'replace_file_content drops replacement_content from required'
  );

  const writeJsonSchemaPlumbing = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.WRITE_JSON);
  assert(writeJsonSchemaPlumbing.function.parameters.properties.data_source_file?.type === 'string', "write_json schema exposes 'data_source_file'");
  assert(
    JSON.stringify([...writeJsonSchemaPlumbing.function.parameters.required]) === JSON.stringify(['file_path']),
    'write_json drops data from required'
  );

  const queryJsonSchemaPlumbing = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.QUERY_JSON);
  assert(queryJsonSchemaPlumbing.function.parameters.properties.output_file?.type === 'string', "query_json schema exposes 'output_file'");

  const jsonPatchSchemaPlumbing = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.JSON_PATCH);
  assert(jsonPatchSchemaPlumbing.function.parameters.properties.patch.items.properties.value_file?.type === 'string', "json_patch items expose 'value_file'");

  const concatSchema = allSchemas.find(s => s.function.name === SANDBOX_TOOLS.CONCAT_FILES);
  assert(concatSchema, 'concat_files is present in the schema surface');
  assert(concatSchema.function.parameters.properties.sources?.type === 'array', "concat_files schema exposes a 'sources' array");
  assert(concatSchema.function.parameters.properties.destination?.type === 'string', "concat_files schema exposes 'destination'");
  assert(concatSchema.function.parameters.properties.separator?.type === 'string', "concat_files schema exposes 'separator'");
  assert(
    JSON.stringify([...concatSchema.function.parameters.required]) === JSON.stringify(['sources', 'destination']),
    'concat_files requires sources and destination'
  );
  assert(concatSchema.function.parameters.additionalProperties === false, 'concat_files schema is closed');

  // Closed Draft-07 descriptor schemas carry the inline/file mutual exclusion.
  const registryDescriptors = Object.fromEntries(ALL_TOOL_DESCRIPTORS.map(d => [d.name, d]));
  for (const name of ['write_file', 'replace_file_content', 'write_json']) {
    const oneOf = registryDescriptors[name]?.schema?.oneOf;
    assert(Array.isArray(oneOf) && oneOf.length === 2, `descriptor '${name}' declares the inline/file oneOf`);
    assert(registryDescriptors[name].schema.additionalProperties === false, `descriptor '${name}' is closed`);
  }
  assert(registryDescriptors.json_patch.schema.properties.patch.items.additionalProperties === false, 'json_patch operation items are closed');
  assert(registryDescriptors.concat_files.schema.additionalProperties === false, 'concat_files descriptor is closed');

  // End-to-end dispatcher coverage for every new param.
  const plumbingWrite = await fullDispatcher.executeTool('write_file', { file_path: '/plumbing/src.txt', content: 'SRC-BYTES' });
  assert(plumbingWrite.success === true, 'write_file seeds the source file');
  const plumbingCopy = await fullDispatcher.executeTool('write_file', { file_path: '/plumbing/copy.txt', source_file: '/plumbing/src.txt' });
  assert(plumbingCopy.success === true && plumbingCopy.size === 9, 'write_file source_file copies the source bytes');
  const plumbingAppend = await fullDispatcher.executeTool('write_file', { file_path: '/plumbing/copy.txt', content: '!', append: true });
  assert(plumbingAppend.success === true, 'write_file append succeeds');
  const copiedRead = await fullDispatcher.executeTool('read_file', { file_path: '/plumbing/copy.txt' });
  assert(copiedRead.success === true && copiedRead.content === 'SRC-BYTES!', 'append produced the concatenated content');

  const plumbingMixed = await fullDispatcher.executeTool('write_file', { file_path: '/plumbing/mixed.txt', content: 'x', source_file: '/plumbing/src.txt' });
  assert(plumbingMixed.success === false && plumbingMixed.code === 'INVALID_ARGUMENTS', 'inline + source_file fails INVALID_ARGUMENTS');

  const plumbingReplace = await fullDispatcher.executeTool('replace_file_content', {
    file_path: '/plumbing/copy.txt',
    target_content: 'SRC-BYTES',
    replacement_source_file: '/plumbing/src.txt'
  });
  assert(plumbingReplace.success === true, 'replace_file_content accepts replacement_source_file');

  const plumbingJson = await fullDispatcher.executeTool('write_json', { file_path: '/plumbing/value.json', data: { nested: true } });
  assert(plumbingJson.success === true, 'write_json seeds the JSON source');
  const plumbingJsonCopy = await fullDispatcher.executeTool('write_json', { file_path: '/plumbing/copied.json', data_source_file: '/plumbing/value.json' });
  assert(plumbingJsonCopy.success === true, 'write_json accepts data_source_file');
  const plumbingPatch = await fullDispatcher.executeTool('json_patch', {
    file_path: '/plumbing/copied.json',
    patch: [{ op: 'add', path: '/added', value_file: '/plumbing/value.json' }]
  });
  assert(plumbingPatch.success === true, 'json_patch accepts per-op value_file');
  const patched = await fullDispatcher.executeTool('query_json', { file_path: '/plumbing/copied.json', query: '.added' });
  assert(patched.success === true && patched.nested === true, 'value_file payload was applied');

  const extracted = await fullDispatcher.executeTool('query_json', { file_path: '/plumbing/copied.json', query: '.', output_file: '/plumbing/extract.json' });
  assert(extracted.success === true && extracted.output_file === '/plumbing/extract.json', 'query_json accepts output_file and returns the receipt');
  const extractedRead = await fullDispatcher.executeTool('read_file', { file_path: '/plumbing/extract.json' });
  assert(extractedRead.success === true && JSON.parse(extractedRead.content).added.nested === true, 'the extracted file carries the full result');

  const concatenated = await fullDispatcher.executeTool('concat_files', {
    sources: ['/plumbing/src.txt', '/plumbing/src.txt'],
    destination: '/plumbing/joined.txt',
    separator: '|'
  });
  assert(concatenated.success === true && concatenated.source_count === 2, 'concat_files joins the requested sources');
  const joinedRead = await fullDispatcher.executeTool('read_file', { file_path: '/plumbing/joined.txt' });
  assert(joinedRead.success === true && joinedRead.content === 'SRC-BYTES|SRC-BYTES', 'concat_files honors the separator');

  // Peer scoping through the dispatcher: the same read ACL that guards read_file.
  const bobPlumbingDispatcher = createSandboxToolDispatcher({
    virtualFs,
    messagingBus,
    worldClock,
    agentId: 'agent_bob',
    allowedTools: ['read_file', 'write_file', 'concat_files']
  });
  const peerSource = await bobPlumbingDispatcher.executeTool('write_file', {
    file_path: '/stolen.txt',
    source_file: '/agents/agent_alice/secret.txt'
  });
  assert(peerSource.success === false && peerSource.code === 'PERMISSION_DENIED', 'a peer private-workspace source is denied for concat/write plumbing');
  const bobPeerRead = await bobPlumbingDispatcher.executeTool('read_file', { file_path: '/agents/agent_alice/secret.txt' });
  assert(bobPeerRead.success === false && bobPeerRead.code === 'PERMISSION_DENIED', 'the same reference is denied through read_file');
  const bobAbsent = await bobPlumbingDispatcher.executeTool('read_file', { file_path: '/stolen.txt' });
  assert(bobAbsent.success === false, 'the denied plumbing write created no destination');

  // --- SECTION 9: Wave U publishing descriptors (ticket 2518510) ---
  console.log('\n--- 9. Wave U Publishing Meta-Tool Descriptors & Schema Exposure ---');
  assert(Object.isFrozen(PUBLISHING_TOOL_REGISTRY), 'PUBLISHING_TOOL_REGISTRY is frozen');
  assert(
    Object.keys(PUBLISHING_TOOL_REGISTRY).length === 2,
    'the publishing registry carries exactly the two meta tools'
  );
  assert(ALL_TOOL_DESCRIPTORS.length === 35, 'publishing tools stay outside the 35-tool canonical catalog');
  assert(
    !Object.values(PUBLISHING_TOOLS).some((name) => Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)),
    'publishing tools are absent from TOOL_REGISTRY'
  );
  assert(
    getSandboxToolsSchema('all').every((def) => !Object.values(PUBLISHING_TOOLS).includes(def.function.name)),
    'wildcard schema generation never exposes publishing tools'
  );
  assert(
    getPublishingToolSchemas(['*']).length === 0,
    'wildcard is not an authority and exposes no publishing schema'
  );
  assert(
    getPublishingToolSchemas([AGENT_AUTHORITIES.TEMPLATE]).length === 1
      && getPublishingToolSchemas([AGENT_AUTHORITIES.TEMPLATE])[0].function.name === PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
    'the template authority exposes only import_realm_template'
  );
  assert(
    getPublishingToolSchemas([AGENT_AUTHORITIES.HYDRATION]).length === 1
      && getPublishingToolSchemas([AGENT_AUTHORITIES.HYDRATION])[0].function.name === PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
    'the hydration authority exposes only submit_hydration_package'
  );
  for (const descriptor of Object.values(PUBLISHING_TOOL_REGISTRY)) {
    assert(descriptor.schema.type === 'object', `${descriptor.name} schema is an object`);
    assert(descriptor.schema.additionalProperties === false, `${descriptor.name} schema is closed`);
    for (const [propertyName, property] of Object.entries(descriptor.schema.properties)) {
      assert(typeof property.type === 'string', `${descriptor.name}.${propertyName} declares a Draft-07 type`);
      assert(typeof property.description === 'string', `${descriptor.name}.${propertyName} documents the parameter`);
    }
    assert(
      Array.isArray(descriptor.schema.oneOf) && descriptor.schema.oneOf.length === 2,
      `${descriptor.name} enforces exactly one manifest form`
    );
    const exposed = getPublishingToolSchemas([descriptor.authority]);
    assert(exposed.length === 1, `${descriptor.name} is exposed for its exact authority`);
    assert(exposed[0].function.description.length > 0, `${descriptor.name} exposes a non-empty description`);
    assert(exposed[0].function.parameters.additionalProperties === false, `${descriptor.name} exposed schema is closed`);
  }

  console.log('\n======================================================================');
  console.log(`  EPIC 6 UNIT TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runEpic6UnitTests().catch(err => {
  console.error('Test runner encountered fatal error:', err);
  process.exit(1);
});
