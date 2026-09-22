/* 北化课件下载 · 标签版 v2.2 — 自包含书签
 * 弹窗；两个总标签「课程资源 / 单元学习」；
 * 进入课程页后独立拉取两侧资源（不依赖当前 frame 是否已打开资源列表）。
 */
(() => {
  'use strict';
  const VERSION = '2.2.0-tab';
  const HOST_ID = 'buct-tab-dl-host';

  if (location.protocol !== 'https:' && location.protocol !== 'http:') {
    alert('请在学校教学平台页面运行此书签');
    return;
  }
  if (!/course\.buct\.edu\.cn$/i.test(location.hostname)) {
    alert('请在 course.buct.edu.cn 的课程页运行「北化课件下载 · 标签版」');
    return;
  }

  const old = document.getElementById(HOST_ID);
  if (old) old.remove();
  if (window.__buctTabDl && window.__buctTabDl.close) {
    try { window.__buctTabDl.close(); } catch (_) {}
  }

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
    return img ? extFromIconSrc(img.getAttribute('src') || '') : '';
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
    let origin = ORIGIN;
    try { origin = new URL(pageUrl).origin; } catch { /* */ }
    const downloadUrl = origin + '/meol/common/script/download.jsp?fileid=' + encodeURIComponent(fileid) +
      '&resid=' + encodeURIComponent(resid) + '&lid=' + encodeURIComponent(lid);
    return {
      id: lid + ':' + resid + ':' + fileid,
      name, originalName: sanitizeName((link.textContent || '').trim() || '未命名'),
      downloadUrl, previewUrl: absUrl(link.getAttribute('href') || '', pageUrl),
      fileid, resid, lid, ext, group: groupOf(ext),
    };
  }

  function makeFolder(name, pathSegments, url) {
    return {
      type: 'folder', id: 'f_' + pathSegments.join('|') + '_' + (url || ''),
      name: sanitizeName(name), pathSegments: pathSegments.slice(), url: url || '',
      children: [], scanError: '',
    };
  }
  function makeFile(info, pathSegments, section) {
    return { type: 'file', ...info, pathSegments: pathSegments.slice(), section: section || 'resource' };
  }

  async function scanFolder(pageUrl, folderName, pathSegments, visited) {
    const html = await fetchGBKText(pageUrl);
    const doc = parseHTML(html);
    const folderNode = makeFolder(folderName, pathSegments, pageUrl);
    for (const tr of extractRows(doc)) {
      const file = parseFileRow(tr, pageUrl);
      if (file) { folderNode.children.push(makeFile(file, pathSegments, 'resource')); continue; }
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
      await sleep(35);
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

  /** 从任意 frame / URL / 链接里挖课程 id（lid 或 courseId） */
  function discoverCourseId() {
    const candidates = [];
    for (const win of walkWindows(window)) {
      try {
        const href = win.location.href;
        try {
          const u = new URL(href);
          const lid = u.searchParams.get('lid') || u.searchParams.get('courseId') || '';
          if (lid && /^\d+$/.test(lid)) candidates.push(lid);
        } catch { /* */ }
        for (const a of win.document.querySelectorAll('a[href]')) {
          const h = a.getAttribute('href') || '';
          if (!/lid=|courseId=/.test(h)) continue;
          try {
            const u = new URL(h, href);
            const lid = u.searchParams.get('lid') || u.searchParams.get('courseId') || '';
            if (lid && /^\d+$/.test(lid)) candidates.push(lid);
          } catch { /* */ }
        }
      } catch { /* */ }
    }
    // 去重，优先出现次数最多的
    const count = {};
    for (const id of candidates) count[id] = (count[id] || 0) + 1;
    const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : '';
  }

  function courseNameFromTitle(title) {
    const m = String(title || '').match(/网络课程\s*[—–-]\s*(.+)$/);
    if (m) return sanitizeName(m[1]).slice(0, 80);
    return sanitizeName(String(title || '').replace(/\s*[-—–|].*$/, '').trim() || '课件').slice(0, 80);
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

  function extractPreviewLinks(doc) {
    const unique = new Map();
    for (const anchor of doc.querySelectorAll('a[href*="download_preview.jsp"]')) {
      try {
        const u = new URL(anchor.getAttribute('href'), doc.baseURI || ORIGIN);
        const fileid = u.searchParams.get('fileid') || '';
        const resid = u.searchParams.get('resid') || '';
        const lid = u.searchParams.get('lid') || '';
        if (!fileid || !resid || !lid) continue;
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

  async function fetchUnitFiles(entryUrl) {
    const html = await fetchGBKText(entryUrl);
    const doc = parseHTML(html);
    let list = extractPreviewLinks(doc);
    const srcs = [...doc.querySelectorAll('iframe[src],frame[src]')].map((f) => absUrl(f.getAttribute('src') || '', entryUrl));
    const m = html.match(/resFolderViewList\.do[^"'\s]*/i);
    if (m) srcs.push(absUrl(m[0].replace(/&amp;/g, '&'), entryUrl));
    for (const src of srcs) {
      if (!src || !/course\.buct\.edu\.cn/i.test(src)) continue;
      if (!/resFolderViewList|listview|download_preview|colUrlStuView/i.test(src)) continue;
      try {
        list = list.concat(extractPreviewLinks(parseHTML(await fetchGBKText(src))));
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

  /** 一次汇总两侧，互不依赖当前 frame 是否已打开对应列表 */
  async function scanAll(onProgress) {
    const report = (t) => { if (onProgress) onProgress(t); };

    let courseName = '课件';
    for (const win of walkWindows(window)) {
      try {
        const t = win.document && win.document.title;
        if (t && /网络课程/.test(t)) { courseName = courseNameFromTitle(t); break; }
      } catch { /* */ }
    }

    const lid = discoverCourseId();
    const failures = [];
    let resourceTree = makeFolder('课程资源', [], location.href);
    resourceTree.id = 'section-resource';
    let unitTree = makeFolder('单元学习', ['单元学习'], location.href);
    unitTree.id = 'section-unit';

    // ---- 课程资源：无论当前在哪个页面，都主动拉 listview 根目录树 ----
    report('正在扫描课程资源目录树…');
    if (lid) {
      try {
        const rootUrl = ORIGIN + '/meol/common/script/listview.jsp?acttype=enter&folderid=0&lid=' + encodeURIComponent(lid);
        resourceTree = await scanFolder(rootUrl, '课程资源', [], new Set());
        resourceTree.id = 'section-resource';
      } catch (e1) {
        // 兼容其它 list 路径
        try {
          const alt = ORIGIN + '/meol/jpk/course/layout/newpage/listview.jsp?acttype=enter&folderid=0&lid=' + encodeURIComponent(lid);
          resourceTree = await scanFolder(alt, '课程资源', [], new Set());
          resourceTree.id = 'section-resource';
        } catch (e2) {
          resourceTree.scanError = (e2 && e2.message) || String(e2);
          failures.push({ section: '课程资源', title: '目录树', error: resourceTree.scanError });
        }
      }
    } else {
      // 从当前 frame 里已有的 listview 补扫
      let foundList = false;
      for (const win of walkWindows(window)) {
        try {
          if (!/listview\.jsp/i.test(win.location.href)) continue;
          if (!win.document || !win.document.querySelector('table.valuelist')) continue;
          foundList = true;
          resourceTree = await scanFolder(win.location.href, '课程资源', [], new Set());
          resourceTree.id = 'section-resource';
          break;
        } catch { /* */ }
      }
      if (!foundList) {
        resourceTree.scanError = '未能定位课程 id，请先进入课程资源或单元学习页面';
        failures.push({ section: '课程资源', title: '目录树', error: resourceTree.scanError });
      }
    }

    // ---- 单元学习：探测全部单元并逐个读取 ----
    report('正在探测全部单元…');
    let unitIndex = [];
    for (const win of walkWindows(window)) {
      try {
        const idx = parseUnitIndex(win.document, win.location.href);
        if (idx.length > unitIndex.length) unitIndex = idx;
      } catch { /* */ }
    }

    let unitFileCount = 0;
    if (unitIndex.length) {
      const merged = new Map();
      let done = 0;
      for (const entry of unitIndex) {
        done += 1;
        report('正在读取单元 ' + done + ' / ' + unitIndex.length + '：' + entry.title);
        try {
          const files = await fetchUnitFiles(entry.entryUrl);
          const folder = makeFolder(entry.title, ['单元学习', entry.title], entry.entryUrl);
          for (const f of files) {
            if (merged.has(f.id)) continue;
            merged.set(f.id, f);
            folder.children.push(makeFile(f, ['单元学习', entry.title], 'unit'));
          }
          unitTree.children.push(folder);
          unitFileCount += files.length;
        } catch (e) {
          failures.push({ section: '单元学习', title: entry.title, error: e && e.message ? e.message : String(e) });
          const folder = makeFolder(entry.title, ['单元学习', entry.title], entry.entryUrl);
          folder.scanError = e && e.message ? e.message : String(e);
          unitTree.children.push(folder);
        }
        await sleep(40);
      }
    } else {
      // 退回：当前 frame 里已有的预览链接
      const frameFiles = [];
      const seen = new Set();
      for (const win of walkWindows(window)) {
        try {
          for (const f of extractPreviewLinks(win.document)) {
            if (seen.has(f.id)) continue;
            seen.add(f.id);
            frameFiles.push(f);
          }
        } catch { /* */ }
      }
      if (frameFiles.length) {
        const folder = makeFolder('当前页面', ['单元学习', '当前页面'], location.href);
        for (const f of frameFiles) folder.children.push(makeFile(f, ['单元学习', '当前页面'], 'unit'));
        unitTree.children.push(folder);
        unitFileCount = frameFiles.length;
      } else {
        unitTree.scanError = '未探测到单元列表';
      }
    }

    const resourceFiles = flattenFiles(resourceTree);
    const unitFiles = flattenFiles(unitTree);
    return {
      ok: true,
      courseName,
      lid,
      resourceTree,
      unitTree,
      resourceFiles,
      unitFiles,
      stats: {
        resourceFiles: resourceFiles.length,
        units: unitIndex.length || (unitTree.children.length ? unitTree.children.length : 0),
        unitFiles: unitFiles.length,
        total: resourceFiles.length + unitFiles.length,
      },
      unitIndex,
      failures,
    };
  }

  // ---------- UI ----------
  const state = {
    courseName: '课件',
    tab: 'resource', // resource | unit
    resourceTree: null,
    unitTree: null,
    resourceFiles: [],
    unitFiles: [],
    files: [],
    stats: null,
    failures: [],
    group: 'all',
    query: '',
    selected: new Set(),
    collapsed: new Set(),
    scanning: false,
    downloading: false,
  };

  function mountUI() {
    let host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.scrim {
  position: absolute; inset: 0; pointer-events: auto;
  background: rgba(15, 23, 42, 0.38);
  backdrop-filter: blur(3px);
}
.dialog {
  pointer-events: auto;
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: min(980px, calc(100vw - 32px));
  height: min(700px, calc(100vh - 32px));
  display: flex; flex-direction: column;
  background: #fff; color: #0f172a;
  border-radius: 18px;
  box-shadow: 0 25px 70px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(15, 23, 42, 0.06);
  overflow: hidden;
  font: 14px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.dialog.dragging { user-select: none; }
.top {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 18px;
  background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 55%, #2563eb 140%);
  color: #fff; cursor: grab;
}
.top:active { cursor: grabbing; }
.mark {
  width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
  background: rgba(255,255,255,.14); font-size: 18px; flex-shrink: 0;
}
.titles { flex: 1; min-width: 0; }
.titles h1 { margin: 0; font-size: 16px; font-weight: 700; }
.sub { margin: 3px 0 0; font-size: 12px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stats { display: flex; gap: 8px; flex-wrap: wrap; }
.stat {
  background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.12);
  border-radius: 999px; padding: 4px 10px; font-size: 12px; white-space: nowrap;
}
.acts { display: flex; gap: 8px; }
button {
  font: inherit; border-radius: 10px; border: 1px solid transparent;
  padding: 8px 14px; cursor: pointer; transition: .15s ease;
}
button.primary { background: #fff; color: #0f172a; font-weight: 650; }
button.primary:hover { background: #e2e8f0; }
button.accent { background: #10b981; color: #042f1e; font-weight: 700; }
button.accent:hover { background: #34d399; }
button.ghost {
  background: rgba(255,255,255,.1); color: #fff; border-color: rgba(255,255,255,.12);
}
button.ghost:hover { background: rgba(255,255,255,.18); }
button.soft {
  background: #f1f5f9; color: #334155; border-color: #e2e8f0; font-size: 12px; padding: 6px 10px;
}
button.soft:hover { background: #e2e8f0; }
button:disabled { opacity: 0.45; cursor: not-allowed; }

.main-tabs {
  display: flex; gap: 8px; padding: 12px 16px 0; background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
}
.main-tab {
  border: 1px solid #e2e8f0; background: #fff; color: #64748b;
  border-radius: 12px 12px 0 0; border-bottom: none;
  padding: 10px 18px; cursor: pointer; font: inherit; font-weight: 650;
}
.main-tab:hover { color: #0f172a; }
.main-tab.active {
  background: #fff; color: #0f172a; border-color: #e2e8f0;
  box-shadow: 0 -2px 0 #2563eb inset;
}
.main-tab .cnt {
  display: inline-block; margin-left: 6px; background: #e2e8f0; color: #334155;
  border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 600;
}
.main-tab.active .cnt { background: #dbeafe; color: #1d4ed8; }

.status {
  padding: 8px 16px; font-size: 12px; color: #475569; background: #fff;
  border-bottom: 1px solid #f1f5f9; min-height: 34px; display: flex; align-items: center; gap: 8px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; flex-shrink: 0; }
.dot.ok { background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,.15); }
.dot.err { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.15); }
.dot.busy { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .45; } }

.toolbar {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid #e2e8f0; background: #fff; flex-wrap: wrap;
}
.types { display: flex; gap: 4px; flex-wrap: wrap; }
.type {
  border: 1px solid transparent; background: transparent; color: #64748b;
  border-radius: 999px; padding: 5px 11px; cursor: pointer; font: inherit; font-size: 12px;
}
.type:hover { background: #e2e8f0; color: #0f172a; }
.type.active { background: #0f172a; color: #fff; border-color: #0f172a; font-weight: 600; }
.search {
  flex: 1; min-width: 140px; max-width: 240px;
  border: 1px solid #e2e8f0; border-radius: 999px; padding: 7px 14px;
  font: inherit; background: #fff; color: inherit;
}
.search:focus { outline: 2px solid #93c5fd; border-color: #3b82f6; }

.body { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 300px; min-height: 0; }
.tree {
  overflow: auto; padding: 10px 8px 14px;
  background: radial-gradient(circle at top left, rgba(37,99,235,.05), transparent 40%), #fff;
}
.empty { padding: 48px 24px; text-align: center; color: #64748b; }
.empty strong { display: block; color: #0f172a; margin-bottom: 6px; font-size: 15px; }
.row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 10px; }
.row:hover { background: #f1f5f9; }
.twisty {
  width: 18px; height: 18px; border: none; background: transparent; color: #94a3b8;
  cursor: pointer; border-radius: 4px; font-size: 11px;
}
.twisty.leaf { visibility: hidden; }
.chk { width: 15px; height: 15px; accent-color: #2563eb; cursor: pointer; }
.ico {
  width: 20px; height: 20px; border-radius: 6px; display: inline-grid; place-items: center;
  font-size: 10px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.ico.folder { background: linear-gradient(145deg, #f59e0b, #d97706); }
.ico.pdf { background: linear-gradient(145deg, #ef4444, #b91c1c); }
.ico.ppt { background: linear-gradient(145deg, #f97316, #c2410c); }
.ico.word { background: linear-gradient(145deg, #3b82f6, #1d4ed8); }
.ico.excel { background: linear-gradient(145deg, #22c55e, #15803d); }
.ico.archive { background: linear-gradient(145deg, #64748b, #475569); }
.ico.other { background: linear-gradient(145deg, #8b5cf6, #6d28d9); }
.label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge, .ext { color: #94a3b8; font-size: 12px; flex-shrink: 0; }
.ext { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.kids { margin-left: 18px; border-left: 1px dashed #e2e8f0; padding-left: 4px; }
.kids.collapsed { display: none; }

.side {
  border-left: 1px solid #e2e8f0; background: #fcfdff;
  display: flex; flex-direction: column; min-height: 0;
}
.side h2 {
  margin: 0; font-size: 13px; padding: 14px 14px 8px; color: #334155;
  display: flex; justify-content: space-between; align-items: center;
}
.side .list { flex: 1; overflow: auto; padding: 0 8px 8px; }
.sec-label {
  font-size: 11px; font-weight: 700; letter-spacing: .04em;
  color: #1d4ed8; background: #eff6ff; border-radius: 6px;
  padding: 4px 8px; margin: 8px 4px 4px;
}
.sec-label.unit { color: #0f766e; background: #ecfdf5; }
.side .item {
  font-size: 12px; color: #475569; padding: 5px 8px; border-radius: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.side .item:hover { background: #f1f5f9; }
.tag {
  display: inline-block; font-size: 10px; font-weight: 700; border-radius: 4px;
  padding: 1px 5px; margin-right: 6px; vertical-align: middle;
}
.tag.resource { background: #dbeafe; color: #1d4ed8; }
.tag.unit { background: #d1fae5; color: #0f766e; }
.foot {
  padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #f8fafc;
}
.foot .meta { font-size: 12px; color: #64748b; }
.foot .meta strong { color: #0f172a; }
.note { font-size: 11px; color: #94a3b8; margin-top: 2px; }
@media (max-width: 760px) {
  .body { grid-template-columns: 1fr; }
  .side { display: none; }
  .stats { display: none; }
}
</style>
<div class="scrim" id="scrim"></div>
<div class="dialog" role="dialog" aria-label="北化课件下载标签版">
  <header class="top" id="dragBar">
    <div class="mark">⬇</div>
    <div class="titles">
      <h1>北化课件下载 · 标签版</h1>
      <p class="sub" id="course">正在识别课程…</p>
    </div>
    <div class="stats" id="stats"></div>
    <div class="acts">
      <button class="primary" id="btnScan" type="button">重新汇总</button>
      <button class="accent" id="btnDl" type="button" disabled>下载所选</button>
      <button class="ghost" id="btnClose" type="button">关闭</button>
    </div>
  </header>
  <nav class="main-tabs" id="mainTabs" aria-label="板块">
    <button class="main-tab active" data-tab="resource" type="button">课程资源 <span class="cnt" id="cntRes">0</span></button>
    <button class="main-tab" data-tab="unit" type="button">单元学习 <span class="cnt" id="cntUnit">0</span></button>
  </nav>
  <div class="status" id="status"><span class="dot busy"></span><span id="statusText">正在汇总课程资源与全部单元…</span></div>
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
    <button class="soft" id="btnExp" type="button">展开</button>
    <button class="soft" id="btnCol" type="button">折叠</button>
    <button class="soft" id="btnSelVis" type="button">全选可见</button>
    <button class="soft" id="btnClr" type="button">清空</button>
  </div>
  <div class="body">
    <div class="tree" id="tree" role="tree"></div>
    <aside class="side">
      <h2>已选 <span id="selN">0</span></h2>
      <div class="list" id="selList"></div>
      <div class="foot">
        <div class="meta">
          <div>保存到下载目录 / <strong id="saveName">课件</strong> / 目录</div>
          <div class="note" id="dlNote">已选会按「课程资源 / 单元学习」分组</div>
        </div>
      </div>
    </aside>
  </div>
</div>`;
    document.documentElement.appendChild(host);
    window.__buctTabDl = { host, shadow, close: () => host.remove() };

    const $ = (id) => shadow.getElementById(id);
    const els = {
      course: $('course'), stats: $('stats'), status: $('status'), statusText: $('statusText'),
      tree: $('tree'), types: $('types'), q: $('q'), mainTabs: $('mainTabs'),
      cntRes: $('cntRes'), cntUnit: $('cntUnit'),
      btnScan: $('btnScan'), btnDl: $('btnDl'), btnClose: $('btnClose'),
      btnExp: $('btnExp'), btnCol: $('btnCol'), btnSelVis: $('btnSelVis'), btnClr: $('btnClr'),
      selList: $('selList'), selN: $('selN'), saveName: $('saveName'), dlNote: $('dlNote'),
      dialog: shadow.querySelector('.dialog'), dragBar: $('dragBar'), scrim: $('scrim'),
    };

    (function enableDrag() {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      const dialog = els.dialog;
      function onDown(e) {
        if (e.target.closest('button, input')) return;
        dragging = true;
        dialog.classList.add('dragging');
        const rect = dialog.getBoundingClientRect();
        ox = rect.left; oy = rect.top;
        sx = e.clientX; sy = e.clientY;
        dialog.style.transform = 'none';
        dialog.style.left = ox + 'px';
        dialog.style.top = oy + 'px';
        e.preventDefault();
      }
      function onMove(e) {
        if (!dragging) return;
        dialog.style.left = Math.max(8, Math.min(window.innerWidth - 120, ox + e.clientX - sx)) + 'px';
        dialog.style.top = Math.max(8, Math.min(window.innerHeight - 80, oy + e.clientY - sy)) + 'px';
      }
      function onUp() { dragging = false; dialog.classList.remove('dragging'); }
      els.dragBar.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    })();

    function setStatus(text, kind) {
      els.statusText.textContent = text;
      const dot = els.status.querySelector('.dot');
      dot.className = 'dot' + (kind ? ' ' + kind : ' busy');
    }

    function currentTree() {
      return state.tab === 'unit' ? state.unitTree : state.resourceTree;
    }
    function currentFiles() {
      return state.tab === 'unit' ? state.unitFiles : state.resourceFiles;
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

    function findFile(id) {
      return state.files.find((x) => x.id === id);
    }

    function updateSel() {
      els.selN.textContent = String(state.selected.size);
      els.btnDl.disabled = state.selected.size === 0 || state.scanning || state.downloading;
      els.saveName.textContent = state.courseName || '课件';
      els.selList.innerHTML = '';

      const resSel = [];
      const unitSel = [];
      for (const id of state.selected) {
        const f = findFile(id);
        if (!f) continue;
        if (f.section === 'unit') unitSel.push(f);
        else resSel.push(f);
      }

      function addGroup(title, list, cls) {
        if (!list.length) return;
        const lab = document.createElement('div');
        lab.className = 'sec-label' + (cls ? ' ' + cls : '');
        lab.textContent = title + ' · ' + list.length;
        els.selList.appendChild(lab);
        for (const f of list) {
          const d = document.createElement('div');
          d.className = 'item';
          d.innerHTML = '<span class="tag ' + (f.section === 'unit' ? 'unit' : 'resource') + '"></span><span></span>';
          d.querySelector('.tag').textContent = f.section === 'unit' ? '单元' : '资源';
          d.querySelector('span:last-child').textContent = relPath(f);
          els.selList.appendChild(d);
        }
      }
      addGroup('课程资源', resSel, '');
      addGroup('单元学习', unitSel, 'unit');

      for (const input of els.tree.querySelectorAll('input[data-id]')) {
        const id = input.dataset.id;
        if (input.dataset.kind === 'file') {
          input.checked = state.selected.has(id);
          input.indeterminate = false;
        } else {
          const node = findNode(currentTree(), id);
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
      const tree = currentTree();
      const label = state.tab === 'unit' ? '单元学习' : '课程资源';
      if (!tree || (!tree.children || !tree.children.length) && tree.scanError) {
        els.tree.innerHTML = '<div class="empty"><strong>' + label + '暂无内容</strong>' + (tree && tree.scanError ? tree.scanError : '点「重新汇总」再试') + '</div>';
        return;
      }
      if (!tree) {
        els.tree.innerHTML = '<div class="empty"><strong>正在汇总…</strong>' + label + '会单独列出</div>';
        return;
      }
      const el = renderNode(tree);
      if (el) els.tree.appendChild(el);
      else els.tree.innerHTML = '<div class="empty"><strong>当前筛选下无文件</strong>可切换类型或清空搜索</div>';
      updateSel();
    }

    function renderStats(stats) {
      if (!stats) { els.stats.innerHTML = ''; return; }
      els.stats.innerHTML =
        '<span class="stat">资源 ' + stats.resourceFiles + '</span>' +
        '<span class="stat">单元 ' + stats.units + '</span>' +
        '<span class="stat">共 ' + stats.total + '</span>';
      els.cntRes.textContent = String(stats.resourceFiles);
      els.cntUnit.textContent = String(stats.unitFiles);
    }

    function expandDepth(node, d) {
      if (!node || d <= 0 || node.type !== 'folder') return;
      state.collapsed.delete(node.id);
      for (const c of node.children || []) expandDepth(c, d - 1);
    }

    function applyResult(result) {
      if (!result || !result.ok) {
        setStatus((result && result.error) || '汇总失败', 'err');
        return;
      }
      state.courseName = result.courseName || '课件';
      state.resourceTree = result.resourceTree;
      state.unitTree = result.unitTree;
      state.resourceFiles = result.resourceFiles || [];
      state.unitFiles = result.unitFiles || [];
      state.files = [...state.resourceFiles, ...state.unitFiles];
      state.stats = result.stats;
      state.failures = result.failures || [];
      state.selected.clear();
      state.collapsed.clear();
      expandDepth(state.resourceTree, 2);
      expandDepth(state.unitTree, 2);
      els.course.textContent = state.courseName + ' · 资源 ' + state.stats.resourceFiles + ' / 单元文件 ' + state.stats.unitFiles;
      renderStats(state.stats);
      let msg = '已汇总：课程资源 ' + state.stats.resourceFiles + ' 个，单元学习 ' + state.stats.unitFiles + ' 个（' + state.stats.units + ' 个单元）';
      if (state.failures.length) msg += '，' + state.failures.length + ' 项读取失败';
      setStatus(msg, state.failures.length ? '' : 'ok');
      renderTree();
    }

    async function doScan() {
      if (state.scanning) return;
      state.scanning = true;
      els.btnScan.disabled = true;
      els.btnDl.disabled = true;
      setStatus('正在一次性汇总课程资源与全部单元…', 'busy');
      renderTree();
      try {
        const result = await scanAll((t) => setStatus(t, 'busy'));
        applyResult(result);
      } catch (e) {
        setStatus(e && e.message ? e.message : '汇总失败', 'err');
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
      const items = [...state.selected].map(findFile).filter(Boolean);
      if (!items.length) return;
      state.downloading = true;
      els.btnDl.disabled = true;
      els.dlNote.textContent = 'Chrome 可能询问是否允许多个下载，请点允许。';
      setStatus('正在触发 ' + items.length + ' 个下载…', 'busy');
      let done = 0;
      for (const f of items) {
        const section = f.section === 'unit' ? '单元学习' : '课程资源';
        triggerDownload(f.downloadUrl, (state.courseName || '课件') + '/' + section + '/' + relPath(f));
        done += 1;
        setStatus('已触发 ' + done + ' / ' + items.length + '：' + f.name, 'busy');
        await sleep(260);
      }
      setStatus('已触发全部 ' + items.length + ' 个下载。请到浏览器下载列表核对。', 'ok');
      els.dlNote.textContent = '路径含「课程资源 / 单元学习」分组';
      state.downloading = false;
      updateSel();
    }

    els.mainTabs.addEventListener('click', (e) => {
      const b = e.target.closest('.main-tab');
      if (!b) return;
      state.tab = b.dataset.tab;
      for (const x of els.mainTabs.querySelectorAll('.main-tab')) x.classList.toggle('active', x === b);
      renderTree();
    });
    els.btnScan.addEventListener('click', () => doScan());
    els.btnDl.addEventListener('click', () => doDownload());
    els.btnClose.addEventListener('click', () => host.remove());
    els.scrim.addEventListener('click', () => host.remove());
    els.btnExp.addEventListener('click', () => { state.collapsed.clear(); renderTree(); });
    els.btnCol.addEventListener('click', () => {
      const walk = (n) => {
        if (n.type === 'folder') {
          state.collapsed.add(n.id);
          for (const c of n.children || []) walk(c);
        }
      };
      const tree = currentTree();
      if (tree) walk(tree);
      renderTree();
    });
    els.btnSelVis.addEventListener('click', () => {
      for (const f of collectVisible(currentTree())) state.selected.add(f.id);
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

    renderTree();
    doScan();
  }

  mountUI();
})();
