// Builds the static GitHub Pages site in `dist/site`.
//
// The draggable bookmarklet is fully self-contained: esbuild bundles the page-side
// runtime into one IIFE, and that IIFE becomes the anchor's `javascript:` payload.
// Nothing is published for the site to fetch at runtime — no versioned runtime
// file, no worker file, no remote import — so the artifact scan below fails the
// build if any of those reappear.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSelfContainedBookmarklet } from '../src/bookmarklet/bootstrap.js';
import { BOOKMARKLET_VERSION, bookmarkletStamp } from '../src/bookmarklet/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The only hosts a shipped file may point at. */
export const ALLOWED_HOSTS = Object.freeze(['chromewebstore.google.com', 'course.buct.edu.cn', 'github.com']);

/** Chrome extension IDs use the a–p alphabet; the store URL must match exactly. */
const STORE_URL = /^https:\/\/chromewebstore\.google\.com\/detail\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-p]{32}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.txt', '.svg', '.webmanifest']);
const BANNED_FILES = /^(?:\.env(?:\..*)?|.*\.(?:map|pem|key|p12|pfx|crx|zip|log))$/i;
const BANNED_SEGMENTS = new Set(['.git', 'node_modules', 'fixtures', '__fixtures__', 'tests']);
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS 访问键'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub 令牌'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API 密钥'],
];

function fail(message) {
  throw new Error(`站点构建失败：${message}`);
}

function requireString(value, key) {
  if (typeof value !== 'string' || !value.trim()) fail(`config.${key} 必须是非空字符串`);
  return value.trim();
}

/**
 * Validates the site config. A null store URL is the pre-review state; anything
 * else must be an exact Chrome Web Store detail URL, so a typo cannot ship a
 * broken or look-alike install button.
 */
export function readSiteConfig(source) {
  const config = typeof source === 'string' ? JSON.parse(source) : source;
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('config 必须是 JSON 对象');
  const basePath = requireString(config.basePath, 'basePath');
  if (!basePath.startsWith('/') || !basePath.endsWith('/') || basePath.includes('//') || basePath.includes('..') || basePath.includes('://')) {
    fail('config.basePath 必须是以 / 开头和结尾的站内路径，例如 /THEOL-downloader/');
  }
  const releaseVersion = requireString(config.releaseVersion, 'releaseVersion');
  if (!VERSION.test(releaseVersion)) fail('config.releaseVersion 必须是 x.y.z 形式');
  const { chromeWebStoreUrl } = config;
  if (chromeWebStoreUrl !== null && !STORE_URL.test(String(chromeWebStoreUrl))) {
    fail('config.chromeWebStoreUrl 必须是 https://chromewebstore.google.com/detail/<slug>/<32 位扩展 ID> 或 null');
  }
  return Object.freeze({
    basePath, releaseVersion,
    chromeWebStoreUrl: chromeWebStoreUrl === null ? null : String(chromeWebStoreUrl),
  });
}

/**
 * The release number is written down in four places — `package.json`,
 * `public/manifest.json`, `site/config.json` and the bookmarklet's own module —
 * and a page that shows a stale one misleads every visitor at once. `buildSite`
 * is the only step that reads all four, so it is where they are required to agree.
 */
export async function assertSingleReleaseVersion({ projectRoot = root, config } = {}) {
  const [pkg, manifest] = await Promise.all([
    readFile(join(projectRoot, 'package.json'), 'utf8'),
    readFile(join(projectRoot, 'public', 'manifest.json'), 'utf8'),
  ]);
  const declared = {
    'package.json': JSON.parse(pkg).version,
    'public/manifest.json': JSON.parse(manifest).version,
    'site/config.json': config.releaseVersion,
    'src/bookmarklet/version.js': BOOKMARKLET_VERSION,
  };
  const versions = [...new Set(Object.values(declared))];
  if (versions.length > 1) {
    fail(`版本号不一致：${Object.entries(declared).map(([file, value]) => `${file}=${value}`).join('、')}`);
  }
  return versions[0];
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The full-version install control. Chrome forbids silent installs, so the only
 * two honest states are a store link the user confirms, and a disabled control
 * while the unlisted entry is still in review.
 */
export function createChromeInstallMarkup(storeUrl) {
  if (storeUrl === null) {
    return '<span id="chrome-install" class="button" aria-disabled="true">Chrome 商店审核中</span>';
  }
  if (!STORE_URL.test(String(storeUrl))) fail('chrome-install 的商店链接无效');
  return `<a id="chrome-install" class="button button-primary" rel="noopener noreferrer" href="${escapeAttribute(storeUrl)}">添加至 Chrome</a>`;
}

function render(template, values) {
  let html = template;
  // A function replacement keeps `$&`-style sequences inside the bookmarklet
  // payload literal instead of letting String.replaceAll expand them.
  for (const [key, value] of Object.entries(values)) html = html.replaceAll(`{{${key}}}`, () => value);
  const leftover = html.match(/\{\{[a-zA-Z]+\}\}/);
  if (leftover) fail(`模板占位符未替换：${leftover[0]}`);
  return html;
}

/** Renders the landing page. Pure, so both store states are testable in memory. */
export function renderIndexPage({ template, config, bookmarklet, build }) {
  return render(template, {
    basePath: config.basePath,
    releaseVersion: config.releaseVersion,
    bookmarkletStamp: bookmarkletStamp(build),
    bookmarkletHref: escapeAttribute(bookmarklet),
    chromeInstall: createChromeInstallMarkup(config.chromeWebStoreUrl),
  });
}

/** Renders the privacy page. */
export function renderPrivacyPage({ template, config, build }) {
  return render(template, {
    basePath: config.basePath,
    releaseVersion: config.releaseVersion,
    bookmarkletStamp: bookmarkletStamp(build),
  });
}

/** Bundles the page-side runtime exactly as the shipped bookmarklet carries it. */
export async function buildBookmarkletBundle({ root: projectRoot = root, buildStamp = bookmarkletBuildStamp() } = {}) {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/bookmarklet/main.js'],
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    platform: 'browser',
    charset: 'utf8',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    loader: { '.css': 'text' },
    write: false,
    // A saved bookmarklet has no cache to bust: the build date is what lets a
    // user tell an old bookmark from a current one.
    define: { __BOOKMARKLET_BUILD__: JSON.stringify(buildStamp) },
  });
  return result.outputFiles[0].text;
}

/** The date this bundle was built, stamped into the bookmarklet itself. */
export function bookmarkletBuildStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function walk(dir, base = dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, found);
    } else {
      found.push({ full, relative: relative(base, full).split(sep).join('/') });
    }
  }
  return found;
}

/**
 * Rejects any shipped file that would leak a build input or reach the network:
 * source maps, fixtures, env files, credentials, remote imports, and any URL
 * outside the allowlisted hosts (the school origin or a public link).
 */
export async function assertSafeArtifact(output) {
  const files = await walk(output);
  for (const file of files) {
    const segments = file.relative.split('/');
    if (segments.some(segment => BANNED_SEGMENTS.has(segment) || /fixture/i.test(segment))) {
      fail(`产物包含禁止的路径：${file.relative}`);
    }
    if (BANNED_FILES.test(file.relative.split('/').pop())) {
      fail(`产物包含禁止的文件：${file.relative}`);
    }
    if (!TEXT_EXTENSIONS.has(file.relative.slice(file.relative.lastIndexOf('.')).toLowerCase())) continue;
    const text = await readFile(file.full, 'utf8');
    if (/sourceMappingURL/.test(text)) fail(`${file.relative} 含有 source map 引用`);
    if (/<script[^>]*\ssrc\s*=\s*["']?https?:/i.test(text)) fail(`${file.relative} 远程加载脚本`);
    if (/@import\s+(?:url\(\s*)?["']?https?:/i.test(text)) fail(`${file.relative} 远程导入样式`);
    if (/new\s+Worker\s*\(\s*["'`]https?:/.test(text)) fail(`${file.relative} 远程加载 worker`);
    if (/(?:import\s*\(\s*|from\s*)["'`]https?:/.test(text)) fail(`${file.relative} 远程导入模块`);
    for (const [pattern, label] of SECRETS) {
      if (pattern.test(text)) fail(`${file.relative} 疑似包含${label}`);
    }
    // The character class stops at quotes, HTML-entity ampersands and markup, so
    // the check sees host names rather than the tail of an escaped attribute.
    for (const url of text.match(/https?:\/\/[^\s"'<>`()&;,\\]+/g) ?? []) {
      const host = URL.canParse(url) ? new URL(url).hostname : '';
      if (!ALLOWED_HOSTS.includes(host)) fail(`${file.relative} 指向未允许的主机：${url}`);
    }
  }
  return Object.freeze(files.map(file => file.relative));
}

/**
 * Builds `dist/site` and returns its path. Publishing the whole bookmarklet inside
 * the anchor means there is no runtime URL to keep alive — and no versioned path to
 * break — so the artifact is only the two pages plus their local assets.
 */
export async function buildSite({ root: projectRoot = root, configPath, output } = {}) {
  const siteRoot = join(projectRoot, 'site');
  const config = readSiteConfig(await readFile(configPath ?? join(siteRoot, 'config.json'), 'utf8'));
  await assertSingleReleaseVersion({ projectRoot, config });
  // One date for both: the page shows exactly what the bundle it hands out carries.
  const build = bookmarkletBuildStamp();
  const bundleSource = await buildBookmarkletBundle({ root: projectRoot, buildStamp: build });
  const bookmarklet = createSelfContainedBookmarklet(bundleSource);
  const indexHtml = renderIndexPage({ template: await readFile(join(siteRoot, 'index.html'), 'utf8'), config, bookmarklet, build });
  const privacyHtml = renderPrivacyPage({ template: await readFile(join(siteRoot, 'privacy.html'), 'utf8'), config, build });
  const outputDir = output ?? join(projectRoot, 'dist', 'site');
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'index.html'), indexHtml, 'utf8');
  await writeFile(join(outputDir, 'privacy.html'), privacyHtml, 'utf8');
  await copyFile(join(siteRoot, 'site.css'), join(outputDir, 'site.css'));
  await copyFile(join(siteRoot, 'site.js'), join(outputDir, 'site.js'));
  await assertSafeArtifact(outputDir);
  return outputDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildSite();
  console.log(`Site: ${output}`);
}
