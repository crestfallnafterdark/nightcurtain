# Session Zero — handoff directory

This directory is the realm-global handoff surface for Session Zero. Both
members read and write it; keep the artifact trail here rather than in private
workspaces.

## Conventions

- `/global/handoff/<template_id>.md` — the target brief: template id, canonical
  version, where the spec lives, and what the payload must contain.
- `/global/work/<template_id>/` — working directory for one artifact: bundle
  files, manifests, and assembled content.
- `/global/work/<template_id>/import.manifest.json` — Architect's transport
  manifest (`{ formatVersion: 2, template, files }`).
- `/global/work/<template_id>/hydrate.manifest.json` — Genesis's format-v2
  payload submission manifest.
- `/global/source/` — operator-staged source material for this run (protocol
  prompts, briefs, lore), staged from the optional `source_pack` launch input.
  Read it; never edit it.
- `/global/handoff/notes.md` — operator notes attached at launch (when provided;
  a single file).

Bytes move by reference: manifests name `sourceFile` paths and the host resolves
them at submit time, so large content never transits a model's context. Payload
fileset entries carry their own `{ path, sourceFile }` per-entry references.
