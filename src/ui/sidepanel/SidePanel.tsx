import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import { openDashboard } from '../../shared/nav';
import type { GroupSummary, Item } from '../../shared/types';
import { GroupDot } from '../common/GroupChip';
import { ItemRow } from '../common/ItemRow';
import { plural } from '../common/format';
import { CloseIcon, GridIcon, LogoMark, MoonIcon, SearchIcon, StashIcon } from '../common/icons';
import { applyTheme } from '../common/theme';
import { useDashboardState } from '../common/useDashboardState';
import { MAX_QUERY, useSearch } from '../common/useSearch';
import { useUndo } from '../common/useUndo';
import { SearchResultsView, totalsLine } from '../popup/Popup';

/** Section ids that are expanded, kept per browser profile (a convenience: losing it is harmless). */
const OPEN_KEY = 'sidepanel.open';
const WINDOW_SECTION = 'window';
const UNSORTED_SECTION = 'unsorted';
/** A section never renders more rows than this; the dashboard has the full list. */
const MAX_ROWS = 300;

function loadOpen(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null');
    if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === 'string').slice(0, 100));
  } catch {
    /* unavailable or corrupt: defaults */
  }
  return new Set([WINDOW_SECTION]);
}
function saveOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    /* storage blocked: the panel still works, it just won't remember */
  }
}

const hasTab = (i: Item) => i.state !== 'stashed' && i.tabId !== undefined;
/** Open tabs first (most recently used first), then sleeping, then stashed. */
const STATE_RANK: Record<Item['state'], number> = { open: 0, sleeping: 1, stashed: 2 };
const byUse = (a: Item, b: Item) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastActiveAt - a.lastActiveAt;

/**
 * The browser's side panel: this window's tabs, then every group (collapsible), with search. It stays
 * open beside the page, so picking a tab never closes it, and it follows tab changes as they happen.
 */
export function SidePanel() {
  const { state, error, refresh } = useDashboardState();
  const search = useSearch();
  const { notice, notify, undo } = useUndo();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<number | null>(null);
  const [order, setOrder] = useState<Map<number, number>>(new Map());
  const [open, setOpen] = useState<Set<string>>(loadOpen);
  const theme = state?.settings?.theme;
  useEffect(() => applyTheme(theme), [theme]);

  // The panel belongs to one window for its whole life.
  useEffect(() => {
    chrome.windows.getCurrent().then((w) => setWindowId(w.id ?? null), () => undefined);
  }, []);
  // Tab-strip order and the active tab, re-read whenever the index changes; activation is followed live.
  useEffect(() => {
    if (windowId === null) return;
    chrome.tabs.query({ windowId }).then((tabs) => {
      setOrder(new Map(tabs.flatMap((t) => (t.id === undefined ? [] : [[t.id, t.index] as const]))));
      setActiveTab(tabs.find((t) => t.active)?.id ?? null);
    }, () => undefined);
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId) setActiveTab(info.tabId);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, [windowId, state]);

  const act = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      busyRef.current = false;
      setBusy(false);
      await refresh();
    }
  };
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      saveOpen(next);
      return next;
    });
  const openItem = (item: Item) => act(async () => void (await send({ t: 'open', id: item.id })));
  const sleep = (ids: string[]) =>
    act(async () => {
      const r = await send<{ slept: number; skipped: number }>({ t: 'sleep', ids });
      notify(r.slept ? `Slept ${plural(r.slept, 'tab')}` : 'Nothing to sleep right now');
    });
  const stash = (item: Item) =>
    act(async () => {
      const r = await send<{ token: string; skipped: number }>({ t: 'stash', ids: [item.id] });
      if (r.skipped) notify('That tab couldn’t be stashed');
      else notify('Stashed 1 tab', r.token);
    });
  const close = (item: Item) =>
    act(async () => {
      const r = await send<{ token: string; closed: number }>({ t: 'close', ids: [item.id] });
      notify(`Closed ${plural(r.closed, 'tab')}`, r.closed ? r.token : undefined);
    });

  const items = state?.items ?? [];
  const groups = useMemo(() => new Map((state?.groups ?? []).map((g) => [g.id, g])), [state]);
  const thisWindow = useMemo(
    () => items
      .filter((i) => windowId !== null && i.windowId === windowId && hasTab(i))
      .sort((a, b) => (order.get(a.tabId!) ?? Infinity) - (order.get(b.tabId!) ?? Infinity)),
    [items, windowId, order],
  );
  const shownGroups = (state?.groups ?? []).filter((g) => g.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const unsorted = items.filter((i) => i.groupId === null && hasTab(i)).sort(byUse);

  const row = (i: Item, showGroup: boolean) => {
    const g = showGroup && i.groupId !== null ? groups.get(i.groupId) : undefined;
    const active = i.tabId !== undefined && i.tabId === activeTab;
    return (
      <ItemRow
        key={i.id} item={i} onOpen={() => void openItem(i)} {...(g ? { group: g } : {})}
        rowProps={{ class: active ? 'is-active' : '', ...(active ? { 'aria-current': 'page' } : {}) } as never}
        actions={
          <>
            {i.state === 'open' && i.classifiable && !active && (
              <button type="button" class="icon-btn" aria-label="Sleep" title="Sleep" disabled={busy} onClick={() => void sleep([i.id])}>
                <MoonIcon />
              </button>
            )}
            {hasTab(i) && i.classifiable && (
              <button type="button" class="icon-btn" aria-label="Stash" title="Stash (save and close)" disabled={busy} onClick={() => void stash(i)}>
                <StashIcon />
              </button>
            )}
            {hasTab(i) && (
              <button type="button" class="icon-btn" aria-label="Close" title="Close tab" disabled={busy} onClick={() => void close(i)}>
                <CloseIcon />
              </button>
            )}
          </>
        }
      />
    );
  };
  const section = (id: string, title: string, list: Item[], opts: { group?: GroupSummary; showGroup?: boolean; count?: number }) => {
    const expanded = open.has(id);
    const headId = `sp-h-${id}`;
    const count = opts.count ?? list.length;
    return (
      <section key={id} class="sp-section" aria-labelledby={headId} role={expanded ? 'region' : undefined}>
        <button type="button" id={headId} class="sp-head" aria-expanded={expanded} onClick={() => toggle(id)}>
          <svg class="sp-chevron" viewBox="0 0 16 16" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {opts.group && <GroupDot color={opts.group.color} />}
          <span class="sp-name">{title}</span>
          {opts.group && opts.group.watchCount > 0 && (
            <span class="watch" title={`${opts.group.watchCount} to watch`}>▶ {opts.group.watchCount}</span>
          )}
          <span class="sp-count">{count}</span>
        </button>
        {expanded && (
          list.length
            ? <ul class="item-list">{list.slice(0, MAX_ROWS).map((i) => row(i, !!opts.showGroup))}</ul>
            : <p class="empty sp-empty">No tabs here</p>
        )}
        {expanded && list.length > MAX_ROWS && (
          <button type="button" class="btn btn-ghost btn-sm sp-more" onClick={() => void openDashboard()}>
            Show all {list.length} in the dashboard
          </button>
        )}
      </section>
    );
  };

  return (
    <div class="sp">
      <header class="sp-top">
        <div class="brand">
          <LogoMark />
          <span class="brand-name">Tab Organizer</span>
        </div>
        {state && !state.modelReady && (
          <span class="status-pill" title="The on-device model is grouping your tabs">
            <span class="pulse" aria-hidden="true" />Organizing
          </span>
        )}
      </header>
      <label class="search">
        <SearchIcon class="search-icon" />
        <input
          type="search" aria-label="Search tabs" placeholder="Search tabs, stash and groups"
          maxLength={MAX_QUERY} value={search.query} spellcheck={false} autocomplete="off"
          onInput={(e) => search.setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            const first = search.results?.words[0] ?? search.results?.meaning[0];
            if (e.key === 'Enter' && first && !search.pending) void openItem(first);
            if (e.key === 'Escape' && search.query) {
              e.preventDefault();
              search.setQuery('');
            }
          }}
        />
      </label>
      {state && <p class="totals">{totalsLine(state)}</p>}
      {error && (
        <div class="callout callout-error" role="alert">
          <span>{state ? 'Couldn’t refresh: showing the last known tabs.' : 'Couldn’t load your tabs.'}</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      <main class="sp-body" aria-busy={search.pending}>
        {search.query.trim() ? (
          <SearchResultsView
            results={search.results} pending={search.pending} error={search.error} groups={state?.groups ?? []}
            onOpen={(i) => void openItem(i)}
          />
        ) : state ? (
          <>
            {section(WINDOW_SECTION, 'This window', thisWindow, { showGroup: true })}
            {shownGroups.map((g) =>
              section(`group:${g.id}`, g.name, items.filter((i) => i.groupId === g.id).sort(byUse), { group: g, count: g.count }))}
            {unsorted.length > 0 && section(UNSORTED_SECTION, 'Unsorted', unsorted, {})}
          </>
        ) : (
          !error && <p class="empty" aria-busy="true">Counting tabs…</p>
        )}
      </main>

      <footer class="sp-foot">
        <div class="notice" role="status" aria-live="polite">
          {notice && <span class="notice-text">{notice.message}</span>}
          {notice?.token && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => void undo().then(() => refresh())}>Undo</button>
          )}
        </div>
        <div class="sp-actions">
          <button type="button" class="btn btn-primary" onClick={() => void openDashboard()}>
            <GridIcon />Dashboard
          </button>
          <button
            type="button" class="btn" disabled={busy || !state}
            onClick={() => void sleep(items.filter((i) => i.state === 'open' && i.classifiable && i.tabId !== activeTab).map((i) => i.id))}
          >
            <MoonIcon />Sleep inactive
          </button>
        </div>
      </footer>
    </div>
  );
}
