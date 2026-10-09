import { AppError, ORIGIN, errorResult } from './policy.js';
import { withDeadline, readHtmlResponse } from './network.js';
import { normalizeUnitPageUrl, previewResources } from './unit.js';

const LOGIN_TITLE = /登录|登陆|统一身份认证|sign\s*in|log\s*in/i;
// The identity system lives on its own host, so a transfer that leaves the
// platform or lands on an auth-looking label is the honest "your session ended"
// signal. Any other same-origin target is a page this build does not read, and
// telling the student to log in again for that sends them chasing the wrong
// repair. Labels and path segments are matched whole on purpose: a substring
// test would read the word "lesson" as an SSO endpoint.
const AUTH_HOST_LABEL = /^(portal|passport|sso|cas|auth|oauth|login|signin|account|identity)$/i;
const AUTH_PATH_SEGMENT = /^(login|logon|signin|sign-in|sign_in|logout|sso|cas|auth|oauth|oauth2|authorization|identity)$/i;

function isIdentityRedirect(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN) return true;
    return url.hostname.split('.').some(label => AUTH_HOST_LABEL.test(label))
      || url.pathname.split('/').some(segment => AUTH_PATH_SEGMENT.test(segment));
  } catch {
    return true;
  }
}

export async function collectUnitResources(index, {
  fetcher = globalThis.fetch, parseDocument, signal, timeoutMs = 15000, onProgress = async () => {},
} = {}) {
  const entries = index?.entries ?? [];
  const total = entries.length;
  const results = new Array(total).fill(null);
  const failures = [];
  let processed = 0;
  let discovered = 0;
  let next = 0;
  async function worker() {
    while (next < total) {
      if (signal?.aborted) throw new AppError('CANCELLED', '单元扫描已取消');
      const position = next++;
      const entry = entries[position];
      let unitResult = null;
      let failure = null;
      try {
        unitResult = await withDeadline(async requestSignal => {
          const response = await fetcher(entry.entryUrl, {
            credentials: 'include', redirect: 'follow', signal: requestSignal,
          });
          if (response.type === 'opaqueredirect' || response.status === 0 || response.status === 401) {
            throw new AppError('LOGIN_REQUIRED', '登录已失效或页面发生跳转，请重新登录后扫描');
          }
          if (!response.ok) throw new AppError('NO_DOWNLOAD', '单元页面无法访问，请确认登录状态和课程权限');
          // The entry route has two legitimate shapes: it renders the unit at its
          // own URL, or the platform transfers to a lesson/newpage layout. Any
          // other final URL — login, error, another JSP, another host — is refused
          // here, before the body is read.
          let pageUrl = entry.entryUrl;
          if (response.url !== entry.entryUrl) {
            try { pageUrl = normalizeUnitPageUrl(response.url, index.courseId).url; }
            catch {
              if (isIdentityRedirect(response.url)) throw new AppError('LOGIN_REQUIRED', '登录已失效或页面发生跳转，请重新登录后扫描');
              throw new AppError('UNSUPPORTED_UNIT_PAGE', '该栏目打开的页面不是本课程的单元页面，请改用“扫描当前单元”');
            }
          }
          const html = await readHtmlResponse(response, {
            signal: requestSignal,
            badEncodingMessage: '单元页面的字符编码不受支持，请在平台确认该单元',
            tooLargeMessage: '单元页面内容异常，请在平台确认该单元',
          });
          const document = parseDocument(html);
          if (LOGIN_TITLE.test(document.title || '')) {
            throw new AppError('LOGIN_REQUIRED', '登录已失效，请在教学平台重新登录后扫描');
          }
          // Courseware is read from the transferred document itself: a fetched
          // response has no frame tree, so a unit that renders its list in a
          // nested frame is covered by the current-unit scan instead.
          return { entry, unit: { resources: previewResources(document, index.courseId, pageUrl) } };
        }, { timeoutMs, signal });
      } catch (error) {
        failure = { kind: 'unit', columnId: entry.columnId, title: entry.title, ...errorResult(error) };
      }
      results[position] = unitResult;
      if (failure) failures.push(failure);
      processed++;
      discovered += unitResult ? unitResult.unit.resources.length : 0;
      const event = { kind: 'unit-progress', processed, total, discovered };
      if (failure) event.failure = failure;
      await onProgress(event);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, total) }, worker));
  if (signal?.aborted) throw new AppError('CANCELLED', '单元扫描已取消');
  // Login failure is fatal only when every entry failed as LOGIN_REQUIRED;
  // otherwise it stays a local unit failure and successful units remain.
  if (total > 0 && failures.length === total && failures.every(failure => failure.code === 'LOGIN_REQUIRED')) {
    throw new AppError('LOGIN_REQUIRED', '登录已失效，请重新登录后再扫描全部单元');
  }
  // Deduplicate by canonical resource ID in entry order: a repeated courseware
  // keeps its first unit and only raises the occurrence count, so the metadata
  // stage never requests the same preview twice.
  const unique = new Map();
  for (const result of results) {
    if (!result) continue;
    const { entry, unit } = result;
    for (const resource of unit.resources) {
      const existing = unique.get(resource.id);
      if (existing) existing.unit.occurrenceCount++;
      else {
        resource.unit = { entryUrl: entry.entryUrl, title: entry.title, order: entry.order, occurrenceCount: 1 };
        unique.set(resource.id, resource);
      }
    }
  }
  return {
    entriesProcessed: processed,
    entriesTotal: total,
    resources: [...unique.values()],
    failures,
  };
}
