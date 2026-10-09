import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseExtension } from './release-extension.mjs';
import { writeReleasePackage } from './package-release.mjs';
import { buildSite } from '../web/build.mjs';
export { buildReleaseExtension, RELEASE_ASSETS, RELEASE_PERMISSIONS } from './release-extension.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extensionDirectory = await buildReleaseExtension();
  console.log('Extension: ' + extensionDirectory);
  if (!process.argv.includes('--extension-only')) {
    const pkg = await writeReleasePackage(extensionDirectory);
    console.log('Package: ' + pkg.output);
    console.log('Site: ' + await buildSite({ extensionDirectory }));
  }
}
