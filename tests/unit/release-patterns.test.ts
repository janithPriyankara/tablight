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
});
