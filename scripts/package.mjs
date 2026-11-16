// Builds dist/ (the build runs the release gate), then packages it into release/tab-organizer-<version>.zip.
import { ZipArchive } from 'archiver';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const verify = join(root, 'scripts', 'verify-release.mjs');
// Always package a fresh build: `npm run build` rebuilds dist/ and runs the release gate (postbuild).
const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const out = join(root, 'release', `tab-organizer-${version}.zip`);
await mkdir(dirname(out), { recursive: true });
await rm(out, { force: true });
await new Promise((resolve, reject) => {
  const output = createWriteStream(out);
  const zip = new ZipArchive({ zlib: { level: 9 } });
  output.on('close', resolve);
  zip.on('error', reject);
  zip.pipe(output);
  zip.directory(join(root, 'dist'), false);
  zip.finalize();
});
// Second pass includes the zip itself in the size check; an oversized zip is deleted.
const r = spawnSync(process.execPath, [verify, '--zip', out], { stdio: 'inherit' });
if (r.status !== 0) {
  await rm(out, { force: true });
  process.exit(r.status ?? 1);
}
console.log(`\npackaged ${out} (${((await stat(out)).size / 1_000_000).toFixed(2)} MB)`);
