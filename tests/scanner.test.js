import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { scanResources } from '../src/platform/scan.js';
import { collectUnitResources } from '../src/platform/unit-scan.js';
import { describeSurface } from '../src/platform/surface.js';
import { AppError, errorResult } from '../src/platform/policy.js';
import { dom, preview, resource, previewUrl, listUrl, unitEntryUrl, unitPageUrl } from './helpers/dom.js';

const response = (html) => new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
test('scanner caps parallel requests and isolates unsupported, network and timeout failures', async () => {
  let active = 0, peak = 0;
  const events = [];
  const fetcher = async (url, options) => {
    active++; peak = Math.max(peak, active);
    const n = new URL(url).searchParams.get('fileid');
    try {
      if (n === '6') await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      await new Promise(resolve => setTimeout(resolve, 2));
      if (n === '5') throw new Error('private network detail');
      return response(preview(n === '4' ? '工具.exe' : `章节${n}.pdf`, n));
    } finally { active--; }
  };
  const result = await scanResources([1,2,3,4,5,6].map(resource), { fetcher, parseDocument: dom, onProgress: e => events.push(e), timeoutMs: 80 });
  assert.ok(peak <= 3);
  assert.equal(result.files.length, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures.length, 2);
  assert.equal(result.processed, 6);
  assert.equal(events.length, 6);
  assert.ok(result.failures.some(f => f.code === 'TIMEOUT'));
  assert.ok(result.failures.every(f => !f.message.includes('private network detail')));
});
test('redirects and wrong response types are not scanned as courseware', async () => {
  const result = await scanResources([resource()], { fetcher: async () => ({type:'opaqueredirect', status:0}), parseDocument: dom });
  assert.equal(result.failures[0].code, 'LOGIN_REQUIRED');
  const binary = await scanResources([resource()], { fetcher: async () => new Response('bytes', {headers:{'content-type':'application/pdf'}}), parseDocument: dom });
  assert.equal(binary.files.length, 0);
});
test('timeout covers a stalled response body, not just response headers', async () => {
  const result = await scanResources([resource()], { fetcher: async () => new Response(new ReadableStream({}), {headers:{'content-type':'text/html'}}), parseDocument: dom, timeoutMs:10 });
  assert.equal(result.failures[0].code, 'TIMEOUT');
});
test('empty directories complete without network requests', async () => {
  const result = await scanResources([], { fetcher: () => assert.fail(), parseDocument: dom });
  assert.equal(result.processed, 0);
});


for (const type of ['text/html;charset=gbk', 'text/html; charset="GB2312"']) test('scanner decodes the declared Chinese charset: ' + type, async () => {
  // Synthetic GBK bytes for 文件名:中文课件.ppt (1M); no live page or account data.
  const html=Buffer.concat([Buffer.from('<h2>'),Buffer.from('cec4bcfec3fb3ad6d0cec4bfcebcfe2e7070742028314d29','hex'),Buffer.from('<a href="https://course.buct.edu.cn/meol/common/script/download.jsp?fileid=56&resid=78&lid=12">download</a></h2>')]);
  const result=await scanResources([resource()],{fetcher:async()=>new Response(html,{headers:{'content-type':type}}),parseDocument:dom});
  assert.equal(result.failures.length,0);
  assert.equal(result.files[0].name,'中文课件.ppt');
  assert.equal(result.files[0].sizeText,'1M');
});
test('an unknown declared charset is reported without silently corrupting metadata', async () => {
  const result=await scanResources([resource()],{fetcher:async()=>new Response(preview(),{headers:{'content-type':'text/html; charset=x-not-a-real-charset'}}),parseDocument:dom});
  assert.equal(result.files.length,0);
  assert.equal(result.failures[0].code,'BAD_FILE');
});

// ---------------------------------------------------------------------------
// Surface recognition (Task 4)
// ---------------------------------------------------------------------------

const entryAnchor = (n, title) => `<a href="${unitEntryUrl(n)}">${title ?? `第${n}次`}</a>`;
const unitIndexHtml = `
  <ul>
    <li>${entryAnchor(41)}</li>
    <li>${entryAnchor(42)}</li>
  </ul>`;

test('surface: listview page is a current-only resource directory', () => {
  const document = dom(`<a href="${previewUrl(56)}">第一章</a><a href="${previewUrl(57)}">第二章</a>`);
  const surface = describeSurface(document, listUrl);
  assert.equal(surface.surface, 'resource-directory');
  assert.deepEqual(surface.modeOptions, ['current']);
  assert.deepEqual(surface.directory.resources.map(item => item.id), ['12:78:56', '12:78:57']);
});

for (const layout of ['lesson', 'newpage']) test(`surface: ${layout} unit page with previews is unit-study`, () => {
  const withIndex = describeSurface(dom(`<a href="${previewUrl(56)}">第一章</a>${unitIndexHtml}`), unitPageUrl(layout));
  assert.equal(withIndex.surface, 'unit-study');
  assert.deepEqual(withIndex.modeOptions, ['current', 'all']);
  assert.equal(withIndex.unitPage.layout, layout);
  assert.deepEqual(withIndex.unitPage.resources.map(item => item.id), ['12:78:56']);
  assert.equal(withIndex.unitIndex.entries.length, 2);

  const withoutIndex = describeSurface(dom(`<a href="${previewUrl(56)}">第一章</a>`), unitPageUrl(layout));
  assert.equal(withoutIndex.surface, 'unit-study');
  assert.deepEqual(withoutIndex.modeOptions, ['current']);
  assert.equal(withoutIndex.unitIndex, null);
});

test('surface: unit page with zero previews still supports all when an index exists', () => {
  const surface = describeSurface(dom(unitIndexHtml), unitPageUrl());
  assert.equal(surface.surface, 'unit-study');
  assert.deepEqual(surface.modeOptions, ['current', 'all']);
  assert.deepEqual(surface.unitPage.resources, []);
  assert.equal(surface.unitIndex.entries.length, 2);
});

test('surface: ordinary course shell is unrecognized', () => {
  const document = dom(`<a href="${previewUrl(56)}">第一章</a>${unitIndexHtml}`);
  assert.equal(describeSurface(document, 'https://course.buct.edu.cn/meol/jpk/course/welcome.jsp'), null);
  assert.equal(describeSurface(document, 'https://course.buct.edu.cn/'), null);
});

test('surface: a document matching both shapes is ambiguous, never prioritized', () => {
  // The production URL allowlists (listview vs lesson/newpage) are disjoint,
  // so both parsers can never succeed on one real page URL; the guard is
  // verified through injected parsers to pin the no-silent-priority contract.
  const document = dom(`<a href="${previewUrl(56)}">第一章</a>`);
  assert.throws(
    () => describeSurface(document, listUrl, {
      parseDirectory: () => ({ resources: [], key: '12/34|' }),
      parseUnitPage: () => ({ surface: 'unit-study', resources: [] }),
    }),
    error => error.code === 'AMBIGUOUS_DIRECTORY'
  );
});

test('surface: an ambiguous unit index only drops the all mode', () => {
  const document = dom(`<a href="${previewUrl(56)}">第一章</a>${unitIndexHtml}<ul><li>${entryAnchor(43)}</li><li>${entryAnchor(44)}</li></ul>`);
  const surface = describeSurface(document, unitPageUrl());
  assert.equal(surface.surface, 'unit-study');
  assert.deepEqual(surface.modeOptions, ['current']);
  assert.equal(surface.unitIndex, null);
});

// ---------------------------------------------------------------------------
// Content-script API (Task 4)
// ---------------------------------------------------------------------------

// Loads src/content.js with browser globals (document, location, chrome,
// DOMParser) supplied by the test. Import lines are stripped and the
// already-imported platform modules are injected as function parameters.
// scanResources/collectUnitResources fall back to the ambient fetch, so the
// ambient global is stubbed to keep every request inside the synthetic fetcher.
const loadContentApi = async ({ url, document: pageDocument, fetcher }) => {
  const sent = [];
  const requestedUrls = [];
  const chrome = {
    runtime: {
      id: 'extension-id',
      sendMessage: message => { sent.push(message); return Promise.resolve(); },
    },
  };
  const location = { href: url };
  const globalScope = {};
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(String(input));
    return fetcher(String(input), init);
  };
  const DOMParser = class { parseFromString(html) { return dom(html); } };
  const source = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
  const factory = new Function(
    'scanResources', 'collectUnitResources', 'describeSurface', 'AppError', 'errorResult',
    'document', 'location', 'chrome', 'DOMParser', 'globalThis',
    source.replace(/^import[^\n]*$/gm, '') + '\nreturn globalThis.__BUCT_COURSE_V1__;'
  );
  const api = factory(scanResources, collectUnitResources, describeSurface, AppError, errorResult,
    pageDocument, location, chrome, DOMParser, globalScope);
  return { api, sent, requestedUrls };
};

const unitPageHtml = (fileIds) => `<!doctype html><title>单元学习</title><body>${fileIds.map(n => `<a href="${previewUrl(n)}">第${n}章</a>`).join('')}</body>`;
const htmlResponse = (html) => new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
const withUrl = (response, url) => { Object.defineProperty(response, 'url', { value: url }); return response; };
const isUnitEntry = (url) => url.includes('course_column_preview_transfer.jsp');
const isPreview = (url) => url.includes('download_preview.jsp');
const columnOf = (url) => new URL(url).searchParams.get('columnId');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('content api: describe reports surface and preserves directory for resource frames', async () => {
  const { api } = await loadContentApi({
    url: listUrl,
    document: dom(`<title>资源</title><a href="${previewUrl(56)}">第一章</a>`),
  });
  const described = api.describe();
  assert.equal(described.url, listUrl);
  assert.equal(described.title, '资源');
  assert.equal(described.surface.surface, 'resource-directory');
  assert.deepEqual(described.surface.modeOptions, ['current']);
  assert.equal(described.surface.directory.resources.length, 1);
});

test('content api: current mode performs zero unit-entry fetches and emits metadata progress', async () => {
  const { api, sent, requestedUrls } = await loadContentApi({
    url: unitPageUrl('lesson'),
    document: dom(`<a href="${previewUrl(56)}">第一章</a><a href="${previewUrl(57)}">第二章</a>${unitIndexHtml}`),
    fetcher: async (url) => {
      assert.ok(!isUnitEntry(url), 'current mode must not fetch unit entry URLs');
      const n = new URL(url).searchParams.get('fileid');
      return withUrl(htmlResponse(preview(`第${n}章.PPT`, n)), url);
    },
  });
  await api.scan('scan-1');
  assert.deepEqual(requestedUrls, [previewUrl(56), previewUrl(57)]);
  const events = sent.map(message => message.event);
  assert.ok(events.every(event => event.stage === 'metadata' || event.kind === 'complete'));
  assert.equal(events.filter(event => event.kind === 'progress').length, 2);
  assert.equal(events[events.length - 1].kind, 'complete');
  assert.deepEqual(events[events.length - 1].unitFailures, []);
});

test('content api: all mode orders unit progress, discovered batches, then metadata progress', async () => {
  const { api, sent, requestedUrls } = await loadContentApi({
    url: unitPageUrl('lesson'),
    document: dom(unitIndexHtml),
    fetcher: async (url) => {
      if (isUnitEntry(url)) {
        const n = columnOf(url);
        return withUrl(htmlResponse(unitPageHtml(n === '41' ? [56, 57] : [57, 58])), unitPageUrl('lesson'));
      }
      const n = new URL(url).searchParams.get('fileid');
      return withUrl(htmlResponse(preview(`第${n}章.PPT`, n)), url);
    },
  });
  await api.scan('scan-2', { mode: 'all' });
  assert.equal(requestedUrls.filter(isUnitEntry).length, 2, 'both unit entries are read');
  assert.ok(requestedUrls.every(url => !url.includes('download.jsp')), 'all mode never requests download.jsp');
  const events = sent.map(message => message.event);
  const kinds = events.map(event => event.kind);
  assert.equal(kinds.filter(kind => kind === 'unit-progress').length, 2);
  assert.ok(events.filter(event => event.kind === 'unit-progress').every(event => event.stage === 'units'));
  assert.equal(kinds.filter(kind => kind === 'discovered').length, 2);
  assert.equal(kinds[kinds.length - 1], 'complete');
  // unit-progress* -> discovered* -> metadata progress*.
  const lastUnitProgress = kinds.lastIndexOf('unit-progress');
  const firstDiscovered = kinds.indexOf('discovered');
  const lastDiscovered = kinds.lastIndexOf('discovered');
  const firstMetadataProgress = kinds.findIndex(kind => kind === 'progress');
  assert.ok(lastUnitProgress !== -1 && firstDiscovered !== -1 && firstMetadataProgress !== -1);
  assert.ok(lastUnitProgress < firstDiscovered, 'all unit-progress events precede the first discovered batch');
  assert.ok(lastDiscovered < firstMetadataProgress, 'discovered batches precede metadata progress');
  // Discovered batches group descriptors per unit in unit order; the duplicate
  // belongs to its first unit, so the second batch carries only its own finds.
  const discovered = events.filter(event => event.kind === 'discovered').map(event => event.resources);
  assert.deepEqual(discovered.map(batch => batch.map(item => item.id)), [['12:78:56', '12:78:57'], ['12:78:58']]);
  assert.ok(discovered.every(batch => batch.every(item => item.previewUrl && item.unit)));
  // The metadata stage scans unique resources only, in discovery order.
  assert.deepEqual(requestedUrls.filter(isPreview), [previewUrl(56), previewUrl(57), previewUrl(58)]);
  const complete = events[events.length - 1];
  assert.deepEqual(complete.unitFailures, []);
  assert.deepEqual(complete.failures, []);
});

test('content api: all mode reports a failed unit without losing successful metadata results', async () => {
  const { api, sent } = await loadContentApi({
    url: unitPageUrl('lesson'),
    document: dom(`<a href="${previewUrl(56)}">第一章</a>${unitIndexHtml}`),
    fetcher: async (url) => {
      if (isUnitEntry(url)) {
        return columnOf(url) === '41'
          ? withUrl(htmlResponse(unitPageHtml([56])), unitPageUrl('lesson'))
          : new Response(null, { status: 500 });
      }
      const n = new URL(url).searchParams.get('fileid');
      return withUrl(htmlResponse(preview(`第${n}章.PPT`, n)), url);
    },
  });
  await api.scan('scan-3', { mode: 'all' });
  const events = sent.map(message => message.event);
  const complete = events[events.length - 1];
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.unitFailures.length, 1);
  assert.equal(complete.unitFailures[0].kind, 'unit');
  assert.equal(complete.unitFailures[0].columnId, '42');
  assert.deepEqual(complete.failures, []);
  assert.equal(events.filter(event => event.kind === 'progress' && event.file).length, 1);
});

test('content api: default mode keeps the single-argument contract', async () => {
  const { api, sent } = await loadContentApi({
    url: listUrl,
    document: dom(`<a href="${previewUrl(56)}">第一章</a>`),
    fetcher: async (url) => withUrl(htmlResponse(preview('第一章.PPT', 56)), url),
  });
  await api.scan('scan-4');
  const events = sent.map(message => message.event);
  assert.deepEqual(events.map(event => event.kind), ['progress', 'complete']);
  assert.equal(events[0].stage, 'metadata');
  assert.equal(sent[0].type, 'SCAN_EVENT');
  assert.equal(sent[0].scanId, 'scan-4');
});

test('content api: unknown mode is rejected before any request and keeps prior scans running', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { api, sent, requestedUrls } = await loadContentApi({
    url: unitPageUrl('lesson'),
    document: dom(`<a href="${previewUrl(56)}">第一章</a>`),
    fetcher: async (url) => {
      await gate;
      return withUrl(htmlResponse(preview('第一章.PPT', 56)), url);
    },
  });
  const running = api.scan('scan-5');
  await tick();
  const requestsBefore = requestedUrls.length;
  await assert.rejects(api.scan('scan-6', { mode: 'everything' }), error => error.code === 'INVALID_MESSAGE');
  assert.equal(requestedUrls.length, requestsBefore, 'the rejected scan issued no requests');
  release();
  await running;
  assert.ok(sent.some(message => message.scanId === 'scan-5' && message.event.kind === 'complete'),
    'the in-flight scan is not aborted by an invalid replacement');
  assert.ok(!sent.some(message => message.scanId === 'scan-6'), 'the rejected scan emits nothing');
});

test('content api: cancel and replacement abort both scan stages', async () => {
  const entryCalls = new Map();
  let metadataCalls = 0;
  const hanging = (options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const { api, sent } = await loadContentApi({
    url: unitPageUrl('lesson'),
    document: dom(unitIndexHtml),
    fetcher: (url, options) => {
      if (isUnitEntry(url)) {
        const n = columnOf(url);
        const count = (entryCalls.get(n) ?? 0) + 1;
        entryCalls.set(n, count);
        // First generation hangs on the unit stage; later generations resolve.
        return count === 1 ? hanging(options)
          : withUrl(htmlResponse(unitPageHtml([56])), unitPageUrl('lesson'));
      }
      metadataCalls++;
      // First metadata request hangs; the replacement's request resolves.
      return metadataCalls === 1 ? hanging(options)
        : withUrl(htmlResponse(preview('第一章.PPT', 56)), url);
    },
  });
  // Cancel aborts the unit stage.
  const cancelled = api.scan('scan-7', { mode: 'all' });
  await tick();
  api.cancel();
  await cancelled;
  let fatal = sent.filter(message => message.scanId === 'scan-7' && message.event.kind === 'fatal').pop();
  assert.equal(fatal.event.error.code, 'CANCELLED');
  // A replacement scan aborts the previous generation's metadata stage.
  const replaced = api.scan('scan-8', { mode: 'all' });
  await tick();
  await tick();
  const replacement = api.scan('scan-9', { mode: 'all' });
  await replaced;
  fatal = sent.filter(message => message.scanId === 'scan-8' && message.event.kind === 'fatal').pop();
  assert.equal(fatal.event.error.code, 'CANCELLED', 'replacement aborted the metadata stage');
  // The newest generation is untouched and completes end to end.
  await replacement;
  assert.ok(sent.some(message => message.scanId === 'scan-9' && message.event.kind === 'complete'));
  assert.ok(!sent.some(message => ['scan-7', 'scan-8'].includes(message.scanId) && message.event.kind === 'complete'));
});
