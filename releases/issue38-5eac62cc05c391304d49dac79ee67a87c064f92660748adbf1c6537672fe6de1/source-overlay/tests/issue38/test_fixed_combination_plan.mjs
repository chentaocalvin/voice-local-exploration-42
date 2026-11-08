import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fixedCombinationPlan} from './fixed_combination_plan.mjs';

test('solo tests the fixed combination before any new singles and never repeats accepted high-dose B',()=>{
  const {initial}=fixedCombinationPlan('solo');
  assert.deepEqual(initial.map(item=>item.name),['MQT-seed']);
  assert.deepEqual(initial[0].draft,{
    intents:[
      {kind:'M',amount:.25,mode:'flat',held:false,start_frame:621,end_frame:870},
      {kind:'Q',amount:1,mode:'flat',held:false,start_frame:100,end_frame:1500},
      {kind:'T',amount:3,mode:'flat',held:false,start_frame:100,end_frame:1500},
    ],preserve:[[0,100]],
  });
  assert.equal(initial[0].compare,true);
  assert.equal(initial[0].saveRole,'seed');
});

test('piano supplies each signed low-dose direction before its fixed saved combination',()=>{
  const {initial}=fixedCombinationPlan('piano');
  assert.deepEqual(initial.map(item=>item.name),['B-M-','B-M+','B-Q-','B-Q+','B-T-','B-T+','MQT-seed']);
  assert.deepEqual(initial.slice(0,6).map(item=>item.draft.intents.map(({kind,amount})=>[kind,amount])),
    [[['M',-.25]],[['M',.25]],[['Q',-1]],[['Q',1]],[['T',-3]],[['T',3]]]);
  assert.deepEqual(initial[0].draft.intents[0],
    {kind:'M',amount:-.25,mode:'flat',held:false,start_frame:681,end_frame:1046});
  assert.equal(initial.at(-1).saveRole,'seed');
  assert.ok(initial.every(item=>item.compare));
});

test('both complete routes preserve low flat doses, native shifts, withdrawal and degree baselines',()=>{
  for(const kind of ['solo','piano']) {
    const plan=fixedCombinationPlan(kind),all=[...plan.initial,...plan.continued];
    assert.equal(plan.compareColdSeed,false);
    assert.deepEqual(plan.continued.slice(0,2).map(item=>item.name),
      [kind==='solo'?'withdraw-Q':'withdraw-T',kind==='solo'?'restore-Q':'restore-T']);
    assert.deepEqual(plan.continued[0].draft.intents.map(item=>item.kind),kind==='solo'?['M','T']:['M','Q']);
    assert.deepEqual(plan.continued[1].draft,plan.initial.at(-1).draft);
    assert.equal(plan.continued[1].compare,false);
    assert.deepEqual(plan.continued.filter(item=>item.name.startsWith('base-')).map(item=>item.name),
      kind==='solo'?['base-M','base-Q','base-T']:[]);
    assert.deepEqual(plan.continued.filter(item=>item.name.startsWith('weak-')).map(item=>item.draft.intents[0].amount),[.1,.5,1.5]);
    for(const item of all)for(const control of item.draft.intents) {
      assert.equal(control.held,false);
      if(control.mode==='shift')assert.equal(control.amount,.25);
      else assert.ok(Math.abs(control.amount)<={M:.25,Q:1,T:3}[control.kind],item.name);
    }
    assert.deepEqual(plan.continued.at(-1).draft.intents.map(({kind,amount,mode})=>[kind,amount,mode]),
      [['M',.25,'flat'],['Q',.25,'shift'],['T',3,'flat']]);
    assert.equal(plan.continued.at(-1).saveRole,'final');
    assert.deepEqual(plan.continued.find(item=>item.name==='protection-conflict').draft.preserve,[[0,100],[100,1500]]);
    assert.equal(all.length+3,kind==='solo'?25:28);
    assert.equal(all.filter(item=>item.compare).length,kind==='solo'?21:24);
    assert.equal(all.filter(item=>item.saveRole).length,2);
  }
  assert.throws(()=>fixedCombinationPlan('mix'),/fixed_combination_kind/);
});

test('every planned flat or envelope amount can be selected exactly on the current page grid',()=>{
  const app=readFileSync(new URL('../../issue42/app.mjs',import.meta.url),'utf8');
  const match=app.match(/slider\.step = explorationProject\(\)\?String\(\{M:([.\d]+),Q:([.\d]+),T:([.\d]+)\}\[kind\]\)/);
  assert.ok(match,'current exploration slider steps must be identified before certifying controls');
  const steps={M:Number(match[1]),Q:Number(match[2]),T:Number(match[3])};
  const mismatches=[];
  for(const kind of ['solo','piano']) {
    const plan=fixedCombinationPlan(kind);
    for(const item of [...plan.initial,...plan.continued])for(const control of item.draft.intents) {
      if(control.mode==='shift')continue;
      const minimum=-{M:kind==='solo'?.5:.75,Q:4,T:9}[control.kind];
      const units=(control.amount-minimum)/steps[control.kind];
      if(Math.abs(units-Math.round(units))>1e-9)mismatches.push({kind,operation:item.name,feature:control.kind,requested:control.amount,step:steps[control.kind]});
    }
  }
  assert.deepEqual(mismatches,[],'the page would quantize a declared request; no implicit dose change is allowed');
});
