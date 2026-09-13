import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookmarkletScanner } from '../../src/bookmarklet/scanner.js';
import { dom, listUrl, previewUrl, downloadUrl, preview, unitPageUrl } from '../helpers/dom.js';

// See tests/bookmarklet/discovery.test.js: the walk only needs location,
// document, frames and top, so window graphs stay synthetic.
function page({ url, title = '', html = '', children = [] }, top) {
  const document = dom(title ? `<title>${title}</title>${html}` : html);
  const win = { document, location: { href: url }, frames: [], top: null };
  win.top = top || win;
  win.frames = children.map(child => page(child, win.top));
  return win;
}
const courseName = '电路与模拟电子技术';
const link = (n, title = `第${n}章`) => `<a href="${previewUrl(n)}">${title}</a>`;
const schoolPage = ({ folderid = 34, html, title = `网络课程—${courseName}` }) =>
  page({ url: unitPageUrl('newpage', 12), title, children: [{ url: listUrl.replace('folderid=34', `folderid=${folderid}`), html }] });
const response = (body, type = 'text/html;charset=UTF-8') => new Response(body, { headers: { 'content-type': type } });
const previewOf = fileId => response(preview(`第${fileId}章.pdf`, fileId, '1.5M'));
const flagged = (value, property, flag = true) => { Object.defineProperty(value, property, { value: flag }); return value; };
const code = expected => error => error.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('an empty directory completes without any request', async () => {
  const events = [];
  const state = await createBookmarkletScanner({ fetcher: () => assert.fail('no request'), parseDocument: dom })
    .scan(schoolPage({ html: '' }), event => events.push(event));
  assert.equal(state.phase, 'ready');
  assert.equal(state.total, 0);
  assert.equal(state.processed, 0);
  assert.equal(state.skipped, 0);
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(events.map(event => event.phase), ['scanning']);
});

test('files are reported in source order with the course name and canonical links', async () => {
  const requested = [];
  const fetcher = async (url, options) => {
    requested.push(url);
    const fileId = Number(new URL(url).searchParams.get('fileid'));
    await new Promise(resolve => setTimeout(resolve, (58 - fileId) * 3)); // 58 settles first, 56 last
    return previewOf(fileId);
  };
  const events = [];
  const sessionLink = `<a href="${previewUrl(56).replace('.jsp?', '.jsp;jsessionid=TOKEN?')}&token=secret">第56章</a>`;
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(schoolPage({ html: sessionLink + link(57) + link(58) }), event => events.push(event));
  assert.deepEqual(state.files.map(file => file.fileId), ['56', '57', '58']);
  assert.deepEqual(requested, [previewUrl(56), previewUrl(57), previewUrl(58)]);
  const [first] = state.files;
  assert.equal(first.name, '第56章.pdf');
  assert.equal(first.extension, 'pdf');
  assert.equal(first.courseName, courseName);
  assert.equal(first.sizeBytes, Math.round(1.5 * 1024 * 1024));
  assert.equal(first.sizeText, '1.5M');
  assert.equal(first.previewUrl, previewUrl(56));
  assert.equal(first.downloadUrl, downloadUrl(56));
  assert.equal(state.total, 3);
  assert.equal(state.processed, 3);
  assert.equal(state.skipped, 0);
  assert.equal(state.message, '找到 3 份课件');
  assert.deepEqual(events.map(event => event.files.map(file => file.fileId)),
    [[], ['58'], ['57', '58'], ['56', '57', '58']]);
  assert.equal(events.at(-1).message, '正在识别 3 / 3');
});

test('cancel aborts the reads in flight and resolves a cancelled snapshot', async () => {
  let aborted = 0;
  const fetcher = (url, options) => new Promise(resolve => {
    const fileId = Number(new URL(url).searchParams.get('fileid'));
    if (fileId === 56) return resolve(previewOf(fileId));
    options.signal.addEventListener('abort', () => { aborted++; resolve(previewOf(fileId)); }, { once: true });
  });
  const scanner = createBookmarkletScanner({ fetcher, parseDocument: dom });
  const pending = scanner.scan(schoolPage({ html: link(56) + link(57) + link(58) }), () => {});
  await tick();
  scanner.cancel();
  const state = await pending;
  assert.equal(state.phase, 'cancelled');
  assert.ok(aborted >= 2);
  assert.deepEqual(state.files.map(file => file.fileId), ['56']);
  assert.deepEqual(state.failures, []);
  assert.match(state.message, /取消/);
});

test('a replacement generation cancels the first and never reports its late progress', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const fetcher = async (url, options) => {
    const fileId = Number(new URL(url).searchParams.get('fileid'));
    if (fileId === 58) return previewOf(fileId);
    await held;
    if (options.signal.aborted) throw options.signal.reason;
    return previewOf(fileId);
  };
  const scanner = createBookmarkletScanner({ fetcher, parseDocument: dom });
  const firstEvents = [], secondEvents = [];
  const first = scanner.scan(schoolPage({ folderid: 34, html: link(56) + link(57) }), event => firstEvents.push(event));
  await tick();
  const second = scanner.scan(schoolPage({ folderid: 35, html: link(58) }), event => secondEvents.push(event));
  const secondState = await second;
  release();
  const firstState = await first;
  assert.notEqual(firstState.id, secondState.id);
  assert.equal(firstState.phase, 'cancelled');
  assert.equal(secondState.phase, 'ready');
  assert.deepEqual(secondState.files.map(file => file.fileId), ['58']);
  assert.equal(secondState.context.folderId, '35');
  assert.deepEqual(firstEvents.map(event => event.phase), ['scanning']);
  assert.equal(secondEvents.some(event => event.files.some(file => file.fileId !== '58')), false);
  assert.equal(secondEvents.at(-1).context.folderId, '35');
});

test('an unsupported page is rejected without cancelling the running scan', async () => {
  const scanner = createBookmarkletScanner({ fetcher: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return previewOf(56); }, parseDocument: dom });
  const pending = scanner.scan(schoolPage({ html: link(56) }), () => {});
  await assert.rejects(scanner.scan(page({ url: 'https://example.test/meol/common/script/listview.jsp?lid=12&folderid=34' })), code('UNSUPPORTED_PAGE'));
  const state = await pending;
  assert.equal(state.phase, 'ready');
  assert.deepEqual(state.files.map(file => file.fileId), ['56']);
});

test('decodes the declared GBK charset instead of corrupting the metadata', async () => {
  // Synthetic GBK bytes for 文件名:中文课件.ppt (1M); no live page or account data.
  const body = Buffer.concat([Buffer.from('<h2>'),
    Buffer.from('cec4bcfec3fb3ad6d0cec4bfcebcfe2e7070742028314d29', 'hex'),
    Buffer.from(`<a href="${downloadUrl(56)}">download</a></h2>`)]);
  const state = await createBookmarkletScanner({ fetcher: async () => response(body, 'text/html;charset=gbk'), parseDocument: dom })
    .scan(schoolPage({ html: link(56) }), () => {});
  assert.deepEqual(state.failures, []);
  assert.equal(state.files[0].name, '中文课件.ppt');
  assert.equal(state.files[0].sizeText, '1M');
  assert.equal(state.files[0].sizeBytes, 1024 * 1024);
  assert.equal(state.files[0].courseName, courseName);
});

test('unsupported formats are skipped, not failed', async () => {
  const fetcher = async url => {
    const fileId = Number(new URL(url).searchParams.get('fileid'));
    return response(preview(fileId === 57 ? '工具.exe' : `第${fileId}章.pdf`, fileId, '1M'));
  };
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(schoolPage({ html: link(56) + link(57) }), () => {});
  assert.equal(state.skipped, 1);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.files.map(file => file.fileId), ['56']);
  assert.equal(state.processed, 2);
  assert.equal(state.phase, 'ready');
  assert.equal(state.message, '找到 1 份课件');
});

for (const [name, respond, expected] of [
  ['a login redirect', () => ({ type: 'opaqueredirect', status: 0 }), 'LOGIN_REQUIRED'],
  ['an expired session', () => new Response('', { status: 401 }), 'LOGIN_REQUIRED'],
  ['a followed redirect', () => flagged(response('<h2>文件名:第56章.pdf (1M)</h2>'), 'redirected'), 'LOGIN_REQUIRED'],
  ['a refused download', () => new Response('', { status: 403 }), 'NO_DOWNLOAD'],
]) test(`reports ${name} as a failure rather than courseware`, async () => {
  const state = await createBookmarkletScanner({ fetcher: async () => respond(), parseDocument: dom })
    .scan(schoolPage({ html: link(56) }), () => {});
  assert.deepEqual(state.files, []);
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].code, expected);
  assert.equal(state.failures[0].id, '12:78:56');
  assert.equal(state.processed, 1);
});

test('only canonical preview URLs on the school host are ever fetched', async () => {
  const resources = [
    { id: '12:78:56', courseId: '12', resId: '78', fileId: '56', title: 'A', previewUrl: downloadUrl(56) },
    { id: '12:78:57', courseId: '12', resId: '78', fileId: '57', title: 'B', previewUrl: previewUrl(57).replace('https://course.buct.edu.cn', 'https://evil.test') },
    { id: '12:78:58', courseId: '12', resId: '78', fileId: '58', title: 'C', previewUrl: `${previewUrl(58)}&token=secret` },
  ];
  const directory = { courseId: '12', folderId: '34', url: listUrl, key: '12/34', resources };
  const context = { courseId: '12', folderId: '34', courseName, url: listUrl, surface: 'resource-directory',
    mode: 'current', modeOptions: ['current'], key: directory.key, resourceIds: resources.map(resource => resource.id),
    document: null, location: listUrl };
  let calls = 0;
  const state = await createBookmarkletScanner({ fetcher: async () => { calls++; }, parseDocument: dom, discover: () => ({ context, directory }) })
    .scan({}, () => {});
  assert.equal(calls, 0);
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.failures.map(failure => failure.code), ['INVALID_URL', 'INVALID_URL', 'INVALID_RESOURCE']);
  assert.equal(state.processed, 3);
  assert.equal(state.total, 3);
});
