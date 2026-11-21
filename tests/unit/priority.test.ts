import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import {
  acceptSuggestion, createGroup, deleteGroup, mergeGroups, mirrorTabGroups, moveItems, regroupApply, regroupPreview, renameGroup,
} from '../../src/background/groups';
import {
  PRIORITY_RENAMED_KEY, ensurePriorityIn, migrateReservedName, prioritize, runPriorityCommand, unprioritize,
} from '../../src/background/priority';
import {
  configureTabIndex, embeddingKey, flushTabEvents, maybeSuggest, neighbourPool, processQueue, reconcile, reconcileNow, whenTabIndexIdle,
} from '../../src/background/tab-index';
import { suggestGroups } from '../../src/classify/cluster';
import { autoSleep, closeExtras, closeTabs, stash } from '../../src/background/memory';
import { flashBadge, resetBadgeCache, updateBadge } from '../../src/background/duplicates';
import { applyImport, exportJson, parseImport } from '../../src/io/import-export';
import { resetNameIndexForTests } from '../../src/background/names-load';
import { classify, type Head } from '../../src/classify/assign';
import { parseNames, setNameIndex } from '../../src/classify/names';
import { neighbourGroup, pickGroup, type Neighbour } from '../../src/classify/pick';
import { PRIORITY_COLOR, PRIORITY_GROUP_ID, PRIORITY_NAME, RESERVED_NAME_MESSAGE, newPriorityGroup } from '../../src/shared/priority';
import type { Group, Item } from '../../src/shared/types';
import { normalize } from '../../src/shared/vec';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
vi.mock('../../src/classify/cluster', async (orig) => {
  const m = await orig<typeof import('../../src/classify/cluster')>();
  return { ...m, suggestGroups: vi.fn(m.suggestGroups) };
});

const P = PRIORITY_GROUP_ID;
let n = 0;
let db: Db;
let mock: ChromeMockControl;
beforeEach(async () => {
  db = await openDb(`priority-${n++}`);
  mock = installChromeMock();
  resetNameIndexForTests();
});
afterEach(() => {
  mock.uninstall();
  setNameIndex(null);
  resetBadgeCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DIM = 384;
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

// ───────────────────────── the pipeline never picks Priority ─────────────────────────
describe('the automatic pipeline never places a tab in Priority', () => {
  const D = 16;
  const unit = (a: number) => normalize(Array.from({ length: D }, (_, d) => (d === a ? 1 : 0)));
  const axis = (i: number, w = 10) => Array.from({ length: D }, (_, d) => (d === i ? w : 0));
  // A head that reads axis 0 as "priority" (no real head has that label: this is the worst case).
  const head: Head = { model: 't', dim: D, labels: [P, 'other'], W: [axis(0), axis(9)], b: [0, 0], threshold: 0.6, similarity: 0.9 };
  const PAGE = { url: 'https://example.com/a', title: 'A page' };
  const YT = { url: 'https://www.youtube.com/watch?v=x', title: 'A video - YouTube' };
  const prio = { ...newPriorityGroup(), exemplars: [unit(0)], centroid: unit(0) };

  it('exemplar step: a vector equal to an exemplar in Priority does not go there', () => {
    expect(pickGroup(PAGE, unit(0), [prio], { ...head, labels: ['x', 'other'] }).groupId).toBeNull();
    expect(classify(unit(0), [prio], { ...head, labels: ['x', 'other'] }).groupId).toBeNull();
  });
  it('head step and the YouTube bar: the head’s top label "priority" is not used', () => {
    expect(pickGroup(PAGE, unit(0), [prio], head)).toEqual({ groupId: null, want: P, by: null });
    expect(pickGroup(YT, unit(0), [prio], head).groupId).toBeNull();
    expect(pickGroup(YT, unit(0), [prio, group('videos')], head).groupId).toBe('videos');
    expect(classify(unit(0), [prio], head).groupId).toBeNull();
  });
  it('name step: a name listed under "priority" never files a tab there', () => {
    setNameIndex(parseNames(`#${P}\nbreaking bad\n`));
    const search = { url: 'https://www.google.com/search?q=breaking+bad', title: 'breaking bad - Google Search' };
    expect(pickGroup(search, unit(5), [prio], { ...head, labels: ['x', 'other'] }).groupId).toBeNull();
  });
  it('rule step: a rule still wins with Priority present, and never names it', () => {
    const netflix = { url: 'https://www.netflix.com/title/1', title: 'X' };
    expect(pickGroup(netflix, unit(0), [prio, group('tv')], head)).toEqual({ groupId: 'tv', want: null, by: 'rule' });
  });
  it('neighbour step: tabs in Priority are never neighbours to follow', () => {
    const near = (j: number): Neighbour => {
      const v = new Array<number>(D).fill(0);
      v[4] = 0.95;
      v[j] = Math.sqrt(1 - 0.95 * 0.95);
      return { vec: v, groupId: P, normUrl: `https://n${j}.example.com/` };
    };
    const unsure = unit(4);
    const pool = [near(1), near(2), near(3)];
    expect(neighbourGroup(unsure, pool, [prio], { similarity: 0.9, min: 2, k: 10 })).toBeNull();
    expect(pickGroup(PAGE, unsure, [prio], { ...head, labels: ['x', 'other'] }, pool).groupId).toBeNull();
  });
  it('neighbourPool leaves Priority tabs out', async () => {
    await db.groups.put(newPriorityGroup());
    await db.groups.put(group('games'));
    const a = await addItem({ groupId: P, groupSource: 'user' });
    const b = await addItem({ groupId: 'games', groupSource: 'user' });
    const pool = await neighbourPool(db, await db.items.all(), await db.groups.all());
    expect(pool.map((p) => p.id)).toEqual([b.id]);
    expect(pool.some((p) => p.id === a.id)).toBe(false);
  });
  it('classification and re-classification (title or address change) keep a Priority tab where it is', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://www.netflix.com/title/1', title: 'Show', status: 'complete' }] }] });
    await db.groups.put(group('tv'));
    await reconcile(db, await chrome.tabs.query({}));
    const embed = async (t: string[]) => t.map((x) => vecFor(x));
    await processQueue(db, embed);
    const [item] = await db.items.all();
    expect(item!.groupId).toBe('tv');
    await prioritize(db, [item!.id]);
    const [tab] = mock.tabs();
    mock.updateTab(tab!.id!, { title: 'Another title', url: 'https://www.netflix.com/title/2' });
    const r = await reconcile(db, await chrome.tabs.query({}));
    expect(r.enqueued).toBe(1);
    await processQueue(db, embed);
    expect((await db.items.get(item!.id))!.groupId).toBe(P);
  });
  it('regroup neither moves a tab into Priority nor takes one out', async () => {
    await db.groups.put({ ...newPriorityGroup(), exemplars: [Array.from(vecFor('alpha'))] });
    await db.groups.put(group('games'));
    const auto = await addItem({ groupId: null }, 'alpha');
    const starred = await addItem({ groupId: P, groupSource: 'user', beforePriority: { groupId: 'games', groupSource: 'auto' } }, 'beta');
    expect((await regroupPreview(db)).some((r) => r.groupId === P)).toBe(false);
    await regroupApply(db);
    expect((await db.items.get(auto.id))!.groupId).not.toBe(P);
    expect((await db.items.get(starred.id))!.groupId).toBe(P);
  });
});

// ───────────────────────── adding and removing ─────────────────────────
describe('prioritize / unprioritize', () => {
  it('creates the group on first use, remembers where each tab was, and teaches nothing', async () => {
    await db.groups.put(group('games'));
    const a = await addItem({ groupId: 'games', groupSource: 'auto', placedBy: 'head' });
    const b = await addItem({ groupId: null });
    expect(await db.groups.get(P)).toBeUndefined();
    expect(await prioritize(db, [a.id, b.id, 'missing'])).toBe(2);
    const g = (await db.groups.get(P))!;
    expect(g).toMatchObject({ name: PRIORITY_NAME, color: PRIORITY_COLOR, exemplars: [], centroid: null });
    expect(g.lessons).toBeUndefined();
    expect((await db.groups.get('games'))!.exemplars).toEqual([]);
    const ia = (await db.items.get(a.id))!;
    expect(ia).toMatchObject({ groupId: P, groupSource: 'user', beforePriority: { groupId: 'games', groupSource: 'auto', placedBy: 'head' } });
    expect(ia.placedBy).toBeUndefined();
    expect(ia.updatedAt).toBeGreaterThan(a.updatedAt);
    expect((await db.items.get(b.id))!.beforePriority).toEqual({ groupId: null, groupSource: 'auto' });
    // Adding again is a no-op.
    expect(await prioritize(db, [a.id])).toBe(0);
    expect((await db.items.get(a.id))!.beforePriority!.groupId).toBe('games');
  });
  it('moving into Priority with "Move to group" is the same as the star: no exemplar, no lesson', async () => {
    await db.groups.put(newPriorityGroup());
    const a = await addItem({}, 'alpha');
    await moveItems(db, [a.id], P, async (t) => t.map(() => vecFor('alpha')));
    const g = (await db.groups.get(P))!;
    expect([g.exemplars.length, g.lessons?.length ?? 0]).toEqual([0, 0]);
    expect((await db.items.get(a.id))!.beforePriority).toEqual({ groupId: null, groupSource: 'auto' });
  });
  it('removing puts a tab back where it was, as it was placed', async () => {
    await db.groups.put(group('games'));
    await db.groups.put(group('news'));
    const a = await addItem({ groupId: 'games', groupSource: 'auto', placedBy: 'neighbour' });
    const b = await addItem({ groupId: 'news', groupSource: 'user' });
    await prioritize(db, [a.id, b.id]);
    expect(await unprioritize(db, [a.id, b.id])).toEqual({ removed: 2, queued: 0 });
    const ia = (await db.items.get(a.id))!;
    expect(ia).toMatchObject({ groupId: 'games', groupSource: 'auto', placedBy: 'neighbour' });
    expect(ia.beforePriority).toBeUndefined();
    expect(await db.items.get(b.id)).toMatchObject({ groupId: 'news', groupSource: 'user' });
    // Removing one that is not in Priority is a no-op.
    expect(await unprioritize(db, [a.id])).toEqual({ removed: 0, queued: 0 });
  });
  it('removing a tab whose group is gone (or that had none) leaves it to the pipeline', async () => {
    await db.groups.put(group('games'));
    const a = await addItem({ groupId: 'games', groupSource: 'user' });
    const b = await addItem({ groupId: null });
    const c = await addItem({ groupId: null, classifiable: false, url: 'chrome://settings' });
    // A browser page is never added (the same rule as the shortcut).
    expect(await prioritize(db, [a.id, b.id, c.id])).toBe(2);
    expect((await db.items.get(c.id))!.groupId).toBeNull();
    await deleteGroup(db, 'games');
    expect(await unprioritize(db, [a.id, b.id, c.id])).toEqual({ removed: 2, queued: 2 });
    for (const id of [a.id, b.id]) expect(await db.items.get(id)).toMatchObject({ groupId: null, groupSource: 'auto' });
    expect(await db.queue.take(10)).toEqual(expect.arrayContaining([a.id, b.id]));
  });
  it('a tab moved out of Priority with "Move to group" forgets its old group and teaches the new one', async () => {
    await db.groups.put(group('games'));
    await db.groups.put(group('news'));
    const a = await addItem({ groupId: 'games', groupSource: 'auto' }, 'alpha');
    await prioritize(db, [a.id]);
    await moveItems(db, [a.id], 'news');
    const ia = (await db.items.get(a.id))!;
    expect([ia.groupId, ia.groupSource, ia.beforePriority]).toEqual(['news', 'user', undefined]);
    expect((await db.groups.get('news'))!.exemplars).toHaveLength(1);
    expect(await unprioritize(db, [a.id])).toEqual({ removed: 0, queued: 0 });
  });
  it('a tab saved for later from Priority stays in Priority and keeps where it was', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.example.com/' }, { url: 'https://b.example.com/' }] }] });
    await db.groups.put(group('games'));
    await reconcile(db, await chrome.tabs.query({}));
    const [a] = (await db.items.all()).filter((i) => i.url === 'https://a.example.com/');
    await db.items.put({ ...a!, groupId: 'games', groupSource: 'user' });
    await prioritize(db, [a!.id]);
    await stash(db, [a!.id]);
    const saved = (await db.items.byState('stashed'))[0]!;
    expect(saved).toMatchObject({ groupId: P, groupSource: 'user', beforePriority: { groupId: 'games', groupSource: 'user' } });
  });
  it('the group cannot be renamed, merged or deleted, and its name is kept for it', async () => {
    await db.groups.put(newPriorityGroup());
    await db.groups.put(group('games'));
    await expect(renameGroup(db, P, 'Urgent')).rejects.toThrow(/cannot be renamed/);
    await expect(mergeGroups(db, P, 'games')).rejects.toThrow(/cannot be merged/);
    await expect(mergeGroups(db, 'games', P)).rejects.toThrow(/cannot be merged/);
    await expect(deleteGroup(db, P)).rejects.toThrow(/cannot be deleted/);
    await expect(createGroup(db, 'priority', [])).rejects.toThrow(RESERVED_NAME_MESSAGE);
    await expect(renameGroup(db, 'games', ' PRIORITY ')).rejects.toThrow(RESERVED_NAME_MESSAGE);
  });
  it('a group of the user’s called Priority is never taken over: it becomes “Priority (yours)”; only its saved tabs go to Priority, unstamped', async () => {
    const old = group('g-old', { name: 'priority', builtIn: false, exemplars: [[1, 0]], lessons: [['x', 1]], centroid: [1, 0] });
    await db.groups.put(old);
    const auto = await addItem({ groupId: 'g-old', groupSource: 'auto', placedBy: 'exemplar' });
    const saved = await addItem({ groupId: 'g-old', groupSource: 'user', state: 'stashed', tabId: undefined });
    const b = await addItem();
    await prioritize(db, [b.id]);
    expect(await db.groups.get('g-old')).toEqual({ ...old, name: 'Priority (yours)' });
    expect(await db.groups.get(P)).toMatchObject({ name: PRIORITY_NAME, exemplars: [] });
    expect(await db.items.get(auto.id)).toEqual(auto); // the model's placement stays where it was
    // The saved tab syncs as "Priority" on every device: it moves into the built-in group with the same sync stamp,
    // remembering the renamed group (taking it out of Priority here puts it back there).
    expect(await db.items.get(saved.id)).toEqual({
      ...saved, groupId: P, groupSource: 'user', beforePriority: { groupId: 'g-old', groupSource: 'user' },
    });
    expect((await db.items.all()).filter((i) => i.groupId === P).map((i) => i.id).sort()).toEqual([b.id, saved.id].sort());
    await unprioritize(db, [saved.id]);
    expect((await db.items.get(saved.id))!.groupId).toBe('g-old');
    expect((await chrome.storage.local.get(PRIORITY_RENAMED_KEY))[PRIORITY_RENAMED_KEY]).toEqual(['Priority (yours)']);
    // Once it exists, ensuring it changes nothing.
    expect(await db.tx(['items', 'groups'], (s2) => ensurePriorityIn(s2))).toEqual([]);
  });
  it('the migration renames on its own (numbered when the name is taken) and leaves the built-in group alone', async () => {
    await db.groups.put(newPriorityGroup());
    await db.groups.put(group('g-a', { name: 'Priority (yours)', builtIn: false }));
    await db.groups.put(group('g-b', { name: 'PRIORITY', builtIn: false }));
    await db.groups.put(group('sug', { name: 'Priority', builtIn: false, suggested: true }));
    expect(await migrateReservedName(db)).toBe(1); // the suggestion is renamed too, but not announced
    expect((await db.groups.get('g-b'))!.name).toBe('Priority (yours) 2');
    expect((await db.groups.get('sug'))!.name).toBe('Priority (yours) 3');
    expect((await db.groups.get(P))!.name).toBe(PRIORITY_NAME);
    expect(await migrateReservedName(db)).toBe(0);
    expect((await chrome.storage.local.get(PRIORITY_RENAMED_KEY))[PRIORITY_RENAMED_KEY]).toEqual(['Priority (yours) 2']);
  });
  it('numbering is stable: holders are renamed in id order', async () => {
    await db.groups.put(group('g-z', { name: 'Priority', builtIn: false }));
    await db.groups.put(group('g-a', { name: 'priority', builtIn: false }));
    await migrateReservedName(db);
    expect([(await db.groups.get('g-a'))!.name, (await db.groups.get('g-z'))!.name]).toEqual(['Priority (yours)', 'Priority (yours) 2']);
  });
  it('the migration creates the built-in group for saved tabs when it is missing', async () => {
    await db.groups.put(group('g-old', { name: 'Priority', builtIn: false }));
    const saved = await addItem({ groupId: 'g-old', groupSource: 'user', state: 'stashed', tabId: undefined });
    expect(await migrateReservedName(db)).toBe(1);
    expect(await db.groups.get(P)).toMatchObject({ name: PRIORITY_NAME });
    expect((await db.items.get(saved.id))!.groupId).toBe(P);
  });
  it('mirroring: the renamed group’s native tab group is retitled on the next pass', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/' }] }] });
    mock.setPermission('tabGroups', true);
    await db.settings.set({ mirrorTabGroups: true });
    await db.groups.put(group('g-old', { name: 'Priority', builtIn: false }));
    await reconcile(db, await chrome.tabs.query({}));
    const [item] = await db.items.all();
    await db.items.put({ ...item!, groupId: 'g-old', groupSource: 'user' });
    const w = mock.tabs()[0]!.windowId!;
    await mirrorTabGroups(db, w);
    expect(mock.tabGroups().map((g) => g.title)).toEqual(['Priority']);
    await migrateReservedName(db);
    await mirrorTabGroups(db, w);
    expect(mock.tabGroups().map((g) => g.title)).toEqual(['Priority (yours)']);
  });
  it('accepting a suggestion named Priority (made before the name was reserved) renames it', async () => {
    await db.groups.put(group('sug', { name: 'Priority', builtIn: false, suggested: true }));
    await addItem({ groupId: 'sug' });
    await acceptSuggestion(db, 'sug');
    expect(await db.groups.get('sug')).toMatchObject({ name: 'Priority (yours)' });
    expect((await db.groups.get('sug'))!.suggested).toBeUndefined();
  });
  it('topic discovery never names a suggestion Priority', async () => {
    const tabs = await Promise.all([0, 1, 2, 3].map((k) => addItem({ url: `https://p${k}.example.com/` }, 'same')));
    vi.mocked(suggestGroups).mockReturnValueOnce([{ name: 'Priority', itemIds: tabs.map((t) => t.id) }] as never);
    await maybeSuggest(db);
    const made = (await db.groups.all()).filter((g) => g.suggested);
    expect(made.map((g) => g.name)).toEqual(['Priority 2']);
  });
  it('a merge keeps where a Priority tab came from (it goes back to the merged group)', async () => {
    await db.groups.put(group('games', { builtIn: false }));
    await db.groups.put(group('fun', { builtIn: false }));
    const a = await addItem({ groupId: 'games', groupSource: 'user' });
    await prioritize(db, [a.id]);
    await mergeGroups(db, 'games', 'fun');
    expect((await db.items.get(a.id))!.beforePriority!.groupId).toBe('fun');
    await unprioritize(db, [a.id]);
    expect(await db.items.get(a.id)).toMatchObject({ groupId: 'fun', groupSource: 'user' });
  });
});

// ───────────────────────── automatic actions leave Priority alone ─────────────────────────
describe('Auto-pause and duplicate cleanup', () => {
  it('Auto-pause never pauses a tab in Priority', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/', active: true }, { url: 'https://old.com/' }, { url: 'https://star.com/' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const now = Date.now();
    for (const i of await db.items.all()) if (i.url !== 'https://a.com/') await db.items.put({ ...i, lastActiveAt: now - 3 * 3_600_000 });
    const star = (await db.items.all()).find((i) => i.url === 'https://star.com/')!;
    await prioritize(db, [star.id]);
    await db.settings.set({ autoSleepMinutes: 60 });
    expect(await autoSleep(db, now)).toBe(1);
    expect(mock.tabs().filter((t) => t.discarded).map((t) => t.url)).toEqual(['https://old.com/']);
  });
  it('Close duplicates never closes a Priority tab or a pinned one; only the other copies close', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [
      { url: 'https://dup.com/', pinned: true }, { url: 'https://dup.com/' }, { url: 'https://dup.com/', active: true },
    ] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const [pinned, starred, active] = mock.tabs();
    await prioritize(db, [(await db.items.byTabId(starred!.id!))!.id]);
    await closeExtras(db);
    expect(mock.tabs().map((t) => t.id)).toEqual([pinned!.id, starred!.id]);
    expect(active).toBeDefined();
  });
  it('two copies in Priority both stay; with no Priority or pinned copy the best one stays as before', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [
      { url: 'https://two.com/' }, { url: 'https://two.com/' }, { url: 'https://plain.com/' }, { url: 'https://plain.com/', active: true },
    ] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const [s1, s2, , keep] = mock.tabs();
    await prioritize(db, [(await db.items.byTabId(s1!.id!))!.id, (await db.items.byTabId(s2!.id!))!.id]);
    expect((await closeExtras(db)).closed).toBe(1);
    expect(mock.tabs().map((t) => t.id)).toEqual([s1!.id, s2!.id, keep!.id]);
  });
  it('closing every copy from the Duplicates view keeps the Priority copy', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://d.com/', active: true }, { url: 'https://d.com/' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const [, starred] = mock.tabs();
    await prioritize(db, [(await db.items.byTabId(starred!.id!))!.id]);
    const r = await closeTabs(db, (await db.items.all()).map((i) => i.id), { keepOne: true });
    expect(r.kept).toBe(1);
    expect(mock.tabs().map((t) => t.id)).toEqual([starred!.id]);
  });
});

// ───────────────────────── the shortcuts ─────────────────────────
describe('the Alt+P / Alt+Shift+P command handler', () => {
  const deps = () => ({ catchUp: vi.fn(async () => undefined), kick: vi.fn() });
  async function setup(tabs: Partial<chrome.tabs.Tab>[]) {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs }] });
    await db.groups.put(group('games'));
    await reconcile(db, await chrome.tabs.query({}));
    return mock.tabs();
  }
  it('adds the tab, does nothing the second time, removes it, and does nothing again', async () => {
    const [tab] = await setup([{ url: 'https://a.com/', active: true }]);
    const item = (await db.items.byTabId(tab!.id!))!;
    await db.items.put({ ...item, groupId: 'games', groupSource: 'user' });
    const d = deps();
    expect(await runPriorityCommand(db, 'prioritize-tab', tab, d)).toBe('added');
    expect((await db.items.byTabId(tab!.id!))!.groupId).toBe(P);
    expect(await runPriorityCommand(db, 'prioritize-tab', tab, d)).toBe('none');
    expect(await runPriorityCommand(db, 'unprioritize-tab', tab, d)).toBe('removed');
    expect((await db.items.byTabId(tab!.id!))!.groupId).toBe('games');
    expect(await runPriorityCommand(db, 'unprioritize-tab', tab, d)).toBe('none');
    expect(d.kick).not.toHaveBeenCalled(); // it went back to its group: nothing to classify
  });
  it('a removal with no group to go back to kicks classification', async () => {
    const [tab] = await setup([{ url: 'https://a.com/', active: true }]);
    const d = deps();
    await runPriorityCommand(db, 'prioritize-tab', tab, d);
    expect(await runPriorityCommand(db, 'unprioritize-tab', tab, d)).toBe('removed');
    expect(d.kick).toHaveBeenCalledTimes(1);
  });
  it('Tablight’s own pages, browser pages, incognito tabs and no tab do nothing', async () => {
    const tabs = await setup([
      { url: 'chrome-extension://mock-extension-id/dashboard.html' }, { url: 'chrome://settings/' }, { url: 'https://a.com/' },
    ]);
    const d = deps();
    expect(await runPriorityCommand(db, 'prioritize-tab', tabs[0], d)).toBe('none');
    expect(await runPriorityCommand(db, 'prioritize-tab', tabs[1], d)).toBe('none');
    expect(await runPriorityCommand(db, 'prioritize-tab', { ...tabs[2]!, incognito: true }, d)).toBe('none');
    expect(await runPriorityCommand(db, 'prioritize-tab', undefined, d)).toBe('none');
    expect(await db.groups.get(P)).toBeUndefined();
    expect(d.catchUp).not.toHaveBeenCalled();
  });
  it('a record of another page holding the tab id (stale ids after a restart) is never starred: catch up first', async () => {
    const [tab] = await setup([{ url: 'https://a.com/' }]);
    const item = (await db.items.byTabId(tab!.id!))!;
    await db.items.put({ ...item, url: 'https://old.com/', normUrl: 'https://old.com/' }); // last session's page
    const d = deps();
    expect(await runPriorityCommand(db, 'prioritize-tab', tab, d)).toBe('none');
    expect(d.catchUp).toHaveBeenCalledTimes(1);
    expect((await db.items.get(item.id))!.groupId).not.toBe(P);
    const catchUp = vi.fn(async () => void (await reconcile(db, await chrome.tabs.query({}), { newSession: true })));
    expect(await runPriorityCommand(db, 'prioritize-tab', tab, { catchUp, kick: vi.fn() })).toBe('added');
    expect((await db.items.byTabId(tab!.id!))!).toMatchObject({ normUrl: 'https://a.com/', groupId: P });
  });
  it('the catch-up never races a debounced update (a new starred tab is not deleted) and never waits for classification', async () => {
    const [first] = await setup([{ url: 'https://a.com/' }]);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    configureTabIndex({ db: async () => db, after: () => blocked }); // classification that never ends (until released)
    // A debounced update reads the tabs before the new tab exists, and is slow to get its answer.
    const before = await chrome.tabs.query({});
    let answer!: (t: chrome.tabs.Tab[]) => void;
    const query = vi.spyOn(chrome.tabs, 'query').mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    const flushing = flushTabEvents();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const fresh = mock.addTab({ url: 'https://new.com/', windowId: first!.windowId });
    // The stale snapshot arrives a moment later. Unserialized, the catch-up and the star would land first and the stale
    // snapshot would then delete the new tab's item; serialized, the catch-up reads the tabs after it.
    setTimeout(() => answer(before), 50);
    expect(await runPriorityCommand(db, 'prioritize-tab', fresh, { catchUp: reconcileNow, kick: vi.fn() })).toBe('added');
    // (classification is still blocked here: the catch-up did not wait for it)
    expect((await db.items.byTabId(fresh.id!))!.groupId).toBe(P);
    release();
    await flushing;
    await whenTabIndexIdle();
    expect((await db.items.byTabId(fresh.id!))!.groupId).toBe(P);
    configureTabIndex({ db: async () => db });
  });
  it('a tab not indexed yet is caught up first', async () => {
    const [tab] = await setup([{ url: 'https://a.com/' }]);
    const fresh = mock.addTab({ url: 'https://new.com/', windowId: tab!.windowId });
    const catchUp = vi.fn(async () => void (await reconcile(db, await chrome.tabs.query({}))));
    expect(await runPriorityCommand(db, 'prioritize-tab', fresh, { catchUp, kick: vi.fn() })).toBe('added');
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect((await db.items.byTabId(fresh.id!))!.groupId).toBe(P);
  });
  it('the badge shows the feedback for a moment, then what Tablight showed there before', async () => {
    const [a, b] = await setup([{ url: 'https://dup.com/' }, { url: 'https://dup.com/' }]);
    await updateBadge(db);
    expect(mock.badgeText(a!.id)).toBe('2×');
    await flashBadge(a!.id!, '★', () => updateBadge(db, a!.id), 40);
    expect(mock.badgeText(a!.id)).toBe('★');
    await updateBadge(db); // a refresh during the flash leaves it alone
    expect(mock.badgeText(a!.id)).toBe('★');
    expect(mock.badgeText(b!.id)).toBe('2×');
    await vi.waitFor(() => expect(mock.badgeText(a!.id)).toBe('2×'));
  });
});

// ───────────────────────── persistence ─────────────────────────
describe('persistence', () => {
  it('the data is in IndexedDB (a second connection reads it; the worker restart is in priority-worker.test.ts)', async () => {
    const name = `priority-reopen-${n++}`;
    const first = await openDb(name);
    await first.items.put({
      id: 'x', url: 'https://a.com/', normUrl: 'https://a.com/', title: 'A', domain: 'a.com', state: 'open', groupId: null,
      groupSource: 'auto', kind: 'other', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true,
    });
    await prioritize(first, ['x']);
    const again = await openDb(name);
    expect(await again.groups.get(P)).toBeDefined();
    expect(await again.items.get('x')).toMatchObject({ groupId: P, beforePriority: { groupId: null } });
  });
  it('export names the group; import into an empty profile puts saved and open tabs in the built-in Priority', async () => {
    await db.groups.put(group('games'));
    const saved = await addItem({ state: 'stashed', tabId: undefined, url: 'https://saved.com/' });
    const open = await addItem({ url: 'https://open.com/' });
    await prioritize(db, [saved.id, open.id]);
    const json = await exportJson(db);
    const file = JSON.parse(json) as { groups: { id: string; name: string }[]; items: { groupName: string }[]; tabs: { url: string; groupName: string }[] };
    expect(file.groups.map((g) => g.name)).toContain(PRIORITY_NAME);
    expect(file.items[0]!.groupName).toBe(PRIORITY_NAME);
    expect(file.tabs.find((t) => t.url === 'https://open.com/')!.groupName).toBe(PRIORITY_NAME);
    expect(json).not.toContain('beforePriority'); // where a tab came from stays on this device

    const other = await openDb(`priority-import-${n++}`);
    await other.groups.put(group('games'));
    await other.items.put({ ...open, id: 'here', groupId: 'games', groupSource: 'auto' });
    const parsed = parseImport(json);
    if (!parsed.ok) throw new Error(parsed.error);
    await applyImport(other, parsed.data);
    const groups = await other.groups.all();
    expect(groups.filter((g) => g.name.toLowerCase() === 'priority').map((g) => g.id)).toEqual([P]);
    expect((await other.items.byState('stashed'))[0]).toMatchObject({ groupId: P, groupSource: 'user' });
    expect(await other.items.get('here')).toMatchObject({ groupId: P, groupSource: 'user', beforePriority: { groupId: 'games', groupSource: 'auto' } });
  });
  it('importing a backup never takes an open tab out of Priority, nor loses where it came from', async () => {
    await db.groups.put(group('games', { name: 'Games', builtIn: false }));
    await db.groups.put(group('news', { name: 'News', builtIn: false }));
    const open = await addItem({ url: 'https://open.com/', groupId: 'news', groupSource: 'auto' });
    await prioritize(db, [open.id]);
    const json = JSON.stringify({ format: 'tab-organizer', version: 1, groups: [], items: [], snapshots: [],
      tabs: [{ url: 'https://open.com/', title: 'Open', groupName: 'Games' }] });
    const parsed = parseImport(json);
    if (!parsed.ok) throw new Error(parsed.error);
    expect((await applyImport(db, parsed.data)).grouped).toBe(0);
    expect(await db.items.get(open.id)).toMatchObject({ groupId: P, beforePriority: { groupId: 'news', groupSource: 'auto' } });
  });
  it('mirrors Priority as a yellow native tab group when mirroring is on', async () => {
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/' }] }] });
    mock.setPermission('tabGroups', true);
    await reconcile(db, await chrome.tabs.query({}));
    const [item] = await db.items.all();
    await prioritize(db, [item!.id]);
    await db.settings.set({ mirrorTabGroups: true });
    const update = vi.spyOn(chrome.tabGroups, 'update');
    await mirrorTabGroups(db, mock.tabs()[0]!.windowId!);
    expect(update).toHaveBeenCalledWith(expect.any(Number), { title: PRIORITY_NAME, color: 'yellow' });
  });
});
