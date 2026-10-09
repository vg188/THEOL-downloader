/** One deterministic, allowlisted archive for the website and the standalone download. */
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { RELEASE_ASSETS, RELEASE_PERMISSIONS } from './release-extension.mjs';
import { DIST_ROOT } from './release-utils.mjs';
import { RELEASE_VERSION } from '../src/runtime/version.js';
export const PACKAGE_NAME = 'buct-course-downloader.zip';
function inside(parent, child) { const rel = relative(parent, child); return rel && !rel.startsWith('..') && !isAbsolute(rel); }
export async function packageReleaseExtension(directory) {
  const base = await realpath(directory), dist = await realpath(DIST_ROOT);
  if (!inside(dist, base)) throw new Error('Package input must be inside dist');
  const entries = {};
  for (const asset of RELEASE_ASSETS) {
    const source = join(base, asset);
    if ((await lstat(source)).isSymbolicLink() || !inside(base, await realpath(source))) throw new Error('Unsafe package asset: ' + asset);
    entries[asset] = new Uint8Array(await readFile(source));
  }
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  if (manifest.version !== RELEASE_VERSION || manifest.manifest_version !== 3) throw new Error('Package version does not match runtime');
  if (JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify(RELEASE_PERMISSIONS)) throw new Error('Unexpected release permissions');
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://course.buct.edu.cn/*', 'http://course.buct.edu.cn/*'])) throw new Error('Unexpected release host permissions');
  const bytes = zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0) });
  const unpacked = unzipSync(bytes);
  for (const asset of RELEASE_ASSETS) if (!Buffer.from(unpacked[asset]).equals(entries[asset])) throw new Error('Package verification failed: ' + asset);
  return { bytes, version: RELEASE_VERSION, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function writeReleasePackage(directory = join(DIST_ROOT, 'extension')) {
  const pkg = await packageReleaseExtension(directory), output = join(DIST_ROOT, PACKAGE_NAME);
  try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Unsafe package output'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(output, pkg.bytes);
  return { ...pkg, output };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = await writeReleasePackage();
  console.log('Package: ' + pkg.output + '\nVersion: ' + pkg.version + ' | assets: ' + RELEASE_ASSETS.length + ' | bytes: ' + pkg.size + '\nSHA-256: ' + pkg.sha256);
}
