import assert from 'node:assert/strict';
import test from 'node:test';
import { scanResources } from '../src/platform/scan.js';
import { dom, preview, resource } from './helpers/dom.js';

const response = (html) => new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
test('scanner caps parallel requests and isolates unsupported, network and timeout failures', async () => {
  let active = 0, peak = 0;
  const events = [];
  const fetcher = async (url, options) => {
    active++; peak = Math.max(peak, active);
    const n = new URL(url).searchParams.get('fileid');
    try {
      if (n === '6') await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      await new Promise(resolve => setTimeout(resolve, 2));
      if (n === '5') throw new Error('private network detail');
      return response(preview(n === '4' ? '工具.exe' : `章节${n}.pdf`, n));
    } finally { active--; }
  };
  const result = await scanResources([1,2,3,4,5,6].map(resource), { fetcher, parseDocument: dom, onProgress: e => events.push(e), timeoutMs: 80 });
  assert.ok(peak <= 3);
  assert.equal(result.files.length, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures.length, 2);
  assert.equal(result.processed, 6);
  assert.equal(events.length, 6);
  assert.ok(result.failures.some(f => f.code === 'TIMEOUT'));
  assert.ok(result.failures.every(f => !f.message.includes('private network detail')));
});
test('redirects and wrong response types are not scanned as courseware', async () => {
  const result = await scanResources([resource()], { fetcher: async () => ({type:'opaqueredirect', status:0}), parseDocument: dom });
  assert.equal(result.failures[0].code, 'LOGIN_REQUIRED');
  const binary = await scanResources([resource()], { fetcher: async () => new Response('bytes', {headers:{'content-type':'application/pdf'}}), parseDocument: dom });
  assert.equal(binary.files.length, 0);
});
test('timeout covers a stalled response body, not just response headers', async () => {
  const result = await scanResources([resource()], { fetcher: async () => ({ok:true, status:200, type:'basic', headers:new Headers({'content-type':'text/html'}), text: () => new Promise(() => {})}), parseDocument: dom, timeoutMs:10 });
  assert.equal(result.failures[0].code, 'TIMEOUT');
});
test('empty directories complete without network requests', async () => {
  const result = await scanResources([], { fetcher: () => assert.fail(), parseDocument: dom });
  assert.equal(result.processed, 0);
});
