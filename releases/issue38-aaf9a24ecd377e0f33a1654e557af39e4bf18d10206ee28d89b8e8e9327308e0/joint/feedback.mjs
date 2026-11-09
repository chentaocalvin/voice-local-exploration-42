// SPDX-License-Identifier: GPL-3.0-or-later
const cell = 22050;
const transient = 882;
const hann = Float64Array.from({ length: transient }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (transient - 1)));
const coefficients = Float64Array.from({ length: 161 }, (_, k) => 2 * Math.cos(2 * Math.PI * k / transient));

export function localLevelProfile(signal, [start, end]) {
  let energy = 0;
  for (let i = 0; i < signal.length; i++) if (i < start || i >= end) energy += signal[i] ** 2;
  const context = energy / (signal.length - (end - start));
  const cells = [];
  for (let lo = start; lo + cell <= end; lo += cell) {
    let local = 0;
    for (let i = lo; i < lo + cell; i++) local += signal[i] ** 2;
    cells.push({ interval: [lo, lo + cell], relative_db: context > 0 && local > 0 ? 10 * Math.log10(local / cell / context) : null });
  }
  return cells;
}

export function preservationFeedback(reference, edited, [start, end]) {
  const spans = [...reference.regions, ...edited.regions].sort(([a], [b]) => a - b);
  const union = [];
  for (const [lo, hi] of spans) {
    const tail = union.at(-1);
    if (tail && lo <= tail[1]) tail[1] = Math.max(tail[1], hi);
    else union.push([lo, hi]);
  }
  const hasMix = reference.mix !== undefined && edited.mix !== undefined;
  if (reference.voice.length !== edited.voice.length || Boolean(reference.mix) !== Boolean(edited.mix) ||
      (hasMix && (reference.mix.length !== reference.voice.length || edited.mix.length !== reference.voice.length))) {
    throw new Error('feedback_axis');
  }
  let protectedVoice = true, protectedMix = hasMix ? true : null, residual = hasMix ? true : null, changed = 0;
  let span = 0;
  for (let i = 0; i < reference.voice.length; i++) {
    while (span < union.length && i >= union[span][1]) span++;
    const protectedSample = span === union.length || i < union[span][0];
    const voiceDelta = edited.voice[i] - reference.voice[i];
    if (protectedSample && voiceDelta !== 0) protectedVoice = false;
    if (i >= start && i < end && voiceDelta !== 0) changed++;
    if (hasMix) {
      const mixDelta = edited.mix[i] - reference.mix[i];
      if (protectedSample && mixDelta !== 0) protectedMix = false;
      if (Math.abs(mixDelta - voiceDelta) > 2 / 2147483648) residual = false;
    }
  }
  return { protected_voice_equal: protectedVoice, protected_mix_equal: protectedMix,
    estimated_residual_equal: residual, changed_voice_samples_in_selection: changed };
}

export function componentSpectrum(signal, [start, end]) {
  const observations = [];
  const samples = new Float64Array(transient);
  for (let lo = start; lo + transient <= end; lo += 441) {
    for (let i = 0; i < transient; i++) samples[i] = signal[lo + i] * hann[i];
    let numerator = 0, denominator = 0;
    for (let bin = 2; bin <= 160; bin++) {
      const coefficient = coefficients[bin];
      let prior = 0, previous = 0;
      for (let i = 0; i < transient; i++) {
        const next = samples[i] + coefficient * previous - prior;
        prior = previous;
        previous = next;
      }
      const power = Math.max(0, previous ** 2 + prior ** 2 - coefficient * previous * prior);
      denominator += power;
      if (bin >= 40 && bin <= 60) numerator += power;
    }
    observations.push({ interval: [lo, lo + transient],
      ratio_db: numerator > 0 && denominator > 0 ? 10 * Math.log10(numerator / denominator) : null });
  }
  return observations;
}
