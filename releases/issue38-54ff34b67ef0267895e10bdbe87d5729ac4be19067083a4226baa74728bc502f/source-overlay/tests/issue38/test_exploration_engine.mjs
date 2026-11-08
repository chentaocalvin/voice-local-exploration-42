import assert from 'node:assert/strict';
import test from 'node:test';
import { createJointEngine, editableJointProject } from '../../issue42/joint/engine.mjs';
import { SOLO_EXPLORATION_METHOD, PIANO_EXPLORATION_METHOD } from '../../issue42/joint/signed_exploration.mjs';

import { explorationFixture as fixture } from './exploration_fixture.mjs';
const runExpiry=9000;
const listening={start:.5,end:7.5,mode:'local',selected:'E'};
function draft(kind,items,preserve=[]) {return {preserve,intents:items.map(([feature,amount,mode='flat'])=>({kind:feature,amount,mode,start_frame:feature==='M'?(kind==='solo'?621:681):100,end_frame:feature==='M'?(kind==='solo'?870:1046):1500}))};}

test('one signed exploration engine retains source kind, supports signed temporal edits and cold withdrawal',async()=>{
  const f=await fixture(), engine=createJointEngine(f.options);
  for(const [kind,input,method]of [['solo',f.solo,SOLO_EXPLORATION_METHOD],['piano',f.piano,PIANO_EXPLORATION_METHOD]]) {
    const opened=await engine.open(input);
    assert.equal(opened.kind,kind);assert.equal(opened.method_version,method);
    assert.equal(opened.fixed_solo_recipe,undefined);assert.equal(opened.fixed_piano_recipe,undefined);
    assert.deepEqual(opened.source.default_region,[100,1500]);
    assert.deepEqual(opened.motion_region,kind==='solo'?[621,870]:[681,1046]);
    const control=draft(kind,[['M',kind==='solo'?.5:.75],['Q',4],['T',9]],[[0,100]]);
    const edited=await engine.render(control);engine.select(edited.id);
    const saved=engine.capture(control,listening);
    const metadata=engine.versionRecord(edited.id);
    assert.equal(metadata.source.kind,kind);assert.equal(metadata.source.method_version,method);
    assert.equal(saved.view.voiceDigest,metadata.result.voice_sha256);
    const restored=await createJointEngine(f.options).restore(saved);
    assert.equal(restored.result.sha256,edited.sha256);assert.deepEqual(restored.draft,edited.control);
    const expired=editableJointProject(saved.view);
    assert.equal(expired.expired,true);
    assert.equal(expired.kind,kind);
    assert.deepEqual(expired.control_limits,kind==='solo'?{M:.5,Q:4,T:9}:{M:.75,Q:4,T:9});
    assert.deepEqual(expired.motion_region,kind==='solo'?[621,870]:[681,1046]);
    const removed=await engine.render(draft(kind,[['M',kind==='solo'?.5:.75],['T',9]],[[0,100]]));
    assert.notEqual(removed.sha256,edited.sha256);
    assert.equal((await engine.render(control)).sha256,edited.sha256);
    const negative=draft(kind,[['Q',-4,'front']]);negative.intents[0].start_frame=110;negative.intents[0].end_frame=1400;
    assert.notEqual((await engine.render(negative)).sha256,opened.baseline.sha256);
    assert.equal((await engine.render(draft(kind,[['Q',4]],[[100,1500]]))).sha256,opened.baseline.sha256);
  }
  assert.equal(f.calls.synthesize,0);
});

test('exploration source identity and expiry reject before SDK work without reviving old method routes',async()=>{
  const f=await fixture();
  const wrong=structuredClone(f.options.privateExploration);wrong.solo.sourceSha256='a'.repeat(64);
  await assert.rejects(createJointEngine({...f.options,privateExploration:wrong}).open(f.solo),/signed_exploration_identity/);
  assert.equal(f.calls.analyze,0);
  assert.throws(()=>createJointEngine({...f.options,privateExploration:{...wrong,profile:'other'}}),/invalid_private_exploration/);
  const engine=createJointEngine(f.options), opened=await engine.open(f.solo);
  const control=draft('solo',[['Q',-4]]), result=await engine.render(control);engine.select(result.id);
  const saved=engine.capture(control,listening);
  await assert.rejects(createJointEngine({...f.options,privateExploration:null,privateSourceExpiries:null,privateRunExpires:null}).restore(saved),/signed_exploration_identity/);
  const altered=structuredClone(saved);altered.view.voiceDigest='b'.repeat(64);
  await assert.rejects(createJointEngine(f.options).restore(altered),/archive_result_mismatch/);
  f.clock(runExpiry);
  await assert.rejects(engine.render(control),/input_expired/);
  assert.throws(()=>engine.versionRecord(opened.baseline.id),/input_expired/);
});

test('new feedback binds named core observations to voices and persists bounded summaries without measuring on restore',async()=>{
  const f=await fixture(), engine=createJointEngine(f.options), opened=await engine.open(f.solo);
  const control=draft('solo',[['Q',-4]]), result=await engine.render(control);
  const scope={input_sha256:opened.input_sha256,axis:'vocal_only',interval:[22050,330750],left:'U',left_sha256:opened.baseline.sha256,right:result.id,right_sha256:result.sha256};
  const report=await engine.compare(scope);
  assert.equal(report.core_summary.schema,'voice-local-core-feedback-summary-v1');
  assert.equal(report.core_summary.binding.chain_method,SOLO_EXPLORATION_METHOD);
  assert.equal(report.core_summary.binding.versions[1].voice_sha256,result.voice_sha256);
  assert.equal(report.motion.periodic.reason,'provider_contract_unavailable');
  assert.equal(report.core_summary.contracts.preservation,'issue29-v2-core-consumption-contract-v1');
  assert.equal(report.core_summary.perceptual_inference.status,'unknown');
  assert.equal(report.core_summary.motion.before.length,14);
  assert.ok(new TextEncoder().encode(JSON.stringify(report.core_summary)).length<32768);
  assert.deepEqual(engine.versionRecord(result.id).feedback.summary,report.core_summary);
  const sdkBefore=f.events.filter(e=>['cpps','hnr','stft'].includes(e.kind)).length;
  engine.select(result.id); const saved=engine.capture(control,listening);
  assert.deepEqual(saved.view.feedback,report.core_summary);
  const cold=createJointEngine(f.options), restored=await cold.restore(saved);
  assert.equal(f.events.filter(e=>['cpps','hnr','stft'].includes(e.kind)).length,sdkBefore);
  assert.deepEqual(restored.feedback.summary,report.core_summary);
  assert.equal(restored.feedback.status,'archived_not_remeasured');
  const tampered=structuredClone(saved);tampered.view.feedback.binding.interval=[0,352800];
  await assert.rejects(createJointEngine(f.options).restore(tampered),/archive_feedback_mismatch/);
  await assert.rejects(engine.compare({...scope,interval:[0,352800]}),/feedback_region/);
});
