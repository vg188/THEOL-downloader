import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createSelection } from '../src/popup/model.js';
import { mountPopup } from '../src/popup/view.js';
import { file, listUrl, unitEntryUrl } from './helpers/dom.js';

const POPUP_HTML = new URL('../public/popup.html', import.meta.url);
const idleScan = () => ({ id:'', phase:'idle', context:null, files:[], failures:[], unitFailures:[], units:{processed:0,total:0,discovered:0}, total:0, processed:0, skipped:0 });
const unitContext = (mode = 'current', key = `unit-study|${mode}|lesson`) => ({ surface:'unit-study', mode, unitKey:'https://course.buct.edu.cn/meol/jpk/course/layout/lesson/index.jsp?courseId=12',
  modeOptions:['current','all'], resourceIds:[], courseName:'电路', key });
const unitSurface = { surface:'unit-study', modeOptions:['current','all'], unitIndex:{ key:'idx', entries:[{ title:'第一单元' },{ title:'第二单元' },{ title:'第三单元' }] } };
const directoryContext = { surface:'resource-directory', mode:'current', modeOptions:['current'], resourceIds:['12:78:56'], courseName:'电路', key:`resource-directory|current|${listUrl}` };

async function mount(t, { scan = idleScan(), page = {}, onStart } = {}) {
  const document = new JSDOM(await readFile(POPUP_HTML, 'utf8'), { url: 'https://example.test/popup.html' }).window.document;
  const calls = []; const current = { scan, page }; const Event = document.defaultView.Event;
  const app = await mountPopup({ document, activeTab: 7, subscribe: () => () => {}, send: async message => {
    calls.push(message);
    if (message.type !== 'GET_STATE') return { ok: true, data: onStart ? onStart(message, current) : current.scan };
    return { ok: true, data: { scan: current.scan, queue: { jobs: [] }, page: current.page } };
  } });
  // The panel polls while downloads run; every mount must be torn down.
  t.after(() => app.destroy());
  const change = value => { const select = document.querySelector('#scan-mode'); select.value = value; select.dispatchEvent(new Event('change')); };
  return { document, calls, app, current, change };
}

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
test('unit-study pages offer the range control and default to the current unit',async t=>{
  const { document } = await mount(t, { page: { context: unitContext(), surface: unitSurface } });
  const select=document.querySelector('#scan-mode');
  assert.equal(select.hidden,false);
  assert.equal(document.querySelector('#scan-mode-row').hidden,false);
  assert.equal(select.value,'current');
  assert.deepEqual([...select.options].map(option=>option.value),['current','all']);
  assert.deepEqual([...select.options].map(option=>option.textContent),['当前单元','全部单元']);
  assert.equal(document.querySelector('#scope-copy').textContent,'只扫描当前单元');
  assert.equal(document.querySelector('#all-units-dialog').hidden,true);
});
test('course-resource pages keep current-directory copy and hide the range control',async t=>{
  const { document } = await mount(t, { page: { context: directoryContext, surface: { surface:'resource-directory', modeOptions:['current'] } } });
  const select=document.querySelector('#scan-mode');
  assert.equal(select.hidden,true);
  assert.equal(document.querySelector('#scan-mode-row').hidden,true);
  assert.deepEqual([...select.options].map(option=>option.textContent),['当前目录']);
  assert.equal(document.querySelector('#scope-copy').textContent,'只扫描当前目录');
  assert.equal(document.body.textContent.includes('当前单元'),false,'course-resource copy never says 当前单元');
});
test('an all-unit range needs confirmation before any scan request',async t=>{
  const started=[];
  const scanning={ ...idleScan(), id:'scan-all', phase:'scanning', context:unitContext('all'), units:{processed:0,total:3,discovered:0} };
  const { document, calls, change } = await mount(t, { page: { context: unitContext(), surface: unitSurface }, onStart: (message, current) => {
    started.push(message.mode); current.scan=scanning; return scanning;
  } });
  const select=document.querySelector('#scan-mode'), dialog=document.querySelector('#all-units-dialog'), scanButton=document.querySelector('#scan-button');
  scanButton.focus();
  change('all');
  assert.equal(document.querySelector('#scope-copy').textContent,'将扫描全部单元');
  scanButton.click();
  assert.equal(calls.some(call=>call.type==='START_SCAN'),false,'selecting all must not scan before confirmation');
  assert.equal(dialog.hidden,false);
  assert.equal(select.disabled,true,'the range is locked while the confirmation is open');
  assert.equal(document.activeElement.id,'all-units-cancel','the confirmation lands on the safe choice');
  assert.equal(document.querySelector('#all-units-title').textContent,'扫描全部单元？');
  assert.equal(document.querySelector('#all-units-copy').textContent,'将读取当前课程的 3 个单元页面，不会下载课件正文');
  document.querySelector('#all-units-cancel').click();
  assert.equal(dialog.hidden,true);
  assert.equal(select.disabled,false);
  assert.equal(select.value,'current');
  assert.equal(document.activeElement,scanButton,'closing the confirmation returns focus to the scan button');
  assert.equal(calls.some(call=>call.type==='START_SCAN'),false,'cancelling sends nothing');
  change('all');
  document.querySelector('#scan-button').click();
  document.querySelector('#all-units-confirm').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.filter(call=>call.type==='START_SCAN'),[{ type:'START_SCAN', tabId:7, mode:'all' }]);
  assert.deepEqual(started,['all']);
  assert.equal(dialog.hidden,true);
});
test('all-unit scans report unit progress first, then metadata progress',async t=>{
  const scanning={ ...idleScan(), id:'scan-all', phase:'scanning', context:unitContext('all'), total:0, processed:0, units:{processed:1,total:3,discovered:5} };
  const { document, app, current } = await mount(t, { scan: scanning, page: { context: scanning.context, surface: unitSurface } });
  assert.equal(document.querySelector('#scan-mode').disabled,true,'scanning locks the range');
  assert.equal(document.querySelector('#scan-status').textContent,'正在读取单元 1 / 3，已发现 5 个候选');
  assert.equal(document.querySelector('#scan-progress').max,3);
  assert.equal(document.querySelector('#scan-progress').value,1);
  current.scan={ ...scanning, units:{processed:3,total:3,discovered:5}, total:5, processed:2 };
  await app.refresh(true);
  assert.equal(document.querySelector('#scan-status').textContent,'正在识别课件 2 / 5');
  assert.equal(document.querySelector('#scan-progress').max,5);
  assert.equal(document.querySelector('#scan-progress').value,2);
});
test('reopening the panel restores the current-unit default',async t=>{
  const scan={ ...idleScan(), id:'scan-all', phase:'ready', context:unitContext('all'), files:[file(56)], total:1, processed:1 };
  const { document } = await mount(t, { scan, page: { context: scan.context, surface: unitSurface } });
  assert.equal(document.querySelector('#scan-mode').value,'current','an all-unit scan is never remembered as the range');
});
test('a changed page context closes the confirmation and restores the default',async t=>{
  const { document, app, current, change } = await mount(t, { page: { context: unitContext(), surface: unitSurface } });
  change('all');
  document.querySelector('#scan-button').click();
  assert.equal(document.querySelector('#all-units-dialog').hidden,false);
  await app.refresh(true);
  assert.equal(document.querySelector('#all-units-dialog').hidden,false,'a background refresh keeps the panel-lifetime range');
  assert.equal(document.querySelector('#scan-mode').value,'all');
  current.page={ context: unitContext('current','unit-study|current|other-lesson'), surface: unitSurface };
  await app.refresh(true);
  assert.equal(document.querySelector('#all-units-dialog').hidden,true);
  assert.equal(document.querySelector('#scan-mode').value,'current');
  assert.equal(document.querySelector('#scan-mode').disabled,false);
});
test('changing the range clears an unsubmitted selection',async t=>{
  const scan={ ...idleScan(), id:'scan-one', phase:'ready', context:unitContext(), files:[file(56),file(57)], total:2, processed:2 };
  const { document, change } = await mount(t, { scan, page: { context: scan.context, surface: unitSurface } });
  document.querySelector('.file-row input').click();
  assert.equal(document.querySelector('#download-button').disabled,false);
  change('all');
  assert.equal(document.querySelectorAll('.file-row input:checked').length,0);
  assert.equal(document.querySelector('#download-button').disabled,true);
});
test('file rows name the owning unit only when the scan provides it',async t=>{
  const owned={ ...file(56), unit:{ entryUrl:unitEntryUrl(41), title:'第一单元', order:0, occurrenceCount:3 } };
  const single={ ...file(57), unit:{ entryUrl:unitEntryUrl(42), title:'第二单元', order:1, occurrenceCount:1 } };
  const plain=file(58);
  const here={ ...file(59), unit:{ entryUrl:null, title:'当前单元', order:0, occurrenceCount:1 } };
  const scan={ ...idleScan(), id:'scan-all', phase:'ready', context:unitContext('all'), files:[owned,single,plain,here], total:4, processed:4 };
  const { document } = await mount(t, { scan, page: { context: scan.context, surface: unitSurface } });
  const rows=[...document.querySelectorAll('.file-row')];
  assert.equal(rows[0].querySelector('.file-unit').hidden,false);
  assert.equal(rows[0].querySelector('.file-unit').textContent,'所属单元 第一单元 · 另见 2 个单元');
  assert.equal(rows[1].querySelector('.file-unit').hidden,false);
  assert.equal(rows[1].querySelector('.file-unit').textContent,'所属单元 第二单元');
  assert.equal(rows[2].querySelector('.file-unit').hidden,true);
  assert.equal(rows[2].querySelector('.file-unit').textContent,'');
  assert.equal(rows[3].querySelector('.file-unit').hidden,true,'the current-unit pseudo unit names the page the user is on');
});
test('unit failures and metadata failures render in separate groups',async t=>{
  const scan={ ...idleScan(), id:'scan-all', phase:'ready', context:unitContext('all'), files:[file(56)], total:1, processed:1,
    failures:[{ id:'12:78:57', title:'第57章', message:'原文件入口不可用' }],
    unitFailures:[{ kind:'unit', columnId:'42', title:'第二单元', code:'TIMEOUT', message:'读取超时' }] };
  const { document } = await mount(t, { scan, page: { context: scan.context, surface: unitSurface } });
  assert.equal(document.querySelector('#unit-failures').hidden,false);
  assert.equal(document.querySelector('#scan-failures').hidden,false);
  assert.equal(document.querySelector('#unit-failure-summary').textContent,'1 个单元未能读取');
  assert.equal(document.querySelector('#failure-summary').textContent,'1 个资源未能识别');
  assert.deepEqual([...document.querySelectorAll('#unit-failure-list li')].map(item=>item.textContent),['第二单元：读取超时']);
  assert.deepEqual([...document.querySelectorAll('#failure-list li')].map(item=>item.textContent),['第57章：原文件入口不可用']);
});
