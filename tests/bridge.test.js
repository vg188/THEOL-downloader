import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../src/background/bridge.js';
import { parseDirectory } from '../src/platform/parse.js';
import { dom, listUrl, previewUrl, file } from './helpers/dom.js';

function setup() {
  const directory = parseDirectory(dom(`<a href="${previewUrl()}">第一章</a>`), listUrl);
  let state = null;
  const frames = [
    {frameId:0,documentId:'top',result:{url:'https://course.buct.edu.cn/meol/jpk/course/layout/newpage/index.jsp?courseId=12',title:'网络课程—电路',directory:null}},
    {frameId:3,documentId:'doc3',result:{url:listUrl,title:'资源',directory}},
  ];
  const chrome = {runtime:{id:'extension-id'},tabs:{get:async id => ({id,url:frames[0].result.url})},scripting:{executeScript:async options => options.files ? [] : options.args ? [] : frames}};
  const bridge = createBridge(chrome, {readScan:async () => structuredClone(state), writeScan:async next => {state = structuredClone(next);}});
  return {chrome,bridge,frames,getState:() => state,sender:{id:'extension-id',url:listUrl,origin:'https://course.buct.edu.cn',tab:{id:7},frameId:3,documentId:'doc3'}};
}
test('bridge captures the actual nested frame and original course name', async () => {
  const h = setup();
  const inspected = await h.bridge.inspect(7);
  assert.equal(inspected.context.frameId, 3);
  assert.equal(inspected.context.courseName, '电路');
  const state = await h.bridge.start(7);
  assert.equal(state.phase, 'scanning');
  assert.deepEqual(state.files, []);
});
test('bridge validates scan, sender frame/document and discovered file identity', async () => {
  const h = setup(); const state = await h.bridge.start(7);
  const event = {type:'SCAN_EVENT',scanId:state.id,event:{kind:'progress',file:file(),processed:1,total:1}};
  await assert.rejects(h.bridge.receive(event, {...h.sender,frameId:4}));
  await assert.rejects(h.bridge.receive(event, {...h.sender,documentId:'other'}));
  await assert.rejects(h.bridge.receive({...event,event:{kind:'progress',file:file(99)}}, h.sender));
  await h.bridge.receive(event,h.sender);
  await h.bridge.receive(event,h.sender);
  assert.equal(h.getState().files.length,1);
  assert.equal(h.getState().processed,1);
  await h.bridge.receive({...event,event:{kind:'complete'}},h.sender);
  assert.equal(h.getState().phase,'ready');
});
test('late scan events are ignored and stale directory cannot enqueue', async () => {
  const h=setup(); const old = await h.bridge.start(7); const current = await h.bridge.start(7);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:old.id,event:{kind:'complete'}}, h.sender);
  assert.equal(h.getState().id,current.id);
  h.frames[1].result.directory.key += ',changed';
  await assert.rejects(h.bridge.assertCurrent(7,current.id), error => error.code === 'STALE_SCAN');
});
test('ambiguity and a different top-level course are rejected', async () => {
  const h=setup(); h.frames.push({...h.frames[1],frameId:9,documentId:'doc9'});
  await assert.rejects(h.bridge.inspect(7), error => error.code === 'AMBIGUOUS_DIRECTORY');
  h.frames.pop(); h.frames[0].result.url = h.frames[0].result.url.replace('courseId=12','courseId=99');
  await assert.rejects(h.bridge.inspect(7));
});

test('a ready scan is invalidated by an actual directory change', async () => {
  const h=setup(); const scan=await h.bridge.start(7);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'progress',file:file()}},h.sender);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'complete'}},h.sender);
  assert.equal((await h.bridge.assertCurrent(7,scan.id)).phase,'ready');
  h.frames[1].result.directory.key += ',different-page';
  await assert.rejects(h.bridge.assertCurrent(7,scan.id),e=>e.code==='STALE_SCAN');
  assert.equal(h.getState().phase,'idle');
});
test('a scan replaced during context inspection cannot submit an old selection', async () => {
  const h=setup(); const scan=await h.bridge.start(7);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'progress',file:file()}},h.sender);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'complete'}},h.sender);
  const original=h.chrome.scripting.executeScript; let replace=true;
  h.chrome.scripting.executeScript=async options=>{
    if(!options.files && !options.args && replace){replace=false;await h.bridge.start(7);}
    return original(options);
  };
  await assert.rejects(h.bridge.assertCurrent(7,scan.id),e=>e.code==='STALE_SCAN');
  assert.notEqual(h.getState().id,scan.id);
  assert.equal(h.getState().phase,'scanning');
});


test('stale directory validation never clears a replacement scan', async () => {
  const h=setup(); const scan=await h.bridge.start(7);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'progress',file:file()}},h.sender);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'complete'}},h.sender);
  const original=h.chrome.scripting.executeScript; let replace=true;
  h.chrome.scripting.executeScript=async options=>{
    if(!options.files && !options.args && replace){
      replace=false; h.frames[1].result.directory.key += ',new-directory';
      await h.bridge.start(7);
    }
    return original(options);
  };
  await assert.rejects(h.bridge.assertCurrent(7,scan.id),e=>e.code==='STALE_SCAN');
  assert.notEqual(h.getState().id,scan.id);
  assert.equal(h.getState().phase,'scanning');
});
test('a changed frame invalidates a scan when document IDs are unavailable', async () => {
  const h=setup(); delete h.frames[1].documentId;
  const scan=await h.bridge.start(7);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'progress',file:file()}},h.sender);
  await h.bridge.receive({type:'SCAN_EVENT',scanId:scan.id,event:{kind:'complete'}},h.sender);
  h.frames[1].frameId=4;
  await assert.rejects(h.bridge.assertCurrent(7,scan.id),e=>e.code==='STALE_SCAN');
  assert.equal(h.getState().phase,'idle');
});


test('tabs without URL permission are unsupported and are never injected', async () => {
  const h=setup(); let injections=0;
  h.chrome.tabs.get=async id=>({id});
  h.chrome.scripting.executeScript=async()=>{injections++;return h.frames;};
  await assert.rejects(h.bridge.inspect(7),e=>e.code==='UNSUPPORTED_PAGE');
  assert.equal(injections,0);
});


test('context refresh clears only stale state and lightweight polling does not inject', async () => {
  const h=setup(); const scan=await h.bridge.start(7);
  const original=h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript=async()=>{throw new Error('Unexpected injection');};
  assert.equal((await h.bridge.getState(7,false)).scan.id,scan.id);
  h.chrome.scripting.executeScript=original;
  h.frames[1].result.directory.key += ',changed';
  const changed=await h.bridge.getState(7);
  assert.equal(changed.scan.phase,'idle');
  assert.equal(h.getState().phase,'idle');
  const next=await h.bridge.start(7);
  h.chrome.tabs.get=async id=>({id});
  const unsupported=await h.bridge.getState(7);
  assert.equal(unsupported.page.error.code,'UNSUPPORTED_PAGE');
  assert.equal(unsupported.scan.phase,'idle');
  assert.notEqual(unsupported.scan.id,next.id);
});
