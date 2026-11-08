import assert from 'node:assert/strict';
import test from 'node:test';
import {spectralDeltaScale} from '../../issue42/joint/spectral_headroom.mjs';

test('a joint spectral endpoint keeps at least half the change when greedy stage allocation cannot',()=>{
  // Worked scalar counterexample in the approved plan; this is not measured recording data.
  const base=new Float64Array([.2]),q=new Float64Array([2.568]);
  const first=spectralDeltaScale({stage:'Q',voice:base,mix:base,edited:q,source:{voice:base,mix:base}});
  const allocated=new Float64Array([.2+first.scale*(2.568-.2)]);
  assert.throws(()=>spectralDeltaScale({stage:'T',voice:allocated,mix:allocated,
    edited:allocated.map(value=>1.2*value),source:{voice:base,mix:base}}),/spectral_headroom_insufficient/);
  const together=spectralDeltaScale({stage:'QT',voice:base,mix:base,
    edited:new Float64Array([3.0816]),source:{voice:base,mix:base}});
  assert.ok(together.scale>=.5&&together.scale<1);
  assert.ok(Math.abs((.2+together.scale*2.8816)*.5-.979)<1e-12);
});
