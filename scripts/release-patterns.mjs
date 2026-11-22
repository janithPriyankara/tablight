// Patterns shared by the build record (vite.config.ts) and the release gate (verify-release.mjs).
/** DOM-injection and dynamic-code APIs: fatal in app code, reported in library code. */
export const BANNED_CODE =
  /\b(?:innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|srcdoc)\b|\bdocument\s*\.\s*write(?:ln)?\b|\beval\s*\(|\bnew\s+Function\s*\(/g;
/** A stable name for a BANNED_CODE match ("document.write", "eval(", "new Function("). */
export const bannedName = (match) => match.replace(/\s+/g, (s, i) => (match.startsWith('new') && i === 3 ? ' ' : ''));
/** http(s) URL literals in shipped JavaScript. */
export const URL_LITERAL = /https?:\/\/[^\s"'`)<>\\,;]*/g;
export const cleanUrl = (url) => url.replace(/[.]+$/, '');
/** The npm package a bundled module id comes from, or null for the app's own modules. */
export function packageOf(id) {
  const clean = id.split('?')[0];
  if (clean.startsWith('\0')) return 'bundler-runtime';
  const i = clean.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const parts = clean.slice(i + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}
/**
 * Why an allowlisted URL literal (matching `entry` = { re, pkgs } or { re, app }) may not appear in dist chunk
 * `name` (build-record `chunk`), or null when it is confined to the package(s) or the app module(s) the entry names.
 * An `app` entry lists project-relative source files (e.g. 'src/ui/common/lookup.ts'): the URL may come only from
 * those modules, never from a library or any other app module.
 */
export function urlScopeError(entry, name, chunk) {
  if (name === 'background.js') return 'the service worker must not contain URL literals';
  if (!chunk?.urls) return 'chunk not in the build record';
  if (entry.app) {
    const hits = Object.keys(chunk.urls.app).filter((u) => entry.re.test(u));
    const libHits = Object.keys(chunk.urls.lib).filter((u) => entry.re.test(u));
    if (libHits.length) return `found in library code (${libHits.join(', ')}), allowed only in ${entry.app.join(', ')}`;
    if (!hits.length) return 'not attributable to an app module';
    const from = [...new Set(hits.flatMap((u) => chunk.urls.appIn?.[u] ?? ['(unknown module)']))];
    const foreign = from.filter((m) => !entry.app.includes(m));
    if (foreign.length) return `found in ${foreign.join(', ')}, allowed only in ${entry.app.join(', ')}`;
    return null;
  }
  const inApp = Object.keys(chunk.urls.app).filter((u) => entry.re.test(u));
  if (inApp.length) return `found in app code (${inApp.join(', ')})`;
  const fromLib = Object.entries(chunk.urls.lib).filter(([u]) => entry.re.test(u));
  if (!fromLib.length) return 'not attributable to a bundled library module';
  const foreign = [...new Set(fromLib.flatMap(([, p]) => p))].filter((p) => !entry.pkgs.includes(p));
  if (foreign.length) return `comes from ${foreign.join(', ')}, allowed only from ${entry.pkgs.join(', ')}`;
  return null;
}
/** The look-up client: the only source file that may name Wikidata's or Wikipedia's API; see LOOKUP_IMPORTERS for who may import it. */
export const LOOKUP_SOURCE = 'src/ui/common/lookup.ts';
/** Product modules allowed to import LOOKUP_SOURCE (the confirm dialog, Task 7). Tests are not built and are exempt. */
export const LOOKUP_IMPORTERS = ['src/ui/common/LookupDialog.tsx'];
const ANY_WIKIDATA = /wikidata/gi;
/**
 * "Wikidata" as a word in prose: capitalised, not part of a host, path or identifier, and not the edge of a quoted
 * string (so 'https://www.wikidata' + '.org' and ['www', 'wikidata', 'org'] do not count).
 */
const PROSE_WIKIDATA = /(?<![\w./'"`+-])Wikidata(?![\w-]|\.\w|['"`](?!s\b))/g;
/** The one attribution line of the offline name list in third-party-notices.txt (a notice, never fetched). */
const NOTICE_LINE = 'Source: https://www.wikidata.org';
/**
 * Lines of `path` (project-relative) that mention Wikidata where they may not. Allowed: anything in LOOKUP_SOURCE;
 * the word in prose (in src/ code only on comment lines, except in a LOOKUP_IMPORTERS file, whose UI strings may say
 * it: the dialog sentence); the name list's attribution line in third-party-notices.txt. A host form is never prose.
 */
export function wikidataMentions(path, text) {
  if (path === LOOKUP_SOURCE) return [];
  ANY_WIKIDATA.lastIndex = 0;
  if (!ANY_WIKIDATA.test(text)) return [];
  const code = path.startsWith('src/') && /\.[cm]?[jt]sx?$/.test(path) && !LOOKUP_IMPORTERS.includes(path);
  const notice = /(^|\/)third-party-notices\.txt$/.test(path);
  const bad = [];
  text.split('\n').forEach((line, i) => {
    const all = line.match(ANY_WIKIDATA)?.length ?? 0;
    if (!all) return;
    if (notice && line.trim() === NOTICE_LINE) return;
    const prose = line.match(PROSE_WIKIDATA)?.length ?? 0;
    const comment = /^\s*(\/\/|\/?\*)/.test(line);
    if (prose === all && (!code || comment)) return;
    bad.push(`${path}:${i + 1}`);
  });
  return bad;
}
/**
 * The look-up's API endpoints, as the dist check matches them: each must be in the look-up chunk (else the client
 * shipped without it) and in no other file of dist/.
 */
export const LOOKUP_APIS = [
  { name: 'Wikidata', url: 'https://www.wikidata.org/w/api.php', re: /wikidata\.org\/w\/api\.php/i },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/api.php', re: /wikipedia\.org\/w\/api\.php/i },
];
/**
 * Forms of a MediaWiki API endpoint (Wikipedia's or Wikidata's), any case: the host and API path together, even split
 * by quotes, `+` or dots ('https://en.wikipedia' + '.org/w/api.php', ['wikipedia', 'org', 'w', 'api']), or the path
 * alone ('/w/api', 'api.php'), which no other file needs. The word "Wikipedia" and page URLs (wikipedia.org/wiki/…)
 * stay allowed: the name step matches Wikipedia tabs.
 */
const API_FORMS = [/wikipedia\W*org\W*w\W*api/i, /\/w\/api\b/i, /\bapi\.php\b/i];
/** Lines of `path` (project-relative) that name a look-up API endpoint outside LOOKUP_SOURCE, comments included. */
export function lookupApiMentions(path, text) {
  if (path === LOOKUP_SOURCE) return [];
  if (!API_FORMS.some((re) => re.test(text))) return [];
  const bad = [];
  text.split('\n').forEach((line, i) => {
    if (API_FORMS.some((re) => re.test(line))) bad.push(`${path}:${i + 1}`);
  });
  return bad;
}
/**
 * http(s):// literals tolerated in shipped JS. Except the look-up APIs, none is ever fetched: each is a comment, an
 * error-message hint, an XML namespace, or a default that src/offscreen overrides (and the e2e test proves no request
 * is made). Each library entry (`pkgs`) is scoped to the package(s) it comes from: it may appear only in a chunk where
 * the build record attributes it to one of those packages, never in app code and never in background.js. An app
 * entry (`app`) may appear only where the build record attributes it to the source file it names.
 * Anything else fails the gate. (verify-release applies it; the unit tests check the look-up entries.)
 */
export const URL_ALLOWLIST = [
  { re: /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|1998\/Math\/MathML)$/, pkgs: ['preact'], why: 'XML namespace identifiers used by Preact when creating SVG/MathML elements; identifiers, not requests' },
  { re: /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@/, pkgs: ['@huggingface/transformers'], why: 'Transformers.js default wasm location; overridden by env.backends.onnx.wasm.wasmPaths before any pipeline is built (asserted by the e2e bundle check and live network capture)' },
  { re: /^https:\/\/huggingface\.co\/$/, pkgs: ['@huggingface/transformers'], why: 'Transformers.js default remote host string; remote models are disabled (allowRemoteModels=false) and the CSP forbids connections' },
  { re: /^https:\/\/huggingface\.co\/docs\//, pkgs: ['@huggingface/transformers'], why: 'Transformers.js documentation link inside an error/warning message' },
  { re: /^https:\/\/github\.com\/huggingface\/transformers\.js\/issues\//, pkgs: ['@huggingface/transformers'], why: 'Transformers.js bug-report link inside an error message' },
  { re: /^https:\/\/gist\.github\.com\//, pkgs: ['@huggingface/transformers'], why: 'Transformers.js source comment referencing a gist' },
  { re: /^https:\/\/developer\.mozilla\.org\//, pkgs: ['@huggingface/transformers', 'onnxruntime-web'], why: 'Transformers.js documentation link in a comment/message (MDN)' },
  { re: /^https:\/\/web\.dev\//, pkgs: ['onnxruntime-web', '@huggingface/transformers'], why: 'ONNX Runtime/Transformers.js warning text linking to web.dev (cross-origin isolation)' },
  { re: /^https:\/\/rolldown\.rs\//, pkgs: ['bundler-runtime'], why: 'Bundler runtime helper comment/message (Rolldown docs)' },
  // The URLs the app itself fetches, and only after the user clicks "Look it up" and confirms (design Part 2).
  { re: /^https:\/\/www\.wikidata\.org\/w\/api\.php$/, app: [LOOKUP_SOURCE], why: 'Wikidata search API: the opt-in look-up, sent only after the user confirms the dialog' },
  // The look-up's fallback, in the same confirmed click: the same text, only when Wikidata answered with no topical hit.
  { re: /^https:\/\/en\.wikipedia\.org\/w\/api\.php$/, app: [LOOKUP_SOURCE], why: 'Wikipedia search API: the opt-in look-up\'s fallback when Wikidata finds nothing, same confirmed text and click' },
  // A link the look-up dialog shows (opened in a new tab only if the user clicks it); never fetched by the app.
  { re: /^https:\/\/foundation\.wikimedia\.org\/wiki\/Policy:Privacy_policy$/, app: ['src/ui/common/LookupDialog.tsx'], why: 'Wikimedia privacy-policy link in the look-up dialog; a link, not a request' },
];
/** The project-relative module (no extension, no query) an import specifier in `path` names; null for a package. */
function resolveSpec(path, spec) {
  if (!spec.startsWith('.')) return null;
  const parts = path.split('/').slice(0, -1);
  for (const seg of spec.split(/[?#]/)[0].split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/').replace(/\.(?:[cm]?[jt]sx?)$/, '');
}
/** Project-relative `src/` modules that `text` (the source of `path`) imports, statically, dynamically or re-exported. */
export function importsOf(path, text) {
  const out = new Set();
  const re = /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const r = resolveSpec(path, m[1] ?? m[2] ?? m[3]);
    if (r) out.add(r);
  }
  return [...out];
}
/**
 * Ways `text` (the source of `path`) passes the look-up client on: `export * from` / `export { … } from` it, or
 * exporting a binding imported from it (`export { lookUp }`, `export default lookUp`, `export const f = lookUp`).
 * An allowed importer may call lookUp; it may not hand it to other modules.
 */
export function lookupReexports(path, text) {
  const target = LOOKUP_SOURCE.replace(/\.ts$/, '');
  const bad = [];
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) {
    if (resolveSpec(path, m[1]) === target) bad.push(m[0].replace(/\s+/g, ' '));
  }
  const names = new Set();
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([^'"`;]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (resolveSpec(path, m[2]) !== target) continue;
    const clause = m[1];
    for (const b of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const part of b[1].split(',')) {
        const local = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
        if (local) names.add(local);
      }
    }
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) names.add(ns[1]);
    const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
    if (def) names.add(def[1]);
  }
  for (const n of names) {
    const id = n.replace(/\$/g, '\\$');
    const forms = [
      new RegExp(`\\bexport\\s+(?:type\\s+)?\\{[^}]*(?<![\\w$])${id}(?![\\w$])[^}]*\\}(?!\\s*from)`),
      new RegExp(`\\bexport\\s+default\\s+${id}(?![\\w$])`),
      new RegExp(`\\bexport\\s+(?:const|let|var)\\s+[\\w$]+\\s*(?::[^=]+)?=\\s*${id}(?![\\w$(])`),
    ];
    for (const re of forms) {
      const m = re.exec(text);
      if (m) bad.push(m[0].replace(/\s+/g, ' '));
    }
  }
  return bad;
}
