import { describe, expect, it } from 'vitest';
import { BANNED_CODE, bannedName, packageOf, urlScopeError } from '../../scripts/release-patterns.mjs';
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
  it('scopes the look-up API URL to the one app module that may use it', () => {
    const api = 'https://www.wikidata.org/w/api.php';
    const entry = { re: /^https:\/\/www\.wikidata\.org\/w\/api\.php$/, app: ['src/ui/common/lookup.ts'] };
    const chunk = (appIn: string[], lib: Record<string, string[]> = {}) => ({ urls: { app: { [api]: 1 }, appIn: { [api]: appIn }, lib } });
    expect(urlScopeError(entry, 'assets/dashboard-x.js', chunk(['src/ui/common/lookup.ts']))).toBeNull();
    expect(urlScopeError(entry, 'background.js', chunk(['src/ui/common/lookup.ts']))).toMatch(/service worker/);
    expect(urlScopeError(entry, 'assets/a.js', chunk(['src/ui/common/lookup.ts', 'src/ui/dashboard/App.tsx']))).toMatch(/App\.tsx/);
    expect(urlScopeError(entry, 'assets/a.js', { urls: { app: { [api]: 1 }, lib: {} } })).toMatch(/unknown module/);
    expect(urlScopeError(entry, 'assets/a.js', { urls: { app: {}, appIn: {}, lib: { [api]: ['evil-pkg'] } } })).toMatch(/library code/);
    expect(urlScopeError(entry, 'assets/a.js', { urls: { app: {}, appIn: {}, lib: {} } })).toMatch(/not attributable/);
  });
});
