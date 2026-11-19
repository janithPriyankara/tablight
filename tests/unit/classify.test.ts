import { describe, expect, it } from 'vitest';
import { STARTER_GROUPS } from '../../src/classify/seeds';
import { ruleGroup } from '../../src/classify/rules';
import { buildStarterGroups, buildTrainedGroup, TRAINED_IDS, classify, learn, type Head } from '../../src/classify/assign';
import { HEAD } from '../../src/classify/head';
import { nameCluster, suggestGroups } from '../../src/classify/cluster';
import type { Group } from '../../src/shared/types';
import { normalize } from '../../src/shared/vec';
import { embedText } from '../../src/shared/url';

const DIM = 16;
/** Unit vector along axis `a`, nudged slightly towards axis `b` by `eps`. */
function vec(a: number, eps = 0, b = (a + 1) % DIM): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[a] = 1;
  v[b] = (v[b] ?? 0) + eps;
  return normalize(v);
}
function group(id: string, exemplars: number[][]): Group {
  return {
    id, name: id, color: '#000', icon: 'x', builtIn: true, exemplars,
    centroid: exemplars.length ? normalize(exemplars[0]!.map((_, i) => exemplars.reduce((s, e) => s + e[i]!, 0))) : null,
    createdAt: 0,
  };
}

const NEW_IDS = [
  'hardware', 'science', 'sports', 'food', 'cars', 'home', 'fashion', 'pets', 'family', 'jobs', 'books', 'photo',
  'anime', 'realestate',
];
const INSTALLED = STARTER_GROUPS.filter((g) => !g.onDemand);
const fakeEmbed = async (texts: string[]) => texts.map((_, i) => Float32Array.from(vec(i % DIM)));
describe('seeds', () => {
  it('has the 18 starter groups with seeds, colors and icons', () => {
    expect(INSTALLED.map((g) => g.id)).toEqual([
      'movies', 'tv', 'videos', 'ai', 'programming', 'design', 'shopping', 'news', 'social', 'music',
      'learning', 'docs', 'work', 'travel', 'finance', 'health', 'games', 'other',
    ]);
    for (const g of STARTER_GROUPS) {
      expect(g.name).not.toBe('');
      expect(g.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(g.icon).not.toBe('');
      if (g.id !== 'other') {
        expect(g.seeds.length).toBeGreaterThanOrEqual(5);
        expect(g.seeds.length).toBeLessThanOrEqual(15);
      }
    }
    expect(new Set(STARTER_GROUPS.map((g) => g.color)).size).toBe(STARTER_GROUPS.length);
  });
  it('has the 14 on-demand groups, each with a name, icon and 6-9 seeds', () => {
    expect(STARTER_GROUPS.filter((g) => g.onDemand).map((g) => g.id)).toEqual(NEW_IDS);
    expect([...TRAINED_IDS].sort()).toEqual([...NEW_IDS].sort());
    for (const g of STARTER_GROUPS.filter((x) => x.onDemand)) {
      expect(g.name).not.toBe('');
      expect(g.icon).not.toBe('');
      expect(g.seeds.length).toBeGreaterThanOrEqual(6);
      expect(g.seeds.length).toBeLessThanOrEqual(9);
    }
    expect(STARTER_GROUPS.find((g) => g.id === 'hardware')!.name).toBe('Hardware & making');
    expect(STARTER_GROUPS.find((g) => g.id === 'realestate')!.name).toBe('Real estate');
  });
  it('never names brands or sites in a seed', () => {
    const banned = /\b(youtube|google|amazon|ebay|netflix|spotify|reddit|twitter|facebook|instagram|tiktok|pinterest|etsy|zillow|rightmove|linkedin|indeed|glassdoor|goodreads|crunchyroll|espn|nikon|canon|sony|arduino|esp32|raspberry|lightroom|photoshop|ikea|tesla|toyota|\.com|http|www)\b/i;
    for (const g of STARTER_GROUPS) for (const t of g.seeds) expect(t, `${g.id}: ${t}`).not.toMatch(banned);
  });
});

describe('classify', () => {
  const axis = (i: number, w = 10) => Array.from({ length: DIM }, (_, d) => (d === i ? w : 0));
  const head: Head = {
    model: 'test', dim: DIM, labels: ['a', 'b', 'other'],
    W: [axis(0), axis(4), axis(9)], b: [0, 0, 0], threshold: 0.6, similarity: 0.9,
  };
  const a = group('a', []);
  const b = group('b', []);
  const groups = [a, b, group('other', [])];
  it('takes the head top label', () => {
    const r = classify(vec(0), groups, head);
    expect(r.groupId).toBe('a');
    expect(r.score).toBeGreaterThan(0.99);
    expect(classify(vec(4), groups, head).groupId).toBe('b');
  });
  it('leaves `other` and low-confidence tabs Unsorted', () => {
    expect(classify(vec(9), groups, head).groupId).toBeNull();
    const mixed = normalize([...axis(0, 1)].map((x, d) => x + (d === 4 ? 1 : 0)));
    const r = classify(mixed, groups, head);
    expect(r).toEqual({ groupId: null, score: expect.closeTo(0.5, 1) });
    expect(classify(mixed, groups, head, { threshold: 0.4 }).groupId).not.toBeNull();
  });
  it('returns null when the head label has no group, or the dimension is wrong', () => {
    expect(classify(vec(0), [b], head).groupId).toBeNull();
    expect(classify([1, 0, 0], groups, head)).toEqual({ groupId: null, score: 0 });
  });
  it('lets user-learned exemplars override the head', () => {
    const taughtB = learn(b, vec(0, 0.05));
    const r = classify(vec(0), [a, taughtB], head);
    expect(r.groupId).toBe('b');
    expect(r.score).toBeGreaterThan(0.99);
    expect(classify(vec(0), [a, taughtB], head, { similarity: 1.01 }).groupId).toBe('a');
  });
  it('assigns user-created groups through exemplars alone', () => {
    const mine = learn(group('mine', []), vec(12));
    expect(classify(vec(12, 0.1), [...groups, mine], head).groupId).toBe('mine');
    // Far from the exemplar: falls back to the head, which is unsure (uniform) → Unsorted.
    expect(classify(vec(13), [...groups, mine], head).groupId).toBeNull();
  });
  it('never assigns other, even from exemplars', () => {
    const other = learn(group('other', []), vec(0));
    expect(classify(vec(0), [a, b, other], head).groupId).toBe('a');
  });
});
describe('bundled head', () => {
  it('knows every seed group, installed and on-demand, and its own dimension', () => {
    expect(HEAD.labels).toEqual(STARTER_GROUPS.map((g) => g.id));
    expect(HEAD.W).toHaveLength(HEAD.labels.length);
    for (const row of HEAD.W) expect(row).toHaveLength(HEAD.dim);
    expect(HEAD.b).toHaveLength(HEAD.labels.length);
    expect(HEAD.threshold).toBeGreaterThanOrEqual(0);
    expect(HEAD.threshold).toBeLessThan(1);
    expect(HEAD.similarity).toBeGreaterThan(0);
    expect(HEAD.similarity).toBeLessThanOrEqual(1);
  });
});
describe('learn', () => {
  it('caps exemplars at 50 and keeps the newest 50', () => {
    let g = group('g', []);
    for (let i = 0; i < 60; i++) g = learn(g, [i, 1]);
    expect(g.exemplars).toHaveLength(50);
    expect(g.exemplars[0]).toEqual([10, 1]);
    expect(g.exemplars[49]).toEqual([59, 1]);
  });

  it('recomputes the centroid and does not mutate the input', () => {
    const g = group('g', [vec(0)]);
    const before = g.exemplars.length;
    const next = learn(g, vec(1));
    expect(g.exemplars).toHaveLength(before);
    expect(next.centroid).not.toBeNull();
    expect(next.centroid![0]).toBeCloseTo(Math.SQRT1_2);
    expect(next.centroid![1]).toBeCloseTo(Math.SQRT1_2);
  });
});

describe('buildStarterGroups', () => {
  it('embeds each group seed once into a centroid, with no exemplars', async () => {
    const calls: string[][] = [];
    const groups = await buildStarterGroups(async (texts) => {
      calls.push(texts);
      return texts.map((_, i) => Float32Array.from(vec(i % DIM)));
    });
    expect(groups.map((g) => g.id)).toEqual(INSTALLED.map((g) => g.id));
    for (const id of NEW_IDS) expect(groups.map((g) => g.id)).not.toContain(id);
    const total = INSTALLED.reduce((s, g) => s + g.seeds.length, 0);
    expect(calls.flat()).toHaveLength(total);
    for (const g of groups) {
      const seeds = STARTER_GROUPS.find((s) => s.id === g.id)!.seeds;
      expect(g.builtIn).toBe(true);
      expect(g.exemplars).toEqual([]);
      expect(g.centroid === null).toBe(seeds.length === 0);
    }
  });
});

describe('buildTrainedGroup', () => {
  it('builds one on-demand group with a centroid and no exemplars', async () => {
    const calls: string[][] = [];
    const g = await buildTrainedGroup('hardware', async (t) => { calls.push(t); return fakeEmbed(t); });
    expect(g).toMatchObject({ id: 'hardware', name: 'Hardware & making', builtIn: true, exemplars: [] });
    expect(g.centroid).toHaveLength(DIM);
    const seeds = STARTER_GROUPS.find((s) => s.id === 'hardware')!.seeds;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(seeds);
  });
  it('also rebuilds an installed group, so a deleted one can come back', async () => {
    const g = await buildTrainedGroup('movies', fakeEmbed);
    expect(g).toMatchObject({ id: 'movies', name: 'Movies', builtIn: true });
    expect(g.centroid).not.toBeNull();
  });
  it('throws on an unknown id', async () => {
    await expect(buildTrainedGroup('nope', fakeEmbed)).rejects.toThrow(/unknown group/);
  });
});
describe('suggestGroups', () => {
  const items: { id: string; title: string; domain: string; vec: number[] }[] = [];
  for (const [c, axis] of [[0, 0], [1, 5], [2, 10]] as const) {
    for (let i = 0; i < 4; i++) {
      items.push({ id: `c${c}-${i}`, title: `topic${c} item ${i}`, domain: `d${c}.com`, vec: vec(axis, 0.05 * (i + 1)) });
    }
  }
  items.push({ id: 'out1', title: 'lonely', domain: 'x.com', vec: vec(3) });
  items.push({ id: 'out2', title: 'alone', domain: 'y.com', vec: vec(14) });

  it('finds 3 tight clusters and leaves outliers out', () => {
    const s = suggestGroups(items);
    expect(s).toHaveLength(3);
    const sets = s.map((x) => [...x.itemIds].sort().join(',')).sort();
    expect(sets).toEqual([
      'c0-0,c0-1,c0-2,c0-3', 'c1-0,c1-1,c1-2,c1-3', 'c2-0,c2-1,c2-2,c2-3',
    ]);
    for (const x of s) expect(x.name).not.toBe('');
  });

  it('respects minSize', () => {
    expect(suggestGroups(items, { minSize: 5 })).toHaveLength(0);
    const small = items.filter((x) => !['c0-3', 'c1-2', 'c1-3'].includes(x.id));
    const ids = suggestGroups(small).flatMap((x) => x.itemIds);
    expect(ids.some((id) => id.startsWith('c1-'))).toBe(false);
    expect(ids.filter((id) => id.startsWith('c0-'))).toHaveLength(3);
  });

  it('returns nothing for empty input', () => {
    expect(suggestGroups([])).toEqual([]);
  });
});

describe('nameCluster', () => {
  it('uses the top distinctive terms without stop-words', () => {
    const name = nameCluster(
      ['Rust async book', 'Async Rust tokio guide', 'Rust async traits'],
      ['doc.rust-lang.org', 'tokio.rs', 'blog.x'],
    );
    expect(name.toLowerCase()).toContain('rust');
    expect(name.toLowerCase()).toContain('async');
    for (const stop of ['the', 'and', 'of', 'a']) {
      expect(name.toLowerCase().split(/[^a-z]+/)).not.toContain(stop);
    }
  });

  it('adds the domain when at least 60% share it', () => {
    const name = nameCluster(
      ['The Rust book', 'Rust ownership', 'Rust lifetimes'],
      ['doc.rust-lang.org', 'doc.rust-lang.org', 'other.org'],
    );
    expect(name).toContain('doc.rust-lang.org');
  });

  it('never repeats the domain, and caps names at 60 characters', () => {
    const untitled = nameCluster(['docs.foo.dev page one', 'docs.foo.dev page two', 'docs.foo.dev page three'],
      ['docs.foo.dev', 'docs.foo.dev', 'docs.foo.dev']);
    expect(untitled.split(' · ').filter((p) => p === 'docs.foo.dev')).toHaveLength(1);
    const long = nameCluster(['x'.repeat(200) + ' a', 'x'.repeat(200) + ' b', 'x'.repeat(200) + ' c'], ['', '', '']);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.length).toBeGreaterThan(0);
  });
  it('never returns an empty name', () => {
    expect(nameCluster(['', 'the a'], ['', ''])).not.toBe('');
  });
});

describe('ruleGroup', () => {
  it.each([
    ['https://www.netflix.com/title/123', 'Stranger Things | Netflix', ['tv']],
    // Netflix titles never say "Season": a show and a film look the same, so Netflix defaults to TV.
    ['https://www.netflix.com/lk/title/80057281', 'Watch Stranger Things | Netflix Official Site', ['tv']],
    ['https://www.netflix.com/watch/80057281', 'Netflix', ['tv']],
    ['https://www.primevideo.com/detail/0XYZ/', 'Red One | Prime Video', ['movies']],
    ['https://www.imdb.com/title/tt0903747/', 'Breaking Bad (TV Series 2008–2013) - IMDb', ['tv']],
    ['https://www.imdb.com/title/tt7366338/', 'Chernobyl (TV Mini Series 2019) - IMDb', ['tv']],
    ['https://www.imdb.com/title/tt1375666/', 'Inception (2010) - IMDb', ['movies']],
    ['https://www.disneyplus.com/series/andor/3xsQKWG00GL5', 'Watch Andor | Disney+', ['tv']],
    ['https://www.disneyplus.com/movies/encanto/33q7DY1rtHQH', 'Watch Encanto | Disney+', ['movies']],
    ['https://www.hulu.com/series/the-bear-0123', 'The Bear | Hulu', ['tv']],
    ['https://www.primevideo.com/detail/0ABC/', 'The Boys - Season 4 | Prime Video', ['tv']],
    ['https://music.youtube.com/watch?v=abc', 'Song - YouTube Music', ['music']],
    ['https://www.youtube.com/music', 'Music - YouTube', ['music']],
    ['https://open.spotify.com/album/abc', 'Abbey Road | Spotify', ['music']],
    ['https://www.amazon.com/Some-Thing/dp/B0C1XYZ234/', 'Amazon.com: Some Thing', ['shopping']],
    ['https://www.amazon.co.uk/gp/product/B0C1XYZ234', 'Thing', ['shopping']],
    ['https://www.ebay.com/itm/1234', 'Thing | eBay', ['shopping']],
    ['https://www.aliexpress.com/item/1005.html', 'Thing - AliExpress', ['shopping']],
    ['https://www.etsy.com/listing/123/mug', 'Mug - Etsy', ['shopping']],
    ['https://store.steampowered.com/app/1145360/Hades/', 'Hades on Steam', ['games']],
    ['https://acme.slack.com/archives/C0123', 'general | Acme Slack', ['work']],
    ['https://mail.google.com/mail/u/0/#inbox', 'Inbox - Gmail', ['work']],
    ['https://x.com/someone/status/1', 'Post / X', ['social']],
    ['https://www.linkedin.com/feed/', 'Feed | LinkedIn', ['social']],
    ['https://stackoverflow.com/questions/1/x', 'x - Stack Overflow', ['programming']],
  ])('%s → %s', (url, title, expected) => {
    expect(expected).toContain(ruleGroup(url, title));
  });

  it.each([
    ['https://example.com', 'x'],
    ['https://www.youtube.com/watch?v=abc', 'Rust in 100 seconds - YouTube'],
    ['https://www.imdb.com/name/nm0000138/', 'Leonardo DiCaprio - IMDb'],
    ['https://aws.amazon.com/dp/whatever', 'AWS'],
    ['https://www.amazon.com/', 'Amazon.com. Spend less. Smile more.'],
    ['https://open.spotify.com/show/abc', 'Some Podcast | Spotify'],
    ['https://developers.facebook.com/docs/graph-api', 'Graph API - Meta for Developers'],
    ['https://www.linkedin.com/learning/some-course', 'Some course | LinkedIn Learning'],
    ['https://www.reddit.com/r/rust/', 'r/rust'],
    ['https://notx.com/', 'Not X'],
    ['https://docs.google.com/document/d/abc/edit', 'Trip itinerary - Google Docs'],
    ['https://drive.google.com/drive/my-drive', 'My Drive'],
    ['https://www.notion.so/Recipes-123', 'Recipes'],
    ['https://www.facebook.com/marketplace/', 'Marketplace'],
    ['https://www.linkedin.com/in/someone/', 'Someone | LinkedIn'],
    ['https://leetcode.com/problems/two-sum/', 'Two Sum'],
    ['chrome://settings', 'Settings'],
    ['not a url', ''],
  ])('%s → null', (url, title) => {
    expect(ruleGroup(url, title)).toBeNull();
  });
});

describe('drama rules', () => {
  const yt = 'https://www.youtube.com/watch?v=abc';
  it.each([
    ['https://kisskh.co/Drama/Fight-For-My-Way/Episode-3?id=1', 'Fight For My Way Episode 3', 'tv'],
    ['https://kisskh.me/Drama/Some-Film?id=2', 'Some Film (2019) Full Movie', 'movies'],
    ['https://kisskh.me/Drama/Some-Film?id=2', 'Some Film The Movie', 'movies'],
    ['https://kisskh.me/Drama/Some-Film?id=2', 'Some Film Movie Eng Sub', 'movies'],
    ['https://kisskh.me/Drama/Some-Film?id=2', 'Moviegoers Episode 2', 'tv'],
    ['https://en.mydramalist.com/123-x', 'X - MyDramaList', 'tv'],
    ['https://www.viki.com/tv/123-x', 'Watch X', 'tv'],
    ['https://en.viki.com/tv/123-x', 'Watch X', 'tv'],
    ['https://iq.com/play/x', 'X', 'tv'],
    ['https://www.iq.com/play/x', 'X', 'tv'],
    ['https://wetv.vip/play/x', 'X', 'tv'],
    [yt, 'Scene #koreandrama - YouTube', 'tv'],
    [yt, 'Scene #chinesedrama - YouTube', 'tv'],
    [yt, 'Scene #japanesedrama - YouTube', 'tv'],
    [yt, 'Scene #twdrama - YouTube', 'tv'],
    [yt, 'Scene #asiandrama - YouTube', 'tv'],
    [yt, 'Scene #jdrama - YouTube', 'tv'],
    [yt, 'Scene #kdrama_edit - YouTube', 'tv'],
    [yt, 'Scene #kdramaedits - YouTube', 'tv'],
    [yt, 'Scene #cdramaclips - YouTube', 'tv'],
    [yt, 'Scene #kdramas - YouTube', 'tv'],
    ['https://www.viki.com/tv/123-x', 'Watch X', 'tv'],
    ['https://mydramalist.com/123-x', 'X - MyDramaList', 'tv'],
    ['https://kisskh.co/', 'KissKH', 'tv'],
    ['https://dramacool9.ru/x', 'X', 'tv'],
    ['https://www.youtube.com/shorts/abc', 'He caught her\u2026 #cdrama #shorts - YouTube', 'tv'],
    [yt, 'Best scenes #kdramaedit - YouTube', 'tv'],
    ['https://youtu.be/abc', 'Scene #thaidrama - YouTube', 'tv'],
  ])('%s -> %s', (url, title, expected) => {
    expect(ruleGroup(url, title)).toBe(expected);
  });
  it.each([
    [yt, 'Drama in the parliament today - YouTube'],
    [yt, 'Cooking #dramatic reveal - YouTube'],
    [yt, 'Fan #dramaqueen - YouTube'],
    [yt, 'Influencer exposed #drama #tea - YouTube'],
    [yt, 'Gossip #dramas - YouTube'],
    [yt, 'Tea time #dramaalert - YouTube'],
    ['https://notviki.com/x', 'X'],
    ['https://wetv.example.com/x', 'X'],
    ['https://aiq.com/x', 'X'],
    ['https://iq.com.evil.net/x', 'X'],
    ['https://www.youtube.com/@chan', 'X #kdrama - YouTube'],
    ['https://example.com/a', 'X #kdrama'],
  ])('%s %s -> null', (url, title) => {
    expect(ruleGroup(url, title)).toBeNull();
  });
});
describe('classify: neighbour blend', () => {
  // 2-d toy: the head alone can't separate (all weights 0, so a uniform guess), the neighbours can.
  const toInt8 = (rows: number[][]) => btoa(String.fromCharCode(...rows.flat().map((x) => Math.round(x * 127) & 0xff)));
  const head: Head = {
    model: 't', dim: 2, labels: ['a', 'b', 'other'], W: [[0, 0], [0, 0], [0, 0]], b: [0, 0, -1], threshold: 0, similarity: 0.99,
    knn: { k: 3, alpha: 0.5, sharp: 10, labels: [0, 0, 0, 1, 1, 1], vecs: toInt8([[1, 0], [0.98, 0.2], [0.95, 0.31], [0, 1], [0.2, 0.98], [0.31, 0.95]]) },
  };
  const groups = ['a', 'b', 'other'].map((id) => ({ id, name: id, color: '#000', icon: '', builtIn: true, exemplars: [] as number[][], centroid: null, createdAt: 1 }));
  it('votes for the group of the nearest training examples', () => {
    expect(classify([0.99, 0.1], groups, head).groupId).toBe('a');
    expect(classify([0.1, 0.99], groups, head).groupId).toBe('b');
  });
  it('without neighbour data the head alone decides (unchanged behaviour)', () => {
    const { knn: _k, ...plain } = head;
    void _k;
    expect(classify([0.1, 0.99], groups, { ...plain, b: [1, 0, -1] }).groupId).toBe('a');
  });
  it('a user-taught exemplar still overrides everything', () => {
    const taught = groups.map((g) => (g.id === 'a' ? { ...g, exemplars: [[0.1, 0.99]] } : g));
    expect(classify([0.1, 0.99], taught, head).groupId).toBe('a');
  });
});

describe('embedText for YouTube', () => {
  it('leaves out the source word for YouTube videos only', () => {
    const title = 'How To Cut Threads On A Lathe - YouTube';
    for (const url of [
      'https://www.youtube.com/watch?v=x',
      'https://m.youtube.com/watch?v=x',
      'https://www.youtube.com/shorts/x',
      'https://youtu.be/x',
    ]) {
      const t = embedText({ title, url });
      expect(t).not.toContain('YouTube');
      expect(t).toBe('How To Cut Threads On A Lathe');
    }
    expect(embedText({ title: 'Some Channel - YouTube', url: 'https://www.youtube.com/@channel' })).toContain('— ');
    expect(embedText({ title: 'Some Page', url: 'https://example.com/a' })).toContain('— example.com');
  });
});
