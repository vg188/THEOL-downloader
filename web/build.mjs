/* 标签版官网：构建产物写入 dist/site，并在项目根提供 index.html 便于本地预览 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webDir = path.join(root, 'web');
const distDir = path.join(root, 'dist', 'site');
const previewDir = root; // 当前工作目录预览入口

const stamp = new Date().toISOString().slice(0, 10);
const version = '2.2.0-tab';

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

let src = read(path.join(webDir, 'bookmarklet-source.js'));
src = src.replace(/\/\*[\s\S]*?\*\//g, '');
src = src.replace(/^\s*\/\/.*$/gm, '');
src = src.replace(/\s+/g, ' ').trim();
const bookmarklet = 'javascript:' + encodeURIComponent(src);
const stampLine = `v${version} (${stamp})`;
const inject = `<script>window.__BOOKMARKLET__=${JSON.stringify({ href: bookmarklet, stamp: stampLine })};</script>`;

const files = {
  'bookmarklet.js': read(path.join(webDir, 'bookmarklet-source.js')),
  'site.css': read(path.join(webDir, 'site.css')),
  'privacy.html': read(path.join(webDir, 'privacy.html')),
  'site.js': read(path.join(webDir, 'site.js')),
  'bookmarklet.txt': bookmarklet,
};

let index = read(path.join(webDir, 'index.html'));
index = index.replace('</head>', inject + '\n</head>');
files['index.html'] = index;

for (const [name, content] of Object.entries(files)) {
  write(path.join(distDir, name), content);
  write(path.join(previewDir, name), content);
}

const bytes = Buffer.byteLength(src, 'utf8');
console.log('site built:', distDir);
console.log('preview root:', previewDir);
console.log('bookmarklet stamp:', stampLine);
console.log('bookmarklet payload bytes:', bytes);
if (bytes > 350 * 1024) {
  console.error('bookmarklet too large');
  process.exit(1);
}
