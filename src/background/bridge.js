import { AppError, ORIGIN, schoolUrl, validateFile, errorResult } from '../platform/policy.js';
import { courseTitle } from '../platform/parse.js';

export function emptyScan(message = '打开课程资源目录，然后扫描当前列表') {
  return { id: '', phase: 'idle', context: null, files: [], failures: [], total: 0, processed: 0, skipped: 0, settledIds: [], message, errorCode: '' };
}
function sameContext(left, right) {
  return left && right && ['tabId', 'frameId', 'documentId', 'key'].every(key => left[key] === right[key]);
}
export function createBridge(chrome, { readScan, writeScan }) {
  let tail = Promise.resolve();
  const serialized = work => { const task = tail.then(work); tail = task.catch(() => {}); return task; };

  async function inspect(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new AppError('UNSUPPORTED_PAGE', '请先打开学校教学平台的课程资源页');
    const tab = await chrome.tabs.get(tabId);
    try { schoolUrl(tab.url); } catch { throw new AppError('UNSUPPORTED_PAGE', '请先打开学校教学平台的课程资源页'); }
    let frames;
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.__BUCT_COURSE_V1__?.describe() });
    } catch { throw new AppError('NO_DIRECTORY', '暂时无法读取页面，请等待加载完成后重试'); }
    const top = frames.find(frame => frame.frameId === 0)?.result;
    const expectedCourse = top?.url ? schoolUrl(top.url).searchParams.get('courseId') : null;
    const candidates = frames.filter(frame => frame.result?.directory && (!expectedCourse || frame.result.directory.courseId === expectedCourse));
    if (!candidates.length) throw new AppError('NO_DIRECTORY', '请进入“课程资源”下的课件目录，再扫描当前列表');
    if (candidates.length !== 1) throw new AppError('AMBIGUOUS_DIRECTORY', '页面有多个资源列表，请单独打开需要下载的目录');
    const frame = candidates[0], directory = frame.result.directory;
    const context = { tabId, frameId: frame.frameId, documentId: frame.documentId,
      courseId: directory.courseId, folderId: directory.folderId, key: directory.key,
      courseName: courseTitle(top?.title), url: directory.url, resourceIds: directory.resources.map(r => r.id) };
    return { context, directory };
  }
  async function start(tabId) {
    const { context, directory } = await inspect(tabId);
    const state = { ...emptyScan(), id: crypto.randomUUID(), phase: 'scanning', context, total: directory.resources.length,
      message: directory.resources.length ? '正在读取原文件信息…' : '正在检查当前列表…' };
    await serialized(() => writeScan(state));
    const target = context.documentId ? { tabId, documentIds: [context.documentId] } : { tabId, frameIds: [context.frameId] };
    void chrome.scripting.executeScript({ target, args: [state.id], func: scanId => {
      if (!globalThis.__BUCT_COURSE_V1__) throw new Error('Scanner unavailable');
      return globalThis.__BUCT_COURSE_V1__.scan(scanId);
    } }).catch(() => serialized(async () => {
      const current = await readScan();
      if (current?.id === state.id && current.phase === 'scanning') {
        await writeScan({ ...current, phase: 'error', errorCode: 'STALE_SCAN', message: '扫描中断，页面可能已切换；请重新扫描' });
      }
    }).catch(() => {}));
    return state;
  }
  async function receive(message, sender) {
    return serialized(async () => {
      const current = await readScan();
      if (!current || current.id !== message.scanId || current.phase !== 'scanning') return null;
      const ctx = current.context;
      let origin;
      try { origin = schoolUrl(sender.url).origin; } catch { origin = ''; }
      if (sender.id !== chrome.runtime.id || origin !== ORIGIN || sender.tab?.id !== ctx.tabId || sender.frameId !== ctx.frameId ||
        (ctx.documentId && sender.documentId !== ctx.documentId)) throw new AppError('INVALID_MESSAGE', '忽略不可信的页面消息');
      const event = message.event;
      if (!event || !['progress', 'complete', 'fatal'].includes(event.kind)) throw new AppError('INVALID_MESSAGE', '扫描消息格式无效');
      if (event.kind === 'progress') {
        const id = event.file?.id || event.failure?.id || event.skipped?.id;
        if (!ctx.resourceIds.includes(id)) throw new AppError('INVALID_MESSAGE', '资源不在当前已扫描的列表中');
        if (current.settledIds.includes(id)) return current;
        if (event.file) {
          const file = validateFile({ ...event.file, courseName: ctx.courseName });
          if (file.courseId !== ctx.courseId) throw new AppError('INVALID_MESSAGE', '课件不属于当前课程');
          current.files.push(file);
          current.files.sort((a,b) => ctx.resourceIds.indexOf(a.id) - ctx.resourceIds.indexOf(b.id));
        } else if (event.failure) {
          current.failures.push({ id, title: String(event.failure.title || '课件').slice(0,300),
            code: String(event.failure.code || 'NETWORK').slice(0,40), message: String(event.failure.message || '无法读取该课件').slice(0,240) });
        } else current.skipped++;
        current.settledIds.push(id); current.processed = current.settledIds.length;
        current.message = `正在识别 ${current.processed} / ${current.total}`;
      } else if (event.kind === 'complete') {
        current.phase = current.processed === current.total ? 'ready' : 'error';
        current.errorCode = current.phase === 'ready' ? '' : 'INTERRUPTED';
        current.message = current.phase === 'ready' ? `找到 ${current.files.length} 份课件` : '部分扫描结果缺失，请重新扫描';
      } else {
        current.phase = 'error'; current.errorCode = String(event.error?.code || 'NETWORK').slice(0,40);
        current.message = String(event.error?.message || '扫描未完成，请重新尝试').slice(0,240);
      }
      await writeScan(current); return current;
    });
  }
  async function getState(tabId, checkContext = true) {
    if (!checkContext) return { scan: await readScan() || emptyScan() };
    const checked = await readScan(); let page;
    try { page = { context: (await inspect(tabId)).context }; }
    catch (error) { page = { error: errorResult(error) }; }
    return serialized(async () => {
      let scan = await readScan() || emptyScan();
      // Only the inspected generation may be invalidated; a newer scan wins.
      if (scan.context && scan.id === checked?.id && !sameContext(scan.context, page.context)) {
        scan = emptyScan(page.error?.message || '目录已变化，请重新扫描');
        await writeScan(scan);
      }
      return { scan, page };
    });
  }
  async function assertCurrent(tabId, scanId) {
    const current = await readScan();
    if (!current || current.id !== scanId || current.context?.tabId !== tabId || current.phase !== 'ready') {
      throw new AppError('STALE_SCAN', '请先完成当前目录的扫描');
    }
    const { context } = await inspect(tabId);
    return serialized(async () => {
      // Inspection yields to other requests. Never submit or clear a newer scan.
      const latest = await readScan();
      if (!latest || latest.id !== scanId || latest.context?.tabId !== tabId || latest.phase !== 'ready') {
        throw new AppError('STALE_SCAN', '扫描已更新，请重新选择当前列表的课件');
      }
      if (!sameContext(context, latest.context)) {
        await writeScan(emptyScan('目录已变化，请重新扫描'));
        throw new AppError('STALE_SCAN', '目录已变化，原有选择已清空；请重新扫描');
      }
      return latest;
    });
  }
  return { inspect, start, receive, getState, assertCurrent };
}
