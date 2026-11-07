import assert from 'node:assert/strict';
import test from 'node:test';
import {createEngine} from '../../issue42/engine.mjs';
import {makeProject,saveProject,reopenProject} from '../../issue42/projects.mjs';
import {reservePublicProbe,publicProbeReport,closePublicProbe,PUBLIC_PROBE_SOURCE,PUBLIC_PROBE_SAMPLES} from '../../issue42/joint/public_probe.mjs';
import {probeStorage,probeRecording,probeSdk} from './public_probe_fixture.mjs';

async function edited() {
  const boundary=probeSdk(),engine=createEngine({sdk:boundary.sdk}),input=probeRecording();
  const opened=await engine.analyze(input),[start_frame,end_frame]=opened.source.default_region;
  const control={start_frame,end_frame,amount:3,mode:'flat'},result=await engine.render(control);
  const view={resultId:result.id,draftControl:control,listening:{start:.5,end:1.5,mode:'local',selected:'E'}};
  return {boundary,engine,input,opened,result,view};
}

test('normal engine-owned save and full cold reopen preserve exact U/result and draft with zero new SDK calls',async()=>{
  const {engine,input,opened,result,view}=await edited(),db=probeStorage(),original=result.sha256;
  const saving=engine.saveLocal(db,'owned',view);
  view.draftControl.amount=-3;input[44]^=1;opened.original.bytes[44]^=1;result.bytes[44]^=1;
  await saving;engine.close();
  const cold=probeSdk(),reopened=createEngine({sdk:cold.sdk}),restored=await reopened.reopenLocal(db,'owned');
  assert.equal(restored.result.sha256,original);assert.equal(restored.baseline.sha256,opened.baseline.sha256);
  assert.equal(restored.draft.amount,3);assert.deepEqual(cold.calls,{praat:0,world:0,synthesize:0});
  const auditBefore=reopened.audit();
  const identity=reopened.versionRecord(restored.result.id);
  assert.equal(identity.result.sha256,original);
  assert.deepEqual(identity.region,[view.draftControl.start_frame,view.draftControl.end_frame]);
  assert.equal(identity.source.input_sha256,restored.input_sha256);
  assert.doesNotMatch(JSON.stringify(identity),/"(?:bytes|parent|sp|ap|key|blob)"/);
  assert.deepEqual(reopened.audit(),auditBefore);
  identity.region[0]=0;
  assert.equal(reopened.versionRecord(restored.result.id).region[0],view.draftControl.start_frame);
  restored.result.bytes[44]^=1;restored.baseline.bytes[44]^=1;
  const privateSnapshot=await reopened.snapshot({...view,resultId:restored.result.id});
  assert.equal(privateSnapshot.resultSha256,original);
});

test('closing during asynchronous capture rejects the stale save; a stale cold load cannot replace live state',async()=>{
  const {engine,view}=await edited(),db=probeStorage();
  const stale=engine.saveLocal(db,'stale',view);engine.close();
  await assert.rejects(stale,/stale_request/);await assert.rejects(reopenProject(db,'stale'),/project_missing/);
  const next=await edited();await next.engine.saveLocal(db,'valid',next.view);
  const release=db.pauseNextRead(),loading=next.engine.reopenLocal(db,'valid');next.engine.close();release();
  await assert.rejects(loading,/stale_request/);
});

test('mutated stored PCM is rejected and externally authorized ordinary records cannot claim the owned shortcut',async()=>{
  const {engine,view}=await edited(),db=probeStorage();await engine.saveLocal(db,'owned',view);
  db.tamper('voice-local-projects-v1','projects','owned',record=>{record.result[44]^=1;return record;});
  await assert.rejects(engine.reopenLocal(db,'owned'),/project_identity_mismatch/);
  const record=await makeProject(await engine.snapshot(view));
  await assert.rejects(saveProject(db,'ordinary',record,async()=>false),/snapshot_not_issued/);
  await saveProject(db,'ordinary',record,async()=>true);
  assert.ok(await reopenProject(db,'ordinary'));
  await assert.rejects(engine.reopenLocal(db,'ordinary'),/project_not_engine_owned/);
});

test('anonymous probe counters are persistent and keep foreign sources, extra SDK/render and mismatched reopen closed',async()=>{
  const db=probeStorage(),release='probe-fixture';
  await reservePublicProbe(db,release,{kind:'analyze'});
  await reservePublicProbe(db,release,{kind:'audio_read',slot:'input-identity',input_sha256:null,samples:PUBLIC_PROBE_SAMPLES});
  for(const kind of ['praat','harvest','cheaptrick','d4c'])await reservePublicProbe(db,release,{kind,input_sha256:PUBLIC_PROBE_SOURCE});
  await assert.rejects(reservePublicProbe(db,release,{kind:'praat',input_sha256:PUBLIC_PROBE_SOURCE}),/public_probe_cap/);
  await assert.rejects(reservePublicProbe(db,release,{kind:'synthesize',input_sha256:PUBLIC_PROBE_SOURCE}),/public_probe_cap/);
  await assert.rejects(reservePublicProbe(db,release,{kind:'audio_read',samples:1,input_sha256:'a'.repeat(64)}),/public_probe_source/);
  await reservePublicProbe(db,release,{kind:'render'});await assert.rejects(reservePublicProbe(db,release,{kind:'render'}),/public_probe_cap/);
  await reservePublicProbe(db,release,{kind:'save',project_id:'one'});
  await assert.rejects(reservePublicProbe(db,release,{kind:'reopen',project_id:'other'}),/public_probe_project/);
  await reservePublicProbe(db,release,{kind:'reopen',project_id:'one'});
  const report=await publicProbeReport(db,release);assert.equal(report.counts.praat,1);assert.equal(report.counts.reopen,1);
  await closePublicProbe(db,release);const closed=await publicProbeReport(db,release);
  assert.equal(closed.closed,true);assert.equal(closed.source_sha256,PUBLIC_PROBE_SOURCE);
  assert.deepEqual(closed.counts,report.counts);
  await assert.rejects(reservePublicProbe(db,release,{kind:'analyze'}),/public_probe_closed/);
  await assert.rejects(publicProbeReport(db,'different-release'),/public_probe_ledger/);
});
