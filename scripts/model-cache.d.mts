// Types for scripts/model-cache.mjs (imported by tests).
export interface CacheManifest { MODEL_ID: string; MODEL_REVISION: string; MODEL_FILES: Record<string, string> }
export function purgeOtherModels(modelsDir: string, keep?: string): Promise<string[]>;
export function restore(cacheDir: string, modelsDir: string, manifest?: CacheManifest): Promise<{ removed: string[]; copied: string[] }>;
export function save(cacheDir: string, modelsDir: string, manifest?: CacheManifest): Promise<{ saved: string[] }>;
