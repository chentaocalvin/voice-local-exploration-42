// SPDX-License-Identifier: GPL-3.0-or-later
const FS = 44100;
const SIZE = 2048;
const HALF = SIZE / 2;
const HOP = 220;
const FRAME_SAMPLES = 220.5;
const WINDOW = Float64Array.from({ length: SIZE }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / SIZE));
const COS = Float64Array.from({ length: HALF }, (_, i) => Math.cos(2 * Math.PI * i / SIZE));
const SIN = Float64Array.from({ length: HALF }, (_, i) => Math.sin(2 * Math.PI * i / SIZE));
const REVERSE = Uint16Array.from({ length: SIZE }, (_, i) => {
  let result = 0;
  for (let bit = SIZE; bit > 1; bit >>= 1) {
    result = (result << 1) | (i & 1);
    i >>= 1;
  }
  return result;
});

export function fft(real, imag, inverse) {
  for (let i = 0; i < SIZE; i++) {
    const j = REVERSE[i];
    if (j <= i) continue;
    const r = real[j], q = imag[j];
    real[j] = real[i]; imag[j] = imag[i];
    real[i] = r; imag[i] = q;
  }
  for (let span = 2; span <= SIZE; span *= 2) {
    const half = span / 2, stride = SIZE / span;
    for (let first = 0; first < SIZE; first += span) {
      for (let j = 0; j < half; j++) {
        const a = first + j, b = a + half;
        const c = COS[j * stride], s = (inverse ? 1 : -1) * SIN[j * stride];
        const r = c * real[b] - s * imag[b], q = s * real[b] + c * imag[b];
        real[b] = real[a] - r; imag[b] = imag[a] - q;
        real[a] += r; imag[a] += q;
      }
    }
  }
}

const CONTOUR = Float64Array.from({ length: SIZE }, (_, bin) => {
  const hz = Math.min(bin, SIZE - bin) * FS / SIZE;
  if (hz < 100 || hz >= 8000) return 0;
  const edge = hz < 150 ? .5 - .5 * Math.cos(Math.PI * (hz - 100) / 50)
    : hz > 7000 ? .5 + .5 * Math.cos(Math.PI * (hz - 7000) / 1000) : 1;
  return edge * Math.tanh(Math.log2(hz / 1500));
});

function localWeight(weights, sample) {
  const position = sample / FRAME_SAMPLES;
  const first = Math.floor(position);
  const a = weights[first] ?? 0, b = weights[first + 1] ?? 0;
  if (a <= 0 || b <= 0) return 0;
  return a + (b - a) * (position - first);
}

export function renderWaveformTilt(source, weights, amount) {
  if (!(source instanceof Float64Array) || !source.length || source.length > 45 * FS ||
      !(weights instanceof Float64Array) || weights.length !== Math.floor(source.length / FRAME_SAMPLES) + 1 ||
      !source.every((x) => Number.isFinite(x) && Math.abs(x) <= 1) ||
      !weights.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) ||
      !Number.isFinite(amount) || Math.abs(amount) > 6) throw new Error('invalid_waveform_tilt');
  const output = source.slice();
  if (amount === 0) return output;
  const delta = new Float64Array(source.length), overlap = new Float64Array(source.length);
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  for (let center = 0; center < source.length + HALF; center += HOP) {
    const weight = localWeight(weights, center);
    if (weight > 0) {
      for (let k = 0; k < SIZE; k++) re[k] = (source[center - HALF + k] ?? 0) * WINDOW[k];
      im.fill(0);
      fft(re, im, false);
      for (let k = 0; k < SIZE; k++) {
        const gain = 10 ** (amount * weight * CONTOUR[k] / 20) - 1;
        re[k] *= gain; im[k] *= gain;
      }
      fft(re, im, true);
    }
    const first = Math.max(0, HALF - center), last = Math.min(SIZE, source.length - center + HALF);
    for (let k = first; k < last; k++) {
      const sample = center - HALF + k;
      overlap[sample] += WINDOW[k] ** 2;
      if (weight > 0) delta[sample] += re[k] / SIZE * WINDOW[k];
    }
  }
  let changed = false, first = 0;
  while (first < source.length) {
    if (!localWeight(weights, first)) {
      first++;
      continue;
    }
    let end = first + 1;
    while (end < source.length && localWeight(weights, end)) end++;
    const fadeSamples = Math.min(882, Math.floor((end - first - 1) / 2));
    for (let sample = first; sample < end; sample++) {
      const distance = Math.min(sample - first, end - 1 - sample);
      const fade = fadeSamples ? .5 - .5 * Math.cos(Math.PI * Math.min(1, distance / fadeSamples)) : 0;
      output[sample] += fade * delta[sample] / overlap[sample];
      changed ||= output[sample] !== source[sample];
    }
    first = end;
  }
  if (!changed || !output.every((x) => Number.isFinite(x) && Math.abs(x * .5) <= .98)) {
    throw new Error('unsupported_or_overflow_waveform_tilt');
  }
  return output;
}
