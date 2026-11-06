// SPDX-License-Identifier: GPL-3.0-or-later
import { createEngine } from './engine.mjs';
import { loadAsset } from './assets.mjs';
import { createWorld } from './world.mjs';
import { analyzePitch } from './pitch.mjs';
import { createJointEngine } from './joint/engine.mjs';
import { createJointActions, optionalJointActions } from './joint/actions.mjs';
import { privateSetupEngineOptions, readPrivateSetup } from './joint/private_setup.mjs';
import { enrollPrivateRun, openPrivateRun, provePrivateTransfer } from './joint/private_run.mjs';
import { jointStorage } from './joint/archive.mjs';
import { measureVoiceQuality } from './joint/praat_quality.mjs';
import { makeProject, saveProject, reopenProject, verifyLocalProject, exportProject, importProject,
  listProjects, deleteProject, deleteAllProjects } from './projects.mjs';

const PINS = {
  praat_module: 'c4f896e909f4ad1733ed2dcc6320096e19ccc5647e951a70a54f19db0313d1a2',
  praat_wasm: '4fad3e73c2cb8daecaddc72920b5c29fa9a62c6d8ac367d0be19794dccc7eb9d',
  world_module: '8b27b73fefe8be20b36cf5288d06d1cd938813b7d9c1a179227fe1cac3d5cdcb',
  world_wasm: 'fabb1b8f6225f23221bb75f0b69fcbe6f6e033ef0c1aedf0d124393001715a46',
};
const PRIVATE_QUALITY_PINS = {
  praat_quality_module: '3a0fa4a532145b29a071c350218e2de0851b4f173781b59b7e1f7477cdddb85e',
  praat_quality_wasm: 'd3f29721d5ab79fa90d7373a0241972074a59467925cc58c0837559f5be10f9a',
};
let engine, busy = false, manifest, verification = false, verificationSdkCap = 48;
const timings = [];
let joint = createJointActions(null, null);
let privateSetupSession = null, boundedLegacyReadback = false;
const legacyReadbackCaps = {praat:2, harvest:2, cheaptrick:2, d4c:2, synthesize:4};
const legacyExample = '97504361908ce2f8b27a65ce408f13757b6ac6ba07ae53f527b5d91a9eee3ae4';
let privateTrial = false, soloMotionVerification = false;
const soloMotionCaps = { world_analysis: 2, synthesize: 5, praat: 2 };
const soloMotionOperations = new Set(['jointOpen', 'jointRender', 'jointSave', 'jointList', 'jointReopen', 'jointDelete', 'audit']);
const trialCaps = { world_analysis: 1, synthesize: 3, praat: 1 };
const jointCaps = { world_analysis: 8, synthesize: 24, praat: 32, cpps: 32, hnr: 32, stft: 32 };
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

async function importVerifiedQuality(asset) {
  const data = await loadAsset(asset, read);
  const url = URL.createObjectURL(new Blob([data], { type: 'text/javascript' }));
  try { return (await import(url)).default; }
  finally { URL.revokeObjectURL(url); }
}

async function openVerificationDatabase(jointMode = false) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(jointMode ? 'voice-local-joint-verification-v1' : 'voice-local-verification-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function auditReserve(event, jointMode = false) {
  if (!verification) return;
  const database = await openVerificationDatabase(jointMode);
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction('events', 'readwrite'), store = tx.objectStore('events'), request = store.getAll();
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('verification_budget_exhausted'));
      request.onsuccess = () => {
        const rows = request.result, sdk = rows.filter((row) => row.kind !== 'audio_read').length;
        const samples = rows.reduce((sum, row) => sum + (row.samples || 0), 0);
        if (boundedLegacyReadback && !jointMode &&
            ((event.input_sha256 !== null && event.input_sha256 !== legacyExample) ||
            (event.slot === 'input-identity' && rows.filter(row => row.slot === 'input-identity').length >= 2) ||
            (event.kind !== 'audio_read' && rows.filter(row => row.kind === event.kind).length >= (legacyReadbackCaps[event.kind] ?? 0)) ||
            samples + event.samples > 80000000)) { tx.abort(); return; }
        const callCap = jointMode
          ? rows.filter((row) => row.kind === event.kind).length >= ((privateTrial ? trialCaps : soloMotionVerification ? soloMotionCaps : jointCaps)[event.kind] ?? 0)
          : sdk >= verificationSdkCap;
        if ((event.kind !== 'audio_read' && callCap) ||
            samples + event.samples > (privateTrial || soloMotionVerification ? 16000000 : jointMode ? 150000000 : 4000 * 44100)) { tx.abort(); return; }
        store.add({ ...event, utc: event.utc ?? new Date().toISOString() });
      };
    });
  } finally { database.close(); }
}

async function verificationEvents(jointMode = false) {
  if (!verification) return [];
  const database = await openVerificationDatabase(jointMode);
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction('events', 'readonly'), request = tx.objectStore('events').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('audit_read_failed'));
    });
  } finally { database.close(); }
}

function createPrivateSetupSession(publicEngine, publicActions, jointOptions, release, requireRun) {
  const publicRoute = { engine: publicEngine, actions: publicActions };
  let active = publicRoute, privateRoute = null;
  const privateProjectId = (runId, kind) => 'J:' + runId + ':' + kind;
  const privateKinds = ['solo', 'piano'];
  const withRunLock = (route, operation) => navigator.locks.request('voice-private-run:' + route.runId, operation);
  const sourceKind = (route, data) => {
    if (data.type === 'jointOpen') return 'solo';
    if (data.type === 'jointOpenPiano') return 'piano';
    return privateKinds.find(kind => data.projectId === privateProjectId(route.runId, kind));
  };
  const terminalPrivateError = /^(input_(proof|identity|expired|axis|bytes)|(?:piano|solo)_bundle_required|private_(run|source)|signed_|recording_combination_trial_(baseline|motion)|archive_|feedback_(source|version)|solo_phase_)/;
  async function forPrivateInput(route, kind, operation) {
    return withRunLock(route, async () => {
      await route.run.live(kind);
      try { return await operation(); } catch (error) {
        if (kind && terminalPrivateError.test(error?.message ?? '')) {
          await route.run.stop(kind);
          if (route.kind === kind) route.engine.close();
        }
        throw error;
      }
    });
  }
  const sourceOperations = new Set(['jointOpen', 'jointOpenPiano', 'jointImport', 'jointReopen']);
  function activate(route) {
    if (active !== route) {
      active.engine.close();
      active = route;
    }
  }
  return {
    closePrivateProject() {
      if (privateRoute && active === privateRoute) activate(publicRoute);
    },
    async enroll() {
      if (!requireRun) throw new Error('private_setup_unavailable');
      return enrollPrivateRun(indexedDB, release);
    },
    async proveTransfer(challenge) {
      if (!requireRun) throw new Error('private_setup_unavailable');
      return provePrivateTransfer(indexedDB, release, challenge);
    },
    async install(blob, verificationMode) {
      if (!requireRun && !verificationMode) throw new Error('private_setup_verification_only');
      const setup = await readPrivateSetup(blob, jointOptions.publicKey, release, Date.now(), {requireRun});
      const options = privateSetupEngineOptions(setup);
      if (requireRun && !globalThis.navigator?.locks) throw new Error('private_run_storage');
      let run = null;
      if (requireRun) {
        try { run = await openPrivateRun(indexedDB, setup); }
        catch (error) {
          if (error?.message === 'private_run_ended') {
            for (const kind of privateKinds) await jointStorage(indexedDB, 'expire', privateProjectId(setup.run.id, kind));
          }
          throw error;
        }
      }
      const engine = createJointEngine({ ...jointOptions, ...options,
        ...(run ? {privateRunExpires: run.expires, reserve: run.reserve} : {}) });
      const route = { engine, actions: createJointActions(engine, indexedDB), run, runId: setup.run?.id };
      activate(route);
      privateRoute = route;
      return { installed: true, expires: options.privateSourceExpiries, ...(run ? {run_id: route.runId, run_expires: run.expires} : {}) };
    },
    async end() {
      const route = privateRoute;
      if (!route?.run) throw new Error('private_setup_required');
      return withRunLock(route, async () => {
        await route.run.end();
        activate(publicRoute);
        for (const kind of privateKinds) await jointStorage(indexedDB, 'expire', privateProjectId(route.runId, kind));
        privateRoute = null;
        return route.run.report();
      });
    },
    async report() {
      return privateRoute?.run?.report() ?? null;
    },
    async dispatch(data) {
      if (data.type === 'jointClear') {
        if (requireRun) throw new Error('private_setup_project_clear');
        const result = await publicActions.dispatch(data);
        publicEngine.close();
        privateRoute?.engine.close();
        privateRoute = null;
        active = publicRoute;
        return result;
      }
      if (!privateRoute || !sourceOperations.has(data.type)) {
        if (!active.run || ['jointList', 'jointDelete'].includes(data.type)) return active.actions.dispatch(data);
        return forPrivateInput(active, active.kind, async () => {
          if (data.type === 'jointSave') {
            await active.engine.reserveSave();
            data = {...data, projectId: privateProjectId(active.runId, active.kind)};
          }
          return active.actions.dispatch(data);
        });
      }
      let route = data.type === 'jointOpen' && !data.blob ? publicRoute : privateRoute;
      if (route.run && data.type === 'jointImport') throw new Error('private_setup_project_import');
      if (route.run && data.type === 'jointReopen' && !sourceKind(route, data)) route = publicRoute;
      let result;
      try {
        result = route.run ? await forPrivateInput(route, sourceKind(route, data), () => route.actions.dispatch(data))
          : await route.actions.dispatch(data);
      } catch (error) {
        if (route !== privateRoute || error?.message !== 'private_setup_unsigned_source') throw error;
        route = publicRoute;
        result = await route.actions.dispatch(data);
      }
      if (result?.expired) route.engine.close();
      route.kind = result?.kind;
      activate(route);
      return result;
    },
  };
}

async function initialize(options) {
  verification = options.verification === true;
  verificationSdkCap = options.verificationSdkCap ?? 48;
  if (!Number.isSafeInteger(verificationSdkCap) || verificationSdkCap < 1 || verificationSdkCap > 48) {
    throw new Error('invalid_verification_budget');
  }
  const response = await fetch(new URL('./release.json', import.meta.url), { credentials: 'omit' });
  if (!response.ok) throw new Error('asset_load_failed');
  const nextManifest = await response.json();
  const jointManifest = nextManifest.joint;
  const privateSetupMode = jointManifest?.private_setup === true;
  const privateRunMode = jointManifest?.private_run === true;
  if ((privateRunMode && !privateSetupMode) || (privateSetupMode && (jointManifest.enabled !== true ||
      Object.keys(jointManifest).some(key => !['enabled', 'private_setup', 'private_run', 'source_proof_key'].includes(key))))) {
    throw new Error('private_setup_manifest');
  }
  manifest = nextManifest;
  boundedLegacyReadback = privateRunMode && verification;
  privateTrial = Boolean(manifest.joint?.private_solo_trial);
  soloMotionVerification = manifest.joint?.solo_motion_verification === true;
  if (soloMotionVerification && (privateTrial || !manifest.joint.solo_motion_baseline)) throw new Error('invalid_motion_trial');
  if (privateTrial || soloMotionVerification) verification = true;
  const loaded = {};
  for (const [name, hash] of Object.entries(PINS)) {
    if (manifest.assets?.[name]?.sha256 !== hash) throw new Error('runtime_identity');
    self.postMessage({ progress: name.startsWith('praat') ? '载入独立音高检查' : '载入声音处理引擎' });
    loaded[name] = await loadAsset(manifest.assets[name], read);
  }
  const [praatFactory, worldFactory] = await Promise.all([importVerified(manifest.assets.praat_module), importVerified(manifest.assets.world_module)]);
  const world = createWorld(await worldFactory({ wasmBinary: loaded.world_wasm, locateFile: (path) => new URL('assets/' + path, import.meta.url).href }));
  const sdk = {
    pitch: (inputBytes, inputSha256) => analyzePitch({ moduleFactory: (options) => praatFactory({ ...options, locateFile: (path) => new URL('assets/' + path, import.meta.url).href }), wasmBytes: loaded.praat_wasm,
      wasmSha256: PINS.praat_wasm, inputBytes, inputSha256 }),
    analyze: (samples) => world.analyze(samples), synthesize: (parameters) => world.synthesize(parameters),
  };
  engine = createEngine({ sdk, reserve: auditReserve, verifyLocal: (record) => verifyLocalProject(indexedDB, record) });
  let jointError = null;
  let nextPrivateSetupSession = null;
  if (manifest.joint?.enabled === true) {
    const ready = await optionalJointActions(async () => {
      const publicKey = await crypto.subtle.importKey('jwk', manifest.joint.source_proof_key,
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (privateSetupMode &&
          Object.entries(PRIVATE_QUALITY_PINS).some(([name, hash]) => manifest.assets?.[name]?.sha256 !== hash)) {
        throw new Error('private_setup_quality_identity');
      }
      const qualityModule = manifest.assets.praat_quality_module, qualityWasm = manifest.assets.praat_quality_wasm;
      const [qualityFactory, wasmBinary] = await Promise.all([importVerifiedQuality(qualityModule), loadAsset(qualityWasm, read)]);
      if (typeof qualityFactory !== 'function') throw new Error('invalid_quality_module');
      const fixedMotionTrial = privateTrial ? manifest.joint.private_solo_trial.motion : null;
      const qualityRuntime = () => qualityFactory({
        wasmBinary, locateFile: (path) => new URL('assets/' + path, import.meta.url).href,
      });
      if (fixedMotionTrial) {
        const probe = await qualityRuntime();
        if (!probe?.FS || typeof probe.issue41Initialize !== 'function' ||
            typeof probe.issue41PitchAc !== 'function' || typeof probe.issue38Quality !== 'function') {
          throw new Error('feedback_runtime_unavailable');
        }
        self.postMessage({ progress: 'Praat Worker 导出检查通过' });
      }
      const jointSdk = { ...sdk, voiceQuality: (bytes, method, interval) => measureVoiceQuality({
        moduleFactory: qualityRuntime,
        bytes, method, interval,
      }) };
      const jointOptions = { sdk: jointSdk, publicKey, fixedMotionTrial,
        soloMotionBaseline: manifest.joint.solo_motion_baseline ?? null,
        soloWaveformBaseline: manifest.joint.solo_waveform_baseline ?? null,
        soloNoiseBaseline: manifest.joint.solo_noise_baseline ?? null,
        soloNoiseV2Baseline: manifest.joint.solo_noise_v2_baseline ?? null,
        soloPhaseBaseline: manifest.joint.solo_phase_baseline ?? null,
        soloPhaseV2Baseline: manifest.joint.solo_phase_v2_baseline ?? null,
        pianoQualityBaseline: manifest.joint.piano_quality_baseline ?? null,
        pianoPhaseSources: manifest.joint.piano_phase_sources ?? [],
        pianoSignedSources: manifest.joint.piano_signed_sources ?? [],
        reserve: (event) => auditReserve(event, true) };
      const initial = createJointEngine({ ...jointOptions, ...(privateSetupMode ? { requireUnsignedSource: true } : {}) });
      if (privateSetupMode) {
        const release = manifest.release;
        nextPrivateSetupSession = publicActions => createPrivateSetupSession(initial, publicActions, jointOptions, release, privateRunMode);
      }
      return initial;
    }, indexedDB);
    joint = ready.actions;
    jointError = ready.error;
  }
  privateSetupSession = nextPrivateSetupSession?.(joint) ?? null;
  return { release: manifest.release, method: engine.id, joint: joint.available, joint_error: jointError,
    ...(privateSetupSession ? { private_setup: true, private_run: privateRunMode } : {}) };
}

self.onmessage = async ({ data }) => {
  const id = data?.id;
  if (typeof id !== 'string' || busy) { self.postMessage({ id, ok: false, error: 'processor_busy' }); return; }
  busy = true;
  const start = performance.now();
  try {
    let result;
    if (data.type === 'initialize') {
      if (engine) throw new Error('engine_already_initialized');
      result = await initialize(data);
    } else {
      if (!engine) throw new Error('engine_not_ready');
      if (privateTrial && !['jointOpen', 'jointRender', 'audit'].includes(data.type)) throw new Error('motion_trial_request');
      if (soloMotionVerification && !soloMotionOperations.has(data.type)) throw new Error('motion_trial_request');
      if (data.type === 'jointInstallPrivateSetup') {
        if (!privateSetupSession) throw new Error('private_setup_unavailable');
        result = await privateSetupSession.install(data.blob, verification);
      } else if (data.type === 'jointProvePrivateTransfer') {
        if (!privateSetupSession) throw new Error('private_setup_unavailable');
        result = await privateSetupSession.proveTransfer(data.challenge);
      } else if (data.type === 'jointEnrollPrivateRun' || data.type === 'jointEndPrivateRun' || data.type === 'jointPrivateRunReport') {
        if (!privateSetupSession) throw new Error('private_setup_unavailable');
        result = await (data.type === 'jointEnrollPrivateRun' ? privateSetupSession.enroll() :
          data.type === 'jointEndPrivateRun' ? privateSetupSession.end() : privateSetupSession.report());
      } else if (typeof data.type === 'string' && data.type.startsWith('joint')) {
        result = await (privateSetupSession ?? joint).dispatch(data);
      }
      else if (data.type === 'analyze') result = await engine.analyze(data.bytes);
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
      else if (data.type === 'audit') result = { events: await verificationEvents(), joint_events: await verificationEvents(true), current_worker_events: engine.audit(), timings, release: manifest.release };
      else throw new Error('invalid_request');
      if (data.type === 'analyze' || data.type === 'reopen' || data.type === 'import') {
        privateSetupSession?.closePrivateProject();
      }
    }
    timings.push({ operation: data.type, elapsed_ms: performance.now() - start, ok: true });
    self.postMessage({ id, ok: true, result, elapsed_ms: performance.now() - start });
  } catch (error) {
    timings.push({ operation: data.type, elapsed_ms: performance.now() - start, ok: false });
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'processing_failed',
      pianoQualification: error?.pianoQualification, elapsed_ms: performance.now() - start });
  } finally { busy = false; }
};
