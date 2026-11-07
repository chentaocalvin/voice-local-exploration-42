// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256 } from '../identity.mjs';

const magic = new TextEncoder().encode('ISS38P01');
const registeredMagic = new TextEncoder().encode('ISS38P02');
const maxBytes = 20 * 1024 * 1024;
const nativeMagic = new TextEncoder().encode('ISS38P03');
const nativeMaxBytes = 48 * 1024 * 1024;
const maxHeader = 64 * 1024;
const legacyNames = ['voiceBytes', 'mixBytes', 'payload', 'signature'];
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });

export async function exportJointArchive({ input, view }) {
  const native = input.accompanimentBytes !== undefined;
  const registered = input.profileBytes !== undefined;
  if (native && !registered) throw new Error('archive_input');
  const names = native ? [...legacyNames, 'profileBytes', 'accompanimentBytes'] : registered ? [...legacyNames, 'profileBytes'] : legacyNames;
  const parts = names.map((name) => input[name] ?? new Uint8Array());
  if (!parts.every((bytes) => bytes instanceof Uint8Array)) throw new Error('archive_input');
  const metadata = encoder.encode(JSON.stringify({ lengths: parts.map((bytes) => bytes.length), view }));
  const length = 12 + metadata.length + parts.reduce((total, bytes) => total + bytes.length, 0);
  if (metadata.length > maxHeader || length + 64 > (native ? nativeMaxBytes : maxBytes)) throw new Error('archive_limit');
  const body = new Uint8Array(length);
  body.set(native ? nativeMagic : registered ? registeredMagic : magic);
  new DataView(body.buffer).setUint32(8, metadata.length, true);
  body.set(metadata, 12);
  let offset = 12 + metadata.length;
  for (const bytes of parts) {
    body.set(bytes, offset);
    offset += bytes.length;
  }
  return new Blob([body, await sha256(body)], { type: 'application/octet-stream' });
}

export async function readJointArchive(blob) {
  if (!(blob instanceof Blob) || blob.size < 76 || blob.size > nativeMaxBytes) throw new Error('archive_limit');
  const prefix = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const native = nativeMagic.every((value, i) => prefix[i] === value);
  if (!native && blob.size > maxBytes) throw new Error('archive_limit');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const end = bytes.length - 64;
  const registered = registeredMagic.every((value, i) => bytes[i] === value);
  if (!native && !registered && !magic.every((value, i) => bytes[i] === value)) throw new Error('archive_format');
  const names = native ? [...legacyNames, 'profileBytes', 'accompanimentBytes'] : registered ? [...legacyNames, 'profileBytes'] : legacyNames;
  if (await sha256(bytes.subarray(0, end)) !== decoder.decode(bytes.subarray(end))) throw new Error('archive_identity');
  const size = new DataView(bytes.buffer).getUint32(8, true);
  if (size < 1 || size > maxHeader || 12 + size >= end) throw new Error('archive_format');
  const metadata = JSON.parse(decoder.decode(bytes.subarray(12, 12 + size)));
  const lengths = metadata?.lengths;
  if (!Array.isArray(lengths) || lengths.length !== names.length ||
      !lengths.every((length) => Number.isSafeInteger(length) && length >= 0) ||
      !lengths[0] || ((registered || native) && !lengths[4]) || (native && !lengths[5]) || lengths.reduce((total, length) => total + length, 12 + size) !== end ||
      !metadata.view || typeof metadata.view !== 'object') throw new Error('archive_format');
  const input = {};
  let offset = 12 + size;
  names.forEach((name, index) => {
    const length = lengths[index];
    if (length) input[name] = bytes.slice(offset, offset + length);
    offset += length;
  });
  return { input, view: metadata.view };
}

export function isJointArchive(blob) {
  return blob instanceof Blob && blob.size >= 8 && blob.slice(0, 8).arrayBuffer()
    .then((buffer) => [magic, registeredMagic, nativeMagic].some((candidate) => candidate.every((value, i) => new Uint8Array(buffer)[i] === value)));
}

function connect(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('voice-local-joint-projects-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function expired(record) {
  return record?.blob instanceof Blob && Number.isSafeInteger(record.expires) && Date.now() >= record.expires;
}

function strip(record) {
  return { view: record.view, expires: record.expires, blob: null };
}

export async function jointStorage(indexedDB, operation, key, record) {
  const db = await connect(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('projects', 'readwrite');
      const store = transaction.objectStore('projects');
      let answer;
      if (operation === 'get') {
        const request = store.get(key);
        request.onsuccess = () => {
          answer = request.result;
          if (expired(answer)) { answer = strip(answer); store.put(answer, key); }
        };
      } else if (operation === 'expire') {
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result?.blob instanceof Blob) store.put(strip(request.result), key);
        };
      } else if (operation === 'list' || operation === 'purge') {
        answer = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (operation === 'list') answer.push(cursor.key);
          if (expired(cursor.value)) cursor.update(strip(cursor.value));
          cursor.continue();
        };
      } else if (operation === 'add') store.add(expired(record) ? strip(record) : record, key);
      else if (operation === 'delete') store.delete(key);
      else if (operation === 'clear') store.clear();
      else throw new Error('invalid_storage_operation');
      transaction.oncomplete = () => resolve(answer);
      transaction.onabort = () => reject(transaction.error ?? new Error('project_storage_failed'));
    });
  } finally { db.close(); }
}
