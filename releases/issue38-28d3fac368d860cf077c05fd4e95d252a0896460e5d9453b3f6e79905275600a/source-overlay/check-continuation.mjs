import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {continuationFlow,checkPageDraft,checkCurrentVersion,checkMeasuredVersion,checkFinalChoice,checkFinalPage} from './tests/issue38/continuation_flow.mjs';
import {parseNativePageSnapshot} from './prepare-continuation.mjs';

const [kind,name,stage,contextPath,evidencePath,operationPath,attestationPath]=process.argv.slice(2);
if(!['piano','solo'].includes(kind)||!['page','current','measured','final','final-page'].includes(stage)||!operationPath)
  throw new Error('usage: kind case page|current|measured|final|final-page context.json evidence.json operation.json [export-attestation.json]');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const context=read(contextPath),evidenceBytes=readFileSync(evidencePath),operationBytes=readFileSync(operationPath);
const evidence=JSON.parse(evidenceBytes),operation=JSON.parse(operationBytes);
if(!/^[0-9a-f]{64}$/.test(context.run_id)||!Number.isSafeInteger(context.pid)||context.pid<=0||
  operation.pid!==context.pid||operation.returncode!==0||operation.body!==context.operation)
  throw new Error('continuation_operation_owner');
const time=operation.epoch*1000;
if(!Number.isFinite(time)||!Number.isFinite(context.window?.not_before)||!Number.isFinite(context.window?.expires)||
  time<context.window.not_before||time>=context.window.expires)throw new Error('continuation_operation_window');
if(['current','measured','final'].includes(stage)) {
  const binding=attestationPath?read(attestationPath):null;
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const match=/^voice-project-([0-9]+)\.json$/.exec(binding?.download??'');
  const stamp=Number(match?.[1]);
  if(binding?.schema!=='voice-current-export-binding-v1'||binding.operation_sha256!==digest(operationBytes)||
    binding.bytes!==evidenceBytes.length||binding.sha256!==digest(evidenceBytes)||!match||
    stamp<Math.floor(time)||stamp>time+55000||!Number.isFinite(binding.download_mtime_ms)||
    binding.download_mtime_ms<time||binding.download_mtime_ms>time+55000)
    throw new Error('continuation_export_binding');
}
const flow=continuationFlow(kind,{carryPianoWithdrawal:kind==='piano'});
const step=flow.cases.find(item=>item.name===name);
const header=`J:${context.run_id}:${kind}:seed`;
if(stage==='final')checkFinalChoice(flow,name,evidence,context);
else if(stage==='final-page')checkFinalPage(flow,name,parseNativePageSnapshot(operation.stdout),context,header);
else {
  if(!step)throw new Error('continuation_case_missing');
  if(stage==='page')checkPageDraft(step,parseNativePageSnapshot(operation.stdout),header);
  if(stage==='current')checkCurrentVersion(step,evidence,context);
  if(stage==='measured')checkMeasuredVersion(step,evidence,context);
}
process.stdout.write(JSON.stringify({kind,name,stage,metadataMatched:true,realSDKActions:0,
  scope:'metadata alignment only; authorization, live window, exclusive actor receipts and human gates remain required'})+'\n');
