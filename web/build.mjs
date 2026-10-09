/** Build the current static install site, self-contained bookmarklet and matching extension ZIP. */
import { build } from 'esbuild';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, prepareOutput } from '../scripts/release-utils.mjs';
import { buildReleaseExtension } from '../scripts/release-extension.mjs';
import { packageReleaseExtension, PACKAGE_NAME } from '../scripts/package-release.mjs';
import { RELEASE_VERSION } from '../src/runtime/version.js';

const WEB = join(PROJECT_ROOT, 'web');
export const SITE_ASSETS = Object.freeze(['site.css', 'site.js', 'assets/mark.svg', 'assets/icons.svg', 'assets/course-folder.svg', 'assets/bookmark-guide.svg']);
function escapeAttribute(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
export async function buildBookmarklet({ minify = true } = {}) {
  const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== RELEASE_VERSION) throw new Error('Package version differs from the shipped bookmarklet');
  const result = await build({ absWorkingDir: PROJECT_ROOT, entryPoints: ['web/bookmarklet-source.js'], bundle: true, write: false, minify, target: 'chrome120', charset: 'utf8', format: 'iife', platform: 'browser', legalComments: 'none' });
  const bundle = result.outputFiles[0].text.trim();
  new Function(bundle);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(bundle)) throw new Error('Bookmarklet must not evaluate strings as code');
  return bundle;
}
export async function buildSite({ output = join(PROJECT_ROOT, 'dist', 'site'), stamp = new Date().toISOString().slice(0, 10), extensionDirectory } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) throw new Error('Invalid build date');
  const bundle = await buildBookmarklet();
  const directory = await prepareOutput(output);
  const extension = extensionDirectory || await buildReleaseExtension({ output: directory + '-extension' });
  const pkg = await packageReleaseExtension(extension);
  const href = 'javascript:' + encodeURIComponent(bundle);
  const data = { href, stamp: 'v' + RELEASE_VERSION + ' (' + stamp + ')' };
  const values = { VERSION: RELEASE_VERSION, BUILD_DATE: stamp, PACKAGE_SIZE: Math.round(pkg.size / 1024) + ' KiB' };
  const template = html => {
    const rendered = html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(values, key)) throw new Error('Unknown website template value: ' + key);
      return escapeAttribute(values[key]);
    });
    if (/\{\{[A-Z_]+\}\}/.test(rendered)) throw new Error('Unresolved website template');
    return rendered;
  };
  let html = template(await readFile(join(WEB, 'index.html'), 'utf8'));
  if (!html.includes('href="#" draggable="true"')) throw new Error('Bookmark install anchor missing');
  html = html.replace('href="#" draggable="true"', 'href="' + escapeAttribute(href) + '" draggable="true"');
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  html = html.replace('</head>', '<script>window.__BOOKMARKLET__=' + json + ';</script>\n</head>');
  const release = { version: RELEASE_VERSION, builtAt: stamp, extension: { file: 'downloads/' + PACKAGE_NAME, bytes: pkg.size, sha256: pkg.sha256 }, bookmarklet: { file: 'bookmarklet.txt', version: RELEASE_VERSION }, repository: 'https://github.com/vg188/THEOL-downloader' };
  await Promise.all([mkdir(join(directory, 'assets')), mkdir(join(directory, 'downloads'))]);
  await Promise.all([
    writeFile(join(directory, 'index.html'), html),
    writeFile(join(directory, 'privacy.html'), template(await readFile(join(WEB, 'privacy.html'), 'utf8'))),
    writeFile(join(directory, 'bookmarklet.js'), bundle),
    writeFile(join(directory, 'bookmarklet.txt'), href),
    writeFile(join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n'),
    writeFile(join(directory, 'downloads', PACKAGE_NAME), pkg.bytes),
    copyFile(join(PROJECT_ROOT, 'THIRD_PARTY_NOTICES.md'), join(directory, 'THIRD_PARTY_NOTICES.md')),
    ...SITE_ASSETS.map(file => copyFile(join(WEB, file), join(directory, file))),
  ]);
  return directory;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('Site: ' + await buildSite());
