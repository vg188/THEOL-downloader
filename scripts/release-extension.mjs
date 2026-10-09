import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT, prepareOutput } from './release-utils.mjs';
import { RELEASE_VERSION } from '../src/runtime/version.js';

export const RELEASE_PERMISSIONS = Object.freeze(['alarms', 'downloads', 'offscreen', 'scripting', 'storage', 'tabs']);
export const RELEASE_ASSETS = ['manifest.json', 'background.js', 'content.js', 'panel.js', 'offscreen.js', 'offscreen.html', 'THIRD_PARTY_NOTICES.md', 'panel.html', 'panel.css', 'icons/icon48.png', 'icons/icon128.png'];
export async function buildReleaseExtension({ output = join(PROJECT_ROOT, 'dist', 'extension') } = {}) {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== RELEASE_VERSION) throw new Error('Package version differs from the shipped runtime');
  if (manifest.version !== RELEASE_VERSION) throw new Error('Extension manifest version differs from the shipped runtime');
  const directory = await prepareOutput(output);
  for (const [entry, format] of [['background.js', 'esm'], ['content.js', 'iife'], ['panel.js', 'iife'], ['offscreen.js', 'iife']]) {
    await build({ absWorkingDir: PROJECT_ROOT, entryPoints: ['extension/' + entry], outfile: join(directory, entry), bundle: true, format, target: 'chrome120', platform: 'browser', charset: 'utf8', legalComments: 'none' });
  }
  await mkdir(join(directory, 'icons'), { recursive: true });
  for (const asset of RELEASE_ASSETS.filter(asset => !asset.endsWith('.js'))) await copyFile(join(PROJECT_ROOT, ...(asset === 'THIRD_PARTY_NOTICES.md' ? [asset] : ['extension', asset])), join(directory, asset));
  return directory;
}
