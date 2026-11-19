#!/usr/bin/env node
// Maps the downloaded public datasets (fetch.mjs) onto Tablight's labels as training-only rows for
// scripts/finetune/finetune.py --extra. Build-time only. Mapping tables and licences: training/PUBLIC-DATA.md.
//
//   node scripts/public-data/map.mjs --raw DIR [--bl training/public-bl.json] [--reddit training/public-reddit.json]
//
// Rules:
// - BL web_archive_classification: a row keeps a label only when its (primary, secondary) category pair is in
//   BL_MAP; every other row is dropped. Rows without a usable title (empty, the bare address, "Home", "Index of",
//   error pages) are dropped.
// - subreddit-posts: only subreddits in REDDIT_MAP, which name six niche labels (anime, games, hardware, cars,
//   photo, food). A post becomes a reddit tab: title "<post title> : r/<sub>", address
//   https://www.reddit.com/r/<sub>/comments/<id>/<slug>/ (id from a hash of the title; the dataset has no addresses).
// - Leakage: a public row is dropped when its title, near-duplicate title form or address (host + path, lowercased,
//   without scheme, www., query or trailing slash) equals one of any row in training/*.json, tests/quality/*.json or
//   tests/benchmark/benchmark.json. Only counts are printed; no test row is printed or written.
// - Cap: public rows of a label are at most 40% of that label's rows once added to the pool
//   (public ≤ ⅔ × pool rows of the label), BL and reddit together; BL rows are kept first. Rows over the cap are
//   dropped by a seeded shuffle.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({
  options: { raw: { type: 'string' }, bl: { type: 'string' }, reddit: { type: 'string' }, seed: { type: 'string', default: '1' } },
});
if (!values.raw || (!values.bl && !values.reddit)) {
  console.error('usage: node scripts/public-data/map.mjs --raw DIR [--bl OUT.json] [--reddit OUT.json]');
  process.exit(2);
}

/** BL "primary|secondary" → label. Pairs not listed are dropped. */
export const BL_MAP = {
  'Arts & Humanities|Film / Cinema': 'movies',
  'Arts & Humanities|TV and Radio': 'tv',
  'Arts & Humanities|Music': 'music',
  'Arts & Humanities|Art and Design': 'design',
  'Arts & Humanities|News and Contemporary Events': 'news',
  'Arts & Humanities|Literature': 'books',
  'Arts & Humanities|Publishing, Printing and Bookselling': 'books',
  'Literature|19th Century English Literature': 'books',
  'Computer Science, Information Technology and Web Technology|Video Games': 'games',
  'Business, Economy & Industry|Banking, Insurance, Accountancy and Financial Economics': 'finance',
  'Business, Economy & Industry|Employment, Unemployment and Labour Economics': 'jobs',
  'Medicine & Health|Health Organisations and Services': 'health',
  'Medicine & Health|Conditions and Diseases': 'health',
  'Medicine & Health|Mental Health': 'health',
  'Medicine & Health|Medicines, Treatments and Therapies': 'health',
  'Medicine & Health|Personal Experiences of Illness': 'health',
  'Medicine & Health|Alternative Medicine / Complementary Medicine': 'health',
  'Science & Technology|Life Sciences': 'science',
  'Science & Technology|Physical Sciences': 'science',
  'Science & Technology|Popular Science': 'science',
  'Science & Technology|Mathematics': 'science',
  'Science & Technology|Engineering': 'science',
  'Life Sciences|Darwin 200': 'science',
  'Popular Science|Darwin 200': 'science',
  'Science & Technology|Zoology, Veterinary Science and Animal Health': 'pets',
  'Society & Culture|Sports and Recreation': 'sports',
  'Society & Culture|Food and Drink': 'food',
  'Society & Culture|Travel & Tourism': 'travel',
  'Travel & Tourism|British Countryside': 'travel',
  'Travel & Tourism|Cornwall': 'travel',
};

/** Subreddit (lowercase) → label, niche labels only. */
export const REDDIT_MAP = {
  anime: 'anime', comicbooks: 'anime',
  games: 'games', gaming: 'games', pcgaming: 'games', nintendoswitch: 'games', ps4: 'games', ps5: 'games',
  xboxone: 'games', minecraft: 'games', overwatch: 'games', leagueoflegends: 'games', destinythegame: 'games',
  raspberry_pi: 'hardware', woodworking: 'hardware',
  cars: 'cars',
  photography: 'photo', itookapicture: 'photo',
  cooking: 'food', recipes: 'food', food: 'food', foodporn: 'food', mealprepsunday: 'food', slowcooking: 'food',
};

const CAP_SHARE = 0.4;
const POOL_FILES = [
  'training/train-a.json', 'training/train-b.json', 'training/train-c.json', 'training/train-d.json',
  'training/train-e.json', 'training/train-f.json', 'tests/quality/fixture.json',
];

// --- normal forms (the seal test's title forms; a looser address form than normalizeUrl, so it drops more) ---
const SITE_SUFFIX = /\s+[-|—–·•]\s+[^-|—–·•]{1,40}$/u;
const NEAR_MIN = 8;
const normTitle = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const nearTitle = (t) =>
  t.toLowerCase().replace(/\s+/g, ' ').trim().replace(SITE_SUFFIX, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const looseUrl = (u) =>
  u.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\d?\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

// --- seeded shuffle ---
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(a, r) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- title cleaning ---
const BAD_TITLE = /^(home|home ?page|index|index of\b.*|welcome|untitled|untitled document|default|main|page not found|404\b.*|error\b.*|object moved|moved permanently|302 found|301 moved.*|document moved|domain .*for sale.*|this domain.*|coming soon|under construction|test page.*|apache.*|it works!?|iis.*|website disabled.*|account suspended.*|.*\bparked\b.*)$/i;
function cleanTitle(t) {
  const s = [...String(t ?? '')].map((ch) => (ch.charCodeAt(0) < 32 || ch === '\u007f' ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  if (s.length < 4 || s.length > 140) return null;
  if (BAD_TITLE.test(s)) return null;
  if (/^(https?:\/\/|www\.)\S+$/i.test(s) || /^[\w.-]+\.(co\.uk|org\.uk|ac\.uk|gov\.uk|uk|com|org|net)$/i.test(s)) return null;
  if (!/[a-z]/i.test(s)) return null;
  return s;
}

/** Rows of every JSON file in `dir`, except this script's own outputs (public-*.json), so a re-run reproduces them. */
async function rowsOf(dir) {
  const out = [];
  for (const f of (await readdir(join(root, dir))).filter((x) => x.endsWith('.json') && !x.startsWith('public-'))) {
    const data = JSON.parse(await readFile(join(root, dir, f), 'utf8'));
    if (Array.isArray(data)) out.push(...data.filter((r) => r && typeof r.title === 'string' && typeof r.url === 'string'));
  }
  return out;
}

// --- parsers ---
async function readBl(dir) {
  const text = await readFile(join(dir, 'bl', 'rows.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
async function readReddit(dir) {
  const [head, ...rows] = parseCsv(await readFile(join(dir, 'reddit', 'posts.csv'), 'utf8'));
  const ti = head.indexOf('title'), li = head.indexOf('label');
  if (ti < 0 || li < 0) throw new Error(`posts.csv: unexpected header ${JSON.stringify(head)}`);
  return rows.filter((r) => r.length > Math.max(ti, li)).map((r) => ({ title: r[ti], sub: r[li] }));
}

const slug = (t) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').split('_').slice(0, 8).join('_');
const postId = (t) => BigInt(`0x${createHash('sha256').update(t).digest('hex').slice(0, 10)}`).toString(36).slice(0, 7);

// --- main ---
const raw = resolve(values.raw);
const labels = JSON.parse((await import('node:child_process')).execFileSync('node', [join(root, 'scripts/finetune/labels.mjs')], { cwd: root, encoding: 'utf8' })).map((g) => g.id);
const labelSet = new Set(labels);
for (const l of [...Object.values(BL_MAP), ...Object.values(REDDIT_MAP)]) if (!labelSet.has(l)) throw new Error(`unknown label ${l}`);

const poolCount = {};
for (const f of POOL_FILES) for (const r of JSON.parse(await readFile(join(root, f), 'utf8'))) poolCount[r.group] = (poolCount[r.group] ?? 0) + 1;

// Every title / address in training/, tests/quality/ and the sealed benchmark (read for exclusion only).
const taken = { title: new Set(), near: new Set(), url: new Set() };
const takenRows = [
  ...(await rowsOf('training')), ...(await rowsOf('tests/quality')),
  ...JSON.parse(await readFile(join(root, 'tests/benchmark/benchmark.json'), 'utf8')),
];
for (const r of takenRows) {
  taken.title.add(normTitle(r.title));
  const n = nearTitle(r.title);
  if (n.length >= NEAR_MIN) taken.near.add(n);
  taken.url.add(looseUrl(r.url));
}
const stats = {};
const bump = (k) => (stats[k] = (stats[k] ?? 0) + 1);
const seen = { title: new Set(), url: new Set() };
function admit(row) {
  const t = normTitle(row.title), n = nearTitle(row.title), u = looseUrl(row.url);
  if (taken.title.has(t) || taken.url.has(u) || (n.length >= NEAR_MIN && taken.near.has(n))) return bump('dropped: overlaps training/quality/benchmark'), false;
  if (seen.title.has(t) || seen.url.has(u)) return bump('dropped: duplicate within public data'), false;
  seen.title.add(t);
  seen.url.add(u);
  return true;
}

const byLabel = {};
const add = (src, row) => (byLabel[row.group] ??= { bl: [], reddit: [] })[src].push(row);

if (values.bl) {
  for (const r of await readBl(raw)) {
    const label = BL_MAP[`${r.primary}|${r.secondary}`];
    if (!label) { bump('bl dropped: category not mapped'); continue; }
    const title = cleanTitle(r.title);
    if (!title) { bump('bl dropped: no usable title'); continue; }
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(r.url.trim())) { bump('bl dropped: bad address'); continue; }
    const row = { title, url: r.url.trim(), group: label };
    if (admit(row)) add('bl', row);
  }
}
if (values.reddit) {
  for (const p of await readReddit(raw)) {
    const label = REDDIT_MAP[p.sub.toLowerCase()];
    if (!label) { bump('reddit dropped: subreddit not mapped'); continue; }
    const t = cleanTitle(p.title.replace(/^"(.*)"$/s, '$1'));
    if (!t || t.length > 110) { bump('reddit dropped: no usable title'); continue; }
    const sub = p.sub;
    const row = { title: `${t} : r/${sub}`, url: `https://www.reddit.com/r/${sub}/comments/${postId(t)}/${slug(t)}/`, group: label };
    if (admit(row)) add('reddit', row);
  }
}

const r = rng(Number(values.seed));
const out = { bl: [], reddit: [] };
const table = [];
for (const label of labels) {
  const g = byLabel[label];
  if (!g) continue;
  const pool = poolCount[label] ?? 0;
  const cap = Math.floor(((CAP_SHARE / (1 - CAP_SHARE)) * pool) + 1e-9);
  const bl = shuffle(g.bl.slice(), r).slice(0, cap);
  const rd = shuffle(g.reddit.slice(), r).slice(0, cap - bl.length);
  out.bl.push(...bl);
  out.reddit.push(...rd);
  table.push({ label, pool, available_bl: g.bl.length, available_reddit: g.reddit.length, cap, kept_bl: bl.length, kept_reddit: rd.length, share: ((bl.length + rd.length) / (pool + bl.length + rd.length)).toFixed(3) });
}
console.table(table);
console.log(stats);
const order = (a, b) => labels.indexOf(a.group) - labels.indexOf(b.group) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
if (values.bl) {
  await writeFile(resolve(values.bl), `${JSON.stringify(out.bl.sort(order), null, 1)}\n`);
  console.log(`${values.bl}: ${out.bl.length} rows`);
}
if (values.reddit) {
  await writeFile(resolve(values.reddit), `${JSON.stringify(out.reddit.sort(order), null, 1)}\n`);
  console.log(`${values.reddit}: ${out.reddit.length} rows`);
}
