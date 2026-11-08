// SPDX-License-Identifier: GPL-3.0-or-later
export function inspectPcm16(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44 || bytes.length > 8 * 1024 * 1024 ||
      Object.prototype.toString.call(bytes.buffer) !== '[object ArrayBuffer]') throw new Error('invalid_wav');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) throw new Error('invalid_wav');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= bytes.length) {
    const id = text(pos, 4), n = view.getUint32(pos + 4, true), start = pos + 8;
    if (start + n > bytes.length || start + n + (n % 2) > bytes.length) throw new Error('invalid_wav');
    if (id === 'fmt ') {
      if (fmt || n < 16) throw new Error('invalid_wav');
      fmt = { format: view.getUint16(start, true), channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true),
        block: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
    }
    if (id === 'data') { if (data) throw new Error('invalid_wav'); data = [start, n]; }
    pos = start + n + (n % 2);
  }
  if (pos !== bytes.length || !fmt || !data || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 44100 ||
      fmt.bits !== 16 || fmt.block !== 2 || fmt.byteRate !== 88200 || data[1] === 0 || data[1] % 2 || data[1] / 2 > 45 * 44100) throw new Error('invalid_wav');
  return { offset: data[0], samples: data[1] / 2 };
}

export function decodePcm16(bytes) {
  const info = inspectPcm16(bytes), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float64Array(info.samples);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(info.offset + i * 2, true) / 32768;
  return samples;
}



export function encodePcm32(raw, samples, expectedRawLength) {
  if (!(raw instanceof Float64Array) || !Number.isSafeInteger(samples) || samples <= 0 ||
      !Number.isSafeInteger(expectedRawLength) || raw.length !== expectedRawLength || raw.length < samples ||
      !raw.every((v) => Number.isFinite(v) && Math.abs(v * .5) <= .98)) throw new Error('invalid_raw');
  const out = new Uint8Array(44 + samples * 4), view = new DataView(out.buffer);
  const put = (at, text) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, out.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true); view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true); put(36, 'data'); view.setUint32(40, samples * 4, true);
  for (let i = 0; i < samples; i++) {
    const x = raw[i] * .5 * 2147483648, floor = Math.floor(x), fraction = x - floor;
    const rounded = fraction < .5 ? floor : fraction > .5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
    view.setInt32(44 + 4 * i, rounded, true);
  }
  return out;
}
