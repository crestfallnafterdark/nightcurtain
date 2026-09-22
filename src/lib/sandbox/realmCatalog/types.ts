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
 * inserts parts in declared order; an empty input contributes nothing.
 */
export type PromptPart =
  | { kind: 'file'; path: string }
  | { kind: 'input'; inputId: string }
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
export interface RealmTemplateInput {
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
export interface RealmTemplateSeedFile {
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
export interface RealmSeedManifest {
  /** Files to seed, in declared order. */
  files?: readonly RealmTemplateSeedFile[];
  /** Optional first directive delivered to the named template agent key. */
  directive?: { targetAgentKey: string; text: string };
}

/**
 * Hydration declaration: the overall instruction a hydrator reads when
 * producing a package for this template.
 */
export interface RealmHydrationDeclaration {
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
 * A code-owned Realm template.
 *
 * Templates are frozen data: they declare the schema format version, optional
 * hydration brief, optional template inputs, agent roles with ordered prompt
 * parts and baked history, an optional seed manifest, and the optional
 * capability contract. Domain content lives in bundle files referenced by
 * prompt parts and seed sources; the kernel ships no policy content and no
 * provider implementations.
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
  /** Schema format version; only `1` is accepted. */
  formatVersion: 1;
  /** Overall hydrator instruction. */
  hydration?: RealmHydrationDeclaration;
  /** Declared template inputs referenced by `input` parts. */
  inputs?: readonly RealmTemplateInput[];
  /** Declared agent specs, in launch order; never empty. */
  agents: RealmAgentSpec[];
  /** Optional seed manifest resolved by materialization. */
  seed?: RealmSeedManifest;
  /** Optional capability requirements (shape-validated; never resolved in this wave). */
  toolContract?: RealmToolContract;
  /** Optional provider requests (shape-validated; never resolved in this wave). */
  providers?: readonly RealmProvider[];
}

/**
 * One baked Realm template bundle: a frozen template plus the bundle file
 * bodies its `file` prompt parts, input `defaultFile` prefills, and seed
 * `source.file` entries resolve against.
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
 * Resolved input values keyed by declared input id.
 *
 * Used by `composeAgentHistory()` (history parts resolve from this map) and by
 * launch callers that pass one value per declared input to
 * `materializeTemplate()`.
 */
export type RealmInputValues = Readonly<Record<string, string>>;

/**
 * Bundle file bodies keyed by bundle-relative path (or hydration file content
 * keyed by slot path when a caller composes history against hydrated content).
 */
export type BundleFiles = Readonly<Record<string, string>>;

/**
 * One hydration file entry resolved from a package: the declared slot path and
 * target plus the content the hydrator produced.
 */
export interface ResolvedHydrationFile {
  /** Slot destination path (workspace-relative; matches a declared seed slot). */
  path: string;
  /** Destination workspace: the Realm-global partition or one template agent key. */
  target: 'realm' | { agent: string };
  /** Slot content (may be empty). */
  content: string;
}

/**
 * Fully validated hydration package resolution produced by
 * `validateHydrationPackage()`.
 *
 * `templateVersion` is the version the package pinned; `inputValues` are the
 * package's declared input values; `files` are the package's file entries in
 * package order; `warnings` carries review-surface notes (for example an
 * explicitly allowed version mismatch).
 */
export interface ResolvedHydration {
  /** Template id the package targets (equal to the validated template's id). */
  templateId: string;
  /** Template version the package pinned (`sha256:<hex>`). */
  templateVersion: string;
  /** Package input values keyed by declared input id. */
  inputValues: RealmInputValues;
  /** Package file entries in package order. */
  files: readonly ResolvedHydrationFile[];
  /** Review warnings (empty when none). */
  warnings: readonly string[];
}

/**
 * Parsed and validated canonical transport bundle produced by
 * `parseTemplateBundle()`.
 *
 * `version` is the per-bundle content version
 * ({@link templateBundleVersion} semantics: the canonical template JSON plus
 * each referenced bundle file, framed and hashed). `warnings` carries review
 * notes; the transport envelope itself never silently drops fields.
 */
export interface ParsedTemplateBundle {
  /** The validated template (deeply frozen). */
  template: RealmTemplate;
  /** Bundle file bodies keyed by bundle-relative path (deeply frozen). */
  files: BundleFiles;
  /** Per-bundle content version (`sha256:<hex>`). */
  version: string;
  /** Parse warnings (empty when none). */
  warnings: readonly string[];
}

/**
 * Options accepted by the composition helpers.
 */
export interface RealmComposeOptions {
  /** Launch-level input values keyed by declared input id. */
  inputValues?: Readonly<Record<string, string>>;
  /** Bundle file bodies keyed by bundle-relative path. */
  bundleFiles?: Readonly<Record<string, string>>;
  /** Resolved hydration file entries matching declared `user`/`generated` seed slots. */
  hydrationFiles?: readonly ResolvedHydrationFile[];
}

/**
 * One resolved seed file: destination, target, and the resolved content.
 *
 * Targets stay template agent keys — resolving keys to launched agent ids
 * belongs to the seeding orchestration, not to the catalog.
 */
export interface RealmResolvedSeedFile {
  /** Destination path copied from the manifest. */
  path: string;
  /** Destination workspace: the Realm-global partition or one template agent key. */
  target: 'realm' | { agent: string };
  /** Resolved content (inline verbatim, or the referenced bundle file body). */
  content: string;
}

/**
 * Resolved seed manifest carried by a launch plan: inline and bundle-file
 * sources are resolved to content and the directive is copied verbatim.
 */
export interface RealmResolvedSeed {
  /** Resolved files, in declared order (empty when the manifest declares none). */
  files: readonly RealmResolvedSeedFile[];
  /** Directive copied from the manifest when declared. */
  directive?: { targetAgentKey: string; text: string };
}

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
 * Deeply frozen launch plan produced by `materializeTemplate()`.
 *
 * The plan is deterministic: agent order is template order and every field is
 * a pure function of the template plus the launch options.
 */
export interface RealmLaunchPlan {
  /** Id of the template the plan was materialized from. */
  templateId: string;
  /** Target realm id, stored verbatim from the materialization options. */
  realmId: string;
  /** Resolved seed manifest; absent when the template declares no seed. */
  seed?: RealmResolvedSeed;
  /** Resolved agent plans, in template order. */
  agents: readonly RealmLaunchAgentPlan[];
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
 * `summarizeAgentCapabilities()`: the declared profile, the privilege flag, or
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
 * `summarizeAgentCapabilities()`.
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
