import { AppError, ORIGIN, schoolUrl } from '../platform/policy.js';
import { courseTitle } from '../platform/parse.js';
import { describeSurface } from '../platform/surface.js';
import { parseUnitPageFrames } from '../platform/unit.js';

// A bookmarklet runs in the page's own JavaScript world, so where the
// extension injects a content script into every frame this walk uses plain
// same-origin DOM access. Everything that decides what a page is — canonical
// page URL, parsers, the both-shapes guard and the ambiguity rule — stays in
// the shared platform modules, so a bookmarked page and the extension can never
// disagree about which surface is current.
const UNSUPPORTED_MESSAGE = '请先打开学校教学平台的课程资源页';
const NO_SURFACE_MESSAGE = '请先进入“课程资源”下的课件目录或单元页面，再扫描当前列表';
const AMBIGUOUS_MESSAGE = '页面有多个资源列表，请单独打开需要下载的目录';

// A frame's child windows. `window.frames` is indexed but not iterable (in
// Chrome and jsdom alike), so the readable children are collected into a list
// both this walk and the shared unit parser can consume.
function framesOf(win) {
  const frames = [];
  let children, length;
  try { children = win?.frames; length = Number(children?.length) || 0; } catch { return frames; }
  for (let index = 0; index < length; index++) {
    try { const child = children[index]; if (child) frames.push(child); } catch { /* an opaque child stays unreachable */ }
  }
  return frames;
}

// Unreachable (cross-origin or detached) frames are skipped: the page is still
// usable, and a frame we cannot read can never be a scan surface. The frame's
// window is kept because a unit page aggregates the courseware of the frames
// below it.
function sameOriginFrames(root) {
  const frames = [];
  const visit = win => {
    let document, url;
    try { document = win.document; url = new URL(win.location.href); } catch { return; }
    if (!document || url.origin !== ORIGIN || url.username || url.password) return;
    frames.push({ window: win, document, url: url.href });
    for (const child of framesOf(win)) visit(child);
  };
  visit(root);
  return frames;
}

function topWindow(rootWindow) {
  let top;
  try { top = rootWindow?.top; } catch { top = null; }
  return top && typeof top === 'object' ? top : rootWindow;
}

// A unit page owns the frames below it (its courseware list may be rendered by a
// child), so the unit surface outranks a plain directory frame. Within the
// winning kind nothing may be guessed: two candidates stay ambiguous.
function winningSurface(candidates) {
  const units = candidates.filter(candidate => candidate.surface.surface === 'unit-study');
  const winning = units.length ? units : candidates;
  if (!winning.length) throw new AppError('NO_DIRECTORY', NO_SURFACE_MESSAGE);
  if (winning.length > 1) throw new AppError('AMBIGUOUS_DIRECTORY', AMBIGUOUS_MESSAGE);
  return winning[0];
}

/**
 * The inspected page contract for one bookmarklet generation, using the same
 * fields the extension bridge keeps so both products share one shape. `mode` is
 * the safe default for a fresh inspection; the panel tracks the user's chosen
 * range separately, so the key stays the surface identity: surface, folder or
 * unit page, and the ordered unit index.
 */
export function surfaceContext(surface, { courseName = '', document = null, location = '', mode = 'current', resources } = {}) {
  const directory = surface.directory ?? null;
  const unitPage = surface.unitPage ?? null;
  const list = resources ?? (directory ? directory.resources : unitPage.resources);
  return {
    courseId: directory?.courseId || unitPage?.courseId || '',
    folderId: directory ? directory.folderId : null,
    courseName,
    url: directory ? directory.url : unitPage.url,
    surface: surface.surface,
    mode,
    unitKey: unitPage ? unitPage.url : '',
    modeOptions: [...surface.modeOptions],
    key: `${surface.surface}|${directory?.key || unitPage?.url || ''}|${surface.unitIndex?.key || ''}`,
    resourceIds: list.map(resource => resource.id),
    document,
    location,
  };
}

/**
 * Everything both the surface resolver and the diagnostics need, so the panel's
 * error text and the diagnostics can never disagree about one page.
 *
 * `rejected` counts the frames that were readable but unusable: a page with many
 * frames and zero candidates is a different repair from one with an ambiguous
 * second list, and only these counts can tell them apart without exposing the
 * page's own content.
 */
function collectPage(rootWindow) {
  const top = topWindow(rootWindow);
  let topUrl = null;
  try { topUrl = schoolUrl(top?.location?.href); } catch { topUrl = null; }
  if (!topUrl) return { top, topUrl, frames: [], expectedCourse: null, candidates: [], rejected: { unrecognised: 0, otherCourse: 0 } };
  const frames = sameOriginFrames(top);
  const expectedCourse = topUrl.searchParams.get('courseId');
  const candidates = [];
  const rejected = { unrecognised: 0, otherCourse: 0 };
  for (const frame of frames) {
    // The unit parser owns the frame-tree rule; it reads frames as a list, so it
    // receives this frame's readable children rather than the frame collection.
    const unitWindow = { document: frame.document, frames: framesOf(frame.window) };
    const surface = describeSurface(frame.document, frame.url, {
      parseUnitPage: (_document, pageUrl) => parseUnitPageFrames(unitWindow, pageUrl),
    });
    if (!surface) { rejected.unrecognised++; continue; }
    const courseId = surface.directory?.courseId || surface.unitPage?.courseId || '';
    if (expectedCourse && courseId !== expectedCourse) { rejected.otherCourse++; continue; }
    candidates.push({ surface, document: frame.document, location: frame.url });
  }
  return { top, topUrl, frames, expectedCourse, candidates, rejected };
}

/**
 * Resolves the one surface this bookmarklet may scan, as `{ context, surface }`
 * — the extension's `describe()` contract without `chrome.*`.
 *
 * The top-level document owns the course context, exactly like the tab URL the
 * extension inspects: a page we cannot reach, or one outside the platform, is
 * unsupported rather than guessed at.
 */
export function discoverSurface(rootWindow) {
  const { top, topUrl, expectedCourse, candidates } = collectPage(rootWindow);
  if (!topUrl) throw new AppError('UNSUPPORTED_PAGE', UNSUPPORTED_MESSAGE);
  const { surface, document, location } = winningSurface(candidates);
  const courseName = courseTitle(String(top.document?.title || ''));
  return { context: surfaceContext(surface, { courseName, document, location }), surface };
}

/**
 * A de-identified description of what this bookmarklet can see, for the panel's
 * diagnostics. Nothing here may carry a course id, resource id, file name, page
 * title or query string: only counts, frame paths and recognised surface kinds,
 * so the report is safe to paste into an issue.
 */
export function describePage(rootWindow) {
  // "Are we on the platform?" is answered before the page is walked, so a probe
  // that dies halfway still reports where the user is standing.
  let supported = false;
  try { supported = Boolean(schoolUrl(topWindow(rootWindow)?.location?.href)); } catch { supported = false; }
  const empty = { supported, frameCount: 0, framePaths: [], candidates: [], rejected: { unrecognised: 0, otherCourse: 0 }, topHasCourseId: false, error: null };
  let collected;
  try {
    collected = collectPage(rootWindow);
  } catch (error) {
    return { ...empty, error: { code: error?.code ?? 'ERROR', message: String(error?.message ?? error) } };
  }
  const pathOf = href => { try { return new URL(href).pathname; } catch { return ''; } };
  return {
    // Only a page whose top is the platform has anything to report.
    supported: Boolean(collected.topUrl),
    frameCount: collected.frames.length,
    framePaths: collected.frames.map(frame => pathOf(frame.url)).filter(Boolean),
    candidates: collected.candidates.map(candidate => candidate.surface.surface),
    rejected: { ...collected.rejected },
    // Never the value: only whether the top-level URL pinned a course.
    topHasCourseId: Boolean(collected.expectedCourse),
    error: null,
  };
}
