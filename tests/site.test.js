import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildBookmarkletBundle, assertSafeArtifact, assertSingleReleaseVersion, bookmarkletBuildStamp, buildSite, readSiteConfig, renderIndexPage } from '../scripts/build-site.mjs';
import { BOOKMARKLET_VERSION } from '../src/bookmarklet/version.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const siteRoot = join(projectRoot, 'site');
const config = readSiteConfig(await readFile(join(siteRoot, 'config.json'), 'utf8'));
const output = await buildSite();
const indexHtml = await readFile(join(output, 'index.html'), 'utf8');
const privacyHtml = await readFile(join(output, 'privacy.html'), 'utf8');
const indexDoc = new JSDOM(indexHtml).window.document;
const privacyDoc = new JSDOM(privacyHtml).window.document;
const install = indexDoc.querySelector('#bookmarklet-install');
const payload = install.getAttribute('href').replace(/^javascript:/, '');

test('buildSite 只发布两个页面与本地资源，产物通过安全检查', async (t) => {
  assert.equal(output, join(projectRoot, 'dist', 'site'));
  const files = await assertSafeArtifact(output);
  assert.deepEqual([...files].sort(), ['index.html', 'privacy.html', 'site.css', 'site.js']);
  t.diagnostic(`书签 payload 长度：${payload.length} 字符`);
});

test('页面是中文站点，首屏给出产品、两个安装卡片与 GitHub 链接', () => {
  assert.equal(indexDoc.documentElement.lang, 'zh-CN');
  assert.match(indexDoc.title, /THEOL/);
  assert.equal(indexDoc.querySelectorAll('h1').length, 1);
  assert.equal(indexDoc.querySelectorAll('#install .card').length, 2);
  assert.match(indexDoc.querySelector('#install').textContent, /书签轻量版/);
  assert.match(indexDoc.querySelector('#install').textContent, /完整版/);
  assert.ok(indexDoc.querySelector('a[href*="github.com/vg188/THEOL-downloader"]'));
  assert.equal(indexDoc.querySelector('#privacy a[href$="privacy.html"]').getAttribute('href'), `${config.basePath}privacy.html`);
});

test('可拖拽书签是真实链接，href 就是完整的自包含 bundle', async () => {
  assert.equal(install.tagName, 'A');
  assert.equal(install.getAttribute('draggable'), 'true');
  assert.match(install.getAttribute('href'), /^javascript:/);
  assert.match(payload, /^\(\(\)=>\{/);
  assert.ok(payload.length > 20000, `payload 太小，可能没有带上运行时：${payload.length}`);
  // The anchor carries exactly the esbuild IIFE, character for character.
  const bundle = await buildBookmarkletBundle();
  assert.equal(install.getAttribute('href'), `javascript:${bundle}`);
  assert.ok(payload.includes('__THEOL_DOWNLOADER_BOOKMARKLET_V1__'));
  assert.match(install.textContent, /拖到书签栏/);
});

test('书签自带版本与构建日期，旧书签能被认出来', () => {
  assert.match(payload, /1\.0\.1/, 'bundle carries the release version');
  // Stamped at build time, so the same release built twice is still distinguishable.
  assert.match(payload, new RegExp(bookmarkletBuildStamp()), 'bundle carries a build date');
  assert.match(bookmarkletBuildStamp(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('页面显示的书签版本就是书签自带的版本', () => {
  const shown = indexDoc.querySelector('#bookmarklet-stamp').textContent.trim();
  assert.equal(shown, `v${BOOKMARKLET_VERSION} (${bookmarkletBuildStamp()})`);
  assert.equal(indexDoc.querySelector('.site-footer').textContent.includes(shown), true, '页脚与安装卡片同一行');
  assert.equal(privacyDoc.querySelector('.site-footer').textContent.includes(shown), true, '隐私页同一行');
  // The one date both sides use: the page cannot advertise a build the anchor lacks.
  for (const part of [BOOKMARKLET_VERSION, bookmarkletBuildStamp()]) {
    assert.ok(payload.includes(part), `书签里没有带上页面显示的 ${part}`);
  }
});

test('四处版本号不一致时拒绝构建，一致时返回该版本', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'site-version-'));
  try {
    await mkdir(join(scratch, 'public'), { recursive: true });
    const written = async version => {
      await writeFile(join(scratch, 'package.json'), JSON.stringify({ version }), 'utf8');
      await writeFile(join(scratch, 'public', 'manifest.json'), JSON.stringify({ version }), 'utf8');
    };
    await written(BOOKMARKLET_VERSION);
    assert.equal(await assertSingleReleaseVersion({ projectRoot: scratch, config }), BOOKMARKLET_VERSION);
    await written('9.9.9');
    await assert.rejects(
      () => assertSingleReleaseVersion({ projectRoot: scratch, config }),
      /版本号不一致.*package\.json=9\.9\.9.*site\/config\.json/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('书签自带诊断入口，方便在真实页面上排查', () => {
  // `diagnose` is mounted on the panel global; it must survive minification as a
  // property name, otherwise there is no way to debug a real page.
  assert.ok(payload.includes('diagnose'), 'bundle exposes the diagnostics handle');
  assert.ok(payload.includes('AMBIGUOUS_DIRECTORY'), 'bundle keeps the reason codes');
  assert.ok(payload.includes('NO_DIRECTORY'));
});

test('书签 payload 不加载任何远程运行时', () => {
  assert.doesNotMatch(payload, /createElement\(["']script["']\)/);
  assert.doesNotMatch(payload, /sourceMappingURL/);
  assert.doesNotMatch(payload, /new Worker/);
  assert.doesNotMatch(payload, /\.src\s*=/);
  assert.doesNotMatch(payload, /import\s*\(/);
  assert.doesNotMatch(payload, /bookmarklet\/v\d/);
  const urls = payload.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  assert.deepEqual([...new Set(urls)], ['https://course.buct.edu.cn']);
  for (const url of urls) assert.ok(new URL(url).origin === 'https://course.buct.edu.cn');
});

test('模板里的任意 payload 都能完整落到 anchor 上（转义与 $ 序列不破坏代码）', () => {
  const template = '<a id="bookmarklet-install" href="{{bookmarkletHref}}">x</a>';
  const awkward = ['javascript:alert("a&b<c>d")', '$&', '$`', "$'", '$$', '${x}'].join('|');
  const html = renderIndexPage({ template, config, bookmarklet: awkward });
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('#bookmarklet-install').getAttribute('href'), awkward);
});

test('商店未通过审核时，插件版卡片直接给出本仓库的包与手动加载步骤', async () => {
  assert.equal(config.chromeWebStoreUrl, null);
  const control = indexDoc.querySelector('#chrome-install');
  assert.equal(control.tagName, 'A', 'a visitor can actually get the extension');
  assert.notEqual(control.getAttribute('aria-disabled'), 'true');
  assert.match(control.textContent, /下载 ZIP/);
  assert.equal(
    control.getAttribute('href'),
    `${config.repoUrl}/releases/download/v${config.releaseVersion}/buct-course-downloader.zip`,
  );
  const card = control.closest('.card');
  for (const step of ['开发者模式', '加载已解压的扩展程序', 'manifest.json']) {
    assert.ok(card.textContent.includes(step), `卡片缺少手动安装步骤：${step}`);
  }
  assert.match(card.textContent, /不会自动更新/, 'reinstalling is stated, not hidden');
  assert.equal(indexDoc.body.textContent.includes('Chrome 商店审核中'), false, 'no dead control is advertised');
  // The package name in the link is the one the packager writes.
  const packager = await readFile(join(projectRoot, 'scripts', 'package.py'), 'utf8');
  assert.ok(packager.includes('buct-course-downloader.zip'), 'packager renamed without the site');
});

test('对比表与卡片说的是同一种安装方式', () => {
  const row = indexDoc.querySelector('#compare table tbody tr').textContent;
  assert.match(row, /下载 ZIP/);
  assert.equal(row.includes('Chrome 应用商店'), false, 'the table cannot promise a store that is not live');
});

test('页面里的仓库链接与下载地址同源一个仓库', () => {
  const hrefs = [...indexDoc.querySelectorAll('a[href^="https://github.com"]'), ...privacyDoc.querySelectorAll('a[href^="https://github.com"]')]
    .map(node => node.getAttribute('href'));
  assert.ok(hrefs.length >= 6, `页面上的仓库链接太少：${hrefs.length}`);
  for (const href of hrefs) {
    assert.ok(href.startsWith(`${config.repoUrl}/`) || href === config.repoUrl, `${href} 指向了别的仓库`);
  }
});

test('配置了合法商店链接时完整版卡片变为“添加至 Chrome”', () => {
  const storeUrl = 'https://chromewebstore.google.com/detail/theol-downloader/abcdefghijklmnopabcdefghijklmnop';
  const template = '<a id="bookmarklet-install" href="{{bookmarkletHref}}">x</a><p class="actions">{{chromeInstall}}</p>{{chromeInstallHint}}<table><tbody><tr><th scope="row">安装方式</th><td>{{chromeInstallSummary}}</td></tr></tbody></table>';
  const html = renderIndexPage({ template, config: { ...config, chromeWebStoreUrl: storeUrl }, bookmarklet: 'javascript:void 0', build: '2026-01-02' });
  const doc = new JSDOM(html).window.document;
  const control = doc.querySelector('#chrome-install');
  assert.equal(control.getAttribute('href'), storeUrl);
  assert.match(control.textContent, /添加至 Chrome/);
  assert.equal(control.getAttribute('rel'), 'noopener noreferrer');
  assert.match(doc.querySelector('.hint').textContent, /静默安装/);
  assert.match(doc.querySelector('td').textContent, /Chrome 应用商店/);
});

test('非法商店链接与非法的 basePath 会被拒绝，配置不会被改写', async () => {
  const base = { ...config, chromeWebStoreUrl: null };
  assert.throws(() => readSiteConfig({ ...base, chromeWebStoreUrl: 'http://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop' }), /chromeWebStoreUrl/);
  assert.throws(() => readSiteConfig({ ...base, chromeWebStoreUrl: 'https://chromewebstore.google.com/detail/x/too-short' }), /chromeWebStoreUrl/);
  assert.throws(() => readSiteConfig({ ...base, chromeWebStoreUrl: 'https://chromewebstore.google.com/detail/x/ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP' }), /chromeWebStoreUrl/);
  assert.throws(() => readSiteConfig({ ...base, chromeWebStoreUrl: 'https://evil.example.com/detail/x/abcdefghijklmnopabcdefghijklmnop' }), /chromeWebStoreUrl/);
  assert.throws(() => readSiteConfig({ ...base, basePath: 'THEOL-downloader/' }), /basePath/);
  assert.throws(() => readSiteConfig({ ...base, releaseVersion: 'v1' }), /releaseVersion/);
  assert.throws(() => readSiteConfig({ ...base, repository: 'https://github.com/vg188/THEOL-downloader' }), /repository/);
  assert.throws(() => readSiteConfig({ ...base, repository: '' }), /repository/);
  const onDisk = JSON.parse(await readFile(join(siteRoot, 'config.json'), 'utf8'));
  assert.equal(onDisk.chromeWebStoreUrl, null);
  assert.deepEqual(Object.keys(onDisk).sort(), ['basePath', 'chromeWebStoreUrl', 'releaseVersion', 'repository']);
});

test('站点文案说明 500 MB 规则、二次确认、保持页面打开与“已触发 ≠ 已完成”', () => {
  const text = indexDoc.body.textContent;
  for (const phrase of [
    '500 MB', '大小未知', '二次确认', '确认后才会真正触发下载',
    '不要刷新或关闭页面', '不上传', '非官方', '已触发', '已完成',
    '允许此网站下载多个文件',
  ]) {
    assert.ok(text.includes(phrase), `页面缺少文案：${phrase}`);
  }
  assert.match(indexDoc.querySelector('#compare table').textContent, /ZIP/);
  assert.match(indexDoc.querySelector('#compare table').textContent, /后台队列/);
  assert.match(indexDoc.querySelector('#compare table').textContent, /下载记录/);
});

test('页面同时说明两个入口和三种扫描范围', () => {
  const text = indexDoc.body.textContent;
  // The product reads 课程资源 folders as well as 单元学习 units; a page that
  // names only one of them teaches visitors that the other one does not work.
  for (const phrase of ['课程资源', '单元学习', '扫描当前目录', '扫描当前单元', '扫描全部单元']) {
    assert.ok(text.includes(phrase), `页面缺少入口/范围说明：${phrase}`);
  }
  assert.ok(text.includes('课程资源当前目录'), '对比表要同时点到两处入口');
  assert.match(privacyDoc.body.textContent, /课件目录或单元/);
});

test('页面结构齐全：对比表、三步安装、500 MB 规则、隐私、FAQ、页脚', () => {
  assert.equal(indexDoc.querySelectorAll('#compare table tbody tr').length, 7);
  assert.equal(indexDoc.querySelectorAll('#steps ol li').length, 3);
  assert.ok(indexDoc.querySelectorAll('#rules article').length >= 6);
  assert.ok(indexDoc.querySelectorAll('#privacy .checklist li').length >= 4);
  assert.ok(indexDoc.querySelectorAll('#faq details').length >= 6);
  assert.match(indexDoc.querySelector('.site-footer').textContent, /非北京化工大学官方产品/);
  assert.match(indexDoc.querySelector('.site-footer').textContent, new RegExp(config.releaseVersion));
  assert.match(indexDoc.querySelector('.touch-only').textContent, /桌面浏览器/);
  assert.ok(indexDoc.querySelector('noscript'));
});

test('没有 JavaScript 时内容仍然完整可读', () => {
  // jsdom runs nothing here, so every asserted string must live in the markup.
  const readable = new JSDOM(indexHtml).window.document;
  assert.ok(readable.body.textContent.length > 3000);
  assert.deepEqual(
    [...readable.querySelectorAll('#steps ol li')].map(li => li.textContent.length > 20),
    [true, true, true],
  );
  assert.match(readable.querySelector('#copy-bookmarklet').textContent, /复制书签代码/);
  assert.match(readable.querySelector('#faq').textContent, /加载已解压的扩展程序/);
});

test('所有本地资源 URL 都遵循 basePath', () => {
  for (const [name, doc] of [['index.html', indexDoc], ['privacy.html', privacyDoc]]) {
    const urls = [];
    for (const node of doc.querySelectorAll('link[href], script[src], a[href]')) {
      urls.push(node.getAttribute('href') ?? node.getAttribute('src'));
    }
    assert.ok(urls.length >= 4, `${name} 的本地资源太少`);
    for (const url of urls) {
      if (/^(?:https?:|#|javascript:|mailto:)/.test(url)) continue;
      assert.ok(url.startsWith(config.basePath), `${name} 的本地链接没有带上 basePath：${url}`);
    }
    assert.ok([...doc.querySelectorAll('link[href]')].some(node => node.getAttribute('href') === `${config.basePath}site.css`));
  }
  const other = renderIndexPage({ template: '<link href="{{basePath}}site.css"><script src="{{basePath}}site.js"></script>', config: { ...config, basePath: '/preview/' }, bookmarklet: 'javascript:void 0' });
  assert.match(other, /href="\/preview\/site\.css"/);
  assert.match(other, /src="\/preview\/site\.js"/);
});

test('隐私页声明不上传、无遥测与非官方状态', () => {
  assert.equal(privacyDoc.documentElement.lang, 'zh-CN');
  const text = privacyDoc.body.textContent;
  for (const phrase of ['不上传', '遥测', '非官方', '不导出 Cookie', 'course.buct.edu.cn', '源码']) {
    assert.ok(text.includes(phrase), `隐私页缺少文案：${phrase}`);
  }
  assert.ok(privacyDoc.querySelector('a[href*="github.com/vg188/THEOL-downloader"]'));
  assert.equal(privacyDoc.querySelector('a[href$="index.html"]').getAttribute('href'), `${config.basePath}index.html`);
});

test('site.js 只能复制代码、拦下本页误点击，且不访问网络', async () => {
  const source = await readFile(join(output, 'site.js'), 'utf8');
  assert.doesNotMatch(source, /https?:\/\//);
  const dom = new JSDOM(indexHtml, { runScripts: 'outside-only', url: 'https://vg188.github.io/THEOL-downloader/' });
  const { window } = dom;
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (value) => { copied.push(value); } }, configurable: true });
  window.eval(source);
  const status = window.document.querySelector('#copy-status');
  window.document.querySelector('#copy-bookmarklet').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(copied, [install.getAttribute('href')]);
  assert.match(status.textContent, /已复制/);
  window.document.querySelector('#bookmarklet-install').click();
  assert.match(status.textContent, /拖到书签栏/);
  assert.equal(window.location.href, 'https://vg188.github.io/THEOL-downloader/');
});

test('产物检查会拦下 source map、fixture、env、凭据与远程导入', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'site-artifact-'));
  try {
    await writeFile(join(scratch, 'index.html'), '<p>ok</p>', 'utf8');
    assert.deepEqual(await assertSafeArtifact(scratch), ['index.html']);
    await writeFile(join(scratch, 'app.js.map'), '{}', 'utf8');
    await assert.rejects(() => assertSafeArtifact(scratch), /app\.js\.map/);
    await rm(join(scratch, 'app.js.map'));
    await writeFile(join(scratch, '.env'), 'TOKEN=1', 'utf8');
    await assert.rejects(() => assertSafeArtifact(scratch), /\.env/);
    await rm(join(scratch, '.env'));
    await writeFile(join(scratch, 'fixtures.js'), 'export default {}', 'utf8');
    await assert.rejects(() => assertSafeArtifact(scratch), /fixtures\.js/);
    await rm(join(scratch, 'fixtures.js'));
    await writeFile(join(scratch, 'app.js'), 'import x from "https://cdn.example.com/x.js";', 'utf8');
    await assert.rejects(() => assertSafeArtifact(scratch), /远程导入模块|未允许的主机/);
    await writeFile(join(scratch, 'app.js'), 'const key = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";', 'utf8');
    await assert.rejects(() => assertSafeArtifact(scratch), /GitHub 令牌/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
