import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookmarkletController } from '../../src/bookmarklet/controller.js';
import { DIRECT_DOWNLOAD_CAUTION, downloadDirect } from '../../src/bookmarklet/direct-download.js';
import { ActualSizeLimitError } from '../../src/bookmarklet/fetch-file.js';
import { AppError } from '../../src/platform/policy.js';

const MiB = 1024 * 1024;
const LIMIT = 500 * MiB;

const file = (n, sizeBytes = MiB) => ({
  id: `12:78:${n}`, courseId: '12', resId: '78', fileId: String(n),
  name: `第${n}章.pdf`, extension: 'pdf', sizeBytes, sizeText: '1M', title: `第${n}章`,
  previewUrl: `https://course.buct.edu.cn/meol/common/script/preview/download_preview.jsp?fileid=${n}&resid=78&lid=12`,
  downloadUrl: `https://course.buct.edu.cn/meol/common/script/download.jsp?fileid=${n}&resid=78&lid=12`,
  courseName: '电路与模拟电子技术',
});

const scanPayload = (files, extra = {}) => ({
  id: 'scan-1', phase: 'complete', context: { courseName: '电路与模拟电子技术' }, files,
  failures: [], total: files.length, processed: files.length, skipped: 0, message: '', ...extra,
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const files = options.files ?? [file(1)];
  const calls = { scan: [], archive: [], direct: [], deliver: [], cancelScan: 0 };
  const deps = {
    scan: options.scan ?? (async request => { calls.scan.push(request); return scanPayload(files, options.scanExtra); }),
    cancelScan: () => { calls.cancelScan++; },
    document: options.document,
    archiveFiles: options.archiveFiles ?? (async (selected, request) => {
      calls.archive.push({ selected, request });
      return { blob: { type: 'application/zip' }, name: '课件.zip', bytes: 42, entries: selected.length, failures: [] };
    }),
    downloadDirect: options.downloadDirect ?? (async (selected, request) => {
      calls.direct.push({ selected, request });
      return { triggered: selected.map(item => ({ id: item.id, name: item.name })), failed: [], caution: '已触发不代表文件已保存完成。' };
    }),
  };
  if (options.inspect) deps.inspect = options.inspect;
  if (options.deliverArchive) deps.deliverArchive = async value => { calls.deliver.push(value); };
  const controller = createBookmarkletController(deps);
  return { controller, calls, files, deps };
}

// A page contract shaped exactly like discoverSurface's: the controller is
// driven through the same fields production uses, never a second convention.
const UNIT_PAGE_URL = 'https://course.buct.edu.cn/meol/jpk/course/layout/lesson/index.jsp?courseId=12';
const DIRECTORY_URL = 'https://course.buct.edu.cn/meol/common/script/listview.jsp?lid=12&folderid=34';
const entryUrl = n => `https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?columnId=${n}&tagbug=client`;
const documents = new Map();
const pageDocument = name => {
  if (!documents.has(name)) documents.set(name, { title: name });
  return documents.get(name);
};
function inspection({ surface = 'unit-study', entries = 2, name = 'page' } = {}) {
  const modes = surface === 'unit-study' && entries > 0 ? ['current', 'all'] : ['current'];
  const unitPage = { courseId: '12', layout: 'lesson', url: UNIT_PAGE_URL, resources: [] };
  const directory = surface === 'resource-directory'
    ? { courseId: '12', folderId: '34', url: DIRECTORY_URL, key: '12/34|', resources: [] } : null;
  const unitIndex = modes.includes('all') ? {
    courseId: '12', entries: Array.from({ length: entries }, (_, index) => ({
      columnId: String(41 + index), entryUrl: entryUrl(41 + index), title: `第${41 + index}次课`, order: index,
    })), key: `12|${entries}`,
  } : null;
  return {
    context: { courseId: '12', folderId: directory?.folderId ?? null, courseName: '电路与模拟电子技术',
      url: directory?.url ?? unitPage.url, surface, mode: 'current', unitKey: surface === 'unit-study' ? unitPage.url : '',
      modeOptions: modes, key: `${surface}|${directory?.key || unitPage.url}|${unitIndex?.key || ''}`,
      resourceIds: [], document: pageDocument(name), location: directory?.url ?? unitPage.url },
    surface: { surface, modeOptions: modes, directory, unitPage: surface === 'unit-study' ? unitPage : null, unitIndex },
  };
}


const selectAll = (controller, files) => { for (const item of files) controller.toggle(item.id, true); };

test('a fresh controller starts idle with nothing selected', () => {
  const { controller, calls } = harness();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.visible, false);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.fileCount, 0);
  assert.equal(snapshot.confirmation, null);
  assert.deepEqual(snapshot.summary.mode, 'blocked');
  assert.equal(calls.scan.length, 0, 'no scan starts on its own');
  assert.equal(controller.confirm(), snapshot, 'confirm does nothing before a selection exists');
});

test('a selection at or under the limit confirms a ZIP with exact data and no side effect', async () => {
  const { controller, calls, files } = harness({ files: [file(1, MiB), file(2, 2 * MiB)] });
  await controller.scan();
  const ready = controller.getSnapshot();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.courseName, '电路与模拟电子技术');
  assert.deepEqual(ready.selectedIds, []);
  selectAll(controller, files);
  const confirming = controller.requestDownload();
  assert.equal(confirming.state, 'confirm-zip');
  assert.deepEqual(confirming.confirmation, {
    mode: 'zip', reason: null, fileCount: 2, knownTotalBytes: 3 * MiB, unknownCount: 0,
    limitBytes: LIMIT, knownTotalText: '3.0 MB', limitText: '500.0 MB',
  });
  assert.deepEqual(confirming.selectedIds, ['12:78:1', '12:78:2']);
  assert.equal(calls.archive.length, 0);
  assert.equal(calls.direct.length, 0);
});

test('exactly 500 MiB stays in ZIP while one byte over confirms direct downloads', async () => {
  const within = harness({ files: [file(1, LIMIT)] });
  await within.controller.scan();
  within.controller.toggle('12:78:1', true);
  assert.equal(within.controller.requestDownload().state, 'confirm-zip');

  const over = harness({ files: [file(1, LIMIT + 1)] });
  await over.controller.scan();
  over.controller.toggle('12:78:1', true);
  const confirming = over.controller.requestDownload();
  assert.equal(confirming.state, 'confirm-direct');
  assert.equal(confirming.confirmation.mode, 'direct');
  assert.equal(confirming.confirmation.reason, 'OVER_LIMIT');
  assert.equal(confirming.confirmation.fileCount, 1);
  assert.equal(over.calls.direct.length, 0, 'the first click only opens the confirmation');
});

test('unknown sizes confirm direct downloads and an empty selection is refused', async () => {
  const unknown = harness({ files: [file(1, null)] });
  await unknown.controller.scan();
  unknown.controller.toggle('12:78:1', true);
  const confirming = unknown.controller.requestDownload();
  assert.equal(confirming.state, 'confirm-direct');
  assert.equal(confirming.confirmation.reason, 'UNKNOWN_SIZE');
  assert.equal(confirming.confirmation.unknownCount, 1);
  assert.equal(unknown.calls.direct.length, 0);

  const empty = harness({ files: [file(1, MiB)] });
  await empty.controller.scan();
  const refused = empty.controller.requestDownload();
  assert.equal(refused.state, 'ready');
  assert.match(refused.notice, /请先选择/);
  assert.equal(empty.calls.archive.length, 0);
  assert.equal(empty.calls.direct.length, 0);
});

test('confirm packages the exact selection once even when clicked twice', async () => {
  const archive = deferred();
  const { controller, calls, files } = harness({
    files: [file(1, 3 * MiB)],
    archiveFiles: (selected, request) => { calls.archive.push({ selected, request }); return archive.promise; },
  });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  const pending = controller.confirm();
  assert.equal(controller.getSnapshot().state, 'archiving');
  controller.confirm();
  controller.confirm();
  assert.equal(calls.archive.length, 1, 'double click must not start a second archive');
  assert.equal(calls.archive[0].selected[0], files[0]);
  assert.equal(typeof calls.archive[0].request.onProgress, 'function');
  assert.equal(calls.archive[0].request.signal.aborted, false);
  archive.resolve({ blob: { type: 'application/zip' }, name: '课件.zip', bytes: 99, entries: 1, failures: [{ name: 'x.pdf', reason: '失败' }] });
  await pending;
  const done = controller.getSnapshot();
  assert.equal(done.state, 'done');
  assert.equal(done.result.mode, 'zip');
  assert.equal(done.result.blob.type, 'application/zip');
  assert.equal(done.result.entries, 1);
  assert.equal(done.result.failures.length, 1);
  assert.equal(calls.direct.length, 0);
  assert.equal(calls.deliver.length, 0, 'without a delivery hook the caller reads result.blob');
});

test('an optional delivery hook receives the archive result exactly once', async () => {
  const { controller, calls, files } = harness({ files: [file(1, MiB)], deliverArchive: () => {} });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  await controller.confirm();
  assert.equal(calls.deliver.length, 1);
  assert.equal(calls.deliver[0].name, '课件.zip');
  assert.equal(controller.getSnapshot().state, 'done');
});

test('confirm-direct triggers serial downloads exactly once and never archives', async () => {
  const { controller, calls, files } = harness({
    files: [file(1, LIMIT + 1)],
    downloadDirect: async (selected, request) => {
      calls.direct.push({ selected, request });
      request.onProgress({ kind: 'progress', triggered: 1, total: 1, message: '已触发 1/1' });
      return {
        triggered: [{ id: selected[0].id, name: selected[0].name }],
        failed: [{ id: selected[0].id, title: selected[0].title, code: 'NO_DOWNLOAD', message: '被浏览器拦截' }],
        caution: '已触发不代表文件已保存完成。',
      };
    },
  });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  const pending = controller.confirm();
  assert.equal(controller.getSnapshot().state, 'direct-downloading');
  controller.confirm();
  await pending;
  assert.equal(calls.direct.length, 1);
  assert.equal(calls.direct[0].selected[0], files[0]);
  assert.ok(calls.direct[0].request.signal instanceof AbortSignal);
  assert.equal(calls.archive.length, 0);
  const done = controller.getSnapshot();
  assert.equal(done.state, 'done');
  assert.equal(done.result.mode, 'direct');
  assert.equal(done.result.triggeredCount, 1);
  assert.equal(done.result.triggered[0].name, files[0].name);
  assert.equal(done.result.failedCount, 1);
  assert.match(done.result.caution, /已触发不代表文件已保存完成/);
  assert.equal(done.result.fileCount, 1);
});

test('an actual-size breach returns to confirmation with zero direct downloads', async () => {
  const byName = Object.assign(new Error('实际大小超过 500 MB'), { name: 'ActualSizeLimitError' });
  const byCode = new AppError('ACTUAL_SIZE_LIMIT', '实际大小超过 500 MB');
  for (const breach of [new ActualSizeLimitError(), byName, byCode]) {
    const { controller, calls, files } = harness({
      files: [file(1, 500 * MiB)],
      archiveFiles: async () => { throw breach; },
    });
    await controller.scan();
    controller.toggle(files[0].id, true);
    controller.requestDownload();
    await controller.confirm();
    const overflow = controller.getSnapshot();
    assert.equal(overflow.state, 'actual-size-overflow');
    assert.equal(overflow.confirmation.mode, 'direct');
    assert.equal(overflow.confirmation.reason, 'ACTUAL_SIZE_LIMIT');
    assert.equal(overflow.confirmation.fileCount, 1);
    assert.deepEqual(overflow.selectedIds, ['12:78:1'], 'the selection survives so the user can confirm direct mode');
    assert.equal(overflow.result, null);
    assert.equal(calls.direct.length, 0, 'overflow never starts direct downloads by itself');
    assert.equal(controller.requestDownload().state, 'actual-size-overflow', 'overflow ignores requestDownload');

    const pending = controller.confirm();
    assert.equal(controller.getSnapshot().state, 'direct-downloading');
    assert.equal(calls.direct.length, 1, 'only a fresh confirm starts direct downloads');
    await pending;
    assert.equal(controller.getSnapshot().state, 'done');
  }
});

test('cancel during archiving aborts the task and ignores its late result', async () => {
  const archive = deferred();
  const { controller, calls, files } = harness({
    files: [file(1, MiB)],
    archiveFiles: (selected, request) => { calls.archive.push({ selected, request }); return archive.promise; },
  });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  const pending = controller.confirm();
  const signal = calls.archive[0].request.signal;
  const cancelled = controller.cancel();
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(signal.aborted, true, 'cancelling aborts the running archive');
  assert.equal(cancelled.progress, null);
  archive.resolve({ blob: {}, name: 'late.zip', bytes: 1, entries: 1, failures: [] });
  await pending;
  assert.equal(controller.getSnapshot().state, 'cancelled', 'a late archive result cannot resurrect the task');
  assert.equal(calls.direct.length, 0);
});

test('cancel during scanning aborts the scan and ignores a late result', async () => {
  const scan = deferred();
  let request;
  const { controller, calls } = harness({
    scan: received => { request = received; calls.scan.push(received); return scan.promise; },
  });
  const pending = controller.scan();
  assert.equal(controller.getSnapshot().state, 'scanning');
  controller.cancel();
  assert.equal(request.signal.aborted, true);
  assert.equal(calls.cancelScan, 1);
  scan.resolve(scanPayload([file(7)]));
  await pending;
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, 'cancelled');
  assert.equal(snapshot.fileCount, 0);
  assert.equal(snapshot.files.length, 0);
});

test('cancel during direct download aborts the task and ignores a late result', async () => {
  const direct = deferred();
  const { controller, calls, files } = harness({
    files: [file(1, LIMIT + 1)],
    downloadDirect: (selected, request) => { calls.direct.push({ selected, request }); return direct.promise; },
  });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  const pending = controller.confirm();
  const signal = calls.direct[0].request.signal;
  assert.equal(controller.cancel().state, 'cancelled');
  assert.equal(signal.aborted, true);
  direct.resolve({ triggered: 1, failed: [] });
  await pending;
  assert.equal(controller.getSnapshot().state, 'cancelled');
});

test('cancel on a confirmation returns to ready without invoking any dependency', async () => {
  const { controller, calls, files } = harness({ files: [file(1, LIMIT + 1)] });
  await controller.scan();
  controller.toggle(files[0].id, true);
  assert.equal(controller.requestDownload().state, 'confirm-direct');
  const ready = controller.cancel();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.confirmation, null);
  assert.equal(calls.archive.length, 0);
  assert.equal(calls.direct.length, 0);
});

test('hide only hides the panel and never cancels active work', async () => {
  const archive = deferred();
  const { controller, calls, files } = harness({
    files: [file(1, MiB)],
    archiveFiles: (selected, request) => { calls.archive.push({ selected, request }); return archive.promise; },
  });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  const pending = controller.confirm();
  assert.equal(controller.show().visible, true);
  const hidden = controller.hide();
  assert.equal(hidden.visible, false);
  assert.equal(hidden.state, 'archiving');
  assert.equal(calls.archive[0].request.signal.aborted, false);
  archive.resolve({ blob: {}, name: '课件.zip', bytes: 1, entries: 1, failures: [] });
  await pending;
  assert.equal(controller.getSnapshot().state, 'done');
  assert.equal(controller.getSnapshot().visible, false);
  assert.equal(controller.show().visible, true);
});

test('a new scan drops the previous selection and unknown ids cannot be selected', async () => {
  const files = [file(1, MiB)];
  const { controller } = harness({ files });
  await controller.scan();
  controller.toggle('12:78:1', true);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['12:78:1']);
  controller.toggle('12:78:999', true);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['12:78:1'], 'an unknown file id is never selected');
  files.splice(0, files.length, file(2, MiB));
  await controller.scan();
  const rescanned = controller.getSnapshot();
  assert.deepEqual(rescanned.selectedIds, []);
  assert.equal(rescanned.fileCount, 1);
  assert.equal(rescanned.state, 'ready');
});

test('changing the selection invalidates a pending confirmation', async () => {
  const { controller, calls, files } = harness({ files: [file(1, MiB), file(2, MiB)] });
  await controller.scan();
  selectAll(controller, files);
  assert.equal(controller.requestDownload().state, 'confirm-zip');
  const ready = controller.toggle('12:78:2', false);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.confirmation, null);
  assert.equal(ready.summary.knownTotalBytes, MiB);
  await controller.confirm();
  assert.equal(calls.archive.length, 0, 'a stale confirmation cannot start an archive');
});

test('scan and download failures surface as explicit error states', async () => {
  const failing = harness({ scan: async () => { throw new AppError('LOGIN_REQUIRED', '登录已失效或页面发生跳转，请重新登录后扫描'); } });
  const failed = await failing.controller.scan();
  assert.equal(failed.state, 'error');
  assert.deepEqual(failed.error, { code: 'LOGIN_REQUIRED', message: '登录已失效或页面发生跳转，请重新登录后扫描' });
  assert.equal(failed.files.length, 0);

  const unconfigured = createBookmarkletController({});
  assert.equal((await unconfigured.scan()).error.code, 'NOT_CONFIGURED');

  const noFiles = harness({ archiveFiles: async () => { throw new AppError('NO_FILES', '所有文件都下载失败，未生成压缩包'); } });
  await noFiles.controller.scan();
  noFiles.controller.toggle('12:78:1', true);
  noFiles.controller.requestDownload();
  const errored = await noFiles.controller.confirm();
  assert.equal(errored.state, 'error');
  assert.equal(errored.error.code, 'NO_FILES');
  assert.equal(noFiles.calls.direct.length, 0);

  const direct = harness({ files: [file(1, LIMIT + 1)], downloadDirect: async () => { throw new AppError('NO_DOWNLOAD', '下载被拒绝'); } });
  await direct.controller.scan();
  direct.controller.toggle('12:78:1', true);
  direct.controller.requestDownload();
  const blocked = await direct.controller.confirm();
  assert.equal(blocked.state, 'error');
  assert.deepEqual(blocked.error, { code: 'NO_DOWNLOAD', message: '下载被拒绝' });
  assert.equal(direct.calls.archive.length, 0);

  const opaque = harness({ scan: async () => { throw new Error('private detail'); } });
  const hidden = await opaque.controller.scan();
  assert.equal(hidden.state, 'error');
  assert.equal(hidden.error.code, 'NETWORK');
  assert.equal(hidden.error.message, '操作未完成，请检查网络或重新登录后重试');
});

test('progress from scanning, archiving, and direct downloads reaches the panel', async () => {
  const files = [file(1, MiB), file(2, LIMIT + 1)];
  const { controller } = harness({
    files,
    scan: async ({ onProgress }) => {
      onProgress({ kind: 'progress', processed: 1, total: 2 });
      onProgress({ kind: 'progress', processed: 2, total: 2 });
      return scanPayload(files);
    },
    archiveFiles: async (selected, request) => {
      request.onProgress({ processed: 1, total: 2, name: selected[0].name, message: `正在打包 1/2：${selected[0].name}` });
      return { blob: {}, name: '课件.zip', bytes: 2, entries: 2, failures: [] };
    },
    downloadDirect: async (selected, request) => {
      request.onProgress({ triggered: 1, total: selected.length, message: `已触发 1/${selected.length}` });
      return { triggered: selected.length, failed: [] };
    },
  });
  const seen = [];
  controller.subscribe(snapshot => seen.push(snapshot));
  await controller.scan();
  const scanning = seen.filter(snapshot => snapshot.state === 'scanning');
  assert.deepEqual(scanning.map(snapshot => snapshot.progress.processed), [0, 1, 2]);
  assert.equal(scanning.at(-1).progress.total, 2);

  controller.toggle(files[0].id, true);
  controller.requestDownload();
  await controller.confirm();
  const archiving = seen.filter(snapshot => snapshot.state === 'archiving' && snapshot.progress.processed === 1);
  assert.equal(archiving.length, 1);
  assert.equal(archiving[0].progress.message, '正在打包 1/2：第1章.pdf');
  assert.equal(archiving[0].progress.name, '第1章.pdf');
  assert.equal(controller.getSnapshot().result.mode, 'zip');

  controller.toggle(files[0].id, false);
  controller.toggle(files[1].id, true);
  controller.requestDownload();
  await controller.confirm();
  const downloading = seen.filter(snapshot => snapshot.state === 'direct-downloading' && snapshot.progress.processed === 1);
  assert.equal(downloading.length, 1);
  assert.equal(downloading[0].progress.message, '已触发 1/1');
  assert.equal(controller.getSnapshot().result.mode, 'direct');
});

test('only one task runs at a time', async () => {
  const archive = deferred();
  const { controller, calls, files } = harness({
    files: [file(1, MiB)],
    archiveFiles: (selected, request) => { calls.archive.push({ selected, request }); return archive.promise; },
  });
  await controller.scan();
  controller.toggle(files[0].id, true);
  controller.requestDownload();
  const pending = controller.confirm();
  const rescanned = await controller.scan();
  assert.equal(rescanned.state, 'archiving');
  assert.equal(calls.scan.length, 1, 'a busy controller never starts a second scan');
  assert.match(rescanned.notice, /请先取消/);
  assert.equal(controller.requestDownload().state, 'archiving');
  assert.equal(controller.cancel().state, 'cancelled');
  archive.resolve({ blob: {}, name: '课件.zip', bytes: 1, entries: 1, failures: [] });
  await pending;
  assert.equal(controller.getSnapshot().state, 'cancelled');
});

test('snapshots are immutable, shared until a change, and delivered to subscribers', async () => {
  const { controller, files } = harness({ files: [file(1, MiB)] });
  const seen = [];
  const unsubscribe = controller.subscribe(snapshot => seen.push(snapshot));
  await controller.scan();
  assert.deepEqual(seen.slice(0, 2).map(snapshot => snapshot.state), ['scanning', 'ready']);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot, controller.getSnapshot(), 'an unchanged controller reuses its snapshot');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.files), true);
  assert.equal(Object.isFrozen(snapshot.selectedIds), true);
  assert.equal(Object.isFrozen(snapshot.summary), true);
  assert.throws(() => { snapshot.state = 'hacked'; }, TypeError);
  controller.toggle(files[0].id, true);
  assert.notEqual(controller.getSnapshot(), snapshot);
  assert.throws(() => { controller.getSnapshot().selectedIds.push('12:78:9'); }, TypeError);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['12:78:1']);
  controller.show();
  assert.equal(seen.at(-1).visible, true);
  const before = seen.length;
  unsubscribe();
  controller.hide();
  assert.equal(seen.length, before, 'unsubscribed listeners stop receiving snapshots');
  assert.equal(controller.getSnapshot().visible, false);
});

test('a real sequential direct download starts only after the second confirmation', async () => {
  const clicks = [];
  const attached = [];
  const pageDocument = {
    body: { append: anchor => attached.push(anchor) },
    createElement: () => ({
      href: '', download: '', rel: '', hidden: false,
      click() { clicks.push(this.href); },
      remove() { const index = attached.indexOf(this); if (index >= 0) attached.splice(index, 1); },
    }),
  };
  const files = [file(1, LIMIT + 1), file(2, MiB)];
  const { controller } = harness({ files, document: pageDocument, downloadDirect });
  const progress = [];
  controller.subscribe(snapshot => { if (snapshot.progress) progress.push(snapshot.progress.message); });
  await controller.scan();
  selectAll(controller, files);
  assert.equal(controller.requestDownload().state, 'confirm-direct');
  assert.deepEqual(clicks, [], 'merely requesting the download must not touch a download link');
  const pending = controller.confirm();
  assert.deepEqual(clicks, [files[0].downloadUrl]);
  await pending;
  assert.deepEqual(clicks, files.map(item => item.downloadUrl), 'files trigger in selection order');
  assert.deepEqual(attached, [], 'every anchor is detached after its click');
  assert.ok(progress.includes('已触发 1/2'));
  assert.ok(progress.includes('已触发 2/2'));
  const done = controller.getSnapshot();
  assert.equal(done.state, 'done');
  assert.equal(done.result.triggeredCount, 2);
  assert.equal(done.result.caution, DIRECT_DOWNLOAD_CAUTION);
  assert.equal(done.result.failedCount, 0);
});

test('query and format filter the visible list without touching the selection', async () => {
  const files = [
    { ...file(1, MiB), name: '第一章.pdf', extension: 'pdf' },
    { ...file(2, MiB), name: '第二章.ppt', extension: 'ppt' },
  ];
  const { controller } = harness({ files });
  await controller.scan();
  selectAll(controller, files);
  assert.equal(controller.getSnapshot().visibleCount, 2);
  assert.deepEqual(controller.setFormat('ppt').files.map(item => item.id), ['12:78:2']);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['12:78:1', '12:78:2']);
  assert.deepEqual(controller.setQuery('第一').files.map(item => item.id), []);
  assert.equal(controller.setFormat('docx').format, 'all', 'unsupported filters fall back to all formats');
  assert.equal(controller.setQuery('').files.length, 2);
  assert.deepEqual(controller.getSnapshot().failures, []);
});

// ---------------------------------------------------------------------------
// Scan ranges (bookmarklet modes)
// ---------------------------------------------------------------------------

test('a fresh controller reports no range contract until the page is inspected', () => {
  const { controller } = harness();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'current');
  assert.deepEqual(snapshot.modes, []);
  assert.equal(snapshot.surface, null);
  assert.equal(snapshot.unitCount, 0);
  assert.deepEqual(snapshot.units, { processed: 0, total: 0, discovered: 0 });
  assert.deepEqual(snapshot.unitFailures, []);
});

test('showing the panel reads the page contract without starting any scan', () => {
  let inspected = 0;
  const { controller, calls } = harness({ inspect: () => { inspected++; return inspection({ entries: 3 }); } });
  const shown = controller.show();
  assert.equal(inspected, 1);
  assert.equal(shown.surface, 'unit-study');
  assert.deepEqual(shown.modes, ['current', 'all']);
  assert.equal(shown.unitCount, 3);
  assert.equal(shown.mode, 'current');
  assert.equal(calls.scan.length, 0, 'inspection never fetches');
});

test('selecting all and invoking scan confirms the range before reading any unit page', async () => {
  let unitsRead = 0;
  const { controller, calls } = harness({
    files: [file(1)],
    inspect: () => inspection({ entries: 2 }),
    scan: async request => {
      calls.scan.push(request);
      unitsRead += request.mode === 'all' ? 1 : 0;
      return scanPayload([file(1)]);
    },
  });
  controller.show();
  controller.setScanMode('all');
  const confirming = await controller.scan();
  assert.equal(confirming.state, 'confirm-all-units');
  assert.deepEqual(confirming.confirmation, { mode: 'all', unitCount: 2 });
  assert.equal(calls.scan.length, 0, 'no scan starts before the confirmation');
  assert.equal(unitsRead, 0);
  controller.confirm();
  assert.equal(controller.getSnapshot().state, 'confirm-all-units', 'the download confirm never starts a scan');
  assert.equal(calls.scan.length, 0);

  const pending = controller.confirmAllUnits();
  assert.equal(controller.getSnapshot().state, 'scanning');
  assert.equal(calls.scan.length, 1);
  assert.equal(calls.scan[0].mode, 'all');
  assert.ok(calls.scan[0].signal instanceof AbortSignal);
  assert.equal(typeof calls.scan[0].onProgress, 'function');
  const ready = await pending;
  assert.equal(ready.state, 'ready');
  assert.equal(ready.confirmation, null);
  assert.equal(unitsRead, 1);
});

test('the current range scans without any confirmation and never reports all', async () => {
  const { controller, calls } = harness({ files: [file(1)], inspect: () => inspection() });
  controller.show();
  await controller.scan();
  assert.equal(calls.scan.length, 1);
  assert.equal(calls.scan[0].mode, 'current');
  assert.equal(controller.getSnapshot().mode, 'current');
  assert.equal(controller.getSnapshot().state, 'ready');
});

test('all is refused on a page whose surface does not offer it', async () => {
  const { controller, calls } = harness({ inspect: () => inspection({ surface: 'resource-directory' }) });
  controller.show();
  assert.equal(controller.setScanMode('all').mode, 'current', 'the range control never offers an unsupported range');
  // A stale range cannot be forced through either: scan() validates it again.
  const refused = await controller.scan();
  assert.equal(refused.state, 'ready');
  assert.equal(calls.scan[0].mode, 'current');
});

test('cancelling the all-units confirmation reads nothing', async () => {
  const { controller, calls } = harness({ files: [file(1)], inspect: () => inspection() });
  controller.show();
  controller.setScanMode('all');
  await controller.scan();
  const cancelled = controller.cancel();
  assert.equal(cancelled.state, 'idle', 'nothing was scanned yet, so the panel returns to idle');
  assert.equal(cancelled.confirmation, null);
  assert.equal(calls.scan.length, 0);
});

test('cancelling a running all-units scan aborts it and drops its late result', async () => {
  const scan = deferred();
  let request;
  const { controller, calls } = harness({
    inspect: () => inspection(),
    scan: received => { request = received; calls.scan.push(received); return scan.promise; },
  });
  controller.show();
  controller.setScanMode('all');
  await controller.scan();
  const pending = controller.confirmAllUnits();
  assert.equal(controller.getSnapshot().state, 'scanning');
  assert.equal(controller.cancel().state, 'cancelled');
  assert.equal(request.signal.aborted, true);
  assert.equal(calls.cancelScan, 1);
  scan.resolve(scanPayload([file(7)]));
  await pending;
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal(controller.getSnapshot().fileCount, 0);
});

test('unit counters and failures stream into the panel while all units load', async () => {
  const seen = [];
  const files = [file(1)];
  const { controller } = harness({
    files,
    inspect: () => inspection({ entries: 3 }),
    scan: async ({ onProgress }) => {
      onProgress({ kind: 'unit-progress', processed: 1, total: 3, discovered: 1 });
      onProgress({ kind: 'discovered', order: 0, resources: [] });
      onProgress({ kind: 'unit-progress', processed: 2, total: 3, discovered: 2, failure: { columnId: '42', title: '第42次课', code: 'NO_DOWNLOAD', message: '单元页面无法访问' } });
      onProgress({ kind: 'progress', processed: 1, total: 1, message: '正在识别 1 / 1' });
      return scanPayload(files, { unitFailures: [{ kind: 'unit', columnId: '42', title: '第42次课', code: 'NO_DOWNLOAD', message: '单元页面无法访问' }],
        units: { processed: 3, total: 3, discovered: 1 } });
    },
  });
  controller.subscribe(snapshot => seen.push(snapshot));
  controller.show();
  controller.setScanMode('all');
  await controller.scan();
  await controller.confirmAllUnits();

  const collecting = seen.filter(snapshot => snapshot.state === 'scanning').map(snapshot => [snapshot.units.processed, snapshot.progress.message]);
  assert.deepEqual(collecting, [
    [0, '正在读取单元页面…'],
    [1, '正在读取单元 1 / 3，已发现 1 个候选'],
    [2, '正在读取单元 2 / 3，已发现 2 个候选'],
    // The discovered batch between those two unit counters published nothing:
    // no snapshot was emitted for it.
    [2, '正在识别 1 / 1'],
  ]);
  const ready = controller.getSnapshot();
  assert.deepEqual(ready.units, { processed: 3, total: 3, discovered: 1 });
  assert.deepEqual(ready.unitFailures.map(failure => failure.columnId), ['42']);
  assert.deepEqual(ready.failures, [], 'unit failures stay separate from file failures');
});

test('changing the range drops the selection and any pending confirmation', async () => {
  const { controller, files } = harness({ files: [file(1, MiB)], inspect: () => inspection() });
  controller.show();
  await controller.scan();
  selectAll(controller, files);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['12:78:1']);
  assert.equal(controller.requestDownload().state, 'confirm-zip');

  const changed = controller.setScanMode('all');
  assert.equal(changed.mode, 'all');
  assert.deepEqual(changed.selectedIds, []);
  assert.equal(changed.confirmation, null);
  assert.equal(changed.state, 'ready');
  await controller.confirm();
});

test('the range is immutable while an archive or direct download is running', async () => {
  const archive = deferred();
  const { controller, calls, files } = harness({
    files: [file(1, MiB)],
    inspect: () => inspection(),
    archiveFiles: (selected, request) => { calls.archive.push({ selected, request }); return archive.promise; },
  });
  controller.show();
  await controller.scan();
  selectAll(controller, files);
  controller.requestDownload();
  const pending = controller.confirm();
  assert.equal(controller.getSnapshot().state, 'archiving');
  assert.equal(controller.setScanMode('all').mode, 'current', 'the running task pins the range it was started from');
  archive.resolve({ blob: {}, name: '课件.zip', bytes: 1, entries: 1, failures: [] });
  await pending;
  assert.equal(controller.setScanMode('all').mode, 'all', 'once the task settles the range is free again');
});

test('a changed page invalidates the selection, the confirmation and the old file list', async () => {
  const files = [file(1, MiB)];
  let page = inspection({ entries: 2, name: 'first' });
  const { controller } = harness({ files, inspect: () => page });
  controller.show();
  await controller.scan();
  selectAll(controller, files);
  assert.equal(controller.requestDownload().state, 'confirm-zip');

  // A reloaded frame document under the same URL is a different generation.
  page = inspection({ entries: 2, name: 'second' });
  const reloaded = controller.show();
  assert.deepEqual(reloaded.selectedIds, []);
  assert.equal(reloaded.confirmation, null);
  assert.equal(reloaded.fileCount, 0, 'the previous scan belongs to the previous page');
  assert.equal(reloaded.state, 'idle');

  // So is another folder, unit page or unit index.
  page = inspection({ surface: 'resource-directory', name: 'directory' });
  assert.equal(controller.show().surface, 'resource-directory');
  assert.deepEqual(controller.getSnapshot().modes, ['current']);
});

test('an edited unit index invalidates the selection even in the same frame', async () => {
  const files = [file(1, MiB)];
  let page = inspection({ entries: 2, name: 'unit' });
  const { controller } = harness({ files, inspect: () => page });
  controller.show();
  await controller.scan();
  selectAll(controller, files);
  assert.deepEqual(controller.getSnapshot().selectedIds, ['12:78:1']);

  // The same document now advertises three units: the range it belongs to has
  // changed, so nothing selected for the previous index may survive.
  page = inspection({ entries: 3, name: 'unit' });
  const changed = controller.show();
  assert.equal(changed.unitCount, 3);
  assert.deepEqual(changed.selectedIds, []);
  assert.equal(changed.fileCount, 0);
  assert.equal(changed.state, 'idle');
});

test('the range survives an unchanged page and a repeated show', async () => {
  let inspected = 0;
  const { controller } = harness({ files: [file(1)], inspect: () => { inspected++; return inspection(); } });
  controller.show();
  controller.setScanMode('all');
  const again = controller.show();
  assert.equal(inspected, 2);
  assert.equal(again.mode, 'all', 'an unchanged page keeps the chosen range');
  assert.equal(again.state, 'idle');
});
