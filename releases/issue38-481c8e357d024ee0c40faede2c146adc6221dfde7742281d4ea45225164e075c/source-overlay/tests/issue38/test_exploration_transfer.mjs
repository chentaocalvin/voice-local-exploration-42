import assert from 'node:assert/strict';
import test from 'node:test';
import {sha256} from '../../issue42/identity.mjs';
import {importPrivateRunTransfer} from '../../issue42/joint/private_run_transfer.mjs';

const release='synthetic',recipient='2'.repeat(64);
const address='http://127.0.0.1:12345/'+'1'.repeat(64)+'/';
test('the new transfer profile bounds the entire frame while the legacy member limits stay unchanged',async()=>{
  const entries=Object.entries({setup:4096,solo:1048576,piano:3145728});
  const parts=entries.map(([,size])=>new Uint8Array(size));
  const files=[];
  for(let i=0;i<parts.length;i++)files.push({kind:entries[i][0],bytes:parts[i].length,sha256:await sha256(parts[i])});
  const header=new TextEncoder().encode(JSON.stringify({schema:'issue38-private-transfer-v1',release,recipient,
    run_id:'3'.repeat(64),expires:10000,files}));
  const frame=new Uint8Array(4+header.length+parts.reduce((sum,p)=>sum+p.length,0));
  new DataView(frame.buffer).setUint32(0,header.length);frame.set(header,4);
  let offset=4+header.length;for(const part of parts){frame.set(part,offset);offset+=part.length;}
  assert.ok(frame.length>4198400&&frame.length<=4202500);
  const options={now:()=>0,prove:async()=>({synthetic:true}),read:async url=>String(url).endsWith('challenge')?
    new Response(JSON.stringify({challenge:'4'.repeat(64)}),{headers:{'Content-Type':'application/json'}}):
    new Response(frame.slice(),{headers:{'Content-Type':'application/octet-stream'}})};
  await assert.rejects(importPrivateRunTransfer(address,release,recipient,
    {...options,profile:'issue38-joint-exploration-v1'}),/private_transfer_size/);
  await assert.rejects(importPrivateRunTransfer(address,release,recipient,
    {...options,profile:'issue38-joint-spectral-headroom-v1'}),/private_transfer_size/);
  const old=await importPrivateRunTransfer(address,release,recipient,options);
  assert.deepEqual(Object.keys(old.parts),['setup','solo','piano']);
  assert.equal(old.parts.piano.size,3145728);
});

test('an unknown transfer profile is rejected before any connection',async()=>{
  await assert.rejects(importPrivateRunTransfer(address,release,recipient,{profile:'unknown',
    read:()=>{throw Error('unexpected_connection');}}),/private_transfer_profile/);
});
