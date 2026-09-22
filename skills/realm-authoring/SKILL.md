---
name: realm-authoring
description: >-
  Author and validate Realm format-v1 artifacts for the ai-story engine: template
  bundles ({formatVersion, template, files}) and hydration packages, including
  AgentSpec.authorities declaration and launch-approval semantics. Use when
  producing, revising, or pre-flight validating realm templates or packages, or
  when running scripts/validate_realm_artifacts.mjs. Ships a format-v1 snapshot
  for offline use; validation always runs the engine's real realmCatalog code.
---

# Realm authoring (format v1)

**Status:** living skill (snapshot pinned to format v1) · **Last verified:** 2026-09-21.

You author two portable artifacts for the ai-story Realm engine. The host app owns import,
review, and launch; this skill owns authoring and pre-flight validation.

| Artifact | Shape | Consumed by |
|---|---|---|
| **Template bundle** | `{ "formatVersion": 1, "template": {…}, "files": { "<path>": "<text>" } }` | host `import_realm_template` tool (dry-run first) |
| **Hydration package** | `{ "formatVersion": 1, "templateId", "templateVersion", "inputs", "files", "provenance"? }` | host `submit_hydration_package` tool → launch review → attach at launch |

Field tables, the declared-authority semantics, the hydration-package contract, the canonical
version definition, the validation rules, and the draft 2020-12 JSON schema are in
[`format-v1.snapshot.md`](format-v1.snapshot.md) (**format v1 (snapshot — may evolve pre-release)**).

Ground rules:

- Unknown fields are rejected at every level — misspellings fail closed, never drop.
- No secrets or executable code in artifacts: `providers[].authRef` is a vault key *name*, never the
  key itself, and templates request providers rather than shipping them.
- The engine (`src/lib/sandbox/realmCatalog/`) is the validation authority; the CLI below calls it
  directly. Never hand-roll a schema check.

## Workflow — author → validate → hand off

1. Lay out the bundle directory (bundle id = directory name):

   ```
   my_realm/
     template.json      # the spec
     prompts/**         # `file` prompt parts (and history `file` parts)
     inputs/**          # `defaultFile` prefills
     files/**           # `fixed` seed `source.file` bodies
     README.md          # human docs, never embedded
   ```

2. Author `template.json` against the snapshot: top level, inputs, agents, seed, `toolContract`,
   `providers`. Every `file`/`defaultFile`/`source.file` reference must exist under the directory.
3. Assemble the transport bundle: inline `template.json` as `template` and every referenced text
   file as a `files` entry keyed by bundle-relative path. This bundle is the importable artifact.
4. Validate the bundle:

   ```bash
   node scripts/validate_realm_artifacts.mjs my_realm.bundle.json
   ```

   Read the printed canonical `version` (`sha256:…`).
5. Write the hydration package against a template: fill `inputs` (generated values; user values are
   supplied at launch), one `files` entry per `generated`/`user` seed slot (exact `path` + `target`),
   all `fixed` slots omitted, and pin `templateVersion` to the version from step 4.
6. Validate the package against its bundle:

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
  "formatVersion": 1,
  "template": { "formatVersion": 1, "id": "my_realm", "name": "My Realm", "description": "…",
                "agents": [ /* … */ ] },
  "files": { "prompts/protocol.md": "…", "files/seed.md": "…" }
}
```

Caps enforced host-side: 2 MiB per file; 3 MiB per bundle; 8 MiB per hydration package.

## Agent specs — the fields that matter most

Required: `key` (unique template-local identity), `idPattern` (literal, realm-opaque id — no `{…}`
placeholders, no realm vocabulary), `name`, `role`, `prompt` (ordered parts: `file` / `input` /
`text`, ≤ 64 parts, ≤ 200 KB composed), `toolProfile` (exactly one of `preset` or `tools`;
`tools` entries must be canonical tool names or declared requirement ids), `privileged` (boolean).

Optional: `authorities`, `triggerPolicy` (display-only — never rely on it at runtime),
`modelPresetId`, `initialPrompt`, `history` (baked prologue seeded without a model call).

### Declared authorities (`authorities`)

`authorities` lists **publishing-grant requests** — v1 known ids: `@template:authority` (import
template bundles) and `@hydration:authority` (submit hydration packages). They are declarations,
not grants:

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

## Content origins and slots

Every content artifact declares an origin, and validation is origin-strict:

| origin | inputs | seed file slots |
|---|---|---|
| `user` (default for inputs) | operator-supplied at launch; `default`/`defaultFile` allowed | attached at launch; may be optional; no `source` |
| `generated` | requires a `brief`; no prefills | requires a `brief`; filled from the package; missing ⇒ launch blocked; no `source` |
| `fixed` (default for slots when `source` present) | — | ships bytes in the bundle; `source: { file \| inline }` required |

Hydration entries match slots by **`path` + `target`** exactly (`target` is `"realm"` or
`{ "agent": "<key>" }`). A package must not carry `fixed` slots, unknown or duplicate entries, or
values for undeclared inputs. A `seed.directive` must name a declared agent key and have at least
one same-target file slot.

## Naming and identity rules

- Template `id` equals the bundle directory name; `agents` is non-empty with unique `key`.
- Input ids are unique; prompt/history `input` parts must reference declared inputs.
- `idPattern` is a literal id: `{`/`}` and realm vocabulary are rejected. Ids confer no authority.
- Requirement ids are namespaced (`text.similarity`); the derived model-facing call name
  (`text_similarity`) must be unique within an agent's resolved tool set.
- Paths: no null bytes, no `..` segments; identifiers and path segments reject `__proto__`,
  `constructor`, `prototype`.

## Canonical version

`templateVersion` is `sha256:<hex>` over the canonical byte stream: the spec re-serialized as
UTF-8 JSON with recursively sorted keys and no insignificant whitespace, then each referenced
bundle file in lexicographic path order, each framed as `<pathLength>:<path>\n<contentLength>:<content>`.
The validator prints it; packages pin it; a mismatch fails closed at submit. Any edit to the spec
or a referenced file changes the version — re-validate and re-pin after every edit.

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
missing generated slot, undeclared input, fixed-slot entry, stale version);
`fixtures/reference/` holds the declared-authorities workup — a pre-release engine build that
predates the additive `authorities` field rejects it as an unknown field, so validate it against
the build you will import into.
