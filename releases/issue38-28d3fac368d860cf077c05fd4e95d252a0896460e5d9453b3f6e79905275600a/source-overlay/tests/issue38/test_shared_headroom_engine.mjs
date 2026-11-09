import assert from 'node:assert/strict';
import test from 'node:test';
import {createJointEngine} from '../../issue42/joint/engine.mjs';
import {HEADROOM_PROFILE} from '../../issue42/joint/exploration_profile.mjs';
import {explorationFixture} from './exploration_fixture.mjs';

const profile='issue38-joint-shared-spectral-headroom-v1';
test('the shared operator delivers one QT scale and preserves the unedited protected source',async()=>{
  const f=await explorationFixture();f.analysis.ap.fill(.9);
  const engine=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile}});
  const opened=await engine.open(f.solo);
  assert.equal(opened.method_version,'voice-local-solo-shared-spectral-headroom-v1');
  const result=await engine.render({preserve:[[0,100]],intents:[['M',.5,621,870],['Q',4,100,1500],['T',9,100,1500]]
    .map(([kind,amount,start_frame,end_frame])=>({kind,amount,start_frame,end_frame,mode:'flat'}))});
  assert.deepEqual(Object.keys(result.spectral_delta_scales),['Q','T']);
  assert.equal(result.spectral_delta_scales.Q,result.spectral_delta_scales.T);
  assert.ok(result.spectral_delta_scales.Q>=.5&&result.spectral_delta_scales.Q<1);
  const record=engine.versionRecord(result.id);
  assert.equal(record.source.method_version,opened.method_version);
  assert.deepEqual(record.spectral_delta_scales,result.spectral_delta_scales);
  for(const bytes of [result.bytes,result.voiceBytes]) {
    const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let i=44;i<bytes.length;i+=4)assert.ok(Math.abs(pcm.getInt32(i,true))/2147483648<=.979);
    assert.deepEqual(bytes.slice(44,44+22050*4),opened.baseline.bytes.slice(44,44+22050*4));
    assert.deepEqual(bytes.slice(44+330750*4),opened.baseline.bytes.slice(44+330750*4));
  }
  assert.equal(result.timbre_delta_scale,undefined);
  assert.equal(f.calls.synthesize,0);
});

const control=(kind,items,preserve=[])=>({preserve,intents:items.map(([feature,amount])=>({kind:feature,amount,mode:'flat',held:false,
  start_frame:feature==='M'?(kind==='solo'?621:681):100,end_frame:feature==='M'?(kind==='solo'?870:1046):1500}))});

test('all signed single controls and the neutral WAV keep their accepted sound bytes in both input domains',async()=>{
  const f=await explorationFixture();f.analysis.ap.fill(.9);
  const old=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}});
  const next=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile}});
  for(const [kind,input,m] of [['solo',f.solo,.5],['piano',f.piano,.75]]) {
    const previous=await old.open(input),current=await next.open(input);
    assert.deepEqual(current.baseline.bytes,previous.baseline.bytes);
    assert.equal(current.baseline.sha256,previous.baseline.sha256);
    for(const [feature,amount] of [['M',m],['Q',4],['T',9]])for(const sign of [-1,1]) {
      const draft=control(kind,[[feature,amount*sign]]),a=await old.render(draft),b=await next.render(draft);
      assert.deepEqual(b.bytes,a.bytes);assert.deepEqual(b.voiceBytes,a.voiceBytes);
      assert.equal(b.sha256,a.sha256);assert.equal(b.voice_sha256,a.voice_sha256);
      assert.deepEqual(b.spectral_delta_scales,a.spectral_delta_scales);
      assert.notEqual(b.id,a.id);
    }
  }
  assert.equal(f.calls.synthesize,0);
});

test('an unlimited shared QT endpoint keeps the full unscaled path and a protected interval is exact',async()=>{
  const f=await explorationFixture(),old=createJointEngine(f.options);
  const next=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile}});
  await old.open(f.piano);const opened=await next.open(f.piano);
  const draft=control('piano',[['M',.75],['Q',4],['T',9]],[[0,100]]);
  // Q and T have distinct supports; the shared write region must be their union.
  draft.intents[1].end_frame=1000;draft.intents[2].start_frame=500;
  const a=await old.render(draft),b=await next.render(draft);
  assert.deepEqual(b.spectral_delta_scales,{Q:1,T:1});
  assert.deepEqual(b.bytes,a.bytes);assert.deepEqual(b.voiceBytes,a.voiceBytes);
  assert.deepEqual(b.bytes.slice(44,44+22050*4),opened.baseline.bytes.slice(44,44+22050*4));
});

test('cold restoration binds the common QT scale and refuses changed scales or the former method domain',async()=>{
  const f=await explorationFixture();f.analysis.ap.fill(.9);
  const options={...f.options,privateExploration:{...f.options.privateExploration,profile}};
  const engine=createJointEngine(options);await engine.open(f.solo);
  const draft=control('solo',[['M',.5],['Q',4],['T',9]],[[0,100]]);
  const result=await engine.render(draft);engine.select(result.id);
  const saved=engine.capture(draft,{start:.5,end:7.5,mode:'local',selected:'E'});
  const restored=await createJointEngine(options).restore(saved);
  assert.equal(restored.result.sha256,result.sha256);
  assert.deepEqual(restored.result.spectral_delta_scales,result.spectral_delta_scales);
  assert.deepEqual(restored.draft,draft);
  const tampered=structuredClone(saved);tampered.view.spectral_delta_scales.T=1;
  await assert.rejects(createJointEngine(options).restore(tampered),/archive_result_mismatch/);
  const former=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}});
  await assert.rejects(former.restore(saved),/signed_exploration_identity/);
});
