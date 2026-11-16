// Service worker entry. Every listener is registered synchronously at top level (MV3: a worker woken
// by an event only delivers it to listeners that exist after the first synchronous run).
import type { Req } from '../shared/rpc';
import { buildStarterGroups } from '../classify/assign';
import { openDb, type Db } from './db';
import { invalidateBadges, updateBadge } from './duplicates';
import { embed } from './embedder';
import {
  acceptSuggestion, createGroup, deleteGroup, dismissSuggestion, mergeGroups, mirrorTabGroups, moveItems,
  parseId, parseIds, parseName, regroupApply, regroupPreview, renameGroup,
} from './groups';
import { handle } from '../shared/rpc';
import { applyImport, exportJson, parseImport } from '../io/import-export';
import {
  SNAPSHOT_ALARM, SNAPSHOT_PERIOD_MINUTES, listSessions, runStartupCheck, sessionAction, startupCheckDone,
  startupCheckInterrupted, takeSnapshot,
} from './snapshots';
import { AUTO_SLEEP_ALARM, autoSleep, closeExtras, closeTabs, openItem, sleepTabs, stash, undo } from './memory';
import {
  SYNC_RETRY_ALARM, configureSync, handleSyncStorageChange, pullSync, pushSync, scheduleSync, touchStashedInGroup,
} from './sync';
import {
  KICK_ALARM,
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
  dbp ??= openDb().catch((e: unknown) => {
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

/**
 * After every reconcile: classify the queue; re-cluster Unsorted only when it may have changed;
 * sweep stale embeddings now and then; refresh only the badges whose text changes.
 */
async function pipeline(db: Db, r: ReconcileResult): Promise<void> {
  try {
    await ensureStarterGroups(db);
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
  }
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
  'moveItems', 'groupCreate', 'groupRename', 'groupMerge', 'groupDelete', 'acceptSuggestion', 'stash', 'open',
  'undo', 'sessionAction', 'regroupApply',
]);
/** Group RPCs. Payloads come from extension pages but are still validated. */
export async function handleRequest(req: Req): Promise<unknown> {
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
    case 'sleep': return sleepTabs(db, parseIds(req.ids));
    case 'stash': out = await stash(db, parseIds(req.ids)); break;
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
    case 'regroupApply': out = await regroupApply(db); break;
    case 'export': return exportJson(db);
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
  if (STASH_CHANGING.has(req.t)) scheduleSync(db);
  await mirrorAll(db);
  return out;
}
configureTabIndex({ db: getDb, after: pipeline });
// Remote group names must match the built-in groups, so they are seeded before any sync.
configureSync({ ready: ensureStarterGroups });

handle((req) => handleRequest(req), 'background');

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
chrome.runtime.onInstalled.addListener(() => {
  void getDb()
    .then(ensureStarterGroups)
    .catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e))
    .then(() => flushTabEvents())
    .then(syncNow); // a fresh install picks up the stash from the user's other devices
});
