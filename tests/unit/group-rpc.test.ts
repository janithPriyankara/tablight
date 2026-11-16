import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../../src/ui/mock/chrome-mock';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
  isWarm: vi.fn(() => false),
  closeIfIdle: vi.fn(async () => undefined),
  OFFSCREEN_IDLE_ALARM: 'offscreen-idle',
}));
afterEach(() => vi.resetModules());
describe('group rpc handlers', () => {
  it('are wired through runtime messages with payload validation', async () => {
    const mock = installChromeMock();
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    await db.groups.put({ id: 'g1', name: 'one', color: '#000', icon: 'x', builtIn: false, exemplars: [], centroid: null, createdAt: 1 });
    const ok = await mock.sendMessage({ t: 'groupRename', id: 'g1', name: '  Renamed ' });
    expect(ok).toEqual({ ok: true, data: undefined });
    expect((await db.groups.get('g1'))!.name).toBe('Renamed');
    const bad = [
      { t: 'groupRename', id: 'g1', name: '   ' },
      { t: 'groupRename', id: 'g1', name: 'x'.repeat(61) },
      { t: 'groupCreate', name: 'ok', ids: 'nope' },
      { t: 'moveItems', ids: new Array<string>(5001).fill('a'), groupId: 'g1' },
      { t: 'moveItems', ids: [1], groupId: 'g1' },
      { t: 'groupDelete', id: 'other' },
      { t: 'dismissSuggestion', id: 'g1' },
    ];
    for (const m of bad) expect(await mock.sendMessage(m)).toMatchObject({ ok: false });
    expect((await db.groups.get('g1'))!.name).toBe('Renamed');
    const created = (await mock.sendMessage({ t: 'groupCreate', name: 'Fresh', ids: [] })) as { ok: true; data: { name: string } };
    expect(created.data.name).toBe('Fresh');
    expect(await mock.sendMessage({ t: 'regroupApply' })).toEqual({ ok: true, data: 0 });
    expect(await mock.sendMessage({ t: 'regroupPreview' })).toEqual({ ok: true, data: [] });
    // Foreign senders are refused (no reply at all).
    expect(await mock.sendMessage({ t: 'groupDelete', id: 'g1' }, { id: 'someone-else' })).toBeUndefined();
    expect(await db.groups.get('g1')).toBeDefined();
    mock.uninstall();
  });
});
describe('memory rpc handlers', () => {
  it('validate payloads and register the auto-sleep alarm', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/' }] }] });
    await import('../../src/background/index');
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.alarms().find((a) => a.name === 'auto-sleep')?.periodInMinutes).toBe(5);
    for (const m of [{ t: 'sleep', ids: 'x' }, { t: 'stash', ids: [1] }, { t: 'open', id: '' }, { t: 'close', ids: null }, { t: 'undo', token: 5 }]) {
      expect(await mock.sendMessage(m)).toMatchObject({ ok: false });
    }
    expect(await mock.sendMessage({ t: 'undo', token: 'zzz' })).toEqual({ ok: true, data: false });
    expect(await mock.sendMessage({ t: 'closeExtras' })).toMatchObject({ ok: true, data: { closed: 0 } });
    mock.uninstall();
  });
});
describe('session rpc handlers', () => {
  it('snapshot, list, validate and act; the snapshot alarm runs hourly and snapshots', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/', title: 'A' }] }] });
    const bg = await import('../../src/background/index');
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.alarms().find((a) => a.name === 'snapshot')?.periodInMinutes).toBe(60);
    const snap = (await mock.sendMessage({ t: 'snapshotNow' })) as { ok: true; data: { id: string } };
    const list = (await mock.sendMessage({ t: 'sessions' })) as { ok: true; data: unknown[] };
    expect(list.data).toEqual([expect.objectContaining({ id: snap.data.id, windows: 1, tabs: 1 })]);
    for (const m of [
      { t: 'sessionAction', id: '', action: 'delete' },
      { t: 'sessionAction', id: snap.data.id, action: 'burn' },
      { t: 'sessionAction', id: snap.data.id, action: 'openAll', confirm: 'yes' },
      { t: 'sessionAction', id: 'missing', action: 'delete' },
    ]) expect(await mock.sendMessage(m)).toMatchObject({ ok: false });
    await chrome.storage.session.set({ startupCheckDone: true });
    mock.addTab({ url: 'https://b.com/' });
    mock.fireAlarm('snapshot');
    const db = await bg.getDb();
    await vi.waitFor(async () => expect(await db.snapshots.all()).toHaveLength(2));
    expect(await mock.sendMessage({ t: 'sessionAction', id: snap.data.id, action: 'delete' })).toEqual({ ok: true, data: {} });
    expect(await db.snapshots.all()).toHaveLength(1);
    mock.uninstall();
  });
  it('snapshotNow with no web tab returns null and stores nothing', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'chrome://newtab/' }] }] });
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    for (const s of await db.snapshots.all()) await db.snapshots.delete(s.id);
    expect(await mock.sendMessage({ t: 'snapshotNow' })).toEqual({ ok: true, data: null });
    expect(await db.snapshots.all()).toEqual([]);
    mock.uninstall();
  });
  it('an alarm before onStartup does not overwrite the previous session; the startup check runs first', async () => {
    const mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://fresh.com/' }] }] });
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    for (const s of await db.snapshots.all()) await db.snapshots.delete(s.id); // the db outlives each test
    const tabs = Array.from({ length: 10 }, (_, i) => ({ url: `https://old${i}.com/`, title: 'o' }));
    await db.snapshots.put({ id: 'old', takenAt: 1, windows: [{ tabs }] });
    await new Promise((r) => setTimeout(r, 0));
    mock.fireAlarm('snapshot'); // e.g. a missed alarm firing as the worker starts
    await new Promise((r) => setTimeout(r, 100));
    expect((await db.snapshots.all()).map((s) => s.id)).toEqual(['old']);
    expect((await chrome.storage.session.get('startupCheckDone')).startupCheckDone).toBeUndefined();
    mock.fireStartup(); // joins the check already running
    await vi.waitFor(async () => {
      expect((await chrome.storage.session.get('lastSession')).lastSession).toEqual({ snapshotId: 'old' });
      expect(await db.snapshots.all()).toHaveLength(2);
    }, { timeout: 10_000 });
    expect((await chrome.storage.session.get('startupCheckDone')).startupCheckDone).toBe(true);
    // With the marker set the alarm snapshots as usual.
    mock.addTab({ url: 'https://later.com/' });
    mock.fireAlarm('snapshot');
    await vi.waitFor(async () => expect(await db.snapshots.all()).toHaveLength(3));
    mock.uninstall();
  }, 15_000);
});
