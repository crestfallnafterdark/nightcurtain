#!/usr/bin/env node
/**
 * @file scripts/check_sensitive_content.mjs
 * @description Read-only pre-commit sensitive-content guard. Scans the git
 * index (staged entries), every tracked entry, or explicit working-tree paths
 * and fails closed on content that must never be committed:
 *
 * - `deny-path`         — paths matching the configured deny-list (run
 *                         artifacts, generated payloads, operator dirs, browser
 *                         profiles, local scratch, `.env*`, key files, ...),
 *                         even when the path is gitignored and force-added;
 * - `machine-path`      — absolute machine/user paths in file content (the
 *                         current home directory, POSIX user homes, Windows
 *                         user-profile paths, `file:///...` URLs);
 * - `credential-pattern` — credential-like literals (API keys, cloud access
 *                         key ids, GitHub/Slack tokens, JWTs, private-key
 *                         markers, credential-looking assignments);
 * - `oversized-blob`    — blobs larger than `maxBytes`;
 * - `binary-blob`       — binary blobs (NUL byte in the first 8 KB) outside
 *                         the configured allow-globs.
 *
 * Findings are printed as `path:line — rule — hint`. Matched values are never
 * echoed (the hint names the rule, not the secret). A finding exits 1; a clean
 * scan exits 0; usage/config errors exit 2.
 *
 * Configuration (fail-closed, no external dependencies)
 * -----------------------------------------------------
 * Built-in generic defaults are merged with the tracked
 * `<repo>/.sensitive-content.json` and, when present, the gitignored
 * `<repo>/.sensitive-content.local.json` overlay. Array keys concatenate in
 * that order; scalars are overridden by the overlay. Keys:
 *
 *   denyPaths           string[]  glob patterns for policy-local-only paths
 *   binaryAllowGlobs    string[]  glob patterns exempt from binary/oversized
 *   credentialPatterns  string[]  extra credential regex sources
 *   maxBytes            number    positive integer blob-size ceiling
 *   allowlist           object[]  `{ pattern, reason, rule? }`; a non-empty
 *                                 reason is required, `rule` is one of the
 *                                 rule names above
 *
 * Unknown keys, malformed values, and allowlist entries without a reason are
 * config errors (exit 2) — never silently ignored.
 *
 * Scans the index, never the working tree: `git diff --cached --name-only -z
 * --diff-filter=ACMR`, size via `git cat-file -s :<path>`, content via
 * `git cat-file blob :<path>`. `--all-tracked` reads the same index objects in
 * one `git cat-file --batch` stream.
 *
 * Exit codes: 0 clean, 1 findings, 2 usage/config error.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

/** Bytes inspected when deciding whether a blob is binary. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** Git `cat-file --batch` output ceiling for `--all-tracked`. */
const GIT_BATCH_MAX_BUFFER = 512 * 1024 * 1024;

/** Rule names used in findings and accepted in allowlist `rule` fields. */
const RULE_NAMES = Object.freeze(['deny-path', 'machine-path', 'credential-pattern', 'oversized-blob', 'binary-blob']);

/** Config keys the guard understands; anything else is a config error. */
const CONFIG_KEYS = new Set(['denyPaths', 'binaryAllowGlobs', 'credentialPatterns', 'maxBytes', 'allowlist']);

/** Generic defaults, always active; project patterns come from the config. */
const DEFAULT_CONFIG = Object.freeze({
  denyPaths: ['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*'],
  binaryAllowGlobs: [],
  maxBytes: 1024 * 1024
});

/** Generic credential shapes. Hints deliberately never contain the match. */
const CREDENTIAL_RULES = Object.freeze([
  { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, hint: 'private key block marker (value omitted)' },
  { regex: /\bAKIA[0-9A-Z]{16}\b/, hint: 'possible AWS access key id (value omitted)' },
  { regex: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/, hint: 'possible API secret key (value omitted)' },
  { regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, hint: 'possible GitHub token (value omitted)' },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/, hint: 'possible GitHub fine-grained token (value omitted)' },
  { regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, hint: 'possible Slack token (value omitted)' },
  { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, hint: 'possible JWT (value omitted)' },
  {
    regex: /(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*["'][^"'\n]{16,}["']/i,
    hint: 'credential-looking assignment literal (value omitted)'
  }
]);

/** Generic absolute-path shapes beyond the dynamic current home directory. */
const GENERIC_MACHINE_RULES = Object.freeze([
  { regex: /\/(?:home|Users)\/[A-Za-z0-9._-]+/, hint: 'POSIX user-home path (/home or /Users; value omitted)' },
  { regex: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+/, hint: 'Windows user-profile path (value omitted)' }
]);

const USAGE = `Usage: node scripts/check_sensitive_content.mjs [mode] [options]

Read-only sensitive-content guard for staged/tracked files. Exits 0 clean,
1 with findings, 2 on usage or config errors. Matched values are never echoed.

Modes (exactly one; default --staged):
  --staged              Scan files staged in the git index (recommended).
  --all-tracked         Scan every file tracked in the git index.
  --paths <p...>        Scan the given working-tree paths.

Options:
  --json                Machine-readable result on stdout:
                        { ok, mode, scanned, findings: [{ path, line, rule, hint }] }
  --config <file>       Base config (default: <repo>/.sensitive-content.json).
  --quiet               Suppress the summary line; findings still print.
  -h, --help            Show this help.

Rules: ${RULE_NAMES.join(', ')}.

Config (merged over built-in defaults; .sensitive-content.local.json overlays):
  denyPaths           string[]  glob patterns for policy-local-only paths
  binaryAllowGlobs    string[]  glob patterns exempt from binary/oversized
  credentialPatterns  string[]  extra credential regex sources
  maxBytes            number    positive integer blob-size ceiling (default 1048576)
  allowlist           object[]  { pattern, reason, rule? } — reason is required`;

/** Usage/input error (exit code 2). */
class UsageError extends Error {}

/** Config validation error (exit code 2). */
class ConfigError extends Error {}

/**
 * Creates a usage error.
 * @param {string} message Message.
 * @returns {UsageError} Error instance.
 */
function usage(message) {
  return new UsageError(message);
}

/**
 * Narrows a value to a plain non-array record.
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for plain records.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Escapes a string for literal use inside a regular expression.
 * @param {string} value Raw string.
 * @returns {string} Escaped string.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a glob (`*`, `?`, `**`) to an anchored regular expression.
 * A double-star segment matches zero or more path segments; `*` and `?`
 * never cross a slash.
 * @param {string} glob Glob pattern with forward slashes.
 * @returns {RegExp} Anchored matcher.
 */
function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Tests a repo-relative path against one glob.
 * @param {string} glob Glob pattern.
 * @param {string} value Forward-slash path.
 * @returns {boolean} True on match.
 */
function globMatch(glob, value) {
  return globToRegExp(glob).test(value);
}

/**
 * Returns the first matching glob, or null.
 * @param {string[]} globs Glob patterns.
 * @param {string} value Forward-slash path.
 * @returns {string|null} Matching pattern.
 */
function firstGlobMatch(globs, value) {
  for (const glob of globs) {
    if (globMatch(glob, value)) return glob;
  }
  return null;
}

/**
 * Parses CLI arguments.
 * @param {string[]} argv Raw arguments (without node/script).
 * @returns {{ mode: string, paths: string[], json: boolean, quiet: boolean, configPath: string|null, help: boolean }} Options.
 * @throws {UsageError} On unknown or malformed arguments.
 */
function parseArgs(argv) {
  const options = { mode: 'staged', paths: [], json: false, quiet: false, configPath: null, help: false };
  let modeChosen = false;
  const setMode = (mode) => {
    if (modeChosen && options.mode !== mode) throw usage(`mode already set to --${options.mode}`);
    options.mode = mode;
    modeChosen = true;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--staged') {
      setMode('staged');
    } else if (arg === '--all-tracked') {
      setMode('all-tracked');
    } else if (arg === '--paths') {
      setMode('paths');
      const collected = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        collected.push(argv[index + 1]);
        index += 1;
      }
      if (collected.length === 0) throw usage('--paths requires at least one path');
      options.paths.push(...collected);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--config') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw usage('--config requires a file');
      options.configPath = argv[index + 1];
      index += 1;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw usage(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Resolves the repository toplevel for a working directory.
 * @param {string} cwd Working directory.
 * @returns {string|null} Real path of the toplevel, or null outside a repo.
 */
function resolveRepoRoot(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const top = result.stdout.trim();
  if (top === '') return null;
  try {
    return fs.realpathSync(top);
  } catch {
    return path.resolve(top);
  }
}

/**
 * Runs git and returns stdout, throwing a usage error on failure.
 * @param {string} repoRoot Repository toplevel.
 * @param {string[]} args Git arguments.
 * @param {{ buffer?: boolean }} [options] `buffer: true` returns a Buffer.
 * @returns {string|Buffer} Captured stdout.
 * @throws {UsageError} When git cannot be spawned or exits non-zero.
 */
function gitCapture(repoRoot, args, options = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: options.buffer ? 'buffer' : 'utf8',
    maxBuffer: options.buffer ? GIT_BATCH_MAX_BUFFER : 16 * 1024 * 1024
  });
  if (result.error) throw usage(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw usage(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

/**
 * Splits NUL-terminated git path output.
 * @param {Buffer|string} output Raw `-z` output.
 * @returns {string[]} Paths.
 */
function splitNul(output) {
  return String(output)
    .split('\0')
    .filter((entry) => entry !== '');
}

/**
 * Collects staged index entries (ACMR) with size and blob content.
 * @param {string} repoRoot Repository toplevel.
 * @returns {Array<{displayPath: string, matchPath: string, size: number, content: Buffer}>} Entries.
 */
function collectStagedEntries(repoRoot) {
  const names = splitNul(gitCapture(repoRoot, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { buffer: true }));
  const entries = [];
  for (const name of names) {
    const type = String(gitCapture(repoRoot, ['cat-file', '-t', `:${name}`])).trim();
    if (type !== 'blob') continue;
    const size = Number(String(gitCapture(repoRoot, ['cat-file', '-s', `:${name}`])).trim());
    const content = gitCapture(repoRoot, ['cat-file', 'blob', `:${name}`], { buffer: true });
    entries.push({ displayPath: name, matchPath: name, size, content });
  }
  return entries;
}

/** `git cat-file --batch` header: `<oid> <type> <size>`. */
const BATCH_HEADER_RE = /^[0-9a-f]{40,64} (blob|tree|commit|tag) (\d+)$/;

/**
 * Reads index blobs for many paths in one `git cat-file --batch` stream.
 * Paths containing newlines cannot ride the newline-delimited batch protocol
 * and fall back to per-path `git cat-file` calls.
 * @param {string} repoRoot Repository toplevel.
 * @param {string[]} names Repository-relative paths.
 * @returns {Map<string, {size: number, content: Buffer}|null>} Blob map (null for non-blobs).
 */
function readIndexBlobsBatch(repoRoot, names) {
  const map = new Map();
  if (names.length === 0) return map;
  const batchable = [];
  for (const name of names) {
    if (!name.includes('\n')) {
      batchable.push(name);
      continue;
    }
    const type = String(gitCapture(repoRoot, ['cat-file', '-t', `:${name}`])).trim();
    if (type !== 'blob') {
      map.set(name, null);
      continue;
    }
    const size = Number(String(gitCapture(repoRoot, ['cat-file', '-s', `:${name}`])).trim());
    const content = gitCapture(repoRoot, ['cat-file', 'blob', `:${name}`], { buffer: true });
    map.set(name, { size, content });
  }
  if (batchable.length === 0) return map;
  const input = batchable.map((name) => `:${name}\n`).join('');
  const result = spawnSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: Buffer.from(input, 'utf8'),
    encoding: 'buffer',
    maxBuffer: GIT_BATCH_MAX_BUFFER
  });
  if (result.error) throw usage(`git cat-file --batch failed: ${result.error.message}`);
  if (result.status !== 0) throw usage(`git cat-file --batch failed: ${String(result.stderr).trim()}`);
  const output = result.stdout;
  let offset = 0;
  for (const name of batchable) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;
    const match = header.match(BATCH_HEADER_RE);
    if (!match) {
      map.set(name, null);
      continue;
    }
    const size = Number(match[2]);
    if (match[1] !== 'blob') {
      offset += size + 1;
      map.set(name, null);
      continue;
    }
    map.set(name, { size, content: output.subarray(offset, offset + size) });
    offset += size + 1;
  }
  return map;
}

/**
 * Collects every tracked index entry with size and blob content.
 * @param {string} repoRoot Repository toplevel.
 * @returns {Array<{displayPath: string, matchPath: string, size: number, content: Buffer}>} Entries.
 */
function collectAllTrackedEntries(repoRoot) {
  const names = splitNul(gitCapture(repoRoot, ['ls-files', '-z'], { buffer: true }));
  const blobs = readIndexBlobsBatch(repoRoot, names);
  const entries = [];
  for (const name of names) {
    const blob = blobs.get(name);
    if (!blob) continue;
    entries.push({ displayPath: name, matchPath: name, size: blob.size, content: blob.content });
  }
  return entries;
}

/**
 * Collects explicit working-tree path entries.
 * @param {string[]} rawPaths CLI paths (relative to `cwd` or absolute).
 * @param {string|null} repoRoot Repository toplevel, when inside a repo.
 * @param {string} cwd Working directory.
 * @returns {Array<{displayPath: string, matchPath: string, size: number, content: Buffer}>} Entries.
 * @throws {UsageError} When a path is missing or not a file.
 */
function collectPathEntries(rawPaths, repoRoot, cwd) {
  const entries = [];
  for (const rawPath of rawPaths) {
    const absolute = path.resolve(cwd, rawPath);
    if (!fs.existsSync(absolute)) throw usage(`path not found: ${rawPath}`);
    if (!fs.statSync(absolute).isFile()) throw usage(`not a file: ${rawPath}`);
    let resolved = absolute;
    try {
      resolved = fs.realpathSync(absolute);
    } catch {
      // Keep the resolved absolute path.
    }
    const root = repoRoot ?? cwd;
    const relative = path.relative(root, resolved);
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    const matchPath = inside ? relative.split(path.sep).join('/') : resolved.split(path.sep).join('/');
    const content = fs.readFileSync(resolved);
    entries.push({ displayPath: inside ? matchPath : rawPath, matchPath, size: content.length, content });
  }
  return entries;
}

/**
 * Builds the machine-path detector for the current user.
 * @returns {{ homePattern: RegExp|null, homeHint: string }} Detector parts.
 */
function buildHomeDetector() {
  const home = os.homedir();
  if (typeof home !== 'string' || home.length < 2) return { homePattern: null, homeHint: '' };
  return {
    homePattern: new RegExp(`${escapeRegExp(home)}(?![A-Za-z0-9._-])`),
    homeHint: 'current home directory path (value omitted)'
  };
}

/**
 * Finds a machine-specific path on one line, without echoing it.
 * @param {string} line Text line.
 * @param {{ homePattern: RegExp|null, homeHint: string }} homeDetector Detector parts.
 * @returns {string|null} Hint, or null.
 */
function findMachinePathHint(line, homeDetector) {
  if (homeDetector.homePattern && homeDetector.homePattern.test(line)) return homeDetector.homeHint;
  for (const rule of GENERIC_MACHINE_RULES) {
    if (rule.regex.test(line)) return rule.hint;
  }
  return null;
}

/**
 * Finds a credential-like pattern on one line, without echoing it.
 * @param {string} line Text line.
 * @param {RegExp[]} extraPatterns Project credential patterns from config.
 * @returns {string|null} Hint, or null.
 */
function findCredentialHint(line, extraPatterns) {
  for (const rule of CREDENTIAL_RULES) {
    if (rule.regex.test(line)) return rule.hint;
  }
  for (const regex of extraPatterns) {
    if (regex.test(line)) return 'project credential pattern (value omitted)';
  }
  return null;
}

/**
 * Records a finding once per (path, line, rule).
 * @param {Array<object>} findings Finding accumulator.
 * @param {Set<string>} seen Dedupe set.
 * @param {string} filePath Display path.
 * @param {number} line 1-based line (1 for path/blob-level findings).
 * @param {string} rule Rule name.
 * @param {string} hint Actionable hint (never contains a matched value).
 * @returns {void}
 */
function pushFinding(findings, seen, filePath, line, rule, hint) {
  const key = `${filePath}\0${line}\0${rule}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ path: filePath, line, rule, hint });
}

/**
 * Scans one text blob's lines.
 * @param {{displayPath: string, content: Buffer}} entry Entry.
 * @param {object} config Merged config.
 * @param {Array<object>} findings Finding accumulator.
 * @param {Set<string>} seen Dedupe set.
 * @param {{ homePattern: RegExp|null, homeHint: string }} homeDetector Detector parts.
 * @returns {void}
 */
function scanTextEntry(entry, config, findings, seen, homeDetector) {
  const lines = entry.content.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const machineHint = findMachinePathHint(line, homeDetector);
    if (machineHint) pushFinding(findings, seen, entry.displayPath, index + 1, 'machine-path', machineHint);
    const credentialHint = findCredentialHint(line, config.credentialPatterns);
    if (credentialHint) pushFinding(findings, seen, entry.displayPath, index + 1, 'credential-pattern', credentialHint);
  }
}

/**
 * Applies the merged rules to every entry.
 * @param {Array<object>} entries Collected entries.
 * @param {object} config Merged config.
 * @returns {Array<{path: string, line: number, rule: string, hint: string}>} Findings.
 */
function scanEntries(entries, config) {
  const findings = [];
  const seen = new Set();
  const homeDetector = buildHomeDetector();
  for (const entry of entries) {
    const denyPattern = firstGlobMatch(config.denyPaths, entry.matchPath);
    if (denyPattern) {
      pushFinding(findings, seen, entry.displayPath, 1, 'deny-path', `policy-local-only path (matches "${denyPattern}")`);
      continue;
    }
    const allowedBinary = firstGlobMatch(config.binaryAllowGlobs, entry.matchPath) !== null;
    if (!allowedBinary && entry.size > config.maxBytes) {
      pushFinding(
        findings,
        seen,
        entry.displayPath,
        1,
        'oversized-blob',
        `blob is ${entry.size} bytes (limit ${config.maxBytes})`
      );
    }
    if (entry.content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      if (!allowedBinary) {
        pushFinding(
          findings,
          seen,
          entry.displayPath,
          1,
          'binary-blob',
          `binary blob (NUL byte in first ${BINARY_PROBE_BYTES} bytes) outside allowed asset globs`
        );
      }
      continue;
    }
    scanTextEntry(entry, config, findings, seen, homeDetector);
  }
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  return applyAllowlist(findings, config.allowlist);
}

/**
 * Drops findings matched by a reasoned allowlist entry.
 * @param {Array<object>} findings Findings.
 * @param {Array<{pattern: string, reason: string, rule?: string}>} allowlist Entries.
 * @returns {Array<object>} Filtered findings.
 */
function applyAllowlist(findings, allowlist) {
  if (allowlist.length === 0) return findings;
  return findings.filter((finding) => {
    for (const entry of allowlist) {
      if (entry.rule !== undefined && entry.rule !== finding.rule) continue;
      if (globMatch(entry.pattern, finding.path)) return false;
    }
    return true;
  });
}

/**
 * Validates an array-of-strings config value.
 * @param {unknown} value Candidate.
 * @param {string} where Error location.
 * @returns {string[]} Validated strings.
 * @throws {ConfigError} On invalid values.
 */
function validateStringArray(value, where) {
  if (!Array.isArray(value)) throw new ConfigError(`${where} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new ConfigError(`${where}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

/**
 * Validates the allowlist array (`{pattern, reason, rule?}`; reason required).
 * @param {unknown} value Candidate.
 * @param {string} source Config source label.
 * @returns {Array<{pattern: string, reason: string, rule?: string}>} Validated entries.
 * @throws {ConfigError} On invalid entries.
 */
function validateAllowlist(value, source) {
  if (!Array.isArray(value)) throw new ConfigError(`${source}: allowlist must be an array`);
  return value.map((entry, index) => {
    const where = `${source}: allowlist[${index}]`;
    if (!isRecord(entry)) throw new ConfigError(`${where} must be an object`);
    if (typeof entry.pattern !== 'string' || entry.pattern.length === 0) {
      throw new ConfigError(`${where}.pattern must be a non-empty string`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      throw new ConfigError(`${where}.reason is required`);
    }
    if (entry.rule !== undefined && !RULE_NAMES.includes(entry.rule)) {
      throw new ConfigError(`${where}.rule must be one of: ${RULE_NAMES.join(', ')}`);
    }
    const validated = { pattern: entry.pattern, reason: entry.reason };
    if (entry.rule !== undefined) validated.rule = entry.rule;
    return validated;
  });
}

/**
 * Validates one parsed config object.
 * @param {unknown} raw Parsed JSON.
 * @param {string} source Config file path.
 * @returns {object} Normalized config (missing keys omitted).
 * @throws {ConfigError} On unknown keys or invalid values.
 */
function validateConfig(raw, source) {
  if (!isRecord(raw)) throw new ConfigError(`${source}: top-level value must be a JSON object`);
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new ConfigError(`${source}: unknown config key "${key}"`);
  }
  const config = {};
  if ('denyPaths' in raw) config.denyPaths = validateStringArray(raw.denyPaths, `${source}: denyPaths`);
  if ('binaryAllowGlobs' in raw) config.binaryAllowGlobs = validateStringArray(raw.binaryAllowGlobs, `${source}: binaryAllowGlobs`);
  if ('credentialPatterns' in raw) {
    const patterns = validateStringArray(raw.credentialPatterns, `${source}: credentialPatterns`);
    config.credentialPatterns = patterns.map((pattern, index) => {
      try {
        return new RegExp(pattern);
      } catch {
        throw new ConfigError(`${source}: credentialPatterns[${index}] is not a valid regular expression`);
      }
    });
  }
  if ('maxBytes' in raw) {
    if (!Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
      throw new ConfigError(`${source}: maxBytes must be a positive integer`);
    }
    config.maxBytes = raw.maxBytes;
  }
  if ('allowlist' in raw) config.allowlist = validateAllowlist(raw.allowlist, source);
  return config;
}

/**
 * Reads and validates an optional config file.
 * @param {string} filePath Config path.
 * @param {{ required: boolean }} options Whether absence is an error.
 * @returns {object|null} Normalized config, or null when absent.
 * @throws {ConfigError} On read/parse/validation errors.
 */
function readConfigFile(filePath, options) {
  if (!fs.existsSync(filePath)) {
    if (options.required) throw new ConfigError(`config file not found: ${filePath}`);
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`cannot parse ${filePath}: ${error.message}`);
  }
  return validateConfig(raw, filePath);
}

/**
 * Loads the merged config: built-in defaults + tracked config + local overlay.
 * @param {{configPath: string|null}} options CLI options.
 * @param {string|null} repoRoot Repository toplevel.
 * @param {string} cwd Working directory.
 * @returns {{config: object, configPath: string}} Merged config and base path.
 * @throws {ConfigError} On missing explicit config or invalid content.
 */
function loadConfig(options, repoRoot, cwd) {
  const baseDir = repoRoot ?? cwd;
  const basePath = options.configPath ? path.resolve(cwd, options.configPath) : path.join(baseDir, '.sensitive-content.json');
  const base = readConfigFile(basePath, { required: options.configPath !== null });
  const overlay = readConfigFile(path.join(path.dirname(basePath), '.sensitive-content.local.json'), { required: false });
  const dedupe = (values) => [...new Set(values)];
  const config = {
    denyPaths: dedupe([...DEFAULT_CONFIG.denyPaths, ...(base?.denyPaths ?? []), ...(overlay?.denyPaths ?? [])]),
    binaryAllowGlobs: [...(base?.binaryAllowGlobs ?? []), ...(overlay?.binaryAllowGlobs ?? [])],
    credentialPatterns: [...(base?.credentialPatterns ?? []), ...(overlay?.credentialPatterns ?? [])],
    maxBytes: overlay?.maxBytes ?? base?.maxBytes ?? DEFAULT_CONFIG.maxBytes,
    allowlist: [...(base?.allowlist ?? []), ...(overlay?.allowlist ?? [])]
  };
  return { config, configPath: basePath };
}

/**
 * Collects entries for the selected mode.
 * @param {{mode: string, paths: string[]}} options CLI options.
 * @param {string|null} repoRoot Repository toplevel.
 * @param {string} cwd Working directory.
 * @returns {Array<object>} Entries.
 * @throws {UsageError} Outside a repo for index modes, or bad `--paths` input.
 */
function collectEntries(options, repoRoot, cwd) {
  if (options.mode === 'paths') return collectPathEntries(options.paths, repoRoot, cwd);
  if (repoRoot === null) throw usage(`--${options.mode} requires a git repository (or use --paths)`);
  return options.mode === 'all-tracked' ? collectAllTrackedEntries(repoRoot) : collectStagedEntries(repoRoot);
}

/**
 * Prints findings and the summary in text or JSON form.
 * @param {{json: boolean, quiet: boolean}} options CLI options.
 * @param {string} mode Scan mode.
 * @param {number} scanned Entry count.
 * @param {Array<object>} findings Findings.
 * @returns {void}
 */
function printResult(options, mode, scanned, findings) {
  if (options.json) {
    console.log(JSON.stringify({ ok: findings.length === 0, mode, scanned, findings }, null, 2));
    return;
  }
  for (const finding of findings) {
    console.log(`${finding.path}:${finding.line} — ${finding.rule} — ${finding.hint}`);
  }
  if (options.quiet) return;
  if (findings.length === 0) {
    console.log(`sensitive-content guard: clean — ${scanned} file(s) scanned (${mode})`);
  } else {
    console.log(`sensitive-content guard: ${findings.length} finding(s) in ${scanned} file(s) scanned (${mode})`);
    console.log('Fix the file or add a reasoned allowlist entry to .sensitive-content.json.');
  }
}

/**
 * Runs the guard. Returns the process exit code.
 * @returns {number} Exit code (0 clean, 1 findings, 2 usage/config error).
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`sensitive-content guard: ${error.message}`);
    console.error('Run with --help for usage.');
    return EXIT_USAGE;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  try {
    const cwd = process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    const { config } = loadConfig(options, repoRoot, cwd);
    const entries = collectEntries(options, repoRoot, cwd);
    const findings = scanEntries(entries, config);
    printResult(options, options.mode, entries.length, findings);
    return findings.length === 0 ? EXIT_OK : EXIT_FINDINGS;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      console.error(`sensitive-content guard: ${error.message}`);
      return EXIT_USAGE;
    }
    console.error(`sensitive-content guard: unexpected error: ${error.message}`);
    return EXIT_USAGE;
  }
}

process.exitCode = main();
