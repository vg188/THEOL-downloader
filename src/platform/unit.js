import { ORIGIN, AppError, isUnavailable, numericParam, normalizeResourceUrl, pathWithoutSession, schoolUrl } from './policy.js';

export const UNIT_PATHS = Object.freeze({
  entry: '/meol/jpk/course/course_column_preview_transfer.jsp',
  lesson: '/meol/jpk/course/layout/lesson/index.jsp',
  newpage: '/meol/jpk/course/layout/newpage/index.jsp',
});

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

export function parseUnitPage(document, pageUrl) {
  let page;
  try { page = normalizeUnitPageUrl(pageUrl); } catch { return null; }
  const unique = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isUnavailable(anchor)) continue;
    try {
      const parsed = normalizeResourceUrl(anchor.getAttribute('href'), 'preview', pageUrl);
      const url = new URL(parsed.url);
      if (numericParam(url, 'lid') !== page.courseId || unique.has(parsed.id)) continue;
      unique.set(parsed.id, {
        id: parsed.id, courseId: page.courseId, resId: parsed.resId, fileId: parsed.fileId,
        previewUrl: parsed.url, title: anchor.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) || '未命名资源',
        unit: { entryUrl: null, title: '当前单元', order: 0, occurrenceCount: 1 },
      });
    } catch { /* Unit navigation, controls and other-course links are not resources. */ }
  }
  return { surface: 'unit-study', courseId: page.courseId, layout: page.layout, url: page.url, resources: [...unique.values()] };
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
    if (!container) continue;
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
