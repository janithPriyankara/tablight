import { basename, resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
import { manifest } from './manifest.config.ts';
// Manifest paths are root-relative, so every HTML entry is emitted at the dist root.
// Asset URLs use base '/', which resolves against the extension root, so moving is safe.
function extensionPlugin(): Plugin {
  return {
    name: 'tab-organizer-extension',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.html')) {
          file.fileName = basename(file.fileName);
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
export default defineConfig({
  base: '/',
  plugins: [preact(), extensionPlugin()],
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
