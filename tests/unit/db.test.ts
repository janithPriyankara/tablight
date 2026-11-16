import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { DEFAULT_SETTINGS, type Group, type Item, type Snapshot } from '../../src/shared/types';
let n = 0;
let db: Db;
beforeEach(async () => {
  db = await openDb(`test-${n++}`);
});
function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1', url: 'https://a.com/x', normUrl: 'https://a.com/x', title: 'A', domain: 'a.com',
    state: 'open', tabId: 1, windowId: 1, groupId: null, groupSource: 'auto', kind: 'other',
    createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true, ...over,
  };
}
const group: Group = {
  id: 'g1', name: 'G', color: 'blue', icon: 'x', builtIn: false, exemplars: [[1, 2]],
  centroid: [1, 2], createdAt: 1,
};
const snap: Snapshot = { id: 's1', takenAt: 5, windows: [{ tabs: [{ url: 'u', title: 't' }] }] };
describe('db stores', () => {
  it('items round trip and indexes', async () => {
    await db.items.put(item());
    await db.items.put(item({ id: 'i2', tabId: 2, normUrl: 'https://b.com', state: 'sleeping' }));
    await db.items.put(item({ id: 'i3', tabId: undefined, normUrl: 'https://b.com', state: 'stashed' }));
    expect(await db.items.get('i1')).toEqual(item());
    expect((await db.items.byTabId(2))?.id).toBe('i2');
    expect(await db.items.byTabId(99)).toBeUndefined();
    expect((await db.items.byNormUrl('https://b.com')).map((i) => i.id).sort()).toEqual(['i2', 'i3']);
    expect((await db.items.byState('stashed')).map((i) => i.id)).toEqual(['i3']);
    expect(await db.items.all()).toHaveLength(3);
    await db.items.delete('i1');
    expect(await db.items.get('i1')).toBeUndefined();
  });
  it('groups round trip', async () => {
    await db.groups.put(group);
    expect(await db.groups.get('g1')).toEqual(group);
    expect(await db.groups.all()).toEqual([group]);
    await db.groups.delete('g1');
    expect(await db.groups.all()).toEqual([]);
  });
  it('snapshots round trip', async () => {
    await db.snapshots.put(snap);
    expect(await db.snapshots.all()).toEqual([snap]);
    await db.snapshots.delete('s1');
    expect(await db.snapshots.all()).toEqual([]);
  });
  it('embeddings survive as Float32Array', async () => {
    const v = new Float32Array([0.5, -1.25, 3]);
    await db.embeddings.put('k', v);
    const got = await db.embeddings.get('k');
    expect(got).toBeInstanceOf(Float32Array);
    expect(Array.from(got!)).toEqual([0.5, -1.25, 3]);
    expect(await db.embeddings.get('missing')).toBeUndefined();
  });
  it('queue take is oldest-first and non-destructive; remove deletes', async () => {
    for (const id of ['c', 'a', 'b']) await db.queue.add(id);
    expect(await db.queue.take(2)).toEqual(['c', 'a']);
    expect(await db.queue.size()).toBe(3);
    await db.queue.remove(['c', 'a']);
    expect(await db.queue.take(5)).toEqual(['b']);
    expect(await db.queue.size()).toBe(1);
  });
  it('queue take returns nothing for n <= 0 or NaN', async () => {
    await db.queue.add('a');
    await db.queue.add('b');
    expect(await db.queue.take(0)).toEqual([]);
    expect(await db.queue.take(-1)).toEqual([]);
    expect(await db.queue.take(NaN)).toEqual([]);
    expect(await db.queue.take(1.5)).toEqual(['a']);
  });
  it('queue add does not duplicate or reorder', async () => {
    await db.queue.add('a');
    await db.queue.add('b');
    await db.queue.add('a');
    expect(await db.queue.size()).toBe(2);
    expect(await db.queue.take(2)).toEqual(['a', 'b']);
  });
  it('stashBackups keeps last 3, newest first', async () => {
    for (let i = 1; i <= 4; i++) await db.stashBackups.push([item({ id: `b${i}` })]);
    const all = await db.stashBackups.all();
    expect(all).toHaveLength(3);
    expect(all.map((b) => b.items[0]!.id)).toEqual(['b4', 'b3', 'b2']);
  });
  it('settings default and merge', async () => {
    expect(await db.settings.get()).toEqual(DEFAULT_SETTINGS);
    const next = await db.settings.set({ theme: 'dark' });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
    expect(await db.settings.get()).toEqual(next);
  });
  it('tombstones prune only older entries', async () => {
    const now = 100 * 86400000;
    await db.tombstones.put({ id: 'old', deletedAt: now - 31 * 86400000 });
    await db.tombstones.put({ id: 'new', deletedAt: now - 1000 });
    await db.tombstones.prune(now - 30 * 86400000);
    expect((await db.tombstones.all()).map((t) => t.id)).toEqual(['new']);
  });
});
describe('db.tx', () => {
  it('commits across stores atomically', async () => {
    await db.tx(['items', 'queue'], async (t) => {
      await t.items.put(item());
      await t.queue.add('i1');
    });
    expect(await db.items.get('i1')).toBeDefined();
    expect(await db.queue.size()).toBe(1);
  });
  it('rolls back all stores when fn throws', async () => {
    await expect(
      db.tx(['items', 'queue'], async (t) => {
        await t.items.put(item());
        await t.queue.add('i1');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.items.get('i1')).toBeUndefined();
    expect(await db.queue.size()).toBe(0);
  });
});
