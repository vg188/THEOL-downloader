import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { createArchive } from '../../src/runtime/archive.js';
import { bookmarkletHarness, file, listHTML, response, pdf, waitFor, metadataResponse, previewHTML } from './helpers.js';

test('reopening a running bookmarklet shows the same panel and does not start another scan', async t => {
  let complete;
  const h = await bookmarkletHarness(t, { fetchImpl: (url, options) => url.includes('/preview/download_preview.jsp') ? metadataResponse(url) : new Promise((resolve, reject) => {
    complete = () => resolve(response(listHTML(), url));
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await waitFor(() => h.requests.length === 1);
  const host = h.win.__buctTabDl.host;
  h.panel.getElementById('btnClose').click();
  assert.equal(host.style.display, 'none');
  h.run();
  assert.equal(h.win.__buctTabDl.host, host); assert.equal(host.style.display, ''); assert.equal(h.requests.length, 1);
  complete(); await waitFor(() => !h.panel.getElementById('btnScan').disabled);
});
test('stopping a scan aborts network work and leaves no downloadable stale selection', async t => {
  let aborted = false;
  const h = await bookmarkletHarness(t, { fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) });
  await waitFor(() => h.requests.length === 1);
  h.panel.getElementById('btnCancel').click();
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  assert.equal(aborted, true); assert.equal(h.panel.getElementById('btnDl').disabled, true); assert.equal(h.clicks.length, 0);
});
test('the real bookmarklet produces a valid ZIP and reports triggered rather than saved', async t => {
  const h = await bookmarkletHarness(t);
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click(); h.panel.getElementById('btnDl').click();
  await waitFor(() => h.blobs.length === 1);
  const entries = unzipSync(new Uint8Array(await h.blobs[0].arrayBuffer()));
  assert.deepEqual(Object.keys(entries), ['课程资源/课件1.pdf']);
  assert.match(strFromU8(entries['课程资源/课件1.pdf']), /^%PDF-/);
  assert.match(h.panel.getElementById('statusText').textContent, /已触发 ZIP 下载/);
  assert.ok(!h.panel.getElementById('statusText').textContent.includes('已下载压缩包'));
});
test('archive retries skip failed files in place instead of downloading previous successes again', async () => {
  const calls = [];
  const result = await createArchive([file(), file(2), file(3)], { fetchImpl: async url => {
    calls.push(url);
    if (url === file(2).downloadUrl) throw new Error('offline');
    return pdf(url);
  }, shouldSkip: async () => true });
  assert.equal(result.count, 2); assert.equal(result.skipped.length, 1); assert.equal(calls.length, 3);
  assert.equal(Object.keys(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))).length, 2);
});
test('all failed files never create a misleading empty ZIP', async () => {
  await assert.rejects(createArchive([file()], { fetchImpl: async () => { throw new Error('offline'); }, shouldSkip: async () => true }), { code: 'EMPTY_ARCHIVE' });
});
test('scan errors are rendered as text and not executable HTML', async t => {
  const h = await bookmarkletHarness(t, { fetchImpl: async () => { throw new Error('<img src=x onerror="alert(1)">'); } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  assert.equal(h.panel.querySelector('img'), null);
  assert.match(h.panel.getElementById('tree').textContent, /<img/);
});
test('a failed scan after selection clears the old files instead of enabling an obsolete download', async t => {
  let fail = false;
  const h = await bookmarkletHarness(t, { fetchImpl: async url => {
    if (fail) return response('<title>登录</title>', url);
    return url.includes('/preview/download_preview.jsp') ? metadataResponse(url) : response(listHTML(), url);
  } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click(); assert.equal(h.panel.getElementById('selN').textContent, '1');
  fail = true; h.panel.getElementById('btnScan').click();
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  assert.equal(h.panel.getElementById('selN').textContent, '0'); assert.equal(h.panel.getElementById('btnDl').disabled, true);
});
test('rescan and settings are frozen while a download is in flight, and stop never falls back to batch', async t => {
  const h = await bookmarkletHarness(t, { fetchImpl: async (url, options) => {
    if (url.includes('/preview/download_preview.jsp')) return metadataResponse(url);
    if (!url.includes('/download.jsp')) return response(listHTML(), url);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click(); h.panel.getElementById('btnDl').click();
  await waitFor(() => h.requests.some(request => request.url.includes('/download.jsp')));
  assert.equal(h.panel.getElementById('btnScan').disabled, true); assert.equal(h.panel.getElementById('btnSettings').disabled, true);
  h.panel.getElementById('btnCancel').click();
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  assert.equal(h.clicks.length, 0);
});

test('a course summary reads all discovered units without another scope confirmation', async t => {
  const entry = 'https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=501&courseId=42';
  let confirmations = 0;
  const h = await bookmarkletHarness(t, { html: listHTML() + '<ul><li><a href="' + entry + '">第一单元</a></li></ul>', confirm: () => { confirmations++; return false; } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  assert.equal(confirmations, 0);
  assert.equal(h.requests.some(request => request.url.includes('course_column_preview_transfer')), true);
  assert.equal(h.requests.some(request => request.url.includes('/download.jsp')), false);
  assert.equal(h.panel.getElementById('cntRes').textContent, '1');
});

test('preview-only entries stay visible and every selection path refuses them', async t => {
  const h = await bookmarkletHarness(t, { fetchImpl: async url => url.includes('/preview/download_preview.jsp') ? response(previewHTML(file(), false), url) : response(listHTML(), url) });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  const fileBox = h.panel.querySelector('input[data-kind="file"]');
  assert.ok(fileBox); assert.equal(fileBox.disabled, true);
  assert.equal(h.win.__buctTabDl.host.parentElement, h.win.document.body);
  assert.ok(!h.panel.querySelector(".dot").classList.contains("busy"));
  assert.match(h.panel.getElementById('tree').textContent, /平台未提供原文件下载入口/);
  h.panel.getElementById('btnSelVis').click();
  assert.equal(h.panel.getElementById('selN').textContent, '0');
  fileBox.checked = true; fileBox.dispatchEvent(new h.win.Event('change'));
  assert.equal(h.panel.getElementById('selN').textContent, '0');
  assert.equal(h.panel.getElementById('btnDl').disabled, true);
  assert.equal(h.requests.some(request => request.url.includes('/download.jsp')), false);
});


test('batch download retains individual failure reasons as text after its final summary', async t => {
  const files = [file(), file(2)];
  const h = await bookmarkletHarness(t, { html: listHTML(files), fetchImpl: async url => {
    if (url.includes('/preview/download_preview.jsp')) return metadataResponse(url);
    if (!url.includes('/download.jsp')) return response(listHTML(files), url);
    if (url === file(2).downloadUrl) throw new Error('网络失败 <img src=x onerror=alert(1)>');
    return pdf(url);
  } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSettings').click(); h.panel.getElementById('setZipMode').value = 'never'; h.panel.getElementById('setSave').click();
  h.panel.getElementById('btnSelVis').click(); h.panel.getElementById('btnDl').click();
  await waitFor(() => h.panel.getElementById('statusText').textContent.includes('已触发 1 个下载'));
  assert.equal(h.clicks.length, 1); assert.equal(h.clicks[0].filename, file().name);
  assert.match(h.panel.getElementById('downloadReport').textContent, /课件2\.pdf：网络失败 <img/);
  assert.equal(h.panel.getElementById('downloadReport').querySelector('img'), null);
  assert.match(h.panel.getElementById('dlNote').textContent, /不能核对落盘内容/);
});
test('a skipped same-name file does not reserve an unused ZIP suffix', async () => {
  const result = await createArchive([file(1, { name: 'A.pdf' }), file(2, { name: 'A.pdf' })], { fetchImpl: async url => { if (url === file().downloadUrl) throw new Error('failed'); return pdf(url); }, shouldSkip: async () => true });
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))), ['课程资源/A.pdf']);
});
