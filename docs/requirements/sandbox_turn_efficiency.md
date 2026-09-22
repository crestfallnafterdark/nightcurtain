# Requirements: Sandbox Turn-Efficiency — Mail Injection, Terminal Batches & Precalls

**Status:** RATIFIED
**Last verified: 2026-09-22**
**Version:** 1.1
**Date:** 2026-09-13
**Changelog:** 1.1 — folded in tool-level injection validation (API contract, ordering, precall execution, closing-summary carrier).
**Scope owner:** Project owner
**Related systems:** Multi-agent sandbox runtime, AgentRuntime, MessagingBus, tool layer, persistence, telemetry

> **Naming note (2026-09-17):** The terminal/precall tool described here as `runtime_batchPrecall` was canonically renamed to `batch_precall` (see `src/lib/sandbox/tools/constants/index.ts` and `src/lib/sandbox/tools/descriptors/precallTools.ts`). The historical name is retained throughout this ratified document as design provenance.

---

## 1. Purpose and Background

The three-tier agent architecture (Director, Narrator, spawned NPC actors) produces significantly better stories than the legacy single-storyteller design and is the intended direction. However, an early multi-turn test play consumed approximately **20M input tokens** with a **>98% cache hit rate**, which is too expensive to operate at scale. Runtime stability is also a standing concern.

**Root cause of cost.** Every tool call requires a full LLM inference round trip that re-sends the entire context. The architectural pattern of 6–8 tool calls per turn per agent, across roughly 4 agents for 12 turns, produces hundreds of full-context requests. Because the prefix is overwhelmingly cache hits, reducing *within-turn context* would yield limited savings and would harm quality. The achievable saving comes from **eliminating entire inference round trips** while keeping the context the model sees within a turn intact.

**Quality constraint (non-negotiable).** The full context of an active turn must remain available within that turn. Reasoning/thinking must round-trip (OpenAI-style `reasoning_content`) to preserve interleaved-thinking continuity. No within-turn eviction of context or reasoning.

**Objective.** Convert the "mechanical" portions of a turn (mail retrieval, context reads, post-action closing) from inference round trips into runtime work, without removing any information from the model's active context and without degrading story quality.

---

## 2. Scope

### In scope
- Mail delivery injection (eliminate the notification → read-decision round trip)
- Terminal turn batches via the `runtime_batchPrecall` tool (eliminate the trailing "closing" inference)
- Precalls: context reads requested at turn end, executed at next turn start (eliminate read-decision round trips)
- Synthetic assistant/tool exchange contracts for injected deliveries and precalls
- Failure semantics
- Compatibility with existing native compaction
- Telemetry/observability sufficient to verify the savings

### Out of scope (deferred, explicitly)
- Tool catalog reduction, merging, or retirement (decision: keep existing tools dispatchable for now)
- Tool schema slimming (alias params, description trimming)
- Rewriting Director/Narrator prompts to match the new protocol (separate follow-up; the prompt will be updated after these changes land)
- Reworking the invocation system (decision: invocation stays as-is; the mail path is used)
- Changes to compaction policy beyond compatibility (e.g., turn-stamped compaction is not required while the notification boundary is preserved)

---

## 3. Terminology

- **Call / round trip:** one LLM inference request.
- **Turn:** one agent execution from trigger to completion.
- **Terminal turn:** a turn that completes without a follow-up inference.
- **Precall:** a read/observe tool call requested at turn end, executed at the start of the next turn.
- **Injected exchange:** runtime-synthesized assistant/tool messages appended to an agent's history.
- **Native compaction:** the existing mechanism that replaces historical tool results with lightweight tombstones on later turns.
- **Notification boundary:** the user-role wake message that marks the start of a turn and enables compaction of earlier tool results.

---

## 4. Current Mechanisms Relevant to These Requirements

- Mail arrival currently wakes the agent with a user-role notification message; the agent must spend an inference to decide to read mail, then another inference to process it.
- The existing compaction mechanism tombstones a tool result only when a later user-role or system-role message exists in history (i.e., a turn boundary). Preserving a user-role notification at each wake keeps compaction functioning without any structural change.
- Interleaved-thinking histories permit assistant messages with empty or minimal text/partial reasoning, provided tool-call/result pairing is valid.
- Tool results are recognized for compaction by tool name and result shape. Synthesized results that follow the same shape compact exactly like organic results.

---

## 5. Functional Requirements

### R1 — Mail Injection

- **R1.1** On a mail-triggered wake, the message content must be placed into the agent's context without requiring an additional model inference to decide to read it.
- **R1.2** A user-role notification must still be present at wake so the turn boundary exists and native compaction continues to trigger on subsequent turns.
- **R1.3** The message bodies must be delivered as the result of a normal read/mail tool call exchange (assistant tool call plus matching tool result) so that existing compaction treats them identically to organic reads.
- **R1.4** Injected messages must be marked read/archived as part of injection. No duplicate delivery. Re-inspection of an injected message must remain possible by ID or sender.
- **R1.5** When multiple messages are pending, they must coalesce into a single injected delivery and a single turn. This also mitigates wake storms.
- **R1.6** The injected exchange must be a well-formed assistant(tool call) + tool(result) pair. The assistant message may carry synthesized reasoning/text or be content-empty; both are valid under interleaved thinking. Whenever the assistant message carries tool calls it **must include `reasoning_content` as a string** (see R4.2); `""` is valid.
- **R1.7** Injection must not bypass tool permissions, message auditing, sender integrity, or agent lifecycle checks.

### R2 — Terminal Batches (`runtime_batchPrecall`)

- **R2.1** An agent must be able to explicitly end its turn by emitting `runtime_batchPrecall` as part of its tool batch.
- **R2.2** If a terminal batch contains no tool errors, the runtime must execute all calls and **not** perform another inference. The turn ends.
- **R2.3** If any tool call in the batch fails, the turn must **not** terminate; the model must be called back with the failures so it can handle them.
- **R2.4** The model's closing summary is carried as a **required `summary` argument of the terminal call** (terminal signature: `{ summary, calls }`). No additional inference is used to produce it. Rationale: on the tested thinking model, assistant messages that carry tool calls have empty visible `content`, so the closing memory cannot be relied upon to survive as assistant text; a tool argument is reliable.
- **R2.5** The terminal call must still receive a tool response in history so that the history remains protocol-valid (every tool call has a matching result).
- **R2.6** The terminal semantics — the `summary` field, the precall list, and the expected `reasoning_content` convention — must be defined by the `runtime_batchPrecall` tool specification itself, so that model-authored terminal turns and runtime-synthesized injected turns share one exchange shape.
- **R2.7** Update/action calls (state writes, event operations, clock advances, message sends, agent spawns) may appear in the same batch as the terminal call; they are executed normally.

### R3 — Precalls

- **R3.1** `runtime_batchPrecall` accepts a terminal `summary` plus a list of tool calls to pre-execute on the agent's behalf (arguments: `{ summary, calls: [{ name, arguments }] }`).
- **R3.2** Precalls execute at the **start of the next turn**, after the Narrator's move has been delivered, so that preloaded data is fresh and present before the model infers.
- **R3.3** Precall results are appended as ordinary tool results matching their calls; native compaction applies to them.
- **R3.4** Precalls are restricted to read/observe operations. The ratified allowlist is:
  - Filesystem: read file, query JSON, grep, list files
  - Time/world: wall-clock read; world-clock query; event query
  - Runtime: list agents, whoami
  - Mail: list inbox, read message, get archive
  Tools with mixed read/write semantics must be forced to their query form or excluded. Sends, writes, spawns, kills, schedule mutations, and invocations are forbidden as precalls.
- **R3.5** Precall failures are ordinary tool failures; they appear in context and the model handles them. Consistent with R2.3, a failed precall must not result in silent termination.
- **R3.6** Pending precalls must survive session save/restore and must be discarded when the agent is terminated or purged.
- **R3.7** Precalls must never mutate state or contact other agents.

### R4 — Injected Exchange Ordering (Next Turn)

- **R4.1** At the start of a turn, history is appended in this order:
  1. **Notification** (user-role) — wake notice and turn boundary
  2. **Synthesized assistant message** — reasoning/text covering the mail read and the precall declaration (shape defined by the `runtime_batchPrecall` tool specification)
  3. **Tool responses** — the message read result plus all precall results
  4. The model's inference then runs over the completed context
- **R4.2** The synthesized assistant message must be consistent with interleaved-thinking history: valid tool-call/result pairing; reasoning/text permitted; empty text permitted. **Hard provider requirement (validated on DeepSeek `deepseek-flash` thinking mode):** an assistant message carrying `tool_calls` **must** include `reasoning_content` as a string; omitting it is rejected (`HTTP 400`, "The `reasoning_content` in the thinking mode must be passed back to the API"). Empty string `""` and whitespace are accepted; non-string values are rejected. Text-only assistant turns may omit it.
- **R4.3** All injection and precall exchanges must be append-only. No rewriting of earlier history.
- **R4.4** The leading user-role notification is mandatory. Validated: starting a turn with the synthetic assistant turn and no notification causes the agent to re-issue the mail read and the state queries, producing duplicate tool calls.
- **R4.5** Injected reasoning must be **truthful, mechanical, and non-contradictory** — limited to the reads and precalls actually performed. Validated behavior: benign mechanical reasoning is adopted as the agent's own prior cognition (no meta-awareness, no duplicated calls), whereas salient adversarial reasoning (an injected harmful intent) triggers metacognition and is rejected, and injected "facts" that contradict tool results are corrected by the tool data. Never inject intents, decisions, or fabricated facts.

### R5 — Failure Semantics

- **R5.1** Any tool error in a turn prevents silent termination; the model is informed and given the opportunity to react.
- **R5.2** Failures are recorded as normal tool results and compact like any other tool result.
- **R5.3** Tool failures are expected to be rare for well-formed tools; no special failure-recovery protocol is required beyond the above.

### R6 — Compaction Compatibility

- **R6.1** Injected and precall tool results must be tombstoned by the existing compaction rules on later turns without special-casing.
- **R6.2** The user-role notification must be preserved at each wake so compaction continues to detect turn boundaries.
- **R6.3** No within-turn eviction of context or reasoning is permitted.

### R7 — Observability

- **R7.1** Telemetry must expose, per agent and per turn: inference call count, terminal stops, injected deliveries, precall count and results, and token usage per call, sufficient to measure the reduction against the current baseline.
- **R7.2** Synthetic/injected messages must be distinguishable in UI and telemetry without leaking runtime-only metadata to model providers.

### R8 — Quality Safeguards

- **R8.1** The chosen delivery strategy is **full synthetic injection** (runtime-synthesized exchanges). A switchable fallback delivery mode must be reserved in case model coherence regresses; it need not be enabled initially.
- **R8.2** The change must be evaluated for story-quality regression against the current architecture before being considered complete.

---

## 6. Acceptance Criteria

1. A mail-triggered turn requires **zero** model inferences to read the delivered mail.
2. A scene requiring no reads and no spawns completes in a **single model pass** when the model emits a terminal batch (baseline: roughly 6–10 Director calls).
3. History remains protocol-valid after every terminal turn and injection: every tool call has a matching result; no orphaned calls.
4. Injected tool results compact on subsequent turns exactly like organic tool results.
5. Any failed tool call in a batch causes a callback; no silent termination.
6. Precalls execute at next-turn start and appear in history as normal call/result pairs; failures surface to the model.
7. Telemetry demonstrates the call-count and input-token reduction.
8. No observed quality regression relative to the current architecture.
9. Every synthetic assistant message that carries tool calls includes a string `reasoning_content` (empty allowed); the provider never returns a 400 for the injected exchange.
10. The turn's closing summary is persisted via the terminal call's `summary` argument.

---

## 7. Decisions Ratified During Design

- Use the **mail path**, not invocation rework. Invocation remains unchanged; its purpose is human-like system/message communication.
- **Full synthetic injection first**; fallback mode only if model coherence suffers.
- **Keep the user notification** at wakes to preserve compaction boundaries and avoid turn-stamping changes.
- **Any tool error causes a callback.**
- **Closing summary** is carried in the terminal call's required `summary` argument (assistant text is unreliable on tool-call messages). If the model fails to summarize, that is addressed later.
- **`reasoning_content` on synthetic turns:** required as a string on any assistant turn carrying tool calls; `""` is acceptable.
- **Injection order validated:** notification → synthetic assistant → tool results. The notification is load-bearing; without it the agent duplicates the reads.
- **Injected reasoning is mechanical only:** bind it to the reads/precalls actually performed; never inject intents, decisions, or fabricated facts.
- **Tool retirement, merging, and schema slimming deferred**; existing tools remain available.
- **Tool naming:** the terminal/precall tool lives in the runtime namespace as `runtime_batchPrecall`, consistent with `runtime_schedule`, `runtime_spawnAgent`, `runtime_waitForMail`, etc. Arguments: `{ summary, calls: [{ name, arguments }] }`.
- **Precall allowlist:** ratified as written in R3.4.
- **Document location:** `docs/requirements/sandbox_turn_efficiency.md`.

---

## 8. Deferred / Follow-Up Work

- **Director Protocol split — delivered** (story-independent protocol layer separated from story-pack content; story packs are not shipped in this repository).
- Narrator and NPC prompt updates to operate under the terminal/precall protocol (Director done; Narrator/NPC pending).
- Tool catalog reduction investigations: schedule trio merge, whoami/listAgents merge, `writeJson` fold into `writeFile`, redundant `getInbox` retirement, lab-only tool scoping, and alias-parameter schema slimming.
- Compaction policy tuning and cache-hit measurement post-implementation.
- Removing the fallback delivery mode once full injection is proven in production.

---

## 9. Empirical Validation (Tool-Level)

Validated on a live DeepSeek `deepseek-flash` (thinking mode, `reasoning_effort: "max"`) harness in `scratch/injection_hypothesis/` (see `FINDINGS.md`, `BEATS_COMPARISON.md`).

- **Provider contract:** assistant turns carrying tool calls require a string `reasoning_content`; omission → `HTTP 400`. Empty string and whitespace accepted; non-string rejected. Text-only assistant turns may omit it. Every response returns `reasoning_content`.
- **Injection order:** `notification → synthetic assistant(reasoning + tool_calls) → tool results` is accepted and adopted. Without the leading notification the agent repeats the mail read and state queries (duplicate tool calls).
- **Adoption / head-safety:** benign mechanical injected reasoning is treated as the agent's own prior work — no meta-awareness, no duplicated calls. Salient adversarial injected reasoning is flagged and rejected; injected facts contradicting tool results are corrected by the tool data. Hence R4.5.
- **Closing memory:** tool-call messages carry empty visible `content`, so the closing summary must ride in the terminal call's `summary` argument (R2.4). Confirmed: summaries of 495–830 chars were captured every turn this way.
- **Precalls:** declared read calls executed at next-turn start appear as normal call/result pairs and compact normally.
- **Effect (injection only, generic loop, 4 trials of a 3-turn mini-Director):** injection removed the read/decision call and all duplicate reads and reduced model calls ~34% (12.8 → 8.5) and total tokens ~14%, before terminal batching. With terminal batching, a turn completes in a single inference (acceptance criterion 2).
- **Caveat:** the harness does not implement the full runtime (no permission/audit layer, no persistence); the above validates provider/contract behavior, not end-to-end integration.
