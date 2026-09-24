#!/usr/bin/env node
/**
 * @file scripts/gitbug.mjs
 * @description Safe wrapper around this repository's git-bug CLI (verified on
 * `dev-f2070b5325`). It removes the footguns documented in
 * `.agents/skills/working-with-git-bug/SKILL.md` by construction:
 *
 * - Every operation nests under `git bug bug` (there are no top-level shorthands).
 * - Write commands are always issued with `--non-interactive` and `-m`/`-F`, so no
 *   `$EDITOR` is ever spawned.
 * - `-t` and `-F` are never combined (`-F` silently overrides `-t`). The default
 *   path uses `-m` so `-t` is honoured; `-F -` is used only with `--title-from-body`.
 * - Ticket refs are prefix-matched against `git for-each-ref refs/bugs` before any
 *   `show`/`close`/`open`/`comment`, so an unknown ref fails instead of silently
 *   falling back to the *selected* bug. `refs/bugs/<7-hex>` is never passed to
 *   `git rev-parse`.
 * - Labels are validated individually (one argv element each); malformed or unknown
 *   labels are rejected with exit code 2 instead of creating a space-containing label.
 * - Concurrent invocations are serialized through an advisory O_EXCL lock file
 *   (`<git-common-dir>/gitbug-wrapper.lock`, shared across worktrees; override with
 *   `GITBUG_LOCK_PATH`), so parallel git-bug calls queue instead of failing on
 *   git-bug's own repository lock. The wrapper waits with jittered backoff up to
 *   `--lock-timeout`/`GITBUG_LOCK_TIMEOUT` (default 120000 ms), reclaims stale locks,
 *   and fails closed with holder details on timeout. `.git/git-bug/lock` is never
 *   touched. `--help` and `--dry-run` never take the lock.
 *
 * @remarks
 * `--dry-run` prints the exact `git` argv instead of executing a mutation. Ticket
 * resolution still enumerates `refs/bugs` read-only so the printed ids are real;
 * no ref, ticket, comment, label, or status is ever modified.
 *
 * Exit codes: `0` success, `1` command failure, `2` usage/validation error.
 * Errors are sanitized; no secrets are read or echoed.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const VALID_STATUS = new Set(['open', 'closed']);
const LABEL_PREFIXES = ['area', 'sev', 'type', 'prog', 'prio'];
const LEGACY_LABELS = new Set(['qa', 'mod-21', 'security', 'audit-fail']);

const LOCK_BASENAME = 'gitbug-wrapper.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const LOCK_HARD_CAP_MS = 15 * 60 * 1000;
const LOCK_POLL_MIN_MS = 50;
const LOCK_POLL_MAX_MS = 500;
const LOCKABLE_COMMANDS = new Set(['list', 'show', 'resolve', 'new', 'comment', 'close', 'open', 'labels']);

const USAGE = `Usage: gitbug <command> [options]

Commands:
  list      [--status open|closed] [--label <l>]... [--json]
  show      <ref> [--json]
  resolve   <ref>
  new       --title <t> (--body <b> | --body-file <f>) [--label <l>]... [--title-from-body]
  comment   <ref> (--body <b> | --body-file <f>)
  close     <ref>
  open      <ref>
  labels

Global:
  --dry-run            Print the git argv that would run; perform no mutation.
  --lock-timeout <ms>  Max wait for the wrapper invocation lock (default 120000;
                       env GITBUG_LOCK_TIMEOUT). Serializes concurrent gitbug
                       invocations so they queue on git-bug's repository lock.
  -h, --help           Show this help.

Allowed labels: area:* sev:* type:* prog:* prio:* qa mod-21 security audit-fail
Exit codes: 0 ok, 1 command failure, 2 usage/validation.`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT_USAGE;
  }
}

function usage(message) {
  return new UsageError(message);
}

/**
 * Validate a single git-bug label.
 * @param {string} label Candidate label.
 * @returns {{ok: true} | {ok: false, reason: string}} Result.
 */
export function validateLabel(label) {
  if (typeof label !== 'string' || label.length === 0) {
    return { ok: false, reason: 'label is empty' };
  }
  if (/\s/.test(label)) {
    return { ok: false, reason: `label contains whitespace: ${JSON.stringify(label)}` };
  }
  if (LEGACY_LABELS.has(label)) {
    return { ok: true };
  }
  const idx = label.indexOf(':');
  if (idx === -1) {
    return { ok: false, reason: `unknown label: ${JSON.stringify(label)}` };
  }
  const prefix = label.slice(0, idx);
  const value = label.slice(idx + 1);
  if (!LABEL_PREFIXES.includes(prefix)) {
    return { ok: false, reason: `unknown label prefix: ${JSON.stringify(prefix)}` };
  }
  if (value.length === 0) {
    return { ok: false, reason: `label has an empty value: ${JSON.stringify(label)}` };
  }
  return { ok: true };
}

/**
 * Validate a list of labels.
 * @param {string[]} labels Candidate labels.
 * @returns {{ok: boolean, invalid: Array<{label: string, reason: string}>}} Result.
 */
export function validateLabels(labels) {
  const list = Array.isArray(labels) ? labels : [];
  const invalid = [];
  for (const label of list) {
    const result = validateLabel(label);
    if (!result.ok) invalid.push({ label, reason: result.reason });
  }
  return { ok: invalid.length === 0, invalid };
}

/**
 * Resolve a user-supplied ref against the known `refs/bugs` ref names.
 * @param {string} ref Short id, hex prefix, full id, or full ref name.
 * @param {string[]} refNames Output of `git for-each-ref refs/bugs`.
 * @returns {{ok: true, id: string, shortId: string}
 *   | {ok: false, reason: string, ref?: string, matches?: string[]}} Result.
 */
export function resolveTicketRef(ref, refNames) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  const needle = ref.trim().replace(/^refs\/bugs\//, '').toLowerCase();
  const ids = (Array.isArray(refNames) ? refNames : [])
    .map((name) => String(name).replace(/^refs\/bugs\//, '').toLowerCase());
  const matches = ids.filter((id) => id === needle || id.startsWith(needle));
  if (matches.length === 1) {
    return { ok: true, id: matches[0], shortId: matches[0].slice(0, 7) };
  }
  if (matches.length === 0) {
    return { ok: false, reason: 'not-found', ref: needle };
  }
  return { ok: false, reason: 'ambiguous', ref: needle, matches: matches.slice(0, 10) };
}

/**
 * Build the `git bug bug new` argv. Default mode keeps `-t` authoritative by
 * sending the body through `-m`; `--title-from-body` switches to `-F -` (stdin)
 * and omits `-t` so the body's first line becomes the title.
 * @param {{title?: string, body?: string, bodyFileContent?: string,
 *   titleFromBody?: boolean}} options Inputs, with `--body-file` pre-read.
 * @returns {{args: string[], stdin: string|null}} Argv (without `git`) and stdin.
 */
export function buildNewArgs(options = {}) {
  const { title, body, bodyFileContent, titleFromBody = false } = options;
  const content = body !== undefined ? body : bodyFileContent;
  const args = ['bug', 'bug', 'new', '--non-interactive'];
  if (titleFromBody) {
    if (content === undefined) {
      throw usage('new --title-from-body requires --body or --body-file');
    }
    args.push('-F', '-');
    return { args, stdin: content };
  }
  if (typeof title !== 'string' || title.length === 0) {
    throw usage('new requires --title (or pass --title-from-body)');
  }
  if (content === undefined) {
    throw usage('new requires --body or --body-file');
  }
  args.push('-t', title, '-m', content);
  return { args, stdin: null };
}

/**
 * Build the `git bug bug comment new` argv.
 * @param {{body?: string, bodyFileContent?: string}} options Inputs.
 * @returns {{args: string[], stdin: string|null}} Argv (without `git`) and stdin.
 */
export function buildCommentArgs(options = {}) {
  const { body, bodyFileContent } = options;
  const content = body !== undefined ? body : bodyFileContent;
  if (content === undefined) {
    throw usage('comment requires --body or --body-file');
  }
  return { args: ['bug', 'bug', 'comment', 'new', '--non-interactive', '-m', content], stdin: null };
}

function parseOptions(tokens, { strings = [], bools = [] } = {}) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (strings.includes(token)) {
      if (i + 1 >= tokens.length) throw usage(`missing value for ${token}`);
      const key = token.replace(/^--/, '');
      opts[key] = opts[key] || [];
      opts[key].push(tokens[(i += 1)]);
    } else if (bools.includes(token)) {
      opts[token.replace(/^--/, '')] = true;
    } else if (token.startsWith('-')) {
      throw usage(`unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  return { opts, positional };
}

function single(values, flag) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length !== 1) {
    throw usage(`${flag} may be given exactly once`);
  }
  return values[0];
}

function parse(argv) {
  const global = { dryRun: false, help: false, lockTimeout: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') global.dryRun = true;
    else if (token === '--help' || token === '-h') global.help = true;
    else if (token === '--lock-timeout') {
      if (i + 1 >= argv.length) throw usage('missing value for --lock-timeout');
      global.lockTimeout = parseLockTimeoutValue(argv[i + 1], '--lock-timeout');
      i += 1;
    } else rest.push(token);
  }
  return { global, rest };
}

function formatCommand(args) {
  const quote = (value) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`);
  return ['git', ...args].map(quote).join(' ');
}

function execGit(args, input) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    input: input === null || input === undefined ? undefined : input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return { status: EXIT_FAIL, stdout: '', stderr: `git invocation failed: ${result.error.code || 'error'}` };
  }
  return { status: result.status ?? EXIT_FAIL, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// Advisory invocation lock
//
// git-bug guards its repository with file locks; concurrent wrapper calls must
// queue on our own lock instead of racing into git-bug's. The O_EXCL create is
// the mutex; the JSON content is holder metadata used for stale reclamation.
// ---------------------------------------------------------------------------

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Sleep synchronously, blocking the current thread only.
 * @param {number} ms Milliseconds to wait.
 * @returns {void}
 */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/**
 * Jittered exponential backoff: ~50 ms at first, ~500 ms cap.
 * @param {number} attempt Zero-based attempt counter.
 * @returns {number} Milliseconds to sleep.
 */
function lockBackoffDelay(attempt) {
  const base = Math.min(LOCK_POLL_MAX_MS, LOCK_POLL_MIN_MS * 2 ** Math.min(attempt, 10));
  return Math.max(1, Math.round(base * (0.5 + Math.random() * 0.5)));
}

/**
 * Resolve the wrapper lock path. `GITBUG_LOCK_PATH` overrides the default
 * `<git-common-dir>/gitbug-wrapper.lock`, which is shared across worktrees.
 * git-bug's own `.git/git-bug/lock` is never touched.
 * @param {Record<string, string|undefined>} [env] Environment holding the override.
 * @returns {string} Absolute lock file path.
 */
export function resolveLockPath(env = process.env) {
  if (env.GITBUG_LOCK_PATH) return path.resolve(env.GITBUG_LOCK_PATH);
  const result = execGit(['rev-parse', '--git-common-dir']);
  const commonDir = result.status === EXIT_OK && result.stdout.trim() !== '' ? result.stdout.trim() : '.git';
  return path.resolve(commonDir, LOCK_BASENAME);
}

/**
 * Derive the lock file's command label from the wrapper argv. Only the
 * top-level verb is recorded: argument values (ticket titles, comment bodies)
 * must never be written to the lock file or timeout errors.
 * @param {string[]} rest Wrapper argv with global flags stripped.
 * @returns {string} The invoked verb (or `unknown` when absent).
 */
export function lockCommandFor(rest) {
  if (!Array.isArray(rest) || rest.length === 0 || typeof rest[0] !== 'string' || rest[0] === '') {
    return 'unknown';
  }
  return rest[0];
}

/**
 * Parse a lock timeout value.
 * @param {unknown} raw Candidate value.
 * @param {string} source Flag/env name used in the error message.
 * @returns {number} Validated non-negative integer (milliseconds).
 */
function parseLockTimeoutValue(raw, source) {
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw usage(`${source} must be a non-negative integer (got ${JSON.stringify(text)})`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw usage(`${source} is out of range`);
  return value;
}

/**
 * Resolve the timeout from the environment when no flag was given.
 * @param {Record<string, string|undefined>} [env] Environment to read.
 * @returns {number} Timeout in milliseconds.
 */
function readLockTimeoutEnv(env = process.env) {
  const raw = env.GITBUG_LOCK_TIMEOUT;
  if (raw === undefined || raw === '') return DEFAULT_LOCK_TIMEOUT_MS;
  return parseLockTimeoutValue(raw, 'GITBUG_LOCK_TIMEOUT');
}

/**
 * Read the lock file's metadata without throwing.
 * @param {string} lockPath Lock file path.
 * @returns {{parsed: Record<string, unknown>|null, stat: import('node:fs').Stats|null}} Snapshot.
 */
function inspectLock(lockPath) {
  let stat = null;
  try {
    stat = statSync(lockPath);
  } catch {
    stat = null;
  }
  let parsed = null;
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (value !== null && typeof value === 'object') parsed = value;
  } catch {
    parsed = null;
  }
  return { parsed, stat };
}

/**
 * Age of the lock, preferring the holder's `startedAt` over the file mtime.
 * @param {{parsed: Record<string, unknown>|null, stat: import('node:fs').Stats|null}} inspected Snapshot.
 * @param {number} now Current epoch milliseconds.
 * @returns {number} Age in milliseconds (never negative).
 */
function lockAgeMs(inspected, now) {
  const startedAt = inspected.parsed && typeof inspected.parsed.startedAt === 'string'
    ? Date.parse(inspected.parsed.startedAt)
    : Number.NaN;
  if (Number.isFinite(startedAt)) return Math.max(0, now - startedAt);
  return inspected.stat ? Math.max(0, now - inspected.stat.mtimeMs) : 0;
}

/**
 * Check whether a pid is alive.
 * @param {number} pid Process id.
 * @returns {boolean} True when the process exists (or cannot be probed).
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Decide whether an existing lock is stale and may be reclaimed: dead holder on
 * this host, or the hard cap exceeded (same host, or unparseable metadata).
 * @param {{parsed: Record<string, unknown>|null, stat: import('node:fs').Stats|null}} inspected Snapshot.
 * @param {string} hostname Current hostname.
 * @param {number} now Current epoch milliseconds.
 * @returns {boolean} True when the lock may be removed.
 */
function isLockReclaimable(inspected, hostname, now) {
  if (!inspected.parsed) return lockAgeMs(inspected, now) > LOCK_HARD_CAP_MS;
  if (inspected.parsed.hostname !== hostname) return false;
  const pid = Number(inspected.parsed.pid);
  if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) return true;
  return lockAgeMs(inspected, now) > LOCK_HARD_CAP_MS;
}

/**
 * Human-readable holder description for timeout errors.
 * @param {{parsed: Record<string, unknown>|null, stat: import('node:fs').Stats|null}} inspected Snapshot.
 * @param {number} now Current epoch milliseconds.
 * @returns {string} Description naming pid, host, age, and command.
 */
function formatLockHolder(inspected, now) {
  const ageMs = Math.round(lockAgeMs(inspected, now));
  if (!inspected.parsed) return `unparseable or empty metadata, age ${ageMs}ms`;
  const command = typeof inspected.parsed.command === 'string' && inspected.parsed.command.trim() !== ''
    ? inspected.parsed.command.replace(/\s+/g, ' ').slice(0, 160)
    : 'unknown';
  return `pid ${inspected.parsed.pid ?? 'unknown'} on ${inspected.parsed.hostname ?? 'unknown host'}, `
    + `age ${ageMs}ms, command: ${command}`;
}

/**
 * Build the fail-closed timeout error.
 * @param {string} lockPath Lock file path.
 * @param {{parsed: Record<string, unknown>|null, stat: import('node:fs').Stats|null}} inspected Snapshot.
 * @param {number} timeoutMs Configured timeout.
 * @param {number} now Current epoch milliseconds.
 * @returns {Error & {exitCode: number}} Error carrying exit code 1.
 */
function lockTimeoutError(lockPath, inspected, timeoutMs, now) {
  const error = new Error(
    `timed out after ${timeoutMs}ms waiting for lock ${lockPath} `
    + `(held by ${formatLockHolder(inspected, now)}); refusing to run without the lock`
  );
  error.exitCode = EXIT_FAIL;
  return error;
}

/**
 * Acquire the advisory invocation lock for this process. The atomic `O_EXCL`
 * create is the mutex; on `EEXIST` the holder is inspected and stale locks are
 * reclaimed, otherwise the call sleeps with jittered backoff until `timeoutMs`.
 * @param {string} lockPath Lock file path.
 * @param {{command?: string, timeoutMs?: number, hostname?: string,
 *   now?: () => number, sleep?: (ms: number) => void}} [options] Lock options.
 * @returns {{path: string, nonce: string, pid: number, hostname: string,
 *   startedAt: string, command: string}} Handle for `releaseLock`.
 */
export function acquireLock(lockPath, options = {}) {
  const {
    command = '',
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    hostname = osHostname(),
    now = () => Date.now(),
    sleep = sleepSync,
  } = options;

  const handle = {
    nonce: randomUUID(),
    pid: process.pid,
    hostname,
    startedAt: new Date().toISOString(),
    command,
  };
  const deadline = now() + timeoutMs;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${JSON.stringify(handle)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { ...handle, path: lockPath };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const inspected = inspectLock(lockPath);
    if (isLockReclaimable(inspected, hostname, now())) {
      let reclaimed = false;
      try {
        unlinkSync(lockPath);
        reclaimed = true;
      } catch {
        // Either another waiter reclaimed it first (ENOENT) or unlink is
        // failing persistently; fall through to the deadline + backoff sleep
        // so this branch can never spin.
      }
      if (reclaimed) continue;
    }
    if (now() >= deadline) throw lockTimeoutError(lockPath, inspected, timeoutMs, now());
    sleep(lockBackoffDelay(attempt));
  }
}

/**
 * Release the lock, but only when the file still carries our nonce (never a
 * foreign or reclaimed lock).
 * @param {{path: string, nonce: string}|null} handle Handle returned by `acquireLock`.
 * @returns {boolean} True when our lock file was removed.
 */
export function releaseLock(handle) {
  if (!handle || typeof handle.path !== 'string' || typeof handle.nonce !== 'string') return false;
  let current = null;
  try {
    current = JSON.parse(readFileSync(handle.path, 'utf8'));
  } catch {
    return false;
  }
  if (!current || current.nonce !== handle.nonce) return false;
  try {
    unlinkSync(handle.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` with the advisory lock held. Releases in `finally`; SIGINT/SIGTERM
 * trigger a best-effort release before the default signal disposition. The
 * handlers survive one extra event-loop turn because a signal received during
 * a blocking `spawnSync` is delivered only after the call returns.
 * @param {{lockPath: string, command?: string, timeoutMs?: number}} options Lock options.
 * @param {() => number} fn Work to run under the lock.
 * @returns {number} `fn`'s return value.
 */
export function withLock(options, fn) {
  const handle = acquireLock(options.lockPath, options);
  let released = false;
  /** @type {Array<{signal: string, handler: () => void}>} */
  const handlers = [];
  const release = () => {
    if (!released) {
      released = true;
      releaseLock(handle);
    }
  };
  const onSignal = (signal) => {
    for (const entry of handlers) process.off(entry.signal, entry.handler);
    release();
    process.kill(process.pid, signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => onSignal(signal);
    process.on(signal, handler);
    handlers.push({ signal, handler });
  }
  try {
    return fn();
  } finally {
    release();
    setImmediate(() => {
      for (const entry of handlers) process.off(entry.signal, entry.handler);
    });
  }
}

function runGit(args, global, input) {
  if (global.dryRun) {
    process.stdout.write(`${formatCommand(args)}\n`);
    return { status: EXIT_OK, stdout: '', stderr: '' };
  }
  const result = execGit(args, input);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function listRefs() {
  const result = execGit(['for-each-ref', '--format=%(refname)', 'refs/bugs']);
  if (result.status !== 0) throw new Error('could not enumerate refs/bugs');
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

function resolveOrThrow(ref) {
  const result = resolveTicketRef(ref, listRefs());
  if (result.ok) return result;
  if (result.reason === 'ambiguous') {
    throw new Error(`ambiguous ticket ref ${JSON.stringify(result.ref)} (${result.matches.length}+ matches)`);
  }
  throw new Error(`no such ticket: ${JSON.stringify(ref)}`);
}

function readBodyFile(file) {
  try {
    return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  } catch (err) {
    throw usage(`cannot read --body-file ${JSON.stringify(file)}: ${err.code || 'read error'}`);
  }
}

function validateOrThrow(labels) {
  const result = validateLabels(labels);
  if (!result.ok) {
    const detail = result.invalid.map((entry) => entry.reason).join('; ');
    throw usage(`invalid label(s): ${detail}`);
  }
}

function cmdList(tokens, global) {
  const { opts, positional } = parseOptions(tokens, { strings: ['--status', '--label'], bools: ['--json'] });
  if (positional.length > 0) throw usage(`list takes no positional arguments (got ${JSON.stringify(positional[0])})`);
  const args = ['bug', 'bug'];
  const status = single(opts.status, '--status');
  if (status !== undefined) {
    if (!VALID_STATUS.has(status)) throw usage(`invalid --status ${JSON.stringify(status)} (expected open|closed)`);
    args.push('-s', status);
  }
  const labels = opts.label || [];
  validateOrThrow(labels);
  for (const label of labels) args.push('-l', label);
  args.push('-f', opts.json ? 'json' : 'plain');
  const result = runGit(args, global);
  if (result.status !== EXIT_OK) throw new Error(`list failed (exit ${result.status})`);
  return EXIT_OK;
}

function cmdShow(tokens, global) {
  const { opts, positional } = parseOptions(tokens, { bools: ['--json'] });
  if (positional.length === 0) throw usage('show requires <ref>');
  if (positional.length > 1) throw usage('show takes exactly one <ref>');
  const resolved = resolveOrThrow(positional[0]);
  const args = ['bug', 'bug', 'show'];
  if (opts.json) args.push('-f', 'json');
  args.push(resolved.id);
  const result = runGit(args, global);
  if (result.status !== EXIT_OK) throw new Error(`show failed (exit ${result.status})`);
  return EXIT_OK;
}

function cmdResolve(tokens) {
  const { positional } = parseOptions(tokens);
  if (positional.length !== 1) throw usage('resolve requires exactly one <ref>');
  const result = resolveTicketRef(positional[0], listRefs());
  if (!result.ok) {
    process.stderr.write(`gitbug: no such ticket: ${JSON.stringify(positional[0])}\n`);
    return EXIT_FAIL;
  }
  process.stdout.write(`${result.shortId}\n`);
  return EXIT_OK;
}

function cmdNew(tokens, global) {
  const { opts, positional } = parseOptions(tokens, {
    strings: ['--title', '--body', '--body-file', '--label'],
    bools: ['--title-from-body'],
  });
  if (positional.length > 0) throw usage(`new takes no positional arguments (got ${JSON.stringify(positional[0])})`);
  const labels = opts.label || [];
  validateOrThrow(labels);
  const title = single(opts.title, '--title');
  const body = single(opts.body, '--body');
  const bodyFile = single(opts['body-file'], '--body-file');
  if (body !== undefined && bodyFile !== undefined) {
    throw usage('--body and --body-file are mutually exclusive');
  }
  const bodyFileContent = bodyFile !== undefined ? readBodyFile(bodyFile) : undefined;
  const built = buildNewArgs({ title, body, bodyFileContent, titleFromBody: opts['title-from-body'] === true });
  if (global.dryRun) {
    runGit(built.args, global, built.stdin);
    for (const label of labels) {
      process.stdout.write(`${formatCommand(['bug', 'bug', 'label', 'new', '<new-id>', label])}\n`);
    }
    return EXIT_OK;
  }
  const before = listRefs();
  const result = runGit(built.args, global, built.stdin);
  if (result.status !== EXIT_OK) throw new Error(`new failed (exit ${result.status})`);
  if (labels.length > 0) {
    const after = listRefs();
    const added = after.filter((name) => !before.includes(name));
    if (added.length !== 1) {
      throw new Error('created bug but could not identify it to apply labels');
    }
    const id = added[0].replace(/^refs\/bugs\//, '');
    const labelResult = runGit(['bug', 'bug', 'label', 'new', id, ...labels], global);
    if (labelResult.status !== EXIT_OK) throw new Error(`label new failed (exit ${labelResult.status})`);
  }
  return EXIT_OK;
}

function readCommentBody(opts) {
  const body = single(opts.body, '--body');
  const bodyFile = single(opts['body-file'], '--body-file');
  if (body !== undefined && bodyFile !== undefined) {
    throw usage('--body and --body-file are mutually exclusive');
  }
  if (body === undefined && bodyFile === undefined) {
    throw usage('comment requires --body or --body-file');
  }
  return { body, bodyFileContent: bodyFile !== undefined ? readBodyFile(bodyFile) : undefined };
}

function cmdComment(tokens, global) {
  const { opts, positional } = parseOptions(tokens, { strings: ['--body', '--body-file'] });
  if (positional.length !== 1) throw usage('comment requires exactly one <ref>');
  const { body, bodyFileContent } = readCommentBody(opts);
  const resolved = resolveOrThrow(positional[0]);
  const built = buildCommentArgs({ body, bodyFileContent });
  built.args.push(resolved.id);
  const result = runGit(built.args, global, built.stdin);
  if (result.status !== EXIT_OK) throw new Error(`comment failed (exit ${result.status})`);
  return EXIT_OK;
}

function cmdStatus(tokens, global, action) {
  const { positional } = parseOptions(tokens);
  if (positional.length !== 1) throw usage(`${action} requires exactly one <ref>`);
  const resolved = resolveOrThrow(positional[0]);
  const result = runGit(['bug', 'bug', 'status', action, resolved.id], global);
  if (result.status !== EXIT_OK) throw new Error(`${action} failed (exit ${result.status})`);
  return EXIT_OK;
}

function cmdLabels(tokens, global) {
  const { positional } = parseOptions(tokens);
  if (positional.length > 0) throw usage('labels takes no arguments');
  const result = runGit(['bug', 'label'], global);
  if (result.status !== EXIT_OK) throw new Error(`labels failed (exit ${result.status})`);
  return EXIT_OK;
}

function dispatch(command, tokens, global) {
  switch (command) {
    case 'list': return cmdList(tokens, global);
    case 'show': return cmdShow(tokens, global);
    case 'resolve': return cmdResolve(tokens);
    case 'new': return cmdNew(tokens, global);
    case 'comment': return cmdComment(tokens, global);
    case 'close': return cmdStatus(tokens, global, 'close');
    case 'open': return cmdStatus(tokens, global, 'open');
    case 'labels': return cmdLabels(tokens, global);
    default: throw usage(`unknown command: ${JSON.stringify(command)} (see --help)`);
  }
}

/**
 * Run the wrapper. Every known command except `--dry-run` and `--help` runs
 * under the advisory invocation lock.
 * @param {string[]} argv Arguments after `node scripts/gitbug.mjs`.
 * @returns {number} Process exit code.
 */
export function main(argv = []) {
  try {
    const { global, rest } = parse(argv);
    if (global.help || rest.length === 0) {
      const target = rest.length === 0 && !global.help ? process.stderr : process.stdout;
      target.write(`${USAGE}\n`);
      return global.help ? EXIT_OK : EXIT_USAGE;
    }
    const command = rest[0];
    const tokens = rest.slice(1);
    if (!LOCKABLE_COMMANDS.has(command)) {
      throw usage(`unknown command: ${JSON.stringify(command)} (see --help)`);
    }
    if (global.dryRun) return dispatch(command, tokens, global);
    const timeoutMs = global.lockTimeout !== undefined ? global.lockTimeout : readLockTimeoutEnv();
    const lockPath = resolveLockPath();
    const lockCommand = lockCommandFor(rest);
    return withLock({ lockPath, command: lockCommand, timeoutMs }, () => dispatch(command, tokens, global));
  } catch (err) {
    const code = err && err.exitCode ? err.exitCode : EXIT_FAIL;
    process.stderr.write(`gitbug: ${err && err.message ? err.message : 'unexpected failure'}\n`);
    if (code === EXIT_USAGE) process.stderr.write(`${USAGE}\n`);
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
