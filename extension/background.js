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
  // Update the course binding before opening/focusing the panel, including reuse.
  if (Number.isInteger(courseTabId)) {
    const tab = await chrome.tabs.get(courseTabId);
    if (isSchoolUrl(tab.url)) {
      generation++;
      await chrome.storage.session.set({ courseTabId, [SCAN_KEY]: null });
    }
  }
  const existing = await chrome.tabs.query({ url: PANEL_URL + '*' });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    await chrome.runtime.sendMessage({ type: 'COURSE_TAB_CHANGED' }).catch(() => {});
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
  if (!['auto', 'directory', 'tree', 'unit-current', 'unit-all'].includes(message.mode || 'auto')) throw problem('INVALID_MODE', '不支持的扫描范围');
  const tab = message.tabId == null ? await resolveCourseTab() : await chrome.tabs.get(message.tabId);
  if (!Number.isInteger(tab.id) || !isSchoolUrl(tab.url)) throw problem('NO_COURSE', '请先打开学校教学平台的课程页');
  const current = ++generation;
  await chrome.storage.session.set({ [SCAN_KEY]: null });
  const result = await sendToCourse(tab.id, { type: 'BUCT_SCAN', mode: message.mode || 'auto' });
  if (current !== generation) throw problem('STALE_SCAN', '扫描已被更新的课程或扫描替换，请重试');
  if (!result?.ok) return result || { ok: false, error: '扫描无响应，请刷新课程页后重试' };
  if (!result.contextKey) throw problem('INVALID_SCAN', '扫描上下文缺失，请刷新课程页');
  const files = flattenFiles(result.tree).filter(isDownloadable).map(file => validateFile(file, result.lid));
  const snapshot = { id: crypto.randomUUID(), tabId: tab.id, tabUrl: tab.url, contextKey: result.contextKey, courseName: result.courseName || '课件', files };
  await chrome.storage.session.set({ [SCAN_KEY]: snapshot });
  return { ...result, scanId: snapshot.id, tabId: tab.id };
}
async function enqueue(message) {
  const snapshot = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
  if (!snapshot || snapshot.id !== message.scanId) throw problem('STALE_SCAN', '扫描已过期，请重新扫描后选择文件');
  if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > 2000 || message.ids.some(id => typeof id !== 'string')) throw problem('INVALID_SELECTION', '请选择有效的课件');
  const byId = new Map(snapshot.files.map(file => [file.id, file]));
  const ids = [...new Set(message.ids)];
  if (ids.some(id => !byId.has(id))) throw problem('INVALID_SELECTION', '所选文件不属于本次扫描');
  const tab = await chrome.tabs.get(snapshot.tabId);
  if (tab.url !== snapshot.tabUrl || !isSchoolUrl(tab.url)) throw problem('STALE_SCAN', '课程页面已改变，请重新扫描');
  const context = await sendToCourse(tab.id, { type: 'BUCT_CONTEXT' });
  const latest = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
  if (!context?.ok || context.contextKey !== snapshot.contextKey || latest?.id !== snapshot.id) throw problem('STALE_SCAN', '目录或单元已改变，请重新扫描后再下载');
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
