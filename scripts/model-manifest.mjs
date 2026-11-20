/**
 * The bundled embedding model: BAAI/bge-small-en-v1.5 (MIT) fine-tuned by Tablight on its own synthetic labelled
 * tabs (scripts/finetune/, notes in docs/superpowers/notes/2026-11-20-finetune.md), exported as int8 ONNX in the
 * layout transformers.js loads. It is not downloaded: the files live in the repository under
 * public/models/tablight/bge-small-tabs-v1/, so MODEL_REVISION is a git-free marker, `local-` + the first 12 hex
 * digits of the ONNX file's SHA-256 (scripts/fetch-model.mjs only verifies a `local-` model in place).
 * Keep in sync with src/classify/model.ts (a unit test checks).
 */
export const MODEL_ID = 'tablight/bge-small-tabs-v1';
export const MODEL_REVISION = 'local-d9b63697cd5e';
export const MODEL_POOLING = 'mean';
/** ONNX Runtime Web files copied to dist/ort, pinned so a changed node_modules can't slip into a release. */
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
export const ORT_FILES_SHA256 = {
  'ort-wasm-simd-threaded.mjs': 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f',
  'ort-wasm-simd-threaded.wasm': '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3',
};
export const MODEL_FILES = {
  'onnx/model_quantized.onnx': 'd9b63697cd5ecea10e504f74b4197c8d21fdd1312d8cfcd4f1e38fc23d7564f6',
  'config.json': '98fad585a266cd31954a97923401d745e971044cceb8edafde041057526980a4',
  'tokenizer.json': '91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854',
  'tokenizer_config.json': '7b082b48a08a0b5c5939d99472e33addce3d96202155e33f7928cecd171186a0',
  'special_tokens_map.json': '5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a',
};
