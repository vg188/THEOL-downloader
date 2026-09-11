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
  return {bridge,frames,getState:() => state,sender:{id:'extension-id',url:listUrl,origin:'https://course.buct.edu.cn',tab:{id:7},frameId:3,documentId:'doc3'}};
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
