import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { createWechatRunner, summarizeWechat } from './wechat.mjs';
import { digest, readJson } from './state.mjs';

const help = `WeChat developer-upload operations (not review or public release)
--project <trusted-module> wechat prepare --ref <commit> --version <x.y.z> --current <private-observation.json> --state-dir <private-dir> [--description <text>]
--project <trusted-module> wechat upload <wechat-id> --approve <plan-digest> --state-dir <private-dir>
--project <trusted-module> wechat resume <wechat-id> --state-dir <private-dir>
--project <trusted-module> wechat status <wechat-id> --state-dir <private-dir>

The explicit trusted module exports { repo, wechatProject }. Prepare validates
source/build evidence without uploading. Upload requires the exact plan digest;
pending confirmation is action-required, not completed. Resume queries the saved
task once. Unknown writes are never replayed. Current-version observations name
{ appId, version, source: 'owner'|'provider', observedAt } and expire after 24h.
No experience selection, review submission or public release is implemented.
`;

export async function wechatMain({ args, repo, project, command, signal, output = console.log }) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ref: { type: 'string' }, version: { type: 'string' }, current: { type: 'string' },
    'state-dir': { type: 'string' }, description: { type: 'string' }, approve: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { output(help); return 0; }
  const [operation, id, ...extra] = positionals;
  if (!['prepare', 'upload', 'resume', 'status'].includes(operation) || extra.length ||
      (operation === 'prepare' ? id !== undefined : !id) || !values['state-dir'] ||
      (operation !== 'prepare' && ['ref', 'version', 'current', 'description'].some((key) => values[key] !== undefined)) ||
      (operation !== 'upload' && values.approve !== undefined)) throw new Error(help);
  const runner = await createWechatRunner({ repo, store: values['state-dir'], project, command, signal });
  let state;
  if (operation === 'prepare') {
    if (!values.current || !values.version || !values.ref) throw new Error(help);
    const path = resolve(values.current), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Version observation must be a bounded regular JSON file');
    state = await runner.prepare({ ref: values.ref, version: values.version, current: await readJson(path), description: values.description });
  } else if (operation === 'upload') state = await runner.upload(id, values.approve);
  else state = await runner[operation](id);
  output(JSON.stringify({ plan: state.plan, approvalDigest: digest(state.plan), summary: summarizeWechat(state) }, null, 2));
  // Status/prepare success is an observation/preparation, not completed delivery.
  return ['prepare', 'status'].includes(operation) || state.status === 'uploaded' ? 0 : 2;
}
