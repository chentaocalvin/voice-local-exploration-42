// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256 } from '../identity.mjs';
import { encodePcm32 } from '../pcm.mjs';
import { localQualityTimbreIntervals, qualifySource } from '../qualification.mjs';
import { worldRawLength } from '../world.mjs';
import { renderDifference } from './difference.mjs';
import { NATIVE_PIANO_METHOD, renderNativePiano, decodeStereoPcm32, nativePreservationFeedback } from './native_piano.mjs';
import { REGISTERED_PIANO_METHOD, isRegisteredPianoMethod, checkRegisteredDraft, compileRegisteredIntents, verifyRegisteredAnalysis } from './registered_piano.mjs';
export { REGISTERED_PIANO_METHOD } from './registered_piano.mjs';
import { SOLO_WAVEFORM_METHOD, renderSoloWaveform } from './solo_waveform.mjs';
export { SOLO_WAVEFORM_METHOD } from './solo_waveform.mjs';
import { warpMotion } from './solo_motion.mjs';
import { SOLO_NOISE_METHOD, SOLO_NOISE_V2_METHOD, isSoloNoiseMethod, compileSoloNoise, renderSoloNoise } from './solo_noise.mjs';
export { SOLO_NOISE_METHOD, SOLO_NOISE_V2_METHOD, isSoloNoiseMethod } from './solo_noise.mjs';
import { SOLO_PHASE_METHOD, SOLO_PHASE_V2_METHOD, isSoloPhaseMethod, compileSoloPhase, renderSoloPhase } from './solo_phase.mjs';
export { SOLO_PHASE_METHOD, SOLO_PHASE_V2_METHOD, isSoloPhaseMethod } from './solo_phase.mjs';
import { PIANO_PHASE_METHOD, choosePianoPhaseRegion, renderPianoPhase } from './piano_phase.mjs';
export { PIANO_PHASE_METHOD } from './piano_phase.mjs';
import { SIGNED_PIANO_METHOD, qualifySignedPiano, preflightStrongerMotion, STRONGER_MOTION_FRAMES, checkSignedDraft, compileSignedPiano, renderSignedPiano, estimateSignedPianoReads } from './signed_piano.mjs';
import { soloRecipe } from './private_piano_controls.mjs';
export { SIGNED_PIANO_METHOD } from './signed_piano.mjs';
import { admitInput } from './input.mjs';
import { checkDraft, compileIntents, motionStrengthLimit } from './intents.mjs';
import { componentSpectrum, localLevelProfile, preservationFeedback } from './feedback.mjs';

export const JOINT_METHOD = 'voice-local-world-mqt-v1';
export const SOLO_MOTION_METHOD = 'voice-local-solo-motion-warp-v1';
export const PIANO_QUALITY_METHOD = 'voice-local-piano-quality-v1';
export const isJointMethod = (method) =>
  method === SIGNED_PIANO_METHOD || method === PIANO_PHASE_METHOD || isRegisteredPianoMethod(method) || isSoloPhaseMethod(method) || method === SOLO_WAVEFORM_METHOD || isSoloNoiseMethod(method) || method === JOINT_METHOD || method === SOLO_MOTION_METHOD || method === PIANO_QUALITY_METHOD;
const neutralDraft = { intents: [], preserve: [] };
const kinds = ['M', 'Q', 'T'];
const defaultAmounts = { M: 1, Q: 12, T: 6 };
const compareBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

const sameRegion = (actual, expected) => Array.isArray(actual) && actual.length === 2 &&
  actual[0] === expected[0] && actual[1] === expected[1];

function checkProjectDraft(draft, frames, method, region, motionRegion) {
  if (method === SIGNED_PIANO_METHOD) return checkSignedDraft(draft, frames, region, motionRegion);
  if (isRegisteredPianoMethod(method)) return checkRegisteredDraft(draft, frames, region);
  const checked = checkDraft(draft, frames);
  if (method === SOLO_WAVEFORM_METHOD && checked.intents.some((intent) =>
      !['M', 'T'].includes(intent.kind) || intent.mode !== 'flat' ||
      !sameRegion([intent.start_frame, intent.end_frame], region))) throw new Error('solo_waveform_scope');
  if (isSoloPhaseMethod(method) && checked.intents.some((intent) => intent.mode !== 'flat' ||
      !sameRegion([intent.start_frame, intent.end_frame], region) || (intent.kind === 'Q' && intent.amount > 6))) {
    throw new Error('solo_phase_scope');
  }
  if (isSoloNoiseMethod(method) && checked.intents.some((intent) => intent.mode !== 'flat' ||
      !sameRegion([intent.start_frame, intent.end_frame], region) || (intent.kind === 'Q' && intent.amount > 6))) {
    throw new Error('solo_noise_scope');
  }
  if (method === PIANO_PHASE_METHOD && checked.intents.some((intent) =>
      intent.start_frame < region[0] || intent.end_frame > region[1] || (intent.kind === 'Q' && intent.amount > 6))) {
    throw new Error('piano_phase_scope');
  }
  if (method === PIANO_QUALITY_METHOD && checked.intents.some((intent) => intent.kind !== 'Q' ||
      intent.mode !== 'flat' || !sameRegion([intent.start_frame, intent.end_frame], region))) {
    throw new Error('piano_quality_scope');
  }
  return checked;
}

const supportFailure = /^(ineligible_interval|insufficient_support)(?:_[MQT])?$|^condition_insufficient_/;
const intentAt = (kind, [start_frame, end_frame]) => ({
  kind, start_frame, end_frame, amount: defaultAmounts[kind], mode: 'flat',
});

function pianoQualification(analysis, interval, samples, sharedConditions, anchorConditions) {
  const local = { window_frames: interval, eligible_intervals: localQualityTimbreIntervals(analysis, interval) };
  const inspect = (kind) => {
    const intervals = local.eligible_intervals[kind];
    const detail = {
      eligible_intervals: intervals.map((range) => range.slice()),
      eligible_frames: intervals.reduce((sum, [a, b]) => sum + b - a, 0),
      longest_run_frames: Math.max(0, ...intervals.map(([a, b]) => b - a)),
      covers_selection: intervals.some(([a, b]) => a <= interval[0] && interval[1] <= b),
    };
    try {
      const draft = { intents: [intentAt(kind, interval)], preserve: [] };
      const supported = compileIntents(analysis, local, draft, samples).regions.length > 0;
      return { ...detail, status: supported ? 'supported' : 'blocked', code: supported ? null : 'no_active_region' };
    } catch (error) {
      return { ...detail, status: supportFailure.test(error.message) ? 'blocked' : 'unknown', code: error.message };
    }
  };
  const localChecks = { Q: inspect('Q'), T: inspect('T') };
  const shared = [...sharedConditions], anchor = [...anchorConditions];
  // At the signed anchor, the combination compiler checks M before Q and T.
  const motionSupported = anchor.some((code) => /^(ineligible_interval|insufficient_support)_[QT]$/.test(code));
  const motionBlocked = sharedConditions.has('condition_insufficient_no_calibration_window') ||
    anchor.some((code) => /_M$|^condition_insufficient_postcenter_over50$/.test(code));
  return { interval: interval.slice(), shared, anchor, M: motionSupported ? 'supported' : motionBlocked ? 'blocked' : 'unknown',
    Q: localChecks.Q.status, T: localChecks.T.status, local_checks: localChecks };
}

function combination(analysis, source, region, samples, calibrate, fixedAmount, onCondition) {
  const intents = kinds.map((kind) => intentAt(kind, region));
  try {
    if (fixedAmount !== null) intents[0].amount = fixedAmount;
    else if (calibrate) intents[0].amount = motionStrengthLimit(analysis, source, intents[0]);
    if (compileIntents(analysis, source, { intents, preserve: [] }, samples).regions.length > 0) {
      return { interval: region.slice(), motionAmount: intents[0].amount };
    }
  } catch (error) {
    if (!/^ineligible_interval_|^insufficient_support_|^condition_insufficient_/.test(error.message)) throw error;
    onCondition?.(error.message);
  }
}

function chooseRegion(analysis, source, preferred, samples, strict, calibrate, fixedAmount, onCondition) {
  const check = (region) => combination(analysis, source, region, samples, calibrate, fixedAmount, onCondition);
  const proposed = preferred && check(preferred);
  if (proposed || strict) return proposed;
  const defaultRegion = check(source.default_region);
  if (defaultRegion) return defaultRegion;
  const intersections = source.eligible_intervals.M.flatMap(([ma, mb]) =>
    source.eligible_intervals.T.map(([ta, tb]) => [Math.max(ma, ta), Math.min(mb, tb)]));
  intersections.sort(([a, b], [c, d]) => (d - c) - (b - a) || a - c);
  for (const region of intersections) {
    if (region[1] - region[0] < 151) continue;
    const result = check(region);
    if (result) return result;
  }
}

function listeningView(listening, samples) {
  const { start, end, mode, selected } = listening ?? {};
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > samples / 44100 ||
      !['local', 'whole'].includes(mode) || !['O', 'U', 'E'].includes(selected)) throw new Error('archive_listening');
  return { start, end, mode, selected };
}

export function editableJointProject(view) {
  if (!isJointMethod(view?.method) || !Number.isSafeInteger(view.samples) || view.samples <= 0 ||
      view.samples > 45 * 44100 || !Array.isArray(view.region) || view.region.length !== 2) throw new Error('archive_format');
  const frames = Math.floor(view.samples / 220.5) + 1;
  const motionRegion = view.method === SIGNED_PIANO_METHOD && sameRegion(view.region, [100, 1500]) ?
    STRONGER_MOTION_FRAMES : undefined;
  const draft = checkProjectDraft(view.draft, frames, view.method, view.region, motionRegion);
  const listening = listeningView(view.listening, view.samples);
  checkDraft({ intents: [], preserve: [view.region] }, frames);
  return { method_version: view.method, expired: true, samples: view.samples, draft, listening,
    comparison: view.comparison ?? null,
    source: { default_region: view.region.slice(), eligible_intervals: { M: [], Q: [], T: [] } } };
}

export function createJointEngine({
  sdk, publicKey = null, reserve = async () => {}, now = Date.now, calibrateMotionFor = null,
  onRecordingStep = () => {}, recordingCombinationTrial = null, privateSourceExpiries = null, privateRunExpires = null, requireUnsignedSource = false,
  fixedMotionTrial = null, soloMotionBaseline = null, pianoQualityBaseline = null, pianoPhaseSources = [], pianoSignedSources = [], soloWaveformBaseline = null, soloNoiseBaseline = null, soloNoiseV2Baseline = null, soloPhaseBaseline = null, soloPhaseV2Baseline = null,
} = {}) {
  if (calibrateMotionFor !== null && (typeof calibrateMotionFor !== 'string' || !/^[a-f0-9]{64}$/.test(calibrateMotionFor))) {
    throw new Error('motion_calibration_source');
  }
  const trial = fixedMotionTrial === null ? null : structuredClone(fixedMotionTrial);
  const baseline = soloMotionBaseline === null ? null : structuredClone(soloMotionBaseline);
  const validProfile = (profile) => /^[a-f0-9]{64}$/.test(profile.sourceSha256) &&
    Array.isArray(profile.interval) && profile.interval.length === 2 && profile.interval.every(Number.isSafeInteger) &&
    profile.interval[0] >= 0 && profile.interval[0] < profile.interval[1] &&
    Number.isFinite(profile.amount) && profile.amount > 0 && profile.amount < 1;
  if ((trial && (!validProfile(trial) || calibrateMotionFor !== null || baseline)) ||
      (baseline !== null && (!validProfile(baseline) || calibrateMotionFor !== null))) throw new Error('invalid_motion_trial');
  const waveform = soloWaveformBaseline === null ? null : structuredClone(soloWaveformBaseline);
  if (waveform && (!validProfile(waveform) || trial || calibrateMotionFor !== null)) throw new Error('invalid_waveform_profile');
  const noise = soloNoiseBaseline === null ? null : structuredClone(soloNoiseBaseline);
  if (noise && (!validProfile(noise) || trial || calibrateMotionFor !== null)) throw new Error('invalid_noise_profile');
  const noiseV2 = soloNoiseV2Baseline === null ? null : structuredClone(soloNoiseV2Baseline);
  if (noiseV2 && (!validProfile(noiseV2) || trial || calibrateMotionFor !== null)) throw new Error('invalid_noise_v2_profile');
  const phase = soloPhaseBaseline === null ? null : structuredClone(soloPhaseBaseline);
  if (phase && (!validProfile(phase) || trial || calibrateMotionFor !== null)) throw new Error('invalid_phase_profile');
  const phaseV2 = soloPhaseV2Baseline === null ? null : structuredClone(soloPhaseV2Baseline);
  if (phaseV2 && (!validProfile(phaseV2) || trial || calibrateMotionFor !== null)) throw new Error('invalid_phase_v2_profile');
  const pianoQuality = pianoQualityBaseline === null ? null : structuredClone(pianoQualityBaseline);
  if (pianoQualityBaseline !== null && (!pianoQuality || trial || calibrateMotionFor !== null ||
      !/^[a-f0-9]{64}$/.test(pianoQuality.voiceSha256) || !/^[a-f0-9]{64}$/.test(pianoQuality.mixSha256) ||
      !Array.isArray(pianoQuality.interval) || pianoQuality.interval.length !== 2 ||
      !pianoQuality.interval.every(Number.isSafeInteger) || pianoQuality.interval[0] < 0 ||
      pianoQuality.interval[0] >= pianoQuality.interval[1])) throw new Error('invalid_piano_quality_profile');
  const pianoPhases = structuredClone(pianoPhaseSources);
  if (!Array.isArray(pianoPhases) || pianoPhases.length > 1 ||
      pianoPhases.some((entry) => !/^[a-f0-9]{64}$/.test(entry?.voiceSha256) || !/^[a-f0-9]{64}$/.test(entry?.mixSha256)) ||
      new Set(pianoPhases.map((entry) => entry.voiceSha256)).size !== pianoPhases.length ||
      pianoPhases.some((entry) => entry.voiceSha256 === pianoQuality?.voiceSha256)) throw new Error('invalid_piano_phase_sources');
  const signedPianos = structuredClone(pianoSignedSources);
  if (!Array.isArray(signedPianos) || signedPianos.length > 1 ||
      new Set(signedPianos.map((entry) => entry?.voiceSha256)).size !== signedPianos.length || signedPianos.some((entry) =>
      !/^[a-f0-9]{64}$/.test(entry?.voiceSha256) || !/^[a-f0-9]{64}$/.test(entry?.mixSha256))) {
    throw new Error('invalid_signed_piano_sources');
  }
  const combinationTrial = recordingCombinationTrial === null ? null : structuredClone(recordingCombinationTrial);
  const trialKeys = ['voiceSha256', 'mixSha256', 'neutralMixSha256', 'neutralVoiceSha256'];
  if (combinationTrial !== null && (
      !combinationTrial || Object.keys(combinationTrial).length !== trialKeys.length ||
      trialKeys.some(key => typeof combinationTrial[key] !== 'string' || !/^[a-f0-9]{64}$/.test(combinationTrial[key])) ||
      signedPianos.length !== 1 || signedPianos[0].voiceSha256 !== combinationTrial.voiceSha256 ||
      signedPianos[0].mixSha256 !== combinationTrial.mixSha256)) {
    throw new Error('recording_combination_trial_identity');
  }
  const inputExpiries = privateSourceExpiries === null ? null : structuredClone(privateSourceExpiries);
  if (privateSourceExpiries !== null && (!inputExpiries || !phaseV2 || !combinationTrial || requireUnsignedSource ||
      Object.keys(inputExpiries).length !== 2 || ![inputExpiries.solo, inputExpiries.piano]
        .every((expires) => Number.isSafeInteger(expires) && expires > 0))) throw new Error('invalid_private_source_expiries');
  if (privateRunExpires !== null && (!inputExpiries || !Number.isSafeInteger(privateRunExpires) ||
      privateRunExpires <= 0 || privateRunExpires > Math.min(inputExpiries.solo, inputExpiries.piano))) {
    throw new Error('invalid_private_run_expiry');
  }
  if (!sdk || typeof sdk.pitch !== 'function' || typeof sdk.analyze !== 'function' || typeof sdk.synthesize !== 'function') {
    throw new Error('invalid_sdk');
  }
  let project = null, generation = 0, request = 0, motionProbeReserved = 0;
  const effectiveExpiry = (source) => privateRunExpires ?? source.expires;
  const checkDeadline = (source) => {
    const deadline = source && effectiveExpiry(source);
    if (deadline != null && now() >= deadline) throw new Error('input_expired');
  };
  const live = (record) => checkDeadline(record?.source);
  const charge = async (kind, source, samples = 0) => {
    checkDeadline(source);
    await reserve({ kind, input_sha256: source.voiceHash, samples });
    checkDeadline(source);
  };
  const expose = (version) => ({
    id: version.id, sha256: version.sha256, bytes: version.bytes.slice(), control: structuredClone(version.control),
    held: version.held.slice(), regions: version.regions.map((pair) => pair.slice()),
    ...(version.method === SIGNED_PIANO_METHOD ? { voiceBytes: version.voiceBytes.slice(), voice_sha256: version.voiceDigest } : {}),
    ...(version.timbreDeltaScale !== undefined ? { timbre_delta_scale: version.timbreDeltaScale } : {}),
    ...(version.combinationEncodedMixPeak !== undefined ? { encoded_mix_peak: version.combinationEncodedMixPeak } : {}),
    ...(version.phaseStats ? { phase_stats: structuredClone(version.phaseStats) } : {}),
  });

  function checkCombinationDraft(draft, archive = false) {
    const { intents, preserve } = draft ?? {};
    if (!Array.isArray(intents) || intents.length < 1 || intents.length > 3 ||
        !Array.isArray(preserve) || preserve.length || intents.some(intent => {
          if (intent?.mode !== 'flat' || intent.held || !Number.isFinite(intent.amount)) return true;
          const bounds = intent.kind === 'M' ? STRONGER_MOTION_FRAMES : [100, 1500];
          return intent.start_frame !== bounds[0] || intent.end_frame !== bounds[1];
        })) {
      throw new Error('recording_combination_trial_scope');
    }
    const key = intents.map(({kind, amount}) => kind + ':' + amount).join('|');
    const mqt = key === 'M:0.75|Q:4|T:9';
    if (!mqt && (archive || key !== 'Q:-4' && key !== 'M:0.75|Q:4')) {
      throw new Error('recording_combination_trial_scope');
    }
    return mqt;
  }

  async function probeRecordingMotion(record, reference) {
    live(record);
    const baseline = record.versions.get('U');
    if (baseline.sha256 !== reference?.mix_sha256 || baseline.voiceDigest !== reference?.voice_sha256) {
      throw new Error('recording_stronger_baseline_identity');
    }
    const { analysis, qualification, source } = record;
    const result = await preflightStrongerMotion(analysis, qualification, source.voice.length, async steps => {
      if (motionProbeReserved + steps > 150000000) throw new Error('recording_motion_probe_budget');
      await charge('audio_read', source, steps);
      motionProbeReserved += steps;
    });
    live(record);
    return result;
  }

  async function qualifyRecordingMotion(candidate) {
    candidate.motionPreflight = await probeRecordingMotion(candidate, {
      mix_sha256: combinationTrial.neutralMixSha256, voice_sha256: combinationTrial.neutralVoiceSha256,
    });
    if (candidate.motionPreflight.status !== 'passed') throw new Error('recording_combination_trial_motion');
  }

  async function synthesize(source, analysis) {
    await charge('synthesize', source);
    const raw = await sdk.synthesize(analysis);
    if (!(raw instanceof Float64Array) || raw.length !== worldRawLength(analysis.frames)) throw new Error('invalid_raw_axis');
    await charge('audio_read', source, raw.length);
    return raw;
  }

  async function makeVersion(record, draft, id = null) {
    const { source, analysis, qualification, neutral } = record, samples = source.voice.length;
    if (privateRunExpires !== null) await charge('make_version', source);
    const control = [SIGNED_PIANO_METHOD, PIANO_PHASE_METHOD, PIANO_QUALITY_METHOD, SOLO_WAVEFORM_METHOD, SOLO_NOISE_METHOD, SOLO_NOISE_V2_METHOD, SOLO_PHASE_METHOD, SOLO_PHASE_V2_METHOD].includes(record.method)
      ? checkProjectDraft(draft, analysis.frames, record.method, record.region, qualification.motion_region) : draft;
    if (privateRunExpires !== null && record.method === SOLO_PHASE_V2_METHOD &&
        soloRecipe(control, record.region, phaseV2.amount) === null) throw new Error('solo_phase_scope');
    const compiled = record.method === SIGNED_PIANO_METHOD ? compileSignedPiano(analysis, qualification, control, samples)
      : (record.method === PIANO_PHASE_METHOD || isSoloPhaseMethod(record.method)) ? compileSoloPhase(analysis, qualification, control, samples)
      : isSoloNoiseMethod(record.method) ? compileSoloNoise(analysis, qualification, control, samples)
      : isRegisteredPianoMethod(record.method)
      ? compileRegisteredIntents(analysis, source.registeredProfile, control)
      : compileIntents(analysis, qualification, control, samples);
    if ((calibrateMotionFor !== null || trial || [PIANO_PHASE_METHOD, SOLO_MOTION_METHOD, SOLO_WAVEFORM_METHOD, SOLO_NOISE_METHOD, SOLO_NOISE_V2_METHOD, SOLO_PHASE_METHOD, SOLO_PHASE_V2_METHOD].includes(record.method)) && compiled.draft.intents.some((intent) =>
      intent.kind === 'M' && !compiled.held.includes('M') && intent.amount > record.motionAmount)) {
      throw new Error('motion_calibration_strength');
    }
    if (trial) {
      const { intents, preserve } = compiled.draft;
      const allowed = intents.length === 0 || (intents.length === 1 && intents[0].kind === 'M' &&
        intents[0].amount === trial.amount && intents[0].mode === 'flat' && !intents[0].held &&
        intents[0].start_frame === trial.interval[0] && intents[0].end_frame === trial.interval[1]);
      if (!allowed || preserve.length) throw new Error('motion_trial_request');
    }
    const noChange = compiled.regions.length === 0;
    let regions = noChange ? [[0, samples]] : compiled.regions;
    const warp = record.method === SOLO_MOTION_METHOD && compiled.parameters.f0 !== analysis.f0;
    let output, encoded;
    if (record.method === SIGNED_PIANO_METHOD) {
      const combinationTimbreHeadroom = Boolean(record.recordingCombination && !noChange && checkCombinationDraft(control));
      await charge('audio_read', source, estimateSignedPianoReads({
        samples, frames: analysis.frames, phase: 'render', compiled, combinationTimbreHeadroom,
      }) + (noChange ? 6 : 4) * samples);
      output = renderSignedPiano({ voice: source.voice, mix: source.mix, analysis, qualification, compiled,
        combinationTimbreHeadroom });
      regions = output.regions;
    } else if (record.method === PIANO_PHASE_METHOD) {
      await charge('audio_read', source, 24 * samples);
      output = renderPianoPhase({ voice: source.voice, mix: source.mix, analysis, qualification, compiled, sourceHash: source.voiceHash });
      regions = output.regions;
    } else if (isSoloPhaseMethod(record.method)) {
      await charge('audio_read', source, 20 * samples);
      output = renderSoloPhase({ voice: source.voice, analysis, qualification, compiled, sourceHash: source.voiceHash, method: record.method });
      regions = output.regions;
    } else if (isSoloNoiseMethod(record.method)) {
      await charge('audio_read', source, 16 * samples);
      output = renderSoloNoise({ voice: source.voice, analysis, qualification, compiled, sourceHash: source.voiceHash, method: record.method });
      regions = output.regions;
    } else if (record.method === SOLO_WAVEFORM_METHOD) {
      await charge('audio_read', source, 10 * samples);
      output = renderSoloWaveform({ voice: source.voice, analysis, qualification, compiled });
      regions = output.regions;
    } else if (warp) {
      const motion = compiled.draft.intents.find(({ kind }) => kind === 'M');
      if (motion.mode !== 'flat' || motion.start_frame !== record.region[0] || motion.end_frame !== record.region[1] ||
          compiled.parameters.ap !== analysis.ap || compiled.parameters.sp !== analysis.sp) {
        throw new Error('solo_motion_scope');
      }
      await charge('audio_read', source, 5 * samples);
      // The single waveform must keep phase across isolated zero-shift frames.
      regions = [[regions[0][0], regions.at(-1)[1]]];
      const warped = warpMotion(source.voice, analysis.f0, compiled.parameters.f0, regions[0]);
      if (1200 * Math.log2(1 / (1 - warped.closure_rate_peak)) > 3) throw new Error('solo_motion_scope');
      output = { voice: warped.samples };
    } else {
      const raw = await synthesize(source, compiled.parameters);
      if (noChange && !compareBytes(raw, neutral)) throw new Error('neutral_reconstruction_mismatch');
      await charge('audio_read', source, (source.mix ? 8 : 5) * samples);
      if (source.native) encoded = renderNativePiano({ raw, accompaniment: source.accompaniment, samples });
      else output = renderDifference({ voice: source.voice, mix: source.mix, neutral, edited: raw, regions });
    }
    const voiceBytes = encoded?.voiceBytes ?? encodePcm32(output.voice, samples, samples);
    const bytes = encoded?.bytes ?? (source.mix ? encodePcm32(output.mix, samples, samples) : voiceBytes);
    if (noChange && !source.native) {
      const original = encodePcm32(source.mix ?? source.voice, samples, samples);
      if (!compareBytes(bytes, original)) throw new Error('neutral_pcm_mismatch');
    }
    const [digest, voiceDigest] = await Promise.all([sha256(bytes), sha256(voiceBytes)]);
    const identity = id ?? 'E:' + await sha256(new TextEncoder().encode(JSON.stringify([source.voiceHash, source.mixHash ?? null, digest, compiled.draft])));
    return { id: identity, method: record.method, sha256: digest, bytes, voiceBytes, voiceDigest, control: compiled.draft,
      held: compiled.held, regions: noChange ? [] : regions,
      ...(output?.stats?.timbre_delta_scale !== undefined ? { timbreDeltaScale: output.stats.timbre_delta_scale } : {}),
      ...(output?.stats?.combination_encoded_mix_peak !== undefined ?
        { combinationEncodedMixPeak: output.stats.combination_encoded_mix_peak } : {}),
      ...(output?.phaseStats ? { phaseStats: output.phaseStats } : {}) };
  }

  function readOutput(bytes, samples) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Float64Array.from({ length: samples }, (_, index) => view.getInt32(44 + index * 4, true) / 2147483648);
  }

  async function measure(record, version, interval) {
    const { source, measurements } = record;
    const key = JSON.stringify([version.voiceDigest, interval]);
    if (measurements.has(key)) return measurements.get(key);
    const samples = source.voice.length;
    await charge('audio_read', source, samples * 3);
    const voice = readOutput(version.voiceBytes, samples);
    await charge('stft', source);
    const spectrum = componentSpectrum(voice, interval);
    const quality = {};
    for (const method of ['cpps', 'hnr']) {
      if (typeof sdk.voiceQuality !== 'function') { quality[method] = null; continue; }
      await charge(method, source);
      await charge('audio_read', source, interval[1] - interval[0]);
      const value = await sdk.voiceQuality(version.voiceBytes, method, interval);
      quality[method] = Number.isFinite(value) ? value : null;
    }
    const value = { spectrum, quality, level: localLevelProfile(voice, interval) };
    measurements.set(key, value);
    if (measurements.size > 36) measurements.delete(measurements.keys().next().value);
    return value;
  }

  async function compare(scope) {
    const record = project, token = generation;
    if (!record || scope?.input_sha256 !== (record.source.mixHash ?? record.source.voiceHash)) throw new Error('feedback_source');
    live(record);
    const { source, versions } = record, samples = source.voice.length;
    if (privateRunExpires !== null) await charge('compare', source);
    if (scope.axis !== 'vocal_only' && !(scope.axis === 'full_mix' && source.kind === 'piano')) throw new Error('feedback_axis');
    const interval = Array.isArray(scope.interval) ? scope.interval.slice() : null;
    if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(Number.isSafeInteger) ||
        interval[0] < 0 || interval[1] > samples || interval[1] <= interval[0]) throw new Error('feedback_region');
    const original = versions.get('U');
    const resolve = (id) => id === 'O' ? original : versions.get(id);
    const left = resolve(scope.left), right = resolve(scope.right);
    if (!left || !right || scope.left_sha256 !== left.sha256 || scope.right_sha256 !== right.sha256) throw new Error('feedback_version');
    const before = await measure(record, left, interval);
    const after = await measure(record, right, interval);
    await charge('audio_read', source, (source.native ? 12 : source.mix ? 4 : 2) * samples);
    const measured = (version) => ({ voice: readOutput(version.voiceBytes, samples),
      mix: source.native ? decodeStereoPcm32(version.bytes, samples) : source.mix ? readOutput(version.bytes, samples) : undefined, regions: version.regions });
    const preservation = (source.native ? nativePreservationFeedback : preservationFeedback)(measured(left), measured(right), interval);
    live(record);
    if (record !== project || token !== generation) throw new Error('stale_request');
    record.lastComparison = { input_sha256: scope.input_sha256, axis: scope.axis, interval,
      left: scope.left, right: scope.right, left_sha256: left.sha256, right_sha256: right.sha256 };
    return { source: scope.input_sha256, interval: interval.slice(), axis: scope.axis,
      versions: [{ id: scope.left, sha256: left.sha256 }, { id: scope.right, sha256: right.sha256 }],
      motion: { axis: 'vocal_only', before: before.level, after: after.level,
        periodic: { status: 'unknown', reason: 'cycle_crosscheck_not_available' } },
      quality: { axis: 'vocal_only', before: before.quality, after: after.quality },
      timbre: { axis: 'vocal_only', before: before.spectrum, after: after.spectrum }, preservation };
  }

  function current() {
    if (!project) throw new Error('project_missing');
    live(project);
    const { source, qualification, versions, selected, region } = project;
    return { input_sha256: source.mixHash ?? source.voiceHash, samples: source.voice.length, sample_rate: 44100,
      kind: source.kind, method_version: project.method, selected, expires: effectiveExpiry(source),
      source: { window_frames: qualification.window_frames.slice(), default_region: region.slice(),
        eligible_intervals: structuredClone(qualification.eligible_intervals),
        ...(source.native ? { rendering: 'full_resynthesis', channels: 2 } : {}),
        ...(calibrateMotionFor !== null || trial || [PIANO_PHASE_METHOD, SOLO_MOTION_METHOD, SOLO_WAVEFORM_METHOD, SOLO_NOISE_METHOD, SOLO_NOISE_V2_METHOD, SOLO_PHASE_METHOD, SOLO_PHASE_V2_METHOD].includes(project.method) ? { motion_amount: project.motionAmount } : {}) },
      ...(inputExpiries && project.recordingCombination ? { fixed_piano_recipe: true } : {}),
      ...(privateRunExpires !== null && project.method === SOLO_PHASE_V2_METHOD ? { fixed_solo_recipe: true } : {}),
      ...(project.recordingCombination ? { effective_support: { ...qualification.effective_support },
        motion_region: [...STRONGER_MOTION_FRAMES] } : {}),
      original: { id: 'O', bytes: (source.mixBytes ?? source.voiceBytes).slice() },
      baseline: expose(versions.get('U')),
      available: [...versions.values()].filter((version) => version.id !== 'U').map(expose) };
  }

  async function prepare(input, preferred, savedMethod = null) {
    const source = await admitInput(input, publicKey, now());
    if (requireUnsignedSource && source.payload) throw new Error('private_setup_required');
    if (inputExpiries && !source.payload) throw new Error('private_setup_unsigned_source');
    const registered = Boolean(source.registeredProfile);
    if (registered && savedMethod !== null && !sameRegion(preferred, source.registeredProfile.metadata.frame_window)) {
      throw new Error('registered_identity');
    }
    if ((registered && savedMethod !== null && savedMethod !== (source.native ? NATIVE_PIANO_METHOD : REGISTERED_PIANO_METHOD)) ||
        (!registered && isRegisteredPianoMethod(savedMethod))) throw new Error('registered_identity');
    const calibrate = calibrateMotionFor !== null;
    if ((calibrate && (source.kind !== 'solo' || source.voiceHash !== calibrateMotionFor)) ||
        (trial && (source.kind !== 'solo' || source.voiceHash !== trial.sourceSha256 || !source.payload ||
          !source.preferred || !source.preferred.every((frame, index) => frame === trial.interval[index])))) {
      throw new Error('motion_calibration_source');
    }
    const baselineMatches = baseline && source.kind === 'solo' && source.voiceHash === baseline.sourceSha256 &&
      source.payload && source.preferred?.every((frame, index) => frame === baseline.interval[index]);
    if (!baselineMatches && (savedMethod === SOLO_MOTION_METHOD ||
        (savedMethod === null && baseline?.sourceSha256 === source.voiceHash))) throw new Error('solo_motion_identity');
    const waveformMatches = waveform && source.kind === 'solo' && source.voiceHash === waveform.sourceSha256 &&
      source.payload && sameRegion(source.preferred, waveform.interval);
    if ((savedMethod === SOLO_WAVEFORM_METHOD && (!waveformMatches || !sameRegion(preferred, waveform.interval))) ||
        (savedMethod === null && waveform?.sourceSha256 === source.voiceHash && !waveformMatches)) throw new Error('solo_waveform_identity');
    const useWaveform = waveformMatches && (savedMethod === null || savedMethod === SOLO_WAVEFORM_METHOD);
    const noiseMatches = noise && source.kind === 'solo' && source.voiceHash === noise.sourceSha256 &&
      source.payload && sameRegion(source.preferred, noise.interval);
    if ((savedMethod === SOLO_NOISE_METHOD && (!noiseMatches || !sameRegion(preferred, noise.interval))) ||
        (savedMethod === null && noise?.sourceSha256 === source.voiceHash && !noiseMatches)) throw new Error('solo_noise_identity');
    const useNoise = noiseMatches && (savedMethod === null || savedMethod === SOLO_NOISE_METHOD);
    const noiseV2Matches = noiseV2 && source.kind === 'solo' && source.voiceHash === noiseV2.sourceSha256 &&
      source.payload && sameRegion(source.preferred, noiseV2.interval);
    if ((savedMethod === SOLO_NOISE_V2_METHOD && (!noiseV2Matches || !sameRegion(preferred, noiseV2.interval))) ||
        (savedMethod === null && noiseV2?.sourceSha256 === source.voiceHash && !noiseV2Matches)) throw new Error('solo_noise_v2_identity');
    const useNoiseV2 = noiseV2Matches && (savedMethod === null || savedMethod === SOLO_NOISE_V2_METHOD);
    const phaseMatches = phase && source.kind === 'solo' && source.voiceHash === phase.sourceSha256 &&
      source.payload && sameRegion(source.preferred, phase.interval);
    if ((savedMethod === SOLO_PHASE_METHOD && (!phaseMatches || !sameRegion(preferred, phase.interval))) ||
        (savedMethod === null && phase?.sourceSha256 === source.voiceHash && !phaseMatches)) throw new Error('solo_phase_identity');
    const usePhase = phaseMatches && (savedMethod === null || savedMethod === SOLO_PHASE_METHOD);
    const phaseV2Matches = phaseV2 && source.kind === 'solo' && source.voiceHash === phaseV2.sourceSha256 &&
      source.payload && sameRegion(source.preferred, phaseV2.interval);
    if ((savedMethod === SOLO_PHASE_V2_METHOD && (!phaseV2Matches || !sameRegion(preferred, phaseV2.interval))) ||
        (savedMethod === null && phaseV2?.sourceSha256 === source.voiceHash && !phaseV2Matches)) throw new Error('solo_phase_v2_identity');
    const usePhaseV2 = phaseV2Matches && (savedMethod === null || savedMethod === SOLO_PHASE_V2_METHOD);
    const pianoQualitySource = pianoQuality && source.kind === 'piano' &&
      source.voiceHash === pianoQuality.voiceSha256 && source.mixHash === pianoQuality.mixSha256;
    const pianoQualityMatches = pianoQualitySource && sameRegion(source.preferred, pianoQuality.interval);
    if ((savedMethod === PIANO_QUALITY_METHOD && (!pianoQualityMatches || !sameRegion(preferred, pianoQuality.interval))) ||
        (savedMethod === null && pianoQualitySource && !pianoQualityMatches)) throw new Error('piano_quality_identity');
    const pianoPhaseSource = pianoPhases.find((entry) => entry.voiceSha256 === source.voiceHash);
    const pianoPhaseMatches = pianoPhaseSource && source.kind === 'piano' && !registered && !source.preferred &&
      source.mixHash === pianoPhaseSource.mixSha256;
    if ((savedMethod === PIANO_PHASE_METHOD && !pianoPhaseMatches) ||
        (savedMethod === null && pianoPhaseSource && !pianoPhaseMatches)) throw new Error('piano_phase_identity');
    const usePianoPhase = pianoPhaseMatches && (savedMethod === null || savedMethod === PIANO_PHASE_METHOD);
    const signedPiano = signedPianos.find((entry) => entry.voiceSha256 === source.voiceHash);
    const signedRegion = combinationTrial ? [100, 1500] : [100, 550];
    const signedMatches = signedPiano && source.kind === 'piano' && !registered && source.mixHash === signedPiano.mixSha256 &&
      (!source.preferred || sameRegion(source.preferred, signedRegion));
    if ((savedMethod === SIGNED_PIANO_METHOD && !signedMatches) ||
        (savedMethod === null && signedPiano && !signedMatches)) throw new Error('signed_piano_identity');
    const useSignedPiano = Boolean(signedMatches && (savedMethod === null || savedMethod === SIGNED_PIANO_METHOD));
    if (useSignedPiano && preferred != null && !sameRegion(preferred, signedRegion)) throw new Error('signed_piano_region');
    const recordingCombination = Boolean(combinationTrial && useSignedPiano &&
      source.voiceHash === combinationTrial.voiceSha256 && source.mixHash === combinationTrial.mixSha256 &&
      source.expires != null);
    if (combinationTrial && !recordingCombination && !(usePhaseV2 && source.expires != null)) {
      throw new Error('recording_combination_trial_source');
    }
    if (inputExpiries && source.expires !== inputExpiries[recordingCombination ? 'piano' : 'solo']) {
      throw new Error('private_source_expiry');
    }
    if (privateRunExpires !== null) await charge('open', source);
    const motionBaseline = savedMethod !== JOINT_METHOD && baselineMatches ? baseline : null;
    const qualityOnly = !useSignedPiano && pianoQualityMatches && savedMethod !== JOINT_METHOD;
    const method = useSignedPiano ? SIGNED_PIANO_METHOD : usePianoPhase ? PIANO_PHASE_METHOD : registered ? (source.native ? NATIVE_PIANO_METHOD : REGISTERED_PIANO_METHOD) : usePhaseV2 ? SOLO_PHASE_V2_METHOD : usePhase ? SOLO_PHASE_METHOD : useNoiseV2 ? SOLO_NOISE_V2_METHOD : useNoise ? SOLO_NOISE_METHOD : useWaveform ? SOLO_WAVEFORM_METHOD : qualityOnly ? PIANO_QUALITY_METHOD : motionBaseline ? SOLO_MOTION_METHOD : JOINT_METHOD;
    const profile = usePhaseV2 ? phaseV2 : usePhase ? phase : useNoiseV2 ? noiseV2 : useNoise ? noise : useWaveform ? waveform : motionBaseline ?? trial;
    await charge('audio_read', source, 5 * source.voice.length);
    let track;
    if (!qualityOnly && !registered) {
      if (useSignedPiano) onRecordingStep('praat');
      await charge('praat', source);
      track = await sdk.pitch(source.voiceBytes, source.voiceHash);
    }
    if (useSignedPiano) onRecordingStep('world');
    await charge('world_analysis', source);
    const analysis = await sdk.analyze(source.voice);
    let qualification, selection;
    if (registered) {
      await verifyRegisteredAnalysis(analysis, source.registeredProfile);
      live({ source });
      const interval = source.registeredProfile.metadata.frame_window.slice();
      qualification = { window_frames: interval, eligible_intervals: { M: [interval], Q: [interval], T: [interval] } };
      selection = { interval };
    } else if (useSignedPiano) {
      onRecordingStep('motion_support');
      await charge('audio_read', source, estimateSignedPianoReads({ samples: source.voice.length, frames: analysis.frames, phase: 'prepare' }));
      qualification = qualifySignedPiano({ voice: source.voice, analysis, track, interval: signedRegion,
        motionRegion: recordingCombination ? STRONGER_MOTION_FRAMES : undefined });
      selection = { interval: qualification.default_region.slice() };
    } else if (qualityOnly) {
      const interval = pianoQuality.interval;
      const { Q } = localQualityTimbreIntervals(analysis, interval);
      qualification = { window_frames: interval, eligible_intervals: { M: [], Q, T: [] } };
      compileIntents(analysis, qualification, { intents: [intentAt('Q', interval)], preserve: [] }, source.voice.length);
      selection = { interval };
    } else {
      const anchor = profile?.interval ?? source.preferred ?? preferred;
      const strict = !usePianoPhase && (profile !== null || (source.kind === 'piano' && source.preferred != null));
      const diagnostics = source.kind === 'piano' && source.preferred ? { shared: new Set(), anchor: new Set() } : null;
      const onSharedCondition = diagnostics && ((code) => diagnostics.shared.add(code));
      const onAnchorCondition = diagnostics && ((code) => diagnostics.anchor.add(code));
      const selectRegion = (candidate) => usePianoPhase
        ? choosePianoPhaseRegion(analysis, candidate, source.voice.length, preferred)
        : chooseRegion(analysis, candidate, anchor, source.voice.length, strict, calibrate, profile?.amount ?? null, onAnchorCondition);
      const qualify = (candidate) => Boolean(selectRegion(candidate));
      try {
        qualification = qualifySource({
          ...analysis, track, samples: source.voice.length, inputSha256: source.voiceHash, methodVersion: method,
        }, qualify, false, true, onSharedCondition);
        selection = selectRegion(qualification);
        if (!selection) throw new Error('condition_insufficient_MQT_region');
      } catch (error) {
        if (diagnostics && /^condition_insufficient_/.test(error.message)) {
          checkDeadline(source);
          diagnostics.shared.add(error.message);
          error.pianoQualification = pianoQualification(analysis, anchor, source.voice.length, diagnostics.shared, diagnostics.anchor);
          if (error.motionSearch) error.pianoQualification.motion_search = error.motionSearch;
          checkDeadline(source);
        }
        throw error;
      }
    }
    const neutral = useSignedPiano || usePianoPhase || usePhaseV2 || usePhase || useWaveform || useNoise || useNoiseV2 ? null : await synthesize(source, analysis);
    const candidate = { source, analysis, qualification, neutral, method, recordingCombination, region: selection.interval,
      motionAmount: selection.motionAmount, selected: 'U', versions: new Map(), measurements: new Map() };
    const neutralVersion = await makeVersion(candidate, neutralDraft, 'U');
    if (recordingCombination && (neutralVersion.sha256 !== combinationTrial.neutralMixSha256 ||
        neutralVersion.voiceDigest !== combinationTrial.neutralVoiceSha256)) {
      throw new Error('recording_combination_trial_baseline');
    }
    candidate.versions.set('U', neutralVersion);
    live(candidate);
    return candidate;
  }

  function install(candidate, token) {
    live(candidate);
    if (token !== generation) throw new Error('stale_request');
    project = candidate;
    return current();
  }

  return {
    current,
    compare,
    async open(input, preferred = null) {
      const token = ++generation;
      const candidate = await prepare(input, preferred);
      if (inputExpiries && candidate.recordingCombination) await qualifyRecordingMotion(candidate);
      return install(candidate, token);
    },
    async reserveSave() {
      if (!project) throw new Error('project_missing');
      if (privateRunExpires !== null) await charge('save', project.source);
    },
    capture(draft, listening, selected = project?.selected) {
      if (!project) throw new Error('project_missing');
      live(project);
      const { source, versions, analysis, region, qualification } = project;
      const input = { voiceBytes: source.voiceBytes.slice() };
      if (source.accompanimentBytes) input.accompanimentBytes = source.accompanimentBytes.slice();
      if (source.profileBytes) input.profileBytes = source.profileBytes.slice();
      if (source.mixBytes) input.mixBytes = source.mixBytes.slice();
      if (source.payload) {
        input.payload = source.payload.slice();
        input.signature = source.signature.slice();
      }
      const version = versions.get(selected);
      if (!version) throw new Error('result_missing');
      if (project.recordingCombination) {
        checkCombinationDraft(draft, true);
        checkCombinationDraft(version.control, true);
      }
      if (privateRunExpires !== null && project.method === SOLO_PHASE_V2_METHOD &&
          [draft, version.control].some(value => soloRecipe(value, region, phaseV2.amount) !== 'MQT')) {
        throw new Error('solo_phase_scope');
      }
      return { input, expires: effectiveExpiry(source), view: { method: project.method, samples: source.voice.length, selected, digest: version.sha256,
        ...(inputExpiries && project.recordingCombination ?
          { voiceDigest: version.voiceDigest, timbre_delta_scale: version.timbreDeltaScale } : {}),
        resultControl: structuredClone(version.control), region: region.slice(),
        draft: checkProjectDraft(draft, analysis.frames, project.method, region, qualification.motion_region), listening: listeningView(listening, source.voice.length),
        comparison: project.lastComparison?.right === selected ? structuredClone(project.lastComparison) : null } };
    },
    async restore({ input, view }) {
      if (!isJointMethod(view?.method) || !/^(U|E:[0-9a-f]{64})$/.test(view.selected) ||
          !/^[0-9a-f]{64}$/.test(view.digest)) throw new Error('archive_result_mismatch');
      const token = ++generation;
      if (combinationTrial && !(phaseV2 && view.method === SOLO_PHASE_V2_METHOD) &&
          (!inputExpiries || view.method === SIGNED_PIANO_METHOD)) {
        if (view.method !== SIGNED_PIANO_METHOD || view.selected === 'U') throw new Error('recording_combination_trial_scope');
        checkCombinationDraft(view.draft, true);
        checkCombinationDraft(view.resultControl, true);
        if (inputExpiries && (typeof view.voiceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(view.voiceDigest) ||
            !Number.isFinite(view.timbre_delta_scale) || view.timbre_delta_scale < .5 || view.timbre_delta_scale > 1)) {
          throw new Error('archive_result_mismatch');
        }
      }
      const candidate = await prepare(input, view.region, view.method);
      const { source, analysis } = candidate;
      const draft = checkProjectDraft(view.draft, analysis.frames, candidate.method, candidate.region, candidate.qualification.motion_region);
      const listening = listeningView(view.listening, source.voice.length);
      if (candidate.recordingCombination) await qualifyRecordingMotion(candidate);
      const result = view.selected === 'U' ? candidate.versions.get('U') : await makeVersion(candidate, view.resultControl);
      if (result.id !== view.selected || result.sha256 !== view.digest ||
          (inputExpiries && candidate.recordingCombination &&
            (result.voiceDigest !== view.voiceDigest || result.timbreDeltaScale !== view.timbre_delta_scale)) ||
          (result.id === 'U' && listening.selected === 'E')) throw new Error('archive_result_mismatch');
      const saved = view.comparison;
      if (saved != null) {
        const baseline = candidate.versions.get('U');
        if (saved.input_sha256 !== (source.mixHash ?? source.voiceHash) || saved.left !== 'U' ||
            saved.left_sha256 !== baseline.sha256 || saved.right !== result.id || saved.right_sha256 !== result.sha256 ||
            saved.axis !== (source.kind === 'piano' ? 'full_mix' : 'vocal_only') ||
            !Array.isArray(saved.interval) || saved.interval.length !== 2 || !saved.interval.every(Number.isSafeInteger) ||
            saved.interval[0] < 0 || saved.interval[1] <= saved.interval[0] || saved.interval[1] > source.voice.length) {
          throw new Error('archive_feedback_mismatch');
        }
        candidate.lastComparison = structuredClone(saved);
      }
      candidate.versions.set(result.id, result);
      candidate.selected = result.id;
      return { ...install(candidate, token), result: result.id === 'U' ? null : expose(result), draft, listening,
        comparison: candidate.lastComparison ?? null,
        ...(candidate.recordingCombination ? { motion_preflight: structuredClone(candidate.motionPreflight) } : {}) };
    },
    async preflightRecordingMotion(reference) {
      const record = project;
      if (!record?.recordingCombination || record.motionPreflight) throw new Error('recording_motion_preflight_scope');
      const result = await probeRecordingMotion(record, reference);
      if (record !== project) throw new Error('stale_request');
      record.motionPreflight = result;
      return structuredClone(result);
    },
    async render(draft, keepId = null) {
      const record = project, token = generation, ordinal = ++request;
      if (!record) throw new Error('project_missing');
      live(record);
      if (record.recordingCombination) {
        checkCombinationDraft(draft);
        if (record.motionPreflight?.status !== 'passed') {
          throw new Error('recording_combination_trial_motion');
        }
      }
      const result = await makeVersion(record, draft);
      live(record);
      if (record !== project || token !== generation || ordinal !== request) throw new Error('stale_request');
      record.versions.set(result.id, result);
      if (record.versions.size > (record.method === SIGNED_PIANO_METHOD ? 32 : 12)) {
        const discard = [...record.versions.keys()].find((id) => id !== 'U' && id !== record.selected && id !== result.id && id !== keepId);
        record.versions.delete(discard);
      }
      return expose(result);
    },
    select(id) {
      if (!project?.versions.has(id)) throw new Error('result_missing');
      live(project);
      project.selected = id;
      return expose(project.versions.get(id));
    },
    close() { generation++; project = null; },
  };
}
