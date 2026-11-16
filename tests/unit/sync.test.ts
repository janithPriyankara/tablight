import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
}));
import { openDb, type Db } from '../../src/background/db';
import { embed } from '../../src/background/embedder';
import {
  MAX_NEW_GROUPS, SYNCED_IDS_KEY, SYNC_RETRY_ALARM, SYNC_STATUS_KEY, handleSyncStorageChange, pullSync, pushSync,
  readSyncStatus, scheduleSync, setSyncEnabled, touchStashedInGroup, wasSynced,
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

  it('onChanged: our own write is ignored; any other v1:* change pulls once, debounced 1 s', async () => {
    await stashed('https://a.com/');
    await chrome.storage.sync.set({ 'v1:5': 'stale' });
    await pushSync(db); // removes v1:5, writes v1:0 + meta
    const store = await syncStore();
    const own = { [META_KEY]: { newValue: store[META_KEY] }, 'v1:0': { newValue: store['v1:0'] }, 'v1:5': { oldValue: 'stale' } };
    expect(handleSyncStorageChange(db, own, 'sync')).toBe(false);
    expect(handleSyncStorageChange(db, { 'v1:9': { newValue: 'x' } }, 'local')).toBe(false);
    expect(handleSyncStorageChange(db, { other: { newValue: 'x' } }, 'sync')).toBe(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const get = vi.spyOn(chrome.storage.sync, 'get');
    const r = await remoteRec('https://r.com/');
    // Another device's write arrives in two batches: chunk first, meta later (no meta change at all first).
    expect(handleSyncStorageChange(db, { 'v1:1': { newValue: 'chunk' } }, 'sync')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await remote([r]);
    expect(handleSyncStorageChange(db, { [META_KEY]: { newValue: { chunks: 1, updatedAt: 1 } } }, 'sync')).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(async () => expect(await db.items.get(r[0])).toBeDefined());
    expect(get).toHaveBeenCalledTimes(1);
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
describe('review fixes', () => {
  it('removes stale keys before setting the new chunks', async () => {
    await stashed('https://a.com/');
    await chrome.storage.sync.set({ 'v1:3': 'stale' });
    const order: string[] = [];
    vi.spyOn(chrome.storage.sync, 'remove').mockImplementation(async () => void order.push('remove'));
    vi.spyOn(chrome.storage.sync, 'set').mockImplementation(async () => void order.push('set'));
    await pushSync(db);
    expect(order).toEqual(['remove', 'set']);
  });
  it('pauses after more than 6 pull-triggered writes in 10 minutes: status rate, retry in 15 min, warning logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let k = 0; k < 6; k++) {
      await stashed(`https://a${k}.com/`);
      expect(await pullSync(db)).toMatchObject({ ok: true });
    }
    await stashed('https://a6.com/');
    const set = vi.spyOn(chrome.storage.sync, 'set');
    expect(await pullSync(db)).toMatchObject({ ok: false, reason: 'rate', message: 'sync paused: devices disagree' });
    expect(set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const alarm = mock.alarms().find((a) => a.name === SYNC_RETRY_ALARM)!;
    expect(alarm.scheduledTime - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await db.items.byState('stashed')).toHaveLength(7); // local data untouched
    set.mockRestore();
    // The user's own changes are never paused: a push is not counted.
    expect(await pushSync(db)).toMatchObject({ ok: true, synced: 7 });
    for (let k = 0; k < 8; k++) {
      await stashed(`https://b${k}.com/`);
      expect(await pushSync(db)).toMatchObject({ ok: true });
    }
  });

  it('the backstop never moves an existing (rate/pause) sync-retry alarm earlier', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: 15 });
    const before = mock.alarms().find((a) => a.name === SYNC_RETRY_ALARM)!.scheduledTime;
    scheduleSync(db);
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.alarms().find((a) => a.name === SYNC_RETRY_ALARM)!.scheduledTime).toBe(before);
  });

  it('wasSynced is true while a pass is queued or running (it may be pushing that id)', async () => {
    const a = await stashed('https://a.com/');
    let release!: () => void;
    vi.spyOn(chrome.storage.sync, 'get').mockImplementationOnce(() => new Promise((r) => (release = () => r({}))));
    const p = pushSync(db);
    expect(await wasSynced(a.id)).toBe(true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await p;
    await chrome.storage.local.set({ [SYNCED_IDS_KEY]: [] });
    expect(await wasSynced(a.id)).toBe(false);
  });
  it('scheduleSync sets a sync-retry backstop alarm; a successful pass clears it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scheduleSync(db);
    await vi.waitFor(() => expect(mock.alarms().map((a) => a.name)).toContain(SYNC_RETRY_ALARM));
    const a = mock.alarms().find((x) => x.name === SYNC_RETRY_ALARM)!;
    expect(a.scheduledTime - Date.now()).toBeGreaterThanOrEqual(29_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(mock.alarms().map((x) => x.name)).not.toContain(SYNC_RETRY_ALARM));
  });
  it('remote names never match suggested groups; invalid names stay unsorted; at most 50 groups per pass', async () => {
    await db.groups.put(group('s1', 'Cooking', { suggested: true, builtIn: false }));
    const recs = [
      await remoteRec('https://cook.com/', { group: 'cooking' }),
      await remoteRec('https://blank.com/', { group: '   ' }),
    ];
    for (let k = 0; k < MAX_NEW_GROUPS + 5; k++) recs.push(await remoteRec(`https://g${k}.com/`, { group: `Group ${k}` }));
    await remote(recs);
    await pullSync(db);
    const groups = await db.groups.all();
    expect(groups.filter((g) => !g.suggested)).toHaveLength(MAX_NEW_GROUPS);
    const cook = (await db.items.byState('stashed')).find((i) => i.normUrl === 'https://cook.com/')!;
    expect(cook.groupId).not.toBe('s1');
    const blank = (await db.items.byState('stashed')).find((i) => i.normUrl === 'https://blank.com/')!;
    expect(blank).toMatchObject({ groupId: null, groupSource: 'auto' });
    expect((await db.items.byState('stashed')).filter((i) => i.groupId === null).length).toBeGreaterThanOrEqual(5);
  });
  it('readSyncStatus validates the stored shape', async () => {
    await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { ok: true, synced: 'x' } });
    expect(await readSyncStatus()).toEqual({ ok: true, synced: 0, localOnly: 0, lastSyncAt: null });
    await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { ok: false, reason: 'pwned', message: 'm', lastSyncAt: null } });
    expect((await readSyncStatus()).ok).toBe(true);
    await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { ok: false, reason: 'quota', message: 'm', lastSyncAt: 5, extra: 1 } });
    expect(await readSyncStatus()).toEqual({ ok: false, reason: 'quota', message: 'm', lastSyncAt: 5 });
  });
  it('wasSynced: ids seen remotely or pushed count; never-pushed ones do not', async () => {
    const a = await stashed('https://a.com/');
    expect(await wasSynced(a.id)).toBe(false);
    await pushSync(db);
    expect(await wasSynced(a.id)).toBe(true);
    const r = await remoteRec('https://r.com/');
    await remote([r]);
    await pullSync(db);
    expect(await wasSynced(r[0])).toBe(true);
    expect((await chrome.storage.local.get(SYNCED_IDS_KEY))[SYNCED_IDS_KEY]).toEqual(expect.arrayContaining([a.id, r[0]]));
  });
  it('a pass that changes nothing does not touch local updatedAt (far-future remote values kept raw)', async () => {
    const future = Date.now() + 3 * 86_400_000;
    await remote([await remoteRec('https://f.com/', { updatedAt: future })]);
    await pullSync(db);
    const before = await db.items.all();
    const set = vi.spyOn(chrome.storage.sync, 'set');
    await pullSync(db);
    await pullSync(db);
    expect(await db.items.all()).toEqual(before);
    expect(before[0]!.updatedAt).toBe(future);
    expect(set).not.toHaveBeenCalled();
  });
});
