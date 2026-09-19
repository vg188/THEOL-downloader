import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../src/platform/policy.js';
import { createBookmarkletController } from '../../src/bookmarklet/controller.js';
import { describePage, discoverSurface } from '../../src/bookmarklet/discovery.js';
import { bookmarkletStamp } from '../../src/bookmarklet/version.js';
import { dom, listUrl, previewUrl, unitEntryUrl, unitPageUrl } from '../helpers/dom.js';

// The bookmarklet only needs location, document, frames and top from a window.
function page({ url, title = '', html = '', children = [] }, top) {
  const document = dom(title ? `<title>${title}</title>${html}` : html);
  const win = { document, location: { href: url }, frames: [], top: null };
  win.top = top || win;
  win.frames = children.map(child => page(child, win.top));
  return win;
}
const link = (n, title = `第${n}章`) => `<a href="${previewUrl(n)}">${title}</a>`;
const shellUrl = 'https://course.buct.edu.cn/meol/personal.do?courseId=12';
const courseTitle = '网络课程—电路与模拟电子技术';
const directoryFrame = (folderid = 34) => ({ url: listUrl.replace('folderid=34', `folderid=${folderid}`), html: link(56) });
// A second directory under a *different* course: readable but out of scope.
const otherCourseUrl = 'https://course.buct.edu.cn/meol/personal.do?courseId=99';

test('a rejected page reports the real reason instead of a generic prompt', () => {
  const message = '页面有多个资源列表，请单独打开需要下载的目录';
  const controller = createBookmarkletController({
    inspect: () => { throw new AppError('AMBIGUOUS_DIRECTORY', message); },
  });
  controller.show();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.error.code, 'AMBIGUOUS_DIRECTORY');
  assert.equal(snapshot.error.message, message);
  assert.equal(snapshot.state, 'idle', 'a failed inspection is not a failed task');
});

test('every inspection failure reaches the panel, whatever its code', () => {
  for (const [code, message] of [
    ['UNSUPPORTED_PAGE', '请先打开学校教学平台的课程资源页'],
    ['NO_DIRECTORY', '请先进入“课程资源”下的课件目录或单元页面，再扫描当前列表'],
    ['AMBIGUOUS_DIRECTORY', '页面有多个资源列表，请单独打开需要下载的目录'],
  ]) {
    const controller = createBookmarkletController({ inspect: () => { throw new AppError(code, message); } });
    controller.show();
    assert.equal(controller.getSnapshot().error.code, code, `${code} is reported`);
  }
});

test('the reason clears once the page becomes usable again', () => {
  let broken = true;
  const good = { context: { key: 'ok', surface: 'resource-directory', modeOptions: ['current'], resourceIds: [] }, surface: { surface: 'resource-directory', modeOptions: ['current'] } };
  const controller = createBookmarkletController({
    inspect: () => { if (broken) throw new AppError('NO_DIRECTORY', '没有课件目录'); return good; },
  });
  controller.show();
  assert.equal(controller.getSnapshot().error.code, 'NO_DIRECTORY');
  broken = false;
  controller.show();
  assert.equal(controller.getSnapshot().error, null, 'a usable page removes the stale reason');
});

test('a repeated inspection failure is not reported twice', () => {
  let calls = 0;
  const controller = createBookmarkletController({
    inspect: () => { calls++; throw new AppError('NO_DIRECTORY', '没有课件目录'); },
  });
  controller.show(); controller.show(); controller.show();
  assert.equal(controller.getSnapshot().error.code, 'NO_DIRECTORY');
  assert.equal(calls, 3, 'every show still inspects, only the report is idempotent');
});

test('describePage counts frames and candidate kinds without exposing identities', () => {
  const report = describePage(page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] }));
  assert.equal(report.supported, true);
  assert.ok(report.frameCount >= 2, 'the course shell and its directory frame are counted');
  assert.deepEqual(report.candidates, ['resource-directory']);
  assert.equal(report.topHasCourseId, true);
  const serialised = JSON.stringify(report);
  // The diagnostics are meant to be pastable anywhere, so none of these may appear.
  assert.equal(serialised.includes('courseId=12'), false, 'no query string');
  assert.equal(serialised.includes('folderid='), false, 'no folder id');
  assert.equal(serialised.includes(courseTitle), false, 'no course title');
  assert.equal(serialised.includes('第56章'), false, 'no file name');
});

test('describePage keeps frame paths but drops every query string', () => {
  const report = describePage(page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] }));
  assert.ok(report.framePaths.includes('/meol/common/script/listview.jsp'), report.framePaths.join(' '));
  for (const path of report.framePaths) {
    assert.equal(path.includes('?'), false, `no query survives in ${path}`);
    assert.equal(path.includes('='), false, `no parameter survives in ${path}`);
  }
});

test('describePage separates "unrecognised" from "another course"', () => {
  // The course shell is readable but is not itself a list, so it counts as
  // unrecognised — that is the page telling us where the absence comes from.
  const sameCourse = describePage(page({ url: shellUrl, title: courseTitle, children: [directoryFrame(), directoryFrame(35)] }));
  assert.equal(sameCourse.rejected.otherCourse, 0);
  assert.equal(sameCourse.candidates.length, 2, 'two lists under one course stay candidates');

  const mixed = describePage(page({ url: otherCourseUrl, title: courseTitle, children: [directoryFrame()] }));
  assert.equal(mixed.rejected.otherCourse, 1, 'the frame is readable but belongs to another course');
  assert.deepEqual(mixed.candidates, []);
  assert.ok(sameCourse.rejected.otherCourse < mixed.rejected.otherCourse, 'the two repairs stay distinguishable');
});

test('describePage marks a foreign page unsupported instead of throwing', () => {
  const report = describePage(page({ url: 'https://example.test/course', html: link(56) }));
  assert.equal(report.supported, false);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.frameCount, 0);
});

// A torn-down or unexpected document can make the shared parsers throw. That is a
// broken probe, not an unsupported page, and the two must stay tellable apart.
test('a broken page probe is reported as broken, not as an unsupported page', () => {
  const win = page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] });
  win.frames[0].document = { querySelectorAll() { throw new TypeError('文档已被销毁'); } };
  const report = describePage(win);
  assert.equal(report.supported, true, 'still on the platform, just unreadable');
  assert.equal(report.error.code, 'ERROR');
  assert.match(report.error.message, /文档已被销毁/);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.frameCount, 0, 'no half-walked frame list is published');
  assert.equal(JSON.stringify(report).includes('courseId=12'), false);
});

test('describePage never disagrees with the surface resolver', () => {
  // A bounded unit index, as src/platform/unit.js needs to accept one.
  const html = `<ul><li><a href="${unitEntryUrl(41)}">第一次课</a></li><li><a href="${unitEntryUrl(42)}">第二次课</a></li></ul>`;
  const win = page({ url: unitPageUrl('newpage', 12), title: courseTitle, html });
  const report = describePage(win);
  const { surface } = discoverSurface(win);
  assert.deepEqual(report.candidates, [surface.surface], 'the diagnostics name the same surface kind');
  assert.equal(report.error, null);
});

test('describePage reports nothing readable when the top frame is foreign', () => {
  const report = describePage(page({ url: shellUrl, title: courseTitle, html: link(56) }));
  assert.equal(report.supported, true);
  assert.equal(report.candidates.length, 0, 'the top-level page is not a courseware list');
  assert.ok(report.frameCount >= 1);
});

test('diagnose carries the version, the state and a de-identified page view', () => {
  const controller = createBookmarkletController({
    inspect: () => ({ context: { key: 'k', surface: 'unit-study', modeOptions: ['current', 'all'], resourceIds: [] }, surface: { surface: 'unit-study', modeOptions: ['current', 'all'], unitIndex: { entries: [{ title: 'x' }] } } }),
    describe: () => ({ supported: true, frameCount: 3, framePaths: ['/a'], candidates: ['unit-study'], rejected: { unrecognised: 0, otherCourse: 0 }, topHasCourseId: true, error: null }),
    document: dom('<div></div>'),
  });
  controller.show();
  const report = controller.diagnose();
  assert.equal(report.version, '1.0.1');
  assert.equal(report.stamp, bookmarkletStamp());
  assert.equal(report.state, 'idle');
  assert.equal(report.surface, 'unit-study');
  assert.deepEqual(report.modes, ['current', 'all']);
  assert.equal(report.page.supported, true);
  assert.equal(report.fileCount, 0);
  assert.equal(report.selectedCount, 0);
  assert.equal(report.error, null);
});

test('diagnose survives a broken page probe', () => {
  const controller = createBookmarkletController({
    inspect: () => { throw new AppError('NO_DIRECTORY', '没有课件目录'); },
    describe: () => { throw new Error('probe exploded'); },
  });
  controller.show();
  const report = controller.diagnose();
  assert.equal(report.error.code, 'NO_DIRECTORY');
  assert.match(report.page.error, /probe exploded/, 'the failure is reported, not thrown');
});

test('diagnose works without a page probe and never contains raw ids', () => {
  const controller = createBookmarkletController({ document: dom('<div></div>') });
  const serialised = JSON.stringify(controller.diagnose());
  assert.equal(serialised.includes('12:78:'), false, 'no resource id');
  assert.match(serialised, /1\.0\.1/);
});

test('the stamp names both the release and the build', () => {
  assert.match(bookmarkletStamp(), /^v\d+\.\d+\.\d+ \(.+\)$/);
  assert.equal(bookmarkletStamp().includes('undefined'), false);
});
