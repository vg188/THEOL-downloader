// Runtime entry of the self-contained bookmarklet. Evaluating this bundle mounts
// the panel once and stops there: nothing is scanned and nothing is downloaded
// until the user asks for it. A second invocation re-displays the running panel
// instead of mounting another one.
import { AppError } from '../platform/policy.js';
import { archiveFiles } from './archive.js';
import { createBookmarkletController } from './controller.js';
import { downloadDirect } from './direct-download.js';
import { discoverSurface, describePage } from './discovery.js';
import { createBookmarkletScanner } from './scanner.js';
import { mountBookmarklet } from './view.js';

export const RUNTIME_GLOBAL = '__THEOL_DOWNLOADER_BOOKMARKLET_V1__';
export const DEFAULT_ARCHIVE_NAME = '课件.zip';

function parseHtml(pageWindow, html) {
  return new pageWindow.DOMParser().parseFromString(html, 'text/html');
}

/**
 * Hands a finished archive to the user: one blob URL, one clicked anchor, and the
 * URL revoked immediately — the page never keeps a second copy of the archive
 * reachable.
 */
export function deliverArchive(pageWindow, result) {
  if (!result?.blob) throw new AppError('NO_DOWNLOAD', '打包结果为空，请重新扫描后再试');
  const pageDocument = pageWindow.document;
  const url = pageWindow.URL.createObjectURL(result.blob);
  try {
    const anchor = pageDocument.createElement('a');
    anchor.href = url;
    anchor.download = typeof result.name === 'string' && result.name ? result.name : DEFAULT_ARCHIVE_NAME;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    (pageDocument.body ?? pageDocument.documentElement).append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    pageWindow.URL.revokeObjectURL(url);
  }
}

/** Wires the real scanner, archive and download implementations into a controller. */
export function createRuntimeController({
  window: pageWindow = globalThis,
  fetcher,
  parseDocument,
  timeoutMs = 15000,
  archive = archiveFiles,
  direct = downloadDirect,
  deliver = deliverArchive,
  createWorker,
} = {}) {
  const request = fetcher ?? (typeof pageWindow.fetch === 'function' ? pageWindow.fetch.bind(pageWindow) : globalThis.fetch);
  const parse = parseDocument ?? (html => parseHtml(pageWindow, html));
  const scanner = createBookmarkletScanner({ fetcher: request, parseDocument: parse, timeoutMs });
  return createBookmarkletController({
    document: pageWindow.document,
    // Surface recognition reads the page's own DOM: a bookmarklet cannot
    // inspect a tab, so the shared parsers run in the page's world.
    inspect: () => discoverSurface(pageWindow),
    // Diagnostics read the same page walk as the inspector, so a report can
    // never describe a different page than the one the panel rejected.
    describe: () => describePage(pageWindow),
    scan: ({ mode, onProgress }) => scanner.scan(pageWindow, { mode }, onProgress),
    cancelScan: () => scanner.cancel(),
    archiveFiles: (files, { signal, onProgress }) => archive(files, {
      fetcher: request, signal, onProgress, ...(createWorker ? { createWorker } : {}),
    }),
    downloadDirect: (files, { document: pageDocument, signal, onProgress }) => direct(files, {
      document: pageDocument ?? pageWindow.document, signal, onProgress,
    }),
    deliverArchive: result => deliver(pageWindow, result),
  });
}

/**
 * One panel per page. The instance lives on the page's own global, so a repeated
 * bookmarklet click shows the existing panel; destroying it clears the global and
 * lets a later click mount a fresh one.
 */
export function installBookmarklet(pageWindow = globalThis, options = {}) {
  const existing = pageWindow?.[RUNTIME_GLOBAL];
  if (existing) {
    existing.show();
    return existing;
  }
  const panel = mountBookmarklet({
    window: pageWindow,
    controller: createRuntimeController({ window: pageWindow, ...options }),
    onDestroy: () => { if (pageWindow[RUNTIME_GLOBAL] === panel) delete pageWindow[RUNTIME_GLOBAL]; },
  });
  pageWindow[RUNTIME_GLOBAL] = panel;
  return panel;
}

const runtimeWindow = globalThis.window;
if (runtimeWindow?.document?.documentElement) installBookmarklet(runtimeWindow);
