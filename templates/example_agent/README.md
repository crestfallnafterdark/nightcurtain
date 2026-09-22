# example_agent — template bundle

**Status:** Shipped reference bundle · **Last verified:** 2026-09-22.

Minimal, story-free reference for the format-v1 template primitives, and the
fixture used by the realm pipeline and multi-instance suites.

## Layout

- `template.json` — one unprivileged `assistant` agent with the explicit
  zero-tool profile (`toolProfile: { tools: [] }`), four prompt parts (one
  protocol file + three inputs), no seed and no baked history.
- `prompts/protocol.md` — neutral operating protocol.
- `inputs/house_style.md` — default text for the `house_style` input.
- `README.md` — this human doc (not embedded in the prompt).

## Notes

- `briefing` and `directives` are launch-provided; `house_style` resolves from
  the default file unless overridden.
- The bundle declares no seed, no history, and no tool grants.
