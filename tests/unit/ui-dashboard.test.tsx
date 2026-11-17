// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type DashboardState, type GroupSummary, type Item, type SyncStatus } from '../../src/shared/types';

vi.mock('../../src/shared/rpc', () => ({ send: vi.fn() }));
const { send } = await import('../../src/shared/rpc');
const { Dashboard } = await import('../../src/ui/dashboard/Dashboard');
const { parseHash, viewHash } = await import('../../src/ui/dashboard/views');
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
function group(id: string, name: string, count: number, p: Partial<GroupSummary> = {}): GroupSummary {
  return { id, name, color: '#0090ff', icon: '', builtIn: true, exemplars: [], centroid: null, createdAt: 1, count, watchCount: 0, ...p };
}
function state(p: Partial<DashboardState> = {}): DashboardState {
  return {
    items: [item('i1'), item('i2'), item('i3', { windowId: 2 }), item('i4', { groupId: 'videos', kind: 'watch' })],
    groups: [group('programming', 'Programming', 3), group('videos', 'Videos', 1, { watchCount: 1 })],
    dupCount: 0, windows: 2, sleeping: 0, suspicious: [],
    syncStatus: { ok: true, synced: 412, localOnly: 37, lastSyncAt: Date.now() },
    modelReady: true, queued: 0,
    settings: { ...DEFAULT_SETTINGS, onboarded: true },
    ...p,
  };
}
type Req = { t: string; [k: string]: unknown };
type Handler = (req: Req) => unknown;
function serve(s: DashboardState | (() => DashboardState), extra: Handler = () => undefined): void {
  sendMock.mockImplementation(async (req) =>
    (req.t === 'state' ? (typeof s === 'function' ? s() : s) : extra(req as never)) as never);
}
const sent = (t: string) => sendMock.mock.calls.map(([r]) => r as Req).filter((r) => r.t === t);

type Listener = (m: unknown, s: chrome.runtime.MessageSender) => unknown;
let listeners: Listener[] = [];
const permissionsRequest = vi.fn(async () => true);
const sessionSet = vi.fn(async () => undefined);
beforeEach(() => {
  listeners = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'ext',
      getURL: (p: string) => `chrome-extension://ext/${p.replace(/^\//, '')}`,
      onMessage: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => (listeners = listeners.filter((x) => x !== l)),
      },
    },
    permissions: { request: permissionsRequest },
    storage: { session: { set: sessionSet } },
  });
  history.replaceState(null, '', '/dashboard.html');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sendMock.mockReset();
  permissionsRequest.mockClear();
  sessionSet.mockClear();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});
const ready = () => screen.findByRole('heading', { level: 1 });
const rows = (c: Element) => c.querySelectorAll('.item-row');

describe('dashboard', () => {
  it('renders fewer than 80 rows for 1,000 items (windowed list)', async () => {
    const many = Array.from({ length: 1000 }, (_, n) => item(`i${n + 1}`));
    serve(state({ items: many, groups: [group('programming', 'Programming', 1000)] }));
    const { container } = render(<Dashboard />);
    await screen.findByText('Title i1');
    expect(rows(container).length).toBeGreaterThan(10);
    expect(rows(container).length).toBeLessThan(80);
    expect(container.querySelector<HTMLElement>('.grid-spacer')!.style.height).toBe('52000px'); // full scroll height
    // Scrolling far down renders the rows there instead.
    const scroller = container.querySelector<HTMLElement>('.grid-scroll')!;
    Object.defineProperty(scroller, 'scrollTop', { value: 52 * 600, writable: true, configurable: true });
    fireEvent.scroll(scroller);
    await screen.findByText('Title i601');
    expect(screen.queryByText('Title i1')).toBeNull();
    expect(rows(container).length).toBeLessThan(80);
  });

  it('dragging 3 selected items onto a group sends one moveItems with the 3 ids', async () => {
    serve(state({
      items: [item('i1'), item('i2'), item('i3'), item('i4'), item('i5', { groupId: 'videos' })],
    }), () => undefined);
    const { container } = render(<Dashboard />);
    await screen.findByText('Title i1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Title i1' }));
    fireEvent.click(screen.getByText('Title i3'), { metaKey: true });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Title i4' }));
    await screen.findByText('3 selected');
    const row = screen.getByText('Title i3').closest('li')!;
    fireEvent.dragStart(row, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    const target = within(container.querySelector('.sidebar')!).getByRole('button', { name: /Videos/ }).closest('li')!;
    fireEvent.dragOver(target, { dataTransfer: { dropEffect: 'none' } });
    fireEvent.drop(target);
    await waitFor(() => expect(sent('moveItems')).toEqual([{ t: 'moveItems', ids: ['i1', 'i3', 'i4'], groupId: 'videos' }]));
    // Without a selection, dragging a row moves just that row.
    await screen.findByText(/Moved 3 tabs/);
    fireEvent.dragStart(screen.getByText('Title i2').closest('li')!, { dataTransfer: { setData: vi.fn() } });
    fireEvent.drop(target);
    await waitFor(() => expect(sent('moveItems').at(-1)).toEqual({ t: 'moveItems', ids: ['i2'], groupId: 'videos' }));
  });

  it('"Open all" on a 25-tab session asks first, then resends with confirm', async () => {
    location.hash = '#view=sessions';
    serve(state(), (req) => {
      if (req.t === 'sessions') return [{ id: 's1', takenAt: Date.now() - 60_000, windows: 2, tabs: 25 }];
      if (req.t === 'sessionAction') return req.confirm ? {} : { needsConfirm: 25 };
      return undefined;
    });
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open 25 tabs?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(sent('sessionAction')).toEqual([{ t: 'sessionAction', id: 's1', action: 'openAll' }]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open 25 tabs' }));
    await waitFor(() => expect(sent('sessionAction').at(-1)).toEqual({ t: 'sessionAction', id: 's1', action: 'openAll', confirm: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Cancel (Esc) sends nothing more.
    fireEvent.click(screen.getByRole('button', { name: 'Open all' }));
    const again = await screen.findByRole('dialog');
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent('sessionAction').filter((r) => r.confirm)).toHaveLength(1);
  });

  it('renders malicious titles, URLs and group names as text', async () => {
    serve(state({
      items: [item('i1', { title: XSS, domain: XSS, groupId: 'g' })],
      groups: [group('g', XSS, 1, { color: 'red; background:url(x)' })],
    }));
    const { container } = render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByText(XSS).length).toBeGreaterThan(1));
    expect(container.querySelector('img[src=x]')).toBeNull();
    expect(container.innerHTML).not.toContain('url(x)');
  });

  it('the Re-group preview shows per-group counts and sends nothing until Apply', async () => {
    serve(state(), (req) => {
      if (req.t === 'regroupPreview') return [
        { groupId: null, before: 5, after: 2 }, { groupId: 'programming', before: 3, after: 6 },
      ];
      if (req.t === 'regroupApply') return 3;
      return undefined;
    });
    render(<Dashboard />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Re-group everything' }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-group everything' });
    const unsorted = within(dialog).getByRole('rowheader', { name: 'Unsorted' }).closest('tr')!;
    expect([...unsorted.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['5', '2', '-3']);
    const prog = within(dialog).getByRole('rowheader', { name: 'Programming' }).closest('tr')!;
    expect([...prog.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['3', '6', '+3']);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMock.mock.calls.map(([r]) => r.t).filter((t) => t !== 'state')).toEqual(['regroupPreview']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sent('regroupApply')).toHaveLength(1));
    await screen.findByText('Re-grouped 3 tabs');
  });

  it('refreshes on a "changed" broadcast from its own extension only', async () => {
    let n = 1;
    serve(() => state({ items: [item('i1', { title: `Version ${n}` })] }));
    render(<Dashboard />);
    await screen.findByText('Version 1');
    n = 2;
    for (const l of listeners) l({ target: 'ui', t: 'changed' }, { id: 'someone-else' });
    for (const l of listeners) l({ target: 'background', t: 'changed' }, { id: 'ext' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Version 2')).toBeNull();
    expect(sent('state')).toHaveLength(1);
    for (const l of listeners) expect(l({ target: 'ui', t: 'changed' }, { id: 'ext' })).toBe(false); // never holds the channel
    await screen.findByText('Version 2');
  });

  it('routes by location.hash and writes the hash when a view is picked', async () => {
    expect(parseHash('#group=a%20b%2Fc')).toEqual({ kind: 'group', id: 'a b/c' });
    expect(parseHash('#view=stashed')).toEqual({ kind: 'stashed' });
    expect(parseHash('#view=bogus')).toEqual({ kind: 'all' });
    expect(viewHash({ kind: 'group', id: 'a b/c' })).toBe('group=a%20b%2Fc');
    location.hash = '#group=videos';
    serve(state());
    render(<Dashboard />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Videos' })).toBeTruthy();
    expect(screen.getByText('Title i4')).toBeTruthy();
    expect(screen.queryByText('Title i1')).toBeNull();
    act(() => {
      location.hash = '#view=settings';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    fireEvent.click(within(document.querySelector('.sidebar')!).getByRole('button', { name: /Programming/ }));
    expect(location.hash).toBe('#group=programming');
    await screen.findByRole('heading', { level: 1, name: 'Programming' });
    expect(screen.getByText('Title i1')).toBeTruthy();
  });

  it('keyboard: arrows move focus, Space selects, Delete closes with undo, "/" focuses search', async () => {
    serve(state(), (req) => (req.t === 'close' ? { token: 'tok', closed: 1 } : req.t === 'undo' ? true : undefined));
    const { container } = render(<Dashboard />);
    await screen.findByText('Title i1');
    const mains = () => [...container.querySelectorAll<HTMLElement>('.grid-row .item-main')];
    expect(mains().map((m) => m.tabIndex)).toEqual([0, -1, -1, -1]); // roving tabindex
    mains()[0]!.focus();
    fireEvent.keyDown(mains()[0]!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe(mains()[1]!.textContent));
    fireEvent.keyDown(mains()[1]!, { key: ' ' });
    await screen.findByText('1 selected');
    fireEvent.keyDown(mains()[1]!, { key: 'ArrowDown', shiftKey: true });
    await screen.findByText('2 selected');
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    await waitFor(() => expect(sent('close')).toHaveLength(1));
    expect((sent('close')[0]!.ids as string[]).sort()).toEqual(['i2', 'i4']); // rows are ordered by window: i1 i2 i4 i3
    await screen.findByText('Closed 1 tab'); // the count the background actually closed
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sent('undo')).toEqual([{ t: 'undo', token: 'tok' }]));
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search tabs' }));
  });

  it('two arrow presses before the list repaints move two rows, not one (UI test K-02)', async () => {
    serve(state());
    const { container } = render(<Dashboard />);
    await screen.findByText('Title i1');
    const mains = () => [...container.querySelectorAll<HTMLElement>('.grid-row .item-main')];
    mains()[0]!.focus();
    // A fast typist (or key repeat): the second key arrives before the first one's focus move has happened.
    const press = (key: string, shiftKey = false) =>
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    press('ArrowDown');
    press('ArrowDown');
    await waitFor(() => expect(document.activeElement).toBe(mains()[2]));
    // The same for Shift+↓ extending a selection.
    fireEvent.keyDown(mains()[0]!, { key: 'Home' });
    await waitFor(() => expect(document.activeElement).toBe(mains()[0]));
    fireEvent.keyDown(mains()[0]!, { key: ' ' });
    await screen.findByText('1 selected');
    press('ArrowDown', true);
    press('ArrowDown', true);
    await screen.findByText('3 selected');
  });
  it('Delete acts on the focused row even after a live update moved it', async () => {
    let items = ['i1', 'i2', 'i3', 'i4', 'i5'].map((id) => item(id, { windowId: 1 }));
    serve(() => state({ items }), (req) => (req.t === 'close' ? { token: 'tok', closed: 1 } : undefined));
    const { container } = render(<Dashboard />);
    await screen.findByText('Title i5');
    const mainFor = (id: string) =>
      [...container.querySelectorAll<HTMLElement>('.grid-row .item-main')].find((m) => m.textContent?.includes(`Title ${id}`))!;
    mainFor('i4').focus();
    fireEvent.focusIn(mainFor('i4'));
    // i1 closes elsewhere: the list refreshes and i4 moves up one row, keeping DOM focus.
    items = items.filter((i) => i.id !== 'i1');
    for (const l of listeners) l({ target: 'ui', t: 'changed' }, { id: 'ext' });
    await waitFor(() => expect(screen.queryByText('Title i1')).toBeNull());
    fireEvent.keyDown(mainFor('i4'), { key: 'Delete' });
    await waitFor(() => expect(sent('close')).toHaveLength(1));
    expect(sent('close')[0]!.ids).toEqual(['i4']);
  });
  it('search results follow live updates: a closed tab disappears from them', async () => {
    let items = [item('i1', { title: 'Rust one' }), item('i2', { title: 'Rust two' })];
    serve(() => state({ items }), (req) => {
      if (req.t === 'search') return { words: items, meaning: [] }; // the background searches its current items
      if (req.t === 'close') {
        items = items.filter((i) => i.id !== 'i1');
        return { token: 'tok', closed: 1 };
      }
      return undefined;
    });
    render(<Dashboard />);
    await screen.findByText('Rust one');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search tabs' }), { target: { value: 'rust' } });
    await screen.findByText(/Results for/);
    const row = (await screen.findByText('Rust one')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Rust one')).toBeNull());
    expect(screen.getByText('Rust two')).toBeTruthy();
  });
  it('guided tour: offered on first run, steps through the real screen, Esc ends it and marks onboarding done', async () => {
    serve(state({ settings: DEFAULT_SETTINGS }), (req) => (req.t === 'settings' ? { ...DEFAULT_SETTINGS, ...(req.patch as object) } : undefined));
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take the tour' }));
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to Tablight' });
    expect(within(dialog).getByText(/1 of \d+/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement && dialog.contains(document.activeElement)).toBe(true); // focus moves into the tour
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const groups = await screen.findByRole('dialog', { name: 'Your groups' });
    expect(document.querySelector('.tour-spot')).toBeTruthy(); // the real group list is highlighted
    fireEvent.keyDown(groups, { key: 'ArrowRight' });
    await screen.findByRole('dialog', { name: 'All tabs' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    await screen.findByRole('dialog', { name: 'Your groups' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(sent('settings')).toContainEqual({ t: 'settings', patch: { onboarded: true } }));
  });
  it('guided tour: every step points at exactly one element on the page', async () => {
    const { TOUR_STEPS } = await import('../../src/ui/dashboard/Tour');
    serve(state());
    render(<Dashboard />);
    await screen.findByText('Title i1');
    for (const s of TOUR_STEPS.filter((x) => x.target)) {
      expect(document.querySelectorAll(s.target!).length, s.target).toBe(1);
    }
  });
  it('guided tour: the ? button restarts it any time, and the last step says Done', async () => {
    serve(state());
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Guided tour' }));
    await screen.findByRole('dialog', { name: 'Welcome to Tablight' });
    for (let k = 0; k < 40 && !screen.queryByRole('button', { name: 'Done' }); k++) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('never-opened tabs are marked New, counted in the summary, and can be shown on their own', async () => {
    location.hash = '#group=videos';
    serve(state({
      items: [
        item('i1', { groupId: 'videos', kind: 'watch', opened: false, title: 'Unwatched one' }),
        item('i2', { groupId: 'videos', kind: 'watch', opened: false, title: 'Unwatched two' }),
        item('i3', { groupId: 'videos', kind: 'watch', opened: true, title: 'Seen already', url: 'https://www.youtube.com/watch?v=x&t=754s' }),
        item('i4', { groupId: 'videos', kind: 'watch', state: 'stashed', tabId: undefined, windowId: undefined, opened: false, title: 'Saved one' }),
      ],
      groups: [group('videos', 'Videos', 4, { watchCount: 4 })],
    }));
    render(<Dashboard />);
    await screen.findByText('Unwatched one');
    expect(screen.getByText('4 items · 4 to watch · 2 new')).toBeTruthy();
    const rowOf = (t: string) => screen.getByText(t).closest('li')!;
    expect(within(rowOf('Unwatched one')).getByText('New')).toBeTruthy();
    expect(within(rowOf('Seen already')).queryByText('New')).toBeNull();
    expect(within(rowOf('Saved one')).queryByText('New')).toBeNull(); // saved tabs aren't "new" tabs
    expect(within(rowOf('Seen already')).getByText('from 12:34')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show new only' }));
    await waitFor(() => expect(screen.queryByText('Seen already')).toBeNull());
    expect(screen.getByText('Unwatched two')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await screen.findByText('Seen already');
  });
  it('Settings → About links to every information page, opening in a new tab', async () => {
    location.hash = '#view=settings';
    serve(state());
    render(<Dashboard />);
    const about = await screen.findByRole('region', { name: 'About' });
    const links = within(about).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]);
    expect(links).toEqual([
      ['About Tablight', 'about.html', '_blank', 'noopener'], ['Help and support', 'support.html', '_blank', 'noopener'],
      ['Privacy policy', 'privacy.html', '_blank', 'noopener'], ['Terms of use', 'terms.html', '_blank', 'noopener'],
      ['Open-source licences', 'licenses.html', '_blank', 'noopener'],
    ]);
    expect(about.textContent).toContain('The Moonstone (Pvt) Ltd');
  });
  it('import refuses files over 20 MB before reading them', async () => {
    location.hash = '#view=settings';
    serve(state(), (req) => (req.t === 'import' ? { added: 2, skipped: 1 } : undefined));
    const { container } = render(<Dashboard />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('application/json,.json');
    const big = new File(['{}'], 'big.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    const read = vi.spyOn(big, 'text');
    fireEvent.change(input, { target: { files: [big] } });
    await screen.findByText(/larger than 20 MB/);
    expect(read).not.toHaveBeenCalled();
    expect(sent('import')).toHaveLength(0);
    const ok = new File(['{"schema":1}'], 'ok.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [ok] } });
    await waitFor(() => expect(sent('import')).toEqual([{ t: 'import', json: '{"schema":1}' }]));
    await screen.findByText('Imported 2 tabs · skipped 1');
  });

  it('settings: sync status line, theme, and mirroring asks for the permission before enabling', async () => {
    location.hash = '#view=settings';
    let settings = { ...DEFAULT_SETTINGS, onboarded: true };
    serve(() => state({ settings }), (req) => {
      if (req.t === 'settings') settings = { ...settings, ...(req.patch as object) };
      return settings;
    });
    render(<Dashboard />);
    await screen.findByText('Synced 412 · 37 only on this device');
    expect(screen.getByRole('link', { name: 'Read the privacy policy' }).getAttribute('href')).toBe('privacy.html');
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(sent('settings')).toEqual([{ t: 'settings', patch: { theme: 'dark' } }]);
    permissionsRequest.mockResolvedValueOnce(false);
    const mirror = screen.getByRole('checkbox', { name: /Mirror groups/ });
    fireEvent.click(mirror);
    await screen.findByText(/Permission not granted/);
    expect(permissionsRequest).toHaveBeenCalledWith({ permissions: ['tabGroups'] });
    expect(sent('settings')).toHaveLength(1);
    fireEvent.click(mirror);
    await waitFor(() => expect(sent('settings').at(-1)).toEqual({ t: 'settings', patch: { mirrorTabGroups: true } }));
    fireEvent.click(screen.getByRole('radio', { name: 'Side panel' }));
    await waitFor(() => expect(sent('settings').at(-1)).toEqual({ t: 'settings', patch: { toolbarOpens: 'sidepanel' } }));
  });
  it('settings: every sync status reads as it should, failures marked as errors (UI test S-11)', async () => {
    location.hash = '#view=settings';
    const now = Date.now();
    const cases: [SyncStatus, string, boolean][] = [
      [{ ok: true, synced: 0, localOnly: 0, lastSyncAt: null }, 'Not synced yet', false],
      [{ ok: true, synced: 412, localOnly: 37, lastSyncAt: now - 5 * 60_000 }, 'Synced 412 · 37 only on this device · last synced 5 min ago', false],
      [{ ok: false, reason: 'quota', message: 'Sync storage is full: 3 saved tabs stay on this device', lastSyncAt: null }, 'Sync storage is full: 3 saved tabs stay on this device', true],
      [{ ok: false, reason: 'rate', message: 'Too many changes at once: retrying shortly', lastSyncAt: now - 3_600_000 }, 'Too many changes at once: retrying shortly · last synced 1 h ago', true],
      [{ ok: false, reason: 'error', message: 'Sync failed: will retry', lastSyncAt: null }, 'Sync failed: will retry', true],
      [{ ok: false, reason: 'disabled', message: 'Sync is turned off', lastSyncAt: null }, 'Sync is turned off', true],
    ];
    for (const [syncStatus, text, isError] of cases) {
      serve(state({ syncStatus }));
      const { container, unmount } = render(<Dashboard />);
      await screen.findByRole('heading', { level: 1, name: 'Settings' });
      const line = container.querySelector('.sync-status')!;
      expect(line.textContent, text).toBe(text);
      expect(line.className).toBe(isError ? 'sync-status is-error' : 'sync-status');
      unmount();
    }
  });
  it('onboarding asks to pin the extension only while it is not on the toolbar', async () => {
    const getUserSettings = vi.fn(async () => ({ isOnToolbar: false }));
    (chrome as unknown as { action: unknown }).action = { getUserSettings };
    serve(state({ settings: DEFAULT_SETTINGS }));
    render(<Dashboard />);
    await screen.findByText(/Pin Tablight/);
    cleanup();
    getUserSettings.mockResolvedValue({ isOnToolbar: true });
    render(<Dashboard />);
    await screen.findByText(/Nothing leaves your device/);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Pin Tablight/)).toBeNull();
  });

  it('first run shows onboarding; model-not-ready shows the grouping banner; the last session card', async () => {
    const snap = { id: 'snap1', takenAt: Date.now() - 3_600_000, windows: [{ tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }] }] };
    serve(state({ settings: DEFAULT_SETTINGS, modelReady: false, lastSession: snap }), (req) =>
      (req.t === 'settings' ? { ...DEFAULT_SETTINGS, ...(req.patch as object) } : req.t === 'sessionAction' ? {} : undefined));
    render(<Dashboard />);
    await screen.findByText('Grouping your tabs…');
    expect(screen.getByText(/Nothing leaves your device/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-pause tabs unused for 1 hour' }));
    await waitFor(() => expect(sent('settings')).toEqual([{ t: 'settings', patch: { autoSleepMinutes: 60, onboarded: true } }]));
    expect(screen.getByRole('heading', { name: 'Your last session (2 tabs) wasn’t restored' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save all for later' }));
    await waitFor(() => expect(sent('sessionAction')).toEqual([{ t: 'sessionAction', id: 'snap1', action: 'stashAll' }]));
    fireEvent.click(within(screen.getByRole('region', { name: /last session/ })).getByRole('button', { name: 'Dismiss' }));
    expect(sessionSet).toHaveBeenCalledWith({ lastSession: { snapshotId: null } });
    expect(screen.queryByText(/wasn’t restored/)).toBeNull();
  });

  it('close duplicates asks "Close N duplicate tabs?" before closing; export downloads a dated file', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    serve(state({ dupCount: 2 }), (req) =>
      (req.t === 'closeExtras' ? { closed: 2, token: 't' } : req.t === 'export' ? '{"schema":1}' : undefined));
    render(<Dashboard />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Close duplicates' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close 2 duplicate tabs?' });
    expect(sent('closeExtras')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close duplicates' }));
    await screen.findByText('Closed 2 duplicate tabs');
    fireEvent.click(within(document.querySelector('.sidebar')!).getByRole('button', { name: /Settings/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const a = click.mock.contexts[0] as HTMLAnchorElement;
    expect(a.download).toMatch(/^tablight-\d{4}-\d{2}-\d{2}\.json$/);
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:x'));
    await screen.findByText('Backup ready');
  });

  it('focus returns to the opener after a dialog opened from an action closes', async () => {
    serve(state({ dupCount: 2 }), (req) => (req.t === 'closeExtras' ? { closed: 2, token: 't' } : undefined));
    render(<Dashboard />);
    await ready();
    const opener = screen.getByRole('button', { name: 'Close duplicates' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Close 2 duplicate tabs?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect((opener as HTMLButtonElement).disabled).toBe(false);
  });
  it('below 900 px the view select also reaches suggested groups (with watch counts)', async () => {
    serve(state({
      groups: [group('programming', 'Programming', 3), group('videos', 'Videos', 1, { watchCount: 1 }), group('sug', 'Rust · async', 4, { suggested: true })],
    }));
    render(<Dashboard />);
    await ready();
    const select = screen.getByRole('combobox', { name: 'View' });
    const labels = [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)]);
    expect(labels).toEqual([
      ['Groups', ['Programming (3)', 'Videos (1, 1 to watch)']],
      ['Suggested', ['Rust · async (4)']],
    ]);
    fireEvent.change(select, { target: { value: 'group:sug' } });
    await screen.findByRole('heading', { level: 1, name: 'Rust · async' });
    expect(screen.getByRole('button', { name: 'Accept group' })).toBeTruthy();
  });
  it('in-app privacy text names the one exception: browser-account sync of stashed tabs', async () => {
    serve(state({ settings: DEFAULT_SETTINGS }));
    render(<Dashboard />);
    const onboarding = await screen.findByRole('region', { name: 'Welcome to Tablight' });
    expect(onboarding.textContent).toMatch(/Nothing leaves your device except tabs you save for later and the examples you teach your groups/);
    act(() => {
      location.hash = '#view=settings';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const privacy = await screen.findByRole('region', { name: 'Privacy' });
    expect(privacy.textContent).toMatch(/except saved tabs and the examples you taught your groups, which sync/);
  });
  it('Undo works while another action is still running', async () => {
    let release!: () => void;
    serve(state(), async (req) => {
      if (req.t === 'close') return { token: 'tok', closed: 1 };
      if (req.t === 'sleep') { await new Promise<void>((r) => (release = r)); return { slept: 1, skipped: 0 }; }
      if (req.t === 'undo') return true;
      return undefined;
    });
    render(<Dashboard />);
    await screen.findByText('Title i1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    const undoBtn = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]!); // busy now
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(undoBtn);
    await waitFor(() => expect(sent('undo')).toEqual([{ t: 'undo', token: 'tok' }]));
    release();
  });
  it('a settings overlay is cleared per key, only once the state reflects it', async () => {
    location.hash = '#view=settings';
    let settings = { ...DEFAULT_SETTINGS, onboarded: true };
    let releaseSync!: () => void;
    serve(() => state({ settings }), async (req) => {
      const patch = req.patch as Record<string, unknown>;
      if ('syncEnabled' in patch) await new Promise<void>((r) => (releaseSync = r)); // slow; not stored yet
      settings = { ...settings, ...patch };
      return settings;
    });
    render(<Dashboard />);
    const sync = await screen.findByRole('checkbox', { name: /Sync saved tabs/ });
    fireEvent.click(sync);
    await waitFor(() => expect(releaseSync).toBeTypeOf('function'));
    expect((sync as HTMLInputElement).checked).toBe(false); // optimistic
    for (const l of listeners) l({ target: 'ui', t: 'changed' }, { id: 'ext' }); // a refresh that predates the write
    await new Promise((r) => setTimeout(r, 30));
    expect((sync as HTMLInputElement).checked).toBe(false); // overlay kept: state still says true
    releaseSync();
    await waitFor(() => expect(sent('state').length).toBeGreaterThan(2));
    expect((sync as HTMLInputElement).checked).toBe(false);
  });
  it('stashed rows have "Remove from stash"; the Stashed view removes all after a confirm; both undoable', async () => {
    const stashed = [item('s1', { state: 'stashed', tabId: undefined }), item('s2', { state: 'stashed', tabId: undefined })];
    serve(state({ items: [item('i1'), ...stashed] }), (req) =>
      (req.t === 'stashDelete' ? { token: 'rt', deleted: (req.ids as string[]).length } : req.t === 'undo' ? true : undefined));
    history.replaceState(null, '', '/dashboard.html#view=stashed');
    const { container } = render(<Dashboard />);
    await screen.findByText('Title s1');
    const row = [...container.querySelectorAll<HTMLElement>('.grid-row')].find((r) => r.textContent?.includes('Title s1'))!;
    fireEvent.click(within(row).getByRole('button', { name: 'Remove from Saved for later' }));
    await waitFor(() => expect(sent('stashDelete')).toEqual([{ t: 'stashDelete', ids: ['s1'] }]));
    await screen.findByText('Removed 1 saved tab');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sent('undo')).toEqual([{ t: 'undo', token: 'rt' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove 2 saved tabs?' });
    expect(sent('stashDelete')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove all' }));
    await waitFor(() => expect(sent('stashDelete')).toHaveLength(2));
    expect((sent('stashDelete')[1]!.ids as string[]).sort()).toEqual(['s1', 's2']);
    await screen.findByText('Removed 2 saved tabs');
  });
  it('Settings → Delete all data asks first (Cancel focused), then sends deleteAllData', async () => {
    serve(state(), () => undefined);
    history.replaceState(null, '', '/dashboard.html#view=settings');
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all data' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete all data?' });
    expect(dialog.textContent).toMatch(/Open tabs stay open/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent('deleteAllData')).toHaveLength(0);
    localStorage.setItem('hint.pause', '1');
    localStorage.setItem('sidepanel.open', '["window"]');
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete all data?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all data' }));
    await waitFor(() => expect(sent('deleteAllData')).toHaveLength(1));
    await screen.findByText('All data deleted');
    expect(localStorage.length).toBe(0); // the pages' own flags go too
  });
  it('the import notice reports file sessions that did not fit', async () => {
    const { importNotice } = await import('../../src/ui/dashboard/Settings');
    expect(importNotice({ added: 2, skipped: 1 })).toBe('Imported 2 tabs · skipped 1');
    expect(importNotice({ added: 1, skipped: 0, skippedSessions: 3 })).toBe('Imported 1 tab · 3 sessions not imported (saved sessions are full)');
  });
  it('a "Stash this window" hash shows Stashed + Undo once (valid UUID only); Undo goes through the RPC', async () => {
    const { parseUndoHash } = await import('../../src/ui/dashboard/views');
    const tok = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseUndoHash(`#view=stashed&undo=${tok}&n=3`)).toEqual({ token: tok, n: 3 });
    expect(parseUndoHash('#view=stashed&undo=<script>&n=3')).toBeNull();
    expect(parseUndoHash(`#view=stashed&undo=${tok}&n=-1`)).toBeNull();
    expect(parseUndoHash('#view=stashed')).toBeNull();
    serve(state({ items: [item('s1', { state: 'stashed', tabId: undefined })] }), (req) => (req.t === 'undo' ? true : undefined));
    history.replaceState(null, '', `/dashboard.html#view=stashed&undo=${tok}&n=3`);
    render(<Dashboard />);
    await screen.findByText('Saved 3 tabs for later');
    expect(location.hash).toBe('#view=stashed'); // token dropped from the address
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Saved for later');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sent('undo')).toEqual([{ t: 'undo', token: tok }]));
  });
  it('the export text says the backup includes saved sessions', async () => {
    serve(state());
    history.replaceState(null, '', '/dashboard.html#view=settings');
    render(<Dashboard />);
    await screen.findByRole('button', { name: 'Export backup' });
    expect(screen.getByText(/backup file contains your saved tabs, your groups and your saved sessions/)).toBeTruthy();
  });

  it('a failed load shows the error with Retry; a later failed refresh keeps the list; the grouping banner (UI tests D-90..D-91)', async () => {
    sendMock.mockRejectedValueOnce(new Error('Background unavailable'));
    render(<Dashboard />);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load your tabs: Background unavailable');
    let s = state();
    serve(() => s);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Title i1');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Grouping your tabs…')).toBeNull();
    // A refresh that fails later keeps the last list on screen.
    sendMock.mockRejectedValueOnce(new Error('Background unavailable'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t refresh (Background unavailable). Showing the last known tabs.');
    expect(screen.getByText('Title i1')).toBeTruthy();
    // Retry with the model still loading: the error goes, the grouping banner shows.
    s = state({ modelReady: false });
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await screen.findByText('Grouping your tabs…');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  describe('suspicious tabs', () => {
    const scam = item('s9', { title: 'Open an envelope and reveal your bonus', url: 'https://official-app.space/click?key=abc', domain: 'official-app.space', opened: false });
    const sus = () => state({ items: [...state().items, scam], suspicious: [{ item: scam, clues: ['opener', 'unseen', 'address'] }] });
    const sidebar = () => within(document.querySelector('.sidebar')! as HTMLElement);
    it('the sidebar entry shows the count after Duplicates, only while there are suspicious tabs', async () => {
      serve(sus());
      render(<Dashboard />);
      await ready();
      const entry = sidebar().getByRole('button', { name: /Suspicious/ });
      expect(entry.textContent).toContain('1');
      const names = sidebar().getAllByRole('button').map((b) => b.textContent ?? '');
      expect(names.findIndex((n) => n.startsWith('Suspicious'))).toBe(names.findIndex((n) => n.startsWith('Duplicates')) + 1);
      cleanup();
      serve(state());
      render(<Dashboard />);
      await ready();
      expect(sidebar().queryByRole('button', { name: /Suspicious/ })).toBeNull();
    });
    it('the view explains itself, lists the reasons, and Keep / Go to tab / Close act on the row', async () => {
      location.hash = '#view=suspicious';
      serve(sus(), (req) => (req.t === 'close' ? { token: 't', closed: 1 } : undefined));
      render(<Dashboard />);
      expect((await ready()).textContent).toBe('Suspicious');
      expect(screen.getByText('These tabs opened in the background and look like ads or scams. Tablight never closes tabs on its own.')).toBeTruthy();
      expect(screen.getByText('Opened by another site · Never viewed · Ad-click address')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: `Keep ${scam.title}` }));
      await waitFor(() => expect(sent('keepTab')).toEqual([{ t: 'keepTab', id: 's9' }]));
      fireEvent.click(screen.getByRole('button', { name: `Go to tab ${scam.title}` }));
      await waitFor(() => expect(sent('open')).toEqual([{ t: 'open', id: 's9' }]));
      fireEvent.click(screen.getByRole('button', { name: `Close ${scam.title}` }));
      await waitFor(() => expect(sent('close')).toEqual([{ t: 'close', ids: ['s9'] }]));
      await screen.findByText('Closed 1 tab');
    });
    it('rows: no "New" chip (the reasons say it), the window and group meta line, worded Go to tab / Keep / Close buttons', async () => {
      location.hash = '#view=suspicious';
      const popped = { ...scam, windowId: 2 };
      serve(state({ items: [...state().items, popped], suspicious: [{ item: popped, clues: ['opener', 'unseen', 'address'] }] }));
      render(<Dashboard />);
      await ready();
      const row = within(screen.getByRole('list', { name: 'Suspicious tabs' })).getByRole('listitem');
      expect(row.querySelector('.state-new')).toBeNull();
      expect(row.querySelector('.item-meta')!.textContent).toBe('official-app.spaceWindow 2Programming');
      expect(row.querySelector('.item-note')!.textContent).toBe('Opened by another site · Never viewed · Ad-click address');
      const buttons = within(row).getAllByRole('button');
      // Keep, the way out of a false alarm, is a visible word here (the side panel keeps icon buttons).
      expect(buttons.map((b) => b.className)).toEqual(Array(3).fill('btn btn-sm btn-ghost sus-btn'));
      expect(buttons.map((b) => b.textContent)).toEqual(['Go to tab', 'Keep', 'Close']);
      expect(buttons.map((b) => b.querySelector('svg.icon'))).not.toContain(null);
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([`Go to tab ${scam.title}`, `Keep ${scam.title}`, `Close ${scam.title}`]);
      expect(buttons.map((b) => b.title)).toEqual(['Go to tab', 'Keep: stop pointing this tab out', 'Close tab']);
      // Elsewhere the same unseen tab keeps its "New" chip.
      cleanup();
      location.hash = '#view=all';
      serve(sus());
      render(<Dashboard />);
      await ready();
      const listed = [...document.querySelectorAll('.item-row')].find((r) => r.textContent?.includes(scam.title));
      expect(listed?.querySelector('.state-new')).toBeTruthy();
    });
    it('header like Duplicates: the count as the subtitle, "Close all (N)" in the top bar beside Close duplicates', async () => {
      location.hash = '#view=suspicious';
      serve(sus());
      render(<Dashboard />);
      await ready();
      expect(document.querySelector('.view-sub')!.textContent).toBe('1 suspicious tab');
      const toolbar = document.querySelector('.toolbar') as HTMLElement;
      expect(within(toolbar).getByRole('button', { name: 'Close all (1)' })).toBeTruthy();
      expect(within(toolbar).getByRole('button', { name: /Close duplicates/ })).toBeTruthy();
      expect(document.querySelector('.view-actions')!.textContent).toBe('');
    });
    it('"Close all (1)" asks first, listing the titles, then closes with Undo', async () => {
      location.hash = '#view=suspicious';
      serve(sus(), (req) => (req.t === 'close' ? { token: 't', closed: 1 } : undefined));
      render(<Dashboard />);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: 'Close all (1)' }));
      const dialog = await screen.findByRole('dialog', { name: 'Close 1 suspicious tab?' });
      expect(within(dialog).getByText(scam.title)).toBeTruthy();
      expect(sent('close')).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close tabs' }));
      await waitFor(() => expect(sent('close')).toEqual([{ t: 'close', ids: ['s9'] }]));
      await screen.findByText('Closed 1 tab');
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    });
    it('routed there with none: "No suspicious tabs." and the entry stays while selected', async () => {
      location.hash = '#view=suspicious';
      serve(state());
      render(<Dashboard />);
      await screen.findByText('No suspicious tabs.');
      expect(sidebar().getByRole('button', { name: /Suspicious/ }).getAttribute('aria-current')).toBe('page');
      expect(screen.queryByRole('button', { name: /Close all/ })).toBeNull();
    });
    it('Settings: the "Point out suspicious tabs" switch saves the setting', async () => {
      location.hash = '#view=settings';
      let settings = { ...DEFAULT_SETTINGS, onboarded: true };
      serve(() => state({ settings }), (req) => {
        if (req.t === 'settings') settings = { ...settings, ...(req.patch as object) };
        return settings;
      });
      render(<Dashboard />);
      const sw = await screen.findByRole('checkbox', { name: /Point out suspicious tabs/ });
      expect((sw as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText('Flags background tabs that look like ads or scams. Nothing is closed without your click.')).toBeTruthy();
      fireEvent.click(sw);
      await waitFor(() => expect(sent('settings')).toEqual([{ t: 'settings', patch: { suspiciousTabs: false } }]));
    });
  });
});
