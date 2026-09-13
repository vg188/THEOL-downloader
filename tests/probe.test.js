import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildProbe } from '../scripts/build-probe.mjs';
import { JSDOM } from 'jsdom';
import { armCapture, previewCandidates, readBounded, responseSignature } from '../probe/probe.js';


test('probe emits a fixed-origin bookmarklet and no collection endpoint', async () => {
  const output = await buildProbe();
  const bookmarklet = await readFile(`${output}/bookmarklet.txt`, 'utf8');
  const standalone = await readFile(`${output}/bookmarklet-self-contained.txt`, 'utf8');
  const runtime = await readFile(`${output}/probe.js`, 'utf8');
  const html = await readFile(`${output}/index.html`, 'utf8');
  assert.match(bookmarklet, /^javascript:/);
  assert.match(standalone, /^javascript:/);
  assert.ok(standalone.length < 8000, `self-contained proof must stay draggable: ${standalone.length}`);
  assert.ok(bookmarklet.includes('https://vg188.github.io/THEOL-downloader/probe/probe.js'));
  assert.doesNotMatch(bookmarklet + standalone + runtime, /sendBeacon|XMLHttpRequest|localStorage|sessionStorage|indexedDB|navigator\.clipboard/);
  assert.doesNotMatch(runtime, /\/meol\/common\/script\/download\.jsp/);
  assert.equal(runtime.match(/\bfetch\(/g)?.length, 1, 'probe may issue only one metadata request');
  assert.match(runtime, /credentials:["']include["']/);
  assert.match(runtime, /redirect:["']manual["']/);
  assert.doesNotMatch(runtime, /content-length|response\.url|\.text\(\)|\.json\(\)|\.arrayBuffer\(\)|\.blob\(\)|\.formData\(\)/);
  assert.match(runtime, /currentScript/);
  assert.match(runtime, /未使用（自包含）/);
  assert.match(runtime, /捕获下一次单元点击/);
  assert.match(runtime, /取消捕获/);
  assert.match(runtime, /当前 frame 类型/);
  assert.match(runtime, /重复链接类型/);
  assert.match(runtime, /预览链接数量/);
  assert.match(html, /id="probe-bookmarklet"/);
  assert.match(html, /id="probe-standalone"/);
  assert.doesNotMatch(html, /__PROBE_BOOKMARKLET__/);
  assert.match(html, /href="javascript:/);
});

test('probe page states its metadata-only privacy boundary and safe workflow', async () => {
  const html = await readFile(new URL('../probe/index.html', import.meta.url), 'utf8');
  assert.match(html, /至多读取一份页面中已经存在的规范预览元数据页面/);
  assert.match(html, /最多 64 KiB/);
  assert.match(html, /不会请求下载地址或课件正文/);
  assert.match(html, /不会上传、收集、存储或复制/);
  assert.match(html, /捕获下一次单元点击/);
  assert.match(html, /只点击一次另一个可见单元/);
  assert.match(html, /只发送测试浮层的截图/);
  for (const prohibited of ['DevTools 输出', '页面源码', '完整 URL', '查询参数值', '课程名', '单元名', '文件名', '任何 ID', '账号或凭据', '响应正文']) assert.match(html, new RegExp(prohibited));
});

test('preview candidates canonicalize, deduplicate, and reject unsafe anchors', () => {
  const pageUrl = 'https://course.buct.edu.cn/meol/unit.jsp?lid=9';
  const document = new JSDOM(`
    <a href="/meol;tenant=x/common/script/preview/download_preview.jsp;jsessionid=secret?resid=2&amp;lid=9&amp;fileid=1">one</a>
    <a href="https://course.buct.edu.cn/meol/common/script/preview/download_preview.jsp?fileid=1&amp;resid=2&amp;lid=9#private">duplicate</a>
    <a href="https://evil.test/meol/common/script/preview/download_preview.jsp?fileid=1&amp;resid=2&amp;lid=9">external</a>
    <a href="/meol/common/script/preview/download_preview.jsp?fileid=1&amp;resid=2&amp;lid=9&amp;name=private">extra query</a>
    <a href="/meol/common/script/preview/download_preview.jsp?fileid=1&amp;resid=2">missing</a>
  `, { url:pageUrl }).window.document;
  assert.deepEqual(previewCandidates(document, pageUrl), [
    'https://course.buct.edu.cn/meol/common/script/preview/download_preview.jsp?fileid=1&resid=2&lid=9',
  ]);
});

test('bounded reader enforces its limit and always cancels', async () => {
  let reads = 0, cancelled = 0;
  const response = { body:{ getReader:() => ({
    read:async () => ({ done:false, value:new Uint8Array(++reads === 1 ? 65536 : 1) }),
    cancel:async () => { cancelled++; },
  }) } };
  await assert.rejects(readBounded(response, 65536), /超过 64 KiB/);
  assert.equal(cancelled, 1);
});

test('response signature retains only MIME family and charset', () => {
  const response = { headers:new Headers({ 'content-type':'Text/HTML; Charset="GBK"', 'content-length':'1234' }) };
  assert.deepEqual(responseSignature(response), { mimeFamily:'html', charset:'gbk' });
  assert.deepEqual(responseSignature({ headers:new Headers() }), { mimeFamily:'other', charset:'unspecified' });
});

test('capture is one-shot, ignores overlay clicks, and uses target document URL', () => {
  const dom = new JSDOM('<a id="unit" href="/meol/unit.jsp?unitId=2">unit</a>', { url:'https://course.buct.edu.cn/current.jsp?lid=9' });
  const unit = dom.window.document.querySelector('#unit');
  const host = { contains:target => target.inside };
  const captured = [];
  const registered = [];
  const frameDocument = {
    addEventListener:(type, handler) => registered.push(handler),
    removeEventListener:(type, handler) => registered.splice(registered.indexOf(handler), 1),
  };
  const target = { inside:false, ownerDocument:frameDocument, closest:unit.closest.bind(unit) };
  const makeEvent = target => ({ isTrusted:true, target, preventDefault() {}, stopImmediatePropagation() {} });
  armCapture([{ document:frameDocument, url:dom.window.document.URL }, { document:frameDocument, url:'https://course.buct.edu.cn/wrong.jsp' }], host, value => captured.push(value));
  registered[0](makeEvent({ inside:true, ownerDocument:frameDocument }));
  registered[0](makeEvent(target));
  for (const handler of [...registered]) handler(makeEvent(target));
  assert.deepEqual(captured, [{ mechanism:'href', route:{ endpoint:'/meol/unit.jsp', queryKeys:['unitId'] } }]);
});

test('failed capture registration leaves successful listeners removable', () => {
  const dom = new JSDOM('<section id="host"></section>', { url:'https://course.buct.edu.cn/current.jsp' });
  const { document } = dom.window;
  let removed = 0;
  const successful = {
    addEventListener:document.addEventListener.bind(document),
    removeEventListener:(...args) => { removed++; document.removeEventListener(...args); },
  };
  const failing = { addEventListener:() => { throw new Error('blocked'); }, removeEventListener:() => assert.fail('unregistered listener removed') };
  const stop = armCapture([{ document:successful, url:document.URL }, { document:failing, url:document.URL }], document.querySelector('#host'), () => {});
  stop();
  assert.equal(removed, 1);
});
