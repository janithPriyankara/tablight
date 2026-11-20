import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restore, save } from '../../scripts/model-cache.mjs';
import { MODEL_FILES, MODEL_ID, MODEL_REVISION } from '../../scripts/model-manifest.mjs';
// The Jenkins model cache (/tmp/tablight-model-cache) outlives workspaces; it may hold an old model.
let root: string;
let cache: string;
let models: string;
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const tree = (dir: string): string[] => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name)).map((x) => `${e.name}/${x}`) : [e.name]))
  : []);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'model-cache-'));
  cache = join(root, 'cache');
  models = join(root, 'public', 'models');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('model cache for CI (committed local- model)', () => {
  it('the bundled model is committed, so the cache is never read or written', () => {
    expect(MODEL_REVISION.startsWith('local-')).toBe(true);
  });
  it('a stale Xenova model in the cache and in the workspace never reaches public/models', async () => {
    put(cache, 'Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx', 'old');
    put(cache, `${MODEL_ID}/config.json`, 'stale copy');
    put(models, 'Xenova/bge-small-en-v1.5/config.json', 'old'); // left by an earlier build
    put(models, `${MODEL_ID}/config.json`, 'tracked');
    const r = await restore(cache, models);
    expect(r).toEqual({ removed: ['Xenova/bge-small-en-v1.5'], copied: [] });
    expect(tree(models)).toEqual([`${MODEL_ID.split('/')[0]}/${MODEL_ID.split('/')[1]}/config.json`]);
    expect(readFileSync(join(models, MODEL_ID, 'config.json'), 'utf8')).toBe('tracked'); // never overwritten
    // save leaves the cache alone for a committed model.
    expect(await save(cache, models)).toEqual({ saved: [] });
    expect(readFileSync(join(cache, MODEL_ID, 'config.json'), 'utf8')).toBe('stale copy');
  });
});
describe('model cache for a downloaded model', () => {
  const remote = { MODEL_ID: 'Org/remote-model', MODEL_REVISION: 'abc123', MODEL_FILES: { 'config.json': 'x', 'onnx/m.onnx': 'y' } };
  it('restores only missing pinned files of that model, and save keeps only that model in the cache', async () => {
    put(cache, 'Org/remote-model/config.json', 'cached');
    put(cache, 'Org/remote-model/onnx/m.onnx', 'cached onnx');
    put(cache, 'Org/remote-model/extra.bin', 'not pinned');
    put(cache, 'Xenova/old/config.json', 'old');
    put(models, 'Org/remote-model/config.json', 'workspace');
    const r = await restore(cache, models, remote);
    expect(r.copied).toEqual(['onnx/m.onnx']);
    expect(readFileSync(join(models, 'Org/remote-model/config.json'), 'utf8')).toBe('workspace');
    expect(tree(models).sort()).toEqual(['Org/remote-model/config.json', 'Org/remote-model/onnx/m.onnx']);
    expect((await save(cache, models, remote)).saved).toEqual(['config.json', 'onnx/m.onnx']);
    expect(tree(cache).filter((p) => p.startsWith('Xenova'))).toEqual([]);
  });
  it('MODEL_FILES of the bundled model are what the cache would handle', () => {
    expect(Object.keys(MODEL_FILES)).toContain('onnx/model_quantized.onnx');
  });
});
