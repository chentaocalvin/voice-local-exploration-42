// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {coreFeedbackSummary,archiveCoreFeedback,completedVersionFeedback} from '../../issue42/joint/exploration_feedback.mjs';

function fixture() {
  const binding={input_sha256:'source',source_voice_sha256:'voice',source_mix_sha256:null,
    source_kind:'solo',chain_method:'method',sample_rate:44100,samples:352800,
    axis:'vocal_only',interval:[22050,330750],versions:[
      {id:'U',sha256:'neutral',voice_sha256:'neutral-voice',spectral_delta_scales:{Q:1,T:1},control:{intents:[],preserve:[]}},
      {id:'earlier',sha256:'earlier-wave',voice_sha256:'earlier-voice',spectral_delta_scales:{Q:1,T:1},
        control:{intents:[{kind:'T',amount:3}],preserve:[]}},
    ]};
  const level=Array.from({length:14},(_,i)=>({interval:[22050+i*22050,22050+(i+1)*22050],relative_db:0}));
  const report={motion:{before:level,after:level},quality:{before:{cpps:1,hnr:2},after:{cpps:2,hnr:3}},
    timbre:{before:Array(699).fill({ratio_db:null}),after:Array(699).fill({ratio_db:null})},preservation:{protected_voice_equal:true,protected_mix_equal:null,
      estimated_residual_equal:null,changed_voice_samples_in_selection:2}};
  const summary=coreFeedbackSummary(binding,report);
  return {binding,summary};
}

test('archiving an earlier compared choice retains its own validated feedback and comparison',()=>{
  const {binding,summary}=fixture(),saved=archiveCoreFeedback(summary,binding);
  assert.deepEqual(saved.feedback,summary);
  assert.deepEqual(saved.comparison,{input_sha256:'source',axis:'vocal_only',interval:[22050,330750],
    left:'U',right:'earlier',left_sha256:'neutral',right_sha256:'earlier-wave'});
  saved.feedback.quality.after.cpps=99;saved.comparison.interval[0]=0;
  assert.equal(summary.quality.after.cpps,2);assert.equal(binding.interval[0],22050);
});

test('cached feedback cannot cross source, version, control, scale, interval or axis bindings',()=>{
  const {binding,summary}=fixture();
  const changes=[x=>x.input_sha256='other',x=>x.source_voice_sha256='other',x=>x.source_mix_sha256='other',
    x=>x.source_kind='piano',x=>x.chain_method='other',x=>x.sample_rate=48000,x=>x.samples=123,
    x=>x.axis='full_mix',x=>x.interval[0]=0,x=>x.versions[0].sha256='other',
    x=>x.versions[1].id='latest',x=>x.versions[1].sha256='latest-wave',x=>x.versions[1].voice_sha256='other',
    x=>x.versions[1].control.intents[0].amount=6,x=>x.versions[1].spectral_delta_scales.T=.5];
  for(const change of changes){const expected=structuredClone(binding);change(expected);
    assert.throws(()=>archiveCoreFeedback(summary,expected),/archive_feedback_mismatch/);}
  const corrupted=structuredClone(summary);corrupted.quality.after.cpps=Infinity;
  assert.throws(()=>archiveCoreFeedback(corrupted,binding),/archive_feedback_mismatch/);
});

test('an unmeasured choice stays explicitly without comparison or feedback',()=>{
  assert.deepEqual(archiveCoreFeedback(null,fixture().binding),{comparison:null,feedback:null});
});


test('display accepts only a report for the open input, reference and completed version',()=>{
  const {binding,summary}=fixture();
  const source={input_sha256:'source',voice_sha256:'voice',mix_sha256:null,kind:'solo',
    method_version:'method',samples:352800,sample_rate:44100};
  const [left,right]=binding.versions;
  const version=(identity,feedback)=>({id:identity.id,sha256:identity.sha256,control:identity.control,
    spectral_delta_scales:identity.spectral_delta_scales,metadata:{source,result:identity,feedback}});
  const baseline=version(left), edited=version(right,{status:'archived_not_remeasured',summary});
  assert.deepEqual(completedVersionFeedback(source,baseline,edited),edited.metadata.feedback);
  for(const change of [
    value=>value.metadata.feedback.summary.binding.interval[0]=0,
    value=>value.metadata.feedback.summary.binding.axis='full_mix',
    value=>value.control.intents[0].amount=6,
    value=>value.metadata.source={...source,voice_sha256:'another'},
    value=>value.sha256='another',
  ]){
    const mismatch=structuredClone(edited);change(mismatch);
    assert.equal(completedVersionFeedback(source,baseline,mismatch),null);
  }
  assert.equal(completedVersionFeedback({...source,input_sha256:'another'},baseline,edited),null);
  assert.equal(completedVersionFeedback(source,baseline,version(right)),null);
});
