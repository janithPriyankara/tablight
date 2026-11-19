import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { MIRRORED_KEY } from '../../src/background/groups';
import { REMOVED_TRAINED_KEY, loadRemovedTrained } from '../../src/background/grow';
import { INTERESTS_KEY, applyInterests } from '../../src/background/interests';
import { buildStarterGroups, TRAINED_IDS } from '../../src/classify/assign';
import { INTEREST_CHOICES, STARTER_GROUPS } from '../../src/classify/seeds';
import type { Group, Item } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
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
const userGroup = (id: string, name: string, over: Partial<Group> = {}): Group => ({
  id, name, color: '#0090ff', icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: 1, ...over,
});
/** Queued item ids (take does not remove). */
const queued = async (): Promise<string[]> => (await db.queue.take(10_000)).sort();
const ids = async (): Promise<string[]> => (await db.groups.all()).map((g) => g.id).sort();

beforeEach(async () => {
  db = await openDb(`interests-${n++}`);
  mock = installChromeMock();
  for (const g of await buildStarterGroups(fakeEmbed)) await db.groups.put(g); // the install set
});
afterEach(() => mock.uninstall());

describe('INTEREST_CHOICES', () => {
  it('lists the 17 installed groups and the 14 trained ones in seeds order, never Other', () => {
    expect(INTEREST_CHOICES).toHaveLength(31);
    expect(INTEREST_CHOICES.map((c) => c.id)).toEqual(STARTER_GROUPS.filter((g) => g.id !== 'other').map((g) => g.id));
    expect(INTEREST_CHOICES[0]).toEqual({ id: 'movies', name: 'Movies' });
    expect(INTEREST_CHOICES.filter((c) => TRAINED_IDS.has(c.id))).toHaveLength(14);
  });
});

describe('settings', () => {
  it('interestsAnswered defaults to false; an upgrade reads false and keeps onboarded', async () => {
    expect(DEFAULT_SETTINGS.interestsAnswered).toBe(false);
    await db.settings.set({ onboarded: true });
    // An older install's stored settings lack the key entirely.
    const s = await db.settings.get();
    expect(s.interestsAnswered).toBe(false);
    expect(s.onboarded).toBe(true);
  });
});

describe('applyInterests', () => {
  it('creates picked trained groups, forgets that they were removed, and marks the step answered', async () => {
    await chrome.storage.local.set({ [REMOVED_TRAINED_KEY]: ['hardware', 'sports'] });
    const r = await applyInterests(db, fakeEmbed, { picked: ['hardware', 'movies', 'bogus', 'other'], custom: [] }, false);
    expect(r.created).toEqual(['hardware']);
    expect(r.removed).toEqual([]);
    expect(await db.groups.get('hardware')).toMatchObject({ name: 'Hardware & making', builtIn: true });
    expect(await db.groups.get('bogus')).toBeUndefined();
    expect(await loadRemovedTrained()).toEqual(['sports']);
    expect((await db.settings.get()).interestsAnswered).toBe(true);
    const stored = (await chrome.storage.local.get(INTERESTS_KEY))[INTERESTS_KEY];
    expect(stored).toEqual({ picked: ['hardware', 'movies'], custom: [] });
  });

  it('re-creates a picked installed group the user deleted', async () => {
    await db.groups.delete('movies');
    const r = await applyInterests(db, fakeEmbed, { picked: ['movies'], custom: [] }, false);
    expect(r.created).toEqual(['movies']);
    expect(await db.groups.get('movies')).toMatchObject({ name: 'Movies', builtIn: true });
  });

  it('not fresh: removes nothing and never touches existing groups', async () => {
    const before = await ids();
    const r = await applyInterests(db, fakeEmbed, { picked: ['sports'], custom: [] }, false);
    expect(r.removed).toEqual([]);
    expect(await ids()).toEqual([...before, 'sports'].sort());
  });

  it('fresh: removes unpicked installed groups nobody touched, re-queues their auto tabs, keeps touched ones', async () => {
    // movies: renamed. tv: holds a user-placed tab. music: mirrored as a native tab group. design: taught.
    await db.groups.put({ ...(await db.groups.get('movies'))!, name: 'Films' });
    const userTv = await addItem({ groupId: 'tv', groupSource: 'user' });
    await chrome.storage.session.set({ [MIRRORED_KEY]: { 7: 'music' } });
    await db.groups.put({ ...(await db.groups.get('design'))!, exemplars: [[1, 0]] });
    const autoNews = await addItem({ groupId: 'news' });
    const stashedNews = await addItem({ groupId: 'news', state: 'stashed' });

    const r = await applyInterests(db, fakeEmbed, { picked: ['ai', 'programming', 'hardware'], custom: [] }, true);

    const kept = ['movies', 'tv', 'music', 'design', 'ai', 'programming', 'hardware', 'other'];
    expect(await ids()).toEqual(kept.sort());
    const installedIds = STARTER_GROUPS.filter((g) => !g.onDemand && g.id !== 'other').map((g) => g.id);
    expect(r.removed.sort()).toEqual(installedIds.filter((id) => !kept.includes(id)).sort());
    expect(r.created).toEqual(['hardware']);
    for (const id of [autoNews.id, stashedNews.id]) {
      expect(await db.items.get(id)).toMatchObject({ groupId: null, groupSource: 'auto' });
      expect((await db.items.get(id))!.updatedAt).toBeGreaterThan(10);
    }
    expect(await db.items.get(userTv.id)).toMatchObject({ groupId: 'tv', groupSource: 'user' });
    const q = await queued();
    expect(q).toContain(autoNews.id);
    expect(q).toContain(stashedNews.id);
    expect(q).not.toContain(userTv.id);
  });

  it('fresh: a user-placed tab in a group keeps that group even when stashed', async () => {
    await addItem({ groupId: 'news', groupSource: 'user', state: 'stashed' });
    const r = await applyInterests(db, fakeEmbed, { picked: [], custom: [] }, true);
    expect(r.removed).not.toContain('news');
    expect(await db.groups.get('news')).toBeDefined();
  });

  it('re-queues every auto-placed tab afterwards; user-placed and suggested ones stay put', async () => {
    await db.groups.put(userGroup('suggested-1', 'Maybe', { suggested: true }));
    const unsorted = await addItem();
    const auto = await addItem({ groupId: 'news' });
    const user = await addItem({ groupId: 'news', groupSource: 'user' });
    const sugg = await addItem({ groupId: 'suggested-1' });
    const unclassifiable = await addItem({ classifiable: false });
    await applyInterests(db, fakeEmbed, { picked: ['sports'], custom: [] }, false);
    const q = await queued();
    expect(q).toEqual([unsorted.id, auto.id].sort());
    expect(q).not.toContain(user.id);
    expect(q).not.toContain(sugg.id);
    expect(q).not.toContain(unclassifiable.id);
    expect(await db.items.get(auto.id)).toMatchObject({ groupId: 'news', groupSource: 'auto' }); // until re-classified
  });

  it('custom names: parsed like group names, a new one is a user group', async () => {
    const r = await applyInterests(db, fakeEmbed, { picked: [], custom: ['  Lathe work  '] }, false);
    expect(r.created).toHaveLength(1);
    const g = (await db.groups.get(r.created[0]!))!;
    expect(g).toMatchObject({ name: 'Lathe work', builtIn: false, icon: '📁' });
    expect(g.id.startsWith('g-')).toBe(true);
    for (const bad of ['   ', 'x'.repeat(61)]) {
      await expect(applyInterests(db, fakeEmbed, { picked: [], custom: [bad] }, false)).rejects.toThrow(/1-60/);
    }
  });

  it('custom names: an existing group of that name (any case) is adopted, never duplicated', async () => {
    await db.groups.put(userGroup('g-x', 'Lathe Work'));
    const r = await applyInterests(db, fakeEmbed, { picked: [], custom: ['lathe work', 'MOVIES', 'Lathe work'] }, false);
    expect(r.created).toEqual([]);
    expect((await db.groups.all()).filter((g) => g.name.toLowerCase() === 'lathe work')).toHaveLength(1);
    expect((await db.groups.all()).filter((g) => g.name.toLowerCase() === 'movies')).toHaveLength(1);
  });

  it('custom names: a trained group name creates it with the trained id; a user group of that name takes the id', async () => {
    const r1 = await applyInterests(db, fakeEmbed, { picked: [], custom: ['sports'] }, false);
    expect(r1.created).toEqual(['sports']);
    expect(await db.groups.get('sports')).toMatchObject({ name: 'Sports', builtIn: true });

    await db.groups.put(userGroup('g-food', 'FOOD & Cooking', { exemplars: [[1, 0]], lessons: [['pasta', 5]] }));
    const tab = await addItem({ groupId: 'g-food', groupSource: 'user' });
    await chrome.storage.session.set({ [MIRRORED_KEY]: { 9: 'g-food' } });
    await chrome.storage.local.set({ [REMOVED_TRAINED_KEY]: ['food'] });
    const r2 = await applyInterests(db, fakeEmbed, { picked: [], custom: ['Food & cooking'] }, false);
    expect(r2.created).toEqual([]);
    expect(await db.groups.get('g-food')).toBeUndefined();
    const food = (await db.groups.get('food'))!;
    expect(food).toMatchObject({ name: 'FOOD & Cooking', builtIn: true, exemplars: [[1, 0]], lessons: [['pasta', 5]] });
    expect(food.centroid).not.toBeNull();
    expect(await db.items.get(tab.id)).toMatchObject({ groupId: 'food', groupSource: 'user' });
    expect((await chrome.storage.session.get(MIRRORED_KEY))[MIRRORED_KEY]).toEqual({ 9: 'food' });
    expect(await loadRemovedTrained()).toEqual([]);
  });

  it('picking a trained id adopts a user group of that name instead of duplicating it', async () => {
    await db.groups.put(userGroup('g-s', 'sports'));
    const r = await applyInterests(db, fakeEmbed, { picked: ['sports'], custom: [] }, false);
    expect(r.created).toEqual([]);
    expect(await db.groups.get('g-s')).toBeUndefined();
    expect(await db.groups.get('sports')).toMatchObject({ name: 'sports', builtIn: true });
  });

  it('a name held by another built-in group (renamed) is left alone: nothing is created or adopted', async () => {
    await db.groups.put({ ...(await db.groups.get('news'))!, name: 'Sports' });
    const r = await applyInterests(db, fakeEmbed, { picked: ['sports'], custom: [] }, false);
    expect(r.created).toEqual([]);
    expect(await db.groups.get('sports')).toBeUndefined();
    expect(await db.groups.get('news')).toMatchObject({ name: 'Sports' });
  });

  it('rejects payloads that are not string arrays', async () => {
    for (const req of [{ picked: 'x', custom: [] }, { picked: [], custom: [1] }, { picked: [2], custom: [] }]) {
      await expect(applyInterests(db, fakeEmbed, req as never, false)).rejects.toThrow();
    }
  });
});

describe('interests rpc', () => {
  afterEach(() => vi.resetModules());
  it('is wired: validates, applies fresh only before onboarding and the first answer, and queues for classification', async () => {
    vi.doMock('../../src/background/embedder', () => ({
      embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
      isWarm: vi.fn(() => false),
      closeIfIdle: vi.fn(async () => undefined),
      OFFSCREEN_IDLE_ALARM: 'offscreen-idle',
    }));
    mock.uninstall();
    mock = installChromeMock();
    const bg = await import('../../src/background/index');
    const rdb = await bg.getDb();
    for (const g of await buildStarterGroups(fakeEmbed)) await rdb.groups.put(g);
    expect(await mock.sendMessage({ t: 'interests', picked: 'x', custom: [] })).toMatchObject({ ok: false });
    const res = (await mock.sendMessage({ t: 'interests', picked: ['hardware'], custom: [] })) as {
      ok: true; data: { created: string[]; removed: string[] };
    };
    expect(res.ok).toBe(true);
    expect(res.data.created).toEqual(['hardware']);
    expect(res.data.removed).toContain('movies'); // not onboarded, first answer: fresh
    expect((await rdb.settings.get()).interestsAnswered).toBe(true);
    // Answered once: from now on the step only adds.
    const again = (await mock.sendMessage({ t: 'interests', picked: ['sports'], custom: [] })) as {
      ok: true; data: { created: string[]; removed: string[] };
    };
    expect(again.data).toEqual({ created: ['sports'], removed: [] });
    expect(await mock.sendMessage({ t: 'settings', patch: { interestsAnswered: false } })).toMatchObject({ ok: true });
    expect(await mock.sendMessage({ t: 'settings', patch: { interestsAnswered: 'no' } })).toMatchObject({ ok: false });
  });
});
