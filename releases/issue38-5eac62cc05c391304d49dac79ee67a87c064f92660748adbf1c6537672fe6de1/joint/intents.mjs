// SPDX-License-Identifier: GPL-3.0-or-later
import { prepareT, tiltFrameWeights } from '../t_control.mjs';

const limits = { M: [0, 1], Q: [0, 12], T: [-6, 6] };
const modes = ['flat', 'front', 'back'];
const bins = 1025;
const step = .005;
const samplesPerFrame = 220.5;
const frame = (n) => Number.isSafeInteger(n) && n >= 0;

function validRegion(range, frames) {
  return Array.isArray(range) && range.length === 2 &&
    frame(range[0]) && frame(range[1]) && range[0] < range[1] && range[1] <= frames;
}

export function checkDraft(draft, frames) {
  if (!draft || !Array.isArray(draft.intents) || draft.intents.length > 3 ||
      !Array.isArray(draft.preserve) || draft.preserve.length > 16 ||
      !draft.preserve.every((range) => validRegion(range, frames))) throw new Error('invalid_intents');
  const seen = new Set();
  const intents = draft.intents.map(({ kind, start_frame, end_frame, amount, mode, held = false }) => {
    if (!Object.hasOwn(limits, kind) || seen.has(kind) || !validRegion([start_frame, end_frame], frames) ||
        !Number.isFinite(amount) || amount < limits[kind][0] || amount > limits[kind][1] ||
        !modes.includes(mode) || typeof held !== 'boolean') throw new Error('invalid_intents');
    seen.add(kind);
    return { kind, start_frame, end_frame, amount, mode, held };
  });
  return { intents, preserve: draft.preserve.map((range) => range.slice()) };
}

function motionCurve(analysis, band, control) {
  const { f0, frames } = analysis, { start_frame: start, end_frame: end, mode } = control;
  const weights = new Float64Array(frames);
  const lo = mode === 'back' ? Math.ceil((start + end) / 2) : start;
  const hi = mode === 'front' ? Math.ceil((start + end) / 2) : end;
  if ((hi - lo - 1) * step < .75 || !(band instanceof Float64Array) || band.length !== frames) {
    throw new Error('insufficient_support_M');
  }
  const fade = Math.min(.1, (hi - lo - 1) * step / 2);
  let total = 0, sum = 0;
  for (let i = lo; i < hi; i++) {
    const headroom = Math.min(1200 * Math.log2(f0[i] / 71), 1200 * Math.log2(800 / f0[i]));
    if (!Number.isFinite(headroom) || headroom < 0 || !Number.isFinite(band[i])) throw new Error('invalid_motion_parent');
    const distance = Math.min(i - lo, hi - 1 - i) * step;
    weights[i] = (.5 - .5 * Math.cos(Math.PI * Math.min(distance / fade, 1))) * Math.min(1, headroom / 200);
    sum += weights[i] * band[i];
    total += weights[i];
  }
  if (!(total > 0)) throw new Error('insufficient_support_M');
  const cents = Float64Array.from({ length: hi - lo }, (_, offset) => {
    const i = lo + offset;
    return weights[i] * (band[i] - sum / total);
  });
  return { lo, cents };
}

export function motionStrengthLimit(analysis, source, intent) {
  const [control] = checkDraft({ intents: [intent], preserve: [] }, analysis.frames).intents;
  const { start_frame: first, end_frame: last } = control;
  const [windowStart, windowEnd] = source.window_frames;
  if (control.kind !== 'M' || first < windowStart || last > windowEnd ||
      !source.eligible_intervals.M.some(([a, b]) => a <= first && last <= b)) throw new Error('ineligible_interval_M');
  const { lo, cents } = motionCurve(analysis, source.plan.rawband_cents, control);
  let limit = 1, hasMotion = false;
  for (const [offset, value] of cents.entries()) {
    if (value === 0) continue;
    hasMotion = true;
    const hz = analysis.f0[lo + offset];
    const headroom = 1200 * Math.log2(value > 0 ? 800 / hz : hz / 71);
    limit = Math.min(limit, Math.min(50, headroom) / Math.abs(value));
  }
  const amount = Math.floor(limit * 1e6) / 1e6;
  if (!hasMotion || !(amount > 0)) throw new Error('insufficient_support_M');
  return amount;
}

function motion(analysis, band, control) {
  const { f0, frames } = analysis;
  const { lo, cents: curve } = motionCurve(analysis, band, control);
  const changed = f0.slice(), active = new Uint8Array(frames);
  for (const [offset, value] of curve.entries()) {
    const i = lo + offset;
    const cents = value * control.amount;
    if (Math.abs(cents) > 50) throw new Error('condition_insufficient_postcenter_over50');
    const hz = f0[i] * 2 ** (cents / 1200);
    if (hz < 71 || hz > 800) throw new Error('invalid_motion_headroom');
    changed[i] = hz;
    active[i] = hz !== f0[i] ? 1 : 0;
  }
  return { value: changed, active };
}

function quality(analysis, source, control) {
  const weights = tiltFrameWeights(analysis, { eligible_intervals: { T: source.eligible_intervals.Q } }, control);
  const { ap, frames } = analysis, output = ap.slice(), active = new Uint8Array(frames);
  let supported = 0;
  for (let i = control.start_frame; i < control.end_frame; i++) {
    if (!weights[i]) continue;
    supported++;
    const odds = 10 ** (control.amount * weights[i] / 10);
    for (let j = i * bins + 1; j < (i + 1) * bins; j++) {
      const power = ap[j] ** 2;
      output[j] = Math.sqrt(odds * power / (1 - power + odds * power));
      if (output[j] !== ap[j]) active[i] = 1;
    }
  }
  return { value: output, active, supported };
}

const field = { M: 'f0', Q: 'ap', T: 'sp' };

export function compileIntents(analysis, source, draft, samples) {
  const normalized = checkDraft(draft, analysis.frames);
  const parameters = { ...analysis }, active = new Uint8Array(analysis.frames), held = [];
  for (const control of normalized.intents) {
    const { kind, start_frame: first, end_frame: last } = control;
    if (control.held || normalized.preserve.some(([a, b]) => a < last && first < b)) { held.push(kind); continue; }
    if (control.amount === 0) continue;
    const [windowStart, windowEnd] = source.window_frames;
    if (first < windowStart || last > windowEnd ||
        (kind !== 'Q' && !source.eligible_intervals[kind].some(([a, b]) => a <= first && last <= b))) {
      throw new Error('ineligible_interval_' + kind);
    }
    let result;
    if (kind === 'M') result = motion(analysis, source.plan.rawband_cents, control);
    else if (kind === 'Q') result = quality(analysis, source, control);
    else {
      const tilt = prepareT(analysis, source, control);
      result = { value: tilt.sp, active: tilt.active };
    }
    if (!result.active.some(Boolean) || (kind === 'Q' && result.supported < 2)) {
      throw new Error('insufficient_support_' + kind);
    }
    parameters[field[kind]] = result.value;
    result.active.forEach((used, i) => { if (used) active[i] = 1; });
  }
  const regions = [];
  for (let i = 0; i < active.length;) {
    if (!active[i]) { i++; continue; }
    const first = i;
    while (i < active.length && active[i]) i++;
    const lo = Math.ceil(first * samplesPerFrame), hi = Math.min(samples, Math.ceil(i * samplesPerFrame));
    if (lo < hi) regions.push([lo, hi]);
  }
  return { draft: normalized, parameters, regions, held };
}
