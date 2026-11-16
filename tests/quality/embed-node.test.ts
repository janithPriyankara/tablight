import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
let ex: FeatureExtractionPipeline;
beforeAll(async () => {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = resolve(import.meta.dirname, '../../public/models') + '/';
  ex = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
}, 120_000);
async function e(text: string): Promise<number[]> {
  const out = await ex([text], { pooling: 'mean', normalize: true });
  return (out.tolist() as number[][])[0]!;
}
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
describe('embedding quality (node)', () => {
  it('gives 384-dim unit vectors', async () => {
    const v = await e('hello world');
    expect(v).toHaveLength(384);
    expect(Math.abs(Math.sqrt(dot(v, v)) - 1)).toBeLessThan(1e-3);
  });
  it('ranks related tabs above unrelated ones', async () => {
    const a = await e('LangGraph agents tutorial — YouTube video');
    const near = await e('Claude Agent SDK docs — docs.anthropic.com');
    const far = await e('Best pasta recipe — food blog');
    expect(dot(a, near)).toBeGreaterThan(dot(a, far));
  });
});
