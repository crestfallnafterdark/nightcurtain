# AGENTS.md

**Status:** CANONICAL · **Last verified:** 2026-09-22.
Durable working rules for any agent contributing to this repository. Program-specific state lives elsewhere (see §2) — these rules do not expire with it.

## 1. What this repo is
AI story engine with an encapsulated multi-agent sandbox.
- **Engine:** `src/lib/sandbox/` — runtime, inference adapters, credential vault, model configuration, preset catalog, virtualFs, messaging bus, world clock, trigger queue, invocation engine, domain agents, tools (incl. the Svelte 5 `sandboxStore`).
- **App/UI:** `src/App.svelte` + `src/lib/components/sandbox/` (14 Svelte components + UI helpers and `markdown/`). No legacy stores/api/utils remain (§7).
- **History:** the legacy single-agent Storyteller UI/storage has been retired; `main` is sandbox-only.

**System invariants** (enforced by the suites and the per-module ICDs, never by hand):

| ID | Rule |
|---|---|
| `INV-1` | **Zero Mailbox Intrusion** — invocations and direct subagent calls do not write to or pollute user-visible message histories. |
| `INV-2` | **Invocations ≠ Messages** — direct subroutine execution returns result tokens directly to the caller without creating inbox envelopes. |
| `INV-3` | **Centralized Non-Blocking Queue** — all autonomous wakeups, mail notifications, schedules, and user turns buffer through a unified FIFO queue with intra-agent ordering and busy-skipping. |
| `INV-4` | **Autonomous Agent Parity** — all agents possess equal asynchronous activation capabilities; no agent is locked to passive polling. |
| `INV-5` | **Turn-Level Await Primitive** — agents can halt turn execution to await one or more specific invocation UUIDs or mail arrivals without polling loops. |
| `INV-6` | **Privilege Escalation Gate** — unprivileged agents cannot spawn privileged (sudo) agents, access private peer workspaces, or execute admin tools. |
| `INV-7` | **Deterministic Identity** — every message in history retains a permanent, immutable UUID across serialization cycles. |
| `INV-8` | **Compaction Integrity** — historical tool calls are compacted to compact summaries, but file writes, invocations, and receipts remain strictly unevicted. |
| `INV-9` | **Descriptor-authoritative capability authorization** — when the frozen registry descriptor exists for a caller, capability derives from it alone (wildcard/explicit/selector grant); the legacy authority channels (`isAdmin`/`isPrivileged`/allowlists) apply only to descriptor-less callers and never widen a present descriptor. **Exception — publishing meta-capabilities:** `@template:authority`/`@hydration:authority` require the exact explicit grant on the frozen descriptor; the wildcard `'*'`, `privileged`, tool profiles, spawn/update selectors, and every legacy channel deliberately do not imply them, and their schemas are exposed at turn time only to exact-authority holders. |

Payload invariant `INV-REASONING-STRING` (`reasoning_content` is always a string primitive) and the **Zero-Mock Verification** mandate (tests execute real class instances; static regex/AST scraping of `.svelte` sources is forbidden) belong to the same durable set — see [`docs/testing/testing_strategy.md`](docs/testing/testing_strategy.md).

## 2. Source-of-truth map
| What | Where |
|---|---|
| Durable agent rules | `AGENTS.md` (this file) |
| Documentation index | `docs/README.md` |
| **Backlog / TODO** | **git-bug** — same tracker as defects (`node scripts/gitbug.mjs list -s open`); no TODO file (§10) |
| Defects / issue tracker | **git-bug** (`git bug bug`) — **single source of issue state**; findings are filed directly as self-contained tickets; local refs, push only on explicit request |
| **Ports / ICDs** | Port interfaces are declared in the provider module's `index.ts` and surfaced in the **generated ICDs** (`docs/generated/modules/`); no separate registry doc |
| **Module contract docs (ICD)** | [`docs/modules/README.md`](docs/modules/README.md) — ratified tag schema + generated-report conventions (reports → `docs/generated/modules/`, Phase 3) |
| Living docs | `docs/ui/`, `docs/testing/`, `docs/requirements/`, `docs/sandbox_notes.md` |

**Doc lifecycle:** program workspaces are temporary. When a program completes, durable notes are folded into living docs and the workspace is removed — nothing is kept in-tree for its own sake; retired **living docs are deleted, not archived**. Durable rules must live in `AGENTS.md`, never only in a program workspace.

## 3. Encapsulation boundaries (hard rules)
1. **Sandbox is the only home for new engine code.**
2. **Dependency direction is outside → sandbox only.** Sandbox modules must not import `../utils`, `../../api`, `../../stores`, `../../components`, `../../prompts`, or any other out-of-sandbox path. Check with:
   `grep -rnE "from '(\.\./)+(utils|api|stores|components|prompts)/" src/lib/sandbox`
3. **Ports** are narrow, injected, frozen plain objects; the interface is declared in the provider module's `index.ts` (the sole surface) and surfaced in the generated ICD, and consumers import the type only. Ratified ports evolve additively. There is no separate registry doc — the hand-maintained `PORTS.md`/`ports/*.md` registry and its verifier check were retired with `docs/encapsulation/` (2026-09-20).
4. **Sandbox modules declare their public surface.** Every sandbox module is a **folder** whose `index.ts` (store: `index.svelte.ts`) is the sole importable surface; declarations are compiler-emitted; deep imports into module folders are banned (verifier + dependency-cruiser enforced). The legacy hand-written `.js` + `.d.ts` pairs and `@contractExports` are retired.
5. **Keystore = `(keyId, secret)` pairs only** (`credentialVault`); no URLs or unrelated metadata. Endpoint URLs belong to the model config (`AgentModelConfig.url`).
6. **Model literals live only in `src/lib/sandbox/modelConfig.js`** (`PRESET_MODELS`, master default). Every other consumer resolves from the catalog, `settings.modelConfig`, or per-call options.
7. **Single settings channel: `settings.modelConfig`.** The legacy scalars (`providerModels`, `providerVendor`, `providerModelId`, `settings.model`) are retired — never reintroduce them.
8. **No secrets in logs, errors, snapshots, or debug dumps.**
9. **New code is TypeScript.** No new `.js` source files under `src/` (tests stay `.js` by repo convention; `main.js` is the pre-existing Vite entry). New UI helpers are born `.ts` with the same thin-surface discipline as sandbox modules.
10. **New-module lifecycle: temporary ICD → generated ICD.** New code first passes integration discovery — prefer the existing module that owns the concern; create a new folder module only when nothing fits (update the verifier expected set). While designing, keep a **temporary ICD** (a scratch/design doc). Once interfaces are solid: implement, then **delete the temporary ICD** and rely on the **generated ICD** (`npm run api:reports` → `docs/generated/modules/`, built from the `index.ts` docblock/tags). No code, tag, or doc may reference the temporary ICD — a `@decision` ref, when one is used, anchors to a commit SHA or a git-bug ticket id (doc paths are not accepted).
11. **Capability scope is pinned, never caller-supplied.** Per-call context cannot override `workspaceId`/`realmId`/`tenantId`/`scope`; the dispatcher strips the scope vocabulary, and trusted bound construction plus the identity projection are the only scope sources.
12. **Custom tools are host-only.** Custom handlers are operator/host-registered (never model-registered, never Realm-registered), execute only for wildcard/authority callers (a matching allowlist entry alone does not grant), and their schemas are never exposed to ungranted callers.
13. **Agent-facing surfaces are realm-opaque.** No realm vocabulary (`realm:`, realm ids, realm fields) may appear in any agent-visible receipt, listing, or error; enforcement is identity-ACL, never obscurity — cross-scope operations deny even with the exact correct target id. The director is a reserved **system scope**, invisible and unaddressable to agents (the bootstrap id and `realmBypass` projection are its only special aspects).
14. **Agent workspace view is private-by-default.** `/` is the caller's private workspace; `/global/...` mounts the shared workspace (mount prefix stripped; legacy `/global/<path>` reads stay compatible); `/agents/<id>/...` mounts peers only with cross-workspace authority **within the caller's scope** (root never crosses realms). Caller-supplied workspace params are stripped at the agent tool boundary; host/API explicit-workspace semantics are unchanged.
15. **Realm membership is immutable and realm ids are opaque.** Membership is fixed at launch (terminate + relaunch into the target realm to change it); every non-director agent has a realm (seeded `realm_generic` default, never deletable), and non-empty realms delete only through the operator recursive override. Agent ids never embed realm ids (the `{realm}` placeholder is retired); uniqueness is staged (per-realm duplicates denied; cross-realm duplicates denied until realm-local namespacing lands).

## 4. Gates & commands
```bash
node scripts/verify_sandbox_contracts.js   # default: must PASS
npm run verify                             # DEFAULT static battery: contracts + module contracts + contract types + api-report freshness + arch + lints + typecheck (read-only, parallel-safe)
npm run verify:contracts                   # static boundary/pillar checks --enforce-boundaries: 0/0/0/0 (NOT a typecheck; included in npm run verify)
npm run verify:contract-types              # strict sandbox-surface tsc (tsconfig.contracts.json) — distinct from verify:contracts; included in npm run verify / typecheck
npm run gate:arch                          # dependency-cruiser over src/: 0 errors / 0 warnings
npm run lint:sandbox                       # sandbox lint gate: 0 problems (contracts_gate_test case 7; config-level exceptions documented in eslint.config.js)
npm run lint:docs                          # TSDoc syntax gate over sandbox .ts: 0 errors
npm run typecheck                          # scripts/typecheck.mjs: jsconfig tsc + strict contracts tsc + svelte-check all run; ratchet baselines (tsc 0 total / 0 sandbox; contracts 0; svelte-check ≤96)
timeout 90 node tests/unit/<suite>.js      # single suite (timeout 180 for heavy suites)
timeout 90 node tests/audit/repros/<id>.test.js # audit repros (red-before-fix evidence; not part of npm test)
timeout 600 npm test                       # 94 suites — single-flight: lead runs after each round lands + at convergence (includes contracts_gate_test)
npm run build
npm run test:e2e                           # Playwright (9 specs) — outside the main gate
node tests/qa/seed_vault.mjs               # QA: seed provider keys into the MCP profile (browser closed first)
node tests/qa/provider_smoke.mjs           # Live pre-flight: 1 minimal completion for NanoGPT + DeepSeek; if it passes, provider-suite failures are code/test defects, not env
```
- Never run the full suite concurrently with other suites/agents.
- Agent-driven exploratory QA uses the Playwright MCP browser (global opencode config; headless built-in Chromium, persistent profile, secrets seeded directly into the profile — no daemon, no init script). Harness, charters, and secret-handling rules: [`docs/testing/exploratory_qa_plan.md`](docs/testing/exploratory_qa_plan.md).
- A work round is done when verifier + `tsc` + the round's targeted suites pass (docs: apply the §6 routing table; `verify:docs` once it lands). Every lane/agent runs the default static battery `npm run verify` (all static gates, read-only, parallel-safe); the partial commands above are for iteration/repair. The full suite + build are single-flight: the lead runs them after each round lands and at convergence — never concurrently with other agents.
- Fixing one sandbox `tsc` error by suppressing or moving the file out of `src/lib/sandbox/` is not a fix.

## 5. Workflow protocol
- **Permission first:** do not start tasks, spawn agents, push, or delete files without explicit user approval. Commits are **pre-approved** (standing permission) — keep them path-scoped; push and file deletion always require a fresh go-ahead.
- **Orchestration model:** the lead agent acts as meta-director — it does not edit application code; changes are delegated to worker agents, and docs are lead-owned. Worker agents stay strictly within their assigned file sets.
- **One writer per file.** Parallel agents may only work on disjoint file sets.
- **Worktree policy:** default to serial work in the primary checkout. Multiple worktrees are allowed only when their file sets are provably disjoint and landing them requires **no manual merge** (no shared files, no shared generated artifacts such as ICDs, doc inventories, or test counts, no shared lockstep edits). If a manual merge would be needed, run the work serially in a single worktree instead.
- **Path-scoped commits:** `git commit -m "…" -- <paths>`; stage new files with `git add --`; **never** `git add -A`; no amend/force/push; retry on `index.lock`.
- **Scope proof:** every agent reports its allowed files, `git status --short`, `git show --stat HEAD`, and an attestation that nothing else was touched.
- **Docs are separate commits** from code.
- **Verification:** security/contract changes get an independent read-only verifier; defect fixes are demonstrated failing before and passing after. Auditors are read-only and must deliver a deterministic repro + proposed failing test per finding; fixes commit the repro red before the fix and keep it as a regression (mechanics: `docs/testing/audit_and_repro.md`).

## 6. Documentation duties
Update these **in the same change set** as the change:
- Issue/tracker updates as **ticket comments with references** (no TODO file — §10).
- Module/port changes: ports are declared in the provider module's `index.ts`; there is no ledger/ICD registry to hand-edit. New/changed module: regenerate the **generated ICD** (`npm run api:reports`) in the same change set and **delete the temporary design ICD** — never reference it from code, tags, or docs (AGENTS §3.10).
- Defects: **git-bug is the single source of issue state** (`git bug bug`; labels `qa`/`sev:*`/`area:*`; local refs — never push without explicit approval). File findings directly as self-contained tickets (repro + evidence + file pointers); **no per-finding markdown mirror**. Active work is the tracker board (§9/§10).
- Living docs (`docs/ui|testing|requirements/`, `docs/sandbox_notes.md`) whenever their subject changes.
- Every doc carries `**Status:** … · **Last verified: <date>**`; broken links get fixed in the same commit.

### Doc routing (which doc owns which fact)
One canonical home per fact; everywhere else links. If a change isn't in the table, write it in TSDoc or file a ticket — do not create a new hand doc.

| Change | Canonical home |
|---|---|
| Module surface / invariant / decision | Regenerate the ICDs (`npm run api:reports`) — `docs/generated/` is never hand-edited |
| Cross-cutting system rule / invariant | `AGENTS.md` §1 (invariants) or §3 (boundaries) |
| Engine quirk / accepted exception | `docs/sandbox_notes.md` |
| UI behavior, layout, copy | the matching `docs/ui/*.md` |
| Test suite added/removed/renamed | `docs/testing/testing_strategy.md` inventory (+ counts until generated) |
| Gate, command, tooling | `AGENTS.md` §4 (+ `docs/README.md` quickstart if user-facing) |
| Ratified requirement behavior | `docs/requirements/*.md` — by explicit decision only |
| Everything else | TSDoc on the code or a git-bug ticket — no new hand doc |

Mechanical facts (counts, file lists, command lists) are generated or omitted, never hand-copied. A hand doc that cannot be kept true is deleted (git history is the archive). A docs freshness gate (`npm run verify:docs`) will enforce links/headers/counts; until it lands, apply this table by hand.

## 7. Code & docs map
- **Engine:** `src/lib/sandbox/` — 36 folder modules with `index.ts` surfaces (`runtime/`, `inference/`, `domain/`, `tools/`, `credentialVault/`, `modelConfig/`, `presetCatalog/`, `realmRegistry/`, `realmCatalog/`, `virtualFs/`, `messagingBus/`, `worldClock/`, `triggerQueue/`, `invocationEngine/`, `sandboxPersistence/`, `sandboxStore/index.svelte.ts`, …).
- **App/UI:** the shell — `src/App.svelte`, `src/main.js`, `src/app.css`, and `src/lib/components/sandbox/` (14 Svelte components + `estimateTokens.ts`, `realmGroups.ts`, `realmHydrationHelpers.ts`, `realmLauncherHelpers.ts`, `realmPayloadLibrary.ts`, `realmReviewHelpers.ts`, `realmTemplateHelpers.ts`, `toolPresetResolve.ts` + `markdown/`). No legacy stores/api/utils remain.
- **Tests:** `tests/unit/`, `tests/integration/`, `tests/e2e/` (Playwright); runner `tests/runner.js`.
- **Tooling:** `scripts/verify_sandbox_contracts.js`.
- **Docs:** see §2 for the map; the generated ICDs (`docs/generated/modules/`) are the contract record.

## 8. Safety
- **Never commit secrets.** `.env.local` is local-only; never log/dump API keys or KEKs (see BUG-ENC-006 redaction policy).
- Commit only intended paths; never add unrelated untracked files.
- Do not install/upgrade tooling (`npm install`, dependency bumps) without approval.

## 9. git-bug CLI (issue tracker of record)
Grammar is version-sensitive; trust the installed binary (`git bug version`, `git bug commands`) over upstream READMEs (older releases use `git bug ls`/`git bug add`).
- **Prefer the wrapper `node scripts/gitbug.mjs`** (`list`/`show`/`resolve`/`new`/`comment`/`close`/`labels`; `--json`, `--dry-run`) — it enforces non-interactive calls, validates labels, and never trusts the selection fallback. Raw `git bug` only for verbs it lacks (`title`, `comment edit`, `user`, `bridge`, `push`/`pull`).
- **Everything nests under `git bug bug`; there are no top-level shorthands** (`git bug ls|show|new|comment|status|title|rm` all fail). `git bug bug` alone lists/searches: `git bug bug [QUERY] [-s open] [-l qa] [-f plain|id|json]`.
- Read: `git bug bug show <short-id> [--field id|shortId|labels|status]` · `git bug bug comment <id>` · `git bug bug label <id>` (vs `git bug label` = all labels).
- Write — **always `--non-interactive` plus `-m`**, else `$EDITOR` opens and the command hangs. **Never combine `-F` with `-t`** (the file's first line overrides the title — a title can be mangled this way): `git bug bug new --non-interactive -t "<title>" -m "<body>"` · `git bug bug comment new <id> --non-interactive -m "<msg>"` · `git bug bug label new <id> <label>...` (one arg per label — a quoted multi-label creates a malformed space label) · `git bug bug status close|open <id>` · `git bug bug title edit --non-interactive -t "<t>" <id>`.
- Ticket ref = **7-char `shortId`**; `refs/bugs/<64-hex>` stores full ids. `git bug --help` prints a stale 2019 man page — use `git bug -h` / `git bug commands`.
- **Never use `git bug bug show <id>` exit status as an existence test:** an unresolvable id silently falls back to the *selected* bug and still exits 0 — **including writes** (`label new`/`comment new` then mutate an unrelated ticket; a known defect). Resolve via `git for-each-ref refs/bugs` prefix match (or `gitbug.mjs resolve <ref>`).
- Cloud ingestion: this build ships **github/gitlab/jira/launchpad-preview bridges** (`git bug bridge …`, pull-first; `push` only on explicit request).
- Local refs only; `git bug push`/`pull` only on explicit request. Full reference + pitfalls + index-cache maintenance: [`.agents/skills/working-with-git-bug/SKILL.md`](.agents/skills/working-with-git-bug/SKILL.md).

## 10. Work & issue tracking (three tiers)
- **Ephemeral work** → the session todo list only. Never durable, never committed.
- **Session context / checkpoints** → the gitignored `./scratch/` directory (`scratch/checkpoints/` for session catalogues; topic subfolders for scratch scripts and probes). Never write session context to `/tmp`, and never commit `scratch/`. Anything that must outlive the session belongs in a living doc, `AGENTS.md`, or a ticket — not in `scratch/`.
- **Durable issues/backlog** → **git-bug** (single source; §9). Drive it via `node scripts/gitbug.mjs` (`list`/`show`/`resolve`/`new`/`comment`/`close`); never keep a TODO file. Board: `list --status open`; filter with `-l area:*`, `-l sev:*`, `-l type:*`, `-l prio:*`.
- **Durable decisions/rules** → `AGENTS.md` and living docs. Tickets link to them; docs never mirror ticket status.
- **Every ticket update is a comment** carrying references: commit SHA, `file:line`, durable doc paths, command + result. Close only after a closing comment citing the fix.
- Labels: `type:defect|feature|task|chore|decision` · `sev:*` · `area:*` · `prio:*` · `prog:*`, plus legacy `qa`, `mod-21`, `security`, `audit-fail`.
- `docs/TODO.md` was retired 2026-09-20 — durable work lives in the tracker.
