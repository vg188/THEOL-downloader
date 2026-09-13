import { AppError, errorResult, validateFile, buildFilename } from '../platform/policy.js';

export const DIRECT_DOWNLOAD_CAUTION = 'Chrome 可能要求允许此网站下载多个文件；‘已触发’不代表文件已保存完成。';
export const DIRECT_DOWNLOAD_DELAY_MS = 400;

// The extension saves into a course folder, but an anchor download name cannot carry a path.
function safeDownloadName(file) {
  const path = buildFilename(file.courseName, file.name);
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, ms);
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/**
 * Requests one browser download per file. "Triggered" only means the click was
 * dispatched: a bookmarklet cannot observe whether Chrome finished saving.
 */
export async function downloadDirect(files, {
  document: pageDocument = globalThis.document, signal, delayMs = DIRECT_DOWNLOAD_DELAY_MS, onProgress = async () => {},
} = {}) {
  if (signal?.aborted) throw new AppError('CANCELLED', '下载已取消');
  const pending = [];
  const failed = [];
  // Validate the whole selection before the first click so a stale or hostile
  // entry can never ride along behind an already-triggered download.
  for (const value of Array.isArray(files) ? files : []) {
    try {
      const file = validateFile(value);
      pending.push({ file, downloadName: safeDownloadName(file) });
    } catch (error) {
      failed.push({ id: value?.id, title: value?.title || value?.name || '未命名资源', ...errorResult(error) });
    }
  }
  const triggered = [];
  const total = pending.length;
  const result = { triggered, failed, caution: DIRECT_DOWNLOAD_CAUTION };
  if (!total) return result;
  if (typeof pageDocument?.createElement !== 'function') throw new AppError('NETWORK', '页面环境不可用，无法触发下载');
  const root = pageDocument.body || pageDocument.documentElement;
  for (let index = 0; index < total; index++) {
    if (index) await delay(delayMs, signal);
    if (signal?.aborted) throw new AppError('CANCELLED', '下载已取消');
    const { file, downloadName } = pending[index];
    let anchor;
    let clicked = false;
    try {
      anchor = pageDocument.createElement('a');
      anchor.href = file.downloadUrl;
      anchor.download = downloadName;
      anchor.rel = 'noopener';
      anchor.hidden = true;
      root?.append(anchor);
      anchor.click();
      triggered.push({ id: file.id, name: file.name });
      clicked = true;
    } catch (error) {
      failed.push({ id: file.id, title: file.title, ...errorResult(error) });
    } finally {
      anchor?.remove?.();
    }
    if (clicked) {
      await onProgress({
        kind: 'progress', name: file.name, triggered: triggered.length, total,
        message: `已触发 ${triggered.length}/${total}`,
      });
    }
  }
  return result;
}
