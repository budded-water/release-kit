import { parseArgs } from 'node:util';
import { inspectStorage, planStorageCleanup } from './storage.mjs';

export async function storageMain({ args, signal, output = console.log } = {}) {
  signal?.throwIfAborted();
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { 'state-dir': { type: 'string' }, 'max-entries': { type: 'string', default: '100000' },
      'timeout-seconds': { type: 'string', default: '120' }, help: { type: 'boolean' } } });
  const operation = positionals[0];
  if (!['storage-inspect', 'storage-plan'].includes(operation) || positionals.length !== 1) throw new Error('Expected one storage read operation; no release ID');
  if (values.help) {
    output(`${operation} --state-dir <existing-absolute-directory> [--max-entries <1–1000000>] [--timeout-seconds <1–300>]\nRead-only inventory/cleanup preview; no deletion, apply, project or provider operations.`);
    return 0;
  }
  if (!values['state-dir'] || !/^[1-9]\d*$/.test(values['max-entries']) || !/^[1-9]\d*$/.test(values['timeout-seconds'])) throw new Error('Storage reads require --state-dir and positive integer budgets');
  const inventory = await inspectStorage({ stateDirectory: values['state-dir'], maxEntries: Number(values['max-entries']),
    timeoutMs: Number(values['timeout-seconds']) * 1000, signal });
  signal?.throwIfAborted();
  output(JSON.stringify(operation === 'storage-inspect' ? inventory : planStorageCleanup(inventory), null, 2));
  return inventory.observationComplete ? 0 : 2;
}
