// Service worker entry. Every listener is registered synchronously at top level (MV3: a worker woken
// by an event only delivers it to listeners that exist after the first synchronous run).
import type { Req } from '../shared/rpc';
import { buildStarterGroups } from '../classify/assign';
import { openDb, type Db } from './db';
import { findDuplicates, invalidateBadges, updateBadge } from './duplicates';
import { OFFSCREEN_IDLE_ALARM, closeIfIdle, embed, isWarm } from './embedder';
import {
  acceptSuggestion, createGroup, deleteGroup, dismissSuggestion, mergeGroups, mirrorTabGroups, moveItems,
  parseId, parseIds, parseName, regroupApply, regroupPreview, renameGroup,
} from './groups';
import { handle } from '../shared/rpc';
import { deleteAllData } from './reset';
import { openDashboard } from '../shared/nav';
import { isClutterTab } from '../shared/url';
import { semanticSearch, wordSearch } from '../search/search';
import type { ChangedMessage, DashboardState, GroupSummary, Item, Settings, Snapshot } from '../shared/types';
import { applyImport, exportJson, parseImport } from '../io/import-export';
import {
  LAST_SESSION_KEY, SNAPSHOT_ALARM, SNAPSHOT_PERIOD_MINUTES, listSessions, runStartupCheck, sessionAction, startupCheckDone,
  startupCheckInterrupted, takeSnapshot,
} from './snapshots';
import { AUTO_SLEEP_ALARM, autoSleep, closeExtras, closeTabs, deleteStashed, openItem, sleepTabs, stash, stashWindow, undo } from './memory';
import {
  SYNC_RETRY_ALARM, configureSync, handleSyncStorageChange, pullSync, pushSync, readSyncStatus, scheduleSync,
  setSyncEnabled, touchStashedInGroup,
} from './sync';
import {
  KICK_ALARM,
  backfillEmbKeys,
  configureTabIndex,
  flushTabEvents,
  maybeSuggest,
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
async function ensureStarterGroups(db: Db): Promise<void> {
  if ((await db.groups.all()).length > 0) return;
  const groups = await buildStarterGroups(embed);
  await db.tx(['groups'], async (s) => {
    if ((await s.groups.all()).length > 0) return; // another run won the race
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
    await ensureStarterGroups(db);
    await backfill(db, false);
    const written = await processQueue(db);
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
    await updateBadge(db).catch((e: unknown) => console.error('badge update failed', e));
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
  const items = await db.items.all();
  const words = wordSearch(items, await db.groups.all(), q);
  if (!req.semantic) return { words, meaning: [] };
  const ticket = ++searchTicket;
  try {
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
    return { words, meaning: semanticSearch(qVec, withVec) };
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
/** The last-focused window's active tab and its copies, when it has any. */
async function activeDuplicate(items: Item[], dups: Map<string, Item[]>): Promise<DashboardState['activeDup']> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab?.id === undefined) return undefined;
  const item = items.find((i) => i.tabId === tab.id && i.state !== 'stashed');
  const copies = item ? dups.get(item.normUrl) : undefined;
  if (!item || !copies) return undefined;
  return { item, others: copies.filter((i) => i.id !== item.id) };
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
    ...g, exemplars: [], centroid: null, ...(counts.get(g.id) ?? { count: 0, watchCount: 0 }),
  }));
  const dups = findDuplicates(items);
  let dupCount = 0;
  for (const list of dups.values()) dupCount += list.length - 1;
  const [activeDup, syncStatus, lastSession] = await Promise.all([
    activeDuplicate(items, dups), readSyncStatus(), readLastSession(db),
  ]);
  return {
    items, groups: summaries, dupCount, windows: windows.size, sleeping, syncStatus, settings,
    // An empty queue is ready even with no groups (e.g. the user deleted them all): nothing is pending.
    modelReady: queued === 0 || (groups.length > 0 && isWarm()),
    queued,
    ...(activeDup ? { activeDup } : {}),
    ...(lastSession ? { lastSession } : {}),
  };
}
/** Activation/focus: a light path (lastActiveAt + that tab's badge), never a full reconcile. */
async function activated(tabId: number): Promise<void> {
  const db = await getDb();
  await touchTab(db, tabId);
  await updateBadge(db, tabId);
}

/** Re-applies native tab groups in every window after a group change (no-op unless enabled). */
async function mirrorAll(db: Db): Promise<void> {
  const windowIds = new Set((await chrome.tabs.query({})).map((t) => t.windowId));
  for (const w of windowIds) await mirrorTabGroups(db, w).catch((e: unknown) => console.error('mirror failed', e));
}
/** RPCs that can change the stash or the group names its records carry: each schedules a sync push. */
const STASH_CHANGING: ReadonlySet<Req['t']> = new Set<Req['t']>([
  'moveItems', 'groupCreate', 'groupRename', 'groupMerge', 'groupDelete', 'acceptSuggestion', 'stash', 'stashWindow', 'stashDelete', 'open',
  'undo', 'sessionAction', 'regroupApply',
]);
const SETTING_KEYS: ReadonlySet<string> = new Set<keyof Settings>([
  'autoSleepMinutes', 'syncEnabled', 'mirrorTabGroups', 'removeOnOpen', 'theme', 'onboarded', 'autoCreateGroups',
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
      case 'syncEnabled': case 'mirrorTabGroups': case 'removeOnOpen': case 'onboarded': case 'autoCreateGroups':
        if (!isBool(val)) throw new Error(`${key} must be true or false`);
        out[key as 'syncEnabled'] = val;
        break;
    }
  }
  return out;
}
/** `settings` RPC: applies a validated patch and returns the new settings. */
async function updateSettings(db: Db, raw: unknown): Promise<Settings> {
  const { syncEnabled, ...rest } = parseSettingsPatch(raw);
  // The UI requests the optional permission (it needs a user gesture); never enable mirroring without it.
  if (rest.mirrorTabGroups === true && !(await chrome.permissions.contains({ permissions: ['tabGroups'] }))) {
    throw new Error('tab groups permission not granted');
  }
  if (Object.keys(rest).length) await db.settings.set(rest);
  if (syncEnabled !== undefined) await setSyncEnabled(db, syncEnabled);
  // Turning auto-create on also accepts the suggestions already waiting, so the setting means one thing.
  if (rest.autoCreateGroups === true) {
    for (const g of (await db.groups.all()).filter((x) => x.suggested)) await acceptSuggestion(db, g.id);
  }
  return db.settings.get();
}
/** Group RPCs. Payloads come from extension pages but are still validated. */
export async function handleRequest(req: Req): Promise<unknown> {
  if (req.t === 'offscreenIdle') {
    await closeIfIdle();
    return null;
  }
  const db = await getDb();
  let out: unknown;
  switch (req.t) {
    case 'moveItems': await moveItems(db, parseIds(req.ids), parseId(req.groupId)); break;
    case 'groupCreate': out = await createGroup(db, parseName(req.name), parseIds(req.ids)); break;
    case 'groupRename': {
      const id = parseId(req.id);
      await renameGroup(db, id, parseName(req.name));
      await touchStashedInGroup(db, id); // the new name must win LWW on other devices
      break;
    }
    case 'groupMerge': await mergeGroups(db, parseId(req.from), parseId(req.into)); break;
    case 'groupDelete': await deleteGroup(db, parseId(req.id)); break;
    case 'acceptSuggestion': await acceptSuggestion(db, parseId(req.id)); break;
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
    case 'open': await openItem(db, parseId(req.id)); break;
    case 'close': out = await closeTabs(db, parseIds(req.ids)); break;
    case 'closeExtras': out = await closeExtras(db); break;
    case 'undo': out = await undo(db, parseId(req.token)); break;
    case 'regroupPreview': return regroupPreview(db);
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
    case 'regroupApply': out = await regroupApply(db); break;
    case 'settings': out = await updateSettings(db, req.patch); break;
    case 'export': return exportJson(db);
    case 'deleteAllData': {
      await deleteAllData(db);
      await ensureStarterGroups(db).catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e));
      await flushTabEvents(); // re-index the open tabs (nothing was closed)
      break;
    }
    case 'import': {
      if (typeof req.json !== 'string') throw new Error('invalid import');
      const parsed = parseImport(req.json);
      if (!parsed.ok) throw new Error(parsed.error);
      out = await applyImport(db, parsed.data);
      scheduleSync(db);
      break;
    }
    default: throw new Error(`unsupported request: ${req.t}`);
  }
  notifyChanged();
  if (STASH_CHANGING.has(req.t)) scheduleSync(db);
  if (req.t === 'import' || req.t === 'sessionAction' || req.t === 'groupDelete') void kickClassification(db);
  await mirrorAll(db);
  return out;
}
configureTabIndex({ db: getDb, after: pipeline });
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
chrome.commands.onCommand.addListener((command) => {
  if (command !== OPEN_DASHBOARD_COMMAND) return;
  openDashboard().catch((e: unknown) => console.error('open dashboard failed', e));
});
chrome.tabs.onCreated.addListener(() => onTabEvent());
chrome.tabs.onUpdated.addListener((_id, info) => {
  // Favicon/audible/mute churn doesn't change the index.
  if (info.url !== undefined || info.title !== undefined || info.status !== undefined ||
      info.discarded !== undefined) onTabEvent();
});
chrome.tabs.onRemoved.addListener(() => onTabEvent());
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
  // A fresh install shows the dashboard (its onboarding) at once instead of nothing.
  if (fresh) openDashboard().catch((e: unknown) => console.error('open dashboard failed', e));
  void getDb()
    .then(ensureStarterGroups)
    .catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e))
    .then(() => flushTabEvents())
    .then(async () => {
      // The first snapshot, once the initial reconcile ran (else nothing exists until the hourly alarm).
      if (fresh) await takeSnapshot(await getDb(), Date.now());
    })
    .catch((e: unknown) => console.error('first snapshot failed', e))
    .then(syncNow); // a fresh install picks up the stash from the user's other devices
});
