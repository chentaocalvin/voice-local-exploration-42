// In-memory IndexedDB boundary: serialized transactions, commit and abort.
export function memoryIndexedDB() {
  const databases=new Map(),failDeletes=new Set();
  function database(data,name) {
    return {
      close(){},
      createObjectStore(store){data.stores.set(store,new Map());},
      transaction(storeName,mode) {
        const operations=[];let working,aborted=false,finish;
        const prior=data.pending;data.pending=new Promise(resolve=>{finish=resolve;});
        const transaction={error:null,
          abort(){aborted=true;this.onabort?.();},
          objectStore(){
            const enqueue=use=>{const request={};operations.push(()=>{request.result=use();request.onsuccess?.();});return request;};
            const write=use=>enqueue(()=>{if(mode==='readonly')throw Error('readonly');return use();});
            return {
              get:key=>enqueue(()=>structuredClone(working.get(key))),
              put:(value,key)=>write(()=>working.set(key,structuredClone(value))),
              add:(value,key)=>write(()=>{if(working.has(key))throw Error('duplicate');working.set(key,structuredClone(value));}),
              delete:key=>write(()=>{if(failDeletes.has(name))throw Error('synthetic delete failure');working.delete(key);}),
              clear:()=>write(()=>working.clear()),
              openCursor(){
                const request={};let index=0;
                const visit=()=>{
                  const entry=[...working.entries()][index];
                  request.result=entry?{key:entry[0],value:structuredClone(entry[1]),
                    update:value=>working.set(entry[0],structuredClone(value)),
                    continue(){index++;operations.push(visit);}}:null;
                  request.onsuccess?.();
                };
                operations.push(visit);return request;
              },
            };
          },
        };
        prior.then(()=>{
          working=new Map([...data.stores.get(storeName)].map(([key,value])=>[key,structuredClone(value)]));
          try {
            while(operations.length&&!aborted)operations.shift()();
            if(!aborted){data.stores.set(storeName,working);transaction.oncomplete?.();}
          } catch(error){transaction.error=error;transaction.onabort?.();}
          finally{finish();}
        });
        return transaction;
      },
    };
  }
  return {
    open(name) {
      const request={};
      queueMicrotask(()=>{
        let data=databases.get(name),aborted=false;
        const fresh=!data;
        if(fresh){data={stores:new Map(),pending:Promise.resolve()};databases.set(name,data);}
        request.result=database(data,name);request.transaction={abort(){aborted=true;}};
        if(fresh)request.onupgradeneeded?.();
        if(aborted){databases.delete(name);request.onerror?.();}else request.onsuccess?.();
      });
      return request;
    },
    seed(name,store,key,value){
      if(!databases.has(name))databases.set(name,{stores:new Map(),pending:Promise.resolve()});
      const data=databases.get(name);if(!data.stores.has(store))data.stores.set(store,new Map());
      data.stores.get(store).set(key,structuredClone(value));
    },
    failDeletes(name){failDeletes.add(name);},
  };
}
