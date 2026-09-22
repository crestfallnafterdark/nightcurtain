# Audit Findings & Reproduction Tests

**Status:** RATIFIED (user, 2026-09-18) · **Last verified:** 2026-09-22.

Mechanics that keep independent audit findings actionable, regression-proof, and attributable. Applies to defect audits of sandbox modules and to provider/environment failures.

## 1. Roles
- **Auditors are read-only.** They do not commit. They deliver, per finding: a deterministic repro (command or script), input, observed vs expected output, `file:line`, and the pre-fix result. Where the defect is testable in-process, they also deliver a proposed failing test (code block in the ticket, or a scratch path under the OS temp dir).
- **Fix agents commit tests test-first.** The first commit of a fix for an audited finding adds the repro as a failing test (red); the fix commit makes it green. The test remains as the regression guard.
- **Lead/tracker** files tickets and, when the proposed test is provided, has the repro archived before fixes start.

## 2. Repro test placement
- `tests/audit/repros/<short-ticket-id>.test.js` — deterministic, offline repros that reproduce a finding. **Not part of `npm test`**; run directly (`timeout 90 node tests/audit/repros/<file>.test.js`).
- `tests/audit/harnesses/` — fuzz/property harnesses used to find findings (e.g. continuation fuzzing). Deterministic seed mandatory; usage header with the exact invocation.
- Promotion: when a repro is deterministic and offline, the fixing agent ports it into the owning suite (`tests/unit/`, `tests/integration/`) and keeps it there. Live-provider or environment-bound repros stay under `tests/audit/` with a header explaining why they cannot join the suite.

## 3. Finding → fix lifecycle
1. Audit produces a ticket with repro + proposed test.
2. Repro archiver commits the failing test(s) under `tests/audit/repros/` (red at current HEAD) — this is the shared proof that the bug exists and is unsolved.
3. Fix agent runs the red test, fixes the defect, re-runs it green, and promotes it into the owning suite when eligible.
4. The audit wave re-runs the repro against the parent commit (must fail) and the fix commit (must pass).

A finding with no committed repro is not considered fixable; the first task of its fix wave is to produce one.

## 4. Providers: smoke before code
Live provider suites are flaky by nature. Before attributing a provider-suite failure to engine code, run:

```bash
node tests/qa/provider_smoke.mjs
```

It makes one minimal completion per required provider (NanoGPT, DeepSeek) and exits non-zero on key/transport failure. If the smoke request succeeds and the suite still fails, the failure is a code/test defect (file a ticket, do not dismiss it as environment). If the smoke fails, the problem is key/provider/network — re-seed and retry before touching code.

## 5. Secret hygiene
Repros, harnesses, logs: provider ids, booleans, lengths, response bodies only. Never print key material, request headers, or `.env.local` contents.
