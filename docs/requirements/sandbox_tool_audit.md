# Requirements: Sandbox Tool Audit & Turn-Completion Integrity

**Status:** RATIFIED  
**Last verified: 2026-09-22**  
**Version:** 1.0  
**Date:** 2026-09-13
**Scope owner:** Project owner
**Related systems:** Multi-agent sandbox tool layer, AgentRuntime, InvocationEngine, MessagingBus, VirtualFS, sandbox UI/telemetry
**Related documents:** `docs/requirements/sandbox_turn_efficiency.md` (mail injection, terminal batches, precalls)

---

## 1. Purpose and Background

An independent, read-only audit of the sandbox tool layer was carried out at the time of the audit. It covered: schema/dispatcher coverage, permissions and privilege enforcement, argument/alias normalization, dispatcher error handling and the multi-agent coordination tools, and filesystem isolation/data integrity.

The audit found defects ranging from privilege-escalation and turn-aborting bugs to silently ignored arguments and broken JSON operations. Two additional defects in the precall/turn-completion experience were reported by the project owner:

1. A terminal `runtime_batchPrecall` is shown in the UI as **"Agent Turn Interrupted"**, even though the terminal batch is an intentional, successful turn-ending mechanism — not an interruption.
2. The terminal batch's **summary is not appended to the turn as the agent's response**, so after tool results are compacted the agent has no model-visible record of what it did in the turn.

This document states **what must be true when the work is complete**. It intentionally does not prescribe implementation. Appendix A records the observed defect behind each requirement for traceability.

---

## 2. Scope

### In scope
- Precall and turn-completion semantics, including UI status and agent-visible turn memory.
- Tool permission, privilege, and capability enforcement.
- Turn execution stability and failure isolation.
- Tool schema / dispatcher / alias contract fidelity.
- Filesystem isolation, permissions, and data-integrity behavior.
- Test and documentation fidelity for the tool registry.

### Out of scope
- The already-ratified mail-injection and terminal-batch cost model in `sandbox_turn_efficiency.md` (this document builds on it, and where requirements overlap they are restated here for completeness).
- New tool features or tool-catalog reduction.
- Rewriting agent prompts.
- UI redesign beyond the specific status/presentation requirements in §4.1.

---

## 3. Terminology

- **Terminal batch:** a turn-ending `runtime_batchPrecall` call carrying a `summary` and optional read precalls.
- **Precall:** a read/observe call requested at turn end and executed at the start of the next turn.
- **Capability gate:** the runtime check that decides whether an agent may invoke a tool.
- **Fail-closed:** when authorization input is missing, malformed, or ambiguous, access is denied.
- **Trusted channel:** runtime-derived call context, as opposed to model-supplied tool arguments (the untrusted payload).
- **Turn response:** the agent-authored record appended to history that represents the completed turn.

---

## 4. Functional Requirements

### 4.1 Precall & Turn Completion (PRC)

- **PRC-1 — Intentional completion is not an interruption.** A turn that ends through a `runtime_batchPrecall` batch with no tool errors must be recorded and presented as a successful, intentional turn completion. It must never be labeled or styled as "Agent Turn Interrupted," an error, or an abort. Genuine interruptions/aborts must remain distinguishable from intentional terminal completion.
- **PRC-2 — The summary is the agent's turn response.** The `summary` supplied with a terminal batch must be appended to the agent's history as the assistant response for that turn. It must remain model-visible on subsequent turns after that turn's tool results have been compacted, so the agent always has a readable record of what it did and decided. Rationale: with all tools compacted after the turn, the summary is the agent's only durable account of its own turn.
- **PRC-3 — Precalls are strictly read-only.** Only pure read/observe operations may execute as precalls. Tools with mixed read/write semantics must be forced to a query form or excluded. No precall may mutate runtime state, filesystem state, mailbox state, or contact other agents.
- **PRC-4 — Execution-time revalidation.** The precall allow-list must be enforced when precalls actually execute, not only when queued. Precalls restored from persistence, injected, or otherwise hydrated must be validated identically to freshly queued ones.
- **PRC-5 — Deduplication.** Two precalls with the same normalized tool name and equivalent arguments must execute once.
- **PRC-6 — Precall failures surface.** A failed precall must appear as an ordinary tool failure that the model can observe and react to; it must never cause silent termination or be reported as a successful completion.
- **PRC-7 — Proactive precall-triggered delivery.** A turn that ends with read precalls for data that is already available must not require an extra model inference to consume that data on the next turn.
- **PRC-8 — Bounded precall volume.** A terminal batch must not be able to queue an unbounded number of precalls or mutate state through volume.

### 4.2 Security & Authorization (SEC)

- **SEC-1 — Privilege is not derived from identity strings.** An agent's privileges must come only from trusted, explicit configuration. A tool argument, an agent's display name, its id string, or a free-text role/description field must never grant or elevate privileges.
- **SEC-2 — Reserved identities cannot be claimed.** Non-privileged callers must be unable to create, rename, or take over reserved privileged identities.
- **SEC-3 — Capability gating is fail-closed.** Missing, empty, null, malformed, or unrecognized allowed-tool input must grant no restricted tools. Universal access must require an explicit, trusted grant — never absence of configuration.
- **SEC-4 — Advertised and callable tools match.** The set of tools an agent may execute must equal the set it is permitted and advertised. A "read-only" preset must not be able to perform mutations, directly or through alias resolution.
- **SEC-5 — Innate tools do not silently widen privileges.** The always-available tool set must not grant an agent mutating capabilities that its preset denies, without that behavior being an explicit, documented policy.
- **SEC-6 — Subagent management is explicitly granted.** Spawning, invoking, killing, and undoing other agents' turns must require an explicit capability grant or privileged status.
- **SEC-7 — Scheduling is owner-scoped.** An agent must not be able to list or cancel another agent's scheduled tasks unless it is privileged.
- **SEC-8 — Workspace operations require caller identity.** Workspace-scoped reads and writes must deny by default when caller identity is absent, and identity must be taken only from the trusted channel, never from the tool payload.
- **SEC-9 — Read-only protection is universal.** A read-only file must not be overwritten, deleted, patched, replaced, or copied over by a non-owner/non-privileged caller through any mutating operation.
- **SEC-10 — Path aliases cannot shadow protected files.** Aliased spellings of a path (e.g. public/global prefixes) must resolve to the same canonical file for existence checks, permission checks, and the actual write.
- **SEC-11 — Pattern searches are bounded.** Free-text regular-expression search must not be able to block the runtime indefinitely (e.g. catastrophic backtracking), and search options must be sanitized like all other tool options.
- **SEC-12 — Snapshot import is authorized and validated.** Restoring runtime state from persistence must not allow forged ownership, forged read-only flags, or cross-workspace injection; malformed snapshots must be rejected.
- **SEC-13 — Privilege strings are not spoofable.** Special identity strings used in authorization decisions must not be settable by untrusted input.

### 4.3 Turn Execution & Stability (TURN)

- **TURN-1 — Repeated waits do not abort a turn.** A batch containing more than one wait-for-mail (or equivalent wait) call must execute normally and must not abort the turn or leave the agent in an error state.
- **TURN-2 — Waits are always bounded.** Every wait call must resolve within a finite time. Missing, non-numeric, string, or negative timeout values must not cause an unbounded hang; they must resolve using a safe default.
- **TURN-3 — Empty waits are not false successes.** A wait invoked with no valid target must report an invalid-argument failure, not an immediate successful completion.
- **TURN-4 — Completion, timeout, and abort are distinct.** Aborted, timed-out, partially-satisfied, and fully-completed waits must be distinguishable in results and must not report success when the condition was not met.
- **TURN-5 — Concurrent waits do not double-deliver.** Overlapping waits for the same message must not deliver it twice or create duplicate archived copies.
- **TURN-6 — One failure does not abort the batch.** A single failing tool call must be contained and reported; it must not abort the execution of the remaining calls in the batch, and must not corrupt the turn's history.
- **TURN-7 — Tool results are always serializable.** A tool result that cannot be serialized must be normalized into a safe, structured result rather than throwing and aborting the turn.
- **TURN-8 — Error codes are consistent.** The same class of failure must report the same error code regardless of which code path produced it.
- **TURN-9 — Waits honor their documented options.** Wait options advertised in the schema (e.g. include-read behavior) must be honored, or removed from the schema.
- **TURN-10 — Spawn failures leave no live partial agent.** If agent creation fails after partial registration, the runtime must not leave a live, message-subscribable, partially-initialized agent behind.
- **TURN-11 — Kill reports accurately.** Terminating a non-existent agent must report not-found rather than success.
- **TURN-12 — Recycled-id spawn is explicit.** Spawning an id that exists in the recycle bin must not silently destroy preserved history without explicit intent.
- **TURN-13 — Invalid spawn options fail loudly.** An invalid preset or spawn option must produce a clear invalid-argument failure rather than silently resolving to a broad or empty permission set.

### 4.4 Tool Contract & Normalization (CON)

- **CON-1 — Declared and dispatched tools are in sync.** Every declared tool must be dispatchable, and every dispatched tool must be declared.
- **CON-2 — Declared parameters and aliases are honored.** No parameter or alias advertised in a tool's schema may be silently ignored by the handler.
- **CON-3 — Alias resolution is consistent.** The same alias must resolve to the same canonical tool across all runtime modules.
- **CON-4 — Normalization is prototype-safe and case-consistent.** Tool-name and argument normalization must not resolve object-prototype keys, and must handle casing/whitespace predictably.
- **CON-5 — Defaults and enums match behavior.** A tool's documented default and allowed values must match what the handler actually does when the argument is omitted.
- **CON-6 — Argument coercion is consistent.** Numeric and boolean values supplied as strings must be coerced predictably or rejected with a clear error; they must never be silently ignored or interpreted as the opposite boolean.
- **CON-7 — Required arguments are enforced.** A required argument must actually be required, and an optional one must not be declared required.
- **CON-8 — Preset resolution is fail-closed.** Empty, invalid, or non-preset input must not resolve to "all tools," and preset lookup must not be vulnerable to prototype keys.
- **CON-9 — Dead and duplicate definitions are removed or documented.** Alias constants and duplicate aliases that are never reachable must be eliminated or explicitly declared as public API.
- **CON-10 — Documentation reflects schemas.** Tool semantic documentation and self-description must match the actual schema and behavior.

### 4.5 Filesystem & Data Integrity (FS)

- **FS-1 — JSON query and transform work.** Declared JSON query/transform capabilities must function; if a capability is unsupported, it must be removed rather than left in a state that throws.
- **FS-2 — Per-agent filesystem accessors work.** Every convenience accessor an agent can reach must execute without undefined-reference errors.
- **FS-3 — Canonical path handling.** Path normalization must produce a single canonical key for a file, and the key used for the existence check, the permission check, and the write must be the same.
- **FS-4 — Read-only is enforced on every mutating operation.** Replace, patch, copy-over, and delete must respect the read-only/ownership rules with the same rigor as write.
- **FS-5 — Literal replacement.** Content replacement must insert the replacement text literally; characters that have special meaning in replacement patterns must not be interpreted.
- **FS-6 — Copy overwrite default is consistent.** The documented default, the dispatcher default, and the UI default for overwriting on copy must agree.
- **FS-7 — Directory semantics are defined.** Deleting or listing a directory must have explicit, documented behavior.
- **FS-8 — Metadata accuracy.** Operation receipts/metadata must report the workspace and path that actually changed.

### 4.6 Test & Documentation Fidelity (HYG)

- **HYG-1 — Tests match the registry.** Tool-count and preset-count assertions must reflect the real tool registry.
- **HYG-2 — No tests reference absent tools.** Test suites must not assert on tools or constants that do not exist.
- **HYG-3 — Security expectations match policy.** Schema tests must assert the schema policy actually in force (e.g. additional-properties policy), not a superseded one.

---

## 5. Non-Goals

- No new story features, tools, or agents.
- No change to the ratified injection/terminal cost model except where required for §4.1 correctness.
- No prompt rewrites.
- No UI redesign beyond distinguishing intentional completion, and surfacing the turn summary.

---

## 6. Acceptance Criteria

1. A terminal batch that completes without errors is shown and recorded as a successful, intentional turn completion; "Agent Turn Interrupted" appears only for genuine interruptions.
2. After the turn ends and its tool results compact, the agent's history still contains that turn's summary as its own assistant response.
3. Every precall executed at turn start is a pure read; none mutates state or contacts another agent, including precalls restored from persistence.
4. Duplicate precalls execute once; a failed precall is visible to the model and does not terminate the turn silently.
5. A non-privileged agent cannot gain privileges by choosing its id, name, role description, or tool arguments.
6. An agent with missing/invalid/empty allowed-tool configuration can execute no restricted tool.
7. A "read-only" agent cannot mutate files, mailbox, clock, events, or schedules through any tool or alias.
8. A batch with two wait calls completes without erroring the agent; a wait with an invalid timeout still resolves.
9. Empty, aborted, partial, and completed waits are distinguishable; overlapping waits deliver each message once.
10. A failing tool in a batch does not abort the remaining calls or the turn.
11. No configured tool is silently unreachable, and no advertised alias is silently ignored.
12. `queryJson`/`transformJson` work for their declared filters, and every reachable filesystem accessor executes without an undefined-reference error.
13. A read-only global file cannot be overwritten through any path alias or mutating operation by a non-owner.
14. Tool-count/preset-count tests pass against the real registry.
15. The full existing test suite passes, and `npm run build` exits 0.

---

## Appendix A — Audit Evidence (Observed Defects)

> **Historical (2026-09-17):** This appendix records historical audit evidence and is retained for traceability only. Stale line references have been dropped; the requirement IDs in §4 are the authority.

The authority is the requirement IDs above. `virtualFs` was under active edits during the audit and its findings were re-verified afterwards.

| Req ID | Observed defect (audit) | Evidence |
|---|---|---|
| PRC-1, PRC-2 | Owner-reported: terminal batch shown as "Agent Turn Interrupted"; summary not appended as the agent's turn response, so after tool compaction the agent cannot see what it did. | owner report; related persistence: `toolDefinitions/index.ts` |
| PRC-3, PRC-4 | Precall allow-list includes mutating `world_clock`, `event_list`, `messaging_readMessage`, `messaging_getInbox`; alias→canonical fallback admits advance/reset/register/resolve; queued/restored `pendingPrecalls` execute with no re-validation. | `toolDefinitions/index.ts`; `runtime/agent/index.ts` |
| PRC-5, PRC-8 | No dedupe or volume bound on queued precalls. | `toolDefinitions/index.ts`; `runtime/agent/index.ts` |
| SEC-1, SEC-13 | Privilege derived from `agentId === 'admin'/'director'` and from a lowercased role string; free-text "Role Description" is written unvalidated. | `toolDefinitions/index.ts`; `runtime/agent/index.ts`; the retired `AgentEditModal.svelte` |
| SEC-2 | Spawn accepts a caller-chosen id with no reserved-name check. | `toolDefinitions/index.ts`; `runtime/agent/index.ts` |
| SEC-3 | Capability set stays `null` unless `allowedTools` is an array; `null` is treated as unrestricted, permitting subagent tools. | `toolDefinitions/index.ts` |
| SEC-4, SEC-5 | Innate set includes FS writes, schedule/clock/event mutation, and is exempt from the capability gate; a "readonly" agent can still invoke them (schema also advertises a narrower set). | `toolDefinitions/index.ts`; the historical authority-hierarchy test (removed) |
| SEC-7 | `runtime_listSchedules` spreads caller args after the bound agent id; `cancelSchedule` has no owner check. | `toolDefinitions/index.ts`; `runtime/agent/index.ts` |
| SEC-8 | Workspace isolation is skipped when caller identity is absent; identity is also read from the payload, and `grep` skips option sanitization. | `virtualFs/index.ts` |
| SEC-9, SEC-10 | `writeFile` checks `existing` at one key then writes another; `copyFile` destination lookup lacks the public-prefix fallback, allowing a `/public/`-prefixed shadow to defeat a read-only global file. Read-only enforcement also not applied uniformly in replace/patch/copy. | `virtualFs/index.ts` |
| SEC-11 | `grep` builds a raw `RegExp` from user input with no timeout. | `toolDefinitions/index.ts`; `virtualFs/index.ts` |
| SEC-12 | `importSnapshot` reconstructs arbitrary workspaces/ownership/read-only with no validation. | `virtualFs/index.ts`; `sandboxPersistence.js` |
| TURN-1 | `waiting_for_message` is absent from its own allowed transitions; a second wait throws and aborts the batch. | `runtime/agent/index.ts` |
| TURN-2 | Invocation wait arms no timer for non-numeric or negative timeouts, so it never resolves. | `invocationEngine/index.ts` |
| TURN-3, TURN-4 | Empty target list returns success with `timedOut:false`; aborted wait returns `success:true` with an error field. | `invocationEngine/index.ts` |
| TURN-5, TURN-9 | Concurrent waits both resolve and duplicate archive records; `includeRead` is advertised but never read. | `messagingBus/index.ts`; `toolDefinitions/index.ts` |
| TURN-6, TURN-7 | `executeToolCall` is outside try/catch and `JSON.stringify(result)` failures escape, aborting the batch; handler returns `undefined` yields a content-`undefined` message. | `toolDefinitions/index.ts`; `runtime/agent/index.ts` |
| TURN-8 | Generic and permission errors surface different codes for the same class. | `toolDefinitions/index.ts` |
| TURN-10 | Registration, bus subscription, and `agents.set` happen before the initial prompt runs; failure leaves the agent live. | `runtime/agent/index.ts` |
| TURN-11 | `killAgent` return value is discarded; success is always reported. | `toolDefinitions/index.ts`; `runtime/agent/index.ts` |
| TURN-12 | Launch deletes a recycled id and rebuilds, discarding preserved history. | `runtime/agent/index.ts` |
| TURN-13 | Invalid `toolPreset` silently resolves to `['*']` or a raw string. | `toolDefinitions/index.ts` |
| CON-2 | `path` alias declared but unread by replacement/writeJson/queryJson/listFiles/jsonPatch/inlineFile; `markAsRead` ignored by getInbox; `instruction` ignored by invokeAgent. | `toolDefinitions/index.ts` |
| CON-3 | `get_inbox`/`getInbox` map to `listInbox`, while the semantic docs and another module map them to `getInbox`. | `toolDefinitions/index.ts`; the legacy provider module (removed) |
| CON-4 | Normalization returns inherited prototype members and is case-sensitive. | `toolDefinitions/index.ts` |
| CON-5 | `event_list` documents default `query_active` but no-action returns all statuses; `copyFile` documents overwrite default true but code defaults false; `runtime_undoTurn` declares `agentId` required but defaults to caller. | `toolDefinitions/index.ts`; `toolDefinitions/index.ts`; `virtualFs/index.ts` |
| CON-6 | Handlers use `Boolean(...)`, so string `"false"` acts as true; numeric strings are silently ignored. | `toolDefinitions/index.ts` |
| CON-8 | Empty/invalid input resolves to `['*']`; prototype keys throw or leak. | `toolDefinitions/index.ts` |
| CON-9, CON-10 | Dead alias constants and semantic-doc drift from schemas. | `toolDefinitions/index.ts` |
| FS-1 | `evaluateJq`/`transformJq` are referenced but never defined, breaking jq-style query and transform. | `virtualFs/index.ts` |
| FS-2 | `forAgent` delegations reference the undefined `baseOptsions`, throwing for `exists`/`listFiles`/`deleteFile`/`replaceFileContent`/`writeJson`. | `virtualFs/index.ts` |
| FS-4, FS-8 | Read-only checks in replace/patch/copy are global-only; receipts can report a different workspace than the one written. | `virtualFs/index.ts` |
| FS-5 | Replacement string is passed to `String.replace`, so `$` patterns are interpreted. | `virtualFs/index.ts` |
| FS-6 | Copy overwrite default disagrees between schema, dispatcher, and store. | `toolDefinitions/index.ts`; `virtualFs/index.ts`; `sandboxStore/index.svelte.ts` |
| FS-7 | Delete has no directory semantics; only exact keys are removed. | `virtualFs/index.ts` |
| HYG-1, HYG-2, HYG-3 | Registry has 34 tools; tests assert 33 and reference a nonexistent `FS_TRANSFORM_JSON`; schema tests expect `additionalProperties:false` though all are true. | `tool_presets_optimization_test.js`; `tool_schemas_security_test.js` |

### Resolved since the earlier audit snapshot (do not re-chase)
- `copyFile` dropping `overwrite` and `setPermissions` dropping `owner` were true in the audit's first snapshot but are resolved after the audit snapshot (options now flow through `sanitizeFsOptions`).
