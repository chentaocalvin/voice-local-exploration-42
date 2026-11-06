// SPDX-License-Identifier: GPL-3.0-or-later
import { checkDraft, compileIntents } from './intents.mjs';
import { renderSoloWaveform } from './solo_waveform.mjs';
import { tiltFrameWeights } from '../t_control.mjs';
import { renderWaveformTilt, fft } from '../waveform_tilt.mjs';

export const SOLO_NOISE_METHOD = 'voice-local-solo-shaped-noise-mqt-v1';
export const SOLO_NOISE_V2_METHOD = 'voice-local-solo-shaped-noise-mqt-v2';
export const isSoloNoiseMethod = (method) => [SOLO_NOISE_METHOD, SOLO_NOISE_V2_METHOD].includes(method);
const size = 2048, half = size / 2, hop = 220, frameSamples = 220.5;
const window = Float64Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / size));
const weightAt = (weights, sample) => {
  const position = sample / frameSamples, first = Math.floor(position);
  const a = weights[first] ?? 0, b = weights[first + 1] ?? 0;
  return a > 0 && b > 0 ? a + (b - a) * (position - first) : 0;
};

export function compileSoloNoise(analysis, qualification, draft, samples) {
  const normalized = checkDraft(draft, analysis.frames);
  const compiled = compileIntents(analysis, qualification, {
    intents: normalized.intents.filter(({ kind }) => kind !== 'Q'), preserve: normalized.preserve,
  }, samples);
  compiled.draft = normalized;
  const quality = normalized.intents.find(({ kind }) => kind === 'Q');
  if (!quality) return compiled;
  if (quality.held || normalized.preserve.some(([a, b]) => a < quality.end_frame && quality.start_frame < b)) {
    compiled.held.push('Q'); return compiled;
  }
  if (!quality.amount) return compiled;
  const weights = tiltFrameWeights(analysis, { eligible_intervals: { T: qualification.eligible_intervals.Q } }, quality);
  const regions = [];
  for (let i = 0; i < samples;) {
    if (!weightAt(weights, i)) { i++; continue; }
    const first = i;
    while (i < samples && weightAt(weights, i)) i++;
    regions.push([first, i]);
  }
  if (!regions.length) throw new Error('solo_noise_support');
  compiled.noiseWeights = weights;
  compiled.regions.push(...regions);
  return compiled;
}

function shapedNoise(voice, analysis, weights, sourceHash, amount, ratio) {
  const noise = new Float64Array(voice.length), overlap = new Float64Array(voice.length);
  const real = new Float64Array(size), imaginary = new Float64Array(size);
  let state = Number.parseInt(sourceHash.slice(0, 8), 16) || 1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let center = 0; center < voice.length + half; center += hop) {
    if (!weightAt(weights, center)) continue;
    const frame = Math.min(analysis.frames - 1, Math.round(center / frameSamples));
    real.fill(0); imaginary.fill(0);
    for (let bin = 1; bin < half; bin++) {
      const power = analysis.sp[frame * (half + 1) + bin];
      if (!Number.isFinite(power) || power < 0) throw new Error('solo_noise_spectrum');
      const angle = random() * 2 * Math.PI, amplitude = Math.sqrt(power);
      real[bin] = real[size - bin] = amplitude * Math.cos(angle);
      imaginary[bin] = amplitude * Math.sin(angle); imaginary[size - bin] = -imaginary[bin];
    }
    fft(real, imaginary, true);
    let sourceEnergy = 0, noiseEnergy = 0;
    for (let k = 0; k < size; k++) {
      const sample = center - half + k;
      if (sample < 0 || sample >= voice.length) continue;
      const w = window[k] ** 2;
      sourceEnergy += w * voice[sample] ** 2; noiseEnergy += w * (real[k] / size) ** 2;
    }
    if (!(noiseEnergy > 0) || !Number.isFinite(noiseEnergy) || !Number.isFinite(sourceEnergy)) throw new Error('solo_noise_support');
    const scale = Math.sqrt(sourceEnergy / noiseEnergy);
    for (let k = 0; k < size; k++) {
      const sample = center - half + k;
      if (sample < 0 || sample >= voice.length) continue;
      noise[sample] += real[k] / size * scale * window[k]; overlap[sample] += window[k];
    }
  }
  let sourceEnergy = 0, noiseEnergy = 0;
  for (let i = 0; i < voice.length; i++) {
    const weight = weightAt(weights, i);
    noise[i] = overlap[i] > 0 ? noise[i] / overlap[i] * weight : 0;
    sourceEnergy += (voice[i] * weight) ** 2; noiseEnergy += noise[i] ** 2;
  }
  if (!(sourceEnergy > 0 && noiseEnergy > 0) || !Number.isFinite(noiseEnergy)) throw new Error('solo_noise_support');
  // This is an additive carrier, not an estimate of the singer's AP or turbulent noise.
  // The method version fixes the dose: v1 is 5%, v2 is 20% at Q6, before T.
  const scale = amount / 6 * ratio * Math.sqrt(sourceEnergy / noiseEnergy);
  const output = Float64Array.from(voice, (value, i) => value + noise[i] * scale);
  if (!output.every((value) => Number.isFinite(value) && Math.abs(value * .5) <= .98)) throw new Error('solo_noise_overflow');
  return output;
}

export function renderSoloNoise({ voice, analysis, qualification, compiled, sourceHash, method = SOLO_NOISE_METHOD }) {
  if (!isSoloNoiseMethod(method)) throw new Error('solo_noise_scope');
  const motion = compileIntents(analysis, qualification, {
    intents: compiled.draft.intents.filter(({ kind }) => kind === 'M'), preserve: compiled.draft.preserve,
  }, voice.length);
  const warped = renderSoloWaveform({ voice, analysis, qualification, compiled: motion });
  let output = warped.voice;
  if (compiled.noiseWeights) {
    const intent = compiled.draft.intents.find(({ kind }) => kind === 'Q');
    output = shapedNoise(output, analysis, compiled.noiseWeights, sourceHash, intent.amount, method === SOLO_NOISE_V2_METHOD ? .20 : .05);
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
  return { voice: output, regions: union };
}
