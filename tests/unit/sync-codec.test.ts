import { describe, expect, it } from 'vitest';
import {
  META_KEY, TOMB_TTL_MS, decodeChunks, encodeChunks, merge, mergedView, sha1hex, toRecord, verifyIds,
  type SyncRecord, type Tomb,
} from '../../src/sync/sync-codec';
import type { Item } from '../../src/shared/types';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const hex = (k: number) => k.toString(16).padStart(40, '0');
const bytes = (s: string) => new TextEncoder().encode(s).length;
const size = (k: string, v: unknown) => bytes(k) + bytes(JSON.stringify(v));

/** k records, record k stashed at NOW - k minutes (so lower k = newer); titles are long and partly non-ASCII. */
function recs(count: number, from = 0): SyncRecord[] {
  return Array.from({ length: count }, (_, j) => {
    const k = from + j;
    return [hex(k), `https://site${k}.example.com/some/path/${k}?q=${k}`, `Título número ${k} — ${'x'.repeat(40)}`,
      k % 3 ? 'Programming' : '', NOW - k * 60_000, NOW - k * 60_000];
  });
}

function item(p: Partial<Item>): Item {
  return {
    id: hex(1), url: 'https://a.com/x', normUrl: 'https://a.com/x', title: 'A', domain: 'a.com', state: 'stashed',
    groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, stashedAt: 5, updatedAt: 7,
    classifiable: true, ...p,
  };
}

describe('toRecord', () => {
  it('maps an item and truncates the title to 80 characters without splitting a surrogate pair', () => {
    expect(toRecord(item({}), 'News')).toEqual([hex(1), 'https://a.com/x', 'A', 'News', 5, 7]);
    const long = toRecord(item({ title: 'a'.repeat(79) + '😀' + 'b'.repeat(10) }), '');
    expect(long[2]).toBe('a'.repeat(79));
    expect(toRecord(item({ title: 'z'.repeat(300) }), '')[2]).toHaveLength(80);
  });
});

describe('encodeChunks', () => {
  it('every chunk is ≤ 8,000 bytes (key + JSON) and the total is ≤ 90,000', () => {
    const { chunks } = encodeChunks(recs(3000), [], 90_000, 8_000, NOW);
    let total = 0;
    for (const [k, v] of Object.entries(chunks)) {
      expect(k).toMatch(/^v1:\d+$/);
      expect(size(k, v)).toBeLessThanOrEqual(8_000);
      total += size(k, v);
    }
    expect(total).toBeLessThanOrEqual(90_000);
    expect(Object.keys(chunks).length).toBeGreaterThan(5);
  });

  it('3,000 records: localOnly is non-empty and included holds the newest', () => {
    const all = recs(3000);
    const { included, localOnly } = encodeChunks([...all].reverse(), [], 90_000, 8_000, NOW);
    expect(localOnly.length).toBeGreaterThan(0);
    expect(included.length + localOnly.length).toBe(3000);
    expect(included).toEqual(all.slice(0, included.length).map((r) => r[0]));
  });

  it('removing 500 records promotes previously local-only items, newest first', () => {
    const all = recs(3000);
    const before = encodeChunks(all, [], 90_000, 8_000, NOW);
    const rest = all.slice(500);
    const after = encodeChunks(rest, [], 90_000, 8_000, NOW);
    const promoted = after.included.filter((id) => before.localOnly.includes(id));
    expect(promoted.length).toBeGreaterThan(0);
    const stillHere = new Set(rest.map((r) => r[0]));
    expect(promoted).toEqual(before.localOnly.filter((id) => stillHere.has(id)).slice(0, promoted.length));
    expect(after.included).toEqual(all.slice(500, 500 + after.included.length).map((r) => r[0]));
  });

  it('round-trips through decodeChunks', () => {
    const r = recs(50);
    const tombs: Tomb[] = [[hex(9999), NOW - DAY]];
    const { chunks } = encodeChunks(r, tombs, 90_000, 8_000, NOW);
    const out = decodeChunks({ ...chunks, [META_KEY]: { chunks: Object.keys(chunks).length, updatedAt: NOW } });
    expect(out.recs).toEqual(r);
    expect(out.tombs).toEqual(tombs);
  });

  it('tombstones go first, capped at 75% of the budget; records fill the rest', () => {
    const tombs: Tomb[] = Array.from({ length: 3000 }, (_, k) => [hex(100_000 + k), NOW - k * 1000]);
    const { chunks, included, localOnly } = encodeChunks(recs(2000), tombs, 90_000, 8_000, NOW);
    const out = decodeChunks(chunks);
    const tombBytes = out.tombs.reduce((n, t) => n + bytes(JSON.stringify(JSON.stringify(t))) - 1, 0);
    expect(tombBytes).toBeLessThanOrEqual(0.75 * 90_000);
    expect(tombBytes).toBeGreaterThan(0.7 * 90_000);
    expect(out.tombs.map((t) => t[0])).toEqual(tombs.slice(0, out.tombs.length).map((t) => t[0])); // newest first
    expect(included.length).toBeGreaterThan(50);
    expect(localOnly.length).toBeGreaterThan(0);
  });

  it('drops records killed by an encoded tombstone, keeps those whose tombstone did not fit', () => {
    const r = recs(3);
    const { included } = encodeChunks(r, [[hex(0), NOW], [hex(1), r[1]![5] - 1]], 90_000, 8_000, NOW);
    expect(included).toEqual([hex(1), hex(2)]);
    const many: Tomb[] = Array.from({ length: 3000 }, (_, k) => [hex(100_000 + k), NOW]);
    const oldTomb: Tomb = [hex(2), NOW - 1]; // older than all the others: does not fit
    const res = encodeChunks(r, [...many, oldTomb], 90_000, 8_000, NOW);
    expect(res.included).toContain(hex(2));
  });

  it('prunes tombs older than 30 days', () => {
    const tombs: Tomb[] = [[hex(1), NOW - TOMB_TTL_MS - 1], [hex(2), NOW - TOMB_TTL_MS + 1000]];
    const { chunks } = encodeChunks([], tombs, 90_000, 8_000, NOW);
    expect(decodeChunks(chunks).tombs).toEqual([[hex(2), NOW - TOMB_TTL_MS + 1000]]);
  });
});

describe('decodeChunks', () => {
  it('ignores garbage keys/values, __proto__ keys and non-arrays without throwing', () => {
    const good = encodeChunks(recs(2), [], 90_000, 8_000, NOW).chunks['v1:0']!;
    const store = JSON.parse(`{"__proto__": {"polluted": true}, "v1:meta": {"chunks": 6, "updatedAt": 1}}`) as Record<string, unknown>;
    Object.assign(store, {
      'v1:0': good, 'v1:1': '{not json', 'v1:2': 42, 'v1:3': JSON.stringify({ a: 1 }),
      'v1:4': JSON.stringify([[1, 2, 3], null, 'x', ['__proto__', 5], [hex(3), 'javascript:alert(1)', 't', '', 1, 1]]),
      'v1:5': JSON.stringify([[hex(4), 'https://ok.com/', 7, '', 1, 1], [hex(5), 'https://ok.com/', 't', '', NaN, 1]]),
      other: 'x', 'v2:0': good,
    });
    let out!: ReturnType<typeof decodeChunks>;
    expect(() => (out = decodeChunks(store))).not.toThrow();
    expect(out.recs.map((r) => r[0])).toEqual([hex(0), hex(1)]);
    expect(out.tombs).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(decodeChunks(null as unknown as Record<string, unknown>)).toEqual({ recs: [], tombs: [] });
    expect(decodeChunks({ 'v1:meta': 'x', 'v1:0': [[hex(1)]] })).toEqual({ recs: [], tombs: [] });
  });

  it('drops javascript:/oversized urls, truncates titles, keeps (raw) future timestamps within a year unchanged', () => {
    const chunk = JSON.stringify([
      [hex(1), 'javascript:alert(1)', 't', '', 1, 1],
      [hex(2), `https://a.com/${'p'.repeat(2100)}`, 't', '', 1, 1],
      [hex(3), 'https://b.com/', 'T'.repeat(500), 'G'.repeat(61), 1, NOW + 364 * DAY],
      [hex(4), 'data:text/html,hi', 't', '', 1, 1],
      ['not-hex', 'https://c.com/', 't', '', 1, 1],
      [hex(5), NOW + 300 * DAY],
    ]);
    const out = decodeChunks({ 'v1:0': chunk }, NOW);
    expect(out.recs).toEqual([[hex(3), 'https://b.com/', 'T'.repeat(80), '', 1, NOW + 364 * DAY]]);
    expect(out.tombs).toEqual([[hex(5), NOW + 300 * DAY]]);
    // Re-encoding keeps the raw value: two passes never drift.
    const again = decodeChunks(encodeChunks(out.recs, out.tombs, 90_000, 8_000, NOW).chunks, NOW);
    expect(again).toEqual(out);
  });
});

describe('verifyIds', () => {
  it('keeps only records whose id is sha1hex(normUrl)', async () => {
    const id = await sha1hex('https://a.com/');
    const r: SyncRecord[] = [[id, 'https://a.com/', 'A', '', 1, 1], [hex(1), 'https://b.com/', 'B', '', 1, 1]];
    expect(await verifyIds(r)).toEqual([r[0]]);
  });
});

describe('merge', () => {
  const rec = (k: number, updatedAt: number, title = 't'): SyncRecord => [hex(k), `https://s${k}.com/`, title, '', 1, updatedAt];

  it('remote newer updatedAt wins; local newer is not overwritten', () => {
    const m = merge([rec(1, 10, 'old'), rec(2, 30, 'mine')], [], [rec(1, 20, 'new'), rec(2, 25, 'theirs')], []);
    expect(m.upserts).toEqual([rec(1, 20, 'new')]);
    expect(m.deletes).toEqual([]);
  });

  it('a tomb newer than the record deletes it (local or remote tomb)', () => {
    expect(merge([rec(1, 10)], [], [], [[hex(1), 15]]).deletes).toEqual([hex(1)]);
    expect(merge([rec(1, 10)], [], [], [[hex(1), 10]]).deletes).toEqual([hex(1)]); // tie: tomb wins
    const m = merge([], [[hex(2), 50]], [rec(2, 40)], []);
    expect(m.upserts).toEqual([]); // a remote record older than our own tomb is not re-added
    expect(m.tombs).toEqual([[hex(2), 50]]);
  });

  it('a record newer than the tomb survives', () => {
    const m = merge([rec(1, 20)], [], [], [[hex(1), 15]]);
    expect(m.deletes).toEqual([]);
    const r = merge([], [[hex(2), 15]], [rec(2, 20)], []);
    expect(r.upserts).toEqual([rec(2, 20)]);
  });

  it('a local item absent remotely without a tomb is kept', () => {
    const m = merge([rec(1, 10)], [], [rec(2, 10)], []);
    expect(m.deletes).toEqual([]);
    expect(m.upserts).toEqual([rec(2, 10)]);
    expect(mergedView([rec(1, 10)], [rec(2, 10)]).map((r) => r[0]).sort()).toEqual([hex(1), hex(2)]);
  });

  it('mergedView prefers the remote copy on a tie', () => {
    const v = mergedView([rec(1, 10, 'local'), rec(2, 10)], [rec(1, 10, 'remote')]);
    expect(v).toEqual([rec(1, 10, 'remote'), rec(2, 10)]);
  });

  it('a tombstone superseded by a newer record (re-stash) stays in the union until its TTL', () => {
    expect(merge([rec(1, 20)], [], [], [[hex(1), 15]])).toEqual({ upserts: [], deletes: [], tombs: [[hex(1), 15]] });
    expect(merge([], [], [rec(1, 20)], [[hex(1), 15]]).tombs).toEqual([[hex(1), 15]]);
    expect(merge([rec(1, 10)], [[hex(1), 15]], [], []).tombs).toEqual([[hex(1), 15]]);
  });
});
describe('hostile sync data', () => {
  it('ignores records and tombstones dated more than a year ahead (they would never expire)', () => {
    const now = 1_800_000_000_000;
    const far = now + 400 * 86_400_000;
    const soon = now + 3 * 86_400_000; // a device with a fast clock is still accepted
    const store = { 'v1:0': JSON.stringify([['a'.repeat(40), far], ['b'.repeat(40), soon]]) };
    expect(decodeChunks(store, now).tombs).toEqual([['b'.repeat(40), soon]]);
  });
});
