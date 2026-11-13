import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand } from './command.mjs';
import { digest, loadState, saveState } from './state.mjs';
import { createWechatRunner, summarizeWechat, assertWechatState, assertWechatVersionObservation } from './wechat.mjs';
import { main } from './cli.mjs';

const appId = 'wx1111111111111111';
const time = Date.parse('2026-01-02T12:00:00Z');
const observation = { appId, version: '1.22.4', source: 'owner', observedAt: new Date(time).toISOString() };
async function fixture(t, base = tmpdir(), repoName = 'repo') {
  const directory = await mkdtemp(join(base, 'wechat-operation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, repoName), store = join(directory, 'private');
  await mkdir(repo); await mkdir(store);
  const git = (...args) => runCommand('git', args, { cwd: repo });
  await git('init', '-q');
  await git('config', 'user.name', 'Synthetic');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'core.hooksPath', '/dev/null');
  await git('remote', 'add', 'origin', 'https://example.invalid/synthetic-mini.git');
  await writeFile(join(repo, '.gitignore'), 'dist/\n.validation/\n');
  await writeFile(join(repo, 'source.txt'), 'synthetic source');
  await git('add', '.'); await git('commit', '-qm', 'synthetic');
  await mkdir(join(repo, 'dist'));
  await writeFile(join(repo, 'dist/project.config.json'), JSON.stringify({ appid: appId, compileType: 'miniprogram' }));
  await writeFile(join(repo, 'dist/app.js'), 'App({})');
  const calls = [];
  let uploadMode = 'pending', taskMode = 'success', revalidationFails = false, clock = time;
  const command = async (binary, args, options) => {
    if (binary === 'git') return runCommand(binary, args, options);
    assert.equal(options.diagnostics, false);
    const tool = args[2]; calls.push({ tool, args });
    let result;
    if (tool === 'check_wechatide_status') result = { success: true, skillVersion: '0.3.11', versionRelation: 'equal', loginExpired: false, tokenRequired: false, cliTokenRequired: false, loginUser: 'PRIVATE_IDENTITY_SENTINEL' };
    if (tool === 'upload') {
      if (uploadMode === 'throw') throw new Error('PRIVATE_ERROR_SENTINEL');
      if (uploadMode === 'cleanup') throw Object.assign(new Error('uncertain cleanup'), { cleanupIncomplete: true });
      result = uploadMode === 'pending' ? { success: true, status: 'pending', taskId: 'confirmation_upload_synthetic' } :
        uploadMode === 'missing-task' ? { success: true, status: 'pending' } : { success: true, status: 'success', result: { success: true } };
    }
    if (tool === 'polling_task_result') {
      assert.deepEqual(args.slice(3), ['--task-id', 'confirmation_upload_synthetic']);
      result = { success: true, status: taskMode, taskId: 'confirmation_upload_synthetic', result: { success: true }, private: 'PRIVATE_RECEIPT_SENTINEL' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, tool, clientName: 'Codex', result }), stderr: '' };
  };
  const project = { schemaVersion: 1, appId, policy: 'synthetic/checks/v1', artifactDirectory: 'dist',
    driver: { binary: '/synthetic/wechatide', clientName: 'Codex', skillVersion: '0.3.11' },
    async validate({ source }) {
      await mkdir(join(repo, '.validation'), { recursive: true });
      const bytes = JSON.stringify({ source, synthetic: true });
      await writeFile(join(repo, '.validation/receipt.json'), bytes);
      return { path: '.validation/receipt.json', sha256: digest(bytes) };
    },
    async revalidate() { if (revalidationFails) throw new Error('invalid receipt'); },
  };
  const options = { repo, store, project, command, now: () => clock };
  const runner = await createWechatRunner(options);
  return { repo, store, project, command, options, runner, calls,
    prepare: (extra = {}) => runner.prepare({ ref: 'HEAD', version: '1.22.5', current: observation, ...extra }),
    uploadMode: (v) => uploadMode = v, taskMode: (v) => taskMode = v,
    invalidate: () => revalidationFails = true, clock: (v) => clock = v };
}

test('explicit current version rejects historical logs, stale/unknown versions and rollback', () => {
  assertWechatVersionObservation(observation, appId, '1.22.5', time);
  for (const current of [undefined, { ...observation, source: 'local-log' }, { ...observation, appId: 'wx2222222222222222' },
    { ...observation, observedAt: '2025-01-01' }, { ...observation, observedAt: '2027-01-01' }]) {
    assert.throws(() => assertWechatVersionObservation(current, appId, '1.22.5', time));
  }
  for (const version of ['1.22.0', '1.22.4', '1.22.4-test', '01.22.5']) assert.throws(() => assertWechatVersionObservation(observation, appId, version, time));
});

test('state remains outside source through system aliases and nonexistent nested directories', async (t) => {
  for (const base of process.platform === 'darwin' ? [tmpdir(), '/tmp'] : [tmpdir()]) {
    const f = await fixture(t, base);
    for (const suffix of ['', '.private-state', 'missing/nested-state']) {
      const store = join(f.repo, suffix);
      await assert.rejects(createWechatRunner({ ...f.options, store }), /outside candidate source/);
      if (suffix) await assert.rejects(lstat(store), { code: 'ENOENT' });
    }
  }
});

test('ancestor stores cannot put managed journals or cleanup locks inside a checkout', async (t) => {
  for (const name of ['wechat', 'locks']) {
    const f = await fixture(t, tmpdir(), name), parent = dirname(f.repo);
    const before = await readdir(parent);
    await assert.rejects(createWechatRunner({ ...f.options, store: parent }), /ancestor overlap/);
    assert.deepEqual(await readdir(parent), before);
  }
});

test('a checkout subdirectory cannot hide an in-checkout sibling store', async (t) => {
  const f = await fixture(t), nested = join(f.repo, 'src'), store = join(f.repo, 'missing-state');
  await mkdir(nested);
  const before = await readdir(f.repo);
  const runner = await createWechatRunner({ ...f.options, repo: nested, store });
  await assert.rejects(runner.prepare({ ref: 'HEAD', version: '1.22.5', current: observation }), /actual Git checkout root/);
  await assert.rejects(lstat(store), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.repo), before);
});

test('initial Git discovery retains bootstrap exclusion before any business journal exists', async (t) => {
  for (const fenceFails of [false, true]) {
    const f = await fixture(t), bootstrap = join(f.repo, '.git/release-kit-wechat');
    let launched = 0;
    const command = async (bin, args, options) => {
      if (bin === 'git' && args.includes('--show-toplevel')) {
        launched++;
        if (fenceFails) await writeFile(join(bootstrap, 'locks'), 'synthetic fence failure');
        throw Object.assign(new Error('Unsettled initial Git process'), { cleanupIncomplete: true });
      }
      return f.command(bin, args, options);
    };
    const runner = await createWechatRunner({ ...f.options, command });
    await assert.rejects(runner.prepare({ ref: 'HEAD', version: '1.22.5', current: observation }), { cleanupIncomplete: true });
    await lstat(join(bootstrap, 'initialization.lock'));
    await assert.rejects(lstat(join(f.store, 'wechat')), { code: 'ENOENT' });
    const fresh = await createWechatRunner({ ...f.options, command });
    await assert.rejects(fresh.prepare({ ref: 'HEAD', version: '1.22.6', current: observation }), /Execution lock exists/);
    assert.equal(launched, 1); assert.equal(f.calls.length, 0);
  }
});

test('registered Git worktrees use protected administrative initialization state', async (t) => {
  const f = await fixture(t), repo = join(dirname(f.repo), 'linked');
  await runCommand('git', ['worktree', 'add', '-q', '--detach', repo, 'HEAD'], { cwd: f.repo });
  await mkdir(join(repo, 'dist'));
  await writeFile(join(repo, 'dist/project.config.json'), JSON.stringify({ appid: appId, compileType: 'miniprogram' }));
  await writeFile(join(repo, 'dist/app.js'), 'App({})');
  const project = { ...f.project, validate: async ({ source }) => {
    await mkdir(join(repo, '.validation'), { recursive: true });
    const bytes = JSON.stringify({ source }); await writeFile(join(repo, '.validation/receipt.json'), bytes);
    return { path: '.validation/receipt.json', sha256: digest(bytes) };
  } };
  const runner = await createWechatRunner({ ...f.options, repo, store: join(dirname(repo), 'linked-private'), project });
  assert.equal((await runner.prepare({ ref: 'HEAD', version: '1.22.5', current: observation })).status, 'prepared');
  assert.equal(f.calls.length, 0);
});

test('origin credentials and query values never enter a prepared plan or CLI output', async (t) => {
  const f = await fixture(t);
  for (const origin of ['https://SYNTHETIC_SECRET@example.invalid/repo.git', 'https://example.invalid/repo.git?token=SYNTHETIC_SECRET', 'ssh://git:SYNTHETIC_SECRET@example.invalid/repo.git']) {
    await runCommand('git', ['remote', 'set-url', 'origin', origin], { cwd: f.repo });
    await assert.rejects(f.prepare(), (error) => /credential-free/.test(error.message) && !error.message.includes('SYNTHETIC_SECRET'));
  }
  await assert.rejects(lstat(join(f.store, 'wechat/operations')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
  const current = join(f.store, 'current.json');
  await writeFile(current, JSON.stringify({ ...observation, observedAt: new Date().toISOString() }));
  let printed = false;
  await assert.rejects(main({ repo: f.repo, wechatProject: f.project, command: f.command, output: () => { printed = true; }, args: ['wechat', 'prepare', '--ref', 'HEAD', '--version', '1.22.5', '--current', current, '--state-dir', f.store] }), /credential-free/);
  assert.equal(printed, false);
  await runCommand('git', ['remote', 'set-url', 'origin', 'git@example.invalid:synthetic/repo.git'], { cwd: f.repo });
  assert.equal((await f.prepare()).plan.repository, 'git@example.invalid:synthetic/repo.git');
});

test('prepare is non-publishing; exact approval, pending resume and final upload have truthful projections', async (t) => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.runner.upload(prepared.plan.id, 'wrong'), /approval/);
  const pending = await f.runner.upload(prepared.plan.id, digest(prepared.plan));
  assert.equal(pending.status, 'pending-confirmation'); assert.equal(summarizeWechat(pending).uploadCompleted, false);
  assert.equal((await f.runner.upload(prepared.plan.id, digest(prepared.plan))).status, 'pending-confirmation');
  const uploaded = await f.runner.resume(prepared.plan.id);
  assert.equal(uploaded.status, 'uploaded'); assert.equal(summarizeWechat(uploaded).artifactVerified, true);
  assert.equal(summarizeWechat(uploaded).reviewSubmitted, false); assert.equal(summarizeWechat(uploaded).experienceVersionSelected, false);
  await f.runner.resume(prepared.plan.id); await f.runner.upload(prepared.plan.id, digest(prepared.plan));
  assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 1);
  assert.equal(f.calls.filter((x) => x.tool === 'polling_task_result').length, 1);
  const saved = JSON.stringify(await loadState(join(f.store, 'wechat/operations', prepared.plan.id)));
  assert.ok(!saved.includes('PRIVATE_'));
});

test('changed source, artifact and receipt cannot use old upload approval', async (t) => {
  for (const kind of ['source', 'artifact', 'receipt']) await t.test(kind, async (t) => {
    const f = await fixture(t), p = await f.prepare();
    const path = { source: 'source.txt', artifact: 'dist/app.js', receipt: '.validation/receipt.json' }[kind];
    await writeFile(join(f.repo, path), 'changed');
    await assert.rejects(f.runner.upload(p.plan.id, digest(p.plan)));
    assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 0);
    assert.equal((await f.runner.status(p.plan.id)).status, 'prepared');
  });
});

test('expired observation blocks first write but never blocks observation of an already started task', async (t) => {
  const f = await fixture(t), p = await f.prepare();
  f.clock(time + 25 * 60 * 60 * 1000);
  await assert.rejects(f.runner.upload(p.plan.id, digest(p.plan)), /24 hours/);
  f.clock(time); await f.runner.upload(p.plan.id, digest(p.plan)); f.clock(time + 25 * 60 * 60 * 1000);
  assert.equal((await f.runner.resume(p.plan.id)).status, 'uploaded');
});

test('unknown external write survives a fresh runner and never permits replay', async (t) => {
  const f = await fixture(t), p = await f.prepare(), next = await f.prepare({ version: '1.22.6' }); f.uploadMode('throw');
  await assert.rejects(f.runner.upload(p.plan.id, digest(p.plan)), /outcome unknown/);
  const fresh = await createWechatRunner(f.options);
  assert.equal((await fresh.upload(p.plan.id, digest(p.plan))).status, 'upload-unknown');
  assert.equal((await fresh.resume(p.plan.id)).status, 'upload-unknown');
  f.project.validate = () => { throw new Error('Must not rebuild active artifact'); };
  await assert.rejects(f.prepare({ version: '1.22.7' }), /reconciliation before rebuilding/);
  await assert.rejects(fresh.upload(next.plan.id, digest(next.plan)), /reconciliation/);
  assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 1);
});

test('missing pending task identity stays unknown rather than authorizing another write', async (t) => {
  const f = await fixture(t), p = await f.prepare(); f.uploadMode('missing-task');
  await assert.rejects(f.runner.upload(p.plan.id, digest(p.plan)), /unknown/);
  assert.equal((await f.runner.status(p.plan.id)).status, 'upload-unknown');
});

test('a valid journal copied under another operation identity cannot be observed or uploaded', async (t) => {
  const f = await fixture(t), first = await f.prepare(), second = await f.prepare({ version: '1.22.6' });
  await saveState(join(f.store, 'wechat/operations', first.plan.id), second);
  await assert.rejects(f.runner.status(first.plan.id), /requested operation ID/);
  await assert.rejects(f.runner.upload(first.plan.id, digest(second.plan)), /requested operation ID/);
  assert.equal(f.calls.length, 0);
});

test('pending another version blocks new upload; completed versions retain immutable ownership', async (t) => {
  const f = await fixture(t), p = await f.prepare(), next = await f.prepare({ version: '1.22.6' }); await f.runner.upload(p.plan.id, digest(p.plan));
  await assert.rejects(f.prepare({ version: '1.22.7' }), /reconciliation before rebuilding/);
  await assert.rejects(f.runner.upload(next.plan.id, digest(next.plan)), /reconciliation/);
  await f.runner.resume(p.plan.id);
  f.uploadMode('immediate'); await f.runner.upload(next.plan.id, digest(next.plan));
  const duplicate = await f.prepare({ description: 'another plan for the same version' });
  await assert.rejects(f.runner.upload(duplicate.plan.id, digest(duplicate.plan)), /newer than all uploaded/);
  assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 2);
});

test('cancelled task is terminal; resume and upload do not silently retry', async (t) => {
  const f = await fixture(t), p = await f.prepare(); await f.runner.upload(p.plan.id, digest(p.plan)); f.taskMode('cancelled');
  const cancelled = await f.runner.resume(p.plan.id); assert.equal(cancelled.status, 'cancelled');
  await f.runner.resume(p.plan.id); await f.runner.upload(p.plan.id, digest(p.plan));
  assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 1);
  const replacement = await f.prepare({ description: 'different plan, same cancelled version' });
  await assert.rejects(f.runner.upload(replacement.plan.id, digest(replacement.plan)), /already has an operation|already bound/);
});

test('successful version authority survives descending plans, later failure and a fresh runner', async (t) => {
  for (const unverified of [false, true]) await t.test(String(unverified), async (t) => {
    const f = await fixture(t), older = await f.prepare(), newer = await f.prepare({ version: '1.22.6' });
    await f.runner.upload(newer.plan.id, digest(newer.plan));
    if (unverified) f.invalidate();
    assert.equal((await f.runner.resume(newer.plan.id)).status, unverified ? 'uploaded-unverified' : 'uploaded');
    // A subsequent cancelled operation must not replace the successful version floor.
    if (!unverified) {
      const later = await f.prepare({ version: '1.22.7' });
      await f.runner.upload(later.plan.id, digest(later.plan)); f.taskMode('cancelled'); await f.runner.resume(later.plan.id);
    }
    // Restore the trusted hook to isolate version admission from receipt rejection.
    const fresh = await createWechatRunner({ ...f.options, project: { ...f.project, revalidate: async () => {} } });
    const before = f.calls.filter((x) => x.tool === 'upload').length;
    await assert.rejects(fresh.upload(older.plan.id, digest(older.plan)), /newer than all uploaded/);
    assert.equal(f.calls.filter((x) => x.tool === 'upload').length, before);
  });
});

test('two runners cannot concurrently write the same AppID within one selected state store', async (t) => {
  const f = await fixture(t), p = await f.prepare();
  let entered, finish;
  const active = new Promise((resolve) => entered = resolve), gate = new Promise((resolve) => finish = resolve);
  const command = async (bin, args, options) => {
    if (args[2] === 'upload') { entered(); await gate; }
    return f.command(bin, args, options);
  };
  const first = await createWechatRunner({ ...f.options, command });
  const second = await createWechatRunner({ ...f.options, command });
  const pending = first.upload(p.plan.id, digest(p.plan));
  await active;
  try { await assert.rejects(second.upload(p.plan.id, digest(p.plan)), /lock exists/i); }
  finally { finish(); }
  await pending;
  assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 1);
});

test('wrong client/tool/task and ambiguous final responses cannot complete an upload', async (t) => {
  for (const kind of ['client', 'tool', 'task', 'nested-success']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    const command = async (bin, args, options) => {
      const output = await f.command(bin, args, options);
      if (args[2] === 'polling_task_result') {
        const payload = JSON.parse(output.stdout);
        if (kind === 'client') payload.clientName = 'Other';
        if (kind === 'tool') payload.tool = 'upload';
        if (kind === 'task') payload.result.taskId = 'another_task';
        if (kind === 'nested-success') delete payload.result.result.success;
        return { ...output, stdout: JSON.stringify(payload) };
      }
      return output;
    };
    const runner = await createWechatRunner({ ...f.options, command }), p = await f.prepare();
    await runner.upload(p.plan.id, digest(p.plan));
    await assert.rejects(runner.resume(p.plan.id));
    assert.equal((await runner.status(p.plan.id)).status, 'pending-confirmation');
  });
});

test('official success with changed local evidence is retained as uploaded-unverified', async (t) => {
  const f = await fixture(t), p = await f.prepare(); await f.runner.upload(p.plan.id, digest(p.plan));
  await writeFile(join(f.repo, 'dist/app.js'), 'changed while awaiting confirmation');
  const observed = await f.runner.resume(p.plan.id);
  assert.equal(observed.status, 'uploaded-unverified');
  assert.equal(summarizeWechat(observed).uploadCompleted, true); assert.equal(summarizeWechat(observed).artifactVerified, false);
});

test('confirmed success is durable while post-validation is stalled and can resume without a provider call', async (t) => {
  for (const mode of ['immediate', 'resume']) {
    const f = await fixture(t), p = await f.prepare();
    let validations = 0, entered, finish;
    const active = new Promise((resolve) => entered = resolve), gate = new Promise((resolve) => finish = resolve);
    const project = { ...f.project, revalidate: async () => { if (++validations === 2) { entered(); await gate; throw new Error('Synthetic settled verification failure'); } } };
    const runner = await createWechatRunner({ ...f.options, project });
    if (mode === 'immediate') f.uploadMode('immediate');
    else await runner.upload(p.plan.id, digest(p.plan));
    const running = mode === 'immediate' ? runner.upload(p.plan.id, digest(p.plan)) : runner.resume(p.plan.id);
    await active;
    const fresh = await createWechatRunner(f.options);
    const saved = await fresh.status(p.plan.id);
    assert.equal(saved.status, 'uploaded-unverified'); assert.equal(saved.observation.status, 'success');
    try { await assert.rejects(fresh.resume(p.plan.id), /Execution lock exists/); }
    finally { finish(); }
    assert.equal((await running).status, 'uploaded-unverified');
    const calls = f.calls.length;
    assert.equal((await fresh.resume(p.plan.id)).status, 'uploaded');
    assert.equal(f.calls.length, calls);
  }
});

test('a real controller crash after confirmation retains success and requires owned-lock recovery', async (t) => {
  const f = await fixture(t), p = await f.prepare();
  const child = `
    const [repo,store,projectJson,id,approval,time,moduleUrl,commandUrl] = process.argv.slice(1);
    const {createWechatRunner} = await import(moduleUrl), {runCommand} = await import(commandUrl);
    let validations=0;
    const project={...JSON.parse(projectJson),validate:async()=>{},revalidate:async()=>{if(++validations===2)process.exit(77);}};
    const command=async(bin,args,options)=>{
      if(bin==='git')return runCommand(bin,args,options);
      const result=args[2]==='upload'?{success:true,status:'success',result:{success:true}}:{success:true,skillVersion:'0.3.11',versionRelation:'equal',loginExpired:false,tokenRequired:false};
      return {exitCode:0,stdout:JSON.stringify({ok:true,tool:args[2],clientName:'Codex',result})};
    };
    const runner=await createWechatRunner({repo,store,project,command,now:()=>Number(time)});
    await runner.upload(id,approval);
  `;
  await assert.rejects(runCommand(process.execPath, ['--input-type=module', '-e', child, f.repo, f.store, JSON.stringify(f.project), p.plan.id, digest(p.plan), String(time), new URL('./wechat.mjs', import.meta.url).href, new URL('./command.mjs', import.meta.url).href]), (error) => error.exitCode === 77);
  const fresh = await createWechatRunner(f.options);
  assert.equal((await fresh.status(p.plan.id)).status, 'uploaded-unverified');
  await assert.rejects(fresh.resume(p.plan.id), /Execution lock exists/);
  // This synthetic controller has exited and its Git children were awaited;
  // model explicit operator recovery of only its owned temporary locks.
  await rm(join(f.repo, '.git/release-kit-wechat/initialization.lock'));
  await rm(join(f.store, `wechat/target-${digest(appId)}.lock`));
  assert.equal((await fresh.resume(p.plan.id)).status, 'uploaded');
  assert.equal(f.calls.length, 0);
});

test('hook-originated post-success cleanup uncertainty retains the provider result and admission exclusion', async (t) => {
  for (const mode of ['immediate', 'resume']) for (const fenceFails of [false, true]) {
    const f = await fixture(t), p = await f.prepare();
    let validations = 0;
    const project = { ...f.project, revalidate: async () => {
      if (++validations === 2) {
        if (fenceFails) await writeFile(join(f.store, 'locks'), 'synthetic fence creation failure');
        throw Object.assign(new Error('Synthetic unsettled validation child'), { cleanupIncomplete: true });
      }
    } };
    const runner = await createWechatRunner({ ...f.options, project });
    if (mode === 'immediate') f.uploadMode('immediate');
    if (mode === 'resume') await runner.upload(p.plan.id, digest(p.plan));
    await assert.rejects(mode === 'resume' ? runner.resume(p.plan.id) : runner.upload(p.plan.id, digest(p.plan)), { cleanupIncomplete: true });
    const saved = await runner.status(p.plan.id);
    assert.equal(saved.status, 'uploaded-unverified'); assert.equal(saved.observation.status, 'success');
    assert.equal(summarizeWechat(saved).uploadCompleted, true);
    if (fenceFails) await assert.rejects(lstat(join(f.store, 'locks/cleanup-incomplete.lock')), { code: 'ENOTDIR' });
    else await lstat(join(f.store, 'locks/cleanup-incomplete.lock'));
    const fresh = await createWechatRunner(f.options);
    await assert.rejects(fresh.resume(p.plan.id), /Execution lock exists/);
    assert.equal(f.calls.filter((call) => call.tool === 'upload').length, 1);
  }
});

test('redirected artifacts and contradictory current state are rejected', async (t) => {
  const f = await fixture(t), p = await f.prepare();
  await symlink(join(f.repo, 'source.txt'), join(f.repo, 'dist/redirect.js'));
  await assert.rejects(f.runner.upload(p.plan.id, digest(p.plan)), /artifact|redirect/i);
  for (const patch of [{ status: 'uploaded' }, { status: 'pending-confirmation' }, { publication: 'no upload occurred' }]) {
    assert.throws(() => assertWechatState({ ...p, ...patch }));
  }
  const { id: _id, ...identity } = p.plan;
  const unsafe = { ...identity, repository: 'https://SYNTHETIC_SECRET@example.invalid/repo.git' };
  assert.throws(() => assertWechatState({ ...p, plan: { id: `wechat-${digest(unsafe).slice(0, 24)}`, ...unsafe } }), /credential-free/);
  const bad = { ...p, status: 'uploaded' };
  await saveState(join(f.store, 'wechat/operations', p.plan.id), bad);
  await assert.rejects(f.runner.status(p.plan.id), /observation/);
});

test('cleanup uncertainty uses the shared durable fence across runner instances', async (t) => {
  const f = await fixture(t), p = await f.prepare(); f.uploadMode('cleanup');
  await assert.rejects(f.runner.upload(p.plan.id, digest(p.plan)), /cleanup|unconfirmed/i);
  const fresh = await createWechatRunner(f.options);
  await assert.rejects(fresh.resume(p.plan.id), /cleanup|unconfirmed|Execution lock exists/i);
  assert.equal(f.calls.filter((x) => x.tool === 'upload').length, 1);
});

test('target exclusion survives cleanup uncertainty even when the initial fence cannot be created', async (t) => {
  const f = await fixture(t), p = await f.prepare();
  const child = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [repo,store,projectJson,id,approval,time,moduleUrl,commandUrl] = process.argv.slice(1);
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      if (String(args[0]).endsWith('cleanup-incomplete.lock') && args[1] === 'wx') throw Object.assign(new Error('Synthetic full disk'),{code:'ENOSPC'});
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    const {createWechatRunner} = await import(moduleUrl), {runCommand} = await import(commandUrl);
    const project = {...JSON.parse(projectJson),validate:async()=>{},revalidate:async()=>{}};
    const command = async (bin,args,options) => {
      if(bin==='git') return runCommand(bin,args,options);
      if(args[2]==='upload') throw Object.assign(new Error('Unsettled process'),{cleanupIncomplete:true});
      return {exitCode:0,stdout:JSON.stringify({ok:true,tool:args[2],clientName:'Codex',result:{success:true,skillVersion:'0.3.11',versionRelation:'equal',loginExpired:false,tokenRequired:false}})};
    };
    const runner = await createWechatRunner({repo,store,project,command,now:()=>Number(time)});
    try { await runner.upload(id,approval); throw new Error('unexpected success'); }
    catch(error) { if(!error.cleanupIncomplete) throw error; }
  `;
  await runCommand(process.execPath, ['--input-type=module', '-e', child, f.repo, f.store, JSON.stringify(f.project), p.plan.id, digest(p.plan), String(time), new URL('./wechat.mjs', import.meta.url).href, new URL('./command.mjs', import.meta.url).href]);
  await assert.rejects(readFile(join(f.store, 'locks/cleanup-incomplete.lock')), { code: 'ENOENT' });
  const fresh = await createWechatRunner(f.options);
  await assert.rejects(fresh.resume(p.plan.id), /Execution lock exists/);
});

test('CLI never conflates prepare/status observation with pending upload completion', async (t) => {
  const f = await fixture(t), current = join(f.store, 'current.json');
  await writeFile(current, JSON.stringify(observation));
  // Fixed clock is supplied to the library tests; CLI uses an actual fresh owner observation.
  await writeFile(current, JSON.stringify({ ...observation, observedAt: new Date().toISOString() }));
  let result;
  const options = { repo: f.repo, wechatProject: f.project, command: f.command, output: (s) => result = JSON.parse(s) };
  assert.equal(await main({ ...options, args: ['wechat', 'prepare', '--state-dir', f.store, '--ref', 'HEAD', '--version', '1.22.5', '--current', current] }), 0);
  const id = result.plan.id;
  assert.equal(await main({ ...options, args: ['wechat', 'upload', id, '--state-dir', f.store, '--approve', result.approvalDigest] }), 2);
  assert.equal(result.summary.uploadCompleted, false);
  assert.equal(await main({ ...options, args: ['wechat', 'status', id, '--state-dir', f.store] }), 0);
  assert.equal(result.summary.state, 'pending-confirmation');
});
