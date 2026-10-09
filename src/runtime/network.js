import { schoolUrl, pageUrl, problem, validateFile, matchesFileUrl, isGeneratedPreview, isPreviewSource, requiresPreparedDownload, previewAssetUrl, previewNotice } from './policy.js';
import { renderPreviewBytes } from './preview-content.js';
import { inspectFileContent } from './file-content.js';
import { responseHeaders, assertExactMetadataSize } from './response-metadata.js';

export function checkCancelled(signal) {
  if (signal?.aborted) throw problem('CANCELLED', '操作已取消');
}
export async function requestTask(work, { signal, timeoutMs = 30000 } = {}) {
  checkCancelled(signal);
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, timeoutMs);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(problem(timeout ? 'TIMEOUT' : 'CANCELLED', timeout ? '请求超时，请检查网络后重试' : '操作已取消')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]); }
  catch (error) {
    if (controller.signal.aborted) throw problem(timeout ? 'TIMEOUT' : 'CANCELLED', timeout ? '请求超时，请检查网络后重试' : '操作已取消');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
export async function readBoundedBody(response, { maxBytes, signal } = {}) {
  checkCancelled(signal);
  const length = response.headers.get('content-length');
  const transportEncoding = response.headers.get('content-encoding') || '';
  if ((!transportEncoding || /^identity$/i.test(transportEncoding)) && length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw problem('OVER_BUDGET', '文件体积超过剩余内存预算');
  }
  if (!response.body?.getReader) throw problem('NO_BODY', '服务器未返回可读取的文件内容');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    const chunks = []; let size = 0;
    while (true) {
      checkCancelled(signal);
      const { value, done } = await reader.read();
      checkCancelled(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw problem('OVER_BUDGET', '文件体积超过剩余内存预算');
      chunks.push(value);
    }
    const encoding = response.headers.get('content-encoding') || '';
    if (length && /^\d+$/.test(length) && (!encoding || /^identity$/i.test(encoding)) && size !== Number(length)) throw problem('SIZE_MISMATCH', '实际读取长度与服务器声明不一致，文件可能截断');
    complete = true;
    if (chunks.length === 1) return chunks[0];
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (!complete) cancel();
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
function checkResponse(response) {
  if ([0, 401, 403].includes(response.status) || response.type === 'opaqueredirect') throw problem('LOGIN_REQUIRED', '登录失效或无访问权限，请在教学平台确认后重试');
  if (!response.ok) throw problem('HTTP_ERROR', '请求失败 HTTP ' + response.status);
}
export async function readSchoolPage(value, { fetchImpl = globalThis.fetch, signal, courseId, timeoutMs } = {}) {
  const url = pageUrl(value, { courseId });
  return requestTask(async requestSignal => {
    const response = await fetchImpl(url.href, { credentials: 'same-origin', mode: 'same-origin', redirect: 'follow', signal: requestSignal });
    try {
      checkResponse(response);
      let final;
      try { final = pageUrl(response.url || url.href, { courseId }); }
      catch (error) {
        if (error.code === 'WRONG_COURSE') throw error;
        let target;
        try { target = schoolUrl(response.url || url.href); } catch { throw problem('LOGIN_REQUIRED', '页面已跳转到身份认证页面，请重新登录'); }
        if (target.origin !== url.origin || /\/(?:login|logon|signin|sso|cas|auth)(?:[/.;]|$)/i.test(target.pathname)) throw problem('LOGIN_REQUIRED', '页面已跳转到登录页，请重新登录后扫描');
        throw problem('UNSUPPORTED_PAGE', '该栏目打开的不是支持的课程页面，请在平台打开目标单元后扫描');
      }
      if (final.origin !== url.origin) throw problem('LOGIN_REQUIRED', '页面已离开当前登录会话');
      const type = response.headers.get('content-type') || '';
      if (type && !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(type)) throw problem('BAD_PAGE', '服务器未返回课程页面');
      const bytes = await readBoundedBody(response, { maxBytes: 4 * 1024 * 1024, signal: requestSignal });
      const declared = type.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
      const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
      const charset = declared || sniff.match(/charset\s*=\s*["']?([^;"'\s/>]+)/i)?.[1] || 'gbk';
      let html;
      try { html = new TextDecoder(charset).decode(bytes); } catch { throw problem('BAD_ENCODING', '页面编码不受支持：' + charset); }
      if (/<title[^>]*>[^<]*(?:登录|登陆|统一身份认证|sign\s*in|log\s*in)/i.test(html) || /<input\b[^>]*type\s*=\s*["']?password\b/i.test(html)) throw problem('LOGIN_REQUIRED', '登录已失效，请重新登录教学平台');
      return { html, url: final.href };
    } finally {
      if (!response.body?.locked) void response.body?.cancel().catch(() => {});
    }
  }, { signal, timeoutMs });
}
export function assertFileContent(bytes, file, contentType = '', disposition = '', options = {}) {
  return inspectFileContent(bytes, file, { contentType, disposition, ...options });
}
function assertResourceResponse(response, identity) {
  checkResponse(response);
  if (response.redirected || !matchesFileUrl(identity, response.url || identity.downloadUrl)) throw problem('BAD_FILE', '下载已跳转，不是所选文件');
}
function withPreviewWarning(inspection, file) {
  return file.downloadKind === 'preview' ? { ...inspection, warnings: [{ code: 'PREVIEW_COPY', message: previewNotice(file) }, ...(inspection.warnings || [])] } : inspection;
}
async function fetchPreviewImage(value, file, { fetchImpl, signal, maxBytes }) {
  const url = previewAssetUrl(value, file, { kind: 'image' });
  const response = await fetchImpl(url.href, { credentials: 'include', redirect: 'error', cache: 'no-store', signal });
  try {
    checkResponse(response);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) throw problem('BAD_FILE', '预览图片已跳转或未返回完整内容');
    return { bytes: await readBoundedBody(response, { maxBytes, signal }), contentType: response.headers.get('content-type') || '' };
  } finally { if (!response.body?.locked) void response.body?.cancel().catch(() => {}); }
}
export async function fetchFileBytes(file, { fetchImpl = globalThis.fetch, maxBytes = 200 * 1024 * 1024, signal, timeoutMs, onInspection = () => {}, onProgress = () => {} } = {}) {
  const identity = validateFile(file);
  if (isGeneratedPreview(identity)) return requestTask(async requestSignal => {
    const bytes = await renderPreviewBytes(identity, { maxBytes, signal: requestSignal, onProgress,
      loadAsset: (url, budget) => fetchPreviewImage(url, identity, { fetchImpl, signal: requestSignal, maxBytes: budget }) });
    onInspection(withPreviewWarning(inspectFileContent(bytes, identity, { complete: true, contentType: identity.ext === 'pdf' ? 'application/pdf' : identity.ext === 'html' ? 'text/html' : 'text/plain', disposition: 'attachment' }), identity));
    return bytes;
  }, { signal, timeoutMs: timeoutMs ?? 180000 });
  return requestTask(async requestSignal => {
    const response = await fetchImpl(identity.downloadUrl, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: requestSignal });
    try {
      assertResourceResponse(response, identity);
      if (response.status !== 200) throw problem('BAD_FILE', '服务器未返回完整原文件（HTTP ' + response.status + '）');
      const info = responseHeaders(response, file);
      const bytes = await readBoundedBody(response, { maxBytes, signal: requestSignal });
      assertExactMetadataSize(file, bytes.length);
      const inspection = inspectFileContent(bytes, file, { ...info, complete: true });
      if (info.mimeCorrected) inspection.warnings = [...(inspection.warnings || []), { code: 'PREVIEW_STREAM_MIME', message: '平台将资源流误标为 PDF；已按完整 ' + identity.ext.toUpperCase() + ' 内容校验并保留原始字节' }];
      onInspection(withPreviewWarning(inspection, identity));
      return bytes;
    } finally {
      if (!response.body?.locked) void response.body?.cancel().catch(() => {});
    }
  }, { signal, timeoutMs: timeoutMs ?? 60000 });
}
export const PROBE_BYTES = 64 * 1024;
/** Ordinary direct files use a bounded sample; prepared sources are fully read and verified once. */
export async function preflightFile(file, { fetchImpl = globalThis.fetch, signal, timeoutMs, includeBytes = false, onProgress = () => {} } = {}) {
  const identity = validateFile(file);
  if (requiresPreparedDownload(identity)) {
    let inspection;
    const bytes = await fetchFileBytes(identity, { fetchImpl, signal, timeoutMs, onProgress, onInspection: value => { inspection = value; } });
    return { ...(includeBytes ? { bytes } : {}), expectedFileBytes: bytes.length, expectedBytes: bytes.length, sampleBytes: bytes.length, sampleComplete: true,
      requiresLocalDownload: true, responseName: '', contentType: isPreviewSource(identity) ? 'application/octet-stream' : identity.ext === 'pdf' ? 'application/pdf' : identity.ext === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8', etag: '', ...inspection };
  }
  return requestTask(async requestSignal => {
    const response = await fetchImpl(identity.downloadUrl, { credentials: 'include', redirect: 'error', cache: 'no-store', headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) }, signal: requestSignal });
    let reader;
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener('abort', cancel, { once: true });
    try {
      assertResourceResponse(response, identity);
      const info = responseHeaders(response, file);
      let expectedBytes = info.identityEncoding ? info.contentLength : null, rangeLength = null;
      if (response.status === 206) {
        const range = (response.headers.get('content-range') || '').match(/^bytes 0-(\d+)\/(\d+)$/);
        if (!range || !info.identityEncoding) throw problem('BAD_FILE', '服务器返回的分段文件范围无法核对');
        const end = Number(range[1]), total = Number(range[2]);
        if (!Number.isSafeInteger(total) || end < 0 || end >= PROBE_BYTES || total <= end) throw problem('BAD_FILE', '服务器返回了错误的文件片段');
        rangeLength = end + 1; expectedBytes = total;
        if (info.contentLength != null && info.contentLength !== rangeLength) throw problem('SIZE_MISMATCH', '文件分段长度声明不一致');
      } else if (response.status !== 200) throw problem('BAD_FILE', '服务器未返回原文件（HTTP ' + response.status + '）');
      assertExactMetadataSize(file, expectedBytes);
      if (!response.body?.getReader) throw problem('NO_BODY', '无法读取原文件');
      reader = response.body.getReader();
      const chunks = []; let size = 0, done = false, truncated = false;
      while (size < PROBE_BYTES) {
        const result = await reader.read();
        checkCancelled(requestSignal);
        if (result.done) { done = true; break; }
        const value = result.value;
        if (rangeLength != null && size + value.length > rangeLength) throw problem('SIZE_MISMATCH', '文件分段的实际长度超过声明');
        if (info.identityEncoding && info.contentLength != null && size + value.length > info.contentLength) throw problem('SIZE_MISMATCH', '响应内容超出服务器声明长度');
        const part = value.subarray(0, PROBE_BYTES - size); chunks.push(part); size += part.length;
        if (part.length < value.length) truncated = true;
      }
      if ((rangeLength != null && size !== rangeLength) || (done && info.identityEncoding && info.contentLength != null && size !== info.contentLength)) throw problem('SIZE_MISMATCH', '实际读取长度与服务器声明不一致，文件可能截断');
      const complete = !truncated && ((done && response.status === 200) || (expectedBytes != null && size === expectedBytes));
      if (complete && expectedBytes == null && info.identityEncoding) expectedBytes = size;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
      const inspection = withPreviewWarning(inspectFileContent(bytes, file, { ...info, complete }), identity);
      if (complete) assertExactMetadataSize(file, size);
      const expectedFileBytes = complete ? size : file.sizeExact === true ? file.sizeBytes : expectedBytes;
      return { ...(includeBytes && complete ? { bytes } : {}), expectedFileBytes, expectedBytes, responseName: info.responseName, contentType: info.contentType, etag: info.etag,
        sampleBytes: size, sampleComplete: complete, format: inspection.format, level: inspection.level, warnings: inspection.warnings || [] };
    } finally {
      requestSignal.removeEventListener('abort', cancel);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else void response.body?.cancel().catch(() => {});
    }
  }, { signal, timeoutMs: timeoutMs ?? 15000 });
}
