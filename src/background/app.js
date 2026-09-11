import { AppError } from '../platform/policy.js';

export function createRouter({ chrome, queue, bridge }) {
  return async function route(message, sender) {
    if (!message || typeof message.type !== 'string') throw new AppError('INVALID_MESSAGE', '扩展请求格式无效');
    if (message.type === 'SCAN_EVENT') return bridge.receive(message, sender);
    if (sender.id !== chrome.runtime.id || String(sender.url || '').split(/[?#]/)[0] !== chrome.runtime.getURL('popup.html')) {
      throw new AppError('INVALID_MESSAGE', '只接受扩展面板发起的操作');
    }
    switch (message.type) {
      case 'GET_STATE': {
        const jobs = await queue.refresh();
        return { ...await bridge.getState(message.tabId, message.checkContext !== false), queue: jobs };
      }
      case 'START_SCAN': return bridge.start(message.tabId);
      case 'DOWNLOAD_SELECTED': {
        if (!Array.isArray(message.ids) || !message.ids.length || message.ids.some(id => typeof id !== 'string')) {
          throw new AppError('INVALID_MESSAGE', '请先勾选课件');
        }
        const scan = await bridge.assertCurrent(message.tabId, message.scanId);
        const files = [...new Set(message.ids)].map(id => scan.files.find(file => file.id === id));
        if (files.some(file => !file)) throw new AppError('INVALID_MESSAGE', '选择包含不属于本次扫描的文件，请重新扫描');
        return queue.enqueue(files, message.requestId);
      }
      case 'RETRY_FAILED': return queue.retry(message.ids);
      case 'SHOW_DOWNLOAD': {
        const job = (await queue.getState()).jobs.find(job => job.id === message.id);
        if (!job || job.status !== 'complete' || !Number.isInteger(job.downloadId)) throw new AppError('INVALID_MESSAGE', '文件尚未下载完成');
        await chrome.downloads.show(job.downloadId); return null;
      }
      default: throw new AppError('INVALID_MESSAGE', '不支持的扩展操作');
    }
  };
}
