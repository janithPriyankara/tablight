import { describe, it, expect } from 'vitest';
import { cosine, mean, normalize } from '../../src/shared/vec';
describe('vec', () => {
  it('cosine of identical and orthogonal vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('cosine with a zero vector is 0, not NaN', () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
  it('cosine accepts typed arrays', () => {
    expect(cosine(new Float32Array([2, 0]), new Float32Array([5, 0]))).toBeCloseTo(1);
  });
  it('normalize gives unit length', () => {
    const v = normalize([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(v[0]).toBeCloseTo(0.6);
  });
  it('normalize of zero vector does not produce NaN', () => {
    expect(normalize([0, 0])).toEqual([0, 0]);
  });
  it('mean of two vectors', () => {
    expect(mean([[1, 2], [3, 4]])).toEqual([2, 3]);
  });
  it('mean of nothing is empty', () => {
    expect(mean([])).toEqual([]);
  });
});
