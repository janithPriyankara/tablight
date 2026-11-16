import { describe, expect, it } from 'vitest';
import { STARTER_GROUPS } from '../../src/classify/seeds';
import { ruleGroup } from '../../src/classify/rules';
import { buildStarterGroups, classify, learn, type Head } from '../../src/classify/assign';
import { HEAD } from '../../src/classify/head';
import { nameCluster, suggestGroups } from '../../src/classify/cluster';
import type { Group } from '../../src/shared/types';
import { normalize } from '../../src/shared/vec';

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

describe('seeds', () => {
  it('has the 18 starter groups with seeds, colors and icons', () => {
    expect(STARTER_GROUPS.map((g) => g.id)).toEqual([
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
  it('matches the starter groups and its own dimension', () => {
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
    expect(groups.map((g) => g.id)).toEqual(STARTER_GROUPS.map((g) => g.id));
    const total = STARTER_GROUPS.reduce((s, g) => s + g.seeds.length, 0);
    expect(calls.flat()).toHaveLength(total);
    for (const g of groups) {
      const seeds = STARTER_GROUPS.find((s) => s.id === g.id)!.seeds;
      expect(g.builtIn).toBe(true);
      expect(g.exemplars).toEqual([]);
      expect(g.centroid === null).toBe(seeds.length === 0);
    }
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

  it('never returns an empty name', () => {
    expect(nameCluster(['', 'the a'], ['', ''])).not.toBe('');
  });
});

describe('ruleGroup', () => {
  it.each([
    ['https://www.netflix.com/title/123', 'Stranger Things | Netflix', ['tv', 'movies']],
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
