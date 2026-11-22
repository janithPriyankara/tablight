import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentNameIndex } from '../../src/classify/names';
import { loadNameIndex, resetNameIndexForTests } from '../../src/background/names-load';

describe('loadNameIndex', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetNameIndexForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://me/${p}` } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    resetNameIndexForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('reads the bundled file once and installs it', async () => {
    fetchMock.mockResolvedValue(new Response('#tv\nbreaking bad\n'));
    const [a, b] = await Promise.all([loadNameIndex(), loadNameIndex()]);
    expect(await loadNameIndex()).toBe(a);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('chrome-extension://me/names/names.txt');
    expect(currentNameIndex()?.get('breaking bad')).toBe('tv');
  });
  it('resolves null on a failed read and tries again next time', async () => {
    fetchMock.mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await loadNameIndex()).toBeNull();
    expect(await loadNameIndex()).toBeNull();
    expect(currentNameIndex()).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('#games\nelden ring\n'));
    expect((await loadNameIndex())?.get('elden ring')).toBe('games');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('resolves null without throwing when the runtime is missing', async () => {
    vi.stubGlobal('chrome', undefined);
    await expect(loadNameIndex()).resolves.toBeNull();
  });
});
