import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../../src/ui/mock/chrome-mock';
vi.mock('../../src/background/tab-index', async (orig) => {
  const m = await orig<typeof import('../../src/background/tab-index')>();
  return { ...m, maybeSuggest: vi.fn(m.maybeSuggest) };
});
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
}));
afterEach(() => vi.resetModules());
describe('background index', () => {
  it('on install seeds groups, indexes and classifies tabs, then marks duplicates', async () => {
    const mock = installChromeMock({
      windows: [{ tabs: [
        { url: 'https://stackoverflow.com/questions/1/x', title: 'Q' },
        { url: 'https://www.stackoverflow.com/questions/1/x/' , title: 'Q' },
        { url: 'chrome://settings', title: 'Settings' },
      ] }],
    });
    const bg = await import('../../src/background/index');
    const { whenTabIndexIdle } = await import('../../src/background/tab-index');
    expect(mock.chrome.tabs.onCreated.hasListeners()).toBe(true);
    expect(mock.chrome.alarms.onAlarm.hasListeners()).toBe(true);
    mock.fireInstalled();
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      const db = await bg.getDb();
      expect((await db.groups.all()).length).toBeGreaterThan(10);
      expect(await db.queue.size()).toBe(0);
      const items = await db.items.all();
      expect(items).toHaveLength(3);
      expect(items.filter((i) => i.groupId === 'programming')).toHaveLength(2);
    });
    const [a, b, c] = mock.tabs();
    await vi.waitFor(() => expect(mock.badgeText(a!.id)).toBe('2×'));
    expect(mock.badgeText(b!.id)).toBe('2×');
    expect(mock.badgeText(c!.id)).toBe('');
    expect(mock.alarms().map((a) => a.name)).toEqual(['auto-sleep', 'snapshot']); // no classify-kick: nothing failed
    // Activation and window focus take the light path: no reconcile, lastActiveAt + that badge.
    const tabIndex = await import('../../src/background/tab-index');
    const suggest = vi.mocked(tabIndex.maybeSuggest);
    const query = vi.spyOn(mock.chrome.tabs, 'query');
    const db = await bg.getDb();
    const before = (await db.items.byTabId(b!.id!))!.lastActiveAt;
    await new Promise((r) => setTimeout(r, 5));
    mock.activateTab(b!.id!);
    await vi.waitFor(async () => expect((await db.items.byTabId(b!.id!))!.lastActiveAt).toBeGreaterThan(before));
    mock.focusWindow(1);
    await new Promise((r) => setTimeout(r, 700));
    await whenTabIndexIdle();
    expect(query.mock.calls.filter(([q]) => Object.keys(q).length === 0)).toHaveLength(0);
    // A change that classifies nothing and deletes nothing doesn't re-cluster Unsorted.
    suggest.mockClear();
    mock.updateTab(c!.id!, { title: 'Settings 2' });
    await new Promise((r) => setTimeout(r, 700));
    await whenTabIndexIdle();
    expect(query).toHaveBeenCalledWith({});
    expect(suggest).not.toHaveBeenCalled();
    // Closing a tab can change Unsorted: it does.
    mock.removeTab(c!.id!);
    await new Promise((r) => setTimeout(r, 700));
    await whenTabIndexIdle();
    expect(suggest).toHaveBeenCalledTimes(1);
    mock.uninstall();
  });
  it('pulls the stash when another device writes storage.sync; its own write-back does not loop', async () => {
    const mock = installChromeMock({ windows: [] });
    const bg = await import('../../src/background/index');
    const { sha1hex } = await import('../../src/shared/hash');
    const url = 'https://remote.example.com/';
    const id = await sha1hex(url);
    const db = await bg.getDb();
    const localUrl = 'https://local.example.com/';
    const localId = await sha1hex(localUrl);
    await db.items.put({
      id: localId, url: localUrl, normUrl: localUrl, title: 'L', domain: 'local.example.com', state: 'stashed',
      groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, stashedAt: 1, updatedAt: 1,
      classifiable: true,
    });
    const set = vi.spyOn(mock.chrome.storage.sync, 'set');
    await chrome.storage.sync.set({ 'v1:0': JSON.stringify([[id, url, 'R', '', 1, 1]]), 'v1:meta': { chunks: 1, updatedAt: 1 } });
    // The pull is debounced by 1 s (a write may arrive in several onChanged batches).
    await vi.waitFor(async () => expect((await db.items.get(id))?.state).toBe('stashed'), { timeout: 3000 });
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2), { timeout: 3000 }); // the remote write + our write-back of the local-only item
    await new Promise((r) => setTimeout(r, 100));
    expect(set).toHaveBeenCalledTimes(2);
    mock.uninstall();
  });
  it('import enqueues items and kicks classification; search RPC finds words and meaning', async () => {
    const mock = installChromeMock({ windows: [] });
    const bg = await import('../../src/background/index');
    const { embed } = await import('../../src/background/embedder');
    const db = await bg.getDb();
    const json = JSON.stringify({
      format: 'tab-organizer', version: 1, exportedAt: 1, groups: [], snapshots: [],
      items: [
        { url: 'https://stackoverflow.com/questions/1/x', title: 'Agent SDK question' },
        { url: 'https://example.org/pasta', title: 'Cooking pasta' },
      ],
    });
    const added = await bg.handleRequest({ t: 'import', json });
    expect(added).toMatchObject({ added: 2 });
    await vi.waitFor(async () => {
      expect(await db.queue.size()).toBe(0);
      const so = (await db.items.all()).find((i) => i.domain === 'stackoverflow.com');
      expect(so?.groupId).toBe('programming'); // classified by the kicked pipeline, not left waiting
    });
    const none = { words: [], meaning: [] };
    expect(await bg.handleRequest({ t: 'search', q: '   ', semantic: true })).toEqual(none);
    await expect(bg.handleRequest({ t: 'search', q: 'x'.repeat(201), semantic: false })).rejects.toThrow();
    const r = (await bg.handleRequest({ t: 'search', q: 'agnet', semantic: true })) as { words: { title: string }[]; meaning: { title: string }[] };
    expect(r.words.map((i) => i.title)).toEqual(['Agent SDK question']);
    // Every cached vector is identical to the mocked query vector, so the other item matches by meaning only.
    const meaning = r.meaning.map((i) => i.title);
    expect(meaning).toContain('Cooking pasta');
    expect(meaning).not.toContain('Agent SDK question'); // already a word match
    expect((await bg.handleRequest({ t: 'search', q: 'agnet', semantic: false }) as typeof r).meaning).toEqual([]);
    vi.mocked(embed).mockRejectedValueOnce(new Error('offline'));
    const failed = (await bg.handleRequest({ t: 'search', q: 'agnet', semantic: true })) as typeof r;
    expect(failed.words).toHaveLength(1);
    expect(failed.meaning).toEqual([]);
    mock.uninstall();
  });
});
