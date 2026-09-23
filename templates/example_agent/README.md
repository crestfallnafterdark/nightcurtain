# example_agent — template bundle

**Status:** Shipped reference bundle · **Last verified:** 2026-09-22.

Minimal, story-free reference for the format-v2 template primitives, and the
fixture used by the realm pipeline and multi-instance suites.

## Layout

- `template.json` — one unprivileged `assistant` agent with the explicit
  zero-tool profile (`toolProfile: { tools: [] }`), four prompt parts (one
  protocol file + three text inputs), no placements and no baked history.
- `prompts/protocol.md` — neutral operating protocol.
- `inputs/house_style.md` — default text for the `house_style` input.
- `README.md` — this human doc (not embedded in the prompt).

## Notes

- `briefing` is launch-provided; `directives` falls back to its declared
  default, and `house_style` resolves from the default file unless overridden.
- The bundle declares no placements, no history, and no tool grants.
