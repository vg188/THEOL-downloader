import assert from 'node:assert/strict';
import test from 'node:test';
import { preflight } from '../src/background/preflight.js';
import { file } from './helpers/dom.js';
const ole = new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
test('preflight uses GET, credentials and range, then cancels range-ignoring streams', async () => {
  let cancelled=false;
  const response = new Response(new ReadableStream({start(c){const block=new Uint8Array(65536);block.set(ole);c.enqueue(block);},cancel(){cancelled=true;}}), {headers:{'content-type':'application/vnd.ms-powerpoint'}});
  const result=await preflight(file(), {fetcher:async (url,options) => {assert.equal(options.method,'GET');assert.equal(options.headers.Range,'bytes=0-1023');assert.equal(options.credentials,'include');return response;}});
  assert.equal(result.mime,'application/vnd.ms-powerpoint');
  assert.equal(cancelled,true);
});
test('HTML, authentication redirects and mismatched signatures are rejected', async () => {
  for(const response of [new Response('<!doctype html>login',{headers:{'content-type':'application/octet-stream'}}),new Response(ole,{status:403}),{type:'opaqueredirect',status:0}]) {
    await assert.rejects(preflight(file(),{fetcher:async()=>response}));
  }
  await assert.rejects(preflight(file(),{fetcher:async()=>new Response('%PDF-1.7')}),e=>e.code==='BAD_FILE');
});
test('valid PDF and PPTX signatures are accepted', async () => {
  const pdf={...file(),name:'一.pdf',extension:'pdf'};
  assert.ok(await preflight(pdf,{fetcher:async()=>new Response('%PDF-1.7\n1234',{headers:{'content-type':'application/pdf'}})}));
  const pptx={...file(),name:'一.pptx',extension:'pptx'};
  assert.ok(await preflight(pptx,{fetcher:async()=>new Response(new Uint8Array([80,75,3,4,0,0,0,0]))}));
});
test('timeout includes a stalled body and cancels it', async () => {
  let cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  await assert.rejects(preflight(file(),{fetcher:async()=>response,timeoutMs:10}),e=>e.code==='TIMEOUT');
  assert.equal(cancelled,true);
});

test('HTML containing a PDF marker is still not a PDF when the MIME is incorrect', async () => {
  const pdf = {...file(), name:'错误.pdf', extension:'pdf'};
  await assert.rejects(preflight(pdf, {fetcher:async()=>new Response('<!DOCTYPE html><html><!-- %PDF-1.7 --><body>login</body></html>', {headers:{'content-type':'application/octet-stream'}})}), e=>e.code==='BAD_FILE');
});


test('PDF markers in other text or malformed headers are rejected', async () => {
  const pdf={...file(),name:'课件.pdf',extension:'pdf'};
  for (const body of ['login %PDF-1.7', '<!-- %PDF-1.7 -->', '%PDF-not-a-version', 'prefix\n%PDF-1.7']) {
    await assert.rejects(preflight(pdf,{fetcher:async()=>new Response(body,{headers:{'content-type':'application/pdf'}})}),e=>e.code==='BAD_FILE');
  }
  assert.ok(await preflight(pdf,{fetcher:async()=>new Response('%PDF-2.0\n%binary')}));
});
