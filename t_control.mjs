// SPDX-License-Identifier: GPL-3.0-or-later
const FS = 44100, FFT = 2048, BINS = 1025;
const finite = (x) => Number.isFinite(x);

export function tiltFrameWeights({ frames, time, f0 }, source, control) {
  const { start_frame: first, end_frame: last, mode } = control;
  const intervals = source.eligible_intervals.T;
  let begin = first * .005, end = last * .005;
  if (mode === 'front') end = (begin + end) / 2;
  if (mode === 'back') begin = (begin + end) / 2;
  const selected = [];
  for (let i = first; i < last; i++) {
    if (time[i] >= begin && time[i] < end && f0[i] >= FS / FFT + 1 && intervals.some(([a, b]) => a <= i && i < b)) selected.push(i);
  }
  const weights = new Float64Array(frames);
  const fade = (d) => .5 - .5 * Math.cos(Math.PI * Math.max(0, Math.min(1, d / .05)));
  let run = 0;
  while (run < selected.length) {
    let stop = run + 1;
    while (stop < selected.length && selected[stop] === selected[stop - 1] + 1) stop++;
    const lo = time[selected[run]], hi = time[selected[stop - 1]];
    for (let k = run; k < stop; k++) {
      const i = selected[k], t = time[i];
      let weight = fade(t - begin) * fade(end - t) * fade(t - lo) * fade(hi - t);
      if (mode !== 'flat') {
        const phase = (t - first * .005) / ((last - first) * .005) - (mode === 'back' ? .5 : 0);
        weight *= Math.sin(Math.PI * phase) ** 2;
      }
      weights[i] = weight;
    }
    run = stop;
  }
  return weights;
}

export function prepareT(parent, source, control) {
  const { frames, time, f0, sp, ap } = parent;
  if (!Number.isInteger(frames) || frames <= 0 || frames > 9001 ||
      !(time instanceof Float64Array) || !(f0 instanceof Float64Array) ||
      !(sp instanceof Float64Array) || !(ap instanceof Float64Array) ||
      time.length !== frames || f0.length !== frames || sp.length !== frames * BINS || ap.length !== sp.length ||
      !Array.isArray(source?.eligible_intervals?.T)) throw new Error('invalid_parent');
  const { start_frame: first, end_frame: last, amount, mode } = control;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last > frames || first >= last ||
      !finite(amount) || amount < -6 || amount > 6 || !['flat', 'front', 'back'].includes(mode)) throw new Error('invalid_control');
  const window = source.window_frames;
  if (!Array.isArray(window) || window.length !== 2 || !Number.isInteger(window[0]) ||
      !Number.isInteger(window[1]) || first < window[0] || last > window[1]) throw new Error('invalid_window');
  const intervals = source.eligible_intervals.T;
  if (!intervals.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) &&
      Number.isInteger(p[1]) && p[0] >= 0 && p[0] < p[1] && p[1] <= frames)) throw new Error('invalid_eligibility');
  if (!intervals.some(([a, b]) => a <= first && last <= b)) throw new Error('ineligible_interval');
  for (let i = 0; i < frames; i++) {
    if (!finite(time[i]) || Math.abs(time[i] - i * .005) > 1e-12 || !finite(f0[i]) || f0[i] < 0 || f0[i] >= FS / 2) throw new Error('invalid_parent');
  }
  for (let i = 0; i < sp.length; i++) {
    if (!finite(sp[i]) || sp[i] < 0 || !finite(ap[i]) || ap[i] < 0 || ap[i] > 1) throw new Error('invalid_parent');
  }
  if (amount === 0) return { sp: sp.slice(), active: new Uint8Array(frames) };
  const weights = tiltFrameWeights(parent, source, control);
  const result = sp.slice();
  const active = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) {
    const weight = weights[i];
    if (!(weight > 0)) continue;
    active[i] = 1;
    let before = 0, after = 0;
    for (let j = 1; j < BINS; j++) {
      const idx = i * BINS + j;
      const curve = Math.max(-1, Math.min(1, Math.log2((j * FS / FFT) / 1000)));
      before += sp[idx];
      result[idx] = sp[idx] * 10 ** (amount * weight * curve / 10);
      after += result[idx];
    }
    if (!finite(before) || !finite(after) || before <= 0 || after <= 0) throw new Error('invalid_spectrum');
    for (let j = 1; j < BINS; j++) result[i * BINS + j] *= before / after;
    let restored = 0;
    for (let j = 1; j < BINS; j++) restored += result[i * BINS + j];
    if (!finite(restored) || Math.abs(restored - before) > 1e-12 * before) throw new Error('power_not_preserved');
  }
  if (!active.some(Boolean)) throw new Error('insufficient_support');
  return { sp: result, active };
}
