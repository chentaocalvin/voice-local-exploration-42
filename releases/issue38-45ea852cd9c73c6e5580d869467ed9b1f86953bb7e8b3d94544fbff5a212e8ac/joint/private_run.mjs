// SPDX-License-Identifier: GPL-3.0-or-later
import {keyAlgorithm, signatureAlgorithm, caps, isHash, isTime, withState, digest, fingerprint, validateEnrollment, proveEnrollment, validateLedger,canonicalClaims} from './private_run_receipt.mjs';
import {EXPLORATION_SCHEMA,EXPLORATION_CAPS,validateExplorationSetup} from './exploration_profile.mjs';
export {privateRunReceipt} from './private_run_receipt.mjs';
const maxLease = 60 * 60 * 1000;

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
  }, database => database.createObjectStore('authorization'));
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
  if(setup?.schema===EXPLORATION_SCHEMA){validateExplorationSetup(setup,'private_run_policy');return;}
  if(setup?.profile!==undefined)throw new Error('private_run_policy');
  const { release, solo, piano, run } = setup ?? {};
  if (typeof release !== 'string' || !release || typeof run?.id !== 'string' || !run.id ||
      !isHash(run.recipient) || !isHash(solo?.sourceSha256) || !isHash(piano?.voiceSha256) ||
      solo.sourceSha256 === piano.voiceSha256 || !isTime(solo.expires) || !isTime(piano.expires) ||
      !isTime(run.not_before) || !isTime(run.expires) || run.expires <= run.not_before ||
      run.expires - run.not_before > maxLease || run.expires > Math.min(solo.expires, piano.expires)) {
    throw new Error('private_run_policy');
  }
}

function checkLease(now, notBefore, expires) {
  const time = now();
  if (!isTime(time) || time < notBefore || time >= expires) throw new Error('private_run_expired');
}

function emptyCounts(input,counterCaps) {
  return Object.fromEntries(Object.keys(counterCaps[input]).map(kind => [kind, 0]));
}

// setup has already passed signed envelope verification. Its canonical digest
// binds the ledger to every claim, including the non-metered source identities.
export async function openPrivateRun(indexedDB, setup, now = Date.now) {
  validateSetup(setup);
  const exploration=setup.schema===EXPLORATION_SCHEMA;
  const counterCaps=exploration?EXPLORATION_CAPS:caps;
  const { release, solo, piano, run: { recipient, not_before: notBefore, expires } } = setup;
  const soloHash = solo.sourceSha256;
  const pianoHash = piano.voiceSha256;
  checkLease(now, notBefore, expires);
  const claimHash = await digest(new TextEncoder().encode(JSON.stringify(setup, canonicalClaims)));
  const state = await withState(indexedDB, 'readonly', existing => validateEnrollment(existing, release, recipient));
  await proveEnrollment(state);
  const grantSignature=exploration?Array.from(new Uint8Array(await crypto.subtle.sign(signatureAlgorithm,
    state.privateKey,new TextEncoder().encode('issue38-bound-grant-v3:'+claimHash))),byte=>byte.toString(16).padStart(2,'0')).join(''):null;

  const sameEnrollment = existing => validateEnrollment(existing, release, recipient);
  const sameGrant=ledger=>{
    validateLedger(ledger,claimHash);
    if(exploration?(JSON.stringify(ledger.grant,canonicalClaims)!==JSON.stringify(setup,canonicalClaims)):
      ledger.grant!==undefined)throw new Error('private_run_ledger');
    return ledger;
  };
  const active = (ledger, kind) => {
    if (ledger.ended) throw new Error('private_run_ended');
    if (kind && ledger.stopped[kind]) throw new Error('private_run_stopped');
    checkLease(now, notBefore, expires);
  };
  await withState(indexedDB, 'readwrite', (existing, write) => {
    sameEnrollment(existing);
    if (existing.phase === 'enrolled' && existing.ledger === null) {
      checkLease(now, notBefore, expires);
      const counts = { solo: emptyCounts('solo',counterCaps), piano: emptyCounts('piano',counterCaps) };
      write({ ...existing, phase: 'bound', ledger: { claimHash, ended: false, stopped: {solo:false,piano:false}, counts,
        ...(exploration?{grant:structuredClone(setup),grantSignature}:{}) } });
      return;
    }
    if (existing.phase !== 'bound') throw new Error('private_run_ledger');
    active(sameGrant(existing.ledger));
  });

  function withLedger(mode, useLedger) {
    return withState(indexedDB, mode, (existing, write) => {
      sameEnrollment(existing);
      if (existing.phase !== 'bound') throw new Error('private_run_ledger');
      const ledger = sameGrant(existing.ledger);
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
      if (!input || typeof kind !== 'string' || !Object.hasOwn(counterCaps[input], kind)) {
        throw new Error('private_run_event');
      }
      const units = kind === 'audio_read' ? samples : 1;
      if (!Number.isSafeInteger(units) || units <= 0) throw new Error('private_run_event');
      await withLedger('readwrite', (ledger, write) => {
        active(ledger, input);
        const current = ledger.counts[input][kind];
        if (units > counterCaps[input][kind] - current) throw new Error('private_run_cap');
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
