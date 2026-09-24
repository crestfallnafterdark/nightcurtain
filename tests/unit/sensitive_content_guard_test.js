/**
 * @file tests/unit/sensitive_content_guard_test.js
 * @description Unit tests for the pre-commit sensitive-content guard:
 * `scripts/check_sensitive_content.mjs` (staged / --all-tracked / --paths
 * scans, deny-path / machine-path / credential / oversized / binary rules,
 * config merge, allowlist, JSON output) and `scripts/install_git_hooks.mjs`
 * (marked hook install, idempotency, foreign-hook refusal, uninstall).
 *
 * Every case runs in a throwaway git repository under `os.tmpdir()`; the real
 * checkout is never mutated. Synthetic credential strings are assembled at
 * runtime so this tracked test file never contains a literal the guard itself
 * would flag.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = fileURLToPath(new URL('../../scripts/check_sensitive_content.mjs', import.meta.url));
const INSTALLER = fileURLToPath(new URL('../../scripts/install_git_hooks.mjs', import.meta.url));

/** Per-file scratch root, removed after the suite. */
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-guard-unit-'));
after(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

// Synthetic samples, assembled at runtime (never literal in this file).
const FAKE_OPENAI_KEY = 'sk-' + 'F'.repeat(24);
const FAKE_AWS_KEY = 'AKIA' + 'Q'.repeat(16);
const FAKE_GITHUB_TOKEN = 'ghp_' + 'g'.repeat(24);
const FAKE_JWT = ['eyJ' + 'h'.repeat(12), 'p'.repeat(12), 's'.repeat(12)].join('.');
const FAKE_PRIVATE_KEY_MARKER = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const FAKE_ASSIGNMENT = 'api_key = "' + 'z'.repeat(20) + '"';

/**
 * Runs the guard checker and captures stdout/stderr.
 * @param {string} cwd Directory to run in.
 * @param {string[]} args CLI arguments.
 * @param {{ home?: string }} [options] Optional environment overrides.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Result.
 */
function runChecker(cwd, args, options = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  if (options.home) env.HOME = options.home;
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: 'utf8', env });
}

/**
 * Runs git in a directory.
 * @param {string} cwd Directory to run in.
 * @param {string[]} args Git arguments.
 * @param {{ allowFailure?: boolean }} [options] Options.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Result.
 */
function runGit(cwd, args, options = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

/**
 * Creates a throwaway git repository.
 * @returns {string} Absolute repository path.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'repo-'));
  runGit(dir, ['init', '-q']);
  return dir;
}

/**
 * Writes a file inside a repository, creating parent directories.
 * @param {string} repo Repository root.
 * @param {string} relPath Repository-relative path.
 * @param {string|Buffer} content File content.
 * @returns {string} Absolute file path.
 */
function writeFile(repo, relPath, content) {
  const abs = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/**
 * Stages paths with `git add -f` (force, so ignored paths are staged too).
 * @param {string} repo Repository root.
 * @param {string[]} relPaths Repository-relative paths.
 * @returns {void}
 */
function stagePaths(repo, relPaths) {
  runGit(repo, ['add', '-f', '--', ...relPaths]);
}

/**
 * Resolves the managed hook path for a repository.
 * @param {string} repo Repository root.
 * @returns {string} Absolute `pre-commit` hook path.
 */
function hookPathFor(repo) {
  const commonDir = runGit(repo, ['rev-parse', '--git-common-dir']).stdout.trim();
  return path.resolve(repo, commonDir, 'hooks', 'pre-commit');
}

/**
 * Runs the hook installer in a repository.
 * @param {string} repo Repository root.
 * @param {string[]} args Installer arguments.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Result.
 */
function runInstaller(repo, args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], { cwd: repo, encoding: 'utf8' });
}

test('staged credential-like content fails, names path+rule, never echoes the value', () => {
  const samples = [
    { label: 'openai-style key', content: FAKE_OPENAI_KEY },
    { label: 'aws access key id', content: FAKE_AWS_KEY },
    { label: 'github token', content: FAKE_GITHUB_TOKEN },
    { label: 'jwt', content: FAKE_JWT },
    { label: 'private key marker', content: FAKE_PRIVATE_KEY_MARKER },
    { label: 'assignment literal', content: FAKE_ASSIGNMENT }
  ];
  for (const sample of samples) {
    const repo = makeRepo();
    writeFile(repo, 'src/sample.js', `${sample.content}\n`);
    stagePaths(repo, ['src/sample.js']);

    const result = runChecker(repo, ['--staged', '--json']);
    assert.equal(result.status, 1, `${sample.label}: expected exit 1, got ${result.status} (${result.stderr})`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false, sample.label);
    assert.ok(
      parsed.findings.some((finding) => finding.path === 'src/sample.js' && finding.rule === 'credential-pattern'),
      `${sample.label}: expected a credential-pattern finding, got ${result.stdout}`
    );
    assert.ok(!result.stdout.includes(sample.content), `${sample.label}: stdout must not echo the value`);
    assert.ok(!result.stderr.includes(sample.content), `${sample.label}: stderr must not echo the value`);
  }
});

test('text output uses "path:line — rule — hint" and stays quiet-safe', () => {
  const repo = makeRepo();
  writeFile(repo, 'src/sample.js', `${FAKE_OPENAI_KEY}\n`);
  stagePaths(repo, ['src/sample.js']);

  const result = runChecker(repo, ['--staged']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /src\/sample\.js:1 — credential-pattern — /);
  assert.ok(!result.stdout.includes(FAKE_OPENAI_KEY), 'stdout must not echo the value');

  const quiet = runChecker(repo, ['--staged', '--quiet']);
  assert.equal(quiet.status, 1);
  assert.match(quiet.stdout, /src\/sample\.js:1 — credential-pattern — /);
  assert.ok(!quiet.stdout.includes(FAKE_OPENAI_KEY), 'quiet stdout must not echo the value');
});

test('machine-specific absolute paths in staged content fail', () => {
  const repo = makeRepo();
  const fakeHome = path.join(repo, 'fakehome');
  fs.mkdirSync(fakeHome, { recursive: true });
  const windowsPath = ['C:', 'Users', 'exampleuser', 'work'].join('\\');
  writeFile(repo, 'src/home-path.js', `const dir = "${fakeHome}/notes";\n`);
  writeFile(repo, 'src/posix-path.js', `const dir = "${['/Users', 'exampleuser', 'work'].join('/')}";\n`);
  writeFile(repo, 'src/windows-path.js', `const dir = "${windowsPath}";\n`);
  writeFile(repo, 'src/windows-escaped-path.js', `const dir = "${windowsPath.replaceAll('\\', '\\\\')}";\n`);
  writeFile(repo, 'src/relative.js', 'const dir = "src/local";\n');
  stagePaths(repo, [
    'src/home-path.js',
    'src/posix-path.js',
    'src/windows-path.js',
    'src/windows-escaped-path.js',
    'src/relative.js'
  ]);

  const result = runChecker(repo, ['--staged', '--json'], { home: fakeHome });
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const flagged = new Set(parsed.findings.filter((f) => f.rule === 'machine-path').map((f) => f.path));
  assert.ok(flagged.has('src/home-path.js'), `home dir not flagged: ${result.stdout}`);
  assert.ok(flagged.has('src/posix-path.js'), `/Users path not flagged: ${result.stdout}`);
  assert.ok(flagged.has('src/windows-path.js'), `C:\\Users path not flagged: ${result.stdout}`);
  assert.ok(flagged.has('src/windows-escaped-path.js'), `escaped C:\\Users path not flagged: ${result.stdout}`);
  assert.ok(!flagged.has('src/relative.js'), 'relative path must not be flagged');
  assert.ok(!result.stdout.includes(fakeHome), 'stdout must not echo the home path');
});

test('force-added ignored .env file is still caught', () => {
  const repo = makeRepo();
  writeFile(repo, '.gitignore', '.env*\n');
  writeFile(repo, '.env.local', 'LOCAL_FLAG=1\n');
  stagePaths(repo, ['.gitignore']);
  runGit(repo, ['add', '-f', '--', '.env.local']);

  const result = runChecker(repo, ['--staged', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed.findings.some((finding) => finding.path === '.env.local' && finding.rule === 'deny-path'),
    `force-added .env.local not flagged: ${result.stdout}`
  );
});

test('project deny-list from config catches force-added local-only dirs', () => {
  const repo = makeRepo();
  writeFile(repo, '.sensitive-content.json', JSON.stringify({ denyPaths: ['scratch/**'] }));
  writeFile(repo, '.gitignore', 'scratch/\n');
  writeFile(repo, 'scratch/notes.txt', 'local only\n');
  stagePaths(repo, ['.gitignore']);
  runGit(repo, ['add', '-f', '--', 'scratch/notes.txt']);

  const result = runChecker(repo, ['--staged', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'scratch/notes.txt' && finding.rule === 'deny-path'),
    `configured deny path not flagged: ${result.stdout}`
  );
});

test('oversized and binary blobs fail outside allow-globs; sanctioned binaries pass', () => {
  const repo = makeRepo();
  writeFile(repo, '.sensitive-content.json', JSON.stringify({ maxBytes: 2048, binaryAllowGlobs: ['assets/**'] }));
  writeFile(repo, 'big.txt', 'a'.repeat(4096));
  const binary = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(64, 0x41)]);
  writeFile(repo, 'blob.bin', binary);
  writeFile(repo, 'assets/logo.bin', binary);
  stagePaths(repo, ['big.txt', 'blob.bin', 'assets/logo.bin']);

  const result = runChecker(repo, ['--staged', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'big.txt' && finding.rule === 'oversized-blob'),
    `oversized blob not flagged: ${result.stdout}`
  );
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'blob.bin' && finding.rule === 'binary-blob'),
    `binary blob not flagged: ${result.stdout}`
  );
  assert.ok(
    !parsed.findings.some((finding) => finding.path === 'assets/logo.bin'),
    `sanctioned binary must pass: ${result.stdout}`
  );
});

test('default maxBytes rejects a blob larger than 1 MiB', () => {
  const repo = makeRepo();
  writeFile(repo, 'huge.txt', 'b'.repeat(1024 * 1024 + 10));
  stagePaths(repo, ['huge.txt']);

  const result = runChecker(repo, ['--staged', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'huge.txt' && finding.rule === 'oversized-blob'),
    `default maxBytes not enforced: ${result.stdout}`
  );
});

test('clean staged set exits 0; JSON shape is stable; --quiet is silent on success', () => {
  const repo = makeRepo();
  writeFile(repo, 'README.md', '# hello\n\nNothing sensitive here.\n');
  stagePaths(repo, ['README.md']);

  const result = runChecker(repo, ['--staged', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['findings', 'mode', 'ok', 'scanned']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, 'staged');
  assert.equal(parsed.scanned, 1);
  assert.deepEqual(parsed.findings, []);
  for (const finding of parsed.findings) {
    assert.equal(typeof finding.path, 'string');
    assert.equal(typeof finding.line, 'number');
    assert.equal(typeof finding.rule, 'string');
    assert.equal(typeof finding.hint, 'string');
  }

  const text = runChecker(repo, ['--staged']);
  assert.equal(text.status, 0, text.stderr);

  const quiet = runChecker(repo, ['--staged', '--quiet']);
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout.trim(), '', '--quiet success output must be empty');
});

test('local overlay merges over the tracked config', () => {
  const repo = makeRepo();
  writeFile(repo, '.sensitive-content.json', JSON.stringify({ denyPaths: ['one/**'] }));
  writeFile(repo, '.sensitive-content.local.json', JSON.stringify({ denyPaths: ['two/**'], maxBytes: 512 }));
  writeFile(repo, 'one/a.txt', 'x\n');
  writeFile(repo, 'two/b.txt', 'x\n');
  writeFile(repo, 'big.txt', 'c'.repeat(600));
  stagePaths(repo, ['one/a.txt', 'two/b.txt', 'big.txt']);

  const result = runChecker(repo, ['--staged', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const denied = new Set(parsed.findings.filter((f) => f.rule === 'deny-path').map((f) => f.path));
  assert.ok(denied.has('one/a.txt'), `tracked config deny path lost: ${result.stdout}`);
  assert.ok(denied.has('two/b.txt'), `overlay deny path not merged: ${result.stdout}`);
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'big.txt' && finding.rule === 'oversized-blob'),
    `overlay maxBytes not applied: ${result.stdout}`
  );
});

test('allowlist entries with reasons skip matches; missing reason is a config error', () => {
  const repo = makeRepo();
  writeFile(repo, 'fixtures/sample.txt', 'x\n');
  stagePaths(repo, ['fixtures/sample.txt']);

  writeFile(
    repo,
    '.sensitive-content.json',
    JSON.stringify({
      denyPaths: ['fixtures/**'],
      allowlist: [{ pattern: 'fixtures/**', reason: 'synthetic fixtures' }]
    })
  );
  let result = runChecker(repo, ['--staged']);
  assert.equal(result.status, 0, `allowlisted path must pass: ${result.stdout}${result.stderr}`);

  writeFile(
    repo,
    '.sensitive-content.json',
    JSON.stringify({
      denyPaths: ['fixtures/**'],
      allowlist: [{ pattern: 'fixtures/**', rule: 'credential-pattern', reason: 'credentials only' }]
    })
  );
  result = runChecker(repo, ['--staged']);
  assert.equal(result.status, 1, 'rule-scoped allowlist must not suppress a different rule');

  writeFile(
    repo,
    '.sensitive-content.json',
    JSON.stringify({ denyPaths: ['fixtures/**'], allowlist: [{ pattern: 'fixtures/**' }] })
  );
  result = runChecker(repo, ['--staged']);
  assert.equal(result.status, 2, 'allowlist entry without reason must be a config error');
  assert.match(result.stderr, /reason/i);
});

test('usage and config errors exit 2', () => {
  const repo = makeRepo();

  let result = runChecker(repo, ['--bogus']);
  assert.equal(result.status, 2, 'unknown flag must exit 2');

  result = runChecker(repo, ['--config', 'missing.json']);
  assert.equal(result.status, 2, 'missing --config file must exit 2');

  result = runChecker(repo, ['--paths']);
  assert.equal(result.status, 2, '--paths without paths must exit 2');

  writeFile(repo, 'bad.json', '{ not json');
  result = runChecker(repo, ['--config', 'bad.json']);
  assert.equal(result.status, 2, 'malformed config must exit 2');

  writeFile(repo, 'unknown-key.json', JSON.stringify({ denyPaths: [], surprise: true }));
  result = runChecker(repo, ['--config', 'unknown-key.json']);
  assert.equal(result.status, 2, 'unknown config key must exit 2');
});

test('--paths scans working-tree files without staging them', () => {
  const repo = makeRepo();
  writeFile(repo, 'notes.txt', `${FAKE_OPENAI_KEY}\n`);
  writeFile(repo, 'clean.txt', 'all good\n');

  const failing = runChecker(repo, ['--paths', 'notes.txt', '--json']);
  assert.equal(failing.status, 1, failing.stderr);
  const parsed = JSON.parse(failing.stdout);
  assert.equal(parsed.mode, 'paths');
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'notes.txt' && finding.rule === 'credential-pattern'),
    `--paths must scan the working tree: ${failing.stdout}`
  );
  assert.ok(!failing.stdout.includes(FAKE_OPENAI_KEY), 'stdout must not echo the value');

  const clean = runChecker(repo, ['--paths', 'clean.txt']);
  assert.equal(clean.status, 0, clean.stderr);
});

test('--all-tracked scans the index even when nothing is staged', () => {
  const repo = makeRepo();
  writeFile(repo, 'tracked.txt', `${FAKE_OPENAI_KEY}\n`);
  stagePaths(repo, ['tracked.txt']);
  runGit(repo, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'seed']);

  const staged = runChecker(repo, ['--staged']);
  assert.equal(staged.status, 0, `clean index must pass --staged: ${staged.stdout}${staged.stderr}`);

  const all = runChecker(repo, ['--all-tracked', '--json']);
  assert.equal(all.status, 1, all.stderr);
  const parsed = JSON.parse(all.stdout);
  assert.equal(parsed.mode, 'all-tracked');
  assert.ok(
    parsed.findings.some((finding) => finding.path === 'tracked.txt' && finding.rule === 'credential-pattern'),
    `--all-tracked must scan committed files: ${all.stdout}`
  );
  assert.ok(!all.stdout.includes(FAKE_OPENAI_KEY), 'stdout must not echo the value');
});

test('installer writes a marked executable hook and is idempotent', () => {
  const repo = makeRepo();
  const first = runInstaller(repo, []);
  assert.equal(first.status, 0, first.stderr);
  const hookPath = hookPathFor(repo);
  assert.ok(first.stdout.includes(hookPath), `installer must report the hook path: ${first.stdout}`);
  assert.ok(fs.existsSync(hookPath), 'hook file must exist');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.match(content, /sensitive-content-guard/, 'hook must carry the managed marker');
  assert.match(content, /--staged/, 'hook must run the checker with --staged');
  assert.ok((fs.statSync(hookPath).mode & 0o111) !== 0, 'hook must be executable');

  const second = runInstaller(repo, []);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(hookPath, 'utf8'), content, 're-run must be idempotent');
});

test('installer refuses a foreign hook without --force and replaces it with --force', () => {
  const repo = makeRepo();
  const hookPath = hookPathFor(repo);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  const foreign = '#!/bin/sh\necho foreign\n';
  fs.writeFileSync(hookPath, foreign);
  fs.chmodSync(hookPath, 0o755);

  const refused = runInstaller(repo, []);
  assert.notEqual(refused.status, 0, 'foreign hook must be refused without --force');
  assert.match(refused.stderr, /--force/);
  assert.equal(fs.readFileSync(hookPath, 'utf8'), foreign, 'foreign hook must be left untouched');

  const forced = runInstaller(repo, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(fs.readFileSync(hookPath, 'utf8'), /sensitive-content-guard/);
});

test('--uninstall removes only marked hooks', () => {
  const repo = makeRepo();
  const hookPath = hookPathFor(repo);

  assert.equal(runInstaller(repo, []).status, 0);
  let result = runInstaller(repo, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(hookPath), 'marked hook must be removed');

  const foreign = '#!/bin/sh\necho foreign\n';
  fs.writeFileSync(hookPath, foreign);
  result = runInstaller(repo, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(hookPath, 'utf8'), foreign, 'foreign hook must survive --uninstall');

  fs.rmSync(hookPath);
  result = runInstaller(repo, ['--uninstall']);
  assert.equal(result.status, 0, 'uninstall with no hook must exit 0');
});

test('installed hook runs the guard against staged content', () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(CHECKER, path.join(repo, 'scripts', 'check_sensitive_content.mjs'));
  assert.equal(runInstaller(repo, []).status, 0);
  const hookPath = hookPathFor(repo);

  writeFile(repo, '.env.local', 'LOCAL_FLAG=1\n');
  runGit(repo, ['add', '-f', '--', '.env.local']);
  let result = spawnSync('sh', [hookPath], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 1, `hook must block a staged .env file:\n${result.stdout}\n${result.stderr}`);

  runGit(repo, ['rm', '-q', '--cached', '--', '.env.local']);
  result = spawnSync('sh', [hookPath], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `hook must pass a clean index:\n${result.stdout}\n${result.stderr}`);
});
