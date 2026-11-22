// Writes public/third-party-notices.txt: every third-party package that ships in the extension (the production
// dependencies and what they pull in, minus Transformers.js's Node-only runtime) with its licence text, plus the
// bundled AI model and the Wikidata name list. Run: npm run notices (also run by npm run build).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ID } from './model-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
/** Node-only runtime of Transformers.js: never imported by the browser build, not in dist. */
const NODE_ONLY = new Set(['sharp', 'onnxruntime-node']);

const pkgJson = (name) => {
  const p = join(nm, name, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const seen = new Map();
const visit = (name) => {
  if (seen.has(name) || NODE_ONLY.has(name)) return;
  const pj = pkgJson(name);
  if (!pj) return;
  seen.set(name, pj);
  for (const dep of Object.keys(pj.dependencies ?? {})) visit(dep);
};
for (const dep of Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {})) visit(dep);

const licenceOf = (pj) => pj.license ?? (Array.isArray(pj.licenses) ? pj.licenses.map((l) => l.type ?? l).join(' OR ') : 'see package');
const repoOf = (pj) => (typeof pj.repository === 'string' ? pj.repository : pj.repository?.url ?? pj.homepage ?? '');
const licenceTexts = (name) => {
  const dir = join(nm, name);
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').trim());
};

const RULE = '='.repeat(78);
const out = [
  'Tablight - third-party software notices',
  '',
  'Tablight includes the open-source software, the AI model and the data listed below. Each is used under its own',
  'licence, reproduced here. Tablight itself is (c) The Moonstone (Pvt) Ltd.',
  '',
];
out.push(RULE, `${MODEL_ID} (AI model)`, 'Licence: MIT',
  'Base model: BAAI/bge-small-en-v1.5, https://huggingface.co/BAAI/bge-small-en-v1.5',
  'Fine-tuned by Tablight on its own synthetic labelled tabs and converted to ONNX (int8); the base model\'s',
  'licence below applies.', RULE, '',
  'MIT License', '', 'Copyright (c) Beijing Academy of Artificial Intelligence (BAAI)', '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated',
  'documentation files (the "Software"), to deal in the Software without restriction, including without limitation',
  'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and',
  'to permit persons to whom the Software is furnished to do so, subject to the following conditions:', '',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of',
  'the Software.', '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO',
  'THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF',
  'CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS',
  'IN THE SOFTWARE.', '');
out.push(RULE, 'Wikidata (name list, names/names.txt)', 'Licence: CC0 1.0 Universal (public domain dedication)',
  'Source: https://www.wikidata.org', RULE, '',
  'The offline name list (names of well-known films, series, games, bands, albums, books, cars, sports clubs,',
  'hardware and their makers) was built from Wikidata. Wikidata\'s structured data is available under the',
  'Creative Commons CC0 1.0 Universal Public Domain Dedication: https://creativecommons.org/publicdomain/zero/1.0/', '');
for (const [name, pj] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(RULE, `${name} ${pj.version}`, `Licence: ${licenceOf(pj)}`);
  const repo = repoOf(pj);
  if (repo) out.push(`Source: ${repo.replace(/^git\+/, '')}`);
  out.push(RULE, '');
  const texts = licenceTexts(name);
  out.push(...(texts.length ? texts.flatMap((t) => [t, '']) : [`(No licence file in the package; licensed under ${licenceOf(pj)}.)`, '']));
}
writeFileSync(join(root, 'public', 'third-party-notices.txt'), `${out.join('\n')}\n`);
console.log(`third-party notices: ${seen.size} packages + the model -> public/third-party-notices.txt`);
