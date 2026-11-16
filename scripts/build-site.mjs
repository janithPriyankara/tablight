// Copies the information pages (About, Privacy, Terms, Support, Licences) into release/site/, ready to publish on
// GitHub Pages or any static host; About becomes the home page. The stores link to these public copies.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public');
const out = join(root, 'release', 'site');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['about.html', 'privacy.html', 'terms.html', 'support.html', 'licenses.html', 'pages.css', 'third-party-notices.txt', 'brand']) {
  cpSync(join(src, f), join(out, f), { recursive: true });
}
cpSync(join(src, 'about.html'), join(out, 'index.html'));
console.log(`site -> ${out} (index.html = About)`);
