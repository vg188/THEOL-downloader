// The bookmarklet panel: an isolated renderer over `createBookmarkletController`.
// It owns no policy — filtering, selection, the 500 MiB decision and the task
// lifecycle all stay in the controller — so the panel is only markup, copy and
// focus behaviour that a test can drive through a real controller.
import { formatBytes } from '../popup/model.js';
import { DIRECT_DOWNLOAD_CAUTION } from './direct-download.js';
import { createPanelHost } from './template.js';

const FORMAT_LABELS = { all: '全部', pdf: 'PDF', ppt: 'PPT', pptx: 'PPTX' };
const CONFIRM_STATES = new Set(['confirm-zip', 'confirm-direct', 'actual-size-overflow', 'confirm-all-units']);
const SCANNING_LABEL = '扫描中…';
const UNKNOWN_SIZE_TEXT = '大小未知';
const EMPTY_LIST_MESSAGE = '当前列表没有可下载的 PDF、PPT 或 PPTX 文件';
const NO_MATCH_MESSAGE = '没有匹配的文件';
const BUSY_NOTE = '任务进行中：请保持页面打开，不要刷新或关闭页面。';
// The range wording mirrors the extension popup: a course-resource page scans
// its current directory, a unit page its current unit or every unit.
const RANGE_LABELS = { current: '当前目录' };
const UNIT_RANGE_LABELS = { current: '当前单元', all: '全部单元' };

/**
 * The ranges a snapshot offers, as `[value, label]`. A page with no inspected
 * surface offers none, and the panel hides the control entirely.
 */
function rangeOptions(snapshot) {
  const unit = snapshot.surface === 'unit-study';
  const labels = unit ? UNIT_RANGE_LABELS : RANGE_LABELS;
  return snapshot.modes.map(value => [value, labels[value] ?? value]);
}

/** The scan button and empty-state verb for the range the panel is set to. */
function scanLabel(snapshot) {
  if (snapshot.surface === 'unit-study') return snapshot.mode === 'all' ? '扫描全部单元' : '扫描当前单元';
  return '扫描当前目录';
}

/**
 * Confirmation copy for one controller confirmation. `mode` decides the branch
 * and `reason` distinguishes an actually-measured overflow from a planned one,
 * because the three states ask the user for different things: a local ZIP, a
 * confirmed direct download, or a confirmed direct download after the archive
 * was destroyed.
 */
function confirmationCopy(confirmation) {
  if (confirmation.mode === 'all') {
    return {
      title: '扫描全部单元？',
      lines: [`将读取当前课程的 ${confirmation.unitCount} 个单元页面，不会下载课件正文`],
      confirm: '确认扫描',
    };
  }
  const count = confirmation.fileCount;
  const known = confirmation.knownTotalText;
  if (confirmation.reason === 'ACTUAL_SIZE_LIMIT') {
    return {
      title: '实际大小超过限制',
      lines: [
        `实际读取已超过 ${confirmation.limitText}，未发布的临时 ZIP 已销毁，不会自动改为逐个下载。`,
        `确认后将逐个下载 ${count} 个原文件。`,
        '不会生成 ZIP，将逐个下载原文件',
        DIRECT_DOWNLOAD_CAUTION,
      ],
      confirm: '确认逐个下载',
    };
  }
  if (confirmation.mode === 'zip') {
    return {
      title: '确认打包',
      lines: [
        `共 ${count} 个文件`,
        `预计总大小 ${known}`,
        '打包在页面内存中完成，低内存设备仍可能失败。',
        '打包期间请保持页面打开，不要刷新或关闭页面。',
      ],
      confirm: '确认打包',
    };
  }
  const sizeLine = confirmation.unknownCount > 0
    ? `已知总量 ${known}，另有 ${confirmation.unknownCount} 个文件大小未知`
    : `预计总大小 ${known}，超过 ${confirmation.limitText} 上限`;
  return {
    title: '确认逐个下载',
    lines: [
      `所选文件共 ${count} 个`,
      sizeLine,
      '不会生成 ZIP，将逐个下载原文件',
      '页面必须保持打开，失败项不会由后台恢复。',
      DIRECT_DOWNLOAD_CAUTION,
    ],
    confirm: '确认逐个下载',
  };
}

/**
 * Mounts the panel for one controller and returns its lifecycle handle.
 *
 * `show()` re-displays the panel (the bookmarklet's second invocation), and
 * `destroy()` aborts whatever the controller is running, detaches the host and
 * clears the panel's listeners. Mounting starts nothing: no scan and no download
 * runs until the user clicks.
 */
export function mountBookmarklet({ window: pageWindow = globalThis, controller, css, onDestroy } = {}) {
  if (!controller?.getSnapshot || !controller?.subscribe) throw new TypeError('mountBookmarklet 需要一个 controller');
  const pageDocument = pageWindow.document;
  const { host, root, refs } = createPanelHost({ document: pageDocument, css });

  const rows = new Map();
  const disposers = [];
  let destroyed = false;
  let confirming = false;
  let shownConfirmation = null;
  let shownResult = null;
  let confirmAccept = null;
  let trigger = null;

  const listen = (node, type, handler) => {
    node.addEventListener(type, handler);
    disposers.push(() => node.removeEventListener(type, handler));
  };
  const text = (node, value) => { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; };
  const toggle = (node, visible) => { node.hidden = !visible; };
  const create = (tag, className = '') => { const node = pageDocument.createElement(tag); if (className) node.className = className; return node; };

  function createFileRow(file) {
    const node = create('li', 'file');
    const label = create('label', 'file-label');
    const box = create('input');
    box.type = 'checkbox';
    const name = create('span', 'file-name');
    const badge = create('span', 'file-badge');
    const size = create('span', 'file-size');
    label.append(box, name);
    node.append(label, badge, size);
    listen(box, 'change', () => controller.toggle(file.id, box.checked));
    return { node, box, name, badge, size };
  }

  function renderFiles(snapshot, selected, busy) {
    const live = new Set();
    for (const file of snapshot.files) {
      live.add(file.id);
      let row = rows.get(file.id);
      if (!row) { row = createFileRow(file); rows.set(file.id, row); }
      row.box.checked = selected.has(file.id);
      row.box.disabled = busy;
      text(row.name, file.name);
      text(row.badge, String(file.extension || '').toUpperCase() || '文件');
      text(row.size, Number.isSafeInteger(file.sizeBytes) ? formatBytes(file.sizeBytes) : UNKNOWN_SIZE_TEXT);
      refs.files.append(row.node);
    }
    for (const [id, row] of rows) {
      if (live.has(id)) continue;
      row.node.remove();
      rows.delete(id);
    }
    toggle(refs.empty, !snapshot.files.length);
    if (!snapshot.files.length) text(refs.empty, emptyMessage(snapshot));
  }

  function emptyMessage(snapshot) {
    if (snapshot.fileCount) return NO_MATCH_MESSAGE;
    return snapshot.scan?.phase === 'ready' ? EMPTY_LIST_MESSAGE : `点击“${scanLabel(snapshot)}”读取当前页面的课件列表`;
  }

  function countText(snapshot) {
    const chosen = snapshot.selectedIds.length;
    const parts = [`共 ${snapshot.fileCount} 个文件`];
    if (snapshot.visibleCount !== snapshot.fileCount) parts.push(`显示 ${snapshot.visibleCount} 个`);
    parts.push(`已选 ${chosen} 个`);
    // The 500 MiB summary describes the selection, so it stays hidden until
    // there is one: “预计 0 B” would read as if the courseware had no size.
    if (chosen) {
      parts.push(`预计 ${snapshot.summary.knownTotalText}`);
      if (snapshot.summary.unknownCount) parts.push(`含 ${snapshot.summary.unknownCount} 个大小未知`);
    }
    return parts.join(' · ');
  }

  function renderProgress(progress) {
    const message = progress?.message || '';
    toggle(refs.progress, Boolean(message));
    text(refs.progressText, message);
    const total = progress?.total || 0;
    toggle(refs.bar, total > 0);
    refs.bar.max = total || 1;
    refs.bar.value = Math.min(progress?.processed || 0, total);
  }

  function fillConfirm(confirmation) {
    const copy = confirmationCopy(confirmation);
    const title = create('p', 'confirm-title');
    text(title, copy.title);
    const list = create('ul', 'confirm-list');
    for (const line of copy.lines) {
      const item = create('li');
      text(item, line);
      list.append(item);
    }
    const actions = create('div', 'confirm-actions');
    const accept = create('button', 'primary');
    accept.type = 'button';
    accept.dataset.action = 'confirm';
    text(accept, copy.confirm);
    const decline = create('button', 'ghost');
    decline.type = 'button';
    decline.dataset.action = 'cancel';
    text(decline, '取消');
    actions.append(accept, decline);
    refs.confirm.replaceChildren(title, list, actions);
    confirmAccept = accept;
  }

  function fillResult(result) {
    const title = create('p', 'result-title');
    const lines = [];
    if (result.mode === 'zip') {
      text(title, 'ZIP 已生成并触发下载');
      lines.push(`共 ${result.entries ?? 0} 个文件，${formatBytes(result.bytes ?? 0)}`);
      if (result.failures.length) lines.push(`已附上 下载失败清单.txt（${result.failures.length} 个文件失败）`);
      lines.push('若浏览器没有保存，请检查此站点的下载设置。');
    } else {
      // "Triggered" is the only honest claim a bookmarklet can make.
      text(title, '下载已触发');
      lines.push(`已触发 ${result.triggeredCount}/${result.fileCount} 个下载`);
      if (result.failedCount) lines.push(`${result.failedCount} 个文件没有触发，请重试。`);
      if (result.caution) lines.push(result.caution);
    }
    const body = lines.map(line => { const node = create('p'); text(node, line); return node; });
    refs.result.replaceChildren(title, ...body);
  }

  function renderConfirm(snapshot) {
    const confirmation = snapshot.confirmation;
    const open = Boolean(confirmation) && CONFIRM_STATES.has(snapshot.state);
    toggle(refs.confirm, open);
    if (open && confirmation !== shownConfirmation) {
      shownConfirmation = confirmation;
      fillConfirm(confirmation);
      confirmAccept.focus?.();
    }
    if (!open) {
      shownConfirmation = null;
      if (confirming) {
        (trigger ?? refs.download).focus?.();
        trigger = null;
      }
    }
    confirming = open;
  }

  function renderResult(snapshot) {
    toggle(refs.result, Boolean(snapshot.result));
    if (!snapshot.result) { shownResult = null; return; }
    if (snapshot.result === shownResult) return;
    shownResult = snapshot.result;
    fillResult(snapshot.result);
  }

  function render() {
    if (destroyed) return;
    const snapshot = controller.getSnapshot();
    host.hidden = !snapshot.visible;
    const busy = snapshot.busy;
    const selected = new Set(snapshot.selectedIds);
    const visibleIds = snapshot.files.map(file => file.id);
    const chosenVisible = visibleIds.filter(id => selected.has(id)).length;

    toggle(refs.course, Boolean(snapshot.courseName));
    text(refs.course, snapshot.courseName);
    // The range control exists only where more than one range is meaningful:
    // a course-resource page keeps its fixed "当前目录".
    const options = rangeOptions(snapshot);
    const showModes = options.length > 1;
    toggle(refs.modeRow, showModes);
    const optionsKey = `${snapshot.surface}|${options.map(([value]) => value).join(',')}`;
    if (showModes && refs.mode.dataset.options !== optionsKey) {
      refs.mode.replaceChildren(...options.map(([value, label]) => {
        const option = pageDocument.createElement('option');
        option.value = value;
        text(option, label);
        return option;
      }));
      refs.mode.dataset.options = optionsKey;
    }
    if (refs.mode.value !== snapshot.mode) refs.mode.value = snapshot.mode;
    refs.mode.disabled = busy;
    const label = scanLabel(snapshot);
    text(refs.scan, busy ? SCANNING_LABEL : label);
    refs.scan.disabled = busy;
    // The panel can only hide: a running task needs the page to stay open.
    text(refs.close, busy ? '隐藏' : '关闭');
    if (refs.search.value !== snapshot.query) refs.search.value = snapshot.query;
    for (const chip of root.querySelectorAll('[data-format]')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.format === snapshot.format));
      text(chip, FORMAT_LABELS[chip.dataset.format]);
    }
    refs.all.checked = visibleIds.length > 0 && chosenVisible === visibleIds.length;
    refs.all.indeterminate = chosenVisible > 0 && chosenVisible < visibleIds.length;
    refs.all.disabled = busy || !visibleIds.length;
    text(refs.counts, countText(snapshot));
    toggle(refs.notice, Boolean(snapshot.notice));
    text(refs.notice, snapshot.notice);
    toggle(refs.error, Boolean(snapshot.error));
    text(refs.error, snapshot.error?.message ?? '');
    toggle(refs.busyNote, busy);
    text(refs.busyNote, busy ? BUSY_NOTE : '');
    // Unit failures and file failures are different repairs for the user, so
    // they are reported separately, never summed.
    const failureLines = [];
    if (snapshot.failures.length) failureLines.push(`${snapshot.failures.length} 个文件未能读取，可重新扫描后再试。`);
    if (snapshot.unitFailures.length) failureLines.push(`${snapshot.unitFailures.length} 个单元未能读取，其余单元已扫描。`);
    toggle(refs.failures, failureLines.length > 0);
    text(refs.failures, failureLines.join(' '));
    refs.download.disabled = busy;
    toggle(refs.cancel, busy);
    renderProgress(snapshot.progress);
    renderFiles(snapshot, selected, busy);
    renderConfirm(snapshot);
    renderResult(snapshot);
  }

  listen(refs.scan, 'click', () => { void controller.scan(); });
  listen(refs.mode, 'change', event => controller.setScanMode(event.target.value));
  listen(refs.search, 'input', event => controller.setQuery(event.target.value));
  listen(refs.close, 'click', () => controller.hide());
  listen(refs.download, 'click', () => {
    trigger = refs.download;
    controller.requestDownload();
  });
  listen(refs.cancel, 'click', () => controller.cancel());
  listen(refs.all, 'change', event => {
    const checked = Boolean(event.target.checked);
    for (const file of controller.getSnapshot().files) controller.toggle(file.id, checked);
  });
  for (const chip of root.querySelectorAll('[data-format]')) {
    listen(chip, 'click', () => controller.setFormat(chip.dataset.format));
  }
  // Delegated, so a rebuilt confirmation never accumulates listeners. The
  // all-units range has its own confirmation: only that one starts unit reads.
  listen(refs.confirm, 'click', event => {
    const action = event.target?.dataset?.action;
    if (action === 'confirm') {
      if (controller.getSnapshot().state === 'confirm-all-units') controller.confirmAllUnits();
      else controller.confirm();
    } else if (action === 'cancel') controller.cancel();
  });

  pageDocument.documentElement.append(host);
  const unsubscribe = controller.subscribe(render);
  controller.show();
  render();

  return {
    controller,
    host,
    shadowRoot: root,
    getSnapshot: () => controller.getSnapshot(),
    show: () => { controller.show(); },
    // Diagnostics stay a method, not a rendered control: the panel belongs to
    // students, this handle belongs to whoever is debugging in the console.
    diagnose: () => controller.diagnose(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      // Abort in-flight reads and workers before the host goes away.
      if (controller.getSnapshot().busy) controller.cancel();
      unsubscribe();
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      rows.clear();
      host.remove();
      onDestroy?.();
    },
  };
}
