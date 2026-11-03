// SPDX-License-Identifier: GPL-3.0-or-later
import { inspectPcm16, decodePcm16, encodePcm32 } from './pcm.mjs';
import { prepareT, tiltFrameWeights } from './t_control.mjs';
import { renderWaveformTilt } from './waveform_tilt.mjs';
import { qualifySource } from './qualification.mjs';
import { sha256 } from './identity.mjs';

export const LEGACY_METHOD = 'voice-local-world-praat-T-v1';
export const METHOD = 'voice-local-praat-waveform-T-v2';
const MAX_PARENT = 256 * 1024 * 1024;
const copyControl = (c) => ({ start_frame: c.start_frame, end_frame: c.end_frame, amount: c.amount, mode: c.mode });
const controlTag = (c) => [c.start_frame, c.end_frame, c.amount, c.mode];
const recordTag = (r) => JSON.stringify([r.engine_id, r.input_sha256, r.result_sha256, r.parent_sha256,
  controlTag(r.control), controlTag(r.draft_control), r.listening.start, r.listening.end, r.listening.mode, r.listening.selected]);
const rawLength = (frames) => Math.floor(frames * 5 * 44100 / 1000);

function validateAnalysis(analysis, samples) {
  const frames = Math.floor(1000 * samples / 44100 / 5) + 1;
  if (!analysis || analysis.frames !== frames) throw new Error('invalid_analysis');
  for (const [name, length] of [['time', frames], ['f0', frames], ['sp', frames * 1025], ['ap', frames * 1025]]) {
    const value = analysis[name];
    if (!(value instanceof Float64Array) || value.length !== length ||
        Object.prototype.toString.call(value.buffer) !== '[object ArrayBuffer]' || !value.every(Number.isFinite)) throw new Error('invalid_analysis');
  }
  if (!analysis.time.every((x, i) => Math.abs(x - i * .005) <= 1e-12) || !analysis.f0.every((x) => x >= 0 && x < 22050) ||
      !analysis.sp.every((x) => x >= 0) || !analysis.ap.every((x) => x >= 0 && x <= 1)) throw new Error('invalid_analysis');
}

function publicSource(source) {
  return structuredClone({ window_frames: source.window_frames, window_samples: source.window_samples,
    default_region: source.default_region, eligible_intervals: { T: source.eligible_intervals.T } });
}

function packParent(parent, baseline, method, versions) {
  const history = [...versions.values()].filter((v) => v.id !== 'U');
  const header = new TextEncoder().encode(JSON.stringify({ schema: 'voice-parent-v1', method,
    input_sha256: parent.inputSha256, samples: parent.samples, frames: parent.analysis.frames,
    track: parent.track, baseline_length: baseline.length,
    history: history.map((v) => ({ id: v.id, sha256: v.sha256, control: v.control, length: v.bytes.length })) }));
  const arrays = ['time', 'f0', 'sp', 'ap'].map((name) => parent.analysis[name]);
  const total = 4 + header.length + arrays.reduce((sum, a) => sum + a.byteLength, 0) + baseline.length + history.reduce((sum, v) => sum + v.bytes.length, 0);
  if (header.length > 1048576 || total > MAX_PARENT) throw new Error('project_limit');
  const output = new Uint8Array(total), view = new DataView(output.buffer);
  view.setUint32(0, header.length, true); output.set(header, 4);
  let offset = 4 + header.length;
  for (const array of arrays) for (const value of array) { view.setFloat64(offset, value, true); offset += 8; }
  output.set(baseline, offset); offset += baseline.length;
  for (const v of history) { output.set(v.bytes, offset); offset += v.bytes.length; }
  return output;
}

function unpackParent(bytes, inputHash, samples, method) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > MAX_PARENT) throw new Error('invalid_parent');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = view.getUint32(0, true);
  if (!size || size > 1048576 || size + 4 > bytes.length) throw new Error('invalid_parent');
  let header;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + size))); }
  catch { throw new Error('invalid_parent'); }
  const frames = Math.floor(1000 * samples / 44100 / 5) + 1;
  if (!header || header.schema !== 'voice-parent-v1' || header.method !== method || header.input_sha256 !== inputHash ||
      header.samples !== samples || header.frames !== frames || !Array.isArray(header.track) || header.track.length > 10000 ||
      header.baseline_length !== 44 + samples * 4 || !Array.isArray(header.history) || header.history.length > 7 ||
      !header.history.every((v) => typeof v.id === 'string' && v.id.length <= 256 && /^[0-9a-f]{64}$/.test(v.sha256) && v.length === 44 + samples * 4) ||
      bytes.length !== 4 + size + (2 * frames + 2 * frames * 1025) * 8 + header.baseline_length + header.history.length * (44 + samples * 4)) throw new Error('invalid_parent');
  let offset = 4 + size;
  const read = (length) => {
    const array = new Float64Array(length);
    for (let i = 0; i < length; i++) { array[i] = view.getFloat64(offset, true); offset += 8; }
    return array;
  };
  const analysis = { frames, time: read(frames), f0: read(frames), sp: read(frames * 1025), ap: read(frames * 1025) };
  validateAnalysis(analysis, samples);
  const baseline = bytes.slice(offset, offset + header.baseline_length); offset += header.baseline_length;
  const history = header.history.map((v) => { const entry = { ...v, bytes: bytes.slice(offset, offset + v.length) }; offset += v.length; return entry; });
  return { analysis, track: header.track, baseline, history };
}

/**
 * @typedef {Awaited<ReturnType<typeof import('./projects.mjs').makeProject>>} ProjectRecord
 * @typedef {{frames:number, time:Float64Array, f0:Float64Array, sp:Float64Array, ap:Float64Array}} Analysis
 * @param {{sdk: {pitch:(input:Uint8Array, hash:string)=>Promise<Array<{time:number,hz:number,undefined:boolean}>>,
 * analyze:(samples:Float64Array)=>Promise<Analysis>|Analysis, synthesize:(analysis:Analysis)=>Promise<Float64Array>|Float64Array,
 * close?:()=>void}, reserve?:(event:{kind:string,slot:string,input_sha256:string|null,samples:number,utc:string})=>Promise<void>,
 * verifyLocal?:(record:ProjectRecord)=>Promise<ProjectRecord>, method?:string}} options
 */
export function createEngine({ sdk, reserve = async () => {}, verifyLocal = async () => { throw new Error('untrusted_local_project'); }, method = METHOD }) {
  if (!sdk || typeof sdk.pitch !== 'function' || typeof sdk.analyze !== 'function' || typeof sdk.synthesize !== 'function') throw new Error('invalid_sdk');
  let parent = null, baseline = null;
  const versions = new Map(), snapshots = new Set();
  const events = [];
  const charge = async (kind, slot, samples = 0, inputHash = parent?.inputSha256 ?? null) => {
    const event = { kind, slot, input_sha256: inputHash, samples, utc: new Date().toISOString() };
    await reserve(event); events.push(event);
  };
  const compatible = (storedMethod) => storedMethod === method ||
    (method === METHOD && storedMethod === LEGACY_METHOD);
  const qualify = (analysis, track, inputHash, samples, activeMethod) =>
    qualifySource({ ...analysis, samples, track, inputSha256: inputHash, methodVersion: activeMethod }, (source) => {
      const [first, last] = source.default_region;
      const inset = first + Math.ceil((last - first) / 4);
      const edits = [[first, 6, 'flat'], [first, -6, 'front'], [inset, 3, 'back'],
        [inset, 3, 'flat'], [inset, -3, 'flat']];
      return edits.every(([start, amount, mode]) => {
        try {
          const result = prepareT(analysis, source, { start_frame: start, end_frame: last, amount, mode });
          return result.sp.some((value, index) => value !== analysis.sp[index]);
        } catch (error) {
          if (error.message === 'insufficient_support') return false;
          throw error;
        }
      });
    }, activeMethod === LEGACY_METHOD);
  const expose = (version) => ({ id: version.id, sha256: version.sha256,
    control: version.control ? copyControl(version.control) : null, bytes: version.bytes.slice() });
  const info = () => ({ input_sha256: parent.inputSha256, samples: parent.samples, sample_rate: 44100,
    source: publicSource(parent.source), original: { id: 'O', bytes: parent.input.slice() }, baseline: expose(baseline), method_version: parent.method });

  // Build a complete candidate before replacing any live input or heard version.
  async function analyzeCandidate(input, activeMethod = method) {
      if (!(input instanceof Uint8Array) || Object.prototype.toString.call(input.buffer) !== '[object ArrayBuffer]') throw new Error('invalid_wav');
      const bytes = input.slice(), format = inspectPcm16(bytes);
      await charge('audio_read', 'input-identity', format.samples, null);
      const inputSha256 = await sha256(bytes);
      await charge('audio_read', 'input-decode', format.samples, inputSha256);
      const samples = decodePcm16(bytes);
      await charge('praat', 'analyze', 0, inputSha256);
      await charge('audio_read', 'praat-input', samples.length, inputSha256);
      const track = await sdk.pitch(bytes, inputSha256);
      for (const kind of ['harvest', 'cheaptrick', 'd4c']) await charge(kind, 'analyze', 0, inputSha256);
      await charge('audio_read', 'world-input', 3 * samples.length, inputSha256);
      const analysis = await sdk.analyze(samples);
      validateAnalysis(analysis, samples.length);
      const source = qualify(analysis, track, inputSha256, samples.length, activeMethod);
      let raw = samples;
      if (activeMethod !== METHOD) {
        await charge('synthesize', 'U', 0, inputSha256);
        raw = await sdk.synthesize(analysis);
      }
      const length = activeMethod === METHOD ? samples.length : rawLength(analysis.frames);
      await charge('audio_read', 'U-output-QA', 3 * length, inputSha256);
      const wave = encodePcm32(raw, samples.length, length);
      const waveSha = await sha256(wave);
    const nextParent = { input: bytes, inputSha256, samples: samples.length, analysis, track, source, method: activeMethod };
    const nextBaseline = { id: 'U', bytes: wave, sha256: waveSha,
      control: { start_frame: source.default_region[0], end_frame: source.default_region[1], amount: 0, mode: 'flat' } };
    return { parent: nextParent, baseline: nextBaseline };
  }
  function commit(candidate) {
    parent = candidate.parent; baseline = candidate.baseline;
    versions.clear(); snapshots.clear(); versions.set('U', baseline);
  }
  async function renderCandidate(candidate, control, slot) {
    const selected = copyControl(control);
    const changed = prepareT(candidate.analysis, candidate.source, selected);
    const waveform = candidate.method === METHOD;
    let raw, length;
    if (waveform) {
      await charge('audio_read', 'waveform-source', candidate.samples, candidate.inputSha256);
      const original = decodePcm16(candidate.input);
      const weights = tiltFrameWeights(candidate.analysis, candidate.source, selected);
      raw = renderWaveformTilt(original, weights, selected.amount);
      length = candidate.samples;
    } else {
      await charge('synthesize', slot ?? 'edit', 0, candidate.inputSha256);
      raw = await sdk.synthesize({ ...candidate.analysis, sp: changed.sp });
      length = rawLength(candidate.analysis.frames);
    }
    await charge('audio_read', 'edit-output-QA', 3 * length, candidate.inputSha256);
    const bytes = encodePcm32(raw, candidate.samples, length);
    const hash = await sha256(bytes), id = 'E:' + hash + ':' + JSON.stringify(controlTag(selected));
    return { id, sha256: hash, bytes, control: selected, sp: waveform ? null : changed.sp,
      active: waveform ? null : changed.active, slot };
  }

  const engine = {
    id: method,
    async analyze(input) {
      commit(await analyzeCandidate(input));
      return info();
    },
    async render(control, slot = null, keepId = null) {
      if (!parent?.analysis) throw new Error('analysis_required');
      const version = await renderCandidate(parent, control, slot);
      versions.set(version.id, version);
      if (versions.size > 8) {
        const removable = [...versions.values()].find((v) => v.id !== 'U' && v.id !== version.id && v.id !== keepId);
        if (removable) versions.delete(removable.id);
      }
      return expose(version);
    },
    async snapshot({ resultId = 'U', draftControl, listening }) {
      const version = versions.get(resultId);
      if (!parent || !version) throw new Error('result_missing');
      const parentBytes = packParent(parent, baseline.bytes, parent.method, versions);
      const record = { engine_id: parent.method, input_sha256: parent.inputSha256, result_sha256: version.sha256,
        parent_sha256: await sha256(parentBytes), control: copyControl(version.control), draft_control: copyControl(draftControl), listening: structuredClone(listening) };
      snapshots.add(recordTag(record));
      return { inputBytes: parent.input.slice(), resultBytes: version.bytes.slice(), parentBytes,
        inputSha256: record.input_sha256, resultSha256: record.result_sha256, parentSha256: record.parent_sha256,
        engineId: parent.method, control: record.control, draftControl: record.draft_control, listening: record.listening };
    },
    async authorizeSnapshot(record) {
      return snapshots.has(recordTag(record)) && await sha256(record.input) === record.input_sha256 &&
        await sha256(record.result) === record.result_sha256 && await sha256(record.parent) === record.parent_sha256;
    },
    async restoreLocal(record) {
      const verified = await verifyLocal(record);
      if (!compatible(verified.engine_id)) throw new Error('incompatible_method');
      const format = inspectPcm16(verified.input);
      const restored = unpackParent(verified.parent, verified.input_sha256, format.samples, verified.engine_id);
      const source = qualify(restored.analysis, restored.track, verified.input_sha256, format.samples, verified.engine_id);
      prepareT(restored.analysis, source, verified.control);
      const nextParent = { input: verified.input.slice(), inputSha256: verified.input_sha256, samples: format.samples,
        analysis: restored.analysis, track: restored.track, source, method: verified.engine_id };
      const nextBaseline = { id: 'U', bytes: restored.baseline, sha256: await sha256(restored.baseline),
        control: { start_frame: source.default_region[0], end_frame: source.default_region[1], amount: 0, mode: 'flat' } };
      const nextVersions = new Map([['U', nextBaseline]]);
      for (const v of restored.history) {
        prepareT(restored.analysis, source, v.control);
        if (await sha256(v.bytes) !== v.sha256) throw new Error('history_identity_mismatch');
        nextVersions.set(v.id, { id: v.id, bytes: v.bytes, sha256: v.sha256, control: copyControl(v.control) });
      }
      const result = { id: 'restored', bytes: verified.result.slice(), sha256: verified.result_sha256, control: copyControl(verified.control) };
      const known = [...nextVersions.values()].find((v) => v.sha256 === result.sha256 && JSON.stringify(controlTag(v.control)) === JSON.stringify(controlTag(result.control)));
      if (known) result.id = known.id;
      else nextVersions.set(result.id, result);
      commit({ parent: nextParent, baseline: nextBaseline });
      for (const [id, version] of nextVersions) versions.set(id, version);
      return { ...info(), result: expose(result), available: [...versions.values()].filter((v) => v.id !== 'U').map(expose),
        draft: copyControl(verified.draft_control), listening: structuredClone(verified.listening) };
    },
    async restoreImported(record) {
      if (!compatible(record.engine_id)) throw new Error('incompatible_method');
      const identity = await sha256(record.input);
      if (identity !== record.input_sha256) throw new Error('identity_mismatch');
      const candidate = await analyzeCandidate(record.input, record.engine_id);
      const result = await renderCandidate(candidate.parent, record.control, 'file-reproduce');
      if (result.sha256 !== record.result_sha256) throw new Error('restored_result_mismatch');
      commit(candidate); versions.set(result.id, result);
      return { ...info(), result: expose(result), draft: copyControl(record.draft_control), listening: structuredClone(record.listening) };
    },
    async evidencePiece(slot = 'parent') {
      if (!parent) throw new Error('analysis_required');
      if (parent.method === METHOD) {
        const version = slot === 'parent' ? baseline : [...versions.values()].find((entry) => entry.slot === slot);
        if (!version || (slot !== 'parent' && !/^E[1-5]$/.test(slot))) throw new Error('evidence_version_missing');
        return {
          header: { schema: 'voice-waveform-evidence-v2', input_sha256: parent.inputSha256,
            method_version: parent.method, samples: parent.samples, source: publicSource(parent.source),
            slot, control: version.control, wav_sha256: version.sha256, bytes: version.bytes.length },
          blob: new Blob([version.bytes], { type: 'audio/wav' }),
        };
      }
      let arrays, control = null;
      if (slot === 'parent') {
        arrays = { time: parent.analysis.time, f0: parent.analysis.f0,
          praat_time: Float64Array.from(parent.track, (row) => row.time), praat_f0: Float64Array.from(parent.track, (row) => row.hz),
          praat_undefined: Uint8Array.from(parent.track, (row) => row.undefined ? 1 : 0), sp: parent.analysis.sp, ap: parent.analysis.ap };
      } else {
        const version = [...versions.values()].find((v) => v.slot === slot && v.sp);
        if (!version || !/^E[1-5]$/.test(slot)) throw new Error('evidence_version_missing');
        arrays = { [slot + '_sp']: version.sp, [slot + '_active']: version.active }; control = version.control;
      }
      const descriptor = [], pieces = []; let offset = 0;
      for (const [name, array] of Object.entries(arrays)) {
        const bytes = new Uint8Array(array.length * array.BYTES_PER_ELEMENT), view = new DataView(bytes.buffer);
        if (array instanceof Float64Array) for (let i = 0; i < array.length; i++) view.setFloat64(8 * i, array[i], true);
        else bytes.set(array);
        descriptor.push({ name, offset, count: array.length, bytes: bytes.length,
          dtype: array instanceof Float64Array ? '<f8' : 'u1', sha256: await sha256(bytes) });
        pieces.push(bytes); offset += bytes.length;
      }
      return { header: { schema: 'voice-evidence-v1', input_sha256: parent.inputSha256, samples: parent.samples,
        frames: parent.analysis.frames, praat_frames: parent.track.length, method_version: parent.method,
        source: publicSource(parent.source), qualification: true, slot, control,
        controls: control ? { [slot]: control } : {}, arrays: descriptor, bytes: offset }, blob: new Blob(pieces) };
    },
    audit() { return structuredClone(events); },
    close() { parent = null; baseline = null; versions.clear(); snapshots.clear(); sdk.close?.(); },
  };
  return engine;
}
