import assert from 'node:assert/strict';
import test from 'node:test';
import { DIRECT_DOWNLOAD_CAUTION, downloadDirect } from '../../src/bookmarklet/direct-download.js';
import { AppError } from '../../src/platform/policy.js';

const DOWNLOAD = 'https://course.buct.edu.cn/meol/common/script/download.jsp';
const PREVIEW = 'https://course.buct.edu.cn/meol/common/script/preview/download_preview.jsp';
const canonical = n => `${DOWNLOAD}?fileid=${n}&resid=${n + 10}&lid=7`;

function file(n, overrides = {}) {
  return {
    id: `7:${n + 10}:${n}`, courseId: '7', resId: String(n + 10), fileId: String(n),
    previewUrl: `${PREVIEW}?fileid=${n}&resid=${n + 10}&lid=7`,
    downloadUrl: canonical(n),
    title: `章节${n}`, name: `章节${n}.pdf`, extension: 'pdf', sizeText: '1 MB', sizeBytes: 1048576,
    courseName: '电路', ...overrides,
  };
}

function fakeDocument() {
  const created = [];
  const log = [];
  const body = {
    children: [],
    append(node) { node.parent = body; body.children.push(node); log.push({ type: 'append', node }); },
    removeChild(node) { const index = body.children.indexOf(node); if (index !== -1) body.children.splice(index, 1); node.parent = null; },
  };
  const doc = {
    body,
    documentElement: body,
    createElement(tag) {
      log.push({ type: 'create', tag: String(tag).toUpperCase() });
      const node = {
        tagName: String(tag).toUpperCase(), href: '', download: '', rel: '', hidden: false,
        parent: null, clicks: 0,
        click() { node.clicks++; log.push({ type: 'click', node }); },
        remove() { if (node.parent) node.parent.removeChild(node); log.push({ type: 'remove', node }); },
      };
      created.push(node);
      return node;
    },
  };
  return { doc, created, body, log };
}

function fakeTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let next = 0;
  globalThis.setTimeout = (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => { timers.delete(id); };
  return {
    started: () => [...timers.values()].map(timer => timer.ms),
    runNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'no scheduled download delay to run');
      timers.delete(entry[0]);
      entry[1].fn();
      return entry[1].ms;
    },
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; },
  };
}

const flush = async (rounds = 25) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); };

test('validates the whole list before the first anchor click', async () => {
  const timers = fakeTimers();
  try {
    const { doc, created, log } = fakeDocument();
    const reads = [];
    const last = file(3);
    const tripwire = { ...last };
    Object.defineProperty(tripwire, 'downloadUrl', { get() { reads.push(created.length); return last.downloadUrl; } });
    const hostile = { ...file(2), downloadUrl: 'https://evil.example.com/download.jsp?fileid=2&resid=12&lid=7' };
    let result;
    const promise = downloadDirect([file(1), hostile, tripwire], { document: doc, delayMs: 10 }).then(value => { result = value; });
    await flush();
    assert.deepEqual(reads, [0], 'the last file is validated before any anchor exists');
    assert.equal(created.length, 1);
    timers.runNext();
    await flush();
    await promise;
    assert.deepEqual(result.triggered.map(t => t.id), ['7:11:1', '7:13:3']);
    assert.deepEqual(result.failed, [{ id: '7:12:2', title: '章节2', code: 'INVALID_URL', message: '只支持学校教学平台上的资源' }]);
    assert.deepEqual(created.map(anchor => anchor.href), [canonical(1), canonical(3)]);
    assert.ok(log.every(entry => entry.type !== 'create' || entry.tag === 'A'));
  } finally { timers.restore(); }
});

test('triggers one hidden same-origin anchor per file, in order, with delays', async () => {
  const timers = fakeTimers();
  try {
    const { doc, created, body, log } = fakeDocument();
    const messy = { ...file(2), downloadUrl: `${DOWNLOAD};jsessionid=DEADBEEF?fileid=2&resid=12&lid=7&extra=1` };
    let result;
    const promise = downloadDirect([file(1), messy, file(3)], { document: doc, delayMs: 250 }).then(value => { result = value; });
    await flush();
    assert.equal(created.length, 1, 'the first anchor is clicked without waiting');
    assert.deepEqual(timers.started(), [250], 'the delay separates files instead of preceding the first');
    timers.runNext();
    await flush();
    assert.equal(created.length, 2);
    assert.deepEqual(timers.started(), [250]);
    timers.runNext();
    await flush();
    await promise;
    assert.deepEqual(result.triggered.map(t => t.id), ['7:11:1', '7:12:2', '7:13:3']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(created.map(anchor => anchor.href), [canonical(1), canonical(2), canonical(3)]);
    assert.deepEqual(created.map(anchor => anchor.download), ['章节1.pdf', '章节2.pdf', '章节3.pdf']);
    for (const anchor of created) {
      assert.equal(anchor.rel, 'noopener');
      assert.equal(anchor.hidden, true);
      assert.equal(anchor.clicks, 1);
      assert.equal(anchor.parent, null);
      const events = log.filter(entry => entry.node === anchor).map(entry => entry.type);
      assert.deepEqual(events, ['append', 'click', 'remove']);
    }
    assert.equal(body.children.length, 0);
  } finally { timers.restore(); }
});

test('reports 已触发 n/m progress without claiming a finished download', async () => {
  const timers = fakeTimers();
  try {
    const { doc } = fakeDocument();
    const events = [];
    const promise = downloadDirect([file(1), file(2)], { document: doc, delayMs: 5, onProgress: event => events.push(event) });
    await flush();
    timers.runNext();
    await flush();
    const result = await promise;
    assert.deepEqual(events.map(event => event.message), ['已触发 1/2', '已触发 2/2']);
    assert.deepEqual(events.map(event => [event.kind, event.triggered, event.total, event.name]), [
      ['progress', 1, 2, '章节1.pdf'], ['progress', 2, 2, '章节2.pdf'],
    ]);
    assert.equal(result.triggered.length, 2);
    assert.equal(result.caution, DIRECT_DOWNLOAD_CAUTION);
    assert.equal(result.caution, 'Chrome 可能要求允许此网站下载多个文件；‘已触发’不代表文件已保存完成。');
    assert.equal(events.some(event => /已完成|已保存完成/.test(event.message)), false);
  } finally { timers.restore(); }
});

test('cancellation stops the sequence without further clicks', async () => {
  const timers = fakeTimers();
  try {
    const { doc, created, body } = fakeDocument();
    const controller = new AbortController();
    const failure = downloadDirect([file(1), file(2), file(3)], { document: doc, signal: controller.signal, delayMs: 500 })
      .then(() => null, error => error);
    await flush();
    assert.equal(created.length, 1);
    assert.deepEqual(timers.started(), [500]);
    controller.abort();
    await flush();
    const error = await failure;
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'CANCELLED');
    assert.equal(created.length, 1);
    assert.deepEqual(timers.started(), [], 'the pending delay is cleared');
    assert.equal(body.children.length, 0);
  } finally { timers.restore(); }
});

test('an already aborted signal creates no anchor', async () => {
  const { doc, created } = fakeDocument();
  const controller = new AbortController();
  controller.abort();
  const error = await downloadDirect([file(1)], { document: doc, signal: controller.signal })
    .then(() => null, value => value);
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'CANCELLED');
  assert.equal(created.length, 0);
});

test('an unusable selection reports failures instead of clicking anything', async () => {
  const { doc, created } = fakeDocument();
  const events = [];
  const result = await downloadDirect([
    file(1, { name: '工具.exe' }),
    { ...file(2), downloadUrl: 'http://course.buct.edu.cn/meol/common/script/download.jsp?fileid=2&resid=12&lid=7' },
  ], { document: doc, onProgress: event => events.push(event) });
  assert.deepEqual(result.triggered, []);
  assert.deepEqual(result.failed.map(entry => entry.code), ['UNSUPPORTED_TYPE', 'INVALID_URL']);
  assert.equal(result.caution, DIRECT_DOWNLOAD_CAUTION);
  assert.deepEqual(events, []);
  assert.equal(created.length, 0);
});

test('never fetches a body, opens a popup, or uses a hidden frame', async () => {
  const timers = fakeTimers();
  const realFetch = globalThis.fetch;
  const realOpen = globalThis.open;
  let fetches = 0;
  let popups = 0;
  globalThis.fetch = () => { fetches++; throw new Error('downloadDirect must not fetch'); };
  globalThis.open = () => { popups++; throw new Error('downloadDirect must not open popups'); };
  try {
    const { doc, created, log } = fakeDocument();
    const promise = downloadDirect([file(1), file(2)], { document: doc, delayMs: 50 });
    await flush();
    timers.runNext();
    await flush();
    await promise;
    assert.equal(fetches, 0);
    assert.equal(popups, 0);
    assert.deepEqual([...new Set(log.filter(entry => entry.type === 'create').map(entry => entry.tag))], ['A']);
    assert.equal(created.every(anchor => anchor.href.startsWith(DOWNLOAD)), true);
  } finally {
    timers.restore();
    globalThis.fetch = realFetch;
    if (realOpen === undefined) delete globalThis.open; else globalThis.open = realOpen;
  }
});
