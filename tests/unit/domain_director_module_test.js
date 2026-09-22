/**
 * @file tests/unit/domain_director_module_test.js
 * @description Comprehensive isolated unit test suite for Module 7: domain_director.
 *
 * Verifies:
 * 1. Contract Invariants & Strict Whitelist Proof (E \ D = ∅).
 * 2. Deep Specification Immutability & Directive Wiring.
 * 3. Exhaustive isDirector Type Guard & Non-Throwing Input Robustness.
 * 4. Root Privilege & Immutability Enforcement (SEC-1, SEC-13).
 * 5. WeakMap Concurrency-Locked Singleton Deduplication.
 * 6. Prototype Pollution Defenses (Object.prototype hardening).
 * 7. Runtime Host Contract Validation & Resilient Re-Provisioning.
 * 8. AgentRuntime Facade Integration via runtime/index.ts.
 */

import '../test_env.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as DirectorModule from '../../src/lib/sandbox/domain/directorAgent/index.ts';
const {
  DIRECTOR_AGENT_ID,
  DIRECTOR_ROLE,
  DIRECTOR_DIRECTIVE,
  DIRECTOR_ERROR_CODES,
  DIRECTOR_SPEC,
  DirectorDomainError,
  isDirector,
  ensureDirectorAgent
} = DirectorModule;

import { Agent } from '../../src/lib/sandbox/runtime/agent/index.ts';
import { AgentRuntime, createAgentRuntime, RUNTIME_STATUS } from '../../src/lib/sandbox/runtime/index.ts';

// ============================================================================
// 1. Contract Invariants & Export Whitelist
// ============================================================================

test('1. Strict Export Whitelist & Constant Types', () => {
  const exportedKeys = Object.keys(DirectorModule).sort();
  assert.deepStrictEqual(exportedKeys, [
    'DIRECTOR_AGENT_ID',
    'DIRECTOR_DIRECTIVE',
    'DIRECTOR_ERROR_CODES',
    'DIRECTOR_ROLE',
    'DIRECTOR_SPEC',
    'DirectorDomainError',
    'ensureDirectorAgent',
    'isDirector'
  ]);

  // Identifiers
  assert.strictEqual(DIRECTOR_AGENT_ID, 'director');
  assert.strictEqual(DIRECTOR_ROLE, 'director');

  // Error Codes
  assert.ok(Object.isFrozen(DIRECTOR_ERROR_CODES));
  assert.strictEqual(DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME, 'ERR_INVALID_RUNTIME');
  assert.strictEqual(DIRECTOR_ERROR_CODES.ERR_DIRECTOR_LAUNCH_FAILED, 'ERR_DIRECTOR_LAUNCH_FAILED');
  assert.strictEqual(DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE, 'ERR_INVALID_SPEC_OVERRIDE');
  assert.strictEqual(DIRECTOR_ERROR_CODES.ERR_DIRECTOR_CORRUPT, 'ERR_DIRECTOR_CORRUPT');

  // Operational Directive: behavior text, not a pinned invariant.
  assert.ok(typeof DIRECTOR_DIRECTIVE === 'string' && DIRECTOR_DIRECTIVE.length > 50);

  // Deep Specification Immutability
  assert.ok(Object.isFrozen(DIRECTOR_SPEC));
  assert.ok(Object.isFrozen(DIRECTOR_SPEC.tools));
  assert.ok(Object.isFrozen(DIRECTOR_SPEC.allowedTools));
  assert.strictEqual(DIRECTOR_SPEC.id, DIRECTOR_AGENT_ID);
  assert.strictEqual(DIRECTOR_SPEC.name, 'Director');
  assert.strictEqual(DIRECTOR_SPEC.role, DIRECTOR_ROLE);
  assert.strictEqual(DIRECTOR_SPEC.systemPrompt, DIRECTOR_DIRECTIVE);
  assert.strictEqual(DIRECTOR_SPEC.privileged, true);
  assert.deepStrictEqual(DIRECTOR_SPEC.tools, ['*']);
  assert.deepStrictEqual(DIRECTOR_SPEC.allowedTools, ['*']);
  assert.strictEqual(DIRECTOR_SPEC.workspaceId, DIRECTOR_AGENT_ID);
});

test('2. DirectorDomainError: Error Code and Metadata Encapsulation', () => {
  const err = new DirectorDomainError(
    'Host validation failed',
    DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME,
    { attempt: 1, host: 'invalid' }
  );

  assert.ok(err instanceof Error);
  assert.ok(err instanceof DirectorDomainError);
  assert.strictEqual(err.name, 'DirectorDomainError');
  assert.strictEqual(err.message, 'Host validation failed');
  assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME);
  assert.deepStrictEqual(err.details, { attempt: 1, host: 'invalid' });
  assert.ok(Object.isFrozen(err.details));

  // Default empty details
  const errDefault = new DirectorDomainError('Simple error', DIRECTOR_ERROR_CODES.ERR_DIRECTOR_CORRUPT);
  assert.deepStrictEqual(errDefault.details, {});
  assert.ok(Object.isFrozen(errDefault.details));
});

// ============================================================================
// 2. isDirector Predicate & Type Guard Tests
// ============================================================================

test('3. isDirector: String Identifier Matching & Whitespace Trimming', () => {
  assert.strictEqual(isDirector('director'), true);
  assert.strictEqual(isDirector('  director  '), true);
  assert.strictEqual(isDirector('\tdirector\n'), true);

  assert.strictEqual(isDirector('director_agent'), false);
  assert.strictEqual(isDirector('writer'), false);
  assert.strictEqual(isDirector(''), false);
  assert.strictEqual(isDirector('   '), false);
  assert.strictEqual(isDirector('DIRECTOR'), false);
});

test('4. isDirector: Object and Agent Instance Matching', () => {
  // Direct id property
  assert.strictEqual(isDirector({ id: 'director' }), true);
  assert.strictEqual(isDirector({ id: '  director ' }), true);
  assert.strictEqual(isDirector({ id: 'writer' }), false);
  assert.strictEqual(isDirector({ id: 123 }), false);

  // Target with config object
  assert.strictEqual(isDirector({ config: { id: 'director' } }), true);
  assert.strictEqual(isDirector({ config: { id: '  director  ' } }), true);
  assert.strictEqual(isDirector({ config: { id: 'writer' } }), false);

  // Both direct id and config
  assert.strictEqual(isDirector({ id: 'director', config: { id: 'director' } }), true);
  assert.strictEqual(isDirector({ id: 'writer', config: { id: 'writer' } }), false);
  assert.strictEqual(isDirector({ id: 'writer', config: { id: 'director' } }), true, 'Matches via config.id per rule 2');

  // Real Agent domain instance
  const directorAgent = new Agent({ id: 'director', name: 'Director', role: 'director' });
  assert.strictEqual(isDirector(directorAgent), true);

  const workerAgent = new Agent({ id: 'worker_1', name: 'Worker', role: 'worker' });
  assert.strictEqual(isDirector(workerAgent), false);
});

test('5. isDirector: Non-Throwing Invariant across Fuzz & Malformed Inputs', () => {
  const fuzzInputs = [
    null,
    undefined,
    0,
    1,
    -1,
    NaN,
    Infinity,
    true,
    false,
    Symbol('director'),
    Symbol.for('director'),
    () => 'director',
    function() { return 'director'; },
    [],
    ['director'],
    [1, 2, 3],
    new Date(),
    new RegExp('director'),
    new Map(),
    new Set(),
    Object.create(null)
  ];

  for (const input of fuzzInputs) {
    assert.doesNotThrow(() => {
      const res = isDirector(input);
      assert.strictEqual(typeof res, 'boolean');
      assert.strictEqual(res, false);
    });
  }

  // Throwing getters must safely return false
  const throwingIdTarget = {
    get id() {
      throw new Error('Explosive getter');
    }
  };
  assert.doesNotThrow(() => {
    assert.strictEqual(isDirector(throwingIdTarget), false);
  });

  const throwingConfigTarget = {
    get config() {
      throw new Error('Explosive config getter');
    }
  };
  assert.doesNotThrow(() => {
    assert.strictEqual(isDirector(throwingConfigTarget), false);
  });

  // Circular reference objects
  const circularTarget = { id: 'other' };
  circularTarget.self = circularTarget;
  assert.strictEqual(isDirector(circularTarget), false);
});

// ============================================================================
// 3. Prototype Pollution Defenses
// ============================================================================

test('6. Prototype Pollution Defenses: Object.prototype Hardening', () => {
  const originalProtoIdDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'id');
  const originalProtoConfigDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'config');
  const originalProtoPrivilegedDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'privileged');
  const originalProtoToolsDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'tools');

  try {
    // Attack 1: Polluting Object.prototype.id = 'director'
    Object.prototype.id = 'director';

    // Plain empty objects must NOT be recognized as director
    assert.strictEqual(isDirector({}), false, 'Empty object must not pass isDirector when prototype is polluted');
    assert.strictEqual(isDirector({ name: 'Bob' }), false, 'Innocent object must not pass isDirector when prototype is polluted');
    assert.strictEqual(isDirector({ role: 'writer' }), false);

    // Legitimate director with own property id must still pass
    assert.strictEqual(isDirector({ id: 'director' }), true);
    assert.strictEqual(isDirector(new Agent({ id: 'director' })), true);

    // Legitimate non-director with own property id must fail
    assert.strictEqual(isDirector({ id: 'writer' }), false);
    assert.strictEqual(isDirector(new Agent({ id: 'writer' })), false);

    // Attack 2: Polluting Object.prototype.config = { id: 'director' }
    delete Object.prototype.id;
    Object.prototype.config = { id: 'director' };

    assert.strictEqual(isDirector({}), false, 'Empty object must not pass when Object.prototype.config is polluted');
    assert.strictEqual(isDirector({ foo: 'bar' }), false);

    // Attack 3: Polluting Object.prototype.privileged = false and Object.prototype.tools = ['restricted']
    delete Object.prototype.config;
    Object.prototype.privileged = false;
    Object.prototype.tools = ['restricted'];

    // Mock host to verify ensureDirectorAgent is resistant to prototype pollution
    const mockHost = {
      agent: null,
      getAgent(id) {
        return id === 'director' ? this.agent : null;
      },
      async launchAgent(spec) {
        assert.strictEqual(spec.privileged, true, 'Launched spec must retain privileged: true despite pollution');
        assert.deepStrictEqual(spec.tools, ['*'], 'Launched spec must retain tools: [*] despite pollution');
        this.agent = new Agent(spec);
        return this.agent;
      }
    };

    // Calling ensureDirectorAgent with empty overrides must not trigger false ERR_INVALID_SPEC_OVERRIDE
    return (async () => {
      const director = await ensureDirectorAgent(mockHost, { overrides: {} });
      assert.strictEqual(director.id, 'director');
      assert.strictEqual(director.config.privileged, true);
      assert.deepStrictEqual(director.config.tools, ['*']);
    })();
  } finally {
    // Teardown prototype modifications
    if (originalProtoIdDesc) {
      Object.defineProperty(Object.prototype, 'id', originalProtoIdDesc);
    } else {
      delete Object.prototype.id;
    }

    if (originalProtoConfigDesc) {
      Object.defineProperty(Object.prototype, 'config', originalProtoConfigDesc);
    } else {
      delete Object.prototype.config;
    }

    if (originalProtoPrivilegedDesc) {
      Object.defineProperty(Object.prototype, 'privileged', originalProtoPrivilegedDesc);
    } else {
      delete Object.prototype.privileged;
    }

    if (originalProtoToolsDesc) {
      Object.defineProperty(Object.prototype, 'tools', originalProtoToolsDesc);
    } else {
      delete Object.prototype.tools;
    }
  }
});

// ============================================================================
// 4. Runtime Host Validation & Error Handling
// ============================================================================

test('7. Runtime Host Contract Validation', async () => {
  const invalidHosts = [
    null,
    undefined,
    'not_a_runtime',
    12345,
    true,
    {},
    { getAgent: () => null }, // missing launchAgent
    { launchAgent: async () => ({}) }, // missing getAgent
    { launchAgent: 'not_a_func', getAgent: () => null }
  ];

  for (const host of invalidHosts) {
    await assert.rejects(
      async () => {
        await ensureDirectorAgent(host);
      },
      (err) => {
        assert.ok(err instanceof DirectorDomainError);
        assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_RUNTIME);
        return true;
      }
    );
  }

  // Valid minimal host exposing the public getAgent/launchAgent contract
  const agentsMap = new Map();
  const mapHost = {
    getAgent(id) {
      return agentsMap.get(id) || null;
    },
    async launchAgent(spec) {
      const agent = new Agent(spec);
      agentsMap.set(spec.id, agent);
      return agent;
    }
  };

  const agentFromMapHost = await ensureDirectorAgent(mapHost);
  assert.strictEqual(agentFromMapHost.id, 'director');
  assert.strictEqual(agentsMap.get('director'), agentFromMapHost);
});

test('8. Launch Failure and Corrupt Agent Error Handling', async () => {
  // Launch failure handling (runtime error during launchAgent)
  const failingHost = {
    getAgent: () => null,
    async launchAgent() {
      throw new Error('Hardware / DB failure during agent instantiation');
    }
  };

  await assert.rejects(
    async () => {
      await ensureDirectorAgent(failingHost);
    },
    (err) => {
      assert.ok(err instanceof DirectorDomainError);
      assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_DIRECTOR_LAUNCH_FAILED);
      assert.ok(err.message.includes('Hardware / DB failure'));
      return true;
    }
  );

  // Corrupt agent instance returned by host
  const corruptHost = {
    getAgent: () => null,
    async launchAgent() {
      // Returns a non-director object
      return { id: 'imposter_agent', name: 'Imposter' };
    }
  };

  await assert.rejects(
    async () => {
      await ensureDirectorAgent(corruptHost);
    },
    (err) => {
      assert.ok(err instanceof DirectorDomainError);
      assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_DIRECTOR_CORRUPT);
      return true;
    }
  );
});

// ============================================================================
// 5. Root Privilege & Spec Override Enforcement (SEC-1, SEC-13)
// ============================================================================

test('9. Root Privilege & Immutability Invariant Enforcement', async () => {
  const mockHost = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  const illegalOverrides = [
    { overrides: { id: 'not_director' }, field: 'id' },
    { overrides: { id: 'director' }, field: 'id' },
    { overrides: { role: 'writer' }, field: 'role' },
    { overrides: { role: 'director' }, field: 'role' },
    { overrides: { privileged: false }, field: 'privileged' },
    { overrides: { privileged: true }, field: 'privileged' },
    { overrides: { workspaceId: 'custom_ws' }, field: 'workspaceId' },
    { overrides: { workspaceId: 'director' }, field: 'workspaceId' },
    { overrides: { tools: ['fs_read'] }, field: 'tools' },
    { overrides: { tools: [] }, field: 'tools' },
    { overrides: { tools: ['*'] }, field: 'tools' },
    { overrides: { allowedTools: ['fs_read'] }, field: 'allowedTools' },
    { overrides: { allowedTools: [] }, field: 'allowedTools' },
    { overrides: { allowedTools: ['*'] }, field: 'allowedTools' },
    { overrides: { foo: 'bar' }, field: 'foo' },
    { overrides: { model: {} }, field: 'model' },
    { overrides: { provider: {} }, field: 'provider' },
    { overrides: { state: 'running' }, field: 'state' },
    { overrides: { isAdmin: true }, field: 'isAdmin' }
  ];

  for (const { overrides, field } of illegalOverrides) {
    await assert.rejects(
      async () => {
        await ensureDirectorAgent(mockHost, { overrides });
      },
      (err) => {
        assert.ok(err instanceof DirectorDomainError);
        assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE);
        assert.strictEqual(err.details?.field, field);
        return true;
      },
      `Should reject illegal override of field '${field}'`
    );
  }

  // Permitted overrides
  let capturedConfig = null;
  const interceptHost = {
    getAgent() { return null; },
    async launchAgent(spec) {
      capturedConfig = spec;
      return new Agent(spec);
    }
  };

  const director = await ensureDirectorAgent(interceptHost, {
    overrides: {
      name: 'Custom Director Display',
      systemPrompt: 'Custom prompt with directives intact',
      modelConfig: { temperature: 0.2 }
    }
  });

  assert.strictEqual(director.name, 'Custom Director Display');
  assert.strictEqual(capturedConfig.name, 'Custom Director Display');
  assert.strictEqual(capturedConfig.systemPrompt, 'Custom prompt with directives intact');
  assert.deepStrictEqual(capturedConfig.modelConfig, { temperature: 0.2 });
  assert.strictEqual(capturedConfig.privileged, true);
  assert.deepStrictEqual(capturedConfig.tools, ['*']);
  assert.deepStrictEqual(capturedConfig.allowedTools, ['*']);
  assert.strictEqual(capturedConfig.workspaceId, 'director');
  assert.strictEqual(capturedConfig.role, 'director');
});

test('9b. Override Whitelist Regression: Arbitrary Config Keys Are Rejected Before Launch', async () => {
  let launchCount = 0;
  const host = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      launchCount++;
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  const arbitraryKeys = ['foo', 'bar', 'systemPromt', 'prompt', 'model', 'provider', 'state', 'globalConfig', 'owner', 'updatedAt'];

  for (const key of arbitraryKeys) {
    const overrides = { name: 'Whitelisted Name', [key]: 'arbitrary-value' };
    await assert.rejects(
      async () => {
        await ensureDirectorAgent(host, { overrides });
      },
      (err) => {
        assert.ok(err instanceof DirectorDomainError);
        assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE);
        assert.strictEqual(err.details?.field, key);
        assert.strictEqual(err.details?.value, 'arbitrary-value');
        return true;
      },
      `Arbitrary override key '${key}' must be rejected with ERR_INVALID_SPEC_OVERRIDE`
    );
  }

  assert.strictEqual(launchCount, 0, 'No launch may occur when an override key is rejected');

  // Inherited (prototype) keys are not own overrides: they must not block a valid launch
  // and must not leak into the composed configuration.
  const inheritedOverrides = Object.create({ foo: 'inherited-bar' });
  inheritedOverrides.name = 'Inherited-Safe Director';
  const director = await ensureDirectorAgent(host, { overrides: inheritedOverrides });
  assert.strictEqual(launchCount, 1);
  assert.strictEqual(director.name, 'Inherited-Safe Director');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(director.config, 'foo'), false);
});

test('9c. Override Type Confusion: Non-Object overrides Rejected With ERR_INVALID_SPEC_OVERRIDE Before Launch', async () => {
  let launchCount = 0;
  const host = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      launchCount++;
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  const functionWithPayload = function () {};
  functionWithPayload.foo = 'function-carried';

  const nonObjectOverrides = [
    'name=Evil Director',
    'id',
    ['name', 'systemPrompt'],
    [['name', 'Evil']],
    [],
    42,
    0,
    true,
    Symbol('overrides'),
    10n,
    functionWithPayload
  ];

  for (const overrides of nonObjectOverrides) {
    await assert.rejects(
      async () => {
        await ensureDirectorAgent(host, { overrides });
      },
      (err) => {
        assert.ok(err instanceof DirectorDomainError, `Expected DirectorDomainError for ${String(overrides)}`);
        assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE);
        assert.strictEqual(err.details?.field, 'overrides');
        assert.strictEqual(err.details?.value, overrides);
        return true;
      },
      `Non-object overrides (${typeof overrides}) must be rejected before launch`
    );
  }

  assert.strictEqual(launchCount, 0, 'No launch may occur while overrides are type-rejected');

  // Object-shaped overrides still flow through the key whitelist (not the type guard)
  const rogueInstance = new (class RogueOverrides {
    constructor() {
      this.id = 'not_director';
    }
  })();
  await assert.rejects(
    async () => {
      await ensureDirectorAgent(host, { overrides: rogueInstance });
    },
    (err) => {
      assert.ok(err instanceof DirectorDomainError);
      assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE);
      assert.strictEqual(err.details?.field, 'id');
      return true;
    },
    'Class-instance overrides must be rejected via the whitelist key check'
  );

  const nullProtoRejected = Object.create(null);
  nullProtoRejected.id = 'not_director';
  await assert.rejects(
    async () => {
      await ensureDirectorAgent(host, { overrides: nullProtoRejected });
    },
    (err) => {
      assert.ok(err instanceof DirectorDomainError);
      assert.strictEqual(err.code, DIRECTOR_ERROR_CODES.ERR_INVALID_SPEC_OVERRIDE);
      assert.strictEqual(err.details?.field, 'id');
      return true;
    },
    'Null-prototype overrides must still be key-filtered'
  );

  assert.strictEqual(launchCount, 0, 'Whitelist rejections must not launch the Director');

  // Absent (undefined) and null overrides remain legal and launch with canonical defaults
  const directorA = await ensureDirectorAgent(host, { overrides: undefined });
  assert.strictEqual(directorA.id, 'director');
  assert.strictEqual(launchCount, 1);

  host.agent = null;
  const directorB = await ensureDirectorAgent(host, { overrides: null });
  assert.strictEqual(directorB.id, 'director');
  assert.strictEqual(launchCount, 2);
});

test('9d. Override Own-Key Semantics: Inherited Whitelisted Values Do Not Leak; Null-Prototype Bags Apply', async () => {
  let launchCount = 0;
  let capturedConfig = null;
  const host = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      launchCount++;
      capturedConfig = spec;
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  // Inherited (non-own) whitelisted values must not be composed into the config
  const inheritedWhitelist = Object.create({
    name: 'Inherited Director',
    systemPrompt: 'Inherited prompt',
    modelConfig: { temperature: 0.9 }
  });
  inheritedWhitelist.systemPrompt = 'Own prompt';

  const inheritedDirector = await ensureDirectorAgent(host, { overrides: inheritedWhitelist });
  assert.strictEqual(launchCount, 1);
  assert.strictEqual(inheritedDirector.name, DIRECTOR_SPEC.name, 'Inherited name must not override the canonical name');
  assert.strictEqual(capturedConfig.name, DIRECTOR_SPEC.name);
  assert.strictEqual(capturedConfig.systemPrompt, 'Own prompt');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(capturedConfig, 'modelConfig'),
    false,
    'Inherited modelConfig must not leak into the composed configuration'
  );

  // Null-prototype object with own whitelisted keys is a valid overrides bag
  host.agent = null;
  const nullProto = Object.create(null);
  nullProto.name = 'Null-Proto Director';
  nullProto.systemPrompt = 'Null-proto prompt';
  nullProto.modelConfig = { temperature: 0.1 };

  const nullProtoDirector = await ensureDirectorAgent(host, { overrides: nullProto });
  assert.strictEqual(launchCount, 2);
  assert.strictEqual(nullProtoDirector.name, 'Null-Proto Director');
  assert.strictEqual(capturedConfig.systemPrompt, 'Null-proto prompt');
  assert.deepStrictEqual(capturedConfig.modelConfig, { temperature: 0.1 });
});

// ============================================================================
// 6. Concurrency Locks & Deduplication
// ============================================================================

test('10. WeakMap Concurrency-Locked Singleton Deduplication', async () => {
  let launchCount = 0;
  let delayResolve;
  const launchDelayedPromise = new Promise((resolve) => {
    delayResolve = resolve;
  });

  const slowHost = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      launchCount++;
      await launchDelayedPromise;
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  // Launch 10 concurrent requests on the same runtime host
  const concurrentCalls = Array.from({ length: 10 }, () => ensureDirectorAgent(slowHost));

  // Release the launch delay
  delayResolve();

  const results = await Promise.all(concurrentCalls);

  // Exactly 1 launch must have occurred
  assert.strictEqual(launchCount, 1, 'Only a single launchAgent invocation must occur across concurrent requests');

  // All returned instances must be identical by reference
  const firstInstance = results[0];
  assert.ok(firstInstance instanceof Agent);
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i], firstInstance, `Result ${i} must equal the first instance`);
  }

  // Subsequent call after completion must return the existing instance immediately
  const subsequentCall = await ensureDirectorAgent(slowHost);
  assert.strictEqual(subsequentCall, firstInstance);
  assert.strictEqual(launchCount, 1, 'Subsequent call must reuse cached agent without re-launching');
});

test('11. Concurrency Lock Isolation Across Distinct Hosts & Failure Cleanup', async () => {
  let host1Count = 0;
  let host2Count = 0;

  const host1 = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      host1Count++;
      await new Promise(r => setTimeout(r, 10));
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  const host2 = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      host2Count++;
      await new Promise(r => setTimeout(r, 10));
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  // Concurrently ensure on two distinct hosts
  const [d1, d2] = await Promise.all([
    ensureDirectorAgent(host1),
    ensureDirectorAgent(host2)
  ]);

  assert.strictEqual(host1Count, 1);
  assert.strictEqual(host2Count, 1);
  assert.notStrictEqual(d1, d2, 'Distinct runtime hosts must produce distinct Director instances');

  // Failure cleanup test: lock must be removed on failure so subsequent attempts work
  let shouldFail = true;
  let failHostCount = 0;
  const flakyHost = {
    agent: null,
    getAgent() { return this.agent; },
    async launchAgent(spec) {
      failHostCount++;
      if (shouldFail) {
        throw new Error('Temporary launch failure');
      }
      this.agent = new Agent(spec);
      return this.agent;
    }
  };

  await assert.rejects(async () => {
    await ensureDirectorAgent(flakyHost);
  }, DirectorDomainError);

  assert.strictEqual(failHostCount, 1);

  // Second attempt after failure succeeds
  shouldFail = false;
  const recoveredDirector = await ensureDirectorAgent(flakyHost);
  assert.strictEqual(failHostCount, 2);
  assert.strictEqual(recoveredDirector.id, 'director');
});

// ============================================================================
// 7. Resilient Lifecycle & Re-Provisioning
// ============================================================================

test('12. Resilient Lifecycle & Re-Provisioning (Terminated / Recycled Re-Launch)', async () => {
  let launchCounter = 0;
  let currentAgent = null;

  const dynamicHost = {
    getAgent(id) {
      return id === 'director' ? currentAgent : null;
    },
    async launchAgent(spec) {
      launchCounter++;
      currentAgent = new Agent(spec);
      return currentAgent;
    }
  };

  // 1. Initial launch
  const d1 = await ensureDirectorAgent(dynamicHost);
  assert.strictEqual(launchCounter, 1);
  assert.strictEqual(d1.state, 'idle');

  // 2. Active idle returns existing
  const d1_again = await ensureDirectorAgent(dynamicHost);
  assert.strictEqual(d1_again, d1);
  assert.strictEqual(launchCounter, 1);

  // 3. Set state to running -> returns existing
  d1.state = 'running';
  const d1_running = await ensureDirectorAgent(dynamicHost);
  assert.strictEqual(d1_running, d1);
  assert.strictEqual(launchCounter, 1);

  // 4. Terminate agent -> ensureDirectorAgent must re-launch a new Director!
  d1.state = 'terminated';
  const d2 = await ensureDirectorAgent(dynamicHost);
  assert.strictEqual(launchCounter, 2, 'Must re-launch when prior Director was terminated');
  assert.notStrictEqual(d2, d1);
  assert.strictEqual(d2.id, 'director');
  assert.strictEqual(d2.state, 'idle');

  // 5. Recycle agent -> ensureDirectorAgent must re-launch a new Director!
  d2.state = 'recycled';
  const d3 = await ensureDirectorAgent(dynamicHost);
  assert.strictEqual(launchCounter, 3, 'Must re-launch when prior Director was recycled');
  assert.notStrictEqual(d3, d2);
  assert.strictEqual(d3.id, 'director');
  assert.strictEqual(d3.state, 'idle');
});

// ============================================================================
// 8. End-to-End AgentRuntime Integration via Facade
// ============================================================================

test('13. End-to-End Integration with AgentRuntime Facade', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);
  assert.strictEqual(runtime.getAgent('director'), null);

  // 1. Ensure director via runtime.ensureDirector()
  const director = await runtime.ensureDirector();
  assert.ok(director instanceof Agent);
  assert.strictEqual(director.id, 'director');
  assert.strictEqual(director.config.role, 'director');
  assert.strictEqual(director.config.privileged, true);
  assert.deepStrictEqual(director.config.tools, ['*']);
  assert.strictEqual(isDirector(director), true);

  // 2. Verify identity via whoami
  const identity = runtime.whoami('director');
  assert.strictEqual(identity.id, 'director');
  assert.strictEqual(identity.role, 'director');
  assert.strictEqual(identity.privileged, true);
  assert.strictEqual(identity.workspaceId, 'director');
  assert.deepStrictEqual(identity.allowedTools, ['*']);

  // 3. Re-query via ensureDirector() returns same singleton instance
  const director2 = await runtime.ensureDirector();
  assert.strictEqual(director2, director);

  // 4. Soft-kill Director to recycle bin (self-termination carries a principal)
  const killed = runtime.killAgent('director', 'Administrative recycle', { callerAgentId: 'director' });
  assert.ok(killed);
  assert.strictEqual(runtime.hasRecycledAgent('director'), true);
  assert.strictEqual(runtime.getAgent('director'), null);

  // 5. Ensure director re-provisions cleanly
  const director3 = await runtime.ensureDirector();
  assert.ok(director3);
  assert.strictEqual(director3.id, 'director');
  assert.strictEqual(director3.state, 'idle');
  assert.strictEqual(runtime.getAgent('director'), director3);

  // 6. Cleanup runtime
  runtime.destroy();
  assert.strictEqual(runtime.status, RUNTIME_STATUS.DESTROYED);
});

test('14. Model, Provider, and InitialPrompt Dependency Injection via EnsureDirectorOptions', async () => {
  let capturedModel = null;
  let capturedProvider = null;
  let capturedPrompt = null;
  let capturedConfig = null;

  const mockModel = {
    id: 'custom-director-llm',
    provider: { id: 'custom-provider' }
  };
  const mockProvider = {
    id: 'custom-provider',
    createModel: () => mockModel
  };

  const injectionHost = {
    getAgent() { return null; },
    async launchAgent(config, model, provider, initialPrompt) {
      capturedConfig = config;
      capturedModel = model;
      capturedProvider = provider;
      capturedPrompt = initialPrompt;
      return new Agent(config, model, provider);
    }
  };

  const director = await ensureDirectorAgent(injectionHost, {
    model: mockModel,
    provider: mockProvider,
    initialPrompt: 'SYSTEM_BOOTSTRAP_DIRECTOR'
  });

  assert.strictEqual(director.id, 'director');
  assert.strictEqual(capturedModel, mockModel);
  assert.strictEqual(capturedProvider, mockProvider);
  assert.strictEqual(capturedPrompt, 'SYSTEM_BOOTSTRAP_DIRECTOR');
  assert.strictEqual(director.model, mockModel);
  assert.strictEqual(director.provider, mockProvider);
});

test('15. DIRECTOR_SPEC Immutability: Deep Freeze Verification', () => {
  assert.ok(Object.isFrozen(DIRECTOR_SPEC));
  assert.ok(Object.isFrozen(DIRECTOR_SPEC.tools));
  assert.ok(Object.isFrozen(DIRECTOR_SPEC.allowedTools));

  assert.throws(() => {
    // @ts-ignore
    DIRECTOR_SPEC.privileged = false;
  }, TypeError);

  assert.throws(() => {
    // @ts-ignore
    DIRECTOR_SPEC.id = 'not_director';
  }, TypeError);

  assert.throws(() => {
    // @ts-ignore
    DIRECTOR_SPEC.tools.push('new_tool');
  }, TypeError);

  assert.throws(() => {
    // @ts-ignore
    DIRECTOR_SPEC.allowedTools[0] = 'restricted';
  }, TypeError);
});

test('16. Auto-Bootstrapped Runtime Lifecycle Verification', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: true });
  assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);

  // Give the async auto-bootstrap promise a brief turn tick
  await new Promise((r) => setTimeout(r, 20));

  const director = runtime.getAgent('director');
  assert.ok(director);
  assert.strictEqual(director.id, 'director');
  assert.strictEqual(director.config.privileged, true);
  assert.deepStrictEqual(director.config.tools, ['*']);
  assert.strictEqual(isDirector(director), true);

  runtime.destroy();
});

test('17. Simultaneous Multi-Property Prototype Pollution Defense', async () => {
  const originalDescriptors = {
    id: Object.getOwnPropertyDescriptor(Object.prototype, 'id'),
    role: Object.getOwnPropertyDescriptor(Object.prototype, 'role'),
    privileged: Object.getOwnPropertyDescriptor(Object.prototype, 'privileged'),
    workspaceId: Object.getOwnPropertyDescriptor(Object.prototype, 'workspaceId'),
    tools: Object.getOwnPropertyDescriptor(Object.prototype, 'tools'),
    allowedTools: Object.getOwnPropertyDescriptor(Object.prototype, 'allowedTools'),
    config: Object.getOwnPropertyDescriptor(Object.prototype, 'config')
  };

  try {
    // Pollute all key properties on Object.prototype simultaneously
    Object.prototype.id = 'director';
    Object.prototype.role = 'rogue_role';
    Object.prototype.privileged = false;
    Object.prototype.workspaceId = 'rogue_ws';
    Object.prototype.tools = ['rogue_tool'];
    Object.prototype.allowedTools = ['rogue_tool'];
    Object.prototype.config = { id: 'director', privileged: false };

    // 1. isDirector on rogue object without own property 'id' must return false
    assert.strictEqual(isDirector({}), false);
    assert.strictEqual(isDirector({ someOtherProp: true }), false);

    // 2. ensureDirectorAgent on mock host must succeed and strictly retain root invariants
    let launchedSpec = null;
    const host = {
      agent: null,
      getAgent() { return this.agent; },
      async launchAgent(spec) {
        launchedSpec = spec;
        this.agent = new Agent(spec);
        return this.agent;
      }
    };

    const agent = await ensureDirectorAgent(host);
    assert.strictEqual(agent.id, 'director');
    assert.strictEqual(launchedSpec.id, 'director');
    assert.strictEqual(launchedSpec.role, 'director');
    assert.strictEqual(launchedSpec.privileged, true);
    assert.strictEqual(launchedSpec.workspaceId, 'director');
    assert.deepStrictEqual(launchedSpec.tools, ['*']);
    assert.deepStrictEqual(launchedSpec.allowedTools, ['*']);
  } finally {
    for (const [key, desc] of Object.entries(originalDescriptors)) {
      if (desc) {
        Object.defineProperty(Object.prototype, key, desc);
      } else {
        delete Object.prototype[key];
      }
    }
  }
});

