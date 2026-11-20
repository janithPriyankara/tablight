// Who may call the opt-in look-up, and where Wikidata may be named: checked on the sources, before any build
// (scripts/verify-release.mjs checks the same on the build record and on every file of dist/).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOKUP_IMPORTERS, LOOKUP_SOURCE, importsOf, wikidataMentions } from '../../scripts/release-patterns.mjs';

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
