#!/usr/bin/env node
/**
 * @file skills/realm-authoring/fixtures/run_fixtures.mjs
 * @description Red/green fixture harness for the standalone Realm artifact
 * validator: runs `scripts/validate_realm_artifacts.mjs --json` over every
 * fixture listed in `expectations.json` and checks the exit code and (for red
 * cases) the typed catalog error code.
 *
 * Usage: node skills/realm-authoring/fixtures/run_fixtures.mjs
 * Exit codes: 0 all expectations met, 1 a fixture diverged.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Directory containing this harness. */
const FIXTURES_DIR = import.meta.dirname;

/** Repository root (`skills/realm-authoring/fixtures` -> repo root). */
const PROJECT_ROOT = path.resolve(FIXTURES_DIR, '..', '..', '..');

/** Standalone validator under test. */
const VALIDATOR = path.join(PROJECT_ROOT, 'scripts', 'validate_realm_artifacts.mjs');

/** Red/green expectations. */
const EXPECTATIONS = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'expectations.json'), 'utf8'));

let failures = 0;
for (const testCase of EXPECTATIONS.cases) {
  const args = [VALIDATOR, path.join(FIXTURES_DIR, testCase.file), '--json'];
  if (testCase.template !== undefined) {
    args.push('--template', path.join(FIXTURES_DIR, testCase.template));
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  const problems = [];
  if (result.status !== testCase.expectExit) {
    problems.push(`exit ${result.status} (expected ${testCase.expectExit})`);
  }
  if (testCase.expectCode !== undefined && payload?.error?.code !== testCase.expectCode) {
    problems.push(`code ${payload?.error?.code ?? '<none>'} (expected ${testCase.expectCode})`);
  }
  if (testCase.expectExit === 0 && payload?.ok !== true) {
    problems.push('validator did not report ok');
  }
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL ${testCase.file}: ${problems.join('; ')}`);
    if (typeof result.stderr === 'string' && result.stderr.trim() !== '') {
      console.error(`  stderr: ${result.stderr.trim()}`);
    }
  } else {
    console.log(`PASS ${testCase.file}`);
  }
}

if (failures > 0) {
  console.error(`run_fixtures: ${failures} of ${EXPECTATIONS.cases.length} case(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`run_fixtures: ${EXPECTATIONS.cases.length} case(s) passed`);
}
