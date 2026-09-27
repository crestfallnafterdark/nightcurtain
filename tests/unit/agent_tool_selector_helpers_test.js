/**
 * @file tests/unit/agent_tool_selector_helpers_test.js
 * @description Unit tests for the Agent Settings tool-permission form resolver
 * (ticket 6a0282b, finding F10): a withheld/degraded `allowedTools` selector
 * must read as default-deny runtime truth — never Full Access — and a blank
 * whitelist edit must persist default-deny instead of silently widening to `*`.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllowedToolsInput,
  resolveAgentToolFormState
} from '../../src/lib/components/sandbox/agentToolSelectorHelpers.ts';
import { TOOL_PRESETS } from '../../src/lib/sandbox/toolDefinitions/index.ts';

test('1. an absent selector reads default-deny for an unprivileged agent (F10)', () => {
  for (const config of [{}, { privileged: false }, { allowedTools: undefined }, null, undefined]) {
    assert.deepStrictEqual(
      resolveAgentToolFormState(config),
      { toolPreset: 'custom', toolsString: '' },
      `missing selector ${JSON.stringify(config)} must not read as Full Access`
    );
  }
});

test('2. a privileged agent with no list reads Full Access (the wildcard derives from privilege)', () => {
  assert.deepStrictEqual(
    resolveAgentToolFormState({ privileged: true }),
    { toolPreset: 'all', toolsString: '*' }
  );
});

test('3. an explicit wildcard list and named presets resolve to their preset keys', () => {
  assert.deepStrictEqual(
    resolveAgentToolFormState({ allowedTools: ['*'] }),
    { toolPreset: 'all', toolsString: '*' }
  );
  assert.deepStrictEqual(
    resolveAgentToolFormState({ allowedTools: [...TOOL_PRESETS.readonly] }),
    { toolPreset: 'readonly', toolsString: TOOL_PRESETS.readonly.join(', ') }
  );
  assert.deepStrictEqual(
    resolveAgentToolFormState({ allowedTools: [...TOOL_PRESETS.manager] }),
    { toolPreset: 'manager', toolsString: TOOL_PRESETS.manager.join(', ') }
  );
});

test('4. a custom list stays custom and an explicit empty list stays empty', () => {
  assert.deepStrictEqual(
    resolveAgentToolFormState({ allowedTools: ['read_file', 'write_file'] }),
    { toolPreset: 'custom', toolsString: 'read_file, write_file' }
  );
  assert.deepStrictEqual(
    resolveAgentToolFormState({ allowedTools: [] }),
    { toolPreset: 'custom', toolsString: '' }
  );
});

test('5. the editor parser only widens on an explicit wildcard', () => {
  assert.deepStrictEqual(parseAllowedToolsInput('*'), ['*']);
  assert.deepStrictEqual(parseAllowedToolsInput(' * '), ['*']);
  assert.deepStrictEqual(parseAllowedToolsInput(''), []);
  assert.deepStrictEqual(parseAllowedToolsInput('   '), []);
  assert.deepStrictEqual(parseAllowedToolsInput('read_file, ,send_message'), ['read_file', 'send_message']);
});
