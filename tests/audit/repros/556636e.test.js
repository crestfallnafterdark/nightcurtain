/**
 * @file tests/audit/repros/556636e.test.js
 * @description Audit repro for ticket 556636e (Critical, area:security, MOD-21):
 * `Agent#adoptConfig` builds the live config with an assignment loop
 * (`clean[key] = next[key]`), so a caller-supplied config carrying an own
 * `__proto__` key rewrites the live config's `[[Prototype]]` instead of becoming
 * a plain data key. `Agent.fromSnapshot` deletes only own authority keys from
 * the clone, so a tampered snapshot (direct `importSnapshot` or a programmatic
 * entity construction) hydrates with the attacker payload on the config
 * prototype: wildcard capability reaches the identity projection and the legacy
 * tool gate, parentage resolves through `config.spawnedBy`/`creatorId`, and the
 * Proxy variant hides `privileged` from `hasOwnProperty`.
 *
 * Expected: prototype-pollution keys are rejected at every hydration boundary
 * and the live config is built pollution-safely on every adoption path, so no
 * config payload can become a prototype.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/556636e.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';
import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

/**
 * Canonical tampered config: an own `__proto__` data key (JSON.parse) carrying
 * capability, privilege and parentage payloads.
 * @returns {Record<string, any>}
 */
function pollutedConfig() {
  return JSON.parse(
    '{"id":"victim","name":"victim","role":"user","systemPrompt":"","__proto__":{"allowedTools":["*"],"tools":["*"],"privileged":true,"spawnedBy":"mallory","creatorId":"mallory"}}'
  );
}

test('556636e: the entity constructor must not adopt a config __proto__ payload', () => {
  const agent = new Agent(pollutedConfig());

  assert.strictEqual(
    Object.getPrototypeOf(agent.config),
    Object.prototype,
    'an own __proto__ config key must never become the live config prototype'
  );
  assert.strictEqual(agent.config.privileged ?? false, false, 'the constructor must not mint privilege');
  assert.strictEqual(agent.config.spawnedBy ?? null, null, 'the constructor must not adopt parentage');
  assert.strictEqual(agent.config.creatorId ?? null, null, 'the constructor must not adopt parentage');
  assert.strictEqual(agent.authority.allow.has('*'), false, 'the authority descriptor must stay default-deny');
});

test('556636e: whole-object config replacement must not adopt a __proto__ payload', () => {
  const agent = new Agent({ id: 'setter' });
  agent.config = pollutedConfig();

  assert.strictEqual(
    Object.getPrototypeOf(agent.config),
    Object.prototype,
    'the config setter must build a pollution-safe config object'
  );
  assert.strictEqual(agent.config.privileged ?? false, false, 'config replacement must not mint privilege');
  assert.strictEqual(agent.config.spawnedBy ?? null, null, 'config replacement must not adopt parentage');
});

test('556636e: fromSnapshot rejects a prototype-polluting config (fail closed)', () => {
  assert.throws(
    () => Agent.fromSnapshot({ id: 'victim', config: pollutedConfig(), history: [] }),
    (err) => err?.code === 'INVALID_CONFIG',
    'a snapshot config carrying __proto__ must be rejected'
  );
});

test('556636e: direct importSnapshot rejects a prototype-polluting config and leaves state intact', () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.launchAgent({ id: 'mallory' });

    assert.throws(
      () => runtime.importSnapshot({
        agents: [
          { id: 'mallory', config: { id: 'mallory' } },
          { id: 'victim', config: pollutedConfig(), history: [] }
        ],
        recycleBin: []
      }),
      (err) => err?.code === 'ERR_SNAPSHOT_INVALID',
      'the public importSnapshot facade must not hydrate a prototype-polluting config'
    );

    assert.strictEqual(runtime.getAgent('victim'), null, 'the polluted victim must not hydrate');
    assert.ok(runtime.getAgent('mallory'), 'the prior registry must stay intact after the rejected import');

    const identity = runtime.createAgentIdentityPort().getAgentIdentity('mallory');
    assert.strictEqual(identity.authority.allow.has('*'), false, 'the registry descriptor stays default-deny');
  } finally {
    runtime.destroy();
  }
});

test('556636e: a recycled prototype-polluting record cannot re-grant restore authority', () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.launchAgent({ id: 'mallory' });

    assert.throws(
      () => runtime.importSnapshot({
        agents: [{ id: 'mallory', config: { id: 'mallory' } }],
        recycleBin: [
          {
            id: 'victim',
            name: 'victim',
            config: pollutedConfig(),
            state: 'recycled',
            recycledAt: new Date().toISOString(),
            recycleReason: 'forged',
            history: []
          }
        ]
      }),
      (err) => err?.code === 'ERR_SNAPSHOT_INVALID',
      'the recycle-bin import must not hydrate a prototype-polluting config'
    );

    assert.strictEqual(runtime.hasRecycledAgent('victim'), false, 'the polluted record must not hydrate');
  } finally {
    runtime.destroy();
  }
});
