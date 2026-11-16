import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../../src/ui/mock/chrome-mock';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
  isWarm: vi.fn(() => false),
  closeIfIdle: vi.fn(async () => undefined),
  OFFSCREEN_IDLE_ALARM: 'offscreen-idle',
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});
type S = import('../../src/shared/types').DashboardState;
type Settings = import('../../src/shared/types').Settings;

describe('settings rpc', () => {
  it('validates every field, rejects unknown keys and returns the new settings', async () => {
    const mock = installChromeMock();
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    const before = await db.settings.get();
    const bad: unknown[] = [
      { autoSleepMinutes: 4 }, { autoSleepMinutes: 1441 }, { autoSleepMinutes: 30.5 }, { autoSleepMinutes: '60' },
      { syncEnabled: 'yes' }, { mirrorTabGroups: 1 }, { removeOnOpen: null }, { theme: 'blue' }, { onboarded: 'true' }, { autoCreateGroups: 'on' },
      { evil: true }, { __proto__: { onboarded: true } }, JSON.parse('{"__proto__":{"onboarded":true}}'),
      null, [], 'theme', { theme: 'dark', extra: 1 },
    ];
    for (const patch of bad) {
      expect(await mock.sendMessage({ t: 'settings', patch }), JSON.stringify(patch)).toMatchObject({ ok: false });
    }
    expect(await db.settings.get()).toEqual(before);
    const ok = (await mock.sendMessage({
      t: 'settings', patch: { autoSleepMinutes: 60, removeOnOpen: false, theme: 'dark', onboarded: true, autoCreateGroups: true },
    })) as { ok: true; data: Settings };
    expect(ok.ok).toBe(true);
    expect(ok.data).toMatchObject({ autoSleepMinutes: 60, removeOnOpen: false, theme: 'dark', onboarded: true, autoCreateGroups: true });
    expect(await db.settings.get()).toEqual(ok.data);
    expect(((await mock.sendMessage({ t: 'settings', patch: { autoSleepMinutes: null } })) as { data: Settings }).data.autoSleepMinutes).toBeNull();
    for (const m of [5, 1440]) {
      expect(await mock.sendMessage({ t: 'settings', patch: { autoSleepMinutes: m } })).toMatchObject({ ok: true });
    }
    // The state RPC carries the settings for the UI.
    expect(((await bg.handleRequest({ t: 'state' })) as S).settings).toEqual(await db.settings.get());
    mock.uninstall();
  });

  it('turns sync off and on through setSyncEnabled; mirroring needs the tabGroups permission', async () => {
    const mock = installChromeMock();
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    const off = (await mock.sendMessage({ t: 'settings', patch: { syncEnabled: false } })) as { data: Settings };
    expect(off.data.syncEnabled).toBe(false);
    const { readSyncStatus } = await import('../../src/background/sync');
    expect(await readSyncStatus()).toMatchObject({ ok: false, reason: 'disabled' });
    await mock.sendMessage({ t: 'settings', patch: { syncEnabled: true } });
    expect((await readSyncStatus()).ok).toBe(true);
    // Not granted: refused, the setting stays off.
    expect(await mock.sendMessage({ t: 'settings', patch: { mirrorTabGroups: true } })).toMatchObject({ ok: false });
    expect((await db.settings.get()).mirrorTabGroups).toBe(false);
    mock.setPermission('tabGroups', true);
    expect(await mock.sendMessage({ t: 'settings', patch: { mirrorTabGroups: true } })).toMatchObject({ ok: true });
    expect((await db.settings.get()).mirrorTabGroups).toBe(true);
    mock.uninstall();
  });

  it('turning auto-create on also turns waiting suggestions into groups', async () => {
    const mock = installChromeMock();
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    await db.groups.put({
      id: 'suggested-1', name: 'Rust · async', color: '#0090ff', icon: '✨', builtIn: false, exemplars: [],
      centroid: null, createdAt: 1, suggested: true,
    });
    expect(await mock.sendMessage({ t: 'settings', patch: { autoCreateGroups: true } })).toMatchObject({ ok: true });
    expect((await db.groups.get('suggested-1'))!.suggested).toBeUndefined();
    mock.uninstall();
  });
  it('broadcasts a debounced "changed" message to the UI after a mutation, not after reads', async () => {
    const mock = installChromeMock();
    const bg = await import('../../src/background/index');
    await bg.getDb();
    await new Promise((r) => setTimeout(r, 400)); // let start-up work settle
    const base = mock.broadcasts().length;
    const fresh = () => mock.broadcasts().slice(base);
    await bg.handleRequest({ t: 'state' });
    await bg.handleRequest({ t: 'sessions' });
    await new Promise((r) => setTimeout(r, 400));
    expect(fresh()).toEqual([]);
    await bg.handleRequest({ t: 'settings', patch: { theme: 'light' } });
    await bg.handleRequest({ t: 'settings', patch: { theme: 'dark' } });
    expect(fresh()).toEqual([]); // not yet: debounced
    await vi.waitFor(() => expect(fresh()).toEqual([{ target: 'ui', t: 'changed' }]), { timeout: 1000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(fresh()).toHaveLength(1); // the two writes were coalesced
    mock.uninstall();
  });

  it('modelReady is true once the queue is empty, even with no groups at all', async () => {
    const mock = installChromeMock();
    const bg = await import('../../src/background/index');
    const db = await bg.getDb();
    for (const g of await db.groups.all()) await db.groups.delete(g.id);
    expect(((await bg.handleRequest({ t: 'state' })) as S).modelReady).toBe(true);
    mock.uninstall();
  });
});
