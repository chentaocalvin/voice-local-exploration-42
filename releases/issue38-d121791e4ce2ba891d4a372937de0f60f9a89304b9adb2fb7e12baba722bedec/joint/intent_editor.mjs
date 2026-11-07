// SPDX-License-Identifier: GPL-3.0-or-later
const names={M:'声音运动',Q:'声质',T:'音色'};
const developments={flat:'均匀',front:'前半展开',back:'后半展开',shift:'将原变化后移0.25秒'};
const location=item=>`${(item.start_frame/200).toFixed(3)}–${(item.end_frame/200).toFixed(3)} 秒`;

// This controller organizes the existing draft; compilers still decide eligibility.
export function createIntentEditor({document,getDraft,commit,canEdit,selectKind}) {
  const list=document.getElementById('intent-list');
  const removedList=document.getElementById('removed-intents');
  const protections=document.getElementById('protection-list');
  const removed=new Map();
  const change=operation=>{
    if(!canEdit()) return;
    const draft=getDraft();operation(draft);commit(draft);
  };
  function action(label,operation,disabled=false) {
    const button=document.createElement('button');button.type='button';button.textContent=label;
    button.disabled=disabled||!canEdit();button.onclick=operation;return button;
  }
  return {
    reset(){removed.clear();},
    render(draft) {
      list.replaceChildren();removedList.replaceChildren();protections.replaceChildren();
      if(!draft?.intents) return;
      for(const [index,item] of draft.intents.entries()) {
        removed.delete(item.kind);
        const row=document.createElement('li'),label=document.createElement('span');
        row.dataset.kind=item.kind;
        label.textContent=`${names[item.kind]} · ${location(item)} · ${item.amount} · ${developments[item.mode]}${item.held?' · 已撤回':''} `;
        row.append(label,action('编辑',()=>selectKind(item.kind)),
          action(item.held?'恢复':'撤回',()=>change(next=>{
            const current=next.intents.find(value=>value.kind===item.kind);current.held=!current.held;
          })),
          action('上移',()=>change(next=>{[next.intents[index-1],next.intents[index]]=[next.intents[index],next.intents[index-1]];}),index===0),
          action('下移',()=>change(next=>{[next.intents[index+1],next.intents[index]]=[next.intents[index],next.intents[index+1]];}),index===draft.intents.length-1),
          action('删除',()=>change(next=>{
            const current=next.intents.findIndex(value=>value.kind===item.kind);
            removed.set(item.kind,{item:next.intents[current],index:current});next.intents.splice(current,1);
          })));
        list.append(row);
      }
      for(const [kind,saved] of removed) {
        const row=document.createElement('li'),label=document.createElement('span');
        label.textContent=`已删除${names[kind]} · ${location(saved.item)}（仅本次打开可撤销） `;
        row.append(label,action('恢复已删除项',()=>change(next=>{
          if(next.intents.some(item=>item.kind===kind)) return;
          next.intents.splice(Math.min(saved.index,next.intents.length),0,structuredClone(saved.item));removed.delete(kind);
        })));removedList.append(row);
      }
      for(const [index,[start,end]] of draft.preserve.entries()) {
        const row=document.createElement('li'),label=document.createElement('span');
        label.textContent=`${(start/200).toFixed(3)}–${(end/200).toFixed(3)} 秒 · 全部编辑类 `;
        row.append(label,action('撤销此保留',()=>change(next=>{next.preserve.splice(index,1);})));protections.append(row);
      }
    },
  };
}
