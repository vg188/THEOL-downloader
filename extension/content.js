import { createCourseScanner } from '../src/runtime/scanner.js';

// One top-frame coordinator inspects the same-origin frame tree. All-frame
// messaging would race responses from the layout shell and the actual list.
if (!window.__buctTheolScanBooted) {
  window.__buctTheolScanBooted = true;
  let controller;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !['BUCT_SCAN', 'BUCT_CONTEXT'].includes(message?.type)) return false;
    const errorResponse = error => sendResponse({ ok: false, code: error.code, error: error.message || '扫描失败' });
    try {
      if (message.type === 'BUCT_CONTEXT') {
        const scanner = createCourseScanner({ window });
        sendResponse({ ok: true, contextKey: scanner.contextKey() });
        return false;
      }
      controller?.abort();
      controller = new AbortController();
      const scanner = createCourseScanner({ window, signal: controller.signal });
      const key = scanner.contextKey();
      scanner.scan({ mode: message.mode || 'course' }).then(result => {
        if (scanner.contextKey() !== key) sendResponse({ ok: false, code: 'STALE_PAGE', error: '已切换课程，请刷新课程列表' });
        else sendResponse({ ...result, contextKey: key });
      }).catch(errorResponse);
    } catch (error) { errorResponse(error); }
    return true;
  });
}
