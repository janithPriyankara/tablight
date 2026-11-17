// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type DashboardState, type GroupSummary, type Item } from '../../src/shared/types';

vi.mock('../../src/shared/rpc', () => ({ send: vi.fn() }));
const { send } = await import('../../src/shared/rpc');
const { SidePanel } = await import('../../src/ui/sidepanel/SidePanel');
const { InlineCloseConfirm } = await import('../../src/ui/common/Suspicious');
const sendMock = vi.mocked(send);

const XSS = '<img src=x onerror=alert(1)>';
function item(id: string, p: Partial<Item> = {}): Item {
  const url = p.url ?? `https://example.com/${id}`;
  return {
    id, url, normUrl: url, title: `Title ${id}`, domain: 'example.com', state: 'open', tabId: Number(id.replace(/\D/g, '')),
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
      item('i1', { title: 'Rust async guide' }),
      item('i2', { title: 'Dune trailer', groupId: 'movies', kind: 'watch' }),
      item('i3', { title: 'Other window tab', windowId: 2, groupId: 'movies' }),
      item('i4', { title: XSS, groupId: null }),
      item('i5', { title: 'Stashed film', state: 'stashed', tabId: undefined, windowId: undefined, groupId: 'movies' }),
    ],
    groups: [group('programming', 'Programming', 1), group('movies', 'Movies', 3, 2), group('empty', 'Empty', 0)],
    dupCount: 0, windows: 2, sleeping: 0, suspicious: [],
    syncStatus: { ok: true, synced: 0, localOnly: 0, lastSyncAt: null },
    modelReady: true, queued: 0, settings: DEFAULT_SETTINGS,
    ...p,
  };
}
type Handler = (req: { t: string; [k: string]: unknown }) => unknown;
function serve(s: DashboardState, extra: Handler = () => undefined): void {
  sendMock.mockImplementation(async (req) => (req.t === 'state' ? s : extra(req as never)) as never);
}
// Tab order in window 1: i4, i2, i1 (so the list follows the tab strip, not item order); i2 is active.
const windowTabs = [
  { id: 4, index: 0, active: false, windowId: 1 }, { id: 2, index: 1, active: true, windowId: 1 },
  { id: 1, index: 2, active: false, windowId: 1 },
] as chrome.tabs.Tab[];
const onActivated = { addListener: vi.fn(), removeListener: vi.fn() };
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getURL: (p: string) => `chrome-extension://ext/${p.replace(/^\//, '')}`, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    tabs: { query: vi.fn(async () => windowTabs), onActivated },
  });
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendMock.mockReset();
});

const windowSection = () => screen.getByRole('region', { name: /This window/ });
const loaded = () => screen.findByRole('region', { name: /This window/ });

describe('SidePanel', () => {
  it('lists only this window’s tabs, in tab-strip order, with the active one marked', async () => {
    serve(state());
    render(<SidePanel />);
    await waitFor(() => expect(within(windowSection()).getAllByRole('listitem')).toHaveLength(3));
    await waitFor(() => expect(within(windowSection()).getAllByRole('listitem')[0]!.textContent).toContain(XSS));
    const rows = within(windowSection()).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining(XSS), expect.stringContaining('Dune trailer'), expect.stringContaining('Rust async guide'),
    ]);
    expect(rows[1]!.className).toContain('is-active');
    expect(within(windowSection()).queryByText('Other window tab')).toBeNull();
    // Untrusted titles are text, never markup.
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('clicking an entry switches to it and keeps the panel open', async () => {
    serve(state());
    render(<SidePanel />);
    await loaded();
    fireEvent.click(await within(windowSection()).findByRole('button', { name: /Rust async guide/ }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'open', id: 'i1' }));
    expect(window.close).not.toHaveBeenCalled();
  });

  it('groups start collapsed, expand on click to show every tab in them, and skip empty groups', async () => {
    serve(state());
    render(<SidePanel />);
    const header = await screen.findByRole('button', { name: /^Movies/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('2'); // to watch
    expect(screen.queryByRole('button', { name: /^Empty/ })).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByRole('region', { name: /^Movies/ });
    expect(within(region).getByText('Other window tab')).toBeTruthy();
    expect(within(region).getByText('Stashed film')).toBeTruthy();
    // Expanded groups are remembered for the next time the panel opens.
    cleanup();
    render(<SidePanel />);
    expect((await screen.findByRole('button', { name: /^Movies/ })).getAttribute('aria-expanded')).toBe('true');
  });

  it('closing a tab from its row offers Undo', async () => {
    serve(state(), (req) => (req.t === 'close' ? { token: 'tok', closed: 1 } : req.t === 'undo' ? true : undefined));
    render(<SidePanel />);
    await loaded();
    const row = (await within(windowSection()).findByText('Rust async guide')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'close', ids: ['i1'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({ t: 'undo', token: 'tok' }));
  });

  it('a late Undo says so instead of failing silently', async () => {
    serve(state(), (req) => (req.t === 'close' ? { token: 'tok', closed: 1 } : req.t === 'undo' ? false : undefined));
    render(<SidePanel />);
    await loaded();
    const row = (await within(windowSection()).findByText('Rust async guide')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await screen.findByText('Too late to undo');
  });
  it('search asks again when the tabs change, so a closed tab drops out of the matches', async () => {
    let s = state();
    const matches = () => s.items.filter((i) => /Rust|Dune/.test(i.title));
    sendMock.mockImplementation(async (req) =>
      (req.t === 'state' ? s : req.t === 'search' ? { words: matches(), meaning: [] } : undefined) as never);
    render(<SidePanel />);
    await loaded();
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search tabs' }), { target: { value: 'rust' } });
    const list = await screen.findByRole('list', { name: 'Matches' });
    expect(within(list).getByText('Dune trailer')).toBeTruthy();
    // Dune closes elsewhere; the background's "changed" broadcast refreshes the state, then the search.
    s = { ...s, items: s.items.filter((i) => i.id !== 'i2') };
    const onMessage = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0] as (m: unknown, x: unknown) => void;
    onMessage({ target: 'ui', t: 'changed' }, { id: 'ext' });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Matches' })).queryByText('Dune trailer')).toBeNull());
  });
  it('the first Pause and the first Save for later explain themselves once', async () => {
    serve(state(), (req) => (req.t === 'sleep' ? { slept: 1, skipped: 0 } : req.t === 'stash' ? { token: 't', skipped: 0 } : undefined));
    render(<SidePanel />);
    await loaded();
    const rowOf = async (t: string) => (await within(windowSection()).findByText(t)).closest('li')!;
    fireEvent.click(within(await rowOf('Rust async guide')).getByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused 1 tab');
    expect(screen.getByText(/Paused tabs stay in your tab strip and use no memory/)).toBeTruthy();
    fireEvent.click(within(await rowOf('Rust async guide')).getByRole('button', { name: 'Save for later' }));
    await screen.findByText('Saved 1 tab for later');
    expect(screen.getByText(/Find it in Saved for later/)).toBeTruthy();
    fireEvent.click(within(await rowOf('Rust async guide')).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(sendMock.mock.calls.filter(([r]) => (r as { t: string }).t === 'sleep')).toHaveLength(2));
    await screen.findByText('Paused 1 tab');
    expect(screen.queryByText(/Paused tabs stay in your tab strip/)).toBeNull(); // only the first time
  });
  it('search replaces the lists with matches', async () => {
    serve(state(), (req) => (req.t === 'search' ? { words: [item('i1', { title: 'Rust async guide' })], meaning: [] } : undefined));
    render(<SidePanel />);
    await screen.findByRole('region', { name: /This window/ });
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search tabs' }), { target: { value: 'rust' } });
    await screen.findByRole('list', { name: 'Matches' });
    expect(screen.queryByRole('region', { name: /This window/ })).toBeNull();
  });

  describe('suspicious tabs', () => {
    const scam = item('i9', { title: 'Reveal your bonus', windowId: 2, opened: false });
    const sus = () => state({ suspicious: [{ item: scam, clues: ['popup', 'title'] }] });
    const section = () => screen.getByRole('region', { name: 'Suspicious (1)' });
    it('has no section when there are none', async () => {
      serve(state());
      render(<SidePanel />);
      await loaded();
      expect(screen.queryByRole('region', { name: /Suspicious/ })).toBeNull();
    });
    it('shows a section at the top with reasons; Keep and Close act on the row', async () => {
      serve(sus(), (req) => (req.t === 'close' ? { token: 't', closed: 1 } : undefined));
      render(<SidePanel />);
      await loaded();
      const sec = section();
      expect(sec.compareDocumentPosition(windowSection()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(sec).getByText('Opened in a pop-up window · Scam-style title')).toBeTruthy();
      fireEvent.click(within(sec).getByRole('button', { name: 'Keep Reveal your bonus' }));
      await waitFor(() => expect(sendMock.mock.calls.map(([r]) => r)).toContainEqual({ t: 'keepTab', id: 'i9' }));
      fireEvent.click(within(sec).getByRole('button', { name: 'Close Reveal your bonus' }));
      await waitFor(() => expect(sendMock.mock.calls.map(([r]) => r)).toContainEqual({ t: 'close', ids: ['i9'] }));
      await screen.findByRole('button', { name: 'Undo' });
    });
    it('headed like the other sections (count on the right, collapsible, open), compact rows with the window meta', async () => {
      serve(sus());
      render(<SidePanel />);
      await loaded();
      const head = within(section()).getByRole('button', { name: 'Suspicious (1)' });
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(head.querySelector('.sp-chevron')).toBeTruthy();
      expect(head.querySelector('.sp-count')!.textContent).toBe('1');
      const row = within(section()).getByRole('listitem');
      expect(row.querySelector('.state-new')).toBeNull();
      expect(row.querySelector('.item-meta')!.textContent).toBe('example.comWindow 2Programming');
      expect(within(row).getAllByRole('button').map((b) => b.className)).toEqual(['icon-btn', 'icon-btn', 'icon-btn']);
      fireEvent.click(head);
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(within(section()).queryByRole('list', { name: 'Suspicious tabs' })).toBeNull();
      fireEvent.click(head);
      expect(within(section()).getByRole('list', { name: 'Suspicious tabs' })).toBeTruthy();
    });
    it('shows at most 3 rows, then "Show all (N)"', async () => {
      const many = [1, 2, 3, 4, 5].map((n) => ({ item: item(`s${n}`, { title: `Scam ${n}` }), clues: ['popup' as const] }));
      serve(state({ suspicious: many }));
      render(<SidePanel />);
      await loaded();
      const sec = screen.getByRole('region', { name: 'Suspicious (5)' });
      const rows = () => within(within(sec).getByRole('list', { name: 'Suspicious tabs' })).getAllByRole('listitem');
      expect(rows()).toHaveLength(3);
      fireEvent.click(within(sec).getByRole('button', { name: 'Show all (5)' }));
      expect(rows()).toHaveLength(5);
      fireEvent.click(within(sec).getByRole('button', { name: 'Show fewer' }));
      expect(rows()).toHaveLength(3);
      expect(within(sec).getByRole('button', { name: 'Close all (5)' })).toBeTruthy();
    });
    it('"Close all (1)" asks first, listing the titles, then closes', async () => {
      serve(sus(), (req) => (req.t === 'close' ? { token: 't', closed: 1 } : undefined));
      render(<SidePanel />);
      await loaded();
      fireEvent.click(within(section()).getByRole('button', { name: 'Close all (1)' }));
      const ask = await screen.findByRole('group', { name: 'Close 1 suspicious tab?' });
      expect(within(ask).getByText('Reveal your bonus')).toBeTruthy();
      expect(sendMock.mock.calls.some(([r]) => (r as { t: string }).t === 'close')).toBe(false);
      fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('group', { name: /suspicious tab\?/ })).toBeNull();
      fireEvent.click(within(section()).getByRole('button', { name: 'Close all (1)' }));
      fireEvent.click(within(await screen.findByRole('group', { name: 'Close 1 suspicious tab?' })).getByRole('button', { name: 'Close tabs' }));
      await waitFor(() => expect(sendMock.mock.calls.map(([r]) => r)).toContainEqual({ t: 'close', ids: ['i9'] }));
      await screen.findByText('Closed 1 tab');
    });
    it('"Close tabs" is disabled while another action runs, and the confirmation stays open', async () => {
      const onConfirm = vi.fn();
      const { rerender } = render(<InlineCloseConfirm titles={['Reveal your bonus']} busy onCancel={() => undefined} onConfirm={onConfirm} />);
      const ask = screen.getByRole('group', { name: 'Close 1 suspicious tab?' });
      const go = within(ask).getByRole('button', { name: 'Close tabs' }) as HTMLButtonElement;
      expect(go.disabled).toBe(true); // a browser sends no click to a disabled button
      rerender(<InlineCloseConfirm titles={['Reveal your bonus']} busy={false} onCancel={() => undefined} onConfirm={onConfirm} />);
      fireEvent.click(within(screen.getByRole('group', { name: 'Close 1 suspicious tab?' })).getByRole('button', { name: 'Close tabs' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});
