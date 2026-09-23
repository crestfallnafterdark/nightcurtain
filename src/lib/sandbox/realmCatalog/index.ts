/**
 * @packageDocumentation
 * Realm Catalog — the code-owned Realm template schema, the baked demo
 * template, and the pure helpers that validate, version, materialize, and
 * summarize templates and payloads.
 *
 * Templates are frozen data authored in code or imported as canonical JSON:
 * they declare agent keys, literal id patterns, ordered prompt parts, baked
 * history, tool profiles, privilege flags, declared input requirements
 * (`text` or `files` shape), explicit consumption sites (prompt/history input
 * references, workspace placements, launch directives), and an optional
 * capability contract (`toolContract`/`providers`) — no model identifiers, no
 * credentials, no runtime instances, no provider implementations, and no
 * kernel policy content. A template becomes agents only through
 * `materializeTemplate()`, which normalizes the authored document, resolves
 * the literal id patterns and tool profiles, composes each agent's system
 * prompt and baked history from their declared parts (bundle files, supplied
 * payload inputs, inline text), resolves the declared placements and
 * directives, and returns a deterministic, deeply frozen launch plan for the
 * launch orchestration. `parseTemplateBundle()` / `serializeTemplateBundle()`
 * move bundles as canonical transport JSON and `templateBundleVersion()` pins
 * one bundle's authored-form content version; `validatePayload()` validates a
 * payload against the declared contract; `composeAgentHistory()` /
 * `composeSystemPrompt()` / `resolvePlacements()` / `resolveDirectives()`
 * expose the same pure resolution to preview surfaces; and
 * `summarizeAgentCapabilities()` projects the same resolved grants into the
 * per-agent preview consumed by the launcher UI. Legacy format-v1 documents
 * are read through the shim: `normalizeTemplate()`, the transport, version,
 * payload, and materialization helpers accept them at the authored boundary
 * and convert them to the canonical model, so pre-migration bundles keep
 * importing, launching, and validating while the module exposes one format.
 *
 * ### Responsibilities
 * - The canonical schema (`RealmTemplate`/`RealmAgentSpec`/`PromptPart`/inputs/placements/directives/history/`toolContract`/`providers`) and closed-shape validation.
 * - The baked `DEMO_TEMPLATE` fixture (privileged coordinator plus read-only worker).
 * - The baked template bundles — the demo fixture plus the embedded bundles generated from `templates/**` by `scripts/embed_realm_content.mjs` (`BAKED_TEMPLATE_BUNDLES` / `getBakedTemplateBundle`).
 * - Prompt and baked-history composition, input provenance, placement/directive resolution, and origin-free input resolution.
 * - Canonical transport parse/serialize and the per-bundle content version (self-contained SHA-256, synchronous), plus the public `hashText` content-hash helper for instance provenance.
 * - Payload validation and slot resolution (typed, fail-closed, version-mismatch policy), including legacy format-v1 hydration packages.
 * - Literal-id/override resolution, preset-resolved launch plans, and the provider-requirement launch gate helper.
 * - Per-agent capability summaries: grants, mutation classification, privilege.
 *
 * ### Non-responsibilities
 * No Realm records or membership (the realm registry owns those), no agent
 * launch or lifecycle calls, no filesystem/messaging/clock scoping (seeding
 * writes and directive delivery are orchestrated outside this module), no
 * model or credential resolution, no provider/MCP resolution or connection
 * (`toolContract`/`providers` are accepted and shape-validated only), no
 * persistence, no UI presentation, and no ambient I/O — bundle content is
 * embedded at generation time, never read at runtime.
 *
 * @module realmCatalog
 * @invariant INV-TOTALITY: Template validation is closed-shape and total: every declared input is referenced at least once across prompt parts, history parts, placements, and directives (an unreferenced input is a template error), every reference resolves to a declared input, input ids and agent keys are unique, `files`-shape references name exactly one file with `path` while `text`-shape references must not carry one, placement sources and destinations match the referenced input's shape (`path` for text/bundle/one-file sources, `root` for multi-file filesets), directive references are `text`-shape, targets name declared agent keys or `realm`, paths are safe and free of reserved property names, and duplicate static destinations (same target + path, or same target + root) are rejected.
 * @invariant INV-CONSUMPTION: Inputs are the only variable content and every consumption is explicit at its use site — `agents[].prompt[]`/`agents[].history[]` inject an input at the exact declared position (`text` value, or one selected file of a `files` input), `placements[]` write the resolved value or fileset into a workspace at launch, and `directives[]` deliver an operator-attributed mailbox message at launch; contributing pieces join with a blank line, an optional empty value contributes nothing (a `required` empty value fails closed), a `files` input is never injected wholesale, and the schema imposes no part-count or composed-size caps.
 * @invariant INV-PAYLOAD: A payload is self-contained and inline-only — it repeats no paths and no targets, contains no external file references, pins the authored template version, carries only declared input ids with shape-matched values (`{ text }` or a non-empty fileset of safe, unique `{ path, content }` entries), rejects unknown keys and shape mismatches, requires every `required` input to be present and non-empty, and treats a pinned-version mismatch as a typed error unless `allowVersionMismatch` is explicitly passed (then reported as a review warning); `payloadDigest` hashes the payload's canonical sorted-key bytes.
 * @invariant INV-SHIM: Legacy format-v1 documents are accepted through a read shim: templates validate against the frozen v1 schema and convert to the canonical model (seed slots become placements plus per-slot single-file `files` inputs with a `path` destination, `fixed` inline sources become `default` prefills, `generated` becomes `required`, the template-level hydration brief seeds per-input briefs, and the seed directive becomes a literal directive), and v1 hydration packages convert against the normalized template (input values must name declared `text` inputs; file entries match placements by path + target and must resolve a `files` input); the authored-form bundle version is preserved so pre-migration pins stay valid, and a converted template that violates totality fails closed rather than carrying dead content.
 * @invariant INV-VERSION: The bundle version is `sha256:<hex>` over the authored-form spec (canonical, or the v1 spec for a legacy bundle) re-serialized as UTF-8 JSON with recursively sorted keys and no insignificant whitespace, then each referenced bundle file (prompt/history `file` parts, input `defaultFile` prefills, placement `file` sources) in lexicographic path order framed as `<pathLength>:<path>\n<contentLength>:<content>` (UTF-8 byte counts); `parseTemplateBundle` returns both the normalized template and the canonical authored `serialized` text, so a persisted bundle round-trips to a deep-equal parse with the same version.
 * @invariant INV-FROZEN: Every baked template, parsed bundle, validated payload, and every plan, composed prompt, composed history, resolved placement/directive, or summary returned by the module's helpers is deeply frozen plain data; callers can never mutate module state through a returned reference.
 * @invariant INV-DETERMINISM: materializeTemplate, composeSystemPrompt, composeAgentHistory, resolvePlacements, resolveDirectives, templateBundleVersion, parseTemplateBundle, serializeTemplateBundle, and summarizeAgentCapabilities are pure: agent order is template order, part order is declared order, bundle files hash in lexicographic path order, no timestamps or randomness are introduced, and repeated calls with equal inputs return deep-equal results.
 * @invariant INV-FAIL-CLOSED: materializeTemplate validates the whole template before building any plan and rejects malformed or unknown fields, empty agent lists or prompt-part lists, duplicate keys, resolved ids, input ids, or requirement ids, empty or placeholder-bearing ids, reserved property names (`__proto__`/`constructor`/`prototype`) as identifiers or path segments, placeholder syntax (the retired `{realm}` token included), unknown presets, ambiguous or absent tool profiles, tool grants that are neither canonical tool names nor declared requirement ids, invalid optional fields, undeclared input references (prompts and history), missing bundle entries, required inputs that resolve empty, history entries that compose empty, placement targets that name unknown agent keys, unsafe placement paths, placement destination collisions, directive targets that name unknown agent keys, unknown id-override or input-value keys, and fileset selection mismatches.
 * @invariant INV-COMPOSITION: System prompts compose from parts in declared order — `file` and `text` parts contribute verbatim, a `text` input resolving empty contributes nothing (unless declared `required`, which fails closed), a `files` input reference selects exactly one file by `path`, contributing pieces join with a blank line, and per-referenced-input provenance records the id and value source (`launch`/`default`/`defaultFile`/`empty`) without duplicating value text.
 * @invariant INV-HISTORY: A spec's declared history composes through the same part model and separator as prompts (missing `file` entries fail closed, empty inputs contribute nothing, an entry that composes empty is rejected), composes with the same launch/default/defaultFile input precedence as prompts, lands in the launch plan in declared order, and carries `source: 'template'` host-side provenance; message ids and seeding belong to the runtime, and no model call is made for baked entries.
 * @invariant INV-BUNDLE-VERSION: templateBundleVersion is `sha256:<hex>` over the canonical byte stream — the authored spec re-serialized as UTF-8 JSON with recursively sorted keys and no insignificant whitespace, then each referenced bundle file (prompt/history `file` parts, input `defaultFile` prefills, placement `file` sources) in lexicographic path order, each framed as `<pathLength>:<path>\n<contentLength>:<content>` with UTF-8 byte lengths — computed by a self-contained synchronous SHA-256 with no dependencies, no `crypto.subtle`, and no ambient I/O; baked and JSON-imported bundles hash identically, legacy v1 pins stay reproducible, the same primitive backs the public `hashText` content-hash helper, and the pipeline's global `REALM_CONTENT_VERSION` keeps its own meaning (whole embedded payload freshness).
 * @invariant INV-BAKED-BUNDLES: The baked bundles (the demo fixture plus the generated embedded bundles) and every nested bundle file body are deeply frozen plain data; the generated content module is embedded at generation time by `scripts/embed_realm_content.mjs` and is never hand-edited, bundle files are the only source for prompt/history `file` parts, input `defaultFile` prefills, and placement `file` sources, and the module performs no runtime file reads or `?raw` imports.
 * @invariant INV-OPAQUE-IDS: Agent ids are realm-opaque and ordinary: `idPattern` values are literal ids (no placeholder is resolved), a per-key id override wins over the pattern, a resolved id is rejected only when it is empty or still carries a placeholder, and no id value is reserved or confers authority.
 * @invariant INV-RESOLVED-GRANTS: Plans and capability summaries carry tool grants resolved through the canonical tool-constants resolver; classification uses the canonical mutation vocabulary, the aggregate subagent-management selector expands to its canonical tools, and declared `toolContract` requirement ids surface in `grants` without a mutation classification (resolution of those requirements arrives with the providers integration).
 * @invariant INV-PRIVILEGE-HONEST: A privileged spec reports effective wildcard capability in its summary, matching the runtime authority derivation, so previews never understate what a launched agent can do.
 * @invariant INV-DECLARED-AUTHORITIES: `AgentSpec.authorities` declares publishing-grant requests as non-empty unique strings and is inert data — validation accepts identifiers unknown to the host (`KNOWN_AGENT_AUTHORITIES` lists the known set), `templateUnsupportedAuthorities()` reports declared-but-unknown ids for the launch gate to fail closed on, and materialization copies the declarations verbatim onto `RealmLaunchAgentPlan.authorities` (empty when none declared) without ever granting anything: approval and grant application belong exclusively to the launch seam.
 * @invariant INV-NO-MODEL-LITERALS: The catalog contains no model identifiers, endpoints, credentials, or provider implementations; model-preset ids pass through verbatim, tool selectors resolve through the canonical preset resolver, and `toolContract`/`providers` are requests that are accepted and shape-validated but never resolved or connected.
 * @decision Agent ids materialize as trimmed literal strings with no realm-derived prefix; the retired `{realm}` placeholder is rejected at validation with a clear message, per-key overrides win over patterns, and every resolved id is ordinary — the historically reserved `director` identity included, because ids confer no authority under the principal model
 * @decision A tool profile declares exactly one of a canonical preset name or an explicit tools list; presets resolve through the tool constants, explicit lists pass through in declared order, and the capability summary canonicalizes alias spellings before classification so the preview matches dispatcher authorization
 * @decision Unknown fields on templates, agent specs, tool profiles, inputs, prompt parts, placements, directives, history entries, tool contracts, and provider requests are rejected rather than dropped, because a misspelled privilege, capability, input, or placement field must fail closed instead of silently launching a weaker or differently configured agent
 * @decision A privileged spec implies wildcard capability in the summary (the runtime authority derivation appends the wildcard for privileged agents); wildcardSource reports whether the wildcard came from the declared profile or from privilege
 * @decision A system prompt is declared as ordered parts (bundle file, template input, inline text) instead of a single reference: composition joins contributing pieces with a blank line, empty inputs are omitted, required inputs fail closed, and the kernel ships no policy content — whether a template includes refusal, lore, or directive text is entirely the template author's decision
 * @decision Input values are launch-level (one value per declared input shared by every referencing agent); provenance records each referenced input's id and source (launch, default, defaultFile, empty) instead of duplicating value text, and an explicit empty launch value stays launch-sourced rather than silently falling back to a default
 * @decision Placements and directives resolve inside the catalog (bundle files resolved, missing entries failing closed) and carry template agent keys; the store's seed orchestration owns workspace writes, path normalization, and directive delivery
 * @decision Baked bundle content is embedded at generation time into `content.generated.ts` by `scripts/embed_realm_content.mjs` — a deterministic walk of `templates/<id>/template.json` inlining `prompts/**`, `inputs/**`, and `files/**` (UTF-8 text only, 256 KB per-file cap, fail-closed on malformed manifests, dangling references, oversized/binary files, and unsafe paths) with every manifest schema-validated through the real `normalizeTemplate` (canonical, or v1 through the read shim) and a sha256 `REALM_CONTENT_VERSION` over the canonical payload and a `--check` freshness mode; the catalog deep-freezes and exposes the generated bundles behind the demo fixture, and the store's default launch catalog is sourced from that accessor so the picker and the launch resolve one embedded source with no runtime file reads
 * @decision A bundle's content version is canonical and self-contained: the authored spec re-serialized as UTF-8 JSON with recursively sorted keys and no insignificant whitespace, then each referenced bundle file in lexicographic path order framed as `<pathLength>:<path>\n<contentLength>:<content>` (UTF-8 byte lengths), hashed by a pure synchronous SHA-256 with no platform crypto — so a baked bundle and the same bundle imported as JSON hash identically, and the version pins instance provenance independently of the pipeline's global `REALM_CONTENT_VERSION`
 * @decision Baked history composes through the prompt part model and is seeded without a model call: entries compose in declared order with a blank line, empty inputs contribute nothing, an entry that composes empty is rejected rather than seeded as an empty message, and composed messages carry `source: 'template'` for host-side provenance while message ids are generated at launch (INV-7)
 * @decision Payloads match declared inputs by id and shape: `text` values carry `{ text }`, `files` values carry a non-empty `{ files }` fileset, unknown/duplicate entries are rejected, every `required` input must be present and non-empty, and a pinned-version mismatch fails closed unless `allowVersionMismatch` is explicitly passed (then it is reported as a review warning) — review surfaces may pass the flag to obtain the warning, launch passes it only after user confirmation
 * @decision Template-declared identifiers that become object keys (input ids, agent keys, requirement ids) and bundle/placement path segments reject the reserved property names `__proto__`/`constructor`/`prototype`, and identifier/slot records use own-property or null-prototype reads and writes, so a hostile or malformed template can never swallow or misroute a value through the prototype chain
 * @decision A placement's static destinations are validated for duplicates (same target + path, or same target + root) at validation, because resolution is keyed by that pair and last-wins writes would make the written content depend on declaration order
 */

export { DEMO_TEMPLATE } from './demo.ts';
export { BAKED_TEMPLATE_BUNDLES, getBakedTemplateBundle } from './bundles.ts';
export { REALM_CONTENT_VERSION } from './content.generated.ts';
export { materializeTemplate } from './materialize.ts';
export {
  composeAgentHistory,
  composeSystemPrompt,
  resolveDirectives,
  resolvePlacements
} from './compose.ts';
export { summarizeAgentCapabilities } from './capabilities.ts';
export { parseTemplateBundle, serializeTemplateBundle } from './transport.ts';
export { templateBundleVersion } from './version.ts';
export { hashText } from './sha256.ts';
export { payloadDigest, validatePayload } from './hydration.ts';
export { normalizeTemplate } from './legacy.ts';
export {
  templateRequiresProviders,
  templateUnsupportedAuthorities,
  validateTemplate
} from './validation.ts';
export { AGENT_AUTHORITIES, KNOWN_AGENT_AUTHORITIES } from './types.ts';
export { REALM_CATALOG_ERROR_CODES, RealmCatalogError } from './errors.ts';
export type { RealmCatalogErrorCode } from './errors.ts';

export type {
  AgentCapabilitySummary,
  BakedTemplateBundle,
  BundleFiles,
  CapabilityWildcardSource,
  ParsedTemplateBundle,
  PendingInstancePayload,
  PromptPart,
  RealmAgentSpec,
  RealmAgentToolProfile,
  RealmComposedPrompt,
  RealmComposeOptions,
  RealmDirective,
  RealmHistoryEntry,
  RealmHistoryMessage,
  RealmInputProvenance,
  RealmInputValues,
  RealmInputValueSource,
  RealmInputValue,
  RealmLaunchAgentPlan,
  RealmLaunchPlan,
  RealmLaunchToolProfile,
  RealmMaterializeOptions,
  RealmPayload,
  RealmPayloadFile,
  RealmPayloadInputValue,
  RealmPayloadProvenance,
  RealmPlacement,
  RealmProvider,
  RealmProviderHttpTransport,
  RealmProviderMcp,
  RealmProviderPack,
  RealmProviderProvides,
  RealmProviderStdioTransport,
  RealmResolvedDirective,
  RealmResolvedPlacement,
  RealmTemplate,
  RealmTemplateInput,
  RealmToolContract,
  RealmToolRequirement,
  ResolvedPayload
} from './types.ts';
