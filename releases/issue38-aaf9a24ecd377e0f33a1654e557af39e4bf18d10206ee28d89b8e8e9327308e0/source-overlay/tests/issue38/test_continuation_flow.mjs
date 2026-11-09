import assert from 'node:assert/strict';
import test from 'node:test';
import {continuationFlow,checkPageDraft,checkCurrentVersion,checkMeasuredVersion,checkFinalChoice,checkFinalPage} from './continuation_flow.mjs';

test('the explicit carry route contains all thirteen remaining piano C requests and the full solo C',()=>{
  const piano=continuationFlow('piano',{carryPianoWithdrawal:true});
  assert.deepEqual(piano.cases.map(item=>item.name),[
    'M-front','M-back','M-shift','Q-front','Q-back','Q-shift','T-front','T-back','T-shift',
    'other-pair','QT','protection-conflict','MQT-Q-shift-check']);
  assert.deepEqual(piano.expectedCounts,{make_version:17,compare:14,save:2,open:2});
  const solo=continuationFlow('solo',{carryPianoWithdrawal:false});
  assert.equal(solo.cases.length,21);
  assert.deepEqual(solo.cases.slice(0,8).map(item=>item.name),[
    'withdraw-Q','restore-Q','base-M','base-Q','base-T','weak-M','weak-Q','weak-T']);
  assert.deepEqual(solo.expectedCounts,{make_version:25,compare:21,save:2,open:2});
  assert.equal(solo.cases[1].compare,false);
  assert.equal(solo.cases[1].expected,'seed');
  assert.equal(piano.realSDKAuthorized,false);
  assert.equal(solo.realSDKAuthorized,false);
});

const children=(label,held)=>[
  {role:'AXListMarker',value:''},{role:'AXStaticText',value:label},
  {role:'AXButton',name:'编辑'},{role:'AXButton',name:held?'恢复':'撤回'}];
const frontPage=()=>({header:'J:fixture:piano:seed',generateEnabled:true,
  intentRows:[children('声音运动 · 3.405–5.230 秒 · 0.5 · 前半展开 ',false)],protectionRows:[],
  form:{kind:'M',amount:.5,mode:'front',start:3.405,end:5.23,held:false}});

test('page guard consumes actual native list markers and rejects stale source or uncommitted form',()=>{
  const step=continuationFlow('piano',{carryPianoWithdrawal:true}).cases[0];
  assert.equal(checkPageDraft(step,frontPage(),'J:fixture:piano:seed'),true);
  const wrongSource=frontPage();wrongSource.header='J:another:piano:seed';
  assert.throws(()=>checkPageDraft(step,wrongSource,'J:fixture:piano:seed'),/page_source/);
  const stale=frontPage();stale.form.mode='flat';
  assert.throws(()=>checkPageDraft(step,stale,'J:fixture:piano:seed'),/page_form/);
});

test('held guard keeps every intent and exact protection rather than treating withdrawal as deletion',()=>{
  const step=continuationFlow('piano').cases[0];
  const page={header:'J:fixture:piano:seed',generateEnabled:true,intentRows:[
    children('声音运动 · 3.405–5.230 秒 · 0.5 · 均匀 ',false),
    children('声质 · 0.500–7.500 秒 · 2 · 均匀 ',false),
    children('音色 · 0.500–7.500 秒 · 6 · 均匀 · 已撤回 ',true)],
    protectionRows:[[{role:'AXListMarker',value:''},{role:'AXStaticText',value:'0.000–0.500 秒 · 全部编辑类 '}]],
    form:{kind:'T',amount:6,mode:'flat',start:.5,end:7.5,held:true}};
  assert.equal(checkPageDraft(step,page,page.header),true);
  page.intentRows.pop();assert.throws(()=>checkPageDraft(step,page,page.header),/page_intents/);
});

const fingerprint=n=>String(n).repeat(64);
function reference() {
  const source={input_sha256:fingerprint(1),voice_sha256:fingerprint(2),mix_sha256:fingerprint(1),
    kind:'piano',samples:352800,sample_rate:44100,method_version:'voice-local-piano-shared-spectral-headroom-v1'};
  return {source,baseline:{result:{id:'U',sha256:fingerprint(3),voice_sha256:fingerprint(4)},
    source,control:{intents:[],preserve:[]},region:[100,1500],sample_regions:[],spectral_delta_scales:{}}};
}
function completed(step) {
  return {schema:'voice-version-record-v1',source:reference().source,
    result:{id:'E:'+fingerprint(5),sha256:fingerprint(6),voice_sha256:fingerprint(7)},
    control:structuredClone(step.draft),region:[100,1500],sample_regions:[[151000,230000]],
    spectral_delta_scales:Object.fromEntries(step.draft.intents.filter(x=>['Q','T'].includes(x.kind)&&!x.held).map(x=>[x.kind,1])),
    feedback:{status:'unknown',reason:'version_not_compared'}};
}

test('current export binds the requested complete control rather than an identical display caption',()=>{
  const [front,back]=continuationFlow('piano',{carryPianoWithdrawal:true}).cases;
  const record=completed(front);
  assert.equal(checkCurrentVersion(front,record,reference()),true);
  assert.throws(()=>checkCurrentVersion(back,record,reference()),/version_control/);
  const wrong=structuredClone(record);wrong.source.voice_sha256=fingerprint(8);
  assert.throws(()=>checkCurrentVersion(front,wrong,reference()),/version_source/);
  const quality=continuationFlow('piano',{carryPianoWithdrawal:true}).cases.find(x=>x.name==='Q-front');
  const reduced=completed(quality);reduced.spectral_delta_scales.Q=.49;
  assert.throws(()=>checkCurrentVersion(quality,reduced,reference()),/version_scale/);
});

test('restoration and all-protection require actual complete fingerprints of the accepted reference',()=>{
  const restore=continuationFlow('piano').cases[1];const seed=completed(restore);const ctx={...reference(),seed};
  assert.equal(checkCurrentVersion(restore,structuredClone(seed),ctx),true);
  const changed=structuredClone(seed);changed.result.sha256=fingerprint(9);
  assert.throws(()=>checkCurrentVersion(restore,changed,ctx),/expected_seed/);
  const conflict=continuationFlow('piano',{carryPianoWithdrawal:true}).cases.find(x=>x.expected==='U');
  const identity=completed(conflict);identity.result.sha256=ctx.baseline.result.sha256;
  identity.result.voice_sha256=ctx.baseline.result.voice_sha256;identity.spectral_delta_scales={};
  assert.equal(checkCurrentVersion(conflict,identity,ctx),true);
  identity.result.voice_sha256=fingerprint(8);
  assert.throws(()=>checkCurrentVersion(conflict,identity,ctx),/expected_U/);
});

test('unmeasured current results cannot stand in for matching measured feedback or final choice',()=>{
  const flow=continuationFlow('piano',{carryPianoWithdrawal:true}),step=flow.cases[0],record=completed(step);
  assert.throws(()=>checkMeasuredVersion(step,record,reference()),/feedback_status/);
  assert.throws(()=>checkFinalChoice(flow,step.name,record,{...reference(),accepted:{[step.name]:record},availableIds:[record.result.id]}),/feedback_status/);
  assert.throws(()=>checkFinalChoice(flow,'B-Qplus',record,reference()),/final_pool/);
});

function measured(step) {
  const record=completed(step),left=reference().baseline;
  const version=item=>({id:item.result.id,sha256:item.result.sha256,voice_sha256:item.result.voice_sha256,
    spectral_delta_scales:item.spectral_delta_scales,control:item.control});
  const levels=Array.from({length:14},(_,i)=>({interval:[22050+i*22050,44100+i*22050],relative_db:0}));
  record.feedback={status:'measured',summary:{schema:'voice-local-core-feedback-summary-v1',
    contracts:{motion:'issue27-v2-core-handoff-v1',quality:'issue28-v2-core-handoff-v1',preservation:'issue29-v2-core-consumption-contract-v1'},
    binding:{input_sha256:fingerprint(1),source_voice_sha256:fingerprint(2),source_mix_sha256:fingerprint(1),
      source_kind:'piano',chain_method:'voice-local-piano-shared-spectral-headroom-v1',sample_rate:44100,samples:352800,
      axis:'full_mix',interval:[22050,330750],versions:[version(left),version(record)]},
    motion:{axis:'vocal_only',method:'500ms RMS relative to each version outside-ROI context',before:levels,after:levels,
      periodic:{status:'unknown',reason:'provider_contract_unavailable',required_provider:'issue27-cc-pyin-observation-v1'}},
    quality:{axis:'vocal_only',method:'same-time vocal-component Praat CPPS and HNR observations',before:{cpps:15,hnr:4},after:{cpps:14,hnr:3}},
    timbre:{axis:'vocal_only',method:'vocal-component 2-3kHz / 100-8000Hz spectral power ratio',
      before:{windows:699,available:699,median_db:-8,min_db:-20,max_db:-2},after:{windows:699,available:699,median_db:-7,min_db:-18,max_db:-1}},
    preservation:{protected_voice_equal:true,protected_mix_equal:true,estimated_residual_equal:true,changed_voice_samples_in_selection:100},
    perceptual_inference:{status:'unknown',reason:'human_judgment_required'}}};
  return record;
}

test('complete measured feedback rejects wrong mixture axis, U identity, and protection damage',()=>{
  const step=continuationFlow('piano',{carryPianoWithdrawal:true}).cases[0],record=measured(step);
  assert.equal(checkMeasuredVersion(step,record,reference()),true);
  const axis=structuredClone(record);axis.feedback.summary.binding.axis='vocal_only';
  assert.throws(()=>checkMeasuredVersion(step,axis,reference()),/archive_feedback_mismatch/);
  const oldU=structuredClone(record);oldU.feedback.summary.binding.versions[0].sha256=fingerprint(8);
  assert.throws(()=>checkMeasuredVersion(step,oldU,reference()),/archive_feedback_mismatch/);
  const damaged=structuredClone(record);damaged.feedback.summary.preservation.protected_voice_equal=false;
  assert.throws(()=>checkMeasuredVersion(step,damaged,reference()),/feedback_preservation/);
});

test('final choice accepts an earlier measured C with its own complete draft and rejects another case caption',()=>{
  const flow=continuationFlow('piano',{carryPianoWithdrawal:true}),record=measured(flow.cases[0]);
  assert.deepEqual(checkFinalChoice(flow,'M-front',record,{...reference(),accepted:{'M-front':record},availableIds:[record.result.id]}),{
    intents:[{kind:'M',amount:.5,mode:'front',held:false,start_frame:681,end_frame:1046}],preserve:[]});
  assert.throws(()=>checkFinalChoice(flow,'M-back',record,reference()),/version_control/);
});

test('final saving requires the actual available accepted cache and refuses altered observation values',()=>{
  const flow=continuationFlow('piano',{carryPianoWithdrawal:true}),step=flow.cases[0],record=measured(step);
  const context={...reference(),accepted:{'M-front':structuredClone(record)},availableIds:[record.result.id]};
  const altered=structuredClone(record);altered.feedback.summary.quality.after.cpps+=1;
  assert.throws(()=>checkFinalChoice(flow,'M-front',altered,context),/final_cache/);
  assert.throws(()=>checkFinalChoice(flow,'M-front',record,{...context,availableIds:[]}),/final_available/);
  assert.throws(()=>checkFinalChoice(flow,'M-front',record,{...context,accepted:{}}),/final_cache/);
});

test('version identity and scales keep the existing full metadata types',()=>{
  const step=continuationFlow('piano',{carryPianoWithdrawal:true}).cases[0],record=completed(step);
  record.result.id='E:garbage';assert.throws(()=>checkCurrentVersion(step,record,reference()),/version_identity/);
  record.result.id='E:'+fingerprint(5);record.spectral_delta_scales=[];
  assert.throws(()=>checkCurrentVersion(step,record,reference()),/version_scale/);
});

test('the U reference itself must be the same source and zero-control baseline',()=>{
  const step=continuationFlow('piano',{carryPianoWithdrawal:true}).cases[0],record=completed(step),context=reference();
  context.baseline.source={...context.source,voice_sha256:fingerprint(8)};
  assert.throws(()=>checkCurrentVersion(step,record,context),/baseline_source/);
  context.baseline.source=context.source;context.baseline.result.id='E:'+fingerprint(5);
  assert.throws(()=>checkCurrentVersion(step,record,context),/baseline_identity/);
});

test('final save restores the selected draft and its actual listening snapshot without a new render',()=>{
  const flow=continuationFlow('piano',{carryPianoWithdrawal:true}),record=measured(flow.cases[0]),page=frontPage();
  page.listening={start:.5,end:7.5,mode:'local'};
  const context={...reference(),accepted:{'M-front':record},availableIds:[record.result.id],
    acceptedListening:{'M-front':{start:.5,end:7.5,mode:'local'}}};
  assert.equal(checkFinalPage(flow,'M-front',page,context,page.header),true);
  page.listening.start=1;
  assert.throws(()=>checkFinalPage(flow,'M-front',page,context,page.header),/final_listening/);
  page.listening.start=.5;page.form.mode='back';
  assert.throws(()=>checkFinalPage(flow,'M-front',page,context,page.header),/page_form/);
});
