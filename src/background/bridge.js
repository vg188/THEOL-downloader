import { AppError, ORIGIN, schoolUrl, validateFile, normalizeResourceUrl, errorResult } from '../platform/policy.js';
import { courseTitle } from '../platform/parse.js';

const count = value => Number.isInteger(value) && value >= 0 ? value : 0;

export function emptyScan(message = '打开课程资源目录，然后扫描当前列表') {
  return { id: '', phase: 'idle', context: null, files: [], failures: [], unitFailures: [],
    units: { processed: 0, total: 0, discovered: 0 }, total: 0, processed: 0, skipped: 0, settledIds: [], message, errorCode: '' };
}
function sameIds(left, right) {
  const before = Array.isArray(left) ? left : [], after = Array.isArray(right) ? right : [];
  return before.length === after.length && before.every((id, index) => id === after[index]);
}
function sameContext(left, right) {
  if (!left || !right || !['tabId', 'frameId', 'documentId', 'key'].every(key => left[key] === right[key])) return false;
  // All-mode IDs accumulate with every discovered batch, so only a current
  // selection is pinned by the inspected resource set.
  return left.mode !== 'current' || sameIds(left.resourceIds, right.resourceIds);
}
function unitFailure(value) {
  return { kind: 'unit', columnId: String(value?.columnId ?? '').slice(0, 20), title: String(value?.title || '单元').slice(0, 200),
    code: String(value?.code || 'NETWORK').slice(0, 40), message: String(value?.message || '无法读取该单元').slice(0, 240) };
}
const courseIdOf = surface => surface.directory?.courseId || surface.unitPage?.courseId || '';
// Frame selection: a unit page owns the frames below it (its courseware list may
// be rendered by a child), so a unit surface outranks a plain directory frame.
// Within the winning kind the focused document decides, then the deepest frame.
// Equal candidates stay ambiguous — never merge or guess.
function activeFrame(candidates) {
  if (candidates.length === 1) return candidates[0];
  const rank = candidate => candidate.result.surface.surface === 'unit-study' ? 1 : 0;
  const best = Math.max(...candidates.map(rank));
  const sameKind = candidates.filter(candidate => rank(candidate) === best);
  const focused = sameKind.filter(candidate => candidate.result.hasFocus === true);
  const pool = focused.length ? focused : sameKind;
  const depth = Math.max(...pool.map(candidate => count(candidate.result.depth)));
  const deepest = pool.filter(candidate => count(candidate.result.depth) === depth);
  if (deepest.length !== 1) throw new AppError('AMBIGUOUS_DIRECTORY', '页面有多个资源列表，请单独打开需要下载的目录');
  return deepest[0];
}
export function createBridge(chrome, { readScan, writeScan }) {
  let tail = Promise.resolve();
  const serialized = work => { const task = tail.then(work); tail = task.catch(() => {}); return task; };

  async function locate(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new AppError('UNSUPPORTED_PAGE', '请先打开学校教学平台的课程资源页');
    const tab = await chrome.tabs.get(tabId);
    try { schoolUrl(tab.url); } catch { throw new AppError('UNSUPPORTED_PAGE', '请先打开学校教学平台的课程资源页'); }
    let frames;
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => {
        const described = globalThis.__BUCT_COURSE_V1__?.describe();
        if (!described) return null;
        // Depth decides between the course shell and its content frame: a unit
        // page and its containing layout share the same URL policy.
        let depth = 0, scope = window;
        try { while (scope !== scope.parent) { depth++; scope = scope.parent; } } catch { /* an opaque ancestor is still an ancestor */ }
        return { ...described, hasFocus: document.hasFocus(), depth };
      } });
    } catch { throw new AppError('NO_DIRECTORY', '暂时无法读取页面，请等待加载完成后重试'); }
    const top = frames.find(frame => frame.frameId === 0)?.result;
    const expectedCourse = top?.url ? schoolUrl(top.url).searchParams.get('courseId') : null;
    const candidates = frames.filter(frame => frame.result?.surface && (!expectedCourse || courseIdOf(frame.result.surface) === expectedCourse));
    if (!candidates.length) throw new AppError('NO_DIRECTORY', '请进入“课程资源”下的课件目录，再扫描当前列表');
    return { frame: activeFrame(candidates), top };
  }
  // `all` is the only mode beyond the safe default; anything else inspects as
  // the current page so a malformed request can never widen a scan.
  async function inspect(tabId, mode = 'current') {
    const { frame, top } = await locate(tabId);
    const surface = frame.result.surface;
    const selected = mode === 'all' && surface.modeOptions.includes('all') ? 'all' : 'current';
    const directory = surface.directory || null, unitPage = surface.unitPage || null;
    const resources = directory ? directory.resources : unitPage.resources;
    const context = {
      tabId, frameId: frame.frameId, documentId: frame.documentId,
      courseId: courseIdOf(surface), folderId: directory ? directory.folderId : null,
      // The key is the selection identity: surface, mode, folder or current
      // unit page, and the ordered unit index.
      key: `${surface.surface}|${selected}|${directory?.key || unitPage?.url || ''}|${surface.unitIndex?.key || ''}`,
      courseName: courseTitle(top?.title), url: directory ? directory.url : unitPage.url,
      surface: surface.surface, mode: selected, unitKey: unitPage ? unitPage.url : '',
      modeOptions: [...surface.modeOptions], resourceIds: selected === 'all' ? [] : resources.map(resource => resource.id),
    };
    return { context, surface };
  }
  async function start(tabId, mode = 'current') {
    const requested = mode === 'all' ? 'all' : 'current';
    const { context } = await inspect(tabId, requested);
    if (requested === 'all' && context.mode !== 'all') throw new AppError('INVALID_MESSAGE', '当前页面不支持扫描全部单元');
    const total = context.resourceIds.length;
    const state = { ...emptyScan(), id: crypto.randomUUID(), phase: 'scanning', context, total,
      message: requested === 'all' ? '正在读取单元页面…' : total ? '正在读取原文件信息…' : '正在检查当前列表…' };
    await serialized(() => writeScan(state));
    const target = context.documentId ? { tabId, documentIds: [context.documentId] } : { tabId, frameIds: [context.frameId] };
    void chrome.scripting.executeScript({ target, args: [state.id, context.mode], func: (scanId, mode) => {
      if (!globalThis.__BUCT_COURSE_V1__) throw new Error('Scanner unavailable');
      return globalThis.__BUCT_COURSE_V1__.scan(scanId, { mode });
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
      if (!event || !['progress', 'unit-progress', 'discovered', 'complete', 'fatal'].includes(event.kind)) {
        throw new AppError('INVALID_MESSAGE', '扫描消息格式无效');
      }
      if (event.kind === 'unit-progress') {
        // Display-only counters: they never admit resource IDs.
        if (ctx.mode !== 'all') throw new AppError('INVALID_MESSAGE', '扫描消息格式无效');
        current.units = { processed: count(event.processed), total: count(event.total), discovered: count(event.discovered) };
        if (event.failure) current.unitFailures.push(unitFailure(event.failure));
      } else if (event.kind === 'discovered') {
        // Only the active unit frame of this scan generation may introduce IDs,
        // and each descriptor is re-validated from its canonical preview URL.
        if (ctx.mode !== 'all' || !Array.isArray(event.resources)) throw new AppError('INVALID_MESSAGE', '扫描消息格式无效');
        for (const descriptor of event.resources) {
          let preview;
          try { preview = normalizeResourceUrl(descriptor?.previewUrl, 'preview'); }
          catch { throw new AppError('INVALID_MESSAGE', '发现不属于当前课程的资源'); }
          if (preview.courseId !== ctx.courseId || (descriptor.id != null && descriptor.id !== preview.id)) {
            throw new AppError('INVALID_MESSAGE', '发现不属于当前课程的资源');
          }
          if (!ctx.resourceIds.includes(preview.id)) ctx.resourceIds.push(preview.id);
        }
        current.total = ctx.resourceIds.length;
        if (current.total) current.message = '正在读取原文件信息…';
      } else if (event.kind === 'progress') {
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
        if (Array.isArray(event.unitFailures)) current.unitFailures = event.unitFailures.map(unitFailure);
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
    const checked = await readScan();
    let page;
    try { page = await inspect(tabId, checked?.context?.mode); }
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
    const { context } = await inspect(tabId, current.context.mode);
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
