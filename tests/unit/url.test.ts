import { describe, it, expect } from 'vitest';
import {
  normalizeUrl, isWebUrl, isSafeToOpen, kindOf, readableSource, cleanTitle, embedText,
} from '../../src/shared/url';
describe('normalizeUrl', () => {
  it.each([
    ['https://WWW.Example.com/a/?utm_source=x&b=1#top', 'https://example.com/a?b=1'],
    ['https://www.youtube.com/watch?v=abc&t=42s&si=zz&list=L1', 'https://youtube.com/watch?v=abc&list=L1'],
    ['https://youtu.be/abc?t=3', 'https://youtube.com/watch?v=abc'],
    ['https://app.com/#/inbox/3', 'https://app.com/#/inbox/3'],
    ['https://x.com/?fbclid=1&gclid=2&mc_eid=3&ref=hn', 'https://x.com/'],
    ['https://a.com/path/', 'https://a.com/path'],
    ['https://a.com/?z=1&a=2', 'https://a.com/?a=2&z=1'],
    ['https://a.com/?UTM_Campaign=x&q=1', 'https://a.com/?q=1'],
  ])('%s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
  it('returns invalid input unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
    expect(normalizeUrl('')).toBe('');
  });
  it('is idempotent', () => {
    const u = normalizeUrl('https://www.youtube.com/watch?v=abc&t=42s&list=L1');
    expect(normalizeUrl(u)).toBe(u);
  });
});
describe('isWebUrl / isSafeToOpen', () => {
  it('accepts http and https, any scheme case', () => {
    for (const u of ['http://a.com', 'https://a.com/x', 'HTTPS://A.com', 'HtTp://a.com']) {
      expect(isWebUrl(u)).toBe(true);
      expect(isSafeToOpen(u)).toBe(true);
    }
  });
  it('rejects everything else', () => {
    for (const u of [
      'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings',
      'edge://flags', 'about:blank', 'view-source:https://a.com', 'blob:', 'blob:https://a.com/x',
      '', 'http://', 'https:', 'a.com', 'ftp://a.com',
    ]) {
      expect(isWebUrl(u)).toBe(false);
      expect(isSafeToOpen(u)).toBe(false);
    }
  });
  it('rejects credentials in the URL', () => {
    expect(isSafeToOpen('https://u:p@a.com')).toBe(false);
    expect(isSafeToOpen('https://u@a.com')).toBe(false);
    expect(isWebUrl('https://u:p@a.com')).toBe(true);
  });
});
describe('kindOf', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc', 'https://m.youtube.com/watch?v=abc', 'https://youtu.be/abc',
    'https://www.netflix.com/title/1', 'https://www.primevideo.com/detail/x', 'https://www.disneyplus.com/x',
    'https://www.twitch.tv/foo', 'https://vimeo.com/123', 'https://www.hulu.com/x', 'https://www.max.com/x',
    'https://www.imdb.com/title/tt123/',
  ])('watch: %s', (u) => expect(kindOf(u)).toBe('watch'));
  it.each([
    'https://www.youtube.com/', 'https://example.com', 'https://www.imdb.com/name/nm1/', 'https://github.com/a/b',
    'https://notnetflix.com/', 'https://evil.com/?u=youtube.com/watch',
  ])('read: %s', (u) => expect(kindOf(u)).toBe('read'));
  it.each(['chrome://settings', 'about:blank', 'file:///x', 'javascript:1', ''])('other: %s', (u) =>
    expect(kindOf(u)).toBe('other'));
});
describe('readableSource', () => {
  it('describes known sources', () => {
    expect(readableSource('https://www.youtube.com/watch?v=a')).toBe('YouTube video');
    expect(readableSource('https://github.com/org/repo/issues/1')).toBe('GitHub repository org repo');
    expect(readableSource('https://www.example.com/x')).toBe('example.com');
  });
  it('does not throw on junk', () => {
    expect(readableSource('nope')).toBe('');
  });
});
describe('cleanTitle', () => {
  it('strips notification prefix and site suffix', () => {
    expect(cleanTitle('(3) Agents tutorial - YouTube', 'https://youtube.com/watch?v=1')).toBe('Agents tutorial');
    expect(cleanTitle('Stranger Things | Netflix', 'https://netflix.com/x')).toBe('Stranger Things');
    expect(cleanTitle('org/repo: stuff - GitHub', 'https://github.com/org/repo')).toBe('org/repo: stuff');
    expect(cleanTitle('(12) YouTube', 'https://youtube.com/')).toBe('YouTube');
  });
  it('falls back to host and path words when empty', () => {
    expect(cleanTitle('', 'https://a.com/x-y-z')).toBe('a.com x y z');
    expect(cleanTitle('   ', 'https://www.a.com/x_y/z.html')).toBe('a.com x y z html');
  });
  it('falls back when title equals the URL', () => {
    expect(cleanTitle('https://a.com/foo-bar', 'https://a.com/foo-bar')).toBe('a.com foo bar');
  });
  it('caps very long titles', () => {
    expect(cleanTitle('x'.repeat(2000), 'https://a.com').length).toBeLessThanOrEqual(300);
    expect(cleanTitle('😀'.repeat(1000), 'https://a.com').length).toBeLessThanOrEqual(300);
  });
  it('preserves emoji and RTL text', () => {
    expect(cleanTitle('🔥 مرحبا بالعالم', 'https://a.com')).toBe('🔥 مرحبا بالعالم');
  });
  it('never returns empty for junk input', () => {
    expect(cleanTitle('', 'junk')).toBe('');
  });
});
describe('embedText', () => {
  it('joins clean title and readable source', () => {
    expect(embedText({ title: '(3) Agents - YouTube', url: 'https://www.youtube.com/watch?v=1' }))
      .toBe('Agents — YouTube video');
  });
});
