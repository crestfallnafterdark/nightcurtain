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

# Notes
What you read above was AI slop. Yes! Indeed! This project is AI-slop. But it is managed AI slop, time was deliberately spent to manage the slop to make maintaining easier.  
All the code and the docs(including this readme) are AI generated. The only human code that was written was after reaching unbearable levels of frustrations with the AI model. None of the code is verified, the coder was AI and so was the reviewer. I, the supposed author, understand it no more than you. If you find any committed keys, take it as treat. Spend a few dollars and then message me so I can rotate them.  
Some stats:
Started working on this near August 20, the initial history (about 3000 commits) was truncated because the models commited binaries, api-keys and everything in between.  
For the first few days Gemini-flash-v3.7 was used with Antigravity. Google doesn't tell me how much tokens I wasted, but I had two pro accounts on rotation(only found out this was against TOS when one got banned). Truly a horrible experience, too many input tokens were spent on creative insults. Made me break the cardinal rule of this project(no code) and write a bunch of code(see if you can find it).  
Meanwhile in testing I was using the deepseek-v4-flash agent, that seemed to do much better than Gemini in the sandbox, it was way cheaper as well. So around September 10th I changed harness to OpenCode and started using DeepSeek-v4.1-flash. It is easily a superior model in all respects. Highly recommended. Most of the current code is a complete rewrite of the broken Gemini code by DeepSeek. It is what implemented actual, encapsulation, abstractions. Two parallel subscriptions were used for this: 1) OpenCode Go, 2) Command Code GOAT. These services tell me how many tokens I have wasted. It seems the total is somewhere around 9 billion tokens(above 98% cache hit rate). This is for $20, and I have half the Command Code limit still left. Now this is the AI revolution I can buy(all hail comarade Xi). 
