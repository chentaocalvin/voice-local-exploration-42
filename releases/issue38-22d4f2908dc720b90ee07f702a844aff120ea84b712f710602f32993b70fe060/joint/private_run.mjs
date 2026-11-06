// SPDX-License-Identifier: GPL-3.0-or-later
const databaseName = 'voice-private-run';
const storeName = 'authorization';
const stateKey = 'one-run';
const keyAlgorithm = { name: 'ECDSA', namedCurve: 'P-256' };
const signatureAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
const maxLease = 60 * 60 * 1000;
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
const caps = {
  solo: { ...fixedCaps, audio_read: 150_000_000 },
  piano: { ...fixedCaps, audio_read: 500_000_000 },
};

function isHash(value) {
  return typeof value === 'string' && hashPattern.test(value);
}

function isTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function storageError() {
  return new Error('private_run_storage');
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) throw storageError();
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = request.onblocked = () => reject(storageError());
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

// Keep each read and optional write inside one transaction. The caller must await
// completion before doing work, since a successful put alone does not commit it.
async function withState(indexedDB, mode, useState) {
  const database = await openDatabase(indexedDB);
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

export async function enrollPrivateRun(indexedDB, release) {
  if (typeof release !== 'string' || !release) throw new Error('private_run_release');
  const { privateKey, publicKey } = await crypto.subtle.generateKey(keyAlgorithm, false, ['sign', 'verify']);
  const candidate = {
    version: 1, release, privateKey, publicKey, recipient: await fingerprint(publicKey),
    phase: 'enrolled', ledger: null,
  };
  const state = await withState(indexedDB, 'readwrite', (existing, write) => {
    if (existing === undefined) {
      write(candidate);
      return candidate;
    }
    validateEnrollment(existing, release);
    if (existing.phase !== 'enrolled' || existing.ledger !== null) throw new Error('private_run_already_used');
    return existing;
  });
  await proveEnrollment(state);
  return { recipient: state.recipient };
}

export async function provePrivateTransfer(indexedDB, release, challenge) {
  if (!isHash(challenge)) throw new Error('private_transfer_challenge');
  const enrollment = await withState(indexedDB, 'readonly', state => validateEnrollment(state, release));
  if (enrollment.phase !== 'enrolled' || enrollment.ledger !== null) throw new Error('private_run_already_used');
  const payload = new TextEncoder().encode('issue38-private-transfer-v1:' + challenge);
  const publicKey = await crypto.subtle.exportKey('raw', enrollment.publicKey);
  const signature = await crypto.subtle.sign(signatureAlgorithm, enrollment.privateKey, payload);
  const hex = (value) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
  return {public_key: hex(publicKey), signature: hex(signature)};
}

function validateSetup(setup) {
  const { release, solo, piano, run } = setup ?? {};
  if (typeof release !== 'string' || !release || typeof run?.id !== 'string' || !run.id ||
      !isHash(run.recipient) || !isHash(solo?.sourceSha256) || !isHash(piano?.voiceSha256) ||
      solo.sourceSha256 === piano.voiceSha256 || !isTime(solo.expires) || !isTime(piano.expires) ||
      !isTime(run.not_before) || !isTime(run.expires) || run.expires <= run.not_before ||
      run.expires - run.not_before > maxLease || run.expires > Math.min(solo.expires, piano.expires)) {
    throw new Error('private_run_policy');
  }
}

function canonicalClaims(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(field => [field, value[field]]));
  }
  return value;
}

function checkLease(now, notBefore, expires) {
  const time = now();
  if (!isTime(time) || time < notBefore || time >= expires) throw new Error('private_run_expired');
}

function emptyCounts(input) {
  return Object.fromEntries(Object.keys(caps[input]).map(kind => [kind, 0]));
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

// setup has already passed signed envelope verification. Its canonical digest
// binds the ledger to every claim, including the non-metered source identities.
export async function openPrivateRun(indexedDB, setup, now = Date.now) {
  validateSetup(setup);
  const { release, solo, piano, run: { recipient, not_before: notBefore, expires } } = setup;
  const soloHash = solo.sourceSha256;
  const pianoHash = piano.voiceSha256;
  checkLease(now, notBefore, expires);
  const claimHash = await digest(new TextEncoder().encode(JSON.stringify(setup, canonicalClaims)));
  const state = await withState(indexedDB, 'readonly', existing => validateEnrollment(existing, release, recipient));
  await proveEnrollment(state);

  const sameEnrollment = existing => validateEnrollment(existing, release, recipient);
  const active = (ledger, kind) => {
    if (ledger.ended) throw new Error('private_run_ended');
    if (kind && ledger.stopped[kind]) throw new Error('private_run_stopped');
    checkLease(now, notBefore, expires);
  };
  await withState(indexedDB, 'readwrite', (existing, write) => {
    sameEnrollment(existing);
    if (existing.phase === 'enrolled' && existing.ledger === null) {
      checkLease(now, notBefore, expires);
      const counts = { solo: emptyCounts('solo'), piano: emptyCounts('piano') };
      write({ ...existing, phase: 'bound', ledger: { claimHash, ended: false, stopped: {solo:false,piano:false}, counts } });
      return;
    }
    if (existing.phase !== 'bound') throw new Error('private_run_ledger');
    active(validateLedger(existing.ledger, claimHash));
  });

  function withLedger(mode, useLedger) {
    return withState(indexedDB, mode, (existing, write) => {
      sameEnrollment(existing);
      if (existing.phase !== 'bound') throw new Error('private_run_ledger');
      const ledger = validateLedger(existing.ledger, claimHash);
      return useLedger(ledger, value => write({ ...existing, ledger: value }));
    });
  }

  return {
    expires,
    live: (kind) => withLedger('readonly', ledger => {
      active(ledger, kind);
      return true;
    }),
    async reserve({ kind, input_sha256: inputHash, samples } = {}) {
      const input = inputHash === soloHash ? 'solo' : inputHash === pianoHash ? 'piano' : null;
      if (!input || typeof kind !== 'string' || !Object.hasOwn(caps[input], kind)) {
        throw new Error('private_run_event');
      }
      const units = kind === 'audio_read' ? samples : 1;
      if (!Number.isSafeInteger(units) || units <= 0) throw new Error('private_run_event');
      await withLedger('readwrite', (ledger, write) => {
        active(ledger, input);
        const current = ledger.counts[input][kind];
        if (units > caps[input][kind] - current) throw new Error('private_run_cap');
        ledger.counts[input][kind] = current + units;
        write(ledger);
      });
    },
    report: () => withLedger('readonly', ledger => ledger.counts),
    stop: (kind) => withLedger('readwrite', (ledger, write) => {
      if (!Object.hasOwn(caps, kind)) throw new Error('private_run_event');
      if (!ledger.stopped[kind]) write({...ledger, stopped: {...ledger.stopped, [kind]: true}});
    }),
    end: () => withLedger('readwrite', (ledger, write) => {
      if (!ledger.ended) write({ ...ledger, ended: true });
    }),
  };
}
