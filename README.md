# Agentic Sandbox Studio

**Status:** CANONICAL
**Last verified:** 2026-09-22

> **A browser-native, high-assurance multi-agent orchestration studio built with Svelte 5 Runes, sovereign Agent Runtimes, and a unified multi-provider LLM gateway.**

`src/App.svelte` renders only the sandbox (`SandboxView`). `main` is sandbox-only: the legacy single-agent Storyteller app (UI, `gameState`, `api/domain`, `rpgClient`, legacy prompts/hygiene/utils, and their suites) has been removed.

---

## 1. What ships

- **Engine — `src/lib/sandbox/`**: folder modules with `index.ts` surfaces — `runtime/`, `inference/`, `domain/`, `tools/`, `credentialVault/`, `modelConfig/`, `presetCatalog/`, `realmCatalog/`, `realmRegistry/`, `virtualFs/`, `messagingBus/`, `worldClock/`, `triggerQueue/`, `invocationEngine/`, `sandboxPersistence/`, `sandboxStore/`.
- **App/UI — `src/lib/components/sandbox/`**: `SandboxView` workstation with Chat Studio, Agent Settings, Agent Inspector, VirtualFS Explorer, and Messaging Bus tabs; plus the launcher, recycle bin, and settings modals.
- **Sovereign agent runtime (`AgentRuntime`)**: non-blocking turn execution, terminal `batch_precall` batches, tool loops, context compaction, and fault isolation.
- **Inter-agent messaging (`MessagingBus`)**: FIFO mailbox queues, broadcast delivery, peeking/unread tracking, scheduled wakeups.
- **Filesystem & persistence (`VirtualFS`, `sandboxPersistence`)**: workspace isolation, paginated reads, JSON patch/query, USTAR export, and debounced `ai_storyteller_sandbox_state_v1` snapshots with turn undo/redo.
- **Model presets (`presetCatalog`)**: catalog-driven presets are the single writer of model configuration; `sandboxStore.modelConfig` is a read-only projection. Agents bind to a preset (`agent.config.presetId`) — there is no per-agent inherit layer.
- **Five providers — `src/lib/sandbox/inference/`**: `runware`, `nanogpt`, `deepseek`, `prem`, `custom`, resolved from the catalog and keyed through the credential vault.
- **Credentials (`credentialVault`)**: stores `(keyId, secret)` pairs only — no URLs or model metadata; providers resolve secrets at the transport boundary.

---

## 2. Quick start

```bash
npm install
npm run dev        # Vite dev server → http://localhost:5173
```

Open the app, click **Settings** to configure a model preset and provider key in the Sandbox Settings modal, then **Launch Agent**.

### Verification commands

```bash
npm test                  # 92 suites (46 unit + 46 integration) — convergence gates
npm run typecheck         # tsc + svelte-check (ratchet baselines)
npm run build             # Vite production build
npm run test:e2e          # Playwright (8 specs)
npm run gate:arch         # dependency-cruiser (0 errors / 0 warnings)
npm run verify:contracts  # sandbox boundary and pillar gates
```

Live provider keys for tests, QA seeds, and the Playwright MCP profile come from `.env.local` (`DEEPSEEK_TEST_API_KEY`, `NANO_TEST_API_KEY`, `PREM_TEST_API_KEY`, `RUNWARE_TEST_API_KEY`); never commit secrets.

---

## 3. Documentation

- Durable agent rules and gates: [`AGENTS.md`](AGENTS.md).
- Master portal: [`docs/README.md`](docs/README.md) — architecture, UI, testing, and requirements indexes.
- Engine internals: [`docs/sandbox_notes.md`](docs/sandbox_notes.md) + generated module ICDs ([`docs/generated/modules/`](docs/generated/modules/)) · UI: [`docs/ui/`](docs/ui/) · Tests/QA: [`docs/testing/`](docs/testing/).
- Module contract docs (ICD) and generated reports: [`docs/modules/README.md`](docs/modules/README.md).
- Backlog & defects: tracked locally in git-bug (`node scripts/gitbug.mjs list -s open`; see AGENTS §9).

---

## 4. License & Acknowledgments

- **License:** MIT License — see [`LICENSE`](LICENSE).
- **Built with:** [Svelte 5](https://svelte.dev/), [Vite](https://vitejs.dev/), [Prem AI](https://prem.io/), [Runware](https://runware.ai/), and [DeepSeek](https://deepseek.com/).
