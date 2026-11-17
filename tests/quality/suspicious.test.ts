import { describe, expect, it } from 'vitest';
import fixture from './fixture.json';
import holdout from './holdout.json';
import holdout2 from './holdout2.json';
import spam from './spam-fixture.json';
import trainA from '../../training/train-a.json';
import trainB from '../../training/train-b.json';
import trainC from '../../training/train-c.json';
import trainD from '../../training/train-d.json';
import { addressClue, titleClue } from '../../src/background/suspicious';
interface Row { title: string; url: string }
const normal = [fixture, holdout, holdout2, trainA, trainB, trainC, trainD].flat() as Row[];
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;
describe('suspicious-tab clue quality', () => {
  it('no normal tab has both an ad-click address and a scam title', () => {
    let addressOnly = 0;
    let titleOnly = 0;
    const both: Row[] = [];
    for (const r of normal) {
      const a = addressClue(r.url);
      const t = titleClue(r.title);
      if (a && t) both.push(r);
      else if (a) addressOnly++;
      else if (t) titleOnly++;
    }
    console.log(`normal rows ${normal.length}: address alone ${addressOnly}, title alone ${titleOnly}, both ${both.length}`);
    expect(both).toEqual([]);
  });
  it('catches most spam-fixture tabs on content alone', () => {
    const rows = spam as Row[];
    const both = rows.filter((r) => addressClue(r.url) && titleClue(r.title));
    const any = rows.filter((r) => addressClue(r.url) || titleClue(r.title));
    const missed = rows.filter((r) => !addressClue(r.url) && !titleClue(r.title));
    console.log(`spam rows ${rows.length}: both clues ${both.length} (${pct(both.length, rows.length)}), at least one ${any.length} (${pct(any.length, rows.length)})`);
    console.log('misses:', JSON.stringify(missed.map((r) => r.title)));
    expect(any.length / rows.length).toBeGreaterThanOrEqual(0.8);
  });
});
