/* 北化课件下载 · 标签版 — service worker
 * 职责：打开标签页面板、扫描协调、下载队列（并发 2）、chrome.downloads。
 */

const MAX_PARALLEL = 2;
const PANEL_URL = chrome.runtime.getURL('src/panel.html');

/** @type {Map<string, Job>} */
const jobs = new Map();
let activeCount = 0;

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} url
 * @property {string} filename
 * @property {string} name
 * @property {'queued'|'preparing'|'downloading'|'done'|'failed'|'cancelled'} status
 * @property {string} [error]
 * @property {number} [downloadId]
 * @property {number} createdAt
 */

chrome.action.onClicked.addListener(async (tab) => {
  await openPanel(tab?.id);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'OPEN_PANEL') {
    openPanel(message.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return sendResponse({ ok: false, error: '没有活动标签页' });
      sendResponse({
        ok: true,
        tab: { id: tab.id, url: tab.url || '', title: tab.title || '' },
      });
    });
    return true;
  }

  if (message.type === 'GET_COURSE_TAB') {
    resolveCourseTab().then((info) => {
      if (!info) sendResponse({ ok: false, error: '请先打开学校教学平台的课程页' });
      else sendResponse({ ok: true, tab: info });
    });
    return true;
  }

  if (message.type === 'SCAN_TAB') {
    handleScan(message).then(sendResponse);
    return true;
  }

  if (message.type === 'ENQUEUE') {
    handleEnqueue(message, sendResponse);
    return true;
  }

  if (message.type === 'GET_JOBS') {
    sendResponse({ ok: true, jobs: listJobs() });
    return true;
  }

  if (message.type === 'RETRY_JOB') {
    handleRetry(message, sendResponse);
    return true;
  }

  if (message.type === 'CLEAR_FINISHED') {
    for (const [id, job] of jobs) {
      if (job.status === 'done' || job.status === 'cancelled') jobs.delete(id);
    }
    sendResponse({ ok: true, jobs: listJobs() });
    return true;
  }

  return false;
});

async function openPanel(courseTabId) {
  const existing = await chrome.tabs.query({ url: PANEL_URL + '*' });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  const created = await chrome.tabs.create({ url: PANEL_URL });
  if (courseTabId != null) {
    await chrome.storage.session.set({ courseTabId: Number(courseTabId) });
  }
  return created;
}

function isSchoolUrl(url) {
  return /^https?:\/\/course\.buct\.edu\.cn\//i.test(String(url || ''));
}

async function resolveCourseTab() {
  const { courseTabId } = await chrome.storage.session.get('courseTabId');
  if (Number.isFinite(courseTabId)) {
    try {
      const tab = await chrome.tabs.get(courseTabId);
      if (tab?.id != null && isSchoolUrl(tab.url)) {
        return { id: tab.id, url: tab.url || '', title: tab.title || '' };
      }
    } catch {
      /* fall through */
    }
  }
  const tabs = await chrome.tabs.query({ url: ['https://course.buct.edu.cn/*', 'http://course.buct.edu.cn/*'] });
  // 优先当前窗口的活动页
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = active[0];
  if (activeTab?.id != null && isSchoolUrl(activeTab.url)) {
    return { id: activeTab.id, url: activeTab.url || '', title: activeTab.title || '' };
  }
  if (tabs.length) {
    const tab = tabs[0];
    return { id: tab.id, url: tab.url || '', title: tab.title || '' };
  }
  return null;
}

// ---------- 扫描 ----------

async function handleScan(message) {
  try {
    let courseTabId = message.tabId;
    if (courseTabId == null) {
      const info = await resolveCourseTab();
      if (!info) {
        return {
          ok: false,
          code: 'NOT_SCHOOL',
          error: '请先打开学校教学平台（course.buct.edu.cn）的课程页',
        };
      }
      courseTabId = info.id;
    }
    courseTabId = Number(courseTabId);
    if (!Number.isFinite(courseTabId)) {
      return { ok: false, error: '请先打开学校教学平台的课程页' };
    }

    const tab = await chrome.tabs.get(courseTabId);
    if (!isSchoolUrl(tab?.url)) {
      return {
        ok: false,
        code: 'NOT_SCHOOL',
        error: '请先打开学校教学平台（course.buct.edu.cn）的课程页',
      };
    }

    const payload = {
      type: 'BUCT_SCAN',
      mode: message.mode || 'auto',
      recursive: message.recursive !== false,
    };

    let result;
    try {
      result = await chrome.tabs.sendMessage(courseTabId, payload);
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: courseTabId, allFrames: true },
        files: ['content.js'],
      });
      result = await chrome.tabs.sendMessage(courseTabId, payload);
    }

    if (!result) return { ok: false, error: '扫描无响应，请刷新课程页后重试' };
    return { ...result, tabId: courseTabId };
  } catch (error) {
    return { ok: false, error: error?.message || '扫描失败' };
  }
}

// ---------- 下载队列 ----------

function listJobs() {
  return [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function sanitizeSegment(seg) {
  let s = String(seg || '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // strip trailing dots/spaces and reserved device names
  s = s.replace(/[. ]+$/g, '');
  if (!s) return '';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  return s.slice(0, 80);
}

function sanitizeDownloadPath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(sanitizeSegment)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function handleEnqueue(message, sendResponse) {
  const items = Array.isArray(message.items) ? message.items : [];
  const created = [];
  let offset = 0;
  for (const item of items) {
    if (!item?.url || !item?.filename) continue;
    const filename = sanitizeDownloadPath(item.filename);
    const already = [...jobs.values()].find(
      (j) =>
        j.url === item.url &&
        j.filename === filename &&
        j.status !== 'failed' &&
        j.status !== 'done' &&
        j.status !== 'cancelled'
    );
    if (already) continue;
    const id = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    /** @type {Job} */
    const job = {
      id,
      url: String(item.url),
      filename,
      name: String(item.name || filename.split('/').pop() || '课件'),
      status: 'queued',
      createdAt: Date.now() + offset,
    };
    offset += 1;
    jobs.set(id, job);
    created.push(job.id);
  }
  void pump();
  sendResponse({ ok: true, jobs: listJobs(), created });
}

function handleRetry(message, sendResponse) {
  const job = jobs.get(message.id);
  if (!job) return sendResponse({ ok: false, error: '任务不存在' });
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    return sendResponse({ ok: false, error: '仅失败或已取消的任务可重试' });
  }
  job.status = 'queued';
  job.error = undefined;
  job.downloadId = undefined;
  void pump();
  sendResponse({ ok: true, jobs: listJobs() });
}

async function pump() {
  while (activeCount < MAX_PARALLEL) {
    const next = [...jobs.values()].find((j) => j.status === 'queued');
    if (!next) break;
    activeCount += 1;
    next.status = 'preparing';
    try {
      await startDownload(next);
    } catch (error) {
      next.status = 'failed';
      next.error = error?.message || '下载失败';
    } finally {
      activeCount -= 1;
    }
  }
}

function startDownload(job) {
  return new Promise((resolve, reject) => {
    job.status = 'downloading';
    chrome.downloads.download(
      {
        url: job.url,
        filename: job.filename,
        saveAs: false,
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          reject(new Error(chrome.runtime.lastError?.message || '无法创建下载任务'));
          return;
        }
        job.downloadId = downloadId;
        resolve();
      }
    );
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  for (const job of jobs.values()) {
    if (job.downloadId !== delta.id) continue;
    if (delta.state?.current === 'complete') {
      job.status = 'done';
    } else if (delta.state?.current === 'interrupted') {
      job.status = 'failed';
      job.error = delta.error?.current || '下载被中断';
    } else if (delta.state?.current === 'cancelled') {
      job.status = 'cancelled';
      job.error = '已取消';
    }
  }
});

void pump();
