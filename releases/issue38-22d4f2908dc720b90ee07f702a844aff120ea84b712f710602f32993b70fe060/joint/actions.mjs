// SPDX-License-Identifier: GPL-3.0-or-later
import { editableJointProject } from './engine.mjs';
import { exportJointArchive, readJointArchive, jointStorage } from './archive.mjs';

const recordingProjectId = 'J:recording-combination';
const recordingArchiveMax = 3 * 1024 * 1024;

export function createJointActions(engine, indexedDB, { recordingCombo = false } = {}) {
  const enabled = Boolean(engine);
  return {
    available: enabled,
    async dispatch(message) {
      switch (message.type) {
        case 'jointList': return jointStorage(indexedDB, 'list');
        case 'jointDelete': return jointStorage(indexedDB, 'delete', message.projectId);
        case 'jointClear': return jointStorage(indexedDB, 'clear');
        case 'jointReopen': {
          if (recordingCombo && message.projectId !== recordingProjectId) throw new Error('recording_archive_identity');
          const saved = await jointStorage(indexedDB, 'get', message.projectId);
          if (!saved) throw new Error('project_missing');
          if (recordingCombo && (!(saved.blob instanceof Blob) || !saved.blob.size || saved.blob.size > recordingArchiveMax)) {
            throw new Error('recording_archive_size');
          }
          if (!saved.blob) return editableJointProject(saved.view);
          if (!enabled) throw new Error('joint_runtime_unavailable');
          const restored = await engine.restore(await readJointArchive(saved.blob));
          return recordingCombo ? { ...restored, archive_bytes: saved.blob.size } : restored;
        }
      }
      if (!enabled) throw new Error('joint_runtime_unavailable');
      switch (message.type) {
        case 'jointOpen': {
          if (!message.blob) return engine.open({ voiceBytes: message.bytes });
          const { input, view } = await readJointArchive(message.blob);
          if (input.mixBytes || view.kind !== 'solo_input') throw new Error('solo_bundle_required');
          return engine.open(input);
        }
        case 'jointOpenPiano': {
          const { input, view } = await readJointArchive(message.blob);
          if (!input.mixBytes || view.kind !== 'piano_input') throw new Error('piano_bundle_required');
          return engine.open(input);
        }
        case 'jointRecordingMotionPreflight': return engine.preflightRecordingMotion(message.reference);
        case 'jointRender': return engine.render(message.draft, message.keepId);
        case 'jointCompare': return engine.compare(message.scope);
        case 'jointExport':
        case 'jointSave': {
          if (recordingCombo && (message.type !== 'jointSave' || message.projectId !== recordingProjectId)) {
            throw new Error('recording_archive_identity');
          }
          const { resultId, draft, listening } = message.view;
          const record = engine.capture(draft, listening, resultId);
          if (message.type === 'jointExport' && record.expires !== null) {
            return { blob: new Blob([JSON.stringify(record.view)], { type: 'application/json' }), metadataOnly: true };
          }
          const snapshot = await exportJointArchive(record);
          if (recordingCombo && (!snapshot.size || snapshot.size > recordingArchiveMax)) throw new Error('recording_archive_size');
          if (message.type === 'jointExport') return { blob: snapshot };
          if (typeof message.projectId !== 'string' || !message.projectId.startsWith('J:') ||
              message.projectId.length > 128) throw new Error('invalid_project_id');
          await jointStorage(indexedDB, 'add', message.projectId, { blob: snapshot, view: record.view, expires: record.expires });
          return { id: message.projectId, ...(recordingCombo ? { archive_bytes: snapshot.size } : {}) };
        }
        case 'jointImport': return engine.restore(await readJointArchive(message.blob));
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
