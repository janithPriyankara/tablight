// Packages dist/ into release/tab-organizer-<version>.zip after the release gate passes.
import { ZipArchive } from 'archiver';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const verify = join(root, 'scripts', 'verify-release.mjs');
const run = (...args) => {
  const r = spawnSync(process.execPath, [verify, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run();
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
console.log(`\npackaged ${out} (${((await stat(out)).size / 1024 / 1024).toFixed(2)} MB)`);
