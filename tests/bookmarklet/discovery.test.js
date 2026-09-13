import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverDirectory } from '../../src/bookmarklet/discovery.js';
import { dom, listUrl, previewUrl, unitPageUrl } from '../helpers/dom.js';

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
const shellUrl = unitPageUrl('newpage', 12);
const courseTitle = '网络课程—电路与模拟电子技术';
const link = (n, title = `第${n}章`) => `<a href="${previewUrl(n)}">${title}</a>`;
const directoryFrame = (folderid = 34, html = link(56)) =>
  ({ url: listUrl.replace('folderid=34', `folderid=${folderid}`), html });

test('finds the one current directory inside a nested same-origin frame', () => {
  const found = discoverDirectory(page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] }));
  assert.equal(found.directory.folderId, '34');
  assert.equal(found.directory.courseId, '12');
  assert.equal(found.context.courseName, '电路与模拟电子技术');
  assert.equal(found.context.courseId, '12');
  assert.equal(found.context.surface, 'resource-directory');
  assert.deepEqual(found.context.modeOptions, ['current']);
  assert.equal(found.context.mode, 'current');
  assert.equal(found.context.url, listUrl);
  assert.equal(found.context.location, listUrl);
  assert.equal(found.context.key, found.directory.key);
  assert.deepEqual(found.context.resourceIds, found.directory.resources.map(resource => resource.id));
  assert.equal(found.directory.resources.length, 1);
});

test('the generation pins the frame document and its location', () => {
  const top = page({ url: shellUrl, title: courseTitle, children: [directoryFrame()] });
  const found = discoverDirectory(top);
  assert.equal(found.context.document, top.frames[0].document);
  assert.equal(found.context.location, top.frames[0].location.href);
});

test('a top-level resource list is already the current directory', () => {
  const found = discoverDirectory(page({ url: listUrl, title: courseTitle, html: link(56) + link(57) }));
  assert.equal(found.directory.folderId, '34');
  assert.equal(found.context.courseName, '电路与模拟电子技术');
  assert.equal(found.directory.resources.length, 2);
});

for (const [name, win] of [
  ['another site', page({ url: 'https://example.test/meol/common/script/listview.jsp?lid=12&folderid=34' })],
  ['plain http', page({ url: listUrl.replace('https:', 'http:') })],
  ['a look-alike host', page({ url: listUrl.replace('course.buct.edu.cn', 'course.buct.edu.cn.evil.test') })],
  ['credentials in the url', page({ url: listUrl.replace('https://', 'https://user:secret@') })],
  ['no window at all', undefined],
]) test(`rejects a page that is not the school platform: ${name}`, () => {
  assert.throws(() => discoverDirectory(win), code('UNSUPPORTED_PAGE'));
});

test('rejects a school frame whose top document cannot be reached', () => {
  const crossOriginTop = { location: {}, document: {} };
  block(crossOriginTop, 'location');
  const frame = { ...page({ url: listUrl, html: link(56) }), top: crossOriginTop };
  assert.throws(() => discoverDirectory(frame), code('UNSUPPORTED_PAGE'));
});

test('two resource directories are ambiguous, never guessed', () => {
  const twoChildren = page({ url: shellUrl, title: courseTitle, children: [directoryFrame(34), directoryFrame(35)] });
  assert.throws(() => discoverDirectory(twoChildren), code('AMBIGUOUS_DIRECTORY'));
  const alsoTopLevel = page({ url: listUrl, title: courseTitle, html: link(56), children: [directoryFrame(35)] });
  assert.throws(() => discoverDirectory(alsoTopLevel), code('AMBIGUOUS_DIRECTORY'));
});

test('a directory from another course is not the current one', () => {
  const other = page({ url: shellUrl, title: courseTitle, children: [{ url: listUrl.replace('lid=12', 'lid=99'), html: link(56) }] });
  assert.throws(() => discoverDirectory(other), code('NO_DIRECTORY'));
  const noCourseInShell = page({ url: 'https://course.buct.edu.cn/meol/personal.do', title: courseTitle, children: [{ url: listUrl.replace('lid=12', 'lid=99'), html: link(56) }] });
  assert.equal(discoverDirectory(noCourseInShell).directory.courseId, '99');
});

test('unreadable and foreign frames are skipped without failing the page', () => {
  const blocked = block(page(directoryFrame(35)), 'document');
  const foreign = page({ url: 'https://example.test/listview.jsp?lid=12&folderid=35', html: link(57) });
  const top = page({ url: shellUrl, title: courseTitle, children: [blocked, foreign, directoryFrame(34)] });
  assert.equal(discoverDirectory(top).directory.folderId, '34');
  const hidden = page({ url: shellUrl, title: courseTitle, children: [blocked] });
  assert.throws(() => discoverDirectory(hidden), code('NO_DIRECTORY'));
});

test('only canonical preview links become resources', () => {
  const html = `${link(56)}<a href="${previewUrl(57).replace('.jsp?', '.jsp;jsessionid=TOKEN?')}&token=secret">第二章</a>` +
    `<a href="https://course.buct.edu.cn/meol/common/script/download.jsp?fileid=58&resid=78&lid=12">直链</a>` +
    '<a href="https://example.test/meol/common/script/preview/download_preview.jsp?fileid=59&resid=78&lid=12">外部</a>';
  const found = discoverDirectory(page({ url: shellUrl, title: courseTitle, children: [{ url: listUrl, html }] }));
  assert.deepEqual(found.directory.resources.map(resource => resource.previewUrl), [previewUrl(56), previewUrl(57)]);
  assert.deepEqual(found.context.resourceIds, ['12:78:56', '12:78:57']);
});

test('a school page without a resource directory says so', () => {
  const unit = page({ url: unitPageUrl('lesson', 12), title: courseTitle, html: link(56) });
  assert.throws(() => discoverDirectory(unit), error => {
    assert.equal(error.code, 'NO_DIRECTORY');
    return /课件目录/.test(error.message);
  });
});
