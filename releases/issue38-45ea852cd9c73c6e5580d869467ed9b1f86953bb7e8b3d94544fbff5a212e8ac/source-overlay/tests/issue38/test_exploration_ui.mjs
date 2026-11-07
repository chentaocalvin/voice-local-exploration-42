import assert from 'node:assert/strict';
import test from 'node:test';
import {appPage} from './app_fixture.mjs';
import {explorationFixture} from './exploration_fixture.mjs';

async function explorationPage() {
  const f=await explorationFixture('solo');
  return appPage({clock:{now:0},parent:{sdk:f.options.sdk},engineOptions:f.options,inputBundle:f.input});
}

test('normal exploration controls offer signed amounts in the admitted region and a fixed quarter-second shift',async()=>{
  const page=await explorationPage();
  try {
    const {nodes}=page;
    nodes['joint-kind'].value='M';nodes['joint-kind'].onchange();
    assert.equal(nodes.amount.min,'-0.5');assert.equal(nodes.amount.max,'0.5');
    assert.equal(nodes.start.value,'3.105');assert.equal(nodes.end.value,'4.35');
    nodes.amount.value='-0.5';nodes.amount.oninput();await nodes.generate.onclick();
    assert.equal(page.workers[0].engine.current().available.at(-1).control.intents[0].amount,-.5);
    nodes['joint-kind'].value='Q';nodes['joint-kind'].onchange();
    assert.equal(nodes.amount.min,'-4');assert.equal(nodes.amount.max,'4');
    nodes.development.value='shift';nodes.development.onchange();
    assert.equal(nodes.amount.value,'0.25');assert.equal(nodes.amount.disabled,true);
    await nodes.generate.onclick();
    const last=page.workers[0].engine.current().available.at(-1).control.intents.at(-1);
    assert.equal(last.kind,'Q');assert.equal(last.mode,'shift');assert.equal(last.amount,.25);
    assert.match(nodes['intent-list'].textContent,/后移0.25秒/);
    assert.doesNotMatch(nodes['intent-list'].textContent,/undefined/);
  }finally{page.dispose();}
});

test('normal exploration comparison keeps its fixed measurement region when listening changes and saves an explicit role',async()=>{
  const page=await explorationPage();
  try {
    const {nodes}=page;
    nodes.amount.value='3';nodes.amount.oninput();await nodes.generate.onclick();
    nodes['listen-start'].value='1';nodes['listen-start'].onchange();
    nodes['listen-end'].value='2';nodes['listen-end'].onchange();
    await nodes['joint-compare'].onclick();
    const compared=page.messages.findLast(message=>message.type==='jointCompare');
    assert.deepEqual(compared.scope.interval,[22050,330750]);
    assert.match(nodes['joint-report'].textContent,/0.5–7.5/);
    assert.ok(page.messages.some(message=>message.type==='jointVersionRecord'));
    assert.equal(nodes['private-save-role'].hidden,false);
    nodes['private-save-role'].value='seed';await nodes.save.onclick();
    nodes['private-save-role'].value='final';await nodes.save.onclick();
    assert.deepEqual(page.messages.filter(message=>message.type==='jointSave').map(message=>message.saveRole),['seed','final']);
  }finally{page.dispose();}
});

test('a real range value entering T shift and returning to flat keeps exactly the requested amount',async()=>{
  const page=await explorationPage();
  try {
    const {nodes}=page;
    assert.equal(nodes['joint-kind'].value,'T');assert.equal(nodes.amount.step,'0.5');
    nodes.development.value='shift';nodes.development.onchange();
    assert.equal(nodes.amount.value,'0.25');
    assert.equal(nodes['amount-unit'].textContent,'秒');
    await nodes.generate.onclick();
    let last=page.messages.findLast(message=>message.type==='jointRender').draft.intents.find(item=>item.kind==='T');
    assert.equal(last.mode,'shift');assert.equal(last.amount,.25);
    nodes.development.value='flat';nodes.development.onchange();
    assert.equal(nodes.amount.value,'0');
    assert.equal(nodes['amount-unit'].textContent,'dB');
    await nodes.generate.onclick();
    last=page.messages.findLast(message=>message.type==='jointRender').draft.intents.find(item=>item.kind==='T');
    assert.equal(last.mode,'flat');assert.equal(last.amount,0);
  }finally{page.dispose();}
});
