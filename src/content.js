import { parseDirectory } from './platform/parse.js';
import { scanResources } from './platform/scan.js';
import { AppError, errorResult } from './platform/policy.js';

// This API lives in Chrome's isolated world, not in the website's JavaScript world.
if (!globalThis.__BUCT_COURSE_V1__) {
  let activeController;
  globalThis.__BUCT_COURSE_V1__ = {
    describe() {
      return { url: location.href, title: document.title, directory: parseDirectory(document, location.href) };
    },
    async scan(scanId) {
      activeController?.abort();
      const controller = new AbortController(); activeController = controller;
      const send = event => chrome.runtime.sendMessage({ type: 'SCAN_EVENT', scanId, event });
      try {
        const directory = parseDirectory(document, location.href);
        if (!directory) throw new AppError('STALE_SCAN', '页面已切换，请重新扫描当前目录');
        await scanResources(directory.resources, {
          parseDocument: html => new DOMParser().parseFromString(html, 'text/html'),
          signal: controller.signal, onProgress: send,
        });
        await send({ kind: 'complete' });
      } catch (error) {
        await send({ kind: 'fatal', error: errorResult(error) }).catch(() => {});
      }
    },
  };
}
