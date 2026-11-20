import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script helper
import { calibrationIndices, matchCalibration, rowKey } from '../../scripts/calibration.mjs';
// @ts-expect-error plain .mjs build script helper
import { fitHead, mulberry32 } from '../../scripts/head-fit.mjs';
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
describe('matchCalibration (train-head key check)', () => {
  it('returns the indices when every distinct key matches a pool row', () => {
    const keys = [rowKey(pool[3]!), rowKey(pool[0]!), rowKey(pool[0]!)];
    expect(matchCalibration(pool, keys, { file: 'cal.json' })).toEqual([0, 3]);
  });
  it('throws when no key matches', () => {
    expect(() => matchCalibration(pool, ['https://nowhere.test/\nZ'], { file: 'cal.json' })).toThrow(/cal\.json: none of its 1 keys/);
  });
  it('throws on a partial match: a drifted pool must not quietly shrink the calibration set', () => {
    const keys = [rowKey(pool[0]!), 'https://nowhere.test/\nZ'];
    expect(() => matchCalibration(pool, keys, { file: 'cal.json' })).toThrow(/only 1 of its 2 distinct keys/);
  });
  it('accepts a partial match only with the explicit override', () => {
    const keys = [rowKey(pool[0]!), 'https://nowhere.test/\nZ'];
    expect(matchCalibration(pool, keys, { allowPartial: true })).toEqual([0]);
  });
});
// fitHead is train-head.mjs's selection and training step; here it runs on small synthetic vectors.
const LABELS = ['a', 'b', 'other'];
/** 90 unit vectors in 3 dims, 30 per label, each a noisy copy of its label's axis. */
function synth() {
  const rand = mulberry32(7);
  const X: number[][] = [];
  const Y: number[] = [];
  for (let i = 0; i < 90; i++) {
    const y = i % 3;
    const v = [0, 1, 2].map((d) => (d === y ? 1 : 0) + (rand() - 0.5) * 0.8);
    const norm = Math.hypot(...v);
    X.push(v.map((x) => x / norm));
    Y.push(y);
  }
  return { X, Y, rule: X.map(() => null), labels: LABELS, epochs: 40, log: () => {} };
}
describe('fitHead with calibration rows (train-head CALIBRATION)', () => {
  const calIdx = Array.from({ length: 24 }, (_, k) => k * 3 + (k % 3)); // 24 rows, 8 per label
  it('validates, thresholds and picks the similarity on the calibration rows only', () => {
    const r = fitHead({ ...synth(), calIdx });
    expect(r.valIdx).toEqual(calIdx);
    expect(r.scored).toEqual(calIdx);
    expect(r.trainIdx).toEqual(Array.from({ length: 90 }, (_, i) => i).filter((i) => !calIdx.includes(i)));
    expect(r.chosen.count).toBe(calIdx.length); // L2 choice scored on calibration rows
    expect(r.cv.count).toBe(calIdx.length); // out-of-fold threshold scored on calibration rows
    expect(r.similarityCount).toBe(calIdx.length); // override similarity queried with calibration rows
    expect(r.final.W).toHaveLength(LABELS.length); // final head still trains on the whole pool
  });
  it('without calibration, uses a 15% split and out-of-fold scores over the whole pool', () => {
    const r = fitHead({ ...synth(), calIdx: null });
    expect(r.valIdx).toHaveLength(15); // round(30 × 0.15) = 5 per label
    expect(r.chosen.count).toBe(15);
    expect(r.cv.count).toBe(90);
    expect(r.similarityCount).toBe(15);
  });
  it('fails loudly on an empty calibration set', () => {
    expect(() => fitHead({ ...synth(), calIdx: [] })).toThrow(/no calibration row/);
  });
});
