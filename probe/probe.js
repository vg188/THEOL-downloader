const SCHOOL_ORIGIN = 'https://course.buct.edu.cn';
const LIST_PATH = '/meol/common/script/listview.jsp';
const PREVIEW_PATH = '/meol/common/script/preview/download_preview.jsp';

function numericParam(url, key, allowZero = false) {
  const values = url.searchParams.getAll(key);
  const pattern = allowZero ? /^(0|[1-9]\d{0,11})$/ : /^[1-9]\d{0,11}$/;
  return values.length === 1 && pattern.test(values[0]) ? values[0] : null;
}

function canonicalPreview(value, base, expectedCourse) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== SCHOOL_ORIGIN || url.username || url.password || url.pathname.replace(/;jsessionid=[^/;]*$/i, '') !== PREVIEW_PATH) return null;
  const fileId = numericParam(url, 'fileid'), resId = numericParam(url, 'resid'), courseId = numericParam(url, 'lid');
  if (!fileId || !resId || !courseId || courseId !== expectedCourse) return null;
  const canonical = new URL(PREVIEW_PATH, SCHOOL_ORIGIN);
  canonical.search = new URLSearchParams({ fileid:fileId, resid:resId, lid:courseId });
  return canonical.href;
}

function firstPreview(document, pageUrl) {
  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  if (url.origin !== SCHOOL_ORIGIN || url.pathname.replace(/;jsessionid=[^/;]*$/i, '') !== LIST_PATH) return null;
  const courseId = numericParam(url, 'lid'), folderId = numericParam(url, 'folderid', true);
  if (!courseId || folderId === null) return null;
  for (const anchor of document.querySelectorAll('a[href]')) {
    const previewUrl = canonicalPreview(anchor.getAttribute('href'), pageUrl, courseId);
    if (previewUrl) return { previewUrl };
  }
  return { previewUrl:null };
}

const MAX_METADATA_BYTES = 64 * 1024;
const result = { inline: true, remote: true, frame: false, metadata: false, worker: false, details: [] };

function collectFrames(root) {
  const found = [];
  const visit = current => {
    let document;
    try { document = current.document; void current.location.href; } catch { return; }
    found.push({ window: current, document, url: current.location.href });
    for (let index = 0; index < current.frames.length; index++) visit(current.frames[index]);
  };
  visit(root);
  return found;
}

async function readBounded(response, limit) {
  if (!response.body) throw new Error('元数据响应为空');
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (length <= limit) {
      const { done, value } = await reader.read();
      if (done) return length;
      length += value?.byteLength || 0;
      if (length > limit) throw new Error('元数据页面超过 64 KiB，已停止读取');
    }
  } finally { await reader.cancel().catch(() => {}); }
  return length;
}

async function checkWorker() {
  const source = new Blob(["postMessage('ok')"], { type: 'text/javascript' });
  const url = URL.createObjectURL(source);
  try {
    await new Promise((resolve, reject) => {
      const worker = new Worker(url);
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker 超时')); }, 2000);
      worker.onmessage = event => { clearTimeout(timer); worker.terminate(); event.data === 'ok' ? resolve() : reject(new Error('Worker 返回异常')); };
      worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('Worker 被阻止')); };
    });
    result.worker = true;
  } catch (error) { result.details.push(error.message); }
  finally { URL.revokeObjectURL(url); }
}

function render() {
  document.getElementById('__theol_probe_v1__')?.remove();
  const host = document.createElement('section');
  host.id = '__theol_probe_v1__';
  Object.assign(host.style, { position:'fixed', zIndex:'2147483647', right:'20px', top:'20px', width:'min(380px,calc(100vw - 40px))', padding:'18px', boxSizing:'border-box', border:'1px solid #d7d7d7', borderRadius:'12px', background:'#fff', color:'#171717', boxShadow:'0 16px 50px #0003', font:'14px/1.55 system-ui' });
  const title = document.createElement('strong'); title.textContent = 'THEOL 书签兼容性测试';
  const list = document.createElement('ul');
  for (const [key, label] of [['inline','书签内联代码'],['remote','GitHub Pages 远程脚本'],['frame','当前同源资源 frame'],['metadata','预览元数据请求'],['worker','Blob Worker']]) {
    const item = document.createElement('li'); item.textContent = label + '：' + (result[key] ? '成功' : '失败'); list.append(item);
  }
  const privacy = document.createElement('p'); privacy.textContent = '测试没有下载课件正文，也没有上传测试结果。';
  const detail = document.createElement('p'); detail.textContent = result.details.join('；'); detail.hidden = !result.details.length;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.onclick = () => host.remove();
  host.append(title, list, privacy, detail, close); document.documentElement.append(host);
}

async function run() {
  try {
    const frames = collectFrames(window);
    result.frame = frames.length > 1;
    const candidates = frames.map(frame => ({ frame, directory: firstPreview(frame.document, frame.url) })).filter(item => item.directory);
    if (!candidates.length) throw new Error('没有找到当前课件目录，请进入课程资源目录后重试');
    result.frame = true;
    const first = candidates[0].directory;
    if (!first) throw new Error('当前目录没有可测试的资源元数据');
    const response = await fetch(first.previewUrl, { credentials:'include', redirect:'manual' });
    if (!response.ok || response.type === 'opaqueredirect' || response.status === 0 || response.redirected) throw new Error('预览元数据请求失败或登录已失效');
    await readBounded(response, MAX_METADATA_BYTES);
    result.metadata = true;
  } catch (error) { result.details.push(error.message || '元数据测试失败'); }
  await checkWorker();
  render();
}

void run();
