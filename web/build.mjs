/* 标签版官网构建：书签用 Base64 自包含，href 直接写进 HTML，避免拖拽丢 javascript: */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webDir = path.join(root, 'web');
const distDir = path.join(root, 'dist', 'site');
const previewDir = root;

const stamp = new Date().toISOString().slice(0, 10);
const version = '2.2.1-tab';

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

let src = read(path.join(webDir, 'bookmarklet-source.js'));
// 只去掉块注释，不压空白（避免弄坏模板字符串/正则）
src = src.replace(/\/\*[\s\S]*?\*\//g, '');
src = src.trim();
const payloadBytes = Buffer.byteLength(src, 'utf8');
const b64 = Buffer.from(src, 'utf8').toString('base64');
// 书签本体：decode Base64 → UTF-8 → eval。比 encodeURIComponent 更小、对中文更稳。
const bookmarklet =
  'javascript:eval(new TextDecoder().decode(Uint8Array.from(atob("' + b64 + '"),function(c){return c.charCodeAt(0)})))';

const stampLine = `v${version} (${stamp})`;
const inject = `<script>window.__BOOKMARKLET__=${JSON.stringify({
  href: bookmarklet,
  stamp: stampLine,
})};</script>`;

let index = read(path.join(webDir, 'index.html'));
// 构建时直接写入完整 href，拖拽不依赖 JS
index = index.replace(
  'href="#" draggable="true"',
  'href="' + bookmarklet.replace(/"/g, '&quot;') + '" draggable="true"'
);
index = index.replace('</head>', inject + '\n</head>');

const files = {
  'bookmarklet.js': src,
  'bookmarklet.txt': bookmarklet,
  'site.css': read(path.join(webDir, 'site.css')),
  'privacy.html': read(path.join(webDir, 'privacy.html')),
  'site.js': read(path.join(webDir, 'site.js')),
  'index.html': index,
};

for (const [name, content] of Object.entries(files)) {
  write(path.join(distDir, name), content);
  write(path.join(previewDir, name), content);
}

console.log('site built:', distDir);
console.log('preview root:', previewDir);
console.log('bookmarklet stamp:', stampLine);
console.log('source bytes:', payloadBytes);
console.log('base64 chars:', b64.length);
console.log('bookmarklet href chars:', bookmarklet.length);
if (b64.length > 400 * 1024) {
  console.error('bookmarklet too large');
  process.exit(1);
}

// 烟测：decode 后必须是可解析的 JS
try {
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  if (!decoded.includes('mountUI')) throw new Error('decode mismatch');
  new Function(decoded); // 仅语法检查，不执行
  console.log('syntax check: ok');
} catch (e) {
  console.error('syntax check failed:', e.message);
  process.exit(1);
}
