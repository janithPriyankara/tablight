import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTabContext, forgetTab, keepTab, loadContexts, loadKept, pruneKept, recordCreated } from '../../src/background/tab-context';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
let mock: ChromeMockControl;
beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  mock.uninstall();
  vi.restoreAllMocks();
});
describe('tab context store', () => {
  it('records the opener domain and returns it from loadContexts', async () => {
    const opener = mock.addTab({ url: 'https://www.news.example/story' });
    const child = mock.addTab({ url: 'https://ads.example/x', openerTabId: opener.id });
    await recordCreated(child);
    const m = await loadContexts([{ tabId: child.id!, windowId: child.windowId }]);
    expect(m.get(child.id!)).toEqual({ openerDomain: 'news.example', popup: false });
  });
  it('does not throw and records nothing when the opener is gone', async () => {
    const child = mock.addTab({ url: 'https://ads.example/x', openerTabId: 9999 });
    await expect(recordCreated(child)).resolves.toBeUndefined();
    const m = await loadContexts([{ tabId: child.id!, windowId: child.windowId }]);
    expect(m.get(child.id!)?.openerDomain).toBeUndefined();
  });
  it('flags pop-up windows and looks each window up once', async () => {
    const w = mock.addWindow();
    mock.setWindowType(w, 'popup');
    const spy = vi.spyOn(mock.chrome.windows, 'get');
    const tabs = [{ tabId: 1, windowId: w }];
    expect((await loadContexts(tabs)).get(1)?.popup).toBe(true);
    expect((await loadContexts(tabs)).get(1)?.popup).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('treats a failed window lookup as not a pop-up and does not cache it', async () => {
    const spy = vi.spyOn(mock.chrome.windows, 'get');
    expect((await loadContexts([{ tabId: 1, windowId: 777 }])).get(1)?.popup).toBe(false);
    await loadContexts([{ tabId: 1, windowId: 777 }]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('clearTabContext forgets every opener, pop-up window and kept tab', async () => {
    const opener = mock.addTab({ url: 'https://www.news.example/story' });
    const child = mock.addTab({ url: 'https://ads.example/x', openerTabId: opener.id });
    await recordCreated(child);
    const w = mock.addWindow();
    mock.setWindowType(w, 'popup');
    await loadContexts([{ tabId: child.id!, windowId: w }]);
    await keepTab(child.id!, 'ads.example');
    await chrome.storage.session.set({ unrelated: 1 });
    await clearTabContext();
    expect(await chrome.storage.session.get(null)).toEqual({ unrelated: 1 });
    expect(await loadKept()).toEqual(new Map());
    expect((await loadContexts([{ tabId: child.id!, windowId: undefined }])).get(child.id!)?.openerDomain).toBeUndefined();
  });
  it('round-trips kept tabs', async () => {
    await keepTab(5, 'a.example');
    await keepTab(6, 'b.example');
    expect(await loadKept()).toEqual(new Map([[5, 'a.example'], [6, 'b.example']]));
  });
  it('pruneKept ends a keep once its tab is on another site, and leaves the others', async () => {
    await keepTab(5, 'a.example');
    await keepTab(6, 'b.example');
    await keepTab(7, 'c.example');
    // Tab 5 left its site, tab 6 is still there, tab 7 is not in the list (unknown: untouched).
    const kept = await pruneKept([{ tabId: 5, domain: 'elsewhere.example' }, { tabId: 6, domain: 'b.example' }]);
    expect(kept).toEqual(new Map([[6, 'b.example'], [7, 'c.example']]));
    expect(await loadKept()).toEqual(kept);
    // Coming back to the first site does not bring the keep back.
    expect((await pruneKept([{ tabId: 5, domain: 'a.example' }])).has(5)).toBe(false);
  });
  it('forgetTab drops the context and the kept entry', async () => {
    const opener = mock.addTab({ url: 'https://o.example/' });
    const child = mock.addTab({ url: 'https://c.example/', openerTabId: opener.id });
    await recordCreated(child);
    await keepTab(child.id!, 'c.example');
    await forgetTab(child.id!);
    expect((await loadContexts([{ tabId: child.id! }])).get(child.id!)?.openerDomain).toBeUndefined();
    expect((await loadKept()).has(child.id!)).toBe(false);
  });
  it('keeps every entry when many tabs are recorded concurrently', async () => {
    const opener = mock.addTab({ url: 'https://o.example/' });
    const kids = Array.from({ length: 10 }, (_, i) =>
      mock.addTab({ url: `https://c${i}.example/`, openerTabId: opener.id }));
    await Promise.all(kids.map((k) => recordCreated(k)));
    const m = await loadContexts(kids.map((k) => ({ tabId: k.id!, windowId: k.windowId })));
    for (const k of kids) expect(m.get(k.id!)?.openerDomain).toBe('o.example');
  });
});
