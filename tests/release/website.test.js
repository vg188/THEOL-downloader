import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { unzipSync } from 'fflate';
import { buildSite, SITE_ASSETS } from '../../web/build.mjs';
import { packageReleaseExtension, PACKAGE_NAME } from '../../scripts/package-release.mjs';
import { RELEASE_ASSETS } from '../../scripts/release-extension.mjs';
import { RELEASE_VERSION } from '../../src/runtime/version.js';
import { ROOT, waitFor } from './helpers.js';
const output = join(ROOT, 'dist', 'test-website-' + randomUUID());
let directory, html, script, release;
before(async () => {
  directory = await buildSite({ output, stamp: '2026-10-09' });
  html = await readFile(join(directory, 'index.html'), 'utf8');
  script = await readFile(join(directory, 'site.js'), 'utf8');
  release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
});
function documentFor(t, clipboard) {
  const dom = new JSDOM(html, { url: 'https://vg188.github.io/THEOL-downloader/', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: clipboard });
  dom.window.document.execCommand = () => false;
  dom.window.fetch = () => { throw new Error('The installation page must not fetch anything'); };
  dom.window.eval(script);
  return { win: dom.window, doc: dom.window.document };
}

test('current website includes matching local extension package, bookmarklet, release metadata and legal assets', async t => {
  const { doc, win } = documentFor(t);
  assert.equal(release.version, RELEASE_VERSION);
  assert.equal(release.bookmarklet.version, RELEASE_VERSION);
  assert.equal(doc.querySelector('#extension-download').getAttribute('href'), release.extension.file);
  assert.ok(doc.querySelector('#extension-download').hasAttribute('download'));
  const bytes = await readFile(join(directory, release.extension.file));
  assert.equal(bytes.length, release.extension.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), release.extension.sha256);
  const entries = unzipSync(bytes);
  assert.deepEqual(Object.keys(entries).sort(), [...RELEASE_ASSETS].sort());
  assert.equal(JSON.parse(new TextDecoder().decode(entries['manifest.json'])).version, RELEASE_VERSION);
  assert.equal(doc.querySelector('#bookmarklet-install').getAttribute('href'), win.__BOOKMARKLET__.href);
  assert.match(doc.querySelector('#bookmarklet-stamp').textContent, new RegExp(RELEASE_VERSION.replaceAll('.', '\\.')));
  assert.doesNotMatch(html, /\{\{(?:VERSION|PACKAGE_SIZE|BUILD_DATE)\}\}/);
  for (const asset of [...SITE_ASSETS, 'privacy.html', 'THIRD_PARTY_NOTICES.md', 'bookmarklet.js', 'bookmarklet.txt']) assert.ok((await readFile(join(directory, asset))).length);
});
test('same extension inputs always produce the same package hash and bytes', async () => {
  const a = await packageReleaseExtension(output + '-extension'), b = await packageReleaseExtension(output + '-extension');
  assert.equal(a.sha256, b.sha256); assert.deepEqual(a.bytes, b.bytes);
  assert.deepEqual(Buffer.from(a.bytes), await readFile(join(directory, 'downloads', PACKAGE_NAME)));
});
test('website preserves navigation anchors, one main heading and no external active assets', t => {
  const { doc } = documentFor(t);
  assert.equal(doc.querySelectorAll('h1').length, 1);
  assert.equal(doc.querySelector('link[rel="canonical"]').href, 'https://h.yourba.top/THEOL-downloader/');
  for (const id of ['main', 'install', 'features', 'download', 'faq']) assert.ok(doc.getElementById(id));
  assert.ok(doc.querySelector('a.skip-link[href="#main"]'));
  for (const link of doc.querySelectorAll('a[href^="#"]')) assert.ok(doc.querySelector(link.getAttribute('href')), 'missing anchor ' + link.getAttribute('href'));
  for (const node of doc.querySelectorAll('script[src],img[src],link[rel="stylesheet"]')) assert.doesNotMatch(node.getAttribute('src') || node.getAttribute('href'), /^(?:https?:)?\/\//);
  for (const image of doc.images) assert.ok(image.hasAttribute('alt'));
  assert.match(doc.body.textContent, /非学校官方/); assert.match(doc.body.textContent, /仅下载你有权访问/);
  assert.match(doc.body.textContent, /200 MB \/ 120/); assert.match(doc.body.textContent, /优先保留原文件/);
  assert.doesNotMatch(doc.body.textContent, /[—]|商店已上架|所有课件都能/);
});
test('homepage omits redundant context and release explanations while keeping the feature link useful', t => {
  const { doc } = documentFor(t);
  assert.equal(doc.querySelector('.context-strip, .features-section, .priority-list'), null);
  assert.doesNotMatch(doc.body.textContent, /同学做的小工具|在你的浏览器本地运行|能拿整份文件|就不一张张拼图|看看新版能做什么/);
  assert.deepEqual([...doc.querySelector('main').children].filter(node => node.tagName === 'SECTION').map(node => node.id || 'hero'), ['hero', 'install', 'features', 'download', 'faq']);
  const features = doc.getElementById('features');
  assert.ok(features.classList.contains('workflow-section'));
  assert.equal(features.getAttribute('aria-labelledby'), 'workflow-title');
  assert.equal(doc.querySelector('.hero-actions a[href="#features"]').textContent, '查看功能');
});
test('bookmarks are draggable without running on the installation page', t => {
  const { doc, win } = documentFor(t);
  let alerts = 0; win.alert = () => alerts++;
  const install = doc.querySelector('#bookmarklet-install');
  assert.equal(install.draggable, true); install.click();
  assert.equal(alerts, 0); assert.match(doc.querySelector('#copy-status').textContent, /拖到书签栏/);
  assert.equal(doc.querySelector('#manual-code').hidden, true);
});
test('copy button writes the exact current bookmark payload and announces success', async t => {
  const copied = [], { doc, win } = documentFor(t, { writeText: async value => copied.push(value) });
  doc.querySelector('#copy-bookmarklet').click();
  await waitFor(() => !doc.querySelector('#copy-bookmarklet').disabled);
  assert.deepEqual(copied, [win.__BOOKMARKLET__.href]);
  assert.match(doc.querySelector('#copy-status').textContent, /已复制/);
});
test('clipboard denial and unavailable legacy copy expose selected full code instead of false success', async t => {
  const { doc, win } = documentFor(t, { writeText: async () => { throw new Error('NotAllowedError'); } });
  doc.querySelector('#copy-bookmarklet').click(); await waitFor(() => !doc.querySelector('#copy-bookmarklet').disabled);
  const details = doc.querySelector('#manual-code'), field = doc.querySelector('#bookmarklet-code');
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  assert.equal(field.value, win.__BOOKMARKLET__.href); assert.equal(field.selectionEnd, field.value.length);
  assert.equal(doc.activeElement, field); assert.match(doc.querySelector('#copy-status').textContent, /手动复制/);
  assert.doesNotMatch(doc.querySelector('#copy-status').textContent, /已复制/);
});
test('extension manager copy has its own success and error status', async t => {
  const copied = [], { doc } = documentFor(t, { writeText: async value => copied.push(value) });
  doc.querySelector('#copy-extensions-url').click(); await waitFor(() => !doc.querySelector('#copy-extensions-url').disabled);
  assert.deepEqual(copied, ['chrome://extensions']); assert.match(doc.querySelector('#extension-copy-status').textContent, /地址已复制/);
  assert.equal(doc.querySelector('#copy-status').textContent, '');
});
test('privacy stays navigable and versioned without running site JavaScript', async () => {
  const text = await readFile(join(directory, 'privacy.html'), 'utf8'), dom = new JSDOM(text);
  try {
    const doc = dom.window.document; assert.equal(doc.querySelectorAll('h1').length, 1);
    assert.equal(doc.querySelectorAll('script').length, 0);
    assert.equal(doc.querySelector('link[rel="canonical"]').href, 'https://h.yourba.top/THEOL-downloader/privacy.html');
    for (const id of ['main', 'collection', 'working', 'storage', 'boundaries', 'source']) assert.ok(doc.getElementById(id));
    assert.match(text, /localStorage/); assert.match(text, /Chrome 存储/); assert.match(text, /不上传课件/);
    assert.match(text, new RegExp('v' + RELEASE_VERSION.replaceAll('.', '\\.'))); assert.doesNotMatch(text, /\{\{/);
  } finally { dom.window.close(); }
});
test('packaging only publishes explicit assets, never browser profiles, captured courses or source maps', async () => {
  const entries = await readdir(directory);
  assert.deepEqual(entries.sort(), ['THIRD_PARTY_NOTICES.md', 'assets', 'bookmarklet.js', 'bookmarklet.txt', 'downloads', 'index.html', 'privacy.html', 'release.json', 'site.css', 'site.js'].sort());
  assert.deepEqual(await readdir(join(directory, 'downloads')), [PACKAGE_NAME]);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|document\.cookie/);
  assert.doesNotMatch(await readFile(join(directory, 'site.css'), 'utf8'), /@import|https?:/);
});
