import { AppError, validateFile, normalizeResourceUrl, isUnsafeMime } from '../platform/policy.js';
import { hasFileSignature, readBodySample } from '../platform/file-content.js';
import { withDeadline } from '../platform/network.js';

export async function preflight(input, { fetcher = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const file = validateFile(input);
  try {
    return await withDeadline(async signal => {
      // THEOL rejects HEAD. A bounded GET also lets us reject disguised login HTML.
      const response = await fetcher(file.downloadUrl, { method: 'GET', credentials: 'include', redirect: 'manual',
        headers: { Range: 'bytes=0-1023' }, signal });
      if (response.type === 'opaqueredirect' || response.status === 0 || response.redirected || response.status === 401) {
        throw new AppError('LOGIN_REQUIRED', '登录已失效或资源跳转，请重新登录后重试');
      }
      if (!response.ok) throw new AppError('NO_DOWNLOAD', '服务器拒绝下载，请确认登录状态和课件权限');
      if (response.url && normalizeResourceUrl(response.url, 'download').id !== file.id) throw new AppError('BAD_FILE', '下载响应与所选课件不匹配');
      const mime = response.headers.get('content-type') || '';
      if (isUnsafeMime(mime)) throw new AppError('BAD_FILE', '平台返回了网页而非课件，请重新登录或确认下载权限');
      if (!response.body) throw new AppError('BAD_FILE', '平台返回了空文件');
      const sample = await readBodySample(response, { maxBytes: 1024, signal });
      if (!hasFileSignature(sample, file.extension)) throw new AppError('BAD_FILE', '文件内容与格式不符，已停止下载；请在平台确认原文件');
      return { mime: mime.split(';')[0].trim() };
    }, { timeoutMs });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('NETWORK', '下载前校验失败，请检查网络或重新登录后重试');
  }
}
