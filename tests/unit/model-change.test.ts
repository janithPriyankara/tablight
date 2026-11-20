import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { acceptSuggestion, createGroup, moveItems, regroupPreview, whenTeachingDone } from '../../src/background/groups';
import { growGroups } from '../../src/background/grow';
import { BACKOFF_MS, EMBED_MODEL_KEY, LEGACY_MODEL, MIGRATION_BACKOFF_KEY, migrateModel } from '../../src/background/model-change';
import { EMBED_INPUT_VERSION, cachedVectors, embeddingKey, processQueue } from '../../src/background/tab-index';
import { EMBED_MODEL } from '../../src/classify/model';
import { STARTER_GROUPS } from '../../src/classify/seeds';
import { sha1hex } from '../../src/shared/hash';
import { normalize } from '../../src/shared/vec';
import { embedText } from '../../src/shared/url';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

// Old-model vectors carry OLD at the last dimension; vectors from the bundled model never do. Every cosine the
// code computes is watched: after the migration none may involve an old vector, and none may ever mix the two.
const DIM = 384;
const OLD = 0.5;
const watch = vi.hoisted(() => ({ on: false, calls: 0, withOld: 0, mixed: 0 }));
vi.mock('../../src/shared/vec', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/shared/vec')>();
  const isOld = (v: ArrayLike<number>) => v.length === 384 && Math.abs(v[383]! - 0.5) < 1e-6;
  return {
    ...m,
    cosine: (a: ArrayLike<number>, b: ArrayLike<number>) => {
      if (watch.on) {
        watch.calls++;
        if (isOld(a) || isOld(b)) watch.withOld++;
        if (isOld(a) !== isOld(b)) watch.mixed++;
      }
      return m.cosine(a, b);
    },
  };
});

let n = 0;
let db: Db;
let mock: ChromeMockControl;
let embedded: string[];
/** The bundled model, faked: a deterministic unit vector per text, never tagged OLD. */
function newVec(text: string): Float32Array {
  const v = new Float32Array(DIM);
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  v[h % 300] = 0.8;
  v[(h >>> 9) % 300 + 1] = 0.6;
  return v;
}
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  embedded.push(...texts);
  return texts.map(newVec);
};
function oldVec(seed: number): Float32Array {
  const v = new Float32Array(DIM).fill(0.01 * (seed + 1));
  v[DIM - 1] = OLD;
  return v;
}
/** The cache key the previous model's build wrote: the same form, naming Xenova/bge-small-en-v1.5. */
const legacyKey = (i: Item) => sha1hex(`${LEGACY_MODEL}\n${EMBED_INPUT_VERSION}\n${i.normUrl}\n${embedText(i)}`);
const group = (id: string, over: Partial<Group> = {}): Group => ({
  id, name: id, color: '#0090ff', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 1, ...over,
});
let seq = 0;
/** An item classified by the previous model: its vector sits under the legacy key, recorded in embKey. */
async function oldItem(over: Partial<Item> = {}): Promise<Item> {
  const k = seq++;
  const url = over.url ?? `https://site${k}.example.com/page`;
  const base: Item = {
    id: `i${k}`, url, normUrl: url, title: `Title ${k}`, domain: `site${k}.example.com`, state: 'open',
    groupId: null, groupSource: 'auto', kind: 'read', createdAt: k, lastActiveAt: k, updatedAt: 10, classifiable: true,
    ...over,
  };
  const key = await legacyKey(base);
  expect(key).not.toBe(await embeddingKey(base));
  const item = { ...base, embKey: key };
  await db.items.put(item);
  await db.embeddings.put(key, oldVec(k));
  return item;
}

beforeEach(async () => {
  // Only the clock is faked: each test starts an hour later, past any backoff an earlier test left behind.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 20) + n * 3_600_000);
  db = await openDb(`model-change-${n++}`);
  mock = installChromeMock();
  embedded = [];
  watch.on = false;
  watch.calls = 0;
  watch.withOld = 0;
  watch.mixed = 0;
});
afterEach(() => {
  mock.uninstall();
  vi.useRealTimers();
});

describe('migrateModel: an install upgrading from Xenova/bge-small-en-v1.5', () => {
  it('re-embeds every item under the new model id and rebuilds exemplars from lessons, with no cross-model cosine', async () => {
    expect(EMBED_MODEL).not.toBe(LEGACY_MODEL);
    const lessonsGames: [string, number][] = [['Zelda walkthrough — example.com', 1], ['Elden Ring boss guide — wiki', 2]];
    await db.groups.put(group('games', {
      // Two lessons with their old vectors, plus one exemplar taught before lessons existed (no text).
      exemplars: [Array.from(oldVec(90)), Array.from(oldVec(91)), Array.from(oldVec(92))],
      centroid: Array.from(oldVec(93)), lessons: lessonsGames,
    }));
    await db.groups.put(group('news', { centroid: Array.from(oldVec(94)) })); // installed seed group, nothing taught
    await db.groups.put(group('user-x', { builtIn: false, exemplars: [Array.from(oldVec(95))], centroid: Array.from(oldVec(95)) }));
    await db.groups.put(group('suggested-1', { builtIn: false, suggested: true, centroid: Array.from(oldVec(96)) }));
    const items = [
      await oldItem({ groupId: 'games', groupSource: 'user' }),
      await oldItem({ groupId: 'user-x', groupSource: 'user' }),
      await oldItem({ groupId: 'news' }),
      await oldItem({ state: 'stashed', groupId: 'suggested-1' }),
      await oldItem({ title: 'A YouTube video', url: 'https://www.youtube.com/watch?v=abc' }),
    ];
    const unclassifiable = await oldItem({ classifiable: false });
    // A move before the migration still teaches the old vector (old with old) and records the lesson text.
    await moveItems(db, [items[2]!.id], 'games');
    const taughtText = embedText(items[2]!);
    expect((await db.groups.get('games'))!.lessons!.map(([t]) => t)).toContain(taughtText);
    expect(await chrome.storage.local.get(EMBED_MODEL_KEY)).toEqual({}); // missing: counts as the legacy model

    watch.on = true;
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    expect((await chrome.storage.local.get(EMBED_MODEL_KEY))[EMBED_MODEL_KEY]).toBe(EMBED_MODEL);

    // Nothing can reach an old vector any more: no embKey, an empty cache, nothing for cachedVectors.
    expect(await db.embeddings.keys()).toEqual([]);
    for (const i of await db.items.all()) expect(i.embKey).toBeUndefined();
    expect((await cachedVectors(db, await db.items.all())).size).toBe(0);
    expect(await db.queue.size()).toBe(items.length); // every classifiable item, not the unclassifiable one

    // Exemplars rebuilt from the lessons' texts (in order); the exemplar without a lesson is dropped.
    const games = (await db.groups.get('games'))!;
    const texts = games.lessons!.map(([t]) => t);
    expect(texts).toEqual([...lessonsGames.map(([t]) => t), taughtText]);
    expect(games.exemplars).toEqual(texts.map((t) => Array.from(newVec(t))));
    expect(games.centroid![DIM - 1]).toBe(0);
    // A seed group with nothing taught gets its seeds' centroid from the new model.
    const news = (await db.groups.get('news'))!;
    expect(news.centroid).not.toBeNull();
    expect(news.centroid![DIM - 1]).toBe(0);
    expect(embedded).toEqual(expect.arrayContaining(STARTER_GROUPS.find((g) => g.id === 'news')!.seeds));
    // A user group with no lessons, and a suggestion: nothing to rebuild from.
    // A group with no lessons and no seeds gets its name's vector (as sync builds such groups).
    expect((await db.groups.get('user-x'))).toMatchObject({ exemplars: [], centroid: normalize(Array.from(newVec('user-x'))) });
    // A suggestion is dissolved: gone, its member back in Unsorted, nothing recorded as dismissed.
    expect(await db.groups.get('suggested-1')).toBeUndefined();
    expect((await db.items.get(items[3]!.id))!.groupId).toBeNull();
    expect(await chrome.storage.local.get('dismissedSuggestions')).toEqual({});
    // Queue order: user-placed tabs first, saved tabs last.
    const queued = await db.queue.take(100);
    expect(queued.slice(0, 2).sort()).toEqual([items[0]!.id, items[1]!.id].sort());
    expect(queued.at(-1)).toBe(items[3]!.id);

    // The queue re-embeds every item under a key naming the new model.
    embedded = [];
    expect(await processQueue(db, fakeEmbed)).toBe(items.length);
    const after = new Map((await db.items.all()).map((i) => [i.id, i]));
    const newKeys = new Set<string>();
    for (const i of items) {
      const cur = after.get(i.id)!;
      const key = await embeddingKey(cur);
      expect(key).toBe(await sha1hex(`${EMBED_MODEL}\n${EMBED_INPUT_VERSION}\n${cur.normUrl}\n${embedText(cur)}`));
      expect(cur.embKey).toBe(key);
      expect(cur.embKey).not.toBe(i.embKey);
      newKeys.add(key);
    }
    expect(embedded.sort()).toEqual(items.map(embedText).sort());
    expect(after.get(unclassifiable.id)!.embKey).toBeUndefined();
    expect(new Set(await db.embeddings.keys())).toEqual(newKeys);
    for (const k of newKeys) expect((await db.embeddings.get(k))![DIM - 1]).toBe(0);
    // User placements are kept.
    expect(after.get(items[0]!.id)).toMatchObject({ groupId: 'games', groupSource: 'user' });
    expect(after.get(items[1]!.id)).toMatchObject({ groupId: 'user-x', groupSource: 'user' });

    await regroupPreview(db);
    expect(watch.calls).toBeGreaterThan(0); // exemplars and neighbours were compared, all with new vectors
    expect(watch.mixed).toBe(0);
    expect(watch.withOld).toBe(0);
  });

  it('is a no-op when the stored model is the bundled one', async () => {
    await chrome.storage.local.set({ [EMBED_MODEL_KEY]: EMBED_MODEL });
    const item = await oldItem();
    const g = group('games', { exemplars: [Array.from(oldVec(1))], lessons: [['x', 1]] });
    await db.groups.put(g);
    expect(await migrateModel(db, fakeEmbed)).toBe(false);
    expect(embedded).toEqual([]);
    expect((await db.items.get(item.id))!.embKey).toBe(item.embKey);
    expect(await db.groups.get('games')).toEqual(g);
    expect(await db.queue.size()).toBe(0);
  });

  it('stores nothing and changes nothing when embedding fails, and succeeds on a later try', async () => {
    const item = await oldItem();
    const g = group('games', { exemplars: [Array.from(oldVec(1))], lessons: [['x', 1]] });
    await db.groups.put(g);
    await expect(migrateModel(db, () => Promise.reject(new Error('offscreen down')))).rejects.toThrow('offscreen down');
    expect(await chrome.storage.local.get(EMBED_MODEL_KEY)).toEqual({});
    expect((await db.items.get(item.id))!.embKey).toBe(item.embKey);
    expect(await db.groups.get('games')).toEqual(g);
    expect(await db.embeddings.keys()).toHaveLength(1);
    // Within the backoff a call fails at once, without loading the model.
    embedded = [];
    await expect(migrateModel(db, fakeEmbed)).rejects.toThrow('offscreen down');
    expect(embedded).toEqual([]);
    vi.setSystemTime(Date.now() + BACKOFF_MS);
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    expect((await db.groups.get('games'))!.exemplars).toEqual([Array.from(newVec('x'))]);
  });

  it('backs off longer after each failure, up to 15 minutes', async () => {
    await db.groups.put(group('games', { lessons: [['x', 1]] }));
    const down = () => Promise.reject(new Error('down'));
    const t0 = Date.now();
    for (const [k, wait] of [[0, 1], [1, 2], [2, 4], [3, 8], [4, 15], [5, 15]] as const) {
      await expect(migrateModel(db, down)).rejects.toThrow('down');
      vi.setSystemTime(Date.now() + wait * 60_000 - 1);
      await expect(migrateModel(db, fakeEmbed), `failure ${k + 1}`).rejects.toThrow('down'); // still waiting
      vi.setSystemTime(Date.now() + 1);
    }
    expect(Date.now() - t0).toBe((1 + 2 + 4 + 8 + 15 + 15) * 60_000);
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
  });
  it('stops after two failed embed calls when the embedder is down, instead of trying every text and seed group', async () => {
    // 40 lessons (two chunks), two untaught seed groups and an untaught user group: a down embedder used to be
    // asked once per chunk, once per text and once per group.
    const lessons = Array.from({ length: 40 }, (_, k): [string, number] => [`lesson ${k}`, k]);
    await db.groups.put(group('games', { lessons }));
    const seeds = STARTER_GROUPS.slice(0, 3).map((g) => g.id).filter((id) => id !== 'games').slice(0, 2);
    for (const id of seeds) await db.groups.put(group(id));
    await db.groups.put(group('user-x', { builtIn: false }));
    let calls = 0;
    const down = async (): Promise<Float32Array[]> => {
      calls++;
      throw new Error('model will not load');
    };
    await expect(migrateModel(db, down)).rejects.toThrow('model will not load');
    expect(calls).toBe(2); // the first chunk, then its first text alone
    expect(await chrome.storage.local.get(EMBED_MODEL_KEY)).toEqual({});
  });
  it('stops after two failed calls when only seed groups need embedding', async () => {
    const seeds = STARTER_GROUPS.slice(0, 4).map((g) => g.id);
    for (const id of seeds) await db.groups.put(group(id));
    await oldItem();
    let calls = 0;
    await expect(migrateModel(db, async () => {
      calls++;
      throw new Error('down');
    })).rejects.toThrow('down');
    expect(calls).toBe(2);
  });
  it('keeps trying the other texts once one call has worked (one bad text is not a down embedder)', async () => {
    await db.groups.put(group('games', { lessons: [['good', 1], ['poison', 2], ['fine', 3], ['also poison', 4]] }));
    const picky = async (texts: string[]) => {
      if (texts.some((t) => t.includes('poison'))) throw new Error('bad text');
      return fakeEmbed(texts);
    };
    expect(await migrateModel(db, picky)).toBe(true);
    expect((await db.groups.get('games'))!.exemplars).toEqual([Array.from(newVec('good')), Array.from(newVec('fine'))]);
  });
  it('keeps the backoff in chrome.storage.session, so a service-worker restart still waits', async () => {
    await db.groups.put(group('games', { lessons: [['x', 1]] }));
    await expect(migrateModel(db, () => Promise.reject(new Error('offscreen down')))).rejects.toThrow('offscreen down');
    const stored = (await chrome.storage.session.get(MIGRATION_BACKOFF_KEY))[MIGRATION_BACKOFF_KEY];
    expect(stored).toEqual({ failures: 1, retryAt: Date.now() + BACKOFF_MS, error: 'offscreen down' });
    // A fresh copy of the module is a restarted worker: nothing in memory, the backoff still holds.
    vi.resetModules();
    const fresh = await import('../../src/background/model-change');
    embedded = [];
    await expect(fresh.migrateModel(db, fakeEmbed)).rejects.toThrow('offscreen down');
    expect(embedded).toEqual([]);
    // Its second failure doubles the wait from the stored count.
    vi.setSystemTime(Date.now() + BACKOFF_MS);
    await expect(fresh.migrateModel(db, () => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    expect((await chrome.storage.session.get(MIGRATION_BACKOFF_KEY))[MIGRATION_BACKOFF_KEY])
      .toEqual({ failures: 2, retryAt: Date.now() + 2 * BACKOFF_MS, error: 'still down' });
    // A success clears it.
    vi.setSystemTime(Date.now() + 2 * BACKOFF_MS);
    expect(await fresh.migrateModel(db, fakeEmbed)).toBe(true);
    expect(await chrome.storage.session.get(MIGRATION_BACKOFF_KEY)).toEqual({});
  });
  it('drops only the exemplar of a lesson whose text will not embed', async () => {
    await db.groups.put(group('games', { lessons: [['good', 1], ['poison', 2], ['fine', 3]] }));
    const picky = async (texts: string[]) => {
      if (texts.includes('poison')) throw new Error('bad text');
      return fakeEmbed(texts);
    };
    expect(await migrateModel(db, picky)).toBe(true);
    const g = (await db.groups.get('games'))!;
    expect(g.exemplars).toEqual([Array.from(newVec('good')), Array.from(newVec('fine'))]);
    expect(g.lessons!.map(([t]) => t)).toEqual(['good', 'poison', 'fine']); // lessons are kept
  });
  it('a group created while the lessons are embedded makes the run start again', async () => {
    await db.groups.put(group('games', { lessons: [['a', 1]] }));
    let first = true;
    const racing = async (texts: string[]) => {
      if (first) {
        first = false;
        await db.groups.put(group('user-new', { builtIn: false, exemplars: [Array.from(oldVec(3))], lessons: [['b', 2]] }));
      }
      return fakeEmbed(texts);
    };
    expect(await migrateModel(db, racing)).toBe(true);
    expect((await db.groups.get('user-new'))!.exemplars).toEqual([Array.from(newVec('b'))]);
  });
  it("writes a saved tab's re-pick locally only: no updatedAt bump, nothing for sync (normal passes still stamp)", async () => {
    // The old model filed this saved tab under News; the new model's vector matches a Games lesson exactly.
    const item = await oldItem({ state: 'stashed', groupId: 'news', groupSource: 'auto', updatedAt: 500 });
    const text = embedText(item);
    await db.groups.put(group('news'));
    await db.groups.put(group('games', { lessons: [[text, 1]] }));
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    expect(await processQueue(db, fakeEmbed)).toBe(1);
    const after = (await db.items.get(item.id))!;
    expect(after).toMatchObject({ groupId: 'games', groupSource: 'auto', updatedAt: 500 });
    expect(syncSet).not.toHaveBeenCalled();
    // The same change outside the migration (an ordinary queue entry) is stamped as before.
    await db.items.put({ ...after, groupId: 'news' });
    await db.queue.add(item.id);
    expect(await processQueue(db, fakeEmbed)).toBe(1);
    expect((await db.items.get(item.id))!.updatedAt).toBeGreaterThan(500);
  });
  it('a move during the re-embed still teaches: embedded on demand, or by its lesson text alone', async () => {
    await db.groups.put(group('games'));
    const a = await oldItem();
    const b = await oldItem();
    expect(await migrateModel(db, fakeEmbed)).toBe(true); // the cache is empty, nothing re-embedded yet
    await moveItems(db, [a.id], 'games', fakeEmbed);
    await whenTeachingDone();
    let g = (await db.groups.get('games'))!;
    expect(g.exemplars).toEqual([Array.from(newVec(embedText(a)))]);
    expect(g.lessons!.map(([t]) => t)).toEqual([embedText(a)]);
    await moveItems(db, [b.id], 'games', () => Promise.reject(new Error('cold')));
    await whenTeachingDone();
    g = (await db.groups.get('games'))!;
    expect(g.exemplars).toHaveLength(1); // no vector for b
    expect(g.lessons!.map(([t]) => t)).toEqual([embedText(a), embedText(b)]); // but its lesson is kept (and syncs)
  });
  it('a migration committing between the vector read and the teaching transaction never leaves an old-model exemplar', async () => {
    watch.on = true;
    // A Db whose next transaction first lets the whole migration commit: the vectors were read (through the old
    // embKey) before it, the teaching transaction runs after it.
    const racing = (): Db => {
      let raced = false;
      return {
        ...db,
        tx: (async (stores: never, fn: never) => {
          if (!raced) {
            raced = true;
            expect(await migrateModel(db, fakeEmbed)).toBe(true);
          }
          return db.tx(stores, fn);
        }) as Db['tx'],
      };
    };
    const noOld = (g: Group | undefined) => {
      expect(g).toBeDefined();
      for (const v of g!.exemplars) expect(v[DIM - 1]).not.toBeCloseTo(OLD);
      if (g!.centroid) expect(g!.centroid[DIM - 1]).not.toBeCloseTo(OLD);
    };
    await db.groups.put(group('games'));
    const a = await oldItem();
    await moveItems(racing(), [a.id], 'games', fakeEmbed);
    await whenTeachingDone();
    noOld(await db.groups.get('games'));
    expect((await db.groups.get('games'))!.exemplars).toEqual([Array.from(newVec(embedText(a)))]); // taught late
    await chrome.storage.local.remove(EMBED_MODEL_KEY); // the next race migrates again
    const b = await oldItem();
    const made = await createGroup(racing(), 'Made', [b.id], fakeEmbed);
    await whenTeachingDone();
    noOld(await db.groups.get(made.id));
    expect((await db.groups.get(made.id))!.exemplars).toEqual([Array.from(newVec(embedText(b)))]);
    await chrome.storage.local.remove(EMBED_MODEL_KEY);
    await db.groups.put(group('sugg', { builtIn: false, suggested: true }));
    const c = await oldItem({ groupId: 'sugg' });
    // The migration dissolves the suggestion, so accepting it fails; nothing old is taught anywhere.
    await expect(acceptSuggestion(racing(), 'sugg', fakeEmbed)).rejects.toThrow('not a suggestion');
    for (const g of await db.groups.all()) noOld(g);
    expect((await db.items.get(c.id))!.groupId).toBeNull();
  });
  it('a later move wins over an earlier one whose embed is still pending; teaching never moves a tab', async () => {
    await db.groups.put(group('games'));
    await db.groups.put(group('news'));
    const x = await oldItem({ state: 'stashed' });
    const y = await oldItem({ state: 'stashed' });
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    // x was re-embedded already; y's embed (the model is busy or cold) is held until released.
    await db.embeddings.put(await embeddingKey(x), newVec(embedText(x)));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slowEmbed = async (texts: string[]) => {
      await held;
      return fakeEmbed(texts);
    };
    await moveItems(db, [x.id, y.id], 'games', slowEmbed); // returns with the move committed, embed still pending
    expect((await db.items.get(x.id))!.groupId).toBe('games');
    await moveItems(db, [x.id], 'news', slowEmbed);
    const afterB = (await db.items.get(x.id))!;
    expect(afterB.groupId).toBe('news');
    release();
    await whenTeachingDone();
    const final = (await db.items.get(x.id))!;
    expect(final).toMatchObject({ groupId: 'news', groupSource: 'user' });
    expect(final.updatedAt).toBe(afterB.updatedAt); // the News move is the newest stamp: it is what syncs for x
    expect((await db.items.get(y.id))!.groupId).toBe('games');
    expect((await db.groups.get('games'))!.exemplars).toContainEqual(Array.from(newVec(embedText(y)))); // y taught late
  });
  it("growGroups keeps a quiet re-pick's tabs unstamped; a user move clears the mark", async () => {
    // Three saved tabs that the migration's re-pick leaves in Unsorted wanting Hardware (a trained group not there).
    const tabs = [];
    for (let k = 0; k < 3; k++) tabs.push(await oldItem({ state: 'stashed', groupId: 'news', updatedAt: 700 }));
    await db.groups.put(group('news'));
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    // The quiet write as processBatch makes it when the pick changes group (the head is not faked here).
    for (const t of tabs) {
      const cur = (await db.items.get(t.id))!;
      await db.items.put({ ...cur, groupId: null, want: 'hardware', quietPick: true });
    }
    const grown = await growGroups(db, fakeEmbed);
    expect(grown.map((g) => g.id)).toEqual(['hardware']);
    for (const t of tabs) {
      expect(await db.items.get(t.id)).toMatchObject({ groupId: 'hardware', updatedAt: 700, quietPick: true });
    }
    await moveItems(db, [tabs[0]!.id], 'news');
    const moved = (await db.items.get(tabs[0]!.id))!;
    expect(moved.quietPick).toBeUndefined();
    expect(moved.updatedAt).toBeGreaterThan(700);
  });
  it('processBatch marks a quiet change of group, keeps the mark while the group stays, and a stamped move drops it', async () => {
    const item = await oldItem({ state: 'stashed', groupId: 'news', groupSource: 'auto', updatedAt: 500 });
    const text = embedText(item);
    await db.groups.put(group('news'));
    await db.groups.put(group('games', { lessons: [[text, 1]] }));
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    await processQueue(db, fakeEmbed);
    expect(await db.items.get(item.id)).toMatchObject({ groupId: 'games', updatedAt: 500, quietPick: true });
    await db.queue.add(item.id); // an ordinary re-run that keeps the group: still the quiet placement
    await processQueue(db, fakeEmbed);
    expect(await db.items.get(item.id)).toMatchObject({ groupId: 'games', updatedAt: 500, quietPick: true });
    const cur = (await db.items.get(item.id))!;
    await db.items.put({ ...cur, groupId: 'news' }); // as if placed elsewhere; an ordinary pass moves it back, stamped
    await db.queue.add(item.id);
    await processQueue(db, fakeEmbed);
    const after = (await db.items.get(item.id))!;
    expect(after.groupId).toBe('games');
    expect(after.updatedAt).toBeGreaterThan(500);
    expect(after.quietPick).toBeUndefined();
  });
  it('migrates a store marked with another model too', async () => {
    await chrome.storage.local.set({ [EMBED_MODEL_KEY]: 'Xenova/all-MiniLM-L6-v2' });
    await oldItem();
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    expect(await db.embeddings.keys()).toEqual([]);
  });

  it('only marks the model on an empty store (a fresh install), without embedding', async () => {
    expect(await migrateModel(db, fakeEmbed)).toBe(false);
    expect(embedded).toEqual([]);
    expect((await chrome.storage.local.get(EMBED_MODEL_KEY))[EMBED_MODEL_KEY]).toBe(EMBED_MODEL);
  });

  it('retries when a lesson is added while the lessons are embedded', async () => {
    await db.groups.put(group('games', { lessons: [['a', 1]] }));
    let first = true;
    const racing = async (texts: string[]) => {
      if (first) {
        first = false;
        const cur = (await db.groups.get('games'))!;
        await db.groups.put({ ...cur, lessons: [...cur.lessons!, ['b', 2]] });
      }
      return fakeEmbed(texts);
    };
    expect(await migrateModel(db, racing)).toBe(true);
    expect((await db.groups.get('games'))!.exemplars).toEqual([Array.from(newVec('a')), Array.from(newVec('b'))]);
  });

  it('shares one run between concurrent calls', async () => {
    await db.groups.put(group('games', { lessons: [['a', 1]] }));
    const [a, b] = await Promise.all([migrateModel(db, fakeEmbed), migrateModel(db, fakeEmbed)]);
    expect([a, b]).toEqual([true, true]);
    expect(embedded.filter((t) => t === 'a')).toHaveLength(1);
  });
});
