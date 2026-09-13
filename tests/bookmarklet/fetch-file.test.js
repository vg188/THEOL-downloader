import assert from 'node:assert/strict';
import test from 'node:test';
import { ActualSizeLimitError, fetchCourseFile } from '../../src/bookmarklet/fetch-file.js';
import { downloadUrl, file, previewUrl } from '../helpers/dom.js';

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const pdf = (extra = '') => new TextEncoder().encode(`%PDF-1.7\n${extra}`);
const ppt = (extra = '') => {
  const body = new TextEncoder().encode(extra);
  const bytes = new Uint8Array(OLE.length + body.length);
  bytes.set(OLE);
  bytes.set(body, OLE.length);
  return bytes;
};
const concat = chunks => {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};
// A Response-shaped stub: real `Response` cannot carry the redirect/login states,
// the response URL or a null body that the download rules must reject.
const respond = ({
  chunks = [], status = 200, type = 'basic', redirected = false, url = '',
  headers = { 'content-type': 'application/octet-stream' }, body = true,
} = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  type,
  redirected,
  url,
  headers: new Headers(headers),
  body: !body ? null : new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
});
const pdfFile = () => ({ ...file(), name: '第一章.pdf', extension: 'pdf' });

test('the canonical download URL is validated before any request', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return respond({ chunks: [pdf()] });
  };
  await assert.rejects(
    fetchCourseFile({ ...pdfFile(), downloadUrl: 'https://evil.example/meol/common/script/download.jsp?fileid=56&resid=78&lid=12' }, { fetcher }),
    error => error.code === 'INVALID_URL',
  );
  await assert.rejects(
    fetchCourseFile({ ...pdfFile(), downloadUrl: downloadUrl(99) }, { fetcher }),
    error => error.code === 'INVALID_RESOURCE',
  );
  await assert.rejects(
    fetchCourseFile({ ...pdfFile(), previewUrl: previewUrl(56).replace('lid=12', 'lid=13') }, { fetcher }),
    error => error.code === 'INVALID_RESOURCE',
  );
  assert.equal(calls, 0);
});

test('reads with the page session, no redirect following, and forwards every byte in order', async () => {
  const chunks = [pdf('一'), new Uint8Array([1, 2, 3]), new TextEncoder().encode('尾部')];
  const seen = [];
  let options = null;
  const result = await fetchCourseFile(pdfFile(), {
    fetcher: async (url, init) => {
      options = init;
      assert.equal(url, downloadUrl(56));
      return respond({ chunks, headers: { 'content-type': 'application/pdf; charset=binary' } });
    },
    onChunk: chunk => seen.push(chunk),
  });
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers, undefined);
  assert.deepEqual(concat(seen), concat(chunks));
  assert.deepEqual(result, { id: '12:78:56', name: '第一章.pdf', mime: 'application/pdf', bytes: concat(chunks).byteLength });
});

test('a signature split across chunks is still verified', async () => {
  const bytes = ppt('拆分的响应');
  const seen = [];
  await fetchCourseFile(file(), {
    fetcher: async () => respond({ chunks: [bytes.subarray(0, 3), bytes.subarray(3, 5), bytes.subarray(5)] }),
    onChunk: chunk => seen.push(chunk),
  });
  assert.deepEqual(concat(seen), bytes);
});

test('login redirects, expired sessions and refusals are reported as such', async () => {
  const cases = [
    [{ type: 'opaqueredirect', status: 0 }, 'LOGIN_REQUIRED'],
    [{ redirected: true, status: 200 }, 'LOGIN_REQUIRED'],
    [{ status: 401 }, 'LOGIN_REQUIRED'],
    [{ status: 403 }, 'NO_DOWNLOAD'],
  ];
  for (const [shape, code] of cases) {
    await assert.rejects(fetchCourseFile(pdfFile(), { fetcher: async () => respond({ chunks: [pdf()], ...shape }) }), error => error.code === code);
  }
});

test('login pages, wrong formats and short bodies never reach the archive', async () => {
  const web = { 'content-type': 'text/html; charset=gbk' };
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => respond({ chunks: [pdf()], headers: web }) }),
    error => error.code === 'BAD_FILE',
  );
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => respond({ chunks: [new TextEncoder().encode('<!doctype html>login')] }) }),
    error => error.code === 'BAD_FILE',
  );
  await assert.rejects(
    fetchCourseFile(file(), { fetcher: async () => respond({ chunks: [new Uint8Array([0x50, 0x4b, 0x03])] }) }),
    error => error.code === 'BAD_FILE',
  );
});

test('a response for another file is rejected and a missing body is empty', async () => {
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => respond({ chunks: [pdf()], url: downloadUrl(99), headers: { 'content-type': 'application/pdf' } }) }),
    error => error.code === 'BAD_FILE',
  );
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => respond({ body: false }) }),
    error => error.code === 'BAD_FILE',
  );
});

test('cancellation rejects with CANCELLED and cancels the reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let seen = 0;
  const response = respond({ chunks: [] });
  response.body = new ReadableStream({
    start(stream) {
      stream.enqueue(pdf('开始'));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    fetchCourseFile(pdfFile(), {
      fetcher: async () => response,
      signal: controller.signal,
      onChunk: () => {
        seen += 1;
        controller.abort();
      },
    }),
    error => error.code === 'CANCELLED',
  );
  assert.equal(seen, 1);
  assert.equal(cancelled, true);
});

test('the reader is cancelled when a later consumer stops the stream', async () => {
  let cancelled = false;
  const stop = new Error('consumer stopped');
  const response = respond({ chunks: [] });
  response.body = new ReadableStream({
    start(stream) { stream.enqueue(pdf('开始')); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => response, onChunk: () => { throw stop; } }),
    error => error === stop,
  );
  assert.equal(cancelled, true);
});

test('an already-announced size above the budget is refused before reading', async () => {
  let chunkRead = false;
  const response = respond({ chunks: [pdf('x'.repeat(64))], headers: { 'content-type': 'application/pdf', 'content-length': '2000' } });
  const original = response.body.getReader.bind(response.body);
  response.body.getReader = () => {
    chunkRead = true;
    return original();
  };
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => response, limitBytes: 1024 }),
    error => error instanceof ActualSizeLimitError,
  );
  assert.equal(chunkRead, false);
});

test('the actual byte count is enforced, and the exact budget is allowed', async () => {
  const bytes = pdf('内容内容内容');
  const response = () => respond({ chunks: [bytes], headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(
    fetchCourseFile(pdfFile(), { fetcher: async () => response(), limitBytes: bytes.byteLength - 1 }),
    error => error instanceof ActualSizeLimitError,
  );
  const result = await fetchCourseFile(pdfFile(), { fetcher: async () => response(), limitBytes: bytes.byteLength });
  assert.equal(result.bytes, bytes.byteLength);
});
