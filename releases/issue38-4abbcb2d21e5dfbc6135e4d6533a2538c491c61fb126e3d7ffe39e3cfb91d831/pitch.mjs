// SPDX-License-Identifier: GPL-3.0-or-later
export function parsePitchTrack(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1_048_576) {
    throw new Error('invalid_track');
  }
  const rows = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (rows.length === 0 || rows.length > 10_000) throw new Error('invalid_track');
  let previous = -1;
  return rows.map((row) => {
    const parts = row.split('\t');
    if (parts.length !== 2 || !/^\d+\.\d{9}$/.test(parts[0])) throw new Error('invalid_track');
    const time = Number(parts[0]);
    if (!Number.isFinite(time) || time <= previous) throw new Error('invalid_track');
    previous = time;
    if (parts[1] === '--undefined--') return { time, hz: 0, undefined: true };
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(parts[1])) {
      throw new Error('invalid_track');
    }
    const hz = Number(parts[1]);
    if (!Number.isFinite(hz) || hz < 0) throw new Error('invalid_track');
    return { time, hz, undefined: false };
  });
}

/** Candidate only. Caller must independently authenticate the JS factory,
 * approved source/build manifest and input rights. Matching hashes below bind
 * bytes to the supplied identities but do not authenticate those identities.
 * A fresh Emscripten instance is created per input and MEMFS is cleaned.
 */
export async function analyzePitch(options) {
  if (!options || typeof options.moduleFactory !== 'function' ||
      !(options.wasmBytes instanceof Uint8Array) || options.wasmBytes.length === 0 ||
      !(options.inputBytes instanceof Uint8Array) || options.inputBytes.length === 0 ||
      !/^[0-9a-f]{64}$/.test(options.wasmSha256) || !/^[0-9a-f]{64}$/.test(options.inputSha256)) {
    throw new Error('praat_6406_runtime_unverified');
  }
  const { moduleFactory, wasmSha256, inputSha256 } = options;
  const isCurrent = options.isCurrent ?? (() => true);
  if (typeof isCurrent !== 'function') throw new Error('invalid_request');
  const checkCurrent = () => { if (isCurrent() !== true) throw new Error('stale_request'); };
  checkCurrent();
  // Limits bound the pre-await snapshots; input cap includes WAV headers.
  if (options.wasmBytes.byteLength > 64 * 1024 * 1024 ||
      options.inputBytes.byteLength > 8 * 1024 * 1024) throw new Error('input_limit');
  // Capture non-shared bytes before the first await. A caller-supplied digest
  // still needs separate authentication; this only binds bytes to that digest.
  if (Object.prototype.toString.call(options.wasmBytes.buffer) !== '[object ArrayBuffer]' ||
      Object.prototype.toString.call(options.inputBytes.buffer) !== '[object ArrayBuffer]') {
    throw new Error('shared_buffer_not_allowed');
  }
  const wasmSnapshot = new Uint8Array(options.wasmBytes);
  const inputSnapshot = new Uint8Array(options.inputBytes);
  const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (await digest(wasmSnapshot) !== wasmSha256 ||
      await digest(inputSnapshot) !== inputSha256) throw new Error('identity_mismatch');
  checkCurrent();
  const module = await moduleFactory({ wasmBinary: wasmSnapshot });
  if (!module || !module.FS || typeof module.issue41Initialize !== 'function' ||
      typeof module.issue41PitchAc !== 'function') throw new Error('invalid_runtime');
  checkCurrent();
  let inputCreated = false;
  let outputCreated = false;
  let result;
  let failure;
  try {
    if (!module.issue41Initialize()) throw new Error('praat_initialization_failed');
    module.FS.mkdir('/input');
    inputCreated = true;
    module.FS.mkdir('/output');
    outputCreated = true;
    module.FS.writeFile('/input/voice.wav', inputSnapshot, { canOwn: false });
    checkCurrent();
    if (!module.issue41PitchAc()) throw new Error('praat_analysis_failed');
    const size = module.FS.stat('/output/pitch.tsv').size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > 1_048_576) throw new Error('invalid_track');
    result = parsePitchTrack(module.FS.readFile('/output/pitch.tsv', { encoding: 'utf8' }));
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = [];
  const clean = (fn) => { try { fn(); } catch (error) { cleanupErrors.push(error); } };
  if (inputCreated) {
    clean(() => { if (module.FS.analyzePath('/input/voice.wav').exists) module.FS.unlink('/input/voice.wav'); });
    clean(() => module.FS.rmdir('/input'));
  }
  if (outputCreated) {
    clean(() => { if (module.FS.analyzePath('/output/pitch.tsv').exists) module.FS.unlink('/output/pitch.tsv'); });
    clean(() => module.FS.rmdir('/output'));
  }
  if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'praat_cleanup_failed');
  if (failure) throw failure;
  return result;
}
