// Release gate. Run after `vite build` (npm run build does this automatically) and before packaging.
// Fails (exit 1) on: manifest permission/CSP/version drift, URL literals in shipped JS that are not
// allowlisted or not confined to the library they come from, model/ORT hash mismatch, DOM-injection or
// dynamic-code APIs in app code, a Node-only package in the bundle, a non-allowlisted license among
// bundled packages, or a package size of 45 MB (45,000,000 bytes) or more (unpacked dist, and the zip
// when `--zip <file>` is given).
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_FILES, MODEL_ID } from './model-manifest.mjs';
import { BANNED_CODE, URL_LITERAL, cleanUrl, packageOf, urlScopeError } from './release-patterns.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
/** 45 MB in decimal megabytes (10^6 bytes), the unit of the 45 MB package constraint. */
export const SIZE_LIMIT = 45_000_000;
const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;
const CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS = ['alarms', 'favicon', 'offscreen', 'storage', 'tabs', 'unlimitedStorage'];
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const LICENSE_ALLOWLIST = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];
/**
 * http(s):// literals tolerated in shipped JS. None is ever fetched: each is a comment, an error-message
 * hint, an XML namespace, or a default that src/offscreen overrides (and the e2e test proves no request
 * is made). Each entry is scoped to the package(s) it comes from: it may appear only in a chunk where the
 * build record attributes it to one of those packages, never in app code and never in background.js.
 * Anything else fails the gate.
 */
const URL_ALLOWLIST = [
  { re: /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|1998\/Math\/MathML)$/, pkgs: ['preact'], why: 'XML namespace identifiers used by Preact when creating SVG/MathML elements; identifiers, not requests' },
  { re: /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@/, pkgs: ['@huggingface/transformers'], why: 'Transformers.js default wasm location; overridden by env.backends.onnx.wasm.wasmPaths before any pipeline is built (asserted by the e2e bundle check and live network capture)' },
  { re: /^https:\/\/huggingface\.co\/$/, pkgs: ['@huggingface/transformers'], why: 'Transformers.js default remote host string; remote models are disabled (allowRemoteModels=false) and the CSP forbids connections' },
  { re: /^https:\/\/huggingface\.co\/docs\//, pkgs: ['@huggingface/transformers'], why: 'Transformers.js documentation link inside an error/warning message' },
  { re: /^https:\/\/github\.com\/huggingface\/transformers\.js\/issues\//, pkgs: ['@huggingface/transformers'], why: 'Transformers.js bug-report link inside an error message' },
  { re: /^https:\/\/gist\.github\.com\//, pkgs: ['@huggingface/transformers'], why: 'Transformers.js source comment referencing a gist' },
  { re: /^https:\/\/developer\.mozilla\.org\//, pkgs: ['@huggingface/transformers', 'onnxruntime-web'], why: 'Transformers.js documentation link in a comment/message (MDN)' },
  { re: /^https:\/\/web\.dev\//, pkgs: ['onnxruntime-web', '@huggingface/transformers'], why: 'ONNX Runtime/Transformers.js warning text linking to web.dev (cross-origin isolation)' },
  { re: /^https:\/\/rolldown\.rs\//, pkgs: ['bundler-runtime'], why: 'Bundler runtime helper comment/message (Rolldown docs)' },
];
const errors = [];
const fail = (m) => errors.push(m);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
let files;
try {
  files = await walk(dist);
} catch {
  console.error('FAIL dist/ is missing. Run "npm run build" first.');
  process.exit(1);
}
// ── manifest ────────────────────────────────────────────────────────────────
const manifest = await readJson(join(dist, 'manifest.json'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (manifest.minimum_chrome_version !== '120') fail('minimum_chrome_version must be "120"');
const perms = JSON.stringify([...(manifest.permissions ?? [])].sort());
if (perms !== JSON.stringify(PERMISSIONS)) fail(`unexpected permissions: ${perms}`);
if (JSON.stringify(manifest.optional_permissions) !== '["tabGroups"]') fail('unexpected optional_permissions');
for (const k of ['host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable']) {
  if (k in manifest) fail(`${k} must not be present`);
}
if ((manifest.web_accessible_resources ?? []).length > 0) fail('web_accessible_resources must be empty');
if (manifest.incognito !== 'not_allowed') fail('incognito must be not_allowed');
if (manifest.content_security_policy?.extension_pages !== CSP) fail('CSP mismatch');
const pkgVersion = (await readJson(join(root, 'package.json'))).version;
if (manifest.version !== pkgVersion) fail(`manifest version ${manifest.version} differs from package.json ${pkgVersion}`);
// ── URL literals in shipped JS ──────────────────────────────────────────────
const jsFiles = files.filter((f) => /\.(m?js)$/.test(f));
let record;
try {
  record = await readJson(join(root, '.build', 'build-record.json'));
} catch {
  fail('.build/build-record.json is missing; run "npm run build" (the vite build writes it)');
}
const urlHits = new Map(); // url -> Set(files)
for (const f of jsFiles) {
  const text = await readFile(f, 'utf8');
  for (const m of text.matchAll(URL_LITERAL)) {
    const url = cleanUrl(m[0]);
    if (!urlHits.has(url)) urlHits.set(url, new Set());
    urlHits.get(url).add(relative(dist, f));
  }
}
console.log('\nURL literals in dist JS (allowlist, each entry justified and scoped to its package):');
const usedEntries = new Map();
for (const [url, where] of [...urlHits].sort()) {
  const entry = URL_ALLOWLIST.find((e) => e.re.test(url));
  if (!entry) {
    fail(`URL literal not in the allowlist: ${url} (in ${[...where].join(', ')})`);
    continue;
  }
  for (const name of where) {
    const err = urlScopeError(entry, name, record?.chunks?.[name]);
    if (err) fail(`URL literal ${url} in ${name}: ${err}`);
  }
  if (!usedEntries.has(entry)) usedEntries.set(entry, []);
  usedEntries.get(entry).push(`${url}  [${[...where].join(', ')}]`);
}
for (const [entry, urls] of usedEntries) {
  console.log(`  - ${entry.why} (from ${entry.pkgs.join(', ')})`);
  for (const u of urls) console.log(`      ${u}`);
}
if (usedEntries.size === 0) console.log('  (none found)');
// ── hashes: model files and ONNX Runtime files ──────────────────────────────
for (const [file, expected] of Object.entries(MODEL_FILES)) {
  try {
    const actual = sha256(await readFile(join(dist, 'models', ...MODEL_ID.split('/'), file)));
    if (actual !== expected) fail(`model hash mismatch: ${file}`);
  } catch {
    fail(`model file missing from dist: ${file}`);
  }
}
for (const f of ORT_FILES) {
  try {
    const expected = sha256(await readFile(join(root, 'node_modules', 'onnxruntime-web', 'dist', f)));
    const actual = sha256(await readFile(join(dist, 'ort', f)));
    if (actual !== expected) fail(`ORT hash mismatch (dist/ort/${f} differs from node_modules/onnxruntime-web)`);
  } catch {
    fail(`ORT file missing (dist/ort/${f} or node_modules/onnxruntime-web/dist/${f}); run "npm ci && npm run prepare:assets"`);
  }
}
// ── build record: DOM-injection APIs and bundled-package licenses ───────────
if (record) {
  console.log(
    '\nDOM-injection and dynamic-code APIs (innerHTML, outerHTML, insertAdjacentHTML, setHTMLUnsafe,\n' +
      '  createContextualFragment, srcdoc, document.write, eval(, new Function(): app code fails, libraries are reported:',
  );
  let any = false;
  for (const f of jsFiles) {
    const name = relative(dist, f);
    const text = await readFile(f, 'utf8');
    const total = (text.match(BANNED_CODE) ?? []).length;
    if (total === 0) continue;
    any = true;
    const chunk = record.chunks[name];
    const app = chunk ? Object.entries(chunk.app) : null;
    const recorded = chunk ? [...Object.values(chunk.app), ...Object.values(chunk.lib)].reduce((a, b) => a + b, 0) : 0;
    if (chunk && total > recorded) {
      fail(`DOM-injection API in ${name} not accounted for by the build record (${total} found, ${recorded} recorded): file edited after the build?`);
    } else if (!chunk || app.length > 0) {
      fail(`DOM-injection API in app code (${name}): ${chunk ? app.map(([k, v]) => `${k} x${v}`).join(', ') : 'chunk not in build record'}`);
    } else {
      console.log(`  lib only (reported, not failed): ${name}: ${Object.entries(chunk.lib).map(([k, v]) => `${k} x${v}`).join(', ')}`);
    }
  }
  if (!any) console.log('  none');
  // Licenses of exactly the packages that ship in dist (from the bundler's module list).
  const pkgOf = (id) => {
    const name = packageOf(id);
    if (!name || name === 'bundler-runtime') return null;
    const clean = id.split('?')[0];
    const i = clean.lastIndexOf('node_modules/');
    return { name, dir: clean.slice(0, i + 'node_modules/'.length) + name };
  };
  const bundled = new Map();
  for (const id of record.modules) {
    const p = pkgOf(id);
    if (p) bundled.set(p.name, p.dir);
  }
  const licenseOf = (pkg) => {
    const l = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((x) => x.type ?? x).join(' OR ') : pkg.licenses?.type);
    return typeof l === 'object' && l !== null ? l.type : l;
  };
  // "(MIT OR Apache-2.0)" is acceptable when every alternative... at least one is allowed; AND needs all.
  const allowed = (expr) => {
    if (typeof expr !== 'string') return false;
    const e = expr.replace(/[()]/g, ' ');
    return e.split(/\s+OR\s+/).some((alt) => alt.split(/\s+AND\s+/).every((l) => LICENSE_ALLOWLIST.includes(l.trim())));
  };
  // Prebuilt dists (transformers.web.js, onnxruntime-web) inline their own dependencies, which the module
  // list cannot see, so the declared dependencies of every bundled package are checked as well. Only the
  // Node-only runtime (sharp and onnxruntime-node, with everything they alone pull in) is excluded.
  const NODE_ONLY_ROOTS = new Set(['sharp', 'onnxruntime-node']);
  const closure = (roots, stop) => {
    const seen = new Set();
    const visit = async (name) => {
      if (seen.has(name) || stop.has(name)) return;
      seen.add(name);
      try {
        const p = await readJson(join(root, 'node_modules', name, 'package.json'));
        for (const d of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) await visit(d);
      } catch {
        /* optional/platform-specific package that is not installed here */
      }
    };
    return Promise.all([...roots].map(visit)).then(() => seen);
  };
  const checked = await closure(bundled.keys(), NODE_ONLY_ROOTS);
  const nodeOnly = await closure(NODE_ONLY_ROOTS, new Set());
  const excluded = [...nodeOnly].filter((n) => !checked.has(n)).sort();
  // The exclusion only holds while none of those packages is actually bundled.
  const leaked = [...bundled.keys()].filter((n) => NODE_ONLY_ROOTS.has(n) || excluded.includes(n));
  if (leaked.length) fail(`Node-only package(s) bundled into dist: ${leaked.join(', ')}`);
  console.log(
    `\nLicenses of the ${checked.size} package(s) shipped in dist or declared by a shipped package ` +
      `(${bundled.size} bundled directly; allowed: ${LICENSE_ALLOWLIST.join('; ')}):`,
  );
  for (const name of [...checked].sort()) {
    let pkg;
    try {
      pkg = await readJson(join(root, 'node_modules', name, 'package.json'));
    } catch {
      if (bundled.has(name)) fail(`cannot read package.json of bundled package ${name}`);
      else console.log(`  ${name}: (not installed; optional)`);
      continue;
    }
    const lic = licenseOf(pkg);
    console.log(`  ${name}@${pkg.version}: ${lic}${bundled.has(name) ? '' : '  [inlined/declared dependency]'}`);
    if (!allowed(lic)) fail(`license not allowed: ${name}@${pkg.version} (${lic})`);
  }
  console.log(
    `Excluded from the license check (${excluded.length} packages): ${NODE_ONLY_ROOTS.size} Node-only roots (${[...NODE_ONLY_ROOTS].join(', ')}) and what only they pull in.\n` +
      `  ${excluded.join(', ')}\n` +
      "  Justification: Transformers.js's Node runtime (sharp, @img/*, onnxruntime-node) is never imported by the browser build\n" +
      '  (none of it appears in the bundler module list) and is not in dist. Dev tooling is not shipped either.',
  );
}
// ── size ────────────────────────────────────────────────────────────────────
let unpacked = 0;
for (const f of files) unpacked += (await stat(f)).size;
console.log(`\nUnpacked dist: ${mb(unpacked)} (limit ${mb(SIZE_LIMIT)})`);
if (unpacked >= SIZE_LIMIT) fail(`unpacked dist is ${mb(unpacked)} (limit ${mb(SIZE_LIMIT)})`);
const zipArg = process.argv.indexOf('--zip');
if (zipArg > 0) {
  const zipSize = (await stat(process.argv[zipArg + 1])).size;
  console.log(`Zip: ${mb(zipSize)} (limit ${mb(SIZE_LIMIT)})`);
  if (zipSize >= SIZE_LIMIT) fail(`zip is ${mb(zipSize)} (limit ${mb(SIZE_LIMIT)})`);
}
if (errors.length) {
  console.error('\n' + errors.map((e) => `FAIL ${e}`).join('\n'));
  process.exit(1);
}
console.log('\nverify-release: OK');
