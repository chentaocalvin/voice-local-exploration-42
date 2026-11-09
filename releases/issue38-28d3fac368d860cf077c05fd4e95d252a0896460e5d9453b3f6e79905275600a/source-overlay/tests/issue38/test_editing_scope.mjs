import test from 'node:test';
import assert from 'node:assert/strict';
import {isPreciseShiftIntent,deferredEditingScope,requireCurrentEditingScope} from '../../issue42/joint/editing_scope.mjs';

const item=(kind,mode,held=false)=>({kind,mode,held,amount:mode==='shift'?.25:.5,start_frame:100,end_frame:400});
test('new precise shift requests stop while their original controls stay intact',()=>{
 for(const kind of ['M','Q','T']) {
  const draft={intents:[item(kind,'shift')],preserve:[[0,100]]},before=structuredClone(draft);
  assert.equal(isPreciseShiftIntent(draft.intents[0]),true);
  assert.equal(deferredEditingScope(draft),true);
  assert.throws(()=>requireCurrentEditingScope(draft),/precise_shift_deferred/);
  assert.deepEqual(draft,before);
 }
});
test('supported developments and withdrawn legacy shifts keep their exact stored meaning',()=>{
 const draft={intents:[item('M','shift',true),item('Q','front'),item('T','back')],preserve:[[0,100]]};
 assert.equal(deferredEditingScope(draft),false);
 assert.equal(requireCurrentEditingScope(draft),draft);
 assert.equal(draft.intents[0].mode,'shift');
 for(const mode of ['flat','front','back'])assert.equal(deferredEditingScope({intents:[item('M',mode)]}),false);
 const mixed=structuredClone(draft);mixed.intents[0].held=false;
 assert.throws(()=>requireCurrentEditingScope(mixed),/precise_shift_deferred/);
});

test('zero amount does not reopen a deferred mode',()=>{
 const legacy={intents:[{...item('Q','shift'),amount:0}],preserve:[]};
 assert.throws(()=>requireCurrentEditingScope(legacy),/precise_shift_deferred/);
});
