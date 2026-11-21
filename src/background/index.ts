// Service worker entry. Every listener is registered synchronously at top level (MV3: a worker woken
// by an event only delivers it to listeners that exist after the first synchronous run).
import type { LabelForTextReply, Req } from '../shared/rpc';
import { OTHER_GROUP_ID, buildStarterGroups, headTop } from '../classify/assign';
import { openDb, type Db } from './db';
import { findDuplicates, flashBadge, invalidateBadges, updateBadge } from './duplicates';
import { COMMAND_BADGE, isPriorityCommand, prioritize, runPriorityCommand, unprioritize, type CommandResult } from './priority';
import { PRIORITY_GROUP_ID, isPriority, type PriorityCommand } from '../shared/priority';
import { OFFSCREEN_IDLE_ALARM, closeIfIdle, embed, isWarm } from './embedder';
import {
  acceptSuggestion, createGroup, deleteGroup, dismissSuggestion, mergeGroups, mirrorTabGroups, moveItems,
  parseId, parseIds, parseName, regroupApply, regroupPreview, renameGroup,
} from './groups';
import { handle } from '../shared/rpc';
import { deleteAllData } from './reset';
import { fillTrainedCentroids, growGroups } from './grow';
import { applyInterests, createStarterGroup } from './interests';
import { markModelCurrent, migrateModel } from './model-change';
import { findSuspicious } from './suspicious';
import { forgetTab, keepTab, loadContexts, pruneKept, recordCreated } from './tab-context';
import { openDashboard } from '../shared/nav';
import { isBlankTab, isClutterTab } from '../shared/url';
import { semanticMinFor, semanticSearch, wordSearch } from '../search/search';
import { HEAD } from '../classify/head';
import type { SuspiciousTab } from '../shared/clues';
import type { ChangedMessage, DashboardState, GroupSummary, Item, ResetMessage, Settings, Snapshot } from '../shared/types';
import { applyImport, exportJson, parseImport } from '../io/import-export';
import {
  LAST_SESSION_KEY, SNAPSHOT_ALARM, SNAPSHOT_PERIOD_MINUTES, listSessions, runStartupCheck, sessionAction, startupCheckDone,
  startupCheckInterrupted, takeSnapshot,
} from './snapshots';
import {
  AUTO_SLEEP_ALARM, TAB_GONE, autoSleep, closeExtras, closeTabs, deleteStashed, openItem, sleepTabs, stash, stashWindow, undo,
} from './memory';
import {
  SYNC_RETRY_ALARM, configureSync, handleSyncStorageChange, pullSync, pushSync, readSyncStatus, scheduleSync,
  setSyncEnabled, touchStashedInGroup,
} from './sync';
import {
  KICK_ALARM,
  backfillEmbKeys,
  configureTabIndex,
  flushIfPending, flushTabEvents,
  acceptQuietly, maybeSuggest,
  onTabEvent,
  processQueue,
  sweepEmbeddings,
  touchTab,
  type ReconcileResult,
} from './tab-index';
/** The embedding cache sweep runs at most this often. */
const SWEEP_INTERVAL_MS = 10 * 60_000;
let lastSweep = 0;

let dbp: Promise<Db> | undefined;
export function getDb(): Promise<Db> {
  dbp ??= openDb(undefined, {
    lost: () => {
      dbp = undefined; // closed for an upgrade or terminated: the next call reopens
    },
  }).catch((e: unknown) => {
    dbp = undefined;
    throw e;
  });
  return dbp;
}

/** Seeds the built-in groups once; classification waits for them (else everything lands Unsorted). */
/** The starter seeds never change: their vectors are kept for this worker's life, so "Delete all data" re-seeds
 * the groups without running the model again (it was ~4 s per wipe). */
let seedVecs: Promise<Float32Array[]> | undefined;
const embedSeeds = (texts: string[]): Promise<Float32Array[]> => {
  seedVecs ??= embed(texts).catch((e: unknown) => { seedVecs = undefined; throw e; });
  return seedVecs;
};
// The Priority group does not count: a shortcut used before the first seeding (or right after "Delete all data")
// creates it, and the starter groups must still appear.
const seeded = (groups: { id: string }[]) => groups.some((g) => g.id !== PRIORITY_GROUP_ID);
async function ensureStarterGroups(db: Db): Promise<void> {
  if (seeded(await db.groups.all())) return;
  const groups = await buildStarterGroups(embedSeeds);
  await db.tx(['groups'], async (s) => {
    if (seeded(await s.groups.all())) return; // another run won the race
    for (const g of groups) await s.groups.put(g);
  });
}

/** Open extension pages hear about changes at most this often (the first change starts the wait). */
export const CHANGED_DEBOUNCE_MS = 300;
let changedTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Tells open dashboards/popups that the data changed, so they re-read the state. Coalesced: one message
 * CHANGED_DEBOUNCE_MS after the first change of a burst. No page open is not an error.
 */
export function notifyChanged(): void {
  if (changedTimer !== undefined) return;
  changedTimer = setTimeout(() => {
    changedTimer = undefined;
    const msg: ChangedMessage = { target: 'ui', t: 'changed' };
    try {
      void Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => undefined);
    } catch {
      // no receiver: nothing to do
    }
  }, CHANGED_DEBOUNCE_MS);
}
/**
 * Tells open pages that "Delete all data" ran, so a look-up still in flight there does not write its answer back
 * into the cache that was just removed (the page also removes the key again after its pending writes).
 */
function broadcastReset(): void {
  const msg: ResetMessage = { target: 'ui', t: 'reset' };
  try {
    void Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => undefined);
  } catch {
    // no receiver: nothing to do
  }
}
/** Backfill runs at most this often from pipeline passes (kicks and startup run it at once). */
const BACKFILL_INTERVAL_MS = 5 * 60_000;
let lastBackfill = 0;
async function backfill(db: Db, force: boolean): Promise<void> {
  if (!force && Date.now() - lastBackfill < BACKFILL_INTERVAL_MS) return;
  lastBackfill = Date.now();
  await backfillEmbKeys(db);
}
/**
 * After every reconcile: classify the queue; re-cluster Unsorted only when it may have changed;
 * sweep stale embeddings now and then; refresh only the badges whose text changes.
 */
async function pipeline(db: Db, r: ReconcileResult): Promise<void> {
  try {
    // After an update that changed the bundled model, nothing is classified until stored vectors are moved to it
    // (model-change.ts); a failure throws here and the pass is retried like a failed embed.
    await migrateModel(db, embed);
    await ensureStarterGroups(db);
    await backfill(db, false);
    const written = await processQueue(db);
    if (written > 0) {
      // The model just embedded, so it is warm: trained groups made while it was cold (a sync pull or an import
      // right after launch) get their seed centroid now. Never throws.
      await fillTrainedCentroids(db, embed);
      // Trained groups that tabs now need appear on the fly; a failure here never stops the pipeline.
      const grown = await growGroups(db, embed).catch((e: unknown) => {
        console.error('growing groups failed', e);
        return [];
      });
      if (grown.length) {
        scheduleSync(db); // stashed tabs may have changed group
        await mirrorAll(db).catch((e: unknown) => console.error('mirror failed', e));
      }
    }
    if (written > 0 || r.deleted > 0) {
      await maybeSuggest(db);
      if (Date.now() - lastSweep >= SWEEP_INTERVAL_MS) {
        lastSweep = Date.now();
        await sweepEmbeddings(db);
      }
    }
  } catch (e) {
    // processQueue leaves the classify-kick alarm set while work remains; make sure it exists.
    if (!(await chrome.alarms.get(KICK_ALARM).catch(() => undefined))) {
      await chrome.alarms.create(KICK_ALARM, { periodInMinutes: 1 }).catch(() => undefined);
    }
    console.error('classification pipeline failed', e);
  } finally {
    invalidateBadges(r.navigatedTabIds);
    await refreshBadge(db).catch((e: unknown) => console.error('badge update failed', e));
    notifyChanged();
  }
}

/**
 * Import, stash-all and sync pulls enqueue items without a tab reconcile, so nothing else would run the
 * classifier for them. Runs the normal pipeline (processQueue is re-entrancy safe) when work is queued.
 * Never rejects.
 */
export async function kickClassification(db: Db): Promise<void> {
  try {
    await backfill(db, true); // import/stash/sync records may lack their vector key
    if ((await db.queue.size()) === 0) return;
    await pipeline(db, { created: 0, deleted: 0, enqueued: 0, navigatedTabIds: [] });
  } catch (e) {
    console.error('classification kick failed', e);
  }
}
const MAX_QUERY = 200;
/** Latest semantic search wins: an older one that finishes embedding after a newer began returns no meaning. */
let searchTicket = 0;
/** Cap on items compared by meaning (same bound as the word search). */
const MAX_SEMANTIC_ITEMS = 5_000;
/** `search` RPC: word matches always, plus (when asked) matches by meaning that aren't already word matches. */
async function search(db: Db, req: Extract<Req, { t: 'search' }>): Promise<{ words: Item[]; meaning: Item[]; superseded?: true }> {
  if (typeof req.q !== 'string' || req.q.length > MAX_QUERY) throw new Error('invalid query');
  if (typeof req.semantic !== 'boolean') throw new Error('invalid semantic flag');
  const q = req.q.trim();
  if (!q) return { words: [], meaning: [] };
  // Same rule as the lists: the dashboard itself and blank new tabs are never results.
  const own = chrome.runtime.getURL('');
  const items = (await db.items.all()).filter((i) => !isClutterTab(i.url, own));
  const words = wordSearch(items, await db.groups.all(), q);
  if (!req.semantic) return { words, meaning: [] };
  const ticket = ++searchTicket;
  try {
    await migrateModel(db, embed); // the query's vector must never be compared with a previous model's
    const [qVec] = await embed([q]);
    if (!qVec || ticket !== searchTicket) return { words, meaning: [], superseded: true }; // a newer search began
    const seen = new Set(words.map((i) => i.id));
    const recent = items
      .filter((i) => i.classifiable && !seen.has(i.id))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, MAX_SEMANTIC_ITEMS);
    // Items carry their cache key (set at classification): no hashing, one read transaction.
    const keyed = recent.filter((i) => i.embKey !== undefined);
    const vecs = await db.embeddings.getMany(keyed.map((i) => i.embKey!));
    const withVec = keyed.flatMap((item) => {
      const vec = vecs.get(item.embKey!);
      return vec ? [{ item, vec }] : [];
    });
    if (ticket !== searchTicket) return { words, meaning: [], superseded: true };
    return { words, meaning: semanticSearch(qVec, withVec, 20, semanticMinFor(HEAD.model)) };
  } catch (e) {
    console.error('semantic search failed', e);
    return { words, meaning: [] };
  }
}
/** The snapshot the startup check flagged as not restored (chrome.storage.session), if any. */
async function readLastSession(db: Db): Promise<Snapshot | undefined> {
  const stored = (await chrome.storage.session.get(LAST_SESSION_KEY).catch(() => ({})) as Record<string, unknown>)[LAST_SESSION_KEY];
  const id = (stored as { snapshotId?: unknown } | undefined)?.snapshotId;
  if (typeof id !== 'string') return undefined;
  return (await db.snapshots.all()).find((s) => s.id === id);
}
/** The active tab of every window. */
async function activeTabIds(): Promise<number[]> {
  const tabs = await chrome.tabs.query({ active: true }).catch(() => [] as chrome.tabs.Tab[]);
  return tabs.flatMap((t) => (t.id === undefined ? [] : [t.id]));
}
/** The last-focused window's active tab and its copies, when it has any. */
async function activeDuplicate(items: Item[], dups: Map<string, Item[]>): Promise<DashboardState['activeDup']> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab?.id === undefined) return undefined;
  const item = items.find((i) => i.tabId === tab.id && i.state !== 'stashed');
  const copies = item ? dups.get(item.normUrl) : undefined;
  if (!item || !copies) return undefined;
  // A copy in Priority is never offered for closing.
  const others = copies.filter((i) => i.id !== item.id && !isPriority(i));
  return others.length ? { item, others } : undefined;
}
/**
 * The suspicious tabs among `items` (already clutter-filtered), or none when the setting is off. The one place
 * this is computed, so the dashboard list and the toolbar badge can never disagree.
 */
async function currentSuspicious(all: Item[], settings: Settings): Promise<SuspiciousTab[]> {
  if (!settings.suspiciousTabs) return [];
  const items = all.filter((i) => !isPriority(i)); // tabs the user put in Priority are never flagged
  const live = items.filter((i) => i.tabId !== undefined).map((i) => ({ tabId: i.tabId!, windowId: i.windowId }));
  // A keep ends when its tab moves to another site: drop those now, so coming back flags the tab again.
  const onSite = items.filter((i) => i.tabId !== undefined && i.state !== 'stashed').map((i) => ({ tabId: i.tabId!, domain: i.domain }));
  const [ctx, kept] = await Promise.all([loadContexts(live), pruneKept(onSite)]);
  return findSuspicious(items, ctx, kept);
}
/** Refreshes the toolbar badge with the current suspicious count (see updateBadge for `tabId`). */
async function refreshBadge(db: Db, tabId?: number): Promise<void> {
  const own = chrome.runtime.getURL('');
  const [all, settings] = await Promise.all([db.items.all(), db.settings.get()]);
  const suspicious = await currentSuspicious(all.filter((i) => !isClutterTab(i.url, own)), settings);
  await updateBadge(db, tabId, suspicious.length);
}
/**
 * `state` RPC: one read of items and groups, counted in memory. Group vectors are stripped (they are
 * large and the UI never needs them). modelReady: the starter groups exist and either nothing waits
 * for classification or the model already produced a vector in this worker's lifetime.
 */
async function dashboardState(db: Db): Promise<DashboardState> {
  const [all, groups, queued, settings] = await Promise.all([
    db.items.all(), db.groups.all(), db.queue.size(), db.settings.get(),
  ]);
  // The dashboard itself and blank new tabs are not tabs the user is keeping: leave them out of every list.
  const own = chrome.runtime.getURL('');
  const items = all.filter((i) => !isClutterTab(i.url, own));
  const counts = new Map<string, { count: number; watchCount: number }>();
  const windows = new Set<number>();
  let sleeping = 0;
  for (const i of items) {
    if (i.groupId !== null) {
      const c = counts.get(i.groupId) ?? { count: 0, watchCount: 0 };
      c.count++;
      if (i.kind === 'watch') c.watchCount++;
      counts.set(i.groupId, c);
    }
    if (i.state === 'stashed') continue;
    if (i.state === 'sleeping') sleeping++;
    if (i.windowId !== undefined) windows.add(i.windowId);
  }
  const summaries: GroupSummary[] = groups.map((g) => ({
    ...g, exemplars: [], centroid: null, lessons: undefined, ...(counts.get(g.id) ?? { count: 0, watchCount: 0 }),
  }));
  const dups = findDuplicates(items);
  let dupCount = 0;
  for (const list of dups.values()) dupCount += list.length - 1;
  const [activeDup, activeIds, syncStatus, lastSession] = await Promise.all([
    activeDuplicate(items, dups), activeTabIds(), readSyncStatus(), readLastSession(db),
  ]);
  const suspicious = await currentSuspicious(items, settings);
  return {
    items, groups: summaries, dupCount, windows: windows.size, sleeping, suspicious, syncStatus, settings,
    // An empty queue is ready even with no groups (e.g. the user deleted them all): nothing is pending.
    modelReady: queued === 0 || (groups.length > 0 && isWarm()),
    queued,
    activeTabIds: activeIds,
    ...(activeDup ? { activeDup } : {}),
    ...(lastSession ? { lastSession } : {}),
  };
}
/** Activation/focus: a light path (lastActiveAt + that tab's badge), never a full reconcile. */
async function activated(tabId: number): Promise<void> {
  const db = await getDb();
  await touchTab(db, tabId);
  notifyChanged(); // open pages re-sort (open tabs by last use) and move the "Now" mark
  await refreshBadge(db, tabId); // opening a tab drops its "never viewed" clue, so the count can change
}

/** Re-applies native tab groups in every window after a group change (no-op unless enabled). */
async function mirrorAll(db: Db): Promise<void> {
  const windowIds = new Set((await chrome.tabs.query({})).map((t) => t.windowId));
  for (const w of windowIds) await mirrorTabGroups(db, w).catch((e: unknown) => console.error('mirror failed', e));
}
/** RPCs that can change the stash or the group names its records carry: each schedules a sync push. */
const STASH_CHANGING: ReadonlySet<Req['t']> = new Set<Req['t']>([
  'moveItems', 'groupCreate', 'groupRename', 'groupMerge', 'groupDelete', 'acceptSuggestion', 'stash', 'stashWindow', 'stashDelete', 'open',
  'undo', 'sessionAction', 'regroupApply', 'interests', 'prioritize', 'priorityCommand',
]);
const SETTING_KEYS: ReadonlySet<string> = new Set<keyof Settings>([
  'autoSleepMinutes', 'syncEnabled', 'mirrorTabGroups', 'removeOnOpen', 'theme', 'onboarded', 'autoCreateGroups', 'toolbarOpens', 'suspiciousTabs',
  'interestsAnswered', 'lookupButton',
]);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
/**
 * Validates a `settings` patch: a plain object holding only known keys, each with a valid value
 * (autoSleepMinutes: null or an integer 5..1440). Anything else is rejected as a whole.
 */
export function parseSettingsPatch(v: unknown): Partial<Settings> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('invalid settings');
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error('invalid settings');
  const out: Partial<Settings> = {};
  for (const key of Object.keys(v)) {
    if (!SETTING_KEYS.has(key)) throw new Error(`unknown setting: ${key.slice(0, 40)}`);
    const val = (v as Record<string, unknown>)[key];
    switch (key as keyof Settings) {
      case 'autoSleepMinutes':
        if (val !== null && !(Number.isInteger(val) && (val as number) >= 5 && (val as number) <= 1440)) {
          throw new Error('autoSleepMinutes must be off or 5-1440 minutes');
        }
        out.autoSleepMinutes = val as number | null;
        break;
      case 'theme':
        if (val !== 'system' && val !== 'light' && val !== 'dark') throw new Error('invalid theme');
        out.theme = val;
        break;
      case 'toolbarOpens':
        if (val !== 'popup' && val !== 'sidepanel') throw new Error('toolbarOpens must be popup or sidepanel');
        out.toolbarOpens = val;
        break;
      case 'syncEnabled': case 'mirrorTabGroups': case 'removeOnOpen': case 'onboarded': case 'autoCreateGroups': case 'suspiciousTabs':
      case 'interestsAnswered': case 'lookupButton':
        if (!isBool(val)) throw new Error(`${key} must be true or false`);
        out[key as 'syncEnabled'] = val;
        break;
    }
  }
  return out;
}
/**
 * Points the toolbar icon at the popup or the side panel. Re-applied on every background start: the browser
 * keeps neither choice reliably across restarts. Browsers without the side panel API keep the popup.
 */
export async function applyToolbar(opens: Settings['toolbarOpens']): Promise<void> {
  const panel = opens === 'sidepanel' && typeof chrome.sidePanel?.setPanelBehavior === 'function';
  await chrome.action.setPopup({ popup: panel ? '' : 'popup.html' });
  if (typeof chrome.sidePanel?.setPanelBehavior === 'function') {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel });
  }
}
/** `settings` RPC: applies a validated patch and returns the new settings. */
async function updateSettings(db: Db, raw: unknown): Promise<Settings> {
  const { syncEnabled, ...rest } = parseSettingsPatch(raw);
  // The UI requests the optional permission (it needs a user gesture); never enable mirroring without it.
  if (rest.mirrorTabGroups === true && !(await chrome.permissions.contains({ permissions: ['tabGroups'] }))) {
    throw new Error('tab groups permission not granted');
  }
  // Any answer to the interests step (Skip sends interestsAnswered: true) ends the fresh-install window.
  if (rest.interestsAnswered === true) await db.settings.set({ interestsFresh: false });
  if (Object.keys(rest).length) await db.settings.set(rest);
  if (rest.toolbarOpens !== undefined) await applyToolbar(rest.toolbarOpens);
  if (rest.suspiciousTabs !== undefined) await refreshBadge(db).catch((e: unknown) => console.error('badge update failed', e));
  if (syncEnabled !== undefined) await setSyncEnabled(db, syncEnabled);
  // Turning auto-create on also accepts the suggestions already waiting, so the setting means one thing.
  if (rest.autoCreateGroups === true) {
    for (const g of (await db.groups.all()).filter((x) => x.suggested)) await acceptQuietly(db, g.id);
  }
  return db.settings.get();
}
/** Longest text labelForText accepts: a look-up hit's label and description (200 characters each) and the dash. */
export const LABEL_TEXT_MAX = 500;
/**
 * The look-up dialog's fallback when no keyword names a hit's description: the head's label for the text, embedded
 * here (the text never leaves the device). Null below the head's threshold, for `other`, or for a vector that does
 * not fit the head. Stores nothing.
 */
async function labelForText(text: unknown): Promise<LabelForTextReply> {
  if (typeof text !== 'string' || !text.trim() || text.length > LABEL_TEXT_MAX) throw new Error('invalid text');
  const [vec] = await embed([text]);
  const top = vec ? headTop(vec, HEAD) : null;
  if (!top) return { label: null, score: 0 };
  const { label, score } = top;
  if (label === undefined || label === OTHER_GROUP_ID || !(score >= HEAD.threshold)) return { label: null, score }; // NaN too
  return { label, score };
}
/** The Priority shortcuts on `tab` (the onCommand listener and the `priorityCommand` RPC): badge feedback on a change. */
async function priorityCommand(db: Db, command: PriorityCommand, tab: chrome.tabs.Tab | undefined): Promise<CommandResult> {
  const result = await runPriorityCommand(db, command, tab, { catchUp: flushTabEvents, kick: (d) => void kickClassification(d) });
  if (result !== 'none' && tab?.id !== undefined) {
    const tabId = tab.id;
    await flashBadge(tabId, COMMAND_BADGE[result], () => refreshBadge(db, tabId));
  }
  return result;
}
/** Group RPCs. Payloads come from extension pages but are still validated. */
export async function handleRequest(req: Req): Promise<unknown> {
  if (req.t === 'offscreenIdle') {
    await closeIfIdle();
    return null;
  }
  if (req.t === 'labelForText') return labelForText(req.text); // reads and changes no data
  const db = await getDb();
  let out: unknown;
  switch (req.t) {
    case 'moveItems': out = await moveItems(db, parseIds(req.ids), parseId(req.groupId), embed); break;
    case 'prioritize': {
      if (typeof req.on !== 'boolean') throw new Error('invalid on');
      out = req.on ? await prioritize(db, parseIds(req.ids)) : (await unprioritize(db, parseIds(req.ids))).removed;
      break;
    }
    case 'priorityCommand': {
      if (!isPriorityCommand(req.command)) throw new Error('invalid command');
      if (!Number.isSafeInteger(req.tabId) || req.tabId < 0) throw new Error('invalid tab');
      const tab = await chrome.tabs.get(req.tabId).catch(() => undefined);
      out = await priorityCommand(db, req.command, tab);
      break;
    }
    case 'groupCreateStarter': out = await createStarterGroup(db, embed, req.id); break;
    case 'groupCreate': out = await createGroup(db, parseName(req.name), parseIds(req.ids), embed); break;
    case 'groupRename': {
      const id = parseId(req.id);
      await renameGroup(db, id, parseName(req.name));
      await touchStashedInGroup(db, id); // the new name must win LWW on other devices
      break;
    }
    case 'groupMerge': await mergeGroups(db, parseId(req.from), parseId(req.into)); break;
    case 'groupDelete': await deleteGroup(db, parseId(req.id)); break;
    case 'acceptSuggestion': await acceptSuggestion(db, parseId(req.id), embed); break;
    case 'dismissSuggestion': await dismissSuggestion(db, parseId(req.id)); break;
    case 'sleep': {
      const r = await sleepTabs(db, parseIds(req.ids));
      notifyChanged();
      return r;
    }
    case 'stash': out = await stash(db, parseIds(req.ids)); break;
    case 'stashWindow': {
      if (!Number.isSafeInteger(req.windowId) || req.windowId < 0) throw new Error('invalid window');
      out = await stashWindow(db, req.windowId);
      break;
    }
    case 'stashDelete': out = await deleteStashed(db, parseIds(req.ids)); break;
    case 'open':
      try {
        await openItem(db, parseId(req.id));
      } catch (e) {
        // The list was behind: bring it up to date so the closed tab disappears, then say why nothing opened.
        if (e instanceof Error && e.message === TAB_GONE) await flushTabEvents();
        throw e;
      }
      break;
    case 'close': out = await closeTabs(db, parseIds(req.ids), { keepOne: req.keepOne === true }); break;
    case 'closeExtras': out = await closeExtras(db); break;
    case 'undo': out = await undo(db, parseId(req.token)); break;
    case 'regroupPreview': {
      await migrateModel(db, embed); // the bundled head and exemplars must read vectors of the bundled model
      return regroupPreview(db);
    }
    case 'sessions': return listSessions(db);
    case 'snapshotNow': {
      const snap = await takeSnapshot(db, Date.now());
      return snap.windows.length ? snap : null; // null: no web tab to snapshot
    }
    case 'sessionAction': {
      const { action, confirm } = req;
      if (action !== 'openAll' && action !== 'stashAll' && action !== 'delete') throw new Error('invalid action');
      if (confirm !== undefined && typeof confirm !== 'boolean') throw new Error('invalid confirm');
      out = await sessionAction(db, parseId(req.id), action, confirm === true);
      break;
    }
    case 'search': return search(db, req);
    case 'state': return dashboardState(db);
    case 'regroupApply': {
      await migrateModel(db, embed);
      out = await regroupApply(db, embed); // embed: groups tabs now need can appear
      break;
    }
    case 'keepTab': {
      const item = await db.items.get(parseId(req.id));
      if (!item || item.tabId === undefined) throw new Error('tab not found');
      await keepTab(item.tabId, item.domain);
      await refreshBadge(db).catch((e: unknown) => console.error('badge update failed', e));
      break;
    }
    case 'settings': out = await updateSettings(db, req.patch); break;
    case 'export': return exportJson(db);
    case 'deleteAllData': {
      await deleteAllData(db);
      broadcastReset();
      await ensureStarterGroups(db).catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e));
      await flushTabEvents(); // re-index the open tabs (nothing was closed)
      break;
    }
    case 'interests': {
      // The first answer on a new install may also remove the installed groups nobody picked; later answers only add.
      out = await applyInterests(db, embed, { picked: req.picked, custom: req.custom }, (await db.settings.get()).interestsFresh);
      break;
    }
    case 'import': {
      if (typeof req.json !== 'string') throw new Error('invalid import');
      const parsed = parseImport(req.json);
      if (!parsed.ok) throw new Error(parsed.error);
      out = await applyImport(db, parsed.data, embed);
      scheduleSync(db);
      break;
    }
    default: throw new Error(`unsupported request: ${req.t}`);
  }
  notifyChanged();
  if (STASH_CHANGING.has(req.t)) scheduleSync(db);
  if (req.t === 'import' || req.t === 'sessionAction' || req.t === 'groupDelete' || req.t === 'interests' || req.t === 'prioritize') {
    void kickClassification(db); // a tab taken out of Priority with no group to go back to waits in the queue
  }
  await mirrorAll(db);
  return out;
}
configureTabIndex({ db: getDb, after: pipeline });
// A tab change whose update the previous background didn't finish (it was stopped mid-debounce).
void flushIfPending();
// Remote group names must match the built-in groups, so they are seeded before any sync.
configureSync({
  ready: ensureStarterGroups,
  applied: (db) => {
    notifyChanged();
    void kickClassification(db);
  },
  status: notifyChanged,
});

handle((req) => handleRequest(req), 'background');

/** The manifest's `open-dashboard` command (Alt+Shift+T): focus the dashboard tab or open one. */
export const OPEN_DASHBOARD_COMMAND = 'open-dashboard';
/** The manifest's `open-side-panel` command (Alt+Shift+S). */
export const OPEN_SIDE_PANEL_COMMAND = 'open-side-panel';
chrome.commands.onCommand.addListener((command, tab) => {
  if (isPriorityCommand(command)) {
    // The same path as the `priorityCommand` RPC. The tab given is the active one; without it, the focused window's.
    void (tab ? Promise.resolve([tab]) : chrome.tabs.query({ active: true, lastFocusedWindow: true }))
      .then(([t]) => (t?.id !== undefined ? handleRequest({ t: 'priorityCommand', command, tabId: t.id }) : undefined))
      .catch((e: unknown) => console.error('priority shortcut failed', e));
    return;
  }
  if (command === OPEN_SIDE_PANEL_COMMAND) {
    // open() needs the shortcut's user gesture: call it right away, before anything is awaited.
    if (tab?.windowId !== undefined && typeof chrome.sidePanel?.open === 'function') {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((e: unknown) => console.error('open side panel failed', e));
    }
    return;
  }
  if (command !== OPEN_DASHBOARD_COMMAND) return;
  openDashboard().catch((e: unknown) => console.error('open dashboard failed', e));
});
void getDb()
  .then((db) => db.settings.get())
  .then((s) => applyToolbar(s.toolbarOpens))
  .catch((e: unknown) => console.error('toolbar setup failed', e));
/**
 * The side panel is window-wide, so once open it would sit beside every tab, including an empty new tab, where a
 * list of tabs and groups is only clutter. It is turned off for empty new-tab pages and back on once the tab goes
 * somewhere; Chrome hides and shows the open panel accordingly.
 */
const panelOn = new Map<number, boolean>();
function syncPanel(tab: chrome.tabs.Tab | undefined): void {
  if (tab?.id === undefined || typeof chrome.sidePanel?.setOptions !== 'function') return;
  const enabled = !isBlankTab(tab.url || tab.pendingUrl || '');
  if (panelOn.get(tab.id) === enabled) return;
  panelOn.set(tab.id, enabled);
  chrome.sidePanel.setOptions({ tabId: tab.id, enabled }).catch(() => panelOn.delete(tab.id!));
}
chrome.tabs.onCreated.addListener((tab) => {
  onTabEvent();
  recordCreated(tab).catch(() => undefined);
  syncPanel(tab);
});
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  // Favicon/audible/mute churn doesn't change the index.
  if (info.url !== undefined || info.title !== undefined || info.status !== undefined ||
      info.discarded !== undefined) onTabEvent();
  if (info.url !== undefined) syncPanel(tab);
});
// Tabs already open when the background starts (empty new tabs among them).
void chrome.tabs.query({}).then((tabs) => tabs.forEach(syncPanel), () => undefined);
chrome.tabs.onRemoved.addListener((tabId) => {
  onTabEvent();
  forgetTab(tabId).catch(() => undefined);
  panelOn.delete(tabId);
});
chrome.tabs.onReplaced.addListener(() => onTabEvent());
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activated(tabId).catch(() => undefined);
});
chrome.windows.onRemoved.addListener(() => onTabEvent());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs
    .query({ active: true, windowId })
    .then(([t]) => (t?.id !== undefined ? activated(t.id) : undefined))
    .catch(() => undefined);
});

/** Pull from storage.sync; pullSync never rejects, so only opening the db can fail here. */
function syncNow(): void {
  void getDb()
    .then((db) => pullSync(db))
    .catch((e: unknown) => console.error('sync failed', e));
}
chrome.storage.onChanged.addListener((changes, areaName) => {
  void getDb()
    .then((db) => handleSyncStorageChange(db, changes, areaName))
    .catch((e: unknown) => console.error('sync failed', e));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OFFSCREEN_IDLE_ALARM) void closeIfIdle();
  if (alarm.name === KICK_ALARM) void flushTabEvents();
  if (alarm.name === SYNC_RETRY_ALARM) {
    void getDb()
      .then((db) => pushSync(db))
      .catch((e: unknown) => console.error('sync retry failed', e));
  }
  if (alarm.name === SNAPSHOT_ALARM) {
    void startupCheckDone()
      .then((done) => (done ? getDb().then((db) => takeSnapshot(db, Date.now())).then(() => undefined) : startupCheck()))
      .catch((e: unknown) => console.error('snapshot failed', e));
  }
  if (alarm.name === AUTO_SLEEP_ALARM) {
    void getDb()
      .then((db) => autoSleep(db, Date.now()))
      .catch((e: unknown) => console.error('auto-sleep failed', e));
  }
});
// Created once; re-creating on every worker start would keep pushing the schedule back.
void chrome.alarms
  .get(AUTO_SLEEP_ALARM)
  .then((a) => (a ? undefined : chrome.alarms.create(AUTO_SLEEP_ALARM, { periodInMinutes: 5 })))
  .catch((e: unknown) => console.error('auto-sleep alarm failed', e));
/**
 * Once per browser session (the marker lives in session storage): compare the restored tabs with the
 * last snapshot once they settled, then snapshot. It runs from onStartup, from a snapshot alarm that
 * fires before it (a missed alarm), and again when the worker was killed mid-check, so nothing can
 * snapshot a half-restored browser first.
 */
let checking: Promise<void> | undefined;
function startupCheck(): void {
  checking ??= getDb()
    .then((db) => runStartupCheck(db))
    .catch((e: unknown) => console.error('startup check failed', e))
    .finally(() => {
      checking = undefined;
    });
}
chrome.runtime.onStartup.addListener(() => {
  void flushTabEvents();
  startupCheck();
  syncNow();
});
void startupCheckInterrupted().then((interrupted) => (interrupted ? startupCheck() : undefined));
void chrome.alarms
  .get(SNAPSHOT_ALARM)
  .then((a) => (a ? undefined : chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: SNAPSHOT_PERIOD_MINUTES })))
  .catch((e: unknown) => console.error('snapshot alarm failed', e));
chrome.runtime.onInstalled.addListener(({ reason }) => {
  const fresh = reason === 'install';
  void getDb()
    .then(async (db) => {
      if (fresh) {
        // Nothing older than the bundled model is stored on a fresh install: no model migration to run.
        await markModelCurrent().catch((e: unknown) => console.error('model flag failed', e));
        // Only a real install answers the interests step as fresh (an update keeps every group it has). It is
        // written before the dashboard opens, so the onboarding never reads the step as not fresh.
        await db.settings.set({ interestsFresh: true }).catch((e: unknown) => console.error('interests flag failed', e));
        // A fresh install shows the dashboard (its onboarding) at once instead of nothing.
        openDashboard().catch((e: unknown) => console.error('open dashboard failed', e));
      }
      await ensureStarterGroups(db);
    })
    .catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e))
    .then(() => flushTabEvents())
    .then(async () => {
      // The first snapshot, once the initial reconcile ran (else nothing exists until the hourly alarm).
      if (fresh) await takeSnapshot(await getDb(), Date.now());
    })
    .catch((e: unknown) => console.error('first snapshot failed', e))
    .then(syncNow); // a fresh install picks up the stash from the user's other devices
});
