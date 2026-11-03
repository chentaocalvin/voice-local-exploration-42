// SPDX-License-Identifier: GPL-3.0-or-later
import { createEngine } from './engine.mjs';
import { loadAsset } from './assets.mjs';
import { createWorld } from './world.mjs';
import { analyzePitch } from './pitch.mjs';
import { makeProject, saveProject, reopenProject, verifyLocalProject, exportProject, importProject,
  listProjects, deleteProject, deleteAllProjects } from './projects.mjs';

const PINS = {
  praat_module: 'c4f896e909f4ad1733ed2dcc6320096e19ccc5647e951a70a54f19db0313d1a2',
  praat_wasm: '4fad3e73c2cb8daecaddc72920b5c29fa9a62c6d8ac367d0be19794dccc7eb9d',
  world_module: '8b27b73fefe8be20b36cf5288d06d1cd938813b7d9c1a179227fe1cac3d5cdcb',
  world_wasm: 'fabb1b8f6225f23221bb75f0b69fcbe6f6e033ef0c1aedf0d124393001715a46',
};
let engine, busy = false, manifest, verification = false, verificationSdkCap = 48;
const timings = [];
const read = async (path) => {
  const response = await fetch(new URL(path, import.meta.url), { credentials: 'omit' });
  if (!response.ok) throw new Error('asset_load_failed');
  return new Uint8Array(await response.arrayBuffer());
};

async function importVerified(asset) {
  if (asset.chunks.length !== 1 || !asset.chunks[0].path.endsWith('.mjs')) throw new Error('runtime_module_path');
  // Keep the original module's import.meta.url on the immutable static release.
  return (await import(new URL(asset.chunks[0].path, import.meta.url).href)).default;
}

async function openVerificationDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('voice-local-verification-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function auditReserve(event) {
  if (!verification) return;
  const database = await openVerificationDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction('events', 'readwrite'), store = tx.objectStore('events'), request = store.getAll();
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('verification_budget_exhausted'));
      request.onsuccess = () => {
        const rows = request.result, sdk = rows.filter((row) => row.kind !== 'audio_read').length;
        const samples = rows.reduce((sum, row) => sum + (row.samples || 0), 0);
        if ((event.kind !== 'audio_read' && sdk >= verificationSdkCap) || samples + event.samples > 4000 * 44100) { tx.abort(); return; }
        store.add(event);
      };
    });
  } finally { database.close(); }
}

async function verificationEvents() {
  if (!verification) return [];
  const database = await openVerificationDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction('events', 'readonly'), request = tx.objectStore('events').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('audit_read_failed'));
    });
  } finally { database.close(); }
}

async function initialize(options) {
  verification = options.verification === true;
  verificationSdkCap = options.verificationSdkCap ?? 48;
  if (!Number.isSafeInteger(verificationSdkCap) || verificationSdkCap < 1 || verificationSdkCap > 48) {
    throw new Error('invalid_verification_budget');
  }
  const response = await fetch(new URL('./release.json', import.meta.url), { credentials: 'omit' });
  if (!response.ok) throw new Error('asset_load_failed');
  manifest = await response.json();
  const loaded = {};
  for (const [name, hash] of Object.entries(PINS)) {
    if (manifest.assets?.[name]?.sha256 !== hash) throw new Error('runtime_identity');
    self.postMessage({ progress: name.startsWith('praat') ? '载入独立音高检查' : '载入声音处理引擎' });
    loaded[name] = await loadAsset(manifest.assets[name], read);
  }
  const [praatFactory, worldFactory] = await Promise.all([importVerified(manifest.assets.praat_module), importVerified(manifest.assets.world_module)]);
  const world = createWorld(await worldFactory({ wasmBinary: loaded.world_wasm, locateFile: (path) => new URL('assets/' + path, import.meta.url).href }));
  engine = createEngine({ sdk: {
    pitch: (inputBytes, inputSha256) => analyzePitch({ moduleFactory: (options) => praatFactory({ ...options, locateFile: (path) => new URL('assets/' + path, import.meta.url).href }), wasmBytes: loaded.praat_wasm,
      wasmSha256: PINS.praat_wasm, inputBytes, inputSha256 }),
    analyze: (samples) => world.analyze(samples), synthesize: (parameters) => world.synthesize(parameters),
  }, reserve: auditReserve, verifyLocal: (record) => verifyLocalProject(indexedDB, record) });
  return { release: manifest.release, method: engine.id };
}

self.onmessage = async ({ data }) => {
  const id = data?.id;
  if (typeof id !== 'string' || busy) { self.postMessage({ id, ok: false, error: 'processor_busy' }); return; }
  busy = true;
  const start = performance.now();
  try {
    let result;
    if (data.type === 'initialize') result = await initialize(data);
    else {
      if (!engine) throw new Error('engine_not_ready');
      if (data.type === 'analyze') result = await engine.analyze(data.bytes);
      else if (data.type === 'render') result = await engine.render(data.control, verification ? data.slot : null, data.keepId);
      else if (data.type === 'save' || data.type === 'export') {
        const snapshot = await engine.snapshot(data.view), record = await makeProject(snapshot);
        if (data.type === 'save') {
          await saveProject(indexedDB, data.projectId, record, engine.authorizeSnapshot);
          result = { id: data.projectId };
        } else result = { blob: await exportProject(record) };
      } else if (data.type === 'reopen') result = await engine.restoreLocal(await reopenProject(indexedDB, data.projectId));
      else if (data.type === 'import') result = await engine.restoreImported(await importProject(data.blob));
      else if (data.type === 'list') result = await listProjects(indexedDB);
      else if (data.type === 'delete') { await deleteProject(indexedDB, data.projectId); result = true; }
      else if (data.type === 'deleteAll') { await deleteAllProjects(indexedDB); result = true; }
      else if (data.type === 'evidence') result = await engine.evidencePiece(data.slot);
      else if (data.type === 'audit') result = { events: await verificationEvents(), current_worker_events: engine.audit(), timings, release: manifest.release };
      else throw new Error('invalid_request');
    }
    timings.push({ operation: data.type, elapsed_ms: performance.now() - start, ok: true });
    self.postMessage({ id, ok: true, result, elapsed_ms: performance.now() - start });
  } catch (error) {
    timings.push({ operation: data.type, elapsed_ms: performance.now() - start, ok: false });
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'processing_failed', elapsed_ms: performance.now() - start });
  } finally { busy = false; }
};
