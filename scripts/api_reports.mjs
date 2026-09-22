#!/usr/bin/env node
/**
 * @file scripts/api_reports.mjs
 * @description Phase 3 generated-ICD pipeline: API Extractor surface + doc model + in-source
 * contract tags -> tracked `docs/generated/modules/<module>.api.md`.
 *
 * Modes
 * -----
 * `--write`  Regenerate the tracked reports under `docs/generated/modules/` (+ `INDEX.md`).
 * `--check`  Regenerate into a temp tree and byte-compare against the tracked files; prints a
 *            unified-diff summary and exits 1 on any difference (README §6 Tier 3 freshness).
 *            This is also the default mode when neither `--write` nor `--check` is given.
 * `--json`   Emit a machine-readable summary instead of human output. May accompany either mode;
 *            used alone it implies `--check`.
 *
 * Extraction
 * ----------
 * One programmatic `ExtractorConfig.prepare` + `Extractor.invoke` per contract (the CLI is
 * one-entry-per-config). Every invocation shares a single `CompilerState` created with all other
 * contracts as additional entry points (~0.7s for all 30 entries vs ~3.9s when each invocation
 * builds its own TypeScript program). `localBuild: true` is deliberate: report freshness is
 * enforced by this script's own byte-diff, so the only thing the non-local mode would add is a
 * second, redundant drift report (`api-extractor` always exits 0 in local builds either way).
 *
 * Dual-mode discovery (TS rewrite)
 * --------------------------------
 * The contract set is discovered from `src/lib/sandbox` rather than a hard-coded list:
 * - born-`.ts` module: `<folder>/index.ts` or `<folder>/index.svelte.ts` — the report key is the
 *   folder path (`runtime/index.ts` => `runtime`, `runtime/agent/index.ts` => `runtime/agent`);
 * - flat contract: `*.d.ts` / `*.svelte.d.ts` with no born-`.ts` successor — the key is the path
 *   with the full contract extension stripped (legacy `runtime/index.d.ts` => `runtime/index`,
 *   README §5). During a conversion wave the born-`.ts` surface shadows its retired `.d.ts` pair.
 *
 * API Extractor analyzes declarations, never sources, so born-`.ts` contracts get a declaration
 * pre-pass: the emit mirror is populated from the repo `jsconfig.json` (declaration-only, svelte
 * rune globals included) and existing flat `.d.ts` files are copied alongside it, which keeps
 * mixed unconverted/converted imports resolvable. Type diagnostics do not fail this pipeline; the
 * gates that own them are `lint` / `typecheck`. With zero `.ts` present the pre-pass is skipped
 * entirely and behavior is byte-identical to the flat-only pipeline.
 *
 * Message policy (`api-extractor.json`, README `docs/modules/README.md` §6 Tier 4)
 * --------------------------------------------------------------------------------
 * - `ae-missing-release-tag`: none  — the corpus never carried release tags; they are not part of
 *   this contract schema, and the generated report is the release artifact.
 * - `ae-undocumented`: error        — the coverage signal required by README §9. Wave R1 closed
 *   every member-doc gap and Wave R2 flipped this message from `warning` to `error`: from now on
 *   any declaration without a TSDoc summary fails extraction (`errorCount`). The explicit
 *   doc-coverage assertion below re-verifies the same invariant on the extracted doc model, so
 *   the gate stays non-zero even if the extractor policy is ever downgraded again.
 * - `ae-forgotten-export`: warning  — referenced-but-not-exported declarations (`ModelPreset`,
 *   `ProviderInterface`, ...) are inherent to per-entry extraction; each report lists them.
 * - `ae-unresolved-link`: none      — per-entry extraction cannot resolve `{@link}` targets that
 *   are declarations of sibling contracts (not exports of this entry). The direct TSDoc renderer
 *   emits the link text regardless, so the reader still gets a readable name; failing or warning
 *   on every sibling cross-reference would only add noise. Counted per report for visibility.
 *
 * Gate failure is driven by extraction `errorCount` (which now carries `ae-undocumented`), the
 * explicit doc-coverage assertion, and report byte-drift. Remaining warnings stay visible (report
 * sections + `--json` counters); they do not fail the gate.
 *
 * Determinism
 * -----------
 * Reports carry no timestamps and no absolute paths; input order comes from the sorted discovery
 * walk; message-derived lists are de-duplicated and sorted; the rendered bodies are stable slices
 * of API Extractor output. Generated reports are never hand-edited — drift is a gate failure,
 * fixed by `npm run api:reports`.
 *
 * Test hook
 * ---------
 * `--reports-root <path>` points `--write`/`--check` at an alternate reports tree. It exists for
 * negative-control proofs in scratch space; the gate chain never passes it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CompilerState, Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import {
  DocCodeSpan,
  DocErrorText,
  DocEscapedText,
  DocFencedCode,
  DocHtmlEndTag,
  DocHtmlStartTag,
  DocInlineTag,
  DocLinkTag,
  DocParagraph,
  DocPlainText,
  DocSection,
  DocSoftBreak,
  TSDocConfiguration,
  TSDocParser
} from '@microsoft/tsdoc';
import { TSDocConfigFile } from '@microsoft/tsdoc-config';
import ts from 'typescript';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const CONTRACTS_ROOT = path.join(PROJECT_ROOT, 'src/lib/sandbox');
const DEFAULT_REPORTS_ROOT = path.join(PROJECT_ROOT, 'docs/generated/modules');
const BASE_CONFIG_PATH = path.join(PROJECT_ROOT, 'api-extractor.json');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');
const JS_CONFIG_PATH = path.join(PROJECT_ROOT, 'jsconfig.json');
const INDEX_FILE_NAME = 'INDEX.md';
const TS_SURFACE_FILE_NAMES = new Set(['index.ts', 'index.svelte.ts']);

const CUSTOM_TAGS = new Set(['@module', '@mayImport', '@mustNotImport', '@invariant', '@decision']);
const POLICY_MESSAGE_IDS = ['ae-undocumented', 'ae-forgotten-export', 'ae-unresolved-link'];

const MAX_DIFF_FILES = 6;
const MAX_DIFF_LINES_PER_FILE = 60;

const KIND_LABELS = {
  Class: 'class',
  Constructor: 'constructor',
  Enum: 'enum',
  EnumMember: 'enum member',
  Function: 'function',
  IndexSignature: 'index signature',
  Interface: 'interface',
  Method: 'method',
  MethodSignature: 'method',
  Namespace: 'namespace',
  Property: 'property',
  PropertySignature: 'property',
  TypeAlias: 'type alias',
  Variable: 'variable'
};

const argv = process.argv.slice(2);
let mode = null;
let jsonOutput = false;
let reportsRootArg = null;
let showHelp = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--write') mode = 'write';
  else if (arg === '--check') mode = 'check';
  else if (arg === '--json') jsonOutput = true;
  else if (arg === '--help' || arg === '-h') showHelp = true;
  else if (arg === '--reports-root') {
    reportsRootArg = argv[i + 1] || null;
    i += 1;
  } else if (arg.startsWith('--reports-root=')) {
    reportsRootArg = arg.slice('--reports-root='.length);
  } else {
    process.stderr.write(
      `Unknown argument '${arg}'. Usage: node scripts/api_reports.mjs (--write | --check) [--json] [--reports-root <path>]\n`
    );
    process.exit(2);
  }
}

if (showHelp) {
  process.stdout.write(
    'Usage: node scripts/api_reports.mjs (--write | --check) [--json] [--reports-root <path>]\n' +
      '\n' +
      '  --write   regenerate tracked reports under docs/generated/modules/\n' +
      '  --check   regenerate to a temp tree and fail on any diff vs tracked files (default)\n' +
      '  --json    emit a machine-readable summary instead of human output\n' +
      '  --reports-root <path>  test hook: alternate reports tree (default docs/generated/modules)\n'
  );
  process.exit(0);
}

if (!mode) mode = 'check';

const REPORTS_ROOT = reportsRootArg
  ? path.resolve(PROJECT_ROOT, reportsRootArg)
  : DEFAULT_REPORTS_ROOT;

const REPORTS_ROOT_DISPLAY = displayPath(REPORTS_ROOT);

/**
 * Human-report sink; silenced in `--json` mode so stdout stays machine-parseable.
 *
 * @param {...unknown} args
 */
const log = jsonOutput ? () => {} : (...args) => process.stdout.write(`${args.join(' ')}\n`);

/**
 * Renders a path for reports: repo-relative when possible, absolute otherwise.
 *
 * @param {string} filePath
 * @returns {string}
 */
function displayPath(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

/**
 * Converts a filesystem-relative path to POSIX separators (report keys are always `/`-joined).
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Replaces the run's random temp-root prefix inside extractor messages and embedded report
 * comments with a stable placeholder so rendered paths stay byte-identical across runs. Paths in
 * the emitted-declaration mirror collapse to `<declarations>/` (keeping the remainder legible);
 * anything else under the temp root collapses to `<api-reports-temp>/`.
 *
 * @param {string} text
 * @param {string} tempRoot
 * @returns {string}
 */
function normalizeTempPaths(text, tempRoot) {
  if (!text) return text;
  let normalized = text;
  for (const root of new Set([tempRoot, toPosix(tempRoot)])) {
    normalized = normalized.split(`${root}/declarations/`).join('<declarations>/');
    normalized = normalized.split(root).join('<api-reports-temp>');
  }
  return normalized;
}

/**
 * Recursively lists absolute files under a root, filtered and locale-sorted so discovery input
 * order is deterministic.
 *
 * @param {string} root
 * @param {(filePath: string) => boolean} predicate
 * @returns {string[]}
 */
function listAbsoluteFiles(root, predicate) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const scan = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (predicate(full)) files.push(full);
    }
  };
  scan(root);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Maps a flat contract path to its module id: contract-relative path with the full contract
 * extension stripped (`.d.ts`; `.svelte.d.ts` also loses `.svelte` — README §5).
 *
 * @param {string} filePath
 * @returns {string}
 */
function moduleIdForDtsPath(filePath) {
  return toPosix(path.relative(CONTRACTS_ROOT, filePath))
    .replace(/\.d\.ts$/, '')
    .replace(/\.svelte$/, '');
}

/**
 * True when a flat `.d.ts` contract has a born-`.ts` successor: `<stem>/index.ts` /
 * `index.svelte.ts` (or a sibling `index.ts` for an `index.d.ts`). While both exist during a
 * conversion wave they must collapse to a single module keyed by the folder path.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isRetiredByTsSurface(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/\.d\.ts$/, '');
  const folders = base === 'index' ? [dir] : [path.join(dir, base.replace(/\.svelte$/, ''))];
  return folders.some(folder =>
    [...TS_SURFACE_FILE_NAMES].some(name => fs.existsSync(path.join(folder, name)))
  );
}

/**
 * Discovers the contract set from the sandbox tree (dual-mode):
 * - born-`.ts` modules: `<folder>/index.ts` / `index.svelte.ts`; key = folder path;
 * - flat contracts: `*.d.ts` / `*.svelte.d.ts` without a born-`.ts` successor; key = path with the
 *   contract extension stripped (legacy `runtime/index.d.ts` keeps its old key until promoted).
 *
 * Vacuity is guarded here; drift against the tracked reports (missing/extra) is caught by the
 * caller's tree comparison.
 *
 * @returns {Array<{ moduleId: string, kind: 'dts'|'ts', surfacePath: string, extractorPath: string, contractDisplayPath: string }>}
 */
function discoverModules() {
  const surfaces = new Map();
  const flatContracts = [];

  const scan = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (TS_SURFACE_FILE_NAMES.has(entry.name)) {
        if (current === CONTRACTS_ROOT) continue; // the sandbox root barrel is not a module
        surfaces.set(toPosix(path.relative(CONTRACTS_ROOT, current)), full);
      } else if (entry.name.endsWith('.d.ts')) {
        flatContracts.push(full);
      }
    }
  };
  scan(CONTRACTS_ROOT);

  const modules = [];
  for (const [moduleId, surfacePath] of surfaces) {
    modules.push({
      moduleId,
      kind: 'ts',
      surfacePath,
      extractorPath: surfacePath, // replaced by the emitted declaration during generation
      contractDisplayPath: displayPath(surfacePath)
    });
  }
  for (const filePath of flatContracts) {
    if (isRetiredByTsSurface(filePath)) continue;
    const moduleId = moduleIdForDtsPath(filePath);
    if (surfaces.has(moduleId)) continue;
    modules.push({
      moduleId,
      kind: 'dts',
      surfacePath: filePath,
      extractorPath: filePath,
      contractDisplayPath: displayPath(filePath)
    });
  }

  modules.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  if (modules.length === 0) {
    throw new Error(
      `No sandbox contracts discovered under ${displayPath(CONTRACTS_ROOT)}; discovery is vacuous.`
    );
  }
  return modules;
}

/**
 * Builds a TSDoc parser configured from the repo `tsdoc.json` (custom tags included).
 *
 * @returns {TSDocParser}
 */
function createTsdocParser() {
  const configFile = TSDocConfigFile.loadForFolder(PROJECT_ROOT);
  const configuration = new TSDocConfiguration();
  configFile.configureParser(configuration);
  return new TSDocParser(configuration);
}

/**
 * Finds the module header comment: the first TSDoc doc comment carrying the
 * `@packageDocumentation` modifier (`@module` tags live there per README §2).
 *
 * @param {string} text full file text
 * @param {TSDocParser} parser
 * @returns {import('@microsoft/tsdoc').ParserContext|null}
 */
function findPackageDocumentationComment(text, parser) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let token = scanner.scan();

  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const candidate = text.slice(scanner.getTokenStart(), scanner.getTokenEnd());
      if (candidate.startsWith('/**')) {
        const context = parser.parseString(candidate);
        const isHeader = context.docComment.modifierTagSet.nodes.some(
          node => node.tagName === '@packageDocumentation'
        );
        if (isHeader) return context;
      }
    }
    token = scanner.scan();
  }

  return null;
}

/**
 * Extracts the contract tags from a module header comment, preserving source order.
 *
 * @param {import('@microsoft/tsdoc').ParserContext} headerContext
 * @param {string} expectedModuleId
 * @returns {{ moduleId: string|null, mayImport: string[], mustNotImport: string[], invariants: string[], decisions: string[] }}
 */
function extractModuleTags(headerContext, expectedModuleId) {
  const result = { moduleId: null, mayImport: [], mustNotImport: [], invariants: [], decisions: [] };

  for (const block of headerContext.docComment.customBlocks) {
    const tagName = block.blockTag.tagName;
    if (!CUSTOM_TAGS.has(tagName)) continue;
    const value = renderInline(block.content.getChildNodes());

    if (tagName === '@module') result.moduleId = value;
    else if (tagName === '@mayImport') result.mayImport.push(value);
    else if (tagName === '@mustNotImport') result.mustNotImport.push(value);
    else if (tagName === '@invariant') result.invariants.push(value);
    else if (tagName === '@decision') result.decisions.push(value);
  }

  if (result.moduleId !== expectedModuleId) {
    throw new Error(
      `Module header declares @module '${result.moduleId ?? '(missing)'}' but the contract path expects '${expectedModuleId}'.`
    );
  }
  return result;
}

/**
 * Renders an inline node to markdown text.
 *
 * @param {import('@microsoft/tsdoc').DocNode} node
 * @returns {string}
 */
function renderInlineNode(node) {
  if (node instanceof DocPlainText) return node.text;
  if (node instanceof DocSoftBreak) return ' ';
  if (node instanceof DocEscapedText) return node.decodedText;
  if (node instanceof DocCodeSpan) return `\`${node.code}\``;
  if (node instanceof DocErrorText) return node.text;
  if (node instanceof DocLinkTag) {
    const destination = node.codeDestination ? node.codeDestination.emitAsTsdoc() : '';
    const text = node.linkText || destination || node.urlDestination || '';
    return node.urlDestination ? `[${text}](${node.urlDestination})` : text;
  }
  if (node instanceof DocHtmlStartTag || node instanceof DocHtmlEndTag) {
    return typeof node.emitAsHtml === 'function' ? node.emitAsHtml() : '';
  }
  if (node instanceof DocInlineTag) {
    return node.tagContent ? `{@${node.tagName} ${renderInline(node.getChildNodes())}}` : `{@${node.tagName}}`;
  }
  if (node instanceof DocSection || node instanceof DocParagraph) {
    return renderInline(node.getChildNodes());
  }
  return '';
}

/**
 * Renders a node list to a single line. Block-level nodes (paragraphs/sections) are separated by
 * a space so multi-paragraph summaries stay readable in bullets.
 *
 * @param {ReadonlyArray<import('@microsoft/tsdoc').DocNode>} nodes
 * @returns {string}
 */
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node instanceof DocParagraph || node instanceof DocSection) {
      const text = renderInline(node.getChildNodes());
      if (text) out += `${out && !/\s$/.test(out) ? ' ' : ''}${text} `;
    } else {
      out += renderInlineNode(node);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Renders a fenced code node as a markdown fence.
 *
 * @param {import('@microsoft/tsdoc').DocFencedCode} node
 * @returns {string}
 */
function renderFencedCode(node) {
  const language = node.language || '';
  return `\`\`\`${language}\n${node.code.replace(/\n+$/, '')}\n\`\`\``;
}

/**
 * Renders a node list as block-level markdown (paragraphs and fenced code).
 *
 * @param {ReadonlyArray<import('@microsoft/tsdoc').DocNode>} nodes
 * @returns {string}
 */
function renderBody(nodes) {
  const parts = [];
  for (const node of nodes) {
    if (node instanceof DocParagraph) {
      const text = renderInline(node.getChildNodes());
      if (text) parts.push(text);
    } else if (node instanceof DocFencedCode) {
      parts.push(renderFencedCode(node));
    } else if (node instanceof DocSection) {
      const nested = renderBody(node.getChildNodes());
      if (nested) parts.push(nested);
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Renders `@param` blocks merged with the declaration's parameter list so undocumented
 * parameters stay visible.
 *
 * @param {import('@microsoft/tsdoc').DocComment} comment
 * @param {Array<{ parameterName: string }>|undefined} parameters
 * @returns {string}
 */
function renderParameterList(comment, parameters) {
  const documented = new Map(
    comment.params.blocks.map(block => [
      block.parameterName,
      renderInline(block.content.getChildNodes())
    ])
  );
  const names = parameters && parameters.length > 0
    ? parameters.map(parameter => parameter.parameterName)
    : [...documented.keys()];
  const lines = [];
  for (const name of names) {
    const description = documented.get(name);
    lines.push(description ? `- \`${name}\` — ${description}` : `- \`${name}\` — _No description._`);
  }
  return lines.join('\n');
}

/**
 * Parses an item's TSDoc comment string from the doc model.
 *
 * @param {TSDocParser} parser
 * @param {{ docComment?: string }|null|undefined} member
 * @returns {import('@microsoft/tsdoc').DocComment|null}
 */
function parseItemComment(parser, member) {
  if (!member || !member.docComment) return null;
  return parser.parseString(member.docComment).docComment;
}

/**
 * Returns the summary text of an item's doc comment, or an empty string.
 *
 * @param {TSDocParser} parser
 * @param {{ docComment?: string }|null|undefined} member
 * @returns {string}
 */
function itemSummary(parser, member) {
  const comment = parseItemComment(parser, member);
  return comment ? renderInline(comment.summarySection.getChildNodes()) : '';
}

/**
 * Returns a display name for any doc model declaration kind.
 *
 * @param {object} member
 * @returns {string}
 */
function declarationName(member) {
  if (member.name) return member.name;
  if (member.kind === 'Constructor') return 'constructor';
  if (member.kind === 'IndexSignature') return 'index signature';
  if (member.kind === 'CallSignature') return 'call signature';
  return '(signature)';
}

/**
 * Renders one exported (or member) declaration's API docs section.
 *
 * @param {object} member doc model member
 * @param {TSDocParser} parser
 * @param {number} depth heading depth offset (2 => `###`)
 * @returns {string}
 */
function renderApiDocEntry(member, parser, depth = 3) {
  const kind = KIND_LABELS[member.kind] || String(member.kind || 'member').toLowerCase();
  const heading = `${'#'.repeat(depth)} \`${declarationName(member)}\` — ${kind}`;
  const comment = parseItemComment(parser, member);
  const sections = [heading];

  const summary = comment ? renderBody(comment.summarySection.getChildNodes()) : '';
  sections.push(summary || '_No TSDoc summary._');

  if (comment?.remarksBlock) {
    const remarks = renderBody(comment.remarksBlock.content.getChildNodes());
    if (remarks) sections.push('#### Remarks', remarks);
  }

  if (comment?.deprecatedBlock) {
    const deprecated = renderBody(comment.deprecatedBlock.content.getChildNodes());
    if (deprecated) sections.push(`> **Deprecated:** ${deprecated}`);
  }

  if (Array.isArray(member.parameters) && member.parameters.length > 0) {
    const params = renderParameterList(comment, member.parameters);
    if (params) sections.push('#### Parameters', params);
  }

  if (comment?.returnsBlock) {
    const returns = renderBody(comment.returnsBlock.content.getChildNodes());
    if (returns) sections.push('#### Returns', returns);
  }

  const exampleBlocks = (comment?.customBlocks || []).filter(
    block => block.blockTag.tagName === '@example'
  );
  for (const block of exampleBlocks) {
    const example = renderBody(block.content.getChildNodes());
    if (example) sections.push('#### Examples', example);
  }

  const throwBlocks = (comment?.customBlocks || []).filter(
    block => block.blockTag.tagName === '@throws'
  );
  if (throwBlocks.length > 0) {
    const throws = throwBlocks
      .map(block => `- ${renderInline(block.content.getChildNodes())}`)
      .filter(line => line !== '- ');
    if (throws.length > 0) sections.push('#### Throws', throws.join('\n'));
  }

  const nested = Array.isArray(member.members) ? member.members : [];
  if (nested.length > 0) {
    const documented = [];
    for (const child of nested) {
      const childSummary = itemSummary(parser, child);
      if (childSummary) documented.push(`- **\`${declarationName(child)}\`** — ${childSummary}`);
    }
    sections.push('#### Members', documented.length > 0 ? documented.join('\n') : '_No documented members._');
  }

  return sections.join('\n\n');
}

/**
 * Renders the per-export TSDoc channel for every top-level export of an entry point.
 *
 * @param {object} entryPoint doc model `EntryPoint` member
 * @param {TSDocParser} parser
 * @returns {string}
 */
function renderApiDocs(entryPoint, parser) {
  const members = Array.isArray(entryPoint.members) ? entryPoint.members : [];
  if (members.length === 0) return '_This contract exports no declarations._';
  return members.map(member => renderApiDocEntry(member, parser)).join('\n\n');
}

/**
 * Extracts the fenced TypeScript surface from an API Extractor report, dropping the report's own
 * title/notice (the generated report supplies its own header).
 *
 * @param {string} reportText
 * @returns {string}
 */
function extractSurface(reportText) {
  const start = reportText.indexOf('```ts');
  const end = reportText.lastIndexOf('```');
  if (start === -1 || end === -1 || end <= start) return reportText.trim();
  return reportText
    .slice(start + '```ts'.length, end)
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Recursively collects a declaration and all nested members.
 *
 * @param {object} member
 * @param {object[]} out
 */
function collectDeclarations(member, out) {
  out.push(member);
  for (const child of Array.isArray(member.members) ? member.members : []) {
    collectDeclarations(child, out);
  }
}

/**
 * Counts declarations and TSDoc coverage for the doc-coverage section.
 *
 * @param {object} entryPoint
 * @param {TSDocParser} parser
 * @returns {{ exports: number, declarations: number, documented: number, undocumented: number }}
 */
function computeCoverage(entryPoint, parser) {
  const declarations = [];
  for (const member of Array.isArray(entryPoint.members) ? entryPoint.members : []) {
    collectDeclarations(member, declarations);
  }
  let documented = 0;
  for (const declaration of declarations) {
    if (itemSummary(parser, declaration)) documented += 1;
  }
  return {
    exports: (entryPoint.members || []).length,
    declarations: declarations.length,
    documented,
    undocumented: declarations.length - documented
  };
}

/**
 * Renders an invariant tag value, marking a leading `ID:` token.
 *
 * @param {string} value
 * @returns {string}
 */
function renderInvariant(value) {
  const match = /^([A-Z][A-Z0-9-]*):\s*(.*)$/s.exec(value);
  return match ? `- \`${match[1]}\` — ${match[2]}` : `- ${value}`;
}

/**
 * Renders a decision tag value, appending its durable ref when the tag carries one (the trailing
 * ` | ref <ref>` suffix is optional; ref-less tags render as plain bullets).
 *
 * @param {string} value
 * @returns {string}
 */
function renderDecision(value) {
  const match = /^(.*?)\s\|\s+ref\s+(.+?)\s*$/s.exec(value);
  if (!match) return `- ${value}`;
  return `- ${match[1]} — ref: \`${match[2]}\``;
}

/**
 * Renders one boundary bullet list.
 *
 * @param {string[]} values
 * @returns {string}
 */
function renderBoundaryList(values) {
  if (values.length === 0) return '  - _(none tagged)_';
  return values.map(value => `  - \`${value.replace(/\\@/g, '@')}\``).join('\n');
}

/**
 * Summarizes the policy-relevant extractor messages for one module. `ae-forgotten-export` is
 * emitted *into* the API report and therefore never reaches the message callback; it is recovered
 * from the embedded report comments instead (the callback still carries `ae-undocumented` and
 * `ae-unresolved-link`).
 *
 * @param {Array<{ messageId: string, logLevel: string, text: string }>} messages
 * @param {string} reportText normalized raw API Extractor report
 * @returns {{ counts: Record<string, number>, forgotten: string[] }}
 */
function summarizeMessages(messages, reportText = '') {
  const counts = {};
  const forgotten = new Set();
  for (const message of messages) {
    if (POLICY_MESSAGE_IDS.includes(message.messageId)) {
      counts[message.messageId] = (counts[message.messageId] || 0) + 1;
    }
    if (message.messageId === 'ae-forgotten-export') {
      const match = /The symbol "([^"]+)"/.exec(message.text);
      if (match) forgotten.add(match[1]);
    }
  }

  const embeddedForgotten = [...reportText.matchAll(/ae-forgotten-export\) The symbol "([^"]+)"/g)];
  for (const match of embeddedForgotten) forgotten.add(match[1]);
  if (embeddedForgotten.length > 0) counts['ae-forgotten-export'] = embeddedForgotten.length;

  return {
    counts,
    forgotten: [...forgotten].sort((a, b) => a.localeCompare(b))
  };
}

/**
 * Renders one module's complete generated report.
 *
 * @param {object} ctx
 * @param {string} ctx.moduleId
 * @param {string} ctx.contractDisplayPath
 * @param {import('@microsoft/tsdoc').ParserContext} ctx.headerContext
 * @param {object} ctx.entryPoint doc model entry point
 * @param {string} ctx.reportText raw API Extractor report
 * @param {Array<{ messageId: string, logLevel: string, text: string }>} ctx.messages
 * @param {TSDocParser} parser
 * @returns {string}
 */
function renderModuleReport(ctx, parser) {
  const tags = extractModuleTags(ctx.headerContext, ctx.moduleId);
  const coverage = computeCoverage(ctx.entryPoint, parser);
  const reportText = ctx.reportText.replace(/\r\n/g, '\n');
  const messageSummary = summarizeMessages(ctx.messages, reportText);
  const statedUndocumented = messageSummary.counts['ae-undocumented'] || 0;
  const unresolvedLinks = messageSummary.counts['ae-unresolved-link'] || 0;

  const sections = [];

  sections.push(
    [
      `# Module contract: \`${ctx.moduleId}\``,
      '',
      `> Generated by \`scripts/api_reports.mjs\` from \`${ctx.contractDisplayPath}\` — do not edit.`,
      '> Regenerate with `npm run api:reports`; `npm run verify:api-reports` fails on any drift.'
    ].join('\n')
  );

  sections.push(
    [
      '## Module',
      '',
      `- **ID:** \`${tags.moduleId}\``,
      `- **Contract:** \`${ctx.contractDisplayPath}\``,
      '- **Surface:** API Extractor report (configuration in `api-extractor.json`)'
    ].join('\n')
  );

  sections.push(
    [
      '## Boundary',
      '',
      '- **May import (`@mayImport`):**',
      renderBoundaryList(tags.mayImport),
      '- **Must not import (`@mustNotImport`):**',
      renderBoundaryList(tags.mustNotImport),
      '',
      'Actual-edge cross-check is the Tier 2 architecture gate (`npm run gate:arch:json`); this section renders tagged intent only.'
    ].join('\n')
  );

  sections.push(
    [
      '## Invariants',
      '',
      tags.invariants.length > 0
        ? tags.invariants.map(renderInvariant).join('\n')
        : '_(none tagged)_'
    ].join('\n')
  );

  sections.push(
    [
      '## Decisions',
      '',
      tags.decisions.length > 0
        ? tags.decisions.map(renderDecision).join('\n')
        : '_(none tagged)_'
    ].join('\n')
  );

  sections.push(['## Surface', '', '```ts', extractSurface(reportText), '```'].join('\n'));
  sections.push(['## API docs', '', renderApiDocs(ctx.entryPoint, parser)].join('\n'));

  const coverageLines = [
    `- Top-level exports: ${coverage.exports}`,
    `- Declarations (exports + members): ${coverage.declarations}`,
    `- Documented declarations: ${coverage.documented} / ${coverage.declarations} (` +
      `${coverage.declarations === 0 ? 0 : Math.round((coverage.documented / coverage.declarations) * 100)}%)`,
    `- Missing TSDoc summaries: ${coverage.undocumented}`,
    `- API Extractor \`ae-undocumented\` (policy \`error\`): ${statedUndocumented}`,
    '- Referenced but not exported (`ae-forgotten-export`): ' +
      (messageSummary.forgotten.length > 0
        ? messageSummary.forgotten.map(name => `\`${name}\``).join(', ')
        : 'none'),
    `- Unresolved \`{@link}\` targets (\`ae-unresolved-link\`): ${unresolvedLinks} (policy \`none\`; see \`scripts/api_reports.mjs\`)`
  ];
  sections.push(['## Doc coverage', '', coverageLines.join('\n')].join('\n'));

  return `${sections.join('\n\n').replace(/\r\n/g, '\n')}\n`;
}

/**
 * Renders the reports index.
 *
 * @param {Array<{ moduleId: string, contractDisplayPath: string }>} entries
 * @returns {string}
 */
function renderIndex(entries) {
  const sorted = [...entries].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  const rows = sorted.map(
    entry =>
      `| \`${entry.moduleId}\` | \`${entry.contractDisplayPath}\` | [\`${entry.moduleId}.api.md\`](${entry.moduleId}.api.md) |`
  );
  return (
    [
      '# Generated module reports',
      '',
      '> Generated by `scripts/api_reports.mjs` — do not edit.',
      `> One report per tagged sandbox contract (${sorted.length} modules). Regenerate with \`npm run api:reports\`.`,
      '',
      '| Module | Contract | Report |',
      '| --- | --- | --- |',
      ...rows,
      ''
    ].join('\n')
  );
}

/**
 * Recursively lists files under a root, repo-relative and sorted.
 *
 * @param {string} root
 * @returns {string[]}
 */
function listFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const scan = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) scan(full);
      else files.push(displayPath(full));
    }
  };
  scan(root);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Builds a unified diff for one changed pair via `git diff --no-index` (fallback: summary only).
 *
 * @param {string|null} trackedPath
 * @param {string|null} generatedPath
 * @param {string} label
 * @returns {string}
 */
function unifiedDiff(trackedPath, generatedPath, label) {
  const args = ['diff', '--no-index', '--no-color', '--unified=3'];
  args.push('--', trackedPath || '/dev/null', generatedPath || '/dev/null');
  const result = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
  if (!output) return `(no unified diff available for ${label})`;

  const lines = output.split('\n').map(line => {
    if (line.startsWith('diff --git ')) return `diff --git a/${label} b/${label}`;
    if (line.startsWith('--- ')) return trackedPath ? `--- a/${label}` : '--- /dev/null';
    if (line.startsWith('+++ ')) return generatedPath ? `+++ b/${label}` : '+++ /dev/null';
    return line;
  });
  if (lines.length > MAX_DIFF_LINES_PER_FILE) {
    lines.length = MAX_DIFF_LINES_PER_FILE;
    lines.push(`... (diff truncated at ${MAX_DIFF_LINES_PER_FILE} lines)`);
  }
  return lines.join('\n');
}

/**
 * Compares the freshly generated in-memory tree against the tracked reports tree. Differing
 * generated files are materialized under a caller-provided scratch dir so `git diff --no-index`
 * can produce a unified diff (the extraction temp tree is already gone by then).
 *
 * @param {Map<string, string>} generated rel path -> content
 * @param {string} reportsRoot
 * @param {string} diffDir scratch dir for generated sides of diffs
 * @returns {Array<{ status: string, path: string, trackedPath: string|null, generatedPath: string|null }>}
 */
function compareTrees(generated, reportsRoot, diffDir) {
  const diffs = [];
  const trackedRoot = path.resolve(reportsRoot);

  const materialize = (relativePath, content) => {
    const target = path.join(diffDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };

  for (const [relativePath, content] of generated) {
    const trackedPath = path.join(trackedRoot, relativePath);
    if (!fs.existsSync(trackedPath)) {
      diffs.push({
        status: 'missing',
        path: relativePath,
        trackedPath: null,
        generatedPath: materialize(relativePath, content)
      });
      continue;
    }
    if (!Buffer.from(fs.readFileSync(trackedPath)).equals(Buffer.from(content))) {
      diffs.push({
        status: 'changed',
        path: relativePath,
        trackedPath,
        generatedPath: materialize(relativePath, content)
      });
    }
  }

  const expected = new Set(generated.keys());
  const trackedPrefix = displayPath(reportsRoot);
  for (const trackedPath of listFiles(reportsRoot)) {
    const relativePath = trackedPath.startsWith(`${trackedPrefix}/`)
      ? trackedPath.slice(trackedPrefix.length + 1)
      : trackedPath;
    if (!expected.has(relativePath)) {
      diffs.push({ status: 'extra', path: relativePath, trackedPath, generatedPath: null });
    }
  }

  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Copies the flat `.d.ts` contracts into the declaration mirror so imports from emitted
 * declarations resolve whether the target module has already converted to `.ts` or not (mixed
 * wave states), without rewriting any specifiers.
 *
 * @param {string} destination
 */
function copyFlatDeclarations(destination) {
  for (const filePath of listAbsoluteFiles(CONTRACTS_ROOT, candidate => candidate.endsWith('.d.ts'))) {
    const target = path.join(destination, path.relative(CONTRACTS_ROOT, filePath));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(filePath, target);
  }
}

/**
 * Emits compiler declarations for the born-`.ts` sandbox set into a mirror tree
 * (`<module>/index.svelte.ts` -> `<module>/index.svelte.d.ts`), because API Extractor analyzes
 * declarations, not sources. The repo `jsconfig.json` options are reused (bundler resolution,
 * `allowImportingTsExtensions`); `svelte` is added to `types` so `$state`-style runes in
 * `.svelte.ts` emit their real types. Type diagnostics are intentionally not fatal here — `lint`
 * and `typecheck` own them — but a skipped emit is.
 *
 * @param {string} destination
 */
function emitDeclarationFiles(destination) {
  const jsconfig = ts.readConfigFile(JS_CONFIG_PATH, ts.sys.readFile);
  if (jsconfig.error) {
    throw new Error(`Could not read ${displayPath(JS_CONFIG_PATH)}; declaration emit is unavailable.`);
  }
  const parsed = ts.parseJsonConfigFileContent(jsconfig.config, ts.sys, PROJECT_ROOT);
  const rootNames = listAbsoluteFiles(
    CONTRACTS_ROOT,
    filePath => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts')
  );
  const compilerOptions = {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    rootDir: CONTRACTS_ROOT,
    incremental: false,
    declarationMap: false,
    sourceMap: false,
    types: [...(parsed.options.types || []), 'svelte']
  };
  delete compilerOptions.outDir;
  delete compilerOptions.declarationDir;

  const program = ts.createProgram({
    rootNames,
    options: compilerOptions,
    projectReferences: parsed.projectReferences
  });
  const emitResult = program.emit(
    undefined,
    (fileName, data) => {
      if (typeof data !== 'string') return;
      const relative = path.relative(CONTRACTS_ROOT, fileName);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
      const target = path.join(destination, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    },
    undefined,
    true
  );
  if (emitResult.emitSkipped) {
    throw new Error('Declaration emit for the born-.ts module set was skipped; the .ts contract surface is unavailable.');
  }
}

/**
 * Runs the pipeline. Throws on extraction errors so `--write` never leaves a partial tree.
 *
 * @returns {{ generated: Map<string, string>, moduleResults: object[], coverageViolations: object[], extractionMs: number }}
 */
function generateAll() {
  const modules = discoverModules();
  const parser = createTsdocParser();
  const baseConfig = ExtractorConfig.loadFile(BASE_CONFIG_PATH);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'api-reports-'));
  const apiReportFolder = path.join(tempRoot, 'api-report');
  const apiReportTempFolder = path.join(tempRoot, 'api-report-temp');
  const docModelFolder = path.join(tempRoot, 'doc-model');
  fs.mkdirSync(apiReportFolder, { recursive: true });
  fs.mkdirSync(apiReportTempFolder, { recursive: true });
  fs.mkdirSync(docModelFolder, { recursive: true });

  const prepareConfig = ({ moduleId, extractorPath }) => {
    const flatName = moduleId.replace(/\//g, '__');
    const configObject = structuredClone(baseConfig);
    configObject.projectFolder = PROJECT_ROOT;
    configObject.mainEntryPointFilePath = extractorPath;
    configObject.compiler = { tsconfigFilePath: JS_CONFIG_PATH };
    configObject.apiReport = {
      enabled: true,
      reportFileName: `${flatName}.api.md`,
      reportFolder: `${apiReportFolder}/`,
      reportTempFolder: `${apiReportTempFolder}/`
    };
    configObject.docModel = {
      enabled: true,
      apiJsonFilePath: path.join(docModelFolder, `${flatName}.api.json`)
    };
    configObject.dtsRollup = { enabled: false };
    configObject.tsdocMetadata = { enabled: false };
    return ExtractorConfig.prepare({
      configObject,
      configObjectFullPath: BASE_CONFIG_PATH,
      packageJsonFullPath: PACKAGE_JSON_PATH
    });
  };

  const generated = new Map();
  const moduleResults = [];
  const coverageViolations = [];
  const extractionStartedAt = Date.now();

  try {
    if (modules.some(module => module.kind === 'ts')) {
      const declarationsRoot = path.join(tempRoot, 'declarations');
      fs.mkdirSync(declarationsRoot, { recursive: true });
      copyFlatDeclarations(declarationsRoot);
      emitDeclarationFiles(declarationsRoot);
      for (const module of modules) {
        if (module.kind !== 'ts') continue;
        const emittedPath = path.join(
          declarationsRoot,
          path.relative(CONTRACTS_ROOT, module.surfacePath).replace(/\.ts$/, '.d.ts')
        );
        if (!fs.existsSync(emittedPath)) {
          throw new Error(
            `${module.contractDisplayPath}: declaration emit produced no ${displayPath(emittedPath)}.`
          );
        }
        module.extractorPath = emittedPath;
      }
    }

    const prepared = modules.map(prepareConfig);

    const compilerState = CompilerState.create(prepared[0], {
      additionalEntryPoints: prepared.slice(1).map(config => config.mainEntryPointFilePath)
    });

    for (let i = 0; i < modules.length; i += 1) {
      const { moduleId, surfacePath, contractDisplayPath } = modules[i];
      const flatName = moduleId.replace(/\//g, '__');
      const messages = [];
      const result = Extractor.invoke(prepared[i], {
        localBuild: true,
        compilerState,
        messageCallback: message => {
          message.handled = true;
          messages.push({
            messageId: message.messageId,
            logLevel: message.logLevel,
            text: normalizeTempPaths(message.text, tempRoot)
          });
        }
      });

      const contractText = fs.readFileSync(surfacePath, 'utf-8');
      const headerContext = findPackageDocumentationComment(contractText, parser);
      if (!headerContext) {
        throw new Error(
          `${contractDisplayPath}: missing @packageDocumentation module header; cannot read contract tags.`
        );
      }

      const rawReportPath = path.join(apiReportFolder, `${flatName}.api.md`);
      if (!fs.existsSync(rawReportPath)) {
        throw new Error(`${moduleId}: API Extractor did not write ${displayPath(rawReportPath)}.`);
      }
      const docModelPath = path.join(docModelFolder, `${flatName}.api.json`);
      if (!fs.existsSync(docModelPath)) {
        throw new Error(`${moduleId}: API Extractor did not write the doc model.`);
      }

      const docModel = JSON.parse(fs.readFileSync(docModelPath, 'utf-8'));
      const entryPoint = (docModel.members || []).find(member => member.kind === 'EntryPoint');
      if (!entryPoint) {
        throw new Error(`${moduleId}: doc model has no EntryPoint member.`);
      }

      if (result.errorCount > 0) {
        const errorText = messages
          .filter(message => message.logLevel === 'error')
          .map(message => `${message.messageId}: ${message.text}`)
          .join('\n  ');
        throw new Error(`${moduleId}: API Extractor reported ${result.errorCount} error(s):\n  ${errorText}`);
      }

      const rawReportText = normalizeTempPaths(
        fs.readFileSync(rawReportPath, 'utf-8').replace(/\r\n/g, '\n'),
        tempRoot
      );
      const reportContent = renderModuleReport(
        {
          moduleId,
          contractDisplayPath,
          headerContext,
          entryPoint,
          reportText: rawReportText,
          messages
        },
        parser
      );

      const messageSummary = summarizeMessages(messages, rawReportText);
      const coverage = computeCoverage(entryPoint, parser);
      if (coverage.undocumented > 0) {
        coverageViolations.push({
          module: moduleId,
          declarations: coverage.declarations,
          undocumented: coverage.undocumented,
          aeUndocumented: messageSummary.counts['ae-undocumented'] || 0
        });
      }
      generated.set(`${moduleId}.api.md`, reportContent);
      moduleResults.push({
        module: moduleId,
        report: `${REPORTS_ROOT_DISPLAY}/${moduleId}.api.md`,
        exports: coverage.exports,
        declarations: coverage.declarations,
        documented: coverage.documented,
        undocumented: coverage.undocumented,
        warnings: messageSummary.counts
      });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  generated.set(
    INDEX_FILE_NAME,
    renderIndex(
      modules.map(module => ({
        moduleId: module.moduleId,
        contractDisplayPath: module.contractDisplayPath
      }))
    )
  );

  return {
    generated,
    moduleResults,
    coverageViolations,
    extractionMs: Date.now() - extractionStartedAt
  };
}

/**
 * Aggregates per-module coverage counters into the `--json` summary and human output.
 *
 * @param {object[]} moduleResults
 * @returns {{ modules: number, declarations: number, documented: number, undocumented: number, modulesBelow100: number }}
 */
function summarizeCoverage(moduleResults) {
  const totals = { modules: moduleResults.length, declarations: 0, documented: 0, undocumented: 0, modulesBelow100: 0 };
  for (const moduleResult of moduleResults) {
    totals.declarations += moduleResult.declarations;
    totals.documented += moduleResult.documented;
    totals.undocumented += moduleResult.undocumented;
    if (moduleResult.undocumented > 0) totals.modulesBelow100 += 1;
  }
  return totals;
}

/**
 * Writes every generated file under the reports root.
 *
 * @param {Map<string, string>} generated
 */
function writeReports(generated) {
  for (const [relativePath, content] of generated) {
    const target = path.join(REPORTS_ROOT, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    log(`  wrote ${displayPath(target)}`);
  }
}

/**
 * Entry point.
 */
function main() {
  const startedAt = Date.now();
  let failed = false;
  let generated;
  let moduleResults;
  let coverageViolations;
  let extractionMs;
  let diffs = [];

  try {
    ({ generated, moduleResults, coverageViolations, extractionMs } = generateAll());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const warnings = {};
  for (const moduleResult of moduleResults) {
    for (const [id, count] of Object.entries(moduleResult.warnings)) {
      warnings[id] = (warnings[id] || 0) + count;
    }
  }

  const docCoverage = summarizeCoverage(moduleResults);
  if (coverageViolations.length > 0) {
    const durationMs = Date.now() - startedAt;
    const detail = coverageViolations
      .map(
        violation =>
          `  ${violation.module}: ${violation.undocumented} undocumented of ${violation.declarations} ` +
          `declaration(s) (ae-undocumented=${violation.aeUndocumented})`
      )
      .join('\n');
    if (jsonOutput) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'api-reports',
            mode,
            passed: false,
            modules: moduleResults.length,
            reportsRoot: REPORTS_ROOT_DISPLAY,
            extractionMs,
            durationMs,
            docCoverage,
            coverageViolations,
            warnings,
            diffs: [],
            error: 'doc-coverage assertion failed'
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stderr.write(
        `Doc-coverage assertion failed: ${docCoverage.undocumented} undocumented declaration(s) across ` +
          `${coverageViolations.length} of ${moduleResults.length} module(s). Every declaration in the ` +
          'generated reports must carry a TSDoc summary (README §9; `ae-undocumented` policy `error`).\n' +
          `${detail}\n`
      );
    }
    process.exit(1);
  }

  if (mode === 'write') {
    writeReports(generated);
  } else {
    const diffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-reports-diff-'));
    try {
      diffs = compareTrees(generated, REPORTS_ROOT, diffDir);
      if (diffs.length > 0) failed = true;

      const durationMs = Date.now() - startedAt;

      if (jsonOutput) {
        process.stdout.write(
          `${JSON.stringify(
            {
              tool: 'api-reports',
              mode,
              passed: !failed,
              modules: moduleResults.length,
              reportsRoot: REPORTS_ROOT_DISPLAY,
              extractionMs,
              durationMs,
              docCoverage,
              warnings,
              diffs: diffs.map(diff => ({ status: diff.status, path: diff.path })),
              reports: moduleResults
            },
            null,
            2
          )}\n`
        );
      } else {
        log(
          `Generated ICD pipeline — mode=${mode} | modules=${moduleResults.length} | reports=${REPORTS_ROOT_DISPLAY}`
        );
        const warningSummary = Object.entries(warnings)
          .map(([id, count]) => `${id}=${count}`)
          .join(', ');
        log(
          `Extraction: ${extractionMs}ms | Total: ${durationMs}ms | Warnings: ${warningSummary || 'none'}`
        );
        log(
          `Coverage: ${docCoverage.documented}/${docCoverage.declarations} declaration(s) documented | ` +
            `modules below 100%: ${docCoverage.modulesBelow100}`
        );

        if (diffs.length === 0) {
          log(`${moduleResults.length} report(s) byte-identical to ${REPORTS_ROOT_DISPLAY}.`);
        } else {
          log('');
          log(`DRIFT (${diffs.length} file(s) differ from ${REPORTS_ROOT_DISPLAY}):`);
          for (const diff of diffs) log(`  [${diff.status}] ${diff.path}`);
          log('');
          for (const diff of diffs.slice(0, MAX_DIFF_FILES)) {
            if (diff.status === 'extra') {
              log(`--- ${diff.path} (tracked but not generated)`);
              continue;
            }
            log(`--- ${diff.path}`);
            log(unifiedDiff(diff.trackedPath, diff.generatedPath, diff.path));
          }
          if (diffs.length > MAX_DIFF_FILES) {
            log(`... (${diffs.length - MAX_DIFF_FILES} more differing file(s) not shown)`);
          }
          log('');
          log('Run `npm run api:reports` to regenerate the tracked reports.');
        }

        log('');
        log(
          `Result: ${failed ? 'FAIL' : 'PASS'} — ${moduleResults.length} module(s), ` +
            `${Object.values(warnings).reduce((sum, count) => sum + count, 0)} warning(s), ` +
            `${diffs.length} drift(s), ${durationMs}ms`
        );
      }
    } finally {
      fs.rmSync(diffDir, { recursive: true, force: true });
    }
    process.exit(failed ? 1 : 0);
  }

  const durationMs = Date.now() - startedAt;

  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'api-reports',
          mode,
          passed: !failed,
          modules: moduleResults.length,
          reportsRoot: REPORTS_ROOT_DISPLAY,
          extractionMs,
          durationMs,
          docCoverage,
          warnings,
          diffs: [],
          reports: moduleResults
        },
        null,
        2
      )}\n`
    );
  } else {
    log(`Generated ICD pipeline — mode=${mode} | modules=${moduleResults.length} | reports=${REPORTS_ROOT_DISPLAY}`);
    log(`Extraction: ${extractionMs}ms | Total: ${durationMs}ms`);
    log(
      `Coverage: ${docCoverage.documented}/${docCoverage.declarations} declaration(s) documented | ` +
        `modules below 100%: ${docCoverage.modulesBelow100}`
    );
    log(`Wrote ${generated.size} file(s) under ${REPORTS_ROOT_DISPLAY}.`);
    log('');
    log(
      `Result: ${failed ? 'FAIL' : 'PASS'} — ${moduleResults.length} module(s), ` +
        `${Object.values(warnings).reduce((sum, count) => sum + count, 0)} warning(s), ` +
        `0 drift(s), ${durationMs}ms`
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
