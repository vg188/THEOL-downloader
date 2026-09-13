import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../../scripts/build.mjs';
import { openNativePopup } from './helpers/native-popup.js';

// End-to-end proof of the unit-study flow against real Chrome: the entry route
// redirects through the network stack, the unit pages render per session state,
// and the popup drives current-unit and all-unit scans through the real bridge,
// content script and platform parsers. Fixtures are synthetic; the platform is
// never contacted.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = join(root, 'output/playwright/unit-study');
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => existsSync(path));

const origin = 'https://course.buct.edu.cn';
const lessonPath = '/meol/jpk/course/layout/lesson/index.jsp';
const newpagePath = '/meol/jpk/course/layout/newpage/index.jsp';
const listPath = '/meol/common/script/listview.jsp';
const entryPath = '/meol/jpk/course/course_column_preview_transfer.jsp';
const previewPath = '/meol/common/script/preview/download_preview.jsp';
const downloadPath = '/meol/common/script/download.jsp';
const page = (html) => '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' + html + '</html>';
const previewLink = (n) => `${previewPath}?fileid=${n}&resid=78&lid=12`;
const fileRows = (numbers) => numbers.map(n => `<p><a href="${previewLink(n)}">第 ${n} 章课件</a></p>`).join('');
const entryAnchor = (columnId, label) => `<a href="${entryPath}?tagbug=client&columnId=${columnId}">${label}</a>`;

async function installUnitFixture(context) {
  const requests = [];
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (url.origin !== origin) return route.abort();
    const destination = route.request().resourceType() === 'document' ? 'document' : 'fetch';
    let html, status = 200, headers = {};
    if (url.pathname === entryPath) {
      const columnId = url.searchParams.get('columnId');
      if (url.searchParams.get('tagbug') !== 'client' || !['41', '42'].includes(columnId)) {
        return route.fulfill({ status: 404, body: 'Unknown unit' });
      }
      // The entry route renders the unit at its own URL here. The other legitimate
      // shape — a transfer to a lesson/newpage layout — cannot be simulated with
      // route interception, because Playwright does not intercept the hop of a
      // fulfilled redirect (it escapes to the real network); that shape is pinned
      // by tests/unit-scan.test.js instead.
      html = '<title>网络课程—单元学习（模拟数据）</title>' + fileRows(columnId === '41' ? [56, 57] : [58]);
    } else if (url.pathname.endsWith('/newpage/index.jsp')) {
      if (url.searchParams.get('courseId') !== '12') return route.fulfill({ status: 404, body: 'Unknown course' });
      html = '<title>网络课程—单元学习（模拟数据）</title><iframe id="outer" src="/qa-course-frame.html"></iframe>';
    } else if (url.pathname === '/qa-course-frame.html') {
      html = '<iframe id="inner" src="' + listPath + '?lid=12&folderid=34"></iframe>';
    } else if (url.pathname === lessonPath) {
      if (url.searchParams.get('courseId') !== '12') return route.fulfill({ status: 404, body: 'Unknown course' });
      // The page the user sits on: a bounded unit list plus the current unit's
      // courseware rendered by a nested frame.
      html = '<title>网络课程—单元学习（模拟数据）</title><ul id="units"><li>'
        + entryAnchor(41, '第一次课') + '</li><li>' + entryAnchor(42, '第二次课') + '</li></ul>'
        + '<iframe id="unit-list" src="' + listPath + '?lid=12&folderid=34"></iframe>';
    } else if (url.pathname === listPath) {
      html = fileRows([56, 57]);
    } else if (url.pathname === previewPath) {
      const fileId = url.searchParams.get('fileid');
      html = '<h2>文件名:单元课件 ' + fileId + '.pdf (1.2M)<a href="' + downloadPath + '?fileid=' + fileId
        + '&resid=78&lid=12">下载</a></h2>';
    } else {
      return route.fulfill({ status: 404, body: 'No file downloads in unit tests' });
    }
    await route.fulfill({ status, headers, contentType: 'text/html; charset=utf-8', body: page(html) });
  });
  return { requests };
}

test('unit study scans the current unit and, after confirmation, every unit', { timeout: 90000 }, async () => {
  assert.ok(chrome, 'Install desktop Chrome or set CHROME_PATH to its executable');
  const extensionPath = await buildExtension();
  await mkdir(artifacts, { recursive: true });
  const profile = await mkdtemp(join(artifacts, 'profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chrome, headless: true, viewport: null,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--enable-automation', '--window-size=1280,900'],
    });
    const browserSession = await context.browser().newBrowserCDPSession();
    const { id } = await browserSession.send('Extensions.loadUnpacked', { path: extensionPath });
    const fixture = await installUnitFixture(context);
    const course = context.pages()[0] || await context.newPage();
    const lessonUrl = origin + lessonPath + '?courseId=12';
    await course.goto(lessonUrl);
    await course.frameLocator('#unit-list').locator('a').first().waitFor();
    await course.bringToFront();
    const popup = await openNativePopup(context, browserSession, id);
    try {
      // The unit page offers both ranges and defaults to the current unit.
      await popup.waitFor(() => {
        const mode = document.querySelector('#scan-mode');
        return mode && !document.querySelector('#scan-mode-row').hidden
          && mode.value === 'current' && mode.options.length === 2 && !document.querySelector('#scan-button').disabled;
      });
      const ranges = await popup.evaluate(() => ({
        labels: [...document.querySelector('#scan-mode').options].map(option => option.textContent),
        scope: document.querySelector('#scope-copy').textContent,
      }));
      assert.deepEqual(ranges.labels, ['当前单元', '全部单元']);
      assert.equal(ranges.scope.includes('当前目录'), false, 'a unit page never claims to scan the current directory');

      // Current unit: the courseware the page already rendered, including the
      // frame that hosts the list.
      await popup.evaluate(() => document.querySelector('#scan-button').click());
      await popup.waitFor(() => document.querySelectorAll('#file-list .file-row').length === 2);
      assert.equal(fixture.requests.filter(url => url.includes(entryPath)).length, 0,
        'the current range never reads a unit entry page');

      // All units: the count is shown before anything is read, and nothing is
      // requested until the confirmation is accepted.
      await popup.evaluate(() => {
        const mode = document.querySelector('#scan-mode');
        mode.value = 'all';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#scan-button').click();
      });
      await popup.waitFor(() => document.querySelector('#all-units-dialog').open === true);
      const dialog = await popup.evaluate(() => ({
        title: document.querySelector('#all-units-title').textContent,
        copy: document.querySelector('#all-units-copy').textContent,
      }));
      assert.equal(dialog.title, '扫描全部单元？');
      assert.match(dialog.copy, /2 个单元页面/);
      assert.equal(fixture.requests.filter(url => url.includes(entryPath)).length, 0,
        'no unit page is read before the confirmation');

      await popup.evaluate(() => document.querySelector('#all-units-confirm').click());
      await popup.waitFor(() => document.querySelectorAll('#file-list .file-row').length === 3);
      const entries = fixture.requests.filter(url => url.includes(entryPath));
      assert.equal(entries.length, 2, 'each unit entry is read exactly once');
      assert.deepEqual(entries.map(url => new URL(url).searchParams.get('columnId')).sort(), ['41', '42']);
      assert.equal(fixture.requests.some(url => url.includes('resFolderViewList.do')), false,
        'the auxiliary folder route is never traversed');
      assert.equal(course.url(), lessonUrl, 'scanning never navigates the page');
    } finally {
      await popup.close();
    }
  } finally {
    await context.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
