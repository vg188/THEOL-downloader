import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { buildSite } from '../../web/build.mjs';
import { buildReleaseExtension, RELEASE_ASSETS } from '../../scripts/build-release.mjs';
import { prepareOutput } from '../../scripts/release-utils.mjs';
import { RELEASE_VERSION } from '../../src/runtime/version.js';
import { ROOT } from './helpers.js';
const output = join(ROOT, 'dist', 'test-release-' + randomUUID());

test('the current release builds an installable extension with all referenced assets', async () => {
  const directory = await buildReleaseExtension({ output: join(output, 'extension') });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, RELEASE_VERSION); assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'downloads', 'offscreen', 'scripting', 'storage', 'tabs']);
  const packageScript = await readFile(join(ROOT, 'scripts/package.py'), 'utf8');
  const allowed = JSON.parse(packageScript.match(/^PERMISSIONS = (\[.*\])$/m)[1]);
  assert.deepEqual(allowed, [...manifest.permissions].sort(), 'packaging permissions must match the shipped manifest');
  for (const asset of RELEASE_ASSETS) assert.ok((await readFile(join(directory, asset))).length);
  assert.match(await readFile(join(directory, 'background.js'), 'utf8'), /getURL\("panel\.html"\)/);
  assert.equal((await readdir(directory)).includes('popup.html'), false);
});
test('the install link is a correctly encoded self-contained JavaScript URL and matches the copy payload', async () => {
  const directory = await buildSite({ output: join(output, 'site'), stamp: '2026-10-08' });
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  try {
    const href = dom.window.document.querySelector('a[draggable="true"]').getAttribute('href');
    assert.ok(href.startsWith('javascript:'));
    assert.ok(!href.includes('#'));
    assert.equal(href, dom.window.__BOOKMARKLET__.href);
    assert.equal(decodeURIComponent(href.slice('javascript:'.length)), (await readFile(join(directory, 'bookmarklet.js'), 'utf8')).trim());
    assert.match(dom.window.__BOOKMARKLET__.stamp, new RegExp(RELEASE_VERSION.replaceAll('.', '\\.')));
    assert.doesNotThrow(() => new Function(decodeURIComponent(href.slice(11))));
  } finally { dom.window.close(); }
});
test('release cleanup refuses the repository root or any path outside its dist directory', async () => {
  await assert.rejects(prepareOutput(ROOT), /must be a child/);
  await assert.rejects(prepareOutput(join(ROOT, 'dist')), /must be a child/);
  await assert.rejects(prepareOutput(join(ROOT, 'src')), /must be a child/);
});

test('the web package build command is relative to its own working directory', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'web', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'node build.mjs');
});

test('release dependencies use integrity-pinned HTTPS tarballs from the public npm registry', async () => {
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.match(await readFile(join(ROOT, '.npmrc'), 'utf8'), /^registry=https:\/\/registry\.npmjs\.org\/\s*$/);
  const dependencies = Object.entries(lock.packages).filter(([name]) => name);
  assert.ok(dependencies.length > 0);
  for (const [name, dependency] of dependencies) {
    const source = new URL(dependency.resolved);
    assert.equal(source.origin, 'https://registry.npmjs.org', name);
    assert.equal(source.username, '', name);
    assert.equal(source.password, '', name);
    assert.ok(source.pathname.endsWith('.tgz'), name);
    assert.match(dependency.integrity ?? '', /^sha512-[A-Za-z0-9+/]+=*$/, name);
  }
});
