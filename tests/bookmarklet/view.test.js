import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { ActualSizeLimitError } from '../../src/bookmarklet/archive.js';
import { createBookmarkletController } from '../../src/bookmarklet/controller.js';
import { DIRECT_DOWNLOAD_CAUTION } from '../../src/bookmarklet/direct-download.js';
import { downloadUrl, listUrl, preview, previewUrl } from '../helpers/dom.js';

// `panel.css` reaches the shipped bundle through esbuild's text loader
// (`loader:{'.css':'text'}`). This hook gives plain `node --test` the same module
// shape, so these tests exercise the stylesheet exactly as it is packaged.
registerHooks({
  load(url, context, next) {
    if (!url.endsWith('.css')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};` };
  },
});

const { HOST_ID, PANEL_CSS } = await import('../../src/bookmarklet/template.js');
const { mountBookmarklet } = await import('../../src/bookmarklet/view.js');
const { installBookmarklet, RUNTIME_GLOBAL } = await import('../../src/bookmarklet/main.js');

const MiB = 1024 * 1024;
const COURSE_NAME = '电路与模拟电子技术';

const file = (n, extra = {}) => ({
  id: `12:78:${n}`, courseId: '12', resId: '78', fileId: String(n),
  name: `第${n}章.pdf`, extension: 'pdf', sizeText: '1M', sizeBytes: 1024, title: `第${n}章`,
  previewUrl: previewUrl(n), downloadUrl: downloadUrl(n), courseName: COURSE_NAME, ...extra,
});

const payload = (files, courseName = COURSE_NAME) => ({
  id: 'scan-1', phase: 'ready', context: { courseName }, files,
  failures: [], total: files.length, processed: files.length, skipped: 0, message: `找到 ${files.length} 份课件`,
});

function schoolPage(html = '') {
  return new JSDOM(`<!doctype html><html><head><title>网络课程—${COURSE_NAME}</title></head><body>${html}</body></html>`, { url: listUrl }).window;
}

function harness({ files = [file(1)], scan, archive, direct, deliver, courseName = COURSE_NAME } = {}) {
  const calls = { scan: 0, archive: [], direct: [], deliver: [] };
  const dependencies = {
    scan: scan ?? (async () => { calls.scan++; return payload(files, courseName); }),
    cancelScan: () => {},
    archiveFiles: archive ?? (async selected => {
      calls.archive.push(selected);
      return { blob: { type: 'application/zip' }, name: '课件.zip', bytes: 2048, entries: selected.length, failures: [] };
    }),
    downloadDirect: direct ?? (async selected => {
      calls.direct.push(selected);
      return { triggered: selected.map(item => ({ id: item.id, name: item.name })), failed: [], caution: DIRECT_DOWNLOAD_CAUTION };
    }),
  };
  if (deliver) dependencies.deliverArchive = deliver;
  return { controller: createBookmarkletController(dependencies), calls, files };
}

function mount(window, controller) {
  const instance = mountBookmarklet({ window, controller });
  const host = window.document.getElementById(HOST_ID);
  const root = host.shadowRoot;
  return { instance, host, root, ref: name => root.querySelector(`[data-ref="${name}"]`) };
}

const copyLines = root => [...root.querySelectorAll('.confirm-list li')].map(item => item.textContent);
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (rounds = 12) => { for (let index = 0; index < rounds; index++) await new Promise(resolve => setTimeout(resolve, 0)); };

test('the panel is one open shadow root that inlines its own stylesheet', () => {
  const window = schoolPage();
  const { controller } = harness();
  const { host, root } = mount(window, controller);

  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 1);
  assert.ok(host.shadowRoot, 'the shadow root is open');
  assert.equal(root.querySelector('style').textContent, PANEL_CSS, 'the stylesheet travels inside the panel');
  assert.equal(root.querySelector('link'), null, 'no page or remote stylesheet is linked');
  assert.equal(window.document.querySelectorAll('link, style').length, 0, 'the course page DOM is untouched');
  assert.match(PANEL_CSS, /prefers-reduced-motion/, 'reduced motion is respected');
  assert.match(PANEL_CSS, /:focus-visible/, 'focus stays visible');
  assert.doesNotMatch(PANEL_CSS, /@import|url\(\s*['"]?https?:/, 'the panel pulls no external asset');
});

test('course and file text is rendered as text, never as markup', async () => {
  const window = schoolPage();
  const hostile = '<img src=x onerror=alert(1)>.pdf';
  const { controller } = harness({ files: [file(1, { name: hostile })], courseName: '<b>电路</b>' });
  await controller.scan();
  const { root, ref } = mount(window, controller);

  assert.equal(ref('course').textContent, '<b>电路</b>');
  assert.equal(root.querySelector('.file-name').textContent, hostile);
  assert.equal(root.querySelectorAll('img, b, script').length, 0);
});

test('a mounted panel selects nothing and starts no scan, request or download', () => {
  const window = schoolPage();
  const { controller, calls } = harness();
  const { host, root, ref } = mount(window, controller);

  assert.equal(host.hidden, false, 'the panel is shown on mount');
  assert.equal(controller.getSnapshot().state, 'idle');
  assert.equal(ref('course').hidden, true, 'no course name is invented before a scan');
  assert.deepEqual(calls, { scan: 0, archive: [], direct: [], deliver: [] });
  assert.equal(ref('all').checked, false, 'nothing is selected by default');
  assert.equal(root.querySelectorAll('.file').length, 0);
  assert.equal(window.document.querySelectorAll('a[download]').length, 0);

  ref('download').click();
  assert.equal(ref('notice').hidden, false);
  assert.equal(ref('notice').textContent, '请先选择要下载的课件');
  assert.deepEqual(calls.archive, []);
});

test('search, format filters and checkboxes all drive the controller', async () => {
  const window = schoolPage();
  const pdf = file(1);
  const ppt = file(2, { name: '第2章.ppt', extension: 'ppt' });
  const { controller } = harness({ files: [pdf, ppt] });
  await controller.scan();
  const { root, ref } = mount(window, controller);
  assert.equal(root.querySelectorAll('.file').length, 2);

  const boxes = [...root.querySelectorAll('.file input')];
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(controller.getSnapshot().selectedIds, [ppt.id]);
  assert.equal(ref('all').indeterminate, true, 'a partial selection shows a mixed select-all');
  assert.match(ref('counts').textContent, /已选 1 个/);

  ref('all').checked = true;
  ref('all').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(controller.getSnapshot().selectedIds.slice().sort(), [pdf.id, ppt.id].sort());

  root.querySelector('[data-format="pdf"]').click();
  assert.equal(controller.getSnapshot().format, 'pdf');
  assert.deepEqual([...root.querySelectorAll('.file-name')].map(node => node.textContent), [pdf.name]);
  assert.deepEqual(controller.getSnapshot().selectedIds.slice().sort(), [pdf.id, ppt.id].sort(), 'filtering never drops a selection');

  const search = ref('search');
  search.value = '第2';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(controller.getSnapshot().query, '第2');
  assert.equal(root.querySelectorAll('.file').length, 0);
  assert.equal(ref('empty').textContent, '没有匹配的文件');
});

test('progress reports 已识别 while the scan is still running', async () => {
  const window = schoolPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { controller } = harness({
    files: [file(1), file(2)],
    scan: async ({ onProgress }) => {
      onProgress({ message: '正在识别 1 / 2', processed: 1, total: 2 });
      await gate;
      return payload([file(1), file(2)]);
    },
  });
  const { ref } = mount(window, controller);
  const pending = controller.scan();
  await tick();

  assert.equal(ref('progress').hidden, false);
  assert.equal(ref('progressText').textContent, '正在识别 1 / 2');
  assert.equal(ref('bar').value, 1);
  assert.equal(ref('bar').max, 2);

  release();
  await pending;
  assert.equal(ref('progress').hidden, true, 'progress clears once the scan settles');
  assert.equal(ref('counts').textContent, '共 2 个文件 · 已选 0 个');
});

test('a small selection confirms a local ZIP with the memory and page-open warnings', async () => {
  const window = schoolPage();
  const small = file(1, { sizeBytes: 1024 });
  const { controller, calls } = harness({ files: [small] });
  await controller.scan();
  controller.toggle(small.id, true);
  const { root, ref } = mount(window, controller);

  ref('download').click();
  assert.deepEqual(copyLines(root), [
    '共 1 个文件',
    '预计总大小 1.0 KB',
    '打包在页面内存中完成，低内存设备仍可能失败。',
    '打包期间请保持页面打开，不要刷新或关闭页面。',
  ]);
  assert.equal(root.querySelector('.confirm-title').textContent, '确认打包');
  assert.equal(root.querySelector('.confirm-actions [data-action="confirm"]').textContent, '确认打包');
  assert.equal(calls.archive.length, 0, 'the first click only confirms');

  root.querySelector('.confirm-actions [data-action="confirm"]').click();
  await settle();
  assert.equal(calls.archive.length, 1);
  assert.match(ref('result').textContent, /ZIP 已生成并触发下载/);
  assert.equal(ref('confirm').hidden, true);
});

test('a large selection only offers confirmed direct downloads', async () => {
  const window = schoolPage();
  const big = file(1, { sizeBytes: 600 * MiB });
  const { controller, calls } = harness({ files: [big] });
  await controller.scan();
  controller.toggle(big.id, true);
  const { root, ref } = mount(window, controller);

  ref('download').click();
  assert.equal(controller.getSnapshot().state, 'confirm-direct');
  assert.deepEqual(copyLines(root), [
    '所选文件共 1 个',
    '预计总大小 600.0 MB，超过 500.0 MB 上限',
    '不会生成 ZIP，将逐个下载原文件',
    '页面必须保持打开，失败项不会由后台恢复。',
    DIRECT_DOWNLOAD_CAUTION,
  ]);
  assert.equal(root.querySelector('.confirm-actions [data-action="confirm"]').textContent, '确认逐个下载');
  assert.deepEqual(calls.direct, [], 'the first click only confirms');
});

test('an unknown size demands the same second confirmation and is labelled as unknown', async () => {
  const window = schoolPage();
  const unknown = file(1, { sizeBytes: null });
  const { controller, calls, files } = harness({ files: [unknown] });
  await controller.scan();
  controller.toggle(files[0].id, true);
  const { root, ref } = mount(window, controller);

  assert.equal(root.querySelector('.file-size').textContent, '大小未知');
  ref('download').click();
  assert.deepEqual(copyLines(root), [
    '所选文件共 1 个',
    '已知总量 0 B，另有 1 个文件大小未知',
    '不会生成 ZIP，将逐个下载原文件',
    '页面必须保持打开，失败项不会由后台恢复。',
    DIRECT_DOWNLOAD_CAUTION,
  ]);
  assert.deepEqual(calls.direct, []);
});

test('a confirmed direct download reports 已触发 and never claims the files were saved', async () => {
  const window = schoolPage();
  const big = file(1, { sizeBytes: 600 * MiB });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { controller } = harness({
    files: [big],
    direct: async (selected, { onProgress }) => {
      onProgress({ message: '已触发 1/1', triggered: 1, total: 1 });
      await gate;
      return { triggered: selected.map(item => ({ id: item.id, name: item.name })), failed: [], caution: DIRECT_DOWNLOAD_CAUTION };
    },
  });
  await controller.scan();
  controller.toggle(big.id, true);
  const { root, ref } = mount(window, controller);

  ref('download').click();
  root.querySelector('.confirm-actions [data-action="confirm"]').click();
  await tick();
  assert.equal(ref('progressText').textContent, '已触发 1/1');

  release();
  await settle();
  const result = ref('result').textContent;
  assert.match(result, /已触发 1\/1 个下载/);
  assert.match(result, /不代表文件已保存完成/);
  assert.doesNotMatch(result, /已完成|已保存成功/);
});

test('an archive that actually exceeds the limit returns to confirmation without downloading', async () => {
  const window = schoolPage();
  const small = file(1, { sizeBytes: 1024 });
  const { controller, calls } = harness({
    files: [small],
    archive: async () => { throw new ActualSizeLimitError(); },
  });
  await controller.scan();
  controller.toggle(small.id, true);
  const { root, ref } = mount(window, controller);

  ref('download').click();
  root.querySelector('.confirm-actions [data-action="confirm"]').click();
  await settle();

  assert.equal(controller.getSnapshot().state, 'actual-size-overflow');
  assert.equal(ref('confirm').hidden, false);
  assert.equal(ref('result').hidden, true, 'the unpublished archive is destroyed, not delivered');
  assert.equal(root.querySelector('.confirm-title').textContent, '实际大小超过限制');
  assert.deepEqual(copyLines(root), [
    '实际读取已超过 500.0 MB，未发布的临时 ZIP 已销毁，不会自动改为逐个下载。',
    '确认后将逐个下载 1 个原文件。',
    '不会生成 ZIP，将逐个下载原文件',
    DIRECT_DOWNLOAD_CAUTION,
  ]);
  assert.deepEqual(calls.direct, [], 'an overflow never starts direct downloads by itself');

  root.querySelector('.confirm-actions [data-action="confirm"]').click();
  await settle();
  assert.equal(calls.direct.length, 1, 'only the second confirmation downloads');
});

test('focus moves into the confirmation and returns to the trigger when it closes', async () => {
  const window = schoolPage();
  const small = file(1, { sizeBytes: 1024 });
  const { controller } = harness({ files: [small] });
  await controller.scan();
  controller.toggle(small.id, true);
  const { root, ref } = mount(window, controller);

  ref('download').click();
  assert.equal(root.activeElement, root.querySelector('.confirm-actions [data-action="confirm"]'));

  root.querySelector('.confirm-actions [data-action="cancel"]').click();
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(root.activeElement, ref('download'), 'focus returns to the panel trigger');
});

test('close only hides the panel, and a running task can only be hidden', async () => {
  const window = schoolPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { controller } = harness({
    files: [file(1)],
    scan: async ({ onProgress }) => {
      onProgress({ message: '正在识别 1 / 1', processed: 1, total: 1 });
      await gate;
      return payload([file(1)]);
    },
  });
  const { host, ref } = mount(window, controller);

  const pending = controller.scan();
  await tick();
  assert.equal(ref('close').textContent, '隐藏');
  assert.match(ref('busyNote').textContent, /保持页面打开/);
  assert.equal(ref('cancel').hidden, false, 'a running task offers cancel');

  ref('close').click();
  assert.equal(host.hidden, true);
  assert.equal(controller.getSnapshot().busy, true, 'hiding never cancels the task');

  controller.show();
  assert.equal(host.hidden, false, 'the panel comes back while the task runs');

  release();
  await pending;
  assert.equal(ref('close').textContent, '关闭');
  assert.equal(ref('busyNote').hidden, true);
  assert.equal(ref('cancel').hidden, true);
  assert.equal(host.hidden, false);
});

test('destroy removes the host, stops listening and aborts the running scan', async () => {
  const window = schoolPage();
  let signal;
  const { controller } = harness({ scan: request => { signal = request.signal; return new Promise(() => {}); } });
  const { instance, host } = mount(window, controller);

  void controller.scan();
  assert.equal(controller.getSnapshot().busy, true);

  instance.destroy();
  assert.equal(signal.aborted, true, 'in-flight reads are aborted');
  assert.equal(host.isConnected, false);
  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 0);
  assert.equal(controller.getSnapshot().state, 'cancelled');

  controller.show();
  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 0, 'a destroyed panel never returns');
});

test('a second invocation shows the running panel instead of mounting another', () => {
  const window = schoolPage();
  const forbid = () => assert.fail('mounting must not request anything');
  const options = { fetcher: forbid, parseDocument: forbid };

  const first = installBookmarklet(window, options);
  assert.equal(window[RUNTIME_GLOBAL], first);
  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 1);
  assert.equal(first.getSnapshot().state, 'idle');
  const host = window.document.getElementById(HOST_ID);
  assert.equal(host.hidden, false);

  first.controller.hide();
  assert.equal(host.hidden, true);
  const second = installBookmarklet(window, options);
  assert.equal(second, first, 'the same panel is returned');
  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 1, 'no second host is mounted');
  assert.equal(host.hidden, false, 'show() re-displayed the panel');

  first.destroy();
  assert.equal(window[RUNTIME_GLOBAL], undefined, 'destroy clears the singleton');
  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 0);

  const third = installBookmarklet(window, options);
  assert.notEqual(third, first);
  assert.equal(window.document.querySelectorAll(`#${HOST_ID}`).length, 1);
});

test('scanning through the real runtime delivers one ZIP blob that is revoked right away', async () => {
  const window = schoolPage(`<a href="${previewUrl(56)}">第56章</a>`);
  const created = [];
  const revoked = [];
  const clicks = [];
  window.URL.createObjectURL = blob => { created.push(blob); return 'blob:panel-test'; };
  window.URL.revokeObjectURL = url => { revoked.push(url); };
  window.document.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a[download]');
    if (!anchor) return;
    clicks.push({ href: anchor.href, download: anchor.download });
    // jsdom cannot follow a download link and reports the attempt as an error.
    event.preventDefault();
  });

  const panel = installBookmarklet(window, {
    fetcher: async () => new Response(preview('第一章.PPT', 56, '9.1M'), { headers: { 'content-type': 'text/html;charset=UTF-8' } }),
    archive: async selected => ({ blob: new window.Blob(['zip']), name: '课件.zip', bytes: 2048, entries: selected.length, failures: [] }),
  });
  assert.equal(window.document.querySelectorAll('a[download]').length, 0, 'mounting downloads nothing');

  const root = window.document.getElementById(HOST_ID).shadowRoot;
  const ref = name => root.querySelector(`[data-ref="${name}"]`);
  ref('scan').click();
  await settle();

  assert.equal(root.querySelectorAll('.file').length, 1);
  assert.equal(root.querySelector('.file-name').textContent, '第一章.PPT');
  assert.equal(panel.getSnapshot().state, 'ready');

  const box = root.querySelector('.file input');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(ref('counts').textContent, /预计 9\.1 MB/);
  ref('download').click();
  assert.equal(root.querySelector('.confirm-title').textContent, '确认打包');
  root.querySelector('.confirm-actions [data-action="confirm"]').click();
  await settle();

  assert.equal(created.length, 1, 'exactly one blob URL is created');
  assert.deepEqual(revoked, ['blob:panel-test'], 'and revoked immediately after the click');
  assert.deepEqual(clicks, [{ href: 'blob:panel-test', download: '课件.zip' }]);
  assert.match(ref('result').textContent, /ZIP 已生成并触发下载/);
});
