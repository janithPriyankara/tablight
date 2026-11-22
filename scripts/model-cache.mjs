// Build-time only (CI): keeps a downloaded model between builds without letting anything stale reach dist.
//
//   node scripts/model-cache.mjs restore <cache-dir>   before `npm run prepare:assets`
//   node scripts/model-cache.mjs save <cache-dir>      after it
//
// restore first removes every public/models/<org>/<model> directory except MODEL_ID's (vite copies public/ into
// dist, and verify-release accepts only the bundled model). A model with a `local-` revision is committed to the
// repository: its files are never restored from or saved to the cache. A downloaded model's cached files are copied
// only where public/models has no file yet, and only the files MODEL_FILES pins; save copies only those files.
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_FILES, MODEL_ID, MODEL_REVISION } from './model-manifest.mjs';

const exists = (p) => stat(p).then(() => true, () => false);
async function dirs(p) {
  try {
    return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Removes every model directory under `modelsDir` except `keep` ("org/model"). Returns what it removed. */
export async function purgeOtherModels(modelsDir, keep = MODEL_ID) {
  const [keepOrg, keepModel] = keep.split('/');
  const removed = [];
  for (const org of await dirs(modelsDir)) {
    for (const model of await dirs(join(modelsDir, org))) {
      if (org === keepOrg && model === keepModel) continue;
      await rm(join(modelsDir, org, model), { recursive: true, force: true });
      removed.push(`${org}/${model}`);
    }
    if (org !== keepOrg && !(await dirs(join(modelsDir, org))).length) await rm(join(modelsDir, org), { recursive: true, force: true });
  }
  return removed;
}

/** restore: purge, then (downloaded models only) copy the pinned files the workspace lacks from the cache. */
export async function restore(cacheDir, modelsDir, manifest = { MODEL_ID, MODEL_REVISION, MODEL_FILES }) {
  const removed = await purgeOtherModels(modelsDir, manifest.MODEL_ID);
  const copied = [];
  if (!manifest.MODEL_REVISION.startsWith('local-')) {
    for (const file of Object.keys(manifest.MODEL_FILES)) {
      const from = join(cacheDir, ...manifest.MODEL_ID.split('/'), file);
      const to = join(modelsDir, ...manifest.MODEL_ID.split('/'), file);
      if (!(await exists(from)) || (await exists(to))) continue; // never over a file the workspace has
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      copied.push(file);
    }
  }
  return { removed, copied };
}

/** save: (downloaded models only) copy the pinned files into the cache, and drop every other model from it. */
export async function save(cacheDir, modelsDir, manifest = { MODEL_ID, MODEL_REVISION, MODEL_FILES }) {
  if (manifest.MODEL_REVISION.startsWith('local-')) return { saved: [] };
  await purgeOtherModels(cacheDir, manifest.MODEL_ID);
  const saved = [];
  for (const file of Object.keys(manifest.MODEL_FILES)) {
    const from = join(modelsDir, ...manifest.MODEL_ID.split('/'), file);
    if (!(await exists(from))) continue;
    const to = join(cacheDir, ...manifest.MODEL_ID.split('/'), file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    saved.push(file);
  }
  return { saved };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, cacheDir] = process.argv.slice(2);
  const modelsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');
  if ((cmd !== 'restore' && cmd !== 'save') || !cacheDir) {
    console.error('usage: node scripts/model-cache.mjs restore|save <cache-dir>');
    process.exit(2);
  }
  const local = MODEL_REVISION.startsWith('local-');
  if (cmd === 'restore') {
    const { removed, copied } = await restore(cacheDir, modelsDir);
    for (const r of removed) console.log(`removed stale model public/models/${r}`);
    console.log(local ? `${MODEL_ID} is committed (${MODEL_REVISION}): nothing restored from the cache`
      : `restored ${copied.length} cached file(s) of ${MODEL_ID}`);
  } else {
    const { saved } = await save(cacheDir, modelsDir);
    console.log(local ? `${MODEL_ID} is committed (${MODEL_REVISION}): the cache is not used`
      : `cached ${saved.length} file(s) of ${MODEL_ID}`);
  }
}
