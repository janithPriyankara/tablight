export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
/** ONNX Runtime Web files copied to dist/ort, pinned so a changed node_modules can't slip into a release. */
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
export const ORT_FILES_SHA256 = {
  'ort-wasm-simd-threaded.mjs': 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f',
  'ort-wasm-simd-threaded.wasm': '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3',
};
export const MODEL_FILES = {
  'onnx/model_quantized.onnx': 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
  'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
};
