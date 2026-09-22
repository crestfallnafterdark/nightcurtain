# Validator fixtures (red/green)

Worked artifacts for [`scripts/validate_realm_artifacts.mjs`](../../../scripts/validate_realm_artifacts.mjs)
and the workflow in [`../SKILL.md`](../SKILL.md).

```bash
node skills/realm-authoring/fixtures/run_fixtures.mjs   # all expectations, exit 1 on divergence
```

| path | expectation | demonstrates |
|---|---|---|
| `valid/authoring_demo.bundle.json` | exit 0 | packet-valid template: prompt parts, input origins, fixed + generated seed slots, baked history, requirement id in `tools`, one MCP provider request |
| `valid/authoring_demo.package.json` | exit 0 (with `--template valid/authoring_demo.bundle.json`) | package pinning the bundle's canonical version, filling the generated input + slot |
| `invalid/unknown_field.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | misspelled agent field fails closed |
| `invalid/dangling_prompt.bundle.json` | exit 1 `ERR_TEMPLATE_INVALID` | prompt `file` part not carried by the bundle |
| `invalid/missing_generated_slot.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | required `generated` slot absent |
| `invalid/undeclared_input.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | package value for an undeclared input |
| `invalid/fixed_slot.package.json` | exit 1 `ERR_HYDRATION_PACKAGE` | package entry targeting a `fixed` slot |
| `invalid/stale_version.package.json` | exit 1 `ERR_HYDRATION_VERSION_MISMATCH` | pinned version ≠ current bundle version |

`expectations.json` is the machine-checked manifest the harness reads.

The two valid fixtures are a pair: the package's `templateVersion` is the canonical version of the
bundle. Editing the bundle (spec or any referenced file) changes that version, so re-run the
validator on the bundle, re-pin the package, and re-run the harness.

`reference/session_zero_reference.bundle.json` is the declared-authorities workup (Architect →
`@template:authority`, Genesis → `@hydration:authority`, both `privileged: true`). It is **not** in
the harness manifest: on an engine build that predates the additive v1 `authorities` field
(wave U U-P) the validator rejects it as an unknown field, and it must validate once that field
lands. Validate it against the build you intend to import into.
