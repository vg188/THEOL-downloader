// Local ZIP assembly for the bookmarklet. Validated courseware is streamed straight
// into one Store-mode ZIP through the worker protocol, so the page never holds the
// archive content twice: only the signature sample and the ZIP's own output exist.
// Pass `createWorker: () => new Worker(url, {type: 'module'})` to run the writer off
// the page's thread; the default runs the same protocol in-process. Resolves with
// `{blob, name, bytes, entries, failures}`; the caller creates and revokes the URL.
import { AppError, buildFilename, errorResult } from '../platform/policy.js';
import { FAILURE_MANIFEST_NAME, createLoopbackWorker } from './archive-worker.js';
import { ZIP_LIMIT_BYTES } from './download-plan.js';
import { ActualSizeLimitError, fetchCourseFile } from './fetch-file.js';

export { ActualSizeLimitError };

// A file whose validation fails before any byte was forwarded is a per-file failure
// (it is listed in 下载失败清单.txt); anything else breaks the whole archive, because
// a half-read file must never be written into a ZIP that is then handed to the user.
const SKIPPABLE = new Set(['INVALID_URL', 'INVALID_RESOURCE', 'UNSUPPORTED_TYPE', 'LOGIN_REQUIRED', 'NO_DOWNLOAD', 'BAD_FILE']);

export async function archiveFiles(files, {
  fetcher,
  signal,
  onProgress = () => {},
  limitBytes = ZIP_LIMIT_BYTES,
  createWorker = createLoopbackWorker,
} = {}) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!list.length) throw new AppError('NO_FILES', '没有可打包的文件');
  const worker = createWorker();
  const used = new Set();
  const failures = [];
  const state = {
    processed: 0, total: list.length, name: null, fileSize: null,
    fileBytes: 0, bytes: 0, succeeded: 0, failed: 0, message: '',
  };
  const report = message => onProgress({ ...state, message });
  const channel = openChannel(worker, message => {
    // The worker's count is what has actually been appended to the archive; the
    // pre-send budget below stays on the page so a breach aborts the reader at once.
    state.fileBytes = message.entryBytes;
    state.bytes = message.totalBytes;
    report(`正在打包 ${state.processed}/${state.total}：${state.name}`);
  });
  let contentBytes = 0;

  try {
    channel.send({ type: 'start' });
    for (const [index, file] of list.entries()) {
      state.processed = index;
      state.name = null;
      state.fileSize = Number.isSafeInteger(file?.sizeBytes) && file.sizeBytes >= 0 ? file.sizeBytes : null;
      state.fileBytes = 0;
      let name;
      try {
        name = uniqueName(used, buildFilename(file.courseName, file.name));
      } catch (error) {
        state.processed = index + 1;
        state.failed += 1;
        failures.push({ name: String(file?.name ?? '未知文件'), reason: errorResult(error).message });
        continue;
      }
      state.name = name;
      report(`正在读取 ${index + 1}/${state.total}：${name}`);
      let sent = 0;
      try {
        await fetchCourseFile(file, {
          fetcher,
          signal,
          limitBytes: limitBytes - contentBytes,
          onChunk: chunk => {
            channel.send({ type: 'entry', id: index, name, chunk, final: false });
            sent += chunk.byteLength;
            contentBytes += chunk.byteLength;
          },
        });
        channel.send({ type: 'entry', id: index, name, final: true });
        state.succeeded += 1;
      } catch (error) {
        if (sent > 0 || signal?.aborted || !SKIPPABLE.has(error?.code)) throw error;
        state.failed += 1;
        failures.push({ name, reason: errorResult(error).message });
      }
      state.processed = index + 1;
    }
    if (!state.succeeded) throw new AppError('NO_FILES', '所有文件都未能读取，未生成压缩包');
    const archive = await channel.finish({ type: 'finish', failures, manifestName: FAILURE_MANIFEST_NAME });
    channel.close();
    return {
      blob: new Blob(archive.parts, { type: 'application/zip' }),
      name: archiveName(used),
      bytes: contentBytes,
      entries: archive.entries,
      failures,
    };
  } catch (error) {
    channel.abort();
    throw error;
  }
}

// Duplicate names are resolved in selection order, so the same selection always
// yields the same archive.
function uniqueName(used, base) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot < 0 ? base : base.slice(0, dot);
  const extension = dot < 0 ? '' : base.slice(dot);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function archiveName(used) {
  const first = used.values().next().value ?? '';
  const slash = first.indexOf('/');
  return `${slash < 0 ? '课件' : first.slice(0, slash)}.zip`;
}

// Duplex over the worker protocol: replies arrive asynchronously, so a failure
// reported by the worker surfaces on the next `send`, and `finish` awaits the
// archive's final chunk.
function openChannel(worker, onProgressReply) {
  let settled = null;
  let failure = null;
  worker.onmessage = ({ data }) => {
    if (!data) return;
    if (data.type === 'progress') return void onProgressReply(data);
    if (data.type === 'error') {
      failure = new AppError(data.code === 'ARCHIVE' ? 'ARCHIVE' : 'ARCHIVE_PROTOCOL', data.message);
      settled?.reject(failure);
      settled = null;
      return;
    }
    if (data.type === 'complete') {
      const pending = settled;
      settled = null;
      pending?.resolve(data);
    }
  };
  return {
    send(message) {
      if (failure) throw failure;
      worker.postMessage(message);
    },
    finish(message) {
      return new Promise((resolve, reject) => {
        settled = { resolve, reject };
        worker.postMessage(message);
      });
    },
    close() {
      worker.terminate();
      settled = null;
    },
    abort() {
      worker.postMessage({ type: 'abort' });
      worker.terminate();
      failure = null;
      settled = null;
    },
  };
}
