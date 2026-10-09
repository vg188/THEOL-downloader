import { createId } from '../src/runtime/policy.js';
import { createCourseScanner } from '../src/runtime/scanner.js';

// One top-frame coordinator inspects the same-origin frame tree. All-frame
// messaging would race responses from the layout shell and the actual list.
if (!window.__buctTheolScanBooted) {
  window.__buctTheolScanBooted = true;
  const documentKey = createId();
  let controller;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !['BUCT_SCAN', 'BUCT_CONTEXT'].includes(message?.type)) return false;
    const errorResponse = error => sendResponse({ ok: false, code: error.code, error: error.message || '扫描失败' });
    try {
      if (message.type === 'BUCT_CONTEXT') {
        const scanner = createCourseScanner({ window });
        sendResponse({ ok: true, contextKey: documentKey + scanner.contextKey() });
        return false;
      }
      controller?.abort();
      controller = new AbortController();
      const scanner = createCourseScanner({ window, signal: controller.signal });
      const key = documentKey + scanner.contextKey();
      scanner.scan({ mode: message.mode || 'auto' }).then(result => {
        if (documentKey + scanner.contextKey() !== key) sendResponse({ ok: false, code: 'STALE_PAGE', error: '课程页面已改变，请重新扫描' });
        else sendResponse({ ...result, contextKey: key });
      }).catch(errorResponse);
    } catch (error) { errorResponse(error); }
    return true;
  });
}
