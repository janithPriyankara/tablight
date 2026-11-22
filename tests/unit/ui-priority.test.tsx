// @vitest-environment jsdom
// The Priority group in the dashboard and the side panel: the star on rows, the selection bar, the group listed first.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type DashboardState, type GroupSummary, type Item } from '../../src/shared/types';
import { PRIORITY_COLOR, PRIORITY_GROUP_ID } from '../../src/shared/priority';

vi.mock('../../src/shared/rpc', () => ({ send: vi.fn() }));
const { send } = await import('../../src/shared/rpc');
const { Dashboard } = await import('../../src/ui/dashboard/Dashboard');
const { SidePanel } = await import('../../src/ui/sidepanel/SidePanel');
const { regularGroups } = await import('../../src/ui/dashboard/views');
const { Popup } = await import('../../src/ui/popup/Popup');
const { shortcutsPage } = await import('../../src/ui/dashboard/Settings');
const sendMock = vi.mocked(send);
const P = PRIORITY_GROUP_ID;

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
const priority = (count: number) => group(P, 'Priority', count, { color: PRIORITY_COLOR });
function state(p: Partial<DashboardState> = {}): DashboardState {
  return {
    items: [item('i1'), item('i2', { groupId: P, groupSource: 'user' }), item('i3', { groupId: 'videos' })],
    groups: [group('programming', 'Programming', 5), group('videos', 'Videos', 1), priority(1)],
    dupCount: 0, windows: 1, sleeping: 0, suspicious: [],
    syncStatus: { ok: true, synced: 0, localOnly: 0, lastSyncAt: null },
    modelReady: true, queued: 0, activeTabIds: [],
    settings: { ...DEFAULT_SETTINGS, interestsAnswered: true, onboarded: true },
    ...p,
  };
}
type Req = { t: string; [k: string]: unknown };
function serve(s: DashboardState, extra: (r: Req) => unknown = () => undefined): void {
  sendMock.mockImplementation(async (req) => (req.t === 'state' ? s : extra(req as never)) as never);
}
const sent = (t: string) => sendMock.mock.calls.map(([r]) => r as Req).filter((r) => r.t === t);

const tabsCreate = vi.fn(async () => ({}));
const localRemove = vi.fn(async () => undefined);
const getAll = vi.fn(async () => [
  { name: 'open-dashboard', description: 'Open the Tablight dashboard', shortcut: 'Alt+Shift+T' },
  { name: 'prioritize-tab', description: 'Add the current tab to Priority', shortcut: 'Ctrl+Shift+9' },
  { name: 'unprioritize-tab', description: 'Remove the current tab from Priority', shortcut: '' },
]);
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'ext', getURL: (p: string) => `chrome-extension://ext/${p.replace(/^\//, '')}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    tabs: { query: vi.fn(async () => [{ id: 1, index: 0, active: true, windowId: 1 }, { id: 2, index: 1, windowId: 1 }]), onActivated: { addListener: vi.fn(), removeListener: vi.fn() }, create: tabsCreate },
    commands: { getAll },
    storage: { session: { set: vi.fn(async () => undefined) }, local: { remove: localRemove } },
  });
  history.replaceState(null, '', '/dashboard.html');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendMock.mockReset();
  tabsCreate.mockClear();
});
const nav = () => screen.getByRole('navigation', { name: 'Views and groups' });
const groupsList = () => within(nav()).getByRole('list', { name: 'Groups' });
/** The sidebar's group entries (not their hover close buttons). */
const groupEntries = () => [...groupsList().querySelectorAll<HTMLButtonElement>('.nav-item')];
/** The row of the item titled `title`. */
const rowOf = (title: string) => screen.getByRole('checkbox', { name: `Select ${title}` }).closest('li')!;

describe('regularGroups', () => {
  it('puts Priority first, hides it while empty unless it is open, leaves suggestions out', () => {
    const gs = [group('a', 'A', 9), priority(1), group('s', 'S', 4, { suggested: true }), group('b', 'B', 3)];
    expect(regularGroups(gs).map((g) => g.id)).toEqual([P, 'a', 'b']);
    const empty = [group('a', 'A', 9), priority(0)];
    expect(regularGroups(empty).map((g) => g.id)).toEqual(['a']);
    expect(regularGroups(empty, P).map((g) => g.id)).toEqual([P, 'a']);
  });
});

describe('dashboard', () => {
  it('lists Priority first in the sidebar with a star, and hides it while empty', async () => {
    serve(state());
    render(<Dashboard />);
    await waitFor(() => expect(groupEntries()[0]!.textContent).toMatch(/^Priority/));
    expect(groupEntries()[0]!.querySelector('.star-mark')).not.toBeNull();
    cleanup();
    serve(state({ groups: [group('programming', 'Programming', 5), priority(0)] }));
    render(<Dashboard />);
    await waitFor(() => expect(groupEntries().map((b) => b.textContent)).toEqual(['Programming5']));
  });
  it('the star adds a row to Priority, and on a row already there takes it out; the tooltip names the shortcut', async () => {
    serve(state(), (r) => (r.t === 'prioritize' ? 1 : undefined));
    render(<Dashboard />);
    await screen.findByRole('checkbox', { name: 'Select Title i1' });
    const add = within(rowOf('Title i1')).getByRole('button', { name: 'Add to Priority' });
    expect(add.getAttribute('title')).toContain('Alt+P');
    fireEvent.click(add);
    await waitFor(() => expect(sent('prioritize')).toEqual([{ t: 'prioritize', ids: ['i1'], on: true }]));
    await screen.findByText('Added 1 tab to Priority');
    const remove = within(rowOf('Title i2')).getByRole('button', { name: 'Remove from Priority' });
    expect(remove.getAttribute('title')).toContain('Alt+Shift+P');
    expect(remove.classList.contains('is-on')).toBe(true);
    fireEvent.click(remove);
    await waitFor(() => expect(sent('prioritize')[1]).toEqual({ t: 'prioritize', ids: ['i2'], on: false }));
    await screen.findByText('Removed 1 tab from Priority');
  });
  it('browser pages get no star', async () => {
    serve(state({ items: [item('i5', { url: 'chrome://settings/', classifiable: false, groupId: null })] }));
    render(<Dashboard />);
    await screen.findByRole('button', { name: 'Move to group' });
    expect(screen.queryByRole('button', { name: /^(Add to|Remove from) Priority$/ })).toBeNull();
  });
  it('the selection bar has Prioritize, or Remove from Priority when everything selected is there', async () => {
    serve(state(), (r) => (r.t === 'prioritize' ? (r.ids as string[]).length : undefined));
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Title i1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Title i2' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected tabs' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Prioritize' }));
    await waitFor(() => expect(sent('prioritize')).toEqual([{ t: 'prioritize', ids: ['i1', 'i2'], on: true }]));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Selected tabs' })).toBeNull());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Title i2' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selected tabs' })).getByRole('button', { name: 'Remove from Priority' }));
    await waitFor(() => expect(sent('prioritize')[1]).toEqual({ t: 'prioritize', ids: ['i2'], on: false }));
  });
  it('the Priority page has no rename, merge or delete, and says how to add tabs when empty', async () => {
    history.replaceState(null, '', `/dashboard.html#group=${P}`);
    serve(state({ items: [item('i1')], groups: [group('programming', 'Programming', 1), priority(0)] }));
    render(<Dashboard />);
    await screen.findByRole('heading', { level: 1, name: 'Priority' });
    expect(screen.getByText(/Star a tab, or press Alt\+P on it/)).toBeTruthy();
    for (const name of ['Rename group', 'Merge group', 'Delete group']) expect(screen.queryByRole('button', { name })).toBeNull();
    // Open, so it stays listed though empty.
    expect(groupEntries()[0]!.textContent).toMatch(/^Priority/);
  });
  it('un-starring a row on the Priority page moves focus to the row that takes its place', async () => {
    history.replaceState(null, '', `/dashboard.html#group=${P}`);
    let s = state({ items: [item('i1', { groupId: P, groupSource: 'user' }), item('i2', { groupId: P, groupSource: 'user' })], groups: [priority(2)] });
    sendMock.mockImplementation(async (req) => {
      if (req.t === 'state') return s as never;
      if (req.t === 'prioritize') {
        s = state({ items: [item('i2', { groupId: P, groupSource: 'user' })], groups: [priority(1)] });
        return 1 as never;
      }
      return undefined as never;
    });
    render(<Dashboard />);
    await screen.findByRole('checkbox', { name: 'Select Title i1' });
    const star = within(rowOf('Title i1')).getByRole('button', { name: 'Remove from Priority' });
    star.focus();
    fireEvent.click(star);
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Select Title i1' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowOf('Title i2').querySelector('.item-main')));
  });
  it('a star that changes nothing shows no "0 tabs" message', async () => {
    serve(state(), (r) => (r.t === 'prioritize' ? 0 : undefined));
    render(<Dashboard />);
    await screen.findByRole('checkbox', { name: 'Select Title i1' });
    fireEvent.click(within(rowOf('Title i1')).getByRole('button', { name: 'Add to Priority' }));
    await waitFor(() => expect(sent('prioritize')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/0 tabs/)).toBeNull();
  });
  it('a saved row’s star names no shortcut (the keys act on the tab you are on)', async () => {
    serve(state({ items: [item('i7', { state: 'stashed', tabId: undefined, groupId: null })] }));
    render(<Dashboard />);
    await screen.findByRole('checkbox', { name: 'Select Title i7' });
    expect(within(rowOf('Title i7')).getByRole('button', { name: 'Add to Priority' }).getAttribute('title')).toBe('Add to Priority');
  });
  it('a group renamed for the built-in Priority group gets a one-time notice that can be dismissed', async () => {
    serve(state({ priorityRenamed: ['Priority (yours)'] }));
    render(<Dashboard />);
    const notice = await screen.findByText('Your group “Priority” is now “Priority (yours)”: Priority is a built-in group you fill yourself.');
    fireEvent.click(within(notice.closest('.callout')!).getByRole('button', { name: 'Dismiss' }));
    expect(localRemove).toHaveBeenCalledWith('priorityRenamed');
  });
  it('the name dialog says at once that “Priority” is taken by the built-in group', async () => {
    serve(state());
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Title i1' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selected tabs' })).getByRole('button', { name: 'New group' }));
    const field = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.input(field, { target: { value: ' priority ' } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '“Priority” is the built-in group you fill yourself. Choose another name.');
    expect(screen.getByRole('button', { name: 'Create group' })).toHaveProperty('disabled', true);
    fireEvent.input(field, { target: { value: 'Urgent' } });
    expect(screen.getByRole('button', { name: 'Create group' })).toHaveProperty('disabled', false);
  });
  it('the shortcuts page is Edge’s own in Edge and Chrome’s elsewhere', () => {
    expect(shortcutsPage('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('edge://extensions/shortcuts');
    expect(shortcutsPage('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('chrome://extensions/shortcuts');
  });
  it('Settings lists the current shortcuts and opens the browser’s shortcuts page', async () => {
    history.replaceState(null, '', '/dashboard.html#view=settings');
    serve(state());
    render(<Dashboard />);
    const keys = await screen.findByRole('region', { name: 'Keyboard shortcuts' });
    await waitFor(() => expect(within(keys).getByText('Ctrl+Shift+9')).toBeTruthy());
    expect(within(keys).getByText('Add the current tab to Priority')).toBeTruthy();
    expect(within(keys).getByText('Not set')).toBeTruthy();
    fireEvent.click(within(keys).getByRole('button', { name: 'Open shortcuts page' }));
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
    expect(keys.textContent).toContain('On a Mac they are Option+P and Option+Shift+P');
  });
});

describe('popup duplicate card', () => {
  beforeEach(() => void vi.spyOn(window, 'close').mockImplementation(() => undefined));
  const dup = (active: Item, other: Item) => state({ items: [active, other], activeDup: { item: active, others: [other] } });
  it('never offers to close the tab you are on when it is in Priority; Switch is still there', async () => {
    serve(dup(item('i1', { groupId: P, groupSource: 'user' }), item('i2')));
    render(<Popup />);
    const card = await screen.findByRole('region', { name: 'Duplicate tab' });
    expect(within(card).getByText('This tab is open 2 times')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Close this one/ })).toBeNull();
    expect(within(card).getByRole('button', { name: /Switch/ })).toBeTruthy();
  });
  it('offers Close this one when only the other copy is in Priority, and Switch goes to that copy', async () => {
    serve(dup(item('i1'), item('i2', { groupId: P, groupSource: 'user' })));
    render(<Popup />);
    const card = await screen.findByRole('region', { name: 'Duplicate tab' });
    expect(within(card).getByRole('button', { name: /Close this one/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /Switch/ }));
    await waitFor(() => expect(sent('open')).toEqual([{ t: 'open', id: 'i2' }]));
  });
});

describe('side panel', () => {
  it('shows Priority first with its tabs, and the star toggles a row', async () => {
    serve(state(), (r) => (r.t === 'prioritize' ? 1 : undefined));
    render(<SidePanel />);
    const regions = await screen.findAllByRole('region');
    expect(regions[0]!.getAttribute('aria-labelledby')).toBe(`sp-h-group:${P}`);
    expect(within(regions[0]!).getByText('Title i2')).toBeTruthy();
    fireEvent.click(within(regions[0]!).getByRole('button', { name: 'Remove from Priority' }));
    await waitFor(() => expect(sent('prioritize')).toEqual([{ t: 'prioritize', ids: ['i2'], on: false }]));
    const windowRegion = screen.getByRole('region', { name: /This window/ });
    fireEvent.click(within(windowRegion).getAllByRole('button', { name: 'Add to Priority' })[0]!);
    await waitFor(() => expect(sent('prioritize')[1]).toMatchObject({ t: 'prioritize', on: true }));
  });
  it('an empty Priority group is not shown', async () => {
    serve(state({ items: [item('i1')], groups: [group('programming', 'Programming', 1), priority(0)] }));
    render(<SidePanel />);
    await screen.findByRole('region', { name: /This window/ });
    expect(document.getElementById(`sp-h-group:${P}`)).toBeNull();
  });
});
