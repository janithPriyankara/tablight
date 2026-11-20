// Build-time only: downloads the pinned model files and verifies SHA-256. A model with a `local-` revision is
// committed to the repository (it has no download source): its files are only verified in place.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_FILES, MODEL_ID, MODEL_REVISION } from './model-manifest.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models', ...MODEL_ID.split('/'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
async function existingHash(path) {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}
let failed = false;
for (const [file, expected] of Object.entries(MODEL_FILES)) {
  const dest = join(outDir, file);
  if ((await existingHash(dest)) === expected) {
    console.log(`ok (cached) ${file}`);
    continue;
  }
  if (MODEL_REVISION.startsWith('local-')) {
    console.error(`missing or changed ${file}: ${MODEL_ID} is committed under public/models, not downloaded`);
    failed = true;
    continue;
  }
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${file}`;
  console.log(`downloading ${url}`);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    console.error(`failed ${file}: ${e instanceof Error ? e.message : e}`);
    failed = true;
    continue;
  }
  if (!res.ok) {
    console.error(`failed ${file}: HTTP ${res.status}`);
    failed = true;
    continue;
  }
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error(`failed ${file}: ${e instanceof Error ? e.message : e}`);
    failed = true;
    continue;
  }
  const actual = sha256(buf);
  if (actual !== expected) {
    console.error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`);
    failed = true;
    continue;
  }
  await mkdir(dirname(dest), { recursive: true });
  // Atomic: a half-written file never sits at the final path.
  const tmp = `${dest}.tmp`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  console.log(`ok ${file}`);
}
if (failed) process.exit(1);
