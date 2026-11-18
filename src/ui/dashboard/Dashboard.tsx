import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SuspiciousTab } from '../../shared/clues';
import { send } from '../../shared/rpc';
import { LAST_SESSION_KEY, type GroupSummary, type Item, type Settings as SettingsT } from '../../shared/types';
import { GroupDot } from '../common/GroupChip';
import { displayTitle, plural } from '../common/format';
import {
  CloseIcon, CopyIcon, HelpIcon, LogoMark, MergeIcon, PauseIcon, PencilIcon, PlusIcon, SearchIcon, SparkIcon, StashIcon,
  SwitchIcon, TrashIcon,
} from '../common/icons';
import { applyTheme } from '../common/theme';
import { useDashboardState } from '../common/useDashboardState';
import { MAX_QUERY, useSearch } from '../common/useSearch';
import { useUndo } from '../common/useUndo';
import { hintOnce } from '../common/hints';
import { CLOSE_ALL_BODY, SUSPICIOUS_INTRO, SuspiciousRows, closeAllTitle } from '../common/Suspicious';
import { GroupList, ViewSelect } from './GroupList';
import { ItemGrid, type RowAction, type SelectMode } from './ItemGrid';
import { ConfirmDialog, type ConfirmOptions, Modal, NameDialog } from './Modal';
import { Onboarding } from './Onboarding';
import { LastSessionCard, type SessionActionKind, type SessionSummary, Sessions } from './Sessions';
import { Settings } from './Settings';
import { UndoToast } from './UndoToast';
import { Tour } from './Tour';
import { SideResizer, loadSideWidth } from './SideResizer';
import {
  type SettingsTab, type View, byDefaultOrder, itemsForView, lastCopies, parseHash, parseSettingsTab, parseUndoHash, settingsHash,
  viewHash, windowNumbers,
} from './views';

/** Opening more than this many tabs at once asks first (same bound as the background's open-all). */
export const OPEN_MANY_CONFIRM_ABOVE = 20;
/** The permanent catch-all group (the background refuses to delete it). */
const OTHER_GROUP_ID = 'other';
const VIEW_TITLE: Record<Exclude<View['kind'], 'group'>, string> = {
  all: 'All tabs', unsorted: 'Unsorted', duplicates: 'Duplicates', suspicious: 'Suspicious', stashed: 'Saved for later', sessions: 'Sessions', settings: 'Settings',
};
type RegroupRow = { groupId: string | null; before: number; after: number };
type Dialog =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'name'; title: string; initial?: string; confirmLabel: string; resolve: (name: string | null) => void }
  | { kind: 'merge'; from: GroupSummary }
  | { kind: 'regroup'; rows: RegroupRow[] };

const hasTab = (i: Item) => i.state !== 'stashed' && i.tabId !== undefined;
/** An empty id set that keeps its identity across renders. */
const NONE: ReadonlySet<string> = new Set();
const isStashed = (i: Item) => i.state === 'stashed';
/** A tab that was never switched to (see Item.opened). */
const isNewTab = (i: Item) => i.state !== 'stashed' && i.opened === false;
const isWebOpen = (i: Item) => i.state === 'open' && i.classifiable && i.tabId !== undefined;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function Dashboard() {
  const { state, error, refresh } = useDashboardState();
  const search = useSearch(undefined, state);
  const { notice, notify, undo, dismiss } = useUndo();
  const [view, setViewState] = useState<View>(() => parseHash(location.hash));
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => parseSettingsTab(location.hash));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [sideWidth, setSideWidth] = useState(loadSideWidth);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const dragIds = useRef<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [touring, setTouring] = useState(false);
  const [pendingSettings, setPendingSettings] = useState<Partial<SettingsT> | null>(null);
  const [lastSessionHidden, setLastSessionHidden] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const moveSelect = useRef<HTMLSelectElement>(null);

  const settings: SettingsT | null = state ? { ...state.settings, ...pendingSettings } : null;
  const theme = settings?.theme;
  useEffect(() => applyTheme(theme), [theme]);

  // Routing: #group=<id> / #view=<name>, also changed by the popup's links. "Stash this window" adds an
  // undo token: show its Undo once, then drop it from the address (a reload must not offer it again).
  useEffect(() => {
    const takeUndo = () => {
      const u = parseUndoHash(location.hash);
      if (!u) return;
      history.replaceState(null, '', `#${viewHash(parseHash(location.hash))}`);
      notify(`Saved ${plural(u.n, 'tab')} for later`, u.token, hintOnce('save'));
    };
    const onHash = () => {
      setViewState(parseHash(location.hash));
      setSettingsTab(parseSettingsTab(location.hash));
      takeUndo();
    };
    takeUndo();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [view.kind, view.kind === 'group' ? view.id : '']);
  /** The tour runs over All tabs (so there are tab rows to point at), with the search cleared. */
  const startTour = () => {
    search.setQuery('');
    go({ kind: 'all' });
    setTouring(true);
  };
  const endTour = () => {
    setTouring(false);
    if (settings && !settings.onboarded) void act(() => save({ onboarded: true }));
  };
  const go = (v: View) => {
    search.setQuery('');
    setNewOnly(false);
    setViewState(v);
    if (v.kind === 'settings') setSettingsTab('general');
    const hash = `#${viewHash(v)}`;
    if (location.hash !== hash) location.hash = hash;
  };

  // "/" focuses search from anywhere but a text field or an open dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      searchBox.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const groups = state?.groups ?? [];
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const items = state?.items ?? [];
  const windowNo = useMemo(() => windowNumbers(items), [items]);
  const searching = search.query.trim().length > 0;
  const results = search.results;
  const meaningIds = useMemo(() => new Set(results?.meaning.map((i) => i.id) ?? []), [results]);
  // Pages the Duplicates view has listed since it was opened (see lastCopies); forgotten on leaving the view.
  const dupSeen = useRef(new Set<string>());
  const [fullList, lastCopyIds] = useMemo((): [Item[], ReadonlySet<string>] => {
    if (searching) return [results ? [...results.words, ...results.meaning] : [], NONE];
    const out = itemsForView(view, items, groups);
    if (view.kind !== 'duplicates') {
      dupSeen.current = new Set();
      return [out, NONE];
    }
    for (const i of out) dupSeen.current.add(i.normUrl);
    const left = lastCopies(out, items, dupSeen.current);
    if (!left.length) return [out, NONE];
    const all = [...out, ...left].sort((a, b) => a.normUrl.localeCompare(b.normUrl) || byDefaultOrder(a, b));
    return [all, new Set(left.map((i) => i.id))];
  }, [searching, results, view, items, groups]);
  // "New" = tabs that were never switched to. "Show new only" narrows the current view to them.
  const newCount = useMemo(() => (searching ? 0 : fullList.filter(isNewTab).length), [searching, fullList]);
  const [newOnly, setNewOnly] = useState(false);
  const showNewOnly = newOnly && newCount > 0 && !searching;
  const list = useMemo(() => (showNewOnly ? fullList.filter(isNewTab) : fullList), [showNewOnly, fullList]);
  const byId = useMemo(() => new Map(list.map((i) => [i.id, i])), [list]);
  // The selection only ever holds items still listed (live updates remove closed tabs).
  const selection = useMemo(() => list.filter((i) => selected.has(i.id)), [list, selected]);
  const currentGroup = view.kind === 'group' ? groupMap.get(view.id) : undefined;

  /** The control that started the running action: focus goes back to it if it was lost meanwhile. */
  const opener = useRef<HTMLElement | null>(null);
  /**
   * Runs one action at a time (a ref guards double clicks), reports failures, then re-reads the state.
   * Controls are disabled while it runs, so a dialog closing then cannot hand focus back to its opener:
   * the effect below does that once the controls are enabled again.
   */
  const act = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
      await refresh();
    }
  };
  useEffect(() => {
    if (busy || dialog) return;
    const el = opener.current;
    opener.current = null;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (el?.isConnected && lost) el.focus();
  }, [busy, dialog]);
  const confirm = (opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', opts, resolve }));
  const askName = (title: string, confirmLabel: string, initial?: string) =>
    new Promise<string | null>((resolve) => setDialog({ kind: 'name', title, confirmLabel, initial, resolve }));
  /** Overlay keys whose value `s` does not hold yet (null when none are left). */
  const unreflected = (p: Partial<SettingsT> | null, s: SettingsT): Partial<SettingsT> | null => {
    if (!p) return null;
    const rest = Object.fromEntries(Object.entries(p).filter(([k, v]) => s[k as keyof SettingsT] !== v));
    return Object.keys(rest).length ? (rest as Partial<SettingsT>) : null;
  };
  /**
   * Shows a settings change at once (controls don't flick back). Each key of the overlay is dropped once
   * a state read reflects it; a refused or adjusted write drops its keys at once.
   */
  const save = async (patch: Partial<SettingsT>) => {
    setPendingSettings((p) => ({ ...p, ...patch }));
    const drop = (keys: string[]) =>
      setPendingSettings((p) => {
        if (!p) return p;
        const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !keys.includes(k)));
        return Object.keys(rest).length ? (rest as Partial<SettingsT>) : null;
      });
    try {
      const next = await send<SettingsT>({ t: 'settings', patch });
      drop(Object.keys(patch).filter((k) => next?.[k as keyof SettingsT] !== patch[k as keyof SettingsT]));
    } catch (e) {
      drop(Object.keys(patch));
      throw e;
    }
  };
  useEffect(() => {
    if (state) setPendingSettings((p) => unreflected(p, state.settings));
  }, [state]);

  /** Undo bypasses the busy guard: its 10 s window must not be lost to another action still running. */
  const runUndo = async () => {
    try {
      notify((await undo()) ? 'Undone' : 'Too late to undo');
    } catch (e) {
      notify(errorText(e));
    } finally {
      await refresh();
    }
  };
  // ── item actions ──
  const openItem = (item: Item) => act(() => send({ t: 'open', id: item.id }));
  const sleepIds = async (ids: string[]) => {
    const r = await send<{ slept: number; skipped: number }>({ t: 'sleep', ids });
    if (r.slept) notify(`Paused ${plural(r.slept, 'tab')}${r.skipped ? ` · ${r.skipped} skipped` : ''}`, undefined, hintOnce('pause'));
    else notify('Nothing to pause: the tab you’re on, pinned tabs and tabs playing sound keep running');
  };
  const stashIds = async (ids: string[]) => {
    const r = await send<{ token: string; skipped: number }>({ t: 'stash', ids });
    const stashed = ids.length - r.skipped;
    if (stashed > 0) notify(`Saved ${plural(stashed, 'tab')} for later`, r.token, hintOnce('save'));
    else notify('Nothing saved: those tabs can’t be saved for later');
  };
  const closeIds = async (ids: string[]) => {
    // The Duplicates view lists every copy, the original too: closing from it never closes the last copy of a page.
    const keepOne = view.kind === 'duplicates' && !searching;
    const r = await send<{ token: string; closed?: number; kept?: number }>({ t: 'close', ids, ...(keepOne ? { keepOne } : {}) });
    notify(`Closed ${plural(r.closed ?? ids.length, 'tab')}${r.kept ? ' · kept 1 copy of each page' : ''}`, r.token);
  };
  const removeIds = async (ids: string[]) => {
    const r = await send<{ token: string; deleted: number }>({ t: 'stashDelete', ids });
    notify(`Removed ${plural(r.deleted, 'saved tab')}`, r.deleted ? r.token : undefined);
    setSelected(new Set());
  };
  const moveIds = async (ids: string[], groupId: string) => {
    await send({ t: 'moveItems', ids, groupId });
    const g = groupMap.get(groupId);
    notify(`Moved ${plural(ids.length, 'tab')}${g ? ` to ${g.name}` : ''}`);
    setSelected(new Set());
  };
  const onRowAction = (action: RowAction, item: Item) => {
    if (action === 'move') {
      setSelected(new Set([item.id]));
      anchor.current = item.id;
      // The selection bar (with its "Move to…" menu) renders on the next frame.
      setTimeout(() => moveSelect.current?.focus(), 0);
      return;
    }
    void act(() => (action === 'sleep' ? sleepIds([item.id]) : action === 'stash' ? stashIds([item.id])
      : action === 'remove' ? removeIds([item.id]) : closeIds([item.id])));
  };
  const onDelete = (focused: Item) => {
    const targets = (selection.length ? selection : [focused]).filter(hasTab);
    if (targets.length) void act(() => closeIds(targets.map((i) => i.id)));
  };
  const select = (id: string, mode: SelectMode) => {
    setSelected((prev) => {
      if (mode === 'only') return new Set([id]);
      if (mode === 'range' && anchor.current && byId.has(anchor.current)) {
        const ids = list.map((i) => i.id);
        const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((x, y) => x - y) as [number, number];
        return new Set([...prev, ...ids.slice(a, b + 1)]);
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (mode !== 'range' || !anchor.current) anchor.current = id;
  };

  // ── selection bar ──
  const openSelection = () =>
    act(async () => {
      if (selection.length > OPEN_MANY_CONFIRM_ABOVE && !(await confirm({
        title: `Open ${selection.length} tabs?`, body: 'Each one starts loading, which can slow the browser down.',
        confirmLabel: `Open ${selection.length} tabs`,
      }))) return;
      for (const i of selection) await send({ t: 'open', id: i.id });
    });
  const newGroupFromSelection = () =>
    act(async () => {
      const name = await askName('New group', 'Create group');
      if (!name) return;
      const ids = selection.map((i) => i.id);
      const g = await send<GroupSummary>({ t: 'groupCreate', name, ids });
      notify(`Created ${g.name} with ${plural(ids.length, 'tab')}`);
      setSelected(new Set());
    });

  // ── drag and drop ──
  const onDragStart = (item: Item, e: DragEvent) => {
    const ids = selected.has(item.id) ? selection.map((i) => i.id) : [item.id];
    dragIds.current = ids;
    setDragging(true);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-tab-organizer-ids', JSON.stringify(ids));
    }
  };
  const onDropOn = (groupId: string) => {
    const ids = dragIds.current;
    dragIds.current = [];
    setDragging(false);
    if (ids.length) void act(() => moveIds(ids, groupId));
  };

  // ── toolbar ──
  const groupTargets = list.filter(isWebOpen);
  const stashView = () => act(() => stashIds(groupTargets.map((i) => i.id)));
  const sleepView = () => act(() => sleepIds(groupTargets.map((i) => i.id)));
  // A group's open and paused tabs in every window; its saved-for-later tabs stay.
  const groupTabs = list.filter(hasTab);
  const closeGroup = (g: GroupSummary) =>
    act(async () => {
      if (!(await confirm({
        title: `Close ${plural(groupTabs.length, 'tab')} in ${g.name}?`,
        body: 'Saved-for-later tabs in this group stay. You can undo for 10 seconds.',
        confirmLabel: 'Close tabs', danger: true,
      }))) return;
      await closeIds(groupTabs.map((i) => i.id));
    });
  const deleteAllData = () =>
    act(async () => {
      if (!(await confirm({
        title: 'Delete all data?',
        body: 'This deletes your groups, saved tabs, saved sessions and settings on this device, removes the synced copy of your saved tabs from your browser account, and turns sync off here so they can’t come back. Your other devices keep their own saved tabs. Open tabs stay open. This can’t be undone; export a backup first if you may need it.',
        confirmLabel: 'Delete all data', danger: true,
      }))) return;
      await send({ t: 'deleteAllData' });
      // The pages' own small conveniences (open side-panel sections, hints already shown) go too.
      try {
        localStorage.clear();
      } catch {
        /* storage unavailable: nothing stored there */
      }
      setPendingSettings(null);
      setSelected(new Set());
      notify('All data deleted');
    });
  const removeAllStashed = () =>
    act(async () => {
      const ids = list.filter(isStashed).map((i) => i.id);
      if (!ids.length) return;
      if (!(await confirm({
        title: `Remove ${plural(ids.length, 'saved tab')}?`,
        body: 'They’re removed from Saved for later here and, when sync is on, on your other devices. You can undo for 10 seconds.',
        confirmLabel: 'Remove all', danger: true,
      }))) return;
      await removeIds(ids);
    });
  const closeDuplicates = () =>
    act(async () => {
      const n = state?.dupCount ?? 0;
      if (!(await confirm({
        title: `Close ${plural(n, 'duplicate tab')}?`, body: 'The most recently used copy of each page stays open. You can undo for 10 seconds.',
        confirmLabel: 'Close duplicates', danger: true,
      }))) return;
      const r = await send<{ closed: number; token: string }>({ t: 'closeExtras' });
      notify(`Closed ${plural(r.closed, 'duplicate tab')}`, r.token);
    });
  // ── suspicious tabs ──
  const suspicious = state?.suspicious ?? [];
  const keepTab = (s: SuspiciousTab) => act(() => send({ t: 'keepTab', id: s.item.id }));
  const closeAllSuspicious = () =>
    act(async () => {
      const list = suspicious;
      if (!list.length) return;
      if (!(await confirm({
        title: closeAllTitle(list.length), items: list.map((s) => displayTitle(s.item)), body: CLOSE_ALL_BODY,
        confirmLabel: 'Close tabs', danger: true,
      }))) return;
      await closeIds(list.map((s) => s.item.id));
    });
  const regroup = () =>
    act(async () => {
      const rows = await send<RegroupRow[]>({ t: 'regroupPreview' });
      setDialog({ kind: 'regroup', rows });
    });
  const applyRegroup = () => {
    setDialog(null);
    void act(async () => {
      const n = await send<number>({ t: 'regroupApply' });
      notify(n ? `Re-grouped ${plural(n, 'tab')}` : 'Nothing needed to move');
    });
  };

  // ── groups ──
  const renameGroup = (g: GroupSummary) =>
    act(async () => {
      const name = await askName(`Rename ${g.name}`, 'Rename', g.name);
      if (name && name !== g.name) await send({ t: 'groupRename', id: g.id, name });
    });
  const deleteGroup = (g: GroupSummary) =>
    act(async () => {
      if (!(await confirm({
        title: `Delete ${g.name}?`, body: `Its ${plural(g.count, 'tab')} go back to Unsorted and are sorted again. Tabs are not closed.`,
        confirmLabel: 'Delete group', danger: true,
      }))) return;
      await send({ t: 'groupDelete', id: g.id });
      go({ kind: 'all' });
    });
  const acceptSuggestion = (id: string) => act(() => send({ t: 'acceptSuggestion', id }));
  const dismissSuggestion = (id: string) => act(() => send({ t: 'dismissSuggestion', id }));

  // ── sessions ──
  const sessionAction = (s: SessionSummary, action: SessionActionKind) =>
    act(async () => {
      if (action === 'delete' && !(await confirm({
        title: 'Delete this session?', body: `Its ${plural(s.tabs, 'tab')} are removed from the list. This can’t be undone.`,
        confirmLabel: 'Delete session', danger: true,
      }))) return;
      const r = await send<{ needsConfirm?: number }>({ t: 'sessionAction', id: s.id, action });
      if (r.needsConfirm !== undefined) {
        const n = r.needsConfirm;
        if (!(await confirm({
          title: `Open ${n} tabs?`, body: 'They open in a new window and all start loading. “Save all for later” keeps them without loading.',
          confirmLabel: `Open ${n} tabs`,
        }))) return;
        await send({ t: 'sessionAction', id: s.id, action, confirm: true });
      }
      if (action === 'stashAll') notify(`Saved the session’s ${plural(s.tabs, 'tab')} for later`, undefined, hintOnce('save'));
    });
  const snapshotNow = () =>
    act(async () => {
      const snap = await send<unknown>({ t: 'snapshotNow' });
      notify(snap ? 'Session saved' : 'No web tabs to save');
    });
  const dismissLastSession = () => {
    setLastSessionHidden(true);
    void chrome.storage.session.set({ [LAST_SESSION_KEY]: { snapshotId: null } }).catch(() => undefined);
  };

  // ── render ──
  const title = searching
    ? `Results for “${search.query.trim()}”`
    : view.kind === 'group' ? currentGroup?.name ?? 'Group not found' : VIEW_TITLE[view.kind];
  // Settings shows only its own controls: no welcome card and no list actions above it.
  const onSettings = view.kind === 'settings' && !searching;
  const isList = searching || (view.kind !== 'sessions' && view.kind !== 'settings' && view.kind !== 'suspicious');
  const counts = useMemo(() => ({
    all: items.length,
    unsorted: itemsForView({ kind: 'unsorted' }, items, groups).length,
    duplicates: state?.dupCount ?? 0,
    suspicious: suspicious.length,
    stashed: items.filter((i) => i.state === 'stashed').length,
  }), [items, groups, state?.dupCount, suspicious.length]);
  const subtitle = (() => {
    if (state && !searching && view.kind === 'suspicious') return suspicious.length ? plural(suspicious.length, 'suspicious tab') : '';
    if (!state || !isList) return '';
    if (searching) return search.pending ? 'Searching…' : plural(list.length, 'match', 'matches');
    if (view.kind === 'all') {
      const tabs = items.filter((i) => i.state !== 'stashed').length;
      return [plural(tabs, 'tab'), plural(state.windows, 'window'), `${state.sleeping} paused`, `${counts.stashed} saved`,
        newCount ? `${newCount} new` : ''].filter(Boolean).join(' · ');
    }
    if (view.kind === 'duplicates') return `${plural(state.dupCount, 'extra copy', 'extra copies')}`;
    const watch = currentGroup?.watchCount ?? 0;
    return [plural(fullList.length, 'item'), watch ? `${watch} to watch` : '', newCount ? `${newCount} new` : '']
      .filter(Boolean).join(' · ');
  })();
  const emptyText = (() => {
    if (searching) return search.pending ? 'Searching…' : 'No matches';
    switch (view.kind) {
      case 'unsorted': return 'Nothing unsorted: every tab has a group.';
      case 'duplicates': return 'No page is open more than once.';
      case 'stashed': return 'Nothing saved yet. “Save for later” closes a tab and keeps it here, so it uses no memory until you open it again.';
      case 'group': return currentGroup ? 'No tabs in this group yet. Drag tabs here to teach it.' : 'This group no longer exists.';
      default: return 'No tabs yet.';
    }
  })();
  const canGroupAct = !searching && (view.kind === 'group' || view.kind === 'unsorted');
  const moveTargets = groups.filter((g) => !g.suggested);

  return (
    <>
      <div class={dragging ? 'dash is-dragging' : 'dash'} inert={dialog ? true : undefined} style={{ '--side-w': `${sideWidth}px` }}>
        <aside class="dash-side">
          <div class="brand">
            <LogoMark />
            <span class="brand-name">Tablight</span>
          </div>
          <GroupList
            view={searching ? { kind: 'all' } : view} groups={groups} counts={counts} onView={go} dragging={dragging}
            onDropOn={onDropOn} onAccept={(id) => void acceptSuggestion(id)} onDismiss={(id) => void dismissSuggestion(id)} busy={busy}
          />
        </aside>
        <SideResizer width={sideWidth} onWidth={setSideWidth} />

        <main class="dash-main">
          <header class="dash-top">
            <ViewSelect view={view} groups={groups} onView={go} suspicious={suspicious.length} />
            <label class="search" data-tour="search">
              <SearchIcon class="search-icon" />
              <input
                ref={searchBox} type="search" aria-label="Search tabs" placeholder="Search tabs, saved tabs and groups  ( / )"
                maxLength={MAX_QUERY} value={search.query} spellcheck={false} autocomplete="off"
                onInput={(e) => search.setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && search.query) {
                    e.preventDefault();
                    search.setQuery('');
                  }
                  if (e.key === 'ArrowDown' && list.length) {
                    e.preventDefault();
                    document.querySelector<HTMLElement>('.grid-row .item-main')?.focus();
                  }
                }}
              />
            </label>
            <div class="toolbar">
              {view.kind === 'suspicious' && !searching && suspicious.length > 0 && (
                <button type="button" class="btn btn-sm" title="Close all suspicious tabs" disabled={busy} onClick={() => void closeAllSuspicious()}>
                  <CloseIcon />{`Close all (${suspicious.length})`}
                </button>
              )}
              {!onSettings && (
                <>
                  <button type="button" class="btn btn-sm" data-tour="close-duplicates" disabled={busy || !state?.dupCount} onClick={() => void closeDuplicates()}>
                    <CopyIcon />Close duplicates
                  </button>
                  <button type="button" class="btn btn-sm" disabled={busy || !state} onClick={() => void regroup()}>
                    <SparkIcon />Re-group everything
                  </button>
                </>
              )}
              <button type="button" class="icon-btn tour-open" aria-label="Guided tour" title="Guided tour" onClick={startTour}><HelpIcon /></button>
            </div>
          </header>

          {state && !state.modelReady && (
            <div class="banner" role="status">
              <span class="pulse" aria-hidden="true" />
              <span><strong>Grouping your tabs…</strong> The on-device model is sorting them. New tabs wait in Unsorted meanwhile.</span>
            </div>
          )}
          {error && !state && (
            <div class="callout callout-error page-callout" role="alert">
              <span>{`Couldn’t load your tabs: ${error}`}</span>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {error && state && (
            <div class="callout callout-error page-callout" role="alert">
              <span>{`Couldn’t refresh (${error}). Showing the last known tabs.`}</span>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {settings && !settings.onboarded && !onSettings && (
            <Onboarding
              busy={busy}
              onAutoSleep={() => void act(async () => {
                await save({ autoSleepMinutes: 60, onboarded: true });
                notify('Auto-pause is on: tabs unused for an hour will pause');
              })}
              onDone={() => void act(() => save({ onboarded: true }))}
              onTour={startTour}
            />
          )}

          <div class="view-head">
            <div class="view-title-row">
              {currentGroup && !searching && <GroupDot color={currentGroup.color} />}
              <h1 class="view-title">{title}</h1>
              {currentGroup?.suggested && !searching && <span class="status-pill">Suggested</span>}
            </div>
            {subtitle && (
              <p class="view-sub">
                <span>{subtitle}</span>
                {newCount > 0 && (
                  <button type="button" class="link view-filter" aria-pressed={showNewOnly} onClick={() => setNewOnly(!showNewOnly)}>
                    {showNewOnly ? 'Show all' : 'Show new only'}
                  </button>
                )}
              </p>
            )}
            <div class="view-actions">
              {view.kind === 'stashed' && !searching && list.length > 0 && (
                <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void removeAllStashed()}>
                  <TrashIcon />Remove all
                </button>
              )}
              {canGroupAct && (
                <>
                  <button type="button" class="btn btn-sm" disabled={busy || !groupTargets.length} onClick={() => void stashView()}>
                    <StashIcon />Save group for later
                  </button>
                  <button type="button" class="btn btn-sm" disabled={busy || !groupTargets.length} onClick={() => void sleepView()}>
                    <PauseIcon />Pause group
                  </button>
                  {currentGroup && (
                    <button type="button" class="btn btn-sm" disabled={busy || !groupTabs.length} onClick={() => void closeGroup(currentGroup)}>
                      <CloseIcon />Close group
                    </button>
                  )}
                </>
              )}
              {currentGroup && !searching && currentGroup.suggested && (
                <>
                  <button type="button" class="btn btn-sm btn-primary" disabled={busy} onClick={() => void acceptSuggestion(currentGroup.id)}>Accept group</button>
                  <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void dismissSuggestion(currentGroup.id)}>Dismiss</button>
                </>
              )}
              {currentGroup && !searching && !currentGroup.suggested && (
                <>
                  <button type="button" class="icon-btn" disabled={busy} aria-label="Rename group" title="Rename" onClick={() => void renameGroup(currentGroup)}>
                    <PencilIcon />
                  </button>
                  <button type="button" class="icon-btn" disabled={busy} aria-label="Merge group" title="Merge into…" onClick={() => setDialog({ kind: 'merge', from: currentGroup })}>
                    <MergeIcon />
                  </button>
                  {currentGroup.id !== OTHER_GROUP_ID && (
                    <button type="button" class="icon-btn" disabled={busy} aria-label="Delete group" title="Delete group" onClick={() => void deleteGroup(currentGroup)}>
                      <TrashIcon />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {isList && selection.length > 0 && (
            <div class="selection-bar" role="toolbar" aria-label="Selected tabs">
              <span class="selection-count">{`${selection.length} selected`}</span>
              <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void openSelection()}><SwitchIcon />Open</button>
              <button type="button" class="btn btn-sm" disabled={busy || !selection.some(isWebOpen)} onClick={() => void act(() => sleepIds(selection.filter(isWebOpen).map((i) => i.id)))}>
                <PauseIcon />Pause
              </button>
              <button type="button" class="btn btn-sm" disabled={busy || !selection.some((i) => hasTab(i) && i.classifiable)} onClick={() => void act(() => stashIds(selection.filter((i) => hasTab(i) && i.classifiable).map((i) => i.id)))}>
                <StashIcon />Save for later
              </button>
              <button type="button" class="btn btn-sm" disabled={busy || !selection.some(hasTab)} onClick={() => void act(() => closeIds(selection.filter(hasTab).map((i) => i.id)))}>
                <CloseIcon />Close
              </button>
              {selection.some(isStashed) && (
                <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void act(() => removeIds(selection.filter(isStashed).map((i) => i.id)))}>
                  <TrashIcon />Remove from Saved for later
                </button>
              )}
              <select
                ref={moveSelect} class="field field-inline field-sm" aria-label="Move selected tabs to group" value="" disabled={busy}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  if (id) void act(() => moveIds(selection.map((i) => i.id), id));
                }}
              >
                <option value="">Move to…</option>
                {moveTargets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void newGroupFromSelection()}><PlusIcon />New group</button>
              <button type="button" class="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}

          {!searching && view.kind === 'all' && state?.lastSession && !lastSessionHidden && (
            <LastSessionCard session={state.lastSession} busy={busy} onAction={sessionAction} onDismiss={dismissLastSession} />
          )}

          {!state && !error && <p class="empty" aria-busy="true">Loading your tabs…</p>}
          {state && searching && search.error && !search.pending && (
            <p class="callout callout-error page-callout" role="alert">{`Search failed: ${search.error}`}</p>
          )}
          {state && isList && (list.length ? (
            <ItemGrid
              items={list} label={title} selected={selected} groups={groupMap} showGroup={view.kind !== 'group' || searching}
              windowNo={windowNo} extraMeta={searching ? (i) => (meaningIds.has(i.id) ? 'Similar by meaning' : undefined)
                : lastCopyIds.size ? (i) => (lastCopyIds.has(i.id) ? 'Last copy, still open' : undefined) : undefined}
              onOpen={(i) => void openItem(i)} onSelect={select} onClearSelection={() => setSelected(new Set())}
              onAction={onRowAction} onDelete={onDelete} onDragStart={onDragStart}
              onDragEnd={() => {
                dragIds.current = [];
                setDragging(false);
              }}
              resetKey={searching ? `search:${search.query}` : viewHash(view)}
            />
          ) : (
            !(searching && search.error) && (
              <div class="empty">
                <p>{emptyText}</p>
                {view.kind === 'group' && !currentGroup && !searching && (
                  <button type="button" class="btn btn-sm" onClick={() => go({ kind: 'all' })}>Show all tabs</button>
                )}
              </div>
            )
          ))}
          {state && !searching && view.kind === 'suspicious' && (suspicious.length ? (
            <div class="page-scroll sus-view">
              <p class="sus-intro">{SUSPICIOUS_INTRO}</p>
              <SuspiciousRows
                list={suspicious} label="Suspicious tabs" busy={busy} windowNo={windowNo} worded
                groupOf={(i) => (i.groupId !== null ? groupMap.get(i.groupId) : undefined)}
                onGo={(s) => void openItem(s.item)} onKeep={(s) => void keepTab(s)}
                onClose={(s) => void act(() => closeIds([s.item.id]))}
              />
            </div>
          ) : (
            <div class="empty"><p>No suspicious tabs.</p></div>
          ))}
          {state && !searching && view.kind === 'sessions' && (
            <Sessions version={state} busy={busy} onAction={sessionAction} onSnapshot={snapshotNow} />
          )}
          {state && settings && !searching && view.kind === 'settings' && (
            <Settings
              settings={settings} syncStatus={state.syncStatus} busy={busy} save={save} act={act} notify={(m) => notify(m)}
              onDeleteAll={() => void deleteAllData()}
              onTour={startTour}
              tab={settingsTab}
              onTab={(t) => {
                setSettingsTab(t);
                const hash = `#${settingsHash(t)}`;
                if (location.hash !== hash) location.hash = hash;
              }}
            />
          )}
        </main>
      </div>

      {touring && <Tour onClose={endTour} />}
      <UndoToast
        notice={notice} onDismiss={dismiss}
        onUndo={() => void runUndo()}
      />

      {dialog?.kind === 'confirm' && (
        <ConfirmDialog opts={dialog.opts} onDone={(ok) => { setDialog(null); dialog.resolve(ok); }} />
      )}
      {dialog?.kind === 'name' && (
        <NameDialog
          title={dialog.title} initial={dialog.initial} confirmLabel={dialog.confirmLabel}
          onDone={(name) => { setDialog(null); dialog.resolve(name); }}
        />
      )}
      {dialog?.kind === 'merge' && (
        <MergeDialog
          from={dialog.from} groups={moveTargets} onClose={() => setDialog(null)}
          onMerge={(into) => {
            const from = dialog.from;
            setDialog(null);
            void act(async () => {
              await send({ t: 'groupMerge', from: from.id, into });
              go({ kind: 'group', id: into });
            });
          }}
        />
      )}
      {dialog?.kind === 'regroup' && (
        <RegroupDialog rows={dialog.rows} groups={groupMap} onClose={() => setDialog(null)} onApply={applyRegroup} />
      )}
    </>
  );
}

function MergeDialog(props: { from: GroupSummary; groups: GroupSummary[]; onClose: () => void; onMerge: (into: string) => void }) {
  const targets = props.groups.filter((g) => g.id !== props.from.id);
  const [into, setInto] = useState(targets[0]?.id ?? '');
  return (
    <Modal
      title={`Merge ${props.from.name} into…`} onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
          <button type="button" class="btn btn-primary" disabled={!into} onClick={() => props.onMerge(into)}>Merge</button>
        </>
      }
    >
      <p>{`Its ${plural(props.from.count, 'tab')} move to the group you pick, and ${props.from.name} is removed.`}</p>
      <label class="form-label">
        Merge into
        <select class="field" value={into} data-autofocus onChange={(e) => setInto(e.currentTarget.value)}>
          {targets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>
    </Modal>
  );
}

/** Preview of "Re-group everything": per-group counts now and after. Nothing changes until Apply. */
function RegroupDialog(props: { rows: RegroupRow[]; groups: ReadonlyMap<string, GroupSummary>; onClose: () => void; onApply: () => void }) {
  const { rows, groups } = props;
  const name = (id: string | null) => (id === null ? 'Unsorted' : groups.get(id)?.name ?? 'Removed group');
  return (
    <Modal
      title="Re-group everything" onClose={props.onClose} wide
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>{rows.length ? 'Cancel' : 'Close'}</button>
          {rows.length > 0 && <button type="button" class="btn btn-primary" data-autofocus onClick={props.onApply}>Apply</button>}
        </>
      }
    >
      {rows.length ? (
        <>
          <p>Automatically sorted tabs are sorted again with everything learned so far. Tabs you moved yourself stay put.</p>
          <table class="regroup-table">
            <thead>
              <tr><th scope="col">Group</th><th scope="col">Now</th><th scope="col">After</th><th scope="col">Change</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = r.after - r.before;
                return (
                  <tr key={r.groupId ?? '(unsorted)'}>
                    <th scope="row">{name(r.groupId)}</th>
                    <td>{r.before}</td>
                    <td>{r.after}</td>
                    <td class={d > 0 ? 'delta-up' : 'delta-down'}>{d > 0 ? `+${d}` : String(d)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <p>Everything is already in the group it would go to. Nothing to change.</p>
      )}
    </Modal>
  );
}
