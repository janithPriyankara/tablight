// Build-time only: trains the classification head (multinomial logistic regression over
// sentence embeddings) and writes src/classify/head.json.
//
//   node scripts/train-head.mjs
//
// Env overrides (for model experiments): MODEL_ID, MODEL_PATH (dir holding <org>/<model>/),
// POOLING (mean|cls), OUT.
//
// Pool = training/train-a.json + train-b.json + train-c.json + train-d.json + train-e.json + tests/quality/fixture.json.
// tests/quality/holdout.json, holdout2.json and holdout3.json are never read here: they are the blind test sets.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { runnerImport } from 'vite';
import { MODEL_ID as DEFAULT_MODEL, MODEL_POOLING } from './model-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = process.env.MODEL_ID ?? DEFAULT_MODEL;
const MODEL_PATH = process.env.MODEL_PATH ?? join(root, 'public', 'models');
const POOLING = process.env.POOLING ?? MODEL_POOLING;
const OUT = process.env.OUT ?? join(root, 'src', 'classify', 'head.json');

const SEED = 42;
const VAL_SHARE = 0.15;
const EPOCHS = 600;
const LR = 0.05;
const L2_GRID = [1e-4, 3e-4, 1e-3, 3e-3];
/**
 * Neighbour blend (chosen by 5-fold CV, see docs §12): final scores = (1-ALPHA)·p_head + ALPHA·vote of the
 * K nearest pool items, each weighted exp(SHARP·cosine). Shipped as int8 vectors in head.json.
 */
const KNN = { k: 10, alpha: 0.3, sharp: 10 };
/** Max share of `other` items the threshold may let through to a real group (val split). */
const MAX_OTHER_ASSIGNED = 0.3;
/**
 * A tab filed in the wrong group costs the user more than one left in Unsorted (they must notice it, then move
 * it). The Unsorted threshold maximises right - WRONG_COST * wrong on the val split, so weak guesses stay Unsorted.
 */
const WRONG_COST = Number(process.env.WRONG_COST ?? 2);
/** Required precision of the learned-exemplar override (val split). */
const OVERRIDE_PRECISION = 0.95;

const load = async (p) => (await runnerImport(join(root, p))).module;
const { embedText } = await load('src/shared/url.ts');
const { ruleGroup } = await load('src/classify/rules.ts');
const { STARTER_GROUPS } = await load('src/classify/seeds.ts');
// Every seed group, installed and on-demand: the head knows all of them, and classify() only assigns a label
// whose group exists.
const LABELS = STARTER_GROUPS.map((g) => g.id);
const OTHER = LABELS.indexOf('other');

// ---------- data ----------
const files = [
  'training/train-a.json', 'training/train-b.json', 'training/train-c.json', 'training/train-d.json', 'training/train-e.json',
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

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function shuffle(xs) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

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

// Stratified split.
const valIdx = [];
const trainIdx = [];
for (let c = 0; c < LABELS.length; c++) {
  const idx = shuffle(Y.map((y, i) => (y === c ? i : -1)).filter((i) => i >= 0));
  const nVal = Math.round(idx.length * VAL_SHARE);
  valIdx.push(...idx.slice(0, nVal));
  trainIdx.push(...idx.slice(nVal));
}

// ---------- logistic regression (full-batch Adam, L2, class-balanced) ----------
function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
function logits(W, b, x) {
  return W.map((row, c) => {
    let s = b[c];
    for (let d = 0; d < DIM; d++) s += row[d] * x[d];
    return s;
  });
}
function train(idx, l2) {
  const C = LABELS.length;
  const counts = new Array(C).fill(0);
  for (const i of idx) counts[Y[i]]++;
  const cw = counts.map((n) => (n ? idx.length / (C * n) : 0));
  const wsum = idx.reduce((s, i) => s + cw[Y[i]], 0);
  const W = Array.from({ length: C }, () => new Float64Array(DIM));
  const b = new Float64Array(C);
  const mW = W.map(() => new Float64Array(DIM));
  const vW = W.map(() => new Float64Array(DIM));
  const mb = new Float64Array(C);
  const vb = new Float64Array(C);
  const [b1, b2, eps] = [0.9, 0.999, 1e-8];
  for (let t = 1; t <= EPOCHS; t++) {
    const gW = W.map(() => new Float64Array(DIM));
    const gb = new Float64Array(C);
    for (const i of idx) {
      const p = softmax(logits(W, b, X[i]));
      const w = cw[Y[i]] / wsum;
      for (let c = 0; c < C; c++) {
        const g = w * (p[c] - (c === Y[i] ? 1 : 0));
        if (g === 0) continue;
        gb[c] += g;
        const row = gW[c];
        const x = X[i];
        for (let d = 0; d < DIM; d++) row[d] += g * x[d];
      }
    }
    for (let c = 0; c < C; c++) {
      for (let d = 0; d < DIM; d++) {
        const g = gW[c][d] + l2 * W[c][d];
        mW[c][d] = b1 * mW[c][d] + (1 - b1) * g;
        vW[c][d] = b2 * vW[c][d] + (1 - b2) * g * g;
        W[c][d] -= (LR * (mW[c][d] / (1 - b1 ** t))) / (Math.sqrt(vW[c][d] / (1 - b2 ** t)) + eps);
      }
      mb[c] = b1 * mb[c] + (1 - b1) * gb[c];
      vb[c] = b2 * vb[c] + (1 - b2) * gb[c] * gb[c];
      b[c] -= (LR * (mb[c] / (1 - b1 ** t))) / (Math.sqrt(vb[c] / (1 - b2 ** t)) + eps);
    }
  }
  return { W: W.map((r) => Array.from(r)), b: Array.from(b) };
}

/** Neighbour vote over `ref` pool items (indices), as the shipped classify() does with head.knn. */
function knnVote(i, ref) {
  const sims = [];
  for (const j of ref) {
    let s = 0;
    for (let d = 0; d < DIM; d++) s += X[i][d] * X[j][d];
    sims.push([s, Y[j]]);
  }
  sims.sort((a, b) => b[0] - a[0]);
  const v = new Array(LABELS.length).fill(0);
  let S = 0;
  for (const [s, y] of sims.slice(0, KNN.k)) {
    const w = Math.exp(KNN.sharp * s);
    v[y] += w;
    S += w;
  }
  return v.map((x) => x / S);
}
/** Pipeline on one item: rule first, then head blended with neighbours (other / low confidence → Unsorted). */
function predict(head, i, threshold) {
  if (RULE[i]) return RULE[i];
  head.cache ??= new Map(); // blended scores per item: the threshold search re-reads them ~90 times
  let p = head.cache.get(i);
  if (!p) {
    const ph = softmax(logits(head.W, head.b, X[i]));
    const vote = knnVote(i, head.ref);
    p = ph.map((x, c) => (1 - KNN.alpha) * x + KNN.alpha * vote[c]);
    head.cache.set(i, p);
  }
  let top = 0;
  for (let c = 1; c < p.length; c++) if (p[c] > p[top]) top = c;
  return top === OTHER || p[top] < threshold ? null : LABELS[top];
}
function evaluate(head, idx, threshold) {
  let ok = 0;
  let n = 0;
  let others = 0;
  let otherAssigned = 0;
  let wrong = 0;
  for (const i of idx) {
    const g = predict(head, i, threshold);
    if (Y[i] === OTHER) {
      others++;
      if (g !== null) otherAssigned++;
    } else {
      n++;
      if (g === LABELS[Y[i]]) ok++;
      else if (g !== null) wrong++;
    }
  }
  const acc = ok / n;
  const wrongRate = (wrong + otherAssigned) / (n + others);
  return { acc, wrongRate, utility: (ok - WRONG_COST * (wrong + otherAssigned)) / (n + others), otherRate: others ? otherAssigned / others : 0 };
}
function bestThreshold(head, idx) {
  let best = null;
  for (let t = 0; t <= 0.9 + 1e-9; t += 0.01) {
    const r = evaluate(head, idx, t);
    if (r.otherRate > MAX_OTHER_ASSIGNED) continue;
    if (!best || r.utility > best.utility) best = { threshold: Math.round(t * 100) / 100, ...r };
  }
  return best ?? { threshold: 0.9, ...evaluate(head, idx, 0.9) };
}

// ---------- model selection on the val split ----------
let chosen = null;
for (const l2 of L2_GRID) {
  const head = { ...train(trainIdx, l2), ref: trainIdx };
  const r = bestThreshold(head, valIdx);
  console.log(
    `l2=${l2}: val acc ${(r.acc * 100).toFixed(1)}% @ t=${r.threshold}, wrong ${(r.wrongRate * 100).toFixed(1)}%, ` +
      `other assigned ${(r.otherRate * 100).toFixed(0)}%`,
  );
  // Ties go to the larger L2 (simpler model).
  if (!chosen || r.utility >= chosen.utility) chosen = { l2, head, ...r };
}

// Unsorted threshold for the chosen L2, from 5-fold out-of-fold scores over the whole pool. A single 15% val
// split is too small for it: the threshold it picks swings by 0.1+ when a few items change.
const FOLDS = 5;
const foldOf = new Array(pool.length);
for (let c = 0; c < LABELS.length; c++) {
  shuffle(Y.map((y, i) => (y === c ? i : -1)).filter((i) => i >= 0)).forEach((i, k) => (foldOf[i] = k % FOLDS));
}
const oof = { cache: new Map() };
for (let f = 0; f < FOLDS; f++) {
  const rest = pool.map((_, i) => i).filter((i) => foldOf[i] !== f);
  const h = { ...train(rest, chosen.l2), ref: rest };
  for (let i = 0; i < pool.length; i++) if (foldOf[i] === f) predict(h, i, 0);
  for (const [i, p] of h.cache ?? []) oof.cache.set(i, p);
}
const cv = bestThreshold(oof, pool.map((_, i) => i));
console.log(
  `${FOLDS}-fold: acc ${(cv.acc * 100).toFixed(1)}% @ t=${cv.threshold}, wrong ${(cv.wrongRate * 100).toFixed(1)}%, ` +
    `other assigned ${(cv.otherRate * 100).toFixed(0)}% (at t=0: wrong ${(evaluate(oof, pool.map((_, i) => i), 0).wrongRate * 100).toFixed(1)}%)`,
);

// Learned-exemplar override: treat train-split items as a user's learned exemplars and pick the
// lowest cosine at which "nearest exemplar's group" is right ≥ OVERRIDE_PRECISION of the time on val.
const dot = (a, b) => a.reduce((s, x, d) => s + x * b[d], 0);
const nearest = valIdx.map((i) => {
  let best = -1;
  let g = -1;
  for (const j of trainIdx) {
    if (Y[j] === OTHER) continue;
    const s = dot(X[i], X[j]);
    if (s > best) [best, g] = [s, Y[j]];
  }
  return { sim: best, right: g === Y[i] };
});
let similarity = 0.95;
for (let s = 0.5; s <= 0.95 + 1e-9; s += 0.01) {
  const hits = nearest.filter((x) => x.sim >= s);
  if (hits.length >= 10 && hits.filter((x) => x.right).length / hits.length >= OVERRIDE_PRECISION) {
    similarity = Math.round(s * 100) / 100;
    break;
  }
}

// Final head: same L2, trained on the whole pool.
const final = train(pool.map((_, i) => i), chosen.l2);
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
