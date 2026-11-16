import { resolve } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBED_MODEL, EMBED_POOLING } from '../../src/classify/model';
export interface EmbedderOpts {
  model?: string;
  pooling?: 'mean' | 'cls';
  /** Directory holding <org>/<model>/. Defaults to the bundled public/models. */
  path?: string;
}
/** Loads a bundled embedding model (q8) with remote loading off. */
export async function loadEmbedder(opts: EmbedderOpts = {}): Promise<(texts: string[]) => Promise<Float32Array[]>> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = (opts.path ?? resolve(import.meta.dirname, '../../public/models')).replace(/\/?$/, '/');
  const ex: FeatureExtractionPipeline = await pipeline(
    'feature-extraction', opts.model ?? EMBED_MODEL, { dtype: 'q8' },
  );
  return async (texts) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const t = await ex(texts.slice(i, i + 64), { pooling: opts.pooling ?? EMBED_POOLING, normalize: true });
      for (const row of t.tolist() as number[][]) out.push(Float32Array.from(row));
    }
    return out;
  };
}
