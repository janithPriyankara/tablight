import { describe, it, expect } from 'vitest';
import {
  normalizeUrl, isWebUrl, isSafeToOpen, kindOf, readableSource, cleanTitle, embedText, pathWords, isClutterTab,
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
  it('desktop, mobile and short YouTube links of one video normalize alike (dedupe + one sync id)', async () => {
    const { sha1hex } = await import('../../src/shared/hash');
    const links = [
      'https://www.youtube.com/watch?v=abc&list=L1',
      'https://m.youtube.com/watch?list=L1&v=abc&t=10',
      'https://youtube.com/watch?list=L1&v=abc&si=x',
      'https://youtu.be/abc?list=L1&t=3',
    ];
    const norm = links.map(normalizeUrl);
    expect(new Set(norm)).toEqual(new Set(['https://youtube.com/watch?v=abc&list=L1']));
    expect(new Set(await Promise.all(norm.map((u) => sha1hex(u)))).size).toBe(1);
    expect(normalizeUrl('https://m.youtube.com/')).toBe('https://youtube.com/');
    expect(normalizeUrl('https://m.example.com/a')).toBe('https://m.example.com/a'); // only YouTube's mobile host
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
  it('appends meaningful path words (spec 7.3.1)', () => {
    expect(embedText({ title: 'Overview', url: 'https://docs.claude.com/en/docs/agent-sdk/overview' }))
      .toBe('Overview — docs.claude.com docs agent sdk overview');
    expect(embedText({ title: 'Fix', url: 'https://github.com/acme/api/pull/4821' }))
      .toBe('Fix — GitHub repository acme api pull');
    expect(embedText({ title: 'Home', url: 'https://example.com/' })).toBe('Home — example.com');
  });
});
describe('pathWords', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', ''],
    ['https://www.youtube.com/feed/subscriptions', 'feed subscriptions'],
    ['https://www.imdb.com/title/tt15398776/', 'title'],
    ['https://www.amazon.com/Sony-WH-1000XM5-Headphones/dp/B09XS7JWHH/', 'Sony WH Headphones dp'],
    ['https://example.com/en-US/docs/Web/index.html', 'docs Web'],
    ['https://example.com/blog/2024/05/my_first-post.php', 'blog my first post'],
    ['https://example.com/f/3f2a1b0c9d8e7f6a5b4c/report', 'report'],
    ['https://example.com/a/' + 'b'.repeat(40), ''],
    ['https://example.com/Docs/docs/DOCS', 'Docs'],
    ['https://example.com/%E6%97%A5%E6%9C%AC/caf%C3%A9', '日本 café'],
    ['https://example.com/%E0%A4%A', ''],
    ['https://github.com/org/repo', ''],
    ['https://github.com/org/repo/issues/12', 'issues'],
    ['https://chatgpt.com/c/6732a1f0-1b3c-8000-a1b2-9f8e7d6c5b4a', ''],
    ['https://example.com/v1/cs1/3d/8B', 'v1 cs1 3d 8B'],
    ['not a url', ''],
  ])('%s → %j', (url, expected) => {
    expect(pathWords(url)).toBe(expected);
  });
  it('keeps at most 8 words', () => {
    expect(pathWords('https://e.com/' + 'abcdefghijkl'.split('').map((c) => c + c).join('/')).split(' ')).toHaveLength(8);
  });
});

describe('isClutterTab', () => {
  const own = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
  it.each([
    own + 'dashboard.html', own + 'popup.html#x', 'about:blank', '', 'chrome://newtab/', 'edge://newtab/',
    'chrome://new-tab-page/', 'about:newtab',
  ])('hides %s', (url) => {
    expect(isClutterTab(url, own)).toBe(true);
  });
  it.each([
    'https://example.com/', 'chrome://settings/', 'edge://settings/', 'file:///Users/me/a.pdf',
    'chrome-extension://otherextensionidxxxxxxxxxxxxxxxx/page.html', 'https://example.com/?u=about:blank',
  ])('keeps %s', (url) => {
    expect(isClutterTab(url, own)).toBe(false);
  });
});
