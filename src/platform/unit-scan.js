import { AppError, errorResult } from './policy.js';
import { withDeadline, readHtmlResponse } from './network.js';
import { normalizeUnitPageUrl, parseUnitPage } from './unit.js';

const LOGIN_TITLE = /登录|登陆|统一身份认证|sign\s*in|log\s*in/i;

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
            credentials: 'include', redirect: 'manual', signal: requestSignal,
          });
          if (response.type === 'opaqueredirect' || response.status === 0 || response.redirected || response.status === 401) {
            throw new AppError('LOGIN_REQUIRED', '登录已失效或页面发生跳转，请重新登录后扫描');
          }
          if (!response.ok) throw new AppError('NO_DOWNLOAD', '单元页面无法访问，请确认登录状态和课程权限');
          // The observed entry route renders content directly, so any final-URL
          // change is anomalous and fails as a redirect-equivalent. The body is
          // never read before the final URL is an allowlisted unit page of the
          // current course; the canonical entry URL itself is not a redirect,
          // but it still fails the unit-page allowlist.
          let page;
          try { page = normalizeUnitPageUrl(response.url, index.courseId); }
          catch (error) {
            if (response.url === entry.entryUrl) throw error;
            throw new AppError('LOGIN_REQUIRED', '登录已失效或页面发生跳转，请重新登录后扫描');
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
          return { entry, unit: parseUnitPage(document, page.url) };
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
