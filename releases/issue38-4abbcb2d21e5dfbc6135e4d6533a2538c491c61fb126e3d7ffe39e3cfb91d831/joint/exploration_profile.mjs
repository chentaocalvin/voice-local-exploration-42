// SPDX-License-Identifier: GPL-3.0-or-later
// This named profile is a separate authorization domain; legacy v2 caps stay fixed.
export const EXPLORATION_PROFILE='issue38-joint-exploration-v1';
export const EXPLORATION_SCHEMA='voice-private-setup-v3';
export const EXPLORATION_MAX_LEASE=120*60*1000;
export const EXPLORATION_METHODS=Object.freeze({
  solo:'voice-local-solo-signed-exploration-v1',
  piano:'voice-local-piano-signed-exploration-v1',
});
export const HEADROOM_PROFILE='issue38-joint-spectral-headroom-v1';
export const HEADROOM_METHODS=Object.freeze({
  solo:'voice-local-solo-spectral-headroom-v1',
  piano:'voice-local-piano-spectral-headroom-v1',
});
export const SHARED_HEADROOM_PROFILE='issue38-joint-shared-spectral-headroom-v1';
export const SHARED_HEADROOM_METHODS=Object.freeze({
  solo:'voice-local-solo-shared-spectral-headroom-v1',
  piano:'voice-local-piano-shared-spectral-headroom-v1',
});
export const isSpectralHeadroomProfile=profile=>profile===HEADROOM_PROFILE||profile===SHARED_HEADROOM_PROFILE;
const profiles=new Map([[EXPLORATION_PROFILE,EXPLORATION_METHODS],[HEADROOM_PROFILE,HEADROOM_METHODS],
  [SHARED_HEADROOM_PROFILE,SHARED_HEADROOM_METHODS]]);
const identities=new Map([...profiles].flatMap(([profile,methods])=>
  Object.entries(methods).map(([kind,method])=>[method,Object.freeze({profile,kind,method})])));
export const isExplorationProfile=profile=>profiles.has(profile);
export const explorationMethodIdentity=method=>identities.get(method)??null;
export function explorationMethodFor(profile,kind) {
  const methods=profiles.get(profile);
  if(!methods||!Object.hasOwn(methods,kind))throw new Error('exploration_profile');
  return methods[kind];
}
const limits=Object.freeze({praat:4,world_analysis:4,synthesize:0,cpps:26,hnr:26,stft:26,
  make_version:28,compare:24,save:2,open:2,audio_read:1_250_000_000});
export const EXPLORATION_CAPS=Object.freeze({solo:limits,piano:limits});
export const EXPLORATION_AXES=Object.freeze({samples:352800,frames:1601,sample_rate:44100,
  region:Object.freeze([100,1500]),solo_motion:Object.freeze([621,870]),
  piano_motion:Object.freeze([681,1046]),modes:Object.freeze(['flat','front','back','shift']),
  solo_m:.5,piano_m:.75,q:4,t:9,shift_seconds:.25,max_motion_pieces:10,max_versions:32});
const sourceExpiry=Object.freeze({solo:Date.parse('2026-11-10T17:24:06Z'),piano:Date.parse('2026-11-13T03:38:03.318Z')});
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>0;
const keys=(value,names)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));

export function validateExplorationSetup(setup,code='private_setup_policy') {
  const {solo,piano,run}=setup??{};
  if(!keys(setup,['schema','profile','release','solo','piano','run'])||setup.schema!==EXPLORATION_SCHEMA||
      !isExplorationProfile(setup.profile)||typeof setup.release!=='string'||!setup.release||
      !keys(solo,['sourceSha256','expires'])||!hash(solo.sourceSha256)||
      !keys(piano,['voiceSha256','mixSha256','neutralMixSha256','neutralVoiceSha256','expires'])||
      !['voiceSha256','mixSha256','neutralMixSha256','neutralVoiceSha256'].every(name=>hash(piano[name]))||
      !time(solo.expires)||!time(piano.expires)||solo.expires>sourceExpiry.solo||piano.expires>sourceExpiry.piano||
      solo.sourceSha256===piano.voiceSha256||!keys(run,['id','recipient','not_before','expires'])||
      !hash(run.id)||!hash(run.recipient)||!time(run.not_before)||!time(run.expires)||
      run.expires<=run.not_before||run.expires-run.not_before>EXPLORATION_MAX_LEASE||
      run.expires>Math.min(solo.expires,piano.expires))throw new Error(code);
  return setup;
}

export function explorationProjectId(runId,kind,role) {
  if(!hash(runId)||!Object.hasOwn(EXPLORATION_METHODS,kind)||!['seed','final'].includes(role))
    throw new Error('private_archive_identity');
  return `J:${runId}:${kind}:${role}`;
}

export function explorationArchiveBinding(setup,kind,role) {
  validateExplorationSetup(setup,'private_run_policy');
  explorationProjectId(setup.run.id,kind,role);
  return {profile:setup.profile,run_id:setup.run.id,recipient:setup.run.recipient,kind,role,
    source_sha256:kind==='solo'?setup.solo.sourceSha256:setup.piano.voiceSha256};
}

export function sameArchiveBinding(left,right) {
  return keys(left,['profile','run_id','recipient','kind','role','source_sha256'])&&
    Object.keys(right).every(name=>left[name]===right[name]);
}
