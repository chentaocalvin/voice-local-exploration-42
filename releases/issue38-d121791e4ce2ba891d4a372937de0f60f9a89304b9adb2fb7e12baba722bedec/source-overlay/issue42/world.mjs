// SPDX-License-Identifier: GPL-3.0-or-later
const FS = 44100, BINS = 1025;
const check = (x, message) => { if (!x) throw new Error(message); };
const finite = (array) => array.every(Number.isFinite);

// Exact pyworld 0.3.5 length contract; the full tail is retained.
export function worldRawLength(frames) {
  check(Number.isInteger(frames) && frames > 0 && frames <= 9001, 'invalid_world_frames');
  return Math.floor(frames * 5 * FS / 1000);
}

export function createWorld(module) {
  check(module && module.HEAPF64 && typeof module._malloc === 'function' && typeof module._free === 'function' &&
    typeof module._issue41_world_frames === 'function' && typeof module._issue41_world_analyze === 'function' &&
    typeof module._issue41_world_synthesize === 'function', 'invalid_world_runtime');
  const withMemory = (lengths, fn) => {
    const ptrs = [];
    try {
      for (const n of lengths) {
        const p = module._malloc(n * 8);
        check(p && p % 8 === 0, 'world_allocation_failed');
        ptrs.push(p);
      }
      return fn(ptrs);
    } finally { for (const p of ptrs.reverse()) module._free(p); }
  };
  const put = (p, data) => module.HEAPF64.set(data, p / 8);
  const take = (p, n) => module.HEAPF64.slice(p / 8, p / 8 + n);
  const analyze = (samples) => {
    check(samples instanceof Float64Array && samples.length > 0 && samples.length <= 45 * FS && finite(samples), 'invalid_input');
    const frames = module._issue41_world_frames(samples.length);
    check(Number.isInteger(frames) && frames === Math.floor(1000 * samples.length / FS / 5) + 1, 'invalid_world_frames');
    return withMemory([samples.length, frames, frames, frames * BINS, frames * BINS], ([x, t, f, s, a]) => {
      put(x, samples);
      check(module._issue41_world_analyze(x, samples.length, frames, t, f, s, a) === 1, 'world_analysis_failed');
      const result = { frames, time: take(t, frames), f0: take(f, frames), sp: take(s, frames * BINS), ap: take(a, frames * BINS) };
      check(finite(result.time) && finite(result.f0) && finite(result.sp) && finite(result.ap) &&
        result.f0.every((v) => v >= 0 && v < FS / 2) && result.sp.every((v) => v >= 0) &&
        result.ap.every((v) => v >= 0 && v <= 1) && result.time.every((v, i) => Math.abs(v - i * .005) <= 1e-12), 'invalid_world_output');
      return result;
    });
  };
  const synthesize = ({ frames, f0, sp, ap }) => {
    check(Number.isInteger(frames) && frames > 0 && frames <= 9001 && f0 instanceof Float64Array &&
      sp instanceof Float64Array && ap instanceof Float64Array && f0.length === frames && sp.length === frames * BINS &&
      ap.length === sp.length && finite(f0) && finite(sp) && finite(ap) && f0.every((v) => v >= 0 && v < FS / 2) &&
      sp.every((v) => v >= 0) && ap.every((v) => v >= 0 && v <= 1), 'invalid_world_parameters');
    const n = worldRawLength(frames);
    return withMemory([frames, sp.length, ap.length, n], ([f, s, a, y]) => {
      put(f, f0); put(s, sp); put(a, ap);
      check(module._issue41_world_synthesize(f, frames, s, a, n, y) === 1, 'world_synthesis_failed');
      const raw = take(y, n);
      check(finite(raw) && raw.every((v) => Math.abs(v * .5) <= .98), 'invalid_world_output');
      return raw;
    });
  };
  return { analyze, synthesize };
}
