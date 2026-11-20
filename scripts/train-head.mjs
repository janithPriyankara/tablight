// Build-time only: trains the classification head (multinomial logistic regression over
// sentence embeddings) and writes src/classify/head.json.
//
//   node scripts/train-head.mjs
//
// Env overrides (for model experiments): MODEL_ID, MODEL_PATH (dir holding <org>/<model>/),
// POOLING (mean|cls), OUT, CALIBRATION (path to finetune.py's calibration.json: the head still trains on every
// pool row, but the L2 choice, Unsorted threshold and override similarity use only those rows, which a fine-tuned
// encoder never saw; without it everything is unchanged; every key must match a pool row unless
// CALIBRATION_ALLOW_PARTIAL=1). The bundled tablight/bge-small-tabs-v1 defaults to its
// committed scripts/finetune/calibration-bge-small-tabs-v1.json; another tablight/* model without one is refused.
//
// Pool = training/train-a.json + train-b.json + train-c.json + train-d.json + train-e.json + train-f.json + tests/quality/fixture.json.
// tests/quality/holdout.json, holdout2.json and holdout3.json are never read here: they are the blind test sets.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { runnerImport } from 'vite';
import { matchCalibration } from './calibration.mjs';
import { FOLDS, fitHead, KNN } from './head-fit.mjs';
import { MODEL_ID as DEFAULT_MODEL, MODEL_POOLING } from './model-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = process.env.MODEL_ID ?? DEFAULT_MODEL;
const MODEL_PATH = process.env.MODEL_PATH ?? join(root, 'public', 'models');
const POOLING = process.env.POOLING ?? MODEL_POOLING;
const OUT = process.env.OUT ?? join(root, 'src', 'classify', 'head.json');

/** The calibration keys of each committed fine-tuned encoder (scripts/finetune/README.md). */
const COMMITTED_CALIBRATION = { 'tablight/bge-small-tabs-v1': 'scripts/finetune/calibration-bge-small-tabs-v1.json' };
const CALIBRATION = process.env.CALIBRATION ??
  (COMMITTED_CALIBRATION[MODEL_ID] ? join(root, COMMITTED_CALIBRATION[MODEL_ID]) : undefined);
// A fine-tuned encoder saw most pool rows in training: a threshold chosen on them would be too optimistic.
if (!CALIBRATION && MODEL_ID.startsWith('tablight/')) {
  throw new Error(`${MODEL_ID} is fine-tuned on the pool: set CALIBRATION=<its calibration.json>`);
}
if (CALIBRATION && !process.env.CALIBRATION) console.log(`calibration rows: ${CALIBRATION} (committed for ${MODEL_ID})`);
const SEED = 42;
/** Cost of a wrong group relative to a tab left Unsorted, for the threshold choice (head-fit.mjs). */
const WRONG_COST = Number(process.env.WRONG_COST ?? 2);

const load = async (p) => (await runnerImport(join(root, p))).module;
const { embedText } = await load('src/shared/url.ts');
const { ruleGroup } = await load('src/classify/rules.ts');
const { STARTER_GROUPS } = await load('src/classify/seeds.ts');
// Every seed group, installed and on-demand: the head knows all of them, and classify() only assigns a label
// whose group exists.
const LABELS = STARTER_GROUPS.map((g) => g.id);

// ---------- data ----------
const files = [
  'training/train-a.json', 'training/train-b.json', 'training/train-c.json', 'training/train-d.json', 'training/train-e.json', 'training/train-f.json',
  'tests/quality/fixture.json',
];
const seen = new Set();
const pool = [];
for (const f of files) {
  for (const r of JSON.parse(await readFile(join(root, f), 'utf8'))) {
    if (!LABELS.includes(r.group)) throw new Error(`${f}: unknown group "${r.group}"`);
    const key = `${r.url}\n${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({ title: r.title, url: r.url, group: r.group });
  }
}
const poolHash = createHash('sha256').update(JSON.stringify(pool)).digest('hex');

// ---------- embeddings ----------
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODEL_PATH.endsWith('/') ? MODEL_PATH : `${MODEL_PATH}/`;
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
const X = [];
for (let i = 0; i < pool.length; i += 64) {
  const out = await extractor(pool.slice(i, i + 64).map(embedText), { pooling: POOLING, normalize: true });
  X.push(...out.tolist());
}
const DIM = X[0].length;
const Y = pool.map((r) => LABELS.indexOf(r.group));
const RULE = pool.map((r) => ruleGroup(r.url, r.title));

// Calibration rows (CALIBRATION): every key must be a pool row's `url\ntitle`. A key-format drift would silently
// shrink the calibration set, so the match count is logged, zero matches is an error, and so is a partial match
// unless CALIBRATION_ALLOW_PARTIAL=1.
let calIdx = null;
if (CALIBRATION) {
  const keys = JSON.parse(await readFile(CALIBRATION, 'utf8'));
  // The pool is deduplicated by the same key, so each matched key is exactly one pool row.
  calIdx = matchCalibration(pool, keys, { file: CALIBRATION, allowPartial: process.env.CALIBRATION_ALLOW_PARTIAL === '1' });
  const matched = calIdx.length;
  console.log(`calibration: ${matched} of ${new Set(keys).size} distinct keys matched pool rows (${matched} of ${pool.length} pool rows)`);
}

// Split, L2 choice, Unsorted threshold, override similarity and final head (head-fit.mjs).
const { chosen, cv, similarity, final, valIdx } = fitHead({ X, Y, rule: RULE, labels: LABELS, calIdx, seed: SEED, wrongCost: WRONG_COST });

const round = (v) => Math.round(v * 1e4) / 1e4;
const out = {
  model: MODEL_ID,
  pooling: POOLING,
  dim: DIM,
  labels: LABELS,
  W: final.W.map((r) => r.map(round)),
  b: final.b.map(round),
  threshold: cv.threshold,
  similarity,
  // Neighbours: every pool item's vector, int8-quantized (x·127, unit vectors), base64; labels index into `labels`.
  knn: {
    ...KNN,
    labels: Y,
    vecs: Buffer.from(Int8Array.from(X.flat(), (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))).buffer).toString('base64'),
  },
  l2: chosen.l2,
  val: { acc: round(chosen.acc), otherAssigned: round(chosen.otherRate), n: valIdx.length },
  cv: { folds: FOLDS, wrongCost: WRONG_COST, acc: round(cv.acc), wrong: round(cv.wrongRate), otherAssigned: round(cv.otherRate) },
  trainedAt: new Date().toISOString(),
  poolSize: pool.length,
  poolHash,
};
const json = JSON.stringify(out, null, 0)
  .replace('"W":[[', '"W":[\n[')
  .replace(/\],\[/g, '],\n[');
await writeFile(OUT, `${json}\n`);
console.log(
  `model ${MODEL_ID} (${POOLING}, dim ${DIM}); pool ${pool.length}, val ${valIdx.length}; ` +
    `l2 ${chosen.l2}; val acc ${(chosen.acc * 100).toFixed(1)}%; threshold ${cv.threshold} ` +
    `(${FOLDS}-fold acc ${(cv.acc * 100).toFixed(1)}%, wrong ${(cv.wrongRate * 100).toFixed(1)}%); override similarity ${similarity} → ${OUT}`,
);
