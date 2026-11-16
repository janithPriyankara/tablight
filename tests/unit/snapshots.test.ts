import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import {
  LAST_SESSION_KEY, STARTUP_PENDING_KEY, MAX_SNAPSHOTS, lastSessionMissing, listSessions,
  runStartupCheck, sessionAction, takeSnapshot,
} from '../../src/background/snapshots';
import { sha1hex } from '../../src/shared/hash';
import { normalizeUrl } from '../../src/shared/url';
import type { Snapshot } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
let n = 0;
let db: Db;
let mock: ChromeMockControl | undefined;
beforeEach(async () => {
  db = await openDb(`snapshots-${n++}`);
});
afterEach(() => {
  mock?.uninstall();
  mock = undefined;
  vi.restoreAllMocks();
});
const urls = (k: number, tag = 'a') => Array.from({ length: k }, (_, i) => `https://${tag}${i}.example.com/`);
const snap = (id: string, takenAt: number, list: string[]): Snapshot => ({
  id, takenAt, windows: [{ tabs: list.map((url) => ({ url, title: url })) }],
});
describe('takeSnapshot', () => {
  it('keeps only web tabs, grouped by window in order', async () => {
    mock = installChromeMock({ windows: [
      { tabs: [{ url: 'https://a.com/', title: 'A' }, { url: 'chrome://settings/' }, { url: 'about:blank' }] },
      { tabs: [{ url: 'chrome://newtab/' }] },
      { tabs: [{ url: 'http://b.com/', title: 'B' }, { url: 'https://c.com/', title: 'C' }] },
    ] });
    const s = await takeSnapshot(db, 1000);
    expect(s.windows).toEqual([
      { tabs: [{ url: 'https://a.com/', title: 'A' }] },
      { tabs: [{ url: 'http://b.com/', title: 'B' }, { url: 'https://c.com/', title: 'C' }] },
    ]);
    expect(await db.snapshots.all()).toEqual([s]);
  });
  it('keeps the newest 14 of 16 snapshots', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/' }] }] });
    for (let k = 0; k < 16; k++) {
      mock.addTab({ url: `https://n${k}.com/` }); // each snapshot differs from the previous one
      await takeSnapshot(db, 1000 + k);
    }
    const all = (await db.snapshots.all()).sort((a, b) => a.takenAt - b.takenAt);
    expect(all).toHaveLength(MAX_SNAPSHOTS);
    expect(all.map((s) => s.takenAt)).toEqual(Array.from({ length: 14 }, (_, k) => 1002 + k));
  });
  it('skips a snapshot identical to the latest one, and an empty one', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/?utm_source=x' }] }] });
    const first = await takeSnapshot(db, 1);
    const again = await takeSnapshot(db, 2);
    expect(again.id).toBe(first.id);
    expect(await db.snapshots.all()).toHaveLength(1);
    mock.addTab({ url: 'https://b.com/' });
    await takeSnapshot(db, 3);
    expect(await db.snapshots.all()).toHaveLength(2);
    mock.uninstall();
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'chrome://newtab/' }] }] });
    await takeSnapshot(db, 4);
    expect(await db.snapshots.all()).toHaveLength(2);
  });
});
describe('lastSessionMissing', () => {
  const list = urls(10);
  it('returns the snapshot when fewer than 30% of its tabs are open', async () => {
    const s = snap('s1', 1, list);
    await db.snapshots.put(s);
    await db.snapshots.put(snap('old', 0, urls(10, 'z')));
    expect(await lastSessionMissing(db, new Set(list.slice(0, 2).map(normalizeUrl)))).toEqual(s);
  });
  it('returns null with 30% or more present, with no snapshot, and for an empty snapshot', async () => {
    expect(await lastSessionMissing(db, new Set())).toBeNull();
    await db.snapshots.put(snap('s1', 1, list));
    expect(await lastSessionMissing(db, new Set(list.slice(0, 5).map(normalizeUrl)))).toBeNull();
    expect(await lastSessionMissing(db, new Set(list.slice(0, 3).map(normalizeUrl)))).toBeNull();
    await db.snapshots.put({ id: 'e', takenAt: 2, windows: [] });
    expect(await lastSessionMissing(db, new Set())).toBeNull();
  });
});
describe('listSessions', () => {
  it('lists newest first with window and tab counts', async () => {
    await db.snapshots.put(snap('a', 1, urls(2)));
    await db.snapshots.put({ id: 'b', takenAt: 2, windows: [{ tabs: [{ url: 'https://x.com/', title: '' }] }, { tabs: [] }] });
    expect(await listSessions(db)).toEqual([
      { id: 'b', takenAt: 2, windows: 2, tabs: 1 }, { id: 'a', takenAt: 1, windows: 1, tabs: 2 },
    ]);
  });
});
describe('sessionAction', () => {
  it('stashAll twice does not duplicate items; records use the stash id and are queued', async () => {
    mock = installChromeMock({ windows: [{ tabs: [] }] });
    await db.snapshots.put({ id: 's', takenAt: 5, windows: [
      { tabs: [{ url: 'https://a.com/x?utm_source=1', title: 'A' }, { url: 'https://www.a.com/x', title: 'A2' }] },
      { tabs: [{ url: 'https://b.com/', title: 'B' }, { url: 'chrome://settings/', title: 'S' }] },
    ] });
    await sessionAction(db, 's', 'stashAll');
    await sessionAction(db, 's', 'stashAll');
    const items = await db.items.all();
    expect(items).toHaveLength(2);
    const a = items.find((i) => i.normUrl === 'https://a.com/x')!;
    expect(a.id).toBe(await sha1hex('https://a.com/x'));
    expect(a).toMatchObject({ state: 'stashed', groupId: null, groupSource: 'auto', domain: 'a.com' });
    expect(await db.queue.size()).toBe(2);
  });
  it('stashAll keeps an existing record, its user group and its classification', async () => {
    mock = installChromeMock({ windows: [{ tabs: [] }] });
    const id = await sha1hex('https://a.com/');
    await db.items.put({
      id, url: 'https://a.com/', normUrl: 'https://a.com/', title: 'Mine', domain: 'a.com', state: 'stashed',
      groupId: 'g1', groupSource: 'user', kind: 'read', createdAt: 1, lastActiveAt: 1, stashedAt: 1, updatedAt: 1,
      classifiable: true,
    });
    await db.snapshots.put(snap('s', 5, ['https://a.com/']));
    await sessionAction(db, 's', 'stashAll');
    expect(await db.items.get(id)).toMatchObject({ groupId: 'g1', groupSource: 'user', createdAt: 1, stashedAt: 1 });
    expect(await db.queue.size()).toBe(0);
  });
  it('openAll with 25 tabs asks for confirmation and opens nothing', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://here.com/' }] }] });
    await db.snapshots.put(snap('s', 1, urls(25)));
    expect(await sessionAction(db, 's', 'openAll')).toEqual({ needsConfirm: 25 });
    expect(mock.tabs()).toHaveLength(1);
    expect(mock.windowIds()).toHaveLength(1);
  });
  it('openAll with confirm opens one window, first tab active, only safe urls', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://here.com/' }] }] });
    await db.snapshots.put(snap('s', 1, [...urls(24), 'https://u:p@evil.com/', 'javascript:alert(1)']));
    expect(await sessionAction(db, 's', 'openAll', true)).toEqual({});
    expect(mock.windowIds()).toHaveLength(2);
    const created = mock.tabs().filter((t) => t.windowId === 2);
    expect(created).toHaveLength(24);
    expect(created.map((t) => t.active)).toEqual(created.map((_, k) => k === 0));
  });
  it('openAll up to 20 tabs needs no confirmation', async () => {
    mock = installChromeMock({ windows: [{ tabs: [] }] });
    await db.snapshots.put(snap('s', 1, urls(20)));
    expect(await sessionAction(db, 's', 'openAll')).toEqual({});
    expect(mock.tabs()).toHaveLength(20);
  });
  it('delete removes the snapshot; unknown ids throw', async () => {
    await db.snapshots.put(snap('s', 1, urls(1)));
    await sessionAction(db, 's', 'delete');
    expect(await db.snapshots.all()).toEqual([]);
    await expect(sessionAction(db, 's', 'delete')).rejects.toThrow('session not found');
  });
});
describe('runStartupCheck', () => {
  const fast = { intervalMs: 1, maxMs: 200 };
  it('waits for restored tabs to settle, compares against the old snapshot, then snapshots', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'chrome://newtab/' }] }] });
    const old = snap('old', 1, urls(10));
    await db.snapshots.put(old);
    await chrome.storage.session.set({ [STARTUP_PENDING_KEY]: true });
    // The browser restores the previous session's tabs a little after the check starts.
    setTimeout(() => urls(10).forEach((url) => mock!.addTab({ url })), 20);
    await runStartupCheck(db, { intervalMs: 5, maxMs: 2000, stableRuns: 3 });
    expect((await chrome.storage.session.get(LAST_SESSION_KEY))[LAST_SESSION_KEY]).toEqual({ snapshotId: null });
    expect(await db.snapshots.all()).toHaveLength(1); // identical to the old one: not duplicated
    expect((await chrome.storage.session.get(STARTUP_PENDING_KEY))[STARTUP_PENDING_KEY]).toBeUndefined();
  });
  it('records the snapshot id when the windows were not restored, then takes the startup snapshot', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://fresh.com/' }] }] });
    await db.snapshots.put(snap('old', 1, urls(10)));
    await runStartupCheck(db, fast);
    expect((await chrome.storage.session.get(LAST_SESSION_KEY))[LAST_SESSION_KEY]).toEqual({ snapshotId: 'old' });
    expect(await db.snapshots.all()).toHaveLength(2);
  });
});
