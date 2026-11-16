import { EMBED_MODEL, EMBED_POOLING } from '../classify/model';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { handle, send } from '../shared/rpc.ts';
/**
 * Second layer of the idle close (the first is the background's `offscreen-idle` alarm): after this long
 * without a request the document asks the background to close it. An offscreen document has no
 * chrome.offscreen API; chrome.offscreen.closeDocument() from the worker is the supported way to close it.
 */
export const SELF_IDLE_MS = 60_000;
let busy = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (busy > 0) return;
    // The background closes us only if it has nothing in flight. If it can't be reached, close ourselves.
    send({ t: 'offscreenIdle' }).catch(() => window.close());
  }, SELF_IDLE_MS);
}
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
  extractor ??= pipeline('feature-extraction', EMBED_MODEL, {
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
  busy++;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  try {
    const ex = await getExtractor();
    const out = await ex(req.texts, { pooling: EMBED_POOLING, normalize: true });
    return out.tolist() as number[][];
  } finally {
    busy--;
    if (busy === 0) armIdle();
  }
}, 'offscreen');
armIdle(); // a document created but never used closes too
