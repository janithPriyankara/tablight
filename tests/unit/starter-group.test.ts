// groupCreateStarter (the look-up dialog's "Create <starter> and move"): makes exactly that one starter group and
// changes nothing else: no settings, no stored interests answer, nothing queued, no tab moved.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { REMOVED_TRAINED_KEY, loadRemovedTrained } from '../../src/background/grow';
import { INTERESTS_KEY, createStarterGroup } from '../../src/background/interests';
import { buildStarterGroups } from '../../src/classify/assign';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

const DIM = 384;
let n = 0;
let db: Db;
let mock: ChromeMockControl;
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> =>
  texts.map((_, k) => {
    const v = new Float32Array(DIM);
    v[k % DIM] = 1;
    return v;
  });
const item = (id: string, over: Partial<Item> = {}): Item => {
  const url = `https://${id}.example.com/page`;
  return {
    id, url, normUrl: url, title: `Title ${id}`, domain: `${id}.example.com`, state: 'open', groupId: null,
    groupSource: 'auto', kind: 'other', createdAt: 1, lastActiveAt: 1, updatedAt: 10, classifiable: true, ...over,
  };
};
const userGroup = (id: string, name: string, over: Partial<Group> = {}): Group => ({
  id, name, color: '#0090ff', icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: 1, ...over,
});
async function snapshot() {
  return {
    settings: await db.settings.get(),
    items: (await db.items.all()).sort((a, b) => a.id.localeCompare(b.id)),
    queued: await db.queue.take(10_000),
    interests: (await chrome.storage.local.get(INTERESTS_KEY))[INTERESTS_KEY],
  };
}

beforeEach(async () => {
  db = await openDb(`starter-${n++}`);
  mock = installChromeMock();
  for (const g of await buildStarterGroups(fakeEmbed)) await db.groups.put(g);
  await db.settings.set({ interestsAnswered: false, interestsFresh: true });
  // An auto-placed tab in Movies, a user-placed one in Movies, an Unsorted one.
  await db.items.put(item('auto', { groupId: 'movies', groupSource: 'auto' }));
  await db.items.put(item('mine', { groupId: 'movies', groupSource: 'user' }));
  await db.items.put(item('loose'));
});
afterEach(() => mock.uninstall());

describe('createStarterGroup', () => {
  it('creates exactly the one starter group and nothing else changes (auto-placed tabs stay where they are)', async () => {
    await chrome.storage.local.set({ [REMOVED_TRAINED_KEY]: ['anime', 'sports'] });
    const before = await snapshot();
    const groupsBefore = (await db.groups.all()).map((g) => g.id).sort();
    expect(groupsBefore).not.toContain('anime');
    expect(await createStarterGroup(db, fakeEmbed, 'anime')).toBe('anime');
    expect(await db.groups.get('anime')).toMatchObject({ name: 'Anime & comics', builtIn: true });
    expect((await db.groups.all()).map((g) => g.id).sort()).toEqual([...groupsBefore, 'anime'].sort());
    expect(await snapshot()).toEqual(before);
    expect((await db.settings.get()).interestsAnswered).toBe(false);
    expect((await db.settings.get()).interestsFresh).toBe(true);
    expect((await db.items.get('auto'))!.groupId).toBe('movies');
    expect(await loadRemovedTrained()).toEqual(['sports']);
  });
  it('an existing group with that id: its id, nothing created', async () => {
    const before = await db.groups.all();
    expect(await createStarterGroup(db, fakeEmbed, 'tv')).toBe('tv');
    expect(await db.groups.all()).toEqual(before);
  });
  it('a same-named user group: that group’s id; it is not adopted or renamed', async () => {
    await db.groups.put(userGroup('u1', 'anime & COMICS'));
    const before = await snapshot();
    expect(await createStarterGroup(db, fakeEmbed, 'anime')).toBe('u1');
    expect(await db.groups.get('anime')).toBeUndefined();
    expect(await db.groups.get('u1')).toMatchObject({ name: 'anime & COMICS', builtIn: false });
    expect(await snapshot()).toEqual(before);
  });
  it('a built-in group holding the name: an error, nothing created', async () => {
    const tv = (await db.groups.get('tv'))!;
    await db.groups.put({ ...tv, name: 'Anime & comics' });
    await expect(createStarterGroup(db, fakeEmbed, 'anime')).rejects.toThrow(/already exists/);
    expect(await db.groups.get('anime')).toBeUndefined();
  });
  it('refuses ids that are not starter choices', async () => {
    for (const id of ['other', 'bogus', '', 42, null, { id: 'anime' }]) {
      await expect(createStarterGroup(db, fakeEmbed, id), String(id)).rejects.toThrow('unknown starter group');
    }
  });
});
