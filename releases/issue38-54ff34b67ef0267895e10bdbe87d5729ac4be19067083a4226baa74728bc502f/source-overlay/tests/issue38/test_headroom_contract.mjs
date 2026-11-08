import assert from 'node:assert/strict';
import test from 'node:test';
import {readPrivateSetup,privateSetupEngineOptions} from '../../issue42/joint/private_setup.mjs';
import {HEADROOM_PROFILE,EXPLORATION_PROFILE,explorationArchiveBinding} from '../../issue42/joint/exploration_profile.mjs';
import {enrollPrivateRun,openPrivateRun,privateRunReceipt} from '../../issue42/joint/private_run.mjs';
import {memoryIndexedDB} from './memory_indexeddb.mjs';
import {describePrivateUsage} from '../../issue42/joint/private_usage.mjs';
import {explorationFixture} from './exploration_fixture.mjs';
import {createJointEngine} from '../../issue42/joint/engine.mjs';
import {createJointActions} from '../../issue42/joint/actions.mjs';
import {jointStorage} from '../../issue42/joint/archive.mjs';

test('a signed headroom grant requires its exact manifest domain and retains an independent cold ledger',async()=>{
  const db=memoryIndexedDB(),release='headroom-contract',start=Date.parse('2026-11-07T13:00:00Z');
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const {recipient}=await enrollPrivateRun(db,release,HEADROOM_PROFILE);
  const claims={schema:'voice-private-setup-v3',profile:HEADROOM_PROFILE,release,
    solo:{sourceSha256:'a'.repeat(64),expires:start+7_200_000},
    piano:{voiceSha256:'b'.repeat(64),mixSha256:'c'.repeat(64),neutralMixSha256:'d'.repeat(64),neutralVoiceSha256:'e'.repeat(64),expires:start+7_200_000},
    run:{id:'f'.repeat(64),recipient,not_before:start,expires:start+7_200_000}};
  const signed=async value=>{
    const payload=new TextEncoder().encode(JSON.stringify(value));
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,payload);
    return new Blob([JSON.stringify({payload:Buffer.from(payload).toString('base64url'),signature:Buffer.from(signature).toString('base64url')})]);
  };
  const verify=async(value,expectedProfile=HEADROOM_PROFILE)=>readPrivateSetup(await signed(value),key.publicKey,release,start,{requireRun:true,expectedProfile});
  assert.deepEqual(await verify(claims),claims);
  await assert.rejects(verify(claims,EXPLORATION_PROFILE),/private_setup_policy/);
  await assert.rejects(verify({...claims,profile:EXPLORATION_PROFILE}),/private_setup_policy/);
  await assert.rejects(readPrivateSetup(await signed(claims),key.publicKey,release,start,{requireRun:true}),/private_setup_policy/);
  for(const bad of [{...claims,extra:1},{...claims,run:{...claims.run,expires:claims.run.expires+1}},
    {...claims,solo:{...claims.solo,method:'other'}},{...claims,profile:'unknown'}])await assert.rejects(verify(bad),/private_setup_policy/);
  assert.equal(privateSetupEngineOptions(claims).privateExploration.profile,HEADROOM_PROFILE);
  assert.equal(explorationArchiveBinding(claims,'solo','seed').profile,HEADROOM_PROFILE);
  const run=await openPrivateRun(db,claims,()=>start);
  await run.reserve({kind:'make_version',input_sha256:claims.solo.sourceSha256});
  const cold=await openPrivateRun(db,claims,()=>start+1);
  assert.equal((await cold.report()).solo.make_version,1);
  await assert.rejects(openPrivateRun(db,{...claims,profile:EXPLORATION_PROFILE},()=>start),/private_run_enrollment/);
  const receipt=await privateRunReceipt(db,release,'end',undefined,HEADROOM_PROFILE);
  assert.equal(receipt.profile,HEADROOM_PROFILE);assert.equal(receipt.ended,true);
  assert.equal(receipt.counts.solo.make_version,1);assert.equal(receipt.archive_cleanup,'verified');
  assert.match(describePrivateUsage(receipt),/版本预扣：1 \/ 28/);
});

test('headroom seed storage reopens through production actions and end strips only that method domain',async t=>{
  const previousNow=Date.now;Date.now=()=>100;t.after(()=>{Date.now=previousNow;});
  const f=await explorationFixture();f.clock(100);
  const db=memoryIndexedDB(),release='headroom-storage',{recipient}=await enrollPrivateRun(db,release,HEADROOM_PROFILE);
  const setup={schema:'voice-private-setup-v3',profile:HEADROOM_PROFILE,release,
    solo:f.options.privateExploration.solo,piano:f.options.privateExploration.piano,
    run:{id:'6'.repeat(64),recipient,not_before:1,expires:9000}};
  const run=await openPrivateRun(db,setup,()=>100),reserve=event=>run.reserve(event);
  const options={...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE},reserve};
  const engine=createJointEngine(options);await engine.open(f.solo);
  const draft={preserve:[[0,100]],intents:[{kind:'Q',amount:-4,mode:'flat',start_frame:100,end_frame:1500}]};
  const result=await engine.render(draft),id=`J:${setup.run.id}:solo:seed`;
  const actions=createJointActions(engine,db,{privateArchive:setup,resourceReserve:reserve});
  await actions.dispatch({type:'jointSave',projectId:id,saveRole:'seed',view:{resultId:result.id,draft,
    listening:{start:.5,end:7.5,mode:'local',selected:'E'}}});
  const cold=createJointActions(createJointEngine(options),db,{privateArchive:setup,resourceReserve:reserve});
  const reopened=await cold.dispatch({type:'jointReopen',projectId:id});
  assert.equal(reopened.result.sha256,result.sha256);
  assert.deepEqual(reopened.result.spectral_delta_scales,result.spectral_delta_scales);
  const receipt=await privateRunReceipt(db,release,'end',undefined,HEADROOM_PROFILE);
  assert.equal(receipt.archive_cleanup,'verified');assert.equal(receipt.archive_flags[id],'stripped');
  const saved=await jointStorage(db,'get',id);assert.equal(saved.blob,null);
  assert.deepEqual(saved.view.spectral_delta_scales,result.spectral_delta_scales);
});
