import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

class Element {
  constructor(){this.children=[];this._text='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.dataset={};this.style={};this.classList={toggle(){},add(){},remove(){}};}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(x=>x.textContent??'').join('');}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this._text='';this.children=items;}
  get options(){return this.children;}
  setAttribute(){} removeAttribute(){} addEventListener(){} pause(){} load(){} getContext(){return null;} showModal(){} close(){} remove(){} click(){return this.onclick?.();}
}
const profile='issue38-joint-shared-spectral-headroom-v1',method='metadata-exploration';
const motionRegion=kind=>kind==='solo'?[621,870]:[681,1046];
const normalDraft=kind=>{
  const [start_frame,end_frame]=motionRegion(kind);
  return {intents:[{kind:'M',start_frame,end_frame,amount:.5,mode:'flat',held:false}],preserve:[]};
};
const source={input_sha256:'b'.repeat(64),voice_sha256:'a'.repeat(64),mix_sha256:'b'.repeat(64),kind:'piano',method_version:method};
const version=(id,control)=>({id,sha256:'c'.repeat(64),bytes:new Uint8Array(),control,metadata:{source,result:{id},control}});
export const refusedPoint={schema:'voice-motion-limit-diagnostic-v1',frame:833,time_seconds:4.165,mode:'front',amount:.5,start_frame:681,end_frame:1046,
  sourceHz:226.6759787028638,targetHz:220.20696305979388,cents:-50.12571067607007,raw:-50.12571067607007,weight:1,residual:41.366677563834116,
  shifted_residual:null,shift_source_frame:null,support_start:null,support_end:null,finite:true,violations:{cents:true,frequency:false},thresholds:{absolute_cents:50,cents_epsilon:1e-9,min_target_hz:71,max_target_hz:800}};

export async function metadataApp({refuse=true,refuseAfter=0,kind='piano',initialDraft=normalDraft(kind),projects=new Map()}={}) {
  const base=new URL('../../issue42/',import.meta.url),page=readFileSync(new URL('page.py',base),'utf8');
  const nodes=Object.fromEntries([...page.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
  for(const [id,value] of Object.entries({'joint-kind':'T',amount:'6',start:'0',end:'1',development:'flat','listen-start':'0','listen-end':'1','piano-recipe':'U'}))nodes[id].value=value;
  nodes['joint-kind'].append(...['T','M','Q'].map(value=>Object.assign(new Element(),{value})));
  nodes.development.append(...['flat','front','back','shift'].map(value=>Object.assign(new Element(),{value})));
  nodes.local.checked=true;nodes.follow.checked=true;
  const calls={render:0,other:[],requests:[]};
  const inputSource={...source,kind,mix_sha256:kind==='piano'?source.mix_sha256:null};
  const makeVersion=(id,control)=>({...version(id,control),metadata:{schema:'voice-version-record-v1',source:inputSource,result:{id},control}});
  const original=makeVersion('O',null),baseline=makeVersion('U',{intents:[],preserve:[]}),old=makeVersion('old-E',initialDraft);
  const versions=new Map([[old.id,old]]);
  const next=(view={resultId:old.id,draft:initialDraft})=>({
    method_version:method,exploration_profile:profile,kind,input_sha256:inputSource.input_sha256,samples:352800,sample_rate:44100,
    source:{default_region:[100,1500],eligible_intervals:{M:[motionRegion(kind)],Q:[[100,1500]],T:[[100,1500]]}},
    motion_region:motionRegion(kind),control_limits:{M:.5,Q:2,T:6},
    original,baseline,available:[...versions.values()],result:versions.get(view.resultId),
    draft:structuredClone(view.draft),listening:view.listening,expires:Date.now()+3600000,
  });
  class Worker {
    postMessage(data){queueMicrotask(()=>{
      calls.other.push(data.type);calls.requests.push(structuredClone(data));
      let result;
      if(data.type==='initialize')result={joint:true,private_run:true};
      else if(data.type==='jointOpenPiano'||data.type==='jointOpen')result=next();
      else if(data.type==='jointRender'){
        calls.render++;
        if(refuse&&calls.render>refuseAfter){this.onmessage({data:{id:data.id,ok:false,error:'signed_motion_limit',motionLimit:refusedPoint}});return;}
        result=makeVersion('new-E-'+calls.render,structuredClone(data.draft));versions.set(result.id,result);
      }else if(data.type==='list')result=[];
      else if(data.type==='jointList')result=[...projects.keys()];
      else if(data.type==='jointSave'){
        projects.set(data.projectId,{view:structuredClone(data.view),version:versions.get(data.view.resultId)});
        result={id:data.projectId};
      }else if(data.type==='jointReopen'&&projects.has(data.projectId)){
        const saved=projects.get(data.projectId);
        if(saved.version)versions.set(saved.version.id,saved.version);
        result=next(saved.view);
      }else if(data.type==='jointCompare'){
        result={motion:{before:[],after:[]},quality:{before:{},after:{}},timbre:{before:[],after:[]},preservation:{}};
      }else if(data.type==='jointVersionRecord')result=versions.get(data.resultId)?.metadata;
      else{this.onmessage({data:{id:data.id,ok:false,error:'unexpected_metadata_rpc:'+data.type}});return;}
      this.onmessage({data:{id:data.id,ok:true,result}});
    });}
    terminate(){}
  }
  class MetadataURL extends URL {static createObjectURL(){return 'blob:metadata-only';}static revokeObjectURL(){}}
  const context=vm.createContext({console,URL:MetadataURL,URLSearchParams,Blob,Uint8Array,structuredClone,queueMicrotask,performance,crypto,Worker,
    document:{getElementById:id=>nodes[id],createElement:()=>new Element(),querySelectorAll:()=>[],addEventListener(){},body:new Element()},
    location:{search:'',href:'https://metadata.invalid/'},indexedDB:{},BroadcastChannel:class{postMessage(){}close(){}},
    setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({release:'metadata-only',joint:{enabled:true,private_run:true}})})});
  for(const name of ['HTMLInputElement','HTMLSelectElement','HTMLButtonElement','HTMLDialogElement','HTMLCanvasElement'])context[name]=Element;
  const modules=new Map();
  const actual=new Set(['app.mjs','state.mjs','joint/request_feasibility.mjs','joint/motion_limit.mjs','joint/exploration_profile.mjs','joint/intent_editor.mjs','joint/version_records.mjs','joint/completed_version_choice.mjs','joint/editing_scope.mjs']);
  const unused=name=>()=>{throw Error('unexpected_metadata_dependency:'+name);};
  async function module(url){
    if(modules.has(url.href))return modules.get(url.href);
    const code=readFileSync(url,'utf8');
    const loaded=new vm.SourceTextModule(code,{context,identifier:url.href,initializeImportMeta:meta=>{meta.url=url.href;}});modules.set(url.href,loaded);
    await loaded.link(async(specifier,reference)=>{
      const target=new URL(specifier,reference.identifier),rel=fileURLToPath(target).slice(fileURLToPath(base).length);
      if(actual.has(rel))return module(target);
      const names=[...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)].find(([, , path])=>path===specifier)?.[1].split(',').map(x=>x.trim()).filter(Boolean);
      if(!names)throw Error('unexpected_import:'+specifier);
      const overrides={createVersionRecords:()=>({add(){},reset(){}}),createIntentEditor:()=>({render(){},reset(){}}),
        isJointMethod:value=>value===method,isExplorationMethod:value=>value===method,isRegisteredPianoMethod:()=>false,isSoloPhaseMethod:()=>false,isSoloNoiseMethod:()=>false,
        comparisonPlaybackGain:()=>1,jointStorage:async()=>undefined,SHARED_HEADROOM_PROFILE:profile};
      const exports=Object.fromEntries(names.map(name=>[name,Object.hasOwn(overrides,name)?overrides[name]:name===name.toUpperCase()?name:unused(name)]));
      const synthetic=new vm.SyntheticModule(names,function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);},{context});await synthetic.link(()=>{throw Error('nested_mock_import');});return synthetic;
    });return loaded;
  }
  await (await module(new URL('app.mjs',base))).evaluate();
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};await flush();
  return {nodes,calls,flush,projects,
    async open(){
      const file=new Blob([]);file.name='metadata.bundle';
      const input=nodes['joint-'+kind+'-file'];input.files=[file];input.onchange();await flush();
    },
    async reopen(id){
      await nodes.saved.onclick();
      const row=nodes['saved-list'].children.find(x=>x.children[0].textContent===id);
      if(!row)throw Error('metadata_project_not_listed:'+id);
      row.children[1].click();await flush();
    },
    motion(mode){nodes['joint-kind'].value='M';nodes['joint-kind'].onchange();nodes.development.value=mode;nodes.development.onchange();},
  };
}
