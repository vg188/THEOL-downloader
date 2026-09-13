import { AppError, ORIGIN, schoolUrl } from '../platform/policy.js';
import { courseTitle } from '../platform/parse.js';
import { describeSurface } from '../platform/surface.js';

// A bookmarklet runs in the page's own JavaScript world, so where the
// extension injects a content script into every frame this walk uses plain
// same-origin DOM access. Everything that decides what a resource directory is
// — canonical page URL, parser, ambiguity rule — stays in the shared platform
// modules, so a bookmarked page and the extension can never disagree about
// which directory is current.
const UNSUPPORTED_MESSAGE = '请先打开学校教学平台的课程资源页';
const NO_DIRECTORY_MESSAGE = '请进入“课程资源”下的课件目录，再扫描当前列表';
const AMBIGUOUS_MESSAGE = '页面有多个资源列表，请单独打开需要下载的目录';

// Unreachable (cross-origin or detached) frames are skipped: the page is still
// usable, and a frame we cannot read can never be a resource directory.
function sameOriginFrames(root) {
  const frames = [];
  const visit = win => {
    let document, url;
    try { document = win.document; url = new URL(win.location.href); } catch { return; }
    if (!document || url.origin !== ORIGIN || url.username || url.password) return;
    frames.push({ document, url: url.href });
    let children, length;
    try { children = win.frames; length = Number(children?.length) || 0; } catch { return; }
    for (let index = 0; index < length; index++) visit(children[index]);
  };
  visit(root);
  return frames;
}

function topWindow(rootWindow) {
  let top;
  try { top = rootWindow?.top; } catch { top = null; }
  return top && typeof top === 'object' ? top : rootWindow;
}

export function discoverDirectory(rootWindow) {
  // The top-level document owns the course context, exactly like the tab URL
  // the extension inspects: a page we cannot reach, or one outside the
  // platform, is unsupported rather than guessed at.
  const top = topWindow(rootWindow);
  let topUrl;
  try { topUrl = schoolUrl(top?.location?.href); } catch { throw new AppError('UNSUPPORTED_PAGE', UNSUPPORTED_MESSAGE); }
  const expectedCourse = topUrl.searchParams.get('courseId');
  const candidates = [];
  for (const frame of sameOriginFrames(top)) {
    const surface = describeSurface(frame.document, frame.url);
    if (surface?.surface !== 'resource-directory') continue;
    if (expectedCourse && surface.directory.courseId !== expectedCourse) continue;
    candidates.push({ document: frame.document, location: frame.url, directory: surface.directory });
  }
  if (!candidates.length) throw new AppError('NO_DIRECTORY', NO_DIRECTORY_MESSAGE);
  if (candidates.length > 1) throw new AppError('AMBIGUOUS_DIRECTORY', AMBIGUOUS_MESSAGE);
  const { document, location, directory } = candidates[0];
  const context = {
    courseId: directory.courseId,
    folderId: directory.folderId,
    courseName: courseTitle(String(top.document?.title || '')),
    url: directory.url,
    surface: 'resource-directory',
    mode: 'current',
    modeOptions: ['current'],
    key: directory.key,
    resourceIds: directory.resources.map(resource => resource.id),
    // The live frame identity pins this generation: a reloaded or navigated
    // document must invalidate the selection like a changed directory does.
    document,
    location,
  };
  return { context, directory };
}
