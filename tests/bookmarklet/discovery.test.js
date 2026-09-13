import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverSurface } from '../../src/bookmarklet/discovery.js';
import { describeSurface } from '../../src/platform/surface.js';
import { parseUnitPageFrames } from '../../src/platform/unit.js';
import { dom, listUrl, previewUrl, unitEntryUrl, unitPageUrl } from '../helpers/dom.js';

// The bookmarklet only needs location, document, frames and top from a window,
// so synthetic window graphs keep every frame case local and deterministic —
// jsdom cannot load a child document with its own URL.
function page({ url, title = '', html = '', children = [] }, top) {
  const document = dom(title ? `<title>${title}</title>${html}` : html);
  const win = { document, location: { href: url }, frames: [], top: null };
  win.top = top || win;
  win.frames = children.map(child => page(child, win.top));
  return win;
}
const block = (win, property) => {
  Object.defineProperty(win, property, { get() { throw new Error(`cross-origin ${property}`); } });
  return win;
};
const code = value => error => error.code === value;
const ids = list => (list ?? []).map(resource => resource.id);
// A course shell that is not itself a lesson/newpage page: the resource
// directory frame below it is then the surface, not the shell.
const shellUrl = 'https://course.buct.edu.cn/meol/personal.do?courseId=12';
const courseTitle = '网络课程—电路与模拟电子技术';
const link = (n, title = `第${n}章`) => `<a href="${previewUrl(n)}">${title}</a>`;
const entry = (n, title) => `<a href="${unitEntryUrl(n)}">${title ?? `第${n}次课`}</a>`;
const unitIndexHtml = `<ul><li>${entry(41)}</li><li>${entry(42)}</li></ul>`;
const directoryFrame = (folderid = 34, html = link(56)) =>
  ({ url: listUrl.replace('folderid=34', `folderid=${folderid}`), html });

// The extension's own view of one frame, exactly as src/content.js builds it:
// parity is asserted against the production wiring, never against a copy of it.
const extensionView = win => describeSurface(win.document, win.location.href, {
  parseUnitPage: (_document, pageUrl) => parseUnitPageFrames(win, pageUrl),
});

test('the selected surface is exactly what the extension describes for the page', () => {
  const cases = [
    // [name, top window, the window the winning surface lives in]
    ['top-level resource directory',
      page({ url: listUrl, title: courseTitle, html: link(56) + link(57) }), 0],
    ['directory nested in the course shell',
      page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] }), 'frames.0'],
    ['current unit page with courseware',
      page({ url: unitPageUrl('lesson', 12), title: courseTitle, html: link(56) }), 0],
    ['unit page with a bounded unit index and no courseware',
      page({ url: unitPageUrl('newpage', 12), title: courseTitle, html: unitIndexHtml }), 0],
    ['unit page owning a nested directory frame',
      page({ url: unitPageUrl('newpage', 12), title: courseTitle, html: link(56) + unitIndexHtml, children: [directoryFrame()] }), 0],
    ['lesson layout hosting the courseware list frame',
      page({ url: unitPageUrl('lesson', 12), title: courseTitle, children: [directoryFrame()] }), 0],
  ];
  for (const [name, win, at] of cases) {
    const frame = at === 0 ? win : win.frames[0];
    const found = discoverSurface(win);
    assert.deepEqual(found.surface, extensionView(frame), `same surface for ${name}`);
    assert.equal(found.context.surface, found.surface.surface, name);
    assert.deepEqual(found.context.modeOptions, found.surface.modeOptions, name);
    assert.deepEqual(found.context.resourceIds, [...ids(found.surface.directory?.resources), ...ids(found.surface.unitPage?.resources)], name);
  }
});

test('the extension and the bookmarklet agree about the unit index and its mode options', () => {
  const win = page({ url: unitPageUrl('lesson', 12), title: courseTitle, html: link(56) + unitIndexHtml });
  const described = extensionView(win);
  const found = discoverSurface(win);
  assert.equal(described.surface, 'unit-study');
  assert.deepEqual(described.modeOptions, ['current', 'all']);
  assert.deepEqual(found.context.modeOptions, described.modeOptions);
  assert.equal(found.context.unitKey, described.unitPage.url);
  assert.deepEqual(described.unitIndex.entries.map(item => item.columnId), ['41', '42']);
  assert.equal(described.unitIndex.entries[0].entryUrl, 'https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?columnId=41&tagbug=client');
  assert.equal(found.context.key, `unit-study|${described.unitPage.url}|${described.unitIndex.key}`);
});

test('finds the one current directory inside a nested same-origin frame', () => {
  const found = discoverSurface(page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] }));
  assert.equal(found.surface.surface, 'resource-directory');
  assert.equal(found.surface.directory.folderId, '34');
  assert.equal(found.surface.directory.courseId, '12');
  assert.equal(found.context.courseName, '电路与模拟电子技术');
  assert.equal(found.context.courseId, '12');
  assert.equal(found.context.folderId, '34');
  assert.equal(found.context.surface, 'resource-directory');
  assert.deepEqual(found.context.modeOptions, ['current']);
  assert.equal(found.context.mode, 'current');
  assert.equal(found.context.unitKey, '');
  assert.equal(found.context.url, listUrl);
  assert.equal(found.context.location, listUrl);
  assert.equal(found.context.key, `resource-directory|${found.surface.directory.key}|`);
  assert.deepEqual(found.context.resourceIds, found.surface.directory.resources.map(resource => resource.id));
  assert.equal(found.surface.directory.resources.length, 1);
});

test('a unit page owns its nested directory frame instead of the frame owning the scan', () => {
  const top = page({ url: unitPageUrl('newpage', 12), title: courseTitle, html: link(56), children: [directoryFrame(34, link(57))] });
  const found = discoverSurface(top);
  assert.equal(found.surface.surface, 'unit-study');
  // The nested directory frame is a candidate too; the unit surface wins and
  // carries the union of its own and its frames' courseware.
  assert.deepEqual(ids(found.surface.unitPage.resources), ['12:78:56', '12:78:57']);
  assert.deepEqual(found.context.resourceIds, ['12:78:56', '12:78:57']);
  assert.equal(found.context.folderId, null);
});

test('the generation pins the frame document and its location', () => {
  const top = page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] });
  const found = discoverSurface(top);
  assert.equal(found.context.document, top.frames[0].document);
  assert.equal(found.context.location, top.frames[0].location.href);
});

test('a top-level resource list is already the current directory', () => {
  const found = discoverSurface(page({ url: listUrl, title: courseTitle, html: link(56) + link(57) }));
  assert.equal(found.surface.directory.folderId, '34');
  assert.equal(found.context.courseName, '电路与模拟电子技术');
  assert.equal(found.surface.directory.resources.length, 2);
});

for (const [name, win] of [
  ['another site', page({ url: 'https://example.test/meol/common/script/listview.jsp?lid=12&folderid=34' })],
  ['plain http', page({ url: listUrl.replace('https:', 'http:') })],
  ['a look-alike host', page({ url: listUrl.replace('course.buct.edu.cn', 'course.buct.edu.cn.evil.test') })],
  ['credentials in the url', page({ url: listUrl.replace('https://', 'https://user:secret@') })],
  ['no window at all', undefined],
]) test(`rejects a page that is not the school platform: ${name}`, () => {
  assert.throws(() => discoverSurface(win), code('UNSUPPORTED_PAGE'));
});

test('rejects a school frame whose top document cannot be reached', () => {
  const crossOriginTop = { location: {}, document: {} };
  block(crossOriginTop, 'location');
  const frame = { ...page({ url: listUrl, html: link(56) }), top: crossOriginTop };
  assert.throws(() => discoverSurface(frame), code('UNSUPPORTED_PAGE'));
});

test('two surfaces of the winning kind are ambiguous, never guessed', () => {
  const twoChildren = page({ url: shellUrl, title: courseTitle, children: [directoryFrame(34), directoryFrame(35)] });
  assert.throws(() => discoverSurface(twoChildren), code('AMBIGUOUS_DIRECTORY'));
  const alsoTopLevel = page({ url: listUrl, title: courseTitle, html: link(56), children: [directoryFrame(35)] });
  assert.throws(() => discoverSurface(alsoTopLevel), code('AMBIGUOUS_DIRECTORY'));
  const twoUnits = page({ url: unitPageUrl('lesson', 12), title: courseTitle, html: link(56), children: [
    { url: unitPageUrl('newpage', 12), html: link(57) },
  ] });
  assert.throws(() => discoverSurface(twoUnits), code('AMBIGUOUS_DIRECTORY'));
});

test('a surface from another course is not the current one', () => {
  const other = page({ url: shellUrl, title: courseTitle, children: [{ url: listUrl.replace('lid=12', 'lid=99'), html: link(56) }] });
  assert.throws(() => discoverSurface(other), code('NO_DIRECTORY'));
  const unitElsewhere = page({ url: shellUrl, title: courseTitle, children: [
    { url: unitPageUrl('lesson', 13), html: unitIndexHtml },
  ] });
  assert.throws(() => discoverSurface(unitElsewhere), code('NO_DIRECTORY'));
  const noCourseInShell = page({ url: 'https://course.buct.edu.cn/meol/personal.do', title: courseTitle, children: [{ url: listUrl.replace('lid=12', 'lid=99'), html: link(56) }] });
  assert.equal(discoverSurface(noCourseInShell).surface.directory.courseId, '99');
});

test('unreadable and foreign frames are skipped without failing the page', () => {
  const blocked = block(page(directoryFrame(35)), 'document');
  const foreign = page({ url: 'https://example.test/listview.jsp?lid=12&folderid=35', html: link(57) });
  const top = page({ url: shellUrl, title: courseTitle, children: [blocked, foreign, directoryFrame(34)] });
  assert.equal(discoverSurface(top).surface.directory.folderId, '34');
  const hidden = page({ url: shellUrl, title: courseTitle, children: [blocked] });
  assert.throws(() => discoverSurface(hidden), code('NO_DIRECTORY'));
});

test('only canonical preview links become resources', () => {
  const html = `${link(56)}<a href="${previewUrl(57).replace('.jsp?', '.jsp;jsessionid=TOKEN?')}&token=secret">第二章</a>` +
    `<a href="https://course.buct.edu.cn/meol/common/script/download.jsp?fileid=58&resid=78&lid=12">直链</a>` +
    '<a href="https://example.test/meol/common/script/preview/download_preview.jsp?fileid=59&resid=78&lid=12">外部</a>';
  const found = discoverSurface(page({ url: shellUrl, title: courseTitle, children: [{ url: listUrl, html }] }));
  assert.deepEqual(found.surface.directory.resources.map(resource => resource.previewUrl), [previewUrl(56), previewUrl(57)]);
  assert.deepEqual(found.context.resourceIds, ['12:78:56', '12:78:57']);
});

test('a school page without a directory or unit page says so', () => {
  const welcome = page({ url: 'https://course.buct.edu.cn/meol/jpk/course/welcome.jsp', title: courseTitle, html: link(56) });
  assert.throws(() => discoverSurface(welcome), error => {
    assert.equal(error.code, 'NO_DIRECTORY');
    return /课件目录/.test(error.message);
  });
  // A lesson shell renders its courseware in a nested frame; the shell alone is
  // not a surface and must not steal the scan from that frame.
  const shellOnly = page({ url: unitPageUrl('lesson', 12), title: courseTitle, html: '<nav>课程</nav>' });
  assert.throws(() => discoverSurface(shellOnly), code('NO_DIRECTORY'));
});
