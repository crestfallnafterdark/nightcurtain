/**
 * Baked demo template for the `realmCatalog` module.
 *
 * The fixture is deliberately trivial and non-domain: a privileged coordinator
 * with a manager-style tool profile and a read-only worker, each carrying a
 * single inline `text` prompt part. The demo declares no inputs and no seed;
 * real templates compose bundle files and template inputs.
 */

import { deepFreeze } from './freeze.ts';
import type { RealmAgentSpec, RealmTemplate } from './types.ts';

/** Privileged coordinator spec: manager capability, elevated privilege. */
const coordinatorSpec: RealmAgentSpec = {
  key: 'coordinator',
  idPattern: 'coordinator',
  name: 'Coordinator',
  role: 'coordinator',
  prompt: [{ kind: 'text', text: 'You coordinate the realm workers and report their results back.' }],
  toolProfile: { preset: 'manager' },
  privileged: true
};

/** Read-only worker spec: read-only capability, unprivileged. */
const workerSpec: RealmAgentSpec = {
  key: 'worker',
  idPattern: 'worker',
  name: 'Worker',
  role: 'worker',
  prompt: [{ kind: 'text', text: 'You carry out the coordinator assignments and report back.' }],
  toolProfile: { preset: 'readonly' },
  privileged: false
};

/**
 * Baked demo template (frozen): two agents, one privileged coordinator with a
 * manager-style profile and one read-only worker.
 *
 * The template is the stable launch/test fixture for the Realm launcher and
 * materializes deterministic plans for any target realm id.
 */
export const DEMO_TEMPLATE: RealmTemplate = deepFreeze({
  id: 'demo',
  name: 'Demo Realm',
  description: 'Trivial two-agent fixture: a privileged coordinator and a read-only worker.',
  formatVersion: 1,
  agents: [coordinatorSpec, workerSpec]
});
