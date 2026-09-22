/**
 * @file tests/unit/tool_preset_resolve_test.js
 * @description Unit tests for the launcher tool-permission resolver
 * (ticket 4e7cc01): blank custom whitelists deny instead of granting '*'.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolGrants } from '../../src/lib/components/sandbox/toolPresetResolve.ts';
import { TOOL_PRESETS } from '../../src/lib/sandbox/toolDefinitions/index.ts';

test('1. blank custom whitelist fails validation and never grants a wildcard', () => {
  for (const input of ['', '   ', '\t\n', ',,,', ' , , ']) {
    const resolution = resolveToolGrants('custom', input);
    assert.strictEqual(resolution.ok, false, `custom input ${JSON.stringify(input)} must be rejected`);
    assert.ok(typeof resolution.error === 'string' && resolution.error.length > 0);
    assert.ok(!('allowedTools' in resolution), 'a rejected resolution must not carry grants');
  }
});

test('2. blanks mixed with names drop blanks and keep the names', () => {
  assert.deepStrictEqual(resolveToolGrants('custom', ' read_file , , send_message ,  '), {
    ok: true,
    allowedTools: ['read_file', 'send_message']
  });
});

test('3. single custom entry resolves', () => {
  assert.deepStrictEqual(resolveToolGrants('custom', ' whoami '), {
    ok: true,
    allowedTools: ['whoami']
  });
});

test('4. alias entries resolve to canonical tool names', () => {
  assert.deepStrictEqual(
    resolveToolGrants('custom', 'readFile, fs_writeFile, virtualFs.readFile'),
    { ok: true, allowedTools: ['read_file', 'write_file'] }
  );
});

test('5. explicit wildcard remains an intentional grant', () => {
  assert.deepStrictEqual(resolveToolGrants('custom', '*'), { ok: true, allowedTools: ['*'] });
  assert.deepStrictEqual(resolveToolGrants('custom', 'all'), { ok: true, allowedTools: ['*'] });
  assert.deepStrictEqual(resolveToolGrants('all', ''), { ok: true, allowedTools: ['*'] });
  assert.deepStrictEqual(resolveToolGrants('*', ''), { ok: true, allowedTools: ['*'] });
});

test('6. named presets keep their catalog behavior', () => {
  for (const preset of ['manager', 'collaborator', 'readonly_collaborator', 'readonly']) {
    assert.deepStrictEqual(
      resolveToolGrants(preset, ''),
      { ok: true, allowedTools: [...TOOL_PRESETS[preset]] },
      `preset '${preset}' must resolve to its frozen catalog list`
    );
  }
});

test('7. unknown preset fails closed', () => {
  const resolution = resolveToolGrants('bogus', '');
  assert.strictEqual(resolution.ok, false);
  assert.match(resolution.error, /Unknown tool permission profile/);
});

test('8. only an explicit wildcard selection yields a wildcard grant', () => {
  const inputs = [
    ['custom', ''],
    ['custom', '   '],
    ['custom', 'read_file, write_file'],
    ['manager', ''],
    ['collaborator', ''],
    ['readonly_collaborator', ''],
    ['readonly', ''],
    ['bogus', '']
  ];
  for (const [preset, custom] of inputs) {
    const resolution = resolveToolGrants(preset, custom);
    if (resolution.ok) {
      assert.ok(
        !resolution.allowedTools.includes('*'),
        `'${preset}' with custom ${JSON.stringify(custom)} must not wildcard`
      );
    }
  }
});
