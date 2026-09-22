# NightCurtain

**A browser-native studio for multi-agent AI story worlds.**
Every story is a curtain pulled back — behind it, a cast of agents that talk to
each other, use real tools, keep files, and schedule their own wake-ups inside a
sandbox you control.

> Early development (pre-1.0): the engine is covered by 92 test suites, but the
> UI and template formats are still moving.

## What it does

- **Sovereign agents** — each agent owns its turn loop with tool calls, context
  compaction, and fault isolation.
- **A real tool surface** — 35 tools: virtual filesystem, inter-agent mail,
  invocation/await, scheduling, world clock, lifecycle, and template publishing.
- **Multi-provider** — Runware, NanoGPT, DeepSeek, Prem, and any
  OpenAI-compatible endpoint. Keys live in a `(keyId, secret)` vault and never
  touch model config.
- **Templates & realms** — launch pre-built agent bundles (including the
  Session Zero generator realm) or import/export format-v1 templates; realms
  keep agents isolated.
- **Studio UI** — streaming chat with reasoning, agent inspector + telemetry,
  VirtualFS explorer, messaging-bus viewer, catalog-driven settings.
- **Persistence** — debounced snapshots, turn undo/redo, recycle bin.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

1. Open the app and click **Settings**.
2. Add a provider key to the credential vault and pick a model preset.
3. Click **Launch Agent** — or start from the **Session Zero** template.

Provider keys for scripted tests and QA come from `.env.local`
(`*_TEST_API_KEY`); never commit that file.

## Verify

```bash
npm run verify     # 7 static gates (contracts, module contracts, types, ICD freshness, arch, lints, typecheck)
npm test           # 92 suites (46 unit + 46 integration), zero mocks
npm run test:e2e   # 8 Playwright specs
npm run build
```

## How it's built

Svelte 5 (runes) + Vite, with the engine in `src/lib/sandbox/` as folder modules
whose `index.ts` is the only importable surface — the sandbox never imports app
code, and the boundaries are gate-enforced. Deterministic identity and
realm-scoped capability checks are invariants, not conventions.

Deep dives: [`docs/README.md`](docs/README.md) · engine notes:
[`docs/sandbox_notes.md`](docs/sandbox_notes.md) · agent/contributor rules:
[`AGENTS.md`](AGENTS.md).

## License

MIT — see [`LICENSE`](LICENSE).
