// SPDX-License-Identifier: GPL-3.0-or-later
const closureDelta = 1 - 2 ** (-3 / 1200);
const certificates = new WeakMap();
const epsilon = 1e-9;

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

export function sourceShiftLimits(minimum, maximum) {
  requireValue(Number.isFinite(minimum) && Number.isFinite(maximum) && minimum <= 0 && maximum >= 0,
    'source_shift_range');
  const span = maximum - minimum;
  const minRate = 2 ** (-span / 1200) - closureDelta;
  const maxRate = 2 ** (span / 1200) + closureDelta;
  requireValue(minRate > 0 && Number.isFinite(maxRate), 'source_shift_range');
  return Object.freeze({ absolute_cents: span, min_rate: minRate, max_rate: maxRate,
    closure_delta: closureDelta });
}

const fade = distance => distance <= 0 ? 0 : .5 - .5 * Math.cos(Math.PI * Math.min(distance / .02, 1));

export function certifySourceShift({ parent, target, residual, support, weights, effective,
  interval, sampleRegions, intent }) {
  const frames = parent?.length;
  requireValue(frames === 1601 && [parent, target, residual, weights, effective].every(
    values => values instanceof Float64Array && values.length === frames && values.every(Number.isFinite)) &&
    support instanceof Uint8Array && support.length === frames, 'source_shift_axis');
  requireValue(intent?.kind === 'M' && intent.mode === 'shift' && intent.amount === .25 &&
    !intent.held && Array.isArray(interval) && interval.length === 2 && interval.every(Number.isSafeInteger),
    'source_shift_intent');
  const [first, last] = interval, start = first * .005, end = last * .005;
  requireValue(first >= intent.start_frame && last <= intent.end_frame && first >= 0 && last <= frames &&
    end - start > .29 && sampleRegions.length === 1 &&
    sampleRegions[0][0] === Math.ceil(first * 220.5) &&
    sampleRegions[0][1] === Math.ceil((last - 1) * 220.5), 'source_shift_support');
  let minimum = 0, maximum = 0;
  for (let i = first; i < last; i++) {
    requireValue(support[i] === 1, 'source_shift_support');
    minimum = Math.min(minimum, residual[i]);
    maximum = Math.max(maximum, residual[i]);
  }
  const limits = sourceShiftLimits(minimum, maximum);
  for (let i = 0; i < frames; i++) {
    const weight = weights[i];
    requireValue(weight >= 0 && weight <= 1, 'source_shift_weight');
    let expected = 0;
    if (i >= first && i < last) {
      const time = i * .005, removal = fade(time - start) * fade(end - time);
      let insertion = 0, moved = 0;
      if (i >= first + 50) {
        const sourceTime = time - .25;
        const source = fade(sourceTime - start) * fade(end - .25 - sourceTime);
        const destination = fade(time - start - .25) * fade(end - time);
        insertion = destination * source;
        moved = insertion * residual[i - 50];
      }
      requireValue(insertion <= removal + epsilon, 'source_shift_envelope');
      expected = weight * (moved - removal * residual[i]);
      const next = residual[i] + effective[i];
      requireValue(next >= minimum - epsilon && next <= maximum + epsilon, 'source_shift_range');
    }
    requireValue(Object.is(effective[i], expected) &&
      Object.is(target[i], parent[i] * 2 ** (expected / 1200)), 'source_shift_target');
    requireValue(Math.abs(expected) <= limits.absolute_cents + epsilon &&
      (expected === 0 || target[i] >= 71 && target[i] <= 800), 'source_shift_frequency');
  }
  const token = Object.freeze({ schema: 'voice-source-bound-motion-shift-v1' });
  const arrays = [parent, target, residual, weights, effective];
  certificates.set(token, { parent, target, limits, region: sampleRegions[0].slice(),
    arrays, snapshots: arrays.map(values => values.slice()) });
  return token;
}

export function sourceShiftContractLimits(token, parent, target, region) {
  if (token === undefined) return null;
  const proof = certificates.get(token);
  requireValue(proof && proof.parent === parent && proof.target === target &&
    Array.isArray(region) && region.length === 2 && region.every((value, i) => value === proof.region[i]) &&
    proof.arrays.every((values, k) => values.length === proof.snapshots[k].length &&
      values.every((value, i) => Object.is(value, proof.snapshots[k][i]))), 'source_shift_certificate');
  return proof.limits;
}
