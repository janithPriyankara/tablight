import type { Item } from '../shared/types';
import type { Db } from './db';

/** Neutral grey: the badge is information, not an alarm. */
export const BADGE_COLOR = '#6f6e77';

/** normUrl → the ≥ 2 open/sleeping web items sharing it. Stashed and non-web items never count. */
export function findDuplicates(items: Item[]): Map<string, Item[]> {
  const by = new Map<string, Item[]>();
  for (const i of items) {
    if (i.state === 'stashed' || !i.classifiable || i.tabId === undefined) continue;
    const list = by.get(i.normUrl);
    if (list) list.push(i);
    else by.set(i.normUrl, [i]);
  }
  for (const [k, list] of by) if (list.length < 2) by.delete(k);
  return by;
}

/**
 * Sets the per-tab badge: "2×" (the copy count) on a tab that has a duplicate, '' otherwise.
 * With `activeTabId` only that tab is updated; without it, every indexed tab is.
 */
export async function updateBadge(db: Db, activeTabId?: number): Promise<void> {
  const items = (await db.items.all()).filter((i) => i.state !== 'stashed' && i.tabId !== undefined);
  const count = new Map<number, number>();
  for (const list of findDuplicates(items).values()) for (const i of list) count.set(i.tabId!, list.length);
  const tabIds = activeTabId !== undefined ? [activeTabId] : items.map((i) => i.tabId!);
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => undefined);
  await Promise.all(
    tabIds.map((tabId) => {
      const n = count.get(tabId);
      // The tab may have closed since the index was read: that is not an error.
      return chrome.action.setBadgeText({ tabId, text: n ? `${n}×` : '' }).catch(() => undefined);
    }),
  );
}
