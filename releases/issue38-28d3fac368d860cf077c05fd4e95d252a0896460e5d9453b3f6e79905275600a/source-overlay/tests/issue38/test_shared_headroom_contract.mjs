import assert from 'node:assert/strict';
import test from 'node:test';
import {EXPLORATION_PROFILE,HEADROOM_PROFILE,SHARED_HEADROOM_PROFILE} from '../../issue42/joint/exploration_profile.mjs';
import {enrollPrivateRun,openPrivateRun,provePrivateTransfer,privateRunReceipt} from '../../issue42/joint/private_run.mjs';
import {readPrivateSetup} from '../../issue42/joint/private_setup.mjs';
import {reservePublicProbe,closePublicProbe,publicProbeReport} from '../../issue42/joint/public_probe.mjs';
import {memoryIndexedDB} from './memory_indexeddb.mjs';

const start=Date.parse('2026-11-07T13:00:00Z');
const claims=(release,profile,recipient,id)=>({schema:'voice-private-setup-v3',profile,release,
  solo:{sourceSha256:'a'.repeat(64),expires:start+7200000},
  piano:{voiceSha256:'b'.repeat(64),mixSha256:'c'.repeat(64),neutralMixSha256:'d'.repeat(64),neutralVoiceSha256:'e'.repeat(64),expires:start+7200000},
  run:{id,recipient,not_before:start,expires:start+7200000}});

test('the shared signed domain survives cold reporting while both ended private domains remain unchanged',async()=>{
  const db=memoryIndexedDB(),old=[];
  for(const [release,profile,id] of [['old',EXPLORATION_PROFILE,'1'],['spectral',HEADROOM_PROFILE,'2']]) {
    const {recipient}=await enrollPrivateRun(db,release,profile);
    const run=await openPrivateRun(db,claims(release,profile,recipient,id.repeat(64)),()=>start);
    await run.reserve({kind:'make_version',input_sha256:'a'.repeat(64)});await run.end();
    old.push({release,profile,receipt:await privateRunReceipt(db,release,'report',recipient,profile)});
  }
  const profile=SHARED_HEADROOM_PROFILE,release='shared',{recipient}=await enrollPrivateRun(db,release,profile);
  const setup=claims(release,profile,recipient,'3'.repeat(64));
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const payload=new TextEncoder().encode(JSON.stringify(setup));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,payload);
  const blob=new Blob([JSON.stringify({payload:Buffer.from(payload).toString('base64url'),signature:Buffer.from(signature).toString('base64url')})]);
  assert.deepEqual(await readPrivateSetup(blob,key.publicKey,release,start,{requireRun:true,expectedProfile:profile}),setup);
  for(const expectedProfile of [HEADROOM_PROFILE,EXPLORATION_PROFILE,undefined])
    await assert.rejects(readPrivateSetup(blob,key.publicKey,release,start,{requireRun:true,expectedProfile}),/private_setup_policy/);
  const proof=await provePrivateTransfer(db,release,'4'.repeat(64),profile);
  assert.match(proof.public_key,/^04[0-9a-f]{128}$/);
  const run=await openPrivateRun(db,setup,()=>start);
  await run.reserve({kind:'make_version',input_sha256:'a'.repeat(64)});
  assert.equal((await (await openPrivateRun(db,setup,()=>start+1)).report()).solo.make_version,1);
  const ended=await privateRunReceipt(db,release,'end',recipient,profile);
  assert.equal(ended.ended,true);assert.equal(ended.profile,profile);assert.equal(ended.counts.solo.make_version,1);
  await assert.rejects(enrollPrivateRun(db,release,profile),/private_run_already_used/);
  for(const record of old)assert.deepEqual(await privateRunReceipt(db,record.release,'report',undefined,record.profile),record.receipt);
});

test('the new anonymous prerequisite is separate from both already closed ledgers',async()=>{
  const db=memoryIndexedDB(),old=[];
  for(const [release,profile] of [['old',undefined],['spectral',HEADROOM_PROFILE]]) {
    for(const event of [{kind:'analyze'},{kind:'render'},{kind:'save',project_id:release},{kind:'reopen',project_id:release}])
      await reservePublicProbe(db,release,event,profile);
    await closePublicProbe(db,release,profile);
    old.push({release,profile,receipt:await publicProbeReport(db,release,profile)});
  }
  await reservePublicProbe(db,'shared',{kind:'analyze'},SHARED_HEADROOM_PROFILE);
  assert.equal((await publicProbeReport(db,'shared',SHARED_HEADROOM_PROFILE)).counts.analyze,1);
  await assert.rejects(reservePublicProbe(db,'shared',{kind:'analyze'},SHARED_HEADROOM_PROFILE),/public_probe_cap/);
  for(const record of old)assert.deepEqual(await publicProbeReport(db,record.release,record.profile),record.receipt);
  await assert.rejects(publicProbeReport(db,'shared','unknown'),/public_probe_profile/);
});
