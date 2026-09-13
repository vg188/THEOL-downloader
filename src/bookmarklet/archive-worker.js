// Store-mode ZIP writer for the bookmarklet. The page keeps the network and the
// 500 MiB policy; this module only turns streamed chunks into one archive, either
// inside a real Worker (bundled from this file) or, when the feasibility gate
// picked main-thread archiving, through the same protocol with `createLoopbackWorker`.
//
// Protocol, main -> worker:
//   {type:'start'}                                  begin a session, discarding earlier state
//   {type:'entry',id,name,chunk,final}              append `chunk` to entry `id`; `final` closes it
//   {type:'finish',failures,manifestName?}          add 下载失败清单.txt when failures exist, then end
//   {type:'abort'}                                  discard the unpublished archive without a reply
// Worker -> main:
//   {type:'progress',id,entryBytes,totalBytes}      one reply per `entry` message
//   {type:'complete',parts,entries,bytes}           ordered ZIP parts, entry count, content bytes
//   {type:'error',code,message}                     protocol or fflate failure
import { Zip, ZipPassThrough } from 'fflate';

export const FAILURE_MANIFEST_NAME = '下载失败清单.txt';

const UTF8 = new TextEncoder();
const EMPTY = new Uint8Array(0);

export function createArchiveSession(post) {
  let zip = null;
  let ending = false;
  let failure = null;
  let parts = [];
  let entries = new Map();
  let count = 0;
  let bytes = 0;

  // The manifest is the only entry this module names itself. It can never collide
  // with courseware: every courseware entry lives under a `<course>/` folder.
  function manifestEntry(name, text) {
    const file = new ZipPassThrough(name);
    zip.add(file);
    file.push(UTF8.encode(text), true);
  }

  function onData(error, data, final) {
    if (error) {
      failure = error;
      post({ type: 'error', code: 'ARCHIVE', message: '打包失败，请重试' });
      return;
    }
    // Store mode passes each forwarded chunk through by reference, so the archive's
    // parts reuse those buffers instead of copying every file a second time.
    if (data?.byteLength) parts.push(data);
    if (final) post({ type: 'complete', parts, entries: count, bytes });
  }

  function reset() {
    zip = new Zip(onData);
    ending = false;
    failure = null;
    parts = [];
    entries = new Map();
    count = 0;
    bytes = 0;
  }

  function append({ id, name, chunk, final }) {
    if (!zip || ending) return void post({ type: 'error', code: 'PROTOCOL', message: '归档任务尚未开始或已结束' });
    let entry = entries.get(id);
    if (!entry) {
      if (typeof name !== 'string' || !name) return void post({ type: 'error', code: 'PROTOCOL', message: '归档条目缺少文件名' });
      // `add` writes this entry's local header, so it must precede its first chunk.
      entry = { file: new ZipPassThrough(name), bytes: 0, closed: false };
      zip.add(entry.file);
      entries.set(id, entry);
    }
    if (entry.closed) return void post({ type: 'error', code: 'PROTOCOL', message: `归档条目 ${id} 已结束` });
    const data = chunk?.byteLength ? chunk : EMPTY;
    entry.file.push(data, Boolean(final));
    if (failure) return;
    entry.bytes += data.byteLength;
    bytes += data.byteLength;
    if (final) {
      entry.closed = true;
      count += 1;
    }
    post({ type: 'progress', id, entryBytes: entry.bytes, totalBytes: bytes });
  }

  function finish({ failures, manifestName = FAILURE_MANIFEST_NAME }) {
    if (!zip || ending) return void post({ type: 'error', code: 'PROTOCOL', message: '归档任务尚未开始或已结束' });
    ending = true;
    if (Array.isArray(failures) && failures.length) {
      manifestEntry(manifestName, failures.map(({ name, reason }) => `${name}\t${reason}`).join('\n') + '\n');
    }
    if (failure) return;
    zip.end();
  }

  return {
    handle(message) {
      const type = message?.type;
      if (type === 'start') return void reset();
      if (type === 'abort') return void reset();
      if (failure) return;
      if (type === 'entry') return void append(message);
      if (type === 'finish') return void finish(message);
      post({ type: 'error', code: 'PROTOCOL', message: `未知的归档消息：${String(type)}` });
    },
  };
}

// Wires a worker scope (`postMessage`/`onmessage`) to a session. Used by the real
// module worker below and by the loopback adapter.
export function connectArchiveWorker(scope) {
  const session = createArchiveSession(message => scope.postMessage(message));
  scope.onmessage = event => session.handle(event?.data);
  return session;
}

// Worker-like object speaking the same protocol on the page's thread. Replies are
// deferred by a microtask, so callers exercise the asynchronous ordering a real
// Worker imposes instead of a synchronous shortcut.
export function createLoopbackWorker() {
  let reply = null;
  let terminated = false;
  const scope = {
    postMessage(message) {
      queueMicrotask(() => { if (!terminated) reply?.({ data: message }); });
    },
  };
  connectArchiveWorker(scope);
  return {
    postMessage(message) {
      queueMicrotask(() => { if (!terminated) scope.onmessage?.({ data: message }); });
    },
    terminate() { terminated = true; },
    set onmessage(handler) { reply = handler; },
    get onmessage() { return reply; },
  };
}

// `self` without `document` is a dedicated worker; Node and page imports stay inert.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document) {
  connectArchiveWorker(self);
}
