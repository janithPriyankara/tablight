// Dev-only server for the mocked UI preview (npm run preview:ui). Never part of `npm run build` / dist.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
const root = import.meta.dirname;
const REAL_EMBEDDER = resolve(root, 'src/background/embedder.ts');
const FAKE_EMBEDDER = resolve(root, 'src/ui/mock/fake-embedder.ts');
/** Swaps the on-device model (offscreen document) for the precomputed-vector embedder. */
function fakeEmbedder(): Plugin {
  return {
    name: 'preview-fake-embedder',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !/embedder/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r?.id === REAL_EMBEDDER ? FAKE_EMBEDDER : null;
    },
  };
}
/** Serves a small generic placeholder icon for /_favicon/ (tinted per site, no network). */
function placeholderFavicons(): Plugin {
  return {
    name: 'preview-favicons',
    configureServer(server) {
      server.middlewares.use('/_favicon', (req, res) => {
        const page = new URL(req.url ?? '/', 'http://x').searchParams.get('pageUrl') ?? '';
        const hue = createHash('md5').update(new URL(page, 'http://x').hostname).digest()[0]! * (360 / 256);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${hue.toFixed(0)} 55% 52%)"/>` +
            '<circle cx="16" cy="16" r="8" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2"/>' +
            '<path d="M8 16h16M16 8c4 4 4 12 0 16M16 8c-4 4-4 12 0 16" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.5"/></svg>',
        );
      });
    },
  };
}
export default defineConfig({
  root: resolve(root, 'src/ui/mock/preview'),
  publicDir: false,
  base: '/',
  plugins: [fakeEmbedder(), preact(), placeholderFavicons()],
  server: { port: 5174, strictPort: true, fs: { allow: [root] } },
});
