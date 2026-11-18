import { join } from 'node:path';
import { createResourceLifecycle } from '../../src/resource-lifecycle.mjs';

export const plan = { id: `release-${'a'.repeat(24)}`, source: 'b'.repeat(40) };

export function resourceHarness(root, hooks = {}) {
  const store = join(root, 'state'), anchor = join(root, 'coordination');
  const workspace = join(store, 'releases', plan.id, 'validation');
  const cache = join(workspace, '.native/intermediates');
  const policy = { schemaVersion: 1, coordinationAnchor: anchor, cacheBudgetBytes: 8,
    minimumFreeBytes: 1, phaseBytes: { validate: 1, execute: 2, content: 3 } };
  const adapter = { schemaVersion: 1, policy: 'c'.repeat(64),
    caches: { compiler: { path: '.native/intermediates', stages: ['checks'] } },
    references: async () => [], toolchain: async () => 'e'.repeat(64),
    sessions: ['synthetic-session'], validateSession: async () => true,
    releaseSession: async () => {},
    reconstructable: async ({ resource }) => ({ source: resource.source, toolchain: resource.toolchain,
      sourceClean: true, inputsAvailable: true, recoveryIndependent: true }), ...hooks };
  return { store, anchor, workspace, cache, policy,
    lifecycle: createResourceLifecycle({ stateDirectory: store, policy, adapter }) };
}
