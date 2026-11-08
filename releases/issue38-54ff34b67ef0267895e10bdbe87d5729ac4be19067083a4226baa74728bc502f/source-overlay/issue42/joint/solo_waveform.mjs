// SPDX-License-Identifier: GPL-3.0-or-later
import { compileIntents } from './intents.mjs';
import { warpMotion } from './solo_motion.mjs';
import { tiltFrameWeights } from '../t_control.mjs';
import { renderWaveformTilt } from '../waveform_tilt.mjs';
export const SOLO_WAVEFORM_METHOD = 'voice-local-solo-motion-waveform-t-v1';

export function renderSoloWaveform({ voice, analysis, qualification, compiled }) {
  let output = voice.slice();
  const regions = compiled.regions.map((pair) => pair.slice());
  if (compiled.parameters.f0 !== analysis.f0) {
    const intent = compiled.draft.intents.find(({ kind }) => kind === 'M');
    const motion = compileIntents(analysis, qualification, { intents: [intent], preserve: compiled.draft.preserve }, voice.length);
    const interval = [motion.regions[0][0], motion.regions.at(-1)[1]];
    const warped = warpMotion(voice, analysis.f0, compiled.parameters.f0, interval);
    if (1200 * Math.log2(1 / (1 - warped.closure_rate_peak)) > 3) throw new Error('solo_waveform_scope');
    output = warped.samples;
    regions.push(interval);
  }
  if (compiled.parameters.sp !== analysis.sp) {
    const intent = compiled.draft.intents.find(({ kind }) => kind === 'T');
    output = renderWaveformTilt(output, tiltFrameWeights(analysis, qualification, intent), intent.amount);
  }
  regions.sort(([a], [b]) => a - b);
  const union = [];
  for (const pair of regions) {
    const last = union.at(-1);
    if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
    else union.push(pair);
  }
  return { voice: output, regions: union };
}
