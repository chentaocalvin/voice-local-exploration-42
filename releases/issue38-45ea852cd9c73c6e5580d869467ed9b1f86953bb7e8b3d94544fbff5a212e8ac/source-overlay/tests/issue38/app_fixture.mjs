import {readFileSync} from 'node:fs';
import {createJointEngine} from '../../issue42/joint/engine.mjs';
import {createJointActions} from '../../issue42/joint/actions.mjs';
import {exportJointArchive} from '../../issue42/joint/archive.mjs';
import {memoryIndexedDB} from './memory_indexeddb.mjs';
import {enrollPrivateRun,openPrivateRun} from '../../issue42/joint/private_run.mjs';
import {privateRunReceipt} from '../../issue42/joint/private_run_receipt.mjs';
import {worldRawLength} from '../../issue42/world.mjs';

// Same four-second SDK0 parent as test_engine.mjs; no real SDK or media I/O.
export function syntheticParent() {
  const frames=801,samples=176400;
  const bytes=new Uint8Array(44+samples*2),view=new DataView(bytes.buffer);
  const label=(at,value)=>bytes.set(new TextEncoder().encode(value),at);
  label(0,'RIFF');view.setUint32(4,bytes.length-8,true);label(8,'WAVE');label(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,44100,true);view.setUint32(28,88200,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  label(36,'data');view.setUint32(40,samples*2,true);view.setInt16(44,8192,true);
  const f0=Float64Array.from({length:frames},(_,i)=>300*2**(20*Math.sin(2*Math.PI*.03*i)/1200));
  const time=Float64Array.from({length:frames},(_,i)=>i*.005);
  const sp=new Float64Array(frames*1025).fill(1),ap=new Float64Array(sp.length).fill(.2);
  return {bytes,sdk:{analyze:()=>({frames,time,f0,sp,ap}),
    pitch:()=>Array.from(time,(t,i)=>({time:t,hz:f0[i],undefined:false})),
    synthesize:({sp:next})=>new Float64Array(worldRawLength(frames)).fill(next===sp?0:.25)}};
}

class Element {
  constructor(tag='div') {this.tagName=tag;this.children=[];this._text='';this.type='';this._min='';this._max='';this._step='';this._value='';this.checked=false;
    this.hidden=false;this.disabled=false;this.dataset={};this.classList={toggle(){}};this.style={};}
  get value(){return this._value;}
  set value(value){this._value=String(value);this.sanitizeRange();}
  get min(){return this._min;} set min(value){this._min=String(value);this.sanitizeRange();}
  get max(){return this._max;} set max(value){this._max=String(value);this.sanitizeRange();}
  get step(){return this._step;} set step(value){this._step=String(value);this.sanitizeRange();}
  sanitizeRange() {
    if(this.type!=='range')return;
    const minimum=this._min!==''&&Number.isFinite(Number(this._min))?Number(this._min):0;
    const maximum=Math.max(minimum,this._max!==''&&Number.isFinite(Number(this._max))?Number(this._max):100);
    let value=this._value!==''&&Number.isFinite(Number(this._value))?Number(this._value):(minimum+maximum)/2;
    value=Math.max(minimum,Math.min(maximum,value));
    if(this._step!=='any') {
      const step=Number(this._step)>0?Number(this._step):1;
      value=minimum+Math.round((value-minimum)/step)*step;
      if(value>maximum)value=minimum+Math.floor((maximum-minimum)/step)*step;
    }
    this._value=String(Number(value.toPrecision(12)));
  }
  set textContent(value) {this._text=String(value);this.children=[];}
  get textContent() {return this._text+this.children.map(node=>node.textContent??'').join('');}
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this._text='';this.children=nodes;}
  get options() {return this.children;}
  setAttribute() {}
  removeAttribute(name) {this[name]='';}
  addEventListener() {}
  pause() {this.paused=true;}
  load() {this.loaded=true;}
  remove() {}
  getContext() {return null;} showModal() {} close() {} click() {return this.onclick?.();}
}
export async function boundPrivateRun(db,release,now=Date.now()) {
  const {recipient}=await enrollPrivateRun(db,release);
  const setup={release,solo:{sourceSha256:'a'.repeat(64),expires:now+20000},
    piano:{voiceSha256:'b'.repeat(64),expires:now+30000},
    run:{id:'f'.repeat(64),recipient,not_before:now,expires:now+10000}};
  return {setup,run:await openPrivateRun(db,setup,()=>now)};
}

let sequence=0;
export async function appPage({usage=null,autoOpen=true,privateSetup=null,clock=null,db=memoryIndexedDB(),parent:providedParent=null,engineOptions={},inputBundle=null}={}) {
  const saved=new Map(),release='synthetic';
  function set(name,value) {saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});}
  if(usage) {
    const {setup,run}=await boundPrivateRun(db,release,clock?.now??Date.now());
    for(const input of ['solo','piano']) for(const [kind,count] of Object.entries(usage.counts[input])) {
      const input_sha256=input==='solo'?setup.solo.sourceSha256:setup.piano.voiceSha256;
      if(kind==='audio_read') {if(count)await run.reserve({kind,input_sha256,samples:count});}
      else for(let i=0;i<count;i++)await run.reserve({kind,input_sha256});
    }
    if(usage.ended)await run.end();
  }
  if(privateSetup) db.seed('voice-local-private-setup-v1','setup','signed',
    {id:'fixture-setup',expires:privateSetup.run.expires,blob:new Blob(['synthetic signed setup boundary'])});
  const privateMode=Boolean(usage||privateSetup);
  const page=readFileSync(new URL('../../issue42/page.py',import.meta.url),'utf8');
  const nodes=Object.fromEntries([...page.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([,tag,attributes,id])=>{
    const node=new Element(tag);
    if(tag==='input') for(const name of ['type','min','max','step','value']) {
      const value=attributes.match(new RegExp('\\b'+name+'="([^"]*)"'))?.[1];
      if(value!==undefined)node[name]=value;
    }
    return [id,node];
  }));
  for (const [id,value] of Object.entries({'joint-kind':'T',amount:'6',start:'0',end:'1',development:'flat',
    'listen-start':'0','listen-end':'1','piano-recipe':'U'})) nodes[id].value=value;
  nodes['joint-kind'].append(...['T','M','Q'].map(value=>Object.assign(new Element('option'),{value})));
  nodes.development.append(...['flat','front','back','shift'].map(value=>Object.assign(new Element('option'),{value})));
  nodes.local.checked=nodes.follow.checked=true;
  const parent=providedParent??syntheticParent(),events=[],messages=[],downloads=[],workers=[],broadcasts=[];
  const listeners=new Map();
  const document={getElementById:id=>nodes[id],createElement:tag=>{
    const node=new Element(tag);
    if(tag==='a') node.click=()=>downloads.push({name:node.download,blob:blobs.get(node.href)});
    return node;},body:new Element(),querySelectorAll:()=>[],
    addEventListener(type,listener){listeners.set(type,listener);},visibilityState:'visible',
    dispatch(type){listeners.get(type)?.();}};
  const blobs=new Map();let url=0;
  class Worker {
    constructor() {this.engine=createJointEngine({...engineOptions,sdk:parent.sdk,reserve:async event=>events.push(event)});
      this.actions=createJointActions(this.engine,db);this.installed=false;workers.push(this);}
    postMessage(data) {messages.push(data);Promise.resolve().then(async()=>{
      try {
        let result;
        if(data.type==='initialize') result={joint:true,...(privateMode?{private_setup:true,private_run:true}:{})};
        else if(data.type==='jointInstallPrivateSetup') {
          this.installed=true;result={installed:true,run_id:privateSetup.run.id,run_expires:privateSetup.run.expires};
        } else if(data.type==='jointPrivateRunReport') result=await privateRunReceipt(db,release,'report');
        else if(data.type==='jointEndPrivateRun') result={...await privateRunReceipt(db,release,'end'),
          ledger_ended:true,archive_cleanup:'unverified'};
        else if(data.type==='list') result=[];
        else if(data.type==='jointList'&&privateSetup) result=['J:fixture-private'];
        else if(data.type==='jointReopen'&&privateSetup) {
          if(!this.installed)throw Error('private_setup_required');
          result=await this.engine.open({voiceBytes:parent.bytes});
        } else result=await this.actions.dispatch(data);
        if(privateSetup&&this.installed&&['jointOpen','jointReopen'].includes(data.type)) result={...result,expires:privateSetup.run.expires};
        this.onmessage({data:{id:data.id,ok:true,result}});
      } catch(error) {this.onmessage({data:{id:data.id,ok:false,error:error.message}});}
    });}
    terminate() {this.terminated=true;this.engine.close();}
  }
  for(const name of ['HTMLInputElement','HTMLSelectElement','HTMLButtonElement','HTMLDialogElement','HTMLCanvasElement']) set(name,Element);
  set('document',document);set('location',{search:'',href:'https://example.invalid/',origin:'https://example.invalid'});
  const realSetTimeout=globalThis.setTimeout,timers=new Set();
  if(clock) {const RealDate=globalThis.Date;set('Date',class extends RealDate {static now(){return clock.now;}});}
  set('setTimeout',(callback,delay,...args)=>{
    if(delay===60000){callback(...args);return 0;}
    if(clock&&delay!==600000)return 0;
    const timer=realSetTimeout(callback,delay,...args);timers.add(timer);return timer;
  });
  set('Worker',Worker);set('indexedDB',db);
  set('BroadcastChannel',class {postMessage(value){broadcasts.push(value);} close(){}});
  set('fetch',async()=>({ok:true,json:async()=>({release,joint:{enabled:true,...(privateMode?{private_setup:true,private_run:true}:{})}})}));
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  URL.createObjectURL=blob=>{const id='blob:'+ ++url;blobs.set(id,blob);return id;};URL.revokeObjectURL=id=>blobs.delete(id);
  const waitFor=async predicate=>{for(let i=0;i<100;i++){await new Promise(resolve=>setImmediate(resolve));if(predicate())return;}
    throw Error(nodes.status.textContent);};
  const dispose=()=>{for(const worker of workers)worker.terminate();for(const timer of timers)clearTimeout(timer);
    URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;
    for(const [name,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}};
  try {
    await import('../../issue42/app.mjs?dom='+ ++sequence);
    await new Promise(resolve=>setImmediate(resolve));
    if(autoOpen) {
      const file=inputBundle?await exportJointArchive({input:inputBundle,view:{kind:'solo_input'}}):new Blob([parent.bytes]);file.name='synthetic.wav';nodes['joint-solo-file'].files=[file];
      nodes['joint-solo-file'].onchange();await waitFor(()=>nodes.status.textContent.includes('独唱已就绪'));
    }
    return {nodes,events,messages,downloads,workers,document,db,broadcasts,waitFor,dispose,
      async flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}};
  } catch(error) {dispose();throw error;}
}
