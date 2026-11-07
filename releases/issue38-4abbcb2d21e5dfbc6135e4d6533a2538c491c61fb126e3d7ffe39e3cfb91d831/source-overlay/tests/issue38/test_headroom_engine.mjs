import assert from 'node:assert/strict';
import test from 'node:test';
import {createJointEngine} from '../../issue42/joint/engine.mjs';
import {HEADROOM_PROFILE,HEADROOM_METHODS} from '../../issue42/joint/exploration_profile.mjs';
import {explorationFixture} from './exploration_fixture.mjs';
import {qualifyExploration,compileExploration,renderExploration} from '../../issue42/joint/signed_exploration.mjs';

test('the new profile opens each source under its own method while retaining its exact editing scope',async()=>{
  const f=await explorationFixture();
  const engine=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}});
  for(const [kind,input,motion,maximum] of [['solo',f.solo,[621,870],.5],['piano',f.piano,[681,1046],.75]]) {
    const opened=await engine.open(input);
    assert.equal(opened.method_version,HEADROOM_METHODS[kind]);
    assert.equal(opened.exploration_profile,HEADROOM_PROFILE);
    assert.equal(opened.kind,kind);
    assert.deepEqual(opened.motion_region,motion);
    assert.deepEqual(opened.control_limits,{M:maximum,Q:4,T:9});
  }
  assert.equal(f.calls.synthesize,0);
});

test('a scaled MQT result records Q and T once and does not apply the legacy combination scaler',async()=>{
  const f=await explorationFixture();f.analysis.ap.fill(.9);
  const engine=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}});
  await engine.open(f.solo);
  const result=await engine.render({preserve:[[0,100]],intents:[['M',.5,621,870],['Q',4,100,1500],['T',9,100,1500]]
    .map(([kind,amount,start_frame,end_frame])=>({kind,amount,start_frame,end_frame,mode:'flat'}))});
  assert.ok(result.spectral_delta_scales.Q>=.5&&result.spectral_delta_scales.Q<1);
  assert.deepEqual(Object.keys(result.spectral_delta_scales),['Q','T']);
  assert.ok(result.spectral_delta_scales.T>=.5&&result.spectral_delta_scales.T<=1);
  assert.equal(result.timbre_delta_scale,undefined);
  assert.equal(result.metadata.spectral_delta_scales.T,result.spectral_delta_scales.T);
});

test('both T directions use one common voice/mix scale and leave protected samples unchanged',async()=>{
  const f=await explorationFixture();
  const track=Array.from(f.analysis.time,(time,i)=>({time,hz:f.analysis.f0[i],undefined:false}));
  for(const [amount,hz] of [[9,4200],[-9,300]]) {
    const voice=Float64Array.from({length:352800},(_,i)=>.88*Math.sin(2*Math.PI*hz*i/44100));
    const mix=voice.map((value,i)=>value+.08*Math.sin(2*Math.PI*180*i/44100));
    const qualification=qualifyExploration({kind:'piano',voice,analysis:f.analysis,track,profile:HEADROOM_PROFILE});
    const draft={preserve:[[0,100]],intents:[{kind:'T',amount,mode:'flat',start_frame:100,end_frame:1500}]};
    const compiled=compileExploration(f.analysis,qualification,draft,voice.length);
    const output=renderExploration({voice,mix,analysis:f.analysis,qualification,compiled});
    assert.ok(output.stats.spectral_delta_scales.T>=.5&&output.stats.spectral_delta_scales.T<1);
    assert.deepEqual(Object.keys(output.stats.spectral_delta_scales),['T']);
    for(let i=0;i<voice.length;i++) {
      assert.ok(Math.abs(output.voice[i]*.5)<=.979+1e-9);assert.ok(Math.abs(output.mix[i]*.5)<=.979+1e-9);
      assert.ok(Math.abs((output.mix[i]-output.voice[i])-(mix[i]-voice[i]))<1e-14);
      if(i<22050||i>=330750) {assert.equal(output.voice[i],voice[i]);assert.equal(output.mix[i],mix[i]);}
    }
  }
});

test('headroom records and cold archives bind actual stage scales alongside the controls and full identities',async()=>{
  const f=await explorationFixture();f.analysis.ap.fill(.9);
  const options={...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}};
  const engine=createJointEngine(options),opened=await engine.open(f.solo);
  const draft={preserve:[[0,100]],intents:[{kind:'Q',amount:4,mode:'flat',start_frame:100,end_frame:1500}]};
  const result=await engine.render(draft),metadata=engine.versionRecord(result.id);
  assert.deepEqual(metadata.spectral_delta_scales,result.spectral_delta_scales);
  assert.deepEqual(metadata.result,{id:result.id,sha256:result.sha256,voice_sha256:result.voice_sha256});
  assert.equal(metadata.source.method_version,HEADROOM_METHODS.solo);
  const report=await engine.compare({input_sha256:opened.input_sha256,axis:'vocal_only',interval:[22050,330750],
    left:'U',left_sha256:opened.baseline.sha256,right:result.id,right_sha256:result.sha256});
  assert.deepEqual(report.core_summary.binding.versions[1].spectral_delta_scales,result.spectral_delta_scales);
  assert.deepEqual(report.core_summary.binding.versions[1].control,result.control);
  engine.select(result.id);
  const saved=engine.capture(draft,{start:.5,end:7.5,mode:'local',selected:'E'});
  assert.deepEqual(saved.view.spectral_delta_scales,result.spectral_delta_scales);
  const restored=await createJointEngine(options).restore(saved);
  assert.deepEqual(restored.result.spectral_delta_scales,result.spectral_delta_scales);
  const tampered=structuredClone(saved);tampered.view.spectral_delta_scales.Q=1;
  await assert.rejects(createJointEngine(options).restore(tampered),/archive_result_mismatch/);
  const old=createJointEngine(f.options);
  await assert.rejects(old.restore(saved),/signed_exploration_identity/);
});

test('unlimited new stages keep legacy sound bytes, with a separate method-bound result identity',async()=>{
  const f=await explorationFixture(), old=createJointEngine(f.options);
  const engine=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}});
  for(const [kind,input,amount] of [['solo',f.solo,.5],['piano',f.piano,.75]]) {
    await old.open(input);await engine.open(input);
    for(const items of [[['Q',4]],[['T',9]],[['M',amount],['Q',4],['T',9]]]) {
      const draft={preserve:[[0,100]],intents:items.map(([feature,value])=>({kind:feature,amount:value,mode:'flat',
        start_frame:feature==='M'?(kind==='solo'?621:681):100,end_frame:feature==='M'?(kind==='solo'?870:1046):1500}))};
      const expected=await old.render(draft), actual=await engine.render(draft);
      assert.deepEqual(actual.bytes,expected.bytes);assert.deepEqual(actual.voiceBytes,expected.voiceBytes);
      assert.notEqual(actual.id,expected.id);
      assert.deepEqual(actual.spectral_delta_scales,Object.fromEntries(items.filter(([key])=>key!=='M').map(([key])=>[key,1])));
      assert.equal(actual.timbre_delta_scale,undefined);
    }
  }
});

test('Q overflow retains at least half its difference and checks the actual encoded voice and mix',async()=>{
  const f=await explorationFixture();f.analysis.ap.fill(.9);
  const control={preserve:[[0,100]],intents:[{kind:'Q',amount:4,mode:'flat',start_frame:100,end_frame:1500}]};
  const old=createJointEngine(f.options);await old.open(f.solo);
  await assert.rejects(old.render(control),/signed_peak_limit/);
  const engine=createJointEngine({...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}});
  const opened=await engine.open(f.solo), result=await engine.render(control);
  assert.ok(result.spectral_delta_scales.Q>=.5&&result.spectral_delta_scales.Q<1);
  assert.deepEqual(Object.keys(result.spectral_delta_scales),['Q']);
  assert.notEqual(result.sha256,opened.baseline.sha256);
  for(const bytes of [result.bytes,result.voiceBytes]) {
    const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let i=44;i<bytes.length;i+=4)assert.ok(Math.abs(pcm.getInt32(i,true))/2147483648<=.979);
    assert.deepEqual(bytes.slice(44,44+22050*4),opened.baseline.bytes.slice(44,44+22050*4));
    assert.deepEqual(bytes.slice(44+330750*4),opened.baseline.bytes.slice(44+330750*4));
  }
  assert.equal(f.calls.synthesize,0);
});
