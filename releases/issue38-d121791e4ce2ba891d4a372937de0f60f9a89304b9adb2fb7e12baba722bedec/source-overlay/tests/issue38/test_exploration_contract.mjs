import assert from 'node:assert/strict';
import test from 'node:test';
import {memoryIndexedDB} from './memory_indexeddb.mjs';
import {enrollPrivateRun,openPrivateRun,privateRunReceipt} from '../../issue42/joint/private_run.mjs';
import {readPrivateSetup,privateSetupEngineOptions} from '../../issue42/joint/private_setup.mjs';
import {jointStorage,exportJointArchive} from '../../issue42/joint/archive.mjs';
import {describePrivateUsage} from '../../issue42/joint/private_usage.mjs';
import {createJointActions} from '../../issue42/joint/actions.mjs';
import {registerHooks} from 'node:module';
import {explorationFixture} from './exploration_fixture.mjs';

const release='exploration-contract-fixture', start=Date.parse('2026-11-07T13:00:00Z');
const profile='issue38-joint-exploration-v1';
const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
const solo='a'.repeat(64), piano='b'.repeat(64), mix='c'.repeat(64);
const limits={praat:4,world_analysis:4,synthesize:0,cpps:26,hnr:26,stft:26,
  make_version:28,compare:24,save:2,open:2,audio_read:1_250_000_000};
async function fixture() {
  const db=memoryIndexedDB(),{recipient}=await enrollPrivateRun(db,release);
  const claims={schema:'voice-private-setup-v3',profile,release,
    solo:{sourceSha256:solo,expires:Date.parse('2026-11-10T17:24:06Z')},
    piano:{voiceSha256:piano,mixSha256:mix,neutralMixSha256:'d'.repeat(64),neutralVoiceSha256:'e'.repeat(64),expires:Date.parse('2026-11-13T03:38:03Z')},
    run:{id:'f'.repeat(64),recipient,not_before:start,expires:start+7_200_000}};
  return {db,claims};
}
async function signed(claims,signingKey=key.privateKey) {
  const payload=new TextEncoder().encode(JSON.stringify(claims));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey,payload);
  return new Blob([JSON.stringify({payload:Buffer.from(payload).toString('base64url'),signature:Buffer.from(signature).toString('base64url')})]);
}
const event=(kind,input=solo,samples)=>({kind,input_sha256:input,...(samples===undefined?{}:{samples})});

test('signed v3 binds its named profile, distinct sources and fixed 120 minute maximum without extending v2',async()=>{
  const {claims}=await fixture();
  const verify=async c=>readPrivateSetup(await signed(c),key.publicKey,release,start,{requireRun:true,expectedProfile:profile});
  assert.deepEqual(await verify(claims),claims);
  assert.ok((await signed(claims)).size<=4096);
  const options=privateSetupEngineOptions(claims);
  assert.deepEqual(options.privateExploration,{profile,solo:claims.solo,piano:claims.piano});
  assert.deepEqual(options.privateSourceExpiries,{solo:claims.solo.expires,piano:claims.piano.expires});
  assert.equal(options.soloPhaseV2Baseline,undefined);
  for(const bad of [
    {...claims,profile:'unknown'}, {...claims,extra:1},
    {...claims,solo:{...claims.solo,amount:1}},
    {...claims,run:{...claims.run,expires:claims.run.expires+1}},
    {...claims,solo:{...claims.solo,expires:claims.solo.expires+1}},
    {...claims,piano:{...claims.piano,voiceSha256:solo}},
    {...claims,schema:'voice-private-setup-v2'},
  ]) await assert.rejects(verify(bad),/private_setup_policy/);
  await assert.rejects(readPrivateSetup(await signed(claims),key.publicKey,release,start),/private_setup_policy/);
  await assert.rejects(readPrivateSetup(await signed(claims),key.publicKey,release,start,{requireRun:true}),/private_setup_policy/);
  const foreign=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  await assert.rejects(readPrivateSetup(await signed(claims,foreign.privateKey),key.publicKey,release,start,{requireRun:true}),/private_setup_signature/);
});

test('v3 caps precharge independently per input, survive cold opening, and cannot be borrowed by v2',async()=>{
  const {db,claims}=await fixture();
  const run=await openPrivateRun(db,claims,()=>start);
  for(const input of [solo,piano])for(const [kind,cap] of Object.entries(limits)) {
    if(kind==='audio_read')await run.reserve(event(kind,input,cap));
    else for(let n=0;n<cap;n++)await run.reserve(event(kind,input));
    await assert.rejects(run.reserve(event(kind,input,1)),/private_run_cap/);
  }
  const cold=await openPrivateRun(db,structuredClone(claims),()=>start+1);
  assert.deepEqual(await cold.report(),{solo:limits,piano:limits});
  const receipt=await privateRunReceipt(db,release,'report');
  assert.equal(receipt.profile,profile);assert.equal(receipt.run_id,claims.run.id);
  assert.match(describePrivateUsage(receipt),/28 \/ 28/);
  const other=await fixture();
  await assert.rejects(openPrivateRun(other.db,{release,solo:other.claims.solo,piano:other.claims.piano,run:other.claims.run},()=>start),/private_run_policy/);
});

test('cold v3 end strips only its exact seed and final archive references, leaving other projects intact',async()=>{
  const {db,claims}=await fixture();const run=await openPrivateRun(db,claims,()=>start);
  await run.reserve(event('compare'));
  const ids=[];
  for(const kind of ['solo','piano'])for(const role of ['seed','final']) {
    const id=`J:${claims.run.id}:${kind}:${role}`;ids.push(id);
    const privateRun={profile,run_id:claims.run.id,recipient:claims.run.recipient,kind,role,
      source_sha256:kind==='solo'?solo:piano};
    await jointStorage(db,'add',id,{blob:new Blob(['synthetic marker']),view:{method:kind==='solo'?'voice-local-solo-signed-exploration-v1':'voice-local-piano-signed-exploration-v1'},expires:claims.run.expires,privateRun});
  }
  await jointStorage(db,'add','J:other-run:solo:seed',{blob:new Blob(['other']),view:{unrelated:true},expires:claims.run.expires});
  const receipt=await privateRunReceipt(db,release,'end');
  assert.equal(receipt.ended,true);assert.equal(receipt.archive_cleanup,'verified');
  assert.equal(receipt.counts.solo.compare,1);
  assert.equal(Object.keys(receipt.archive_flags).length,4);
  for(const id of ids) {
    const saved=await jointStorage(db,'get',id);assert.equal(saved.blob,null);
    assert.ok(saved.view.method);assert.equal(saved.privateRun.run_id,claims.run.id);
  }
  assert.equal((await jointStorage(db,'get','J:other-run:solo:seed')).blob.size,5);
  const repeated=await privateRunReceipt(db,release,'end');assert.equal(repeated.archive_cleanup,'verified');
  await assert.rejects(run.reserve(event('compare')),/private_run_ended/);
});

test('v3 missing project database is verified absent without creating it; wrong archive metadata is retained unknown',async()=>{
  const {db,claims}=await fixture();await openPrivateRun(db,claims,()=>start);
  const none=await privateRunReceipt(db,release,'end');
  assert.equal(none.archive_cleanup,'verified');
  assert.ok(Object.values(none.archive_flags).every(value=>value==='absent'));
  const other=await fixture();await openPrivateRun(other.db,other.claims,()=>start);
  const id=`J:${other.claims.run.id}:solo:seed`;
  await jointStorage(other.db,'add',id,{blob:new Blob(['do not strip']),view:{},expires:other.claims.run.expires,
    privateRun:{profile,run_id:other.claims.run.id,recipient:'0'.repeat(64),kind:'solo',role:'seed',source_sha256:solo}});
  const ended=await privateRunReceipt(other.db,release,'end');
  assert.equal(ended.archive_cleanup,'unverified');assert.equal((await jointStorage(other.db,'get',id)).blob.size,12);
});

test('private archive navigation rejects other run/role IDs and lists only exact current-run records',async()=>{
  const {db,claims}=await fixture(),id=`J:${claims.run.id}:solo:seed`;
  const binding={profile,run_id:claims.run.id,recipient:claims.run.recipient,kind:'solo',role:'seed',source_sha256:solo};
  await jointStorage(db,'add',id,{blob:new Blob(['owned']),view:{method:'voice-local-solo-signed-exploration-v1'},expires:claims.run.expires,privateRun:binding});
  await jointStorage(db,'add','J:other',{blob:new Blob(['other']),view:{},expires:1});
  const actions=createJointActions(null,db,{privateArchive:claims});
  assert.deepEqual(await actions.dispatch({type:'jointList'}),[id]);
  for(const projectId of ['J:other',`J:${claims.run.id}:solo:extra`,`J:${claims.run.id}:solo`])
    for(const type of ['jointDelete','jointReopen'])await assert.rejects(actions.dispatch({type,projectId}),/private_archive_identity/);
  await assert.rejects(actions.dispatch({type:'jointClear'}),/private_setup_project_clear/);
  await assert.rejects(actions.dispatch({type:'jointReopen',projectId:id}),/joint_runtime_unavailable/);
});

test('cold production Worker exports v3 limits and cleanup metadata without installing a source or touching SDK',async()=>{
  const {db,claims}=await fixture();const run=await openPrivateRun(db,claims,()=>start);
  await run.reserve(event('make_version'));await run.reserve(event('compare'));
  const factory='data:text/javascript,'+encodeURIComponent(`export default async()=>({
    HEAPF64:new Float64Array(1),_malloc(){throw Error('actual_sdk');},_free(){},
    _issue41_world_frames(){throw Error('actual_sdk');},_issue41_world_analyze(){throw Error('actual_sdk');},
    _issue41_world_synthesize(){throw Error('actual_sdk');}})`);
  const pins={praat_module:'c4f896e909f4ad1733ed2dcc6320096e19ccc5647e951a70a54f19db0313d1a2',
    praat_wasm:'4fad3e73c2cb8daecaddc72920b5c29fa9a62c6d8ac367d0be19794dccc7eb9d',
    world_module:'8b27b73fefe8be20b36cf5288d06d1cd938813b7d9c1a179227fe1cac3d5cdcb',
    world_wasm:'fabb1b8f6225f23221bb75f0b69fcbe6f6e033ef0c1aedf0d124393001715a46'};
  const assets=Object.fromEntries(Object.entries(pins).map(([name,sha256])=>[name,{sha256,chunks:[{path:factory+'//'+name+'.mjs'}]}]));
  assets.praat_quality_module={sha256:'3a0fa4a532145b29a071c350218e2de0851b4f173781b59b7e1f7477cdddb85e'};
  assets.praat_quality_wasm={sha256:'d3f29721d5ab79fa90d7373a0241972074a59467925cc58c0837559f5be10f9a'};
  const publicKey=await crypto.subtle.exportKey('jwk',key.publicKey);
  const manifest={release,assets,joint:{enabled:true,private_setup:true,private_run:true,source_proof_key:publicKey}};
  const old={self:globalThis.self,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB};
  const objectURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL,messages=[];
  const hooks=registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.includes('/processor.mjs')&&specifier==='./assets.mjs')
      return {url:'data:text/javascript,export async function loadAsset(){return new Uint8Array();}',shortCircuit:true};
    return next(specifier,context);
  }});
  try {
    globalThis.self={postMessage:value=>messages.push(value)};globalThis.indexedDB=db;
    globalThis.fetch=async()=>({ok:true,json:async()=>manifest});URL.createObjectURL=()=>factory;URL.revokeObjectURL=()=>{};
    await import('../../issue42/processor.mjs?exploration-cold-end');
    async function rpc(type,fields={}){const id=String(messages.length);await self.onmessage({data:{id,type,...fields}});return messages.findLast(row=>row.id===id);}
    assert.equal((await rpc('initialize')).result.private_run,true);
    assert.equal((await rpc('jointPrivateRunReport')).result.profile,profile);
    const receipt=(await rpc('jointEndPrivateRun')).result;
    assert.equal(receipt.archive_cleanup,'verified');assert.equal(receipt.ledger_ended,true);
    assert.equal(receipt.counts.solo.make_version,1);assert.equal(receipt.counts.solo.compare,1);
    assert.deepEqual(Object.values(receipt.archive_flags),['absent','absent','absent','absent']);
    manifest.public_probe='issue38-anonymous-example-v1';
    await import('../../issue42/processor.mjs?anonymous-probe-first-worker');await rpc('initialize');
    assert.equal((await rpc('analyze',{bytes:new Uint8Array([1,2])})).error,'invalid_wav');
    const probe=(await rpc('audit')).result.public_probe;
    assert.equal(probe.stopped,true);assert.equal(probe.counts.analyze,1);
    assert.equal(probe.counts.audio_read,3*1463881);assert.equal(probe.counts.praat,0);
    await import('../../issue42/processor.mjs?anonymous-probe-cold-worker');await rpc('initialize');
    assert.equal((await rpc('analyze',{bytes:new Uint8Array([1,2])})).error,'public_probe_stopped');
  }finally{hooks.deregister();Object.assign(globalThis,old);URL.createObjectURL=objectURL;URL.revokeObjectURL=revokeURL;}
});

for(const failure of ['pitch','quality','scope'])test(failure==='scope'?
  'v3 production reopening rejects foreign run and wrong role before Blob reads or any SDK/precharge':
  `v3 ${failure} SDK failure stops its input persistently without refund and leaves metadata recovery available`,async()=>{
  const {db,claims}=await fixture(),f=await explorationFixture();
  claims.solo.sourceSha256=f.options.privateExploration.solo.sourceSha256;
  Object.assign(claims.piano,f.options.privateExploration.piano,{expires:claims.piano.expires});
  // Source proofs are synthetic but genuine signatures. The production source
  // admission, engine, actions, run ledger and Worker RPC are not substituted.
  const input=structuredClone(f.solo),proof=JSON.parse(new TextDecoder().decode(input.payload));
  input.payload=new TextEncoder().encode(JSON.stringify({...proof,expires:claims.solo.expires}));
  input.signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,input.payload));
  const bundle=await exportJointArchive({input,view:{kind:'solo_input'}});
  const factory='data:text/javascript,export default async()=>({})';
  const pins={praat_module:'c4f896e909f4ad1733ed2dcc6320096e19ccc5647e951a70a54f19db0313d1a2',
    praat_wasm:'4fad3e73c2cb8daecaddc72920b5c29fa9a62c6d8ac367d0be19794dccc7eb9d',
    world_module:'8b27b73fefe8be20b36cf5288d06d1cd938813b7d9c1a179227fe1cac3d5cdcb',
    world_wasm:'fabb1b8f6225f23221bb75f0b69fcbe6f6e033ef0c1aedf0d124393001715a46'};
  const assets=Object.fromEntries(Object.entries(pins).map(([name,sha256])=>[name,{sha256,chunks:[{path:factory+'//'+name+'.mjs'}]}]));
  assets.praat_quality_module={sha256:'3a0fa4a532145b29a071c350218e2de0851b4f173781b59b7e1f7477cdddb85e'};
  assets.praat_quality_wasm={sha256:'d3f29721d5ab79fa90d7373a0241972074a59467925cc58c0837559f5be10f9a'};
  const manifest={release,assets,private_profile:profile,joint:{enabled:true,private_setup:true,private_run:true,
    source_proof_key:await crypto.subtle.exportKey('jwk',key.publicKey)}};
  const saved={self:globalThis.self,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB,
    boundary:globalThis.explorationStopSdkBoundary,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),
    now:Date.now,createObjectURL:URL.createObjectURL,revokeObjectURL:URL.revokeObjectURL};
  const messages=[],boundary={
    pitch(...args){if(failure==='pitch')throw Error('praat_analysis_failed');return f.options.sdk.pitch(...args);},
    analyze:(...args)=>f.options.sdk.analyze(...args),synthesize:()=>{throw Error('actual_sdk_forbidden');},
    voiceQuality(){throw Error('feedback_measurement_failed');},
  };
  const sdkAdapters={
    './assets.mjs':'export async function loadAsset(){return new Uint8Array([1]);}',
    './pitch.mjs':'export const analyzePitch=(...args)=>globalThis.explorationStopSdkBoundary.pitch(...args);',
    './world.mjs':'export const createWorld=()=>globalThis.explorationStopSdkBoundary;',
    './joint/praat_quality.mjs':'export const measureVoiceQuality=(...args)=>globalThis.explorationStopSdkBoundary.voiceQuality(...args);',
  };
  const hooks=registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.includes('/processor.mjs')&&sdkAdapters[specifier])
      return {url:'data:text/javascript,'+encodeURIComponent(sdkAdapters[specifier]),shortCircuit:true};
    return next(specifier,context);
  }});
  try {
    Date.now=()=>start;globalThis.self={postMessage:value=>messages.push(value)};
    globalThis.indexedDB=db;globalThis.fetch=async()=>({ok:true,json:async()=>manifest});
    globalThis.explorationStopSdkBoundary=boundary;
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,use)=>use()}}});
    URL.createObjectURL=()=>factory;URL.revokeObjectURL=()=>{};
    async function rpc(type,fields={}){const id=String(messages.length);await self.onmessage({data:{id,type,...fields}});return messages.findLast(row=>row.id===id);}
    const install=async (suffix,grant=claims)=>{
      await import('../../issue42/processor.mjs?stop-'+failure+'-'+suffix);
      const initialized=await rpc('initialize');assert.equal(initialized.ok,true,initialized.error);
      const installed=await rpc('jointInstallPrivateSetup',{blob:await signed(grant)});
      assert.equal(installed.ok,true,installed.error);
    };
    await install('initial');
    if(failure==='scope') {
      const ids=[`J:${'9'.repeat(64)}:solo:seed`,`J:${claims.run.id}:solo:wrong-role`];
      for(const id of ids)await jointStorage(db,'add',id,{blob:new Blob([new Uint8Array(100)]),view:{},expires:claims.run.expires});
      const before=(await rpc('jointPrivateRunReport')).result,arrayBuffer=Blob.prototype.arrayBuffer;
      let reads=0;const observations=[];
      Blob.prototype.arrayBuffer=function(){reads++;return arrayBuffer.call(this);};
      try {
        for(const projectId of ids) {
          const previousReads=reads;
          const rejected=await rpc('jointReopen',{projectId});
          observations.push({error:rejected.error,blob_reads:reads-previousReads});
          const after=(await rpc('jointPrivateRunReport')).result;
          assert.deepEqual(after.counts,before.counts);assert.deepEqual(after.stopped,before.stopped);
          assert.deepEqual(f.calls,{pitch:0,analyze:0,synthesize:0});
        }
      }finally{Blob.prototype.arrayBuffer=arrayBuffer;}
      assert.deepEqual(observations,[{error:'private_archive_identity',blob_reads:0},{error:'private_archive_identity',blob_reads:0}]);
      const ended=(await rpc('jointEndPrivateRun')).result;assert.equal(ended.ended,true);
      assert.deepEqual(ended.counts,before.counts);
      const legacy=await fixture();globalThis.indexedDB=legacy.db;delete manifest.private_profile;
      const legacyClaims={schema:'voice-private-setup-v2',release,
        solo:{...claims.solo,interval:[621,870],amount:.5},piano:claims.piano,
        run:{...legacy.claims.run,expires:start+3_600_000}};
      await install('legacy-v2',legacyClaims);
      await jointStorage(legacy.db,'add',ids[0],{blob:new Blob([new Uint8Array(100)]),view:{},expires:legacyClaims.run.expires});
      const legacyBefore=(await rpc('jointPrivateRunReport')).result;
      reads=0;Blob.prototype.arrayBuffer=function(){reads++;return arrayBuffer.call(this);};
      try {
        assert.equal((await rpc('jointReopen',{projectId:ids[0]})).error,'archive_format');
        assert.equal(reads,2);
      }finally{Blob.prototype.arrayBuffer=arrayBuffer;}
      assert.deepEqual((await rpc('jointPrivateRunReport')).result,legacyBefore);
      assert.deepEqual(f.calls,{pitch:0,analyze:0,synthesize:0});
      assert.equal((await rpc('jointEndPrivateRun')).result.ledger_ended,true);
      return;
    }
    const opened=await rpc('jointOpen',{blob:bundle});
    if(failure==='pitch')assert.equal(opened.error,'praat_analysis_failed');
    else {
      assert.equal(opened.ok,true,opened.error);
      const metadataError=await rpc('jointVersionRecord',{resultId:'missing'});
      assert.equal(metadataError.error,'result_missing');
      assert.equal((await rpc('jointPrivateRunReport')).result.stopped.solo,false);
      const draft={intents:[{kind:'Q',amount:-4,mode:'flat',start_frame:100,end_frame:1500}],preserve:[]};
      const rendered=await rpc('jointRender',{draft});assert.equal(rendered.ok,true,rendered.error);
      const result=rendered.result,view=opened.result;
      const compared=await rpc('jointCompare',{scope:{input_sha256:view.input_sha256,axis:'vocal_only',interval:[22050,330750],
        left:'U',left_sha256:view.baseline.sha256,right:result.id,right_sha256:result.sha256}});
      assert.equal(compared.error,'feedback_measurement_failed');
    }
    const receipt=(await rpc('jointPrivateRunReport')).result;
    assert.equal(receipt.stopped.solo,true);assert.equal(receipt.stopped.piano,false);
    assert.equal(receipt.counts.solo.open,1);assert.equal(receipt.counts.solo.praat,1);
    if(failure==='pitch')assert.equal(receipt.counts.solo.world_analysis,0);
    else {assert.equal(receipt.counts.solo.cpps,1);assert.equal(receipt.counts.solo.stft,1);assert.equal(receipt.counts.solo.compare,1);}
    await install('cold');
    assert.equal((await rpc('jointOpen',{blob:bundle})).error,'private_run_stopped');
    assert.deepEqual((await rpc('jointPrivateRunReport')).result.counts,receipt.counts);
    assert.equal((await rpc('jointList')).ok,true);
    const ended=(await rpc('jointEndPrivateRun')).result;assert.equal(ended.ended,true);
    assert.deepEqual(ended.counts,receipt.counts);
  }finally {
    hooks.deregister();Date.now=saved.now;globalThis.self=saved.self;globalThis.fetch=saved.fetch;globalThis.indexedDB=saved.indexedDB;
    globalThis.explorationStopSdkBoundary=saved.boundary;URL.createObjectURL=saved.createObjectURL;URL.revokeObjectURL=saved.revokeObjectURL;
    if(saved.navigator)Object.defineProperty(globalThis,'navigator',saved.navigator);else delete globalThis.navigator;
  }
});
