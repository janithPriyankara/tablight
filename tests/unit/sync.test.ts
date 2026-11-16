import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
}));
import { openDb, type Db } from '../../src/background/db';
import { embed } from '../../src/background/embedder';
import {
  SYNC_RETRY_ALARM, SYNC_STATUS_KEY, handleSyncStorageChange, pullSync, pushSync, readSyncStatus, scheduleSync,
  setSyncEnabled, touchStashedInGroup,
} from '../../src/background/sync';
import { META_KEY, encodeChunks, toRecord, type SyncRecord, type Tomb } from '../../src/sync/sync-codec';
import { sha1hex } from '../../src/shared/hash';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

let n = 0;
let db: Db;
let mock: ChromeMockControl;
beforeEach(async () => {
  db = await openDb(`sync-${n++}`);
  mock = installChromeMock({ windows: [] });
});
afterEach(() => {
  mock.uninstall();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function stashed(url: string, p: Partial<Item> = {}): Promise<Item> {
  const now = Date.now();
  const it: Item = {
    id: await sha1hex(url), url, normUrl: url, title: `T ${url}`, domain: new URL(url).hostname, state: 'stashed',
    groupId: null, groupSource: 'auto', kind: 'read', createdAt: now, lastActiveAt: now, stashedAt: now, updatedAt: now,
    classifiable: true, ...p,
  };
  await db.items.put(it);
  return it;
}
const group = (id: string, name: string, p: Partial<Group> = {}): Group => ({
  id, name, color: '#000', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 1, ...p,
});
async function remote(recs: SyncRecord[], tombs: Tomb[] = []): Promise<void> {
  const { chunks } = encodeChunks(recs, tombs);
  await chrome.storage.sync.set({ ...chunks, [META_KEY]: { chunks: Object.keys(chunks).length, updatedAt: 1 } });
}
async function remoteRec(url: string, p: { title?: string; group?: string; updatedAt?: number; id?: string } = {}) {
  const at = p.updatedAt ?? Date.now();
  return [p.id ?? (await sha1hex(url)), url, p.title ?? 'R', p.group ?? '', at, at] as SyncRecord;
}
const syncStore = () => chrome.storage.sync.get(null);

describe('pushSync', () => {
  it('writes chunks + meta for stashed items (not open ones) and reports counts', async () => {
    await db.groups.put(group('news', 'News'));
    const a = await stashed('https://a.com/', { groupId: 'news', groupSource: 'user' });
    await db.items.put({ ...a, id: 'open-1', state: 'open', tabId: 1 });
    const st = await pushSync(db);
    expect(st).toMatchObject({ ok: true, synced: 1, localOnly: 0 });
    const store = await syncStore();
    expect(store[META_KEY]).toMatchObject({ chunks: 1 });
    expect(JSON.parse(store['v1:0'] as string)).toEqual([toRecord(a, 'News')]);
    expect((await chrome.storage.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY]).toMatchObject({ ok: true, synced: 1 });
    expect((await readSyncStatus()).lastSyncAt).toBeTypeOf('number');
  });

  it('only writes changed chunks in one set, then removes stale keys', async () => {
    for (let k = 0; k < 3; k++) await stashed(`https://a${k}.com/`);
    await chrome.storage.sync.set({ 'v1:7': 'stale', 'v1:8': 'stale' });
    await pushSync(db);
    const set = vi.spyOn(chrome.storage.sync, 'set');
    const remove = vi.spyOn(chrome.storage.sync, 'remove');
    expect(await pushSync(db)).toMatchObject({ ok: true, synced: 3 });
    expect(set).not.toHaveBeenCalled(); // nothing changed
    expect(remove).not.toHaveBeenCalled();
    expect(Object.keys(await syncStore()).sort()).toEqual(['v1:0', 'v1:meta']);
  });

  it('QUOTA_BYTES error → {ok:false, reason:"quota"}, local items unchanged, status stored for the UI', async () => {
    await stashed('https://a.com/');
    const before = await db.items.all();
    vi.spyOn(chrome.storage.sync, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));
    const st = await pushSync(db);
    expect(st).toMatchObject({ ok: false, reason: 'quota' });
    expect(await db.items.all()).toEqual(before);
    expect(await readSyncStatus()).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('MAX_WRITE_OPERATIONS error → reason "rate" and a sync-retry alarm in 2 min', async () => {
    await stashed('https://a.com/');
    vi.spyOn(chrome.storage.sync, 'set').mockRejectedValue(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded'));
    expect(await pushSync(db)).toMatchObject({ ok: false, reason: 'rate' });
    const alarm = mock.alarms().find((a) => a.name === SYNC_RETRY_ALARM)!;
    expect(alarm.scheduledTime - Date.now()).toBeGreaterThan(110_000);
  });

  it('syncEnabled:false → no storage.sync calls at all, status "disabled"', async () => {
    await db.settings.set({ syncEnabled: false });
    await stashed('https://a.com/');
    await chrome.storage.sync.set({ 'v1:0': 'remote', [META_KEY]: { chunks: 1, updatedAt: 1 } });
    const spies = (['get', 'set', 'remove'] as const).map((m) => vi.spyOn(chrome.storage.sync, m));
    expect(await pushSync(db)).toMatchObject({ ok: false, reason: 'disabled' });
    expect(await pullSync(db)).toMatchObject({ ok: false, reason: 'disabled' });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(await readSyncStatus()).toMatchObject({ reason: 'disabled' });
  });

  it('turning sync off keeps remote data; turning it on pulls then pushes', async () => {
    await remote([await remoteRec('https://r.com/')]);
    await setSyncEnabled(db, false);
    expect(Object.keys(await syncStore())).toContain('v1:0');
    await stashed('https://a.com/');
    const st = await setSyncEnabled(db, true);
    expect(st).toMatchObject({ ok: true, synced: 2 });
    expect((await db.items.byState('stashed')).map((i) => i.normUrl).sort()).toEqual(['https://a.com/', 'https://r.com/']);
  });

  it('scheduleSync debounces pushes by 5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const set = vi.spyOn(chrome.storage.sync, 'set');
    await stashed('https://a.com/');
    scheduleSync(db);
    scheduleSync(db);
    await vi.advanceTimersByTimeAsync(4_000);
    scheduleSync(db);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  });
});

describe('pullSync', () => {
  it('adds remote records as stashed items; group names are matched case-insensitively or created', async () => {
    await db.groups.put(group('news', 'News'));
    await remote([
      await remoteRec('https://a.com/', { group: 'news' }),
      await remoteRec('https://b.com/', { group: 'Recipes' }),
      await remoteRec('https://c.com/'),
    ]);
    expect(await pullSync(db)).toMatchObject({ ok: true, synced: 3 });
    const groups = await db.groups.all();
    const recipes = groups.find((g) => g.name === 'Recipes')!;
    expect(recipes).toMatchObject({ builtIn: false });
    expect(recipes.centroid).toHaveLength(384);
    expect(groups.filter((g) => g.name.toLowerCase() === 'news')).toHaveLength(1);
    const items = await db.items.byState('stashed');
    const by = (u: string) => items.find((i) => i.normUrl === u)!;
    expect(by('https://a.com/')).toMatchObject({ groupId: 'news', groupSource: 'user', title: 'R', url: 'https://a.com/' });
    expect(by('https://b.com/')).toMatchObject({ groupId: recipes.id, groupSource: 'user' });
    expect(by('https://c.com/')).toMatchObject({ groupId: null, groupSource: 'auto' });
    expect(await db.queue.take(10)).toEqual([by('https://c.com/').id]);
  });

  it('an embedding failure creates the group with a null centroid and never blocks the pull', async () => {
    vi.mocked(embed).mockRejectedValueOnce(new Error('model down'));
    await remote([await remoteRec('https://b.com/', { group: 'Recipes' })]);
    expect(await pullSync(db)).toMatchObject({ ok: true });
    expect((await db.groups.all()).find((g) => g.name === 'Recipes')!.centroid).toBeNull();
    expect(await db.items.byState('stashed')).toHaveLength(1);
  });

  it('applying a delete pushes a stash backup first; open tabs are never removed', async () => {
    const a = await stashed('https://a.com/', { updatedAt: 1000 });
    const b = await stashed('https://b.com/', { updatedAt: 1000 });
    await db.items.put({ ...a, id: 'open-1', state: 'open', tabId: 3 });
    await remote([], [[a.id, Date.now()]]);
    const push = vi.spyOn(db.stashBackups, 'push');
    const del = vi.spyOn(db, 'tx');
    await pullSync(db);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.invocationCallOrder[0]!).toBeLessThan(del.mock.invocationCallOrder.at(-1)!);
    const [backup] = await db.stashBackups.all();
    expect(backup!.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(await db.items.get(a.id)).toBeUndefined();
    expect(await db.items.get(b.id)).toBeDefined();
    expect(await db.items.get('open-1')).toBeDefined();
    expect((await db.tombstones.all()).map((t) => t.id)).toEqual([a.id]);
  });

  it('a remote record with a javascript: normUrl, or an id that is not sha1(normUrl), is dropped', async () => {
    await remote([
      await remoteRec('javascript:alert(1)'),
      await remoteRec('https://evil.com/', { id: await sha1hex('https://other.com/') }),
      await remoteRec('https://ok.com/'),
    ]);
    await pullSync(db);
    expect((await db.items.all()).map((i) => i.normUrl)).toEqual(['https://ok.com/']);
  });

  it('a local item absent remotely without a tomb is kept and pushed', async () => {
    await stashed('https://local.com/');
    await remote([await remoteRec('https://r.com/')]);
    await pullSync(db);
    expect(await db.items.byState('stashed')).toHaveLength(2);
    const chunk = JSON.parse((await syncStore())['v1:0'] as string) as SyncRecord[];
    expect(chunk.map((r) => r[1]).sort()).toEqual(['https://local.com/', 'https://r.com/']);
  });

  it('remote newer wins; local newer survives and is pushed', async () => {
    await stashed('https://a.com/', { title: 'old', updatedAt: 100 });
    await stashed('https://b.com/', { title: 'mine', updatedAt: 900 });
    await remote([
      await remoteRec('https://a.com/', { title: 'new', updatedAt: 500 }),
      await remoteRec('https://b.com/', { title: 'theirs', updatedAt: 500 }),
    ]);
    await pullSync(db);
    const items = await db.items.byState('stashed');
    expect(items.find((i) => i.normUrl === 'https://a.com/')).toMatchObject({ title: 'new', updatedAt: 500 });
    expect(items.find((i) => i.normUrl === 'https://b.com/')).toMatchObject({ title: 'mine' });
    const chunk = JSON.parse((await syncStore())['v1:0'] as string) as SyncRecord[];
    expect(chunk.find((r) => r[1] === 'https://b.com/')![2]).toBe('mine');
  });

  it('a malformed remote chunk never throws and never touches local data', async () => {
    await stashed('https://a.com/');
    await chrome.storage.sync.set({ [META_KEY]: { chunks: 2 }, 'v1:0': '{{{', 'v1:1': JSON.stringify([['__proto__']]) });
    expect(await pullSync(db)).toMatchObject({ ok: true, synced: 1 });
    expect(await db.items.all()).toHaveLength(1);
  });

  it('onChanged: our own write is ignored, another device\'s write triggers a pull', async () => {
    await pushSync(db);
    const own = (await syncStore())[META_KEY];
    const get = vi.spyOn(chrome.storage.sync, 'get');
    expect(handleSyncStorageChange(db, { [META_KEY]: { newValue: own } }, 'sync')).toBeUndefined();
    expect(handleSyncStorageChange(db, { [META_KEY]: { newValue: own } }, 'local')).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    await remote([await remoteRec('https://r.com/')]);
    const p = handleSyncStorageChange(db, { [META_KEY]: { newValue: { chunks: 1, updatedAt: 1 } } }, 'sync');
    expect(p).toBeDefined();
    await p;
    expect(await db.items.byState('stashed')).toHaveLength(1);
  });
});

describe('touchStashedInGroup', () => {
  it('bumps updatedAt of stashed items in the group so a rename wins LWW elsewhere', async () => {
    const a = await stashed('https://a.com/', { groupId: 'g1', updatedAt: 5 });
    const b = await stashed('https://b.com/', { groupId: 'g2', updatedAt: 5 });
    await touchStashedInGroup(db, 'g1');
    expect((await db.items.get(a.id))!.updatedAt).toBeGreaterThan(5);
    expect((await db.items.get(b.id))!.updatedAt).toBe(5);
  });
});
