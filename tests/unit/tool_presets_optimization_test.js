/**
 * @file tests/unit/tool_presets_optimization_test.js
 * @description Unit and integration tests for Tool Schema Optimization and Tool Presets Overhaul.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_TOOLS,
  TOOL_PRESETS,
  resolveToolPreset,
  getSandboxToolsSchema,
  createSandboxToolDispatcher
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';

test('1. TOOL_PRESETS Definition & Immutability', () => {
  assert.ok(TOOL_PRESETS, 'TOOL_PRESETS must be exported');
  assert.ok(Object.isFrozen(TOOL_PRESETS), 'TOOL_PRESETS must be frozen');

  const expectedPresets = ['all', 'manager', 'collaborator', 'readonly_collaborator', 'readonly'];
  for (const preset of expectedPresets) {
    assert.ok(TOOL_PRESETS[preset], `TOOL_PRESETS must contain '${preset}'`);
    assert.ok(Array.isArray(TOOL_PRESETS[preset]), `TOOL_PRESETS.${preset} must be an array`);
  }

  assert.deepStrictEqual(TOOL_PRESETS.all, ['*']);
  // The retired selector is not a tier member; the deprecated window still
  // resolves it to exactly the four legacy subagent-management tools.
  assert.strictEqual(TOOL_PRESETS.manager.includes('subagent_management'), false);
  assert.deepStrictEqual(
    resolveToolPreset('subagent_management'),
    ['spawn_agent', 'kill_agent', 'invoke_agent', 'undo_turn']
  );
  assert.strictEqual(TOOL_PRESETS.manager.includes('spawn_agent'), true);
  assert.strictEqual(TOOL_PRESETS.manager.includes('world_clock'), false);
  assert.strictEqual(TOOL_PRESETS.manager.includes('event_list'), false);
  assert.strictEqual(TOOL_PRESETS.collaborator.includes('subagent_management'), false);
  assert.strictEqual(TOOL_PRESETS.collaborator.includes('send_message'), true);
  assert.strictEqual(TOOL_PRESETS.readonly_collaborator.includes('send_message'), true);
  assert.strictEqual(TOOL_PRESETS.readonly_collaborator.includes('write_file'), false);
  assert.strictEqual(TOOL_PRESETS.readonly.includes('send_message'), false);
  assert.strictEqual(TOOL_PRESETS.readonly.includes('read_file'), true);
});

test('2. resolveToolPreset Resolution', () => {
  assert.deepStrictEqual(resolveToolPreset('all'), ['*']);
  assert.deepStrictEqual(resolveToolPreset('*'), ['*']);
  assert.deepStrictEqual(resolveToolPreset(), []);
  assert.deepStrictEqual(resolveToolPreset(null), []);
  assert.deepStrictEqual(resolveToolPreset(undefined), []);
  assert.deepStrictEqual(resolveToolPreset('manager'), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset('collaborator'), [...TOOL_PRESETS.collaborator]);
  assert.deepStrictEqual(resolveToolPreset('readonly_collaborator'), [...TOOL_PRESETS.readonly_collaborator]);
  assert.deepStrictEqual(resolveToolPreset('readonly'), [...TOOL_PRESETS.readonly]);
  assert.deepStrictEqual(resolveToolPreset(['manager']), [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(resolveToolPreset(['read_file', 'write_file']), ['read_file', 'write_file']);
  assert.deepStrictEqual(resolveToolPreset('read_file, write_file'), ['read_file', 'write_file']);
});

test('3. getSandboxToolsSchema Integration', () => {
  const allSchemas = getSandboxToolsSchema('all');
  assert.strictEqual(allSchemas.length, 41);

  const managerSchemas = getSandboxToolsSchema('manager');
  assert.strictEqual(managerSchemas.length, 37);
  assert.ok(managerSchemas.some(t => t.function.name === SANDBOX_TOOLS.SPAWN_AGENT));
  assert.ok(managerSchemas.some(t => t.function.name === SANDBOX_TOOLS.GET_ARCHIVE));
  assert.ok(managerSchemas.some(t => t.function.name === SANDBOX_TOOLS.LIST_AGENTS));
  assert.ok(managerSchemas.some(t => t.function.name === SANDBOX_TOOLS.WAIT_FOR_INVOCATION));
  assert.ok(managerSchemas.some(t => t.function.name === SANDBOX_TOOLS.WAIT_FOR_AGENT));

  const collabSchemas = getSandboxToolsSchema('collaborator');
  assert.strictEqual(collabSchemas.length, 28);
  assert.ok(!collabSchemas.some(t => t.function.name === SANDBOX_TOOLS.SPAWN_AGENT));
  assert.ok(!collabSchemas.some(t => t.function.name === SANDBOX_TOOLS.LIST_AGENTS));
  assert.ok(collabSchemas.some(t => t.function.name === SANDBOX_TOOLS.SEND_MESSAGE));

  const readonlyCollabSchemas = getSandboxToolsSchema('readonly_collaborator');
  assert.strictEqual(readonlyCollabSchemas.length, 17);
  assert.ok(readonlyCollabSchemas.some(t => t.function.name === SANDBOX_TOOLS.SEND_MESSAGE));
  assert.ok(!readonlyCollabSchemas.some(t => t.function.name === SANDBOX_TOOLS.WRITE_FILE));

  const readonlySchemas = getSandboxToolsSchema('readonly');
  assert.strictEqual(readonlySchemas.length, 16);
  assert.ok(!readonlySchemas.some(t => t.function.name === SANDBOX_TOOLS.SEND_MESSAGE));
  assert.ok(readonlySchemas.some(t => t.function.name === SANDBOX_TOOLS.READ_FILE));
});

test('4. Schema Draft-07 Conformance', () => {
  const allSchemas = getSandboxToolsSchema();
  assert.strictEqual(allSchemas.length, 41);

  const spawnDef = allSchemas.find(t => t.function.name === SANDBOX_TOOLS.SPAWN_AGENT);
  assert.ok(spawnDef, 'spawn_agent schema definition must exist');
  assert.ok(spawnDef.function.parameters.properties.id, 'id property must exist');

  for (const tool of allSchemas) {
    assert.ok(tool.type === 'function', `Tool ${tool.function.name} type must be function`);
    assert.ok(typeof tool.function.name === 'string', 'Tool name must be string');
    assert.ok(typeof tool.function.description === 'string', 'Tool description must be string');
    assert.ok(tool.function.parameters && typeof tool.function.parameters === 'object', 'Parameters must be object');
    // The emitted keyword always matches the runtime boundary: closed for every
    // descriptor except the ratified spawn_agent accept-and-warn boundary
    // (decision ticket f41f838).
    const isSpawn = tool.function.name === SANDBOX_TOOLS.SPAWN_AGENT;
    assert.strictEqual(
      tool.function.parameters.additionalProperties,
      isSpawn,
      `${tool.function.name} additionalProperties must match its boundary policy`
    );
    assert.ok(Array.isArray(tool.function.parameters.required), 'required must be array');
  }
});

test('5. AgentRuntime & Dispatcher Integration', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus });
  // The spawn_agent dispatcher below is bound to `director`; bootstrapping it
  // first keeps the spawn an agent-principal launch (the ratified capability
  // default applies to resolved agent callers; principal-less host launches
  // keep their legacy behavior).
  await runtime.ensureDirector();

  const agentA = await runtime.launchAgent({
    id: 'agent_ro_collab',
    name: 'Readonly Collab',
    allowedTools: 'readonly_collaborator'
  });
  assert.deepStrictEqual(agentA.config.allowedTools, [...TOOL_PRESETS.readonly_collaborator]);

  runtime.updateAgentConfig('agent_ro_collab', {
    allowedTools: 'manager'
  });
  assert.deepStrictEqual(agentA.config.allowedTools, [...TOOL_PRESETS.manager]);

  const dispatcher = createSandboxToolDispatcher({
    virtualFs: vfs,
    messagingBus: bus,
    agentId: 'director',
    privileged: true,
    runtime
  });

  const spawnRes = await dispatcher.executeTool('spawn_agent', {
    id: 'spawned_child_agent',
    name: 'Spawned Child'
  });
  assert.strictEqual(spawnRes.success, true);
  const spawned = runtime.getAgent('spawned_child_agent');
  assert.ok(spawned);
  // Ratified default (decision ticket f41f838): a spawn with no capability
  // selector leaves the child the readonly_collaborator ∩ spawner set —
  // never the legacy zero-tool child. The director spawner here holds `'*'`,
  // so the full readonly_collaborator preset applies.
  assert.deepStrictEqual(spawned.config.allowedTools, [...TOOL_PRESETS.readonly_collaborator]);
  assert.deepStrictEqual(spawnRes.allowedTools, [...TOOL_PRESETS.readonly_collaborator]);
});
