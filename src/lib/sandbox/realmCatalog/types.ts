/**
 * Plain types for the `realmCatalog` module: the frozen Realm template schema
 * (prompt parts, declared inputs, agent specs, and the seed manifest), the
 * materialized launch plan (composed prompts, input provenance, resolved
 * seed), and the capability-summary display model.
 */

import type { ToolPresetName } from '../tools/constants/index.ts';
import type { TriggerPolicy } from '../runtime/agent/index.ts';

/**
 * Tool-profile selector block declared by a template agent spec.
 *
 * A profile declares exactly one selector: a canonical preset name (`preset`)
 * or an explicit tool-name list (`tools`). Materialization resolves both
 * through the canonical preset resolver, so plans never carry unresolved
 * profile selectors.
 */
export interface RealmAgentToolProfile {
  /** Canonical capability preset name (for example `manager` or `readonly`). */
  preset?: ToolPresetName;
  /** Explicit tool names, resolved through the canonical preset resolver. */
  tools?: readonly string[];
}

/**
 * One system-prompt part declared by a template agent spec.
 *
 * A part is one of three primitives: a bundle prompt file (`file`), a
 * template-declared input (`input`), or inline text (`text`). Composition
 * inserts parts in declared order; an empty input contributes nothing. The
 * optional `path` file selector is the format-v2 extension: a reference to a
 * `files`-shape input must name exactly one file of the fileset (`path`
 * required), and a reference to a `text`-shape input must not carry one
 * (format-v1 validation rejects the field entirely).
 */
export type PromptPart =
  | { kind: 'file'; path: string }
  | { kind: 'input'; inputId: string; path?: string }
  | { kind: 'text'; text: string };

/**
 * One template-declared editable input.
 *
 * Inputs are launch-level: one value per input is used wherever any agent
 * references it. `default` and `defaultFile` are mutually exclusive prefills
 * (declaring both is rejected); a `required` input fails composition while it
 * resolves empty. The kernel attaches no meaning to the text — an input may
 * carry directives, lore, policy notes, or nothing at all.
 */
export interface RealmTemplateInputV1 {
  /** Stable per-template input id (unique within the template; referenced by `input` parts). */
  id: string;
  /** Human-readable field label. */
  label: string;
  /** Author commentary (provider notes, provenance, usage) shown with the field. */
  help?: string;
  /**
   * Where the value comes from: `user` (operator-provided, the default) or
   * `generated` (produced by a hydrator).
   */
  origin?: 'user' | 'generated';
  /** Hydration instruction; required for `generated` inputs, ignored otherwise. */
  brief?: string;
  /** Prefilled text (`user` origin only); absent or empty starts empty. */
  default?: string;
  /** Alternative prefill resolved from a bundle file (`user` origin only); mutually exclusive with `default`. */
  defaultFile?: string;
  /** Whether composition fails closed while the resolved value is empty. */
  required?: boolean;
  /** UI hint: render as a multiline field (default true). */
  multiline?: boolean;
}

/**
 * One baked history entry declared by a template agent spec.
 *
 * History entries are seeded at launch with no model call (INV-7 message ids
 * are generated then): `role` attributes the entry to the operator (`user`) or
 * the agent itself (`assistant`), and `content` uses the same ordered part
 * model as prompts, so an opener may be fixed, user-provided, or generated.
 */
export interface RealmHistoryEntry {
  /** Message attribution: the operator or the agent itself. */
  role: 'user' | 'assistant';
  /** Ordered content parts (non-empty; same model as prompt parts). */
  content: readonly PromptPart[];
}

/**
 * One composed history message carried by a launch plan and passed to the
 * runtime's trusted history launch option.
 *
 * `content` is the composed text (parts in declared order joined with a blank
 * line), and `source: 'template'` marks the entry as declared by the template
 * (host-side metadata; never model output).
 */
export interface RealmHistoryMessage {
  /** Message attribution copied from the declared entry. */
  role: 'user' | 'assistant';
  /** Composed content (never empty; an entry that composes empty is rejected). */
  content: string;
  /** Host-side provenance marker for template-declared history. */
  source?: 'template';
}

/**
 * One agent role declared by a Realm template.
 *
 * Specs are code-owned frozen data: `key` is the stable per-template agent
 * identity used by overrides and summaries, `idPattern` is the literal agent
 * id template (plain and realm-opaque — the retired `{realm}` placeholder is
 * rejected at validation), and `prompt` declares the system prompt as an
 * ordered list of parts composed at materialization. `history` declares an
 * optional baked prologue seeded at launch without a model call. No spec field
 * carries a model identifier, endpoint, or credential.
 */
export interface RealmAgentSpec {
  /** Stable per-template agent key (unique within the template, never an agent id). */
  key: string;
  /** Literal agent id pattern; placeholder syntax (including the retired `{realm}`) is rejected. */
  idPattern: string;
  /** Human-readable display name. */
  name: string;
  /** Role description or archetype. */
  role: string;
  /** Ordered system-prompt parts (non-empty, at most 64 parts). */
  prompt: readonly PromptPart[];
  /** Declared tool profile (exactly one of `preset` or `tools`). */
  toolProfile: RealmAgentToolProfile;
  /** Whether the launched agent receives elevated privilege. */
  privileged: boolean;
  /**
   * Declared publishing-grant requests (Wave U, lane U-P).
   *
   * The declaration is inert data: no engine path grants from template content.
   * The mandatory launch review surfaces each request per agent, and only
   * explicitly approved requests are applied, as ordinary revocable operator
   * grants; absent approval the agent simply lacks the authority, and approvals
   * for undeclared authorities are rejected. Shape: an array of non-empty
   * unique strings. Validation accepts any identifier; identifiers unknown to
   * the host fail closed at launch (`ERR_TEMPLATE_AUTHORITY_UNSUPPORTED`),
   * mirroring `providers`. `KNOWN_AGENT_AUTHORITIES` lists the v1 known set.
   */
  authorities?: readonly string[];
  /** Optional baked history entries seeded at launch (in declared order; no model call). */
  history?: readonly RealmHistoryEntry[];
  /** Optional legacy trigger-policy label stored verbatim by the runtime. */
  triggerPolicy?: TriggerPolicy;
  /** Optional model-preset id passed through to the launch config verbatim. */
  modelPresetId?: string;
  /** Optional initial prompt triggering an immediate first turn. */
  initialPrompt?: string;
}

/**
 * One template-declared seed file slot: destination, target, origin, and
 * origin-dependent content source.
 *
 * `path` is a workspace-relative destination (traversal and null bytes are
 * rejected), `target` names the Realm-global workspace or one template agent
 * key, and `origin` declares where the content comes from: `fixed` (shipped in
 * the bundle; `source` required), `user` (attached at launch; `source`
 * forbidden, absent slot skipped), or `generated` (filled from the hydration
 * package; `source` forbidden, missing slot fails closed). The store's own
 * seed payload type is `RealmSeedFile` (`{ path, content }`), the resolved
 * write shape this declaration materializes into.
 */
export interface RealmTemplateSeedFileV1 {
  /** Destination path (workspace-relative; traversal rejected). */
  path: string;
  /** Destination workspace: the Realm-global partition or one member's private workspace. */
  target: 'realm' | { agent: string };
  /** Content origin (defaults to `fixed` when `source` is present). */
  origin?: 'fixed' | 'user' | 'generated';
  /** Hydration instruction: required for `generated`, optional for `user`, ignored for `fixed`. */
  brief?: string;
  /** Content source; required for `fixed` slots and forbidden for `user`/`generated` slots. */
  source?: { file: string } | { inline: string };
}

/**
 * Seed manifest declared by a template: files to write at launch plus an
 * optional first directive delivered to one member.
 *
 * A directive is delivered together with its target's files (one operator
 * seed call per target), so the manifest must declare at least one file for
 * the directive's target agent; a directive-only manifest is rejected at
 * validation rather than inventing a second delivery path.
 */
export interface RealmSeedManifestV1 {
  /** Files to seed, in declared order. */
  files?: readonly RealmTemplateSeedFileV1[];
  /** Optional first directive delivered to the named template agent key. */
  directive?: { targetAgentKey: string; text: string };
}

/**
 * Hydration declaration: the overall instruction a hydrator reads when
 * producing a package for this template.
 */
export interface RealmHydrationDeclarationV1 {
  /** Non-empty hydration brief. */
  brief: string;
}

/**
 * One capability the template requires from the host (format v1 §3.9).
 *
 * Requirements are requests, never implementations: the capability id is
 * namespaced (`text.similarity`, `acme.scoring.similarity`), `io` records the
 * minimal signature, and `range`/`prefer` are resolution hints. The
 * model-facing call name is derived from the id (`text.similarity` →
 * `text_similarity`) and is stable across implementations. Requirements are
 * accepted and shape-validated in this wave; resolution arrives with the
 * providers wave.
 */
export interface RealmToolRequirement {
  /** Capability id (namespaced; referenced by `toolProfile.tools` and provider `provides`). */
  id: string;
  /** Human/agent-readable description of the capability. */
  brief: string;
  /** Minimal signature: parameter/result names mapped to type labels. */
  io: {
    /** Input names → type labels. */
    in: Readonly<Record<string, string>>;
    /** Output names → type labels. */
    out: Readonly<Record<string, string>>;
  };
  /** Whether a missing implementation blocks launch (default `true`). */
  required?: boolean;
  /** Semver range of acceptable implementations. */
  range?: string;
  /** Preferred provider ids (hints, never bindings). */
  prefer?: readonly string[];
}

/**
 * The template's capability contract: the requirements it asks the host to
 * satisfy. Accepted and shape-validated in this wave, never resolved here.
 */
export interface RealmToolContract {
  /** Declared capability requirements. */
  requirements?: readonly RealmToolRequirement[];
}

/**
 * A host-installed tool pack requested by the template.
 */
export interface RealmProviderPack {
  /** Provider kind discriminator. */
  kind: 'pack';
  /** `publisher/name` identity. */
  id: string;
  /** Semver range of acceptable pack versions. */
  range?: string;
  /** Where the pack can be obtained (install hint). */
  source?: string;
}

/**
 * One capability → provider surface mapping of an MCP provider.
 */
export interface RealmProviderProvides {
  /** Capability id this surface provides. */
  capability: string;
  /** Publisher-side tool name of the surface. */
  tool?: string;
}

/**
 * HTTP transport of an MCP provider.
 */
export interface RealmProviderHttpTransport {
  /** Transport discriminator. */
  kind: 'http';
  /** Server URL. */
  url: string;
}

/**
 * Stdio transport of an MCP provider.
 */
export interface RealmProviderStdioTransport {
  /** Transport discriminator. */
  kind: 'stdio';
  /** Executable to run. */
  command: string;
  /** Command arguments. */
  args?: readonly string[];
}

/**
 * An MCP server requested by the template.
 */
export interface RealmProviderMcp {
  /** Provider kind discriminator. */
  kind: 'mcp';
  /** Server id. */
  id: string;
  /** Exactly one transport (http or stdio). */
  transport: RealmProviderHttpTransport | RealmProviderStdioTransport;
  /** Capability → surface mappings. */
  provides?: readonly RealmProviderProvides[];
  /** Credential vault key *name* (never a secret). */
  authRef?: string;
}

/**
 * A provider request: a host-installed tool pack or an MCP server.
 *
 * Providers are requests; templates never ship or auto-load executable code
 * and never carry credentials (`authRef` names a vault entry). Accepted and
 * shape-validated in this wave, never connected or resolved here.
 */
export type RealmProvider = RealmProviderPack | RealmProviderMcp;

/**
 * The frozen format-v1 document schema (legacy read-shim input).
 *
 * Not part of the public surface: `normalizeTemplate()` validates format-v1
 * documents against this schema and converts them to the canonical
 * {@link RealmTemplate} model. The catalog's transport, version, payload, and
 * materialization helpers accept such documents at their authored boundary, so
 * pre-migration bundles keep importing, launching, and validating.
 */
export interface RealmTemplateV1 {
  /** Stable template id. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Operator-facing description (may be empty). */
  description: string;
  /** Free-text author comments shown in the launcher. */
  notes?: string;
  /** Schema format version; only `1` is accepted. */
  formatVersion: 1;
  /** Overall hydrator instruction. */
  hydration?: RealmHydrationDeclarationV1;
  /** Declared template inputs referenced by `input` parts. */
  inputs?: readonly RealmTemplateInputV1[];
  /** Declared agent specs, in launch order; never empty. */
  agents: RealmAgentSpec[];
  /** Optional seed manifest resolved by materialization. */
  seed?: RealmSeedManifestV1;
  /** Optional capability requirements (shape-validated; never resolved in this wave). */
  toolContract?: RealmToolContract;
  /** Optional provider requests (shape-validated; never resolved in this wave). */
  providers?: readonly RealmProvider[];
}

/**
 * One baked Realm template bundle: a frozen template plus the bundle file
 * bodies its `file` prompt/history parts, input `defaultFile` prefills, and
 * placement `file` sources resolve against.
 *
 * Bundle files are the only source for those references — the catalog performs
 * no runtime file reads, and the generated module is embedded at build time by
 * `scripts/embed_realm_content.mjs`. The shape is structurally identical to the
 * sandbox store's launch-seam bundle (`RealmTemplateBundle`), so the store can
 * consume the baked bundles directly while the two modules keep distinct names.
 */
export interface BakedTemplateBundle {
  /** Template the bundle launches. */
  readonly template: RealmTemplate;
  /** Bundle file bodies keyed by bundle-relative path (`prompts/**`, `inputs/**`, `files/**`). */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Resolved tool profile carried by a materialized agent plan.
 *
 * `preset` reports the declared preset name (or `null` for explicit lists) and
 * `tools` carries the resolved grants exactly as the runtime allowlist will
 * receive them.
 */
export interface RealmLaunchToolProfile {
  /** Declared preset name, or `null` when the spec declared an explicit list. */
  preset: ToolPresetName | null;
  /** Resolved grants, in declared order. */
  tools: readonly string[];
}

/**
 * Source that supplied one referenced input's value during composition.
 *
 * `launch` is an explicit launch value (empty counts as launch-supplied),
 * `default`/`defaultFile` are the declared prefill, and `empty` means the
 * input declared no value at all.
 */
export type RealmInputValueSource = 'launch' | 'default' | 'defaultFile' | 'empty';

/**
 * Provenance of one referenced template input: the declared id plus the source
 * of the resolved value. The value text itself is never duplicated.
 */
export interface RealmInputProvenance {
  /** Declared input id. */
  inputId: string;
  /** Where the composed value came from. */
  source: RealmInputValueSource;
}

/**
 * Composed system prompt for one agent plus the provenance of every input it
 * referenced.
 */
export interface RealmComposedPrompt {
  /** Contributing parts in declared order joined with a blank line; empty inputs omitted. */
  systemPrompt: string;
  /** One entry per referenced input, in first-reference order. */
  inputProvenance: readonly RealmInputProvenance[];
}

/**
 * Bundle file bodies keyed by bundle-relative path (or hydration file content
 * keyed by slot path when a caller composes history against hydrated content).
 */
export type BundleFiles = Readonly<Record<string, string>>;

/**
 * One fully resolved agent plan produced by `materializeTemplate()`.
 *
 * The record is deeply frozen and closed-shape: it carries only the fields
 * declared by the source spec, with the agent id resolved, the tool profile
 * resolved, and the system prompt composed from the declared parts. Absent
 * optional spec fields stay absent.
 */
export interface RealmLaunchAgentPlan {
  /** Stable per-template agent key from the source spec. */
  key: string;
  /** Resolved literal agent id (realm-opaque; override applied). */
  agentId: string;
  /** Human-readable display name. */
  name: string;
  /** Role description or archetype. */
  role: string;
  /** Composed system prompt (parts in declared order; empty inputs omitted). */
  systemPrompt: string;
  /** One entry per referenced input, in first-reference order; text never duplicated. */
  inputProvenance: readonly RealmInputProvenance[];
  /** Composed baked history messages, in declared order (empty when none declared). */
  history: readonly RealmHistoryMessage[];
  /** Resolved tool profile. */
  toolProfile: RealmLaunchToolProfile;
  /** Whether the agent launches with elevated privilege. */
  privileged: boolean;
  /**
   * Declared publishing-grant requests copied from the spec, in declared
   * order (empty when the spec declares none). Declarations are inert: the
   * launch seam owns per-agent approval, and only approved requests are
   * applied as operator grants.
   */
  authorities: readonly string[];
  /** Trigger-policy label copied from the spec when declared. */
  triggerPolicy?: TriggerPolicy;
  /** Model-preset id copied from the spec when declared. */
  modelPresetId?: string;
  /** Initial prompt copied from the spec when declared. */
  initialPrompt?: string;
}

/**
 * Publishing-authority ids a template agent spec may declare (Wave U, lane
 * U-P). `authorities` declares grant *requests*; the mandatory launch review is
 * the approval act, and approval applies ordinary revocable operator grants.
 * The ids are explicit-grant-only capabilities: the wildcard `'*'` and
 * `privileged` never imply them.
 */
export const AGENT_AUTHORITIES: Readonly<{
  /** Import realm template bundles. */
  readonly TEMPLATE: '@template:authority';
  /** Submit hydration packages. */
  readonly HYDRATION: '@hydration:authority';
}> = Object.freeze({
  TEMPLATE: '@template:authority',
  HYDRATION: '@hydration:authority'
} as const);

/**
 * Frozen vocabulary of the known publishing-authority ids (`@template:authority`
 * and `@hydration:authority`).
 *
 * Validation accepts any non-empty unique identifier in
 * `AgentSpec.authorities`; identifiers outside this set are declared-but-unknown
 * and fail launch closed (`ERR_TEMPLATE_AUTHORITY_UNSUPPORTED`) while import,
 * parse, and review stay valid — the providers precedent.
 */
export const KNOWN_AGENT_AUTHORITIES: readonly string[] = Object.freeze([
  AGENT_AUTHORITIES.TEMPLATE,
  AGENT_AUTHORITIES.HYDRATION
]);

/**
 * One session-only pending instance payload (candidate hydration package)
 * produced by `submit_hydration_package` and attached at launch only.
 *
 * The payload is the canonical inline hydration package the submitting tool
 * validated against the effective template; candidates are session-only and
 * never persisted, and the Wave T launch attach path (`{ package }`) stays the
 * only attach mechanism.
 */
export interface PendingInstancePayload {
  /** Template id the package targets. */
  readonly templateId: string;
  /** Effective template version the package was validated against (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Canonical inline hydration package. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** ISO-8601 timestamp of the resolution that produced the candidate. */
  readonly resolvedAt: string;
}

/**
 * Runtime vocabulary of wildcard-capability origins. `CapabilityWildcardSource`
 * is its compile-time mirror; the two are proven exact mirrors below.
 */
export const CAPABILITY_WILDCARD_SOURCES = Object.freeze({
  /** The declared profile grants the wildcard `'*'`. */
  PROFILE: 'profile',
  /** The privilege flag escalates the effective grants to wildcard. */
  PRIVILEGED: 'privileged',
  /** No wildcard capability. */
  NONE: 'none'
} as const);

/**
 * Origin of the effective wildcard capability reported by
 * `summarizeAgentCapabilitiesV1()`: the declared profile, the privilege flag, or
 * neither.
 */
export type CapabilityWildcardSource = 'profile' | 'privileged' | 'none';

/**
 * Compile-time proof that `CapabilityWildcardSource` mirrors
 * `CAPABILITY_WILDCARD_SOURCES` in both directions; a drifted vocabulary or
 * union makes the assertion alias fail its constraint.
 */
type _CapabilityWildcardSourceValues =
  (typeof CAPABILITY_WILDCARD_SOURCES)[keyof typeof CAPABILITY_WILDCARD_SOURCES];

type _CapabilityWildcardSourcesInSync = [CapabilityWildcardSource] extends [_CapabilityWildcardSourceValues]
  ? [_CapabilityWildcardSourceValues] extends [CapabilityWildcardSource]
    ? true
    : false
  : false;

type _AssertTrue<T extends true> = T;

type _CapabilityWildcardSourcesSyncCheck = _AssertTrue<_CapabilityWildcardSourcesInSync>;

/**
 * Honest per-agent capability preview produced by
 * `summarizeAgentCapabilitiesV1()`.
 *
 * `grants` is the effective canonical grant list after alias canonicalization
 * and aggregate expansion (wildcard reported as `['*']`); `mutating` and
 * `readOnly` partition the canonical grants against the canonical mutation
 * vocabulary, and `unrecognized` names every declared grant that maps to no
 * canonical tool. A privileged spec reports effective wildcard capability
 * regardless of its declared profile, matching the runtime authority
 * derivation, with `wildcardSource` naming the reason.
 */
export interface AgentCapabilitySummary {
  /** Stable per-template agent key from the source spec. */
  key: string;
  /** Declared literal id pattern (unresolved; no realm id is bound at preview time). */
  idPattern: string;
  /** Human-readable display name. */
  name: string;
  /** Role description or archetype. */
  role: string;
  /** Declared privilege flag. */
  privileged: boolean;
  /** Declared preset name, or `null` when the spec declared an explicit list. */
  preset: ToolPresetName | null;
  /** Effective canonical grants; `['*']` under wildcard capability. */
  grants: readonly string[];
  /** Whether the effective grants include the wildcard `'*'`. */
  wildcard: boolean;
  /** Origin of wildcard capability when present. */
  wildcardSource: CapabilityWildcardSource;
  /** Whether the effective grants include the subagent-management tool set. */
  subagentManagement: boolean;
  /** Mutating canonical tools in the effective grants. */
  mutating: readonly string[];
  /** Read-only canonical tools in the effective grants. */
  readOnly: readonly string[];
  /** Declared grants that map to no canonical tool; empty under wildcard. */
  unrecognized: readonly string[];
}

/* ------------------------------------------------------------------------- *
 * Format v2 (decision ticket 2ba3008)
 *
 * The format-v2 model makes inputs the only variable content and every
 * consumption explicit at its use site: `agents[].prompt[]` and
 * `agents[].history[]` inject inputs at an exact position, `placements[]`
 * write inputs or bundle files into workspaces, and `directives[]` deliver an
 * operator-attributed mailbox message. `origin` is removed; requiredness is
 * the per-input `required` flag, and the hash scope follows the
 * template/payload split. The agent-spec, tool-profile, tool-contract,
 * provider, history-message, launch-agent-plan, and capability-summary types
 * are shared with format v1 because their shape is unchanged.
 * ------------------------------------------------------------------------- */

/**
 * One template-declared editable input in format v2.
 *
 * Inputs are the only variable content: one value per input is used wherever
 * any agent, placement, or directive references it. `shape` selects the value
 * domain — `text` is one UTF-8 string, `files` is an ordered fileset
 * (`{ path, content }` entries; filesets only, no archives or base64). A
 * `files` input is never injected wholesale: a prompt/history reference names
 * one file (`path`), and a placement writes the fileset to a workspace
 * (`root`) or, when the fileset holds exactly one file, to an exact `path`.
 * `default`/`defaultFile` are text-only prefills and mutually exclusive; a
 * `required` input fails closed while it resolves empty. `label`, `help`, and
 * `multiline` are review/UI metadata.
 */
export interface RealmTemplateInput {
  /** Stable per-template input id (unique within the template; referenced by parts, placements, and directives). */
  id: string;
  /** Human-readable field label. */
  label: string;
  /** Value domain: one text string or an ordered fileset. */
  shape: 'text' | 'files';
  /** Author commentary (provider notes, provenance, usage) shown with the field. */
  help?: string;
  /** Production instruction for whoever fills the input (hydrator or operator). */
  brief?: string;
  /** Whether composition and placement fail closed while the input resolves empty (default `false`). */
  required?: boolean;
  /** Prefilled text (`text` shape only); absent or empty starts empty. */
  default?: string;
  /** Alternative prefill resolved from a bundle file (`text` shape only); mutually exclusive with `default`. */
  defaultFile?: string;
  /** UI hint: render as a multiline field (`text` shape only; default true). */
  multiline?: boolean;
}

/**
 * One format-v2 placement: a declared destination for an input's value or a
 * bundle file.
 *
 * A placement names exactly one source (`inputId` or `file`), one target (the
 * Realm-global workspace or one template agent key), and exactly one
 * destination: `path` writes a single value verbatim (a `text` input's value,
 * a bundle file's body, or the single file of a one-file fileset), while
 * `root` writes every file of a `files` input under the root prefix
 * (`root + file.path`). Destinations live only in the template; a payload
 * repeats no paths and no targets.
 */
export interface RealmPlacement {
  /** Source: a declared template input. */
  inputId?: string;
  /** Source: a bundle file body. */
  file?: string;
  /** Destination workspace: the Realm-global partition or one member's private workspace. */
  target: 'realm' | { agent: string };
  /** Exact destination path (single-value sources and one-file filesets). */
  path?: string;
  /** Directory prefix for every file of a `files` input. */
  root?: string;
}

/**
 * One format-v2 directive: an operator-attributed mailbox message delivered at
 * launch.
 *
 * A directive names exactly one message source (`inputId` naming a `text`
 * input, or literal `text`) and exactly one target agent key. An optional
 * input that resolves empty delivers nothing.
 */
export interface RealmDirective {
  /** Message source: a declared `text` input. */
  inputId?: string;
  /** Message source: literal text. */
  text?: string;
  /** Destination: one template agent key. */
  target: { agent: string };
}

/**
 * A code-owned Realm template in format v2.
 *
 * Templates are frozen data: they declare the schema format version, input
 * requirements, agent roles with ordered prompt parts and baked history,
 * placements, directives, and the optional capability contract. Domain content
 * lives in bundle files referenced by prompt parts, placement `file` sources,
 * and input `defaultFile` prefills; the kernel ships no policy content and no
 * provider implementations. Validation is closed-shape and total: every
 * declared input must be referenced at least once and every reference must
 * resolve.
 */
export interface RealmTemplate {
  /** Stable template id. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Operator-facing description (may be empty). */
  description: string;
  /** Free-text author comments shown in the launcher. */
  notes?: string;
  /** Schema format version; only `2` is accepted by the v2 surface. */
  formatVersion: 2;
  /** Declared input requirements referenced by parts, placements, and directives. */
  inputs?: readonly RealmTemplateInput[];
  /** Declared agent specs, in launch order; never empty. */
  agents: RealmAgentSpec[];
  /** Declared workspace placements, in write order. */
  placements?: readonly RealmPlacement[];
  /** Declared launch directives, in delivery order. */
  directives?: readonly RealmDirective[];
  /** Optional capability requirements (shape-validated; never resolved in this wave). */
  toolContract?: RealmToolContract;
  /** Optional provider requests (shape-validated; never resolved in this wave). */
  providers?: readonly RealmProvider[];
}

/**
 * One file of a format-v2 payload fileset.
 */
export interface RealmPayloadFile {
  /** Fileset-relative path (safe; unique within the fileset). */
  path: string;
  /** File content (UTF-8 text; may be empty). */
  content: string;
}

/**
 * One authored format-v2 payload input value: `{ text }` for a `text` input,
 * `{ files }` for a `files` input (closed shape; exactly one member).
 */
export type RealmPayloadInputValue =
  | { text: string }
  | { files: readonly RealmPayloadFile[] };

/**
 * Optional payload provenance block (all fields optional non-empty strings;
 * never secrets).
 */
export interface RealmPayloadProvenance {
  /** Who produced the payload (hydrator, operator, or tool name). */
  producer?: string;
  /** ISO-8601 production timestamp. */
  generatedAt?: string;
  /** Producing model identifier, when one was used. */
  model?: string;
  /** Who reviewed the payload, when reviewed. */
  reviewedBy?: string;
}

/**
 * A format-v2 payload: the structured input values for one template.
 *
 * The payload is self-contained and inline-only: it repeats no paths and no
 * targets (destinations live only in the template), contains no external file
 * references, and pins the template version it was produced against. Every
 * `required` input must be present; unknown keys, shape mismatches, and
 * duplicate fileset paths are rejected.
 */
export interface RealmPayload {
  /** Schema format version; only `2` is accepted by the v2 surface. */
  formatVersion: 2;
  /** Template id the payload targets. */
  templateId: string;
  /** Template version the payload was produced against (`sha256:<hex>`). */
  templateVersion: string;
  /** Input values keyed by declared input id. */
  inputs: Readonly<Record<string, RealmPayloadInputValue>>;
  /** Optional provenance block. */
  provenance?: RealmPayloadProvenance;
}

/**
 * One validated format-v2 input value: the declaration's shape tag plus the
 * resolved content.
 */
export type RealmInputValue =
  | { shape: 'text'; text: string }
  | { shape: 'files'; files: readonly RealmPayloadFile[] };

/**
 * Validated input values keyed by declared input id (supplied values only;
 * defaults resolve at composition time).
 */
export type RealmInputValues = Readonly<Record<string, RealmInputValue>>;

/**
 * Fully validated payload resolution produced by `validatePayload()`.
 *
 * `inputs` carries the supplied values keyed by declared input id (shape
 * tagged); `warnings` carries review-surface notes (for example an explicitly
 * allowed version mismatch).
 */
export interface ResolvedPayload {
  /** Template id the payload targets (equal to the validated template's id). */
  templateId: string;
  /** Template version the payload pinned (`sha256:<hex>`). */
  templateVersion: string;
  /** Supplied input values keyed by declared input id. */
  inputs: RealmInputValues;
  /** Review warnings (empty when none). */
  warnings: readonly string[];
}

/**
 * Options accepted by the format-v2 composition helpers.
 */
export interface RealmComposeOptions {
  /** Supplied input values keyed by declared input id (shape tagged). */
  inputs?: RealmInputValues;
  /** Bundle file bodies keyed by bundle-relative path. */
  bundleFiles?: Readonly<Record<string, string>>;
}

/**
 * Launch options accepted by `materializeTemplate()`.
 */
export interface RealmMaterializeOptions extends RealmComposeOptions {
  /** Target realm id (membership metadata only; agent ids never embed it). */
  realmId: string;
  /** Per-agent-key id overrides; keys must name template agent keys. */
  idOverrides?: Readonly<Record<string, string>>;
}

/**
 * One resolved placement: destination path, target, and the resolved content.
 *
 * Targets stay template agent keys — resolving keys to launched agent ids
 * belongs to the launch orchestration, not to the catalog.
 */
export interface RealmResolvedPlacement {
  /** Destination path copied from the placement (or root-joined for filesets). */
  path: string;
  /** Destination workspace: the Realm-global partition or one template agent key. */
  target: 'realm' | { agent: string };
  /** Resolved content (input value or bundle file body). */
  content: string;
}

/**
 * One resolved directive: the target agent key and the resolved message text.
 */
export interface RealmResolvedDirective {
  /** Target template agent key. */
  targetAgentKey: string;
  /** Resolved message text (never empty; empty optional inputs deliver nothing). */
  text: string;
}

/**
 * Deeply frozen format-v2 launch plan produced by `materializeTemplate()`.
 *
 * The plan is deterministic: agent order is template order, placement and
 * directive order is declared order, and every field is a pure function of the
 * template plus the launch options.
 */
export interface RealmLaunchPlan {
  /** Id of the template the plan was materialized from. */
  templateId: string;
  /** Target realm id, stored verbatim from the materialization options. */
  realmId: string;
  /** Resolved workspace placements, in declared order (empty when none declared). */
  placements: readonly RealmResolvedPlacement[];
  /** Resolved directives, in declared order (empty when none declared). */
  directives: readonly RealmResolvedDirective[];
  /** Resolved agent plans, in template order. */
  agents: readonly RealmLaunchAgentPlan[];
}

/**
 * Parsed and validated format-v2 transport bundle produced by
 * `parseTemplateBundle()`.
 *
 * `template` is the normalized format-v2 model (a format-v1 bundle is shimmed);
 * `serialized` is the canonical authored transport JSON (round-trips to a
 * deep-equal parsed bundle with the same `version`), and `version` pins the
 * authored content. `sourceFormatVersion` records which format the transport
 * document declared.
 */
export interface ParsedTemplateBundle {
  /** The validated, normalized format-v2 template. */
  template: RealmTemplate;
  /** Bundle file bodies keyed by bundle-relative path. */
  files: BundleFiles;
  /** Per-bundle content version over the authored transport form (`sha256:<hex>`). */
  version: string;
  /** Format the authored transport document declared. */
  sourceFormatVersion: 1 | 2;
  /** Canonical authored transport JSON text (stable round-trip input). */
  serialized: string;
  /** Parse warnings (empty when none). */
  warnings: readonly string[];
}
