import { AppError, normalizeResourceUrl, validateFile } from '../platform/policy.js';
import { scanResources } from '../platform/scan.js';
import { collectUnitResources } from '../platform/unit-scan.js';
import { discoverSurface, surfaceContext } from './discovery.js';

// One immutable snapshot per settled resource, in the same shape the extension
// keeps for its popup. A scan is a generation: replacing or cancelling it makes
// the previous generation unaddressable, so progress that arrives late can
// never mutate a newer scan.
const CANCELLED_MESSAGE = '扫描已取消，请重新扫描当前目录';
const NO_UNIT_INDEX_MESSAGE = '当前页面不支持扫描全部单元';

function sourceOrder(resourceIds) {
  return new Map(resourceIds.map((id, index) => [id, index]));
}
// scanResources settles resources in completion order; the source's own order is
// what the user selected, so files are reported in it.
function bySourceOrder(files, order) {
  return files.slice().sort((left, right) => order.get(left.id) - order.get(right.id));
}
function settledId(event) {
  return event.file?.id ?? event.failure?.id ?? event.skipped?.id;
}
// validateFile is the extension's download contract and drops the size the
// platform reported; the 500 MiB gate needs it back, typed.
function reportedSize(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
// Unit failures reach the panel as text, so they are bounded here like the
// bridge bounds them for the popup.
function unitFailure(value) {
  return { kind: 'unit', columnId: String(value?.columnId ?? '').slice(0, 20),
    title: String(value?.title || '单元').slice(0, 200),
    code: String(value?.code || 'NETWORK').slice(0, 40),
    message: String(value?.message || '无法读取该单元').slice(0, 240) };
}
// One discovered batch per settled unit, in unit order: the panel already holds
// the resources, but the batch keeps the same stream the extension emits.
function discoveredBatches(resources) {
  const batches = new Map();
  for (const resource of resources) {
    const order = resource.unit?.order ?? 0;
    const batch = batches.get(order) ?? { order, resources: [] };
    batch.resources.push(resource);
    batches.set(order, batch);
  }
  return [...batches.values()].sort((left, right) => left.order - right.order);
}
function counters(value) {
  const source = value && typeof value === 'object' ? value : {};
  const count = key => Number.isFinite(source[key]) && source[key] >= 0 ? source[key] : 0;
  return { processed: count('processed'), total: count('total'), discovered: count('discovered') };
}

export function createBookmarkletScanner({
  fetcher = globalThis.fetch,
  parseDocument,
  timeoutMs = 15000,
  // Injectable like the platform parsers, so the "only canonical preview URLs
  // are fetched" rule stays verifiable from a hostile surface descriptor.
  discover = discoverSurface,
} = {}) {
  let active = null;

  // Every metadata request must be the canonical same-origin preview endpoint:
  // a page may not route its own credentials to another host, script or
  // session. A rejection here becomes that resource's failure, so one bad link
  // never aborts the scan.
  const guardedFetcher = (value, options) => {
    const identity = normalizeResourceUrl(value, 'preview');
    if (identity.url !== String(value)) throw new AppError('INVALID_RESOURCE', '课件预览地址不是规范的平台链接');
    return fetcher(identity.url, options);
  };

  function apply(generation, state, event) {
    const id = settledId(event);
    // Unknown or already settled IDs are dropped; processed then stays below
    // total and the scan reports itself as incomplete instead of inventing a
    // result.
    if (!generation.order.has(id) || generation.settled.has(id)) return state;
    generation.settled.add(id);
    let files = state.files, failures = state.failures, skipped = state.skipped;
    if (event.file) {
      const file = validateFile({ ...event.file, courseName: generation.context.courseName });
      if (file.courseId !== generation.context.courseId) throw new AppError('INVALID_MESSAGE', '课件不属于当前课程');
      files = bySourceOrder([...files, { ...file, sizeBytes: reportedSize(event.file.sizeBytes) }], generation.order);
    } else if (event.failure) {
      failures = [...failures, { id, title: String(event.failure.title || '课件').slice(0, 300),
        code: String(event.failure.code || 'NETWORK').slice(0, 40),
        message: String(event.failure.message || '无法读取该课件').slice(0, 240) }];
    } else skipped += 1;
    const processed = generation.settled.size;
    return { ...state, files, failures, skipped, processed, message: `正在识别 ${processed} / ${state.total}` };
  }

  /**
   * `scan(rootWindow, { mode }, onProgress)`; a bare callback second argument
   * still means "current range", so an older caller keeps working.
   *
   * `current` never reads a unit entry page: it scans the resources of the
   * surface the page already rendered (a course-resource directory, or the
   * current unit page including its nested frames). `all` requires a bounded
   * unit index, collects those unit pages two at a time, and only then reads the
   * metadata of the unique courseware they contain.
   */
  async function scan(rootWindow, options = {}, onProgress) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    const mode = options?.mode === 'all' ? 'all' : 'current';
    // Discovery runs before the generation exists: an unsupported page must not
    // cancel the scan still running behind the panel.
    const { context, surface } = discover(rootWindow);
    if (mode === 'all' && (!surface.unitIndex || !surface.modeOptions.includes('all'))) {
      throw new AppError('INVALID_MESSAGE', NO_UNIT_INDEX_MESSAGE);
    }
    const entries = surface.unitIndex?.entries ?? [];
    const resources = mode === 'all' ? [] : surface.surface === 'resource-directory' ? surface.directory.resources : surface.unitPage.resources;
    const generation = {
      id: crypto.randomUUID(), controller: new AbortController(), context,
      order: sourceOrder(resources.map(resource => resource.id)), settled: new Set(),
    };
    active?.controller.abort();
    active = generation;
    let state = { id: generation.id, phase: 'scanning', context, files: [], failures: [], unitFailures: [],
      units: mode === 'all' ? { processed: 0, total: entries.length, discovered: 0 } : counters(null),
      total: resources.length, processed: 0, skipped: 0,
      message: mode === 'all' ? '正在读取单元页面…' : resources.length ? '正在读取原文件信息…' : '正在检查当前列表…' };
    report({ ...state });
    let interruption = null;
    try {
      if (mode === 'all') {
        const collection = await collectUnitResources(surface.unitIndex, {
          fetcher, parseDocument, signal: generation.controller.signal, timeoutMs,
          // Display-only counters: the batches below are what carry resources.
          onProgress: event => {
            if (active !== generation) return;
            state = { ...state, units: counters(event) };
            report({ ...event });
          },
        });
        if (active !== generation) return { ...state, phase: 'cancelled', message: CANCELLED_MESSAGE };
        for (const batch of discoveredBatches(collection.resources)) {
          if (active !== generation) return { ...state, phase: 'cancelled', message: CANCELLED_MESSAGE };
          report({ kind: 'discovered', order: batch.order, resources: batch.resources });
        }
        resources.push(...collection.resources);
        generation.order = sourceOrder(resources.map(resource => resource.id));
        state = { ...state, context: surfaceContext(surface, { ...generation.context, mode, resources }),
          unitFailures: collection.failures.map(unitFailure),
          total: resources.length, message: resources.length ? '正在读取原文件信息…' : '正在检查当前列表…' };
        report({ ...state });
      }
      await scanResources(resources, {
        fetcher: guardedFetcher, parseDocument, signal: generation.controller.signal, timeoutMs,
        onProgress: event => {
          if (active !== generation) return;
          const next = apply(generation, state, event);
          if (next === state) return;
          state = next;
          report({ ...state });
        },
      });
    } catch (error) {
      if (!generation.controller.signal.aborted || !(error instanceof AppError && error.code === 'CANCELLED')) interruption = error;
    } finally {
      if (active === generation) active = null;
    }
    // A cancellation only ever discards this generation's own work; the
    // snapshot resolves instead of rejecting so a stale scan cannot be mistaken
    // for the failure of the scan that replaced it.
    if (interruption) throw interruption;
    // An aborted read is not a file failure: the generation itself was
    // cancelled, and the snapshot says so instead of blaming the courseware.
    if (generation.controller.signal.aborted) return { ...state, phase: 'cancelled',
      failures: state.failures.filter(failure => failure.code !== 'CANCELLED'), message: CANCELLED_MESSAGE };
    const complete = state.processed === state.total;
    return { ...state, phase: complete ? 'ready' : 'error',
      message: complete ? `找到 ${state.files.length} 份课件` : '部分扫描结果缺失，请重新扫描' };
  }

  function cancel() {
    active?.controller.abort();
  }

  return { scan, cancel };
}
