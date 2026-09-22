/* 北化课件下载 · 标签版 — content script
 * 适配 course.buct.edu.cn THEOL 真实结构：
 * - 课程资源壳： courseResource.jsp → left.jsp(目录树) + listview.jsp(列表)
 * - 列表表： table.valuelist
 * - 文件夹： listview.jsp?acttype=enter&folderid=&lid=  + folder.gif
 * - 文件：   preview/download_preview.jsp?fileid=&resid=&lid=
 * - 直下：   /meol/common/script/download.jsp?fileid=&resid=&lid=
 * - 单元：   course_column_preview_transfer.jsp?tagbug=client&columnId=
 * 页面编码多为 GBK。window.frames 必须按下标遍历。
 */

(() => {
  'use strict';
  if (window.__buctTheolScanBooted) return;
  window.__buctTheolScanBooted = true;

  const ORIGIN = 'https://course.buct.edu.cn';

  // 图标文件名 → 扩展名（THEOL 用 /meol/common/icons/*.gif）
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

  const COURSEWARE_EXT = new Set([
    'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx',
    'zip', 'rar', '7z', 'txt', 'jpg', 'jpeg', 'png', 'gif',
    'mp3', 'mp4', 'wav', 'avi', 'html', 'htm', 'swf',
  ]);

  const TYPE_GROUP = {
    pdf: 'pdf',
    ppt: 'ppt', pptx: 'ppt',
    doc: 'word', docx: 'word',
    xls: 'excel', xlsx: 'excel',
    zip: 'archive', rar: 'archive', '7z': 'archive',
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function sanitizeName(name) {
    return (
      String(name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '') || '未命名'
    );
  }

  function hasExtension(name) {
    const file = String(name || '').trim();
    if (!file) return false;
    return /\.[A-Za-z0-9]{1,8}$/.test(file.split(/[\\/]/).pop());
  }

  function extOf(name) {
    const m = String(name || '').trim().match(/\.([A-Za-z0-9]{1,8})$/);
    return m ? m[1].toLowerCase() : '';
  }

  function groupOf(ext) {
    return TYPE_GROUP[ext] || 'other';
  }

  function basename(path) {
    return String(path || '').split(/[\\/]/).pop().toLowerCase();
  }

  function extFromIconSrc(src) {
    if (!src) return '';
    const base = basename(src);
    if (base in ICON_EXT) return ICON_EXT[base];
    for (const key of Object.keys(ICON_EXT)) {
      if (base.includes(key.replace('.gif', ''))) return ICON_EXT[key];
    }
    return '';
  }

  function extFromClass(iconClass) {
    if (!iconClass) return '';
    const keys = Object.keys(CLASS_EXT).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (iconClass.includes(key)) return CLASS_EXT[key];
    }
    return '';
  }

  function extFromRow(tr) {
    const img = tr.querySelector('img[src*="icons/"], img[src*="image/"]');
    if (img) {
      const fromSrc = extFromIconSrc(img.getAttribute('src') || '');
      if (fromSrc) return fromSrc;
    }
    const span = tr.querySelector('span[class*="ico_"]');
    if (span) {
      const fromClass = extFromClass(span.className);
      if (fromClass) return fromClass;
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
    if (enc === 'gb2312' || enc === 'gbk' || enc === 'x-gbk') enc = 'gbk';
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {
      return new TextDecoder('gbk').decode(buf);
    }
  }

  function parseHTML(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function absUrl(href, base) {
    try {
      return new URL(href, base).href;
    } catch {
      return '';
    }
  }

  function extractRows(doc) {
    const table = doc.querySelector('table.valuelist') || doc.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('tr')).filter((tr) => tr.querySelector('td'));
  }

  function parseFolderRow(tr, pageUrl) {
    const link = tr.querySelector("a[href*='listview.jsp'][href*='acttype=enter'], a[href*='listview.jsp?acttype=enter']");
    if (!link) {
      // 兼容 left.jsp 树里的 listview.jsp?lid=&folderid= （无 acttype）
      const alt = tr.querySelector("a[href*='listview.jsp'][href*='folderid=']");
      if (!alt) return null;
    }
    const anchor =
      tr.querySelector("a[href*='listview.jsp?acttype=enter']") ||
      tr.querySelector("a[href*='listview.jsp'][href*='folderid=']");
    if (!anchor) return null;
    const href = anchor.getAttribute('href') || '';
    if (!href.includes('folderid=')) return null;
    // 过滤「返回上一级」
    const nameRaw = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (!nameRaw || /返回上一级/.test(nameRaw)) return null;
    const fullUrl = absUrl(href, pageUrl);
    if (!fullUrl) return null;
    let folderId = '';
    let lid = '';
    try {
      const u = new URL(fullUrl);
      folderId = u.searchParams.get('folderid') || '';
      lid = u.searchParams.get('lid') || '';
    } catch {
      return null;
    }
    if (!folderId) return null;
    // 确保是文件夹图标或目录链接
    const img = tr.querySelector('img');
    const imgSrc = img ? img.getAttribute('src') || '' : '';
    const isFolderIcon = /folder\.gif|filefolder|directory/i.test(imgSrc) || /acttype=enter/.test(href);
    if (!isFolderIcon && !/acttype=enter/.test(href)) return null;
    return {
      folderId,
      lid,
      name: sanitizeName(nameRaw),
      url: fullUrl.includes('acttype=enter')
        ? fullUrl
        : absUrl('listview.jsp?acttype=enter&folderid=' + encodeURIComponent(folderId) + (lid ? '&lid=' + encodeURIComponent(lid) : ''), pageUrl),
    };
  }

  function parseFileRow(tr, pageUrl) {
    const link = tr.querySelector("a[href*='download_preview.jsp']");
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    let urlObj;
    try {
      urlObj = new URL(href, pageUrl);
    } catch {
      return null;
    }
    const fileid = urlObj.searchParams.get('fileid') || '';
    const resid = urlObj.searchParams.get('resid') || '';
    const lid = urlObj.searchParams.get('lid') || '';
    if (!fileid || !resid || !lid) return null;

    let name = sanitizeName((link.textContent || '').trim() || '未命名');
    const iconExt = extFromRow(tr);
    if (!hasExtension(name) && iconExt) name += '.' + iconExt;
    let ext = extOf(name) || iconExt;

    let origin = ORIGIN;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      /* keep default */
    }
    const downloadUrl =
      origin +
      '/meol/common/script/download.jsp?fileid=' +
      encodeURIComponent(fileid) +
      '&resid=' +
      encodeURIComponent(resid) +
      '&lid=' +
      encodeURIComponent(lid);

    return {
      id: lid + ':' + resid + ':' + fileid,
      name,
      originalName: sanitizeName((link.textContent || '').trim() || '未命名'),
      downloadUrl,
      previewUrl: absUrl(href, pageUrl),
      iconSrc: (tr.querySelector('img') && tr.querySelector('img').getAttribute('src')) || '',
      fileid,
      resid,
      lid,
      ext,
      group: groupOf(ext),
    };
  }

  /** 从预览页取真实文件名、大小、下载入口（列表名常无后缀） */
  async function enrichFromPreview(file) {
    if (!file?.previewUrl) return file;
    if (hasExtension(file.originalName) && file.ext) return file;
    try {
      const html = await fetchGBKText(file.previewUrl);
      const doc = parseHTML(html);
      const text = (doc.body && doc.body.textContent) || '';
      const m = text.match(/文件名\s*[:：]\s*([^\n\r（(]+)/);
      if (m) {
        const real = sanitizeName(m[1]);
        if (real) {
          file.name = real;
          file.ext = extOf(real) || file.ext;
          file.group = groupOf(file.ext);
        }
      }
      const sizeM = text.match(/[（(]\s*(\d+(?:\.\d+)?\s*[KMGTB]?B?|字节)\s*[）)]/i);
      if (sizeM) file.sizeText = sizeM[1].replace(/\s+/g, '');
      for (const a of doc.querySelectorAll('a[href*="download.jsp"]')) {
        const dUrl = absUrl(a.getAttribute('href') || '', file.previewUrl);
        if (dUrl) {
          file.downloadUrl = dUrl;
          break;
        }
      }
    } catch {
      /* 保持列表名 */
    }
    return file;
  }

  function makeFolder(name, pathSegments, url) {
    return {
      type: 'folder',
      id: 'f_' + pathSegments.join('|') + '_' + (url || ''),
      name: sanitizeName(name),
      pathSegments: pathSegments.slice(),
      url: url || '',
      children: [],
      scanError: '',
    };
  }

  function makeFile(info, pathSegments) {
    return {
      type: 'file',
      id: info.id,
      name: info.name,
      originalName: info.originalName,
      pathSegments: pathSegments.slice(),
      downloadUrl: info.downloadUrl,
      previewUrl: info.previewUrl,
      iconSrc: info.iconSrc,
      fileid: info.fileid,
      resid: info.resid,
      lid: info.lid,
      ext: info.ext,
      group: info.group,
      sizeText: info.sizeText || '',
    };
  }

  function appendChild(parent, child) {
    parent.children.push(child);
  }

  // ---------- 课程资源：递归目录树 ----------

  async function scanFolder(pageUrl, folderName, pathSegments, visited) {
    const html = await fetchGBKText(pageUrl);
    const doc = parseHTML(html);
    const folderNode = makeFolder(folderName, pathSegments, pageUrl);
    const rows = extractRows(doc);

    for (const tr of rows) {
      const file = parseFileRow(tr, pageUrl);
      if (file) {
        appendChild(folderNode, makeFile(file, pathSegments));
        continue;
      }
      const folder = parseFolderRow(tr, pageUrl);
      if (!folder) continue;
      if (visited.has(folder.folderId)) continue;
      visited.add(folder.folderId);
      try {
        const child = await scanFolder(
          folder.url,
          folder.name,
          [...pathSegments, folder.name],
          visited
        );
        appendChild(folderNode, child);
      } catch (err) {
        const child = makeFolder(folder.name, [...pathSegments, folder.name], folder.url);
        child.scanError = err?.message || String(err);
        appendChild(folderNode, child);
      }
      await sleep(50);
    }
    return folderNode;
  }

  // ---------- 帧遍历（必须用下标） ----------

  function walkWindows(root) {
    const out = [];
    const seen = new Set();
    function pushTree(start) {
      const queue = [start];
      while (queue.length) {
        const win = queue.shift();
        if (!win || seen.has(win)) continue;
        seen.add(win);
        out.push(win);
        let n = 0;
        try {
          n = (win.frames && win.frames.length) || 0;
        } catch {
          n = 0;
        }
        for (let i = 0; i < n; i++) {
          try {
            queue.push(win.frames[i]);
          } catch {
            /* ignore */
          }
        }
      }
    }
    pushTree(root);
    try {
      if (window.top && !seen.has(window.top)) pushTree(window.top);
    } catch {
      /* ignore */
    }
    return out;
  }

  function findResourceContexts() {
    const found = [];
    for (const win of walkWindows(window)) {
      try {
        const doc = win.document;
        if (!doc) continue;
        const href = win.location.href;
        const table = doc.querySelector('table.valuelist');
        const isList = /listview\.jsp/i.test(href);
        const isShell = /courseResource\.jsp/i.test(href);
        const isLeft = /left\.jsp/i.test(href);
        // 单元学习资源列表：resFolderViewList.do?folderid=&lid=&columnId=
        const isUnitResList = /resFolderViewList\.do/i.test(href);
        if (table || isList || isShell || isLeft || isUnitResList) {
          found.push({
            win,
            doc,
            url: href,
            title: doc.title || '',
            isList: isList || isUnitResList,
            isShell,
            isLeft,
            isUnitResList,
            hasTable: !!table,
          });
        }
      } catch {
        /* ignore */
      }
    }
    return found;
  }

  function findUnitDocs() {
    const found = [];
    for (const win of walkWindows(window)) {
      try {
        const winUrl = win.location.href;
        const doc = win.document;
        if (!doc) continue;
        if (
          /course_column_preview_transfer\.jsp/i.test(winUrl) ||
          /layout\/(lesson|newpage)\/index\.jsp/i.test(winUrl) ||
          /colUrlStuView\.do/i.test(winUrl) ||
          /resFolderViewList\.do/i.test(winUrl) ||
          /unitstudy|lesson|newpage/i.test(winUrl)
        ) {
          found.push({ win, doc, url: winUrl, title: doc.title || '' });
        }
        // 单元内容也可能挂在普通 document 里，靠预览链接+单元标题识别
        const hasPreview = doc.querySelector("a[href*='download_preview.jsp']");
        const hasUnitNav = doc.querySelector("a[href*='course_column_preview_transfer.jsp']");
        if (hasPreview && hasUnitNav && !found.some((f) => f.win === win)) {
          found.push({ win, doc, url: winUrl, title: doc.title || '', soft: true });
        }
      } catch {
        /* ignore */
      }
    }
    return found;
  }

  function courseNameFromTitle(title) {
    const m = String(title || '').match(/网络课程\s*[—–-]\s*(.+)$/);
    if (m) return sanitizeName(m[1]).slice(0, 80);
    const m2 = String(title || '').replace(/\s*[-—–|].*$/, '').trim();
    return sanitizeName(m2 || '课件').slice(0, 80);
  }

  // ---------- 单元学习 ----------

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
        if (!hasExtension(name) && iconExt) name += '.' + iconExt;
        const ext = extOf(name) || iconExt;
        unique.set(id, {
          id,
          name,
          originalName: sanitizeName((anchor.textContent || '').trim() || '未命名'),
          downloadUrl:
            u.origin +
            '/meol/common/script/download.jsp?fileid=' +
            encodeURIComponent(fileid) +
            '&resid=' +
            encodeURIComponent(resid) +
            '&lid=' +
            encodeURIComponent(lid),
          previewUrl: u.href,
          fileid,
          resid,
          lid,
          ext,
          group: groupOf(ext),
        });
      } catch {
        /* ignore */
      }
    }
    return [...unique.values()];
  }

  function parseUnitIndex(doc, pageUrl) {
    const entries = [];
    const seen = new Set();
    // 课程栏目（非学习单元）——出现在导航/侧栏，不能当成单元
    const NON_UNIT = /^(单元学习|课程资源|课程活动|基本信息|首页|课程介绍|教学大纲|教学日历|教师信息|课程作业|在线测试|教学播课|学习分析|互动交流|课程通知|课程问卷|课程笔记|课程答疑|课程wiki|课程博客|研究性学习|课程作业|试题库|试卷库|作业库|课程管理|课程信息|课程公告)$/i;
    for (const anchor of doc.querySelectorAll('a[href*="course_column_preview_transfer.jsp"]')) {
      try {
        const u = new URL(anchor.getAttribute('href'), pageUrl);
        const columnId = u.searchParams.get('columnId');
        const tagbug = u.searchParams.get('tagbug');
        if (!columnId || tagbug !== 'client') continue;
        if (seen.has(columnId)) continue;
        const title = sanitizeName((anchor.textContent || '').replace(/\s+/g, ' ').trim() || '单元').slice(0, 120);
        if (NON_UNIT.test(title)) continue;
        // 过滤过短/过长噪音
        if (title.length < 2) continue;
        seen.add(columnId);
        entries.push({
          columnId,
          entryUrl: u.origin + u.pathname + '?tagbug=client&columnId=' + encodeURIComponent(columnId),
          title,
          order: entries.length,
        });
      } catch {
        /* ignore */
      }
    }
    return entries;
  }

  async function fetchUnitPage(entryUrl) {
    const html = await fetchGBKText(entryUrl);
    const doc = parseHTML(html);
    // 入口可能是壳：再抓一层 resFolderViewList.do / iframe
    let list = extractPreviewLinks(doc, undefined);
    const frameSrcs = [...doc.querySelectorAll('iframe[src],frame[src]')].map((f) =>
      absUrl(f.getAttribute('src') || '', entryUrl)
    );
    // 文档内重定向/脚本里的 resFolderViewList
    const bodyHtml = html;
    const m = bodyHtml.match(/resFolderViewList\.do[^"'\s]*/i);
    if (m) {
      frameSrcs.push(absUrl(m[0].replace(/&amp;/g, '&'), entryUrl));
    }
    for (const src of frameSrcs) {
      if (!src || !/course\.buct\.edu\.cn/i.test(src)) continue;
      if (!/resFolderViewList|listview|download_preview|colUrlStuView/i.test(src)) continue;
      try {
        const childDoc = parseHTML(await fetchGBKText(src));
        list = list.concat(extractPreviewLinks(childDoc, undefined));
        // 再跟一层
        for (const f2 of childDoc.querySelectorAll('iframe[src],frame[src]')) {
          const src2 = absUrl(f2.getAttribute('src') || '', src);
          if (src2 && /course\.buct\.edu\.cn/i.test(src2)) {
            try {
              list = list.concat(extractPreviewLinks(parseHTML(await fetchGBKText(src2)), undefined));
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    // 去重
    const seen = new Set();
    const unique = [];
    for (const f of list) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      unique.push(f);
    }
    return unique;
  }

  async function scanAllUnits(unitIndex, courseId) {
    const files = [];
    const seen = new Set();
    const failures = [];
    for (const entry of unitIndex) {
      try {
        const list = await fetchUnitPage(entry.entryUrl);
        for (const f of list) {
          if (courseId && f.lid && f.lid !== courseId) continue;
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          files.push({ ...f, unitTitle: entry.title });
        }
      } catch (err) {
        failures.push({ title: entry.title, error: err?.message || String(err) });
      }
      await sleep(60);
    }
    return { files, failures };
  }

  // ---------- 对外扫描入口 ----------

  async function scan(options = {}) {
    const mode = options.mode || 'auto'; // auto | directory | tree | unit-current | unit-all
    const recursive = options.recursive !== false;

    // 1) 课程资源
    const resourceDocs = findResourceContexts();
    const listDocs = resourceDocs.filter((d) => d.isList || d.hasTable);
    const wantResource = mode !== 'unit-current' && mode !== 'unit-all';

    if (listDocs.length && wantResource) {
      // 优先取带 table 的 listview（课程资源）；单元资源列表也走这里但 surface 不同
      let ctx =
        listDocs.find((d) => d.hasTable && d.isList && !d.isUnitResList) ||
        listDocs.find((d) => d.hasTable && d.isList) ||
        listDocs.find((d) => d.hasTable) ||
        listDocs[0];
      const isUnitRes = !!ctx.isUnitResList || /resFolderViewList\.do/i.test(ctx.url);
      let listUrl = ctx.url;
      let lid = '';
      let folderId = '0';
      try {
        const u = new URL(listUrl);
        lid = u.searchParams.get('lid') || '';
        folderId = u.searchParams.get('folderid') || '0';
      } catch {
        /* ignore */
      }

      // 当前目录
      const currentFolder = makeFolder('当前目录', [], listUrl);
      for (const tr of extractRows(ctx.doc)) {
        const file = parseFileRow(tr, listUrl);
        if (file) {
          appendChild(currentFolder, makeFile(file, []));
          continue;
        }
        const folder = parseFolderRow(tr, listUrl);
        if (folder) {
          const placeholder = makeFolder(folder.name, [folder.name], folder.url);
          placeholder.folderId = folder.folderId;
          appendChild(currentFolder, placeholder);
        }
      }

      // 树：仅课程资源 listview 递归；单元 resFolderViewList 只扫当前列表
      let tree = currentFolder;
      if (recursive && mode !== 'directory' && !isUnitRes) {
        try {
          const rootUrl =
            lid
              ? absUrl('listview.jsp?acttype=enter&folderid=0&lid=' + encodeURIComponent(lid), listUrl)
              : listUrl;
          tree = await scanFolder(rootUrl, '课程资源', [], new Set());
        } catch (err) {
          try {
            tree = await scanFolder(listUrl, '课程资源', [], new Set());
          } catch (err2) {
            tree = currentFolder;
            tree.scanError = err2?.message || String(err2);
          }
        }
      }

      // 补全无后缀文件的真实文件名（有限并发）
      const flat = [];
      const walk = (n) => {
        if (n.type === 'file') flat.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(tree);
      const need = flat.filter((f) => !hasExtension(f.name) || !f.ext);
      let idx = 0;
      async function enrichWorker() {
        while (idx < need.length) {
          const f = need[idx++];
          await enrichFromPreview(f);
          await sleep(30);
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, need.length || 0) }, enrichWorker));

      // 课程名：优先顶层 document 标题
      let courseName = '课件';
      for (const win of walkWindows(window)) {
        try {
          const t = win.document && win.document.title;
          if (t && /网络课程/.test(t)) {
            courseName = courseNameFromTitle(t);
            break;
          }
        } catch {
          /* ignore */
        }
      }

      return {
        ok: true,
        surface: isUnitRes ? 'unit-study' : 'resource-directory',
        courseName,
        modes: isUnitRes
          ? ['directory', 'unit-current', 'unit-all']
          : ['directory', 'tree'],
        defaultMode: isUnitRes ? 'unit-current' : mode === 'directory' ? 'directory' : 'tree',
        tree,
        currentFolder,
        files: flattenFiles(tree),
        unitIndex: [],
        failures: [],
      };
    }

    // 2) 单元学习
    const unitDocs = findUnitDocs();
    if (unitDocs.length) {
      const ctx = unitDocs.find((d) => !d.soft) || unitDocs[0];
      let courseId = '';
      try {
        courseId = new URL(ctx.url).searchParams.get('courseId') ||
          new URL(ctx.url).searchParams.get('lid') || '';
      } catch {
        /* ignore */
      }

      const files = [];
      const seen = new Set();
      for (const item of walkWindows(ctx.win)) {
        try {
          for (const f of extractPreviewLinks(item.document, courseId)) {
            if (seen.has(f.id)) continue;
            seen.add(f.id);
            files.push({ ...f, unitTitle: '当前单元' });
          }
        } catch {
          /* ignore */
        }
      }

      let unitIndex = [];
      try {
        unitIndex = parseUnitIndex(ctx.doc, ctx.url);
      } catch {
        unitIndex = [];
      }
      // 也从顶层抓单元索引
      if (!unitIndex.length) {
        try {
          unitIndex = parseUnitIndex(document, location.href);
        } catch {
          unitIndex = [];
        }
      }

      if (mode === 'unit-all') {
        if (!unitIndex.length) {
          return {
            ok: false,
            code: 'NO_UNIT_INDEX',
            error: '未找到单元列表，无法扫描全部单元',
          };
        }
        const all = await scanAllUnits(unitIndex, courseId);
        const merged = new Map();
        for (const f of files) merged.set(f.id, f);
        for (const f of all.files) {
          if (!merged.has(f.id)) merged.set(f.id, f);
        }
        const tree = makeFolder('全部单元', [], ctx.url);
        for (const f of merged.values()) {
          appendChild(tree, makeFile(f, f.unitTitle ? [f.unitTitle] : []));
        }
        return {
          ok: true,
          surface: 'unit-study',
          courseName: courseNameFromTitle(ctx.title || document.title),
          modes: unitIndex.length ? ['unit-current', 'unit-all'] : ['unit-current'],
          defaultMode: 'unit-current',
          tree,
          currentFolder: tree,
          files: [...merged.values()],
          unitIndex,
          failures: all.failures,
        };
      }

      const tree = makeFolder('当前单元', [], ctx.url);
      for (const f of files) appendChild(tree, makeFile(f, []));
      return {
        ok: true,
        surface: 'unit-study',
        courseName: courseNameFromTitle(ctx.title || document.title),
        modes: unitIndex.length ? ['unit-current', 'unit-all'] : ['unit-current'],
        defaultMode: 'unit-current',
        tree,
        currentFolder: tree,
        files,
        unitIndex,
        failures: [],
      };
    }

    return {
      ok: false,
      code: 'UNSUPPORTED_PAGE',
      error: '请进入「课程资源」目录或「单元学习」页面后再扫描',
    };
  }

  function flattenFiles(node) {
    const out = [];
    const walk = (n) => {
      if (n.type === 'file') out.push(n);
      for (const c of n.children || []) walk(c);
    };
    walk(node);
    return out;
  }

  function shouldHandleScan() {
    const href = location.href;
    const hasList = !!document.querySelector('table.valuelist');
    const isListUrl = /listview\.jsp|courseResource\.jsp|left\.jsp|resFolderViewList\.do/i.test(href);
    const isUnitUrl = /course_column_preview_transfer|layout\/(lesson|newpage)|colUrlStuView|unitstudy/i.test(href);
    return hasList || isListUrl || isUnitUrl || window === window.top;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'BUCT_SCAN') return false;
    if (!shouldHandleScan()) return false;
    scan(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || '扫描失败' });
    });
    return true;
  });
})();
