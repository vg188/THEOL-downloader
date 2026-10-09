import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createCourseScanner, extractFiles, extractUnitIndex } from '../../src/runtime/scanner.js';
import { file, ORIGIN, LIST, link, listHTML, response, metadataResponse } from './helpers.js';
const documentFor = (html, url = LIST) => new JSDOM(html, { url }).window;

test('relative preview links use the fetched page URL rather than DOMParser about:blank', () => {
  const preview = new URL(file().previewUrl); const relative = 'preview/download_preview.jsp' + preview.search;
  const win = documentFor('<a href="' + relative + '">lecture.pdf</a>');
  try { assert.equal(extractFiles(win.document, LIST, '42')[0].downloadUrl, file().downloadUrl); }
  finally { win.close(); }
});
test('file extraction rejects unavailable links and files from a different course', () => {
  const win = documentFor(link(file()).replace('<a ', '<a hidden ') + link(file(2, { previewUrl: file(2).previewUrl.replace('lid=42', 'lid=43') })) + link(file(3)));
  try { assert.deepEqual(extractFiles(win.document, LIST, '42').map(f => f.id), [file(3).id]); }
  finally { win.close(); }
});
test('unit navigation excludes unrelated course columns and off-host destinations', () => {
  const entry = ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=10&courseId=42';
  const win = documentFor('<ul><li><a href="' + entry + '">课程资源</a><a href="' + entry.replace('columnId=10','columnId=11') + '">一</a><a href="' + entry.replace('course.buct.edu.cn','evil.test') + '">第二单元</a></li></ul>');
  try { assert.deepEqual(extractUnitIndex(win.document, LIST, '42').map(unit => unit.title), ['一']); }
  finally { win.close(); }
});
test('auto scope scans the current directory without fetching the whole course tree', async t => {
  const win = documentFor(listHTML()); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async url => { assert.equal(url, file().previewUrl); return metadataResponse(url); } }).scan();
  assert.equal(result.defaultMode, 'directory'); assert.equal(result.files.length, 1);
});
test('the preview filename overrides an icon guess (old PowerPoint is not renamed to pptx)', async t => {
  const f = file(1, { name: '第一讲', originalName: '第一讲' });
  const win = documentFor(listHTML([f]).replace('<td>', '<td><img src="/meol/common/icons/powerpoint.gif">')); t.after(() => win.close());
  const seen = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    seen.push(url);
    return response('<h2>文件名：真正课件.ppt (12KB)<a href="' + file().downloadUrl + '">下载</a></h2>', url);
  } }).scan({ mode: 'directory' });
  assert.equal(result.files[0].name, '真正课件.ppt'); assert.equal(result.files[0].ext, 'ppt'); assert.equal(result.files[0].sizeBytes, 12288);
  assert.deepEqual(seen, [file().previewUrl]);
});
test('directory traversal stops cycles and exposes child failures instead of silently claiming an empty folder', async t => {
  const row = '<tr><td><img src="folder.gif"><a href="listview.jsp?acttype=enter&folderid=5&lid=42">子目录</a></td></tr>';
  const win = documentFor(listHTML([file()], row)); t.after(() => win.close());
  const seen = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    seen.push(url);
    if (url === file().previewUrl) return metadataResponse(url);
    if (new URL(url).searchParams.get('folderid') === '5') throw new Error('offline child');
    return response(listHTML([file()], row + row.replace('folderid=5', 'folderid=0')), url);
  } }).scan({ mode: 'tree' });
  assert.equal(seen.length, 3); assert.equal(result.failures.length, 1);
  assert.equal(result.files[0].downloadable, true);
  assert.equal(result.tree.children[1].scanError, 'offline child');
});
test('all-unit scanning follows redirected page bases and reports the all-unit mode', async t => {
  const entry = ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=10&courseId=42';
  const current = ORIGIN + '/meol/jpk/course/layout/newpage/index.jsp?courseId=42';
  const child = ORIGIN + '/meol/jpk/course/layout/newpage/resFolderViewList.do?lid=42&columnId=10';
  const win = documentFor('<title>网络课程 — 测试课程</title><ul><li><a href="' + entry + '">第一单元</a></li></ul>', current); t.after(() => win.close());
  const requests = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    requests.push(url);
    if (url === file().previewUrl) return metadataResponse(url);
    if (url === entry) return response('<iframe src="resFolderViewList.do?lid=42&columnId=10"></iframe>', current);
    assert.equal(url, child);
    return response(link(file()).replace(file().previewUrl, '../../../../common/script/preview/download_preview.jsp?fileid=1&resid=101&lid=42'), child);
  } }).scan({ mode: 'unit-all' });
  assert.equal(result.defaultMode, 'unit-all'); assert.deepEqual(result.files.map(f => f.id), [file().id]);
  assert.deepEqual(requests, [entry, child, file().previewUrl]);
  assert.equal(result.files[0].downloadable, true);
});
test('failed unit child pages are visible in diagnostics while successful siblings remain usable', async t => {
  const entry = ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=10&courseId=42';
  const win = documentFor('<ul><li><a href="' + entry + '">第一单元</a></li></ul>', ORIGIN + '/meol/jpk/course/layout/newpage/index.jsp?courseId=42'); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    if (url === file().previewUrl) return metadataResponse(url);
    if (url === entry) return response(link(file()) + '<iframe src="/meol/jpk/course/resFolderViewList.do?lid=42"></iframe>', url);
    throw new Error('unit frame unavailable');
  } }).scan({ mode: 'unit-all' });
  assert.equal(result.files.length, 1); assert.equal(result.failures.length, 1);
});
test('course discovery refuses an ambiguous course list instead of choosing the most frequent ID', async t => {
  const win = documentFor('<a href="' + LIST + '">课程一</a><a href="' + LIST.replace('lid=42','lid=43') + '">课程二</a>', ORIGIN + '/meol/index.jsp'); t.after(() => win.close());
  await assert.rejects(createCourseScanner({ window: win }).scanAll(), { code: 'AMBIGUOUS_COURSE' });
});
test('cancelled scans stop both traversal and metadata work', async t => {
  const win = documentFor(listHTML()); t.after(() => win.close());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createCourseScanner({ window: win, signal: controller.signal, fetchImpl: async () => { throw new Error('should not fetch'); } }).scan({ mode: 'tree' }), { code: 'CANCELLED' });
});

test('navigation lists cannot silently become an all-unit scan range', () => {
  const entry = ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=10&courseId=42';
  const win = documentFor('<nav><ul><li><a href="' + entry + '">考试资料</a></li></ul></nav><a href="' + entry.replace('columnId=10','columnId=11') + '">任意链接</a>');
  try { assert.deepEqual(extractUnitIndex(win.document, LIST, '42'), []); } finally { win.close(); }
});
test('current unit reaches nested same-origin list frames without treating them as a different course', async t => {
  const entry = ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=10&courseId=42';
  const win = documentFor('<ul><li><a href="' + entry + '">第一单元</a></li></ul><iframe></iframe>', ORIGIN + '/meol/jpk/course/layout/lesson/index.jsp?courseId=42');
  const child = documentFor(listHTML()); t.after(() => { win.close(); child.close(); });
  // WindowProxy frame collections are indexed, not iterable.
  Object.defineProperty(win, 'frames', { value: { 0: child, length: 1 } });
  Object.defineProperty(child, 'parent', { value: win });
  const result = await createCourseScanner({ window: win, fetchImpl: async url => { assert.equal(url, file().previewUrl); return metadataResponse(url); } }).scan();
  assert.equal(result.defaultMode, 'unit-current'); assert.equal(result.files[0].id, file().id); assert.equal(result.files[0].downloadable, true);
});


test('a resource-only course does not report missing unit content as a failed scan', async t => {
  const win = documentFor(listHTML()); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async url => url.includes('/preview/') ? metadataResponse(url) : response(listHTML(), url) }).scanAll();
  assert.equal(result.resourceFiles.length, 1); assert.equal(result.unitFiles.length, 0);
  assert.equal(result.failures.length, 0);
  assert.match(result.unitTree.emptyReason, /未发现/);
});
test('declining all-unit scanning from resources is a deliberate empty state, not a failed request', async t => {
  const entry = ORIGIN + '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=51&courseId=42';
  const win = documentFor(listHTML() + '<ul id="ul_advance"><li><a href="' + entry + '">第一单元</a></li></ul>'); t.after(() => win.close());
  const requested = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => { requested.push(url); return url.includes('/preview/') ? metadataResponse(url) : response(listHTML(), url); } }).scanAll({ includeAllUnits: false });
  assert.equal(result.failures.length, 0); assert.equal(result.unitIndex.length, 1);
  assert.match(result.unitTree.emptyReason, /本次未读取/); assert.equal(requested.includes(entry), false);
});
