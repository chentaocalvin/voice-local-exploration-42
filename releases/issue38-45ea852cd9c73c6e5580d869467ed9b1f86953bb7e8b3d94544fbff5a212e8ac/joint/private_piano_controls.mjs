// SPDX-License-Identifier: GPL-3.0-or-later
import { STRONGER_MOTION_FRAMES } from './signed_piano.mjs';

const intent = (kind, amount, [start_frame, end_frame]) => ({ kind, amount, start_frame, end_frame, mode: 'flat', held: false });
const motion = intent('M', 0.75, STRONGER_MOTION_FRAMES);
const voiceQuality = intent('Q', 4, [100, 1500]);
const color = intent('T', 9, [100, 1500]);
const recipes = { U: [], 'Q−': [intent('Q', -4, [100, 1500])], MQ: [motion, voiceQuality], MQT: [motion, voiceQuality, color] };

export function pianoDraft(recipe) {
  if (!Object.hasOwn(recipes, recipe)) throw new Error('recording_combination_trial_scope');
  return { intents: structuredClone(recipes[recipe]), preserve: [] };
}

export function pianoRecipe(draft) {
  const { intents, preserve } = draft ?? {};
  if (!Array.isArray(intents) || !Array.isArray(preserve) || preserve.length) return null;
  return Object.keys(recipes).find((name) => recipes[name].length === intents.length &&
    recipes[name].every((item, index) => Object.entries(item).every(([key, value]) => intents[index]?.[key] === value))) ?? null;
}

export function soloDraft(recipe, region, amount) {
  const motion = intent('M', amount, region);
  const quality = intent('Q', 6, region);
  const color = intent('T', 6, region);
  const controls = { U: [], Q: [quality], MT: [motion, color], MQT: [motion, quality, color] };
  if (!Object.hasOwn(controls, recipe)) throw new Error('solo_phase_scope');
  return { intents: controls[recipe], preserve: [] };
}

export function soloRecipe(draft, region, amount) {
  const { intents, preserve } = draft ?? {};
  if (!Array.isArray(intents) || !Array.isArray(preserve) || preserve.length) return null;
  return ['U', 'Q', 'MT', 'MQT'].find((name) => {
    const expected = soloDraft(name, region, amount).intents;
    return expected.length === intents.length &&
      expected.every((item, index) => Object.entries(item).every(([key, value]) => intents[index]?.[key] === value));
  }) ?? null;
}
