import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUnitResources } from '../src/platform/unit-scan.js';
import { dom, unitEntryUrl, unitPageUrl, previewUrl } from './helpers/dom.js';

const HTML = 'text/html;charset=UTF-8';
const ORIGIN = 'https://course.buct.edu.cn';
// Canonical entry URL as normalizeUnitEntryUrl produces it (params sorted).
const entryUrl = (n) => `${ORIGIN}/meol/jpk/course/course_column_preview_transfer.jsp?columnId=${n}&tagbug=client`;
const entry = (n) => ({ columnId: String(n), entryUrl: entryUrl(n), title: `第${n}次课`, order: n - 1 });
const entries = (...ns) => ns.map(entry);
const index = (...ns) => ({ courseId: '12', entries: entries(...ns) });
const anchor = (n, title) => `<a href="${previewUrl(n)}">${title ?? `第${n}章`}</a>`;
const unitHtml = (...fileIds) => `<!doctype html><html><head><title>单元学习</title></head><body><h1>单元学习页面</h1>${fileIds.map(n => anchor(n)).join('')}</body></html>`;
const columnOf = (url) => new URL(url).searchParams.get('columnId');

const withUrl = (response, url) => {
  Object.defineProperty(response, 'url', { value: url });
  return response;
};
// A body that fails loudly if anything reads it before URL validation.
const unreadableBody = () => new ReadableStream({
  start(controller) { controller.error(new Error('body must not be read before URL validation')); },
});
const okUnit = (fileIds) => withUrl(new Response(unitHtml(...fileIds), { headers: { 'content-type': HTML } }), unitPageUrl('lesson', 12));

test('unit collector caps parallel requests at two and preserves entry order through out-of-order responses', async () => {
  let active = 0, peak = 0;
  const fetcher = async (url) => {
    active++; peak = Math.max(peak, active);
    const n = Number(columnOf(url));
    try {
      // Entry 1 resolves last; responses arrive out of order.
      await new Promise(resolve => setTimeout(resolve, n === 1 ? 60 : 5 * n));
      return okUnit([10 * n]);
    } finally { active--; }
  };
  const result = await collectUnitResources(index(1, 2, 3, 4), { fetcher, parseDocument: dom });
  assert.equal(peak, 2, 'two workers run in parallel and no more');
  assert.equal(result.entriesProcessed, 4);
  assert.equal(result.entriesTotal, 4);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.resources.map(r => r.unit.order), [0, 1, 2, 3]);
  assert.deepEqual(result.resources.map(r => r.unit.title), ['第1次课', '第2次课', '第3次课', '第4次课']);
  assert.deepEqual(result.resources.map(r => r.unit.entryUrl), [1, 2, 3, 4].map(entryUrl));
  assert.equal(result.resources[0].id, '12:78:10');
  assert.equal(result.resources[3].id, '12:78:40');
});

test('duplicate resource IDs are kept once with an incremented occurrence count', async () => {
  const fetcher = async (url) => okUnit(columnOf(url) === '1' ? [56, 57] : [56]);
  const result = await collectUnitResources(index(1, 2), { fetcher, parseDocument: dom });
  assert.equal(result.resources.length, 2);
  const duplicate = result.resources.find(r => r.id === '12:78:56');
  assert.equal(duplicate.unit.entryUrl, entryUrl(1), 'first unit wins');
  assert.equal(duplicate.unit.title, '第1次课');
  assert.equal(duplicate.unit.occurrenceCount, 2);
  assert.equal(result.resources.find(r => r.id === '12:78:57').unit.occurrenceCount, 1);
});

test('progress events report cumulative discovery and per-entry failures', async () => {
  const events = [];
  const fetcher = async (url) => {
    const n = Number(columnOf(url));
    if (n === 1) await new Promise(resolve => setTimeout(resolve, 40));
    return n === 2 ? new Response(null, { status: 500 }) : okUnit([n]);
  };
  const result = await collectUnitResources(index(1, 2, 3), { fetcher, parseDocument: dom, onProgress: e => events.push(e) });
  assert.equal(events.length, 3);
  assert.ok(events.every(e => e.kind === 'unit-progress' && e.total === 3));
  assert.deepEqual(events.map(e => e.processed), [1, 2, 3]);
  assert.deepEqual(events.map(e => e.discovered), [0, 1, 2]);
  const failed = events.find(e => e.failure);
  assert.ok(events.every(e => 'failure' in e === (e === failed)), 'only the failed entry carries a failure');
  assert.equal(failed.failure.kind, 'unit');
  assert.equal(failed.failure.columnId, '2');
  assert.equal(failed.failure.title, '第2次课');
  assert.equal(failed.failure.code, 'NO_DOWNLOAD');
  assert.equal(result.entriesProcessed, 3);
  assert.equal(result.resources.length, 2);
  assert.deepEqual(result.failures, [{
    kind: 'unit', columnId: '2', title: '第2次课', code: 'NO_DOWNLOAD',
    message: '单元页面无法访问，请确认登录状态和课程权限',
  }]);
});

test('one failed unit keeps resources from the successful units', async () => {
  const fetcher = async (url) => {
    const n = Number(columnOf(url));
    return n === 3 ? new Response(null, { status: 404 }) : okUnit([n]);
  };
  const result = await collectUnitResources(index(1, 2, 3, 4), { fetcher, parseDocument: dom });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].columnId, '3');
  assert.equal(result.failures[0].code, 'NO_DOWNLOAD');
  assert.equal(result.resources.length, 3);
  assert.ok(result.resources.every(r => r.unit.entryUrl !== entryUrl(3)));
});

const redirected = () => {
  const response = new Response(unitHtml(56), { headers: { 'content-type': HTML } });
  Object.defineProperty(response, 'redirected', { value: true });
  return response;
};
const foreignLesson = () => withUrl(
  new Response(unreadableBody(), { headers: { 'content-type': HTML } }),
  'https://evil.test/meol/jpk/course/layout/lesson/index.jsp?courseId=12',
);
const wrongCourse = () => withUrl(
  new Response(unreadableBody(), { headers: { 'content-type': HTML } }),
  unitPageUrl('lesson', 13),
);
const folderListing = () => withUrl(
  new Response(unreadableBody(), { headers: { 'content-type': HTML } }),
  `${ORIGIN}/meol/common/script/resFolderViewList.do?courseId=12`,
);
const stuckAtEntry = () => withUrl(
  new Response(unreadableBody(), { headers: { 'content-type': HTML } }),
  entryUrl(1),
);
const loginPage = () => withUrl(
  new Response('<!doctype html><title>统一身份认证登录</title><form>用户名</form>', { headers: { 'content-type': HTML } }),
  unitPageUrl('lesson', 12),
);
const badCharset = () => withUrl(
  new Response(unitHtml(56), { headers: { 'content-type': 'text/html; charset=x-not-a-real-charset' } }),
  unitPageUrl('lesson', 12),
);
// Oversized AND undecodable: the byte limit must fire before any decoder is built.
const oversized = () => withUrl(
  new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html; charset=x-not-a-real-charset' } }),
  unitPageUrl('lesson', 12),
);

const rejections = [
  ['opaque redirect', () => ({ type: 'opaqueredirect', status: 0 }), 'LOGIN_REQUIRED'],
  ['status 0', () => ({ type: 'cors', status: 0 }), 'LOGIN_REQUIRED'],
  ['redirected 200', redirected, 'LOGIN_REQUIRED'],
  ['status 401', () => new Response(null, { status: 401 }), 'LOGIN_REQUIRED'],
  ['server error', () => new Response(null, { status: 500 }), 'NO_DOWNLOAD'],
  ['cross-origin final url', foreignLesson, 'LOGIN_REQUIRED'],
  ['wrong course id', wrongCourse, 'LOGIN_REQUIRED'],
  ['folder listing url', folderListing, 'LOGIN_REQUIRED'],
  ['login page html', loginPage, 'LOGIN_REQUIRED'],
  ['unsupported charset', badCharset, 'BAD_FILE'],
  ['oversized body', oversized, 'BAD_FILE'],
  ['final url stuck at entry url', stuckAtEntry, 'INVALID_URL'],
];

for (const [name, buildResponse, code] of rejections) test(`unit page rejected: ${name}`, async () => {
  // A second, always-healthy entry keeps LOGIN_REQUIRED local instead of fatal.
  const fetcher = async (url) => columnOf(url) === '1' ? buildResponse() : okUnit([99]);
  const result = await collectUnitResources(index(1, 2), { fetcher, parseDocument: dom });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, code);
  assert.equal(result.failures[0].columnId, '1');
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].id, '12:78:99');
  assert.equal(result.entriesProcessed, 2);
  assert.ok(!JSON.stringify(result.failures).includes('evil.test'), 'no raw URL leakage');
  assert.ok(!JSON.stringify(result.failures).includes('body must not be read'), 'no raw body leakage');
});

test('oversized bodies fail on size before any charset decoding is attempted', async () => {
  const result = await collectUnitResources(index(1), { fetcher: async () => oversized(), parseDocument: dom });
  assert.equal(result.failures[0].code, 'BAD_FILE');
  assert.equal(result.failures[0].message, '单元页面内容异常，请在平台确认该单元');
});

test('fetch rejections become opaque network failures', async () => {
  const result = await collectUnitResources(index(1), {
    fetcher: async () => { throw new Error('private network detail'); },
    parseDocument: dom,
  });
  assert.equal(result.failures[0].code, 'NETWORK');
  assert.ok(!result.failures[0].message.includes('private network detail'));
});

test('timeouts on a stalled entry are recorded as unit failures', async () => {
  const result = await collectUnitResources(index(1), {
    fetcher: () => new Promise(() => {}),
    parseDocument: dom,
    timeoutMs: 20,
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'TIMEOUT');
});

test('cancellation aborts the whole collection instead of recording failures', async () => {
  const controller = new AbortController();
  const fetcher = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const promise = collectUnitResources(index(1, 2, 3), { fetcher, parseDocument: dom, signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, error => error.code === 'CANCELLED');
});

test('login failure is fatal only when every entry failed as LOGIN_REQUIRED', async () => {
  await assert.rejects(
    collectUnitResources(index(1, 2, 3), {
      fetcher: async () => ({ type: 'opaqueredirect', status: 0 }),
      parseDocument: dom,
    }),
    error => error.code === 'LOGIN_REQUIRED' && error.message === '登录已失效，请重新登录后再扫描全部单元',
  );
  // Mixed failures stay local: login-related and other failures coexist.
  const fetcher = async (url) => Number(columnOf(url)) === 1
    ? new Response(null, { status: 401 })
    : new Response(null, { status: 500 });
  const mixed = await collectUnitResources(index(1, 2), { fetcher, parseDocument: dom });
  assert.deepEqual(mixed.failures.map(f => f.code), ['LOGIN_REQUIRED', 'NO_DOWNLOAD']);
  assert.equal(mixed.entriesProcessed, 2);
});

test('unit pages decode the declared GBK charset', async () => {
  // Synthetic GBK bytes for the anchor text 第一份; no live page or account data.
  const html = Buffer.concat([
    Buffer.from('<!doctype html><title>单元学习</title>'),
    Buffer.from('<a href="' + previewUrl(56) + '">'),
    Buffer.from('b5dad2bbb7dd', 'hex'),
    Buffer.from('</a>'),
  ]);
  const fetcher = async () => withUrl(
    new Response(html, { headers: { 'content-type': 'text/html;charset=gbk' } }),
    unitPageUrl('lesson', 12),
  );
  const result = await collectUnitResources(index(1), { fetcher, parseDocument: dom });
  assert.equal(result.failures.length, 0);
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].title, '第一份');
});

test('empty unit indexes complete without network requests', async () => {
  const result = await collectUnitResources({ courseId: '12', entries: [] }, { fetcher: () => assert.fail(), parseDocument: dom });
  assert.deepEqual(result, { entriesProcessed: 0, entriesTotal: 0, resources: [], failures: [] });
});
