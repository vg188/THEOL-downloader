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
