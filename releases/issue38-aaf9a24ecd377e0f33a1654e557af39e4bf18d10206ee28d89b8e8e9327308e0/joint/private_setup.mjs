// SPDX-License-Identifier: GPL-3.0-or-later
import {EXPLORATION_SCHEMA,isExplorationProfile,validateExplorationSetup} from './exploration_profile.mjs';
const hash = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const maxEnvelope = 4096, maxPayload = 2048, signatureBytes = 64;

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function parse(bytes, code) {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(code);
  }
}

function decodeBase64Url(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('private_setup_format');
  }
  let decoded;
  try {
    decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    throw new Error('private_setup_format');
  }
  if (decoded.length > limit || btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) {
    throw new Error('private_setup_format');
  }
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

export async function readPrivateSetup(blob, publicKey, release, now = Date.now(), {requireRun = false,expectedProfile} = {}) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > maxEnvelope) throw new Error('private_setup_format');
  const envelope = parse(await blob.arrayBuffer(), 'private_setup_format');
  if (!exactKeys(envelope, ['payload', 'signature'])) throw new Error('private_setup_format');
  const payload = decodeBase64Url(envelope.payload, maxPayload);
  const signature = decodeBase64Url(envelope.signature, signatureBytes);
  if (signature.length !== signatureBytes ||
      !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, payload)) {
    throw new Error('private_setup_signature');
  }
  const claims = parse(payload, 'private_setup_policy');
  if(expectedProfile!==undefined&&!isExplorationProfile(expectedProfile))throw new Error('private_setup_policy');
  if (claims?.schema === EXPLORATION_SCHEMA) {
    if (!requireRun||!isExplorationProfile(expectedProfile)||claims.profile!==expectedProfile) throw new Error('private_setup_policy');
    validateExplorationSetup(claims);
    if (claims.release !== release) throw new Error('private_setup_release');
    if (now < claims.run.not_before) throw new Error('private_setup_not_started');
    if (now >= claims.run.expires) throw new Error('private_setup_expired');
    return claims;
  }
  if(expectedProfile!==undefined)throw new Error('private_setup_policy');
  const fields = ['schema', 'release', 'solo', 'piano'];
  const schema = requireRun ? 'voice-private-setup-v2' : 'voice-private-setup-v1';
  if (requireRun) fields.push('run');
  if (!exactKeys(claims, fields) || claims.schema !== schema) throw new Error('private_setup_policy');
  if (typeof claims.release !== 'string' || !claims.release || claims.release !== release) throw new Error('private_setup_release');
  const { solo, piano } = claims;
  const pianoHashes = ['voiceSha256', 'mixSha256', 'neutralMixSha256', 'neutralVoiceSha256'];
  const isHash = value => typeof value === 'string' && hash.test(value);
  const validExpiry = value => Number.isSafeInteger(value) && value > 0;
  if (!exactKeys(solo, ['sourceSha256', 'interval', 'amount', 'expires']) || !isHash(solo.sourceSha256) ||
      !Array.isArray(solo.interval) || solo.interval.length !== 2 || !solo.interval.every(Number.isSafeInteger) ||
      solo.interval[0] < 0 || solo.interval[0] >= solo.interval[1] || solo.interval[1] > 45 * 200 + 1 ||
      !Number.isFinite(solo.amount) || solo.amount <= 0 || solo.amount >= 1 || !validExpiry(solo.expires) ||
      !exactKeys(piano, [...pianoHashes, 'expires']) || !pianoHashes.every(key => isHash(piano[key])) ||
      !validExpiry(piano.expires)) throw new Error('private_setup_policy');
  if (requireRun) {
    const { run } = claims;
    if (!exactKeys(run, ['id', 'recipient', 'not_before', 'expires']) || !isHash(run.id) || !isHash(run.recipient) ||
        !validExpiry(run.not_before) || !validExpiry(run.expires) || run.expires <= run.not_before ||
        run.expires - run.not_before > 60 * 60 * 1000 || run.expires > Math.min(solo.expires, piano.expires) ||
        solo.sourceSha256 === piano.voiceSha256) throw new Error('private_setup_policy');
    if (now < run.not_before) throw new Error('private_setup_not_started');
    if (now >= run.expires) throw new Error('private_setup_expired');
  } else if (now >= Math.max(solo.expires, piano.expires)) {
    throw new Error('private_setup_expired');
  }
  return claims;
}

export function privateSetupEngineOptions(setup) {
  const {solo,piano}=setup;
  if (setup.schema===EXPLORATION_SCHEMA) {
    validateExplorationSetup(setup);
    return {privateExploration:{profile:setup.profile,solo:structuredClone(solo),piano:structuredClone(piano)},
      privateSourceExpiries:{solo:solo.expires,piano:piano.expires}};
  }
  const { expires: soloExpires, ...soloPhaseV2Baseline } = solo;
  const { expires: pianoExpires, ...recordingCombinationTrial } = piano;
  const { voiceSha256, mixSha256 } = recordingCombinationTrial;
  return {
    soloPhaseV2Baseline, recordingCombinationTrial, pianoSignedSources: [{ voiceSha256, mixSha256 }],
    privateSourceExpiries: { solo: soloExpires, piano: pianoExpires },
  };
}
