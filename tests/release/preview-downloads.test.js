import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { createCourseScanner } from '../../src/runtime/scanner.js';
import { findPreviewDownload } from '../../src/runtime/preview.js';
import { previewMetadata } from '../../src/runtime/metadata.js';
import { validateFile, previewAssetUrl, previewPageUrl, availabilityCounts, MAX_PREVIEW_PAGES } from '../../src/runtime/policy.js';
import { fetchFileBytes, preflightFile } from '../../src/runtime/network.js';
import { inspectFileContent } from '../../src/runtime/file-content.js';
import { createArchive } from '../../src/runtime/archive.js';
import { createDownloadQueue } from '../../src/runtime/download-queue.js';
import { ORIGIN, LIST, file, listHTML, previewHTML, response, fixtureBytes, nativeDownloads, memoryStorage, waitFor, bookmarkletHarness } from './helpers.js';
import { WHOLE_PDF, MEDIA_URL, PAGE_URLS, VIEWER_URL, sourceFile, previewFile, slideHTML, mediaHTML, pagePNG, mediaBytes } from './preview-helpers.js';
const parse = html => new JSDOM(html).window.document;
const imageResponse = url => response(pagePNG(url === PAGE_URLS[0] ? 40 : 30, url === PAGE_URLS[0] ? 30 : 40), url, 'image/png');

test('a platform whole PDF is preferred over page images and downloaded byte-for-byte', async () => {
  const f = previewFile(slideHTML(PAGE_URLS, '<script>var pdfUrl="' + WHOLE_PDF + '";</script>'));
  assert.equal(f.preview.kind, 'pdf'); assert.equal(f.name, 'Lesson One.pdf'); assert.equal(f.sizeBytes, null);
  const requests = [];
  const bytes = await fetchFileBytes(f, { fetchImpl: async url => { requests.push(url); return response(fixtureBytes('sample.pdf'), url, 'application/pdf'); } });
  assert.deepEqual(requests, [WHOLE_PDF]); assert.deepEqual(Buffer.from(bytes), fixtureBytes('sample.pdf'));
});
test('an existing whole PDF does not depend on a valid image manifest', () => {
  const f = previewFile('<div id="ppt-img"></div><script>$("#ppt-img").slidePPT({});var DEFAULT_URL="' + WHOLE_PDF + '";</script>');
  assert.equal(f.preview.kind, 'pdf');
});
test('PDF.js encoded file parameters resolve to the original platform PDF response', () => {
  const f = previewFile('<iframe src="/meol/viewer/web/viewer.html?file=' + encodeURIComponent(WHOLE_PDF) + '"></iframe>');
  assert.equal(f.downloadUrl, WHOLE_PDF);
});
test('original download controls still take precedence over converted preview data', async t => {
  const win = new JSDOM(listHTML(), { url: LIST }).window; t.after(() => win.close());
  const requested = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => { requested.push(url); return response(previewHTML(file()) + mediaHTML(), url); } }).scan({ mode: 'directory' });
  assert.equal(result.files[0].downloadUrl, file().downloadUrl); assert.notEqual(result.files[0].downloadKind, 'preview'); assert.equal(requested.length, 1);
});
test('metadata scans resolve nested preview manifests without reading any file or image body', async t => {
  const original = sourceFile(); const win = new JSDOM(listHTML([original]), { url: LIST }).window; t.after(() => win.close()); const requests = [];
  const result = await createCourseScanner({ window: win, fetchImpl: async url => {
    requests.push(url); if (url === original.previewUrl) return response(previewHTML(original, false) + '<iframe src="' + VIEWER_URL + '"></iframe>', url);
    assert.equal(url, VIEWER_URL); return response(slideHTML(), url);
  } }).scan({ mode: 'directory' });
  assert.deepEqual(requests, [original.previewUrl, VIEWER_URL]); const f = result.files[0];
  assert.equal(f.downloadable, true); assert.equal(f.preview.kind, 'slides'); assert.equal(f.name, 'Lesson One.pdf'); assert.equal(f.originalName, 'Lesson One.pptx');
  assert.deepEqual(availabilityCounts([f]), { total: 1, downloadable: 1, previewOnly: 0, unverified: 0, previewDownloads: 1 });
});
test('inline units bind preview downloads to their real course page and file ID', async t => {
  const url = ORIGIN + '/meol/buildless/resFolderViewList.do?folderid=8&lid=42&columnId=3';
  const win = new JSDOM('<div id="dowload-preview">' + previewHTML(sourceFile(), false) + '<iframe src="/meol/common/script/preview/preview.jsp?fileid=1"></iframe></div>', { url }).window; t.after(() => win.close());
  const requested=[]; const result = await createCourseScanner({ window: win, fetchImpl: async value => { requested.push(value); return response(slideHTML(), value); } }).scan({ mode: 'unit-current' });
  assert.equal(requested.length, 1); assert.equal(result.files[0].id, 'preview-only:42:1'); assert.equal(validateFile(result.files[0], '42').downloadKind, 'preview');
});
test('direct player media retains its MP4 filename, not a fabricated original endpoint', async () => {
  const f = previewFile(mediaHTML(), sourceFile({ originalName: 'Lecture Video.mp4', sizeBytes: 99999999, sizeExact: true }));
  assert.equal(f.preview.kind, 'media'); assert.equal(f.downloadUrl, MEDIA_URL); assert.equal(f.name, 'Lecture Video.mp4'); assert.equal(f.sizeExact, false);
  const bytes = await fetchFileBytes(f, { fetchImpl: async url => response(mediaBytes(), url, 'video/mp4') }); assert.deepEqual(bytes, mediaBytes());
});
test('online text is a UTF-8 download with a clean filename without executing embedded scripts', async t => {
  const online = ORIGIN + '/meol/common/script/onlinepreview.jsp?lid=42&resid=101';
  const win = new JSDOM('<table class="valuelist"><tr><td><a href="' + online + '">阅读材料</a></td></tr></table>', { url: LIST }).window; t.after(() => win.close());
  const result = await createCourseScanner({ window: win, fetchImpl: async url => response('<input type="hidden" id="26_content" value="&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;">', url) }).scan({ mode: 'directory' });
  const f=result.files[0]; assert.equal(f.name, '阅读材料.txt'); const bytes=await fetchFileBytes(f, { fetchImpl: async()=>{throw Error('text does not fetch a body');} });
  assert.equal(new TextDecoder().decode(bytes), '第一段\n第二段\n');
});
test('mixed-media online lessons are not falsely exported as complete text', () => {
  const f=sourceFile({ id:'online-only:42:101', previewUrl:'', sourceUrl:ORIGIN+'/meol/common/script/onlinepreview.jsp?lid=42&resid=101' });
  assert.equal(previewFile('<input type="hidden" id="1_content" value="&lt;p&gt;内容&lt;/p&gt;&lt;img src=x&gt;">',f),null);
});
test('generated PDF preserves pages and records its image source without altering the filename', async () => {
  const f=previewFile(), requests=[], progress=[];
  const bytes=await fetchFileBytes(f,{fetchImpl:async url=>{requests.push(url);return imageResponse(url);},onProgress:p=>progress.push(p.page)});
  assert.deepEqual(requests,PAGE_URLS); assert.deepEqual(progress,[1,2]); const doc=await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(),2); assert.deepEqual(doc.getPages().map(p=>p.getSize()),[{width:30,height:22.5},{width:22.5,height:30}]); assert.equal(doc.getTitle(),f.name); assert.match(doc.getSubject(),/不是原始/);
  assert.equal(inspectFileContent(bytes,f).level,'document-structure');
});
test('a missing preview page aborts the entire document instead of saving a partial PDF', async () => {
  await assert.rejects(fetchFileBytes(previewFile(),{fetchImpl:async url=>url===PAGE_URLS[0]?imageResponse(url):response('missing',url,'text/plain',404)}),e=>e.code==='PREVIEW_PAGE_FAILED'&&/第 2 \/ 2 页/.test(e.message));
});
test('corrupt preview images and HTML error pages cannot be embedded as PDF pages',async()=>{
  for(const body of ['<html>登录</html>',pagePNG().slice(0,-4)]) await assert.rejects(fetchFileBytes(previewFile(),{fetchImpl:async url=>response(body,url,'image/png')}),{code:'PREVIEW_PAGE_FAILED'});
});
test('preview generation respects byte budgets and cancellation without requesting remaining pages',async()=>{
  await assert.rejects(fetchFileBytes(previewFile(),{maxBytes:1,fetchImpl:async url=>imageResponse(url)}),{code:'OVER_BUDGET'});
  const controller=new AbortController();let requested=0;
  await assert.rejects(fetchFileBytes(previewFile(),{signal:controller.signal,fetchImpl:async url=>{requested++;controller.abort();return imageResponse(url);}}),{code:'CANCELLED'}); assert.equal(requested,1);
});
test('complete generated previews are reused by individual downloads, not submitted as JSP URLs',async()=>{
  const probe=await preflightFile(previewFile(),{fetchImpl:async url=>imageResponse(url),includeBytes:true});
  assert.equal(probe.requiresLocalDownload,true); assert.equal(probe.sampleComplete,true); assert.equal(probe.bytes.length,probe.expectedFileBytes); assert.equal(probe.contentType,'application/pdf'); assert.equal(probe.warnings[0].code,'PREVIEW_COPY');
});
test('ZIP entries use actual preview formats and retain whole PDF bytes',async()=>{
  const f=previewFile('<embed src="'+WHOLE_PDF+'">'); const result=await createArchive([f],{fetchImpl:async url=>response(fixtureBytes('sample.pdf'),url,'application/pdf')});
  const entries=unzipSync(new Uint8Array(await result.blob.arrayBuffer())); assert.deepEqual(Object.keys(entries),['课程资源/Lesson One.pdf']); assert.deepEqual(Buffer.from(Object.values(entries)[0]),fixtureBytes('sample.pdf')); assert.equal(result.warnings.length,0);
});
test('preview responses may use a server-generated name, but not a different format',async()=>{
  const f=previewFile('<embed src="'+WHOLE_PDF+'">');
  const fetchImpl=async()=>{const r=response(fixtureBytes('sample.pdf'),WHOLE_PDF,'application/pdf');r.headers.set('content-disposition','inline; filename="generated.pdf"');return r;};
  await fetchFileBytes(f,{fetchImpl});
  await assert.rejects(fetchFileBytes(f,{fetchImpl:async()=>{const r=await fetchImpl();r.headers.set('content-disposition','attachment; filename="wrong.pptx"');return r;}}),{code:'FILENAME_MISMATCH'});
});
test('full MP4 validation rejects a truncated media container or PDF renamed to MP4',()=>{
  const f=previewFile(mediaHTML()); assert.equal(inspectFileContent(mediaBytes(),f).level,'container-structure');
  assert.throws(()=>inspectFileContent(mediaBytes().slice(0,-1),f),{code:'BAD_FILE'});assert.throws(()=>inspectFileContent(fixtureBytes('sample.pdf'),f),{code:'BAD_FILE'});
});
test('preview provenance cannot be changed to another course, source resource or arbitrary URL',()=>{
  const f=previewFile(); assert.throws(()=>validateFile({...f,lid:'43'}),{code:'WRONG_COURSE'});
  assert.throws(()=>validateFile({...f,fileid:'2'}),{code:'INVALID_FILE'});
  assert.throws(()=>validateFile({...f,name:'Lesson One.pptx'}),{code:'INVALID_FILE'});
  for(const url of ['https://evil.example/file.pdf',ORIGIN+'/meol/homepage/common/logout.jsp',ORIGIN+'/meol/data/convert/2026/10/9/../../secret.pdf',WHOLE_PDF+'?target=x','file:///C:/secret.pdf','data:application/pdf,x']) assert.throws(()=>previewAssetUrl(url,f,{kind:'pdf'}));
  assert.throws(()=>previewPageUrl(VIEWER_URL.replace('fileid=1','fileid=2'),f),{code:'WRONG_RESOURCE'});
  assert.throws(()=>previewPageUrl(VIEWER_URL+'&fileid=2',f),{code:'INVALID_URL'});
});
test('cross-resource PDF endpoints and external player media are never accepted',()=>{
  assert.throws(()=>previewAssetUrl(ORIGIN+'/meol/analytics/resPdfShow.do?resId=999&lid=42',sourceFile(),{kind:'pdf'}),{code:'WRONG_RESOURCE'});
  assert.equal(previewFile(mediaHTML('https://other.example/video.mp4')),null);
});
test('empty, overlong or foreign page manifests never yield a misleading preview PDF',()=>{
  for(const urls of [[],[PAGE_URLS[0],'',PAGE_URLS[1]],Array(MAX_PREVIEW_PAGES+1).fill(PAGE_URLS[0]),['https://evil.example/page.png']]) assert.throws(()=>previewFile(slideHTML(urls)));
});
test('preview download redirects are rejected before the bytes can be saved',async()=>{
  const f=previewFile('<embed src="'+WHOLE_PDF+'">'); await assert.rejects(fetchFileBytes(f,{fetchImpl:async()=>response(fixtureBytes('sample.pdf'),WHOLE_PDF.replace('complete','other'),'application/pdf')}),{code:'BAD_FILE'});
});
test('native queue downloads and verifies an extension-owned preview Blob, then releases it',async()=>{
  const f=previewFile(), native=nativeDownloads(), released=[];const storage=memoryStorage();const blob='blob:chrome-extension://abcdefghijklmnopabcdefghijklmnop/local-pdf';
  const queue=createDownloadQueue({storage,downloads:native.downloads,extensionId:'abcdefghijklmnopabcdefghijklmnop',preflight:async()=>({blobUrl:blob,expectedBytes:123,expectedFileBytes:123,sampleComplete:true}),releasePrepared:async id=>released.push(id),makeId:()=> 'preview-job'});
  await queue.enqueue([f],{requestId:'preview-1'});await waitFor(()=>native.calls.length===1); assert.equal(native.calls[0].url,blob);assert.equal(native.calls[0].filename,'课件/课程资源/Lesson One.pdf');
  Object.assign(native.items.get(1),{state:'complete',fileSize:123,totalBytes:123,exists:true});const jobs=await queue.refresh(); assert.equal(jobs[0].status,'done');assert.ok(released.includes('preview-job'));assert.equal(storage.peek().jobs[0].preflight.bytes,undefined);
});
test('native queue will not submit a preview JSP when local PDF generation returns no Blob',async()=>{
  const native=nativeDownloads();const queue=createDownloadQueue({storage:memoryStorage(),downloads:native.downloads,extensionId:'abcdefghijklmnopabcdefghijklmnop',preflight:async()=>({}),makeId:()=> 'bad-preview'});
  await queue.enqueue([previewFile()],{requestId:'bad-preview'});await waitFor(async()=> (await queue.getJobs())[0]?.status==='failed');assert.equal(native.calls.length,0);
});
test('bookmarklet UI selects preview copies and saves a whole PDF inside ZIP without image requests',async t=>{
  const f=sourceFile(); const h=await bookmarkletHarness(t,{html:listHTML([f]),fetchImpl:async url=>{
    if(url.includes('download_preview.jsp'))return response(previewHTML(f,false)+'<iframe src="/meol/viewer/web/viewer.html?file='+encodeURIComponent(WHOLE_PDF)+'"></iframe>',url);
    if(url===WHOLE_PDF)return response(fixtureBytes('sample.pdf'),url,'application/pdf');return response(listHTML([f]),url);
  }});
  await waitFor(()=>!h.panel.getElementById('btnScan').disabled);assert.equal(h.panel.querySelector('input[data-kind="file"]').disabled,false);assert.match(h.panel.getElementById('tree').textContent,/完整 PDF/);
  h.panel.getElementById('btnSelVis').click();h.panel.getElementById('btnDl').click();await waitFor(()=>h.blobs.length===1);
  const entries=unzipSync(new Uint8Array(await h.blobs[0].arrayBuffer()));assert.deepEqual(Object.keys(entries),['课程资源/Lesson One.pdf']);assert.deepEqual(Buffer.from(Object.values(entries)[0]),fixtureBytes('sample.pdf'));
  assert.equal(h.requests.some(r=>r.url.includes('_slide-')||r.url.includes('/download.jsp')),false);
});

test('Word rich previews become self-contained HTML with tables/images and no active scripts or external loads',async()=>{
  const image=ORIGIN+'/meol/data/convert/2026/10/9/word_image1.png';
  const html='<p onclick="alert(1)">保留正文</p><table><tr><td colspan="2">保留表格</td></tr></table><img src="'+image+'" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">链接</a>';
  const document=parse('<input type="hidden" id="88_content" value="'+html.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')+'">');
  const f=findPreviewDownload(document,sourceFile({originalName:'Lecture.docx'}),VIEWER_URL).file;
  assert.equal(f.name,'Lecture.html');assert.equal(f.preview.kind,'html');assert.deepEqual(f.preview.images,[image]);
  const bytes=await fetchFileBytes(f,{fetchImpl:async url=>{assert.equal(url,image);return response(pagePNG(),url,'image/png');}});const saved=new TextDecoder().decode(bytes);
  assert.match(saved,/<table>/);assert.match(saved,/data:image\/png;base64,/);assert.match(saved,/Content-Security-Policy/);assert.match(saved,/保留正文/);
  assert.doesNotMatch(saved,/<script|onclick|onerror|javascript:|buct-preview-image:|src="https?:/);
  assert.equal(inspectFileContent(bytes,f,{contentType:'text/html',disposition:'attachment'}).format,'html');
});
test('rich preview downloads refuse missing or external images rather than silently dropping them',async()=>{
  const html='<input type="hidden" id="88_content" value="&lt;p&gt;内容&lt;/p&gt;&lt;img src=&quot;'+ORIGIN+'/meol/data/convert/2026/10/9/word_image1.png&quot;&gt;">';
  const f=previewFile(html,sourceFile({originalName:'Lecture.docx'}));
  await assert.rejects(fetchFileBytes(f,{fetchImpl:async url=>response('missing',url,'text/plain',404)}),{code:'HTTP_ERROR'});
  assert.throws(()=>previewFile(html.replace(ORIGIN,'https://other.example'),sourceFile({originalName:'Lecture.docx'})),{code:'INVALID_URL'});
});

test('quoted PDF metadata and direct PDF.js calls keep the platform PDF ahead of slide images',()=>{
  for(const code of ['var config={"pdfUrl":"'+WHOLE_PDF+'"};','pdfjsLib.getDocument("'+WHOLE_PDF+'");']){
    assert.equal(previewFile(slideHTML(PAGE_URLS,'<script>'+code+'</script>')).downloadUrl,WHOLE_PDF);
  }
});
