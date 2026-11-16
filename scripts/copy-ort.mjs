import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dest = join(root, 'public', 'ort');
const files = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
for (const f of files) {
  try {
    await access(join(src, f));
  } catch {
    console.error(`copy-ort: ${join(src, f)} is missing. Run "npm ci" (onnxruntime-web is pinned in package.json); if it still fails, the pinned onnxruntime-web build no longer ships this file.`);
    process.exit(1);
  }
}
await mkdir(dest, { recursive: true });
for (const f of files) {
  await copyFile(join(src, f), join(dest, f));
  console.log(`copied ${f}`);
}
