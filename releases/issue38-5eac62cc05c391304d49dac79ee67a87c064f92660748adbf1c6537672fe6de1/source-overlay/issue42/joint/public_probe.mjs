// SPDX-License-Identifier: GPL-3.0-or-later
import {isSpectralHeadroomProfile} from './exploration_profile.mjs';
export const PUBLIC_PROBE='issue38-anonymous-example-v1';
export const PUBLIC_PROBE_SOURCE='97504361908ce2f8b27a65ce408f13757b6ac6ba07ae53f527b5d91a9eee3ae4';
export const PUBLIC_PROBE_SAMPLES=1463881;
// Existing engine precharges cover 9N analysis and 4N waveform render. These
// additional PCM reads cover private-buffer copies/exposure and owned archival
// pack/hash paths; parameter-array bytes are reported separately.
export const PUBLIC_PROBE_PCM_MULTIPLIERS=Object.freeze({analyze:3,render:1,save:8,reopen:7});
const limits=Object.freeze({analyze:1,render:1,save:1,reopen:1,input_identity:1,
  praat:1,harvest:1,cheaptrick:1,d4c:1,synthesize:0,audio_read:50_000_000});
const operations=new Set(['analyze','render','save','reopen']);

async function state(indexedDB,release,mode,use,create=false,profile) {
  if(profile!==undefined&&!isSpectralHeadroomProfile(profile))throw new Error('public_probe_profile');
  const key=isSpectralHeadroomProfile(profile)?JSON.stringify([PUBLIC_PROBE,profile,release]):PUBLIC_PROBE;
  const database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('voice-local-public-probe-v1',1);
    request.onupgradeneeded=()=>{
      if(create)request.result.createObjectStore('authorization');
      else {request.transaction.abort();reject(new Error('public_probe_missing'));}
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=request.onblocked=()=>reject(new Error('public_probe_storage'));
  });
  try {
    return await new Promise((resolve,reject)=>{
      const tx=database.transaction('authorization',mode),store=tx.objectStore('authorization'),request=store.get(key);
      let answer,failure;
      request.onsuccess=()=>{
        try {
          const existing=request.result;
          if(existing!==undefined&&(existing.release!==release||existing.profile!==PUBLIC_PROBE||
              typeof existing.stopped!=='boolean'||typeof existing.closed!=='boolean'||Object.keys(existing.counts??{}).length!==Object.keys(limits).length||
              Object.entries(limits).some(([kind,cap])=>!Number.isSafeInteger(existing.counts[kind])||existing.counts[kind]<0||existing.counts[kind]>cap)))
            throw new Error('public_probe_ledger');
          answer=use(existing,value=>store.put(value,key));
        }catch(error){failure=error;tx.abort();}
      };
      tx.oncomplete=()=>resolve(answer);
      tx.onerror=tx.onabort=()=>reject(failure??new Error('public_probe_storage'));
    });
  }finally{database.close();}
}

export async function reservePublicProbe(indexedDB,release,event,profile) {
  return state(indexedDB,release,'readwrite',(existing,write)=>{
    const ledger=existing??{profile:PUBLIC_PROBE,release,stopped:false,closed:false,project_id:null,
      counts:Object.fromEntries(Object.keys(limits).map(kind=>[kind,0]))};
    if(ledger.stopped)throw new Error('public_probe_stopped');
    if(ledger.closed)throw new Error('public_probe_closed');
    const {kind}=event;
    if(!Object.hasOwn(limits,kind))throw new Error('public_probe_event');
    if(operations.has(kind)) {
      if(kind==='save'||kind==='reopen') {
        if(typeof event.project_id!=='string'||!event.project_id.trim()||event.project_id.length>128)
          throw new Error('public_probe_project');
        if(kind==='save')ledger.project_id=event.project_id;
        else if(event.project_id!==ledger.project_id)throw new Error('public_probe_project');
      }
    }else {
      if(event.input_sha256!==PUBLIC_PROBE_SOURCE&&!(kind==='audio_read'&&event.slot==='input-identity'&&event.input_sha256===null))
        throw new Error('public_probe_source');
      if(kind==='audio_read'&&event.slot==='input-identity') {
        if(event.samples!==PUBLIC_PROBE_SAMPLES||ledger.counts.input_identity!==0)throw new Error('public_probe_source');
        ledger.counts.input_identity++;
      }
    }
    const amount=kind==='audio_read'?event.samples:1;
    if(!Number.isSafeInteger(amount)||amount<=0||amount>limits[kind]-ledger.counts[kind])throw new Error('public_probe_cap');
    ledger.counts[kind]+=amount;write(ledger);
  },true,profile);
}

export async function stopPublicProbe(indexedDB,release,profile) {
  return state(indexedDB,release,'readwrite',(ledger,write)=>{
    if(ledger&&!ledger.stopped)write({...ledger,stopped:true});
  },false,profile);
}

export async function closePublicProbe(indexedDB,release,profile) {
  return state(indexedDB,release,'readwrite',(ledger,write)=>{
    if(!ledger||ledger.stopped||ledger.counts.reopen!==1)throw new Error('public_probe_ledger');
    if(!ledger.closed)write({...ledger,closed:true});
  },false,profile);
}

export async function publicProbeReport(indexedDB,release,profile) {
  try {return await state(indexedDB,release,'readonly',ledger=>ledger?{
    profile:PUBLIC_PROBE,release:ledger.release,stopped:ledger.stopped,closed:ledger.closed,
    source_sha256:PUBLIC_PROBE_SOURCE,samples:PUBLIC_PROBE_SAMPLES,
    project_id:typeof ledger.project_id==='string'?ledger.project_id:null,
    counts:Object.fromEntries(Object.keys(limits).map(kind=>[kind,ledger.counts[kind]])),
  }:null,false,profile);}
  catch(error){if(error?.message==='public_probe_missing')return null;throw error;}
}
