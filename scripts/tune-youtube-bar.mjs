// Build-time / evaluation only: chooses a head's YouTube bar (head.youtubeThreshold, read by pickGroup) for an
// encoder whose score scale differs from bge-small's, using only rows that encoder never trained on.
//
//   CALIBRATION=<calibration.json> MODEL_ID=… MODEL_PATH=… HEAD=<head.json> [OUT=<head.json>] \
//     node scripts/tune-youtube-bar.mjs
//
// Rows: the YouTube videos (isYouTubeVideo) among the calibration rows of finetune.py's split. Scores: the same
// out-of-fold blended head scores train-head.mjs uses to set head.threshold (same pool, same fitHead call and seed),
// so no row is scored by a head that trained on it. Each bar from 0 to head.threshold is scored as the YouTube gate
// scores a set (youtube-bar.mjs); the best one is written into the head as `youtubeThreshold` (OUT, default HEAD).
// No tests/quality set other than fixture.json (part of the training pool) is read. Rows of training/sessions-tune.json
// are added only when fewer than MIN_ROWS calibration rows are YouTube videos (scored by the head in HEAD).
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { runnerImport } from 'vite';
import { calibrationIndices } from './calibration.mjs';
import { fitHead } from './head-fit.mjs';
import { MODEL_ID as DEFAULT_MODEL, MODEL_POOLING } from './model-manifest.mjs';
import { chooseYoutubeBar } from './youtube-bar.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = process.env.MODEL_ID ?? DEFAULT_MODEL;
const MODEL_PATH = process.env.MODEL_PATH ?? join(root, 'public', 'models');
const POOLING = process.env.POOLING ?? MODEL_POOLING;
const { CALIBRATION, HEAD } = process.env;
const OUT = process.env.OUT ?? HEAD;
const MIN_ROWS = 60;
if (!CALIBRATION || !HEAD) throw new Error('CALIBRATION and HEAD are required');

const load = async (p) => (await runnerImport(join(root, p))).module;
const { embedText, isYouTubeVideo } = await load('src/shared/url.ts');
const { ruleGroup } = await load('src/classify/rules.ts');
const { STARTER_GROUPS } = await load('src/classify/seeds.ts');
const { headTop } = await load('src/classify/assign.ts');
const LABELS = STARTER_GROUPS.map((g) => g.id);
// The YouTube gate scores with the installed (starter) groups.
const installed = new Set(STARTER_GROUPS.filter((g) => !g.onDemand).map((g) => g.id));

const headText = await readFile(HEAD, 'utf8');
const head = JSON.parse(headText);

// Same files, order and dedupe as train-head.mjs, so pool indices and the poolHash match.
const files = [
  'training/train-a.json', 'training/train-b.json', 'training/train-c.json', 'training/train-d.json', 'training/train-e.json', 'training/train-f.json',
  'tests/quality/fixture.json',
];
const seen = new Set();
const pool = [];
for (const f of files) {
  for (const r of JSON.parse(await readFile(join(root, f), 'utf8'))) {
    const key = `${r.url}\n${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({ title: r.title, url: r.url, group: r.group });
  }
}
const poolHash = createHash('sha256').update(JSON.stringify(pool)).digest('hex');
if (head.poolHash && head.poolHash !== poolHash) throw new Error(`${HEAD}: trained on another pool (poolHash differs)`);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODEL_PATH.endsWith('/') ? MODEL_PATH : `${MODEL_PATH}/`;
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
const embed = async (rows) => {
  const X = [];
  for (let i = 0; i < rows.length; i += 64) {
    const out = await extractor(rows.slice(i, i + 64).map(embedText), { pooling: POOLING, normalize: true });
    X.push(...out.tolist());
  }
  return X;
};
const X = await embed(pool);
const Y = pool.map((r) => LABELS.indexOf(r.group));
const RULE = pool.map((r) => ruleGroup(r.url, r.title));
const calIdx = calibrationIndices(pool, JSON.parse(await readFile(CALIBRATION, 'utf8')));
if (!calIdx.length) throw new Error(`${CALIBRATION}: no key matches a pool row`);

// The exact fitHead call of train-head.mjs (seed 42, wrong cost 2): its out-of-fold scores are the ones that set
// head.threshold, so cv.threshold must come out equal to it.
const { cv, oof } = fitHead({ X, Y, rule: RULE, labels: LABELS, calIdx, seed: 42, wrongCost: 2, log: () => {} });
if (cv.threshold !== head.threshold) throw new Error(`out-of-fold threshold ${cv.threshold} ≠ head.threshold ${head.threshold}`);

const topOf = (p) => {
  let top = 0;
  for (let c = 1; c < p.length; c++) if (p[c] > p[top]) top = c;
  return { label: LABELS[top], score: p[top] };
};
const rows = [];
for (const i of calIdx) {
  if (!isYouTubeVideo(pool[i].url)) continue;
  const p = oof.get(i);
  // A rule hit is never scored by the head (fitHead leaves it out of oof); its outcome does not depend on the bar
  // when its group is installed, and every YouTube rule group (music, tv) is.
  if (!p && !(RULE[i] && installed.has(RULE[i]))) throw new Error(`no out-of-fold score for pool row ${i}`);
  rows.push({ group: pool[i].group, rule: RULE[i], ...(p ? topOf(p) : { label: null, score: 0 }) });
}
const calRows = rows.length;
let tuneRows = 0;
if (calRows < MIN_ROWS) {
  const tune = JSON.parse(await readFile(join(root, 'training/sessions-tune.json'), 'utf8'));
  const tabs = tune.filter((r) => isYouTubeVideo(r.url)); // flat rows: { person, title, url, group }
  const V = await embed(tabs);
  tabs.forEach((r, k) => rows.push({ group: r.group, rule: ruleGroup(r.url, r.title), ...headTop(V[k], head) }));
  tuneRows = tabs.length;
}

const { best, table } = chooseYoutubeBar(rows, { threshold: head.threshold, installed });
const byGroup = {};
for (const r of rows) byGroup[r.group] = (byGroup[r.group] ?? 0) + 1;
console.log(`${HEAD}: head.threshold ${head.threshold}; ${calRows} calibration YouTube rows${tuneRows ? ` + ${tuneRows} sessions-tune` : ''}`);
console.log(`labels: ${Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(', ')}`);
for (const s of table) console.log(`  bar ${s.bar.toFixed(2)}  hits ${s.hits}/${s.n}  wrong ${s.wrong}  parked ${s.parked}${s === best ? '  <- chosen' : ''}`);
const legacy = table.find((s) => Math.abs(s.bar - Math.min(0.26, head.threshold)) < 1e-9);
if (legacy) console.log(`at the shipped bar min(0.26, threshold) = ${legacy.bar}: hits ${legacy.hits}/${legacy.n}, wrong ${legacy.wrong}`);

// Keep head.json's layout: insert (or replace) the field after `similarity`.
const field = `"youtubeThreshold":${best.bar}`;
const next = /"youtubeThreshold":[-0-9.e]+/.test(headText)
  ? headText.replace(/"youtubeThreshold":[-0-9.e]+/, field)
  : headText.replace(/("similarity":[-0-9.e]+,)/, `$1${field},`);
if (JSON.parse(next).youtubeThreshold !== best.bar) throw new Error('could not write youtubeThreshold');
await writeFile(OUT, next);
console.log(`youtubeThreshold ${best.bar} → ${OUT}`);
