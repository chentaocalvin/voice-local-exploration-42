import assert from 'node:assert/strict';
import test from 'node:test';
import {fixedCombinationPlan} from './fixed_combination_plan.mjs';

test('the proposed piano continuation tests its combination before six new directions',()=>{
  const p=fixedCombinationPlan('piano');
  assert.deepEqual(p.initial.map(x=>x.name),['MQT-seed','B-M-','B-M+','B-Q-','B-Q+','B-T-','B-T+','weak-M','weak-Q','weak-T']);
  assert.deepEqual(p.initial[0].draft,{
    intents:[
      {kind:'M',amount:.5,mode:'flat',held:false,start_frame:681,end_frame:1046},
      {kind:'Q',amount:2,mode:'flat',held:false,start_frame:100,end_frame:1500},
      {kind:'T',amount:6,mode:'flat',held:false,start_frame:100,end_frame:1500},
    ],preserve:[[0,100]],
  });
  assert.equal(p.initial[0].saveRole,'seed');
  const solo=fixedCombinationPlan('solo');
  assert.deepEqual(solo.initial.map(x=>x.name),['MQT-seed']);
  assert.deepEqual(solo.initial[0].draft.intents.map(({kind,amount})=>[kind,amount]),[['M',.5],['Q',2],['T',6]]);
});

test('withdrawing one intent keeps the complete editable intent graph and restores the seed',()=>{
  for(const kind of ['solo','piano']) {
    const p=fixedCombinationPlan(kind),seed=p.initial.find(x=>x.saveRole==='seed');
    const [withdraw,restore]=p.continued,removed=kind==='solo'?'Q':'T';
    assert.equal(withdraw.name,'withdraw-'+removed);
    assert.deepEqual(withdraw.draft,{intents:seed.draft.intents.map(x=>({...x,held:x.kind===removed})),preserve:[[0,100]]});
    assert.deepEqual(restore.draft,seed.draft);
    assert.equal(restore.compare,false);
    assert.equal(restore.expected,'seed');
    assert.equal(p.compareColdSeed,false);
  }
});

test('degree and temporal comparisons use the chosen points without reviving failed high QT doses',()=>{
  for(const kind of ['solo','piano']) {
    const p=fixedCombinationPlan(kind),c=p.continued;
    assert.deepEqual([...p.initial,...c].filter(x=>x.name.startsWith('weak-')).map(x=>x.draft.intents[0].amount),[.25,1,3]);
    assert.deepEqual(c.filter(x=>x.name.startsWith('base-')).map(x=>x.draft.intents[0].amount),kind==='solo'?[.5,2,6]:[]);
    const byName=name=>c.find(x=>x.name===name);
    assert.deepEqual(byName('other-pair').draft.intents.map(({kind,amount})=>[kind,amount]),kind==='solo'?[['M',.5],['Q',2]]:[['M',.5],['T',6]]);
    assert.deepEqual(byName('QT').draft.intents.map(({kind,amount})=>[kind,amount]),[['Q',2],['T',6]]);
    for(const [feature,amount] of [['M',.5],['Q',2],['T',6]])for(const mode of ['front','back','shift']) {
      const x=byName(feature+'-'+mode).draft.intents[0];
      assert.deepEqual([x.kind,x.mode,x.amount],[feature,mode,mode==='shift'?.25:amount]);
    }
    assert.deepEqual(c.at(-1).draft.intents.map(({kind,amount,mode})=>[kind,amount,mode]),[['M',.5,'flat'],['Q',.25,'shift'],['T',6,'flat']]);
    assert.equal(c.at(-1).saveRole,'final');
    assert.deepEqual(byName('protection-conflict').draft.preserve,[[0,100],[100,1500]]);
    assert.equal(byName('protection-conflict').expected,'U');
    for(const x of [...p.initial,...c])for(const control of x.draft.intents) {
      if(control.mode!=='shift')assert.ok(Math.abs(control.amount)<={M:.5,Q:2,T:6}[control.kind],x.name);
    }
  }
});

test('the proposed complete routes keep the existing per-input operation ceilings',()=>{
  for(const kind of ['solo','piano']) {
    const p=fixedCombinationPlan(kind),all=[...p.initial,...p.continued];
    assert.equal(all.length+3,kind==='solo'?25:28); // initial U and cold U/selected result
    assert.equal(all.filter(x=>x.compare).length,kind==='solo'?21:24);
    assert.equal(all.filter(x=>x.saveRole).length,2);
    assert.deepEqual(all.filter(x=>x.saveRole).map(x=>x.saveRole),['seed','final']);
    assert.equal(p.initial.filter(x=>x.name.startsWith('B-')).length,kind==='solo'?0:6);
    assert.equal(p.initial.filter(x=>x.name==='MQT-seed').length,1);
    assert.ok(all.every(x=>x.draft.intents.every(y=>Number.isFinite(y.amount))));
  }
  assert.throws(()=>fixedCombinationPlan('mix'),/fixed_combination_kind/);
});

test('the final archive is a listener choice rather than an automatically fixed last sound',()=>{
  for(const kind of ['solo','piano']) {
    const p=fixedCombinationPlan(kind),last=p.continued.at(-1);
    assert.equal(last.name,'MQT-Q-shift-check');
    assert.equal(last.saveRole,'final');
    assert.equal(last.saveSelection,'listener-choice');
    const unchanged=p.continued.find(x=>x.name==='protection-conflict');
    assert.equal(unchanged.expected,'U');
    assert.equal(unchanged.compare,true);
    assert.equal([...p.initial,...p.continued].filter(x=>x.saveSelection).length,1);
  }
});

test('piano degree comparisons finish while strong versions are still available before cold reopen',()=>{
  const p=fixedCombinationPlan('piano');
  assert.equal(p.initial.filter(x=>x.compare).length,10);
  assert.equal(p.continued.some(x=>x.name.startsWith('weak-')),false);
  assert.ok(p.initial.findIndex(x=>x.name==='weak-M')>p.initial.findIndex(x=>x.name==='B-T+'));
  assert.equal(fixedCombinationPlan('solo').continued.filter(x=>x.name.startsWith('weak-')).length,3);
});
