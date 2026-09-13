// Reads one courseware file with the page's own session. The decisions match
// src/background/preflight.js (redirect/login detection, MIME and signature checks,
// response/selection identity), but bytes are streamed to the caller instead of
// being discarded, so the archive never holds a second copy of a file. No `chrome.*`.
import { AppError, isUnsafeMime, normalizeResourceUrl, validateFile } from '../platform/policy.js';
import { hasFileSignature } from '../platform/file-content.js';
import { ZIP_LIMIT_BYTES } from './download-plan.js';

// Longest signature this module verifies is the 8-byte OLE header. Waiting for the
// whole window (rather than for the bytes the regex happened to need) keeps a valid
// file from being rejected just because its first chunk was short.
// The shared `readBodySample` is deliberately not reused here: it cancels the
// response tail once the sample is taken, which is right for preflight but would
// throw away the very bytes this module has to stream.
const SIGNATURE_BYTES = 1024;
const SIGNATURE_MINIMUM = 8;

export class ActualSizeLimitError extends AppError {
  constructor() {
    super('ACTUAL_SIZE_LIMIT', '课程实际大小超过 500 MB 上限，已停止打包，请重新确认下载方式');
    this.name = 'ActualSizeLimitError';
  }
}

// A caller's own failure (for example the archive's size limit or a cancelled
// worker) must reach the caller unchanged; only transport failures become NETWORK.
class ConsumerError extends Error {
  constructor(cause) {
    super('the chunk consumer failed');
    this.cause = cause;
  }
}

// `limitBytes` is the archive's remaining budget, not a per-file quota: the caller
// passes what is left of the 500 MiB ZIP ceiling so the total cannot be exceeded.
export async function fetchCourseFile(file, {
  fetcher = globalThis.fetch,
  signal,
  onChunk = () => {},
  limitBytes = ZIP_LIMIT_BYTES,
} = {}) {
  // Validation runs before any request: the canonical download URL and the matching
  // identifiers are the only thing this module is allowed to ask the platform for.
  const target = validateFile(file);
  if (signal?.aborted) throw new AppError('CANCELLED', '归档已取消');
  try {
    const response = await fetcher(target.downloadUrl, {
      method: 'GET', credentials: 'include', redirect: 'manual', signal,
    });
    assertDownloadable(response, target);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
    const declared = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(declared) && declared > limitBytes) throw new ActualSizeLimitError();
    return await streamBody(response.body, { target, mime, signal, onChunk, limitBytes });
  } catch (error) {
    if (error instanceof ConsumerError) throw error.cause;
    // ActualSizeLimitError is an AppError, so a policy decision is never rewritten
    // into a network failure by this handler.
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw new AppError('CANCELLED', '归档已取消');
    throw new AppError('NETWORK', '读取课件失败，请检查网络或重新登录后重试');
  }
}

function assertDownloadable(response, target) {
  if (response.type === 'opaqueredirect' || response.status === 0 || response.redirected || response.status === 401) {
    throw new AppError('LOGIN_REQUIRED', '登录已失效或资源跳转，请重新登录后重试');
  }
  if (!response.ok) throw new AppError('NO_DOWNLOAD', '服务器拒绝下载，请确认登录状态和课件权限');
  if (response.url && responseIdentity(response.url) !== target.id) {
    throw new AppError('BAD_FILE', '下载响应与所选课件不匹配');
  }
  if (isUnsafeMime(response.headers.get('content-type') || '')) {
    throw new AppError('BAD_FILE', '平台返回了网页而非课件，请重新登录或确认下载权限');
  }
  if (!response.body) throw new AppError('BAD_FILE', '平台返回了空文件');
}

function responseIdentity(url) {
  try { return normalizeResourceUrl(url, 'download').id; } catch { return null; }
}

async function streamBody(body, { target, mime, signal, onChunk, limitBytes }) {
  const reader = body.getReader();
  const sample = new Uint8Array(SIGNATURE_BYTES);
  let sampleLength = 0;
  let verified = false;
  let bytes = 0;
  // Only the signature window is held back; everything else is handed on as it
  // arrives, so a 500 MiB file never accumulates in the page.
  const forward = chunk => {
    if (bytes + chunk.byteLength > limitBytes) throw new ActualSizeLimitError();
    bytes += chunk.byteLength;
    try {
      onChunk(chunk);
    } catch (error) {
      throw new ConsumerError(error);
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new AppError('CANCELLED', '归档已取消');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      let rest = value;
      if (!verified) {
        const held = value.subarray(0, Math.min(SIGNATURE_BYTES - sampleLength, value.byteLength));
        sample.set(held, sampleLength);
        sampleLength += held.byteLength;
        rest = value.subarray(held.byteLength);
        if (sampleLength >= SIGNATURE_MINIMUM) {
          verified = true;
          verifySignature(sample.subarray(0, sampleLength), target.extension);
          // A private copy, so callers may hand the chunk to a worker unchanged.
          forward(sample.subarray(0, sampleLength).slice());
        }
      }
      if (rest.byteLength) forward(rest);
    }
    if (!verified) verifySignature(sample.subarray(0, sampleLength), target.extension);
    return { id: target.id, name: target.name, mime, bytes };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function verifySignature(sample, extension) {
  if (!hasFileSignature(sample, extension)) {
    throw new AppError('BAD_FILE', '文件内容与格式不符，已停止下载；请在平台确认原文件');
  }
}
