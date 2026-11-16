// Settings → "Delete all data": everything this extension stored, and nothing else.
import type { Db } from './db';
import { clearUndos } from './memory';
import { clearSyncData } from './sync';
import { DISMISSED_KEY } from './tab-index';
/**
 * Deletes all extension data: every IndexedDB store (tab index, groups, stash, snapshots, embeddings,
 * backups, settings), our chrome.storage.local keys and our "v1:*" chrome.storage.sync keys. Closes no tab.
 * The sync on/off choice is kept (re-enabling sync the user turned off would be a surprise). The caller
 * re-seeds the starter groups and re-indexes the open tabs.
 */
export async function deleteAllData(db: Db): Promise<void> {
  const { syncEnabled } = await db.settings.get();
  clearUndos();
  await clearSyncData(async () => {
    await db.clearAll();
    if (!syncEnabled) await db.settings.set({ syncEnabled: false });
    await chrome.storage.local.remove([DISMISSED_KEY]);
  });
}
