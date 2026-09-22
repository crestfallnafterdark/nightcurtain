/**
 * @file tests/audit/repros/e514c5b.test.js
 * @description Audit repro for ticket e514c5b (Minor, area:docs):
 * `validateSandboxState` is documented as pure and never throwing, but its
 * prototype-pollution scan reads every own property value (`obj[key]`), so a
 * getter on the inspected object runs caller code and its exception propagates
 * out of the validator (and out of `restoreRuntimeEnvironment`, which validates
 * before its own try block).
 *
 * Evidence: `src/lib/sandbox/sandboxPersistence/index.ts` `deepHasPrototypePollution`
 * reads `val = obj[key]` for every own property name.
 *
 * Contract pin: `src/lib/sandbox/sandboxPersistence/index.ts` @invariant
 * "`validateSandboxState` is pure and never throws ... always returns a
 * ValidationResult" and the function TSDoc "Never throws".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/e514c5b.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSandboxState,
  restoreRuntimeEnvironment,
  saveSandboxState,
  PERSISTENCE_ERROR_CODES
} from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

test('e514c5b: validateSandboxState never throws on accessor-bearing input', () => {
  const hostile = {
    get version() {
      throw new Error('getter boom');
    }
  };

  let result;
  assert.doesNotThrow(() => {
    result = validateSandboxState(hostile);
  }, 'a throwing getter must not escape validateSandboxState');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.INVALID_STATE);

  const nestedHostile = {
    version: '1.0.0',
    timestamp: 1726531200000,
    agents: [],
    virtualFs: {
      get global() {
        throw new Error('nested getter boom');
      }
    }
  };
  assert.doesNotThrow(() => {
    result = validateSandboxState(nestedHostile);
  }, 'a throwing nested getter must not escape validateSandboxState');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.INVALID_STATE);

  let restoreResult;
  assert.doesNotThrow(() => {
    restoreResult = restoreRuntimeEnvironment(hostile, { importSnapshot() {} });
  }, 'restoreRuntimeEnvironment must return a RestoreResult instead of throwing');
  assert.strictEqual(restoreResult.success, false);
  assert.strictEqual(restoreResult.code, PERSISTENCE_ERROR_CODES.INVALID_STATE);

  assert.strictEqual(saveSandboxState(hostile), false);
});
