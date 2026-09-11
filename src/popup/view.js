import { createSelection, formatBytes } from './model.js';
const ACTIVE = new Set(['queued','preparing','downloading']);
const LABELS = {queued:'排队中',preparing:'校验中',downloading:'下载中',complete:'已完成',failed:'失败'};

export async function mountPopup({ document, send, subscribe = () => () => {}, activeTab }) {
  const $ = id => document.getElementById(id);
  const selection = createSelection(), fileRows = new Map(), jobRows = new Map(), disposers = [];
  let state = { scan: {id:'',phase:'idle',files:[],failures:[],total:0,processed:0,skipped:0}, queue:{jobs:[]}, page:{} };
  let tab = 'files', format = 'all', query = '', pending = false, destroyed = false;
  let refreshPromise, queuedRefresh = false, queuedCheck = false;
  const text = (node,value) => { const next=String(value ?? ''); if(node.textContent !== next) node.textContent=next; };
  function make(tag,className,content) { const node=document.createElement(tag); if(className)node.className=className; if(content!=null)text(node,content);return node; }
  function listen(node,type,handler) { node.addEventListener(type,handler); disposers.push(()=>node.removeEventListener(type,handler)); }
  function notify(message='') { text($('notice'),message);$('notice').hidden=!message; }
  async function request(message) { const reply=await send(message); if(!reply?.ok)throw new Error(reply?.error?.message || '扩展暂时不可用，请关闭面板后重试');return reply.data; }
  function apply(data) {
    if(data.scan){state.scan=data.scan;selection.reset(`${data.scan.id}|${data.scan.context?.key || ''}`);}
    if(data.queue)state.queue=data.queue;
    if(data.page)state.page=data.page;
  }
  async function action(work) {
    if(pending)return;pending=true;notify();render();
    try { await work(); } catch(error) {notify(error.message || '操作未完成，请重试');}
    finally {pending=false;render();}
  }
  function reconcile(list,map,records,create,update) {
    const keep=new Set(records.map(r=>r.id));
    for(const [id,row] of map)if(!keep.has(id)){row.remove();map.delete(id);}
    records.forEach((record,index)=>{
      let row=map.get(record.id);if(!row){row=create(record);map.set(record.id,row);}
      update(row,record);
      if(list.children[index]!==row)list.insertBefore(row,list.children[index] || null);
    });
  }
  function createFile(file) {
    const row=make('li','file-row');row.dataset.id=file.id;
    const label=make('label'), checkbox=make('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label',`选择 ${file.name}`);
    checkbox.addEventListener('change',()=>{selection.toggle(file.id,checkbox.checked);render();});
    const icon=make('span','format-icon',file.extension.toUpperCase());icon.dataset.extension=file.extension;icon.setAttribute('aria-hidden','true');
    const copy=make('span','file-copy'), name=make('span','file-name',file.name), meta=make('span','file-meta');name.title=file.name;
    const status=make('span','file-status');copy.append(name,meta,status);label.append(checkbox,icon,copy);row.append(label);
    return row;
  }
  function createJob(job) {
    const row=make('li','job-row'), top=make('div','job-top'), copy=make('div','job-copy');
    copy.append(make('p','file-name'),make('p','file-meta'));
    const actions=make('div','job-actions');actions.append(make('p','job-status'));
    const button=make('button','text-button');button.type='button';
    button.addEventListener('click',()=>action(async()=>{
      const current=state.queue.jobs.find(j=>j.id===job.id);
      if(current?.status==='failed')state.queue=await request({type:'RETRY_FAILED',ids:[job.id]});
      else if(current?.status==='complete')await request({type:'SHOW_DOWNLOAD',id:job.id});
    }));
    actions.append(button);top.append(copy,actions);
    const progress=make('progress');progress.setAttribute('aria-label',`${job.file.name} 下载进度`);
    row.append(top,progress,make('p','job-error'));return row;
  }
  function render() {
    if(destroyed)return;
    const scan=state.scan, files=scan.files || [], jobs=state.queue.jobs || [];
    const busy=new Set(jobs.filter(j=>ACTIVE.has(j.status)).map(j=>j.file.id));
    for(const id of busy)selection.toggle(id,false);
    const shown=selection.visible(files,query,format), selectable=shown.filter(f=>!busy.has(f.id));
    const selected=new Set(selection.selectedIds()), course=state.page.context?.courseName || scan.context?.courseName;
    const scanning=scan.phase==='scanning', canChoose=scan.phase==='ready' && !state.page.error;
    text($('course-name'),course || '等待课程页面');$('course-name').title=course || '';
    text($('scope-copy'),'只扫描当前已加载的列表');
    $('scan-button').disabled=pending || scanning || !state.page.context || Boolean(state.page.error);
    text($('scan-label'),scanning ? '扫描中…' : scan.id ? '重新扫描' : '扫描课件');
    text($('files-count'),files.length);text($('jobs-count'),jobs.length);
    for(const kind of ['files','history']) {
      const active=tab===kind;$(`${kind}-tab`).setAttribute('aria-selected',String(active));$(`${kind}-tab`).tabIndex=active?0:-1;$(`${kind}-panel`).hidden=!active;
    }
    for(const button of document.querySelectorAll('[data-format]'))button.setAttribute('aria-pressed',String(button.dataset.format===format));
    text($('visible-count'),`${shown.length} 项`);
    const all=$('select-all');all.disabled=!canChoose || !selectable.length || pending;
    all.checked=selectable.length>0 && selectable.every(f=>selected.has(f.id));
    all.indeterminate=!all.checked && selectable.some(f=>selected.has(f.id));
    text($('scan-status'),scanning ? `${scan.processed || 0} / ${scan.total || 0} 正在识别` : scan.phase==='ready' ? `${files.length} 份课件${scan.skipped ? ` · 跳过 ${scan.skipped}` : ''}` : scan.phase==='error' ? '扫描未完成' : '尚未扫描');
    $('scan-progress').hidden=!scanning;$('scan-progress').max=Math.max(scan.total || 0,1);$('scan-progress').value=scan.processed || 0;
    reconcile($('file-list'),fileRows,shown,createFile,(row,file)=>{
      const activeJob=[...jobs].reverse().find(j=>j.file.id===file.id && j.status!=='failed');
      row.classList.toggle('selected',selected.has(file.id));row.classList.toggle('busy',busy.has(file.id));
      const checkbox=row.querySelector('input');checkbox.checked=selected.has(file.id);checkbox.disabled=!canChoose || pending || busy.has(file.id);
      text(row.querySelector('.file-meta'),`${file.extension.toUpperCase()} · ${file.sizeText}`);
      text(row.querySelector('.file-status'),activeJob ? LABELS[activeJob.status] : '');
    });
    $('empty-state').hidden=shown.length>0;
    let title='先扫描，再挑选', description='进入课程资源目录，点击“扫描课件”。扫描不会自动下载文件。';
    if(state.page.error){title='先打开课件目录';description=state.page.error.message;}
    else if(scanning){title='正在读取课件信息';description='正在核对原文件名和下载入口，请稍候。';}
    else if(scan.phase==='error'){title='这次扫描没有完成';description=scan.message || '请重新扫描当前列表。';}
    else if(scan.phase==='ready' && files.length){title='没有匹配的课件';description='换个关键词，或切换到“全部”格式。已选的其他文件会保留。';}
    else if(scan.phase==='ready'){title=scan.failures?.length?'暂时没能识别课件':'这个目录没有课件';description=scan.failures?.length?'请查看下方原因，确认登录状态后重新扫描。':'首版只读取当前列表。请进入包含 PDF 或 PPT 的子目录后重新扫描。';}
    text($('empty-title'),title);text($('empty-copy'),description);$('skeleton').hidden=!scanning;
    const failures=scan.failures || [];$('scan-failures').hidden=!failures.length;text($('failure-summary'),`${failures.length} 个资源未能识别`);
    const failureList=$('failure-list');
    const failureKey=JSON.stringify(failures);
    if(failureList.dataset.key!==failureKey){failureList.replaceChildren(...failures.map(f=>make('li','',`${f.title}：${f.message}`)));failureList.dataset.key=failureKey;}
    const running=jobs.filter(j=>ACTIVE.has(j.status)).length, complete=jobs.filter(j=>j.status==='complete').length;
    text($('history-summary'),jobs.length?`${running} 项进行中 · ${complete} 项已完成`:'本次浏览器会话的下载记录');
    $('retry-all').disabled=pending || !jobs.some(j=>j.status==='failed');$('history-empty').hidden=jobs.length>0;
    reconcile($('job-list'),jobRows,[...jobs].reverse(),createJob,(row,job)=>{
      text(row.querySelector('.file-name'),job.file.name);row.querySelector('.file-name').title=job.file.name;
      const bytes=job.status==='downloading' ? job.totalBytes>0?` · ${formatBytes(job.bytesReceived)} / ${formatBytes(job.totalBytes)}`:' · 正在传输' : '';
      text(row.querySelector('.file-meta'),`${job.file.courseName} · ${job.file.sizeText}${bytes}`);
      const status=row.querySelector('.job-status');text(status,LABELS[job.status] || '等待');status.dataset.status=job.status;
      const button=row.querySelector('button');button.hidden=!['failed','complete'].includes(job.status);button.disabled=pending;
      text(button,job.status==='failed'?'重试':'在文件夹中显示');button.setAttribute('aria-label',`${job.status==='failed'?'重试':'在文件夹中显示'} ${job.file.name}`);
      const progress=row.querySelector('progress');progress.hidden=job.status!=='downloading' || job.totalBytes<=0;progress.max=Math.max(job.totalBytes || 0,1);progress.value=job.bytesReceived || 0;
      const error=row.querySelector('.job-error');error.hidden=job.status!=='failed';text(error,job.error || '');
    });
    if(tab==='files') {
      const hiddenSelected=[...selected].filter(id=>!shown.some(f=>f.id===id)).length;
      text($('selection-summary'),selected.size ? `已选 ${selected.size} 份${hiddenSelected?`（另有 ${hiddenSelected} 份已隐藏）`:''}`:'尚未选择课件');
      $('download-button').disabled=pending || !canChoose || !selected.size;
      text($('download-label'),pending?'正在提交…':selected.size?`下载所选（${selected.size}）`:'下载所选');
      text($('save-hint'),`保存到 Chrome 下载目录 / ${course || '课程名'}`);
    } else {
      text($('selection-summary'),running ? `${running} 项任务会在后台继续` : `${complete} 项下载已完成`);
      $('download-button').disabled=pending;text($('download-label'),'打开 Chrome 下载页');text($('save-hint'),'关闭面板后，已提交的下载会继续');
    }
  }
  async function refresh(checkContext=false) {
    if(destroyed)return;
    if(refreshPromise){queuedRefresh=true;queuedCheck ||= checkContext;return refreshPromise;}
    refreshPromise=(async()=>{
      try{apply(await request({type:'GET_STATE',tabId:activeTab,checkContext}));render();}
      catch(error){notify(error.message);}
    })();
    await refreshPromise;refreshPromise=null;
    if(queuedRefresh){const next=queuedCheck;queuedRefresh=false;queuedCheck=false;void refresh(next);}
  }
  listen($('scan-button'),'click',()=>action(async()=>{
    selection.clear();const scan=await request({type:'START_SCAN',tabId:activeTab});apply({scan,page:{context:scan.context}});
  }));
  listen($('search-input'),'input',event=>{query=event.target.value;render();});
  for(const button of document.querySelectorAll('[data-format]'))listen(button,'click',()=>{format=button.dataset.format;render();});
  listen($('select-all'),'change',event=>{
    const busy=new Set(state.queue.jobs.filter(j=>ACTIVE.has(j.status)).map(j=>j.file.id));
    selection.toggleVisible(selection.visible(state.scan.files,query,format).filter(f=>!busy.has(f.id)),event.target.checked);render();
  });
  for(const kind of ['files','history'])listen($(`${kind}-tab`),'click',()=>{tab=kind;render();});
  listen(document.querySelector('[role=tablist]'),'keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();tab=event.key==='Home'?'files':event.key==='End'?'history':tab==='files'?'history':'files';render();$(`${tab}-tab`).focus();
  });
  listen($('download-button'),'click',()=>action(async()=>{
    if(tab==='history'){await request({type:'OPEN_DOWNLOADS'});return;}
    const ids=selection.selectedIds();if(!ids.length)return;
    state.queue=await request({type:'DOWNLOAD_SELECTED',tabId:activeTab,scanId:state.scan.id,ids,requestId:crypto.randomUUID()});
    selection.clear();tab='history';
  }));
  listen($('native-downloads'),'click',()=>action(()=>request({type:'OPEN_DOWNLOADS'})));
  listen($('retry-all'),'click',()=>action(async()=>{state.queue=await request({type:'RETRY_FAILED',ids:state.queue.jobs.filter(j=>j.status==='failed').map(j=>j.id)});}));
  const unsubscribe=subscribe(()=>{void refresh(false);});
  const timer=setInterval(()=>{if(!pending && state.queue.jobs.some(j=>ACTIVE.has(j.status)))void refresh(false);},1500);
  render();await refresh(true);
  return { refresh, destroy(){destroyed=true;clearInterval(timer);unsubscribe?.();for(const dispose of disposers)dispose();} };
}
