// SPDX-License-Identifier: GPL-3.0-or-later
const databaseName = 'voice-private-run';
const storeName = 'authorization';
const stateKey = 'one-run';
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
async function withState(indexedDB, mode, useState, createStore) {
  const database = await openDatabase(indexedDB, createStore);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode, { durability: 'strict' });
      const store = transaction.objectStore(storeName);
      const request = store.get(stateKey);
      let result;
      let failure;
      transaction.onerror = transaction.onabort = () => reject(failure ?? storageError());
      transaction.oncomplete = () => failure ? reject(failure) : resolve(result);
      request.onsuccess = () => {
        try {
          result = useState(request.result, value => store.put(value, stateKey));
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

function validateLedger(ledger, claimHash) {
  if (ledger?.claimHash !== claimHash || typeof ledger.ended !== 'boolean' ||
      typeof ledger.stopped?.solo !== 'boolean' || typeof ledger.stopped?.piano !== 'boolean') {
    throw new Error('private_run_ledger');
  }
  for (const input of Object.keys(caps)) {
    const limits = caps[input];
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
export async function privateRunReceipt(indexedDB, release, operation, expectedRecipient) {
  if (!['report', 'end'].includes(operation)) throw new Error('private_run_event');
  if (expectedRecipient !== undefined && !isHash(expectedRecipient)) throw new Error('private_run_enrollment');
  const state = await withState(indexedDB, 'readonly', existing => validateEnrollment(existing, release, expectedRecipient ?? existing?.recipient));
  if (state.phase !== 'bound' || !isHash(state.ledger?.claimHash)) throw new Error('private_run_ledger');
  await proveEnrollment(state);
  return withState(indexedDB, operation === 'end' ? 'readwrite' : 'readonly', (existing, write) => {
    validateEnrollment(existing, release, state.recipient);
    if (existing.phase !== 'bound' || existing.ledger?.claimHash !== state.ledger.claimHash) throw new Error('private_run_ledger');
    const ledger = validateLedger(existing.ledger, existing.ledger.claimHash);
    if (operation === 'end' && !ledger.ended) write({...existing, ledger:{...ledger, ended:true}});
    return {claimHash:ledger.claimHash, ended:operation === 'end' || ledger.ended,
      stopped:{solo:ledger.stopped.solo, piano:ledger.stopped.piano},
      counts:Object.fromEntries(Object.keys(caps).map(input => [input,
        Object.fromEntries(Object.keys(caps[input]).map(kind => [kind, ledger.counts[input][kind]]))]))};
  });
}

export {keyAlgorithm, signatureAlgorithm, caps, isHash, isTime, withState, digest, fingerprint, validateEnrollment, proveEnrollment, validateLedger};
