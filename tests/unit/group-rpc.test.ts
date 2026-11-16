import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../../src/ui/mock/chrome-mock';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
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
