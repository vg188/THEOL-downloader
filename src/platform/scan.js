import { AppError, errorResult, schoolUrl, normalizeResourceUrl } from './policy.js';
import { parsePreview } from './parse.js';
import { withDeadline } from './network.js';

export async function scanResources(resources, {
  fetcher = globalThis.fetch, parseDocument, onProgress = async () => {}, signal, timeoutMs = 15000,
} = {}) {
  const result = { processed: 0, total: resources.length, skipped: 0, files: [], failures: [] };
  let next = 0;
  async function worker() {
    while (next < resources.length) {
      if (signal?.aborted) throw new AppError('CANCELLED', '页面扫描已取消');
      const resource = resources[next++];
      let event;
      try {
        const file = await withDeadline(async requestSignal => {
          const response = await fetcher(resource.previewUrl, { credentials: 'include', redirect: 'manual', signal: requestSignal });
          if (response.type === 'opaqueredirect' || response.status === 0 || response.redirected || response.status === 401) {
            throw new AppError('LOGIN_REQUIRED', '登录已失效或页面发生跳转，请重新登录后扫描');
          }
          if (!response.ok) throw new AppError('NO_DOWNLOAD', '资源无法访问，请确认登录状态和下载权限');
          if (response.url) {
            schoolUrl(response.url);
            if (normalizeResourceUrl(response.url, 'preview').id !== resource.id) throw new AppError('INVALID_RESOURCE', '预览页与课件不匹配');
          }
          const type = response.headers.get('content-type') || '';
          if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new AppError('NO_DOWNLOAD', '平台未返回可识别的课件预览页');
          // Response.text() always uses UTF-8, but THEOL serves GBK preview pages.
          const charset = type.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
          let decoder;
          try { decoder = new TextDecoder(charset); }
          catch { throw new AppError('BAD_FILE', '预览页的字符编码不受支持，请在平台确认该资源'); }
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > 2 * 1024 * 1024) throw new AppError('BAD_FILE', '预览页内容异常，请在平台确认该资源');
          const html = decoder.decode(bytes);
          return parsePreview(parseDocument(html), resource);
        }, { timeoutMs, signal });
        result.files.push(file); event = { file };
      } catch (error) {
        const failure = { id: resource.id, title: resource.title, ...errorResult(error) };
        if (failure.code === 'UNSUPPORTED_TYPE') { result.skipped++; event = { skipped: { id: resource.id } }; }
        else { result.failures.push(failure); event = { failure }; }
      }
      result.processed++;
      await onProgress({ kind: 'progress', ...event, processed: result.processed, total: result.total });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, resources.length) }, worker));
  return result;
}
