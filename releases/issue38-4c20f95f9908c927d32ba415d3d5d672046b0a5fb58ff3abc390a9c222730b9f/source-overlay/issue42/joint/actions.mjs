// SPDX-License-Identifier: GPL-3.0-or-later
import { editableJointProject } from './engine.mjs';
import { exportJointArchive, readJointArchive, jointStorage, listPrivateArchives } from './archive.mjs';
import {explorationMethodFor,validateExplorationSetup,explorationProjectId,
  explorationArchiveBinding,sameArchiveBinding} from './exploration_profile.mjs';

const recordingProjectId = 'J:recording-combination';
const recordingArchiveMax = 3 * 1024 * 1024;

export function createJointActions(engine, indexedDB, { recordingCombo = false,privateArchive=null,resourceReserve=null } = {}) {
  const enabled = Boolean(engine);
  const grant=privateArchive===null?null:structuredClone(validateExplorationSetup(privateArchive));
  const owned=grant?['solo','piano'].flatMap(kind=>['seed','final'].map(role=>
    ({kind,role,id:explorationProjectId(grant.run.id,kind,role)}))):[];
  const ownedProject=id=>{
    const target=owned.find(item=>item.id===id);
    if(!target)throw new Error('private_archive_identity');
    return target;
  };
  const readArchive=async(blob,kind)=>{
    if(grant) {
      if(!(blob instanceof Blob)||!blob.size||blob.size>(kind==='solo'?1024*1024:3*1024*1024))
        throw new Error('private_archive_size');
      if(typeof resourceReserve!=='function')throw new Error('private_run_event');
      await resourceReserve({kind:'audio_read',input_sha256:kind==='solo'?grant.solo.sourceSha256:grant.piano.voiceSha256,
        samples:Math.ceil(blob.size*3/2)});
    }
    return readJointArchive(blob);
  };
  return {
    available: enabled,
    async dispatch(message) {
      switch (message.type) {
        case 'jointList': return grant?listPrivateArchives(indexedDB,owned.map(item=>item.id)):jointStorage(indexedDB, 'list');
        case 'jointDelete':
          if(grant)ownedProject(message.projectId);
          return jointStorage(indexedDB, 'delete', message.projectId);
        case 'jointClear':
          if(grant)throw new Error('private_setup_project_clear');
          return jointStorage(indexedDB, 'clear');
        case 'jointReopen': {
          const target=grant?ownedProject(message.projectId):null;
          if (recordingCombo && message.projectId !== recordingProjectId) throw new Error('recording_archive_identity');
          const saved = await jointStorage(indexedDB, 'get', message.projectId);
          if (!saved) throw new Error('project_missing');
          if(target&&(!sameArchiveBinding(saved.privateRun,explorationArchiveBinding(grant,target.kind,target.role))||
              saved.expires!==grant.run.expires||saved.view?.method!==explorationMethodFor(grant.profile,target.kind)))
            throw new Error('private_archive_identity');
          if (recordingCombo && (!(saved.blob instanceof Blob) || !saved.blob.size || saved.blob.size > recordingArchiveMax)) {
            throw new Error('recording_archive_size');
          }
          if (!saved.blob) return editableJointProject(saved.view);
          if (!enabled) throw new Error('joint_runtime_unavailable');
          const restored = await engine.restore(await readArchive(saved.blob,target?.kind));
          return recordingCombo ? { ...restored, archive_bytes: saved.blob.size } : restored;
        }
      }
      if (!enabled) throw new Error('joint_runtime_unavailable');
      switch (message.type) {
        case 'jointOpen': {
          if (!message.blob) return engine.open({ voiceBytes: message.bytes });
          const { input, view } = await readArchive(message.blob,'solo');
          if (input.mixBytes || view.kind !== 'solo_input') throw new Error('solo_bundle_required');
          return engine.open(input);
        }
        case 'jointOpenPiano': {
          const { input, view } = await readArchive(message.blob,'piano');
          if (!input.mixBytes || view.kind !== 'piano_input') throw new Error('piano_bundle_required');
          return engine.open(input);
        }
        case 'jointRecordingMotionPreflight': return engine.preflightRecordingMotion(message.reference);
        case 'jointVersionRecord': return engine.versionRecord(message.resultId);
        case 'jointRender': return engine.render(message.draft, message.keepId);
        case 'jointCompare': return engine.compare(message.scope);
        case 'jointExport':
        case 'jointSave': {
          if (recordingCombo && (message.type !== 'jointSave' || message.projectId !== recordingProjectId)) {
            throw new Error('recording_archive_identity');
          }
          const { resultId, draft, listening } = message.view;
          if(grant&&message.type==='jointExport')return {
            blob:new Blob([JSON.stringify(engine.versionRecord(resultId))],{type:'application/json'}),metadataOnly:true};
          let privateRun;
          if(grant) {
            const target=ownedProject(message.projectId);
            if(message.saveRole!==target.role)throw new Error('private_archive_identity');
            const metadata=engine.versionRecord(resultId),source=metadata.source;
            const expected=target.kind==='solo'?grant.solo.sourceSha256:grant.piano.voiceSha256;
            if(source.kind!==target.kind||source.voice_sha256!==expected||
              source.method_version!==explorationMethodFor(grant.profile,target.kind)||source.samples!==352800||source.sample_rate!==44100||
              (target.kind==='piano'&&source.mix_sha256!==grant.piano.mixSha256))throw new Error('private_archive_identity');
            privateRun=explorationArchiveBinding(grant,target.kind,target.role);
            await engine.reserveSave();
          }
          const record = engine.capture(draft, listening, resultId);
          if(grant&&record.expires!==grant.run.expires)throw new Error('private_archive_identity');
          if (message.type === 'jointExport' && record.expires !== null) {
            return { blob: new Blob([JSON.stringify(record.view)], { type: 'application/json' }), metadataOnly: true };
          }
          const snapshot = await exportJointArchive(record);
          if(grant&&snapshot.size>(privateRun.kind==='solo'?1024*1024:3*1024*1024))throw new Error('private_archive_size');
          if (recordingCombo && (!snapshot.size || snapshot.size > recordingArchiveMax)) throw new Error('recording_archive_size');
          if (message.type === 'jointExport') return { blob: snapshot };
          if (typeof message.projectId !== 'string' || !message.projectId.startsWith('J:') ||
              message.projectId.length > 128) throw new Error('invalid_project_id');
          await jointStorage(indexedDB, 'add', message.projectId, { blob: snapshot, view: record.view, expires: record.expires,
            ...(privateRun?{privateRun}:{}) });
          return { id: message.projectId, ...(recordingCombo ? { archive_bytes: snapshot.size } : {}) };
        }
        case 'jointImport':
          if(grant)throw new Error('private_setup_project_import');
          return engine.restore(await readJointArchive(message.blob));
        default: throw new Error('invalid_joint_request');
      }
    },
  };
}

export async function optionalJointActions(factory, indexedDB, options) {
  try {
    return { actions: createJointActions(await factory(), indexedDB, options), error: null };
  } catch (error) {
    return { actions: createJointActions(null, indexedDB, options),
      error: error instanceof Error ? error.message : 'joint_runtime_unavailable' };
  }
}
