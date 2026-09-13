import { scanResources } from './platform/scan.js';
import { collectUnitResources } from './platform/unit-scan.js';
import { parseUnitPageFrames } from './platform/unit.js';
import { describeSurface } from './platform/surface.js';
import { AppError, errorResult } from './platform/policy.js';

// This API lives in Chrome's isolated world, not in the website's JavaScript world.
if (!globalThis.__BUCT_COURSE_V1__) {
  let activeController;
  // A unit page may render its courseware inside a nested same-origin frame, so
  // the unit surface is resolved from this frame and every readable frame below.
  const describePage = () => describeSurface(document, location.href, {
    parseUnitPage: (_document, pageUrl) => parseUnitPageFrames(globalThis, pageUrl),
  });
  globalThis.__BUCT_COURSE_V1__ = {
    describe() {
      return { url: location.href, title: document.title, surface: describePage() };
    },
    cancel() {
      activeController?.abort();
    },
    async scan(scanId, { mode = 'current' } = {}) {
      if (mode !== 'current' && mode !== 'all') {
        // Validate before touching the active scan: a malformed message must
        // neither kill a running scan nor issue any request.
        throw new AppError('INVALID_MESSAGE', '扫描消息格式无效');
      }
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const send = event => chrome.runtime.sendMessage({ type: 'SCAN_EVENT', scanId, event });
      const parseDocument = html => new DOMParser().parseFromString(html, 'text/html');
      try {
        const surface = describePage();
        if (!surface) throw new AppError('STALE_SCAN', '页面已切换，请重新扫描当前目录');
        if (!surface.modeOptions.includes(mode)) {
          throw new AppError('INVALID_MESSAGE', '当前页面不支持该扫描范围');
        }
        let resources;
        let unitFailures = [];
        if (mode === 'all') {
          const collection = await collectUnitResources(surface.unitIndex, {
            parseDocument, signal: controller.signal,
            onProgress: event => send({ ...event, stage: 'units' }),
          });
          if (controller.signal.aborted) throw new AppError('CANCELLED', '扫描已取消，请重新扫描当前目录');
          unitFailures = collection.failures;
          // One discovered batch per settled unit, in unit order, carrying that
          // unit's canonical preview descriptors. The bridge validates these
          // descriptors before accepting metadata progress for their IDs;
          // unit-progress counters stay display-only.
          const batches = new Map();
          for (const resource of collection.resources) {
            const batch = batches.get(resource.unit.order) ?? { order: resource.unit.order, resources: [] };
            batch.resources.push(resource);
            batches.set(resource.unit.order, batch);
          }
          for (const batch of [...batches.values()].sort((left, right) => left.order - right.order)) {
            await send({ kind: 'discovered', stage: 'units', resources: batch.resources });
          }
          if (controller.signal.aborted) throw new AppError('CANCELLED', '扫描已取消，请重新扫描当前目录');
          resources = collection.resources;
        } else {
          resources = surface.surface === 'resource-directory' ? surface.directory.resources : surface.unitPage.resources;
        }
        const metadata = await scanResources(resources, {
          parseDocument, signal: controller.signal,
          onProgress: event => send({ ...event, stage: 'metadata' }),
        });
        if (controller.signal.aborted) throw new AppError('CANCELLED', '扫描已取消，请重新扫描当前目录');
        await send({ kind: 'complete', unitFailures, failures: metadata.failures });
      } catch (error) {
        await send({ kind: 'fatal', error: errorResult(error) }).catch(() => {});
      }
    },
  };
}
