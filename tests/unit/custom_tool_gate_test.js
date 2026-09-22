/**
 * @file tests/unit/custom_tool_gate_test.js
 * @description A0-5 (ticket 0443865): host-registered custom tool handlers
 * execute before the dispatcher capability gate and receive raw substrate
 * handles, so the turn execution engine must authorize every custom-handler
 * invocation directly against the caller's frozen `AuthorityDescriptor` —
 * never through the dispatcher's union `isAuthorized` behavior.
 *
 * Policy under test:
 * - a caller whose descriptor `allow` holds the wildcard `'*'` or the
 *   lifecycle-authority capability `'@lifecycle:authority'` may execute custom
 *   handlers (as does an engine-internal principal projection);
 * - an `allowedTools` entry that merely matches the handler name does NOT
 *   grant custom execution (the acceptance case);
 * - anonymous callers (missing/no identity projection, or no identity port)
 *   are denied;
 * - custom schemas are hidden from ungranted callers (chosen behavior:
 *   block), while granted callers still receive them.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutionEngine } from '../../src/lib/sandbox/runtime/turnExecutionEngine/index.ts';

const LIFECYCLE_AUTHORITY_CAPABILITY = '@lifecycle:authority';

/**
 * Builds a frozen authority descriptor stub matching the runtime projection
 * shape (`subject`/`kind`/`allow`/`visibility`).
 */
function makeAuthority(agentId, allow, kind = 'agent') {
  const allowSet = new Set(allow);
  return Object.freeze({
    subject: agentId,
    kind,
    allow: allowSet,
    visibility: kind === 'internal' || allowSet.has('*') ? 'all' : 'self'
  });
}

/** Builds a frozen identity projection stub with the given authority grant. */
function makeIdentity(agentId, allow, { privileged = false, kind = 'agent' } = {}) {
  return Object.freeze({
    id: agentId,
    privileged,
    allowedTools: [...allow],
    authority: makeAuthority(agentId, allow, kind)
  });
}

/**
 * Builds a frozen identity projection whose descriptor capability probe throws.
 * @param {string} agentId - Bound subject id.
 * @returns {object}
 */
function makeThrowingProbeIdentity(agentId) {
  return Object.freeze({
    id: agentId,
    privileged: false,
    allowedTools: ['probe'],
    authority: Object.freeze({
      subject: agentId,
      kind: 'agent',
      allow: Object.freeze({
        has() {
          throw new Error('capability probe exploded');
        }
      }),
      visibility: 'self'
    })
  });
}

/**
 * Builds an identity projection whose `authority` property accessor throws.
 * @param {string} agentId - Bound subject id.
 * @returns {object}
 */
function makeThrowingAuthorityAccessorIdentity(agentId) {
  return {
    id: agentId,
    privileged: false,
    allowedTools: ['probe'],
    get authority() {
      throw new Error('authority accessor exploded');
    }
  };
}

/**
 * Builds an identity projection whose descriptor `allow` accessor throws.
 * @param {string} agentId - Bound subject id.
 * @returns {object}
 */
function makeThrowingAllowAccessorIdentity(agentId) {
  return Object.freeze({
    id: agentId,
    privileged: false,
    allowedTools: ['probe'],
    authority: {
      subject: agentId,
      kind: 'agent',
      get allow() {
        throw new Error('allow accessor exploded');
      },
      visibility: 'self'
    }
  });
}

/**
 * Builds an identity projection whose `allow.has` property accessor throws.
 * @param {string} agentId - Bound subject id.
 * @returns {object}
 */
function makeThrowingHasAccessorIdentity(agentId) {
  return Object.freeze({
    id: agentId,
    privileged: false,
    allowedTools: ['probe'],
    authority: Object.freeze({
      subject: agentId,
      kind: 'agent',
      allow: Object.freeze({
        get has() {
          throw new Error('has accessor exploded');
        }
      }),
      visibility: 'self'
    })
  });
}

/** Minimal engine-compatible agent fixture. */
function makeAgent(id, { allowedTools = [], customTools = null, customToolSchemas = null, pendingPrecalls = [] } = {}) {
  return {
    id,
    name: id,
    state: 'idle',
    stateDetail: null,
    history: [],
    turnCount: 0,
    currentTurnPromise: null,
    abortController: null,
    lastError: null,
    lastSummary: null,
    lastInterruptedTurn: null,
    pendingPrecalls,
    currentStream: '',
    currentReasoning: '',
    activeToolCalls: [],
    redoStack: [],
    telemetry: {
      turnPromptTokens: 0,
      turnCompletionTokens: 0,
      turnTotalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      precallCount: 0,
      terminalStops: 0,
      injectedDeliveries: 0
    },
    config: {
      role: 'collaborator',
      maxTurns: 4,
      identityHeader: false,
      allowedTools,
      ...(customTools ? { customTools } : {}),
      ...(customToolSchemas ? { customToolSchemas } : {})
    },
    model: null,
    rebindModel() {}
  };
}

/**
 * Mock model: first pass streams one tool call for `toolName`, every later
 * pass concludes with prose. Captures the first `stream(options)` payload so
 * tests can assert the exposed tool schema surface.
 */
function createToolLoopModel(toolName = null) {
  let pass = 0;
  const model = {
    streamOptions: null,
    async *stream(options) {
      model.streamOptions = model.streamOptions || options;
      if (pass++ === 0 && toolName) {
        yield { type: 'text', content: 'calling tool' };
        yield {
          type: 'tool_call',
          toolCalls: [{
            id: `call_${toolName}`,
            type: 'function',
            name: toolName,
            function: { name: toolName, arguments: '{}' }
          }]
        };
      } else {
        yield { type: 'text', content: 'done' };
      }
    }
  };
  return model;
}

/** Builds an engine whose runtime stub exposes the supplied identity projections. */
function createEngine(identities, { customTools = null, virtualFs = null } = {}) {
  return new TurnExecutionEngine({
    runtime: {
      createAgentIdentityPort: () => ({
        getAgentIdentity: (agentId) => (identities instanceof Map ? (identities.get(agentId) ?? null) : null)
      })
    },
    customTools,
    virtualFs
  });
}

/** Extracts the tool names from a model stream-options payload. */
function schemaNames(streamOptions) {
  return (streamOptions?.tools || []).map((entry) => entry?.function?.name || entry?.name || '');
}

/** Returns the tool-role receipts recorded in agent history. */
function toolMessages(agent) {
  return agent.history.filter((message) => message.role === 'tool');
}

const PROBE_SCHEMA = Object.freeze({
  type: 'function',
  function: {
    name: 'probe',
    description: 'Host probe',
    parameters: { type: 'object', properties: {} }
  }
});

// ---------------------------------------------------------------------------
// Acceptance: a matching allowlist entry never grants custom execution
// ---------------------------------------------------------------------------

test('A0-5 acceptance: allowlisted name match does not authorize the custom handler', async () => {
  let handlerCalls = 0;
  const agent = makeAgent('gate_matched_allowlist', {
    allowedTools: ['probe'],
    customTools: {
      probe: () => {
        handlerCalls += 1;
        return { success: true, leaked: 'custom-handler-output' };
      }
    },
    customToolSchemas: [PROBE_SCHEMA]
  });
  agent.model = createToolLoopModel('probe');

  const identity = makeIdentity(agent.id, ['probe']);
  const engine = createEngine(new Map([[agent.id, identity]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed');
  assert.strictEqual(handlerCalls, 0, 'an allowlist entry matching the handler name must not authorize custom execution');

  const [toolMessage] = toolMessages(agent);
  assert.ok(toolMessage, 'the denied custom call must still produce a tool receipt for the model');
  const parsed = JSON.parse(toolMessage.content);
  assert.strictEqual(parsed.success, false, 'the custom handler output must never reach history for an ungranted caller');

  assert.ok(
    !schemaNames(agent.model.streamOptions).includes('probe'),
    'custom tool schemas must be hidden from ungranted callers'
  );
});

// ---------------------------------------------------------------------------
// Granted callers may execute custom handlers and see custom schemas
// ---------------------------------------------------------------------------

test('A0-5: wildcard authority executes custom handlers and exposes custom schemas', async () => {
  let handlerCalls = 0;
  const agent = makeAgent('gate_wildcard', {
    allowedTools: ['*'],
    customTools: {
      probe: () => {
        handlerCalls += 1;
        return { success: true, source: 'wildcard' };
      }
    },
    customToolSchemas: [PROBE_SCHEMA]
  });
  agent.model = createToolLoopModel('probe');

  const identity = makeIdentity(agent.id, ['*'], { privileged: true });
  const engine = createEngine(new Map([[agent.id, identity]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed');
  assert.strictEqual(handlerCalls, 1, 'wildcard authority must execute the custom handler');

  const [toolMessage] = toolMessages(agent);
  assert.strictEqual(JSON.parse(toolMessage.content).source, 'wildcard');

  assert.ok(
    schemaNames(agent.model.streamOptions).includes('probe'),
    'granted callers must receive custom tool schemas'
  );
});

test('A0-5: lifecycle-authority sentinel executes custom handlers', async () => {
  let handlerCalls = 0;
  const agent = makeAgent('gate_lifecycle_authority', {
    allowedTools: [],
    customTools: {
      probe: () => {
        handlerCalls += 1;
        return { success: true, source: 'lifecycle-authority' };
      }
    }
  });
  agent.model = createToolLoopModel('probe');

  const identity = makeIdentity(agent.id, [LIFECYCLE_AUTHORITY_CAPABILITY]);
  const engine = createEngine(new Map([[agent.id, identity]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed');
  assert.strictEqual(handlerCalls, 1, 'the lifecycle-authority capability must execute the custom handler');
  assert.strictEqual(JSON.parse(toolMessages(agent)[0].content).source, 'lifecycle-authority');
});

test('A0-5: engine-internal principal projection executes custom handlers', async () => {
  let handlerCalls = 0;
  const agent = makeAgent('gate_internal_principal', {
    allowedTools: [],
    customTools: {
      probe: () => {
        handlerCalls += 1;
        return { success: true, source: 'internal' };
      }
    }
  });
  agent.model = createToolLoopModel('probe');

  const identity = makeIdentity(agent.id, [], { kind: 'internal' });
  const engine = createEngine(new Map([[agent.id, identity]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed');
  assert.strictEqual(handlerCalls, 1, 'an engine-internal principal projection is host-trusted');
  assert.strictEqual(JSON.parse(toolMessages(agent)[0].content).source, 'internal');
});

// ---------------------------------------------------------------------------
// Anonymous callers are denied
// ---------------------------------------------------------------------------

test('A0-5: anonymous callers cannot execute custom handlers', async () => {
  for (const variant of ['unresolvable-identity', 'no-identity-port']) {
    let handlerCalls = 0;
    const agent = makeAgent(`gate_anonymous_${variant}`, {
      allowedTools: ['probe'],
      customTools: {
        probe: () => {
          handlerCalls += 1;
          return { success: true, source: 'anonymous' };
        }
      },
      customToolSchemas: [PROBE_SCHEMA]
    });
    agent.model = createToolLoopModel('probe');

    const engine = variant === 'no-identity-port'
      ? new TurnExecutionEngine({ emit: { emit: () => {} } })
      : createEngine(new Map());

    const receipt = await engine.executeAgentTurn(agent, 'go');

    assert.strictEqual(receipt.status, 'completed', `${variant}: turn still settles`);
    assert.strictEqual(handlerCalls, 0, `${variant}: anonymous callers must be denied custom execution`);
    const [toolMessage] = toolMessages(agent);
    assert.ok(toolMessage, `${variant}: the denied call must still produce a tool receipt`);
    assert.strictEqual(JSON.parse(toolMessage.content).success, false, `${variant}: no custom output may surface`);
    assert.ok(
      !schemaNames(agent.model.streamOptions).includes('probe'),
      `${variant}: custom schemas must be hidden from anonymous callers`
    );
  }
});

// ---------------------------------------------------------------------------
// A throwing capability probe denies without aborting the turn
// ---------------------------------------------------------------------------

test('A0-5 follow-up: a descriptor whose allow.has throws denies custom execution, turn still settles', async () => {
  let handlerCalls = 0;
  const agent = makeAgent('gate_throwing_probe', {
    allowedTools: ['probe'],
    customTools: {
      probe: () => {
        handlerCalls += 1;
        return { success: true, source: 'throwing-probe' };
      }
    },
    customToolSchemas: [PROBE_SCHEMA]
  });
  agent.model = createToolLoopModel('probe');

  const engine = createEngine(new Map([[agent.id, makeThrowingProbeIdentity(agent.id)]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed', 'the turn must settle instead of aborting');
  assert.strictEqual(handlerCalls, 0, 'a throwing capability probe must deny custom execution');
  const [toolMessage] = toolMessages(agent);
  assert.ok(toolMessage, 'the denied custom call must still produce a tool receipt');
  assert.strictEqual(JSON.parse(toolMessage.content).success, false, 'no custom output may surface');
  assert.ok(
    !schemaNames(agent.model.streamOptions).includes('probe'),
    'custom schemas must be hidden when the capability probe throws'
  );
});

/**
 * Runs one turn for a caller whose projection carries a throwing descriptor
 * accessor and asserts the custom handler was denied without aborting the turn.
 * @param {string} label - Variant label used in assertion messages.
 * @param {string} agentId - Agent id (also the projection subject).
 * @param {(agentId: string) => object} makeIdentity - Projection factory.
 */
async function assertThrowingAccessorDenied(label, agentId, makeIdentity) {
  let handlerCalls = 0;
  const agent = makeAgent(agentId, {
    allowedTools: ['probe'],
    customTools: {
      probe: () => {
        handlerCalls += 1;
        return { success: true, source: 'throwing-accessor' };
      }
    },
    customToolSchemas: [PROBE_SCHEMA]
  });
  agent.model = createToolLoopModel('probe');

  const engine = createEngine(new Map([[agent.id, makeIdentity(agent.id)]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed', `${label}: the turn must settle instead of aborting`);
  assert.strictEqual(handlerCalls, 0, `${label}: a throwing descriptor accessor must deny custom execution`);
  const [toolMessage] = toolMessages(agent);
  assert.ok(toolMessage, `${label}: the denied custom call must still produce a tool receipt`);
  assert.strictEqual(JSON.parse(toolMessage.content).success, false, `${label}: no custom output may surface`);
  assert.ok(
    !schemaNames(agent.model.streamOptions).includes('probe'),
    `${label}: custom schemas must be hidden when the descriptor accessor throws`
  );
}

test('A0-5 follow-up: a throwing authority accessor denies custom execution, turn still settles (8716523)', async () => {
  await assertThrowingAccessorDenied(
    'authority accessor',
    'gate_throwing_authority_accessor',
    makeThrowingAuthorityAccessorIdentity
  );
});

test('A0-5 follow-up: a throwing allow accessor denies custom execution, turn still settles (8716523)', async () => {
  await assertThrowingAccessorDenied(
    'allow accessor',
    'gate_throwing_allow_accessor',
    makeThrowingAllowAccessorIdentity
  );
});

test('A0-5 follow-up: a throwing allow.has accessor denies custom execution, turn still settles (8716523)', async () => {
  await assertThrowingAccessorDenied(
    'allow.has accessor',
    'gate_throwing_has_accessor',
    makeThrowingHasAccessorIdentity
  );
});

// ---------------------------------------------------------------------------
// Precall pipeline obeys the same gate
// ---------------------------------------------------------------------------

test('A0-5: precall pipeline never executes an ungranted custom handler', async () => {
  let handlerCalls = 0;
  const agent = makeAgent('gate_precall', {
    allowedTools: ['read_file'],
    customTools: {
      read_file: () => {
        handlerCalls += 1;
        return { success: true, content: 'custom-handler-content' };
      }
    },
    pendingPrecalls: [{ name: 'read_file', arguments: { path: '/notes.md' } }]
  });
  agent.model = createToolLoopModel(null);

  const identity = makeIdentity(agent.id, ['read_file']);
  const engine = createEngine(new Map([[agent.id, identity]]));
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed');
  assert.strictEqual(handlerCalls, 0, 'a precall name matching the allowlist must not authorize the custom handler');
  assert.ok(toolMessages(agent).length >= 1, 'the precall must still dispatch through the normal tool path');

  // Positive control: wildcard authority executes the same precall handler.
  let wildcardHandlerCalls = 0;
  const wildcardAgent = makeAgent('gate_precall_wildcard', {
    allowedTools: ['*'],
    customTools: {
      read_file: () => {
        wildcardHandlerCalls += 1;
        return { success: true, content: 'wildcard-custom-content' };
      }
    },
    pendingPrecalls: [{ name: 'read_file', arguments: { path: '/notes.md' } }]
  });
  wildcardAgent.model = createToolLoopModel(null);

  const wildcardIdentity = makeIdentity(wildcardAgent.id, ['*'], { privileged: true });
  const wildcardEngine = createEngine(new Map([[wildcardAgent.id, wildcardIdentity]]));
  await wildcardEngine.executeAgentTurn(wildcardAgent, 'go');

  assert.strictEqual(wildcardHandlerCalls, 1, 'wildcard authority must execute the precall custom handler');
  const wildcardToolMessage = toolMessages(wildcardAgent)[0];
  assert.match(wildcardToolMessage.content, /wildcard-custom-content/);
});
