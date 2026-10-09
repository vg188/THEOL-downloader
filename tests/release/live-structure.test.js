import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createCourseScanner, extractUnitIndex } from '../../src/runtime/scanner.js';
import { displayName, safeSegment, availabilityCounts } from '../../src/runtime/policy.js';
import { ORIGIN, LIST, file, listHTML, response } from './helpers.js';

// Synthetic fixtures preserve the structure observed on THEOL, not account or course data.
const entry = id => '/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=' + id;
const link = (id, text) => '<a href="' + entry(id) + '">' + text + '</a>';
const menus = '<div class="nav"><ul id="tmenu"><li><a>课程资源</a></li></ul></div>'
  + '<div class="sidebar" style="display:none"><div id="menu">'
  + '<ul class="ul_100" style="display:none"><li>' + link(900, '答疑讨论') + '</li><li>' + link(901, '试题试卷库') + '</li></ul>'
  + '<ul id="ul_advance" style="display:none"><li>' + link(10, '第一单元') + '<ul style="display:none"><li>' + link(11, '嵌套第二单元') + '</li></ul></li></ul>'
  + '<ul class="ul_200s" style="display:none"><li>' + link(10, '第一单元') + '</li></ul></div></div>';
const windowFor = (html, url = LIST) => new JSDOM(html, { url }).window;
const previewHTML = (f, download = true) => '<h2>文件名：<span>' + f.name + '</span><span class="right"> (12.5K\n)</span>' + (download ? '<a href="' + f.downloadUrl + '">下载</a>' : '') + '</h2>';
function attach(parent, child) { Object.defineProperty(parent, 'frames', { value: { 0: child, length: 1 } }); Object.defineProperty(child, 'parent', { value: parent }); }

test('the dedicated learning tree excludes dormant activity menus but includes collapsed nested units', () => {
  const win = windowFor(menus);
  try { assert.deepEqual(extractUnitIndex(win.document, LIST, '42').map(unit => unit.columnId), ['10', '11']); }
  finally { win.close(); }
});
test('a layout shell with a hidden unit tree cannot steal the active resource-directory scope', async t => {
  const win = windowFor(menus, ORIGIN + '/meol/jpk/course/layout/lesson/index.jsp?courseId=42');
  const shell = windowFor('', ORIGIN + '/meol/common/script/courseResource.jsp?lid=42');
  const child = windowFor(listHTML()); attach(win, shell); attach(shell, child);
  t.after(() => { win.close(); shell.close(); child.close(); });
  const requests = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => { requests.push(url); return response(previewHTML(file()), url); } }).scan();
  assert.equal(result.defaultMode, 'directory'); assert.equal(result.surface, 'resource-directory');
  assert.equal(result.files.length, 1); assert.ok(requests.every(url => url.includes('/preview/download_preview.jsp')));
});
test('display names and output names survive a host page that overwrites String.trim to remove all spaces', () => {
  const original = String.prototype.trim; let display, path;
  try {
    String.prototype.trim = function () { return this.replace(/ /g, ''); };
    display = displayName('  Lecture One 2026.pdf  ');
    path = safeSegment('  Lecture One 2026.pdf  ', { filename: true });
  } finally { String.prototype.trim = original; }
  assert.equal(display, 'Lecture One 2026.pdf'); assert.equal(path, 'Lecture One 2026.pdf');
});
test('a list filename with a suffix still requires original metadata and a real download link', async t => {
  const win = windowFor(listHTML()); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async url => response(previewHTML(file(1, { name: 'Original Lecture.pptx' }), false), url) }).scan({ mode: 'directory' });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'Original Lecture.pptx');
  assert.equal(result.files[0].sizeBytes, 12800);
  assert.equal(result.files[0].downloadable, false);
  assert.ok(!result.files[0].downloadUrl);
  assert.match(result.files[0].unavailableReason, /下载入口/);
});
test('a directly embedded preview remains visible and unselectable instead of making the unit look empty', async t => {
  const url = ORIGIN + '/meol/buildless/resFolderViewList.do?folderid=20&lid=42&columnId=10';
  const html = '<div id="dowload-preview">' + previewHTML(file(1, { name: 'Lecture One.pptx' }), false) + '<iframe id="ifm" src="/meol/common/script/preview/preview.jsp?fileid=1"></iframe></div>';
  const win = windowFor(html, url); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async () => { throw new Error('must not fetch converted content'); } }).scan({ mode: 'unit-current' });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].name, 'Lecture One.pptx');
  assert.equal(result.files[0].downloadable, false); assert.equal(result.files[0].downloadUrl, '');
});
test('an inline preview with a matching platform download anchor is usable without inventing URLs', async t => {
  const url = ORIGIN + '/meol/buildless/resFolderViewList.do?folderid=20&lid=42&columnId=10';
  const html = '<div id="dowload-preview">' + previewHTML(file(), true) + '<iframe src="/meol/common/script/preview/preview.jsp?fileid=1"></iframe></div>';
  const win = windowFor(html, url); t.after(() => win.close());
  const result = await createCourseScanner({ window: win }).scan({ mode: 'unit-current' });
  assert.equal(result.files[0].downloadUrl, file().downloadUrl); assert.equal(result.files[0].downloadable, true);
});
test('online-only list rows are reported without requesting video content or guessing a download URL', async t => {
  const html = '<table class="valuelist"><tr><td><a href="onlinepreview.jsp?countadd=1&lid=42&resid=99">在线教学视频</a></td></tr></table>';
  const win = windowFor(html); t.after(() => win.close());
  const requested = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => { requested.push(url); assert.match(url, /onlinepreview\.jsp/); return response('<p>暂不支持的在线播放器</p>', url); } }).scan({ mode: 'directory' });
  assert.equal(requested.length, 1);
  assert.equal(result.files.length, 1); assert.equal(result.files[0].downloadable, false);
  assert.match(result.files[0].unavailableReason, /未发现可保存的预览内容/);
});

test('a directory containing only folders reports the subfolder count without pretending the course is empty', async t => {
  const html = '<table class="valuelist"><tr><td><a href="listview.jsp?acttype=enter&folderid=3&lid=42">第一章</a></td></tr></table>';
  const win = windowFor(html); t.after(() => win.close());
  const result = await createCourseScanner({ window: win }).scan({ mode: 'directory' });
  assert.equal(result.files.length, 0); assert.equal(result.tree.subfolderCount, 1);
});

test('an inline iframe file cannot inherit an unrelated download anchor', async t => {
  const url = ORIGIN + '/meol/buildless/resFolderViewList.do?folderid=20&lid=42&columnId=10';
  const html = '<div id="dowload-preview">' + previewHTML(file(2), true) + '<iframe src="/meol/common/script/preview/preview.jsp?fileid=1"></iframe></div>';
  const win = windowFor(html, url); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async url => response('<p>无法预览</p>', url) }).scan({ mode: 'unit-current' });
  assert.equal(result.files[0].downloadable, false); assert.equal(result.files[0].downloadUrl, '');
});
test('metadata transport failures retain a disabled row and a specific diagnostic', async t => {
  const win = windowFor(listHTML()); t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async () => { throw new Error('offline metadata'); } }).scan({ mode: 'directory' });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].downloadable, false);
  assert.match(result.files[0].unavailableReason, /offline metadata/); assert.equal(result.failures.length, 1);
});
test('all-unit scanning discovers a directly embedded preview without fetching converted slides', async t => {
  const root = ORIGIN + '/meol/jpk/course/layout/lesson/index.jsp?courseId=42';
  const target = ORIGIN + '/meol/buildless/colUrlStuView.do?columnId=10';
  const list = ORIGIN + '/meol/buildless/resFolderViewList.do?folderid=20&lid=42&columnId=10';
  const win = windowFor('<ul>' + '<li>' + link(10, '第一单元') + '</li></ul>', root); t.after(() => win.close());
  const requests = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    requests.push(url);
    if (url.includes('course_column_preview_transfer.jsp')) return response('<iframe src="' + list + '"></iframe>', target);
    if (url.includes('/preview/preview.jsp')) return response('<p>无法加载的预览</p>', url);
    assert.equal(url, list);
    return response('<div id="dowload-preview">' + previewHTML(file(), false) + '<iframe src="/meol/common/script/preview/preview.jsp?fileid=1"></iframe></div>', list);
  } }).scan({ mode: 'unit-all' });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].downloadable, false);
  assert.equal(requests.length, 3); assert.equal(result.failures.length, 0);
  assert.ok(requests.every(url => !url.includes('/data/convert/') && !url.includes('/download.jsp')));
});
test('availability counts keep missing download links separate from request failures', () => {
  const counts = availabilityCounts([file(), file(2, { downloadable: false, unavailableCode: 'NO_DOWNLOAD_LINK' }), file(3, { downloadable: false, unavailableCode: 'HTTP_ERROR' })]);
  assert.deepEqual(counts, { total: 3, downloadable: 1, previewOnly: 1, unverified: 1, previewDownloads: 0 });
});
