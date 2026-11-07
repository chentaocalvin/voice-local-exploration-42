import { sha256 } from './identity.mjs';

const hex = /^[0-9a-f]{64}$/;
export async function loadAsset(manifest, read, maximum = 64 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 1024 ** 3 ||
      !manifest || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > maximum ||
      !hex.test(manifest.sha256) || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 64) {
    throw new Error('invalid_asset_manifest');
  }
  let total = 0;
  const paths = new Set();
  for (const part of manifest.chunks) {
    if (!part || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > 20 * 1024 * 1024 ||
        !hex.test(part.sha256) || typeof part.path !== 'string' || !/^assets\/[a-zA-Z0-9_.-]+$/.test(part.path) || paths.has(part.path)) {
      throw new Error('invalid_asset_manifest');
    }
    total += part.bytes;
    paths.add(part.path);
  }
  if (total !== manifest.bytes) throw new Error('invalid_asset_manifest');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of manifest.chunks) {
    const received = await read(part.path);
    if (!(received instanceof Uint8Array) || received.length !== part.bytes ||
        Object.prototype.toString.call(received.buffer) !== '[object ArrayBuffer]' || await sha256(received) !== part.sha256) {
      throw new Error('asset_identity');
    }
    bytes.set(received, offset);
    offset += received.length;
  }
  if (await sha256(bytes) !== manifest.sha256) throw new Error('asset_identity');
  return bytes;
}
