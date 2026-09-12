import { build } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_URL = 'https://vg188.github.io/THEOL-downloader/probe/probe.js';

export function createProbeBookmarklet() {
  const code = `()=>{if(location.protocol!==${JSON.stringify('https:')}||location.hostname!==${JSON.stringify('course.buct.edu.cn')}){alert(${JSON.stringify('请在 THEOL 课程资源页运行此测试')});return}const s=document.createElement('script');s.src=${JSON.stringify(RUNTIME_URL)};s.onerror=()=>alert(${JSON.stringify('远程测试脚本被页面策略或网络阻止')});document.documentElement.append(s)}`;
  return 'javascript:(' + code + ')()';
}

export async function buildProbe() {
  const output = join(root, 'dist', 'probe');
  await rm(output, { recursive:true, force:true });
  await mkdir(output, { recursive:true });
  await copyFile(join(root, 'probe', 'index.html'), join(output, 'index.html'));
  await build({ absWorkingDir:root, entryPoints:['probe/probe.js'], outfile:join(output,'probe.js'), bundle:true, format:'iife', target:'chrome120', platform:'browser', charset:'utf8', legalComments:'none', minify:true, sourcemap:false });
  await writeFile(join(output, 'bookmarklet.txt'), createProbeBookmarklet() + '\n', 'utf8');
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Probe: ${await buildProbe()}`);
