/* 北化课件下载 · 标签版 — 自包含书签脚本
 * 在 course.buct.edu.cn 课程页运行：全屏标签页面板，树状勾选，类型筛选，批量下载。
 * 不依赖远程运行时，不上传任何数据。
 */
(() => {
  'use strict';
  const VERSION = '2.0.0-tab';
  const HOST_ID = 'buct-tab-dl-host';
  if (window.__buctTabDl) {
    const prev = document.getElementById(HOST_ID);
    if (prev) prev.remove();
    window.__buctTabDl = null;
  }

  if (location.protocol !== 'https:' && location.protocol !== 'http:') {
    alert('请在学校教学平台页面运行此书签');
    return;
  }
  if (!/course\.buct\.edu\.cn$/i.test(location.hostname)) {
    alert('请在 course.buct.edu.cn 的课程页运行「北化课件下载 · 标签版」');
    return;
  }

  // ---------- 工具 ----------
  const ORIGIN = location.origin;
  const ICON_EXT = {
    'pdf.gif': 'pdf', 'powerpoint.gif': 'pptx', 'ppt.gif': 'ppt', 'pptx.gif': 'pptx',
    'word.gif': 'doc', 'doc.gif': 'doc', 'docx.gif': 'docx',
    'excel.gif': 'xls', 'xls.gif': 'xls', 'xlsx.gif': 'xlsx',
    'zip.gif': 'zip', 'rar.gif': 'rar', '7z.gif': '7z', 'txt.gif': 'txt',
    'jpg.gif': 'jpg', 'png.gif': 'png', 'gif.gif': 'gif',
    'mp3.gif': 'mp3', 'mp4.gif': 'mp4', 'video.gif': 'mp4', 'avi.gif': 'avi',
    'html.gif': 'html', 'file.gif': '', 'attach.gif': '',
  };
  const TYPE_GROUP = {
    pdf: 'pdf', ppt: 'ppt', pptx: 'ppt',
    doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel',
    zip: 'archive', rar: 'archive', '7z': 'archive',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sanitizeName = (n) => String(n || '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || '未命名';
  const hasExt = (n) => /\.[A-Za-z0-9]{1,8}$/.test(String(n || '').split(/[\\/]/).pop() || '');
  const extOf = (n) => (String(n || '').trim().match(/\.([A-Za-z0-9]{1,8})$/i) || [, ''])[1].toLowerCase();
  const groupOf = (e) => TYPE_GROUP[e] || 'other';
  const basename = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();

  function extFromIconSrc(src) {
    if (!src) return '';
    const b = basename(src);
    if (b in ICON_EXT) return ICON_EXT[b];
    for (const k of Object.keys(ICON_EXT)) {
      if (ICON_EXT[k] && b.includes(k.replace('.gif', ''))) return ICON_EXT[k];
    }
    return '';
  }

  async function fetchGBKText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('请求失败 ' + res.status);
    const buf = await res.arrayBuffer();
    const ctype = res.headers.get('content-type') || '';
    const m = ctype.match(/charset=([^;]+)/i);
    let enc = (m ? m[1] : 'gbk').trim().toLowerCase();
    if (enc === 'gb2312') enc = 'gbk';
    try { return new TextDecoder(enc).decode(buf); }
    catch { return new TextDecoder('gbk').decode(buf); }
  }

  const parseHTML = (html) => new DOMParser().parseFromString(html, 'text/html');
  const absUrl = (href, base) => { try { return new URL(href, base).href; } catch { return ''; } };

  function extractRows(doc) {
    const table = doc.querySelector('table.valuelist') || doc.querySelector('table');
    if (!table) return [];
    return [...table.querySelectorAll('tr')].filter((tr) => tr.querySelector('td'));
  }

  function extFromRow(tr) {
    const img = tr.querySelector('img[src*="icons/"], img[src*="image/"]');
    if (img) {
      const e = extFromIconSrc(img.getAttribute('src') || '');
      if (e) return e;
    }
    return '';
  }

  function parseFolderRow(tr, pageUrl) {
    const a = tr.querySelector("a[href*='listview.jsp'][href*='folderid=']");
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const nameRaw = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!nameRaw || /返回上一级/.test(nameRaw)) return null;
    const fullUrl = absUrl(href, pageUrl);
    if (!fullUrl) return null;
    let folderId = '', lid = '';
    try {
      const u = new URL(fullUrl);
      folderId = u.searchParams.get('folderid') || '';
      lid = u.searchParams.get('lid') || '';
    } catch { return null; }
    if (!folderId) return null;
    const img = tr.querySelector('img');
    const imgSrc = img ? img.getAttribute('src') || '' : '';
    const isFolder = /folder\.gif|filefolder|directory/i.test(imgSrc) || /acttype=enter/.test(href);
    if (!isFolder && !/acttype=enter/.test(href)) return null;
    const url = fullUrl.includes('acttype=enter')
      ? fullUrl
      : absUrl('listview.jsp?acttype=enter&folderid=' + encodeURIComponent(folderId) + (lid ? '&lid=' + encodeURIComponent(lid) : ''), pageUrl);
    return { folderId, lid, name: sanitizeName(nameRaw), url };
  }

  function parseFileRow(tr, pageUrl) {
    const link = tr.querySelector("a[href*='download_preview.jsp']");
    if (!link) return null;
    let urlObj;
    try { urlObj = new URL(link.getAttribute('href') || '', pageUrl); } catch { return null; }
    const fileid = urlObj.searchParams.get('fileid') || '';
    const resid = urlObj.searchParams.get('resid') || '';
    const lid = urlObj.searchParams.get('lid') || '';
    if (!fileid || !resid || !lid) return null;
    let name = sanitizeName((link.textContent || '').trim() || '未命名');
    const iconExt = extFromRow(tr);
    if (!hasExt(name) && iconExt) name += '.' + iconExt;
    const ext = extOf(name) || iconExt;
    const downloadUrl = ORIGIN + '/meol/common/script/download.jsp?fileid=' + encodeURIComponent(fileid) +
      '&resid=' + encodeURIComponent(resid) + '&lid=' + encodeURIComponent(lid);
    return {
      id: lid + ':' + resid + ':' + fileid,
      name, originalName: sanitizeName((link.textContent || '').trim() || '未命名'),
      downloadUrl, previewUrl: absUrl(link.getAttribute('href') || '', pageUrl),
      fileid, resid, lid, ext, group: groupOf(ext), sizeText: '',
    };
  }

  function makeFolder(name, pathSegments, url) {
    return {
      type: 'folder', id: 'f_' + pathSegments.join('|') + '_' + (url || ''),
      name: sanitizeName(name), pathSegments: pathSegments.slice(), url: url || '',
      children: [], scanError: '',
    };
  }
  function makeFile(info, pathSegments) {
    return { type: 'file', ...info, pathSegments: pathSegments.slice() };
  }

  async function scanFolder(pageUrl, folderName, pathSegments, visited) {
    const html = await fetchGBKText(pageUrl);
    const doc = parseHTML(html);
    const folderNode = makeFolder(folderName, pathSegments, pageUrl);
    for (const tr of extractRows(doc)) {
      const file = parseFileRow(tr, pageUrl);
      if (file) { folderNode.children.push(makeFile(file, pathSegments)); continue; }
      const folder = parseFolderRow(tr, pageUrl);
      if (!folder || visited.has(folder.folderId)) continue;
      visited.add(folder.folderId);
      try {
        folderNode.children.push(await scanFolder(folder.url, folder.name, [...pathSegments, folder.name], visited));
      } catch (err) {
        const child = makeFolder(folder.name, [...pathSegments, folder.name], folder.url);
        child.scanError = err && err.message ? err.message : String(err);
        folderNode.children.push(child);
      }
      await sleep(40);
    }
    return folderNode;
  }

  function walkWindows(root) {
    const out = [], seen = new Set();
    function pushTree(start) {
      const q = [start];
      while (q.length) {
        const win = q.shift();
        if (!win || seen.has(win)) continue;
        seen.add(win);
        out.push(win);
        let n = 0;
        try { n = (win.frames && win.frames.length) || 0; } catch { n = 0; }
        for (let i = 0; i < n; i++) { try { q.push(win.frames[i]); } catch { /* */ } }
      }
    }
    pushTree(root);
    try { if (window.top && !seen.has(window.top)) pushTree(window.top); } catch { /* */ }
    return out;
  }

  function findListDocs() {
    const found = [];
    for (const win of walkWindows(window)) {
      try {
        const doc = win.document;
        if (!doc) continue;
        const href = win.location.href;
        const table = doc.querySelector('table.valuelist');
        const isList = /listview\.jsp|resFolderViewList\.do/i.test(href);
        if (table || isList) found.push({ win, doc, url: href, title: doc.title || '', hasTable: !!table, isUnitRes: /resFolderViewList\.do/i.test(href) });
      } catch { /* */ }
    }
    return found;
  }

  function extractPreviewLinks(doc, courseId) {
    const unique = new Map();
    for (const anchor of doc.querySelectorAll('a[href*="download_preview.jsp"]')) {
      try {
        const u = new URL(anchor.getAttribute('href'), doc.baseURI || ORIGIN);
        const fileid = u.searchParams.get('fileid') || '';
        const resid = u.searchParams.get('resid') || '';
        const lid = u.searchParams.get('lid') || '';
        if (!fileid || !resid || !lid) continue;
        if (courseId && lid !== courseId) continue;
        const id = lid + ':' + resid + ':' + fileid;
        if (unique.has(id)) continue;
        const row = anchor.closest('tr,li,div,td') || anchor.parentElement;
        let name = sanitizeName((anchor.textContent || '').trim() || '未命名');
        const iconExt = row ? extFromRow(row) : '';
        if (!hasExt(name) && iconExt) name += '.' + iconExt;
        const ext = extOf(name) || iconExt;
        unique.set(id, {
          id, name, originalName: sanitizeName((anchor.textContent || '').trim() || '未命名'),
          downloadUrl: u.origin + '/meol/common/script/download.jsp?fileid=' + encodeURIComponent(fileid) +
            '&resid=' + encodeURIComponent(resid) + '&lid=' + encodeURIComponent(lid),
          previewUrl: u.href, fileid, resid, lid, ext, group: groupOf(ext),
        });
      } catch { /* */ }
    }
    return [...unique.values()];
  }

  function parseUnitIndex(doc, pageUrl) {
    const entries = [], seen = new Set();
    const NON_UNIT = /^(单元学习|课程资源|课程活动|基本信息|首页|课程介绍|教学大纲|教学日历|教师信息|课程作业|在线测试|教学播课|学习分析|互动交流|课程通知|课程问卷|课程笔记|课程答疑)$/i;
    for (const anchor of doc.querySelectorAll('a[href*="course_column_preview_transfer.jsp"]')) {
      try {
        const u = new URL(anchor.getAttribute('href'), pageUrl);
        const columnId = u.searchParams.get('columnId');
        const tagbug = u.searchParams.get('tagbug');
        if (!columnId || tagbug !== 'client' || seen.has(columnId)) continue;
        const title = sanitizeName((anchor.textContent || '').replace(/\s+/g, ' ').trim() || '单元').slice(0, 120);
        if (NON_UNIT.test(title) || title.length < 2) continue;
        seen.add(columnId);
        entries.push({
          columnId, title,
          entryUrl: u.origin + u.pathname + '?tagbug=client&columnId=' + encodeURIComponent(columnId),
          order: entries.length,
        });
      } catch { /* */ }
    }
    return entries;
  }

  async function fetchUnitFiles(entryUrl) {
    const html = await fetchGBKText(entryUrl);
    const doc = parseHTML(html);
    let list = extractPreviewLinks(doc, undefined);
    const srcs = [...doc.querySelectorAll('iframe[src],frame[src]')].map((f) => absUrl(f.getAttribute('src') || '', entryUrl));
    const m = html.match(/resFolderViewList\.do[^"'\s]*/i);
    if (m) srcs.push(absUrl(m[0].replace(/&amp;/g, '&'), entryUrl));
    for (const src of srcs) {
      if (!src || !/course\.buct\.edu\.cn/i.test(src)) continue;
      if (!/resFolderViewList|listview|download_preview|colUrlStuView/i.test(src)) continue;
      try {
        const childDoc = parseHTML(await fetchGBKText(src));
        list = list.concat(extractPreviewLinks(childDoc, undefined));
      } catch { /* */ }
    }
    const seen = new Set(); const unique = [];
    for (const f of list) { if (!seen.has(f.id)) { seen.add(f.id); unique.push(f); } }
    return unique;
  }

  function flattenFiles(node, out = []) {
    if (!node) return out;
    if (node.type === 'file') out.push(node);
    for (const c of node.children || []) flattenFiles(c, out);
    return out;
  }

  function courseNameFromTitle(title) {
    const m = String(title || '').match(/网络课程\s*[—–-]\s*(.+)$/);
    if (m) return sanitizeName(m[1]).slice(0, 80);
    return sanitizeName(String(title || '').replace(/\s*[-—–|].*$/, '').trim() || '课件').slice(0, 80);
  }

  async function scan(mode) {
    const listDocs = findListDocs();
    const wantRes = mode !== 'unit-current' && mode !== 'unit-all';

    if (listDocs.length && wantRes) {
      let ctx = listDocs.find((d) => d.hasTable && !d.isUnitRes) || listDocs.find((d) => d.hasTable) || listDocs[0];
      const isUnitRes = !!ctx.isUnitRes;
      let lid = '', listUrl = ctx.url;
      try { lid = new URL(listUrl).searchParams.get('lid') || ''; } catch { /* */ }

      const currentFolder = makeFolder('当前目录', [], listUrl);
      for (const tr of extractRows(ctx.doc)) {
        const file = parseFileRow(tr, listUrl);
        if (file) { currentFolder.children.push(makeFile(file, [])); continue; }
        const folder = parseFolderRow(tr, listUrl);
        if (folder) {
          const ph = makeFolder(folder.name, [folder.name], folder.url);
          ph.folderId = folder.folderId;
          currentFolder.children.push(ph);
        }
      }

      let tree = currentFolder;
      if (mode !== 'directory' && !isUnitRes) {
        try {
          const rootUrl = lid ? absUrl('listview.jsp?acttype=enter&folderid=0&lid=' + encodeURIComponent(lid), listUrl) : listUrl;
          tree = await scanFolder(rootUrl, '课程资源', [], new Set());
        } catch {
          try { tree = await scanFolder(listUrl, '课程资源', [], new Set()); }
          catch (e2) { tree = currentFolder; tree.scanError = e2 && e2.message ? e2.message : String(e2); }
        }
      }

      let courseName = '课件';
      for (const win of walkWindows(window)) {
        try {
          const t = win.document && win.document.title;
          if (t && /网络课程/.test(t)) { courseName = courseNameFromTitle(t); break; }
        } catch { /* */ }
      }

      return {
        ok: true,
        surface: isUnitRes ? 'unit-study' : 'resource-directory',
        courseName,
        modes: isUnitRes ? ['directory', 'unit-current', 'unit-all'] : ['directory', 'tree'],
        defaultMode: isUnitRes ? 'unit-current' : mode === 'directory' ? 'directory' : 'tree',
        tree, currentFolder, files: flattenFiles(tree), unitIndex: [],
      };
    }

    // 单元学习
    let unitIndex = [];
    for (const win of walkWindows(window)) {
      try {
        const idx = parseUnitIndex(win.document, win.location.href);
        if (idx.length > unitIndex.length) unitIndex = idx;
      } catch { /* */ }
    }

    const files = [], seen = new Set();
    for (const win of walkWindows(window)) {
      try {
        for (const f of extractPreviewLinks(win.document, '')) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          files.push({ ...f, unitTitle: '当前单元' });
        }
      } catch { /* */ }
    }

    if (mode === 'unit-all') {
      if (!unitIndex.length) return { ok: false, error: '未找到单元列表，无法扫描全部单元' };
      const merged = new Map(files.map((f) => [f.id, f]));
      for (const entry of unitIndex) {
        try {
          for (const f of await fetchUnitFiles(entry.entryUrl)) {
            if (!merged.has(f.id)) merged.set(f.id, { ...f, unitTitle: entry.title });
          }
        } catch { /* */ }
        await sleep(50);
      }
      const tree = makeFolder('全部单元', [], location.href);
      for (const f of merged.values()) tree.children.push(makeFile(f, f.unitTitle ? [f.unitTitle] : []));
      return {
        ok: true, surface: 'unit-study', courseName: courseNameFromTitle(document.title),
        modes: unitIndex.length ? ['unit-current', 'unit-all'] : ['unit-current'],
        defaultMode: 'unit-current', tree, currentFolder: tree,
        files: [...merged.values()], unitIndex,
      };
    }

    const tree = makeFolder('当前单元', [], location.href);
    for (const f of files) tree.children.push(makeFile(f, []));
    return {
      ok: true, surface: 'unit-study', courseName: courseNameFromTitle(document.title),
      modes: unitIndex.length ? ['unit-current', 'unit-all'] : ['unit-current'],
      defaultMode: 'unit-current', tree, currentFolder: tree, files, unitIndex,
    };
  }

  // ---------- UI ----------
  const state = {
    courseName: '课件', surface: null, modes: [], mode: 'tree',
    tree: null, files: [], unitIndex: [],
    group: 'all', query: '', selected: new Set(), collapsed: new Set(),
    scanning: false, downloading: false,
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mountUI() {
    let host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.wrap {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  background: #f4f6fb; color: #1c2433;
  font: 14px/1.45 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.top {
  display: flex; align-items: center; gap: 16px; padding: 14px 20px;
  background: #fff; border-bottom: 1px solid #e4e8f0;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 180px; }
.mark {
  width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center;
  background: linear-gradient(145deg, #3b82f6, #1d4ed8); color: #fff; font-weight: 700;
}
.brand h1 { margin: 0; font-size: 15px; font-weight: 700; }
.brand p { margin: 2px 0 0; font-size: 12px; color: #6b7385; }
.meta { flex: 1; min-width: 0; }
.course { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { color: #6b7385; font-size: 12px; margin-top: 2px; }
.acts { display: flex; gap: 8px; }
button {
  font: inherit; border-radius: 10px; border: 1px solid #e4e8f0; background: #fff;
  color: #1c2433; padding: 8px 14px; cursor: pointer;
}
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.accent { background: #0f766e; border-color: #0f766e; color: #fff; }
button.ghost { border-color: transparent; background: transparent; color: #6b7385; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button:hover:not(:disabled) { filter: brightness(0.97); }
.scopes { display: flex; gap: 8px; padding: 12px 20px 0; flex-wrap: wrap; }
.scope {
  border: 1px solid #e4e8f0; background: #fff; color: #6b7385;
  border-radius: 999px; padding: 7px 13px; cursor: pointer; font: inherit; font-size: 13px;
}
.scope.active { background: #1c2433; border-color: #1c2433; color: #fff; }
.scope:disabled { opacity: 0.35; cursor: not-allowed; }
.toolbar {
  display: flex; align-items: center; gap: 10px; padding: 12px 20px; flex-wrap: wrap;
}
.types { display: flex; gap: 4px; flex-wrap: wrap; }
.type {
  border: 1px solid transparent; background: transparent; color: #6b7385;
  border-radius: 8px; padding: 5px 9px; cursor: pointer; font: inherit; font-size: 13px;
}
.type.active { background: #dbe7ff; color: #1d4ed8; border-color: #c7d8ff; font-weight: 600; }
.search {
  flex: 1; min-width: 160px; max-width: 280px; border: 1px solid #e4e8f0; border-radius: 10px;
  padding: 8px 12px; font: inherit; background: #fff; color: inherit;
}
.search:focus { outline: 2px solid #bfdbfe; border-color: #2563eb; }
.main {
  flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 14px;
  padding: 0 20px 14px; min-height: 0;
}
.panel {
  background: #fff; border: 1px solid #e4e8f0; border-radius: 12px; display: flex;
  flex-direction: column; min-height: 0; overflow: hidden;
}
.status {
  padding: 10px 14px; border-bottom: 1px solid #e4e8f0; color: #6b7385; font-size: 13px; background: #fafbff;
}
.status.ok { color: #0f766e; background: #f0fdfa; }
.status.err { color: #b91c1c; background: #fef2f2; }
.tree { overflow: auto; padding: 8px 6px 14px; flex: 1; }
.empty { padding: 40px 20px; text-align: center; color: #6b7385; }
.row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; }
.row:hover { background: #f3f6ff; }
.twisty {
  width: 18px; height: 18px; border: none; background: transparent; color: #6b7385;
  cursor: pointer; border-radius: 4px; font-size: 11px;
}
.twisty.leaf { visibility: hidden; }
.chk { width: 15px; height: 15px; accent-color: #2563eb; cursor: pointer; }
.ico {
  width: 18px; height: 18px; border-radius: 4px; display: inline-grid; place-items: center;
  font-size: 10px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.ico.folder { background: #d97706; }
.ico.pdf { background: #dc2626; }
.ico.ppt { background: #ea580c; }
.ico.word { background: #2563eb; }
.ico.excel { background: #15803d; }
.ico.archive { background: #6b7280; }
.ico.other { background: #7c3aed; }
.label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge, .ext { color: #6b7385; font-size: 12px; flex-shrink: 0; }
.ext { font-size: 11px; text-transform: uppercase; }
.kids { margin-left: 18px; border-left: 1px solid #e4e8f0; padding-left: 4px; }
.kids.collapsed { display: none; }
.side { display: flex; flex-direction: column; overflow: hidden; }
.side h2 { margin: 0; font-size: 13px; padding: 12px 14px 8px; }
.sel { padding: 12px 14px; border-top: 1px solid #e4e8f0; background: #fcfdff; font-size: 13px; }
.sel .muted { color: #6b7385; font-size: 12px; margin-top: 4px; }
.foot {
  padding: 8px 20px 12px; color: #6b7385; font-size: 12px;
}
@media (max-width: 900px) { .main { grid-template-columns: 1fr; } }
</style>
<div class="wrap" role="dialog" aria-label="北化课件下载标签版">
  <header class="top">
    <div class="brand">
      <div class="mark">⬇</div>
      <div><h1>北化课件下载</h1><p>标签版 · ${VERSION}</p></div>
    </div>
    <div class="meta">
      <div class="course" id="course">—</div>
      <div class="hint" id="hint">正在准备扫描…</div>
    </div>
    <div class="acts">
      <button class="primary" id="btnScan" type="button">扫描</button>
      <button class="accent" id="btnDl" type="button" disabled>下载所选</button>
      <button class="ghost" id="btnClose" type="button">关闭</button>
    </div>
  </header>
  <nav class="scopes" id="scopes" aria-label="扫描范围"></nav>
  <div class="toolbar">
    <div class="types" id="types">
      <button class="type active" data-g="all" type="button">全部</button>
      <button class="type" data-g="pdf" type="button">PDF</button>
      <button class="type" data-g="ppt" type="button">PPT</button>
      <button class="type" data-g="word" type="button">Word</button>
      <button class="type" data-g="excel" type="button">Excel</button>
      <button class="type" data-g="archive" type="button">压缩包</button>
      <button class="type" data-g="other" type="button">其他</button>
    </div>
    <input class="search" id="q" type="search" placeholder="搜索文件名…" />
    <button class="ghost" id="btnExp" type="button">展开</button>
    <button class="ghost" id="btnCol" type="button">折叠</button>
    <button class="ghost" id="btnSelVis" type="button">全选可见</button>
    <button class="ghost" id="btnClr" type="button">清空选择</button>
  </div>
  <div class="main">
    <section class="panel">
      <div class="status" id="status">尚未扫描</div>
      <div class="tree" id="tree" role="tree"></div>
    </section>
    <aside class="panel side">
      <h2>已选文件</h2>
      <div class="tree" id="selList" style="flex:1"></div>
      <div class="sel">
        <div>已选 <strong id="selN">0</strong> 个文件</div>
        <div class="muted">保存到：浏览器下载目录 / 课程名 / 目录 / 文件名</div>
        <div class="muted" id="dlNote"></div>
      </div>
    </aside>
  </div>
  <footer class="foot">非学校官方 · 仅用你的登录会话下载已授权课件 · 不上传任何数据 · 关闭面板不中断已触发的下载</footer>
</div>`;
    document.documentElement.appendChild(host);
    window.__buctTabDl = { host, shadow, close: () => host.remove() };

    const $ = (id) => shadow.getElementById(id);
    const els = {
      course: $('course'), hint: $('hint'), status: $('status'), tree: $('tree'),
      scopes: $('scopes'), types: $('types'), q: $('q'),
      btnScan: $('btnScan'), btnDl: $('btnDl'), btnClose: $('btnClose'),
      btnExp: $('btnExp'), btnCol: $('btnCol'), btnSelVis: $('btnSelVis'), btnClr: $('btnClr'),
      selList: $('selList'), selN: $('selN'), dlNote: $('dlNote'),
    };

    const MODE_LABEL = {
      directory: '当前目录', tree: '目录树', 'unit-current': '当前单元', 'unit-all': '全部单元',
    };

    function setStatus(t, k) {
      els.status.textContent = t;
      els.status.className = 'status' + (k ? ' ' + k : '');
    }

    function matches(f) {
      if (state.group !== 'all') {
        const g = f.group || groupOf(f.ext || '');
        if (g !== state.group) return false;
      }
      if (state.query) {
        const q = state.query.toLowerCase();
        const name = String(f.name || '').toLowerCase();
        const path = (f.pathSegments || []).join('/').toLowerCase();
        if (!name.includes(q) && !path.includes(q)) return false;
      }
      return true;
    }

    function nodeVisible(node) {
      if (node.type === 'file') return matches(node);
      if (flattenFiles(node).some(matches)) return true;
      if (state.query && String(node.name || '').toLowerCase().includes(state.query.toLowerCase())) return true;
      return false;
    }

    function collectVisible(node, out = []) {
      if (!node || !nodeVisible(node)) return out;
      if (node.type === 'file') { out.push(node); return out; }
      for (const c of node.children || []) collectVisible(c, out);
      return out;
    }

    function findNode(node, id) {
      if (!node) return null;
      if (node.id === id) return node;
      for (const c of node.children || []) {
        const hit = findNode(c, id);
        if (hit) return hit;
      }
      return null;
    }

    function setSubtree(node, checked) {
      if (node.type === 'file') {
        if (matches(node)) {
          if (checked) state.selected.add(node.id);
          else state.selected.delete(node.id);
        }
        return;
      }
      for (const c of node.children || []) setSubtree(c, checked);
    }

    function relPath(f) {
      const dir = (f.pathSegments || []).filter(Boolean).join('/');
      return dir ? dir + '/' + f.name : f.name;
    }

    function updateSel() {
      els.selN.textContent = String(state.selected.size);
      els.btnDl.disabled = state.selected.size === 0 || state.scanning || state.downloading;
      els.selList.innerHTML = '';
      for (const id of state.selected) {
        const f = state.files.find((x) => x.id === id);
        if (!f) continue;
        const d = document.createElement('div');
        d.className = 'row';
        d.innerHTML = '<span class="label"></span>';
        d.querySelector('.label').textContent = relPath(f);
        els.selList.appendChild(d);
      }
      for (const input of els.tree.querySelectorAll('input[data-id]')) {
        const id = input.dataset.id;
        if (input.dataset.kind === 'file') {
          input.checked = state.selected.has(id);
          input.indeterminate = false;
        } else {
          const node = findNode(state.tree, id);
          if (!node) continue;
          const files = flattenFiles(node).filter(matches);
          if (!files.length) { input.checked = false; input.indeterminate = false; input.disabled = true; continue; }
          input.disabled = false;
          const n = files.filter((f) => state.selected.has(f.id)).length;
          input.checked = n === files.length;
          input.indeterminate = n > 0 && n < files.length;
        }
      }
    }

    function renderScopes() {
      els.scopes.innerHTML = '';
      const modes = state.modes.length ? state.modes : ['directory', 'tree'];
      for (const mode of modes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scope' + (state.mode === mode ? ' active' : '');
        b.textContent = MODE_LABEL[mode] || mode;
        b.disabled = state.scanning;
        b.addEventListener('click', () => doScan(mode));
        els.scopes.appendChild(b);
      }
    }

    function iconClass(n) {
      if (n.type === 'folder') return 'folder';
      return n.group || groupOf(n.ext || '');
    }
    function iconLetter(n) {
      if (n.type === 'folder') return '▸';
      return ({ pdf: 'P', ppt: 'S', word: 'W', excel: 'X', archive: 'Z', other: 'F' })[iconClass(n)] || 'F';
    }

    function renderNode(node) {
      if (!nodeVisible(node)) return null;
      const wrap = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'row';
      const isFolder = node.type === 'folder';
      const collapsed = state.collapsed.has(node.id);

      const tw = document.createElement('button');
      tw.type = 'button';
      tw.className = 'twisty' + (isFolder ? '' : ' leaf');
      tw.textContent = collapsed ? '▶' : '▼';
      if (isFolder) tw.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
        else state.collapsed.add(node.id);
        renderTree();
      });

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'chk';
      chk.dataset.id = node.id;
      chk.dataset.kind = node.type;
      if (isFolder) {
        chk.addEventListener('change', () => { setSubtree(node, chk.checked); updateSel(); });
      } else {
        chk.checked = state.selected.has(node.id);
        chk.addEventListener('change', () => {
          if (chk.checked) state.selected.add(node.id);
          else state.selected.delete(node.id);
          updateSel();
        });
      }

      const ico = document.createElement('span');
      ico.className = 'ico ' + iconClass(node);
      ico.textContent = iconLetter(node);
      const lab = document.createElement('span');
      lab.className = 'label';
      lab.textContent = node.name;
      lab.title = relPath(node);
      row.append(tw, chk, ico, lab);

      if (isFolder) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(flattenFiles(node).filter(matches).length);
        row.appendChild(badge);
      } else {
        const ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = (node.ext || '').toUpperCase();
        row.appendChild(ext);
      }
      wrap.appendChild(row);
      if (isFolder) {
        const kids = document.createElement('div');
        kids.className = 'kids' + (collapsed ? ' collapsed' : '');
        for (const c of node.children || []) {
          const el = renderNode(c);
          if (el) kids.appendChild(el);
        }
        wrap.appendChild(kids);
      }
      return wrap;
    }

    function renderTree() {
      els.tree.innerHTML = '';
      if (!state.tree) {
        els.tree.innerHTML = '<div class="empty">点击「扫描」识别当前课程的课件。</div>';
        return;
      }
      const el = renderNode(state.tree);
      if (el) els.tree.appendChild(el);
      updateSel();
    }

    function expandDepth(node, d) {
      if (!node || d <= 0 || node.type !== 'folder') return;
      state.collapsed.delete(node.id);
      for (const c of node.children || []) expandDepth(c, d - 1);
    }

    function applyResult(result) {
      if (!result || !result.ok) {
        setStatus((result && result.error) || '扫描失败', 'err');
        state.tree = null; state.files = []; state.modes = [];
        renderTree(); renderScopes();
        return;
      }
      state.surface = result.surface;
      state.courseName = result.courseName || '课件';
      state.modes = result.modes || [];
      state.mode = result.defaultMode || state.modes[0] || 'tree';
      state.tree = result.tree;
      state.files = flattenFiles(result.tree);
      state.unitIndex = result.unitIndex || [];
      state.selected.clear();
      state.collapsed.clear();
      expandDepth(state.tree, 2);
      els.course.textContent = state.courseName;
      els.hint.textContent = result.surface === 'resource-directory'
        ? '课程资源 · 可扫当前目录或完整目录树'
        : '单元学习 · 可扫当前单元或全部单元';
      setStatus('发现 ' + state.files.length + ' 个文件。勾选后点「下载所选」。', 'ok');
      renderScopes();
      renderTree();
    }

    async function doScan(mode) {
      if (state.scanning) return;
      if (mode) state.mode = mode;
      if (state.mode === 'unit-all' && state.unitIndex.length) {
        const ok = confirm('将读取 ' + state.unitIndex.length + ' 个单元页面并汇总课件。\n只读取页面与文件信息，不会自动下载课件正文。确认扫描？');
        if (!ok) { setStatus('已取消全部单元扫描'); return; }
      }
      state.scanning = true;
      els.btnScan.disabled = true;
      els.btnDl.disabled = true;
      setStatus('正在扫描…');
      renderScopes();
      try {
        const result = await scan(state.mode);
        applyResult(result);
      } catch (e) {
        setStatus(e && e.message ? e.message : '扫描失败', 'err');
      }
      state.scanning = false;
      els.btnScan.disabled = false;
      updateSel();
    }

    function triggerDownload(url, filename) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.split('/').pop();
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    async function doDownload() {
      const items = [...state.selected]
        .map((id) => state.files.find((f) => f.id === id))
        .filter(Boolean);
      if (!items.length) return;
      state.downloading = true;
      els.btnDl.disabled = true;
      els.dlNote.textContent = 'Chrome 可能询问是否允许多个下载，请点允许。';
      setStatus('正在触发 ' + items.length + ' 个下载…', 'ok');
      let done = 0;
      for (const f of items) {
        triggerDownload(f.downloadUrl, (state.courseName || '课件') + '/' + relPath(f));
        done += 1;
        setStatus('已触发 ' + done + ' / ' + items.length + '：' + f.name, 'ok');
        await sleep(280);
      }
      setStatus('已触发全部 ' + items.length + ' 个下载。请到浏览器下载列表核对文件。', 'ok');
      els.dlNote.textContent = '「已触发」不等于「已保存完成」，请看浏览器下载记录。';
      state.downloading = false;
      updateSel();
    }

    els.btnScan.addEventListener('click', () => doScan());
    els.btnDl.addEventListener('click', () => doDownload());
    els.btnClose.addEventListener('click', () => host.remove());
    els.btnExp.addEventListener('click', () => { state.collapsed.clear(); renderTree(); });
    els.btnCol.addEventListener('click', () => {
      const walk = (n) => {
        if (n.type === 'folder') {
          state.collapsed.add(n.id);
          for (const c of n.children || []) walk(c);
        }
      };
      if (state.tree) walk(state.tree);
      renderTree();
    });
    els.btnSelVis.addEventListener('click', () => {
      for (const f of collectVisible(state.tree)) state.selected.add(f.id);
      updateSel();
    });
    els.btnClr.addEventListener('click', () => { state.selected.clear(); updateSel(); });
    els.q.addEventListener('input', () => { state.query = els.q.value.trim(); renderTree(); });
    els.types.addEventListener('click', (e) => {
      const b = e.target.closest('.type');
      if (!b) return;
      state.group = b.dataset.g;
      for (const x of els.types.querySelectorAll('.type')) x.classList.toggle('active', x === b);
      renderTree();
    });

    // 启动：自动扫描
    renderScopes();
    doScan();
  }

  mountUI();
})();
