import assert from 'node:assert/strict';
import test from 'node:test';
import { spectralDeltaScale } from '../../issue42/joint/spectral_headroom.mjs';

test('a requested spectral change respects the tighter mix margin using one shared scale',()=>{
  const beforeVoice=new Float64Array([0]);
  const beforeMix=new Float64Array([1]);
  const requestedVoice=new Float64Array([1]);
  const result=spectralDeltaScale({stage:'Q',voice:beforeVoice,mix:beforeMix,edited:requestedVoice,
    source:{voice:beforeVoice,mix:beforeMix}});
  assert.ok(Math.abs(result.scale-.958)<1e-12);
  assert.deepEqual([...requestedVoice],[1]);
});

test('a nonfinite pre-stage mix refuses the change with bounded stage evidence',()=>{
  assert.throws(()=>spectralDeltaScale({stage:'Q',voice:new Float64Array([0]),
    mix:new Float64Array([NaN]),edited:new Float64Array([1]),
    source:{voice:new Float64Array([0]),mix:new Float64Array([0])}}),error=>{
    assert.equal(error.message,'spectral_headroom_nonfinite');
    assert.deepEqual(error.headroom,{stage:'Q',finite:false,sample:0});
    return true;
  });
});

test('a spectral request needing less than half its difference stops without reducing its floor',()=>{
  assert.throws(()=>spectralDeltaScale({stage:'T',voice:new Float64Array([1]),
    mix:new Float64Array([1]),edited:new Float64Array([3]),
    source:{voice:new Float64Array([1]),mix:new Float64Array([1])}}),error=>{
    assert.equal(error.message,'spectral_headroom_insufficient');
    assert.equal(error.headroom.stage,'T');
    assert.equal(error.headroom.finite,true);
    assert.equal(error.headroom.intersection_empty,false);
    assert.ok(Math.abs(error.headroom.scale_upper_bound-.479)<1e-12);
    return true;
  });
});

test('the spectral-only policy cannot be applied to a motion stage',()=>{
  const voice=new Float64Array([0]);
  assert.throws(()=>spectralDeltaScale({stage:'M',voice,mix:voice,edited:voice,
    source:{voice,mix:voice}}),/spectral_headroom_axis/);
});

test('an empty or mismatched waveform axis is not reported as a safe spectral change',()=>{
  const voice=new Float64Array([0]);
  for(const edited of [new Float64Array(),new Float64Array([0,0])])
    assert.throws(()=>spectralDeltaScale({stage:'Q',voice,mix:voice,edited,
      source:{voice,mix:voice}}),/spectral_headroom_axis/);
});

test('a change below the original hard gate stays exact even above the scaled-only target',()=>{
  const voice=new Float64Array([0]),edited=new Float64Array([1.959]);
  const result=spectralDeltaScale({stage:'Q',voice,mix:voice,edited,source:{voice,mix:voice}});
  assert.equal(result.scale,1);
  assert.deepEqual([...edited],[1.959]);
});

test('a negative timbre difference uses the same common voice and mix constraint',()=>{
  const voice=new Float64Array([0]),mix=new Float64Array([-1]);
  const result=spectralDeltaScale({stage:'T',voice,mix,edited:new Float64Array([-1]),source:{voice,mix}});
  assert.ok(Math.abs(result.scale-.958)<1e-12);
});

test('exactly half the requested difference remains allowed',()=>{
  const result=spectralDeltaScale({stage:'Q',voice:new Float64Array([.458]),
    mix:new Float64Array([1.458]),edited:new Float64Array([1.458]),
    source:{voice:new Float64Array([0]),mix:new Float64Array([1])}});
  assert.equal(result.scale,.5);
});

test('an unchanged sample outside the scaled target cannot be repaired by global gain',()=>{
  assert.throws(()=>spectralDeltaScale({stage:'T',voice:new Float64Array([0,.959]),
    mix:new Float64Array([1,1.959]),edited:new Float64Array([1,.959]),
    source:{voice:new Float64Array([0,0]),mix:new Float64Array([1,1])}}),error=>{
    assert.equal(error.message,'spectral_headroom_insufficient');
    assert.equal(error.headroom.intersection_empty,true);
    return true;
  });
});

test('the voice can be the tighter constraint even when the requested mix is safe',()=>{
  const voice=new Float64Array([1]),mix=new Float64Array([0]);
  const result=spectralDeltaScale({stage:'Q',voice,mix,edited:new Float64Array([2]),source:{voice,mix}});
  assert.ok(Math.abs(result.scale-.958)<1e-12);
});
