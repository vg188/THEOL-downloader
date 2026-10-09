import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { buildReleaseExtension } from '../../scripts/build-release.mjs';
import { buildSite } from '../../web/build.mjs';
import { ROOT, file, listHTML, previewHTML, fixtureBytes } from '../release/helpers.js';
import { slideHTML, mediaHTML, pagePNG, mediaBytes, sourceStreamHTML, streamUrl } from '../release/preview-helpers.js';
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
const artifacts=join(ROOT,'output','playwright','preview-downloads');
const origin='http://course.buct.edu.cn';
const asset=name=>origin+'/meol/data/convert/2026/10/9/'+name;
const whole=asset('complete.pdf'), video=origin+'/dest/abc/lesson.mp4';
const pages=[asset('fallback_slide-1'),asset('fallback_slide-2')];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function jobsUntil(panel,predicate) {
  const deadline=Date.now()+60000;let jobs=[];
  while(Date.now()<deadline){jobs=await panel.evaluate(async()=> (await chrome.runtime.sendMessage({type:'GET_JOBS'})).jobs||[]);if(predicate(jobs))return jobs;await new Promise(r=>setTimeout(r,100));}
  throw Error('Preview jobs did not settle: '+JSON.stringify(jobs));
}
test('Chrome preview downloads prefer complete PDF, preserve local generated files across panel/worker closure, and verify saved bytes',{timeout:120000},async()=>{
  assert.ok(chrome,'Install Chrome or set CHROME_PATH');
  const source=(id,name)=>{const f=file(id,{name,originalName:name});f.previewUrl=f.previewUrl.replace('https:','http:');f.downloadUrl=f.downloadUrl.replace('https:','http:');return f;};
  const originals=[source(1,'Whole PDF.pptx'),source(2,'Slides Fallback.pptx'),source(3,'Video.mp4'),source(5,'Broken Pages.pptx'),source(6,'Word Rich Preview.docx'),source(7,'Original Stream.pptx'),source(8,'Wrong Stream.pptx')];
  const online=origin+'/meol/common/script/onlinepreview.jsp?lid=42&resid=104';
  const extra='<tr><td><a href="'+online+'">在线文本</a></td></tr>';
  const requests=[];let imageDelay=true;
  const server=createServer((req,res)=>{
    const url=new URL(req.url,origin);requests.push({url:url.href,range:req.headers.range||''});
    const send=(body,type='text/html; charset=utf-8',status=200)=>{res.writeHead(status,{'content-type':type,'content-length':Buffer.byteLength(body)});res.end(body);};
    if(url.pathname.endsWith('/listview.jsp'))return send(listHTML(originals,extra).replace('测试课程','预览验收课程'));
    if(url.pathname.endsWith('/download_preview.jsp')){
      const f=originals.find(f=>f.fileid===url.searchParams.get('fileid'));if(!f)return send('missing','text/plain',404);
      return send(previewHTML(f,false)+(['7','8'].includes(f.fileid)?sourceStreamHTML(f):'')+(f.fileid==='3'?mediaHTML(video):'<iframe src="preview.jsp?fileid='+f.fileid+'&resid='+f.resid+'&lid=42"></iframe>'));
    }
    if(url.pathname.endsWith('/preview/preview.jsp')){
      const id=url.searchParams.get('fileid');
      if(id==='1')return send(slideHTML([asset('must-not-fetch_slide-1')],'<script>var pdfUrl="'+whole+'";</script>'));
      if(id==='2')return send(slideHTML(pages));
      if(id==='5')return send(slideHTML([asset('missing_slide-1')]));
      if(id==='6')return send('<input type="hidden" id="88_content" value="&lt;p&gt;富文本正文&lt;/p&gt;&lt;table&gt;&lt;tr&gt;&lt;td&gt;表格&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;img src=&quot;'+asset('word_image1.png')+'&quot;&gt;">');
    }
    if(url.pathname.endsWith('/onlinepreview.jsp'))return send('<input type="hidden" id="26_content" value="&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;">');
    if(url.pathname==='/meol/analytics/resPdfShow.do'&&!url.searchParams.has('file')){
      const body=fixtureBytes(url.searchParams.get('resId')==='107'?'sample.pptx':'sample.docx');
      res.writeHead(200,{'content-type':'application/pdf;charset=UTF-8'});res.write(body.subarray(0,100));return res.end(body.subarray(100));
    }
    if(url.href===whole)return send(fixtureBytes('sample.pdf'),'application/pdf');
    if(url.href===video)return send(mediaBytes(),'video/mp4');
    if(url.href===asset('word_image1.png'))return send(pagePNG(),'image/png');
    if(pages.includes(url.href))return setTimeout(()=>send(pagePNG(url.href===pages[0]?40:30,url.href===pages[0]?30:40),'image/png'),imageDelay?1200:0);
    return send('missing','text/plain',404);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  await mkdir(artifacts,{recursive:true});const profile=await mkdtemp(join(artifacts,'profile-')),downloads=await mkdtemp(join(artifacts,'files-')),managed=await mkdtemp(join(artifacts,'managed-'));
  await mkdir(join(profile,'Default'));await writeFile(join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloads,prompt_for_download:false,directory_upgrade:true},profile:{default_content_setting_values:{automatic_downloads:1}}}));
  const extension=await buildReleaseExtension({output:join(ROOT,'dist','test-preview-downloads','extension')});let context;
  try{
    context=await chromium.launchPersistentContext(profile,{executablePath:chrome,headless:true,viewport:{width:1280,height:920},acceptDownloads:true,downloadsPath:managed,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--enable-automation','--no-proxy-server','--host-resolver-rules=MAP course.buct.edu.cn 127.0.0.1:'+server.address().port,'--disable-features=HttpsUpgrades']});
    const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});const {id}=await cdp.send('Extensions.loadUnpacked',{path:extension});
    const course=context.pages()[0];await course.goto(origin+'/meol/common/script/listview.jsp?folderid=0&lid=42');
    let panel=await context.newPage();const errors=[];panel.on('pageerror',e=>errors.push(e.message));await panel.goto('chrome-extension://'+id+'/panel.html');
    await panel.waitForFunction(()=>document.querySelectorAll('input[data-kind="file"]').length===8&&!document.querySelector('#btnRescan').disabled);
    assert.equal(requests.some(r=>r.url.includes('/data/convert/')||r.url.includes('/dest/')||r.url.includes('/resPdfShow.do')),false,'scanning never downloads preview bodies');
    assert.equal(await panel.locator('input[data-kind="file"]:disabled').count(),0);
    await panel.locator('#btnSelectVisible').click();
    await course.evaluate(() => { document.querySelector('table').replaceChildren(); history.replaceState(null, '', location.pathname + '?lid=42&folderid=99#browse'); });
    await panel.locator('#btnDownload').click();
    await jobsUntil(panel,jobs=>jobs.some(j=>j.file.fileid==='2'&&j.status==='preparing'));
    await panel.close();
    const targets=await cdp.send('Target.getTargets');const worker=targets.targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'+id+'/'));
    if(worker)await cdp.send('Target.closeTarget',{targetId:worker.targetId});
    panel=await context.newPage();panel.on('pageerror',e=>errors.push(e.message));await panel.goto('chrome-extension://'+id+'/panel.html');
    const jobs=await jobsUntil(panel,jobs=>jobs.length===8&&jobs.every(j=>['done','failed','cancelled'].includes(j.status)));imageDelay=false;
    await writeFile(join(artifacts,'native-preview-debug.json'),JSON.stringify({jobs,requests},null,2));
    for(const job of jobs){
      if(job.file.fileid==='5'){assert.equal(job.status,'failed');assert.equal(job.errorCode,'PREVIEW_PAGE_FAILED');continue;}
      if(job.file.fileid==='8'){assert.equal(job.status,'failed');assert.equal(job.errorCode,'BAD_FILE');continue;}
      assert.equal(job.status,'done',JSON.stringify(job));const target=await realpath(job.actualFilename),base=await realpath(downloads),rel=relative(base,target);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
      const bytes=await readFile(target);assert.equal(bytes.length,job.fileSize);
      if(job.file.fileid==='7'){assert.doesNotMatch(job.actualFilename,/预览版/);assert.ok(job.nativeUrl.startsWith('blob:chrome-extension://'));assert.equal(job.preflight.sampleComplete,true);assert.equal(hash(bytes),hash(fixtureBytes('sample.pptx')));continue;}
      assert.doesNotMatch(job.actualFilename,/预览版/);
      if(job.file.fileid==='1')assert.equal(hash(bytes),hash(fixtureBytes('sample.pdf')));
      else if(job.file.fileid==='2'){const doc=await PDFDocument.load(bytes);assert.equal(doc.getPageCount(),2);assert.deepEqual(doc.getPages().map(p=>p.getSize()),[{width:30,height:22.5},{width:22.5,height:30}]);}
      else if(job.file.fileid==='3')assert.equal(hash(bytes),hash(mediaBytes()));
      else if(job.file.fileid==='6'){assert.match(new TextDecoder().decode(bytes),/富文本正文/);assert.match(new TextDecoder().decode(bytes),/data:image\/png;base64,/);}
      else assert.equal(new TextDecoder().decode(bytes),'第一段\n第二段\n');
    }
    assert.equal(requests.some(r=>r.url.includes('must-not-fetch')||r.url.includes('/download.jsp')),false);
    assert.equal(requests.filter(r=>r.url===pages[0]).length,1,'worker recovery reuses the same offscreen render');
    assert.deepEqual(requests.filter(r=>r.url===streamUrl(originals.find(f=>f.fileid==='7'))).map(r=>r.range),[''],'native stream save reuses one fully validated response, no second download');
    await panel.screenshot({path:join(artifacts,'preview-extension.png'),fullPage:true});await panel.setViewportSize({width:390,height:900});assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await panel.screenshot({path:join(artifacts,'preview-extension-390.png'),fullPage:true});
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:managed,eventsEnabled:true});
    const site=await buildSite({output:join(ROOT,'dist','test-preview-downloads','site')});const bookmark=await readFile(join(site,'bookmarklet.txt'),'utf8');course.on('dialog',dialog=>dialog.accept());await course.bringToFront();
    await course.evaluate(href=>{const a=document.createElement('a');a.href=href;document.body.appendChild(a);a.click();a.remove();},bookmark);
    await course.waitForFunction(()=>document.getElementById('buct-tab-dl-host')&&!document.getElementById('buct-tab-dl-host').shadowRoot.getElementById('btnScan').disabled);
    await course.locator('#buct-tab-dl-host input[data-kind="file"][data-id="42:101:1"]').check();
    await course.locator('#buct-tab-dl-host input[data-kind="file"][data-id="42:107:7"]').check();
    const zipEvent=course.waitForEvent('download');await course.locator('#buct-tab-dl-host #btnDl').click();const download=await zipEvent;const archive=join(artifacts,'whole-platform-pdf.zip');await download.saveAs(archive);
    const entries=unzipSync(await readFile(archive));assert.deepEqual(Object.keys(entries),['课程资源/Whole PDF.pdf','课程资源/Original Stream.pptx']);assert.equal(hash(entries['课程资源/Whole PDF.pdf']),hash(fixtureBytes('sample.pdf')));assert.equal(hash(entries['课程资源/Original Stream.pptx']),hash(fixtureBytes('sample.pptx')));
    assert.equal(requests.some(r=>r.url.includes('must-not-fetch')),false);
    await course.screenshot({path:join(artifacts,'preview-bookmarklet.png'),fullPage:true});await course.setViewportSize({width:390,height:900});assert.ok(await course.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await course.screenshot({path:join(artifacts,'preview-bookmarklet-390.png'),fullPage:true});
    assert.deepEqual(errors,[]);await writeFile(join(artifacts,'preview-report.json'),JSON.stringify({chrome:context.browser().version(),wholePdfSha256:hash(fixtureBytes('sample.pdf')),originalStreamSha256:hash(fixtureBytes('sample.pptx')),wrongOfficeStreamRefused:true,imageFallbackPages:2,panelAndWorkerClosureRecovered:true,missingPageRefused:true,jobs:jobs.map(j=>({name:j.name,status:j.status,bytes:j.fileSize,code:j.errorCode}))},null,2));
  }finally{
    await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const base=await realpath(artifacts),target=await realpath(profile),rel=relative(base,target);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'only delete this test profile');await rm(target,{recursive:true,force:true});
  }
});
