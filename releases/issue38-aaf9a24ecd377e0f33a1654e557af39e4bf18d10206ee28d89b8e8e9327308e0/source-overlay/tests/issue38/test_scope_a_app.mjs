import assert from 'node:assert/strict';
import test from 'node:test';
import {metadataApp} from './app_metadata_fixture.mjs';

for (const kind of ['solo','piano']) test(kind+' reopens a saved shift, withdraws it, edits and reopens the chosen result',async()=>{
  const [start_frame,end_frame]=kind==='solo'?[621,870]:[681,1046];
  const shift={kind:'M',start_frame,end_frame,amount:.25,mode:'shift',held:false};
  const legacy={intents:[shift],preserve:[[0,100]]};
  const projects=new Map([['J:older',{view:{resultId:'old-E',draft:legacy,listening:{start:.6,end:7,mode:'whole',selected:'E'}}}]]);
  const page=await metadataApp({kind,projects,initialDraft:legacy,refuse:false});
  const {nodes,calls}=page;
  await page.reopen('J:older');
  assert.match(nodes.status.textContent,/工程已恢复/);
  assert.match(nodes['intent-list'].textContent,/后移0.25秒.*已延期/);
  assert.equal(nodes.development.options.find(x=>x.value==='shift').disabled,true);
  assert.equal(nodes.generate.disabled,true);
  assert.equal(nodes['hear-E'].disabled,false);
  assert.equal(nodes.whole.checked,true);
  assert.equal(nodes['listen-start'].value,'0.6');

  nodes.development.value='front';nodes.development.onchange();
  nodes.amount.value='3';nodes.amount.oninput();
  await nodes.generate.onclick();
  assert.equal(calls.render,0,'an active legacy shift in another intent blocks new generation');

  const motion=nodes['intent-list'].children.find(x=>x.dataset.kind==='M');
  motion.children.find(x=>x.textContent==='撤回').click();
  assert.equal(nodes.generate.disabled,false);
  await nodes.generate.onclick();
  assert.equal(calls.render,1);
  const generated=calls.requests.findLast(x=>x.type==='jointRender');
  assert.deepEqual(generated.draft.intents.find(x=>x.kind==='M'),{...shift,held:true});
  assert.equal(generated.draft.intents.find(x=>x.kind==='T').mode,'front');

  assert.equal(nodes['choose-latest'].disabled,false);
  nodes['choose-latest'].click();
  assert.equal(nodes.history.value,'new-E-1');
  await nodes['joint-compare'].onclick();
  const compare=calls.requests.findLast(x=>x.type==='jointCompare');
  assert.equal(compare.scope.right,'new-E-1');
  assert.equal(compare.scope.axis,kind==='piano'?'full_mix':'vocal_only');
  assert.equal(calls.render,1);
  nodes['private-save-role'].value='final';await nodes.save.onclick();
  const saved=calls.requests.findLast(x=>x.type==='jointSave');
  assert.equal(saved.view.resultId,'new-E-1');
  assert.deepEqual(saved.view.draft,generated.draft);
  assert.equal(saved.view.listening.mode,'whole');

  const reopened=await metadataApp({kind,projects,refuse:false});
  await reopened.reopen(saved.projectId);
  assert.match(reopened.nodes.status.textContent,/工程已恢复/);
  assert.equal(reopened.nodes.history.value,'new-E-1');
  assert.match(reopened.nodes['intent-list'].textContent,/后移0.25秒.*已延期.*已撤回/);
  assert.equal(reopened.nodes.development.value,'front');
  assert.equal(reopened.nodes.amount.value,'3');
  assert.equal(reopened.nodes.generate.disabled,false);
  assert.equal(reopened.calls.render,0);
  assert.deepEqual(projects.get('J:older').view.draft,legacy);
});

test('scope A blocks a direct submit of newly selected shift at the page boundary',async()=>{
  const page=await metadataApp({refuse:false});
  await page.open();page.motion('shift');
  await page.nodes.generate.onclick();
  assert.equal(page.calls.render,0);
  assert.match(page.nodes.status.textContent,/精确后移已延期/);
  assert.equal(page.nodes['hear-E'].disabled,false);
});

for (const kind of ['solo','piano']) test(kind+' compares completed versions and restores only the saved feedback',async()=>{
  const projects=new Map(), cueDeltas={'old-E':4.1,'new-E-1':2.5};
  const page=await metadataApp({kind,projects,cueDeltas,refuse:false});
  const {nodes,calls}=page;
  await page.open();
  assert.equal(nodes['version-comparison'].hidden,false);
  assert.match(nodes['version-comparison'].textContent,/尚无.*线索/);
  const comparing = nodes['joint-compare'].onclick();
  await Promise.resolve();
  nodes['listen-start'].value='0.6';nodes['listen-start'].onchange();
  await comparing;
  assert.match(nodes['version-comparison'].textContent,/4\.1 dB/);
  nodes.amount.value='3';nodes.amount.oninput();
  await nodes.generate.onclick();
  nodes['choose-latest'].click();
  assert.match(nodes['version-comparison'].textContent,/待计算/);
  await nodes['joint-compare'].onclick();
  let text=nodes['version-comparison'].textContent;
  assert.ok(text.indexOf('2.5 dB')>=0&&text.indexOf('2.5 dB')<text.indexOf('4.1 dB'));
  assert.equal(text.includes('估算伴奏'),kind==='piano');
  assert.match(text,/处理范围外的人声与参考相同/);
  nodes.history.value='old-E';nodes.history.onchange();
  text=nodes['version-comparison'].textContent;
  assert.ok(text.indexOf('4.1 dB')<text.indexOf('2.5 dB'));
  nodes['listen-start'].value='0.7';nodes['listen-start'].onchange();
  assert.match(nodes['version-comparison'].textContent,/0\.5–7\.5 秒/);
  assert.equal(calls.requests.filter(x=>x.type==='jointCompare').length,2);
  await nodes.save.onclick();
  const saved=calls.requests.findLast(x=>x.type==='jointSave');
  const reopened=await metadataApp({kind,projects,cueDeltas,refuse:false});
  await reopened.reopen(saved.projectId);
  text=reopened.nodes['version-comparison'].textContent;
  assert.match(text,/4\.1 dB/);
  assert.match(text,/重开工程仅恢复保存时所选版本及其线索/);
  assert.match(text,/已保存/);
  assert.doesNotMatch(text,/2\.5 dB/);
  assert.ok(!reopened.calls.requests.some(x=>x.type==='jointCompare'));
  await reopened.open();
  assert.doesNotMatch(reopened.nodes['version-comparison'].textContent,/4\.1 dB|2\.5 dB/);
});
