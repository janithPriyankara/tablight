import { describe, expect, it } from 'vitest';
import { semanticSearch, wordSearch } from '../../src/search/search';
import type { Group, Item } from '../../src/shared/types';
function item(id: string, title: string, over: Partial<Item> = {}): Item {
  return {
    id, url: `https://example.com/${id}`, normUrl: `https://example.com/${id}`, title, domain: 'example.com',
    state: 'open', groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1,
    classifiable: true, ...over,
  };
}
const group = (id: string, name: string): Group => ({
  id, name, color: '#000', icon: 'x', builtIn: false, exemplars: [], centroid: null, createdAt: 1,
});
describe('wordSearch', () => {
  const items = [
    item('a', 'Claude Agent SDK docs'),
    item('b', 'Cooking pasta', { domain: 'youtube.com' }),
    item('c', 'Café Münchën menu', { groupId: 'g1' }),
  ];
  const groups = [group('g1', 'Travel')];
  it('tolerates one typo in tokens of 5+ chars', () => {
    expect(wordSearch(items, groups, 'agnet sdk').map((i) => i.id)).toEqual(['a']);
    expect(wordSearch(items, groups, 'agnt sdk')).toEqual([]); // 4 chars: no typo tolerance
  });
  it('a typo also matches the start of a longer word ("agnet" finds "agents")', () => {
    const long = [item('p', 'Building AI agents in Python'), item('q', 'Agency fees explained')];
    expect(wordSearch(long, [], 'agnet').map((i) => i.id)).toEqual(['p']);
    expect(wordSearch(long, [], 'pythn').map((i) => i.id)).toEqual(['p']); // deletion against "python"
    expect(wordSearch(long, [], 'agnt')).toEqual([]); // 4 chars: still no typo tolerance
    expect(wordSearch(long, [], 'xgents')).toEqual(wordSearch(long, [], 'agents').slice(0, 1)); // substitution
  });
  it('matches by domain and group name, by prefix, ignoring case and diacritics', () => {
    expect(wordSearch(items, groups, 'YouTube').map((i) => i.id)).toEqual(['b']);
    expect(wordSearch(items, groups, 'trav').map((i) => i.id)).toEqual(['c']);
    expect(wordSearch(items, groups, 'cafe munchen').map((i) => i.id)).toEqual(['c']);
  });
  it('returns [] for an empty or symbol-only query', () => {
    expect(wordSearch(items, groups, '')).toEqual([]);
    expect(wordSearch(items, groups, '  -- ')).toEqual([]);
  });
  it('requires every token to match', () => {
    expect(wordSearch(items, groups, 'agent pasta')).toEqual([]);
  });
  it('ranks exact over prefix over typo, then by lastActiveAt', () => {
    const r = wordSearch(
      [
        item('typo', 'Documnt notes', { lastActiveAt: 100 }),
        item('prefix', 'Documentation notes', { lastActiveAt: 50 }),
        item('exactOld', 'Document notes', { lastActiveAt: 10 }),
        item('exactNew', 'Document notes', { lastActiveAt: 20 }),
      ],
      [], 'document',
    );
    expect(r.map((i) => i.id)).toEqual(['exactNew', 'exactOld', 'prefix', 'typo']);
  });
  it('honours the limit and searches only the 5000 most recent items', () => {
    const many = Array.from({ length: 5001 }, (_, k) => item(`i${k}`, 'needle', { lastActiveAt: k + 1 }));
    many.push(item('old', 'needle', { lastActiveAt: 0 }));
    const r = wordSearch(many, [], 'needle', 10_000);
    expect(r).toHaveLength(5000);
    expect(r.some((i) => i.id === 'old')).toBe(false);
    expect(wordSearch(many, [], 'needle', 3)).toHaveLength(3);
  });
});
describe('semanticSearch', () => {
  it('orders by cosine and drops results below min', () => {
    const r = semanticSearch([1, 0], [
      { item: item('far', 'far'), vec: [0, 1] },
      { item: item('mid', 'mid'), vec: [1, 1] },
      { item: item('near', 'near'), vec: [1, 0.1] },
    ]);
    expect(r.map((i) => i.id)).toEqual(['near', 'mid']);
  });
  it('honours the limit', () => {
    const vs = [1, 2, 3].map((k) => ({ item: item(`i${k}`, 'x'), vec: [1, k / 10] }));
    expect(semanticSearch([1, 0], vs, 2)).toHaveLength(2);
  });
});
describe('semanticMinFor', () => {
  it('uses the cut-off measured for each bundled model, and a strict default for unknown ones', async () => {
    const { semanticMinFor } = await import('../../src/search/search');
    const { HEAD } = await import('../../src/classify/head');
    expect(semanticMinFor('Xenova/bge-small-en-v1.5')).toBe(0.55);
    expect(semanticMinFor('Xenova/all-MiniLM-L6-v2')).toBe(0.3);
    expect(semanticMinFor('tablight/bge-small-tabs-v1')).toBe(0.37);
    expect(semanticMinFor('some/other-model')).toBe(0.5);
    // The shipped model has a measured cut-off (not the fallback).
    expect(['tablight/bge-small-tabs-v1', 'Xenova/bge-small-en-v1.5', 'Xenova/all-MiniLM-L6-v2']).toContain(HEAD.model);
  });
});
