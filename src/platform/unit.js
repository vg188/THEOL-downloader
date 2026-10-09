import { ORIGIN, AppError, isUnavailable, numericParam, normalizeResourceUrl, pathWithoutSession, schoolUrl } from './policy.js';
import { parseDirectory } from './parse.js';

export const UNIT_PATHS = Object.freeze({
  entry: '/meol/jpk/course/course_column_preview_transfer.jsp',
  lesson: '/meol/jpk/course/layout/lesson/index.jsp',
  newpage: '/meol/jpk/course/layout/newpage/index.jsp',
});

// A course page carries several column lists at once: the tab bar in the header,
// collapsed side menus, and the unit list the student actually reads. Only the
// last one may define the scan range, so a list that sits inside page navigation
// is treated as navigation. `.nav` matches the whole class token, so a themed
// `lesson-nav` is not caught here.
const NAVIGATION = 'nav, [role=navigation], [role=menubar], [role=tablist], .nav, .navbar';

function exactKeys(url, expected) {
  const actual = [...new Set(url.searchParams.keys())].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AppError('INVALID_RESOURCE', '单元链接参数无效');
  }
}

function noFragment(url) {
  if (url.hash) throw new AppError('INVALID_RESOURCE', '单元链接参数无效');
}

export function normalizeUnitEntryUrl(input, base = ORIGIN) {
  const url = schoolUrl(input, base);
  if (pathWithoutSession(url.pathname) !== UNIT_PATHS.entry) {
    throw new AppError('INVALID_URL', '不是支持的单元入口链接');
  }
  exactKeys(url, ['columnId', 'tagbug']);
  noFragment(url);
  const columnId = numericParam(url, 'columnId');
  if (url.searchParams.get('tagbug') !== 'client') {
    throw new AppError('INVALID_RESOURCE', '单元链接参数无效');
  }
  const canonical = new URL(UNIT_PATHS.entry, ORIGIN);
  canonical.search = new URLSearchParams({ columnId, tagbug: 'client' }).toString();
  return { columnId, url: canonical.href };
}

export function normalizeUnitPageUrl(input, expectedCourseId, base = ORIGIN) {
  const url = schoolUrl(input, base);
  const path = pathWithoutSession(url.pathname);
  const layout = path === UNIT_PATHS.lesson ? 'lesson' : path === UNIT_PATHS.newpage ? 'newpage' : null;
  if (!layout) throw new AppError('INVALID_URL', '不是支持的单元页面链接');
  exactKeys(url, ['courseId']);
  noFragment(url);
  const courseId = numericParam(url, 'courseId');
  if (expectedCourseId !== undefined && courseId !== String(expectedCourseId)) {
    throw new AppError('INVALID_RESOURCE', '单元页面课程不匹配');
  }
  const canonical = new URL(UNIT_PATHS[layout], ORIGIN);
  canonical.search = new URLSearchParams({ courseId }).toString();
  return { courseId, url: canonical.href, layout };
}

// A unit page's courseware may be rendered by the page itself or by a nested
// same-origin frame (the layout that hosts the resource list), so the unit
// surface aggregates every readable frame below it, parent first.
export function previewResources(document, courseId, pageUrl) {
  const unique = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isUnavailable(anchor)) continue;
    try {
      const parsed = normalizeResourceUrl(anchor.getAttribute('href'), 'preview', pageUrl);
      const url = new URL(parsed.url);
      if (numericParam(url, 'lid') !== courseId || unique.has(parsed.id)) continue;
      unique.set(parsed.id, {
        id: parsed.id, courseId, resId: parsed.resId, fileId: parsed.fileId,
        previewUrl: parsed.url, title: anchor.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) || '未命名资源',
        unit: { entryUrl: null, title: '当前单元', order: 0, occurrenceCount: 1 },
      });
    } catch { /* Unit navigation, controls and other-course links are not resources. */ }
  }
  return [...unique.values()];
}

export function parseUnitPage(document, pageUrl) {
  let page;
  try { page = normalizeUnitPageUrl(pageUrl); } catch { return null; }
  return { surface: 'unit-study', courseId: page.courseId, layout: page.layout, url: page.url, resources: previewResources(document, page.courseId, pageUrl) };
}

export function parseUnitPageFrames(rootWindow, pageUrl) {
  if (!rootWindow?.document) return null;
  const page = parseUnitPage(rootWindow.document, pageUrl);
  if (!page) return null;
  // Whether the page lists courseware in its own document decides if it is a
  // unit page or only the shell around the frame it hosts, so keep both counts.
  const ownResources = page.resources;
  const resources = [...ownResources];
  const seen = new Set(ownResources.map(resource => resource.id));
  let frames = 0;
  const visit = win => {
    // `window.frames` is the window proxy itself, not an array: it has a length and
    // numeric indices but no iterator, so it must be walked by index.
    const children = win.frames;
    for (let index = 0; index < (children?.length ?? 0); index++) {
      const child = children[index];
      if (!child) continue;
      try {
        const childDocument = child.document;
        const childUrl = child.location.href;
        if (!childDocument) continue;
        frames++;
        // Reading a frame's own anchors is independent of its page type: the
        // courseware list may be a listview page, and the platform nests the newer
        // courseware routes one frame deeper than the column page that hosts them.
        for (const resource of previewResources(childDocument, page.courseId, childUrl)) {
          if (seen.has(resource.id)) continue;
          seen.add(resource.id);
          resources.push(resource);
        }
        visit(child);
      } catch { /* Cross-origin or unloaded frames hold no readable courseware. */ }
    }
  };
  visit(rootWindow);
  return { ...page, resources, ownResources, frameCount: frames };
}

const canonicalEntryParams = (entryUrl) =>
  [...new URL(entryUrl).searchParams].sort().map(([name, value]) => `${name}=${value}`).join('&');

export function parseUnitIndex(document, pageUrl) {
  let page;
  try { page = normalizeUnitPageUrl(pageUrl); } catch { return null; }
  const groups = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isUnavailable(anchor)) continue;
    let parsed;
    try { parsed = normalizeUnitEntryUrl(anchor.getAttribute('href'), pageUrl); } catch { continue; }
    const container = anchor.closest('ul,ol,[role="list"]');
    if (!container || container.closest(NAVIGATION)) continue;
    const group = groups.get(container) ?? new Map();
    if (!group.has(parsed.columnId)) group.set(parsed.columnId, { parsed, anchor });
    groups.set(container, group);
  }
  const bounded = [...groups.values()].filter(group => group.size >= 2);
  if (bounded.length === 0) return null;
  if (bounded.length > 1) throw new AppError('AMBIGUOUS_UNIT_INDEX', '页面存在多个单元列表，无法确定扫描范围');
  const entries = [...bounded[0].values()].map(({ parsed, anchor }, order) => ({
    columnId: parsed.columnId,
    entryUrl: parsed.url,
    title: anchor.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) || `单元 ${order + 1}`,
    order,
  }));
  return {
    courseId: page.courseId,
    entries,
    key: `${page.courseId}|${entries.map(entry => `${entry.columnId}:${canonicalEntryParams(entry.entryUrl)}`).join(',')}`,
  };
}
