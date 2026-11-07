import assert from 'node:assert/strict';
import test from 'node:test';
import {explorationFixture} from './exploration_fixture.mjs';
import {memoryIndexedDB} from './memory_indexeddb.mjs';
import {enrollPrivateRun,openPrivateRun,privateRunReceipt} from '../../issue42/joint/private_run.mjs';
import {EXPLORATION_PROFILE,SHARED_HEADROOM_PROFILE} from '../../issue42/joint/exploration_profile.mjs';
import {appPage} from './app_fixture.mjs';

test('the visible usage action selects the current signed profile without disturbing an ended ledger',async()=>{
  const db=memoryIndexedDB(),clock={now:1000};
  const grant=(profile,release,recipient,id)=>({schema:'voice-private-setup-v3',profile,release,
    solo:{sourceSha256:'a'.repeat(64),expires:20000},
    piano:{voiceSha256:'b'.repeat(64),mixSha256:'c'.repeat(64),neutralMixSha256:'d'.repeat(64),neutralVoiceSha256:'e'.repeat(64),expires:20000},
    run:{id,recipient,not_before:1000,expires:11000}});
  const old=await enrollPrivateRun(db,'ended',EXPLORATION_PROFILE);
  const prior=await openPrivateRun(db,grant(EXPLORATION_PROFILE,'ended',old.recipient,'1'.repeat(64)),()=>1000);
  await prior.reserve({kind:'compare',input_sha256:'a'.repeat(64)});await prior.end();
  const before=await privateRunReceipt(db,'ended','report');
  const current=await enrollPrivateRun(db,'synthetic',SHARED_HEADROOM_PROFILE);
  const setup=grant(SHARED_HEADROOM_PROFILE,'synthetic',current.recipient,'2'.repeat(64));
  const active=await openPrivateRun(db,setup,()=>1000);
  await active.reserve({kind:'compare',input_sha256:'a'.repeat(64)});await active.reserve({kind:'compare',input_sha256:'a'.repeat(64)});
  const page=await appPage({autoOpen:false,db,clock,privateSetup:setup});
  try {
    await page.nodes['private-report'].onclick();
    assert.match(page.nodes['private-usage'].textContent,/2 \/ 24/);
    assert.equal(page.messages.some(message=>['jointRender','jointOpen','jointCompare','jointInstallPrivateSetup'].includes(message.type)),false);
    assert.deepEqual(await privateRunReceipt(db,'ended','report'),before);
    assert.equal((await active.report()).solo.compare,2);
  }finally{page.dispose();}
});

test('the shared limited combination explains the common allocation and leaves requested amounts visible',async()=>{
  const f=await explorationFixture('solo');f.analysis.ap.fill(.9);
  const page=await appPage({clock:{now:0},parent:{sdk:f.options.sdk},engineOptions:{...f.options,
    privateExploration:{...f.options.privateExploration,profile:'issue38-joint-shared-spectral-headroom-v1'}},inputBundle:f.solo});
  try {
    for(const [kind,amount] of [['M',.5],['Q',4],['T',9]]) {
      page.nodes['joint-kind'].value=kind;page.nodes['joint-kind'].onchange();
      page.nodes.amount.value=amount;page.nodes.amount.oninput();
    }
    await page.nodes.generate.onclick();
    assert.match(page.nodes.status.textContent,/共同/);
    assert.match(page.nodes.status.textContent,/实际/);
    const result=page.workers[0].engine.current().available.at(-1);
    assert.equal(result.spectral_delta_scales.Q,result.spectral_delta_scales.T);
    assert.ok(result.spectral_delta_scales.Q<1);
    assert.equal(result.control.intents.find(item=>item.kind==='Q').amount,4);
    assert.equal(result.control.intents.find(item=>item.kind==='T').amount,9);
  }finally{page.dispose();}
});
