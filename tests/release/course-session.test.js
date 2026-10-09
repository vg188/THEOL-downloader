import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unzipSync } from 'fflate';
import { createCourseScanner } from '../../src/runtime/scanner.js';
import { previewFilename } from '../../src/runtime/policy.js';
import { backgroundHarness, bookmarkletHarness, panelHarness, bundle, ORIGIN, LIST, file, tree, listHTML, response, metadataResponse, pdf, waitFor } from './helpers.js';

const unitEntry = id => ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=' + id + '&courseId=42';
const unitMenu = id => '<ul id="ul_advance"><li><a href="' + unitEntry(id) + '">第一单元</a></li></ul>';
const courseUrl = ORIGIN + '/meol/common/script/courseResource.jsp?lid=42';
function documentFor(t, html = listHTML(), url = LIST) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  return dom;
}
function courseResult(contextKey = 'document-1|course-42') {
  const resourceTree = { ...tree([file()]), id: 'section-resource', name: '课程资源' };
  const unitTree = { ...tree([file(2, { section: 'unit', pathSegments: ['单元学习', '第一单元'] })]), id: 'section-unit', name: '单元学习' };
  return { ok: true, lid: '42', contextKey, courseName: '测试课程', surface: 'course', defaultMode: 'course', modes: ['course', 'tree', 'unit-all'], tree: { ...tree([]), children: [resourceTree, unitTree] }, resourceTree, unitTree, unitIndex: [] };
}

test('course identity ignores resource markup, folder URLs, fragments and recreated documents', t => {
  const dom = documentFor(t), scanner = createCourseScanner({ window: dom.window });
  const key = scanner.contextKey();
  dom.window.document.querySelector('table').innerHTML = '<tr><td>课件列表已切换</td></tr>';
  dom.reconfigure({ url: LIST.replace('folderid=0', 'folderid=35') + '#materials' });
  assert.equal(scanner.contextKey(), key);
  dom.window.document.body.insertAdjacentHTML('beforeend', unitMenu(502));
  assert.equal(scanner.contextKey(), key);
  const reloaded = documentFor(t, listHTML([file(3)]), ORIGIN + '/meol/jpk/course/layout/lesson/index.jsp?courseId=42');
  assert.equal(createCourseScanner({ window: reloaded.window }).contextKey(), key);
});

test('course identity still detects another course, login expiration and a lost course identifier', t => {
  const dom = documentFor(t), scanner = createCourseScanner({ window: dom.window }), key = scanner.contextKey();
  dom.reconfigure({ url: LIST.replace('lid=42', 'lid=43') });
  assert.notEqual(scanner.contextKey(), key);
  dom.window.document.title = '统一身份认证';
  assert.throws(() => scanner.contextKey(), { code: 'LOGIN_REQUIRED' });
  dom.window.document.title = '教学平台';
  dom.window.document.body.replaceChildren();
  dom.reconfigure({ url: ORIGIN + '/meol/index.jsp' });
  assert.throws(() => scanner.contextKey(), { code: 'AMBIGUOUS_COURSE' });
});

test('whole-course scan freezes the unit menu before same-course navigation replaces the live page', async t => {
  const dom = documentFor(t, listHTML() + unitMenu(501), courseUrl), requested = [];
  const scanner = createCourseScanner({ window: dom.window, fetchImpl: async url => {
    requested.push(url);
    if (url.includes('/preview/download_preview.jsp')) return metadataResponse(url);
    if (url.includes('/listview.jsp')) {
      dom.window.document.body.innerHTML = listHTML([file(4)]) + unitMenu(502);
      dom.reconfigure({ url: LIST.replace('folderid=0', 'folderid=5') });
      return response(listHTML(), url);
    }
    assert.equal(url, unitEntry(501));
    return response(listHTML([file(2)]), url);
  } });
  const key = scanner.contextKey(), result = await scanner.scan({ mode: 'course' });
  assert.equal(result.surface, 'course');
  assert.deepEqual(result.modes, ['course', 'tree', 'unit-all']);
  assert.deepEqual(result.files.map(item => item.id), [file().id, file(2).id]);
  assert.deepEqual(result.unitIndex.map(item => item.columnId), ['501']);
  assert.equal(scanner.contextKey(), key);
  assert.ok(!requested.some(url => url.includes('columnId=502') || url.includes('/download.jsp')));
});

test('content scans tolerate same-course changes while metadata is in flight', async t => {
  const dom = documentFor(t), win = dom.window;
  let listener;
  Object.assign(win, { TextEncoder, TextDecoder, Response });
  win.chrome = { runtime: { id: 'local-extension', onMessage: { addListener: fn => { listener = fn; } } } };
  win.fetch = async url => {
    win.document.querySelector('table').innerHTML = '<tr><td>另一个目录</td></tr>';
    dom.reconfigure({ url: LIST.replace('folderid=0', 'folderid=5') });
    return metadataResponse(url);
  };
  win.eval(await bundle('extension/content.js'));
  const result = await new Promise(resolve => listener({ type: 'BUCT_SCAN', mode: 'directory' }, { id: 'local-extension' }, resolve));
  assert.equal(result.ok, true);
  assert.equal(result.files[0].id, file().id);
  const context = await new Promise(resolve => listener({ type: 'BUCT_CONTEXT' }, { id: 'local-extension' }, resolve));
  assert.equal(context.contextKey, result.contextKey);
});

test('extension downloads use the stored course selection after same-course URL changes', async () => {
  const h = await backgroundHarness(), scan = await h.send({ type: 'SCAN_TAB', mode: 'directory' });
  h.tabs.get(1).url = ORIGIN + '/meol/jpk/course/layout/lesson/index.jsp?courseId=42#chapter2';
  const result = await h.send({ type: 'ENQUEUE', scanId: scan.scanId, ids: [file().id], requestId: 'same-course' });
  assert.equal(result.ok, true);
  await waitFor(() => h.calls.length === 1);
  assert.equal(h.calls[0].url, file().downloadUrl);
  assert.equal(h.sent.filter(call => call.payload.type === 'BUCT_SCAN').length, 1);
});

test('whole-course results are cached across panel opening and reopening', async () => {
  const h = await backgroundHarness({ scanResult: async () => courseResult() });
  const first = await h.send({ type: 'SCAN_TAB', mode: 'course', reuse: true });
  h.chrome.action.onClicked.emit({ id: 1 });
  await waitFor(() => h.created.length === 1);
  h.chrome.action.onClicked.emit({ id: 1 });
  await waitFor(() => h.sent.filter(call => call.payload.type === 'BUCT_CONTEXT').length >= 2);
  const second = await h.send({ type: 'SCAN_TAB', mode: 'course', reuse: true });
  assert.equal(second.ok, true); assert.equal(second.reused, true); assert.equal(second.scanId, first.scanId);
  assert.equal(h.notified.length, 0);
  const stored = h.chrome.storage.session.data.courseResourceScanV2;
  assert.equal(stored.files, undefined);
  assert.equal(stored.result.files, undefined);
  assert.equal(stored.result.resourceTree, undefined);
  assert.equal(stored.result.unitTree, undefined);
  assert.equal(h.sent.filter(call => call.payload.type === 'BUCT_SCAN').length, 1);
});

test('an explicit refresh replaces the cache while login expiration is reported without pretending the directory changed', async () => {
  const h = await backgroundHarness({ scanResult: async () => courseResult() });
  const first = await h.send({ type: 'SCAN_TAB', mode: 'course', reuse: true });
  const second = await h.send({ type: 'SCAN_TAB', mode: 'course', reuse: false });
  assert.notEqual(second.scanId, first.scanId);
  assert.equal((await h.send({ type: 'ENQUEUE', scanId: first.scanId, ids: [file().id], requestId: 'old' })).code, 'STALE_SCAN');
  h.chrome.tabs.sendMessage = async () => ({ ok: false, code: 'LOGIN_REQUIRED', error: '请先登录教学平台' });
  const denied = await h.send({ type: 'ENQUEUE', scanId: second.scanId, ids: [file().id], requestId: 'login' });
  assert.equal(denied.code, 'LOGIN_REQUIRED'); assert.equal(h.calls.length, 0);
});

test('panel range changes filter the cached course without fetching or clearing selection', async t => {
  const h = await panelHarness(t, async message => {
    if (message.type === 'GET_JOBS') return { ok: true, jobs: [] };
    if (message.type === 'GET_COURSE_TAB') return { ok: true, tab: { id: 1, url: LIST } };
    if (message.type === 'SCAN_TAB') return { ...courseResult(), scanId: 'course-cache', tabId: 1 };
    throw new Error('Unexpected message: ' + message.type);
  });
  await waitFor(() => h.element('treeRoot').querySelectorAll('input[data-kind="file"]').length === 2);
  const box = h.element('treeRoot').querySelector('input[data-id="' + file().id + '"]');
  box.checked = true; box.dispatchEvent(new h.win.Event('change'));
  h.element('scopeTabs').querySelector('[data-mode="unit-all"]').click();
  assert.equal(h.element('treeRoot').querySelectorAll('input[data-kind="file"]').length, 1);
  assert.equal(h.element('selCount').textContent, '1');
  assert.match(h.element('selHidden').textContent, /1 个不在当前范围/);
  h.element('scopeTabs').querySelector('[data-mode="course"]').click();
  assert.equal(h.element('treeRoot').querySelector('input[data-id="' + file().id + '"]').checked, true);
  assert.equal(h.messages.filter(message => message.type === 'SCAN_TAB').length, 1);
  assert.equal(h.messages.find(message => message.type === 'SCAN_TAB').mode, 'course');
  assert.equal(h.messages.find(message => message.type === 'SCAN_TAB').reuse, true);
});

test('bookmarklet still saves its selected original after same-course directory changes', async t => {
  const h = await bookmarkletHarness(t);
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click();
  h.win.document.querySelector('table').innerHTML = '<tr><td>已切到另一个目录</td></tr>';
  h.win.history.replaceState(null, '', LIST.replace('folderid=0', 'folderid=9'));
  h.panel.getElementById('btnDl').click();
  await waitFor(() => h.blobs.length === 1);
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await h.blobs[0].arrayBuffer()))), ['课程资源/课件1.pdf']);
  assert.equal(h.requests.filter(request => request.url.includes('/listview.jsp')).length, 1);
});

test('bookmarklet does not discard an in-flight ZIP because the visible resource list changed', async t => {
  let finishDownload;
  const h = await bookmarkletHarness(t, { fetchImpl: async url => {
    if (url.includes('/preview/download_preview.jsp')) return metadataResponse(url);
    if (url.includes('/download.jsp')) return new Promise(resolve => { finishDownload = () => resolve(pdf(url)); });
    return response(listHTML(), url);
  } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click(); h.panel.getElementById('btnDl').click();
  await waitFor(() => finishDownload);
  h.win.document.querySelector('table').replaceChildren();
  h.win.history.replaceState(null, '', LIST + '#another-unit');
  finishDownload(); await waitFor(() => h.blobs.length === 1);
  assert.match(h.panel.getElementById('statusText').textContent, /已触发 ZIP 下载/);
});

test('bookmarklet refuses old selections after a real course switch', async t => {
  const h = await bookmarkletHarness(t);
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click();
  h.win.history.replaceState(null, '', LIST.replace('lid=42', 'lid=43'));
  h.panel.getElementById('btnDl').click();
  await waitFor(() => h.panel.getElementById('statusText').textContent.includes('已切换课程'));
  assert.equal(h.blobs.length, 0);
  assert.ok(!h.requests.some(request => request.url.includes('/download.jsp')));
});

test('platform filenames keep exact matching extensions and receive no injected preview suffix', () => {
  assert.equal(previewFilename('Lecture  One.PDF', 'pdf'), 'Lecture  One.PDF');
  assert.equal(previewFilename('Lecture  One.pptx', 'pdf'), 'Lecture  One.pdf');
  assert.equal(previewFilename('Lecture.mp4', 'mp4'), 'Lecture.mp4');
  assert.equal(previewFilename('讲义', 'txt'), '讲义.txt');
  assert.equal(previewFilename('教师命名（预览版）.pdf', 'pdf'), '教师命名（预览版）.pdf', 'an existing teacher-supplied title is not rewritten');
});


test('content still rejects a scan when the user actually changes course during metadata loading', async t => {
  const dom = documentFor(t), win = dom.window;
  let listener;
  Object.assign(win, { TextEncoder, TextDecoder, Response });
  win.chrome = { runtime: { id: 'local-extension', onMessage: { addListener: fn => { listener = fn; } } } };
  win.fetch = async url => { dom.reconfigure({ url: LIST.replace('lid=42', 'lid=43') }); return metadataResponse(url); };
  win.eval(await bundle('extension/content.js'));
  const result = await new Promise(resolve => listener({ type: 'BUCT_SCAN', mode: 'directory' }, { id: 'local-extension' }, resolve));
  assert.equal(result.ok, false); assert.equal(result.code, 'STALE_PAGE');
});

test('focusing a panel cannot put an older cached tree back over a concurrent manual refresh', async () => {
  const h = await backgroundHarness({ scanResult: async () => courseResult() });
  await h.send({ type: 'SCAN_TAB', mode: 'course' });
  const send = h.chrome.tabs.sendMessage;
  let releaseContext;
  h.chrome.tabs.sendMessage = async (id, payload, options) => payload.type === 'BUCT_CONTEXT'
    ? new Promise(resolve => { releaseContext = () => resolve({ ok: true, contextKey: h.contextKey }); })
    : send(id, payload, options);
  h.chrome.action.onClicked.emit({ id: 1 });
  await waitFor(() => releaseContext);
  const refreshed = await h.send({ type: 'SCAN_TAB', mode: 'course' });
  releaseContext(); await waitFor(() => h.created.length === 1);
  assert.equal(h.chrome.storage.session.data.courseResourceScanV2.id, refreshed.scanId);
});
