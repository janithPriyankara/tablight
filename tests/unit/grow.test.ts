import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { deleteGroup } from '../../src/background/groups';
import { GROW_MIN, REMOVED_TRAINED_KEY, growGroups, loadRemovedTrained } from '../../src/background/grow';
import { TRAINED_IDS } from '../../src/classify/assign';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

const DIM = 384;
let n = 0;
let db: Db;
let mock: ChromeMockControl;
let embedCalls: string[][];
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  embedCalls.push(texts);
  return texts.map((_, k) => {
    const v = new Float32Array(DIM);
    v[k % DIM] = 1;
    return v;
  });
};
const group = (id: string, over: Partial<Group> = {}): Group => ({
  id, name: id, color: '#0090ff', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 1, ...over,
});
let seq = 0;
async function addItem(over: Partial<Item> = {}): Promise<Item> {
  const k = seq++;
  const url = over.url ?? `https://site${k}.example.com/page`;
  const item: Item = {
    id: `i${k}`, url, normUrl: url, title: `Title ${k}`, domain: `site${k}.example.com`, state: 'open',
    groupId: null, groupSource: 'auto', kind: 'other', createdAt: k, lastActiveAt: k, updatedAt: 10,
    classifiable: true, ...over,
  };
  await db.items.put(item);
  return item;
}
beforeEach(async () => {
  db = await openDb(`grow-${n++}`);
  mock = installChromeMock();
  embedCalls = [];
  await db.groups.put(group('videos', { name: 'YouTube / Videos' }));
});
afterEach(() => mock.uninstall());

describe('growGroups', () => {
  it('GROW_MIN is 2 and hardware is a trained on-demand id', () => {
    expect(GROW_MIN).toBe(2);
    expect(TRAINED_IDS.has('hardware')).toBe(true);
  });

  it('creates the wanted trained group once two auto tabs want it, and moves them in', async () => {
    const a = await addItem({ groupId: 'videos', want: 'hardware', url: 'https://www.youtube.com/watch?v=x' });
    const b = await addItem({ want: 'hardware' });
    const other = await addItem({ want: 'sports' }); // only one: stays
    const made = await growGroups(db, fakeEmbed, 5000);
    expect(made.map((g) => g.id)).toEqual(['hardware']);
    const g = (await db.groups.get('hardware'))!;
    expect(g).toMatchObject({ id: 'hardware', name: 'Hardware & making', builtIn: true, grownAt: 5000 });
    expect(g.centroid).not.toBeNull();
    for (const id of [a.id, b.id]) {
      const i = (await db.items.get(id))!;
      expect(i.groupId).toBe('hardware');
      expect(i.groupSource).toBe('auto');
      expect(i.want).toBeUndefined();
      expect(i.updatedAt).toBe(5000); // a group change is a real change
    }
    expect((await db.items.get(other.id))!).toMatchObject({ groupId: null, want: 'sports' });
    expect(await db.groups.get('sports')).toBeUndefined();
    // A second pass has nothing left to do and embeds nothing.
    embedCalls = [];
    expect(await growGroups(db, fakeEmbed, 6000)).toEqual([]);
    expect(embedCalls).toEqual([]);
  });

  it('does nothing for one auto tab plus one user-placed tab, and never moves the user-placed one', async () => {
    await addItem({ want: 'hardware' });
    const u = await addItem({ want: 'hardware', groupSource: 'user', groupId: 'videos' });
    expect(await growGroups(db, fakeEmbed)).toEqual([]);
    expect(await db.groups.get('hardware')).toBeUndefined();
    expect((await db.items.get(u.id))!.groupId).toBe('videos');
    expect(embedCalls).toEqual([]); // nothing to grow: the model is not run
  });

  it('ignores stale wants: items in another group, and wants that are not trained ids', async () => {
    await db.groups.put(group('news'));
    await addItem({ want: 'hardware', groupId: 'news' }); // moved by a regroup since; want is stale
    await addItem({ want: 'hardware' });
    await addItem({ want: 'news' }); // an installed group, not on-demand
    await addItem({ want: 'news' });
    await addItem({ want: 'nope' });
    await addItem({ want: 'nope' });
    expect(await growGroups(db, fakeEmbed)).toEqual([]);
    expect((await db.groups.all()).map((g) => g.id).sort()).toEqual(['news', 'videos']);
  });

  it('never re-creates a trained group the user removed', async () => {
    await chrome.storage.local.set({ [REMOVED_TRAINED_KEY]: ['hardware'] });
    await addItem({ want: 'hardware' });
    await addItem({ want: 'hardware' });
    expect(await growGroups(db, fakeEmbed)).toEqual([]);
    expect(await db.groups.get('hardware')).toBeUndefined();
  });

  it('does not grow a group whose name a user group already has', async () => {
    await db.groups.put(group('g-mine', { name: 'hardware & MAKING', builtIn: false }));
    await addItem({ want: 'hardware' });
    await addItem({ want: 'hardware' });
    expect(await growGroups(db, fakeEmbed)).toEqual([]);
    expect(await db.groups.get('hardware')).toBeUndefined();
  });

  it('skips items taken meanwhile and an existing group (re-checked inside the write)', async () => {
    const a = await addItem({ want: 'hardware' });
    await addItem({ want: 'hardware' });
    const racing = async (texts: string[]): Promise<Float32Array[]> => {
      const out = await fakeEmbed(texts);
      // While the seeds embed, the user moves one of the tabs.
      await db.items.put({ ...(await db.items.get(a.id))!, groupId: 'videos', groupSource: 'user' });
      return out;
    };
    expect(await growGroups(db, racing)).toEqual([]); // one tab left: below GROW_MIN, nothing created
    expect(await db.groups.get('hardware')).toBeUndefined();
    expect((await db.items.get(a.id))!.groupSource).toBe('user');
  });
});

describe('deleteGroup of a trained on-demand group', () => {
  it('records its id; its tabs go back to the classifier and the next pass does not re-grow it', async () => {
    await addItem({ want: 'hardware' });
    await addItem({ want: 'hardware' });
    await growGroups(db, fakeEmbed);
    const members = (await db.items.all()).filter((i) => i.groupId === 'hardware');
    expect(members).toHaveLength(2);
    await deleteGroup(db, 'hardware');
    expect(await loadRemovedTrained()).toEqual(['hardware']);
    expect((await db.queue.take(10)).sort()).toEqual(members.map((i) => i.id).sort()); // re-classified
    // The classifier would want hardware again for them.
    for (const m of members) await db.items.put({ ...(await db.items.get(m.id))!, want: 'hardware' });
    expect(await growGroups(db, fakeEmbed)).toEqual([]);
    expect(await db.groups.get('hardware')).toBeUndefined();
  });

  it('does not record an installed or user group', async () => {
    await db.groups.put(group('news'));
    await deleteGroup(db, 'news');
    await deleteGroup(db, 'videos');
    expect(await loadRemovedTrained()).toEqual([]);
  });
});
