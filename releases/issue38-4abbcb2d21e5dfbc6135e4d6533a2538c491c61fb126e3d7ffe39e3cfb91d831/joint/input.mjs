// SPDX-License-Identifier: GPL-3.0-or-later
import { decodeStereoPcm32, decodeNativeAccompaniment } from './native_piano.mjs';
import { sha256 } from '../identity.mjs';
import { decodePcm16 } from '../pcm.mjs';
import { decodeRegisteredVoice, readRegisteredProfile } from './registered_piano.mjs';

const maxWav = 8 * 1024 * 1024;
const hash = /^[0-9a-f]{64}$/;
const proofFields = ['axis', 'expires', 'frames', 'role', 'schema', 'voice_sha256'];

function copyBytes(value, limit) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > limit ||
      Object.prototype.toString.call(value.buffer) !== '[object ArrayBuffer]') throw new Error('input_bytes');
  return value.slice();
}

function decodeComponent(bytes, frames) {
  if (bytes.length !== 44 + frames * 4) throw new Error('input_axis');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (label(0) !== 'RIFF' || label(8) !== 'WAVE' || label(12) !== 'fmt ' || label(36) !== 'data' ||
      view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 44100 || view.getUint32(28, true) !== 176400 ||
      view.getUint16(32, true) !== 4 || view.getUint16(34, true) !== 32 ||
      view.getUint32(40, true) !== frames * 4) throw new Error('input_axis');
  return Float64Array.from({ length: frames }, (_, index) => view.getInt32(44 + index * 4, true) / 2147483648);
}

export async function admitInput(input, publicKey, now = Date.now()) {
  const native = input?.accompanimentBytes !== undefined;
  const registered = input?.profileBytes !== undefined;
  if (native && !registered) throw new Error('input_proof');
  const voiceBytes = copyBytes(input?.voiceBytes, registered ? 16 * 1024 * 1024 : maxWav);
  if (registered && input.mixBytes === undefined) throw new Error('input_proof');
  if (input.mixBytes === undefined && input.payload === undefined && input.signature === undefined) {
    const voice = decodePcm16(voiceBytes);
    return { kind: 'solo', voice, voiceBytes, voiceHash: await sha256(voiceBytes), expires: null };
  }

  const piano = input.mixBytes !== undefined;
  const mixBytes = piano ? copyBytes(input.mixBytes, native ? 16 * 1024 * 1024 : maxWav) : undefined;
  const payload = copyBytes(input.payload, 4096), signature = copyBytes(input.signature, 64);
  if (!publicKey || signature.length !== 64 ||
      !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, payload)) {
    throw new Error('input_proof');
  }
  const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  if (!claims || typeof claims !== 'object') throw new Error('input_proof');
  const required = [...proofFields, ...(piano ? ['mix_sha256'] : []), ...(registered ? ['profile_sha256'] : []), ...(native ? ['accompaniment_sha256'] : []), ...(Object.hasOwn(claims, 'preferred') ? ['preferred'] : [])];
  if (Object.keys(claims).sort().join(',') !== required.sort().join(',') ||
      claims.schema !== (native ? 'voice-native-piano-v1' : registered ? 'voice-registered-piano-v1' : piano ? 'voice-piano-source-v1' : 'voice-private-solo-v1') ||
      claims.role !== (piano ? 'estimated_vocal_component' : 'solo_recording') ||
      claims.axis !== (native ? 'mono-f64le-stereo-pcm32-44100' : registered ? 'mono-f64le-44100' : piano ? 'mono-pcm32-44100' : 'mono-pcm16-44100') ||
      !Number.isSafeInteger(claims.frames) || claims.frames < 1 || claims.frames > 45 * 44100 ||
      typeof claims.voice_sha256 !== 'string' || !hash.test(claims.voice_sha256) ||
      (piano && (typeof claims.mix_sha256 !== 'string' || !hash.test(claims.mix_sha256))) ||
      !Number.isSafeInteger(claims.expires)) throw new Error('input_proof');
  if (registered && (!hash.test(claims.profile_sha256) || !claims.preferred)) throw new Error('input_proof');
  if (native && !hash.test(claims.accompaniment_sha256)) throw new Error('input_proof');
  const preferred = claims.preferred ?? null;
  if (preferred !== null && (!Array.isArray(preferred) || preferred.length !== 2 ||
      !preferred.every(Number.isSafeInteger) || preferred[0] < 0 || preferred[0] >= preferred[1] ||
      preferred[1] > Math.floor(claims.frames / 220.5) + 1)) throw new Error('input_proof');
  if (now >= claims.expires) throw new Error('input_expired');
  const [voiceHash, mixHash] = await Promise.all([sha256(voiceBytes), piano ? sha256(mixBytes) : undefined]);
  if (voiceHash !== claims.voice_sha256 || mixHash !== claims.mix_sha256) throw new Error('input_identity');
  let profileBytes, registeredProfile;
  if (registered) {
    profileBytes = copyBytes(input.profileBytes, 320 * 1024);
    if (await sha256(profileBytes) !== claims.profile_sha256) throw new Error('input_identity');
    registeredProfile = readRegisteredProfile(profileBytes, claims);
  }
  const voice = registered ? decodeRegisteredVoice(voiceBytes, claims.frames) : piano ? decodeComponent(voiceBytes, claims.frames) : decodePcm16(voiceBytes);
  if (voice.length !== claims.frames) throw new Error('input_axis');
  const mix = native ? decodeStereoPcm32(mixBytes, claims.frames) : piano ? decodeComponent(mixBytes, claims.frames) : undefined;
  let accompanimentBytes, accompaniment;
  if (native) {
    accompanimentBytes = copyBytes(input.accompanimentBytes, 32 * 1024 * 1024);
    if (await sha256(accompanimentBytes) !== claims.accompaniment_sha256) throw new Error('input_identity');
    accompaniment = decodeNativeAccompaniment(accompanimentBytes, claims.frames);
  }
  return { kind: piano ? 'piano' : 'solo', voice, mix, voiceBytes, mixBytes, voiceHash, mixHash,
    payload, signature, profileBytes, registeredProfile, native, accompanimentBytes, accompaniment, expires: claims.expires, preferred };
}
