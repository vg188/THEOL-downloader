import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildExtension, ASSETS } from '../scripts/build.mjs';
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
test('manifest has only the approved host and permissions',async()=>{
  const manifest=await json(new URL('../public/manifest.json',import.meta.url));
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.permissions.sort(),['downloads','scripting','storage']);
  assert.deepEqual(manifest.host_permissions,['https://course.buct.edu.cn/*']);
  assert.equal(manifest.content_scripts,undefined);
  assert.equal(manifest.externally_connectable,undefined);
  assert.ok(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'));
});
test('build creates a complete self-contained extension and real PNG icons',async()=>{
  const directory=await buildExtension();
  for(const asset of ASSETS){assert.ok((await readFile(new URL(asset,`file:///${directory.replaceAll('\\','/')}/`))).length>0);}
  const icon=await readFile(`${directory}/icons/16.png`);
  assert.deepEqual([...icon.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const html=await readFile(`${directory}/popup.html`,'utf8');assert.ok(!/<script[^>]*src=["']https?:/i.test(html));
  const bundle=await readFile(`${directory}/background.js`,'utf8');assert.ok(!bundle.includes('document.cookie'));assert.ok(!bundle.includes('chrome.cookies'));
});
