const amounts=Object.freeze({M:.25,Q:1,T:3});
const motion=Object.freeze({solo:[621,870],piano:[681,1046]});

function draft(kind,items,preserve=[]) {
  return {intents:items.map(([feature,amount,mode='flat'])=>{
    const [start_frame,end_frame]=feature==='M'?motion[kind]:[100,1500];
    return {kind:feature,amount,mode,held:false,start_frame,end_frame};
  }),preserve:structuredClone(preserve)};
}

function operation(kind,name,items,{preserve=[],compare=true,saveRole=null,expected=null}={}) {
  return {name,draft:draft(kind,items,preserve),compare,saveRole,expected};
}

export function fixedCombinationPlan(kind) {
  if(!Object.hasOwn(motion,kind))throw new Error('fixed_combination_kind');
  const triple=Object.entries(amounts);
  const singles=kind==='piano'?triple.flatMap(([feature,amount])=>[-1,1].map(sign=>
    operation(kind,'B-'+feature+(sign<0?'-':'+'),[[feature,sign*amount]]))):[];
  const removed=kind==='solo'?'Q':'T';
  const continued=[
    operation(kind,'withdraw-'+removed,triple.filter(([feature])=>feature!==removed),{preserve:[[0,100]]}),
    operation(kind,'restore-'+removed,triple,{preserve:[[0,100]],compare:false,expected:'seed'}),
  ];
  if(kind==='solo')for(const item of triple)
    continued.push(operation(kind,'base-'+item[0],[item]));
  for(const [feature,amount] of [['M',.1],['Q',.5],['T',1.5]])
    continued.push(operation(kind,'weak-'+feature,[[feature,amount]]));
  for(const [feature,amount] of triple)for(const mode of ['front','back','shift'])
    continued.push(operation(kind,feature+'-'+mode,[[feature,mode==='shift'?.25:amount,mode]]));
  continued.push(
    operation(kind,'other-pair',kind==='solo'?[['M',.25],['Q',1]]:[['M',.25],['T',3]]),
    operation(kind,'QT',[['Q',1],['T',3]]),
    operation(kind,'protection-conflict',triple,{preserve:[[0,100],[100,1500]],expected:'U'}),
    operation(kind,'MQT-Q-shift-final',[['M',.25],['Q',.25,'shift'],['T',3]],{preserve:[[0,100]],saveRole:'final'}),
  );
  return {compareColdSeed:false,
    initial:[...singles,operation(kind,'MQT-seed',triple,{preserve:[[0,100]],saveRole:'seed'})],continued};
}
