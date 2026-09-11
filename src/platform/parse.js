import { AppError, ORIGIN, PATHS, pathWithoutSession, schoolUrl, numericParam, normalizeResourceUrl, extensionOf, FORMATS } from './policy.js';

function isUnavailable(element) {
  for (let node = element; node; node = node.parentElement) {
    if (['hidden', 'inert', 'disabled'].some(name => node.hasAttribute(name)) ||
        ['aria-hidden', 'aria-disabled'].some(name => node.getAttribute(name)?.trim().toLowerCase() === 'true') ||
        node.style?.display.toLowerCase() === 'none' ||
        ['hidden', 'collapse'].includes(node.style?.visibility.toLowerCase())) return true;
  }
  return false;
}

export function parseDirectory(document, pageUrl) {
  let url, courseId, folderId;
  try {
    url = schoolUrl(pageUrl);
    if (pathWithoutSession(url.pathname) !== PATHS.list) return null;
    courseId = numericParam(url, 'lid');
    folderId = numericParam(url, 'folderid', true);
  } catch { return null; }
  const unique = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isUnavailable(anchor)) continue;
    try {
      const parsed = normalizeResourceUrl(anchor.getAttribute('href'), 'preview', pageUrl);
      if (parsed.courseId !== courseId || unique.has(parsed.id)) continue;
      unique.set(parsed.id, {
        id: parsed.id, courseId, resId: parsed.resId, fileId: parsed.fileId,
        previewUrl: parsed.url, title: anchor.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) || '未命名资源',
      });
    } catch { /* Folder links, controls and unrelated URLs are not resources. */ }
  }
  const resources = [...unique.values()];
  const cleanUrl = new URL(PATHS.list, ORIGIN);
  cleanUrl.search = new URLSearchParams({ lid: courseId, folderid: folderId }).toString();
  return { courseId, folderId, url: cleanUrl.href,
    key: `${courseId}/${folderId}|${resources.map(r => r.id).join(',')}`, resources };
}

export function parsePreview(document, resource) {
  const identity = normalizeResourceUrl(resource.previewUrl, 'preview');
  if (identity.id !== resource.id) throw new AppError('INVALID_RESOURCE', '课件标识不匹配');
  if (/登录|登陆|统一身份认证|sign\s*in|log\s*in/i.test(document.title)) {
    throw new AppError('LOGIN_REQUIRED', '登录已失效，请在教学平台重新登录后扫描');
  }
  const heading = [...document.querySelectorAll('h2')].find(node => /文件名\s*[:：]/.test(node.textContent));
  if (!heading) throw new AppError('NO_DOWNLOAD', '无法识别课件信息，请确认登录状态和页面下载权限');
  const copy = heading.cloneNode(true);
  for (const element of copy.querySelectorAll('a,script,style,iframe')) element.remove();
  let name = copy.textContent.split(/文件名\s*[:：]/).slice(1).join('文件名:').trim();
  const size = name.match(/[（(]\s*(\d+(?:\.\d+)?\s*(?:[kmgt](?:i?b)?|b|字节))\s*[）)]\s*$/i);
  const sizeText = size ? size[1].replace(/\s+/g, '') : '大小未知';
  if (size) name = name.slice(0, size.index).trim();
  name = name.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const extension = extensionOf(name);
  if (!FORMATS.has(extension)) throw new AppError('UNSUPPORTED_TYPE', '不是 PDF、PPT 或 PPTX，已跳过');
  let downloadUrl;
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isUnavailable(anchor)) continue;
    try {
      const download = normalizeResourceUrl(anchor.getAttribute('href'), 'download', resource.previewUrl);
      if (download.id === identity.id) { downloadUrl = download.url; break; }
    } catch { /* Never manufacture a missing download endpoint. */ }
  }
  if (!downloadUrl) throw new AppError('NO_DOWNLOAD', '该课件没有可用的原文件下载入口');
  return { ...resource, previewUrl: identity.url, name, extension, sizeText, downloadUrl };
}

export function courseTitle(title) {
  const match = String(title || '').match(/^网络课程\s*[—–-]\s*(.+)$/);
  return match?.[1].trim().slice(0, 200) || '课件';
}
