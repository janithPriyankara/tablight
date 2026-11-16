import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { autoSleep, closeExtras, closeTabs, openItem, sleepTabs, stash, undo } from '../../src/background/memory';
import { reconcile } from '../../src/background/tab-index';
import { SYNCED_IDS_KEY } from '../../src/background/sync';
import { sha1hex } from '../../src/shared/hash';
import type { Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
let n = 0;
let db: Db;
let mock: ChromeMockControl;
beforeEach(async () => {
  db = await openDb(`memory-${n++}`);
});
afterEach(() => {
  mock.uninstall();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function setup(tabs: Partial<chrome.tabs.Tab>[]): Promise<Item[]> {
  mock = installChromeMock({ windows: [{ tabs }] });
  await reconcile(db, await chrome.tabs.query({}));
  return db.items.all();
}
const byUrl = (items: Item[], url: string) => items.find((i) => i.url === url)!;
describe('sleepTabs / autoSleep', () => {
  const tabs = [
    { url: 'https://active.com/', active: true },
    { url: 'https://pinned.com/', pinned: true },
    { url: 'https://audio.com/', audible: true },
    { url: 'https://plain.com/' },
    { url: 'https://asleep.com/', discarded: true },
    { url: 'chrome://settings/' },
  ];
  it('skips active, pinned, audible, discarded and non-web tabs', async () => {
    const items = await setup(tabs);
    const discard = vi.spyOn(chrome.tabs, 'discard');
    const r = await sleepTabs(db, items.map((i) => i.id).concat('missing'));
    expect(r).toEqual({ slept: 1, skipped: 6 });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(mock.tabs().find((t) => t.url === 'https://plain.com/')!.discarded).toBe(true);
  });
  it('autoSleepMinutes null does nothing; 60 sleeps only tabs inactive > 60 min', async () => {
    const items = await setup([{ url: 'https://a.com/', active: true }, { url: 'https://old.com/' }, { url: 'https://new.com/' }]);
    const now = Date.now();
    await db.items.put({ ...byUrl(items, 'https://old.com/'), lastActiveAt: now - 61 * 60_000 });
    await db.items.put({ ...byUrl(items, 'https://new.com/'), lastActiveAt: now - 59 * 60_000 });
    expect(await autoSleep(db, now)).toBe(0);
    expect(mock.tabs().some((t) => t.discarded)).toBe(false);
    await db.settings.set({ autoSleepMinutes: 60 });
    expect(await autoSleep(db, now)).toBe(1);
    expect(mock.tabs().filter((t) => t.discarded).map((t) => t.url)).toEqual(['https://old.com/']);
  });
});
describe('stash', () => {
  it('stores a stashed record (new id from normUrl, group kept) and closes the tab; skips non-web', async () => {
    const items = await setup([{ url: 'https://a.com/x?utm_source=1' }, { url: 'chrome://settings/' }]);
    const a = byUrl(items, 'https://a.com/x?utm_source=1');
    await db.items.put({ ...a, groupId: 'g1', groupSource: 'user' });
    const r = await stash(db, items.map((i) => i.id));
    expect(r.skipped).toBe(1);
    const id = await sha1hex('https://a.com/x');
    const rec = (await db.items.get(id))!;
    expect(rec).toMatchObject({ state: 'stashed', groupId: 'g1', groupSource: 'user', url: a.url, title: a.title });
    expect(rec.tabId).toBeUndefined();
    expect(rec.windowId).toBeUndefined();
    expect(rec.stashedAt).toBeDefined();
    expect(await db.items.get(a.id)).toBeUndefined();
    expect(mock.tabs().map((t) => t.url)).toEqual(['chrome://settings/']);
    // Reconcile does not match the remaining tab onto the stash record.
    await reconcile(db, await chrome.tabs.query({}));
    expect((await db.items.get(id))!.state).toBe('stashed');
  });
  it('writes the stash before tabs.remove: a failing remove never loses the tab', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    vi.spyOn(chrome.tabs, 'remove').mockRejectedValue(new Error('boom'));
    await stash(db, [items[0]!.id]);
    const stashed = await db.items.byState('stashed');
    expect(stashed).toHaveLength(1);
    expect(mock.tabs()).toHaveLength(1);
  });
  it('stashing the same page twice keeps one record, earliest stashedAt, newest title', async () => {
    const items = await setup([{ url: 'https://a.com/x', title: 'Old' }, { url: 'https://www.a.com/x/', title: 'New' }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await stash(db, [byUrl(items, 'https://a.com/x').id]);
    vi.setSystemTime(5_000);
    await stash(db, [byUrl(items, 'https://www.a.com/x/').id]);
    const st = await db.items.byState('stashed');
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ stashedAt: 1_000, title: 'New' });
  });
  it('undo recreates the tabs (group kept) and removes only the stash records it created', async () => {
    const items = await setup([{ url: 'https://a.com/' }, { url: 'https://b.com/' }]);
    await db.items.put({ ...byUrl(items, 'https://a.com/'), groupId: 'g1', groupSource: 'user' });
    const { token } = await stash(db, items.map((i) => i.id));
    expect(mock.tabs()).toHaveLength(0);
    // a.com's record already reached storage.sync; b.com's never did.
    await chrome.storage.local.set({ [SYNCED_IDS_KEY]: [await sha1hex('https://a.com/')] });
    expect(await undo(db, token)).toBe(true);
    expect(mock.tabs().map((t) => t.url).sort()).toEqual(['https://a.com/', 'https://b.com/']);
    expect(await db.items.byState('stashed')).toHaveLength(0);
    // A tombstone keeps sync from bringing a synced record back; a never-synced one needs none.
    expect((await db.tombstones.all()).map((t) => t.id)).toEqual([await sha1hex('https://a.com/')]);
    await reconcile(db, await chrome.tabs.query({}));
    const all = await db.items.all();
    expect(all).toHaveLength(2);
    expect(byUrl(all, 'https://a.com/').groupId).toBe('g1');
    expect(await undo(db, token)).toBe(false); // one use
  });
});
describe('undo safety', () => {
  it('keeps the stash record when recreating the tab fails', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    const { token } = await stash(db, [items[0]!.id]);
    vi.spyOn(chrome.tabs, 'create').mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await undo(db, token);
    expect(await db.items.byState('stashed')).toHaveLength(1);
  });
  it('keeps the stash record of a tab that never closed', async () => {
    const items = await setup([{ url: 'https://a.com/' }, { url: 'https://b.com/' }]);
    const a = byUrl(items, 'https://a.com/');
    const remove = chrome.tabs.remove.bind(chrome.tabs);
    vi.spyOn(chrome.tabs, 'remove').mockImplementation((id: number | number[]) =>
      [id].flat().includes(a.tabId!) ? Promise.reject(new Error('boom')) : remove(id as number));
    const { token } = await stash(db, items.map((i) => i.id));
    expect(await undo(db, token)).toBe(true);
    const stashed = await db.items.byState('stashed');
    expect(stashed.map((i) => i.url)).toEqual(['https://a.com/']);
    expect(mock.tabs().filter((t) => t.url === 'https://b.com/')).toHaveLength(1);
  });
  it('restores the group when reconcile indexed the recreated tab before adopt', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    await db.items.put({ ...items[0]!, groupId: 'g1', groupSource: 'user' });
    const { token } = await stash(db, [items[0]!.id]);
    const create = chrome.tabs.create.bind(chrome.tabs);
    vi.spyOn(chrome.tabs, 'create').mockImplementation(async (p) => {
      const tab = await create(p);
      await reconcile(db, await chrome.tabs.query({})); // the debounced reconcile wins the race
      return tab;
    });
    await undo(db, token);
    const all = await db.items.all();
    expect(all.filter((i) => i.state !== 'stashed')).toHaveLength(1);
    expect(all.find((i) => i.state === 'open')).toMatchObject({ groupId: 'g1', groupSource: 'user' });
  });
});
describe('minor behaviors', () => {
  it('closeExtras keeps a pinned copy over a more recent one', async () => {
    const items = await setup([{ url: 'https://k.com/' }, { url: 'https://a.com/x', pinned: true }, { url: 'https://a.com/x?utm_source=1' }]);
    await db.items.put({ ...byUrl(items, 'https://a.com/x?utm_source=1'), lastActiveAt: Date.now() + 1e6 });
    await closeExtras(db);
    expect(mock.tabs().map((t) => t.url).sort()).toEqual(['https://a.com/x', 'https://k.com/']);
  });
  it('stash skipped counts only non-web/missing ids, deduped', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    const id = items[0]!.id;
    expect((await stash(db, [id, id, 'missing'])).skipped).toBe(1);
  });
  it('openItem succeeds when windows.update rejects', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    vi.spyOn(chrome.windows, 'update').mockRejectedValue(new Error('no window'));
    await expect(openItem(db, items[0]!.id)).resolves.toBeUndefined();
  });
});
describe('openItem', () => {
  it('focuses an open tab and its window', async () => {
    const items = await setup([{ url: 'https://a.com/', active: true }, { url: 'https://b.com/' }]);
    const win = vi.spyOn(chrome.windows, 'update');
    await openItem(db, byUrl(items, 'https://b.com/').id);
    expect(mock.tabs().find((t) => t.url === 'https://b.com/')!.active).toBe(true);
    expect(win).toHaveBeenCalledWith(expect.any(Number), { focused: true });
  });
  it('errors when the tab no longer exists', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    mock.removeTab(items[0]!.tabId!);
    await expect(openItem(db, items[0]!.id)).rejects.toThrow('tab no longer exists');
  });
  it('refuses an unsafe stashed url without creating a tab', async () => {
    mock = installChromeMock();
    const create = vi.spyOn(chrome.tabs, 'create');
    for (const url of ['javascript:alert(1)', 'https://user:pw@a.com/']) {
      await db.items.put({
        id: 'bad', url, normUrl: url, title: 't', domain: '', state: 'stashed', groupId: null, groupSource: 'auto',
        kind: 'other', createdAt: 1, lastActiveAt: 1, stashedAt: 1, updatedAt: 1, classifiable: false,
      });
      await expect(openItem(db, 'bad')).rejects.toThrow('unsafe url');
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('opens a stash; removeOnOpen deletes it and writes a tombstone (once synced), else keeps it', async () => {
    const items = await setup([{ url: 'https://a.com/' }, { url: 'https://n.com/' }]);
    await stash(db, items.map((i) => i.id));
    const id = await sha1hex('https://a.com/');
    await chrome.storage.local.set({ [SYNCED_IDS_KEY]: [id] });
    await openItem(db, await sha1hex('https://n.com/')); // never synced: no tombstone
    await db.settings.set({ removeOnOpen: false });
    await openItem(db, id);
    expect(mock.tabs()).toHaveLength(2);
    expect(await db.items.get(id)).toBeDefined();
    expect(await db.tombstones.all()).toEqual([]);
    await db.settings.set({ removeOnOpen: true });
    await openItem(db, id);
    expect(await db.items.get(id)).toBeUndefined();
    expect(await db.tombstones.all()).toMatchObject([{ id }]);
  });
});
describe('closeExtras / closeTabs / undo', () => {
  it('keeps the most recently active copy', async () => {
    const items = await setup([{ url: 'https://b.com/' }, { url: 'https://a.com/x' }, { url: 'https://a.com/x?utm_source=1' }]);
    await db.items.put({ ...byUrl(items, 'https://a.com/x'), lastActiveAt: 10 });
    await db.items.put({ ...byUrl(items, 'https://a.com/x?utm_source=1'), lastActiveAt: 99 });
    const r = await closeExtras(db);
    expect(r.closed).toBe(1);
    expect(mock.tabs().map((t) => t.url).sort()).toEqual(['https://a.com/x?utm_source=1', 'https://b.com/']);
  });
  it('undo within 10 s recreates web tabs only; after 10 s returns false', async () => {
    const items = await setup([{ url: 'https://a.com/' }, { url: 'chrome://settings/' }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { token } = await closeTabs(db, items.map((i) => i.id));
    expect(mock.tabs()).toHaveLength(0);
    vi.advanceTimersByTime(9_000);
    expect(await undo(db, token)).toBe(true);
    expect(mock.tabs().map((t) => t.url)).toEqual(['https://a.com/']);
    const t2 = await closeTabs(db, [(await db.items.all()).find((i) => i.url === 'https://a.com/')!.id]);
    vi.advanceTimersByTime(10_001);
    expect(await undo(db, t2.token)).toBe(false);
    expect(mock.tabs()).toHaveLength(0);
  });
  it('undo falls back to the current window when the original one is gone', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://k.com/' }] }, { tabs: [{ url: 'https://a.com/' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const a = byUrl(await db.items.all(), 'https://a.com/');
    const { token } = await closeTabs(db, [a.id]);
    mock.removeWindow(a.windowId!);
    expect(await undo(db, token)).toBe(true);
    expect(mock.tabs().map((t) => t.url).sort()).toEqual(['https://a.com/', 'https://k.com/']);
  });
  it('ignores unknown tokens', async () => {
    mock = installChromeMock();
    expect(await undo(db, 'nope')).toBe(false);
  });
});
describe('re-stash and tombstones', () => {
  it('re-stashing a page clears its tombstone and gets an updatedAt newer than it', async () => {
    const items = await setup([{ url: 'https://a.com/' }]);
    const id = await sha1hex('https://a.com/');
    const future = Date.now() + 3 * 86_400_000; // e.g. from a device whose clock runs fast
    await db.tombstones.put({ id, deletedAt: future });
    await stash(db, [items[0]!.id]);
    expect(await db.tombstones.all()).toEqual([]);
    expect((await db.items.get(id))!.updatedAt).toBe(future + 1);
  });
  it('open/undo tombstones are stamped after the record, even one stamped ahead by a fast clock', async () => {
    const items = await setup([{ url: 'https://a.com/' }, { url: 'https://b.com/' }]);
    const { token } = await stash(db, items.map((i) => i.id));
    const [a, b] = [await sha1hex('https://a.com/'), await sha1hex('https://b.com/')];
    const future = Date.now() + 3 * 86_400_000;
    for (const id of [a, b]) await db.items.put({ ...(await db.items.get(id))!, updatedAt: future });
    await chrome.storage.local.set({ [SYNCED_IDS_KEY]: [a, b] });
    await openItem(db, a);
    expect((await db.tombstones.get(a))!.deletedAt).toBe(future + 1);
    await undo(db, token);
    expect((await db.tombstones.get(b))!.deletedAt).toBe(future + 1);
  });
});
