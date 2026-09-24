#!/usr/bin/env node
/**
 * @file tests/audit/harnesses/gitbug_lock_stress.mjs
 * @description Stress acceptance harness for ticket 19cc568: concurrent
 * `scripts/gitbug.mjs` invocations against a real scratch git-bug repository
 * must all succeed with no lost or duplicated mutations once the wrapper
 * serializes its invocations through its own advisory lock.
 *
 * Scenario 1: 10 concurrent `gitbug new` calls -> all exit 0 and `refs/bugs`
 *             contains exactly 10 refs.
 * Scenario 2: 10 concurrent `gitbug comment <id>` calls -> all exit 0 and the
 *             ticket holds exactly 10 comments (git-bug's JSON `comments`
 *             array includes the description at index 0, so the total is 11).
 *
 * The scratch repo is created under `os.tmpdir()` and removed afterwards; the
 * real tracker is never touched.
 *
 * Not part of `npm test`.
 * Run:
 *   node tests/audit/harnesses/gitbug_lock_stress.mjs
 *
 * Exit codes: 0 acceptance met; 1 acceptance violated (details on stdout).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('../../../scripts/gitbug.mjs', import.meta.url));
const CONCURRENCY = 10;
const COMMENT_PREFIX = 'stress-comment-';

/**
 * Run a command and resolve with its exit code and streams.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {{cwd?: string}} [options] Spawn options.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, ms: number}>} Result.
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

/**
 * Synchronously run a command, returning exit code and streams.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {{cwd?: string}} [options] Spawn options.
 * @returns {{code: number|null, stdout: string, stderr: string}} Result.
 */
function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const failures = [];

/**
 * Record a failure line and its per-call evidence.
 * @param {string} summary One-line summary.
 * @param {Array<{code: number|null, stderr: string}>} results Per-call results.
 */
function recordFailure(summary, results) {
  failures.push(summary);
  console.log(`FAIL ${summary}`);
  for (const [index, result] of results.entries()) {
    if (result.code !== 0) {
      console.log(`  call #${index}: exit=${result.code} stderr=${JSON.stringify(result.stderr.trim())}`);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbug-lock-stress-'));
try {
  const init = runSync('git', ['init', '-q'], { cwd: tmp });
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);

  const user = runSync(
    'git',
    ['bug', 'user', 'new', '-n', 'Probe', '-e', 'probe@example.com', '--non-interactive'],
    { cwd: tmp }
  );
  if (user.code !== 0) throw new Error(`git bug user new failed: ${user.stderr.trim()}`);

  // Scenario 1: concurrent creations.
  const newResults = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => run(
      process.execPath,
      [WRAPPER, 'new', '--title', `stress-new-${i}`, '--body', `stress body ${i}`],
      { cwd: tmp }
    ))
  );
  const newFailed = newResults.filter((result) => result.code !== 0);
  const refNames = runSync('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], { cwd: tmp })
    .stdout.split('\n').filter((line) => line.length > 0);
  console.log(`scenario 1 (new): ok ${newResults.length - newFailed.length}/${CONCURRENCY}, refs=${refNames.length}`);
  if (newFailed.length > 0 || refNames.length !== CONCURRENCY) {
    recordFailure(`concurrent new: expected ${CONCURRENCY} successes and ${CONCURRENCY} refs`, newResults);
  }

  // Scenario 2: concurrent comments on the first created ticket.
  if (refNames.length === 0) {
    recordFailure('concurrent comment: no ticket was created to comment on', []);
  } else {
    const ticketId = refNames[0].replace(/^refs\/bugs\//, '');
    const commentResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => run(
        process.execPath,
        [WRAPPER, 'comment', ticketId, '--body', `${COMMENT_PREFIX}${i}`],
        { cwd: tmp }
      ))
    );
    const commentFailed = commentResults.filter((result) => result.code !== 0);
    const show = runSync('git', ['bug', 'bug', 'show', '-f', 'json', ticketId], { cwd: tmp });
    let ourComments = -1;
    if (show.code !== 0) {
      console.log(`  show failed: exit=${show.code} stderr=${JSON.stringify(show.stderr.trim())}`);
    } else {
      const parsed = JSON.parse(show.stdout);
      ourComments = (parsed.comments || [])
        .filter((entry) => typeof entry.message === 'string' && entry.message.startsWith(COMMENT_PREFIX))
        .length;
    }
    console.log(`scenario 2 (comment): ok ${commentResults.length - commentFailed.length}/${CONCURRENCY}, comments=${ourComments}`);
    if (commentFailed.length > 0 || ourComments !== CONCURRENCY) {
      recordFailure(`concurrent comment: expected ${CONCURRENCY} successes and ${CONCURRENCY} comments`, commentResults);
    }
  }

  const lockPath = path.join(tmp, '.git', 'gitbug-wrapper.lock');
  if (fs.existsSync(lockPath)) {
    recordFailure(`wrapper lock was left behind at ${lockPath}`, []);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`RESULT: FAIL (${failures.length} acceptance violation(s))`);
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS (all concurrent invocations serialized, no lost mutations)');
  process.exitCode = 0;
}
