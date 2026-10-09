import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';
import { unzipSync } from 'fflate';
import { buildReleaseExtension } from '../../scripts/build-release.mjs';
import { buildSite } from '../../web/build.mjs';
import { ROOT, ORIGIN, LIST, file, link, listHTML, previewHTML, fixtureBytes } from '../release/helpers.js';

const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const artifacts = join(ROOT, 'output', 'playwright', 'release-flow');
const pageUrl = ORIGIN + '/meol/common/script/courseResource.jsp?lid=42';
const entryPath = '/meol/jpk/course/course_column_preview_transfer.jsp';
const folderRow = '<tr><td><img src="/folder.gif"><a href="listview.jsp?acttype=enter&folderid=5&lid=42">第二讲</a></td></tr>';
async function fixtures(context) {
  const requests = [];
  await context.route('http{,s}://**/*', async route => {
    const url = new URL(route.request().url()); requests.push(url.href);
    if (url.origin !== ORIGIN) return route.abort();
    let html;
    if (url.pathname.endsWith('/courseResource.jsp')) html = '<title>网络课程 — 浏览器验收课程</title><ul><li><a href="' + entryPath + '?tagbug=client&columnId=501&courseId=42">第一单元</a></li></ul><iframe id="course-list" style="width:95%;height:400px" src="' + LIST + '"></iframe>';
    else if (url.pathname.endsWith('/listview.jsp')) html = url.searchParams.get('folderid') === '5' ? listHTML([file(2)]) : listHTML([file()], folderRow);
    else if (url.pathname === entryPath) html = '<title>第一单元</title>' + link(file(3));
    else if (url.pathname.endsWith('/preview/download_preview.jsp')) html = previewHTML(file(Number(url.searchParams.get('fileid'))));
    else if (url.pathname.endsWith('/download.jsp')) return route.fulfill({ contentType: 'application/pdf', body: fixtureBytes(url.searchParams.get('fileid') === '2' ? 'sample-alt.pdf' : 'sample.pdf') });
    else return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' + html + '</html>' });
  });
  return requests;
}
async function cleanupProfile(profile) {
  const base = await realpath(artifacts), target = await realpath(profile);
  const rel = relative(base, target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'profile must stay in the named artifact directory');
  await rm(target, { recursive: true, force: true });
}
test('current Chrome release: frame scanning, stale-selection refusal, real bookmark URL and ZIP download', { timeout: 90000 }, async () => {
  assert.ok(chrome, 'Install Chrome or set CHROME_PATH');
  await mkdir(artifacts, { recursive: true });
  const extension = await buildReleaseExtension();
  const site = await buildSite();
  const profile = await mkdtemp(join(artifacts, 'profile-'));
  await mkdir(join(profile, 'Default'));
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: chrome, headless: true, viewport: { width: 1280, height: 900 }, acceptDownloads: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--enable-automation', '--host-resolver-rules=MAP course.buct.edu.cn ~NOTFOUND'] });
    const browserSession = await context.browser().newBrowserCDPSession();
    const { id } = await browserSession.send('Extensions.loadUnpacked', { path: extension });
    const requests = await fixtures(context);
    const course = context.pages()[0];
    const errors = []; course.on('pageerror', error => errors.push(error.message));
    await course.goto(pageUrl);
    await course.frameLocator('#course-list').locator('table.valuelist').waitFor();
    const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
    await panel.goto('chrome-extension://' + id + '/panel.html');
    await panel.waitForFunction(() => document.querySelector('#statusBar').textContent.includes('发现 1 个文件'));
    await panel.locator('input[data-kind="file"]').check();
    await course.frameLocator('#course-list').locator('table').evaluate((table, preview) => { const row = table.insertRow(); const cell = row.insertCell(); const a = document.createElement('a'); a.href = preview; a.textContent = 'added.pdf'; cell.appendChild(a); }, file(4).previewUrl);
    await panel.locator('#btnDownload').click();
    await panel.waitForFunction(() => document.querySelector('#statusBar').textContent.includes('已改变'));
    assert.equal(requests.some(url => url.includes('/download.jsp')), false, 'stale selection never starts a file request');
    await panel.locator('#btnRescan').click();
    await panel.waitForFunction(() => document.querySelector('#statusBar').textContent.includes('发现 2 个文件'));
    await panel.locator('[data-mode="tree"]').click();
    await panel.waitForFunction(() => document.querySelector('#statusBar').textContent.includes('发现 2 个文件') && !document.querySelector('#btnRescan').disabled);
    await panel.screenshot({ path: join(artifacts, 'extension-panel.png'), fullPage: true });
    await panel.setViewportSize({ width: 480, height: 850 });
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'extension must not overflow horizontally');
    assert.ok(await panel.locator('.course-meta').evaluate(element => element.getBoundingClientRect().width > 200), 'course title must not be squeezed into a vertical column');
    await panel.screenshot({ path: join(artifacts, 'extension-panel-480.png'), fullPage: true });

    await course.bringToFront();
    course.on('dialog', dialog => dialog.accept());
    const href = await readFile(join(site, 'bookmarklet.txt'), 'utf8');
    await course.evaluate(bookmark => { const anchor = document.createElement('a'); anchor.href = bookmark; document.body.appendChild(anchor); anchor.click(); anchor.remove(); }, href);
    await course.locator('#buct-tab-dl-host').waitFor();
    await course.waitForFunction(() => { const root = document.getElementById('buct-tab-dl-host')?.shadowRoot; return root && !root.getElementById('btnScan').disabled; });
    await course.locator('#buct-tab-dl-host').getByRole('button', { name: '全选可见', exact: true }).click();
    await course.locator('#buct-tab-dl-host [data-tab="unit"]').click();
    await course.locator('#buct-tab-dl-host').getByRole('button', { name: '全选可见', exact: true }).click();
    const downloadPromise = course.waitForEvent('download');
    await course.locator('#buct-tab-dl-host #btnDl').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), '浏览器验收课程.zip');
    const zipPath = join(artifacts, 'fixture-course.zip');
    await download.saveAs(zipPath);
    const entries = unzipSync(await readFile(zipPath));
    const names = Object.keys(entries);
    for (const [name, bytes] of Object.entries(entries)) assert.deepEqual(Buffer.from(bytes), fixtureBytes(name.endsWith('课件2.pdf') ? 'sample-alt.pdf' : 'sample.pdf'), 'ZIP entries must preserve each selected original');
    assert.deepEqual(names.sort(), ['单元学习/第一单元/课件3.pdf', '课程资源/第二讲/课件2.pdf', '课程资源/课件1.pdf'].sort());
    await course.screenshot({ path: join(artifacts, 'bookmarklet.png'), fullPage: true });
    await course.setViewportSize({ width: 390, height: 844 });
    assert.ok(await course.evaluate(() => { const host = document.getElementById('buct-tab-dl-host'); const rect = host.shadowRoot.querySelector('.dialog').getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1; }), 'bookmarklet must stay in the viewport');
    assert.ok(await course.locator('#buct-tab-dl-host h1').evaluate(element => element.getBoundingClientRect().height < 32), 'bookmarklet title must stay on one line');
    assert.ok(await course.locator('#buct-tab-dl-host #btnDl').evaluate(element => element.getBoundingClientRect().height < 48), 'action labels must not wrap vertically');
    await course.screenshot({ path: join(artifacts, 'bookmarklet-390.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await cleanupProfile(profile);
  }
});
