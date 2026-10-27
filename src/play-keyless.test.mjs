import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doctorStore, inspectStore, contentSession } from './stores.mjs';
import { inspectProviders } from './inspection.mjs';

const sourceToken = 'source-token-SENTINEL';
const targetToken = 'target-token-SENTINEL';
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'keyless-play-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = Date.now();
  const calls = [], commands = [];
  const auth = { type: 'gcloud-impersonation', account: 'operator@example.com',
    serviceAccount: 'publisher@example-project.iam.gserviceaccount.com',
    configurationDirectoryEnv: 'GOOGLE_CLI_CONFIG' };
  const ctx = {
    platform: 'android', now: () => time,
    env: { GOOGLE_CLI_CONFIG: directory, PATH: process.env.PATH,
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'unrelated-token', CLOUDSDK_CORE_ACCOUNT: 'wrong@example.com' },
    plan: { appIds: { android: 'com.example.app' } },
    config: { stores: { android: { packageName: 'com.example.app', managedPublishingDisabled: true, auth } } },
    command: async (bin, args, opts) => { commands.push({ bin, args, opts }); return { code: 0, stdout: sourceToken+'\n' }; },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (url.startsWith('https://iamcredentials.googleapis.com/')) {
        assert.equal(opts.headers.Authorization, 'Bearer '+sourceToken);
        assert.deepEqual(JSON.parse(opts.body), {scope:['https://www.googleapis.com/auth/androidpublisher'], lifetime:'3600s'});
        return ok({ accessToken: targetToken, expireTime: new Date(time+3600000).toISOString() });
      }
      assert.equal(opts.headers.Authorization, 'Bearer '+targetToken);
      return ok({ releases: [] });
    },
  };
  return { ctx, auth, calls, commands, advance: () => { time+=3600000; } };
}

test('keyless provider inspection uses explicit accounts, IAM scope and secret-safe command output', async t => {
  const f = await fixture(t);
  const report = await inspectStore(f.ctx);
  assert.equal(report.ok, true);
  assert.equal(report.publicationReadiness, 'not-evaluated');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/publisher%40example-project.iam.gserviceaccount.com:generateAccessToken');
  assert.equal(f.calls[1].opts.method ?? 'GET', 'GET');
  const command = f.commands[0];
  assert.equal(command.bin, 'gcloud');
  assert.deepEqual(command.args, ['auth','print-access-token','--account','operator@example.com','--quiet']);
  assert.equal(command.opts.sensitive, true);
  assert.equal(command.opts.diagnostics, false);
  assert.equal(command.opts.maxBuffer, 32768);
  assert.equal(command.opts.env.CLOUDSDK_CONFIG, f.ctx.env.GOOGLE_CLI_CONFIG);
  assert.equal(command.opts.env.CLOUDSDK_AUTH_ACCESS_TOKEN, undefined);
  assert.equal(command.opts.env.CLOUDSDK_CORE_ACCOUNT, undefined);
  assert.equal(command.opts.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, '');
  assert.doesNotMatch(JSON.stringify(report), /SENTINEL/);
});

test('doctor reports local prerequisites without authentication or provider calls', async t => {
  const f = await fixture(t);
  const report = await doctorStore(f.ctx);
  assert.equal(report.checks.every(x => x.ok), true);
  assert.match(report.checks[1].message, /have not been tested/);
  assert.equal(f.commands.length+f.calls.length, 0);
});

test('content and publishing transport refresh keyless credentials before next request, never replay a write', async t => {
  const f = await fixture(t);
  const session = await contentSession(f.ctx);
  await session.read('tracks/production/releases');
  await session.read('tracks/production/releases');
  assert.equal(f.commands.length, 1);
  f.advance();
  await session.read('tracks/production/releases');
  assert.equal(f.commands.length, 2);
  assert.equal(f.calls.filter(x => x.url.includes('iamcredentials')).length, 2);
  assert.equal(f.calls.filter(x => !x.url.includes('iamcredentials')).length, 3);
});

test('invalid, mixed or implicit auth configurations fail before CLI and network', async t => {
  for (const change of [
    f => { f.ctx.config.stores.android.serviceAccountPathEnv = 'KEY'; },
    f => { f.auth.type = 'unknown'; },
    f => { delete f.auth.account; },
    f => { f.auth.account = '--help'; },
    f => { f.auth.serviceAccount = 'bad/target'; },
    f => { f.auth.gcloudBinary = './gcloud'; },
    f => { f.ctx.env.GOOGLE_CLI_CONFIG = 'relative'; },
  ]) {
    const f = await fixture(t); change(f);
    assert.equal((await inspectStore(f.ctx)).ok, false);
    assert.equal(f.commands.length+f.calls.length, 0);
  }
});

test('CLI errors, malformed tokens and IAM denial do not leak secrets or call Play', async t => {
  for (const mode of ['throw','empty','multiline','nonzero','denied','bad-expiry','bad-token']) {
    const f = await fixture(t);
    f.ctx.command = async () => {
      if (mode==='throw') throw new Error(sourceToken);
      return {code:mode==='nonzero'?1:0, stdout:mode==='empty'?'':mode==='multiline'?'warning\n'+sourceToken:sourceToken};
    };
    f.ctx.fetch = async (url, opts) => {
      f.calls.push({url,opts});
      if (mode==='denied') return {ok:false,status:403,json:async()=>({error:{code:403,status:'PERMISSION_DENIED',message:sourceToken}})};
      return ok({accessToken:mode==='bad-token'?'bad\nsecret':targetToken,expireTime:mode==='bad-expiry'?'invalid':new Date(Date.now()+3600000).toISOString()});
    };
    const report=await inspectStore(f.ctx);
    assert.equal(report.ok,false,mode);
    assert.doesNotMatch(JSON.stringify(report),/SENTINEL/);
    assert.ok(f.calls.every(x=>x.url.startsWith('https://iamcredentials.googleapis.com/')));
  }
});

test('expired or aborted authentication cannot advance to a provider request', async t => {
  const f = await fixture(t); const abort = new AbortController(); f.ctx.signal = abort.signal;
  f.ctx.command = async()=>{abort.abort();return {code:0,stdout:sourceToken};};
  await assert.rejects(inspectStore(f.ctx));
  assert.equal(f.calls.length,0);
});


test('provider-inspect passes the guarded command runner without a release artifact', async t => {
  const f = await fixture(t);
  const repo = f.ctx.env.GOOGLE_CLI_CONFIG;
  await writeFile(path.join(repo, 'app.json'), JSON.stringify({expo:{version:'1.0.0',android:{package:'com.example.app'}}}));
  const result = await inspectProviders({repo, config:f.ctx.config, platforms:['android'],
    environment:f.ctx.env, command:f.ctx.command,
    inspector: ctx => inspectStore({...ctx,fetch:f.ctx.fetch})});
  assert.equal(result.ok,true);
  assert.equal(f.commands.length,1);
  assert.doesNotMatch(JSON.stringify(result),/SENTINEL/);
});

test('keyless session refuses Play writes after authentication denial', async t => {
  const f = await fixture(t);
  f.ctx.command=async()=>{throw new Error(sourceToken);};
  await assert.rejects(contentSession(f.ctx),/authentication failed/);
  assert.equal(f.calls.length,0);
});


test('IAM 404 during refresh is never exposed as a missing Play resource', async t => {
  const f=await fixture(t);
  const session=await contentSession(f.ctx);
  f.advance();
  f.ctx.fetch=async()=>({ok:false,status:404,json:async()=>({error:{code:404,status:'NOT_FOUND'}})});
  await assert.rejects(session.read('edits/live-edit'), error => {
    assert.equal(error.status,undefined);
    assert.equal(error.preparedEditUnavailable,undefined);
    assert.match(error.message,/impersonation failed/);
    return true;
  });
});


test('unconfirmed CLI cleanup propagates through inspection and stops later platforms', async t => {
  const f=await fixture(t); const repo=f.ctx.env.GOOGLE_CLI_CONFIG;
  await writeFile(path.join(repo,'app.json'),JSON.stringify({expo:{version:'1.0.0',android:{package:'com.example.app'},ios:{bundleIdentifier:'com.example.app'}}}));
  let inspected=0;
  f.ctx.command=async()=>{throw Object.assign(new Error(sourceToken),{cleanupIncomplete:true});};
  await assert.rejects(inspectProviders({repo,config:f.ctx.config,platforms:['android','ios'],environment:f.ctx.env,command:f.ctx.command,
    inspector:ctx=>{inspected++;return inspectStore({...ctx,fetch:f.ctx.fetch});}}),error=>{
      assert.equal(error.cleanupIncomplete,true); assert.doesNotMatch(error.message,/SENTINEL/); return true;
    });
  assert.equal(inspected,1); assert.equal(f.calls.length,0);
});
