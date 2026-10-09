import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, unzipSync } from 'fflate';
import { inspectFileContent } from '../../src/runtime/file-content.js';
import { createArchive } from '../../src/runtime/archive.js';
import { preflightFile } from '../../src/runtime/network.js';
import { file, response, panelHarness, bookmarkletHarness, listHTML, previewHTML, waitFor, tree, LIST } from './helpers.js';

const emptyZip = zipSync({});
const resource = file(1, { name: '目录打包文件.zip', ext: 'zip', group: 'archive', sizeBytes: 22, sizeExact: true });
function originalResponse(url) {
  const res = response(emptyZip, url, 'application/octet-stream');
  res.headers.set('content-length', '22');
  res.headers.set('content-disposition', 'attachment; filename="' + encodeURIComponent(resource.name) + '"');
  return res;
}
test('an empty original ZIP is valid but receives an explicit source-content warning', () => {
  const result = inspectFileContent(emptyZip, resource);
  assert.equal(result.entries, 0);
  assert.ok(result.warnings.some(w => w.code === 'EMPTY_SOURCE_ZIP'));
});
test('a complete ignored-Range response retains its empty-source warning without changing the file', async () => {
  const probe = await preflightFile(resource, { fetchImpl: async url => originalResponse(url), includeBytes: true });
  assert.equal(probe.sampleComplete, true);
  assert.ok(probe.warnings.some(w => w.code === 'EMPTY_SOURCE_ZIP'));
  assert.deepEqual(probe.bytes, emptyZip);
});
test('the outer ZIP preserves an empty original while returning a per-file warning', async () => {
  const result = await createArchive([resource], { fetchImpl: async url => originalResponse(url) });
  assert.equal(result.count, 1); assert.equal(result.skipped.length, 0);
  assert.equal(result.warnings[0].id, resource.id);
  assert.equal(result.warnings[0].code, 'EMPTY_SOURCE_ZIP');
  assert.deepEqual(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))['课程资源/' + resource.name], emptyZip);
});
test('the extension keeps browser completion separate from a source-content warning', async t => {
  const h = await panelHarness(t, async message => {
    if (message.type === 'GET_COURSE_TAB') return { ok: true, tab: { id: 1, url: LIST } };
    if (message.type === 'SCAN_TAB') return { ok: true, scanId: 's', tabId: 1, tree: tree([resource]), modes: ['directory'], defaultMode: 'directory' };
    if (message.type === 'GET_JOBS') return { ok: true, jobs: [{ id: 'j', name: resource.name, filename: '课程/' + resource.name, status: 'done', fileSize: 22, preflight: { sampleComplete: true, level: 'container-crc', warnings: [{ code: 'EMPTY_SOURCE_ZIP', message: '原 ZIP 为空（0 个条目）' }] } }] };
  });
  await waitFor(() => h.element('jobsList').querySelector('.job-warning'));
  assert.match(h.element('jobsList').textContent, /浏览器已完成/);
  assert.match(h.element('jobsList').querySelector('.job-warning').textContent, /原 ZIP 为空/);
});
test('bookmarklet ZIP success retains original-content warnings rather than silently treating the file as full', async t => {
  const h = await bookmarkletHarness(t, { html: listHTML([resource]), fetchImpl: async url => {
    if (url.includes('/preview/download_preview.jsp')) return response(previewHTML(resource).replace('(12K)', '(22B )'), url);
    if (url.includes('/download.jsp')) return originalResponse(url);
    return response(listHTML([resource]), url);
  } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  h.panel.getElementById('btnSelVis').click(); h.panel.getElementById('btnDl').click();
  await waitFor(() => h.blobs.length === 1);
  assert.match(h.panel.getElementById('downloadReport').textContent, /原 ZIP 为空/);
  assert.match(h.panel.getElementById('statusText').textContent, /内容提示/);
});


test('server-style percent encoding with literal spaces and ignored Range remains compatible', async () => {
  const { fixtureBytes } = await import('./helpers.js');
  const body = fixtureBytes('sample.pdf'), selected = file(9, { name: '0 课程导言.pdf', sizeBytes: 0.1 * 1048576, sizeExact: false });
  const probe = await preflightFile(selected, { fetchImpl: async url => {
    const res = response(body, url, 'application/pdf'); res.headers.set('content-disposition', 'attachment; filename="0 %E8%AF%BE%E7%A8%8B%E5%AF%BC%E8%A8%80.pdf"'); res.headers.set('content-length', String(body.length)); return res;
  } });
  assert.equal(probe.responseName, selected.name); assert.equal(probe.expectedBytes, body.length);
  assert.equal(probe.sampleComplete, true);
});
