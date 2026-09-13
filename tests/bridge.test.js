import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../src/background/bridge.js';
import { describeSurface } from '../src/platform/surface.js';
import { dom, listUrl, previewUrl, unitEntryUrl, unitPageUrl, file, resource } from './helpers/dom.js';

const shellUrl = unitPageUrl('newpage', 12);
const lessonUrl = unitPageUrl('lesson', 12);
const unitIndexHtml = `<ul><li><a href="${unitEntryUrl(41)}">第一单元</a></li><li><a href="${unitEntryUrl(42)}">第二单元</a></li></ul>`;
const lessonHtml = `<a href="${previewUrl(56)}">第一章</a><a href="${previewUrl(57)}">第二章</a>${unitIndexHtml}`;
const event = (scan, body) => ({ type: 'SCAN_EVENT', scanId: scan.id, event: body });

function frame(frameId, documentId, document, url, { hasFocus = false, depth = 0, title = '网络课程—电路' } = {}) {
  return { frameId, documentId, result: { url, title, surface: describeSurface(document, url), hasFocus, depth } };
}
function harness(frames, activeFrameId) {
  let state = null;
  const scanCalls = [];
  const chrome = { runtime: { id: 'extension-id' }, tabs: { get: async id => ({ id, url: frames[0].result.url }) },
    scripting: { executeScript: async options => {
      if (options.args) { scanCalls.push({ target: options.target, args: options.args }); return []; }
      return options.files ? [] : frames;
    } } };
  const bridge = createBridge(chrome, { readScan: async () => structuredClone(state), writeScan: async next => { state = structuredClone(next); } });
  const active = frames.find(item => item.frameId === activeFrameId);
  const sender = { id: 'extension-id', url: active.result.url, origin: 'https://course.buct.edu.cn',
    tab: { id: 7 }, frameId: active.frameId, documentId: active.documentId };
  return { chrome, bridge, frames, scanCalls, sender, getState: () => state };
}
const directoryHarness = () => harness([
  frame(0, 'top', dom(''), shellUrl),
  frame(3, 'doc3', dom(`<a href="${previewUrl()}">第一章</a>`), listUrl, { hasFocus: true, depth: 1, title: '资源' }),
], 3);
const unitHarness = () => harness([
  frame(0, 'shell', dom(''), shellUrl),
  frame(5, 'unit', dom(lessonHtml), lessonUrl, { hasFocus: true, depth: 1 }),
], 5);
async function finish(h, scan, ids) {
  await h.bridge.receive(event(scan, { kind: 'discovered', resources: ids.map(resource) }), h.sender);
  for (const id of ids) await h.bridge.receive(event(scan, { kind: 'progress', file: file(id) }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete', unitFailures: [], failures: [] }), h.sender);
}

test('bridge captures the actual nested frame and original course name', async () => {
  const h = directoryHarness();
  const inspected = await h.bridge.inspect(7);
  assert.equal(inspected.context.frameId, 3);
  assert.equal(inspected.context.courseName, '电路');
  assert.equal(inspected.context.surface, 'resource-directory');
  assert.deepEqual(inspected.context.modeOptions, ['current']);
  const state = await h.bridge.start(7);
  assert.equal(state.phase, 'scanning');
  assert.deepEqual(state.files, []);
});
test('bridge validates scan, sender frame/document and discovered file identity', async () => {
  const h = directoryHarness(); const state = await h.bridge.start(7);
  const progress = event(state, { kind: 'progress', file: file(), processed: 1, total: 1 });
  await assert.rejects(h.bridge.receive(progress, { ...h.sender, frameId: 4 }));
  await assert.rejects(h.bridge.receive(progress, { ...h.sender, documentId: 'other' }));
  await assert.rejects(h.bridge.receive({ ...progress, event: { kind: 'progress', file: file(99) } }, h.sender));
  await h.bridge.receive(progress, h.sender);
  await h.bridge.receive(progress, h.sender);
  assert.equal(h.getState().files.length, 1);
  assert.equal(h.getState().processed, 1);
  await h.bridge.receive(event(state, { kind: 'complete' }), h.sender);
  assert.equal(h.getState().phase, 'ready');
});
test('late scan events are ignored and stale directory cannot enqueue', async () => {
  const h = directoryHarness(); const old = await h.bridge.start(7); const current = await h.bridge.start(7);
  await h.bridge.receive(event(old, { kind: 'complete' }), h.sender);
  assert.equal(h.getState().id, current.id);
  h.frames[1].result.surface.directory.key += ',changed';
  await assert.rejects(h.bridge.assertCurrent(7, current.id), error => error.code === 'STALE_SCAN');
});
test('ambiguity and a different top-level course are rejected', async () => {
  const h = directoryHarness(); h.frames.push({ ...h.frames[1], frameId: 9, documentId: 'doc9' });
  await assert.rejects(h.bridge.inspect(7), error => error.code === 'AMBIGUOUS_DIRECTORY');
  h.frames.pop(); h.frames[0].result.url = h.frames[0].result.url.replace('courseId=12', 'courseId=99');
  await assert.rejects(h.bridge.inspect(7), error => error.code === 'NO_DIRECTORY');
});

test('a ready scan is invalidated by an actual directory change', async () => {
  const h = directoryHarness(); const scan = await h.bridge.start(7);
  await h.bridge.receive(event(scan, { kind: 'progress', file: file() }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  assert.equal((await h.bridge.assertCurrent(7, scan.id)).phase, 'ready');
  h.frames[1].result.surface.directory.key += ',different-page';
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.equal(h.getState().phase, 'idle');
});
test('a scan replaced during context inspection cannot submit an old selection', async () => {
  const h = directoryHarness(); const scan = await h.bridge.start(7);
  await h.bridge.receive(event(scan, { kind: 'progress', file: file() }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  const original = h.chrome.scripting.executeScript; let replace = true;
  h.chrome.scripting.executeScript = async options => {
    if (!options.files && !options.args && replace) { replace = false; await h.bridge.start(7); }
    return original(options);
  };
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.notEqual(h.getState().id, scan.id);
  assert.equal(h.getState().phase, 'scanning');
});

test('stale directory validation never clears a replacement scan', async () => {
  const h = directoryHarness(); const scan = await h.bridge.start(7);
  await h.bridge.receive(event(scan, { kind: 'progress', file: file() }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  const original = h.chrome.scripting.executeScript; let replace = true;
  h.chrome.scripting.executeScript = async options => {
    if (!options.files && !options.args && replace) {
      replace = false; h.frames[1].result.surface.directory.key += ',new-directory';
      await h.bridge.start(7);
    }
    return original(options);
  };
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.notEqual(h.getState().id, scan.id);
  assert.equal(h.getState().phase, 'scanning');
});
test('a changed frame invalidates a scan when document IDs are unavailable', async () => {
  const h = directoryHarness(); delete h.frames[1].documentId;
  const scan = await h.bridge.start(7);
  await h.bridge.receive(event(scan, { kind: 'progress', file: file() }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  h.frames[1].frameId = 4;
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.equal(h.getState().phase, 'idle');
});

test('tabs without URL permission are unsupported and are never injected', async () => {
  const h = directoryHarness(); let injections = 0;
  h.chrome.tabs.get = async id => ({ id });
  h.chrome.scripting.executeScript = async () => { injections++; return h.frames; };
  await assert.rejects(h.bridge.inspect(7), e => e.code === 'UNSUPPORTED_PAGE');
  assert.equal(injections, 0);
});

test('context refresh clears only stale state and lightweight polling does not inject', async () => {
  const h = directoryHarness(); const scan = await h.bridge.start(7);
  const original = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async () => { throw new Error('Unexpected injection'); };
  assert.equal((await h.bridge.getState(7, false)).scan.id, scan.id);
  h.chrome.scripting.executeScript = original;
  h.frames[1].result.surface.directory.key += ',changed';
  const changed = await h.bridge.getState(7);
  assert.equal(changed.scan.phase, 'idle');
  assert.equal(h.getState().phase, 'idle');
  const next = await h.bridge.start(7);
  h.chrome.tabs.get = async id => ({ id });
  const unsupported = await h.bridge.getState(7);
  assert.equal(unsupported.page.error.code, 'UNSUPPORTED_PAGE');
  assert.equal(unsupported.scan.phase, 'idle');
  assert.notEqual(unsupported.scan.id, next.id);
});

test('current mode scans exactly the active unit frame with the current range', async () => {
  const h = unitHarness();
  const inspected = await h.bridge.inspect(7);
  assert.equal(inspected.surface.surface, 'unit-study');
  assert.equal(inspected.context.frameId, 5);
  assert.equal(inspected.context.documentId, 'unit');
  assert.equal(inspected.context.surface, 'unit-study');
  assert.equal(inspected.context.mode, 'current');
  assert.equal(inspected.context.unitKey, lessonUrl);
  assert.equal(inspected.context.folderId, null);
  assert.equal(inspected.context.url, lessonUrl);
  assert.deepEqual(inspected.context.modeOptions, ['current', 'all']);
  assert.deepEqual(inspected.context.resourceIds, ['12:78:56', '12:78:57']);
  assert.equal(inspected.context.key, `unit-study|current|${lessonUrl}|${inspected.surface.unitIndex.key}`);
  const state = await h.bridge.start(7);
  assert.equal(state.phase, 'scanning');
  assert.equal(state.total, 2);
  assert.equal(state.context.mode, 'current');
  assert.deepEqual(h.scanCalls, [{ target: { tabId: 7, documentIds: ['unit'] }, args: [state.id, 'current'] }]);
});
test('all mode starts empty, scans the active unit frame and survives inspection polling', async () => {
  const h = unitHarness();
  const state = await h.bridge.start(7, 'all');
  assert.equal(state.context.mode, 'all');
  assert.deepEqual(state.context.resourceIds, []);
  assert.equal(state.total, 0);
  assert.deepEqual(h.scanCalls, [{ target: { tabId: 7, documentIds: ['unit'] }, args: [state.id, 'all'] }]);
  const polled = await h.bridge.getState(7);
  assert.equal(polled.scan.id, state.id);
  assert.equal(polled.scan.context.mode, 'all');
  assert.equal(polled.page.context.modeOptions.includes('all'), true);
});
test('all mode is rejected on course-resource surfaces and never starts a scan', async () => {
  const h = directoryHarness();
  await assert.rejects(h.bridge.start(7, 'all'), e => e.code === 'INVALID_MESSAGE');
  assert.equal(h.getState(), null);
  assert.deepEqual(h.scanCalls, []);
  assert.equal((await h.bridge.inspect(7, 'all')).context.mode, 'current');
});
test('only an offered all-unit range is kept; every other mode inspects as current', async () => {
  const h = unitHarness();
  assert.equal((await h.bridge.inspect(7, 'all')).context.mode, 'all');
  for (const mode of ['unknown', 'ALL', '', 7, {}, null, undefined]) {
    assert.equal((await h.bridge.inspect(7, mode)).context.mode, 'current');
  }
  const state = await h.bridge.start(7, 'unknown');
  assert.equal(state.context.mode, 'current');
  assert.deepEqual(h.scanCalls[0].args, [state.id, 'current']);
  h.frames[1].result.surface = describeSurface(dom(`<a href="${previewUrl(56)}">第一章</a>`), lessonUrl);
  assert.deepEqual(h.frames[1].result.surface.modeOptions, ['current']);
  await assert.rejects(h.bridge.start(7, 'all'), e => e.code === 'INVALID_MESSAGE');
});
test('the deepest frame resolves several candidates; focus outranks depth', async () => {
  const deep = unitHarness();
  deep.frames.forEach(item => { item.result.hasFocus = false; });
  assert.equal((await deep.bridge.inspect(7)).context.frameId, 5);
  assert.equal((await deep.bridge.inspect(7)).context.unitKey, lessonUrl);
  const focused = unitHarness();
  focused.frames[0].result.hasFocus = true;
  focused.frames[1].result.hasFocus = false;
  const shell = await focused.bridge.inspect(7);
  assert.equal(shell.context.frameId, 0);
  assert.equal(shell.context.unitKey, shellUrl);
  const tied = unitHarness();
  tied.frames.push(frame(6, 'unit2', dom(lessonHtml), lessonUrl, { hasFocus: true, depth: 1 }));
  await assert.rejects(tied.bridge.inspect(7), e => e.code === 'AMBIGUOUS_DIRECTORY');
});

test('all mode trusts only discovered IDs from the active unit frame', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7, 'all');
  const discovered = body => event(scan, { kind: 'discovered', resources: body });
  assert.equal(h.getState().total, 0);
  await assert.rejects(h.bridge.receive(discovered([{ ...resource(56), previewUrl: 'https://evil.test/meol/common/script/preview/download_preview.jsp?fileid=56&resid=78&lid=12' }]), h.sender), e => e.code === 'INVALID_MESSAGE');
  await assert.rejects(h.bridge.receive(discovered([{ ...resource(57), previewUrl: previewUrl(57).replace('lid=12', 'lid=99') }]), h.sender), e => e.code === 'INVALID_MESSAGE');
  await assert.rejects(h.bridge.receive(discovered([{ ...resource(56), id: '12:78:99' }]), h.sender), e => e.code === 'INVALID_MESSAGE');
  await assert.rejects(h.bridge.receive(discovered([resource(56)]), { ...h.sender, documentId: 'other' }));
  await assert.rejects(h.bridge.receive(discovered([resource(56)]), { ...h.sender, url: 'https://evil.test/' }));
  assert.equal(h.getState().total, 0);
  await h.bridge.receive(discovered([resource(56), resource(57)]), h.sender);
  assert.deepEqual(h.getState().context.resourceIds, ['12:78:56', '12:78:57']);
  assert.equal(h.getState().total, 2);
  await h.bridge.receive(discovered([resource(56), resource(57)]), h.sender);
  assert.deepEqual(h.getState().context.resourceIds, ['12:78:56', '12:78:57']);
  await assert.rejects(h.bridge.receive(event(scan, { kind: 'progress', file: file(99) }), h.sender), e => e.code === 'INVALID_MESSAGE');
  await h.bridge.receive(event(scan, { kind: 'progress', file: file(57) }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'progress', file: file(56) }), h.sender);
  assert.deepEqual(h.getState().files.map(item => item.id), ['12:78:56', '12:78:57']);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  assert.equal(h.getState().phase, 'ready');
});
test('unit progress stays a display counter and unit failures stay their own group', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7, 'all');
  await h.bridge.receive(event(scan, { kind: 'unit-progress', processed: 1, total: 2, discovered: 1 }), h.sender);
  assert.deepEqual(h.getState().units, { processed: 1, total: 2, discovered: 1 });
  assert.deepEqual(h.getState().context.resourceIds, []);
  await assert.rejects(h.bridge.receive(event(scan, { kind: 'discovered', resources: [resource(56)] }), { ...h.sender, frameId: 4 }));
  await h.bridge.receive(event(scan, { kind: 'unit-progress', processed: 2, total: 2, discovered: 1,
    failure: { kind: 'unit', columnId: '42', title: '第二单元', code: 'NO_DOWNLOAD', message: '单元页面无法访问' } }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'discovered', resources: [resource(56)] }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'progress', file: file(56) }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete', failures: [],
    unitFailures: [{ kind: 'unit', columnId: '42', title: '第二单元', code: 'NO_DOWNLOAD', message: '单元页面无法访问' }] }), h.sender);
  assert.deepEqual(h.getState().failures, []);
  assert.deepEqual(h.getState().unitFailures, [{ kind: 'unit', columnId: '42', title: '第二单元', code: 'NO_DOWNLOAD', message: '单元页面无法访问' }]);
  assert.equal(h.getState().phase, 'ready');
  const current = unitHarness(); const plain = await current.bridge.start(7);
  await assert.rejects(current.bridge.receive(event(plain, { kind: 'unit-progress', processed: 1, total: 2, discovered: 1 }), current.sender), e => e.code === 'INVALID_MESSAGE');
  await assert.rejects(current.bridge.receive(event(plain, { kind: 'discovered', resources: [resource(56)] }), current.sender), e => e.code === 'INVALID_MESSAGE');
});

test('a changed unit resource set invalidates a ready unit selection', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7);
  for (const id of [56, 57]) await h.bridge.receive(event(scan, { kind: 'progress', file: file(id) }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  assert.equal((await h.bridge.assertCurrent(7, scan.id)).phase, 'ready');
  h.frames[1].result.surface.unitPage.resources.push(resource(58));
  const changed = await h.bridge.getState(7);
  assert.equal(changed.scan.phase, 'idle');
  assert.equal(h.getState().phase, 'idle');
});
test('a changed unit index or unit page invalidates a ready all-mode selection', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7, 'all');
  await finish(h, scan, [56]);
  assert.equal((await h.bridge.assertCurrent(7, scan.id)).phase, 'ready');
  h.frames[1].result.surface.unitIndex.key += ',changed';
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.equal(h.getState().phase, 'idle');
  const moved = unitHarness(); const all = await moved.bridge.start(7, 'all');
  await finish(moved, all, [56]);
  moved.frames[1].result.url = shellUrl;
  moved.frames[1].result.surface = describeSurface(dom(lessonHtml), shellUrl);
  assert.equal((await moved.bridge.getState(7)).scan.phase, 'idle');
});
test('a changed document or surface invalidates a ready unit selection', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7);
  for (const id of [56, 57]) await h.bridge.receive(event(scan, { kind: 'progress', file: file(id) }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  h.frames[1].documentId = 'reloaded';
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.equal(h.getState().phase, 'idle');
  const switched = unitHarness(); const all = await switched.bridge.start(7, 'all');
  await finish(switched, all, [56]);
  switched.frames[1] = frame(5, 'unit', dom(`<a href="${previewUrl(56)}">第一章</a>`), listUrl, { hasFocus: true, depth: 1 });
  const changed = await switched.bridge.getState(7);
  assert.equal(changed.page.context.surface, 'resource-directory');
  assert.equal(changed.scan.phase, 'idle');
});
test('a unit page that no longer offers all units invalidates through the mode key', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7, 'all');
  await finish(h, scan, [56]);
  assert.equal((await h.bridge.assertCurrent(7, scan.id)).phase, 'ready');
  h.frames[1].result.surface = describeSurface(dom(`<a href="${previewUrl(56)}">第一章</a>`), lessonUrl);
  const changed = await h.bridge.getState(7);
  assert.deepEqual(changed.page.context.modeOptions, ['current']);
  assert.equal(changed.scan.phase, 'idle');
});
test('switching current and all during inspection never clears the newer scan', async () => {
  const h = unitHarness(); const scan = await h.bridge.start(7);
  for (const id of [56, 57]) await h.bridge.receive(event(scan, { kind: 'progress', file: file(id) }), h.sender);
  await h.bridge.receive(event(scan, { kind: 'complete' }), h.sender);
  const original = h.chrome.scripting.executeScript; let replace = true;
  h.chrome.scripting.executeScript = async options => {
    if (!options.files && !options.args && replace) { replace = false; await h.bridge.start(7, 'all'); }
    return original(options);
  };
  await assert.rejects(h.bridge.assertCurrent(7, scan.id), e => e.code === 'STALE_SCAN');
  assert.equal(h.getState().phase, 'scanning');
  assert.equal(h.getState().context.mode, 'all');
  assert.notEqual(h.getState().id, scan.id);

  const back = unitHarness(); const all = await back.bridge.start(7, 'all');
  await finish(back, all, [56]);
  const restore = back.chrome.scripting.executeScript; let switched = true;
  back.chrome.scripting.executeScript = async options => {
    if (!options.files && !options.args && switched) { switched = false; await back.bridge.start(7); }
    return restore(options);
  };
  await assert.rejects(back.bridge.assertCurrent(7, all.id), e => e.code === 'STALE_SCAN');
  assert.equal(back.getState().phase, 'scanning');
  assert.equal(back.getState().context.mode, 'current');
  assert.notEqual(back.getState().id, all.id);
});
