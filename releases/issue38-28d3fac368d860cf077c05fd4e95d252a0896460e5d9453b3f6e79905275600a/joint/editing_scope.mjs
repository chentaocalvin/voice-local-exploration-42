// SPDX-License-Identifier: GPL-3.0-or-later
export const PRECISE_SHIFT_NOTICE='精确后移已延期。旧设置仍保留；可改为均匀、前半或后半展开，或撤回该项后继续。';
export const isPreciseShiftIntent=item=>['M','Q','T'].includes(item.kind)&&item.mode==='shift';
export const deferredEditingScope=draft=>draft.intents.some(item=>isPreciseShiftIntent(item)&&!item.held);
export function requireCurrentEditingScope(draft) {
  if(deferredEditingScope(draft))throw new Error('precise_shift_deferred');
  return draft;
}
