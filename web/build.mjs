/* 构建标签版官网：打包自包含书签 + 生成 dist/site */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webDir = path.join(root, 'web');
const distDir = path.join(root, 'dist', 'site');

const stamp = new Date().toISOString().slice(0, 10);
const version = '2.0.0-tab';

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// 1) 打包书签：去掉注释块，压成一行，包成 javascript:
let src = read(path.join(webDir, 'bookmarklet-source.js'));
// 去掉块注释与行注释（保守：仅 /* */ 与整行 //）
src = src.replace(/\/\*[\s\S]*?\*\//g, '');
src = src.replace(/^\s*\/\/.*$/gm, '');
src = src.replace(/\s+/g, ' ').trim();
const bookmarklet = 'javascript:' + encodeURIComponent(src);
const stampLine = `v${version} (${stamp})`;

// 2) 组装站点
write(path.join(distDir, 'bookmarklet.js'), read(path.join(webDir, 'bookmarklet-source.js')));
write(path.join(distDir, 'site.css'), read(path.join(webDir, 'site.css')));
write(path.join(distDir, 'privacy.html'), read(path.join(webDir, 'privacy.html')));

let index = read(path.join(webDir, 'index.html'));
const inject = `<script>window.__BOOKMARKLET__=${JSON.stringify({
  href: bookmarklet,
  stamp: stampLine,
})};</script>`;
index = index.replace('</head>', inject + '\n</head>');
write(path.join(distDir, 'index.html'), index);
write(path.join(distDir, 'site.js'), read(path.join(webDir, 'site.js')));

// 3) 保存一份纯书签文本便于调试
write(path.join(distDir, 'bookmarklet.txt'), bookmarklet);

const bytes = Buffer.byteLength(src, 'utf8');
console.log('site built:', distDir);
console.log('bookmarklet stamp:', stampLine);
console.log('bookmarklet payload bytes:', bytes);
if (bytes > 350 * 1024) {
  console.error('bookmarklet too large');
  process.exit(1);
}
