// SPDX-License-Identifier: GPL-3.0-or-later
import {EXPLORATION_CAPS,EXPLORATION_SCHEMA,EXPLORATION_PROFILE,isSpectralHeadroomProfile,validateExplorationSetup,
  explorationProjectId,explorationArchiveBinding} from './exploration_profile.mjs';
import {expirePrivateArchive} from './archive.mjs';
const databaseName = 'voice-private-run';
const storeName = 'authorization';
const stateKey = 'one-run';
export function privateRunStateKey(release,profile) {
  if(isSpectralHeadroomProfile(profile))return JSON.stringify([stateKey,profile,release]);
  if(profile===undefined||profile===EXPLORATION_PROFILE)return stateKey;
  throw new Error('private_run_policy');
}
const keyAlgorithm = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const signatureAlgorithm = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
const hashPattern = /^[a-f0-9]{64}$/;
const fixedCaps = {
  praat: 2,
  world_analysis: 2,
  synthesize: 0,
  cpps: 6,
  hnr: 6,
  stft: 6,
  make_version: 7,
  compare: 3,
  save: 1,
  open: 2,
};
const caps = Object.freeze({
  solo: Object.freeze({ ...fixedCaps, audio_read: 150_000_000 }),
  piano: Object.freeze({ ...fixedCaps, audio_read: 500_000_000 }),
});

function isHash(value) {
  return typeof value === 'string' && hashPattern.test(value);
}

function isTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function storageError() {
  return new Error('private_run_storage');
}

function openDatabase(indexedDB, createStore) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) throw storageError();
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (typeof createStore !== 'function') {
        request.transaction.abort();
        reject(storageError());
      } else createStore(request.result);
    };
    request.onerror = request.onblocked = () => reject(storageError());
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

// Keep each read and optional write inside one transaction. The caller must await
// completion before doing work, since a successful put alone does not commit it.
async function withState(indexedDB, mode, useState, createStore, key=stateKey) {
  const database = await openDatabase(indexedDB, createStore);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode, { durability: 'strict' });
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      let result;
      let failure;
      transaction.onerror = transaction.onabort = () => reject(failure ?? storageError());
      transaction.oncomplete = () => failure ? reject(failure) : resolve(result);
      request.onsuccess = () => {
        try {
          result = useState(request.result, value => store.put(value, key));
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
    });
  } finally {
    database.close();
  }
}

async function digest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(publicKey) {
  return digest(await crypto.subtle.exportKey('raw', publicKey));
}

function validateEnrollment(state, release, recipient = state?.recipient) {
  if (state?.version !== 1 || state.release !== release || !isHash(recipient) || state.recipient !== recipient ||
      state.privateKey?.type !== 'private' || state.privateKey.extractable !== false ||
      state.privateKey.algorithm?.namedCurve !== keyAlgorithm.namedCurve ||
      state.publicKey?.type !== 'public' || state.publicKey.algorithm?.namedCurve !== keyAlgorithm.namedCurve) {
    throw new Error('private_run_enrollment');
  }
  return state;
}

async function proveEnrollment(state) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  if (await fingerprint(state.publicKey) !== state.recipient ||
      !await crypto.subtle.verify(signatureAlgorithm, state.publicKey,
        await crypto.subtle.sign(signatureAlgorithm, state.privateKey, challenge), challenge)) {
    throw new Error('private_run_enrollment');
  }
}

function ledgerCaps(ledger) {
  if(ledger?.grant===undefined)return caps;
  validateExplorationSetup(ledger.grant,'private_run_ledger');
  if(typeof ledger.grantSignature!=='string'||!(/^[a-f0-9]{128}$/).test(ledger.grantSignature))
    throw new Error('private_run_ledger');
  return EXPLORATION_CAPS;
}

function canonicalClaims(key,value) {
  if(value&&typeof value==='object'&&!Array.isArray(value))
    return Object.fromEntries(Object.keys(value).sort().map(field=>[field,value[field]]));
  return value;
}

async function verifyStoredGrant(state) {
  const {ledger}=state;
  if(ledger?.grant===undefined)return;
  ledgerCaps(ledger);
  if(ledger.grant.release!==state.release||ledger.grant.run.recipient!==state.recipient||
      await digest(new TextEncoder().encode(JSON.stringify(ledger.grant,canonicalClaims)))!==ledger.claimHash||
      !await crypto.subtle.verify(signatureAlgorithm,state.publicKey,
        Uint8Array.from(ledger.grantSignature.match(/../g),byte=>parseInt(byte,16)),
        new TextEncoder().encode('issue38-bound-grant-v3:'+ledger.claimHash)))
    throw new Error('private_run_ledger');
}

function validateLedger(ledger, claimHash) {
  if (ledger?.claimHash !== claimHash || typeof ledger.ended !== 'boolean' ||
      typeof ledger.stopped?.solo !== 'boolean' || typeof ledger.stopped?.piano !== 'boolean') {
    throw new Error('private_run_ledger');
  }
  const counterCaps=ledgerCaps(ledger);
  for (const input of Object.keys(counterCaps)) {
    const limits = counterCaps[input];
    const counts = ledger.counts?.[input];
    if (!counts || Object.keys(counts).length !== Object.keys(limits).length ||
        Object.entries(limits).some(([kind, cap]) => !Object.hasOwn(counts, kind) ||
          !Number.isSafeInteger(counts[kind]) || counts[kind] < 0 || counts[kind] > cap)) {
      throw new Error('private_run_ledger');
    }
  }
  return ledger;
}

// Recover only the already-bound metadata ledger. This does not open a run,
// consume work, restore a setup, or grant access to any source bytes.
export async function privateRunReceipt(indexedDB, release, operation, expectedRecipient,profile) {
  const key=privateRunStateKey(release,profile);
  if (!['report', 'end'].includes(operation)) throw new Error('private_run_event');
  if (expectedRecipient !== undefined && !isHash(expectedRecipient)) throw new Error('private_run_enrollment');
  const state = await withState(indexedDB, 'readonly', existing => validateEnrollment(existing, release, expectedRecipient ?? existing?.recipient),undefined,key);
  if (state.phase !== 'bound' || !isHash(state.ledger?.claimHash)) throw new Error('private_run_ledger');
  await proveEnrollment(state);
  await verifyStoredGrant(state);
  const receipt=await withState(indexedDB, operation === 'end' ? 'readwrite' : 'readonly', (existing, write) => {
    validateEnrollment(existing, release, state.recipient);
    if (existing.phase !== 'bound' || existing.ledger?.claimHash !== state.ledger.claimHash) throw new Error('private_run_ledger');
    const ledger = validateLedger(existing.ledger, existing.ledger.claimHash);
    if(JSON.stringify(ledger.grant,canonicalClaims)!==JSON.stringify(state.ledger.grant,canonicalClaims)||
      ledger.grantSignature!==state.ledger.grantSignature)throw new Error('private_run_ledger');
    const counterCaps=ledgerCaps(ledger);
    if (operation === 'end' && !ledger.ended) write({...existing, ledger:{...ledger, ended:true}});
    return {claimHash:ledger.claimHash, ended:operation === 'end' || ledger.ended,
      stopped:{solo:ledger.stopped.solo, piano:ledger.stopped.piano},
      counts:Object.fromEntries(Object.keys(counterCaps).map(input => [input,
        Object.fromEntries(Object.keys(counterCaps[input]).map(kind => [kind, ledger.counts[input][kind]]))])),
      ...(ledger.grant?.schema===EXPLORATION_SCHEMA?{profile:ledger.grant.profile,run_id:ledger.grant.run.id,
        expires:ledger.grant.run.expires}: {})};
  },undefined,key);
  if(operation!=='end'||!state.ledger.grant)return receipt;
  const grant=state.ledger.grant,flags={};
  for(const kind of ['solo','piano'])for(const role of ['seed','final']) {
    const id=explorationProjectId(grant.run.id,kind,role);
    try {flags[id]=await expirePrivateArchive(indexedDB,id,explorationArchiveBinding(grant,kind,role),grant.run.expires);}
    catch {flags[id]='unverified';}
  }
  return {...receipt,archive_cleanup:Object.values(flags).some(flag=>flag==='unverified')?'unverified':'verified',archive_flags:flags};
}

export {keyAlgorithm, signatureAlgorithm, caps, isHash, isTime, withState, digest, fingerprint, validateEnrollment, proveEnrollment, validateLedger,canonicalClaims};
