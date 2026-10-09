import { displayName, trimWhitespace, extOf, groupOf, resourceUrl, schoolUrl, numericParam, problem } from './policy.js';

export const missingDownloadReason = '平台未提供原文件下载入口（仅预览）';
export function parseFileHeading(document) {
  const heading = [...document.querySelectorAll('h1,h2,h3')].find(node => /文件名\s*[:：]/.test(node.textContent));
  if (!heading) return null;
  const copy = heading.cloneNode(true);
  for (const node of copy.querySelectorAll('a,button,script,style')) node.remove();
  let name = trimWhitespace(copy.textContent.replace(/^.*?文件名\s*[:：]/s, ''));
  const size = name.match(/[（(]\s*(\d+(?:\.\d+)?)\s*(B|字节|[KMGT](?:I?B)?)\s*[）)]\s*$/i);
  let sizeBytes = null;
  if (size) {
    sizeBytes = Number(size[1]) * 1024 ** ({ K: 1, M: 2, G: 3, T: 4 }[size[2][0].toUpperCase()] || 0);
    name = trimWhitespace(name.slice(0, size.index));
  }
  name = trimWhitespace(name).normalize('NFC');
  const ext = extOf(name);
  if (!ext) throw problem('BAD_METADATA', '无法确认原文件格式');
  return { name, ext, group: groupOf(ext), sizeBytes, sizeExact: !!size && /^(?:B|字节)$/i.test(size[2]), sizeText: size ? size[1] + size[2] : '' };
}
function offeredDownloads(document, base, courseId) {
  const result = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],[disabled]')) continue;
    let hidden = false;
    for (let node = anchor; node; node = node.parentElement) {
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) { hidden = true; break; }
    }
    if (hidden) continue;
    try { result.push(resourceUrl(anchor.getAttribute('href'), 'download', { base, courseId })); } catch { /* Not an offered original file. */ }
  }
  return result;
}
export function previewMetadata(document, file, pageUrl, courseId) {
  const heading = parseFileHeading(document);
  if (!heading) throw problem('BAD_METADATA', '预览页没有原文件名');
  const offered = offeredDownloads(document, pageUrl, courseId).find(link => link.id === file.id);
  return { ...heading, originalName: heading.name, listName: file.originalName, metadataResolved: true, sourceUrl: pageUrl, downloadKind: offered ? 'original' : '', downloadable: !!offered, downloadUrl: offered?.url || '',
    unavailableCode: offered ? '' : 'NO_DOWNLOAD_LINK', unavailableReason: offered ? '' : missingDownloadReason };
}
/** Some unit pages render the preview itself rather than a table of preview links. */
export function inlinePreviewFiles(document, base, courseId) {
  if (!document.querySelector('#dowload-preview, #download-preview, iframe[src*="/preview/preview.jsp"]')) return [];
  let heading;
  try { heading = parseFileHeading(document); } catch { return []; }
  if (!heading) return [];
  const url = schoolUrl(base);
  const frameIds = new Set();
  for (const frame of document.querySelectorAll('iframe[src],frame[src]')) {
    try {
      const src = schoolUrl(frame.getAttribute('src'), base);
      if (src.pathname === '/meol/common/script/preview/preview.jsp') frameIds.add(numericParam(src, 'fileid'));
    } catch { /* Never inspect converted content or media bodies. */ }
  }
  const offered = offeredDownloads(document, base, courseId).filter(link => !frameIds.size || frameIds.has(link.fileid));
  if (offered.length === 1) {
    const link = offered[0];
    return [{ ...link, ...heading, originalName: heading.name, downloadUrl: link.url, metadataResolved: true, downloadable: true }];
  }
  // Without an offered canonical URL, keep a display-only identity, not a guessed download endpoint.
  const fileid = frameIds.size === 1 ? [...frameIds][0] : '';
  return [{ ...heading, id: 'preview-only:' + courseId + ':' + (fileid || url.pathname + url.search), lid: courseId, fileid,
    originalName: heading.name, sourceUrl: url.href, downloadUrl: '', metadataResolved: true, downloadable: false,
    unavailableCode: 'NO_DOWNLOAD_LINK', unavailableReason: missingDownloadReason }];
}
export function onlineOnlyFiles(document, base, courseId) {
  const result = new Map();
  for (const anchor of document.querySelectorAll('a[href*="onlinepreview.jsp"]')) {
    if (anchor.closest('[hidden],[aria-hidden="true"]')) continue;
    try {
      const url = schoolUrl(anchor.getAttribute('href'), base);
      if (url.pathname !== '/meol/common/script/onlinepreview.jsp' || numericParam(url, 'lid') !== courseId) continue;
      const resid = numericParam(url, 'resid');
      const id = 'online-only:' + courseId + ':' + resid;
      const name = displayName(anchor.textContent);
      result.set(id, { id, lid: courseId, resid, name, originalName: name, ext: '', group: 'other', sourceUrl: url.href,
        downloadUrl: '', metadataResolved: true, downloadable: false, unavailableCode: 'ONLINE_ONLY', unavailableReason: '平台仅提供在线预览，未提供原文件下载入口' });
    } catch { /* Ignore unrelated courses and unsupported online routes. */ }
  }
  return [...result.values()];
}
