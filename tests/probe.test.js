import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildProbe } from '../scripts/build-probe.mjs';

test('probe emits a fixed-origin bookmarklet and no collection endpoint', async () => {
  const output = await buildProbe();
  const bookmarklet = await readFile(`${output}/bookmarklet.txt`, 'utf8');
  const runtime = await readFile(`${output}/probe.js`, 'utf8');
  assert.match(bookmarklet, /^javascript:/);
  assert.ok(bookmarklet.includes('https://vg188.github.io/THEOL-downloader/probe/probe.js')); 
  assert.doesNotMatch(bookmarklet + runtime, /sendBeacon|XMLHttpRequest|localStorage|sessionStorage/);
  assert.doesNotMatch(runtime, /download\.jsp/);
});

test('probe page states its metadata-only privacy boundary', async () => {
  const html = await readFile(new URL('../probe/index.html', import.meta.url), 'utf8');
  assert.match(html, /仅读取一份预览元数据页面/);
  assert.match(html, /不会下载课件正文/);
  assert.match(html, /不会上传/);
});
