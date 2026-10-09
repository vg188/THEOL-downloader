import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ORIGIN = 'https://course.buct.edu.cn';
export const LIST = ORIGIN + '/meol/common/script/listview.jsp?acttype=enter&folderid=0&lid=42';
export const PANEL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html';
export function file(id = 1, extras = {}) {
  return { id: '42:' + (100 + id) + ':' + id, lid: '42', resid: String(100 + id), fileid: String(id), name: '课件' + id + '.pdf', originalName: '课件' + id + '.pdf', ext: 'pdf', group: 'pdf', type: 'file', section: 'resource', pathSegments: [], downloadUrl: ORIGIN + '/meol/common/script/download.jsp?fileid=' + id + '&resid=' + (100 + id) + '&lid=42', previewUrl: ORIGIN + '/meol/common/script/preview/download_preview.jsp?fileid=' + id + '&resid=' + (100 + id) + '&lid=42', ...extras };
}
export const tree = files => ({ type: 'folder', id: 'root', name: '课程资源', pathSegments: [], children: files });
export const link = f => '<a href="' + f.previewUrl.replaceAll('&', '&amp;') + '">' + f.name + '</a>';
export const listHTML = (files = [file()], extra = '') => '<title>网络课程 — 测试课程</title><meta charset="utf-8"><table class="valuelist">' + files.map(f => '<tr><td>' + link(f) + '</td></tr>').join('') + extra + '</table>';
export function response(body, url, type = 'text/html; charset=utf-8', status = 200) {
  const res = new Response(body, { status, headers: { 'Content-Type': type } });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}
export const previewHTML = (f = file(), downloadable = true) => '<h2>文件名：<span>' + f.name + '</span><span>(12K)</span>' + (downloadable ? '<a href="' + f.downloadUrl + '">下载</a>' : '') + '</h2>';
export const metadataResponse = url => response(previewHTML(file(Number(new URL(url).searchParams.get('fileid')))), url);
export const fixtureBytes = name => readFileSync(new URL('../fixtures/downloads/' + name, import.meta.url));
export function pdf(url) { return response(fixtureBytes('sample.pdf'), url, 'application/pdf'); }
export async function waitFor(predicate, message = 'condition', ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for ' + message);
}
const bundles = new Map();
export async function bundle(entry) {
  if (!bundles.has(entry)) bundles.set(entry, build({ absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120' }).then(result => result.outputFiles[0].text));
  return bundles.get(entry);
}
export function event() { const listeners = []; return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } }; }
export function memoryStorage(seed) {
  let data = structuredClone(seed);
  return { read: async () => structuredClone(data), write: async value => { data = structuredClone(value); }, peek: () => structuredClone(data) };
}
export function nativeDownloads() {
  const items = new Map(), calls = [];
  const downloads = {
    onChanged: event(),
    download: async options => { const id = calls.length + 1; calls.push({ ...options }); items.set(id, { ...options, id, state: 'in_progress', byExtensionId: 'abcdefghijklmnopabcdefghijklmnop', mime: 'application/pdf' }); return id; },
    search: async query => [...items.values()].filter(item => query.id != null ? item.id === query.id : !query.url || item.url === query.url).map(item => ({ ...item })),
    cancel: async id => { const item = items.get(id); if (item) { item.state = 'interrupted'; item.error = 'USER_CANCELED'; } },
  };
  return { downloads, items, calls };
}
function area() {
  const data = {};
  return { data, get: async key => key == null ? structuredClone(data) : { [key]: structuredClone(data[key]) }, set: async value => { Object.assign(data, structuredClone(value)); } };
}
export async function backgroundHarness({ source, scanResult, sessionSeed = {} } = {}) {
  const native = nativeDownloads(), sent = [], injected = [], created = [], notified = [], errors = [];
  const tabs = new Map([[1, { id: 1, windowId: 1, url: LIST, title: '测试课程', active: true }]]);
  const alarms = new Map();
  const chrome = {
    alarms: { onAlarm: event(), get: async name => alarms.get(name), create: async (name, info) => { alarms.set(name, { name, ...info }); }, clear: async name => alarms.delete(name) },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: name => PANEL.replace('panel.html', name), onMessage: event(), sendMessage: async message => { notified.push(message); } },
    action: { onClicked: event() },
    storage: { session: area(), local: area() },
    downloads: native.downloads,
    windows: { update: async () => {} },
    scripting: { executeScript: async details => { injected.push(details); } },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
      query: async query => [...tabs.values()].filter(tab => query.url ? Array.isArray(query.url) ? tab.url.startsWith(ORIGIN) : tab.url.startsWith(PANEL) : !query.active || tab.active),
      update: async (id, details) => { Object.assign(tabs.get(id), details); },
      create: async details => { created.push(details); const tab = { id: 9, windowId: 1, ...details }; tabs.set(9, tab); return tab; },
      sendMessage: async (id, payload, options) => {
        sent.push({ id, payload, options });
        if (payload.type === 'BUCT_CONTEXT') return { ok: true, contextKey: harness.contextKey };
        return scanResult ? scanResult(id, payload) : { ok: true, lid: '42', contextKey: harness.contextKey, courseName: '测试课程', defaultMode: 'directory', modes: ['directory', 'tree'], surface: 'resource-directory', tree: tree([file()]), unitIndex: [] };
      },
    },
  };
  Object.assign(chrome.storage.session.data, sessionSeed);
  const harness = { chrome, alarms, ...native, tabs, sent, injected, created, notified, errors, contextKey: 'document-1|course-42' };
  const globals = { chrome, URL, URLSearchParams, Response, Blob, TextEncoder, TextDecoder, AbortController, structuredClone, crypto: { randomUUID }, fetch: async url => pdf(url), setTimeout, clearTimeout, console: { error: (...args) => errors.push(args) } };
  vm.runInNewContext(source || await bundle('extension/background.js'), globals);
  harness.send = (message, sender = { id: chrome.runtime.id, url: PANEL }) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, sender, resolve));
  return harness;
}
export async function bookmarkletHarness(t, { html = listHTML(), url = LIST, fetchImpl, confirm = () => true } = {}) {
  const requests = [], clicks = [], blobs = [], revoked = [];
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  Object.assign(win, { TextDecoder, TextEncoder, Response, Blob, structuredClone });
  win.confirm = confirm; win.alert = () => {};
  win.fetch = async (value, options) => { requests.push({ url: String(value), options }); if (fetchImpl) return fetchImpl(String(value), options); return String(value).includes('/preview/download_preview.jsp') ? metadataResponse(String(value)) : /download\.jsp/.test(String(value)) ? pdf(String(value)) : response(listHTML(), String(value)); };
  win.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test-' + blobs.length; };
  win.URL.revokeObjectURL = url => revoked.push(url);
  win.HTMLAnchorElement.prototype.click = function () { clicks.push({ url: this.href, filename: this.download }); };
  const code = await bundle('web/bookmarklet-source.js');
  const run = () => win.eval(code);
  run();
  t.after(() => { win.__buctTabDl?.destroy(); dom.window.close(); });
  return { win, requests, clicks, blobs, revoked, run, get panel() { return win.document.getElementById('buct-tab-dl-host')?.shadowRoot; } };
}
export async function panelHarness(t, handler) {
  const html = await readFile(resolve(ROOT, 'extension/panel.html'), 'utf8');
  const dom = new JSDOM(html, { url: PANEL, runScripts: 'outside-only' });
  const messages = [], win = dom.window;
  win.confirm = () => true;
  win.chrome = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', onMessage: event(), sendMessage: async message => { messages.push(message); return handler(message); } } };
  win.eval(await bundle('extension/panel.js'));
  t.after(() => dom.window.close());
  return { win, messages, element: id => win.document.getElementById(id) };
}
