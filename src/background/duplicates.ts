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

/** tabId → badge text we last set. Lets a full refresh touch only tabs whose text changes. */
const shown = new Map<number, string>();
let colorSet = false;
/** Forget what we set on these tabs (Chrome may reset a tab's badge, e.g. when it navigates). */
export function invalidateBadges(tabIds: number[]): void {
  for (const id of tabIds) shown.delete(id);
}
/** For tests and a fresh worker. */
export function resetBadgeCache(): void {
  shown.clear();
  colorSet = false;
}
/**
 * Per-tab badge: "2×" (the copy count) on a tab that has a duplicate, '' otherwise.
 * With `activeTabId` that tab is always (re)set. Without it, every indexed tab is checked but
 * setBadgeText is called only where the text differs from what we last set (unknown counts as '').
 */
export async function updateBadge(db: Db, activeTabId?: number): Promise<void> {
  const items = (await db.items.all()).filter((i) => i.state !== 'stashed' && i.tabId !== undefined);
  const count = new Map<number, number>();
  for (const list of findDuplicates(items).values()) for (const i of list) count.set(i.tabId!, list.length);
  const textOf = (tabId: number) => {
    const n = count.get(tabId);
    return n ? `${n}×` : '';
  };
  if (!colorSet) {
    colorSet = true;
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => (colorSet = false));
  }
  let targets: number[];
  if (activeTabId !== undefined) targets = [activeTabId];
  else {
    const live = new Set(items.map((i) => i.tabId!));
    for (const id of shown.keys()) if (!live.has(id)) shown.delete(id);
    targets = [...live].filter((id) => (shown.get(id) ?? '') !== textOf(id));
  }
  await Promise.all(
    targets.map(async (tabId) => {
      const text = textOf(tabId);
      try {
        await chrome.action.setBadgeText({ tabId, text });
        shown.set(tabId, text);
      } catch {
        shown.delete(tabId); // the tab closed since the index was read: not an error
      }
    }),
  );
}
