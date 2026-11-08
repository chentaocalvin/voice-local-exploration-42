// SPDX-License-Identifier: GPL-3.0-or-later
const valid = (samples) => samples instanceof Float64Array && samples.every(Number.isFinite);
const safe = (samples) => samples.every((value) => Math.abs(value * .5) <= .98);

/**
 * @param {{voice: Float64Array, mix?: Float64Array, neutral: Float64Array,
 * edited: Float64Array, regions: number[][], fade?: number}} options
 */
export function renderDifference({ voice, mix, neutral, edited, regions, fade = 882 }) {
  if (!valid(voice) || !voice.length || (mix !== undefined && (!valid(mix) || mix.length !== voice.length)) ||
      !valid(neutral) || !valid(edited) || neutral.length !== edited.length || neutral.length < voice.length) {
    throw new Error('axis_mismatch');
  }
  if (!Array.isArray(regions) || !Number.isSafeInteger(fade) || fade < 1) throw new Error('invalid_support');
  const output = voice.slice(), full = mix?.slice() ?? output;
  let end = 0;
  for (const [lo, hi] of regions) {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < end || hi <= lo || hi > voice.length) {
      throw new Error('invalid_support');
    }
    end = hi;
    for (let index = lo; index < hi; index++) {
      const distance = Math.min(index - lo, hi - 1 - index);
      const phase = Math.min(1, distance / fade);
      const weight = .5 - .5 * Math.cos(Math.PI * phase);
      const delta = (edited[index] - neutral[index]) * weight;
      if (delta === 0) continue;
      output[index] += delta;
      if (mix) full[index] += delta;
    }
  }
  if (!safe(output) || !safe(full)) throw new Error('unsafe_audio');
  return { voice: output, mix: full };
}
