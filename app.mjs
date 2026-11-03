// SPDX-License-Identifier: GPL-3.0-or-later
import { createWorkspace } from './state.mjs';
import { loadAsset } from './assets.mjs';

const element = (id) => { const value = document.getElementById(id); if (!value) throw new Error('missing_view:' + id); return value; };
const input = (id) => { const value = element(id); if (!(value instanceof HTMLInputElement)) throw new Error('missing_input'); return value; };
const select = (id) => { const value = element(id); if (!(value instanceof HTMLSelectElement)) throw new Error('missing_select'); return value; };
const button = (id) => { const value = element(id); if (!(value instanceof HTMLButtonElement)) throw new Error('missing_button'); return value; };
const dialog = (id) => { const value = element(id); if (!(value instanceof HTMLDialogElement)) throw new Error('missing_dialog'); return value; };
const verification = new URLSearchParams(location.search).get('verification') === '1';
const workspace = createWorkspace();
let client = null, connecting = null, info = null, active = null, epoch = 0, resultId = 'U', projectId = null;
let currentAudio = null, currentURL = null, currentRole = 'O', recordingTitle = '', release = null;
let connectionVersion = 0;
let engineAvailable = false, playbackRange = { start: 0, end: 1, mode: 'local' };
const sounds = new Map(), history = new Map();

function message(text, failed = false) {
  element('status').textContent = text;
  element('status').classList.toggle('error', failed);
}

function friendly(error) {
  const code = error instanceof Error ? error.message : String(error);
  if (/condition.insufficient|insufficient_support|ineligible|invalid_window|ambiguous_independent_mapping/.test(code)) return '这段录音或选区不满足当前处理条件。已有可听结果仍保留，可调整合法选区或使用另一段录音。';
  if (/invalid_wav|project_wav/.test(code)) return '请选择44.1 kHz、单声道、16位PCM WAV，最长45秒。当前没有生成新声音。';
  if (/quota|storage|Quota/.test(code)) return '本地保存未完成；旧工程仍保留。请检查浏览器空间，或先导出工程。';
  if (/identity|incompatible|invalid_project|invalid_parent|invalid_export|restored_result/.test(code)) return '工程或组件身份不一致，已拒绝使用。当前已打开的结果仍保留。';
  if (/budget/.test(code)) return '本次本机核验额度已用尽，已有声音与工程仍保留。';
  if (/timeout|worker|processor_busy/.test(code)) return '本次处理未完成。已有结果仍可试听；请等待当前操作结束后重试。';
  return '本次操作未完成：' + code + '。已有成果不会被失败结果替换。';
}

function control() {
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
  const modes = { flat: '均匀', front: '前半展开', back: '后半展开' };
  return `${c.amount > 0 ? '+' : ''}${c.amount} dB · ${modes[c.mode]} · ${(c.start_frame / 200).toFixed(3)}–${(c.end_frame / 200).toFixed(3)}秒`;
}

function listening() {
  return { ...playbackRange, selected: currentRole };
}

function snapshotView() {
  return { resultId, draftControl: structuredClone(workspace.view().draft), listening: listening() };
}

function updateControls() {
  const enabled = !!info;
  for (const id of ['amount', 'start', 'end']) input(id).disabled = !enabled;
  select('development').disabled = !enabled;
  select('history').disabled = !!active;
  button('generate').disabled = !enabled || !engineAvailable || !!active;
  button('save').disabled = !enabled || !engineAvailable;
  button('export').disabled = !enabled || !engineAvailable;
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
  for (const [a, b] of info.source.eligible_intervals.T) {
    ctx.fillStyle = '#bdcfa944'; ctx.fillRect(25 + (width - 50) * a / 200 / duration, 55, (width - 50) * (b - a) / 200 / duration, height - 110);
  }
  const x = 25 + (width - 50) * start / duration, last = 25 + (width - 50) * end / duration;
  ctx.fillStyle = '#b94e3122'; ctx.fillRect(x, 35, Math.max(2, last - x), height - 65);
  ctx.strokeStyle = '#b94e31'; ctx.lineWidth = 2; ctx.strokeRect(x, 35, Math.max(2, last - x), height - 65);
  element('range-label').textContent = `当前局部 ${start.toFixed(3)}–${end.toFixed(3)} 秒 · 阴影为可处理范围`;
}

function setDraft(c) {
  input('start').value = String(c.start_frame / 200); input('end').value = String(c.end_frame / 200);
  input('amount').value = String(c.amount); select('development').value = c.mode;
  element('amount-value').textContent = (c.amount > 0 ? '+' : '') + c.amount;
  element('intent').textContent = '当前草稿：' + describe(c);
  draw();
}

function disposeAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio.removeAttribute('src'); currentAudio.load(); currentAudio = null; }
  if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }
  element('audio').replaceChildren();
}

function hear(role) {
  const sound = sounds.get(role); if (!sound) return;
  disposeAudio(); currentRole = role;
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata';
  currentURL = URL.createObjectURL(new Blob([sound.bytes], { type: 'audio/wav' }));
  audio.src = currentURL; audio.volume = role === 'O' ? .5 : 1;
  const range = listening();
  audio.addEventListener('loadedmetadata', () => { if (audio === currentAudio) audio.currentTime = range.mode === 'local' ? range.start : 0; });
  audio.addEventListener('play', () => {
    if (audio !== currentAudio) { audio.pause(); return; }
    const r = listening(); if (r.mode === 'local' && (audio.currentTime < r.start || audio.currentTime >= r.end)) audio.currentTime = r.start;
  });
  audio.addEventListener('timeupdate', () => { const r = listening(); if (audio === currentAudio && r.mode === 'local' && audio.currentTime >= r.end) audio.pause(); });
  audio.addEventListener('error', () => { if (audio === currentAudio) { audio.pause(); message('此版本暂不可播放。工程仍保留，可切换原声或同链参考。', true); } });
  currentAudio = audio; element('audio').append(audio);
  for (const name of ['O', 'U', 'E']) button('hear-' + name).classList.toggle('active', name === role);
  element('heard').textContent = (role === 'O' ? '原声 · ' : role === 'U' ? '同链无编辑 · ' : '正在聆听的完成版本 · ') + describe(sound.control) +
    (sound.sha256 ? ' · ' + sound.sha256.slice(0, 12) : '');
}

function connect() {
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
        connectionVersion++; client = null; connecting = null; engineAvailable = false; updateControls();
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
      if (data.ok) request.resolve(data.result); else request.reject(new Error(data.error || 'processing_failed'));
      if (data.elapsed_ms) element('timing').textContent = `最近操作 ${(data.elapsed_ms / 1000).toFixed(1)} 秒 · 本机处理`;
    };
    worker.onerror = () => stop('worker_failed');
    try { await rpc('initialize', { verification }); } catch (error) { stop('worker_failed'); throw error; }
    if (closed || generation !== connectionVersion) throw new Error('worker_closed');
    client = { rpc, close() { stop('worker_closed'); } };
    return client;
  })();
  return connecting;
}

function adopt(next, title, savedId = null) {
  epoch++; info = next; engineAvailable = true; recordingTitle = title; projectId = savedId; sounds.clear(); history.clear();
  sounds.set('O', next.original); sounds.set('U', next.baseline); resultId = 'U';
  for (const item of next.available || []) history.set(item.id, item);
  if (next.result) { sounds.set('E', next.result); history.set(next.result.id, next.result); resultId = next.result.id; }
  const [a, b] = next.source.default_region;
  const draft = next.draft || { start_frame: a, end_frame: b, amount: 6, mode: 'flat' };
  workspace.open(String(epoch), draft, next.result || next.baseline);
  setDraft(draft); element('empty').hidden = true;
  element('recording-title').textContent = title; element('duration').textContent = (next.samples / 44100).toFixed(2) + ' 秒 · 本地录音';
  const range = next.listening;
  input('whole').checked = range?.mode === 'whole'; input('local').checked = !input('whole').checked;
  playbackRange = range ? { start: range.start, end: range.end, mode: range.mode } : { start: a / 200, end: b / 200, mode: 'local' };
  input('listen-start').value = String(playbackRange.start); input('listen-end').value = String(playbackRange.end);
  input('follow').checked = playbackRange.start === draft.start_frame / 200 && playbackRange.end === draft.end_frame / 200;
  updateHistory(); updateControls(); draw(); hear(range?.selected && sounds.has(range.selected) ? range.selected : 'O');
}

function updateHistory() {
  const list = select('history'); list.replaceChildren();
  const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = '其它完成版本'; list.append(prompt);
  for (const sound of history.values()) { const option = document.createElement('option'); option.value = sound.id; option.textContent = describe(sound.control); list.append(option); }
  list.hidden = history.size < 2;
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
button('upload').onclick = () => input('wav-file').click();
button('open').onclick = () => input('project-file').click();
input('wav-file').onchange = () => { const file = input('wav-file').files?.[0]; if (file) run(async () => {
  if (file.size > 8 * 1024 * 1024) throw new Error('invalid_wav');
  await openWav(new Uint8Array(await file.arrayBuffer()), file.name);
}, '导入录音，独立检查可处理区间…'); input('wav-file').value = ''; };
input('project-file').onchange = () => { const file = input('project-file').files?.[0]; if (file) run(async () => {
  const api = await connect(); const next = await api.rpc('import', { blob: file }); adopt(next, file.name);
  message('文件工程已从原录音重新验证，可继续修改。');
}, '验证文件工程，并从原录音恢复结果…'); input('project-file').value = ''; };

for (const id of ['amount', 'start', 'end']) input(id).oninput = edit;
select('development').onchange = edit;
function edit() {
  if (!info) return;
  try { const c = control(); workspace.edit(c); setDraft(c);
    if (input('follow').checked) { playbackRange.start = c.start_frame / 200; playbackRange.end = c.end_frame / 200;
      input('listen-start').value = String(playbackRange.start); input('listen-end').value = String(playbackRange.end); }
  }
  catch (error) { message(friendly(error), true); }
}
for (const id of ['local', 'whole']) input(id).onchange = () => { playbackRange.mode = input('whole').checked ? 'whole' : 'local'; if (info) hear(currentRole); };
for (const id of ['listen-start', 'listen-end']) input(id).onchange = () => {
  const start = Number(input('listen-start').value), end = Number(input('listen-end').value);
  if (!info || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > info.samples / 44100) { message('试听范围必须位于录音内，且结束晚于开始。', true); return; }
  playbackRange = { ...playbackRange, start, end }; input('follow').checked = false; hear(currentRole);
};
input('follow').onchange = () => { if (info && input('follow').checked) edit(); };
for (const name of ['O', 'U', 'E']) button('hear-' + name).onclick = () => hear(name);
select('history').onchange = () => {
  const item = history.get(select('history').value); if (!item) return;
  resultId = item.id; sounds.set('E', item); hear('E');
};

button('generate').onclick = () => run(async () => {
  const c = control(), request = workspace.begin(), began = epoch;
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

async function settledView() {
  const began = epoch, pending = active;
  if (pending) { message('正在等待本次处理结束后保存；已有声音仍可听。'); try { await pending; } catch {} }
  if (began !== epoch) throw new Error('project_changed_before_save');
  return snapshotView();
}
button('save').onclick = async () => {
  try {
    const view = await settledView(), api = await connect();
    const id = projectId || recordingTitle.slice(0, 55) + ' · ' + new Date().toLocaleString() + ' · ' + crypto.randomUUID().slice(0, 6);
    await api.rpc('save', { projectId: id, view }); projectId = id; message('已保存在此浏览器：' + id);
  } catch (error) { message(friendly(error), true); }
};
button('export').onclick = async () => {
  try { const view = await settledView(), api = await connect(), result = await api.rpc('export', { view });
    download(result.blob, 'voice-project-' + Date.now() + '.voiceproj'); message('工程已导出；文件包含原录音和结果，请妥善保存。');
  } catch (error) { message(friendly(error), true); }
};

button('saved').onclick = async () => {
  dialog('saved-dialog').showModal(); element('saved-list').textContent = '读取此浏览器中的工程…';
  try {
    const api = await connect(), ids = await api.rpc('list'); element('saved-list').replaceChildren();
    if (!ids.length) element('saved-list').textContent = '这里还没有保存的工程。';
    for (const id of ids) {
      const row = document.createElement('div'), label = document.createElement('span'), open = document.createElement('button'), remove = document.createElement('button');
      row.className = 'saved-row'; label.textContent = id; open.textContent = '打开'; remove.textContent = '删除';
      open.onclick = () => { dialog('saved-dialog').close(); run(async () => { const next = await api.rpc('reopen', { projectId: id }); adopt(next, id, id); message('本地工程已恢复，试听范围与草稿已保留。'); }, '恢复本地工程与已听结果…'); };
      remove.onclick = async () => { try { await api.rpc('delete', { projectId: id }); row.remove(); if (projectId === id) clearCurrent(); } catch (error) { message(friendly(error), true); } };
      row.append(label, open, remove); element('saved-list').append(row);
    }
  } catch (error) { element('saved-list').textContent = friendly(error); }
};
function clearCurrent() {
  epoch++; active = null; workspace.close(); disposeAudio(); sounds.clear(); history.clear();
  info = null; projectId = null; engineAvailable = false; recordingTitle = ''; resultId = 'U'; currentRole = 'O';
  if (client) client.close(); client = null; connecting = null;
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
    const api = await connect(); await api.rpc('deleteAll'); clearCurrent(); element('saved-list').textContent = '本页本地工程已删除。';
    const request = indexedDB.deleteDatabase('voice-local-verification-v1'); request.onerror = () => message('工程已删除；核验记录清理未完成，请关闭其它本页后重试。', true);
    message('本页本地工程已删除；已导出的文件需自行删除。');
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
    download(result.blob, name + '.bin'); element('verification-status').textContent = '已导出 ' + slot;
  } catch (error) { message(friendly(error), true); }
};
button('audit').onclick = async () => {
  try { const api = await connect(), result = await api.rpc('audit'); download(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), 'local-verification-' + Date.now() + '.json'); }
  catch (error) { message(friendly(error), true); }
};
fetch('./release.json', { credentials: 'omit' }).then((r) => { if (!r.ok) throw new Error('release_load_failed'); return r.json(); }).then((metadata) => {
  release = metadata; element('version').textContent = '版本 ' + metadata.release.slice(0, 12) + ' · 原录音始终保留';
  const area = element('source-downloads'), source = metadata.source;
  if (!source) return;
  const link = document.createElement('button'); link.textContent = '下载完整对应源码（' + (source.bytes / 1024 / 1024).toFixed(1) + ' MB）';
  link.onclick = async () => { try { link.disabled = true; const bytes = await loadAsset(source, async (path) => {
    const r = await fetch(path, { credentials: 'omit' }); if (!r.ok) throw new Error('source_load_failed'); return new Uint8Array(await r.arrayBuffer());
  }, 1024 ** 3); download(new Blob([bytes], { type: 'application/gzip' }), 'voice-source-' + metadata.release.slice(0, 12) + '.tar.gz'); }
  catch (error) { message(friendly(error), true); } finally { link.disabled = false; } };
  area.append(link);
}).catch((error) => message(friendly(error), true));
updateControls();
