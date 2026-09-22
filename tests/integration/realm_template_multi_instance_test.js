/**
 * @file tests/integration/realm_template_multi_instance_test.js
 * @description Wave I lane I2-T (ticket d57cbc1) acceptance: one baked template
 *   instantiates many times. The `example_agent` bundle launches twice
 *   into two independently created Realms with distinct launch input values,
 *   through the real `SandboxStore` + `AgentRuntime` composition root (real
 *   MessagingBus, VirtualFS, identity registries).
 *
 *   Asserted contract:
 *   1. both template launches succeed and each Realm carries its own
 *      `assistant` registration (the same bare id in two Realms);
 *   2. both rosters and both private workspaces exist side by side with
 *      distinct canonical partitions and no bare-id partition;
 *   3. each composed system prompt reflects its own launch inputs (briefing,
 *      directives, `defaultFile` prefill) and never the other instance's;
 *   4. cross-instance sends, files, and invocations stay denied, while
 *      same-instance operations resolve realm-locally;
 *   5. killing one instance's member leaves the other instance intact and its
 *      workspace bytes unreadable/unaffected;
 *   6. template-instance receipts and denials stay realm-opaque;
 *   7. Wave T lane T-E extension (ticket df3aac7): an imported package+seed
 *      template instantiates twice in one store — the `adcc133` realm-scoped
 *      seed resolution permits it — and each realm's generated/fixed seed files
 *      stay isolated in its own realm-global and member-private partitions.
 *
 * Zero-Mock Verification: every engine/substrate class is the real production
 * class; the deterministic in-memory model attached after launch is the repo's
 * standard stub, so no request leaves the process.
 *
 * Standalone: `timeout 240 node tests/integration/realm_template_multi_instance_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { materializeTemplate, templateBundleVersion } from '../../src/lib/sandbox/realmCatalog/index.ts';

/** Baked template id under test. */
const TEMPLATE_ID = 'example_agent';

/** Realm vocabulary that must never appear on an agent-visible surface. */
const CANONICAL_KEY_SHAPE = /(?:^|["'\s{[(,=])realm:[^"'\s{}\[\],]+:[^"'\s{}\[\],]+/;

/** Launch input values for instance one. */
const INPUT_ONE = Object.freeze({
  briefing: 'Instance one briefing text.',
  directives: 'Instance one directive text.'
});

/** Launch input values for instance two. */
const INPUT_TWO = Object.freeze({
  briefing: 'Instance two briefing text.',
  directives: 'Instance two directive text.'
});

/**
 * Asserts an agent-visible surface is free of canonical-key vocabulary.
 *
 * @param {unknown} value - Receipt/listing/error under test.
 * @param {string} label - Assertion label naming the surface.
 */
function assertKeyOpaque(value, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(serialized.includes('realm:'), false, `${label} must not carry a canonical key: ${serialized}`);
  assert.equal(CANONICAL_KEY_SHAPE.test(serialized), false, `${label} must not match the canonical key shape: ${serialized}`);
}

/**
 * Deterministic in-memory model (repo convention): real classes only, no
 * network. Attached to the launched members and observer principals.
 *
 * @param {string} output - Final assistant text for every turn.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `i2t-template-model-${output.replace(/\s+/g, '-')}`,
    config: {},
    provider: {
      id: 'i2t-template-provider',
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: 'i2t-template-model', name: 'I2T Template Model' }]
    },
    async *stream(options = {}) {
      if (typeof options.onChunk === 'function') options.onChunk(output);
      yield { type: 'text', content: output };
      yield { type: 'finish', finishReason: 'stop', content: output, reasoning: '', toolCalls: [] };
    },
    async complete() {
      return { role: 'assistant', content: output };
    }
  };
}

/**
 * Runs the acceptance fixture: one store/runtime, two template launches with
 * distinct inputs, then one realm-unique privileged observer per instance so
 * cross-instance invocation denials are decided by the Realm gate (a
 * zero-grant template member could not invoke at all).
 *
 * @returns {Promise<object>} Live fixture with both instances resolved.
 */
async function createTemplateFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  await store.ensureDirector();

  const bundle = store.getRealmTemplateBundle(TEMPLATE_ID);
  assert.ok(bundle, 'the baked example_agent bundle resolves through the store seam');

  const first = await store.launchRealmFromTemplate(TEMPLATE_ID, {
    name: 'Story Instance One',
    inputValues: INPUT_ONE
  });
  const second = await store.launchRealmFromTemplate(TEMPLATE_ID, {
    name: 'Story Instance Two',
    inputValues: INPUT_TWO
  });

  const realmOne = first.realm.id;
  const realmTwo = second.realm.id;
  assert.notEqual(realmOne, realmTwo, 'each template launch creates its own Realm');

  const port = runtime.createAgentIdentityPort();
  const oneIdentity = port.getAgentIdentity('assistant', { realmId: realmOne });
  const twoIdentity = port.getAgentIdentity('assistant', { realmId: realmTwo });
  assert.ok(oneIdentity && twoIdentity, 'both instances resolve realm-exactly');

  // Keep every potential wake offline; the template ships no model.
  runtime.getAgent(oneIdentity.key).model = createDeterministicModel('instance one turn output');
  runtime.getAgent(twoIdentity.key).model = createDeterministicModel('instance two turn output');

  // Realm-unique privileged observers give the cross-instance invocation
  // denials a wildcard invoker, so the denial comes from the Realm gate.
  await store.launchAgent(
    { id: 'one_root', realmId: realmOne, privileged: true, allowedTools: ['*'] },
    createDeterministicModel('instance one root output')
  );
  await store.launchAgent(
    { id: 'two_root', realmId: realmTwo, privileged: true, allowedTools: ['*'] },
    createDeterministicModel('instance two root output')
  );
  const oneRoot = port.getAgentIdentity('one_root', { realmId: realmOne });
  const twoRoot = port.getAgentIdentity('two_root', { realmId: realmTwo });
  assert.ok(oneRoot && twoRoot, 'fixture: both observers resolve');

  return {
    runtime,
    store,
    bundle,
    port,
    operator: runtime.getOperatorPrincipal(),
    realmOne,
    realmTwo,
    one: { realm: first.realm, receipt: first, identity: oneIdentity },
    two: { realm: second.realm, receipt: second, identity: twoIdentity },
    oneRoot,
    twoRoot
  };
}

/**
 * Tears down one fixture.
 *
 * @param {object} fixture - Fixture from {@link createTemplateFixture}.
 */
function destroyTemplateFixture(fixture) {
  fixture.store.destroy();
  fixture.runtime.destroy();
}

/**
 * Reads one instance's launched member snapshot from the store projection.
 *
 * @param {object} fixture - Live template fixture.
 * @param {string} realmId - Instance Realm id.
 * @returns {object} The assistant snapshot bound to that Realm.
 */
function instanceSnapshot(fixture, realmId) {
  const snapshot = fixture.store.agents.find(
    (agent) => agent.id === 'assistant' && agent.config.realmId === realmId
  );
  assert.ok(snapshot, `instance '${realmId}' must expose its assistant snapshot`);
  return snapshot;
}

/**
 * Trusted caller context for one member identity.
 *
 * @param {object} identity - Realm-exact identity projection.
 * @returns {{callerAgentId: string, callerKey: string}} Context object.
 */
function callContext(identity) {
  return { callerAgentId: identity.id, callerKey: identity.key };
}

// ============================================================================
// 1. Both launches succeed; rosters exist side by side
// ============================================================================

test('1. the baked template instantiates twice into two realms', async () => {
  const fixture = await createTemplateFixture();
  try {
    for (const [label, instance] of [['one', fixture.one], ['two', fixture.two]]) {
      assert.equal(instance.receipt.realm.templateId, TEMPLATE_ID, `${label}: the realm records its template id`);
      assert.deepEqual(instance.receipt.agents.map((agent) => agent.id), ['assistant'], `${label}: one member in template order`);
      assert.equal(instance.receipt.agents[0].config.realmId, instance.realm.id, `${label}: the member carries its realm membership`);
      assert.equal(instance.receipt.realm.name, label === 'one' ? 'Story Instance One' : 'Story Instance Two');
    }
    assert.notEqual(fixture.one.identity.key, fixture.two.identity.key, 'the same bare id owns two canonical registrations');

    // Roster isolation: each realm lists exactly its own member plus observer.
    assert.deepEqual(
      fixture.runtime.listAgents({ realmId: fixture.realmOne }).map((agent) => agent.id).sort(),
      ['assistant', 'one_root'],
      'instance one lists its own roster'
    );
    assert.deepEqual(
      fixture.runtime.listAgents({ realmId: fixture.realmTwo }).map((agent) => agent.id).sort(),
      ['assistant', 'two_root'],
      'instance two lists its own roster'
    );
    const members = fixture.store.agents.filter((agent) => agent.id === 'assistant');
    assert.equal(members.length, 2, 'the store projects both same-id members side by side');
    assert.deepEqual(
      members.map((agent) => agent.config.realmId).sort(),
      [fixture.realmOne, fixture.realmTwo].sort()
    );

    console.log(
      `[realm-template] instances: ${fixture.realmOne} / ${fixture.realmTwo}; `
      + `members: assistant@${fixture.realmOne} + assistant@${fixture.realmTwo}`
    );
  } finally {
    destroyTemplateFixture(fixture);
  }
});

// ============================================================================
// 2. Each composed prompt reflects its own launch inputs
// ============================================================================

test('2. each instance composes its own prompt from its own launch inputs', async () => {
  const fixture = await createTemplateFixture();
  const { runtime, bundle, realmOne, realmTwo } = fixture;
  try {
    const expectedOne = materializeTemplate(bundle.template, {
      realmId: realmOne,
      inputValues: INPUT_ONE,
      bundleFiles: bundle.files
    });
    const expectedTwo = materializeTemplate(bundle.template, {
      realmId: realmTwo,
      inputValues: INPUT_TWO,
      bundleFiles: bundle.files
    });
    const promptOne = instanceSnapshot(fixture, realmOne).config.systemPrompt;
    const promptTwo = instanceSnapshot(fixture, realmTwo).config.systemPrompt;

    assert.equal(promptOne, expectedOne.agents[0].systemPrompt, 'instance one composes exactly like its materialization');
    assert.equal(promptTwo, expectedTwo.agents[0].systemPrompt, 'instance two composes exactly like its materialization');
    assert.notEqual(promptOne, promptTwo, 'distinct inputs produce distinct prompts');
    assert.ok(promptOne.startsWith(bundle.files['prompts/protocol.md']), 'the embedded protocol opens instance one');
    assert.ok(promptTwo.startsWith(bundle.files['prompts/protocol.md']), 'the embedded protocol opens instance two');

    assert.ok(promptOne.includes('Instance one briefing text.'), 'instance one keeps its briefing');
    assert.ok(promptOne.includes('Instance one directive text.'), 'instance one keeps its directives');
    assert.equal(promptOne.includes('Instance Two briefing'), false, 'instance one never sees instance two briefing');
    assert.equal(promptOne.includes('Instance Two directives'), false, 'instance one never sees instance two directives');
    assert.ok(promptTwo.includes('Instance two briefing text.'), 'instance two keeps its briefing');
    assert.ok(promptTwo.includes('Instance two directive text.'), 'instance two keeps its directives');
    assert.equal(promptTwo.includes('Instance One briefing'), false, 'instance two never sees instance one briefing');
    assert.equal(promptTwo.includes('Instance One directives'), false, 'instance two never sees instance one directives');

    // Both resolve the same `defaultFile` prefill from the embedded bundle.
    assert.ok(promptOne.includes(bundle.files['inputs/house_style.md']), 'the shared defaultFile prefill resolves for instance one');
    assert.ok(promptTwo.includes(bundle.files['inputs/house_style.md']), 'the shared defaultFile prefill resolves for instance two');

    // The composed prompt is launch-time system state; a same-id agent in the
    // other realm can never contribute to it (no cross-realm prompt bleed).
    assert.equal(runtime.getAgent(fixture.one.identity.key).config.systemPrompt, promptOne);
    assert.equal(runtime.getAgent(fixture.two.identity.key).config.systemPrompt, promptTwo);
  } finally {
    destroyTemplateFixture(fixture);
  }
});

// ============================================================================
// 3. Private workspaces exist side by side, never sharing a partition
// ============================================================================

test('3. both instances own distinct canonical private workspaces', async () => {
  const fixture = await createTemplateFixture();
  const { runtime, operator } = fixture;
  const { virtualFs: vfs } = runtime;
  try {
    const oneWrite = vfs.writeFile(
      { filePath: '/session.md', content: 'instance one private session' },
      callContext(fixture.one.identity)
    );
    const twoWrite = vfs.writeFile(
      { filePath: '/session.md', content: 'instance two private session' },
      callContext(fixture.two.identity)
    );
    assert.equal(oneWrite.success, true, `instance one private write failed: ${oneWrite.code}`);
    assert.equal(twoWrite.success, true, `instance two private write failed: ${twoWrite.code}`);
    assert.equal(oneWrite.workspaceId, 'assistant', 'the write receipt projects the bare id label');
    assert.equal(twoWrite.workspaceId, 'assistant');
    assertKeyOpaque(oneWrite, 'the instance one private write receipt');

    assert.equal(
      vfs.readFile({ filePath: '/session.md' }, { ...callContext(fixture.one.identity), raw: true }),
      'instance one private session',
      'instance one reads its own bytes'
    );
    assert.equal(
      vfs.readFile({ filePath: '/session.md' }, { ...callContext(fixture.two.identity), raw: true }),
      'instance two private session',
      'instance two reads its own bytes'
    );

    const snapshot = vfs.exportSnapshot({ principal: operator });
    assert.equal(snapshot[fixture.one.identity.key]['/session.md'].content, 'instance one private session');
    assert.equal(snapshot[fixture.two.identity.key]['/session.md'].content, 'instance two private session');
    assert.equal(snapshot.assistant, undefined, 'no bare-id partition is created for the same-id pair');

    // Cross-instance file access denies on the explicit foreign workspace key.
    let foreign = null;
    try {
      vfs.readFile({ filePath: '/session.md' }, { ...callContext(fixture.one.identity), workspaceId: fixture.two.identity.key });
    } catch (err) {
      foreign = err;
    }
    assert.ok(foreign, 'instance one cannot read instance two private workspace');
    assert.equal(foreign.code, 'PERMISSION_DENIED');
    assert.equal(String(foreign.message).includes('instance two private session'), false, 'foreign bytes are never disclosed');
    assertKeyOpaque(String(foreign.message), 'the cross-instance file denial');

    // A realm-global write stays inside its own instance partition.
    const globalWrite = vfs.writeFile(
      { filePath: '/shared.md', content: 'instance one realm-global note' },
      { ...callContext(fixture.one.identity), workspaceId: 'global' }
    );
    assert.equal(globalWrite.success, true, `realm-global write failed: ${globalWrite.code}`);
    assert.equal(
      vfs.readFile({ filePath: '/shared.md' }, { ...callContext(fixture.one.identity), workspaceId: 'global', raw: true }),
      'instance one realm-global note'
    );
    assert.equal(
      vfs.exists({ filePath: '/shared.md' }, { ...callContext(fixture.two.identity), workspaceId: 'global' }),
      false,
      "instance two's global workspace never exposes instance one's note"
    );
  } finally {
    destroyTemplateFixture(fixture);
  }
});

// ============================================================================
// 4. Cross-instance sends and invocations deny; same-instance resolves locally
// ============================================================================

test('4. cross-instance sends and invocations deny; same-instance stays local', async () => {
  const fixture = await createTemplateFixture();
  const { runtime, one, two, oneRoot } = fixture;
  const { messagingBus: bus } = runtime;
  try {
    // Cross-instance direct send: the foreign canonical key is never a target.
    const crossSend = bus.sendMessage(
      { from: 'assistant', to: two.identity.key, content: 'cross-instance probe' },
      callContext(one.identity)
    );
    assert.equal(crossSend.success, false, 'a cross-instance send denies');
    assert.equal(crossSend.code, 'PERMISSION_DENIED');
    assert.equal(crossSend.id, undefined, 'a denied envelope mints no id');
    assert.equal(bus.getUnreadCount(two.identity.key), 0, 'the foreign instance mailbox stays empty');
    assertKeyOpaque(crossSend, 'the cross-instance send denial');

    // A bare same-id ref resolves the sender's own instance (self-send).
    const selfSend = bus.sendMessage(
      { from: 'assistant', to: 'assistant', content: 'same-instance note' },
      callContext(one.identity)
    );
    assert.equal(selfSend.success, true, `same-instance send failed: ${selfSend.code}`);
    assert.equal(bus.getUnreadCount(one.identity.key), 1, 'the same-instance mailbox receives the note');
    assert.equal(bus.getUnreadCount(two.identity.key), 0, 'the other instance mailbox stays untouched');
    assertKeyOpaque(selfSend, 'the same-instance send receipt');

    // Broadcast fan-out stays inside the sending instance.
    const broadcast = bus.sendMessage(
      { from: 'assistant', to: 'all', content: 'instance one standup' },
      callContext(one.identity)
    );
    assert.equal(broadcast.success, true, `instance broadcast failed: ${broadcast.code}`);
    assert.ok(broadcast.recipients.includes('one_root'), 'the same-instance observer receives the broadcast');
    assert.equal(broadcast.recipients.includes('two_root'), false, 'the foreign instance observer is never a recipient');
    assert.equal(broadcast.recipients.includes('assistant'), false, 'the sender is excluded from its own fan-out');
    assert.equal(bus.getUnreadCount(two.identity.key), 0);
    assertKeyOpaque(broadcast, 'the instance broadcast receipt');

    // Cross-instance invocation from a wildcard observer denies at the Realm gate.
    const crossInvoke = runtime.invokeAgent(oneRoot.key, two.identity.key, 'cross-instance task');
    assert.equal(crossInvoke.success, false, 'a cross-instance invocation denies');
    assert.equal(crossInvoke.code, 'PERMISSION_DENIED');
    assertKeyOpaque(crossInvoke, 'the cross-instance invocation denial');

    // Same-instance invocation resolves the bare id to its own registration.
    const localInvoke = runtime.invokeAgent(oneRoot.key, one.identity.key, 'same-instance task');
    assert.equal(localInvoke.success, true, `same-instance invoke failed: ${localInvoke.code}`);
    const wait = await runtime.waitForInvocation({ invocationIds: [localInvoke.invocationId], timeout_ms: 3000 });
    assert.equal(wait.success, true, 'the same-instance invocation settles');
    assert.equal(wait.results[0].output, 'instance one turn output', "the invoker receives its own instance's output");
    assertKeyOpaque(wait, 'the same-instance invocation result');
    assert.equal(bus.getUnreadCount(two.identity.key), 0, 'no invocation mail crosses the instance boundary');

    // The template member itself cannot invoke (zero grants), and the denial
    // never names the foreign instance.
    const memberInvoke = runtime.invokeAgent(one.identity.key, two.identity.key, 'unauthorized cross');
    assert.equal(memberInvoke.success, false, 'a zero-grant template member cannot invoke');
    assert.equal(memberInvoke.code, 'PERMISSION_DENIED');
    assertKeyOpaque(memberInvoke, 'the zero-grant invocation denial');

    // The observer dispatch seam denies cross-instance invocation at the Realm
    // gate without disclosing the foreign registration.
    const dispatcherOne = createSandboxToolDispatcher({
      runtime,
      agentId: 'one_root',
      realmId: fixture.realmOne,
      virtualFs: runtime.virtualFs,
      messagingBus: bus
    });
    const toolCross = await dispatcherOne.executeTool('invoke_agent', { agent_id: 'two_root', prompt: 'tool cross' });
    assert.equal(toolCross.success, false, 'a cross-instance tool invocation denies');
    assert.equal(toolCross.code, 'PERMISSION_DENIED');
    assertKeyOpaque(toolCross, 'the cross-instance tool invocation denial');
    assert.ok(runtime.getAgent(fixture.twoRoot.key), 'the foreign observer is untouched by the denied invoke');
  } finally {
    destroyTemplateFixture(fixture);
  }
});

// ============================================================================
// 5. Killing one instance leaves the other intact
// ============================================================================

test('5. killing one instance member leaves the other instance intact', async () => {
  const fixture = await createTemplateFixture();
  const { runtime, operator, one, two } = fixture;
  const { virtualFs: vfs } = runtime;
  try {
    vfs.writeFile({ filePath: '/session.md', content: 'instance two survives' }, callContext(two.identity));

    runtime.killAgent(one.identity.key, 'instance one teardown', { principal: operator });
    assert.equal(runtime.hasRecycledAgent(one.identity.key), true, 'instance one member is recycled');
    assert.equal(runtime.hasRecycledAgent(two.identity.key), false, 'instance two member stays active');
    assert.ok(runtime.getAgent(two.identity.key), 'the foreign same-id registration is untouched');

    // Instance two keeps its prompt, workspace bytes, and roster.
    const surviving = instanceSnapshot(fixture, fixture.realmTwo);
    assert.ok(surviving.config.systemPrompt.includes('Instance two briefing text.'));
    assert.equal(
      vfs.readFile({ filePath: '/session.md' }, { ...callContext(two.identity), raw: true }),
      'instance two survives',
      'instance two workspace bytes survive the foreign teardown'
    );
    assert.deepEqual(
      runtime.listAgents({ realmId: fixture.realmTwo }).map((agent) => agent.id).sort(),
      ['assistant', 'two_root'],
      'instance two roster is unchanged'
    );

    // Restore and confirm the same instance one registration comes back.
    const restored = runtime.restoreAgent(one.identity.key, { principal: operator });
    assert.equal(restored.id, 'assistant', 'instance one restores realm-exactly');
    assert.ok(runtime.getAgent(one.identity.key), 'instance one is active again');
    assert.ok(runtime.getAgent(two.identity.key), 'instance two stays active');
  } finally {
    destroyTemplateFixture(fixture);
  }
});

// ============================================================================
// 6. Template-instance opacity sweep
// ============================================================================

test('6. template-instance receipts and denials stay realm-opaque', async () => {
  const fixture = await createTemplateFixture();
  const { runtime, store, one, two, oneRoot } = fixture;
  const { messagingBus: bus, virtualFs: vfs } = runtime;
  const surfaces = [];
  try {
    surfaces.push(['launch receipt one', one.receipt]);
    surfaces.push(['launch receipt two', two.receipt]);
    surfaces.push([
      'cross-instance send denial',
      bus.sendMessage({ from: 'assistant', to: two.identity.key, content: 'x' }, callContext(one.identity))
    ]);
    surfaces.push([
      'same-instance inline',
      await bus.inlineFileInMessage(
        { filePath: '/note.md', recipient: 'one_root', from: 'assistant' },
        { ...callContext(one.identity), virtualFs: vfs }
      )
    ]);
    surfaces.push(['private write', vfs.writeFile({ filePath: '/note.md', content: 'opaque note' }, callContext(one.identity))]);
    surfaces.push(['cross-instance invocation denial', runtime.invokeAgent(oneRoot.key, two.identity.key, 'x')]);
    const opacityDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'one_root',
      realmId: fixture.realmOne,
      virtualFs: runtime.virtualFs,
      messagingBus: bus
    });
    surfaces.push([
      'cross-instance kill denial',
      await opacityDispatcher.executeTool('kill_agent', { agent_id: 'two_root' })
    ]);
    surfaces.push(['store ambiguous send', store.sendMessage('human', 'assistant', 'x')]);

    for (const [label, value] of surfaces) {
      assert.ok(value !== null && value !== undefined, `${label}: surface must exist`);
      assertKeyOpaque(value, label);
    }
  } finally {
    destroyTemplateFixture(fixture);
  }
});

// ============================================================================
// 7. Wave T (T-E df3aac7): package + seed variants across two realms of one
//    store, with cross-instance seeded-file isolation
// ============================================================================

/** Imported package+seed fixture template id. */
const PACKAGE_SEED_TEMPLATE_ID = 'i2t-package-seed';

/** Bundle files the package-seed fixture's prompt part resolves against. */
const PACKAGE_SEED_FILES = Object.freeze({
  'prompts/writer.md': 'Package seed writer protocol.'
});

/** Fixture: one generated input plus generated/fixed seed slots per target. */
const PACKAGE_SEED_TEMPLATE = Object.freeze({
  formatVersion: 1,
  id: PACKAGE_SEED_TEMPLATE_ID,
  name: 'Package Seed Fixture',
  description: 'Two package launches in one store.',
  inputs: [{ id: 'brief', label: 'Brief', origin: 'generated', brief: 'One generated brief.' }],
  agents: [{
    key: 'writer',
    idPattern: 'i2t-writer',
    name: 'Writer',
    role: 'writer',
    prompt: [
      { kind: 'file', path: 'prompts/writer.md' },
      { kind: 'input', inputId: 'brief' }
    ],
    toolProfile: { tools: [] },
    privileged: false
  }],
  seed: {
    files: [
      { path: 'shared/roster.md', target: 'realm', origin: 'generated', brief: 'Generated roster.' },
      { path: 'private/notes.md', target: { agent: 'writer' }, origin: 'generated', brief: 'Generated notes.' },
      { path: 'shared/rules.md', target: 'realm', origin: 'fixed', source: { inline: 'Fixed rules.' } }
    ]
  }
});

/** The fixture as a canonical transport payload. */
const PACKAGE_SEED_TRANSPORT = Object.freeze({
  formatVersion: 1,
  template: PACKAGE_SEED_TEMPLATE,
  files: PACKAGE_SEED_FILES
});

/** Effective fixture bundle version pinned by both packages. */
const PACKAGE_SEED_VERSION = templateBundleVersion({
  template: PACKAGE_SEED_TEMPLATE,
  files: PACKAGE_SEED_FILES
});

/**
 * Builds a hydration package for the package-seed fixture.
 *
 * @param {string} brief - Generated brief value for this instance.
 * @returns {object} Package object.
 */
function createPackageSeedPackage(brief) {
  return {
    formatVersion: 1,
    templateId: PACKAGE_SEED_TEMPLATE_ID,
    templateVersion: PACKAGE_SEED_VERSION,
    inputs: { brief },
    files: [
      { path: 'shared/roster.md', target: 'realm', content: `Roster: ${brief}` },
      { path: 'private/notes.md', target: { agent: 'writer' }, content: `Notes: ${brief}` }
    ]
  };
}

/**
 * Runs the Wave T extension fixture: one store/runtime pair, one imported
 * package+seed template, two launches with distinct packages.
 *
 * @returns {Promise<object>} Live fixture with both instances resolved.
 */
async function createPackageSeedFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  await store.ensureDirector();
  store.importRealmTemplate(PACKAGE_SEED_TRANSPORT);

  const first = await store.launchRealmFromTemplate(PACKAGE_SEED_TEMPLATE_ID, {
    name: 'Package Seed Realm One',
    package: createPackageSeedPackage('alpha brief')
  });
  const second = await store.launchRealmFromTemplate(PACKAGE_SEED_TEMPLATE_ID, {
    name: 'Package Seed Realm Two',
    package: createPackageSeedPackage('beta brief')
  });
  assert.notEqual(first.realm.id, second.realm.id, 'each package launch creates its own Realm');

  const port = runtime.createAgentIdentityPort();
  const oneIdentity = port.getAgentIdentity('i2t-writer', { realmId: first.realm.id });
  const twoIdentity = port.getAgentIdentity('i2t-writer', { realmId: second.realm.id });
  assert.ok(oneIdentity && twoIdentity, 'fixture: both package-seed writers resolve realm-exactly');

  // Keep any potential wake offline; the fixture declares no directive, so no
  // turn is expected at all.
  runtime.getAgent(oneIdentity.key).model = createDeterministicModel('package seed one output');
  runtime.getAgent(twoIdentity.key).model = createDeterministicModel('package seed two output');

  return { runtime, store, first, second, oneIdentity, twoIdentity };
}

test('7. a package+seed template instantiates twice with isolated generated files', async () => {
  const fixture = await createPackageSeedFixture();
  const { runtime, store, first, second, oneIdentity, twoIdentity } = fixture;
  const { virtualFs: vfs } = runtime;
  try {
    const realmOne = first.realm.id;
    const realmTwo = second.realm.id;
    const oneGlobal = `realm:${realmOne}:global`;
    const twoGlobal = `realm:${realmTwo}:global`;
    const oneMemberKey = `realm:${realmOne}:i2t-writer`;
    const twoMemberKey = `realm:${realmTwo}:i2t-writer`;

    // Both instances pin the same template version but distinct package digests.
    for (const receipt of [first, second]) {
      assert.equal(receipt.realm.templateId, PACKAGE_SEED_TEMPLATE_ID);
      assert.equal(receipt.realm.instance.templateVersion, PACKAGE_SEED_VERSION);
      assert.ok(receipt.realm.instance.packageDigest.startsWith('sha256:'));
    }
    assert.notEqual(
      first.realm.instance.packageDigest,
      second.realm.instance.packageDigest,
      'distinct packages digest distinctly'
    );

    // Each member composes its own package input into the prompt, never the
    // other instance's.
    const oneMember = store.agents.find((agent) => agent.id === 'i2t-writer' && agent.config.realmId === realmOne);
    const twoMember = store.agents.find((agent) => agent.id === 'i2t-writer' && agent.config.realmId === realmTwo);
    assert.ok(oneMember && twoMember, 'both same-id registrations are active');
    assert.equal(oneMember.config.systemPrompt, 'Package seed writer protocol.\n\nalpha brief');
    assert.equal(twoMember.config.systemPrompt, 'Package seed writer protocol.\n\nbeta brief');
    assert.equal(oneMember.config.systemPrompt.includes('beta brief'), false, 'instance one never sees instance two input');
    assert.equal(twoMember.config.systemPrompt.includes('alpha brief'), false, 'instance two never sees instance one input');

    // Realm-global seed files land per realm; the fixed file copies per realm.
    assert.equal(store.fsSnapshot[oneGlobal]['/shared/roster.md'].content, 'Roster: alpha brief');
    assert.equal(store.fsSnapshot[twoGlobal]['/shared/roster.md'].content, 'Roster: beta brief');
    assert.equal(store.fsSnapshot[oneGlobal]['/shared/rules.md'].content, 'Fixed rules.');
    assert.equal(store.fsSnapshot[twoGlobal]['/shared/rules.md'].content, 'Fixed rules.');

    // Member-private seed files land in distinct canonical partitions.
    assert.notEqual(oneMemberKey, twoMemberKey);
    assert.equal(store.fsSnapshot[oneMemberKey]['/private/notes.md'].content, 'Notes: alpha brief');
    assert.equal(store.fsSnapshot[twoMemberKey]['/private/notes.md'].content, 'Notes: beta brief');
    assert.deepEqual(
      first.realm.instance.seedPaths,
      ['/shared/roster.md', '/shared/rules.md', '/private/notes.md'],
      'instance one records its own seed paths'
    );
    assert.deepEqual(second.realm.instance.seedPaths, [...first.realm.instance.seedPaths]);

    // Through the real VFS each instance reads its own realm-global alias and
    // its own private workspace.
    assert.equal(
      vfs.readFile({ filePath: '/shared/roster.md' }, { ...callContext(oneIdentity), workspaceId: 'global', raw: true }),
      'Roster: alpha brief',
      'instance one reads its own realm-global bytes'
    );
    assert.equal(
      vfs.readFile({ filePath: '/shared/roster.md' }, { ...callContext(twoIdentity), workspaceId: 'global', raw: true }),
      'Roster: beta brief',
      'instance two reads its own realm-global bytes'
    );
    assert.equal(
      vfs.readFile({ filePath: '/private/notes.md' }, { ...callContext(oneIdentity), raw: true }),
      'Notes: alpha brief',
      'instance one reads its own private bytes'
    );
    assert.equal(
      vfs.readFile({ filePath: '/private/notes.md' }, { ...callContext(twoIdentity), raw: true }),
      'Notes: beta brief',
      'instance two reads its own private bytes'
    );

    // Foreign canonical partitions deny without disclosing bytes.
    let foreignGlobal = null;
    try {
      vfs.readFile({ filePath: '/shared/roster.md' }, { ...callContext(oneIdentity), workspaceId: twoGlobal });
    } catch (err) {
      foreignGlobal = err;
    }
    assert.ok(foreignGlobal, 'instance one cannot read instance two global workspace');
    assert.equal(foreignGlobal.code, 'PERMISSION_DENIED');
    assert.equal(String(foreignGlobal.message).includes('Roster: beta brief'), false, 'foreign bytes are never disclosed');
    assertKeyOpaque(String(foreignGlobal.message), 'the cross-instance global denial');

    let foreignMember = null;
    try {
      vfs.readFile({ filePath: '/private/notes.md' }, { ...callContext(oneIdentity), workspaceId: twoMemberKey });
    } catch (err) {
      foreignMember = err;
    }
    assert.ok(foreignMember, 'instance one cannot read instance two private workspace');
    assert.equal(foreignMember.code, 'PERMISSION_DENIED');
    assert.equal(String(foreignMember.message).includes('Notes: beta brief'), false, 'foreign member bytes stay hidden');
    assertKeyOpaque(String(foreignMember.message), 'the cross-instance member denial');

    // Rosters stay realm-scoped; the store projects two same-id registrations.
    assert.deepEqual(runtime.listAgents({ realmId: realmOne }).map((agent) => agent.id), ['i2t-writer']);
    assert.deepEqual(runtime.listAgents({ realmId: realmTwo }).map((agent) => agent.id), ['i2t-writer']);
    assert.equal(store.agents.filter((agent) => agent.id === 'i2t-writer').length, 2);

    // The fixture declares no directive and no initialPrompt: no turn ran and
    // no mail crossed the instance boundary.
    assert.equal(store.messages.length, 0, 'package seed launches deliver no mail');
    assert.equal(runtime.getRuntimeMetrics().totalTurnsExecuted, 0, 'no package seed launch ran a turn');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
