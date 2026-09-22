#!/usr/bin/env node
/**
 * @file scripts/typecheck.mjs
 * @description Triple-gate typecheck runner. `npm run typecheck` must exercise
 * all three checks — the jsconfig tsc pass, the strict contracts tsc pass
 * (`tsconfig.contracts.json`) and svelte-check; a plain
 * `tsc && svelte-check` short-circuits because tsc exits non-zero at the
 * documented error baseline, leaving later checks unexecuted. This runner
 * spawns each check unconditionally, prints all outputs and computed
 * summaries, and enforces the documented baselines.
 *
 * Why the contracts pass is separate (U-W1 `3dee80e`, AGENTS §4)
 * -------------------------------------------------------------
 * `jsconfig.json` checks the whole `src/` tree in JS-inclusive mode, which is
 * NOT the strict sandbox-surface contract. `tsconfig.contracts.json` extends
 * jsconfig but pins `strict: true`, `checkJs: false` and `types: []` and
 * includes only `src/lib/sandbox/**`, so it alone proves the sandbox `.ts`
 * surfaces are strict-clean; it is also the config behind
 * `npm run verify:contract-types`. Composing it here keeps `npm run typecheck`
 * the one command that covers every type check.
 *
 * Baseline policy
 * ---------------
 * The constants below are ceilings, not targets. They may only ratchet DOWN as
 * errors are fixed; raising one requires an explicit, recorded decision with
 * the change that does so. Any tsc error under `src/lib/sandbox/` fails the
 * gate outright — sandbox errors must stay at zero regardless of the total.
 *
 * Forward mode (.ts rewrite)
 * --------------------------
 * The tsc pass runs against `jsconfig.json`, whose includes already cover
 * `.ts` files under `src/` (alongside JS, declaration and Svelte sources), so
 * `.ts` diagnostics — including `sandboxStore/index.svelte.ts` — are part of
 * both counters and the sandbox ratchet applies to them unchanged. The summary
 * additionally splits out `.ts` errors and reports how many source `.ts` files
 * are in scope, so `.ts` adoption is visible without moving any baseline.
 *
 * Failure policy
 * --------------
 * Exit 0 only when all three checks ran and no baseline was exceeded. A missing
 * binary, a crash, or output whose counts cannot be parsed is a failure — the
 * runner must never pass by silently skipping a check.
 *
 * Output policy
 * -------------
 * Only captured tool output plus the runner's own computed counts is printed;
 * the script never inspects or echoes environment/credential values.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Ceiling for total `tsc` errors; ratchet DOWN only (see file header). */
const TSC_ERROR_BASELINE = 0;
/** Max tsc errors under `src/lib/sandbox/`; ratchet DOWN only. */
const SANDBOX_TSC_ERROR_BASELINE = 0;
/** Ceiling for strict contracts tsc errors (`tsconfig.contracts.json`); ratchet DOWN only. */
const CONTRACTS_TSC_ERROR_BASELINE = 0;
/** Ceiling for `svelte-check` errors; ratchet DOWN only (see file header). */
const SVELTE_CHECK_ERROR_BASELINE = 96;

/** tsc exits 0 when clean and 2 when diagnostics are present at this baseline. */
const TSC_ACCEPTED_STATUSES = new Set([0, 2]);
/** svelte-check exits 0 when clean and 1 when it reports diagnostics. */
const SVELTE_CHECK_ACCEPTED_STATUSES = new Set([0, 1]);

const JS_CONFIG = 'jsconfig.json';
const CONTRACTS_CONFIG = 'tsconfig.contracts.json';
const SANDBOX_DIR = path.join('src', 'lib', 'sandbox').replace(/\\/g, '/');

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * Spawns a check process and captures combined stdout/stderr.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Argument vector.
 * @returns {{ ran: boolean, status?: number, reason?: string, output: string }} Result.
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) {
    return { ran: false, reason: result.error.message, output };
  }
  if (result.status === null) {
    return { ran: false, reason: `terminated by signal ${result.signal}`, output };
  }
  return { ran: true, status: result.status, output };
}

/**
 * Counts `error TS####` occurrences in tsc output.
 *
 * @param {string} output Captured tsc output.
 * @returns {number} Total error count.
 */
function countTscErrors(output) {
  return (output.match(/error TS\d+/g) || []).length;
}

/**
 * Counts tsc errors whose source file lives under `src/lib/sandbox/`.
 *
 * @param {string} output Captured tsc output.
 * @param {string} [extension] Optional suffix filter (e.g. `.ts`), used to
 *   report how much of the ratchet is driven by converted sources.
 * @returns {number} Sandbox-owned error count.
 */
function countSandboxTscErrors(output, extension) {
  let count = 0;
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\(\d+,\d+\): error TS\d+/);
    if (!match) continue;
    const file = match[1].trim().replace(/\\/g, '/');
    const inSandbox = file === SANDBOX_DIR || file.startsWith(`${SANDBOX_DIR}/`) || file.includes(`/${SANDBOX_DIR}/`);
    if (inSandbox && (extension === undefined || file.endsWith(extension))) {
      count++;
    }
  }
  return count;
}

/**
 * Counts tsc errors reported against files with the given suffix. Used to make
 * the `.ts` share of the tsc pass explicit once the rewrite starts.
 *
 * @param {string} output Captured tsc output.
 * @param {string} extension Suffix to match, e.g. `.ts` (also covers
 *   `index.svelte.ts`).
 * @returns {number} Matching diagnostic count.
 */
function countTscErrorsForExtension(output, extension) {
  let count = 0;
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\(\d+,\d+\): error TS\d+/);
    if (!match) continue;
    if (match[1].trim().replace(/\\/g, '/').endsWith(extension)) {
      count++;
    }
  }
  return count;
}

/**
 * Counts source `.ts` files under `src/` (the jsconfig include tree; `.d.ts`
 * declarations excluded). Zero today; reported so the tsc pass cannot silently
 * lose `.ts` coverage as module conversion proceeds.
 *
 * @returns {number} Source `.ts` file count.
 */
function countScopedTsFiles() {
  const pending = ['src'];
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Parses the final `svelte-check found N errors ...` summary line.
 *
 * @param {string} output Captured svelte-check output.
 * @returns {{ errors: number, warnings: number } | null} Counts, or null when
 *   no summary line was produced (treated as a cannot-run failure).
 */
function parseSvelteCheckCounts(output) {
  const match = output.match(/svelte-check found (\d+) errors?(?: and (\d+) warnings?)?/i);
  if (!match) return null;
  return {
    errors: Number(match[1]),
    warnings: match[2] === undefined ? 0 : Number(match[2])
  };
}

/**
 * Runs all three checks and enforces the baselines. Prints all outputs and
 * summaries; sets `process.exitCode` to 1 on any failure.
 *
 * @returns {void}
 */
function main() {
  const failures = [];
  const configExists = fs.existsSync(JS_CONFIG);
  if (!configExists) {
    failures.push(`missing ${JS_CONFIG}; checks cannot be trusted`);
  }

  console.log(`=== tsc --noEmit -p ${JS_CONFIG} ===`);
  const tsc = run(NPX, ['tsc', '--noEmit', '-p', JS_CONFIG]);
  console.log(tsc.output.trimEnd());
  if (!tsc.ran) {
    failures.push(`tsc did not run: ${tsc.reason}`);
    console.log(`--- tsc summary: DID NOT RUN (${tsc.reason}) ---`);
  } else if (!TSC_ACCEPTED_STATUSES.has(tsc.status)) {
    failures.push(`tsc exited with unexpected status ${tsc.status}`);
    console.log(`--- tsc summary: CANNOT RUN (unexpected exit ${tsc.status}) ---`);
  } else {
    const total = countTscErrors(tsc.output);
    const sandbox = countSandboxTscErrors(tsc.output);
    const tsErrors = countTscErrorsForExtension(tsc.output, '.ts');
    const sandboxTsErrors = countSandboxTscErrors(tsc.output, '.ts');
    const scopedTsFiles = countScopedTsFiles();
    console.log(
      `--- tsc summary: ${total} errors (baseline <= ${TSC_ERROR_BASELINE}) [${tsErrors} in .ts], ` +
        `${sandbox} sandbox errors (baseline <= ${SANDBOX_TSC_ERROR_BASELINE}) [${sandboxTsErrors} in .ts], ` +
        `${scopedTsFiles} scoped .ts source files ---`
    );
    if (total > TSC_ERROR_BASELINE) {
      failures.push(`tsc errors ${total} exceed baseline ${TSC_ERROR_BASELINE}`);
    }
    if (sandbox > SANDBOX_TSC_ERROR_BASELINE) {
      failures.push(`sandbox tsc errors ${sandbox} exceed baseline ${SANDBOX_TSC_ERROR_BASELINE}`);
    }
  }

  console.log('');
  console.log(`=== tsc --noEmit -p ${CONTRACTS_CONFIG} (strict sandbox surfaces) ===`);
  if (!fs.existsSync(CONTRACTS_CONFIG)) {
    failures.push(`missing ${CONTRACTS_CONFIG}; checks cannot be trusted`);
  }
  const contractsTsc = run(NPX, ['tsc', '--noEmit', '-p', CONTRACTS_CONFIG]);
  console.log(contractsTsc.output.trimEnd());
  if (!contractsTsc.ran) {
    failures.push(`contracts tsc did not run: ${contractsTsc.reason}`);
    console.log(`--- contracts-tsc summary: DID NOT RUN (${contractsTsc.reason}) ---`);
  } else if (!TSC_ACCEPTED_STATUSES.has(contractsTsc.status)) {
    failures.push(`contracts tsc exited with unexpected status ${contractsTsc.status}`);
    console.log(`--- contracts-tsc summary: CANNOT RUN (unexpected exit ${contractsTsc.status}) ---`);
  } else {
    const contractsErrors = countTscErrors(contractsTsc.output);
    console.log(`--- contracts-tsc summary: ${contractsErrors} errors (baseline <= ${CONTRACTS_TSC_ERROR_BASELINE}) ---`);
    if (contractsErrors > CONTRACTS_TSC_ERROR_BASELINE) {
      failures.push(`contracts tsc errors ${contractsErrors} exceed baseline ${CONTRACTS_TSC_ERROR_BASELINE}`);
    }
  }

  console.log('');
  console.log(`=== svelte-check --tsconfig ./${JS_CONFIG} ===`);
  const svelteCheck = run(NPX, ['svelte-check', '--tsconfig', `./${JS_CONFIG}`]);
  console.log(svelteCheck.output.trimEnd());
  if (!svelteCheck.ran) {
    failures.push(`svelte-check did not run: ${svelteCheck.reason}`);
    console.log(`--- svelte-check summary: DID NOT RUN (${svelteCheck.reason}) ---`);
  } else if (!SVELTE_CHECK_ACCEPTED_STATUSES.has(svelteCheck.status)) {
    failures.push(`svelte-check exited with unexpected status ${svelteCheck.status}`);
    console.log(`--- svelte-check summary: CANNOT RUN (unexpected exit ${svelteCheck.status}) ---`);
  } else {
    const counts = parseSvelteCheckCounts(svelteCheck.output);
    if (!counts) {
      failures.push('svelte-check summary line not found');
      console.log('--- svelte-check summary: CANNOT RUN (no summary line) ---');
    } else {
      console.log(`--- svelte-check summary: ${counts.errors} errors, ${counts.warnings} warnings (error baseline <= ${SVELTE_CHECK_ERROR_BASELINE}) ---`);
      if (counts.errors > SVELTE_CHECK_ERROR_BASELINE) {
        failures.push(`svelte-check errors ${counts.errors} exceed baseline ${SVELTE_CHECK_ERROR_BASELINE}`);
      }
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`typecheck: FAIL — ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('typecheck: PASS — all three checks ran; no baseline exceeded.');
    process.exitCode = 0;
  }
}

main();
