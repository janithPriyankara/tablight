import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import {
  configureTabIndex,
  BACKFILL_LIMIT,
  BACKFILL_RETRY_MS,
  backfillEmbKeys,
  BACKOFF_MINUTES,
  embeddingKey,
  flushTabEvents,
  flushIfPending,
  PENDING_KEY,
  maybeSuggest,
  neighbourPool,
  RETITLE_INTERVAL_MS,
  SESSION_KEY,
  sweepEmbeddings,
  touchTab,
  onTabEvent,
  processQueue,
  reconcile,
  whenTabIndexIdle,
} from '../../src/background/tab-index';
import type { Group, Item } from '../../src/shared/types';
import { HEAD } from '../../src/classify/head';
import { NEIGHBOUR_POOL_MAX } from '../../src/classify/pick';
import { normalize } from '../../src/shared/vec';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

const DIM = 384;
let n = 0;
let db: Db;
let mock: ChromeMockControl;

/** Deterministic 384-d unit-ish vector from a string. */
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
const fakeEmbed = vi.fn(async (texts: string[]) => texts.map(vecFor));

function group(id: string, over: Partial<Group> = {}): Group {
  return { id, name: id, color: '#000', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 1, ...over };
}

beforeEach(async () => {
  db = await openDb(`tab-index-${n++}`);
  fakeEmbed.mockClear();
  fakeEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor));
});
afterEach(async () => {
  await whenTabIndexIdle();
  mock?.uninstall();
});

const web = (i: number) => ({ url: `https://site${i}.example.com/page/${i}`, title: `Page ${i}` });

describe('reconcile', () => {
  it('indexes 3 windows × 5 tabs with the right windowIds', async () => {
    mock = installChromeMock({
      windows: [0, 1, 2].map((w) => ({ tabs: [0, 1, 2, 3, 4].map((t) => web(w * 10 + t)) })),
    });
    const tabs = await chrome.tabs.query({});
    await reconcile(db, tabs);
    const items = await db.items.all();
    expect(items).toHaveLength(15);
    for (const t of tabs) {
      const it = await db.items.byTabId(t.id!);
      expect(it?.windowId).toBe(t.windowId);
      expect(it?.state).toBe('open');
      expect(it?.classifiable).toBe(true);
    }
    expect(new Set(items.map((i) => i.windowId)).size).toBe(3);
    expect(await db.queue.size()).toBe(15);
  });

  it('non-web tabs are indexed, not classifiable, never enqueued, never throw', async () => {
    const urls = ['chrome://settings', 'edge://newtab', 'file:///x.pdf', 'about:blank', 'view-source:https://a.com', ''];
    mock = installChromeMock({ windows: [{ tabs: urls.map((url) => ({ url, title: '' })) }] });
    await reconcile(db, await chrome.tabs.query({}));
    const items = await db.items.all();
    expect(items).toHaveLength(urls.length);
    expect(items.every((i) => !i.classifiable)).toBe(true);
    expect(await db.queue.size()).toBe(0);
    await expect(processQueue(db, fakeEmbed)).resolves.toBe(0);
    expect(fakeEmbed).not.toHaveBeenCalled();
  });

  it('marks discarded tabs sleeping', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ ...web(1), discarded: true }, web(2)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    expect((await db.items.byState('sleeping')).map((i) => i.url)).toEqual([web(1).url]);
  });

  it('deletes items whose tab is gone but keeps stashed items', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const stashed: Item = { ...(await db.items.all())[0]!, id: 'stashed', state: 'stashed', tabId: undefined };
    await db.items.put(stashed);
    mock.removeTab(mock.tabs()[0]!.id!);
    await reconcile(db, await chrome.tabs.query({}));
    const items = await db.items.all();
    expect(items.map((i) => i.id).sort()).toEqual([expect.any(String), 'stashed'].sort());
    expect(items.filter((i) => i.state !== 'stashed').map((i) => i.url)).toEqual([web(2).url]);
    expect(await db.queue.size()).toBe(1); // the closed tab's pending entry went with it
  });

  it('re-matches restored tabs with new ids by normUrl+windowId, keeping user groups', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const before = (await db.items.all()).find((i) => i.url === web(1).url)!;
    await db.items.put({ ...before, groupId: 'mine', groupSource: 'user' });
    await db.queue.remove((await db.queue.take(10)));
    // Browser restart: same window and URLs, new tab ids.
    const restored = (await chrome.tabs.query({})).map((t) => ({ ...t, id: t.id! + 100 }));
    await reconcile(db, restored);
    const after = await db.items.byTabId(before.tabId! + 100);
    expect(after?.id).toBe(before.id);
    expect(after?.groupId).toBe('mine');
    expect(await db.items.all()).toHaveLength(2);
    expect(await db.queue.size()).toBe(0);
  });

  it('browser restart (new tab AND window ids) keeps user groups, one item per tab', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2)] }, { tabs: [web(3), web(1)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const items0 = await db.items.all();
    const w2copy = items0.find((i) => i.url === web(1).url && i.windowId === 2)!;
    await db.items.put({ ...w2copy, groupId: 'mine', groupSource: 'user', lastActiveAt: Date.now() + 1000 });
    await db.queue.remove(await db.queue.take(10));

    // Restart: every id changes. Only one copy of web(1) comes back.
    const restored = (await chrome.tabs.query({}))
      .filter((t) => !(t.url === web(1).url && t.windowId === 1))
      .map((t) => ({ ...t, id: t.id! + 100, windowId: t.windowId + 10 }));
    await reconcile(db, restored);
    const items = await db.items.all();
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.tabId)).size).toBe(3);
    const back = items.find((i) => i.url === web(1).url)!;
    expect(back.id).toBe(w2copy.id); // the most recently active copy wins
    expect(back.groupId).toBe('mine');
    expect(back.windowId).toBe(12);
    expect(new Set(items.map((i) => i.id))).toEqual(
      new Set(items0.filter((i) => !(i.url === web(1).url && i.windowId === 1)).map((i) => i.id)),
    );
    expect(await db.queue.size()).toBe(0);
  });

  it('re-classifies an auto item when its real title arrives after load', async () => {
    await db.groups.put(group('programming'));
    const url = 'https://zzz.example.net/a/b';
    mock = installChromeMock({ windows: [{ tabs: [{ url, title: url }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    await processQueue(db, fakeEmbed);
    const tabId = mock.tabs()[0]!.id!;
    const before = (await db.items.byTabId(tabId))!;
    // As if the model had guessed a group from the URL-only text.
    await db.items.put({ ...before, groupId: 'social', groupSource: 'auto' });
    // The model would put the real title into programming: pin that via a user-taught exemplar.
    const title = 'Fixing a segfault in my compiler';
    const key = await embeddingKey({ normUrl: before.normUrl, title, url });
    const v = Array.from(vecFor(`${title} — zzz.example.net a b`));
    await db.groups.put(group('programming', { exemplars: [v] }));
    fakeEmbed.mockImplementation(async (texts: string[]) => texts.map((t) => (t.startsWith(title) ? Float32Array.from(v) : vecFor(t))));

    mock.updateTab(tabId, { title });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.size()).toBe(1);
    await processQueue(db, fakeEmbed);
    expect((await db.items.byTabId(tabId))!.groupId).toBe('programming');
    expect(await db.embeddings.get(key)).toBeDefined();
  });

  it('waits for the real title: a loading tab with a placeholder title is not classified (restored tab)', async () => {
    const url = 'https://zzz.example.net/doc/1';
    mock = installChromeMock({ windows: [{ tabs: [{ url, title: 'Real doc title', status: 'complete' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    await processQueue(db, fakeEmbed);
    const tabId = mock.tabs()[0]!.id!;
    await db.items.put({ ...(await db.items.byTabId(tabId))!, groupId: 'work', groupSource: 'auto' });
    // Restored / reloading: the title falls back to the URL while the page loads.
    mock.updateTab(tabId, { status: 'loading', title: url });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.size()).toBe(0);
    mock.updateTab(tabId, { status: 'loading', title: '' });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.size()).toBe(0);
    expect((await db.items.byTabId(tabId))!.groupId).toBe('work'); // never dropped out of its group
    mock.updateTab(tabId, { status: 'complete', title: 'Real doc title' });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.size()).toBe(1); // the real title is classified
  });
  it('a new loading tab waits; once loaded it is classified even if its title stays a placeholder', async () => {
    const url = 'https://zzz.example.net/file.pdf';
    mock = installChromeMock({ windows: [{ tabs: [{ url, title: '', status: 'loading' }, { url: 'https://b.example.org/x', title: 'B', status: 'loading' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const tabId = mock.tabs()[0]!.id!;
    const id = (await db.items.byTabId(tabId))!.id;
    expect(await db.queue.take(10)).toEqual([(await db.items.byTabId(mock.tabs()[1]!.id!))!.id]); // a real title is fine
    await db.queue.remove(await db.queue.take(10));
    mock.updateTab(tabId, { status: 'complete', title: url });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.take(10)).toEqual([id]);
  });
  it('navigation re-enqueues the item but keeps a user group', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const it0 = (await db.items.all())[0]!;
    await db.items.put({ ...it0, groupId: 'mine', groupSource: 'user' });
    await db.queue.remove([it0.id]);
    mock.updateTab(it0.tabId!, { url: 'https://other.example.org/x', title: 'Other' });
    await reconcile(db, await chrome.tabs.query({}));
    const it1 = (await db.items.get(it0.id))!;
    expect(it1.normUrl).toBe('https://other.example.org/x');
    expect(it1.groupId).toBe('mine');
    expect(await db.queue.take(5)).toEqual([it0.id]);
    await processQueue(db, fakeEmbed);
    expect((await db.items.get(it0.id))!.groupId).toBe('mine');
  });
});

describe('browser restart with colliding ids (review 1.1)', () => {
  it('a new session never matches by tabId: each URL keeps its own user group', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2), web(3), web(4)] }] });
    configureTabIndex({ db: async () => db });
    await flushTabEvents();
    // Ids shift during the session: close the first tab, open another.
    mock.removeTab(mock.tabs()[0]!.id!);
    mock.addTab({ ...web(5), windowId: 1 });
    await flushTabEvents();
    for (const i of await db.items.all()) await db.items.put({ ...i, groupId: `g-${i.url}`, groupSource: 'user' });
    await db.queue.remove(await db.queue.take(10));
    const before = mock.tabs().map((t) => t.id);
    mock.restartBrowser(); // ids renumbered from 1: old tab 2 (web 2) is now tab 1, tab 2 is now web 3, …
    const after = mock.tabs();
    expect(after.map((t) => t.id)).not.toEqual(before);
    expect(after.some((t) => before.includes(t.id))).toBe(true); // ids collide with different URLs
    await flushTabEvents();
    const items = await db.items.all();
    expect(items).toHaveLength(4);
    for (const t of after) {
      const i = (await db.items.byTabId(t.id!))!;
      expect(i.url).toBe(t.url);
      expect(i.groupId).toBe(`g-${t.url}`);
    }
    expect(await db.queue.size()).toBe(0); // nothing looked navigated
  });
  it('within a session, tab ids are trusted (navigation keeps the item)', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1)] }] });
    configureTabIndex({ db: async () => db });
    await flushTabEvents();
    const id0 = (await db.items.all())[0]!.id;
    mock.updateTab(mock.tabs()[0]!.id!, web(9));
    await flushTabEvents();
    expect((await db.items.all()).map((i) => [i.id, i.url])).toEqual([[id0, web(9).url]]);
  });
});
describe('event storm (Review Focus 2)', () => {
  it('300 creates + 200 removes within 100 ms end matching tabs.query with no dup tabIds', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2), web(3)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const keep = (await db.items.all()).find((i) => i.url === web(1).url)!;
    await db.items.put({ ...keep, groupId: 'mine', groupSource: 'user' });

    configureTabIndex({ db: async () => db, after: async (d) => void (await processQueue(d, fakeEmbed)) });
    await chrome.storage.session.set({ [SESSION_KEY]: 1 }); // same browser session: tab ids are trusted
    const events = ['onCreated', 'onUpdated', 'onRemoved', 'onReplaced'] as const;
    for (const e of events) mock.chrome.tabs[e].addListener(() => onTabEvent());
    const query = vi.spyOn(mock.chrome.tabs, 'query');

    const t0 = Date.now();
    const created: number[] = [];
    for (let i = 0; i < 300; i++) created.push(mock.addTab({ ...web(100 + i), windowId: 1 + (i % 3) }).id!);
    // Close 199 of the new tabs and one of the seeded ones (not the user-grouped one).
    for (const id of created.slice(0, 199)) mock.removeTab(id);
    mock.removeTab(mock.tabs().find((t) => t.url === web(2).url)!.id!);
    expect(Date.now() - t0).toBeLessThan(100);

    expect(query).not.toHaveBeenCalled(); // debounced
    await new Promise((r) => setTimeout(r, 600));
    await whenTabIndexIdle();
    expect(query).toHaveBeenCalledTimes(1);

    const tabs = await chrome.tabs.query({});
    const items = (await db.items.all()).filter((i) => i.state !== 'stashed');
    expect(items).toHaveLength(tabs.length);
    expect(new Set(items.map((i) => i.tabId)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.tabId))).toEqual(new Set(tabs.map((t) => t.id)));
    expect((await db.items.get(keep.id))?.groupId).toBe('mine');
    expect(await db.queue.size()).toBe(0);
  });
});

describe('pending update survives a background restart', () => {
  it('a tab event marks an update pending; a finished update clears it', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1)] }] });
    configureTabIndex({ db: async () => db });
    onTabEvent();
    await new Promise((r) => setTimeout(r, 20));
    expect((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY]).toBeTruthy();
    await flushTabEvents();
    expect((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY]).toBeUndefined();
  });
  it('flushIfPending catches up on a change whose update was lost with the old background', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2)] }] });
    configureTabIndex({ db: async () => db });
    await flushTabEvents();
    // The background was stopped after the close event but before the debounced update ran.
    mock.removeTab(mock.tabs()[0]!.id!);
    await chrome.storage.session.set({ [PENDING_KEY]: 1 });
    await flushIfPending();
    expect((await db.items.all()).map((i) => i.url)).toEqual([web(2).url]);
    expect((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY]).toBeUndefined();
  });
  it('flushIfPending does nothing when no update is pending', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1)] }] });
    configureTabIndex({ db: async () => db });
    const query = vi.spyOn(mock.chrome.tabs, 'query');
    await flushIfPending();
    expect(query).not.toHaveBeenCalled();
  });
});
describe('processQueue', () => {
  it('resumes after the embedder dies mid-way (Review Focus 3)', async () => {
    await db.groups.put(group('programming'));
    mock = installChromeMock({
      windows: [{ tabs: Array.from({ length: 70 }, (_, i) => ({ url: `https://stackoverflow.com/questions/${i}/q`, title: `Q ${i}` })) }],
    });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.size()).toBe(70);

    let calls = 0;
    fakeEmbed.mockImplementation(async (texts: string[]) => {
      if (calls++ >= 1) throw new Error('service worker died');
      return texts.map(vecFor);
    });
    await expect(processQueue(db, fakeEmbed)).rejects.toThrow('service worker died');
    expect(await db.queue.size()).toBe(70 - 32);
    expect((await db.items.all()).filter((i) => i.groupId === 'programming')).toHaveLength(32);
    // The kick alarm is left behind to wake the worker again.
    expect(mock.alarms().map((a) => [a.name, a.periodInMinutes])).toEqual([['classify-kick', 1]]);

    fakeEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor));
    await expect(processQueue(db, fakeEmbed)).resolves.toBe(38);
    expect(await db.queue.size()).toBe(0);
    const items = await db.items.all();
    expect(items.every((i) => i.groupId === 'programming')).toBe(true);
    for (const i of items) expect(await db.embeddings.get(await embeddingKey(i))).toBeDefined();
    expect(mock.alarms()).toEqual([]);
  });

  it('is re-entrancy safe: concurrent calls share one run', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const a = processQueue(db, fakeEmbed);
    const b = processQueue(db, fakeEmbed);
    expect(b).toBe(a);
    expect(await a).toBe(2);
    expect(fakeEmbed).toHaveBeenCalledTimes(1);
  });

  it('caches embeddings by normUrl + clean title', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1)] }, { tabs: [{ ...web(1), url: web(1).url + '?utm_source=x' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    await processQueue(db, fakeEmbed);
    expect(fakeEmbed).toHaveBeenCalledTimes(1);
    expect(fakeEmbed.mock.calls[0]![0]).toHaveLength(1);

    mock.addTab({ ...web(1), windowId: 1 });
    await reconcile(db, await chrome.tabs.query({}));
    expect(await db.queue.size()).toBe(1);
    await processQueue(db, fakeEmbed);
    expect(fakeEmbed).toHaveBeenCalledTimes(1);
    expect(await db.queue.size()).toBe(0);
  });

  it('pipeline: user group kept, rule before model, otherwise Unsorted', async () => {
    await db.groups.put(group('programming'));
    await db.groups.put(group('social'));
    mock = installChromeMock({
      windows: [{ tabs: [
        { url: 'https://stackoverflow.com/questions/1/x', title: 'Q' },
        { url: 'https://x.com/home', title: 'Home' },
        { url: 'https://zzz.example.net/qwerty', title: 'qwerty' },
      ] }],
    });
    await reconcile(db, await chrome.tabs.query({}));
    const x = (await db.items.all()).find((i) => i.url.startsWith('https://x.com'))!;
    await db.items.put({ ...x, groupId: 'programming', groupSource: 'user' });
    await processQueue(db, fakeEmbed);
    const by = new Map((await db.items.all()).map((i) => [new URL(i.url).hostname, i.groupId]));
    expect(by.get('stackoverflow.com')).toBe('programming');
    expect(by.get('x.com')).toBe('programming');
    expect(by.get('zzz.example.net')).toBeNull();
  });
});

describe('want (local-only wanted topic)', () => {
  const label = HEAD.labels.find((l) => l !== 'other')!;
  const towards = Float32Array.from(normalize([...HEAD.W[HEAD.labels.indexOf(label)]!]));
  const away = Float32Array.from(normalize([...HEAD.W[HEAD.labels.indexOf('other')]!]));
  it('is stored when set, removed when null or for user-placed tabs, and never bumps updatedAt', async () => {
    mock = installChromeMock({ windows: [{ tabs: [
      { url: 'https://zzz.example.net/a', title: 'a' },
      { url: 'https://zzz.example.net/b', title: 'b' },
    ] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const [first, second] = await db.items.all();
    await db.items.put({ ...second!, groupSource: 'user', want: 'stale' });
    const before = (await db.items.get(first!.id))!.updatedAt;
    await processQueue(db, async (texts: string[]) => texts.map(() => towards));
    expect((await db.items.get(first!.id))!.want).toBe(label); // no groups exist: the topic waits
    expect((await db.items.get(first!.id))!.updatedAt).toBe(before);
    expect((await db.items.get(second!.id))!.want).toBeUndefined();
    // Re-classified with nothing wanted: the stored want is removed.
    await db.items.put({ ...(await db.items.get(first!.id))!, title: 'a2', normUrl: (await db.items.get(first!.id))!.normUrl });
    await db.queue.add(first!.id);
    await processQueue(db, async (texts: string[]) => texts.map(() => away));
    expect((await db.items.get(first!.id))!.want).toBeUndefined();
  });
});
describe('neighbour step', () => {
  // The bundled head reads this vector as `other`: unsure, so only neighbours can place it.
  const unsure = Float32Array.from(normalize([...HEAD.W[HEAD.labels.indexOf('other')]!]));
  it('a tab placed by its neighbours records it, and is left out of the pool; user-placed tabs are in it', async () => {
    await db.groups.put(group('programming'));
    mock = installChromeMock({ windows: [{ tabs: [
      { url: 'https://zzz.example.net/a', title: 'a' },
      { url: 'https://zzz.example.net/b', title: 'b' },
      { url: 'https://zzz.example.net/c', title: 'c' },
    ] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const [a, b, c] = (await db.items.all()).sort((x, y) => x.url.localeCompare(y.url));
    for (const u of [a!, b!]) {
      await db.items.put({ ...u, groupId: 'programming', groupSource: 'user' });
      await db.embeddings.put(await embeddingKey(u), unsure);
    }
    const before = (await db.items.get(c!.id))!.updatedAt;
    await processQueue(db, async (texts: string[]) => texts.map(() => unsure));
    const placed = (await db.items.get(c!.id))!;
    expect(placed).toMatchObject({ groupId: 'programming', groupSource: 'auto', placedBy: 'neighbour' });
    expect(placed.updatedAt).toBeGreaterThan(before); // a real group change is still stamped for sync
    for (const id of [a!.id, b!.id]) expect((await db.items.get(id))!.placedBy).toBeUndefined();
    const pool = await neighbourPool(db, await db.items.all(), await db.groups.all());
    expect(pool.map((p) => p.id).sort()).toEqual([a!.id, b!.id].sort());
    expect(pool[0]).toMatchObject({ groupId: 'programming', vec: unsure });
  });
  it('the pool: rule, exemplar, head and older auto placements and user tabs; never guesses, Videos, Other or suggestions', async () => {
    await db.groups.put(group('programming'));
    await db.groups.put(group('videos'));
    await db.groups.put(group('other'));
    await db.groups.put(group('s1', { suggested: true }));
    const add = async (id: string, over: Partial<Item>) => {
      const it: Item = {
        id, url: `https://${id}.example.com/`, normUrl: `https://${id}.example.com/`, title: id, domain: 'x', state: 'open',
        groupId: 'programming', groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1,
        classifiable: true, ...over,
      };
      await db.items.put(it);
      await db.embeddings.put(await embeddingKey(it), unsure);
    };
    await add('rule', { placedBy: 'rule' });
    await add('exemplar', { placedBy: 'exemplar', state: 'stashed' });
    await add('head', { placedBy: 'head', state: 'sleeping' });
    await add('old', {});
    await add('user', { groupSource: 'user', placedBy: 'neighbour' });
    await add('neighbour', { placedBy: 'neighbour' });
    await add('youtube', { placedBy: 'youtube' });
    await add('videos', { groupId: 'videos', groupSource: 'user' });
    await add('other', { groupId: 'other', groupSource: 'user' });
    await add('suggested', { groupId: 's1' });
    await add('gone', { groupId: 'deleted', groupSource: 'user' });
    await add('unsorted', { groupId: null });
    const ids = (await neighbourPool(db, await db.items.all(), await db.groups.all())).map((p) => p.id).sort();
    expect(ids).toEqual(['exemplar', 'head', 'old', 'rule', 'user']);
  });
  it(`keeps the ${NEIGHBOUR_POOL_MAX} most recently active tabs`, async () => {
    await db.groups.put(group('programming'));
    const items: Item[] = Array.from({ length: NEIGHBOUR_POOL_MAX + 2 }, (_, k) => ({
      id: `p${k}`, url: `https://p${k}.example.com/`, normUrl: `https://p${k}.example.com/`, title: `p${k}`, domain: 'x',
      state: 'open', groupId: 'programming', groupSource: 'user', kind: 'read', createdAt: 1, lastActiveAt: k, updatedAt: 1,
      classifiable: true,
    }));
    for (const it of items) await db.embeddings.put(await embeddingKey(it), unsure);
    const pool = await neighbourPool(db, items, await db.groups.all());
    expect(pool).toHaveLength(NEIGHBOUR_POOL_MAX);
    expect(pool[0]!.id).toBe(`p${NEIGHBOUR_POOL_MAX + 1}`);
    expect(pool.map((p) => p.id)).not.toContain('p0');
  });
});
describe('embedding cache hygiene (review 1.3)', () => {
  it('sweeps keys no item uses any more, keeps shared ones', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(1), web(2)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    await processQueue(db, fakeEmbed);
    expect(await db.embeddings.keys()).toHaveLength(2);
    const [a, , c] = mock.tabs();
    mock.updateTab(a!.id!, web(3)); // one copy of web(1) navigates: web(1) is still used by the other
    mock.removeTab(c!.id!); // web(2) is gone
    await reconcile(db, await chrome.tabs.query({}));
    await processQueue(db, fakeEmbed);
    expect(await sweepEmbeddings(db)).toBe(1);
    const keys = new Set(await db.embeddings.keys());
    for (const i of await db.items.all()) expect(keys.has(await embeddingKey(i))).toBe(true);
    expect(keys.size).toBe(2);
  });
  it('sweep keeps a vector referenced only by an item embKey', async () => {
    const item: Item = {
      id: 'e1', url: 'https://a.com/new', normUrl: 'https://a.com/new', title: 'New title', domain: 'a.com',
      state: 'stashed', groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1,
      classifiable: true, embKey: 'old-content-key',
    };
    await db.items.put(item);
    await db.embeddings.put('old-content-key', vecFor('old'));
    await db.embeddings.put('orphan', vecFor('orphan'));
    expect(await sweepEmbeddings(db)).toBe(1);
    expect(await db.embeddings.keys()).toEqual(['old-content-key']);
  });
  it('backfillEmbKeys sets the key when the vector is cached, else queues the item; it is bounded', async () => {
    const mk = (id: string): Item => ({
      id, url: `https://a.com/${id}`, normUrl: `https://a.com/${id}`, title: id, domain: 'a.com', state: 'stashed',
      groupId: null, groupSource: 'user', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true,
    });
    const cached = mk('cached');
    await db.items.put(cached);
    await db.items.put(mk('fresh'));
    await db.embeddings.put(await embeddingKey(cached), vecFor('c'));
    expect(await backfillEmbKeys(db)).toBe(1);
    expect((await db.items.get('cached'))!.embKey).toBe(await embeddingKey(cached));
    expect((await db.items.get('fresh'))!.embKey).toBeUndefined();
    expect(await db.queue.size()).toBe(1);
    expect(BACKFILL_LIMIT).toBe(200);
    expect(await backfillEmbKeys(db, 0)).toBe(0);
  });
  it('rate-limits title-only re-embeds and ignores digit-only churn', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://chat.example.com/r', title: 'https://chat.example.com/r' }] }] });
      const id = mock.tabs()[0]!.id!;
      const step = async (title: string) => {
        mock.updateTab(id, { title });
        await reconcile(db, await chrome.tabs.query({}));
        const n = await db.queue.size();
        await processQueue(db, fakeEmbed);
        return n;
      };
      await reconcile(db, await chrome.tabs.query({}));
      await processQueue(db, fakeEmbed);
      expect(await step('Team chat')).toBe(1); // first real title replaces the placeholder
      expect(await step('Team chat — release planning')).toBe(1); // first real change
      now += 1000;
      expect(await step('Team chat — lunch')).toBe(0); // rate-limited
      expect(await step('Team chat — lunch 12:01')).toBe(0);
      now += RETITLE_INTERVAL_MS;
      expect(await step('Team chat — lunch 12:07')).toBe(0); // digits only: not a real change
      expect(await step('Team chat — incident review')).toBe(1);
      expect((await db.items.byTabId(id))!.title).toBe('Team chat — incident review');
    } finally {
      spy.mockRestore();
    }
  });
});
describe('queue failures (review 1.4)', () => {
  async function setup(count: number) {
    await db.groups.put(group('programming'));
    mock = installChromeMock({
      windows: [{ tabs: Array.from({ length: count }, (_, i) => ({ url: `https://stackoverflow.com/questions/${i}/q`, title: `Q ${i}` })) }],
    });
    await reconcile(db, await chrome.tabs.query({}));
  }
  it('a poison item is isolated after 3 failures, written Unsorted and dropped', async () => {
    await setup(40);
    fakeEmbed.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.startsWith('Q 5 '))) throw new Error('bad input');
      return texts.map(vecFor);
    });
    await expect(processQueue(db, fakeEmbed)).rejects.toThrow('bad input');
    await expect(processQueue(db, fakeEmbed)).rejects.toThrow('bad input');
    const reads = vi.spyOn(db.items, 'all');
    await expect(processQueue(db, fakeEmbed)).resolves.toBe(40); // 39 classified + the poison item
    // The neighbour pool is read once per batch (two batches), not again for each item retried alone.
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRestore();
    expect(await db.queue.size()).toBe(0);
    const items = await db.items.all();
    expect(items.filter((i) => i.groupId === 'programming')).toHaveLength(39);
    expect(items.find((i) => i.title === 'Q 5')!.groupId).toBeNull();
    expect(mock.alarms()).toEqual([]);
  });
  it('a given-up item is stamped, not re-queued by backfill within 24 h, and success clears the stamp', async () => {
    await setup(40);
    fakeEmbed.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.startsWith('Q 5 '))) throw new Error('bad input');
      return texts.map(vecFor);
    });
    for (let k = 0; k < 2; k++) await expect(processQueue(db, fakeEmbed)).rejects.toThrow();
    await processQueue(db, fakeEmbed);
    const poison = (await db.items.all()).find((i) => i.title === 'Q 5')!;
    expect(poison.embGaveUpAt).toBeTypeOf('number');
    expect(poison.embKey).toBeUndefined();
    expect(await backfillEmbKeys(db)).toBe(0);
    expect(await db.queue.size()).toBe(0);
    // After 24 h it is tried again; once embedding works the stamp is lifted.
    expect(await backfillEmbKeys(db, 200, poison.embGaveUpAt! + BACKFILL_RETRY_MS + 1)).toBe(1);
    fakeEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor));
    await processQueue(db, fakeEmbed);
    const healed = (await db.items.get(poison.id))!;
    expect(healed.embGaveUpAt).toBeUndefined();
    expect(healed.embKey).toBeTypeOf('string');
  });
  it('given-up items do not starve other keyless items in the backfill window', async () => {
    const mk = (id: string, over: Partial<Item> = {}): Item => ({
      id, url: `https://a.com/${id}`, normUrl: `https://a.com/${id}`, title: id, domain: 'a.com', state: 'stashed',
      groupId: null, groupSource: 'user', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true, ...over,
    });
    for (let k = 0; k < 205; k++) await db.items.put(mk(`gave${k}`, { embGaveUpAt: Date.now() }));
    await db.items.put(mk('waiting'));
    expect(await backfillEmbKeys(db)).toBe(1);
    expect(await db.queue.take(10)).toEqual(['waiting']);
  });
  it('wrong vector count counts as a failure too', async () => {
    await setup(3);
    fakeEmbed.mockImplementation(async () => []);
    for (let k = 0; k < 3; k++) await expect(processQueue(db, fakeEmbed)).rejects.toThrow();
    expect(await db.queue.size()).toBe(3); // every item failing: the embedder is down, nothing dropped
  });
  it('when the embedder is down nothing is dropped and the alarm backs off', async () => {
    await setup(5);
    fakeEmbed.mockImplementation(async () => {
      throw new Error('offscreen gone');
    });
    for (let k = 0; k < 3; k++) await expect(processQueue(db, fakeEmbed)).rejects.toThrow('offscreen gone');
    expect(await db.queue.size()).toBe(5);
    expect(mock.alarms().map((a) => a.periodInMinutes)).toEqual([BACKOFF_MINUTES]);
    expect((await db.items.all()).every((i) => i.groupId === null)).toBe(true);
    fakeEmbed.mockImplementation(async (texts: string[]) => texts.map(vecFor));
    await expect(processQueue(db, fakeEmbed)).resolves.toBe(5);
    expect(mock.alarms()).toEqual([]);
  });
  it('never assigns a group deleted while the batch was embedding', async () => {
    await setup(2);
    fakeEmbed.mockImplementation(async (texts: string[]) => {
      await db.groups.delete('programming');
      return texts.map(vecFor);
    });
    await processQueue(db, fakeEmbed);
    expect((await db.items.all()).map((i) => i.groupId)).toEqual([null, null]);
  });
});
describe('never-opened tabs ("New")', () => {
  it('a tab opened in the background during a session is new until it is switched to', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ ...web(1), active: true }] }] });
    await reconcile(db, await chrome.tabs.query({}), { newSession: true });
    const bg = mock.addTab({ ...web(2), windowId: mock.windowIds()[0]!, active: false });
    const fg = mock.addTab({ ...web(3), windowId: mock.windowIds()[0]!, active: true });
    await reconcile(db, await chrome.tabs.query({}));
    expect((await db.items.byTabId(bg.id!))!.opened).toBe(false);
    expect((await db.items.byTabId(fg.id!))!.opened).toBe(true);
    await touchTab(db, bg.id!);
    expect((await db.items.byTabId(bg.id!))!.opened).toBe(true);
  });
  it('tabs that already existed when the index starts (install, browser start) are not marked new', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2), web(3)] }] });
    await reconcile(db, await chrome.tabs.query({}), { newSession: true });
    expect((await db.items.all()).every((i) => i.opened !== false)).toBe(true);
  });
  it('a tab still unopened at a browser restart stays new afterwards', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ ...web(1), active: true }] }] });
    await reconcile(db, await chrome.tabs.query({}), { newSession: true });
    mock.addTab({ ...web(2), windowId: mock.windowIds()[0]!, active: false });
    await reconcile(db, await chrome.tabs.query({}));
    mock.restartBrowser();
    await reconcile(db, await chrome.tabs.query({}), { newSession: true });
    const it2 = (await db.items.all()).find((i) => i.url === web(2).url)!;
    expect(it2.opened).toBe(false);
  });
});
describe('lastActiveAt (review minor 5)', () => {
  it('touchTab records activation; reconcile never moves it back', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ ...web(1), lastAccessed: 5 }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const id = mock.tabs()[0]!.id!;
    expect((await db.items.byTabId(id))!.lastActiveAt).toBe(5);
    await touchTab(db, id, 1000);
    expect((await db.items.byTabId(id))!.lastActiveAt).toBe(1000);
    await reconcile(db, await chrome.tabs.query({}));
    expect((await db.items.byTabId(id))!.lastActiveAt).toBe(1000);
  });
});
describe('maybeSuggest', () => {
  async function unsorted(count: number, prefix: string, base: Float32Array) {
    const tabs = Array.from({ length: count }, (_, i) => ({ url: `https://${prefix}.example.com/${i}`, title: `${prefix} topic ${i}` }));
    for (const t of tabs) mock.addTab(t);
    await reconcile(db, await chrome.tabs.query({}));
    fakeEmbed.mockImplementation(async (texts: string[]) =>
      texts.map((t) => base.map((v, d) => v + (vecFor(t)[d]! * 0.05))));
    await processQueue(db, fakeEmbed);
  }

  it('suggests a group for ≥ 4 similar Unsorted items and does not re-suggest it', async () => {
    mock = installChromeMock();
    await unsorted(4, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    let suggested = (await db.groups.all()).filter((g) => g.suggested);
    expect(suggested).toHaveLength(1);
    expect(suggested[0]!.name).toMatch(/rust|topic/i);
    const members = (await db.items.all()).filter((i) => i.groupId === suggested[0]!.id);
    expect(members).toHaveLength(4);
    expect(members.every((i) => i.groupSource === 'auto')).toBe(true);

    // The same topic grows by one and a new topic appears: only the new one is suggested.
    await unsorted(1, 'rustx', vecFor('rust-base'));
    await unsorted(4, 'gardening', vecFor('garden-base'));
    await maybeSuggest(db);
    suggested = (await db.groups.all()).filter((g) => g.suggested);
    expect(suggested).toHaveLength(2);
    const late = (await db.items.all()).find((i) => i.url.includes('rustx'))!;
    expect(late.groupId).toBeNull();
  });

  it('does nothing below 4 Unsorted items', async () => {
    mock = installChromeMock();
    await unsorted(3, 'rust', vecFor('rust-base'));
    await maybeSuggest(db);
    expect(await db.groups.all()).toEqual([]);
  });

  it('caps suggested groups at 5', async () => {
    mock = installChromeMock();
    for (let k = 0; k < 7; k++) await unsorted(4, `topic${k}`, vecFor(`base-${k}`));
    await maybeSuggest(db);
    expect((await db.groups.all()).filter((g) => g.suggested)).toHaveLength(5);
  });
});
