import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouter } from '../src/background/app.js';
import { createBridge } from '../src/background/bridge.js';
import { describeSurface } from '../src/platform/surface.js';
import { dom, file, listUrl, previewUrl, unitEntryUrl, unitPageUrl, downloadUrl, resource } from './helpers/dom.js';
function harness(){
  const calls=[]; const scan={id:'one',phase:'ready',files:[file()],context:{tabId:7,key:'key',documentId:'doc'}};
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},downloads:{show:async id=>calls.push(id)}};
  const queue={refresh:async()=>({jobs:[]}),getState:async()=>({jobs:[]}),enqueue:async files=>{calls.push(files);return {jobs:[]};},retry:async()=>({jobs:[]})};
  const bridge={assertCurrent:async()=>scan,inspect:async()=>({context:scan.context}),start:async(tabId,mode)=>{calls.push({tabId,mode});return scan;},receive:async()=>{calls.push('progress');}};
  const route=createRouter({chrome,queue,bridge,readScan:async()=>scan,writeScan:async()=>{}});
  return {route,calls,sender:{id:'test',url:'chrome-extension://test/popup.html'}};
}
test('privileged requests reject webpage/content senders',async()=>{
  const h=harness();
  await assert.rejects(h.route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:'one',ids:[file().id],requestId:'r'},{id:'test',url:'https://course.buct.edu.cn/'}),e=>e.code==='INVALID_MESSAGE');
  await assert.rejects(h.route({type:'START_SCAN',tabId:7,mode:'all'},{id:'test',url:unitPageUrl('lesson',12)}),e=>e.code==='INVALID_MESSAGE');
  assert.equal(h.calls.length,0);
});
test('queue receives only validated stored selection, never message-supplied URLs',async()=>{
  const h=harness(); await h.route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:'one',ids:[file().id],requestId:'r',downloadUrl:'https://evil.test'},h.sender);
  assert.equal(h.calls[0][0].downloadUrl,file().downloadUrl);
  await assert.rejects(h.route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:'one',ids:['unknown'],requestId:'r2'},h.sender));
});
test('START_SCAN carries only the validated range and never starts an unknown one',async()=>{
  const h=harness();
  await h.route({type:'START_SCAN',tabId:7},h.sender);
  await h.route({type:'START_SCAN',tabId:7,mode:null},h.sender);
  await h.route({type:'START_SCAN',tabId:7,mode:'all'},h.sender);
  await h.route({type:'START_SCAN',tabId:7,mode:'current',tabUrl:'https://evil.test',mode2:'all'},h.sender);
  assert.deepEqual(h.calls,[{tabId:7,mode:'current'},{tabId:7,mode:'current'},{tabId:7,mode:'all'},{tabId:7,mode:'current'}]);
  for(const mode of ['unknown','ALL','',7,{}]) await assert.rejects(h.route({type:'START_SCAN',tabId:7,mode},h.sender),e=>e.code==='INVALID_MESSAGE');
  assert.equal(h.calls.length,4);
});


for (const directoryChanges of [false, true]) test('popup refresh preserves a concurrently replaced scan (directory change: ' + directoryChanges + ')', async () => {
  const metadata=file(); let state;
  const storage={readScan:async()=>structuredClone(state),writeScan:async next=>{state=structuredClone(next);}};
  const url=listUrl;
  const surface=describeSurface(dom(`<a href="${metadata.previewUrl}">第一章</a>`),url);
  const directory=surface.directory;
  const frames=[{frameId:0,documentId:'doc',result:{url,title:'网络课程—测试',surface,hasFocus:false,depth:0}}];
  assert.equal(directory.resources.length,1);
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},tabs:{get:async id=>({id,url})},scripting:{executeScript:async options=>options.files || options.args ? [] : frames}};
  const bridge=createBridge(chrome,storage);
  const scan=await bridge.start(7);
  const sender={id:'test',url,tab:{id:7},frameId:0,documentId:'doc'};
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

test('popup refresh preserves a scan replaced by an all-unit scan of the same course', async () => {
  let state;
  const storage={readScan:async()=>structuredClone(state),writeScan:async next=>{state=structuredClone(next);}};
  const lesson=unitPageUrl('lesson',12);
  const shell=unitPageUrl('newpage',12);
  const document=dom(`<a href="${previewUrl(56)}">第一章</a><a href="${previewUrl(57)}">第二章</a>`+
    `<ul><li><a href="${unitEntryUrl(41)}">第一单元</a></li><li><a href="${unitEntryUrl(42)}">第二单元</a></li></ul>`);
  const frames=[{frameId:0,documentId:'shell',result:{url:shell,title:'网络课程—测试',surface:describeSurface(dom(''),shell),hasFocus:false,depth:0}},
    {frameId:5,documentId:'unit',result:{url:lesson,title:'单元',surface:describeSurface(document,lesson),hasFocus:true,depth:1}}];
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},tabs:{get:async id=>({id,url:shell})},scripting:{executeScript:async options=>options.files || options.args ? [] : frames}};
  const bridge=createBridge(chrome,storage);
  const current=await bridge.start(7);
  const sender={id:'test',url:lesson,tab:{id:7},frameId:5,documentId:'unit'};
  for(const n of [56,57]) await bridge.receive({type:'SCAN_EVENT',scanId:current.id,event:{kind:'progress',file:file(n)}},sender);
  await bridge.receive({type:'SCAN_EVENT',scanId:current.id,event:{kind:'complete'}},sender);
  assert.equal(state.phase,'ready');
  const original=chrome.scripting.executeScript; let replace=true;
  chrome.scripting.executeScript=async options=>{
    if(!options.files && !options.args && replace){replace=false;await bridge.start(7,'all');}
    return original(options);
  };
  const route=createRouter({chrome,queue:{refresh:async()=>({jobs:[]})},bridge,...storage});
  const result=await route({type:'GET_STATE',tabId:7},{id:'test',url:chrome.runtime.getURL('popup.html')});
  assert.equal(state.phase,'scanning');
  assert.equal(state.context.mode,'all');
  assert.deepEqual(state.context.resourceIds,[]);
  assert.notEqual(state.id,current.id);
  assert.equal(result.scan.id,state.id);
  assert.equal(result.scan.phase,'scanning');
  assert.deepEqual(result.page.context.modeOptions,['current','all']);
});

test('an all-unit scan submits only its stored validated files', async () => {
  let state; const enqueued=[];
  const storage={readScan:async()=>structuredClone(state),writeScan:async next=>{state=structuredClone(next);}};
  const lesson=unitPageUrl('lesson',12), shell=unitPageUrl('newpage',12);
  const document=dom(`<a href="${previewUrl(56)}">第一章</a><a href="${previewUrl(57)}">第二章</a>`+
    `<ul><li><a href="${unitEntryUrl(41)}">第一单元</a></li><li><a href="${unitEntryUrl(42)}">第二单元</a></li></ul>`);
  const frames=[{frameId:0,documentId:'shell',result:{url:shell,title:'网络课程—测试',surface:describeSurface(dom(''),shell),hasFocus:false,depth:0}},
    {frameId:5,documentId:'unit',result:{url:lesson,title:'单元',surface:describeSurface(document,lesson),hasFocus:true,depth:1}}];
  const chrome={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path},tabs:{get:async id=>({id,url:shell})},scripting:{executeScript:async options=>options.files || options.args ? [] : frames}};
  const bridge=createBridge(chrome,storage);
  const scan=await bridge.start(7,'all');
  const sender={id:'test',url:lesson,tab:{id:7},frameId:5,documentId:'unit'};
  const page=event=>bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event},sender);
  await page({kind:'unit-progress',processed:1,total:2,discovered:2});
  await page({kind:'discovered',resources:[resource(56),resource(57)]});
  await page({kind:'discovered',resources:[resource(57)]});
  for(const n of [56,57]) await page({kind:'progress',file:file(n)});
  await page({kind:'complete',unitFailures:[],failures:[]});
  assert.equal(state.phase,'ready');
  assert.deepEqual(state.files.map(item=>item.id),['12:78:56','12:78:57']);
  const route=createRouter({chrome,queue:{getState:async()=>({jobs:[]}),enqueue:async(files,requestId)=>{enqueued.push({files,requestId});return {jobs:[]};}},bridge,...storage});
  const popup={id:'test',url:chrome.runtime.getURL('popup.html')};
  const result=await route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:scan.id,ids:['12:78:57'],requestId:'r',downloadUrl:'https://evil.test/'},popup);
  assert.deepEqual(result,{jobs:[]});
  assert.deepEqual(enqueued[0].files.map(item=>item.downloadUrl),[downloadUrl(57)]);
  await assert.rejects(route({type:'DOWNLOAD_SELECTED',tabId:7,scanId:scan.id,ids:['12:78:56','12:78:99'],requestId:'r2'},popup),e=>e.code==='INVALID_MESSAGE');
  assert.equal(enqueued.length,1);
});
