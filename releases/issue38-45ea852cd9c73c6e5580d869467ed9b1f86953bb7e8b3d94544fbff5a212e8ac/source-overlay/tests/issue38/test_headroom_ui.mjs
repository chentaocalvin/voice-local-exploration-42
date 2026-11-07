import assert from 'node:assert/strict';
import test from 'node:test';
import {appPage} from './app_fixture.mjs';
import {explorationFixture} from './exploration_fixture.mjs';
import {HEADROOM_PROFILE} from '../../issue42/joint/exploration_profile.mjs';

test('a limited result states that its actual change was reduced and exposes the actual scale in its record',async()=>{
  const f=await explorationFixture('solo');f.analysis.ap.fill(.9);
  const page=await appPage({clock:{now:0},parent:{sdk:f.options.sdk},
    engineOptions:{...f.options,privateExploration:{...f.options.privateExploration,profile:HEADROOM_PROFILE}},inputBundle:f.input});
  try {
    const {nodes}=page;
    nodes['joint-kind'].value='Q';nodes['joint-kind'].onchange();
    nodes.amount.value='4';nodes.amount.oninput();await nodes.generate.onclick();
    assert.match(nodes.status.textContent,/波峰余量/);
    assert.match(nodes.status.textContent,/实际变化/);
    const version=page.workers[0].engine.current().available.at(-1);
    assert.ok(version.spectral_delta_scales.Q<1);
    assert.equal(version.metadata.control.intents[0].amount,4);
    assert.equal(version.metadata.spectral_delta_scales.Q,version.spectral_delta_scales.Q);
  }finally{page.dispose();}
});
