import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { moveItems, regroupPreview } from '../../src/background/groups';
import { EMBED_MODEL_KEY, LEGACY_MODEL, migrateModel } from '../../src/background/model-change';
import { EMBED_INPUT_VERSION, cachedVectors, embeddingKey, processQueue } from '../../src/background/tab-index';
import { EMBED_MODEL } from '../../src/classify/model';
import { STARTER_GROUPS } from '../../src/classify/seeds';
import { sha1hex } from '../../src/shared/hash';
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
  db = await openDb(`model-change-${n++}`);
  mock = installChromeMock();
  embedded = [];
  watch.on = false;
  watch.calls = 0;
  watch.withOld = 0;
  watch.mixed = 0;
});
afterEach(() => mock.uninstall());

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
    expect((await db.groups.get('user-x'))).toMatchObject({ exemplars: [], centroid: null });
    expect((await db.groups.get('suggested-1'))).toMatchObject({ exemplars: [], centroid: null, suggested: true });

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
    expect(await migrateModel(db, fakeEmbed)).toBe(true);
    expect((await db.groups.get('games'))!.exemplars).toEqual([Array.from(newVec('x'))]);
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
