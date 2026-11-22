import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import { openDashboard } from '../../shared/nav';
import type { GroupSummary, Item } from '../../shared/types';
import { ItemRow } from '../common/ItemRow';
import { LookItUpButton, LookupDialog, lookupOffer } from '../common/LookupDialog';
import { displayTitle, plural } from '../common/format';
import { CloseIcon, GridIcon, LogoMark, PauseIcon, PlayIcon, SearchIcon, StashIcon } from '../common/icons';
import { applyTheme } from '../common/theme';
import { useDashboardState } from '../common/useDashboardState';
import { MAX_QUERY, useSearch } from '../common/useSearch';
import { useUndo } from '../common/useUndo';
import { useGrownNotice } from '../common/useGrownNotice';
import { hintOnce } from '../common/hints';
import { InlineCloseConfirm, SUSPICIOUS_INTRO, SuspiciousRows } from '../common/Suspicious';
import { SearchResultsView, totalsLine } from '../popup/Popup';
import { regularGroups, windowNumbers } from '../dashboard/views';
import { GroupMark } from '../common/GroupChip';
import { PriorityButton, canPrioritize } from '../common/PriorityButton';
import { PRIORITY_GROUP_ID, PRIORITY_NAME } from '../../shared/priority';

/** Section ids that are expanded, kept per browser profile (a convenience: losing it is harmless). */
const OPEN_KEY = 'sidepanel.open';
const WINDOW_SECTION = 'window';
const UNSORTED_SECTION = 'unsorted';
/** The Priority group's section (listed first, open by default). */
const PRIORITY_SECTION = `group:${PRIORITY_GROUP_ID}`;
/** A section never renders more rows than this; the dashboard has the full list. */
const MAX_ROWS = 300;
/** Suspicious rows shown before "Show all (N)", so the window list stays in view. */
const SUS_ROWS = 3;

function loadOpen(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null');
    if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === 'string').slice(0, 100));
  } catch {
    /* unavailable or corrupt: defaults */
  }
  return new Set([WINDOW_SECTION, PRIORITY_SECTION]);
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
  const search = useSearch(undefined, state);
  const { notice, notify, undo } = useUndo();
  useGrownNotice(state, { notice, notify });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<number | null>(null);
  const [order, setOrder] = useState<Map<number, number>>(new Map());
  const [open, setOpen] = useState<Set<string>>(loadOpen);
  const [confirmClose, setConfirmClose] = useState(false);
  /** The group whose "Close all tabs" confirmation is open, if any. */
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  // The Suspicious section is open by default (not remembered: new suspicious tabs should be seen).
  const [susOpen, setSusOpen] = useState(true);
  const [susAll, setSusAll] = useState(false);
  const closeAllBtn = useRef<HTMLButtonElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  /** The Unsorted tab whose "Look it up" dialog is open. */
  const [lookupItem, setLookupItem] = useState<Item | null>(null);
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
    // Remove from the same event object it was added to: the cleanup can run after the page (or a test)
    // has let go of the global `chrome`.
    const activated = chrome.tabs.onActivated;
    activated.addListener(onActivated);
    return () => activated.removeListener(onActivated);
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
  const runUndo = async () => {
    try {
      notify((await undo()) ? 'Undone' : 'Too late to undo');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
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
      if (r.slept) notify(`Paused ${plural(r.slept, 'tab')}`, undefined, hintOnce('pause'));
      else notify('Nothing to pause right now');
    });
  const stash = (item: Item) =>
    act(async () => {
      const r = await send<{ token: string; skipped: number }>({ t: 'stash', ids: [item.id] });
      if (r.skipped) notify('That tab can’t be saved for later');
      else notify('Saved 1 tab for later', r.token, hintOnce('save'));
    });
  const closeIds = (ids: string[]) =>
    act(async () => {
      const r = await send<{ token: string; closed: number }>({ t: 'close', ids });
      notify(`Closed ${plural(r.closed, 'tab')}`, r.closed ? r.token : undefined);
    });
  const close = (item: Item) => closeIds([item.id]);
  const keep = (item: Item) => act(async () => void (await send({ t: 'keepTab', id: item.id })));
  const prioritize = (item: Item, on: boolean) => {
    // Un-starring from the Priority section takes the row (and the focused star) away: focus its heading, or this
    // window's once the section is gone.
    const fromSection = !on && document.activeElement?.closest(`[aria-labelledby="sp-h-${PRIORITY_SECTION}"]`) != null;
    return act(async () => {
      const n = await send<number>({ t: 'prioritize', ids: [item.id], on });
      if (n) notify(on ? `Added to ${PRIORITY_NAME}` : `Removed from ${PRIORITY_NAME}`);
    }).then(() => {
      if (!fromSection) return;
      setTimeout(() => (document.getElementById(`sp-h-${PRIORITY_SECTION}`) ?? document.getElementById(`sp-h-${WINDOW_SECTION}`))?.focus(), 0);
    });
  };

  const items = state?.items ?? [];
  const groups = useMemo(() => new Map((state?.groups ?? []).map((g) => [g.id, g])), [state]);
  const thisWindow = useMemo(
    () => items
      .filter((i) => windowId !== null && i.windowId === windowId && hasTab(i))
      .sort((a, b) => (order.get(a.tabId!) ?? Infinity) - (order.get(b.tabId!) ?? Infinity)),
    [items, windowId, order],
  );
  // Priority first, above this window's tabs (shown while it has tabs); then the other groups by size.
  const priorityGroup = regularGroups(state?.groups ?? []).find((g) => g.id === PRIORITY_GROUP_ID);
  const shownGroups = (state?.groups ?? []).filter((g) => g.count > 0 && g.id !== PRIORITY_GROUP_ID)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const unsorted = items.filter((i) => i.groupId === null && hasTab(i)).sort(byUse);
  const suspicious = state?.suspicious ?? [];
  // Nothing left to close (closed elsewhere, or kept): drop a pending confirmation with the section.
  useEffect(() => {
    if (!suspicious.length) setConfirmClose(false);
  }, [suspicious.length]);
  const cancelCloseAll = () => {
    setConfirmClose(false);
    setTimeout(() => closeAllBtn.current?.focus(), 0);
  };
  const windowNo = useMemo(() => windowNumbers(items), [items]);
  const susShown = susAll ? suspicious : suspicious.slice(0, SUS_ROWS);
  // Same heading as the other sections (chevron, name, count on the right); the name read out keeps the count.
  const suspiciousSection = suspicious.length > 0 && (
    <section key="suspicious" class="sp-section sp-suspicious" aria-labelledby="sp-h-suspicious" role="region">
      <button
        type="button" id="sp-h-suspicious" class="sp-head" aria-expanded={susOpen} aria-label={`Suspicious (${suspicious.length})`}
        onClick={() => setSusOpen(!susOpen)}
      >
        <svg class="sp-chevron" viewBox="0 0 16 16" aria-hidden="true" style={{ transform: susOpen ? 'rotate(90deg)' : 'none' }}>
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="sp-name">Suspicious</span>
        <span class="sp-count">{suspicious.length}</span>
      </button>
      {susOpen && (
        <>
          <p class="sp-intro">{SUSPICIOUS_INTRO}</p>
          <SuspiciousRows
            list={susShown} label="Suspicious tabs" busy={busy} windowNo={windowNo}
            groupOf={(i) => (i.groupId !== null ? groups.get(i.groupId) : undefined)}
            onGo={(s) => void openItem(s.item)} onKeep={(s) => void keep(s.item)} onClose={(s) => void close(s.item)}
          />
          <div class="sp-sus-actions">
            {suspicious.length > SUS_ROWS && (
              <button type="button" class="btn btn-ghost btn-sm" aria-expanded={susAll} onClick={() => setSusAll(!susAll)}>
                {susAll ? 'Show fewer' : `Show all (${suspicious.length})`}
              </button>
            )}
            <button
              ref={closeAllBtn} type="button" class="btn btn-sm" disabled={busy || confirmClose}
              onClick={() => setConfirmClose(true)}
            >
              <CloseIcon />{`Close all (${suspicious.length})`}
            </button>
          </div>
          {confirmClose && (
            <InlineCloseConfirm
              titles={suspicious.map((s) => displayTitle(s.item))} busy={busy}
              onCancel={cancelCloseAll}
              onConfirm={() => {
                setConfirmClose(false);
                void closeIds(suspicious.map((s) => s.item.id));
              }}
            />
          )}
        </>
      )}
    </section>
  );
  const lookupOn = state?.settings.lookupButton === true;
  const row = (i: Item, showGroup: boolean) => {
    const g = showGroup && i.groupId !== null ? groups.get(i.groupId) : undefined;
    const active = i.tabId !== undefined && i.tabId === activeTab;
    return (
      <ItemRow
        key={i.id} item={i} onOpen={() => void openItem(i)} {...(g ? { group: g } : {})}
        rowProps={{ class: active ? 'is-active' : '', ...(active ? { 'aria-current': 'page' } : {}) } as never}
        actions={
          <>
            {lookupOn && lookupOffer(i) !== null && <LookItUpButton item={i} disabled={busy} onClick={setLookupItem} />}
            {canPrioritize(i) && <PriorityButton item={i} disabled={busy} onToggle={(it, on) => void prioritize(it, on)} />}
            {i.state === 'open' && i.classifiable && !active && (
              <button type="button" class="icon-btn" aria-label="Pause" title="Pause: frees its memory, stays in your tab strip" disabled={busy} onClick={() => void sleep([i.id])}>
                <PauseIcon />
              </button>
            )}
            {hasTab(i) && i.classifiable && (
              <button type="button" class="icon-btn" aria-label="Save for later" title="Save for later: closes the tab and keeps it in Saved for later" disabled={busy} onClick={() => void stash(i)}>
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
    const g = opts.group;
    // A group's open and paused tabs, in every window (its saved-for-later tabs stay).
    const closable = g ? list.filter(hasTab) : [];
    return (
      <section key={id} class="sp-section" aria-labelledby={headId} role={expanded ? 'region' : undefined}>
        <div class="sp-head-row">
        <button type="button" id={headId} class="sp-head" aria-expanded={expanded} onClick={() => toggle(id)}>
          <svg class="sp-chevron" viewBox="0 0 16 16" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {opts.group && <GroupMark group={opts.group} />}
          <span class="sp-name">{title}</span>
          {opts.group && opts.group.watchCount > 0 && (
            <span class="watch" title={`${opts.group.watchCount} to watch`}><PlayIcon />{opts.group.watchCount}</span>
          )}
          <span class="sp-count">{count}</span>
        </button>
        {g && closable.length > 0 && (
          // Like a tab row's buttons: shown on hover or keyboard focus.
          <span class="sp-head-actions">
            <button
              type="button" class="icon-btn" aria-label={`Close all tabs in ${title}`} title="Close all tabs in this group"
              disabled={busy} onClick={() => setConfirmGroup(g.id)}
            >
              <CloseIcon />
            </button>
          </span>
        )}
        </div>
        {g && confirmGroup === g.id && closable.length > 0 && (
          <InlineCloseConfirm
            title={`Close ${plural(closable.length, 'tab')} in ${title}?`}
            body="Saved-for-later tabs in this group stay. You can undo for 10 seconds."
            titles={closable.map((i) => displayTitle(i))} busy={busy}
            onCancel={() => setConfirmGroup(null)}
            onConfirm={() => {
              setConfirmGroup(null);
              void closeIds(closable.map((i) => i.id));
            }}
          />
        )}
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
    <>
      <div class="sp" inert={lookupItem ? true : undefined}>
        <header class="sp-top">
          <div class="brand">
            <LogoMark />
            <span class="brand-name">Tablight</span>
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
            ref={searchBox} type="search" aria-label="Search tabs" placeholder="Search tabs, saved tabs and groups"
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
              {suspiciousSection}
              {priorityGroup && section(PRIORITY_SECTION, priorityGroup.name,
                items.filter((i) => i.groupId === PRIORITY_GROUP_ID).sort(byUse), { group: priorityGroup, count: priorityGroup.count })}
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
            {notice && (
              <span class="notice-text">
                {notice.message}
                {notice.hint && <span class="notice-hint">{notice.hint}</span>}
              </span>
            )}
            {(notice?.token || notice?.undoRequest) && (
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => void runUndo()}>Undo</button>
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
              <PauseIcon />Pause other tabs
            </button>
          </div>
        </footer>
      </div>
      {lookupItem && (
        <LookupDialog
          item={lookupItem} groups={state?.groups ?? []}
          onClose={(moved) => {
            setLookupItem(null);
            // The moved row leaves Unsorted with the next refresh, taking focus with it: start again from the Unsorted
            // heading, or the search box once Unsorted is gone.
            if (moved) setTimeout(() => (document.getElementById(`sp-h-${UNSORTED_SECTION}`) ?? searchBox.current)?.focus(), 0);
          }}
        />
      )}
    </>
  );
}
