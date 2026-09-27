# Validator fixtures (red/green)

Worked artifacts for [`scripts/validate_realm_artifacts.mjs`](../../../scripts/validate_realm_artifacts.mjs)
and the workflow in [`../SKILL.md`](../SKILL.md).

```bash
node skills/realm-authoring/fixtures/run_fixtures.mjs   # all expectations, exit 1 on divergence
```

The harness is the skill's drift gate: it runs the real `realmCatalog` validator (no reimplemented
schema) over every case, so an engine change that invalidates a documented shape turns a fixture
red. Re-run it after touching `src/lib/sandbox/realmCatalog/`, `src/lib/sandbox/tools/`, or this
skill.

## Green cases

| path | expectation | demonstrates |
|---|---|---|
| `valid/authoring_demo_v2.bundle.json` | exit 0 | current format-v2 bundle: a pinned multi-part `files` input, realm/agent/file placements, a launch directive, an alias tool entry, an extension tool reference, and a declared publishing authority |
| `valid/authoring_demo_v2.package.json` | exit 0 (with `--template valid/authoring_demo_v2.bundle.json`) | format-v2 payload pinning the bundle's canonical version and filling the required `text` + `files` inputs |
| `reference/session_zero_reference.bundle.json` | exit 0 | format-v2 declared-authorities workup (Architect → `@template:authority`, Genesis → `@hydration:authority`, both `privileged: true`) |
| `legacy/authoring_demo_v1.bundle.json` | exit 0 | format-v1 demo bundle accepted through the engine's read shim (legacy compatibility) |
| `legacy/authoring_demo_v1.package.json` | exit 0 (with `--template legacy/authoring_demo_v1.bundle.json`) | format-v1 hydration package pinning the v1 canonical version |
| `legacy/session_zero_reference_v1.bundle.json` | exit 0 | pre-cutover format-v1 authorities workup through the read shim |

## Red cases

| path | expectation | demonstrates |
|---|---|---|
| `invalid/unknown_field.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | misspelled agent field fails closed |
| `invalid/dangling_prompt.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | prompt `file` part not carried by the bundle |
| `invalid/v2_files_part_without_path.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | a `files` input reference without a `path` fails (never injected wholesale) |
| `invalid/v2_unreferenced_input.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | a declared input no surface consumes violates the v2 totality rule |
| `invalid/v2_undeclared_provider.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | extension tool reference to an undeclared provider id |
| `invalid/v2_reserved_call_name.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | extension reference whose derived call name is reserved |
| `invalid/missing_generated_slot.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | required generated slot absent (v1 package) |
| `invalid/undeclared_input.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | package value for an undeclared input (v1 package) |
| `invalid/fixed_slot.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | package entry targeting a `fixed` slot (v1 package) |
| `invalid/v2_undeclared_input.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | v2 payload value for an undeclared input |
| `invalid/v2_stale_version.package.json` | exit 1 `ERR_HYDRATION_VERSION_MISMATCH` | v2 payload pin ≠ current bundle version |
| `invalid/stale_version.package.json` | exit 1 `ERR_HYDRATION_VERSION_MISMATCH` | v1 package pin ≠ current bundle version |

`expectations.json` is the machine-checked manifest the harness reads.

The green `valid/` bundle + payload are a pair: the payload's `templateVersion` is the canonical
version of the bundle. Editing the bundle (spec or any referenced file) changes that version, so
re-run the validator on the bundle, re-pin the payload, and re-run the harness. The `legacy/`
documents are frozen format-v1 examples kept green through the read shim — do not migrate them in
place; new artifacts are authored in format v2.
