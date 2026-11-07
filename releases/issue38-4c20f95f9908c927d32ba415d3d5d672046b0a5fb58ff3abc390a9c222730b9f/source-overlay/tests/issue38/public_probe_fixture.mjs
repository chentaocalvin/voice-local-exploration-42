// External browser storage boundary with atomic, serial transactions.
export function probeStorage() {
  const databases=new Map();let pause=null;
  return {
    pauseNextRead(){let release;pause=new Promise(resolve=>{release=resolve;});return release;},
    tamper(database,store,id,change){const rows=databases.get(database).stores.get(store);rows.set(id,change(structuredClone(rows.get(id))));},
    open(name) {
      const request={};queueMicrotask(()=>{
        const fresh=!databases.has(name);
        if(fresh)databases.set(name,{stores:new Map(),pending:Promise.resolve()});
        const data=databases.get(name);let upgradeAborted=false;
        request.transaction={abort(){upgradeAborted=true;}};
        request.result={close(){},objectStoreNames:{contains:key=>data.stores.has(key)},
          createObjectStore:key=>data.stores.set(key,new Map()),
          transaction(names,mode){
            const operations=[],working=new Map();let aborted=false,finish;
            const prior=data.pending;data.pending=new Promise(resolve=>{finish=resolve;});
            const tx={error:null,abort(){aborted=true;this.onabort?.();},objectStore(store){
              const enqueue=use=>{const result={};operations.push(async()=>{result.result=await use();result.onsuccess?.();});return result;};
              const writable=use=>enqueue(()=>{if(mode==='readonly')throw Error('readonly');return use();});
              return {
                get:id=>enqueue(async()=>{if(pause){const wait=pause;pause=null;await wait;}return structuredClone(working.get(store).get(id));}),
                put:(value,id)=>writable(()=>working.get(store).set(id,structuredClone(value))),
                add:(value,id)=>writable(()=>{if(working.get(store).has(id))throw Error('duplicate');working.get(store).set(id,structuredClone(value));}),
                delete:id=>writable(()=>working.get(store).delete(id)),clear:()=>writable(()=>working.get(store).clear()),
                getAllKeys:()=>enqueue(()=>[...working.get(store).keys()]),
              };
            }};
            prior.then(async()=>{
              for(const store of Array.isArray(names)?names:[names])working.set(store,new Map([...data.stores.get(store)].map(([id,value])=>[id,structuredClone(value)])));
              try {
                while(operations.length&&!aborted)await operations.shift()();
                if(!aborted){if(mode==='readwrite')for(const [store,rows] of working)data.stores.set(store,rows);tx.oncomplete?.();}
              }catch(error){tx.error=error;tx.onabort?.();}finally{finish();}
            });return tx;
          }};
        if(fresh)request.onupgradeneeded?.();
        if(upgradeAborted){databases.delete(name);request.onerror?.();}else request.onsuccess?.();
      });return request;
    },
  };
}

export function probeRecording() {
  const samples=198450,bytes=new Uint8Array(44+samples*2),view=new DataView(bytes.buffer);
  for(const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])bytes.set(new TextEncoder().encode(text),offset);
  view.setUint32(4,bytes.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,44100,true);view.setUint32(28,88200,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,samples*2,true);
  for(let i=0;i<samples;i++)view.setInt16(44+i*2,Math.round(8000*Math.sin(2*Math.PI*220*i/44100)+2000*Math.sin(2*Math.PI*3000*i/44100)),true);
  return bytes;
}

export function probeSdk() {
  const calls={praat:0,world:0,synthesize:0};
  const pitch=time=>220*2**(20*Math.sin(2*Math.PI*6.5*time)/1200);
  return {calls,sdk:{
    pitch(bytes){calls.praat++;return Array.from({length:Math.floor((bytes.length-44)/2/220.5)+1},(_,i)=>({time:i*.005,hz:pitch(i*.005),undefined:false}));},
    analyze(samples){calls.world++;const frames=Math.floor(samples.length/220.5)+1,time=Float64Array.from({length:frames},(_,i)=>i*.005);
      return {frames,time,f0:Float64Array.from(time,pitch),sp:new Float64Array(frames*1025).fill(1),ap:new Float64Array(frames*1025)};},
    synthesize(){calls.synthesize++;throw Error('unapproved_synthesis');},
  }};
}
