/**
 * @file tests/audit/repros/19cc568.test.js
 * @description Audit repro for ticket 19cc568 (Major, area:tooling):
 * `scripts/gitbug.mjs` does not serialize its invocations, so concurrent
 * wrapper calls race into git-bug's repository lock and the loser fails
 * outright instead of queueing.
 *
 * Evidence: `scripts/gitbug.mjs` (`runGit`/`execGit` shell out to `git bug ...`
 * with no inter-process lock). Observed on the unfixed wrapper: a 10-way
 * concurrent `new` batch against a scratch git-bug repo lost 4/10 mutations to
 * `Error: the repository you want to access is already locked by the process
 * pid <pid>`.
 *
 * Exact enforced claim after the fix: two concurrent wrapper invocations whose
 * underlying `git bug` calls would collide on git-bug's repository lock both
 * succeed, because the wrapper serializes them through its own advisory lock.
 *
 * Deterministic: the test never relies on real git-bug lock timing. A fake
 * `git` shim placed first on `PATH` intercepts `bug bug ...`, holds its own
 * O_EXCL lock for ~750 ms, and fails with the exact git-bug lock message while
 * the lock is held; every other git subcommand delegates to the real git
 * (absolute path captured before `PATH` is overridden).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/19cc568.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('../../../scripts/gitbug.mjs', import.meta.url));

/** Real git, captured before the shim directory overrides `PATH`. */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/**
 * Fake `git` shim: `bug bug ...` takes an O_EXCL shim lock, sleeps ~750 ms and
 * exits 0; while the lock is held it reproduces git-bug's exact lock error and
 * exits 1. All other subcommands delegate to `GITBUG_REAL_GIT`.
 */
const GIT_SHIM = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] === 'bug' && args[1] === 'bug') {
  const lockPath = process.env.GITBUG_SHIM_LOCK;
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    let holder = 'unknown';
    try { holder = fs.readFileSync(lockPath, 'utf8').trim() || 'unknown'; } catch {}
    process.stderr.write(
      'Error: the repository you want to access is already locked by the process pid ' + holder + '\\n'
    );
    process.exit(1);
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.fsyncSync(fd);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch {}
  }
  process.exit(0);
}

const result = spawnSync(process.env.GITBUG_REAL_GIT, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`;

/**
 * Spawn one wrapper invocation and collect its streams.
 * @param {string[]} args Wrapper argv.
 * @param {NodeJS.ProcessEnv} env Child environment.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} Result.
 */
function runWrapper(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('19cc568: concurrent wrapper invocations serialize instead of failing on git-bug locks', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbug-repro-19cc568-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'git'), GIT_SHIM, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GITBUG_REAL_GIT: REAL_GIT,
    GITBUG_SHIM_LOCK: path.join(tmp, 'shim.lock'),
    GITBUG_LOCK_PATH: path.join(tmp, 'wrapper.lock'),
  };

  const [first, second] = await Promise.all([
    runWrapper(['list', '--json'], env),
    runWrapper(['list', '--json'], env),
  ]);

  const observed = [
    `call A: exit=${first.code} stdout=${JSON.stringify(first.stdout)} stderr=${JSON.stringify(first.stderr)}`,
    `call B: exit=${second.code} stdout=${JSON.stringify(second.stdout)} stderr=${JSON.stringify(second.stderr)}`,
  ].join('\n');

  assert.deepStrictEqual(
    [first.code, second.code],
    [0, 0],
    `both concurrent wrapper calls must serialize and succeed (red evidence below)\n${observed}`
  );
  assert.strictEqual(
    fs.existsSync(env.GITBUG_LOCK_PATH),
    false,
    'the wrapper lock must be released once every invocation has finished'
  );
});
