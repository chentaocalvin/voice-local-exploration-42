import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExplorationDraft, explorationPolicy, SOLO_EXPLORATION_METHOD, PIANO_EXPLORATION_METHOD,
  qualifyExploration, compileExploration, renderExploration } from '../../issue42/joint/signed_exploration.mjs';
import { checkSignedDraft, compileSignedPiano, qualifySignedPiano } from '../../issue42/joint/signed_piano.mjs';

const samples=352800, frames=1601;
const draft=(kind,amount,mode='flat',range=kind==='M'?[621,870]:[100,1500])=>({intents:[{kind,amount,mode,start_frame:range[0],end_frame:range[1]}],preserve:[]});

test('new exploration methods explicitly own signed, temporal and subinterval limits; legacy limits remain',()=>{
  for(const kind of ['solo','piano']) {
    const policy=explorationPolicy(kind), max=kind==='solo'?.5:.75, mr=kind==='solo'?[621,870]:[681,1046];
    assert.equal(policy.method,kind==='solo'?SOLO_EXPLORATION_METHOD:PIANO_EXPLORATION_METHOD);
    for(const [feature,amount,range] of [['M',max,mr],['Q',4,[100,1500]],['T',9,[100,1500]]]) {
      for(const sign of [-1,1]) for(const mode of ['flat','front','back'])
        assert.equal(checkExplorationDraft(draft(feature,sign*amount,mode,range),frames,kind).intents[0].amount,sign*amount);
      assert.throws(()=>checkExplorationDraft(draft(feature,amount+.001,'front',range),frames,kind),/signed_draft/);
      assert.equal(checkExplorationDraft(draft(feature,.25,'shift',range),frames,kind).intents[0].mode,'shift');
      assert.throws(()=>checkExplorationDraft(draft(feature,-.25,'shift',range),frames,kind),/signed_draft/);
      assert.doesNotThrow(()=>checkExplorationDraft(draft(feature,amount,'back',[range[0]+10,range[1]-10]),frames,kind));
      assert.throws(()=>checkExplorationDraft(draft(feature,amount,'back',[range[0]-1,range[1]]),frames,kind),/signed_draft/);
    }
  }
  assert.throws(()=>explorationPolicy('estimated'),/exploration_kind/);
  assert.throws(()=>checkExplorationDraft(draft('Q',4),1801,'solo'),/signed_draft/);
  assert.throws(()=>checkSignedDraft(draft('Q',4,'front'),frames,[100,1500],[681,1046]),/signed_draft/);
  assert.throws(()=>checkSignedDraft(draft('M',.75,'flat',[621,870]),frames,[100,1500],[621,870]),/signed_draft/);
});

function fixture() {
  const voice=Float64Array.from({length:samples},(_,i)=>(1+.15*Math.sin(2*Math.PI*3*i/44100))*(.12*Math.sin(2*Math.PI*300*i/44100)+.02*Math.sin(2*Math.PI*3000*i/44100)));
  const analysis={frames,time:Float64Array.from({length:frames},(_,i)=>i/200),f0:Float64Array.from({length:frames},(_,i)=>300*2**(20*Math.sin(2*Math.PI*6*i/200)/1200)),sp:new Float64Array(frames*1025).fill(1),ap:new Float64Array(frames*1025).fill(.2)};
  const track=Array.from(analysis.time,(time,i)=>({time,hz:analysis.f0[i],undefined:false}));
  return {voice,analysis,track};
}

test('solo exploration reuses source-waveform signed math with zero accompaniment and distinct identity',()=>{
  const f=fixture(), qualification=qualifyExploration({...f,kind:'solo'});
  assert.equal(qualification.method_version,SOLO_EXPLORATION_METHOD);
  assert.deepEqual(qualification.default_region,[100,1500]);
  assert.deepEqual(qualification.motion_region,[621,870]);
  const compiled=compileExploration(f.analysis,qualification,draft('Q',-4,'front'),samples);
  const result=renderExploration({...f,qualification,compiled});
  assert.ok(result.voice.some((v,i)=>v!==f.voice[i]));
  assert.ok(result.voice.every((value,i)=>Math.abs(value-result.mix[i])<1e-15));
  for(let i=0;i<samples;i++)if(!compiled.regions.some(([a,b])=>i>=a&&i<b))assert.equal(result.voice[i],f.voice[i]);
  const legacy=qualifySignedPiano({...f,interval:[100,1500],motionRegion:[621,870]});
  assert.throws(()=>compileSignedPiano(f.analysis,legacy,draft('Q',-4,'front'),samples),/signed_draft/);
  assert.throws(()=>renderExploration({...f,mix:new Float64Array(samples),qualification,compiled}),/exploration_solo_mix/);
});

test('new nonflat maximum controls retain the signed envelopes and fixed shift with independent support',()=>{
  const f=fixture(), qualification=qualifyExploration({...f,kind:'piano'});
  for(const [kind,amount,region]of [['M',.75,[681,1046]],['Q',4,[100,1500]],['T',9,[100,1500]]]) {
    const flat=compileExploration(f.analysis,qualification,draft(kind,amount,'flat',region),samples);
    const front=compileExploration(f.analysis,qualification,draft(kind,amount,'front',region),samples);
    const back=compileExploration(f.analysis,qualification,draft(kind,amount,'back',region),samples);
    assert.ok(flat.controls[kind].effective.every((v,i)=>Math.abs(v-front.controls[kind].effective[i]-back.controls[kind].effective[i])<1e-12));
    assert.ok(compileExploration(f.analysis,qualification,draft(kind,.25,'shift',region),samples).controls[kind].effective.some(v=>v!==0));
  }
  const mismatch=qualifyExploration({...f,kind:'solo',track:f.track.map(item=>({...item,hz:item.hz*2}))});
  assert.throws(()=>compileExploration(f.analysis,mismatch,draft('M',.5),samples),/signed_support_M/);
  assert.doesNotThrow(()=>compileExploration(f.analysis,mismatch,draft('Q',-4),samples));
});
