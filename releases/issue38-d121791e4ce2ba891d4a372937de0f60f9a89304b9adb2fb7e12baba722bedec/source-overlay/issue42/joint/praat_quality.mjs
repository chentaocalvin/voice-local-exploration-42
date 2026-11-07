// SPDX-License-Identifier: GPL-3.0-or-later
export async function measureVoiceQuality({ moduleFactory, bytes, method, interval }) {
  if (!['cpps', 'hnr'].includes(method)) throw new Error('invalid_quality_method');
  const [start, end] = interval, samples = (bytes.length - 44) / 4;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > samples || start >= end) {
    throw new Error('feedback_region');
  }
  if ((end - start) / 44100 < (method === 'cpps' ? 3 : 4.5) / 65) return null;
  const clip = new Uint8Array(44 + (end - start) * 4);
  clip.set(bytes.subarray(0, 44));
  clip.set(bytes.subarray(44 + start * 4, 44 + end * 4), 44);
  const view = new DataView(clip.buffer);
  view.setUint32(4, clip.length - 8, true);
  view.setUint32(40, clip.length - 44, true);

  const module = await moduleFactory();
  if (!module?.FS || typeof module.issue38Quality !== 'function' || !module.issue41Initialize()) {
    throw new Error('feedback_runtime_unavailable');
  }
  const fs = module.FS;
  const input = '/input/voice.wav', output = '/output/quality.txt';
  let inputDir = false, outputDir = false;
  try {
    fs.mkdir('/input');
    inputDir = true;
    fs.mkdir('/output');
    outputDir = true;
    fs.writeFile(input, clip);
    if (!module.issue38Quality(method)) throw new Error('feedback_measurement_failed');
    const size = fs.stat(output).size;
    if (!Number.isSafeInteger(size) || size < 1 || size > 256) throw new Error('invalid_quality_output');
    const text = fs.readFile(output, { encoding: 'utf8' }).trim();
    if (text === '--undefined--') return null;
    if (!/^-?\d+\.\d{12}$/.test(text) || !Number.isFinite(Number(text))) throw new Error('invalid_quality_output');
    return Number(text);
  } finally {
    if (outputDir && fs.analyzePath(output).exists) fs.unlink(output);
    if (inputDir && fs.analyzePath(input).exists) fs.unlink(input);
    if (outputDir) fs.rmdir('/output');
    if (inputDir) fs.rmdir('/input');
  }
}
