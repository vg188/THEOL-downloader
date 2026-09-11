import { AppError, validateFile, buildFilename, normalizeResourceUrl, isUnsafeMime, errorResult } from '../platform/policy.js';

const ACTIVE = new Set(['queued', 'preparing', 'downloading']);
function nativeFailure(error) {
  if (error === 'USER_CANCELED') return { code: 'CANCELLED', message: '已在 Chrome 中取消下载，可手动重试' };
  if (/SERVER_(UNAUTHORIZED|FORBIDDEN)/.test(error || '')) return { code: 'NO_DOWNLOAD', message: '登录失效或资源无下载权限，请在平台确认后重试' };
  if (error === 'FILE_NO_SPACE') return { code: 'INTERRUPTED', message: '磁盘空间不足，请释放空间后重试' };
  if (/FILE_(ACCESS_DENIED|BLOCKED|SECURITY_CHECK_FAILED)/.test(error || '')) return { code: 'INTERRUPTED', message: 'Chrome 或系统阻止了文件保存，请检查下载提示' };
  return { code: 'INTERRUPTED', message: '下载中断，请检查 Chrome 下载页和网络后重试' };
}
export function createQueue({ storage, downloads, preflight, extensionId, clock = Date.now, makeId = () => crypto.randomUUID() }) {
  let state = { jobs: [], requests: [] }, lastSaved = '', tail = Promise.resolve(), ready, pumping = false;
  const copy = () => structuredClone(state);
  const serial = work => { const task = tail.then(work); tail = task.catch(() => {}); return task; };
  async function save() {
    const next = JSON.stringify(state);
    if (next !== lastSaved) { await storage.write(copy()); lastSaved = next; }
  }
  function fail(job, error) {
    const info = errorResult(error); job.status = 'failed'; job.error = info.message; job.errorCode = info.code;
  }
  async function applyNative(job, item) {
    if (!item) { fail(job, new AppError('INTERRUPTED', 'Chrome 中已找不到该下载，请手动重试')); return; }
    let valid = true;
    try { valid = normalizeResourceUrl(item.finalUrl || item.url, 'download').id === job.file.id; } catch { valid = false; }
    if (!valid || isUnsafeMime(item.mime)) {
      if (item.state === 'in_progress') await downloads.cancel(item.id).catch(() => {});
      fail(job, new AppError('BAD_FILE', '服务器未返回所选原文件，已停止；请重新登录后重试')); return;
    }
    job.bytesReceived = Math.max(0, Number(item.bytesReceived) || 0);
    job.totalBytes = Math.max(0, Number(item.totalBytes) || Number(item.fileSize) || 0);
    if (item.state === 'complete') { job.status = 'complete'; job.error = ''; job.errorCode = ''; }
    else if (item.state === 'interrupted') { const info = nativeFailure(item.error); fail(job, new AppError(info.code, info.message)); }
    else job.status = 'downloading';
  }
  function ensureReady() {
    if (!ready) ready = serial(async () => {
      const saved = await storage.read();
      if (saved && Array.isArray(saved.jobs)) {
        state = { jobs: saved.jobs, requests: Array.isArray(saved.requests) ? saved.requests : [] };
        lastSaved = JSON.stringify(state);
        state.jobs = state.jobs.filter(job => {
          try { job.file = validateFile(job.file); return typeof job.id === 'string'; } catch { return false; }
        });
      }
      for (const job of state.jobs) {
        if (job.status === 'downloading' && Number.isInteger(job.downloadId)) {
          await applyNative(job, (await downloads.search({ id: job.downloadId }))[0]);
        } else if (job.status === 'preparing') {
          const matches = job.startedAt ? (await downloads.search({ url: job.file.downloadUrl, startedAfter: new Date(job.startedAt).toISOString() }))
            .filter(item => item.byExtensionId === extensionId) : [];
          if (matches.length === 1) { job.downloadId = matches[0].id; await applyNative(job,matches[0]); }
          else fail(job, new AppError('RECOVERY_REQUIRED', '后台恢复时未能确认此项下载，请手动重试，避免重复文件'));
        }
      }
      await save();
    });
    return ready;
  }
  function kick() { void pump().catch(() => { /* A later Chrome event or popup request retries a failed state refresh. */ }); }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      await ensureReady();
      const reserved = await serial(async () => {
        const busy = state.jobs.filter(j => ['preparing','downloading'].includes(j.status)).length;
        const jobs = state.jobs.filter(j => j.status === 'queued').slice(0, Math.max(0,2-busy));
        for (const job of jobs) { job.status = 'preparing'; job.error = ''; job.errorCode = ''; }
        await save(); return structuredClone(jobs);
      });
      for (const job of reserved) void launch(job).catch(() => {});
    } finally { pumping = false; }
  }
  async function launch(reserved) {
    try {
      await preflight(reserved.file);
      await serial(async () => {
        const job = state.jobs.find(j => j.id === reserved.id);
        if (!job || job.status !== 'preparing') return;
        job.startedAt = clock(); await save();
        job.downloadId = await downloads.download({ url: job.file.downloadUrl,
          filename: buildFilename(job.file.courseName, job.file.name), conflictAction: 'uniquify', saveAs: false });
        job.status = 'downloading'; await save();
        await applyNative(job,(await downloads.search({ id: job.downloadId }))[0]); await save();
      });
    } catch (error) {
      await serial(async () => {
        const job = state.jobs.find(j => j.id === reserved.id);
        if (!job) return;
        if (Number.isInteger(job.downloadId) && job.status === 'downloading') await downloads.cancel(job.downloadId).catch(() => {});
        fail(job,error); await save();
      });
    } finally { kick(); }
  }
  async function init() { await ensureReady(); kick(); return copy(); }
  async function enqueue(inputs, requestId) {
    await ensureReady();
    if (!Array.isArray(inputs) || !inputs.length || typeof requestId !== 'string' || !requestId || requestId.length > 100) {
      throw new AppError('INVALID_MESSAGE', '请先选择要下载的课件');
    }
    const files = inputs.map(validateFile);
    const result = await serial(async () => {
      if (state.requests.includes(requestId)) return copy();
      state.requests.push(requestId); state.requests = state.requests.slice(-200);
      for (const file of files) {
        if (state.jobs.some(j => j.file.id === file.id && ACTIVE.has(j.status))) continue;
        let id = makeId(); while (state.jobs.some(j => j.id === id)) id = makeId();
        state.jobs.push({ id, file, status: 'queued', downloadId: null, createdAt: clock(), startedAt: null,
          bytesReceived: 0, totalBytes: 0, error: '', errorCode: '' });
      }
      await save(); return copy();
    });
    kick(); return result;
  }
  async function retry(ids) {
    await ensureReady();
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new AppError('INVALID_MESSAGE', '重试任务无效');
    const result = await serial(async () => {
      for (const job of state.jobs) {
        if (!ids.includes(job.id) || job.status !== 'failed') continue;
        if (state.jobs.some(other => other.id !== job.id && other.file.id === job.file.id && ACTIVE.has(other.status))) continue;
        Object.assign(job,{ status:'queued',downloadId:null,startedAt:null,error:'',errorCode:'',bytesReceived:0,totalBytes:0 });
      }
      await save(); return copy();
    });
    kick(); return result;
  }
  async function refresh() {
    await ensureReady();
    const result = await serial(async () => {
      for (const job of state.jobs) if (job.status === 'downloading' && Number.isInteger(job.downloadId)) {
        await applyNative(job,(await downloads.search({id:job.downloadId}))[0]);
      }
      await save(); return copy();
    });
    kick(); return result;
  }
  async function getState() { await ensureReady(); return copy(); }
  return { init, enqueue, retry, refresh, getState };
}
