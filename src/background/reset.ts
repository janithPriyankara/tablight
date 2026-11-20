// Settings → "Delete all data": everything this extension stored, and nothing else.
import type { Db } from './db';
import { clearUndos } from './memory';
import { clearSyncData, pullSync } from './sync';
import { DISMISSED_KEY, SESSION_KEY } from './tab-index';
import { clearTabContext } from './tab-context';
import { clearBadgeState } from './duplicates';
import { MIRRORED_KEY } from './groups';
import { REMOVED_TRAINED_KEY } from './grow';
import { INTERESTS_KEY } from './interests';
import { LAST_SESSION_KEY, LOOKUP_CACHE_KEY } from '../shared/types';
/**
 * Deletes all extension data: every IndexedDB store (tab index, groups, stash, snapshots, embeddings,
 * backups, settings), our chrome.storage.local keys (the look-up cache among them), our "v1:*" chrome.storage.sync keys and the chrome.storage.session
 * records: suspicious-tab clues (which site opened each tab, pop-up windows, tabs the user kept), the badge mode,
 * the native groups we made, the startup check's verdict and the index's session marker (so the open tabs are
 * re-indexed as at browser start: no tab counts as "never viewed" because the wipe forgot it). Closes no tab.
 * Only scheduling flags that hold no browsing data stay (tabIndexPending, startupCheckDone, startupCheckAttempts).
 * Sync is turned off on this device afterwards: other devices still hold the stash and would push it
 * straight back (they keep their copy; deleting there takes "Delete all data" on that device). The caller
 * re-seeds the starter groups and re-indexes the open tabs, which repaints every tab's badge. The sync status then
 * reads "Sync is turned off".
 */
export async function deleteAllData(db: Db): Promise<void> {
  clearUndos();
  await clearSyncData(async () => {
    await db.clearAll();
    await db.settings.set({ syncEnabled: false, interestsFresh: true }); // the interests step shows again, as on install
    await chrome.storage.local.remove([DISMISSED_KEY, REMOVED_TRAINED_KEY, INTERESTS_KEY, LOOKUP_CACHE_KEY]);
  });
  await clearTabContext();
  await clearBadgeState();
  await chrome.storage.session.remove([LAST_SESSION_KEY, MIRRORED_KEY, SESSION_KEY]).catch(() => undefined);
  // The wipe removed the last sync status, which would read "Not synced yet" while sync is off: a pass with sync
  // off records "Sync is turned off" (it reads and writes nothing else).
  await pullSync(db);
}
