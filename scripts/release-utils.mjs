import { mkdir, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST_ROOT = resolve(PROJECT_ROOT, 'dist');
function inside(parent, target) { const rel = relative(parent, target); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); }
/** Build cleanup is restricted to a checked child of this repository's dist/. */
export async function prepareOutput(value) {
  const output = resolve(value);
  if (!inside(DIST_ROOT, output)) throw new Error('Build output must be a child of ' + DIST_ROOT);
  await mkdir(DIST_ROOT, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const realDist = await realpath(DIST_ROOT), realParent = await realpath(dirname(output));
  if (!inside(await realpath(PROJECT_ROOT), realDist)) throw new Error('dist escapes the project workspace');
  if (realParent !== realDist && !inside(realDist, realParent)) throw new Error('Build output parent escapes dist');
  let existing;
  try { existing = await lstat(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.isSymbolicLink() || !inside(realDist, await realpath(output))) throw new Error('Unsafe build output target');
    await rm(output, { recursive: true, force: true });
  }
  await mkdir(output, { recursive: true });
  return output;
}
