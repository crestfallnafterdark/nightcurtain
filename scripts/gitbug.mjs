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
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const VALID_STATUS = new Set(['open', 'closed']);
const LABEL_PREFIXES = ['area', 'sev', 'type', 'prog', 'prio'];
const LEGACY_LABELS = new Set(['qa', 'mod-21', 'security', 'audit-fail']);

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
  --dry-run    Print the git argv that would run; perform no mutation.
  -h, --help   Show this help.

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
  const global = { dryRun: false, help: false };
  const rest = [];
  for (const token of argv) {
    if (token === '--dry-run') global.dryRun = true;
    else if (token === '--help' || token === '-h') global.help = true;
    else rest.push(token);
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

/**
 * Run the wrapper.
 * @param {string[]} argv Arguments after `node scripts/gitbug.mjs`.
 * @returns {number} Process exit code.
 */
export function main(argv = []) {
  const { global, rest } = parse(argv);
  if (global.help || rest.length === 0) {
    const target = rest.length === 0 && !global.help ? process.stderr : process.stdout;
    target.write(`${USAGE}\n`);
    return global.help ? EXIT_OK : EXIT_USAGE;
  }
  const command = rest[0];
  const tokens = rest.slice(1);
  try {
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
