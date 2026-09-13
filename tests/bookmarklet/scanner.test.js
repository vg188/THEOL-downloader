import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookmarkletScanner } from '../../src/bookmarklet/scanner.js';
import { dom, listUrl, previewUrl, downloadUrl, preview, unitEntryUrl, unitPageUrl } from '../helpers/dom.js';

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
const title = `网络课程—${courseName}`;
const link = (n, label = `第${n}章`) => `<a href="${previewUrl(n)}">${label}</a>`;
// A course-resource directory is a listview page; a unit page is a lesson or
// newpage page whose courseware may come from a nested frame.
const directory = ({ folderid = 34, html = '', name = title } = {}) =>
  page({ url: listUrl.replace('folderid=34', `folderid=${folderid}`), title: name, html });
const unitPage = ({ layout = 'lesson', html = '', name = title, children = [], courseId = 12 } = {}) =>
  page({ url: unitPageUrl(layout, courseId), title: name, html, children });
const response = (body, type = 'text/html;charset=UTF-8') => new Response(body, { headers: { 'content-type': type } });
const previewOf = fileId => response(preview(`第${fileId}章.pdf`, fileId, '1.5M'));
const flagged = (value, property, flag = true) => { Object.defineProperty(value, property, { value: flag }); return value; };
const withUrl = (value, url) => { Object.defineProperty(value, 'url', { value: url }); return value; };
const code = expected => error => error.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));
const isUnitEntry = url => url.includes('course_column_preview_transfer.jsp');
const isPreview = url => url.includes('download_preview.jsp');

// The unit index a unit page renders: two or more entry links in one list, which
// is what makes the `all` range available.
const entryAnchor = (n, label) => `<a href="${unitEntryUrl(n)}">${label ?? `第${n}次课`}</a>`;
// The canonical entry URL the platform parser normalizes any entry link to.
const canonicalEntry = n => `https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?columnId=${n}&tagbug=client`;
const unitIndexHtml = (...ns) => `<ul>${ns.map(n => `<li>${entryAnchor(n)}</li>`).join('')}</ul>`;
const unitHtml = (...fileIds) => `<!doctype html><title>单元学习</title><body>${fileIds.map(n => `<a href="${previewUrl(n)}">第${n}章</a>`).join('')}</body>`;
const unitEntryResponse = (...fileIds) => withUrl(response(unitHtml(...fileIds)), unitPageUrl('lesson', 12));

test('an empty directory completes without any request', async () => {
  const events = [];
  const state = await createBookmarkletScanner({ fetcher: () => assert.fail('no request'), parseDocument: dom })
    .scan(directory({ html: '' }), event => events.push(event));
  assert.equal(state.phase, 'ready');
  assert.equal(state.context.surface, 'resource-directory');
  assert.equal(state.total, 0);
  assert.equal(state.processed, 0);
  assert.equal(state.skipped, 0);
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.unitFailures, []);
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
    .scan(directory({ html: sessionLink + link(57) + link(58) }), event => events.push(event));
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

test('an omitted options argument still means the current range', async () => {
  const requested = [];
  const state = await createBookmarkletScanner({
    fetcher: async url => { requested.push(url); return previewOf(56); },
    parseDocument: dom,
  }).scan(unitPage({ html: link(56) + unitIndexHtml(41, 42) }), () => {});
  assert.equal(state.context.surface, 'unit-study');
  assert.equal(state.context.mode, 'current');
  assert.deepEqual(requested, [previewUrl(56)], 'current mode reads no unit entry page');
  assert.deepEqual(state.files.map(file => file.fileId), ['56']);
});

test('cancel aborts the reads in flight and resolves a cancelled snapshot', async () => {
  let aborted = 0;
  const fetcher = (url, options) => new Promise(resolve => {
    const fileId = Number(new URL(url).searchParams.get('fileid'));
    if (fileId === 56) return resolve(previewOf(fileId));
    options.signal.addEventListener('abort', () => { aborted++; resolve(previewOf(fileId)); }, { once: true });
  });
  const scanner = createBookmarkletScanner({ fetcher, parseDocument: dom });
  const pending = scanner.scan(directory({ html: link(56) + link(57) + link(58) }), () => {});
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
  const first = scanner.scan(directory({ folderid: 34, html: link(56) + link(57) }), event => firstEvents.push(event));
  await tick();
  const second = scanner.scan(unitPage({ layout: 'newpage', html: link(58) }), event => secondEvents.push(event));
  const secondState = await second;
  release();
  const firstState = await first;
  assert.notEqual(firstState.id, secondState.id);
  assert.equal(firstState.phase, 'cancelled');
  assert.equal(secondState.phase, 'ready');
  assert.deepEqual(secondState.files.map(file => file.fileId), ['58']);
  assert.equal(secondState.context.surface, 'unit-study');
  assert.deepEqual(firstEvents.map(event => event.phase), ['scanning']);
  assert.equal(secondEvents.some(event => event.files.some(file => file.fileId !== '58')), false);
  assert.equal(secondEvents.at(-1).context.surface, 'unit-study');
});

test('an unsupported page is rejected without cancelling the running scan', async () => {
  const scanner = createBookmarkletScanner({ fetcher: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return previewOf(56); }, parseDocument: dom });
  const pending = scanner.scan(directory({ html: link(56) }), () => {});
  await assert.rejects(scanner.scan(page({ url: 'https://example.test/meol/common/script/listview.jsp?lid=12&folderid=34' })), code('UNSUPPORTED_PAGE'));
  const state = await pending;
  assert.equal(state.phase, 'ready');
  assert.deepEqual(state.files.map(file => file.fileId), ['56']);
});

test('all mode without a bounded unit index is rejected before any request', async () => {
  const scanner = createBookmarkletScanner({ fetcher: () => assert.fail('no request'), parseDocument: dom });
  await assert.rejects(scanner.scan(unitPage({ html: link(56) }), { mode: 'all' }), code('INVALID_MESSAGE'));
});

test('all mode reads unit pages two at a time, in entry order, and dedupes courseware', async () => {
  let unitInFlight = 0, maxUnitInFlight = 0, previewInFlight = 0, maxPreviewInFlight = 0;
  const requested = [];
  const fetcher = async url => {
    requested.push(url);
    const unitEntry = isUnitEntry(url);
    if (unitEntry) { unitInFlight++; maxUnitInFlight = Math.max(maxUnitInFlight, unitInFlight); }
    else { previewInFlight++; maxPreviewInFlight = Math.max(maxPreviewInFlight, previewInFlight); }
    try {
      if (unitEntry) {
        const columnId = Number(new URL(url).searchParams.get('columnId'));
        await new Promise(resolve => setTimeout(resolve, (46 - columnId) * 2));
        // Units 42 and 44 hold the same courseware: it must be read once.
        return unitEntryResponse(columnId === 44 ? 42 : columnId);
      }
      await new Promise(resolve => setTimeout(resolve, 1));
      return previewOf(Number(new URL(url).searchParams.get('fileid')));
    } finally {
      if (unitEntry) unitInFlight--; else previewInFlight--;
    }
  };
  const events = [];
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(unitPage({ html: unitIndexHtml(41, 42, 43, 44) }), { mode: 'all' }, event => events.push(event));

  assert.equal(maxUnitInFlight, 2, 'the unit stage is two wide');
  assert.equal(maxPreviewInFlight, 3, 'the metadata stage is three wide');
  assert.deepEqual(requested.filter(isUnitEntry).map(url => new URL(url).searchParams.get('columnId')),
    ['41', '42', '43', '44'], 'entries are read once each, in entry order');
  assert.equal(requested.filter(isPreview).length, 3, 'duplicate courseware is read once');
  assert.deepEqual(state.files.map(file => file.fileId), ['41', '42', '43'], 'files keep entry order');
  assert.equal(state.total, 3);
  assert.equal(state.processed, 3);
  assert.equal(state.skipped, 0);
  assert.deepEqual(state.unitFailures, []);
  assert.deepEqual(state.units, { processed: 4, total: 4, discovered: 4 });
  assert.deepEqual(state.context.resourceIds, ['12:78:41', '12:78:42', '12:78:43']);
  assert.equal(state.context.mode, 'all');
  assert.equal(state.phase, 'ready');
  assert.equal(state.message, '找到 3 份课件');
});

test('all mode emits unit progress, then one discovered batch per unit, then metadata progress', async () => {
  const fetcher = async url => {
    if (!isUnitEntry(url)) return previewOf(Number(new URL(url).searchParams.get('fileid')));
    const columnId = Number(new URL(url).searchParams.get('columnId'));
    await new Promise(resolve => setTimeout(resolve, (columnId - 40) * 2));
    return unitEntryResponse(columnId);
  };
  const events = [];
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(unitPage({ html: unitIndexHtml(41, 42) }), { mode: 'all' }, event => events.push(event));

  const kinds = events.map(event => event.kind ?? 'state');
  assert.deepEqual(kinds.slice(0, 3), ['state', 'unit-progress', 'unit-progress']);
  assert.deepEqual(events.filter(event => event.kind === 'unit-progress').map(event => [event.processed, event.total, event.discovered]),
    [[1, 2, 1], [2, 2, 2]]);
  const discovered = events.filter(event => event.kind === 'discovered');
  assert.deepEqual(discovered.map(event => event.order), [0, 1], 'one batch per settled unit, in unit order');
  assert.deepEqual(discovered.map(event => event.resources.map(resource => resource.id)), [['12:78:41'], ['12:78:42']]);
  assert.deepEqual(discovered.map(event => event.resources.map(resource => resource.unit.occurrenceCount)), [[1], [1]]);
  assert.ok(events.indexOf(discovered.at(-1)) < events.findIndex(event => /正在识别/.test(event.message ?? '')), 'metadata progress starts after the units settle');
  assert.equal(state.units.discovered, 2);
});

test('a duplicate courseware is read once and its repeat is kept as an occurrence count', async () => {
  const requested = [];
  const fetcher = async url => { requested.push(url); return isUnitEntry(url) ? unitEntryResponse(56) : previewOf(56); };
  const events = [];
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(unitPage({ html: unitIndexHtml(41, 42) }), { mode: 'all' }, event => events.push(event));
  assert.equal(requested.filter(isPreview).length, 1, 'the repeated courseware is fetched once');
  assert.equal(state.total, 1);
  assert.deepEqual(state.files.map(file => file.fileId), ['56']);
  assert.deepEqual(state.context.resourceIds, ['12:78:56']);
  assert.equal(state.units.discovered, 2, 'both unit pages reported the courseware');
  // Deduplication keeps the first unit's copy and only counts the repeat, so it
  // is described by the unit that introduced it.
  const batches = events.filter(event => event.kind === 'discovered');
  assert.deepEqual(batches.map(batch => batch.order), [0]);
  assert.deepEqual(batches[0].resources.map(resource => resource.id), ['12:78:56']);
  assert.deepEqual(batches[0].resources[0].unit, { entryUrl: canonicalEntry(41), title: '第41次课', order: 0, occurrenceCount: 2 });
});

test('a failed unit is reported apart from the file failures and the rest still scans', async () => {
  const fetcher = async url => {
    if (isUnitEntry(url)) {
      return Number(new URL(url).searchParams.get('columnId')) === 41
        ? new Response('', { status: 403 })
        : unitEntryResponse(42);
    }
    return previewOf(Number(new URL(url).searchParams.get('fileid')));
  };
  const events = [];
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(unitPage({ html: unitIndexHtml(41, 42) }), { mode: 'all' }, event => events.push(event));
  assert.equal(state.phase, 'ready');
  assert.deepEqual(state.unitFailures.map(failure => [failure.kind, failure.columnId, failure.code]), [['unit', '41', 'NO_DOWNLOAD']]);
  assert.deepEqual(state.failures, [], 'a unit failure is never a file failure');
  assert.deepEqual(state.files.map(file => file.fileId), ['42']);
  const progress = events.filter(event => event.kind === 'unit-progress');
  assert.equal(progress[0].failure.code, 'NO_DOWNLOAD', 'the failed unit is visible while it happens');
});

test('all mode never requests a download endpoint while scanning', async () => {
  const requested = [];
  const fetcher = async url => {
    requested.push(url);
    return isUnitEntry(url) ? unitEntryResponse(Number(new URL(url).searchParams.get('columnId'))) : previewOf(Number(new URL(url).searchParams.get('fileid')));
  };
  const state = await createBookmarkletScanner({ fetcher, parseDocument: dom })
    .scan(unitPage({ html: unitIndexHtml(41, 42) }), { mode: 'all' }, () => {});
  assert.ok(requested.length > 0);
  assert.deepEqual(requested.filter(url => !isUnitEntry(url) && !isPreview(url)), []);
  assert.equal(requested.some(url => url.includes('download.jsp')), false);
  assert.equal(state.files.every(file => file.downloadUrl.includes('download.jsp')), true, 'download links only come from parsed metadata');
});

test('cancel during the unit stage aborts collection and reads no metadata', async () => {
  const requested = [];
  const fetcher = (url, options) => new Promise(resolve => {
    requested.push(url);
    options.signal.addEventListener('abort', () => resolve(unitEntryResponse(41)), { once: true });
  });
  const scanner = createBookmarkletScanner({ fetcher, parseDocument: dom });
  const pending = scanner.scan(unitPage({ html: unitIndexHtml(41, 42) }), { mode: 'all' }, () => {});
  await tick();
  scanner.cancel();
  const state = await pending;
  assert.equal(state.phase, 'cancelled');
  assert.equal(requested.filter(isPreview).length, 0, 'the metadata stage never starts');
  assert.match(state.message, /取消/);
});

test('replacing an all-unit scan aborts both stages and drops the first generation', async () => {
  const fetcher = (url, options) => new Promise(resolve => {
    const unitEntry = isUnitEntry(url);
    if (!unitEntry) return resolve(previewOf(Number(new URL(url).searchParams.get('fileid'))));
    options.signal.addEventListener('abort', () => resolve(unitEntryResponse(41)), { once: true });
  });
  const scanner = createBookmarkletScanner({ fetcher, parseDocument: dom });
  const firstEvents = [];
  const first = scanner.scan(unitPage({ html: unitIndexHtml(41, 42) }), { mode: 'all' }, event => firstEvents.push(event));
  await tick();
  const second = scanner.scan(directory({ folderid: 35, html: link(58) }), () => {});
  const secondState = await second;
  const firstState = await first;
  assert.equal(firstState.phase, 'cancelled');
  assert.deepEqual(firstEvents.map(event => event.kind ?? 'state'), ['state'], 'late unit progress from the replaced generation is dropped');
  assert.equal(secondState.phase, 'ready');
  assert.equal(secondState.context.folderId, '35');
  assert.deepEqual(secondState.files.map(file => file.fileId), ['58']);
});

test('decodes the declared GBK charset instead of corrupting the metadata', async () => {
  // Synthetic GBK bytes for 文件名:中文课件.ppt (1M); no live page or account data.
  const body = Buffer.concat([Buffer.from('<h2>'),
    Buffer.from('cec4bcfec3fb3ad6d0cec4bfcebcfe2e7070742028314d29', 'hex'),
    Buffer.from(`<a href="${downloadUrl(56)}">download</a></h2>`)]);
  const state = await createBookmarkletScanner({ fetcher: async () => response(body, 'text/html;charset=gbk'), parseDocument: dom })
    .scan(directory({ html: link(56) }), () => {});
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
    .scan(directory({ html: link(56) + link(57) }), () => {});
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
    .scan(directory({ html: link(56) }), () => {});
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
  const directorySurface = { courseId: '12', folderId: '34', url: listUrl, key: '12/34', resources };
  const surface = { surface: 'resource-directory', modeOptions: ['current'], directory: directorySurface, unitPage: null, unitIndex: null };
  const context = { courseId: '12', folderId: '34', courseName, url: listUrl, surface: 'resource-directory',
    mode: 'current', unitKey: '', modeOptions: ['current'], key: `resource-directory|${directorySurface.key}|`,
    resourceIds: resources.map(resource => resource.id), document: null, location: listUrl };
  let calls = 0;
  const state = await createBookmarkletScanner({ fetcher: async () => { calls++; }, parseDocument: dom, discover: () => ({ context, surface }) })
    .scan({}, () => {});
  assert.equal(calls, 0);
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.failures.map(failure => failure.code), ['INVALID_URL', 'INVALID_URL', 'INVALID_RESOURCE']);
  assert.equal(state.processed, 3);
  assert.equal(state.total, 3);
});
