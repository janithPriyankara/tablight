// @vitest-environment jsdom
// The "Look it up" button and its confirm dialog (design Part 2): where the button shows, what the dialog says, that
// nothing is sent before "Look up", that what is sent is the (re-cleaned) text in the box, and how a hit moves the tab.
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type DashboardState, type GroupSummary, type Item, type Settings as SettingsT } from '../../src/shared/types';
import { lookupText } from '../../src/shared/lookup-text';

vi.mock('../../src/shared/rpc', () => ({ send: vi.fn() }));
vi.mock('../../src/ui/common/lookup', async (orig) => {
  const actual = await orig<typeof import('../../src/ui/common/lookup')>();
  return { ...actual, lookUp: vi.fn(actual.lookUp) };
});
const { send } = await import('../../src/shared/rpc');
const { lookUp, LOOKUP_DIALOG_SENTENCE } = await import('../../src/ui/common/lookup');
const { LookupDialog, lookupOffer, LOOKUP_SETTING_HINT } = await import('../../src/ui/common/LookupDialog');
const { ItemGrid } = await import('../../src/ui/dashboard/ItemGrid');
const { SidePanel } = await import('../../src/ui/sidepanel/SidePanel');
const { Settings } = await import('../../src/ui/dashboard/Settings');
const { openDb } = await import('../../src/background/db');
const sendMock = vi.mocked(send);
const lookUpMock = vi.mocked(lookUp);

const GOOGLE = 'https://www.google.com/search?q=severance+tv+show';
const GOOGLE_TITLE = 'severance tv show - Google Search';
function item(id: string, p: Partial<Item> = {}): Item {
  const url = p.url ?? GOOGLE;
  return {
    id, url, normUrl: url, title: GOOGLE_TITLE, domain: 'www.google.com', state: 'open', tabId: Number(id.replace(/\D/g, '')),
    windowId: 1, groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1,
    classifiable: true, ...p,
  };
}
function group(id: string, name: string, p: Partial<GroupSummary> = {}): GroupSummary {
  return { id, name, color: '#0090ff', icon: '', builtIn: true, exemplars: [], centroid: null, createdAt: 1, count: 1, watchCount: 0, ...p };
}
const GROUPS = [group('tv', 'TV Series'), group('programming', 'Programming')];
const XSS = '<img src=x onerror=alert(1)>';
function reply(search: unknown[]): Response {
  return new Response(JSON.stringify({ search }), { status: 200, headers: { 'content-type': 'application/json' } });
}
let fetchSpy: ReturnType<typeof vi.fn>;
let stored: Record<string, unknown>;
beforeEach(() => {
  localStorage.clear();
  stored = {};
  fetchSpy = vi.fn(async () => reply([
    { label: 'Severance', description: 'American television series' },
    { label: XSS, description: 'Japanese manga series' },
    { label: 'Severance pay', description: '' },
  ]));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getURL: (p: string) => `chrome-extension://ext/${p}`, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    tabs: { query: vi.fn(async () => [{ id: 1, index: 0, active: false, windowId: 1 }]), onActivated: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: {
      local: {
        get: vi.fn(async (k: string) => (k in stored ? { [k]: stored[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => void Object.assign(stored, o)),
      },
    },
  });
  sendMock.mockResolvedValue(undefined as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendMock.mockReset();
  lookUpMock.mockClear();
});

/** What the dialog asked the background to change (the head's labelForText fallback only reads). */
const moves = () => sendMock.mock.calls.map(([r]) => r).filter((r) => r.t !== 'labelForText' && r.t !== 'state');
const dialog = () => screen.getByRole('dialog', { name: 'Look it up' });
const box = () => within(dialog()).getByRole('textbox', { name: LOOKUP_DIALOG_SENTENCE }) as HTMLInputElement;
function open(it: Item = item('t1'), groups: GroupSummary[] = GROUPS) {
  const onClose = vi.fn();
  render(<LookupDialog item={it} groups={groups} onClose={onClose} />);
  return onClose;
}

describe('where the button shows', () => {
  const grid = (items: Item[], lookup: boolean) => {
    const onAction = vi.fn();
    render(
      <ItemGrid
        items={items} label="Tabs" selected={new Set()} groups={new Map(GROUPS.map((g) => [g.id, g]))} showGroup
        windowNo={new Map()} onOpen={vi.fn()} onSelect={vi.fn()} onClearSelection={vi.fn()} onAction={onAction}
        onDelete={vi.fn()} onDragStart={vi.fn()} onDragEnd={vi.fn()} resetKey="all" lookup={lookup}
      />,
    );
    return onAction;
  };
  it('dashboard: only on Unsorted rows that may be looked up, and only with the setting on', () => {
    const unsorted = item('t1');
    const grouped = item('t2', { groupId: 'tv' });
    const local = item('t3', { url: 'http://localhost:3000/severance', title: 'Severance' });
    const sensitive = item('t4', { url: 'https://www.google.com/search?q=my+bank+login', title: 'my bank login - Google Search' });
    expect(lookupOffer(unsorted)).not.toBeNull();
    const onAction = grid([unsorted, grouped, local, sensitive], true);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => within(r).queryByRole('button', { name: 'Look it up' }) !== null)).toEqual([true, false, false, false]);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Look it up' }));
    expect(onAction).toHaveBeenCalledWith('lookup', unsorted);
    cleanup();
    grid([unsorted], false);
    expect(screen.queryByRole('button', { name: 'Look it up' })).toBeNull();
    // Showing the button sends nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  const state = (settings: SettingsT, items: Item[]): DashboardState => ({
    items, groups: GROUPS, dupCount: 0, windows: 1, sleeping: 0, suspicious: [],
    syncStatus: { ok: true, synced: 0, localOnly: 0, lastSyncAt: null }, modelReady: true, queued: 0, activeTabIds: [], settings,
  });
  it('side panel: on Unsorted rows with the setting on; opens the dialog; off hides it', async () => {
    const items = [item('t1'), item('t2', { groupId: 'tv', title: 'Severance season 2' })];
    sendMock.mockImplementation(async (req) => (req.t === 'state' ? state(DEFAULT_SETTINGS, items) : undefined) as never);
    render(<SidePanel />);
    await screen.findByRole('region', { name: /This window/ });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Look it up' })).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Look it up' }));
    expect(box().value).toBe((lookupText(GOOGLE, GOOGLE_TITLE) as { text: string }).text);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    cleanup();
    sendMock.mockImplementation(async (req) => (req.t === 'state' ? state({ ...DEFAULT_SETTINGS, lookupButton: false }, items) : undefined) as never);
    render(<SidePanel />);
    await screen.findByRole('region', { name: /This window/ });
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: 'Look it up' })).toBeNull();
  });
});

describe('the dialog', () => {
  it('says what is sent, what never is, and links Wikimedia’s privacy policy', () => {
    open();
    expect(LOOKUP_DIALOG_SENTENCE).toBe('Tablight will send this text to Wikidata (Wikimedia Foundation) and nothing else:');
    const d = dialog();
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(within(d).getByText(LOOKUP_DIALOG_SENTENCE)).toBeTruthy();
    const text = (lookupText(GOOGLE, GOOGLE_TITLE) as { text: string }).text;
    expect(text).not.toBe('');
    expect(box().value).toBe(text);
    expect(within(d).getByText('Never sent: the page address, your other tabs, cookies, or any ID.')).toBeTruthy();
    const link = within(d).getByRole('link', { name: /privacy policy/ });
    expect(link.getAttribute('href')).toBe('https://foundation.wikimedia.org/wiki/Policy:Privacy_policy');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // The order: sentence, box, note, link, then the buttons.
    const html = d.innerHTML;
    const at = (s: string) => html.indexOf(s);
    expect(at('Tablight will send')).toBeLessThan(at('<input'));
    expect(at('<input')).toBeLessThan(at('Never sent'));
    expect(at('Never sent')).toBeLessThan(at('foundation.wikimedia.org'));
    expect(at('foundation.wikimedia.org')).toBeLessThan(at('>Cancel<'));
    expect(at('foundation.wikimedia.org')).toBeLessThan(at('>Look up<'));
    expect(document.activeElement).toBe(box());
  });
  it('Cancel and Escape send nothing', () => {
    const onClose = open();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookUpMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
  it('keeps focus inside (Tab wraps)', () => {
    open();
    const look = within(dialog()).getByRole('button', { name: 'Look up' });
    look.focus();
    fireEvent.keyDown(look, { key: 'Tab' });
    expect(document.activeElement).toBe(box());
    fireEvent.keyDown(box(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(look);
  });
  it('Look up is disabled while the cleaned text is empty', () => {
    open();
    fireEvent.input(box(), { target: { value: '   https://example.com/x  user@example.com ' } });
    expect((within(dialog()).getByRole('button', { name: 'Look up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(box(), { target: { value: 'Severance' } });
    expect((within(dialog()).getByRole('button', { name: 'Look up' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('Look up sends the edited text, cleaned again, once; hits render as text', async () => {
    open();
    fireEvent.input(box(), { target: { value: 'Severance  mail me at someone@example.com' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Look up' }));
    await within(dialog()).findByRole('list', { name: 'Matches' });
    expect(lookUpMock).toHaveBeenCalledTimes(1);
    expect(lookUpMock.mock.calls[0]![0]).toBe('Severance mail me at');
    expect(box().value).toBe('Severance mail me at');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('search')).toBe('Severance mail me at');
    const hits = within(within(dialog()).getByRole('list', { name: 'Matches' })).getAllByRole('listitem');
    expect(hits).toHaveLength(3);
    expect(hits[1]!.textContent).toContain(XSS);
    expect(dialog().querySelector('img')).toBeNull();
    expect(within(hits[0]!).getByRole('button', { name: 'Move to TV Series' })).toBeTruthy();
    // A topic with no group yet: the starter group can be created.
    expect(within(hits[1]!).getByRole('button', { name: 'Create Anime & comics and move' })).toBeTruthy();
    // Neither group nor topic: no action.
    expect(within(hits[2]!).queryByRole('button')).toBeNull();
    expect(moves()).toEqual([]);
  });
  it('"Move to" moves the tab with the user move, then closes', async () => {
    const onClose = open();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Look up' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Move to TV Series' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(moves()).toEqual([{ t: 'moveItems', ids: ['t1'], groupId: 'tv' }]);
  });
  it('a missing starter group is created first, then the tab moves into it', async () => {
    const onClose = open();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Look up' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Create Anime & comics and move' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(moves()).toEqual([
      // Every existing group is listed too, so a first answer on a fresh install removes nothing.
      { t: 'interests', picked: ['anime', 'tv', 'programming'], custom: [] },
      { t: 'moveItems', ids: ['t1'], groupId: 'anime' },
    ]);
  });
  it('a failed move says so and closes nothing', async () => {
    const onClose = open();
    sendMock.mockRejectedValue(new Error('unknown group'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Look up' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Move to TV Series' }));
    await within(dialog()).findByText('Couldn’t move the tab.');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('errors are plain messages and move nothing; 0 hits say "No matches"', async () => {
    const cases: [() => Promise<Response>, string][] = [
      [async () => { throw new TypeError('Failed to fetch'); }, 'You seem to be offline.'],
      [async () => new Response('nope', { status: 503 }), 'Wikidata returned an error.'],
      [async () => new Response('{not json', { status: 200 }), 'Couldn\'t read Wikidata\'s answer.'],
      [async () => reply([]), 'No matches'],
    ];
    for (const [i, [impl, message]] of cases.entries()) {
      fetchSpy.mockImplementationOnce(impl);
      open();
      fireEvent.input(box(), { target: { value: `Severance case ${'abcd'[i]}` } });
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Look up' }));
      expect(await within(dialog()).findByText(message)).toBeTruthy();
      expect(within(dialog()).queryByRole('list', { name: 'Matches' })).toBeNull();
      cleanup();
    }
    expect(moves()).toEqual([]);
  });
  it('a timeout says Wikidata didn’t answer in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchSpy.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }));
      open();
      fireEvent.input(box(), { target: { value: 'Severance slow' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Look up' }));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await within(dialog()).findByText('Wikidata didn\'t answer in time.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the setting', () => {
  it('defaults to on; settings stored before it read as on', async () => {
    expect(DEFAULT_SETTINGS.lookupButton).toBe(true);
    const name = 'lookup-old-settings';
    const db = await openDb(name);
    const old: Partial<SettingsT> = { ...DEFAULT_SETTINGS, theme: 'dark' };
    delete old.lookupButton;
    const raw = await openDB(name);
    await raw.put('settings', old, 'main');
    raw.close();
    expect(await db.settings.get()).toMatchObject({ theme: 'dark', lookupButton: true });
  });
  it('Settings → "Show the Look it up button" with its hint', () => {
    const save = vi.fn(async () => undefined);
    render(
      <Settings
        settings={DEFAULT_SETTINGS} syncStatus={{ ok: true, synced: 0, localOnly: 0, lastSyncAt: null }} busy={false}
        save={save} act={async (fn) => fn()} notify={vi.fn()} onDeleteAll={vi.fn()} tab="general" onTab={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('checkbox', { name: 'Show the Look it up button' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(LOOKUP_SETTING_HINT).toBe('Sends only the text you confirm, to Wikidata. Nothing is sent unless you click.');
    const hint = screen.getByText(LOOKUP_SETTING_HINT);
    expect(hint.hidden).toBe(false);
    expect(toggle.closest('.setting-row')!.getAttribute('aria-describedby')).toContain(hint.id);
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith({ lookupButton: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
