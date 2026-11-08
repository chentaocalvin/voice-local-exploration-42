import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,utimes,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('the metadata CLI accepts a matching current export but rejects another UI process',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'continuation-cli-'));
  try {
    const source={input_sha256:'1'.repeat(64),voice_sha256:'2'.repeat(64),mix_sha256:'1'.repeat(64),
      kind:'piano',samples:352800,sample_rate:44100,method_version:'voice-local-piano-shared-spectral-headroom-v1'};
    const context={run_id:'a'.repeat(64),pid:17,window:{not_before:1000000,expires:2000000},
      operation:'piano-M-front-export-current.txt',source,baseline:{source,result:{id:'U'},control:{intents:[],preserve:[]}}};
    const record={schema:'voice-version-record-v1',source,result:{id:'E:'+'5'.repeat(64),sha256:'6'.repeat(64),voice_sha256:'7'.repeat(64)},
      control:{intents:[{kind:'M',amount:.5,mode:'front',held:false,start_frame:681,end_frame:1046}],preserve:[]},
      region:[100,1500],sample_regions:[[151000,230000]],spectral_delta_scales:{}};
    const operation={pid:17,epoch:1001,body:context.operation,returncode:0};
    for(const [name,value] of Object.entries({context,record,operation}))await writeFile(join(directory,name+'.json'),JSON.stringify(value));
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const recordBytes=JSON.stringify(record),operationBytes=JSON.stringify(operation);
    const attestation={schema:'voice-current-export-binding-v1',operation_sha256:digest(operationBytes),
      download:'voice-project-1001000.json',download_mtime_ms:1001000,bytes:Buffer.byteLength(recordBytes),sha256:digest(recordBytes)};
    await writeFile(join(directory,'attestation.json'),JSON.stringify(attestation));
    const args=[fileURLToPath(new URL('../../check-continuation.mjs',import.meta.url)),
      'piano','M-front','current',join(directory,'context.json'),join(directory,'record.json'),join(directory,'operation.json'),join(directory,'attestation.json')];
    const accepted=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(accepted.status,0,accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).realSDKActions,0);
    const stale={...attestation,download:'voice-project-1000500.json',download_mtime_ms:1000500};
    await writeFile(join(directory,'attestation.json'),JSON.stringify(stale));
    const oldDownload=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.notEqual(oldDownload.status,0);assert.match(oldDownload.stderr,/export_binding/);
    await writeFile(join(directory,'attestation.json'),JSON.stringify({...attestation,sha256:'0'.repeat(64)}));
    const replaced=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.notEqual(replaced.status,0);assert.match(replaced.stderr,/export_binding/);
    await writeFile(join(directory,'attestation.json'),JSON.stringify(attestation));
    operation.pid=18;await writeFile(join(directory,'operation.json'),JSON.stringify(operation));
    const rejected=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/operation_owner/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('the current-export collector ignores an immediately preceding download and binds the new small JSON exclusively',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'continuation-collector-'));
  try {
    const downloads=join(directory,'downloads');await mkdir(downloads);
    const operationPath=join(directory,'operation.json'),recordPath=join(directory,'record.json'),bindingPath=join(directory,'binding.json');
    const operation=JSON.stringify({pid:17,epoch:1001,returncode:0});
    await writeFile(operationPath,operation);
    for(const stamp of [1000500,1001000]) {
      const path=join(downloads,`voice-project-${stamp}.json`);
      await writeFile(path,JSON.stringify({schema:'voice-version-record-v1',tag:stamp}));
      await utimes(path,stamp/1000,stamp/1000);
    }
    const command=[fileURLToPath(new URL('../../collect-continuation.py',import.meta.url)),operationPath,downloads,recordPath,bindingPath];
    const collected=spawnSync('python3',['-I','-B',...command],{encoding:'utf8'});
    assert.equal(collected.status,0,collected.stderr);
    const bytes=await readFile(recordPath),binding=JSON.parse(await readFile(bindingPath,'utf8'));
    assert.equal(JSON.parse(bytes).tag,1001000);
    assert.equal(binding.download,'voice-project-1001000.json');
    assert.equal(binding.operation_sha256,createHash('sha256').update(operation).digest('hex'));
    assert.equal(binding.sha256,createHash('sha256').update(bytes).digest('hex'));
    const repeated=spawnSync('python3',['-I','-B',...command],{encoding:'utf8'});
    assert.notEqual(repeated.status,0);
    assert.deepEqual(await readFile(recordPath),bytes);
  }finally{await rm(directory,{recursive:true,force:true});}
});
