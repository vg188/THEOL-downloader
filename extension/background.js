import { isSchoolUrl, validateFile, flattenFiles, isDownloadable, requiresPreparedDownload, problem } from '../src/runtime/policy.js';
import { preflightFile } from '../src/runtime/network.js';
import { createDownloadQueue } from '../src/runtime/download-queue.js';
import { createPreviewHost } from './preview-host.js';
const previewHost = createPreviewHost(chrome);

const PANEL_URL = chrome.runtime.getURL('panel.html');
const QUEUE_KEY = 'courseResourceQueueV2';
const SCAN_KEY = 'courseResourceScanV2';
const RECONCILE_ALARM = 'courseResourceReconcileV2';
async function maintainWakeup(jobs) {
  const active = jobs.some(job => ['queued', 'preparing', 'downloading'].includes(job.status));
  const alarm = await chrome.alarms.get(RECONCILE_ALARM);
  if (active && !alarm) await chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 0.5 });
  else if (!active && alarm) await chrome.alarms.clear(RECONCILE_ALARM);
  if (!active) await previewHost.close();
}
let generation = 0;
const queue = createDownloadQueue({
  extensionId: chrome.runtime.id,
  downloads: chrome.downloads,
  preflight: (file, context) => requiresPreparedDownload(file) ? previewHost.prepare(file, context) : preflightFile(file),
  releasePrepared: jobId => previewHost.release(jobId),
  storage: {
    read: async () => (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY],
    write: async state => {
      await chrome.storage.local.set({ [QUEUE_KEY]: state });
      await maintainWakeup(state.jobs).catch(error => console.error('设置下载状态恢复检查失败', error));
    },
  },
});

function trustedPanel(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.split(/[?#]/)[0] === PANEL_URL;
}
async function openPanel(courseTabId) {
  let changed = false;
  if (Number.isInteger(courseTabId)) {
    const tab = await chrome.tabs.get(courseTabId);
    if (isSchoolUrl(tab.url)) {
      const bindingGeneration = generation;
      const stored = await chrome.storage.session.get(null), snapshot = stored[SCAN_KEY];
      let sameCourse = false;
      if (snapshot?.result) {
        const context = await sendToCourse(tab.id, { type: 'BUCT_CONTEXT' }).catch(() => null);
        sameCourse = context?.ok && context.contextKey === snapshot.contextKey;
      }
      const latest = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
      if (bindingGeneration !== generation || latest?.id !== snapshot?.id) {
        // A concurrent explicit refresh owns the newer snapshot.
      } else if (sameCourse) {
        // Focusing the same course (even in another tab) keeps its snapshot and selection.
        await chrome.storage.session.set({ courseTabId, [SCAN_KEY]: { ...snapshot, tabId: tab.id, tabUrl: tab.url } });
      } else if (stored.courseTabId !== courseTabId || snapshot) {
        generation++;
        changed = true;
        await chrome.storage.session.set({ courseTabId, [SCAN_KEY]: null });
      }
    }
  }
  const existing = await chrome.tabs.query({ url: PANEL_URL + '*' });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    if (changed) await chrome.runtime.sendMessage({ type: 'COURSE_TAB_CHANGED' }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: PANEL_URL });
}
async function resolveCourseTab() {
  const { courseTabId } = await chrome.storage.session.get('courseTabId');
  if (Number.isInteger(courseTabId)) {
    try { const tab = await chrome.tabs.get(courseTabId); if (isSchoolUrl(tab.url)) return tab; } catch { /* closed tab */ }
  }
  const tabs = await chrome.tabs.query({ url: ['https://course.buct.edu.cn/*', 'http://course.buct.edu.cn/*'] });
  const chosen = tabs.find(tab => tab.active) || (tabs.length === 1 ? tabs[0] : null);
  if (!chosen) throw problem('NO_COURSE', tabs.length ? '打开了多个课程，请在要下载的课程页点击扩展图标' : '请先打开学校教学平台的课程页');
  return chosen;
}
async function sendToCourse(tabId, payload) {
  try { return await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
  }
}
async function scan(message) {
  const mode = message.mode || 'course';
  if (!['course', 'auto', 'directory', 'tree', 'unit-current', 'unit-all'].includes(mode)) throw problem('INVALID_MODE', '不支持的扫描范围');
  const tab = message.tabId == null ? await resolveCourseTab() : await chrome.tabs.get(message.tabId);
  if (!Number.isInteger(tab.id) || !isSchoolUrl(tab.url)) throw problem('NO_COURSE', '请先打开学校教学平台的课程页');
  if (message.reuse === true) {
    const snapshot = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
    if (snapshot?.result && snapshot.tabId === tab.id && snapshot.result.defaultMode === mode) {
      const context = await sendToCourse(tab.id, { type: 'BUCT_CONTEXT' });
      const latest = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
      if (context?.ok && context.contextKey === snapshot.contextKey && latest?.id === snapshot.id) {
        return { ...snapshot.result, scanId: snapshot.id, tabId: tab.id, reused: true };
      }
    }
  }
  const current = ++generation;
  await chrome.storage.session.set({ courseTabId: tab.id, [SCAN_KEY]: null });
  const result = await sendToCourse(tab.id, { type: 'BUCT_SCAN', mode });
  if (current !== generation) throw problem('STALE_SCAN', '扫描已被更新的课程或扫描替换，请重试');
  if (!result?.ok) return result || { ok: false, error: '扫描无响应，请刷新课程页后重试' };
  if (!result.contextKey) throw problem('INVALID_SCAN', '扫描上下文缺失，请刷新课程页');
  const seen = new Set();
  flattenFiles(result.tree).filter(file => {
    if (!isDownloadable(file) || seen.has(file.id)) return false;
    seen.add(file.id); return true;
  }).forEach(file => validateFile(file, result.lid));
  const { tree, unitIndex = [], failures = [], surface, defaultMode, modes, contextKey, lid, courseName } = result;
  const cachedResult = { ok: true, tree, unitIndex, failures, surface, defaultMode, modes, contextKey, lid, courseName };
  // Store the tree once rather than duplicating every text body and page list
  // across files, resourceTree, unitTree and the view returned to the panel.
  const snapshot = { id: crypto.randomUUID(), tabId: tab.id, tabUrl: tab.url, lid, contextKey, courseName: courseName || '课件', result: cachedResult };
  await chrome.storage.session.set({ [SCAN_KEY]: snapshot });
  return { ...result, scanId: snapshot.id, tabId: tab.id };
}
async function enqueue(message) {
  const snapshot = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
  if (!snapshot || snapshot.id !== message.scanId) throw problem('STALE_SCAN', '扫描已过期，请重新扫描后选择文件');
  if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > 2000 || message.ids.some(id => typeof id !== 'string')) throw problem('INVALID_SELECTION', '请选择有效的课件');
  const byId = new Map();
  for (const file of snapshot.result ? flattenFiles(snapshot.result.tree) : snapshot.files || []) {
    if (isDownloadable(file) && !byId.has(file.id)) byId.set(file.id, validateFile(file, snapshot.lid));
  }
  const ids = [...new Set(message.ids)];
  if (ids.some(id => !byId.has(id))) throw problem('INVALID_SELECTION', '所选文件不属于本次扫描');
  const tab = await chrome.tabs.get(snapshot.tabId);
  if (!isSchoolUrl(tab.url)) throw problem('STALE_SCAN', '已离开教学平台，请打开对应课程后下载');
  const context = await sendToCourse(tab.id, { type: 'BUCT_CONTEXT' });
  const latest = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
  if (!context?.ok) throw problem(context?.code || 'STALE_SCAN', context?.error || '暂时无法确认课程，请回到对应课程页后重试');
  if (context.contextKey !== snapshot.contextKey) throw problem('STALE_SCAN', '已切换课程，请汇总当前课程后下载');
  if (latest?.id !== snapshot.id) throw problem('STALE_SCAN', '课程列表已刷新，请使用当前列表选择文件');
  // Message-supplied URLs/names are intentionally ignored; only stored files enter the queue.
  return { ok: true, ...await queue.enqueue(ids.map(id => byId.get(id)), { courseName: snapshot.courseName, requestId: message.requestId }) };
}
async function dispatch(message) {
  switch (message.type) {
    case 'OPEN_PANEL': await openPanel(message.tabId); return { ok: true };
    case 'GET_COURSE_TAB': { const tab = await resolveCourseTab(); return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title || '' } }; }
    case 'SCAN_TAB': return scan(message);
    case 'ENQUEUE': return enqueue(message);
    case 'GET_JOBS': return { ok: true, jobs: await queue.refresh() };
    case 'RETRY_JOB': return { ok: true, jobs: await queue.retry(message.id) };
    case 'CLEAR_FINISHED': return { ok: true, jobs: await queue.clearFinished() };
    default: throw problem('INVALID_MESSAGE', '不支持的操作');
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || message.target === 'course-preview-host') return false;
  if (!trustedPanel(sender)) { sendResponse({ ok: false, code: 'FORBIDDEN', error: '只有扩展面板可以执行此操作' }); return false; }
  dispatch(message).then(sendResponse, error => sendResponse({ ok: false, code: error.code || 'OPERATION_FAILED', error: error.message || '操作失败，请重试' }));
  return true;
});
chrome.action.onClicked.addListener(tab => { void openPanel(tab?.id).catch(error => console.error('打开课程资源面板失败', error)); });
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error || delta.finalUrl || delta.mime || delta.filename || delta.totalBytes || delta.exists) void queue.refresh().catch(error => console.error('更新下载记录失败', error));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONCILE_ALARM) void queue.refresh().catch(error => console.error('后台下载状态对账失败', error));
});
void queue.init().catch(error => console.error('恢复下载队列失败', error));
