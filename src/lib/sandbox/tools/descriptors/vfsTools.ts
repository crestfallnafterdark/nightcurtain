/**
 * Tool descriptors for Virtual Filesystem (VFS) operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated vfsToolDescriptors array.
 */

import { SANDBOX_TOOLS } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a VFS descriptor handler. */
type ToolParams = Record<string, unknown>;

/** Minimal virtual-filesystem substrate view consumed by the VFS descriptors. */
interface VirtualFsView {
  readFile(params: ToolParams, context: unknown): unknown;
  writeFile(params: ToolParams, context: unknown): unknown;
  replaceFileContent(params: ToolParams, context: unknown): unknown;
  copyFile(params: ToolParams, context: unknown): unknown;
  deleteFile(params: ToolParams, context: unknown): unknown;
  listFiles(params: ToolParams, context: unknown): unknown;
  writeJson(params: ToolParams, context: unknown): unknown;
  queryJson(params: ToolParams, context: unknown): unknown;
  patchJson?(params: ToolParams, context: unknown): unknown;
  jsonPatch?(params: ToolParams, context: unknown): unknown;
  grep(params: ToolParams, context: unknown): unknown;
  setPermissions(params: ToolParams, context: unknown): unknown;
  concatFiles?(params: ToolParams, context: unknown): unknown;
}

/**
 * Identity keys are bound by the dispatcher's trusted execution context; a tool
 * argument must never select the identity a VFS operation authorizes against
 * (MOD-21 W9-A, tickets 03c0e2c/7651555, 135e77c, f59fd2c).
 */
const IDENTITY_PARAM_KEYS = Object.freeze(['callerAgentId', 'caller_agent_id', 'agentId', 'agent_id']);

/**
 * Workspace/scope keys are pinned dispatcher construction state (Realm A0-2,
 * ticket c7a3049): the turn engine binds the caller's resolved private
 * workspace into the execution context, so a tool argument must never select
 * the storage target (ticket a50f109). The per-side `copy_file` workspace
 * aliases are scrub-owned too (ticket cf5e707), so a copy operates purely on
 * view paths. The scrub below removes every camelCase/snake_case spelling
 * from the sanitized parameters and the nested `options` bag.
 */
const WORKSPACE_PARAM_KEYS = Object.freeze([
  'workspaceId', 'workspace_id',
  'srcWorkspaceId', 'src_workspace_id', 'sourceWorkspaceId', 'source_workspace_id',
  'destWorkspaceId', 'dest_workspace_id', 'destinationWorkspaceId', 'destination_workspace_id'
]);

/**
 * Removes caller-supplied identity and workspace keys (including the
 * per-side `copy_file` aliases) from sanitized tool parameters before they
 * reach the substrate. The sanitized parameter object is a fresh copy
 * produced by the descriptor's `createParamSanitizer`, so scrubbing here never
 * mutates caller input. A nested `options` bag (never a declared tool
 * parameter) is scrubbed too, as a shallow copy.
 * @param params - Sanitized tool parameters
 * @returns A fresh parameter copy with identity/workspace keys removed
 */
function scrubIdentityParams(params: Record<string, unknown>): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const scrubbed = { ...params };
  for (const key of IDENTITY_PARAM_KEYS) delete scrubbed[key];
  for (const key of WORKSPACE_PARAM_KEYS) delete scrubbed[key];
  const nested = scrubbed.options;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const scrubbedNested: Record<string, unknown> = { ...nested };
    for (const key of IDENTITY_PARAM_KEYS) delete scrubbedNested[key];
    for (const key of WORKSPACE_PARAM_KEYS) delete scrubbedNested[key];
    scrubbed.options = scrubbedNested;
  }
  return scrubbed;
}

/**
 * Agent-facing path guidance shared by every VFS descriptor: `/` is the
 * caller's private workspace, `/global/...` is the shared workspace, and
 * `/agents/<agentId>/...` mounts another agent's private workspace.
 */
const PATH_VIEW_HELP =
  '"/" is your private workspace, "/global/..." is the shared workspace visible to every agent in your scope, and "/agents/<agentId>/..." mounts another agent\'s private workspace (authority required).';

/**
 * VFS descriptor parameter sanitizer: every VFS tool sanitizes through this
 * factory so identity keys can never reach the substrate from tool arguments.
 * @param paramAliasMap - Optional alias map applied before scrubbing
 * @returns A sanitizer that returns a fresh scrubbed parameter copy
 */
function createVfsParamSanitizer(
  paramAliasMap: Record<string, string> = {}
): (rawArgs?: unknown) => Record<string, unknown> {
  const sanitize = createParamSanitizer(paramAliasMap);
  return (rawArgs?: unknown): Record<string, unknown> => scrubIdentityParams(sanitize(rawArgs));
}

// --- 1. read_file ---
const readFileParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  source: 'file_path',
  src: 'file_path',
  byte_offset: 'offset',
  byteOffset: 'offset',
  start_offset: 'offset',
  startOffset: 'offset',
  content_offset: 'offset',
  contentOffset: 'offset',
  byte_limit: 'limit',
  byteLimit: 'limit',
  length: 'limit',
  max_bytes: 'limit',
  maxBytes: 'limit'
});

/**
 * `read_file` descriptor — read file content from the virtual filesystem with
 * offset/limit pagination.
 *
 * Args: `file_path` (required), `offset`, `limit`. Returns the substrate result
 * from `context.virtualFs.readFile()` and throws when that service is missing.
 */
export const readFileDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.READ_FILE,
  description: `Read file content from the virtual filesystem with pagination and offset support. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the file in the virtual filesystem. ${PATH_VIEW_HELP}`
      },
      offset: {
        type: 'integer',
        description: 'UTF-16 code unit offset to begin reading from (0-indexed).'
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of UTF-16 code units or lines to read.'
      }
    },
    required: ['file_path'],
    additionalProperties: false
  }),
  paramAliasMap: readFileParamAliasMap,
  sanitize: createVfsParamSanitizer(readFileParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.readFile !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.readFile(params, context);
  }
});
/** camelCase alias of `readFileDescriptor`. */
export const readFile = readFileDescriptor;
/** snake_case alias of `readFileDescriptor`. */
export const read_file = readFileDescriptor;

// --- 2. write_file ---
const writeFileParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  data: 'content',
  text: 'content',
  body: 'content',
  payload: 'content',
  file_content: 'content',
  fileContent: 'content',
  permissions: 'mode',
  permission: 'mode',
  perms: 'mode',
  sourceFile: 'source_file',
  source_file: 'source_file',
  sourcePath: 'source_file',
  source_path: 'source_file',
  fromFile: 'source_file',
  from_file: 'source_file',
  appendTo: 'append',
  append_to: 'append',
  appendMode: 'append',
  append_mode: 'append'
});

/**
 * `write_file` descriptor — write or overwrite text content in the virtual
 * filesystem.
 *
 * Args: `file_path` (required), exactly one of inline `content` or file-sourced
 * `source_file`, plus optional `append` and `mode`. Delegates to
 * `context.virtualFs.writeFile()` and throws when that service is missing.
 */
export const writeFileDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.WRITE_FILE,
  description: `Write or overwrite text content to a file in the virtual filesystem. Provide exactly one of inline content or source_file (a caller-visible source path whose bytes are written server-side, never through context); with append: true the resolved content is appended to the existing destination. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the file to create or overwrite. ${PATH_VIEW_HELP}`
      },
      content: {
        type: 'string',
        description: 'Text or data content to write to the file (mutually exclusive with source_file).'
      },
      source_file: {
        type: 'string',
        description: `Caller-visible path of a source file whose raw content is written instead of inline content (mutually exclusive with content; resolved with the caller's read rules under the same workspace view). ${PATH_VIEW_HELP}`
      },
      append: {
        type: 'boolean',
        description: 'Append the resolved content to the existing destination content instead of overwriting (defaults to false).'
      },
      mode: {
        type: 'string',
        description: 'Optional file mode or permissions flag.'
      }
    },
    required: ['file_path'],
    oneOf: [
      { required: ['content'] },
      { required: ['source_file'] }
    ],
    additionalProperties: false
  }),
  paramAliasMap: writeFileParamAliasMap,
  sanitize: createVfsParamSanitizer(writeFileParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.writeFile !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.writeFile(params, context);
  }
});
/** camelCase alias of `writeFileDescriptor`. */
export const writeFile = writeFileDescriptor;
/** snake_case alias of `writeFileDescriptor`. */
export const write_file = writeFileDescriptor;

// --- 3. replace_file_content ---
const replaceFileContentParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  searchContent: 'target_content',
  replaceContent: 'replacement_content',
  target_content: 'target_content',
  targetContent: 'target_content',
  target: 'target_content',
  search_content: 'target_content',
  search: 'target_content',
  find: 'target_content',
  pattern: 'target_content',
  replacement: 'replacement_content',
  replacementContent: 'replacement_content',
  replacement_content: 'replacement_content',
  replace: 'replacement_content',
  newContent: 'replacement_content',
  new_content: 'replacement_content',
  replacementSourceFile: 'replacement_source_file',
  replacement_source_file: 'replacement_source_file',
  replacementFile: 'replacement_source_file',
  replacement_file: 'replacement_source_file',
  replaceAll: 'replace_all',
  replace_all: 'replace_all',
  all: 'replace_all'
});

/**
 * `replace_file_content` descriptor — surgically replace an exact substring in a
 * virtual filesystem file.
 *
 * Args: `file_path`, `target_content` (both required), exactly one of inline
 * `replacement_content` or file-sourced `replacement_source_file`, optional
 * `replace_all`. Delegates to `context.virtualFs.replaceFileContent()` and
 * throws when that service is missing.
 */
export const replaceFileContentDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  description: `Surgically replace target string content within a virtual filesystem file. Provide exactly one of replacement_content or replacement_source_file (a caller-visible source path whose bytes fill the replacement server-side, never through context). ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the target file in the virtual filesystem. ${PATH_VIEW_HELP}`
      },
      target_content: {
        type: 'string',
        description: 'Exact text substring to find and replace.'
      },
      replacement_content: {
        type: 'string',
        description: 'Replacement text to insert (mutually exclusive with replacement_source_file).'
      },
      replacement_source_file: {
        type: 'string',
        description: `Caller-visible path of a source file whose raw content is used as the replacement string (mutually exclusive with replacement_content; resolved with the caller's read rules under the same workspace view). ${PATH_VIEW_HELP}`
      },
      replace_all: {
        type: 'boolean',
        description: 'Whether to replace all occurrences instead of only the first.'
      }
    },
    required: ['file_path', 'target_content'],
    oneOf: [
      { required: ['replacement_content'] },
      { required: ['replacement_source_file'] }
    ],
    additionalProperties: false
  }),
  paramAliasMap: replaceFileContentParamAliasMap,
  sanitize: createVfsParamSanitizer(replaceFileContentParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.replaceFileContent !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.replaceFileContent(params, context);
  }
});
/** camelCase alias of `replaceFileContentDescriptor`. */
export const replaceFileContent = replaceFileContentDescriptor;
/** snake_case alias of `replaceFileContentDescriptor`. */
export const replace_file_content = replaceFileContentDescriptor;

// --- 4. copy_file ---
const copyFileParamAliasMap = Object.freeze({
  sourcePath: 'src_path',
  destinationPath: 'dest_path',
  src: 'src_path',
  dest: 'dest_path',
  source: 'src_path',
  destination: 'dest_path',
  from: 'src_path',
  to: 'dest_path',
  srcPath: 'src_path',
  src_path: 'src_path',
  destPath: 'dest_path',
  dest_path: 'dest_path',
  from_path: 'src_path',
  fromPath: 'src_path',
  to_path: 'dest_path',
  toPath: 'dest_path',
  source_path: 'src_path',
  destination_path: 'dest_path'
});

/**
 * `copy_file` descriptor — copy a file from `src_path` to `dest_path`.
 *
 * Args: `src_path`, `dest_path` (both required), optional `overwrite`. Delegates
 * to `context.virtualFs.copyFile()` and throws when that service is missing.
 */
export const copyFileDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.COPY_FILE,
  description: `Copy a file from src_path to dest_path in the virtual filesystem. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      src_path: {
        type: 'string',
        description: `Source path of the file to copy. ${PATH_VIEW_HELP}`
      },
      dest_path: {
        type: 'string',
        description: `Destination path for the copied file. ${PATH_VIEW_HELP}`
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite an existing destination file.'
      }
    },
    required: ['src_path', 'dest_path'],
    additionalProperties: false
  }),
  paramAliasMap: copyFileParamAliasMap,
  sanitize: createVfsParamSanitizer(copyFileParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.copyFile !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.copyFile(params, context);
  }
});
/** camelCase alias of `copyFileDescriptor`. */
export const copyFile = copyFileDescriptor;
/** snake_case alias of `copyFileDescriptor`. */
export const copy_file = copyFileDescriptor;

// --- 5. delete_file ---
const deleteFileParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  target_path: 'file_path',
  targetPath: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path'
});

/**
 * `delete_file` descriptor — delete a file or directory from the virtual
 * filesystem.
 *
 * Args: `file_path` (required), optional `recursive`. Delegates to
 * `context.virtualFs.deleteFile()` and throws when that service is missing.
 */
export const deleteFileDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.DELETE_FILE,
  description: `Delete a file or directory from the virtual filesystem. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the file or directory to delete. ${PATH_VIEW_HELP}`
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to recursively delete directories and their contents.'
      }
    },
    required: ['file_path'],
    additionalProperties: false
  }),
  paramAliasMap: deleteFileParamAliasMap,
  sanitize: createVfsParamSanitizer(deleteFileParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.deleteFile !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.deleteFile(params, context);
  }
});
/** camelCase alias of `deleteFileDescriptor`. */
export const deleteFile = deleteFileDescriptor;
/** snake_case alias of `deleteFileDescriptor`. */
export const delete_file = deleteFileDescriptor;

// --- 6. list_files ---
const listFilesParamAliasMap = Object.freeze({
  directoryPath: 'dir_path',
  dirPath: 'dir_path',
  dir_path: 'dir_path',
  directory_path: 'dir_path',
  path: 'dir_path',
  dir: 'dir_path',
  folder: 'dir_path',
  target_dir: 'dir_path',
  targetDir: 'dir_path',
  directory: 'dir_path'
});

/**
 * `list_files` descriptor — list files and directories under a virtual
 * filesystem directory.
 *
 * Args: optional `dir_path` (defaults to "/") and `recursive`. Delegates to
 * `context.virtualFs.listFiles()` and throws when that service is missing.
 */
export const listFilesDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.LIST_FILES,
  description: `List files and directories within a directory of the virtual filesystem. Listing "/" shows your private files plus the global/ mount (and agents/ for mounting authority); listing "/global" shows the shared workspace. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      dir_path: {
        type: 'string',
        description: `Directory path to list files from (defaults to "/"). ${PATH_VIEW_HELP}`
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to recursively list files in subdirectories.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: listFilesParamAliasMap,
  sanitize: createVfsParamSanitizer(listFilesParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.listFiles !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.listFiles(params, context);
  }
});
/** camelCase alias of `listFilesDescriptor`. */
export const listFiles = listFilesDescriptor;
/** snake_case alias of `listFilesDescriptor`. */
export const list_files = listFilesDescriptor;

// --- 7. write_json ---
const writeJsonParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  jsonData: 'data',
  json_data: 'data',
  content: 'data',
  value: 'data',
  json: 'data',
  payload: 'data',
  dataSourceFile: 'data_source_file',
  data_source_file: 'data_source_file',
  jsonSourceFile: 'data_source_file',
  json_source_file: 'data_source_file',
  sourceFile: 'data_source_file',
  source_file: 'data_source_file'
});

/**
 * `write_json` descriptor — write structured JSON data to a virtual filesystem
 * file.
 *
 * Args: `file_path` (required), exactly one of inline `data` or file-sourced
 * `data_source_file`, optional `formatted`. Delegates to
 * `context.virtualFs.writeJson()` and throws when that service is missing.
 */
export const writeJsonDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.WRITE_JSON,
  description: `Write structured JSON data to a file in the virtual filesystem. Provide exactly one of inline data or data_source_file (a caller-visible JSON file whose parsed value is written server-side, never through context). ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the JSON file to create or overwrite. ${PATH_VIEW_HELP}`
      },
      data: {
        type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
        description: 'JSON object, array, primitive value, or JSON-formatted string to write (mutually exclusive with data_source_file).'
      },
      data_source_file: {
        type: 'string',
        description: `Caller-visible path of a JSON source file whose parsed value is written (mutually exclusive with data; resolved with the caller's read rules under the same workspace view). ${PATH_VIEW_HELP}`
      },
      formatted: {
        type: 'boolean',
        description: 'Pretty-print JSON with 2-space indentation (defaults to true).'
      }
    },
    required: ['file_path'],
    oneOf: [
      { required: ['data'] },
      { required: ['data_source_file'] }
    ],
    additionalProperties: false
  }),
  paramAliasMap: writeJsonParamAliasMap,
  sanitize: createVfsParamSanitizer(writeJsonParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.writeJson !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.writeJson(params, context);
  }
});
/** camelCase alias of `writeJsonDescriptor`. */
export const writeJson = writeJsonDescriptor;
/** snake_case alias of `writeJsonDescriptor`. */
export const write_json = writeJsonDescriptor;

// --- 8. query_json ---
const queryJsonParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  jsonPath: 'query',
  json_path: 'query',
  filter: 'query',
  expression: 'query',
  jq: 'query',
  jqFilter: 'query',
  jq_filter: 'query',
  keyPath: 'query',
  key_path: 'query',
  outputFile: 'output_file',
  output_file: 'output_file',
  outputPath: 'output_file',
  output_path: 'output_file',
  toFile: 'output_file',
  to_file: 'output_file'
});

/**
 * `query_json` descriptor — query structured JSON in a virtual file with a jq or
 * JSONPath expression.
 *
 * Args: `file_path` (required), optional `query` and file-sourced
 * `output_file` (extract-to-file). Delegates to `context.virtualFs.queryJson()`
 * and throws when that service is missing.
 */
export const queryJsonDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.QUERY_JSON,
  description: `Query structured JSON data in a virtual file using jq syntax or JSONPath expressions. With output_file the complete serialized result is written to that caller-visible path server-side (never through context) and a write receipt is returned instead of the value. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the JSON file to query. ${PATH_VIEW_HELP}`
      },
      query: {
        type: 'string',
        description: 'jq query or JSONPath expression to execute against the JSON document.'
      },
      output_file: {
        type: 'string',
        description: `Optional caller-visible destination path: write the full serialized query result there and return a receipt instead of the value. ${PATH_VIEW_HELP}`
      }
    },
    required: ['file_path'],
    additionalProperties: false
  }),
  paramAliasMap: queryJsonParamAliasMap,
  sanitize: createVfsParamSanitizer(queryJsonParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.queryJson !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.queryJson(params, context);
  }
});
/** camelCase alias of `queryJsonDescriptor`. */
export const queryJson = queryJsonDescriptor;
/** snake_case alias of `queryJsonDescriptor`. */
export const query_json = queryJsonDescriptor;

// --- 9. json_patch ---
const jsonPatchParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  patchData: 'patch',
  patch_data: 'patch',
  operations: 'patch',
  ops: 'patch'
});

/**
 * `json_patch` descriptor — apply an RFC 6902 patch array to a virtual JSON
 * document atomically.
 *
 * Args: `file_path`, `patch` (both required); each operation may carry inline
 * `value` or a file-sourced `value_file` (mutually exclusive per operation).
 * Delegates to `context.virtualFs.patchJson()` (legacy `jsonPatch` fallback)
 * and throws when that service is missing.
 */
export const jsonPatchDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.JSON_PATCH,
  description: `Apply an array of RFC 6902 JSON Patch operations to a virtual JSON document atomically. Each operation takes inline value or value_file (a caller-visible JSON file whose parsed value fills the operation server-side, never through context); the two are mutually exclusive per operation. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the JSON file to patch. ${PATH_VIEW_HELP}`
      },
      patch: {
        type: 'array',
        description: 'Array of RFC 6902 patch operation objects ({ op, path, value | value_file, from }).',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'],
              description: 'RFC 6902 operation name.'
            },
            path: {
              type: 'string',
              description: 'JSON Pointer path targeted by the operation.'
            },
            value: {
              type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
              description: 'Value payload for add, replace, or test operations (mutually exclusive with value_file).'
            },
            value_file: {
              type: 'string',
              description: `Caller-visible path of a JSON file whose parsed value fills this operation (mutually exclusive with value; resolved with the caller's read rules under the same workspace view). ${PATH_VIEW_HELP}`
            },
            from: {
              type: 'string',
              description: 'Source JSON Pointer path for move or copy operations.'
            }
          },
          required: ['op', 'path'],
          additionalProperties: false
        }
      }
    },
    required: ['file_path', 'patch'],
    additionalProperties: false
  }),
  paramAliasMap: jsonPatchParamAliasMap,
  sanitize: createVfsParamSanitizer(jsonPatchParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || (typeof vfs.patchJson !== 'function' && typeof vfs.jsonPatch !== 'function')) {
      throw new Error('virtualFs service is not available in execution context');
    }
    if (typeof vfs.patchJson === 'function') return await vfs.patchJson(params, context);
    if (typeof vfs.jsonPatch === 'function') return await vfs.jsonPatch(params, context);
    throw new Error('virtualFs service is not available in execution context');
  }
});
/** camelCase alias of `jsonPatchDescriptor`. */
export const jsonPatch = jsonPatchDescriptor;
/** snake_case alias of `jsonPatchDescriptor`. */
export const json_patch = jsonPatchDescriptor;

// --- 10. grep ---
const grepParamAliasMap = Object.freeze({
  searchPattern: 'pattern',
  search_pattern: 'pattern',
  query: 'pattern',
  directory_path: 'path_prefix',
  directoryPath: 'path_prefix',
  dirPath: 'path_prefix',
  dir_path: 'path_prefix',
  pathPrefix: 'path_prefix',
  path_prefix: 'path_prefix',
  path: 'path_prefix',
  isRegex: 'is_regex',
  is_regex: 'is_regex',
  caseSensitive: 'case_insensitive',
  case_sensitive: 'case_insensitive',
  caseInsensitive: 'case_insensitive',
  case_insensitive: 'case_insensitive'
});

/**
 * `grep` descriptor — search workspace files for text or regular expression
 * matches.
 *
 * Args: `pattern` (required), optional `path_prefix`, `is_regex`,
 * `case_insensitive`. Delegates to `context.virtualFs.grep()` and throws when
 * that service is missing.
 */
export const grepDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.GREP,
  description: `Search workspace files for text matches or regular expression patterns. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search string or regular expression pattern.'
      },
      path_prefix: {
        type: 'string',
        description: `Directory path prefix filter (defaults to "/"). ${PATH_VIEW_HELP}`
      },
      is_regex: {
        type: 'boolean',
        description: 'Whether pattern is a regular expression (defaults to false).'
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Whether matching should be case-insensitive (defaults to false).'
      }
    },
    required: ['pattern'],
    additionalProperties: false
  }),
  paramAliasMap: grepParamAliasMap,
  sanitize: createVfsParamSanitizer(grepParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.grep !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.grep(params, context);
  }
});
/** Alias of `grepDescriptor` (single-word canonical name). */
export const grep = grepDescriptor;

// --- 11. set_permissions ---
const setPermissionsParamAliasMap = Object.freeze({
  filePath: 'file_path',
  path: 'file_path',
  targetPath: 'file_path',
  target_path: 'file_path',
  filename: 'file_path',
  file: 'file_path',
  file_name: 'file_path',
  readOnly: 'read_only',
  read_only: 'read_only',
  mode: 'mode',
  owner: 'owner',
  permissions: 'mode',
  permission: 'mode',
  perms: 'mode'
});

/**
 * `set_permissions` descriptor — configure read-only mode, ownership, or mode on
 * a virtual filesystem file.
 *
 * Args: `file_path` (required), optional `read_only`, `owner`, `mode`. Delegates
 * to `context.virtualFs.setPermissions()` and throws when that service is
 * missing.
 */
export const setPermissionsDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.SET_PERMISSIONS,
  description: `Configure access permissions, read-only mode, or ownership on a virtual filesystem file. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path to the target file. ${PATH_VIEW_HELP}`
      },
      read_only: {
        type: 'boolean',
        description: 'Set file read-only (true) or writable (false).'
      },
      owner: {
        type: 'string',
        description: 'Reassign file owner agent ID.'
      },
      mode: {
        type: 'string',
        description: 'Permission mode shorthand (e.g. "r", "rw", "readonly").'
      }
    },
    required: ['file_path'],
    additionalProperties: false
  }),
  paramAliasMap: setPermissionsParamAliasMap,
  sanitize: createVfsParamSanitizer(setPermissionsParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.setPermissions !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.setPermissions(params, context);
  }
});
/** camelCase alias of `setPermissionsDescriptor`. */
export const setPermissions = setPermissionsDescriptor;
/** snake_case alias of `setPermissionsDescriptor`. */
export const set_permissions = setPermissionsDescriptor;

// --- 12. concat_files ---
const concatFilesParamAliasMap = Object.freeze({
  sourcePaths: 'sources',
  source_paths: 'sources',
  sourceFiles: 'sources',
  source_files: 'sources',
  inputs: 'sources',
  files: 'sources',
  parts: 'sources',
  destPath: 'destination',
  dest_path: 'destination',
  destinationPath: 'destination',
  destination_path: 'destination',
  target_path: 'destination',
  targetPath: 'destination',
  output: 'destination',
  delimiter: 'separator',
  joiner: 'separator',
  joinWith: 'separator',
  join_with: 'separator'
});

/**
 * `concat_files` descriptor — concatenate multiple virtual files into one
 * destination file with an optional separator.
 *
 * Args: `sources` (required non-empty array), `destination` (required),
 * optional `separator`. Every source is resolved under the caller's read view
 * and the destination under the caller's write view (no new read powers); all
 * sources are read before a single atomic destination write. Delegates to
 * `context.virtualFs.concatFiles()` and throws when that service is missing.
 */
export const concatFilesDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.CONCAT_FILES,
  description: `Concatenate multiple virtual files into one destination file with an optional separator. Every source resolves under your workspace view with read rules and the destination with write rules; the write is atomic and bounded by the file plumbing caps. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
          description: `Caller-visible source file path. ${PATH_VIEW_HELP}`
        },
        description: `Ordered non-empty list of source file paths to concatenate. ${PATH_VIEW_HELP}`
      },
      destination: {
        type: 'string',
        description: `Destination file path to create or overwrite. ${PATH_VIEW_HELP}`
      },
      separator: {
        type: 'string',
        description: "String inserted between source payloads (defaults to '' — plain concatenation)."
      }
    },
    required: ['sources', 'destination'],
    additionalProperties: false
  }),
  paramAliasMap: concatFilesParamAliasMap,
  sanitize: createVfsParamSanitizer(concatFilesParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const vfs = context?.virtualFs as VirtualFsView | undefined;
    if (!vfs || typeof vfs.concatFiles !== 'function') {
      throw new Error('virtualFs service is not available in execution context');
    }
    return await vfs.concatFiles(params, context);
  }
});
/** camelCase alias of `concatFilesDescriptor`. */
export const concatFiles = concatFilesDescriptor;
/** snake_case alias of `concatFilesDescriptor`. */
export const concat_files = concatFilesDescriptor;

/**
 * Array of all 12 Virtual Filesystem (VFS) Tool Descriptors
 */
export const vfsToolDescriptors = Object.freeze([
  readFileDescriptor,
  writeFileDescriptor,
  replaceFileContentDescriptor,
  copyFileDescriptor,
  deleteFileDescriptor,
  listFilesDescriptor,
  writeJsonDescriptor,
  queryJsonDescriptor,
  jsonPatchDescriptor,
  grepDescriptor,
  setPermissionsDescriptor,
  concatFilesDescriptor
]);
