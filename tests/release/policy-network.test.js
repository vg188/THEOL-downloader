import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceUrl, pageUrl, safeSegment, filePath, uniqueArchivePath, validateFile } from '../../src/runtime/policy.js';
import { readBoundedBody, readSchoolPage, fetchFileBytes, preflightFile, requestTask, PROBE_BYTES } from '../../src/runtime/network.js';
import { normalizeSettings, planDownload } from '../../src/runtime/archive.js';
import { ORIGIN, LIST, file, response, pdf } from './helpers.js';

test('release policy rejects lookalike hosts, credentials, duplicate IDs and cross-course links', () => {
  for (const bad of [file().downloadUrl.replace('course.buct.edu.cn', 'notcourse.buct.edu.cn'), file().downloadUrl.replace('course.buct.edu.cn', 'course.buct.edu.cn.evil.test'), file().downloadUrl.replace('https://', 'https://user@'), file().downloadUrl + '&lid=42']) assert.throws(() => resourceUrl(bad));
  assert.throws(() => resourceUrl(file().previewUrl, 'preview', { courseId: '43' }));
  assert.throws(() => pageUrl(ORIGIN + '/meol/delete.do?lid=42'));
  assert.throws(() => validateFile({ ...file(), id: 'wrong' }));
});
test('portable filenames preserve the extension and contain neither traversal nor Windows devices', () => {
  assert.equal(safeSegment('CON.pdf', { filename: true }), '_CON.pdf');
  assert.equal(safeSegment('../foo.pdf', { filename: true }), '.._foo.pdf');
  assert.ok(safeSegment('😀'.repeat(120) + '.PPTX', { filename: true }).endsWith('.PPTX'));
  assert.ok(!/[\uD800-\uDBFF]\./.test(safeSegment('😀'.repeat(120) + '.PPTX', { filename: true })));
  const path = filePath(file(1, { name: '../NUL.pdf', pathSegments: ['..', 'C:\\secret', ''] }), { courseName: '课程/一' });
  assert.ok(!path.split('/').includes('..'));
  assert.ok(!/[\x00-\x1f<>:"\\|?*]/.test(path));
});
test('ZIP paths deduplicate case-insensitively in directory mode without repeating the unit section', () => {
  const used = new Set();
  const f = file(1, { section: 'unit', pathSegments: ['单元学习', '第一单元'], name: 'A.pdf' });
  assert.equal(uniqueArchivePath(f, used), '单元学习/第一单元/A.pdf');
  assert.equal(uniqueArchivePath({ ...f, name: 'a.PDF' }, used), '单元学习/第一单元/a (1).PDF');
});
test('oversized bodies stop streaming at the budget instead of reading the complete file', async () => {
  let cancelled = false, reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(readBoundedBody(new Response(body), { maxBytes: 9 }), { code: 'OVER_BUDGET' });
  assert.equal(reads, 3); assert.equal(cancelled, true);
});
test('an announced oversized body is rejected without reading any chunks', async () => {
  let reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(20)); } }, { highWaterMark: 0 });
  await assert.rejects(readBoundedBody(new Response(body, { headers: { 'content-length': '20' } }), { maxBytes: 10 }), { code: 'OVER_BUDGET' });
  assert.equal(reads, 0);
});
test('page reads honor response base URLs, declared charset and login failures', async () => {
  const result = await readSchoolPage(LIST, { courseId: '42', fetchImpl: async () => response('<meta charset="utf-8"><h1>课件</h1>', LIST, 'text/html') });
  assert.match(result.html, /课件/); assert.equal(result.url, LIST);
  await assert.rejects(readSchoolPage(LIST, { fetchImpl: async () => response('<title>登录</title>', LIST) }), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(readSchoolPage(LIST, { fetchImpl: async () => response('not found', ORIGIN + '/login.jsp') }), { code: 'LOGIN_REQUIRED' });
});
test('file reads reject HTML disguised as binary, wrong file identity and empty payloads', async () => {
  await assert.rejects(fetchFileBytes(file(), { fetchImpl: async url => response('<!doctype html><form>Login</form>', url, 'application/octet-stream') }), { code: 'BAD_FILE' });
  await assert.rejects(fetchFileBytes(file(), { fetchImpl: async () => pdf(file(2).downloadUrl) }), { code: 'BAD_FILE' });
  await assert.rejects(fetchFileBytes(file(), { fetchImpl: async url => response('', url, 'application/pdf') }), { code: 'EMPTY_FILE' });
});
test('preflight samples at most 64 KiB and cancels a server that ignores Range', async () => {
  let cancelled = false, reads = 0;
  const first = new Uint8Array(PROBE_BYTES * 2); first.set(new TextEncoder().encode('%PDF-1.7\n'));
  await preflightFile(file(), { fetchImpl: async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-' + (PROBE_BYTES - 1)); assert.equal(options.redirect, 'error');
    return response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(first); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), url, 'application/pdf');
  } });
  assert.equal(reads, 1); assert.equal(cancelled, true);
});
test('a hanging transport times out, and external cancellation retains its own reason', async () => {
  await assert.rejects(requestTask(() => new Promise(() => {}), { timeoutMs: 10 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = requestTask(() => new Promise(() => {}), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'CANCELLED' });
});
test('stored settings are normalized and always-ZIP never overrides hard limits', () => {
  assert.deepEqual(normalizeSettings({ zipMode: 'bogus', flatten: 'false', maxZipMb: 9000, maxZipFiles: -5 }), { zipMode: 'auto', flatten: false, maxZipMb: 512, maxZipFiles: 120 });
  assert.equal(planDownload([file(), file(2)], { zipMode: 'always', maxZipFiles: 1 }).mode, 'batch');
  assert.equal(planDownload([file(1, { sizeBytes: 11 * 1048576 })], { zipMode: 'always', maxZipMb: 10 }).mode, 'batch');
});

test('an unsupported same-origin column is not mislabeled as an expired login', async () => {
  await assert.rejects(readSchoolPage(LIST, { fetchImpl: async () => response('<title>通知</title>', ORIGIN + '/meol/notice.jsp') }), { code: 'UNSUPPORTED_PAGE' });
});
test('cancelling a Range probe also cancels a stalled response body', async () => {
  const controller = new AbortController(); let cancelled = false, started;
  const reading = new Promise(resolve => { started = resolve; });
  const pending = preflightFile(file(), { signal: controller.signal, fetchImpl: async url => response(new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), url, 'application/pdf') });
  await reading; controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(cancelled, true);
});

test('an invalid page response cancels its body before it can continue downloading', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readSchoolPage(LIST, { fetchImpl: async url => response(body, url, 'application/pdf') }), { code: 'BAD_PAGE' });
  assert.equal(cancelled, true);
});
