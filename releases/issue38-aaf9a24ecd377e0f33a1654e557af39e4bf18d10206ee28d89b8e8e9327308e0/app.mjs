// SPDX-License-Identifier: GPL-3.0-or-later
import {PRECISE_SHIFT_NOTICE,deferredEditingScope,requireCurrentEditingScope} from './joint/editing_scope.mjs';
import {motionLimitFailureRecord} from './joint/motion_limit.mjs';
import {createRequestFeasibility,motionLimitMessage} from './joint/request_feasibility.mjs';
import { privateRunReceipt } from './joint/private_run_receipt.mjs';
import { describePrivateUsage } from './joint/private_usage.mjs';
import { createVersionRecords } from './joint/version_records.mjs';
import { createIntentEditor } from './joint/intent_editor.mjs';
import { completedVersionChoice, describeCompletedVersion } from './joint/completed_version_choice.mjs';
import { completedVersionFeedback, EXPLORATION_FEEDBACK_INTERVAL } from './joint/exploration_feedback.mjs';
import { isExplorationMethod } from './joint/signed_exploration.mjs';
import { isSharedSpectralHeadroomProfile } from './joint/exploration_profile.mjs';
import { createWorkspace } from './state.mjs';
import { loadAsset } from './assets.mjs';
import { isJointArchive, jointStorage } from './joint/archive.mjs';
import { comparisonPlaybackGain } from './joint/native_piano.mjs';
import { isRegisteredPianoMethod } from './joint/registered_piano.mjs';
import { importPrivateRunTransfer } from './joint/private_run_transfer.mjs';
import { pianoDraft, pianoRecipe, soloDraft, soloRecipe } from './joint/private_piano_controls.mjs';
import { isJointMethod, PIANO_QUALITY_METHOD, PIANO_PHASE_METHOD, SOLO_MOTION_METHOD, SOLO_WAVEFORM_METHOD, isSoloPhaseMethod, isSoloNoiseMethod } from './joint/engine.mjs';

const element = (id) => { const value = document.getElementById(id); if (!value) throw new Error('missing_view:' + id); return value; };
const input = (id) => { const value = element(id); if (!(value instanceof HTMLInputElement)) throw new Error('missing_input'); return value; };
const select = (id) => { const value = element(id); if (!(value instanceof HTMLSelectElement)) throw new Error('missing_select'); return value; };
const button = (id) => { const value = element(id); if (!(value instanceof HTMLButtonElement)) throw new Error('missing_button'); return value; };
const dialog = (id) => { const value = element(id); if (!(value instanceof HTMLDialogElement)) throw new Error('missing_dialog'); return value; };
const verification = new URLSearchParams(location.search).get('verification') === '1';
const workspace = createWorkspace();
const requestFeasibility = createRequestFeasibility();
let client = null, connecting = null, info = null, active = null, epoch = 0, resultId = 'U', projectId = null;
let latestId = null;
let currentAudio = null, currentURL = null, currentRole = 'O', recordingTitle = '', release = null;
let connectionVersion = 0;
let engineAvailable = false, playbackRange = { start: 0, end: 1, mode: 'local' };
const sounds = new Map(), history = new Map();
const jointKinds = { M: ['运动', 0, 1, .1], Q: ['声质', 0, 12, .5], T: ['音色', -6, 6, .5] };
const experimentalQuality = (method) => isSoloNoiseMethod(method) || isSoloPhaseMethod(method) || method === PIANO_PHASE_METHOD;
const jointProject = () => isJointMethod(info?.method_version);
const explorationProject = () => isExplorationMethod(info?.method_version);
const fixedPiano = () => info?.fixed_piano_recipe === true;
const fixedSolo = () => info?.fixed_solo_recipe === true;
const fixedRecipe = () => fixedPiano() || fixedSolo();
const recipeDraft = (name) => fixedSolo() ? soloDraft(name, info.source.default_region, info.source.motion_amount) : pianoDraft(name);
const recipeName = (draft) => fixedSolo() ? soloRecipe(draft, info.source.default_region, info.source.motion_amount) : pianoRecipe(draft);
const recipeLabels = { U: 'U · 同链参考', 'Q−': 'Q− · 气息减弱', Q: 'Q · 气息增强',
  MT: 'MT · 起伏与音色', MQ: 'MQ · 起伏与气息', MQT: 'MQT · 起伏、气息与音色' };
const privateSetupEnabled = (metadata) => metadata?.joint?.enabled === true && metadata.joint.private_setup === true;
const activeKind = () => select('joint-kind').value;
let expiryTimer = null, privateRunTimer = null, privateRunDeadline = null, currentPrivateRunId = null;
const privateInputs = new Map();
let runChannel = null;
const versionRecords=createVersionRecords({document,download,listening});
const intentEditor=createIntentEditor({document,getDraft:()=>workspace.view().draft,
  canEdit:()=>jointProject()&&!fixedRecipe()&&!active,
  commit:draft=>{workspace.edit(draft);setDraft(draft);},
  selectKind:kind=>{select('joint-kind').value=kind;setDraft(workspace.view().draft);updateControls();}});

function clearExpiredPrivateInputLease() {
  if (privateRunDeadline === null || Date.now() < privateRunDeadline) return;
  privateInputs.clear();
  privateRunDeadline = null;
  expireCurrentIfNeeded();
  jointStorage(indexedDB, 'purge').catch(() => {});
  loadPrivateSetup().catch(() => {});
}

function retainPrivateInputLease(deadline, runId) {
  clearTimeout(privateRunTimer);
  currentPrivateRunId = runId;
  privateRunDeadline = deadline;
  privateRunTimer = setTimeout(clearExpiredPrivateInputLease, Math.max(0, deadline - Date.now()));
}

async function privateSetupStorage(operation, record) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('voice-local-private-setup-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('setup');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('private_setup_storage'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('setup', operation === 'get' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('setup');
      let value;
      if (operation === 'put') store.put(record, 'signed');
      else if (operation === 'clear') store.delete('signed');
      else {
        const request = store.get('signed');
        request.onsuccess = () => {
          if (operation === 'get') value = request.result;
          else if (request.result?.id === record.id) store.delete('signed');
        };
      }
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(new Error('private_setup_storage'));
    });
  } finally { db.close(); }
}

async function loadPrivateSetup() {
  const record = await privateSetupStorage('get');
  if (!record) return null;
  if (record.expires > Date.now()) return record;
  await privateSetupStorage('delete', record);
  return null;
}

function message(text, failed = false) {
  element('status').textContent = text;
  element('status').classList.toggle('error', failed);
}

function pianoQualificationMessage({ interval, shared, anchor, M, Q, T }) {
  const labels = { supported: '有局部参数支持', blocked: '当前条件不足', unknown: '尚不能判定' };
  if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(Number.isSafeInteger) ||
      !Array.isArray(shared) || !Array.isArray(anchor) || ![M, Q, T].every((status) => Object.hasOwn(labels, status))) {
    return '';
  }
  const reason = {
    condition_insufficient_no_calibration_window: '没有合格的四秒校准窗',
    condition_insufficient_postcenter_over50: '颤音变化超过当前幅度上限',
    condition_insufficient_independent_track: '两套音高分析未达到一致性要求',
    condition_insufficient_motion: '连续音高支持不足',
    condition_insufficient_T_region: '校准窗内的参考位置缺少音色支持',
    ineligible_interval_M: '指定位置超出颤音可处理范围',
    insufficient_support_M: '指定位置的颤音支持不足',
    ineligible_interval_Q: '指定位置超出声质可处理范围',
    insufficient_support_Q: '指定位置的声质支持不足',
    ineligible_interval_T: '指定位置超出音色可处理范围',
    insufficient_support_T: '指定位置的音色支持不足',
  };
  const notes = (codes) => codes.filter((code) => Object.hasOwn(reason, code)).map((code) => reason[code]).join('，');
  const sharedNote = notes(shared), anchorNote = notes(anchor);
  const [start, end] = interval.map((frame) => frame / 200);
  return `钢琴选区 ${start}–${end} 秒。颤音${labels[M]}，声质${labels[Q]}，音色${labels[T]}。` +
    (sharedNote ? '校准候选遇到的问题包括' + sharedNote + '。' : '') +
    (anchorNote ? '指定选区遇到的问题包括' + anchorNote + '。' : '') + '这次未生成新声音。';
}

function friendly(error) {
  const diagnostic = error?.pianoQualification && pianoQualificationMessage(error.pianoQualification);
  if (diagnostic) return diagnostic;
  const code = error instanceof Error ? error.message : String(error);
  if(code==='precise_shift_deferred')return PRECISE_SHIFT_NOTICE;
  if(code==='signed_motion_limit')return (motionLimitMessage(error) ?? '这次起伏调整超出音高安全范围，未生成新版本。')+'已有版本仍保留。';
  if(code==='request_input_stopped')return '本轮输入已停止；修改设置不会重新开启本轮。已有版本仍保留。';
  if(code==='spectral_headroom_nonfinite')return '这次声质或音色处理出现无效数值，已停止本次处理。已有版本仍保留。';
  if(code==='spectral_headroom_insufficient')return error.headroom?.stage==='QT'
    ? '这组声质与音色的共同余量不足以保留至少一半所请求的变化，已停止本次处理。已有版本仍保留。'
    : '波峰余量不足以保留至少一半所请求的变化，已停止本次处理。已有版本仍保留。';
  if(code==='spectral_headroom_pcm_limit')return '这次声质或音色结果未通过波峰限制，已停止本次处理。已有版本仍保留。';
  if (code === 'invalid_intents' || code === 'draft_form_mismatch') return '当前意图的范围或程度尚未有效，请检查后再生成。';
  if (code === 'private_setup_expired') return '私有体验配置已过期。';
  if (code === 'private_setup_verification_only') return '私有入口只在核验模式下启用。';
  if (code === 'private_setup_required') return '请先选择本次体验的签名配置，再导入录音包。';
  if (code === 'private_setup_storage') return '本浏览器无法保存私有配置。可以在本页继续，重新打开网页时需再选择配置文件。';
  if (/^private_setup_(format|signature|policy|release|unavailable)$/.test(code)) return '无法核验这份私有体验配置，请检查配置文件和网页版本。';
  if (/^recording_combination_trial_/.test(code)) return '这次钢琴处理未通过固定乐段的核验，已有声音仍可试听。';
  if (/condition.insufficient|insufficient_support|ineligible|invalid_window|ambiguous_independent_mapping/.test(code)) return '这段录音或选区不满足当前处理条件。已有可听结果仍保留，可调整合法选区或使用另一段录音。';
  if (code === 'registered_scope') return '这份钢琴采用固定乐句和已核定的强度，可分别调整、组合或收回。';
  if (/^registered_(analysis|profile|identity|axis)/.test(code)) return '钢琴来源或处理基线不一致，已停止本次处理并保留已有结果。';
  if (code === 'piano_phase_scope') return '请在已选乐句范围内调整，气息强度可设为0到6。已有声音仍可比较。';
  if (code === 'solo_phase_scope') return '这份声质试验仅支持固定乐句、平铺强度0到6。';
  if (/^solo_phase_/.test(code)) return '本次声质试验未完成，已有版本仍可使用。';
  if (code === 'solo_noise_scope') return '这份声质试验仅支持固定乐句、平铺强度0到6。';
  if (/^solo_noise_/.test(code)) return '本次声质试验未完成，已有版本仍可使用。';
  if (code === 'solo_waveform_scope') return '这份独唱目前支持固定乐句的起伏和音色，可组合或分别收回。';
  if (code === 'piano_quality_scope') return '这份钢琴验证只支持固定位置的声质调整。';
  if (/solo_motion_scope|warp_/.test(code)) return '独唱 的颤音版本支持在已验证位置单独调整运动。请先收回其它意图或选择其它意图单独处理。';
  if (/invalid_wav|project_wav/.test(code)) return '请选择44.1 kHz、单声道、16位PCM WAV，最长45秒。当前没有生成新声音。';
  if (/quota|storage|Quota/.test(code)) return '本地保存未完成；旧工程仍保留。请检查浏览器空间，或先导出工程。';
  if (/identity|incompatible|invalid_project|invalid_parent|invalid_export|restored_result/.test(code)) return '工程或组件身份不一致，已拒绝使用。当前已打开的结果仍保留。';
  if (/budget/.test(code)) return '本次本机核验额度已用尽，已有声音与工程仍保留。';
  if (/timeout|worker|processor_busy/.test(code)) return '本次处理未完成。已有结果仍可试听；请等待当前操作结束后重试。';
  return '本次操作未完成：' + code + '。已有成果不会被失败结果替换。';
}

function control() {
  if (fixedRecipe()) return recipeDraft(select('piano-recipe').value);
  if (jointProject()) {
    const draft = workspace.view().draft, kind = activeKind();
    const item = { kind, start_frame: Math.round(Number(input('start').value) * 200),
      end_frame: Math.round(Number(input('end').value) * 200), amount: Number(input('amount').value),
      mode: select('development').value, held: input('joint-held').checked };
    const [, defaultMin, defaultMax] = jointKinds[kind];
    const min = explorationProject() ? -info.control_limits[kind] : defaultMin;
    const max = explorationProject() ? info.control_limits[kind] : kind === 'M' ? info.source.motion_amount ?? defaultMax
      : kind === 'Q' && experimentalQuality(info.method_version) ? 6 : defaultMax;
    if (!Number.isSafeInteger(item.start_frame) || !Number.isSafeInteger(item.end_frame) || item.start_frame < 0 ||
        item.end_frame <= item.start_frame || item.end_frame > Math.floor(info.samples / 220.5) + 1 ||
        !Number.isFinite(item.amount) || item.amount < min || item.amount > max ||
        (explorationProject() && item.mode === 'shift' && item.amount !== .25)) throw new Error('invalid_intents');
    const index = draft.intents.findIndex(intent => intent.kind === kind);
    if (index < 0) draft.intents.push(item); else draft.intents[index] = item;
    return draft;
  }
  const value = { start_frame: Math.round(Number(input('start').value) * 200),
    end_frame: Math.round(Number(input('end').value) * 200), amount: Number(input('amount').value), mode: select('development').value };
  if (!info || !Number.isFinite(value.amount) || value.amount < -6 || value.amount > 6 ||
      !Number.isSafeInteger(value.start_frame) || !Number.isSafeInteger(value.end_frame) ||
      value.start_frame >= value.end_frame || !info.source.eligible_intervals.T.some(([a, b]) => a <= value.start_frame && value.end_frame <= b)) {
    throw new Error('ineligible_interval');
  }
  return value;
}

function describe(c) {
  if (!c) return '原始录音';
  const recipe = fixedRecipe() ? recipeName(c) : null;
  if (recipe) return recipeLabels[recipe];
  if (c.intents) {
    const active = c.intents.filter((item) => item.amount !== 0);
    return (active.length ? active.map((item) => jointKinds[item.kind][0] + (item.held ? '已撤回' : ' ' + item.amount)).join(' · ')
      : '零意图') + (c.preserve.length ? ' · 指定保护 ' + c.preserve.length + ' 处' : '');
  }
  const modes = { flat: '均匀', front: '前半展开', back: '后半展开' };
  return `${c.amount > 0 ? '+' : ''}${c.amount} dB · ${modes[c.mode]} · ${(c.start_frame / 200).toFixed(3)}–${(c.end_frame / 200).toFixed(3)}秒`;
}

function listening() {
  return { ...playbackRange, selected: currentRole };
}

function snapshotView() {
  const draft = structuredClone(workspace.view().draft);
  return jointProject() ? { resultId, draft, listening: listening() }
    : { resultId, draftControl: draft, listening: listening() };
}

function canSaveRecipe() {
  return recipeName(workspace.view().draft) === 'MQT' && recipeName(history.get(resultId)?.control) === 'MQT';
}

function requestContext() {
  if(!explorationProject()||!info?.baseline?.metadata?.source)return null;
  const source=info.baseline.metadata.source;
  return {voice_sha256:source.voice_sha256,mix_sha256:source.mix_sha256??null,
    profile:info.exploration_profile,method:info.method_version,analysis_generation:connectionVersion+':'+epoch};
}

function currentRequestState() {
  const context=requestContext();
  if(!context)return {status:'unknown'};
  try{return requestFeasibility.view(context,generationControl());}
  catch{return {status:'unknown'};}
}

function updateControls() {
  const enabled = !!info;
  const preciseShiftDeferred=explorationProject()&&deferredEditingScope(workspace.view().draft);
  if(jointProject()&&!fixedRecipe()) intentEditor.render(workspace.view().draft);
  const fixed = fixedRecipe(), recipe = fixed ? select('piano-recipe').value : null;
  element('private-save-role').hidden = !explorationProject();
  element('amount-unit').textContent=explorationProject()
    ? (select('development').value==='shift'?'秒':activeKind()==='T'?'dB':'相对强度') : 'dB';
  const busy = !!active, canGenerate = enabled && engineAvailable && !busy;
  element('joint-controls').hidden = !jointProject() || fixed;
  element('generic-edit-controls').hidden = fixed;
  element('fixed-piano-controls').hidden = !fixed;
  element('follow-control').hidden = fixed;
  button('private-setup').disabled = busy;
  select('piano-recipe').disabled = !fixed || busy;
  button('piano-withdraw-t').disabled = !fixed || !canGenerate || !canSaveRecipe();
  element('joint-feedback').hidden = !jointProject();
  element('version-record-panel').hidden = !jointProject();
  button('joint-compare').disabled = !jointProject() || !history.has(resultId) || !!active || !engineAvailable;
  button('choose-latest').hidden = !explorationProject();
  button('choose-latest').disabled = completedVersionChoice(completedChoiceState()).choiceId === null;
  const pianoQuality = info?.method_version === PIANO_QUALITY_METHOD;
  const registered = isRegisteredPianoMethod(info?.method_version);
  const waveform = info?.method_version === SOLO_WAVEFORM_METHOD;
  const qualityTrial = experimentalQuality(info?.method_version);
  const fixedRegion = (qualityTrial && info?.method_version !== PIANO_PHASE_METHOD) || waveform || registered || pianoQuality || (info?.method_version === SOLO_MOTION_METHOD && activeKind() === 'M');
  select('joint-kind').disabled = pianoQuality;
  for (const option of select('joint-kind').options) option.disabled = waveform && option.value === 'Q';
  element('control-heading').textContent = pianoQuality ? '调整固定选区的声质' : '给局部一点不同的色彩';
  element('control-help').textContent = pianoQuality ? '调整后与同链参考比较，再按听感决定是否保留。'
    : '改变相对频谱倾斜。先大致比较，再按自己的听感微调。';
  input('amount').setAttribute('aria-label', pianoQuality ? '声质调整强度' : '相对频谱倾斜程度');
  element('amount-low').textContent = pianoQuality ? '原声质 0' : '偏暗 −6';
  element('amount-center').textContent = pianoQuality ? '' : '原始频谱';
  element('amount-high').textContent = pianoQuality ? '调整强度 +12' : '偏亮 +6';
  if (waveform) {
    element('control-heading').textContent = '组合声音起伏与音色';
    element('control-help').textContent = '这份录音支持起伏与音色单独调整、组合或收回。声质方法仍待验证。';
  }
  if (qualityTrial) {
    const kind = activeKind();
    element('control-heading').textContent = kind === 'Q' ? '试验这句的声质变化' : '组合声音起伏与音色';
    element('control-help').textContent = kind === 'Q' ? '与原声同句比较，听声质变化是否自然，再决定是否保留。' : '可组合、分别收回，再比较整句的听感。';
    input('amount').setAttribute('aria-label', kind === 'Q' ? '声质试验强度' : jointKinds[kind][0] + '调整强度');
    element('amount-low').textContent = kind === 'T' ? '偏暗 −6' : '原样 0';
    element('amount-center').textContent = '';
    element('amount-high').textContent = kind === 'Q' ? '试验强度 6' : kind === 'M' ? '当前起伏上限' : '偏亮 +6';
  }
  if (registered) {
    const kind = activeKind();
    const labels = { M: ['颤音', '原起伏 0', '登记起伏 1'], Q: ['声质', '原声质 0', '调整强度 +12'], T: ['音色', '原色 0', '更亮 +6'] }[kind];
    element('control-heading').textContent = '调整这句的' + labels[0];
    element('control-help').textContent = '在同一乐句比较三类调整，可组合、单项收回，并按听感保留。';
    input('amount').setAttribute('aria-label', labels[0] + '调整强度');
    element('amount-low').textContent = labels[1]; element('amount-center').textContent = kind === 'T' ? '稍亮 +3' : '';
    element('amount-high').textContent = labels[2];
  }
  if (explorationProject()) {
    const kind=activeKind(),limit=info.control_limits[kind];
    element('control-heading').textContent='调整这段的'+jointKinds[kind][0];
    const feasibility=currentRequestState();
    const support=feasibility.status==='unavailable'
      ? motionLimitMessage({message:'signed_motion_limit',motionLimit:feasibility.motionLimit})
      : feasibility.status==='generated'?'当前设置已生成过版本，可与同链参考比较后取舍。'
      :'基础支持已建立；当前这组设置尚未验证。';
    element('control-help').textContent='负向减弱原特点，正向增强；可调整局部位置与前后展开。'+(preciseShiftDeferred?PRECISE_SHIFT_NOTICE:'精确后移已延期。'+support)+
      (!engineAvailable?'本轮输入已停止；修改设置不会重新开启本轮。':'');
    input('amount').setAttribute('aria-label',jointKinds[kind][0]+'有符号程度');
    element('amount-low').textContent='减弱 −'+limit;
    element('amount-center').textContent='保留原样 0';
    element('amount-high').textContent='增强 +'+limit;
  }
  for(const option of select('development').options) if(option.value==='shift') {
    option.hidden=!explorationProject();option.disabled=true;option.textContent='精确后移（延期）';
  }
  input('amount').disabled = !enabled || (explorationProject() && select('development').value==='shift');
  for (const id of ['start', 'end']) input(id).disabled = !enabled || fixedRegion;
  select('development').disabled = !enabled || fixedRegion;
  select('history').disabled = !!active;
  if (fixed) {
    element('control-heading').textContent = fixedSolo() ? '比较这段独唱' : '比较这段带琴演唱';
    element('fixed-recipe-help').textContent = fixedSolo()
      ? '用 U 与 Q、MT、MQT 比较。重开 MQT 后，可撤回气息，生成同一个 MT。'
      : '用 U 与 Q−、MQ 比较。要单独听音色，请在试听列表中切换 MQ 和 MQT。';
    button('piano-withdraw-t').textContent = fixedSolo() ? '撤回气息，生成 MT' : '撤回音色，生成 MQ';
  }
  button('generate').disabled = !canGenerate || preciseShiftDeferred || (fixed && recipe === 'U') || (explorationProject()&&currentRequestState().status==='unavailable');
  button('save').disabled = !enabled || !engineAvailable || (fixed && (busy || !canSaveRecipe()));
  button('export').disabled = button('save').disabled;
  button('hear-O').disabled = !sounds.has('O');
  button('hear-U').disabled = !sounds.has('U');
  button('hear-E').disabled = !sounds.has('E');
}

function draw() {
  const canvas = element('timeline');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const width = canvas.width, height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (!info) return;
  const duration = info.samples / 44100, start = Number(input('start').value), end = Number(input('end').value);
  ctx.strokeStyle = '#b8c1ad'; ctx.lineWidth = 1;
  for (let second = 0; second <= duration; second += Math.max(1, Math.ceil(duration / 16))) {
    const x = 25 + (width - 50) * second / duration;
    ctx.beginPath(); ctx.moveTo(x, 35); ctx.lineTo(x, height - 30); ctx.stroke();
    ctx.fillStyle = '#89947c'; ctx.font = '14px sans-serif'; ctx.fillText(String(second), x, height - 12);
  }
  ctx.strokeStyle = '#869a72'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(25, height / 2); ctx.lineTo(width - 25, height / 2); ctx.stroke();
  for (const [a, b] of info.source.eligible_intervals[jointProject() ? activeKind() : 'T']) {
    ctx.fillStyle = '#bdcfa944'; ctx.fillRect(25 + (width - 50) * a / 200 / duration, 55, (width - 50) * (b - a) / 200 / duration, height - 110);
  }
  const x = 25 + (width - 50) * start / duration, last = 25 + (width - 50) * end / duration;
  ctx.fillStyle = '#b94e3122'; ctx.fillRect(x, 35, Math.max(2, last - x), height - 65);
  ctx.strokeStyle = '#b94e31'; ctx.lineWidth = 2; ctx.strokeRect(x, 35, Math.max(2, last - x), height - 65);
  element('range-label').textContent = fixedRecipe() ? `固定乐句 ${start.toFixed(2)}–${end.toFixed(2)} 秒 · 可切换完整乐段` :
    `当前局部 ${start.toFixed(3)}–${end.toFixed(3)} 秒 · 阴影为可处理范围`;
}

function setDraft(c) {
  if(jointProject()&&!fixedRecipe()) intentEditor.render(c);
  if (fixedRecipe()) {
    const picker = select('piano-recipe');
    const names = fixedSolo() ? ['U', 'Q', 'MT', 'MQT'] : ['U', 'Q−', 'MQ', 'MQT'];
    picker.replaceChildren(...names.map(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = recipeLabels[name];
      return option;
    }));
    picker.value = recipeName(c) ?? 'U';
    const [startFrame, endFrame] = info.source.default_region;
    input('start').value = String(startFrame / 200); input('end').value = String(endFrame / 200);
    element('intent').textContent = '当前草稿 · ' + describe(c);
    draw();
    return;
  }
  const slider = input('amount');
  const kind = jointProject() ? activeKind() : 'T';
  const [, min, max, step] = jointKinds[kind];
  const calibrated = jointProject() && kind === 'M' ? info.source.motion_amount : undefined;
  const registered = isRegisteredPianoMethod(info?.method_version);
  slider.min = String(explorationProject()?-info.control_limits[kind]:registered ? 0 : min); slider.max = String(explorationProject()?info.control_limits[kind]:calibrated ?? (experimentalQuality(info?.method_version) && kind === 'Q' ? 6 : max));
  slider.step = explorationProject()?String({M:.05,Q:.25,T:.5}[kind]):registered ? String({ M: 1, Q: 12, T: 3 }[kind]) : calibrated === undefined ? String(step) : 'any';
  const summary = describe(c);
  if (c.intents) {
    const [start_frame, end_frame] = explorationProject()&&kind==='M'?info.motion_region:info.source.default_region;
    c = c.intents.find((item) => item.kind === kind) ?? { start_frame, end_frame, amount: 0, mode: 'flat' };
    input('joint-held').checked = c.held === true;
  }
  input('start').value = String(c.start_frame / 200); input('end').value = String(c.end_frame / 200);
  input('amount').value = String(c.amount); select('development').value = c.mode;
  if(explorationProject()&&c.mode==='shift') {slider.min=slider.max='0.25';slider.step='any';}
  element('amount-value').textContent = (c.amount > 0 ? '+' : '') + c.amount;
  element('intent').textContent = '当前草稿：' + summary;
  updateControls();
  draw();
}

function disposeAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio.removeAttribute('src'); currentAudio.load(); currentAudio = null; }
  if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }
  element('audio').replaceChildren();
}

function expireCurrentIfNeeded() {
  if (!jointProject() || !Number.isSafeInteger(info.expires) || Date.now() < info.expires) return false;
  clearTimeout(expiryTimer);
  disposeAudio(); engineAvailable = false; active = null; latestId = null; sounds.clear(); history.clear();
  const { source, samples, method_version, fixed_piano_recipe, fixed_solo_recipe, kind, exploration_profile, control_limits, motion_region } = info;
  info = { source, samples, method_version, fixed_piano_recipe, fixed_solo_recipe, kind, exploration_profile, control_limits, motion_region, expired: true };
  requestFeasibility.clear();
  workspace.open(String(++epoch), workspace.view().draft, null);
  updateHistory(); updateControls();
  if (client) client.close();
  jointStorage(indexedDB, 'purge').catch(() => message('已停止播放。私有副本待本地清理。', true));
  message('私有输入已过期，已停止播放。', true);
  return true;
}

function scheduleExpiry(deadline) {
  const began = epoch;
  expiryTimer = setTimeout(() => {
    if (began === epoch && !expireCurrentIfNeeded()) scheduleExpiry(deadline);
  }, Math.max(0, Math.min(2147483647, deadline - Date.now())));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    expireCurrentIfNeeded();
    clearExpiredPrivateInputLease();
  }
});

function hear(role) {
  if (expireCurrentIfNeeded()) return;
  const sound = sounds.get(role); if (!sound) return;
  disposeAudio(); currentRole = role;
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata';
  currentURL = URL.createObjectURL(new Blob([sound.bytes], { type: 'audio/wav' }));
  audio.src = currentURL; audio.volume = comparisonPlaybackGain(info.method_version, role);
  const range = listening();
  audio.addEventListener('loadedmetadata', () => {
    if (audio === currentAudio && !expireCurrentIfNeeded()) audio.currentTime = range.mode === 'local' ? range.start : 0;
  });
  audio.addEventListener('play', () => {
    if (audio !== currentAudio) { audio.pause(); return; }
    if (expireCurrentIfNeeded()) return;
    const r = listening(); if (r.mode === 'local' && (audio.currentTime < r.start || audio.currentTime >= r.end)) audio.currentTime = r.start;
  });
  audio.addEventListener('timeupdate', () => {
    if (audio !== currentAudio || expireCurrentIfNeeded()) return;
    const r = listening(); if (r.mode === 'local' && audio.currentTime >= r.end) audio.pause();
  });
  audio.addEventListener('error', () => { if (audio === currentAudio) { audio.pause(); message('此版本暂不可播放。工程仍保留，可切换原声或同链参考。', true); } });
  currentAudio = audio; element('audio').append(audio);
  for (const name of ['O', 'U', 'E']) button('hear-' + name).classList.toggle('active', name === role);
  element('heard').textContent = (role === 'O' ? '原声 · ' : role === 'U' ? '同链无编辑 · ' : '正在聆听的完成版本 · ') + describe(sound.control) +
    (sound.sha256 ? ' · ' + sound.sha256.slice(0, 12) : '');
}

function connect({ restorePrivateSetup = true } = {}) {
  if (client) return Promise.resolve(client);
  if (connecting) return connecting;
  const generation = ++connectionVersion;
  connecting = (async () => {
    const worker = new Worker('./processor.mjs', { type: 'module' });
    const pending = new Map(); let sequence = 0, closed = false;
    const stop = (code) => {
      if (closed) return;
      closed = true; worker.terminate();
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(code)); }
      pending.clear();
      if (generation === connectionVersion) {
        connectionVersion++; client = null; connecting = null; engineAvailable = false; requestFeasibility.clear(); updateControls();
      }
    };
    const rpc = (type, body = {}) => new Promise((resolve, reject) => {
      if (closed) { reject(new Error('worker_closed')); return; }
      const id = String(++sequence), timer = setTimeout(() => stop('worker_timeout'), 600000);
      pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, type, ...body });
    });
    worker.onmessage = ({ data }) => {
      if (closed || generation !== connectionVersion) return;
      if (data.progress) { message(data.progress + '…'); return; }
      const request = pending.get(data.id); if (!request) return;
      pending.delete(data.id); clearTimeout(request.timer);
      if (data.ok) request.resolve(data.result);
      else request.reject(Object.assign(new Error(data.error || 'processing_failed'), {
        pianoQualification: data.pianoQualification,
        headroom:data.headroom,
        motionLimit:motionLimitFailureRecord({message:data.error,motionLimit:data.motionLimit}),
      }));
      if (data.elapsed_ms) element('timing').textContent = `最近操作 ${(data.elapsed_ms / 1000).toFixed(1)} 秒 · 本机处理`;
    };
    worker.onerror = () => stop('worker_failed');
    let ready;
    try { ready = await rpc('initialize', { verification }); } catch (error) { stop('worker_failed'); throw error; }
    const api = { rpc, joint: ready.joint === true, privateSetup: ready.private_setup === true, privateRun: ready.private_run === true,
      jointError: ready.joint_error, close() { stop('worker_closed'); } };
    if (api.privateSetup && restorePrivateSetup) {
      const record = await loadPrivateSetup().catch(() => null);
      if (record) {
        try {
          const { installed, run_expires, run_id } = await rpc('jointInstallPrivateSetup', { blob: record.blob });
          if (run_expires) retainPrivateInputLease(run_expires, run_id);
          if (installed !== true) throw new Error('private_setup_unavailable');
        } catch (error) {
          if (/^private_setup_(expired|format|policy|release|signature)$/.test(error.message)) {
            await privateSetupStorage('delete', record).catch(() => {});
          }
        }
      }
    }
    if (closed || generation !== connectionVersion) throw new Error('worker_closed');
    client = api;
    return client;
  })();
  return connecting;
}

function adopt(next, title, savedId = null) {
  clearTimeout(expiryTimer);
  intentEditor.reset();versionRecords.reset();requestFeasibility.clear();
  versionRecords.add([next.baseline,...(next.available??[]),next.result]);
  epoch++; info = next; engineAvailable = next.expired !== true; latestId = null; recordingTitle = title; projectId = savedId; sounds.clear(); history.clear();
  if (!next.expired) { sounds.set('O', next.original); sounds.set('U', next.baseline); }
  resultId = 'U';
  for (const item of next.available || []) history.set(item.id, item);
  if (next.result) { sounds.set('E', next.result); history.set(next.result.id, next.result); resultId = next.result.id; }
  const [a, b] = next.source.default_region;
  const namedMotion = ([SOLO_MOTION_METHOD, SOLO_WAVEFORM_METHOD].includes(next.method_version) || isSoloNoiseMethod(next.method_version));
  const pianoQuality = next.method_version === PIANO_QUALITY_METHOD;
  const trialAmount = (namedMotion || (verification && release?.joint?.private_solo_trial)) ? next.source.motion_amount : undefined;
  const draft = next.draft || (pianoQuality ? {
    intents: [{ kind: 'Q', amount: 12, start_frame: a, end_frame: b, mode: 'flat', held: false }], preserve: [],
  } : trialAmount !== undefined ? {
    intents: [{ kind: 'M', amount: trialAmount, start_frame: a, end_frame: b, mode: 'flat', held: false }], preserve: [],
  } : jointProject() ? { intents: [], preserve: [] } : { start_frame: a, end_frame: b, amount: 6, mode: 'flat' });
  select('joint-kind').value = pianoQuality ? 'Q' : namedMotion && next.draft?.intents.length
    ? next.draft.intents[0].kind : trialAmount !== undefined ? 'M' : 'T';
  element('joint-report').textContent = next.comparison && !explorationProject()
    ? '已恢复上次对照的两版与位置，可在相同范围重新查看计算线索。' : '';
  if (jointProject() && Number.isSafeInteger(next.expires)) {
    scheduleExpiry(next.expires);
  }
  workspace.open(String(epoch), draft, next.result || next.baseline);
  setDraft(draft); element('empty').hidden = true;
  element('recording-title').textContent = title; element('duration').textContent = (next.samples / 44100).toFixed(2) + ' 秒 · 本地录音';
  const range = next.listening;
  input('whole').checked = range?.mode === 'whole'; input('local').checked = !input('whole').checked;
  const [start, end] = fixedRecipe() ? [Number(input('start').value), Number(input('end').value)] : [a / 200, b / 200];
  playbackRange = range ? { start: range.start, end: range.end, mode: range.mode } : { start, end, mode: 'local' };
  input('listen-start').value = String(playbackRange.start); input('listen-end').value = String(playbackRange.end);
  const initial = jointProject() ? draft.intents.find((item) => item.kind === 'T') : draft;
  input('follow').checked = playbackRange.start === (initial?.start_frame ?? a) / 200 &&
    playbackRange.end === (initial?.end_frame ?? b) / 200;
  updateHistory(); updateControls(); draw(); hear(range?.selected && sounds.has(range.selected) ? range.selected : fixedRecipe() ? 'U' : 'O');
}

function updateHistory() {
  const list = select('history'); list.replaceChildren();
  const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = '其它完成版本'; list.append(prompt);
  for (const sound of history.values()) { const option = document.createElement('option'); option.value = sound.id; option.textContent = explorationProject() ? describeCompletedVersion(sound.control) : describe(sound.control); list.append(option); }
  if (explorationProject()) list.value = completedVersionChoice(completedChoiceState()).currentId;
  list.hidden = history.size < (jointProject() ? 1 : 2);
  updateVersionComparison();
}

function updateVersionComparison() {
  const panel = element('version-comparison');
  const current = explorationProject() && history.get(resultId);
  panel.hidden = !current;
  panel.replaceChildren();
  if (!current) return;

  const baseline = sounds.get('U');
  const column = version => ({version, feedback: completedVersionFeedback(info, baseline, version)});
  const shown = [column(current)];
  let alternative;
  for (const version of [...history.values()].reverse()) {
    if (version.id === current.id) continue;
    const candidate = column(version);
    alternative ??= candidate;
    if (candidate.feedback) { alternative = candidate; break; }
  }
  if (alternative) shown.push(alternative);
  const heading = document.createElement('h3'), note = document.createElement('p');
  heading.textContent = '完成版本对照';
  note.textContent = '计算范围固定为 0.5–7.5 秒。各版都与同一份未编辑参考相比。';
  if (alternative) note.textContent += ' 对照栏优先显示最近有线索的另一版。';
  if (shown[0].feedback?.status === 'archived_not_remeasured') {
    note.textContent += ' 重开工程仅恢复保存时所选版本及其线索。';
  }
  panel.append(heading, note);
  if (!shown.some(column => column.feedback)) {
    note.textContent += ' 尚无可显示的线索。可计算当前版本的线索。';
    return;
  }
  const delta = (before, after) => {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return '未知';
    const difference = after - before, magnitude = Math.abs(difference).toFixed(1);
    return magnitude === '0.0' ? '变化不到 0.1 dB' : (difference > 0 ? '升高 ' : '降低 ') + magnitude + ' dB';
  };
  const preservation = value => value === true ? '与参考相同' : value === false ? '与参考有差异' : '未知';
  const table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
  const top = document.createElement('tr');
  const cell = (row, tag, text, scope) => {
    const node = document.createElement(tag); node.textContent = text;
    if (scope) node.setAttribute('scope', scope);
    row.append(node);
    return node;
  };
  cell(top, 'th', '比较项', 'col');
  shown.forEach(({version, feedback}, index) => {
    const header = cell(top, 'th', index === 0 ? '当前版本' : '对照版本', 'col');
    const description = document.createElement('small');
    description.textContent = describeCompletedVersion(version.control) + (feedback?.status === 'archived_not_remeasured' ? ' · 已保存的线索' : '');
    header.append(description);
  });
  head.append(top);
  const rows = [
    ['选区整体音色变化（明亮频段）', s => delta(s.timbre.before.median_db, s.timbre.after.median_db)],
    ['3.5–4.0 秒的人声相对强弱', s => delta(s.motion.before[6]?.relative_db, s.motion.after[6]?.relative_db)],
    ['谐波与噪声的比值（气息线索）', s => delta(s.quality.before.hnr, s.quality.after.hnr)],
    ['处理范围外的人声', s => preservation(s.preservation.protected_voice_equal)],
  ];
  if (info.kind === 'piano') rows.push(['估算伴奏', s => preservation(s.preservation.estimated_residual_equal)]);
  for (const [label, describeValue] of rows) {
    const row = document.createElement('tr');
    cell(row, 'th', label, 'row');
    for (const {version, feedback} of shown) cell(row, 'td', feedback ? describeValue(feedback.summary, version) : '待计算');
    body.append(row);
  }
  table.append(head, body);
  panel.append(table);
  const explanation = document.createElement('p');
  explanation.textContent = '音色数值是人声 2–3 kHz 相对能量中位值的变化。强弱先与选区外的录音比较。气息线索可帮你决定先复听哪版。';
  panel.append(explanation);
}

function completedChoiceState() {
  return {ids:history.keys(),currentId:resultId,latestId,available:!!info,busy:!!active,
    expired:info?.expired===true||(Number.isSafeInteger(info?.expires)&&Date.now()>=info.expires)};
}

function chooseCompletedVersion(id) {
  if (expireCurrentIfNeeded()) return;
  const selectedId = completedVersionChoice(completedChoiceState(),id).choiceId;
  if (selectedId === null) return;
  const item = history.get(selectedId);
  resultId = item.id; sounds.set('E',item); select('history').value = item.id;
  updateVersionComparison();
  if (jointProject()) element('joint-report').textContent = '';
  hear('E'); updateControls();
  if (item.spectral_delta_scales) message('已选择完成版本。'+headroomNotice(item));
}

async function run(task, status) {
  if (active) { message('当前处理尚未结束，已有版本仍可试听。'); return; }
  message(status); const promise = Promise.resolve().then(task); active = promise; updateControls();
  try { await promise; } catch (error) { if (active === promise) message(friendly(error), true); }
  finally { if (active === promise) active = null; updateControls(); }
}

async function openWav(bytes, name) {
  const api = await connect(), next = await api.rpc('analyze', { bytes }); adopt(next, name);
  message('原声与同链参考已就绪。选择局部，生成自己的比较版本。');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

button('example').onclick = () => run(async () => {
  const metadata = release || await (await fetch('./release.json')).json();
  const response = await fetch(metadata.example.path, { credentials: 'omit' }); if (!response.ok) throw new Error('example_load_failed');
  await openWav(new Uint8Array(await response.arrayBuffer()), 'VocalSet · Caro mio ben');
}, '打开示例，检查这段演唱的实际条件…');
async function installSetup(api, blob) {
  const result = await api.rpc('jointInstallPrivateSetup', { blob });
  if (result.installed !== true) throw new Error('private_setup_unavailable');
  if (jointProject()) clearCurrent({ keepWorker: true });
  const expires = result.run_expires ?? Math.max(result.expires.solo, result.expires.piano);
  const record = { id: crypto.randomUUID(), blob, expires };
  await privateSetupStorage('put', record).catch(() => { throw new Error('private_setup_storage'); });
  if (result.run_expires) retainPrivateInputLease(expires, result.run_id);
  return result;
}

button('private-enroll').onclick = () => run(async () => {
  const api = await connect();
  const { recipient } = await api.rpc('jointEnrollPrivateRun');
  element('private-enrollment-id').textContent = recipient;
  message('本浏览器的登记编号已显示。');
}, '登记此浏览器…');

button('private-claim').onclick = () => run(async () => {
  const api = await connect();
  const { recipient } = await api.rpc('jointEnrollPrivateRun');
  const address = input('private-transfer-address').value.trim();
  input('private-transfer-address').value = '';
  const transfer = await importPrivateRunTransfer(address, release.release, recipient, {
    prove: challenge => api.rpc('jointProvePrivateTransfer', {challenge}),
    profile:release.private_profile??null,
  });
  const installed = await installSetup(api, transfer.parts.setup);
  if (installed.run_id !== transfer.runId || installed.run_expires !== transfer.expires) {
    await api.rpc('jointEndPrivateRun');
    await privateSetupStorage('clear');
    throw new Error('private_transfer_identity');
  }
  privateInputs.set('solo', transfer.parts.solo);
  privateInputs.set('piano', transfer.parts.piano);
  message('已领到两段录音。先打开其中一段，生成和保存后再开另一段。');
}, '读取本次的私有录音包…');

button('private-report').onclick = () => run(async () => {
  if(release?.joint?.private_run!==true) throw new Error('private_setup_unavailable');
  // Share the Worker's scoped receipt verifier without caching an unconfigured
  // processing Worker ahead of normal cold setup restoration.
  element('private-usage').textContent=describePrivateUsage(
    await privateRunReceipt(indexedDB,release.release,'report',undefined,release.private_profile));
  message('已读取本次累计预扣与剩余额度；没有生成新声音。');
}, '读取已有用量账本…');

button('private-end').onclick = () => run(async () => {
  const api = await connect({restorePrivateSetup:false});
  let report, setupCleared = false;
  try {
    report = await api.rpc('jointEndPrivateRun');
    download(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'}), 'private-run-receipt.json');
    setupCleared = await privateSetupStorage('clear').then(() => true, () => false);
  } finally {
    if (report?.run_id) runChannel?.postMessage(report.run_id);
    privateInputs.clear();
    if (Number.isSafeInteger(info?.expires)) clearCurrent({keepWorker: true});
  }
  message(report.archive_cleanup === 'verified' ? '本次私有试听已结束，声音已清理。' :
    '本次用量账本已结束，回执已导出。声音副本的清理状态尚未核实。');
  if (!setupCleared) message('用量账本已结束，回执已导出。签名配置未完成本地清理，声音清理状态尚未核实。', true);
}, '关闭本次试听并清理私有录音…');

function openReceivedInput(kind) {
  clearExpiredPrivateInputLease();
  const blob = privateInputs.get(kind);
  if (!blob) return false;
  const title = kind === 'piano' ? '本人演唱与钢琴' : '本人独唱';
  run(async () => {
    privateInputs.delete(kind);
    const api = await connect();
    adopt(await api.rpc(kind === 'piano' ? 'jointOpenPiano' : 'jointOpen', {blob}), title);
    message('录音已就绪。先听同链参考 U。');
  }, '核验并打开本次录音…');
  return true;
}

button('private-setup').onclick = () => input('private-setup-file').click();
input('private-setup-file').onchange = () => {
  const blob = input('private-setup-file').files?.[0]; input('private-setup-file').value = '';
  if (!blob || !privateSetupEnabled(release)) return;
  run(async () => {
    const api = await connect();
    if (!api.privateSetup) throw new Error(api.jointError || 'private_setup_unavailable');
    await installSetup(api, blob);
    message('已在此浏览器核验并保存配置。请选择独唱或人声与钢琴的录音包。');
  }, '核验本地签名配置…');
};
button('joint-solo').onclick = () => {
  if (openReceivedInput('solo')) return;
  const trial = verification ? release?.joint?.private_solo_trial : null;
  if (!trial) { input('joint-solo-file').click(); return; }
  run(async () => {
    const url = new URL(trial.bundle, location.href);
    if (url.origin !== location.origin) throw new Error('input_identity');
    const api = await connect();
    if (!api.joint) throw new Error(api.jointError || 'joint_runtime_unavailable');
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('input_identity');
    adopt(await api.rpc('jointOpen', { blob: await response.blob() }), '本人独唱');
    message('独唱已就绪，先比较原声与同链参考。');
  }, '核验固定独唱和可处理位置…');
};
button('joint-piano').onclick = () => {
  if (!openReceivedInput('piano')) input('joint-piano-file').click();
};
input('joint-solo-file').onchange = () => {
  const file = input('joint-solo-file').files?.[0]; input('joint-solo-file').value = '';
  if (file) run(async () => {
    if (file.size > 20 * 1024 * 1024) throw new Error('invalid_wav');
    const api = await connect();
    const body = await isJointArchive(file) ? { blob: file } : { bytes: new Uint8Array(await file.arrayBuffer()) };
    adopt(await api.rpc('jointOpen', body), file.name);
    message('独唱已就绪，先比较原声与同链参考。');
  }, '检查独唱的处理条件…');
};
input('joint-piano-file').onchange = () => {
  const blob = input('joint-piano-file').files?.[0]; input('joint-piano-file').value = '';
  if (blob) run(async () => {
    const api = await connect();
    adopt(await api.rpc('jointOpenPiano', { blob }), blob.name);
    message(fixedPiano() ? '带琴录音已就绪。先听 U，再生成需要比较的版本。'
      : info.method_version === PIANO_QUALITY_METHOD ? '固定选区的声质已就绪，可生成并比较。'
      : '钢琴混音及其人声组件已核验。');
  }, '核验钢琴组件和处理位置…');
};
button('upload').onclick = () => input('wav-file').click();
button('open').onclick = () => input('project-file').click();
input('wav-file').onchange = () => { const file = input('wav-file').files?.[0]; if (file) run(async () => {
  if (file.size > 8 * 1024 * 1024) throw new Error('invalid_wav');
  await openWav(new Uint8Array(await file.arrayBuffer()), file.name);
}, '导入录音，独立检查可处理区间…'); input('wav-file').value = ''; };
input('project-file').onchange = () => { const file = input('project-file').files?.[0]; if (file) run(async () => {
  const api = await connect(); const next = await api.rpc(await isJointArchive(file) ? 'jointImport' : 'import', { blob: file }); adopt(next, file.name);
  message('文件工程已从原录音重新验证，可继续修改。');
}, '验证文件工程，并从原录音恢复结果…'); input('project-file').value = ''; };

for (const id of ['amount', 'start', 'end']) input(id).oninput = edit;
select('development').onchange = () => {
  if(explorationProject()) {
    const slider=input('amount'),kind=activeKind(),shift=select('development').value==='shift';
    slider.min=shift?'0.25':String(-info.control_limits[kind]);
    slider.max=shift?'0.25':String(info.control_limits[kind]);
    slider.step=shift?'any':String({M:.05,Q:.25,T:.5}[kind]);
    slider.value=shift?'0.25':'0';
  }
  edit();updateControls();
};
select('joint-kind').onchange = () => {
  if (jointProject()) { setDraft(workspace.view().draft); updateControls(); }
};
input('joint-held').onchange = edit;
button('joint-protect').onclick = () => {
  if (fixedRecipe()) return;
  try {
    const draft = workspace.view().draft;
    const range=[Math.round(Number(input('start').value)*200),Math.round(Number(input('end').value)*200)];
    if(draft.preserve.length>=16||!range.every(Number.isSafeInteger)||range[0]<0||range[1]<=range[0]||
       range[1]>Math.floor(info.samples/220.5)+1) throw new Error('invalid_intents');
    draft.preserve.push(range);
    workspace.edit(draft); setDraft(draft);
  } catch (error) { message(friendly(error), true); }
};
button('joint-clear-protection').onclick = () => {
  if (fixedRecipe()) return;
  const draft = workspace.view().draft;
  draft.preserve = []; workspace.edit(draft); setDraft(draft);
};
function edit() {
  if (!info || fixedRecipe()) return;
  try { const c = control(); workspace.edit(c); setDraft(c);
    const region = jointProject() ? c.intents.find((intent) => intent.kind === activeKind()) : c;
    if (jointProject()) element('joint-report').textContent = '';
    if (input('follow').checked) { playbackRange.start = region.start_frame / 200; playbackRange.end = region.end_frame / 200;
      input('listen-start').value = String(playbackRange.start); input('listen-end').value = String(playbackRange.end); }
  }
  catch (error) { message(friendly(error), true); }
}
function editFixedRecipe(recipe) {
  if (!fixedRecipe() || active) return;
  const draft = recipeDraft(recipe);
  workspace.edit(draft); setDraft(draft);
  element('joint-report').textContent = '';
  if (recipe === 'U') hear('U');
  updateControls();
}
select('piano-recipe').onchange = () => editFixedRecipe(select('piano-recipe').value);
button('piano-withdraw-t').onclick = () => {
  if (!fixedRecipe() || !engineAvailable || active || !canSaveRecipe()) return;
  editFixedRecipe(fixedSolo() ? 'MT' : 'MQ');
  if (!button('generate').disabled) button('generate').click();
};
for (const id of ['local', 'whole']) input(id).onchange = () => { playbackRange.mode = input('whole').checked ? 'whole' : 'local'; if (info) hear(currentRole); };
for (const id of ['listen-start', 'listen-end']) input(id).onchange = () => {
  const start = Number(input('listen-start').value), end = Number(input('listen-end').value);
  if (!info || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > info.samples / 44100) { message('试听范围必须位于录音内，且结束晚于开始。', true); return; }
  playbackRange = { ...playbackRange, start, end }; if (jointProject()) element('joint-report').textContent = ''; input('follow').checked = false; hear(currentRole);
};
input('follow').onchange = () => { if (info && input('follow').checked) edit(); };
for (const name of ['O', 'U', 'E']) button('hear-' + name).onclick = () => hear(name);
select('history').onchange = () => chooseCompletedVersion(select('history').value);
button('choose-latest').onclick = () => { if (explorationProject()) chooseCompletedVersion(latestId); };

function generationControl() {
  const checked=control();
  if(!jointProject()||fixedRecipe()) return checked;
  const draft=workspace.view().draft,kind=activeKind();
  const saved=draft.intents.find(item=>item.kind===kind);
  const displayed=checked.intents.find(item=>item.kind===kind);
  if(saved ? ['start_frame','end_frame','amount','mode','held'].some(key=>saved[key]!==displayed[key]) :
      displayed.amount!==0||displayed.held) throw new Error('draft_form_mismatch');
  return draft;
}

function headroomNotice(result) {
  const scales=result.spectral_delta_scales??{};
  if(!Object.values(scales).some(scale=>scale<1))return '';
  const shared=isSharedSpectralHeadroomProfile(info?.exploration_profile)&&Object.hasOwn(scales,'Q')&&Object.hasOwn(scales,'T');
  return (shared?'声质与音色共同受波峰余量限制，实际谱变化已减小；':'受波峰余量限制，实际变化已减小；')+
    '记录中保留了请求程度和实际差分比例。';
}

button('generate').onclick = () => run(async () => {
  const c = generationControl(), began = epoch;
  if(explorationProject())requireCurrentEditingScope(c);
  if (jointProject()) {
    const fixed = fixedRecipe();
    if (fixed && recipeName(c) === 'U') return;
    const context=requestContext();
    const feasibility=context?requestFeasibility.view(context,c):{status:'unknown'};
    if(feasibility.status==='unavailable')throw Object.assign(new Error('signed_motion_limit'),{motionLimit:feasibility.motionLimit});
    if(explorationProject()&&!engineAvailable)throw new Error('request_input_stopped');
    workspace.edit(c);
    const revision = workspace.view().revision;
    const api = await connect();
    const submittedContext=requestContext();
    let result;
    try {result=await api.rpc('jointRender', { draft: c, keepId: resultId });}
    catch(error){
      if(submittedContext&&began===epoch&&submittedContext.analysis_generation===requestContext()?.analysis_generation){
        requestFeasibility.reject(submittedContext,c,error);
        // The existing private Worker stops this input on a motion failure; keep that stop visible.
        if(error.message==='signed_motion_limit')engineAvailable=false;
      }
      throw error;
    }
    if (began !== epoch) return;
    if(submittedContext&&submittedContext.analysis_generation===requestContext()?.analysis_generation)
      requestFeasibility.generated(submittedContext,c,result.id);
    history.set(result.id, result);
    latestId = result.id;
    versionRecords.add([result]);
    if ((fixed || !sounds.has('E')) && workspace.view().revision === revision) {
      sounds.set('E', result); resultId = result.id;
      if (fixed) { element('joint-report').textContent = ''; hear('E'); }
    }
    while (history.size > (explorationProject()?31:11)) {
      const removable = [...history.keys()].find((id) => id !== resultId && id !== result.id);
      history.delete(removable);
    }
    updateHistory(); updateControls();
    message((fixed ? '新版本已就绪，可与 U 同位比较，或从完成版本中切换。' :
      '实际新声已就绪。当前试听保持，可在完成版本列表中切换。')+headroomNotice(result));
    return;
  }
  const request = workspace.begin();
  message('正在处理冻结意图：' + describe(c) + '。已有版本仍可试听。');
  const api = await connect(); const result = await api.rpc('render', { control: c, slot: verification ? select('evidence-slot').value : null, keepId: resultId });
  if (began !== epoch) return;
  history.set(result.id, result);
  while (history.size > 7) { const remove = [...history.keys()].find((id) => id !== resultId && id !== result.id); if (!remove) break; history.delete(remove); }
  updateHistory();
  if (workspace.finish(request, result)) { resultId = result.id; sounds.set('E', result); hear('E'); message('新声音已就绪。请与同链参考在相同位置比较。'); }
  else message('旧草稿的结果已保留在“其它完成版本”；当前新草稿尚未生成。');
  updateControls();
}, '生成新的完整结果…');

button('joint-compare').onclick = () => run(async () => {
  const next = history.get(resultId);
  if (!jointProject() || !next) throw new Error('result_missing');
  const began = epoch, baseline = sounds.get('U');
  const listeningRange = [playbackRange.start, playbackRange.end];
  const exploration = explorationProject();
  const interval = exploration ? [...EXPLORATION_FEEDBACK_INTERVAL] : listeningRange.map(time => Math.round(time * 44100));
  const scope = {input_sha256: info.input_sha256, axis: info.kind === 'piano' ? 'full_mix' : 'vocal_only', interval,
    left: 'U', left_sha256: baseline.sha256, right: next.id, right_sha256: next.sha256};
  const stillCurrent = () => epoch === began && resultId === next.id &&
    (exploration || (listeningRange[0] === playbackRange.start && listeningRange[1] === playbackRange.end));
  const api = await connect();
  if (!stillCurrent()) return;
  const report = await api.rpc('jointCompare', {scope});
  if (!stillCurrent()) return;
  if (exploration) {
    const metadata = await api.rpc('jointVersionRecord', {resultId: next.id});
    if (!stillCurrent()) return;
    history.set(next.id, {...next, metadata});
    versionRecords.add([{metadata}]);
    updateVersionComparison();
  }
  const finite = (value) => Number.isFinite(value) ? value.toFixed(2) + ' dB' : '未知';
  const level = (rows) => rows.map((row) => finite(row.relative_db)).join(' / ') || '支持不足';
  const color = (rows) => {
    const values = rows.map((row) => row.ratio_db).filter(Number.isFinite);
    return values.length ? finite(values.reduce((total, value) => total + value, 0) / values.length) : '未知';
  };
  const preserved = (value) => value === true ? '相等' : value === false ? '有差异' : '未知';
  const p = report.preservation;
  element('joint-report').textContent =
    (explorationProject()?'计算范围固定0.5–7.5秒。':'')+'局部人声强弱（相对语境）' + level(report.motion.before) + ' → ' + level(report.motion.after) +
    '。周期起伏：未知。声质 CPPS ' + finite(report.quality.before.cpps) + ' → ' + finite(report.quality.after.cpps) +
    '，HNR ' + finite(report.quality.before.hnr) + ' → ' + finite(report.quality.after.hnr) +
    '。人声 2–3 kHz 相对能量 ' + color(report.timbre.before) + ' → ' + color(report.timbre.after) +
    (exploration ? '。处理范围外的人声' : '。保护区人声') + preserved(p.protected_voice_equal) +
    (info.kind === 'piano' ? '，保护区混音' + preserved(p.protected_mix_equal) +
      '，估计伴奏残差' + preserved(p.estimated_residual_equal) : '') +
    '。请同位试听后决定保留哪一版。';
  message('已核所选版本和位置的计算线索。');
}, '计算同一选区、两版的对照…');

async function settledView() {
  const began = epoch, pending = active;
  if (pending) { message('正在等待本次处理结束后保存；已有声音仍可听。'); try { await pending; } catch {} }
  if (began !== epoch) throw new Error('project_changed_before_save');
  if (fixedRecipe() && !canSaveRecipe()) throw new Error('recording_combination_trial_scope');
  return snapshotView();
}
button('save').onclick = async () => {
  try {
    const view = await settledView(), api = await connect();
    const id = (!jointProject() && projectId) || (jointProject() ? 'J:' : '') + recordingTitle.slice(0, 55) + ' · ' + new Date().toLocaleString() + ' · ' + crypto.randomUUID().slice(0, 6);
    const saved = await api.rpc(jointProject() ? 'jointSave' : 'save', { projectId: id, view,
      ...(explorationProject()?{saveRole:select('private-save-role').value}:{}) });
    projectId = saved.id; message('已保存在此浏览器。');
  } catch (error) { message(friendly(error), true); }
};
button('export').onclick = async () => {
  try { const view = await settledView(), api = await connect(), result = await api.rpc(jointProject() ? 'jointExport' : 'export', { view });
    download(result.blob, 'voice-project-' + Date.now() + (result.metadataOnly ? '.json' : '.voiceproj'));
    message(result.metadataOnly ? '已导出编辑记录。私有声音保留在本次限时本地工程中。'
      : '工程已导出；文件包含原录音和结果，请妥善保存。');
  } catch (error) { message(friendly(error), true); }
};

button('saved').onclick = async () => {
  dialog('saved-dialog').showModal(); element('saved-list').textContent = '读取此浏览器中的工程…';
  try {
    const api = await connect(), legacy = await api.rpc('list');
    const entries = legacy.map((id) => ({ id, joint: false }));
    element('saved-list').replaceChildren();
    try { entries.push(...(await api.rpc('jointList')).map((id) => ({ id, joint: true }))); }
    catch { element('saved-list').textContent = '三类探索的本地工程暂不可读取。'; }
    if (!entries.length && !element('saved-list').textContent) element('saved-list').textContent = '这里还没有保存的工程。';
    for (const { id, joint } of entries) {
      const row = document.createElement('div'), label = document.createElement('span'), open = document.createElement('button'), remove = document.createElement('button');
      row.className = 'saved-row'; label.textContent = id; open.textContent = '打开'; remove.textContent = '删除';
      open.onclick = () => { dialog('saved-dialog').close(); run(async () => { const next = await api.rpc(joint ? 'jointReopen' : 'reopen', { projectId: id }); adopt(next, id, id); message(next.expired ? '素材已过期，已恢复草稿与原选区。' : '本地工程已恢复，试听范围与草稿已保留。'); }, '恢复本地工程与已听结果…'); };
      remove.onclick = async () => { try { await api.rpc(joint ? 'jointDelete' : 'delete', { projectId: id }); row.remove(); if (projectId === id && joint === jointProject()) clearCurrent(); } catch (error) { message(friendly(error), true); } };
      row.append(label, open, remove); element('saved-list').append(row);
    }
  } catch (error) { element('saved-list').textContent = friendly(error); }
};
function clearCurrent({ keepWorker = false } = {}) {
  clearTimeout(expiryTimer);
  epoch++; if (!keepWorker) active = null;
  intentEditor.reset();versionRecords.reset();requestFeasibility.clear();
  workspace.close(); disposeAudio(); sounds.clear(); history.clear();
  info = null; projectId = null; engineAvailable = false; latestId = null; recordingTitle = ''; resultId = 'U'; currentRole = 'O';
  if (!keepWorker) {
    if (client) client.close();
    client = null; connecting = null;
  }
  playbackRange = { start: 0, end: 1, mode: 'local' };
  input('listen-start').value = '0'; input('listen-end').value = '1';
  input('local').checked = true; input('whole').checked = false; input('follow').checked = true;
  setDraft({ start_frame: 0, end_frame: 200, amount: 6, mode: 'flat' });
  element('recording-title').textContent = '一段演唱，几种聆听的方式'; element('duration').textContent = '—';
  element('range-label').textContent = '处理范围将由录音的实际条件确定';
  element('heard').textContent = '未开始处理。原声、同链参考与新声音会分别保留自己的身份。';
  element('intent').textContent = '先打开一段符合条件的演唱。';
  for (const role of ['O', 'U', 'E']) button('hear-' + role).classList.remove('active');
  element('empty').hidden = false; updateHistory(); updateControls(); draw();
  message('当前工程已关闭；已导出的文件需自行管理。');
}
button('delete-all').onclick = async () => {
  try {
    const api = await connect(); await api.rpc('deleteAll'); await api.rpc('jointClear');
    const clearedSetup = !api.privateSetup || await privateSetupStorage('clear').then(() => true, () => false);
    clearCurrent(); element('saved-list').textContent = '本页本地工程已删除。';
    const request = indexedDB.deleteDatabase('voice-local-verification-v1'); request.onerror = () => message('工程已删除；核验记录清理未完成，请关闭其它本页后重试。', true);
    message(clearedSetup ? '本页本地工程已删除；已导出的文件需自行删除。' : '工程已删除。浏览器未能清理私有体验配置，请重试。', !clearedSetup);
  } catch (error) { message(friendly(error), true); }
};
button('privacy').onclick = () => dialog('help-dialog').showModal();
button('licenses').onclick = () => dialog('license-dialog').showModal();
document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', () => node.closest('dialog')?.close()));
element('verification').hidden = !verification;
button('evidence').onclick = async () => {
  try { const api = await connect(), slot = select('evidence-slot').value, result = await api.rpc('evidence', { slot });
    const name = 'evidence-' + result.header.input_sha256.slice(0, 12) + '-' + slot;
    download(new Blob([JSON.stringify(result.header, null, 2)], { type: 'application/json' }), name + '.json');
    const extension = result.header.schema === 'voice-waveform-evidence-v2' ? '.wav' : '.bin';
    download(result.blob, name + extension); element('verification-status').textContent = '已导出 ' + slot;
  } catch (error) { message(friendly(error), true); }
};
button('audit').onclick = async () => {
  try { const api = await connect(), result = await api.rpc('audit',{resultId}); download(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), 'local-verification-' + Date.now() + '.json'); }
  catch (error) { message(friendly(error), true); }
};
fetch('./release.json', { credentials: 'omit' }).then((r) => { if (!r.ok) throw new Error('release_load_failed'); return r.json(); }).then((metadata) => {
  release = metadata;
  if (metadata.joint?.enabled === true) {
    jointStorage(indexedDB, 'purge').catch(() => message('暂时无法检查私有素材期限。', true));
  }
  button('joint-solo').hidden = metadata.joint?.enabled !== true;
  if (verification && metadata.joint?.private_solo_trial) button('joint-solo').textContent = '载入核验独唱';
  button('joint-piano').hidden = metadata.joint?.enabled !== true;
  const runMode = metadata.joint?.private_run === true;
  if (runMode) {
    runChannel = new BroadcastChannel('voice-private-run-end');
    runChannel.onmessage = ({data}) => {
      if (!currentPrivateRunId || data !== currentPrivateRunId) return;
      privateInputs.clear();
      if (Number.isSafeInteger(info?.expires)) clearCurrent();
    };
  }
  button('private-setup').hidden = !privateSetupEnabled(metadata) || runMode;
  element('private-run-panel').hidden = !runMode;
  button('delete-all').hidden = runMode;
  if (privateSetupEnabled(metadata)) loadPrivateSetup().catch(() => {});
  element('version').textContent = '版本 ' + metadata.release.slice(0, 12) + ' · 原录音始终保留';
  const area = element('source-downloads'), source = metadata.source;
  if (!source) return;
  if(metadata.source_overlay?.path==='source-overlay/README.md') {
    const overlay=document.createElement('a');overlay.href=metadata.source_overlay.path;
    overlay.textContent='完整源码与本版重建说明';area.append(overlay);
  }
  const link = document.createElement('button'); link.textContent = (metadata.source_overlay?'下载基础源码包（':'下载完整对应源码（') + (source.bytes / 1024 / 1024).toFixed(1) + ' MB）';
  link.onclick = async () => { try { link.disabled = true; const bytes = await loadAsset(source, async (path) => {
    const r = await fetch(path, { credentials: 'omit' }); if (!r.ok) throw new Error('source_load_failed'); return new Uint8Array(await r.arrayBuffer());
  }, 1024 ** 3); download(new Blob([bytes], { type: 'application/gzip' }), 'voice-source-' + metadata.release.slice(0, 12) + '.tar.gz'); }
  catch (error) { message(friendly(error), true); } finally { link.disabled = false; } };
  area.append(link);
}).catch((error) => message(friendly(error), true));
updateControls();
