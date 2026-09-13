import { classifyNavigation, groupRouteSignatures, routeSignature } from './route-signature.js';

const SCHOOL_ORIGIN = 'https://course.buct.edu.cn';
const PREVIEW_PATH = '/meol/common/script/preview/download_preview.jsp';
const MAX_METADATA_BYTES = 64 * 1024;
const HOST_ID = '__theol_probe_v1__';
function cleanPath(pathname) {
  return pathname.replace(/;[^/]*/g, '');
}


function numericParam(url, key) {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && /^[1-9]\d{0,11}$/.test(values[0]) ? values[0] : null;
}

function canonicalPreview(value, base, expectedCourse) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== SCHOOL_ORIGIN || url.protocol !== 'https:' || url.username || url.password || cleanPath(url.pathname) !== PREVIEW_PATH) return null;
  const fileId = numericParam(url, 'fileid'), resId = numericParam(url, 'resid'), courseId = numericParam(url, 'lid');
  if (!fileId || !resId || !courseId || courseId !== expectedCourse) return null;
  const canonical = new URL(PREVIEW_PATH, SCHOOL_ORIGIN);
  canonical.search = new URLSearchParams({ fileid:fileId, resid:resId, lid:courseId });
  return canonical.href;
}

export function previewCandidates(document, pageUrl) {
  const found = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.getAttribute('href'), pageUrl); } catch { continue; }
    if (url.origin !== SCHOOL_ORIGIN || url.protocol !== 'https:' || url.username || url.password || cleanPath(url.pathname) !== PREVIEW_PATH) continue;
    const courseId = numericParam(url, 'lid');
    if (!numericParam(url, 'fileid') || !numericParam(url, 'resid') || !courseId) continue;
    const canonical = canonicalPreview(url.href, pageUrl, courseId);
    if (canonical && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

function accessibleRoot(current) {
  try { return current.top.location.origin === SCHOOL_ORIGIN ? current.top : current; } catch { return current; }
}

function collectFrames(root) {
  const found = [];
  const visit = current => {
    let document, url;
    try { document = current.document; url = new URL(current.location.href); } catch { return; }
    if (url.origin === SCHOOL_ORIGIN) found.push({ document, url:url.href });
    for (let index = 0; index < current.frames.length; index++) visit(current.frames[index]);
  };
  visit(root);
  return found;
}

function repeatedRoutes(frames) {
  const grouped = new Map();
  for (const frame of frames) {
    for (const item of groupRouteSignatures(frame.document, frame.url)) {
      const key = JSON.stringify([item.mechanism, item.endpoint, item.queryKeys]);
      const previous = grouped.get(key);
      if (previous) previous.count += item.count;
      else grouped.set(key, { ...item });
    }
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count || left.endpoint.localeCompare(right.endpoint)).slice(0, 10);
}

export function responseSignature(response) {
  const type = response.headers.get('content-type') || '';
  return {
    mimeFamily: /text\/html|application\/xhtml\+xml/i.test(type) ? 'html' : 'other',
    charset: type.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() || 'unspecified',
  };
}

export async function readBounded(response, limit) {
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

export function armCapture(frames, host, onCapture) {
  const removers = [];
  const byDocument = new Map();
  let taken = false;
  for (const frame of frames) if (!byDocument.has(frame.document)) byDocument.set(frame.document, frame);
  const stop = () => {
    for (const remove of removers.splice(0)) {
      try { remove(); } catch {}
    }
  };
  for (const [document] of byDocument) {
    const handler = event => {
      if (taken || !event.isTrusted || host.contains(event.target)) return;
      const eventDocument = event.target?.ownerDocument || event.composedPath?.().find(node => node?.nodeType === 9);
      const frame = byDocument.get(eventDocument);
      if (!frame) return;
      taken = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      onCapture(classifyNavigation(event.target, frame.url));
    };
    try {
      document.addEventListener('click', handler, true);
      removers.push(() => document.removeEventListener('click', handler, true));
    } catch {}
  }
  return stop;
}

const runtimeDocument = globalThis.document;
const previousStop = runtimeDocument ? globalThis.__theolProbeStop : undefined;
const remoteRuntime = runtimeDocument?.currentScript?.src === 'https://vg188.github.io/THEOL-downloader/probe/probe.js';
const result = {
  inline: true,
  remote: remoteRuntime,
  frame: false,
  metadata: false,
  worker: false,
  currentFrame: globalThis.location ? routeSignature(globalThis.location.href) : null,
  previewCount: 0,
  repeatedRoutes: [],
  capturedNavigation: null,
  response: null,
  details: [],
};
let stopCapture = () => {};
const stopCurrentCapture = () => {
  const stop = stopCapture;
  stopCapture = () => {};
  stop();
};
if (runtimeDocument) globalThis.__theolProbeStop = stopCurrentCapture;

function stopOldProbe() {
  previousStop?.();
  const oldHost = document.getElementById(HOST_ID);
  oldHost?.__theolProbeStop?.();
  oldHost?.remove();
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
  } catch { result.details.push('Blob Worker 测试失败'); }
  finally { URL.revokeObjectURL(url); }
}

function routeText(route) {
  return route ? `${route.endpoint} [${route.queryKeys.join(', ')}]` : '未识别';
}

function appendLine(host, label, value) {
  const line = document.createElement('p');
  const strong = document.createElement('strong'); strong.textContent = label;
  const text = document.createElement('span'); text.textContent = value;
  line.append(strong, text); host.append(line);
}

function render(frames) {
  stopCurrentCapture();
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('section');
  host.id = HOST_ID;
  Object.assign(host.style, { position:'fixed', zIndex:'2147483647', right:'20px', top:'20px', width:'min(420px,calc(100vw - 40px))', maxHeight:'calc(100vh - 40px)', overflow:'auto', padding:'18px', boxSizing:'border-box', border:'1px solid #d7d7d7', borderRadius:'12px', background:'#fff', color:'#171717', boxShadow:'0 16px 50px #0003', font:'14px/1.55 system-ui' });
  const title = document.createElement('strong'); title.textContent = 'THEOL 书签兼容性测试';
  const list = document.createElement('ul');
  for (const [key, label] of [['inline','书签内联代码'],['remote','GitHub Pages 远程脚本'],['frame','当前同源资源 frame'],['metadata','预览元数据请求'],['worker','Blob Worker']]) {
    const item = document.createElement('li'); item.textContent = label + '：' + (key === 'remote' && !remoteRuntime ? '未使用（自包含）' : result[key] ? '成功' : '失败'); list.append(item);
  }
  host.append(title, list);
  appendLine(host, '当前 frame 类型：', routeText(result.currentFrame));
  appendLine(host, '预览链接数量：', String(result.previewCount));
  appendLine(host, '预览响应：', result.response ? `${result.response.mimeFamily === 'html' ? 'HTML' : '其他'}；字符编码 ${result.response.charset}` : '未识别');
  const routesTitle = document.createElement('strong'); routesTitle.textContent = '重复链接类型：'; host.append(routesTitle);
  const routes = document.createElement('ul');
  if (result.repeatedRoutes.length) {
    for (const item of result.repeatedRoutes) {
      const row = document.createElement('li'); row.textContent = `${item.mechanism} ${routeText(item)} × ${item.count}`; routes.append(row);
    }
  } else {
    const row = document.createElement('li'); row.textContent = '未识别'; routes.append(row);
  }
  host.append(routes);
  appendLine(host, '捕获的单元入口：', result.capturedNavigation ? `${result.capturedNavigation.mechanism} ${routeText(result.capturedNavigation.route)}` : '未识别');
  const privacy = document.createElement('p'); privacy.textContent = '测试没有下载课件正文，也没有上传、存储或复制测试结果。报告仅含路径结构、查询键名、计数、MIME 类型与字符编码。';
  const detail = document.createElement('p'); detail.textContent = result.details.join('；'); detail.hidden = !result.details.length;
  const arm = document.createElement('button'); arm.type = 'button'; arm.textContent = '捕获下一次单元点击';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消捕获'; cancel.disabled = true;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  arm.onclick = () => {
    stopCurrentCapture();
    stopCapture = armCapture(frames, host, navigation => { result.capturedNavigation = navigation; render(frames); });
    arm.disabled = true;
    cancel.disabled = false;
  };
  cancel.onclick = () => { stopCurrentCapture(); arm.disabled = false; cancel.disabled = true; };
  close.onclick = () => {
    stopCurrentCapture();
    const stopped = () => {};
    host.__theolProbeStop = stopped;
    if (globalThis.__theolProbeStop === stopCurrentCapture) globalThis.__theolProbeStop = stopped;
    host.remove();
  };
  host.__theolProbeStop = globalThis.__theolProbeStop = stopCurrentCapture;
  host.append(privacy, detail, arm, cancel, close);
  document.documentElement.append(host);
}

async function run() {
  stopOldProbe();
  const frames = collectFrames(accessibleRoot(window));
  result.frame = frames.length > 1;
  result.repeatedRoutes = repeatedRoutes(frames);
  const previews = [];
  for (const frame of frames) {
    for (const candidate of previewCandidates(frame.document, frame.url)) if (!previews.includes(candidate)) previews.push(candidate);
  }
  result.previewCount = previews.length;
  if (previews.length) {
    result.frame = true;
    try {
      const response = await fetch(previews[0], { credentials:'include', redirect:'manual' });
      if (!response.ok || response.type === 'opaqueredirect' || response.status === 0 || response.redirected) throw new Error('预览元数据请求失败或登录已失效');
      result.response = responseSignature(response);
      await readBounded(response, MAX_METADATA_BYTES);
      result.metadata = true;
    } catch (error) {
      result.details.push(error.message === '元数据页面超过 64 KiB，已停止读取' ? error.message : '预览元数据测试失败');
    }
  } else result.details.push('没有找到规范的预览元数据链接');
  await checkWorker();
  render(frames);
}

if (runtimeDocument && globalThis.window) void run();
