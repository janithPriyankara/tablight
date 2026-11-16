import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { DashboardState, GroupSummary, Item, SyncStatus } from '../../shared/types';
import { GroupDot } from '../common/GroupChip';
import { ItemRow } from '../common/ItemRow';
import { ago, displayTitle, plural } from '../common/format';
import { CloseIcon, CopyIcon, GridIcon, LogoMark, PanelIcon, PauseIcon, SearchIcon, StashIcon, SwitchIcon } from '../common/icons';
import { openDashboard } from '../../shared/nav';
import { applyTheme } from '../common/theme';
import { useDashboardState } from '../common/useDashboardState';
import { MAX_QUERY, useSearch } from '../common/useSearch';
import { useUndo } from '../common/useUndo';
import { hintOnce } from '../common/hints';

const TOP_GROUPS = 6;

/** "214 tabs · 6 windows · 31 paused · 12 duplicates": tabs are open + sleeping items. */
export function totalsLine(s: DashboardState): string {
  const tabs = s.items.filter((i) => i.state !== 'stashed').length;
  return [
    plural(tabs, 'tab'), plural(s.windows, 'window'), `${s.sleeping} paused`, plural(s.dupCount, 'duplicate'),
  ].join(' · ');
}
function syncLine(s: SyncStatus): string {
  if (s.ok) return s.lastSyncAt === null ? 'Saved tabs not synced yet' : `Saved tabs synced ${ago(s.lastSyncAt)}`;
  switch (s.reason) {
    case 'disabled': return 'Sync is off';
    case 'quota': return 'Sync full · saved tabs kept on this device';
    case 'rate': return 'Sync paused for a moment';
    default: return 'Sync failed · will retry';
  }
}
const isWebOpen = (i: Item) => i.state === 'open' && i.classifiable && i.tabId !== undefined;

export function Popup() {
  const { state, error, refresh } = useDashboardState();
  const search = useSearch(undefined, state);
  // Popup actions that can be undone close the popup; their Undo lives in the dashboard (Stash this window).
  const { notice, notify } = useUndo();
  const [busy, setBusy] = useState(false);
  // The ref guards re-entry synchronously (a fast double click lands before the re-render disables buttons).
  const busyRef = useRef(false);
  const theme = state?.settings?.theme;
  useEffect(() => applyTheme(theme), [theme]);
  // The side panel must open inside the click (it needs the user gesture), so the window id is read up front.
  const hasPanel = typeof chrome.sidePanel?.open === 'function';
  const [windowId, setWindowId] = useState<number | null>(null);
  useEffect(() => {
    if (hasPanel) chrome.windows.getCurrent().then((w) => setWindowId(w.id ?? null), () => undefined);
  }, [hasPanel]);
  const openPanel = () => {
    if (windowId === null) return;
    chrome.sidePanel.open({ windowId }).catch(() => undefined);
    window.close();
  };

  /** Runs an action, reports failures in the notice bar, then re-reads the state. */
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
  const openItem = (item: Item) =>
    act(async () => {
      await send({ t: 'open', id: item.id });
      window.close();
    });
  /**
   * The background opens the dashboard in this window first (so the window never closes), stashes the
   * rest, and the dashboard shows the Undo. The popup closes once the dashboard tab takes focus.
   */
  const stashWindow = () =>
    act(async () => {
      const win = await chrome.windows.getCurrent();
      if (win.id === undefined) return;
      const r = await send<{ token: string | null; stashed: number }>({ t: 'stashWindow', windowId: win.id });
      if (!r.stashed) return notify('No web tabs to save in this window');
      window.close();
    });
  const sleepInactive = () =>
    act(async () => {
      const ids = (state?.items ?? []).filter(isWebOpen).map((i) => i.id);
      const r = await send<{ slept: number; skipped: number }>({ t: 'sleep', ids });
      if (r.slept) notify(`Paused ${plural(r.slept, 'tab')}`, undefined, hintOnce('pause'));
      else notify('Nothing to pause right now');
    });
  /** Closing the active tab closes the popup with it, so no Undo is offered (it could never be clicked). */
  const closeThis = (item: Item) =>
    act(async () => {
      await send({ t: 'close', ids: [item.id] });
      window.close();
    });
  const dashboard = (hash?: string) =>
    act(async () => {
      await openDashboard(hash);
      window.close();
    });

  return (
    <div class="popup">
      <header class="popup-head">
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

      {error && !state && (
        <div class="callout callout-error" role="alert">
          <span>Couldn’t load your tabs.</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {error && state && (
        <div class="callout callout-error" role="alert">
          <span>Couldn’t refresh: showing the last known tabs.</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {!state && !error && <p class="totals totals-loading" aria-busy="true">Counting tabs…</p>}
      {state && <p class="totals">{totalsLine(state)}</p>}

      {state?.activeDup && (
        <section class="dup-alert" role="region" aria-label="Duplicate tab">
          <CopyIcon class="dup-icon" />
          <div class="dup-text">
            <strong>This tab is open {state.activeDup.others.length + 1} times</strong>
            <span class="dup-title" title={displayTitle(state.activeDup.item)}>{displayTitle(state.activeDup.item)}</span>
          </div>
          <div class="dup-actions">
            <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void openItem(state.activeDup!.others[0]!)}>
              <SwitchIcon />Switch
            </button>
            <button type="button" class="btn btn-sm btn-ghost" disabled={busy} onClick={() => void closeThis(state.activeDup!.item)}>
              <CloseIcon />Close this one
            </button>
          </div>
        </section>
      )}

      <label class="search">
        <SearchIcon class="search-icon" />
        <input
          type="search" aria-label="Search tabs" placeholder="Search tabs, saved tabs and groups" autoFocus
          maxLength={MAX_QUERY} value={search.query} spellcheck={false} autocomplete="off"
          onInput={(e) => search.setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            const first = search.results?.words[0] ?? search.results?.meaning[0];
            // Only once the results match what was typed (no opening a stale result).
            if (e.key === 'Enter' && first && !search.pending) void openItem(first);
            if (e.key === 'Escape' && search.query) {
              e.preventDefault();
              search.setQuery('');
            }
          }}
        />
      </label>

      <main class="popup-body" aria-busy={search.pending}>
        {search.query.trim() ? (
          <SearchResultsView
            results={search.results} pending={search.pending} error={search.error} groups={state?.groups ?? []}
            onOpen={(i) => void openItem(i)}
          />
        ) : (
          state && <TopGroups groups={state.groups} onPick={(id) => void dashboard(`group=${encodeURIComponent(id)}`)} />
        )}
      </main>

      <footer class="popup-foot">
        <div class="notice" role="status" aria-live="polite">
          {notice && (
            <span class="notice-text">
              {notice.message}
              {notice.hint && <span class="notice-hint">{notice.hint}</span>}
            </span>
          )}
        </div>
        <div class={hasPanel ? 'actions has-panel' : 'actions'}>
          <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void dashboard()}>
            <GridIcon />Open dashboard
          </button>
          {hasPanel && (
            <button type="button" class="btn" disabled={windowId === null} onClick={openPanel} title="Keep Tab Organizer open beside your pages (Alt+Shift+S)">
              <PanelIcon />Side panel
            </button>
          )}
          <button type="button" class="btn" disabled={busy || !state} onClick={() => void stashWindow()}>
            <StashIcon />Save window for later
          </button>
          <button type="button" class="btn" disabled={busy || !state} onClick={() => void sleepInactive()}>
            <PauseIcon />Pause other tabs
          </button>
        </div>
        {state && <p class="sync-line">{syncLine(state.syncStatus)}</p>}
      </footer>
    </div>
  );
}

function TopGroups({ groups, onPick }: { groups: GroupSummary[]; onPick: (id: string) => void }) {
  const top = groups.filter((g) => g.count > 0).sort((a, b) => b.count - a.count).slice(0, TOP_GROUPS);
  if (!top.length) return <p class="empty">Your groups appear here once tabs are sorted.</p>;
  return (
    <section aria-labelledby="top-groups-h">
      <h2 class="section-h" id="top-groups-h">Top groups</h2>
      <ul class="group-grid" aria-label="Top groups">
        {top.map((g) => (
          <li key={g.id}>
            <button type="button" class="group-tile" title={`Open ${g.name} in the dashboard`} onClick={() => onPick(g.id)}>
              <span class="group-tile-top">
                <GroupDot color={g.color} />
                <span class="group-name">{g.name}</span>
                <span class="group-count">{g.count}</span>
              </span>
              {g.watchCount > 0 && <span class="watch">▶ {g.watchCount} to watch</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SearchResultsView(props: {
  results: { words: Item[]; meaning: Item[] } | null;
  pending: boolean;
  error: string | null;
  groups: GroupSummary[];
  onOpen: (item: Item) => void;
}) {
  const { results, pending, error, groups, onOpen } = props;
  if (error && !pending) return <p class="empty" role="alert">Search failed: {error}</p>;
  if (!results) return <p class="empty">{pending ? 'Searching…' : ''}</p>;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const row = (i: Item) => {
    const g = i.groupId !== null ? byId.get(i.groupId) : undefined;
    return <ItemRow key={i.id} item={i} onOpen={() => onOpen(i)} {...(g ? { group: g } : {})} />;
  };
  if (!results.words.length && !results.meaning.length) {
    return <p class="empty">{pending ? 'Searching…' : 'No matches'}</p>;
  }
  return (
    <>
      {results.words.length > 0 && <ul class="item-list" aria-label="Matches">{results.words.map(row)}</ul>}
      {results.meaning.length > 0 && (
        <section aria-labelledby="meaning-h">
          <h2 class="section-h" id="meaning-h">Similar by meaning</h2>
          <ul class="item-list">{results.meaning.map(row)}</ul>
        </section>
      )}
    </>
  );
}
