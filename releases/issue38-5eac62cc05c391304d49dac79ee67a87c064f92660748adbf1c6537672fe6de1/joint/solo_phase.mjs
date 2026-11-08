// SPDX-License-Identifier: GPL-3.0-or-later
import { compileSoloNoise } from './solo_noise.mjs';
import { compileIntents } from './intents.mjs';
import { renderSoloWaveform } from './solo_waveform.mjs';
import { tiltFrameWeights } from '../t_control.mjs';
import { fft, renderWaveformTilt } from '../waveform_tilt.mjs';

export const SOLO_PHASE_METHOD = 'voice-local-solo-carrier-phase-mqt-v1';
export const SOLO_PHASE_V2_METHOD = 'voice-local-solo-carrier-phase-mqt-v2';
export const isSoloPhaseMethod = (method) => [SOLO_PHASE_METHOD, SOLO_PHASE_V2_METHOD].includes(method);
const size = 2048, half = size / 2, hop = 220, frameSamples = 220.5, sampleRate = 44100;
const window = Float64Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / size));
const band = Float64Array.from({ length: half + 1 }, (_, bin) => {
  const hz = bin * sampleRate / size;
  return hz <= 2000 ? 0 : hz >= 2500 ? 1 : .5 - .5 * Math.cos(Math.PI * (hz - 2000) / 500);
});
const weightAt = (weights, sample) => {
  const position = sample / frameSamples, first = Math.floor(position);
  const a = weights[first] ?? 0, b = weights[first + 1] ?? 0;
  return a > 0 && b > 0 ? a + (b - a) * (position - first) : 0;
};

function phaseMessage(length, hash) {
  let state = Number.parseInt(hash.slice(0, 8), 16) || 1;
  const k = Math.tan(Math.PI * 100 / sampleRate);
  const filters = [.541196100146197, 1.306562964876377].map((q) => {
    const denominator = 1 + k / q + k * k;
    return { b: k * k / denominator, a1: 2 * (k * k - 1) / denominator,
      a2: (1 - k / q + k * k) / denominator, x1: 0, x2: 0, y1: 0, y2: 0 };
  });
  const result = new Float64Array(length), warmup = 11025;
  let sum = 0, squares = 0;
  for (let i = -warmup; i < length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    let value = (state >>> 0) / 2147483648 - 1;
    for (const filter of filters) {
      const next = filter.b * (value + 2 * filter.x1 + filter.x2) - filter.a1 * filter.y1 - filter.a2 * filter.y2;
      filter.x2 = filter.x1; filter.x1 = value; filter.y2 = filter.y1; filter.y1 = next; value = next;
    }
    if (i >= 0) { result[i] = value; sum += value; squares += value * value; }
  }
  const mean = sum / length, sd = Math.sqrt(squares / length - mean * mean);
  if (!(sd > 0) || !Number.isFinite(sd)) throw new Error('solo_phase_support');
  return result.map((value) => Math.max(-3, Math.min(3, (value - mean) / sd)));
}

export function renderHighBandPhase(source, phases) {
  if (!(source instanceof Float64Array) || !source.length || source.length > 45 * sampleRate ||
      !source.every((value) => Number.isFinite(value) && Math.abs(value) <= 1) ||
      !(phases instanceof Float64Array) || phases.length !== source.length ||
      !phases.every((value) => Number.isFinite(value) && Math.abs(value) <= 3)) throw new Error('solo_phase_scope');
  const output = source.slice();
  if (!phases.some((value) => value !== 0)) return output;
  const carrierReal = new Float64Array(source.length), carrierImaginary = new Float64Array(source.length);
  const overlap = new Float64Array(source.length), real = new Float64Array(size), imaginary = new Float64Array(size);
  for (let center = 0; center < source.length + half; center += hop) {
    for (let k = 0; k < size; k++) real[k] = (source[center - half + k] ?? 0) * window[k];
    imaginary.fill(0); fft(real, imaginary, false);
    real[0] = imaginary[0] = 0;
    for (let bin = 1; bin < half; bin++) {
      real[bin] *= 2 * band[bin]; imaginary[bin] *= 2 * band[bin];
      real[size - bin] = imaginary[size - bin] = 0;
    }
    real[half] *= band[half]; imaginary[half] = 0;
    fft(real, imaginary, true);
    const first = Math.max(0, half - center), last = Math.min(size, source.length - center + half);
    for (let k = first; k < last; k++) {
      const sample = center - half + k;
      carrierReal[sample] += real[k] / size * window[k];
      carrierImaginary[sample] += imaginary[k] / size * window[k];
      overlap[sample] += window[k] ** 2;
    }
  }

  for (let i = 0; i < source.length; i++) {
    const phase = phases[i];
    if (!phase) continue;
    output[i] += (carrierReal[i] * (Math.cos(phase) - 1) - carrierImaginary[i] * Math.sin(phase)) / overlap[i];
  }
  if (!output.every((value) => Number.isFinite(value) && Math.abs(value * .5) <= .98)) throw new Error('solo_phase_overflow');
  return output;
}

function carrierPhaseResult(source, weights, amount, sourceHash, method) {
  if (!isSoloPhaseMethod(method)) throw new Error('solo_phase_scope');
  if (!(source instanceof Float64Array) || !source.length || source.length > 45 * sampleRate ||
      !(weights instanceof Float64Array) || weights.length !== Math.floor(source.length / frameSamples) + 1 ||
      !weights.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
      !Number.isFinite(amount) || amount < 0 || amount > 6 || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('solo_phase_scope');
  const message = phaseMessage(source.length, sourceHash);
  let active = 0, originalSquares = 0, phaseSquares = 0, peak = 0, clipped = 0;
  const phases = message.map((value, i) => {
    const original = amount / 6 * weightAt(weights, i) * value;
    const boosted = method === SOLO_PHASE_V2_METHOD ? 1.5 * original : original;
    const phase = method === SOLO_PHASE_V2_METHOD ? Math.max(-3, Math.min(3, boosted)) : original;
    if (weightAt(weights, i) > 0 && amount) {
      active++; originalSquares += original ** 2; phaseSquares += phase ** 2;
      peak = Math.max(peak, Math.abs(phase)); clipped += Math.abs(boosted) > 3 ? 1 : 0;
    }
    return phase;
  });
  const output = renderHighBandPhase(source, phases);
  if (amount && !output.some((value, i) => value !== source[i])) throw new Error('solo_phase_support');
  return { voice: output, phaseStats: active ? { active_samples: active, unboosted_phase_rms: Math.sqrt(originalSquares / active),
    phase_rms: Math.sqrt(phaseSquares / active), phase_peak: peak, clipped_samples: clipped, clipped_fraction: clipped / active } : null };
}

export function renderCarrierPhase(source, weights, amount, sourceHash, method = SOLO_PHASE_METHOD) {
  return carrierPhaseResult(source, weights, amount, sourceHash, method).voice;
}

export function renderSoloPhase({ voice, analysis, qualification, compiled, sourceHash, method = SOLO_PHASE_METHOD }) {
  const motion = compileIntents(analysis, qualification, {
    intents: compiled.draft.intents.filter(({ kind }) => kind === 'M'), preserve: compiled.draft.preserve,
  }, voice.length);
  const warped = renderSoloWaveform({ voice, analysis, qualification, compiled: motion });
  let output = warped.voice, phaseStats = null;
  if (compiled.noiseWeights) {
    const intent = compiled.draft.intents.find(({ kind }) => kind === 'Q');
    const quality = carrierPhaseResult(output, compiled.noiseWeights, intent.amount, sourceHash, method);
    output = quality.voice; phaseStats = quality.phaseStats;
  }
  if (compiled.parameters.sp !== analysis.sp) {
    const intent = compiled.draft.intents.find(({ kind }) => kind === 'T');
    output = renderWaveformTilt(output, tiltFrameWeights(analysis, qualification, intent), intent.amount);
  }
  const regions = [...compiled.regions, ...warped.regions].sort(([a], [b]) => a - b), union = [];
  for (const pair of regions) {
    const last = union.at(-1);
    if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]); else union.push(pair.slice());
  }
  return { voice: output, regions: union, phaseStats };
}

export { compileSoloNoise as compileSoloPhase };
