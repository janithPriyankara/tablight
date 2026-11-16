import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { handle } from '../shared/rpc.ts';
// Must run before the first pipeline() call, otherwise Transformers.js fetches WASM from a CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.useBrowserCache = false;
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm;
if (!wasm) throw new Error('onnx wasm backend env missing; refusing to fall back to a CDN');
wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.mjs'),
  wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.wasm'),
};
wasm.numThreads = 1;
wasm.proxy = false;
let extractor: Promise<FeatureExtractionPipeline> | undefined;
function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'q8',
    device: 'wasm',
  }).catch((e: unknown) => {
    extractor = undefined; // allow a retry after a failed load
    throw e;
  });
  return extractor;
}
handle(async (req) => {
  if (req.t !== 'embed') throw new Error(`offscreen cannot handle "${req.t}"`);
  const ex = await getExtractor();
  const out = await ex(req.texts, { pooling: 'mean', normalize: true });
  return out.tolist() as number[][];
}, 'offscreen');
