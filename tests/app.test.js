import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouter } from '../src/background/app.js';
import { createBridge } from '../src/background/bridge.js';
import { file } from './helpers/dom.js';
function harness(){
  const calls=[]; const scan={id:'one',phase:'ready',files:[file()],context:{tabId:7,key:'key',documentId:'doc'}};
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},downloads:{show:async id=>calls.push(id)}};
  const queue={refresh:async()=>({jobs:[]}),getState:async()=>({jobs:[]}),enqueue:async files=>{calls.push(files);return {jobs:[]};},retry:async()=>({jobs:[]})};
  const bridge={assertCurrent:async()=>scan,inspect:async()=>({context:scan.context}),start:async()=>scan,receive:async()=>{calls.push('progress');}};
  const route=createRouter({chrome,queue,bridge,readScan:async()=>scan,writeScan:async()=>{}});
  return {route,calls,sender:{id:'test',url:'chrome-extension://test/popup.html'}};
}
test('privileged requests reject webpage/content senders',async()=>{
  const h=harness(); await assert.rejects(h.route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:'one',ids:[file().id],requestId:'r'},{id:'test',url:'https://course.buct.edu.cn/'}),e=>e.code==='INVALID_MESSAGE');
  assert.equal(h.calls.length,0);
});
test('queue receives only validated stored selection, never message-supplied URLs',async()=>{
  const h=harness(); await h.route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:'one',ids:[file().id],requestId:'r',downloadUrl:'https://evil.test'},h.sender);
  assert.equal(h.calls[0][0].downloadUrl,file().downloadUrl);
  await assert.rejects(h.route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:'one',ids:['unknown'],requestId:'r2'},h.sender));
});


for (const directoryChanges of [false, true]) test('popup refresh preserves a concurrently replaced scan (directory change: ' + directoryChanges + ')', async () => {
  const metadata=file(); let state;
  const storage={readScan:async()=>structuredClone(state),writeScan:async next=>{state=structuredClone(next);}};
  const directory={courseId:'12',folderId:'34',key:'12/34|' + metadata.id,url:'https://course.buct.edu.cn/meol/common/script/listview.jsp?lid=12&folderid=34',resources:[metadata]};
  const frames=[{frameId:0,documentId:'doc',result:{url:'https://course.buct.edu.cn/meol/common/script/listview.jsp?lid=12&folderid=34',title:'网络课程—测试',directory}}];
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},tabs:{get:async id=>({id,url:frames[0].result.url})},scripting:{executeScript:async options=>options.files || options.args ? [] : frames}};
  const bridge=createBridge(chrome,storage);
  const scan=await bridge.start(7);
  const sender={id:'test',url:directory.url,tab:{id:7},frameId:0,documentId:'doc'};
  await bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'progress',file:metadata}},sender);
  await bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'complete'}},sender);
  const original=chrome.scripting.executeScript; let replace=true;
  chrome.scripting.executeScript=async options=>{
    if(!options.files && !options.args && replace){
      replace=false; if(directoryChanges) directory.key += ',new';
      await bridge.start(7);
    }
    return original(options);
  };
  const route=createRouter({chrome,queue:{refresh:async()=>({jobs:[]})},bridge,...storage});
  const result=await route({type:'GET_STATE',tabId:7},{id:'test',url:chrome.runtime.getURL('popup.html')});
  assert.equal(state.phase,'scanning');
  assert.notEqual(state.id,scan.id);
  assert.equal(result.scan.id,state.id);
  assert.equal(result.scan.phase,'scanning');
});
