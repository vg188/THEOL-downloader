import { schoolUrl, pageUrl, resourceUrl, numericParam, problem, displayName, extOf, groupOf, flattenFiles, isDownloadable } from './policy.js';
import { readSchoolPage, checkCancelled } from './network.js';
import { previewMetadata, inlinePreviewFiles, onlineOnlyFiles } from './metadata.js';
import { resolvePreviewDownload } from './preview.js';

const ICON_EXT = {
  'pdf.gif': 'pdf',
  'pdf2.gif': 'pdf',
  'powerpoint.gif': 'pptx',
  'powerpoint2.gif': 'pptx',
  'ppt.gif': 'ppt',
  'pptx.gif': 'pptx',
  'word.gif': 'doc',
  'word2.gif': 'doc',
  'doc.gif': 'doc',
  'docx.gif': 'docx',
  'excel.gif': 'xls',
  'excel2.gif': 'xls',
  'xls.gif': 'xls',
  'xlsx.gif': 'xlsx',
  'zip.gif': 'zip',
  'rar.gif': 'rar',
  '7z.gif': '7z',
  'txt.gif': 'txt',
  'text.gif': 'txt',
  'jpg.gif': 'jpg',
  'jpeg.gif': 'jpg',
  'png.gif': 'png',
  'gif.gif': 'gif',
  'image.gif': 'jpg',
  'mp3.gif': 'mp3',
  'audio.gif': 'mp3',
  'mp4.gif': 'mp4',
  'video.gif': 'mp4',
  'avi.gif': 'avi',
  'wav.gif': 'wav',
  'html.gif': 'html',
  'htm.gif': 'html',
  'flash.gif': 'swf',
  'swf.gif': 'swf',
  'file.gif': '',
  'attach.gif': '',
  'other.gif': '',
};

// 老页面也可能用 span.ico_xxx
const CLASS_EXT = {
  ico_pdf: 'pdf',
  ico_doc: 'doc',
  ico_docx: 'docx',
  ico_word: 'doc',
  ico_xls: 'xls',
  ico_xlsx: 'xlsx',
  ico_excel: 'xls',
  ico_ppt: 'ppt',
  ico_pptx: 'pptx',
  ico_powerpoint: 'ppt',
  ico_zip: 'zip',
  ico_rar: 'rar',
  ico_7z: '7z',
  ico_txt: 'txt',
  ico_jpg: 'jpg',
  ico_jpeg: 'jpg',
  ico_png: 'png',
  ico_gif: 'gif',
  ico_mp3: 'mp3',
  ico_mp4: 'mp4',
  ico_video: 'mp4',
  ico_wav: 'wav',
  ico_avi: 'avi',
  ico_html: 'html',
};


const NON_UNIT = /^(单元学习|课程资源|课程活动|基本信息|首页|课程介绍|教学大纲|教学日历|教师信息|课程作业|在线测试|教学播课|学习分析|互动交流|课程通知|课程问卷|课程笔记|课程答疑|课程wiki|课程博客|研究性学习|试题库|试卷库|作业库|课程管理|课程信息|课程公告)$/i;
const isList = url => /\/listview\.jsp(?:;[^?]*)?(?:\?|$)/i.test(url);
const isUnit = url => /resFolderViewList\.do|course_column_preview|colUrlStuView\.do|\/layout\/(?:lesson|newpage)\/index\.jsp/i.test(url);
const available = anchor => !anchor.closest('[hidden],[aria-hidden="true"]') && anchor.getAttribute('aria-disabled') !== 'true' && !anchor.hasAttribute('disabled') && !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(anchor.getAttribute('style') || '');
function isHidden(element) {
  for (let node = element; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) return true;
  }
  return false;
}
function iconExtension(row) {
  const image = row?.querySelector('img[src]');
  const src = (image?.getAttribute('src') || '').split(/[/?#]/).filter(Boolean).pop()?.toLowerCase();
  if (src && ICON_EXT[src]) return ICON_EXT[src];
  const classes = row?.querySelector('[class*="ico_"]')?.className || '';
  const match = classes.split(/\s+/).find(key => Object.hasOwn(CLASS_EXT, key));
  return match ? CLASS_EXT[match] : '';
}
function folder(name, pathSegments = [], url = '') {
  return { type: 'folder', id: 'folder:' + JSON.stringify([pathSegments, url]), name, pathSegments, url, children: [], scanError: '' };
}
function fileNode(file, pathSegments, section) { return { ...file, type: 'file', pathSegments: [...pathSegments], section }; }
export function extractFiles(document, base, courseId) {
  const unique = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!available(anchor)) continue;
    try {
      const preview = resourceUrl(anchor.getAttribute('href'), 'preview', { base, courseId });
      if (unique.has(preview.id)) continue;
      const originalName = displayName(anchor.textContent);
      const ext = extOf(originalName) || iconExtension(anchor.closest('tr,li,td,div'));
      const download = new URL(preview.url); download.pathname = '/meol/common/script/download.jsp';
      unique.set(preview.id, { ...preview, name: originalName, originalName, previewUrl: preview.url, downloadUrl: download.href, ext, group: groupOf(ext), sizeBytes: null });
    } catch { /* Non-file links and links to other courses are never requested. */ }
  }
  for (const file of [...inlinePreviewFiles(document, base, courseId), ...onlineOnlyFiles(document, base, courseId)]) {
    if (!unique.has(file.id)) unique.set(file.id, file);
  }
  return [...unique.values()];
}
export function extractUnitIndex(document, base, courseId) {
  const entries = new Map();
  // This is THEOL's canonical learning tree, including collapsed nested units.
  // Sibling hidden activity menus and the duplicate compact tree are not scan ranges.
  const learningTree = document.querySelector('#ul_advance');
  for (const anchor of (learningTree || document).querySelectorAll('a[href*="course_column_preview_transfer.jsp"]')) {
    if (!available(anchor)) continue;
    const container = anchor.closest('ul,ol,[role="list"],.unit-list,.lesson-list');
    if (!container || container.closest('nav,[role="navigation"],[role="menubar"],[role="tablist"],.nav,.navbar')) continue;
    if (!learningTree && (container.closest('#menu,.menu,.sidebar') || isHidden(container))) continue;
    try {
      const url = pageUrl(anchor.getAttribute('href'), { base, courseId });
      const columnId = numericParam(url, 'columnId');
      if (url.searchParams.getAll('tagbug').length !== 1 || url.searchParams.get('tagbug') !== 'client') continue;
      const title = displayName(anchor.textContent).slice(0, 120);
      if (!title || title === '未命名' || NON_UNIT.test(title) || entries.has(columnId)) continue;
      entries.set(columnId, { columnId, title, entryUrl: url.href, order: entries.size });
    } catch { /* Ignore navigation outside the supported unit surface. */ }
  }
  return [...entries.values()];
}
export function createCourseScanner({ window, fetchImpl = globalThis.fetch, signal, onProgress = () => {}, maxFolders = 500, maxUnits = 500 } = {}) {
  const origin = schoolUrl(window.location.href).origin;
  const failures = [];
  const metadata = new Map(), inlinePages = new Map();
  let courseId = '', courseName = '课件';
  const parse = html => new window.DOMParser().parseFromString(html, 'text/html');
  const fatal = error => { checkCancelled(signal); if (['CANCELLED', 'LOGIN_REQUIRED', 'WRONG_COURSE'].includes(error.code)) throw error; };
  const fail = (title, error, section) => { fatal(error); failures.push({ title, error: error.message || String(error), section }); };
  const report = text => { checkCancelled(signal); onProgress(text); };
  async function read(url) {
    checkCancelled(signal);
    const result = await readSchoolPage(url, { fetchImpl, signal, courseId });
    return { document: parse(result.html), url: result.url, html: result.html };
  }
  function frames() {
    const all = [], seen = new Set(), pending = [{ window, ancestors: [] }];
    while (pending.length && seen.size < 128) {
      const { window: win, ancestors } = pending.shift();
      if (!win || seen.has(win)) continue;
      seen.add(win);
      try {
        const url = schoolUrl(win.location.href);
        if (url.origin !== origin) continue;
        all.push({ window: win, ancestors, document: win.document, url: url.href });
        for (let i = 0; i < win.frames.length; i++) pending.push({ window: win.frames[i], ancestors: [...ancestors, win] });
      } catch { /* Cross-origin frames are deliberately not inspected. */ }
    }
    return all;
  }
  function courseFrom(url) {
    const parsed = schoolUrl(url);
    const lid = numericParam(parsed, 'lid', true), course = numericParam(parsed, 'courseId', true);
    if (lid && course && lid !== course) throw problem('AMBIGUOUS_COURSE', '页面包含多个课程标识，请进入具体课程后重试');
    return lid || course;
  }
  function context() {
    const all = frames();
    if (!all.length) throw problem('UNSUPPORTED_PAGE', '请进入学校教学平台的课程页');
    if (all.some(frame => /登录|登陆|统一身份认证/.test(frame.document.title) || frame.document.querySelector('input[type="password"]'))) throw problem('LOGIN_REQUIRED', '请先登录教学平台');
    courseId = '';
    courseName = '课件';
    const direct = courseFrom(window.location.href);
    const ids = new Set();
    for (const frame of all) { const id = courseFrom(frame.url); if (id) ids.add(id); }
    if (direct) courseId = direct;
    else if (ids.size === 1) courseId = [...ids][0];
    else if (ids.size > 1) throw problem('AMBIGUOUS_COURSE', '发现多个课程，请只打开一个课程页面后扫描');
    if (!courseId) {
      for (const frame of all) for (const anchor of frame.document.querySelectorAll('a[href]')) {
        try { const url = pageUrl(anchor.getAttribute('href'), { base: frame.url }); const id = courseFrom(url.href); if (id) ids.add(id); } catch { /* unrelated link */ }
      }
      if (ids.size !== 1) throw problem('AMBIGUOUS_COURSE', '无法确定当前课程，请进入具体课程资源或单元学习页面');
      courseId = [...ids][0];
    }
    const relevant = all.filter(frame => !courseFrom(frame.url) || courseFrom(frame.url) === courseId);
    for (const frame of relevant) {
      const title = frame.document.title.match(/网络课程\s*[—–-]\s*(.+)$/)?.[1];
      if (title) { courseName = displayName(title); break; }
    }
    return relevant;
  }
  // Freeze the course shell before asynchronous reads: browsing another folder
  // or replacing a frame must not change the resources of an in-flight scan.
  function captureContext() {
    return context().map(frame => ({ ...frame, document: frame.document.cloneNode(true) }));
  }
  function indexFor(all) {
    const units = new Map();
    for (const frame of all) for (const unit of extractUnitIndex(frame.document, frame.url, courseId)) if (!units.has(unit.columnId)) units.set(unit.columnId, unit);
    if (units.size > maxUnits) throw problem('SCAN_LIMIT', '单元数量超过扫描上限，请缩小扫描范围');
    return [...units.values()].map((unit, order) => ({ ...unit, order }));
  }
  async function enrich(file, sourcePage) {
    if (file.metadataResolved && isDownloadable(file)) return file;
    if (!metadata.has(file.id)) metadata.set(file.id, (async () => {
      report('正在读取资源信息：' + file.originalName);
      const cachedPage = sourcePage?.url === file.sourceUrl ? sourcePage : inlinePages.get(file.id);
      const page = file.metadataResolved && cachedPage ? cachedPage : await read(file.previewUrl || file.sourceUrl);
      const resolved = file.metadataResolved ? file : { ...file, ...previewMetadata(page.document, file, page.url, courseId) };
      if (isDownloadable(resolved)) return resolved;
      return resolvePreviewDownload(resolved, page, { readPage: read });
    })());
    return { ...file, ...await metadata.get(file.id) };
  }
  function unavailable(file, error, paths, section) {
    return fileNode({ ...file, downloadable: false, downloadUrl: '', unavailableCode: error.code || 'METADATA_FAILED', unavailableReason: '读取资源信息失败：' + error.message }, paths, section);
  }
  async function appendFiles(parent, page, section, seen) {
    for (const file of extractFiles(page.document, page.url, courseId)) {
      if (seen.has(file.id)) continue;
      try {
        parent.children.push(fileNode(await enrich(file, page), parent.pathSegments, section));
        seen.add(file.id);
      } catch (error) { fail(file.name, error, section); parent.children.push(unavailable(file, error, parent.pathSegments, section)); seen.add(file.id); }
    }
  }
  function subfolders(page) {
    const output = new Map();
    for (const anchor of page.document.querySelectorAll('a[href*="listview.jsp"][href*="folderid="]')) {
      if (!available(anchor) || /返回上一级|上级目录/.test(anchor.textContent)) continue;
      try {
        const url = pageUrl(anchor.getAttribute('href'), { base: page.url, courseId });
        const id = numericParam(url, 'folderid');
        const row = anchor.closest('tr,li,td,div');
        if (url.searchParams.get('acttype') !== 'enter' && !/folder/i.test(row?.querySelector('img')?.getAttribute('src') || '')) continue;
        if (!numericParam(url, 'lid', true)) url.searchParams.set('lid', courseId);
        output.set(id, { id, name: displayName(anchor.textContent), url: url.href });
      } catch { /* Never traverse external or cross-course folders. */ }
    }
    return [...output.values()];
  }
  async function scanFolder(url, name, paths, visited = new Set(), seen = new Set(), depth = 0) {
    checkCancelled(signal);
    const parsed = pageUrl(url, { courseId });
    const id = numericParam(parsed, 'folderid', true) || '0';
    const node = folder(name, paths, parsed.href);
    if (visited.has(id)) return node;
    if (visited.size >= maxFolders || depth > 20) throw problem('SCAN_LIMIT', '目录数量或层级超过安全上限，请分目录扫描');
    visited.add(id);
    const page = await read(parsed.href);
    if (!page.document.querySelector('table.valuelist') && !page.document.querySelector('a[href*="download_preview.jsp"],a[href*="listview.jsp"][href*="folderid="]')) throw problem('BAD_PAGE', '未找到课程资源列表，请确认登录和课程权限');
    await appendFiles(node, page, 'resource', seen);
    for (const child of subfolders(page)) {
      if (visited.has(child.id)) continue;
      try { node.children.push(await scanFolder(child.url, child.name, [...paths, child.name], visited, seen, depth + 1)); }
      catch (error) { fail(child.name, error, 'resource'); node.children.push({ ...folder(child.name, [...paths, child.name], child.url), scanError: error.message }); }
    }
    return node;
  }
  async function resources(all, recursive) {
    const lists = all.filter(frame => isList(frame.url));
    const live = lists.find(frame => frame.document.querySelector('table.valuelist')) || lists[0];
    if (!recursive && live) {
      const node = folder('当前目录', [], live.url);
      node.subfolderCount = subfolders(live).length;
      await appendFiles(node, live, 'resource', new Set());
      return node;
    }
    if (!recursive) throw problem('UNSUPPORTED_PAGE', '请先打开课程资源目录');
    const candidates = [live && new URL('listview.jsp?acttype=enter&folderid=0&lid=' + courseId, live.url).href, origin + '/meol/common/script/listview.jsp?acttype=enter&folderid=0&lid=' + courseId, origin + '/meol/jpk/course/layout/newpage/listview.jsp?acttype=enter&folderid=0&lid=' + courseId].filter(Boolean);
    let error;
    for (const url of new Set(candidates)) {
      try { return await scanFolder(url, '课程资源', []); }
      catch (failure) { fatal(failure); error = failure; }
    }
    throw error;
  }
  async function unitPage(entry) {
    const found = new Map(), visited = new Set(), pending = [{ url: entry.entryUrl, depth: 0 }];
    while (pending.length) {
      checkCancelled(signal);
      const next = pending.shift();
      if (visited.has(next.url)) continue;
      if (visited.size >= 32 || next.depth > 4) { fail(entry.title, problem('SCAN_LIMIT', '单元嵌套页面超过安全上限'), 'unit'); continue; }
      visited.add(next.url);
      let page;
      try { page = await read(next.url); } catch (error) { if (next.depth === 0) throw error; fail(entry.title, error, 'unit'); continue; }
      for (const file of extractFiles(page.document, page.url, courseId)) {
        found.set(file.id, file);
        if (file.metadataResolved && file.sourceUrl === page.url) inlinePages.set(file.id, page);
      }
      const urls = [...page.document.querySelectorAll('iframe[src],frame[src]')].map(frame => frame.getAttribute('src'));
      for (const match of page.html.matchAll(/["']([^"'\n]*(?:resFolderViewList|colUrlStuView)\.do[^"'\n]*)["']/gi)) urls.push(match[1]);
      for (const href of urls) {
        try {
          const url = pageUrl(href.replace(/&amp;/g, '&'), { base: page.url, courseId });
          if (url.origin !== origin || !isUnit(url.href) && !isList(url.href)) continue;
          pending.push({ url: url.href, depth: next.depth + 1 });
        } catch { /* Non-course frames are not fetched. */ }
      }
    }
    return [...found.values()];
  }
  function activeResourceSurface(all) {
    return all.some(frame => /\/courseResource\.jsp(?:[;?]|$)/i.test(frame.url)
      || [...frame.document.querySelectorAll('#tmenu > .licur a')].some(anchor => displayName(anchor.textContent) === '课程资源'));
  }
  function unitRoots(all) {
    if (activeResourceSurface(all)) return [];
    return all.filter(frame => isUnit(frame.url) && (/resFolderViewList|course_column_preview|colUrlStuView/i.test(frame.url)
      || extractFiles(frame.document, frame.url, courseId).length
      || extractUnitIndex(frame.document, frame.url, courseId).length && !isHidden(frame.document.querySelector('#ul_advance') || frame.document.body)));
  }
  async function units(all, allUnits, index) {
    const root = folder(allUnits ? '全部单元' : '当前单元', ['单元学习']);
    const seen = new Set();
    if (allUnits) {
      if (!index.length) throw problem('NO_UNIT_INDEX', '未探测到单元列表，请先打开单元学习页面');
      for (const [position, entry] of index.entries()) {
        report('正在读取单元 ' + (position + 1) + ' / ' + index.length + '：' + entry.title);
        const node = folder(entry.title, ['单元学习', entry.title], entry.entryUrl);
        try {
          for (const file of await unitPage(entry)) {
            if (seen.has(file.id)) continue;
            try { node.children.push(fileNode(await enrich(file), node.pathSegments, 'unit')); seen.add(file.id); }
            catch (error) { fail(file.name, error, 'unit'); node.children.push(unavailable(file, error, node.pathSegments, 'unit')); seen.add(file.id); }
          }
        } catch (error) { fail(entry.title, error, 'unit'); node.scanError = error.message; }
        root.children.push(node);
      }
    } else {
      const roots = unitRoots(all);
      const sources = all.filter(frame => roots.some(parent => frame.window === parent.window || frame.ancestors.includes(parent.window)));
      for (const frame of sources) await appendFiles(root, frame, 'unit', seen);
      if (!sources.length) throw problem('UNSUPPORTED_PAGE', '请先打开单元学习页面');
    }
    return root;
  }
  async function scan(options = {}) {
    const mode = options.mode || 'auto';
    if (mode === 'course') {
      const result = await scanAll();
      const tree = folder('全部课程');
      tree.children = [result.resourceTree, result.unitTree];
      return { ...result, tree, files: flattenFiles(tree), surface: 'course', defaultMode: 'course', modes: ['course', 'tree', 'unit-all'] };
    }
    if (!['auto', 'directory', 'tree', 'unit-current', 'unit-all'].includes(mode)) throw problem('INVALID_MODE', '不支持的扫描范围');
    const all = captureContext(), index = indexFor(all);
    const activeUnit = unitRoots(all).length > 0;
    const resource = ['directory', 'tree'].includes(mode) || mode === 'auto' && !activeUnit && all.some(frame => isList(frame.url));
    const chosen = mode === 'auto' ? resource ? 'directory' : 'unit-current' : mode;
    const tree = resource ? await resources(all, chosen === 'tree') : await units(all, chosen === 'unit-all', index);
    return { ok: true, courseName, lid: courseId, surface: resource ? 'resource-directory' : 'unit-study', modes: resource ? ['directory', 'tree'] : index.length ? ['unit-current', 'unit-all'] : ['unit-current'], defaultMode: chosen, tree, files: flattenFiles(tree), unitIndex: index, failures: [...failures], unavailable: flattenFiles(tree).filter(file => !isDownloadable(file)) };
  }
  async function scanAll({ includeAllUnits = true } = {}) {
    const all = captureContext(), index = indexFor(all);
    let resourceTree = folder('课程资源'), unitTree = folder('单元学习', ['单元学习']);
    report('正在扫描课程资源目录树…');
    try { resourceTree = await resources(all, true); }
    catch (error) { fail('课程资源', error, 'resource'); resourceTree.scanError = error.message; }
    report('正在探测单元学习…');
    if (includeAllUnits && index.length > 0 || unitRoots(all).length > 0) {
      try { unitTree = await units(all, includeAllUnits && index.length > 0, index); }
      catch (error) { fail('单元学习', error, 'unit'); unitTree.scanError = error.message; }
    } else {
      unitTree.emptyReason = index.length ? '本次未读取全部单元；可重新汇总并确认范围，或先在平台打开一个单元' : '当前页面未发现单元内容；课程资源仍可正常使用';
    }
    resourceTree.id = 'section-resource'; unitTree.id = 'section-unit';
    const resourceFiles = flattenFiles(resourceTree), unitFiles = flattenFiles(unitTree);
    return { ok: true, courseName, lid: courseId, resourceTree, unitTree, resourceFiles, unitFiles, unitIndex: index, failures: [...failures], unavailable: [...resourceFiles, ...unitFiles].filter(file => !isDownloadable(file)), stats: { resourceFiles: resourceFiles.length, unitFiles: unitFiles.length, units: includeAllUnits && index.length || (unitFiles.length ? 1 : 0), total: new Set([...resourceFiles, ...unitFiles].map(file => file.id)).size, downloadable: new Set([...resourceFiles, ...unitFiles].filter(isDownloadable).map(file => file.id)).size } };
  }
  function contextKey() {
    const all = context();
    return JSON.stringify({ origin: schoolUrl(all[0].url).origin, courseId });
  }
  return { scan, scanAll, contextKey, unitCount: () => indexFor(context()).length };
}
