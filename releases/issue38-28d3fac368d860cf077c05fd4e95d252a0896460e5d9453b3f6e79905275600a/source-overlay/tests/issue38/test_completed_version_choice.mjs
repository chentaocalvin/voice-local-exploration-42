// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {completedVersionChoice,describeCompletedVersion} from '../../issue42/joint/completed_version_choice.mjs';

test('new completion preserves the current choice until the user selects it',()=>{
  const state={ids:['seed','new'],currentId:'seed',latestId:'new',available:true,busy:false,expired:false};
  assert.deepEqual(completedVersionChoice(state),{currentId:'seed',latestId:'new',choiceId:'new'});
  assert.equal(completedVersionChoice(state,'seed').choiceId,'seed');
  assert.equal(state.currentId,'seed');
});

test('busy, expired and unavailable projects reject both latest and history choices',()=>{
  const state={ids:['seed','new'],currentId:'seed',latestId:'new',available:true,busy:false,expired:false};
  for(const blocked of [{busy:true},{expired:true},{available:false}]) {
    assert.equal(completedVersionChoice({...state,...blocked}).choiceId,null);
    assert.equal(completedVersionChoice({...state,...blocked},'seed').choiceId,null);
  }
});

test('missing latest never falls back to another version and rebuilding history retains the real selection',()=>{
  const state={ids:['seed','new'],currentId:'seed',latestId:'removed',available:true,busy:false,expired:false};
  assert.deepEqual(completedVersionChoice(state),{currentId:'seed',latestId:null,choiceId:null});
  assert.deepEqual(completedVersionChoice({...state,ids:[]}),{currentId:'',latestId:null,choiceId:null});
  assert.equal(completedVersionChoice({...state,latestId:null}).choiceId,null);
  assert.equal(completedVersionChoice(state,'unseen').choiceId,null);
});

test('completed labels distinguish time development, position, held intents and every protection',()=>{
  const control={intents:[
    {kind:'M',amount:.5,mode:'front',start_frame:681,end_frame:1046,held:false},
    {kind:'Q',amount:2,mode:'back',start_frame:100,end_frame:1500,held:true},
    {kind:'T',amount:.25,mode:'shift',start_frame:100,end_frame:1500,held:false},
  ],preserve:[[0,100],[100,1500]]};
  assert.equal(describeCompletedVersion(control),
    '运动 0.5 · 前半展开 · 3.405–5.230秒；声质 2 · 后半展开 · 0.500–7.500秒 · 已撤回；音色 0.25 · 后移0.25秒 · 0.500–7.500秒 ｜ 保护：0.000–0.500秒、0.500–7.500秒');
  assert.equal(describeCompletedVersion({intents:[],preserve:[]}),'零意图 ｜ 无保护');
});
