import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import { manifest } from './manifest.config.ts';
// Manifest paths are root-relative, so every HTML entry is emitted at the dist root.
// Asset URLs use base '/', which resolves against the extension root, so moving is safe.
function extensionPlugin(): Plugin {
  const flattened = new Map<string, string>();
  return {
    name: 'tab-organizer-extension',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.html')) {
          const flat = basename(file.fileName);
          if (flattened.has(flat)) {
            throw new Error(`HTML entries collide at the dist root: ${flat} (${file.fileName} and ${flattened.get(flat)})`);
          }
          flattened.set(flat, file.fileName);
          file.fileName = flat;
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
}
/**
 * Build record for the release gate, written outside dist/ (never packaged):
 *  - every module that ends up in a chunk, so licenses are checked for exactly the packages that ship;
 *  - per chunk, banned DOM-injection APIs found in the app's own modules versus in node_modules ones
 *    (a chunk can mix both, e.g. Preact shares a chunk with app hooks).
 */
const BANNED_DOM = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write(?:ln)?)\b/g;
function buildRecordPlugin(): Plugin {
  const modules = new Set<string>();
  const chunks: Record<string, { app: Record<string, number>; lib: Record<string, number> }> = {};
  return {
    name: 'tab-organizer-build-record',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        const entry = { app: {} as Record<string, number>, lib: {} as Record<string, number> };
        for (const [id, mod] of Object.entries(file.modules)) {
          modules.add(id);
          const side = id.includes('node_modules') ? entry.lib : entry.app;
          for (const m of mod.code?.matchAll(BANNED_DOM) ?? []) {
            const name = m[1]!.replace(/\s+/g, '');
            side[name] = (side[name] ?? 0) + 1;
          }
        }
        chunks[file.fileName] = entry;
      }
    },
    closeBundle() {
      const dir = resolve(import.meta.dirname, '.build');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'build-record.json'), JSON.stringify({ modules: [...modules].sort(), chunks }, null, 2));
    },
  };
}
export default defineConfig({
  base: '/',
  plugins: [preact(), extensionPlugin(), buildRecordPlugin()],
  resolve: {
    // Use onnxruntime-web without its embedded 27 MB wasm; wasmPaths points at public/ort.
    conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        offscreen: resolve(import.meta.dirname, 'src/offscreen/offscreen.html'),
        popup: resolve(import.meta.dirname, 'src/ui/popup/popup.html'),
        dashboard: resolve(import.meta.dirname, 'src/ui/dashboard/dashboard.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
