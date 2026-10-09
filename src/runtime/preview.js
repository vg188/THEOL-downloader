import { extOf, groupOf, trimWhitespace, previewFilename, previewPageUrl, previewAssetUrl, previewSourceUrl, supportsPreviewSource, validateFile, problem, MAX_PREVIEW_PAGES } from './policy.js';

// Parse data literals only. Never eval platform scripts or execute viewer/analytics code.
function decodeLiteral(raw) {
  return raw.replace(/\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, escaped => {
    if (/^\\u/i.test(escaped)) return String.fromCharCode(parseInt(escaped.slice(2), 16));
    if (/^\\x/i.test(escaped)) return String.fromCharCode(parseInt(escaped.slice(2), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escaped[1]] ?? escaped.slice(1);
  });
}
function literals(text) {
  return [...text.matchAll(/(["'])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g)].map(match => decodeLiteral(match[2]));
}
function asPreview(file, preview) {
  const ext = preview.kind === 'slides' || preview.kind === 'pdf' ? 'pdf' : preview.kind === 'text' ? 'txt' : preview.kind === 'html' ? 'html' : extOf(new URL(preview.url).pathname);
  return validateFile({ ...file, name: previewFilename(file.originalName, ext), ext, group: groupOf(ext), downloadKind: 'preview', preview,
    downloadUrl: preview.url || file.previewUrl || file.sourceUrl, downloadable: true, metadataResolved: true, unavailableCode: '', unavailableReason: '',
    sizeBytes: null, sizeExact: false, sizeText: '' }, file.lid);
}
function onlineText(document) {
  const fragments = [...document.querySelectorAll('input[type="hidden"][id$="_content"],textarea[id$="_content"]')].map(node => node.value || node.textContent);
  if (!fragments.length) return '';
  const content = document.implementation.createHTMLDocument(''); content.body.innerHTML = [...new Set(fragments)].join('\n');
  // Do not present text-only extraction as a complete mixed-media lesson.
  if (content.querySelector('img,video,audio,iframe,embed,object,svg,canvas')) return '';
  for (const node of content.querySelectorAll('script,style,noscript,form,button')) node.remove();
  for (const node of content.querySelectorAll('br')) node.replaceWith('\n');
  for (const node of content.querySelectorAll('td,th')) node.append('\t');
  for (const node of content.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre')) node.append('\n');
  return trimWhitespace(content.body.textContent.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'));
}
function richPreview(document, file, base) {
  const fragments = [...document.querySelectorAll('input[type="hidden"][id$="_content"],textarea[id$="_content"]')].map(node => node.value || node.textContent);
  if (!fragments.length) return null;
  const input = document.implementation.createHTMLDocument(''); input.body.innerHTML = [...new Set(fragments)].join('\n');
  if (input.querySelector('iframe,embed,object,video,audio,canvas,svg,math')) throw problem('UNSUPPORTED_PREVIEW', '富文本包含暂不支持离线保存的嵌入内容，未导出不完整副本');
  const output = document.implementation.createHTMLDocument(''), images = [];
  const allowed = new Set('P DIV SPAN BR HR STRONG B EM I U S SUB SUP H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE TABLE THEAD TBODY TFOOT TR TD TH CAPTION IMG A'.split(' '));
  const remove = new Set('SCRIPT STYLE NOSCRIPT IFRAME EMBED OBJECT SVG CANVAS FORM INPUT BUTTON META LINK BASE'.split(' '));
  function copy(node, parent) {
    if (node.nodeType === 3) { parent.appendChild(output.createTextNode(node.textContent)); return; }
    if (node.nodeType !== 1 || remove.has(node.tagName)) return;
    if (!allowed.has(node.tagName)) { for (const child of node.childNodes) copy(child, parent); return; }
    const element = output.createElement(node.tagName.toLowerCase());
    if (node.tagName === 'IMG') {
      const url = previewAssetUrl(node.getAttribute('src'), file, { base, kind: 'image' }).href;
      let index = images.indexOf(url); if (index < 0) { index = images.length; images.push(url); }
      element.setAttribute('src', 'buct-preview-image:' + index); element.setAttribute('alt', node.getAttribute('alt') || '');
    }
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      try { const url = new URL(node.getAttribute('href'), base); if (['https:', 'http:'].includes(url.protocol)) { element.setAttribute('href', url.href); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); } } catch { /* Invalid links are text only. */ }
    }
    if (['TD', 'TH'].includes(node.tagName)) for (const attr of ['colspan', 'rowspan']) {
      const value = node.getAttribute(attr); if (/^[1-9]\d?$/.test(value || '')) element.setAttribute(attr, value);
    }
    for (const child of node.childNodes) copy(child, element); parent.appendChild(element);
  }
  for (const node of input.body.childNodes) copy(node, output.body);
  if (!trimWhitespace(output.body.textContent) && !images.length) return null;
  return { kind: 'html', html: output.body.innerHTML, images };
}
function declaredSourceStream(document, scripts, file, base) {
  // THEOL emits this assignment even on Office pages with no PDF iframe. The servlet can
  // return the original Office bytes under application/pdf; do not mistake its name for its format.
  if (document.querySelector('#pdfIframe') || !file.previewUrl || !supportsPreviewSource(file.originalName)) return null;
  if (!/(?:\$|jQuery)\(\s*(["'])#pdfIframe\1\s*\)\s*\.attr\(\s*(["'])src\2\s*,/.test(scripts)) return null;
  const candidates = new Set();
  for (const match of scripts.matchAll(/\bencodeURIComponent\s*\(\s*(["'])((?:\\[\s\S]|(?!\1)[^\\])*?)\1\s*\)/g)) {
    let url;
    try { url = new URL(decodeLiteral(match[2]), base); } catch { continue; }
    if (url.pathname !== '/meol/analytics/resPdfShow.do' || url.searchParams.has('file')) continue;
    candidates.add(previewSourceUrl(url.href, file, { base }).href);
  }
  if (candidates.size > 1) throw problem('AMBIGUOUS_PREVIEW', '预览页提供了多个原格式资源流，无法可靠对应');
  if (!candidates.size) return null;
  return validateFile({ ...file, name: file.originalName, sourceUrl: base, downloadKind: 'original', downloadSource: 'preview-stream',
    downloadUrl: [...candidates][0], downloadable: true, metadataResolved: true, unavailableCode: '', unavailableReason: '' }, file.lid);
}
export function findPreviewDownload(document, file, base) {
  const scripts = [...document.querySelectorAll('script:not([src])')].map(node => node.textContent).join('\n');
  const source = declaredSourceStream(document, scripts, file, base);
  if (source) return { file: source, pages: [] };
  const readSlides = () => {
    if (!document.querySelector('#ppt-img') || !/\.slidePPT\s*\(/.test(scripts)) return null;
    const assignments = [...scripts.matchAll(/\bconverbodyHtml\s*=\s*(["'])((?:\\[\s\S]|(?!\1)[^\\])*?)\1\s*;/g)];
    if (assignments.length !== 1) throw problem('BAD_PREVIEW', '无法确认课件的完整预览页清单');
    const urls = decodeLiteral(assignments[0][2]).split(',').map(trimWhitespace);
    if (urls.some(url => !url)) throw problem('BAD_PREVIEW', '预览页清单含空缺，未生成缺页 PDF');
    if (!urls.length || urls.length > MAX_PREVIEW_PAGES) throw problem('PREVIEW_LIMIT', '预览页数为空或超过 ' + MAX_PREVIEW_PAGES + ' 页上限');
    const pages = urls.map(url => previewAssetUrl(url, file, { base, kind: 'image' }).href);
    return { kind: 'slides', pages };
  };
  const media = new Set(), pdfs = new Set(), pages = new Set();
  const acceptAsset = (value, kind) => {
    try { return previewAssetUrl(value, file, { base, kind }).href; } catch { return ''; }
  };
  for (const node of document.querySelectorAll('video[src],audio[src],source[src]')) {
    const url = acceptAsset(node.getAttribute('src'), 'media'); if (url) media.add(url);
  }
  if (/CKobject\.embed\s*\(/.test(scripts)) for (const value of literals(scripts)) {
    const url = acceptAsset(value.split('->')[0], 'media'); if (url) media.add(url);
  }
  for (const node of document.querySelectorAll('iframe[src],frame[src],embed[src],object[data],a[href]')) {
    const value = node.getAttribute('src') || node.getAttribute('data') || node.getAttribute('href');
    const pdf = acceptAsset(value, 'pdf'); if (pdf) { pdfs.add(pdf); continue; }
    try {
      const viewer = new URL(value, base);
      if (viewer.origin === new URL(base).origin && /\/viewer\.html$/.test(viewer.pathname) && viewer.searchParams.getAll('file').length === 1) {
        const asset = acceptAsset(new URL(viewer.searchParams.get('file'), viewer.href).href, 'pdf'); if (asset) { pdfs.add(asset); continue; }
      }
    } catch { /* Not a PDF.js file parameter. */ }
    if (!['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(node.tagName)) continue;
    try { pages.add(previewPageUrl(value, file, { base }).href); }
    catch (error) { if (error.code === 'WRONG_RESOURCE' || error.code === 'WRONG_COURSE') throw error; }
  }
  // Prefer an existing complete PDF over a slide manifest, including PDF.js data literals.
  for (const match of scripts.matchAll(/\b(?:converbodyPdf|pdfUrl|pdfURL|pdfPath|pdfFile|fileUrl|fileURL|DEFAULT_URL)["']?\s*[:=]\s*(["'])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g)) {
    const pdf = acceptAsset(decodeLiteral(match[2]), 'pdf'); if (pdf) pdfs.add(pdf);
  }
  if (/\b(?:pdfjsLib|PDFJS|PDFObject)\.(?:getDocument|embed)\s*\(/.test(scripts)) for (const value of literals(scripts)) {
    const pdf = acceptAsset(value, 'pdf'); if (pdf) pdfs.add(pdf);
  }
  // THEOL supplies this PDF endpoint in a data literal and inserts the viewer src via jQuery.
  if (document.querySelector('#pdfIframe')) for (const value of literals(scripts)) {
    const pdf = acceptAsset(value, 'pdf'); if (pdf) pdfs.add(pdf);
  }
  if (pdfs.size > 1 || !pdfs.size && media.size > 1) throw problem('AMBIGUOUS_PREVIEW', '预览页包含多个不同文件，无法可靠对应到单个课件');
  if (pdfs.size) return { file: asPreview(file, { kind: 'pdf', url: [...pdfs][0] }), pages: [] };
  if (media.size) return { file: asPreview(file, { kind: 'media', url: [...media][0] }), pages: [] };
  const slides = readSlides();
  if (slides) return { file: asPreview(file, slides), pages: [] };
  if (file.id.startsWith('online-only:')) {
    const text = onlineText(document);
    if (text) return { file: asPreview(file, { kind: 'text', text }), pages: [] };
  }
  // Converted Word documents are rich HTML stored in THEOL's inert content field.
  if (!file.id.startsWith('online-only:') && ['doc', 'docx', 'docm', 'rtf'].includes(extOf(file.originalName))) {
    const rich = richPreview(document, file, base);
    if (rich) return { file: asPreview(file, rich), pages: [] };
  }
  return { file: null, pages: [...pages] };
}
export async function resolvePreviewDownload(file, rootPage, { readPage } = {}) {
  const pending = [{ ...rootPage, depth: 0 }], seen = new Set();
  while (pending.length) {
    const page = pending.shift(); if (seen.has(page.url)) continue; seen.add(page.url);
    const found = findPreviewDownload(page.document, file, page.url);
    if (found.file) return found.file;
    if (!found.pages.length && /错误|exception|error/i.test(page.document.title)) throw problem('PREVIEW_FAILED', '平台预览页返回错误，暂时无法生成可用文件');
    for (const url of found.pages) {
      if (seen.has(url)) continue;
      if (page.depth >= 3 || seen.size + pending.length >= 8) throw problem('PREVIEW_LIMIT', '预览嵌套层级过多，请在平台打开资源后重试');
      pending.push({ ...await readPage(url), depth: page.depth + 1 });
    }
  }
  return { ...file, unavailableReason: '平台未提供原文件下载入口；未发现可保存的预览内容（不支持外链、分段流或无法加载的预览）' };
}
