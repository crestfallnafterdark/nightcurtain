/**
 * @packageDocumentation
 * Provider-Payload Message Hygiene & Historical Tool Compaction (Module 33: runtime_lifecycle).
 *
 * Home for the provider-facing history sanitizer: it repairs assistant/tool call pairing,
 * enforces the reasoning-content string invariant, evicts completed-turn reasoning, and
 * tombstones historical tool receipts so past turns stop costing context.
 *
 * @module runtime/messageHygiene
 * @invariant INV-REASONING-STRING: every assistant message `formatMessagesWithToolHygiene` emits carries `reasoning_content` as a string primitive (default `''`), and completed-turn reasoning is blanked when `evictCompletedReasoning` is true.
 * @invariant INV-TOOL-PAIRING: an assistant message declaring `tool_calls` survives with them only for a single-assistant history or when every declared id has a matching tool response; otherwise the unfulfilled `tool_calls` are dropped and empty content is normalized to `''`. A tool response is dropped as orphaned when at least one assistant message exists and its `tool_call_id` matches no active declared call.
 * @invariant INV-DEEP-COPY: inbound messages are deep-cloned (`structuredClone`, JSON round-trip fallback) before normalization and each emitted message carries a shallow-copied `metadata`, so caller objects are never mutated.
 * @invariant INV-HISTORICAL-COMPACTION: only tool receipts preceding a later user/system turn are passed through `compactHistoricalToolContent`; active-turn receipts, `compactHistoricalTools: false`, and message-passing/invocation tools are never compacted, and payloads already marked `compacted: true` are returned verbatim.
 * @decision Hygiene lives in its own `runtime/messageHygiene` module rather than inside `turnExecutionEngine`: the sanitizer is provider-payload hygiene, and the engine surface changes only by its import
 * @decision Byte counts for historical `virtualFs_readFile` compaction use the web-standard `TextEncoder` directly; the legacy `Buffer` import and `window`/`globalThis` shim block are not ported (available in Node 11 and later and in all target browsers)
 */

export {
  formatMessagesWithToolHygiene
} from './formatMessages.ts';

export {
  compactHistoricalToolContent,
  normalizeToolName,
  HISTORICAL_TOOL_ALIASES,
  MESSAGE_PASSING_EXCLUSIONS
} from './toolCompaction.ts';
