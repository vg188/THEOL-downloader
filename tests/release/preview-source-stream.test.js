import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unzipSync } from 'fflate';
import { createCourseScanner } from '../../src/runtime/scanner.js';
import { findPreviewDownload } from '../../src/runtime/preview.js';
import { validateFile, previewSourceUrl, isPreviewSource, requiresPreparedDownload, matchesFileUrl } from '../../src/runtime/policy.js';
import { fetchFileBytes, preflightFile } from '../../src/runtime/network.js';
import { assertFileMime } from '../../src/runtime/file-content.js';
import { createArchive } from '../../src/runtime/archive.js';
import { createDownloadQueue } from '../../src/runtime/download-queue.js';
import { LIST, ORIGIN, listHTML, previewHTML, response, fixtureBytes, nativeDownloads, memoryStorage, waitFor, bookmarkletHarness } from './helpers.js';
import { VIEWER_URL, WHOLE_PDF, sourceFile, slideHTML, sourceStreamHTML, streamUrl } from './preview-helpers.js';

function streamFile(extras = {}) {
  const file = sourceFile(extras), dom = new JSDOM(sourceStreamHTML(file), { url: VIEWER_URL });
  try { return findPreviewDownload(dom.window.document, file, VIEWER_URL).file; } finally { dom.window.close(); }
}

test('dormant THEOL PDF-viewer assignment exposes an original stream, not a guessed PDF', () => {
  const input = sourceFile(), dom = new JSDOM(slideHTML([], sourceStreamHTML(input) + '<embed src="' + WHOLE_PDF + '">'));
  try {
    const file = findPreviewDownload(dom.window.document, input, VIEWER_URL).file;
    assert.ok(isPreviewSource(file)); assert.ok(requiresPreparedDownload(file));
    assert.equal(file.downloadUrl, streamUrl(input)); assert.equal(file.name, 'Lesson One.pptx');
    assert.equal(file.ext, 'pptx'); assert.equal(file.preview, undefined);
    assert.equal(validateFile(file, '42').id, input.id);
  } finally { dom.window.close(); }
});
test('an active PDF viewer remains a complete PDF candidate, not an assumed Office source', () => {
  const dom = new JSDOM('<iframe id="pdfIframe"></iframe>' + sourceStreamHTML());
  try { const file = findPreviewDownload(dom.window.document, sourceFile(), VIEWER_URL).file; assert.equal(file.preview.kind, 'pdf'); assert.equal(isPreviewSource(file), false); }
  finally { dom.window.close(); }
});
test('an unrelated endpoint string without the known viewer binding is not a source', () => {
  const dom = new JSDOM('<script>var note="' + streamUrl() + '";</script>');
  try { assert.equal(findPreviewDownload(dom.window.document, sourceFile(), VIEWER_URL).file, null); } finally { dom.window.close(); }
});
test('scanner follows preview.jsp to the declared stream without downloading bodies or slide images', async t => {
  const input = sourceFile(), win = new JSDOM(listHTML([input]), { url: LIST }).window; t.after(() => win.close()); const requests = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    requests.push(url);
    if (url === input.previewUrl) return response(previewHTML(input, false) + '<iframe src="' + VIEWER_URL + '"></iframe>', url);
    assert.equal(url, VIEWER_URL); return response(slideHTML(undefined, sourceStreamHTML(input)), url);
  } }).scan({ mode: 'directory' });
  assert.deepEqual(requests, [input.previewUrl, VIEWER_URL]); assert.ok(isPreviewSource(result.files[0]));
  assert.equal(result.files[0].name, input.originalName);
});
test('an offered canonical original still wins over the preview stream', async t => {
  const input = sourceFile(), win = new JSDOM(listHTML([input]), { url: LIST }).window; t.after(() => win.close());
  const original = ORIGIN + '/meol/common/script/download.jsp?fileid=1&resid=101&lid=42';
  const result = await createCourseScanner({ window: win, fetchImpl: async url => response(previewHTML({ ...input, downloadUrl: original }) + sourceStreamHTML(input), url) }).scan({ mode: 'directory' });
  assert.equal(result.files[0].downloadUrl, original); assert.equal(isPreviewSource(result.files[0]), false);
});
for (const ext of ['pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls', 'pdf']) test('complete source stream preserves .' + ext + ' bytes even under the servlet PDF MIME', async () => {
  const file = streamFile({ name: 'Source.' + ext, originalName: 'Source.' + ext }), body = fixtureBytes('sample.' + ext), calls = [];
  const probe = await preflightFile(file, { includeBytes: true, fetchImpl: async (url, options) => { calls.push({ url, range: options.headers?.Range }); return response(body, url, 'application/pdf;charset=UTF-8'); } });
  assert.deepEqual(Buffer.from(probe.bytes), body); assert.equal(probe.sampleComplete, true); assert.equal(probe.expectedFileBytes, body.length);
  assert.equal(probe.requiresLocalDownload, true); assert.equal(probe.contentType, 'application/octet-stream');
  assert.notEqual(probe.level, 'prefix'); assert.deepEqual(calls, [{ url: streamUrl(file), range: undefined }]);
  if (ext !== 'pdf') assert.ok(probe.warnings.some(w => w.code === 'PREVIEW_STREAM_MIME'));
});
test('Office MIME compatibility is not extended to an ordinary original download', async () => {
  const f = streamFile(), original = { ...f, downloadSource: undefined, downloadUrl: ORIGIN + '/meol/common/script/download.jsp?fileid=1&resid=101&lid=42' };
  assert.throws(() => assertFileMime(f, 'application/pdf'), { code: 'BAD_FILE' });
  await assert.rejects(fetchFileBytes(original, { fetchImpl: async url => response(fixtureBytes('sample.pptx'), url, 'application/pdf') }), { code: 'BAD_FILE' });
});
for (const [name, body, type] of [
  ['HTML login page', '<html><body>登录</body></html>', 'text/html'],
  ['wrong Office type', fixtureBytes('sample.docx'), 'application/pdf'],
  ['PDF pretending to be PPTX', fixtureBytes('sample.pdf'), 'application/pdf'],
  ['truncated Office archive', fixtureBytes('sample.pptx').subarray(0, 1000), 'application/pdf'],
]) test('a source stream refuses ' + name + ' rather than saving or silently falling back', async () => {
  await assert.rejects(preflightFile(streamFile(), { includeBytes: true, fetchImpl: async url => response(body, url, type) }), { code: 'BAD_FILE' });
});
test('source streams retain exact size checks and bounded/cancellable reads', async () => {
  const f = streamFile(), body = fixtureBytes('sample.pptx'), fetchImpl = async url => response(body, url, 'application/pdf');
  await assert.rejects(fetchFileBytes({ ...f, sizeExact: true, sizeBytes: body.length + 1 }, { fetchImpl }), { code: 'SIZE_MISMATCH' });
  await assert.rejects(fetchFileBytes(f, { fetchImpl, maxBytes: 10 }), { code: 'OVER_BUDGET' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(preflightFile(f, { fetchImpl, signal: controller.signal }), { code: 'CANCELLED' });
});
test('source stream identity refuses wrong courses, resources, wrappers, origins and filenames', () => {
  const f = streamFile();
  for (const url of [streamUrl().replace('101', '999'), streamUrl().replace('lid=42', 'lid=43'), streamUrl() + '&resId=101', streamUrl() + '&file=anything', streamUrl() + '&other=1', streamUrl().replace('course.buct.edu.cn', 'evil.example')]) {
    assert.throws(() => validateFile({ ...f, downloadUrl: url })); assert.equal(matchesFileUrl(f, url), false);
  }
  for (const patch of [{ id: '42:102:1' }, { fileid: '9' }, { name: 'Renamed.pdf' }, { previewUrl: '' }, { sourceUrl: streamUrl() }, { downloadKind: 'preview-source' }, { downloadSource: 'other' }]) assert.throws(() => validateFile({ ...f, ...patch }));
  assert.throws(() => previewSourceUrl(streamUrl(), { ...f, originalName: 'unrecognized.bin' }));
  assert.ok(matchesFileUrl(f, streamUrl()));
});
test('a mismatched declared source ID is not requested or replaced with a fabricated endpoint', () => {
  const dom = new JSDOM(sourceStreamHTML(sourceFile(), streamUrl().replace('101', '999')));
  try { assert.throws(() => findPreviewDownload(dom.window.document, sourceFile(), VIEWER_URL), { code: 'WRONG_RESOURCE' }); } finally { dom.window.close(); }
});
test('source ZIP entries preserve the Office name, structure and exact bytes', async () => {
  const f = streamFile(), calls = [], body = fixtureBytes('sample.pptx');
  const { blob } = await createArchive([f], { fetchImpl: async url => { calls.push(url); return response(body, url, 'application/pdf'); } });
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(entries), ['课程资源/' + f.name]); assert.deepEqual(Buffer.from(entries['课程资源/' + f.name]), body); assert.deepEqual(calls, [streamUrl()]);
});
test('source queue refuses a remote or missing prepared Blob and audits the local file identity', async () => {
  const f = streamFile(), native = nativeDownloads(), released = [], blob = 'blob:chrome-extension://abcdefghijklmnopabcdefghijklmnop/verified-source';
  const nativeDownload = native.downloads.download; native.downloads.download = async options => { const id = await nativeDownload(options); native.items.get(id).mime = 'application/octet-stream'; return id; };
  const queue = createDownloadQueue({ storage: memoryStorage(), downloads: native.downloads, extensionId: 'abcdefghijklmnopabcdefghijklmnop', preflight: async () => ({ blobUrl: blob, sampleComplete: true, expectedBytes: 123, expectedFileBytes: 123 }), releasePrepared: async id => released.push(id), makeId: () => 'source-job' });
  await queue.enqueue([f], { requestId: 'source' }); await waitFor(() => native.calls.length === 1);
  assert.equal(native.calls[0].url, blob); assert.match(native.calls[0].filename, /\.pptx$/);
  Object.assign(native.items.get(1), { mime: 'application/octet-stream', state: 'complete', fileSize: 123, totalBytes: 123, exists: true });
  assert.equal((await queue.refresh())[0].status, 'done'); assert.ok(released.includes('source-job'));
  const denied = nativeDownloads(), bad = createDownloadQueue({ storage: memoryStorage(), downloads: denied.downloads, extensionId: 'abcdefghijklmnopabcdefghijklmnop', preflight: async () => ({ blobUrl: streamUrl() }), makeId: () => 'bad-source' });
  await bad.enqueue([f], { requestId: 'bad-source' }); await waitFor(async () => (await bad.getJobs())[0]?.status === 'failed'); assert.equal(denied.calls.length, 0);
});
test('bookmarklet explains the source stream and saves verified original bytes, never a renamed PDF', async t => {
  const input = sourceFile(), h = await bookmarkletHarness(t, { html: listHTML([input]), fetchImpl: async url => {
    if (url === input.previewUrl) return response(previewHTML(input, false) + sourceStreamHTML(input), url);
    if (url === streamUrl()) return response(fixtureBytes('sample.pptx'), url, 'application/pdf');
    return response(listHTML([input]), url);
  } });
  await waitFor(() => !h.panel.getElementById('btnScan').disabled);
  assert.match(h.panel.getElementById('tree').textContent, /整份资源流/);
  const nativeTrim = h.win.String.prototype.trim; h.win.String.prototype.trim = function () { throw new Error('Page-overridden trim must not be called'); };
  t.after(() => { h.win.String.prototype.trim = nativeTrim; });
  h.panel.getElementById('btnSelVis').click(); h.panel.getElementById('btnDl').click(); await waitFor(() => h.blobs.length === 1);
  const entries = unzipSync(new Uint8Array(await h.blobs[0].arrayBuffer()));
  assert.deepEqual(Object.keys(entries), ['课程资源/Lesson One.pptx']); assert.deepEqual(Buffer.from(Object.values(entries)[0]), fixtureBytes('sample.pptx'));
  assert.equal(h.requests.some(r => r.url.includes('_slide-') || r.url.includes('/download.jsp')), false);
});
