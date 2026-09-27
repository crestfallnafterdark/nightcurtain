---
name: realm-authoring
description: >-
  Author and validate Realm template bundles ({formatVersion, template, files})
  and payloads for the ai-story engine, including AgentSpec.authorities
  declaration and launch-approval semantics. Use when producing, revising, or
  pre-flight validating realm templates or payloads, or when running
  scripts/validate_realm_artifacts.mjs. Legacy format-v1 documents are still
  accepted through the engine's read shim; validation always runs the engine's
  real realmCatalog code.
---

# Realm authoring (format v2)

**Status:** living skill · **Last verified:** 2026-09-27 · **Drift gate:** the fixture harness below
(`node skills/realm-authoring/fixtures/run_fixtures.mjs`) runs the engine's real `realmCatalog`
validator, so any engine change that invalidates a documented shape turns it red. Re-run it after
touching `src/lib/sandbox/realmCatalog/`, `src/lib/sandbox/tools/`, or this skill. It is run
manually; it is not wired into `npm run verify`.

You author two portable artifacts for the ai-story Realm engine. The host app owns import,
review, and launch; this skill owns authoring and pre-flight validation.

| Artifact | Shape | Consumed by |
|---|---|---|
| **Template bundle** | `{ "formatVersion": 2, "template": {…}, "files": { "<path>": "<text>" } }` | host `import_realm_template` tool (dry-run first) |
| **Payload** | `{ "formatVersion": 2, "templateId", "templateVersion", "inputs", "provenance"? }` | host `submit_hydration_package` tool → launch review → attach at launch |

The pre-cutover format-v1 field tables (origins, `seed`, hydration packages) remain in
[`format-v1.snapshot.md`](format-v1.snapshot.md) as a **historical snapshot**; format-v1
documents still import, validate, and launch through the engine's read shim, but new
artifacts are authored in format v2.

Ground rules:

- Unknown fields are rejected at every level — misspellings fail closed, never drop.
- No secrets or executable code in artifacts: templates request extensions rather than shipping them,
  and credential binding is wholly user-side. The deprecated `providers[].authRef` hint, when present,
  is a vault key *name* — never the key itself (ticket `44a5cd1`).
- The engine (`src/lib/sandbox/realmCatalog/`) is the validation authority; the CLI below calls it
  directly. Never hand-roll a schema check.

## Model — template + payload

- **Template** = hardcoded constructs + launch spec + input requirements. Content lives in bundle
  files (prompt/history `file` parts, input `defaultFile` prefills, placement `file` sources) or in
  inline text. There are no origins: requiredness is the per-input `required` flag.
- **Payload** = the structured input values, self-contained and inline-only. It repeats no paths and
  no targets — destinations live only in the template.
- **Launch** = template + payload. The launcher assembles the same payload a hydrator produces; one
  schema, one validation path.
- **Totality:** every declared input must be consumed at least once (prompt part, history part,
  placement, or directive), and every reference must resolve to a declared input. An unreferenced
  input is a template error.
- **Hash scope:** the bundle version covers the template plus its referenced bundle files; the
  payload pins the version it was produced against.

## Workflow — author → validate → hand off

1. Lay out the bundle directory (bundle id = directory name):

   ```
   my_realm/
     template.json      # the spec
     prompts/**         # `file` prompt parts (and history `file` parts)
     inputs/**          # `defaultFile` prefills
     files/**           # placement `file` sources
     README.md          # human docs, never embedded
   ```

2. Author `template.json`: top level, `inputs` (each with `id`, `label`, `shape` (`text` or
   `files`), and optional `brief`/`required`/`default`/`defaultFile`/`help`/`multiline`), `agents`,
   optional `placements` (`{ inputId | file, target, path | root }`), optional `directives`
   (`{ inputId | text, target: { agent } }`), and optional `providers` (concrete extension
   requests). `toolContract` is deprecated — see **Deprecated fields** below. Every
   `file`/`defaultFile`/placement-`file` reference must exist under the directory.
3. Assemble the transport bundle: inline `template.json` as `template` and every referenced text
   file as a `files` entry keyed by bundle-relative path. This bundle is the importable artifact.
4. Validate the bundle:

   ```bash
   node scripts/validate_realm_artifacts.mjs my_realm.bundle.json
   ```

   Read the printed canonical `version` (`sha256:…`).
5. Write the payload against a template: `formatVersion: 2`, the template id, the pinned
   `templateVersion` from step 4, and one `inputs` entry per declared input the assignment fills,
   keyed by input id and shape-matched (`{ "text": … }` for a `text` input, `{ "files": [ { "path",
   "content" } ] }` for a `files` input). Every `required` input must be present and non-empty.
6. Validate the payload against its bundle:

   ```bash
   node scripts/validate_realm_artifacts.mjs my_realm.package.json --template my_realm.bundle.json
   ```

7. Hand off: call the host's `import_realm_template` / `submit_hydration_package` with
   `dry_run: true` first (the identical resolve→validate pipeline with zero side effects), then
   without it once clean. The validated artifact itself is inline-only; the publish tools
   additionally accept tool-layer `{ "sourceFile": "<caller-visible path>" }` conveniences — a
   whole bundle `files` value, a whole payload `text` value, and per-entry
   `{ "path", "sourceFile" }` in a payload `files` value — which the host resolves through the
   caller's workspace view, caps, and validates with the same catalog code.

Minimal transport envelope:

```jsonc
{
  "formatVersion": 2,
  "template": { "formatVersion": 2, "id": "my_realm", "name": "My Realm", "description": "…",
                "agents": [ /* … */ ] },
  "files": { "prompts/protocol.md": "…", "files/seed.md": "…" }
}
```

Caps enforced host-side: 2 MiB per file; 3 MiB per bundle; 8 MiB per payload submission.

## Agent specs — the fields that matter most

Required: `key` (unique template-local identity), `idPattern` (literal, realm-opaque id — no `{…}`
placeholders, no realm vocabulary), `name`, `role`, `prompt` (ordered parts: `file` / `input` /
`text`; a `files`-input reference names exactly one file with `path`), `toolProfile` (exactly one of
`preset` or `tools`), `privileged` (boolean).

Optional: `authorities`, `triggerPolicy` (display-only — the runtime stores and echoes the label but
never gates a turn on it), `modelPresetId`, `initialPrompt`, `history` (baked prologue seeded
without a model call).

### Tool entries (`toolProfile.tools`)

Every entry must resolve, and resolution fails closed (engine: `resolveToolGrantEntry()` /
`resolveToolProfile()` in `realmCatalog/validation.ts`; `RealmAgentToolProfile` in
`realmCatalog/types.ts`). An entry may be:

- the wildcard `'*'` (explicit grant; `privileged` is a separate escalation);
- a **canonical tool name** from `tools/constants` (`SANDBOX_TOOLS`);
- an **alias spelling** of a canonical tool, accepted exactly as declared — the resolved profile
  and the runtime allowlist keep the declared spelling while the capability summary canonicalizes
  it;
- a declared legacy `toolContract` **requirement id**, resolved to its derived call name
  (deprecated — see below);
- an **extension tool reference** `<providerId>::<serverToolName>`: the provider id must be
  declared by the owning template's `providers`, and the granted model-facing call name is
  `deriveToolCallName(<serverToolName>)` — every character outside `[A-Za-z0-9_]` becomes `_`, per
  character, with no collapsing, case folding, or trimming (`lore.lookup` → `lore_lookup`).

Derived call names (`deriveToolCallName` / `isReservedToolCallName` in
`tools/normalizers/toolCallNames.ts`) must be **unreserved** and **unique**:

- reserved names — every canonical name, alias spelling, retired-selector spelling, and publishing
  meta-tool spelling (`import_realm_template`, `submit_hydration_package`), plus
  `__proto__`/`constructor`/`prototype` — fail closed, so a template-derived call can never shadow
  a baked or publishing tool;
- the uniqueness ledger is template-wide, not per agent: two declared sources that derive the same
  call name (two extension references, or a requirement id and an extension reference) fail
  validation even when they appear in different agents' profiles.

An undeclared provider id or an empty server tool name also fails closed, and publishing meta-tool
spellings are never recognized grants.

### Deprecated fields (ticket `44a5cd1`)

The legacy capability layer is still accepted — validation keeps working and requirement-id grants
keep resolving — but it is scheduled for removal at the next format revision, so do not include it
in new bundles:

- `toolContract` (and `toolContract.requirements`) — retired capability layer; reference concrete
  extension tools in `toolProfile.tools` instead.
- `providers[].provides` — accepted and shape-checked, never resolved.
- `providers[].authRef` — informational vault key *name* hint, accepted, never resolved;
  credentials stay user-side.

`providers` itself is **current**, not deprecated: its entries (`kind: "mcp"` with exactly one
transport, or `kind: "pack"` with a `publisher/name` id) are the concrete extension requests that
declare the provider ids extension tool references require.

### Declared authorities (`authorities`)

`authorities` lists **publishing-grant requests** — known ids: `@template:authority` (import
template bundles) and `@hydration:authority` (submit payloads). They are declarations, not grants:

- The declaration is inert: no engine path grants capability from template content.
- The mandatory launch review surfaces each request **per agent**; only explicitly approved
  requests are applied, as ordinary revocable operator grants. Absent approval = declined.
- Approvals for undeclared authorities are rejected; unknown authority ids fail closed at launch
  (`ERR_TEMPLATE_AUTHORITY_UNSUPPORTED`). Validation accepts any non-empty identifier.
- A per-template trust override may auto-approve only the exact `(agentKey → authority)` set the
  operator previously approved; any newly declared authority re-prompts.
- `privileged` and wildcard tool profiles never imply these grants. Declare only what the agent
  genuinely needs — e.g. the Session Zero convention grants `@template:authority` to Architect and
  `@hydration:authority` to Genesis, never jointly. See `fixtures/reference/` for a worked example.
- Holding either grant also exposes its M5b read-side meta tools at turn time: `list_templates` +
  `get_template` under `@template:authority`, and `list_hydration_packages` under
  `@hydration:authority` (`REALM_KNOWLEDGE_TOOLS` in `tools/constants`). They arrive with the
  approval; they are not part of the declaration.

## Inputs, placements, and directives

- `text` inputs carry one UTF-8 string; `default`/`defaultFile` prefills are text-only and mutually
  exclusive. `files` inputs carry an ordered fileset (`{ path, content }` entries; no archives, no
  base64) and have no prefills.
- A prompt/history `input` part injects a `text` value, or exactly one file of a `files` input
  (named by `path`). A `files` input is never injected wholesale.
- A placement names exactly one source, one target (`"realm"` or `{ agent }`), and exactly one
  destination. Sources: a declared input (`inputId`) or a bundle file (`file`, which requires
  `path`). Destinations: `path` for a `text` input, a bundle file, or a one-file fileset; `root` for
  a multi-file `files` input only (`root + file.path`, a `/` inserted when the root omits one).
  `{ inputId, target, path | root }` / `{ file, target, path }`.
- A directive delivers an operator-attributed mailbox message at launch: `{ inputId | text,
  target: { agent } }`. An optional input that resolves empty delivers nothing.
- A `required` input that resolves empty fails the launch closed.

## Naming and identity rules

- Template `id` equals the bundle directory name; `agents` is non-empty with unique `key`.
- Input ids are unique; prompt/history `input` parts, placements, and directives must reference
  declared inputs.
- `idPattern` must be a literal agent id: placeholder syntax (`{`/`}` — the retired `{realm}` token
  included) is rejected. Ids are realm-opaque — never embed realm vocabulary (`realm:`, realm ids)
  in one — and confer no authority.
- Requirement ids are namespaced (`text.similarity`); the derived model-facing call name
  (`text_similarity`) must be unreserved and unique across the template's declared sources, not just
  within one agent's resolved tool set (the derived-name ledger is template-wide).
- Paths: no null bytes, no `..` segments; identifiers and path segments reject `__proto__`,
  `constructor`, `prototype`.

## Canonical version

`templateVersion` is `sha256:<hex>` over the canonical byte stream: the authored spec re-serialized
as UTF-8 JSON with recursively sorted keys and no insignificant whitespace, then each referenced
bundle file in lexicographic path order, each framed as
`<pathLength>:<path>\n<contentLength>:<content>`. The validator prints it; payloads pin it; a
mismatch fails closed at submit (unless explicitly confirmed). Any edit to the spec or a referenced
file changes the version — re-validate and re-pin after every edit.

## Validator CLI

```bash
node scripts/validate_realm_artifacts.mjs <artifact.json> [options]

  --kind bundle|package   Force the artifact kind (default: auto-detect)
  --template <file>       Package input: a transport bundle (recommended — checks the version
                          pin) or a bare template.json spec (pin check skipped)
  --json                  Machine-readable result on stdout
  -h, --help              Usage
```

Exit codes: `0` valid · `1` invalid artifact (typed `ERR_TEMPLATE_INVALID` /
`ERR_BUNDLE_FORMAT` / `ERR_HYDRATION_PACKAGE` / `ERR_HYDRATION_VERSION_MISMATCH`) · `2`
usage/input error · `3` unexpected. Red/green fixtures and a harness:

```bash
node skills/realm-authoring/fixtures/run_fixtures.mjs
```

Fixture layout ([`fixtures/README.md`](fixtures/README.md) is the full case table):

- `fixtures/valid/` — the green format-v2 pair (`authoring_demo_v2`): a pinned multi-part `files`
  input, realm/agent/file placements, a directive, an alias tool entry, an extension tool
  reference, and a declared authority. The payload pins the bundle's canonical version.
- `fixtures/reference/` — the format-v2 declared-authorities workup (Architect →
  `@template:authority`, Genesis → `@hydration:authority`, both `privileged: true`).
- `fixtures/legacy/` — the format-v1 demo pair and the pre-cutover authorities workup, kept green
  through the engine's read shim so the compatibility path stays regression-covered.
- `fixtures/invalid/` — red cases, v1 and v2, one per fail-closed rule (unknown field, dangling
  prompt, files part without `path`, totality violation, undeclared provider, reserved derived call
  name, missing required coverage, undeclared input, fixed-placement entry, stale version).
