// SPDX-License-Identifier: GPL-3.0-or-later
import { qualifySignedPiano, compileSignedPiano, renderSignedPiano, explorationPolicy,
  SOLO_EXPLORATION_METHOD, PIANO_EXPLORATION_METHOD, SOLO_HEADROOM_METHOD, PIANO_HEADROOM_METHOD,
  isExplorationMethod, isHeadroomMethod, checkExplorationDraft } from './signed_piano.mjs';
import {EXPLORATION_PROFILE,isExplorationProfile,explorationMethodIdentity} from './exploration_profile.mjs';
export { explorationPolicy, SOLO_EXPLORATION_METHOD, PIANO_EXPLORATION_METHOD, SOLO_HEADROOM_METHOD,
  PIANO_HEADROOM_METHOD, isExplorationMethod, isHeadroomMethod, checkExplorationDraft, EXPLORATION_PROFILE };

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const expires = value => Number.isSafeInteger(value) && value > 0;
export function checkPrivateExploration(value) {
  const soloKeys = ['sourceSha256', 'expires'];
  const pianoHashes = ['voiceSha256', 'mixSha256', 'neutralMixSha256', 'neutralVoiceSha256'];
  if (!exactKeys(value, ['profile', 'solo', 'piano']) || !isExplorationProfile(value.profile) ||
      !exactKeys(value.solo, soloKeys) || !hash(value.solo.sourceSha256) || !expires(value.solo.expires) ||
      !exactKeys(value.piano, [...pianoHashes, 'expires']) ||
      !pianoHashes.every(key => hash(value.piano[key])) || !expires(value.piano.expires) ||
      value.solo.sourceSha256 === value.piano.voiceSha256) throw new Error('invalid_private_exploration');
  return structuredClone(value);
}

export function qualifyExploration({kind, voice, analysis, track, profile=EXPLORATION_PROFILE}) {
  const policy = explorationPolicy(kind,profile);
  if (voice.length !== 8 * 44100) throw new Error('signed_exploration_axis');
  const qualification = qualifySignedPiano({voice, analysis, track, interval:policy.region, motionRegion:policy.motionRegion});
  return {...qualification, method_version:policy.method};
}

export function compileExploration(analysis, qualification, draft, samples) {
  if (!isExplorationMethod(qualification?.method_version) || samples !== 8 * 44100) throw new Error('signed_parent');
  return compileSignedPiano(analysis, qualification, draft, samples);
}

export function renderExploration({voice, mix, analysis, qualification, compiled}) {
  if (!isExplorationMethod(qualification?.method_version) || voice?.length !== 8 * 44100) throw new Error('signed_render_axis');
  const solo = explorationMethodIdentity(qualification.method_version).kind==='solo';
  if (solo && mix !== undefined && mix !== voice) throw new Error('exploration_solo_mix');
  return renderSignedPiano({voice, mix:solo ? voice : mix, analysis, qualification, compiled,
    combinationTimbreHeadroom:Boolean(compiled.controls.M && compiled.controls.Q && compiled.controls.T)});
}
