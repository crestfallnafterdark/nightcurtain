/**
 * Historical tool-receipt compaction and tool-name canonicalization for provider payloads.
 * Relocated from the legacy `api/hygiene/toolCompactor.js` compaction closure; the legacy
 * streaming accumulator stays in the legacy module until the legacy path is deleted.
 */

/**
 * Canonical tool names keyed by every accepted historical alias.
 */
export const HISTORICAL_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // virtualFs_readFile
  'virtualFs_readFile': 'virtualFs_readFile',
  'fs_readFile': 'virtualFs_readFile',
  'read_file': 'virtualFs_readFile',
  'readFile': 'virtualFs_readFile',

  // virtualFs_queryJson
  'virtualFs_queryJson': 'virtualFs_queryJson',
  'fs_queryJson': 'virtualFs_queryJson',
  'query_json': 'virtualFs_queryJson',
  'queryJson': 'virtualFs_queryJson',

  // virtualFs_grep
  'virtualFs_grep': 'virtualFs_grep',
  'fs_grep': 'virtualFs_grep',
  'grep_search': 'virtualFs_grep',
  'grep': 'virtualFs_grep',

  // virtualFs_listFiles
  'virtualFs_listFiles': 'virtualFs_listFiles',
  'fs_listFiles': 'virtualFs_listFiles',
  'list_files': 'virtualFs_listFiles',
  'listFiles': 'virtualFs_listFiles',
  'list_dir': 'virtualFs_listFiles',
  'listDir': 'virtualFs_listFiles',
  'fs_listDir': 'virtualFs_listFiles',

  // runtime_listAgents
  'runtime_listAgents': 'runtime_listAgents',
  'list_agents': 'runtime_listAgents',
  'listAgents': 'runtime_listAgents',

  // runtime_undoTurn
  'runtime_undoTurn': 'runtime_undoTurn',
  'runtime_undo_turn': 'runtime_undoTurn',
  'undo_turn': 'runtime_undoTurn',
  'undoTurn': 'runtime_undoTurn',
  'runtimeUndoTurn': 'runtime_undoTurn',

  // system_describeTool
  'system_describeTool': 'system_describeTool',
  'describe_tool': 'system_describeTool',
  'describeTool': 'system_describeTool',
  'systemDescribeTool': 'system_describeTool',

  // event_list
  'event_list': 'event_list',
  'eventList': 'event_list',
  'events': 'event_list',
  'list_events': 'event_list',
  'listEvents': 'event_list',
  'world_events': 'event_list',
  'worldEvents': 'event_list',

  // Mailbox & messaging tools
  'messaging_readMessage': 'messaging_readMessage',
  'msg_readMessage': 'messaging_readMessage',
  'read_message': 'messaging_readMessage',
  'readMessage': 'messaging_readMessage',
  'msg_read': 'messaging_readMessage',
  'messaging_read': 'messaging_readMessage',
  'read_mail': 'messaging_readMessage',
  'readMail': 'messaging_readMessage',
  'get_message': 'messaging_readMessage',
  'getMessage': 'messaging_readMessage',
  'fetch_message': 'messaging_readMessage',
  'fetchMessage': 'messaging_readMessage',
  'fetch_read_message': 'messaging_readMessage',

  // messaging_getArchive
  'messaging_getArchive': 'messaging_getArchive',
  'msg_getArchive': 'messaging_getArchive',
  'get_archive': 'messaging_getArchive',
  'getArchive': 'messaging_getArchive',
  'list_archive': 'messaging_getArchive',
  'listArchive': 'messaging_getArchive',
  'get_history': 'messaging_getArchive',
  'getHistory': 'messaging_getArchive',
  'get_read_mail': 'messaging_getArchive',
  'getReadMail': 'messaging_getArchive',
  'list_read_mail': 'messaging_getArchive',
  'listReadMail': 'messaging_getArchive',
  'read_archive': 'messaging_getArchive',
  'readArchive': 'messaging_getArchive',

  // messaging_getInbox
  'messaging_getInbox': 'messaging_getInbox',
  'msg_getInbox': 'messaging_getInbox',
  'get_inbox': 'messaging_getInbox',
  'getInbox': 'messaging_getInbox',

  // messaging_drainInbox
  'messaging_drainInbox': 'messaging_drainInbox',
  'msg_drainInbox': 'messaging_drainInbox',
  'drain_inbox': 'messaging_drainInbox',
  'drainInbox': 'messaging_drainInbox',

  // messaging_listInbox
  'messaging_listInbox': 'messaging_listInbox',
  'msg_listInbox': 'messaging_listInbox',
  'list_inbox': 'messaging_listInbox',
  'listInbox': 'messaging_listInbox',
  'get_inbox_headers': 'messaging_listInbox',
  'getInboxHeaders': 'messaging_listInbox',

  // runtime_waitForMail
  'runtime_waitForMail': 'runtime_waitForMail',
  'runtimeWaitForMail': 'runtime_waitForMail',
  'wait_for_mail': 'runtime_waitForMail',
  'waitForMail': 'runtime_waitForMail',
  'wait_mail': 'runtime_waitForMail',
  'waitMail': 'runtime_waitForMail',
  'wait_for_messages': 'runtime_waitForMail',
  'waitForMessages': 'runtime_waitForMail',
  'wait_messages': 'runtime_waitForMail',
  'waitMessages': 'runtime_waitForMail'
});

/**
 * Message Passing Tools Exclusion List (NEVER compacted).
 */
export const MESSAGE_PASSING_EXCLUSIONS: ReadonlySet<string> = Object.freeze(new Set([
  // File modification tools
  'virtualFs_writeFile', 'fs_writeFile', 'write_file', 'writeFile',
  'virtualFs_replaceFileContent', 'fs_replaceFileContent', 'replace_file_content', 'replaceFileContent',
  'virtualFs_copyFile', 'fs_copyFile', 'copy_file', 'copyFile', 'fs_copy_file', 'cp',
  'virtualFs_setPermissions', 'fs_setPermissions', 'set_permissions', 'setPermissions', 'fs_set_permissions', 'chmod', 'fs_chmod',
  'virtualFs_deleteFile', 'fs_deleteFile', 'delete_file', 'deleteFile',
  'virtualFs_writeJson', 'fs_writeJson', 'write_json', 'writeJson',
  'virtualFs_jsonPatch', 'fs_jsonPatch', 'json_patch', 'jsonPatch', 'patch_json', 'patchJson',
  // Invocations and lifecycle tools
  'runtime_invokeAgent', 'runtimeInvokeAgent', 'invoke_agent', 'invokeAgent',
  'runtime_waitForInvocation', 'runtimeWaitForInvocation', 'wait_for_invocation', 'waitForInvocation',
  'runtime_spawnAgent', 'runtimeSpawnAgent', 'spawn_agent', 'spawnAgent',
  'runtime_killAgent', 'runtimeKillAgent', 'kill_agent', 'killAgent',
  // Message transmission tools (receipts only)
  'messaging_sendMessage', 'msg_send', 'msg_sendMessage', 'send_message', 'sendMessage',
  'messaging_inlineFileInMessage', 'inline_file_in_message', 'inlineFileInMessage',
  'messaging_inlineFile', 'inline_file', 'inlineFile',
  'messaging_sendTemplatedMessage', 'send_templated_message', 'sendTemplatedMessage',
  'template_renderPrompt', 'render_prompt', 'renderPrompt',
  'messaging_sendMessageWithFiles', 'sendMessageWithFiles'
]));

/**
 * Structural record view of an arbitrary JSON tool payload.
 */
type ToolPayload = Record<string, unknown>;

/**
 * Structural view of a message header record inside an inbox/archive payload.
 */
interface PayloadMessage {
  id?: unknown;
  messageId?: unknown;
  from?: unknown;
  to?: unknown;
  type?: unknown;
  timestamp?: unknown;
  read?: unknown;
  content?: unknown;
  snippet?: unknown;
  preview?: unknown;
  metadata?: { type?: unknown } | null;
  [key: string]: unknown;
}

/**
 * Reads an unknown value as an array of structural records, defaulting to `[]`.
 *
 * @param value - Candidate array value
 * @returns The value itself when it is an array, otherwise an empty array
 */
function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/**
 * Reads an unknown value as an array of structural message records, defaulting to `[]`.
 *
 * @param value - Candidate array value
 * @returns The value itself when it is an array, otherwise an empty array
 */
function asMessageArray(value: unknown): PayloadMessage[] {
  return Array.isArray(value) ? (value as PayloadMessage[]) : [];
}

/**
 * Normalizes a tool name or alias to its canonical sandbox tool name.
 *
 * @param name - Tool name or alias of unknown shape; non-strings resolve to `''`
 * @returns The canonical tool name, or `''` when no usable name was supplied
 */
export function normalizeToolName(name: unknown): string {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  return HISTORICAL_TOOL_ALIASES[trimmed] || trimmed;
}

/**
 * Pure compaction function for historical tool execution results.
 * Strips unbounded payloads from historical turns while preserving essential summaries and schemas.
 * Replaces past file reads with explicit eviction tombstones to save 99%+ token costs without confusing the agent.
 * Message passing and invocation tools are strictly excluded and returned unmodified.
 *
 * @param toolName - Name or alias of the tool executed
 * @param rawContent - Tool message output content of unknown shape
 * @returns Compacted JSON string, the original content when untouched, or the raw content unchanged for excluded tools
 */
export function compactHistoricalToolContent(toolName: unknown, rawContent: unknown): unknown {
  const name = String(toolName || '').trim();
  if (MESSAGE_PASSING_EXCLUSIONS.has(name)) {
    return rawContent;
  }

  const canonicalName = normalizeToolName(name);
  if (MESSAGE_PASSING_EXCLUSIONS.has(canonicalName)) {
    return rawContent;
  }

  if (rawContent === undefined || rawContent === null) {
    return rawContent;
  }

  const rawStr: string = typeof rawContent === 'string' ? rawContent : (JSON.stringify(rawContent) as string);

  let parsed: ToolPayload | null = null;
  let isJson = false;
  try {
    if (typeof rawContent === 'object' && rawContent !== null) {
      parsed = rawContent as ToolPayload;
      isJson = true;
    } else {
      const candidate: unknown = JSON.parse(rawStr);
      if (candidate !== null && typeof candidate === 'object') {
        parsed = candidate as ToolPayload;
        isJson = true;
      }
    }
  } catch (_) {
    isJson = false;
  }

  // Idempotent check: if already compacted, do not re-compact
  if (isJson && parsed && parsed.compacted === true) {
    return rawStr;
  }

  if (isJson && parsed && typeof parsed === 'object') {
    switch (canonicalName) {
      case 'virtualFs_readFile': {
        const contentStr = typeof parsed.content === 'string' ? parsed.content : '';
        const byteLen = parsed.totalBytes || parsed.total_bytes || (contentStr ? new TextEncoder().encode(contentStr).length : undefined);
        const lineLen = parsed.totalLines || parsed.total_lines || (contentStr ? contentStr.split(/\r?\n/).length : undefined);
        const wordLen = parsed.totalWords || (contentStr ? (contentStr.trim() ? contentStr.trim().split(/\s+/).filter(Boolean).length : 0) : undefined);
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: 'Full file content was delivered and processed in this turn. Raw content has been evicted from conversation history to conserve context and cost. If you need to inspect these contents again, invoke read_file again.',
          filePath: parsed.filePath,
          workspaceId: parsed.workspaceId,
          totalBytes: byteLen,
          totalLines: lineLen,
          totalWords: wordLen
        });
      }

      case 'virtualFs_queryJson': {
        const result = parsed.result;
        const isArr = Array.isArray(result);
        const resultRecord = result !== null && typeof result === 'object' && !isArr ? (result as ToolPayload) : null;
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: 'Query result was delivered in this turn and has been evicted from conversation history to conserve context. If you need the query data again, invoke query_json again.',
          filePath: parsed.filePath,
          query: parsed.query || parsed.filter || parsed.keyPath,
          resultType: isArr ? 'array' : typeof result,
          count: Array.isArray(result) ? result.length : undefined,
          keyCount: resultRecord ? Object.keys(resultRecord).length : undefined,
          keys: resultRecord ? Object.keys(resultRecord).slice(0, 10) : undefined
        });
      }

      case 'virtualFs_grep': {
        const matches = asRecordArray(parsed.matches);
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: 'Grep matches were delivered in this turn and have been compacted. If you need to search again, invoke grep again.',
          workspaceId: parsed.workspaceId,
          pattern: parsed.pattern,
          count: parsed.count,
          filesMatched: [...new Set(matches.map(m => m.filePath))],
          sampleMatches: matches.slice(0, 3).map(m => ({ filePath: m.filePath, lineNumber: m.lineNumber }))
        });
      }

      case 'virtualFs_listFiles': {
        const files = asRecordArray(parsed.files);
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: 'File list was delivered in this turn and has been compacted.',
          workspaceId: parsed.workspaceId,
          dirPath: parsed.dirPath,
          count: parsed.count !== undefined ? parsed.count : (Array.isArray(parsed.files) ? files.length : (Array.isArray(parsed) ? parsed.length : undefined)),
          filePaths: Array.isArray(parsed.files)
            ? files.map(f => f.path || f.filePath || (typeof f === 'string' ? f : undefined))
            : (Array.isArray(parsed) ? (parsed as unknown[]).map(f => (typeof f === 'string' ? f : (f as Record<string, unknown>).path || (f as Record<string, unknown>).filePath)) : [])
        });
      }

      case 'runtime_listAgents': {
        const agents = asRecordArray(parsed.agents);
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          count: parsed.count !== undefined ? parsed.count : (Array.isArray(parsed.agents) ? agents.length : undefined),
          agents: agents.map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status }))
        });
      }

      case 'runtime_undoTurn': {
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          agentId: parsed.agentId,
          removedMessagesCount: parsed.removedMessagesCount,
          message: parsed.message
        });
      }

      case 'system_describeTool': {
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          toolName: parsed.toolName,
          description: parsed.description
        });
      }

      case 'event_list': {
        const events = asRecordArray(parsed.events);
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          count: parsed.count,
          activeCount: parsed.activeCount,
          pendingCount: parsed.pendingCount,
          resolvedCount: parsed.resolvedCount,
          eventIds: events.map(e => e.id)
        });
      }

      case 'messaging_readMessage': {
        const msgObj: ToolPayload = (parsed.message !== null && typeof parsed.message === 'object') ? (parsed.message as ToolPayload) : parsed;
        const msgId = msgObj.id || msgObj.messageId || parsed.messageId || parsed.id || 'unknown';
        const from = msgObj.from || parsed.from || 'unknown';
        const to = msgObj.to || parsed.to;
        const timestamp = msgObj.timestamp || parsed.timestamp;
        const rawBody = typeof msgObj.content === 'string' ? msgObj.content : (typeof parsed.content === 'string' ? parsed.content : '');
        const wordCount = rawBody ? rawBody.trim().split(/\s+/).filter(Boolean).length : undefined;

        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: `Read message from '${String(from)}' (ID: '${String(msgId)}'). Raw content compacted to prevent context bloat. To inspect again, invoke read_message(messageId: '${String(msgId)}') or get_archive(sender: '${String(from)}').`,
          messageId: msgId,
          from,
          ...(to ? { to } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(wordCount !== undefined ? { wordsCount: wordCount } : {})
        });
      }

      case 'messaging_getArchive':
      case 'messaging_getInbox':
      case 'messaging_drainInbox':
      case 'runtime_waitForMail': {
        const rawMsgs = Array.isArray(parsed.messages)
          ? asMessageArray(parsed.messages)
          : (Array.isArray(parsed.archive) ? asMessageArray(parsed.archive) : asMessageArray(parsed));
        const compactedHeaders = rawMsgs.map(m => {
          const id = m.id || m.messageId || 'unknown';
          const from = m.from || 'unknown';
          const to = m.to;
          const timestamp = m.timestamp;
          const type = m.type || m.metadata?.type || 'message';
          const snippet = typeof m.content === 'string'
            ? (m.content.length > 60 ? m.content.slice(0, 60) + '...' : m.content)
            : (m.snippet || '...');
          return { id, messageId: id, from, ...(to ? { to } : {}), type, timestamp, snippet };
        });

        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: `Delivered ${rawMsgs.length} message(s). Raw message bodies compacted to prevent context bloat. To read full message content, invoke read_message(messageId) or get_archive(sender).`,
          count: rawMsgs.length,
          messages: compactedHeaders,
          ...(parsed.timedOut !== undefined ? { timedOut: parsed.timedOut } : {})
        });
      }

      case 'messaging_listInbox': {
        const rawMsgs = Array.isArray(parsed.headers)
          ? asMessageArray(parsed.headers)
          : asMessageArray(parsed.messages);
        return JSON.stringify({
          success: parsed.success !== false,
          compacted: true,
          status: 'evicted_from_history',
          notice: `Listed ${rawMsgs.length} inbox header(s).`,
          count: rawMsgs.length,
          headers: rawMsgs.map(m => ({
            id: m.id || m.messageId,
            messageId: m.messageId || m.id,
            from: m.from,
            to: m.to,
            timestamp: m.timestamp,
            read: m.read,
            snippet: m.snippet || m.preview
          }))
        });
      }

      default:
        break;
    }
  }

  // Generic Large Fallback:
  // For any other tool (not in exclusion list) whose rawContent.length > 500:
  if (rawStr.length > 500) {
    if (isJson && parsed && typeof parsed === 'object') {
      return JSON.stringify({
        success: parsed.success !== false,
        compacted: true,
        status: 'evicted_from_history',
        notice: 'Historical output (' + rawStr.length + ' bytes) has been evicted from conversation history to conserve context and cost.'
      });
    }
    return '[Historical output evicted: ' + rawStr.length + ' bytes to conserve context window]';
  }

  return rawContent;
}
