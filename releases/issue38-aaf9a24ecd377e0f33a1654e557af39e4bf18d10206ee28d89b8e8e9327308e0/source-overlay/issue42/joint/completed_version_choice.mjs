// SPDX-License-Identifier: GPL-3.0-or-later
export function completedVersionChoice({ids,currentId,latestId,available,busy,expired},requestedId=latestId) {
  const present=new Set(ids);
  return {currentId:present.has(currentId)?currentId:'',latestId:present.has(latestId)?latestId:null,
    choiceId:available&&!busy&&!expired&&present.has(requestedId)?requestedId:null};
}

const names={M:'运动',Q:'声质',T:'音色'};
const modes={flat:'均匀',front:'前半展开',back:'后半展开',shift:'后移0.25秒'};
const interval=([start,end])=>`${(start/200).toFixed(3)}–${(end/200).toFixed(3)}秒`;

export function describeCompletedVersion({intents,preserve}) {
  const edits=intents.map(item=>`${names[item.kind]} ${item.amount} · ${modes[item.mode]} · ${interval([item.start_frame,item.end_frame])}${item.held?' · 已撤回':''}`);
  const protections=preserve.length?'保护：'+preserve.map(interval).join('、'):'无保护';
  return (edits.join('；')||'零意图')+' ｜ '+protections;
}
