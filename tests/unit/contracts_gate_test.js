/**
 * @file tests/unit/contracts_gate_test.js
 * @description Encapsulation gate-execution suite (3D gate wiring).
 *
 * Proves the seven static encapsulation gates actually execute and pass:
 * 1. `scripts/verify_sandbox_contracts.js --enforce-boundaries`
 *    (export whitelist E \ D = ∅, boundary isolation)
 * 2. dependency-cruiser architecture gate (`.dependency-cruiser.cjs` rules
 *    cruised over `src/lib/sandbox`).
 * 3. TSDoc syntax gate (`eslint.tsdoc.config.js` over sandbox `.d.ts`/`.ts`
 *    surfaces), also exposed as `npm run lint:docs`.
 * 4. Sandbox contract-types gate (`tsconfig.contracts.json`): strict own-code
 *    check of sandbox `.d.ts`/`.ts` surfaces; `checkJs: false` keeps
 *    out-of-sandbox `.js` seams (covered by the main `typecheck` ratchet) from
 *    being re-checked, and `skipLibCheck: true` skips third-party declaration
 *    files (`@types/node` is absent). Also exposed as `npm run
 *    verify:contract-types`.
 * 5. Tier 1 module-contract validator (`scripts/verify_module_contracts.js`),
 *    also exposed as `npm run verify:module-contracts`.
 * 6. Generated-ICD freshness gate (`scripts/api_reports.mjs --check`, Tier 3:
 *    byte-diff of regenerated reports vs `docs/generated/modules/`), also
 *    exposed as `npm run verify:api-reports`. Deliberately included here
 *    because `--check` runs in ~1s (shared TypeScript program across all 30
 *    entries), far inside the per-suite budget.
 * 7. Sandbox lint gate (`npm run lint:sandbox`): the flat ESLint config over
 *    the sandbox `.js`/`.ts`/`.d.ts` sources — the same glob as `npm run
 *    lint`. Asserted through the npm script name so the gate wiring itself is
 *    covered, not just the underlying binary. ESLint is silent at 0 problems,
 *    so this case accepts a clean silent exit.
 *
 * Full `tsc --noEmit` and `svelte-check` intentionally stay out of this suite:
 * they are slow, live behind `npm run typecheck`, and must not eat the
 * per-suite budget. The narrow contract-types project is different: it
 * type-checks only sandbox `.d.ts`/`.ts` own-code surfaces with `types: []`
 * and completes in ~1s, so it is included here. This suite asserts gate
 * execution (exit code 0 + success marker), not numeric counts, and embeds a
 * bounded stdout/stderr tail in every failure message so a red gate is
 * diagnosable from the master runner output alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');
const VERIFIER_TIMEOUT_MS = 30000;
const DEPCRUISE_TIMEOUT_MS = 45000;
const ESLINT_TIMEOUT_MS = 30000;
const CONTRACT_TYPES_TIMEOUT_MS = 30000;
const MODULE_CONTRACTS_TIMEOUT_MS = 15000;
const API_REPORTS_TIMEOUT_MS = 20000;
const SANDBOX_LINT_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_LINES = 25;

/**
 * Returns the trailing lines of captured gate output.
 *
 * @param {string} text
 * @param {number} [maxLines]
 * @returns {string}
 */
function tailLines(text, maxLines = OUTPUT_TAIL_LINES) {
  const lines = String(text || '').trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

/**
 * Formats child-process diagnostics embedded in gate assertion messages.
 *
 * @param {string} commandText Human-readable command line that was spawned.
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @param {number} durationMs
 * @returns {string}
 */
function gateDiagnostics(commandText, result, durationMs) {
  return [
    `command: ${commandText}`,
    `exit: ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`,
    result.error ? `spawn/timeout error: ${result.error.message}` : null,
    `duration: ${durationMs}ms`,
    `output tail:\n${tailLines([result.stdout, result.stderr].filter(Boolean).join('\n')) || '<empty>'}`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Spawns one gate synchronously and asserts a clean exit with visible output.
 *
 * @param {string} label Human-readable gate name for assertion messages.
 * @param {string[]} args Node script path + argv for the gate.
 * @param {number} timeoutMs Hard kill timeout for the child process.
 * @param {{ requireOutput?: boolean }} [options] When `false`, a silent clean
 *   exit is accepted (linters print nothing on success).
 * @returns {{ durationMs: number, output: string }}
 */
function runGate(label, args, timeoutMs, { requireOutput = true } = {}) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, NODE_ENV: 'test' }
  });
  const durationMs = Date.now() - startedAt;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const diagnostics = gateDiagnostics(`node ${args.join(' ')}`, result, durationMs);

  assert.equal(result.status, 0, `${label} did not pass.\n${diagnostics}`);
  if (requireOutput) {
    assert.ok(
      output.trim().length > 0,
      `${label} exited 0 but produced no output; the gate may not have run.\n${diagnostics}`
    );
  }

  return { durationMs, output };
}

/**
 * Spawns one npm-script gate synchronously and asserts a clean exit. Used when
 * the gate contract is the npm entry point (script name + glob wiring) rather
 * than the underlying binary argv.
 *
 * @param {string} label Human-readable gate name for assertion messages.
 * @param {string} script npm script to run (e.g. `lint:sandbox`).
 * @param {number} timeoutMs Hard kill timeout for the child process.
 * @param {{ requireOutput?: boolean }} [options] When `false`, a silent clean
 *   exit is accepted (linters print nothing on success).
 * @returns {{ durationMs: number, output: string }}
 */
function runNpmScript(label, script, timeoutMs, { requireOutput = true } = {}) {
  const startedAt = Date.now();
  const result = spawnSync('npm', ['run', script], {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
    timeout: timeoutMs,
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  const durationMs = Date.now() - startedAt;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const diagnostics = gateDiagnostics(`npm run ${script}`, result, durationMs);

  assert.equal(result.status, 0, `${label} did not pass.\n${diagnostics}`);
  if (requireOutput) {
    assert.ok(
      output.trim().length > 0,
      `${label} exited 0 but produced no output; the gate may not have run.\n${diagnostics}`
    );
  }

  return { durationMs, output };
}

test(
  'sandbox contract verifier (--enforce-boundaries) runs and passes',
  { timeout: VERIFIER_TIMEOUT_MS + 5000 },
  () => {
    const { output } = runGate(
      'Sandbox contract verifier',
      ['scripts/verify_sandbox_contracts.js', '--enforce-boundaries'],
      VERIFIER_TIMEOUT_MS
    );
    assert.match(
      output,
      /Verification Successful/,
      'Verifier output is missing its success marker; the gate did not complete a full verification.'
    );
  }
);

test(
  'dependency-cruiser architecture gate runs and passes',
  { timeout: DEPCRUISE_TIMEOUT_MS + 5000 },
  () => {
    const { output } = runGate(
      'Dependency-cruiser architecture gate',
      ['node_modules/.bin/depcruise', 'src/lib/sandbox', '--config', '.dependency-cruiser.cjs'],
      DEPCRUISE_TIMEOUT_MS
    );
    assert.match(
      output,
      /no dependency violations found|0 errors, 0 warnings/,
      'Dependency-cruiser output is missing its clean-cruise marker ("no dependency violations found" or "0 errors, 0 warnings"); the gate did not complete a full cruise.'
    );
    assert.doesNotMatch(
      output,
      /[1-9]\d* warnings/,
      `Dependency-cruiser reported warnings; the architecture gate requires 0 errors / 0 warnings.\noutput tail:\n${tailLines(output)}`
    );
  }
);

test(
  'TSDoc syntax gate (sandbox .d.ts/.ts) runs and passes',
  { timeout: ESLINT_TIMEOUT_MS + 5000 },
  () => {
    runGate(
      'TSDoc syntax gate',
      [
        'node_modules/.bin/eslint',
        '--config',
        'eslint.tsdoc.config.js',
        'src/lib/sandbox/**/*.{d.ts,ts}'
      ],
      ESLINT_TIMEOUT_MS,
      { requireOutput: false }
    );
  }
);

test(
  'sandbox contract-types gate (strict sandbox surfaces; third-party libs skipped) runs and passes',
  { timeout: CONTRACT_TYPES_TIMEOUT_MS + 5000 },
  () => {
    runGate(
      'Sandbox contract-types gate',
      ['node_modules/.bin/tsc', '--noEmit', '-p', 'tsconfig.contracts.json'],
      CONTRACT_TYPES_TIMEOUT_MS,
      { requireOutput: false }
    );
  }
);

test(
  'Tier 1 module-contract validator runs and passes',
  { timeout: MODULE_CONTRACTS_TIMEOUT_MS + 5000 },
  () => {
    const { output } = runGate(
      'Tier 1 module-contract validator',
      ['scripts/verify_module_contracts.js'],
      MODULE_CONTRACTS_TIMEOUT_MS
    );
    assert.match(
      output,
      /Result: PASS/,
      'Module-contract validator output is missing its PASS marker; coverage/identity/refs/hygiene did not complete cleanly.'
    );
  }
);

test(
  'generated ICD reports are fresh (Tier 3) runs and passes',
  { timeout: API_REPORTS_TIMEOUT_MS + 5000 },
  () => {
    const { output } = runGate(
      'Generated-ICD freshness gate',
      ['scripts/api_reports.mjs', '--check'],
      API_REPORTS_TIMEOUT_MS
    );
    assert.match(
      output,
      /Result: PASS/,
      'Generated-ICD freshness gate output is missing its PASS marker; tracked reports are stale or extraction failed.'
    );
  }
);

test(
  'sandbox lint gate (npm run lint:sandbox) runs and passes',
  { timeout: SANDBOX_LINT_TIMEOUT_MS + 5000 },
  () => {
    runNpmScript('Sandbox lint gate', 'lint:sandbox', SANDBOX_LINT_TIMEOUT_MS, {
      requireOutput: false
    });
  }
);
