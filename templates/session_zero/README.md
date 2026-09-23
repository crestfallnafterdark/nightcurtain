# session_zero — template bundle

**Status:** Shipped bundle content · **Last verified:** 2026-09-22.

One generator realm hosting both generator agents on the format-v2 template
primitives. *Session Zero* is an ordinary template: it is launched through the
standard review path, replaceable/shadowable like any other bundle, and the host
has no generator-specific orchestration. Publishing happens only through the
validated tool paths.

## Layout

- `template.json` — manifest: two privileged agents (`architect`, `genesis`),
  each with ordered prompt parts (shared operational rules → agent protocol →
  the `assignment` and `target_template` launch inputs), an explicit plumbing
  `toolProfile`, and a declared publishing authority. Two placements seed the
  realm workspace at launch: the bundled `files/handoff_readme.md` body lands at
  `/global/handoff/README.md`, and the optional `handoff_notes` files input
  lands at `/global/handoff/notes.md`.
- `prompts/operational_rules.md` — the shared operational contract: workspace
  view, `/global/...` handoff conventions, caps, typed-error recovery loop, and
  the operator-content prohibition.
- `prompts/architect_protocol.md` — template-authoring procedure (author parts
  as files by reference, assemble the transport manifest, `dry_run`, import,
  hand off) with a worked example.
- `prompts/genesis_protocol.md` — payload-generation procedure (read the
  handoff, assemble input bodies by reference, pin the version, `dry_run`,
  submit, report) with a worked example.
- `files/handoff_readme.md` — bundle file placed at `/global/handoff/README.md`
  at launch; the `handoff_notes` files input is placed at
  `/global/handoff/notes.md` when the operator attaches notes.
- `README.md` — this human doc (not embedded in any prompt).

## Authorities and approval

- **Architect** declares `@template:authority`; **Genesis** declares
  `@hydration:authority`. Per-agent, never jointly by default.
- The declarations are inert: the mandatory launch review approves or declines
  each (agent, authority) request per agent, absent means declined, and only
  approved requests are applied as ordinary revocable operator grants. A
  "trust this template" override auto-approves only the exact previously
  approved set; new declarations re-prompt.
- The two publishing tools (`import_realm_template`,
  `submit_hydration_package`) are explicit-grant-only and deliberately live
  outside the canonical taxonomy: they are **not** listed in any `toolProfile`
  (no preset, wildcard, or profile selector can expose them). Once the grant is
  approved, the host exposes the tool to that agent; `privileged` alone never
  grants publishing.
- Both agents are `privileged: true` so either can read the other's private
  workspace in-realm (`/agents/<id>/...`) for the author→hydrate handoff;
  privilege never implies the publishing authorities.

## Worked flow

1. Launch Session Zero, fill the `assignment` input, and approve both declared
   authorities in the review (optionally trust the template).
2. Architect authors bundle files under `/global/work/<id>/`, writes
   `import.manifest.json`, iterates with
   `import_realm_template { manifest_file, dry_run: true }`, then imports for
   real and writes `/global/handoff/<id>.md` (template id + canonical version).
3. Genesis reads the handoff, assembles the payload input bodies by reference,
   writes the format-v2 payload manifest (pinned `templateVersion`), iterates
   with `submit_hydration_package { manifest_file, dry_run: true }`, then
   submits for real; the candidate is session-only until the operator reviews
   and attaches it at launch.

## Owner decisions (2026-09-21/22)

1. **One standard realm, no special hydrator** — Session Zero hosts both
   generators and is imported through standard means.
2. **Dedicated per-agent grants** — Architect `@template:authority`, Genesis
   `@hydration:authority`; privilege and wildcard never imply them.
3. **Declared authorities are inert** — the launch review is the approval act;
   unknown authority ids fail closed at launch.
4. **Filesystem-first submission** — manifests reference files; bytes never
   transit model context.
5. **`dry_run` iteration** — the identical resolve→validate pipeline with zero
   side effects before every real call.
