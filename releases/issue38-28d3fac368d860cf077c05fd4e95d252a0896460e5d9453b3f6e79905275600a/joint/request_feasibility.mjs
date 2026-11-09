// SPDX-License-Identifier: GPL-3.0-or-later
import {checkMotionLimit,motionLimitFailureRecord} from './motion_limit.mjs';
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const dense=(value,maximum)=>Array.isArray(value)&&value.length<=maximum&&Object.keys(value).length===value.length&&
  Array.from({length:value.length},(_,index)=>Object.hasOwn(value,index)).every(Boolean);
const range=value=>dense(value,2)&&value.length===2&&value.every(Number.isSafeInteger)&&value[0]>=0&&value[1]>value[0];
function binding(context,draft) {
  if(!exactKeys(context,['voice_sha256','mix_sha256','profile','method','analysis_generation'])||
    !hash(context.voice_sha256)||!(context.mix_sha256===null||hash(context.mix_sha256))||
    !text(context.profile)||!text(context.method)||!text(context.analysis_generation)||
    !exactKeys(draft,['intents','preserve'])||!dense(draft.intents,3)||
    !dense(draft.preserve,16)||!draft.preserve.every(range))return null;
  const seen=new Set(),intents=[];
  for(const item of draft.intents) {
    if(!exactKeys(item,['kind','start_frame','end_frame','amount','mode','held'])||!['M','Q','T'].includes(item.kind)||
      seen.has(item.kind)||!range([item.start_frame,item.end_frame])||typeof item.amount!=='number'||!Number.isFinite(item.amount)||
      !['flat','front','back','shift'].includes(item.mode)||typeof item.held!=='boolean')return null;
    seen.add(item.kind);intents.push([item.kind,item.start_frame,item.end_frame,item.amount,item.mode,item.held]);
  }
  return JSON.stringify([context.voice_sha256,context.mix_sha256,context.profile,context.method,
    context.analysis_generation,intents,draft.preserve]);
}

function trustedMotionRecord(error) {
  const record=motionLimitFailureRecord(error);
  if(!record||record.finite!==true||!Number.isSafeInteger(record.frame)||record.frame<0||
    !range([record.start_frame,record.end_frame])||record.frame<record.start_frame||record.frame>=record.end_frame)return null;
  // Re-use the existing scalar guard. This cache neither defines nor relaxes a sound threshold.
  let authoritative;
  try {checkMotionLimit(record);}catch(refusal){authoritative=motionLimitFailureRecord(refusal);}
  if(!authoritative||authoritative.finite!==true||
    authoritative.violations.cents!==record.violations.cents||authoritative.violations.frequency!==record.violations.frequency)return null;
  return authoritative;
}

export function motionLimitMessage(error) {
  const record=trustedMotionRecord(error);
  if(!record)return null;
  const number=value=>Number(value.toFixed(3)).toString(),parts=[];
  if(record.violations.cents)parts.push(`音高改变量${number(record.cents)}音分，超出±${number(record.thresholds.absolute_cents)}音分`);
  if(record.violations.frequency)parts.push(`变化后频率${number(record.targetHz)}Hz，超出${number(record.thresholds.min_target_hz)}–${number(record.thresholds.max_target_hz)}Hz`);
  return `当前设置在${record.time_seconds.toFixed(3)}秒超出音高安全限制：${parts.join('；')}。本次没有生成新版本。`;
}

export function createRequestFeasibility() {
  let current=null;
  function view(context,draft) {
    const key=binding(context,draft);
    if(key===null||current?.key!==key)current=null;
    return current?structuredClone(current.value):{status:'unknown'};
  }
  return {view,
    reject(context,draft,error) {
      view(context,draft);const key=binding(context,draft),record=trustedMotionRecord(error);
      if(key!==null&&record&&draft.intents.some(item=>item.kind==='M'&&!item.held&&item.mode===record.mode&&
        item.amount===record.amount&&item.start_frame===record.start_frame&&item.end_frame===record.end_frame))
        current={key,value:{status:'unavailable',motionLimit:record}};
      return view(context,draft);
    },
    generated(context,draft,resultId) {
      view(context,draft);const key=binding(context,draft);
      if(key!==null&&text(resultId))current={key,value:{status:'generated',resultId}};
      return view(context,draft);
    },
    clear(){current=null;},
  };
}
