import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/shared/url';
const root = resolve(import.meta.dirname, '../..');
const normTitle = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const normUrl = (u: string) => normalizeUrl(u).toLowerCase();
type Row = { title: string; url: string };
async function rowsOf(dir: string): Promise<{ file: string; rows: Row[] }[]> {
  const files = (await readdir(resolve(root, dir))).filter((f) => f.endsWith('.json'));
  const out: { file: string; rows: Row[] }[] = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(resolve(root, dir, f), 'utf8'));
    if (Array.isArray(data) && data.every((r) => r && typeof r === 'object' && 'title' in r && 'url' in r)) out.push({ file: `${dir}/${f}`, rows: data });
  }
  return out;
}
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
    let titleHits = 0;
    let urlHits = 0;
    let checked = 0;
    for (const { rows } of sources) {
      for (const r of rows) {
        checked++;
        if (titles.has(normTitle(r.title))) titleHits++;
        if (urls.has(normUrl(r.url))) urlHits++;
      }
    }
    console.log(`leakage check: ${bench.length} benchmark rows vs ${checked} rows in ${sources.length} files: ${titleHits} title matches, ${urlHits} url matches`);
    expect(titleHits).toBe(0);
    expect(urlHits).toBe(0);
  });
});
