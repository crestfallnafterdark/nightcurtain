/**
 * Result mapping for extension tool executions.
 *
 * One raw `McpClientToolCallResult` is projected into a sandbox
 * `ToolResult` receipt that is always JSON-serializable, always
 * secret-free, and bounded by {@link EXTENSION_TOOL_RESULT_MAX_CHARS}:
 * server text blocks are joined verbatim, non-text blocks become compact
 * markers that never carry binary data, and `structuredContent` is appended as
 * canonical JSON text. A server-reported `isError: true` becomes the standard
 * failure receipt with code `EXECUTION_FAILED`.
 */

import { TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import type { McpClientToolCallResult } from '../../mcpClient/index.ts';
import type { ToolResult } from '../../toolDefinitions/index.ts';

/**
 * Maximum length of the mapped receipt text (characters). The cap bounds one
 * extension receipt to a small fraction of the model context window; the
 * runtime telemetry convention truncates far smaller audit copies at 2000
 * chars, while a tool receipt must stay useful for document-sized results, so
 * this module defines its own documented bound. Text beyond the cap is
 * replaced with the deterministic
 * `…[truncated <omitted> chars]` marker.
 */
export const EXTENSION_TOOL_RESULT_MAX_CHARS = 20000;

/**
 * Fallback error text used when a server reports a tool failure without any
 * text content to explain it.
 */
const DEFAULT_FAILURE_TEXT = 'The extension tool reported an execution failure without details.';

/**
 * Optional overrides for {@link mapMcpToolResult}.
 */
export interface ExtensionToolResultMappingOptions {
  /**
   * Positive finite maximum mapped text length in characters; defaults to
   * {@link EXTENSION_TOOL_RESULT_MAX_CHARS}.
   */
  readonly maxChars?: number;
}

/**
 * Reports whether a value is a plain non-array object.
 *
 * @param value - Candidate value.
 * @returns `true` for object literals.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Computes the decoded byte length of a base64 payload without decoding it, so
 * binary data never has to leave the marker path.
 *
 * @param data - Base64 text (whitespace ignored).
 * @returns Decoded byte length (0 for empty/absent text).
 */
function base64ByteLength(data: string): number {
  const compact = data.replace(/\s+/g, '');
  if (compact === '') return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

/**
 * Renders one raw MCP content block as mapped text, or `null` when the block
 * carries nothing renderable. Binary channels (`data`/`blob`) are measured or
 * described, never copied.
 *
 * @param block - Raw content block from a tool call result.
 * @returns Mapped text section, or `null`.
 */
function renderContentBlock(block: unknown): string | null {
  if (!isRecord(block)) return null;
  const type = typeof block.type === 'string' && block.type !== '' ? block.type : '';
  if (type === 'text') {
    return typeof block.text === 'string' ? block.text : null;
  }
  if (type === 'image' || type === 'audio') {
    const mime = typeof block.mimeType === 'string' && block.mimeType !== '' ? block.mimeType : 'unknown';
    const bytes = typeof block.data === 'string' ? base64ByteLength(block.data) : 0;
    return `[${type} ${mime} ${bytes}B]`;
  }
  if (type === 'resource') {
    const resource = isRecord(block.resource) ? block.resource : null;
    const uri = resource && typeof resource.uri === 'string' && resource.uri !== '' ? resource.uri : 'unknown';
    const mime = resource && typeof resource.mimeType === 'string' && resource.mimeType !== ''
      ? resource.mimeType
      : 'unknown';
    const marker = `[resource ${uri} ${mime}]`;
    if (resource && typeof resource.text === 'string' && resource.text !== '') {
      return `${marker}\n${resource.text}`;
    }
    return marker;
  }
  if (type === 'resource_link') {
    const uri = typeof block.uri === 'string' && block.uri !== '' ? block.uri : 'unknown';
    const mime = typeof block.mimeType === 'string' && block.mimeType !== '' ? block.mimeType : 'unknown';
    return `[resource_link ${uri} ${mime}]`;
  }
  return type === '' ? null : `[${type} block]`;
}

/**
 * Joins only the text blocks of one result, in order, with blank-line
 * separators (the failure-receipt text channel).
 *
 * @param content - Raw content block list.
 * @returns Joined text, or an empty string when no text block carries text.
 */
function joinTextBlocks(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n\n');
}

/**
 * Serializes a structured payload when JSON can represent it.
 *
 * @param value - Candidate payload.
 * @returns Canonical JSON text, or `null` when serialization fails or yields
 *   no JSON value.
 */
function safeJsonStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Applies the mapped-text cap with the deterministic truncation marker.
 *
 * @param text - Full mapped text.
 * @param maxChars - Positive character cap.
 * @returns The text, or its capped prefix plus `…[truncated N chars]`.
 */
function truncateMappedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

/**
 * Resolves and validates the effective mapped-text cap.
 *
 * @param options - Mapping options.
 * @returns The effective cap.
 * @throws `TypeError` - When the options object or `maxChars` is malformed.
 */
function resolveMaxChars(options: ExtensionToolResultMappingOptions): number {
  if (!isRecord(options)) {
    throw new TypeError('mapMcpToolResult options must be an object when present');
  }
  const value = options.maxChars;
  if (value === undefined) return EXTENSION_TOOL_RESULT_MAX_CHARS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('mapMcpToolResult options.maxChars must be a positive finite number');
  }
  return Math.floor(value);
}

/**
 * Maps one MCP tool call result into a sandbox `ToolResult` receipt.
 *
 * Success receipts join text blocks verbatim, render non-text blocks as compact
 * markers (`[image <mime> <bytes>B]`, `[resource <uri> <mime>]` plus inline
 * resource text), append `structuredContent` as JSON text when serializable,
 * and cap the total mapped text with the
 * `…[truncated <omitted> chars]` marker. Failure receipts (`isError === true`)
 * carry the joined text (or a generic fallback) and code `EXECUTION_FAILED`.
 * Binary/base64 data never enters the receipt.
 *
 * @param result - Raw result returned by an MCP session call.
 * @param options - Optional mapped-text cap override.
 * @returns A frozen success or failure `ToolResult` receipt.
 * @throws `TypeError` - When the result or options shape is malformed.
 *
 * @example
 * ```typescript
 * import { mapMcpToolResult } from './tools/extensionTools/index.ts';
 *
 * const receipt = mapMcpToolResult({
 *   content: [{ type: 'text', text: 'hello' }],
 *   isError: false
 * });
 * // receipt => { success: true, content: 'hello' }
 * ```
 */
export function mapMcpToolResult(
  result: McpClientToolCallResult,
  options: ExtensionToolResultMappingOptions = {}
): ToolResult {
  if (!isRecord(result)) {
    throw new TypeError('mapMcpToolResult requires a tool call result object');
  }
  if (!Array.isArray(result.content)) {
    throw new TypeError("mapMcpToolResult requires the result 'content' array");
  }
  const maxChars = resolveMaxChars(options);

  if (result.isError === true) {
    const text = joinTextBlocks(result.content);
    const error = truncateMappedText(text === '' ? DEFAULT_FAILURE_TEXT : text, maxChars);
    return Object.freeze({
      success: false as const,
      error,
      code: TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED
    });
  }

  const sections: string[] = [];
  for (const block of result.content) {
    const section = renderContentBlock(block);
    if (section !== null && section !== '') sections.push(section);
  }
  if (result.structuredContent !== undefined) {
    const structured = safeJsonStringify(result.structuredContent);
    if (structured !== null) sections.push(structured);
  }

  return Object.freeze({
    success: true as const,
    content: truncateMappedText(sections.join('\n\n'), maxChars)
  });
}
