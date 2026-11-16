// Service worker entry. Every listener is registered synchronously at top level (MV3: a worker woken
// by an event only delivers it to listeners that exist after the first synchronous run).
import { buildStarterGroups } from '../classify/assign';
import { openDb, type Db } from './db';
import { updateBadge } from './duplicates';
import { embed } from './embedder';
import {
  KICK_ALARM,
  configureTabIndex,
  flushTabEvents,
  maybeSuggest,
  onTabEvent,
  processQueue,
} from './tab-index';

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

/** After every reconcile: classify the queue, maybe suggest groups, refresh the badges. */
async function pipeline(db: Db): Promise<void> {
  try {
    await ensureStarterGroups(db);
    await processQueue(db);
    await maybeSuggest(db);
  } catch (e) {
    // processQueue leaves the classify-kick alarm set while work remains; make sure it exists.
    await chrome.alarms.create(KICK_ALARM, { periodInMinutes: 1 }).catch(() => undefined);
    console.error('classification pipeline failed', e);
  } finally {
    await updateBadge(db).catch((e: unknown) => console.error('badge update failed', e));
  }
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
  onTabEvent(); // lastActiveAt
  void getDb()
    .then((db) => updateBadge(db, tabId))
    .catch(() => undefined);
});
chrome.windows.onRemoved.addListener(() => onTabEvent());
chrome.windows.onFocusChanged.addListener(() => onTabEvent());

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
