import { AppError, errorResult } from '../platform/policy.js';
import { createSelection, formatBytes } from '../popup/model.js';
import { ZIP_LIMIT_BYTES, planDownload } from './download-plan.js';

const BUSY = new Set(['scanning', 'archiving', 'direct-downloading']);
// States that hold a confirmation: a download plan derived from the current
// selection, or the all-units range waiting for its own explicit confirmation.
const CONFIRMING = new Set(['confirm-zip', 'confirm-direct', 'actual-size-overflow', 'confirm-all-units']);
// States where the user can pick files or ask for another download.
const IDLE = new Set(['idle', 'ready', 'done', 'cancelled', 'error']);
const FORMATS = new Set(['all', 'pdf', 'ppt', 'pptx']);
const MODES = new Set(['current', 'all']);

// Keep in sync with ActualSizeLimitError in src/bookmarklet/archive.js.
function defaultActualSizeLimit(error) {
  return error?.name === 'ActualSizeLimitError' || error?.code === 'ACTUAL_SIZE_LIMIT';
}

function countOf(...values) {
  for (const value of values) if (Number.isFinite(value)) return value;
  return null;
}

// The unit-collection counters the panel renders: `all` reports them while the
// unit pages load, and the settled snapshot keeps the last values.
function frozenCounters(value) {
  const source = value && typeof value === 'object' ? value : {};
  const count = key => Number.isFinite(source[key]) && source[key] >= 0 ? source[key] : 0;
  return Object.freeze({ processed: count('processed'), total: count('total'), discovered: count('discovered') });
}

// One stable progress shape for the panel, whatever the running task reports.
function progressFrom(event, { total = 0, message = '' } = {}) {
  const source = event && typeof event === 'object' ? event : {};
  return Object.freeze({
    message: typeof source.message === 'string' && source.message ? source.message : message,
    name: typeof source.name === 'string' && source.name ? source.name : null,
    processed: countOf(source.processed, source.triggered) ?? 0,
    total: countOf(source.total, total) ?? 0,
    succeeded: countOf(source.succeeded),
    failed: countOf(source.failed),
  });
}

/**
 * Browser-neutral coordinator for the bookmarklet panel.
 *
 * Dependencies (all injected, no chrome.* calls):
 * - `inspect?() => {context,surface}` local surface inspection with no request;
 *   its `context.key`/`context.document` identity is what makes a page change
 *   invalidate the selection
 * - `scan({mode,signal,onProgress}) => Promise<{files,failures,unitFailures,units,context,id,phase,...}>`
 *   called only after a confirmation when `mode` is `all`
 * - `cancelScan?()` for scanners that need an explicit abort
 * - `archiveFiles(files,{signal,onProgress}) => Promise<{blob,name,bytes,entries,failures}>`
 *   and rejecting `ActualSizeLimitError` (`code:'ACTUAL_SIZE_LIMIT'`) on a breach
 * - `downloadDirect(files,{document,signal,onProgress}) => Promise<{triggered,failed,caution}>`
 *   where `triggered` are requested files, never "saved"
 * - `deliverArchive?(result)` optional one-shot blob delivery; without it the
 *   caller reads `snapshot.result.blob` once the state is `done`.
 * - `document?`, `isActualSizeLimitError?(error)`
 */
export function createBookmarkletController(dependencies = {}) {
  const isActualSizeLimit = typeof dependencies.isActualSizeLimitError === 'function'
    ? dependencies.isActualSizeLimitError
    : defaultActualSizeLimit;
  const selection = createSelection();
  const listeners = new Set();
  let state = 'idle';
  let visible = false;
  let query = '';
  let format = 'all';
  let mode = 'current';
  // The last inspected page contract: which surface this page offers, and which
  // ranges it supports. `null` means "not inspected or no longer a surface".
  let inspected = null;
  let scanned = null;
  let progress = null;
  let units = frozenCounters(null);
  let confirmation = null;
  let result = null;
  let failure = null;
  let notice = '';
  let task = null;
  let taskGeneration = 0;
  let scanGeneration = 0;
  let snapshot = null;

  function scanFiles() {
    return Array.isArray(scanned?.files) ? scanned.files : [];
  }

  function availableModes() {
    const source = inspected?.surface?.modeOptions ?? scanned?.context?.modeOptions ?? [];
    return source.filter(value => MODES.has(value));
  }

  // The surface identity: a different surface, folder, unit page, unit index or
  // live frame document is a different generation of the page.
  function samePage(left, right) {
    if (!left || !right) return left === right;
    return left.context?.key === right.context?.key && left.context?.document === right.context?.document;
  }

  /**
   * Re-reads the page contract. Inspection is local DOM work — it makes no
   * request — so it never counts as starting a scan; it is skipped while a task
   * runs, because that task already owns the surface it was started on.
   *
   * A changed page invalidates everything derived from the old one: the
   * selection, any pending confirmation and the previous scan's file list.
   */
  function refreshPage() {
    if (typeof dependencies.inspect !== 'function' || task) return false;
    let next = null;
    try { next = dependencies.inspect() ?? null; } catch { next = null; }
    if (samePage(inspected, next)) return false;
    inspected = next;
    const modes = availableModes();
    if (modes.length && !modes.includes(mode)) mode = 'current';
    selection.clear();
    confirmation = null;
    failure = null;
    notice = '';
    progress = null;
    result = null;
    scanned = null;
    units = frozenCounters(null);
    state = 'idle';
    return true;
  }

  function selectedFiles() {
    const byId = new Map(scanFiles().map(file => [file.id, file]));
    return selection.selectedIds().map(id => byId.get(id)).filter(Boolean);
  }

  function buildConfirmation(plan, { mode = plan.mode, reason = plan.reason ?? null } = {}) {
    return Object.freeze({
      mode,
      reason,
      fileCount: plan.fileCount,
      knownTotalBytes: plan.knownTotalBytes,
      unknownCount: plan.unknownCount,
      limitBytes: plan.limitBytes,
      knownTotalText: formatBytes(plan.knownTotalBytes),
      limitText: formatBytes(plan.limitBytes),
    });
  }

  function buildSnapshot() {
    const files = scanFiles();
    const shown = selection.visible(files, query, format);
    const chosen = selectedFiles();
    const plan = planDownload(chosen);
    const modes = availableModes();
    return Object.freeze({
      state,
      busy: BUSY.has(state),
      visible,
      query,
      format,
      // The scan-range contract the panel renders: which surface this page is
      // and which ranges it offers, never page copy.
      mode,
      modes: Object.freeze(modes),
      surface: inspected?.surface?.surface ?? scanned?.context?.surface ?? null,
      unitCount: inspected?.surface?.unitIndex?.entries?.length ?? units.total,
      units,
      unitFailures: Object.freeze(Array.isArray(scanned?.unitFailures) ? scanned.unitFailures : []),
      courseName: scanned?.context?.courseName ?? '',
      files: Object.freeze(shown),
      fileCount: files.length,
      visibleCount: shown.length,
      selectedIds: Object.freeze(selection.selectedIds()),
      selectedFiles: Object.freeze(chosen),
      summary: Object.freeze({
        ...plan,
        knownTotalText: formatBytes(plan.knownTotalBytes),
        limitText: formatBytes(ZIP_LIMIT_BYTES),
      }),
      confirmation,
      progress,
      result,
      error: failure,
      notice,
      failures: Object.freeze(Array.isArray(scanned?.failures) ? scanned.failures : []),
      scan: scanned ? Object.freeze({
        id: scanned.id ?? null,
        phase: scanned.phase ?? null,
        message: scanned.message ?? '',
        total: countOf(scanned.total) ?? files.length,
        processed: countOf(scanned.processed) ?? files.length,
        skipped: countOf(scanned.skipped) ?? 0,
      }) : null,
    });
  }

  function getSnapshot() {
    if (!snapshot) snapshot = buildSnapshot();
    return snapshot;
  }

  function emit() {
    snapshot = null;
    const current = getSnapshot();
    for (const listener of listeners) listener(current);
    return current;
  }

  function fail(error) {
    task = null;
    progress = null;
    confirmation = null;
    const { code, message } = errorResult(error);
    if (code === 'CANCELLED') { state = 'cancelled'; failure = null; }
    else { state = 'error'; failure = Object.freeze({ code, message }); }
    return emit();
  }

  // Aborts the running task and makes every late result/progress event stale.
  function invalidateTask() {
    const current = task;
    task = null;
    taskGeneration++;
    current?.controller.abort();
    return current;
  }

  function onTaskProgress(generation, event) {
    if (task?.generation !== generation) return;
    progress = progressFrom(event, { total: progress?.total ?? 0, message: progress?.message ?? '' });
    emit();
  }

  async function scan() {
    if (BUSY.has(state)) { notice = '请先取消当前任务'; emit(); return getSnapshot(); }
    if (typeof dependencies.scan !== 'function') return fail(new AppError('NOT_CONFIGURED', '扫描组件未加载'));
    // Inspect first: the range the user chose is validated against the page as
    // it is now, and `all` needs the unit count before it can be confirmed.
    refreshPage();
    if (mode === 'all') {
      const modes = availableModes();
      if (modes.length && !modes.includes('all')) return fail(new AppError('INVALID_MESSAGE', '当前页面不支持扫描全部单元'));
      // No unit page is read until the user confirms this exact range.
      confirmation = Object.freeze({ mode: 'all', unitCount: inspected?.surface?.unitIndex?.entries?.length ?? 0 });
      state = 'confirm-all-units';
      progress = null;
      result = null;
      failure = null;
      notice = '';
      return emit();
    }
    return startScan('current');
  }

  function startScan(scanMode) {
    if (typeof dependencies.scan !== 'function') return fail(new AppError('NOT_CONFIGURED', '扫描组件未加载'));
    const generation = ++scanGeneration;
    invalidateTask();
    selection.reset(generation);
    mode = scanMode;
    state = 'scanning';
    scanned = null;
    confirmation = null;
    result = null;
    failure = null;
    notice = '';
    units = frozenCounters(null);
    progress = progressFrom(null, { total: 0, message: scanMode === 'all' ? '正在读取单元页面…' : '正在扫描当前目录…' });
    const controller = new AbortController();
    task = { kind: 'scan', generation, controller };
    emit();
    return (async () => {
      let outcome;
      try {
        outcome = await dependencies.scan({
          mode: scanMode,
          signal: controller.signal,
          onProgress: event => {
            // Progress from a superseded scan is dropped with its generation.
            if (task?.generation !== generation) return;
            if (event?.kind === 'unit-progress') {
              units = frozenCounters(event);
              progress = progressFrom({
                message: `正在读取单元 ${units.processed} / ${units.total}，已发现 ${units.discovered} 个候选`,
                processed: units.processed, total: units.total,
              }, { message: '' });
              return emit();
            }
            // A discovered batch has already widened the running scan's own
            // resource list: it changes nothing the panel shows yet.
            if (event?.kind === 'discovered') return;
            progress = progressFrom(event, { total: progress?.total ?? 0, message: progress?.message ?? '' });
            emit();
          },
        });
      } catch (error) {
        if (task?.generation !== generation) return getSnapshot();
        return fail(error);
      }
      if (task?.generation !== generation) return getSnapshot();
      task = null;
      scanned = outcome && typeof outcome === 'object' ? outcome : null;
      units = frozenCounters(scanned?.units);
      state = 'ready';
      progress = null;
      return emit();
    })();
  }

  /** The explicit confirmation for the `all` range: this is what reads units. */
  function confirmAllUnits() {
    if (state !== 'confirm-all-units' || task) return getSnapshot();
    confirmation = null;
    return startScan('all');
  }

  /**
   * The scan range. A different range is a different selection scope, so
   * nothing selected or confirmed for the previous one may survive it. While a
   * task is running — an archive or direct download above all — the range is
   * immutable: the task was started from this one.
   */
  function setScanMode(value) {
    const next = MODES.has(value) ? value : 'current';
    if (task || next === mode) return getSnapshot();
    const modes = availableModes();
    if (next === 'all' && modes.length && !modes.includes('all')) return getSnapshot();
    mode = next;
    selection.clear();
    confirmation = null;
    failure = null;
    notice = '';
    if (CONFIRMING.has(state) || BUSY.has(state)) state = scanned ? 'ready' : 'idle';
    return emit();
  }

  function setQuery(value) {
    const next = typeof value === 'string' ? value : '';
    if (next === query) return getSnapshot();
    query = next;
    notice = '';
    return emit();
  }

  function setFormat(value) {
    const next = FORMATS.has(value) ? value : 'all';
    if (next === format) return getSnapshot();
    format = next;
    return emit();
  }

  function toggle(id, checked) {
    if (BUSY.has(state)) return getSnapshot();
    if (!scanFiles().some(file => file.id === id)) return getSnapshot();
    selection.toggle(id, Boolean(checked));
    // The selected set changed, so any confirmation or finished task is stale.
    state = 'ready';
    confirmation = null;
    failure = null;
    notice = '';
    return emit();
  }

  function requestDownload() {
    if (!IDLE.has(state)) return getSnapshot();
    const plan = planDownload(selectedFiles());
    confirmation = null;
    result = null;
    failure = null;
    if (plan.mode === 'blocked') { state = 'ready'; notice = '请先选择要下载的课件'; return emit(); }
    confirmation = buildConfirmation(plan);
    state = plan.mode === 'zip' ? 'confirm-zip' : 'confirm-direct';
    notice = '';
    return emit();
  }

  function startArchive() {
    if (typeof dependencies.archiveFiles !== 'function') return fail(new AppError('NOT_CONFIGURED', '打包组件未加载'));
    const chosen = Object.freeze(selectedFiles());
    const generation = ++taskGeneration;
    const controller = new AbortController();
    task = { kind: 'archive', generation, controller };
    state = 'archiving';
    failure = null;
    notice = '';
    result = null;
    progress = progressFrom(null, { total: chosen.length, message: `正在打包 ${chosen.length} 个文件…` });
    emit();
    return (async () => {
      let archive;
      try {
        archive = await dependencies.archiveFiles(chosen, { signal: controller.signal, onProgress: event => onTaskProgress(generation, event) });
      } catch (error) {
        if (task?.generation !== generation) return getSnapshot();
        if (isActualSizeLimit(error)) return overflow();
        return fail(error);
      }
      if (task?.generation !== generation) return getSnapshot();
      if (typeof dependencies.deliverArchive === 'function') {
        try {
          await dependencies.deliverArchive(archive);
        } catch (error) {
          if (task?.generation !== generation) return getSnapshot();
          return fail(error);
        }
        if (task?.generation !== generation) return getSnapshot();
      }
      task = null;
      progress = null;
      failure = null;
      result = Object.freeze({
        mode: 'zip',
        name: archive?.name ?? null,
        bytes: countOf(archive?.bytes),
        entries: countOf(archive?.entries),
        failures: Object.freeze(Array.isArray(archive?.failures) ? archive.failures : []),
        blob: archive?.blob ?? null,
      });
      state = 'done';
      return emit();
    })();
  }

  // The archive discovered more bytes than the limit: destroy the archive, keep
  // the selection, and wait for a fresh confirm() before any direct download.
  function overflow() {
    task = null;
    progress = null;
    result = null;
    failure = null;
    notice = '';
    confirmation = buildConfirmation(planDownload(selectedFiles()), { mode: 'direct', reason: 'ACTUAL_SIZE_LIMIT' });
    state = 'actual-size-overflow';
    return emit();
  }

  function startDirect() {
    if (typeof dependencies.downloadDirect !== 'function') return fail(new AppError('NOT_CONFIGURED', '下载组件未加载'));
    const chosen = Object.freeze(selectedFiles());
    const generation = ++taskGeneration;
    const controller = new AbortController();
    task = { kind: 'direct', generation, controller };
    state = 'direct-downloading';
    failure = null;
    notice = '';
    result = null;
    confirmation = null;
    progress = progressFrom(null, { total: chosen.length, message: `已触发 0/${chosen.length}` });
    emit();
    return (async () => {
      let outcome;
      try {
        outcome = await dependencies.downloadDirect(chosen, {
          document: dependencies.document,
          signal: controller.signal,
          onProgress: event => onTaskProgress(generation, event),
        });
      } catch (error) {
        if (task?.generation !== generation) return getSnapshot();
        return fail(error);
      }
      if (task?.generation !== generation) return getSnapshot();
      task = null;
      progress = null;
      // downloadDirect reports triggered files (requested, never "saved").
      const triggered = Array.isArray(outcome?.triggered) ? outcome.triggered : [];
      const failed = Array.isArray(outcome?.failed) ? outcome.failed : [];
      result = Object.freeze({
        mode: 'direct',
        fileCount: chosen.length,
        triggered: Object.freeze(triggered),
        triggeredCount: triggered.length,
        failed: Object.freeze(failed),
        failedCount: failed.length,
        caution: typeof outcome?.caution === 'string' ? outcome.caution : null,
      });
      state = 'done';
      return emit();
    })();
  }

  function confirm() {
    if (task) return getSnapshot();
    if (state === 'confirm-zip') return startArchive();
    if (state === 'confirm-direct' || state === 'actual-size-overflow') return startDirect();
    return getSnapshot();
  }

  function cancel() {
    if (CONFIRMING.has(state)) { state = scanned ? 'ready' : 'idle'; confirmation = null; notice = ''; return emit(); }
    if (!BUSY.has(state)) return getSnapshot();
    const kind = task?.kind;
    scanGeneration++;
    invalidateTask();
    if (kind === 'scan' && typeof dependencies.cancelScan === 'function') dependencies.cancelScan();
    progress = null;
    confirmation = null;
    failure = null;
    notice = '';
    state = 'cancelled';
    return emit();
  }

  function hide() {
    if (!visible) return getSnapshot();
    visible = false;
    return emit();
  }

  function show() {
    // The page contract is refreshed every time the panel comes back, so a
    // reloaded or navigated frame cannot leave a stale range control behind.
    const changed = refreshPage();
    if (visible && !changed) return getSnapshot();
    visible = true;
    return emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getSnapshot, subscribe, scan, setScanMode, confirmAllUnits, setQuery, setFormat, toggle, requestDownload, confirm, cancel, hide, show };
}
