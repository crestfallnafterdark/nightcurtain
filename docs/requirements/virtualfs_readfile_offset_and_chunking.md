# Requirements: VirtualFS ReadFile Pagination, Offset & Line-Slicing Resilience

**Status:** RATIFIED
**Last verified: 2026-09-17**
**Version:** 1.0
**Date:** 2026-09-13
**Scope owner:** Project owner
**Related systems:** VirtualFS, Sandbox Tool Definitions, Dispatcher, Telemetry, AgentRuntime

---

## 1. Purpose & Problem Statement

When agents read large workspace files (such as world lore files, large transcripts, or source documents exceeding the default 20,000-byte budget limit), `virtualFs_readFile` returns truncated content with a notice instructing the model to invoke `readFile` with `offset: <nextOffset>` or `startLine: <nextLine>`.

However, the model fails to paginate through large files due to the following defects in `virtualFs/index.ts` and `toolDefinitions/index.ts`:

1. **Option Extraction Drop on Object Invocations in `virtualFs.readFile`**:
   - `toolDefinitions/index.ts` invokes `virtualFs.readFile({ filePath, workspaceId, callerAgentId, ...readOpts })` passing a single parameter object.
   - In `virtualFs.readFile(arg1, arg2, arg3, arg4)`, when `arg1` is an object, `options` is initialized via `sanitizeFsOptions({}, trusted)` where `trusted` is derived from `arg2`/`arg3`/`arg4`.
   - Because `arg2`–`arg4` are undefined, `options` becomes an empty object `{}`.
   - Consequently, `options.offset`, `options.limit`, `options.startLine`, `options.endLine`, `options.budgetBytes`, and `options.raw` are completely lost. `offset` always evaluates to `undefined`, resetting the read position to byte 0 and causing the model to get stuck re-reading the first chunk in an infinite loop.

2. **Parameter Naming & Casing Inconsistencies**:
   - LLM models emit both snake_case and camelCase argument names (e.g., `start_line`, `end_line`, `byte_offset`, `content_offset`, `budget_bytes`, `max_words`).
   - `toolDefinitions/index.ts` and `virtualFs/index.ts` do not universally normalize snake_case and alias properties into canonical options.

3. **String Numeric Coercion Failure**:
   - LLMs frequently emit numeric arguments as strings (e.g., `{"offset": "20000"}`, `{"start_line": "100"}`).
   - Strict `typeof offset === 'number'` checks evaluate to `false`, causing the runtime to fall back to `0` or `undefined`.

4. **Line-Slicing Budgeting Defect**:
   - When a model passes `startLine: 100` without specifying `endLine` for a 2,000-line file, `endLine` defaults to `totalLines`, returning all remaining 1,900 lines and overflowing the model's context budget.

5. **Misleading Delivery Metadata**:
   - `toolDefinitions/index.ts` attaches `deliveryNote: 'Complete file content delivered in full.'` even when `result.truncated === true`, confusing models that inspect delivery notes.

6. **Systemic `sanitizeFsOptions` Call Pattern**:
   - Across `virtualFs/index.ts` (`readFile`, `replaceFileContent`, `queryJson`, `jsonPatch`, `writeJson`, `listFiles`, `grep`), object-destructuring overloads call `sanitizeFsOptions({}, trusted)` rather than passing `arg1` as the untrusted options payload, risking similar option drops.

---

## 2. Functional Requirements

### R1 — Object-Destructuring Option Preservation in `virtualFs/index.ts`
- **R1.1** In `virtualFs.readFile(arg1, arg2, arg3, arg4)`, when `arg1` is an object, options must be extracted directly from `arg1` (e.g., `sanitizeFsOptions(arg1, trusted)` or merged with `arg1`).
- **R1.2** All options (`offset`, `limit`, `startLine`, `endLine`, `budgetBytes`, `maxWords`, `budgetWords`, `raw`, `structured`) passed in `arg1` must be preserved and honored.
- **R1.3** Audit and align all other `virtualFs` methods (`replaceFileContent`, `queryJson`, `jsonPatch`, `writeJson`, `listFiles`, `grep`) to ensure options in `arg1` are never discarded.

### R2 — Universal Parameter Alias & Casing Normalization
- **R2.1** `virtualFs.readFile` and the tool dispatcher in `toolDefinitions/index.ts` must normalize all of the following aliases:
  - **Offset**: `offset`, `byte_offset`, `byteOffset`, `content_offset`, `contentOffset`, `ContentOffset`, `start_offset`, `startOffset`.
  - **Limit**: `limit`, `byte_limit`, `byteLimit`, `max_bytes`, `maxBytes`, `length`.
  - **Start Line**: `startLine`, `start_line`, `StartLine`, `from_line`, `fromLine`.
  - **End Line**: `endLine`, `end_line`, `EndLine`, `to_line`, `toLine`.
  - **Budget Bytes**: `budgetBytes`, `budget_bytes`, `maxBytes`, `max_bytes`.
  - **Max Words**: `maxWords`, `max_words`, `budgetWords`, `budget_words`.
- **R2.2** Universal numeric coercion: Any integer parameter passed as a numeric string (e.g., `"20000"`, `" 50 "`) must be cleanly parsed into a finite integer via `parseInt(String(val).trim(), 10)`. Non-finite or negative values must gracefully fall back to default behavior.

### R3 — Offset Pagination & Slicing Semantics
- **R3.1** Slicing with `offset` and `limit` must accurately return `fullContent.slice(offset, offset + limit)`.
- **R3.2** `nextOffset` must be set to `offset + slicedContent.length` when `offset + slicedContent.length < fullContent.length`, and `undefined` when the end of file is reached.
- **R3.3** `remainingBytes` must accurately report `Math.max(0, totalBytes - (offset + sliceBytes))`.
- **R3.4** If `offset >= totalBytes`, `readFile` must return empty content (`""`) with `truncated: false`, `remainingBytes: 0`, and `nextOffset: undefined`.

### R4 — Budgeted Line Slicing
- **R4.1** When `startLine` is specified without `endLine`:
  - If the remaining lines from `startLine` to `totalLines` exceed `budgetLimit`, `virtualFs.readFile` must calculate an appropriate `endLine` that fits within the byte budget (or default max line window), setting `truncated: true`, `nextLine: calculatedEndLine + 1`, and an informative notice.
- **R4.2** When `startLine` and `endLine` are both specified, format output with 1-indexed line numbers (`<line>: <content>`).

### R5 — Delivery Note & Metadata Integrity in `toolDefinitions/index.ts`
- **R5.1** When `result.truncated === true`, `deliveryNote` in `toolDefinitions/index.ts` must accurately state:
  `"File content partially delivered (${bytesIncluded || sliceBytes} bytes). Truncated: true. Next offset: ${nextOffset} (or next startLine: ${nextLine})."`
- **R5.2** When `result.truncated === false`, `deliveryNote` must state:
  `"Complete file content delivered in full."`

---

## 3. Acceptance Criteria

1. **[AC-READ-01] Offset Pagination**: Invoking `virtualFs_readFile` with `{ filePath: '/large.md', offset: 20000, limit: 10000 }` returns the exact slice from byte 20,000 to 30,000 with `nextOffset: 30000` and `truncated: true`.
2. **[AC-READ-02] Consecutive Offset Continuity**: Reading a 60KB file in three 20KB chunks (`offset: 0`, `offset: 20000`, `offset: 40000`) and concatenating the chunks produces the exact original file content with zero missing or repeated characters.
3. **[AC-READ-03] Snake_Case & Alias Support**: Invoking `virtualFs_readFile` with `start_line`, `end_line`, `byte_offset`, `content_offset`, `budget_bytes`, or `max_words` behaves identically to their camelCase counterparts.
4. **[AC-READ-04] String Numeric Coercion**: Invoking `virtualFs_readFile` with `{"offset": "20000", "limit": "10000"}` or `{"start_line": "50", "end_line": "100"}` successfully slices at byte 20,000 and lines 50–100 without falling back to 0 or 1.
5. **[AC-READ-05] Object-Argument Preservation**: Calling `virtualFs.readFile({ filePath: '...', offset: 15000 })` directly on `VirtualFS` preserves all options.
6. **[AC-READ-06] Budgeted Line Slicing**: Calling `virtualFs_readFile` on a 5,000-line file with `start_line: 100` and no `end_line` bounds the returned output within budget and provides `nextLine`.
7. **[AC-READ-07] Accurate Delivery Notes**: `deliveryNote` accurately indicates partial delivery when truncated.
8. **[AC-READ-08] Zero-Mock QA Verification**: `tests/integration/virtual_fs_pagination_test.js` passes 100% and `npm run build` exits with code 0.
