// Who may call the opt-in look-up, and where Wikidata may be named: checked on the sources, before any build
// (scripts/verify-release.mjs checks the same on the build record and on every file of dist/).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOOKUP_APIS, LOOKUP_IMPORTERS, LOOKUP_SOURCE, importsOf, lookupApiMentions, lookupReexports, wikidataMentions,
} from '../../scripts/release-patterns.mjs';
import { LOOKUP_DIALOG_SENTENCE } from '../../src/ui/common/lookup';

const root = join(import.meta.dirname, '..', '..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
const rel = (f: string) => relative(root, f).split('\\').join('/');
const LOOKUP_MODULE = LOOKUP_SOURCE.replace(/\.ts$/, '');

describe('look-up gate', () => {
  it('only the allowed modules import the look-up client', () => {
    const importers = walk(join(root, 'src'))
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
      .map((f) => [rel(f), readFileSync(f, 'utf8')] as const)
      .filter(([p, text]) => p !== LOOKUP_SOURCE && importsOf(p, text).includes(LOOKUP_MODULE))
      .map(([p]) => p);
    expect(importers.filter((p) => !LOOKUP_IMPORTERS.includes(p))).toEqual([]);
    expect(LOOKUP_IMPORTERS).toEqual(['src/ui/common/LookupDialog.tsx']);
    // An allowed importer may call the client but not pass it on.
    for (const p of importers) expect(lookupReexports(p, readFileSync(join(root, p), 'utf8')), p).toEqual([]);
  });
  it('flags every way an importer could re-export the client', () => {
    const p = 'src/ui/common/LookupDialog.tsx';
    const imp = "import { lookUp, LOOKUP_DIALOG_SENTENCE as S } from './lookup';\n";
    expect(lookupReexports(p, "export * from './lookup';")).toHaveLength(1);
    expect(lookupReexports(p, "export * as L from './lookup.ts';")).toHaveLength(1);
    expect(lookupReexports(p, "export { lookUp } from './lookup';")).toHaveLength(1);
    expect(lookupReexports(p, "export type { LookupHit } from './lookup';")).toHaveLength(1);
    expect(lookupReexports(p, imp + 'export { lookUp };')).toHaveLength(1);
    expect(lookupReexports(p, imp + 'export { x, lookUp as find };')).toHaveLength(1);
    expect(lookupReexports(p, imp + 'export { S };')).toHaveLength(1);
    expect(lookupReexports(p, imp + 'export default lookUp;')).toHaveLength(1);
    expect(lookupReexports(p, imp + 'export const find = lookUp;')).toHaveLength(1);
    expect(lookupReexports(p, "import * as L from './lookup';\nexport const api = L;")).toHaveLength(1);
    expect(lookupReexports(p, "import L from './lookup';\nexport { L };")).toHaveLength(1);
    // Calling it, or exporting the dialog itself, is fine.
    expect(lookupReexports(p, imp + 'export function LookupDialog() { void lookUp(t); return <p>{S}</p>; }')).toEqual([]);
    expect(lookupReexports(p, imp + 'export const r = lookUp(t);\nexport { LookupDialog };')).toEqual([]);
    expect(lookupReexports(p, "export * from './lookup-text';")).toEqual([]);
  });
  it('accepts the dialog sentence in the allowed importer, never a host there', () => {
    expect(LOOKUP_DIALOG_SENTENCE).toBe('Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:');
    const dialog = 'src/ui/common/LookupDialog.tsx';
    const probe = [
      'export function LookupDialog() {',
      '  return (',
      '    <div>',
      '      <p>Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:</p>',
      `      <p>{'Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:'}</p>`,
      `      <p title="Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:" />`,
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    expect(wikidataMentions(dialog, probe)).toEqual([]);
    expect(wikidataMentions(dialog, "const u = 'https://www.wikidata.org/w/api.php';")).toEqual([`${dialog}:1`]);
    expect(wikidataMentions(dialog, "<a href=\"https://wikidata.org\">Wikidata</a>")).toEqual([`${dialog}:1`]);
    expect(wikidataMentions(dialog, "fetch('https://www.' + 'wikidata' + '.org')")).toEqual([`${dialog}:1`]);
    // Anywhere else the sentence in code is still refused (only comments may say the word).
    expect(wikidataMentions('src/ui/dashboard/X.tsx', probe)).toHaveLength(3);
  });
  it('src/ and public/ name a look-up API endpoint only in the client', () => {
    const bad = [...walk(join(root, 'src')), ...walk(join(root, 'public'))]
      .flatMap((f) => lookupApiMentions(rel(f), readFileSync(f).toString('latin1')));
    expect(bad).toEqual([]);
    // The client holds both endpoints, exactly as the dist check looks for them.
    const client = readFileSync(join(root, LOOKUP_SOURCE), 'utf8');
    expect(LOOKUP_APIS.map((a) => a.url)).toEqual(['https://www.wikidata.org/w/api.php', 'https://en.wikipedia.org/w/api.php']);
    for (const a of LOOKUP_APIS) {
      expect(client).toContain(a.url);
      expect(a.re.test(a.url)).toBe(true);
    }
  });
  it('flags the Wikipedia API endpoint outside the client, split or in any case, but not the word or page URLs', () => {
    const p = 'src/ui/dashboard/X.tsx';
    expect(lookupApiMentions(p, "fetch('https://en.wikipedia.org/w/api.php?action=query')")).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, "const u = 'HTTPS://EN.WIKIPEDIA.ORG/W/API.PHP';")).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, "fetch('https://en.wikipedia' + '.org/w/api.php')")).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, "fetch('https://en.wikipedia.org' + '/w/' + 'api.php')")).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, "const h = ['en', 'wikipedia', 'org', 'w', 'api'].join('.');")).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, "const path = '/w/api';")).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, '// see https://de.wikipedia.org/w/api.php')).toEqual([`${p}:1`]);
    expect(lookupApiMentions(p, "a\nfetch(host + 'api.php')")).toEqual([`${p}:2`]);
    expect(lookupApiMentions('public/hosts.json', '{"api": "https://en.wikipedia.org/w/api.php"}')).toEqual(['public/hosts.json:1']);
    expect(lookupApiMentions('dist/assets/dashboard-x.js', 'const u="https://en.wikipedia.org/w/api.php"')).toEqual(['dist/assets/dashboard-x.js:1']);
    // Wikidata's endpoint is held to the same rule.
    expect(lookupApiMentions(p, "fetch('https://www.wikidata.org/w/api.php')")).toEqual([`${p}:1`]);
    // Allowed: the word, Wikipedia page URLs and hosts (the name step matches Wikipedia tabs), and the client itself.
    expect(lookupApiMentions(p, "const WIKI_SUFFIX = /\\s+[-–—]\\s+Wikipedia$/i;")).toEqual([]);
    expect(lookupApiMentions(p, 'return /(^|\\.)wikipedia\\.org$/i.test(u.hostname);')).toEqual([]);
    expect(lookupApiMentions(p, "const u = 'https://en.wikipedia.org/wiki/Anatomy_of_a_Fall';")).toEqual([]);
    expect(lookupApiMentions('src/ui/mock/f.json', '"Anatomy of a Fall - Wikipedia — en.wikipedia.org wiki Anatomy of Fall"')).toEqual([]);
    expect(lookupApiMentions('public/privacy.html', '<p>then to Wikipedia (Wikimedia Foundation).</p>')).toEqual([]);
    expect(lookupApiMentions(LOOKUP_SOURCE, "const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';")).toEqual([]);
  });
  it('src/ and public/ name Wikidata only in the client, in prose, or in the name list notice', () => {
    const bad = [...walk(join(root, 'src')), ...walk(join(root, 'public'))]
      .flatMap((f) => wikidataMentions(rel(f), readFileSync(f).toString('latin1')));
    expect(bad).toEqual([]);
  });
  it('finds imports of every form', () => {
    const p = 'src/ui/dashboard/X.tsx';
    expect(importsOf(p, "import { lookUp } from '../common/lookup';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "import type { LookupHit } from '../common/lookup.ts';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "export { lookUp } from '../common/lookup';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "export * from '../common/lookup';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "const m = await import('../common/lookup');")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "import '../common/lookup';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "import src from '../common/lookup.ts?raw';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "import u from '../common/lookup?url';")).toContain(LOOKUP_MODULE);
    expect(importsOf('src/background/index.ts', "import {\n  lookUp,\n} from '../ui/common/lookup';")).toContain(LOOKUP_MODULE);
    expect(importsOf(p, "import { x } from '../common/lookup-text';")).not.toContain(LOOKUP_MODULE);
  });
  it('catches the ways around a host check', () => {
    const p = 'src/ui/dashboard/X.tsx';
    expect(wikidataMentions(p, "fetch('https://www.wikidata' + '.org/w/api.php')")).toEqual([`${p}:1`]);
    expect(wikidataMentions(p, "const h = ['www', 'wikidata', 'org'].join('.');")).toEqual([`${p}:1`]);
    expect(wikidataMentions(p, 'const h = `https://www.${"Wikidata"}.org`;')).toEqual([`${p}:1`]);
    expect(wikidataMentions(p, "const s = 'Wikidata';")).toEqual([`${p}:1`]);
    expect(wikidataMentions(p, '// see https://www.wikidata.org/w/api.php')).toEqual([`${p}:1`]);
    expect(wikidataMentions('public/hosts.json', '{"api": "https://www.WIKIDATA.org/w/api.php"}')).toEqual(['public/hosts.json:1']);
    expect(wikidataMentions('dist/assets/a.css', 'a{background:url(https://www.wikidata.org/x)}')).toEqual(['dist/assets/a.css:1']);
    expect(wikidataMentions('public/third-party-notices.txt', 'Source: https://www.wikidata.org/w/api.php')).toHaveLength(1);
    // Allowed: prose in comments and assets, the notice line, and anything in the client itself.
    expect(wikidataMentions(p, ' * Cleans text bound for Wikidata: strips URLs')).toEqual([]);
    expect(wikidataMentions(p, "  // the head's label for a description from Wikidata, embedded here.")).toEqual([]);
    expect(wikidataMentions('public/privacy.html', '<p>Only the text you saw goes to Wikidata (Wikimedia Foundation).</p>')).toEqual([]);
    expect(wikidataMentions('public/third-party-notices.txt', "Source: https://www.wikidata.org\nbuilt from Wikidata. Wikidata's data")).toEqual([]);
    expect(wikidataMentions(LOOKUP_SOURCE, "const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';")).toEqual([]);
  });
});
