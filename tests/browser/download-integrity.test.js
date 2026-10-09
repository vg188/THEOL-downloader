import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { unzipSync, zipSync } from 'fflate';
import { buildSite } from '../../web/build.mjs';
import { uniqueArchivePath } from '../../src/runtime/policy.js';
import { buildReleaseExtension } from '../../scripts/build-release.mjs';
import { inspectFileContent } from '../../src/runtime/file-content.js';
import { ROOT, file, fixtureBytes, listHTML, previewHTML } from '../release/helpers.js';
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const artifacts = join(ROOT, 'output', 'playwright', 'download-integrity');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = { pdf: 'application/pdf', doc: 'application/msword', ppt: 'application/vnd.ms-powerpoint', xls: 'application/vnd.ms-excel', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', png: 'image/png', jpg: 'image/jpeg' };
function fixture(id, ext, extra = {}) {
  const f = file(id, { name: '中文  原文件 + α.' + ext.toUpperCase(), ext });
  f.downloadUrl = f.downloadUrl.replace('https:', 'http:'); f.previewUrl = f.previewUrl.replace('https:', 'http:');
  return { file: f, bytes: fixtureBytes('sample.' + ext), mime: mime[ext], ...extra };
}
async function waitForJobs(page, predicate) {
  const deadline = Date.now() + 60000; let jobs = [];
  while (Date.now() < deadline) {
    jobs = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_JOBS' })).jobs || []);
    if (predicate(jobs)) return jobs;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Download queue did not settle: ' + JSON.stringify(jobs));
}
async function cleanupProfile(profile) {
  const base = await realpath(artifacts), target = await realpath(profile), rel = relative(base, target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'only remove the test profile under its artifact directory');
  await rm(target, { recursive: true, force: true });
}

test('native Chrome downloads: real disk paths, file types, exact hashes, duplicates and failed representations', { timeout: 120000 }, async () => {
  assert.ok(chrome, 'Install Chrome or set CHROME_PATH');
  const cases = ['ppt', 'pdf', 'docx', 'pptx', 'xlsx', 'doc', 'xls', 'png', 'jpg'].map((ext, i) => fixture(i + 1, ext));
  const reserved = fixture(10, 'pdf'); reserved.file.name = 'CON.PDF'; cases.push(reserved);
  const duplicate = fixture(11, 'pdf', { bytes: fixtureBytes('sample-alt.pdf') }); duplicate.file.name = cases[1].file.name; cases.push(duplicate);
  const longName = fixture(12, 'docx'); longName.file.name = '长文件名_😀' + '课程讲义'.repeat(45) + '.DOCX'; cases.push(longName);
  cases.push({ file: { ...file(13), name: '原站空压缩包.zip', ext: 'zip', downloadUrl: file(13).downloadUrl.replace('https:', 'http:'), previewUrl: file(13).previewUrl.replace('https:', 'http:') }, bytes: zipSync({}), mime: 'application/zip' });
  cases.push(fixture(91, 'pdf', { badName: '另一个原文件.pdf', failure: 'FILENAME_MISMATCH' }));
  cases.push(fixture(92, 'pptx', { bytes: fixtureBytes('sample.docx'), mime: 'application/octet-stream', failure: 'BAD_FILE' }));
  cases.push(fixture(93, 'pdf', { changed: true, failure: 'any' }));
  cases.push(fixture(94, 'pdf', { truncated: true, failure: 'any' }));
  cases.push(fixture(95, 'pdf', { login: true, failure: 'BAD_FILE' }));
  const byId = new Map(cases.map(c => [c.file.fileid, c])), requests = [];
  let active = 0, maxActive = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://course.buct.edu.cn'), id = url.searchParams.get('fileid'), entry = byId.get(id);
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url.pathname.endsWith('/listview.jsp')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(listHTML(cases.map(c => c.file)).replace('测试课程', '原文件验收课程')); return; }
    if (url.pathname.endsWith('/preview/download_preview.jsp') && entry) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(previewHTML(entry.file).replace('(12K)', '(' + entry.bytes.length + 'B)')); return; }
    if (!url.pathname.endsWith('/download.jsp') || !entry) { res.writeHead(404); res.end(); return; }
    const probe = req.headers.range === 'bytes=0-65535';
    requests.push({ id, probe, range: req.headers.range || '', ifMatch: req.headers['if-match'] || '' });
    if (entry.login) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>登录</title><input type="password"></html>'); return; }
    if (!probe && entry.changed) { res.writeHead(412, { 'content-type': 'text/plain' }); res.end('Representation changed'); return; }
    const headers = { 'content-type': entry.mime, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(entry.badName || entry.file.name), etag: '"fixture-' + id + '"', 'accept-ranges': 'bytes' };
    if (probe) {
      const bytes = entry.bytes.subarray(0, 65536);
      res.writeHead(206, { ...headers, 'content-range': 'bytes 0-' + (bytes.length - 1) + '/' + entry.bytes.length, 'content-length': bytes.length }); res.end(bytes); return;
    }
    active++; maxActive = Math.max(maxActive, active); let counted = true;
    const finish = () => { if (counted) { active--; counted = false; } };
    res.once('close', finish); res.once('finish', finish);
    res.writeHead(200, { ...headers, 'content-length': entry.bytes.length });
    if (entry.truncated) { res.write(entry.bytes.subarray(0, 100)); setTimeout(() => res.destroy(), 80); return; }
    let at = 0;
    const send = () => {
      if (res.destroyed) return;
      const next = Math.min(at + 4096, entry.bytes.length); res.write(entry.bytes.subarray(at, next)); at = next;
      if (at === entry.bytes.length) res.end(); else setTimeout(send, 35);
    };
    setTimeout(send, 60);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await mkdir(artifacts, { recursive: true });
  const profile = await mkdtemp(join(artifacts, 'profile-')), downloadsDir = await mkdtemp(join(artifacts, 'files-'));
  await mkdir(join(profile, 'Default'));
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  const managedDownloads = await mkdtemp(join(artifacts, 'browser-managed-'));
  const extension = await buildReleaseExtension({ output: join(ROOT, 'dist', 'test-native-downloads', 'extension') });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: chrome, headless: true, viewport: { width: 1280, height: 950 }, acceptDownloads: true, downloadsPath: managedDownloads, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--enable-automation', '--no-proxy-server', '--host-resolver-rules=MAP course.buct.edu.cn 127.0.0.1:' + port, '--disable-features=HttpsUpgrades'] });
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const course = context.pages()[0]; await course.goto('http://course.buct.edu.cn/meol/common/script/listview.jsp?folderid=0&lid=42');
    const errors = [], panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
    await panel.goto('chrome-extension://' + id + '/panel.html');
    await panel.waitForFunction(count => document.querySelectorAll('input[data-kind="file"]').length === count && !document.querySelector('#btnRescan').disabled, cases.length);
    await panel.locator('#btnSelectVisible').click(); await panel.locator('#btnDownload').click();
    await waitForJobs(panel, jobs => jobs.some(job => job.status === 'downloading'));
    const alarm = await panel.evaluate(() => chrome.alarms.get('courseResourceReconcileV2'));
    assert.equal(alarm.periodInMinutes, 0.5);
    // Closing the UI must not cancel or duplicate background transfers.
    await panel.close();
    const targets = await cdp.send('Target.getTargets');
    const worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://' + id + '/'));
    assert.ok(worker, 'the download worker must be running');
    assert.equal((await cdp.send('Target.closeTarget', { targetId: worker.targetId })).success, true);
    const reopened = await context.newPage(); await reopened.goto('chrome-extension://' + id + '/panel.html');
    const jobs = await waitForJobs(reopened, jobs => jobs.length === cases.length && jobs.every(job => ['done', 'failed', 'cancelled'].includes(job.status)));
    assert.equal(await reopened.evaluate(() => chrome.alarms.get('courseResourceReconcileV2')), undefined, 'completed queues remove periodic wakeups');
    const emptyJob = jobs.find(job => job.file.fileid === '13');
    assert.ok(emptyJob.preflight.warnings.some(warning => warning.code === 'EMPTY_SOURCE_ZIP'));
    await reopened.waitForFunction(() => [...document.querySelectorAll('.job-warning:not(.hidden)')].some(el => el.textContent.includes('原 ZIP 为空')));
    await writeFile(join(artifacts, 'native-debug.json'), JSON.stringify({ jobs, requests, maxActive }, null, 2));
    const report = [];
    for (const entry of cases) {
      const job = jobs.find(job => job.file.id === entry.file.id); assert.ok(job);
      if (entry.failure) {
        assert.equal(job.status, 'failed', JSON.stringify(job));
        if (entry.failure !== 'any') assert.equal(job.errorCode, entry.failure);
        if (!entry.changed && !entry.truncated) assert.equal(requests.some(r => r.id === entry.file.fileid && !r.probe), false, 'failed preflight must not launch a native request');
        report.push({ name: entry.file.name, status: job.status, error: job.errorCode }); continue;
      }
      assert.equal(job.status, 'done', JSON.stringify(job)); assert.ok(job.actualFilename);
      const target = await realpath(job.actualFilename), root = await realpath(downloadsDir), rel = relative(root, target);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'native file stays in the configured test downloads directory');
      const saved = await readFile(target); assert.equal(hash(saved), hash(entry.bytes), entry.file.name);
      assert.equal(inspectFileContent(saved, entry.file).format, entry.file.ext);
      assert.equal(job.fileSize, saved.length);
      assert.equal(requests.filter(r => r.id === entry.file.fileid && !r.probe).length, 1, 'worker recovery must not start a duplicate native transfer');
      const transfer = requests.find(r => r.id === entry.file.fileid && !r.probe); assert.equal(transfer.ifMatch, '"fixture-' + entry.file.fileid + '"');
      report.push({ name: entry.file.name, saved: target, bytes: saved.length, sha256: hash(saved), status: job.status, format: entry.file.ext });
    }
    assert.notEqual(jobs.find(j => j.file.fileid === '2').actualFilename, jobs.find(j => j.file.fileid === '11').actualFilename, 'same-name files must not overwrite each other');
    assert.ok(maxActive <= 2, 'at most two actual native transfers: ' + maxActive);
    assert.ok(await reopened.locator('.job-path').first().isVisible());
    assert.match(await reopened.locator('.jobs-note').textContent(), /不逐字节/);
    await reopened.screenshot({ path: join(artifacts, 'native-downloads.png'), fullPage: true });
    await reopened.locator('.jobs-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await reopened.screenshot({ path: join(artifacts, 'native-failures.png'), fullPage: true });
    await reopened.setViewportSize({ width: 480, height: 950 });
    assert.ok(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await reopened.screenshot({ path: join(artifacts, 'native-downloads-480.png'), fullPage: true });
    await writeFile(join(artifacts, 'native-report.json'), JSON.stringify({ chrome: context.browser().version(), maxParallelTransfers: maxActive, workerRestartRecovered: true, report }, null, 2));
    // All bookmarklet native requests must hit this same loopback server. Page
    // route mocks alone do not intercept Chrome's native download manager.
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: managedDownloads, eventsEnabled: true });
    const site = await buildSite({ output: join(ROOT, 'dist', 'test-native-downloads', 'site') });
    const bookmark = await readFile(join(site, 'bookmarklet.txt'), 'utf8');
    course.on('dialog', dialog => dialog.accept());
    await course.bringToFront();
    await course.evaluate(href => { const link = document.createElement('a'); link.href = href; document.body.appendChild(link); link.click(); link.remove(); }, bookmark);
    await course.locator('#buct-tab-dl-host').waitFor();
    await course.waitForFunction(() => !document.getElementById('buct-tab-dl-host').shadowRoot.getElementById('btnScan').disabled);
    const zipped = cases.slice(0, 3);
    for (const entry of zipped) await course.locator('#buct-tab-dl-host input[data-kind="file"][data-id="' + entry.file.id + '"]').check();
    const zipEvent = course.waitForEvent('download');
    await course.locator('#buct-tab-dl-host #btnDl').click();
    const zipDownload = await zipEvent;
    assert.equal(zipDownload.suggestedFilename(), '原文件验收课程.zip');
    const archivePath = join(artifacts, 'bookmarklet-originals.zip'); await zipDownload.saveAs(archivePath);
    const entries = unzipSync(await readFile(archivePath)), used = new Set();
    for (const entry of zipped) assert.equal(hash(entries[uniqueArchivePath(entry.file, used)]), hash(entry.bytes));
    assert.equal(Object.keys(entries).length, zipped.length);
    await course.locator('#buct-tab-dl-host #btnSettings').click();
    await course.locator('#buct-tab-dl-host #setZipMode').selectOption('never');
    await course.locator('#buct-tab-dl-host #setSave').click();
    await course.locator('#buct-tab-dl-host #btnClr').click();
    const batched = [cases[0], cases[2]]; // A large native PPT + a small verified Blob DOCX.
    for (const entry of batched) await course.locator('#buct-tab-dl-host input[data-kind="file"][data-id="' + entry.file.id + '"]').check();
    const batchDownloads = [], beforeBatch = requests.length; course.on('download', download => batchDownloads.push(download));
    await course.locator('#buct-tab-dl-host #btnDl').click();
    await course.waitForFunction(() => document.getElementById('buct-tab-dl-host').shadowRoot.getElementById('statusText').textContent.includes('已触发 2 个下载'));
    const deadline = Date.now() + 10000;
    while (batchDownloads.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(batchDownloads.length, 2);
    for (const download of batchDownloads) {
      const entry = batched.find(entry => entry.file.name === download.suggestedFilename()); assert.ok(entry, download.suggestedFilename());
      const target = join(artifacts, 'batch-' + download.suggestedFilename()); await download.saveAs(target);
      assert.equal(hash(await readFile(target)), hash(entry.bytes));
    }
    assert.equal(requests.slice(beforeBatch).filter(r => r.id === cases[2].file.fileid).length, 1, 'small files reuse one fully validated response');
    assert.equal(requests.slice(beforeBatch).filter(r => r.id === cases[0].file.fileid).length, 2, 'large native downloads are honestly preceded by a separate partial probe');
    await course.screenshot({ path: join(artifacts, 'bookmarklet-downloads.png'), fullPage: true });
    await writeFile(join(artifacts, 'bookmarklet-report.json'), JSON.stringify({ zip: zipped.map(entry => ({ name: entry.file.name, sha256: hash(entry.bytes) })), batch: batched.map(entry => ({ name: entry.file.name, sha256: hash(entry.bytes) })), smallFileResponseReused: true }, null, 2));
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await cleanupProfile(profile);
  }
});
