import assert from 'node:assert/strict';
import test from 'node:test';
import {enrollPrivateRun,provePrivateTransfer,openPrivateRun,privateRunReceipt} from '../../issue42/joint/private_run.mjs';
import {HEADROOM_PROFILE,EXPLORATION_PROFILE} from '../../issue42/joint/exploration_profile.mjs';
import {memoryIndexedDB} from './memory_indexeddb.mjs';

test('a new headroom enrollment, proof and cold ledger preserve an ended legacy run in the same browser',async()=>{
  const db=memoryIndexedDB(),start=Date.parse('2026-11-07T13:00:00Z');
  const setup=(release,profile,recipient,id)=>({schema:'voice-private-setup-v3',profile,release,
    solo:{sourceSha256:'a'.repeat(64),expires:start+7_200_000},
    piano:{voiceSha256:'b'.repeat(64),mixSha256:'c'.repeat(64),neutralMixSha256:'d'.repeat(64),neutralVoiceSha256:'e'.repeat(64),expires:start+7_200_000},
    run:{id,recipient,not_before:start,expires:start+7_200_000}});
  const prior=await enrollPrivateRun(db,'prior');
  const old=await openPrivateRun(db,setup('prior',EXPLORATION_PROFILE,prior.recipient,'1'.repeat(64)),()=>start);
  await old.reserve({kind:'make_version',input_sha256:'a'.repeat(64)});await old.end();
  const ended=await privateRunReceipt(db,'prior','report');
  const next=await enrollPrivateRun(db,'new',HEADROOM_PROFILE);
  assert.notEqual(next.recipient,prior.recipient);
  const proof=await provePrivateTransfer(db,'new','2'.repeat(64),HEADROOM_PROFILE);
  assert.match(proof.public_key,/^04[0-9a-f]{128}$/);assert.match(proof.signature,/^[0-9a-f]{128}$/);
  const claims=setup('new',HEADROOM_PROFILE,next.recipient,'3'.repeat(64));
  const run=await openPrivateRun(db,claims,()=>start);
  await run.reserve({kind:'make_version',input_sha256:'a'.repeat(64)});
  const cold=await openPrivateRun(db,claims,()=>start+1);
  assert.equal((await cold.report()).solo.make_version,1);
  assert.deepEqual(await privateRunReceipt(db,'prior','report'),ended);
  const receipt=await privateRunReceipt(db,'new','end',next.recipient,HEADROOM_PROFILE);
  assert.equal(receipt.ended,true);assert.equal(receipt.counts.solo.make_version,1);
  await assert.rejects(enrollPrivateRun(db,'new',HEADROOM_PROFILE),/private_run_already_used/);
  await assert.rejects(provePrivateTransfer(db,'new','2'.repeat(64),HEADROOM_PROFILE),/private_run_already_used/);
  await assert.rejects(openPrivateRun(db,claims,()=>start+2),/private_run_ended/);
  assert.deepEqual(await privateRunReceipt(db,'prior','report'),ended);
  await assert.rejects(enrollPrivateRun(db,'new','unknown'),/private_run_policy/);
});
