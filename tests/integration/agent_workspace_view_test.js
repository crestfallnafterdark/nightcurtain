/**
 * @file tests/integration/agent_workspace_view_test.js
 * @description Realm wave R / ticket a50f109 — agent workspace view end-to-end:
 *   1. Engine binding: agent tool I/O is private-by-default, so two agents
 *      writing `/same.md` stay in separate private workspaces and shared bytes
 *      move only through the `/global` mount.
 *   2. Shared mount: `/global/lore.md` is written mount-stripped (no literal
 *      `/global/...` record) and is visible to every realm member.
 *   3. Mounts: a same-realm root caller reads `/agents/<peer>/...`; an ordinary
 *      member is denied; a cross-realm attempt is denied naming the exact
 *      target id, realm-opaquely.
 *   4. Tool-boundary hygiene: a caller-supplied `workspace_id` tool parameter
 *      never selects the storage target.
 *   5. Opacity: no tool receipt/listing/error in agent history contains
 *      `realm:`.
 *
 * Real engine, real VirtualFS, scripted model (no mocks of the code under
 * test): turns run through `AgentRuntime.executeAgentTurn`, so the dispatcher
 * under test is exactly the one the turn engine constructs.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';

/** Builds a scripted model whose Nth stream call replays `script[N]`. */
function createScriptedModel(script) {
  let call = 0;
  const provider = {
    id: 'scripted-provider',
    createModel: () => model,
    getEndpointUrl: () => 'http://localhost/scripted',
    checkBalance: async () => ({ balance: 1 }),
    listModels: async () => [{ id: 'scripted-model', name: 'scripted-model' }]
  };
  const model = {
    id: 'scripted-model',
    config: {},
    provider,
    async *stream(options = {}) {
      const step = script[Math.min(call, script.length - 1)] || {};
      call += 1;
      if (typeof step.content === 'string' && step.content) {
        if (typeof options.onChunk === 'function') {
          try { options.onChunk({ type: 'text', content: step.content }); } catch (_) { /* ignore */ }
        }
        yield { type: 'text', content: step.content };
      }
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      if (toolCalls.length > 0) {
        yield { type: 'tool_call', toolCalls };
      }
      yield {
        type: 'finish',
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        content: step.content || '',
        toolCalls
      };
    },
    async complete() {
      return { content: 'complete' };
    }
  };
  return model;
}

/** Creates a scripted OpenAI-style tool call. */
function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** Extracts the JSON-parsed tool result messages from an agent's history. */
function toolResults(runtime, agentId) {
  const agent = runtime.getAgent(agentId);
  assert.ok(agent, `agent '${agentId}' exists`);
  return agent.history
    .filter((message) => message.role === 'tool')
    .map((message) => {
      try {
        return { content: String(message.content), parsed: JSON.parse(String(message.content)) };
      } catch {
        return { content: String(message.content), parsed: null };
      }
    });
}

test('agent workspace view: private-by-default placement, mounts, hygiene, opacity (a50f109)', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    // The director's private workspace (system scope) is a mount target that
    // must never be visible to a realm caller (ticket d587e1e).
    runtime.virtualFs.writeFile({ filePath: '/board.md', content: 'director-private-board' }, { callerAgentId: 'director' });

    // --- Agent A (realm alpha, ordinary) -----------------------------------
    const agentA = await runtime.launchAgent({
      id: 'agent_a',
      realmId: 'alpha',
      allowedTools: ['write_file', 'read_file', 'list_files', 'copy_file'],
      model: createScriptedModel([
        {
          content: '',
          toolCalls: [
            toolCall('a1', 'write_file', { file_path: '/same.md', content: 'from-a' }),
            toolCall('a2', 'write_file', { file_path: '/global/lore.md', content: 'shared-lore' }),
            // Tool-boundary hygiene: the model tries to select a foreign workspace.
            toolCall('a3', 'write_file', { file_path: '/hack.md', content: 'hygiene', workspace_id: 'agent_c' }),
            // Per-side workspace claims are inert at the agent boundary (cf5e707).
            toolCall('a4', 'copy_file', { src_path: '/same.md', dest_path: '/claim.md', dest_workspace_id: 'global' }),
            toolCall('a5', 'copy_file', { src_path: '/same.md', dest_path: '/claim2.md', src_workspace_id: 'agent_b' })
          ]
        },
        { content: 'done' }
      ])
    });
    assert.ok(agentA, 'agent A launched');

    // --- Agent B (realm alpha, ordinary) -----------------------------------
    await runtime.launchAgent({
      id: 'agent_b',
      realmId: 'alpha',
      allowedTools: ['write_file', 'read_file'],
      model: createScriptedModel([
        {
          content: '',
          toolCalls: [
            toolCall('b1', 'write_file', { file_path: '/same.md', content: 'from-b' }),
            toolCall('b2', 'read_file', { file_path: '/global/lore.md' })
          ]
        },
        { content: 'done' }
      ])
    });

    // --- Agent C (realm beta, ordinary) ------------------------------------
    await runtime.launchAgent({
      id: 'agent_c',
      realmId: 'beta',
      allowedTools: ['write_file'],
      model: createScriptedModel([
        { content: '', toolCalls: [toolCall('c1', 'write_file', { file_path: '/same.md', content: 'from-c' })] },
        { content: 'done' }
      ])
    });

    // --- Custom-workspace peer (realm alpha, ordinary) ---------------------
    // Its private workspace key is explicitly configured, so `/agents/<id>`
    // mounts must resolve it by agent identity, not by key lookup (9765b96).
    await runtime.launchAgent({
      id: 'agent_custom',
      realmId: 'alpha',
      workspaceId: 'custom_int_ws',
      allowedTools: ['write_file'],
      model: createScriptedModel([
        { content: '', toolCalls: [toolCall('x1', 'write_file', { file_path: '/custom.md', content: 'custom-private' })] },
        { content: 'done' }
      ])
    });

    // --- Root R (realm alpha, cross-workspace authority) -------------------
    await runtime.launchAgent({
      id: 'agent_root',
      realmId: 'alpha',
      privileged: true,
      allowedTools: ['read_file', 'list_files', 'write_file'],
      // Privileged provisioning is operator authority: attribute it to the
      // bootstrapped director descriptor (real registry authority, no flags).
      callerContext: { callerAgentId: 'director' },
      model: createScriptedModel([
        {
          content: '',
          toolCalls: [
            toolCall('r1', 'read_file', { file_path: '/agents/agent_b/same.md' }),
            toolCall('r2', 'read_file', { file_path: '/agents/agent_c/same.md' }),
            toolCall('r3', 'list_files', { dir_path: '/' }),
            toolCall('r4', 'read_file', { file_path: '/agents/agent_custom/custom.md' }),
            toolCall('r5', 'list_files', { dir_path: '/agents' })
          ]
        },
        { content: 'done' }
      ])
    });

    // --- Mapper M (realm alpha, cross-workspace authority) -----------------
    // Reproduces the verified engine path of ticket 2185224: an authority
    // creator pins a child's workspace to a cross-realm agent key, then mounts
    // the child. Peer-identity resolution alone must not expose the mapped
    // realm's bytes — the resolved workspace key's scope is enforced too.
    await runtime.launchAgent({
      id: 'agent_mapper',
      realmId: 'alpha',
      privileged: true,
      allowedTools: ['spawn_agent', 'read_file', 'list_files'],
      callerContext: { callerAgentId: 'director' },
      model: createScriptedModel([
        {
          content: '',
          toolCalls: [
            toolCall('m1', 'spawn_agent', { id: 'mapped_child', workspace: 'agent_c' }),
            toolCall('m2', 'read_file', { file_path: '/agents/mapped_child/same.md' }),
            toolCall('m3', 'list_files', { dir_path: '/agents' })
          ]
        },
        { content: 'done' }
      ])
    });

    // --- Generic root G (default realm, cross-workspace authority) ---------
    // The director's system scope is never mount-visible to a realm root
    // (ticket d587e1e): the Generic default realm is a realm like any other.
    await runtime.launchAgent({
      id: 'generic_root',
      privileged: true,
      allowedTools: ['read_file', 'list_files', 'write_file'],
      callerContext: { callerAgentId: 'director' },
      model: createScriptedModel([
        {
          content: '',
          toolCalls: [
            toolCall('g1', 'read_file', { file_path: '/agents/director/board.md' }),
            toolCall('g2', 'list_files', { dir_path: '/agents' })
          ]
        },
        { content: 'done' }
      ])
    });

    // A writes first, then B reads the shared mount, then C, then the custom
    // peer, then R mounts, then the mapper and the Generic root probe.
    await runtime.executeAgentTurn('agent_a', 'go');
    await runtime.executeAgentTurn('agent_b', 'go');
    await runtime.executeAgentTurn('agent_c', 'go');
    await runtime.executeAgentTurn('agent_custom', 'go');
    await runtime.executeAgentTurn('agent_root', 'go');
    await runtime.executeAgentTurn('agent_mapper', 'go');
    await runtime.executeAgentTurn('generic_root', 'go');

    // --- Placement ---------------------------------------------------------
    // Wave I (ticket d57cbc1): a realm-bound agent's default private workspace
    // is keyed by its canonical identity, so the same literal id in two realms
    // owns two distinct partitions.
    const wsA = (id) => `realm:alpha:${id}`;
    const wsB = (id) => `realm:beta:${id}`;
    const snapshot = runtime.virtualFs.exportSnapshot({ callerAgentId: 'director' });
    assert.ok(snapshot[wsA('agent_a')] && snapshot[wsA('agent_a')]['/same.md'], 'A writes its own private workspace');
    assert.equal(snapshot[wsA('agent_a')]?.['/same.md']?.content, 'from-a');
    assert.ok(snapshot[wsA('agent_b')] && snapshot[wsA('agent_b')]['/same.md'], 'B writes its own private workspace');
    assert.equal(snapshot[wsA('agent_b')]?.['/same.md']?.content, 'from-b');
    assert.ok(snapshot[wsB('agent_c')] && snapshot[wsB('agent_c')]['/same.md'], 'C writes its own private workspace');
    assert.equal(snapshot[wsB('agent_c')]?.['/same.md']?.content, 'from-c');
    assert.equal(snapshot['realm:alpha:global']?.['/same.md'], undefined, 'no private path leaks into the shared workspace');
    assert.equal(snapshot['realm:beta:global']?.['/same.md'], undefined, 'C never touches its shared workspace with a private path');
    assert.equal(snapshot[wsA('agent_a')]?.['/hack.md']?.content, 'hygiene', 'the foreign `workspace_id` tool param is ignored (A private)');
    assert.equal(snapshot[wsB('agent_c')]?.['/hack.md'], undefined, 'the foreign `workspace_id` tool param never targets another agent workspace');

    // --- Per-side workspace claims are inert (cf5e707) ---------------------
    assert.equal(snapshot[wsA('agent_a')]?.['/claim.md']?.content, 'from-a', 'a dest_workspace_id claim lands in the caller private workspace');
    assert.equal(snapshot['realm:alpha:global']?.['/claim.md'], undefined, 'a dest_workspace_id claim never touches the shared workspace');
    assert.equal(snapshot[wsA('agent_a')]?.['/claim2.md']?.content, 'from-a', 'a src_workspace_id claim still copies the private source');
    assert.equal(snapshot[wsA('agent_b')]?.['/claim2.md'], undefined, 'a src_workspace_id claim never targets another agent workspace');

    // --- Custom-workspace peer mounts (9765b96) ----------------------------
    assert.ok(snapshot.custom_int_ws && snapshot.custom_int_ws['/custom.md'], 'the custom-workspace peer writes its private workspace');
    assert.equal(snapshot['realm:alpha:global']?.['/custom.md'], undefined, 'the custom peer never touches the shared workspace');

    // --- Shared mount ------------------------------------------------------
    assert.equal(snapshot['realm:alpha:global']?.['/lore.md']?.content, 'shared-lore', 'the /global write is stored mount-stripped');
    assert.equal(snapshot['realm:alpha:global']?.['/global/lore.md'], undefined, 'no literal /global/... record is created');
    const bResults = toolResults(runtime, 'agent_b');
    const sharedRead = bResults.find((entry) => entry.content.includes('shared-lore'));
    assert.ok(sharedRead, 'B reads the shared bytes through the /global mount');

    // --- Mounts ------------------------------------------------------------
    const rootResults = toolResults(runtime, 'agent_root');
    const peerRead = rootResults.find((entry) => String(entry.parsed?.content || '').includes('from-b'));
    assert.ok(peerRead, 'a same-realm root caller mounts the peer file via /agents/<peer>');
    const crossRead = rootResults.find((entry) => entry.parsed && entry.parsed.success === false && String(entry.parsed.error || '').includes('agent_c'));
    assert.ok(crossRead, 'a cross-realm mount attempt is denied naming the exact target id');
    assert.ok(
      !/realm:/.test(String(crossRead.parsed.error)),
      'the cross-realm denial is realm-opaque'
    );
    const rootList = rootResults.find((entry) => Array.isArray(entry.parsed?.result));
    assert.ok(rootList, 'the root listing ran');
    const rootNames = rootList.parsed.result.map((item) => item.name);
    assert.ok(rootNames.includes('global'), 'the root listing shows the synthetic global/ mount');
    assert.ok(rootNames.includes('agents'), 'the root listing shows the synthetic agents/ mount');

    // Custom-workspace peer: the mount resolves by agent identity and shows up
    // in the root's `/agents` listing (9765b96).
    const customRead = rootResults.find((entry) => String(entry.parsed?.content || '').includes('custom-private'));
    assert.ok(customRead, 'a same-realm root mounts a custom-workspace peer by agent id');
    const agentsList = rootResults.find(
      (entry) => Array.isArray(entry.parsed?.result) && entry.parsed.result.some((item) => String(item.path || '').startsWith('/agents/'))
    );
    assert.ok(agentsList, 'the root /agents listing ran');
    const mountNames = agentsList.parsed.result.map((item) => item.name);
    assert.ok(mountNames.includes('agent_custom'), 'the root /agents listing includes the custom-workspace peer');
    assert.ok(mountNames.includes('agent_b'), 'the root /agents listing keeps default-key peers');
    assert.equal(JSON.stringify(agentsList.parsed.result).includes('custom_int_ws'), false, 'mount listings never expose physical workspace keys');

    // --- Cross-realm-mapped mount keys are denied (2185224) ----------------
    const mapperResults = toolResults(runtime, 'agent_mapper');
    const spawnReceipt = mapperResults.find((entry) => entry.parsed && entry.parsed.id === 'mapped_child');
    assert.ok(spawnReceipt && spawnReceipt.parsed.success === true, 'the authority spawn with a workspace pin succeeds');
    const mappedRead = mapperResults.find(
      (entry) => entry.parsed && entry.parsed.success === false && String(entry.parsed.error || '').includes('mapped_child')
    );
    assert.ok(mappedRead, 'a mount through a cross-realm-mapped workspace key is denied');
    assert.equal(mappedRead.parsed.code, 'PERMISSION_DENIED', 'the mapped-key denial is fail-closed');
    assert.equal(
      /from-c|realm:/.test(String(mappedRead.parsed.error)),
      false,
      'the mapped-key denial leaks neither beta bytes nor realm keys'
    );
    const mapperList = mapperResults.find(
      (entry) => Array.isArray(entry.parsed?.result) && entry.parsed.result.some((item) => String(item.path || '').startsWith('/agents/'))
    );
    assert.ok(mapperList, 'the mapper /agents listing ran');
    const mapperNames = mapperList.parsed.result.map((item) => item.name);
    assert.equal(mapperNames.includes('mapped_child'), false, 'a cross-realm-mapped child is never listed');
    assert.ok(mapperNames.includes('agent_b'), 'same-realm mount targets stay listed for the mapper');

    // --- The system scope is never mount-visible (d587e1e) -----------------
    const genericResults = toolResults(runtime, 'generic_root');
    const directorRead = genericResults.find(
      (entry) => entry.parsed && entry.parsed.success === false && String(entry.parsed.error || '').includes('director')
    );
    assert.ok(directorRead, 'a realm root is denied the director mount');
    assert.equal(directorRead.parsed.code, 'PERMISSION_DENIED', 'the director-mount denial is fail-closed');
    const genericList = genericResults.find((entry) => Array.isArray(entry.parsed?.result));
    assert.ok(genericList, 'the Generic root /agents listing ran');
    assert.equal(
      genericList.parsed.result.some((item) => item.name === 'director'),
      false,
      'the director is never listed to a realm root'
    );
    assert.equal(
      runtime.virtualFs.readFile({ filePath: '/board.md' }, { callerAgentId: 'director', raw: true }),
      'director-private-board',
      'the director private bytes survive the denied mount'
    );

    // --- Opacity -----------------------------------------------------------
    for (const agentId of ['agent_a', 'agent_b', 'agent_c', 'agent_custom', 'agent_root']) {
      const receipts = toolResults(runtime, agentId).map((entry) => entry.content).join('\n');
      assert.equal(/realm:/.test(receipts), false, `agent '${agentId}' tool receipts/errors never expose a realm key`);
    }

    // --- Ordinary member cannot mount a peer -------------------------------
    await runtime.launchAgent({
      id: 'agent_probe',
      realmId: 'alpha',
      allowedTools: ['read_file'],
      model: createScriptedModel([
        {
          content: '',
          toolCalls: [
            toolCall('p1', 'read_file', { file_path: '/agents/agent_b/same.md' }),
            toolCall('p2', 'read_file', { file_path: '/agents/agent_custom/custom.md' })
          ]
        },
        { content: 'done' }
      ])
    });
    await runtime.executeAgentTurn('agent_probe', 'go');
    const probeResults = toolResults(runtime, 'agent_probe');
    assert.ok(
      probeResults.some((entry) => entry.parsed && entry.parsed.success === false && entry.parsed.code === 'PERMISSION_DENIED'),
      'an ordinary member is denied the /agents/<peer> mount'
    );
    assert.equal(
      probeResults.some((entry) => String(entry.parsed?.content || '').includes('custom-private')),
      false,
      'an ordinary member never reads custom-workspace peer bytes'
    );
  } finally {
    runtime.destroy();
  }
});

test('wave I (d57cbc1): realm-local identity keys partition VFS private workspaces through the real runtime port', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const scripted = () => createScriptedModel([{ content: 'done' }]);
    // The same literal id in two realms is legal (I2-CORE) — the VFS must keep
    // the two private workspaces apart.
    await runtime.launchAgent({ id: 'scout', realmId: 'alpha', model: scripted() });
    await runtime.launchAgent({ id: 'scout', realmId: 'beta', model: scripted() });
    await runtime.launchAgent({ id: 'outrider', realmId: 'beta', model: scripted() });
    await runtime.launchAgent({
      id: 'overseer',
      realmId: 'alpha',
      privileged: true,
      allowedTools: ['read_file', 'write_file'],
      callerContext: { callerAgentId: 'director' },
      model: scripted()
    });

    const port = runtime.createAgentIdentityPort();
    const vfs = runtime.virtualFs;
    const callerKey = (realmId, id) => createAgentIdentityKey(realmId, id);
    const alphaScout = { callerAgentId: 'scout', callerKey: callerKey('alpha', 'scout') };
    const betaScout = { callerAgentId: 'scout', callerKey: callerKey('beta', 'scout') };

    const alphaWrite = vfs.writeFile({ filePath: '/note.md', content: 'alpha-note' }, alphaScout);
    assert.equal(alphaWrite.workspaceId, 'scout', 'the receipt projects the bare id');
    assert.equal(JSON.stringify(alphaWrite).includes('realm:'), false, 'the receipt is canonical-key opaque');
    vfs.writeFile({ filePath: '/note.md', content: 'beta-note' }, betaScout);

    // Two distinct realm-qualified partitions, no bare-id partition.
    const snapshot = vfs.exportSnapshot({ principal: runtime.getOperatorPrincipal() });
    assert.equal(snapshot['realm:alpha:scout']['/note.md'].content, 'alpha-note');
    assert.equal(snapshot['realm:beta:scout']['/note.md'].content, 'beta-note');
    assert.equal(snapshot.scout, undefined, 'the same literal id never shares a bare-id partition');
    assert.equal(port.getAgentIdentity('scout'), null, 'the bare id is ambiguous across realms (fail closed)');

    // Same-realm member access by bare id resolves the caller realm's scout.
    assert.equal(
      vfs.readFile({ filePath: '/agents/scout/note.md' }, { callerAgentId: 'overseer', callerKey: callerKey('alpha', 'overseer'), raw: true }),
      'alpha-note',
      "a same-realm root mount resolves the caller realm's same-id registration"
    );

    // Foreign-realm peer: denied, naming the requested mount id only, opaque.
    let foreignErr = null;
    try {
      vfs.readFile({ filePath: '/agents/outrider/note.md' }, { callerAgentId: 'overseer', callerKey: callerKey('alpha', 'overseer') });
    } catch (err) {
      foreignErr = err;
    }
    assert.ok(foreignErr instanceof Error && foreignErr.code === 'PERMISSION_DENIED', 'a cross-realm mount is denied');
    assert.ok(String(foreignErr.message).includes('outrider'), 'the denial names the requested mount id');
    assert.equal(/realm:/.test(String(foreignErr.message)), false, 'the denial is realm-opaque');

    // Without the canonical caller key an ambiguous bare id fails closed
    // instead of silently sharing the bare partition.
    assert.throws(
      () => vfs.writeFile({ filePath: '/ambiguous.md', content: 'x' }, { callerAgentId: 'scout' }),
      (err) => err instanceof Error && err.code === 'PERMISSION_DENIED',
      'an ambiguous bare caller id without the canonical key fails closed'
    );
  } finally {
    runtime.destroy();
  }
});
