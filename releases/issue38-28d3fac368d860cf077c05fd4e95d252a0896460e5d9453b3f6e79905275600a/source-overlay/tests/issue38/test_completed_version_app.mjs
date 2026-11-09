// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {appPage} from './app_fixture.mjs';
import {explorationFixture} from './exploration_fixture.mjs';
import {SHARED_HEADROOM_PROFILE} from '../../issue42/joint/exploration_profile.mjs';
import {exportJointArchive} from '../../issue42/joint/archive.mjs';

async function openSignedSolo(page,input) {
  const file=await exportJointArchive({input,view:{kind:'solo_input'}});
  file.name='synthetic.wav';page.nodes['joint-solo-file'].files=[file];
  page.nodes['joint-solo-file'].onchange();
  const deadline=performance.now()+15000;
  while(performance.now()<deadline) {
    const status=page.nodes.status.textContent;
    if(status.includes('独唱已就绪')&&!page.nodes.generate.disabled)return;
    if(/未完成|未通过|不一致|用尽|已停止|过期/.test(status))
      throw new Error('completed_version_open_failed: '+status);
    await delay(10);
  }
  throw new Error('completed_version_open_timeout: '+JSON.stringify({status:page.nodes.status.textContent,
    generateDisabled:page.nodes.generate.disabled,recentRequests:page.messages.slice(-4).map(item=>item.type),
    processingMayRemain:true}));
}

async function sharedPage({ending=false}={}) {
  const fixture=await explorationFixture('solo'),clock={now:1000};
  fixture.clock(clock.now);
  const page=await appPage({autoOpen:false,clock,parent:{sdk:fixture.options.sdk},
    engineOptions:{...fixture.options,privateExploration:{...fixture.options.privateExploration,profile:SHARED_HEADROOM_PROFILE}},
    ...(ending?{usage:{counts:{solo:{},piano:{}}}}:{})});
  for(const role of ['O','U','E']) page.nodes['hear-'+role].classList.remove=()=>{};
  try {await openSignedSolo(page,fixture.input);}
  catch(error) {
    page.dispose();
    throw new Error(error.message+'; fixture teardown requested, pending shutdown not established',{cause:error});
  }
  return {page,clock,fixture};
}

function paidRequests(page) {
  return page.messages.filter(message=>['jointRender','jointCompare','jointSave'].includes(message.type));
}

async function exportedCurrent(page) {
  const before=page.downloads.length;
  await page.nodes.export.onclick();
  assert.equal(page.downloads.length,before+1);
  return JSON.parse(await page.downloads.at(-1).blob.text());
}

async function generateT(page,amount,mode='flat') {
  page.nodes.development.value=mode;page.nodes.development.onchange();
  page.nodes.amount.value=amount;page.nodes.amount.oninput();
  await page.nodes.generate.onclick();
}

test('shared second render keeps old E; explicit latest choice drives normal export and comparison without paid selection',async()=>{
  const {page}=await sharedPage();
  try {
    await generateT(page,3);
    const first=await exportedCurrent(page);
    await generateT(page,6,'front');
    const latestId=page.nodes.history.options.at(-1).value;
    assert.notEqual(latestId,first.selected);
    assert.equal(page.nodes.history.value,first.selected);
    assert.equal((await exportedCurrent(page)).selected,first.selected);
    assert.equal(page.nodes['choose-latest'].hidden,false);
    assert.equal(page.nodes['choose-latest'].disabled,false);
    const before=paidRequests(page).length;
    page.nodes['choose-latest'].onclick();
    assert.equal(paidRequests(page).length,before);
    assert.equal(page.nodes.history.value,latestId);
    const selected=await exportedCurrent(page);
    const control={intents:[{kind:'T',start_frame:100,end_frame:1500,amount:6,mode:'front',held:false}],preserve:[]};
    assert.equal(selected.selected,latestId);
    assert.deepEqual(selected.resultControl,control);
    assert.match(page.nodes.heard.textContent,/正在聆听的完成版本/);
    assert.match(page.nodes.history.options.at(-1).textContent,/前半展开 · 0\.500–7\.500秒/);
    await page.nodes['joint-compare'].onclick();
    const compared=page.messages.findLast(message=>message.type==='jointCompare');
    assert.equal(compared.scope.right,latestId);
    assert.equal(compared.scope.right_sha256,selected.digest);
    assert.deepEqual(compared.scope.interval,[22050,330750]);
    assert.equal(paidRequests(page).length,before+1);
  }finally{page.dispose();}
});

test('busy latest choice cannot replace current E and adopting another input resets latest',async()=>{
  const {page,fixture}=await sharedPage();
  try {
    await generateT(page,3);
    const selected=await exportedCurrent(page);
    page.nodes.amount.value=6;page.nodes.amount.oninput();
    const pending=page.nodes.generate.onclick();
    assert.equal(page.nodes['choose-latest'].disabled,true);
    page.nodes['choose-latest'].onclick();
    await pending;
    assert.equal((await exportedCurrent(page)).selected,selected.selected);
    await openSignedSolo(page,fixture.input);
    assert.equal(page.nodes['choose-latest'].disabled,true);
  }finally{page.dispose();}
});

test('expired exploration cannot select latest or issue new paid requests',async()=>{
  const {page,clock,fixture}=await sharedPage();
  try {
    await generateT(page,3);
    const before=paidRequests(page).length;
    clock.now=9000;fixture.clock(9000);page.document.dispatch('visibilitychange');
    assert.equal(page.nodes['choose-latest'].disabled,true);
    page.nodes['choose-latest'].onclick();
    assert.equal(paidRequests(page).length,before);
    assert.equal(page.nodes.history.options.length,1);
  }finally{page.dispose();}
});

test('normal visible private end clears latest without another paid request',async()=>{
  const {page}=await sharedPage({ending:true});
  try {
    await generateT(page,3);
    const before=paidRequests(page).length;
    assert.equal(page.nodes['private-run-panel'].hidden,false);
    await page.nodes['private-end'].onclick();
    assert.equal(page.nodes['choose-latest'].hidden,true);
    assert.equal(page.nodes['choose-latest'].disabled,true);
    assert.equal(page.nodes.history.options[0].textContent,'其它完成版本');
    assert.equal(page.nodes.local.checked,true);
    assert.equal(page.nodes['listen-start'].value,'0');
    assert.equal(page.nodes['listen-end'].value,'1');
    page.nodes.local.checked=false;page.nodes.whole.checked=true;page.nodes.whole.onchange();
    assert.equal(page.nodes.whole.checked,true);
    page.nodes['choose-latest'].onclick();
    assert.equal(paidRequests(page).length,before);
    assert.equal(page.nodes.generate.disabled,true);
  }finally{page.dispose();}
});

test('unopened nonjoint page keeps its local and whole scope controls with latest hidden',async()=>{
  const page=await appPage({autoOpen:false,clock:{now:0}});
  try {
    assert.equal(page.nodes['choose-latest'].hidden,true);
    assert.equal(page.nodes['choose-latest'].disabled,true);
    assert.equal(page.nodes.generate.disabled,true);
    assert.equal(page.nodes.local.checked,true);
    page.nodes.local.checked=false;page.nodes.whole.checked=true;page.nodes.whole.onchange();
    assert.equal(page.nodes.whole.checked,true);
    assert.equal(paidRequests(page).length,0);
  }finally{page.dispose();}
});
