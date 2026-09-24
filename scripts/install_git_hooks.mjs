#!/usr/bin/env node
/**
 * @file scripts/install_git_hooks.mjs
 * @description Idempotent installer for the pre-commit sensitive-content
 * guard (`scripts/check_sensitive_content.mjs --staged`). Writes a marked
 * `pre-commit` shim into the repository's common hooks directory (resolved via
 * `git rev-parse --git-common-dir`, so linked worktrees share one hook) and
 * makes it executable.
 *
 * Safety properties:
 * - A hook that does not carry the managed marker is foreign and is refused
 *   unless `--force` is given; the refusal never modifies it.
 * - `--uninstall` removes only marked hooks; foreign hooks are left in place.
 * - Re-running install is a no-op when the marked hook is already current.
 * - The shim resolves the worktree toplevel at run time, so each worktree runs
 *   its own copy of the guard, and it fails closed when the guard cannot run.
 *
 * Usage: node scripts/install_git_hooks.mjs [--force] [--uninstall] [-h]
 *
 * Exit codes: 0 success/no-op, 1 refused foreign hook, 2 usage error.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** Marker that identifies a managed hook; also the uninstall test. */
const MARKER = 'sensitive-content-guard';

/** Hook file managed by this installer. */
const HOOK_NAME = 'pre-commit';

const USAGE = `Usage: node scripts/install_git_hooks.mjs [--force] [--uninstall] [-h]

Installs (or removes) the managed pre-commit hook that runs
scripts/check_sensitive_content.mjs --staged against the staged index.

Options:
  --force       Replace a foreign (unmarked) pre-commit hook.
  --uninstall   Remove the managed hook; foreign hooks are left untouched.
  -h, --help    Show this help.

Exit codes: 0 success/no-op, 1 refused foreign hook, 2 usage error.`;

/** Usage/input error (exit code 2). */
class UsageError extends Error {}

/**
 * Parses CLI arguments.
 * @param {string[]} argv Raw arguments (without node/script).
 * @returns {{force: boolean, uninstall: boolean, help: boolean}} Options.
 * @throws {UsageError} On unknown arguments.
 */
function parseArgs(argv) {
  const options = { force: false, uninstall: false, help: false };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Resolves the shared hooks directory for the current repository.
 * @param {string} cwd Working directory.
 * @returns {string} Absolute hooks directory.
 * @throws {UsageError} Outside a git repository.
 */
function resolveHooksDir(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (result.error) throw new UsageError(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) throw new UsageError(`not inside a git repository (${String(result.stderr).trim()})`);
  const commonDir = result.stdout.trim();
  if (commonDir === '') throw new UsageError('git rev-parse --git-common-dir returned no path');
  return path.join(path.resolve(cwd, commonDir), 'hooks');
}

/**
 * Builds the managed hook shim.
 * @returns {string} Hook script content.
 */
function shimContent() {
  return `#!/bin/sh
# ${MARKER}: managed pre-commit hook — do not edit.
# Reinstall: node scripts/install_git_hooks.mjs   Remove: --uninstall
# Runs the repository guard against the staged index; fails closed.
set -e
toplevel=$(git rev-parse --show-toplevel) || exit 0
exec node "$toplevel/scripts/check_sensitive_content.mjs" --staged --quiet
`;
}

/**
 * Installs or refreshes the managed hook.
 * @param {string} hooksDir Hooks directory.
 * @param {boolean} force Replace a foreign hook.
 * @returns {number} Exit code.
 */
function installHook(hooksDir, force) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, HOOK_NAME);
  const desired = shimContent();
  if (fs.existsSync(hookPath)) {
    const current = fs.readFileSync(hookPath, 'utf8');
    if (!current.includes(MARKER)) {
      if (!force) {
        console.error(`refusing to overwrite foreign hook: ${hookPath} (re-run with --force)`);
        return EXIT_FAIL;
      }
      console.log(`overwriting foreign hook: ${hookPath}`);
    } else if (current === desired) {
      fs.chmodSync(hookPath, 0o755);
      console.log(`already installed: ${hookPath}`);
      return EXIT_OK;
    }
  }
  fs.writeFileSync(hookPath, desired, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  console.log(`installed: ${hookPath}`);
  return EXIT_OK;
}

/**
 * Removes the managed hook, leaving foreign hooks in place.
 * @param {string} hooksDir Hooks directory.
 * @returns {number} Exit code.
 */
function uninstallHook(hooksDir) {
  const hookPath = path.join(hooksDir, HOOK_NAME);
  if (!fs.existsSync(hookPath)) {
    console.log(`no hook installed: ${hookPath}`);
    return EXIT_OK;
  }
  const current = fs.readFileSync(hookPath, 'utf8');
  if (!current.includes(MARKER)) {
    console.log(`not managed by ${MARKER}; left in place: ${hookPath}`);
    return EXIT_OK;
  }
  fs.unlinkSync(hookPath);
  console.log(`removed: ${hookPath}`);
  return EXIT_OK;
}

/**
 * Runs the installer. Returns the process exit code.
 * @returns {number} Exit code.
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`install_git_hooks: ${error.message}`);
    console.error('Run with --help for usage.');
    return EXIT_USAGE;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  try {
    const hooksDir = resolveHooksDir(process.cwd());
    return options.uninstall ? uninstallHook(hooksDir) : installHook(hooksDir, options.force);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`install_git_hooks: ${error.message}`);
      return EXIT_USAGE;
    }
    console.error(`install_git_hooks: unexpected error: ${error.message}`);
    return EXIT_USAGE;
  }
}

process.exitCode = main();
