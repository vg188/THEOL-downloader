import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIcons } from './icons.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const ASSETS=['manifest.json','popup.html','popup.css','popup.js','background.js','content.js','icons/16.png','icons/32.png','icons/48.png','icons/128.png'];
export async function buildExtension() {
  const output=join(root,'dist','extension');
  await mkdir(output,{recursive:true});
  const reports=[];
  for(const [entry,outfile,format] of [['src/content.js','content.js','iife'],['src/background.js','background.js','esm'],['src/popup/main.js','popup.js','esm']]) {
    const result=await build({absWorkingDir:root,entryPoints:[entry],outfile:join(output,outfile),bundle:true,format,target:'chrome120',platform:'browser',charset:'utf8',legalComments:'none',metafile:true});
    if(Object.keys(result.metafile.inputs).some(path=>path.includes('node_modules')))throw new Error('Unexpected third-party runtime dependency');
    reports.push(result.metafile);
  }
  for(const file of ['manifest.json','popup.html','popup.css'])await copyFile(join(root,'public',file),join(output,file));
  await writeIcons(join(output,'icons'));
  await writeFile(join(root,'dist','build-report.json'),JSON.stringify(reports,null,2));
  return output;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(`Loadable extension: ${await buildExtension()}`);
