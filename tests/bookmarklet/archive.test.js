import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { ActualSizeLimitError, archiveFiles } from '../../src/bookmarklet/archive.js';
import { createArchiveSession, createLoopbackWorker } from '../../src/bookmarklet/archive-worker.js';
import { ZIP_LIMIT_BYTES } from '../../src/bookmarklet/download-plan.js';
import { file } from '../helpers/dom.js';

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const payload = (label, size = 64) => {
  const text = new TextEncoder().encode(label.padEnd(size, '.'));
  const bytes = new Uint8Array(OLE.length + text.byteLength);
  bytes.set(OLE);
  bytes.set(text, OLE.length);
  return bytes;
};
const CONTENT = new Map([[56, payload('第一章内容')], [57, payload('第二章内容')]]);
const courseFile = (n, overrides = {}) => ({
  ...file(n),
  name: `第${n}章.ppt`,
  sizeBytes: CONTENT.get(n).byteLength,
  ...overrides,
});
const served = (bytes, { status = 200, chunkSize = 0, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  type: 'basic',
  redirected: false,
  url: '',
  headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), ...headers }),
  body: new ReadableStream({
    start(controller) {
      if (!chunkSize) controller.enqueue(bytes);
      else for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      controller.close();
    },
  }),
});
// Serves one content fixture per fileid, split into small chunks so every entry
// crosses several `entry` messages.
const serving = (responses = new Map()) => async url => {
  const id = Number(new URL(url).searchParams.get('fileid'));
  const override = responses.get(id);
  if (override) return typeof override === 'function' ? override() : override;
  return served(CONTENT.get(id), { chunkSize: 8 });
};
// The real loopback worker, wrapped only to observe the cleanup the caller owes it.
const trackingWorker = () => {
  const worker = createLoopbackWorker();
  return {
    terminated: false,
    replies: [],
    set onmessage(handler) {
      worker.onmessage = event => {
        this.replies.push(event.data?.type);
        handler(event);
      };
    },
    get onmessage() { return worker.onmessage; },
    postMessage: message => worker.postMessage(message),
    terminate() { this.terminated = true; worker.terminate(); },
  };
};
// Reads the central directory, so entry names and the compression method come from
// the produced bytes rather than from the code that wrote them.
function centralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const decoder = new TextDecoder();
  const records = [];
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < view.getUint16(eocd + 10, true); index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    records.push({
      method: view.getUint16(offset + 10, true),
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return records;
}
const sameBytes = (actual, expected) => assert.deepEqual(Uint8Array.from(actual), Uint8Array.from(expected));

test('one Store-mode ZIP holds the exact source bytes under safe courseware names', async () => {
  const result = await archiveFiles([courseFile(56), courseFile(57)], { fetcher: serving() });
  assert.equal(result.name, '电路.zip');
  assert.equal(result.entries, 2);
  assert.equal(result.bytes, CONTENT.get(56).byteLength + CONTENT.get(57).byteLength);
  assert.deepEqual(result.failures, []);
  assert.equal(result.blob.type, 'application/zip');
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const zipped = centralDirectory(bytes);
  assert.deepEqual(zipped, [
    { method: 0, name: '电路/第56章.ppt' },
    { method: 0, name: '电路/第57章.ppt' },
  ]);
  const unzipped = unzipSync(bytes);
  sameBytes(unzipped['电路/第56章.ppt'], CONTENT.get(56));
  sameBytes(unzipped['电路/第57章.ppt'], CONTENT.get(57));
});

test('progress reports the current file, its bytes and the archive total', async () => {
  const events = [];
  const result = await archiveFiles([courseFile(56), courseFile(57)], {
    fetcher: serving(),
    onProgress: event => events.push(event),
  });
  const last = events.at(-1);
  assert.deepEqual(
    { processed: last.processed, total: last.total, name: last.name, succeeded: last.succeeded, failed: last.failed },
    { processed: 2, total: 2, name: '电路/第57章.ppt', succeeded: 2, failed: 0 },
  );
  assert.equal(last.fileSize, CONTENT.get(57).byteLength);
  assert.equal(last.fileBytes, CONTENT.get(57).byteLength);
  assert.equal(last.bytes, result.bytes);
  assert.match(last.message, /第57章\.ppt/);
  assert.ok(events.some(event => event.name === '电路/第56章.ppt' && event.fileBytes < event.fileSize));
});

test('duplicate names are numbered in selection order and stay deterministic', async () => {
  const duplicated = [courseFile(56), courseFile(57, { name: courseFile(56).name })];
  const run = async () => {
    const result = await archiveFiles(duplicated, { fetcher: serving() });
    return centralDirectory(new Uint8Array(await result.blob.arrayBuffer())).map(record => record.name);
  };
  assert.deepEqual(await run(), ['电路/第56章.ppt', '电路/第56章 (2).ppt']);
  assert.deepEqual(await run(), ['电路/第56章.ppt', '电路/第56章 (2).ppt']);
});

test('a single unreadable file is listed in the failure manifest and the rest still archive', async () => {
  const result = await archiveFiles([courseFile(56), courseFile(57)], {
    fetcher: serving(new Map([[57, () => served(new Uint8Array(0), { status: 403 }) ]])),
  });
  assert.equal(result.entries, 1);
  assert.deepEqual(result.failures, [{ name: '电路/第57章.ppt', reason: '服务器拒绝下载，请确认登录状态和课件权限' }]);
  const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(unzipped), ['电路/第56章.ppt', '下载失败清单.txt']);
  sameBytes(unzipped['电路/第56章.ppt'], CONTENT.get(56));
  assert.equal(
    new TextDecoder().decode(unzipped['下载失败清单.txt']),
    '电路/第57章.ppt\t服务器拒绝下载，请确认登录状态和课件权限\n',
  );
});

test('an all-failure run produces no archive and releases the worker', async () => {
  const worker = trackingWorker();
  const refused = new Map([[56, () => served(new Uint8Array(0), { status: 403 })], [57, () => served(new Uint8Array(0), { status: 401 })]]);
  await assert.rejects(
    archiveFiles([courseFile(56), courseFile(57)], { fetcher: serving(refused), createWorker: () => worker }),
    error => error.code === 'NO_FILES',
  );
  assert.equal(worker.terminated, true);
  assert.ok(!worker.replies.includes('complete'));
});

test('an announced size above the budget stops before reading any content', async () => {
  const worker = trackingWorker();
  await assert.rejects(
    archiveFiles([courseFile(56)], {
      fetcher: async () => served(CONTENT.get(56), { headers: { 'content-length': '4096' } }),
      limitBytes: 512,
      createWorker: () => worker,
    }),
    error => error instanceof ActualSizeLimitError,
  );
  assert.equal(worker.terminated, true);
  assert.ok(!worker.replies.includes('complete'));
});

test('content that grows past the budget while reading destroys the archive', async () => {
  const worker = trackingWorker();
  let cancelled = false;
  const bytes = CONTENT.get(56);
  const response = served(bytes);
  // No content-length: the breach can only be caught from the bytes themselves.
  response.headers = new Headers({ 'content-type': 'application/octet-stream' });
  response.body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 16));
      controller.enqueue(bytes);
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    archiveFiles([courseFile(56)], {
      fetcher: async () => response,
      limitBytes: bytes.byteLength - 1,
      createWorker: () => worker,
    }),
    error => error instanceof ActualSizeLimitError,
  );
  assert.equal(cancelled, true);
  assert.equal(worker.terminated, true);
  assert.ok(!worker.replies.includes('complete'));
});

test('a response body that fails mid-read aborts the whole archive instead of truncating a file', async () => {
  const worker = trackingWorker();
  const bytes = CONTENT.get(56);
  const response = served(bytes);
  response.body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 16));
      controller.error(new Error('connection reset'));
    },
  });
  await assert.rejects(
    archiveFiles([courseFile(56)], { fetcher: async () => response, createWorker: () => worker }),
    error => error.code === 'NETWORK',
  );
  assert.equal(worker.terminated, true);
  assert.ok(!worker.replies.includes('complete'));
});

test('cancelling the archive releases the reader and the worker', async () => {
  const worker = trackingWorker();
  const controller = new AbortController();
  const response = served(CONTENT.get(56));
  response.body = new ReadableStream({ start(stream) { stream.enqueue(CONTENT.get(56)); } });
  let events = 0;
  await assert.rejects(
    archiveFiles([courseFile(56)], {
      fetcher: async () => response,
      signal: controller.signal,
      createWorker: () => worker,
      onProgress: () => {
        events += 1;
        if (events === 1) controller.abort();
      },
    }),
    error => error.code === 'CANCELLED',
  );
  assert.equal(worker.terminated, true);
  assert.ok(!worker.replies.includes('complete'));
});

test('the default budget is the 500 MiB ZIP ceiling, inclusive', async () => {
  const bytes = CONTENT.get(56);
  const declared = length => async () => served(bytes, { headers: { 'content-length': String(length) } });
  await assert.rejects(
    archiveFiles([courseFile(56)], { fetcher: declared(ZIP_LIMIT_BYTES + 1) }),
    error => error instanceof ActualSizeLimitError,
  );
  const result = await archiveFiles([courseFile(56)], { fetcher: declared(ZIP_LIMIT_BYTES) });
  assert.equal(result.entries, 1);
});

test('the worker protocol answers progress and complete only inside a session', () => {
  const replies = [];
  const session = createArchiveSession(reply => replies.push(reply));
  session.handle({ type: 'entry', id: 0, name: '电路/第56章.ppt', final: true });
  assert.equal(replies[0].code, 'PROTOCOL');
  session.handle({ type: 'start' });
  session.handle({ type: 'entry', id: 0, name: '电路/第56章.ppt', chunk: new Uint8Array([1, 2, 3]), final: true });
  session.handle({ type: 'finish', failures: [] });
  assert.deepEqual(replies.map(reply => reply.type), ['error', 'progress', 'complete']);
  assert.equal(replies[1].totalBytes, 3);
  assert.equal(replies[2].entries, 1);
  session.handle({ type: 'finish', failures: [] });
  assert.equal(replies.at(-1).type, 'error');
});
