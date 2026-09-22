/**
 * @file tests/integration/preset_binding_runtime_test.js
 * @description MOD-20 W3-B2 runtime binding integration suite (offline).
 *
 * Verifies the binding contract of ICD v1.1.0 §6 with a real `AgentRuntime` +
 * `Agent` entity over a fake frozen `ModelPresetSourcePort`:
 *   (a) a new agent without a `presetId` binds the catalog default;
 *   (b) `preset-updated` marks bound agents dirty and the next turn start
 *       materializes the new config (provider regenerated only on change);
 *   (c) an update landing while a turn is RUNNING never swaps provider/model;
 *   (d) `preset-deleted` rewrites the binding to the default, persists it via
 *       the `agent_config_updated` path, and materializes at the next turn;
 *   (e) `reset()` unsubscribes/re-subscribes and `destroy()` unsubscribes once;
 *   (f) recycled agents are dirty-marked and rewritten too;
 *   (g) agents bound to other presets (and source-less entities) are isolated;
 *   (h) F3: a byte-identical `preset-updated` save consumes the dirty
 *       mark without regenerating provider/model, while a real config change
 *       and a credential (`keyId`) rotation still regenerate.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { Agent, AGENT_STATES } from '../../src/lib/sandbox/runtime/agent/index.ts';

// ============================================================================
// Fake MOD-20 catalog / source port
// ============================================================================

const PRESET_DEFAULT = Object.freeze({
  providerId: 'deepseek',
  modelId: 'deepseek-chat',
  temperature: 0.2
});

const PRESET_ALT = Object.freeze({
  providerId: 'nanogpt',
  modelId: 'deepseek/deepseek-v4.1-flash:thinking',
  temperature: 0.4
});

/**
 * Builds a mutable fake catalog plus its frozen `ModelPresetSourcePort`
 * projection. `emit` simulates the synchronous catalog notification and
 * `listenerCount` observes the runtime subscription lifecycle.
 *
 * @param {Record<string, object>} presets - Initial preset id -> modelConfig map
 * @param {string} defaultId - Active/default preset id
 * @returns {object} Fake catalog harness
 */
function createFakePresetSource(presets, defaultId) {
  const state = {
    presets: { ...presets },
    defaultId,
    listeners: new Set(),
    subscribeCount: 0,
    unsubscribeCount: 0
  };

  const source = Object.freeze({
    getPreset(id) {
      if (!Object.prototype.hasOwnProperty.call(state.presets, id)) return null;
      return Object.freeze({
        id,
        name: `Preset ${id}`,
        isCustom: false,
        modelConfig: Object.freeze({ ...state.presets[id] })
      });
    },
    getDefaultPresetId() {
      return state.defaultId;
    },
    subscribe(listener) {
      state.listeners.add(listener);
      state.subscribeCount += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        state.listeners.delete(listener);
        state.unsubscribeCount += 1;
      };
    }
  });

  return {
    source,
    state,
    updatePreset(id, config) {
      state.presets[id] = { ...config };
    },
    deletePreset(id) {
      delete state.presets[id];
    },
    emit(type, presetId) {
      for (const listener of [...state.listeners]) listener({ type, presetId });
    },
    listenerCount() {
      return state.listeners.size;
    }
  };
}

/**
 * Creates an offline mock model for direct per-turn injection.
 */
function createMockModel(output = 'ok') {
  return {
    id: 'mock-model',
    async *stream() {
      yield { type: 'text', content: output };
      yield { type: 'finish', finishReason: 'stop', content: output, toolCalls: null };
    },
    async complete() {
      return { content: output, toolCalls: [] };
    }
  };
}

function createRuntime(fake, options = {}) {
  return new AgentRuntime({ presetSource: fake.source, autoBootstrapDirector: false, ...options });
}

// ============================================================================
// (a) Default binding at creation
// ============================================================================

test('a. A new agent without presetId binds the catalog default at creation', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    const agent = await runtime.launchAgent({ id: 'unbound-agent' });
    assert.equal(agent.config.presetId, 'preset_default');
    assert.equal(agent.modelConfig.providerId, 'deepseek');
    assert.equal(agent.modelConfig.modelId, 'deepseek-chat');
    assert.equal(agent.modelConfig.keyId, 'canonical_deepseek');
    assert.equal(agent.provider.id, 'deepseek');
    assert.equal(agent.model.id, 'deepseek-chat');

    // An unknown requested id binds the default too (stale snapshot / deleted preset).
    const stale = await runtime.launchAgent({ id: 'stale-agent', presetId: 'preset_gone' });
    assert.equal(stale.config.presetId, 'preset_default');
    assert.equal(stale.modelConfig.providerId, 'deepseek');

    // Source-less entities keep the legacy no-op surface.
    const bare = new Agent({ id: 'bare-agent' });
    assert.equal(bare.materializeEffectiveModel(), false);
    bare.markPresetDirty();
    assert.equal(bare.materializeEffectiveModel(), false);
    assert.equal(bare.rebindToDefaultPreset(), null);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// (b) preset-updated -> dirty -> next turn materializes
// ============================================================================

test('b. preset-updated marks bound agents dirty; the next turn materializes the new config once', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    const agent = await runtime.launchAgent({ id: 'update-agent' });
    const providerBefore = agent.provider;

    // Clean, unchanged binding: idempotent no-op, no provider churn.
    assert.equal(agent.materializeEffectiveModel(), false);
    assert.equal(agent.provider, providerBefore);

    fake.updatePreset('preset_default', PRESET_ALT);
    fake.emit('preset-updated', 'preset_default');

    // The event only dirties: no mid-turn provider swap.
    assert.equal(agent.provider, providerBefore, 'preset-updated never rebuilds provider');
    assert.equal(agent.modelConfig.modelId, 'deepseek-chat');

    // Next turn start materializes through the engine hook.
    const first = await runtime.executeAgentTurn('update-agent', 'hello', { model: createMockModel('turn one') });
    assert.equal(first.output, 'turn one');
    assert.notEqual(agent.provider, providerBefore, 'provider regenerated at turn start');
    assert.equal(agent.provider.id, 'nanogpt');
    assert.equal(agent.modelConfig.providerId, 'nanogpt');
    assert.equal(agent.modelConfig.modelId, 'deepseek/deepseek-v4.1-flash:thinking');
    assert.equal(agent.model.id, 'deepseek/deepseek-v4.1-flash:thinking');

    // No further catalog change: the next turn does not regenerate the provider.
    const providerAfterFirstTurn = agent.provider;
    const modelAfterFirstTurn = agent.model;
    const second = await runtime.executeAgentTurn('update-agent', 'again', { model: createMockModel('turn two') });
    assert.equal(second.output, 'turn two');
    assert.equal(agent.provider, providerAfterFirstTurn, 'unchanged binding is not regenerated');
    assert.equal(agent.model, modelAfterFirstTurn);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// (c) No mid-turn swap while RUNNING
// ============================================================================

test('c. A preset update landing while a turn is RUNNING never swaps provider/model', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    const agent = await runtime.launchAgent({ id: 'mid-turn-agent' });
    const providerBefore = agent.provider;
    const modelBefore = agent.model;

    let releaseStream;
    const streamGate = new Promise((resolve) => { releaseStream = resolve; });
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });

    const gatedModel = {
      async *stream() {
        yield { type: 'text', content: 'partial' };
        signalStarted();
        await streamGate;
        yield { type: 'finish', finishReason: 'stop', content: 'partial complete' };
      }
    };

    const turnPromise = runtime.executeAgentTurn('mid-turn-agent', 'work', { model: gatedModel });
    await started;
    assert.equal(agent.state, AGENT_STATES.RUNNING, 'turn is in flight');

    fake.updatePreset('preset_default', PRESET_ALT);
    fake.emit('preset-updated', 'preset_default');

    assert.equal(agent.provider, providerBefore, 'no provider swap mid-turn');
    assert.equal(agent.model, modelBefore, 'no model swap mid-turn');
    assert.equal(agent.modelConfig.modelId, 'deepseek-chat');

    releaseStream();
    await turnPromise;

    // The running turn completed on the old binding; the new config waits for
    // the next turn start.
    assert.equal(agent.model, modelBefore);
    assert.equal(agent.materializeEffectiveModel(), true);
    assert.equal(agent.provider.id, 'nanogpt');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// (d) preset-deleted -> default rewrite + persistence + next-turn materialization
// ============================================================================

test('d. preset-deleted rewrites the binding to the default, persists it, and materializes next turn', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    const agent = await runtime.launchAgent({ id: 'delete-agent', presetId: 'preset_alt' });
    assert.equal(agent.config.presetId, 'preset_alt');
    assert.equal(agent.provider.id, 'nanogpt');
    const providerBefore = agent.provider;

    const events = [];
    runtime.subscribe((event) => events.push(event));

    fake.deletePreset('preset_alt');
    fake.emit('preset-deleted', 'preset_alt');

    // Binding rewritten in memory; provider untouched mid-turn.
    assert.equal(agent.config.presetId, 'preset_default');
    assert.equal(agent.provider, providerBefore, 'preset-deleted never rebuilds provider');
    assert.equal(agent.modelConfig.modelId, 'deepseek/deepseek-v4.1-flash:thinking');

    // Persisted through the config-update event consumed by store autosave.
    const persisted = events.find(e => e.type === 'agent_config_updated' && e.agentId === 'delete-agent');
    assert.ok(persisted, 'agent_config_updated emitted for the rewrite');
    assert.equal(persisted.payload.updatedConfig.presetId, 'preset_default');
    assert.equal(persisted.payload.config.presetId, 'preset_default');
    assert.equal(agent.toSnapshot().config.presetId, 'preset_default', 'snapshot persists the rewrite');

    // Next turn start materializes the default preset.
    const receipt = await runtime.executeAgentTurn('delete-agent', 'continue', { model: createMockModel('after delete') });
    assert.equal(receipt.output, 'after delete');
    assert.equal(agent.provider.id, 'deepseek');
    assert.equal(agent.modelConfig.modelId, 'deepseek-chat');

    // A second deletion event for the same (already rewound) id is a no-op.
    const providerAfter = agent.provider;
    fake.emit('preset-deleted', 'preset_alt');
    assert.equal(agent.provider, providerAfter);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// (e) Subscription teardown on reset/destroy
// ============================================================================

test('e. reset() unsubscribes and re-subscribes; destroy() unsubscribes exactly once', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    assert.equal(fake.listenerCount(), 1, 'constructor subscribes once');
    assert.equal(fake.state.subscribeCount, 1);
    assert.equal(fake.state.unsubscribeCount, 0);

    runtime.reset();

    assert.equal(fake.state.unsubscribeCount, 1, 'reset unsubscribes the constructor listener');
    assert.equal(fake.listenerCount(), 1, 'reset re-subscribes');
    assert.equal(fake.state.subscribeCount, 2);

    // The re-bound listener still drives the runtime after a reset.
    const agent = await runtime.launchAgent({ id: 'post-reset-agent' });
    fake.updatePreset('preset_default', PRESET_ALT);
    fake.emit('preset-updated', 'preset_default');
    assert.equal(agent.materializeEffectiveModel(), true, 'post-reset subscription is live');
    assert.equal(agent.provider.id, 'nanogpt');
  } finally {
    runtime.destroy();
  }

  assert.equal(fake.listenerCount(), 0, 'destroy unsubscribes');
  assert.equal(fake.state.unsubscribeCount, 2);

  runtime.destroy();
  assert.equal(fake.state.unsubscribeCount, 2, 'destroy is idempotent (no double unsubscribe)');
});

// ============================================================================
// (f) Recycled agents
// ============================================================================

test('f. recycled agents are dirty-marked on update and rewritten on delete', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    // preset-updated reaches a recycled agent.
    const updateAgent = await runtime.launchAgent({ id: 'recycled-update', presetId: 'preset_alt' });
    assert.ok(runtime.killAgent('recycled-update', 'test recycle', { callerAgentId: 'recycled-update' }));
    assert.equal(runtime.getAgent('recycled-update'), null);
    assert.ok(runtime.getRecycledAgent('recycled-update'));

    fake.updatePreset('preset_alt', { providerId: 'runware', modelId: 'deepseek-v4-flash' });
    fake.emit('preset-updated', 'preset_alt');

    assert.equal(updateAgent.provider.id, 'nanogpt', 'no mid-turn rebuild for recycled agent');
    assert.equal(updateAgent.materializeEffectiveModel(), true, 'recycled agent was dirty-marked');
    assert.equal(updateAgent.provider.id, 'runware');

    // preset-deleted reaches a recycled agent and persists via the direct path
    // (the lifecycle update path only resolves active-registry agents).
    const deletedAgent = await runtime.launchAgent({ id: 'recycled-delete', presetId: 'preset_alt' });
    assert.ok(runtime.killAgent('recycled-delete', 'test recycle', { callerAgentId: 'recycled-delete' }));

    const events = [];
    runtime.subscribe((event) => events.push(event));
    fake.deletePreset('preset_alt');
    fake.emit('preset-deleted', 'preset_alt');

    assert.equal(deletedAgent.config.presetId, 'preset_default');
    const persisted = events.find(e => e.type === 'agent_config_updated' && e.agentId === 'recycled-delete');
    assert.ok(persisted, 'recycled rewrite persisted via the direct emission path');
    assert.equal(persisted.payload.updatedConfig.presetId, 'preset_default');
    assert.equal(deletedAgent.materializeEffectiveModel(), true);
    assert.equal(deletedAgent.provider.id, 'deepseek');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// (g) Foreign-catalog / non-matching agent isolation
// ============================================================================

test('g. catalog events only touch agents bound to the mutated preset', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );
  const runtime = createRuntime(fake);
  try {
    const defaultAgent = await runtime.launchAgent({ id: 'default-bound' });
    const altAgent = await runtime.launchAgent({ id: 'alt-bound', presetId: 'preset_alt' });
    const defaultProvider = defaultAgent.provider;

    fake.updatePreset('preset_alt', { providerId: 'runware', modelId: 'deepseek-v4-flash' });
    fake.emit('preset-updated', 'preset_alt');

    assert.equal(defaultAgent.provider, defaultProvider, 'non-matching agent is untouched');
    assert.equal(defaultAgent.materializeEffectiveModel(), false, 'non-matching agent stays clean');
    assert.equal(altAgent.materializeEffectiveModel(), true, 'matching agent was dirty-marked');
    assert.equal(altAgent.provider.id, 'runware');

    // An event naming an id no agent binds leaves every binding alone.
    fake.emit('preset-updated', 'preset_foreign');
    assert.equal(defaultAgent.materializeEffectiveModel(), false);
    assert.equal(altAgent.materializeEffectiveModel(), false, 'dirty flag was consumed by the previous materialization');
    assert.equal(altAgent.provider.id, 'runware');

    // Deletion of the foreign id likewise touches nothing.
    fake.emit('preset-deleted', 'preset_foreign');
    assert.equal(defaultAgent.config.presetId, 'preset_default');
    assert.equal(altAgent.config.presetId, 'preset_alt');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// (h) F3: byte-identical re-resolution does not regenerate; real changes do
// ============================================================================

test('h. a no-op preset-updated save consumes dirty without regenerating; config changes and credential rotation still regenerate', async () => {
  const fake = createFakePresetSource(
    { preset_default: PRESET_DEFAULT, preset_alt: PRESET_ALT },
    'preset_default'
  );

  let activeCredentialId = 'vault_deepseek_primary';
  const credentialResolver = {
    getCredential: () => null,
    getActiveCredential: (providerId) => (
      providerId === 'deepseek' ? { id: activeCredentialId } : null
    )
  };
  const runtime = createRuntime(fake, { credentialResolver });
  try {
    const agent = await runtime.launchAgent({ id: 'noop-agent' });
    assert.equal(agent.modelConfig.keyId, 'vault_deepseek_primary');
    const providerBefore = agent.provider;
    const modelBefore = agent.model;
    const configBefore = { ...agent.modelConfig };

    // No-op save: same values under a fresh object plus a preset-updated event.
    fake.updatePreset('preset_default', { ...PRESET_DEFAULT });
    fake.emit('preset-updated', 'preset_default');

    assert.equal(agent.materializeEffectiveModel(), false, 'byte-identical re-resolution does not regenerate');
    assert.equal(agent.provider, providerBefore, 'provider identity unchanged');
    assert.equal(agent.model, modelBefore, 'model identity unchanged');
    assert.deepStrictEqual({ ...agent.modelConfig }, configBefore, 'cached config untouched');
    assert.equal(agent.config.presetId, 'preset_default');
    assert.equal(
      agent.materializeEffectiveModel(),
      false,
      'the dirty mark was consumed by the no-op re-resolution'
    );

    // A vault rotation changes `keyId`; the key-wise compare regenerates even
    // without a catalog event or dirty mark.
    activeCredentialId = 'vault_deepseek_rotated';
    assert.equal(agent.materializeEffectiveModel(), true, 'credential rotation regenerates');
    assert.notEqual(agent.provider, providerBefore, 'provider regenerated for the rotated keyId');
    assert.equal(agent.modelConfig.keyId, 'vault_deepseek_rotated');

    // Deleted-preset rebind still regenerates (binding/config changed): a
    // preset_alt-bound agent is rewound to the deepseek default.
    const altAgent = await runtime.launchAgent({ id: 'noop-delete-agent', presetId: 'preset_alt' });
    const altProviderBefore = altAgent.provider;
    fake.deletePreset('preset_alt');
    fake.emit('preset-deleted', 'preset_alt');
    assert.equal(altAgent.config.presetId, 'preset_default', 'binding rewound to the catalog default');
    assert.equal(altAgent.materializeEffectiveModel(), true, 'delete rebind regenerates');
    assert.notEqual(altAgent.provider, altProviderBefore);
    assert.equal(altAgent.provider.id, 'deepseek');
    assert.equal(altAgent.modelConfig.keyId, 'vault_deepseek_rotated');

    // A real config change after the consumed mark still regenerates.
    const providerAfterRotation = agent.provider;
    fake.updatePreset('preset_default', PRESET_ALT);
    fake.emit('preset-updated', 'preset_default');
    assert.equal(agent.materializeEffectiveModel(), true, 'real config change regenerates');
    assert.notEqual(agent.provider, providerAfterRotation);
    assert.equal(agent.provider.id, 'nanogpt');
    assert.equal(agent.modelConfig.providerId, 'nanogpt');
    assert.equal(agent.modelConfig.keyId, 'canonical_nanogpt');
  } finally {
    runtime.destroy();
  }
});
