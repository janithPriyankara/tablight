// Build-time only: downloads the pinned model files and verifies SHA-256.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${file}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`failed ${file}: HTTP ${res.status}`);
    failed = true;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    console.error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`);
    failed = true;
    continue;
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`ok ${file}`);
}
if (failed) process.exit(1);
