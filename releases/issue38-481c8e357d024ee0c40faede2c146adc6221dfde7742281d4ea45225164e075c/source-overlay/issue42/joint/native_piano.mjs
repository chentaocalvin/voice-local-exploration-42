// SPDX-License-Identifier: GPL-3.0-or-later
import { preservationFeedback } from './feedback.mjs';

export const NATIVE_PIANO_METHOD = 'voice-native-registered-piano-mqt-v1';
export const NATIVE_PIANO_RENDERER = 'stereo-accompaniment-plus-raw-v1-gain-one';
const validSamples = (samples) => Number.isSafeInteger(samples) && samples > 0 && samples <= 45 * 44100;

export function encodeNativePcm32(values, samples, channels = 1) {
  if (!validSamples(samples) || ![1, 2].includes(channels) || !(values instanceof Float64Array) ||
      values.length !== samples * channels) throw new Error('native_audio_axis');
  const bytes = new Uint8Array(44 + values.length * 4), view = new DataView(bytes.buffer);
  const label = (at, text) => bytes.set(new TextEncoder().encode(text), at);
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, 44100, true); view.setUint32(28, 44100 * channels * 4, true);
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); label(36, 'data');
  view.setUint32(40, values.length * 4, true);
  for (let index = 0; index < values.length; index++) {
    const scaled = values[index] * 2147483648, low = Math.floor(scaled), fraction = scaled - low;
    const integer = fraction < .5 ? low : fraction > .5 ? low + 1 : low % 2 === 0 ? low : low + 1;
    if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) throw new Error('native_audio_overflow');
    view.setInt32(44 + index * 4, integer, true);
  }
  return bytes;
}

export function decodeStereoPcm32(bytes, samples) {
  if (!validSamples(samples) || !(bytes instanceof Uint8Array) || bytes.length !== 44 + samples * 8) {
    throw new Error('native_audio_axis');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (at) => new TextDecoder().decode(bytes.subarray(at, at + 4));
  if (label(0) !== 'RIFF' || label(8) !== 'WAVE' || label(12) !== 'fmt ' || label(36) !== 'data' ||
      view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 2 || view.getUint32(24, true) !== 44100 ||
      view.getUint32(28, true) !== 352800 || view.getUint16(32, true) !== 8 || view.getUint16(34, true) !== 32 ||
      view.getUint32(40, true) !== samples * 8) throw new Error('native_audio_axis');
  return Float64Array.from({ length: samples * 2 }, (_, index) => view.getInt32(44 + index * 4, true) / 2147483648);
}

export function renderNativePiano({ raw, accompaniment, samples }) {
  if (!validSamples(samples) || !(raw instanceof Float64Array) || raw.length < samples ||
      !(accompaniment instanceof Float64Array) || accompaniment.length !== 2 * samples ||
      !raw.every(Number.isFinite) || !accompaniment.every(Number.isFinite)) throw new Error('native_audio_axis');
  const voice = raw.slice(0, samples), mix = new Float64Array(samples * 2);
  for (let index = 0; index < samples; index++) {
    mix[index * 2] = accompaniment[index] + voice[index];
    mix[index * 2 + 1] = accompaniment[samples + index] + voice[index];
  }
  return { bytes: encodeNativePcm32(mix, samples, 2), voiceBytes: encodeNativePcm32(voice, samples) };
}

export function decodeNativeAccompaniment(bytes, samples) {
  if (!validSamples(samples) || !(bytes instanceof Uint8Array) || bytes.length !== samples * 16) {
    throw new Error('native_audio_axis');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Float64Array.from({ length: samples * 2 }, (_, index) => view.getFloat64(index * 8, true));
  if (!values.every(Number.isFinite)) throw new Error('native_audio_axis');
  return values;
}

export function nativePreservationFeedback(reference, edited, interval) {
  const samples = reference.voice.length;
  if (edited.voice.length !== samples || reference.mix.length !== 2 * samples || edited.mix.length !== 2 * samples) {
    throw new Error('feedback_axis');
  }
  const channels = [0, 1].map((channel) => preservationFeedback(
    { ...reference, mix: Float64Array.from({ length: samples }, (_, i) => reference.mix[2 * i + channel]) },
    { ...edited, mix: Float64Array.from({ length: samples }, (_, i) => edited.mix[2 * i + channel]) }, interval));
  return { ...channels[0], protected_mix_equal: channels.every((value) => value.protected_mix_equal),
    estimated_residual_equal: channels.every((value) => value.estimated_residual_equal),
    mix_channels: 2, protected_mix_channels_equal: channels.map((value) => value.protected_mix_equal) };
}

export const comparisonPlaybackGain = (method, role) => role === 'O' && method !== NATIVE_PIANO_METHOD ? .5 : 1;
