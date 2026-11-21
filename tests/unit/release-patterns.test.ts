import { describe, expect, it } from 'vitest';
import { BANNED_CODE, LOOKUP_SOURCE, URL_ALLOWLIST, bannedName, packageOf, urlScopeError } from '../../scripts/release-patterns.mjs';
describe('release gate patterns', () => {
  it('flags DOM-injection and dynamic-code APIs', () => {
    const code = 'a.innerHTML=x; el.setHTMLUnsafe(h); r.createContextualFragment(s); f.srcdoc=s; eval (s); new Function("x"); document.write(1)';
    expect([...code.matchAll(BANNED_CODE)].map((m) => bannedName(m[0]))).toEqual([
      'innerHTML', 'setHTMLUnsafe', 'createContextualFragment', 'srcdoc', 'eval(', 'new Function(', 'document.write',
    ]);
    expect('evaluate(x); newFunction(); retrieval(1)'.match(BANNED_CODE)).toBeNull();
  });
  it('maps module ids to packages', () => {
    expect(packageOf('/p/node_modules/preact/dist/preact.mjs')).toBe('preact');
    expect(packageOf('/p/node_modules/@huggingface/transformers/dist/x.js?v=1')).toBe('@huggingface/transformers');
    expect(packageOf('\0rolldown/runtime.js')).toBe('bundler-runtime');
    expect(packageOf('/p/src/background/index.ts')).toBeNull();
  });
  it('scopes allowlisted URLs to the chunks and packages they come from', () => {
    const entry = { re: /^https:\/\/huggingface\.co\/$/, pkgs: ['@huggingface/transformers'] };
    const lib = { urls: { app: {}, lib: { 'https://huggingface.co/': ['@huggingface/transformers'] } } };
    expect(urlScopeError(entry, 'assets/offscreen-x.js', lib)).toBeNull();
    expect(urlScopeError(entry, 'background.js', lib)).toMatch(/service worker/);
    expect(urlScopeError(entry, 'assets/a.js', undefined)).toMatch(/build record/);
    expect(urlScopeError(entry, 'assets/a.js', { urls: { app: { 'https://huggingface.co/': 1 }, lib: {} } })).toMatch(/app code/);
    expect(urlScopeError(entry, 'assets/a.js', { urls: { app: {}, lib: {} } })).toMatch(/not attributable/);
    expect(urlScopeError(entry, 'assets/a.js', { urls: { app: {}, lib: { 'https://huggingface.co/': ['evil-pkg'] } } })).toMatch(/evil-pkg/);
  });
  /** The real allowlist entry that admits `url`, and that it is the only one. */
  const entryFor = (url: string) => {
    const hits = URL_ALLOWLIST.filter((e) => e.re.test(url));
    expect(hits, url).toHaveLength(1);
    return hits[0]!;
  };
  for (const api of ['https://www.wikidata.org/w/api.php', 'https://en.wikipedia.org/w/api.php']) {
    it(`scopes ${api} to the look-up client alone, with the real allowlist entry`, () => {
      const entry = entryFor(api);
      expect(entry.app).toEqual([LOOKUP_SOURCE]);
      expect(entry.pkgs).toBeUndefined();
      expect(entry.why).toBeTruthy();
      // Anchored: nothing before or after the exact URL, and no other host or path.
      const host = new URL(api).host;
      for (const near of [`${api}?x=1`, `${api}x`, `http://${host}/w/api.php`, `https://x.${host}/w/api.php`, `https://${host}/w/rest.php`]) {
        expect(entry.re.test(near), near).toBe(false);
      }
      expect(entry.re.test('https://de.wikipedia.org/w/api.php')).toBe(false);
      const chunk = (appIn: string[], lib: Record<string, string[]> = {}) => ({ urls: { app: { [api]: 1 }, appIn: { [api]: appIn }, lib } });
      expect(urlScopeError(entry, 'assets/LookupDialog-x.js', chunk([LOOKUP_SOURCE]))).toBeNull();
      expect(urlScopeError(entry, 'background.js', chunk([LOOKUP_SOURCE]))).toMatch(/service worker/);
      expect(urlScopeError(entry, 'assets/a.js', chunk([LOOKUP_SOURCE, 'src/ui/dashboard/App.tsx']))).toMatch(/App\.tsx/);
      expect(urlScopeError(entry, 'assets/a.js', chunk(['src/ui/common/LookupDialog.tsx']))).toMatch(/LookupDialog\.tsx/);
      expect(urlScopeError(entry, 'assets/a.js', { urls: { app: { [api]: 1 }, lib: {} } })).toMatch(/unknown module/);
      expect(urlScopeError(entry, 'assets/a.js', { urls: { app: {}, appIn: {}, lib: { [api]: ['evil-pkg'] } } })).toMatch(/library code/);
      expect(urlScopeError(entry, 'assets/a.js', { urls: { app: {}, appIn: {}, lib: {} } })).toMatch(/not attributable/);
    });
  }
  it('every allowlist entry is anchored, justified and scoped', () => {
    for (const e of URL_ALLOWLIST) {
      expect(e.re.source.startsWith('^'), e.re.source).toBe(true);
      expect(e.why.length).toBeGreaterThan(10);
      expect(Boolean(e.app) !== Boolean(e.pkgs), e.re.source).toBe(true);
    }
  });
});
