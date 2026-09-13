import { AppError } from './policy.js';

export async function withDeadline(work, { timeoutMs = 15000, signal } = {}) {
  const controller = new AbortController();
  let timer, onAbort;
  const stop = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AppError('TIMEOUT', '请求超时，请检查网络后重新尝试');
      controller.abort(error); reject(error);
    }, timeoutMs);
    onAbort = () => {
      const error = new AppError('CANCELLED', '扫描已取消，请重新扫描当前目录');
      controller.abort(error); reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), stop]); }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
  }
}

export async function readHtmlResponse(response, {
  signal,
  maxBytes = 2 * 1024 * 1024,
  badEncodingMessage = '预览页的字符编码不受支持，请在平台确认该资源',
  tooLargeMessage = '预览页内容异常，请在平台确认该资源',
} = {}) {
  const type = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
    throw new AppError('NO_DOWNLOAD', '平台未返回可识别的课件预览页');
  }
  // THEOL serves GBK pages; Response.text() would always use UTF-8.
  const charset = type.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
  let bytes = new Uint8Array(0);
  if (response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    const stopReading = () => { try { reader.cancel().catch(() => {}); } catch { /* reader already released */ } };
    let onAbort = null;
    if (signal) {
      if (signal.aborted) stopReading();
      else signal.addEventListener('abort', onAbort = stopReading, { once: true });
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size > maxBytes) throw new AppError('BAD_FILE', tooLargeMessage);
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      stopReading();
    }
    bytes = chunks.length === 1 ? chunks[0] : chunks.length ? concatBytes(chunks, size) : new Uint8Array(0);
  } else {
    // Headers-only or null-body objects in tests: fall back to arrayBuffer().
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new AppError('BAD_FILE', tooLargeMessage);
  }
  let decoder;
  try { decoder = new TextDecoder(charset); }
  catch { throw new AppError('BAD_FILE', badEncodingMessage); }
  return decoder.decode(bytes);
}

function concatBytes(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
