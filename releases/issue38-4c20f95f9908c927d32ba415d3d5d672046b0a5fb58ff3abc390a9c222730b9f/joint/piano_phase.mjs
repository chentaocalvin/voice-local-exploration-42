// SPDX-License-Identifier: GPL-3.0-or-later
import { compileSoloPhase, renderSoloPhase, SOLO_PHASE_V2_METHOD } from './solo_phase.mjs';
import { motionStrengthLimit } from './intents.mjs';

export const PIANO_PHASE_METHOD = 'voice-local-piano-carrier-phase-mqt-v1';

export function choosePianoPhaseRegion(analysis, source, samples, preferred = null) {
  const regions = preferred ? [preferred] : source.eligible_intervals.M.flatMap(([ma, mb]) =>
    source.eligible_intervals.T.map(([ta, tb]) => [Math.max(ma, ta), Math.min(mb, tb)]));
  regions.sort(([a, b], [c, d]) => d - c - (b - a) || a - c);
  for (const [first, last] of regions) {
    if (last - first < 302) continue;
    const at = (kind, mode, amount) => ({ kind, mode, amount, start_frame: first, end_frame: last });
    try {
      const inset = Math.floor((last - first) / 4);
      const localMotion = { ...at('M', 'flat', 1), start_frame: first + inset, end_frame: last - inset };
      const amount = Math.min(motionStrengthLimit(analysis, source, localMotion), ...['flat', 'front', 'back'].map((mode) =>
        motionStrengthLimit(analysis, source, at('M', mode, 1))));
      for (const mode of ['flat', 'front', 'back']) compileSoloPhase(analysis, source, {
        intents: [at('M', mode, amount), at('Q', mode, 6), at('T', mode, 6)], preserve: [],
      }, samples);
      compileSoloPhase(analysis, source, { intents: ['M', 'Q', 'T'].map((kind) => ({
        ...at(kind, 'flat', kind === 'M' ? amount : 6), start_frame: first + inset, end_frame: last - inset,
      })), preserve: [] }, samples);
      return { interval: [first, last], motionAmount: amount };
    } catch (error) {
      if (!/^(ineligible_interval|insufficient_support|condition_insufficient|solo_noise_support)/.test(error.message)) throw error;
    }
  }
  return null;
}

export function renderPianoPhase({ mix, ...options }) {
  const output = renderSoloPhase({ ...options, method: SOLO_PHASE_V2_METHOD });
  if (!(mix instanceof Float64Array) || mix.length !== options.voice.length || !mix.every(Number.isFinite)) {
    throw new Error('piano_phase_axis');
  }
  const full = Float64Array.from(mix, (sample, i) => sample + (output.voice[i] - options.voice[i]));
  if (!full.every((sample) => Number.isFinite(sample) && Math.abs(sample * .5) <= .98)) throw new Error('piano_phase_overflow');
  return { ...output, mix: full };
}
