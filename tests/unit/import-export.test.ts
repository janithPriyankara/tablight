import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { applyImport, exportJson, parseImport, type ImportData } from '../../src/io/import-export';
import { sha1hex } from '../../src/shared/hash';
import { normalizeUrl } from '../../src/shared/url';
import type { Group, Item } from '../../src/shared/types';
let n = 0;
let db: Db;
beforeEach(async () => {
  db = await openDb(`io-${n++}`);
});
const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'tab-organizer', version: 1, exportedAt: 1, groups: [], items: [], snapshots: [], ...over });
const ok = (json: string): ImportData => {
  const r = parseImport(json);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const group = (id: string, name: string, extra: Partial<Group> = {}): Group => ({
  id, name, color: '#0090ff', icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: 1, ...extra,
});
async function stashed(url: string, groupId: string | null, source: 'auto' | 'user' = 'user', stashedAt = 1000): Promise<Item> {
  const normUrl = normalizeUrl(url);
  const item: Item = {
    id: await sha1hex(normUrl), url, normUrl, title: `T ${url}`, domain: 'x', state: 'stashed', groupId, groupSource: source,
    kind: 'read', createdAt: stashedAt, lastActiveAt: stashedAt, stashedAt, updatedAt: stashedAt, classifiable: true,
  };
  await db.items.put(item);
  return item;
}
describe('parseImport', () => {
  it('rejects input over 20 MB, too many items, wrong format/version and non-JSON', () => {
    expect(parseImport('x'.repeat(20 * 1024 * 1024 + 1)).ok).toBe(false);
    expect(parseImport('é'.repeat(11 * 1024 * 1024)).ok).toBe(false); // 2 bytes each in UTF-8
    const many = Array.from({ length: 50_001 }, () => ({ url: 'https://a.com/' }));
    expect(parseImport(file({ items: many })).ok).toBe(false);
    expect(parseImport(file({ format: 'other' })).ok).toBe(false);
    expect(parseImport(file({ version: 2 })).ok).toBe(false);
    expect(parseImport('not json').ok).toBe(false);
    expect(parseImport('[]').ok).toBe(false);
    expect(parseImport('null').ok).toBe(false);
    expect(parseImport(file({ items: 'x' })).ok).toBe(false);
  });
  it('skips unsafe urls and items with non-string fields', () => {
    const items = [
      { url: 'javascript:alert(1)' }, { url: 'data:text/html,hi' }, { url: 'file:///etc/passwd' },
      { url: 'https://user:pw@a.com/' }, { url: 5 }, { url: 'https://t.com/', title: 5 },
      { url: 'https://g.com/', groupName: 7 }, null, 'str', { url: 'https://ok.com/', title: 'Fine' },
    ];
    const d = ok(file({ items }));
    expect(d.items.map((i) => i.url)).toEqual(['https://ok.com/']);
  });
  it('does not pollute Object.prototype', () => {
    const json = '{"format":"tab-organizer","version":1,"__proto__":{"polluted":1},"items":[{"url":"https://a.com/","__proto__":{"polluted":2}}]}';
    expect(parseImport(json).ok).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('truncates titles, strips control characters, validates group names and clamps stashedAt', () => {
    const d = ok(file({ items: [
      { url: 'https://a.com/', title: 'x'.repeat(5000) },
      { url: 'https://b.com/', title: 'a\u0000b\u0007c', groupName: '  Work ', stashedAt: 9e15 },
      { url: 'https://c.com/', groupName: 'g'.repeat(61), stashedAt: -5 },
      { url: 'https://d.com/', stashedAt: 'soon' },
    ] }));
    expect(d.items[0]!.title).toHaveLength(1000);
    expect(d.items[1]).toMatchObject({ title: 'abc', groupName: 'Work' });
    expect(d.items[1]!.stashedAt).toBeLessThanOrEqual(Date.now());
    expect(d.items[2]).toMatchObject({ groupName: null, stashedAt: 0 });
    expect(d.items[3]!.stashedAt).toBeNull();
  });
  it('validates group colour and icon against the palette and icon set', () => {
    const d = ok(file({ groups: [
      { name: 'A', color: '#30a46c', icon: '🎬' }, { name: 'B', color: 'red', icon: '<script>' }, { name: '' }, { name: 3 },
    ] }));
    expect(d.groups).toEqual([{ name: 'A', color: '#30a46c', icon: '🎬' }, { name: 'B', color: null, icon: null }]);
  });
  it('rejects 10,000 nested levels without overflowing the stack', () => {
    const deep = `{"format":"tab-organizer","version":1,"items":${'['.repeat(10_000)}${']'.repeat(10_000)}}`;
    expect(parseImport(deep).ok).toBe(false);
    expect(parseImport(file({ items: [{ url: 'https://a.com/', title: '[[[[' }] })).ok).toBe(true); // brackets in strings do not count
  });
  it('keeps only safe snapshot tabs', () => {
    const d = ok(file({ snapshots: [
      { takenAt: 5, windows: [{ tabs: [{ url: 'https://a.com/', title: 'A' }, { url: 'javascript:1', title: 'x' }] }] },
      { takenAt: 6, windows: [{ tabs: [{ url: 'file:///x' }] }] },
      { takenAt: 'x', windows: [] },
    ] }));
    expect(d.snapshots).toHaveLength(1);
    expect(d.snapshots[0]!.windows[0]!.tabs).toEqual([{ url: 'https://a.com/', title: 'A' }]);
  });
});
describe('export / import round trip', () => {
  it('exports only stashed items, non-suggested groups and snapshots', async () => {
    await db.groups.put(group('g1', 'Work'));
    await db.groups.put(group('g2', 'Maybe', { suggested: true }));
    await stashed('https://a.com/', 'g1');
    await db.items.put({ ...(await stashed('https://open.com/', null)), id: 'open1', state: 'open', tabId: 3 });
    await db.items.delete(await sha1hex(normalizeUrl('https://open.com/')));
    await db.snapshots.put({ id: 's1', takenAt: 5, windows: [{ tabs: [{ url: 'https://a.com/', title: 'A' }] }] });
    await db.settings.set({ onboarded: true });
    const out = JSON.parse(await exportJson(db));
    expect(out.format).toBe('tab-organizer');
    expect(out.version).toBe(1);
    expect(out.groups.map((g: Group) => g.name)).toEqual(['Work']);
    expect(out.items).toEqual([{ url: 'https://a.com/', title: 'T https://a.com/', groupName: 'Work', state: 'stashed', stashedAt: 1000 }]);
    expect(out.snapshots).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/embedding|exemplars|centroid|settings|onboarded/);
  });
  it('recreates the stash on a fresh db and is idempotent', async () => {
    await db.groups.put(group('g1', 'Work', { color: '#30a46c', icon: '💼' }));
    await stashed('https://a.com/x?utm_source=q', 'g1');
    await stashed('https://b.com/', null, 'auto');
    await db.snapshots.put({ id: 's1', takenAt: 5, windows: [{ tabs: [{ url: 'https://a.com/', title: 'A' }] }] });
    const json = await exportJson(db);
    const fresh = await openDb(`io-fresh-${n++}`);
    expect(await applyImport(fresh, ok(json))).toEqual({ added: 2, skipped: 0, skippedSessions: 0 });
    const items = await fresh.items.byState('stashed');
    expect(items.map((i) => i.normUrl).sort()).toEqual((await db.items.all()).map((i) => i.normUrl).sort());
    const a = items.find((i) => i.url.includes('a.com'))!;
    const g = (await fresh.groups.all()).find((x) => x.name === 'Work')!;
    expect(a).toMatchObject({ groupId: g.id, groupSource: 'user', stashedAt: 1000 });
    expect(g).toMatchObject({ builtIn: false, color: '#30a46c', icon: '💼' });
    expect(g.id).not.toBe('g1');
    const b = items.find((i) => i.url.includes('b.com'))!;
    expect(b).toMatchObject({ groupId: null, groupSource: 'auto' });
    expect(await fresh.queue.take(10)).toEqual([b.id]);
    expect(await fresh.snapshots.all()).toHaveLength(1);
    expect(await applyImport(fresh, ok(json))).toEqual({ added: 0, skipped: 2, skippedSessions: 0 });
    expect(await fresh.snapshots.all()).toHaveLength(1);
    expect((await fresh.groups.all()).filter((x) => x.name === 'Work')).toHaveLength(1);
    expect((await fresh.items.get(a.id))!.updatedAt).toBe(a.updatedAt);
  });
});
describe('applyImport', () => {
  it('keeps a user group over the file group, never downgrades, and de-dups within the file', async () => {
    await db.groups.put(group('mine', 'Mine'));
    const prev = await stashed('https://a.com/', 'mine', 'user', 500);
    const r = await applyImport(db, ok(file({ items: [
      { url: 'https://a.com/?utm_x=1', title: 'New', groupName: 'Theirs', stashedAt: 100 },
      { url: 'https://c.com/', groupName: 'Theirs' }, { url: 'https://c.com/#frag', groupName: 'Other' },
    ] })));
    expect(r).toEqual({ added: 1, skipped: 2, skippedSessions: 0 });
    expect(await db.items.get(prev.id)).toEqual(prev);
  });
  it('applies the file group to an unclassified existing record and clears its tombstone', async () => {
    const prev = await stashed('https://a.com/', null, 'auto', 500);
    await db.tombstones.put({ id: prev.id, deletedAt: 9000 });
    await applyImport(db, ok(file({ items: [{ url: 'https://a.com/', groupName: 'Work', stashedAt: 200 }] })));
    const cur = (await db.items.get(prev.id))!;
    expect(cur.groupSource).toBe('user');
    expect(cur.groupId).toBe((await db.groups.all()).find((g) => g.name === 'Work')!.id);
    expect(cur.stashedAt).toBe(200);
    expect(cur.updatedAt).toBeGreaterThan(prev.updatedAt);
    expect(await db.tombstones.get(prev.id)).toBeUndefined();
  });
  it('matches group names case-insensitively and ignores suggested groups', async () => {
    await db.groups.put(group('g1', 'Work'));
    await db.groups.put(group('s1', 'Reading', { suggested: true }));
    await applyImport(db, ok(file({ items: [{ url: 'https://a.com/', groupName: 'WORK' }, { url: 'https://b.com/', groupName: 'reading' }] })));
    const names = (await db.groups.all()).map((g) => g.name).sort();
    expect(names).toEqual(['Reading', 'Work', 'reading']);
    const a = (await db.items.all()).find((i) => i.url.includes('a.com'))!;
    expect(a.groupId).toBe('g1');
  });
  it('creates at most 200 new groups', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ url: `https://h${i}.com/`, groupName: `G${i}` }));
    await applyImport(db, ok(file({ items })));
    expect(await db.groups.all()).toHaveLength(200);
    expect(await db.items.all()).toHaveLength(250);
  });
  it('skips identical snapshots, assigns fresh ids, never deletes local ones: file sessions fill free slots only', async () => {
    const snap = (id: string, t: number, u: string) => ({ id, takenAt: t, windows: [{ tabs: [{ url: u, title: u }] }] });
    for (let i = 0; i < 10; i++) await db.snapshots.put(snap(`old${i}`, 100 + i, `https://e${i}.com/`));
    const incoming = [snap('same', 999, 'https://e9.com/'), ...Array.from({ length: 8 }, (_, i) => snap(`f${i}`, 200 + i, `https://f${i}.com/`))];
    const r = await applyImport(db, ok(file({ snapshots: incoming })));
    expect(r).toEqual({ added: 0, skipped: 0, skippedSessions: 4 });
    const all = await db.snapshots.all();
    expect(all).toHaveLength(14);
    const url = (s: { windows: { tabs: { url: string }[] }[] }) => s.windows[0]!.tabs[0]!.url;
    expect(all.some((s) => incoming.some((x) => x.id === s.id))).toBe(false); // fresh ids
    expect(all.filter((s) => url(s) === 'https://e9.com/')).toHaveLength(1);
    expect(all.filter((s) => s.id.startsWith('old'))).toHaveLength(10); // every local session kept
    expect(all.filter((s) => url(s).includes('//f')).map(url).sort()).toEqual(
      ['https://f4.com/', 'https://f5.com/', 'https://f6.com/', 'https://f7.com/'], // the newest file sessions
    );
  });
  it('a full local session list takes no file sessions and deletes none', async () => {
    const snap = (id: string, t: number, u: string) => ({ id, takenAt: t, windows: [{ tabs: [{ url: u, title: u }] }] });
    for (let i = 0; i < 14; i++) await db.snapshots.put(snap(`old${i}`, 100 + i, `https://e${i}.com/`));
    const r = await applyImport(db, ok(file({ snapshots: [snap('new', 9_999, 'https://n.com/')] })));
    expect(r.skippedSessions).toBe(1);
    expect((await db.snapshots.all()).every((s) => s.id.startsWith('old'))).toBe(true);
  });
});
