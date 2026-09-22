/**
 * @file tests/interrupted_turn_resend_test.js
 * @description Comprehensive verification suite for agent-turn interruption, undo and resend:
 * 1. Interrupted agents record lastInterruptedTurn and report isAgentInterrupted.
 * 2. undoAgentTurn() on an interrupted agent turn.
 * 3. undoAgentTurn() while an agent turn is in-flight.
 * 4. retryAgentTurn() on an interrupted agent turn avoids duplicate user messages.
 * 5. undoAgentTurn() on a completed turn pops both assistant and user.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../test_env.js';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';

test('Comprehensive Turn Interruption, Undo & Resend Verification Suite', async (suite) => {
  await suite.test('1. Interrupted agent records lastInterruptedTurn and isAgentInterrupted detects a dangling user turn', async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

    const agent = await runtime.launchAgent({
      id: 'agent_cancel_test',
      role: 'worker',
      allowedTools: []
    });

    assert.equal(runtime.isAgentInterrupted('agent_cancel_test'), false);

    // A dangling unresponded user turn marks the agent interrupted.
    agent.history.push({ role: 'user', content: 'Draft the report' });
    assert.equal(runtime.isAgentInterrupted('agent_cancel_test'), true, 'Dangling user turn detected');

    // An explicit interruption record is detected the same way.
    agent.lastInterruptedTurn = {
      input: 'Draft the report',
      mode: 'chat',
      timestamp: Date.now(),
      cancelled: true
    };

    assert.equal(runtime.isAgentInterrupted('agent_cancel_test'), true);
  });

  await suite.test('2. Sandbox Mode: undoAgentTurn() on interrupted agent turn', async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

    const agent = await runtime.launchAgent({
      id: 'agent_undo_test',
      role: 'worker',
      allowedTools: []
    });

    agent.history = [
      { role: 'assistant', content: 'Ready for work.' },
      { role: 'user', content: 'Analyze the audit logs' }
    ];
    agent.lastInterruptedTurn = {
      input: 'Analyze the audit logs',
      mode: 'chat',
      timestamp: Date.now(),
      cancelled: true
    };

    let emittedUndone = null;
    runtime.on('turn_undone', (data) => {
      emittedUndone = data;
    });

    const undoResult = runtime.undoAgentTurn('agent_undo_test');

    assert.equal(undoResult.undoneUserContent, 'Analyze the audit logs');
    assert.equal(agent.history.length, 1);
    assert.equal(agent.history[0].role, 'assistant');
    assert.equal(agent.lastInterruptedTurn, null);
    assert.equal(runtime.isAgentInterrupted('agent_undo_test'), false);
    assert.ok(emittedUndone);
    assert.equal(emittedUndone.payload.undoneUserContent, 'Analyze the audit logs');
  });

  await suite.test('3. Sandbox Mode: undoAgentTurn() while agent turn is in-flight', async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

    const agent = await runtime.launchAgent({
      id: 'agent_inflight_undo',
      role: 'worker',
      allowedTools: []
    });

    agent.history = [
      { role: 'assistant', content: 'Systems nominal.' },
      { role: 'user', content: 'Compile firmware' }
    ];
    agent.state = AGENT_STATES.RUNNING;
    agent.abortController = new AbortController();
    agent.currentStream = 'Partial output...';
    agent.activeToolCalls = [{ name: 'test_tool', id: 'call_1' }];

    const undoResult = runtime.undoAgentTurn('agent_inflight_undo');

    assert.equal(undoResult.undoneUserContent, 'Compile firmware');
    assert.equal(agent.state, AGENT_STATES.IDLE, 'Agent state reset to IDLE');
    assert.equal(agent.currentStream, '', 'currentStream cleared');
    assert.equal(agent.activeToolCalls.length, 0, 'activeToolCalls cleared');
    assert.equal(agent.history.length, 1);
    assert.equal(agent.history[0].role, 'assistant');
  });

  await suite.test('4. Sandbox Mode: retryAgentTurn() on interrupted agent turn avoids duplicate user messages', async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

    const agent = await runtime.launchAgent({
      id: 'agent_retry_test',
      role: 'worker',
      allowedTools: []
    });

    agent.history = [
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Fetch current temperature' }
    ];
    agent.lastInterruptedTurn = {
      input: 'Fetch current temperature',
      timestamp: Date.now(),
      cancelled: true
    };

    // Mock the queue-backed user-turn entry on the runtime to verify the passed
    // prompt and prevent network calls. Retry is a user-initiated resend and
    // routes through enqueueUserTurn (MOD-21 W7 single dispatch point).
    let executedPrompt = null;
    runtime.enqueueUserTurn = async (agentId, input) => {
      executedPrompt = input;
      agent.history.push({ role: 'user', content: input });
      agent.history.push({ role: 'assistant', content: 'The temperature is 22°C.' });
      return { prose: 'The temperature is 22°C.' };
    };

    await runtime.retryAgentTurn('agent_retry_test');

    assert.equal(executedPrompt, 'Fetch current temperature');
    assert.equal(agent.lastInterruptedTurn, null);
    // History should be: [assistant ("Hello."), user ("Fetch current temperature"), assistant ("The temperature is 22°C.")]
    assert.equal(agent.history.length, 3, 'No duplicate user entries created');
    assert.equal(agent.history[0].role, 'assistant');
    assert.equal(agent.history[1].role, 'user');
    assert.equal(agent.history[1].content, 'Fetch current temperature');
    assert.equal(agent.history[2].role, 'assistant');
  });

  await suite.test('5. Sandbox Mode: undoAgentTurn() on a completed turn pops both assistant and user', async () => {
    const vfs = new VirtualFS();
    const bus = new MessagingBus();
    const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

    const agent = await runtime.launchAgent({
      id: 'agent_full_undo',
      role: 'worker',
      allowedTools: []
    });

    agent.history = [
      { role: 'assistant', content: 'System ready.' },
      { role: 'user', content: 'Who are you?' },
      { role: 'assistant', content: 'I am a worker agent.' }
    ];

    const undoResult = runtime.undoAgentTurn('agent_full_undo');

    assert.equal(undoResult.undoneAssistantContent, 'I am a worker agent.');
    assert.equal(undoResult.undoneUserContent, 'Who are you?');
    assert.equal(agent.history.length, 1);
    assert.equal(agent.history[0].content, 'System ready.');
  });
});
