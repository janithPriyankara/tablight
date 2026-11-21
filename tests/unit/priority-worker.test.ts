// The Priority group through the service worker: the keyboard commands, the RPCs, sync, and "Delete all data".
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
import { PRIORITY_GROUP_ID, PRIORITY_NAME } from '../../src/shared/priority';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
  isWarm: vi.fn(() => false),
  closeIfIdle: vi.fn(async () => undefined),
  OFFSCREEN_IDLE_ALARM: 'offscreen-idle',
}));
// Each test starts from an empty database (the worker opens the same one every time).
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
const P = PRIORITY_GROUP_ID;

async function boot(tabs: Partial<chrome.tabs.Tab>[]): Promise<{
  mock: ChromeMockControl; bg: typeof import('../../src/background/index');
}> {
  const mock = installChromeMock({ windows: [{ tabs }] });
  const bg = await import('../../src/background/index');
  const { whenTabIndexIdle } = await import('../../src/background/tab-index');
  mock.fireInstalled();
  await vi.waitFor(async () => {
    await whenTabIndexIdle();
    const db = await bg.getDb();
    expect((await db.groups.all()).length).toBeGreaterThan(10);
    expect(await db.queue.size()).toBe(0);
  });
  return { mock, bg };
}

describe('Priority in the service worker', () => {
  it('Alt+P adds the active tab (badge ★ for a moment), again does nothing, Alt+Shift+P puts it back (badge –)', async () => {
    const { mock, bg } = await boot([
      { url: 'https://stackoverflow.com/questions/1/x', title: 'Q', active: true }, { url: 'https://example.org/', title: 'E' },
    ]);
    const db = await bg.getDb();
    const tab = mock.tabs().find((t) => t.url === 'https://stackoverflow.com/questions/1/x')!;
    const before = (await db.items.byTabId(tab.id!))!;
    expect(before.groupId).toBe('programming');
    // The shortcut acts on the active tab of the focused window (the install opened the dashboard: go back).
    mock.focusWindow(tab.windowId!);
    mock.activateTab(tab.id!);
    mock.fireCommand('prioritize-tab');
    await vi.waitFor(async () => expect((await db.items.byTabId(tab.id!))!.groupId).toBe(P));
    await vi.waitFor(() => expect(mock.badgeText(tab.id)).toBe('★'));
    expect((await db.groups.get(P))!.exemplars).toEqual([]);
    expect((await db.groups.get('programming'))!.lessons ?? []).toEqual([]);
    // Pressed again: nothing changes.
    const stamp = (await db.items.byTabId(tab.id!))!.updatedAt;
    expect(await bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: tab.id! })).toBe('none');
    expect((await db.items.byTabId(tab.id!))!.updatedAt).toBe(stamp);
    mock.fireCommand('unprioritize-tab');
    await vi.waitFor(async () => expect((await db.items.byTabId(tab.id!))!).toMatchObject({ groupId: 'programming', groupSource: 'auto' }));
    await vi.waitFor(() => expect(mock.badgeText(tab.id)).toBe('–'));
    // After the flash the badge shows what Tablight shows there (nothing: no duplicate, nothing suspicious).
    await vi.waitFor(() => expect(mock.badgeText(tab.id)).toBe(''), { timeout: 4000 });
    expect(await bg.handleRequest({ t: 'priorityCommand', command: 'unprioritize-tab', tabId: tab.id! })).toBe('none');
  });
  it('the shortcut on a browser page or a Tablight page does nothing', async () => {
    const { mock, bg } = await boot([{ url: 'chrome://settings/', title: 'Settings', active: true }]);
    const db = await bg.getDb();
    const settings = mock.tabs().find((t) => t.url === 'chrome://settings/')!;
    mock.focusWindow(settings.windowId!);
    mock.activateTab(settings.id!);
    // The real listener: wait until it has looked the tab up and its command has run (no fixed delay).
    const get = vi.spyOn(chrome.tabs, 'get');
    mock.fireCommand('prioritize-tab');
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(settings.id));
    await bg.whenCommandsDone();
    expect(await db.groups.get(P)).toBeUndefined();
    expect(await bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: settings.id! })).toBe('none');
    const dash = mock.tabs().find((t) => (t.url ?? t.pendingUrl ?? '').includes('dashboard.html'));
    if (dash) expect(await bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: dash.id! })).toBe('none');
    expect(await db.groups.get(P)).toBeUndefined();
    await expect(bg.handleRequest({ t: 'priorityCommand', command: 'bogus' as never, tabId: 1 })).rejects.toThrow(/invalid command/);
  });
  it('the prioritize RPC adds and removes; a removal with no group left is classified again', async () => {
    const { mock, bg } = await boot([{ url: 'https://stackoverflow.com/questions/1/x', title: 'Q' }]);
    const db = await bg.getDb();
    const tab = mock.tabs().find((t) => t.url === 'https://stackoverflow.com/questions/1/x')!;
    const item = (await db.items.byTabId(tab.id!))!;
    expect(await bg.handleRequest({ t: 'prioritize', ids: [item.id], on: true })).toBe(1);
    await bg.handleRequest({ t: 'groupDelete', id: 'programming' });
    expect(await bg.handleRequest({ t: 'prioritize', ids: [item.id], on: false })).toBe(1);
    // Queued, then placed by the pipeline as a new tab would be (programming is gone, so not there).
    const { whenTabIndexIdle } = await import('../../src/background/tab-index');
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect(await db.queue.size()).toBe(0);
      expect((await db.items.get(item.id))!.groupId).not.toBe(P);
    });
    await expect(bg.handleRequest({ t: 'prioritize', ids: [item.id], on: 'yes' as never })).rejects.toThrow(/invalid on/);
  });
  it('quick presses apply in the order pressed: Alt+P then Alt+Shift+P ends out of Priority', async () => {
    const { mock, bg } = await boot([{ url: 'https://example.org/', title: 'E' }]);
    const db = await bg.getDb();
    const tab = mock.tabs().find((t) => t.url === 'https://example.org/')!;
    const before = (await db.items.byTabId(tab.id!))!.groupId;
    // Not awaited one by one: both are in flight together, as with two fast key presses.
    const results = await Promise.all([
      bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: tab.id! }),
      bg.handleRequest({ t: 'priorityCommand', command: 'unprioritize-tab', tabId: tab.id! }),
      bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: tab.id! }),
      bg.handleRequest({ t: 'priorityCommand', command: 'unprioritize-tab', tabId: tab.id! }),
    ]);
    expect(results).toEqual(['added', 'removed', 'added', 'removed']);
    expect((await db.items.byTabId(tab.id!))!.groupId).toBe(before);
  });
  it('Priority survives a worker restart; a badge left mid-flash by a stopped worker is repainted', async () => {
    const { mock, bg } = await boot([{ url: 'https://example.org/', title: 'E', active: true }]);
    const tab = mock.tabs().find((t) => t.url === 'https://example.org/')!;
    expect(await bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: tab.id! })).toBe('added');
    expect(mock.badgeText(tab.id)).toBe('★');
    // The worker stops during the flash (its timer is lost) and a new one starts on the same data.
    vi.resetModules();
    const { resetBadgeCache } = await import('../../src/background/duplicates');
    resetBadgeCache();
    const bg2 = await import('../../src/background/index');
    const db2 = await bg2.getDb();
    // Well within the old worker's 2 s timer (still running in this test process): the new worker repainted it.
    await vi.waitFor(() => expect(mock.badgeText(tab.id)).toBe(''), { timeout: 1000 });
    expect((await db2.items.byTabId(tab.id!))!).toMatchObject({ groupId: P, beforePriority: { groupSource: 'auto' } });
    expect(await db2.groups.get(P)).toBeDefined();
  });
  it('the state lists the group with its count; the duplicate card counts every copy and switches to the Priority one', async () => {
    const { mock, bg } = await boot([
      { url: 'https://dup.example.com/a', title: 'A', active: true }, { url: 'https://dup.example.com/a', title: 'A' },
    ]);
    const db = await bg.getDb();
    const [first, other] = mock.tabs().filter((t) => t.url === 'https://dup.example.com/a');
    mock.focusWindow(first!.windowId!);
    mock.activateTab(first!.id!);
    const item = (await db.items.byTabId(other!.id!))!;
    type S = import('../../src/shared/types').DashboardState;
    expect(((await bg.handleRequest({ t: 'state' })) as S).activeDup?.others).toHaveLength(1);
    await bg.handleRequest({ t: 'prioritize', ids: [item.id], on: true });
    const s = (await bg.handleRequest({ t: 'state' })) as S;
    expect(s.groups.find((g) => g.id === P)).toMatchObject({ name: PRIORITY_NAME, count: 1 });
    // The active tab is not in Priority: the card stays (Close this one is fine), and Switch goes to the Priority copy.
    expect(s.activeDup?.item.tabId).toBe(first!.id);
    expect(s.activeDup?.others.map((i) => i.id)).toEqual([item.id]);
  });
  it('Delete all data removes it; the starter groups still come back when Priority was made first', async () => {
    const { mock, bg } = await boot([{ url: 'https://example.org/', title: 'E', active: true }]);
    const db = await bg.getDb();
    const tab = mock.tabs().find((t) => t.url === 'https://example.org/')!;
    expect(await bg.handleRequest({ t: 'priorityCommand', command: 'prioritize-tab', tabId: tab.id! })).toBe('added');
    expect(await db.groups.get(P)).toBeDefined();
    await bg.handleRequest({ t: 'deleteAllData' });
    expect((await db.items.byTabId(tab.id!))?.groupId).not.toBe(P);
    const after = await db.groups.all();
    expect(after.some((g) => g.id === P)).toBe(false);
    expect(after.length).toBeGreaterThan(10);
    // Priority made before the starter groups exist (a shortcut right after a wipe): they are still seeded.
    const { flushTabEvents, whenTabIndexIdle } = await import('../../src/background/tab-index');
    await whenTabIndexIdle();
    const { newPriorityGroup } = await import('../../src/shared/priority');
    await db.clearAll();
    await db.groups.put(newPriorityGroup());
    await flushTabEvents();
    await vi.waitFor(async () => expect((await db.groups.all()).length).toBeGreaterThan(10));
    expect((await db.groups.all()).filter((g) => g.id === P)).toHaveLength(1);
  });
  it('sync from an older version: a group of the user’s called Priority is renamed first; remote Priority means the built-in group', async () => {
    const { mock, bg } = await boot([]);
    void mock;
    const db = await bg.getDb();
    const { sha1hex } = await import('../../src/shared/hash');
    const { encodeChunks, META_KEY } = await import('../../src/sync/sync-codec');
    const { pullSync } = await import('../../src/background/sync');
    // As an older version made it from sync: an ordinary group, with a saved tab in it.
    await db.groups.put({ id: 'g-old', name: 'Priority', color: '#00959c', icon: '📁', builtIn: false, exemplars: [], centroid: [1], createdAt: 1 });
    const urlOld = 'https://old.example.com/';
    const at = Date.now();
    await db.items.put({
      id: await sha1hex(urlOld), url: urlOld, normUrl: urlOld, title: 'Old', domain: 'old.example.com', state: 'stashed',
      groupId: 'g-old', groupSource: 'user', kind: 'read', createdAt: at, lastActiveAt: at, stashedAt: at, updatedAt: at, classifiable: true,
    });
    const url = 'https://saved.example.com/';
    const { chunks } = encodeChunks([[await sha1hex(url), url, 'Saved', 'Priority', at, at]], []);
    await chrome.storage.sync.set({ ...chunks, [META_KEY]: { chunks: Object.keys(chunks).length, updatedAt: 1 } });
    await db.settings.set({ syncEnabled: true });
    await pullSync(db);
    expect((await db.groups.get('g-old'))!.name).toBe('Priority (yours)');
    expect((await db.items.get(await sha1hex(urlOld)))!.groupId).toBe('g-old');
    expect((await db.items.get(await sha1hex(url)))!.groupId).toBe(P);
    type S = import('../../src/shared/types').DashboardState;
    expect(((await bg.handleRequest({ t: 'state' })) as S).priorityRenamed).toEqual(['Priority (yours)']);
  });
  it('sync: a saved tab in Priority on another device lands in the built-in Priority group here', async () => {
    const { mock, bg } = await boot([]);
    void mock;
    const db = await bg.getDb();
    const { sha1hex } = await import('../../src/shared/hash');
    const { encodeChunks, META_KEY } = await import('../../src/sync/sync-codec');
    const { pullSync } = await import('../../src/background/sync');
    const url = 'https://saved.example.com/';
    const at = Date.now();
    const { chunks } = encodeChunks([[await sha1hex(url), url, 'Saved', 'Priority', at, at]], []);
    await chrome.storage.sync.set({ ...chunks, [META_KEY]: { chunks: Object.keys(chunks).length, updatedAt: 1 } });
    await db.settings.set({ syncEnabled: true });
    await pullSync(db);
    const got = (await db.items.byState('stashed'))[0]!;
    expect(got).toMatchObject({ groupId: P, groupSource: 'user' });
    expect((await db.groups.all()).filter((g) => g.name === PRIORITY_NAME).map((g) => g.id)).toEqual([P]);
    // A tab saved from Priority here is pushed under the same name.
    const { pushSync } = await import('../../src/background/sync');
    const { decodeChunks } = await import('../../src/sync/sync-codec');
    const url2 = 'https://mine.example.com/';
    await db.items.put({ ...got, id: await sha1hex(url2), url: url2, normUrl: url2, title: 'Mine', updatedAt: Date.now() + 1 });
    await pushSync(db);
    const recs = decodeChunks(await chrome.storage.sync.get(null)).recs;
    expect(recs.find((r) => r[1] === url2)?.[3]).toBe(PRIORITY_NAME);
  });
});
