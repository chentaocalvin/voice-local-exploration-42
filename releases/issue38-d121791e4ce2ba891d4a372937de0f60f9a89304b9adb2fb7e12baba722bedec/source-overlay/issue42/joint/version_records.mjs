// SPDX-License-Identifier: GPL-3.0-or-later
export function createVersionRecords({document,download,listening}) {
  const records=new Map(),picker=document.getElementById('version-record');
  const output=document.getElementById('version-metadata');
  function selected() {
    const record=records.get(picker.value);
    if(!record) throw new Error('result_missing');
    const {start,end,mode}=listening();
    return {...structuredClone(record),listening:{start,end,mode}};
  }
  document.getElementById('version-view').onclick=()=>{
    output.textContent=JSON.stringify(selected(),null,2);
  };
  document.getElementById('version-export').onclick=()=>{
    const record=selected();output.textContent=JSON.stringify(record,null,2);
    download(new Blob([output.textContent],{type:'application/json'}),'voice-version-record.json');
  };
  function refresh() {
    const previous=picker.value;picker.replaceChildren();
    for(const record of records.values()) {
      const option=document.createElement('option');option.value=record.result.id;
      option.textContent=record.result.id+' · '+record.source.method_version;picker.append(option);
    }
    picker.value=records.has(previous)?previous:records.keys().next().value??'';
    for(const id of ['version-view','version-export']) document.getElementById(id).disabled=!records.size;
  }
  return {
    reset(){records.clear();output.textContent='';refresh();},
    add(versions) {
      for(const version of versions) {
        const record=version?.metadata;
        if(record?.schema!=='voice-version-record-v1') continue;
        records.set(record.result.id,structuredClone(record));
        if(records.size>64) records.delete(records.keys().next().value);
      }
      refresh();
    },
  };
}
