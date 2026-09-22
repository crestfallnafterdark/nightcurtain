#!/usr/bin/env node
/**
 * @file scripts/verify_all.mjs
 * @description Default static battery: `npm run verify` runs every static gate
 * in one command so a lane cannot forget one. The partial `verify:*` / `gate:*`
 * / `lint:*` / `typecheck` commands remain for iteration and repair; this
 * umbrella is the default (AGENTS §4).
 *
 * Policy
 * ------
 * - Read-only: no gate in the list writes tracked files. `verify:api-reports`
 *   regenerates into a temp tree and byte-compares; `typecheck` only spawns
 *   compilers/linters.
 * - Parallel-safe: no ports, no shared mutable state — the battery may run
 *   alongside other read-only agents, though the full test suite stays
 *   single-flight (AGENTS §4).
 * - Continue-after-failure: the battery never stops early. Each gate prints a
 *   `[PASS]/[FAIL] <script> (<ms>)` line as it goes; the end summary lists all
 *   results and echoes a tail of the captured output for each failing gate.
 * - Exit 0 only when every gate exited 0; otherwise exit 1.
 * - The gate list below is deliberately explicit (never discovered) so the
 *   battery is auditable and its order stable.
 *
 * Output policy
 * -------------
 * Only captured gate output is printed (tails for failures); the script never
 * inspects or echoes environment/credential values.
 */

import { spawnSync } from 'node:child_process';

/** Ordered gate list; each entry is an `npm run <name>` script. */
const GATES = [
  'verify:contracts',
  'verify:module-contracts',
  'verify:api-reports',
  'gate:arch',
  'lint:sandbox',
  'lint:docs',
  'typecheck'
];

/** Lines of captured output echoed per failing gate in the end summary. */
const FAILURE_TAIL_LINES = 40;

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Runs one gate and captures combined stdout/stderr.
 *
 * @param {string} gate npm script name.
 * @returns {{ gate: string, ok: boolean, status: number | null, ms: number, output: string, reason?: string }} Result.
 */
function runGate(gate) {
  const started = Date.now();
  const result = spawnSync(NPM, ['run', gate], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const ms = Date.now() - started;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) {
    return { gate, ok: false, status: null, ms, output, reason: result.error.message };
  }
  if (result.status === null) {
    return { gate, ok: false, status: null, ms, output, reason: `terminated by signal ${result.signal}` };
  }
  return { gate, ok: result.status === 0, status: result.status, ms, output };
}

/**
 * Prints the last `FAILURE_TAIL_LINES` lines of captured gate output.
 *
 * @param {string} output Captured combined output.
 * @returns {void}
 */
function printTail(output) {
  if (output.trim() === '') {
    console.log('    | (no output captured)');
    return;
  }
  const lines = output.trimEnd().split('\n');
  const tail = lines.slice(-FAILURE_TAIL_LINES);
  if (lines.length > tail.length) {
    console.log(`    | ... (${lines.length - tail.length} earlier lines omitted)`);
  }
  for (const line of tail) {
    console.log(`    | ${line}`);
  }
}

/**
 * Runs every gate in order and prints the summary. Sets `process.exitCode`
 * to 1 when any gate failed.
 *
 * @returns {void}
 */
function main() {
  const results = [];
  console.log(`verify: running ${GATES.length} static gates (read-only, continue-on-failure)`);

  for (const gate of GATES) {
    console.log('');
    console.log(`=== npm run ${gate} ===`);
    const result = runGate(gate);
    results.push(result);
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${gate} (${result.ms} ms)`);
  }

  const failed = results.filter((result) => !result.ok);

  console.log('');
  console.log(`=== verify summary: ${results.length - failed.length}/${results.length} gates passed ===`);
  for (const result of results) {
    const suffix = result.ok ? '' : result.status === null ? ` — ${result.reason}` : ` — exit ${result.status}`;
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.gate} (${result.ms} ms)${suffix}`);
  }

  if (failed.length === 0) {
    console.log('');
    console.log(`verify: PASS — all ${results.length} static gates passed.`);
    process.exitCode = 0;
    return;
  }

  for (const result of failed) {
    console.log('');
    console.log(`=== failure output: ${result.gate} (tail) ===`);
    printTail(result.output);
  }
  console.log('');
  console.error(`verify: FAIL — ${failed.length}/${results.length} gates failed: ${failed.map((result) => result.gate).join(', ')}`);
  process.exitCode = 1;
}

main();
