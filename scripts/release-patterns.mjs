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
/** The look-up client: the only source file that may name Wikidata's API, and the only modules that may import it. */
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
 * the word in prose (in src/ code only on comment lines); the name list's attribution line in third-party-notices.txt.
 */
export function wikidataMentions(path, text) {
  if (path === LOOKUP_SOURCE) return [];
  ANY_WIKIDATA.lastIndex = 0;
  if (!ANY_WIKIDATA.test(text)) return [];
  const code = path.startsWith('src/') && /\.[cm]?[jt]sx?$/.test(path);
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
/** Project-relative `src/` modules that `text` (the source of `path`) imports, statically, dynamically or re-exported. */
export function importsOf(path, text) {
  const out = new Set();
  const re = /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;
  const dir = path.split('/').slice(0, -1);
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec.startsWith('.')) continue;
    const parts = [...dir];
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    out.add(parts.join('/').replace(/\.(?:[cm]?[jt]sx?)$/, ''));
  }
  return [...out];
}
