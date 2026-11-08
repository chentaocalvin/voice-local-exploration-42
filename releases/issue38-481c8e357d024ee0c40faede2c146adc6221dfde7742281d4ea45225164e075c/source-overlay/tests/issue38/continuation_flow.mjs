import {fixedCombinationPlan} from './fixed_combination_plan.mjs';
import {isDeepStrictEqual} from 'node:util';
import {checkCoreFeedbackSummary} from '../../issue42/joint/exploration_feedback.mjs';

const labels={M:'声音运动',Q:'声质',T:'音色'};
const developments={flat:'均匀',front:'前半展开',back:'后半展开',shift:'将原变化后移0.25秒'};
const range=([start,end])=>`${(start/200).toFixed(3)}–${(end/200).toFixed(3)} 秒`;
const fail=code=>{throw new Error('continuation_'+code);};
const equal=(left,right,code)=>{if(!isDeepStrictEqual(left,right))fail(code);};
const text=row=>row.filter(node=>node.role==='AXStaticText').map(node=>node.value.trim());

export function continuationFlow(kind,{carryPianoWithdrawal=false}={}) {
  const original=fixedCombinationPlan(kind);
  const cases=structuredClone(original.continued).filter(item=>
    !(kind==='piano'&&carryPianoWithdrawal&&['withdraw-T','restore-T'].includes(item.name)));
  return {kind,realSDKAuthorized:false,carryPianoWithdrawal,
    cases:cases.map(item=>({...item,kind,
      manualToggle:item.name.startsWith('withdraw-')||item.name.startsWith('restore-'),
      listen:!['seed','U'].includes(item.expected)})),
    expectedCounts:{make_version:4+cases.length,compare:1+cases.filter(item=>item.compare).length,save:2,open:2}};
}

export function checkPageDraft(step,page,expectedHeader) {
  equal(page.header,expectedHeader,'page_source');
  if(page.generateEnabled!==true)fail('page_unavailable');
  equal(page.intentRows.length,step.draft.intents.length,'page_intents');
  step.draft.intents.forEach((item,index)=>{
    equal(text(page.intentRows[index]),[`${labels[item.kind]} · ${range([item.start_frame,item.end_frame])} · ${item.amount} · ${developments[item.mode]}${item.held?' · 已撤回':''}`],'page_intents');
    const actions=page.intentRows[index].filter(node=>node.role==='AXButton').map(node=>node.name);
    if(!actions.includes(item.held?'恢复':'撤回')||actions.includes(item.held?'撤回':'恢复'))fail('page_held');
  });
  equal(page.protectionRows.map(text),step.draft.preserve.map(item=>[`${range(item)} · 全部编辑类`]),'page_protection');
  const active=step.draft.intents.find(item=>item.kind===page.form.kind);
  if(!active)fail('page_form');
  equal(page.form,{kind:active.kind,amount:active.amount,mode:active.mode,
    start:active.start_frame/200,end:active.end_frame/200,held:active.held},'page_form');
  return true;
}

export function checkCurrentVersion(step,record,context) {
  equal(context.baseline?.source,context.source,'baseline_source');
  equal(context.baseline?.result?.id,'U','baseline_identity');
  equal(context.baseline?.control,{intents:[],preserve:[]},'baseline_identity');
  if(record.schema!=='voice-version-record-v1')fail('version_schema');
  equal(record.source,context.source,'version_source');
  equal(record.source.kind,step.kind,'version_source');
  equal(record.source.samples,352800,'version_source');
  equal(record.source.sample_rate,44100,'version_source');
  equal(record.control,step.draft,'version_control');
  equal(record.region,[100,1500],'version_region');
  if(!/^E:[0-9a-f]{64}$/.test(record.result?.id)||!['sha256','voice_sha256'].every(key=>/^[0-9a-f]{64}$/.test(record.result?.[key])))fail('version_identity');
  if(!Array.isArray(record.sample_regions)||record.sample_regions.some(item=>!Array.isArray(item)||item.length!==2||
    !item.every(Number.isSafeInteger)||item[0]<22050||item[1]>330750||item[0]>=item[1]))fail('version_regions');
  const scales=record.spectral_delta_scales;
  if(!scales||Array.isArray(scales)||typeof scales!=='object'||Object.entries(scales).some(([key,value])=>!['Q','T'].includes(key)||!Number.isFinite(value)||value<.5||value>1))fail('version_scale');
  if(step.expected!=='U') {
    const expected=step.draft.intents.filter(item=>['Q','T'].includes(item.kind)&&!item.held&&item.amount!==0).map(item=>item.kind).sort();
    equal(Object.keys(scales).sort(),expected,'version_scale');
  }
  if(step.expected==='seed')for(const key of ['result','source','control','region','sample_regions','spectral_delta_scales'])
    equal(record[key],context.seed?.[key],'expected_seed');
  if(step.expected==='U')for(const key of ['sha256','voice_sha256'])equal(record.result[key],context.baseline.result[key],'expected_U');
  return true;
}

function feedbackBinding(record,context) {
  const source=record.source;
  const identity=version=>({id:version.result.id,sha256:version.result.sha256,voice_sha256:version.result.voice_sha256,
    spectral_delta_scales:version.spectral_delta_scales,control:version.control});
  return {input_sha256:source.input_sha256,source_voice_sha256:source.voice_sha256,source_mix_sha256:source.mix_sha256,
    source_kind:source.kind,chain_method:source.method_version,sample_rate:44100,samples:352800,
    axis:source.kind==='piano'?'full_mix':'vocal_only',interval:[22050,330750],versions:[identity(context.baseline),identity(record)]};
}

function checkedFeedback(record,context,statuses) {
  if(!statuses.includes(record.feedback?.status))fail('feedback_status');
  const summary=checkCoreFeedbackSummary(record.feedback.summary,feedbackBinding(record,context));
  if(summary.preservation.protected_voice_equal!==true||
    (record.source.kind==='piano'&&(summary.preservation.protected_mix_equal!==true||summary.preservation.estimated_residual_equal!==true)))fail('feedback_preservation');
  return summary;
}

export function checkMeasuredVersion(step,record,context) {
  checkCurrentVersion(step,record,context);
  if(!step.compare)fail('unexpected_compare');
  checkedFeedback(record,context,['measured']);
  return true;
}

export function checkFinalChoice(flow,choice,record,context) {
  const step=choice==='seed'?{kind:flow.kind,draft:context.seed.control,expected:'seed'}:
    flow.cases.find(item=>item.name===choice&&item.compare);
  if(!step)fail('final_pool');
  checkCurrentVersion(step,record,context);
  if(!context.availableIds?.includes(record.result.id))fail('final_available');
  const accepted=context.accepted?.[choice];
  if(!accepted)fail('final_cache');
  for(const key of ['result','source','control','region','sample_regions','spectral_delta_scales'])equal(record[key],accepted[key],'final_cache');
  equal(record.feedback?.summary,accepted.feedback?.summary,'final_cache');
  checkedFeedback(record,context,['measured','archived_not_remeasured']);
  return structuredClone(record.control);
}

export function checkFinalPage(flow,choice,page,context,expectedHeader) {
  const accepted=context.accepted?.[choice];
  if(!accepted)fail('final_cache');
  const draft=checkFinalChoice(flow,choice,accepted,context);
  checkPageDraft({kind:flow.kind,draft},page,expectedHeader);
  const listening=context.acceptedListening?.[choice];
  if(!listening||!['local','whole'].includes(listening.mode)||
    ![listening.start,listening.end].every(Number.isFinite)||listening.start<0||listening.end>8||listening.end<=listening.start)fail('final_listening');
  equal(page.listening,listening,'final_listening');
  return true;
}
