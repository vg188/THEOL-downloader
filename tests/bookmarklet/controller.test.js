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
  if (options.deliverArchive) deps.deliverArchive = async value => { calls.deliver.push(value); };
  const controller = createBookmarkletController(deps);
  return { controller, calls, files, deps };
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
