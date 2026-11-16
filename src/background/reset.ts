// Settings → "Delete all data": everything this extension stored, and nothing else.
import type { Db } from './db';
import { clearUndos } from './memory';
import { clearSyncData } from './sync';
import { DISMISSED_KEY } from './tab-index';
/**
 * Deletes all extension data: every IndexedDB store (tab index, groups, stash, snapshots, embeddings,
 * backups, settings), our chrome.storage.local keys and our "v1:*" chrome.storage.sync keys. Closes no tab.
 * Sync is turned off on this device afterwards: other devices still hold the stash and would push it
 * straight back (they keep their copy; deleting there takes "Delete all data" on that device). The caller
 * re-seeds the starter groups and re-indexes the open tabs.
 */
export async function deleteAllData(db: Db): Promise<void> {
  clearUndos();
  await clearSyncData(async () => {
    await db.clearAll();
    await db.settings.set({ syncEnabled: false });
    await chrome.storage.local.remove([DISMISSED_KEY]);
  });
}
