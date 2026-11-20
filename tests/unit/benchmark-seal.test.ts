import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/shared/url';
const root = resolve(import.meta.dirname, '../..');
const normTitle = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const normUrl = (u: string) => normalizeUrl(u).toLowerCase();
/**
 * Near-duplicate title form: lowercased, the trailing site suffix dropped (" - YouTube", " | Site", " — Site",
 * " · Site"), then punctuation and symbols removed and spaces collapsed. Forms shorter than NEAR_MIN chars are
 * skipped: generic titles ("Inbox", "Home") match across unrelated sites and say nothing about leakage.
 */
const SITE_SUFFIX = /\s+[-|—–·•]\s+[^-|—–·•]{1,40}$/u;
const NEAR_MIN = 8;
/**
 * Near-duplicate title matches allowed. The benchmark was re-sealed on 2026-11-20, before scoring, without the 22 rows
 * whose near form matched a training or quality title, so none may remain.
 */
const KNOWN_NEAR = 0;
const nearTitle = (t: string): string =>
  t.toLowerCase().replace(/\s+/g, ' ').trim().replace(SITE_SUFFIX, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
type Row = { title: string; url: string };
/**
 * JSON files under training/ or tests/quality/ that are deliberately not arrays of {title, url} rows, by path. None
 * today. Any other file of another shape fails the check instead of being skipped: a training file the leakage
 * check silently ignored would defeat it.
 */
const NOT_ROWS: ReadonlySet<string> = new Set<string>([]);
const isRow = (r: unknown): r is Row =>
  !!r && typeof r === 'object' && typeof (r as Row).title === 'string' && typeof (r as Row).url === 'string';
async function rowsOf(dir: string): Promise<{ file: string; rows: Row[] }[]> {
  const files = (await readdir(resolve(root, dir))).filter((f) => f.endsWith('.json'));
  const out: { file: string; rows: Row[] }[] = [];
  for (const f of files) {
    const file = `${dir}/${f}`;
    if (NOT_ROWS.has(file)) continue;
    const data: unknown = JSON.parse(await readFile(resolve(root, dir, f), 'utf8'));
    // Names the file only, never a row.
    if (!Array.isArray(data) || !data.every(isRow)) throw new Error(`${file} is not an array of {title, url} rows (add it to NOT_ROWS if that is intended)`);
    out.push({ file, rows: data });
  }
  return out;
}
describe('nearTitle', () => {
  it('drops a site suffix, punctuation and case', () => {
    expect(nearTitle('How to Fix a Bike Chain! - YouTube')).toBe('how to fix a bike chain');
    expect(nearTitle('how to fix a bike chain | Some Site')).toBe('how to fix a bike chain');
    expect(nearTitle('How to: fix a bike-chain')).toBe('how to fix a bike chain');
  });
});
describe('sealed benchmark', () => {
  it('benchmark.json matches the SHA-256 in SEAL.md', async () => {
    const seal = await readFile(resolve(root, 'tests/benchmark/SEAL.md'), 'utf8');
    const want = /SHA-256:\s*`([0-9a-f]{64})`/.exec(seal)?.[1];
    expect(want).toBeTruthy();
    const got = createHash('sha256').update(await readFile(resolve(root, 'tests/benchmark/benchmark.json'))).digest('hex');
    expect(got).toBe(want);
  });
  it('no benchmark title or URL appears in any training or quality file', async () => {
    const bench: Row[] = JSON.parse(await readFile(resolve(root, 'tests/benchmark/benchmark.json'), 'utf8'));
    const titles = new Set(bench.map((r) => normTitle(r.title)));
    const urls = new Set(bench.map((r) => normUrl(r.url)));
    const sources = [...(await rowsOf('training')), ...(await rowsOf('tests/quality'))];
    const near = new Set(bench.map((r) => nearTitle(r.title)).filter((t) => t.length >= NEAR_MIN));
    let titleHits = 0;
    let urlHits = 0;
    let nearHits = 0;
    let checked = 0;
    const nearBench = new Set<string>(); // distinct benchmark near-forms hit
    for (const { rows } of sources) {
      for (const r of rows) {
        checked++;
        if (titles.has(normTitle(r.title))) titleHits++;
        if (urls.has(normUrl(r.url))) urlHits++;
        const n = nearTitle(r.title);
        if (n.length >= NEAR_MIN && near.has(n)) {
          nearHits++;
          nearBench.add(n);
        }
      }
    }
    const short = [...nearBench].filter((n) => n.split(' ').length <= 2).length;
    // Counts only: never print a matching row.
    console.log(
      `leakage check: ${bench.length} benchmark rows vs ${checked} rows in ${sources.length} files: ${titleHits} title matches, ` +
        `${urlHits} url matches, ${nearHits} near-duplicate title matches (${nearBench.size} distinct benchmark titles, ` +
        `${short} of them one or two words)`,
    );
    expect(titleHits).toBe(0);
    expect(urlHits).toBe(0);
    expect(nearHits).toBeLessThanOrEqual(KNOWN_NEAR);
  });
});
