#!/usr/bin/env node
// Downloads the public datasets used as an extra fine-tuning source (training/PUBLIC-DATA.md). Build-time only.
//
//   node scripts/public-data/fetch.mjs --out DIR [--source bl|reddit|all]
//
// DIR should be a new, empty directory outside the repo: downloaded data is untrusted and is only ever read as data
// (map.mjs parses it as JSON / CSV text). Writes, per source, DIR/<source>/README.md (the dataset card, which states
// the licence) and the raw rows, and prints each file's SHA-256 so the run can be recorded.
//
// bl:     TheBritishLibrary/web_archive_classification on Hugging Face (UK Web Archive, Public Domain Mark 1.0).
//         The original TSV link in its loading script is gone (404), so the rows are read from the Hugging Face
//         datasets-server (its parquet conversion of the same TSV), 100 per request, to DIR/bl/rows.jsonl with the
//         class-label numbers turned back into names: {primary, secondary, title, url}.
// reddit: daspartho/subreddit-posts on Hugging Face (Apache-2.0): titles of the top 1000 posts of 250 subreddits,
//         DIR/reddit/posts.csv (columns title, label = subreddit). No post URLs.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' }, source: { type: 'string', default: 'all' } } });
if (!values.out) {
  console.error('usage: node scripts/public-data/fetch.mjs --out DIR [--source bl|reddit|all]');
  process.exit(2);
}
const OUT = resolve(values.out);
const UA = { 'user-agent': 'tablight-build/1.0 (dataset fetch)' };

async function get(url, tries = 10) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: UA, redirect: 'follow' });
    if (res.ok) return res;
    if (i >= tries || (res.status !== 429 && res.status < 500)) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(5000 * i);
  }
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
async function save(path, data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  await writeFile(path, buf);
  console.log(`${path}: ${buf.length} bytes, sha256 ${sha(buf)}`);
}

async function fetchBl() {
  const ds = 'TheBritishLibrary/web_archive_classification';
  const dir = join(OUT, 'bl');
  await mkdir(dir, { recursive: true });
  await save(join(dir, 'README.md'), await (await get(`https://huggingface.co/datasets/${ds}/raw/main/README.md`)).text());
  const base = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(ds)}&config=default&split=train`;
  const lines = [];
  let names = null;
  let total = Infinity;
  for (let offset = 0; offset < total; offset += 100) {
    if (offset) await sleep(1000); // the datasets-server rate-limits bursts (HTTP 429)
    const page = await (await get(`${base}&offset=${offset}&length=100`)).json();
    total = page.num_rows_total;
    if (!names) {
      const f = Object.fromEntries(page.features.map((x) => [x.name, x.type.names]));
      names = { primary: f.primary_category, secondary: f.secondary_category };
    }
    for (const { row } of page.rows) {
      lines.push(JSON.stringify({
        primary: names.primary[row.primary_category] ?? null,
        secondary: names.secondary[row.secondary_category] ?? null,
        title: String(row.title ?? ''),
        url: String(row.url ?? ''),
      }));
    }
  }
  if (lines.length !== total) throw new Error(`bl: got ${lines.length} rows of ${total}`);
  await save(join(dir, 'rows.jsonl'), `${lines.join('\n')}\n`);
  console.log(`bl: ${lines.length} rows`);
}

async function fetchReddit() {
  const ds = 'daspartho/subreddit-posts';
  const dir = join(OUT, 'reddit');
  await mkdir(dir, { recursive: true });
  await save(join(dir, 'README.md'), await (await get(`https://huggingface.co/datasets/${ds}/raw/main/README.md`)).text());
  await save(join(dir, 'posts.csv'), Buffer.from(await (await get(`https://huggingface.co/datasets/${ds}/resolve/main/posts.csv`)).arrayBuffer()));
}

if (values.source === 'bl' || values.source === 'all') await fetchBl();
if (values.source === 'reddit' || values.source === 'all') await fetchReddit();
