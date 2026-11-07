// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256 } from '../identity.mjs';
import { checkDraft } from './intents.mjs';
import { NATIVE_PIANO_METHOD, NATIVE_PIANO_RENDERER } from './native_piano.mjs';

export const REGISTERED_PIANO_METHOD = 'voice-local-registered-piano-mqt-v1';
export const isRegisteredPianoMethod = (method) => method === REGISTERED_PIANO_METHOD || method === NATIVE_PIANO_METHOD;
const bins = 1025;
const hex = /^[a-f0-9]{64}$/;
const fields = ['time', 'f0', 'sp', 'ap'];
const runtime = {
  world_module: '8b27b73fefe8be20b36cf5288d06d1cd938813b7d9c1a179227fe1cac3d5cdcb',
  world_wasm: 'fabb1b8f6225f23221bb75f0b69fcbe6f6e033ef0c1aedf0d124393001715a46',
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const range = (value, limit) => Array.isArray(value) && value.length === 2 &&
  value.every(Number.isSafeInteger) && value[0] >= 0 && value[0] < value[1] && value[1] <= limit;

function decodeF64(bytes, length) {
  if (bytes.length !== length * 8) throw new Error('registered_axis');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Float64Array.from({ length }, (_, index) => view.getFloat64(index * 8, true));
  if (!values.every(Number.isFinite)) throw new Error('registered_axis');
  return values;
}

export function decodeRegisteredVoice(bytes, samples) {
  const voice = decodeF64(bytes, samples);
  if (!voice.every((sample) => Math.abs(sample) <= 1)) throw new Error('registered_voice_domain');
  return voice;
}

export async function analysisIdentity(analysis) {
  const pairs = [];
  for (const name of fields) {
    const values = analysis[name];
    if (!(values instanceof Float64Array)) throw new Error('registered_analysis');
    const bytes = new Uint8Array(values.length * 8), view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setFloat64(index * 8, value, true));
    pairs.push([name, await sha256(bytes)]);
  }
  return Object.fromEntries(pairs);
}

export function readRegisteredProfile(bytes, claims) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > 320 * 1024 ||
      new TextDecoder().decode(bytes.subarray(0, 8)) !== 'I37REG01') throw new Error('registered_profile');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (!headerLength || headerLength > 4096 || 12 + headerLength >= bytes.length) throw new Error('registered_profile');
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + headerLength)));
  const native = claims.schema === 'voice-native-piano-v1';
  const { frames, samples, frame_window: interval, sample_window: sampleWindow } = metadata;
  if (metadata.schema !== 'voice-registered-controls-v1' || metadata.method !== (native ? NATIVE_PIANO_METHOD : REGISTERED_PIANO_METHOD) ||
      metadata.renderer !== (native ? NATIVE_PIANO_RENDERER : 'mono-local-difference-v1-gain-half') || samples !== claims.frames ||
      frames !== Math.floor(samples / 220.5) + 1 || !range(interval, frames) || !range(sampleWindow, samples) ||
      !same(interval, sampleWindow.map((sample) => Math.ceil(sample / 220.5))) || !same(interval, claims.preferred) ||
      metadata.voice_sha256 !== claims.voice_sha256 || metadata.mix_sha256 !== claims.mix_sha256 ||
      metadata.expires !== claims.expires ||
      (native && metadata.accompaniment_sha256 !== claims.accompaniment_sha256) || Object.entries(runtime).some(([key, value]) => metadata.runtime?.[key] !== value) ||
      !fields.every((name) => hex.test(metadata.analysis_sha256?.[name])) ||
      !['f0', 'sp', 'ap', 'M'].every((name) => hex.test(metadata.parent_sha256?.[name])) ||
      bytes.length !== 12 + headerLength + frames * 8 * 4) throw new Error('registered_profile');
  const arrays = Array.from({ length: 4 }, (_, index) => decodeF64(
    bytes.subarray(12 + headerLength + index * frames * 8, 12 + headerLength + (index + 1) * frames * 8), frames));
  const [originalF0, targetF0, qWeights, tWeights] = arrays;
  let motion = false;
  for (let i = 0; i < frames; i++) {
    const changed = targetF0[i] !== originalF0[i], inside = interval[0] <= i && i < interval[1];
    if (originalF0[i] < 0 || originalF0[i] >= 22050 || (originalF0[i] === 0) !== (targetF0[i] === 0) ||
        (changed && (!inside || targetF0[i] < 71 || targetF0[i] > 800)) ||
        [qWeights[i], tWeights[i]].some((weight) => weight < 0 || weight > 1 || (!inside && weight !== 0))) {
      throw new Error('registered_profile');
    }
    motion ||= changed;
  }
  if (!motion || qWeights.filter((weight) => weight > 0).length < 2 || !tWeights.some((weight) => weight > 0)) {
    throw new Error('registered_profile');
  }
  return { metadata, originalF0, targetF0, qWeights, tWeights };
}

export async function verifyRegisteredAnalysis(analysis, profile) {
  const { metadata, originalF0 } = profile;
  if (analysis.frames !== metadata.frames ||
      analysis.f0.length !== metadata.frames || analysis.sp.length !== metadata.frames * bins ||
      analysis.ap.length !== analysis.sp.length || analysis.time.length !== metadata.frames ||
      analysis.f0.some((hz, i) => (hz === 0) !== (originalF0[i] === 0) || Math.abs(hz - originalF0[i]) > 1e-6)) {
    throw new Error('registered_analysis');
  }
  const actual = await analysisIdentity(analysis);
  if (fields.some((name) => actual[name] !== metadata.analysis_sha256[name])) throw new Error('registered_analysis');
}

export function checkRegisteredDraft(draft, frames, interval) {
  const checked = checkDraft(draft, frames);
  if (checked.intents.some((intent) => intent.mode !== 'flat' ||
      !same([intent.start_frame, intent.end_frame], interval) ||
      !({ M: [0, 1], Q: [0, 12], T: [0, 3, 6] })[intent.kind].includes(intent.amount))) {
    throw new Error('registered_scope');
  }
  return checked;
}

export function compileRegisteredIntents(analysis, profile, draft) {
  const { metadata, originalF0, targetF0, qWeights, tWeights } = profile;
  const normalized = checkRegisteredDraft(draft, analysis.frames, metadata.frame_window);
  const parameters = { ...analysis }, held = [];
  let changed = false;
  for (const control of normalized.intents) {
    const { kind, amount, start_frame: first, end_frame: last } = control;
    if (control.held || normalized.preserve.some(([a, b]) => a < last && first < b)) { held.push(kind); continue; }
    if (amount === 0) continue;
    if (kind === 'M') {
      parameters.f0 = analysis.f0.slice();
      for (let i = first; i < last; i++) if (targetF0[i] !== originalF0[i]) parameters.f0[i] = targetF0[i];
    } else if (kind === 'Q') {
      parameters.ap = analysis.ap.slice();
      for (let i = first; i < last; i++) {
        if (!qWeights[i]) continue;
        const odds = 10 ** (amount * qWeights[i] / 10);
        for (let bin = 1; bin < bins; bin++) {
          const index = i * bins + bin, power = analysis.ap[index] ** 2;
          parameters.ap[index] = Math.sqrt(odds * power / (1 - power + odds * power));
        }
      }
    } else {
      parameters.sp = analysis.sp.slice();
      for (let i = first; i < last; i++) {
        if (!tWeights[i]) continue;
        let before = 0, after = 0;
        for (let bin = 1; bin < bins; bin++) {
          const index = i * bins + bin, original = analysis.sp[index];
          const slope = Math.max(-1, Math.min(1, Math.log2(bin * 44100 / 2048 / 1000)));
          parameters.sp[index] = original * 10 ** (amount * tWeights[i] * slope / 10);
          before += original; after += parameters.sp[index];
        }
        if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0 || after <= 0) throw new Error('registered_timbre_domain');
        for (let bin = 1; bin < bins; bin++) parameters.sp[i * bins + bin] *= before / after;
      }
    }
    changed = true;
  }
  return { draft: normalized, parameters, regions: changed ? [metadata.sample_window.slice()] : [], held };
}
