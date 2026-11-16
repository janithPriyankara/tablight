// Service worker entry. Every listener is registered synchronously at top level (MV3: a worker woken
// by an event only delivers it to listeners that exist after the first synchronous run).
import { buildStarterGroups } from '../classify/assign';
import { openDb, type Db } from './db';
import { invalidateBadges, updateBadge } from './duplicates';
import { embed } from './embedder';
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

configureTabIndex({ db: getDb, after: pipeline });

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
});
chrome.runtime.onStartup.addListener(() => void flushTabEvents());
chrome.runtime.onInstalled.addListener(() => {
  void getDb()
    .then(ensureStarterGroups)
    .catch((e: unknown) => console.error('starter groups failed; retried on the next pass', e))
    .then(() => flushTabEvents());
});
