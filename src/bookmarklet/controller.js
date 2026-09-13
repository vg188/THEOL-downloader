import { AppError, errorResult } from '../platform/policy.js';
import { createSelection, formatBytes } from '../popup/model.js';
import { ZIP_LIMIT_BYTES, planDownload } from './download-plan.js';

const BUSY = new Set(['scanning', 'archiving', 'direct-downloading']);
// States that hold a confirmation derived from the current selection.
const CONFIRMING = new Set(['confirm-zip', 'confirm-direct', 'actual-size-overflow']);
// States where the user can pick files or ask for another download.
const IDLE = new Set(['idle', 'ready', 'done', 'cancelled', 'error']);
const FORMATS = new Set(['all', 'pdf', 'ppt', 'pptx']);

// Keep in sync with ActualSizeLimitError in src/bookmarklet/archive.js.
function defaultActualSizeLimit(error) {
  return error?.name === 'ActualSizeLimitError' || error?.code === 'ACTUAL_SIZE_LIMIT';
}

function countOf(...values) {
  for (const value of values) if (Number.isFinite(value)) return value;
  return null;
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
 * - `scan({signal,onProgress}) => Promise<{files,failures,context,id,phase,...}>`
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
  let scanned = null;
  let progress = null;
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
    return Object.freeze({
      state,
      busy: BUSY.has(state),
      visible,
      query,
      format,
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
    const generation = ++scanGeneration;
    invalidateTask();
    selection.reset(generation);
    state = 'scanning';
    scanned = null;
    confirmation = null;
    result = null;
    failure = null;
    notice = '';
    progress = progressFrom(null, { total: 0, message: '正在扫描当前目录…' });
    const controller = new AbortController();
    task = { kind: 'scan', generation, controller };
    emit();
    let outcome;
    try {
      outcome = await dependencies.scan({
        signal: controller.signal,
        onProgress: event => {
          if (task?.generation !== generation) return;
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
    state = 'ready';
    progress = null;
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
    if (CONFIRMING.has(state)) { state = 'ready'; confirmation = null; notice = ''; return emit(); }
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
    if (visible) return getSnapshot();
    visible = true;
    return emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getSnapshot, subscribe, scan, setQuery, setFormat, toggle, requestDownload, confirm, cancel, hide, show };
}
