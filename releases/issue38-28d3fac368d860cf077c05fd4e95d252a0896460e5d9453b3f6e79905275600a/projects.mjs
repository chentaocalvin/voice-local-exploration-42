import { sha256 } from './identity.mjs';

const SCHEMA = 'voice-local-project-v1';
const MAX_BYTES = 256 * 1024 * 1024, HEADER_LIMIT = 1024 * 1024, WAV_LIMIT = 8 * 1024 * 1024;
const MAGIC = new TextEncoder().encode('ISS42P01');
const HASH = /^[0-9a-f]{64}$/;
const RECORD_KEYS = 'control,draft_control,engine_id,input,input_sha256,listening,parent,parent_sha256,result,result_sha256,schema';
const HEADER_KEYS = 'control,draft_control,engine_id,input_length,input_sha256,listening,parent_length,parent_sha256,result_length,result_sha256,schema';
const LOCAL_KEYS = 'control,draft_control,engine_id,input,input_sha256,listening,local_id,local_seal,parent,parent_sha256,result,result_sha256,schema';
const DB = 'voice-local-projects-v1', STORE = 'projects', META = 'origin';

function keys(value, expected, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== expected) throw new Error(reason);
}

function bytesCopy(value, maximum, copy = true) {
  if (!(value instanceof Uint8Array) || Object.prototype.toString.call(value.buffer) !== '[object ArrayBuffer]' ||
      !value.byteLength || value.byteLength > maximum) throw new Error('invalid_project_bytes');
  return copy ? new Uint8Array(value) : value;
}

function wavFrames(bytes, bits) {
  if (bytes.length < 44 || bytes.length > WAV_LIMIT) throw new Error('invalid_project_wav');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (position, length) => String.fromCharCode(...bytes.subarray(position, position + length));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) throw new Error('invalid_project_wav');
  let position = 12, format = false, frames = null;
  while (position + 8 <= bytes.length) {
    const name = text(position, 4), size = view.getUint32(position + 4, true), start = position + 8;
    if (start + size + size % 2 > bytes.length) throw new Error('invalid_project_wav');
    if (name === 'fmt ') {
      if (format || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
          view.getUint32(start + 4, true) !== 44100 || view.getUint32(start + 8, true) !== 44100 * bits / 8 ||
          view.getUint16(start + 12, true) !== bits / 8 || view.getUint16(start + 14, true) !== bits) throw new Error('invalid_project_wav');
      format = true;
    }
    if (name === 'data') {
      if (frames !== null || !size || size % (bits / 8)) throw new Error('invalid_project_wav');
      frames = size / (bits / 8);
    }
    position = start + size + size % 2;
  }
  if (!format || !frames || frames > 45 * 44100 || position !== bytes.length) throw new Error('invalid_project_wav');
  return frames;
}

function controlCopy(control, frames) {
  keys(control, 'amount,end_frame,mode,start_frame', 'invalid_control');
  if (!Number.isSafeInteger(control.start_frame) || !Number.isSafeInteger(control.end_frame) || control.start_frame < 0 ||
      control.end_frame <= control.start_frame || control.end_frame > frames || typeof control.amount !== 'number' ||
      !Number.isFinite(control.amount) || control.amount < -6 || control.amount > 6 || !['flat', 'front', 'back'].includes(control.mode)) throw new Error('invalid_control');
  return { start_frame: control.start_frame, end_frame: control.end_frame, amount: control.amount, mode: control.mode };
}

function listeningCopy(listening, duration) {
  keys(listening, 'end,mode,selected,start', 'invalid_listening');
  if (typeof listening.start !== 'number' || typeof listening.end !== 'number' || !Number.isFinite(listening.start) ||
      !Number.isFinite(listening.end) || listening.start < 0 || listening.end <= listening.start || listening.end > duration ||
      !['local', 'whole'].includes(listening.mode) || !['O', 'U', 'E'].includes(listening.selected)) throw new Error('invalid_listening');
  return { start: listening.start, end: listening.end, mode: listening.mode, selected: listening.selected };
}

function header(project) {
  return { schema: project.schema, engine_id: project.engine_id, input_sha256: project.input_sha256,
    result_sha256: project.result_sha256, parent_sha256: project.parent_sha256, control: project.control,
    draft_control: project.draft_control, listening: project.listening,
    input_length: project.input.length, result_length: project.result.length, parent_length: project.parent.length };
}

async function makeProjectRecord({ inputBytes, resultBytes, parentBytes, inputSha256, resultSha256, parentSha256,
  engineId, control, draftControl, listening },copy=true) {
  if (typeof engineId !== 'string' || !engineId.length || engineId.length > 256 ||
      ![inputSha256, resultSha256, parentSha256].every((value) => typeof value === 'string' && HASH.test(value))) throw new Error('invalid_project_identity');
  if ((inputBytes?.byteLength ?? MAX_BYTES) + (resultBytes?.byteLength ?? MAX_BYTES) + (parentBytes?.byteLength ?? MAX_BYTES) > MAX_BYTES) throw new Error('project_limit');
  const input = bytesCopy(inputBytes, WAV_LIMIT,copy), result = bytesCopy(resultBytes, WAV_LIMIT,copy), parent = bytesCopy(parentBytes, MAX_BYTES,copy);
  const samples = wavFrames(input, 16), frames = Math.floor(1000 * samples / 44100 / 5) + 1;
  if (wavFrames(result, 32) !== samples) throw new Error('project_sample_mismatch');
  const project = { schema: SCHEMA, engine_id: engineId, input_sha256: inputSha256, result_sha256: resultSha256, parent_sha256: parentSha256,
    control: controlCopy(control, frames), draft_control: controlCopy(draftControl, frames),
    listening: listeningCopy(listening, samples / 44100), input, result, parent };
  const length = new TextEncoder().encode(JSON.stringify(header(project))).length;
  if (length > HEADER_LIMIT || 12 + length + input.length + result.length + parent.length > MAX_BYTES) throw new Error('project_limit');
  if (await sha256(input) !== inputSha256 || await sha256(result) !== resultSha256 || await sha256(parent) !== parentSha256) throw new Error('project_identity_mismatch');
  return project;
}

export function makeProject(snapshot) {return makeProjectRecord(snapshot);}

function validate(project,copy=true) {
  const local = project && Object.prototype.hasOwnProperty.call(project, 'local_seal');
  keys(project, local ? LOCAL_KEYS : RECORD_KEYS, 'invalid_project');
  if (project.schema !== SCHEMA) throw new Error('invalid_project');
  return makeProjectRecord({ inputBytes: project.input, resultBytes: project.result, parentBytes: project.parent,
    inputSha256: project.input_sha256, resultSha256: project.result_sha256, parentSha256: project.parent_sha256,
    engineId: project.engine_id, control: project.control, draftControl: project.draft_control, listening: project.listening },copy);
}

function projectId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 128 || /[\u0000-\u001f]/.test(id)) throw new Error('invalid_project_id');
  return id;
}

function openDB(indexedDB) {
  if (!indexedDB || typeof indexedDB.open !== 'function') throw new Error('storage_unavailable');
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(META)) request.result.createObjectStore(META);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => { settled = true; reject(request.error || new Error('storage_open_failed')); };
    request.onblocked = () => { settled = true; reject(new Error('storage_blocked')); };
  });
}

function transaction(db, names, mode, operation) {
  return new Promise((resolve, reject) => {
    let value;
    const tx = db.transaction(names, mode);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('storage_failed'));
    tx.onabort = () => reject(tx.error || new Error('storage_aborted'));
    try { operation(tx, (result) => { value = result; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

function read(db, store, id) {
  return transaction(db, [store], 'readonly', (tx, done) => {
    const request = tx.objectStore(store).get(id);
    request.onsuccess = () => done(request.result);
  });
}

async function originKey(db, create) {
  let key = await read(db, META, 'hmac');
  if (!key && create) {
    const generated = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    key = await transaction(db, [META], 'readwrite', (tx, done) => {
      const store = tx.objectStore(META), request = store.get('hmac');
      request.onsuccess = () => {
        if (request.result) done(request.result);
        else { store.put(generated, 'hmac'); done(generated); }
      };
    });
  }
  if (!key) throw new Error('project_not_local');
  if (key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'HMAC' ||
      key.algorithm?.hash?.name !== 'SHA-256' || !key.usages?.includes('verify') || !key.usages?.includes('sign')) throw new Error('invalid_origin_key');
  return key;
}

function sealMessage(project, id) {
  return new TextEncoder().encode(JSON.stringify({ local_id: id, project: header(project) }));
}

function ownedSealMessage(project,id) {
  return new TextEncoder().encode(JSON.stringify({purpose:'engine-owned-project-v1',local_id:id,project:header(project)}));
}

export async function saveProject(indexedDB, id, record, authorizeSnapshot) {
  projectId(id);
  if (typeof authorizeSnapshot !== 'function') throw new Error('snapshot_not_issued');
  const project = await validate(record);
  if (await authorizeSnapshot(project) !== true) throw new Error('snapshot_not_issued');
  const db = await openDB(indexedDB);
  try {
    const key = await originKey(db, true);
    const seal = new Uint8Array(await crypto.subtle.sign('HMAC', key, sealMessage(project, id)));
    const signed = { ...project, local_id: id, local_seal: seal };
    await transaction(db, [STORE, META], 'readwrite', (tx) => {
      tx.objectStore(STORE).put(signed, id);
      tx.objectStore(META).put(seal, 'proof:' + id);
    });
    return signed;
  } finally { db.close(); }
}

async function verifyProject(indexedDB, record,copy=true) {
  keys(record, LOCAL_KEYS, 'project_not_local');
  const id = projectId(record.local_id), seal = bytesCopy(record.local_seal, 32);
  if (seal.length !== 32) throw new Error('project_not_local');
  const project = await validate(record,copy), db = await openDB(indexedDB);
  try {
    const key = await originKey(db, false);
    const current = await read(db, META, 'proof:' + id);
    if (!(current instanceof Uint8Array) || current.length !== seal.length || !current.every((value, index) => value === seal[index])) throw new Error('project_not_local');
    if (!await crypto.subtle.verify('HMAC', key, seal, sealMessage(project, id))) throw new Error('project_local_identity_mismatch');
    return { ...project, local_id: id, local_seal: seal };
  } finally { db.close(); }
}

export function verifyLocalProject(indexedDB,record) {return verifyProject(indexedDB,record);}

// The factory is wired inside createEngine. Its public save/load interface never
// accepts or returns a mutable project record; capture owns every source buffer,
// while a loaded record is the database's private structured clone. The ordinary
// external record APIs above retain their defensive copies and authorization.
export function createEngineProjectPersistence(indexedDB,{capture,restore}) {
  if(typeof capture!=='function'||typeof restore!=='function')throw new Error('invalid_project_owner');
  return {
    async save(id,view) {
      projectId(id);
      const {snapshot,assertCurrent}=await capture(view);
      const project=await makeProjectRecord(snapshot,false);
      assertCurrent();
      const db=await openDB(indexedDB);
      try {
        const key=await originKey(db,true);
        const seal=new Uint8Array(await crypto.subtle.sign('HMAC',key,sealMessage(project,id)));
        const ownedSeal=new Uint8Array(await crypto.subtle.sign('HMAC',key,ownedSealMessage(project,id)));
        assertCurrent();
        await transaction(db,[STORE,META],'readwrite',tx=>{
          assertCurrent();
          const request=tx.objectStore(STORE).put({...project,local_id:id,local_seal:seal},id);
          request.onsuccess=()=>{try{assertCurrent();}catch{tx.abort();}};
          tx.objectStore(META).put(seal,'proof:'+id);
          tx.objectStore(META).put(ownedSeal,'owned-proof:'+id);
        });
        return {id};
      }finally{db.close();}
    },
    async reopen(id,token) {
      projectId(id);const db=await openDB(indexedDB);let record;
      try{record=await read(db,STORE,id);}finally{db.close();}
      if(!record)throw new Error('project_missing');
      if(record.local_id!==id)throw new Error('project_local_identity_mismatch');
      const verified=await verifyProject(indexedDB,record,false),origin=await openDB(indexedDB);
      try {
        const key=await originKey(origin,false),proof=await read(origin,META,'owned-proof:'+id);
        if(!(proof instanceof Uint8Array)||proof.length!==32||
          !await crypto.subtle.verify('HMAC',key,proof,ownedSealMessage(verified,id)))throw new Error('project_not_engine_owned');
      }finally{origin.close();}
      return restore(verified,token);
    },
  };
}

export async function reopenProject(indexedDB, id) {
  projectId(id);
  const db = await openDB(indexedDB);
  let record;
  try { record = await read(db, STORE, id); } finally { db.close(); }
  if (!record) throw new Error('project_missing');
  if (record.local_id !== id) throw new Error('project_local_identity_mismatch');
  return verifyLocalProject(indexedDB, record);
}

export async function listProjects(indexedDB) {
  const db = await openDB(indexedDB);
  try {
    const ids = await transaction(db, [STORE], 'readonly', (tx, done) => {
      const request = tx.objectStore(STORE).getAllKeys();
      request.onsuccess = () => done(request.result);
    });
    return ids.map(projectId).sort();
  } finally { db.close(); }
}

export async function deleteProject(indexedDB, id) {
  projectId(id);
  const db = await openDB(indexedDB);
  try {
    await transaction(db, [STORE, META], 'readwrite', (tx) => {
      tx.objectStore(STORE).delete(id);
      tx.objectStore(META).delete('proof:' + id);
      tx.objectStore(META).delete('owned-proof:' + id);
    });
  }
  finally { db.close(); }
}

export async function deleteAllProjects(indexedDB) {
  const db = await openDB(indexedDB);
  try {
    await transaction(db, [STORE, META], 'readwrite', (tx) => {
      tx.objectStore(STORE).clear();
      tx.objectStore(META).clear();
    });
  } finally { db.close(); }
}

export async function exportProject(record) {
  const project = await validate(record), text = new TextEncoder().encode(JSON.stringify(header(project)));
  const prefix = new Uint8Array(12); prefix.set(MAGIC); new DataView(prefix.buffer).setUint32(8, text.length, true);
  return new Blob([prefix, text, project.input, project.result, project.parent], { type: 'application/octet-stream' });
}

export async function importProject(blob) {
  if (!(blob instanceof Blob) || blob.size < 13 || blob.size > MAX_BYTES) throw new Error('invalid_project_export');
  const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (!MAGIC.every((value, index) => prefix[index] === value)) throw new Error('invalid_project_export');
  const length = new DataView(prefix.buffer).getUint32(8, true);
  if (!length || length > HEADER_LIMIT || 12 + length > blob.size) throw new Error('invalid_project_export');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blob.slice(12, 12 + length).arrayBuffer())); }
  catch { throw new Error('invalid_project_export'); }
  keys(parsed, HEADER_KEYS, 'invalid_project_export');
  if (parsed.schema !== SCHEMA || ![parsed.input_length, parsed.result_length, parsed.parent_length].every((value) => Number.isSafeInteger(value) && value > 0) ||
      12 + length + parsed.input_length + parsed.result_length + parsed.parent_length !== blob.size) throw new Error('invalid_project_export');
  let offset = 12 + length;
  const input = new Uint8Array(await blob.slice(offset, offset += parsed.input_length).arrayBuffer());
  const result = new Uint8Array(await blob.slice(offset, offset += parsed.result_length).arrayBuffer());
  const parent = new Uint8Array(await blob.slice(offset).arrayBuffer());
  return makeProject({ inputBytes: input, resultBytes: result, parentBytes: parent,
    inputSha256: parsed.input_sha256, resultSha256: parsed.result_sha256, parentSha256: parsed.parent_sha256,
    engineId: parsed.engine_id, control: parsed.control, draftControl: parsed.draft_control, listening: parsed.listening });
}
