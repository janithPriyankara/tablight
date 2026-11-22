// The name step on its development set (tests/quality/names-dev.json; not blind: the list's rules were tuned on it).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nameLabel, parseNames } from '../../src/classify/names';
import rows from './names-dev.json';

/** Every label the name list, the Wikipedia disambiguators and the part-number patterns can give. */
const NAME_LABELS = new Set(['tv', 'movies', 'games', 'music', 'anime', 'books', 'cars', 'sports', 'hardware']);

describe('name step on names-dev.json', () => {
  it('precision ≥ 95% (recall reported, not gated)', () => {
    const index = parseNames(readFileSync(resolve(import.meta.dirname, '../../public/names/names.txt'), 'utf8'));
    const data = rows as { url: string; title: string; group: string }[];
    let fired = 0;
    let right = 0;
    let positives = 0;
    let found = 0;
    let negFired = 0;
    for (const r of data) {
      const got = nameLabel(r.url, r.title, index);
      const positive = NAME_LABELS.has(r.group);
      if (positive) positives++;
      if (got === null) continue;
      fired++;
      if (got === r.group) {
        right++;
        found++;
      }
      if (!positive) negFired++;
    }
    const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;
    console.log(
      `NAMES-DEV (${data.length} rows) precision ${right}/${fired} = ${pct(right, fired)}; ` +
        `recall ${found}/${positives} = ${pct(found, positives)}; negatives fired ${negFired}/${data.length - positives}`,
    );
    expect(fired).toBeGreaterThan(0);
    expect(right / fired).toBeGreaterThanOrEqual(0.95);
  });
});
