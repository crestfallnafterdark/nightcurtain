/**
 * @file tests/runner.js
 * @description Master Test Runner for the Agentic Sandbox Studio test architecture.
 * Executes all Unit and Integration test suites with zero mocks, clean logging, and timing metrics.
 */

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

async function runMasterSuite() {
  const rootDir = path.resolve(import.meta.dirname, '..');
  const unitDir = path.join(rootDir, 'tests/unit');
  const integrationDir = path.join(rootDir, 'tests/integration');

  const unitFiles = readdirSync(unitDir)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ name: f, category: 'Unit', dir: unitDir, path: path.join(unitDir, f) }));

  const integrationFiles = readdirSync(integrationDir)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ name: f, category: 'Integration', dir: integrationDir, path: path.join(integrationDir, f) }));

  const allSuites = [...unitFiles, ...integrationFiles];

  console.log(`\n${BOLD}${CYAN}======================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}  AGENTIC SANDBOX STUDIO MASTER TEST SUITE RUNNER${RESET}`);
  console.log(`${BOLD}${CYAN}  Total Suites: ${allSuites.length} (${unitFiles.length} Unit, ${integrationFiles.length} Integration)${RESET}`);
  console.log(`${BOLD}${CYAN}======================================================================${RESET}\n`);

  let passedSuites = 0;
  let failedSuites = 0;
  const suiteResults = [];

  const overallStart = Date.now();

  for (const suite of allSuites) {
    const start = Date.now();
    process.stdout.write(`  [${suite.category.padEnd(11)}] ${suite.name.padEnd(46)} `);

    const res = spawnSync('node', [suite.path], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 120000,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    const duration = Date.now() - start;

    if (res.status === 0) {
      passedSuites++;
      console.log(`${GREEN}✔ PASS${RESET} ${DIM}(${duration}ms)${RESET}`);
      suiteResults.push({ ...suite, status: 'PASS', duration });
    } else {
      failedSuites++;
      console.log(`${RED}✖ FAIL${RESET} ${DIM}(code ${res.status}, ${duration}ms)${RESET}`);
      suiteResults.push({
        ...suite,
        status: 'FAIL',
        duration,
        stderr: res.stderr || '',
        stdout: res.stdout || ''
      });
    }
  }

  const overallDuration = Date.now() - overallStart;

  console.log(`\n${BOLD}${CYAN}======================================================================${RESET}`);
  console.log(`${BOLD}  EXECUTION SUMMARY${RESET}`);
  console.log(`${BOLD}${CYAN}======================================================================${RESET}`);
  console.log(`  Suites:       ${passedSuites === allSuites.length ? GREEN : RED}${passedSuites} passed${RESET}, ${allSuites.length} total`);
  console.log(`  Failed:       ${failedSuites > 0 ? RED : GREEN}${failedSuites} failed${RESET}`);
  console.log(`  Duration:     ${(overallDuration / 1000).toFixed(2)}s`);
  console.log(`${BOLD}${CYAN}======================================================================${RESET}\n`);

  if (failedSuites > 0) {
    console.error(`${BOLD}${RED}Failures Detected:${RESET}\n`);
    for (const failed of suiteResults.filter(r => r.status === 'FAIL')) {
      console.error(`${RED}--- Failed Suite: ${failed.category}/${failed.name} ---${RESET}`);
      if (failed.stderr) console.error(failed.stderr.trim());
      if (failed.stdout) console.error(failed.stdout.trim().split('\n').slice(-10).join('\n'));
      console.error('');
    }
    process.exit(1);
  }

  process.exit(0);
}

runMasterSuite().catch(err => {
  console.error('Master test runner fatal error:', err);
  process.exit(1);
});
