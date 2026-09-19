import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountPopup } from '../src/popup/view.js';
import { file } from './helpers/dom.js';

const POPUP_HTML = new URL('../public/popup.html', import.meta.url);
const readyScan = (files = [file(1), file(2)]) => ({
  id: 'scan-one', phase: 'ready', context: { key: 'one', courseName: '电路' },
  files, failures: [], unitFailures: [], units: { processed: 0, total: 0, discovered: 0 },
  total: files.length, processed: files.length, skipped: 0,
});
const job = (overrides = {}) => ({
  id: 'job-1', file: file(1), status: 'queued', downloadId: null,
  bytesReceived: 0, totalBytes: 0, error: '', errorCode: '', ...overrides,
});
// The panel awaits nothing on click, so assertions must let the pending
// action settle before reading the DOM or the recorded messages.
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function mount(t, { jobs = [], scan = readyScan(), page = {} } = {}) {
  const document = new JSDOM(await readFile(POPUP_HTML, 'utf8'), { url: 'https://example.test/popup.html' }).window.document;
  const calls = [];
  const state = { scan, page, queue: { jobs } };
  const app = await mountPopup({
    document, activeTab: 7, subscribe: () => () => {},
    send: async message => {
      calls.push(message);
      if (message.type === 'GET_STATE') return { ok: true, data: { scan: state.scan, queue: state.queue, page: state.page } };
      if (message.type === 'RETRY_FAILED') return { ok: true, data: { jobs: state.queue.jobs.map(j => message.ids.includes(j.id) ? { ...j, status: 'queued', error: '' } : j) } };
      return { ok: true, data: { jobs: state.queue.jobs } };
    },
  });
  t.after(() => app.destroy());
  return { document, calls, state };
}

test('download history renders one row per job with its status label', async t => {
  const { document } = await mount(t, { jobs: [
    job({ id: 'a', status: 'queued' }),
    job({ id: 'b', file: file(2), status: 'preparing' }),
    job({ id: 'c', file: file(3), status: 'downloading', bytesReceived: 1024, totalBytes: 4096 }),
    job({ id: 'd', file: file(4), status: 'complete', downloadId: 9 }),
    job({ id: 'e', file: file(5), status: 'failed', error: '登录失效，请重新登录' }),
  ] });
  const rows = [...document.querySelectorAll('.job-row')];
  assert.equal(rows.length, 5);
  // Newest first: the list is rendered reversed.
  assert.deepEqual(rows.map(row => row.querySelector('.job-status').textContent), ['失败', '已完成', '下载中', '校验中', '排队中']);
  assert.equal(rows[0].querySelector('.file-name').textContent, file(5).name);
  assert.equal(document.querySelector('#history-empty').hidden, true);
});

test('a failed job exposes its reason and offers retry only for that job', async t => {
  const { document, calls } = await mount(t, { jobs: [
    job({ id: 'ok', file: file(2), status: 'complete', downloadId: 9 }),
    job({ id: 'bad', status: 'failed', error: '登录失效，请重新登录' }),
  ] });
  const rows = [...document.querySelectorAll('.job-row')];
  const failed = rows.find(row => row.querySelector('.file-name').textContent === file(1).name);
  assert.equal(failed.querySelector('.job-error').hidden, false);
  assert.equal(failed.querySelector('.job-error').textContent, '登录失效，请重新登录');
  assert.equal(failed.querySelector('button').textContent, '重试');
  assert.equal(failed.querySelector('button').getAttribute('aria-label'), `重试 ${file(1).name}`);
  failed.querySelector('button').click();
  await flush();
  const retry = calls.find(call => call.type === 'RETRY_FAILED');
  assert.deepEqual(retry.ids, ['bad']);
});

test('a completed job offers "show in folder" instead of retry', async t => {
  const { document, calls } = await mount(t, { jobs: [job({ id: 'done', status: 'complete', downloadId: 9 })] });
  const button = document.querySelector('.job-row button');
  assert.equal(button.textContent, '在文件夹中显示');
  assert.equal(button.getAttribute('aria-label'), `在文件夹中显示 ${file(1).name}`);
  button.click();
  await flush();
  assert.deepEqual(calls.find(call => call.type === 'SHOW_DOWNLOAD'), { type: 'SHOW_DOWNLOAD', id: 'done' });
});

test('buttons and progress only appear for finished or transferring jobs', async t => {
  const { document } = await mount(t, { jobs: [
    job({ id: 'q', status: 'queued' }),
    job({ id: 'c', file: file(2), status: 'complete', downloadId: 9 }),
  ] });
  const queuedRow = [...document.querySelectorAll('.job-row')].find(row => row.querySelector('.job-status').textContent === '排队中');
  assert.equal(queuedRow.querySelector('button').hidden, true);
  assert.equal(queuedRow.querySelector('progress').hidden, true);
  assert.equal(queuedRow.querySelector('.job-error').hidden, true);
});

test('the progress bar reports transferred bytes while downloading', async t => {
  const { document } = await mount(t, { jobs: [job({ status: 'downloading', bytesReceived: 2048, totalBytes: 8192 })] });
  const progress = document.querySelector('.job-row progress');
  assert.equal(progress.hidden, false);
  assert.equal(progress.max, 8192);
  assert.equal(progress.value, 2048);
  assert.equal(progress.getAttribute('aria-label'), `${file(1).name} 下载进度`);
  assert.match(document.querySelector('.job-row .file-meta').textContent, /2(\.0)? ?KB \/ 8(\.0)? ?KB/);
});

test('a download with unknown total size stays indeterminate', async t => {
  const { document } = await mount(t, { jobs: [job({ status: 'downloading', bytesReceived: 512, totalBytes: 0 })] });
  assert.equal(document.querySelector('.job-row progress').hidden, true);
  assert.match(document.querySelector('.job-row .file-meta').textContent, /正在传输/);
});

test('history summary counts running and completed jobs; retry-all tracks failures', async t => {
  const { document } = await mount(t, { jobs: [
    job({ id: 'a', status: 'downloading' }),
    job({ id: 'b', file: file(2), status: 'complete', downloadId: 9 }),
    job({ id: 'c', file: file(3), status: 'complete', downloadId: 10 }),
  ] });
  assert.equal(document.querySelector('#history-summary').textContent, '1 项进行中 · 2 项已完成');
  assert.equal(document.querySelector('#retry-all').disabled, true);
});

test('retry-all is enabled as soon as one job fails', async t => {
  const { document, calls } = await mount(t, { jobs: [
    job({ id: 'a', status: 'failed', error: '下载中断' }),
    job({ id: 'b', file: file(2), status: 'complete', downloadId: 9 }),
  ] });
  const retryAll = document.querySelector('#retry-all');
  assert.equal(retryAll.disabled, false);
  retryAll.click();
  await flush();
  assert.deepEqual(calls.find(call => call.type === 'RETRY_FAILED').ids, ['a']);
});

test('the scan button starts a current-range scan for the active tab', async t => {
  const { document, calls } = await mount(t, { page: { context: { surface: 'resource-directory', modeOptions: ['current'], courseName: '电路', key: 'resource-directory|current|x' } } });
  document.querySelector('#scan-button').click();
  await flush();
  assert.deepEqual(calls.find(call => call.type === 'START_SCAN'), { type: 'START_SCAN', tabId: 7, mode: 'current' });
});

test('select-all checks every visible file and the count follows', async t => {
  const { document } = await mount(t);
  const all = document.querySelector('#select-all');
  all.checked = true;
  all.dispatchEvent(new document.defaultView.Event('change'));
  assert.equal(document.querySelectorAll('.file-row input:checked').length, 2);
  assert.match(document.querySelector('#selection-summary').textContent, /已选 2 份/);
  assert.equal(document.querySelector('#download-button').disabled, false);
  all.checked = false;
  all.dispatchEvent(new document.defaultView.Event('change'));
  assert.equal(document.querySelectorAll('.file-row input:checked').length, 0);
  assert.equal(document.querySelector('#selection-summary').textContent, '尚未选择课件');
});

test('select-all skips files that are already queued or downloading', async t => {
  const { document } = await mount(t, { jobs: [job({ status: 'downloading' })] });
  const all = document.querySelector('#select-all');
  all.checked = true;
  all.dispatchEvent(new document.defaultView.Event('change'));
  assert.equal(document.querySelectorAll('.file-row input:checked').length, 1);
  const busyRow = [...document.querySelectorAll('.file-row')].find(row => row.querySelector('.file-name').textContent === file(1).name);
  assert.equal(busyRow.querySelector('input').checked, false);
  assert.equal(busyRow.querySelector('input').disabled, true);
  assert.equal(busyRow.classList.contains('busy'), true);
});

test('the tab list is reachable with arrow, Home and End keys', async t => {
  const { document } = await mount(t);
  const tablist = document.querySelector('[role=tablist]');
  const press = key => tablist.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('ArrowRight');
  assert.equal(document.querySelector('#history-tab').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('#files-tab').getAttribute('aria-selected'), 'false');
  press('ArrowLeft');
  assert.equal(document.querySelector('#files-tab').getAttribute('aria-selected'), 'true');
  press('End');
  assert.equal(document.querySelector('#history-tab').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('#download-button').textContent, '打开 Chrome 下载页');
  press('Home');
  assert.equal(document.querySelector('#files-tab').getAttribute('aria-selected'), 'true');
});

test('an unrecognised key leaves the tab list alone', async t => {
  const { document } = await mount(t);
  const tablist = document.querySelector('[role=tablist]');
  const event = new document.defaultView.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  tablist.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(document.querySelector('#files-tab').getAttribute('aria-selected'), 'true');
});

test('a failed request surfaces its message and does not disable the panel', async t => {
  const document = new JSDOM(await readFile(POPUP_HTML, 'utf8'), { url: 'https://example.test/popup.html' }).window.document;
  const app = await mountPopup({
    document, activeTab: 7, subscribe: () => () => {},
    send: async message => message.type === 'START_SCAN' ? { ok: false, error: { message: '请先打开学校教学平台的课程资源页' } } : { ok: true, data: { scan: readyScan(), queue: { jobs: [] }, page: {} } },
  });
  document.querySelector('#scan-button').click();
  await flush();
  assert.equal(document.querySelector('#notice').hidden, false);
  assert.equal(document.querySelector('#notice').textContent, '请先打开学校教学平台的课程资源页');
  assert.equal(document.querySelector('#scan-button').disabled, false);
  app.destroy();
});
