import { isDownloadable, availabilityCounts, trimWhitespace, schoolUrl, previewSummary, previewNotice, isGeneratedPreview, isPreviewSource } from '../src/runtime/policy.js';

/* 北化课件下载 · 标签版 — panel controller */

const MODE_LABEL = {
  course: '全部课程',
  directory: '当前目录',
  tree: '课程资源',
  'unit-current': '当前单元',
  'unit-all': '单元学习',
};

const GROUP_LABEL = {
  all: '全部',
  pdf: 'PDF',
  ppt: 'PPT',
  word: 'Word',
  excel: 'Excel',
  archive: '压缩包',
  other: '其他',
};

const state = {
  courseTabId: null,
  courseName: '课件',
  surface: null,
  modes: [],
  mode: 'course',
  courseTree: null,
  tree: null,
  files: [],
  unitIndex: [],
  failures: [],
  group: 'all',
  query: '',
  selected: new Set(),
  collapsed: new Set(),
  scanning: false,
  submitting: false,
  scanId: null,
  scanVersion: 0,
  pendingRescan: false,
  requestKey: null,
  requestId: null,
  jobs: [],
};

const el = {
  courseName: document.getElementById('courseName'),
  pageHint: document.getElementById('pageHint'),
  scopeTabs: document.getElementById('scopeTabs'),
  typeTabs: document.getElementById('typeTabs'),
  searchInput: document.getElementById('searchInput'),
  treeRoot: document.getElementById('treeRoot'),
  emptyState: document.getElementById('emptyState'),
  statusBar: document.getElementById('statusBar'),
  btnRescan: document.getElementById('btnRescan'),
  btnDownload: document.getElementById('btnDownload'),
  btnExpand: document.getElementById('btnExpand'),
  btnCollapse: document.getElementById('btnCollapse'),
  btnSelectVisible: document.getElementById('btnSelectVisible'),
  btnClearSel: document.getElementById('btnClearSel'),
  btnClearJobs: document.getElementById('btnClearJobs'),
  jobsList: document.getElementById('jobsList'),
  selCount: document.getElementById('selCount'),
  selHidden: document.getElementById('selHidden'),
  selPreview: document.getElementById('selPreview'),
  saveFolder: document.getElementById('saveFolder'),
};

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '扩展后台无响应，请稍后重试');
  return response;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setStatus(text, kind = '') {
  el.statusBar.textContent = text;
  el.statusBar.className = 'status-bar' + (kind ? ' ' + kind : '');
}

function modeLabel(mode) {
  return MODE_LABEL[mode] || mode;
}

function groupOfExt(ext) {
  const map = {
    pdf: 'pdf',
    ppt: 'ppt', pptx: 'ppt',
    doc: 'word', docx: 'word',
    xls: 'excel', xlsx: 'excel',
    zip: 'archive', rar: 'archive', '7z': 'archive',
  };
  return map[ext] || 'other';
}

function iconClassFor(node) {
  if (node.type === 'folder') return 'folder';
  const g = node.group || groupOfExt(node.ext || '');
  return g;
}

function iconLetter(node) {
  if (node.type === 'folder') return '▸';
  const g = iconClassFor(node);
  return {
    pdf: 'P',
    ppt: 'S',
    word: 'W',
    excel: 'X',
    archive: 'Z',
    other: 'F',
  }[g] || 'F';
}

function flattenFiles(node, out = []) {
  if (!node) return out;
  if (node.type === 'file') out.push(node);
  for (const c of node.children || []) flattenFiles(c, out);
  return out;
}

function matchesFilter(file) {
  if (state.group !== 'all') {
    const g = file.group || groupOfExt(file.ext || '');
    if (g !== state.group) return false;
  }
  if (state.query) {
    const q = state.query.toLowerCase();
    const name = String(file.name || '').toLowerCase();
    const path = (file.pathSegments || []).join('/').toLowerCase();
    if (!name.includes(q) && !path.includes(q)) return false;
  }
  return true;
}

function nodeVisible(node) {
  if (node.type === 'file') return matchesFilter(fileFromNode(node));
  // folder visible if any descendant file matches, or query matches folder name
  const files = flattenFiles(node);
  if (node.scanError || files.some(matchesFilter)) return true;
  if (state.query && String(node.name || '').toLowerCase().includes(state.query.toLowerCase())) return true;
  return false;
}

function fileFromNode(node) {
  return {
    ...node,
    group: node.group || groupOfExt(node.ext || ''),
  };
}

function collectVisibleFiles(node, out = []) {
  if (!node || !nodeVisible(node)) return out;
  if (node.type === 'file') {
    if (isDownloadable(node)) out.push(fileFromNode(node));
    return out;
  }
  for (const c of node.children || []) collectVisibleFiles(c, out);
  return out;
}

function relPath(file) {
  const dir = (file.pathSegments || []).filter(Boolean).join('/');
  if (file.type === 'folder') return dir || file.name;
  return dir ? dir + '/' + file.name : file.name;
}

function updateSelectionChrome() {
  for (const id of state.selected) if (!state.files.some(file => file.id === id && isDownloadable(file))) state.selected.delete(id);
  const visible = new Set(collectVisibleFiles(state.tree).map(file => file.id));
  const hiddenSelected = [...state.selected].filter(id => !visible.has(id)).length;

  el.selCount.textContent = String(state.selected.size);
  el.selHidden.textContent = hiddenSelected ? '另有 ' + hiddenSelected + ' 个不在当前范围或筛选中' : '';
  el.btnDownload.disabled = state.selected.size === 0 || state.scanning || state.submitting;
  el.saveFolder.textContent = state.courseName || '课件';

  el.selPreview.innerHTML = '';
  const preview = [...state.selected]
    .map((id) => state.files.find((f) => f.id === id))
    .filter(Boolean)
    .slice(0, 8);
  for (const f of preview) {
    const li = document.createElement('li');
    li.textContent = relPath(fileFromNode(f));
    el.selPreview.appendChild(li);
  }
  if (state.selected.size > 8) {
    const li = document.createElement('li');
    li.textContent = '…';
    el.selPreview.appendChild(li);
  }

  // sync checkboxes
  for (const input of el.treeRoot.querySelectorAll('input[data-id]')) {
    const id = input.dataset.id;
    const isFile = input.dataset.kind === 'file';
    if (isFile) {
      input.checked = state.selected.has(id);
      input.indeterminate = false;
    }
  }
  // folder tri-state
  for (const input of el.treeRoot.querySelectorAll('input[data-kind="folder"]')) {
    const nodeId = input.dataset.id;
    const node = findNode(state.tree, nodeId);
    if (!node) continue;
    const files = flattenFiles(node).filter(isDownloadable).filter(matchesFilter);
    if (!files.length) {
      input.checked = false;
      input.indeterminate = false;
      input.disabled = true;
      continue;
    }
    input.disabled = false;
    const checkedCount = files.filter((f) => state.selected.has(f.id)).length;
    input.checked = checkedCount === files.length;
    input.indeterminate = checkedCount > 0 && checkedCount < files.length;
  }
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
    if (isDownloadable(node) && matchesFilter(fileFromNode(node))) {
      if (checked) state.selected.add(node.id);
      else state.selected.delete(node.id);
    }
    return;
  }
  for (const c of node.children || []) setSubtree(c, checked);
}

function renderScopeTabs() {
  const modes = state.modes.length ? state.modes : [];
  const buttons = el.scopeTabs.querySelectorAll('.scope-tab');
  for (const btn of buttons) {
    const mode = btn.dataset.mode;
    const enabled = modes.includes(mode);
    btn.hidden = !enabled;
    btn.disabled = !enabled || state.scanning || state.submitting;
    btn.classList.toggle('active', state.mode === mode);
    if (!modes.length) btn.disabled = true;
  }
}

function renderTypeTabs() {
  for (const btn of el.typeTabs.querySelectorAll('.type-tab')) {
    btn.classList.toggle('active', btn.dataset.group === state.group);
  }
}

function renderTreeNode(node, depth = 0) {
  if (!nodeVisible(node)) return null;
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  wrap.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.setAttribute('role', 'treeitem');

  const isFolder = node.type === 'folder';
  const collapsed = state.collapsed.has(node.id);

  const twisty = document.createElement('button');
  twisty.type = 'button';
  twisty.className = 'twisty' + (isFolder ? '' : ' leaf');
  twisty.textContent = collapsed ? '▶' : '▼';
  twisty.setAttribute('aria-label', (collapsed ? '展开 ' : '折叠 ') + node.name);
  if (isFolder) row.setAttribute('aria-expanded', String(!collapsed));
  else { twisty.disabled = true; twisty.tabIndex = -1; twisty.setAttribute('aria-hidden', 'true'); }
  if (isFolder) {
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
      else state.collapsed.add(node.id);
      renderTree();
    });
  }

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'tree-check';
  check.setAttribute('aria-label', '选择 ' + node.name);
  check.dataset.id = node.id;
  check.dataset.kind = node.type;
  if (!isFolder && !isDownloadable(node)) { check.disabled = true; check.title = node.unavailableReason || '未提供下载入口'; }
  if (isFolder) {
    check.addEventListener('change', () => {
      setSubtree(node, check.checked);
      updateSelectionChrome();
    });
  } else {
    check.checked = state.selected.has(node.id);
    check.addEventListener('change', () => {
      if (check.checked) state.selected.add(node.id);
      else state.selected.delete(node.id);
      updateSelectionChrome();
    });
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon ' + iconClassFor(node);
  icon.textContent = iconLetter(node);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;
  label.title = relPath(fileFromNode(node));

  row.append(twisty, check, icon, label);

  if (isFolder) {
    const count = flattenFiles(node).filter(matchesFilter).length;
    const badge = document.createElement('span');
    badge.className = 'tree-badge';
    badge.textContent = count ? String(count) : '0';
    row.appendChild(badge);
  } else {
    const ext = document.createElement('span');
    ext.className = 'tree-ext';
    ext.textContent = (node.ext || '').toUpperCase();
    if (node.downloadKind === 'preview') ext.classList.add('preview-type');
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
    } catch { /* A read-only item need not have a preview link. */ }
    wrap.appendChild(note);
  }

  if (isFolder && node.scanError) {
    const err = document.createElement('div');
    err.className = 'folder-error';
    err.textContent = '读取失败：' + node.scanError;
    wrap.appendChild(err);
  }

  if (isFolder) {
    const kids = document.createElement('div');
    kids.className = 'tree-children' + (collapsed ? ' collapsed' : '');
    kids.setAttribute('role', 'group');
    for (const c of node.children || []) {
      const childEl = renderTreeNode(c, depth + 1);
      if (childEl) kids.appendChild(childEl);
    }
    wrap.appendChild(kids);
  }

  return wrap;
}

function renderTree() {
  el.treeRoot.replaceChildren();
  const rootEl = state.tree && renderTreeNode(state.tree, 0);
  el.emptyState.classList.toggle('hidden', !!rootEl);
  if (rootEl) el.treeRoot.appendChild(rootEl);
  else {
    const message = document.createElement('p');
    message.textContent = state.scanning ? '正在读取课程文件信息…'
      : !state.tree ? '点击「刷新列表」读取当前课程；失败后可重试。'
      : state.mode === 'directory' && state.tree.subfolderCount ? '当前目录没有直接文件，但有 ' + state.tree.subfolderCount + ' 个子目录。切换「课程资源」可汇总子目录中的资源。'
      : !flattenFiles(state.tree).length ? state.tree.emptyReason || '当前范围没有文件，切换范围即可查看其他课程资源。'
      : state.files.length ? '当前筛选下没有文件，可切换类型或清空搜索。'
      : '当前范围没有识别到文件；可稍后刷新列表。';
    el.emptyState.replaceChildren(message);
  }
  updateSelectionChrome();
}

function renderJobs() {
  const key = JSON.stringify(state.jobs);
  if (key === state.jobsRenderKey) return;
  state.jobsRenderKey = key;
  el.jobsList.innerHTML = '';
  if (!state.jobs.length) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.textContent = '暂无下载任务';
    el.jobsList.appendChild(p);
    return;
  }
  const statusText = {
    queued: '排队中',
    preparing: '正在预检',
    downloading: '下载中',
    done: '浏览器已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  for (const job of state.jobs) {
    const item = document.createElement('div');
    item.className = 'job-item';
    item.dataset.jobId = job.id;
    item.innerHTML =
      '<div class="job-name"></div>' +
      '<div class="job-meta"><span class="job-status"></span><span class="job-actions"></span></div>' +
      '<div class="job-path"></div>' +
      '<div class="job-detail"></div>' +
      '<div class="job-warning hidden"></div>' +
      '<div class="job-error hidden"></div>';
    item.querySelector('.job-name').textContent = job.name || job.filename;
    item.querySelector('.job-name').title = job.name || job.filename;
    item.querySelector('.job-status').textContent = job.status === 'preparing' && isGeneratedPreview(job.file) ? '正在生成预览副本' : statusText[job.status] || job.status;
    item.querySelector('.job-status').className = 'job-status ' + job.status;
    const pathEl = item.querySelector('.job-path');
    pathEl.textContent = (job.actualFilename ? '保存路径：' : '计划路径：') + (job.actualFilename || job.filename || '等待分配');
    pathEl.title = pathEl.textContent;
    const bytes = value => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
    const details = [];
    if (job.preflight) details.push(job.preflight.sampleComplete && job.preflight.level !== 'unrecognized' ? '格式预检通过' : '响应预检通过');
    if (job.status === 'downloading' && job.totalBytes > 0) details.push(bytes(job.bytesReceived || 0) + ' / ' + bytes(job.totalBytes));
    if (job.status === 'done' && Number.isFinite(job.fileSize)) details.push(bytes(job.fileSize));
    item.querySelector('.job-detail').textContent = details.join(' · ');
    const warnings = Array.isArray(job.preflight?.warnings) ? [...job.preflight.warnings] : [];
    if (job.syncWarning) warnings.push({ message: job.syncWarning });
    if (warnings.length) {
      const warningEl = item.querySelector('.job-warning');
      warningEl.textContent = warnings.map(warning => warning.message).join('；');
      warningEl.classList.remove('hidden');
    }
    const errEl = item.querySelector('.job-error');
    if (job.error) {
      errEl.textContent = job.error;
      errEl.classList.remove('hidden');
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      const btn = document.createElement('button');
      btn.className = 'btn sm';
      btn.type = 'button';
      btn.textContent = '重试';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await send('RETRY_JOB', { id: job.id }); await refreshJobs(); }
        catch (error) { setStatus(error.message, 'error'); }
        finally { btn.disabled = false; }
      });
      item.querySelector('.job-actions').appendChild(btn);
    }
    el.jobsList.appendChild(item);
  }
}

async function refreshJobs() {
  const res = await send('GET_JOBS');
  if (res?.ok) {
    state.jobs = res.jobs || [];
    renderJobs();
  }
}

function applyScanResult(result) {
  if (!result?.ok) {
    setStatus(result?.error || '扫描失败', 'error');
    state.courseTree = null;
    state.tree = null;
    state.files = [];
    state.selected.clear();
    state.scanId = null;
    state.unitIndex = [];
    el.courseName.textContent = "—";
    state.modes = [];
    renderTree();
    renderScopeTabs();
    return;
  }
  state.scanId = result.scanId;
  state.courseTabId = result.tabId;
  state.surface = result.surface;
  state.courseName = result.courseName || '课件';
  state.modes = result.modes || [];
  state.mode = result.defaultMode || state.modes[0] || 'auto';
  state.courseTree = result.surface === 'course' ? result.tree : null;
  state.tree = result.tree;
  const seen = new Set();
  state.files = flattenFiles(result.tree).filter(file => { if (seen.has(file.id)) return false; seen.add(file.id); return true; }).map(fileFromNode);
  state.unitIndex = result.unitIndex || [];
  state.failures = result.failures || [];
  state.selected.clear();
  state.collapsed.clear();
  // 默认展开两层
  expandDepth(state.tree, 2);

  el.courseName.textContent = state.courseName;
  el.pageHint.textContent =
    result.surface === 'course'
      ? '已汇总整门课程 · 切换目录或单元不会影响此列表'
      : result.surface === 'resource-directory'
      ? '课程资源 · 可扫描当前目录或完整目录树'
      : '单元学习 · 可扫描当前单元或全部单元';

  const counts = availabilityCounts(state.files);
  const unavailableCount = counts.previewOnly + counts.unverified;
  const unavailableText = (counts.previewOnly ? '，' + counts.previewOnly + ' 个暂不支持保存' : '') + (counts.unverified ? '，' + counts.unverified + ' 个无法读取' : '');
  const failText = state.failures.length
    ? `，${state.failures.length} 项读取失败`
    : '';
  const guidance = state.files.length > unavailableCount ? '勾选后点击「下载所选」。'
    : unavailableCount ? '可使用列表中的平台预览链接查看。'
    : state.tree?.subfolderCount ? '当前目录只有子目录，请切换「目录树」。' : '可在平台切换范围后重试。';
  setStatus(
    `发现 ${state.files.length} 个文件${unavailableText}${failText}。${guidance}`,
    unavailableCount || state.failures.length ? '' : 'ok'
  );
  renderScopeTabs();
  renderTypeTabs();
  renderTree();
}

function expandDepth(node, depth) {
  if (!node || depth <= 0 || node.type !== 'folder') return;
  state.collapsed.delete(node.id);
  for (const c of node.children || []) expandDepth(c, depth - 1);
}

function selectScope(mode) {
  if (state.scanning || state.submitting) return;
  if (!state.courseTree) { void doScan(mode); return; }
  const selectedTree = mode === 'course' ? state.courseTree : state.courseTree.children.find(node => node.id === (mode === 'tree' ? 'section-resource' : 'section-unit'));
  if (!state.modes.includes(mode) || !selectedTree) return;
  state.mode = mode; state.tree = selectedTree;
  renderScopeTabs(); renderTree();
}

async function doScan(mode, { reuse = false } = {}) {
  if (state.scanning || state.submitting) return;
  const requestedMode = mode || (state.courseTree ? 'course' : state.mode);
  const version = ++state.scanVersion;
  state.scanning = true;
  state.scanId = null;
  state.selected.clear();
  state.courseTree = null; state.tree = null; state.files = [];
  el.btnRescan.disabled = true;
  renderTree(); renderScopeTabs();
  setStatus('正在扫描…');
  try {
    const tab = (await send('GET_COURSE_TAB')).tab;
    state.courseTabId = tab.id;
    const result = await send('SCAN_TAB', { tabId: tab.id, mode: requestedMode, reuse });
    if (version === state.scanVersion) applyScanResult(result);
  } catch (error) {
    if (version === state.scanVersion) applyScanResult({ ok: false, error: error.message });
  } finally {
    state.scanning = false;
    el.btnRescan.disabled = false;
    renderScopeTabs(); renderTree();
    if (state.pendingRescan) { state.pendingRescan = false; void doScan('course', { reuse: true }); }
  }
}

async function doDownload() {
  if (state.scanning || state.submitting || !state.scanId) return;
  const ids = [...state.selected].filter(id => state.files.some(file => file.id === id && isDownloadable(file)));
  if (!ids.length) return;
  state.submitting = true;
  el.btnRescan.disabled = true;
  updateSelectionChrome(); renderScopeTabs();
  const key = state.scanId + '|' + [...ids].sort().join(',');
  if (state.requestKey !== key) { state.requestKey = key; state.requestId = crypto.randomUUID(); }
  setStatus('正在提交下载任务…');
  try {
    const response = await send('ENQUEUE', { scanId: state.scanId, ids, requestId: state.requestId });
    state.jobs = response.jobs || [];
    renderJobs();
    const count = response.created?.length || 0;
    setStatus(count ? '已新增 ' + count + ' 个下载任务' + (count < ids.length ? '，进行中的文件未重复提交' : '') : '所选文件已在队列中，未重复提交', 'ok');
    state.requestKey = null; state.requestId = null;
  } catch (error) { setStatus(error.message, 'error'); }
  finally {
    state.submitting = false;
    el.btnRescan.disabled = false;
    updateSelectionChrome(); renderScopeTabs();
    if (state.pendingRescan) { state.pendingRescan = false; void doScan('course', { reuse: true }); }
  }
}

async function init() {
  // 绑定
  el.btnRescan.addEventListener('click', () => doScan());
  el.btnDownload.addEventListener('click', () => doDownload());
  el.btnSelectVisible.addEventListener('click', () => {
    for (const f of collectVisibleFiles(state.tree)) state.selected.add(f.id);
    updateSelectionChrome();
  });
  el.btnClearSel.addEventListener('click', () => {
    state.selected.clear();
    updateSelectionChrome();
  });
  el.btnExpand.addEventListener('click', () => {
    state.collapsed.clear();
    renderTree();
  });
  el.btnCollapse.addEventListener('click', () => {
    const walk = (n) => {
      if (n.type === 'folder') {
        state.collapsed.add(n.id);
        for (const c of n.children || []) walk(c);
      }
    };
    if (state.tree) walk(state.tree);
    renderTree();
  });
  el.btnClearJobs.addEventListener('click', async () => {
    try { await send('CLEAR_FINISHED'); await refreshJobs(); }
    catch (error) { setStatus(error.message, 'error'); }
  });

  el.searchInput.addEventListener('input', () => {
    state.query = trimWhitespace(el.searchInput.value);
    renderTree();
  });

  el.scopeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.scope-tab');
    if (!btn || btn.disabled) return;
    selectScope(btn.dataset.mode);
  });

  el.typeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.type-tab');
    if (!btn) return;
    state.group = btn.dataset.group;
    renderTypeTabs();
    renderTree();
  });

  await refreshJobs().catch(error => setStatus(error.message, 'error'));
  let refreshing = false;
  const timer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try { await refreshJobs(); } catch { /* Leave the current user action's status intact; next tick retries. */ }
    finally { refreshing = false; }
  }, 1500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'COURSE_TAB_CHANGED') return;
    state.scanVersion++;
    state.scanId = null; state.selected.clear();
    if (state.scanning || state.submitting) state.pendingRescan = true;
    else void doScan('course', { reuse: true });
  });

  // 自动定位课程标签页并尝试扫描
  const tabRes = await send('GET_COURSE_TAB').catch(() => null);
  if (tabRes?.ok && tabRes.tab) {
    state.courseTabId = tabRes.tab.id;
    el.pageHint.textContent = '已连接课程页：' + (tabRes.tab.title || tabRes.tab.url);
    await doScan('course', { reuse: true });
  } else {
    setStatus('请先在其他标签页打开 course.buct.edu.cn 的课程资源或单元学习，然后点击「刷新列表」', 'error');
    el.pageHint.textContent = '未找到学校课程标签页';
  }
}

init().catch((err) => {
  setStatus(err?.message || '初始化失败', 'error');
});
