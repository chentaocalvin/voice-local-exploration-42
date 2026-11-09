// Proposed acceptance requests only; never product defaults or execution authorization.
// saveRole is a checkpoint; real UI execution still waits for its human gate.
const amounts=Object.freeze({M:.5,Q:2,T:6});
const motion=Object.freeze({solo:[621,870],piano:[681,1046]});

function draft(kind,items,preserve=[]) {
  return {intents:items.map(([feature,amount,mode='flat',held=false])=>{
    const [start_frame,end_frame]=feature==='M'?motion[kind]:[100,1500];
    return {kind:feature,amount,mode,held,start_frame,end_frame};
  }),preserve:structuredClone(preserve)};
}

function operation(kind,name,items,{preserve=[],compare=true,saveRole=null,saveSelection=null,expected=null}={}) {
  return {name,draft:draft(kind,items,preserve),compare,saveRole,...(saveSelection?{saveSelection}:{}),expected};
}

export function fixedCombinationPlan(kind) {
  if(!Object.hasOwn(motion,kind))throw new Error('fixed_combination_kind');
  const triple=Object.entries(amounts);
  const singles=kind==='piano'?triple.flatMap(([feature,amount])=>[-1,1].map(sign=>
    operation(kind,'B-'+feature+(sign<0?'-':'+'),[[feature,sign*amount]]))):[];
  const removed=kind==='solo'?'Q':'T';
  const continued=[
    operation(kind,'withdraw-'+removed,triple.map(([feature,amount])=>[feature,amount,'flat',feature===removed]),{preserve:[[0,100]]}),
    operation(kind,'restore-'+removed,triple,{preserve:[[0,100]],compare:false,expected:'seed'}),
  ];
  if(kind==='solo')for(const item of triple)
    continued.push(operation(kind,'base-'+item[0],[item]));
  const weaker=triple.map(([feature,amount])=>operation(kind,'weak-'+feature,[[feature,amount/2]]));
  if(kind==='solo')continued.push(...weaker);
  for(const [feature,amount] of triple)for(const mode of ['front','back','shift'])
    continued.push(operation(kind,feature+'-'+mode,[[feature,mode==='shift'?.25:amount,mode]]));
  continued.push(
    operation(kind,'other-pair',triple.filter(([feature])=>feature!==(kind==='solo'?'T':'Q'))),
    operation(kind,'QT',triple.filter(([feature])=>feature!=='M')),
    operation(kind,'protection-conflict',triple,{preserve:[[0,100],[100,1500]],expected:'U'}),
    operation(kind,'MQT-Q-shift-check',[['M',amounts.M],['Q',.25,'shift'],['T',amounts.T]],{preserve:[[0,100]],saveRole:'final',saveSelection:'listener-choice'}),
  );
  return {compareColdSeed:false,
    initial:[operation(kind,'MQT-seed',triple,{preserve:[[0,100]],saveRole:'seed'}),...singles,...(kind==='piano'?weaker:[])],continued};
}
