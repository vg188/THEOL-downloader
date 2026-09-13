import { AppError } from './policy.js';
import { parseDirectory } from './parse.js';
import { parseUnitPage, parseUnitIndex } from './unit.js';

// Pure surface recognition: the exact page URL policy plus parser success
// decides what the document is — never page-text guessing. A course-resource
// nested frame and a unit page in separate frames are separate candidates;
// the background bridge disambiguates across frames using the active
// document/course context.
//
// The parsers are injectable only so the both-shapes guard stays verifiable:
// the committed URL allowlists (listview vs lesson/newpage) are disjoint, so
// production inputs can match at most one shape, and the guard is a defense
// against future policy drift — not a reachable priority rule.
export function describeSurface(document, pageUrl, {
  parseDirectory: parseDirectoryImpl = parseDirectory,
  parseUnitPage: parseUnitPageImpl = parseUnitPage,
  parseUnitIndex: parseUnitIndexImpl = parseUnitIndex,
} = {}) {
  const directory = parseDirectoryImpl(document, pageUrl);
  const unitPage = parseUnitPageImpl(document, pageUrl);
  if (directory && unitPage) {
    throw new AppError('AMBIGUOUS_DIRECTORY', '页面有多个资源列表，请单独打开需要下载的目录');
  }
  if (directory) {
    return { surface: 'resource-directory', modeOptions: ['current'], directory };
  }
  if (unitPage) {
    let unitIndex = null;
    try { unitIndex = parseUnitIndexImpl(document, pageUrl); }
    catch (error) {
      // An ambiguous unit list only removes the unsafe all-unit option; the
      // page itself remains a valid current-unit surface.
      if (!(error instanceof AppError)) throw error;
    }
    // A lesson/newpage document with neither courseware nor a bounded unit list
    // is a layout shell: its content lives in a nested frame, and that frame
    // stays the scanned surface.
    if (!unitIndex && !unitPage.resources.length) return null;
    return { surface: 'unit-study', modeOptions: unitIndex ? ['current', 'all'] : ['current'], unitPage, unitIndex };
  }
  return null;
}
