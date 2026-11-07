// SPDX-License-Identifier: GPL-3.0-or-later
import {caps} from './private_run_receipt.mjs';
import {EXPLORATION_PROFILE,EXPLORATION_CAPS} from './exploration_profile.mjs';
const labels={praat:'音高检查',world_analysis:'参数分析',synthesize:'合成',cpps:'CPPS测量',hnr:'HNR测量',
  stft:'频谱计算',make_version:'版本预扣',compare:'比较',save:'保存',open:'打开',audio_read:'声音样本读取'};

export function describePrivateUsage(report) {
  const counts=report?.counts??report;
  const counterCaps=report?.profile===EXPLORATION_PROFILE?EXPLORATION_CAPS:caps;
  const lines=['以下为实际累计预扣；预扣不代表已生成成功声音，失败不会退回额度。'];
  if(report?.ended===true) lines.push('本次账本已结束。');
  for(const input of ['solo','piano']) {
    lines.push(input==='solo'?'独唱':'带琴');
    for(const [kind,limit] of Object.entries(counterCaps[input])) {
      const used=counts?.[input]?.[kind];
      if(!Number.isSafeInteger(used)||used<0||used>limit) throw new Error('private_run_ledger');
      lines.push(`${labels[kind]}：${used} / ${limit}，剩余 ${limit-used}`);
    }
  }
  return lines.join('\n');
}
