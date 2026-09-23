/**
 * Legacy format-v1 read shim for the `realmCatalog` module.
 *
 * `normalizeTemplate()` is the single entry point that turns an authored
 * template of either format into the format-v2 internal model: a
 * `formatVersion: 1` template is validated against the frozen v1 schema and
 * converted (its `seed` manifest becomes placements and directives, its input
 * origins collapse into `required`, and the template-level hydration brief
 * seeds per-input briefs), while a `formatVersion: 2` template is validated
 * directly. The shim exists for one migration cycle (decision `2ba3008`); the
 * shipped in-tree templates migrate to v2 and only externally authored v1
 * documents flow through this path.
 *
 * The shim preserves v1 semantics exactly:
 *
 * - `inputs[]` values stay `text`-shape with their ids, labels, help, briefs,
 *   and prefills; `generated` inputs become `required` (their brief is
 *   mandatory in v1, and a package without them could not compose).
 * - `seed.files[]` `fixed` slots become placements — a `{ file }` placement
 *   for `source.file`, or a `text` input with the inline body as its `default`
 *   plus a `{ inputId, path }` placement for `source.inline`.
 * - `seed.files[]` `user`/`generated` slots become one single-file `files`
 *   input each (id `seed_<index>`, label = the slot path, `required` for
 *   `generated`) with a `{ inputId, path }` placement, so a v1 package entry
 *   matching slot path + target converts back to that input's fileset.
 * - `seed.directive` becomes a literal `text` directive.
 * - The template-level `hydration.brief`, when present, is copied onto every
 *   converted input that declares no brief of its own.
 *
 * The converted template is validated with the v2 rules (closed shape,
 * resolver rules, totality), so a legacy template that declares an input no
 * surface consumes fails closed with the v2 totality message instead of
 * silently carrying dead content.
 */

import { isPlainRecord, validateTemplate, validateTemplateV1 } from './validation.ts';
import type {
  RealmDirective,
  RealmPlacement,
  RealmTemplateV1,
  RealmTemplateInput,
  RealmTemplate
} from './types.ts';

/**
 * Normalizes an authored template of either schema format into the canonical
 * internal model.
 *
 * `formatVersion: 1` documents go through the read shim (validated v1, then
 * converted and validated canonical); `formatVersion: 2` documents validate
 * directly. Any other format version fails closed.
 *
 * @param candidate - Candidate template (any value)
 * @returns The validated canonical template
 * @throws `Error` - When the template is not an object, declares an unsupported format version, or fails its schema validation
 *
 * @example
 * ```typescript
 * import { normalizeTemplate } from './realmCatalog/index.ts';
 *
 * const template = normalizeTemplate(DEMO_TEMPLATE); // v1 demo → v2 model
 * template.formatVersion; // 2
 * ```
 */
export function normalizeTemplate(candidate: unknown): RealmTemplate {
  if (!isPlainRecord(candidate)) {
    throw new Error('template must be an object');
  }
  if (candidate.formatVersion === 1) {
    return validateTemplate(shimTemplateV1ToV2(validateTemplateV1(candidate)));
  }
  if (candidate.formatVersion === 2) {
    return validateTemplate(candidate);
  }
  throw new Error(`template formatVersion must be 1 or 2 (got '${String(candidate.formatVersion)}')`);
}

/**
 * Converts a validated format-v1 template into the format-v2 model.
 *
 * The conversion is structural and total over the v1 schema: it never drops
 * declared content. A generated `seed_<index>` id that collides with a
 * declared input id fails closed instead of silently shadowing one side.
 *
 * @param v1 - Validated format-v1 template
 * @returns The converted format-v2 template (not yet v2-validated)
 * @throws `Error` - When a shim-generated input id collides with a declared input id
 */
export function shimTemplateV1ToV2(v1: RealmTemplateV1): RealmTemplate {
  const hydrationBrief = v1.hydration?.brief;
  const inputs: RealmTemplateInput[] = [];
  const inputIds: Set<string> = new Set();

  const addInput = (input: RealmTemplateInput, originLabel: string): void => {
    if (inputIds.has(input.id)) {
      throw new Error(
        `legacy template ${originLabel} collides with input id '${input.id}' — `
        + 'rename one side before importing the format-v1 bundle'
      );
    }
    inputIds.add(input.id);
    inputs.push(input);
  };

  for (const input of v1.inputs ?? []) {
    const isGenerated = input.origin === 'generated';
    addInput(
      {
        id: input.id,
        label: input.label,
        shape: 'text',
        ...(input.help !== undefined ? { help: input.help } : {}),
        ...(input.brief !== undefined
          ? { brief: input.brief }
          : hydrationBrief !== undefined
            ? { brief: hydrationBrief }
            : {}),
        ...(isGenerated
          ? { required: true }
          : input.required !== undefined
            ? { required: input.required }
            : {}),
        ...(input.default !== undefined ? { default: input.default } : {}),
        ...(input.defaultFile !== undefined ? { defaultFile: input.defaultFile } : {}),
        ...(input.multiline !== undefined ? { multiline: input.multiline } : {})
      },
      `input '${input.id}'`
    );
  }

  const placements: RealmPlacement[] = [];
  const directives: RealmDirective[] = [];

  (v1.seed?.files ?? []).forEach((slot, index) => {
    const origin = slot.origin ?? 'fixed';
    const shimmedId = `seed_${index}`;
    if (origin === 'fixed') {
      const source = slot.source;
      if (source === undefined) {
        // Structurally impossible after v1 validation; kept fail-closed.
        throw new Error(`legacy seed slot '${slot.path}' (files[${index}]) declares no source`);
      }
      if ('file' in source) {
        placements.push({ file: source.file, target: slot.target, path: slot.path });
        return;
      }
      addInput(
        { id: shimmedId, label: slot.path, shape: 'text', default: source.inline },
        `seed slot '${slot.path}'`
      );
      placements.push({ inputId: shimmedId, target: slot.target, path: slot.path });
      return;
    }
    addInput(
      {
        id: shimmedId,
        label: slot.path,
        shape: 'files',
        ...(slot.brief !== undefined
          ? { brief: slot.brief }
          : hydrationBrief !== undefined
            ? { brief: hydrationBrief }
            : {}),
        ...(origin === 'generated' ? { required: true } : {})
      },
      `seed slot '${slot.path}'`
    );
    placements.push({ inputId: shimmedId, target: slot.target, path: slot.path });
  });

  if (v1.seed?.directive !== undefined) {
    directives.push({
      text: v1.seed.directive.text,
      target: { agent: v1.seed.directive.targetAgentKey }
    });
  }

  return {
    formatVersion: 2,
    id: v1.id,
    name: v1.name,
    description: v1.description,
    ...(v1.notes !== undefined ? { notes: v1.notes } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    agents: v1.agents,
    ...(placements.length > 0 ? { placements } : {}),
    ...(directives.length > 0 ? { directives } : {}),
    ...(v1.toolContract !== undefined ? { toolContract: v1.toolContract } : {}),
    ...(v1.providers !== undefined ? { providers: v1.providers } : {})
  };
}
