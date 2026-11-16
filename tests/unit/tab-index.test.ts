import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import {
  configureTabIndex,
  embeddingKey,
  maybeSuggest,
  onTabEvent,
  processQueue,
  reconcile,
  whenTabIndexIdle,
} from '../../src/background/tab-index';
import type { Group, Item } from '../../src/shared/types';
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

describe('event storm (Review Focus 2)', () => {
  it('300 creates + 200 removes within 100 ms end matching tabs.query with no dup tabIds', async () => {
    mock = installChromeMock({ windows: [{ tabs: [web(1), web(2), web(3)] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const keep = (await db.items.all()).find((i) => i.url === web(1).url)!;
    await db.items.put({ ...keep, groupId: 'mine', groupSource: 'user' });

    configureTabIndex({ db: async () => db, after: async (d) => void (await processQueue(d, fakeEmbed)) });
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
