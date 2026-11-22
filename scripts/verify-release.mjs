// Release gate. Run after `vite build` (npm run build does this automatically) and before packaging.
// Fails (exit 1) on: manifest permission/CSP/version drift, URL literals in shipped JS that are not
// allowlisted or not confined to the library they come from, model/ORT hash mismatch, DOM-injection or
// dynamic-code APIs in app code, a Node-only package in the bundle, a non-allowlisted license among
// bundled packages, a names/names.txt that is not the pinned file or is over 1,500,000 bytes, or a package size of 55 MB (55,000,000 bytes) or more (unpacked dist, and the zip
// when `--zip <file>` is given).
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_FILES, MODEL_ID, ORT_FILES_SHA256 } from './model-manifest.mjs';
import {
  BANNED_CODE, LOOKUP_APIS, LOOKUP_IMPORTERS, LOOKUP_SOURCE, URL_ALLOWLIST, URL_LITERAL, cleanUrl, importsOf, lookupApiMentions,
  lookupReexports, packageOf, urlScopeError, wikidataMentions,
} from './release-patterns.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
/**
 * 55 MB in decimal megabytes (10^6 bytes). Raised from 45 MB for bge-small-en-v1.5 (33 MB, replacing the 23 MB
 * MiniLM) plus the head's neighbour data (~1 MB); see docs §12.
 */
export const SIZE_LIMIT = 55_000_000;
const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;
const CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://www.wikidata.org https://en.wikipedia.org; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** SHA-256 of public/names/names.txt, the offline Wikidata name list (scripts/names/build.mjs prints it). */
export const NAMES_SHA256 = 'ab527a25f6104247c2d0e3d2ec65243a3a4712867e516f0ff844c9f622f37084';
/** names.txt cap in bytes (design Part 1); tests/unit/names-file.test.ts checks the same. */
export const NAMES_LIMIT = 1_500_000;
const PERMISSIONS = ['alarms', 'favicon', 'offscreen', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage'];
/** Keyboard commands and their suggested keys (Chrome allows at most 4 suggested keys; these are all 4). */
const COMMANDS = {
  'open-dashboard': 'Alt+Shift+T', 'open-side-panel': 'Alt+Shift+S', 'prioritize-tab': 'Alt+P', 'unprioritize-tab': 'Alt+Shift+P',
};
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const LICENSE_ALLOWLIST = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];
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
const commands = Object.fromEntries(Object.entries(manifest.commands ?? {}).map(([k, v]) => [k, v?.suggested_key?.default ?? null]));
if (JSON.stringify(commands, Object.keys(commands).sort()) !== JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort())) {
  fail(`unexpected commands: ${JSON.stringify(commands)}`);
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
  console.log(`  - ${entry.why} (from ${(entry.pkgs ?? entry.app).join(', ')})`);
  for (const u of urls) console.log(`      ${u}`);
}
if (usedEntries.size === 0) console.log('  (none found)');
// ── the opt-in look-up: who may call it, and where Wikidata may be named ────
// 1. Importers. The build record lists every module whose import chain reaches LOOKUP_SOURCE (from the module graph,
//    so a tree-shaken importer still counts). Only LOOKUP_IMPORTERS may import it, nothing in the service worker or the
//    offscreen document may reach it, and its code may not land in background.js or the offscreen chunk.
// 2. Mentions. "wikidata" (any case) may appear only in LOOKUP_SOURCE, as a prose word, or as the name list's notice
//    line; a MediaWiki API endpoint (lookupApiMentions: Wikipedia's or Wikidata's, split or not) only in LOOKUP_SOURCE. Checked over every file of src/ and public/ (catches split strings like 'www.wikidata' + '.org' and
//    copies of the URL in JSON, HTML or text assets) and every file of dist/, JS or not (manifest.json may hold it only
//    in the pinned CSP; a JS chunk only when it carries LOOKUP_SOURCE, whose other modules the source scan covers).
// 3. Endpoints. When the client ships, the chunk carrying it must hold both API URLs (LOOKUP_APIS): a missing one means
//    the build changed the client in a way these checks no longer see.
console.log('\nLook-up (Wikidata, Wikipedia fallback) checks:');
{
  const before = errors.length;
  const lk = record?.lookup;
  const target = LOOKUP_SOURCE.replace(/\.ts$/, '');
  if (record && (lk === undefined || lk === null || !Array.isArray(lk.ids))) fail('build record has no look-up entry; rebuild');
  // The record's path matching must work, or every check below would pass by finding nothing.
  if (record && !record.chunks?.['background.js']?.appModules?.includes('src/background/index.ts')) {
    fail('build record path matching is broken: background.js does not list src/background/index.ts; rebuild or fix vite.config.ts');
  }
  const lkIds = lk?.ids ?? [];
  if (lkIds.some((id) => id.split(/[?#]/)[0] !== LOOKUP_SOURCE)) fail(`build record look-up ids do not resolve to ${LOOKUP_SOURCE}: ${lkIds.join(', ')}`);
  if (lk) {
    const foreign = lk.importers.filter((m) => !LOOKUP_IMPORTERS.includes(m));
    if (foreign.length) fail(`${LOOKUP_SOURCE} is imported by ${foreign.join(', ')}; allowed only: ${LOOKUP_IMPORTERS.join(', ')}`);
    const worker = lk.ancestors.filter((m) => /^src\/(background|offscreen)\//.test(m));
    if (worker.length) fail(`${LOOKUP_SOURCE} is reachable from ${worker.join(', ')}`);
  }
  let inChunks = false;
  for (const [name, chunk] of Object.entries(record?.chunks ?? {})) {
    if (!chunk.appModules) fail(`build record chunk ${name} has no module list; rebuild`);
    else if (chunk.appModules.includes(LOOKUP_SOURCE)) {
      inChunks = true;
      if (name === 'background.js' || /offscreen/.test(name)) fail(`${LOOKUP_SOURCE} is bundled into ${name}`);
    }
  }
  // Sources: mentions, imports outside the allowlist (even ones the bundler dropped) and re-exports by allowed importers.
  let srcImporters = 0;
  const sources = [...(await walk(join(root, 'src'))), ...(await walk(join(root, 'public')))];
  for (const f of sources) {
    const path = relative(root, f).split('\\').join('/');
    const text = (await readFile(f)).toString('latin1');
    for (const where of wikidataMentions(path, text)) fail(`Wikidata named outside ${LOOKUP_SOURCE}: ${where}`);
    for (const where of lookupApiMentions(path, text)) fail(`look-up API endpoint named outside ${LOOKUP_SOURCE}: ${where}`);
    if (!/\.[cm]?[jt]sx?$/.test(path) || path === LOOKUP_SOURCE || !importsOf(path, text).includes(target)) continue;
    srcImporters++;
    if (!LOOKUP_IMPORTERS.includes(path)) fail(`${path} imports ${LOOKUP_SOURCE}; allowed only: ${LOOKUP_IMPORTERS.join(', ')}`);
    for (const r of lookupReexports(path, text)) fail(`${path} re-exports from ${LOOKUP_SOURCE}: ${r}`);
  }
  // Dist: an API URL anywhere means the client shipped; outside its chunk, it is a leak.
  const pinnedCsp = JSON.stringify(CSP).slice(1, -1);
  let urlInDist = false;
  const apisInLookupChunks = new Set();
  for (const f of files) {
    const name = relative(dist, f).split('\\').join('/');
    let text = (await readFile(f)).toString('latin1');
    if (name === 'manifest.json') text = text.split(pinnedCsp).join('');
    if (LOOKUP_APIS.some((a) => a.re.test(text))) urlInDist = true;
    if (record?.chunks?.[name]?.appModules?.includes(LOOKUP_SOURCE)) {
      for (const a of LOOKUP_APIS) if (text.includes(a.url)) apisInLookupChunks.add(a.name);
      continue;
    }
    for (const where of wikidataMentions(`dist/${name}`, text)) fail(`Wikidata named in dist outside the look-up chunk: ${where}`);
    for (const where of lookupApiMentions(`dist/${name}`, text)) fail(`look-up API endpoint in dist outside the look-up chunk: ${where}`);
  }
  if (inChunks) {
    for (const a of LOOKUP_APIS) {
      if (!apisInLookupChunks.has(a.name)) fail(`the look-up chunk does not contain the ${a.name} API URL ${a.url}: the client changed shape; update the gate`);
    }
  }
  // Zero client ids in the record is only believable when nothing ships it and nothing in src imports it.
  if (record && lkIds.length === 0 && (inChunks || urlInDist || srcImporters > 0)) {
    fail(`build record lists no ${LOOKUP_SOURCE} module, yet ${inChunks ? 'a chunk carries it' : urlInDist ? 'dist holds its URL' : 'src imports it'}: the importer check cannot run`);
  }
  console.log(errors.length === before
    ? `  OK: ids ${lkIds.join(', ') || '(none: nothing imports it)'}; importers ${lk?.importers?.join(', ') || '(none)'}; allowed: ${LOOKUP_IMPORTERS.join(', ')}`
    : '  FAILED (see below)');
}
// ── hashes: model files and ONNX Runtime files ──────────────────────────────
// Exactly one model ships (a leftover directory of a previous model would only add megabytes).
try {
  const dirs = async (d) => (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const shipped = [];
  for (const org of await dirs(join(dist, 'models'))) for (const m of await dirs(join(dist, 'models', org))) shipped.push(`${org}/${m}`);
  if (shipped.length !== 1 || shipped[0] !== MODEL_ID) fail(`dist/models must hold only ${MODEL_ID}, found: ${shipped.join(', ') || 'nothing'}`);
} catch {
  fail('dist/models is missing');
}
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
    // Pinned, so a tampered or silently changed onnxruntime-web package fails the release too.
    if (actual !== ORT_FILES_SHA256[f]) fail(`ORT hash mismatch (dist/ort/${f} is not the pinned file in model-manifest.mjs)`);
  } catch {
    fail(`ORT file missing (dist/ort/${f} or node_modules/onnxruntime-web/dist/${f}); run "npm ci && npm run prepare:assets"`);
  }
}
// ── name list: pinned like the model, and capped ────────────────────────────
try {
  const names = await readFile(join(dist, 'names', 'names.txt'));
  const actual = sha256(names);
  console.log(`\nName list: dist/names/names.txt ${names.length} bytes (limit ${NAMES_LIMIT}), sha256 ${actual}`);
  if (actual !== NAMES_SHA256) fail('name list hash mismatch: dist/names/names.txt is not the file pinned in NAMES_SHA256');
  if (names.length > NAMES_LIMIT) fail(`name list is ${names.length} bytes (limit ${NAMES_LIMIT})`);
} catch {
  fail('name list missing from dist (dist/names/names.txt); run "npm run names:build" and rebuild');
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
