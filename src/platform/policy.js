export const ORIGIN = 'https://course.buct.edu.cn';
export const PATHS = Object.freeze({
  list: '/meol/common/script/listview.jsp',
  preview: '/meol/common/script/preview/download_preview.jsp',
  download: '/meol/common/script/download.jsp',
});
export const FORMATS = new Set(['pdf', 'ppt', 'pptx']);

export class AppError extends Error {
  constructor(code, message) { super(message); this.name = 'AppError'; this.code = code; }
}
export function errorResult(error) {
  return { code: error instanceof AppError ? error.code : 'NETWORK',
    message: error instanceof AppError ? error.message : '操作未完成，请检查网络或重新登录后重试' };
}
export function pathWithoutSession(path) {
  return path.replace(/;jsessionid=[^/;]*$/i, '');
}
export function schoolUrl(value, base = ORIGIN) {
  if ((typeof value !== 'string' && !(value instanceof URL)) || !String(value).trim()) {
    throw new AppError('INVALID_URL', '资源链接无效');
  }
  let url;
  try { url = new URL(value, base); } catch { throw new AppError('INVALID_URL', '资源链接无效'); }
  if (url.origin !== ORIGIN || url.username || url.password) {
    throw new AppError('INVALID_URL', '只支持学校教学平台上的资源');
  }
  return url;
}
export function numericParam(url, key, allowZero = false) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !(allowZero ? /^(0|[1-9]\d{0,11})$/ : /^[1-9]\d{0,11}$/).test(values[0])) {
    throw new AppError('INVALID_RESOURCE', '课程或文件标识无效');
  }
  return values[0];
}

export function isUnavailable(element) {
  for (let node = element; node; node = node.parentElement) {
    if (['hidden', 'inert', 'disabled'].some(name => node.hasAttribute(name)) ||
        ['aria-hidden', 'aria-disabled'].some(name => node.getAttribute(name)?.trim().toLowerCase() === 'true') ||
        node.style?.display.toLowerCase() === 'none' ||
        ['hidden', 'collapse'].includes(node.style?.visibility.toLowerCase())) return true;
  }
  return false;
}
export function normalizeResourceUrl(input, kind, base = ORIGIN) {
  const url = schoolUrl(input, base);
  if (!['preview', 'download'].includes(kind) || pathWithoutSession(url.pathname) !== PATHS[kind]) {
    throw new AppError('INVALID_URL', '不是支持的课件资源链接');
  }
  const fileId = numericParam(url, 'fileid');
  const resId = numericParam(url, 'resid');
  const courseId = numericParam(url, 'lid');
  const canonical = new URL(PATHS[kind], ORIGIN);
  for (const [key, value] of [['fileid', fileId], ['resid', resId], ['lid', courseId]]) canonical.searchParams.set(key, value);
  return { id: `${courseId}:${resId}:${fileId}`, fileId, resId, courseId, url: canonical.href };
}
export function extensionOf(name) {
  return typeof name === 'string' ? name.trim().match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() : undefined;
}
export function validateFile(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 1000) {
    throw new AppError('INVALID_RESOURCE', '文件名无效');
  }
  const preview = normalizeResourceUrl(value.previewUrl, 'preview');
  const download = normalizeResourceUrl(value.downloadUrl, 'download');
  if (preview.id !== download.id || value.id !== preview.id || value.courseId !== preview.courseId ||
      value.resId !== preview.resId || value.fileId !== preview.fileId) {
    throw new AppError('INVALID_RESOURCE', '下载链接与课件不匹配');
  }
  const extension = extensionOf(value.name);
  if (!FORMATS.has(extension) || extension !== value.extension) {
    throw new AppError('UNSUPPORTED_TYPE', '不是 PDF、PPT 或 PPTX，已跳过');
  }
  return {
    id: preview.id, courseId: preview.courseId, resId: preview.resId, fileId: preview.fileId,
    previewUrl: preview.url, downloadUrl: download.url,
    title: String(value.title || value.name).slice(0, 300), name: value.name.trim(), extension,
    sizeText: typeof value.sizeText === 'string' && value.sizeText ? value.sizeText.slice(0, 40) : '大小未知',
    courseName: typeof value.courseName === 'string' && value.courseName.trim() ? value.courseName.trim().slice(0, 200) : '课件',
  };
}
function truncateUtf16(value, maxLength) {
  const result = value.slice(0, maxLength);
  return /[\ud800-\udbff]$/.test(result) ? result.slice(0, -1) : result;
}
function cleanSegment(value, fallback, maxLength) {
  let result = String(value || '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  // Truncation can expose a trailing dot/space or turn a long name into CON.
  result = truncateUtf16(result, maxLength).replace(/[. ]+$/g, '');
  if (!result) return fallback;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(result)) {
    result = '_' + truncateUtf16(result, maxLength - 1).replace(/[. ]+$/g, '');
  }
  return result;
}
export function buildFilename(courseName, name) {
  const extension = extensionOf(name);
  if (!FORMATS.has(extension)) throw new AppError('UNSUPPORTED_TYPE', '不支持的文件格式');
  const originalSuffix = name.trim().slice(-(extension.length + 1));
  const stem = name.trim().slice(0, -(extension.length + 1));
  const folder = cleanSegment(courseName, '课件', 48);
  const filename = cleanSegment(stem, '课件', 115) + originalSuffix;
  return `${folder}/${filename}`;
}
export function isUnsafeMime(mime = '') {
  return /^(text\/html|application\/(xhtml\+xml|json|problem\+json))(?:;|$)/i.test(mime.trim());
}
