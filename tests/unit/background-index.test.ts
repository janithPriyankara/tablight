import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../../src/ui/mock/chrome-mock';
vi.mock('../../src/background/tab-index', async (orig) => {
  const m = await orig<typeof import('../../src/background/tab-index')>();
  return { ...m, maybeSuggest: vi.fn(m.maybeSuggest) };
});
vi.mock('../../src/shared/hash', async (orig) => {
  const m = await orig<typeof import('../../src/shared/hash')>();
  return { ...m, sha1hex: vi.fn(m.sha1hex) };
});
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
  isWarm: vi.fn(() => false),
  closeIfIdle: vi.fn(async () => undefined),
  OFFSCREEN_IDLE_ALARM: 'offscreen-idle',
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
      expect(items).toHaveLength(4); // 3 tabs + the dashboard that a fresh install opens
      expect(items.filter((i) => i.groupId === 'programming')).toHaveLength(2);
      // The first snapshot is taken after the initial reconcile (web tabs only).
      const snaps = await db.snapshots.all();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]!.windows.flatMap((w) => w.tabs).map((t) => t.url)).toHaveLength(2);
    });
    expect(mock.tabs().filter((t) => t.url === 'chrome-extension://mock-extension-id/dashboard.html')).toHaveLength(1);
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
    await expect(bg.handleRequest({ t: 'search', q: 'agnet', semantic: 'yes' as unknown as boolean })).rejects.toThrow();
    // Semantic search reads vectors in one transaction and never hashes per item.
    const { sha1hex } = await import('../../src/shared/hash');
    const getMany = vi.spyOn(db.embeddings, 'getMany');
    const getOne = vi.spyOn(db.embeddings, 'get');
    vi.mocked(sha1hex).mockClear();
    await bg.handleRequest({ t: 'search', q: 'agnet', semantic: true });
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getOne).not.toHaveBeenCalled();
    expect(sha1hex).not.toHaveBeenCalled();
    // Latest wins: a search superseded while embedding returns no meaning.
    let release!: () => void;
    vi.mocked(embed).mockImplementationOnce(async (t) => {
      await new Promise<void>((res) => (release = res));
      return t.map(() => new Float32Array(384).fill(0.05));
    });
    const older = bg.handleRequest({ t: 'search', q: 'agnet', semantic: true }) as Promise<typeof r>;
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const newer = (await bg.handleRequest({ t: 'search', q: 'agnet', semantic: true })) as typeof r;
    release();
    expect(await older).toMatchObject({ meaning: [], superseded: true });
    expect(newer.meaning.length).toBeGreaterThan(0);
    vi.mocked(embed).mockRejectedValueOnce(new Error('offline'));
    const failed = (await bg.handleRequest({ t: 'search', q: 'agnet', semantic: true })) as typeof r;
    expect(failed.words).toHaveLength(1);
    expect(failed.meaning).toEqual([]);
    mock.uninstall();
  });
  it('a sync pull that queues items kicks classification', async () => {
    const mock = installChromeMock({ windows: [] });
    const bg = await import('../../src/background/index');
    const { sha1hex } = await vi.importActual<typeof import('../../src/shared/hash')>('../../src/shared/hash');
    const url = 'https://github.com/remote/kick';
    const id = await sha1hex(url);
    const db = await bg.getDb();
    await chrome.storage.sync.set({ 'v1:0': JSON.stringify([[id, url, 'Kick', '', 1, 1]]), 'v1:meta': { chunks: 1, updatedAt: 1 } });
    await vi.waitFor(async () => {
      const it = await db.items.get(id);
      expect(it?.state).toBe('stashed');
      expect(await db.queue.size()).toBe(0);
      expect(it?.embKey).toBeTypeOf('string'); // classified by the kicked pipeline
    }, { timeout: 5000 });
    mock.uninstall();
  });
  it('stashed, synced and imported items stay findable by meaning (embKey survives those paths)', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://stackoverflow.com/questions/9/zzz', title: 'Zzz question' }] }] });
    const bg = await import('../../src/background/index');
    const { whenTabIndexIdle } = await import('../../src/background/tab-index');
    mock.fireInstalled();
    const db = await bg.getDb();
    const open = async () => (await db.items.all()).find((i) => i.title === 'Zzz question' && i.state === 'open');
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect((await open())?.embKey).toBeTypeOf('string');
    });
    const search = async (q: string) =>
      ((await bg.handleRequest({ t: 'search', q, semantic: true })) as { meaning: { title: string }[] }).meaning.map((i) => i.title);
    // 1. stash: the stash record carries the key.
    await bg.handleRequest({ t: 'stash', ids: [(await open())!.id] });
    const stashed = (await db.items.all()).find((i) => i.title === 'Zzz question' && i.state === 'stashed')!;
    expect(stashed.embKey).toBeTypeOf('string');
    expect(await search('unrelated')).toContain('Zzz question');
    // 2. a sync upsert for an existing classified record with unchanged content keeps the key.
    await chrome.storage.sync.set({
      'v1:0': JSON.stringify([[stashed.id, stashed.normUrl, stashed.title, '', stashed.stashedAt, stashed.updatedAt + 100000]]),
      'v1:meta': { chunks: 1, updatedAt: 1 },
    });
    await vi.waitFor(async () => expect((await db.items.get(stashed.id))!.updatedAt).toBe(stashed.updatedAt + 100000), { timeout: 4000 });
    expect((await db.items.get(stashed.id))!.embKey).toBe(stashed.embKey);
    // 3. an imported item with a group (never queued by import) gets its key through the backfill.
    const json = JSON.stringify({
      format: 'tab-organizer', version: 1, exportedAt: 1, groups: [{ name: 'Travel' }], snapshots: [],
      items: [{ url: 'https://example.net/trip', title: 'Imported trip', groupName: 'Travel' }],
    });
    await bg.handleRequest({ t: 'import', json });
    await vi.waitFor(async () => {
      expect((await db.items.all()).find((i) => i.title === 'Imported trip')?.embKey).toBeTypeOf('string');
    });
    expect(await search('unrelated')).toContain('Imported trip');
    mock.uninstall();
  });
  it('state RPC returns totals, group counts without vectors, the active duplicate and statuses', async () => {
    const mock = installChromeMock({
      windows: [
        { tabs: [
          { url: 'https://www.youtube.com/watch?v=abc', title: 'Video', active: true },
          { url: 'https://www.youtube.com/watch?v=abc', title: 'Video' },
          { url: 'chrome://settings', title: 'Settings' },
        ] },
        { tabs: [{ url: 'https://stackoverflow.com/questions/5/s', title: 'State Q', active: true }] },
      ],
    });
    const bg = await import('../../src/background/index');
    const { whenTabIndexIdle } = await import('../../src/background/tab-index');
    const db = await bg.getDb();
    mock.fireInstalled('update'); // an update: no dashboard tab opens
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect(await db.queue.size()).toBe(0);
      expect((await db.items.all()).filter((i) => i.state !== 'stashed')).toHaveLength(4);
    });
    const [a, b] = mock.tabs();
    const vids = (await db.items.all()).filter((i) => i.title === 'Video' && i.state === 'open');
    await bg.handleRequest({ t: 'moveItems', ids: vids.map((i) => i.id), groupId: 'videos' });
    mock.focusWindow(1);
    type S = import('../../src/shared/types').DashboardState;
    let s = (await bg.handleRequest({ t: 'state' })) as S;
    expect(s.windows).toBe(2);
    expect(s.sleeping).toBe(0);
    expect(s.dupCount).toBe(1); // one extra copy
    expect(s.items.filter((i) => i.state !== 'stashed')).toHaveLength(4);
    expect(s.activeDup?.item.tabId).toBe(a!.id);
    expect(s.activeDup?.others.map((i) => i.tabId)).toEqual([b!.id]);
    const inGroup = s.items.filter((i) => i.groupId === 'videos');
    const g = s.groups.find((x) => x.id === 'videos')!;
    expect(g.count).toBe(inGroup.length);
    expect(g.count).toBeGreaterThanOrEqual(2);
    expect(g.watchCount).toBe(inGroup.filter((i) => i.kind === 'watch').length);
    expect(g.watchCount).toBeGreaterThanOrEqual(2); // youtube watch pages
    for (const g of s.groups) {
      expect(g.exemplars).toEqual([]); // vectors never go to the UI
      expect(g.centroid).toBeNull();
    }
    const { readSyncStatus } = await import('../../src/background/sync');
    expect(s.syncStatus).toEqual(await readSyncStatus());
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect(await db.queue.size()).toBe(0);
    });
    expect(((await bg.handleRequest({ t: 'state' })) as S).modelReady).toBe(true); // starter groups, empty queue
    expect(((await bg.handleRequest({ t: 'state' })) as S).queued).toBe(0);
    expect(s.lastSession).toBeUndefined();
    // No duplicate for the focused window's active tab: no alert.
    mock.focusWindow(2);
    s = (await bg.handleRequest({ t: 'state' })) as S;
    expect(s.activeDup).toBeUndefined();
    // A sleeping tab counts; the last session shows when the startup check stored one.
    const so = (await db.items.all()).find((i) => i.title === 'State Q')!;
    await db.items.put({ ...so, state: 'sleeping' });
    const snap = await bg.handleRequest({ t: 'snapshotNow' }) as { id: string };
    await chrome.storage.session.set({ lastSession: { snapshotId: snap.id } });
    s = (await bg.handleRequest({ t: 'state' })) as S;
    expect(s.sleeping).toBe(1);
    expect(s.lastSession?.id).toBe(snap.id);
    // Not ready while work is queued and the embedder has not produced a vector this session.
    await db.queue.add(so.id);
    expect(((await bg.handleRequest({ t: 'state' })) as S).modelReady).toBe(false);
    expect(((await bg.handleRequest({ t: 'state' })) as S).queued).toBe(1); // the queue size is reported
    const { isWarm } = await import('../../src/background/embedder');
    vi.mocked(isWarm).mockReturnValue(true);
    expect(((await bg.handleRequest({ t: 'state' })) as S).modelReady).toBe(true);
    await db.queue.remove([so.id]);
    mock.uninstall();
  });
  it('the offscreen-idle alarm and the document\'s offscreenIdle request both run closeIfIdle', async () => {
    const mock = installChromeMock({ windows: [] });
    const bg = await import('../../src/background/index');
    const { closeIfIdle } = await import('../../src/background/embedder');
    vi.mocked(closeIfIdle).mockClear();
    await mock.chrome.alarms.create('offscreen-idle', { delayInMinutes: 1 });
    mock.fireAlarm('offscreen-idle');
    expect(closeIfIdle).toHaveBeenCalledTimes(1);
    expect(await bg.handleRequest({ t: 'offscreenIdle' })).toBeNull();
    expect(closeIfIdle).toHaveBeenCalledTimes(2);
    mock.uninstall();
  });
  it('the open-dashboard command opens the dashboard once, then focuses it', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.example/', title: 'A' }] }] });
    await import('../../src/background/index');
    expect(mock.chrome.commands.onCommand.hasListeners()).toBe(true);
    const dash = () => mock.tabs().filter((t) => t.url?.startsWith('chrome-extension://mock-extension-id/dashboard.html'));
    mock.fireCommand('something-else');
    mock.fireCommand('open-dashboard');
    await vi.waitFor(() => expect(dash()).toHaveLength(1));
    mock.activateTab(mock.tabs()[0]!.id!);
    mock.fireCommand('open-dashboard');
    await vi.waitFor(() => expect(dash()[0]!.active).toBe(true));
    expect(dash()).toHaveLength(1);
    mock.uninstall();
  });
  it('stashDelete validates ids and deletes only stashed records', async () => {
    const mock = installChromeMock({ windows: [] });
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    const rec = {
      id: 'st1', url: 'https://s.example/', normUrl: 'https://s.example/', title: 'S', domain: 's.example',
      state: 'stashed' as const, groupId: null, groupSource: 'auto' as const, kind: 'other' as const,
      createdAt: 1, lastActiveAt: 1, stashedAt: 1, updatedAt: 1, classifiable: true,
    };
    await db.items.put(rec);
    await expect(bg.handleRequest({ t: 'stashDelete', ids: 'st1' as never })).rejects.toThrow();
    const r = (await bg.handleRequest({ t: 'stashDelete', ids: ['st1'] })) as { deleted: number; token: string };
    expect(r.deleted).toBe(1);
    expect(await db.items.get('st1')).toBeUndefined();
    expect(await bg.handleRequest({ t: 'undo', token: r.token })).toBe(true);
    expect((await db.items.get('st1'))?.state).toBe('stashed');
    mock.uninstall();
  });
  it('deleteAllData wipes our IndexedDB, local and v1:* sync data only, keeps tabs open, then re-seeds', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }] }] });
    const bg = await import('../../src/background/index');
    const { whenTabIndexIdle } = await import('../../src/background/tab-index');
    mock.fireInstalled('update');
    const db = await bg.getDb();
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect((await db.items.all()).filter((i) => i.state === 'open').map((i) => i.url).sort()).toEqual(['https://a.example/', 'https://b.example/']);
    });
    const ia = (await db.items.all()).find((i) => i.url === 'https://a.example/');
    const st = (await bg.handleRequest({ t: 'stash', ids: [ia!.id] })) as { token: string };
    await bg.handleRequest({ t: 'snapshotNow' });
    await db.settings.set({ onboarded: true, syncEnabled: false, theme: 'dark' });
    await db.tombstones.put({ id: 'gone', deletedAt: 1 });
    await chrome.storage.sync.set({ 'v1:meta': { x: 1 }, 'v1:0': 'chunk', 'other-ext-key': 1 });
    await chrome.storage.local.set({ syncStatus: { ok: true }, syncedIds: ['x'], dismissedSuggestions: [['a']], foreign: 1 });
    const openTabs = mock.tabs().length;
    await bg.handleRequest({ t: 'deleteAllData' });
    expect(mock.tabs()).toHaveLength(openTabs); // nothing closed
    expect(await db.snapshots.all()).toEqual([]);
    expect(await db.tombstones.all()).toEqual([]);
    expect(await db.stashBackups.all()).toEqual([]);
    expect(await db.items.byState('stashed')).toEqual([]);
    const settings = await db.settings.get();
    expect(settings).toMatchObject({ onboarded: false, theme: 'system', syncEnabled: false }); // the sync choice is kept
    expect(Object.keys(await chrome.storage.sync.get(null))).toEqual(['other-ext-key']);
    expect(Object.keys(await chrome.storage.local.get(null))).toEqual(['foreign']);
    expect((await db.groups.all()).length).toBeGreaterThan(10); // starter groups re-seeded
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect((await db.items.all()).map((i) => i.url).sort()).toEqual(['https://b.example/']); // the open tab is re-indexed
    });
    expect(await bg.handleRequest({ t: 'undo', token: st.token })).toBe(false); // no undo across a wipe
    mock.uninstall();
  });
  it('groupDelete re-sorts the deleted group\'s items into the remaining groups', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://stackoverflow.com/questions/9/z', title: 'Z' }] }] });
    const bg = await import('../../src/background/index');
    const { whenTabIndexIdle } = await import('../../src/background/tab-index');
    mock.fireInstalled('update');
    const db = await bg.getDb();
    const find = async () => (await db.items.all()).find((i) => i.url === 'https://stackoverflow.com/questions/9/z');
    await vi.waitFor(async () => {
      await whenTabIndexIdle();
      expect((await find())?.groupId).toBe('programming');
    });
    const g = (await bg.handleRequest({ t: 'groupCreate', name: 'Temp', ids: [(await find())!.id] })) as { id: string };
    expect((await find())?.groupId).toBe(g.id);
    await bg.handleRequest({ t: 'groupDelete', id: g.id });
    await vi.waitFor(async () => {
      expect(await db.queue.size()).toBe(0);
      expect((await find())?.groupId).toBe('programming');
    });
    mock.uninstall();
  });

  describe('suspicious tabs', () => {
    type S = import('../../src/shared/types').DashboardState;
    const SCAM = { url: 'https://ads.example.com/click/x?key=1', title: 'You have won a prize' };
    async function boot() {
      const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/', active: true }, SCAM] }] });
      const bg = await import('../../src/background/index');
      const { whenTabIndexIdle } = await import('../../src/background/tab-index');
      await (await bg.getDb()).settings.set({ suspiciousTabs: true }); // the fake IndexedDB outlives each test
      mock.fireInstalled('update');
      await vi.waitFor(async () => {
        await whenTabIndexIdle();
        expect((await (await bg.getDb()).items.all()).length).toBe(2);
      });
      return { mock, bg };
    }
    it('state lists a flagged tab, and the setting turns the list (and the badge) off', async () => {
      const { mock, bg } = await boot();
      const [a, scam] = mock.tabs();
      await vi.waitFor(async () => expect(((await bg.handleRequest({ t: 'state' })) as S).suspicious).toHaveLength(1));
      const s = (await bg.handleRequest({ t: 'state' })) as S;
      expect(s.suspicious[0]!.item.tabId).toBe(scam!.id);
      await vi.waitFor(() => expect(mock.badgeText(a!.id)).toBe('!'));
      expect(mock.badgeText(scam!.id)).toBe('!');
      expect(mock.badgeColor()).toBe('#c2410c');
      expect(mock.actionTitle()).toBe('Tablight: 1 suspicious tab');
      expect(await mock.sendMessage({ t: 'settings', patch: { suspiciousTabs: false } })).toMatchObject({ ok: true });
      expect(((await bg.handleRequest({ t: 'state' })) as S).suspicious).toEqual([]);
      expect(mock.badgeText(a!.id)).toBe('');
      expect(mock.badgeText(scam!.id)).toBe('');
      expect(mock.actionTitle()).toBe('Tablight');
      mock.uninstall();
    });
    it('activating a flagged tab refreshes the badge through the activation path', async () => {
      const mock = installChromeMock({
        windows: [{ tabs: [{ url: 'https://a.com/', active: true }, { url: 'https://ads.example.com/click/x?key=1', title: 'Hello' }] }],
      });
      const bg = await import('../../src/background/index');
      const { whenTabIndexIdle } = await import('../../src/background/tab-index');
      const db = await bg.getDb();
      await db.settings.set({ suspiciousTabs: true });
      mock.fireInstalled('update');
      await vi.waitFor(async () => {
        await whenTabIndexIdle();
        expect((await db.items.all()).length).toBe(2);
      });
      const [a, tab] = mock.tabs();
      // Address clue + the tab never opened ("unseen") = suspicious.
      const item = (await db.items.all()).find((i) => i.tabId === tab!.id)!;
      await db.items.put({ ...item, opened: false });
      await mock.sendMessage({ t: 'settings', patch: { suspiciousTabs: true } }); // refresh the badge now
      await vi.waitFor(async () => expect(mock.badgeText(tab!.id)).toBe('!'));
      expect(mock.badgeText(a!.id)).toBe('!');
      mock.activateTab(tab!.id!);
      // Its "unseen" clue is gone once viewed; only the address clue remains, so the alert clears.
      await vi.waitFor(async () => {
        expect((await bg.handleRequest({ t: 'state' }) as S).suspicious).toEqual([]);
        expect(mock.badgeText(a!.id)).toBe('');
      });
      expect(mock.badgeText(tab!.id)).toBe('');
      mock.uninstall();
    });
    it('keepTab removes the tab from the next state and clears the badge', async () => {
      const { mock, bg } = await boot();
      const [a] = mock.tabs();
      await vi.waitFor(async () => expect(((await bg.handleRequest({ t: 'state' })) as S).suspicious).toHaveLength(1));
      const id = ((await bg.handleRequest({ t: 'state' })) as S).suspicious[0]!.item.id;
      expect(await mock.sendMessage({ t: 'keepTab', id })).toMatchObject({ ok: true });
      expect(((await bg.handleRequest({ t: 'state' })) as S).suspicious).toEqual([]);
      expect(mock.badgeText(a!.id)).toBe('');
      expect(await mock.sendMessage({ t: 'keepTab', id: 'nope' })).toMatchObject({ ok: false });
      mock.uninstall();
    });
    it('a kept tab that goes to another site and back is flagged again', async () => {
      const { mock, bg } = await boot();
      const { whenTabIndexIdle } = await import('../../src/background/tab-index');
      const [a, scam] = mock.tabs();
      const sus = async () => ((await bg.handleRequest({ t: 'state' })) as S).suspicious;
      await vi.waitFor(async () => expect(await sus()).toHaveLength(1));
      const id = (await sus())[0]!.item.id;
      expect(await mock.sendMessage({ t: 'keepTab', id })).toMatchObject({ ok: true });
      expect(await sus()).toEqual([]);
      // Another site, seen by the index (and the badge pass after it)...
      mock.updateTab(scam!.id!, { url: 'https://b.com/', title: 'B' });
      await vi.waitFor(async () => {
        await whenTabIndexIdle();
        expect((await (await bg.getDb()).items.all()).some((i) => i.url === 'https://b.com/')).toBe(true);
      });
      await vi.waitFor(async () => expect(await sus()).toEqual([]));
      // ...then back to the scam page: the keep ended when the tab left the site.
      mock.updateTab(scam!.id!, SCAM);
      await vi.waitFor(async () => {
        await whenTabIndexIdle();
        expect((await sus()).map((s) => s.item.tabId)).toEqual([scam!.id]);
      });
      await vi.waitFor(() => expect(mock.badgeText(a!.id)).toBe('!'));
      mock.uninstall();
    });
  });
});
