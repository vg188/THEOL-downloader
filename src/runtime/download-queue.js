import { filePath, validateFile, matchesFileUrl, requiresPreparedDownload, problem, safeSegment } from './policy.js';
import { assertFileMime } from './file-content.js';

const BUSY = new Set(['preparing', 'downloading']);
const ACTIVE = new Set(['queued', ...BUSY]);
const STATUSES = new Set([...ACTIVE, 'done', 'failed', 'cancelled']);
function matchesSavedPath(requested, actual) {
  const expected = requested.normalize('NFC').toLowerCase(), path = actual.replace(/\\/g, '/').normalize('NFC').toLowerCase();
  if (path === expected || path.endsWith('/' + expected)) return true;
  const slash = expected.lastIndexOf('/'), directory = expected.slice(0, slash + 1), leaf = expected.slice(slash + 1), dot = leaf.lastIndexOf('.');
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf, suffix = dot > 0 ? leaf.slice(dot) : '';
  const escaped = value => value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  // Chrome's conflictAction=uniquify is the only automatic rename we requested.
  return new RegExp('(?:^|/)' + escaped(directory + stem) + ' \\([1-9]\\d*\\)' + escaped(suffix) + '$').test(path);
}

/** Persisted queue; a concurrency slot belongs to a transfer until Chrome settles it. */
export function createDownloadQueue({ storage, downloads, preflight, releasePrepared = async () => {}, extensionId, maxParallel = 2, makeId = () => crypto.randomUUID(), now = Date.now }) {
  let state = { jobs: [], requests: [] }, tail = Promise.resolve(), ready, pumping = false;
  const serial = task => { const result = tail.then(task); tail = result.catch(() => {}); return result; };
  const snapshot = () => structuredClone(state.jobs);
  let savedJSON;
  const save = async () => {
    const json = JSON.stringify(state);
    if (json === savedJSON) return;
    await storage.write(structuredClone(state)); savedJSON = json;
  };
  const kick = () => { void pump().catch(() => {}); };
  function fail(job, error) { job.status = error.code === 'CANCELLED' ? 'cancelled' : 'failed'; job.error = error.message || String(error); job.errorCode = error.code || 'DOWNLOAD_ERROR'; }
  async function applyNative(job, item) {
    if (!item) { fail(job, problem('INTERRUPTED', 'Chrome 已找不到该下载，请手动重试')); return; }
    let valid = false;
    const actualUrl = item.finalUrl || item.url;
    valid = (requiresPreparedDownload(job.file)
      ? typeof job.nativeUrl === 'string' && job.nativeUrl.startsWith('blob:chrome-extension://' + extensionId + '/') && actualUrl === job.nativeUrl
      : matchesFileUrl(job.file, actualUrl)) && (!item.byExtensionId || item.byExtensionId === extensionId);
    let mismatch;
    if (!valid) mismatch = problem('BAD_FILE', '服务器或浏览器未返回所选文件，请重新登录后重试');
    try { assertFileMime(job.file, item.mime || '', 'attachment'); } catch (error) { mismatch = error; }
    job.bytesReceived = Math.max(0, Number(item.bytesReceived) || 0);
    job.totalBytes = Math.max(0, Number(item.totalBytes) || 0);
    if (item.filename) {
      job.actualFilename = item.filename;
      if (!matchesSavedPath(job.filename, item.filename)) mismatch = problem('FILENAME_MISMATCH', '浏览器保存名称或目录与请求不一致，请核对实际保存路径');
    }
    const expected = job.preflight?.expectedBytes;
    const diskExpected = job.preflight?.expectedFileBytes ?? (job.file.sizeExact === true ? job.file.sizeBytes : expected);
    if (Number.isSafeInteger(expected) && expected >= 0 && job.totalBytes > 0 && job.totalBytes !== expected) mismatch = problem('SIZE_MISMATCH', '实际下载大小与预检不一致，原文件可能已更新；请重新扫描');
    if (item.state === 'complete') {
      if (Number.isFinite(item.fileSize) && item.fileSize === 0) mismatch = problem('EMPTY_FILE', '浏览器保存了空文件，请核对下载记录');
      if (Number.isSafeInteger(diskExpected) && diskExpected >= 0 && Number.isFinite(item.fileSize) && item.fileSize >= 0 && item.fileSize !== diskExpected) mismatch = problem('SIZE_MISMATCH', '落盘文件大小与预检不一致，未标记为成功');
      if (item.exists === false) mismatch = problem('FILE_MISSING', '浏览器报告文件已不存在，请核对保存路径');
    }
    if (mismatch) {
      if (item.state === 'in_progress') await downloads.cancel(item.id).catch(() => {});
      if (item.state === 'complete') mismatch.message += '（文件可能已落盘，不会自动删除，请人工检查）';
      fail(job, mismatch); return;
    }
    if (item.state === 'complete') {
      job.status = 'done'; job.error = ''; job.errorCode = ''; job.verification = 'browser-complete';
      job.fileSize = Number.isFinite(item.fileSize) && item.fileSize >= 0 ? item.fileSize : job.bytesReceived;
    } else if (item.state === 'interrupted') fail(job, problem(item.error === 'USER_CANCELED' ? 'CANCELLED' : 'INTERRUPTED', item.error === 'USER_CANCELED' ? '已在浏览器取消，可手动重试' : '下载中断：' + (item.error || '请检查网络或磁盘空间')));
    else job.status = 'downloading';
  }
  async function reconcile(job) {
    try {
      await applyNative(job, (await downloads.search({ id: job.downloadId }))[0]);
      job.syncWarning = '';
      if (!ACTIVE.has(job.status) && requiresPreparedDownload(job.file)) await releasePrepared(job.id).catch(() => {});
    } catch {
      // A query failure says nothing about the transfer: retain its ID and slot.
      job.syncWarning = '暂时无法读取浏览器下载状态，将自动重试；不会重复启动下载';
    }
  }
  function initialize() {
    if (!ready) ready = serial(async () => {
      const saved = await storage.read();
      if (saved && Array.isArray(saved.jobs)) {
        state = { jobs: [], requests: Array.isArray(saved.requests) ? saved.requests.filter(id => typeof id === 'string').slice(-200) : [] };
        const ids = new Set();
        for (const input of saved.jobs) {
          try {
            if (!input || typeof input.id !== 'string' || ids.has(input.id) || !STATUSES.has(input.status)) continue;
            const file = validateFile(input.file);
            const oldPath = typeof input.filename === 'string' && !input.filename.startsWith('/') && input.filename.split('/').every(part => part && safeSegment(part, { filename: true, max: 240 }) === part) ? input.filename : '';
            const filename = input.startedAt && oldPath ? oldPath : filePath(file, { courseName: input.courseName || '课件', section: true });
            const job = { ...input, file, name: file.name, filename };
            if (job.status === 'downloading' && Number.isInteger(job.downloadId)) await reconcile(job);
            else if (BUSY.has(job.status)) {
              if (!job.startedAt && job.status === 'preparing') job.status = 'queued';
              else {
                const matches = (await downloads.search({ url: input.nativeUrl || file.downloadUrl, startedAfter: new Date(job.startedAt || 0).toISOString() })).filter(item => item.byExtensionId === extensionId);
                if (matches.length === 1) { job.downloadId = matches[0].id; await applyNative(job, matches[0]); }
                else fail(job, problem('RECOVERY_REQUIRED', '后台重启，无法确认此项是否已开始；请核对浏览器下载列表后手动重试'));
              }
            }
            ids.add(job.id); state.jobs.push(job);
          } catch (error) {
            // A transient Chrome error must not silently discard a valid transfer.
            if (input?.file && typeof input.id === 'string') {
              try { const file = validateFile(input.file); if (!ids.has(input.id)) { ids.add(input.id); state.jobs.push({ ...input, file, status: 'failed', error: '恢复下载记录失败，请核对浏览器下载列表后重试', errorCode: 'RECOVERY_REQUIRED' }); } } catch { /* Invalid persisted input is discarded. */ }
            }
          }
        }
      }
      await save();
    }).catch(error => { ready = undefined; throw error; });
    return ready;
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      await initialize();
      const reserved = await serial(async () => {
        const capacity = Math.max(0, maxParallel - state.jobs.filter(job => BUSY.has(job.status)).length);
        const pending = state.jobs.filter(job => job.status === 'queued').slice(0, capacity);
        for (const job of pending) { job.status = 'preparing'; job.error = ''; }
        try { await save(); } catch (error) { for (const job of pending) job.status = 'queued'; throw error; }
        return structuredClone(pending);
      });
      for (const job of reserved) void launch(job).catch(() => {});
    } finally { pumping = false; }
  }
  async function launch(reserved) {
    try {
      const inspection = await preflight(reserved.file, { jobId: reserved.id });
      await serial(async () => {
        const job = state.jobs.find(item => item.id === reserved.id);
        if (!job || job.status !== 'preparing') { await releasePrepared(reserved.id).catch(() => {}); return; }
        if (requiresPreparedDownload(job.file) && !inspection?.blobUrl?.startsWith('blob:chrome-extension://' + extensionId + '/')) throw problem('BAD_FILE', '未获得已完成本地准备和校验的文件');
        job.nativeUrl = requiresPreparedDownload(job.file) ? inspection.blobUrl : job.file.downloadUrl;
        job.preflight = inspection || null; job.verification = 'preflight';
        job.startedAt = now(); await save();
        const options = { url: job.nativeUrl, filename: job.filename, saveAs: false, conflictAction: 'uniquify' };
        if (inspection?.etag) options.headers = [{ name: 'If-Match', value: inspection.etag }];
        job.downloadId = await downloads.download(options);
        if (!Number.isInteger(job.downloadId)) throw problem('DOWNLOAD_ERROR', '无法创建浏览器下载任务');
        job.status = 'downloading'; await save();
        await reconcile(job);
        await save();
      });
    } catch (error) {
      await serial(async () => {
        const job = state.jobs.find(item => item.id === reserved.id);
        if (!job) return;
        if (Number.isInteger(job.downloadId) && BUSY.has(job.status)) await downloads.cancel(job.downloadId).catch(() => {});
        fail(job, error); await releasePrepared(job.id).catch(() => {}); await save();
      });
    } finally { kick(); }
  }
  async function enqueue(files, { courseName = '课件', requestId } = {}) {
    await initialize();
    if (!Array.isArray(files) || !files.length || files.length > 2000 || typeof requestId !== 'string' || !requestId || requestId.length > 100) throw problem('INVALID_MESSAGE', '请选择有效文件后再下载');
    const valid = files.map(file => validateFile(file));
    const result = await serial(async () => {
      if (state.requests.includes(requestId)) return { jobs: snapshot(), created: [] };
      const before = structuredClone(state), created = [];
      for (const file of valid) {
        if (state.jobs.some(job => ACTIVE.has(job.status) && job.file.id === file.id)) continue;
        const id = makeId();
        state.jobs.push({ id, file, courseName, name: file.name, url: file.downloadUrl, filename: filePath(file, { courseName, section: true }), status: 'queued', createdAt: now(), startedAt: null, downloadId: null, error: '', errorCode: '' });
        created.push(id);
      }
      state.requests.push(requestId); state.requests = state.requests.slice(-200);
      try { await save(); } catch (error) { state = before; throw error; }
      return { jobs: snapshot(), created };
    });
    kick(); return result;
  }
  async function refresh() {
    await initialize();
    const result = await serial(async () => {
      for (const job of state.jobs) if (job.status === 'downloading' && Number.isInteger(job.downloadId)) {
        await reconcile(job);
      }
      await save(); return snapshot();
    });
    kick(); return result;
  }
  async function retry(id) {
    await initialize();
    const result = await serial(async () => {
      const job = state.jobs.find(item => item.id === id);
      if (!job || !['failed', 'cancelled'].includes(job.status)) throw problem('INVALID_JOB', '仅失败或已取消的任务可重试');
      if (state.jobs.some(other => other.id !== id && other.file.id === job.file.id && ACTIVE.has(other.status))) throw problem('DUPLICATE_JOB', '该文件已有进行中的下载任务');
      const before = { ...job };
      Object.assign(job, { status: 'queued', downloadId: null, startedAt: null, nativeUrl: '', actualFilename: '', preflight: null, verification: '', syncWarning: '', error: '', errorCode: '' });
      try { await save(); } catch (error) { Object.assign(job, before); throw error; }
      return snapshot();
    });
    kick(); return result;
  }
  async function clearFinished() {
    await initialize();
    return serial(async () => { const before = state.jobs; state.jobs = state.jobs.filter(job => !['done', 'cancelled'].includes(job.status)); try { await save(); } catch (error) { state.jobs = before; throw error; } return snapshot(); });
  }
  return { init: async () => { await initialize(); kick(); return snapshot(); }, enqueue, refresh, retry, clearFinished, getJobs: async () => { await initialize(); return snapshot(); } };
}
