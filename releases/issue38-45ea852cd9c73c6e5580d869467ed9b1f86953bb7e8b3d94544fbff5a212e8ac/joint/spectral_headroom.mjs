// SPDX-License-Identifier: GPL-3.0-or-later
function refusal(stage,code,details) {
  return Object.assign(new Error(code),{headroom:{stage,...details}});
}

export function headroomFailureRecord(error) {
  const value=error?.headroom;
  if(!value||!['Q','T'].includes(value.stage))return undefined;
  const {stage}=value;
  if(error.message==='spectral_headroom_nonfinite'&&value.finite===false&&
      Number.isSafeInteger(value.sample)&&value.sample>=0&&value.sample<352800)
    return {stage,finite:false,sample:value.sample};
  if(error.message==='spectral_headroom_insufficient'&&value.finite===true&&
      Number.isFinite(value.scale_upper_bound)&&value.scale_upper_bound>=0&&value.scale_upper_bound<=1&&
      typeof value.intersection_empty==='boolean')
    return {stage,finite:true,scale_upper_bound:value.scale_upper_bound,intersection_empty:value.intersection_empty};
  if(error.message==='spectral_headroom_pcm_limit'&&value.finite===true&&
      Number.isFinite(value.scale)&&value.scale>=.5&&value.scale<=1&&Number.isFinite(value.encoded_peak)&&value.encoded_peak>=0)
    return {stage,finite:true,scale:value.scale,encoded_peak:value.encoded_peak};
  return undefined;
}

export function spectralDeltaScale({stage,voice,mix,edited,source}) {
  if((stage!=='Q'&&stage!=='T')||!(edited instanceof Float64Array)||!edited.length||
      ![voice,mix,source?.voice,source?.mix].every(values=>values instanceof Float64Array&&values.length===edited.length))
    throw new Error('spectral_headroom_axis');
  const target=2*.979;
  let lower=0,scale=1,exceeds=false;
  for(let i=0;i<edited.length;i++) {
    const original=voice[i],reference=mix[i],proposed=edited[i];
    const sourceVoice=source.voice[i],sourceMix=source.mix[i];
    const delta=proposed-original,combined=sourceMix+proposed-sourceVoice;
    if(!Number.isFinite(original)||!Number.isFinite(reference)||!Number.isFinite(proposed)||
        !Number.isFinite(sourceVoice)||!Number.isFinite(sourceMix)||!Number.isFinite(delta)||!Number.isFinite(combined))
      throw refusal(stage,'spectral_headroom_nonfinite',{finite:false,sample:i});
    exceeds ||= Math.abs(proposed*.5)>.98||Math.abs(combined*.5)>.98;
    if(delta!==0) {
      const sign=Math.sign(delta),magnitude=Math.abs(delta);
      scale=Math.min(scale,(target-sign*original)/magnitude,(target-sign*reference)/magnitude);
      lower=Math.max(lower,(-target-sign*original)/magnitude,(-target-sign*reference)/magnitude);
    } else if(Math.abs(original)>target||Math.abs(reference)>target)lower=Infinity;
  }
  if(!exceeds)return {stage,scale:1};
  if(scale<.5||scale<lower)throw refusal(stage,'spectral_headroom_insufficient',
    {finite:true,scale_upper_bound:Math.max(0,Math.min(1,scale)),intersection_empty:scale<lower});
  return {stage,scale};
}
