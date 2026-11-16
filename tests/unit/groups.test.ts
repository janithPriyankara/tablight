import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import {
  acceptSuggestion, createGroup, deleteGroup, dismissSuggestion, mergeGroups, mirrorTabGroups, moveItems,
  nearestChromeColor, parseIds, parseName, regroupApply, regroupPreview, renameGroup,
} from '../../src/background/groups';
import {
  MAX_DISMISSED, embeddingKey, loadDismissed, maybeSuggest, processQueue, reconcile, recordDismissed,
} from '../../src/background/tab-index';
import { cosine } from '../../src/shared/vec';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
const DIM = 384;
let n = 0;
let db: Db;
let mock: ChromeMockControl;
function vecFor(text: string): Float32Array {
  const v = new Float32Array(DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  for (let i = 0; i < DIM; i++) {
    h = Math.imul(h ^ i, 16777619);
    v[i] = ((h >>> 0) % 1000) / 1000 - 0.5;
  }
  return v;
}
const group = (id: string, over: Partial<Group> = {}): Group => ({
  id, name: id, color: '#0090ff', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 1, ...over,
});
let seq = 0;
/** An item with a cached vector (derived from `vecText`). */
async function addItem(over: Partial<Item> = {}, vecText = `v${seq}`): Promise<Item> {
  const k = seq++;
  const url = over.url ?? `https://site${k}.example.com/page`;
  const base: Item = {
    id: `i${k}`, url, normUrl: url, title: `Title ${k}`, domain: `site${k}.example.com`, state: 'open',
    groupId: null, groupSource: 'auto', kind: 'other', createdAt: k, lastActiveAt: k, updatedAt: k,
    classifiable: true, ...over,
  };
  await db.items.put(base);
  await db.embeddings.put(await embeddingKey(base), vecFor(vecText));
  return base;
}
beforeEach(async () => {
  db = await openDb(`groups-${n++}`);
  mock = installChromeMock();
});
afterEach(() => mock.uninstall());
describe('moveItems', () => {
  it("sets groupSource 'user' and the group gains the items' vectors as exemplars", async () => {
    await db.groups.put(group('games'));
    const a = await addItem({}, 'alpha');
    const b = await addItem({}, 'beta');
    await moveItems(db, [a.id, b.id], 'games');
    for (const id of [a.id, b.id]) {
      const i = (await db.items.get(id))!;
      expect([i.groupId, i.groupSource]).toEqual(['games', 'user']);
    }
    const g = (await db.groups.get('games'))!;
    expect(g.exemplars).toHaveLength(2);
    expect(cosine(g.exemplars[0]!, vecFor('alpha'))).toBeGreaterThan(0.999);
    expect(g.centroid).not.toBeNull();
  });
  it('rejects an unknown group without touching items, and keeps only the newest 50 exemplars', async () => {
    await db.groups.put(group('games'));
    const a = await addItem();
    await expect(moveItems(db, [a.id], 'nope')).rejects.toThrow(/unknown group/);
    expect((await db.items.get(a.id))!.groupId).toBeNull();
    const ids: string[] = [];
    for (let k = 0; k < 55; k++) ids.push((await addItem({}, `bulk${k}`)).id);
    await moveItems(db, ids, 'games');
    expect((await db.groups.get('games'))!.exemplars).toHaveLength(50);
  });
});
describe('createGroup', () => {
  it('uses the vectors of ids as exemplars and moves the items as user', async () => {
    const a = await addItem({}, 'alpha');
    const g = await createGroup(db, '  Birds  ', [a.id, 'missing']);
    expect(g.name).toBe('Birds');
    expect(g.builtIn).toBe(false);
    expect(g.exemplars).toHaveLength(1);
    expect(await db.groups.get(g.id)).toEqual(g);
    expect((await db.items.get(a.id))).toMatchObject({ groupId: g.id, groupSource: 'user' });
    await expect(createGroup(db, '   ', [])).rejects.toThrow();
  });
});
describe('rename / delete / merge', () => {
  it('renames with trimming and validation', async () => {
    await db.groups.put(group('g1'));
    await renameGroup(db, 'g1', '  New  ');
    expect((await db.groups.get('g1'))!.name).toBe('New');
    await expect(renameGroup(db, 'g1', 'x'.repeat(61))).rejects.toThrow();
    await expect(renameGroup(db, 'nope', 'ok')).rejects.toThrow(/unknown group/);
  });
  it("deleteGroup('other') rejects; a built-in like games can be deleted and its items go Unsorted", async () => {
    await db.groups.put(group('other'));
    await db.groups.put(group('games'));
    const a = await addItem({ groupId: 'games', groupSource: 'user' });
    await expect(deleteGroup(db, 'other')).rejects.toThrow(/other/i);
    expect(await db.groups.get('other')).toBeDefined();
    await deleteGroup(db, 'games');
    expect(await db.groups.get('games')).toBeUndefined();
    expect(await db.items.get(a.id)).toMatchObject({ groupId: null, groupSource: 'auto' });
    expect(await db.queue.take(10)).toEqual([a.id]); // queued for re-sorting, as the dialog promises
  });
  it('deleteGroup queues only classifiable items for re-sorting', async () => {
    await db.groups.put(group('games'));
    const web = await addItem({ groupId: 'games' });
    const nonWeb = await addItem({ groupId: 'games', classifiable: false, url: 'chrome://x/', normUrl: 'chrome://x/' });
    await deleteGroup(db, 'games');
    expect(await db.queue.take(10)).toEqual([web.id]);
    expect((await db.items.get(nonWeb.id))!.groupId).toBeNull();
  });
  it('merge moves every item and exemplar, then deletes the source', async () => {
    await db.groups.put(group('a', { exemplars: [[1, 0], [0, 1]], centroid: [1, 0] }));
    await db.groups.put(group('b', { exemplars: [[1, 1]], centroid: [1, 1] }));
    const x = await addItem({ groupId: 'a', groupSource: 'user' });
    const y = await addItem({ groupId: 'a' });
    const z = await addItem({ groupId: 'b' });
    await mergeGroups(db, 'a', 'b');
    expect(await db.groups.get('a')).toBeUndefined();
    expect((await db.groups.get('b'))!.exemplars).toHaveLength(3);
    for (const i of [x, y, z]) expect((await db.items.get(i.id))!.groupId).toBe('b');
    expect((await db.items.get(x.id))!.groupSource).toBe('user');
    await expect(mergeGroups(db, 'b', 'b')).rejects.toThrow();
    await db.groups.put(group('other'));
    await expect(mergeGroups(db, 'other', 'b')).rejects.toThrow();
  });
});
describe('regroup', () => {
  // A netflix title is decided by ruleGroup ('tv'); an exemplar-matching vector by learning.
  const setup = async () => {
    await db.groups.put(group('tv'));
    await db.groups.put(group('taught', { exemplars: [Array.from(vecFor('taught-vec'))] }));
    const auto = await addItem({ url: 'https://www.netflix.com/title/80100172', title: 'Some Show' });
    const learned = await addItem({ groupId: null }, 'taught-vec');
    const user = await addItem({ url: 'https://www.netflix.com/title/1', groupId: 'taught', groupSource: 'user' });
    const noVec = await addItem({ url: 'https://www.netflix.com/title/2' });
    await db.embeddings.delete(await embeddingKey(noVec));
    return { auto, learned, user, noVec };
  };
  it('preview reports before/after per group and writes nothing', async () => {
    const { auto, learned } = await setup();
    const before = JSON.stringify(await db.items.all());
    const rows = await regroupPreview(db);
    expect(JSON.stringify(await db.items.all())).toBe(before);
    expect(rows).toContainEqual({ groupId: 'tv', before: 0, after: 1 });
    expect(rows).toContainEqual({ groupId: 'taught', before: 1, after: 2 });
    expect(rows).toContainEqual({ groupId: null, before: 3, after: 1 }); // auto, learned and noVec start Unsorted
    void auto; void learned;
  });
  it('apply changes only auto items with a cached vector and never user items', async () => {
    const { auto, learned, user, noVec } = await setup();
    expect(await regroupApply(db)).toBe(2);
    expect((await db.items.get(auto.id))!.groupId).toBe('tv');
    expect((await db.items.get(learned.id))!.groupId).toBe('taught');
    expect((await db.items.get(user.id))).toMatchObject({ groupId: 'taught', groupSource: 'user' });
    expect((await db.items.get(noVec.id))!.groupId).toBeNull(); // no cached vector: unchanged
    expect(await regroupApply(db)).toBe(0);
  });
  it('leaves items in pending suggestions alone', async () => {
    await db.groups.put(group('tv'));
    await db.groups.put(group('s1', { suggested: true, builtIn: false }));
    const a = await addItem({ url: 'https://www.netflix.com/title/9', groupId: 's1' });
    expect(await regroupApply(db)).toBe(0);
    expect((await db.items.get(a.id))!.groupId).toBe('s1');
  });
});
describe('suggestions', () => {
  it('accept flips suggested, keeps members and makes them stable user items that teach the group', async () => {
    await db.groups.put(group('s1', { suggested: true, builtIn: false }));
    const a = await addItem({ groupId: 's1' }, 'alpha');
    await acceptSuggestion(db, 's1');
    const g = (await db.groups.get('s1'))!;
    expect(g.suggested).toBeFalsy();
    expect(g.exemplars).toHaveLength(1);
    expect(await db.items.get(a.id)).toMatchObject({ groupId: 's1', groupSource: 'user' });
    await expect(acceptSuggestion(db, 's1')).rejects.toThrow(/not a suggestion/);
  });
  async function unsorted(count: number, prefix: string, base: Float32Array) {
    for (let i = 0; i < count; i++) mock.addTab({ url: `https://${prefix}.example.com/${i}`, title: `${prefix} topic ${i}` });
    await reconcile(db, await chrome.tabs.query({}));
    const embedFn = async (texts: string[]) => texts.map((t) => base.map((v, d) => v + vecFor(t)[d]! * 0.05));
    await processQueue(db, embedFn);
  }
  it('dismiss deletes the group, returns items to Unsorted, and maybeSuggest will not re-suggest the cluster', async () => {
    await unsorted(4, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    const [s] = (await db.groups.all()).filter((g) => g.suggested);
    expect(s).toBeDefined();
    await dismissSuggestion(db, s!.id);
    expect(await db.groups.get(s!.id)).toBeUndefined();
    expect((await db.items.all()).every((i) => i.groupId === null && i.groupSource === 'auto')).toBe(true);
    expect(await loadDismissed()).toHaveLength(1);
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((g) => g.suggested)).toEqual([]);
    // A genuinely new topic is still suggested.
    await unsorted(4, 'gardening', vecFor('garden-base'));
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((g) => g.suggested)).toHaveLength(1);
  });
  it('still suggests a cluster that overlaps a dismissed one by less than 60%', async () => {
    await unsorted(4, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    const [s] = (await db.groups.all()).filter((g) => g.suggested);
    await dismissSuggestion(db, s!.id);
    // Drop two of the four items from the dismissed set (replace them with new ones): 2/4 overlap < 60%.
    const [t1, t2] = mock.tabs();
    mock.removeTab(t1!.id!);
    mock.removeTab(t2!.id!);
    await unsorted(2, 'rust2', vecFor('rust-base'));
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((g) => g.suggested)).toHaveLength(1);
  });
  it('with auto-create on, a found topic becomes a normal group right away and teaches it', async () => {
    await db.settings.set({ autoCreateGroups: true });
    await unsorted(4, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    const created = (await db.groups.all()).filter((g) => !g.builtIn);
    expect(created).toHaveLength(1);
    const g = created[0]!;
    expect(g.suggested).toBeUndefined();
    expect(g.exemplars.length).toBe(4);
    const members = (await db.items.all()).filter((i) => i.groupId === g.id);
    expect(members).toHaveLength(4);
    expect(members.every((i) => i.groupSource === 'user')).toBe(true);
  });
  it('with auto-create off (the default), a found topic is only suggested', async () => {
    expect((await db.settings.get()).autoCreateGroups).toBe(false);
    await unsorted(4, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((g) => g.suggested)).toHaveLength(1);
  });
  it('a deleted auto-created group does not come straight back', async () => {
    await db.settings.set({ autoCreateGroups: true });
    await unsorted(4, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    const [g] = (await db.groups.all()).filter((x) => !x.builtIn);
    await deleteGroup(db, g!.id);
    expect((await db.items.all()).every((i) => i.groupId === null)).toBe(true);
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((x) => !x.builtIn)).toEqual([]);
    // A new topic is still created.
    await unsorted(4, 'gardening', vecFor('garden-base'));
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((x) => !x.builtIn)).toHaveLength(1);
  });
  it('keeps only the newest 200 dismissed fingerprints', async () => {
    for (let k = 0; k < MAX_DISMISSED + 5; k++) await recordDismissed([`h${k}`]);
    const all = await loadDismissed();
    expect(all).toHaveLength(MAX_DISMISSED);
    expect(all[0]).toEqual(['h5']);
    expect(all.at(-1)).toEqual([`h${MAX_DISMISSED + 4}`]);
  });
});
describe('mirrorTabGroups', () => {
  async function setup() {
    mock.setPermission('tabGroups', true);
    await db.settings.set({ mirrorTabGroups: true });
    await db.groups.put(group('games', { name: 'Games', color: '#6e56cf' }));
    await db.groups.put(group('empty', { name: 'Empty' }));
    await db.groups.put(group('sug', { name: 'Sug', suggested: true, builtIn: false }));
    const w = mock.addWindow();
    const t1 = mock.addTab({ windowId: w, url: 'https://a.example.com/' });
    const t2 = mock.addTab({ windowId: w, url: 'https://b.example.com/' });
    const pinned = mock.addTab({ windowId: w, url: 'https://c.example.com/', pinned: true });
    const sleeping = mock.addTab({ windowId: w, url: 'https://d.example.com/', discarded: true });
    const other = mock.addTab({ windowId: w, url: 'https://e.example.com/' });
    await reconcile(db, await chrome.tabs.query({}));
    for (const t of [t1, t2, pinned, sleeping]) {
      const i = (await db.items.byTabId(t.id!))!;
      await db.items.put({ ...i, groupId: 'games' });
    }
    const o = (await db.items.byTabId(other.id!))!;
    await db.items.put({ ...o, groupId: 'sug' });
    return { w, t1, t2, pinned, sleeping, other };
  }
  it('does not call chrome.tabs.group without the tabGroups permission', async () => {
    const { w } = await setup();
    mock.setPermission('tabGroups', false);
    await mirrorTabGroups(db, w);
    expect(mock.calls.group).toBe(0);
    expect(mock.tabGroups()).toEqual([]);
  });
  it('does nothing when the setting is off', async () => {
    const { w } = await setup();
    await db.settings.set({ mirrorTabGroups: false });
    await mirrorTabGroups(db, w);
    expect(mock.calls.group).toBe(0);
  });
  it('groups open and sleeping unpinned tabs with title and nearest color; no empty or suggested groups', async () => {
    const { w, t1, t2, pinned, sleeping, other } = await setup();
    await mirrorTabGroups(db, w);
    const groups = mock.tabGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: 'Games', color: 'purple', windowId: w });
    const byId = new Map(mock.tabs().map((t) => [t.id, t]));
    expect(byId.get(t1.id)!.groupId).toBe(groups[0]!.id);
    expect(byId.get(t2.id)!.groupId).toBe(groups[0]!.id);
    expect(byId.get(sleeping.id)!.groupId).toBe(groups[0]!.id);
    expect(byId.get(pinned.id)!.groupId).toBe(-1);
    expect(byId.get(other.id)!.groupId).toBe(-1);
  });
  it('is idempotent: a second run reuses the native group and makes no calls', async () => {
    const { w } = await setup();
    await mirrorTabGroups(db, w);
    const calls = mock.calls.group;
    await mirrorTabGroups(db, w);
    expect(mock.calls.group).toBe(calls);
    expect(mock.tabGroups()).toHaveLength(1);
  });
  it('maps colors to the nearest Chrome color', () => {
    expect(nearestChromeColor('#e5484d')).toBe('red');
    expect(nearestChromeColor('#30a46c')).toBe('green');
    expect(nearestChromeColor('#0090ff')).toBe('blue');
    expect(nearestChromeColor('nonsense')).toBe('grey');
  });
});
describe('validation', () => {
  it('parseIds and parseName', () => {
    expect(parseIds(['a'])).toEqual(['a']);
    expect(() => parseIds('a')).toThrow();
    expect(() => parseIds([1])).toThrow();
    expect(() => parseIds(new Array<string>(5001).fill('x'))).toThrow();
    expect(parseIds(new Array<string>(5000).fill('x'))).toHaveLength(5000);
    expect(parseName(' a ')).toBe('a');
    expect(() => parseName('  ')).toThrow();
    expect(() => parseName(5)).toThrow();
    expect(() => parseName('x'.repeat(61))).toThrow();
    expect(parseName('x'.repeat(60))).toHaveLength(60);
  });
});
describe('updatedAt stamping (sync LWW)', () => {
  it('a change never stamps earlier than the record (fast-clock device stamped it ahead)', async () => {
    const future = Date.now() + 3 * 86_400_000;
    await db.groups.put(group('games'));
    await db.groups.put(group('news'));
    const a = await addItem({ state: 'stashed', updatedAt: future });
    await moveItems(db, [a.id], 'games');
    expect((await db.items.get(a.id))!.updatedAt).toBe(future + 1);
    await mergeGroups(db, 'games', 'news');
    expect((await db.items.get(a.id))!.updatedAt).toBe(future + 2);
    await deleteGroup(db, 'news');
    expect((await db.items.get(a.id))!.updatedAt).toBe(future + 3);
  });
});
