import { resolve } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
/** Loads the bundled all-MiniLM-L6-v2 (q8) from public/models, with remote loading off. */
export async function loadEmbedder(): Promise<(texts: string[]) => Promise<Float32Array[]>> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = resolve(import.meta.dirname, '../../public/models') + '/';
  const ex: FeatureExtractionPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  return async (texts) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const t = await ex(texts.slice(i, i + 64), { pooling: 'mean', normalize: true });
      for (const row of t.tolist() as number[][]) out.push(Float32Array.from(row));
    }
    return out;
  };
}
