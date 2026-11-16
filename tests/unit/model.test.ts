import { describe, expect, it } from 'vitest';
import { EMBED_MODEL, EMBED_POOLING } from '../../src/classify/model';
import { HEAD } from '../../src/classify/head';
import { MODEL_ID, MODEL_POOLING } from '../../scripts/model-manifest.mjs';
describe('embedding model', () => {
  it('the extension, the release manifest and the trained head all use the same model and pooling', () => {
    expect(MODEL_ID).toBe(EMBED_MODEL);
    expect(MODEL_POOLING).toBe(EMBED_POOLING);
    expect(HEAD.model).toBe(EMBED_MODEL);
    expect((HEAD as { pooling?: string }).pooling ?? 'mean').toBe(EMBED_POOLING);
  });
  it('ships its neighbour data in the shape classify() expects', () => {
    const k = HEAD.knn!;
    expect(k.k).toBeGreaterThan(0);
    expect(atob(k.vecs).length).toBe(k.labels.length * HEAD.dim);
    expect(k.labels.every((l) => Number.isInteger(l) && l >= 0 && l < HEAD.labels.length)).toBe(true);
  });
});
