import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { unzipSync } from 'fflate';
import { buildSite } from '../../web/build.mjs';
import { RELEASE_VERSION } from '../../src/runtime/version.js';
import { ROOT } from '../release/helpers.js';
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
const artifacts = join(ROOT, 'output', 'playwright', 'site-redesign');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.txt':'text/plain', '.md':'text/plain', '.zip':'application/zip' };
test('website works under the Pages subpath: responsive, keyboard, no-JS, clipboard fallback and native package download', { timeout: 90000 }, async () => {
  assert.ok(chrome, 'Install Chrome or set CHROME_PATH');
  const directory = await buildSite({ output: join(ROOT, 'dist', 'test-website-browser-' + randomUUID()) });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/THEOL-downloader/')) { res.writeHead(404); res.end(); return; }
      const name = decodeURIComponent(url.pathname.slice('/THEOL-downloader/'.length)) || 'index.html';
      const target = resolve(directory, name), rel = relative(directory, target);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
      const bytes = await readFile(target); res.writeHead(200, { 'content-type':types[extname(target)] || 'application/octet-stream', 'content-length':bytes.length }); res.end(bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await mkdir(artifacts, { recursive: true });
  const base = 'http://127.0.0.1:' + server.address().port + '/THEOL-downloader/';
  const browser = await chromium.launch({ executablePath:chrome, headless:true });
  const errors = [], failed = [], requests = [];
  try {
    const context = await browser.newContext({ viewport:{width:1440,height:1000}, acceptDownloads:true, reducedMotion:'reduce' });
    await context.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async text => window.__copies.push(text)} });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url())); page.on('response', response => { if(response.status()>=400)failed.push({url:response.url(),status:response.status()}); });
    await page.goto(base, { waitUntil:'networkidle' });
    assert.equal(await page.locator('h1').count(), 1);
    const responsive = [];
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 640 ? 844 : 1000 });
      const layout = await page.evaluate(() => ({
        width:innerWidth, scroll:document.documentElement.scrollWidth,
        brokenImages:[...document.images].filter(img=>!img.complete||img.naturalWidth===0).map(img=>img.getAttribute('src')),
        mainButtonVisible:document.querySelector('.hero-actions .button').getBoundingClientRect().bottom<innerHeight,
      }));
      assert.ok(layout.scroll <= layout.width + 1, 'document overflow at ' + width); assert.deepEqual(layout.brokenImages, []); assert.ok(layout.mainButtonVisible, 'hero CTA below fold at ' + width);
      responsive.push(layout);
      if ([1440,390,320].includes(width)) await page.screenshot({ path:join(artifacts,'verified-home-'+width+'.png'), fullPage:true });
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>{document.documentElement.style.zoom='2';});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% CSS zoom must not create document overflow');
    await page.screenshot({path:join(artifacts,'verified-home-200-percent.png'),fullPage:true});
    await page.goto(base);
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement.className),'skip-link');
    await page.keyboard.press('Enter'); assert.equal(new URL(page.url()).hash, '#main');
    const bookmark = page.locator('#bookmarklet-install'); await bookmark.click();
    assert.match(await page.locator('#copy-status').textContent(), /拖到书签栏/); assert.equal(await page.locator('#buct-tab-dl-host').count(), 0);
    await page.locator('#copy-bookmarklet').click(); await page.waitForFunction(()=>!document.querySelector('#copy-bookmarklet').disabled);
    assert.ok(await page.evaluate(()=>window.__copies[0]===document.querySelector('#bookmarklet-install').getAttribute('href')));
    await page.locator('#copy-extensions-url').click(); await page.waitForFunction(()=>!document.querySelector('#copy-extensions-url').disabled);
    assert.equal(await page.evaluate(()=>window.__copies.at(-1)),'chrome://extensions');
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});document.execCommand=()=>false;});
    await page.locator('#copy-bookmarklet').click(); await page.locator('#manual-code').waitFor({state:'visible'});
    assert.ok(await page.evaluate(()=>{const field=document.querySelector('#bookmarklet-code');return field.value===window.__BOOKMARKLET__.href&&field.selectionEnd===field.value.length;}));
    const faq=page.locator('#faq details').first();await faq.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await faq.getAttribute('open'),'');
    const release=JSON.parse(await readFile(join(directory,'release.json'),'utf8'));
    const downloadEvent=page.waitForEvent('download');await page.locator('#extension-download').click();const download=await downloadEvent;
    const saved=join(artifacts,'website-extension.zip');await download.saveAs(saved);assert.equal(await download.failure(),null);
    const bytes=await readFile(saved);assert.equal(createHash('sha256').update(bytes).digest('hex'),release.extension.sha256);
    assert.equal(JSON.parse(new TextDecoder().decode(unzipSync(bytes)['manifest.json'])).version,RELEASE_VERSION);
    await page.goto(base+'privacy.html');await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(artifacts,'verified-privacy-390.png'),fullPage:true});
    await page.getByRole('link',{name:'本地存储',exact:true}).click();assert.ok(page.url().endsWith('#storage'));
    const noJS=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}), fallback=await noJS.newPage();
    await fallback.goto(base);assert.match(await fallback.locator('#bookmarklet-install').getAttribute('href'),/^javascript:/);
    assert.match(await fallback.locator('#bookmarklet-stamp').textContent(),new RegExp(RELEASE_VERSION.replaceAll('.','\\.')));
    assert.equal(await fallback.locator('#extension-download').getAttribute('href'),release.extension.file);
    assert.ok(await fallback.locator('noscript').isVisible());await fallback.locator('#faq summary').first().click();assert.equal(await fallback.locator('#faq details').first().getAttribute('open'),'');
    assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.equal(requests.some(url=>!url.startsWith(base)),false,'website loads only its own static assets');
    const report={version:RELEASE_VERSION,responsive,cssZoom200Percent:true,clipboardFallback:true,noJavaScript:true,keyboard:true,extensionZipSha256:release.extension.sha256,extensionZipBytes:bytes.length,errors,failed};
    const {writeFile}=await import('node:fs/promises');await writeFile(join(artifacts,'browser-report.json'),JSON.stringify(report,null,2));
  } finally { await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});
