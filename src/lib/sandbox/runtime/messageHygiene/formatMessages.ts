/**
 * Provider-payload message hygiene: tool-pairing repair, reasoning eviction, and
 * historical tool-receipt compaction for OpenAI/DeepSeek chat-completion histories.
 * Relocated from the legacy `api/hygiene/messageHygiene.js` sanitizer.
 */

import { compactHistoricalToolContent } from './toolCompaction.ts';

/**
 * Arbitrary metadata attached to a history message.
 */
type MessageMetadata = Record<string, unknown>;

/**
 * Tool call as it may arrive on an inbound history message.
 */
interface RawToolCall {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
}

/**
 * Loose structural view of an inbound history message.
 */
interface RawMessage {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  thought?: unknown;
  metadata?: MessageMetadata;
  id?: unknown;
  tool_calls?: RawToolCall[];
  tool_call_id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/**
 * Tool call shape emitted by the hygiene pass.
 */
interface EmittedToolCall {
  id: string;
  type?: unknown;
  function: { name: string; arguments: string };
}

/**
 * Message shape emitted by the hygiene pass.
 */
interface EmittedMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  metadata?: MessageMetadata;
  id?: unknown;
  tool_calls?: EmittedToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Deep-clones an inbound message so callers' objects are never mutated in place.
 * Prefers `structuredClone` and falls back to a JSON round-trip when it is absent
 * or throws on the value.
 *
 * @param rawMsg - Inbound message object
 * @returns An independent copy of the message
 */
function deepCloneMessage(rawMsg: RawMessage): RawMessage {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(rawMsg);
    } catch (_) {
      return JSON.parse(JSON.stringify(rawMsg)) as RawMessage;
    }
  }
  return JSON.parse(JSON.stringify(rawMsg)) as RawMessage;
}

/**
 * Validates and formats chat history ensuring strict context hygiene for the OpenAI/DeepSeek tool-calling protocol:
 * assistant messages declaring `tool_calls` keep valid structure, `tool` receipts keep a matching `tool_call_id`,
 * orphaned tool receipts are dropped, broken tool sequences are repaired, unfulfilled tool calls are pruned,
 * completed-turn reasoning is evicted, and historical tool receipts are compacted.
 *
 * @param messages - Raw conversation history of unknown shape; non-arrays yield an empty result
 * @param options - Hygiene switches; both default to `true`: `evictCompletedReasoning` blanks `reasoning_content` on assistant turns that have a later user/system turn, and `compactHistoricalTools` compacts tool receipts that belong to completed turns
 * @returns Sanitized message history conforming to the OpenAI/DeepSeek schema
 */
export function formatMessagesWithToolHygiene(
  messages: unknown,
  options: { evictCompletedReasoning?: boolean; compactHistoricalTools?: boolean } = {}
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const { evictCompletedReasoning = true, compactHistoricalTools = true } = options;

  // Pass 1: Normalize all valid messages and record declared tool call IDs and provided tool responses
  // Use deep copies so caller message objects are never mutated in-place
  const normalized: EmittedMessage[] = [];
  const toolResponseIds = new Set<string>();
  const toolCallIdToNameMap = new Map<string, string>();

  for (const rawMsg of messages) {
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const msg = deepCloneMessage(rawMsg as RawMessage);
    const role = msg.role;

    if (role === 'system' || role === 'user') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content !== undefined && msg.content !== null ? String(msg.content) : '');
      const entry: EmittedMessage = { role: String(role), content };
      if (msg.id) entry.id = msg.id;
      if (msg.metadata) entry.metadata = { ...msg.metadata };
      normalized.push(entry);
    } else if (role === 'assistant') {
      const formatted: EmittedMessage = { role: 'assistant' };
      if (msg.id) formatted.id = msg.id;
      if (msg.metadata) formatted.metadata = { ...msg.metadata };
      if (msg.content !== undefined && msg.content !== null) {
        formatted.content = typeof msg.content === 'string' ? msg.content : String(msg.content);
      } else {
        formatted.content = null;
      }
      const metadataReasoning = msg.metadata?.reasoning_content || msg.metadata?.reasoning;
      const reasoningVal = (msg.reasoning_content !== undefined && msg.reasoning_content !== null)
        ? String(msg.reasoning_content)
        : (msg.reasoning ? String(msg.reasoning) : (msg.thought ? String(msg.thought) : (metadataReasoning ? String(metadataReasoning) : '')));
      formatted.reasoning_content = reasoningVal;

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        formatted.tool_calls = msg.tool_calls.map((tc: RawToolCall) => {
          const tcId = String(tc.id || '');
          const tcName = String(tc.function?.name || tc.name || '');
          if (tcId && tcName) {
            toolCallIdToNameMap.set(tcId, tcName);
          }
          return {
            id: tcId,
            type: tc.type || 'function',
            function: {
              name: tcName,
              arguments: typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : (JSON.stringify(tc.function?.arguments !== undefined && tc.function?.arguments !== null ? tc.function.arguments : (tc.arguments || {})) as string)
            }
          };
        });
      }

      normalized.push(formatted);
    } else if (role === 'tool') {
      const toolCallId = String(msg.tool_call_id || msg.toolCallId || msg.id || '');
      const content = typeof msg.content === 'string'
        ? msg.content
        : (JSON.stringify(msg.content !== undefined ? msg.content : null) as string);

      const toolMsg: EmittedMessage = {
        role: 'tool',
        tool_call_id: toolCallId,
        content
      };
      if (msg.id) toolMsg.id = msg.id;
      if (msg.metadata) toolMsg.metadata = { ...msg.metadata };
      if (msg.name) {
        toolMsg.name = String(msg.name);
        if (toolCallId) {
          toolCallIdToNameMap.set(toolCallId, toolMsg.name);
        }
      }
      if (toolCallId) {
        toolResponseIds.add(toolCallId);
      }
      normalized.push(toolMsg);
    }
  }

  // Pass 2: Sequence & Hygiene Validation
  const cleaned: EmittedMessage[] = [];
  const activeExpectedToolCalls = new Set<string>();
  const hasAnyAssistant = normalized.some(m => m.role === 'assistant');
  const isSingleAssistant = normalized.length === 1 && normalized[0].role === 'assistant';

  for (let i = 0; i < normalized.length; i++) {
    const msg = normalized[i];

    const cloneMsg = (m: EmittedMessage): EmittedMessage => {
      const c: EmittedMessage = { ...m };
      if (m.metadata) c.metadata = { ...m.metadata };
      return c;
    };

    if (msg.role === 'system' || msg.role === 'user') {
      activeExpectedToolCalls.clear();
      cleaned.push(cloneMsg(msg));
    } else if (msg.role === 'assistant') {
      activeExpectedToolCalls.clear();

      const hasSubsequentTurn = normalized.slice(i + 1).some(m => m.role === 'user' || m.role === 'system');
      const shouldEvict = evictCompletedReasoning && hasSubsequentTurn;
      const effectiveReasoning = shouldEvict
        ? ''
        : ((msg.reasoning_content !== undefined && msg.reasoning_content !== null) ? String(msg.reasoning_content) : '');

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        if (isSingleAssistant) {
          for (const tc of msg.tool_calls) {
            if (tc.id) activeExpectedToolCalls.add(tc.id);
          }
          const assistantEntry = cloneMsg(msg);
          assistantEntry.reasoning_content = effectiveReasoning;
          cleaned.push(assistantEntry);
        } else {
          const allFulfilled = msg.tool_calls.length > 0 && msg.tool_calls.every(tc => tc.id && toolResponseIds.has(tc.id));
          if (allFulfilled) {
            const assistantEntry = cloneMsg(msg);
            assistantEntry.tool_calls = msg.tool_calls.map(tc => ({
              id: tc.id,
              type: tc.type || 'function',
              function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '{}'
              }
            }));
            assistantEntry.reasoning_content = effectiveReasoning;
            for (const fc of msg.tool_calls) {
              if (fc.id) activeExpectedToolCalls.add(fc.id);
            }
            cleaned.push(assistantEntry);
          } else {
            const assistantEntry = cloneMsg(msg);
            assistantEntry.content = (msg.content === null || msg.content === undefined) ? '' : msg.content;
            assistantEntry.reasoning_content = effectiveReasoning;
            delete assistantEntry.tool_calls;
            cleaned.push(assistantEntry);
          }
        }
      } else {
        const assistantEntry = cloneMsg(msg);
        assistantEntry.reasoning_content = effectiveReasoning;
        cleaned.push(assistantEntry);
      }
    } else if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id || '';
      const isMatched = toolCallId !== '' && activeExpectedToolCalls.has(toolCallId);
      const isStandalone = !hasAnyAssistant;

      if (isMatched || isStandalone) {
        const toolMsg = cloneMsg(msg);
        const hasSubsequentTurn = normalized.slice(i + 1).some(m => m.role === 'user' || m.role === 'system');
        if (compactHistoricalTools && hasSubsequentTurn) {
          const toolName = toolMsg.name || toolCallIdToNameMap.get(toolCallId) || '';
          toolMsg.content = compactHistoricalToolContent(toolName, toolMsg.content) as string | null;
        }
        cleaned.push(toolMsg);
        if (isMatched) {
          activeExpectedToolCalls.delete(toolCallId);
        }
      } else {
        console.warn(`[ToolHygiene] Dropping orphaned tool response for call ID: ${msg.tool_call_id}`);
      }
    }
  }

  return cleaned;
}
