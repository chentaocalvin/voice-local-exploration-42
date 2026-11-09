// SPDX-License-Identifier: GPL-3.0-or-later
const schema='voice-motion-limit-diagnostic-v1';
const numericFields=['frame','amount','start_frame','end_frame','sourceHz','targetHz','cents','raw','weight',
  'residual','shifted_residual','shift_source_frame','support_start','support_end'];
const nullableFields=new Set(['shifted_residual','shift_source_frame','support_start','support_end']);

function diagnostic(context,violations) {
  const record={schema};
  let finite=true;
  for(const key of numericFields) {
    const value=context[key];
    if(nullableFields.has(key)&&value===null)record[key]=null;
    else if(typeof value==='number'&&Number.isFinite(value))record[key]=value;
    else {record[key]=null;finite=false;}
  }
  record.mode=['flat','front','back','shift'].includes(context.mode)?context.mode:null;
  if(record.mode===null)finite=false;
  const time=record.frame===null?null:record.frame*.005;
  record.time_seconds=Number.isFinite(time)?time:null;
  if(record.time_seconds===null)finite=false;
  record.finite=finite;
  record.violations={cents:violations.cents,frequency:violations.frequency};
  record.thresholds={absolute_cents:50,cents_epsilon:1e-9,min_target_hz:71,max_target_hz:800};
  return record;
}

export function checkMotionLimit(context) {
  const {cents,targetHz}=context;
  if (Math.abs(cents) > 50 + 1e-9 || (cents !== 0 && (targetHz < 71 || targetHz > 800))) {
    const error=new Error('signed_motion_limit');
    error.motionLimit=diagnostic(context,{cents:Math.abs(cents)>50+1e-9,
      frequency:cents!==0&&(targetHz<71||targetHz>800)});
    throw error;
  }
}

export function motionLimitFailureRecord(error) {
  if(error?.message!=='signed_motion_limit')return undefined;
  const value=error.motionLimit;
  if(!value||Array.isArray(value)||typeof value!=='object'||value.schema!==schema||
    typeof value.violations?.cents!=='boolean'||typeof value.violations?.frequency!=='boolean')return undefined;
  const record=diagnostic(value,value.violations);
  record.finite=record.finite&&value.finite===true;
  return record;
}
