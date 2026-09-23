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

**Status:** living skill (format v2; the v1 contract is a historical snapshot) · **Last verified:** 2026-09-23.

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
- No secrets or executable code in artifacts: `providers[].authRef` is a vault key *name*, never the
  key itself, and templates request providers rather than shipping them.
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
   (`{ inputId | text, target: { agent } }`), and optional `toolContract`/`providers`. Every
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
   without it once clean. The host resolves `{ "sourceFile": "<caller-visible path>" }` refs
   host-side, caps the payloads, and validates with the same catalog code.

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
`preset` or `tools`; `tools` entries must be canonical tool names or declared requirement ids),
`privileged` (boolean).

Optional: `authorities`, `triggerPolicy` (display-only — never rely on it at runtime),
`modelPresetId`, `initialPrompt`, `history` (baked prologue seeded without a model call).

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

## Inputs, placements, and directives

- `text` inputs carry one UTF-8 string; `default`/`defaultFile` prefills are text-only and mutually
  exclusive. `files` inputs carry an ordered fileset (`{ path, content }` entries; no archives, no
  base64) and have no prefills.
- A prompt/history `input` part injects a `text` value, or exactly one file of a `files` input
  (named by `path`). A `files` input is never injected wholesale.
- A placement writes a text value, a bundle file, or a whole fileset into a workspace:
  `{ inputId, target: "realm" | { agent }, path }` for single values/one-file filesets,
  `{ inputId, target, root }` for multi-file filesets (`root + file.path`).
- A directive delivers an operator-attributed mailbox message at launch: `{ inputId | text,
  target: { agent } }`. An optional input that resolves empty delivers nothing.
- A `required` input that resolves empty fails the launch closed.

## Naming and identity rules

- Template `id` equals the bundle directory name; `agents` is non-empty with unique `key`.
- Input ids are unique; prompt/history `input` parts, placements, and directives must reference
  declared inputs.
- `idPattern` is a literal id: `{`/`}` and realm vocabulary are rejected. Ids confer no authority.
- Requirement ids are namespaced (`text.similarity`); the derived model-facing call name
  (`text_similarity`) must be unique within an agent's resolved tool set.
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

`fixtures/valid/` holds the passing bundle + package pair and the canonical version they pin;
`fixtures/invalid/` holds one red case per validation rule (unknown field, dangling prompt,
missing required coverage, undeclared input, fixed-placement entry, stale version);
`fixtures/reference/` holds the declared-authorities workup — a pre-release engine build that
predates the additive `authorities` field rejects it as an unknown field, so validate it against
the build you will import into.
