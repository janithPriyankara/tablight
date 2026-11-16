/**
 * The bundled embedding model. bge-small-en-v1.5 (int8) replaced all-MiniLM-L6-v2: +1.8 points top-1 in 5-fold
 * cross-validation on the training pool (89.3% vs 87.5%, both with the tuned head and neighbour blend).
 * Keep in sync with src/classify/model.ts (a unit test checks).
 */
export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const MODEL_POOLING = 'mean';
/** ONNX Runtime Web files copied to dist/ort, pinned so a changed node_modules can't slip into a release. */
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
export const ORT_FILES_SHA256 = {
  'ort-wasm-simd-threaded.mjs': 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f',
  'ort-wasm-simd-threaded.wasm': '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3',
};
export const MODEL_FILES = {
  'onnx/model_quantized.onnx': '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
  'config.json': 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
  'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
};
