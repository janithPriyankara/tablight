// Build-time / evaluation only: measures an encoder's similarity cut-offs on rows it never trained on.
//
//   node scripts/measure-similarity.mjs [MODELS_DIR=org/model ...]
//
// Rows: the training pool (as train-head.mjs builds it) restricted to the calibration keys of the bundled
// fine-tuned encoder (scripts/finetune/calibration-bge-small-tabs-v1.json, CALIBRATION overrides): the 20% of pool
// rows held out of its fine-tuning. No tests/quality set is read except fixture.json, which is part of the pool.
// Each argument is another encoder to measure on the same rows (e.g. a bge-small copy, for comparison); with none,
// the bundled model in public/models is measured.
//
// - Search (search.ts SEMANTIC_MIN): QUERIES below, two short searches per group, against every calibration row of
//   another group (`other` rows left out); the cut-off is the 99th percentile of those cosines, i.e. 99% of unrelated
//   tabs score below it. Also printed: the share of same-group rows at or above it.
// - Clustering (cluster.ts CLUSTER_THRESHOLD): over all pairs of calibration rows, the share of different-group
//   pairs and of same-group pairs at or above each threshold, and the threshold where the different-group share
//   equals the given model's share at CLUSTER_THRESHOLD.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { runnerImport } from 'vite';
import { calibrationIndices } from './calibration.mjs';
import { MODEL_ID, MODEL_POOLING } from './model-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CALIBRATION = process.env.CALIBRATION ?? join(root, 'scripts/finetune/calibration-bge-small-tabs-v1.json');
const load = async (p) => (await runnerImport(join(root, p))).module;
const { embedText } = await load('src/shared/url.ts');
const { CLUSTER_THRESHOLD } = await load('src/classify/cluster.ts');

/** Two short searches per group, as a person would type them. */
export const QUERIES = {
  movies: ['movie trailer', 'best films of the year'], tv: ['tv series episode guide', 'watch the new season'],
  ai: ['large language model agents', 'chatgpt prompts'], programming: ['python list comprehension', 'rust borrow checker error'],
  design: ['figma components', 'color palette ideas'], shopping: ['buy running shoes', 'laptop deals'],
  news: ['election results', 'breaking news today'], social: ['twitter thread', 'reddit discussion'],
  music: ['jazz playlist', 'guitar chords'], learning: ['online course machine learning', 'learn spanish lessons'],
  docs: ['api reference documentation', 'css grid docs'], work: ['team calendar meeting', 'jira tickets'],
  travel: ['cheap flights to tokyo', 'hotel booking paris'], finance: ['stock market index', 'mortgage rates'],
  health: ['symptoms of flu', 'workout routine'], games: ['zelda walkthrough', 'steam sale games'],
  hardware: ['esp32 sensor project', '3d printer settings'], science: ['black hole research', 'chemistry experiment'],
  sports: ['football scores', 'nba highlights'], food: ['pasta recipe', 'vegan dinner ideas'],
  cars: ['electric car review', 'engine oil change'], home: ['kitchen renovation', 'garden plants care'],
  fashion: ['summer outfits', 'sneakers style'], pets: ['puppy training', 'cat food'],
  family: ['parenting toddler tips', 'baby names'], jobs: ['software engineer jobs', 'resume tips'],
  books: ['fantasy novel recommendations', 'book review'], photo: ['camera lens review', 'photo editing lightroom'],
  anime: ['one piece episode', 'best anime 2025'], realestate: ['apartments for rent', 'house prices'],
};

// ---------- rows: the pool as train-head.mjs builds it, calibration rows only ----------
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
const rows = calibrationIndices(pool, JSON.parse(await readFile(CALIBRATION, 'utf8'))).map((i) => pool[i]);
if (!rows.length) throw new Error(`${CALIBRATION}: no calibration row matched the pool`);

const sorted = (a) => Float64Array.from(a).sort();
const quantile = (s, p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
/** Share of sorted `s` at or above `t`. */
const atLeast = (s, t) => {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (s[m] < t) lo = m + 1;
    else hi = m;
  }
  return (s.length - lo) / s.length;
};
const dot = (a, b) => {
  let s = 0;
  for (let d = 0; d < a.length; d++) s += a[d] * b[d];
  return s;
};
const pct = (x) => `${(x * 100).toFixed(2)}%`;

const targets = process.argv.slice(2).map((a) => {
  const k = a.lastIndexOf('=');
  return { path: a.slice(0, k), id: a.slice(k + 1) };
});
if (!targets.length) targets.push({ path: join(root, 'public', 'models'), id: MODEL_ID });
env.allowRemoteModels = false;
env.allowLocalModels = true;
console.log(`calibration rows: ${rows.length} (${CALIBRATION}); ${Object.values(QUERIES).flat().length} queries`);
for (const { path, id } of targets) {
  env.localModelPath = path.endsWith('/') ? path : `${path}/`;
  const ex = await pipeline('feature-extraction', id, { dtype: 'q8' });
  const embed = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
      out.push(...(await ex(texts.slice(i, i + 64), { pooling: MODEL_POOLING, normalize: true })).tolist());
    }
    return out;
  };
  const X = await embed(rows.map(embedText));
  // Search.
  const queries = Object.entries(QUERIES).flatMap(([group, ts]) => ts.map((text) => ({ group, text })));
  const Q = await embed(queries.map((q) => q.text));
  const unrelated = [];
  const related = [];
  queries.forEach((q, k) => rows.forEach((r, i) => {
    if (r.group === q.group) related.push(dot(Q[k], X[i]));
    else if (r.group !== 'other') unrelated.push(dot(Q[k], X[i]));
  }));
  const un = sorted(unrelated);
  const re = sorted(related);
  const cut = quantile(un, 0.99);
  console.log(`\n${id}\n  search: unrelated p99 ${cut.toFixed(3)} (p95 ${quantile(un, 0.95).toFixed(3)}), ` +
    `same-group rows at or above it ${pct(atLeast(re, cut))} (n unrelated ${un.length}, related ${re.length})`);
  // Clustering.
  const diff = [];
  const same = [];
  for (let i = 0; i < X.length; i++) for (let j = i + 1; j < X.length; j++) (rows[i].group === rows[j].group ? same : diff).push(dot(X[i], X[j]));
  const d = sorted(diff);
  const s = sorted(same);
  const at = (t) => `t=${t}: diff ${pct(atLeast(d, t))} same ${pct(atLeast(s, t))}`;
  console.log(`  clustering: ${[0.4, 0.45, 0.5, CLUSTER_THRESHOLD, 0.6].map(at).join(' | ')}`);
  console.log(`  different-group pairs at or above CLUSTER_THRESHOLD ${CLUSTER_THRESHOLD}: ${pct(atLeast(d, CLUSTER_THRESHOLD))}; ` +
    `quantiles p99 ${quantile(d, 0.99).toFixed(3)} p99.5 ${quantile(d, 0.995).toFixed(3)} p99.9 ${quantile(d, 0.999).toFixed(3)}`);
}
