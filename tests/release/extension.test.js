import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundHarness, panelHarness, PANEL, LIST, file, tree, waitFor, bundle, listHTML } from './helpers.js';

test('the action opens an existing panel.html and rebinds an already-open panel to the clicked course', async () => {
  const h = await backgroundHarness();
  h.chrome.action.onClicked.emit({ id: 1 });
  await waitFor(() => h.created.length === 1);
  assert.equal(h.created[0].url, PANEL);
  h.tabs.set(2, { id: 2, windowId: 1, url: LIST.replace('lid=42', 'lid=43'), title: '课程二' });
  h.chrome.action.onClicked.emit({ id: 2 });
  await waitFor(() => h.notified.length === 1);
  assert.equal(h.chrome.storage.session.data.courseTabId, 2);
  assert.equal(h.created.length, 1);
});
test('privileged release messages reject course content scripts and arbitrary extension pages', async () => {
  const h = await backgroundHarness();
  for (const sender of [{ id: h.chrome.runtime.id, url: LIST, tab: { id: 1 } }, { id: 'other', url: PANEL }, { id: h.chrome.runtime.id, url: PANEL.replace('panel.html','unknown.html') }]) {
    const result = await h.send({ type: 'ENQUEUE', items: [{ url: 'https://evil.test', filename: 'file' }] }, sender);
    assert.equal(result.code, 'FORBIDDEN');
  }
  assert.equal(h.calls.length, 0);
});
test('release scans target only frame zero and only their stored file IDs can enter the queue', async () => {
  const h = await backgroundHarness();
  const scan = await h.send({ type: 'SCAN_TAB', mode: 'directory' });
  assert.equal(scan.ok, true); assert.equal(h.sent[0].options.frameId, 0);
  const result = await h.send({ type: 'ENQUEUE', scanId: scan.scanId, ids: [file().id], requestId: 'one', items: [{ url: 'https://evil.test/payload', filename: 'bad.exe' }] });
  assert.equal(result.ok, true); assert.equal(result.created.length, 1);
  await waitFor(() => h.calls.length === 1);
  assert.equal(h.calls[0].url, file().downloadUrl);
  assert.equal(h.calls[0].filename, '测试课程/课程资源/课件1.pdf');
});
test('a changed course context or an unrecognized selection cannot enqueue old files', async () => {
  const h = await backgroundHarness();
  const scan = await h.send({ type: 'SCAN_TAB', mode: 'directory' });
  const unknown = await h.send({ type: 'ENQUEUE', scanId: scan.scanId, ids: [file(2).id], requestId: 'one' });
  assert.equal(unknown.code, 'INVALID_SELECTION');
  h.contextKey = 'new-document';
  const stale = await h.send({ type: 'ENQUEUE', scanId: scan.scanId, ids: [file().id], requestId: 'two' });
  assert.equal(stale.code, 'STALE_SCAN'); assert.equal(h.calls.length, 0);
});
test('a slow older scan cannot overwrite a newer successful scan', async () => {
  let completeFirst, count = 0;
  const base = { ok: true, lid: '42', contextKey: 'document-1|course-42', courseName: '课程', tree: tree([file()]) };
  const h = await backgroundHarness({ scanResult: async () => { count++; if (count === 1) return new Promise(resolve => { completeFirst = resolve; }); return base; } });
  const first = h.send({ type: 'SCAN_TAB', mode: 'directory' });
  await waitFor(() => completeFirst);
  const second = await h.send({ type: 'SCAN_TAB', mode: 'directory' });
  completeFirst(base);
  assert.equal((await first).code, 'STALE_SCAN');
  assert.equal(h.chrome.storage.session.data.courseResourceScanV2.id, second.scanId);
});
test('panel failures clear stale choices and always restore scan controls', async t => {
  let attempts = 0;
  const h = await panelHarness(t, async message => {
    if (message.type === 'GET_JOBS') return { ok: true, jobs: [] };
    if (message.type === 'GET_COURSE_TAB') return { ok: true, tab: { id: 1, title: '课程', url: LIST } };
    if (message.type === 'SCAN_TAB') {
      attempts++;
      if (attempts > 1) throw new Error('network disconnected');
      return { ok: true, scanId: 'scan-one', tabId: 1, tree: tree([file()]), courseName: '课程', defaultMode: 'directory', modes: ['directory', 'tree'] };
    }
    throw new Error('unexpected ' + message.type);
  });
  await waitFor(() => h.element('treeRoot').querySelector('input[data-kind="file"]'));
  const input = h.element('treeRoot').querySelector('input[data-kind="file"]'); input.checked = true; input.dispatchEvent(new h.win.Event('change'));
  assert.equal(h.element('selCount').textContent, '1');
  h.element('btnRescan').click();
  await waitFor(() => /network disconnected/.test(h.element('statusBar').textContent));
  assert.equal(h.element('btnRescan').disabled, false);
  assert.equal(h.element('btnDownload').disabled, true);
  assert.equal(h.element('selCount').textContent, '0');
});
test('panel download failures do not claim submission success and allow retry', async t => {
  const h = await panelHarness(t, async message => {
    if (message.type === 'GET_JOBS') return { ok: true, jobs: [] };
    if (message.type === 'GET_COURSE_TAB') return { ok: true, tab: { id: 1, url: LIST } };
    if (message.type === 'SCAN_TAB') return { ok: true, scanId: 's', tabId: 1, tree: tree([file()]), defaultMode: 'directory', modes: ['directory', 'tree'] };
    if (message.type === 'ENQUEUE') return { ok: false, error: 'storage unavailable' };
  });
  await waitFor(() => h.element('treeRoot').querySelector('input[data-kind="file"]'));
  const input = h.element('treeRoot').querySelector('input[data-kind="file"]'); input.checked = true; input.dispatchEvent(new h.win.Event('change'));
  h.element('btnDownload').click();
  await waitFor(() => /storage unavailable/.test(h.element('statusBar').textContent));
  assert.equal(h.element('btnDownload').disabled, false);
  assert.equal(h.element('btnRescan').disabled, false);
  const submitted = h.messages.find(message => message.type === 'ENQUEUE');
  assert.deepEqual([...submitted.ids], [file().id]); assert.equal(submitted.items, undefined);
});

test('content bootstrap works on HTTP pages where crypto.randomUUID is unavailable', async () => {
  const dom = new JSDOM(listHTML(), { url: LIST.replace('https:', 'http:'), runScripts: 'outside-only' });
  try {
    let listener;
    dom.window.chrome = { runtime: { id: 'local-extension', onMessage: { addListener: fn => { listener = fn; } } } };
    Object.defineProperty(dom.window.crypto, 'randomUUID', { value: undefined });
    dom.window.eval(await bundle('extension/content.js'));
    const result = await new Promise(resolve => listener({ type: 'BUCT_SCAN', mode: 'directory' }, { id: 'local-extension' }, resolve));
    assert.equal(result.ok, true); assert.equal(result.files.length, 1);
    assert.ok(result.contextKey.length > 32);
  } finally { dom.window.close(); }
});

test('preview-only scan rows cannot be submitted even with a guessed canonical download URL', async () => {
  const blocked = file(2, { downloadable: false, unavailableReason: '没有下载入口' });
  const h = await backgroundHarness({ scanResult: async () => ({ ok: true, lid: '42', contextKey: 'document-1|course-42', tree: tree([file(), blocked]) }) });
  const scan = await h.send({ type: 'SCAN_TAB', mode: 'directory' });
  assert.equal(scan.ok, true);
  const result = await h.send({ type: 'ENQUEUE', scanId: scan.scanId, ids: [blocked.id], requestId: 'blocked' });
  assert.equal(result.code, 'INVALID_SELECTION'); assert.equal(h.calls.length, 0);
});
test('the extension panel displays preview-only rows without including them in select-all', async t => {
  const blocked = file(2, { downloadable: false, downloadUrl: '', unavailableReason: '平台仅提供在线预览' });
  const h = await panelHarness(t, async message => {
    if (message.type === 'GET_JOBS') return { ok: true, jobs: [] };
    if (message.type === 'GET_COURSE_TAB') return { ok: true, tab: { id: 1, url: LIST } };
    if (message.type === 'SCAN_TAB') return { ok: true, scanId: 's', tabId: 1, tree: tree([file(), blocked]), defaultMode: 'directory', modes: ['directory', 'tree'] };
  });
  await waitFor(() => h.element('treeRoot').querySelectorAll('input[data-kind="file"]').length === 2);
  h.element('btnSelectVisible').click();
  assert.equal(h.element('selCount').textContent, '1');
  assert.equal(h.element('treeRoot').querySelectorAll('input[data-kind="file"]:disabled').length, 1);
  assert.match(h.element('treeRoot').textContent, /平台仅提供在线预览/);
});

test('empty current-directory UI explains how to scan the subfolders instead of displaying a blank tree', async t => {
  const h = await panelHarness(t, async message => {
    if (message.type === 'GET_JOBS') return { ok: true, jobs: [] };
    if (message.type === 'GET_COURSE_TAB') return { ok: true, tab: { id: 1, url: LIST } };
    if (message.type === 'SCAN_TAB') return { ok: true, scanId: 's', tabId: 1, tree: { ...tree([]), subfolderCount: 3 }, defaultMode: 'directory', modes: ['directory', 'tree'] };
  });
  await waitFor(() => h.element('statusBar').textContent.includes('子目录'));
  assert.match(h.element('emptyState').textContent, /3 个子目录/);
  assert.equal(h.element('emptyState').classList.contains('hidden'), false);
  assert.equal(h.element('btnDownload').disabled, true);
});


test('background wakeups exist only while downloads need reconciliation and recover without a panel', async () => {
  const h = await backgroundHarness();
  const scan = await h.send({ type: 'SCAN_TAB', mode: 'directory' });
  await h.send({ type: 'ENQUEUE', scanId: scan.scanId, ids: [file().id], requestId: 'alarm-flow' });
  await waitFor(() => h.alarms.size === 1 && h.calls.length === 1);
  const alarm = [...h.alarms.values()][0]; assert.equal(alarm.periodInMinutes, 0.5);
  h.items.get(1).state = 'complete';
  h.chrome.alarms.onAlarm.emit(alarm);
  await waitFor(() => h.alarms.size === 0);
  assert.equal((await h.send({ type: 'GET_JOBS' })).jobs[0].status, 'done');
  assert.equal(h.calls.length, 1);
});
