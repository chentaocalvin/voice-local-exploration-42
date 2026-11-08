// SPDX-License-Identifier: GPL-3.0-or-later
const contracts = Object.freeze({motion:'issue27-v2-core-handoff-v1',
  quality:'issue28-v2-core-handoff-v1', preservation:'issue29-v2-core-consumption-contract-v1'});
const motionMethod = '500ms RMS relative to each version outside-ROI context';
const qualityMethod = 'same-time vocal-component Praat CPPS and HNR observations';
const timbreMethod = 'vocal-component 2-3kHz / 100-8000Hz spectral power ratio';
const periodic = Object.freeze({status:'unknown', reason:'provider_contract_unavailable',
  required_provider:'issue27-cc-pyin-observation-v1'});
const perceptual = Object.freeze({status:'unknown', reason:'human_judgment_required'});
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const scalar = value => value === null || Number.isFinite(value);

function spectrumSummary(observations) {
  const values = observations.map(item=>item.ratio_db).filter(Number.isFinite).sort((a,b)=>a-b);
  const middle = values.length >> 1;
  return {windows:observations.length, available:values.length,
    median_db:values.length ? (values.length % 2 ? values[middle] : (values[middle-1]+values[middle])/2) : null,
    min_db:values.length ? values[0] : null, max_db:values.length ? values.at(-1) : null};
}

export function coreFeedbackSummary(binding, report) {
  const summary = {schema:'voice-local-core-feedback-summary-v1', contracts:{...contracts},
    binding:structuredClone(binding),
    motion:{axis:'vocal_only', method:motionMethod, before:structuredClone(report.motion.before),
      after:structuredClone(report.motion.after), periodic:{...periodic}},
    quality:{axis:'vocal_only', method:qualityMethod, before:{...report.quality.before}, after:{...report.quality.after}},
    timbre:{axis:'vocal_only', method:timbreMethod, before:spectrumSummary(report.timbre.before), after:spectrumSummary(report.timbre.after)},
    preservation:{...report.preservation}, perceptual_inference:{...perceptual}};
  return checkCoreFeedbackSummary(summary,binding);
}

export function checkCoreFeedbackSummary(summary, binding) {
  const fail = () => {throw new Error('archive_feedback_mismatch');};
  if (!exact(summary,['schema','contracts','binding','motion','quality','timbre','preservation','perceptual_inference']) ||
      summary.schema !== 'voice-local-core-feedback-summary-v1' || !same(summary.contracts,contracts) ||
      !same(summary.binding,binding) || !same(summary.perceptual_inference,perceptual) ||
      new TextEncoder().encode(JSON.stringify(summary)).length > 32768) fail();
  const {motion,quality,timbre,preservation}=summary;
  if (!exact(motion,['axis','method','before','after','periodic']) || motion.axis !== 'vocal_only' ||
      motion.method !== motionMethod || !same(motion.periodic,periodic) ||
      !exact(quality,['axis','method','before','after']) || quality.axis !== 'vocal_only' || quality.method !== qualityMethod ||
      !exact(timbre,['axis','method','before','after']) || timbre.axis !== 'vocal_only' || timbre.method !== timbreMethod) fail();
  const [start,end]=binding.interval;
  for (const levels of [motion.before,motion.after]) {
    if (!Array.isArray(levels) || levels.length !== Math.floor((end-start)/22050)) fail();
    levels.forEach((cell,index)=>{
      if (!exact(cell,['interval','relative_db']) || !same(cell.interval,[start+index*22050,start+(index+1)*22050]) ||
          !scalar(cell.relative_db)) fail();
    });
  }
  for (const value of [quality.before,quality.after]) if (!exact(value,['cpps','hnr']) || !scalar(value.cpps) || !scalar(value.hnr)) fail();
  const windows = Math.max(0,Math.floor((end-start-882)/441)+1);
  for (const value of [timbre.before,timbre.after]) {
    if (!exact(value,['windows','available','median_db','min_db','max_db']) || value.windows !== windows ||
        !Number.isSafeInteger(value.available) || value.available<0 || value.available>windows ||
        ![value.median_db,value.min_db,value.max_db].every(scalar) ||
        (value.available === 0 ? [value.median_db,value.min_db,value.max_db].some(v=>v!==null)
          : ![value.median_db,value.min_db,value.max_db].every(Number.isFinite) ||
            value.min_db>value.median_db || value.median_db>value.max_db)) fail();
  }
  if (!exact(preservation,['protected_voice_equal','protected_mix_equal','estimated_residual_equal','changed_voice_samples_in_selection']) ||
      typeof preservation.protected_voice_equal !== 'boolean' ||
      (binding.source_kind === 'solo' ? preservation.protected_mix_equal !== null || preservation.estimated_residual_equal !== null
        : typeof preservation.protected_mix_equal !== 'boolean' || typeof preservation.estimated_residual_equal !== 'boolean') ||
      !Number.isSafeInteger(preservation.changed_voice_samples_in_selection) ||
      preservation.changed_voice_samples_in_selection<0 || preservation.changed_voice_samples_in_selection>end-start) fail();
  return structuredClone(summary);
}

export function unavailablePeriodicObservation() {return {...periodic};}

// The archive follows the selected cached result, independently of the last comparison.
export function archiveCoreFeedback(summary, binding) {
  if (summary == null) return {comparison:null, feedback:null};
  const feedback = checkCoreFeedbackSummary(summary,binding);
  const [left,right] = binding.versions;
  return {comparison:{input_sha256:binding.input_sha256, axis:binding.axis, interval:binding.interval.slice(),
    left:left.id, right:right.id, left_sha256:left.sha256, right_sha256:right.sha256}, feedback};
}
