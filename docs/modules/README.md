# Module Contract Docs (ICD) — Conventions

**Status:** RATIFIED · **Last verified:** 2026-09-22.
Generated per-module contract docs (ICDs) built from in-source TSDoc tags and the module dependency graph.
Hand-written ICDs are retired.

**Module definition:** a module is a **folder**; its public surface is `<module>/index.ts` (store:
`index.svelte.ts`) — the only importable path from outside the folder; deep imports into a module folder are
banned (dependency-cruiser + verifier enforced). The `@module` identity is the contract-relative folder path.
Declarations are compiler-emitted; hand-written `.d.ts` pairs are retired.

## 1. Sources of truth
- **Surface:** compiler-emitted declarations.
- **Per-export usage docs (what an export does / how to consume it):** **ordinary TSDoc on the declarations** —
  summaries, `@param`, `@returns`, `@example`, `@throws`, `@remarks`. The custom tags in §3 do **not** replace
  this channel; the two are complementary.
- **Module-level contract facts (how the module is allowed to relate to the rest of the system):** in-source
  TSDoc tags (§3).
- **Generated report:** `docs/generated/modules/<module>.api.md` — surface + per-export docs (doc model) +
  tag-derived module sections. Generated, never hand-edited; the record of contract (temporary design ICDs are
  deleted before a module lands — see §9).
- **Global rules stay global:** sandbox→outside import ban, outside→entry-only rules live in
  `.dependency-cruiser.cjs` + verifier — never repeated per module (including as `@invariant`).

## 2. Tag placement
All contract tags live in the module header comment block (attached to `@packageDocumentation`). Member-level
tags are allowed only for member-specific facts (`@internal`; member-specific `@invariant`). Individual
declarations keep their ordinary TSDoc untouched.

## 3. Tag schema
Custom tags describe the **module-level contract**, not individual exports.

| Tag | Kind | Cardinality | Meaning |
|---|---|---|---|
| `@module <path>` | block | exactly 1 | Stable identity: contract-relative path with the full contract extension stripped (`modelConfig`, `runtime/agent`, `inference/OpenAIProvider`, `sandboxStore`) |
| `@mayImport <spec>` | block | 0..n | Contract-level allowed import beyond the global rule; `type-only <spec>` prefix allowed |
| `@mustNotImport <spec>` | block | 0..n | Module-specific forbidden import/edge beyond the global rule |
| `@invariant [<ID>:] <text>` | block | 0..n | Guarantee the module upholds; optional unique id per file; one physical line each |
| `@decision [<ID>] <text>` | block | 0..n | Decision record for the module's contract; an optional trailing `\| ref <durable-ref>` is validated when present — the public tree carries no private commit/ticket refs |
| `@internal` | modifier (standard) | member-level | Not part of the public contract; optional, use sparingly |

`@consumer` is deliberately **not** tagged — consumers are derived from the dependency graph into the generated report.

## 4. `tsdoc.json` (repo root; exact)
```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/tsdoc/v0/tsdoc.schema.json",
  "extends": ["@microsoft/api-extractor/extends/tsdoc-base.json"],
  "tagDefinitions": [
    { "tagName": "@module", "syntaxKind": "block" },
    { "tagName": "@mayImport", "syntaxKind": "block", "allowMultiple": true },
    { "tagName": "@mustNotImport", "syntaxKind": "block", "allowMultiple": true },
    { "tagName": "@invariant", "syntaxKind": "block", "allowMultiple": true },
    { "tagName": "@decision", "syntaxKind": "block", "allowMultiple": true }
  ],
  "supportForTags": {
    "@module": true, "@mayImport": true, "@mustNotImport": true,
    "@invariant": true, "@decision": true
  }
}
```
- Tag names are letters/digits only (TSDoc rule) — hence `@mayImport`, not kebab.
- The parser does **not** enforce `allowMultiple` or "exactly one `@module`" — the validator does.
- API Extractor `.api.md` reports **drop custom tags**; the generated ICD renders from the doc model or a direct
  `@microsoft/tsdoc` parse (the doc model preserves them).
- **`lint:docs` must run with cwd = repo root** (`eslint-plugin-tsdoc` resolves `tsdoc.json` from cwd under
  ESLint 10). All existing gates already do.

## 5. Grammar rules (validator)
- `@module` matches `^[a-z][a-zA-Z0-9]*(/[a-zA-Z][a-zA-Z0-9]*)*$`, equals the contract path with the full
  contract extension stripped (`.d.ts` → removed; `.svelte.d.ts` → `.svelte` also removed), appears exactly once.
- Boundary specs non-empty, no whitespace; optional `type-only` prefix; `\@` escapes unescaped by the validator.
- Ids (`@invariant`/`@decision`) unique per file when present; report keys are module-qualified.
- `@decision`: `[<ID>] <text>` with an **optional** trailing `| ref <durable-ref>`; when a ref is present it must
  resolve to a commit hash (`git cat-file -e <ref>^{commit}`) or a local git-bug ticket id — doc paths are not
  accepted. Ref-less decisions are valid.
- **Vacuity guard:** the validator asserts the full expected contract set is present and tagged (zero matches = failure).
- **Text hygiene:** no defect/QA ids (`BUG-ENC-\d+`, `QA-\d+`), no dates, no status words
  (`DRAFT|INTERIM|PROPOSED|PLANNED`), no global-rule phrasing (`verifier|dep-cruiser|outside-sandbox|may import only`).

## 6. Validation tiers
- **Tier 0:** `npm run lint:docs` — declared tag names; typos fail (`tsdoc-undefined-tag`); cwd = repo root.
- **Tier 1:** `scripts/verify_module_contracts.js` — coverage/vacuity, identity grammar, one-line tags, boundary
  syntax + direction, ref durability (only when a ref is present), text hygiene, id uniqueness; wired into
  `contracts_gate_test`.
- **Tier 2:** cross-check `@mayImport`/`@mustNotImport` against the resolved dependency graph (dependency-cruiser
  JSON, including type-only edges), tracked-exception parity with `TRACKED_SANDBOX_EXCEPTIONS` (empty-aware), and
  **untagged out-of-sandbox edges fail**; untagged intra-sandbox edges are allowed (global direction rule).
- **Tier 3:** freshness — `npm run verify:api-reports` regenerates to a temp tree and fails on any byte drift
  against the tracked reports.
- **Tier 4:** API Extractor messages — **`ae-undocumented: error`** (any undocumented declaration fails the
  pipeline), `ae-missing-release-tag: none`, `ae-forgotten-export: warning`, `ae-unresolved-link: none`; the
  `api_reports.mjs` coverage assertion independently fails before write/diff.

## 7. Do not tag
Responsibilities/non-responsibilities prose · current reverse dependencies · global rules (including as
`@invariant`) · signatures/export lists · anything ordinary TSDoc (`@param`/`@returns`/`@example`/`@throws`)
already covers · statuses/dates/defect ids · secrets · free-standing prose with no gate or report section
consuming it.

## 8. Generated report mapping
- **Surface:** signatures from API Extractor.
- **Per export (ordinary TSDoc via the doc model):** summary, parameters, returns, examples, throws, remarks —
  the "what it does / how to consume it" channel.
- **Per module (custom tags + graph):** Module identity · Boundary (`@mayImport`/`@mustNotImport` +
  graph-derived actuals) · Invariants · Decisions.
- **Coverage signal:** `ae-undocumented` is an error plus a per-module doc-coverage section in every report;
  member-doc gaps cannot return silently — the pipeline fails before write/diff.

## 9. New-module lifecycle — temporary ICD → generated ICD
Durable rule for all new code (AGENTS §3.9–3.10). The **generated report is the ICD of record**; a temporary
ICD is a scratch design artifact that never survives the module.

1. **Integration discovery first.** Find the existing folder module that owns the concern (grep call sites,
   dependency graph, nearest-surface rule). Prefer extending it. Only when nothing fits, create a new folder
   module per AGENTS §3.4 and update the verifier expected set.
2. **Temporary ICD while designing.** A short scratch/design doc capturing responsibility, boundary,
   invariants, and surface intent. It is planning material only — never the contract.
3. **Implement in TypeScript** (AGENTS §3.9): `index.ts` surface with the `@module` docblock/tags,
   implementation in dedicated files (no god files).
4. **Solidify, then delete the temporary ICD.** Run `npm run api:reports`
   (`docs/generated/modules/<module>.api.md` + `INDEX.md`); `npm run verify:api-reports` must show 0 drift. The
   generated report is what future readers consume.
5. **No references to the temporary ICD.** Not in code, `@decision`/`@invariant` tags, tests, or docs. A
   `@decision` ref, when one is used, anchors to a commit or a local ticket (amendment rule: additive only).

Hand-written ICDs were retired with the encapsulation workspace (2026-09-20); the generated reports are the
only ICDs.
