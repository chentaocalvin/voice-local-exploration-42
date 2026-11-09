import {test} from 'node:test';
import assert from 'node:assert/strict';
import {metadataApp} from './app_metadata_fixture.mjs';

test('motion refusal prevents repeat RPC and preserves previous results without unlocking the stopped input',async()=>{
  const page=await metadataApp();await page.open();page.motion('front');page.nodes.amount.value='0.5';page.nodes.amount.oninput();
  const before=page.nodes.heard.textContent;
  await page.nodes.generate.onclick();assert.equal(page.calls.render,1);
  await page.nodes.generate.onclick();assert.equal(page.calls.render,1,'same known refusal must not submit another RPC');
  assert.equal(page.nodes.generate.disabled,true);
  assert.match(page.nodes.status.textContent,/4\.165/);assert.match(page.nodes.status.textContent,/50\.126/);
  assert.equal(page.nodes.heard.textContent,before,'failure does not replace selected sound');
  page.nodes.development.value='flat';page.nodes.development.onchange();
  assert.match(page.nodes['control-help'].textContent,/尚未验证/);
  assert.match(page.nodes['control-help'].textContent,/本轮.*停止/);
  await page.nodes.generate.onclick();assert.equal(page.calls.render,1,'changing draft never reopens a stopped private input');
});

test('a generated request is recognized only in this opened analysis context',async()=>{
  const page=await metadataApp({refuse:false});await page.open();page.motion('front');page.nodes.amount.value='0.5';page.nodes.amount.oninput();
  assert.match(page.nodes['control-help'].textContent,/尚未验证/);
  await page.nodes.generate.onclick();assert.equal(page.calls.render,1);
  assert.match(page.nodes['control-help'].textContent,/已生成/);
  await page.open();assert.match(page.nodes['control-help'].textContent,/尚未验证/);
});

test('a stopped input can still choose another completed local result without a Worker request',async()=>{
  const page=await metadataApp({refuseAfter:1});await page.open();
  page.nodes.amount.value='3';page.nodes.amount.oninput();
  await page.nodes.generate.onclick();
  page.nodes['hear-E'].click();
  const oldHeard=page.nodes.heard.textContent;
  page.motion('front');page.nodes.amount.value='0.5';page.nodes.amount.oninput();
  await page.nodes.generate.onclick();
  assert.equal(page.nodes.generate.disabled,true);
  assert.equal(page.nodes['joint-compare'].disabled,true);
  const requests=page.calls.requests.length;
  page.nodes.history.value='new-E-1';page.nodes.history.onchange();
  assert.equal(page.calls.requests.length,requests);
  assert.notEqual(page.nodes.heard.textContent,oldHeard);
  assert.match(page.nodes.heard.textContent,/音色 3/);
  assert.equal(page.nodes.generate.disabled,true);
});
