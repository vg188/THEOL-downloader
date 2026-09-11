import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueue } from '../src/background/queue.js';
import { AppError } from '../src/platform/policy.js';
import { file } from './helpers/dom.js';
import { memoryStorage, fakeDownloads, settle } from './helpers/downloads.js';
function setup(options={}) {
  const storage=options.storage || memoryStorage(); const downloads=options.downloads || fakeDownloads(); let n=0;
  const queue=createQueue({storage,downloads,preflight:options.preflight || (async()=>({mime:'application/vnd.ms-powerpoint'})),extensionId:'test-extension',makeId:()=>`job-${++n}`});
  return {storage,downloads,queue};
}
test('native queue limits concurrency, drains on completion and deduplicates submissions', async()=>{
  const h=setup(); await h.queue.init(); const files=[1,2,3,4].map(file);
  await h.queue.enqueue(files,'request-one'); await settle();
  assert.equal(h.downloads.activeCount(),2);
  await h.queue.enqueue(files,'request-one'); await h.queue.enqueue(files,'request-two'); await settle();
  assert.equal((await h.queue.getState()).jobs.length,4);
  h.downloads.completeFirst(); await h.queue.refresh(); await settle();
  assert.equal(h.downloads.activeCount(),2);
  assert.equal(h.downloads.calls[0].conflictAction,'uniquify');
  assert.equal(h.downloads.calls[0].saveAs,false);
  assert.equal(h.downloads.calls[0].filename,'电路/第1章.ppt');
});
test('preparing reservations also count against the concurrency limit', async()=>{
  let active=0,peak=0; const releases=[];
  const h=setup({preflight:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>releases.push(r));active--;}});
  await h.queue.init(); await h.queue.enqueue([1,2,3].map(file),'one'); await settle();
  assert.equal(peak,2); assert.equal(releases.length,2);
  releases.splice(0).forEach(r=>r()); await settle(); assert.equal(h.downloads.activeCount(),2);
});
test('preflight or download failure can be retried only by explicit request', async()=>{
  let checks=0; const h=setup({preflight:async()=>{if(++checks===1)throw new AppError('LOGIN_REQUIRED','请重新登录');}});
  await h.queue.init(); await h.queue.enqueue([file()],'one'); await settle();
  assert.equal(h.downloads.calls.length,0);
  const first=(await h.queue.getState()).jobs[0]; assert.equal(first.status,'failed');
  await h.queue.retry([first.id]); await settle(); assert.equal(h.downloads.calls.length,1); assert.equal(checks,2);
});
test('download API errors never leave stuck preparing jobs', async()=>{
  const h=setup(); h.downloads.failNext=true; await h.queue.init(); await h.queue.enqueue([file()],'one'); await settle();
  const state=await h.queue.getState(); assert.equal(state.jobs[0].status,'failed'); assert.ok(!state.jobs[0].error.includes('private failure detail'));
});
test('immediate completion before event processing is reconciled and drains all jobs', async()=>{
  const h=setup(); h.downloads.immediatelyComplete=true; await h.queue.init(); await h.queue.enqueue([1,2,3].map(file),'one'); await settle();
  assert.equal((await h.queue.getState()).jobs.filter(j=>j.status==='complete').length,3);
  await h.queue.enqueue([file(1)],'explicit-again'); await settle(); assert.equal(h.downloads.calls.length,4);
});
test('closing popup has no role in queue lifetime; new worker recovers native jobs', async()=>{
  const h=setup(); await h.queue.init(); await h.queue.enqueue([1,2,3].map(file),'one'); await settle();
  const recovered=setup({storage:h.storage,downloads:h.downloads}); await recovered.queue.init(); await settle();
  assert.equal(h.downloads.calls.length,2);
  h.downloads.completeFirst(); await recovered.queue.refresh(); await settle(); assert.equal(h.downloads.calls.length,3);
});
test('native cancellation is distinct from a server returning HTML', async()=>{
  const h=setup(); await h.queue.init(); await h.queue.enqueue([1,2].map(file),'one'); await settle();
  const [a,b]=[...h.downloads.items.values()]; await h.downloads.cancel(a.id); b.mime='text/html';
  await h.queue.refresh(); const jobs=(await h.queue.getState()).jobs;
  assert.equal(jobs[0].errorCode,'CANCELLED'); assert.equal(jobs[1].errorCode,'BAD_FILE'); assert.equal(h.downloads.activeCount(),0);
});
test('ambiguous or lost preparing reservations are retryable, never silently duplicated', async()=>{
  const storage=memoryStorage({requests:[],jobs:[{id:'old',file:file(),status:'preparing',downloadId:null,createdAt:Date.now(),startedAt:null}]});
  const h=setup({storage}); await h.queue.init(); await settle();
  assert.equal(h.downloads.calls.length,0); assert.equal((await h.queue.getState()).jobs[0].errorCode,'RECOVERY_REQUIRED');
});
test('invalid file metadata is rejected before creating any native download', async()=>{
  const h=setup(); await h.queue.init(); await assert.rejects(h.queue.enqueue([{...file(),downloadUrl:'https://evil.test/a'}],'one'));
  assert.equal(h.downloads.calls.length,0);
});
