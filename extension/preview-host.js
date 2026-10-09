import { problem } from '../src/runtime/policy.js';

export function createPreviewHost(chrome) {
  let creating;
  async function exists() { return !!chrome.offscreen && await chrome.offscreen.hasDocument(); }
  async function ensure() {
    if (!chrome.offscreen) throw problem('PREVIEW_UNAVAILABLE', '请更新 Chrome 并重新加载扩展，以准备本地下载文件');
    if (await exists()) return;
    if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'],
      justification: '在本机校验用户选中的原格式资源流或生成预览副本，并持有临时 Blob 下载地址' }).finally(() => { creating = null; });
    await creating;
  }
  return {
    async prepare(file, { jobId }) {
      await ensure();
      const result = await chrome.runtime.sendMessage({ target: 'course-preview-host', type: 'PREPARE_PREVIEW', jobId, file });
      if (!result?.ok) throw problem(result?.code || 'PREVIEW_FAILED', result?.error || '文件准备或校验失败，请重试');
      if (!result.inspection?.blobUrl?.startsWith('blob:' + chrome.runtime.getURL(''))) throw problem('BAD_FILE', '本地下载文件地址无效');
      return result.inspection;
    },
    async release(jobId) {
      if (await exists()) await chrome.runtime.sendMessage({ target: 'course-preview-host', type: 'RELEASE_PREVIEW', jobId });
    },
    async close() { if (await exists()) await chrome.offscreen.closeDocument(); },
  };
}
