/**
 * Master Tool Alias Map, canonical tool resolver, and precall allowlist definitions.
 * Private implementation detail of the `tools/normalizers` module; the public surface is `index.ts`.
 */

import { PUBLISHING_TOOLS, SANDBOX_TOOLS } from '../constants/index.ts';

/**
 * Master Tool Alias Map
 * Maps canonical snake_case names, camelCase variants, namespaces, and documented LLM hallucinated aliases
 * directly to the canonical snake_case tool name.
 */
export const TOOL_ALIAS_MAP: Readonly<Record<string, string>> = Object.freeze({
  // --- VFS Primitives ---

  // read_file
  'read_file': SANDBOX_TOOLS.READ_FILE,
  'readFile': SANDBOX_TOOLS.READ_FILE,
  'virtualFs_readFile': SANDBOX_TOOLS.READ_FILE,
  'virtualFs.readFile': SANDBOX_TOOLS.READ_FILE,
  'virtualFsReadFile': SANDBOX_TOOLS.READ_FILE,
  'fs_readFile': SANDBOX_TOOLS.READ_FILE,
  'fs.readFile': SANDBOX_TOOLS.READ_FILE,
  'fs_read_file': SANDBOX_TOOLS.READ_FILE,
  'vfs_read_file': SANDBOX_TOOLS.READ_FILE,
  'vfs_readFile': SANDBOX_TOOLS.READ_FILE,
  'file_read': SANDBOX_TOOLS.READ_FILE,
  'fileRead': SANDBOX_TOOLS.READ_FILE,
  'read': SANDBOX_TOOLS.READ_FILE,

  // write_file
  'write_file': SANDBOX_TOOLS.WRITE_FILE,
  'writeFile': SANDBOX_TOOLS.WRITE_FILE,
  'virtualFs_writeFile': SANDBOX_TOOLS.WRITE_FILE,
  'virtualFs.writeFile': SANDBOX_TOOLS.WRITE_FILE,
  'virtualFsWriteFile': SANDBOX_TOOLS.WRITE_FILE,
  'fs_writeFile': SANDBOX_TOOLS.WRITE_FILE,
  'fs.writeFile': SANDBOX_TOOLS.WRITE_FILE,
  'fs_write_file': SANDBOX_TOOLS.WRITE_FILE,
  'vfs_write_file': SANDBOX_TOOLS.WRITE_FILE,
  'vfs_writeFile': SANDBOX_TOOLS.WRITE_FILE,
  'file_write': SANDBOX_TOOLS.WRITE_FILE,
  'fileWrite': SANDBOX_TOOLS.WRITE_FILE,
  'save_file': SANDBOX_TOOLS.WRITE_FILE,
  'saveFile': SANDBOX_TOOLS.WRITE_FILE,
  'write': SANDBOX_TOOLS.WRITE_FILE,

  // replace_file_content
  'replace_file_content': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'replaceFileContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'virtualFs_replaceFileContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'virtualFs.replaceFileContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'virtualFsReplaceFileContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'virtualFs_replaceContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'virtualFsReplaceContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'fs_replaceFileContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'fs.replaceFileContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'fs_replace_file_content': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'fs_replaceContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'fsReplaceContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'replace_content': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'replaceContent': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'edit_file': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'editFile': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'replace_file': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  'replaceFile': SANDBOX_TOOLS.REPLACE_FILE_CONTENT,

  // copy_file
  'copy_file': SANDBOX_TOOLS.COPY_FILE,
  'copyFile': SANDBOX_TOOLS.COPY_FILE,
  'virtualFs_copyFile': SANDBOX_TOOLS.COPY_FILE,
  'virtualFs.copyFile': SANDBOX_TOOLS.COPY_FILE,
  'virtualFsCopyFile': SANDBOX_TOOLS.COPY_FILE,
  'fs_copyFile': SANDBOX_TOOLS.COPY_FILE,
  'fs.copyFile': SANDBOX_TOOLS.COPY_FILE,
  'fs_copy_file': SANDBOX_TOOLS.COPY_FILE,
  'vfs_copy_file': SANDBOX_TOOLS.COPY_FILE,
  'vfs_copyFile': SANDBOX_TOOLS.COPY_FILE,
  'cp': SANDBOX_TOOLS.COPY_FILE,
  'copy': SANDBOX_TOOLS.COPY_FILE,

  // delete_file
  'delete_file': SANDBOX_TOOLS.DELETE_FILE,
  'deleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'virtualFs_deleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'virtualFs.deleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'virtualFsDeleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'fs_deleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'fs.deleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'fs_delete_file': SANDBOX_TOOLS.DELETE_FILE,
  'vfs_delete_file': SANDBOX_TOOLS.DELETE_FILE,
  'vfs_deleteFile': SANDBOX_TOOLS.DELETE_FILE,
  'remove_file': SANDBOX_TOOLS.DELETE_FILE,
  'removeFile': SANDBOX_TOOLS.DELETE_FILE,
  'rm': SANDBOX_TOOLS.DELETE_FILE,
  'unlink': SANDBOX_TOOLS.DELETE_FILE,
  'delete': SANDBOX_TOOLS.DELETE_FILE,

  // list_files
  'list_files': SANDBOX_TOOLS.LIST_FILES,
  'listFiles': SANDBOX_TOOLS.LIST_FILES,
  'virtualFs_listFiles': SANDBOX_TOOLS.LIST_FILES,
  'virtualFs.listFiles': SANDBOX_TOOLS.LIST_FILES,
  'virtualFsListFiles': SANDBOX_TOOLS.LIST_FILES,
  'virtualFs_listDir': SANDBOX_TOOLS.LIST_FILES,
  'virtualFsListDir': SANDBOX_TOOLS.LIST_FILES,
  'fs_listFiles': SANDBOX_TOOLS.LIST_FILES,
  'fs.listFiles': SANDBOX_TOOLS.LIST_FILES,
  'fs_list_files': SANDBOX_TOOLS.LIST_FILES,
  'fs_listDir': SANDBOX_TOOLS.LIST_FILES,
  'fsListDir': SANDBOX_TOOLS.LIST_FILES,
  'vfs_list_files': SANDBOX_TOOLS.LIST_FILES,
  'vfs_listFiles': SANDBOX_TOOLS.LIST_FILES,
  'list_dir': SANDBOX_TOOLS.LIST_FILES,
  'listDir': SANDBOX_TOOLS.LIST_FILES,
  'ls': SANDBOX_TOOLS.LIST_FILES,
  'dir': SANDBOX_TOOLS.LIST_FILES,

  // write_json
  'write_json': SANDBOX_TOOLS.WRITE_JSON,
  'writeJson': SANDBOX_TOOLS.WRITE_JSON,
  'virtualFs_writeJson': SANDBOX_TOOLS.WRITE_JSON,
  'virtualFs.writeJson': SANDBOX_TOOLS.WRITE_JSON,
  'virtualFsWriteJson': SANDBOX_TOOLS.WRITE_JSON,
  'fs_writeJson': SANDBOX_TOOLS.WRITE_JSON,
  'fs.writeJson': SANDBOX_TOOLS.WRITE_JSON,
  'fs_write_json': SANDBOX_TOOLS.WRITE_JSON,
  'vfs_write_json': SANDBOX_TOOLS.WRITE_JSON,
  'vfs_writeJson': SANDBOX_TOOLS.WRITE_JSON,
  'save_json': SANDBOX_TOOLS.WRITE_JSON,
  'saveJson': SANDBOX_TOOLS.WRITE_JSON,
  'write_json_file': SANDBOX_TOOLS.WRITE_JSON,
  'writeJsonFile': SANDBOX_TOOLS.WRITE_JSON,

  // query_json
  'query_json': SANDBOX_TOOLS.QUERY_JSON,
  'queryJson': SANDBOX_TOOLS.QUERY_JSON,
  'virtualFs_queryJson': SANDBOX_TOOLS.QUERY_JSON,
  'virtualFs.queryJson': SANDBOX_TOOLS.QUERY_JSON,
  'virtualFsQueryJson': SANDBOX_TOOLS.QUERY_JSON,
  'fs_queryJson': SANDBOX_TOOLS.QUERY_JSON,
  'fs.queryJson': SANDBOX_TOOLS.QUERY_JSON,
  'fs_query_json': SANDBOX_TOOLS.QUERY_JSON,
  'vfs_query_json': SANDBOX_TOOLS.QUERY_JSON,
  'vfs_queryJson': SANDBOX_TOOLS.QUERY_JSON,
  'json_path': SANDBOX_TOOLS.QUERY_JSON,
  'jsonPath': SANDBOX_TOOLS.QUERY_JSON,
  'query_json_file': SANDBOX_TOOLS.QUERY_JSON,
  'queryJsonFile': SANDBOX_TOOLS.QUERY_JSON,
  'read_json': SANDBOX_TOOLS.QUERY_JSON,
  'readJson': SANDBOX_TOOLS.QUERY_JSON,

  // json_patch
  'json_patch': SANDBOX_TOOLS.JSON_PATCH,
  'jsonPatch': SANDBOX_TOOLS.JSON_PATCH,
  'virtualFs_jsonPatch': SANDBOX_TOOLS.JSON_PATCH,
  'virtualFs.jsonPatch': SANDBOX_TOOLS.JSON_PATCH,
  'virtualFsJsonPatch': SANDBOX_TOOLS.JSON_PATCH,
  'virtualFs_patchJson': SANDBOX_TOOLS.JSON_PATCH,
  'virtualFsPatchJson': SANDBOX_TOOLS.JSON_PATCH,
  'fs_jsonPatch': SANDBOX_TOOLS.JSON_PATCH,
  'fs.jsonPatch': SANDBOX_TOOLS.JSON_PATCH,
  'fs_json_patch': SANDBOX_TOOLS.JSON_PATCH,
  'fs_patchJson': SANDBOX_TOOLS.JSON_PATCH,
  'fsPatchJson': SANDBOX_TOOLS.JSON_PATCH,
  'patch_json': SANDBOX_TOOLS.JSON_PATCH,
  'patchJson': SANDBOX_TOOLS.JSON_PATCH,
  'apply_json_patch': SANDBOX_TOOLS.JSON_PATCH,
  'applyJsonPatch': SANDBOX_TOOLS.JSON_PATCH,

  // grep
  'grep': SANDBOX_TOOLS.GREP,
  'virtualFs_grep': SANDBOX_TOOLS.GREP,
  'virtualFs.grep': SANDBOX_TOOLS.GREP,
  'virtualFsGrep': SANDBOX_TOOLS.GREP,
  'virtualFs_search': SANDBOX_TOOLS.GREP,
  'virtualFsSearch': SANDBOX_TOOLS.GREP,
  'fs_grep': SANDBOX_TOOLS.GREP,
  'fs.grep': SANDBOX_TOOLS.GREP,
  'grep_search': SANDBOX_TOOLS.GREP,
  'grepSearch': SANDBOX_TOOLS.GREP,
  'fs_search': SANDBOX_TOOLS.GREP,
  'fsSearch': SANDBOX_TOOLS.GREP,
  'search_files': SANDBOX_TOOLS.GREP,
  'searchFiles': SANDBOX_TOOLS.GREP,
  'find_in_files': SANDBOX_TOOLS.GREP,
  'findInFiles': SANDBOX_TOOLS.GREP,
  'search': SANDBOX_TOOLS.GREP,

  // set_permissions
  'set_permissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'setPermissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'virtualFs_setPermissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'virtualFs.setPermissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'virtualFsSetPermissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'fs_setPermissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'fs.setPermissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'fs_set_permissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'chmod': SANDBOX_TOOLS.SET_PERMISSIONS,
  'fs_chmod': SANDBOX_TOOLS.SET_PERMISSIONS,
  'set_mode': SANDBOX_TOOLS.SET_PERMISSIONS,
  'setMode': SANDBOX_TOOLS.SET_PERMISSIONS,
  'change_permissions': SANDBOX_TOOLS.SET_PERMISSIONS,
  'changePermissions': SANDBOX_TOOLS.SET_PERMISSIONS,

  // concat_files
  'concat_files': SANDBOX_TOOLS.CONCAT_FILES,
  'concatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'virtualFs_concatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'virtualFs.concatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'virtualFsConcatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'fs_concatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'fs.concatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'fs_concat_files': SANDBOX_TOOLS.CONCAT_FILES,
  'vfs_concat_files': SANDBOX_TOOLS.CONCAT_FILES,
  'vfs_concatFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'concat': SANDBOX_TOOLS.CONCAT_FILES,
  'join_files': SANDBOX_TOOLS.CONCAT_FILES,
  'joinFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'merge_files': SANDBOX_TOOLS.CONCAT_FILES,
  'mergeFiles': SANDBOX_TOOLS.CONCAT_FILES,
  'combine_files': SANDBOX_TOOLS.CONCAT_FILES,
  'combineFiles': SANDBOX_TOOLS.CONCAT_FILES,

  // --- Messaging & Mailbox Primitives ---

  // send_message
  'send_message': SANDBOX_TOOLS.SEND_MESSAGE,
  'sendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'messaging_sendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'messaging.sendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'messagingSendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'msg_sendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'msgSendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'msg_send': SANDBOX_TOOLS.SEND_MESSAGE,
  'msg.send': SANDBOX_TOOLS.SEND_MESSAGE,
  'msgSend': SANDBOX_TOOLS.SEND_MESSAGE,
  'runtime_sendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'runtime.sendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'runtimeSendMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'send_mail': SANDBOX_TOOLS.SEND_MESSAGE,
  'sendMail': SANDBOX_TOOLS.SEND_MESSAGE,
  'post_message': SANDBOX_TOOLS.SEND_MESSAGE,
  'postMessage': SANDBOX_TOOLS.SEND_MESSAGE,
  'send': SANDBOX_TOOLS.SEND_MESSAGE,

  // wait_for_mail
  'wait_for_mail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'waitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'runtime_waitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'runtime.waitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'runtimeWaitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'wait_mail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'waitMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'wait_for_messages': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'waitForMessages': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'wait_messages': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'waitMessages': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'await_mail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'awaitMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'messaging_waitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'messaging.waitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,
  'messagingWaitForMail': SANDBOX_TOOLS.WAIT_FOR_MAIL,

  // list_inbox
  'list_inbox': SANDBOX_TOOLS.LIST_INBOX,
  'listInbox': SANDBOX_TOOLS.LIST_INBOX,
  'messaging_listInbox': SANDBOX_TOOLS.LIST_INBOX,
  'messaging.listInbox': SANDBOX_TOOLS.LIST_INBOX,
  'messagingListInbox': SANDBOX_TOOLS.LIST_INBOX,
  'msg_listInbox': SANDBOX_TOOLS.LIST_INBOX,
  'msg.listInbox': SANDBOX_TOOLS.LIST_INBOX,
  'msgListInbox': SANDBOX_TOOLS.LIST_INBOX,
  'get_inbox_headers': SANDBOX_TOOLS.LIST_INBOX,
  'getInboxHeaders': SANDBOX_TOOLS.LIST_INBOX,
  'check_inbox': SANDBOX_TOOLS.LIST_INBOX,
  'checkInbox': SANDBOX_TOOLS.LIST_INBOX,
  'list_messages': SANDBOX_TOOLS.LIST_INBOX,
  'listMessages': SANDBOX_TOOLS.LIST_INBOX,
  'inbox_list': SANDBOX_TOOLS.LIST_INBOX,
  'inboxList': SANDBOX_TOOLS.LIST_INBOX,

  // read_message
  'read_message': SANDBOX_TOOLS.READ_MESSAGE,
  'readMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'messaging_readMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'messaging.readMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'messagingReadMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'msg_readMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'msg.readMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'msgReadMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'read_mail': SANDBOX_TOOLS.READ_MESSAGE,
  'readMail': SANDBOX_TOOLS.READ_MESSAGE,
  'get_message': SANDBOX_TOOLS.READ_MESSAGE,
  'getMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'fetch_message': SANDBOX_TOOLS.READ_MESSAGE,
  'fetchMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'fetch_read_message': SANDBOX_TOOLS.READ_MESSAGE,
  'fetchReadMessage': SANDBOX_TOOLS.READ_MESSAGE,
  'msg_read': SANDBOX_TOOLS.READ_MESSAGE,
  'msgRead': SANDBOX_TOOLS.READ_MESSAGE,

  // get_archive
  'get_archive': SANDBOX_TOOLS.GET_ARCHIVE,
  'getArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'messaging_getArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'messaging.getArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'messagingGetArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'msg_getArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'msg.getArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'msgGetArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'list_archive': SANDBOX_TOOLS.GET_ARCHIVE,
  'listArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'get_history': SANDBOX_TOOLS.GET_ARCHIVE,
  'getHistory': SANDBOX_TOOLS.GET_ARCHIVE,
  'get_read_mail': SANDBOX_TOOLS.GET_ARCHIVE,
  'getReadMail': SANDBOX_TOOLS.GET_ARCHIVE,
  'list_read_mail': SANDBOX_TOOLS.GET_ARCHIVE,
  'listReadMail': SANDBOX_TOOLS.GET_ARCHIVE,
  'read_archive': SANDBOX_TOOLS.GET_ARCHIVE,
  'readArchive': SANDBOX_TOOLS.GET_ARCHIVE,
  'message_history': SANDBOX_TOOLS.GET_ARCHIVE,
  'messageHistory': SANDBOX_TOOLS.GET_ARCHIVE,

  // inline_file_in_message
  'inline_file_in_message': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'inlineFileInMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging_inlineFileInMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging.inlineFileInMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messagingInlineFileInMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging_inlineFile': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging.inlineFile': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messagingInlineFile': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'inline_file': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'inlineFile': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging_sendTemplatedMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging.sendTemplatedMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'send_templated_message': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'sendTemplatedMessage': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging_sendMessageWithFiles': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'messaging.sendMessageWithFiles': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'send_message_with_files': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'sendMessageWithFiles': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'template_renderPrompt': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'render_prompt': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'renderPrompt': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'msg_inlineFile': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  'msgInlineFile': SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,

  // get_inbox
  'get_inbox': SANDBOX_TOOLS.GET_INBOX,
  'getInbox': SANDBOX_TOOLS.GET_INBOX,
  'messaging_getInbox': SANDBOX_TOOLS.GET_INBOX,
  'messaging.getInbox': SANDBOX_TOOLS.GET_INBOX,
  'messagingGetInbox': SANDBOX_TOOLS.GET_INBOX,
  'msg_getInbox': SANDBOX_TOOLS.GET_INBOX,
  'msg.getInbox': SANDBOX_TOOLS.GET_INBOX,
  'msgGetInbox': SANDBOX_TOOLS.GET_INBOX,
  'fetch_inbox': SANDBOX_TOOLS.GET_INBOX,
  'fetchInbox': SANDBOX_TOOLS.GET_INBOX,

  // drain_inbox
  'drain_inbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'drainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'messaging_drainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'messaging.drainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'messagingDrainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'msg_drainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'msg.drainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'msgDrainInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'clear_inbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'clearInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'empty_inbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'emptyInbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'flush_inbox': SANDBOX_TOOLS.DRAIN_INBOX,
  'flushInbox': SANDBOX_TOOLS.DRAIN_INBOX,

  // --- Agent Lifecycle Primitives ---

  // spawn_agent
  'spawn_agent': SANDBOX_TOOLS.SPAWN_AGENT,
  'spawnAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'runtime_spawnAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'runtime.spawnAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'runtimeSpawnAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'create_agent': SANDBOX_TOOLS.SPAWN_AGENT,
  'createAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'spawn': SANDBOX_TOOLS.SPAWN_AGENT,
  'new_agent': SANDBOX_TOOLS.SPAWN_AGENT,
  'newAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'runtime_createAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'runtimeCreateAgent': SANDBOX_TOOLS.SPAWN_AGENT,
  'start_agent': SANDBOX_TOOLS.SPAWN_AGENT,
  'startAgent': SANDBOX_TOOLS.SPAWN_AGENT,

  // kill_agent
  'kill_agent': SANDBOX_TOOLS.KILL_AGENT,
  'killAgent': SANDBOX_TOOLS.KILL_AGENT,
  'runtime_killAgent': SANDBOX_TOOLS.KILL_AGENT,
  'runtime.killAgent': SANDBOX_TOOLS.KILL_AGENT,
  'runtimeKillAgent': SANDBOX_TOOLS.KILL_AGENT,
  'terminate_agent': SANDBOX_TOOLS.KILL_AGENT,
  'terminateAgent': SANDBOX_TOOLS.KILL_AGENT,
  'stop_agent': SANDBOX_TOOLS.KILL_AGENT,
  'stopAgent': SANDBOX_TOOLS.KILL_AGENT,
  'delete_agent': SANDBOX_TOOLS.KILL_AGENT,
  'deleteAgent': SANDBOX_TOOLS.KILL_AGENT,
  'destroy_agent': SANDBOX_TOOLS.KILL_AGENT,
  'destroyAgent': SANDBOX_TOOLS.KILL_AGENT,
  'kill': SANDBOX_TOOLS.KILL_AGENT,

  // list_agents
  'list_agents': SANDBOX_TOOLS.LIST_AGENTS,
  'listAgents': SANDBOX_TOOLS.LIST_AGENTS,
  'runtime_listAgents': SANDBOX_TOOLS.LIST_AGENTS,
  'runtime.listAgents': SANDBOX_TOOLS.LIST_AGENTS,
  'runtimeListAgents': SANDBOX_TOOLS.LIST_AGENTS,
  'get_agents': SANDBOX_TOOLS.LIST_AGENTS,
  'getAgents': SANDBOX_TOOLS.LIST_AGENTS,
  'active_agents': SANDBOX_TOOLS.LIST_AGENTS,
  'activeAgents': SANDBOX_TOOLS.LIST_AGENTS,
  'all_agents': SANDBOX_TOOLS.LIST_AGENTS,
  'allAgents': SANDBOX_TOOLS.LIST_AGENTS,

  // whoami
  'whoami': SANDBOX_TOOLS.WHOAMI,
  'runtime_whoami': SANDBOX_TOOLS.WHOAMI,
  'runtime.whoami': SANDBOX_TOOLS.WHOAMI,
  'runtimeWhoami': SANDBOX_TOOLS.WHOAMI,
  'get_identity': SANDBOX_TOOLS.WHOAMI,
  'getIdentity': SANDBOX_TOOLS.WHOAMI,
  'my_identity': SANDBOX_TOOLS.WHOAMI,
  'myIdentity': SANDBOX_TOOLS.WHOAMI,
  'who_am_i': SANDBOX_TOOLS.WHOAMI,
  'whoAmI': SANDBOX_TOOLS.WHOAMI,
  'self_id': SANDBOX_TOOLS.WHOAMI,
  'selfId': SANDBOX_TOOLS.WHOAMI,

  // undo_turn
  'undo_turn': SANDBOX_TOOLS.UNDO_TURN,
  'undoTurn': SANDBOX_TOOLS.UNDO_TURN,
  'runtime_undoTurn': SANDBOX_TOOLS.UNDO_TURN,
  'runtime.undoTurn': SANDBOX_TOOLS.UNDO_TURN,
  'runtime_undo_turn': SANDBOX_TOOLS.UNDO_TURN,
  'runtimeUndoTurn': SANDBOX_TOOLS.UNDO_TURN,
  'undo': SANDBOX_TOOLS.UNDO_TURN,
  'revert_turn': SANDBOX_TOOLS.UNDO_TURN,
  'revertTurn': SANDBOX_TOOLS.UNDO_TURN,
  'rollback_turn': SANDBOX_TOOLS.UNDO_TURN,
  'rollbackTurn': SANDBOX_TOOLS.UNDO_TURN,

  // --- Synchronous Invocation Primitives ---

  // invoke_agent
  'invoke_agent': SANDBOX_TOOLS.INVOKE_AGENT,
  'invokeAgent': SANDBOX_TOOLS.INVOKE_AGENT,
  'runtime_invokeAgent': SANDBOX_TOOLS.INVOKE_AGENT,
  'runtime.invokeAgent': SANDBOX_TOOLS.INVOKE_AGENT,
  'runtimeInvokeAgent': SANDBOX_TOOLS.INVOKE_AGENT,
  'call_agent': SANDBOX_TOOLS.INVOKE_AGENT,
  'callAgent': SANDBOX_TOOLS.INVOKE_AGENT,
  'invoke': SANDBOX_TOOLS.INVOKE_AGENT,
  'dispatch_agent': SANDBOX_TOOLS.INVOKE_AGENT,
  'dispatchAgent': SANDBOX_TOOLS.INVOKE_AGENT,
  'run_agent': SANDBOX_TOOLS.INVOKE_AGENT,
  'runAgent': SANDBOX_TOOLS.INVOKE_AGENT,

  // wait_for_invocation
  'wait_for_invocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'waitForInvocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'runtime_waitForInvocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'runtime.waitForInvocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'runtimeWaitForInvocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'wait_invocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'waitInvocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'await_invocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  'awaitInvocation': SANDBOX_TOOLS.WAIT_FOR_INVOCATION,

  // --- Scheduler Primitives ---

  // schedule
  'schedule': SANDBOX_TOOLS.SCHEDULE,
  'runtime_schedule': SANDBOX_TOOLS.SCHEDULE,
  'runtime.schedule': SANDBOX_TOOLS.SCHEDULE,
  'runtimeSchedule': SANDBOX_TOOLS.SCHEDULE,
  'schedule_task': SANDBOX_TOOLS.SCHEDULE,
  'scheduleTask': SANDBOX_TOOLS.SCHEDULE,
  'schedule_timer': SANDBOX_TOOLS.SCHEDULE,
  'scheduleTimer': SANDBOX_TOOLS.SCHEDULE,
  'set_timer': SANDBOX_TOOLS.SCHEDULE,
  'setTimer': SANDBOX_TOOLS.SCHEDULE,
  'create_schedule': SANDBOX_TOOLS.SCHEDULE,
  'createSchedule': SANDBOX_TOOLS.SCHEDULE,
  'sched_schedule': SANDBOX_TOOLS.SCHEDULE,
  'schedSchedule': SANDBOX_TOOLS.SCHEDULE,

  // list_schedules
  'list_schedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'listSchedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'runtime_listSchedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'runtime.listSchedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'runtimeListSchedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'get_schedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'getSchedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'sched_list': SANDBOX_TOOLS.LIST_SCHEDULES,
  'schedList': SANDBOX_TOOLS.LIST_SCHEDULES,
  'list_timers': SANDBOX_TOOLS.LIST_SCHEDULES,
  'listTimers': SANDBOX_TOOLS.LIST_SCHEDULES,
  'active_schedules': SANDBOX_TOOLS.LIST_SCHEDULES,
  'activeSchedules': SANDBOX_TOOLS.LIST_SCHEDULES,

  // cancel_schedule
  'cancel_schedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'cancelSchedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'runtime_cancelSchedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'runtime.cancelSchedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'runtimeCancelSchedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'delete_schedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'deleteSchedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'remove_schedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'removeSchedule': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'sched_cancel': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'schedCancel': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'cancel_timer': SANDBOX_TOOLS.CANCEL_SCHEDULE,
  'cancelTimer': SANDBOX_TOOLS.CANCEL_SCHEDULE,

  // --- Clock & Events Primitives ---

  // world_clock
  'world_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'worldClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'get_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'getClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'update_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'updateClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'advance_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'advanceClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'set_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'setClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'reset_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'resetClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'clear_clock': SANDBOX_TOOLS.WORLD_CLOCK,
  'clearClock': SANDBOX_TOOLS.WORLD_CLOCK,
  'world_time': SANDBOX_TOOLS.WORLD_CLOCK,
  'worldTime': SANDBOX_TOOLS.WORLD_CLOCK,
  'clock_control': SANDBOX_TOOLS.WORLD_CLOCK,
  'clockControl': SANDBOX_TOOLS.WORLD_CLOCK,

  // event_list
  'event_list': SANDBOX_TOOLS.EVENT_LIST,
  'eventList': SANDBOX_TOOLS.EVENT_LIST,
  'events': SANDBOX_TOOLS.EVENT_LIST,
  'world_events': SANDBOX_TOOLS.EVENT_LIST,
  'worldEvents': SANDBOX_TOOLS.EVENT_LIST,
  'list_events': SANDBOX_TOOLS.EVENT_LIST,
  'listEvents': SANDBOX_TOOLS.EVENT_LIST,
  'register_event': SANDBOX_TOOLS.EVENT_LIST,
  'registerEvent': SANDBOX_TOOLS.EVENT_LIST,
  'resolve_event': SANDBOX_TOOLS.EVENT_LIST,
  'resolveEvent': SANDBOX_TOOLS.EVENT_LIST,
  'mark_event_resolved': SANDBOX_TOOLS.EVENT_LIST,
  'markEventResolved': SANDBOX_TOOLS.EVENT_LIST,
  'active_events': SANDBOX_TOOLS.EVENT_LIST,
  'activeEvents': SANDBOX_TOOLS.EVENT_LIST,
  'query_events': SANDBOX_TOOLS.EVENT_LIST,
  'queryEvents': SANDBOX_TOOLS.EVENT_LIST,
  'cancel_event': SANDBOX_TOOLS.EVENT_LIST,
  'cancelEvent': SANDBOX_TOOLS.EVENT_LIST,
  'delete_event': SANDBOX_TOOLS.EVENT_LIST,
  'deleteEvent': SANDBOX_TOOLS.EVENT_LIST,
  'clear_events': SANDBOX_TOOLS.EVENT_LIST,
  'clearEvents': SANDBOX_TOOLS.EVENT_LIST,
  'reset_events': SANDBOX_TOOLS.EVENT_LIST,
  'resetEvents': SANDBOX_TOOLS.EVENT_LIST,
  'event_manager': SANDBOX_TOOLS.EVENT_LIST,
  'eventManager': SANDBOX_TOOLS.EVENT_LIST,
  'worldClock_queryEvents': SANDBOX_TOOLS.EVENT_LIST,

  // get_current_time
  'get_current_time': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'getCurrentTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'system_getCurrentTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'system.getCurrentTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'systemGetCurrentTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'worldClock_getTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'worldClock.getTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'worldClockGetTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'get_time': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'getTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'current_time': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'currentTime': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'time': SANDBOX_TOOLS.GET_CURRENT_TIME,
  'now': SANDBOX_TOOLS.GET_CURRENT_TIME,

  // --- Precall & Reflection Primitives ---

  // batch_precall
  'batch_precall': SANDBOX_TOOLS.BATCH_PRECALL,
  'batchPrecall': SANDBOX_TOOLS.BATCH_PRECALL,
  'runtime_batchPrecall': SANDBOX_TOOLS.BATCH_PRECALL,
  'runtime.batchPrecall': SANDBOX_TOOLS.BATCH_PRECALL,
  'runtimeBatchPrecall': SANDBOX_TOOLS.BATCH_PRECALL,
  'batch_call': SANDBOX_TOOLS.BATCH_PRECALL,
  'batchCall': SANDBOX_TOOLS.BATCH_PRECALL,
  'precall': SANDBOX_TOOLS.BATCH_PRECALL,
  'precalls': SANDBOX_TOOLS.BATCH_PRECALL,
  'batch_precalls': SANDBOX_TOOLS.BATCH_PRECALL,

  // describe_tool
  'describe_tool': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'describeTool': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'system_describeTool': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'system.describeTool': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'systemDescribeTool': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'tool_info': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'toolInfo': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'help': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'describe': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'inspect_tool': SANDBOX_TOOLS.DESCRIBE_TOOL,
  'inspectTool': SANDBOX_TOOLS.DESCRIBE_TOOL,

  // Subagent management category presets/aliases
  'subagent_management': 'subagent_management',
  'manage_subagents': 'subagent_management',
  'subagents': 'subagent_management',
  'subagent_tools': 'subagent_management',

  // --- Wave U Publishing Meta Tools (explicit-grant-only; never wildcard-exposed) ---
  'import_realm_template': PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
  'importRealmTemplate': PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
  'import_template': PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
  'importTemplate': PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
  'submit_hydration_package': PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
  'submitHydrationPackage': PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
  'submit_hydration': PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
  'submitHydration': PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE
});

const LOWER_TOOL_ALIAS_MAP = Object.create(null);
for (const [key, value] of Object.entries(TOOL_ALIAS_MAP)) {
  LOWER_TOOL_ALIAS_MAP[key.toLowerCase()] = value;
}

/**
 * Pure lookup function returning canonical snake_case tool name or null.
 * Safe against prototype pollution.
 *
 * @param toolName - Raw, untrusted tool name; non-string values resolve to `null`.
 * @returns The canonical snake_case tool name, or `null` when the input is not a non-empty string or has no alias entry.
 */
export function getCanonToolName(toolName: unknown): string | null {
  if (!toolName || typeof toolName !== 'string') return null;
  const trimmed = toolName.trim();
  if (!trimmed) return null;

  // 1. Direct match in frozen alias dictionary (O(1))
  if (Object.prototype.hasOwnProperty.call(TOOL_ALIAS_MAP, trimmed)) {
    return TOOL_ALIAS_MAP[trimmed];
  }

  // 2. Case-insensitive lookup (O(1))
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOWER_TOOL_ALIAS_MAP, lower)) {
    return LOWER_TOOL_ALIAS_MAP[lower] || null;
  }

  // 3. Dot-notation normalization ('fs.readFile' -> 'fs_readFile')
  if (trimmed.includes('.')) {
    const normalizedDots = trimmed.replace(/\./g, '_');
    if (Object.prototype.hasOwnProperty.call(TOOL_ALIAS_MAP, normalizedDots)) {
      return TOOL_ALIAS_MAP[normalizedDots];
    }
    const lowerDots = normalizedDots.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LOWER_TOOL_ALIAS_MAP, lowerDots)) {
      return LOWER_TOOL_ALIAS_MAP[lowerDots] || null;
    }
  }

  return null;
}

/**
 * Alias of {@link getCanonToolName} — the same function reference (`normalizeToolName === getCanonToolName`).
 */
export const normalizeToolName = getCanonToolName;

/**
 * Ratified Precall Allowlist
 * Precalls are NOT read-only: this set admits mail-consuming operations
 * (`read_message` defaults to mark-as-read; `get_inbox` with `mark_as_read` drains the inbox)
 * and clock/event stepping (`world_clock` actions advance/set/reset, `event_list` actions
 * register/resolve/cancel) within its allowed set. Forbidden: every tool outside this set —
 * VFS writes and mutations, agent lifecycle mutations (`list_agents` is allowlisted), scheduler
 * mutations, outbound messaging, and direct invocation — denied as `PRECALL_FORBIDDEN` by the
 * `batch_precall` descriptor and as `FORBIDDEN_PRECALL` by the turn-execution precall gate.
 */
export const PRECALL_ALLOWLIST = Object.freeze(new Set([
  SANDBOX_TOOLS.READ_FILE,
  SANDBOX_TOOLS.QUERY_JSON,
  SANDBOX_TOOLS.LIST_FILES,
  SANDBOX_TOOLS.GREP,
  SANDBOX_TOOLS.GET_CURRENT_TIME,
  SANDBOX_TOOLS.WORLD_CLOCK,
  SANDBOX_TOOLS.EVENT_LIST,
  SANDBOX_TOOLS.LIST_AGENTS,
  SANDBOX_TOOLS.WHOAMI,
  SANDBOX_TOOLS.LIST_INBOX,
  SANDBOX_TOOLS.READ_MESSAGE,
  SANDBOX_TOOLS.GET_ARCHIVE,
  SANDBOX_TOOLS.GET_INBOX,
  SANDBOX_TOOLS.DESCRIBE_TOOL
]));
