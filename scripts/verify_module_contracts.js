#!/usr/bin/env node
/**
 * @file scripts/verify_module_contracts.js
 * @description Module-contract (ICD) dual-mode validator over either the legacy flat `.d.ts`
 * header corpus or the TS rewrite's module-folder surfaces (`<module>/index.ts`, store:
 * `index.svelte.ts`): Tier 1 per-file checks plus Tier 2 resolved-graph cross-checks.
 *
 * Modes
 * -----
 * - **flat** (zero module-surface `.ts` under the contracts root): discovers `.d.ts` files and
 *   expects the explicit 30-contract set — the pre-rewrite behavior, unchanged.
 * - **folders** (any `index.ts`/`index.svelte.ts` surface): discovers those surfaces (plus legacy
 *   `.d.ts` files not yet superseded by their `.ts` twin), derives contract identity from the
 *   folder path, and expects the 35-module promoted set (the promoted `tools/` surfaces, the
 *   `runtime/messageHygiene` module, the `presetCatalog` and `realmRegistry` modules, and the
 *   `inference/index`/`runtime/index` facades renamed to their folder identities). Legacy `.d.ts`
 *   facades may still carry their `/index` spelling until converted.
 *
 * Tier 1 (docs/modules/README.md §5):
 *  1. Coverage / vacuity  — the mode's explicit expected set must match the discovered contracts.
 *  2. Identity            — exactly one @module per header; value equals the contract path with
 *                           the full contract extension stripped (`.d.ts`, `.svelte.d.ts`) in flat
 *                           mode, or the contract-relative folder path in folder mode.
 *  3. One physical line   — custom tags must not wrap their values across lines.
 *  4. Boundary syntax     — @mayImport/@mustNotImport: optional `type-only ` prefix, then a
 *                           non-empty, whitespace-free spec (`\@` unescaped before validation).
 *  5. Ref durability      — the trailing ` | ref <ref>` on @decision tags is optional (refs are
 *                           stripped from the public tree); a present ref is valid when
 *                           `git cat-file -e <ref>^{commit}` resolves or when it prefix-matches a
 *                           real `refs/bugs/<64-hex>` ref. HEAD, branch names and relative refs are
 *                           rejected. The corpus-compatible `commit <hash>` prefix form is accepted
 *                           and the hash is validated. A ref-less @decision is valid; a present ref
 *                           is always validated. Resolutions are memoized for the whole run, and a
 *                           failed ref-enumeration probe is retried with a bounded jittered backoff
 *                           (defect 20a885f: ticket resolution must not depend on the git-bug
 *                           selection store).
 *  6. Text hygiene        — no defect/QA ids, dates, status words, or global-rule phrasing inside
 *                           custom-tag text.
 *  7. Id uniqueness       — optional @invariant/@decision ids are unique per file.
 *
 * Tier 2 (docs/modules/README.md §6, actual graph cross-checks):
 *  8. @mayImport truth    — every tagged spec has at least one actual edge from the contract's
 *                           paired graph nodes (sibling implementation plus the declaration file
 *                           itself, where the `type-only` edges live).
 *  9. @mustNotImport truth — zero actual edges match a tagged ban (catches inverted/wrong bans).
 * 10. Exception parity    — the out-of-sandbox @mayImport pair set equals the tracked exceptions
 *                           exported by `.dependency-cruiser.cjs` (`config.TRACKED_SANDBOX_EXCEPTIONS`;
 *                           an empty array is a valid expected set that requires zero
 *                           `sandbox-outside-import-tracked-*`/`sandbox-no-outside-imports-*` rules
 *                           and still fails any out-of-sandbox tag). When the export is absent the
 *                           set is derived from the generated tracked rules (fail-closed on an
 *                           empty scan). Drift in either direction fails.
 * 11. Untagged boundary   — sandbox edges leaving `src/lib/sandbox/` with no matching @mayImport
 *                           tag fail; untagged intra-sandbox edges are allowed (global rule).
 *
 * Graph build: dependency-cruiser with the repo config, plus two scope flags documented next to
 * DEPCRUISE_EXTRA_ARGS below. The repo's own `gate:arch` cruise stays untouched. If depcruise
 * cannot run or emits unparseable JSON the validator fails with the output tail.
 *
 * Matching semantics: specs are relative to the contract's directory; a trailing `/*` matches the
 * whole base directory; the `type-only ` prefix is stripped before matching and type-only edges
 * count as edges; `\@` is unescaped. Relative specs match a resolved target or the literal graph
 * specifier; bare specs match the dependency's module name (`buffer`, `fast-json-patch`,
 * `\@premai/...`).
 *
 * Tag extraction uses @microsoft/tsdoc + @microsoft/tsdoc-config (no regex tag scraping). Only the
 * @packageDocumentation module header is inspected; member-level @invariant/@internal are allowed
 * and intentionally ignored by this validator.
 *
 * Test hooks: `--contracts-root <path>` points the scan at an alternate contract tree and
 * `--tier1-only` skips the Tier 2 graph cross-checks (which always run over the repository graph).
 * Both exist for synthetic fixture and negative-control proofs only; the gate chain never passes
 * either flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  DocCodeSpan,
  DocEscapedText,
  DocLinkTag,
  DocParagraph,
  DocPlainText,
  DocSection,
  DocSoftBreak,
  TSDocConfiguration,
  TSDocParser
} from '@microsoft/tsdoc';
import { TSDocConfigFile } from '@microsoft/tsdoc-config';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_CONTRACTS_ROOT = path.join(PROJECT_ROOT, 'src/lib/sandbox');
const EXPECTED_MODULES = [
  'credentialVault',
  'domain/directorAgent',
  'fsDownloadUtils',
  'inference/createProvider',
  'inference/DeepSeekProvider',
  'inference/index',
  'inference/NanoGptProvider',
  'inference/OpenAIProvider',
  'inference/PremProvider',
  'inference/ProviderInterface',
  'inference/retry',
  'inference/RunwareProvider',
  'invocationEngine',
  'messagingBus',
  'modelConfig',
  'runtime/agent',
  'runtime/agentLifecycle',
  'runtime/historyManager',
  'runtime/index',
  'runtime/runtimeScheduler',
  'runtime/runtimeTelemetry',
  'runtime/triggerDispatcher',
  'runtime/turnExecutionEngine',
  'sandboxPersistence',
  'sandboxStore',
  'toolDefinitions',
  'tools/constants',
  'triggerQueue',
  'virtualFs',
  'worldClock'
];

/**
 * Folder-mode expected set (TS port): the 30 flat contracts
 * plus the promoted `tools/descriptors`, `tools/normalizers`, and `runtime/messageHygiene`
 * surfaces and the `presetCatalog`/`realmCatalog`/`realmRegistry` modules, with the `inference/index`
 * and `runtime/index` facades renamed to their folder identities. Selected whenever any module-surface
 * `.ts` file exists under the contracts root.
 */
const EXPECTED_MODULES_FOLDERS = [
  'credentialVault',
  'domain/directorAgent',
  'fsDownloadUtils',
  'inference',
  'inference/createProvider',
  'inference/DeepSeekProvider',
  'inference/NanoGptProvider',
  'inference/OpenAIProvider',
  'inference/PremProvider',
  'inference/ProviderInterface',
  'inference/retry',
  'inference/RunwareProvider',
  'invocationEngine',
  'messagingBus',
  'modelConfig',
  'presetCatalog',
  'realmCatalog',
  'realmRegistry',
  'runtime',
  'runtime/agent',
  'runtime/agentLifecycle',
  'runtime/historyManager',
  'runtime/messageHygiene',
  'runtime/runtimeScheduler',
  'runtime/runtimeTelemetry',
  'runtime/triggerDispatcher',
  'runtime/turnExecutionEngine',
  'sandboxPersistence',
  'sandboxStore',
  'toolDefinitions',
  'tools/constants',
  'tools/descriptors',
  'tools/normalizers',
  'triggerQueue',
  'virtualFs',
  'worldClock'
];

const MODE_FLAT = 'flat';
const MODE_FOLDERS = 'folders';
const TIER2_CHECK_IDS = new Set([
  'graph-build',
  'may-import-truth',
  'must-not-import-truth',
  'exception-parity',
  'untagged-boundary'
]);

const MODULE_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\/[a-zA-Z][a-zA-Z0-9]*)*$/;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const CUSTOM_TAGS = new Set(['@module', '@mayImport', '@mustNotImport', '@invariant', '@decision']);
const BOUNDARY_TAGS = new Set(['@mayImport', '@mustNotImport']);

const SANDBOX_REPO_PREFIX = 'src/lib/sandbox/';
const DEPCRUISE_TIMEOUT_MS = 60000;

/**
 * Ticket-ref resolution hardening (defect 20a885f). The former probe treated the exit code of
 * `git bug bug show <ref>` as proof of existence, but git-bug silently falls back to the
 * currently selected bug for an unresolvable id and still exits 0, so arbitrary hex refs passed
 * the durability check. The probe now enumerates `refs/bugs` with plain git and prefix-matches the
 * ref against the full 64-hex refnames, which is selection-independent and never touches the
 * git-bug store. A failed or killed `git for-each-ref` is reported as transient and retried with a
 * bounded jittered backoff (one delay per entry; one initial attempt + two retries).
 */
const TICKET_REF_NAMESPACE = 'refs/bugs/';
const GIT_BUG_RETRY_DELAYS_MS = [150, 350];
const GIT_BUG_RETRY_JITTER_MS = 150;
const GIT_BUG_PROBE_TIMEOUT_MS = 10000;

/**
 * Tier 2 graph-build flags layered on top of the repo config (the `gate:arch` cruise itself is
 * unchanged):
 * - `--ts-pre-compilation-deps`: type-only edges (`import type` / `export type`) live only in the
 *   `.d.ts` declarations; without this flag every `type-only` tag spec is invisible to the graph.
 * - `--exclude` re-states the repo exclude minus `dist`: the repo pattern also hides npm packages
 *   that resolve under a `node_modules/.../dist/` path (e.g. `jsonpath-plus`), which would make a
 *   tagged real import unresolvable. This only widens the graph for target resolution; rule
 *   evaluation below keeps the repo semantics (out-of-sandbox = repo `src/` paths).
 */
const DEPCRUISE_EXTRA_ARGS = [
  '--ts-pre-compilation-deps',
  '--exclude',
  '(^|/)(test-results|docs|\\.playwright|\\.git)(/|$)'
];

const TRACKED_EXCEPTION_RULE_PATTERN = /^sandbox-outside-import-tracked-(.+)$/;
const PAIR_PRECISE_RULE_PATTERN = /^sandbox-no-outside-imports-(.+)$/;

const HYGIENE_PATTERNS = [
  { id: 'defect-id', pattern: /BUG-ENC-\d+/ },
  { id: 'qa-id', pattern: /QA-\d+/ },
  { id: 'date', pattern: /\d{4}-\d{2}-\d{2}/ },
  { id: 'status-word', pattern: /\b(DRAFT|INTERIM|PROPOSED|PLANNED)\b/ },
  {
    id: 'global-rule',
    pattern: /\bdep-cruiser\b|\boutside-sandbox\b|\bmay import only\b|\bverifier\b/i
  }
];

const CHECKS = [
  { id: 'coverage', label: 'Coverage / vacuity' },
  { id: 'identity', label: 'Identity (@module)' },
  { id: 'tag-line', label: 'One physical line per tag' },
  { id: 'boundary-syntax', label: 'Boundary syntax' },
  { id: 'decision-ref', label: 'Decision refs (optional)' },
  { id: 'hygiene', label: 'Text hygiene' },
  { id: 'id-uniqueness', label: 'Id uniqueness' },
  { id: 'syntax', label: 'TSDoc parse errors' },
  { id: 'graph-build', label: 'Tier 2 graph build' },
  { id: 'may-import-truth', label: 'Tier 2 @mayImport truth' },
  { id: 'must-not-import-truth', label: 'Tier 2 @mustNotImport truth' },
  { id: 'exception-parity', label: 'Tier 2 exception parity' },
  { id: 'untagged-boundary', label: 'Tier 2 untagged boundary' }
];

const argv = process.argv.slice(2);
let jsonOutput = false;
let tier1Only = false;
let contractsRootArg = null;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--tier1-only') {
    tier1Only = true;
  } else if (arg === '--contracts-root') {
    contractsRootArg = argv[i + 1] || null;
    i += 1;
  } else if (arg.startsWith('--contracts-root=')) {
    contractsRootArg = arg.slice('--contracts-root='.length);
  } else {
    process.stderr.write(
      `Unknown argument '${arg}'. Usage: node scripts/verify_module_contracts.js [--json] [--tier1-only] [--contracts-root <path>]\n`
    );
    process.exit(2);
  }
}

const CONTRACTS_ROOT = contractsRootArg
  ? path.resolve(PROJECT_ROOT, contractsRootArg)
  : DEFAULT_CONTRACTS_ROOT;

/**
 * Human-report sink. Silenced under --json so stdout stays machine-parseable.
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
 * True when a path names a module surface in the TS rewrite layout (`index.ts`,
 * `index.svelte.ts`, or the same at the contracts root).
 *
 * @param {string} relPath contract-relative or bare file name
 * @returns {boolean}
 */
function isTsSurfacePath(relPath) {
  return (
    relPath === 'index.ts' ||
    relPath === 'index.svelte.ts' ||
    /\/index(?:\.svelte)?\.ts$/.test(relPath)
  );
}

/**
 * Returns a file's path relative to the contracts root in posix form.
 *
 * @param {string} filePath
 * @returns {string}
 */
function contractsRelPath(filePath) {
  return path.relative(CONTRACTS_ROOT, filePath).split(path.sep).join('/');
}

/**
 * Recursively discovers contract files under a root, sorted deterministically. Flat mode (zero
 * module-surface `.ts`) discovers `.d.ts` files only; folder mode discovers `index.ts` /
 * `index.svelte.ts` surfaces, plus legacy `.d.ts` files whose canonical module id has no `.ts`
 * surface yet (a superseded `.d.ts` twin is reported instead of discovered).
 *
 * @param {string} root
 * @returns {{ files: string[], mode: 'flat'|'folders', supersededDts: string[] }}
 */
function discoverContractFiles(root) {
  const dtsFiles = [];
  const tsFiles = [];
  if (!fs.existsSync(root)) return { files: [], mode: MODE_FLAT, supersededDts: [] };

  const scan = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith('.d.ts')) dtsFiles.push(full);
      else if (isTsSurfacePath(entry.name)) tsFiles.push(full);
    }
  };

  scan(root);

  if (tsFiles.length === 0) {
    return {
      files: dtsFiles.sort((a, b) => a.localeCompare(b)),
      mode: MODE_FLAT,
      supersededDts: []
    };
  }

  const tsModuleIds = new Set(
    tsFiles.map(file => moduleIdFromRelPath(contractsRelPath(file), MODE_FOLDERS))
  );
  const supersededDts = dtsFiles.filter(file =>
    tsModuleIds.has(moduleIdFromRelPath(contractsRelPath(file), MODE_FOLDERS))
  );
  const supersededPaths = new Set(supersededDts);
  const files = [...tsFiles, ...dtsFiles.filter(file => !supersededPaths.has(file))].sort((a, b) =>
    a.localeCompare(b)
  );
  return { files, mode: MODE_FOLDERS, supersededDts };
}

/**
 * Maps a contract path (relative to the contracts root) to its module id.
 *
 * Folder mode: a `.ts` surface maps to its folder path (`runtime/agent/index.ts` ->
 * `runtime/agent`, `runtime/index.ts` -> `runtime`); a legacy `.d.ts` maps to the same folder
 * identity (`runtime/index.d.ts` -> `runtime`). Flat mode (and folder-mode flat contracts):
 * the full contract extension is stripped (`.svelte.d.ts` entirely, then `.d.ts`/`.ts`).
 *
 * @param {string} relPath
 * @param {'flat'|'folders'} mode
 * @returns {string}
 */
function moduleIdFromRelPath(relPath, mode) {
  if (isTsSurfacePath(relPath)) {
    const dir = path.posix.dirname(relPath);
    return dir === '.' ? '' : dir;
  }
  const legacy = relPath.replace(/\.svelte\.d\.ts$/, '').replace(/\.d\.ts$/, '');
  if (mode === MODE_FOLDERS && legacy.endsWith('/index')) return legacy.slice(0, -'/index'.length);
  return legacy;
}

/**
 * Builds a TSDoc parser configured from the repo `tsdoc.json`.
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
 * `@packageDocumentation` modifier tag.
 *
 * @param {string} text full file text
 * @param {TSDocParser} parser
 * @returns {{ start: number, end: number, context: import('@microsoft/tsdoc').ParserContext }|null}
 */
function findPackageDocumentationComment(text, parser) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let token = scanner.scan();

  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      const candidate = text.slice(start, end);
      if (candidate.startsWith('/**')) {
        const context = parser.parseString(candidate);
        const isHeader = context.docComment.modifierTagSet.nodes.some(
          node => node.tagName === '@packageDocumentation'
        );
        if (isHeader) return { start, end, context };
      }
    }
    token = scanner.scan();
  }

  return null;
}

/**
 * Precomputes 1-based line start offsets for a text buffer.
 *
 * @param {string} text
 * @returns {number[]}
 */
function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * Resolves a buffer position to a 1-based line number.
 *
 * @param {number[]} lineStarts
 * @param {number} position
 * @returns {number}
 */
function lineForPosition(lineStarts, position) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Recursively flattens TSDoc content nodes to plain text. Escaped text is decoded
 * (`\@` -> `@`), code spans keep their code, and soft breaks become `\n` so callers
 * can detect wrapped tag values.
 *
 * @param {ReadonlyArray<import('@microsoft/tsdoc').DocNode>} nodes
 * @returns {string}
 */
function flattenDocText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node instanceof DocPlainText) {
      out += node.text;
    } else if (node instanceof DocEscapedText) {
      out += node.decodedText;
    } else if (node instanceof DocCodeSpan) {
      out += node.code;
    } else if (node instanceof DocSoftBreak) {
      out += '\n';
    } else if (node instanceof DocParagraph || node instanceof DocSection) {
      out += flattenDocText(node.getChildNodes());
    } else if (node instanceof DocLinkTag) {
      out += node.linkText || (node.codeDestination ? node.codeDestination.toString() : '');
    }
  }
  return out;
}

/**
 * Synchronously sleeps without busy-waiting so the synchronous ref-resolution path can back off
 * before retrying a lock-contended git-bug store read.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Probes the local git ref store for one ticket id. Enumerates `refs/bugs` and reports a match
 * when a full refname begins with `refs/bugs/<ref>` (7-40 hex prefixes; defect 20a885f — never
 * consults `git bug bug show`, whose selection fallback accepted arbitrary hex). A failed/killed
 * probe is reported as transient so the caller may retry.
 *
 * @param {string} ref
 * @returns {{ resolved: boolean, transient: boolean }}
 */
function probeGitBugTicket(ref) {
  const result = spawnSync('git', ['for-each-ref', '--format=%(refname)', TICKET_REF_NAMESPACE], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_BUG_PROBE_TIMEOUT_MS
  });
  if (result.error) return { resolved: false, transient: true };
  if (result.status !== 0) return { resolved: false, transient: false };
  const output = typeof result.stdout === 'string' ? result.stdout : '';
  const prefix = `${TICKET_REF_NAMESPACE}${ref}`;
  const resolved = output.split('\n').some(line => line.startsWith(prefix));
  return { resolved, transient: false };
}

/**
 * Reports whether `ref` names a real local git-bug ticket. Exported as the ticket-resolution
 * predicate so the audit repro can exercise it directly.
 *
 * @param {string} ref
 * @returns {boolean}
 */
export function isResolvableTicketRef(ref) {
  return probeGitBugTicket(ref).resolved;
}

/**
 * Resolves a ticket-shaped ref against the local git-bug store, memoized per validator run. A
 * lookup that fails on lock contention (a concurrent validator/audit process holds the git-bug
 * repository lock) is retried with a bounded jittered backoff; any other failure — and a final
 * contention failure — resolves as missing.
 *
 * @param {string} ref
 * @param {Map<string, boolean>} ticketCache
 * @returns {boolean}
 */
function resolveTicketRef(ref, ticketCache) {
  if (!ticketCache.has(ref)) {
    let resolved = false;
    for (let attempt = 0; attempt <= GIT_BUG_RETRY_DELAYS_MS.length; attempt += 1) {
      const probe = probeGitBugTicket(ref);
      if (probe.resolved) {
        resolved = true;
        break;
      }
      if (!probe.transient || attempt === GIT_BUG_RETRY_DELAYS_MS.length) break;
      const jitter = Math.floor(Math.random() * GIT_BUG_RETRY_JITTER_MS);
      sleepSync(GIT_BUG_RETRY_DELAYS_MS[attempt] + jitter);
    }
    ticketCache.set(ref, resolved);
  }
  return ticketCache.get(ref);
}

/**
 * Resolves a single durable ref: a commit hash or a local git-bug ticket id. Commit resolution
 * wins when a ticket id and a commit prefix collide; ticket resolution is the fallback for
 * hex-like ids that are not commits, matching `refs/bugs/<ref>` prefixes so it does not depend on
 * the git-bug selection store (defect 20a885f). Doc paths are not durable: the retired
 * encapsulation workspace no longer hosts decision anchors, so only commits and tickets resolve.
 * Both caches are run-scoped, so every unique ref hits the git stores at most once per run.
 *
 * @param {string} ref
 * @param {Map<string, boolean>} commitCache
 * @param {Map<string, boolean>} ticketCache
 * @returns {{ kind: 'commit'|'ticket'|null, message: string|null }} resolution kind and
 *   violation message (null when valid)
 */
function resolveDurableRef(ref, commitCache, ticketCache) {
  if (!ref) return { kind: null, message: 'durable ref is empty' };

  if (ref.toUpperCase() === 'HEAD' || ref.startsWith('refs/') || /[\^~@:]|\.\./.test(ref)) {
    return {
      kind: null,
      message: `ref '${ref}' is a HEAD/branch/relative ref; only commit hashes and local git-bug ticket ids are durable`
    };
  }

  if (COMMIT_HASH_PATTERN.test(ref)) {
    if (!commitCache.has(ref)) {
      const result = spawnSync('git', ['-C', PROJECT_ROOT, 'cat-file', '-e', `${ref}^{commit}`], {
        stdio: 'ignore'
      });
      commitCache.set(ref, result.status === 0);
    }
    if (commitCache.get(ref)) return { kind: 'commit', message: null };

    if (resolveTicketRef(ref, ticketCache)) return { kind: 'ticket', message: null };

    return {
      kind: null,
      message: `ref '${ref}' resolves neither as a commit ('git cat-file -e ${ref}^{commit}') nor as a local git-bug ticket ('refs/bugs/${ref}')`
    };
  }

  return {
    kind: null,
    message: `ref '${ref}' is not a durable ref: expected a commit hash ('git cat-file -e ${ref}^{commit}') or a local git-bug ticket id ('refs/bugs/${ref}'); doc paths are not accepted`
  };
}

/**
 * Extracts the optional invariant id (leading `ID:` token in the corpus).
 *
 * @param {string} value
 * @returns {string|null}
 */
function extractInvariantId(value) {
  const match = /^([A-Z][A-Z0-9-]*):/.exec(value);
  return match ? match[1] : null;
}

/**
 * Extracts the optional decision id (leading digit-bearing `ID` token in the corpus,
 * e.g. `R8 (3C-D): ...` or `D1=A: ...`; ordinary capitalized words are not ids).
 *
 * @param {string} value
 * @returns {string|null}
 */
function extractDecisionId(value) {
  const firstToken = value.split(/\s+/)[0] || '';
  const match = /^([A-Z][A-Z0-9-]*\d)/.exec(firstToken);
  return match ? match[1] : null;
}

/**
 * Validates one contract file's module header and collects the contract facts Tier 2 needs.
 *
 * @param {TSDocParser} parser
 * @param {string} filePath
 * @param {'flat'|'folders'} mode
 * @param {{ commitCache: Map<string, boolean>, ticketCache: Map<string, boolean> }} refCaches
 *   run-scoped durable-ref resolution caches shared across every contract file
 * @returns {{ violations: Array<object>, warnings: Array<object>, stats: object, contract: object }}
 */
function validateContractFile(parser, filePath, mode, refCaches) {
  const violations = [];
  const warnings = [];
  const stats = { tags: {}, refs: 0, commitRefs: 0, ticketRefs: 0 };
  const display = displayPath(filePath);
  const text = fs.readFileSync(filePath, 'utf-8');
  const relToRoot = contractsRelPath(filePath);
  const expectedModuleId = moduleIdFromRelPath(relToRoot, mode);
  const acceptedModuleIds = [expectedModuleId];
  if (mode === MODE_FOLDERS && !isTsSurfacePath(relToRoot)) {
    const legacyModuleId = relToRoot.replace(/\.svelte\.d\.ts$/, '').replace(/\.d\.ts$/, '');
    if (!acceptedModuleIds.includes(legacyModuleId)) acceptedModuleIds.push(legacyModuleId);
  }
  const contractBase = relToRoot.replace(/\.d\.ts$/, '').replace(/\.ts$/, '');
  const contract = {
    display,
    filePath,
    moduleId: expectedModuleId,
    contractBase,
    dirRel: path.posix.dirname(contractBase),
    mayImport: [],
    mustNotImport: [],
    graphModules: []
  };

  const header = findPackageDocumentationComment(text, parser);
  if (!header) {
    violations.push({
      check: 'identity',
      file: display,
      line: 1,
      message: 'missing @packageDocumentation module header; contract tags cannot be read'
    });
    return { violations, warnings, stats, contract };
  }

  const lineStarts = buildLineStarts(text);
  const headerContext = header.context;

  for (const message of headerContext.log.messages) {
    const line = lineForPosition(lineStarts, header.start + message.textRange.pos);
    violations.push({
      check: 'syntax',
      file: display,
      line,
      message: `${message.messageId}: ${message.unformattedText}`
    });
  }

  const moduleBlocks = [];
  const fileIds = new Map();

  for (const block of headerContext.docComment.customBlocks) {
    const tagName = block.blockTag.tagName;
    if (!CUSTOM_TAGS.has(tagName)) continue;

    stats.tags[tagName] = (stats.tags[tagName] || 0) + 1;

    const rawPosition = block.blockTag.getTokenSequence().getContainingTextRange().pos;
    const line = lineForPosition(lineStarts, header.start + rawPosition);
    const rawText = flattenDocText(block.content.getChildNodes());
    const unwrapped = rawText.replace(/\n+$/, '');
    const wrapped = unwrapped.includes('\n');
    const value = rawText.replace(/\s+/g, ' ').trim();

    if (wrapped) {
      violations.push({
        check: 'tag-line',
        file: display,
        line,
        tag: tagName,
        message: `${tagName} value wraps across physical lines; keep each custom tag on one line`
      });
    }

    if (tagName === '@module') {
      moduleBlocks.push({ value, line });
      continue;
    }

    if (BOUNDARY_TAGS.has(tagName)) {
      let spec = value;
      if (spec.startsWith('type-only ')) spec = spec.slice('type-only '.length);
      else if (spec === 'type-only') spec = '';
      spec = spec.replace(/\\@/g, '@');

      if (spec.length === 0) {
        violations.push({
          check: 'boundary-syntax',
          file: display,
          line,
          tag: tagName,
          message: `${tagName} has an empty import spec`
        });
      } else if (/\s/.test(spec)) {
        violations.push({
          check: 'boundary-syntax',
          file: display,
          line,
          tag: tagName,
          message: `${tagName} import spec '${spec}' contains whitespace`
        });
      } else {
        const target = tagName === '@mayImport' ? contract.mayImport : contract.mustNotImport;
        target.push({ spec, line });
      }
    }

    if (tagName === '@decision') {
      // The trailing ` | ref <ref>` is optional (the public tree strips provenance); a present
      // ref is validated for durability exactly as before, a ref-less tag is accepted as-is.
      const refMatch = value.match(/\s\|\s+ref\s+(.+?)\s*$/);
      if (refMatch) {
        let ref = refMatch[1].trim();
        if (/^commit\s+/i.test(ref)) ref = ref.replace(/^commit\s+/i, '').trim();
        stats.refs += 1;
        const refResolution = resolveDurableRef(ref, refCaches.commitCache, refCaches.ticketCache);
        if (refResolution.kind === 'commit') stats.commitRefs += 1;
        else if (refResolution.kind === 'ticket') stats.ticketRefs += 1;
        if (refResolution.message) {
          violations.push({
            check: 'decision-ref',
            file: display,
            line,
            tag: '@decision',
            message: refResolution.message
          });
        }
      }
    }

    for (const { id, pattern } of HYGIENE_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({
          check: 'hygiene',
          file: display,
          line,
          tag: tagName,
          message: `${tagName} text violates '${id}' hygiene: ${value.slice(0, 120)}`
        });
      }
    }

    let id = null;
    if (tagName === '@invariant') id = extractInvariantId(value);
    else if (tagName === '@decision') id = extractDecisionId(value);
    if (id) {
      const key = id;
      if (fileIds.has(key)) {
        const first = fileIds.get(key);
        violations.push({
          check: 'id-uniqueness',
          file: display,
          line,
          tag: tagName,
          message: `duplicate id '${id}' (first used at line ${first.line} by ${first.tag})`
        });
      } else {
        fileIds.set(key, { line, tag: tagName });
      }
    }
  }

  if (moduleBlocks.length !== 1) {
    const firstLine = moduleBlocks.length > 0 ? moduleBlocks[0].line : 1;
    violations.push({
      check: 'identity',
      file: display,
      line: firstLine,
      message: `found ${moduleBlocks.length} @module tag(s); exactly one is required`
    });
  } else {
    const { value, line } = moduleBlocks[0];
    if (!acceptedModuleIds.includes(value)) {
      violations.push({
        check: 'identity',
        file: display,
        line,
        tag: '@module',
        message: `@module '${value}' does not match the contract path '${expectedModuleId}'`
      });
    }
    if (!MODULE_ID_PATTERN.test(value)) {
      violations.push({
        check: 'identity',
        file: display,
        line,
        tag: '@module',
        message: `@module '${value}' does not satisfy the identity grammar`
      });
    }
  }

  return { violations, warnings, stats, contract };
}

/**
 * Runs coverage/vacuity validation against the mode's explicit expected set.
 *
 * @param {string[]} files discovered absolute contract files
 * @param {string[]} expectedModules expected module ids for the active mode
 * @param {'flat'|'folders'} mode
 * @returns {Array<object>}
 */
function verifyCoverage(files, expectedModules, mode) {
  const violations = [];
  const discovered = files.map(file => moduleIdFromRelPath(contractsRelPath(file), mode));
  const discoveredSet = new Set(discovered);
  const expectedSet = new Set(expectedModules);

  if (discovered.length === 0) {
    violations.push({
      check: 'coverage',
      file: displayPath(CONTRACTS_ROOT),
      line: 1,
      message: 'vacuity guard: zero contract files discovered; the expected set cannot be satisfied'
    });
  }

  for (const expected of expectedModules) {
    if (!discoveredSet.has(expected)) {
      violations.push({
        check: 'coverage',
        file: displayPath(CONTRACTS_ROOT),
        line: 1,
        message: `missing expected contract '${expected}'`
      });
    }
  }

  for (const found of discovered) {
    if (!expectedSet.has(found)) {
      const source = files[discovered.indexOf(found)];
      violations.push({
        check: 'coverage',
        file: displayPath(source),
        line: 1,
        message: `unexpected contract '${found}' is not part of the expected ${expectedModules.length}-path set`
      });
    }
  }

  return violations;
}

/**
 * Returns the trailing lines of captured process output.
 *
 * @param {string} text
 * @param {number} [maxLines]
 * @returns {string}
 */
function tailLines(text, maxLines = 15) {
  const lines = String(text || '').trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

/**
 * Resolves a contract-relative import spec to a repo-relative posix path.
 *
 * @param {object} contract
 * @param {string} spec
 * @returns {string}
 */
function resolveContractSpec(contract, spec) {
  const dir = contract.dirRel === '.' ? 'src/lib/sandbox' : `src/lib/sandbox/${contract.dirRel}`;
  return path.posix.normalize(`${dir}/${spec}`);
}

/**
 * Tests one parsed contract spec against one dependency-cruiser dependency, per the Tier 2
 * matching semantics (trailing `/*` glob, relative resolution with literal-specifier fallback for
 * resolver-unmapped type-only edges, bare npm/core specifier equality).
 *
 * @param {object} contract
 * @param {string} spec
 * @param {object} dependency
 * @returns {boolean}
 */
function specMatchesDependency(contract, spec, dependency) {
  const moduleName = typeof dependency.module === 'string' ? dependency.module : '';
  const resolved = typeof dependency.resolved === 'string' ? dependency.resolved : null;

  if (spec.endsWith('/*')) {
    const baseSpec = spec.slice(0, -2);
    if (baseSpec.startsWith('.')) {
      const base = resolveContractSpec(contract, baseSpec);
      return resolved !== null && (resolved === base || resolved.startsWith(`${base}/`));
    }
    return (
      moduleName === baseSpec ||
      moduleName.startsWith(`${baseSpec}/`) ||
      (resolved !== null && resolved.startsWith(`${baseSpec}/`))
    );
  }

  if (spec.startsWith('.')) {
    const target = resolveContractSpec(contract, spec);
    return resolved === target || moduleName === spec;
  }

  return moduleName === spec;
}

/**
 * Maps a graph module source to its contract base path (module path minus `.d.ts`/sibling
 * implementation extension), e.g. `src/lib/sandbox/sandboxStore/index.svelte.ts` -> `sandboxStore/index.svelte`.
 *
 * @param {string} source
 * @returns {string}
 */
function graphSourceBase(source) {
  const rel = source.startsWith(SANDBOX_REPO_PREFIX)
    ? source.slice(SANDBOX_REPO_PREFIX.length)
    : source;
  return rel.replace(/\.d\.ts$/, '').replace(/\.(js|ts|mjs|cjs)$/, '');
}

/**
 * Resolves the contract's paired graph nodes: the sibling implementation plus the declaration
 * file itself (type-only imports live in the declaration, so it is part of the paired surface).
 *
 * @param {object} contract
 * @param {Map<string, object>} bySource
 * @returns {object[]}
 */
function pairedGraphModules(contract, bySource) {
  const extensions = ['.js', '.ts', '.d.ts', '.mjs', '.cjs'];
  return extensions
    .map(extension => bySource.get(`${SANDBOX_REPO_PREFIX}${contract.contractBase}${extension}`))
    .filter(Boolean);
}

/**
 * Reads `TRACKED_SANDBOX_EXCEPTIONS` from `.dependency-cruiser.cjs` (CJS require) as the
 * authoritative expected set and cross-checks it against the generated
 * `sandbox-outside-import-tracked-*` documentation rules and their pair-precise
 * `sandbox-no-outside-imports-*` guard rules (drift in either direction fails).
 *
 * Semantics:
 * - exported array (including `[]`): authoritative. Each entry (`{ slug, from, to }`) must have a
 *   matching tracked rule and pair-precise guard agreeing on the same from/to pair; generated
 *   rules without a backing entry are drift. An empty array expects zero generated rules.
 * - export absent (or not an array): legacy/foreign config. The set is derived from the generated
 *   tracked rules and an empty rule scan stays fail-closed (a violation).
 *
 * The returned exceptions feed the bidirectional tag-parity check: every out-of-sandbox
 * `@mayImport` must match one exception and every exception must match one tag.
 *
 * @returns {{ exceptions: Array<object>, violations: Array<object> }}
 */
function loadTrackedExceptions() {
  const configPath = path.join(PROJECT_ROOT, '.dependency-cruiser.cjs');
  const display = displayPath(configPath);
  const violations = [];
  let config;
  try {
    config = createRequire(import.meta.url)(configPath);
  } catch (error) {
    violations.push({
      check: 'exception-parity',
      file: display,
      line: 1,
      message: `could not require .dependency-cruiser.cjs: ${error instanceof Error ? error.message : String(error)}`
    });
    return { exceptions: [], violations };
  }

  const forbidden = Array.isArray(config.forbidden) ? config.forbidden : [];
  const trackedRules = forbidden.filter(rule => TRACKED_EXCEPTION_RULE_PATTERN.test(rule.name || ''));
  const preciseRules = forbidden.filter(rule => PAIR_PRECISE_RULE_PATTERN.test(rule.name || ''));
  const exported = Array.isArray(config.TRACKED_SANDBOX_EXCEPTIONS)
    ? config.TRACKED_SANDBOX_EXCEPTIONS
    : null;

  if (exported === null) {
    if (trackedRules.length === 0) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message:
          'no sandbox-outside-import-tracked-* rules found in .dependency-cruiser.cjs; the tracked-exception set cannot be read'
      });
    }

    const exceptions = [];
    for (const rule of trackedRules) {
      const fromPath = rule.from && rule.from.path;
      const toPath = rule.to && rule.to.path;
      if (!fromPath || !toPath) {
        violations.push({
          check: 'exception-parity',
          file: display,
          line: 1,
          message: `${rule.name} is missing a from.path/to.path pair`
        });
        continue;
      }

      const slug = TRACKED_EXCEPTION_RULE_PATTERN.exec(rule.name)[1];
      const preciseName = `sandbox-no-outside-imports-${slug}`;
      const precise = preciseRules.find(candidate => candidate.name === preciseName);
      if (!precise) {
        violations.push({
          check: 'exception-parity',
          file: display,
          line: 1,
          message: `tracked exception '${rule.name}' has no matching pair-precise guard '${preciseName}'`
        });
      } else {
        const pathNot = Array.isArray(precise.from && precise.from.pathNot)
          ? precise.from.pathNot
          : [precise.from && precise.from.pathNot].filter(Boolean);
        if (
          !precise.from ||
          precise.from.path !== '^src/lib/sandbox/' ||
          !pathNot.includes(fromPath) ||
          !precise.to ||
          precise.to.path !== toPath
        ) {
          violations.push({
            check: 'exception-parity',
            file: display,
            line: 1,
            message: `tracked exception '${rule.name}' and pair-precise guard '${preciseName}' disagree on their from/to pair`
          });
        }
      }

      exceptions.push({
        name: rule.name,
        fromPath,
        toPath,
        fromRegex: new RegExp(fromPath),
        toRegex: new RegExp(toPath)
      });
    }

    return { exceptions, violations };
  }

  const exceptions = [];
  const expectedTrackedRuleNames = new Set();
  const expectedPreciseRuleNames = new Set();

  exported.forEach((entry, index) => {
    const label = `TRACKED_SANDBOX_EXCEPTIONS[${index}]`;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.slug !== 'string' ||
      entry.slug.length === 0 ||
      typeof entry.from !== 'string' ||
      entry.from.length === 0 ||
      typeof entry.to !== 'string' ||
      entry.to.length === 0
    ) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `${label} must be an object with non-empty string slug/from/to`
      });
      return;
    }

    const trackedName = `sandbox-outside-import-tracked-${entry.slug}`;
    const preciseName = `sandbox-no-outside-imports-${entry.slug}`;
    expectedTrackedRuleNames.add(trackedName);
    expectedPreciseRuleNames.add(preciseName);

    const tracked = trackedRules.find(rule => rule.name === trackedName);
    if (!tracked) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `${label} ('${entry.slug}') has no matching tracked rule '${trackedName}'`
      });
    } else if ((tracked.from && tracked.from.path) !== entry.from || (tracked.to && tracked.to.path) !== entry.to) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `${label} ('${entry.slug}') and tracked rule '${trackedName}' disagree on their from/to pair`
      });
    }

    const precise = preciseRules.find(candidate => candidate.name === preciseName);
    if (!precise) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `${label} ('${entry.slug}') has no matching pair-precise guard '${preciseName}'`
      });
    } else {
      const pathNot = Array.isArray(precise.from && precise.from.pathNot)
        ? precise.from.pathNot
        : [precise.from && precise.from.pathNot].filter(Boolean);
      if (
        !precise.from ||
        precise.from.path !== '^src/lib/sandbox/' ||
        !pathNot.includes(entry.from) ||
        !precise.to ||
        precise.to.path !== entry.to
      ) {
        violations.push({
          check: 'exception-parity',
          file: display,
          line: 1,
          message: `${label} ('${entry.slug}') and pair-precise guard '${preciseName}' disagree on their from/to pair`
        });
      }
    }

    let fromRegex;
    let toRegex;
    try {
      fromRegex = new RegExp(entry.from);
      toRegex = new RegExp(entry.to);
    } catch (error) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `${label} has an invalid from/to regex: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    exceptions.push({
      name: trackedName,
      fromPath: entry.from,
      toPath: entry.to,
      fromRegex,
      toRegex
    });
  });

  // Generated rules with no backing exported entry are drift in the other direction.
  for (const rule of trackedRules) {
    if (!expectedTrackedRuleNames.has(rule.name)) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `tracked rule '${rule.name}' has no matching TRACKED_SANDBOX_EXCEPTIONS entry`
      });
    }
  }
  for (const rule of preciseRules) {
    if (!expectedPreciseRuleNames.has(rule.name)) {
      violations.push({
        check: 'exception-parity',
        file: display,
        line: 1,
        message: `pair-precise guard '${rule.name}' has no matching TRACKED_SANDBOX_EXCEPTIONS entry`
      });
    }
  }

  return { exceptions, violations };
}

/**
 * Runs dependency-cruiser over the sandbox with the repo config and returns the parsed JSON graph.
 *
 * @returns {{ graph?: object, error?: string, durationMs: number }}
 */
function runDependencyGraph() {
  const startedAt = Date.now();
  const depcruiseBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'depcruise');
  const args = [
    'src/lib/sandbox',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'json',
    ...DEPCRUISE_EXTRA_ARGS
  ];
  const result = spawnSync(process.execPath, [depcruiseBin, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: DEPCRUISE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });
  const durationMs = Date.now() - startedAt;
  const outputTail = tailLines([result.stdout, result.stderr].filter(Boolean).join('\n'));

  if (result.error) {
    return { error: `dependency-cruiser could not be spawned: ${result.error.message}\n${outputTail}`, durationMs };
  }
  if (result.status !== 0) {
    return {
      error: `dependency-cruiser exited ${result.status} (expected 0). Output tail:\n${outputTail}`,
      durationMs
    };
  }

  let graph;
  try {
    graph = JSON.parse(result.stdout);
  } catch (parseError) {
    return {
      error: `dependency-cruiser JSON output could not be parsed: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }\n${outputTail}`,
      durationMs
    };
  }
  if (!graph || !Array.isArray(graph.modules)) {
    return { error: `dependency-cruiser JSON has no modules array. Output tail:\n${outputTail}`, durationMs };
  }

  return { graph, durationMs };
}

/**
 * Tier 2: cross-checks contract boundary tags against the resolved dependency graph, enforces the
 * tracked-exception parity, and rejects untagged out-of-sandbox edges.
 *
 * @param {object[]} contracts parsed contract facts from validateContractFile
 * @returns {{ violations: Array<object>, stats: object }}
 */
function runTier2Checks(contracts) {
  const violations = [];
  const stats = {
    graphModules: 0,
    sandboxModules: 0,
    graphEdges: 0,
    mayImportSpecs: 0,
    mustNotImportSpecs: 0,
    outOfSandboxEdges: 0,
    trackedExceptions: 0,
    depcruiseMs: 0
  };

  const graphResult = runDependencyGraph();
  stats.depcruiseMs = graphResult.durationMs;
  if (graphResult.error) {
    violations.push({
      check: 'graph-build',
      file: displayPath(PROJECT_ROOT),
      line: 1,
      message: graphResult.error
    });
    return { violations, stats };
  }

  const { graph } = graphResult;
  const bySource = new Map(graph.modules.map(module => [module.source, module]));
  stats.graphModules = graph.modules.length;
  stats.sandboxModules = graph.modules.filter(module => module.source.startsWith(SANDBOX_REPO_PREFIX)).length;
  stats.graphEdges = graph.modules.reduce(
    (sum, module) => sum + (Array.isArray(module.dependencies) ? module.dependencies.length : 0),
    0
  );

  const { exceptions, violations: configViolations } = loadTrackedExceptions();
  violations.push(...configViolations);
  stats.trackedExceptions = exceptions.length;

  for (const contract of contracts) {
    contract.graphModules = pairedGraphModules(contract, bySource);
    stats.mayImportSpecs += contract.mayImport.length;
    stats.mustNotImportSpecs += contract.mustNotImport.length;
  }

  // Rule 2/3: tag truth against the actual edges of the paired graph nodes.
  for (const contract of contracts) {
    const pairedSources = contract.graphModules.map(module => module.source);
    const pairedLabel = pairedSources.length > 0 ? pairedSources.join(', ') : '(no paired module found in graph)';

    for (const tag of contract.mayImport) {
      const covered = contract.graphModules.some(module =>
        (Array.isArray(module.dependencies) ? module.dependencies : []).some(dependency =>
          specMatchesDependency(contract, tag.spec, dependency)
        )
      );
      if (!covered) {
        violations.push({
          check: 'may-import-truth',
          file: contract.display,
          line: tag.line,
          tag: '@mayImport',
          message: `@mayImport '${tag.spec}' has no actual edge from ${pairedLabel}`
        });
      }
    }

    for (const tag of contract.mustNotImport) {
      const matches = [];
      for (const module of contract.graphModules) {
        for (const dependency of Array.isArray(module.dependencies) ? module.dependencies : []) {
          if (specMatchesDependency(contract, tag.spec, dependency)) {
            matches.push(`${module.source} -> ${dependency.resolved || dependency.module || '(unresolved)'}`);
          }
        }
      }
      if (matches.length > 0) {
        const shown = matches.slice(0, 3).join('; ');
        const suffix = matches.length > 3 ? ` (+${matches.length - 3} more)` : '';
        violations.push({
          check: 'must-not-import-truth',
          file: contract.display,
          line: tag.line,
          tag: '@mustNotImport',
          message: `@mustNotImport '${tag.spec}' matches actual edge(s): ${shown}${suffix}`
        });
      }
    }
  }

  // Rule 5: every out-of-sandbox edge must be covered by a tag on its module's contract.
  const contractByBase = new Map(contracts.map(contract => [contract.contractBase, contract]));
  for (const module of graph.modules) {
    if (!module.source.startsWith(SANDBOX_REPO_PREFIX)) continue;
    const contract = contractByBase.get(graphSourceBase(module.source));
    for (const dependency of Array.isArray(module.dependencies) ? module.dependencies : []) {
      if (typeof dependency.resolved !== 'string') continue;
      if (!dependency.resolved.startsWith('src/') || dependency.resolved.startsWith(SANDBOX_REPO_PREFIX)) {
        continue;
      }
      stats.outOfSandboxEdges += 1;
      const covered = contract
        ? contract.mayImport.some(tag => specMatchesDependency(contract, tag.spec, dependency))
        : false;
      if (!covered) {
        violations.push({
          check: 'untagged-boundary',
          file: contract ? contract.display : module.source,
          line: 1,
          message: contract
            ? `out-of-sandbox edge '${module.source}' -> '${dependency.resolved}' has no matching @mayImport tag`
            : `out-of-sandbox edge '${module.source}' -> '${dependency.resolved}' cannot be tagged: no contract file for module '${graphSourceBase(module.source)}'`
        });
      }
    }
  }

  // Rule 4: out-of-sandbox @mayImport pairs must equal the tracked exceptions exactly.
  const outOfSandboxTags = [];
  for (const contract of contracts) {
    const implementation = contract.graphModules.find(module => !module.source.endsWith('.d.ts'));
    const from = implementation ? implementation.source : `${SANDBOX_REPO_PREFIX}${contract.contractBase}.js`;
    for (const tag of contract.mayImport) {
      if (!tag.spec.startsWith('.')) continue;
      const baseSpec = tag.spec.endsWith('/*') ? tag.spec.slice(0, -2) : tag.spec;
      const target = resolveContractSpec(contract, baseSpec);
      if (target.startsWith(SANDBOX_REPO_PREFIX)) continue;
      outOfSandboxTags.push({ contract, tag, from, to: target });
    }
  }

  const matchedExceptions = new Set();
  for (const entry of outOfSandboxTags) {
    const matches = exceptions.filter(
      exception => exception.fromRegex.test(entry.from) && exception.toRegex.test(entry.to)
    );
    if (matches.length === 0) {
      violations.push({
        check: 'exception-parity',
        file: entry.contract.display,
        line: entry.tag.line,
        tag: '@mayImport',
        message: `out-of-sandbox @mayImport '${entry.tag.spec}' (${entry.from} -> ${entry.to}) is not one of the TRACKED_SANDBOX_EXCEPTIONS pairs`
      });
    }
    for (const match of matches) matchedExceptions.add(match.name);
  }
  for (const exception of exceptions) {
    if (!matchedExceptions.has(exception.name)) {
      violations.push({
        check: 'exception-parity',
        file: '.dependency-cruiser.cjs',
        line: 1,
        message: `tracked exception '${exception.fromPath}' -> '${exception.toPath}' has no matching out-of-sandbox @mayImport tag`
      });
    }
  }

  return { violations, stats };
}

/**
 * Zeroed Tier 2 stats for `--tier1-only` runs.
 *
 * @returns {object}
 */
function skippedTier2Stats() {
  return {
    graphModules: 0,
    sandboxModules: 0,
    graphEdges: 0,
    mayImportSpecs: 0,
    mustNotImportSpecs: 0,
    outOfSandboxEdges: 0,
    trackedExceptions: 0,
    depcruiseMs: 0
  };
}

/**
 * Main orchestrator: discovers contracts, runs every check, prints the report.
 */
function run() {
  const startedAt = Date.now();
  const parser = createTsdocParser();
  const { files, mode, supersededDts } = discoverContractFiles(CONTRACTS_ROOT);
  const expectedModules = mode === MODE_FOLDERS ? EXPECTED_MODULES_FOLDERS : EXPECTED_MODULES;

  const violations = [];
  const warnings = [];
  const stats = { tags: {}, refs: 0, commitRefs: 0, ticketRefs: 0 };
  const contracts = [];
  const refCaches = { commitCache: new Map(), ticketCache: new Map() };

  for (const file of supersededDts) {
    warnings.push({
      tag: 'discovery',
      file: displayPath(file),
      line: 1,
      message: 'legacy declaration is superseded by its module index.ts surface; delete the .d.ts twin'
    });
  }

  violations.push(...verifyCoverage(files, expectedModules, mode));

  for (const file of files) {
    const result = validateContractFile(parser, file, mode, refCaches);
    violations.push(...result.violations);
    warnings.push(...result.warnings);
    contracts.push(result.contract);
    for (const [tag, count] of Object.entries(result.stats.tags)) {
      stats.tags[tag] = (stats.tags[tag] || 0) + count;
    }
    stats.refs += result.stats.refs;
    stats.commitRefs += result.stats.commitRefs;
    stats.ticketRefs += result.stats.ticketRefs;
  }

  const tier2 = tier1Only
    ? { violations: [], stats: skippedTier2Stats() }
    : runTier2Checks(contracts);
  violations.push(...tier2.violations);

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.check.localeCompare(b.check) ||
      a.message.localeCompare(b.message)
  );
  warnings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message)
  );

  const checks = CHECKS.filter(check => !tier1Only || !TIER2_CHECK_IDS.has(check.id)).map(check => {
    const count = violations.filter(violation => violation.check === check.id).length;
    return { id: check.id, label: check.label, violations: count, passed: count === 0 };
  });

  const discovered = files.map(file => moduleIdFromRelPath(contractsRelPath(file), mode));
  const totalTags = Object.values(stats.tags).reduce((sum, count) => sum + count, 0);
  const passed = violations.length === 0;
  const durationMs = Date.now() - startedAt;

  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify(
        {
          validator: 'module-contracts',
          passed,
          mode,
          tier1Only,
          contractsRoot: displayPath(CONTRACTS_ROOT),
          expectedModules: expectedModules.length,
          discoveredModules: discovered.length,
          discovered,
          customTags: stats.tags,
          customTagTotal: totalTags,
          refs: {
            checked: stats.refs,
            commits: stats.commitRefs,
            tickets: stats.ticketRefs
          },
          tier2: tier2.stats,
          checks,
          violations,
          warnings,
          durationMs
        },
        null,
        2
      )}\n`
    );
  } else {
    log('Module-contract validation (Tier 1+2)');
    log(
      `Root: ${displayPath(CONTRACTS_ROOT)} | Mode: ${mode} | Expected: ${expectedModules.length} | ` +
        `Discovered: ${discovered.length} | Custom tags: ${totalTags}`
    );
    if (tier1Only) {
      log('Graph: skipped (--tier1-only test hook)');
    } else {
      log(
        `Graph: ${tier2.stats.graphEdges} edge(s) over ${tier2.stats.graphModules} module(s) ` +
          `(${tier2.stats.sandboxModules} sandbox) | tracked exceptions: ${tier2.stats.trackedExceptions} | ` +
          `depcruise ${tier2.stats.depcruiseMs}ms`
      );
    }
    log('');

    for (const check of checks) {
      const status = check.passed ? 'PASS' : `FAIL (${check.violations} violation(s))`;
      log(`  ${check.label.padEnd(30, '.')} ${status}`);
    }

    if (warnings.length > 0) {
      log('');
      log(`Warnings (${warnings.length}):`);
      for (const warning of warnings) {
        log(`  [${warning.tag}] ${warning.file}:${warning.line}  ${warning.message}`);
      }
    }

    if (violations.length > 0) {
      log('');
      log(`Violations (${violations.length}):`);
      for (const violation of violations) {
        log(`  [${violation.check}] ${violation.file}:${violation.line}  ${violation.message}`);
      }
    }

    log('');
    log(
      `Result: ${passed ? 'PASS' : 'FAIL'} — ${violations.length} violation(s), ` +
        `${warnings.length} warning(s), ${totalTags} custom tags, ${durationMs}ms ` +
        `(graph ${tier2.stats.depcruiseMs}ms)`
    );
  }

  process.exit(passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
