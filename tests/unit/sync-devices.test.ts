// Two simulated devices (own IndexedDB, own chrome.storage.local, own sync module instance and clock)
// sharing one chrome.storage.sync. Passes alternate until a full round writes nothing.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
}));
import { openDb, type Db } from '../../src/background/db';
import { restashTime } from '../../src/background/memory';
import { sha1hex } from '../../src/shared/hash';
import { nextStamp } from '../../src/shared/stamp';
import { decodeChunks } from '../../src/sync/sync-codec';
import type { Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl, type MockStorageArea } from '../../src/ui/mock/chrome-mock';

type SyncModule = typeof import('../../src/background/sync');
interface Device { name: string; db: Db; mock: ChromeMockControl; sync: SyncModule; offset: number; writes: number }

const DAY = 86_400_000;
const PASS_GAP = 150_000; // 2.5 min between passes: never more than 4 passes in the 10-minute guard window
let clock = Date.UTC(2026, 10, 16);
let dbn = 0;
let current: Device | undefined;
const devices: Device[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of devices.splice(0)) d.mock.uninstall();
  delete (globalThis as { chrome?: unknown }).chrome;
});

async function makeDevices(offsetB = 0): Promise<[Device, Device]> {
  vi.spyOn(Date, 'now').mockImplementation(() => clock + (current?.offset ?? 0));
  const mA = installChromeMock({ windows: [] });
  const mB = installChromeMock({ windows: [] });
  const shared = mA.chrome.storage.sync;
  const counted = (fn: keyof MockStorageArea) => {
    const orig = shared[fn].bind(shared) as (x: never) => Promise<unknown>;
    return async (x: never) => {
      if (fn !== 'get' && current) current.writes++;
      return orig(x);
    };
  };
  const area: MockStorageArea = { get: counted('get'), set: counted('set'), remove: counted('remove') } as MockStorageArea;
  (mA.chrome.storage as { sync: MockStorageArea }).sync = area;
  (mB.chrome.storage as { sync: MockStorageArea }).sync = area;
  const mk = async (name: string, mock: ChromeMockControl, offset: number): Promise<Device> => {
    vi.resetModules();
    const sync = await import('../../src/background/sync');
    const d = { name, db: await openDb(`devices-${dbn++}`), mock, sync, offset, writes: 0 };
    devices.push(d);
    return d;
  };
  return [await mk('A', mA, 0), await mk('B', mB, offsetB)];
}

function on<T>(d: Device, fn: () => Promise<T>): Promise<T> {
  current = d;
  (globalThis as { chrome?: unknown }).chrome = d.mock.chrome;
  return fn().finally(() => {
    current = undefined;
  });
}

async function pass(d: Device): Promise<void> {
  clock += PASS_GAP;
  const st = await on(d, () => d.sync.pullSync(d.db));
  expect(st, `${d.name}: ${JSON.stringify(st)}`).toMatchObject({ ok: true });
}

/** Alternates passes until a full round writes nothing; returns the writes per device. */
async function converge(a: Device, b: Device, first: Device = a): Promise<{ A: number; B: number }> {
  a.writes = b.writes = 0;
  const order = first === a ? [a, b] : [b, a];
  for (let round = 0; round < 8; round++) {
    const before = a.writes + b.writes;
    for (const d of order) await pass(d);
    if (a.writes + b.writes === before && round > 0) return { A: a.writes, B: b.writes };
  }
  throw new Error(`no convergence: A wrote ${a.writes}, B wrote ${b.writes}`);
}

const now = (d: Device) => clock + d.offset;
async function put(d: Device, url: string, p: Partial<Item> = {}): Promise<Item> {
  const t = now(d);
  const it: Item = {
    id: await sha1hex(url), url, normUrl: url, title: `T ${url}`, domain: new URL(url).hostname, state: 'stashed',
    groupId: null, groupSource: 'auto', kind: 'read', createdAt: t, lastActiveAt: t, stashedAt: t, updatedAt: t,
    classifiable: true, ...p,
  };
  await d.db.items.put(it);
  return it;
}
/** Deletes a stashed record as memory.ts does: the tombstone is stamped after the record. */
async function remove(d: Device, id: string): Promise<void> {
  const cur = await d.db.items.get(id);
  await d.db.items.delete(id);
  await d.db.tombstones.put({ id, deletedAt: nextStamp(cur?.updatedAt, now(d)) });
}
/** Edits a record as groups.ts / memory.ts do: stamped after its current updatedAt. */
async function edit(d: Device, url: string, p: Partial<Item>): Promise<void> {
  const cur = (await d.db.items.get(await sha1hex(url)))!;
  await d.db.items.put({ ...cur, ...p, updatedAt: nextStamp(cur.updatedAt, now(d)) });
}
const urls = async (d: Device) => (await d.db.items.byState('stashed')).map((i) => i.normUrl).sort();
const titleOf = async (d: Device, url: string) => (await d.db.items.get(await sha1hex(url)))?.title;

describe('two devices sharing storage.sync', () => {
  it('concurrent edits of the same record: the later edit wins on both, in bounded writes', async () => {
    const [a, b] = await makeDevices();
    const r = await put(a, 'https://r.com/');
    await converge(a, b);
    clock += 1000;
    await put(a, r.url, { title: 'A edit', updatedAt: now(a) });
    clock += 1000;
    await put(b, r.url, { title: 'B edit', updatedAt: now(b) });
    const w = await converge(a, b);
    expect(await titleOf(a, r.url)).toBe('B edit');
    expect(await titleOf(b, r.url)).toBe('B edit');
    expect(w.A).toBeLessThanOrEqual(4);
    expect(w.B).toBeLessThanOrEqual(4);
  });

  it('delete on A + later edit on B: the edit survives; edit then later delete: deleted on both, with a backup', async () => {
    const [a, b] = await makeDevices();
    const r = await put(a, 'https://r.com/');
    const s = await put(a, 'https://s.com/');
    await converge(a, b);
    await remove(a, r.id);
    clock += 1000;
    await put(b, r.url, { title: 'B edit', updatedAt: now(b) });
    let w = await converge(a, b);
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
    expect(await urls(a)).toEqual(['https://r.com/', 'https://s.com/']);
    expect(await titleOf(a, r.url)).toBe('B edit');
    expect((await a.db.tombstones.all()).map((t) => t.id)).toEqual([r.id]); // kept until its TTL; the record wins LWW
    await put(b, s.url, { title: 'B edit', updatedAt: now(b) });
    clock += 1000;
    await remove(a, s.id);
    w = await converge(a, b);
    expect(await urls(a)).toEqual(['https://r.com/']);
    expect(await urls(b)).toEqual(['https://r.com/']);
    expect((await b.db.stashBackups.all())[0]!.items.map((i) => i.normUrl)).toContain('https://s.com/');
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
  });

  it('tombstone overflow (2,000 deletes): converges, no resurrection on A, nothing lost that was not deleted', async () => {
    const [a, b] = await makeDevices();
    const keep = await put(a, 'https://keep.com/', { stashedAt: now(a) + 10_000_000 });
    for (let k = 0; k < 2000; k++) {
      const url = `https://site${k}.example.com/page`;
      const p = { stashedAt: now(a) - k * 1000, updatedAt: now(a) - k * 1000, title: `Title ${k}` };
      await put(a, url, p);
      await put(b, url, p);
    }
    await converge(a, b);
    const victims = (await a.db.items.byState('stashed')).filter((i) => i.id !== keep.id);
    for (const i of victims) await remove(a, i.id);
    const w = await converge(a, b);
    expect(w.A).toBeLessThanOrEqual(4);
    expect(w.B).toBeLessThanOrEqual(4);
    expect(await urls(a)).toEqual(['https://keep.com/']); // A's tombstones block every re-add
    expect(await urls(b)).toContain('https://keep.com/');
    expect((await b.db.items.byState('stashed')).length).toBeLessThan(2001); // encoded deletes reached B
    const status = await on(b, () => b.sync.readSyncStatus());
    expect(status.ok).toBe(true);
  });

  it('clock skew (+3 days on B): edits from both sides propagate, re-stash beats a future tombstone', async () => {
    const [a, b] = await makeDevices(3 * DAY);
    const r = await put(a, 'https://r.com/');
    await converge(a, b);
    clock += 1000;
    await put(b, r.url, { title: 'B1', updatedAt: now(b) });
    await converge(a, b, b);
    clock += 1000;
    await put(b, r.url, { title: 'B2', updatedAt: now(b) });
    await put(a, 'https://a-new.com/');
    const w = await converge(a, b, b);
    expect(await titleOf(a, r.url)).toBe('B2'); // the second far-future edit still reaches A
    expect(await urls(b)).toEqual(['https://a-new.com/', 'https://r.com/']);
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
    // B deletes r (tombstone 3 days ahead of A), then A re-stashes it.
    await remove(b, r.id);
    await converge(a, b, b);
    expect(await urls(a)).toEqual(['https://a-new.com/']);
    clock += 1000;
    await a.db.tx(['items', 'tombstones'], async (s) => {
      const at = await restashTime(s, r.id, now(a));
      await s.items.put({ ...r, title: 'again', stashedAt: at, updatedAt: at });
    });
    const w2 = await converge(a, b);
    expect(await urls(a)).toEqual(['https://a-new.com/', 'https://r.com/']);
    expect(await urls(b)).toEqual(['https://a-new.com/', 'https://r.com/']);
    expect(Math.max(w2.A, w2.B)).toBeLessThanOrEqual(4);
  });

  it('a write delivered in batches (meta before a chunk) loses nothing and converges', async () => {
    const [a, b] = await makeDevices();
    for (let k = 0; k < 150; k++) await put(a, `https://a${k}.example.com/some/long/path/${k}`, { title: `A ${'x'.repeat(60)} ${k}` });
    await on(a, () => a.sync.pushSync(a.db));
    const store = await a.mock.chrome.storage.sync.get(null);
    expect(Object.keys(store).filter((k) => /^v1:\d+$/.test(k)).length).toBeGreaterThan(1);
    await on(a, () => a.mock.chrome.storage.sync.remove('v1:1')); // B has meta + chunk 0 only
    await put(b, 'https://b-only.com/');
    clock += PASS_GAP;
    await on(b, () => b.sync.pullSync(b.db));
    await on(a, () => a.mock.chrome.storage.sync.set({ 'v1:1': store['v1:1'] })); // the late batch lands
    const w = await converge(a, b, b);
    const all = [...(await urls(a))];
    expect(all).toHaveLength(151);
    expect(await urls(b)).toEqual(all);
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
  });

  it('device offline 40 days: the pruned delete may resurrect, nothing is lost, writes stay bounded', async () => {
    const [a, b] = await makeDevices();
    const r = await put(a, 'https://r.com/');
    await put(a, 'https://s.com/');
    await converge(a, b);
    await remove(a, r.id);
    await pass(a);
    clock += 40 * DAY;
    await pass(a); // A prunes the 40-day-old tombstone
    const w = await converge(a, b, b);
    expect(await urls(b)).toEqual(['https://r.com/', 'https://s.com/']);
    expect(await urls(a)).toEqual(['https://r.com/', 'https://s.com/']); // resurrected, allowed
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
  });

  it('a superseded tombstone of a local-only record stays: no write ping-pong', async () => {
    const [a, b] = await makeDevices();
    const x = await put(a, 'https://x.com/', { stashedAt: now(a) - 10 * DAY });
    await put(b, x.url, { ...x });
    for (let k = 0; k < 800; k++) {
      const url = `https://site${k}.example.com/page/${'p'.repeat(40)}`;
      const p = { stashedAt: now(a) - k * 1000, updatedAt: now(a) - k * 1000, title: `Title ${'t'.repeat(60)} ${k}` };
      await put(a, url, p);
      await put(b, url, p);
    }
    await converge(a, b);
    const remoteIds = async () => decodeChunks(await on(a, () => a.mock.chrome.storage.sync.get(null))).recs.map((r) => r[0]);
    expect(await remoteIds()).not.toContain(x.id); // X is local only (past the budget) on both
    expect((await remoteIds()).length).toBeGreaterThan(100);
    await remove(b, x.id); // B deletes X ...
    await pass(b);
    clock += 1000;
    await edit(a, x.url, { title: 'renamed group' }); // ... A edits it later (e.g. a rename); X stays local only
    const w = await converge(a, b);
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
    expect(await titleOf(a, x.url)).toBe('renamed group'); // the newer edit survives on A
    expect(await titleOf(b, x.url)).toBeUndefined();
    expect(await remoteIds()).not.toContain(x.id);
  });
  it('fast device (+3 days) edits X, normal device then deletes X: the delete wins on both', async () => {
    const [a, b] = await makeDevices(3 * DAY);
    const x = await put(a, 'https://x.com/');
    await converge(a, b);
    clock += 1000;
    await edit(b, x.url, { title: 'fast edit' });
    await converge(a, b, b);
    expect(await titleOf(a, x.url)).toBe('fast edit');
    clock += 1000;
    await remove(a, x.id);
    const w = await converge(a, b);
    expect(await urls(a)).toEqual([]);
    expect(await urls(b)).toEqual([]);
    expect(Math.max(w.A, w.B)).toBeLessThanOrEqual(4);
  });
  it('wired through storage.onChanged: echoes are skipped, the other device pulls (debounced) and both converge', async () => {
    const [a, b] = await makeDevices();
    const scheduled: string[] = [];
    a.mock.chrome.storage.onChanged.addListener((changes, area) => {
      for (const d of [a, b]) if (d.sync.handleSyncStorageChange(d.db, changes, area)) scheduled.push(d.name);
    });
    const statusAt = async (d: Device) =>
      ((await d.mock.chrome.storage.local.get('syncStatus')).syncStatus as { lastSyncAt?: number } | undefined)?.lastSyncAt;
    /** Lets the one device whose pull is scheduled run it (its chrome/clock active), until nothing is scheduled. */
    async function deliver(): Promise<number> {
      let hops = 0;
      while (scheduled.length) {
        expect(new Set(scheduled).size).toBe(1); // only the other device reacts; the writer skips its echo
        const d = scheduled[0] === 'A' ? a : b;
        scheduled.length = 0;
        clock += PASS_GAP;
        const before = await statusAt(d);
        current = d;
        (globalThis as { chrome?: unknown }).chrome = d.mock.chrome;
        await vi.waitFor(async () => expect(await statusAt(d)).not.toBe(before), { timeout: 3000 });
        await new Promise((r) => setTimeout(r, 20)); // let the pass finish its write
        current = undefined;
        if (++hops > 4) throw new Error('no convergence through onChanged');
      }
      return hops;
    }
    await put(a, 'https://r.com/');
    await on(a, () => a.sync.pushSync(a.db));
    expect(scheduled).toEqual(['B']);
    expect(await deliver()).toBe(1); // B pulls r; nothing new to write back
    await put(b, 'https://s.com/');
    await on(b, () => b.sync.pushSync(b.db));
    expect(scheduled).toEqual(['A']);
    expect(await deliver()).toBe(1);
    expect(await urls(a)).toEqual(['https://r.com/', 'https://s.com/']);
    expect(await urls(b)).toEqual(['https://r.com/', 'https://s.com/']);
  });
});

