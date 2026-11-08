// SPDX-License-Identifier: GPL-3.0-or-later
import { alignPraat } from '../qualification.mjs';
import { fft } from '../waveform_tilt.mjs';
export const FS = 44100, STEP = .005, FRAME = 220.5, SIZE = 2048, HALF = 1024, HOP = 220;
export const WINDOW = Float64Array.from({
  length: SIZE
}, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / SIZE));
export const CURVE = Float64Array.from({
  length: HALF + 1
}, (_, k) => {
  const hz = k * FS / SIZE;
  if (hz < 100 || hz >= 8000)return 0;
  const edge = hz < 150?.5 - .5 * Math.cos(Math.PI * (hz - 100) / 50): hz > 7000?.5 + .5 * Math.cos(Math.PI * (hz - 7000) / 1000): 1;
  return edge * Math.tanh(Math.log2(hz / 1500));
});
export const fade = (d, seconds = .05) => d <= 0 ? 0: .5 - .5 * Math.cos(Math.PI * Math.min(d / seconds, 1));
export function runs(mask) {
  const result = [];
  for (let i = 0; i < mask.length; ) {
    if (!mask[i]) {
      i++;
      continue;
    }
    const a = i;
    while (i < mask.length && mask[i])i++;
    result.push([a, i]);
  }
  return result;
}
const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b), m = sorted.length >> 1;
  return sorted.length%2 ? sorted[m]: (sorted[m - 1] + sorted[m]) / 2;
};
const rms = (values) => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
function kernel() {
  const values = new Float64Array(101), sinc = (x) => x === 0 ? 1: Math.sin(Math.PI * x) / (Math.PI * x);
  let mean = 0;
  for (let j = 0; j < 101; j++) {
    const t = j - 50;
    values[j] = (18 / 200 * sinc(18 / 200 * t) - 8 / 200 * sinc(8 / 200 * t)) * (.5 - .5 * Math.cos(2 * Math.PI * j / 100));
    mean += values[j];
  }
  mean /= 101;
  let real = 0, imag = 0;
  for (let j = 0; j < 101; j++) {
    values[j] -= mean;
    const angle = - 2 * Math.PI * 6.5 / 200 * (j - 50);
    real += values[j] * Math.cos(angle);
    imag += values[j] * Math.sin(angle);
  }
  const norm = Math.hypot(real, imag);
  return values.map(v => v / norm);
}
const BAND = kernel();
function motionTrack(hz) {
  const mask = Uint8Array.from(hz, v => Number.isFinite(v) && v >= 71 && v <= 800), residual = new Float64Array(hz.length), support = new Uint8Array(hz.length);
  const pitch = Float64Array.from(hz, v => v > 0 ? 1200 * Math.log2(v): 0);
  for (const [a, b] of runs(mask)) {
    const slow = new Float64Array(hz.length);
    for (let i = a + 50; i < b - 50; i++)slow[i] = median(Array.from(pitch.subarray(i - 50, i + 51)));
    support.fill(1, a + 60, Math.max(a + 60, b - 60));
    for (let i = a + 60; i < b - 60; i++) if (Math.abs(slow[i + 10] - slow[i - 10]) > 100)support.fill(0, Math.max(a, i - 50), Math.min(b, i + 51));
    for (let i = a + 50; i < b - 50; i++)for (let j = 0; j < 101; j++)residual[i] += (pitch[i + j - 50] - pitch[i]) * BAND[j];
  }
  return {
    support, residual
  };
}
export function motionModel(f0, track) {
  const n = f0.length;
  if (!Array.isArray(track) || !track.length)return {
    support: new Uint8Array(n), residual: new Float64Array(n), code: 'signed_independent_missing'
  };
  let independent;
  try {
    independent = alignPraat(n, track);
  } catch (error) {
    if (error.message !== 'ambiguous_independent_mapping') throw error;
    return { support: new Uint8Array(n), residual: new Float64Array(n), code: error.message };
  }
  const world = motionTrack(f0), praat = motionTrack(independent);
  const support = Uint8Array.from(world.support, (v, i) => v && praat.support[i] ? 1: 0), rejected = [];
  for (const [a, b] of runs(support)) {
    const error = Array.from({
      length: b - a
    }, (_, j) => 1200 * Math.log2(f0[a + j] / independent[a + j]));
    const bias = median(error), mad = 1.4826 * median(error.map(v => Math.abs(v - bias)));
    const w = Array.from(world.residual.subarray(a, b)), p = Array.from(praat.residual.subarray(a, b));
    const difference = rms(w.map((v, i) => v - p[i]));
    if (!(Math.abs(bias) < rms(w) && mad < rms(w) && difference < Math.min(rms(w), rms(p)))) {
      support.fill(0, a, b);
      rejected.push({ interval: [a, b], code: 'signed_independent_disagreement' });
    }
  }
  return {
    support, residual: world.residual, rejected
  };
}
export function apPower(analysis, center, bin) {
  const frame = center / FRAME, left = Math.floor(frame), fraction = frame - left;
  if (left < 0 || left + 1 >= analysis.frames)return null;
  const a = analysis.ap[left * (HALF + 1) + bin], b = analysis.ap[(left + 1) * (HALF + 1) + bin];
  const amplitude = a + (b - a) * fraction;
  return amplitude * amplitude;
}
export function spectralModels(voice, analysis, qSupport, tSupport) {
  const centers = [], qValues = [], tValues = [], re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  const bins = Array.from(CURVE.keys()).filter(k => k > 0 && CURVE[k] !== 0), mean = bins.reduce((s, k) => s + CURVE[k], 0) / bins.length;
  const denominator = bins.reduce((s, k) => s + (CURVE[k] - mean) ** 2, 0);
  for (let center = 0; center < voice.length; center += HOP) {
    const position = center / FRAME, left = Math.floor(position);
    const q = qSupport[left] && qSupport[left + 1], t = tSupport[left] && tSupport[left + 1];
    centers.push(center / FS);
    if (!q && !t) {
      qValues.push(NaN);
      tValues.push(NaN);
      continue;
    }
    for (let k = 0; k < SIZE; k++)re[k] = (voice[center - HALF + k] ?? 0) * WINDOW[k];
    im.fill(0);
    fft(re, im, false);
    let energy = 0, positive = 0, slope = 0;
    for (let k = 1; k <= HALF; k++) {
      const magnitude = Math.hypot(re[k], im[k]);
      positive += magnitude * magnitude;
      if (q) {
        const power = apPower(analysis, center, k);
        energy += (k === HALF ? 1: 2) * (power * magnitude) ** 2;
      }
      if (t && CURVE[k] !== 0)slope += (CURVE[k] - mean) * 20 * Math.log10(Math.max(magnitude, 1e-12));
    }
    qValues.push(q && Math.sqrt(energy) > 1e-12 ? Math.log(Math.sqrt(energy)): NaN);
    tValues.push(t && positive > 0 && denominator > 0 ? slope / denominator: NaN);
  }
  return {
    Q: spectralResidual(analysis.frames, centers, qValues, qSupport), T: spectralResidual(analysis.frames, centers, tValues, tSupport)
  };
}
function spectralResidual(frames, centers, values, support) {
  const mapped = new Float64Array(frames).fill(NaN), valid = new Uint8Array(frames), residual = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const position = i * FRAME / HOP, left = Math.floor(position), fraction = position - left;
    if (!support[i] || left + 1 >= centers.length || !Number.isFinite(values[left]) || !Number.isFinite(values[left + 1]))continue;
    const a = Math.floor(centers[left] / STEP), b = Math.ceil(centers[left + 1] / STEP);
    if (a < 0 || b >= frames || !support[a] || !support[b])continue;
    mapped[i] = values[left] + fraction * (values[left + 1] - values[left]);
    valid[i] = 1;
  }
  const hann = Float64Array.from({
    length: 101
  }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / 100)), normal = hann.reduce((a, b) => a + b, 0), shiftSupport = new Uint8Array(frames);
  for (const [a, b] of runs(valid))for (let i = a + 50; i < b - 50; i++) {
    let slow = 0;
    for (let j = 0; j < 101; j++)slow += hann[j] * mapped[i + j - 50] / normal;
    residual[i] = mapped[i] - slow;
    shiftSupport[i] = 1;
  }
  return {
    support, residual, shiftSupport
  };
}
