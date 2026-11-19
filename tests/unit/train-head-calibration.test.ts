import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script helper
import { calibrationIndices, rowKey } from '../../scripts/calibration.mjs';
const pool = [
  { title: 'A', url: 'https://a.test/' },
  { title: 'B', url: 'https://b.test/' },
  { title: 'A', url: 'https://c.test/' },
  { title: 'D', url: 'https://d.test/' },
];
describe('calibrationIndices', () => {
  it('picks exactly the pool rows whose url+title key is listed', () => {
    const keys = [rowKey(pool[3]!), rowKey(pool[0]!), 'https://nowhere.test/\nZ'];
    expect(calibrationIndices(pool, keys)).toEqual([0, 3]);
  });
  it('matches finetune.py keys (`url\\ntitle`) and ignores rows that share only a title', () => {
    expect(rowKey(pool[0]!)).toBe('https://a.test/\nA');
    expect(calibrationIndices(pool, ['https://a.test/\nA'])).toEqual([0]);
  });
  it('is empty without keys: no row outside the file can reach threshold or similarity selection', () => {
    expect(calibrationIndices(pool, [])).toEqual([]);
  });
});
