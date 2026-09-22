/**
 * Tests for Tool Response Compaction and Context Hygiene in src/lib/sandbox/runtime/messageHygiene/
 *
 * Verifies:
 * 1. Active turn tool calls retain 100% full uncompacted content.
 * 2. Historical turns compact all 8 specialized tools:
 *    - virtualFs_readFile (and aliases)
 *    - virtualFs_queryJson (and aliases)
 *    - virtualFs_grep (and aliases)
 *    - virtualFs_listFiles (and aliases)
 *    - runtime_listAgents (and aliases)
 *    - runtime_undoTurn (and aliases)
 *    - system_describeTool (and aliases)
 *    - event_list (and aliases)
 * 3. Generic large fallback (> 500 bytes) compacts JSON and plain text, leaving <= 500 bytes intact.
 * 4. Message passing tools are strictly EXCLUDED from compaction regardless of payload size or turn history.
 * 5. Input arrays and message objects are never mutated in-place (deep frozen input immutability).
 * 6. options.compactHistoricalTools = false disables historical tool compaction.
 * 7. Pure function compactHistoricalToolContent behaves identically when invoked directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMessagesWithToolHygiene,
  compactHistoricalToolContent,
  normalizeToolName,
  HISTORICAL_TOOL_ALIASES,
  MESSAGE_PASSING_EXCLUSIONS
} from '../../src/lib/sandbox/runtime/messageHygiene/index.ts';

test('1. Active turn tool calls retain 100% full uncompacted content', () => {
  const largeContent = 'X'.repeat(5000);
  const readFilePayload = JSON.stringify({
    success: true,
    filePath: '/active_turn.txt',
    workspaceId: 'global',
    totalBytes: 5000,
    totalLines: 100,
    totalWords: 800,
    content: largeContent
  });

  const queryJsonPayload = JSON.stringify({
    success: true,
    filePath: '/data.json',
    query: '$.records',
    result: Array.from({ length: 100 }, (_, i) => ({ id: i, payload: 'large_data_' + i }))
  });

  const messages = [
    { role: 'user', content: 'Run active operations' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_rf_1', type: 'function', function: { name: 'read_file', arguments: '{"filePath":"/active_turn.txt"}' } },
        { id: 'call_qj_1', type: 'function', function: { name: 'query_json', arguments: '{"filePath":"/data.json"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_rf_1', name: 'read_file', content: readFilePayload },
    { role: 'tool', tool_call_id: 'call_qj_1', name: 'query_json', content: queryJsonPayload }
  ];

  const formatted = formatMessagesWithToolHygiene(messages);

  assert.equal(formatted.length, 4);
  // Tool 1: full read_file output retained verbatim
  assert.equal(formatted[2].content, readFilePayload);
  const parsed1 = JSON.parse(formatted[2].content);
  assert.equal(parsed1.compacted, undefined);
  assert.equal(parsed1.content, largeContent);

  // Tool 2: full query_json output retained verbatim
  assert.equal(formatted[3].content, queryJsonPayload);
  const parsed2 = JSON.parse(formatted[3].content);
  assert.equal(parsed2.compacted, undefined);
  assert.equal(parsed2.result.length, 100);
});

test('2. Historical turns compact all 8 specialized tools', () => {
  // Turn 1: 8 specialized tool calls
  const fullReadFile = JSON.stringify({
    success: true,
    filePath: '/history/report.txt',
    workspaceId: 'agent_alpha',
    totalBytes: 25000,
    totalLines: 500,
    totalWords: 3500,
    content: 'Lorem ipsum '.repeat(300)
  });

  const fullQueryJson = JSON.stringify({
    success: true,
    filePath: '/history/db.json',
    query: '$.users',
    result: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Charlie' }
    ]
  });

  const fullGrep = JSON.stringify({
    success: true,
    workspaceId: 'global',
    pattern: 'secret_token',
    count: 4,
    matches: [
      { filePath: '/auth.js', lineNumber: 42, lineContent: 'const secret_token = "abc";' },
      { filePath: '/auth.js', lineNumber: 99, lineContent: 'verify(secret_token);' },
      { filePath: '/config.js', lineNumber: 12, lineContent: 'export const secret_token = env;' },
      { filePath: '/env.sh', lineNumber: 1, lineContent: 'secret_token=123' }
    ]
  });

  const fullListFiles = JSON.stringify({
    success: true,
    workspaceId: 'agent_alpha',
    dirPath: '/docs',
    count: 3,
    files: [
      { path: '/docs/a.md', size: 1000, updatedAt: 100, readOnly: false },
      { path: '/docs/b.md', size: 2000, updatedAt: 200, readOnly: true },
      { path: '/docs/c.md', size: 3000, updatedAt: 300, readOnly: false }
    ]
  });

  const fullListAgents = JSON.stringify({
    success: true,
    count: 2,
    agents: [
      { id: 'ag_1', name: 'Scout', role: 'worker', status: 'idle', allowedTools: ['read_file', 'write_file', 'grep', 'list_files'] },
      { id: 'ag_2', name: 'Architect', role: 'admin', status: 'busy', allowedTools: ['all'] }
    ]
  });

  const fullUndoTurn = JSON.stringify({
    success: true,
    agentId: 'ag_1',
    removedMessagesCount: 2,
    undoneUserContent: 'Please delete the database',
    undoneAssistantContent: 'Database deleted.',
    message: 'Successfully undid turn for agent ag_1'
  });

  const fullDescribeTool = JSON.stringify({
    success: true,
    toolName: 'virtualFs_readFile',
    description: 'Read file with pagination slicing and budget controls',
    parameters: { filePath: { type: 'string' }, budgetBytes: { type: 'number' } },
    parametersSchema: { type: 'object', properties: {} },
    returns: { type: 'object' },
    examples: ['virtualFs_readFile({ filePath: "/a.txt" })']
  });

  const fullEventList = JSON.stringify({
    success: true,
    count: 3,
    activeCount: 2,
    pendingCount: 0,
    resolvedCount: 1,
    events: [
      { id: 'evt_1', name: 'Eclipse', status: 'active' },
      { id: 'evt_2', name: 'Comet', status: 'active' },
      { id: 'evt_3', name: 'Solstice', status: 'resolved' }
    ],
    activeEvents: [
      { id: 'evt_1', name: 'Eclipse' },
      { id: 'evt_2', name: 'Comet' }
    ]
  });

  const history = [
    { role: 'user', content: 'Turn 1: execute all 8 tools' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_rf', type: 'function', function: { name: 'fs_readFile', arguments: '{}' } },
        { id: 'call_qj', type: 'function', function: { name: 'fs_queryJson', arguments: '{}' } },
        { id: 'call_gr', type: 'function', function: { name: 'grep', arguments: '{}' } },
        { id: 'call_lf', type: 'function', function: { name: 'list_files', arguments: '{}' } },
        { id: 'call_la', type: 'function', function: { name: 'list_agents', arguments: '{}' } },
        { id: 'call_ut', type: 'function', function: { name: 'undo_turn', arguments: '{}' } },
        { id: 'call_dt', type: 'function', function: { name: 'describe_tool', arguments: '{}' } },
        { id: 'call_el', type: 'function', function: { name: 'events', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_rf', name: 'fs_readFile', content: fullReadFile },
    { role: 'tool', tool_call_id: 'call_qj', name: 'fs_queryJson', content: fullQueryJson },
    { role: 'tool', tool_call_id: 'call_gr', name: 'grep', content: fullGrep },
    { role: 'tool', tool_call_id: 'call_lf', name: 'list_files', content: fullListFiles },
    { role: 'tool', tool_call_id: 'call_la', name: 'list_agents', content: fullListAgents },
    { role: 'tool', tool_call_id: 'call_ut', name: 'undo_turn', content: fullUndoTurn },
    { role: 'tool', tool_call_id: 'call_dt', name: 'describe_tool', content: fullDescribeTool },
    { role: 'tool', tool_call_id: 'call_el', name: 'events', content: fullEventList },
    { role: 'assistant', content: 'Turn 1 finished.' },
    // Turn 2: triggers subsequent turn check
    { role: 'user', content: 'Turn 2: now check history compaction' }
  ];

  const formatted = formatMessagesWithToolHygiene(history);

  // Find compacted tool messages
  const toolMsg = (callId) => formatted.find(m => m.role === 'tool' && m.tool_call_id === callId);

  // 1. virtualFs_readFile is evicted in historical turns into an explicit tombstone
  const rf = JSON.parse(toolMsg('call_rf').content);
  assert.equal(rf.compacted, true);
  assert.equal(rf.status, 'evicted_from_history');
  assert.equal(rf.preview, undefined, 'Evicted tool output MUST NEVER contain a preview field');
  assert.ok(rf.notice.includes('evicted from conversation history'));
  assert.equal(rf.filePath, '/history/report.txt');
  assert.equal(rf.workspaceId, 'agent_alpha');
  assert.equal(rf.totalBytes, 25000);
  assert.equal(rf.totalLines, 500);
  assert.equal(rf.totalWords, 3500);
  assert.equal(rf.content, undefined);

  // 2. virtualFs_queryJson compaction verification
  const qj = JSON.parse(toolMsg('call_qj').content);
  assert.equal(qj.compacted, true);
  assert.equal(qj.filePath, '/history/db.json');
  assert.equal(qj.query, '$.users');
  assert.equal(qj.resultType, 'array');
  assert.equal(qj.count, 3);
  assert.equal(qj.result, undefined);

  // 3. virtualFs_grep compaction verification
  const gr = JSON.parse(toolMsg('call_gr').content);
  assert.equal(gr.compacted, true);
  assert.equal(gr.workspaceId, 'global');
  assert.equal(gr.pattern, 'secret_token');
  assert.equal(gr.count, 4);
  assert.deepEqual(gr.filesMatched, ['/auth.js', '/config.js', '/env.sh']);
  assert.equal(gr.sampleMatches.length, 3);
  assert.deepEqual(gr.sampleMatches[0], { filePath: '/auth.js', lineNumber: 42 });
  assert.equal(gr.matches, undefined);

  // 4. virtualFs_listFiles compaction verification
  const lf = JSON.parse(toolMsg('call_lf').content);
  assert.equal(lf.compacted, true);
  assert.equal(lf.workspaceId, 'agent_alpha');
  assert.equal(lf.dirPath, '/docs');
  assert.equal(lf.count, 3);
  assert.deepEqual(lf.filePaths, ['/docs/a.md', '/docs/b.md', '/docs/c.md']);
  assert.equal(lf.files, undefined);

  // 5. runtime_listAgents compaction verification
  const la = JSON.parse(toolMsg('call_la').content);
  assert.equal(la.compacted, true);
  assert.equal(la.count, 2);
  assert.deepEqual(la.agents, [
    { id: 'ag_1', name: 'Scout', role: 'worker', status: 'idle' },
    { id: 'ag_2', name: 'Architect', role: 'admin', status: 'busy' }
  ]);
  assert.equal(la.agents[0].allowedTools, undefined);

  // 6. runtime_undoTurn compaction verification
  const ut = JSON.parse(toolMsg('call_ut').content);
  assert.equal(ut.compacted, true);
  assert.equal(ut.agentId, 'ag_1');
  assert.equal(ut.removedMessagesCount, 2);
  assert.equal(ut.message, 'Successfully undid turn for agent ag_1');
  assert.equal(ut.undoneUserContent, undefined);
  assert.equal(ut.undoneAssistantContent, undefined);

  // 7. system_describeTool compaction verification
  const dt = JSON.parse(toolMsg('call_dt').content);
  assert.equal(dt.compacted, true);
  assert.equal(dt.toolName, 'virtualFs_readFile');
  assert.equal(dt.description, 'Read file with pagination slicing and budget controls');
  assert.equal(dt.parameters, undefined);
  assert.equal(dt.parametersSchema, undefined);
  assert.equal(dt.returns, undefined);
  assert.equal(dt.examples, undefined);

  // 8. event_list compaction verification
  const el = JSON.parse(toolMsg('call_el').content);
  assert.equal(el.compacted, true);
  assert.equal(el.count, 3);
  assert.equal(el.activeCount, 2);
  assert.equal(el.pendingCount, 0);
  assert.equal(el.resolvedCount, 1);
  assert.deepEqual(el.eventIds, ['evt_1', 'evt_2', 'evt_3']);
  assert.equal(el.events, undefined);
  assert.equal(el.activeEvents, undefined);
});

test('3. Generic large fallback (> 500 bytes) compacts JSON and plain text, leaving <= 500 intact', () => {
  const largeJson = JSON.stringify({
    success: true,
    arbitraryLargeField: 'Z'.repeat(1200)
  });

  const largeString = 'Unstructured log stream: ' + 'LOG_ENTRY_ABC123 '.repeat(60);
  const smallString = 'Quick status: all systems normal.';

  const history = [
    { role: 'user', content: 'Execute custom diagnostics' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_large_json', type: 'function', function: { name: 'custom_diagnostics', arguments: '{}' } },
        { id: 'call_large_str', type: 'function', function: { name: 'raw_log_dump', arguments: '{}' } },
        { id: 'call_small_str', type: 'function', function: { name: 'health_ping', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_large_json', name: 'custom_diagnostics', content: largeJson },
    { role: 'tool', tool_call_id: 'call_large_str', name: 'raw_log_dump', content: largeString },
    { role: 'tool', tool_call_id: 'call_small_str', name: 'health_ping', content: smallString },
    { role: 'assistant', content: 'Turn complete' },
    { role: 'user', content: 'Next question' }
  ];

  const formatted = formatMessagesWithToolHygiene(history);

  const jsonMsg = formatted.find(m => m.tool_call_id === 'call_large_json');
  const parsedJson = JSON.parse(jsonMsg.content);
  assert.equal(parsedJson.compacted, true);
  assert.ok(parsedJson.notice.includes('evicted from conversation history'));
  assert.equal(parsedJson.status, 'evicted_from_history');
  assert.equal(parsedJson.preview, undefined, 'Generic fallback MUST NEVER include a preview property');

  const strMsg = formatted.find(m => m.tool_call_id === 'call_large_str');
  assert.ok(strMsg.content.includes('[Historical output evicted:'));

  const smallMsg = formatted.find(m => m.tool_call_id === 'call_small_str');
  assert.equal(smallMsg.content, smallString, 'Small outputs <= 500 bytes remain completely uncompacted');
});

test('4. Mutation and invocation tools are strictly EXCLUDED from compaction', () => {
  const preservedTools = [
    // File modification
    'virtualFs_writeFile',
    'fs_writeFile',
    'write_file',
    'writeFile',
    'virtualFs_replaceFileContent',
    'replace_file_content',
    'virtualFs_copyFile',
    'copy_file',
    'virtualFs_writeJson',
    'write_json',
    'virtualFs_jsonPatch',
    'json_patch',
    // Invocations
    'runtime_invokeAgent',
    'runtimeInvokeAgent',
    'invoke_agent',
    'invokeAgent',
    'runtime_waitForInvocation',
    'runtimeWaitForInvocation',
    'wait_for_invocation',
    'waitForInvocation',
    'runtime_spawnAgent',
    'spawn_agent',
    'runtime_killAgent',
    'kill_agent',
    // Messaging send receipts
    'messaging_sendMessage',
    'msg_send',
    'send_message',
    'sendMessage',
    'messaging_inlineFileInMessage',
    'inline_file_in_message',
    'inlineFileInMessage'
  ];

  for (const toolName of preservedTools) {
    const hugePayload = JSON.stringify({
      success: true,
      status: 'executed',
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `item_${i}`,
        body: 'Important payload '.repeat(20)
      }))
    });

    // Both direct function invocation and historical turn history must NEVER compact preserved tools
    const directResult = compactHistoricalToolContent(toolName, hugePayload);
    assert.equal(directResult, hugePayload, `compactHistoricalToolContent must not alter ${toolName}`);

    const history = [
      { role: 'user', content: `Run ${toolName}` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_msg', type: 'function', function: { name: toolName, arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call_msg', name: toolName, content: hugePayload },
      { role: 'assistant', content: 'Got output' },
      { role: 'user', content: 'Proceed with next phase' }
    ];

    const formatted = formatMessagesWithToolHygiene(history);
    const toolReceipt = formatted.find(m => m.tool_call_id === 'call_msg');
    assert.equal(toolReceipt.content, hugePayload, `formatMessagesWithToolHygiene must preserve full uncompacted receipt for ${toolName}`);
  }
});

test('5. Input arrays and message objects are never mutated in-place (deep frozen immutability)', () => {
  const originalListFiles = JSON.stringify({
    success: true,
    workspaceId: 'global',
    dirPath: '/frozen',
    count: 2,
    files: [
      { path: '/frozen/a.txt', size: 100 },
      { path: '/frozen/b.txt', size: 200 }
    ]
  });

  const rawHistory = [
    { role: 'user', content: 'List files' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_frozen', type: 'function', function: { name: 'list_files', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_frozen', name: 'list_files', content: originalListFiles },
    { role: 'assistant', content: 'Turn 1 complete' },
    { role: 'user', content: 'Turn 2' }
  ];

  // Deep freeze all objects in input array
  function deepFreeze(obj) {
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object' && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
    return obj;
  }

  deepFreeze(rawHistory);

  // Executing formatMessagesWithToolHygiene on frozen input must NOT throw TypeError
  assert.doesNotThrow(() => {
    const formatted = formatMessagesWithToolHygiene(rawHistory);
    assert.equal(formatted.length, 5);
    // Formatted output tool message is compacted
    const compacted = JSON.parse(formatted[2].content);
    assert.equal(compacted.compacted, true);
    // Original input remains completely intact and unmutated
    assert.equal(rawHistory[2].content, originalListFiles);
  });
});

test('6. options.compactHistoricalTools = false disables compaction', () => {
  const fullContent = JSON.stringify({
    success: true,
    dirPath: '/docs',
    workspaceId: 'global',
    count: 3,
    files: [
      { path: '/docs/1.txt', size: 100 },
      { path: '/docs/2.txt', size: 200 },
      { path: '/docs/3.txt', size: 300 }
    ]
  });

  const history = [
    { role: 'user', content: 'List files' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_list', type: 'function', function: { name: 'list_files', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_list', name: 'list_files', content: fullContent },
    { role: 'assistant', content: 'Files listed' },
    { role: 'user', content: 'Next turn' }
  ];

  const formatted = formatMessagesWithToolHygiene(history, { compactHistoricalTools: false });
  const toolMsg = formatted.find(m => m.tool_call_id === 'call_list');
  assert.equal(toolMsg.content, fullContent, 'When compactHistoricalTools is false, historical tool content is untouched');
});

test('7. Tool name resolution and tool call id mapping without name attribute on tool message', () => {
  // When role: 'tool' message omits the 'name' field, the formatter resolves tool name from the assistant tool_calls mapping
  const listFilesPayload = JSON.stringify({
    success: true,
    workspaceId: 'global',
    dirPath: '/notes',
    count: 2,
    files: [
      { path: '/notes/a.md', size: 500 },
      { path: '/notes/b.md', size: 600 }
    ]
  });

  const history = [
    { role: 'user', content: 'List notes' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_lookup_1', type: 'function', function: { name: 'list_files', arguments: '{"dirPath":"/notes"}' } }
      ]
    },
    // Note: no 'name' property on this tool message, only tool_call_id
    { role: 'tool', tool_call_id: 'call_lookup_1', content: listFilesPayload },
    { role: 'assistant', content: 'Notes listed successfully' },
    { role: 'user', content: 'What next?' }
  ];

  const formatted = formatMessagesWithToolHygiene(history);
  const toolMsg = formatted.find(m => m.tool_call_id === 'call_lookup_1');
  const parsed = JSON.parse(toolMsg.content);
  assert.equal(parsed.compacted, true, 'Correctly compacted list_files via assistant tool_calls name mapping');
  assert.equal(parsed.dirPath, '/notes');
});

test('8. Pure function compactHistoricalToolContent edge cases & idempotence', () => {
  // Edge case: null, undefined, non-JSON strings
  assert.equal(compactHistoricalToolContent('list_files', null), null);
  assert.equal(compactHistoricalToolContent('list_files', undefined), undefined);
  assert.equal(compactHistoricalToolContent('list_files', 'Not JSON'), 'Not JSON');

  // Idempotence: passing an already compacted JSON string
  const alreadyCompacted = JSON.stringify({ success: true, compacted: true, dirPath: '/a' });
  assert.equal(compactHistoricalToolContent('list_files', alreadyCompacted), alreadyCompacted);

  // Object result queryJson
  const objQueryResult = JSON.stringify({
    success: true,
    filePath: '/settings.json',
    filter: '$.config',
    result: { k1: 'v1', k2: 'v2', k3: 'v3' }
  });
  const compactedObj = JSON.parse(compactHistoricalToolContent('query_json', objQueryResult));
  assert.equal(compactedObj.compacted, true);
  assert.equal(compactedObj.resultType, 'object');
  assert.equal(compactedObj.keyCount, 3);
  assert.deepEqual(compactedObj.keys, ['k1', 'k2', 'k3']);
});

test('9. metadata.reasoning_content fallback is normalized to a string (INV-REASONING-STRING)', () => {
  // No top-level reasoning_content/reasoning/thought: the only source is metadata.
  // A non-string metadata value must still be emitted as a string, never raw.
  const formatted = formatMessagesWithToolHygiene([
    { role: 'assistant', content: 'Final answer', metadata: { reasoning_content: 42 } }
  ]);

  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].role, 'assistant');
  assert.equal(typeof formatted[0].reasoning_content, 'string');
  assert.equal(formatted[0].reasoning_content, '42');
});
