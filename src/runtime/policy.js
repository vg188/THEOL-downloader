/** Shared trust boundary and portable paths for the shipped bookmarklet and extension. */
export const SCHOOL_HOST = 'course.buct.edu.cn';
export const DOWNLOAD_PATH = '/meol/common/script/download.jsp';
export const PREVIEW_PATH = '/meol/common/script/preview/download_preview.jsp';
const PAGE_ROUTE = /\/(?:listview\.jsp|download_preview\.jsp|course_column_preview(?:_transfer)?\.jsp|resFolderViewList\.do|colUrlStuView\.do|courseResource\.jsp|left\.jsp|index\.jsp|preview\.jsp|onlinepreview\.jsp|resPdfShow\.do)$/i;
const GROUPS = Object.fromEntries([['pdf', ['pdf']], ['ppt', ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm']], ['word', ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf']], ['excel', ['xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm']], ['archive', ['zip', 'rar', '7z']]].flatMap(([group, extensions]) => extensions.map(ext => [ext, group])));
export const groupOf = ext => GROUPS[String(ext).toLowerCase()] || 'other';
export const extOf = name => (String(name || '').match(/\.([a-z0-9]{1,8})$/i) || [, ''])[1].toLowerCase();
// THEOL overrides String.trim() in the page world; never use it on user-visible names.
export const trimWhitespace = value => String(value ?? '').replace(/^\s+|\s+$/g, '');
export const displayName = name => trimWhitespace(String(name || '').replace(/\s+/g, ' ')) || '未命名';
export const isDownloadable = file => !!file && file.downloadable !== false && typeof file.downloadUrl === 'string' && file.downloadUrl.length > 0;

export function availabilityCounts(files) {
  const unique = new Map(files.map(file => [file.id, file]));
  const counts = { total: unique.size, downloadable: 0, previewOnly: 0, unverified: 0, previewDownloads: 0 };
  for (const file of unique.values()) {
    if (isDownloadable(file)) { counts.downloadable++; if (file.downloadKind === 'preview') counts.previewDownloads++; }
    else if (['NO_DOWNLOAD_LINK', 'ONLINE_ONLY'].includes(file.unavailableCode)) counts.previewOnly++;
    else counts.unverified++;
  }
  return counts;
}
export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // getRandomValues is also available on the HTTP course pages.
  return Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), word => word.toString(16).padStart(8, '0')).join('');
}
export function problem(code, message) { return Object.assign(new Error(message), { code }); }
export function schoolUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw problem('INVALID_URL', '资源地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== SCHOOL_HOST || url.port || url.username || url.password) {
    throw problem('INVALID_URL', '只允许学校教学平台的资源地址');
  }
  return url;
}
export function isSchoolUrl(value) { try { schoolUrl(value); return true; } catch { return false; } }
export function numericParam(url, key, optional = false) {
  const values = url.searchParams.getAll(key);
  if (optional && values.length === 0) return '';
  if (values.length !== 1 || !/^\d+$/.test(values[0])) throw problem('INVALID_URL', '资源标识缺失或重复');
  return values[0];
}
export function pageUrl(value, { base, courseId } = {}) {
  const url = schoolUrl(value, base);
  // Strip only THEOL's session suffix, not arbitrary path data.
  const pathname = url.pathname.replace(/;jsessionid=[^/;]+/gi, '');
  if (!pathname.startsWith('/meol/') || !PAGE_ROUTE.test(pathname)) throw problem('UNSUPPORTED_PAGE', '不是支持的课程页面');
  for (const key of ['lid', 'courseId']) {
    const id = numericParam(url, key, true);
    if (courseId && id && id !== String(courseId)) throw problem('WRONG_COURSE', '页面不属于当前课程');
  }
  url.hash = '';
  return url;
}
export function resourceUrl(value, kind = 'download', { base, courseId } = {}) {
  const url = schoolUrl(value, base);
  const expected = kind === 'preview' ? PREVIEW_PATH : DOWNLOAD_PATH;
  if (url.pathname.replace(/;jsessionid=[^/;]+/gi, '') !== expected) throw problem('INVALID_URL', '不是原文件下载或预览地址');
  const lid = numericParam(url, 'lid'), resid = numericParam(url, 'resid'), fileid = numericParam(url, 'fileid');
  if (courseId && lid !== String(courseId)) throw problem('WRONG_COURSE', '资源不属于当前课程');
  url.pathname = expected;
  url.search = new URLSearchParams({ fileid, resid, lid }).toString();
  url.hash = '';
  return { id: lid + ':' + resid + ':' + fileid, lid, resid, fileid, url: url.href };
}
export function validateFile(input, courseId) {
  if (input?.downloadable === false) throw problem('INVALID_FILE', '该资源未提供原文件下载入口');
  if (!input || typeof input.name !== 'string' || !trimWhitespace(input.name)) throw problem('INVALID_FILE', '文件名无效');
  if (input.downloadKind === 'preview') return validatePreviewFile(input, courseId);
  if (input.downloadSource) return validatePreviewSource(input, courseId);
  if (input.downloadKind && input.downloadKind !== 'original') throw problem('INVALID_FILE', '不支持的下载类型');
  const parsed = resourceUrl(input.downloadUrl, 'download', { courseId });
  if (input.id !== parsed.id) throw problem('INVALID_FILE', '文件标识与下载地址不一致');
  if (input.previewUrl && resourceUrl(input.previewUrl, 'preview', { courseId }).id !== parsed.id) throw problem('INVALID_FILE', '预览地址与下载地址不一致');
  const name = trimWhitespace(input.name).normalize('NFC'), ext = extOf(name);
  return { ...input, ...parsed, downloadUrl: parsed.url, name, ext, group: groupOf(ext), pathSegments: Array.isArray(input.pathSegments) ? input.pathSegments.slice(0, 20).map(displayName) : [] };
}
function clip(text, max) {
  let result = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}
export function safeSegment(value, { filename = false, max = 120 } = {}) {
  let clean = String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_').replace(/^\s+|\s+$/g, '').replace(/[. ]+$/g, '');
  if (!clean || /^\.+$/.test(clean)) clean = '未命名';
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(clean)) clean = '_' + clean;
  const suffix = filename && /\.[a-z0-9]{1,8}$/i.exec(clean)?.[0];
  const encoder = new TextEncoder();
  if (clean.length > max || encoder.encode(clean).length > 240) {
    let hash = 2166136261; for (let i = 0; i < clean.length; i++) hash = Math.imul(hash ^ clean.charCodeAt(i), 16777619);
    const tail = '~' + (hash >>> 0).toString(16).padStart(8, '0') + (suffix || '');
    let stem = clip(suffix ? clean.slice(0, -suffix.length) : clean, Math.max(1, max - tail.length));
    while (encoder.encode(stem + tail).length > 240) stem = clip(stem, stem.length - 1);
    clean = stem + tail;
  }
  return clean.replace(/[. ]+$/g, '') || '未命名';
}
export function filePath(file, { courseName, section = false, flatten = false } = {}) {
  const parts = [];
  if (courseName) parts.push(safeSegment(courseName));
  if (!flatten) {
    const label = file.section === 'unit' ? '单元学习' : '课程资源';
    const folders = (file.pathSegments || []).slice(0, 20).filter(Boolean).map(part => safeSegment(part, { max: 60 }));
    if (section) { parts.push(label); if (folders[0] === label) folders.shift(); }
    parts.push(...folders);
  }
  parts.push(safeSegment(file.name, { filename: true }));
  // Bound the *whole* relative path, not only each component. Retain both ends
  // of a deep hierarchy and mark the omitted middle deterministically.
  const maxPath = 200;
  if (parts.join('/').length > maxPath && parts.length > 4) {
    const middle = parts.slice(2, -2).join('/'); let hash = 2166136261;
    for (let i = 0; i < middle.length; i++) hash = Math.imul(hash ^ middle.charCodeAt(i), 16777619);
    parts.splice(2, parts.length - 4, '目录~' + (hash >>> 0).toString(16));
  }
  while (parts.join('/').length > maxPath) {
    let longest = 0;
    for (let i = 1; i < parts.length; i++) if (parts[i].length > parts[longest].length) longest = i;
    parts[longest] = safeSegment(parts[longest], { filename: longest === parts.length - 1, max: parts[longest].length - 1 });
  }
  return parts.join('/');
}
export function uniqueArchivePath(file, used, { flatten = false } = {}) {
  const base = filePath(file, { section: true, flatten });
  let name = base, n = 1;
  const lastSlash = base.lastIndexOf('/'), dot = base.lastIndexOf('.');
  while (used.has(name.toLowerCase())) {
    const at = dot > lastSlash + 1 ? dot : base.length;
    const suffix = ' (' + n++ + ')', directory = base.slice(0, lastSlash + 1);
    const leaf = base.slice(lastSlash + 1, at) + suffix + base.slice(at);
    name = directory + safeSegment(leaf, { filename: true, max: Math.min(120, 200 - directory.length) });
  }
  used.add(name.toLowerCase());
  return name;
}
export function flattenFiles(node, out = []) {
  if (!node) return out;
  if (node.type === 'file') out.push(node);
  for (const child of node.children || []) flattenFiles(child, out);
  return out;
}


// Preview assets are discovered in the selected course, never supplied by a download message.
export const MAX_PREVIEW_PAGES = 500;
const MEDIA_EXT = new Set(['mp4', 'm4v', 'm4a', 'mp3', 'flv', 'webm', 'ogg', 'wav']);
const PREVIEW_SOURCE_EXT = new Set('pdf doc dot docx docm dotx dotm ppt pps pot pptx pptm ppsx ppsm potx potm xls xlt xlsx xlsm xltx xltm'.split(' '));
export const supportsPreviewSource = name => PREVIEW_SOURCE_EXT.has(extOf(name));
export const isPreviewSource = file => file?.downloadKind === 'original' && file?.downloadSource === 'preview-stream';
function samePreviewOrigin(url, file, base) {
  const source = file.previewUrl || file.sourceUrl || base;
  if (source && url.origin !== schoolUrl(source, base).origin) throw problem('INVALID_URL', '预览资源不属于当前学校会话');
}
function onlyParams(url, names) {
  if ([...url.searchParams.keys()].some(key => !names.includes(key))) throw problem('INVALID_URL', '预览地址含不支持的参数');
}
export function previewPageUrl(value, file, { base } = {}) {
  const url = schoolUrl(value, base);
  samePreviewOrigin(url, file, base);
  url.pathname = url.pathname.replace(/;jsessionid=[^/;]+/gi, ''); url.hash = '';
  const matches = (key, expected, optional = false) => {
    const id = numericParam(url, key, optional);
    if (id && (!expected || id !== String(expected))) throw problem('WRONG_RESOURCE', '预览页与所选课件标识不一致');
  };
  if (url.pathname === PREVIEW_PATH) {
    const parsed = resourceUrl(url.href, 'preview', { courseId: file.lid });
    if (parsed.id !== file.id) throw problem('WRONG_RESOURCE', '预览页与所选课件不一致');
    return new URL(parsed.url);
  }
  if (url.pathname === '/meol/common/script/preview/preview.jsp') {
    onlyParams(url, ['fileid', 'resid', 'lid']);
    matches('fileid', file.fileid); matches('resid', file.resid, true); matches('lid', file.lid, true);
  } else if (url.pathname === '/meol/common/script/onlinepreview.jsp') {
    onlyParams(url, ['resid', 'lid', 'countadd']);
    matches('resid', file.resid); matches('lid', file.lid);
    if (url.searchParams.has('countadd') && numericParam(url, 'countadd') !== '1') throw problem('INVALID_URL', '在线预览参数无效');
  } else if (url.pathname === '/meol/analytics/resPdfShow.do') {
    onlyParams(url, ['resId', 'lid', 'file']); matches('resId', file.resid); matches('lid', file.lid);
    if (url.searchParams.has('file')) {
      const innerValues = url.searchParams.getAll('file');
      if (innerValues.length !== 1) throw problem('INVALID_URL', 'PDF 预览地址重复');
      const inner = schoolUrl(innerValues[0], url.href);
      if (inner.pathname !== url.pathname || inner.searchParams.has('file')) throw problem('INVALID_URL', 'PDF 预览嵌套地址无效');
      previewPageUrl(inner.href, file, { base: url.href });
    }
  } else throw problem('UNSUPPORTED_PREVIEW', '暂不支持该预览页面');
  return url;
}
export function previewAssetUrl(value, file, { base, kind } = {}) {
  const url = schoolUrl(value, base || file.sourceUrl || file.previewUrl);
  samePreviewOrigin(url, file, base); url.hash = '';
  const converted = /^\/meol\/data\/convert\/\d{4}\/\d{1,2}\/\d{1,2}\/[a-zA-Z0-9_-]+(?:\.(?:png|jpe?g|pdf))?$/.test(url.pathname);
  const media = /^\/dest\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(?:mp4|m4v|m4a|mp3|flv|webm|ogg|wav)$/i.test(url.pathname);
  const analyticsPDF = url.pathname === '/meol/analytics/resPdfShow.do' && !url.searchParams.has('file');
  if (analyticsPDF) previewPageUrl(url.href, file, { base });
  else if ((!converted && !media) || url.search) throw problem('INVALID_URL', '不是平台提供的受支持预览文件地址');
  if (kind === 'image' && !(converted && (/_slide-\d+$/.test(url.pathname) || /\.(?:png|jpe?g)$/i.test(url.pathname)))) throw problem('INVALID_URL', '不是课件的预览图片');
  if (kind === 'media' && !media) throw problem('INVALID_URL', '不是可保存的音视频预览文件');
  if (kind === 'pdf' && !(analyticsPDF || converted && /\.pdf$/i.test(url.pathname))) throw problem('INVALID_URL', '不是 PDF 预览文件');
  return url;
}
// This servlet is a resource stream despite its PDF name/MIME. Accept only the exact declared, ID-bound source.
export function previewSourceUrl(value, file, { base } = {}) {
  const url = previewPageUrl(value, file, { base: base || file.sourceUrl || file.previewUrl });
  if (url.pathname !== '/meol/analytics/resPdfShow.do' || url.searchParams.has('file') || !supportsPreviewSource(file.originalName || file.name)) throw problem('INVALID_URL', '不是支持完整内容校验的预览资源流');
  url.search = new URLSearchParams({ resId: String(file.resid), lid: String(file.lid) }).toString();
  return url;
}
function validatePreviewSource(input, courseId) {
  if (!isPreviewSource(input)) throw problem('INVALID_FILE', '不支持的原文件来源');
  const identity = resourceUrl(input.previewUrl, 'preview', { courseId });
  if (identity.id !== input.id || identity.lid !== String(input.lid) || identity.resid !== String(input.resid) || identity.fileid !== String(input.fileid)) throw problem('INVALID_FILE', '预览资源流与课件标识不一致');
  const source = previewPageUrl(input.sourceUrl || input.previewUrl, input);
  if (![PREVIEW_PATH, '/meol/common/script/preview/preview.jsp'].includes(source.pathname)) throw problem('INVALID_FILE', '预览资源流缺少有效的声明页面');
  const url = previewSourceUrl(input.downloadUrl, input), name = trimWhitespace(input.name).normalize('NFC'), ext = extOf(name);
  if (!input.originalName || name !== trimWhitespace(input.originalName).normalize('NFC') || !supportsPreviewSource(name)) throw problem('INVALID_FILE', '预览资源流必须保留可校验的原文件名与格式');
  return { ...input, ...identity, url: url.href, previewUrl: identity.url, sourceUrl: source.href, downloadUrl: url.href, name, ext, group: groupOf(ext), preview: undefined,
    pathSegments: Array.isArray(input.pathSegments) ? input.pathSegments.slice(0, 20).map(displayName) : [] };
}
export const isGeneratedPreview = file => file?.downloadKind === 'preview' && ['slides', 'text', 'html'].includes(file.preview?.kind);
export const requiresPreparedDownload = file => isGeneratedPreview(file) || isPreviewSource(file);
export function previewFilename(name, ext) {
  const original = trimWhitespace(name).normalize('NFC');
  // The preview route is a transport, not a filename suffix. Preserve exact
  // names for matching formats and change only the extension when converted.
  return extOf(original) === String(ext).toLowerCase() ? original : original.replace(/\.[a-z0-9]{1,8}$/i, '') + '.' + ext;
}
export function previewSummary(file) {
  if (isPreviewSource(file)) return '整份资源流 · ' + file.ext.toUpperCase();
  if (file?.downloadKind !== 'preview') return '';
  return (file.preview.kind === 'slides' ? '图片合成 ' : file.preview.kind === 'html' ? '离线 ' : '平台文件 · ') + file.ext.toUpperCase() + (file.preview.kind === 'slides' ? ' · ' + file.preview.pages.length + ' 页' : '');
}
export function previewNotice(file) {
  if (isPreviewSource(file)) return '预览页提供的原格式文件流；保存前完整校验，保留文件字节，不用分页图片合成';
  if (file?.downloadKind !== 'preview') return '';
  if (file.preview.kind === 'slides') return '由平台提供的 ' + file.preview.pages.length + ' 页图片合成，不含可编辑内容、动画、备注或平台未提供的页面';
  if (file.preview.kind === 'pdf') return '直接保存平台提供的完整 PDF，保留文件字节，不重新合成';
  if (file.preview.kind === 'html') return '平台富文本预览的离线 HTML，保留正文、表格和内嵌图片；不是原始 Word 文件';
  return file.preview.kind === 'text' ? '将平台提供的正文保存为 UTF-8 文本' : '保存平台提供的完整音视频文件';
}
export function validatePreviewFile(input, courseId) {
  const lid = String(input.lid || '');
  if (!/^\d+$/.test(lid) || courseId && lid !== String(courseId)) throw problem('WRONG_COURSE', '预览资源不属于当前课程');
  let source;
  if (input.previewUrl) {
    const identity = resourceUrl(input.previewUrl, 'preview', { courseId: lid });
    if (identity.id !== input.id || identity.fileid !== String(input.fileid) || identity.resid !== String(input.resid)) throw problem('INVALID_FILE', '预览资源标识不一致');
    source = new URL(identity.url);
  } else if (input.id === 'preview-only:' + lid + ':' + input.fileid && /^\d+$/.test(String(input.fileid))) {
    source = pageUrl(input.sourceUrl, { courseId: lid });
    if (numericParam(source, 'lid', true) !== lid && numericParam(source, 'courseId', true) !== lid) throw problem('INVALID_FILE', '内嵌预览缺少课程来源');
  } else if (input.id === 'online-only:' + lid + ':' + input.resid && /^\d+$/.test(String(input.resid))) {
    source = previewPageUrl(input.sourceUrl, input);
    if (source.pathname !== '/meol/common/script/onlinepreview.jsp') throw problem('INVALID_FILE', '在线文本来源无效');
  } else throw problem('INVALID_FILE', '预览资源缺少有效的课程来源');
  const inputPreview = input.preview || {}; let preview, ext, downloadUrl;
  if (['media', 'pdf'].includes(inputPreview.kind)) {
    const url = previewAssetUrl(inputPreview.url, { ...input, sourceUrl: source.href }, { kind: inputPreview.kind });
    ext = inputPreview.kind === 'pdf' ? 'pdf' : extOf(url.pathname);
    if (inputPreview.kind === 'media' && !MEDIA_EXT.has(ext)) throw problem('INVALID_FILE', '不支持的预览媒体格式');
    preview = { kind: inputPreview.kind, url: url.href }; downloadUrl = url.href;
  } else if (inputPreview.kind === 'slides') {
    if (!Array.isArray(inputPreview.pages) || !inputPreview.pages.length || inputPreview.pages.length > MAX_PREVIEW_PAGES) throw problem('PREVIEW_LIMIT', '预览页数为空或超过 ' + MAX_PREVIEW_PAGES + ' 页上限');
    preview = { kind: 'slides', pages: inputPreview.pages.map(url => previewAssetUrl(url, input, { kind: 'image' }).href) };
    ext = 'pdf'; downloadUrl = source.href;
  } else if (inputPreview.kind === 'html') {
    if (typeof inputPreview.html !== 'string' || !trimWhitespace(inputPreview.html) || new TextEncoder().encode(inputPreview.html).length > 1048576 || !Array.isArray(inputPreview.images) || inputPreview.images.length > MAX_PREVIEW_PAGES) throw problem('PREVIEW_LIMIT', '富文本预览内容过大或图片过多');
    preview = { kind: 'html', html: inputPreview.html, images: inputPreview.images.map(url => previewAssetUrl(url, input, { kind: 'image' }).href) };
    ext = 'html'; downloadUrl = source.href;
  } else if (inputPreview.kind === 'text') {
    if (typeof inputPreview.text !== 'string' || !trimWhitespace(inputPreview.text) || new TextEncoder().encode(inputPreview.text).length > 1048576) throw problem('PREVIEW_LIMIT', '在线文本为空或超过 1 MB 上限');
    preview = { kind: 'text', text: inputPreview.text }; ext = 'txt'; downloadUrl = source.href;
  } else throw problem('INVALID_FILE', '没有可保存的预览内容');
  const name = previewFilename(input.originalName || '', ext);
  if (!trimWhitespace(input.originalName) || input.name !== name || input.downloadUrl !== downloadUrl) throw problem('INVALID_FILE', '预览副本的名称、格式或地址不一致');
  return { ...input, lid, name, ext, group: groupOf(ext), sourceUrl: source.href, downloadUrl, preview, downloadable: true,
    sizeBytes: null, sizeExact: false, sizeText: '', pathSegments: Array.isArray(input.pathSegments) ? input.pathSegments.slice(0, 20).map(displayName) : [] };
}
export function matchesFileUrl(file, value) {
  try {
    if (isPreviewSource(file)) return previewSourceUrl(value, file).href === file.downloadUrl;
    if (file.downloadKind === 'preview') return !isGeneratedPreview(file) && previewAssetUrl(value, file, { kind: file.preview.kind }).href === file.downloadUrl;
    return resourceUrl(value).id === file.id && schoolUrl(value).origin === schoolUrl(file.downloadUrl).origin;
  } catch { return false; }
}
