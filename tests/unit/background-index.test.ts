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
    expect(mock.alarms()).toEqual([]);
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
});
