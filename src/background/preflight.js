import { AppError, validateFile, normalizeResourceUrl, isUnsafeMime } from '../platform/policy.js';
import { withDeadline } from '../platform/network.js';

function hasSignature(bytes, extension) {
  if (extension === 'pdf') return new TextDecoder('latin1').decode(bytes).includes('%PDF-');
  const signature = extension === 'ppt' ? [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1] : [0x50,0x4b,0x03,0x04];
  return signature.every((value,index) => bytes[index] === value);
}
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
      const reader = response.body.getReader();
      const abortReader = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abortReader, { once: true });
      const sample = new Uint8Array(1024); let length = 0;
      try {
        while (length < sample.length) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) { const chunk = value.subarray(0, sample.length-length); sample.set(chunk,length); length += chunk.length; }
        }
      } finally {
        signal.removeEventListener('abort', abortReader);
        await reader.cancel().catch(() => {});
      }
      if (!hasSignature(sample.subarray(0,length), file.extension)) throw new AppError('BAD_FILE', '文件内容与格式不符，已停止下载；请在平台确认原文件');
      return { mime: mime.split(';')[0].trim() };
    }, { timeoutMs });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('NETWORK', '下载前校验失败，请检查网络或重新登录后重试');
  }
}
