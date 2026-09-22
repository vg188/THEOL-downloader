/* 标签版官网构建
 * 书签格式对齐可用旧版：esbuild 压成 IIFE，href = javascript: + 源码（不用 eval/atob）。
 * HTML 属性转义后直接写入按钮 href，拖拽即得完整 javascript: URL。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webDir = path.join(root, 'web');
const distDir = path.join(root, 'dist', 'site');
const previewDir = root;

function loadTransform() {
  const candidates = [
    'esbuild',
    path.join(__dirname, 'node_modules', 'esbuild'),
    'E:/codex/File-scri/node_modules/esbuild/lib/main.js',
    'E:/codex/File-scri/node_modules/esbuild',
  ];
  for (const id of candidates) {
    try {
      const mod = require(id);
      return mod.transform || (mod.default && mod.default.transform);
    } catch {
      /* try next */
    }
  }
  throw new Error('esbuild not found; run npm install --prefix web esbuild');
}
const transform = loadTransform();

const stamp = new Date().toISOString().slice(0, 10);
const version = '2.5.0';

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

/** 与旧版一致的 HTML 属性转义 */
function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

let src = read(path.join(webDir, 'bookmarklet-source.js'));
src = src.replace(/\/\*[\s\S]*?\*\//g, '').trim();

// esbuild 压成可直接放在 javascript: 后的 IIFE（chrome120 + utf8，对齐旧版）
const minified = await transform(src, {
  minify: true,
  target: 'chrome120',
  charset: 'utf8',
  format: 'iife',
  logLevel: 'silent',
});
let bundle = minified.code.trim();
// 去掉可能的尾部分号，保持旧版风格
bundle = bundle.replace(/;+\s*$/, '');

// 关键：javascript: + 内联 IIFE，禁止 eval/atob 包装
const bookmarklet = 'javascript:' + bundle;

const stampLine = `v${version} (${stamp})`;
const inject = `<script>window.__BOOKMARKLET__=${JSON.stringify({
  href: bookmarklet,
  stamp: stampLine,
})};</script>`;

let index = read(path.join(webDir, 'index.html'));
index = index.replace(
  'href="#" draggable="true"',
  'href="' + escapeAttribute(bookmarklet) + '" draggable="true"'
);
index = index.replace('</head>', inject + '\n</head>');

const files = {
  'bookmarklet.js': bundle,
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

const rawBytes = Buffer.byteLength(bundle, 'utf8');
console.log('site built:', distDir);
console.log('bookmarklet stamp:', stampLine);
console.log('bundle bytes:', rawBytes);
console.log('href prefix:', bookmarklet.slice(0, 40));
console.log('href chars:', bookmarklet.length);
if (/eval\s*\(|atob\s*\(/.test(bundle.slice(0, 80))) {
  console.error('bookmarklet must not start with eval/atob wrapper');
  process.exit(1);
}
if (!bookmarklet.startsWith('javascript:')) {
  console.error('bookmarklet must start with javascript:');
  process.exit(1);
}
try {
  new Function(bundle);
  console.log('syntax check: ok');
} catch (e) {
  console.error('syntax check failed:', e.message);
  process.exit(1);
}
