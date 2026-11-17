// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type DashboardState, type GroupSummary, type Item, type SyncStatus } from '../../src/shared/types';

vi.mock('../../src/shared/rpc', () => ({ send: vi.fn() }));
const { send } = await import('../../src/shared/rpc');
const { Popup } = await import('../../src/ui/popup/Popup');
const { Favicon } = await import('../../src/ui/common/Favicon');
const { readableTextOn } = await import('../../src/ui/common/color');
const { GroupChip, GroupDot } = await import('../../src/ui/common/GroupChip');
const sendMock = vi.mocked(send);

const XSS = '<img src=x onerror=alert(1)>';
function item(id: string, p: Partial<Item> = {}): Item {
  const url = p.url ?? `https://example.com/${id}`;
  return {
    id, url, normUrl: url, title: `Title ${id}`, domain: 'example.com', state: 'open', tabId: Number(id.replace(/\D/g, '')) || 1,
    windowId: 1, groupId: 'programming', groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1,
    classifiable: true, ...p,
  };
}
function group(id: string, name: string, count: number, watchCount = 0): GroupSummary {
  return { id, name, color: '#0090ff', icon: '', builtIn: true, exemplars: [], centroid: null, createdAt: 1, count, watchCount };
}
function state(p: Partial<DashboardState> = {}): DashboardState {
  return {
    items: [
      item('i1'), item('i2'), item('i3', { windowId: 2 }), item('i4', { state: 'sleeping' }),
      item('i5', { url: 'chrome://settings', classifiable: false, title: 'Settings' }),
      item('i6', { state: 'stashed', tabId: undefined, windowId: undefined }),
    ],
    groups: [
      group('programming', 'Programming', 9), group('videos', 'YouTube / Videos', 7, 3), group('a', 'A', 6),
      group('b', 'B', 5), group('c', 'C', 4), group('d', 'D', 3), group('e', 'Seventh', 2), group('z', 'Empty', 0),
    ],
    dupCount: 1, windows: 2, sleeping: 1, suspicious: [],
    syncStatus: { ok: true, synced: 1, localOnly: 0, lastSyncAt: null },
    modelReady: true, queued: 0,
    settings: DEFAULT_SETTINGS,
    ...p,
  };
}
type Handler = (req: { t: string; [k: string]: unknown }) => unknown;
function serve(s: DashboardState, extra: Handler = () => undefined): void {
  sendMock.mockImplementation(async (req) => (req.t === 'state' ? s : extra(req as never)) as never);
}
const tabsQuery = vi.fn(async () => [] as chrome.tabs.Tab[]);
const tabsCreate = vi.fn(async () => ({}) as chrome.tabs.Tab);
beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => `chrome-extension://ext/${p.replace(/^\//, '')}` },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })), update: vi.fn(async () => ({})) },
    tabs: { query: tabsQuery, create: tabsCreate, update: vi.fn(async () => ({})) },
  });
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sendMock.mockReset();
  tabsQuery.mockClear();
  tabsCreate.mockClear();
});

describe('popup', () => {
  it('renders totals from the state RPC and the top 6 non-empty groups', async () => {
    serve(state());
    render(<Popup />);
    await screen.findByText('5 tabs · 2 windows · 1 paused · 1 duplicate');
    expect(sendMock).toHaveBeenCalledWith({ t: 'state' });
    const groups = screen.getAllByRole('listitem').filter((li) => li.closest('[aria-label="Top groups"]'));
    expect(groups).toHaveLength(6);
    expect(screen.queryByText('Seventh')).toBeNull();
    expect(screen.getByText('3 to watch')).toBeTruthy();
  });

  it('renders attacker-controlled titles and group names as literal text', async () => {
    const evil = item('i1', { title: XSS });
    serve(state({
      activeDup: { item: evil, others: [item('i2', { title: XSS })] },
      groups: [{ ...group('g', XSS, 3) }],
    }));
    const { container } = render(<Popup />);
    await screen.findByText('5 tabs · 2 windows · 1 paused · 1 duplicate');
    expect(screen.getAllByText(XSS).length).toBeGreaterThan(0);
    expect(container.querySelector('img[src=x]')).toBeNull();
  });

  it('shows the duplicate alert only when activeDup is set; Switch opens the copy, Close closes this one', async () => {
    serve(state());
    const first = render(<Popup />);
    await screen.findByText(/5 tabs/);
    expect(screen.queryByRole('region', { name: 'Duplicate tab' })).toBeNull();
    first.unmount();

    const dup = { item: item('i1'), others: [item('i2'), item('i3')] };
    serve(state({ activeDup: dup }), () => ({ token: 'tok' }));
    render(<Popup />);
    const alert = await screen.findByRole('region', { name: 'Duplicate tab' });
    expect(alert.textContent).toContain('open 3 times');
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'open', id: 'i2' }));
    vi.mocked(window.close).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Close this one' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'close', ids: ['i1'] }));
    // Closing the active tab closes the popup too: no Undo that could never be clicked.
    await waitFor(() => expect(window.close).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('search is debounced 150 ms, shows words then meaning, and ignores superseded and stale replies', async () => {
    serve(state(), (req) => {
      if (req.t !== 'search') return undefined;
      if (req.q === 'old') return { words: [item('i9', { title: 'Stale' })], meaning: [] };
      if (req.q === 'sup') return { words: [item('i8', { title: 'Sup word' })], meaning: [], superseded: true };
      return { words: [item('i1', { title: 'Word hit' })], meaning: [item('i2', { title: 'Meaning hit' })] };
    });
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    vi.useFakeTimers();
    const box = screen.getByRole('searchbox', { name: 'Search tabs' });
    fireEvent.input(box, { target: { value: 'ag' } });
    fireEvent.input(box, { target: { value: 'agent' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(149); });
    expect(sendMock.mock.calls.filter(([r]) => r.t === 'search')).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const searches = sendMock.mock.calls.filter(([r]) => r.t === 'search');
    expect(searches).toEqual([[{ t: 'search', q: 'agent', semantic: true }]]);
    vi.useRealTimers();
    const word = await screen.findByText('Word hit');
    const meaningHead = screen.getByText('Similar by meaning');
    const meaning = screen.getByText('Meaning hit');
    expect(word.compareDocumentPosition(meaningHead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meaningHead.compareDocumentPosition(meaning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A superseded reply (another page searched meanwhile) shows its own word matches, without meaning.
    fireEvent.input(box, { target: { value: 'sup' } });
    await screen.findByText('Sup word');
    expect(screen.queryByText('Word hit')).toBeNull();
    expect(screen.queryByText('Similar by meaning')).toBeNull();
    // Latest wins: a slow older reply that lands after a newer one is dropped.
    let releaseOld!: () => void;
    sendMock.mockImplementation(async (req) => {
      if (req.t === 'search' && req.q === 'old') {
        await new Promise<void>((r) => (releaseOld = r));
        return { words: [item('i9', { title: 'Stale' })], meaning: [] } as never;
      }
      if (req.t === 'search') return { words: [item('i7', { title: 'Fresh' })], meaning: [] } as never;
      return state() as never;
    });
    fireEvent.input(box, { target: { value: 'old' } });
    await waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    fireEvent.input(box, { target: { value: 'new' } });
    await screen.findByText('Fresh');
    releaseOld();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Stale')).toBeNull();
    // Clicking a result opens it.
    fireEvent.click(screen.getByText('Fresh'));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'open', id: 'i7' }));
  });

  it('stash this window hands the window to the background (which leaves the dashboard with Undo) and closes', async () => {
    const close = vi.mocked(window.close);
    close.mockClear();
    serve(state(), (req) => (req.t === 'stashWindow' ? { token: 'tok1', stashed: 2 } : undefined));
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    fireEvent.click(screen.getByRole('button', { name: 'Save window for later' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'stashWindow', windowId: 1 }));
    expect(sendMock.mock.calls.some(([r]) => (r as { t: string }).t === 'stash')).toBe(false);
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull(); // no dead Undo in a closing popup
  });
  it('stash this window with nothing to stash says so and stays open', async () => {
    const close = vi.mocked(window.close);
    close.mockClear();
    serve(state(), (req) => (req.t === 'stashWindow' ? { token: null, stashed: 0 } : undefined));
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    fireEvent.click(screen.getByRole('button', { name: 'Save window for later' }));
    await screen.findByText('No web tabs to save in this window');
    expect(close).not.toHaveBeenCalled();
  });
  it('a notice disappears after 10 s', async () => {
    serve(state(), (req) => (req.t === 'sleep' ? { slept: 2, skipped: 1 } : undefined));
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Pause other tabs' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText('Paused 2 tabs')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByText('Paused 2 tabs')).toBeNull();
  });
  it('sleep inactive sends every open web item (the background skips active/pinned/audible)', async () => {
    serve(state(), (req) => (req.t === 'sleep' ? { slept: 2, skipped: 1 } : undefined));
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    fireEvent.click(screen.getByRole('button', { name: 'Pause other tabs' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'sleep', ids: ['i1', 'i2', 'i3'] }));
    await screen.findByText('Paused 2 tabs');
  });

  it('open dashboard focuses an existing dashboard tab, else creates one', async () => {
    serve(state());
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await waitFor(() => expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://ext/dashboard.html' }));
    tabsQuery.mockResolvedValueOnce([{ id: 42, windowId: 3, url: 'chrome-extension://ext/dashboard.html' } as chrome.tabs.Tab]);
    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await waitFor(() => expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true }));
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('"Side panel" opens the panel in this window (before awaiting anything) and closes the popup', async () => {
    const open = vi.fn(() => Promise.resolve());
    (chrome as unknown as { sidePanel: unknown }).sidePanel = { open };
    serve(state());
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    fireEvent.click(await screen.findByRole('button', { name: 'Side panel' }));
    expect(open).toHaveBeenCalledWith({ windowId: 1 }); // synchronously, inside the click
    expect(window.close).toHaveBeenCalled();
  });
  it('has no "Side panel" button where the browser lacks the side panel API', async () => {
    serve(state());
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    expect(screen.queryByRole('button', { name: 'Side panel' })).toBeNull();
  });
  it('Enter opens the first result only once the latest query answered', async () => {
    let release!: () => void;
    serve(state(), async (req) => {
      if (req.t !== 'search') return undefined;
      if (req.q === 'slow') await new Promise<void>((r) => (release = r));
      return { words: [item('i1', { title: `Hit ${String(req.q)}` })], meaning: [] };
    });
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    const box = screen.getByRole('searchbox', { name: 'Search tabs' });
    fireEvent.input(box, { target: { value: 'fast' } });
    await screen.findByText('Hit fast');
    fireEvent.input(box, { target: { value: 'slow' } });
    fireEvent.keyDown(box, { key: 'Enter' }); // "Hit fast" is stale now
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(sendMock.mock.calls.some(([r]) => r.t === 'open')).toBe(false);
    release();
    await screen.findByText('Hit slow');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'open', id: 'i1' }));
  });
  it('a superseded reply ends the pending state; a failed search says so instead of "No matches"', async () => {
    serve(state(), (req) => {
      if (req.t !== 'search') return undefined;
      if (req.q === 'sup') return { words: [], meaning: [], superseded: true };
      if (req.q === 'good') return { words: [item('i1', { title: 'Good hit' })], meaning: [] };
      throw new Error('worker restarted');
    });
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    const box = screen.getByRole('searchbox', { name: 'Search tabs' });
    fireEvent.input(box, { target: { value: 'sup' } });
    await waitFor(() => expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('false'));
    expect(screen.queryByText('Searching…')).toBeNull();
    fireEvent.input(box, { target: { value: 'good' } });
    await screen.findByText('Good hit');
    fireEvent.input(box, { target: { value: 'boom' } });
    await screen.findByText('Search failed: worker restarted');
    expect(screen.queryByText('No matches')).toBeNull();
    expect(screen.queryByText('Good hit')).toBeNull(); // results of an older query are never left behind
    fireEvent.keyDown(box, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMock.mock.calls.some(([r]) => r.t === 'open')).toBe(false);
  });
  it('refreshes are coalesced: one in flight plus exactly one more', async () => {
    const releases: (() => void)[] = [];
    sendMock.mockImplementation(async (req) => {
      if (req.t !== 'state') return undefined as never;
      await new Promise<void>((r) => releases.push(r));
      return state() as never;
    });
    const listeners: ((m: unknown, s: { id: string }) => unknown)[] = [];
    (chrome.runtime as unknown as { id: string }).id = 'ext';
    (chrome.runtime as unknown as { onMessage: unknown }).onMessage = {
      addListener: (l: (typeof listeners)[number]) => listeners.push(l), removeListener: () => undefined,
    };
    render(<Popup />);
    await waitFor(() => expect(releases).toHaveLength(1));
    for (let k = 0; k < 5; k++) for (const l of listeners) l({ target: 'ui', t: 'changed' }, { id: 'ext' });
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(1); // still the first one in flight
    releases[0]!();
    await waitFor(() => expect(releases).toHaveLength(2)); // exactly one more for the five broadcasts
    releases[1]!();
    await screen.findByText(/5 tabs/);
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(2);
  });
  it('a fast double click runs an action once', async () => {
    serve(state(), (req) => (req.t === 'sleep' ? { slept: 1, skipped: 0 } : undefined));
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    const btn = screen.getByRole('button', { name: 'Pause other tabs' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByText('Paused 1 tab');
    expect(sendMock.mock.calls.filter(([r]) => r.t === 'sleep')).toHaveLength(1);
  });
  it('applies the theme setting and surfaces a failed refresh while showing stale state', async () => {
    serve(state({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } }));
    render(<Popup />);
    await screen.findByText(/5 tabs/);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    sendMock.mockRejectedValue(new Error('gone'));
    document.dispatchEvent(new Event('visibilitychange'));
    await screen.findByRole('alert');
    expect(screen.getByText(/5 tabs/)).toBeTruthy();
    delete document.documentElement.dataset.theme;
  });
  it('shows an error with a retry when the state RPC fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('worker asleep'));
    render(<Popup />);
    await screen.findByRole('alert');
    serve(state());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/5 tabs/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Organizing')).toBeNull();
  });
  it('shows the “Organizing” pill while the model is not ready (UI test P-14)', async () => {
    serve(state({ modelReady: false }));
    render(<Popup />);
    expect((await screen.findByText('Organizing')).closest('.status-pill')).toBeTruthy();
  });
  it('the sync line names every sync status in a few words (UI test S-11)', async () => {
    const now = Date.now();
    const cases: [SyncStatus, string][] = [
      [{ ok: true, synced: 0, localOnly: 0, lastSyncAt: null }, 'Saved tabs not synced yet'],
      [{ ok: true, synced: 412, localOnly: 37, lastSyncAt: now - 5 * 60_000 }, 'Saved tabs synced 5 min ago'],
      [{ ok: false, reason: 'quota', message: 'x', lastSyncAt: null }, 'Sync full · saved tabs kept on this device'],
      [{ ok: false, reason: 'rate', message: 'x', lastSyncAt: now - 3_600_000 }, 'Sync paused for a moment'],
      [{ ok: false, reason: 'error', message: 'x', lastSyncAt: null }, 'Sync failed · will retry'],
      [{ ok: false, reason: 'disabled', message: 'x', lastSyncAt: null }, 'Sync is off'],
    ];
    for (const [syncStatus, text] of cases) {
      serve(state({ syncStatus }));
      const { container, unmount } = render(<Popup />);
      await screen.findByText(/5 tabs/);
      expect(container.querySelector('.sync-line')!.textContent).toBe(text);
      unmount();
    }
  });
  it('with nothing grouped yet says so (UI test P-03)', async () => {
    serve(state({ items: [], groups: [], windows: 0, sleeping: 0, dupCount: 0 }));
    render(<Popup />);
    await screen.findByText('0 tabs · 0 windows · 0 paused · 0 duplicates');
    expect(screen.getByText('Your groups appear here once tabs are sorted.')).toBeTruthy();
  });
  it('points out suspicious tabs with a Review link to the dashboard view, only when there are some', async () => {
    const scam = item('i9', { title: 'Reveal your bonus' });
    serve(state({ suspicious: [{ item: scam, clues: ['popup', 'title'] }] }));
    render(<Popup />);
    await screen.findByText('1 suspicious tab');
    // The same card as the duplicate-tab notice, not a plain line of text.
    const card = screen.getByRole('region', { name: 'Suspicious tabs' });
    expect(card.className).toContain('dup-alert');
    expect(within(card).getByText('1 suspicious tab').tagName).toBe('STRONG');
    expect(within(card).getByText('They opened in the background and look like ads or scams.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Review' }).className).toBe('btn btn-sm');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://ext/dashboard.html#view=suspicious' }));
    cleanup();
    serve(state());
    render(<Popup />);
    await screen.findByText(/tabs ·/);
    expect(screen.queryByText(/suspicious/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });
});

describe('Favicon', () => {
  it('uses the browser favicon endpoint for web pages and a local placeholder otherwise', () => {
    const { container, rerender } = render(<Favicon url="https://a.example/x?y=1&z" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(
      'chrome-extension://ext/_favicon/?pageUrl=' + encodeURIComponent('https://a.example/x?y=1&z') + '&size=32',
    );
    expect(img.getAttribute('loading')).toBe('lazy');
    rerender(<Favicon url="chrome://settings" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.favicon-placeholder')!.style.width).toBe('16px');
  });
});

describe('readableTextOn', () => {
  it('picks the text color with the higher contrast', () => {
    expect(readableTextOn('#ffb224')).toBe('#111113');
    expect(readableTextOn('#3e63dd')).toBe('#ffffff');
    expect(readableTextOn('not a color')).toBe('#111113');
  });
});

describe('group colors', () => {
  it('never pass arbitrary CSS through: an injected color falls back to grey', () => {
    const evil = 'red; background:url(x)';
    const { container } = render(<><GroupChip name="G" color={evil} /><GroupDot color={evil} /></>);
    const painted = container.querySelectorAll<HTMLElement>('.swatch, .group-dot');
    expect(painted.length).toBe(2);
    for (const el of container.querySelectorAll<HTMLElement>('*')) expect(el.getAttribute('style') ?? '').not.toContain('url(');
    for (const el of painted) expect(el.getAttribute('style')).toContain('var(--tone-neutral)');
  });
});
describe('groupTone', () => {
  it('keeps only the hue, never passes stored text into CSS, and greys stay neutral', async () => {
    const { groupTone, groupHue } = await import('../../src/ui/common/color');
    expect(groupTone('#e5484d')).toMatch(/^oklch\(var\(--tone-l\) var\(--tone-c\) \d{1,3}\)$/);
    expect(groupTone('#8d8d8d')).toBe('var(--tone-neutral)');
    expect(groupTone('red; background:url(x)')).toBe('var(--tone-neutral)');
    // Distinct starter colors keep distinct hues.
    expect(groupHue('#e5484d')).not.toBe(groupHue('#30a46c'));
  });

});
