import { RELEASE_VERSION } from "../src/runtime/version.js";
import { createCourseScanner } from "../src/runtime/scanner.js";
import { flattenFiles, groupOf, safeSegment, validateFile, requiresPreparedDownload, isPreviewSource, problem, isDownloadable, availabilityCounts, trimWhitespace, schoolUrl, previewSummary, previewNotice } from "../src/runtime/policy.js";
import { preflightFile, checkCancelled } from "../src/runtime/network.js";
import { DEFAULT_SETTINGS, normalizeSettings, planDownload, createArchive } from "../src/runtime/archive.js";

/* 课程资源助手 — 自包含书签
 * 弹窗；课程资源 / 单元学习；优先 ZIP；可配置目录结构与打包策略。
 */
(() => {
  'use strict';
  const VERSION = RELEASE_VERSION;
  const HOST_ID = 'buct-tab-dl-host';
  const SETTINGS_KEY = 'buct-dl-settings-v1';

  if (location.protocol !== 'https:' && location.protocol !== 'http:') {
    alert('请在学校教学平台页面运行此书签');
    return;
  }
  if (location.hostname.toLowerCase() !== 'course.buct.edu.cn') {
    alert('请在 course.buct.edu.cn 的课程页运行「课程资源助手」');
    return;
  }

  const previous = window.__buctTabDl;
  if (previous?.version === VERSION && previous.host?.isConnected) { previous.show(); return; }
  if (previous?.destroy) previous.destroy();
  else if (previous?.close) previous.close();
  document.getElementById(HOST_ID)?.remove();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let scannerWindow = window;
  try { if (window.top.location.origin === location.origin) scannerWindow = window.top; } catch { /* isolated frame */ }
  const makeScanner = (options = {}) => createCourseScanner({ window: scannerWindow, ...options });

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(next) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* */ }
  }

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
    settings: loadSettings(),
    showSettings: false,
    activeAbort: null,
    contextKey: null,
    destroyed: false,
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
.acts { display: flex; gap: 8px; flex-shrink: 0; }
button {
  font: inherit; border-radius: 10px; border: 1px solid transparent; white-space: nowrap;
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
.dot.warn { background: #b45309; box-shadow: 0 0 0 3px rgba(180,83,9,.12); }
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
.row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 10px; min-height: 28px; }
.row:hover { background: #f1f5f9; }
.twisty {
  width: 18px; height: 18px; border: none; background: transparent; color: #94a3b8;
  cursor: pointer; border-radius: 4px; font-size: 10px; line-height: 1;
  padding: 0; margin: 0; display: inline-grid; place-items: center;
  flex-shrink: 0; user-select: none;
}
.twisty:hover { background: #e2e8f0; color: #334155; }
.twisty.leaf { visibility: hidden; }
.chk { width: 15px; height: 15px; accent-color: #2563eb; cursor: pointer; margin: 0; flex-shrink: 0; }
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
.label { flex: 1; min-width: 0; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
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
.settings { padding: 12px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
.settings h3 { margin: 0 0 10px; font-size: 13px; color: #334155; }
.set-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.set-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #475569; }
.set-grid select, .set-grid input {
  font: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid #e2e8f0;
  border-radius: 8px; background: #fff; color: #0f172a;
}
.set-note { margin: 10px 0 0; font-size: 11px; color: #94a3b8; }
.set-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
@media (max-width: 760px) {
  .body { grid-template-columns: 1fr; }
  .side { display: none; }
  .stats { display: none; }
  .top { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 10px; padding: 12px; flex-shrink: 0; }
  .titles h1 { white-space: nowrap; }
  .acts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
  .acts button { flex: 1 1 auto; padding: 7px 10px; min-height: 36px; }
  .main-tabs, .status, .toolbar { flex-shrink: 0; }
  .settings { flex-shrink: 0; max-height: 48vh; overflow: auto; }
  .set-grid { grid-template-columns: minmax(0, 1fr); }
  .set-grid select, .set-grid input { min-width: 0; width: 100%; }
}
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.top button:focus-visible { outline-color: #fff; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
.file-note { padding: 0 12px 8px 64px; font-size: 12px; color: #64748b; overflow-wrap: anywhere; }
.file-note a { color: #1d4ed8; text-underline-offset: 2px; }
</style>
<div class="scrim" id="scrim"></div>
<div class="dialog" role="dialog" aria-label="课程资源助手">
  <header class="top" id="dragBar">
    <div class="mark">⬇</div>
    <div class="titles">
      <h1>课程资源助手</h1>
      <p class="sub" id="course">正在识别课程…</p>
    </div>
    <div class="stats" id="stats"></div>
    <div class="acts">
      <button class="primary" id="btnScan" type="button">重新汇总</button>
      <button class="accent" id="btnDl" type="button" disabled>下载所选</button>
      <button class="ghost" id="btnSettings" type="button">设置</button>
      <button class="ghost" id="btnCancel" type="button" disabled>停止</button>
      <button class="ghost" id="btnClose" type="button">关闭</button>
    </div>
  </header>
  <nav class="main-tabs" id="mainTabs" aria-label="板块">
    <button class="main-tab active" data-tab="resource" type="button">课程资源 <span class="cnt" id="cntRes">0</span></button>
    <button class="main-tab" data-tab="unit" type="button">单元学习 <span class="cnt" id="cntUnit">0</span></button>
  </nav>
  <div class="status" id="status" role="status" aria-live="polite"><span class="dot busy"></span><span id="statusText">正在汇总课程资源与全部单元…</span></div>
  <div class="settings" id="settingsPanel" hidden>
    <h3>下载设置</h3>
    <div class="set-grid">
      <label>打包方式
        <select id="setZipMode">
          <option value="auto">自动（优先 ZIP）</option>
          <option value="always">优先打包 ZIP（不突破上限）</option>
          <option value="never">始终批量逐个</option>
        </select>
      </label>
      <label>ZIP 内目录
        <select id="setFlatten">
          <option value="0">保留目录结构</option>
          <option value="1">不要文件夹，文件平铺</option>
        </select>
      </label>
      <label>ZIP 体积上限 (MB)
        <input id="setZipMb" type="number" min="10" max="512" step="10" />
      </label>
      <label>ZIP 文件数上限
        <input id="setZipFiles" type="number" min="1" max="500" step="1" />
      </label>
    </div>
    <p class="set-note">ZIP 在本页内存中生成，实际占用可能高于文件总体积；建议保持默认上限。设置仅存本机。</p>
    <div class="set-actions">
      <button class="soft" id="setReset" type="button">恢复默认</button>
      <button class="accent" id="setSave" type="button">保存设置</button>
    </div>
  </div>
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
    <input class="search" id="q" type="search" aria-label="搜索文件名" placeholder="搜索文件名…" />
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
          <div>ZIP 文件名：<strong id="saveName">课件</strong>.zip</div>
          <div class="note" id="dlNote">已选会按「课程资源 / 单元学习」分组</div><div id="downloadReport" class="note" role="status" aria-live="polite"></div>
        </div>
      </div>
    </aside>
  </div>
</div>`;
    (document.body || document.documentElement).appendChild(host);


    const $ = (id) => shadow.getElementById(id);
    const els = {
      course: $('course'), stats: $('stats'), status: $('status'), statusText: $('statusText'),
      tree: $('tree'), types: $('types'), q: $('q'), mainTabs: $('mainTabs'),
      cntRes: $('cntRes'), cntUnit: $('cntUnit'),
      btnScan: $('btnScan'), btnDl: $('btnDl'), btnClose: $('btnClose'), btnCancel: $('btnCancel'), btnSettings: $('btnSettings'),
      btnExp: $('btnExp'), btnCol: $('btnCol'), btnSelVis: $('btnSelVis'), btnClr: $('btnClr'),
      selList: $('selList'), selN: $('selN'), saveName: $('saveName'), dlNote: $('dlNote'), downloadReport: $('downloadReport'),
      dialog: shadow.querySelector('.dialog'), dragBar: $('dragBar'), scrim: $('scrim'),
      settingsPanel: $('settingsPanel'), setZipMode: $('setZipMode'), setFlatten: $('setFlatten'),
      setZipMb: $('setZipMb'), setZipFiles: $('setZipFiles'), setReset: $('setReset'), setSave: $('setSave'),
    };

    const listeners = new AbortController();
    const beforeUnload = event => { if (state.scanning || state.downloading) { event.preventDefault(); event.returnValue = ''; } };
    function destroy() {
      state.destroyed = true;
      state.activeAbort?.abort(); listeners.abort(); host.remove();
      window.removeEventListener('beforeunload', beforeUnload);
      if (window.__buctTabDl?.host === host) delete window.__buctTabDl;
    }
    function show() { host.style.display = ''; els.btnClose.focus(); }
    function hide() { host.style.display = 'none'; }
    window.__buctTabDl = { host, shadow, version: VERSION, show, hide, close: hide, destroy };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', destroy, { once: true, signal: listeners.signal });
    function syncBusy() {
      const busy = state.scanning || state.downloading;
      els.btnScan.disabled = busy;
      els.btnCancel.disabled = !busy;
      els.btnClose.textContent = busy ? '隐藏' : '关闭';
      for (const control of [els.btnSettings, els.setSave, els.setReset, els.setZipMode, els.setFlatten, els.setZipMb, els.setZipFiles]) control.disabled = busy;
      els.btnDl.disabled = busy || !state.selected.size;
      els.btnDl.textContent = state.downloading ? '下载中…' : '下载所选' + (state.selected.size ? ' (' + state.selected.size + ')' : '');
    }
    function assertCurrentContext() {
      checkCancelled(state.activeAbort?.signal);
      if (!state.contextKey || makeScanner().contextKey() !== state.contextKey) throw problem('STALE_SCAN', '课程页面已改变，请重新汇总后下载');
    }

    function openSettings() {
      const s = state.settings;
      els.setZipMode.value = s.zipMode || 'auto';
      els.setFlatten.value = s.flatten ? '1' : '0';
      els.setZipMb.value = String(s.maxZipMb || 200);
      els.setZipFiles.value = String(s.maxZipFiles || 120);
      els.settingsPanel.hidden = false;
      state.showSettings = true;
    }
    function closeSettings() {
      els.settingsPanel.hidden = true;
      state.showSettings = false;
    }

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
      window.addEventListener('mousemove', onMove, { signal: listeners.signal });
      window.addEventListener('mouseup', onUp, { signal: listeners.signal });
    })();

    function setStatus(text, kind) {
      els.statusText.textContent = text;
      const dot = els.status.querySelector('.dot');
      dot.className = 'dot' + (kind ? ' ' + kind : '');
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
      if (node.scanError || flattenFiles(node).some(matches)) return true;
      if (state.query && String(node.name || '').toLowerCase().includes(state.query.toLowerCase())) return true;
      return false;
    }

    function collectVisible(node, out = []) {
      if (!node || !nodeVisible(node)) return out;
      if (node.type === 'file') { if (isDownloadable(node)) out.push(node); return out; }
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
        if (isDownloadable(node) && matches(node)) {
          if (checked) state.selected.add(node.id);
          else state.selected.delete(node.id);
        }
        return;
      }
      for (const c of node.children || []) setSubtree(c, checked);
    }

    function relPath(f) {
      const dir = (f.pathSegments || []).filter(Boolean).join('/');
      if (f.type === 'folder') return dir || f.name;
      return dir ? dir + '/' + f.name : f.name;
    }

    function findFile(id) {
      return state.files.find((x) => x.id === id);
    }

    function updateSel() {
      for (const id of state.selected) if (!isDownloadable(findFile(id))) state.selected.delete(id);
      syncBusy();
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
          const files = flattenFiles(node).filter(isDownloadable).filter(matches);
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
      if (isFolder) { tw.setAttribute('aria-label', (collapsed ? '展开 ' : '折叠 ') + node.name); tw.setAttribute('aria-expanded', String(!collapsed)); }
      else { tw.setAttribute('aria-hidden', 'true'); tw.tabIndex = -1; tw.disabled = true; }
      if (isFolder) tw.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
        else state.collapsed.add(node.id);
        renderTree();
      });

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'chk';
      chk.setAttribute('aria-label', '选择 ' + node.name);
      chk.dataset.id = node.id;
      chk.dataset.kind = node.type;
      if (!isFolder && !isDownloadable(node)) { chk.disabled = true; chk.title = node.unavailableReason || '未提供下载入口'; }
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
        ext.textContent = node.downloadKind === 'preview' ? '预览版 ' + node.ext.toUpperCase() : (node.ext || '').toUpperCase();
        row.appendChild(ext);
      }
      wrap.appendChild(row);
      if (!isFolder && (!isDownloadable(node) || node.downloadKind === 'preview' || isPreviewSource(node))) {
        const note = document.createElement('div'); note.className = 'file-note';
        note.textContent = node.downloadKind === 'preview' || isPreviewSource(node) ? previewSummary(node) + '；' + previewNotice(node) + '。' : node.unavailableReason || '未提供下载入口';
        try {
          const url = schoolUrl(node.previewUrl || node.sourceUrl);
          const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看平台预览';
          note.append(' ', link);
        } catch { /* No safe preview URL. */ }
        wrap.appendChild(note);
      }
      if (node.scanError) { const error = document.createElement('div'); error.className = 'empty'; error.textContent = '读取失败：' + node.scanError; wrap.appendChild(error); }
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
      els.tree.replaceChildren();
      const tree = currentTree();
      if (!tree || !tree.children?.length) {
        const empty = document.createElement('div'); empty.className = 'empty';
        const heading = document.createElement('strong');
        heading.textContent = state.scanning ? '正在汇总…' : state.tab === 'unit' ? '单元学习暂无内容' : '课程资源暂无内容';
        const detail = document.createElement('div'); detail.textContent = tree?.scanError || tree?.emptyReason || (state.scanning ? '扫描不会自动下载文件' : '可重新汇总，或在平台打开对应页面后重试');
        empty.append(heading, detail); els.tree.appendChild(empty);
      } else {
        const node = renderNode(tree);
        if (node) els.tree.appendChild(node);
        else { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '当前筛选下无文件，可切换类型或清空搜索'; els.tree.appendChild(empty); }
      }
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
      const counts = availabilityCounts(state.files);
      const unavailableCount = counts.previewOnly + counts.unverified;
      if (counts.previewDownloads) msg += '，可下载预览副本 ' + counts.previewDownloads + ' 个';
      if (counts.previewOnly) msg += '，' + counts.previewOnly + ' 个暂不支持保存';
      if (counts.unverified) msg += '，' + counts.unverified + ' 个无法读取';
      if (state.failures.length) msg += '，' + state.failures.length + ' 项读取失败';
      setStatus(msg, state.failures.length || unavailableCount ? 'warn' : 'ok');
      renderTree();
    }

    async function doScan() {
      if (state.scanning || state.downloading || state.destroyed) return;
      state.scanning = true;
      state.contextKey = null;
      state.selected.clear(); state.files = []; state.resourceFiles = []; state.unitFiles = [];
      state.resourceTree = null; state.unitTree = null;
      state.activeAbort = new AbortController();
      syncBusy(); renderTree();
      setStatus('正在一次性汇总课程资源与单元学习…', 'busy');
      try {
        const scanner = makeScanner({ signal: state.activeAbort.signal, onProgress: text => setStatus(text, 'busy') });
        const key = scanner.contextKey();
        const count = scanner.unitCount();
        const includeAllUnits = !count || window.confirm('已发现 ' + count + ' 个学习单元。是否读取全部单元页面并汇总课件？取消则只读取当前单元和课程资源，不会自动下载文件。');
        const result = await scanner.scanAll({ includeAllUnits });
        checkCancelled(state.activeAbort.signal);
        if (scanner.contextKey() !== key) throw problem('STALE_SCAN', '课程页面已改变，请重新汇总');
        state.contextKey = key;
        applyResult(result);
      } catch (error) {
        if (!state.destroyed) setStatus(error.code === 'CANCELLED' ? '已停止汇总，未开始下载' : error.message || '汇总失败', 'err');
      } finally {
        state.scanning = false; state.activeAbort = null;
        if (!state.destroyed) { syncBusy(); renderTree(); }
      }
    }

    function triggerDownload(file) {
      const validated = validateFile(file);
      if (requiresPreparedDownload(validated)) throw problem('BAD_FILE', '文件尚未完成本地准备和校验，未下载预览网页或未经验证的资源流');
      const a = document.createElement('a');
      a.href = validated.downloadUrl;
      a.download = safeSegment(validated.name, { filename: true }).split('/').pop();
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function reportDownloadIssue(name, message) {
      const row = document.createElement('div');
      row.textContent = name + '：' + message;
      row.style.overflowWrap = 'anywhere';
      els.downloadReport.appendChild(row);
    }

    function saveBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    async function downloadAsZip(items, settings, signal) {
      const result = await createArchive(items, {
        settings, signal,
        onProgress: ({ file, position, total, page, pages }) => setStatus('打包中 ' + position + ' / ' + total + '：' + file.name + (page ? ' · 读取预览第 ' + page + ' / ' + pages + ' 页' : ''), 'busy'),
        shouldSkip: async (file, error) => {
          const skip = window.confirm(file.name + '：' + error.message + '\n是否跳过此文件并继续？之前已读取的文件不会重复请求。');
          reportDownloadIssue(file.name, (skip ? '已跳过：' : '未下载：') + error.message);
          return skip;
        },
      });
      assertCurrentContext();
      const name = safeSegment((state.courseName || '课件') + '.zip', { filename: true });
      saveBlob(result.blob, name);
      for (const warning of result.warnings) reportDownloadIssue(warning.name, '内容提示：' + warning.message);
      setStatus('已触发 ZIP 下载：' + name + '（' + result.count + ' 个文件' + (result.skipped.length ? '，跳过 ' + result.skipped.length + ' 个失败项' : '') + '）' + (result.warnings.length ? '，' + result.warnings.length + ' 项内容提示，见右侧' : '') + '。请在浏览器下载列表核对。', result.warnings.length ? 'warn' : 'ok');
    }
    async function downloadAsBatch(items, signal) {
      let triggered = 0, failed = 0, reused = 0, warnings = 0;
      els.dlNote.textContent = '浏览器可能询问是否允许多个下载。批量下载不能保留目录结构，也不能核对落盘内容。';
      for (const [index, file] of items.entries()) {
        assertCurrentContext();
        try {
          const probe = await preflightFile(file, { signal, includeBytes: true, onProgress: ({ page, pages }) => setStatus('生成 ' + file.name + ' · 第 ' + page + ' / ' + pages + ' 页', 'busy') });
          checkCancelled(signal);
          for (const warning of probe.warnings) { warnings++; reportDownloadIssue(file.name, '内容提示：' + warning.message); }
          if (probe.bytes) {
            saveBlob(new Blob([probe.bytes], { type: probe.contentType || 'application/octet-stream' }), safeSegment(file.name, { filename: true }));
            reused++;
          } else triggerDownload(file);
          triggered++;
        } catch (error) {
          checkCancelled(signal);
          failed++;
          reportDownloadIssue(file.name, error.message);
          setStatus(file.name + '：' + error.message, 'err');
        }
        setStatus('已检查 ' + (index + 1) + ' / ' + items.length + '，已触发 ' + triggered + '，失败 ' + failed, 'busy');
        await sleep(260);
      }
      els.dlNote.textContent = reused + ' 个文件保存已校验的本地内容（含预览副本）；' + (triggered - reused) + ' 个交由浏览器直接下载。逐个下载不能保留目录，不能核对落盘内容。';
      setStatus('已触发 ' + triggered + ' 个下载' + (failed ? '，' + failed + ' 个预检失败未下载' : '') + (warnings ? '，' + warnings + ' 项内容提示' : '') + '。请到浏览器下载列表核对。', failed ? 'err' : warnings ? 'warn' : 'ok');
    }
    async function doDownload() {
      if (state.scanning || state.downloading || state.destroyed) return;
      const items = [...state.selected].map(findFile).filter(isDownloadable);
      if (!items.length) return;
      const settings = normalizeSettings(state.settings);
      const plan = planDownload(items, settings);
      if (plan.mode === 'batch' && !window.confirm(plan.reason + '。将逐个触发 ' + items.length + ' 个下载，无法保留目录结构。继续？')) return;
      state.downloading = true; state.activeAbort = new AbortController();
      const signal = state.activeAbort.signal;
      syncBusy(); els.dlNote.textContent = plan.reason; els.downloadReport.replaceChildren();
      try {
        assertCurrentContext();
        if (plan.mode === 'zip') {
          try { await downloadAsZip(items, settings, signal); }
          catch (error) {
            checkCancelled(signal);
            if (error.code === 'OVER_BUDGET' && window.confirm('打包超过体积或数量上限，是否改为逐个下载？')) await downloadAsBatch(items, signal);
            else throw error;
          }
        } else await downloadAsBatch(items, signal);
      } catch (error) {
        if (!state.destroyed) setStatus(error.code === 'CANCELLED' ? '已停止后续读取；已触发的浏览器下载请在下载列表管理' : error.message || '下载失败', 'err');
      } finally {
        state.downloading = false; state.activeAbort = null;
        if (!state.destroyed) updateSel();
      }
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
    els.btnClose.addEventListener('click', hide);
    els.btnCancel.addEventListener('click', () => state.activeAbort?.abort());
    els.scrim.addEventListener('click', hide);
    els.btnSettings.addEventListener('click', () => {
      if (state.showSettings) closeSettings();
      else openSettings();
    });
    els.setSave.addEventListener('click', () => {
      state.settings = normalizeSettings({
        zipMode: els.setZipMode.value || 'auto',
        flatten: els.setFlatten.value === '1',
        maxZipMb: Math.max(10, Math.min(512, Number(els.setZipMb.value) || 200)),
        maxZipFiles: Math.max(1, Math.min(500, Number(els.setZipFiles.value) || 120)),
      });
      saveSettings(state.settings);
      closeSettings();
      setStatus('设置已保存', 'ok');
    });
    els.setReset.addEventListener('click', () => {
      state.settings = { ...DEFAULT_SETTINGS };
      saveSettings(state.settings);
      openSettings();
      setStatus('已恢复默认设置', 'ok');
    });
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
    els.q.addEventListener('input', () => { state.query = trimWhitespace(els.q.value); renderTree(); });
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
