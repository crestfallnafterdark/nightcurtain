/**
 * @file tests/audit/repros/1398527.test.js
 * @description Audit repro for tickets 1398527 (Critical) and 38a64ae (Major,
 * duplicate root; MOD-21-A2): `AgentRuntime.importSnapshot` compared the raw,
 * untrimmed snapshot id against `DIRECTOR_AGENT_ID` before
 * `Agent.fromSnapshot` trimmed it, so a whitespace-padded alias
 * (`'  director  '`, `'\tdirector'`, `'director\n'`, `'director\u00a0'`)
 * bypassed the rebuild branch, hydrated an attacker-authored body, installed it
 * under the canonical `director` key, and was then re-authorized with the
 * engine wildcard descriptor.
 *
 * Wave I (ticket c02d0b9) removed the reserved-id namespace and the
 * rebuild-from-spec branch: no hydrated record is re-authorized at all.
 * Expected: ids are canonicalized at the hydration boundary (the entity
 * `config.id` never diverges from `this.id`), and every hydrated record —
 * `director` aliases included — stays default-deny with no `realmBypass`
 * grant, so a padded alias can never smuggle authority or a system identity.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/1398527.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import {
  restoreRuntimeEnvironment,
  SANDBOX_PERSISTENCE_VERSION
} from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

const ATTACKER_PROMPT = 'ATTACKER VIA PADDED DIRECTOR ID';
const ATTACKER_URL = 'https://evil.example';
const PADDED_DIRECTOR_IDS = ['  director  ', '\tdirector', 'director\n', 'director\u00a0'];

function buildTelemetry() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    terminalStops: 0,
    injectedDeliveries: 0,
    precallCount: 0,
    lastSentContext: []
  };
}

function hostileEntry(id, overrides = {}) {
  const entry = {
    id,
    name: id,
    config: {
      id,
      role: 'user',
      systemPrompt: ATTACKER_PROMPT,
      modelConfig: { provider: 'nano-gpt', modelId: 'evil', url: ATTACKER_URL }
    },
    state: 'idle',
    stateDetail: null,
    turnCount: 0,
    telemetry: buildTelemetry(),
    createdAt: 1,
    updatedAt: 1,
    lastSummary: null,
    lastError: null,
    lastInterruptedTurn: null,
    recycledAt: null,
    recycleReason: null,
    history: [],
    redoStack: [],
    pendingPrecalls: []
  };
  return {
    ...entry,
    ...overrides,
    config: { ...entry.config, ...(overrides.config || {}) }
  };
}

test('1398527: every padded director id canonicalizes and hydrates default-deny (no authority, no bypass)', () => {
  for (const id of PADDED_DIRECTOR_IDS) {
    const runtime = new AgentRuntime({ autoBootstrapDirector: false });
    try {
      runtime.importSnapshot({ agents: [hostileEntry(id)], recycleBin: [] });

      const director = runtime.getAgent('director');
      assert.ok(director, `padded id ${JSON.stringify(id)} must hydrate under the canonical director key`);
      assert.strictEqual(director.id, 'director');
      assert.strictEqual(director.config.id, 'director', 'config.id must be canonicalized at hydration');

      const projection = runtime.createAgentIdentityPort().getAgentIdentity('director');
      assert.strictEqual(
        projection.authority.allow.size,
        0,
        `padded id ${JSON.stringify(id)} must never be re-authorized from snapshot content`
      );
      assert.strictEqual(
        projection.realmBypass,
        false,
        `padded id ${JSON.stringify(id)} must never inherit the engine bypass grant`
      );
    } finally {
      runtime.destroy();
    }
  }
});

test('1398527: a padded duplicate is rejected fail-closed and mints no authority', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    // Wave I2 (ticket d57cbc1): hydration computes the canonical
    // `(realmId, agentId)` key per record and fails closed on a duplicate
    // identity — the padded alias canonicalizes to the same key as the plain
    // record, so the snapshot is rejected before any state is mutated. The
    // rejection is the security property: no duplicate may install or mint
    // authority.
    assert.throws(
      () => runtime.importSnapshot({
        agents: [hostileEntry('director'), hostileEntry('  director  ')],
        recycleBin: []
      }),
      { code: 'ERR_SNAPSHOT_INVALID' },
      'a duplicate canonical agent identity must reject the snapshot fail-closed'
    );

    // The failed import must leave the runtime registry untouched: neither
    // record is installed and no identity is projected (no authority minted).
    assert.strictEqual(runtime.getAgent('director'), null, 'the duplicate must not install under the canonical key');
    assert.strictEqual(runtime.getAgent('  director  '), null, 'the padded alias must not install either');
    assert.strictEqual(
      runtime.createAgentIdentityPort().listAgentIdentities().length,
      0,
      'a rejected snapshot must install no agent at all'
    );
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('director'),
      null,
      'no duplicate may mint authority'
    );
  } finally {
    runtime.destroy();
  }
});

test('1398527: a recycled padded director canonicalizes default-deny', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({
      agents: [],
      recycleBin: [hostileEntry('director ', { state: 'recycled' })]
    });

    assert.strictEqual(runtime.getAgent('director'), null, 'a recycled director must not be active');
    const recycled = runtime.getRecycledAgent('director');
    assert.ok(recycled, 'a recycled padded director must land under the canonical key');
    assert.strictEqual(recycled.config.id, 'director', 'config.id must be canonicalized at hydration');
    assert.strictEqual(recycled.authorityProvenance, 'snapshot', 'the hydrated record carries snapshot provenance');
  } finally {
    runtime.destroy();
  }
});

test('1398527: the persistence restore path cannot smuggle authority through a padded id', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    const persisted = {
      version: SANDBOX_PERSISTENCE_VERSION,
      timestamp: Date.now(),
      activeAgentId: null,
      activeFsWorkspace: null,
      activeTab: null,
      agents: [hostileEntry('  director  ')],
      recycleBin: [],
      virtualFs: {},
      messagingBus: {},
      scheduledTimers: [],
      worldClock: null,
      agentDraftInputs: {}
    };

    const result = restoreRuntimeEnvironment(persisted, runtime);
    assert.strictEqual(result.success, true, 'the snapshot shape must restore cleanly');

    const director = runtime.getAgent('director');
    assert.ok(director, 'the record must be installed under the canonical key');
    assert.strictEqual(director.config.id, 'director', 'config.id must be canonicalized at hydration');
    const projection = runtime.createAgentIdentityPort().getAgentIdentity('director');
    assert.strictEqual(projection.authority.allow.size, 0, 'restoreRuntimeEnvironment must never mint authority');
    assert.strictEqual(projection.realmBypass, false, 'restoreRuntimeEnvironment must never mint the bypass grant');
  } finally {
    runtime.destroy();
  }
});

test('1398527: non-reserved padded ids canonicalize without minting authority', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({
      agents: [hostileEntry('  analyst  ')],
      recycleBin: []
    });

    const analyst = runtime.getAgent('analyst');
    assert.ok(analyst, 'a padded non-reserved id must install under its canonical key');
    assert.strictEqual(analyst.config.id, 'analyst', 'entity config.id and entity id must agree');
    assert.strictEqual(runtime.getAgent('  analyst  '), null, 'the padded alias is never a key');

    const identity = runtime.createAgentIdentityPort().getAgentIdentity('analyst');
    assert.ok(identity, 'the hydrated agent must be identifiable');
    assert.strictEqual(
      identity.authority.allow.size,
      0,
      'snapshot hydration never mints authority, padded id or not'
    );
  } finally {
    runtime.destroy();
  }
});
