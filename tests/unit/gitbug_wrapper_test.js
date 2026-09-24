/**
 * @file tests/unit/gitbug_wrapper_test.js
 * @description Unit tests for `scripts/gitbug.mjs`: the pure functions, the
 * advisory invocation lock (`resolveLockPath`/`acquireLock`/`releaseLock`/
 * `withLock`), and one read-only `list --json` smoke against this repository.
 * No tracker state is mutated; the smoke asserts `refs/bugs` is byte-identical
 * before and after.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateLabel,
  validateLabels,
  resolveTicketRef,
  buildNewArgs,
  buildCommentArgs,
  main,
  resolveLockPath,
  acquireLock,
  releaseLock,
  withLock,
} from '../../scripts/gitbug.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/gitbug.mjs', import.meta.url));

/** Real git, captured before any shim directory overrides `PATH`. */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/** Per-file scratch root, removed after the suite. */
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbug-wrapper-unit-'));
after(() => fs.rmSync(TEST_TMP, { recursive: true, force: true }));

/**
 * Create a unique scratch subdirectory.
 * @param {string} name Label for the directory.
 * @returns {string} Absolute path.
 */
function makeTempDir(name) {
  return fs.mkdtempSync(path.join(TEST_TMP, `${name}-`));
}

/**
 * Spawn one wrapper invocation and collect its streams.
 * @param {string[]} args Wrapper argv.
 * @param {NodeJS.ProcessEnv} env Child environment.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} Result.
 */
function spawnWrapper(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Install a fake `git` first on `PATH`. Every invocation appends
 * `lock=<bool> args=<...>` to `GITBUG_TEST_MARKER`; `bug bug` exits 0, all
 * other subcommands delegate to the real git.
 * @param {string} binDir Directory to place the shim in.
 * @returns {void}
 */
function writeGitShim(binDir) {
  const shim = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const held = fs.existsSync(process.env.GITBUG_LOCK_PATH);
fs.appendFileSync(process.env.GITBUG_TEST_MARKER, 'lock=' + held + ' args=' + args.join(' ') + '\\n');
if (args[0] === 'bug' && args[1] === 'bug') process.exit(0);
const result = spawnSync(process.env.GITBUG_TEST_REAL_GIT, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'git'), shim, { mode: 0o755 });
}

/**
 * Write a lock file carrying a live same-host holder.
 * @param {string} lockPath Lock file path.
 * @param {string} command Holder command label.
 * @returns {void}
 */
function writeLiveHolderLock(lockPath, command) {
  fs.writeFileSync(lockPath, `${JSON.stringify({
    nonce: 'unit-holder-nonce',
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    command,
  })}\n`);
}

function snapshotRefs() {
  const result = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, 'git for-each-ref refs/bugs must succeed');
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

test('validateLabel accepts canonical prefixes and legacy labels', () => {
  for (const label of ['area:settings', 'sev:major', 'type:bug', 'prog:encapsulation', 'prio:high', 'qa', 'mod-21', 'security', 'audit-fail']) {
    assert.deepStrictEqual(validateLabel(label), { ok: true }, `${label} should be valid`);
  }
});

test('validateLabel rejects empty, whitespace, unknown prefix, unknown bare, and empty value', () => {
  assert.strictEqual(validateLabel('').ok, false);
  assert.strictEqual(validateLabel('a b').ok, false);
  assert.strictEqual(validateLabel('area:with space').ok, false);
  assert.strictEqual(validateLabel('foo').ok, false);
  assert.strictEqual(validateLabel('bogus:value').ok, false);
  assert.strictEqual(validateLabel('area:').ok, false);
  assert.match(validateLabel('').reason, /empty/);
  assert.match(validateLabel('a b').reason, /whitespace/);
});

test('validateLabels aggregates only the invalid labels', () => {
  const result = validateLabels(['qa', 'area:tooling', 'nope', 'sev:']);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.invalid.map((entry) => entry.label), ['nope', 'sev:']);
  assert.deepStrictEqual(validateLabels(['qa', 'area:tooling']), { ok: true, invalid: [] });
});

const REFS = [
  'refs/bugs/bb977919c94e16f4682bc3834294c05323f54de96faed3df05f0e4f8dfdc3756',
  'refs/bugs/816e77e7a0f29da84dfcf31f0297aea9b367838d36da0e14113f542c0416acff',
  'refs/bugs/06f1ecb36353ecb405ab28e7fc6d00e350da41c849a32e509141f37285fbbb33',
];

test('resolveTicketRef resolves short ids, prefixes, full ids, and full ref names', () => {
  const expected = 'bb977919c94e16f4682bc3834294c05323f54de96faed3df05f0e4f8dfdc3756';
  for (const ref of ['bb97791', 'bb9779', expected, `refs/bugs/${expected}`, 'BB97791']) {
    const result = resolveTicketRef(ref, REFS);
    assert.strictEqual(result.ok, true, `${ref} should resolve`);
    assert.strictEqual(result.id, expected);
    assert.strictEqual(result.shortId, 'bb97791');
  }
});

test('resolveTicketRef fails on unknown and ambiguous refs without falling back', () => {
  assert.deepStrictEqual(resolveTicketRef('deadbeef', REFS), { ok: false, reason: 'not-found', ref: 'deadbeef' });
  assert.deepStrictEqual(resolveTicketRef('', REFS), { ok: false, reason: 'empty' });
  const ambiguous = resolveTicketRef('0', [
    'refs/bugs/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'refs/bugs/0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  assert.strictEqual(ambiguous.ok, false);
  assert.strictEqual(ambiguous.reason, 'ambiguous');
  assert.strictEqual(ambiguous.matches.length, 2);
});

test('buildNewArgs default mode honours -t via -m and never emits -F with -t', () => {
  const built = buildNewArgs({ title: 'A title', body: 'A body' });
  assert.deepStrictEqual(built.args, ['bug', 'bug', 'new', '--non-interactive', '-t', 'A title', '-m', 'A body']);
  assert.strictEqual(built.stdin, null);
  assert.ok(!(built.args.includes('-t') && built.args.includes('-F')), '-t and -F must never coexist');
});

test('buildNewArgs --title-from-body uses -F - with stdin and omits -t', () => {
  const built = buildNewArgs({ body: 'first line\nsecond line', titleFromBody: true });
  assert.deepStrictEqual(built.args, ['bug', 'bug', 'new', '--non-interactive', '-F', '-']);
  assert.strictEqual(built.stdin, 'first line\nsecond line');
  assert.ok(!(built.args.includes('-t') && built.args.includes('-F')), '-t and -F must never coexist');

  const withTitle = buildNewArgs({ title: 'ignored', body: 'first', titleFromBody: true });
  assert.deepStrictEqual(withTitle.args, ['bug', 'bug', 'new', '--non-interactive', '-F', '-']);
  assert.ok(!(withTitle.args.includes('-t') && withTitle.args.includes('-F')), '-t and -F must never coexist');
});

test('buildNewArgs throws on missing title or body', () => {
  assert.throws(() => buildNewArgs({ body: 'only body' }), { exitCode: 2 });
  assert.throws(() => buildNewArgs({ title: 'only title' }), { exitCode: 2 });
  assert.throws(() => buildNewArgs({ titleFromBody: true }), { exitCode: 2 });
});

test('buildCommentArgs always passes --non-interactive and -m', () => {
  const built = buildCommentArgs({ body: 'hello' });
  assert.deepStrictEqual(built.args, ['bug', 'bug', 'comment', 'new', '--non-interactive', '-m', 'hello']);
  assert.throws(() => buildCommentArgs({}), { exitCode: 2 });
});

test('main returns exit code 2 for invalid labels without touching git', () => {
  const lockPath = path.join(makeTempDir('labels'), 'wrapper.lock');
  const previousLockPath = process.env.GITBUG_LOCK_PATH;
  process.env.GITBUG_LOCK_PATH = lockPath;
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.strictEqual(main(['list', '--label', 'a b']), 2);
    assert.strictEqual(main(['list', '--label', 'bogus:thing']), 2);
    assert.strictEqual(main(['list', '--status', 'archived']), 2);
    assert.strictEqual(fs.existsSync(lockPath), false, 'usage failures must still release the lock');
  } finally {
    process.stderr.write = originalWrite;
    if (previousLockPath === undefined) delete process.env.GITBUG_LOCK_PATH;
    else process.env.GITBUG_LOCK_PATH = previousLockPath;
  }
});

test('resolveLockPath honours GITBUG_LOCK_PATH and resolves the git common dir otherwise', () => {
  assert.strictEqual(
    resolveLockPath({ GITBUG_LOCK_PATH: path.join(TEST_TMP, 'override.lock') }),
    path.join(TEST_TMP, 'override.lock')
  );
  assert.strictEqual(resolveLockPath({ GITBUG_LOCK_PATH: 'relative/lock' }), path.resolve('relative/lock'));
  assert.strictEqual(
    resolveLockPath({ GITBUG_LOCK_PATH: '' }),
    path.resolve(spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim() || '.git', 'gitbug-wrapper.lock')
  );
  const defaultPath = resolveLockPath({});
  assert.strictEqual(path.isAbsolute(defaultPath), true, 'the default lock path must be absolute');
  assert.strictEqual(path.basename(defaultPath), 'gitbug-wrapper.lock');
  assert.ok(!defaultPath.includes(path.join('.git', 'git-bug')), 'git-bug\'s own lock must never be used');
});

test('resolveLockPath is absolute and shared between linked worktrees', () => {
  const mainRepo = makeTempDir('worktree-main');
  spawnSync('git', ['init', '-q'], { cwd: mainRepo });
  spawnSync('git', ['-c', 'user.email=probe@example.com', '-c', 'user.name=Probe', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: mainRepo });
  const worktree = path.join(makeTempDir('worktree-link'), 'wt');
  const added = spawnSync('git', ['worktree', 'add', '-q', worktree, '-b', 'probe-branch'], { cwd: mainRepo, encoding: 'utf8' });
  assert.strictEqual(added.status, 0, `git worktree add failed: ${added.stderr}`);

  const previousCwd = process.cwd();
  try {
    process.chdir(mainRepo);
    const mainPath = resolveLockPath({});
    process.chdir(worktree);
    const worktreePath = resolveLockPath({});
    assert.strictEqual(path.isAbsolute(mainPath), true);
    assert.strictEqual(worktreePath, mainPath, 'worktrees must share one lock file');
  } finally {
    process.chdir(previousCwd);
  }
});

test('acquireLock writes holder metadata and releaseLock removes our own lock', () => {
  const lockPath = path.join(makeTempDir('acquire'), 'wrapper.lock');
  const handle = acquireLock(lockPath, { command: 'gitbug list --json', timeoutMs: 0 });

  assert.strictEqual(handle.path, lockPath);
  assert.strictEqual(typeof handle.nonce, 'string');
  const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['command', 'hostname', 'nonce', 'pid', 'startedAt']);
  assert.strictEqual(parsed.pid, process.pid);
  assert.strictEqual(parsed.hostname, os.hostname());
  assert.strictEqual(parsed.command, 'gitbug list --json');
  assert.ok(!Number.isNaN(Date.parse(parsed.startedAt)), 'startedAt must be an ISO timestamp');

  assert.strictEqual(releaseLock(handle), true);
  assert.strictEqual(fs.existsSync(lockPath), false, 'releaseLock must remove our lock');
});

test('releaseLock never removes a foreign or unparseable lock', () => {
  const lockPath = path.join(makeTempDir('nonce'), 'wrapper.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ nonce: 'foreign-nonce', pid: 1 })}\n`);
  assert.strictEqual(releaseLock({ path: lockPath, nonce: 'our-nonce' }), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, 'foreign-nonce');

  fs.writeFileSync(lockPath, 'not json at all');
  assert.strictEqual(releaseLock({ path: lockPath, nonce: 'our-nonce' }), false);
  assert.strictEqual(fs.existsSync(lockPath), true, 'an unparseable lock must be left for the stale check');

  fs.writeFileSync(lockPath, `${JSON.stringify({ nonce: 'our-nonce' })}\n`);
  assert.strictEqual(releaseLock({ path: lockPath, nonce: 'our-nonce' }), true);
  assert.strictEqual(fs.existsSync(lockPath), false);
  assert.strictEqual(releaseLock(null), false);
});

test('acquireLock times out with holder pid, age, command, and lock path', () => {
  const lockPath = path.join(makeTempDir('timeout'), 'wrapper.lock');
  writeLiveHolderLock(lockPath, 'gitbug list --json');

  assert.throws(
    () => acquireLock(lockPath, { timeoutMs: 0, command: 'gitbug show 1234567' }),
    (err) => {
      assert.strictEqual(err.exitCode, 1);
      assert.match(err.message, /timed out after 0ms/);
      assert.ok(err.message.includes(lockPath), 'timeout must name the lock path');
      assert.match(err.message, new RegExp(`pid ${process.pid}`));
      assert.match(err.message, /age \d+ms/);
      assert.match(err.message, /gitbug list --json/);
      assert.match(err.message, /refusing to run without the lock/);
      return true;
    }
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, 'unit-holder-nonce');
});

test('acquireLock reclaims a lock whose same-host holder pid is dead', () => {
  const lockPath = path.join(makeTempDir('deadpid'), 'wrapper.lock');
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.strictEqual(typeof exited.pid, 'number', 'spawnSync must report the child pid');
  fs.writeFileSync(lockPath, `${JSON.stringify({
    nonce: 'dead-holder',
    pid: exited.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    command: 'gitbug crashed',
  })}\n`);

  const handle = acquireLock(lockPath, { timeoutMs: 0, command: 'gitbug list' });
  assert.notStrictEqual(handle.nonce, 'dead-holder');
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, handle.nonce);
  assert.strictEqual(releaseLock(handle), true);
});

test('acquireLock reclaims locks past the hard cap (old startedAt, or unparseable with old mtime)', () => {
  const lockPath = path.join(makeTempDir('hardcap'), 'wrapper.lock');
  const past = Date.now() - 16 * 60 * 1000;

  fs.writeFileSync(lockPath, `${JSON.stringify({
    nonce: 'old-live-holder',
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date(past).toISOString(),
    command: 'gitbug stuck',
  })}\n`);
  const first = acquireLock(lockPath, { timeoutMs: 0, command: 'gitbug list' });
  assert.notStrictEqual(first.nonce, 'old-live-holder');
  assert.strictEqual(releaseLock(first), true);

  fs.writeFileSync(lockPath, 'garbage lock content');
  const oldTime = new Date(past);
  fs.utimesSync(lockPath, oldTime, oldTime);
  const second = acquireLock(lockPath, { timeoutMs: 0, command: 'gitbug list' });
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, second.nonce);
  assert.strictEqual(releaseLock(second), true);
});

test('withLock releases the lock when the callback throws', () => {
  const lockPath = path.join(makeTempDir('withlock'), 'wrapper.lock');
  assert.throws(
    () => withLock({ lockPath, command: 'gitbug boom', timeoutMs: 0 }, () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.strictEqual(fs.existsSync(lockPath), false, 'a throwing callback must not leak the lock');
});

test('wrapper holds GITBUG_LOCK_PATH across the underlying git call and releases it after', async () => {
  const tmp = makeTempDir('isolation');
  const lockPath = path.join(tmp, 'wrapper.lock');
  const marker = path.join(tmp, 'marker.log');
  const binDir = path.join(tmp, 'bin');
  writeGitShim(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GITBUG_TEST_REAL_GIT: REAL_GIT,
    GITBUG_TEST_MARKER: marker,
    GITBUG_LOCK_PATH: lockPath,
  };

  const result = await spawnWrapper(['list', '--json'], env);
  assert.strictEqual(result.code, 0, `list must succeed: ${result.stderr}`);
  const lines = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepStrictEqual(lines, [`lock=true args=bug bug -f json`]);
  assert.strictEqual(fs.existsSync(lockPath), false, 'the lock must be released after the command');
});

test('wrapper queues behind a held lock instead of failing', async () => {
  const tmp = makeTempDir('queue');
  const lockPath = path.join(tmp, 'wrapper.lock');
  const marker = path.join(tmp, 'marker.log');
  const binDir = path.join(tmp, 'bin');
  writeGitShim(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GITBUG_TEST_REAL_GIT: REAL_GIT,
    GITBUG_TEST_MARKER: marker,
    GITBUG_LOCK_PATH: lockPath,
  };

  writeLiveHolderLock(lockPath, 'gitbug holder');
  const started = Date.now();
  const pending = spawnWrapper(['list', '--json', '--lock-timeout', '5000'], env);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  fs.unlinkSync(lockPath);
  const result = await pending;
  const waited = Date.now() - started;

  assert.strictEqual(result.code, 0, `queued call must succeed: ${result.stderr}`);
  assert.ok(waited >= 250, `wrapper must have waited for the lock (waited ${waited}ms)`);
  assert.match(fs.readFileSync(marker, 'utf8'), /lock=true args=bug bug -f json/);
  assert.strictEqual(fs.existsSync(lockPath), false);
});

test('wrapper fails closed with holder details when the lock times out', async () => {
  const tmp = makeTempDir('failclosed');
  const lockPath = path.join(tmp, 'wrapper.lock');
  const marker = path.join(tmp, 'marker.log');
  const binDir = path.join(tmp, 'bin');
  writeGitShim(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GITBUG_TEST_REAL_GIT: REAL_GIT,
    GITBUG_TEST_MARKER: marker,
    GITBUG_LOCK_PATH: lockPath,
  };

  writeLiveHolderLock(lockPath, 'gitbug list --status open');
  const result = await spawnWrapper(['list', '--json', '--lock-timeout', '0'], env);

  assert.strictEqual(result.code, 1);
  assert.match(result.stderr, /timed out after 0ms/);
  assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
  assert.match(result.stderr, /gitbug list --status open/);
  assert.match(result.stderr, /refusing to run without the lock/);
  assert.strictEqual(fs.existsSync(marker), false, 'the wrapper must never run git unlocked');
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, 'unit-holder-nonce');
});

test('GITBUG_LOCK_TIMEOUT is honoured and validated', async () => {
  const tmp = makeTempDir('envtimeout');
  const lockPath = path.join(tmp, 'wrapper.lock');

  const invalid = spawnSync(process.execPath, [SCRIPT, 'list'], {
    encoding: 'utf8',
    env: { ...process.env, GITBUG_LOCK_PATH: lockPath, GITBUG_LOCK_TIMEOUT: 'abc' },
  });
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /GITBUG_LOCK_TIMEOUT must be a non-negative integer/);

  writeLiveHolderLock(lockPath, 'gitbug holder');
  const timedOut = await spawnWrapper(['list', '--json'], {
    ...process.env,
    GITBUG_LOCK_PATH: lockPath,
    GITBUG_LOCK_TIMEOUT: '0',
  });
  assert.strictEqual(timedOut.code, 1);
  assert.match(timedOut.stderr, /timed out after 0ms/);
});

test('--lock-timeout is validated and documented in usage', () => {
  const missing = spawnSync(process.execPath, [SCRIPT, 'list', '--lock-timeout'], { encoding: 'utf8' });
  assert.strictEqual(missing.status, 2);
  assert.match(missing.stderr, /missing value for --lock-timeout/);

  const invalid = spawnSync(process.execPath, [SCRIPT, 'list', '--lock-timeout', 'abc'], { encoding: 'utf8' });
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /--lock-timeout must be a non-negative integer/);

  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /--lock-timeout <ms>/);
  assert.match(help.stdout, /GITBUG_LOCK_TIMEOUT/);
});

test('--dry-run and --help never take the lock or wait', async () => {
  const tmp = makeTempDir('nolock');
  const lockPath = path.join(tmp, 'wrapper.lock');
  const marker = path.join(tmp, 'marker.log');
  const binDir = path.join(tmp, 'bin');
  writeGitShim(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GITBUG_TEST_REAL_GIT: REAL_GIT,
    GITBUG_TEST_MARKER: marker,
    GITBUG_LOCK_PATH: lockPath,
  };

  writeLiveHolderLock(lockPath, 'gitbug holder');
  const started = Date.now();
  const dryRun = await spawnWrapper(['--dry-run', 'list', '--json'], env);
  assert.strictEqual(dryRun.code, 0);
  assert.match(dryRun.stdout, /git bug bug -f json/);
  assert.ok(Date.now() - started < 5000, 'dry-run must not wait on the lock');
  assert.strictEqual(fs.existsSync(marker), false, 'dry-run must not invoke git-bug');
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, 'unit-holder-nonce');

  const help = await spawnWrapper(['--help'], env);
  assert.strictEqual(help.code, 0);
  assert.match(help.stdout, /Usage: gitbug/);
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce, 'unit-holder-nonce');
});

test('smoke: list --json parses to an array and leaves refs/bugs untouched', () => {
  const before = snapshotRefs();
  const lockPath = path.join(makeTempDir('smoke'), 'wrapper.lock');
  const result = spawnSync(process.execPath, [SCRIPT, 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GITBUG_LOCK_PATH: lockPath },
  });
  assert.strictEqual(result.status, 0, `list --json failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed), 'list --json must be a JSON array');
  assert.ok(parsed.length > 0, 'repository should have at least one ticket');
  for (const ticket of parsed) {
    assert.strictEqual(typeof ticket, 'object');
    assert.strictEqual(typeof ticket.id, 'string');
    assert.strictEqual(typeof (ticket.shortId ?? ticket.human_id), 'string');
    assert.strictEqual(typeof ticket.status, 'string');
  }
  assert.strictEqual(fs.existsSync(lockPath), false, 'the smoke lock must be released');
  assert.deepStrictEqual(snapshotRefs(), before, 'list --json must not mutate refs/bugs');
});
