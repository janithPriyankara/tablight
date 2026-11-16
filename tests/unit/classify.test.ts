import { describe, expect, it } from 'vitest';
import { STARTER_GROUPS } from '../../src/classify/seeds';
import { ruleGroup } from '../../src/classify/rules';
import { assign, buildStarterGroups, DEFAULT_THRESHOLD, learn } from '../../src/classify/assign';
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

describe('assign', () => {
  const a = group('a', [vec(0, 0.1), vec(0, 0.2), vec(0, 0.05)]);
  const b = group('b', [vec(4, 0.1), vec(4, 0.2), vec(4, 0.05)]);

  it('picks the group whose exemplars are nearest', () => {
    expect(assign(vec(0, 0.15), [a, b]).groupId).toBe('a');
    const r = assign(vec(4, 0.15), [a, b]);
    expect(r.groupId).toBe('b');
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('returns null below the threshold', () => {
    const r = assign(vec(9), [a, b]);
    expect(r.groupId).toBeNull();
    expect(r.score).toBeLessThan(DEFAULT_THRESHOLD);
  });

  it('respects a custom threshold', () => {
    expect(assign(vec(0, 0.15), [a, b], { threshold: 1.01 }).groupId).toBeNull();
  });

  it('uses k nearest exemplars: k=2 by default, overridable', () => {
    // A: two exact facets plus unrelated ones; B: five mediocre matches.
    const facets = group('facets', [vec(0, 0, 1), vec(0, 0, 1), vec(5), vec(7), vec(9)]);
    const uniform = group('uniform', Array.from({ length: 5 }, () => vec(0, 2, 1)));
    const q = vec(0, 0.3, 1);
    expect(assign(q, [facets, uniform]).groupId).toBe('facets');
    expect(assign(q, [facets, uniform], { k: 5 }).groupId).toBe('uniform');
  });
  it('never assigns to the other group', () => {
    const other = group('other', [vec(9), vec(9, 0.1)]);
    expect(assign(vec(9), [a, b, other]).groupId).toBeNull();
  });

  it('skips groups with no exemplars and no centroid', () => {
    const empty = group('empty', []);
    expect(assign(vec(0), [empty, a]).groupId).toBe('a');
    expect(assign(vec(0), [empty])).toEqual({ groupId: null, score: 0 });
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
  it('embeds each group seed once and builds centroids', async () => {
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
      expect(g.exemplars).toHaveLength(seeds.length);
      expect(g.centroid === null).toBe(seeds.length === 0);
      expect(Array.isArray(g.exemplars[0] ?? [])).toBe(true);
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
