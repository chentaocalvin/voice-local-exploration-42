// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256 } from '../identity.mjs';

const limits = { setup: 4096, solo: 1024 * 1024, piano: 3 * 1024 * 1024 };
const maxHeader = 4096;
const maxFrame = 4 + maxHeader + Object.values(limits).reduce((sum, bytes) => sum + bytes, 0);
const hash = /^[0-9a-f]{64}$/;

async function readFrame(response, contentType, maximum) {
  if (!response.ok || response.headers.get('Content-Type') !== contentType || !response.body) {
    throw new Error('private_transfer_unavailable');
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(maximum);
  let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      if (value.length > buffer.length - length) throw new Error('private_transfer_size');
      buffer.set(value, length);
      length += value.length;
    }
    return buffer.subarray(0, length);
  } catch (error) {
    buffer.fill(0);
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function importPrivateRunTransfer(address, release, recipient, { read = fetch, now = Date.now, prove, profile = null } = {}) {
  if(profile!==null&&profile!=='issue38-joint-exploration-v1') throw new Error('private_transfer_profile');
  const frameLimit=profile==='issue38-joint-exploration-v1'?4198400:maxFrame;
  if (typeof address !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[0-9a-f]{64}\/$/.test(address)) {
    throw new Error('private_transfer_address');
  }
  let url;
  try { url = new URL(address); } catch { throw new Error('private_transfer_address'); }
  const options = { credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer' };
  const challengeBytes = await readFrame(await read(new URL('challenge', url), options), 'application/json', 256);
  let challenge;
  try { ({challenge} = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(challengeBytes))); }
  catch { throw new Error('private_transfer_challenge'); }
  if (typeof challenge !== 'string' || !hash.test(challenge)) throw new Error('private_transfer_challenge');
  const proof = await prove(challenge);
  const bytes = await readFrame(await read(url, {...options, method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(proof)}), 'application/octet-stream', frameLimit);
  try {
    if (bytes.length < 5) throw new Error('private_transfer_size');
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    if (!headerLength || headerLength > maxHeader || headerLength > bytes.length - 4) throw new Error('private_transfer_size');
    let header;
    try { header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(4, 4 + headerLength))); }
    catch { throw new Error('private_transfer_format'); }
    const kinds = Object.keys(limits);
    if (header?.schema !== 'issue38-private-transfer-v1' || header.release !== release || header.recipient !== recipient ||
        typeof header.run_id !== 'string' || !hash.test(header.run_id) || !Number.isSafeInteger(header.expires) ||
        now() >= header.expires || !Array.isArray(header.files) || header.files.length !== kinds.length) {
      throw new Error('private_transfer_identity');
    }
    let offset = 4 + headerLength;
    const parts = {};
    for (const [index, kind] of kinds.entries()) {
      const item = header.files[index];
      if (item?.kind !== kind || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > limits[kind] ||
          item.bytes > bytes.length - offset || typeof item.sha256 !== 'string' || !hash.test(item.sha256)) {
        throw new Error('private_transfer_size');
      }
      const content = bytes.subarray(offset, offset + item.bytes);
      if (await sha256(content) !== item.sha256) throw new Error('private_transfer_identity');
      parts[kind] = new Blob([content]);
      offset += item.bytes;
    }
    if (offset !== bytes.length || now() >= header.expires) throw new Error('private_transfer_size');
    return {runId: header.run_id, expires: header.expires, parts};
  } finally {
    bytes.fill(0);
  }
}
