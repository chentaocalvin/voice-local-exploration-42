import assert from 'node:assert/strict';
import test from 'node:test';
import {explorationFixture} from './exploration_fixture.mjs';
import {memoryIndexedDB} from './memory_indexeddb.mjs';
import {createJointEngine} from '../../issue42/joint/engine.mjs';
import {createJointActions} from '../../issue42/joint/actions.mjs';
import {exportJointArchive,jointStorage} from '../../issue42/joint/archive.mjs';
import {enrollPrivateRun,openPrivateRun,privateRunReceipt} from '../../issue42/joint/private_run.mjs';
import {readPrivateSetup,privateSetupEngineOptions} from '../../issue42/joint/private_setup.mjs';
import {EXPLORATION_CAPS,EXPLORATION_PROFILE,HEADROOM_PROFILE,explorationProjectId} from '../../issue42/joint/exploration_profile.mjs';

const n=352800, frames=1601, interval=[22050,330750], listening={start:.5,end:7.5,mode:'local',selected:'E'};
function control(kind,items,preserve=[]) {
  return {preserve,intents:items.map(([feature,amount,mode='flat'])=>({kind:feature,amount,mode,held:false,
    start_frame:feature==='M'?(kind==='solo'?621:681):100,
    end_frame:feature==='M'?(kind==='solo'?870:1046):1500}))};
}
function maximum(kind) {return kind==='solo'?.5:.75;}
function matrixUpperBound(kind,profile) {
  const headroom=profile===HEADROOM_PROFILE;
  const active=7*44100;
  const prepare=8*n+n+2048*Math.ceil(n/220);
  const base=6*n+5*active+16*n;
  const motion=10*n+10*active;
  const spectral=n+3*2048*Math.ceil((n+1024)/220)+5*active;
  const neutral=6*n+16*n;
  const oneMotion=base+motion,oneSpectral=base+spectral+(headroom?24*n:0);
  const pair=base+motion+spectral+(headroom?24*n:0),qt=base+2*spectral+(headroom?48*n:0);
  const triple=base+motion+2*spectral+(headroom?48:24)*n;
  const render=3*neutral+6*oneMotion+12*oneSpectral+2*pair+qt+4*triple;
  const measure=26*(6*n+2*active),compare=24*12*n,save=2*(32*n+65536);
  const archive=2*Math.ceil((kind==='solo'?1024*1024:3*1024*1024)*3/2);
  return {prepare:2*prepare,render,measure,compare,save,archive,
    total:2*prepare+render+measure+compare+save+archive};
}

// The bounds are checked before constructing synthetic PCM or invoking even a
// substitute SDK. They count the frozen complete route, not arbitrary retries.
for(const profile of [EXPLORATION_PROFILE,HEADROOM_PROFILE])for(const kind of ['solo','piano'])assert.ok(matrixUpperBound(kind,profile).total<1_250_000_000);

for(const profile of [EXPLORATION_PROFILE,HEADROOM_PROFILE])test(`the complete ${profile} matrix preserves its cold ledger and fits every per-input cap`,async t=>{
  const realNow=Date.now;
  Date.now=()=>Date.parse('2026-11-07T13:00:00Z');
  t.after(()=>{Date.now=realNow;});
  const f=await explorationFixture(),db=memoryIndexedDB(),release='sdk0-private-matrix-'+profile;
  const signingKey=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const start=Date.now(),expires=start+7_200_000,sourceExpires=start+7_300_000;
  const {recipient}=await enrollPrivateRun(db,release,profile);
  const claims={schema:'voice-private-setup-v3',profile,release,
    solo:{...f.options.privateExploration.solo,expires:sourceExpires},
    piano:{...f.options.privateExploration.piano,expires:sourceExpires},
    run:{id:'4'.repeat(64),recipient,not_before:start,expires}};
  const payload=new TextEncoder().encode(JSON.stringify(claims));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey.privateKey,payload);
  const envelope=new Blob([JSON.stringify({payload:Buffer.from(payload).toString('base64url'),signature:Buffer.from(signature).toString('base64url')})]);
  assert.ok(envelope.size<=4096);
  const setup=await readPrivateSetup(envelope,signingKey.publicKey,release,start,{requireRun:true,expectedProfile:claims.profile});
  const bundles={};
  for(const kind of ['solo','piano']) {
    const input=structuredClone(f[kind]);
    input.payload=new TextEncoder().encode(JSON.stringify({...JSON.parse(new TextDecoder().decode(input.payload)),expires:sourceExpires}));
    input.signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey.privateKey,input.payload));
    bundles[kind]=await exportJointArchive({input,view:{kind:kind+'_input'}});
    assert.ok(bundles[kind].size<=(kind==='solo'?1024*1024:3*1024*1024));
  }
  const events=[],operations=[];
  let stage='initial',route;
  async function newRoute() {
    const run=await openPrivateRun(db,setup,()=>start);
    const reserve=async event=>{await run.reserve(event);events.push({...event,stage});};
    const engine=createJointEngine({sdk:f.options.sdk,publicKey:signingKey.publicKey,now:()=>start,
      ...privateSetupEngineOptions(setup),privateRunExpires:setup.run.expires,reserve});
    const actions=createJointActions(engine,db,{privateArchive:setup,resourceReserve:reserve});
    return {run,engine,actions};
  }
  const dispatch=message=>route.actions.dispatch(message);
  async function render(kind,name,draft,opened,compare=true) {
    stage=kind+':'+name;
    const result=await dispatch({type:'jointRender',draft});
    assert.equal(result.bytes.length,44+n*4);
    assert.equal(result.voiceBytes.length,44+n*4);
    operations.push({kind,name,type:'render',id:result.id,digest:result.sha256});
    if(compare)await compareVersion(kind,name,opened,result);
    return result;
  }
  async function compareVersion(kind,name,opened,result) {
    const report=await dispatch({type:'jointCompare',scope:{input_sha256:opened.input_sha256,
      axis:kind==='piano'?'full_mix':'vocal_only',interval,left:'U',left_sha256:opened.baseline.sha256,
      right:result.id,right_sha256:result.sha256}});
    assert.equal(report.core_summary.binding.versions[1].voice_sha256,result.voice_sha256);
    assert.equal(report.motion.periodic.status,'unknown');
    operations.push({kind,name,type:'compare',id:result.id});
    return report;
  }
  async function save(kind,role,result,draft) {
    stage=kind+':save-'+role;
    const projectId=explorationProjectId(setup.run.id,kind,role);
    const saved=await dispatch({type:'jointSave',projectId,saveRole:role,view:{resultId:result.id,draft,listening}});
    assert.equal(saved.id,projectId);operations.push({kind,type:'save',role,id:projectId});
    return projectId;
  }
  const seeds={};
  route=await newRoute();
  for(const kind of ['solo','piano']) {
    stage=kind+':open-B';
    const opened=await dispatch({type:kind==='solo'?'jointOpen':'jointOpenPiano',blob:bundles[kind]});
    operations.push({kind,type:'open',phase:'B'});
    for(const [feature,amount]of [['M',maximum(kind)],['Q',4],['T',9]])for(const sign of [-1,1]) {
      const result=await render(kind,'B-'+feature+(sign<0?'-':'+'),control(kind,[[feature,sign*amount]]),opened);
      assert.notEqual(result.sha256,opened.baseline.sha256);
    }
    // A synthetic pass advances this software route; it is no human acceptance.
    const draft=control(kind,[['M',maximum(kind)],['Q',4],['T',9]],[[0,100]]);
    const result=await render(kind,'MQT-seed',draft,opened,false);
    const id=await save(kind,'seed',result,draft);
    seeds[kind]={id,draft,digest:result.sha256,voiceDigest:result.voice_sha256};
  }
  const beforeCold=await route.run.report();
  for(const kind of ['solo','piano']) {
    assert.equal(beforeCold[kind].make_version,8);assert.equal(beforeCold[kind].compare,6);
    assert.equal(beforeCold[kind].save,1);assert.equal(beforeCold[kind].open,1);
  }
  route.engine.close();route=null;
  stage='common-cold-reopen';route=await newRoute();
  assert.deepEqual(await route.run.report(),beforeCold);
  for(const kind of ['solo','piano']) {
    stage=kind+':cold-seed';
    const opened=await dispatch({type:'jointReopen',projectId:seeds[kind].id});
    operations.push({kind,type:'open',phase:'cold'});
    assert.equal(opened.result.sha256,seeds[kind].digest);
    assert.equal(opened.result.voice_sha256,seeds[kind].voiceDigest);
    assert.deepEqual(opened.draft,seeds[kind].draft);
    await compareVersion(kind,'cold-MQT',opened,opened.result);
    const removed=kind==='solo'?'Q':'T';
    const remaining=seeds[kind].draft.intents.filter(item=>item.kind!==removed);
    await render(kind,'withdraw-'+removed,{intents:remaining,preserve:[[0,100]]},opened);
    assert.equal((await render(kind,'restore-'+removed,seeds[kind].draft,opened,false)).sha256,seeds[kind].digest);
    for(const [feature,amount]of [['M',.25],['Q',1],['T',3]])
      await render(kind,'weak-'+feature,control(kind,[[feature,amount]]),opened);
    for(const [feature,amount]of [['M',maximum(kind)],['Q',4],['T',9]])for(const mode of ['front','back','shift'])
      await render(kind,feature+'-'+mode,control(kind,[[feature,mode==='shift'?.25:amount,mode]]),opened);
    await render(kind,'other-pair',control(kind,kind==='solo'?[['M',maximum(kind)],['Q',4]]:[['M',maximum(kind)],['T',9]]),opened);
    await render(kind,'QT',control(kind,[['Q',4],['T',9]]),opened);
    const protectedResult=await render(kind,'protection-conflict',control(kind,[['M',maximum(kind)],['Q',4],['T',9]],[[0,100],[100,1500]]),opened);
    assert.equal(protectedResult.sha256,opened.baseline.sha256);
    const finalDraft=control(kind,[['M',maximum(kind)],['Q',.25,'shift'],['T',9]],[[0,100]]);
    const final=await render(kind,'MQT-Q-shift-final',finalDraft,opened);
    const id=await save(kind,'final',final,finalDraft);
    const beforeMetadata=await route.run.report();
    const metadata=await dispatch({type:'jointVersionRecord',resultId:final.id});
    assert.equal(metadata.feedback.status,'measured');
    const exported=await dispatch({type:'jointExport',view:{resultId:final.id,draft:finalDraft,listening}});
    assert.equal(exported.metadataOnly,true);assert.equal(exported.blob.type,'application/json');
    assert.equal(JSON.parse(await exported.blob.text()).result.sha256,final.sha256);
    assert.deepEqual(await route.run.report(),beforeMetadata);
    const stored=await jointStorage(db,'get',id);
    assert.equal(stored.view.feedback.binding.versions[1].sha256,final.sha256);
  }
  const counts=await route.run.report();
  for(const kind of ['solo','piano']) {
    assert.equal(counts[kind].make_version,28);assert.equal(counts[kind].compare,24);
    assert.equal(counts[kind].save,2);assert.equal(counts[kind].open,2);
    assert.equal(counts[kind].praat,2);assert.equal(counts[kind].world_analysis,2);assert.equal(counts[kind].synthesize,0);
    assert.equal(counts[kind].cpps,counts[kind].stft);assert.equal(counts[kind].hnr,counts[kind].stft);
    assert.ok(counts[kind].stft<=26);
    for(const [name,value]of Object.entries(counts[kind]))assert.ok(value<=EXPLORATION_CAPS[kind][name],kind+':'+name);
    assert.ok(counts[kind].audio_read<=matrixUpperBound(kind,profile).total);
    assert.equal(operations.filter(op=>op.kind===kind&&op.type==='render').length,25);
    assert.equal(operations.filter(op=>op.kind===kind&&op.type==='compare').length,24);
  }
  const receipt=await privateRunReceipt(db,release,'end',undefined,profile);
  assert.equal(receipt.ended,true);assert.equal(receipt.archive_cleanup,'verified');
  assert.deepEqual(receipt.counts,counts);assert.equal(Object.keys(receipt.archive_flags).length,4);
  assert.ok(Object.values(receipt.archive_flags).every(flag=>flag==='stripped'));
  for(const kind of ['solo','piano'])for(const role of ['seed','final']) {
    const stored=await jointStorage(db,'get',explorationProjectId(setup.run.id,kind,role));
    assert.equal(stored.blob,null);assert.ok(stored.view.method);
  }
  await assert.rejects(route.run.reserve({kind:'make_version',input_sha256:setup.solo.sourceSha256}),/private_run_ended/);
  t.diagnostic(JSON.stringify({schema:'issue38-exploration-sdk0-matrix-cost-v1',profile,counts,
    upper_bounds:Object.fromEntries(['solo','piano'].map(kind=>[kind,matrixUpperBound(kind,profile)])),
    events:events.length,operation_counts:Object.fromEntries(['solo','piano'].map(kind=>[kind,
      Object.fromEntries(['open','render','compare','save'].map(type=>[type,operations.filter(op=>op.kind===kind&&op.type===type).length]))])),
    source_axis:{samples:n,frames},lease_ms:expires-start,setup_bytes:envelope.size,
    source_bundle_bytes:Object.fromEntries(Object.entries(bundles).map(([kind,blob])=>[kind,blob.size])),
    real_sdk:0,real_recording_reads:0,new_jobs:0}));
});
