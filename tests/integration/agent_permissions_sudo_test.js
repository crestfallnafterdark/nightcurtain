/**
 * @file tests/agent_permissions_sudo_test.js
 * @description Zero-mock verification suite for agent permissions, sudo / administrative authority,
 * tool presets / whitelists, and dynamic privilege reconfiguration.
 */

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('======================================================================');
  console.log('  AGENT PERMISSIONS & SUDO AUTHORITY VERIFICATION SUITE');
  console.log('======================================================================\n');

  // MOD-21 W4: the substrate resolves cross-workspace authority from the
  // injected identity port / internal principal only; delegate to the runtime
  // port once the runtime exists.
  let runtimeIdentityPort = null;
  const vfs = new VirtualFS({
    identityPort: {
      getAgentIdentity: (agentId) => (runtimeIdentityPort ? runtimeIdentityPort.getAgentIdentity(agentId) : null)
    }
  });
  const bus = new MessagingBus({
    identityPort: {
      getAgentIdentity: (agentId) => (runtimeIdentityPort ? runtimeIdentityPort.getAgentIdentity(agentId) : null)
    }
  });
  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus
  });
  runtimeIdentityPort = runtime.createAgentIdentityPort();

  // MOD-21: authority is default-deny; bootstrap the director (composition
  // root) and attribute privileged provisioning to its registry descriptor.
  await runtime.ensureDirector();

  // --- 1. Launch with Sudo / Privileged: true (operator authority) ---
  console.log('--- 1. Launch with Sudo / Privileged: true ---');
  assert(runtime.getAgent('director')?.config?.privileged === true, 'bootstrapped director is privileged');
  const sudoAgent = await runtime.launchAgent({
    config: {
      id: 'agent-root',
      name: 'Root Operator',
      role: 'Infrastructure Lead',
      privileged: true,
      allowedTools: ['*']
    },
    callerContext: { callerAgentId: 'director' }
  });

  assert(sudoAgent.config.privileged === true, 'Agent config reflects privileged === true');
  assert(sudoAgent.config.role === 'Infrastructure Lead', 'Agent custom role is preserved');
  assert(bus.getPolicy('agent-root')?.privileged === true, 'MessagingBus registers agent-root as privileged');

  // --- 2. Launch with Non-Privileged Standard Collaborator ---
  console.log('\n--- 2. Launch with Non-Privileged Standard Collaborator ---');
  const collabAgent = await runtime.launchAgent({
    id: 'agent-collab',
    name: 'Collaborator Worker',
    role: 'Worker',
    privileged: false,
    allowedTools: ['read_file', 'write_file', 'send_message']
  });

  assert(collabAgent.config.privileged === false, 'Standard agent config reflects privileged === false');
  assert(bus.getPolicy('agent-collab')?.privileged === false, 'MessagingBus registers agent-collab as non-privileged');
  assert(Array.isArray(collabAgent.config.allowedTools), 'allowedTools is an array');
  assert(collabAgent.config.allowedTools.length === 3, 'allowedTools contains exactly 3 tools');
  assert(collabAgent.config.allowedTools.includes('read_file'), 'read_file is in allowedTools');

  // --- 3. Dynamic Privilege Elevation & Downgrade via updateAgentConfig ---
  console.log('\n--- 3. Dynamic Privilege Elevation & Downgrade ---');

  // Anonymous authority grants are denied before mutation (MOD-21 W3)
  let anonymousDenied = false;
  try {
    runtime.updateAgentConfig('agent-collab', {
      privileged: true,
      allowedTools: ['*']
    });
  } catch (err) {
    anonymousDenied = err?.code === 'PERMISSION_DENIED';
  }
  assert(anonymousDenied === true, 'Anonymous updateAgentConfig cannot grant privileged');
  assert(collabAgent.config.privileged === false, 'Denied grant leaves collabAgent unprivileged');
  assert(bus.getPolicy('agent-collab')?.privileged === false, 'Denied grant leaves the bus policy unchanged');

  // Forged flags on an unprivileged registered caller are denied too
  let forgedDenied = false;
  try {
    runtime.updateAgentConfig('agent-collab', { privileged: true }, {
      callerAgentId: 'agent-collab',
      isPrivileged: true,
      isAdmin: true
    });
  } catch (err) {
    forgedDenied = err?.code === 'PERMISSION_DENIED';
  }
  assert(forgedDenied === true, 'Self-elevation through forged flags is denied');
  assert(collabAgent.config.privileged === false, 'Denied self-elevation leaves collabAgent unprivileged');

  // Operator authority (director registry descriptor) may elevate
  runtime.updateAgentConfig('agent-collab', {
    privileged: true,
    allowedTools: ['*']
  }, { callerAgentId: 'director' });

  assert(collabAgent.config.privileged === true, 'collabAgent was dynamically elevated to privileged === true');
  assert(bus.getPolicy('agent-collab')?.privileged === true, 'MessagingBus dynamically updated agent-collab to privileged === true');
  assert(collabAgent.config.allowedTools[0] === '*', 'allowedTools dynamically updated to [*]');

  // Downgrade back to unprivileged (operator authority)
  runtime.updateAgentConfig('agent-collab', {
    privileged: false,
    allowedTools: ['read_file']
  }, { callerAgentId: 'director' });

  assert(collabAgent.config.privileged === false, 'collabAgent was dynamically downgraded to privileged === false');
  assert(bus.getPolicy('agent-collab')?.privileged === false, 'MessagingBus dynamically updated agent-collab to non-privileged');
  assert(collabAgent.config.allowedTools.length === 1, 'allowedTools updated to 1 tool');

  // --- 4. Cross-Workspace VirtualFS Access via Sudo ---
  console.log('\n--- 4. Cross-Workspace VirtualFS Access via Sudo ---');
  vfs.writeFile('/secret.txt', 'collab secret content', { workspaceId: 'agent-collab', callerAgentId: 'agent-collab' });

  vfs.writeFile('/override.txt', 'root was here', { workspaceId: 'agent-collab', callerAgentId: 'agent-root', callerRole: 'admin', isAdmin: true });
  const overrideRead = vfs.readFile('/override.txt', { workspaceId: 'agent-collab', callerAgentId: 'agent-root', isAdmin: true });
  assert((typeof overrideRead === 'string' ? overrideRead : overrideRead.content) === 'root was here', 'Privileged agent wrote directly to foreign workspace');

  // Verify non-privileged agent cannot write to foreign workspace
  let rejected = false;
  try {
    vfs.writeFile('/hack.txt', 'intruder', { workspaceId: 'agent-collab', callerAgentId: 'agent-observer', callerRole: 'user', isAdmin: false });
  } catch (err) {
    rejected = true;
  }
  assert(rejected === true, 'Non-privileged agent rejected when attempting cross-workspace write');

  // --- 5. Tool Whitelist Restriction Verification ---
  console.log('\n--- 5. Tool Whitelist Restrictions ---');
  const readOnlyAgent = await runtime.launchAgent({
    id: 'agent-observer',
    name: 'Observer',
    privileged: false,
    allowedTools: ['read_file', 'query_json', 'list_files']
  });

  assert(readOnlyAgent.config.allowedTools.includes('read_file'), 'Observer has read_file');
  assert(!readOnlyAgent.config.allowedTools.includes('write_file'), 'Observer does NOT have write_file');
  assert(!readOnlyAgent.config.allowedTools.includes('kill_agent'), 'Observer does NOT have kill_agent');

  console.log('\n======================================================================');
  console.log(`  PERMISSIONS & SUDO TEST SUMMARY: ${passed}/${passed + failed} PASSED`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
