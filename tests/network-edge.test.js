import assert from 'node:assert/strict';
import test from 'node:test';
import { readHtmlResponse, withDeadline } from '../src/platform/network.js';
import { preflight } from '../src/background/preflight.js';
import { AppError } from '../src/platform/policy.js';
import { file, downloadUrl } from './helpers/dom.js';

const headers = value => new Headers({ 'content-type': value });
function streamResponse(chunks, contentType = 'text/html; charset=utf-8') {
  const encoder = new TextEncoder();
  return {
    headers: headers(contentType),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

test('a streamed preview page is decoded after joining every chunk', async () => {
  // A split multi-byte sequence must survive concatenation: the bytes are only
  // decoded once, after the whole body has been read.
  const body = '中文课件名单'.repeat(40);
  const middle = Math.floor(body.length / 2);
  const html = await readHtmlResponse(streamResponse([body.slice(0, middle), body.slice(middle)]));
  assert.equal(html, body);
});

test('a single-chunk body is decoded without copying', async () => {
  assert.equal(await readHtmlResponse(streamResponse(['<html>第一章</html>'])), '<html>第一章</html>');
});

test('a response without a stream falls back to arrayBuffer()', async () => {
  const encoder = new TextEncoder();
  const response = { headers: headers('text/html; charset=utf-8'), body: null,
    async arrayBuffer() { return encoder.encode('<html>fallback</html>').buffer; } };
  assert.equal(await readHtmlResponse(response), '<html>fallback</html>');
});

test('an oversized streamed body stops reading and reports the caller message', async () => {
  await assert.rejects(
    () => readHtmlResponse(streamResponse(['x'.repeat(1024), 'y'.repeat(1024)]), { maxBytes: 512, tooLargeMessage: '单元页面内容异常' }),
    error => error instanceof AppError && error.code === 'BAD_FILE' && error.message === '单元页面内容异常',
  );
});

test('an oversized buffered body is rejected too', async () => {
  const encoder = new TextEncoder();
  const response = { headers: headers('text/html'), body: null,
    async arrayBuffer() { return encoder.encode('z'.repeat(2048)).buffer; } };
  await assert.rejects(() => readHtmlResponse(response, { maxBytes: 256 }),
    error => error.code === 'BAD_FILE');
});

test('a non-HTML content type never reaches the decoder', async () => {
  await assert.rejects(() => readHtmlResponse(streamResponse(['%PDF-1.7'], 'application/pdf')),
    error => error.code === 'NO_DOWNLOAD');
});

test('an unsupported charset is refused instead of mis-decoded', async () => {
  await assert.rejects(() => readHtmlResponse(streamResponse(['<html/>'], 'text/html; charset=not-a-charset')),
    error => error.code === 'BAD_FILE' && /字符编码/.test(error.message));
});

test('an aborted read never returns a truncated body', async () => {
  const controller = new AbortController();
  const response = { headers: headers('text/html'), body: new ReadableStream({
    async pull(c) { c.enqueue(new TextEncoder().encode('a'.repeat(64))); await new Promise(r => setTimeout(r, 20)); },
  }) };
  const reading = readHtmlResponse(response, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => reading, error => error.code === 'CANCELLED');
});

test('withDeadline surfaces timeout as an AppError with a retry hint', async () => {
  await assert.rejects(() => withDeadline(() => new Promise(() => {}), { timeoutMs: 5 }),
    error => error instanceof AppError && error.code === 'TIMEOUT');
});

test('withDeadline turns an external abort into a cancellation', async () => {
  const controller = new AbortController();
  const work = withDeadline(() => new Promise(() => {}), { timeoutMs: 60000, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => work, error => error.code === 'CANCELLED');
});

test('withDeadline reports a pre-aborted signal immediately', async () => {
  await assert.rejects(() => withDeadline(async () => 'never', { signal: AbortSignal.abort() }),
    error => error.code === 'CANCELLED');
});

const okResponse = bytes => ({
  ok: true, status: 206, redirected: false, type: 'basic', url: downloadUrl(1),
  headers: new Headers({ 'content-type': 'application/vnd.ms-powerpoint' }),
  body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
});

test('preflight converts a transport failure into a retryable NETWORK error', async () => {
  await assert.rejects(() => preflight(file(1), { fetcher: async () => { throw new TypeError('Failed to fetch'); } }),
    error => error instanceof AppError && error.code === 'NETWORK' && /网络/.test(error.message));
});

test('preflight keeps the specific reason of an AppError', async () => {
  await assert.rejects(() => preflight(file(1), { fetcher: async () => ({ ok: false, status: 403, url: downloadUrl(56), headers: new Headers() }) }),
    error => error.code === 'NO_DOWNLOAD');
});

test('preflight rejects a redirect to the login page', async () => {
  await assert.rejects(() => preflight(file(1), { fetcher: async () => ({ ok: true, status: 200, redirected: true, url: downloadUrl(56), headers: new Headers() }) }),
    error => error.code === 'LOGIN_REQUIRED');
});

test('preflight accepts a real PPT sample and drops the parameters from the mime', async () => {
  const sample = new Uint8Array(1024);
  sample.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  const result = await preflight(file(1), { fetcher: async () => okResponse(sample) });
  assert.equal(result.mime, 'application/vnd.ms-powerpoint');
});
