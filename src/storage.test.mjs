import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, lstat, open, opendir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStorage, planStorageCleanup } from './storage.mjs';
import { saveState, releasePath, loadState } from './state.mjs';
import { main } from './cli.mjs';

const id = suffix => 'release-' + suffix.repeat(24);
const state = suffix => ({ schemaVersion: 1, plan: { id: id(suffix), source: suffix.repeat(40), platforms: ['ios'] },
  stages: {}, artifacts: {}, outcomes: {}, checkpoints: {} });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'state'); await mkdir(store);
  return { root, store };
}
async function file(path, data) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, data); }
async function tree(root, path = '') {
  const result = [];
  for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const rel = join(path, entry.name);
    result.push(entry.isDirectory() ? [rel, 'directory'] : [rel, entry.isSymbolicLink() ? 'link' : (await readFile(join(root, rel))).toString('base64')]);
    if (entry.isDirectory()) result.push(...await tree(root, rel));
  }
  return result;
}

test('two release formats inventory bytes and preview without project imports or state writes', async t => {
  const { root, store } = await fixture(t);
  for (const [suffix, kind] of [['a', undefined], ['b', 'consumer-testflight-v1']]) {
    const s = state(suffix); if (kind) s.plan.kind = kind;
    await saveState(releasePath(store, s.plan.id), s);
    await file(join(releasePath(store, s.plan.id), 'validation/node_modules/dependency.bin'), '123456789');
    await file(join(releasePath(store, s.plan.id), 'build-ios/output.bin'), 'abcd');
  }
  const before = await tree(root);
  const inventory = await inspectStorage({ stateDirectory: store });
  assert.equal(inventory.observationComplete, true);
  assert.equal(inventory.workspaces.length, 4);
  assert.equal(inventory.workspaces.find(w=>w.path.endsWith('build-ios')).apparentBytes, 4);
  assert.equal(inventory.releases.every(r=>r.verifiedEvents===1), true);
  const preview = planStorageCleanup(inventory);
  assert.equal(preview.counts.reviewCandidates, 4); assert.equal(preview.applySupported, false);
  assert.equal(preview.deletionAuthorized, false); assert.equal(preview.reclaimableBytes, null);
  assert.deepEqual(planStorageCleanup(inventory), preview);
  let printed;
  assert.equal(await main({args:['storage-plan','--state-dir',store],repo:'/absent', project:{},
    command:()=>{throw Error('unexpected execution');},output:s=>printed=JSON.parse(s)}),0);
  assert.equal(printed.kind,'release-storage-cleanup-preview-v1');
  assert.deepEqual(await tree(root), before);
});

test('all retained snapshots and other releases protect referenced workspace descendants and ancestors', async t => {
  const { store } = await fixture(t); const a=state('a'), b=state('b');
  const directory=releasePath(store,a.plan.id), workspace=join(directory,'validation');
  await file(join(workspace,'evidence/proof.bin'),'proof');
  a.acceptance={ios:{path:join(workspace,'evidence/proof.bin')}};await saveState(directory,a);
  delete a.acceptance;await saveState(directory,a);
  b.evidenceRoot=directory;await saveState(releasePath(store,b.plan.id),b);
  const inventory=await inspectStorage({stateDirectory:store});
  assert.equal(inventory.observationComplete,true);
  assert.deepEqual(inventory.workspaces[0].referencedBy,[id('a'),id('b')]);
  assert(inventory.releases.every(release=>release.referenceScopeResolved));
  assert(inventory.workspaces[0].protectionReasons.includes('retained-journal-reference'));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
});

test('literal missing/external and ambiguous relative paths conservatively prevent review candidates', async t => {
  for (const value of ['/external/proof','relative/proof','file:///external/proof',null]) {
    const {store}=await fixture(t);const s=state('a');
    s.acceptance={path:value??join(store,'missing-proof')};await saveState(releasePath(store,s.plan.id),s);
    await file(join(releasePath(store,s.plan.id),'validation/cache'),'cache');
    const inventory=await inspectStorage({stateDirectory:store});
    assert(inventory.workspaces[0].protectionReasons.includes('journal-reference-scope-unresolved'));
    assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
  }
});

test('unknown operations and on-disk ownership remain protected, including empty lock files', async t => {
  for (const marker of ['locks/cleanup-incomplete.lock','dispatch/requests/pending/request.json','targets/reservation.json']) {
    const {store}=await fixture(t);const s=state('a');await saveState(releasePath(store,s.plan.id),s);
    await file(join(releasePath(store,s.plan.id),'build-ios/output'),'bytes');await file(join(store,marker),'');
    const result=await inspectStorage({stateDirectory:store});
    assert.equal(result.observationComplete,true);assert.equal(planStorageCleanup(result).counts.reviewCandidates,0);
    assert(result.workspaces[0].protectionReasons.length);
  }
  const {store}=await fixture(t);const s=state('a');s.stages.build={status:'unknown'};
  await saveState(releasePath(store,s.plan.id),s);await file(join(releasePath(store,s.plan.id),'build-ios/cache'),'x');
  assert((await inspectStorage({stateDirectory:store})).workspaces[0].protectionReasons.includes('release-operations-unsettled-or-unrecognized'));
});

test('corrupt event integrity disables candidates and follows the same rule as normal journal replay', async t => {
  const {store}=await fixture(t);const s=state('a');const directory=releasePath(store,s.plan.id);
  await saveState(directory,s);await file(join(directory,'validation/cache'),'x');
  const event=join(directory,'events/00000001.json');const raw=JSON.parse(await readFile(event));raw.state.changed=true;await writeFile(event,JSON.stringify(raw));
  await assert.rejects(loadState(directory),/integrity mismatch/);
  const result=await inspectStorage({stateDirectory:store});assert.equal(result.observationComplete,false);
  assert.equal(planStorageCleanup(result).counts.reviewCandidates,0);assert(result.errors.some(e=>e.code==='journal-invalid'));
});

test('symlink targets are not traversed or measured and workspace links remain opaque', async t => {
  const {root,store}=await fixture(t);const s=state('a');await saveState(releasePath(store,s.plan.id),s);
  const workspace=join(releasePath(store,s.plan.id),'validation');await mkdir(workspace);
  await file(join(root,'external-secret'),'not to be measured');await symlink(root,join(workspace,'outside'));
  const result=await inspectStorage({stateDirectory:store});assert.equal(result.observationComplete,true);
  assert.equal(result.workspaces[0].apparentBytes,0);assert.equal(result.totals.symlinks,1);
  assert(result.workspaces[0].protectionReasons.includes('contains-opaque-symlinks'));
  const alias=join(root,'alias');await symlink(store,alias);
  await assert.rejects(inspectStorage({stateDirectory:alias}),/symlink/);
});

test('hard-linked bytes are counted logically per path but allocations are unique and not reclaimable estimates', async t => {
  const {store}=await fixture(t);await file(join(store,'one'),'0123456789');await link(join(store,'one'),join(store,'two'));
  const result=await inspectStorage({stateDirectory:store});assert.equal(result.totals.apparentBytes,20);
  assert.equal(result.totals.hardLinkedFiles,2);assert.equal(result.reclaimableBytes,null);
  const single=await lstat(join(store,'one'));
  assert.equal(result.totals.observedUniqueAllocatedBytes, Number.isSafeInteger(single.blocks) ? single.blocks*512 : null);
});

test('entry and journal byte budgets return partial reports without review candidates', async t => {
  const {store}=await fixture(t);const s=state('a');await saveState(releasePath(store,s.plan.id),s);
  await file(join(releasePath(store,s.plan.id),'validation/cache'),'x');
  const result=await inspectStorage({stateDirectory:store,maxEntries:3});assert.equal(result.observationComplete,false);
  assert(result.errors.some(e=>e.code==='entry-budget-exhausted'));assert.equal(planStorageCleanup(result).counts.reviewCandidates,0);
  await writeFile(join(releasePath(store,s.plan.id),'events/00000001.json'),'x'.repeat(8*1024*1024+1));
  const oversized=await inspectStorage({stateDirectory:store});assert.equal(oversized.observationComplete,false);
  assert(oversized.errors.some(e=>e.code==='journal-byte-budget-exhausted'));
});

test('missing roots and invalid CLI inputs do not create directories; cancellation never returns a report', async t => {
  const {root,store}=await fixture(t);await assert.rejects(inspectStorage({stateDirectory:join(root,'absent')}));
  assert(!(await readdir(root)).includes('absent'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(inspectStorage({stateDirectory:store,signal:controller.signal}),{name:'AbortError'});
  let help;assert.equal(await main({args:['storage-inspect','--help'],output:s=>help=s}),0);assert.match(help,/no deletion/);
  for (const extra of [['--apply'],['--publish'],['--config','/private/config'],['release-123'],['--max-entries','10000001'],['--timeout-seconds','301']])
    await assert.rejects(main({args:['storage-plan','--state-dir',store,...extra],output:()=>{}}));
});

test('deep workspaces cannot starve other release journals or immediate ownership markers', async t => {
  const {root,store}=await fixture(t),a=state('a'),b=state('b');
  const workspace=join(releasePath(store,a.plan.id),'validation');
  for(let i=0;i<80;i++) await file(join(workspace,`cache-${i}`),'cache');
  b.evidenceRoot=join(workspace,'cache-79');
  await saveState(releasePath(store,a.plan.id),a);
  await saveState(releasePath(store,b.plan.id),b);
  await file(join(releasePath(store,b.plan.id),'build-ios/output'),'build');
  await file(join(store,'targets/owner.json'),'ownership');
  const before=await tree(root);
  const inventory=await inspectStorage({stateDirectory:store,maxEntries:30});
  assert.equal(inventory.observationComplete,false);
  assert(inventory.errors.some(e=>e.code==='entry-budget-exhausted'));
  assert.equal(inventory.releases.length,2);
  assert(inventory.releases.every(release=>release.verifiedEvents===1));
  assert.equal(inventory.workspaces.length,2);
  assert(inventory.workspaces.every(w=>w.protectionReasons.includes('inventory-incomplete')&&w.protectionReasons.includes('target-ownership-present')));
  assert(inventory.workspaces.find(w=>w.kind==='validation').referencedBy.includes(b.plan.id));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
  assert.deepEqual(await tree(root),before);
});

test('missing and corrupt journals stay unresolved even when a workspace exhausts measurement', async t => {
  const {store}=await fixture(t),a=state('a'),b=state('b'),c=state('c');
  await saveState(releasePath(store,a.plan.id),a);
  await saveState(releasePath(store,b.plan.id),b);
  await writeFile(join(releasePath(store,b.plan.id),'events/00000001.json'),'{}');
  await file(join(releasePath(store,c.plan.id),'logs/old.log'),'log');
  for(let i=0;i<80;i++) await file(join(releasePath(store,a.plan.id),'validation',`cache-${i}`),'cache');
  const inventory=await inspectStorage({stateDirectory:store,maxEntries:30});
  assert.equal(inventory.releases.find(r=>r.releaseId===a.plan.id).verifiedEvents,1);
  for(const releaseId of [b.plan.id,c.plan.id]) {
    const release=inventory.releases.find(r=>r.releaseId===releaseId);
    assert.equal(release.verifiedEvents,0);
    assert.equal(release.referenceScopeResolved,false);
  }
  for(const code of ['journal-invalid','journal-missing','entry-budget-exhausted']) assert(inventory.errors.some(e=>e.code===code));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
});

test('a workspace replaced by a symlink between journal and measurement phases is not traversed', async t => {
  const {root,store}=await fixture(t),s=state('a'),dir=releasePath(store,s.plan.id);
  await saveState(dir,s);
  const workspace=join(dir,'validation');await file(join(workspace,'cache'),'cache');
  const outside=join(root,'outside');await file(join(outside,'secret'),'synthetic external bytes');
  const event=join(dir,'events/00000001.json');
  const handle=await open(event,'r'),prototype=Object.getPrototypeOf(handle);await handle.close();
  const read=prototype.read;let replaced=false;
  t.mock.method(prototype,'read',async function(...args){
    const result=await read.apply(this,args);
    if(result.bytesRead&&!replaced){replaced=true;await rm(workspace,{recursive:true});await symlink(outside,workspace);}
    return result;
  });
  const inventory=await inspectStorage({stateDirectory:store});
  assert(replaced);assert.equal(inventory.observationComplete,false);
  assert.equal(inventory.releases[0].verifiedEvents,1);
  assert.equal(inventory.workspaces[0].apparentBytes,0);
  assert(inventory.errors.some(e=>e.code==='directory-changed'&&e.path.endsWith('/validation')));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
});

test('larger explicit scans remain bounded through both the API and CLI', async t => {
  const {store}=await fixture(t);await file(join(store,'small'),'123');
  for(const maxEntries of [1000001,10000000]) {
    assert.equal((await inspectStorage({stateDirectory:store,maxEntries})).observationComplete,true);
    let report;
    assert.equal(await main({args:['storage-inspect','--state-dir',store,'--max-entries',String(maxEntries)],output:s=>report=JSON.parse(s)}),0);
    assert.equal(report.totals.apparentBytes,3);
  }
  await assert.rejects(inspectStorage({stateDirectory:store,maxEntries:10000001}),/entry budget/);
});

test('timeout during deferred measurement retains journal checks without claiming resolved deep references', async t => {
  const {store}=await fixture(t),s=state('a'),dir=releasePath(store,s.plan.id);
  const workspace=join(dir,'validation');await file(join(workspace,'cache'),'cache');
  s.evidenceRoot=join(workspace,'missing-proof');await saveState(dir,s);
  const handle=await opendir(workspace),prototype=Object.getPrototypeOf(handle);await handle.close();
  const descriptor=Object.getOwnPropertyDescriptor(prototype,Symbol.asyncIterator);
  const canonicalWorkspace=await realpath(workspace);let expired=false;
  // Restore the descriptor directly: Node 22's mock restore corrupts this symbol method.
  Object.defineProperty(prototype,Symbol.asyncIterator,{...descriptor,value:function(...args){
    if(this.path===canonicalWorkspace) expired=true;
    return descriptor.value.apply(this,args);
  }});
  t.mock.method(Date,'now',()=>expired?1000:0);
  let inventory;
  try { inventory=await inspectStorage({stateDirectory:store,timeoutMs:100}); }
  finally { Object.defineProperty(prototype,Symbol.asyncIterator,descriptor); }
  assert(expired);assert.equal(inventory.releases[0].verifiedEvents,1);
  assert.equal(inventory.releases[0].referenceScopeResolved,false);
  assert.equal(inventory.observationComplete,false);
  assert(inventory.errors.some(e=>e.code==='timeout'));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
});

test('metadata contents stay private while unrecognized directories remain outside cleanup candidates', async t => {
  const {store}=await fixture(t);const s=state('a');s.privateContact='synthetic-contact-value';s.password='synthetic-password-value';
  await saveState(releasePath(store,s.plan.id),s);
  await file(join(store,'unclassified/large.bin'),'12345');
  const result=await inspectStorage({stateDirectory:store});
  assert.equal(result.observationComplete,true);assert.equal(result.workspaces.length,0);
  assert(!JSON.stringify(result).includes('synthetic-contact-value'));assert(!JSON.stringify(result).includes('synthetic-password-value'));
  assert.equal(result.groups.find(group=>group.path==='unclassified').apparentBytes,5);
});

test('a linked journal and a missing event never become a complete absence or a review candidate', async t => {
  const {root,store}=await fixture(t);const s=state('a');const dir=releasePath(store,s.plan.id);
  await saveState(dir,s);await file(join(dir,'validation/cache'),'x');
  const event=join(dir,'events/00000001.json');const original=await readFile(event);await rm(event);
  await file(join(root,'outside-event'),original);await symlink(join(root,'outside-event'),event);
  const linked=await inspectStorage({stateDirectory:store});assert.equal(linked.observationComplete,false);
  assert.equal(planStorageCleanup(linked).counts.reviewCandidates,0);
  await rm(event);await file(join(dir,'events/00000002.json'),original);
  const missing=await inspectStorage({stateDirectory:store});assert.equal(missing.observationComplete,false);
  assert(missing.errors.some(error=>error.code==='journal-sequence-invalid'));
});

test('asynchronous caller cancellation stops before any report is emitted', async t => {
  const {store}=await fixture(t);const controller=new AbortController();let printed=false;
  const result=main({args:['storage-inspect','--state-dir',store],signal:controller.signal,output:()=>{printed=true;}});
  setImmediate(()=>controller.abort());
  await assert.rejects(result,{name:'AbortError'});assert.equal(printed,false);
});

test('pure preview rejects escaping and unrecognized workspace targets and incomplete replay stays protected', async t => {
  const {store}=await fixture(t);const s=state('a');await saveState(releasePath(store,s.plan.id),s);
  await file(join(releasePath(store,s.plan.id),'validation/cache'),'x');
  const inventory=await inspectStorage({stateDirectory:store});
  assert.equal(planStorageCleanup({...inventory,observationComplete:false}).counts.reviewCandidates,0);
  for(const path of ['/outside','../outside','releases/'+id('a')+'/arbitrary','releases/'+id('b')+'/validation']){
    const bad=structuredClone(inventory);bad.workspaces[0].path=path;
    await assert.throws(()=>planStorageCleanup(bad));
  }
});

test('independent project roots never share references, byte counts or preview state', async t => {
  const first=await fixture(t),second=await fixture(t);const a=state('a'),b=state('b');
  a.evidenceRoot='/external/protected';await saveState(releasePath(first.store,a.plan.id),a);
  await saveState(releasePath(second.store,b.plan.id),b);
  await file(join(releasePath(first.store,a.plan.id),'validation/cache'),'1234567');
  await file(join(releasePath(second.store,b.plan.id),'validation/cache'),'123');
  const protectedInventory=await inspectStorage({stateDirectory:first.store});
  const independentInventory=await inspectStorage({stateDirectory:second.store});
  assert.equal(protectedInventory.workspaces[0].apparentBytes,7);
  assert.equal(independentInventory.workspaces[0].apparentBytes,3);
  assert.equal(planStorageCleanup(protectedInventory).counts.reviewCandidates,0);
  assert.equal(planStorageCleanup(independentInventory).counts.reviewCandidates,1);
  assert.deepEqual(independentInventory.releases.map(r=>r.releaseId),[b.plan.id]);
});

test('a real journal writer growing a file during its bounded read disables the preview', async t => {
  const {store}=await fixture(t);const s=state('a'),dir=releasePath(store,s.plan.id);
  await saveState(dir,s);await file(join(dir,'validation/cache'),'x');
  const event=join(dir,'events/00000001.json'), originalBytes=await readFile(event);
  const handle=await open(event,'r'),prototype=Object.getPrototypeOf(handle);await handle.close();
  const read=prototype.read;let changed=false;
  t.mock.method(prototype,'read',async function(...args){
    const result=await read.apply(this,args);
    if(result.bytesRead && !changed){changed=true;await writeFile(event,Buffer.concat([originalBytes,Buffer.from(' ')]));}
    return result;
  });
  const inventory=await inspectStorage({stateDirectory:store});
  assert.equal(changed,true);assert.equal(inventory.observationComplete,false);
  assert(inventory.errors.some(error=>error.code==='journal-changed'));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
  assert.deepEqual(await readFile(event),Buffer.concat([originalBytes,Buffer.from(' ')]));
});

test('expired overall budget is partial rather than a late successful observation', async t => {
  const {store}=await fixture(t);let reads=0;
  t.mock.method(Date,'now',()=>reads++===0 ? 0 : 10);
  const inventory=await inspectStorage({stateDirectory:store,timeoutMs:1});
  assert.equal(inventory.observationComplete,false);assert(inventory.errors.some(error=>error.code==='timeout'));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
});

test('unsupported nested state shapes and stale availability never clear unknown operation protection', async t => {
  for(const field of ['stages','checkpoints','outcomes','artifacts']) {
    const {store}=await fixture(t);const s=state('a');s[field]={ios:true};
    await saveState(releasePath(store,s.plan.id),s);await file(join(releasePath(store,s.plan.id),'build-ios/cache'),'x');
    const inventory=await inspectStorage({stateDirectory:store});
    assert.equal(inventory.observationComplete,false);
    assert(inventory.errors.some(error=>error.code==='journal-schema-unsupported'));
    assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
  }
  const {store}=await fixture(t),s=state('a');
  s.testflight={build:{state:'unknown'},submission:{state:'finished'},apple:{availabilityVerified:true}};
  await saveState(releasePath(store,s.plan.id),s);await file(join(releasePath(store,s.plan.id),'build-ios/cache'),'x');
  const inventory=await inspectStorage({stateDirectory:store});assert.equal(inventory.observationComplete,true);
  assert(inventory.workspaces[0].protectionReasons.includes('release-operations-unsettled-or-unrecognized'));
  assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
});

test('redirected, dangling or invalid ownership roots cannot hide coordination state or expose target bytes', async t => {
  for (const name of ['locks','dispatch','targets']) {
    for (const variant of ['directory-link','dangling-link','regular-file']) {
      const {root,store}=await fixture(t);const s=state('a'),dir=releasePath(store,s.plan.id);
      await saveState(dir,s);await file(join(dir,'validation/cache'),'cache');
      const baseline=await inspectStorage({stateDirectory:store});
      assert.equal(planStorageCleanup(baseline).counts.reviewCandidates,1);
      const marker=join(store,name);
      if(variant==='regular-file') await writeFile(marker,'invalid root');
      else {
        const target=join(root,'external-ownership');
        if(variant==='directory-link') await file(join(target,'must-not-be-traversed'),'synthetic external ownership payload');
        await symlink(target,marker);
      }
      const before=await tree(root),inventory=await inspectStorage({stateDirectory:store});
      assert.equal(inventory.observationComplete,false,`${name}/${variant}`);
      assert(inventory.errors.some(error=>error.code==='ownership-root-unavailable'&&error.path===name));
      assert.equal(planStorageCleanup(inventory).counts.reviewCandidates,0);
      assert(inventory.workspaces[0].protectionReasons.includes('ownership-root-unavailable'));
      assert.equal(inventory.totals.apparentBytes,baseline.totals.apparentBytes+(variant==='regular-file' ? Buffer.byteLength('invalid root') : 0));
      assert.deepEqual(await tree(root),before);
    }
  }
});
