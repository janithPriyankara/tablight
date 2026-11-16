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
import { AUTO_SLEEP_ALARM, autoSleep, closeExtras, closeTabs, openItem, sleepTabs, stash, undo } from './memory';
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
/** Group RPCs. Payloads come from extension pages but are still validated. */
export async function handleRequest(req: Req): Promise<unknown> {
  const db = await getDb();
  let out: unknown;
  switch (req.t) {
    case 'moveItems': await moveItems(db, parseIds(req.ids), parseId(req.groupId)); break;
    case 'groupCreate': out = await createGroup(db, parseName(req.name), parseIds(req.ids)); break;
    case 'groupRename': await renameGroup(db, parseId(req.id), parseName(req.name)); break;
    case 'groupMerge': await mergeGroups(db, parseId(req.from), parseId(req.into)); break;
    case 'groupDelete': await deleteGroup(db, parseId(req.id)); break;
    case 'acceptSuggestion': await acceptSuggestion(db, parseId(req.id)); break;
    case 'dismissSuggestion': await dismissSuggestion(db, parseId(req.id)); break;
    case 'sleep': return sleepTabs(db, parseIds(req.ids));
    case 'stash': out = await stash(db, parseIds(req.ids)); break;
    case 'open': await openItem(db, parseId(req.id)); break;
    case 'close': out = await closeTabs(db, parseIds(req.ids)); break;
    case 'closeExtras': out = await closeExtras(db); break;
    case 'undo': return undo(db, parseId(req.token));
    case 'regroupPreview': return regroupPreview(db);
    case 'regroupApply': out = await regroupApply(db); break;
    default: throw new Error(`unsupported request: ${req.t}`);
  }
  await mirrorAll(db);
  return out;
}
configureTabIndex({ db: getDb, after: pipeline });

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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KICK_ALARM) void flushTabEvents();
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
chrome.runtime.onStartup.addListener(() => void flushTabEvents());
chrome.runtime.onInstalled.addListener(() => {
  void getDb()
    .then(ensureStarterGroups)
    .catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e))
    .then(() => flushTabEvents());
});
