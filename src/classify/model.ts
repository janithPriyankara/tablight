/**
 * The bundled embedding model and how its output is pooled. One place for the background (cache keys), the
 * offscreen document (the pipeline) and the tests; scripts/model-manifest.mjs pins the same id and pooling,
 * and head.json must have been trained with them (tests/unit/model.test.ts checks all three agree).
 */
export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_POOLING: 'mean' | 'cls' = 'mean';
