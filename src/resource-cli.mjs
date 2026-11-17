import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { acquireMaintenance } from './coordination.mjs';
import { createResourceLifecycle } from './resource-lifecycle.mjs';
import { readResourceJson, resourceError, resourceCode } from './resource-ledger.mjs';

export async function loadResourceLifecycle(path, { repo, store, project, command, signal, environment = process.env } = {}) {
  if (typeof project?.resourceAdapter !== 'function')
    throw resourceError('RESOURCE_POLICY', 'Lifecycle requires the explicitly supplied trusted project adapter');
  const policy = (await readResourceJson(resolve(path))).value;
  if (typeof policy.stateDirectory !== 'string' || resolve(policy.stateDirectory) !== policy.stateDirectory ||
      store && resolve(store) !== policy.stateDirectory)
    throw resourceError('RESOURCE_POLICY', 'Lifecycle policy does not bind the selected canonical state root');
  const adapter = await project.resourceAdapter({ policy, repo, command, signal, environment });
  return createResourceLifecycle({ stateDirectory: policy.stateDirectory, policy, adapter, signal });
}

export async function resourceReclaimMain({ args, repo, project, command, signal, resourceLease, environment = process.env, output = console.log } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    output('storage-reclaim --config <private-lifecycle-policy.json> [--dry-run]\nRequires prior installed activation; existing storage-inspect/storage-plan remain read-only.');
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== 'storage-reclaim' || !values.config)
    throw resourceError('RESOURCE_POLICY', 'storage-reclaim requires only an explicit lifecycle policy');
  signal?.throwIfAborted();
  const lifecycle = await loadResourceLifecycle(values.config, { repo, project, command, signal, environment });
  let lease = resourceLease;
  try {
    if (!values['dry-run'] && !lease)
      lease = await acquireMaintenance(lifecycle.coordinationAnchor, { operation: 'explicit resource reclamation' });
    const report = await lifecycle.reclaim({ lease, dryRun: Boolean(values['dry-run']) });
    output(JSON.stringify(report, null, 2));
    return report.outcome === 'complete' ? 0 : report.outcome === 'protected-capacity' ? 3 : 4;
  } catch (error) {
    if (signal?.aborted) return 130;
    if (['RESOURCE_POLICY', 'RESOURCE_NOT_ACTIVATED', 'RESOURCE_COMPATIBILITY'].includes(error.code)) throw error;
    const blocked = ['COORDINATION_BUSY', 'RESOURCE_CAPACITY'].includes(error.code);
    output(JSON.stringify({ schemaVersion: 1, kind: 'resource-maintenance', trigger: 'explicit',
      stateDirectory: lifecycle.stateDirectory, policy: lifecycle.policyIdentity,
      readOnly: Boolean(values['dry-run']), observationComplete: false,
      outcome: blocked ? 'protected-capacity' : 'incomplete', errors: [resourceCode(error)],
      ...(lease?.retained ? { ownershipRetained: true } : {}) }, null, 2));
    return blocked ? 3 : 4;
  } finally {
    if (lease && !resourceLease && !lease.retained) await lease.release();
  }
}
