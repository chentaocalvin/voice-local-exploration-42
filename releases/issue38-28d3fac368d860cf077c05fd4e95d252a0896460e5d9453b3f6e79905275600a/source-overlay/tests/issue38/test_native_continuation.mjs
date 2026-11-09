import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareContinuation,parseNativePageSnapshot,continuationNativeTexts} from '../../prepare-continuation.mjs';
import {continuationFlow,checkPageDraft} from './continuation_flow.mjs';

test('new-only text preparation has the exact bounded remaining routes and no execution authority',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'issue38-native-text-test-'));
  try {
    const out=join(parent,'prepared'),m=await prepareContinuation(out);
    assert.equal(m.realSDKAuthorized,false);assert.equal(m.UIExecuted,0);assert.equal(m.SDKExecuted,0);
    assert.deepEqual(m.flows.map(x=>[x.kind,x.cases.length,x.expectedCounts.make_version,x.expectedCounts.compare]),[['piano',13,17,14],['solo',21,25,21]]);
    assert.ok(m.flows.every(x=>x.cases.every(c=>c.files.every(f=>f.path.endsWith('.txt')))));
    assert.equal(m.headers.piano,'__CURRENT_RUN_PROJECT__');
    const restore=m.flows[1].cases.find(x=>x.name==='restore-Q');
    assert.ok(!restore.files.some(x=>x.role==='compare'||x.role.startsWith('play-')));
    const final=await readFile(join(out,'piano-final-final-save.txt'),'utf8');
    assert.match(final,/保存当前最终方案/);assert.ok(!final.includes('生成并比较'));
    const guide=await readFile(join(out,'RUNBOOK.md'),'utf8');
    assert.match(guide,/若current record仍是旧版/);assert.match(guide,/checkMeasuredVersion/);
    await assert.rejects(prepareContinuation(out),/EEXIST/);
  }finally{await rm(parent,{recursive:true,force:true});}
});

const snapshot=`HEADER\t__CURRENT_RUN_PROJECT__
GENERATE\ttrue
FORM_KIND\t声音运动
FORM_AMOUNT\t0.5
FORM_MODE\t前半展开，后半保留
FORM_START\t3.405
FORM_END\t5.23
FORM_HELD\t0
LISTEN_LOCAL\t1
LISTEN_WHOLE\t0
LISTEN_START\t0.5
LISTEN_END\t7.5
INTENT\t1\tAXListMarker\t\t
INTENT\t1\tAXStaticText\t\t声音运动 · 3.405–5.230 秒 · 0.5 · 前半展开
INTENT\t1\tAXButton\t编辑\t
INTENT\t1\tAXButton\t撤回\t
`;
test('normal role/name/value snapshot accepts AXListMarker and feeds the root full-draft checker',()=>{
  const step=continuationFlow('piano',{carryPianoWithdrawal:true}).cases[0];
  const page=parseNativePageSnapshot(snapshot);
  assert.equal(page.intentRows[0][0].role,'AXListMarker');
  assert.deepEqual(page.listening,{start:.5,end:7.5,mode:'local'});
  assert.equal(checkPageDraft(step,page,'__CURRENT_RUN_PROJECT__'),true);
  assert.throws(()=>checkPageDraft(step,page,'wrong'),'page_source');
});

test('incomplete, duplicate, unparsed checkbox and row gaps stop before any native action',()=>{
  for(const bad of [snapshot.replace('FORM_HELD\t0\n',''),snapshot+'FORM_KIND\t声音运动\n',
    snapshot.replace('FORM_HELD\t0','FORM_HELD\tmissing value'),snapshot.replaceAll('INTENT\t1','INTENT\t2'),
    snapshot.replaceAll('INTENT\t1','INTENT\t4294967294'),snapshot+'PROTECT\t3\tAXStaticText\t\tbad\n']) {
    assert.throws(()=>parseNativePageSnapshot(bad),/native_snapshot_/);
  }
});

test('native bodies separate paid clicks from read-only probing, latest choice and normal metadata export',()=>{
  const texts=continuationNativeTexts();
  assert.ok(!texts['read-page'].includes('AXPress'));
  assert.match(texts['read-page'],/continuation_checkbox_not_uniquely_observed/);
  assert.match(texts['read-page'],/childRole/);assert.ok(!texts['read-page'].includes('rowLabel to value of UI element 1'));
  assert.ok(!/scanNode|rowList|childNode|200/.test(texts['read-page']));
  assert.match(texts['play-E-local'],/delay 8\.5/);assert.ok(!texts['play-E-local'].includes('repeat 42'));
  assert.equal((texts.render.match(/AXPress/g)||[]).length,1);
  assert.equal((texts.compare.match(/AXPress/g)||[]).length,1);
  assert.match(texts.latest,/选用刚生成的版本/);
  assert.match(texts['export-current'],/导出工程/);
  assert.ok(!Object.values(texts).some(x=>/version-record|http|[0-9a-f]{64}|unix id is \d/.test(x)));
});

test('CLI requires an explicit output directory and module import from stdin performs no preparation',()=>{
  const moduleURL=new URL('../../prepare-continuation.mjs',import.meta.url);
  const cli=spawnSync(process.execPath,[fileURLToPath(moduleURL)],{encoding:'utf8'});
  assert.notEqual(cli.status,0);assert.match(cli.stderr,/explicit --out is required/);
  const imported=spawnSync(process.execPath,['--input-type=module','-'],{input:`await import(${JSON.stringify(moduleURL.href)});console.log('IMPORTED_ONLY');`,encoding:'utf8'});
  assert.equal(imported.status,0);assert.equal(imported.stdout.trim(),'IMPORTED_ONLY');
});
