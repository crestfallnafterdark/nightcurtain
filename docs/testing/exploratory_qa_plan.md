# Agent-Driven Exploratory QA — Sandbox Studio

**Status:** CANONICAL · **Last verified:** 2026-09-22.
Charter-based, hands-on exploratory QA of the app driven by an AI agent through a Playwright browser (Playwright MCP; headless — the opencode environment has no X/Wayland). This is deliberately **not** a scripted spec: the agent clicks, observes snapshots/console/network after every action, adapts, and records findings. Scripted coverage stays in [`e2e_and_visual.md`](e2e_and_visual.md).

## 1. Harness

| Component | What / where |
| :--- | :--- |
| Browser control | Playwright MCP `@playwright/mcp@0.0.81` (pinned) via global opencode config `~/.config/opencode/opencode.jsonc` |
| Browser | Headless Chromium — the Playwright-managed browser bundled with the repo's Playwright (headless built-in), viewport 1440x900 |
| Profile | Persistent `<repo>/.playwright/qa-profile` (gitignored) — vault/sandbox state survives browser restarts; delete the directory to wipe all QA state |
| Artifacts | `<repo>/test-results/qa/` (gitignored) — auto-named screenshots, traces, and the MCP session log (`--save-session`) |
| Secret redaction | `--secrets .env.local` masks matching key values in MCP tool outputs as `<secret>NAME</secret>` |
| Dev server | `npm run dev` → `http://localhost:5173` (must already be running; the MCP does not start it) |

**Config changes are read at opencode startup only** — restart opencode after editing the global config. If a tool misbehaves, `npx playwright cli` (bundled with the repo's Playwright 1.63) can drive the same flows as a fallback.

## 2. Credential vault seeding

Provider keys live in `.env.local` (`*_TEST_API_KEY`). No daemon or page init script is involved: the seeder reads the file locally and writes `ai_story_credentials_v1` directly into the MCP profile.

```bash
# 1. close the MCP browser first (single-writer profile lock) — `browser_close` tool
# 2. seed
node tests/qa/seed_vault.mjs
# 3. the next MCP tool call relaunches the browser on the seeded profile
```

`tests/qa/seed_vault.mjs` seeds canonical entries (`canonical_runware`, `canonical_deepseek`, `canonical_nanogpt`, `canonical_prem`) for the keys present, and prints provider ids only. It is idempotent (re-running overwrites the vault).

### Secret-handling rules
- Never type, print, return, screenshot, or commit a secret value. `browser_evaluate` must never return vault contents.
- Avoid `browser_network_request` header dumps for provider calls; if needed, confirm redaction replaced the `Authorization` value first.
- `localStorage` dumps can contain seeded keys — cite key ids/labels only in findings, never values.
- The persistent profile is a plaintext credential store on this machine; treat it accordingly and delete it when the QA program ends.

## 3. Charters (sandbox studio scope)

| # | Charter | Phenomena | Net |
| :--- | :--- | :--- | :--- |
| C1 | Boot & configuration | Director bootstrap, KPI chips, catalog-driven Sandbox Settings modal (preset select/save/create → custom preset, active pointer), **credential vault** (seeded entries masked, add/set-active/delete), persistence across reload | local (+ live "test key" probes) |
| C2 | Agent lifecycle | Launch modal validation (duplicate id, empty, pattern), presets, sudo, tool whitelists, `AgentSettingsPanel` save/sync, terminate/undo/cancel, recycle bin restore/purge, factory reset, per-agent drafts | local (+ 1 live turn) |
| C3 | Turn engine & chat | Streaming, reasoning accordion, tool badges, markdown, inline edit, copy/delete, undo/redo, cancel mid-stream, retry/unstick, multi-agent switching; provider parity smoke | live (NanoGPT primary) |
| C4 | Tools | VFS explorer (create/upload/query/grep/download/clear), agent-driven VFS tool calls, bus viewer (filters/inject) + agent mail, scheduler fire/cancel, world clock, telemetry/trace consistency | local + live |
| C5 | Persistence & recovery | Reload idle/mid-stream, offline mid-turn (`browser_network_state_set`), interrupted-turn recovery, malformed `ai_storyteller_sandbox_state_v1` recovery, draft/tab/selection restore | local + live |
| C7 | Adversarial | XSS/markdown sanitization, malformed VFS JSON, oversized inputs, duplicate ids, console/page-error and failed-request audit, no-legacy-globals check (no `window.gameState`), vault redaction check | local |
| C8 | Responsive spot checks | Sandbox at 1440x900 / 768x1024 / 375x812 (drawer, tabs, modals) | local |

## 4. Step protocol

For every meaningful action: **snapshot → act → observe → verdict**.
1. `browser_snapshot` (use `browser_find` for large trees; scope snapshots to elements when possible).
2. Act by ref (`browser_click`/`browser_type`/…). Let the auto-snapshot settle.
3. Observe: resulting snapshot, `browser_console_messages`, `browser_network_requests` when relevant, screenshot for visual states.
4. Verdict `OK` / `ANOMALY` / `BLOCKED`; log action, expected, observed.

On an anomaly: reproduce twice from a clean state, capture a trace (`browser_start_tracing`/`stop`), then continue unless it blocks the charter. Stop a charter when coverage is reached, a blocker appears, or the user interrupts.

## 5. Evidence

- Session directory per charter: `test-results/qa/<YYYY-MM-DD>-C<n>-<slug>/`.
- Screenshots with explicit step-numbered filenames; traces and the MCP session log land in `test-results/qa/` via `--output-dir`/`--save-session`.
- Keep evidence out of git; tickets reference local artifact paths and textual repro steps.

## 6. Budget

- **NanoGPT is the primary provider** for functional charters (preset model `deepseek/deepseek-v4.1-flash:thinking`, routing `auto`).
- Cap ≈ 40 live turns across the pass; after the main pass, one shallow turn each on DeepSeek Native / Prem / Runware for provider parity.
- Runware live-service flakes are expected (accepted); DeepSeek Native is the most reliable tool-caller — prefer it for tool-loop checks.
- Record actual turn counts per provider in the findings doc.

## 7. Findings

- **git-bug is the single source of issue state.** File each finding directly as a self-contained ticket (`git bug bug new -F body.md`; labels `qa` + `sev:*` + `area:*`) with repro, expected/actual, evidence, and file pointers; **no per-finding markdown mirror**. Severity: `Blocker`/`Major`/`Minor`/`Cosmetic`.
- Cross-check against known issues in the tracker before filing (deferred secret-exposure and telemetry-seam defects, and the accepted quirks) so duplicates are not filed.
- After a pass, session evidence is retained by the operator; active work is tracked in the git-bug tracker of record (`node scripts/gitbug.mjs`; AGENTS §6); fixes are approved separately.

## 8. Security notes

- The only secret sink is the local profile; there is no listening secrets service and no init script injecting secrets into pages.
- Do not browse external origins in the QA profile while seeded.
- `--secrets` redaction is a convenience, not a security boundary — apply the secret-handling rules above regardless.

## 9. Related

- [`e2e_and_visual.md`](e2e_and_visual.md) — scripted Playwright specs and visual baselines.
- [`testing_strategy.md`](testing_strategy.md) — QA philosophy and CI gates.
- **Product/QA defects are filed in git-bug** (`git bug bug`) per AGENTS.md §6.
