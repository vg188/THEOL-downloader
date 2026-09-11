import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createSelection } from '../src/popup/model.js';
import { mountPopup } from '../src/popup/view.js';
import { file } from './helpers/dom.js';

test('search and format filters preserve hidden selections; new scans reset them',()=>{
  const model=createSelection(); model.reset('a'); model.toggle(file(1).id,true);
  const visible=model.visible([file(1),file(2)],'第2章','all'); model.toggleVisible(visible,true);
  assert.equal(model.selectedIds().length,2);
  model.toggleVisible(visible,false); assert.deepEqual(model.selectedIds(),[file(1).id]);
  model.reset('a'); assert.equal(model.selectedIds().length,1);
  model.reset('b'); assert.deepEqual(model.selectedIds(),[]);
});
test('popup starts unchecked, renders filenames as text and submits only selected IDs',async()=>{
  const html=await readFile(new URL('../public/popup.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://example.test/popup.html'}); const document=dom.window.document;
  const calls=[]; const dangerous={...file(1),name:'<img src=x onerror=alert(1)>.ppt'};
  const scan={id:'scan-one',phase:'ready',context:{key:'one',courseName:'电路'},files:[dangerous,file(2)],failures:[],skipped:0,total:2,processed:2,message:'找到 2 份课件'};
  const app=await mountPopup({document,activeTab:7,send:async message=>{
    calls.push(message); return {ok:true,data:message.type==='GET_STATE'?{scan,queue:{jobs:[]},page:{context:scan.context}}:{jobs:[]}};
  },subscribe:()=>()=>{}});
  assert.equal(document.querySelectorAll('.file-row input:checked').length,0);
  assert.equal(document.querySelector('#download-button').disabled,true);
  assert.equal(document.querySelectorAll('#file-list img').length,0);
  const checkbox=document.querySelector('.file-row input'); checkbox.click();
  assert.equal(document.querySelector('#download-button').disabled,false);
  document.querySelector('#download-button').click();
  await new Promise(resolve=>setImmediate(resolve));
  const submission=calls.find(c=>c.type==='DOWNLOAD_SELECTED');
  assert.deepEqual(submission.ids,[dangerous.id]); assert.equal(submission.tabId,7); assert.equal('url' in submission,false);
  app.destroy();
});
test('unsupported pages give instructions without enabling scan',async()=>{
  const document=new JSDOM(await readFile(new URL('../public/popup.html',import.meta.url),'utf8')).window.document;
  const app=await mountPopup({document,activeTab:2,send:async()=>({ok:true,data:{scan:{id:'',phase:'idle',files:[],failures:[]},queue:{jobs:[]},page:{error:{code:'UNSUPPORTED_PAGE',message:'请先打开学校教学平台的课程资源页'}}}}),subscribe:()=>()=>{}});
  assert.equal(document.querySelector('#scan-button').disabled,true);
  assert.match(document.querySelector('#empty-copy').textContent,/课程资源/);
  app.destroy();
});
