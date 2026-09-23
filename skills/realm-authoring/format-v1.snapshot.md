# Format v1 — snapshot (may evolve pre-release)

**Status:** snapshot of the accepted format-v1 contract (extracted 2026-09-21) · **Last verified:** 2026-09-21.

> **Historical snapshot (post-cutover).** The engine's canonical format is now v2
> (`skills/realm-authoring/SKILL.md`). This file documents the frozen format-v1 contract that
> legacy documents are still validated against: `normalizeTemplate()` converts them to the
> canonical model, and the transport, version, payload, and materialization entry points accept
> them at their authored boundary. The v1-only API names mentioned below (for example
> `validateHydrationPackage`) were deleted in the cutover — v1 *documents* flow through the read
> shim, not through a public v1 API.

> **format v1 (snapshot — may evolve pre-release).** This is a convenience copy for offline
> authoring: the field tables, the declared-authority semantics, the hydration-package contract,
> the canonical version definition, the validation rules, and the draft 2020-12 JSON schema.
> The engine (`src/lib/sandbox/realmCatalog/`) is the authority — when this snapshot and the
> engine disagree, the engine wins. Validate every artifact with
> `node scripts/validate_realm_artifacts.mjs` rather than trusting this file alone.

## A. `template.json` field tables

### A.1 Top level

| field | type | required | notes |
|---|---|---|---|
| `formatVersion` | `1` | yes | schema version |
| `id` | string | yes | must equal the bundle directory name |
| `name` | string | yes | launcher title |
| `description` | string | yes | launcher subtitle (may be empty in draft templates) |
| `notes` | string | no | author commentary, shown in the launcher |
| `hydration` | `{ brief: string }` | no | overall instruction for a hydrator |
| `inputs` | `Input[]` | no | content form (A.2) |
| `agents` | `AgentSpec[]` | yes | non-empty, unique `key` |
| `seed` | `SeedManifest` | no | file slots + first directive (A.5) |
| `toolContract` | `{ requirements: Requirement[] }` | no | capability needs (A.7) |
| `providers` | `Provider[]` | no | where capabilities come from (A.8) |

Unknown fields are rejected at every level — a misspelled field fails closed.

### A.2 `Input`

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | unique; referenced by prompt parts via `{ "kind": "input", "inputId": … }` |
| `label` | string | yes | form label |
| `help` | string | no | author commentary shown under the field |
| `origin` | `"user"` \| `"generated"` | no | default `"user"` |
| `brief` | string | cond. | required when `origin: "generated"`; ignored otherwise |
| `default` | string | no | prefill; `user` origin only |
| `defaultFile` | string | no | prefill from a bundle file (safe path); `user` origin only; mutually exclusive with `default` |
| `required` | boolean | no | launch blocked while empty |
| `multiline` | boolean | no | UI hint, default `true` |

Values are **launch-level**: one value per input per instance, used wherever referenced; an empty
value contributes nothing to composition.

### A.3 `AgentSpec`

| field | type | required | notes |
|---|---|---|---|
| `key` | string | yes | template-local identity; referenced by seed targets and directives |
| `idPattern` | string | yes | literal realm-opaque agent id (no `{…}` placeholders; realm-vocabulary ids are rejected) |
| `name` | string | yes | display name |
| `role` | string | yes | role/archetype |
| `prompt` | `Part[]` | yes | ordered system-prompt parts (A.4), ≤ 64 parts, ≤ 200 KB composed |
| `toolProfile` | `{ preset }` or `{ tools: string[] }` | yes | exactly one; `tools` entries are canonical tool names or requirement ids (A.7) |
| `privileged` | boolean | yes | launch requires authority; disclaimed in review |
| `authorities` | string[] | no | declared publishing-grant requests; inert until approved in the launch review (B) |
| `triggerPolicy` | string | no | display-only label (inert; never rely on it) |
| `modelPresetId` | string | no | resolved by the preset catalog at launch |
| `initialPrompt` | string | no | launches one user turn with this text |
| `history` | `HistoryEntry[]` | no | baked prologue (A.6) |

### A.4 `Part`

```jsonc
{ "kind": "file",  "path": "prompts/protocol.md" }   // bundle file, verbatim
{ "kind": "input", "inputId": "briefing" }            // launch value; empty contributes nothing
{ "kind": "text",  "text": "literal text" }
```

Parts compose **in declared order**, joined with `\n\n`; a `file` part whose path is missing fails
closed; `input` parts must reference a declared input.

### A.5 `SeedManifest` / `SeedFile` (content slots)

`seed.directive` is `{ targetAgentKey, text }`: delivered as the first message (operator-attributed,
`source: realm_seed`); requires ≥ 1 file targeting the same agent key.

| `SeedFile` field | type | required | notes |
|---|---|---|---|
| `path` | string | yes | destination path (no `..`, no null bytes; store-side root checks apply) |
| `target` | `"realm"` or `{ "agent": key }` | yes | realm's shared workspace or one member's private workspace |
| `origin` | `"fixed"` \| `"user"` \| `"generated"` | no | default `"fixed"` when `source` is present |
| `brief` | string | cond. | required for `generated`; optional for `user` |
| `source` | `{ "file": path }` or `{ "inline": text }` | cond. | **required** for `fixed`; **forbidden** for `user`/`generated` |

- `fixed` slots ship their bytes in the bundle.
- `user` slots are attached at launch (file picker); may be optional (absent → not written).
- `generated` slots are filled from the hydration package; a missing required slot blocks launch.

### A.6 `HistoryEntry`

```jsonc
{ "role": "assistant", "content": [ { "kind": "input", "inputId": "opening_scene" } ] }
```

- `role`: `"user"` (operator-attributed) or `"assistant"` (the agent itself). System content is the
  composed prompt, not a history entry.
- `content`: the same `Part[]` model; a baked opener may be `fixed`, `user` or `generated` (hydration).
- Seeded at launch **without a model call**; message ids are generated at launch.
- `initialPrompt` / the seed directive remain the turn triggers; a template may open with an
  assistant message and start *in medias res*.

### A.7 `toolProfile` / `toolContract.Requirement`

`toolProfile`: exactly one of `preset` (a named tier) or `tools` (explicit list). `tools` entries are
either **canonical tool names** (resolved from the tool catalog) or **requirement ids** from
`toolContract`; an entry that is neither is a validation error. Wildcard `"*"` remains
authority-gated. Presets (v1): `all`, `manager`, `collaborator`, `readonly_collaborator`, `readonly`.

| `Requirement` field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | capability id, namespaced (`text.similarity`, `acme.scoring.similarity`) |
| `brief` | string | yes | human/agent-readable description of the capability |
| `io` | `{ "in": Record<string,string>, "out": Record<string,string> }` | yes | minimal signature (names → type labels) |
| `required` | boolean | no | default `true`; `false` allows degradation |
| `range` | string | no | semver range of acceptable implementations |
| `prefer` | string[] | no | preferred provider ids (hints, not bindings) |

The **model-facing call name** is derived from the requirement id (`text.similarity` →
`text_similarity`) and is stable across implementations; it must be unique within an agent's
resolved tool set (collision = launch error).

### A.8 `Provider`

```jsonc
// a host-installed tool pack
{ "kind": "pack", "id": "acme/text-tools", "range": "^1",
  "source": "https://example.com/acme-text-tools" }

// an MCP server
{ "kind": "mcp", "id": "acme-scoring",
  "transport": { "kind": "http",  "url": "https://mcp.example.com" },
  // or: { "kind": "stdio", "command": "npx", "args": ["-y", "@acme/scoring-mcp"] }
  "provides": [ { "capability": "text.similarity", "tool": "similarity" },
                { "capability": "text.cosine_distance", "tool": "cosine" } ],
  "authRef": "acme_scoring_key" }        // credential vault key *name*; never a secret
```

- Providers are **requests**: the host installs packs / connects MCP servers. Templates never ship
  or auto-load executable code, and never carry credentials.
- `pack.id` is `publisher/name`; `mcp.transport` is exactly one of http/stdio. `provides` maps a
  provider surface (tool name) to a capability id; the host binds requirements to providers at
  launch/review (unique match auto-binds; required + missing → launch blocked).
- v1 validates and resolves provider requests but never connects.

## B. Declared authorities — `AgentSpec.authorities` (additive v1)

`authorities` lists publishing-grant requests. At v1 the known set is exactly:

| authority | grants |
|---|---|
| `@template:authority` | import template bundles |
| `@hydration:authority` | submit hydration packages |

Semantics (declaration is inert data — no engine path grants from template content):

- Shape: non-empty unique strings. Validation accepts any non-empty identifier; identifiers
  unknown to the host **fail closed at launch** (`ERR_TEMPLATE_AUTHORITY_UNSUPPORTED`), mirroring
  `providers`.
- The mandatory launch review surfaces each request **per agent**, and only explicitly approved
  requests are applied, as ordinary revocable operator grants. Absent approval = declined: the
  agent simply lacks the authority. Approvals for undeclared authorities are rejected.
- A host may offer a per-template trust override: it auto-approves only the **exact**
  `(agentKey → authority)` set the operator previously approved; any newly declared authority
  re-prompts. Clearing the override revokes it.
- Neither `privileged` nor a wildcard tool profile implies these grants; they are never granted
  jointly by default. Publishing never creates instances — realm launch stays an operator action
  in the review ("attach at launch only").

## C. Hydration package

```jsonc
{
  "formatVersion": 1,
  "templateId": "consensus_test",
  "templateVersion": "sha256:…",          // bundle content hash at hydration time
  "inputs": { "motion": "…", "stance_a": "…", "stance_b": "…", "rubric": "…", "max_rounds": "10" },
  "files": [                               // one entry per `generated`/`user` slot, matching path+target
    { "path": "lore/world.md", "target": "realm", "content": "…" }
  ],
  "provenance": { "hydrator": "hydration builtin", "generatedAt": "2026-09-21T…", "model": "…", "reviewedBy": "owner" }
}
```

Rules: entries must match declared slots (`generated` slots required unless the slot is optional;
unknown/extra entries rejected; `fixed` slots must not appear); `templateVersion` mismatch fails
closed at submit and warns in review with explicit confirmation; large payloads may inline files
alongside as `<path>` entries (packaging detail). **Tool resolution is host-side** and recorded on
the instance, not in the package. `provenance` is an optional closed block of non-empty strings
(`hydrator`, `generatedAt`, `model`, `reviewedBy`) — never secrets.

## D. Canonical version

- `templateVersion` = `sha256:<hex>` over the canonical byte stream: the spec re-serialized as
  UTF-8 JSON with recursively sorted keys and no insignificant whitespace, then each referenced
  bundle file in lexicographic path order, each framed as
  `<pathLength>:<path>\n<contentLength>:<content>`.
- A package pins the template version; mismatch → review warning + explicit confirmation.
- Templates (manifest + files) and packages are plain JSON + text: portable, importable/exportable
  without the app (this skill writes them; the app validates them).

## E. Validation rules (fail-closed)

Defaults preserving draft compatibility: `Input.origin` absent → `"user"`; `SeedFile.origin`
absent → `"fixed"` (requires `source`); absent `hydration`, `notes`, `history`, `toolContract`,
`providers` are all valid.

Closed shapes and cross-references:

- Unknown fields are rejected at every level.
- `id` equals the bundle directory; `agents` non-empty with unique `key`; `idPattern` rejects
  `{`/`}` and realm-vocabulary ids.
- Prompt `file` paths and `input` references must resolve (inputs declared; bundle files exist in
  baked/imported bundles).
- `toolProfile.tools` entries must be canonical tool names or declared requirement ids.
- `provider.kind` ∈ {`pack`,`mcp`}; `pack.id` is `publisher/name`; `mcp.transport` is exactly one of
  http/stdio; `authRef` is a key name, never a secret.
- `seed.directive.targetAgentKey` must name a declared agent key and have ≥ 1 same-target file slot.
- Package entries must match declared slots and origins; required `generated` slots present; no
  `fixed` entries.
- Paths: no null bytes, no `..` segments; store-side root/reserved checks apply at write time.
- Caps: ≤ 64 parts per agent, ≤ 200 KB composed prompt, bundle file cap per the embed pipeline.
- `required` inputs non-empty at launch; call-name collisions rejected.
- Identifier and path segments reject the reserved property names `__proto__`, `constructor`,
  `prototype`.

## F. Host handoff (the publishing tools)

The host exposes two tools; both take **exactly one** manifest form (`manifest` inline or
`manifest_file`) and an optional `dry_run: true`, which runs the identical resolve→validate
pipeline with typed errors and **zero side effects** (no import, no registry mutation) — iterate
with it before the real call.

- `import_realm_template` — manifest is the transport envelope `{ formatVersion: 1, template, files }`.
  Each `files` value is a string OR `{ "sourceFile": "<caller-visible path>" }`; the host resolves
  refs through the caller's workspace view, caps (2 MiB/file, 3 MiB total), then
  `parseTemplateBundle()`-validates and imports.
- `submit_hydration_package` — manifest is the package with `inputs` values (or
  `{ "sourceFile": … }`) and `files` entries (`content?` or `sourceFile`); the host resolves refs,
  caps (2 MiB/file, 8 MiB total), builds the canonical inline package, and calls
  `validateHydrationPackage(template, pkg, { currentVersion })` — a version mismatch fails closed.
  Valid submissions become a session-only candidate; the operator reviews and attaches at launch.

## Appendix — JSON Schema (draft 2020-12, compact)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-story.local/schemas/realm-template-v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["formatVersion", "id", "name", "description", "agents"],
  "properties": {
    "formatVersion": { "const": 1 },
    "id": { "type": "string", "minLength": 1 },
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "notes": { "type": "string", "minLength": 1 },
    "hydration": { "type": "object", "additionalProperties": false, "required": ["brief"],
      "properties": { "brief": { "type": "string", "minLength": 1 } } },
    "inputs": { "type": "array", "items": { "$ref": "#/$defs/input" } },
    "agents": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/agent" } },
    "seed": { "$ref": "#/$defs/seed" },
    "toolContract": { "type": "object", "additionalProperties": false,
      "properties": { "requirements": { "type": "array", "items": { "$ref": "#/$defs/requirement" } } } },
    "providers": { "type": "array", "items": { "$ref": "#/$defs/provider" } }
  },
  "$defs": {
    "part": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["kind", "path"],
          "properties": { "kind": { "const": "file" }, "path": { "type": "string", "minLength": 1 } } },
        { "type": "object", "additionalProperties": false, "required": ["kind", "inputId"],
          "properties": { "kind": { "const": "input" }, "inputId": { "type": "string", "minLength": 1 } } },
        { "type": "object", "additionalProperties": false, "required": ["kind", "text"],
          "properties": { "kind": { "const": "text" }, "text": { "type": "string" } } }
      ]
    },
    "input": {
      "type": "object", "additionalProperties": false, "required": ["id", "label"],
      "properties": {
        "id": { "type": "string", "minLength": 1 }, "label": { "type": "string", "minLength": 1 },
        "help": { "type": "string", "minLength": 1 },
        "origin": { "enum": ["user", "generated"] }, "brief": { "type": "string", "minLength": 1 },
        "default": { "type": "string" }, "defaultFile": { "type": "string", "minLength": 1 },
        "required": { "type": "boolean" }, "multiline": { "type": "boolean" }
      }
    },
    "historyEntry": {
      "type": "object", "additionalProperties": false, "required": ["role", "content"],
      "properties": { "role": { "enum": ["user", "assistant"] },
        "content": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/part" } } }
    },
    "agent": {
      "type": "object", "additionalProperties": false,
      "required": ["key", "idPattern", "name", "role", "prompt", "toolProfile", "privileged"],
      "properties": {
        "key": { "type": "string", "minLength": 1 }, "idPattern": { "type": "string", "minLength": 1 },
        "name": { "type": "string", "minLength": 1 }, "role": { "type": "string", "minLength": 1 },
        "prompt": { "type": "array", "minItems": 1, "maxItems": 64, "items": { "$ref": "#/$defs/part" } },
        "toolProfile": { "$ref": "#/$defs/toolProfile" },
        "privileged": { "type": "boolean" },
        "authorities": { "type": "array", "items": { "type": "string", "minLength": 1 }, "uniqueItems": true },
        "triggerPolicy": { "type": "string", "minLength": 1 },
        "modelPresetId": { "type": "string", "minLength": 1 },
        "initialPrompt": { "type": "string", "minLength": 1 },
        "history": { "type": "array", "items": { "$ref": "#/$defs/historyEntry" } }
      }
    },
    "toolProfile": {
      "type": "object", "additionalProperties": false,
      "properties": { "preset": { "type": "string", "minLength": 1 },
                      "tools": { "type": "array", "items": { "type": "string", "minLength": 1 } } }
    },
    "seed": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "files": { "type": "array", "items": { "$ref": "#/$defs/seedFile" } },
        "directive": { "type": "object", "additionalProperties": false,
          "required": ["targetAgentKey", "text"],
          "properties": { "targetAgentKey": { "type": "string", "minLength": 1 },
                          "text": { "type": "string", "minLength": 1 } } }
      }
    },
    "seedFile": {
      "type": "object", "additionalProperties": false, "required": ["path", "target"],
      "properties": {
        "path": { "type": "string", "minLength": 1 },
        "target": { "oneOf": [ { "const": "realm" },
          { "type": "object", "additionalProperties": false, "required": ["agent"],
            "properties": { "agent": { "type": "string", "minLength": 1 } } } ] },
        "origin": { "enum": ["fixed", "user", "generated"] },
        "brief": { "type": "string", "minLength": 1 },
        "source": { "oneOf": [
          { "type": "object", "additionalProperties": false, "required": ["file"],
            "properties": { "file": { "type": "string", "minLength": 1 } } },
          { "type": "object", "additionalProperties": false, "required": ["inline"],
            "properties": { "inline": { "type": "string" } } } ] }
      }
    },
    "requirement": {
      "type": "object", "additionalProperties": false, "required": ["id", "brief", "io"],
      "properties": {
        "id": { "type": "string", "minLength": 1 }, "brief": { "type": "string", "minLength": 1 },
        "io": { "type": "object", "additionalProperties": false, "required": ["in", "out"],
          "properties": { "in": { "type": "object" }, "out": { "type": "object" } } },
        "required": { "type": "boolean" }, "range": { "type": "string", "minLength": 1 },
        "prefer": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      }
    },
    "provider": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["kind", "id"],
          "properties": { "kind": { "const": "pack" }, "id": { "type": "string", "minLength": 1 },
                          "range": { "type": "string", "minLength": 1 },
                          "source": { "type": "string", "minLength": 1 } } },
        { "type": "object", "additionalProperties": false, "required": ["kind", "id", "transport"],
          "properties": {
            "kind": { "const": "mcp" }, "id": { "type": "string", "minLength": 1 },
            "transport": { "oneOf": [
              { "type": "object", "additionalProperties": false, "required": ["kind", "url"],
                "properties": { "kind": { "const": "http" }, "url": { "type": "string", "minLength": 1 } } },
              { "type": "object", "additionalProperties": false, "required": ["kind", "command"],
                "properties": { "kind": { "const": "stdio" }, "command": { "type": "string", "minLength": 1 },
                                "args": { "type": "array", "items": { "type": "string" } } } } ] },
            "provides": { "type": "array", "items": { "type": "object", "additionalProperties": false,
              "required": ["capability"],
              "properties": { "capability": { "type": "string", "minLength": 1 },
                              "tool": { "type": "string", "minLength": 1 } } } },
            "authRef": { "type": "string", "minLength": 1 }
          } }
      ]
    }
  }
}
```
