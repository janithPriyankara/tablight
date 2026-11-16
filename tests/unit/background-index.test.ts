import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../../src/ui/mock/chrome-mock';
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
    mock.uninstall();
  });
});
