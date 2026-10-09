import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadQueue } from '../../src/runtime/download-queue.js';
import { file, memoryStorage, nativeDownloads, waitFor } from './helpers.js';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
function setup(options = {}) {
  const native = nativeDownloads(), storage = memoryStorage(); let count = 0;
  const queue = createDownloadQueue({ storage, downloads: native.downloads, preflight: async () => {}, extensionId: EXTENSION_ID, makeId: () => 'job-' + ++count, ...options });
  return { ...native, storage, queue };
}
test('exactly two native transfers remain active; obtaining download IDs does not release slots', async () => {
  const h = setup();
  await h.queue.enqueue([file(), file(2), file(3), file(4)], { courseName: '课程', requestId: 'one' });
  await waitFor(() => h.calls.length === 2, 'first two transfers');
  await h.queue.refresh();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.queue.getJobs()).filter(job => job.status === 'queued').length, 2);
  h.items.get(1).state = 'complete'; await h.queue.refresh();
  await waitFor(() => h.calls.length === 3, 'next transfer');
  assert.equal((await h.queue.getJobs()).filter(job => job.status === 'downloading').length, 2);
});
test('worker restart recovers active downloads without starting duplicate transfers', async () => {
  const h = setup();
  await h.queue.enqueue([file(), file(2), file(3)], { requestId: 'one' });
  await waitFor(async () => (await h.queue.getJobs()).filter(job => job.status === 'downloading').length === 2);
  const recovered = createDownloadQueue({ storage: h.storage, downloads: h.downloads, preflight: async () => {}, extensionId: EXTENSION_ID });
  await recovered.init(); await recovered.refresh();
  assert.equal(h.calls.length, 2);
  h.items.get(2).state = 'complete'; await recovered.refresh();
  await waitFor(() => h.calls.length === 3);
  assert.equal(new Set(h.calls.map(call => call.url)).size, 3);
});
test('concurrent submissions deduplicate active files and repeated request IDs', async () => {
  const h = setup();
  const results = await Promise.all([h.queue.enqueue([file()], { requestId: 'same' }), h.queue.enqueue([file()], { requestId: 'same' }), h.queue.enqueue([file()], { requestId: 'other' })]);
  assert.equal(results.reduce((n, result) => n + result.created.length, 0), 1);
  await waitFor(() => h.calls.length === 1);
});
test('browser cancellation is retryable and cannot duplicate another active job', async () => {
  const h = setup();
  const first = await h.queue.enqueue([file()], { requestId: 'one' });
  await waitFor(() => h.calls.length === 1);
  await h.downloads.cancel(1); await h.queue.refresh();
  assert.equal((await h.queue.getJobs())[0].status, 'cancelled');
  await h.queue.enqueue([file()], { requestId: 'two' });
  await assert.rejects(h.queue.retry(first.created[0]), { code: 'DUPLICATE_JOB' });
});
test('preflight failure releases its slot and never creates a native download for the failed file', async () => {
  const h = setup({ preflight: async f => { if (f.id === file().id) throw new Error('expired'); } });
  await h.queue.enqueue([file(), file(2), file(3)], { requestId: 'one' });
  await waitFor(() => h.calls.length === 2);
  assert.ok(h.calls.every(call => call.url !== file().downloadUrl));
  assert.equal((await h.queue.getJobs())[0].error, 'expired');
});
test('an uncertain launch on restart requires manual recovery rather than automatic duplication', async () => {
  const job = { id: 'pending', file: file(), status: 'preparing', startedAt: Date.now(), courseName: '课程' };
  const h = setup({ storage: memoryStorage({ jobs: [job], requests: [] }) });
  const result = await h.queue.init();
  assert.equal(result[0].errorCode, 'RECOVERY_REQUIRED'); assert.equal(h.calls.length, 0);
});
test('unsafe persisted jobs and arbitrary download URLs are rejected', async () => {
  const h = setup();
  await assert.rejects(h.queue.enqueue([file(1, { downloadUrl: 'https://evil.test/download' })], { requestId: 'bad' }));
  assert.equal(h.calls.length, 0);
});


test('preflight representation is persisted and a strong ETag pins the native request', async () => {
  const h = setup({ preflight: async () => ({ expectedBytes: 100, responseName: file().name, etag: '"version-1"', sampleComplete: true, level: 'document-structure' }) });
  await h.queue.enqueue([file()], { requestId: 'metadata' });
  await waitFor(() => h.calls.length === 1);
  assert.deepEqual(h.calls[0].headers, [{ name: 'If-Match', value: '"version-1"' }]);
  Object.assign(h.items.get(1), { state: 'complete', bytesReceived: 100, totalBytes: 100, fileSize: 100, filename: 'C:\\Downloads\\' + h.calls[0].filename.replaceAll('/', '\\') });
  await h.queue.refresh(); const job = (await h.queue.getJobs())[0];
  assert.equal(job.status, 'done'); assert.equal(job.verification, 'browser-complete'); assert.equal(job.fileSize, 100);
  assert.equal(job.actualFilename, h.items.get(1).filename);
  assert.equal(h.storage.peek().jobs[0].preflight.etag, '"version-1"');
});
test('a changed native size, wrong saved extension or empty file cannot report success', async () => {
  for (const variant of ['size', 'name', 'empty']) {
    const h = setup({ preflight: async () => ({ expectedBytes: 100 }) });
    await h.queue.enqueue([file()], { requestId: variant }); await waitFor(() => h.calls.length === 1);
    Object.assign(h.items.get(1), { state: 'complete', bytesReceived: 100, totalBytes: 100, fileSize: 100, filename: h.calls[0].filename });
    if (variant === 'size') h.items.get(1).fileSize = 99;
    if (variant === 'name') h.items.get(1).filename += '.html';
    if (variant === 'empty') h.items.get(1).fileSize = 0;
    await h.queue.refresh(); const job = (await h.queue.getJobs())[0];
    assert.equal(job.status, 'failed'); assert.match(job.error, /不会自动删除/);
  }
});
test('Chrome uniquified names are accepted and recorded, but unrelated renames are not', async () => {
  const h = setup(); await h.queue.enqueue([file()], { requestId: 'same-name' }); await waitFor(() => h.calls.length === 1);
  Object.assign(h.items.get(1), { state: 'complete', filename: 'C:/Downloads/' + h.calls[0].filename.replace('.pdf', ' (1).pdf'), fileSize: 100 });
  await h.queue.refresh(); const job = (await h.queue.getJobs())[0]; assert.equal(job.status, 'done'); assert.match(job.actualFilename, / \(1\)\.pdf$/);
});
test('an already-started pre-upgrade download retains its original relative path on recovery', async () => {
  const native = nativeDownloads(); const downloadId = await native.downloads.download({ url: file().downloadUrl, filename: '旧课程/课件1.pdf' });
  const storage = memoryStorage({ jobs: [{ id: 'old-job', file: file(), courseName: '旧课程', status: 'downloading', filename: '旧课程/课件1.pdf', startedAt: 123, downloadId }], requests: [] });
  const queue = createDownloadQueue({ storage, downloads: native.downloads, preflight: async () => {}, extensionId: EXTENSION_ID });
  await queue.init(); native.items.get(downloadId).state = 'complete'; await queue.refresh();
  const job = (await queue.getJobs())[0]; assert.equal(job.status, 'done'); assert.equal(job.filename, '旧课程/课件1.pdf');
});
test('refreshing unchanged jobs does not rewrite persistent storage on every UI tick', async () => {
  let writes = 0; const backing = memoryStorage(); const h = setup({ storage: { read: backing.read, write: async value => { writes++; await backing.write(value); } } });
  await h.queue.init(); const before = writes; await h.queue.refresh(); await h.queue.refresh(); assert.equal(writes, before);
});


test('one transient native-search failure does not block reconciliation or free its active slot', async () => {
  const h = setup();
  await h.queue.enqueue([file(), file(2), file(3)], { requestId: 'partial-search-error' });
  await waitFor(async () => (await h.queue.getJobs()).filter(j => j.status === 'downloading').length === 2);
  const realSearch = h.downloads.search;
  h.downloads.search = async query => { if (query.id === 1) throw new Error('temporary Chrome API error'); return realSearch(query); };
  h.items.get(2).state = 'complete';
  const jobs = await h.queue.refresh();
  assert.equal(jobs[0].status, 'downloading');
  assert.match(jobs[0].syncWarning, /自动重试/);
  assert.equal(jobs[1].status, 'done');
  await waitFor(() => h.calls.length === 3);
  assert.equal(h.calls.filter(call => call.url === file().downloadUrl).length, 1);
  h.downloads.search = realSearch;
  const recovered = await h.queue.refresh();
  assert.equal(recovered[0].syncWarning, '');
});


test('a failed first status query never cancels a native transfer that already has an ID', async () => {
  const h = setup();
  const nativeSearch = h.downloads.search;
  h.downloads.search = async () => { throw new Error('temporary query error'); };
  await h.queue.enqueue([file()], { requestId: 'launch-query-error' });
  await waitFor(async () => (await h.queue.getJobs())[0]?.syncWarning);
  const job = (await h.queue.getJobs())[0];
  assert.equal(job.status, 'downloading'); assert.equal(job.downloadId, 1);
  assert.equal(h.items.get(1).state, 'in_progress'); assert.equal(h.calls.length, 1);
  h.downloads.search = nativeSearch; h.items.get(1).state = 'complete';
  await h.queue.refresh(); assert.equal((await h.queue.getJobs())[0].status, 'done');
});
test('an interrupted Chrome query during worker recovery retains the native ID and occupied slot', async () => {
  const native = nativeDownloads(), downloadId = await native.downloads.download({ url: file().downloadUrl, filename: '课程/课件1.pdf' });
  const search = native.downloads.search;
  native.downloads.search = async () => { throw new Error('restarting'); };
  const queue = createDownloadQueue({ storage: memoryStorage({ jobs: [{ id: 'recover', file: file(), courseName: '课程', filename: '课程/课件1.pdf', status: 'downloading', downloadId, startedAt: 123 }], requests: [] }), downloads: native.downloads, preflight: async () => {}, extensionId: EXTENSION_ID });
  const jobs = await queue.init(); assert.equal(jobs[0].status, 'downloading'); assert.equal(jobs[0].downloadId, downloadId);
  assert.match(jobs[0].syncWarning, /自动重试/); assert.equal(native.calls.length, 1);
  native.downloads.search = search;
  await queue.refresh(); assert.equal((await queue.getJobs())[0].syncWarning, '');
});
