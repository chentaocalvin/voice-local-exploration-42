// SPDX-License-Identifier: GPL-3.0-or-later
import { measureMotionWarp, warpMotion } from './solo_motion.mjs';
import { fft } from '../waveform_tilt.mjs';
import {spectralDeltaScale} from './spectral_headroom.mjs';
import { FS, STEP, FRAME, SIZE, HALF, HOP, WINDOW, CURVE, fade, runs, motionModel, spectralModels, apPower } from './signed_piano_model.mjs';
import {EXPLORATION_PROFILE,EXPLORATION_METHODS,HEADROOM_PROFILE,HEADROOM_METHODS,
  explorationMethodIdentity,explorationMethodFor} from './exploration_profile.mjs';
export const SIGNED_PIANO_METHOD = 'voice-local-piano-signed-residual-mqt-v1';
export const SOLO_EXPLORATION_METHOD = EXPLORATION_METHODS.solo;
export const PIANO_EXPLORATION_METHOD = EXPLORATION_METHODS.piano;
export const SOLO_HEADROOM_METHOD = HEADROOM_METHODS.solo;
export const PIANO_HEADROOM_METHOD = HEADROOM_METHODS.piano;
export const isExplorationMethod = method => explorationMethodIdentity(method)!==null;
export const isHeadroomMethod = method => explorationMethodIdentity(method)?.profile===HEADROOM_PROFILE;
const explorationKind = method => explorationMethodIdentity(method)?.kind??null;
export function explorationPolicy(kind,profile=EXPLORATION_PROFILE) {
  if (!['solo', 'piano'].includes(kind)) throw new Error('exploration_kind');
  return { method: explorationMethodFor(profile,kind),
    region: [100, 1500], motionRegion: kind === 'solo' ? [621, 870] : [681, 1046],
    limits: { M: kind === 'solo' ? .5 : .75, Q: 4, T: 9 } };
}
const limits = {
  M: .5, Q: 1, T: 6
};
const flatLimits = { M: .75, Q: 4, T: 9 };
export const STRONGER_MOTION_FRAMES = Object.freeze([681, 1046]);
function pcmValue(value) {
  const scaled = value * 1073741824, base = Math.floor(scaled), fraction = scaled - base;
  return fraction < .5 ? base: fraction > .5 ? base + 1: base%2 === 0 ? base: base + 1;
}
const validRange = (r, n) => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[0] < r[1] && r[1] <= n;
function axis(analysis, voice) {
  const { frames, f0, time, ap } = analysis ?? {};
  if (!(voice instanceof Float64Array) || !voice.length || voice.length > 45 * FS || !Number.isSafeInteger(frames) || frames !== Math.floor(voice.length / FRAME) + 1 || !(f0 instanceof Float64Array) || f0.length !== frames || !(time instanceof Float64Array) || time.length !== frames || !(ap instanceof Float64Array) || ap.length !== frames * (HALF + 1)) throw new Error('signed_parent');
  for (let i = 0; i < frames; i++) if (!Number.isFinite(f0[i]) || f0[i] < 0 || f0[i] >= FS / 2 || Math.abs(time[i] - i * STEP) > 1e-12 || !Number.isFinite(time[i])) throw new Error('signed_parent');
  for (const value of ap) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('signed_ap');
  for (const value of voice) if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('signed_voice');
}
export function qualifySignedPiano({ voice, analysis, track, interval = [100, 550], motionRegion }) {
  axis(analysis, voice);
  const { frames, f0, ap } = analysis;
  if (!validRange(interval, frames)) throw new Error('signed_region');
  const M = motionModel(f0, track), t = Uint8Array.from(f0, v => v >= FS / SIZE + 1 ? 1: 0), q = Uint8Array.from(t, (v, i) => v && ap[i * (HALF + 1)] ** 2 <= .999 ? 1: 0);
  const spectral = spectralModels(voice, analysis, q, t), models = {
    M: {
      ...M, shiftSupport: M.support
    }, ...spectral
  };
  const eligible_intervals = Object.fromEntries(Object.entries(models).map(([kind, model]) => [kind, runs(model.support)]));
  return {
    method_version: SIGNED_PIANO_METHOD, window_frames: [0, frames], default_region: interval.slice(), eligible_intervals, models,
    ...(motionRegion ? { motion_region: [...motionRegion],
      effective_support: Object.fromEntries(Object.entries(models).map(([kind, model]) =>
        [kind, hasLocalSupport(kind, model, interval, frames, voice.length)])) } : {})
  };
}
export function checkSignedDraft(draft, frames, region, motionRegion) {
  if (!validRange(region, frames) || !draft || !Array.isArray(draft.intents) || draft.intents.length > 3 || !Array.isArray(draft.preserve) || draft.preserve.length > 16 || !draft.preserve.every(r => validRange(r, frames))) throw new Error('signed_draft');
  const seen = new Set(), intents = draft.intents.map(({ kind, start_frame, end_frame, amount, mode, held = false }) => {
    const bounds = kind === 'M' && motionRegion ? motionRegion : region;
    if (!bounds || !Object.hasOwn(limits, kind) || seen.has(kind) || !validRange([start_frame, end_frame], frames) || start_frame !== bounds[0] || end_frame !== bounds[1] || !['flat', 'front', 'back', 'shift'].includes(mode) || !Number.isFinite(amount) || typeof held !== 'boolean' || (mode === 'shift' ? amount !== .25: Math.abs(amount) > (motionRegion && mode === 'flat' ? flatLimits : limits)[kind])) throw new Error('signed_draft');
    if (mode === 'flat' && ((kind === 'M' && Math.abs(amount) > .5 &&
        (Math.abs(amount) !== .75 || start_frame !== STRONGER_MOTION_FRAMES[0] || end_frame !== STRONGER_MOTION_FRAMES[1])) ||
        (kind === 'Q' && amount > 3 && (amount !== 4 || start_frame !== 100 || end_frame !== 1500)))) throw new Error('signed_draft');
    seen.add(kind);
    return {
      kind, start_frame, end_frame, amount, mode, held
    };
  });
  return {
    intents, preserve: draft.preserve.map(r => r.slice())
  };
}
export function checkExplorationDraft(draft, frames, kind) {
  const policy = explorationPolicy(kind);
  if (frames !== 1601 || !validRange(policy.region, frames) || !draft || !Array.isArray(draft.intents) ||
      draft.intents.length > 3 || !Array.isArray(draft.preserve) || draft.preserve.length > 16 ||
      !draft.preserve.every(range => validRange(range, frames))) throw new Error('signed_draft');
  const seen = new Set();
  const intents = draft.intents.map(({kind: feature, start_frame, end_frame, amount, mode, held = false}) => {
    const bounds = feature === 'M' ? policy.motionRegion : policy.region;
    if (!Object.hasOwn(policy.limits, feature) || seen.has(feature) ||
        !validRange([start_frame, end_frame], frames) || start_frame < bounds[0] || end_frame > bounds[1] ||
        !['flat', 'front', 'back', 'shift'].includes(mode) || !Number.isFinite(amount) ||
        typeof held !== 'boolean' || (mode === 'shift' ? amount !== .25 : Math.abs(amount) > policy.limits[feature])) {
      throw new Error('signed_draft');
    }
    seen.add(feature);
    return {kind: feature, start_frame, end_frame, amount, mode, held};
  });
  return {intents, preserve: draft.preserve.map(range => range.slice())};
}
function selectedRuns(mask, region) {
  const selected = mask.slice();
  selected.fill(0, 0, region[0]);
  selected.fill(0, region[1]);
  return runs(selected);
}
function weights(frames, intervals, region, mode, support) {
  const result = new Float64Array(frames), a = region[0] * STEP, b = region[1] * STEP;
  const supportedRuns = runs(support);
  for (const [first, last] of intervals) {
    const [supportedFirst, supportedLast] = supportedRuns.find(([start, end]) => start <= first && last <= end);
    for (let i = first; i < last; i++) {
      const t = i * STEP, u = (t - a) / (b - a), envelope = mode === 'front' ? (1 + Math.cos(Math.PI * u)) / 2: mode === 'back' ? (1 - Math.cos(Math.PI * u)) / 2: 1;
      result[i] = fade(t - a) * fade(b - t) * fade(t - supportedFirst * STEP) * fade((supportedLast - 1) * STEP - t) * envelope;
    }
  }
  return result;
}
function hasLocalSupport(kind, model, region, frames, samples) {
  const intervals = selectedRuns(model.support, region);
  if (!sampleRegions(intervals, samples).length) return false;
  const localWeights = weights(frames, intervals, region, 'flat', model.support);
  return localWeights.some((weight, i) => weight !== 0 && (kind !== 'M' || model.residual[i] !== 0));
}
function shiftCurve(model, region) {
  const candidates = selectedRuns(model.shiftSupport, region).sort(([a, b], [c, d]) => (d - c) - (b - a) || a - c);
  if (!candidates.length) throw new Error('signed_shift_support');
  const [a, b] = candidates[0], end = b * STEP, start = a * STEP, delta = .25;
  if (!(end - start > delta + .04)) throw new Error('signed_shift_support');
  const curve = new Float64Array(model.residual.length);
  for (let i = a; i < b; i++) {
    const t = i * STEP, r = model.residual[i], union = fade(t - start, .02) * fade(end - t, .02);
    let moved = 0;
    if (i >= a + 50) {
      const sourceTime = t - delta, source = fade(sourceTime - start, .02) * fade(end - delta - sourceTime, .02);
      const target = fade(t - start - delta, .02) * fade(end - t, .02);
      moved = target * source * model.residual[i - 50];
    }
    curve[i] = moved - union * r;
  }
  if (!curve.some(v => v !== 0)) throw new Error('signed_shift_no_residual');
  return {
    curve, intervals: [[a, b]]
  };
}
function mergeRegions(regions) {
  const result = [];
  for (const [a, b] of regions.sort(([a], [b]) => a - b)) {
    const last = result.at( - 1);
    if (last && a <= last[1])last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
function sampleRegions(intervals, samples) {
  return intervals.map(([a, b]) => [Math.ceil(a * FRAME), Math.min(samples, Math.ceil((b - 1) * FRAME))]).filter(([a, b]) => b > a);
}
export function compileSignedPiano(analysis, qualification, draft, samples) {
  const kind = explorationKind(qualification?.method_version);
  if ((qualification?.method_version !== SIGNED_PIANO_METHOD && !kind) || !Number.isSafeInteger(samples) || samples <= 0 || analysis.frames !== Math.floor(samples / FRAME) + 1) throw new Error('signed_parent');
  const policy = kind ? explorationPolicy(kind) : null;
  if (policy && (JSON.stringify(qualification.default_region) !== JSON.stringify(policy.region) ||
      JSON.stringify(qualification.motion_region) !== JSON.stringify(policy.motionRegion))) throw new Error('signed_parent');
  const normalized = kind ? checkExplorationDraft(draft, analysis.frames, kind)
    : checkSignedDraft(draft, analysis.frames, qualification.default_region, qualification.motion_region);
  const held = [], controls = {}, regions = [];
  const parameters = {
    ...analysis
  };
  for (const intent of normalized.intents) {
    const { kind, amount, mode, start_frame: a, end_frame: b } = intent;
    if (intent.held || normalized.preserve.some(([p, q]) => p < b && a < q)) {
      held.push(kind);
      continue;
    }
    if (mode !== 'shift' && amount === 0)continue;
    const model = qualification.models[kind];
    let intervals = selectedRuns(model.support, [a, b]), curve;
    if (mode === 'shift') {
      let shifted;
      try {
        shifted = shiftCurve(model, [a, b]);
      }
      catch (error) {
        throw new Error(error.message + '_' + kind);
      }
      intervals = shifted.intervals;
      curve = shifted.curve;
    }
    if (!intervals.length) throw new Error('signed_support_' + kind);
    if (policy && kind === 'M' && intervals.length > 10) throw new Error('signed_resource_motion_fragments');
    const support = mode === 'shift' ? model.shiftSupport : model.support;
    const w = weights(analysis.frames, intervals, [a, b], mode, support), effective = new Float64Array(analysis.frames);
    for (let i = 0; i < effective.length; i++) {
      const raw = mode === 'shift' ? curve[i] / (kind === 'Q' ? Math.LN2: 1): kind === 'M' ? amount * model.residual[i]: amount;
      effective[i] = w[i] * raw;
      if (kind === 'M') {
        const cents = effective[i], hz = analysis.f0[i] * 2 ** (cents / 1200);
        if (Math.abs(cents) > 50 + 1e-9 || (cents !== 0 && (hz < 71 || hz > 800))) throw new Error('signed_motion_limit');
      } else if (Math.abs(effective[i]) > (policy?.limits ?? (qualification.motion_region && mode === 'flat' ? flatLimits : limits))[kind] + 1e-12) throw new Error('signed_shift_limit_' + kind);
    }
    if (!effective.some(v => v !== 0)) throw new Error('signed_no_change_' + kind);
    const local = sampleRegions(intervals, samples);
    if (!local.length) throw new Error('signed_support_' + kind);
    controls[kind] = {
      effective, regions: local, intervals
    };
    regions.push(...local);
    if (kind === 'M')parameters.f0 = Float64Array.from(analysis.f0, (hz, i) => hz * 2 ** (effective[i] / 1200));
  }
  return {
    draft: normalized, held, regions: mergeRegions(regions), parameters, controls
  };
}
function requireMotionClosure(geometry) {
  if (1200 * Math.log2(1 / (1 - geometry.closure_rate_peak)) > 3) throw new Error('signed_motion_closure');
}

const motionRefusals = new Set(['signed_support_M', 'signed_no_change_M', 'signed_motion_limit',
  'warp_axis', 'warp_motion_limit', 'warp_rate_outside_guard', 'warp_phase_outside_guard', 'signed_motion_closure']);

function checkMotionGeometry(analysis, qualification, samples, region, amount) {
  const draft = { preserve: [], intents: [{kind: 'M', start_frame: region[0], end_frame: region[1], amount, mode: 'flat'}] };
  const compiled = compileSignedPiano(analysis, { ...qualification, motion_region: region }, draft, samples);
  for (const samplesRegion of compiled.controls.M.regions) {
    requireMotionClosure(measureMotionWarp(samples, analysis.f0, compiled.parameters.f0, samplesRegion));
  }
}

export async function preflightStrongerMotion(analysis, qualification, samples, reserve) {
  const region = STRONGER_MOTION_FRAMES;
  const support = selectedRuns(qualification.models.M.support, region);
  const hasOriginalSupport = support.length === 1 && support[0][0] === region[0] && support[0][1] === region[1];
  const directions = {};
  let reserved = 0;
  for (const [role, amount] of [['M-', -.75], ['M+', .75]]) {
    const steps = 2 * Math.ceil((region[1] - region[0]) * FRAME) + 10 * analysis.frames;
    await reserve(steps);
    reserved += steps;
    try {
      if (!hasOriginalSupport) throw new Error('signed_support_M');
      checkMotionGeometry(analysis, qualification, samples, region, amount);
      directions[role] = { status: 'passed' };
    } catch (error) {
      if (!motionRefusals.has(error.message)) throw error;
      directions[role] = { status: 'refused', code: error.message };
    }
  }
  const status = Object.values(directions).every(row => row.status === 'passed') ? 'passed' : 'refused';
  return { status, region: [...region], directions, reserved };
}

function controlAt(effective, center) {
  const position = center / FRAME, left = Math.floor(position), a = effective[left] ?? 0, b = effective[left + 1] ?? 0;
  return a + (b - a) * (position - left);
}
function spectralRender(source, analysis, kind, control) {
  const output = source.slice(), delta = new Float64Array(source.length), overlap = new Float64Array(source.length), re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  for (let center = 0; center < source.length + HALF; center += HOP) {
    const amount = controlAt(control.effective, center);
    if (amount !== 0) {
      for (let k = 0; k < SIZE; k++)re[k] = (source[center - HALF + k] ?? 0) * WINDOW[k];
      im.fill(0);
      fft(re, im, false);
      for (let k = 0; k <= HALF; k++) {
        const gain = k === 0 ? 0: kind === 'Q' ? ((2 ** amount - 1) * apPower(analysis, center, k)): 10 ** (amount * CURVE[k] / 20) - 1;
        re[k] *= gain;
        im[k] *= gain;
        if (k === HALF)im[k] = 0;
        if (k > 0 && k < HALF) {
          re[SIZE - k] *= gain;
          im[SIZE - k] *= gain;
        }
      }
      fft(re, im, true);
    }
    const first = Math.max(0, HALF - center), last = Math.min(SIZE, source.length - center + HALF);
    for (let k = first; k < last; k++) {
      const sample = center - HALF + k;
      overlap[sample] += WINDOW[k] ** 2;
      if (amount !== 0)delta[sample] += re[k] / SIZE * WINDOW[k];
    }
  }
  let changed = false;
  for (const [a, b] of control.regions) {
    const fadeSamples = Math.min(882, Math.floor((b - a - 1) / 2));
    for (let i = a; i < b; i++) {
      const safe = fadeSamples ? fade(Math.min(i - a, b - 1 - i) / FS, fadeSamples / FS): 0;
      output[i] += safe * delta[i] / overlap[i];
      changed ||= pcmValue(output[i]) !== pcmValue(source[i]);
    }
  }
  if (!changed) throw new Error('signed_no_pcm_change_' + kind);
  return output;
}
// Compute one uniform T scale for both the voice and the mix.
function timbreDeltaScale(voice, mix, edited, source) {
  const target = 2 * .979;
  let lower = 0, scale = 1, exceeds = false;
  for (let i = 0; i < edited.length; i++) {
    const original = voice[i], reference = mix[i], proposed = edited[i];
    const delta = proposed - original;
    const combined = source.mix[i] + proposed - source.voice[i];
    if (!Number.isFinite(delta) || !Number.isFinite(combined)) throw new Error('signed_nonfinite_output');
    exceeds ||= Math.abs(proposed * .5) > .98 || Math.abs(combined * .5) > .98;
    if (delta !== 0) {
      const sign = Math.sign(delta), magnitude = Math.abs(delta);
      scale = Math.min(scale, (target - sign * original) / magnitude,
        (target - sign * reference) / magnitude);
      lower = Math.max(lower, (-target - sign * original) / magnitude, (-target - sign * reference) / magnitude);
    } else if (Math.abs(original) > target || Math.abs(reference) > target) {
      // An unchanged pre-T sample cannot be brought under the scaled target.
      lower = Infinity;
    }
  }
  if (!exceeds) return 1;
  if (scale < .5 || scale < lower) throw new Error('signed_timbre_headroom_insufficient');
  return scale;
}

function preTReference(voice, mix, edited, controls) {
  const mixed = mix.slice();
  for (const kind of ['M', 'Q']) for (const [a, b] of controls[kind].regions) {
    for (let i = a; i < b; i++) mixed[i] = mix[i] + edited[i] - voice[i];
  }
  for (let i = 0; i < edited.length; i++) {
    if (!Number.isFinite(edited[i]) || !Number.isFinite(mixed[i])) throw new Error('signed_nonfinite_output');
    if (Math.abs(edited[i] * .5) > .98 || Math.abs(mixed[i] * .5) > .98) throw new Error('signed_mqt_base_peak_limit');
  }
  return {voice: edited, mix: mixed};
}

function headroomStage(before,source,analysis,stage,control,regions) {
  const reference=source.mix.slice();
  for(const [a,b] of regions) for(let i=a;i<b;i++) reference[i]=source.mix[i]+before[i]-source.voice[i];
  const edited=spectralRender(before,analysis,stage,control);
  const {scale}=spectralDeltaScale({stage,voice:before,mix:reference,edited,source});
  if(scale<1) for(const [a,b] of control.regions) for(let i=a;i<b;i++) edited[i]=before[i]+scale*(edited[i]-before[i]);
  const mixed=source.mix.slice();
  for(const [a,b] of regions) for(let i=a;i<b;i++) mixed[i]=source.mix[i]+edited[i]-source.voice[i];
  let peak=0,voiceChanged=false,mixChanged=false;
  for(let i=0;i<edited.length;i++) {
    const voiceSample=edited[i],mixSample=mixed[i];
    if(!Number.isFinite(voiceSample)||!Number.isFinite(mixSample))
      throw Object.assign(new Error('spectral_headroom_nonfinite'),{headroom:{stage,finite:false,sample:i}});
    peak=Math.max(peak,Math.abs(voiceSample*.5),Math.abs(mixSample*.5));
    if(scale<1&&(Math.abs(pcmValue(voiceSample))/2147483648>.979||Math.abs(pcmValue(mixSample))/2147483648>.979))
      throw Object.assign(new Error('spectral_headroom_pcm_limit'),{headroom:{stage,finite:true,scale,encoded_peak:peak}});
  }
  for(const [a,b] of control.regions) for(let i=a;i<b;i++) {
    voiceChanged ||= pcmValue(edited[i])!==pcmValue(before[i]);
    mixChanged ||= pcmValue(mixed[i])!==pcmValue(reference[i]);
  }
  if(!voiceChanged||!mixChanged) throw new Error('signed_no_pcm_change_'+stage);
  return {voice:edited,scale};
}

export function renderSignedPiano({ voice, mix, analysis, qualification, compiled,
  combinationTimbreHeadroom = false }) {
  if ((qualification?.method_version !== SIGNED_PIANO_METHOD && !isExplorationMethod(qualification?.method_version)) || !(voice instanceof Float64Array) || !(mix instanceof Float64Array) || voice.length !== mix.length) throw new Error('signed_render_axis');
  let output = voice;
  if (compiled.controls.M) {
    let motionChanged = false;
    for (const region of compiled.controls.M.regions) {
      const warped = warpMotion(output, analysis.f0, compiled.parameters.f0, region);
      requireMotionClosure(warped);
      for (let i = region[0]; i < region[1]; i++) motionChanged ||= pcmValue(warped.samples[i]) !== pcmValue(output[i]);
      output = warped.samples;
    }
    if (!motionChanged) throw new Error('signed_no_pcm_change_M');
  }
  const {M, Q, T} = compiled.controls;
  const headroom=isHeadroomMethod(qualification.method_version),scales={};
  if(Q&&headroom) {
    const stage=headroomStage(output,{voice,mix},analysis,'Q',Q,compiled.regions);
    output=stage.voice;scales.Q=stage.scale;
  } else if (Q) output = spectralRender(output, analysis, 'Q', Q);
  const preT = !headroom && combinationTimbreHeadroom && M && Q && T ? preTReference(voice, mix, output, compiled.controls) : null;
  if(T&&headroom) {
    const stage=headroomStage(output,{voice,mix},analysis,'T',T,compiled.regions);
    output=stage.voice;scales.T=stage.scale;
  } else if (T) output = spectralRender(output, analysis, 'T', T);
  const deltaScale = preT ? timbreDeltaScale(preT.voice, preT.mix, output, {voice, mix}) : 1;
  if (preT && deltaScale < 1) {
    for (const [a, b] of T.regions) for (let i = a; i < b; i++) {
      output[i] = preT.voice[i] + deltaScale * (output[i] - preT.voice[i]);
    }
  }
  const mixed = mix.slice();
  let peak = 0, changed = false;
  for (const [a, b] of compiled.regions)for (let i = a; i < b; i++) {
    mixed[i] = mix[i] + output[i] - voice[i];
    changed ||= pcmValue(mixed[i]) !== pcmValue(mix[i]);
  }
  for (let i = 0; i < voice.length; i++) {
    if (preT && (!Number.isFinite(output[i]) || !Number.isFinite(mixed[i]))) throw new Error('signed_nonfinite_output');
    if (!Number.isFinite(output[i]) || !Number.isFinite(mixed[i]) || Math.abs(output[i] * .5) > .98 || Math.abs(mixed[i] * .5) > .98) throw new Error('signed_peak_limit');
    peak = Math.max(peak, Math.abs(mixed[i] * .5));
  }
  if (compiled.regions.length && !changed) throw new Error('signed_no_pcm_change');
  if (preT) {
    let voiceTChanged = false, mixTChanged = false;
    for (const [a, b] of T.regions) for (let i = a; i < b; i++) {
      voiceTChanged ||= pcmValue(output[i]) !== pcmValue(preT.voice[i]);
      mixTChanged ||= pcmValue(mixed[i]) !== pcmValue(preT.mix[i]);
    }
    if (!voiceTChanged || !mixTChanged) throw new Error('signed_no_pcm_change_T');
    if (deltaScale < 1) {
      // Check the actual PCM result, including the final mix arithmetic and ties-to-even rounding.
      for (let i = 0; i < voice.length; i++) {
        if (Math.abs(pcmValue(output[i])) / 2147483648 > .979 ||
            Math.abs(pcmValue(mixed[i])) / 2147483648 > .979) throw new Error('signed_timbre_headroom_insufficient');
      }
    }
  }
  return {
    voice: output, mix: mixed, regions: compiled.regions.map(r => r.slice()), stats: {
      encoded_mix_peak: peak, ...(preT ? { timbre_delta_scale: deltaScale } : {}),
      ...(headroom ? {spectral_delta_scales:scales} : {}),
      ...(preT ? { combination_encoded_mix_peak: pcmValue(2 * peak) / 2147483648 } : {}),
    }
  };
}
export function estimateSignedPianoReads({ samples, frames, phase, compiled, combinationTimbreHeadroom = false, spectralHeadroom=false }) {
  if (!Number.isSafeInteger(samples) || samples <= 0 || !Number.isSafeInteger(frames) || frames !== Math.floor(samples / FRAME) + 1) throw new Error('signed_read_axis');
  if (phase === 'prepare')return samples + SIZE * Math.ceil(samples / HOP);
  if (phase !== 'render' || !compiled?.controls || !Array.isArray(compiled.regions)) throw new Error('signed_read_phase');
  const length = (regions) => regions.reduce((sum, [a, b]) => sum + b - a, 0), active = length(compiled.regions);
  let total = 6 * samples + 5 * active;
  for (const [a, b] of compiled.controls.M?.regions ?? [])total += samples + 10 * (b - a);
  for (const kind of ['Q', 'T']) if (compiled.controls[kind])total += samples + 3 * SIZE * Math.ceil((samples + HALF) / HOP) + 5 * length(compiled.controls[kind].regions);
  // Upper bound for the independent pre-T mix, headroom intersection, and PCM checks.
  if(spectralHeadroom) total += 24*samples*['Q','T'].filter(kind=>compiled.controls[kind]).length;
  else if (combinationTimbreHeadroom) total += 24 * samples;
  return total;
}
