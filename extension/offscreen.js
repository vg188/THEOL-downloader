import { validateFile, requiresPreparedDownload, problem } from '../src/runtime/policy.js';
import { preflightFile } from '../src/runtime/network.js';

// Blob lifetimes belong to this hidden extension document, not the panel or service worker.
const tasks = new Map(); let tail = Promise.resolve();
function prepare(message) {
  const file = validateFile(message.file);
  if (!requiresPreparedDownload(file) || typeof message.jobId !== 'string' || !message.jobId || message.jobId.length > 100) throw problem('INVALID_FILE', '无效的本地文件准备任务');
  if (tasks.has(message.jobId)) return tasks.get(message.jobId).promise;
  const task = { controller: new AbortController(), blobUrl: '' };
  task.promise = tail.then(async () => {
    const { bytes, ...inspection } = await preflightFile(file, { signal: task.controller.signal, includeBytes: true });
    if (task.controller.signal.aborted) throw problem('CANCELLED', '操作已取消');
    task.blobUrl = URL.createObjectURL(new Blob([bytes], { type: inspection.contentType }));
    return { ...inspection, blobUrl: task.blobUrl };
  }).catch(error => { tasks.delete(message.jobId); throw error; });
  tail = task.promise.catch(() => {}); tasks.set(message.jobId, task);
  return task.promise;
}
function release(jobId) {
  const task = tasks.get(jobId); if (!task) return;
  task.controller.abort(); if (task.blobUrl) URL.revokeObjectURL(task.blobUrl); tasks.delete(jobId);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'course-preview-host') return false;
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url && sender.url !== chrome.runtime.getURL('background.js')) {
    respond({ ok: false, code: 'FORBIDDEN', error: '只有扩展后台可以准备下载文件' }); return false;
  }
  if (message.type === 'RELEASE_PREVIEW') { release(message.jobId); respond({ ok: true }); return false; }
  if (message.type !== 'PREPARE_PREVIEW') return false;
  Promise.resolve().then(() => prepare(message)).then(inspection => respond({ ok: true, inspection }), error => respond({ ok: false, code: error.code || 'PREVIEW_FAILED', error: error.message }));
  return true;
});
