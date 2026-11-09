// SPDX-License-Identifier: GPL-3.0-or-later
// Writes source text only. Never discovers a browser, reads a gate or executes native UI.
import {mkdir,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {continuationFlow} from './tests/issue38/continuation_flow.mjs';

const main='UI element 3 of UI element 1 of UI element 1 of UI element 1 of UI element 4 of UI element 1 of window 1 of application process targetIndex';
const edit='UI element 2 of UI element 9 of '+main;
const listen='UI element 7 of '+main;
const player='UI element 1 of UI element 7 of '+listen;
const quote=JSON.stringify;
const digest=text=>createHash('sha256').update(text).digest('hex');
const kinds={M:'声音运动',Q:'声质',T:'音色'};
const modes={flat:'均匀作用',front:'前半展开，后半保留',back:'前半保留，后半展开',shift:'将原变化后移0.25秒'};
const headerGuard=header=>`if value of UI element 1 of UI element 1 of ${listen} is not ${quote(header)} then error "continuation_header_mismatch"\n`;
const press=(path,title)=>`if name of ${path} is not ${quote(title)} then error "continuation_button_mismatch"\nif not enabled of ${path} then error "continuation_button_disabled"\nperform action "AXPress" of ${path}\n`;
const heldGroup='UI element 3 of UI element 1 of '+edit;
function probeHeld(path) {
  return `if (role of ${path} as text) is "AXCheckBox" then
set heldName to name of ${path} as text
set heldDescription to description of ${path} as text
if heldName is "暂时撤回这一项" or heldDescription is "暂时撤回这一项" then
set heldMatches to heldMatches + 1
set heldValue to value of ${path} as integer
end if
end if
`;
}
function snapshotRows(kind,path) {
  const child=`UI element childIndex of UI element rowIndex of ${path}`;
  return `if (count UI elements of ${path}) is greater than ${kind==='INTENT'?3:2} then error "continuation_snapshot_row_bound"
repeat with rowIndex from 1 to count UI elements of ${path}
repeat with childIndex from 1 to count UI elements of UI element rowIndex of ${path}
set childRole to role of ${child} as text
set childName to ""
set childValue to ""
try
if name of ${child} is not missing value then set childName to name of ${child} as text
end try
try
if value of ${child} is not missing value then set childValue to value of ${child} as text
end try
if childName contains tabText or childName contains lineText or childValue contains tabText or childValue contains lineText then error "continuation_snapshot_delimiter"
set outputText to outputText & "${kind}" & tabText & (rowIndex as text) & tabText & childRole & tabText & childName & tabText & childValue & lineText
end repeat
end repeat
`;
}

// Normal AX output is deliberately a small text protocol, not hidden browser state.
// The root parser rejects delimiters, unknown cells and an absent/ambiguous held checkbox.
function readPage(header) {
  return headerGuard(header)+`set tabText to tab
set lineText to linefeed
set outputText to "HEADER" & tabText & (value of UI element 1 of UI element 1 of ${listen} as text) & lineText
set outputText to outputText & "GENERATE" & tabText & (enabled of UI element 3 of UI element 9 of ${main} as text) & lineText
set outputText to outputText & "FORM_KIND" & tabText & (value of UI element 2 of UI element 1 of ${edit} as text) & lineText
set outputText to outputText & "FORM_AMOUNT" & tabText & (value of UI element 5 of ${edit} as text) & lineText
set outputText to outputText & "FORM_MODE" & tabText & (value of UI element 13 of ${edit} as text) & lineText
set outputText to outputText & "FORM_START" & tabText & (value of UI element 2 of UI element 10 of ${edit} as text) & lineText
set outputText to outputText & "FORM_END" & tabText & (value of UI element 2 of UI element 11 of ${edit} as text) & lineText
set outputText to outputText & "LISTEN_LOCAL" & tabText & (value of UI element 1 of UI element 8 of ${listen} as text) & lineText
set outputText to outputText & "LISTEN_WHOLE" & tabText & (value of UI element 1 of UI element 9 of ${listen} as text) & lineText
set outputText to outputText & "LISTEN_START" & tabText & (value of UI element 2 of UI element 12 of ${listen} as text) & lineText
set outputText to outputText & "LISTEN_END" & tabText & (value of UI element 2 of UI element 13 of ${listen} as text) & lineText
set heldMatches to 0
set heldValue to -1
`+probeHeld(heldGroup)+`repeat with heldI from 1 to count UI elements of ${heldGroup}
`+probeHeld('UI element heldI of '+heldGroup)+`repeat with heldJ from 1 to count UI elements of UI element heldI of ${heldGroup}
`+probeHeld('UI element heldJ of UI element heldI of '+heldGroup)+`end repeat
end repeat
if heldMatches is not 1 or (heldValue is not 0 and heldValue is not 1) then error "continuation_checkbox_not_uniquely_observed"
set outputText to outputText & "FORM_HELD" & tabText & (heldValue as text) & lineText
`+snapshotRows('INTENT','UI element 7 of UI element 1 of '+edit)
    +snapshotRows('PROTECT','UI element 10 of UI element 1 of '+edit)+'return outputText\n';
}

export function parseNativePageSnapshot(text) {
  const fields=new Map(),intentRows=[],protectionRows=[];
  for(const line of text.split(/\r?\n/).filter(Boolean)) {
    const cells=line.split('\t'),key=cells[0];
    if(key==='INTENT'||key==='PROTECT') {
      if(cells.length!==5||!/^\d+$/.test(cells[1])||Number(cells[1])<1||Number(cells[1])>(key==='INTENT'?3:2))throw Error('native_snapshot_row');
      const rows=key==='INTENT'?intentRows:protectionRows,index=Number(cells[1])-1;
      (rows[index]??=[]).push({role:cells[2],name:cells[3],value:cells[4]});
    } else {
      if(cells.length!==2||fields.has(key)||!['HEADER','GENERATE','FORM_KIND','FORM_AMOUNT','FORM_MODE','FORM_START','FORM_END','FORM_HELD','LISTEN_LOCAL','LISTEN_WHOLE','LISTEN_START','LISTEN_END'].includes(key))throw Error('native_snapshot_field');
      fields.set(key,cells[1]);
    }
  }
  if(fields.size!==12||!['true','false'].includes(fields.get('GENERATE'))||!['0','1'].includes(fields.get('FORM_HELD')))throw Error('native_snapshot_incomplete');
  if(!['0','1'].includes(fields.get('LISTEN_LOCAL'))||!['0','1'].includes(fields.get('LISTEN_WHOLE'))||fields.get('LISTEN_LOCAL')===fields.get('LISTEN_WHOLE'))throw Error('native_snapshot_listening');
  const listening={start:Number(fields.get('LISTEN_START')),end:Number(fields.get('LISTEN_END')),mode:fields.get('LISTEN_LOCAL')==='1'?'local':'whole'};
  if(['LISTEN_START','LISTEN_END'].some(k=>fields.get(k).trim()==='')||![listening.start,listening.end].every(Number.isFinite)||listening.start<0||listening.end<=listening.start||listening.end>8)throw Error('native_snapshot_listening');
  for(const rows of [intentRows,protectionRows])for(let i=0;i<rows.length;i++)if(!Object.hasOwn(rows,i))throw Error('native_snapshot_row_gap');
  const kind=Object.keys(kinds).find(k=>kinds[k]===fields.get('FORM_KIND'));
  const mode=Object.keys(modes).find(k=>modes[k]===fields.get('FORM_MODE'));
  const values=['FORM_AMOUNT','FORM_START','FORM_END'].map(k=>fields.get(k).trim());
  if(!kind||!mode||values.some(v=>v===''||!Number.isFinite(Number(v))))throw Error('native_snapshot_form');
  return {header:fields.get('HEADER'),generateEnabled:fields.get('GENERATE')==='true',intentRows,protectionRows,listening,
    form:{kind,amount:Number(values[0]),mode,start:Number(values[1]),end:Number(values[2]),held:fields.get('FORM_HELD')==='1'}};
}

function observe(header,done) {
  return headerGuard(header)+`repeat 110 times
set observedStatus to value of UI element 1 of UI element 1 of ${main} as text
if observedStatus starts with ${quote(done)} then return observedStatus
if observedStatus contains "未完成" or observedStatus contains "未通过" or observedStatus contains "不一致" or observedStatus contains "用尽" or observedStatus contains "已停止" then error "continuation_observed_failure_no_retry"
delay 0.3
end repeat
return "PENDING_NO_RETRY"
`;
}

function play(header,role,mode) {
  const roleIndex=role==='U'?2:3,title=role==='U'?'同链参考':'新声音',radio=mode==='local'?8:9,start=mode==='local'?500:0;
  return headerGuard(header)+`set followValue to value of UI element 1 of UI element 11 of ${listen} as integer
if followValue is not 0 and followValue is not 1 then error "continuation_follow_not_observed"
if followValue is 1 then perform action "AXPress" of UI element 1 of UI element 11 of ${listen}
if (value of UI element 1 of UI element 11 of ${listen} as integer) is not 0 then error "continuation_follow_not_cleared"
set existingStart to value of UI element 2 of UI element 12 of ${listen} as real
set existingEnd to value of UI element 2 of UI element 13 of ${listen} as real
if existingStart is greater than or equal to 7.5 then
if existingStart is not 0.5 then set value of UI element 2 of UI element 12 of ${listen} to 0.5
end if
if existingEnd is not 7.5 then set value of UI element 2 of UI element 13 of ${listen} to 7.5
if (value of UI element 2 of UI element 12 of ${listen} as real) is not 0.5 then set value of UI element 2 of UI element 12 of ${listen} to 0.5
if name of UI element 1 of UI element ${radio} of ${listen} is not ${quote(mode==='local'?'同位局部':'完整乐段')} then error "continuation_scope_mismatch"
if (value of UI element 2 of UI element 12 of ${listen} as real) is not 0.5 or (value of UI element 2 of UI element 13 of ${listen} as real) is not 7.5 then error "continuation_listening_range"
if (value of UI element 1 of UI element ${radio} of ${listen} as integer) is not 1 then perform action "AXPress" of UI element 1 of UI element ${radio} of ${listen}
`+press(`UI element ${roleIndex} of UI element 6 of ${listen}`,title)+`delay 0.25
if description of UI element 2 of ${player} is not "Play" then error "continuation_player_not_paused"
set firstPosition to value of UI element 4 of ${player} as real
if firstPosition is not ${start} then error "continuation_player_start"
perform action "AXPress" of UI element 2 of ${player}
delay 8.5
set actualPosition to value of UI element 4 of ${player} as real
set finalPlayState to description of UI element 2 of ${player} as text
if actualPosition is not greater than firstPosition or finalPlayState is not "Play" then error "continuation_playback_pending_no_retry"
return ${quote(`${mode}|${role}|start=`)} & (firstPosition as text) & "|end=" & (actualPosition as text) & "|progressed=true|finished=true"
`;
}

export function continuationNativeTexts(header='__CURRENT_RUN_PROJECT__') {
  return {
    'read-page':readPage(header),
    render:headerGuard(header)+press('UI element 3 of UI element 9 of '+main,'生成并比较')+'return "RENDER_REQUESTED_ONCE"\n',
    'observe-render':observe(header,'实际新声已就绪。'),
    'export-current':headerGuard(header)+press('UI element 14 of '+main,'导出工程')+'return "CURRENT_METADATA_EXPORT_REQUESTED"\n',
    latest:headerGuard(header)+press('UI element 4 of UI element 6 of '+listen,'选用刚生成的版本')+'return "LATEST_COMPLETED_CHOSEN_NO_SDK"\n',
    compare:headerGuard(header)+press('UI element 1 of UI element 11 of '+main,'查看选区的计算线索')+'return "COMPARE_REQUESTED_ONCE"\n',
    'observe-compare':observe(header,'已核所选版本和位置的计算线索。'),
    'play-U-local':play(header,'U','local'),'play-E-local':play(header,'E','local'),
    'play-U-whole':play(header,'U','whole'),'play-E-whole':play(header,'E','whole'),
    'final-select-E':headerGuard(header)+press('UI element 3 of UI element 6 of '+listen,'新声音')+'return "FINAL_E_ROLE_SELECTED_NO_RENDER_COMPARE"\n',
    'final-save':headerGuard(header)+`if value of UI element 12 of ${main} is not "保存当前最终方案" then error "continuation_final_role_mismatch"\n`+press('UI element 13 of '+main,'保存在此浏览器')+'return "FINAL_SAVE_REQUESTED_ONCE"\n',
    'observe-save':observe(header,'已保存在此浏览器。'),
  };
}

export async function prepareContinuation(out,{carryPianoWithdrawal=true,headers={}}={}) {
  const destination=resolve(out);
  await mkdir(destination,{recursive:false,mode:0o700});
  const manifest={schema:'issue38-continuation-native-preparation-v1',realSDKAuthorized:false,UIExecuted:0,SDKExecuted:0,
    historyMenusAutomated:false,versionRecordPickerIsCurrent:false,headers:{},flows:[],limitations:[
      'New button AX group/element ordering and semantic held checkbox naming need actual read-only reception before any paid request.',
      'AX snapshot is role/name/value from normal UI only; ambiguous checkbox, marker/layout shift or missing nodes stops before SDK.',
      'Plain current export must pass full source/control/result/scales checks; no version-record picker or status-message shortcut.',
      'The actor must refuse repeated paid operation receipts, use a fresh per-operation filename and retain all failures; this generator is not a driver.',
    ]};
  const runbook=['# 完整C正常界面执行文本（准备；无真实执行许可）','',
    '仅在新完整包获批、当前方便、新recipient/run/固定窗口/源许可及新seed保存冷恢复门全部通过后使用。旧run/状态/窗口不可复用。',
    '命令均沿新包已核private-native-operation.py，执行某body会先独占reservation；观察/PENDING不得重发paid动作。此生成器不读取state/gate、不打开浏览器、不执行任何body。',
    '默认header占位符必须未来用显式新run工程标题重新生成；不得手改为旧run。snapshot.stdout用parseNativePageSnapshot解析，再由root checkPageDraft验收。',
    '角色探测失败先留只读证据，不猜held-checkbox位置；禁止隐藏状态、控制台或后台RPC补选。',
    '每个snapshot/普通导出必须配该次新op receipt(pid/epoch/body/body_sha/native_sha)及未来新包唯一writer保存的ctx。精确ctx键为run_id, operation, window{not_before,expires}(毫秒), pid, source, baseline, seed, accepted, availableIds, acceptedListening；baseline/seed/accepted必须来自本次已核新run，当前pending记录不得反填accepted。沿新export时间调用既有collector收集新JSON，旧阶段JSON不能混入当前；校验文件不授予SDK许可。',
    '每次普通export成功后，future新包使用：python3 -B collect-continuation.py NEW_OPERATION.json DOWNLOADS_DIRECTORY NEW_RECORD.json NEW_EXPORT_ATTESTATION.json。producer只收该op时间窗内唯一小JSON并独占存新record/attestation，不是签名认证或SDK许可，不得现在用旧op执行。',
    'current/measured/final须调用：node check-continuation.mjs KIND CASE STAGE NEW_CONTEXT.json NEW_RECORD.json NEW_OPERATION.json NEW_EXPORT_ATTESTATION.json。最后一项不可省略；page/final-page沿该次AX操作stdout解析，仍配本次op receipt。CLI核op原字节SHA、record原字节/大小、download名时间戳/mtime窗口，只是当前文件/操作对齐，不冒真实UI或数字认证安全。',
    '如果只读observe返回PENDING，保留receipt；只能用另一个new-only文件名复制只读观察文本重新读取，不能重发render/compare/save。',
    '本人正常控件按表设置type/amount/mode/start/end/held/preserve/顺序；不自动开历史菜单。最终当前表单必须是该完整意图图中的某一项。',
    '强弱组和最终缓存选择由本人正常富标签菜单选择；“最新”仅用于刚render结果。选择后普通导出核当前record，不以独立“版本记录”picker冒当前E。',''];
  for(const kind of ['piano','solo']) {
    const header=headers[kind]??'__CURRENT_RUN_PROJECT__';
    if(header!=='__CURRENT_RUN_PROJECT__'&&!new RegExp('^J:[0-9a-f]{64}:'+kind+':seed$').test(header))throw Error('native_header_identity');
    manifest.headers[kind]=header;
    const flow=continuationFlow(kind,{carryPianoWithdrawal});
    const texts=continuationNativeTexts(header),steps=[];
    for(const [index,step] of flow.cases.entries()) {
      const prefix=`${kind}-${String(index+1).padStart(2,'0')}-${step.name}`,files=[];
      for(const [role,text] of Object.entries(texts)) {
        if(role.startsWith('final-')||role==='observe-save'||(!step.compare&&['compare','observe-compare'].includes(role))||(!step.listen&&role.startsWith('play-')))continue;
        const slots=role==='export-current'?['export-before-choice','export-after-choice',...(step.compare?['export-measured']:[])]:[role];
        for(const slot of slots) {
          const name=`${prefix}-${slot}.txt`;await writeFile(join(destination,name),text,{flag:'wx',mode:0o600});files.push({role:slot,path:name,sha256:digest(text)});
        }
      }
      steps.push({...step,files});
      runbook.push(`## ${prefix}`,'',`完整控件表：${JSON.stringify(step.draft)}`,
        step.manualToggle?'本人在具名行真实点击撤回/恢复；代理不可替点。':'本人按上表在正常编辑控件设置全部意图、顺序及保护；不要生成。',
        `1. read-page → parseNativePageSnapshot → root checkPageDraft(step,snapshot,${quote(header)})；失败零SDK停止。`,
        '2. render只一次 → observe-render只读。成功后export-before-choice（顶层“导出工程”，私有JSON）→新collector独占接收NEW_RECORD/NEW_EXPORT_ATTESTATION。',
        '3. 若current record仍是旧版，但source正确：仅点latest一次→export-after-choice（独立文件槽）。checkCurrentVersion完整核source/control/held/preserve/region/sample_regions/result指纹/scales；不匹配即停，不compare旧E。若before已精确匹配则跳过latest/after槽。',
        step.compare?'4. compare只一次→observe-compare→export-measured（独立槽）→新collector收该新导出→root checkMeasuredVersion/CLI measured（必须该op与export-attestation）。':'4. 此项compare=0；checkCurrentVersion/CLI current（必须该op与export-attestation）并完整等context.seed，反馈只沿已有缓存状态，不重测。',
        step.listen?'5. 播放体先只读follow/听区，仅必要时取消跟随并改listen-start=.5/end=7.5，再选local/whole与U/E。同位局部U/E各1、完整8秒U/E各1；字段/角色切换可触发hear/audio_read，实际全部共账，不能称免费（只是不新增render/compare）。明确版/位置后分组记录属性/方向/程度/时间、自然/指定保留及钢琴（带琴）。':'5. expected seed/U严格身份同声成立，不重新要同声听感；identity未过不能跳听或补成功。','');
    }
    const finalFiles=[];
    for(const role of ['read-choice-page','read-page-before-save','export-before-save','export-after-save','final-select-E','final-save','observe-save']) {
      const name=`${kind}-final-${role}.txt`,text=texts[role.startsWith('export-')?'export-current':role.startsWith('read-')?'read-page':role];await writeFile(join(destination,name),text,{flag:'wx',mode:0o600});finalFiles.push({role,path:name,sha256:digest(text)});
    }
    manifest.flows.push({...flow,cases:steps,finalFiles});
    runbook.push(`## ${kind}最终选择/另存`,'',
      '本人只从本次cold后当前页仍可选、已比较且完整binding匹配的seed/C版本选择，说明为何；U选择本次全保护严格等声完成版，不是点U播放冒保存U。',
      '本人实际选择既有完成版后，用read-choice-page普通AX snapshot另存ctx.acceptedListening[choice]的mode/start/end，与普通export-before-save→新collector的record/op receipt/export-attestation一并绑定；root checkFinalChoice/CLI final。不是从固定metadata.region推断试听范围，也不从预设默认值伪造本人已选范围。',
      '本人恢复该版原draft/held/preserve/顺序及选择时的原local/whole/start/end；只在值不同时调整正常控件，不生成。final-select-E正常选新声音；独立read-page-before-save→checkPageDraft（以已选record.control为目标）且snapshot.listening须等被选择时的完整快照。range/role操作如触发audio_read仍共账。',
      '本人将保存阶段选为“保存当前最终方案”；final-save一次→observe-save→export-after-save核完整record同所选。没有新的render/compare/E/E分析，保存计入真实账。',
      '逐组三类反馈必须记录具体版本/位置/哪条观察帮助定位理解或选择；具体音乐用途本人判断，periodic/自动感知保持unknown。参数/人答/计算不能互代。','');
  }
  runbook.push('## 结束/范围','',
    '本包是文本准备。新完整数值预算/QA/发布/A/新私有作业/SDK额度或窗口均未由本输出授权；actual counters以真实账为准，cold内部U/seed计入新run。',
    '原硬门、每项一次、先预扣失败不退、无换量/新算法/新输入、条件失败与能力失败分列；到新批准截止必end/精确四键清音频留metadata/正常退出，其他会话/默认索引不动。',
    '所有AX实际位置、checkbox语义和新button点击后current完整binding均待新包获批后在真实UI核；本文本生成不冒实际稳定或完整#38验收。','');
  await writeFile(join(destination,'RUNBOOK.md'),runbook.join('\n'),{flag:'wx',mode:0o600});
  await writeFile(join(destination,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return manifest;
}

let invokedAsCLI=false;
if(process.argv[1]&&process.argv[1]!=='-') {
  try {invokedAsCLI=import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch {}
}
if(invokedAsCLI) {
  const args=process.argv.slice(2),options={headers:{}};let out;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--out')out=args[++i];
    else if(args[i]==='--piano-header')options.headers.piano=args[++i];
    else if(args[i]==='--solo-header')options.headers.solo=args[++i];
    else if(args[i]==='--include-piano-withdrawal')options.carryPianoWithdrawal=false;
    else throw Error('usage: --out NEW_TEXT_DIRECTORY [--piano-header J:NEW:... --solo-header J:NEW:...]');
  }
  if(!out)throw Error('explicit --out is required');
  const manifest=await prepareContinuation(out,options);
  process.stdout.write(JSON.stringify({prepared:manifest.flows.map(f=>({kind:f.kind,cases:f.cases.length,counts:f.expectedCounts})),UI:0,SDK:0})+'\n');
}
