import { describe, expect, it } from 'vitest';
import { EMBED_MODEL, EMBED_POOLING } from '../../src/classify/model';
import { HEAD } from '../../src/classify/head';
import { MODEL_FILES, MODEL_ID, MODEL_POOLING, MODEL_REVISION } from '../../scripts/model-manifest.mjs';
describe('embedding model', () => {
  it('the extension, the release manifest and the trained head all use the same model and pooling', () => {
    expect(MODEL_ID).toBe(EMBED_MODEL);
    expect(MODEL_POOLING).toBe(EMBED_POOLING);
    expect(HEAD.model).toBe(EMBED_MODEL);
    expect((HEAD as { pooling?: string }).pooling ?? 'mean').toBe(EMBED_POOLING);
  });
  it("pins Tablight's fine-tuned model, its revision marker naming the committed ONNX file's hash", () => {
    expect(MODEL_ID).toBe('tablight/bge-small-tabs-v1');
    expect(MODEL_FILES['onnx/model_quantized.onnx']).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL_REVISION).toBe(`local-${MODEL_FILES['onnx/model_quantized.onnx']!.slice(0, 12)}`);
  });
  it('ships its neighbour data in the shape classify() expects', () => {
    const k = HEAD.knn!;
    expect(k.k).toBeGreaterThan(0);
    expect(atob(k.vecs).length).toBe(k.labels.length * HEAD.dim);
    expect(k.labels.every((l) => Number.isInteger(l) && l >= 0 && l < HEAD.labels.length)).toBe(true);
  });
});
