// SPDX-License-Identifier: GPL-3.0-or-later
export function createWorkspace() {
  let epoch = 0;
  let sequence = 0;
  let state = null;
  return {
    open(projectId, draft, selected) {
      epoch++;
      state = { projectId, revision: 0, draft: structuredClone(draft), selected: structuredClone(selected), pending: null };
    },
    edit(control) {
      if (!state) throw new Error('project_missing');
      state.revision++;
      state.draft = structuredClone(control);
    },
    begin() {
      if (!state) throw new Error('project_missing');
      const request = { epoch, sequence: ++sequence, revision: state.revision, control: structuredClone(state.draft) };
      state.pending = request;
      return structuredClone(request);
    },
    finish(request, result) {
      if (!state || request.epoch !== epoch || request.sequence !== state.pending?.sequence) return false;
      state.pending = null;
      if (request.revision !== state.revision) return false;
      state.selected = structuredClone(result);
      return true;
    },
    close() { epoch++; state = null; },
    view() { return structuredClone(state); },
  };
}
