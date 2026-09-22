/* 北化课件下载 · 标签版 — panel controller */

const MODE_LABEL = {
  directory: '当前目录',
  tree: '目录树',
  'unit-current': '当前单元',
  'unit-all': '全部单元',
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
  mode: 'tree',
  tree: null,
  files: [],
  unitIndex: [],
  failures: [],
  group: 'all',
  query: '',
  selected: new Set(),
  collapsed: new Set(),
  scanning: false,
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

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
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
  if (files.some(matchesFilter)) return true;
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
    out.push(fileFromNode(node));
    return out;
  }
  for (const c of node.children || []) collectVisibleFiles(c, out);
  return out;
}

function relPath(file) {
  const dir = (file.pathSegments || []).filter(Boolean).join('/');
  return dir ? dir + '/' + file.name : file.name;
}

function updateSelectionChrome() {
  const all = state.files.map(fileFromNode).filter(matchesFilter);
  const selectedFiles = all.filter((f) => state.selected.has(f.id));
  const hiddenSelected = state.files.filter((f) => state.selected.has(f.id) && !matchesFilter(fileFromNode(f))).length;

  el.selCount.textContent = String(state.selected.size);
  el.selHidden.textContent = hiddenSelected ? `（另有 ${hiddenSelected} 个不在当前筛选中）` : '';
  el.btnDownload.disabled = state.selected.size === 0 || state.scanning;
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
    const files = flattenFiles(node).filter(matchesFilter);
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
    if (matchesFilter(fileFromNode(node))) {
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
    btn.disabled = !enabled && !state.scanning ? true : !modes.includes(mode);
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
  twisty.setAttribute('aria-label', collapsed ? '展开' : '折叠');
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
  check.dataset.id = node.id;
  check.dataset.kind = node.type;
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
    row.appendChild(ext);
  }

  wrap.appendChild(row);

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
  el.treeRoot.innerHTML = '';
  if (!state.tree) {
    el.emptyState.classList.remove('hidden');
    return;
  }
  el.emptyState.classList.add('hidden');
  const rootEl = renderTreeNode(state.tree, 0);
  if (rootEl) el.treeRoot.appendChild(rootEl);
  updateSelectionChrome();
}

function renderJobs() {
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
    preparing: '准备中',
    downloading: '下载中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  for (const job of state.jobs) {
    const item = document.createElement('div');
    item.className = 'job-item';
    item.innerHTML =
      '<div class="job-name"></div>' +
      '<div class="job-meta"><span class="job-status"></span><span class="job-actions"></span></div>' +
      '<div class="job-error hidden"></div>';
    item.querySelector('.job-name').textContent = job.name || job.filename;
    item.querySelector('.job-status').textContent = statusText[job.status] || job.status;
    item.querySelector('.job-status').className = 'job-status ' + job.status;
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
        await send('RETRY_JOB', { id: job.id });
        await refreshJobs();
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
    state.tree = null;
    state.files = [];
    state.modes = [];
    renderTree();
    renderScopeTabs();
    return;
  }
  state.surface = result.surface;
  state.courseName = result.courseName || '课件';
  state.modes = result.modes || [];
  state.mode = result.defaultMode || state.modes[0] || 'tree';
  state.tree = result.tree;
  state.files = flattenFiles(result.tree).map(fileFromNode);
  state.unitIndex = result.unitIndex || [];
  state.failures = result.failures || [];
  state.selected.clear();
  state.collapsed.clear();
  // 默认展开两层
  expandDepth(state.tree, 2);

  el.courseName.textContent = state.courseName;
  el.pageHint.textContent =
    result.surface === 'resource-directory'
      ? '课程资源 · 可扫描当前目录或完整目录树'
      : '单元学习 · 可扫描当前单元或全部单元';

  const failText = state.failures.length
    ? `，${state.failures.length} 个单元/目录读取失败`
    : '';
  setStatus(
    `发现 ${state.files.length} 个文件${failText}。勾选后点击「下载所选」。`,
    'ok'
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

async function doScan(mode) {
  if (state.scanning) return;
  state.scanning = true;
  el.btnRescan.disabled = true;
  el.btnDownload.disabled = true;
  setStatus('正在扫描…');

  if (mode) state.mode = mode;
  // unit-all 需要确认
  if (state.mode === 'unit-all' && state.unitIndex.length) {
    const ok = window.confirm(
      `将读取 ${state.unitIndex.length} 个单元页面并汇总课件。\n只读取页面与文件信息，不会自动下载课件正文。确认扫描？`
    );
    if (!ok) {
      state.scanning = false;
      el.btnRescan.disabled = false;
      updateSelectionChrome();
      setStatus('已取消全部单元扫描');
      return;
    }
  }

  const res = await send('SCAN_TAB', {
    tabId: state.courseTabId,
    mode: state.mode,
    recursive: true,
  });
  applyScanResult(res);
  state.scanning = false;
  el.btnRescan.disabled = false;
  updateSelectionChrome();
}

function selectedItems() {
  return [...state.selected]
    .map((id) => state.files.find((f) => f.id === id))
    .filter(Boolean)
    .map((f) => ({
      url: f.downloadUrl,
      name: f.name,
      filename: `${state.courseName || '课件'}/${relPath(f)}`,
    }));
}

async function doDownload() {
  const items = selectedItems();
  if (!items.length) return;
  el.btnDownload.disabled = true;
  setStatus(`已提交 ${items.length} 个下载任务…`, 'ok');
  await send('ENQUEUE', { items });
  await refreshJobs();
  updateSelectionChrome();
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
    await send('CLEAR_FINISHED');
    await refreshJobs();
  });

  el.searchInput.addEventListener('input', () => {
    state.query = el.searchInput.value.trim();
    renderTree();
  });

  el.scopeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.scope-tab');
    if (!btn || btn.disabled) return;
    doScan(btn.dataset.mode);
  });

  el.typeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.type-tab');
    if (!btn) return;
    state.group = btn.dataset.group;
    renderTypeTabs();
    renderTree();
  });

  await refreshJobs();
  setInterval(refreshJobs, 1500);

  // 自动定位课程标签页并尝试扫描
  const tabRes = await send('GET_COURSE_TAB').catch(() => null);
  if (tabRes?.ok && tabRes.tab) {
    state.courseTabId = tabRes.tab.id;
    el.pageHint.textContent = '已连接课程页：' + (tabRes.tab.title || tabRes.tab.url);
    await doScan();
  } else {
    setStatus('请先在其他标签页打开 course.buct.edu.cn 的课程资源或单元学习，然后点击「扫描」', 'error');
    el.pageHint.textContent = '未找到学校课程标签页';
  }
}

init().catch((err) => {
  setStatus(err?.message || '初始化失败', 'error');
});
