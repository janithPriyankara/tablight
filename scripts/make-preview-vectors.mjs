// One-off: embeds the UI preview's texts with the real bundled model and writes
// src/ui/mock/fixtures.vectors.json (compact, 3 decimals). Run: npm run preview:vectors
// Texts come from the app's own code (embedText, starter-group seeds), loaded through Vite so they never drift.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { createServer } from 'vite';
const root = resolve(import.meta.dirname, '..');
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});
const { previewTabs, SAMPLE_QUERIES } = await server.ssrLoadModule('/src/ui/mock/fixtures.ts');
const { embedText, isWebUrl } = await server.ssrLoadModule('/src/shared/url.ts');
const { buildStarterGroups } = await server.ssrLoadModule('/src/classify/assign.ts');
const texts = new Set();
await buildStarterGroups(async (t) => {
  for (const x of t) texts.add(x);
  return t.map(() => new Float32Array(384));
});
for (const t of previewTabs()) if (isWebUrl(t.url)) texts.add(embedText(t));
for (const q of SAMPLE_QUERIES) texts.add(q);
await server.close();
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = resolve(root, 'public/models') + '/';
const ex = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
const list = [...texts];
const vectors = {};
for (let i = 0; i < list.length; i += 64) {
  const out = await ex(list.slice(i, i + 64), { pooling: 'mean', normalize: true });
  out.tolist().forEach((row, k) => {
    vectors[list[i + k]] = row.map((x) => Math.round(x * 1000) / 1000);
  });
}
const dim = Object.values(vectors)[0].length;
writeFileSync(resolve(root, 'src/ui/mock/fixtures.vectors.json'), JSON.stringify({ dim, vectors }) + '\n');
console.log(`wrote ${list.length} vectors (dim ${dim})`);
