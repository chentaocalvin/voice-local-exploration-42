// SPDX-License-Identifier: GPL-3.0-or-later
import { sourceShiftContractLimits } from './source_shift.mjs';
const samplesPerFrame = 220.5;
const fadeSamples = 882;

function interpolate(samples, position) {
  const left = Math.floor(position), t = position - left;
  const a = samples[Math.max(0, left - 1)], b = samples[left];
  const c = samples[Math.min(samples.length - 1, left + 1)];
  const d = samples[Math.min(samples.length - 1, left + 2)];
  return b + .5 * t * (c - a + t * (2*a - 5*b + 4*c - d + t * (3*(b-c) + d-a)));
}

function motionGeometry(samples, parent, target, [start, end], onPosition, contract) {
  if (!(parent instanceof Float64Array) || !(target instanceof Float64Array) || parent.length !== target.length ||
      !Number.isSafeInteger(samples) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end > samples || end - start < 2 * fadeSamples ||
      end - 1 >= (target.length - 1) * samplesPerFrame) throw new Error('warp_axis');
  const limits = sourceShiftContractLimits(contract, parent, target, [start, end]);
  const ratios = Float64Array.from(target, (hz, i) => {
    if (parent[i] === hz) return 0;
    const ratio = hz / parent[i], cents = 1200 * Math.log2(ratio);
    if (!Number.isFinite(cents) || Math.abs(cents) > (limits?.absolute_cents ?? 50) + 1e-9) throw new Error('warp_motion_limit');
    return ratio - 1;
  });
  const length = end - start - 1;
  const shifts = new Float64Array(length), weights = new Float64Array(length);
  let total = 0, weightSum = 0;
  for (let i = 0; i < length; i++) {
    const frame = (start + i + .5) / samplesPerFrame, left = Math.floor(frame);
    const fraction = frame - left;
    const edge = Math.min(i, length - 1 - i) / fadeSamples;
    const weight = .5 - .5 * Math.cos(Math.PI * Math.min(1, edge));
    weights[i] = weight;
    shifts[i] = (ratios[left] * (1 - fraction) + ratios[left + 1] * fraction) * weight;
    total += shifts[i];
    weightSum += weight;
  }
  // Close the phase at the far boundary without adding a second waveform.
  const drift = total / weightSum;
  let shift = 0, peakShift = 0, peakClosure = 0;
  for (let i = 0; i < length - 1; i++) {
    const rate = 1 + shifts[i] - drift * weights[i];
    if (rate < (limits?.min_rate ?? .965) || rate > (limits?.max_rate ?? 1.037)) throw new Error('warp_rate_outside_guard');
    shift += rate - 1;
    peakShift = Math.max(peakShift, Math.abs(shift));
    peakClosure = Math.max(peakClosure, Math.abs(drift * weights[i]));
    if (limits && peakClosure > limits.closure_delta) throw new Error('signed_motion_closure');
    const index = start + i + 1;
    const position = index + shift;
    if (position < start || position > end - 1 || peakShift > 441) throw new Error('warp_phase_outside_guard');
    if (shift !== 0) onPosition?.(index, position);
  }
  return { peak_shift_samples: peakShift, closure_rate_peak: peakClosure };
}

export function measureMotionWarp(samples, parent, target, region, contract) {
  return motionGeometry(samples, parent, target, region, undefined, contract);
}

export function warpMotion(source, parent, target, region, contract) {
  if (!(source instanceof Float64Array)) throw new Error('warp_axis');
  const output = source.slice();
  const geometry = motionGeometry(source.length, parent, target, region, (index, position) => {
    output[index] = interpolate(source, position);
  }, contract);
  return { samples: output, ...geometry };
}
