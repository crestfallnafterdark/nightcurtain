/**
 * @file tests/unit/precall_gate_adversarial_test.js
 * @description Independent adversarial test suite for the forbidden-precall gate (BUG-ENC-017).
 *
 * Exercises `batchPrecallDescriptor.handler` through its public surface with a minimal
 * execution context (`executeTool` spy) and asserts the required post-fix semantics:
 *   - resolves to an allowlisted canonical name -> allowed (executes);
 *   - legitimate aliases normalizing to allowlisted canonicals -> allowed (executes);
 *   - resolves to a non-allowlisted canonical name -> denied with PRECALL_FORBIDDEN;
 *   - cannot be resolved (null/undefined/unknown/typo/non-string) -> denied;
 *   - denied calls never reach the execution path (`executeTool` is never invoked).
 *
 * Hermetic and deterministic: no timers, no network, no filesystem writes.
 * This suite intentionally does NOT modify or import any other test file.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { batchPrecallDescriptor } from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { TOOL_SYSTEM_ERROR_CODES } from '../../src/lib/sandbox/tools/constants/index.ts';
import { PRECALL_ALLOWLIST, getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';

/** Structured denial codes permitted for names that cannot be resolved to a canonical tool. */
const UNRESOLVED_DENIAL_CODES = new Set([
  TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN,
  TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS
]);

/**
 * Minimal `executeTool` spy. Records every invocation; never performs real work.
 * @returns {{ executeTool: (name: any, args: any, ctx: any) => Promise<any>, calls: Array<{ name: any, args: any, ctx: any }> }}
 */
function createExecuteToolSpy() {
  /** @type {Array<{ name: any, args: any, ctx: any }>} */
  const calls = [];
  const executeTool = async (name, args, ctx) => {
    calls.push({ name, args, ctx });
    return { executed: true, tool: name, args };
  };
  return { executeTool, calls };
}

/**
 * Invokes the batch_precall descriptor handler with a single-call batch.
 * @param {unknown} name
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<{ result: any, calls: Array<{ name: any, args: any, ctx: any }>, context: { executeTool: (name: any, args: any, ctx: any) => Promise<any> } }>}
 */
async function invokeSingle(name, args = {}) {
  const spy = createExecuteToolSpy();
  const context = { executeTool: spy.executeTool };
  const result = await batchPrecallDescriptor.handler(
    { calls: [{ name, arguments: args }] },
    context
  );
  return { result, calls: spy.calls, context };
}

/**
 * Asserts a call is denied with PRECALL_FORBIDDEN and never executed.
 * @param {unknown} name
 * @param {string} [expectedCanon]
 */
async function assertForbidden(name, expectedCanon = String(name)) {
  const { result, calls } = await invokeSingle(name);
  assert.strictEqual(result.success, true, `'${String(name)}': batch envelope must remain successful`);
  assert.strictEqual(result.count, 1, `'${String(name)}': batch must return one per-call result`);
  const item = result.results[0];
  assert.strictEqual(item.success, false, `'${String(name)}': call must be denied`);
  assert.strictEqual(
    item.code,
    TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN,
    `'${String(name)}' resolves to non-allowlisted '${expectedCanon}' and must be denied with PRECALL_FORBIDDEN (got '${item.code}')`
  );
  assert.match(String(item.error), /forbidden/i, `'${String(name)}': denial error must state the tool is forbidden`);
  assert.strictEqual(calls.length, 0, `'${String(name)}': denied call must never reach executeTool`);
}

/**
 * Asserts an unresolvable name is denied (structured denial) and never executed.
 * @param {unknown} name
 */
async function assertDeniedUnresolved(name) {
  const { result, calls } = await invokeSingle(name);
  assert.strictEqual(result.success, true, `'${String(name)}': batch envelope must remain successful`);
  assert.strictEqual(result.count, 1, `'${String(name)}': batch must return one per-call result`);
  const item = result.results[0];
  assert.strictEqual(item.success, false, `'${String(name)}': unresolvable call must be denied`);
  assert.ok(
    UNRESOLVED_DENIAL_CODES.has(item.code),
    `'${String(name)}': denial must carry PRECALL_FORBIDDEN or INVALID_ARGUMENTS (got '${item.code}')`
  );
  assert.strictEqual(calls.length, 0, `'${String(name)}': unresolvable call must never reach executeTool`);
}

// -----------------------------------------------------------------------------
// 1. Positive control: allowlisted canonical names are allowed and execute
// -----------------------------------------------------------------------------

test('1. every allowlisted canonical precall name executes exactly once', async () => {
  const allowlisted = [...PRECALL_ALLOWLIST].sort();
  assert.ok(allowlisted.length >= 14, `precall allowlist unexpectedly small (${allowlisted.length} entries)`);

  for (const canon of allowlisted) {
    const args = { probe: canon, nested: { depth: 1 } };
    const { result, calls, context } = await invokeSingle(canon, args);

    assert.strictEqual(result.success, true, `'${canon}': batch envelope`);
    assert.strictEqual(result.count, 1, `'${canon}': count`);
    assert.strictEqual(calls.length, 1, `'${canon}': allowlisted call must execute exactly once`);
    assert.strictEqual(getCanonToolName(calls[0].name), canon, `'${canon}': executed under canonical identity`);
    assert.deepStrictEqual(calls[0].args, args, `'${canon}': arguments must pass through unchanged`);
    assert.strictEqual(calls[0].ctx, context, `'${canon}': execution context must be threaded through`);
    assert.deepStrictEqual(
      result.results[0].result,
      { executed: true, tool: canon, args },
      `'${canon}': execution result must be surfaced`
    );
  }
});

// -----------------------------------------------------------------------------
// 2. Positive control: legitimate aliases normalize to allowlisted canonicals
// -----------------------------------------------------------------------------

test('2. legitimate aliases normalize to allowlisted canonicals and execute', async () => {
  /** @type {Array<[string, string]>} */
  const aliasCases = [
    ['readFile', 'read_file'],
    ['virtualFs_readFile', 'read_file'],
    ['fs.readFile', 'read_file'],
    ['file_read', 'read_file'],
    ['ReAd_FiLe', 'read_file'],
    ['  readFile  ', 'read_file'],
    ['ls', 'list_files'],
    ['listDir', 'list_files'],
    ['queryJson', 'query_json'],
    ['read_json', 'query_json'],
    ['grep_search', 'grep'],
    ['search', 'grep'],
    ['clock', 'world_clock'],
    ['get_time', 'get_current_time'],
    ['now', 'get_current_time'],
    ['events', 'event_list'],
    ['check_inbox', 'list_inbox'],
    ['messaging_listInbox', 'list_inbox'],
    ['readMail', 'read_message'],
    ['messaging_getArchive', 'get_archive'],
    ['runtime_listAgents', 'list_agents'],
    ['get_identity', 'whoami'],
    ['system_describeTool', 'describe_tool']
  ];

  for (const [alias, canon] of aliasCases) {
    assert.strictEqual(getCanonToolName(alias), canon, `fixture: '${alias}' must resolve to '${canon}'`);
    assert.ok(PRECALL_ALLOWLIST.has(canon), `fixture: '${canon}' must be in PRECALL_ALLOWLIST`);

    const args = { aliasCheck: alias };
    const { result, calls } = await invokeSingle(alias, args);

    assert.strictEqual(result.success, true, `'${alias}': batch envelope`);
    assert.strictEqual(result.count, 1, `'${alias}': count`);
    assert.strictEqual(calls.length, 1, `'${alias}' must execute exactly once`);
    assert.strictEqual(
      getCanonToolName(calls[0].name),
      canon,
      `'${alias}' must execute under the allowlisted canonical '${canon}'`
    );
    assert.deepStrictEqual(calls[0].args, args, `'${alias}': arguments must pass through unchanged`);
    assert.strictEqual(result.results[0].result.executed, true, `'${alias}': execution result must be surfaced`);
  }
});

// -----------------------------------------------------------------------------
// 3. Negative control: non-allowlisted canonical names -> PRECALL_FORBIDDEN
// -----------------------------------------------------------------------------

test('3. non-allowlisted canonical names are denied with PRECALL_FORBIDDEN and never execute', async () => {
  const forbiddenCanonicalNames = [
    'write_file',
    'replace_file_content',
    'copy_file',
    'delete_file',
    'write_json',
    'json_patch',
    'set_permissions',
    'send_message',
    'wait_for_mail',
    'inline_file_in_message',
    'drain_inbox',
    'spawn_agent',
    'kill_agent',
    'undo_turn',
    'invoke_agent',
    'wait_for_invocation',
    'schedule',
    'list_schedules',
    'cancel_schedule',
    'batch_precall'
  ];

  for (const name of forbiddenCanonicalNames) {
    assert.strictEqual(getCanonToolName(name), name, `fixture: '${name}' must resolve to itself`);
    assert.strictEqual(PRECALL_ALLOWLIST.has(name), false, `fixture: '${name}' must NOT be allowlisted`);
    await assertForbidden(name);
  }
});

// -----------------------------------------------------------------------------
// 4. Non-allowlisted aliases -> PRECALL_FORBIDDEN (resolution must not be dodged)
// -----------------------------------------------------------------------------

test('4. aliases of non-allowlisted canonicals are denied with PRECALL_FORBIDDEN and never execute', async () => {
  /** @type {Array<[string, string]>} */
  const forbiddenAliasCases = [
    ['chmod', 'set_permissions'],
    ['fs.chmod', 'set_permissions'],
    ['rm', 'delete_file'],
    ['unlink', 'delete_file'],
    ['fs.writeFile', 'write_file'],
    ['writeFile', 'write_file'],
    ['  Write_File  ', 'write_file'],
    ['sendMessage', 'send_message'],
    ['messaging_sendMessage', 'send_message'],
    ['send', 'send_message'],
    ['spawn', 'spawn_agent'],
    ['runtime_killAgent', 'kill_agent'],
    ['kill', 'kill_agent'],
    ['undo', 'undo_turn'],
    ['invoke', 'invoke_agent'],
    ['set_timer', 'schedule'],
    ['cancel_timer', 'cancel_schedule'],
    ['clear_inbox', 'drain_inbox'],
    ['render_prompt', 'inline_file_in_message']
  ];

  for (const [alias, canon] of forbiddenAliasCases) {
    assert.strictEqual(getCanonToolName(alias), canon, `fixture: '${alias}' must resolve to '${canon}'`);
    assert.strictEqual(PRECALL_ALLOWLIST.has(canon), false, `fixture: '${canon}' must NOT be allowlisted`);
    await assertForbidden(alias, canon);
  }
});

// -----------------------------------------------------------------------------
// 5. BUG-ENC-017 bypass: unresolvable string names must be denied, not executed
// -----------------------------------------------------------------------------

test('5. unresolvable string names (typos/unknown/prototype keys) are denied and never execute', async () => {
  const unresolvableNames = [
    'read_flie',
    'write_fil',
    'totally_unknown_tool',
    'fs.readFilee',
    'batch_precall_',
    'READ_FILEX',
    'read file',
    'read-file',
    'réad_file',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'toString',
    'valueOf',
    '   '
  ];

  for (const name of unresolvableNames) {
    assert.strictEqual(getCanonToolName(name), null, `fixture: '${name}' must be unresolvable`);
    await assertDeniedUnresolved(name);
  }
});

// -----------------------------------------------------------------------------
// 6. Nullish / empty names must be denied, not executed
// -----------------------------------------------------------------------------

test('6. null, undefined, empty, and falsy names are denied and never execute', async () => {
  const nullishNames = [null, undefined, '', 0, false, NaN];

  for (const name of nullishNames) {
    await assertDeniedUnresolved(name);
  }
});

// -----------------------------------------------------------------------------
// 7. Non-string truthy names cannot smuggle execution past the gate
// -----------------------------------------------------------------------------

test('7. non-string truthy names are denied and never execute', async () => {
  const nonStringNames = [123, 0.5, true, {}, [], ['read_file'], { name: 'read_file' }, Symbol('read_file')];

  for (const name of nonStringNames) {
    assert.strictEqual(getCanonToolName(name), null, `fixture: '${String(name)}' must be unresolvable`);
    await assertDeniedUnresolved(name);
  }
});

// -----------------------------------------------------------------------------
// 8. Mixed batch: denials are isolated and only allowlisted calls execute
// -----------------------------------------------------------------------------

test('8. mixed batch isolates denials: only allowlisted calls reach the execution path', async () => {
  const spy = createExecuteToolSpy();
  const context = { executeTool: spy.executeTool };

  const result = await batchPrecallDescriptor.handler({
    calls: [
      { name: 'readFile', arguments: { path: 'a.txt' } },
      { name: 'write_file', arguments: { path: 'evil.txt', content: 'x' } },
      { name: 'read_flie', arguments: { path: 'a.txt' } },
      { name: 'ls', arguments: { recursive: true } },
      { name: 'sendMessage', arguments: { to: 'director' } },
      { name: null, arguments: {} },
      { name: 123, arguments: {} }
    ]
  }, context);

  assert.strictEqual(result.success, true, 'batch envelope must remain successful');
  assert.strictEqual(result.count, 7, 'every item must produce a result');
  assert.strictEqual(result.results.length, 7, 'every item must produce a result');

  assert.deepStrictEqual(
    result.results.map((item) => (item && item.success === false ? 'DENIED' : 'ALLOWED')),
    ['ALLOWED', 'DENIED', 'DENIED', 'ALLOWED', 'DENIED', 'DENIED', 'DENIED'],
    'only the two allowlisted calls may be allowed'
  );

  assert.strictEqual(spy.calls.length, 2, 'exactly two calls may reach executeTool');
  assert.deepStrictEqual(
    spy.calls.map((call) => getCanonToolName(call.name)),
    ['read_file', 'list_files'],
    'executed calls must be the allowlisted canonicals'
  );
  assert.deepStrictEqual(
    spy.calls.map((call) => call.args),
    [{ path: 'a.txt' }, { recursive: true }],
    'executed calls must carry their original arguments'
  );

  assert.strictEqual(result.results[0].result.executed, true, 'readFile must execute');
  assert.strictEqual(result.results[1].code, TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN, 'write_file must be forbidden');
  assert.ok(UNRESOLVED_DENIAL_CODES.has(result.results[2].code), 'typo must be denied');
  assert.strictEqual(result.results[3].result.executed, true, 'ls must execute');
  assert.strictEqual(result.results[4].code, TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN, 'sendMessage must be forbidden');
  assert.ok(UNRESOLVED_DENIAL_CODES.has(result.results[5].code), 'null name must be denied');
  assert.ok(UNRESOLVED_DENIAL_CODES.has(result.results[6].code), 'numeric name must be denied');
});

// -----------------------------------------------------------------------------
// 9. R4 gate agreement: phantom aliases absent from the canonical map are denied
// -----------------------------------------------------------------------------

test("9. R4 gate agreement: phantom 'time_now' is not canonical-resolvable and the descriptor gate denies it", async () => {
  // Canonical authority (tools/normalizers/index.ts): 'time_now' reads like a clock
  // alias but is absent from the master alias map, so the descriptor gate fail-closes
  // on it. The engine-local precall gate must agree (pinned in runtime_execution_module_test.js).
  assert.strictEqual(getCanonToolName('time_now'), null, "'time_now' must not resolve to a canonical tool");
  assert.strictEqual(PRECALL_ALLOWLIST.has('time_now'), false, "'time_now' must not be allowlisted");

  const { result, calls } = await invokeSingle('time_now', {});
  assert.strictEqual(result.success, true, 'batch envelope must remain successful');
  assert.strictEqual(result.count, 1, 'batch must return one per-call result');
  assert.strictEqual(result.results[0].success, false, "'time_now' must be denied");
  assert.strictEqual(
    result.results[0].code,
    TOOL_SYSTEM_ERROR_CODES.PRECALL_FORBIDDEN,
    "'time_now' must be denied with PRECALL_FORBIDDEN"
  );
  assert.strictEqual(calls.length, 0, 'phantom precall must never reach executeTool');
});

// -----------------------------------------------------------------------------
// 10. R7 Symbol guard: Symbol names yield a structured denial without throwing
// -----------------------------------------------------------------------------

test("10. R7 Symbol guard: Symbol('read_file') yields a structured denial without throwing or executing", async () => {
  const symbolName = Symbol('read_file');
  assert.strictEqual(typeof symbolName, 'symbol', 'fixture must be a Symbol');
  assert.strictEqual(getCanonToolName(symbolName), null, 'Symbols must not resolve canonically');

  // Before the guard, the forged denial message interpolated the Symbol and threw
  // TypeError instead of producing a structured denial.
  const { result, calls } = await invokeSingle(symbolName, {});
  assert.strictEqual(result.success, true, 'batch envelope must remain successful');
  assert.strictEqual(result.count, 1, 'batch must return one per-call result');
  const item = result.results[0];
  assert.strictEqual(item.success, false, 'Symbol-named call must be denied');
  assert.ok(
    UNRESOLVED_DENIAL_CODES.has(item.code),
    `Symbol denial must carry PRECALL_FORBIDDEN or INVALID_ARGUMENTS (got '${item.code}')`
  );
  assert.strictEqual(calls.length, 0, 'Symbol-named call must never reach executeTool');
});
